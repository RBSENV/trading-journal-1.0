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
