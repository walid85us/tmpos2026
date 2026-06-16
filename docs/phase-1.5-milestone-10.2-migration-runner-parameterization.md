# Phase 1.5 — Milestone 10.2: Migration Runner Parameterization + DEV Safety Guard

Status: **Implemented locally — NOT committed, NOT pushed, NOT backed up. Pending review.**
Owner UI QA: **not required** (tooling-only; no visible UI change).

Checkpoint before M10.2: `a33e261259b28efc6bad6f174515d5801820ab3f` ("Phase 1.5 M10.1 record DEV migration applied").

---

## 1. Scope (accepted Option B)

M10.2 parameterizes the previously-hardcoded migration runner so future migrations can be
**listed** and **dry-run validated** safely, and so any future owner-approved **apply** requires
explicit DEV-only guards. It is **tooling-only**: it changes a dev operator CLI and adds a pure
diagnostic + this doc. **It applies no migration, connects to no database, runs no SQL, uses no
Supabase MCP, touches no production, and changes no runtime/frontend/backend business behaviour.**

Per the accepted M10.2 plan, **Option B** (parameterize the existing runner) was selected over
A (do nothing), C (duplicate script), D (migration ledger — DB-write scope, deferred), E (Supabase
CLI — added tooling), and F (MCP — disallowed).

### Files changed / added

- **Modified:** `scripts/supabase-migrate.ts` — parameterized, default-safe, DEV-guarded.
- **Added:** `scripts/diagnostics-supabase-migrate-runner-check.ts` — pure/offline runner diagnostic.
- **Added:** `docs/phase-1.5-milestone-10.2-migration-runner-parameterization.md` — this record.
- **No `package.json` change** (the existing `identity:migrate` entry now defaults to `--list`).
  No `package-lock.json` change. No new dependency.

---

## 2. Runner modes

| Mode | Command | DB? |
|------|---------|-----|
| **list** (default) | `npm run identity:migrate` / `… --list` | No |
| **dry-run** | `… --dry-run --migration 002 [--direction up\|down]` | No |
| **apply** (up) | `… --migration 002 --direction up --apply --confirm-dev` | Yes (guarded) |
| **apply** (down) | `… --migration 002 --direction down --apply --allow-down --confirm-dev` | Yes (extra-guarded) |

### Default-safe behaviour

With **no apply flags** the runner **lists** discovered migrations and **never connects** to the
database. This is a deliberate behaviour change from the old hardcoded "apply `001`" default: `001`
is already applied to DEV, and silent auto-apply is exactly the footgun this removes. `list` and
`dry-run` **do not require** `SUPABASE_DATABASE_URL`.

---

## 3. Migration discovery and path safety

- Discovery reads `server/platform-identity/migrations/` and matches the grammar
  `NNN_name.(up|down).sql` (`/^(\d{3})_([a-z0-9_]+)\.(up|down)\.sql$/`), grouping by number into
  up/down pairs.
- Selection is by **migration number** (`002`) or **exact basename** (`002_authorization_audit_foundation`).
  **Full paths are rejected.**
- **Path-traversal is rejected**: an identifier containing `/`, `\`, `..`, or an absolute prefix is
  refused, and identifiers are allow-listed to `[a-z0-9_]` only.
- **Folder restriction**: the resolved file's realpath must live inside the migrations directory
  (realpath containment check).
- Resolution verifies the **up/down pair exists** and the selected SQL is **non-empty** before any
  apply.

---

## 4. DEV safety guard model

`apply` is the **only** mode that may connect/run SQL, and it **refuses unless every guard holds**:

1. `NODE_ENV !== 'production'` — production is **hard-blocked** (cannot be overridden).
2. `ALLOW_SUPABASE_MIGRATION_APPLY === 'true'` — explicit intent gate.
3. `CONFIRM_SUPABASE_TARGET === 'tmpos2026-dev'` — typed DEV confirmation (the accepted token is
   baked into the runner; a wrong/production label can never satisfy it).
4. `--confirm-dev` — explicit CLI confirmation.
5. `SUPABASE_DATABASE_URL` present.
6. **Optional automated check**: if `EXPECTED_DEV_PROJECT_REF` is set, the project ref derived
   in-process from `SUPABASE_DATABASE_URL` must match — reported **boolean-only**; refuse on mismatch.

All guard checks happen **before** any Postgres client is constructed, so a missing guard refuses
**before any connection is attempted**. The runner can only *assert* the typed DEV target (the human
project name is not present in the connection URL); the optional ref-match is the strongest *automated*
DEV check available without a DB round-trip.

---

## 5. Down migration safety

`down` requires **all apply guards PLUS `--allow-down` PLUS `--confirm-dev`**, is **DEV-only**
(production hard-blocked), and prints a strong warning before executing:

> ⚠ DOWN MIGRATION — DEV ONLY. Never run a down migration against production. Never drop a populated
> `audit_event` in production without explicit approval, a verified backup, and a compliance review.

No automatic down-on-failure behaviour is added (re-running an idempotent up is the recovery path).
Down mode was **not run** in M10.2 QA.

---

## 6. Secret-safe logging

The runner **never** prints `SUPABASE_DATABASE_URL`, the derived project ref, the SQL file contents,
or any secret. Allowed safe output only: migration id, basename, direction, relative migration path,
the `CONFIRM_SUPABASE_TARGET` label, booleans (e.g. `expected dev project ref matched: true/false`),
and PASS/FAIL/REFUSED status. The error handler reports `err.message` only.

---

## 7. What M10.2 did NOT do

- **Did not apply** any migration.
- **Did not connect** to the database.
- **Did not run** any SQL.
- **Did not use** Supabase MCP.
- **Did not touch** production.
- **Did not change** runtime authorization, the durable audit runtime, protected business APIs,
  `/auth/session/resolve`, AccessContext/Login/AccessGuard/App, Firebase/Firestore, the M9 contracts,
  or the `001`/`002` SQL migration files.
- **Did not add** a migration ledger, a dependency, or a `package-lock.json` change.

---

## 8. Future owner-approved apply (separate operational step)

A real apply remains a **separate, owner-controlled operational step**, run in the Replit shell where
the secret exists. Example (DEV only):

```
ALLOW_SUPABASE_MIGRATION_APPLY=true CONFIRM_SUPABASE_TARGET=tmpos2026-dev \
  npx tsx scripts/supabase-migrate.ts --migration 002 --direction up --apply --confirm-dev
```

Optionally add `EXPECTED_DEV_PROJECT_REF=<dev-ref>` for the automated ref-match. A down rollback adds
`--allow-down`. **Applying any migration is an owner-controlled operational step, not UI QA**, and is
not performed as part of this milestone.

> Note: `002` is **already applied** to DEV (M10.1). The migration is idempotent, so a future re-apply
> via the runner is a safe no-op, but apply should still be a conscious, guarded owner action.

---

## 9. Migration ledger — deferred

No `schema_migrations` ledger is introduced. A ledger would require a new DB-applied migration plus
reconciliation for the already-manually-applied `001`/`002` (otherwise it would falsely report them
pending). Until then, **idempotent migrations + dry-run + (apply-mode-only) `to_regclass` pre-checks**
cover safety. A ledger, if wanted, is its own later milestone.

---

## 10. Backend Control Plane roadmap note

- The **Backend Control Plane remains planned** as a separate, future workstream — **not implemented
  now** and **not connected to live data**.
- Runner parameterization is **infrastructure hygiene only**: it connects no control-plane tool and
  adds no runtime authorization.
- It supports the **controlled, repeatable schema evolution** future control-plane work will need.
- When built, the control plane must be **API-only, fully audited, least-privilege, approval-gated**,
  and **must not** use the service-role key or direct-Postgres access from any tool runtime. This
  migration runner is an **operator CLI**, explicitly distinct from any runtime control-plane component.

---

## 11. QA evidence (Claude-run, no DB)

- New runner diagnostic `diagnostics-supabase-migrate-runner-check.ts` → **23/23 PASS** (15 static +
  8 behavioural; behavioural runs spawn the runner with `SUPABASE_DATABASE_URL` and all guard envs
  stripped — proving list/dry-run are DB-free, traversal is rejected, and apply refuses
  pre-connection).
- Manual safe runner checks (DB URL unset): `--list` ✓, `--dry-run 001/002` ✓, `--dry-run 002 down` ✓,
  `--dry-run ../x` refused ✓, `--apply` (no guards) refused ✓, down-apply (no `--allow-down`) refused ✓.
- M10 SQL diagnostics → **authorization 20/20**, **audit 15/15** PASS.
- M9 diagnostics → **authorization-contract 12/12**, **audit-event-contract 10/10** PASS.
- Backend regression → **M7 19/19**, **M6 15/15**, **M5 7/7**, **M3 23/23** (live identity check I1
  skipped in hermetic mode), **M2 8/8**, **M8 13/13** PASS.
- `npx tsc --noEmit` → **12 pre-existing baseline errors only; 0 in M10.2 files**.
- `npm run build` → **success**; runner/diagnostic **not bundled** into the client; **no server-only
  secret names / connection strings** in `dist/`.
- Static safety → no secret literals, no frontend imports, no MCP references in M10.2 files; runner
  never logs the DB URL/ref or full SQL.
- Forbidden-file diff → none (`.replit`, `package.json`, `package-lock.json`, `vite.config.ts`,
  `firestore.rules`, `src/**`, `server/index.ts`, migrations, runtime files, M9 contracts, existing
  M10/M10.1 docs all unchanged).

---

## 12. Rollback plan

Reversible by reverting `scripts/supabase-migrate.ts` and deleting the new diagnostic + this doc (no
migration applied, no schema/runtime/dependency change → nothing else to undo), mirroring the
file-only rollback pattern of M5/M6/M8/M9/M10.

---

## 13. Deferred items (after M10.2)

Actual migration **application** via the runner; migration **ledger** + reconciliation; Supabase
**CLI** adoption; **MCP**; in-runner git-state enforcement and apply-mode `to_regclass` pre-check;
RLS policies; durable **resolver**/**audit writer**; protected business APIs; `/auth/session/resolve`
authorization output; AccessContext adoption; Backend Control Plane; Hostinger/host decision; ORM;
Firebase→Supabase auth migration; any **production** migration.

---

**Not committed / not pushed / not backed up; no migration applied; no DB connection; no SQL run;
Supabase MCP not used; pending review.** Working tree contains only the allowed M10.2 changes
(`scripts/supabase-migrate.ts` modified; `scripts/diagnostics-supabase-migrate-runner-check.ts` and
this doc added).
