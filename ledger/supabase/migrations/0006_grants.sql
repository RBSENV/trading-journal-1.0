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
