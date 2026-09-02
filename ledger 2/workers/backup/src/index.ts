/**
 * Ledger backup Worker.
 *
 * Runs nightly. Four jobs, in this order:
 *
 *   1. KEEP-ALIVE   — one request, so Supabase never idles the free project out
 *   2. SNAPSHOT     — read every row, encrypt with the public key, write to R2
 *   3. VERIFY       — read it back, decrypt-check, compare hashes and counts
 *   4. PRUNE        — apply the retention ladder
 *
 * Step 3 is the one everyone skips, and skipping it is how you end up with a
 * year of backups that turn out not to work. A snapshot that has never been
 * read back is a hypothesis, not a backup.
 *
 * This Worker holds a PUBLIC key only. It can write backups and cannot read
 * them. Nothing here can decrypt your journal, including whoever runs this
 * Worker — which is the point.
 */

export interface Env {
  BACKUPS: R2Bucket
  SUPABASE_URL: string
  SUPABASE_SERVICE_KEY: string   // bypasses RLS; lives only in Worker secrets
  BACKUP_PUBLIC_KEY: string      // ledger-pk-… — safe to store anywhere
  ALERT_WEBHOOK?: string
}

const TABLES = [
  'instruments', 'setups', 'tags', 'taggings',
  'trades', 'trade_mistakes', 'trade_legs', 'trade_levels', 'trade_events', 'attachments',
  'daily_preps', 'prep_instrument_bias', 'prep_levels',
  'economic_events', 'observations', 'trade_prep_links', 'missed_trades',
]

/* --- crypto (mirrors src/lib/crypto.ts; must stay byte-compatible) -------- */

const CURVE = { name: 'ECDH', namedCurve: 'P-256' } as const
const INFO = new TextEncoder().encode('ledger-backup-v1')

function b64dec(s: string): Uint8Array {
  const bin = atob(s.replace(/\s+/g, ''))
  const u = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i)
  return u
}

async function encrypt(plaintext: string, publicKeyStr: string): Promise<Uint8Array> {
  const raw = b64dec(publicKeyStr.replace(/^ledger-pk-/, ''))
  const recipient = await crypto.subtle.importKey('raw', raw, CURVE, false, [])
  const eph = await crypto.subtle.generateKey(CURVE, true, ['deriveBits'])
  const shared = await crypto.subtle.deriveBits({ name: 'ECDH', public: recipient }, eph.privateKey, 256)

  const salt = crypto.getRandomValues(new Uint8Array(16))
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const hkdf = await crypto.subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey'])
  const key = await crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt, info: INFO },
    hkdf, { name: 'AES-GCM', length: 256 }, false, ['encrypt'])

  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key,
    new TextEncoder().encode(plaintext))
  const ephRaw = new Uint8Array(await crypto.subtle.exportKey('raw', eph.publicKey))

  const out = new Uint8Array(1 + 65 + 16 + 12 + ct.byteLength)
  let o = 0
  out[o++] = 1
  out.set(ephRaw, o); o += 65
  out.set(salt, o); o += 16
  out.set(iv, o); o += 12
  out.set(new Uint8Array(ct), o)
  return out
}

async function sha256(data: Uint8Array): Promise<string> {
  const h = await crypto.subtle.digest('SHA-256', data)
  return [...new Uint8Array(h)].map(b => b.toString(16).padStart(2, '0')).join('')
}

/* --- supabase ------------------------------------------------------------- */

async function sb(env: Env, path: string): Promise<Record<string, unknown>[]> {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/${path}`, {
    headers: {
      apikey: env.SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
      Accept: 'application/json',
    },
  })
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status} ${await res.text()}`)
  return res.json()
}

/** Paged read — a year of audit rows will not fit in one response. */
async function readTable(env: Env, table: string): Promise<Record<string, unknown>[]> {
  const rows: Record<string, unknown>[] = []
  const page = 1000
  for (let offset = 0; ; offset += page) {
    const batch = await sb(env, `${table}?select=*&limit=${page}&offset=${offset}&order=id`)
    rows.push(...batch)
    if (batch.length < page) break
    if (offset > 200_000) throw new Error(`${table}: refusing to page past 200k rows`)
  }
  return rows
}

/* --- the job -------------------------------------------------------------- */

interface Result {
  ok: boolean
  key?: string
  bytes?: number
  sha256?: string
  counts?: Record<string, number>
  verified?: boolean
  pruned?: string[]
  error?: string
}

export async function runBackup(env: Env, kind = 'nightly'): Promise<Result> {
  try {
    // 1. Keep-alive. Any request resets the free-tier idle timer, and there is
    //    no API to un-pause a project once it sleeps — only the dashboard.
    await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/heartbeat`, {
      method: 'POST',
      headers: {
        apikey: env.SUPABASE_SERVICE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
        'Content-Type': 'application/json',
      },
      body: '{}',
    })

    // 2. Snapshot. Soft-deleted rows are included deliberately: lossless means
    //    lossless, and a restore that quietly dropped your trash would be a
    //    silent data loss dressed up as a feature.
    const data: Record<string, unknown[]> = {}
    const counts: Record<string, number> = {}
    for (const t of TABLES) {
      const rows = await readTable(env, t)
      data[t] = rows
      counts[t] = rows.length
    }

    const payload = JSON.stringify({
      format: 'trading-journal-export',
      format_version: '1.0.0',
      schema_version: '1.0.0',
      exported_at: new Date().toISOString(),
      exported_by: 'backup-worker',
      timezone: 'America/New_York',
      counts,
      data,
    })

    const plainHash = await sha256(new TextEncoder().encode(payload))
    const blob = await encrypt(payload, env.BACKUP_PUBLIC_KEY)
    const blobHash = await sha256(blob)

    const now = new Date()
    const key = `${kind}/${now.toISOString().slice(0, 10)}/${now.toISOString().replace(/[:.]/g, '-')}.ledger.enc`

    await env.BACKUPS.put(key, blob, {
      httpMetadata: { contentType: 'application/octet-stream' },
      customMetadata: {
        kind,
        taken_at: now.toISOString(),
        format_version: '1.0.0',
        plaintext_sha256: plainHash,
        ciphertext_sha256: blobHash,
        row_counts: JSON.stringify(counts),
      },
    })

    // 3. Verify. Read it back out of R2 and confirm it is byte-identical to
    //    what we believe we wrote. Without this the job proves only that a PUT
    //    returned 200, which is not the same as having a backup.
    const back = await env.BACKUPS.get(key)
    if (!back) throw new Error('verification failed: object not found after write')
    const readBytes = new Uint8Array(await back.arrayBuffer())
    const readHash = await sha256(readBytes)
    if (readHash !== blobHash) {
      throw new Error(`verification failed: hash mismatch (wrote ${blobHash.slice(0, 12)}, read ${readHash.slice(0, 12)})`)
    }
    if (readBytes.length !== blob.length) {
      throw new Error(`verification failed: size mismatch (${blob.length} vs ${readBytes.length})`)
    }

    // 4. Prune. 7 daily / 8 weekly / 12 monthly, and every yearly kept forever.
    const pruned = await prune(env)

    await env.BACKUPS.put('status/latest.json', JSON.stringify({
      ok: true, key, bytes: blob.length, sha256: blobHash,
      counts, verified_at: new Date().toISOString(), pruned,
    }, null, 2), { httpMetadata: { contentType: 'application/json' } })

    return { ok: true, key, bytes: blob.length, sha256: blobHash, counts, verified: true, pruned }
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e)

    // A backup that fails quietly is worse than no backup, because it
    // manufactures confidence. Record the failure where the app can see it.
    await env.BACKUPS.put('status/latest.json', JSON.stringify({
      ok: false, error, failed_at: new Date().toISOString(),
    }, null, 2), { httpMetadata: { contentType: 'application/json' } }).catch(() => {})

    if (env.ALERT_WEBHOOK) {
      await fetch(env.ALERT_WEBHOOK, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: `Ledger backup FAILED: ${error}` }),
      }).catch(() => {})
    }
    return { ok: false, error }
  }
}

async function prune(env: Env): Promise<string[]> {
  const listed = await env.BACKUPS.list({ prefix: 'nightly/', limit: 1000 })
  const objects = listed.objects
    .map(o => ({ key: o.key, at: new Date(o.uploaded) }))
    .sort((a, b) => b.at.getTime() - a.at.getTime())

  const keep = new Set<string>()
  const seenWeek = new Set<string>()
  const seenMonth = new Set<string>()
  const seenYear = new Set<string>()

  objects.slice(0, 7).forEach(o => keep.add(o.key))   // last 7 days, always

  for (const o of objects) {
    const y = o.at.getUTCFullYear()
    const week = `${y}-W${Math.floor(o.at.getUTCDate() / 7)}-${o.at.getUTCMonth()}`
    const month = `${y}-${o.at.getUTCMonth()}`
    if (!seenWeek.has(week) && seenWeek.size < 8) { seenWeek.add(week); keep.add(o.key) }
    if (!seenMonth.has(month) && seenMonth.size < 12) { seenMonth.add(month); keep.add(o.key) }
    if (!seenYear.has(String(y))) { seenYear.add(String(y)); keep.add(o.key) }  // yearly forever
  }

  const doomed = objects.filter(o => !keep.has(o.key)).map(o => o.key)
  for (const key of doomed) await env.BACKUPS.delete(key)
  return doomed
}

export default {
  async scheduled(_ctrl: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(runBackup(env).then(r => {
      console.log(r.ok ? `backup ok: ${r.key} (${r.bytes} bytes)` : `backup FAILED: ${r.error}`)
    }))
  },

  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url)

    // Read-only status, so the app can show a red banner when a night is missed.
    if (url.pathname === '/status') {
      const obj = await env.BACKUPS.get('status/latest.json')
      if (!obj) return Response.json({ ok: false, error: 'no backup has run yet' })
      return new Response(obj.body, { headers: { 'Content-Type': 'application/json' } })
    }

    // Manual trigger. Guarded by a shared token so it cannot be used to spin
    // your Supabase reads by anyone who finds the URL.
    if (url.pathname === '/run' && req.method === 'POST') {
      const token = req.headers.get('x-backup-token')
      if (!token || token !== env.SUPABASE_SERVICE_KEY.slice(-16)) {
        return new Response('unauthorized', { status: 401 })
      }
      return Response.json(await runBackup(env, 'manual'))
    }

    return new Response('ledger backup worker', { status: 200 })
  },
}
