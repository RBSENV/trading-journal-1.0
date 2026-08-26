-- 0002_infrastructure.sql
-- The durability machinery: mutation log, audit trail, sync state, conflicts,
-- backup and export registries. These exist before any domain table so the
-- audit triggers have somewhere to write from the moment trades are created.

-- ---------------------------------------------------------------------------
-- mutation_log — idempotency for offline sync
-- The client never issues a bare INSERT. It submits a mutation with an id it
-- generated. Replaying the same id is a no-op, which is what makes retrying
-- on flaky signal safe.
-- ---------------------------------------------------------------------------

create table mutation_log (
  id              uuid primary key,               -- client-generated
  user_id         uuid not null references auth.users(id) on delete cascade,
  device_id       uuid references devices(id) on delete set null,
  seq             bigserial not null,             -- server-assigned global order
  client_seq      bigint,                         -- per-device monotonic counter
  op              mutation_op not null,
  entity_type     text not null,
  entity_id       uuid not null,
  payload         jsonb not null default '{}'::jsonb,
  client_time     timestamptz,
  server_time     timestamptz not null default now(),
  applied         boolean not null default false,
  rejected_reason text
);

alter table mutation_log enable row level security;

-- Insert and read only. No update, no delete — the log is the record of what happened.
create policy mutation_log_insert on mutation_log
  for insert to authenticated with check (user_id = auth.uid());
create policy mutation_log_select on mutation_log
  for select to authenticated using (user_id = auth.uid());

create index mutation_log_seq_idx on mutation_log (user_id, seq);
create index mutation_log_entity_idx on mutation_log (user_id, entity_type, entity_id);

-- ---------------------------------------------------------------------------
-- audit_log — permanent history, written by triggers only
-- No client-available role can insert, update, or delete here. If the app has
-- a bug, the audit trail is still correct.
-- ---------------------------------------------------------------------------

create table audit_log (
  id          bigserial primary key,
  user_id     uuid not null,
  table_name  text not null,
  row_id      uuid not null,
  op          text not null,
  field_name  text,
  old_value   jsonb,
  new_value   jsonb,
  device_id   uuid,
  mutation_id uuid,
  changed_at  timestamptz not null default now()
);

alter table audit_log enable row level security;

create policy audit_log_select on audit_log
  for select to authenticated using (user_id = auth.uid());
-- Deliberately no insert/update/delete policy for any client role.

create index audit_log_row_idx on audit_log (user_id, table_name, row_id, changed_at desc);
create index audit_log_recent_idx on audit_log (user_id, changed_at desc);

-- Field-level audit. Text columns you care about get one row per changed field,
-- so the History tab reads like a diff rather than a blob.
create or replace function write_audit()
returns trigger
language plpgsql
security definer set search_path = public
as $$
declare
  col        text;
  old_json   jsonb;
  new_json   jsonb;
  old_v      jsonb;
  new_v      jsonb;
  target_uid uuid;
  dev        uuid;
  mut        uuid;
begin
  if tg_op = 'DELETE' then
    old_json := to_jsonb(old);
    target_uid := (old_json->>'user_id')::uuid;
    insert into audit_log (user_id, table_name, row_id, op, old_value)
    values (target_uid, tg_table_name, (old_json->>'id')::uuid, 'delete', old_json);
    return old;
  end if;

  new_json := to_jsonb(new);
  target_uid := (new_json->>'user_id')::uuid;
  dev := nullif(new_json->>'origin_device','')::uuid;
  mut := nullif(new_json->>'last_mutation','')::uuid;

  if tg_op = 'INSERT' then
    insert into audit_log (user_id, table_name, row_id, op, new_value, device_id, mutation_id)
    values (target_uid, tg_table_name, (new_json->>'id')::uuid, 'insert', new_json, dev, mut);
    return new;
  end if;

  old_json := to_jsonb(old);

  for col in select jsonb_object_keys(new_json) loop
    -- Bookkeeping columns would drown the log in noise.
    if col in ('updated_at','rev','last_mutation','origin_device') then
      continue;
    end if;
    old_v := old_json -> col;
    new_v := new_json -> col;
    if old_v is distinct from new_v then
      insert into audit_log (user_id, table_name, row_id, op, field_name, old_value, new_value, device_id, mutation_id)
      values (target_uid, tg_table_name, (new_json->>'id')::uuid,
              case when old_json->>'deleted_at' is null and new_json->>'deleted_at' is not null then 'soft_delete'
                   when old_json->>'deleted_at' is not null and new_json->>'deleted_at' is null then 'restore'
                   else 'update' end,
              col, old_v, new_v, dev, mut);
    end if;
  end loop;

  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- sync_state — one row per device
-- ---------------------------------------------------------------------------

create table sync_state (
  user_id          uuid not null references auth.users(id) on delete cascade,
  device_id        uuid not null references devices(id) on delete cascade,
  last_pulled_seq  bigint not null default 0,
  last_pushed_seq  bigint not null default 0,
  last_full_sync_at timestamptz,
  schema_version   text,
  pending_count    integer not null default 0,
  conflict_count   integer not null default 0,
  updated_at       timestamptz not null default now(),
  primary key (user_id, device_id)
);

alter table sync_state enable row level security;

create policy sync_state_owner on sync_state
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

create trigger sync_state_updated_at
  before update on sync_state
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- conflicts — nothing is ever silently discarded
-- ---------------------------------------------------------------------------

create table conflicts (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  entity_type   text not null,
  entity_id     uuid not null,
  field_name    text,
  local_value   jsonb,
  remote_value  jsonb,
  local_device  uuid,
  remote_device uuid,
  detected_at   timestamptz not null default now(),
  resolved_at   timestamptz,
  resolution    conflict_choice,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

alter table conflicts enable row level security;

create policy conflicts_owner on conflicts
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

create index conflicts_open_idx on conflicts (user_id, detected_at desc) where resolved_at is null;

create trigger conflicts_updated_at
  before update on conflicts
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- backups — a snapshot that has never been read back is not a backup.
-- verified_at is the column that makes the difference.
-- ---------------------------------------------------------------------------

create table backups (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references auth.users(id) on delete cascade,
  kind             backup_kind not null,
  taken_at         timestamptz not null default now(),
  storage_provider text not null default 'r2',
  storage_key      text not null,
  byte_size        bigint,
  sha256           text,
  encryption       text,
  schema_version   text,
  row_counts       jsonb,
  media_count      integer,
  media_bytes      bigint,
  verified_at      timestamptz,
  verify_result    text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

alter table backups enable row level security;

create policy backups_owner on backups
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

create index backups_recent_idx on backups (user_id, taken_at desc);

create trigger backups_updated_at
  before update on backups
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- exports — a receipt for every export you take
-- ---------------------------------------------------------------------------

create table exports (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references auth.users(id) on delete cascade,
  format         export_format not null,
  schema_version text,
  filters        jsonb,
  row_counts     jsonb,
  byte_size      bigint,
  sha256         text,
  storage_key    text,
  downloaded_at  timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

alter table exports enable row level security;

create policy exports_owner on exports
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

create index exports_recent_idx on exports (user_id, created_at desc);

create trigger exports_updated_at
  before update on exports
  for each row execute function set_updated_at();
