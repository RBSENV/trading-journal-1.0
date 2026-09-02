-- 0010_sequence_grant.sql
--
-- Fixes: "permission denied for sequence global_sync_seq"
--
-- The bump_sync_seq trigger calls nextval() on every update, and a trigger runs
-- as whoever fired it — you, the authenticated user. Inserts worked because
-- they go through push_mutations, which is security definer and therefore runs
-- as the owner. A direct update does not, so it hit the sequence unprivileged
-- and was refused. That is why uploading passed while downloading failed.
--
-- The sequence is a counter and nothing else: no data lives in it, and knowing
-- its value tells you nothing about anyone's trades.

grant usage, select on sequence global_sync_seq to authenticated;

-- Same reasoning for the other sequences the client touches directly.
do $$
declare s text;
begin
  for s in
    select sequencename from pg_sequences
     where schemaname = 'public'
       and sequencename in ('mutation_log_seq_seq', 'audit_log_id_seq')
  loop
    execute format('grant usage, select on sequence %I to authenticated', s);
  end loop;
end
$$;
