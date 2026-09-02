-- Ledger — sync fix.
-- Run this in the Supabase SQL Editor. Replaces one function; nothing else
-- is touched, and no data is affected.
--
-- Fixes the four self-test failures: uploading, downloading, retrying,
-- and delete/restore. All four had the same cause.

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
