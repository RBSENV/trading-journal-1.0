import { useState } from 'react'
import {
  addLeg, addEvent, moveLevel, closeTrade, updateTrade,
  type Trade, type EventType, type Adherence,
} from '../../lib/trades'
import { mutate } from '../../lib/sync'
import { Sheet, Field, Num, Area, NYTime, Choice, useNow } from '../../components/Form'

/* ---------------------------------------------------------------------------
   Quick update — the most-used screen in the app.
   Target: under eight seconds from tap to saved. Local write, sheet closes,
   no spinner, no waiting on the network.
--------------------------------------------------------------------------- */

type Action =
  | 'add' | 'partial' | 'close' | 'stop' | 'target'
  | 'note' | 'mistake' | 'thesis' | 'observation' | 'news'

const MENU: { a: Action; label: string; glyph: string }[] = [
  { a: 'add',         label: 'Add to position',    glyph: '＋' },
  { a: 'partial',     label: 'Partial exit',       glyph: '－' },
  { a: 'close',       label: 'Close out',          glyph: '✕' },
  { a: 'stop',        label: 'Move stop',          glyph: '🛡' },
  { a: 'target',      label: 'Move target',        glyph: '🎯' },
  { a: 'note',        label: 'Note',               glyph: '📝' },
  { a: 'mistake',     label: 'Mistake / rule break', glyph: '⚠️' },
  { a: 'thesis',      label: 'Thesis update',      glyph: '💡' },
  { a: 'observation', label: 'Market observation', glyph: '👁' },
  { a: 'news',        label: 'News event',         glyph: '📰' },
]

export function QuickUpdate({ trade, onDone, onClose }: {
  trade: Trade; onDone: () => void; onClose: () => void
}) {
  const [action, setAction] = useState<Action | null>(null)

  if (action === 'close') return <CloseOut trade={trade} onDone={onDone} onClose={() => setAction(null)} />
  if (action) return <UpdateForm trade={trade} action={action} onDone={onDone} onClose={() => setAction(null)} />

  return (
    <Sheet title={`${trade.symbol_snapshot} ${trade.direction}`} onClose={onClose}>
      <div className="stack">
        {MENU.map(m => (
          <button key={m.a} onClick={() => setAction(m.a)}
            style={{ justifyContent: 'flex-start', textAlign: 'left', display: 'flex', gap: 14, alignItems: 'center' }}>
            <span style={{ fontSize: 17, width: 24 }} aria-hidden>{m.glyph}</span>
            <span style={{ flex: 1 }}>{m.label}</span>
            {m.a === 'stop' && trade.current_stop != null &&
              <span className="mono hint">{trade.current_stop}</span>}
            {m.a === 'target' && trade.current_target != null &&
              <span className="mono hint">{trade.current_target}</span>}
          </button>
        ))}
      </div>
    </Sheet>
  )
}

const TITLES: Record<Action, string> = {
  add: 'Add to position', partial: 'Partial exit', close: 'Close out',
  stop: 'Move stop', target: 'Move target', note: 'Note',
  mistake: 'Mistake / rule break', thesis: 'Thesis update',
  observation: 'Market observation', news: 'News event',
}

const EVENT_OF: Partial<Record<Action, EventType>> = {
  note: 'note', mistake: 'mistake_or_rule_break', thesis: 'thesis_update',
  observation: 'market_observation', news: 'economic_news',
}

function UpdateForm({ trade, action, onDone, onClose }: {
  trade: Trade; action: Action; onDone: () => void; onClose: () => void
}) {
  const [price, setPrice] = useState('')
  const [qty, setQty] = useState('')
  const [text, setText] = useState('')
  const [at, setAt] = useNow()
  const [busy, setBusy] = useState(false)

  const needsPrice = action === 'add' || action === 'partial' || action === 'stop' || action === 'target'
  const needsQty = action === 'add' || action === 'partial'
  const num = (v: string) => (v.trim() === '' ? null : Number(v))
  const ok = (!needsPrice || num(price) != null) && (!needsQty || num(qty) != null)

  async function save() {
    if (!ok || busy) return
    setBusy(true)

    if (action === 'add' || action === 'partial') {
      const isAdd = action === 'add'
      await addLeg(trade.id, {
        action: isAdd ? (trade.direction === 'long' ? 'add' : 'add') : 'reduce',
        leg_role: isAdd ? 'scale_in' : 'partial_exit',
        price: num(price)!, quantity: num(qty)!,
        executed_at: at, notes: text || null,
      })
      await addEvent(trade.id, isAdd ? 'add_to_position' : 'partial_exit', at, {
        title: `${qty} @ ${price}`, description: text || null,
      })
      if (!isAdd) await updateTrade(trade.id, { status: 'partially_closed' })
    } else if (action === 'stop' || action === 'target') {
      await moveLevel(trade.id, action, num(price)!, at, text || undefined)
    } else {
      const type = EVENT_OF[action]!
      await addEvent(trade.id, type, at, { description: text || null })
      if (action === 'thesis' && text) await updateTrade(trade.id, { thesis: text })
      if (action === 'mistake' && text) {
        await mutate('trade_mistakes', crypto.randomUUID(), 'insert', {
          trade_id: trade.id, mistake_key: 'custom', note: text,
        })
      }
    }
    onDone()
  }

  return (
    <Sheet title={TITLES[action]} onClose={onClose} footer={
      <button className="primary" disabled={!ok || busy} onClick={save}>
        {busy ? 'Saving…' : 'Save'}
      </button>
    }>
      <div className="stack">
        {needsPrice && (
          <div className="row">
            <div style={{ flex: 1 }}><Field label="Price"><Num value={price} onChange={setPrice} /></Field></div>
            {needsQty && <div style={{ flex: 1 }}><Field label="Quantity"><Num value={qty} onChange={setQty} /></Field></div>}
          </div>
        )}
        <Field label={action === 'stop' || action === 'target' ? 'Reason' : 'Note'}>
          <Area value={text} onChange={setText} rows={action === 'note' || action === 'thesis' ? 5 : 3} />
        </Field>
        <Field label="Time"><NYTime iso={at} onChange={setAt} /></Field>
      </div>
    </Sheet>
  )
}

/* ---------------------------------------------------------------------------
   Close-out.

   Where the fields that make analysis possible get captured — while you still
   remember. MAE/MFE take thirty seconds off the chart and cannot be
   reconstructed later.

   "Close & review later" exists because you will sometimes be in the middle of
   another position. Forcing the full review is how journals get abandoned.
--------------------------------------------------------------------------- */

export function CloseOut({ trade, onDone, onClose }: {
  trade: Trade; onDone: () => void; onClose: () => void
}) {
  const [price, setPrice] = useState('')
  const [qty, setQty] = useState('')
  const [at, setAt] = useNow()
  const [pnl, setPnl] = useState('')
  const [pct, setPct] = useState('')
  const [mae, setMae] = useState('')
  const [mfe, setMfe] = useState('')
  const [plan, setPlan] = useState<Adherence | null>(null)
  const [lesson, setLesson] = useState('')
  const [busy, setBusy] = useState(false)

  const num = (v: string) => (v.trim() === '' ? null : Number(v))
  const r = num(pnl) != null && trade.risk_amount
    ? Math.round((num(pnl)! / Math.abs(trade.risk_amount)) * 100) / 100
    : null

  async function save(defer: boolean) {
    if (busy) return
    setBusy(true)
    await closeTrade(trade.id, {
      exit: num(price) != null && num(qty) != null
        ? { price: num(price)!, quantity: num(qty)!, executed_at: at }
        : undefined,
      final_pnl_amount: num(pnl),
      final_pnl_percent: num(pct),
      mae_price: num(mae),
      mfe_price: num(mfe),
      followed_plan: plan,
      lesson_learned: lesson || null,
      deferReview: defer,
    })
    onDone()
  }

  return (
    <Sheet title={`Close ${trade.symbol_snapshot} ${trade.direction}`} onClose={onClose} footer={
      <div className="stack">
        <button className="primary" disabled={busy} onClick={() => save(false)}>Close trade</button>
        <button className="ghost" disabled={busy} onClick={() => save(true)}>Close &amp; review later</button>
      </div>
    }>
      <div className="stack-l">
        <div className="stack">
          <h2>Final exit</h2>
          <div className="row">
            <div style={{ flex: 1 }}><Field label="Price"><Num value={price} onChange={setPrice} /></Field></div>
            <div style={{ flex: 1 }}><Field label="Quantity"><Num value={qty} onChange={setQty} /></Field></div>
          </div>
          <Field label="Time"><NYTime iso={at} onChange={setAt} /></Field>
        </div>

        <div className="stack">
          <h2>Result — you enter these</h2>
          <div className="row">
            <div style={{ flex: 1 }}><Field label="Final P/L ($)"><Num value={pnl} onChange={setPnl} /></Field></div>
            <div style={{ flex: 1 }}><Field label="Percent"><Num value={pct} onChange={setPct} /></Field></div>
          </div>
          {r != null && (
            <div className="hint mono">
              R-multiple <span className={r >= 0 ? 'long' : 'short'}>{r >= 0 ? '+' : ''}{r}R</span>
              {' '}· from 1R = {trade.risk_amount}
            </div>
          )}
          {r == null && (
            <div className="hint">No 1R recorded on this trade, so no R-multiple. Add one in the trade's plan to make it comparable across instruments.</div>
          )}
        </div>

        <div className="stack">
          <h2>Excursion — 30 seconds, worth it</h2>
          <div className="row">
            <div style={{ flex: 1 }}>
              <Field label="Worst price against" hint="MAE"><Num value={mae} onChange={setMae} /></Field>
            </div>
            <div style={{ flex: 1 }}>
              <Field label="Best price for" hint="MFE"><Num value={mfe} onChange={setMfe} /></Field>
            </div>
          </div>
          <div className="hint">
            Read these off the chart now. They answer "is my stop too tight?" and
            "am I leaving money on the table?" — and they cannot be reconstructed later.
          </div>
        </div>

        <div className="stack">
          <h2>Quick review</h2>
          <Field label="Followed plan">
            <Choice value={plan} onChange={setPlan} options={[
              { v: 'yes' as Adherence, label: 'Yes' },
              { v: 'partially' as Adherence, label: 'Partly' },
              { v: 'no' as Adherence, label: 'No' },
            ]} />
          </Field>
          <Field label="Lesson"><Area value={lesson} onChange={setLesson} /></Field>
        </div>
      </div>
    </Sheet>
  )
}
