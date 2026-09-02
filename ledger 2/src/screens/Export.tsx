import { useEffect, useState } from 'react'
import { buildStatsPack, buildDeepDive, buildJSON, copyToClipboard, downloadText } from '../lib/export'
import { listTrades, type Trade } from '../lib/trades'
import { Field, Choice } from '../components/Form'
import { dryRun, importExport, type ImportReport } from '../lib/import'

/* ---------------------------------------------------------------------------
   Export.

   Clipboard first — that's the primary action on a phone. You filter to a set,
   tap Copy, and paste it into a chat.

   Profile A fits a full year in one paste. Profile B carries the writing for a
   filtered slice, always anchored to the full-record stats so the detail sits
   against everything rather than floating.
--------------------------------------------------------------------------- */

type Scope = 'all' | '30d' | '90d' | 'year'
type Kind = 'stats' | 'deep' | 'json'

export function ExportScreen() {
  const [kind, setKind] = useState<Kind>('stats')
  const [scope, setScope] = useState<Scope>('all')
  const [onlyLosses, setOnlyLosses] = useState(false)
  const [symbol, setSymbol] = useState<string | null>(null)
  const [symbols, setSymbols] = useState<string[]>([])
  const [preview, setPreview] = useState('')
  const [copied, setCopied] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    listTrades().then((ts: Trade[]) => {
      setSymbols([...new Set(ts.map(t => t.symbol_snapshot).filter(Boolean) as string[])])
    })
  }, [])

  function filter() {
    const now = Date.now()
    const days = scope === '30d' ? 30 : scope === '90d' ? 90 : scope === 'year' ? 365 : null
    return {
      from: days ? new Date(now - days * 86400000).toISOString() : null,
      symbols: symbol ? [symbol] : undefined,
      onlyLosses: onlyLosses || undefined,
    }
  }

  async function build() {
    setBusy(true); setCopied(false)
    const text = kind === 'json' ? await buildJSON()
      : kind === 'deep' ? await buildDeepDive(filter())
      : await buildStatsPack(filter())
    setPreview(text)
    setBusy(false)
    return text
  }

  async function copy() {
    const text = preview || await build()
    const ok = await copyToClipboard(text)
    setCopied(ok)
    if (!ok) downloadText(`ledger-${kind}-${new Date().toISOString().slice(0, 10)}.md`, text)
  }

  const kb = preview ? (new Blob([preview]).size / 1024).toFixed(1) : null

  return (
    <div className="screen stack-l">
      <div>
        <h1>Export for analysis</h1>
        <p className="hint">Copy, then paste into a chat and ask it what it sees.</p>
      </div>

      <div className="stack">
        <Field label="What">
          <Choice value={kind} onChange={v => { setKind(v); setPreview('') }} options={[
            { v: 'stats' as Kind, label: 'Stats' },
            { v: 'deep' as Kind, label: 'Deep dive' },
            { v: 'json' as Kind, label: 'Backup' },
          ]} />
        </Field>
        <div className="hint">
          {kind === 'stats' && 'Every trade, one line each, with all derived metrics precomputed. A full year fits in one paste.'}
          {kind === 'deep' && 'Full narrative — thesis, timeline, review, lessons — for the filtered slice, anchored to your full-record stats.'}
          {kind === 'json' && 'Lossless backup including soft-deleted rows. Save this somewhere outside the app once a month.'}
        </div>
      </div>

      {kind !== 'json' && (
        <div className="stack">
          <Field label="Period">
            <Choice value={scope} onChange={v => { setScope(v); setPreview('') }} options={[
              { v: '30d' as Scope, label: '30d' }, { v: '90d' as Scope, label: '90d' },
              { v: 'year' as Scope, label: '1y' }, { v: 'all' as Scope, label: 'All' },
            ]} />
          </Field>

          {symbols.length > 0 && (
            <Field label="Symbol">
              <div className="row" style={{ flexWrap: 'wrap' }}>
                <button onClick={() => { setSymbol(null); setPreview('') }}
                  style={{
                    flex: '0 0 auto', padding: '10px 14px',
                    borderColor: symbol === null ? 'var(--signal)' : 'var(--line)',
                    color: symbol === null ? 'var(--text)' : 'var(--muted)',
                  }}>All</button>
                {symbols.map(s => (
                  <button key={s} onClick={() => { setSymbol(s); setPreview('') }}
                    style={{
                      flex: '0 0 auto', padding: '10px 14px',
                      borderColor: symbol === s ? 'var(--signal)' : 'var(--line)',
                      color: symbol === s ? 'var(--text)' : 'var(--muted)',
                    }}>{s}</button>
                ))}
              </div>
            </Field>
          )}

          <button className="ghost" onClick={() => { setOnlyLosses(v => !v); setPreview('') }}
            style={{ borderColor: onlyLosses ? 'var(--short)' : 'var(--line)',
                     color: onlyLosses ? 'var(--short)' : 'var(--muted)' }}>
            {onlyLosses ? '✓ Losses only' : 'Losses only'}
          </button>
        </div>
      )}

      <div className="stack">
        <button className="primary" onClick={copy} disabled={busy}>
          {busy ? 'Building…' : copied ? '✓ Copied to clipboard' : 'Copy for analysis'}
        </button>
        <button className="ghost" onClick={build} disabled={busy}>Preview</button>
        {preview && (
          <button className="ghost" onClick={() =>
            downloadText(`ledger-${kind}-${new Date().toISOString().slice(0, 10)}.${kind === 'json' ? 'json' : 'md'}`, preview)}>
            Save as file
          </button>
        )}
      </div>

      {preview && (
        <div className="stack">
          <div className="between">
            <h2>Preview</h2>
            <span className="hint mono">{kb} KB</span>
          </div>
          <pre className="mono" style={{
            background: 'var(--surface)', border: '1px solid var(--line)',
            borderRadius: 'var(--r)', padding: 12, fontSize: 11,
            maxHeight: 360, overflow: 'auto', whiteSpace: 'pre-wrap',
          }}>{preview.slice(0, 4000)}{preview.length > 4000 ? '\n…' : ''}</pre>
        </div>
      )}

      <ImportPanel />

      <div className="banner">
        <strong>One thing worth knowing</strong>
        Pasting journal text into a chat sends it to that provider under their terms.
        Your call — but the app shouldn't imply a promise it isn't keeping.
      </div>
    </div>
  )
}

/* ---------------------------------------------------------------------------
   Restore.

   Deliberately two steps: check first, then write. The check reads the file
   and tells you exactly what would happen without touching anything, which is
   the only honest way to offer a restore button.
--------------------------------------------------------------------------- */

function ImportPanel() {
  const [report, setReport] = useState<ImportReport | null>(null)
  const [raw, setRaw] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState(false)

  async function pick(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    setBusy(true); setDone(false)
    const text = await file.text()
    setRaw(text)
    setReport(await dryRun(text, 'skip'))
    setBusy(false)
  }

  async function confirm() {
    if (!raw) return
    setBusy(true)
    setReport(await importExport(raw, 'skip'))
    setBusy(false)
    setDone(true)
  }

  return (
    <div className="stack">
      <h2>Restore from a backup</h2>

      <label className="ghost" style={{
        display: 'block', textAlign: 'center', padding: 12, cursor: 'pointer',
        border: '1px solid var(--line)', borderRadius: 'var(--r)', color: 'var(--muted)',
      }}>
        Choose a backup file…
        <input type="file" accept="application/json,.json" onChange={pick}
          style={{ display: 'none' }} />
      </label>

      {busy && <div className="hint">Reading…</div>}

      {report && (
        <div className="card stack">
          <pre className="mono" style={{
            fontSize: 11, whiteSpace: 'pre-wrap', margin: 0,
            color: report.ok ? 'var(--text)' : 'var(--short)',
          }}>{report.summary}</pre>

          {report.ok && !done && (
            <button className="primary" onClick={confirm} disabled={busy}>
              Restore these records
            </button>
          )}
          {done && <div className="long mono" style={{ fontSize: 13 }}>✓ Restored</div>}
        </div>
      )}

      <div className="hint">
        Restoring the same file twice is safe — records carry their own ids, so a
        second run finds them already there and changes nothing. That is what makes
        it safe to retry when you are not sure the first one worked.
      </div>
    </div>
  )
}
