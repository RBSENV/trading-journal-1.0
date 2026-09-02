import { createClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL
const key = import.meta.env.VITE_SUPABASE_ANON_KEY

if (!url || !key) {
  throw new Error('Missing VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY. Copy .env.example to .env.local.')
}

export const supabase = createClient(url, key, {
  auth: {
    // Refresh tokens persist so a cold app launch does not force a re-login.
    // Access tokens stay in memory. Nothing auth-related is ever put in a URL.
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: false,
    flowType: 'pkce',
  },
})

export const NY_TZ = 'America/New_York'

/** Every timestamp in this app displays in New York time. No exceptions. */
export function nyTime(iso: string | Date, opts: Intl.DateTimeFormatOptions = {}) {
  const d = typeof iso === 'string' ? new Date(iso) : iso
  return new Intl.DateTimeFormat('en-US', {
    timeZone: NY_TZ, hour: 'numeric', minute: '2-digit', hour12: true, ...opts,
  }).format(d)
}

export function nyDate(iso: string | Date) {
  const d = typeof iso === 'string' ? new Date(iso) : iso
  return new Intl.DateTimeFormat('en-US', {
    timeZone: NY_TZ, weekday: 'short', month: 'short', day: 'numeric', year: 'numeric',
  }).format(d)
}
