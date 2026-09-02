import { db } from './db'
import { mutate } from './sync'
import { supabase } from './supabase'
import { listRows } from './db'
import { NY } from './trades'

/* ---------------------------------------------------------------------------
   Media pipeline.

   Order matters, and it is durability first, network last:

     1. Blob into IndexedDB
     2. Attachment row created, marked pending
     3. UI shows the image immediately, marked "Saved locally"
     4. Background upload, with retry
     5. Only on a confirmed hash match does the local blob become evictable

   Step 5 is the rule that keeps this honest: an unuploaded blob is NEVER
   evicted from the local cache, no matter how full it gets. If we are short on
   space we stop accepting new media rather than quietly dropping a screenshot
   that exists nowhere else.

   Two iOS specifics worth knowing about, because both are silent failures:

   HEIC — never list image/heic in the `accept` attribute. Safari 17+ has a bug
   where doing so makes it convert your OTHER formats INTO heic. Asking only for
   jpeg/png/webp causes iOS to hand over a JPEG from the Photos library, which
   is what we want.

   EXIF — iOS routinely strips EXIF during that conversion, so the original
   capture time is often simply gone. That is exactly why every timestamp in
   this app is manually editable: we treat EXIF as a hint and never as truth.
--------------------------------------------------------------------------- */

export const ACCEPT = 'image/jpeg,image/png,image/webp'
export const MAX_BYTES = 30 * 1024 * 1024
const SOFT_CAP_BYTES = 500 * 1024 * 1024

export type Stage =
  | 'before_entry' | 'entry' | 'during_trade' | 'partial_exit'
  | 'final_exit' | 'after_trade' | 'daily_prep' | 'custom'

export type Timeframe = '1m' | '5m' | '15m' | '30m' | '1h' | '4h' | 'daily' | 'weekly' | 'custom'

export const STAGES: { v: Stage; label: string }[] = [
  { v: 'before_entry', label: 'Before entry' },
  { v: 'entry', label: 'Entry' },
  { v: 'during_trade', label: 'During' },
  { v: 'partial_exit', label: 'Partial' },
  { v: 'final_exit', label: 'Final exit' },
  { v: 'after_trade', label: 'After' },
  { v: 'daily_prep', label: 'Prep' },
]

export const TIMEFRAMES: Timeframe[] = ['1m', '5m', '15m', '30m', '1h', '4h', 'daily', 'weekly']

export interface Attachment {
  id: string
  kind: 'image' | 'chart_link' | 'file'
  trade_id?: string | null
  trade_event_id?: string | null
  daily_prep_id?: string | null
  stage?: Stage | null
  timeframe?: Timeframe | null
  captured_at: string
  tz_label: string
  caption?: string | null
  context_note?: string | null
  url?: string | null
  storage_key?: string | null
  mime_type?: string | null
  byte_size?: number | null
  width?: number | null
  height?: number | null
  sha256?: string | null
  original_filename?: string | null
  upload_status: 'pending' | 'uploading' | 'uploaded' | 'failed' | 'orphaned'
  upload_attempts: number
  last_upload_error?: string | null
  deleted_at?: string | null
}

const WORKER = import.meta.env.VITE_MEDIA_WORKER_URL

function keyFor(userId: string, id: string, mime: string): string {
  const now = new Date()
  const ext = mime === 'image/png' ? 'png' : mime === 'image/webp' ? 'webp' : 'jpg'
  return `${userId}/${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, '0')}/${id}.${ext}`
}

async function dimensions(blob: Blob): Promise<{ width: number; height: number } | null> {
  try {
    const bmp = await createImageBitmap(blob)
    const d = { width: bmp.width, height: bmp.height }
    bmp.close()
    return d
  } catch {
    return null
  }
}

async function sha256(buf: ArrayBuffer): Promise<string> {
  const h = await crypto.subtle.digest('SHA-256', buf)
  return [...new Uint8Array(h)].map(b => b.toString(16).padStart(2, '0')).join('')
}

/** Bytes held locally that have not been confirmed uploaded. Never evicted. */
export async function unuploadedBytes(): Promise<number> {
  const rows = await db.blobs.where('uploaded').equals(0).toArray()
  return rows.reduce((s, r) => s + r.bytes, 0)
}

export async function cacheBytes(): Promise<number> {
  const rows = await db.blobs.toArray()
  return rows.reduce((s, r) => s + r.bytes, 0)
}

/**
 * Attach a file. Returns as soon as it is durable locally — never waits on the
 * network, because you might be attaching a chart from a lift.
 */
export async function attach(file: File, link: {
  trade_id?: string
  trade_event_id?: string
  daily_prep_id?: string
  stage?: Stage
  timeframe?: Timeframe
  caption?: string
  context_note?: string
  captured_at?: string
}): Promise<string> {
  if (file.size > MAX_BYTES) {
    throw new Error(`That file is ${(file.size / 1024 / 1024).toFixed(1)} MB. The limit is ${MAX_BYTES / 1024 / 1024} MB.`)
  }

  const used = await cacheBytes()
  const pending = await unuploadedBytes()
  if (used + file.size > SOFT_CAP_BYTES && pending > SOFT_CAP_BYTES / 2) {
    throw new Error('Local storage is full and there is unsent media waiting. Get online to clear the queue before adding more.')
  }

  const id = crypto.randomUUID()
  const buf = await file.arrayBuffer()
  const hash = await sha256(buf)
  const dims = await dimensions(file)

  // 1. Durable locally, before anything else can fail.
  await db.blobs.put({
    attachment_id: id,
    blob: file,
    mime: file.type || 'image/jpeg',
    bytes: file.size,
    created_at: new Date().toISOString(),
    uploaded: false,
  })

  // 2. The record. captured_at defaults to now and is always editable — EXIF
  //    is frequently stripped by iOS, so it is a hint at best.
  await mutate('attachments', id, 'insert', {
    kind: 'image',
    trade_id: link.trade_id ?? null,
    trade_event_id: link.trade_event_id ?? null,
    daily_prep_id: link.daily_prep_id ?? null,
    stage: link.stage ?? null,
    timeframe: link.timeframe ?? null,
    captured_at: link.captured_at ?? new Date().toISOString(),
    tz_label: NY,
    caption: link.caption ?? null,
    context_note: link.context_note ?? null,
    mime_type: file.type || 'image/jpeg',
    byte_size: file.size,
    width: dims?.width ?? null,
    height: dims?.height ?? null,
    sha256: hash,
    original_filename: file.name || null,
    upload_status: 'pending',
    upload_attempts: 0,
  })

  // 3. Try now; failure is fine, the queue will get it later.
  void flushUploads()
  return id
}

/** Save a TradingView or any other chart URL. No file, same metadata. */
export async function attachLink(url: string, link: {
  trade_id?: string
  daily_prep_id?: string
  stage?: Stage
  timeframe?: Timeframe
  caption?: string
  context_note?: string
}): Promise<string> {
  const id = crypto.randomUUID()
  await mutate('attachments', id, 'insert', {
    kind: 'chart_link',
    url,
    trade_id: link.trade_id ?? null,
    daily_prep_id: link.daily_prep_id ?? null,
    stage: link.stage ?? null,
    timeframe: link.timeframe ?? null,
    captured_at: new Date().toISOString(),
    tz_label: NY,
    caption: link.caption ?? null,
    context_note: link.context_note ?? null,
    upload_status: 'uploaded',   // nothing to upload
    upload_attempts: 0,
  })
  return id
}

let flushing = false

/** Drain the upload queue. Safe to call often; it will not overlap itself. */
export async function flushUploads(): Promise<void> {
  if (flushing || !navigator.onLine || !WORKER) return
  flushing = true
  try {
    const { data: { session } } = await supabase.auth.getSession()
    const token = session?.access_token
    if (!token) return

    const userId = session.user.id
    const queued = await db.blobs.where('uploaded').equals(0).toArray()

    for (const b of queued) {
      const row = (await listRows<Attachment>('attachments', r => r.id === b.attachment_id))[0]
      if (!row) { await db.blobs.delete(b.attachment_id); continue }
      if (row.upload_status === 'uploaded') { await markUploaded(b.attachment_id); continue }

      const key = row.storage_key ?? keyFor(userId, row.id, b.mime)

      try {
        await mutate('attachments', row.id, 'update', {
          upload_status: 'uploading',
          upload_attempts: (row.upload_attempts ?? 0) + 1,
        })

        const res = await fetch(`${WORKER}/object/${encodeURIComponent(key)}`, {
          method: 'PUT',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': b.mime,
            'X-Attachment-Id': row.id,
          },
          body: b.blob,
        })

        if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`)
        const out = await res.json() as { sha256: string; bytes: number }

        // Confirm what landed matches what we sent. A 200 alone only proves the
        // request completed, not that the bytes survived it.
        if (row.sha256 && out.sha256 !== row.sha256) {
          throw new Error('Uploaded file does not match what was sent. Will retry.')
        }

        await mutate('attachments', row.id, 'update', {
          storage_key: key,
          upload_status: 'uploaded',
          last_upload_error: null,
        })
        await markUploaded(row.id)
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        const attempts = (row.upload_attempts ?? 0) + 1
        await mutate('attachments', row.id, 'update', {
          // After several tries this becomes your problem to look at, not the
          // queue's to keep silently retrying. The blob stays either way.
          upload_status: attempts >= 5 ? 'failed' : 'pending',
          last_upload_error: msg,
        })
      }
    }
  } finally {
    flushing = false
  }
}

async function markUploaded(id: string) {
  const b = await db.blobs.get(id)
  if (b) await db.blobs.put({ ...b, uploaded: true })
}

/**
 * A displayable URL for an attachment.
 * Local blob first — instant, works offline, and correct even before upload.
 */
export async function displayUrl(a: Attachment): Promise<string | null> {
  if (a.kind === 'chart_link') return a.url ?? null

  const local = await db.blobs.get(a.id)
  if (local) return URL.createObjectURL(local.blob)

  if (!a.storage_key || !WORKER) return null
  const { data: { session } } = await supabase.auth.getSession()
  if (!session) return null

  try {
    const res = await fetch(`${WORKER}/object/${encodeURIComponent(a.storage_key)}`, {
      headers: { Authorization: `Bearer ${session.access_token}` },
    })
    if (!res.ok) return null
    const blob = await res.blob()
    // Cache it back so scrolling the same trade twice does not re-download.
    await db.blobs.put({
      attachment_id: a.id, blob, mime: blob.type,
      bytes: blob.size, created_at: new Date().toISOString(), uploaded: true,
    })
    return URL.createObjectURL(blob)
  } catch {
    return null
  }
}

export const attachmentsFor = (where: (r: Record<string, unknown>) => boolean) =>
  listRows<Attachment>('attachments', where)
    .then(rows => rows.sort((a, b) => a.captured_at.localeCompare(b.captured_at)))

export async function removeAttachment(id: string) {
  await mutate('attachments', id, 'delete', {})
}

/** Evict uploaded blobs only, oldest first. Pending media is untouchable. */
export async function trimCache(targetBytes = SOFT_CAP_BYTES * 0.8): Promise<number> {
  let total = await cacheBytes()
  if (total <= targetBytes) return 0

  const evictable = (await db.blobs.where('uploaded').equals(1).toArray())
    .sort((a, b) => a.created_at.localeCompare(b.created_at))

  let freed = 0
  for (const b of evictable) {
    if (total <= targetBytes) break
    await db.blobs.delete(b.attachment_id)
    total -= b.bytes
    freed += b.bytes
  }
  return freed
}

if (typeof window !== 'undefined') {
  window.addEventListener('online', () => void flushUploads())
}
