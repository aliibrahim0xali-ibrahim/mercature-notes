# mercature-notes — Task 3: share & tip

## What's new
- `shareNote` / `unshareNote` — toggle a note's `shared` flag (owner-only).
- `feed` — a plain `query` (no session needed) returning every shared note with its author.
- `myBalance`, `myTipHistory` — identity-checked, so `shared`/update not `query`.
- `tip(session, noteId, amount)` enforces both rules before moving points:
  - Rule 1 — `amount > myBalance` → rejected
  - Rule 2 — `note.owner == caller` → rejected
- Every principal is lazily granted 100 points **once**, the first time it's seen
  (in `createNote` or the first tip either direction) — never re-granted after that.
- **Bonus — `ledgerSeal`**: total points in circulation must always equal
  `100 × accounts`, since tipping only moves points between balances, never
  creates or destroys them. Rendered in the page footer as a small trust check.
- **Bonus — image attachment**: `Note.imagePath` is a stub field only. Wiring
  it up for real means integrating thebes-lib's `Media` module (chunked
  upload, quotas, the certified media tree) — that's a meaningfully bigger
  piece of work than the rest of this task, so it's left as a TODO rather
  than a half-verified guess. Read the `Media` module's header comment in
  thebes-lib before building it.

## Untouched, on purpose
The Memphis gate line is byte-for-byte identical to Task 2:
```
var gate = MemphisAuth.initFromCid(921, "mercature-notes", 1);
```
Do not edit this line or re-call `initFromCid` anywhere else.

## Deploy
```
mops install
thebes-deploy build
thebes-deploy deploy
```

`asset_canister.wasm` (at the project root) is committed here — it's the
`type = "frontend"` canister's wasm, a separate release artifact from
`thebes-deploy` itself (Mercatura-Forum/Thebes-Protocol-, release
`asset-canister-v0.1.0`), not something `thebes-deploy build` produces. If
it's ever missing, `thebes-deploy deploy` fails with:
```
Error: read wasm ./asset_canister.wasm
Caused by:
    No such file or directory (os error 2)
```
Re-fetch it from the release page and verify before using it:
```
curl -fL -o asset_canister.wasm \
  https://github.com/Mercatura-Forum/Thebes-Protocol-/releases/download/asset-canister-v0.1.0/asset_canister.wasm
echo "6b72e4fe96b0439e37e485b0bcbf5ac7ccda3a2fd51e39b3e9aa8f276bd55b77  asset_canister.wasm" | sha256sum -c
```

Passkey sign-in pins its relying-party id to the served origin, so it does
not work from `npm run dev` on localhost — deploy first, then test sign-in
on the served `memphis.mercaturaforum.com/_/raw/<cid>/...` URL.
