# Phase 1.5 — Milestone 11: Pure Server-Derived Authorization Resolver + Bootstrap Strategy

Status: **Implemented locally — NOT committed, NOT pushed, NOT backed up. Pending review.**
Owner UI QA: **not required** (pure/inert; no visible UI change).

Checkpoint before M11: `86cf0cfaab764f6857cd4c9bde6688c2773d0ce5` ("Phase 1.5 M10.2 parameterize migration runner").

---

## 1. Scope (accepted Option B)

M11 adds a **pure, inert** server-side authorization resolver that maps a **server-assembled
snapshot** of durable rows to the M9 `ServerDerivedAuthorizationV1` shape, validated entirely with
**mocked diagnostic inputs**. It proves resolver behavior **without** any DB access, bootstrap data,
or runtime wiring.

Explicitly, M11:

- **No DB connection. No SQL. No seed/bootstrap. No migration. No Supabase MCP.**
- **No runtime wiring**: the resolver is imported by nothing at runtime.
- **`/auth/session/resolve` STILL returns `authorization: null`** — unchanged (M7 untouched).
- **No frontend / AccessContext change.** No durable audit writer. No protected business API.

### Files added (exactly three)

- `server/platform-identity/authorizationResolver.ts` — the pure resolver.
- `scripts/diagnostics-authorization-resolver-check.ts` — pure/offline mocked-input diagnostic.
- `docs/phase-1.5-milestone-11-authorization-resolver-bootstrap-strategy.md` — this record.

### Files modified

- **None.** No existing file was modified. No `package.json` / `package-lock.json` / dependency change.

---

## 2. Resolver input model

A `resolveAuthorization(input)` pure function consuming a **server-assembled** snapshot (never client
input):

- `identity` — `{ internalUserId, authProvider, authProviderUid, email }` (reference fields never authority).
- `appUser` — `{ internal_user_id, status, display_name } | null`.
- `memberships[]` — `{ membership_id, internal_user_id, tenant_id|null, store_id|null, scope_type, role_id, status }`.
- `tenant` — `{ tenant_id, plan_key, status } | null`.
- `store` — `{ store_id, tenant_id, status } | null`.
- `entitlements[]` — `{ tenant_id, feature_key, enabled, source }`.
- `requestedContext` — `{ scopeType: 'platform'|'tenant'|'store', tenantId?, storeId? }` (server-validated
  against memberships).

The resolver **never** reads a request body, a token's `user_metadata`, or any client-asserted
role/permission/entitlement/tenant/store. Memberships are defensively filtered to the verified identity.

## 3. Resolver output model

Returns `{ authorization: ServerDerivedAuthorizationV1 | null, decision, reasonCode, humanReadableReason,
limitation }`. The `reasonCode` is **resolver-local** (`AUTHORIZATION_RESOLVER_REASON_CODES`) and does
**not** modify the M9 contracts. On any denial, `authorization === null`. `limitation` is `'read_only'`
when read-only limiting applies (permission capping deferred — see §7).

## 4. Status / denial rules (status precedence BEFORE role)

- Missing `app_user` (or mismatched identity) → deny `denied_no_app_user`.
- `app_user.status` `suspended` → deny `denied_account_suspended`; `pending_activation` → deny
  `denied_account_pending_activation` (the M9 `STATUS_DENY_BEFORE_ROLE` set).
- `app_user.status` `read_only` / `overdue` → allow with **read-only limiting** (`resolved_read_only`).
- `active` / `trialing` → normal.
- Membership: none → `denied_no_membership`; `invited`/`suspended`/`pending_setup` → `denied_membership_not_active`.
- Tenant/store deny-status is checked **before** the membership role grant (status precedence).

## 5. Scope rules

- **platform** — requires an active platform-scoped membership; `tenantId/storeId` null; `userType: 'platform'`.
- **tenant** — requires `tenantId`, a matching active `tenant` (not deny-status), and an active
  tenant-scoped membership; `userType: 'tenant'`.
- **store** — requires `tenantId` + `storeId`, a matching active `tenant`, a matching active `store`
  that **belongs to the tenant** (`denied_store_tenant_mismatch` otherwise), and an active store-scoped
  membership. Scopes are explicit and fail-closed (a platform/tenant membership does **not**
  auto-grant a narrower scope).

## 6. Role rules

- **Tenant/store roles** (`store_owner|manager|technician|sales_staff`) are consistent across the DB
  migration, the M9 contract, and the frontend → resolved directly; `store_owner` is the tenant/store owner.
- **Platform roles** — see §8 (drift). The resolver works in the **contract** vocabulary; an
  unreconcilable platform role **fails closed** (`denied_unresolvable_role`).

## 7. Entitlement + permission/sub-permission rules

- `entitlements` includes **only** rows with `enabled === true` for the **in-scope tenant**; disabled
  or other-tenant rows are excluded. Platform scope carries no tenant entitlements. Plan→entitlement
  **materialization remains deferred** (the resolver reads whatever rows exist).
- `permissions` and `subPermissions` are intentionally **empty** this milestone. Full materialization is
  **deferred to the shared permission-catalog unification** (M9 `SHARED_PERMISSION_CATALOG_TARGET`,
  `declared_not_built`) — the codebase still has three mirrored orderings
  (`accessConfig.ts`, `platformPermissionsConfig.ts`, `permissionDecision.ts`), and hardening that drift
  into the server now would be premature. Roles + scope + status + entitlements are the authoritative
  outputs M11 proves.

## 8. Platform-role vocabulary drift (must reconcile before live wiring)

The durable migration (`002`) constrains platform `role_id` to:

> `platform_owner | platform_admin | platform_ops | platform_support | platform_readonly`

but the M9 contract (`PLATFORM_ROLE_IDS`) and the live frontend engine use:

> `system_owner | support_admin | billing_admin | operations_admin | security_admin`

These **do not line up** (e.g., `platform_admin` has no unambiguous contract equivalent;
`platform_readonly` has none). The resolver works in the **contract** vocabulary and provides a
**provisional, documented** `PLATFORM_ROLE_COMPAT_MAP` for the **unambiguous subset only**
(`platform_owner→system_owner`, `platform_support→support_admin`, `platform_ops→operations_admin`);
`platform_admin` / `platform_readonly` are intentionally unmapped and **fail closed**
(`denied_unresolvable_role`). **Live wiring MUST reconcile the two vocabularies first** (canonicalize one
set, or define an authoritative, semantically-justified mapping) — this is a hard prerequisite, not
papered over here. Tenant/store roles have no such drift.

## 9. Bootstrap strategy (planned, NOT applied)

After M10.1 all six durable tables had **0 rows**, so a **live** resolver would deny every user. Minimum
DEV bootstrap before any live wiring: one `app_user` (PK = an existing `platform_identity.internal_user_id`),
one `tenant`, one `store`, one `user_membership`, and optional `tenant_feature_entitlement` rows.

Bootstrap must be **idempotent, DEV-only, owner-controlled, secret-free** (no raw provider tokens, no
trusted `user_metadata`), and likely needs an **owner-selected `internal_user_id` or email**. Recommended
form: an **idempotent seed SQL file committed but applied separately** by the owner in the Supabase DEV
SQL Editor — **kept distinct from schema migrations** (so the M10.2 runner is not used for it unless
bootstrap is later deliberately modeled as a seed). **Bootstrap is deferred to a separate, owner-approved
M11.1.** Production bootstrap is out of scope.

## 10. Live DB / read-only diagnostic strategy

A **live** read-only diagnostic that validates the resolver against real DEV rows requires a DB
connection and is therefore a **separate, owner-approved M11.2 step** — deferred. M11 itself performs no
DB connection; its diagnostic is mocked-input only.

## 11. Durable audit writer — deferred

M11 writes no durable audit and implements no audit writer (the resolver is side-effect-free). The
fail-closed write strategy and durable-audit-writer slice are **deferred**, and should precede or
accompany resolver **wiring** — not the pure resolver.

## 12. Runtime wiring — deferred

The resolver is imported by nothing at runtime; `/auth/session/resolve` is untouched and stays
`authorization: null`. Wiring is a later slice, gated on: platform-role reconciliation (§8) + DEV
bootstrap (§9) + (recommended) durable audit writer (§11). No route params/body fields are added.

## 13. Backend Control Plane roadmap note

The Backend Control Plane remains **planned, not implemented now, not connected to live data**. The
resolver and bootstrap strategy (and the future durable audit writer) are **prerequisites** — M11 defines
server-derived authorization *behavior* without connecting any tool. When built, the control plane must be
**API-only, fully audited, least-privilege, approval-gated**, and **must not** use the service-role key or
direct-Postgres access from any tool runtime.

## 14. Supabase MCP scope

**Not used.** No MCP, no Supabase config/Auth/schema/RLS change.

## 15. Hostinger / deployment scope

**Not now.** Hostinger = static frontend/demo; Replit = dev-only; Supabase = production DB direction.
M11 makes no host/deploy decision; DEV-only.

## 16. Prisma / ORM strategy

**Deferred.** SQL-first/Supabase migrations remain; a future repository layer (M11.2) would follow the
existing `getDb()` tagged-template pattern in `identityRepository.ts`. No ORM.

## 17. QA evidence (Claude-run, no DB)

- New resolver diagnostic `diagnostics-authorization-resolver-check.ts` → **27/27 PASS** (status/membership
  denials, owner resolutions per scope, scope/status edges, entitlement inclusion/exclusion, client/metadata
  ignored, shape conformance, denial-null, inertness, runtime isolation, no-secret output).
- M9 diagnostics → **authorization-contract 12/12**, **audit-event-contract 10/10** PASS.
- M10 diagnostics → **authorization-schema 20/20**, **audit-schema 15/15** PASS.
- M10.2 runner diagnostic → **23/23 PASS**.
- Backend regression → **M7 19/19**, **M6 15/15**, **M5 7/7**, **M3 23/23** (live identity I1 skipped in
  hermetic mode), **M2 8/8**, **M8 13/13** PASS.
- `npx tsc --noEmit` → **pre-existing baseline errors only; 0 in M11 files**.
- `npm run build` → **success**; resolver/diagnostic/doc **not bundled** into the client; **no secret bundled**.
- Static safety → resolver has no DB/env/network/Express/Supabase/Firebase imports, no `process.env`,
  no token/JWT/JWKS/secret output; resolver imported by no runtime module; `sessionResolve.ts` unchanged
  and still returns `authorization: null`.
- Forbidden-file diff → none.

## 18. Rollback plan

Reversible by deleting the three new files (no migration applied, no schema/runtime/dependency change →
nothing else to undo), mirroring the file-only rollback pattern of M5/M6/M8/M9/M10/M10.2.

## 19. Deferred items (after M11)

Platform-role vocabulary **reconciliation** (§8); DEV **bootstrap** seed (M11.1); **repository** layer +
live read-only diagnostic (M11.2); permission/sub-permission **materialization** + shared-catalog
unification; **durable audit writer** (fail-closed); `/auth/session/resolve` **wiring** + tenant/store
context input; AccessContext adoption; protected business APIs; Backend Control Plane; Supabase MCP/config;
Hostinger/host decision; ORM; Firebase→Supabase auth migration; any **production** bootstrap/migration.

---

**Not committed / not pushed / not backed up; no DB connection; no SQL run; no seed/bootstrap applied;
Supabase MCP not used; `/auth/session/resolve` not modified; pending review.** Working tree contains only
the three allowed M11 files.
