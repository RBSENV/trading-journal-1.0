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
