# mercature-notes — Task 2: points balance

## What's new
- `myBalance` — identity-checked (so `shared`/update, not `query`); the frontend renders it as a small stamp in the masthead.
- Every principal is lazily granted 100 points **once**, the first time it's seen in `createNote` or `myBalance` — never re-granted after that.
- **Bonus — `ledgerSeal`**: total points in circulation must always equal `100 × accounts`, since points are minted exactly once and never moved or destroyed. Rendered in the page footer as a small trust check.

CRUD (create/edit/delete/list) matches Task 1 — owner-only.

## Deploy
```
mops install
thebes-deploy build
thebes-deploy deploy
```
