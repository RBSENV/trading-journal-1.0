import { useEffect, useState } from 'react'
import { generateKeypair, decrypt, type Keypair } from '../lib/crypto'
import { dryRun, importExport, type ImportReport } from '../lib/import'
import { buildJSON, downloadText, copyToClipboard } from '../lib/export'
import { Field, Area } from '../components/Form'

/* ---------------------------------------------------------------------------
   Backup & restore.

   Decryption happens HERE, in your browser, using a key you paste in and that
   never leaves the page. That is deliberate: a backup you need a command line
   and a toolchain to open is a backup you will never actually restore from,
   which makes it decorative.
--------------------------------------------------------------------------- */

interface Status {
  ok: boolean
  key?: string
  bytes?: number
  counts?: Record<string, number>
  verified_at?: string
  failed_at?: string
  error?: string
}

export function BackupScreen() {
  const [status, setStatus] = useState<Status | null>(null)
  const [checked, setChecked] = useState(false)
  const workerUrl = import.meta.env.VITE_BACKUP_WORKER_URL

  useEffect(() => {
    if (!workerUrl) { setChecked(true); return }
    fetch(`${workerUrl}/status`)
      .then(r => r.json())
      .then(setStatus)
      .catch(() => setStatus({ ok: false, error: 'Could not reach the backup worker.' }))
      .finally(() => setChecked(true))
  }, [workerUrl])

  const stale = status?.verified_at
    ? Date.now() - new Date(status.verified_at).getTime() > 36 * 3600_000
    : false

  return (
    <div className="screen stack-l">
      <h1>Backup</h1>

      {/* --- nightly status ------------------------------------------------ */}
      <div className="stack">
        <h2>Nightly backup</h2>
        {!workerUrl && (
          <div className="banner warn">
            <strong>Not set up yet</strong>
            Nothing is backing you up automatically. Your data is still in the database
            and still exports by hand — but there is no second copy anywhere.
          </div>
        )}
        {workerUrl && !checked && <div className="hint">Checking…</div>}
        {status && (
          <div className={`banner${status.ok && !stale ? '' : ' warn'}`}>
            <strong>
              {!status.ok ? 'Last backup FAILED'
                : stale ? 'No backup in over a day'
                : 'Backed up and verified'}
            </strong>
            {status.error ?? (status.verified_at
              ? `${new Date(status.verified_at).toLocaleString()} · ${((status.bytes ?? 0) / 1024).toFixed(0)} KB · read back and hash-checked`
              : '')}
          </div>
        )}
        {status?.counts && (
          <div className="card">
            <div className="hint" style={{ marginBottom: 8 }}>Rows in the last snapshot</div>
            {Object.entries(status.counts).filter(([, n]) => n > 0).map(([t, n]) => (
              <div key={t} className="between" style={{ fontSize: 13 }}>
                <span className="hint">{t}</span><span className="mono">{n}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      <KeyGen />
      <ManualExport />
      <DecryptRestore />
    </div>
  )
}

/* --- key generation ------------------------------------------------------- */

function KeyGen() {
  const [kp, setKp] = useState<Keypair | null>(null)
  const [copied, setCopied] = useState<string | null>(null)
  const [ack, setAck] = useState(false)

  async function gen() { setKp(await generateKeypair()); setAck(false) }

  return (
    <div className="stack">
      <h2>Backup key</h2>
      {!kp && (
        <>
          <p className="hint">
            Generates a pair. The <strong>public</strong> half goes into the backup worker —
            it can lock backups but not open them. The <strong>private</strong> half is the
            only thing that can read them back, and it never leaves this page.
          </p>
          <button className="ghost" onClick={gen}>Generate a key pair</button>
        </>
      )}

      {kp && (
        <div className="stack">
          <div className="banner warn">
            <strong>Save the private key before you leave this screen</strong>
            It is shown once. Lose it and every encrypted backup becomes permanently
            unreadable — by you, by me, by anyone. Nobody can reset it. That is the
            same property that makes it worth having.
          </div>

          <Field label="Public key — goes in the worker, safe to paste anywhere">
            <Area value={kp.publicKey} rows={3} onChange={() => {}} />
          </Field>
          <button className="ghost" onClick={async () => {
            await copyToClipboard(kp.publicKey); setCopied('pub')
          }}>{copied === 'pub' ? '✓ Copied' : 'Copy public key'}</button>

          <Field label="Private key — password manager AND on paper. Nowhere else.">
            <Area value={kp.privateKey} rows={4} onChange={() => {}} />
          </Field>
          <div className="row">
            <button className="ghost" style={{ flex: 1 }} onClick={async () => {
              await copyToClipboard(kp.privateKey); setCopied('priv')
            }}>{copied === 'priv' ? '✓ Copied' : 'Copy private key'}</button>
            <button className="ghost" style={{ flex: 1 }} onClick={() =>
              downloadText('ledger-private-key.txt', kp.privateKey)}>Save as file</button>
          </div>

          <button className="ghost" onClick={() => setAck(a => !a)}
            style={{ borderColor: ack ? 'var(--long)' : 'var(--line)',
                     color: ack ? 'var(--long)' : 'var(--muted)' }}>
            {ack ? '✓ Saved in two places' : 'I have saved it in two places'}
          </button>

          {ack && (
            <button className="primary" onClick={() => setKp(null)}>Done — clear from screen</button>
          )}
        </div>
      )}
    </div>
  )
}

/* --- manual export -------------------------------------------------------- */

function ManualExport() {
  const [busy, setBusy] = useState(false)

  async function save() {
    setBusy(true)
    const json = await buildJSON()
    downloadText(`ledger-backup-${new Date().toISOString().slice(0, 10)}.json`, json)
    setBusy(false)
  }

  return (
    <div className="stack">
      <h2>Manual backup</h2>
      <p className="hint">
        Unencrypted, straight to your own disk. Your nightly backups live at Cloudflare;
        this is the copy that sits outside every vendor, which is the whole reason
        to bother. Once a month.
      </p>
      <button className="ghost" onClick={save} disabled={busy}>
        {busy ? 'Building…' : 'Save a backup file now'}
      </button>
    </div>
  )
}

/* --- decrypt and restore -------------------------------------------------- */

function DecryptRestore() {
  const [privKey, setPrivKey] = useState('')
  const [plain, setPlain] = useState<string | null>(null)
  const [report, setReport] = useState<ImportReport | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState(false)

  async function pick(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    setBusy(true); setError(null); setReport(null); setDone(false)
    try {
      let text: string
      if (file.name.endsWith('.enc')) {
        if (!privKey.trim()) throw new Error('Paste your private key first — this file is encrypted.')
        const bytes = new Uint8Array(await file.arrayBuffer())
        text = await decrypt(bytes, privKey.trim())
      } else {
        text = await file.text()
      }
      setPlain(text)
      setReport(await dryRun(text, 'skip'))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
    setBusy(false)
  }

  async function confirm() {
    if (!plain) return
    setBusy(true)
    setReport(await importExport(plain, 'skip'))
    setBusy(false)
    setDone(true)
  }

  return (
    <div className="stack">
      <h2>Restore from a backup</h2>

      <Field label="Private key" hint="Only needed for .enc files. Never leaves this page.">
        <Area value={privKey} rows={3} onChange={setPrivKey} placeholder="ledger-sk-…" />
      </Field>

      <label style={{
        display: 'block', textAlign: 'center', padding: 12, cursor: 'pointer',
        border: '1px solid var(--line)', borderRadius: 'var(--r)', color: 'var(--muted)',
      }}>
        Choose a backup file (.enc or .json)…
        <input type="file" accept=".enc,.json,application/json"
          onChange={pick} style={{ display: 'none' }} />
      </label>

      {busy && <div className="hint">Working…</div>}
      {error && <div className="error">{error}</div>}

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
        The file is checked before anything is written, and running the same file
        twice changes nothing the second time — records carry their own ids. That
        is what makes it safe to retry when you are not sure the first one worked.
      </div>
    </div>
  )
}
