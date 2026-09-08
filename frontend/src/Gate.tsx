/**
 * Gate — our own blocking sign-in screen, standing in for @thebes/sdk's
 * <MemphisGate>.
 *
 * History:
 *
 * 1. Wrong endpoint (fixed by the @thebes/sdk bump to v0.2.0, not by this
 *    file): the passkey.js shipped with v0.1.1 queried Memphis at
 *    `/api/v1/contract/921/query`, which 404s. v0.2.0's passkey.js queries
 *    the right path (`/api/v1/canister/921/query`) instead.
 *
 * 2. No way to register (fixed by v0.2.0's useMemphis + this component
 *    calling `signIn` and letting the hook's `window.confirm` gate the
 *    mint). That's what shipped as of v0.2.0.
 *
 * 3. THIS REWRITE — Memphis (cid 921) has required THREE factors at
 *    registration since 2026-08-29 (MIN_FACTORS_AT_SIGNUP = 3). The pinned
 *    v0.2.0 SDK's `useMemphis`/`register` still sends exactly one factor,
 *    so any first-time signup against the live canister fails with
 *    `register: InsufficientFactors`. No tagged release fixes this — the
 *    granular ceremony (`beginRegistrationChallenge`, `buildDeviceFactor`,
 *    `registerWithFactors`) only exists on the SDK's `main` branch, past
 *    v0.4.0, unreleased. `useMemphis` itself was NOT updated to use it
 *    (still calls the one-factor `signInOrRegister`), so we bypass the hook
 *    entirely here and drive `window.MemphisPasskey`'s low-level ceremony
 *    functions directly. `package.json` now pins `@thebes/sdk` to commit
 *    `9337c0c` (the tip of `main` at the time of this fix) rather than
 *    `v0.2.0`, since that's the only ref that has these functions.
 *
 *    One more wrinkle worth documenting because it isn't obvious from the
 *    SDK's own comments: the intended THIRD factor is a recovery phrase via
 *    `buildRecoveryFactor`, which requires `window.MemphisRecovery` from a
 *    `recovery.js` the runtime expects "loaded alongside" passkey.js. That
 *    file does not exist anywhere in the thebes-sdk repo — no tag, no
 *    branch — so driving that path throws `recovery.js not loaded`. Until
 *    upstream ships it, we satisfy the 3-factor floor with a THIRD device
 *    passkey instead (`kind` defaults to "WebAuthn" when omitted, which is
 *    exactly what `buildDeviceFactor` sends). A recovery-phrase factor can
 *    be added later, post-signup, via `addDevice`/`setupRecoveryPhrase`
 *    once `recovery.js` lands — that path doesn't block getting people
 *    signed up today. Search this file for "TODO(recovery.js)" for the one
 *    spot to change when it does.
 *
 * 4. "Not signed in (#Memphis(#NotAuthenticated))" on every backend call,
 *    even right after a successful sign-in — this component was handing
 *    `App.tsx` the raw MASTER `session_token_hex` from `signIn`/
 *    `registerWithFactors`. `backend/main.mo` pins `thebes-lib#v1.0.0`,
 *    whose `MemphisAuth.verifyWithAudience` calls Memphis's
 *    `whoami_scoped_u` — and per that module's own header, a master token
 *    is REFUSED there by design ("Clients must obtain a scoped token for
 *    your origin"); `whoami_scoped_u` doesn't recognise it at all, which is
 *    exactly the `#NotAuthenticated` being thrown, not `#Unauthorized`.
 *    Fixed by minting an origin-scoped token with `issueScopedSession`
 *    right after sign-in/registration (and again, silently, whenever a
 *    persisted master session is reloaded on mount — no passkey prompt
 *    needed, since the master token alone is enough to ask Memphis for a
 *    new scope) and exposing THAT as `session.session_token_hex` instead.
 *    `App.tsx` needed no changes: it already only ever reads
 *    `session.session_token_hex` and sends it straight through.
 *    `AUDIENCE` below must stay byte-identical to `backend/main.mo`'s
 *    `AUDIENCE` constant — see docs/memphis.md's warning that a trailing
 *    slash, port, or case difference is a mismatch.
 *
 *    Scoped tokens are short-lived (~30 real minutes); this fix re-mints
 *    one on every page load but does not yet wire the SDK's refresh-token
 *    pair (`issueRefresh`/`exchangeRefresh`) to extend a session across a
 *    long-lived tab. That's the next thing to add if "session expired"
 *    reports start coming in from people who leave a tab open.
 *
 * v0.2.0+ also turned the SDK's own <MemphisGate> into an "open-demo" gate
 * that never blocks the app (sign-in moved into a header chip). That's a
 * different product than this one — "Sign in to your notes." is a hard
 * wall by design — so we keep our own small blocking wrapper here rather
 * than taking their gate.
 */
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import type { MemphisSession } from '@thebes/sdk'

/** A single registered credential, as the low-level ceremony functions produce it. */
type FactorRegistration = {
  credential_id: Uint8Array
  cose_pub_key_bytes: Uint8Array
  authenticator_data: Uint8Array
  client_data_json: Uint8Array
  signature: Uint8Array
  kind?: 'WebAuthn' | 'RecoveryPhrase'
}

/** The subset of window.MemphisPasskey this component drives directly. */
type PasskeyRuntime = {
  validateName: (name: string) => string
  lookupAnchor: (name: string) => Promise<Uint8Array | null>
  signIn: (name: string) => Promise<MemphisSession>
  beginRegistrationChallenge: () => Promise<Uint8Array>
  buildDeviceFactor: (challenge: Uint8Array, label: string) => Promise<FactorRegistration>
  registerWithFactors: (name: string, factors: FactorRegistration[]) => Promise<MemphisSession>
  issueScopedSession: (sessionTokenHex: string, audience: string) => Promise<{ scoped_token_hex: string }>
  loadSession: () => MemphisSession | null
  signOut: () => Promise<void>
}

function pk(): PasskeyRuntime {
  const p = (window as unknown as { MemphisPasskey?: PasskeyRuntime }).MemphisPasskey
  if (!p) throw new Error('passkey.js not loaded (window.MemphisPasskey missing)')
  return p
}

// The web origin this app is served from — MUST stay byte-identical to
// backend/main.mo's `AUDIENCE`. Memphis compares it exactly; a mismatch
// here fails every backend call with #Unauthorized ("token minted for
// another origin"), never with #NotAuthenticated.
const AUDIENCE = 'https://memphis.mercaturaforum.com'

// Master session tokens (what signIn/registerWithFactors return) are
// refused by the backend's `whoami_scoped_u` check — see file header,
// point 4. Every session this component exposes must go through here
// first, so `session.session_token_hex` is always the scoped token
// `App.tsx` actually needs to send.
async function scopeSession(master: MemphisSession): Promise<MemphisSession> {
  const { scoped_token_hex } = await pk().issueScopedSession(master.session_token_hex, AUDIENCE)
  return { ...master, session_token_hex: scoped_token_hex }
}

interface AuthValue {
  session: MemphisSession
  displayName: string
  signOut: () => Promise<void>
}

const AuthCtx = createContext<AuthValue | null>(null)

/** The signed-in Memphis session + sign-out. Throws if used outside the gate. */
export function useAuth(): AuthValue {
  const v = useContext(AuthCtx)
  if (!v) throw new Error('useAuth must be used inside <Gate>')
  return v
}

// Registration is a fixed sequence of steps, each surfaced to the person so
// a WebAuthn prompt they weren't expecting doesn't read as the app hanging.
type Step =
  | { kind: 'idle' }
  | { kind: 'busy'; label: string }
  | { kind: 'error'; message: string }

export function Gate({ appName, tagline, children }: { appName: string; tagline?: string; children: ReactNode }) {
  const [session, setSession] = useState<MemphisSession | null>(null)
  const [name, setName] = useState('')
  const [step, setStep] = useState<Step>({ kind: 'idle' })

  useEffect(() => {
    let cancelled = false
    async function restore() {
      let master: MemphisSession | null
      try { master = pk().loadSession() } catch { return /* passkey.js not present yet */ }
      if (!master) return
      try {
        const scoped = await scopeSession(master)
        if (!cancelled) setSession(scoped)
      } catch {
        // The master session itself is dead (expired/revoked) — fall back
        // to the sign-in screen rather than handing App.tsx a token that
        // will just fail on the first call.
        if (!cancelled) setSession(null)
      }
    }
    restore()
    return () => { cancelled = true }
  }, [])

  if (session) {
    const value: AuthValue = {
      session,
      displayName: session.display_tag || session.name,
      signOut: async () => {
        try { await pk().signOut() } finally { setSession(null) }
      },
    }
    return <AuthCtx.Provider value={value}>{children}</AuthCtx.Provider>
  }

  const busy = step.kind === 'busy'
  const error = step.kind === 'error' ? step.message : undefined

  async function runRegistration(validated: string) {
    // 1. One challenge, shared by every factor in this signup.
    setStep({ kind: 'busy', label: 'Starting sign-up…' })
    const challenge = await pk().beginRegistrationChallenge()

    // 2-4. Three WebAuthn prompts. See the file header for why this is
    // three device passkeys rather than two passkeys + a recovery phrase.
    // TODO(recovery.js): once upstream ships window.MemphisRecovery, swap
    // factor 3 for `pk().buildRecoveryFactor(challenge, phrase)` and show
    // the phrase to the person before finishing, instead of prompting for
    // a third passkey.
    setStep({ kind: 'busy', label: 'Create your passkey — this device will confirm (1 of 3)…' })
    const factor1 = await pk().buildDeviceFactor(challenge, validated)

    setStep({ kind: 'busy', label: 'Register a backup passkey (2 of 3) — a phone or security key works well…' })
    const factor2 = await pk().buildDeviceFactor(challenge, `${validated} (backup 2)`)

    setStep({ kind: 'busy', label: 'One more backup passkey (3 of 3), so losing one device never locks you out…' })
    const factor3 = await pk().buildDeviceFactor(challenge, `${validated} (backup 3)`)

    setStep({ kind: 'busy', label: 'Finishing sign-up…' })
    return pk().registerWithFactors(validated, [factor1, factor2, factor3])
  }

  async function submit() {
    setStep({ kind: 'busy', label: 'Checking handle…' })
    try {
      const validated = pk().validateName(name.trim())
      const anchor = await pk().lookupAnchor(validated)

      if (anchor) {
        setStep({ kind: 'busy', label: 'Signing in…' })
        const master = await pk().signIn(validated)
        setSession(await scopeSession(master))
        setStep({ kind: 'idle' })
        return
      }

      const ok = window.confirm(
        `No Memphis identity exists for "${validated}".\n\n` +
        'Create a NEW identity with this name? (Cancel if you meant to sign into an existing one.)\n\n' +
        "You'll be asked to confirm three passkeys — this keeps the account recoverable if any one device is lost.",
      )
      if (!ok) { setStep({ kind: 'idle' }); return }

      const master = await runRegistration(validated)
      setSession(await scopeSession(master))
      setStep({ kind: 'idle' })
    } catch (e) {
      setStep({ kind: 'error', message: e instanceof Error ? e.message : String(e) })
    }
  }

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
          disabled={busy}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
        />
        <button className="gate-submit" onClick={submit} disabled={busy || !name.trim()}>
          {busy ? 'Working…' : 'Sign in with passkey'}
        </button>
        {step.kind === 'busy' && <p className="gate-footnote">{step.label}</p>}
        {error && <p className="gate-error">{error}</p>}
        <p className="gate-footnote">
          New handle? Just type it and sign in — you'll be asked to confirm before a new identity is created.
          A passkey is your identity — no password. Powered by Memphis.
        </p>
      </div>
    </div>
  )
}
