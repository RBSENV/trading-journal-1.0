-- Ledger — complete database setup.
-- Paste this whole file into the Supabase SQL Editor and hit Run. Once.
-- Creates 26 tables, locks them all to your account, grants the app
-- access, and switches on the change-history and trash systems.

-- ═══════════════════════════════════════════════════════
-- 0001_foundation.sql
-- ═══════════════════════════════════════════════════════

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

-- ═══════════════════════════════════════════════════════
-- 0002_infrastructure.sql
-- ═══════════════════════════════════════════════════════

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

-- ═══════════════════════════════════════════════════════
-- 0003_domain.sql
-- ═══════════════════════════════════════════════════════

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

-- ═══════════════════════════════════════════════════════
-- 0004_prep.sql
-- ═══════════════════════════════════════════════════════

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

-- ═══════════════════════════════════════════════════════
-- 0005_audit_and_seed.sql
-- ═══════════════════════════════════════════════════════

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

-- ═══════════════════════════════════════════════════════
-- 0006_grants.sql
-- ═══════════════════════════════════════════════════════

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
