# Phase 1.6 — Milestone 20: DEV Identity Link Migration Apply Evidence

## 1. Title

Phase 1.6 Milestone 20 — DEV-Only `identity_link` Migration Apply Evidence (M20.6 result record;
redaction-safe; documentation-only).

## 2. Purpose

Preserve, in a repository-durable and redaction-safe form, the verified evidence that the committed
`004_identity_link` up migration was applied **once, schema-only, to the DEV database** in M20.6, that the
additive `identity_link` table was created exactly as designed, and that no existing data or table was
changed. This milestone (M20.7) records evidence only; it applies nothing and connects to nothing.

## 3. Repository Checkpoint

- Repository checkpoint at record time: `61c44b9d166742d354c93659f8cd0ee8a3fce0e4`
- Commit subject at base: "Phase 1.6 M20.5 document DEV identity link apply runbook"
- M20.6 made **no** repository changes (DB-only apply); this M20.7 evidence file is additive
  documentation only.

## 4. Scope and Non-Goals

**In scope:** a written, redaction-safe record of the M20.6 DEV apply (pre/post schema, constraints,
indexes, RLS posture, data state, and boundary confirmations).

**Non-goals (explicit):** no migration applied; no SQL/DDL executed; no DB connection in this pass; no DB
write; no change to migration files, source, runtime, `platform_identity`, existing tables, Firebase auth,
Supabase auth, session-resolve, or AccessContext; no runtime wiring; no Supabase MCP; no production; no
commit/push/backup as part of authoring.

## 5. M20.6 Apply Summary

- M20.6 applied the **already-committed** `004_identity_link.up.sql` to the **DEV database only**, exactly
  once. The migration file was **unchanged from HEAD** at apply time.
- **Apply result: SUCCESS.** (The only emitted messages were benign idempotency NOTICEs — `pgcrypto`
  already present; `drop trigger if exists` no-op.)
- The migration created the additive `identity_link` table and only its own related objects.

## 6. DEV Target Boundary

The apply targeted the project's single configured **DEV** database; `NODE_ENV` was non-production. No
connection string or secret was printed. Production was not targeted and remains blocked.

## 7. Pre-Apply Evidence

Read-only pre-apply checks (booleans/counts only):
- `platform_identity` existed; `audit_event` existed; **`identity_link` did not exist** (decision:
  proceed).
- `platform_identity` row count: **3** (provider distribution: `supabase = 2`, `firebase = 1`).
- `audit_event` row count: **6**.
- Baseline public tables: **7**.

## 8. Migration Applied

- File: `server/platform-identity/migrations/004_identity_link.up.sql` (committed; unchanged from HEAD).
- Applied once via the existing configured DEV connection mechanism. No file modification; no extra SQL
  beyond the committed migration and read-only verification.

## 9. Post-Apply Schema Evidence

- `identity_link` **exists**; `platform_identity` still exists; all existing baseline tables remained
  present.
- `identity_link` includes the intended schema areas:
  - link primary key (`link_id`);
  - stable `internal_user_id` anchor;
  - Firebase provider reference columns (`firebase_auth_provider`, `firebase_auth_provider_uid`);
  - Supabase provider reference columns (`supabase_auth_provider`, `supabase_auth_provider_uid`);
  - status / lifecycle column (`status`);
  - verification / provenance metadata columns (`verification_method`, `provenance_note`);
  - created / updated timestamp columns (`created_at`, `updated_at`);
  - disabled / revoked lifecycle timestamp columns (`disabled_at`, `revoked_at`) plus optional app-owned
    actor-provenance columns.

## 10. Post-Apply Constraint and Index Evidence

- **Primary key** present (`identity_link_pkey`).
- **Three foreign keys**, all referencing `platform_identity`: the anchor FK
  (`identity_link_internal_user_id_fkey`) plus the Firebase and Supabase provider-reference FKs
  (`identity_link_firebase_ref_fk`, `identity_link_supabase_ref_fk`).
- **Active-only partial unique indexes** present (`uq_identity_link_active_firebase`,
  `uq_identity_link_active_supabase`, `uq_identity_link_active_pair`) — one active link per provider
  reference and no duplicate active pair, while retaining history.
- **Lookup indexes** present (`idx_identity_link_internal_user_id`, `idx_identity_link_firebase_uid`,
  `idx_identity_link_supabase_uid`, `idx_identity_link_status`).
- CHECK constraints present for NOT NULL columns, provider labels, status, and verification method.

## 11. Post-Apply RLS / Policy / Privilege Evidence

- **RLS enabled** on `identity_link`.
- **Client-facing policy count: 0.**
- **Client-role grants (anon/authenticated/PUBLIC): 0** (REVOKE effective). Provider references are
  server-only and not client-visible.

## 12. Post-Apply Data-State Evidence

- `identity_link` row count: **0** — no identity links were inserted (schema-only).
- `platform_identity` count: **3** (unchanged; provider distribution `supabase = 2`, `firebase = 1`).
- `audit_event` count: **6** (unchanged — the apply wrote no audit rows).
- No existing application data rows were inserted, updated, or deleted.

## 13. Runtime and Route Boundary Evidence

- No existing table was altered beyond creating `identity_link` and its own objects.
- No runtime/source files changed; no route was called; no live authorization was enabled; the `:5002`
  identity API was not running; no M15 harness, M14 feed, M11 token bridge, or comparison was invoked; no
  Supabase MCP was used.
- Working tree and Git HEAD remained unchanged at `61c44b9d166742d354c93659f8cd0ee8a3fce0e4`.

## 14. Security / Redaction Boundary

This evidence record contains only table names, column names, constraint/index names, booleans, aggregate
counts, and safe high-level statements. It contains no DB connection string, env values, secrets,
service-role/anon keys, tokens, headers/body, raw identity/audit rows, real Firebase/Supabase/provider
UIDs, `internal_user_id` values, emails, tenant/store/role/plan values, actor UUIDs, request IDs, audit
metadata, permission/entitlement key names, mismatch lists, raw authorization output, executable SQL, or
shell/runner commands.

## 15. Explicitly Forbidden Conclusions

This record does **not** claim: that identity mapping is implemented; that identity links exist; that
Firebase and Supabase identities are now mapped; that email is safe as identity authority; that a
client-supplied UID is safe as authority; that the M17 Supabase pilot user equals the Firebase app user;
that active-context alignment is solved; that context hints are safe now; that server authorization is
advisory-ready beyond presence-only; that server authorization is authoritative; that the frontend should
consume server authorization now; that AccessContext or session-resolve should change now; that Firebase
session authority is replaced; that production enablement is ready; or that M14/M15/M17.1 should be wired
into runtime.

It affirms: the schema exists in **DEV only**; the table is **empty**; **no identity links were
inserted**; identity mapping remains **inactive and unwired**; Firebase/legacy AccessContext remain
authoritative; server-derived authorization remains observational/comparable only; email must not be
identity authority; client-asserted UID must not be authority; `internal_user_id` remains the app-owned
stable anchor; any future identity-link creation flow must be separately designed, audited, verified,
approved, and tested; the M11→M15 + M17.1 path remains dormant; and production remains blocked.

## 16. Acceptance Criteria Result

The M20.6 DEV apply met its acceptance criteria: applied in DEV with owner approval; `identity_link`
created with the intended schema, primary key, three `platform_identity` foreign keys, active-only
partial-unique constraints, and lookup indexes; RLS enabled with zero client policies and zero client-role
grants; zero data rows inserted; no existing table altered; baseline tables and row counts unchanged
(`platform_identity` 3→3, `audit_event` 6→6); no secret/real identifier exposed; production untouched; no
runtime wiring introduced. **Result: PASS.**

## 17. Remaining Deferred Work

Deferred to future, separately-approved milestones: the verified-both-sides identity-link **creation
flow**; a dedicated identity-link **audit event kind**; reconciliation of the existing shared-email
correspondence (with server-verified evidence on both sides, never email-as-authority); and any
**runtime integration** (which would remain DEV-only, default-OFF, and authority-path-free until
separately approved). Active-context alignment, advisory adoption, shadow-at-scale, and authoritative use
all remain deferred.

## 18. Recommended Next Milestones

- `Phase 1.6 M20.7 — Scoped Commit and Backup Authorization` (commit/back up this evidence doc,
  owner-gated).
- `Phase 1.6 M20.8 — Identity Link Creation Flow Planning` (design-only) — define the future
  verified-both-sides creation/audit flow before any row is ever inserted. No runtime wiring until
  separately approved.
