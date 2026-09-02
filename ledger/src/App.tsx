import { useCallback, useEffect, useState } from 'react'
import type { Session } from '@supabase/supabase-js'
import { supabase } from './lib/supabase'
import { registerDevice, requestPersistence, isInstalled } from './lib/device'
import { SignIn, MfaChallenge, MfaEnroll } from './features/auth/Auth'
import { startSync, subscribe, getStatus, type SyncStatus } from './lib/sync'
import {
  openTrades, draftTrades, needsReview, listTrades,
  fmtDate, fmtTime, fmtDuration, realizedR,
  type Trade,
} from './lib/trades'
import { NewTrade } from './features/trades/NewTrade'
import { QuickUpdate } from './features/trades/QuickUpdate'
import { TradeDetail } from './features/trades/TradeDetail'
import { ExportScreen } from './screens/Export'
import { DailyPrepScreen } from './features/prep/DailyPrep'
import { BackupScreen } from './screens/Backup'
import { TrashScreen, ConflictsScreen } from './screens/Integrity'
import { SelfTest } from './screens/SelfTest'

/* ---------------------------------------------------------------------------
   Sync chip.
   Always on screen, always tappable, always honest. "Synced" is never shown
   while anything is pending — a status indicator that lies is worse than none.
--------------------------------------------------------------------------- */

const LABEL: Record<SyncStatus['state'], string> = {
  local: 'Saved locally', syncing: 'Syncing', synced: 'Synced',
  offline: 'Offline', error: 'Sync error', attention: 'Needs attention',
}

function SyncChip({ status, onTap }: { status: SyncStatus; onTap: () => void }) {
  return (
    <button className="chip" data-state={status.state} onClick={onTap} aria-live="polite">
      <span className="dot" />
      {LABEL[status.state]}{status.pending > 0 && ` · ${status.pending}`}
    </button>
  )
}

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
        : 'In a browser tab, Safari can clear offline data after seven days unused. Tap Share, then Add to Home Screen.'}
    </div>
  )
}

/* --- trade card ----------------------------------------------------------- */

function TradeCard({ t, onOpen, onUpdate }: {
  t: Trade; onOpen: () => void; onUpdate: () => void
}) {
  const dir = t.direction === 'long' ? 'long' : 'short'
  const r = realizedR(t)
  return (
    <div className="card stack" style={{ gap: 10 }}>
      <div className="between" onClick={onOpen} style={{ cursor: 'pointer' }}>
        <div>
          <span className="mono" style={{ fontSize: 16 }}>{t.symbol_snapshot} </span>
          <span className={`mono ${dir}`} style={{ fontSize: 13 }}>{t.direction?.toUpperCase()}</span>
          <span className="hint mono" style={{ fontSize: 12 }}>  #{t.trade_number ?? '—'}</span>
        </div>
        <span className="hint mono" style={{ fontSize: 12 }}>
          {t.opened_at ? fmtDuration(t.opened_at, t.closed_at) : 'draft'}
        </span>
      </div>

      <div className="hint mono" style={{ fontSize: 12 }}>
        {t.current_stop != null && `Stop ${t.current_stop}`}
        {t.current_stop != null && t.current_target != null && ' · '}
        {t.current_target != null && `Target ${t.current_target}`}
        {t.setup_name_snapshot && ` · ${t.setup_name_snapshot}`}
      </div>

      {t.final_pnl_amount != null && (
        <div className="mono">
          <span className={t.final_pnl_amount >= 0 ? 'long' : 'short'}>
            {t.final_pnl_amount >= 0 ? '+' : ''}${Math.round(t.final_pnl_amount).toLocaleString()}
          </span>
          {r != null && <span className="hint">  {r >= 0 ? '+' : ''}{r}R</span>}
        </div>
      )}

      {(t.status === 'open' || t.status === 'partially_closed') && (
        <button className="ghost" onClick={onUpdate}>+ Update</button>
      )}
    </div>
  )
}

/* --- screens -------------------------------------------------------------- */

function Today({ email, onOpen, onUpdate, refreshKey }: {
  email: string
  onOpen: (id: string) => void
  onUpdate: (t: Trade) => void
  refreshKey: number
}) {
  const [open, setOpen] = useState<Trade[]>([])
  const [drafts, setDrafts] = useState<Trade[]>([])
  const [review, setReview] = useState<Trade[]>([])

  useEffect(() => {
    openTrades().then(setOpen)
    draftTrades().then(setDrafts)
    needsReview().then(setReview)
  }, [refreshKey])

  const now = new Date().toISOString()

  return (
    <div className="screen stack-l">
      <div>
        <h1>{fmtDate(now)}</h1>
        <span className="hint num">{fmtTime(now)} ET</span>
      </div>

      <StorageBanner />

      <div>
        <h2>Open{open.length > 0 && ` (${open.length})`}</h2>
        {open.length === 0
          ? <div className="card empty">No open positions.</div>
          : <div className="stack">{open.map(t =>
              <TradeCard key={t.id} t={t} onOpen={() => onOpen(t.id)} onUpdate={() => onUpdate(t)} />)}</div>}
      </div>

      {drafts.length > 0 && (
        <div>
          <h2>Drafts ({drafts.length})</h2>
          <div className="stack">{drafts.map(t =>
            <TradeCard key={t.id} t={t} onOpen={() => onOpen(t.id)} onUpdate={() => onUpdate(t)} />)}</div>
        </div>
      )}

      {review.length > 0 && (
        <div>
          <h2>Needs review ({review.length})</h2>
          <div className="stack">{review.map(t =>
            <TradeCard key={t.id} t={t} onOpen={() => onOpen(t.id)} onUpdate={() => onUpdate(t)} />)}</div>
        </div>
      )}

      <div>
        <h2>Account</h2>
        <div className="card stack">
          <div className="between">
            <span className="hint">Signed in</span>
            <span className="mono" style={{ fontSize: 13 }}>{email}</span>
          </div>
          <button className="ghost" onClick={() => supabase.auth.signOut()}>Sign out</button>
        </div>
      </div>
    </div>
  )
}

function TradesList({ onOpen, refreshKey }: { onOpen: (id: string) => void; refreshKey: number }) {
  const [trades, setTrades] = useState<Trade[]>([])
  const [q, setQ] = useState('')

  useEffect(() => {
    listTrades().then(ts => setTrades(ts.sort((a, b) =>
      (b.opened_at ?? b.created_at ?? '').localeCompare(a.opened_at ?? a.created_at ?? ''))))
  }, [refreshKey])

  const shown = q.trim()
    ? trades.filter(t => JSON.stringify(t).toLowerCase().includes(q.toLowerCase()))
    : trades

  return (
    <div className="screen stack-l">
      <h1>Trades</h1>
      <input type="text" value={q} placeholder="Search symbols, notes, setups…"
        onChange={e => setQ(e.target.value)} />
      {shown.length === 0
        ? <div className="card empty">{trades.length === 0 ? 'No trades yet.' : 'Nothing matches.'}</div>
        : <div className="stack">{shown.map(t =>
            <TradeCard key={t.id} t={t} onOpen={() => onOpen(t.id)} onUpdate={() => onOpen(t.id)} />)}</div>}
    </div>
  )
}

function QueueView({ status, onClose, onBackup, onTrash, onConflicts, onSelfTest }: {
  status: SyncStatus
  onClose: () => void
  onBackup: () => void
  onTrash: () => void
  onConflicts: () => void
  onSelfTest: () => void
}) {
  return (
    <div className="screen stack-l">
      <div className="between">
        <h1>Sync</h1>
        <button className="link" onClick={onClose}>Done</button>
      </div>
      <div className="card stack">
        <div className="between"><span className="hint">State</span><span className="mono">{LABEL[status.state]}</span></div>
        <div className="between"><span className="hint">Waiting to upload</span><span className="mono">{status.pending}</span></div>
        {status.lastSyncAt && (
          <div className="between"><span className="hint">Last synced</span>
            <span className="mono" style={{ fontSize: 13 }}>{fmtTime(status.lastSyncAt)} ET</span></div>
        )}
        {status.lastError && <div className="error">{status.lastError}</div>}
      </div>
      <div className="hint">
        Anything showing here is saved on this device and will upload on its own when
        you have signal. Nothing is lost while it waits.
      </div>

      <div className="stack">
        {status.conflicts > 0 && (
          <button className="ghost" onClick={onConflicts}
            style={{ borderColor: 'var(--short)', color: 'var(--short)' }}>
            Resolve {status.conflicts} conflict{status.conflicts === 1 ? '' : 's'} ›
          </button>
        )}
        <button className="ghost" onClick={onBackup}>Backup &amp; restore ›</button>
        <button className="ghost" onClick={onTrash}>Trash ›</button>
        <button className="ghost" onClick={onConflicts}>Needs attention ›</button>
        <button className="ghost" onClick={onSelfTest}>Run self-test ›</button>
      </div>
    </div>
  )
}

/* --- root ----------------------------------------------------------------- */

type Gate = 'loading' | 'signin' | 'challenge' | 'ready'
type Tab = 'today' | 'trades' | 'prep' | 'export' | 'sync' | 'backup' | 'trash' | 'conflicts' | 'selftest'

export default function App() {
  const [session, setSession] = useState<Session | null>(null)
  const [gate, setGate] = useState<Gate>('loading')
  const [factorId, setFactorId] = useState<string | null>(null)
  const [enrolling, setEnrolling] = useState(false)
  const [tab, setTab] = useState<Tab>('today')
  const [status, setStatus] = useState<SyncStatus>(getStatus())
  const [refreshKey, setRefreshKey] = useState(0)

  const [detailId, setDetailId] = useState<string | null>(null)
  const [updating, setUpdating] = useState<Trade | null>(null)
  const [creating, setCreating] = useState(false)

  const refresh = useCallback(() => setRefreshKey(k => k + 1), [])

  useEffect(() => subscribe(setStatus), [])

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session))
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setSession(s))
    return () => sub.subscription.unsubscribe()
  }, [])

  useEffect(() => {
    if (!session) { setGate('signin'); return }
    let cancelled = false
    ;(async () => {
      const { data: aal } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel()
      const { data: factors } = await supabase.auth.mfa.listFactors()
      if (cancelled) return
      const verified = factors?.totp?.find(f => f.status === 'verified')
      if (verified && aal?.currentLevel !== 'aal2') {
        setFactorId(verified.id); setGate('challenge'); return
      }
      await registerDevice(session.user.id)
      await supabase.rpc('seed_user_defaults')
      await startSync()
      if (!cancelled) { setGate('ready'); refresh() }
    })()
    return () => { cancelled = true }
  }, [session, refresh])

  if (gate === 'loading') return <div className="center"><span className="hint">Loading…</span></div>
  if (gate === 'signin' || !session) return <SignIn onDone={() => {}} />
  if (enrolling) return <MfaEnroll onDone={() => { setEnrolling(false); setGate('loading') }} />
  if (gate === 'challenge' && factorId)
    return <MfaChallenge factorId={factorId} onDone={() => setGate('loading')} />

  return (
    <div className="app">
      {tab === 'today' && (
        <Today email={session.user.email ?? ''} refreshKey={refreshKey}
          onOpen={setDetailId} onUpdate={setUpdating} />
      )}
      {tab === 'trades' && <TradesList onOpen={setDetailId} refreshKey={refreshKey} />}
      {tab === 'prep' && <DailyPrepScreen />}
      {tab === 'export' && <ExportScreen />}
      {tab === 'sync' && <QueueView status={status} onClose={() => setTab('today')} onBackup={() => setTab('backup')}
          onTrash={() => setTab('trash')} onConflicts={() => setTab('conflicts')}
          onSelfTest={() => setTab('selftest')} />}
      {tab === 'backup' && <BackupScreen />}
      {tab === 'trash' && <TrashScreen />}
      {tab === 'conflicts' && <ConflictsScreen />}
      {tab === 'selftest' && <SelfTest />}

      {creating && (
        <NewTrade onCancel={() => setCreating(false)}
          onDone={id => { setCreating(false); refresh(); setDetailId(id) }} />
      )}
      {updating && (
        <QuickUpdate trade={updating} onClose={() => setUpdating(null)}
          onDone={() => { setUpdating(null); refresh() }} />
      )}
      {detailId && (
        <TradeDetail tradeId={detailId} onClose={() => { setDetailId(null); refresh() }}
          onUpdate={refresh} />
      )}

      <SyncChip status={status} onTap={() => setTab('sync')} />

      <nav className="tabs">
        <button aria-current={tab === 'today' ? 'page' : undefined} onClick={() => setTab('today')}>
          <span className="glyph" aria-hidden>▤</span><span>Today</span>
        </button>
        <button aria-current={tab === 'trades' ? 'page' : undefined} onClick={() => setTab('trades')}>
          <span className="glyph" aria-hidden>▦</span><span>Trades</span>
        </button>
        <button className="add" aria-label="New trade" onClick={() => setCreating(true)}>
          <span className="glyph" aria-hidden>+</span>
        </button>
        <button aria-current={tab === 'prep' ? 'page' : undefined} onClick={() => setTab('prep')}>
          <span className="glyph" aria-hidden>◷</span><span>Prep</span>
        </button>
        <button aria-current={tab === 'export' ? 'page' : undefined} onClick={() => setTab('export')}>
          <span className="glyph" aria-hidden>↗</span><span>Export</span>
        </button>
      </nav>
    </div>
  )
}
