/**
 * Ledger media Worker.
 *
 * R2 has no equivalent of Postgres row-level security, so authorization has to
 * happen somewhere. It happens here, before any object is touched.
 *
 * Every request carries the caller's Supabase access token. We ask Supabase who
 * that token belongs to, then allow access only to objects under that user's
 * own prefix. A guessed path from another account is refused at this layer, not
 * merely hidden by the app — which matters, because the app is code anyone can
 * read.
 *
 * Object keys: {user_id}/{yyyy}/{mm}/{attachment_id}.{ext}
 * The user id is the FIRST path segment on purpose: it makes the ownership
 * check a prefix comparison that is hard to get subtly wrong.
 */

export interface Env {
  MEDIA: R2Bucket
  SUPABASE_URL: string
  SUPABASE_ANON_KEY: string
  ALLOWED_ORIGIN?: string
}

const MAX_BYTES = 30 * 1024 * 1024

// HEIC is deliberately absent. Safari 17+ has a documented bug where listing
// image/heic in an upload `accept` causes it to convert OTHER formats INTO
// heic — a PNG goes in and a .heic comes out. The client asks only for these,
// and iOS converts Photos-library HEICs to JPEG on the way out.
const ALLOWED_MIME = new Set([
  'image/jpeg', 'image/png', 'image/webp', 'image/gif', 'application/pdf',
])

/* --- identity ------------------------------------------------------------- */

interface CachedUser { id: string; at: number }
const userCache = new Map<string, CachedUser>()
const CACHE_MS = 60_000

/** Who does this token belong to? Null means "no idea", which means no access. */
async function whoami(env: Env, token: string): Promise<string | null> {
  const hit = userCache.get(token)
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.id

  const res = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: env.SUPABASE_ANON_KEY, Authorization: `Bearer ${token}` },
  })
  if (!res.ok) return null

  const user = await res.json() as { id?: string }
  if (!user.id) return null

  userCache.set(token, { id: user.id, at: Date.now() })
  if (userCache.size > 50) userCache.clear()
  return user.id
}

function bearer(req: Request): string | null {
  const h = req.headers.get('Authorization')
  return h?.startsWith('Bearer ') ? h.slice(7) : null
}

function cors(env: Env, extra: Record<string, string> = {}): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN ?? '*',
    'Access-Control-Allow-Methods': 'GET, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Attachment-Id',
    'Access-Control-Max-Age': '86400',
    ...extra,
  }
}

/**
 * A key is valid only if its first segment is the caller's own user id.
 * Rejecting traversal explicitly rather than relying on the prefix check alone,
 * because "../" in a key is exactly the kind of thing that turns a prefix
 * comparison into a false sense of safety.
 */
function ownsKey(key: string, uid: string): boolean {
  if (!key || key.includes('..') || key.startsWith('/')) return false
  return key.split('/')[0] === uid
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    if (req.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors(env) })
    }

    const url = new URL(req.url)
    if (url.pathname === '/health') {
      return Response.json({ ok: true }, { headers: cors(env) })
    }

    const token = bearer(req)
    if (!token) {
      return new Response('missing token', { status: 401, headers: cors(env) })
    }
    const uid = await whoami(env, token)
    if (!uid) {
      return new Response('invalid token', { status: 401, headers: cors(env) })
    }

    // /object/{key...}
    const m = url.pathname.match(/^\/object\/(.+)$/)
    if (!m) return new Response('not found', { status: 404, headers: cors(env) })

    const key = decodeURIComponent(m[1]!)
    if (!ownsKey(key, uid)) {
      // Deliberately 404, not 403: a 403 would confirm the object exists.
      return new Response('not found', { status: 404, headers: cors(env) })
    }

    if (req.method === 'PUT') {
      const type = req.headers.get('Content-Type') ?? 'application/octet-stream'
      if (!ALLOWED_MIME.has(type)) {
        return new Response(`unsupported type ${type}`, { status: 415, headers: cors(env) })
      }
      const len = Number(req.headers.get('Content-Length') ?? '0')
      if (len > MAX_BYTES) {
        return new Response(`too large (${len} bytes, max ${MAX_BYTES})`, {
          status: 413, headers: cors(env),
        })
      }

      const body = await req.arrayBuffer()
      const digest = await crypto.subtle.digest('SHA-256', body)
      const sha = [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('')

      await env.MEDIA.put(key, body, {
        httpMetadata: { contentType: type, cacheControl: 'private, max-age=31536000' },
        customMetadata: {
          uploaded_at: new Date().toISOString(),
          attachment_id: req.headers.get('X-Attachment-Id') ?? '',
          sha256: sha,
        },
      })

      // The hash goes back so the client can confirm what landed matches what
      // it sent, rather than trusting that a 200 means the bytes are intact.
      return Response.json({ ok: true, key, bytes: body.byteLength, sha256: sha },
        { headers: cors(env) })
    }

    if (req.method === 'GET') {
      const obj = await env.MEDIA.get(key)
      if (!obj) return new Response('not found', { status: 404, headers: cors(env) })
      const headers = new Headers(cors(env))
      obj.writeHttpMetadata(headers)
      headers.set('etag', obj.httpEtag)
      headers.set('Cache-Control', 'private, max-age=3600')
      return new Response(obj.body, { headers })
    }

    if (req.method === 'DELETE') {
      // Soft delete is the app's job. This exists only for the purge path, and
      // is not wired to any button in the UI.
      await env.MEDIA.delete(key)
      return Response.json({ ok: true }, { headers: cors(env) })
    }

    return new Response('method not allowed', { status: 405, headers: cors(env) })
  },
}
