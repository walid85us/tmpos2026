# Phase 1.5 — Milestone 10: Durable Authorization + Append-Only Audit SQL Migration (Option C)

Status: **Implemented locally — NOT committed, NOT pushed, NOT backed up, NOT applied. Pending review.**
Owner UI QA: **not required** (migration-file-only; no visible UI change).

Checkpoint before M10: `df089d3388825a3b60a90dd11dfff505e7292d4a` ("Phase 1.5 M9 authorization audit contracts").

---

## 1. M10 scope

M10 adds **reviewed, unapplied SQL migration files** plus **pure SQL diagnostics** and this document
for the durable, server-authoritative **authorization** model and a durable **append-only audit**
table declared by the M9 contracts. It is **migration-file-only**: it creates files, applies
nothing, wires no runtime, and modifies no existing file.

### Option C selection

Per the accepted M10 planning pass, **Option C — migration-file-only foundation** was selected: the
M9 contracts are mature enough to generate SQL from, and the 001 migration supplies a proven security
pattern (UUID PKs, RLS deny-all, trigger, comments, pgcrypto). Options A/B (more design) were
unnecessary; D (apply migrations) is a separate owner-approved step; E/F/G/H (runtime/endpoint/
AccessContext/control-plane) are out of scope and disallowed now.

### Files added (exactly five)

- `server/platform-identity/migrations/002_authorization_audit_foundation.up.sql`
- `server/platform-identity/migrations/002_authorization_audit_foundation.down.sql`
- `scripts/diagnostics-authorization-schema-check.ts` (pure/offline; parses the SQL text)
- `scripts/diagnostics-audit-schema-check.ts` (pure/offline; parses the SQL text)
- `docs/phase-1.5-milestone-10-authorization-audit-sql-migration.md` (this file)

### Files modified

- **None.** Purely additive, mirroring the M9 additive precedent.

### Explicitly NOT done

No migration applied; no runtime wiring; no `/auth/session/resolve` change; no AccessContext/Login/
AccessGuard/App/Firebase/Firestore change; no M7/M8/M9 change; no business API; no dependency/package
change; no Supabase MCP/config/Auth/schema/RLS change; no Backend Control Plane work; no seed/demo/
production data; no runner modification.

---

## 2. Migrations were NOT applied

These SQL files are **not executed** against any database by this milestone. Nothing in the codebase
imports or runs them at runtime. Application against the Supabase **DEV** project is a **separate,
owner-approved step**.

### Existing runner gap

`scripts/supabase-migrate.ts` is **hardcoded to `001_platform_identity`** (it only toggles up/down for
that one file). It is intentionally **not modified in M10**. Applying `002` later requires **one** of:

1. **Supabase SQL Editor paste** — paste `002_authorization_audit_foundation.up.sql` into the DEV
   project's SQL editor (the runner doc already documents manual paste as an equally valid path); or
2. **A later, separately-approved runner parameterization** — a small change letting
   `supabase-migrate.ts` accept a migration name.

Either is a distinct, owner-controlled action outside M10.

---

## 3. Full schema summary

`002…up.sql` creates six **singular** tables (matching `platform_identity`), all with **RLS enabled,
no policies**, and explicit `REVOKE ALL … FROM public, anon, authenticated` (defense-in-depth). UUID
PKs use `gen_random_uuid()` (except `app_user.internal_user_id`, which is the 1:1 FK to
`platform_identity`). Status/role/scope/decision vocabularies are **`text` + `CHECK`** (no Postgres
enums), mirroring 001 and keeping the TS contracts as the source of truth. Three shared helper
functions are created: `set_updated_at_timestamp()` (mutable-table `updated_at` trigger),
`audit_metadata_is_flat(jsonb)` (immutable flatness guard), and `reject_audit_event_mutation()`
(append-only enforcement). `pgcrypto` is created defensively (idempotent; not dropped on rollback).

---

## 4. Table-by-table explanation

- **`app_user`** — app-owned durable user, **1:1 with `platform_identity`**. `internal_user_id` is the
  PK **and** FK → `platform_identity(internal_user_id) ON DELETE CASCADE`. `status` (account-status
  CHECK), `display_name`, timestamps, `updated_at` trigger, `idx_app_user_status`. No provider token,
  no raw provider uid, no secret.
- **`tenant`** — `tenant_id` (UUID PK), `display_name`, `legal_name`, `plan_key`
  (`starter|growth|advanced` CHECK), `status` (account-status CHECK), timestamps, `updated_at`
  trigger. The plan/feature **catalog stays in code**; this stores the assignment.
- **`store`** — `store_id` (UUID PK), `tenant_id` FK → `tenant` `ON DELETE CASCADE`, `store_name`,
  `status`, timestamps, `updated_at` trigger, `idx_store_tenant_id`.
- **`user_membership`** — `(user × tenant? × store?) → role_id` at `platform|tenant|store` scope.
  FKs to `app_user`/`tenant`/`store` (cascade). `role_id` is a **text constant** (no durable role
  table yet). **Scope-consistency CHECK** (platform → both null; tenant → tenant set, store null;
  store → both set) and **role/scope CHECK** (platform roles only at platform scope; tenant roles only
  at tenant/store scope). **`UNIQUE NULLS NOT DISTINCT (internal_user_id, scope_type, tenant_id,
  store_id, role_id)`** forbids exact duplicate grants (does **not** hard-limit to one active role per
  scope — that stays a resolver rule). Indexes on `internal_user_id`, `tenant_id`, `store_id`.
- **`tenant_feature_entitlement`** — `(tenant × feature_key) → enabled` with `source`
  (`plan|default|manual` CHECK). `UNIQUE (tenant_id, feature_key)`, `idx_…_tenant_id`. No rows seeded;
  plan-derived materialization deferred.
- **`audit_event`** — durable append-only audit (see §6–§8).

---

## 5. RLS / revoke / direct browser-access posture

- **RLS enabled on all six tables, no policies** → deny-all to `anon`/`authenticated` (the
  `platform_identity` pattern). The server reaches them via the **owner-role direct-Postgres
  connection** (`SUPABASE_DATABASE_URL`), which bypasses RLS.
- **Explicit `REVOKE ALL … FROM public, anon, authenticated`** per table — defense-in-depth so
  PostgREST + the anon key can never read/write these tables.
- **The frontend never calls these tables directly**; all access flows through the authenticated,
  audited API. **The API layer is the primary guard; RLS + revoke are defense-in-depth.**
- No RLS helper functions, no JWT-claim policies: future policies (a later slice) will key off the
  app-managed authorization tables, **not** raw JWT role claims.

---

## 6. Audit append-only strategy

`audit_event` is **INSERT + SELECT only**. Immutability is enforced by:

1. **RLS deny-all** + explicit revokes (no anon/authenticated access).
2. A **`BEFORE UPDATE OR DELETE` trigger** (`trg_audit_event_reject_mutation`) calling
   `reject_audit_event_mutation()`, which `RAISE EXCEPTION`s. The trigger fires for **every** role —
   including the table-owner/server connection that bypasses RLS — so rows are immutable once inserted.
3. **No `updated_at` column or trigger** on `audit_event` (rows never change).

The fail-closed write strategy (`AUDIT_WRITE_FAILURE_STRATEGY` from the M9 contract) is an
application-runtime concern, documented now and implemented in a later durable-audit-writer slice.

---

## 7. Audit metadata redaction strategy

`metadata` is a flat `jsonb` column. The DB enforces, as **defense-in-depth**:

- `jsonb_typeof(metadata) = 'object'`;
- **no forbidden top-level keys** (`accessToken`, `refreshToken`, `rawJwt`, `jwtPayload`, `jwks`,
  `serviceRoleKey`, `databaseUrl`, `connectionString`, `password`, `rawDbError`, `pan`, `cardNumber`,
  `providerSecret`) via `metadata ?| array[…]`;
- **flatness** (no nested object/array values) via the immutable `audit_metadata_is_flat(metadata)`.

A DB CHECK **cannot** catch a forbidden *value* placed under an allowed key, nor reliably police deep
nesting — therefore **application allow-listing + redaction (`AUDIT_METADATA_ALLOWLIST`) remains the
PRIMARY guard**. Both layers are required.

---

## 8. Audit FK decoupling rationale

`audit_event` declares **no foreign keys**; `actor_internal_user_id`, `tenant_id`, and `store_id` are
plain UUID columns. Reasons: (1) **immutability** — FK `ON DELETE CASCADE/SET NULL` would attempt to
mutate audit rows and collide with the append-only reject trigger; (2) **compliance independence** —
audit must survive deletion of the referenced operational rows (7-year retention direction).
Referential integrity for audit is an **application guarantee**, documented in the column comments.

---

## 9. Down migration / rollback warning

`002…down.sql` is **DEV rollback only**. It drops the audit trigger/function, the `updated_at`
triggers, then the six tables in **reverse dependency order** (`audit_event` → `tenant_feature_
entitlement` → `user_membership` → `store` → `tenant` → `app_user`), then the three helper functions.
It **does not drop `pgcrypto`** (shared utility; matches 001).

> ⚠ **Never drop a populated `audit_event` in production** without a separate, explicit owner
> approval, a verified backup, and a compliance review — doing so destroys durable compliance
> evidence. In M10 nothing is applied and nothing is seeded, so the up/down pair is a clean reversal.

---

## 10. No seed / demo / production data

The migration creates **structure only**. No `INSERT` exists; no tenant/store/user/membership/
entitlement/audit rows are created. Seeding (including any plan-derived entitlement materialization)
is deferred to later, separately-approved slices.

---

## 11. No runtime wiring

No file imports or executes the SQL at runtime. `server/index.ts`, the identity sidecar
(`server.ts`, `protectedAction.ts`, `permissionDecision.ts`, `auditEnvelope.ts`, repositories), and
the M7 route are untouched. The two new diagnostics are standalone (`npx tsx`), not wired into any
server. No new dependency; `tsc`/build behavior is unchanged.

---

## 12. No `/auth/session/resolve` change

The M7 endpoint stays dev-only / default-off / prod-force-disabled and continues to return
`authorization: null` (`RUNTIME_SESSION_RESOLVE_AUTHORIZATION`). M10 creates schema but wires nothing
into the resolver. `sessionResolve.ts` / `sessionResolveContract.ts` are unchanged.

---

## 13. No AccessContext / frontend change

`AccessContext.tsx`, `AccessGuard.tsx`, `Login.tsx`, `App.tsx`, `src/firebase.ts`, `src/auth/**`,
`src/pilot/**`, `src/context/accessConfig.ts`, and `src/owner/platformPermissionsConfig.ts` are
untouched. Authorization stays client/UI-gated; no client consumer of the new tables exists. No bundle
impact (SQL/scripts/docs are not imported by the client).

---

## 14. Backend Control Plane roadmap note

- The future **Backend Control Plane remains planned** as a separate workstream.
- **It is NOT implemented in M10. No control-plane tool is connected. It is not connected to live data.**
- **Durable authorization schema and durable audit schema are prerequisites** for it — M10 supplies
  their *files* (not their runtime).
- `/auth/session/resolve` is **one prerequisite/access contract** for it.
- When built it must be **API-only, fully audited, least-privilege, and approval-gated**, and **must
  not** use the service-role key or direct Postgres access from any tool runtime.

---

## 15. Supabase MCP scope

**Not used.** No Supabase MCP, no Supabase configuration, no Auth-settings/schema/RLS change. M10
produces SQL **files**; it does not touch the live Supabase project.

---

## 16. Hostinger / deployment scope

**Not now.** Per the Phase 1.4 gate: Hostinger = static frontend/marketing/demo only; Replit =
dev-only; Supabase Postgres = production DB direction. M10 makes no production host decision.

---

## 17. Prisma / ORM strategy

**Deferred.** Phase 1.4 chose SQL-first/Supabase migrations with ORM deferred. The identity sidecar
keeps using the direct `postgres` helper. No ORM introduced in M10.

---

## 18. QA evidence (Claude-run)

- `diagnostics-authorization-schema-check.ts` → **20/20 PASS**.
- `diagnostics-audit-schema-check.ts` → **15/15 PASS**.
- M9 `diagnostics-authorization-contract-check.ts` → **12/12 PASS**; `diagnostics-audit-event-contract-check.ts` → **10/10 PASS**.
- `npx tsc --noEmit` → pre-existing baseline errors only; **0 errors in M10 files**.
- `npm run build` → **success**; no SQL/script/doc imported into the client bundle; no secret bundled.
- Backend regression — M7 19/19, M6 15/15, M5 7/7, M3 23/23 (live skip if applicable), M2 8/8, M8 13/13.
- Static safety — M10 files: no secret values, no env reads, no DB/network/Supabase/Firebase imports,
  no migration-application command, no `GRANT … TO anon/authenticated`, RLS enabled on every table,
  no `CREATE POLICY`, explicit REVOKEs, audit reject trigger present, no forbidden audit columns.
- Runtime isolation — M10 files imported by nothing; no AccessContext/AccessGuard/Login/App/pilot/
  business/server-runtime/endpoint reference.
- Forbidden-file diff — none.

*(Exact run output is reported in the implementation message accompanying this milestone.)*

---

## 19. Rollback plan

Reversible by **deletion** of the five new files (no migration applied, no schema/RLS/runtime/
dependency change → nothing else to undo), mirroring the M5/M6/M8/M9 rollback pattern. If a future,
separately-approved step *applies* `002`, rollback is `002…down.sql` against DEV, with the
production-audit guard of §9.

---

## 20. Deferred items (after M10)

Migration **application**; runner parameterization; RLS policies; durable per-tenant role/permission
**override** tables and a durable `role` table; DB-normalized permission/feature/plan **catalogs**;
plan→entitlement **materialization/seeding**; the durable authorization **resolver**; durable audit
**writer** (fail-closed runtime); wiring authorization into `/auth/session/resolve`; protected business
APIs; AccessContext consuming server authorization; shared-catalog code unification touching `src/`;
Backend Control Plane; Supabase MCP/config; Hostinger/production host decision; ORM; Firebase→Supabase
auth migration.

---

**Not committed / not pushed / not backed up; migration not applied; pending review.** Working tree
contains only the allowed five uncommitted M10 files.
