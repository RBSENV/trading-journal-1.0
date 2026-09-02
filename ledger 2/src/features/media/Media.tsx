import { useEffect, useRef, useState } from 'react'
import {
  attach, attachLink, attachmentsFor, displayUrl, removeAttachment,
  ACCEPT, STAGES, TIMEFRAMES,
  type Attachment, type Stage, type Timeframe,
} from '../../lib/media'
import { fmtTime } from '../../lib/trades'
import { Sheet, Field, Text, Area, NYTime, useNow } from '../../components/Form'

/* ---------------------------------------------------------------------------
   Media.

   The context note is doing more work here than it looks like. You cannot paste
   forty screenshots into a chat, so that field is what carries the visual
   information into an analysis as text. "Range looks clean but volume is half
   the morning, which I didn't check" gets read. A picture does not.
--------------------------------------------------------------------------- */

export function MediaStrip({ where, onAdd }: {
  where: (r: Record<string, unknown>) => boolean
  onAdd: () => void
}) {
  const [items, setItems] = useState<Attachment[]>([])
  const [viewing, setViewing] = useState<Attachment | null>(null)

  async function load() { setItems(await attachmentsFor(where)) }
  useEffect(() => { load() }, [])

  return (
    <div className="stack">
      <div className="between">
        <h2>Charts &amp; screenshots</h2>
        <button className="link" onClick={onAdd}>+ Add</button>
      </div>

      {items.length === 0 && (
        <div className="card empty" style={{ padding: 20 }}>
          Nothing attached.
          <div className="hint" style={{ marginTop: 6 }}>
            A before-entry chart is the one most often missing later.
          </div>
        </div>
      )}

      {items.length > 0 && (
        <div style={{ display: 'flex', gap: 10, overflowX: 'auto', paddingBottom: 4 }}>
          {items.map(a => <Thumb key={a.id} a={a} onOpen={() => setViewing(a)} />)}
        </div>
      )}

      {viewing && (
        <Viewer a={viewing} onClose={() => setViewing(null)}
          onRemoved={() => { setViewing(null); load() }} />
      )}
    </div>
  )
}

function Thumb({ a, onOpen }: { a: Attachment; onOpen: () => void }) {
  const [url, setUrl] = useState<string | null>(null)

  useEffect(() => {
    let dead = false
    displayUrl(a).then(u => { if (!dead) setUrl(u) })
    return () => { dead = true; if (url) URL.revokeObjectURL(url) }
  }, [a.id])

  const pending = a.upload_status !== 'uploaded'
  const failed = a.upload_status === 'failed'

  return (
    <button onClick={onOpen} style={{
      flex: '0 0 auto', width: 104, height: 132, padding: 0, overflow: 'hidden',
      position: 'relative', background: 'var(--surface)',
      borderColor: failed ? 'var(--short)' : 'var(--line)',
      display: 'block',
    }}>
      {a.kind === 'chart_link'
        ? <div style={{ padding: 10, fontSize: 11, color: 'var(--signal)', textAlign: 'left' }}>
            🔗 chart link
          </div>
        : url
          ? <img src={url} alt={a.caption ?? ''} style={{
              width: '100%', height: 90, objectFit: 'cover', display: 'block',
            }} />
          : <div style={{ height: 90, display: 'grid', placeItems: 'center', color: 'var(--faint)' }}>…</div>}

      <div style={{ padding: '5px 6px', fontSize: 10, textAlign: 'left', lineHeight: 1.3 }}>
        <div className="mono" style={{ color: 'var(--muted)' }}>
          {a.timeframe ?? ''} {a.stage ? STAGES.find(s => s.v === a.stage)?.label ?? '' : ''}
        </div>
        {pending && (
          <div className="mono" style={{ color: failed ? 'var(--short)' : 'var(--signal)' }}>
            {failed ? 'failed' : 'saved locally'}
          </div>
        )}
      </div>
    </button>
  )
}

function Viewer({ a, onClose, onRemoved }: {
  a: Attachment; onClose: () => void; onRemoved: () => void
}) {
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => { displayUrl(a).then(setUrl) }, [a.id])

  return (
    <Sheet title={a.caption || 'Attachment'} onClose={onClose}>
      <div className="stack-l">
        {a.kind === 'chart_link'
          ? <a href={a.url ?? '#'} target="_blank" rel="noreferrer"
              className="card" style={{ display: 'block', color: 'var(--signal)', wordBreak: 'break-all' }}>
              {a.url}
            </a>
          : url
            ? <img src={url} alt={a.caption ?? ''} style={{
                width: '100%', borderRadius: 'var(--r)', border: '1px solid var(--line)',
              }} />
            : <div className="card empty">
                Not downloaded yet.
                <div className="hint" style={{ marginTop: 6 }}>
                  It's safe in the cloud — get online to view it here.
                </div>
              </div>}

        <div className="card stack">
          <Row k="Stage" v={STAGES.find(s => s.v === a.stage)?.label ?? '—'} />
          <Row k="Timeframe" v={a.timeframe ?? '—'} />
          <Row k="Captured" v={`${fmtTime(a.captured_at)} ET`} />
          <Row k="Status" v={a.upload_status} />
          {a.byte_size && <Row k="Size" v={`${(a.byte_size / 1024).toFixed(0)} KB`} />}
          {a.width && <Row k="Dimensions" v={`${a.width} × ${a.height}`} />}
        </div>

        {a.context_note && (
          <div>
            <h2>Context</h2>
            <div style={{ whiteSpace: 'pre-wrap' }}>{a.context_note}</div>
          </div>
        )}

        {a.last_upload_error && <div className="error">{a.last_upload_error}</div>}

        <button className="ghost" onClick={async () => { await removeAttachment(a.id); onRemoved() }}>
          Move to trash
        </button>
        <div className="hint">Nothing is deleted for real — it stays restorable.</div>
      </div>
    </Sheet>
  )
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="between" style={{ fontSize: 13 }}>
      <span className="hint">{k}</span>
      <span className="mono">{v}</span>
    </div>
  )
}

/* --- picker --------------------------------------------------------------- */

export function AttachSheet({ link, onDone, onClose }: {
  link: { trade_id?: string; daily_prep_id?: string }
  onDone: () => void
  onClose: () => void
}) {
  const [file, setFile] = useState<File | null>(null)
  const [preview, setPreview] = useState<string | null>(null)
  const [url, setUrl] = useState('')
  const [stage, setStage] = useState<Stage>(link.daily_prep_id ? 'daily_prep' : 'before_entry')
  const [tf, setTf] = useState<Timeframe>('5m')
  const [caption, setCaption] = useState('')
  const [note, setNote] = useState('')
  const [at, setAt] = useNow()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  function choose(f: File | null) {
    if (!f) return
    setFile(f)
    setPreview(URL.createObjectURL(f))
    setError(null)
  }

  // Paste straight from the clipboard — the fastest path on a Mac.
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const item = [...(e.clipboardData?.items ?? [])].find(i => i.type.startsWith('image/'))
      if (item) choose(item.getAsFile())
    }
    window.addEventListener('paste', onPaste)
    return () => window.removeEventListener('paste', onPaste)
  }, [])

  async function save() {
    setBusy(true); setError(null)
    try {
      if (file) {
        await attach(file, { ...link, stage, timeframe: tf, caption, context_note: note, captured_at: at })
      } else if (url.trim()) {
        await attachLink(url.trim(), { ...link, stage, timeframe: tf, caption, context_note: note })
      }
      onDone()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setBusy(false)
    }
  }

  const ready = file != null || url.trim() !== ''

  return (
    <Sheet title="Add chart" onClose={onClose} footer={
      <button className="primary" disabled={!ready || busy} onClick={save}>
        {busy ? 'Saving…' : 'Attach'}
      </button>
    }>
      <div className="stack-l">
        {preview && (
          <img src={preview} alt="" style={{
            width: '100%', borderRadius: 'var(--r)', border: '1px solid var(--line)',
          }} />
        )}

        <div className="stack">
          {/* accept deliberately omits image/heic — see lib/media.ts */}
          <input ref={fileRef} type="file" accept={ACCEPT} style={{ display: 'none' }}
            onChange={e => choose(e.target.files?.[0] ?? null)} />
          <button className="ghost" onClick={() => fileRef.current?.click()}>
            {file ? `✓ ${file.name || 'Image selected'}` : 'Choose from Photos or Files'}
          </button>
          <div className="hint">You can also paste an image straight from the clipboard.</div>
        </div>

        <Field label="Or a TradingView link">
          <Text value={url} onChange={setUrl} placeholder="https://www.tradingview.com/x/…" />
        </Field>

        <Field label="Stage">
          <div className="row" style={{ flexWrap: 'wrap' }}>
            {STAGES.map(s => (
              <button key={s.v} onClick={() => setStage(s.v)}
                style={{
                  flex: '0 0 auto', padding: '8px 12px', fontSize: 13,
                  borderColor: stage === s.v ? 'var(--signal)' : 'var(--line)',
                  color: stage === s.v ? 'var(--text)' : 'var(--muted)',
                }}>{s.label}</button>
            ))}
          </div>
        </Field>

        <Field label="Timeframe">
          <div className="row" style={{ flexWrap: 'wrap' }}>
            {TIMEFRAMES.map(t => (
              <button key={t} onClick={() => setTf(t)}
                style={{
                  flex: '0 0 auto', padding: '8px 12px', fontSize: 13,
                  borderColor: tf === t ? 'var(--signal)' : 'var(--line)',
                  color: tf === t ? 'var(--text)' : 'var(--muted)',
                }}>{t}</button>
            ))}
          </div>
        </Field>

        <Field label="Caption"><Text value={caption} onChange={setCaption} /></Field>

        <Field label="Context"
          hint="This is what carries the chart into an analysis — you can't paste forty images into a chat, but this gets read.">
          <Area value={note} onChange={setNote} rows={4}
            placeholder="What does this show, and what did you miss at the time?" />
        </Field>

        <Field label="Captured" hint="iOS often strips the original time, so this defaults to now.">
          <NYTime iso={at} onChange={setAt} />
        </Field>

        {error && <div className="error">{error}</div>}
      </div>
    </Sheet>
  )
}
