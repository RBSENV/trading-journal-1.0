/* ---------------------------------------------------------------------------
   Backup encryption.

   The design decision that matters: this is PUBLIC-KEY encryption, not a shared
   password.

   The backup Worker holds only a public key. It can create backups; it cannot
   read them. Your private key never leaves your password manager and is never
   uploaded anywhere, which means Cloudflare stores ciphertext it has no way to
   open. A shared secret in a Worker env var would have been simpler and would
   have meant the same provider holds both the lock and the key — barely better
   than no encryption at all.

   The cost is real and you should know it up front: LOSE THE PRIVATE KEY AND
   EVERY ENCRYPTED BACKUP IS PERMANENTLY UNREADABLE. Nobody can reset it. That
   is the same property that makes it worth doing.

   Scheme: ECDH P-256 with an ephemeral sender key, HKDF-SHA256 to derive a
   content key, AES-256-GCM to encrypt. Same shape as age, built from WebCrypto
   so it runs in a Worker and in your browser with no dependencies.
--------------------------------------------------------------------------- */

const VERSION = 1
const CURVE = { name: 'ECDH', namedCurve: 'P-256' } as const
const INFO = new TextEncoder().encode('ledger-backup-v1')

const b64 = {
  enc: (b: ArrayBuffer | Uint8Array) => {
    const u = b instanceof Uint8Array ? b : new Uint8Array(b)
    let s = ''
    for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]!)
    return btoa(s)
  },
  dec: (s: string) => {
    const bin = atob(s.replace(/\s+/g, ''))
    const u = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i)
    return u
  },
}

export interface Keypair {
  publicKey: string   // goes in the Worker. Safe to paste anywhere.
  privateKey: string  // goes in your password manager and on paper. Nowhere else.
}

export async function generateKeypair(): Promise<Keypair> {
  const kp = await crypto.subtle.generateKey(CURVE, true, ['deriveBits'])
  const pub = await crypto.subtle.exportKey('raw', kp.publicKey)
  const priv = await crypto.subtle.exportKey('pkcs8', kp.privateKey)
  return {
    publicKey: 'ledger-pk-' + b64.enc(pub),
    privateKey: 'ledger-sk-' + b64.enc(priv),
  }
}

async function deriveAesKey(bits: ArrayBuffer, salt: Uint8Array): Promise<CryptoKey> {
  const hkdfKey = await crypto.subtle.importKey('raw', bits, 'HKDF', false, ['deriveKey'])
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: salt as BufferSource, info: INFO as BufferSource },
    hkdfKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}

/**
 * Encrypt with the recipient's public key alone.
 * Runs in the Worker. Nothing secret is present while this executes.
 */
export async function encrypt(plaintext: string, publicKeyStr: string): Promise<Uint8Array> {
  const raw = b64.dec(publicKeyStr.replace(/^ledger-pk-/, ''))
  const recipient = await crypto.subtle.importKey('raw', raw as BufferSource, CURVE, false, [])

  // A fresh sender key per backup, so two backups never share a content key.
  const eph = await crypto.subtle.generateKey(CURVE, true, ['deriveBits'])
  const shared = await crypto.subtle.deriveBits(
    { name: 'ECDH', public: recipient }, eph.privateKey, 256)

  const salt = crypto.getRandomValues(new Uint8Array(16))
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const key = await deriveAesKey(shared, salt)

  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: iv as BufferSource },
    key,
    new TextEncoder().encode(plaintext) as BufferSource,
  )

  const ephRaw = new Uint8Array(await crypto.subtle.exportKey('raw', eph.publicKey))
  const out = new Uint8Array(1 + ephRaw.length + salt.length + iv.length + ct.byteLength)
  let o = 0
  out[o++] = VERSION
  out.set(ephRaw, o); o += ephRaw.length
  out.set(salt, o); o += salt.length
  out.set(iv, o); o += iv.length
  out.set(new Uint8Array(ct), o)
  return out
}

/** Decrypt with your private key. Runs in your browser, never on a server. */
export async function decrypt(blob: Uint8Array, privateKeyStr: string): Promise<string> {
  if (blob[0] !== VERSION) {
    throw new Error(`Unsupported backup format (version ${blob[0]}). This app reads version ${VERSION}.`)
  }
  const pkcs8 = b64.dec(privateKeyStr.replace(/^ledger-sk-/, ''))
  const priv = await crypto.subtle.importKey('pkcs8', pkcs8 as BufferSource, CURVE, false, ['deriveBits'])

  let o = 1
  const ephRaw = blob.slice(o, o + 65); o += 65
  const salt = blob.slice(o, o + 16); o += 16
  const iv = blob.slice(o, o + 12); o += 12
  const ct = blob.slice(o)

  const eph = await crypto.subtle.importKey('raw', ephRaw as BufferSource, CURVE, false, [])
  const shared = await crypto.subtle.deriveBits({ name: 'ECDH', public: eph }, priv, 256)
  const key = await deriveAesKey(shared, salt)

  let plain: ArrayBuffer
  try {
    plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: iv as BufferSource }, key, ct as BufferSource)
  } catch {
    // AES-GCM is authenticated, so this fires on a wrong key AND on a tampered
    // or truncated file. Both mean the same thing to you: do not trust it.
    throw new Error('Could not decrypt. Either the private key is wrong, or the file is damaged.')
  }
  return new TextDecoder().decode(plain)
}

/** SHA-256, for verifying a backup reads back exactly as written. */
export async function sha256(data: string | Uint8Array): Promise<string> {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data
  const hash = await crypto.subtle.digest('SHA-256', bytes as BufferSource)
  return [...new Uint8Array(hash)].map(b => b.toString(16).padStart(2, '0')).join('')
}

export const toBase64 = b64.enc
export const fromBase64 = b64.dec
