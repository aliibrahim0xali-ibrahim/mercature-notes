import { useState } from 'react'
import { useQuery, useUpdate, encodeArgs, decodeNat, decodeVecRecord } from '@thebes/sdk'
import { useAuth } from './Gate'
import './style.css'

const NOTES_CID = 106513132452920

type Note = {
  id: bigint
  title: string
  body: string
  owner: string
}
type Seal = { accounts: bigint; totalPoints: bigint; balanced: boolean }

const NOTE_FIELDS = [
  { name: 'id', type: 'nat' as const },
  { name: 'title', type: 'text' as const },
  { name: 'body', type: 'text' as const },
  { name: 'owner', type: 'principal' as const },
]

const SEAL_FIELDS = [
  { name: 'accounts', type: 'nat' as const },
  { name: 'totalPoints', type: 'nat' as const },
  { name: 'balanced', type: 'bool' as const },
]

function decodeNotes(hex: string): Note[] {
  return decodeVecRecord(hex, NOTE_FIELDS) as unknown as Note[]
}
function decodeSeal(hex: string): Seal | undefined {
  const rows = decodeVecRecord(hex, SEAL_FIELDS) as unknown as Seal[]
  return rows[0]
}

export default function App() {
  const { session, displayName, signOut } = useAuth()
  const sessionHex = session?.session_token_hex ?? ''

  const { data: myNotes = [], loading: mineLoading, refetch: refetchMine } = useQuery<Note[]>(
    NOTES_CID, 'listMyNotes', encodeArgs([sessionHex]), decodeNotes, [sessionHex],
  )

  const { data: balance = 0n, refetch: refetchBalance } = useQuery<bigint>(
    NOTES_CID, 'myBalance', encodeArgs([sessionHex]), decodeNat, [sessionHex],
  )

  const { data: seal } = useQuery<Seal | undefined>(
    NOTES_CID, 'ledgerSeal', undefined, decodeSeal, [],
  )

  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [busyId, setBusyId] = useState<string | null>(null)
  const update = useUpdate()

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault()
    if (!title.trim()) return
    await update.call(NOTES_CID, 'createNote', encodeArgs([sessionHex, title, body]))
    setTitle('')
    setBody('')
    refetchMine()
    refetchBalance()
  }

  async function handleDelete(id: bigint) {
    const key = id.toString()
    setBusyId(key)
    try {
      await update.call(NOTES_CID, 'deleteNote', encodeArgs([sessionHex, id]))
      refetchMine()
    } finally {
      setBusyId(null)
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
        <div className="panel">
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
                    </div>
                  </div>
                )
              })}
            </div>
          )}
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
