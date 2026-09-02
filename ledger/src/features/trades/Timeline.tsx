import { useEffect, useState } from 'react'
import {
  timelineFor, addEvent, editEvent, removeEvent,
  fmtTime, fmtDate,
  type TradeEvent, type EventType,
} from '../../lib/trades'
import { Sheet, Field, Area, Text, NYTime, useNow } from '../../components/Form'

/* ---------------------------------------------------------------------------
   Timeline.

   The point of this screen: your thinking laid out against the clock, so you
   can see what you knew and when you knew it. That contradiction between what
   you wrote at 12:47 and what you did at 12:58 is the finding — and it only
   exists if you were logging while the trade was live.

   Every entry's time is a claim you can revise. You will not always be able to
   write something down the moment it happens, and a time typed from memory an
   hour later is often wrong. Backdating is expected, not an edge case.
--------------------------------------------------------------------------- */

const TYPES: { v: EventType; label: string }[] = [
  { v: 'note', label: 'Note' },
  { v: 'market_observation', label: 'Market observation' },
  { v: 'thesis_update', label: 'Thesis update' },
  { v: 'mistake_or_rule_break', label: 'Mistake / rule break' },
  { v: 'economic_news', label: 'News event' },
  { v: 'coinglass_observation', label: 'CoinGlass' },
  { v: 'entry', label: 'Entry' },
  { v: 'add_to_position', label: 'Add to position' },
  { v: 'partial_exit', label: 'Partial exit' },
  { v: 'full_exit', label: 'Full exit' },
  { v: 'stop_moved', label: 'Stop moved' },
  { v: 'target_moved', label: 'Target moved' },
  { v: 'screenshot_added', label: 'Chart added' },
  { v: 'custom', label: 'Custom' },
]

const TONE: Partial<Record<EventType, string>> = {
  mistake_or_rule_break: 'var(--short)',
  stop_moved: 'var(--short)',
  entry: 'var(--long)',
  add_to_position: 'var(--long)',
  full_exit: 'var(--signal)',
  partial_exit: 'var(--signal)',
  economic_news: 'var(--signal)',
}

export function Timeline({ tradeId }: { tradeId: string }) {
  const [events, setEvents] = useState<TradeEvent[]>([])
  const [adding, setAdding] = useState(false)
  const [editing, setEditing] = useState<TradeEvent | null>(null)

  async function load() { setEvents(await timelineFor(tradeId)) }
  useEffect(() => { load() }, [tradeId])

  // Group by NY calendar day, so a trade held over a week still reads as a story.
  const days: { day: string; items: TradeEvent[] }[] = []
  for (const e of events) {
    const day = fmtDate(e.occurred_at)
    const last = days[days.length - 1]
    if (last && last.day === day) last.items.push(e)
    else days.push({ day, items: [e] })
  }

  return (
    <div className="stack-l">
      <div className="between">
        <span className="hint">{events.length} entries, oldest first</span>
        <button className="link" onClick={() => setAdding(true)}>+ Add entry</button>
      </div>

      {events.length === 0 && (
        <div className="card empty">
          Nothing logged yet.
          <div className="hint" style={{ marginTop: 6 }}>
            Notes written while a trade is live are worth more than any review
            you write that evening — you forget what you were thinking within hours.
          </div>
        </div>
      )}

      {days.map(({ day, items }) => (
        <div key={day} className="stack">
          {days.length > 1 && (
            <div className="hint mono" style={{
              fontSize: 11, letterSpacing: '0.08em', textTransform: 'uppercase',
            }}>{day}</div>
          )}
          {items.map(e => (
            <button key={e.id} onClick={() => setEditing(e)} style={{
              display: 'block', width: '100%', textAlign: 'left',
              background: 'none', border: 'none', borderRadius: 0,
              borderLeft: `2px solid ${TONE[e.event_type] ?? 'var(--line)'}`,
              padding: '2px 0 12px 14px', minHeight: 0,
            }}>
              <div className="between">
                <span className="mono" style={{ fontSize: 12, color: TONE[e.event_type] ?? 'var(--signal)' }}>
                  {e.event_type_custom || e.event_type.replace(/_/g, ' ')}
                </span>
                <span className="hint mono" style={{ fontSize: 12 }}>
                  {fmtTime(e.occurred_at)} ✎
                </span>
              </div>
              {e.title && <div style={{ fontSize: 14, marginTop: 2 }}>{e.title}</div>}
              {e.description && (
                <div className="hint" style={{ marginTop: 3, whiteSpace: 'pre-wrap', fontSize: 13 }}>
                  {e.description}
                </div>
              )}
            </button>
          ))}
        </div>
      ))}

      {adding && (
        <EntrySheet tradeId={tradeId} onClose={() => setAdding(false)}
          onDone={() => { setAdding(false); load() }} />
      )}
      {editing && (
        <EntrySheet tradeId={tradeId} existing={editing} onClose={() => setEditing(null)}
          onDone={() => { setEditing(null); load() }} />
      )}
    </div>
  )
}

function EntrySheet({ tradeId, existing, onDone, onClose }: {
  tradeId: string
  existing?: TradeEvent
  onDone: () => void
  onClose: () => void
}) {
  const [type, setType] = useState<EventType>(existing?.event_type ?? 'note')
  const [title, setTitle] = useState(existing?.title ?? '')
  const [body, setBody] = useState(existing?.description ?? '')
  const [nowIso] = useNow()
  const [at, setAt] = useState(existing?.occurred_at ?? nowIso)
  const [busy, setBusy] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)

  async function save() {
    if (busy) return
    setBusy(true)
    if (existing) {
      await editEvent(existing.id, {
        occurred_at: at, event_type: type,
        title: title || null, description: body || null,
      })
    } else {
      await addEvent(tradeId, type, at, {
        title: title || null, description: body || null,
      })
    }
    onDone()
  }

  async function drop() {
    setBusy(true)
    await removeEvent(existing!.id)
    onDone()
  }

  return (
    <Sheet title={existing ? 'Edit entry' : 'Add entry'} onClose={onClose} footer={
      <button className="primary" disabled={busy || (!body.trim() && !title.trim())} onClick={save}>
        {busy ? 'Saving…' : existing ? 'Save changes' : 'Add to timeline'}
      </button>
    }>
      <div className="stack-l">
        <Field label="Time" hint="Backdate it freely — this is when it happened, not when you typed it.">
          <NYTime iso={at} onChange={setAt} />
        </Field>

        <Field label="Type">
          <div className="row" style={{ flexWrap: 'wrap' }}>
            {TYPES.map(t => (
              <button key={t.v} onClick={() => setType(t.v)}
                style={{
                  flex: '0 0 auto', padding: '8px 12px', fontSize: 13,
                  borderColor: type === t.v ? (TONE[t.v] ?? 'var(--signal)') : 'var(--line)',
                  color: type === t.v ? (TONE[t.v] ?? 'var(--text)') : 'var(--muted)',
                }}>{t.label}</button>
            ))}
          </div>
        </Field>

        <Field label="Headline" hint="Optional. Shown in bold on the timeline.">
          <Text value={title} onChange={setTitle} placeholder="e.g. not moving, no sellers" />
        </Field>

        <Field label="What you're thinking">
          <Area value={body} onChange={setBody} rows={6}
            placeholder="Write it the way you'd say it. This is the part that gets read back later." />
        </Field>

        {existing && (
          <div className="stack">
            {!confirmDelete
              ? <button className="ghost" onClick={() => setConfirmDelete(true)}>Delete this entry</button>
              : <>
                  <div className="hint">
                    It moves to the trash and stays restorable. Nothing here is deleted for real.
                  </div>
                  <div className="row">
                    <button className="ghost" style={{ flex: 1 }}
                      onClick={() => setConfirmDelete(false)}>Keep it</button>
                    <button style={{ flex: 1, borderColor: 'var(--short)', color: 'var(--short)' }}
                      onClick={drop} disabled={busy}>Delete</button>
                  </div>
                </>}
            <div className="hint">
              Every change is recorded — what it said before, what it says now, and when
              you changed it. The record of your edits is itself part of the record.
            </div>
          </div>
        )}
      </div>
    </Sheet>
  )
}
