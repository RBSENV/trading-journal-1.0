import { useEffect, useState } from 'react'
import {
  createTrade, addLeg, addEvent, moveLevel, closeTrade, updateTrade,
  legsFor, eventsFor, getTrade, listInstruments, listSetups,
  avgEntry, openQuantity, realizedR, excursionR, exitEfficiency, checkConsistency,
  fmtTime, fmtDate, fmtDuration,
  type Trade, type TradeLeg, type TradeEvent, type Direction,
  type Instrument, type Setup, type Grade, type EventType,
} from '../lib/trades'
import { Sheet, NYTimeField, NumField, num, nowISO, Money, RMultiple, Empty } from './ui'

/* ---------------------------------------------------------------------------
   New trade.

   Only symbol and direction are required. Everything else can arrive later,
   because the fastest way to lose a trade record is to demand fifteen fields
   while the position is moving.
--------------------------------------------------------------------------- */

export function NewTrade({ open, onClose, onCreated }: {
  open: boolean; onClose: () => void; onCreated: (id: string) => void
}) {
  const [instruments, setInstruments] = useState<Instrument[]>([])
  const [setups, setSetups] = useState<Setup[]>([])
  const [symbol, setSymbol] = useState('')
  const [instrumentId, setInstrumentId] = useState<string>('')
  const [direction, setDirection] = useState<Direction>('long')
  const [setupId, setSetupId] = useState('')
  const [price, setPrice] = useState('')
  const [qty, setQty] = useState('')
  const [unit, setUnit] = useState('')
  const [at, setAt] = useState(nowISO())
  const [showPlan, setShowPlan] = useState(false)
  const [stop, setStop] = useState('')
  const [target, setTarget] = useState('')
  const [risk, setRisk] = useState('')
  const [riskUnit, setRiskUnit] = useState('$')
  const [grade, setGrade] = useState<Grade | ''>('')
  const [conviction, setConviction] = useState(0)
  const [thesis, setThesis] = useState('')
  const [invalidation, setInvalidation] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!open) return
    void listInstruments().then(setInstruments)
    void listSetups().then(setSetups)
    setAt(nowISO())
  }, [open])

  async function save() {
    if (!symbol) return
    setBusy(true)
    const p = num(price), q = num(qty)
    const id = await createTrade({
      instrument_id: instrumentId || undefined,
      symbol,
      direction,
      setup_id: setupId || null,
      setup_name: setups.find(s => s.id === setupId)?.name ?? null,
      asset_class: instruments.find(i => i.id === instrumentId)?.asset_class ?? null,
      entry: p != null && q != null ? { price: p, quantity: q, unit: unit || undefined, executed_at: at } : undefined,
      plan: {
        planned_stop: num(stop),
        planned_target: num(target),
        risk_amount: num(risk),
        risk_unit: riskUnit,
        grade_at_entry: grade || null,
        conviction: conviction || null,
        thesis: thesis || null,
        invalidation_thesis: invalidation || null,
      },
    })
    setBusy(false)
    reset()
    onCreated(id)
  }

  function reset() {
    setSymbol(''); setInstrumentId(''); setSetupId('')
    setPrice(''); setQty(''); setUnit('')
    setStop(''); setTarget(''); setRisk('')
    setGrade(''); setConviction(0); setThesis(''); setInvalidation('')
    setShowPlan(false)
  }

  return (
    <Sheet open={open} title="New trade" onClose={onClose}>
      <div className="stack-l">
        <div className="stack">
          <h2>Essentials</h2>
          <div>
            <label>Symbol</label>
            <select value={instrumentId} onChange={e => {
              setInstrumentId(e.target.value)
              setSymbol(instruments.find(i => i.id === e.target.value)?.symbol ?? '')
            }}>
              <option value="">Choose…</option>
              {instruments.map(i => <option key={i.id} value={i.id}>{i.symbol}</option>)}
            </select>
          </div>

          <div>
            <label>Direction</label>
            <div className="seg">
              <button className={direction === 'long' ? 'on long' : ''} onClick={() => setDirection('long')}>LONG</button>
              <button className={direction === 'short' ? 'on short' : ''} onClick={() => setDirection('short')}>SHORT</button>
            </div>
          </div>

          <div>
            <label>Setup <span className="hint">· optional</span></label>
            <select value={setupId} onChange={e => setSetupId(e.target.value)}>
              <option value="">None</option>
              {setups.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </div>
        </div>

        <div className="stack">
          <h2>First entry <span className="hint">· optional — saves as a draft without it</span></h2>
          <div className="row">
            <NumField label="Price" value={price} onChange={setPrice} />
            <NumField label="Quantity" value={qty} onChange={setQty} />
          </div>
          <div>
            <label>Unit <span className="hint">· contracts, BTC, shares…</span></label>
            <input type="text" value={unit} onChange={e => setUnit(e.target.value)} />
          </div>
          <NYTimeField value={at} onChange={setAt} />
        </div>

        <div className="stack">
          <button className="ghost" onClick={() => setShowPlan(v => !v)}>
            {showPlan ? '− Hide plan' : '+ Add plan'} <span className="hint">stop, risk, grade, thesis</span>
          </button>

          {showPlan && (
            <div className="stack">
              <div className="row">
                <NumField label="Stop" value={stop} onChange={setStop} />
                <NumField label="Target" value={target} onChange={setTarget} />
              </div>
              <div className="row">
                <NumField label="Risk (1R)" value={risk} onChange={setRisk} />
                <div style={{ width: 100 }}>
                  <label>Unit</label>
                  <select value={riskUnit} onChange={e => setRiskUnit(e.target.value)}>
                    <option>$</option><option>%</option><option>ticks</option><option>pts</option>
                  </select>
                </div>
              </div>
              <p className="hint" style={{ margin: 0 }}>
                Risk is what makes results comparable across NQ and BTC. Skip it and there's no R column later.
              </p>

              <div>
                <label>Grade at entry <span className="hint">· before you know the outcome</span></label>
                <div className="seg">
                  {(['A', 'B', 'C'] as Grade[]).map(g => (
                    <button key={g} className={grade === g ? 'on' : ''}
                      onClick={() => setGrade(grade === g ? '' : g)}>{g}</button>
                  ))}
                </div>
              </div>

              <div>
                <label>Conviction</label>
                <div className="seg">
                  {[1, 2, 3, 4, 5].map(n => (
                    <button key={n} className={conviction === n ? 'on' : ''}
                      onClick={() => setConviction(conviction === n ? 0 : n)}>{n}</button>
                  ))}
                </div>
              </div>

              <div>
                <label>Thesis</label>
                <textarea rows={3} value={thesis} onChange={e => setThesis(e.target.value)} />
              </div>
              <div>
                <label>Invalidated if <span className="hint">· why you'd be wrong, not the stop price</span></label>
                <textarea rows={2} value={invalidation} onChange={e => setInvalidation(e.target.value)} />
              </div>
            </div>
          )}
        </div>

        <button className="primary" disabled={busy || !symbol} onClick={save}>
          {busy ? 'Saving…' : 'Save trade'}
        </button>
      </div>
    </Sheet>
  )
}

/* ---------------------------------------------------------------------------
   Quick update — the most-used screen. Target: under eight seconds.
--------------------------------------------------------------------------- */

type QuickAction =
  | 'add' | 'partial' | 'close' | 'stop' | 'target'
  | 'note' | 'mistake' | 'thesis' | 'news' | 'observation'

const ACTIONS: Array<{ key: QuickAction; label: string; glyph: string }> = [
  { key: 'add',        label: 'Add to position', glyph: '＋' },
  { key: 'partial',    label: 'Partial exit',    glyph: '－' },
  { key: 'close',      label: 'Close out',       glyph: '✕' },
  { key: 'stop',       label: 'Move stop',       glyph: '⛊' },
  { key: 'target',     label: 'Move target',     glyph: '◎' },
  { key: 'note',       label: 'Note',            glyph: '✎' },
  { key: 'mistake',    label: 'Mistake',         glyph: '⚠' },
  { key: 'thesis',     label: 'Thesis update',   glyph: '💡' },
  { key: 'news',       label: 'News event',      glyph: '📰' },
  { key: 'observation',label: 'Observation',     glyph: '👁' },
]

export function QuickUpdate({ trade, open, onClose, onDone }: {
  trade: Trade | null; open: boolean; onClose: () => void; onDone: () => void
}) {
  const [action, setAction] = useState<QuickAction | null>(null)
  const [at, setAt] = useState(nowISO())
  const [price, setPrice] = useState('')
  const [qty, setQty] = useState('')
  const [text, setText] = useState('')

  useEffect(() => {
    if (open) { setAction(null); setAt(nowISO()); setPrice(''); setQty(''); setText('') }
  }, [open])

  if (!trade) return null

  async function commit() {
    if (!trade || !action) return
    switch (action) {
      case 'add':
      case 'partial': {
        const p = num(price), q = num(qty)
        if (p == null || q == null) return
        await addLeg(trade.id, {
          action: action === 'add'
            ? (trade.direction === 'long' ? 'buy' : 'short')
            : (trade.direction === 'long' ? 'sell' : 'cover'),
          leg_role: action === 'add' ? 'scale_in' : 'partial_exit',
          price: p, quantity: q, executed_at: at, notes: text || null,
        })
        break
      }
      case 'stop':
      case 'target': {
        const p = num(price)
        if (p == null) return
        await moveLevel(trade.id, action === 'stop' ? 'stop' : 'target', p, at, text || undefined)
        break
      }
      default: {
        const map: Record<string, EventType> = {
          note: 'note', mistake: 'mistake_or_rule_break', thesis: 'thesis_update',
          news: 'economic_news', observation: 'market_observation',
        }
        await addEvent(trade.id, map[action] ?? 'note', at, {
          description: text || null,
          importance: action === 'mistake' ? 'high' : 'normal',
        })
      }
    }
    onDone()
    onClose()
  }

  const label = ACTIONS.find(a => a.key === action)?.label ?? 'Update'
  const needsPrice = action === 'add' || action === 'partial' || action === 'stop' || action === 'target'
  const needsQty = action === 'add' || action === 'partial'

  return (
    <Sheet open={open} title={action ? label : `${trade.symbol_snapshot} · update`} onClose={onClose}>
      {!action ? (
        <div className="action-grid">
          {ACTIONS.map(a => (
            <button key={a.key} onClick={() => {
              if (a.key === 'close') { onClose(); onDone(); window.dispatchEvent(new CustomEvent('ledger:close-trade', { detail: trade.id })); return }
              setAction(a.key)
            }}>
              <span className="glyph">{a.glyph}</span>{a.label}
            </button>
          ))}
        </div>
      ) : (
        <div className="stack-l">
          {needsPrice && (
            <div className="row">
              <NumField label="Price" value={price} onChange={setPrice} />
              {needsQty && <NumField label="Quantity" value={qty} onChange={setQty} />}
            </div>
          )}
          <NYTimeField value={at} onChange={setAt} />
          <div>
            <label>{needsPrice ? 'Note' : 'Description'} {!needsPrice && <span className="hint">· write freely</span>}</label>
            <textarea rows={needsPrice ? 2 : 5} value={text} onChange={e => setText(e.target.value)} autoFocus={!needsPrice} />
          </div>
          <button className="primary" onClick={commit}>Save</button>
          <button className="link" onClick={() => setAction(null)}>← Different action</button>
        </div>
      )}
    </Sheet>
  )
}

/* ---------------------------------------------------------------------------
   Close out.

   MAE and MFE live here because this is the only moment you'll ever have the
   chart in front of you. Thirty seconds now buys the exit-efficiency number
   that no amount of later effort can reconstruct.
--------------------------------------------------------------------------- */

export function CloseOut({ trade, open, onClose, onDone }: {
  trade: Trade | null; open: boolean; onClose: () => void; onDone: () => void
}) {
  const [legs, setLegs] = useState<TradeLeg[]>([])
  const [price, setPrice] = useState('')
  const [qty, setQty] = useState('')
  const [at, setAt] = useState(nowISO())
  const [pnl, setPnl] = useState('')
  const [pct, setPct] = useState('')
  const [mae, setMae] = useState('')
  const [mfe, setMfe] = useState('')
  const [plan, setPlan] = useState<'yes' | 'no' | 'partially' | ''>('')
  const [lesson, setLesson] = useState('')

  useEffect(() => {
    if (!open || !trade) return
    setAt(nowISO()); setPrice(''); setPnl(''); setPct(''); setMae(''); setMfe(''); setPlan(''); setLesson('')
    void legsFor(trade.id).then(l => { setLegs(l); setQty(String(openQuantity(l))) })
  }, [open, trade])

  if (!trade) return null

  const preview: Trade = {
    ...trade,
    final_pnl_amount: num(pnl),
    mae_price: num(mae),
    mfe_price: num(mfe),
    realized_r: null,
    exit_efficiency: null,
  }
  const r = realizedR(preview)
  const eff = exitEfficiency(preview, legs)
  const maeR = excursionR(preview, legs, 'mae')
  const mfeR = excursionR(preview, legs, 'mfe')
  const warnings = checkConsistency(preview, legs)

  async function commit(defer: boolean) {
    if (!trade) return
    const p = num(price), q = num(qty)
    await closeTrade(trade.id, {
      exit: p != null && q != null ? { price: p, quantity: q, executed_at: at } : undefined,
      final_pnl_amount: num(pnl),
      final_pnl_percent: num(pct),
      mae_price: num(mae),
      mfe_price: num(mfe),
      followed_plan: plan || null,
      lesson_learned: lesson || null,
      deferReview: defer,
    })
    onDone(); onClose()
  }

  return (
    <Sheet open={open} title={`Close ${trade.symbol_snapshot}`} onClose={onClose}>
      <div className="stack-l">
        <div className="stack">
          <h2>Final exit</h2>
          <div className="row">
            <NumField label="Price" value={price} onChange={setPrice} />
            <NumField label="Quantity" value={qty} onChange={setQty} />
          </div>
          <NYTimeField value={at} onChange={setAt} />
        </div>

        <div className="stack">
          <h2>Result <span className="hint">· you enter these</span></h2>
          <div className="row">
            <NumField label="Final P/L" value={pnl} onChange={setPnl} suffix="$" />
            <NumField label="Percent" value={pct} onChange={setPct} suffix="%" />
          </div>
          {r != null && (
            <div className="derived">
              R-multiple <RMultiple value={r} />
              {trade.risk_amount ? <span className="hint"> from 1R = {trade.risk_amount}</span> : null}
            </div>
          )}
        </div>

        <div className="stack">
          <h2>Excursion <span className="hint">· 30 seconds off the chart</span></h2>
          <div className="row">
            <NumField label="Worst against you" value={mae} onChange={setMae} suffix="MAE" />
            <NumField label="Best in your favour" value={mfe} onChange={setMfe} suffix="MFE" />
          </div>
          {(maeR != null || mfeR != null || eff != null) && (
            <div className="derived">
              {maeR != null && <>MAE <span className="num">{maeR.toFixed(2)}R</span> · </>}
              {mfeR != null && <>MFE <span className="num">{mfeR.toFixed(2)}R</span> · </>}
              {eff != null && (
                <>efficiency <span className={`num ${eff >= 60 ? 'long' : 'short'}`}>{eff}%</span>
                  {eff < 60 && <span className="hint"> — leaving money on the table</span>}</>
              )}
            </div>
          )}
        </div>

        {warnings.length > 0 && (
          <div className="banner warn">
            <strong>These numbers don't line up</strong>
            {warnings.map((w, i) => <div key={i} style={{ marginTop: 4 }}>{w}</div>)}
            <div className="hint" style={{ marginTop: 6 }}>
              Saved either way — worth a second look while the chart is still open.
            </div>
          </div>
        )}

        <div className="stack">
          <h2>Quick review</h2>
          <div>
            <label>Followed plan</label>
            <div className="seg">
              {(['yes', 'partially', 'no'] as const).map(v => (
                <button key={v} className={plan === v ? 'on' : ''}
                  onClick={() => setPlan(plan === v ? '' : v)}>
                  {v === 'partially' ? 'Partly' : v[0]!.toUpperCase() + v.slice(1)}
                </button>
              ))}
            </div>
          </div>
          <div>
            <label>Lesson</label>
            <textarea rows={3} value={lesson} onChange={e => setLesson(e.target.value)} />
          </div>
        </div>

        <button className="primary" onClick={() => commit(false)}>Close trade</button>
        <button className="ghost" onClick={() => commit(true)}>Close &amp; review later</button>
      </div>
    </Sheet>
  )
}

/* ---------------------------------------------------------------------------
   Trade detail — timeline first, because that's where the evidence is.
--------------------------------------------------------------------------- */

const EVENT_LABEL: Record<string, string> = {
  trade_created: 'Created', entry: 'Entry', add_to_position: 'Added',
  partial_exit: 'Partial exit', full_exit: 'Exit', stop_moved: 'Stop moved',
  target_moved: 'Target moved', thesis_update: 'Thesis', market_observation: 'Observation',
  economic_news: 'News', coinglass_observation: 'CoinGlass', screenshot_added: 'Screenshot',
  note: 'Note', mistake_or_rule_break: 'Mistake', custom: 'Event',
}

export function TradeDetail({ tradeId, onBack, onUpdate }: {
  tradeId: string; onBack: () => void; onUpdate: () => void
}) {
  const [trade, setTrade] = useState<Trade | null>(null)
  const [legs, setLegs] = useState<TradeLeg[]>([])
  const [events, setEvents] = useState<TradeEvent[]>([])
  const [tab, setTab] = useState<'timeline' | 'legs' | 'review'>('timeline')
  const [quick, setQuick] = useState(false)
  const [closing, setClosing] = useState(false)

  async function load() {
    const t = await getTrade(tradeId)
    setTrade(t ?? null)
    setLegs(await legsFor(tradeId))
    setEvents(await eventsFor(tradeId))
  }
  useEffect(() => { void load() }, [tradeId])

  if (!trade) return <div className="screen"><Empty>Loading…</Empty></div>

  const entry = avgEntry(legs)
  const remaining = openQuantity(legs)
  const r = realizedR(trade)
  const eff = exitEfficiency(trade, legs)
  const isOpen = trade.status === 'open' || trade.status === 'partially_closed'

  return (
    <div className="screen stack-l">
      <div className="between">
        <button className="link" onClick={onBack}>← Back</button>
        <span className="hint num">#{trade.trade_number ?? '—'}</span>
      </div>

      <div>
        <h1>
          <span className={trade.direction === 'long' ? 'long' : 'short'}>
            {trade.symbol_snapshot} {trade.direction?.toUpperCase()}
          </span>
        </h1>
        <div className="hint num">
          {trade.status.replace('_', ' ')}
          {trade.opened_at && <> · {fmtDate(trade.opened_at)} {fmtTime(trade.opened_at)}</>}
          {trade.opened_at && <> · {fmtDuration(trade.opened_at, trade.closed_at)}</>}
        </div>
      </div>

      <div className="stat-row">
        <div><span className="hint">Entry</span><span className="num">{entry ?? '—'}</span></div>
        <div><span className="hint">Stop</span><span className="num">{trade.current_stop ?? '—'}</span></div>
        <div><span className="hint">Target</span><span className="num">{trade.current_target ?? '—'}</span></div>
        <div><span className="hint">{isOpen ? 'Open qty' : 'P/L'}</span>
          {isOpen ? <span className="num">{remaining}</span> : <Money value={trade.final_pnl_amount} />}</div>
      </div>

      {(r != null || eff != null) && (
        <div className="derived">
          {r != null && <>Result <RMultiple value={r} /></>}
          {eff != null && <> · efficiency <span className={`num ${eff >= 60 ? 'long' : 'short'}`}>{eff}%</span></>}
        </div>
      )}

      {isOpen && (
        <div className="row">
          <button className="primary" onClick={() => setQuick(true)}>+ Update</button>
          <button onClick={() => setClosing(true)}>Close out</button>
        </div>
      )}

      <div className="seg">
        {(['timeline', 'legs', 'review'] as const).map(t => (
          <button key={t} className={tab === t ? 'on' : ''} onClick={() => setTab(t)}>
            {t[0]!.toUpperCase() + t.slice(1)}
          </button>
        ))}
      </div>

      {tab === 'timeline' && (
        events.length === 0 ? <Empty>No events yet.</Empty> : (
          <div className="timeline">
            {events.map(e => (
              <div key={e.id} className="tl-row" data-important={e.importance === 'high'}>
                <span className="tl-time num">{fmtTime(e.occurred_at)}</span>
                <span className="tl-dot" />
                <div className="tl-body">
                  <strong>{EVENT_LABEL[e.event_type] ?? e.event_type}</strong>
                  {e.title && <span className="num"> {e.title}</span>}
                  {e.description && <div className="tl-desc">{e.description}</div>}
                  <div className="hint" style={{ fontSize: 11 }}>{fmtDate(e.occurred_at)}</div>
                </div>
              </div>
            ))}
          </div>
        )
      )}

      {tab === 'legs' && (
        legs.length === 0 ? <Empty>No legs yet.</Empty> : (
          <div className="card stack" style={{ gap: 8 }}>
            {legs.map(l => (
              <div key={l.id} className="between">
                <span className="num">{l.action} {l.quantity} @ {l.price}</span>
                <span className="hint num">{fmtTime(l.executed_at)}</span>
              </div>
            ))}
          </div>
        )
      )}

      {tab === 'review' && (
        <ReviewTab trade={trade} onSaved={() => { void load(); onUpdate() }} />
      )}

      <QuickUpdate trade={trade} open={quick} onClose={() => setQuick(false)}
        onDone={() => { void load(); onUpdate() }} />
      <CloseOut trade={trade} open={closing} onClose={() => setClosing(false)}
        onDone={() => { void load(); onUpdate() }} />
    </div>
  )
}

function ReviewTab({ trade, onSaved }: { trade: Trade; onSaved: () => void }) {
  const [well, setWell] = useState(trade.what_went_well ?? '')
  const [wrong, setWrong] = useState(trade.what_went_wrong ?? '')
  const [lesson, setLesson] = useState(trade.lesson_learned ?? '')
  const [review, setReview] = useState(trade.post_trade_review ?? '')
  const [saved, setSaved] = useState(false)

  async function save() {
    await updateTrade(trade.id, {
      what_went_well: well || null,
      what_went_wrong: wrong || null,
      lesson_learned: lesson || null,
      post_trade_review: review || null,
      needs_review: false,
      reviewed_at: new Date().toISOString(),
    })
    setSaved(true)
    onSaved()
  }

  return (
    <div className="stack">
      {trade.thesis && (
        <div className="card">
          <h2>Thesis</h2>
          <p style={{ margin: 0 }}>{trade.thesis}</p>
        </div>
      )}
      <div><label>Review</label><textarea rows={4} value={review} onChange={e => setReview(e.target.value)} /></div>
      <div><label>What went well</label><textarea rows={2} value={well} onChange={e => setWell(e.target.value)} /></div>
      <div><label>What went wrong</label><textarea rows={2} value={wrong} onChange={e => setWrong(e.target.value)} /></div>
      <div><label>Lesson</label><textarea rows={2} value={lesson} onChange={e => setLesson(e.target.value)} /></div>
      <button className="primary" onClick={save}>{saved ? 'Saved' : 'Save review'}</button>
    </div>
  )
}
