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
