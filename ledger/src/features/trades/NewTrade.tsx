import { useEffect, useState } from 'react'
import {
  createTrade, listInstruments, listSetups,
  type Instrument, type Setup, type Direction, type Grade,
} from '../../lib/trades'
import { Sheet, Field, Num, Text, Area, NYTime, Choice, useNow } from '../../components/Form'

/* ---------------------------------------------------------------------------
   New trade.

   Progressive: only the top section is required. A trade exists as a Draft the
   moment you type a symbol, so nothing is lost if you get interrupted.

   Target from cold open to saved: 15 seconds, one thumb.
--------------------------------------------------------------------------- */

export function NewTrade({ onDone, onCancel }: { onDone: (id: string) => void; onCancel: () => void }) {
  const [instruments, setInstruments] = useState<Instrument[]>([])
  const [setups, setSetups] = useState<Setup[]>([])
  const [symbol, setSymbol] = useState('')
  const [instrumentId, setInstrumentId] = useState<string | null>(null)
  const [direction, setDirection] = useState<Direction | null>(null)
  const [setupId, setSetupId] = useState<string | null>(null)
  const [setupName, setSetupName] = useState('')

  const [price, setPrice] = useState('')
  const [qty, setQty] = useState('')
  const [unit, setUnit] = useState('')
  const [at, setAt] = useNow()

  const [showPlan, setShowPlan] = useState(false)
  const [stop, setStop] = useState('')
  const [target, setTarget] = useState('')
  const [risk, setRisk] = useState('')
  const [riskUnit, setRiskUnit] = useState('$')
  const [grade, setGrade] = useState<Grade | null>(null)
  const [conviction, setConviction] = useState<number | null>(null)
  const [thesis, setThesis] = useState('')
  const [invalidation, setInvalidation] = useState('')

  const [busy, setBusy] = useState(false)

  useEffect(() => {
    listInstruments().then(setInstruments)
    listSetups().then(setSetups)
  }, [])

  const num = (v: string) => (v.trim() === '' ? null : Number(v))
  const canSave = symbol.trim() !== '' && direction != null

  async function save() {
    if (!canSave || busy) return
    setBusy(true)
    const hasEntry = num(price) != null && num(qty) != null
    const id = await createTrade({
      symbol: symbol.trim().toUpperCase(),
      instrument_id: instrumentId ?? undefined,
      direction: direction!,
      setup_id: setupId,
      setup_name: setupName || setups.find(s => s.id === setupId)?.name || null,
      asset_class: instruments.find(i => i.id === instrumentId)?.asset_class ?? null,
      entry: hasEntry
        ? { price: num(price)!, quantity: num(qty)!, unit: unit || undefined, executed_at: at }
        : undefined,
      plan: {
        planned_entry: num(price),
        planned_stop: num(stop),
        planned_target: num(target),
        risk_amount: num(risk),
        risk_unit: risk ? riskUnit : null,
        grade_at_entry: grade,
        conviction,
        thesis: thesis || null,
        invalidation_thesis: invalidation || null,
      },
    })
    onDone(id)
  }

  return (
    <Sheet title="New trade" onClose={onCancel} footer={
      <button className="primary" disabled={!canSave || busy} onClick={save}>
        {busy ? 'Saving…' : canSave ? 'Save trade' : 'Symbol and direction required'}
      </button>
    }>
      <div className="stack-l">
        <div className="stack">
          <h2>Essentials</h2>

          <Field label="Symbol">
            <div className="row" style={{ flexWrap: 'wrap' }}>
              {instruments.map(i => (
                <button key={i.id} type="button"
                  onClick={() => { setSymbol(i.symbol); setInstrumentId(i.id) }}
                  style={{
                    flex: '0 0 auto', padding: '10px 16px',
                    borderColor: symbol === i.symbol ? 'var(--signal)' : 'var(--line)',
                    color: symbol === i.symbol ? 'var(--text)' : 'var(--muted)',
                  }}>
                  {i.symbol}
                </button>
              ))}
            </div>
            <div style={{ marginTop: 8 }}>
              <Text value={symbol} onChange={(v: string) => { setSymbol(v); setInstrumentId(null) }}
                placeholder="or type any symbol" />
            </div>
          </Field>

          <Field label="Direction">
            <Choice value={direction} onChange={setDirection} options={[
              { v: 'long' as Direction, label: 'LONG', tone: 'long' },
              { v: 'short' as Direction, label: 'SHORT', tone: 'short' },
            ]} />
          </Field>

          <Field label="Setup">
            <div className="row" style={{ flexWrap: 'wrap' }}>
              {setups.map(s => (
                <button key={s.id} type="button"
                  onClick={() => { setSetupId(s.id); setSetupName(s.name) }}
                  style={{
                    flex: '0 0 auto', padding: '10px 14px', fontSize: 14,
                    borderColor: setupId === s.id ? 'var(--signal)' : 'var(--line)',
                    color: setupId === s.id ? 'var(--text)' : 'var(--muted)',
                  }}>
                  {s.name}
                </button>
              ))}
            </div>
            <div style={{ marginTop: 8 }}>
              <Text value={setupName} onChange={v => { setSetupName(v); setSetupId(null) }}
                placeholder="or name a new setup" />
            </div>
          </Field>
        </div>

        <div className="stack">
          <h2>First entry</h2>
          <div className="row">
            <div style={{ flex: 1 }}><Field label="Price"><Num value={price} onChange={setPrice} /></Field></div>
            <div style={{ flex: 1 }}><Field label="Quantity"><Num value={qty} onChange={setQty} /></Field></div>
          </div>
          <Field label="Unit"><Text value={unit} onChange={setUnit} placeholder="contracts, BTC, shares…" /></Field>
          <Field label="Time" hint="Defaults to now. Always editable.">
            <NYTime iso={at} onChange={setAt} />
          </Field>
          <div className="hint">Leave price blank to save as a draft and fill it in later.</div>
        </div>

        <div className="stack">
          <button className="ghost" onClick={() => setShowPlan(v => !v)}>
            {showPlan ? '− Hide plan' : '+ Add plan (optional)'}
          </button>

          {showPlan && (
            <div className="stack">
              <div className="row">
                <div style={{ flex: 1 }}><Field label="Stop"><Num value={stop} onChange={setStop} /></Field></div>
                <div style={{ flex: 1 }}><Field label="Target"><Num value={target} onChange={setTarget} /></Field></div>
              </div>

              <Field label="Risk (1R)" hint="The single number that makes an ES scalp comparable to a BTC swing.">
                <div className="row">
                  <div style={{ flex: 2 }}><Num value={risk} onChange={setRisk} placeholder="600" /></div>
                  <div style={{ flex: 1 }}>
                    <Choice value={riskUnit} onChange={setRiskUnit} options={[
                      { v: '$', label: '$' }, { v: '%', label: '%' },
                      { v: 'ticks', label: 'ticks' },
                    ]} />
                  </div>
                </div>
              </Field>

              <Field label="Grade at entry" hint="Graded before you know the outcome. That's the point.">
                <Choice value={grade} onChange={setGrade} options={[
                  { v: 'A' as Grade, label: 'A' }, { v: 'B' as Grade, label: 'B' }, { v: 'C' as Grade, label: 'C' },
                ]} />
              </Field>

              <Field label="Conviction">
                <div className="row">
                  {[1, 2, 3, 4, 5].map(n => (
                    <button key={n} type="button" onClick={() => setConviction(n)}
                      style={{
                        flex: 1,
                        borderColor: conviction === n ? 'var(--signal)' : 'var(--line)',
                        color: conviction === n ? 'var(--text)' : 'var(--muted)',
                      }}>{n}</button>
                  ))}
                </div>
              </Field>

              <Field label="Thesis"><Area value={thesis} onChange={setThesis} /></Field>
              <Field label="Invalidated if" hint="Not the stop price — the reason.">
                <Area value={invalidation} onChange={setInvalidation} rows={2} />
              </Field>
            </div>
          )}
        </div>
      </div>
    </Sheet>
  )
}
