import { useEffect, useState } from 'react'
import { supabase } from '../../lib/supabase'

/* ---------------------------------------------------------------------------
   Sign in
--------------------------------------------------------------------------- */

export function SignIn({ onDone }: { onDone: () => void }) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit() {
    setBusy(true); setError(null)
    const { error } = await supabase.auth.signInWithPassword({ email, password })
    setBusy(false)
    if (error) { setError(error.message); return }
    onDone()
  }

  return (
    <div className="center">
      <div className="stack-l" style={{ width: '100%', maxWidth: 360 }}>
        <div>
          <h1>Ledger</h1>
          <p className="hint">Private trading journal</p>
        </div>

        <div className="stack">
          <div>
            <label htmlFor="email">Email</label>
            <input id="email" type="email" value={email} autoComplete="username"
              autoCapitalize="none" onChange={e => setEmail(e.target.value)} />
          </div>
          <div>
            <label htmlFor="pw">Password</label>
            <input id="pw" type="password" value={password} autoComplete="current-password"
              onChange={e => setPassword(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && submit()} />
          </div>

          {error && <div className="error">{error}</div>}

          <button className="primary" onClick={submit} disabled={busy || !email || !password}>
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
        </div>
      </div>
    </div>
  )
}

/* ---------------------------------------------------------------------------
   MFA challenge — shown when TOTP is enrolled but this session is not verified
--------------------------------------------------------------------------- */

export function MfaChallenge({ factorId, onDone }: { factorId: string; onDone: () => void }) {
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function verify() {
    setBusy(true); setError(null)
    const { data: ch, error: chErr } = await supabase.auth.mfa.challenge({ factorId })
    if (chErr || !ch) { setBusy(false); setError(chErr?.message ?? 'Could not start verification'); return }

    const { error } = await supabase.auth.mfa.verify({ factorId, challengeId: ch.id, code })
    setBusy(false)
    if (error) { setError('That code was not accepted. Codes expire after 30 seconds — try the next one.'); return }
    onDone()
  }

  return (
    <div className="center">
      <div className="stack-l" style={{ width: '100%', maxWidth: 360 }}>
        <div>
          <h1>Verification code</h1>
          <p className="hint">Enter the six-digit code from your authenticator app.</p>
        </div>

        <div className="stack">
          <input inputMode="numeric" autoComplete="one-time-code" maxLength={6}
            value={code} placeholder="000000"
            style={{ fontSize: 26, textAlign: 'center', letterSpacing: '0.3em' }}
            onChange={e => setCode(e.target.value.replace(/\D/g, ''))}
            onKeyDown={e => e.key === 'Enter' && code.length === 6 && verify()} />

          {error && <div className="error">{error}</div>}

          <button className="primary" onClick={verify} disabled={busy || code.length !== 6}>
            {busy ? 'Checking…' : 'Verify'}
          </button>
          <button className="link" onClick={() => supabase.auth.signOut()}>Sign out</button>
        </div>
      </div>
    </div>
  )
}

/* ---------------------------------------------------------------------------
   TOTP enrollment — required, not optional.
   A private journal with a password as its only lock is one leaked password
   away from being someone else's.
--------------------------------------------------------------------------- */

export function MfaEnroll({ onDone }: { onDone: () => void }) {
  const [qr, setQr] = useState<string | null>(null)
  const [secret, setSecret] = useState<string | null>(null)
  const [factorId, setFactorId] = useState<string | null>(null)
  const [code, setCode] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      // Clear any half-finished factor from an abandoned attempt.
      const { data: list } = await supabase.auth.mfa.listFactors()
      for (const f of list?.all ?? []) {
        if (f.status === 'unverified') await supabase.auth.mfa.unenroll({ factorId: f.id })
      }

      const { data, error } = await supabase.auth.mfa.enroll({
        factorType: 'totp', friendlyName: 'Ledger',
      })
      if (cancelled) return
      if (error || !data) { setError(error?.message ?? 'Could not start setup'); return }
      setQr(data.totp.qr_code)
      setSecret(data.totp.secret)
      setFactorId(data.id)
    })()
    return () => { cancelled = true }
  }, [])

  async function confirm() {
    if (!factorId) return
    setBusy(true); setError(null)
    const { data: ch, error: chErr } = await supabase.auth.mfa.challenge({ factorId })
    if (chErr || !ch) { setBusy(false); setError(chErr?.message ?? 'Could not start verification'); return }

    const { error } = await supabase.auth.mfa.verify({ factorId, challengeId: ch.id, code })
    setBusy(false)
    if (error) { setError('That code was not accepted. Try the next one your app shows.'); return }
    onDone()
  }

  return (
    <div className="center">
      <div className="stack-l" style={{ width: '100%', maxWidth: 380 }}>
        <div>
          <h1>Set up two-factor</h1>
          <p className="hint">
            Scan this with an authenticator app. This is required — it is the only
            thing standing between a leaked password and your entire journal.
          </p>
        </div>

        {qr && (
          <div className="card" style={{ display: 'grid', placeItems: 'center', background: '#fff' }}>
            <img src={qr} alt="Two-factor setup code" width={200} height={200} />
          </div>
        )}

        {secret && (
          <div className="stack" style={{ gap: 6 }}>
            <span className="hint">Or enter this key manually:</span>
            <code className="mono" style={{ fontSize: 13, wordBreak: 'break-all', color: 'var(--signal)' }}>
              {secret}
            </code>
            <span className="hint">
              Save this key somewhere you can reach without your phone. Losing both
              your password and your authenticator locks you out permanently.
            </span>
          </div>
        )}

        <div className="stack">
          <input inputMode="numeric" autoComplete="one-time-code" maxLength={6}
            value={code} placeholder="000000"
            style={{ fontSize: 26, textAlign: 'center', letterSpacing: '0.3em' }}
            onChange={e => setCode(e.target.value.replace(/\D/g, ''))} />

          {error && <div className="error">{error}</div>}

          <button className="primary" onClick={confirm} disabled={busy || code.length !== 6 || !factorId}>
            {busy ? 'Confirming…' : 'Confirm and finish'}
          </button>
        </div>
      </div>
    </div>
  )
}
