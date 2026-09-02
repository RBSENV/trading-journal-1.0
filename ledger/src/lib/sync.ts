import { supabase } from './supabase'
import { deviceId } from './device'
import {
  db, getMeta, setMeta, putRow, getRow, pendingCount,
  type Mutation, type SyncOp,
} from './db'

/* ---------------------------------------------------------------------------
   The sync engine.

   Write path, in this order, always:
     1. Apply to the local cache
     2. Append to the outbox
     3. Tell the UI it is saved
     4. Only then attempt the network

   Steps 1-3 do not depend on connectivity, which is why the app is fully
   usable in an elevator. Step 4 is allowed to fail as often as it likes.

   The status this module reports is a promise: "Synced" is never shown while
   anything is queued. A status indicator that lies is worse than none, because
   you would stop checking it.
--------------------------------------------------------------------------- */

export type SyncState = 'synced' | 'syncing' | 'offline' | 'error' | 'attention' | 'local'

export interface SyncStatus {
  state: SyncState
  pending: number
  conflicts: number
  lastSyncAt: string | null
  lastError: string | null
}

type Listener = (s: SyncStatus) => void

let status: SyncStatus = {
  state: navigator.onLine ? 'synced' : 'offline',
  pending: 0, conflicts: 0, lastSyncAt: null, lastError: null,
}

const listeners = new Set<Listener>()
let flushing = false
let backoff = 0
let timer: ReturnType<typeof setTimeout> | null = null

export function subscribe(fn: Listener): () => void {
  listeners.add(fn)
  fn(status)
  return () => listeners.delete(fn)
}

function emit(patch: Partial<SyncStatus>) {
  status = { ...status, ...patch }
  listeners.forEach(fn => fn(status))
}

async function refreshCounts() {
  const pending = await pendingCount()
  const conflicts = await getMeta<number>('conflict_count', 0)
  // The precedence here is the contract. Anything needing a human beats
  // anything that will resolve itself.
  let state: SyncState = status.state
  if (conflicts > 0) state = 'attention'
  else if (!navigator.onLine) state = 'offline'
  else if (flushing) state = 'syncing'
  else if (pending > 0) state = status.lastError ? 'error' : 'local'
  else state = 'synced'
  emit({ pending, conflicts, state })
}

/* --- writing ------------------------------------------------------------- */

let seqCounter = 0

async function nextClientSeq(): Promise<number> {
  if (seqCounter === 0) seqCounter = await getMeta<number>('client_seq', 0)
  seqCounter += 1
  await setMeta('client_seq', seqCounter)
  return seqCounter
}

/**
 * Record a change. Returns as soon as it is durable on this device — it does
 * NOT wait for the server, and callers must not treat it as if it did.
 */
export async function mutate(
  entity_type: string,
  entity_id: string,
  op: SyncOp,
  payload: Record<string, unknown> = {},
): Promise<void> {
  const now = new Date().toISOString()
  const existing = await getRow(entity_type, entity_id)

  // 1. local cache
  let next: Record<string, unknown>
  if (op === 'insert') {
    next = { id: entity_id, ...payload, created_at: now, updated_at: now, rev: 1, deleted_at: null }
  } else if (op === 'delete') {
    next = { ...(existing ?? { id: entity_id }), deleted_at: now, updated_at: now }
  } else if (op === 'restore') {
    next = { ...(existing ?? { id: entity_id }), deleted_at: null, updated_at: now }
  } else {
    next = { ...(existing ?? { id: entity_id }), ...payload, updated_at: now }
  }
  await putRow(entity_type, next, true)

  // 2. outbox
  const mutation: Mutation = {
    id: crypto.randomUUID(),
    client_seq: await nextClientSeq(),
    entity_type,
    entity_id,
    op,
    payload,
    base_rev: (existing?.rev as number) ?? null,
    client_time: now,
    attempts: 0,
    last_error: null,
    state: 'queued',
  }
  await db.outbox.put(mutation)

  // 3. tell the UI
  await refreshCounts()

  // 4. network, best effort
  void flush()
}

/* --- pushing ------------------------------------------------------------- */

const MAX_ATTEMPTS = 8
const BATCH = 50

export async function flush(): Promise<void> {
  if (flushing || !navigator.onLine) return
  const { data: session } = await supabase.auth.getSession()
  if (!session.session) return

  const queued = await db.outbox
    .where('state').anyOf('queued', 'failed')
    .sortBy('client_seq')
  if (queued.length === 0) { await refreshCounts(); return }

  flushing = true
  emit({ state: 'syncing' })

  try {
    const batch = queued.slice(0, BATCH)
    await db.outbox.bulkPut(batch.map(m => ({ ...m, state: 'sending' as const })))

    const { data, error } = await supabase.rpc('push_mutations', {
      mutations: batch.map(m => ({
        id: m.id,
        entity_type: m.entity_type,
        entity_id: m.entity_id,
        op: m.op,
        payload: m.payload,
        base_rev: m.base_rev,
        client_seq: m.client_seq,
        client_time: m.client_time,
        device_id: deviceId(),
      })),
    })

    if (error) throw new Error(error.message)

    const results = (data ?? []) as Array<{
      id: string; status: string; reason?: string; conflicted?: string[]
    }>
    const byId = new Map(results.map(r => [r.id, r]))
    let sawConflict = false

    for (const m of batch) {
      const r = byId.get(m.id)
      if (!r) {
        // No verdict came back. Requeue rather than assume; the mutation id
        // makes a second attempt harmless.
        await db.outbox.put({ ...m, state: 'queued', attempts: m.attempts + 1 })
        continue
      }
      if (r.status === 'applied' || r.status === 'duplicate' || r.status === 'conflict') {
        await db.outbox.delete(m.id)
        if (r.status === 'conflict') sawConflict = true
      } else {
        const attempts = m.attempts + 1
        await db.outbox.put({
          ...m,
          state: attempts >= MAX_ATTEMPTS ? 'failed' : 'queued',
          attempts,
          last_error: r.reason ?? r.status,
        })
      }
    }

    backoff = 0
    emit({ lastError: null })
    flushing = false

    await pull()
    if (sawConflict) await countConflicts()
    await refreshCounts()

    // More waiting? Keep going.
    if ((await pendingCount()) > 0) void flush()
  } catch (e) {
    flushing = false
    const msg = e instanceof Error ? e.message : String(e)
    // Un-stick anything left mid-send so it retries rather than stalling.
    const stuck = await db.outbox.where('state').equals('sending').toArray()
    await db.outbox.bulkPut(stuck.map(m => ({
      ...m, state: 'queued' as const, attempts: m.attempts + 1, last_error: msg,
    })))
    emit({ lastError: msg })
    await refreshCounts()
    scheduleRetry()
  }
}

function scheduleRetry() {
  if (timer) clearTimeout(timer)
  backoff = Math.min(backoff === 0 ? 1000 : backoff * 2, 60_000)
  // Jitter, so a flaky connection doesn't produce a synchronised retry storm.
  const wait = backoff + Math.random() * 500
  timer = setTimeout(() => { void flush() }, wait)
}

/* --- pulling ------------------------------------------------------------- */

export async function pull(): Promise<void> {
  if (!navigator.onLine) return
  let cursor = await getMeta<number>('cursor', 0)
  let guard = 0

  while (guard++ < 40) {
    const { data, error } = await supabase.rpc('pull_changes', { since: cursor, batch: 500 })
    if (error) throw new Error(error.message)

    const res = data as {
      cursor: number
      tables: Record<string, Record<string, unknown>[]>
      complete: boolean
    }

    for (const [entity_type, rows] of Object.entries(res.tables ?? {})) {
      for (const row of rows) {
        // A row we still have queued locally stays marked pending — the server
        // copy is authoritative for everyone else, but our unsent edit is not
        // lost just because a pull arrived first.
        const stillQueued = await db.outbox
          .where('entity_id').equals(row.id as string).count()
        await putRow(entity_type, row, stillQueued > 0)
      }
    }

    cursor = res.cursor
    await setMeta('cursor', cursor)
    if (res.complete || Object.keys(res.tables ?? {}).length === 0) break
  }

  await setMeta('last_sync_at', new Date().toISOString())
  emit({ lastSyncAt: new Date().toISOString() })
}

async function countConflicts() {
  const { count } = await supabase
    .from('conflicts')
    .select('id', { count: 'exact', head: true })
    .is('resolved_at', null)
  await setMeta('conflict_count', count ?? 0)
}

export async function resolveConflict(id: string, choice: 'local' | 'remote' | 'both_kept') {
  await supabase.rpc('resolve_conflict', { conflict_id: id, choice })
  await countConflicts()
  await pull()
  await refreshCounts()
}

/* --- lifecycle ----------------------------------------------------------- */

let started = false

export async function startSync() {
  if (started) return
  started = true

  const last = await getMeta<string | null>('last_sync_at', null)
  emit({ lastSyncAt: last })

  window.addEventListener('online', () => { backoff = 0; void flush() })
  window.addEventListener('offline', () => { void refreshCounts() })

  // Coming back to the app is the most likely moment for the local view to be
  // stale, so always reconcile on focus.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void flush()
  })

  // A flush attempt right before the tab dies gives queued work its best
  // chance; anything that misses it is still durable in the outbox.
  window.addEventListener('pagehide', () => { void flush() })

  await countConflicts()
  await refreshCounts()

  try {
    await pull()
    await flush()
  } catch (e) {
    emit({ lastError: e instanceof Error ? e.message : String(e) })
  }
  await refreshCounts()

  setInterval(() => { void flush() }, 60_000)
}

export function getStatus(): SyncStatus { return status }

/** Full local rebuild from the server. Never touches the outbox. */
export async function resetLocal() {
  await db.cache.clear()
  await setMeta('cursor', 0)
  await pull()
  await refreshCounts()
}
