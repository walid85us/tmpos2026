# Phase 1.6 — Milestone 20: DEV-Only Identity Link Migration Apply Runbook

## 1. Title

Phase 1.6 Milestone 20 — DEV-Only `identity_link` Migration Apply Runbook (preparation only; the
migration is **not** applied in this milestone).

## 2. Purpose

Provide a redaction-safe, **non-executable** runbook and readiness report for a future, owner-approved,
**DEV-only** application of the already-committed `004_identity_link` migration files. This milestone
(M20.5) prepares the procedure, preconditions, verification, rollback, and acceptance criteria; it
applies nothing.

## 3. Accepted Checkpoint

- Accepted checkpoint commit: `c2ef3ec1ff8ec608c77bcacee8dbd2652c7bb802`
- Commit subject at base: "Phase 1.6 M20.4 add identity link migration files"
- This M20.5 runbook is additive documentation only; it modifies no existing file and applies no
  migration.

## 4. Scope and Non-Goals

**In scope:** a written DEV-only apply runbook — preconditions, owner-approval gate, future apply
procedure (prose), future verification, future rollback, expected schema/RLS/data state, failure/stop
conditions, and acceptance criteria for a later apply milestone.

**Non-goals (explicit):** the migration is **not** applied; no DDL/SQL executed; no DB write; no DB
connection in this pass; no runner/seed run; no change to `platform_identity`, existing tables, Firebase
auth, Supabase auth, session-resolve, or AccessContext; no runtime wiring; no Supabase MCP; no production;
no commit/push/backup as part of authoring.

## 5. Migration Files Covered

The committed, additive migration pair (created and backed up in M20.4):
- `server/platform-identity/migrations/004_identity_link.up.sql`
- `server/platform-identity/migrations/004_identity_link.down.sql`

These remain unmodified by this milestone. They create only the new `identity_link` table and its own
objects; they do not alter `platform_identity` or any existing table.

## 6. DEV-Only Apply Boundary

Any future apply is **DEV-only** (the Supabase DEV project) and owner-approved. Production is blocked.
The existing migration runner is intentionally hardcoded to the first migration and is not modified; the
004 apply is an owner-approved, separate step (e.g., a DEV SQL-editor paste or a later, separately-approved
runner parameterization). Supabase MCP is not used.

## 7. Pre-Apply Preconditions

Before a future apply, confirm (read-only):
- HEAD is at the accepted checkpoint and the 004 up/down files are present and unmodified.
- `identity_link` is currently **absent** in the DEV database.
- `platform_identity` and the existing baseline tables still exist.
- `NODE_ENV` is not production; the target is the DEV project only.
- No live-authorization process is running and no runtime consumes `identity_link`.
- Config presence is reported as booleans only; no connection string or secret is printed.

## 8. Required Owner Approval Before Apply

A future apply requires an explicit, separate owner approval that names the DEV target and authorizes a
single application of the committed 004 up migration. Absent that approval, the migration stays unapplied.

## 9. Safe Apply Procedure — Future Only

Described procedurally (non-executable):
- With owner approval, the **committed 004 up migration should be applied in DEV only**, exactly once.
- The apply should create schema only — the new `identity_link` table plus its own indexes, trigger,
  constraints, and RLS posture. It should insert no rows and modify no existing rows or tables.
- Immediately after, run the post-apply verification in §10.
- No copy-paste SQL, shell, runner, CLI, or DB-connection commands are included here by design.

## 10. Post-Apply Verification — Future Only

After a future apply, verify (read-only, metadata/aggregate only):
- `identity_link` exists with the intended columns, primary key, composite provider-reference foreign
  keys to `platform_identity`, the active-only partial-unique constraints, and the lookup indexes.
- RLS is **enabled** on `identity_link` and there are **zero** client-facing policies.
- No data rows exist in `identity_link` (apply is schema-only).
- `platform_identity` and the existing baseline tables are unchanged (no new/removed columns, same row
  counts as before the apply).
- No raw rows, real IDs, provider UIDs, emails, secrets, tokens, request IDs, actor UUIDs, or audit
  metadata are printed during verification.

## 11. Rollback Procedure — Future Only

Described procedurally (non-executable):
- If the apply must be reversed, the **committed 004 down migration should be applied in DEV only**.
- The rollback removes only `identity_link` and its own objects; it does not alter `platform_identity` or
  any other table, and it intentionally retains the shared `pgcrypto` extension and the shared updated-at
  helper.
- After rollback, verify `identity_link` is absent and all baseline tables remain unchanged.

## 12. Expected Schema After Apply

A single new table, `identity_link`, anchored on the stable app-owned `internal_user_id` (referencing
`platform_identity`), with a Firebase provider reference and a Supabase provider reference (each a
`(auth_provider, auth_provider_uid)`-style reference with a composite foreign key to `platform_identity`),
a lifecycle status, non-secret verification provenance, lifecycle timestamps, and optional decoupled
app-owned actor-provenance columns. Active-only partial-unique constraints prevent a provider reference
from being in more than one active link and prevent duplicate active pairs. No existing table is altered.

## 13. Expected RLS / Policy Posture After Apply

RLS enabled on `identity_link`, **zero client-facing policies**, with the same defense-in-depth REVOKE
posture as the existing tables. Provider references are server-only and never client-visible. The
server-side owner-role direct connection bypasses RLS; PostgREST/anon/authenticated get nothing.

## 14. Expected Data State After Apply

Schema-only: **no identity links inserted**, no existing rows modified, no data migration. `identity_link`
is empty after a clean apply. A future, separately-planned, verified-both-sides creation flow (or
controlled admin provisioning) would populate it later — not during apply.

## 15. Forbidden Runtime Conclusions

Applying 004 does **not** mean: identity mapping is active; the frontend should consume server
authorization; AccessContext or session-resolve should change; Firebase session authority is replaced;
server authorization is advisory-ready beyond presence-only or authoritative; or that M14/M15/M17.1 should
be wired into runtime. Apply creates dormant schema only.

## 16. Forbidden Data Exposure

No real Firebase/Supabase/provider UID, real `internal_user_id`, email, tenant/store/role/plan value,
token, Authorization header, request header/body, raw response, DB URL, service-role key, anon-key value,
secret, request ID, actor UUID, audit metadata, audit row dump, raw authorization object, or permission
key list may be printed during any apply/verification.

## 17. DB Safety Rules

DEV target only; one-time apply; schema-only; no INSERT/UPDATE/DELETE/UPSERT of data; no ALTER of existing
tables; append-only audit table remains untouched; read-only verification with aggregate/metadata only; no
connection string or secret printed; no Supabase MCP; production blocked.

## 18. Audit / Evidence Notes

`audit_event` already exists (append-only). A future identity-link **creation/change/revocation** flow
should be audited via the existing append-only writer, using a **new, separately-planned** identity-link
audit event kind with redacted detail (no raw provider UIDs/emails). The apply itself is schema-only and
writes no audit rows.

## 19. Reconciliation Notes for Existing Aggregate Evidence

From M20.2 (aggregates only; planning evidence, **not** linking authority):
- total `platform_identity` rows: 3
- supabase rows: 2; firebase rows: 1
- shared descriptive-email group count: 1; max shared descriptive-email group size: 2

The single shared-email correspondence is a **candidate** for a future verified link, but a link may be
created only with server-verified evidence on **both** provider sides — never from email alone and never
from a client-asserted UID. Reconciliation is a future, controlled, audited, reversible step — not part of
apply.

## 20. Failure / Stop Conditions

Stop and report (do not improvise) if, during a future apply: `identity_link` already exists unexpectedly;
the apply would alter an existing table; the apply attempts any data insert; RLS is not enabled or any
client policy appears; a baseline table's shape or row count changes; a Replit auto-checkpoint commits
`.replit`/`.gitattributes`/the goose tarball; or any secret/real identifier would be exposed.

## 21. Future Acceptance Criteria for M20.6 DEV Apply

A future DEV apply passes only if: applied in DEV with explicit owner approval; `identity_link` created
with the intended schema/constraints/indexes; RLS enabled with zero client policies; zero data rows
inserted; no existing table altered; baseline tables and row counts unchanged; the down migration cleanly
reverses (verified separately or by design); no secret/real identifier exposed; production untouched; and
no runtime wiring introduced.

## 22. Security / Redaction Boundary Confirmation

This runbook records only safe procedural language, conceptual schema descriptions, source-level provider
labels, and the M20.2 aggregate counts. It contains **no executable SQL or commands**, and **no** real
IDs, UIDs, emails, secrets, tokens, DB URLs, request IDs, actor UUIDs, audit metadata, or raw
authorization content.

## 23. Recommended Next Milestones

- `Phase 1.6 M20.5 — Scoped Commit and Backup Authorization` (commit/back up this runbook, owner-gated).
- `Phase 1.6 M20.6 — DEV-Only Identity Link Migration Apply (owner-approved)` — a future, separately-
  approved milestone that applies the committed 004 up migration in DEV only (schema-only), then performs
  read-only post-apply verification, with no runtime wiring. Identity-link creation flow, the audit event
  kind, and any runtime integration remain separate later milestones.
