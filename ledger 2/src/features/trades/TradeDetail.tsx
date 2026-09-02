import { useEffect, useState } from 'react'
import {
  getTrade, legsFor, updateTrade,
  realizedR, excursionR, exitEfficiency, plannedRR, checkConsistency,
  fmtTime, fmtDate, fmtDuration,
  type Trade, type TradeLeg, type Adherence,
} from '../../lib/trades'
import { Sheet, Field, Area, Choice, Num } from '../../components/Form'
import { MediaStrip, AttachSheet } from '../media/Media'
import { Timeline } from './Timeline'
import { HistoryView } from '../../screens/Integrity'

type Tab = 'overview' | 'legs' | 'timeline' | 'charts' | 'review'

export function TradeDetail({ tradeId, onClose, onUpdate }: {
  tradeId: string; onClose: () => void; onUpdate: () => void
}) {
  const [trade, setTrade] = useState<Trade | null>(null)
  const [legs, setLegs] = useState<TradeLeg[]>([])
  const [tab, setTab] = useState<Tab>('overview')
  const [attaching, setAttaching] = useState(false)
  const [history, setHistory] = useState(false)

  async function load() {
    const t = await getTrade(tradeId)
    setTrade(t ?? null)
    setLegs(await legsFor(tradeId))
  }
  useEffect(() => { load() }, [tradeId])

  if (!trade) return <Sheet title="Loading" onClose={onClose}><div className="empty">…</div></Sheet>

  const r = realizedR(trade)
  const eff = exitEfficiency(trade, legs)
  const warnings = checkConsistency(trade, legs)
  const dirClass = trade.direction === 'long' ? 'long' : 'short'

  return (
    <Sheet title={`#${trade.trade_number ?? '—'}`} onClose={onClose}>
      <div className="stack-l">
        <div>
          <h1>
            {trade.symbol_snapshot}{' '}
            <span className={dirClass}>{trade.direction?.toUpperCase()}</span>
          </h1>
          <div className="hint mono">
            {trade.status.replace('_', ' ')}
            {trade.opened_at && ` · ${fmtDate(trade.opened_at)} ${fmtTime(trade.opened_at)}`}
            {trade.opened_at && ` · ${fmtDuration(trade.opened_at, trade.closed_at)}`}
          </div>
          <button className="link" onClick={() => setHistory(true)}
            style={{ paddingLeft: 0 }}>View change history ›</button>
        </div>

        {warnings.length > 0 && (
          <div className="banner warn">
            <strong>Worth a look</strong>
            {warnings.join(' · ')}
          </div>
        )}

        <div className="row" style={{ borderBottom: '1px solid var(--line)', gap: 0 }}>
          {(['overview', 'legs', 'timeline', 'charts', 'review'] as Tab[]).map(t => (
            <button key={t} onClick={() => setTab(t)}
              style={{
                flex: 1, border: 'none', borderRadius: 0, background: 'none',
                borderBottom: tab === t ? '2px solid var(--signal)' : '2px solid transparent',
                color: tab === t ? 'var(--text)' : 'var(--muted)',
                fontSize: 13, textTransform: 'capitalize',
              }}>{t}</button>
          ))}
        </div>

        {tab === 'overview' && (
          <div className="stack">
            <Stat label="Final P/L" value={trade.final_pnl_amount == null ? '—'
              : `${trade.final_pnl_amount >= 0 ? '+' : ''}$${Math.round(trade.final_pnl_amount).toLocaleString()}`}
              tone={trade.final_pnl_amount == null ? undefined : trade.final_pnl_amount >= 0 ? 'long' : 'short'} />
            <Stat label="R-multiple" value={r == null ? '—' : `${r >= 0 ? '+' : ''}${r}R`}
              tone={r == null ? undefined : r >= 0 ? 'long' : 'short'} />
            <Stat label="1R risked" value={trade.risk_amount == null ? '—' : `${trade.risk_amount} ${trade.risk_unit ?? ''}`} />
            <Stat label="MAE / MFE" value={
              `${excursionR(trade, legs, 'mae') ?? '—'}R / ${excursionR(trade, legs, 'mfe') ?? '—'}R`} />
            <Stat label="Exit efficiency" value={eff == null ? '—' : `${eff}%`}
              tone={eff == null ? undefined : eff >= 65 ? 'long' : eff < 55 ? 'short' : undefined} />
            <Stat label="Grade at entry" value={trade.grade_at_entry ?? '—'} />
            <Stat label="Conviction" value={trade.conviction == null ? '—' : `${trade.conviction}/5`} />
            <Stat label="Planned R:R" value={plannedRR(trade) == null ? '—' : `${plannedRR(trade)}`} />
            <Stat label="Stop / target" value={`${trade.current_stop ?? '—'} / ${trade.current_target ?? '—'}`} />
            <Stat label="Setup" value={trade.setup_name_snapshot ?? '—'} />
            <Stat label="Session" value={trade.session_label ?? trade.session_derived ?? '—'} />

            {trade.thesis && <Block label="Thesis" text={trade.thesis} />}
            {trade.invalidation_thesis && <Block label="Invalidated if" text={trade.invalidation_thesis} />}
            {trade.pre_trade_plan && <Block label="Pre-trade plan" text={trade.pre_trade_plan} />}
          </div>
        )}

        {tab === 'legs' && (
          <div className="stack">
            {legs.length === 0 && <div className="empty">No legs yet.</div>}
            {legs.map(l => (
              <div key={l.id} className="card">
                <div className="between">
                  <span className="mono">{l.action} {l.quantity} @ {l.price}</span>
                  <span className="hint mono">{fmtTime(l.executed_at)}</span>
                </div>
                <div className="hint">{fmtDate(l.executed_at)} · {l.leg_role}</div>
                {l.notes && <div style={{ marginTop: 8 }}>{l.notes}</div>}
              </div>
            ))}
          </div>
        )}

        {tab === 'timeline' && <Timeline tradeId={tradeId} />}

        {tab === 'charts' && (
          <MediaStrip key={String(attaching)}
            where={r => r.trade_id === tradeId}
            onAdd={() => setAttaching(true)} />
        )}

        {tab === 'review' && <Review trade={trade} onSaved={() => { load(); onUpdate() }} />}

        {history && <HistoryView rowId={tradeId} onClose={() => setHistory(false)} />}

        {attaching && (
          <AttachSheet link={{ trade_id: tradeId }}
            onClose={() => setAttaching(false)}
            onDone={() => { setAttaching(false); load() }} />
        )}
      </div>
    </Sheet>
  )
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: 'long' | 'short' }) {
  return (
    <div className="between" style={{ borderBottom: '1px solid var(--line)', paddingBottom: 8 }}>
      <span className="hint">{label}</span>
      <span className={`mono ${tone ?? ''}`} style={{ fontSize: 14 }}>{value}</span>
    </div>
  )
}

function Block({ label, text }: { label: string; text: string }) {
  return (
    <div>
      <h2>{label}</h2>
      <div style={{ whiteSpace: 'pre-wrap' }}>{text}</div>
    </div>
  )
}

function Review({ trade, onSaved }: { trade: Trade; onSaved: () => void }) {
  const [review, setReview] = useState(trade.post_trade_review ?? '')
  const [well, setWell] = useState(trade.what_went_well ?? '')
  const [wrong, setWrong] = useState(trade.what_went_wrong ?? '')
  const [lesson, setLesson] = useState(trade.lesson_learned ?? '')
  const [plan, setPlan] = useState<Adherence | null>(trade.followed_plan ?? null)
  const [pnl, setPnl] = useState(trade.final_pnl_amount?.toString() ?? '')
  const [mae, setMae] = useState(trade.mae_price?.toString() ?? '')
  const [mfe, setMfe] = useState(trade.mfe_price?.toString() ?? '')
  const [busy, setBusy] = useState(false)

  const num = (v: string) => (v.trim() === '' ? null : Number(v))

  async function save(markReviewed: boolean) {
    setBusy(true)
    await updateTrade(trade.id, {
      post_trade_review: review || null,
      what_went_well: well || null,
      what_went_wrong: wrong || null,
      lesson_learned: lesson || null,
      followed_plan: plan,
      final_pnl_amount: num(pnl),
      mae_price: num(mae),
      mfe_price: num(mfe),
      needs_review: !markReviewed,
      reviewed_at: markReviewed ? new Date().toISOString() : null,
    })
    setBusy(false)
    onSaved()
  }

  return (
    <div className="stack">
      <div className="row">
        <div style={{ flex: 1 }}><Field label="Final P/L ($)"><Num value={pnl} onChange={setPnl} /></Field></div>
      </div>
      <div className="row">
        <div style={{ flex: 1 }}><Field label="MAE price"><Num value={mae} onChange={setMae} /></Field></div>
        <div style={{ flex: 1 }}><Field label="MFE price"><Num value={mfe} onChange={setMfe} /></Field></div>
      </div>
      <Field label="Followed plan">
        <Choice value={plan} onChange={setPlan} options={[
          { v: 'yes' as Adherence, label: 'Yes' },
          { v: 'partially' as Adherence, label: 'Partly' },
          { v: 'no' as Adherence, label: 'No' },
        ]} />
      </Field>
      <Field label="Review"><Area value={review} onChange={setReview} rows={4} /></Field>
      <Field label="What went well"><Area value={well} onChange={setWell} rows={2} /></Field>
      <Field label="What went wrong"><Area value={wrong} onChange={setWrong} rows={2} /></Field>
      <Field label="Lesson"><Area value={lesson} onChange={setLesson} rows={2} /></Field>
      <button className="primary" disabled={busy} onClick={() => save(true)}>Save &amp; mark reviewed</button>
      <button className="ghost" disabled={busy} onClick={() => save(false)}>Save, still needs review</button>
    </div>
  )
}
