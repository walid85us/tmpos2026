# Phase 1.5 — Milestone 11.1: Platform Role Vocabulary Alignment + DEV Bootstrap Templates

**Status:** Implemented (file-only). Not committed, not pushed, not backed up. Pending owner review.
**Accepted option:** Option E — file-only role-vocabulary alignment migration (003) + DEV bootstrap templates.

## Scope

M11.1 resolves the platform-role vocabulary drift between the durable DB and the
contract/frontend/resolver, and provides DEV bootstrap data templates, **without
applying anything**. It is purely additive: new files only, no existing file modified.

This pass made:

- **No DB connection.**
- **No SQL run.**
- **Migration 003 not applied.**
- **Seed/bootstrap not applied.**
- **No Supabase MCP.**
- **No runtime wiring.** `/auth/session/resolve` still returns `authorization: null`.
- **No frontend / AccessContext change.**

## Files added

| File | Purpose |
|---|---|
| `server/platform-identity/migrations/003_platform_role_vocabulary_alignment.up.sql` | Aligns the platform-scope `user_membership.role_id` CHECK to canonical roles |
| `server/platform-identity/migrations/003_platform_role_vocabulary_alignment.down.sql` | DEV rollback to the legacy 002 vocabulary |
| `server/platform-identity/seeds/dev_bootstrap_platform_owner.example.sql` | DEV-only owner-run bootstrap seed template (outside migrations dir) |
| `server/platform-identity/seeds/dev_bootstrap_rollback.example.sql` | DEV-only owner-run bootstrap cleanup template |
| `scripts/diagnostics-role-vocabulary-alignment-check.ts` | Offline static validator (no DB) |
| `docs/phase-1.5-milestone-11.1-platform-role-vocabulary-and-bootstrap.md` | This record |

No existing files were modified. 002 (already applied to DEV) was **not** edited.

## Canonical platform role decision

Canonical platform roles:

- `system_owner`
- `support_admin`
- `billing_admin`
- `operations_admin`
- `security_admin`

Tenant/store roles (unchanged): `store_owner`, `manager`, `technician`, `sales_staff`.

### Why the DB aligns to M9/frontend, not the reverse

The canonical set is already the single source of truth across the live frontend
engine (`src/context/accessConfig.ts` `Role`, `src/owner/platformPermissionsConfig.ts`
keyed defaults), the M9 contract (`authorizationConstants.PLATFORM_ROLE_IDS`), and the
M11 resolver. The legacy set (`platform_owner|platform_admin|platform_ops|platform_support|platform_readonly`)
appears **only** inside the 002 CHECK constraint and its comments — nowhere else.
Aligning DB → contract therefore touches the least code (one CHECK, via a new
migration) and changes no runtime behaviour. Aligning the other direction would
ripple through the entire frontend matrix, M9, and M11 — high risk, rejected.

### Why `platform_admin` is removed

`platform_admin` has no honest canonical target: its authority is undefined and it is
superseded by the four explicit named admins. Silently remapping it could over- or
under-grant authority, so it is **not** auto-mapped. Any surviving `platform_admin`
row makes the 003 up CHECK fail loudly, forcing manual review.

### Why `platform_readonly` is removed / deferred

Read-only is already modeled by account/status (`app_user.status`/`tenant.status`/
`store.status` = `read_only`), which the M11 resolver already honors (read-only
limiting). A dedicated read-only platform role is therefore redundant and is
**deferred**; if ever needed it must be added to the M9 contract first, then the DB.
`platform_readonly` is **not** auto-mapped (loud fail if present).

## 003 migration overview

Order of operations (both directions): **drop CHECK → map roles → add CHECK**.
Mapping must run after the drop because mapping legacy→canonical would otherwise
violate the still-active legacy CHECK. Idempotent and safe to re-run.

Up:
1. `drop constraint if exists user_membership_role_scope_chk`.
2. Forward-map the three unambiguous legacy roles (platform scope).
3. `add constraint user_membership_role_scope_chk` allowing canonical platform + tenant roles.
4. `comment on column user_membership.role_id` documenting canonical roles + status-based read-only.

The 002 scope-consistency CHECK (`user_membership_scope_consistency_chk`) is left untouched.

### Data mapping table

| Legacy (002) | Canonical (003) | Action |
|---|---|---|
| `platform_owner` | `system_owner` | auto-map |
| `platform_support` | `support_admin` | auto-map |
| `platform_ops` | `operations_admin` | auto-map |
| `platform_admin` | — | **no auto-map** — CHECK fails loudly if present |
| `platform_readonly` | — | **no auto-map** — CHECK fails loudly if present; use status `read_only` |
| — | `billing_admin` | new canonical role (no legacy source) |
| — | `security_admin` | new canonical role (no legacy source) |

DEV is empty (M10.1 verified 0 rows), so the mapping is clean there. The migration is
still written prod-safe (idempotent + loud-fail on un-mappable rows) even though
production is not applied here.

### 003 apply runbook (future, owner-approved only)

- Separate, owner-approved operational step. **DEV first** (`tmpos2026-dev`). Production untouched.
- May use the guarded runner after review:
  - Dry-run (DB-free): `npx tsx scripts/supabase-migrate.ts --dry-run --migration 003 --direction up`
  - Apply (DEV, all guards required): `npx tsx scripts/supabase-migrate.ts --migration 003 --direction up --apply --confirm-dev` with `NODE_ENV != production`, `ALLOW_SUPABASE_MIGRATION_APPLY=true`, `CONFIRM_SUPABASE_TARGET=tmpos2026-dev`.
- Or paste `003_…up.sql` into the Supabase SQL Editor (DEV project).

### 003 rollback runbook

- **DEV only.** Reverse-maps the three unambiguous roles, restores the legacy CHECK.
- **Fails loudly** if `billing_admin`/`security_admin` platform rows exist (no legacy equivalent) — manual review required.
- **Never deletes `audit_event`.** Not for production without a verified backup + compliance review.

## Bootstrap seed strategy

The seed is an **owner-run example template**, not a migration and not runner-driven.
It creates the minimum durable rows a future read-only resolver/live diagnostic needs:
one `app_user` (active), one `tenant`, one `store`, a platform owner membership
(`system_owner`), optional tenant/store owner memberships, and a tiny example
entitlement set.

### Bootstrap input requirements

- Owner provides `auth_provider` + `auth_provider_uid` (the `(auth_provider, auth_provider_uid)`
  pair is UNIQUE on `platform_identity`, so the lookup matches at most one row — no ambiguity).
- Deterministic DEV UUID literals for tenant/store (kept stable across re-runs).
- No secrets of any kind (no connection string, service role key, password, token, JWT).

### Bootstrap idempotency strategy

- `app_user`: `on conflict (internal_user_id) do nothing`.
- `tenant`/`store`: deterministic UUID literals + `on conflict (<pk>) do nothing`.
- `user_membership`: `on conflict on constraint user_membership_unique_grant do nothing`.
- `tenant_feature_entitlement`: `on conflict (tenant_id, feature_key) do nothing`.
- No new slug column; no schema modification.
- Fail-closed: every insert is keyed off a `platform_identity` lookup; no match → nothing inserted.

### Bootstrap rollback strategy

Deletes only the seeded rows, FK-safe order: `user_membership` →
`tenant_feature_entitlement` → `store` → `tenant` → `app_user`. **Never touches
`audit_event`.** DEV cleanup only.

### Why seed files live outside the migrations folder

The runner discovers migrations by the strict grammar `NNN_name.(up|down).sql` under
`server/platform-identity/migrations/`. Placing seeds under
`server/platform-identity/seeds/` (and naming them `*.example.sql`) guarantees the
runner never discovers or applies them — seeding stays a deliberate owner action.

### Why the runner is not extended for seeds

Applying schema and seeding data are different concerns. The runner stays
migrations-only (auditable, guarded). Seeds are owner-run in the SQL Editor.

## Deferred (not in M11.1)

- **Live DB / read-only diagnostic** — separate M11.2.
- **Repository / query layer** (assembles the resolver snapshot from real rows) — M11.2+.
- **Durable audit writer** — separate milestone; prerequisite for resolver wiring.
- **Runtime wiring** of `/auth/session/resolve` authorization — deferred until 003 applied + bootstrap applied + repository/live diagnostic proven + audit-writer strategy decided.
- Permission/sub-permission materialization (shared-catalog unification).
- A dedicated read-only platform role.

## Backend Control Plane roadmap note

Backend Control Plane remains **planned, not now**. Prerequisites: coherent role
vocabulary (this milestone), DEV bootstrap, read-only repository layer, proven
resolver, durable audit writer. M11.1 advances it only by making the authorization
data model coherent — it connects no tool. The future control plane must remain
**API-only, audited, least-privilege, approval-gated**, and must never use the
service-role key or direct Postgres from a tool runtime.

## Supabase MCP scope

Not used in M11.1, and not used by its implementation. Out of scope.

## Hostinger / deployment scope

Out of scope. M11.1 is file-only; no deployment, no production change.

## Prisma / ORM strategy

No ORM introduced. The established pattern is raw SQL migrations + `postgres`
(postgres.js) direct in `server/platform-identity/db.ts`. Adding an ORM would be an
unrequested dependency for zero benefit here.

## Security risks and mitigations

| Risk | Mitigation |
|---|---|
| Silent role remap over-grants authority | Only 3 unambiguous mappings auto-applied; `platform_admin`/`platform_readonly` fail loudly |
| Editing applied 002 breaks reproducibility | Forbidden; evolved via new 003 only |
| Seed leaks secrets | Template carries none; static check asserts no JWT/postgres-URL/supabase-host material |
| Runner auto-applying a seed | Seeds live outside the migrations dir; not discoverable |
| Premature/written audit rows | Seed/rollback never insert or delete `audit_event` |
| Client trust | Authorization stays server-derived; seed trusts no client claim / no provider user_metadata |

## QA evidence

See the M11.1 QA report in the task output. Commands run (no DB, no apply):
`diagnostics-role-vocabulary-alignment-check.ts`, runner `--list` + `--dry-run`
(003 up/down), the M10.2/M11/M9/M10 diagnostics, `tsc --noEmit`, `npm run build`,
static safety greps, and a forbidden-file diff check.

## Rollback plan

File-only and uncommitted: `git restore` / delete the six new files; nothing applied
means no DB rollback. If 003/seed are later applied (separate owner steps), rollback =
`003.down` (DEV) and the DEV bootstrap rollback template — neither touches `audit_event`.

## Final status

Implemented (file-only). Not committed, not pushed, not backed up. No DB connection,
no SQL run, migration 003 not applied, seed/bootstrap not applied, Supabase MCP not
used, `/auth/session/resolve` not modified. Pending owner review.
