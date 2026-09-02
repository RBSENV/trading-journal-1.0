import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { mutate, resolveConflict } from '../lib/sync'
import { listRows } from '../lib/db'
import { fmtDate, fmtTime } from '../lib/trades'
import { Sheet } from '../components/Form'

/* ---------------------------------------------------------------------------
   Integrity.

   Three promises made earlier in this project, made visible here:

     "there is a permanent audit trail"   -> History, with one-tap revert
     "nothing is ever really deleted"     -> Trash, with restore
     "nothing is silently discarded"      -> Conflicts, where you choose

   A guarantee you cannot see is a guarantee you have to take on faith. These
   screens exist so you don't have to.
--------------------------------------------------------------------------- */

interface AuditRow {
  id: number
  table_name: string
  row_id: string
  op: string
  field_name: string | null
  old_value: unknown
  new_value: unknown
  changed_at: string
}

const PRETTY: Record<string, string> = {
  thesis: 'Thesis', invalidation_thesis: 'Invalidation', pre_trade_plan: 'Pre-trade plan',
  during_trade_notes: 'During-trade notes', post_trade_review: 'Review',
  what_went_well: 'What went well', what_went_wrong: 'What went wrong',
  lesson_learned: 'Lesson', final_pnl_amount: 'Final P/L', final_pnl_percent: 'Percent',
  current_stop: 'Stop', current_target: 'Target', risk_amount: '1R',
  mae_price: 'MAE', mfe_price: 'MFE', grade_at_entry: 'Grade', conviction: 'Conviction',
  status: 'Status', followed_plan: 'Followed plan', occurred_at: 'Time',
  executed_at: 'Time', description: 'Note', deleted_at: 'Deleted',
}

const show = (v: unknown): string => {
  if (v === null || v === undefined) return '—'
  if (typeof v === 'string') {
    const s = v.replace(/^"|"$/g, '')
    return s.length > 140 ? s.slice(0, 140) + '…' : s || '(empty)'
  }
  return String(v)
}

/* --- change history ------------------------------------------------------- */

export function HistoryView({ rowId, onClose }: { rowId: string; onClose: () => void }) {
  const [rows, setRows] = useState<AuditRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [reverting, setReverting] = useState<number | null>(null)

  async function load() {
    setLoading(true)
    const { data, error } = await supabase
      .from('audit_log')
      .select('*')
      .eq('row_id', rowId)
      .order('changed_at', { ascending: false })
      .limit(300)
    if (error) setError(error.message)
    else setRows((data ?? []) as AuditRow[])
    setLoading(false)
  }
  useEffect(() => { load() }, [rowId])

  async function revert(r: AuditRow) {
    if (!r.field_name) return
    setReverting(r.id)
    const prev = typeof r.old_value === 'string'
      ? r.old_value.replace(/^"|"$/g, '')
      : r.old_value
    await mutate(r.table_name, r.row_id, 'update', { [r.field_name]: prev })
    setReverting(null)
    load()
  }

  const days: { day: string; items: AuditRow[] }[] = []
  for (const r of rows) {
    const day = fmtDate(r.changed_at)
    const last = days[days.length - 1]
    if (last && last.day === day) last.items.push(r)
    else days.push({ day, items: [r] })
  }

  return (
    <Sheet title="Change history" onClose={onClose}>
      <div className="stack-l">
        <p className="hint">
          Written by the database itself, not by the app. Nothing running on your
          phone can skip it or edit it — so if the app ever has a bug, this is
          still correct.
        </p>

        {loading && <div className="hint">Loading…</div>}
        {error && <div className="error">{error}</div>}
        {!loading && rows.length === 0 && (
          <div className="card empty">
            No changes recorded yet.
            <div className="hint" style={{ marginTop: 6 }}>
              History starts once this record has synced at least once.
            </div>
          </div>
        )}

        {days.map(({ day, items }) => (
          <div key={day} className="stack">
            <div className="hint mono" style={{
              fontSize: 11, letterSpacing: '0.08em', textTransform: 'uppercase',
            }}>{day}</div>

            {items.map(r => (
              <div key={r.id} className="card stack" style={{ gap: 8, padding: 12 }}>
                <div className="between">
                  <span className="mono" style={{ fontSize: 13, color: 'var(--signal)' }}>
                    {r.field_name ? (PRETTY[r.field_name] ?? r.field_name) : r.op}
                  </span>
                  <span className="hint mono" style={{ fontSize: 12 }}>{fmtTime(r.changed_at)}</span>
                </div>

                {r.field_name && (
                  <>
                    <div style={{ fontSize: 13 }}>
                      <span className="short mono" style={{ fontSize: 11 }}>was </span>
                      <span className="hint">{show(r.old_value)}</span>
                    </div>
                    <div style={{ fontSize: 13 }}>
                      <span className="long mono" style={{ fontSize: 11 }}>now </span>
                      <span>{show(r.new_value)}</span>
                    </div>
                    <button className="link" disabled={reverting === r.id}
                      onClick={() => revert(r)} style={{ alignSelf: 'flex-start' }}>
                      {reverting === r.id ? 'Reverting…' : 'Put it back'}
                    </button>
                  </>
                )}
              </div>
            ))}
          </div>
        ))}
      </div>
    </Sheet>
  )
}

/* --- trash ---------------------------------------------------------------- */

const TRASHABLE = [
  ['trades', 'Trades'], ['trade_legs', 'Legs'], ['trade_events', 'Timeline entries'],
  ['attachments', 'Charts'], ['daily_preps', 'Daily prep'], ['prep_levels', 'Key levels'],
  ['trade_mistakes', 'Mistakes'], ['observations', 'Observations'],
] as const

interface Deleted {
  id: string
  table: string
  label: string
  deleted_at: string
}

export function TrashScreen() {
  const [items, setItems] = useState<Deleted[]>([])
  const [busy, setBusy] = useState<string | null>(null)

  async function load() {
    const out: Deleted[] = []
    for (const [table, human] of TRASHABLE) {
      const rows = await listRows<Record<string, unknown>>(table, r => !!r.deleted_at)
      for (const r of rows) {
        out.push({
          id: r.id as string,
          table,
          label: describe(table, human, r),
          deleted_at: r.deleted_at as string,
        })
      }
    }
    setItems(out.sort((a, b) => (b.deleted_at ?? '').localeCompare(a.deleted_at ?? '')))
  }
  useEffect(() => { load() }, [])

  async function restore(d: Deleted) {
    setBusy(d.id)
    await mutate(d.table, d.id, 'restore', {})
    setBusy(null)
    load()
  }

  return (
    <div className="screen stack-l">
      <h1>Trash</h1>
      <p className="hint">
        Nothing in this app is deleted for real. Removing something moves it here,
        where it stays until you deliberately purge it — and there is no purge
        button, on purpose.
      </p>

      {items.length === 0 && <div className="card empty">Nothing deleted.</div>}

      <div className="stack">
        {items.map(d => (
          <div key={`${d.table}-${d.id}`} className="card between" style={{ padding: 12 }}>
            <div>
              <div style={{ fontSize: 14 }}>{d.label}</div>
              <div className="hint mono" style={{ fontSize: 12 }}>
                {d.deleted_at ? `${fmtDate(d.deleted_at)} ${fmtTime(d.deleted_at)}` : ''}
              </div>
            </div>
            <button className="ghost" disabled={busy === d.id}
              onClick={() => restore(d)} style={{ flex: 'none', padding: '10px 14px' }}>
              {busy === d.id ? '…' : 'Restore'}
            </button>
          </div>
        ))}
      </div>
    </div>
  )
}

function describe(table: string, human: string, r: Record<string, unknown>): string {
  if (table === 'trades') {
    return `${r.symbol_snapshot ?? '?'} ${String(r.direction ?? '').toUpperCase()} · #${r.trade_number ?? '—'}`
  }
  if (table === 'trade_events') {
    return `${human} — ${String(r.description ?? r.title ?? r.event_type ?? '').slice(0, 60)}`
  }
  if (table === 'trade_legs') return `${human} — ${r.action} ${r.quantity} @ ${r.price}`
  if (table === 'attachments') return `${human} — ${r.caption ?? r.original_filename ?? 'image'}`
  if (table === 'daily_preps') return `${human} — ${r.prep_date}`
  if (table === 'prep_levels') return `${human} — ${r.level_type} ${r.price}`
  return human
}

/* --- conflicts ------------------------------------------------------------ */

interface Conflict {
  id: string
  entity_type: string
  entity_id: string
  field_name: string
  local_value: unknown
  remote_value: unknown
  detected_at: string
}

export function ConflictsScreen() {
  const [items, setItems] = useState<Conflict[]>([])
  const [busy, setBusy] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  async function load() {
    setLoading(true)
    const { data } = await supabase
      .from('conflicts')
      .select('*')
      .is('resolved_at', null)
      .order('detected_at', { ascending: false })
    setItems((data ?? []) as Conflict[])
    setLoading(false)
  }
  useEffect(() => { load() }, [])

  async function choose(id: string, c: 'local' | 'remote' | 'both_kept') {
    setBusy(id)
    await resolveConflict(id, c)
    setBusy(null)
    load()
  }

  return (
    <div className="screen stack-l">
      <h1>Needs attention</h1>

      {loading && <div className="hint">Checking…</div>}

      {!loading && items.length === 0 && (
        <div className="card empty">
          Nothing to resolve.
          <div className="hint" style={{ marginTop: 6 }}>
            This fills up only when two devices edit the same words while both are offline.
          </div>
        </div>
      )}

      {items.length > 0 && (
        <p className="hint">
          Two devices wrote different text into the same field. Neither was thrown
          away — pick one, or keep both.
        </p>
      )}

      {items.map(c => (
        <div key={c.id} className="card stack">
          <div className="between">
            <span className="mono" style={{ fontSize: 13, color: 'var(--signal)' }}>
              {PRETTY[c.field_name] ?? c.field_name}
            </span>
            <span className="hint mono" style={{ fontSize: 12 }}>
              {fmtDate(c.detected_at)} {fmtTime(c.detected_at)}
            </span>
          </div>

          <div className="stack" style={{ gap: 6 }}>
            <span className="hint" style={{ fontSize: 12 }}>Already saved</span>
            <div style={{
              padding: 10, background: 'var(--ink)', borderRadius: 'var(--r)',
              fontSize: 13, whiteSpace: 'pre-wrap',
            }}>{show(c.remote_value)}</div>
          </div>

          <div className="stack" style={{ gap: 6 }}>
            <span className="hint" style={{ fontSize: 12 }}>From your other device</span>
            <div style={{
              padding: 10, background: 'var(--ink)', borderRadius: 'var(--r)',
              fontSize: 13, whiteSpace: 'pre-wrap', borderLeft: '2px solid var(--signal)',
            }}>{show(c.local_value)}</div>
          </div>

          <div className="row">
            <button style={{ flex: 1 }} disabled={busy === c.id}
              onClick={() => choose(c.id, 'remote')}>Keep saved</button>
            <button style={{ flex: 1 }} disabled={busy === c.id}
              onClick={() => choose(c.id, 'local')}>Keep other</button>
          </div>
          <button className="primary" disabled={busy === c.id}
            onClick={() => choose(c.id, 'both_kept')}>Keep both</button>
        </div>
      ))}
    </div>
  )
}
