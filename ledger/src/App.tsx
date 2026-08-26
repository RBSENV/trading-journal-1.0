import { useEffect, useState } from 'react'
import type { Session } from '@supabase/supabase-js'
import { supabase, nyDate, nyTime } from './lib/supabase'
import { registerDevice, requestPersistence, isInstalled } from './lib/device'
import { SignIn, MfaChallenge, MfaEnroll } from './features/auth/Auth'

/* ---------------------------------------------------------------------------
   Sync chip — the signature element.
   Stage 1 wires the shape and the states. Stage 2 gives it a real queue to
   report on. It never shows "Synced" while anything is pending: a status
   indicator that lies is worse than none at all.
--------------------------------------------------------------------------- */

type SyncState = 'synced' | 'syncing' | 'offline' | 'error' | 'attention' | 'local'

const LABEL: Record<SyncState, string> = {
  local:     'Saved locally',
  syncing:   'Syncing',
  synced:    'Synced',
  offline:   'Offline',
  error:     'Sync error',
  attention: 'Needs attention',
}

function SyncChip({ state, pending }: { state: SyncState; pending: number }) {
  return (
    <button className="chip" data-state={state} aria-live="polite">
      <span className="dot" />
      {LABEL[state]}{pending > 0 && ` · ${pending}`}
    </button>
  )
}

/* ---------------------------------------------------------------------------
   Storage warnings.
   WebKit clears script-writable storage for an origin with no interaction in
   the last seven days, and it clears all of it at once. A home-screen app sits
   outside Safari with its own counter, so installing genuinely matters here.
--------------------------------------------------------------------------- */

function StorageBanner() {
  const [installed, setInstalled] = useState(true)
  const [persistent, setPersistent] = useState(true)

  useEffect(() => {
    setInstalled(isInstalled())
    requestPersistence().then(setPersistent)
  }, [])

  if (installed && persistent) return null

  return (
    <div className="banner warn">
      <strong>{installed ? 'Storage is not marked persistent' : 'Add Ledger to your Home Screen'}</strong>
      {installed
        ? 'Your browser may clear the offline cache. Anything already synced is safe; unsynced work is not.'
        : 'Running in a browser tab, Safari can clear offline data after seven days unused. Tap Share, then Add to Home Screen.'}
    </div>
  )
}

/** If the last successful sync goes stale, say so. A free-tier project that
 *  pauses is recoverable — but only if you notice. */
function StalenessBanner({ lastSync }: { lastSync: Date | null }) {
  if (!lastSync) return null
  const days = Math.floor((Date.now() - lastSync.getTime()) / 86_400_000)
  if (days < 5) return null
  return (
    <div className="banner warn">
      <strong>Last synced {days} days ago</strong>
      Open the app while online to sync, or check your Supabase project status.
    </div>
  )
}

/* ---------------------------------------------------------------------------
   Bottom navigation
--------------------------------------------------------------------------- */

const TABS = [
  { id: 'today',  glyph: '▤', label: 'Today' },
  { id: 'trades', glyph: '▦', label: 'Trades' },
  { id: 'add',    glyph: '+', label: '' },
  { id: 'prep',   glyph: '◷', label: 'Prep' },
  { id: 'search', glyph: '⌕', label: 'Search' },
] as const

function BottomNav({ tab, onTab }: { tab: string; onTab: (id: string) => void }) {
  return (
    <nav className="tabs">
      {TABS.map(t => (
        <button key={t.id} className={t.id === 'add' ? 'add' : ''}
          aria-current={tab === t.id ? 'page' : undefined}
          aria-label={t.label || 'Add'}
          onClick={() => onTab(t.id)}>
          <span className="glyph" aria-hidden>{t.glyph}</span>
          {t.label && <span>{t.label}</span>}
        </button>
      ))}
    </nav>
  )
}

/* ---------------------------------------------------------------------------
   Today — empty in Stage 1. Stage 3 fills it with open positions and drafts.
--------------------------------------------------------------------------- */

function Today({ email, mfaOn, onEnableMfa }: {
  email: string; mfaOn: boolean; onEnableMfa: () => void
}) {
  const now = new Date()
  return (
    <div className="screen stack-l">
      <div className="between">
        <div>
          <h1>{nyDate(now)}</h1>
          <span className="hint num">{nyTime(now)} ET</span>
        </div>
      </div>

      <StorageBanner />
      <StalenessBanner lastSync={null} />

      <div>
        <h2>Open</h2>
        <div className="card empty">
          No open positions.<br />
          <span className="hint">Trade capture arrives in Stage 3.</span>
        </div>
      </div>

      <div>
        <h2>Account</h2>
        <div className="card stack">
          <div className="between">
            <span className="hint">Signed in</span>
            <span className="mono" style={{ fontSize: 13 }}>{email}</span>
          </div>
          <div className="between">
            <span className="hint">Two-factor</span>
            {mfaOn
              ? <span className="long mono" style={{ fontSize: 13 }}>On</span>
              : <button className="link" onClick={onEnableMfa}>Turn on</button>}
          </div>
          <button className="ghost" onClick={() => supabase.auth.signOut()}>Sign out</button>
        </div>
      </div>
    </div>
  )
}

/* ---------------------------------------------------------------------------
   Root
--------------------------------------------------------------------------- */

type Gate = 'loading' | 'signin' | 'challenge' | 'ready'

export default function App() {
  const [session, setSession] = useState<Session | null>(null)
  const [gate, setGate] = useState<Gate>('loading')
  const [factorId, setFactorId] = useState<string | null>(null)
  const [mfaOn, setMfaOn] = useState(false)
  const [enrolling, setEnrolling] = useState(false)
  const [tab, setTab] = useState('today')
  const [online, setOnline] = useState(navigator.onLine)

  useEffect(() => {
    const on = () => setOnline(true)
    const off = () => setOnline(false)
    window.addEventListener('online', on)
    window.addEventListener('offline', off)
    return () => { window.removeEventListener('online', on); window.removeEventListener('offline', off) }
  }, [])

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session))
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setSession(s))
    return () => sub.subscription.unsubscribe()
  }, [])

  // Decide what the user has to do next: enroll, verify, or get on with it.
  useEffect(() => {
    if (!session) { setGate('signin'); return }
    let cancelled = false

    ;(async () => {
      const { data: aal } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel()
      const { data: factors } = await supabase.auth.mfa.listFactors()
      if (cancelled) return

      const verified = factors?.totp?.find(f => f.status === 'verified')
      setMfaOn(Boolean(verified))

      // Two-factor is optional. If it has been switched on, honour it; if not,
      // straight through. RLS is what stops anyone else reading these rows
      // either way — this only guards against someone holding your password.
      if (verified && aal?.currentLevel !== 'aal2') {
        setFactorId(verified.id); setGate('challenge'); return
      }

      await registerDevice(session.user.id)
      await supabase.rpc('seed_user_defaults')
      if (!cancelled) setGate('ready')
    })()

    return () => { cancelled = true }
  }, [session])

  if (gate === 'loading') return <div className="center"><span className="hint">Loading…</span></div>
  if (gate === 'signin' || !session) return <SignIn onDone={() => {}} />
  if (enrolling) return <MfaEnroll onDone={() => { setEnrolling(false); setGate('loading') }} />
  if (gate === 'challenge' && factorId) return <MfaChallenge factorId={factorId} onDone={() => setGate('loading')} />

  return (
    <div className="app">
      {tab === 'today'
        ? <Today email={session.user.email ?? ''} mfaOn={mfaOn} onEnableMfa={() => setEnrolling(true)} />
        : <div className="screen"><div className="card empty">Not built yet.</div></div>}

      <SyncChip state={online ? 'synced' : 'offline'} pending={0} />
      <BottomNav tab={tab} onTab={setTab} />
    </div>
  )
}
