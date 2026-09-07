# mercature-notes — Task 1: basic notes

## What's in this branch
- `createNote` / `editNote` / `deleteNote` — owner-only CRUD.
- `listMyNotes` — returns only the caller's notes.
- `whoAmI` — returns the caller's principal.
- Passkey auth gate via Memphis (3-factor registration for new identities).

## Deploy
```
mops install
thebes-deploy build
thebes-deploy deploy
```
