import { supabase } from './supabase'

const KEY = 'ledger.device_id'

/** A stable id for this browser, used for edit provenance and the sync queue. */
export function deviceId(): string {
  let id = localStorage.getItem(KEY)
  if (!id) {
    id = crypto.randomUUID()
    localStorage.setItem(KEY, id)
  }
  return id
}

function guessLabel(): string {
  const ua = navigator.userAgent
  if (/iPhone/.test(ua)) return 'iPhone'
  if (/iPad/.test(ua)) return 'iPad'
  if (/Macintosh/.test(ua)) return 'Mac'
  if (/Android/.test(ua)) return 'Android'
  if (/Windows/.test(ua)) return 'Windows PC'
  return 'Browser'
}

export async function registerDevice(userId: string) {
  const id = deviceId()
  await supabase.from('devices').upsert({
    id,
    user_id: userId,
    label: guessLabel(),
    user_agent: navigator.userAgent.slice(0, 400),
    last_seen_at: new Date().toISOString(),
  }, { onConflict: 'id' })
  return id
}

/** True when launched from the home screen rather than a Safari tab. */
export function isInstalled(): boolean {
  return window.matchMedia('(display-mode: standalone)').matches
    || (navigator as { standalone?: boolean }).standalone === true
}

/**
 * Ask WebKit to treat our storage as persistent.
 * On iOS this must be requested on every launch, and it is not a guarantee —
 * the local cache is a cache, never the record.
 */
export async function requestPersistence(): Promise<boolean> {
  if (!navigator.storage?.persist) return false
  try {
    if (await navigator.storage.persisted?.()) return true
    return await navigator.storage.persist()
  } catch {
    return false
  }
}
