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
