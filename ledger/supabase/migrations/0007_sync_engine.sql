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
