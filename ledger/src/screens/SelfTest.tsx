import { useState } from 'react'
import { supabase } from '../lib/supabase'
import { mutate, flush, pull } from '../lib/sync'
import { db, listRows, getRow } from '../lib/db'
import { buildStatsPack, buildJSON } from '../lib/export'
import { validate } from '../lib/import'
import { generateKeypair, encrypt, decrypt } from '../lib/crypto'

/* ---------------------------------------------------------------------------
   Self-test.

   Everything in this app has been checked as logic. Almost none of it has been
   run against a real database with real row-level security. That gap is where
   bugs actually live, and no amount of careful reading closes it.

   So: press one button, and this exercises the whole stack end to end against
   your actual setup, creating and cleaning up its own throwaway data. What
   fails here is a real bug worth reporting; what passes, you can stop
   wondering about.

   These are the reliability tests from the plan, made runnable.
--------------------------------------------------------------------------- */

type State = 'pending' | 'running' | 'pass' | 'fail' | 'skip'

interface Check {
  id: string
  name: string
  why: string          // what breaks in real life if this fails
  state: State
  detail?: string
  ms?: number
}

const CHECKS: Omit<Check, 'state'>[] = [
  { id: 'auth', name: 'Signed in', why: 'Nothing else can work without this.' },
  { id: 'schema', name: 'Database tables exist', why: 'The setup SQL ran and created everything.' },
  { id: 'rls', name: 'Your data is locked to you', why: 'Without this, anyone with the public key could read your trades.' },
  { id: 'audit', name: 'Change history is read-only', why: 'You can read your history; nothing can rewrite it.' },
  { id: 'seed', name: 'Instruments loaded', why: 'BTC, ETH, ES and NQ should exist.' },
  { id: 'write', name: 'Saving works locally', why: 'A tap must be durable before any network call.' },
  { id: 'push', name: 'Uploading works', why: 'Local saves reach the cloud. This is the one that matters most.' },
  { id: 'pull', name: 'Downloading works', why: 'Changes made elsewhere reach this device.' },
  { id: 'idempotent', name: 'Retrying is safe', why: 'A flaky connection must not create duplicate trades.' },
  { id: 'softdelete', name: 'Delete and restore', why: 'Nothing is ever really gone.' },
  { id: 'export', name: 'Export builds', why: 'You can get your data out at any time.' },
  { id: 'import', name: 'Restore validates', why: 'A damaged backup is refused instead of half-loaded.' },
  { id: 'crypto', name: 'Backup encryption', why: 'Backups can be locked and unlocked.' },
  { id: 'media', name: 'Screenshot storage', why: 'Charts can upload. Skipped if not set up yet.' },
  { id: 'backup', name: 'Nightly backup', why: 'A backup ran and was verified. Skipped if not set up yet.' },
]

export function SelfTest() {
  const [checks, setChecks] = useState<Check[]>(CHECKS.map(c => ({ ...c, state: 'pending' })))
  const [running, setRunning] = useState(false)
  const [done, setDone] = useState(false)

  const set = (id: string, patch: Partial<Check>) =>
    setChecks(cs => cs.map(c => (c.id === id ? { ...c, ...patch } : c)))

  async function step(id: string, fn: () => Promise<string | null>) {
    set(id, { state: 'running' })
    const t0 = performance.now()
    try {
      const detail = await fn()
      const ms = Math.round(performance.now() - t0)
      if (detail === null) set(id, { state: 'skip', ms, detail: 'Not set up yet' })
      else set(id, { state: 'pass', ms, detail })
    } catch (e) {
      set(id, {
        state: 'fail',
        ms: Math.round(performance.now() - t0),
        detail: e instanceof Error ? e.message : String(e),
      })
    }
  }

  async function run() {
    setRunning(true); setDone(false)
    setChecks(CHECKS.map(c => ({ ...c, state: 'pending' })))

    // Everything this test creates is tagged so cleanup can find it even if a
    // step throws partway through.
    const tag = `selftest-${Date.now()}`
    const testTradeId = crypto.randomUUID()

    await step('auth', async () => {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) throw new Error('No session. Sign in first.')
      return session.user.email ?? 'signed in'
    })

    await step('schema', async () => {
      const tables = ['trades', 'trade_legs', 'trade_events', 'daily_preps', 'attachments', 'audit_log']
      const missing: string[] = []
      for (const t of tables) {
        const { error } = await supabase.from(t).select('id', { count: 'exact', head: true }).limit(1)
        if (error) missing.push(`${t} (${error.message})`)
      }
      if (missing.length) throw new Error(`Not reachable: ${missing.join(', ')}`)
      return `${tables.length} core tables reachable`
    })

    await step('rls', async () => {
      // Ask for every trade in the database. RLS should hand back only ours —
      // which, with one account, means everything returned must be ours.
      const { data: { session } } = await supabase.auth.getSession()
      const { data, error } = await supabase.from('trades').select('user_id').limit(200)
      if (error) throw new Error(error.message)
      const foreign = (data ?? []).filter(r => r.user_id !== session?.user.id)
      if (foreign.length) throw new Error(`Returned ${foreign.length} rows belonging to someone else`)
      return `${data?.length ?? 0} rows, all yours`
    })

    await step('audit', async () => {
      const { error: readErr } = await supabase.from('audit_log').select('id').limit(1)
      if (readErr) throw new Error(`Cannot read history: ${readErr.message}`)

      // The important half: writing must be refused.
      const { error: writeErr } = await supabase.from('audit_log').insert({
        user_id: (await supabase.auth.getSession()).data.session?.user.id,
        table_name: 'trades', row_id: crypto.randomUUID(), op: 'forged',
      })
      if (!writeErr) throw new Error('History accepted a forged entry — it should be read-only')
      return 'readable, and refuses writes'
    })

    await step('seed', async () => {
      const rows = await listRows('instruments')
      if (rows.length === 0) throw new Error('No instruments. seed_user_defaults may not have run.')
      return rows.map(r => r.symbol).join(', ')
    })

    await step('write', async () => {
      await mutate('trades', testTradeId, 'insert', {
        symbol_snapshot: 'SELFTEST', direction: 'long', status: 'draft',
        thesis: tag, tz_label: 'America/New_York', needs_review: false,
      })
      const local = await getRow('trades', testTradeId)
      if (!local) throw new Error('Saved but not found in local storage')
      const queued = await db.outbox.count()
      return `saved locally, ${queued} item${queued === 1 ? '' : 's'} queued`
    })

    await step('push', async () => {
      await flush()
      const { data, error } = await supabase.from('trades')
        .select('id, thesis').eq('id', testTradeId).maybeSingle()
      if (error) throw new Error(error.message)
      if (!data) throw new Error('Row never arrived on the server. Check that UPGRADE-SYNC.sql was run.')
      const left = await db.outbox.count()
      return `reached the server, ${left} still queued`
    })

    await step('pull', async () => {
      // Change it server-side, then confirm a pull brings the change down.
      const marker = `pulled-${Date.now()}`
      const { error } = await supabase.from('trades')
        .update({ market_condition: marker }).eq('id', testTradeId)
      if (error) throw new Error(error.message)

      await pull()
      const local = await getRow<Record<string, unknown>>('trades', testTradeId)
      if (local?.market_condition !== marker) {
        throw new Error('Server change did not reach this device')
      }
      return 'server changes arrive'
    })

    await step('idempotent', async () => {
      // Replay a mutation id that has already been applied. It must be
      // recognised, not applied twice. This is the flaky-signal case.
      const { data: { session } } = await supabase.auth.getSession()
      const dupId = crypto.randomUUID()
      const body = {
        id: dupId, entity_type: 'trades', entity_id: crypto.randomUUID(),
        op: 'insert',
        payload: { symbol_snapshot: 'SELFTEST', thesis: tag, status: 'draft',
                   tz_label: 'America/New_York', needs_review: false },
        base_rev: null, client_seq: 1,
        client_time: new Date().toISOString(), device_id: null,
      }
      const first = await supabase.rpc('push_mutations', { mutations: [body] })
      if (first.error) throw new Error(first.error.message)
      const second = await supabase.rpc('push_mutations', { mutations: [body] })
      if (second.error) throw new Error(second.error.message)

      const status = (second.data as { status: string }[])?.[0]?.status
      if (status !== 'duplicate') {
        throw new Error(`Replay returned "${status}" — expected "duplicate". Retries could create doubles.`)
      }
      void session
      return 'replay recognised, no duplicate'
    })

    await step('softdelete', async () => {
      await mutate('trades', testTradeId, 'delete', {})
      await flush()
      const { data: gone } = await supabase.from('trades')
        .select('deleted_at').eq('id', testTradeId).maybeSingle()
      if (!gone?.deleted_at) throw new Error('Delete did not set deleted_at — the row may be really gone')

      await mutate('trades', testTradeId, 'restore', {})
      await flush()
      const { data: back } = await supabase.from('trades')
        .select('deleted_at').eq('id', testTradeId).maybeSingle()
      if (back?.deleted_at) throw new Error('Restore did not bring it back')
      return 'deleted then restored intact'
    })

    await step('export', async () => {
      const md = await buildStatsPack({})
      const json = await buildJSON()
      if (!md.includes('Ledger')) throw new Error('Stats pack looks malformed')
      const parsed = JSON.parse(json)
      if (parsed.format !== 'trading-journal-export') throw new Error('Backup format wrong')
      return `${(md.length / 1024).toFixed(1)} KB markdown, ${(json.length / 1024).toFixed(1)} KB backup`
    })

    await step('import', async () => {
      const good = await buildJSON()
      if (validate(good).errors.length) throw new Error('Our own export failed validation')

      // A truncated file must be refused before anything is written.
      const truncated = good.slice(0, Math.floor(good.length * 0.6))
      if (validate(truncated).errors.length === 0) {
        throw new Error('A damaged file was accepted — it should have been refused')
      }
      return 'accepts good files, refuses damaged ones'
    })

    await step('crypto', async () => {
      const kp = await generateKeypair()
      const secret = JSON.stringify({ test: tag, note: 'faded the lunch range high' })
      const blob = await encrypt(secret, kp.publicKey)
      const back = await decrypt(blob, kp.privateKey)
      if (back !== secret) throw new Error('Round-trip did not match')

      const other = await generateKeypair()
      let refused = false
      try { await decrypt(blob, other.privateKey) } catch { refused = true }
      if (!refused) throw new Error('A different key opened the backup')
      return 'locks and unlocks, wrong key refused'
    })

    await step('media', async () => {
      const worker = import.meta.env.VITE_MEDIA_WORKER_URL
      if (!worker) return null
      const res = await fetch(`${worker}/health`)
      if (!res.ok) throw new Error(`Worker returned ${res.status}`)

      // Unauthenticated requests must be refused.
      const naked = await fetch(`${worker}/object/somebody-else/x.jpg`)
      if (naked.ok) throw new Error('Worker served a file without a token')
      return 'reachable, and refuses requests without a token'
    })

    await step('backup', async () => {
      const worker = import.meta.env.VITE_BACKUP_WORKER_URL
      if (!worker) return null
      const res = await fetch(`${worker}/status`)
      const s = await res.json() as { ok?: boolean; verified_at?: string; error?: string }
      if (!s.ok) throw new Error(s.error ?? 'Last backup failed')
      const age = s.verified_at
        ? Math.round((Date.now() - new Date(s.verified_at).getTime()) / 3600_000)
        : null
      if (age != null && age > 36) throw new Error(`Last verified backup was ${age} hours ago`)
      return age == null ? 'ran' : `verified ${age}h ago`
    })

    // Clean up after ourselves regardless of what failed above.
    try {
      await supabase.from('trades').delete().eq('thesis', tag)
      await db.cache.where('id').equals(testTradeId).delete()
    } catch { /* leftover test rows are harmless */ }

    setRunning(false)
    setDone(true)
  }

  const passed = checks.filter(c => c.state === 'pass').length
  const failed = checks.filter(c => c.state === 'fail').length
  const skipped = checks.filter(c => c.state === 'skip').length

  return (
    <div className="screen stack-l">
      <div>
        <h1>Self-test</h1>
        <p className="hint">
          Runs the whole app against your real setup — saving, uploading, downloading,
          retrying, deleting, restoring, exporting, encrypting. It creates its own
          throwaway data and cleans up after itself. Nothing you've written is touched.
        </p>
      </div>

      <div className="card between" style={{ padding: 12 }}>
        <span className="hint">App build</span>
        <span className="mono" style={{ fontSize: 13, color: 'var(--signal)' }}>
          {typeof __BUILD_ID__ === 'string' ? __BUILD_ID__ : 'unknown'}
        </span>
      </div>

      <button className="primary" onClick={run} disabled={running}>
        {running ? 'Running…' : done ? 'Run again' : 'Run the tests'}
      </button>

      {done && (
        <div className={`banner${failed ? ' warn' : ''}`}>
          <strong>
            {failed === 0
              ? `All ${passed} checks passed`
              : `${failed} failed, ${passed} passed`}
          </strong>
          {failed === 0
            ? skipped
              ? `${skipped} skipped because they aren't set up yet. Everything you have configured works.`
              : 'Everything works. Screenshot this if you want a record.'
            : 'Send me the failures below and I\'ll fix them.'}
        </div>
      )}

      <div className="stack">
        {checks.map(c => (
          <div key={c.id} className="card stack" style={{ gap: 6, padding: 12 }}>
            <div className="between">
              <span style={{ fontSize: 14 }}>
                <span className="mono" style={{
                  marginRight: 8,
                  color: c.state === 'pass' ? 'var(--long)'
                       : c.state === 'fail' ? 'var(--short)'
                       : c.state === 'running' ? 'var(--signal)'
                       : 'var(--faint)',
                }}>
                  {c.state === 'pass' ? '✓' : c.state === 'fail' ? '✕'
                    : c.state === 'running' ? '…' : c.state === 'skip' ? '–' : '○'}
                </span>
                {c.name}
              </span>
              {c.ms != null && <span className="hint mono" style={{ fontSize: 11 }}>{c.ms}ms</span>}
            </div>

            <div className="hint" style={{ fontSize: 12 }}>{c.why}</div>

            {c.detail && (
              <div className="mono" style={{
                fontSize: 11,
                color: c.state === 'fail' ? 'var(--short)' : 'var(--muted)',
                whiteSpace: 'pre-wrap',
              }}>{c.detail}</div>
            )}
          </div>
        ))}
      </div>

      <div className="hint">
        Worth running after any change to the app or the database, and once before
        you start relying on it for real trades.
      </div>
    </div>
  )
}
