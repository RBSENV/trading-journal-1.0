import { useState, type ReactNode } from 'react'
import { toNYParts, fromNYParts, nowNYParts } from '../lib/trades'

/* ---------------------------------------------------------------------------
   Form primitives.

   The NY datetime field is the one that matters. Every event time in this app
   is a claim you are making about when something happened — not a record of
   when you typed it — so it is always editable and always defaults to now.
   No Start button, no timer, ever.
--------------------------------------------------------------------------- */

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <div>
      <label>{label}</label>
      {children}
      {hint && <div className="hint" style={{ marginTop: 4 }}>{hint}</div>}
    </div>
  )
}

export function Num({ value, onChange, placeholder }: {
  value: string; onChange: (v: string) => void; placeholder?: string
}) {
  return (
    <input inputMode="decimal" value={value} placeholder={placeholder}
      onChange={e => onChange(e.target.value.replace(/[^\d.\-]/g, ''))} />
  )
}

export function Text({ value, onChange, placeholder }: {
  value: string; onChange: (v: string) => void; placeholder?: string
}) {
  return <input type="text" value={value} placeholder={placeholder}
    onChange={e => onChange(e.target.value)} />
}

export function Area({ value, onChange, placeholder, rows = 3 }: {
  value: string; onChange: (v: string) => void; placeholder?: string; rows?: number
}) {
  return (
    <textarea value={value} rows={rows} placeholder={placeholder}
      onChange={e => onChange(e.target.value)}
      style={{
        width: '100%', padding: '12px 14px', background: 'var(--ink)',
        border: '1px solid var(--line)', borderRadius: 'var(--r)',
        color: 'var(--text)', font: 'inherit', fontSize: 16, resize: 'vertical',
      }} />
  )
}

/** Editable New York timestamp. Split date/time so a phone keyboard behaves. */
export function NYTime({ iso, onChange }: { iso: string; onChange: (iso: string) => void }) {
  const p = toNYParts(iso)
  return (
    <div className="row">
      <input type="date" value={p.date} style={{ flex: 3 }}
        onChange={e => onChange(fromNYParts(e.target.value, p.time))} />
      <input type="time" value={p.time} style={{ flex: 2 }}
        onChange={e => onChange(fromNYParts(p.date, e.target.value))} />
      <span className="hint" style={{ flex: 'none' }}>ET</span>
    </div>
  )
}

export function useNow() {
  const [iso, setIso] = useState(() => {
    const p = nowNYParts()
    return fromNYParts(p.date, p.time)
  })
  return [iso, setIso] as const
}

export function Choice<T extends string>({ value, options, onChange }: {
  value: T | null
  options: readonly { v: T; label: string; tone?: 'long' | 'short' }[]
  onChange: (v: T) => void
}) {
  return (
    <div className="row" style={{ flexWrap: 'wrap' }}>
      {options.map(o => {
        const on = value === o.v
        return (
          <button key={o.v} type="button" onClick={() => onChange(o.v)}
            style={{
              flex: 1, minWidth: 72,
              borderColor: on
                ? o.tone === 'long' ? 'var(--long)' : o.tone === 'short' ? 'var(--short)' : 'var(--signal)'
                : 'var(--line)',
              color: on
                ? o.tone === 'long' ? 'var(--long)' : o.tone === 'short' ? 'var(--short)' : 'var(--text)'
                : 'var(--muted)',
              background: on ? 'var(--surface-2)' : 'transparent',
            }}>
            {o.label}
          </button>
        )
      })}
    </div>
  )
}

export function Sheet({ title, onClose, children, footer }: {
  title: string; onClose: () => void; children: ReactNode; footer?: ReactNode
}) {
  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 60, background: 'var(--ink)',
      display: 'flex', flexDirection: 'column',
      paddingTop: 'var(--safe-top)', paddingBottom: 'var(--safe-bottom)',
    }}>
      <div className="between" style={{
        padding: '12px 16px', borderBottom: '1px solid var(--line)', flex: 'none',
      }}>
        <button className="link" onClick={onClose}>Cancel</button>
        <strong style={{ fontSize: 15 }}>{title}</strong>
        <span style={{ width: 52 }} />
      </div>
      <div style={{ flex: 1, overflowY: 'auto', padding: 16 }}>{children}</div>
      {footer && (
        <div style={{ padding: 16, borderTop: '1px solid var(--line)', flex: 'none' }}>
          {footer}
        </div>
      )}
    </div>
  )
}
