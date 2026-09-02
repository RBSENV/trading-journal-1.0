import { useEffect, useState } from 'react'
import { mutate } from '../../lib/sync'
import { listRows, getRow } from '../../lib/db'
import { NY, fmtDate, listInstruments, type Instrument } from '../../lib/trades'
import { Field, Area, Text, Num, Choice } from '../../components/Form'
import { MediaStrip, AttachSheet } from '../media/Media'

/* ---------------------------------------------------------------------------
   Daily Preparation.

   One design decision worth naming: key levels are STRUCTURED ROWS, not a text
   blob. Same typing effort either way, but structured levels can later answer
   "how do I do when I enter at a level I marked pre-session?" — a question
   prose can never answer.

   Economic events and observations carry a `source` field set to 'manual'. A
   future API integration writes rows alongside yours rather than replacing
   them, so manual capture never stops working.
--------------------------------------------------------------------------- */

type Bias = 'bullish' | 'bearish' | 'neutral' | 'mixed'

interface Prep {
  id: string
  prep_date: string
  general_bias?: Bias | null
  general_bias_note?: string | null
  market_thesis?: string | null
  planned_setups?: string | null
  daily_plan?: string | null
  end_of_day_review?: string | null
  lessons?: string | null
  needs_review?: boolean
  deleted_at?: string | null
}

interface Level {
  id: string
  daily_prep_id: string
  instrument_id?: string | null
  level_type: string
  price: number
  label?: string | null
  note?: string | null
  sort_order: number
  deleted_at?: string | null
}

interface EconEvent {
  id: string
  daily_prep_id?: string | null
  name: string
  scheduled_at: string
  impact?: 'low' | 'medium' | 'high' | null
  reaction_note?: string | null
  deleted_at?: string | null
}

const LEVEL_TYPES = ['support', 'resistance', 'pivot', 'vwap', 'liquidity',
                     'open', 'high', 'low', 'invalidation', 'target'] as const

/** NY calendar date, which is what daily_preps keys on. */
function nyToday(): string {
  const f = new Intl.DateTimeFormat('en-CA', {
    timeZone: NY, year: 'numeric', month: '2-digit', day: '2-digit',
  })
  return f.format(new Date())
}

export function DailyPrepScreen() {
  const [date, setDate] = useState(nyToday())
  const [prep, setPrep] = useState<Prep | null>(null)
  const [levels, setLevels] = useState<Level[]>([])
  const [events, setEvents] = useState<EconEvent[]>([])
  const [instruments, setInstruments] = useState<Instrument[]>([])
  const [saving, setSaving] = useState(false)
  const [attaching, setAttaching] = useState(false)

  useEffect(() => { listInstruments().then(setInstruments) }, [])

  async function load() {
    const all = await listRows<Prep>('daily_preps', r => r.prep_date === date)
    const found = all[0] ?? null
    setPrep(found)
    if (found) {
      setLevels((await listRows<Level>('prep_levels', r => r.daily_prep_id === found.id))
        .sort((a, b) => a.sort_order - b.sort_order))
      setEvents((await listRows<EconEvent>('economic_events', r => r.daily_prep_id === found.id))
        .sort((a, b) => a.scheduled_at.localeCompare(b.scheduled_at)))
    } else {
      setLevels([]); setEvents([])
    }
  }
  useEffect(() => { load() }, [date])

  async function ensure(): Promise<string> {
    if (prep) return prep.id
    const id = crypto.randomUUID()
    await mutate('daily_preps', id, 'insert', { prep_date: date, needs_review: true })
    const fresh = await getRow<Prep>('daily_preps', id)
    setPrep(fresh ?? { id, prep_date: date })
    return id
  }

  async function patch(field: keyof Prep, value: unknown) {
    const id = await ensure()
    setSaving(true)
    await mutate('daily_preps', id, 'update', { [field]: value })
    setPrep(p => (p ? { ...p, [field]: value } as Prep : p))
    setSaving(false)
  }

  async function addLevel(l: Omit<Level, 'id' | 'daily_prep_id' | 'sort_order'>) {
    const pid = await ensure()
    const id = crypto.randomUUID()
    await mutate('prep_levels', id, 'insert', {
      ...l, daily_prep_id: pid, sort_order: levels.length,
    })
    load()
  }

  async function removeLevel(id: string) {
    await mutate('prep_levels', id, 'delete', {})
    load()
  }

  async function addEvent(name: string, timeHHMM: string, impact: string | null) {
    const pid = await ensure()
    const id = crypto.randomUUID()
    const [h, m] = timeHHMM.split(':').map(Number)
    const local = new Date(`${date}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00`)
    await mutate('economic_events', id, 'insert', {
      daily_prep_id: pid, name, scheduled_at: local.toISOString(),
      impact: impact || null, tz_label: NY, source: 'manual',
    })
    load()
  }

  const shift = (days: number) => {
    const d = new Date(`${date}T12:00:00Z`)
    d.setUTCDate(d.getUTCDate() + days)
    setDate(d.toISOString().slice(0, 10))
  }

  return (
    <div className="screen stack-l">
      <div className="between">
        <button className="ghost" onClick={() => shift(-1)} style={{ flex: 'none', padding: '10px 16px' }}>‹</button>
        <div style={{ textAlign: 'center' }}>
          <h1>{fmtDate(`${date}T12:00:00Z`)}</h1>
          <span className="hint mono">{saving ? 'saving…' : prep ? 'prep started' : 'not started'}</span>
        </div>
        <button className="ghost" onClick={() => shift(1)} style={{ flex: 'none', padding: '10px 16px' }}>›</button>
      </div>

      <div className="stack">
        <h2>Bias</h2>
        <Choice value={prep?.general_bias ?? null} onChange={(v: Bias) => patch('general_bias', v)}
          options={[
            { v: 'bullish' as Bias, label: 'Bull', tone: 'long' },
            { v: 'bearish' as Bias, label: 'Bear', tone: 'short' },
            { v: 'neutral' as Bias, label: 'Neutral' },
            { v: 'mixed' as Bias, label: 'Mixed' },
          ]} />
        <Area value={prep?.general_bias_note ?? ''} rows={2} placeholder="Why?"
          onChange={v => patch('general_bias_note', v)} />
      </div>

      <LevelsSection levels={levels} instruments={instruments}
        onAdd={addLevel} onRemove={removeLevel} />

      <EventsSection events={events} onAdd={addEvent} />

      {prep && (
        <MediaStrip key={`${prep.id}-${String(attaching)}`}
          where={r => r.daily_prep_id === prep.id}
          onAdd={() => setAttaching(true)} />
      )}

      {attaching && prep && (
        <AttachSheet link={{ daily_prep_id: prep.id }}
          onClose={() => setAttaching(false)}
          onDone={() => { setAttaching(false); load() }} />
      )}

      <div className="stack">
        <h2>Thesis &amp; plan</h2>
        <Field label="Market thesis">
          <Area value={prep?.market_thesis ?? ''} rows={4}
            onChange={v => patch('market_thesis', v)} />
        </Field>
        <Field label="Planned setups">
          <Area value={prep?.planned_setups ?? ''} rows={3}
            onChange={v => patch('planned_setups', v)} />
        </Field>
        <Field label="Daily plan">
          <Area value={prep?.daily_plan ?? ''} rows={3}
            onChange={v => patch('daily_plan', v)} />
        </Field>
      </div>

      <div className="stack">
        <h2>End of day</h2>
        <Field label="Review">
          <Area value={prep?.end_of_day_review ?? ''} rows={4}
            onChange={v => patch('end_of_day_review', v)} />
        </Field>
        <Field label="Lessons">
          <Area value={prep?.lessons ?? ''} rows={3}
            onChange={v => patch('lessons', v)} />
        </Field>
      </div>
    </div>
  )
}

function LevelsSection({ levels, instruments, onAdd, onRemove }: {
  levels: Level[]
  instruments: Instrument[]
  onAdd: (l: Omit<Level, 'id' | 'daily_prep_id' | 'sort_order'>) => void
  onRemove: (id: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [type, setType] = useState<string>('support')
  const [price, setPrice] = useState('')
  const [inst, setInst] = useState<string | null>(null)
  const [note, setNote] = useState('')

  function submit() {
    if (!price.trim()) return
    onAdd({ level_type: type, price: Number(price), instrument_id: inst, note: note || null, label: null })
    setPrice(''); setNote(''); setOpen(false)
  }

  return (
    <div className="stack">
      <div className="between">
        <h2>Key levels</h2>
        <button className="link" onClick={() => setOpen(o => !o)}>{open ? 'Cancel' : '+ Add'}</button>
      </div>

      {levels.length === 0 && !open && (
        <div className="card empty" style={{ padding: 20 }}>
          No levels marked.
          <div className="hint" style={{ marginTop: 6 }}>
            Marking them as rows lets you later ask how you do when you enter at a level you'd flagged.
          </div>
        </div>
      )}

      {levels.map(l => (
        <div key={l.id} className="card between" style={{ padding: 12 }}>
          <div>
            <span className="mono">{l.price}</span>
            <span className="hint" style={{ marginLeft: 8, fontSize: 13 }}>
              {l.level_type}
              {l.instrument_id && ` · ${instruments.find(i => i.id === l.instrument_id)?.symbol ?? ''}`}
            </span>
            {l.note && <div className="hint" style={{ marginTop: 4 }}>{l.note}</div>}
          </div>
          <button className="link" onClick={() => onRemove(l.id)}>Remove</button>
        </div>
      ))}

      {open && (
        <div className="card stack">
          <Field label="Instrument">
            <div className="row" style={{ flexWrap: 'wrap' }}>
              {instruments.map(i => (
                <button key={i.id} onClick={() => setInst(i.id)}
                  style={{
                    flex: '0 0 auto', padding: '8px 14px', fontSize: 14,
                    borderColor: inst === i.id ? 'var(--signal)' : 'var(--line)',
                    color: inst === i.id ? 'var(--text)' : 'var(--muted)',
                  }}>{i.symbol}</button>
              ))}
            </div>
          </Field>
          <Field label="Type">
            <div className="row" style={{ flexWrap: 'wrap' }}>
              {LEVEL_TYPES.map(t => (
                <button key={t} onClick={() => setType(t)}
                  style={{
                    flex: '0 0 auto', padding: '8px 12px', fontSize: 13,
                    borderColor: type === t ? 'var(--signal)' : 'var(--line)',
                    color: type === t ? 'var(--text)' : 'var(--muted)',
                  }}>{t}</button>
              ))}
            </div>
          </Field>
          <Field label="Price"><Num value={price} onChange={setPrice} /></Field>
          <Field label="Note"><Text value={note} onChange={setNote} placeholder="optional" /></Field>
          <button className="primary" onClick={submit} disabled={!price.trim()}>Add level</button>
        </div>
      )}
    </div>
  )
}

function EventsSection({ events, onAdd }: {
  events: EconEvent[]
  onAdd: (name: string, time: string, impact: string | null) => void
}) {
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [time, setTime] = useState('08:30')
  const [impact, setImpact] = useState<string | null>('high')

  return (
    <div className="stack">
      <div className="between">
        <h2>Economic events</h2>
        <button className="link" onClick={() => setOpen(o => !o)}>{open ? 'Cancel' : '+ Add'}</button>
      </div>

      {events.map(e => (
        <div key={e.id} className="card between" style={{ padding: 12 }}>
          <div>
            <span>{e.name}</span>
            {e.impact && <span className="hint" style={{ marginLeft: 8, fontSize: 12 }}>{e.impact}</span>}
          </div>
          <span className="hint mono" style={{ fontSize: 13 }}>
            {new Intl.DateTimeFormat('en-US', {
              timeZone: NY, hour: 'numeric', minute: '2-digit', hour12: true,
            }).format(new Date(e.scheduled_at))} ET
          </span>
        </div>
      ))}

      {open && (
        <div className="card stack">
          <Field label="Event"><Text value={name} onChange={setName} placeholder="CPI, FOMC, NFP…" /></Field>
          <Field label="Time (ET)">
            <input type="time" value={time} onChange={e => setTime(e.target.value)} />
          </Field>
          <Field label="Impact">
            <Choice value={impact} onChange={setImpact} options={[
              { v: 'low', label: 'Low' }, { v: 'medium', label: 'Med' }, { v: 'high', label: 'High' },
            ]} />
          </Field>
          <button className="primary" disabled={!name.trim()}
            onClick={() => { onAdd(name, time, impact); setName(''); setOpen(false) }}>
            Add event
          </button>
        </div>
      )}
    </div>
  )
}
