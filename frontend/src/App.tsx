import { useState } from 'react'
import { useQuery, useUpdate, encodeArgs, decodeNat, decodeBool, decodeVecRecord } from '@thebes/sdk'
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

export default function App() {
  const { session, displayName, signOut } = useAuth()
  // Guaranteed non-null here: <Gate> only renders <App/> once signed in.
  const sessionHex = session?.session_token_hex ?? ''

  const [tab, setTab] = useState<'mine' | 'feed'>('mine')
  const update = useUpdate()

  const { data: myNotes = [], loading: mineLoading, refetch: refetchMine } = useQuery<Note[]>(
    NOTES_CID, 'listMyNotes', encodeArgs([sessionHex]), decodeNotes, [sessionHex],
  )

  const { data: feed = [], loading: feedLoading, refetch: refetchFeed } = useQuery<Note[]>(
    NOTES_CID, 'feed', undefined, decodeNotes, [],
  )

  const { data: balance = 0n, refetch: refetchBalance } = useQuery<bigint>(
    NOTES_CID, 'myBalance', encodeArgs([sessionHex]), decodeNat, [sessionHex],
  )

  const { data: history = [] } = useQuery<Tip[]>(
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
    await update.call(NOTES_CID, 'createNote', encodeArgs([sessionHex, title, body]))
    setTitle('')
    setBody('')
    refreshAll()
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
