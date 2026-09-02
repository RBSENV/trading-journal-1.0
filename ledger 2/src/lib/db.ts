import Dexie, { type Table } from 'dexie'

/* ---------------------------------------------------------------------------
   Local storage.

   This is a CACHE and a WRITE QUEUE. It is not the record.

   WebKit can clear script-writable storage for an origin with no interaction
   in the last seven days, and when it does, it clears all of it at once. So
   everything here is designed to be disposable: deleting this database must
   lose nothing that has already synced, and the app must start cleanly if it
   finds it empty.

   The one thing that is NOT disposable is the outbox. Unsynced mutations exist
   only here until the server acknowledges them, which is why the pending count
   is always on screen — an eviction can take work, but it can never take work
   silently.
--------------------------------------------------------------------------- */

export type SyncOp = 'insert' | 'update' | 'delete' | 'restore'

/** A row mirrored from the server, or created locally and not yet pushed. */
export interface CachedRow {
  key: string                 // `${entity_type}:${id}`
  entity_type: string
  id: string
  data: Record<string, unknown>
  updated_seq: number | null  // null = local-only, never round-tripped yet
  pending: boolean
}

/** One user action, durable before any network call is attempted. */
export interface Mutation {
  id: string                  // client-generated; the idempotency key
  client_seq: number          // per-device order
  entity_type: string
  entity_id: string
  op: SyncOp
  payload: Record<string, unknown>
  base_rev: number | null     // what we believed rev was; drives conflict detection
  client_time: string
  attempts: number
  last_error: string | null
  state: 'queued' | 'sending' | 'failed'
}

/** A media file held locally until its upload is confirmed. */
export interface PendingBlob {
  attachment_id: string
  blob: Blob
  mime: string
  bytes: number
  created_at: string
  uploaded: boolean           // once true, this is an evictable cache entry
}

export interface MetaRow {
  key: string
  value: unknown
}

class LedgerDB extends Dexie {
  cache!: Table<CachedRow, string>
  outbox!: Table<Mutation, string>
  blobs!: Table<PendingBlob, string>
  meta!: Table<MetaRow, string>

  constructor() {
    super('ledger')
    this.version(1).stores({
      cache:  'key, entity_type, updated_seq, pending',
      outbox: 'id, client_seq, state, entity_id',
      blobs:  'attachment_id, uploaded',
      meta:   'key',
    })
  }
}

export const db = new LedgerDB()

/* --- meta helpers -------------------------------------------------------- */

export async function getMeta<T>(key: string, fallback: T): Promise<T> {
  const row = await db.meta.get(key)
  return row ? (row.value as T) : fallback
}

export async function setMeta(key: string, value: unknown) {
  await db.meta.put({ key, value })
}

/* --- cache helpers ------------------------------------------------------- */

export const rowKey = (type: string, id: string) => `${type}:${id}`

export async function putRow(entity_type: string, data: Record<string, unknown>, pending = false) {
  const id = data.id as string
  await db.cache.put({
    key: rowKey(entity_type, id),
    entity_type,
    id,
    data,
    updated_seq: (data.updated_seq as number) ?? null,
    pending,
  })
}

export async function getRow<T = Record<string, unknown>>(
  entity_type: string, id: string,
): Promise<T | undefined> {
  const row = await db.cache.get(rowKey(entity_type, id))
  return row?.data as T | undefined
}

/**
 * Live rows of a type. Soft-deleted rows are filtered here rather than at each
 * call site, so "deleted" can never leak into a list by omission.
 */
export async function listRows<T = Record<string, unknown>>(
  entity_type: string,
  where?: (row: Record<string, unknown>) => boolean,
): Promise<T[]> {
  const rows = await db.cache.where('entity_type').equals(entity_type).toArray()
  return rows
    .map(r => r.data)
    .filter(d => !d.deleted_at)
    .filter(d => (where ? where(d) : true)) as T[]
}

/** Rows still waiting on the server. Drives the pending count. */
export async function pendingCount(): Promise<number> {
  return db.outbox.where('state').notEqual('sending').count()
}

/** Wipe the local cache but keep unsynced work. Used by "reset local data". */
export async function clearCacheKeepOutbox() {
  await db.cache.clear()
  await setMeta('cursor', 0)
}
