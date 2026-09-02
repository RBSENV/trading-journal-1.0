-- Ledger — complete database setup. FRESH projects only.

-- ═══ 0001_foundation.sql ═══

-- 0001_foundation.sql
-- Extensions, enums, shared functions, and the two tables everything else hangs off.
-- RLS is enabled in the same statement block as every table it protects. Never separately.

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------

create type trade_status      as enum ('draft','open','partially_closed','closed','cancelled','archived');
create type trade_direction   as enum ('long','short');
create type trade_outcome     as enum ('win','loss','breakeven','scratch');
create type entry_grade       as enum ('A','B','C');
create type plan_adherence    as enum ('yes','no','partially');

create type leg_action        as enum ('buy','sell','short','cover','add','reduce','close','custom');
create type leg_role          as enum ('entry','scale_in','partial_exit','final_exit','other');
create type level_kind        as enum ('stop','target');

create type event_type as enum (
  'trade_created','entry','add_to_position','partial_exit','full_exit',
  'stop_moved','target_moved','thesis_update','market_observation',
  'economic_news','coinglass_observation','screenshot_added','note',
  'mistake_or_rule_break','custom'
);
create type event_importance  as enum ('low','normal','high');

create type mistake_phase     as enum ('pre_trade','entry','management','exit','review');

create type attachment_kind   as enum ('image','chart_link','file');
create type attachment_stage  as enum ('before_entry','entry','during_trade','partial_exit','final_exit','after_trade','daily_prep','custom');
create type chart_timeframe   as enum ('1m','5m','15m','30m','1h','4h','daily','weekly','custom');
create type upload_status     as enum ('pending','uploading','uploaded','failed','orphaned');

create type market_bias       as enum ('bullish','bearish','neutral','mixed');
create type prep_level_type   as enum ('support','resistance','pivot','vwap','liquidity','open','high','low','invalidation','target','custom');
create type event_impact      as enum ('low','medium','high');
create type observation_source as enum ('coinglass','tradingview','order_flow','on_chain','news','custom');

create type tag_category      as enum ('setup','mistake','emotion','market','instrument','custom');
create type taggable_type     as enum ('trade','trade_leg','trade_event','attachment','daily_prep','observation');

create type mutation_op       as enum ('insert','update','delete','restore');
create type backup_kind       as enum ('nightly','weekly','monthly','manual','pre_migration');
create type export_format     as enum ('json','csv','zip','analysis_a','analysis_b','analysis_c');
create type conflict_choice   as enum ('local','remote','merged','both_kept');

-- ---------------------------------------------------------------------------
-- Shared functions
-- ---------------------------------------------------------------------------

-- Server clock owns created_at/updated_at. Users edit event times, never record times.
create or replace function set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- Guards against a client ever claiming another user's rows.
create or replace function enforce_owner()
returns trigger
language plpgsql
as $$
begin
  if new.user_id is distinct from auth.uid() then
    raise exception 'user_id must match the authenticated user';
  end if;
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- app_meta — schema version, export format version, feature flags
-- ---------------------------------------------------------------------------

create table app_meta (
  key        text primary key,
  value      jsonb not null,
  updated_at timestamptz not null default now()
);

alter table app_meta enable row level security;

create policy app_meta_read on app_meta
  for select to authenticated using (true);

-- ---------------------------------------------------------------------------
-- profiles
-- ---------------------------------------------------------------------------

create table profiles (
  id           uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  timezone     text not null default 'America/New_York',
  settings     jsonb not null default '{}'::jsonb,
  onboarded_at timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

alter table profiles enable row level security;

create policy profiles_owner on profiles
  for all to authenticated
  using (id = auth.uid())
  with check (id = auth.uid());

create trigger profiles_updated_at
  before update on profiles
  for each row execute function set_updated_at();

-- Every new auth user gets a profile automatically.
create or replace function handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, display_name)
  values (new.id, coalesce(new.raw_user_meta_data->>'display_name', split_part(new.email,'@',1)))
  on conflict (id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function handle_new_user();

-- ---------------------------------------------------------------------------
-- devices — provenance for every edit, and the multi-device story
-- ---------------------------------------------------------------------------

create table devices (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  label         text not null,
  user_agent    text,
  first_seen_at timestamptz not null default now(),
  last_seen_at  timestamptz not null default now(),
  last_sync_at  timestamptz,
  revoked_at    timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

alter table devices enable row level security;

create policy devices_owner on devices
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

create index devices_user_idx on devices (user_id, last_seen_at desc);

create trigger devices_updated_at
  before update on devices
  for each row execute function set_updated_at();

-- ═══ 0002_infrastructure.sql ═══

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

-- ═══ 0003_domain.sql ═══

-- 0003_domain.sql
-- Reference data and the trade model. Includes every Tier 1 field, which is
-- what makes the analysis export worth pasting into a chat.
--
-- Instrument-agnostic by construction: nothing below branches on asset class.
-- tick_size and contract_multiplier are display hints the user supplies, never
-- inputs to a calculation.

-- ---------------------------------------------------------------------------
-- instruments
-- ---------------------------------------------------------------------------

create table instruments (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid not null references auth.users(id) on delete cascade,
  symbol              text not null,
  display_name        text,
  asset_class         text,          -- optional label only
  venue               text,
  tick_size           numeric,       -- display hint
  contract_multiplier numeric,       -- display hint
  price_decimals      integer,       -- display hint
  notes               text,
  is_active           boolean not null default true,
  sort_order          integer not null default 0,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  deleted_at          timestamptz,
  rev                 integer not null default 1,
  origin_device       uuid,
  last_mutation       uuid
);

alter table instruments enable row level security;
create policy instruments_owner on instruments for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

create unique index instruments_symbol_uniq on instruments (user_id, upper(symbol)) where deleted_at is null;
create trigger instruments_updated_at before update on instruments for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- setups — your playbook. Versioned, so old trades keep the rules they were taken under.
-- ---------------------------------------------------------------------------

create table setups (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references auth.users(id) on delete cascade,
  name              text not null,
  description       text,
  rules             jsonb not null default '[]'::jsonb,
  confluences       jsonb not null default '[]'::jsonb,  -- reusable checklist, ticked at entry
  default_session   text,
  default_timeframe text,
  version           integer not null default 1,
  is_active         boolean not null default true,
  sort_order        integer not null default 0,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  deleted_at        timestamptz,
  rev               integer not null default 1,
  origin_device     uuid,
  last_mutation     uuid
);

alter table setups enable row level security;
create policy setups_owner on setups for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

create unique index setups_name_uniq on setups (user_id, lower(name)) where deleted_at is null;
create trigger setups_updated_at before update on setups for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- tags + taggings
-- ---------------------------------------------------------------------------

create table tags (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  name          text not null,
  category      tag_category not null default 'custom',
  color         text,
  description   text,
  is_system     boolean not null default false,
  usage_count   integer not null default 0,
  is_active     boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz,
  rev           integer not null default 1,
  origin_device uuid,
  last_mutation uuid
);

alter table tags enable row level security;
create policy tags_owner on tags for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

create unique index tags_name_uniq on tags (user_id, lower(name)) where deleted_at is null;
create trigger tags_updated_at before update on tags for each row execute function set_updated_at();

create table taggings (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  tag_id        uuid not null references tags(id) on delete cascade,
  entity_type   taggable_type not null,
  entity_id     uuid not null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz,
  rev           integer not null default 1,
  origin_device uuid,
  last_mutation uuid
);

alter table taggings enable row level security;
create policy taggings_owner on taggings for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

create unique index taggings_uniq on taggings (tag_id, entity_type, entity_id) where deleted_at is null;
create index taggings_entity_idx on taggings (entity_type, entity_id) where deleted_at is null;
create trigger taggings_updated_at before update on taggings for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- trades — the parent record
-- ---------------------------------------------------------------------------

create table trades (
  id                     uuid primary key default gen_random_uuid(),
  user_id                uuid not null references auth.users(id) on delete cascade,
  trade_number           bigint,                 -- human-readable, assigned by trigger
  status                 trade_status not null default 'draft',

  -- instrument. symbol_snapshot survives an instrument rename.
  instrument_id          uuid references instruments(id) on delete set null,
  symbol_snapshot        text,
  asset_class            text,
  venue                  text,
  account_label          text,

  -- direction and setup
  direction              trade_direction,
  setup_id               uuid references setups(id) on delete set null,
  setup_name_snapshot    text,
  setup_version_snapshot integer,
  market_condition       text,
  session_label          text,                   -- manual
  session_derived        text,                   -- computed from first leg NY time

  -- TIER 1: graded before the outcome is known
  grade_at_entry         entry_grade,
  conviction             smallint check (conviction between 1 and 5),

  -- TIER 1: plan, captured before/at entry
  thesis                 text,
  invalidation_thesis    text,
  pre_trade_plan         text,
  planned_entry          numeric,
  planned_stop           numeric,
  planned_target         numeric,
  planned_rr             numeric,                -- derived client-side, stored
  risk_amount            numeric,                -- the 1R
  risk_unit              text,                   -- '$','%','ticks','pts' — free text

  -- protective levels. Full history lives in trade_levels.
  initial_stop           numeric,
  initial_target         numeric,
  current_stop           numeric,
  current_target         numeric,

  -- outcome. MANUAL ENTRY ONLY. Nothing here is ever computed from legs.
  final_pnl_amount       numeric,
  final_pnl_currency     text default 'USD',
  final_pnl_percent      numeric,
  realized_r             numeric,                -- derived from pnl/risk, overridable
  mae_price              numeric,                -- TIER 1
  mfe_price              numeric,                -- TIER 1
  exit_efficiency        numeric,                -- TIER 1, derived
  outcome                trade_outcome,

  -- review
  during_trade_notes     text,
  post_trade_review      text,
  what_went_well         text,
  what_went_wrong        text,
  lesson_learned         text,
  followed_plan          plan_adherence,
  would_take_again       boolean,
  process_grade          smallint check (process_grade between 0 and 10),
  needs_review           boolean not null default true,
  reviewed_at            timestamptz,

  -- timing. User-asserted and editable; distinct from created_at.
  opened_at              timestamptz,
  closed_at              timestamptz,
  tz_label               text not null default 'America/New_York',

  correlated_note        text,

  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  deleted_at             timestamptz,
  rev                    integer not null default 1,
  origin_device          uuid,
  last_mutation          uuid
);

alter table trades enable row level security;
create policy trades_owner on trades for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

create index trades_status_idx    on trades (user_id, status, opened_at desc) where deleted_at is null;
create index trades_instrument_idx on trades (user_id, instrument_id, opened_at desc) where deleted_at is null;
create index trades_review_idx    on trades (user_id, needs_review) where deleted_at is null and needs_review;
create index trades_number_idx    on trades (user_id, trade_number desc);
create trigger trades_updated_at before update on trades for each row execute function set_updated_at();

-- Sequential per-user trade number. Locks on the user id so two devices
-- syncing at once can't collide.
create or replace function assign_trade_number()
returns trigger
language plpgsql
as $$
begin
  if new.trade_number is null then
    perform pg_advisory_xact_lock(hashtext(new.user_id::text));
    select coalesce(max(trade_number), 0) + 1 into new.trade_number
      from trades where user_id = new.user_id;
  end if;
  return new;
end;
$$;

create trigger trades_assign_number
  before insert on trades
  for each row execute function assign_trade_number();

-- ---------------------------------------------------------------------------
-- trade_mistakes — TIER 1. A closed list becomes statistics; freeform prose never does.
-- ---------------------------------------------------------------------------

create table trade_mistakes (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  trade_id      uuid not null references trades(id) on delete cascade,
  mistake_key   text not null,
  phase         mistake_phase,
  severity      smallint check (severity between 1 and 3),
  note          text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz,
  rev           integer not null default 1,
  origin_device uuid,
  last_mutation uuid
);

alter table trade_mistakes enable row level security;
create policy trade_mistakes_owner on trade_mistakes for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

create index trade_mistakes_trade_idx on trade_mistakes (trade_id) where deleted_at is null;
create index trade_mistakes_key_idx on trade_mistakes (user_id, mistake_key) where deleted_at is null;
create trigger trade_mistakes_updated_at before update on trade_mistakes for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- trade_legs — revision model. Editing a leg inserts a new row rather than
-- overwriting, which is what makes edit history real rather than aspirational.
-- ---------------------------------------------------------------------------

create table trade_legs (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  trade_id      uuid not null references trades(id) on delete cascade,
  sequence      integer not null default 0,
  action        leg_action not null,
  action_custom text,
  leg_role      leg_role,
  price         numeric not null,
  quantity      numeric not null,
  quantity_unit text,
  executed_at   timestamptz not null,            -- USER-EDITABLE
  tz_label      text not null default 'America/New_York',
  notes         text,
  is_superseded boolean not null default false,
  supersedes_id uuid references trade_legs(id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz,
  rev           integer not null default 1,
  origin_device uuid,
  last_mutation uuid
);

alter table trade_legs enable row level security;
create policy trade_legs_owner on trade_legs for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

create index trade_legs_current_idx on trade_legs (trade_id, sequence) where not is_superseded and deleted_at is null;
create trigger trade_legs_updated_at before update on trade_legs for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- trade_levels — append-only stop/target history
-- ---------------------------------------------------------------------------

create table trade_levels (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users(id) on delete cascade,
  trade_id        uuid not null references trades(id) on delete cascade,
  kind            level_kind not null,
  price           numeric not null,
  effective_at    timestamptz not null,          -- USER-EDITABLE
  tz_label        text not null default 'America/New_York',
  reason          text,
  source_event_id uuid,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  deleted_at      timestamptz,
  rev             integer not null default 1,
  origin_device   uuid,
  last_mutation   uuid
);

alter table trade_levels enable row level security;
create policy trade_levels_owner on trade_levels for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

create index trade_levels_idx on trade_levels (trade_id, kind, effective_at desc) where deleted_at is null;
create trigger trade_levels_updated_at before update on trade_levels for each row execute function set_updated_at();

-- Keep trades.current_stop / current_target in step with the latest level.
create or replace function sync_current_level()
returns trigger
language plpgsql
as $$
declare
  latest numeric;
  tid uuid;
  k level_kind;
begin
  tid := coalesce(new.trade_id, old.trade_id);
  k   := coalesce(new.kind, old.kind);

  select price into latest
    from trade_levels
   where trade_id = tid and kind = k and deleted_at is null
   order by effective_at desc, created_at desc
   limit 1;

  if k = 'stop' then
    update trades set current_stop = latest where id = tid;
  else
    update trades set current_target = latest where id = tid;
  end if;

  return null;
end;
$$;

create trigger trade_levels_sync
  after insert or update or delete on trade_levels
  for each row execute function sync_current_level();

-- ---------------------------------------------------------------------------
-- trade_events — the timeline
-- ---------------------------------------------------------------------------

create table trade_events (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references auth.users(id) on delete cascade,
  trade_id          uuid not null references trades(id) on delete cascade,
  event_type        event_type not null,
  event_type_custom text,
  occurred_at       timestamptz not null,        -- USER-EDITABLE
  tz_label          text not null default 'America/New_York',
  title             text,
  description       text,
  importance        event_importance not null default 'normal',
  linked_leg_id     uuid references trade_legs(id) on delete set null,
  linked_level_id   uuid references trade_levels(id) on delete set null,
  linked_prep_id    uuid,
  payload           jsonb not null default '{}'::jsonb,  -- forward-compat hatch
  is_superseded     boolean not null default false,
  supersedes_id     uuid references trade_events(id) on delete set null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  deleted_at        timestamptz,
  rev               integer not null default 1,
  origin_device     uuid,
  last_mutation     uuid
);

alter table trade_events enable row level security;
create policy trade_events_owner on trade_events for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

create index trade_events_timeline_idx on trade_events (trade_id, occurred_at desc)
  where not is_superseded and deleted_at is null;
create trigger trade_events_updated_at before update on trade_events for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- attachments — screenshots and chart links in one table.
-- They share every metadata field and differ only in whether the payload is a
-- stored object or a URL. Splitting them would duplicate search, filter,
-- export and audit logic for no gain.
-- ---------------------------------------------------------------------------

create table attachments (
  id                   uuid primary key default gen_random_uuid(),
  user_id              uuid not null references auth.users(id) on delete cascade,
  kind                 attachment_kind not null default 'image',

  trade_id             uuid references trades(id) on delete cascade,
  trade_event_id       uuid references trade_events(id) on delete cascade,
  trade_leg_id         uuid references trade_legs(id) on delete cascade,
  daily_prep_id        uuid,
  observation_id       uuid,

  stage                attachment_stage,
  stage_custom         text,
  timeframe            chart_timeframe,
  timeframe_custom     text,
  captured_at          timestamptz not null default now(),   -- USER-EDITABLE
  tz_label             text not null default 'America/New_York',

  caption              text,
  context_note         text,          -- carries the chart into a text-only analysis
  url                  text,          -- chart_link only

  storage_bucket       text,
  storage_key          text,          -- {user_id}/{yyyy}/{mm}/{id}.{ext} on R2
  mime_type            text,
  byte_size            bigint,
  width                integer,
  height               integer,
  sha256               text,
  original_filename    text,
  original_captured_at timestamptz,   -- EXIF hint; often stripped by iOS. Never trusted.
  thumbnail_key        text,

  upload_status        upload_status not null default 'pending',
  upload_attempts      integer not null default 0,
  last_upload_error    text,

  annotations          jsonb,         -- reserved. Empty in v1, no migration needed later.

  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  deleted_at           timestamptz,
  rev                  integer not null default 1,
  origin_device        uuid,
  last_mutation        uuid,

  constraint attachment_has_parent check (
    trade_id is not null or trade_event_id is not null or trade_leg_id is not null
    or daily_prep_id is not null or observation_id is not null
  )
);

alter table attachments enable row level security;
create policy attachments_owner on attachments for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

create index attachments_trade_idx on attachments (trade_id, stage) where deleted_at is null;
create index attachments_prep_idx  on attachments (daily_prep_id) where deleted_at is null;
create index attachments_pending_idx on attachments (user_id, upload_status)
  where upload_status <> 'uploaded' and deleted_at is null;
create trigger attachments_updated_at before update on attachments for each row execute function set_updated_at();

-- ═══ 0004_prep.sql ═══

-- 0004_prep.sql
-- Daily Preparation journal and everything that hangs off it.
--
-- Two forward-compatibility decisions worth noting:
--   economic_events.source and observations.source mean a future API
--   integration writes rows alongside your manual ones rather than replacing
--   them. No migration, no dual-write, and manual capture never stops working.

create table daily_preps (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid not null references auth.users(id) on delete cascade,
  prep_date           date not null,                     -- NY calendar date
  general_bias        market_bias,
  general_bias_note   text,
  market_thesis       text,
  planned_setups      text,
  daily_plan          text,
  end_of_day_review   text,
  lessons             text,
  sleep_hours         numeric,
  condition_note      text,
  needs_review        boolean not null default true,
  reviewed_at         timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  deleted_at          timestamptz,
  rev                 integer not null default 1,
  origin_device       uuid,
  last_mutation       uuid
);

alter table daily_preps enable row level security;
create policy daily_preps_owner on daily_preps for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

create unique index daily_preps_date_uniq on daily_preps (user_id, prep_date) where deleted_at is null;
create index daily_preps_recent_idx on daily_preps (user_id, prep_date desc) where deleted_at is null;
create trigger daily_preps_updated_at before update on daily_preps for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- prep_instrument_bias
-- ---------------------------------------------------------------------------

create table prep_instrument_bias (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  daily_prep_id uuid not null references daily_preps(id) on delete cascade,
  instrument_id uuid references instruments(id) on delete set null,
  bias          market_bias,
  note          text,
  sort_order    integer not null default 0,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz,
  rev           integer not null default 1,
  origin_device uuid,
  last_mutation uuid
);

alter table prep_instrument_bias enable row level security;
create policy prep_bias_owner on prep_instrument_bias for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

create index prep_bias_prep_idx on prep_instrument_bias (daily_prep_id) where deleted_at is null;
create trigger prep_bias_updated_at before update on prep_instrument_bias for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- prep_levels — structured, not a text blob.
-- Same typing effort; lets you later ask "how do I do when I enter at a level
-- I marked pre-session", which prose can never answer.
-- ---------------------------------------------------------------------------

create table prep_levels (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references auth.users(id) on delete cascade,
  daily_prep_id     uuid not null references daily_preps(id) on delete cascade,
  instrument_id     uuid references instruments(id) on delete set null,
  level_type        prep_level_type not null default 'custom',
  level_type_custom text,
  price             numeric not null,
  price_upper       numeric,                    -- for zones
  label             text,
  note              text,
  sort_order        integer not null default 0,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  deleted_at        timestamptz,
  rev               integer not null default 1,
  origin_device     uuid,
  last_mutation     uuid
);

alter table prep_levels enable row level security;
create policy prep_levels_owner on prep_levels for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

create index prep_levels_prep_idx on prep_levels (daily_prep_id, sort_order) where deleted_at is null;
create trigger prep_levels_updated_at before update on prep_levels for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- economic_events — manual capture in v1
-- ---------------------------------------------------------------------------

create table economic_events (
  id                   uuid primary key default gen_random_uuid(),
  user_id              uuid not null references auth.users(id) on delete cascade,
  daily_prep_id        uuid references daily_preps(id) on delete cascade,
  name                 text not null,
  scheduled_at         timestamptz not null,     -- USER-EDITABLE
  tz_label             text not null default 'America/New_York',
  impact               event_impact,
  instruments_affected uuid[],
  forecast             text,
  actual               text,
  reaction_note        text,
  source               text not null default 'manual',   -- future: 'api:<provider>'
  external_id          text,                              -- future dedupe key
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  deleted_at           timestamptz,
  rev                  integer not null default 1,
  origin_device        uuid,
  last_mutation        uuid
);

alter table economic_events enable row level security;
create policy economic_events_owner on economic_events for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

create index econ_events_prep_idx on economic_events (daily_prep_id) where deleted_at is null;
create index econ_events_time_idx on economic_events (user_id, scheduled_at desc) where deleted_at is null;
create trigger econ_events_updated_at before update on economic_events for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- observations — CoinGlass and anything else.
-- value_text is deliberately text, not numeric: "funding flipped negative"
-- is as useful as "-0.012%" and you shouldn't have to choose.
-- ---------------------------------------------------------------------------

create table observations (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  daily_prep_id uuid references daily_preps(id) on delete cascade,
  trade_id      uuid references trades(id) on delete cascade,
  source        observation_source not null default 'custom',
  source_custom text,
  observed_at   timestamptz not null default now(),   -- USER-EDITABLE
  tz_label      text not null default 'America/New_York',
  metric        text,
  value_text    text,
  note          text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz,
  rev           integer not null default 1,
  origin_device uuid,
  last_mutation uuid
);

alter table observations enable row level security;
create policy observations_owner on observations for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

create index observations_prep_idx  on observations (daily_prep_id) where deleted_at is null;
create index observations_trade_idx on observations (trade_id) where deleted_at is null;
create trigger observations_updated_at before update on observations for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- trade_prep_links — many-to-many
-- ---------------------------------------------------------------------------

create table trade_prep_links (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  trade_id      uuid not null references trades(id) on delete cascade,
  daily_prep_id uuid not null references daily_preps(id) on delete cascade,
  note          text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz,
  rev           integer not null default 1,
  origin_device uuid,
  last_mutation uuid
);

alter table trade_prep_links enable row level security;
create policy trade_prep_links_owner on trade_prep_links for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

create unique index trade_prep_links_uniq on trade_prep_links (trade_id, daily_prep_id) where deleted_at is null;
create trigger trade_prep_links_updated_at before update on trade_prep_links for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- missed_trades — setups you saw and skipped. Schema now, UI later.
-- ---------------------------------------------------------------------------

create table missed_trades (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null references auth.users(id) on delete cascade,
  daily_prep_id      uuid references daily_preps(id) on delete set null,
  instrument_id      uuid references instruments(id) on delete set null,
  setup_id           uuid references setups(id) on delete set null,
  direction          trade_direction,
  reason_skipped     text,
  would_have_outcome text,
  lesson             text,
  observed_at        timestamptz not null default now(),
  tz_label           text not null default 'America/New_York',
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  deleted_at         timestamptz,
  rev                integer not null default 1,
  origin_device      uuid,
  last_mutation      uuid
);

alter table missed_trades enable row level security;
create policy missed_trades_owner on missed_trades for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

create index missed_trades_idx on missed_trades (user_id, observed_at desc) where deleted_at is null;
create trigger missed_trades_updated_at before update on missed_trades for each row execute function set_updated_at();

-- Deferred FKs now that both sides exist.
alter table attachments
  add constraint attachments_prep_fk
  foreign key (daily_prep_id) references daily_preps(id) on delete cascade;

alter table attachments
  add constraint attachments_observation_fk
  foreign key (observation_id) references observations(id) on delete cascade;

alter table trade_events
  add constraint trade_events_prep_fk
  foreign key (linked_prep_id) references daily_preps(id) on delete set null;

alter table trade_levels
  add constraint trade_levels_event_fk
  foreign key (source_event_id) references trade_events(id) on delete set null;

-- ═══ 0005_audit_and_seed.sql ═══

-- 0005_audit_and_seed.sql
-- Attach the audit trigger to every domain table, and seed the metadata the
-- app reads on boot.
--
-- Audit is by trigger, not by application code: the client cannot skip it,
-- cannot forge it, and cannot write to audit_log at all.

do $$
declare
  t text;
begin
  foreach t in array array[
    'instruments','setups','tags','taggings',
    'trades','trade_mistakes','trade_legs','trade_levels','trade_events','attachments',
    'daily_preps','prep_instrument_bias','prep_levels',
    'economic_events','observations','trade_prep_links','missed_trades'
  ]
  loop
    execute format(
      'create trigger %I after insert or update or delete on %I
         for each row execute function write_audit()', t || '_audit', t);
  end loop;
end
$$;

-- ---------------------------------------------------------------------------
-- Seed metadata
-- ---------------------------------------------------------------------------

insert into app_meta (key, value) values
  ('schema_version',        '"1.0.0"'::jsonb),
  ('export_format_version', '"1.0.0"'::jsonb),
  ('timezone',              '"America/New_York"'::jsonb)
on conflict (key) do update set value = excluded.value, updated_at = now();

-- The starting mistake taxonomy. Stored as metadata rather than an enum so you
-- can extend it from the app without a migration; the closed-list discipline
-- comes from the UI offering these first, not from the database refusing others.
insert into app_meta (key, value) values (
  'mistake_taxonomy',
  '[
    {"key":"no_plan","label":"No plan","phase":"pre_trade"},
    {"key":"entered_early","label":"Entered early","phase":"entry"},
    {"key":"entered_late","label":"Entered late","phase":"entry"},
    {"key":"chased","label":"Chased","phase":"entry"},
    {"key":"oversized","label":"Oversized","phase":"entry"},
    {"key":"undersized","label":"Undersized","phase":"entry"},
    {"key":"no_stop","label":"No stop","phase":"entry"},
    {"key":"moved_stop_against_plan","label":"Moved stop against plan","phase":"management"},
    {"key":"removed_stop","label":"Removed stop","phase":"management"},
    {"key":"exited_early","label":"Exited early","phase":"exit"},
    {"key":"held_past_invalidation","label":"Held past invalidation","phase":"management"},
    {"key":"revenge_trade","label":"Revenge trade","phase":"pre_trade"},
    {"key":"fomo","label":"FOMO","phase":"pre_trade"},
    {"key":"traded_outside_session","label":"Traded outside session","phase":"pre_trade"},
    {"key":"traded_outside_playbook","label":"Traded outside playbook","phase":"pre_trade"},
    {"key":"overtraded","label":"Overtraded","phase":"pre_trade"},
    {"key":"ignored_news_event","label":"Ignored news event","phase":"pre_trade"},
    {"key":"platform_error","label":"Platform error","phase":"entry"},
    {"key":"fat_finger","label":"Fat finger","phase":"entry"}
  ]'::jsonb
) on conflict (key) do update set value = excluded.value, updated_at = now();

insert into app_meta (key, value) values (
  'sessions',
  '["Asia","London","NY AM","NY Lunch","NY PM","Globex Overnight","Weekend"]'::jsonb
) on conflict (key) do update set value = excluded.value, updated_at = now();

-- ---------------------------------------------------------------------------
-- Per-user starter data, created on first sign-in rather than seeded globally.
-- ---------------------------------------------------------------------------

create or replace function seed_user_defaults()
returns void
language plpgsql
security definer set search_path = public
as $$
declare
  uid uuid := auth.uid();
begin
  if uid is null then
    raise exception 'not authenticated';
  end if;

  insert into instruments (user_id, symbol, display_name, asset_class, venue, sort_order)
  values
    (uid, 'BTC', 'Bitcoin',   'crypto',  null, 1),
    (uid, 'ETH', 'Ethereum',  'crypto',  null, 2),
    (uid, 'ES',  'E-mini S&P 500', 'futures', 'CME', 3),
    (uid, 'NQ',  'E-mini Nasdaq 100', 'futures', 'CME', 4)
  on conflict do nothing;

  update profiles set onboarded_at = coalesce(onboarded_at, now()) where id = uid;
end;
$$;

grant execute on function seed_user_defaults() to authenticated;

-- ---------------------------------------------------------------------------
-- Keep-alive. Called by the Cloudflare Worker and the GitHub Action.
-- Reads nothing sensitive; its only job is to reset the free-tier idle timer.
-- ---------------------------------------------------------------------------

create or replace function heartbeat()
returns jsonb
language sql
security definer set search_path = public
as $$
  select jsonb_build_object('ok', true, 'at', now());
$$;

grant execute on function heartbeat() to anon, authenticated;

-- ═══ 0006_grants.sql ═══

-- 0006_grants.sql
--
-- Explicit Data API grants.
--
-- Supabase changed the platform default on 2026-05-30: tables created in
-- public are no longer automatically reachable through the Data API. Without
-- the grants below, every table would exist, RLS would be correct, and the app
-- would still get "permission denied" on every query.
--
-- Two different controls, both required:
--   GRANT  decides whether a role can touch the table at all
--   RLS    decides which rows it gets back
-- We use both on every object. Grants stay narrow: the client can never write
-- to the audit trail, and can only append to the mutation log.

-- ---------------------------------------------------------------------------
-- Full read/write for the signed-in user. RLS still restricts every statement
-- to rows where user_id = auth.uid().
-- ---------------------------------------------------------------------------

grant select, insert, update, delete on
  profiles,
  devices,
  instruments,
  setups,
  tags,
  taggings,
  trades,
  trade_mistakes,
  trade_legs,
  trade_levels,
  trade_events,
  attachments,
  daily_preps,
  prep_instrument_bias,
  prep_levels,
  economic_events,
  observations,
  trade_prep_links,
  missed_trades,
  sync_state,
  conflicts,
  backups,
  exports
to authenticated;

-- ---------------------------------------------------------------------------
-- Append-only: the sync log records what happened and is never rewritten.
-- ---------------------------------------------------------------------------

grant select, insert on mutation_log to authenticated;

-- ---------------------------------------------------------------------------
-- Read-only: the audit trail is written by triggers running as the definer.
-- No client-reachable role can insert, update, or delete here, which is the
-- whole point of putting history in the database rather than in app code.
-- ---------------------------------------------------------------------------

grant select on audit_log to authenticated;
grant select on app_meta  to authenticated;

-- ---------------------------------------------------------------------------
-- Sequences behind the bigserial columns the client inserts into.
-- audit_log's sequence is deliberately excluded — triggers own that table.
-- ---------------------------------------------------------------------------

grant usage, select on sequence mutation_log_seq_seq to authenticated;

-- ---------------------------------------------------------------------------
-- Functions
-- ---------------------------------------------------------------------------

grant execute on function seed_user_defaults() to authenticated;
grant execute on function heartbeat()          to anon, authenticated;

-- ---------------------------------------------------------------------------
-- Nothing is granted to anon beyond the heartbeat. An unauthenticated caller
-- can reach exactly one function, which returns a timestamp and nothing else.
-- ---------------------------------------------------------------------------

revoke all on schema public from anon;
grant usage on schema public to anon, authenticated;

-- ═══ 0007_sync_engine.sql ═══

-- 0007_sync_engine.sql
--
-- The server half of offline sync.
--
-- Two guarantees this file exists to provide:
--
--   1. IDEMPOTENCY. The client generates a uuid for every mutation before it
--      touches the network. Applying the same mutation id twice is a no-op.
--      That is what makes "retry on flaky signal" safe rather than a way to
--      duplicate your trades.
--
--   2. NOTHING IS DISCARDED SILENTLY. When two devices edit the same field
--      while offline, the loser is never simply dropped. Numeric and
--      structural fields take last-write-wins and log a conflict; narrative
--      text keeps BOTH versions and asks the human.

-- ---------------------------------------------------------------------------
-- Global change sequence.
--
-- Every domain row carries updated_seq from one shared sequence, so a client
-- can pull "everything that changed since N" in one ordered pass. Using a
-- sequence rather than a timestamp means device clock skew cannot reorder or
-- hide a change.
-- ---------------------------------------------------------------------------

create sequence change_seq;

create or replace function stamp_change_seq()
returns trigger
language plpgsql
as $$
begin
  new.updated_seq := nextval('change_seq');
  return new;
end;
$$;

do $$
declare t text;
begin
  foreach t in array array[
    'profiles','devices','instruments','setups','tags','taggings',
    'trades','trade_mistakes','trade_legs','trade_levels','trade_events','attachments',
    'daily_preps','prep_instrument_bias','prep_levels',
    'economic_events','observations','trade_prep_links','missed_trades'
  ]
  loop
    execute format('alter table %I add column updated_seq bigint', t);
    execute format('create index %I on %I (user_id, updated_seq)', t || '_seq_idx', t);
    -- BEFORE, and ordered to run after set_updated_at (alphabetically later name).
    execute format(
      'create trigger zz_%I_seq before insert or update on %I
         for each row execute function stamp_change_seq()', t, t);
    execute format('update %I set updated_seq = nextval(''change_seq'')', t);
  end loop;
end
$$;

-- profiles has no user_id column; its index needs the pk instead.
drop index profiles_seq_idx;
create index profiles_seq_idx on profiles (id, updated_seq);

-- ---------------------------------------------------------------------------
-- Which tables the client may write through the sync RPC, and which of their
-- columns are narrative (never overwritten on conflict).
-- ---------------------------------------------------------------------------

create table sync_tables (
  table_name    text primary key,
  narrative_cols text[] not null default '{}',
  append_only   boolean not null default false
);

alter table sync_tables enable row level security;
create policy sync_tables_read on sync_tables for select to authenticated using (true);
grant select on sync_tables to authenticated;

insert into sync_tables (table_name, narrative_cols, append_only) values
  ('instruments',          '{notes}', false),
  ('setups',               '{description}', false),
  ('tags',                 '{description}', false),
  ('taggings',             '{}', true),
  ('trades',               '{thesis,invalidation_thesis,pre_trade_plan,during_trade_notes,post_trade_review,what_went_well,what_went_wrong,lesson_learned,correlated_note,market_condition}', false),
  ('trade_mistakes',       '{note}', false),
  ('trade_legs',           '{notes}', true),
  ('trade_levels',         '{reason}', true),
  ('trade_events',         '{description}', true),
  ('attachments',          '{caption,context_note}', false),
  ('daily_preps',          '{market_thesis,planned_setups,daily_plan,end_of_day_review,lessons,general_bias_note,condition_note}', false),
  ('prep_instrument_bias', '{note}', false),
  ('prep_levels',          '{note}', false),
  ('economic_events',      '{reaction_note,forecast,actual}', false),
  ('observations',         '{note}', false),
  ('trade_prep_links',     '{note}', true),
  ('missed_trades',        '{reason_skipped,would_have_outcome,lesson}', false);

-- ---------------------------------------------------------------------------
-- push_mutations(mutations jsonb)
--
-- Each element: {id, entity_type, entity_id, op, payload, base_rev, client_time, device_id}
-- Returns one result row per mutation so the client can retire its outbox
-- precisely rather than assuming the whole batch landed.
-- ---------------------------------------------------------------------------

create or replace function push_mutations(mutations jsonb)
returns jsonb
language plpgsql
security invoker           -- RLS still applies; the client cannot reach other users' rows
as $$
declare
  m           jsonb;
  results     jsonb := '[]'::jsonb;
  uid         uuid := auth.uid();
  tbl         text;
  ent_id      uuid;
  op          text;
  payload     jsonb;
  base_rev    integer;
  mut_id      uuid;
  dev         uuid;
  cfg         sync_tables%rowtype;
  cur_rev     integer;
  cur_row     jsonb;
  cols        text[];
  vals        text[];
  k           text;
  v           jsonb;
  set_list    text;
  col_list    text;
  val_list    text;
  conflicted  text[] := '{}';
  new_seq     bigint;
  status      text;
begin
  if uid is null then
    raise exception 'not authenticated';
  end if;

  for m in select * from jsonb_array_elements(mutations)
  loop
    mut_id   := (m->>'id')::uuid;
    tbl      := m->>'entity_type';
    ent_id   := (m->>'entity_id')::uuid;
    op       := m->>'op';
    payload  := coalesce(m->'payload', '{}'::jsonb);
    base_rev := nullif(m->>'base_rev','')::integer;
    dev      := nullif(m->>'device_id','')::uuid;
    status   := 'applied';
    conflicted := '{}';

    -- Already applied? Idempotency is the whole point of the mutation id.
    if exists (select 1 from mutation_log where id = mut_id) then
      results := results || jsonb_build_object('id', mut_id, 'status', 'duplicate');
      continue;
    end if;

    select * into cfg from sync_tables where table_name = tbl;
    if not found then
      results := results || jsonb_build_object('id', mut_id, 'status', 'rejected',
                                               'reason', 'table not syncable');
      continue;
    end if;

    -- Strip anything the client must not set directly.
    payload := payload - 'id' - 'user_id' - 'created_at' - 'updated_at'
                       - 'rev' - 'updated_seq' - 'trade_number';

    if op = 'insert' then
      cols := array['id','user_id','origin_device','last_mutation'];
      vals := array[quote_literal(ent_id)||'::uuid', quote_literal(uid)||'::uuid',
                    coalesce(quote_literal(dev)||'::uuid','null'), quote_literal(mut_id)||'::uuid'];
      for k, v in select * from jsonb_each(payload) loop
        cols := cols || quote_ident(k);
        vals := vals || (case when v = 'null'::jsonb then 'null'
                              else quote_literal(v #>> '{}') end);
      end loop;
      col_list := array_to_string(cols, ',');
      val_list := array_to_string(vals, ',');
      execute format('insert into %I (%s) values (%s) on conflict (id) do nothing', tbl, col_list, val_list);

    elsif op in ('update','delete','restore') then
      execute format('select rev, to_jsonb(t) from %I t where id = $1', tbl)
        into cur_rev, cur_row using ent_id;

      if cur_rev is null then
        results := results || jsonb_build_object('id', mut_id, 'status', 'rejected',
                                                 'reason', 'row not found');
        continue;
      end if;

      if op = 'delete' then
        payload := jsonb_build_object('deleted_at', to_jsonb(now()));
      elsif op = 'restore' then
        payload := jsonb_build_object('deleted_at', 'null'::jsonb);
      end if;

      -- Conflict: the row moved on since this device last saw it.
      if base_rev is not null and base_rev <> cur_rev then
        for k, v in select * from jsonb_each(payload) loop
          if (cur_row -> k) is distinct from v then
            insert into conflicts (user_id, entity_type, entity_id, field_name,
                                   local_value, remote_value, local_device)
            values (uid, tbl, ent_id, k, v, cur_row -> k, dev);
            conflicted := conflicted || k;
          end if;
        end loop;

        -- Narrative text is never overwritten. Both versions survive; the
        -- conflict row is what the UI asks you about.
        if array_length(conflicted, 1) is not null then
          status := 'conflict';
          foreach k in array cfg.narrative_cols loop
            payload := payload - k;
          end loop;
        end if;
      end if;

      if payload <> '{}'::jsonb then
        set_list := '';
        for k, v in select * from jsonb_each(payload) loop
          if set_list <> '' then set_list := set_list || ','; end if;
          set_list := set_list || format('%I = %s', k,
            case when v = 'null'::jsonb then 'null' else quote_literal(v #>> '{}') end);
        end loop;
        execute format(
          'update %I set %s, rev = rev + 1, last_mutation = %L, origin_device = %L where id = %L',
          tbl, set_list, mut_id, dev, ent_id);
      end if;
    else
      results := results || jsonb_build_object('id', mut_id, 'status', 'rejected',
                                               'reason', 'unknown op');
      continue;
    end if;

    insert into mutation_log (id, user_id, device_id, client_seq, op, entity_type,
                              entity_id, payload, client_time, applied)
    values (mut_id, uid, dev, nullif(m->>'client_seq','')::bigint, op::mutation_op, tbl,
            ent_id, payload, nullif(m->>'client_time','')::timestamptz, true)
    returning seq into new_seq;

    results := results || jsonb_build_object(
      'id', mut_id, 'status', status, 'seq', new_seq,
      'conflicted', to_jsonb(conflicted));
  end loop;

  return results;
end;
$$;

grant execute on function push_mutations(jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- pull_changes(since bigint, batch int)
--
-- Everything the caller owns that changed after `since`, across every synced
-- table, plus the high-water mark to store as the next cursor.
-- Soft deletes arrive as rows with deleted_at set, never as absences — a
-- missing row would be indistinguishable from one that never synced.
-- ---------------------------------------------------------------------------

create or replace function pull_changes(since bigint default 0, batch integer default 500)
returns jsonb
language plpgsql
security invoker
as $$
declare
  t        text;
  rows_j   jsonb;
  out_j    jsonb := '{}'::jsonb;
  hwm      bigint := since;
  tbl_max  bigint;
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;

  foreach t in array array[
    'instruments','setups','tags','taggings',
    'trades','trade_mistakes','trade_legs','trade_levels','trade_events','attachments',
    'daily_preps','prep_instrument_bias','prep_levels',
    'economic_events','observations','trade_prep_links','missed_trades'
  ]
  loop
    execute format(
      'select coalesce(jsonb_agg(to_jsonb(x) order by x.updated_seq), ''[]''::jsonb),
              max(x.updated_seq)
         from (select * from %I where updated_seq > $1 order by updated_seq limit $2) x', t)
      into rows_j, tbl_max using since, batch;

    if jsonb_array_length(rows_j) > 0 then
      out_j := out_j || jsonb_build_object(t, rows_j);
      if tbl_max > hwm then hwm := tbl_max; end if;
    end if;
  end loop;

  return jsonb_build_object(
    'cursor',  hwm,
    'tables',  out_j,
    'server_time', now(),
    'complete', hwm >= (select last_value from change_seq)
  );
end;
$$;

grant execute on function pull_changes(bigint, integer) to authenticated;

-- ---------------------------------------------------------------------------
-- resolve_conflict — the human's answer, recorded
-- ---------------------------------------------------------------------------

create or replace function resolve_conflict(conflict_id uuid, choice text, merged_value jsonb default null)
returns void
language plpgsql
security invoker
as $$
declare
  c conflicts%rowtype;
  v jsonb;
begin
  select * into c from conflicts where id = conflict_id and user_id = auth.uid();
  if not found then raise exception 'conflict not found'; end if;

  v := case choice
         when 'local'  then c.local_value
         when 'remote' then c.remote_value
         when 'merged' then merged_value
         else null
       end;

  if v is not null and c.field_name is not null then
    execute format('update %I set %I = %s, rev = rev + 1 where id = %L and user_id = %L',
      c.entity_type, c.field_name,
      case when v = 'null'::jsonb then 'null' else quote_literal(v #>> '{}') end,
      c.entity_id, auth.uid());
  end if;

  update conflicts
     set resolved_at = now(), resolution = choice::conflict_choice
   where id = conflict_id;
end;
$$;

grant execute on function resolve_conflict(uuid, text, jsonb) to authenticated;

update app_meta set value = '"1.1.0"'::jsonb, updated_at = now() where key = 'schema_version';

-- ═══ 0007_sync_rpc.sql ═══

-- 0007_sync_rpc.sql
--
-- The pull side of sync.
--
-- Ordering by updated_at does not work: two rows written in the same
-- millisecond tie, a clock adjustment can move rows backwards, and a client
-- resuming from a timestamp cursor can silently skip whatever landed during
-- the tie. So every syncable row gets a value from one shared sequence, and
-- the client's cursor is a position in that sequence. Monotonic, gapless
-- enough to resume from, and immune to clocks entirely.

create sequence if not exists global_sync_seq;

do $$
declare t text;
begin
  foreach t in array array[
    'instruments','setups','tags','taggings',
    'trades','trade_mistakes','trade_legs','trade_levels','trade_events','attachments',
    'daily_preps','prep_instrument_bias','prep_levels',
    'economic_events','observations','trade_prep_links','missed_trades'
  ]
  loop
    execute format(
      'alter table %I add column if not exists sync_seq bigint not null default nextval(''global_sync_seq'')', t);
    execute format(
      'create index if not exists %I on %I (user_id, sync_seq)', t || '_sync_idx', t);
  end loop;
end
$$;

-- Any write advances the row's position, so an edit made on the Mac is picked
-- up by the phone on its next pull.
create or replace function bump_sync_seq()
returns trigger
language plpgsql
as $$
begin
  new.sync_seq := nextval('global_sync_seq');
  return new;
end;
$$;

do $$
declare t text;
begin
  foreach t in array array[
    'instruments','setups','tags','taggings',
    'trades','trade_mistakes','trade_legs','trade_levels','trade_events','attachments',
    'daily_preps','prep_instrument_bias','prep_levels',
    'economic_events','observations','trade_prep_links','missed_trades'
  ]
  loop
    execute format('drop trigger if exists %I on %I', t || '_bump_seq', t);
    execute format(
      'create trigger %I before update on %I
         for each row execute function bump_sync_seq()', t || '_bump_seq', t);
  end loop;
end
$$;

-- ---------------------------------------------------------------------------
-- pull_changes
--
-- Returns every row the caller owns that has moved past their cursor, batched.
-- Deletes arrive as rows with deleted_at set, never as absences — a row that
-- simply stopped appearing would be indistinguishable from one that was never
-- there, and the client would keep showing a deleted trade forever.
--
-- security definer with a hard auth.uid() filter: the function reads on the
-- caller's behalf but can only ever see the caller's own rows.
-- ---------------------------------------------------------------------------

create or replace function pull_changes(since bigint default 0, batch int default 500)
returns jsonb
language plpgsql
security definer set search_path = public
as $$
declare
  uid        uuid := auth.uid();
  tables     text[] := array[
    'instruments','setups','tags','taggings',
    'trades','trade_mistakes','trade_legs','trade_levels','trade_events','attachments',
    'daily_preps','prep_instrument_bias','prep_levels',
    'economic_events','observations','trade_prep_links','missed_trades'
  ];
  t          text;
  rows       jsonb;
  out_tables jsonb := '{}'::jsonb;
  max_seq    bigint := since;
  tbl_max    bigint;
  total      int := 0;
begin
  if uid is null then
    raise exception 'not authenticated';
  end if;

  foreach t in array tables loop
    execute format(
      'select coalesce(jsonb_agg(to_jsonb(x) order by x.sync_seq), ''[]''::jsonb),
              coalesce(max(x.sync_seq), $2)
         from (select * from %I
                where user_id = $1 and sync_seq > $2
                order by sync_seq
                limit $3) x', t)
      into rows, tbl_max
      using uid, since, batch;

    if jsonb_array_length(rows) > 0 then
      out_tables := out_tables || jsonb_build_object(t, rows);
      total := total + jsonb_array_length(rows);
      if tbl_max > max_seq then max_seq := tbl_max; end if;
    end if;
  end loop;

  return jsonb_build_object(
    'cursor',   max_seq,
    'tables',   out_tables,
    'count',    total,
    -- complete = the client can stop looping. False means call again with the
    -- new cursor; the loop is what makes a large first sync resumable.
    'complete', total < batch
  );
end;
$$;

grant execute on function pull_changes(bigint, int) to authenticated;

-- Bump every existing row once so a fresh client pulls the seed data.
do $$
declare t text;
begin
  foreach t in array array['instruments','setups'] loop
    execute format('update %I set sync_seq = nextval(''global_sync_seq'')', t);
  end loop;
end
$$;

-- ═══ 0008_push_mutations.sql ═══

-- 0008_push_mutations.sql
--
-- The write path.
--
-- The client never issues a bare INSERT or UPDATE. It submits mutations, each
-- carrying an id it generated before any network call. That single fact is what
-- makes retrying safe on a bad connection: a mutation applied twice is applied
-- once, because the second attempt finds its own id already in the log and
-- reports 'duplicate' instead of writing again.
--
-- Conflict policy, by field class:
--   append-only rows (legs, events, levels)  no conflict possible
--   scalar and numeric fields                last write wins, but LOGGED
--   narrative text                           NEVER overwritten — both kept
--
-- The last one is the rule that matters. Silently discarding a paragraph you
-- wrote about a trade would be a data loss dressed up as a merge. If two
-- devices both edited your review, you get both and you choose.

-- Narrative fields, by table. Anything listed here is never clobbered.
create or replace function narrative_fields(tbl text)
returns text[]
language sql
immutable
as $$
  select case tbl
    when 'trades' then array[
      'thesis','invalidation_thesis','pre_trade_plan','during_trade_notes',
      'post_trade_review','what_went_well','what_went_wrong','lesson_learned',
      'market_condition','correlated_note']
    when 'trade_events' then array['description','title']
    when 'trade_legs' then array['notes']
    when 'daily_preps' then array[
      'market_thesis','planned_setups','daily_plan','end_of_day_review',
      'lessons','general_bias_note','condition_note']
    when 'attachments' then array['caption','context_note']
    when 'observations' then array['note']
    when 'trade_mistakes' then array['note']
    else array[]::text[]
  end;
$$;

create or replace function push_mutations(mutations jsonb)
returns jsonb
language plpgsql
security definer set search_path = public
as $$
declare
  uid        uuid := auth.uid();
  m          jsonb;
  results    jsonb := '[]'::jsonb;
  tbl        text;
  eid        uuid;
  mid        uuid;
  op         text;
  payload    jsonb;
  base_rev   int;
  dev        uuid;
  existing   jsonb;
  cur_rev    int;
  conflicted text[];
  fld        text;
  narrative  text[];
  merged     jsonb;
  cols       text;
  vals       text;
begin
  if uid is null then
    raise exception 'not authenticated';
  end if;

  for m in select * from jsonb_array_elements(mutations)
  loop
    mid      := (m->>'id')::uuid;
    tbl      := m->>'entity_type';
    eid      := (m->>'entity_id')::uuid;
    op       := m->>'op';
    payload  := coalesce(m->'payload', '{}'::jsonb);
    base_rev := nullif(m->>'base_rev','')::int;
    dev      := nullif(m->>'device_id','')::uuid;
    conflicted := array[]::text[];

    -- Only tables we actually sync. An unknown name is a bug or an attack;
    -- either way it does not get to name a table in dynamic SQL.
    if tbl not in ('instruments','setups','tags','taggings','trades',
                   'trade_mistakes','trade_legs','trade_levels','trade_events',
                   'attachments','daily_preps','prep_instrument_bias','prep_levels',
                   'economic_events','observations','trade_prep_links','missed_trades') then
      results := results || jsonb_build_object('id', mid, 'status', 'rejected',
                                              'reason', format('unknown table %s', tbl));
      continue;
    end if;

    -- Idempotency. This is the whole reason retrying on flaky signal is safe.
    if exists (select 1 from mutation_log where id = mid) then
      results := results || jsonb_build_object('id', mid, 'status', 'duplicate');
      continue;
    end if;

    execute format('select to_jsonb(x) from %I x where x.id = $1 and x.user_id = $2', tbl)
      into existing using eid, uid;

    if op = 'insert' and existing is null then
      payload := payload || jsonb_build_object('id', eid, 'user_id', uid);
      if dev is not null then payload := payload || jsonb_build_object('origin_device', dev); end if;

      select string_agg(quote_ident(k), ','), string_agg(format('$1->>%L', k), ',')
        into cols, vals
        from jsonb_object_keys(payload) k
       where k not in ('created_at','updated_at','rev','sync_seq');

      -- jsonb_populate_record does the type coercion, so numeric and timestamp
      -- columns land correctly without the client having to know the schema.
      execute format(
        'insert into %I select * from jsonb_populate_record(null::%I, $1) on conflict (id) do nothing',
        tbl, tbl) using payload;

    elsif op = 'delete' then
      execute format('update %I set deleted_at = now() where id = $1 and user_id = $2', tbl)
        using eid, uid;

    elsif op = 'restore' then
      execute format('update %I set deleted_at = null where id = $1 and user_id = $2', tbl)
        using eid, uid;

    elsif existing is not null then
      cur_rev := coalesce((existing->>'rev')::int, 1);
      narrative := narrative_fields(tbl);
      merged := '{}'::jsonb;

      -- Someone else moved this row since we last saw it.
      if base_rev is not null and base_rev < cur_rev then
        for fld in select * from jsonb_object_keys(payload)
        loop
          if existing->fld is distinct from payload->fld then
            if fld = any(narrative) and existing->>fld is not null
               and existing->>fld <> '' then
              -- Both sides wrote prose. Keep the server's, record ours, and
              -- surface it. Nothing is discarded on our say-so.
              conflicted := conflicted || fld;
              insert into conflicts (user_id, entity_type, entity_id, field_name,
                                     local_value, remote_value, local_device, detected_at)
              values (uid, tbl, eid, fld, payload->fld, existing->fld, dev, now());
            else
              merged := merged || jsonb_build_object(fld, payload->fld);
            end if;
          end if;
        end loop;
      else
        merged := payload;
      end if;

      merged := merged - 'id' - 'user_id' - 'created_at' - 'rev' - 'sync_seq';

      if merged <> '{}'::jsonb then
        execute format(
          'update %I set (%s) = (select %s from jsonb_populate_record(null::%I, $1)),
                         rev = rev + 1, updated_at = now()
             where id = $2 and user_id = $3',
          tbl,
          (select string_agg(quote_ident(k), ',') from jsonb_object_keys(merged) k),
          (select string_agg(quote_ident(k), ',') from jsonb_object_keys(merged) k),
          tbl)
          using merged, eid, uid;
      end if;
    else
      -- An update for a row that isn't here: treat it as an insert rather than
      -- dropping the change. Offline devices legitimately produce this order.
      payload := payload || jsonb_build_object('id', eid, 'user_id', uid);
      execute format(
        'insert into %I select * from jsonb_populate_record(null::%I, $1) on conflict (id) do nothing',
        tbl, tbl) using payload;
    end if;

    insert into mutation_log (id, user_id, device_id, op, entity_type, entity_id,
                              payload, client_time, applied)
    values (mid, uid, dev, op::mutation_op, tbl, eid, payload,
            nullif(m->>'client_time','')::timestamptz, true);

    if array_length(conflicted, 1) > 0 then
      results := results || jsonb_build_object('id', mid, 'status', 'conflict',
                                              'conflicted', to_jsonb(conflicted));
    else
      results := results || jsonb_build_object('id', mid, 'status', 'applied');
    end if;
  end loop;

  return results;
end;
$$;

grant execute on function push_mutations(jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- resolve_conflict
--
-- 'local' takes the value from the device that lost the race. 'remote' keeps
-- what is already stored. 'both_kept' concatenates them with a marker, which is
-- usually the right answer for prose: two paragraphs you wrote are two things
-- you thought, and stitching them together loses less than picking one.
-- ---------------------------------------------------------------------------

create or replace function resolve_conflict(conflict_id uuid, choice text)
returns jsonb
language plpgsql
security definer set search_path = public
as $$
declare
  uid uuid := auth.uid();
  c   conflicts%rowtype;
  new_value text;
begin
  select * into c from conflicts where id = conflict_id and user_id = uid;
  if not found then
    raise exception 'conflict not found';
  end if;

  if choice = 'local' then
    new_value := c.local_value #>> '{}';
  elsif choice = 'remote' then
    new_value := c.remote_value #>> '{}';
  elsif choice = 'both_kept' then
    new_value := (c.remote_value #>> '{}')
                 || E'\n\n--- also written on another device ---\n\n'
                 || (c.local_value #>> '{}');
  else
    raise exception 'unknown choice %', choice;
  end if;

  if choice <> 'remote' then
    execute format('update %I set %I = $1, rev = rev + 1, updated_at = now()
                     where id = $2 and user_id = $3',
                   c.entity_type, c.field_name)
      using new_value, c.entity_id, uid;
  end if;

  update conflicts
     set resolved_at = now(), resolution = choice::conflict_choice
   where id = conflict_id;

  return jsonb_build_object('ok', true, 'resolution', choice);
end;
$$;

grant execute on function resolve_conflict(uuid, text) to authenticated;

-- ═══ 0009_fix_insert_defaults.sql ═══

-- 0009_fix_insert_defaults.sql
--
-- Fixes: "null value in column created_at violates not-null constraint"
--
-- The bug, and it is a good lesson:
--
--   insert into trades select * from jsonb_populate_record(null::trades, payload)
--
-- jsonb_populate_record returns a FULL row. Every column the payload does not
-- mention comes back as NULL, and `select *` then hands all of them to the
-- insert explicitly. A column default only applies when the column is OMITTED
-- from the insert — passing NULL explicitly overrides it. So created_at,
-- updated_at and rev all arrived as NULL and the not-null constraint fired.
--
-- Every insert was rejected, which is why uploading, downloading and delete
-- all failed at once: nothing ever reached the server for them to act on.
--
-- The fix is to name only the columns the payload actually contains, so
-- everything else falls through to its default.

create or replace function push_mutations(mutations jsonb)
returns jsonb
language plpgsql
security definer set search_path = public
as $$
declare
  uid        uuid := auth.uid();
  m          jsonb;
  results    jsonb := '[]'::jsonb;
  tbl        text;
  eid        uuid;
  mid        uuid;
  op         text;
  payload    jsonb;
  base_rev   int;
  dev        uuid;
  existing   jsonb;
  cur_rev    int;
  conflicted text[];
  fld        text;
  narrative  text[];
  merged     jsonb;
  cols       text;
begin
  if uid is null then
    raise exception 'not authenticated';
  end if;

  for m in select * from jsonb_array_elements(mutations)
  loop
    mid      := (m->>'id')::uuid;
    tbl      := m->>'entity_type';
    eid      := (m->>'entity_id')::uuid;
    op       := m->>'op';
    payload  := coalesce(m->'payload', '{}'::jsonb);
    base_rev := nullif(m->>'base_rev','')::int;
    dev      := nullif(m->>'device_id','')::uuid;
    conflicted := array[]::text[];

    if tbl not in ('instruments','setups','tags','taggings','trades',
                   'trade_mistakes','trade_legs','trade_levels','trade_events',
                   'attachments','daily_preps','prep_instrument_bias','prep_levels',
                   'economic_events','observations','trade_prep_links','missed_trades') then
      results := results || jsonb_build_object('id', mid, 'status', 'rejected',
                                              'reason', format('unknown table %s', tbl));
      continue;
    end if;

    if exists (select 1 from mutation_log where id = mid) then
      results := results || jsonb_build_object('id', mid, 'status', 'duplicate');
      continue;
    end if;

    execute format('select to_jsonb(x) from %I x where x.id = $1 and x.user_id = $2', tbl)
      into existing using eid, uid;

    if (op = 'insert' and existing is null) or (op = 'update' and existing is null) then
      -- An update for a row we don't have is treated as an insert: offline
      -- devices legitimately produce that order, and dropping it would lose data.
      payload := payload || jsonb_build_object('id', eid, 'user_id', uid);
      if dev is not null then
        payload := payload || jsonb_build_object('origin_device', dev);
      end if;

      -- Name only the columns actually present, and only ones that really
      -- exist on this table. Everything omitted falls through to its default —
      -- which is the entire point of this migration.
      select string_agg(quote_ident(k), ',')
        into cols
        from jsonb_object_keys(payload) k
       where k not in ('created_at','updated_at','rev','sync_seq')
         and exists (
           select 1 from information_schema.columns c
            where c.table_schema = 'public'
              and c.table_name = tbl
              and c.column_name = k);

      if cols is not null then
        execute format(
          'insert into %I (%s) select %s from jsonb_populate_record(null::%I, $1)
             on conflict (id) do nothing', tbl, cols, cols, tbl)
          using payload;
      end if;

    elsif op = 'delete' then
      execute format('update %I set deleted_at = now() where id = $1 and user_id = $2', tbl)
        using eid, uid;

    elsif op = 'restore' then
      execute format('update %I set deleted_at = null where id = $1 and user_id = $2', tbl)
        using eid, uid;

    elsif existing is not null then
      cur_rev := coalesce((existing->>'rev')::int, 1);
      narrative := narrative_fields(tbl);
      merged := '{}'::jsonb;

      if base_rev is not null and base_rev < cur_rev then
        for fld in select * from jsonb_object_keys(payload)
        loop
          if existing->fld is distinct from payload->fld then
            if fld = any(narrative) and existing->>fld is not null
               and existing->>fld <> '' then
              conflicted := conflicted || fld;
              insert into conflicts (user_id, entity_type, entity_id, field_name,
                                     local_value, remote_value, local_device, detected_at)
              values (uid, tbl, eid, fld, payload->fld, existing->fld, dev, now());
            else
              merged := merged || jsonb_build_object(fld, payload->fld);
            end if;
          end if;
        end loop;
      else
        merged := payload;
      end if;

      merged := merged - 'id' - 'user_id' - 'created_at' - 'rev' - 'sync_seq' - 'updated_at';

      -- Drop anything that isn't a real column here too, so a client sending a
      -- stray key can't take the whole batch down.
      select jsonb_object_agg(k, merged->k)
        into merged
        from jsonb_object_keys(merged) k
       where exists (
         select 1 from information_schema.columns c
          where c.table_schema = 'public'
            and c.table_name = tbl
            and c.column_name = k);

      if merged is not null and merged <> '{}'::jsonb then
        execute format(
          'update %I set (%s) = (select %s from jsonb_populate_record(null::%I, $1)),
                         rev = rev + 1, updated_at = now()
             where id = $2 and user_id = $3',
          tbl,
          (select string_agg(quote_ident(k), ',') from jsonb_object_keys(merged) k),
          (select string_agg(quote_ident(k), ',') from jsonb_object_keys(merged) k),
          tbl)
          using merged, eid, uid;
      end if;
    end if;

    insert into mutation_log (id, user_id, device_id, op, entity_type, entity_id,
                              payload, client_time, applied)
    values (mid, uid, dev, op::mutation_op, tbl, eid, payload,
            nullif(m->>'client_time','')::timestamptz, true);

    if array_length(conflicted, 1) > 0 then
      results := results || jsonb_build_object('id', mid, 'status', 'conflict',
                                              'conflicted', to_jsonb(conflicted));
    else
      results := results || jsonb_build_object('id', mid, 'status', 'applied');
    end if;
  end loop;

  return results;
end;
$$;

grant execute on function push_mutations(jsonb) to authenticated;

-- ═══ 0010_sequence_grant.sql ═══

-- 0010_sequence_grant.sql
--
-- Fixes: "permission denied for sequence global_sync_seq"
--
-- The bump_sync_seq trigger calls nextval() on every update, and a trigger runs
-- as whoever fired it — you, the authenticated user. Inserts worked because
-- they go through push_mutations, which is security definer and therefore runs
-- as the owner. A direct update does not, so it hit the sequence unprivileged
-- and was refused. That is why uploading passed while downloading failed.
--
-- The sequence is a counter and nothing else: no data lives in it, and knowing
-- its value tells you nothing about anyone's trades.

grant usage, select on sequence global_sync_seq to authenticated;

-- Same reasoning for the other sequences the client touches directly.
do $$
declare s text;
begin
  for s in
    select sequencename from pg_sequences
     where schemaname = 'public'
       and sequencename in ('mutation_log_seq_seq', 'audit_log_id_seq')
  loop
    execute format('grant usage, select on sequence %I to authenticated', s);
  end loop;
end
$$;
