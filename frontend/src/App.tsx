import { useCallback, useEffect, useRef, useState } from 'react'
import { useQuery, useUpdate, update as callUpdate, encodeArgs, decodeNat, decodeBool, decodeVecRecord } from '@thebes/sdk'
import { useAuth } from './Gate'
import './style.css'

// The numeric canister id of the `notes` backend. Must match
// [canisters.notes].cid in thebes.toml (thebes-deploy writes the real
// value back into the manifest after the first successful install —
// copy it from there if you redeploy to a fresh cid).
// Live deploy (2026-09-09): notes cid 28438571719272,
// web cid 214569885401572.
const NOTES_CID = 28438571719272

type Note = {
  id: bigint
  title: string
  body: string
  owner: string // hex-encoded principal bytes (display only, not the real textual form)
  isShared: boolean
}

type Tip = { from: string; to_: string; noteId: bigint; amount: bigint; at: bigint }
type Seal = { members: bigint; circulation: bigint; expected: bigint; consistent: boolean }
type Me = { principal: string }

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
  { name: 'members', type: 'nat' as const },
  { name: 'circulation', type: 'nat' as const },
  { name: 'expected', type: 'nat' as const },
  { name: 'consistent', type: 'bool' as const },
]

const MY_FIELDS = [
  { name: 'principal', type: 'principal' as const },
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
function decodeMe(hex: string): string | undefined {
  const rows = decodeVecRecord(hex, MY_FIELDS) as unknown as Me[]
  return rows[0]?.principal
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

  const [tab, setTab] = useState<'mine' | 'feed' | 'send'>('mine')
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

  const { data: myPrincipalHex } = useUpdateQuery<string | undefined>(
    NOTES_CID, 'whoAmI', encodeArgs([sessionHex]), decodeMe, [sessionHex],
  )

  const { data: seal } = useQuery<Seal | undefined>(
    NOTES_CID, 'ledgerSealView', undefined, decodeSeal, [],
  )

  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [tipAmount, setTipAmount] = useState<Record<string, string>>({})
  const [busyId, setBusyId] = useState<string | null>(null)

  // Task 1 checklist: "edit one" — editNote already existed on the backend
  // but nothing in the UI ever called it. editingId tracks which card is
  // showing its edit form; editTitle/editBody are that form's draft values.
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editTitle, setEditTitle] = useState('')
  const [editBody, setEditBody] = useState('')

  function startEdit(note: Note) {
    setEditingId(note.id.toString())
    setEditTitle(note.title)
    setEditBody(note.body)
  }

  function cancelEdit() {
    setEditingId(null)
  }

  async function handleSaveEdit(id: bigint) {
    if (!editTitle.trim()) return
    const key = id.toString()
    setBusyId(key)
    try {
      await update.call(NOTES_CID, 'editNote', encodeArgs([sessionHex, id, editTitle, editBody]))
      setEditingId(null)
      refreshAll()
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e))
    } finally {
      setBusyId(null)
    }
  }

  // A "registered" recipient = someone with a note on the feed — that's the
  // only address book we have, since the backend exposes no directory of
  // principals. One representative note (its id) is kept per owner so a
  // send can be routed through `tip`, which is the only transfer primitive
  // the backend has. My own principal comes from `whoAmI` (not from my own
  // notes — that broke for anyone with zero notes of their own, since
  // `myNotes[0]?.owner` is `undefined` until you've created one) and is
  // excluded up front so Rule 2 can never even be attempted from here.
  const recipients = (() => {
    const seen = new Map<string, { owner: string; noteId: bigint; title: string }>()
    for (const note of feed) {
      if (myPrincipalHex !== undefined && note.owner === myPrincipalHex) continue // Rule 2: never list myself
      if (!seen.has(note.owner)) {
        seen.set(note.owner, { owner: note.owner, noteId: note.id, title: note.title })
      }
    }
    return Array.from(seen.values())
  })()

  const [selectedRecipients, setSelectedRecipients] = useState<Set<string>>(new Set())
  const [sendAmount, setSendAmount] = useState('')
  const [sending, setSending] = useState(false)

  function toggleRecipient(owner: string) {
    setSelectedRecipients((s) => {
      const next = new Set(s)
      if (next.has(owner)) next.delete(owner)
      else next.add(owner)
      return next
    })
  }

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
    if (myPrincipalHex !== undefined && note.owner === myPrincipalHex) return // Rule 2, defense in depth
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

  // Sends `sendAmount` to every checked recipient. There's no batch-transfer
  // method on the backend, so this is a sequence of individual `tip` calls
  // — one per selected recipient's representative note — each of which
  // still gets Rule 1 / Rule 2 enforced server-side. We also pre-check the
  // total against the current balance so a doomed send doesn't fire a wall
  // of individual rejections.
  async function handleSend() {
    const amount = BigInt(sendAmount || '0')
    if (amount <= 0n || selectedRecipients.size === 0) return
    const total = amount * BigInt(selectedRecipients.size)
    if (total > balance) {
      alert(
        `Rule 1: you don't have that many points — sending ${amount.toString()} to ` +
        `${selectedRecipients.size} recipients needs ${total.toString()}, you have ${balance.toString()}.`,
      )
      return
    }
    setSending(true)
    const failures: string[] = []
    for (const ownerHex of selectedRecipients) {
      const recipient = recipients.find((r) => r.owner === ownerHex)
      if (!recipient) continue
      try {
        await update.call(NOTES_CID, 'tip', encodeArgs([sessionHex, recipient.noteId, amount]))
      } catch (e) {
        failures.push(`${short(ownerHex)}: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
    setSending(false)
    setSelectedRecipients(new Set())
    setSendAmount('')
    refreshAll()
    if (failures.length > 0) alert(`Some sends failed:\n${failures.join('\n')}`)
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
          <button className="tab" data-active={tab === 'send'} onClick={() => setTab('send')}>
            Send
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
                    const isEditing = editingId === key

                    if (isEditing) {
                      return (
                        <div key={key} className="note-card">
                          <label className="field-label" htmlFor={`edit-title-${key}`}>Title</label>
                          <input
                            id={`edit-title-${key}`}
                            value={editTitle}
                            onChange={(e) => setEditTitle(e.target.value)}
                            autoFocus
                          />
                          <label className="field-label" htmlFor={`edit-body-${key}`}>Note</label>
                          <textarea
                            id={`edit-body-${key}`}
                            value={editBody}
                            onChange={(e) => setEditBody(e.target.value)}
                          />
                          <div className="note-actions">
                            <button
                              className="btn btn-primary"
                              onClick={() => handleSaveEdit(note.id)}
                              disabled={isBusy || !editTitle.trim()}
                            >
                              {isBusy ? 'Saving…' : 'Save'}
                            </button>
                            <button className="btn btn-quiet" onClick={cancelEdit} disabled={isBusy}>
                              Cancel
                            </button>
                          </div>
                        </div>
                      )
                    }

                    return (
                      <div key={key} className="note-card">
                        {note.isShared && <span className="badge-shared">on the feed</span>}
                        <h3 className="note-title">{note.title}</h3>
                        <p className="note-body">{note.body}</p>
                        <div className="note-actions">
                          <button
                            className="btn btn-quiet"
                            onClick={() => startEdit(note)}
                            disabled={isBusy}
                          >
                            Edit
                          </button>
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
                    const isMine = myPrincipalHex !== undefined && note.owner === myPrincipalHex
                    return (
                      <div key={key} className="ledger-row">
                        <div className="ledger-main">
                          <h3 className="note-title">{note.title}</h3>
                          <p className="note-body">{note.body}</p>
                          <p className="byline">by {isMine ? 'you' : short(note.owner)}</p>
                        </div>
                        {isMine ? (
                          <p className="empty">This is your note — you can't tip yourself.</p>
                        ) : (
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
                        )}
                      </div>
                    )
                  })}
                </div>
              )}
            </>
          )}

          {tab === 'send' && (
            <div className="send-panel">
              <p className="field-label">Amount per recipient</p>
              <div className="send-amount-row">
                <input
                  className="tip-input"
                  inputMode="numeric"
                  placeholder="0"
                  value={sendAmount}
                  onChange={(e) => setSendAmount(e.target.value.replace(/[^0-9]/g, ''))}
                />
                <button
                  className="btn btn-primary"
                  onClick={handleSend}
                  disabled={sending || selectedRecipients.size === 0 || !sendAmount}
                >
                  {sending
                    ? 'Sending…'
                    : `Send to ${selectedRecipients.size} recipient${selectedRecipients.size === 1 ? '' : 's'}`}
                </button>
              </div>

              {recipients.length === 0 ? (
                <p className="empty">
                  No registered recipients yet — someone needs a note on the feed before you can send to them.
                </p>
              ) : (
                <div className="recipient-list">
                  {recipients.map((r) => (
                    <label key={r.owner} className="recipient-row">
                      <input
                        type="checkbox"
                        checked={selectedRecipients.has(r.owner)}
                        onChange={() => toggleRecipient(r.owner)}
                      />
                      <span className="byline">{short(r.owner)}</span>
                      <span className="note-title">{r.title}</span>
                    </label>
                  ))}
                </div>
              )}
            </div>
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
          <span>{seal.members.toString()} members</span>
          <span>{seal.circulation.toString()} / {seal.expected.toString()} pts in circulation</span>
          <span className="seal-stamp" data-ok={seal.consistent}>
            {seal.consistent ? '✓ ledger conserved' : '⚠ mismatch'}
          </span>
        </footer>
      )}
    </div>
  )
}
