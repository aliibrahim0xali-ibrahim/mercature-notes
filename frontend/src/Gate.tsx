/**
 * Gate — our own blocking sign-in screen, standing in for @thebes/sdk's
 * <MemphisGate>.
 *
 * ── Why this file talks to window.MemphisPasskey directly ──────────────────
 * Memphis (cid 921) has required 3 registration factors since 2026-08-29
 * (MIN_FACTORS_AT_SIGNUP = 3). @thebes/sdk's useMemphis() hook still only
 * drives the old single-factor register() path, so a brand-new handle was
 * always refused by the canister with InsufficientFactors — see below for
 * why that showed up as "register: NotAuthenticated" instead.
 *
 * The multi-factor ceremony (beginRegistrationChallenge, buildDeviceFactor,
 * registerWithFactors) only exists on window.MemphisPasskey (passkey.js),
 * not yet wrapped by useMemphis/MemphisAuth in any released SDK version.
 * So new-identity creation is driven straight off window.MemphisPasskey
 * here, and sign-in for an EXISTING handle still goes through the same
 * client (signInOrRegister short-circuits to signIn when the anchor
 * already exists — that path is unaffected by the 3-factor floor, which
 * only binds at registration).
 *
 * Third factor: Memphis's third factor is meant to be a recovery phrase
 * (FactorKind = RecoveryPhrase), but the recovery.js module that derives
 * a phrase-backed key doesn't exist yet in @thebes/sdk (checked: no
 * released tag or the current main branch ships one). Until it does, we
 * register with THREE device passkey factors instead — buildDeviceFactor
 * defaults kind to "WebAuthn", and 3 WebAuthn factors satisfies
 * MIN_FACTORS_AT_SIGNUP just as well from the canister's point of view.
 * Swap the third buildDeviceFactor() call for buildRecoveryFactor() once
 * recovery.js ships upstream — see the TODO below.
 *
 * ── The bug that made every error print as "register: NotAuthenticated" ──
 * @thebes/sdk pinned at v0.2.0 has a real decoding bug: its
 * extractErrorTag() maps the OUTER `variant { Ok; Err }` tag (always 1 for
 * any error) through a name table, so it printed "NotAuthenticated" for
 * literally every possible canister error, no matter the real cause. The
 * fix (decoding the INNER MemphisError variant properly) landed on the
 * SDK's unreleased main branch, commit 9337c0c — no tag has it yet. This
 * project now pins that exact commit SHA in package.json (see comment
 * there for why a SHA and not a tag).
 *
 * Once you register.js/main.js are back at a released tag with the fix,
 * come back and re-pin to a real version tag instead of a commit SHA.
 */
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'

export interface MemphisSession {
  name: string
  anchor_id_hex: string
  session_token_hex: string
  expires_at_ns: string | number
  display_tag: string
}

interface MemphisAuth {
  session: MemphisSession | null
  signedIn: boolean
  displayName: string
  signIn: (name: string) => Promise<void>
  signOut: () => Promise<void>
  busy: boolean
  error: string | undefined
}

// window.MemphisPasskey is a plain JS global from passkey.js — no TS types
// ship for the P2.4 multi-factor functions yet, so we type only the surface
// we actually call.
interface DeviceFactor {
  credential_id: Uint8Array
  cose_pub_key_bytes: Uint8Array
  authenticator_data: Uint8Array
  client_data_json: Uint8Array
  signature: Uint8Array
  kind: string
}
interface MemphisPasskeyClient {
  signInOrRegister: (name: string, opts?: { confirmCreate?: boolean }) => Promise<MemphisSession>
  loadSession: () => MemphisSession | null
  signOut: () => Promise<void>
  beginRegistrationChallenge: () => Promise<Uint8Array>
  buildDeviceFactor: (challenge: Uint8Array, label: string) => Promise<DeviceFactor>
  registerWithFactors: (name: string, factors: DeviceFactor[]) => Promise<MemphisSession>
  validateName: (name: string) => string
}
function pk(): MemphisPasskeyClient {
  const p = (window as unknown as { MemphisPasskey?: MemphisPasskeyClient }).MemphisPasskey
  if (!p) throw new Error('passkey.js not loaded (window.MemphisPasskey missing)')
  return p
}

const AuthCtx = createContext<MemphisAuth | null>(null)

/** The signed-in Memphis session + sign-out. Throws if used outside the gate. */
export function useAuth(): MemphisAuth {
  const v = useContext(AuthCtx)
  if (!v) throw new Error('useAuth must be used inside <Gate>')
  return v
}

// Drives the 3-device-passkey registration ceremony over ONE challenge.
// TODO: once @thebes/sdk ships recovery.js / buildRecoveryFactor for real,
// swap the third buildDeviceFactor() call below for buildRecoveryFactor()
// so accounts get a genuine recovery phrase instead of a 3rd device.
async function registerNewIdentity(name: string): Promise<MemphisSession> {
  const client = pk()
  const validated = client.validateName(name)
  const challenge = await client.beginRegistrationChallenge()
  const factors: DeviceFactor[] = []
  // Each call opens its own native "create a passkey" prompt — the person
  // confirms 3 times (once per factor) in the same sign-up flow.
  factors.push(await client.buildDeviceFactor(challenge, `${validated} — passkey 1`))
  factors.push(await client.buildDeviceFactor(challenge, `${validated} — passkey 2`))
  factors.push(await client.buildDeviceFactor(challenge, `${validated} — passkey 3`))
  return client.registerWithFactors(validated, factors)
}

function useMemphisGate(): MemphisAuth {
  const [session, setSession] = useState<MemphisSession | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()

  useEffect(() => {
    try { setSession(pk().loadSession()) } catch { /* passkey.js not present yet */ }
  }, [])

  const signIn = async (name: string) => {
    setBusy(true); setError(undefined)
    const client = pk()
    try {
      // signInOrRegister still does the right thing for an EXISTING handle
      // (plain signIn under the hood) — only NEW handles need the 3-factor
      // ceremony below, since the factor floor binds at registration only.
      setSession(await client.signInOrRegister(name))
    } catch (e) {
      const code = (e as { code?: string } | null)?.code
      if (code === 'NameNotRegistered') {
        const requested = (e as { nameRequested?: string }).nameRequested || name
        const ok = typeof window !== 'undefined' && typeof window.confirm === 'function' &&
          window.confirm(
            `No Memphis identity exists for "${requested}".\n\n` +
            'Create a NEW identity with this name? Registration needs 3 passkey ' +
            'confirmations (Memphis requires 3 factors per identity). Cancel if ' +
            'you meant to sign into an existing one.',
          )
        if (!ok) { setError('Sign-in cancelled — no identity created.'); setBusy(false); return }
        try {
          setSession(await registerNewIdentity(requested))
        } catch (e2) {
          setError(e2 instanceof Error ? e2.message : String(e2))
          setBusy(false)
          throw e2
        }
        setBusy(false)
        return
      }
      setError(e instanceof Error ? e.message : String(e))
      setBusy(false)
      throw e
    }
    setBusy(false)
  }

  const signOut = async () => {
    setBusy(true)
    try { await pk().signOut() } catch { /* best-effort */ } finally { setSession(null); setBusy(false) }
  }

  return {
    session,
    signedIn: !!session,
    displayName: session?.display_tag || session?.name || '',
    signIn,
    signOut,
    busy,
    error,
  }
}

export function Gate({ appName, tagline, children }: { appName: string; tagline?: string; children: ReactNode }) {
  const auth = useMemphisGate()
  const [name, setName] = useState('')

  if (auth.signedIn) return <AuthCtx.Provider value={auth}>{children}</AuthCtx.Provider>

  const submit = () => { auth.signIn(name.trim()).catch(() => { /* surfaced by auth.error */ }) }

  return (
    <div className="gate">
      <div className="gate-card">
        <div className="gate-brand">{appName}</div>
        <p className="gate-tagline">{tagline ?? 'Sign in to continue.'}</p>
        <input
          className="gate-input"
          placeholder="yourname.thebes"
          value={name}
          autoFocus
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
        />
        <button className="gate-submit" onClick={submit} disabled={auth.busy || !name.trim()}>
          {auth.busy ? 'Signing in…' : 'Sign in with passkey'}
        </button>
        {auth.error && <p className="gate-error">{auth.error}</p>}
        <p className="gate-footnote">
          New handle? Just type it and sign in — you'll be asked to confirm before a new identity is created.
          Registering asks for 3 passkey confirmations. A passkey is your identity — no password. Powered by Memphis.
        </p>
      </div>
    </div>
  )
}
