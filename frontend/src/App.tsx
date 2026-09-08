import { useCallback, useEffect, useRef, useState } from 'react'
import { useQuery, useUpdate, update as callUpdate, encodeArgs, decodeNat, decodeBool, decodeVecRecord } from '@thebes/sdk'
import { useAuth } from './Gate'
import './style.css'

// The numeric canister id of the `notes` backend. Must match
// [canisters.notes].cid in thebes.toml (thebes-deploy writes the real
// value back into the manifest after the first successful install —
// copy it from there if you redeploy to a fresh cid).
const NOTES_CID = 106513132452920

type Note = {
  id: bigint
  title: string
  body: string
  owner: string // hex-encoded principal bytes (display only, not the real textual form)
  isShared: boolean
}

type Tip = { from: string; to_: string; noteId: bigint; amount: bigint; at: bigint }
type Seal = { accounts: bigint; totalPoints: bigint; balanced: boolean }

// Field lists for decodeVecRecord — order doesn't matter (the decoder
// sorts by field hash itself), but every field the backend record
// actually has must be listed, or the decode desyncs on the next record.
const NOTE_FIELDS = [
  { name: 'id', type: 'nat' as const },
  { name: 'title', type: 'text' as const },
  { name: 'body', type: 'text' as const },
  { name: 'owner', type: 'principal' as const },
  { name: 'isShared', type: 'bool' as const },
]

const TIP_FIELDS = [
  { name: 'from', type: 'principal' as const },
  { name: 'to_', type: 'principal' as const },
  { name: 'noteId', type: 'nat' as const },
  { name: 'amount', type: 'nat' as const },
  { name: 'at', type: 'int' as const },
]

const SEAL_FIELDS = [
  { name: 'accounts', type: 'nat' as const },
  { name: 'totalPoints', type: 'nat' as const },
  { name: 'balanced', type: 'bool' as const },
]

// decode* functions must be stable (defined outside the component) —
// useQuery re-runs whenever the decode reference changes.
function decodeNotes(hex: string): Note[] {
  return decodeVecRecord(hex, NOTE_FIELDS) as unknown as Note[]
}
function decodeTips(hex: string): Tip[] {
  return decodeVecRecord(hex, TIP_FIELDS) as unknown as Tip[]
}
function decodeSeal(hex: string): Seal | undefined {
  const rows = decodeVecRecord(hex, SEAL_FIELDS) as unknown as Seal[]
  return rows[0]
}

function short(hex: string): string {
  return hex.length <= 10 ? hex : `${hex.slice(0, 5)}…${hex.slice(-4)}`
}

// `listMyNotes`, `myBalance`, and `myTipHistory` are deliberately plain
// `public func`s on the backend (not `query func`) — `myBalance` grants the
// one-time 100pt balance as a side effect, and a `query` call's mutations
// never persist on this substrate. `useQuery` (from @thebes/sdk) calls
// `POST /api/query`, the true query transport — which can't invoke a
// method that's only exported as `canister_update`, so every read through
// it here silently returned nothing (its `error` was never even read).
// This mirrors `useQuery`'s exact shape but drives the reads through the
// same `update()` transport `useUpdate` uses, so they hit the method the
// backend actually exports.
function useUpdateQuery<T>(
  cid: number,
  method: string,
  argHex: string | undefined,
  decode: (replyHex: string) => T,
  deps: readonly unknown[] = [],
) {
  const [data, setData] = useState<T>()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string>()
  const runId = useRef(0)

  const run = useCallback(() => {
    const id = ++runId.current
    setLoading(true)
    setError(undefined)
    callUpdate(cid, method, argHex)
      .then((r) => {
        if (id !== runId.current) return
        const hex = r.reply_hex ?? r.reply ?? ''
        setData(decode(hex))
      })
      .catch((e: unknown) => {
        if (id !== runId.current) return
        setError(e instanceof Error ? e.message : String(e))
      })
      .finally(() => {
        if (id === runId.current) setLoading(false)
      })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cid, method, argHex, ...deps])

  useEffect(() => {
    run()
    return () => { runId.current++ }
  }, [run])

  return { data, loading, error, refetch: run }
}

export default function App() {
  const { session, displayName, signOut } = useAuth()
  // Guaranteed non-null here: <Gate> only renders <App/> once signed in.
  const sessionHex = session?.session_token_hex ?? ''

  const [tab, setTab] = useState<'mine' | 'feed'>('mine')
  const update = useUpdate()

  const { data: myNotes = [], loading: mineLoading, error: mineError, refetch: refetchMine } = useUpdateQuery<Note[]>(
    NOTES_CID, 'listMyNotes', encodeArgs([sessionHex]), decodeNotes, [sessionHex],
  )

  const { data: feed = [], loading: feedLoading, refetch: refetchFeed } = useQuery<Note[]>(
    NOTES_CID, 'feed', undefined, decodeNotes, [],
  )

  const { data: balance = 0n, refetch: refetchBalance } = useUpdateQuery<bigint>(
    NOTES_CID, 'myBalance', encodeArgs([sessionHex]), decodeNat, [sessionHex],
  )

  const { data: history = [] } = useUpdateQuery<Tip[]>(
    NOTES_CID, 'myTipHistory', encodeArgs([sessionHex]), decodeTips, [sessionHex],
  )

  const { data: seal } = useQuery<Seal | undefined>(
    NOTES_CID, 'ledgerSeal', undefined, decodeSeal, [],
  )

  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [tipAmount, setTipAmount] = useState<Record<string, string>>({})
  const [busyId, setBusyId] = useState<string | null>(null)

  function refreshAll() {
    refetchMine()
    refetchFeed()
    refetchBalance()
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault()
    if (!title.trim()) return
    try {
      await update.call(NOTES_CID, 'createNote', encodeArgs([sessionHex, title, body]))
      setTitle('')
      setBody('')
      refreshAll()
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e))
    }
  }

  async function handleDelete(id: bigint) {
    const key = id.toString()
    setBusyId(key)
    try {
      await update.call(NOTES_CID, 'deleteNote', encodeArgs([sessionHex, id]))
      refreshAll()
    } finally {
      setBusyId(null)
    }
  }

  async function handleShare(id: bigint) {
    const key = id.toString()
    setBusyId(key)
    try {
      await update.call(NOTES_CID, 'shareNote', encodeArgs([sessionHex, id]))
      refreshAll()
    } finally {
      setBusyId(null)
    }
  }

  async function handleUnshare(id: bigint) {
    const key = id.toString()
    setBusyId(key)
    try {
      await update.call(NOTES_CID, 'unshareNote', encodeArgs([sessionHex, id]))
      refreshAll()
    } finally {
      setBusyId(null)
    }
  }

  async function handleTip(note: Note) {
    const key = note.id.toString()
    const raw = tipAmount[key] ?? ''
    const amount = BigInt(raw || '0')
    if (amount <= 0n) return
    setBusyId(key)
    try {
      await update.call(NOTES_CID, 'tip', encodeArgs([sessionHex, note.id, amount]))
      setTipAmount((s) => ({ ...s, [key]: '' }))
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e))
    } finally {
      setBusyId(null)
      refreshAll()
    }
  }

  return (
    <div>
      <header className="topbar">
        <span className="wordmark">Notes</span>
        <div className="masthead-right">
          <span className="who">{displayName}</span>
          <span className="seal stamp-pop">
            <span className="seal-dot" />
            {balance.toString()} pts
          </span>
          <button className="linklike" onClick={signOut}>Sign out</button>
        </div>
      </header>

      <div className="page">
        <div className="tabs">
          <button className="tab" data-active={tab === 'mine'} onClick={() => setTab('mine')}>
            My notes
          </button>
          <button className="tab" data-active={tab === 'feed'} onClick={() => setTab('feed')}>
            Feed
          </button>
        </div>

        <div className="panel">
          {tab === 'mine' && (
            <>
              <form onSubmit={handleCreate} className="compose">
                <label className="field-label" htmlFor="note-title">Title</label>
                <input
                  id="note-title"
                  placeholder="Give it a name"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                />
                <label className="field-label" htmlFor="note-body">Note</label>
                <textarea
                  id="note-body"
                  placeholder="Write something worth keeping…"
                  value={body}
                  onChange={(e) => setBody(e.target.value)}
                />
                <button className="btn btn-primary" type="submit" disabled={update.pending || !title.trim()}>
                  {update.pending ? 'Saving…' : 'Add note'}
                </button>
              </form>

              {mineLoading && myNotes.length === 0 ? (
                <p className="empty">Fetching your notes…</p>
              ) : mineError ? (
                <p className="empty">
                  Couldn't load your notes: {mineError}{' '}
                  <button className="linklike" onClick={refetchMine}>Retry</button>
                </p>
              ) : myNotes.length === 0 ? (
                <p className="empty">No notes yet — write your first one above.</p>
              ) : (
                <div className="note-grid">
                  {myNotes.map((note) => {
                    const key = note.id.toString()
                    const isBusy = busyId === key
                    return (
                      <div key={key} className="note-card">
                        {note.isShared && <span className="badge-shared">on the feed</span>}
                        <h3 className="note-title">{note.title}</h3>
                        <p className="note-body">{note.body}</p>
                        <div className="note-actions">
                          <button
                            className="btn btn-danger"
                            onClick={() => handleDelete(note.id)}
                            disabled={isBusy}
                          >
                            Delete
                          </button>
                          {note.isShared ? (
                            <button
                              className="btn btn-quiet"
                              onClick={() => handleUnshare(note.id)}
                              disabled={isBusy}
                            >
                              Unshare
                            </button>
                          ) : (
                            <button
                              className="btn btn-quiet"
                              onClick={() => handleShare(note.id)}
                              disabled={isBusy}
                            >
                              Share to feed
                            </button>
                          )}
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}
            </>
          )}

          {tab === 'feed' && (
            <>
              {feedLoading && feed.length === 0 ? (
                <p className="empty">Fetching the feed…</p>
              ) : feed.length === 0 ? (
                <p className="empty">Nothing shared yet — be the first from “My notes”.</p>
              ) : (
                <div className="ledger">
                  {feed.map((note) => {
                    const key = note.id.toString()
                    const isBusy = busyId === key
                    return (
                      <div key={key} className="ledger-row">
                        <div className="ledger-main">
                          <h3 className="note-title">{note.title}</h3>
                          <p className="note-body">{note.body}</p>
                          <p className="byline">by {short(note.owner)}</p>
                        </div>
                        <div className="tip-form">
                          <input
                            className="tip-input"
                            inputMode="numeric"
                            placeholder="0"
                            value={tipAmount[key] ?? ''}
                            onChange={(e) =>
                              setTipAmount((s) => ({ ...s, [key]: e.target.value.replace(/[^0-9]/g, '') }))
                            }
                          />
                          <button
                            className="btn btn-primary"
                            onClick={() => handleTip(note)}
                            disabled={isBusy || !tipAmount[key]}
                          >
                            {isBusy ? '…' : 'Tip'}
                          </button>
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}
            </>
          )}

          <div className="history">
            <h2>Tip history</h2>
            {history.length === 0 ? (
              <p className="empty">No tips yet.</p>
            ) : (
              history.map((t, i) => (
                <div key={i} className="history-row">
                  <span>note #{t.noteId.toString()}</span>
                  <span className="history-amount">{t.amount.toString()} pts</span>
                </div>
              ))
            )}
          </div>
        </div>
      </div>

      {seal && (
        <footer className="seal-strip">
          <span>{seal.accounts.toString()} accounts</span>
          <span>{seal.totalPoints.toString()} pts total</span>
          <span className="seal-stamp" data-ok={seal.balanced}>
            {seal.balanced ? '✓ ledger conserved' : '⚠ mismatch'}
          </span>
        </footer>
      )}
    </div>
  )
}
