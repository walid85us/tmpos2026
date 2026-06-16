# Phase 1.5 M10.1 — DEV Migration Applied Record

Status: **APPLIED TO DEV / VERIFIED.** Owner-run, DEV-only application of the durable
authorization + append-only audit foundation migration (`002`). Docs-only record;
no code, schema, runtime, or production change.

---

## 1. Application metadata

| Field | Value |
|-------|-------|
| Git checkpoint before application | `aff22684790a946a6d18933b2025a82da7e76271` (Phase 1.5 M10) |
| Applied migration | `server/platform-identity/migrations/002_authorization_audit_foundation.up.sql` |
| Method | Owner-run **Supabase SQL Editor** |
| Supabase project | `tmpos2026-dev` |
| Environment | **DEV only** |
| Production | **Not touched** |
| Down migration | **Not run** |
| Supabase MCP | **Not used** |
| Replit / Claude SQL execution | **Not used** (Claude did not run SQL, no Replit DB connection) |
| Migration runner (`scripts/supabase-migrate.ts`) | **Not used / not modified** (remains hardcoded to `001`) |
| DEV snapshot / PITR marker | **Confirmed by owner** before application |

---

## 2. Pre-check summary (read-only, before application)

- `platform_identity_exists = true` — `001` was already applied; the `app_user` FK target existed.
- All six M10 tables were **absent** before application:
  `app_user = false`, `tenant = false`, `store = false`, `user_membership = false`,
  `tenant_feature_entitlement = false`, `audit_event = false`.

---

## 3. Application summary

- Migration **ran successfully** — YES.
- **No SQL Editor error** reported.
- **No seed / demo / production rows** inserted (structure-only migration; the up file contains no `INSERT`).

---

## 4. Verification summary (owner-reported, DEV SQL Editor)

- **Seven tables exist** after application: `platform_identity` plus the six M10 tables
  (`app_user`, `tenant`, `store`, `user_membership`, `tenant_feature_entitlement`, `audit_event`).
- **RLS enabled** on all six M10 tables.
- **Zero RLS policies** for the six tables (`policy_count = 0`) — deny-all posture preserved.
- **Zero direct grants** to `anon` / `authenticated` on the six tables.
- **Audit append-only enforcement present**: trigger `trg_audit_event_reject_mutation` and
  function `reject_audit_event_mutation` both exist.
- **`updated_at` triggers on mutable tables only**: `app_user`, `tenant`, `store`,
  `user_membership`, `tenant_feature_entitlement` (the pre-existing `platform_identity`
  trigger is also present and acceptable). **No `updated_at` trigger on `audit_event`** (immutable).
- **`audit_event` has no foreign keys** (`audit_event_fk_count = 0`) — decoupled / append-only.
- **Audit metadata constraints exist**: `audit_event_metadata_object_chk`,
  `audit_event_metadata_flat_chk`, `audit_event_metadata_no_forbidden_keys_chk`.
- **All six new tables have zero rows.**
- **Production not touched**; **down migration not run** — confirmed by owner.

---

## 5. Explicitly deferred (not done by M10.1)

- No runtime authorization **resolver** wired.
- `/auth/session/resolve` still returns `authorization: null` (M7 endpoint unchanged).
- No durable audit **writer** wired.
- No protected **business API** wired.
- No **AccessContext / frontend** adoption of the new tables.
- No **RLS policies** added (deny-all retained).
- No **Backend Control Plane** implemented.
- No **production** migration applied.
- No **migration-runner parameterization** (runner still hardcoded to `001`).
- No **seed data**.

---

## 6. Rollback note

- The down migration `server/platform-identity/migrations/002_authorization_audit_foundation.down.sql`
  **exists but was not run**.
- Rollback in **DEV** requires **separate owner approval**.
- ⚠ **Never drop a populated `audit_event` table in production** without explicit owner approval,
  a verified backup, and a compliance review — doing so destroys durable compliance evidence
  (7-year financial/audit retention direction).

---

## 7. Next recommended step

1. **Commit** this docs-only applied-state record after owner review.
2. **Back up** to GitHub (`npm run backup:github`).
3. A future **M10.2** may plan migration-runner parameterization, but it is **not required** for this
   applied-state record and remains optional/deferred.

---

**Docs-only record. No code, SQL, schema, RLS, runtime, frontend, dependency, or production change
was made in this pass. Migration application was performed earlier by the owner in the Supabase DEV
SQL Editor; this file records that accepted, verified state.**
