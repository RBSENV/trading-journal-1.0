import { useEffect, useState, type ReactNode } from 'react'
import { subscribe, type SyncStatus } from '../lib/sync'
import { toNYParts, fromNYParts, nowNYParts } from '../lib/trades'

/* ---------------------------------------------------------------------------
   Sync chip — always on screen, always honest.
--------------------------------------------------------------------------- */

const LABEL: Record<string, string> = {
  local: 'Saved locally', syncing: 'Syncing', synced: 'Synced',
  offline: 'Offline', error: 'Sync error', attention: 'Needs attention',
}

export function SyncChip({ onOpen }: { onOpen?: () => void }) {
  const [s, setS] = useState<SyncStatus | null>(null)
  useEffect(() => subscribe(setS), [])
  if (!s) return null

  const n = s.state === 'attention' ? s.conflicts : s.pending
  return (
    <button className="chip" data-state={s.state} aria-live="polite" onClick={onOpen}>
      <span className="dot" />
      {LABEL[s.state]}{n > 0 && ` · ${n}`}
    </button>
  )
}

/* ---------------------------------------------------------------------------
   Sheet — slides from the bottom, thumb-reachable, keeps its draft if
   dismissed by accident.
--------------------------------------------------------------------------- */

export function Sheet({ open, title, onClose, children }: {
  open: boolean; title: string; onClose: () => void; children: ReactNode
}) {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    document.body.style.overflow = 'hidden'
    return () => { window.removeEventListener('keydown', onKey); document.body.style.overflow = '' }
  }, [open, onClose])

  if (!open) return null
  return (
    <div className="sheet-scrim" onClick={onClose}>
      <div className="sheet" role="dialog" aria-label={title} onClick={e => e.stopPropagation()}>
        <div className="sheet-grab" />
        <div className="sheet-head">
          <button className="link" onClick={onClose}>Cancel</button>
          <strong>{title}</strong>
          <span style={{ width: 52 }} />
        </div>
        <div className="sheet-body">{children}</div>
      </div>
    </div>
  )
}

/* ---------------------------------------------------------------------------
   NY time field.

   Defaults to now, always editable, never a timer. The label says ET because
   an unlabelled time is the kind of thing you misread six months later.
--------------------------------------------------------------------------- */

export function NYTimeField({ value, onChange, label = 'Time' }: {
  value: string; onChange: (iso: string) => void; label?: string
}) {
  const parts = toNYParts(value)
  return (
    <div>
      <label>{label} <span className="hint">· New York</span></label>
      <div className="row">
        <input type="date" value={parts.date} className="num"
          onChange={e => onChange(fromNYParts(e.target.value, parts.time))} />
        <input type="time" value={parts.time} className="num" style={{ maxWidth: 130 }}
          onChange={e => onChange(fromNYParts(parts.date, e.target.value))} />
      </div>
    </div>
  )
}

export function nowISO() {
  const p = nowNYParts()
  return fromNYParts(p.date, p.time)
}

/* ---------------------------------------------------------------------------
   Number field — decimal keypad on iOS, monospace so digits don't jitter.
--------------------------------------------------------------------------- */

export function NumField({ label, value, onChange, placeholder, suffix }: {
  label: string
  value: string
  onChange: (v: string) => void
  placeholder?: string
  suffix?: string
}) {
  return (
    <div style={{ flex: 1 }}>
      <label>{label}</label>
      <div className="row" style={{ gap: 6 }}>
        <input inputMode="decimal" value={value} placeholder={placeholder}
          onChange={e => onChange(e.target.value.replace(/[^0-9.\-+]/g, ''))} />
        {suffix && <span className="hint" style={{ whiteSpace: 'nowrap' }}>{suffix}</span>}
      </div>
    </div>
  )
}

export const num = (s: string): number | null => {
  if (s.trim() === '') return null
  const n = Number(s)
  return Number.isFinite(n) ? n : null
}

/* --- small display helpers ---------------------------------------------- */

export function Money({ value }: { value?: number | null }) {
  if (value == null) return <span className="hint">—</span>
  const cls = value > 0 ? 'long' : value < 0 ? 'short' : ''
  return <span className={`num ${cls}`}>{value > 0 ? '+' : ''}{value.toLocaleString()}</span>
}

export function RMultiple({ value }: { value?: number | null }) {
  if (value == null) return <span className="hint">—</span>
  const cls = value > 0 ? 'long' : value < 0 ? 'short' : ''
  return <span className={`num ${cls}`}>{value > 0 ? '+' : ''}{value.toFixed(2)}R</span>
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="card empty">{children}</div>
}
