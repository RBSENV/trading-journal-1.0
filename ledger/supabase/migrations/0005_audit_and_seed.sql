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
