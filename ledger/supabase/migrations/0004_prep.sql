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
