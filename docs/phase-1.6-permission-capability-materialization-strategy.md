# Phase 1.6 M1 — Permission & Capability Materialization (Strategy & Closeout)

**Status:** IMPLEMENTED — pending owner review / manual QA. Not committed, not pushed,
not backed up. No DB, migration, seed, SQL, audit write, or production change occurred.

**Accepted base checkpoint:** `7dac091341d0345e80fbb859e0847f0d4e5e1217`
(Phase 1.5 M11.5 wire session resolve authorization).

---

## 1. Scope

Until this milestone the pure M11 authorization resolver
(`server/platform-identity/authorizationResolver.ts`) returned, on every ALLOW
decision, `permissions: {}` and `subPermissions: {}` — the effective capability
maps were **deferred** to a shared-catalog unification (the M9
`SHARED_PERMISSION_CATALOG_TARGET`).

Phase 1.6 M1 builds that catalog **server-side only (Option B)** and wires the
resolver's `allow()` choke-point to materialize the two maps. Roles + status +
entitlements remain the authoritative inputs; the new outputs are derived from
them by pure functions.

**In scope (backend only):**
- A pure, inert, server-only permission/capability catalog + materializers.
- Resolver `allow()` now fills `permissions` / `subPermissions`.
- Two new offline static diagnostics.

**Explicitly NOT in scope:** any `src/**` change, AccessContext / Login /
AccessGuard / App routing change, protected business APIs, authorization
middleware, Backend Control Plane, Database Operations Console, direct
database-control UI, migrations, seeds, SQL, DB connections, live diagnostics,
Supabase MCP, contract/`authz.v1` shape changes, or `permissionDecision.ts`
changes. The platform-role vocabulary reconciliation remains deferred.

---

## 2. Files added

| File | Purpose |
| --- | --- |
| `server/platform-identity/permissionCatalog.ts` | Pure, inert, server-only catalog + four materializers + `materializeCapabilities` entry point. |
| `scripts/diagnostics-permission-catalog-static-check.ts` | Offline static integrity check of the catalog (35 checks). |
| `scripts/diagnostics-authorization-permission-materialization-check.ts` | Offline end-to-end materialization check via the real resolver with mocked snapshots (37 checks). |
| `docs/phase-1.6-permission-capability-materialization-strategy.md` | This document. |

## 3. Files modified

| File | Change |
| --- | --- |
| `server/platform-identity/authorizationResolver.ts` | `allow()` now calls `materializeCapabilities(...)` and fills `permissions` / `subPermissions` (was `{}` / `{}`). Header + one JSDoc updated for truthfulness. **Deny path, fail-closed, status-before-role, owner short-circuits, entitlement assembly/cap, platform drift shim, and DTO shape are unchanged.** |
| `scripts/diagnostics-authorization-resolver-check.ts` | Test #24 inert-import allowlist extended by one entry (`./permissionCatalog`) so the legitimate new inert import does not trip the inertness assertion. No other change; the catalog's own inertness is asserted by the new catalog static check. |

No other files were touched. In particular: `src/**`,
`src/context/accessConfig.ts`, `src/owner/platformPermissionsConfig.ts`,
`server/platform-identity/permissionDecision.ts`,
`server/platform-identity/sessionResolve.ts`,
`server/platform-identity/sessionAuthorizationService.ts`,
`server/platform-identity/auditEventWriter.ts`,
`server/platform-identity/authorizationRepository.ts`,
`server/platform-identity/authorizationContract.ts`,
`server/platform-identity/authorizationConstants.ts`, `package.json`,
`package-lock.json`, `.replit`, migrations, and seeds are all UNCHANGED.

---

## 4. Two-ordering design (manage/approve divergence preserved)

The catalog keeps **two distinct orderings** of the shared 7-token vocabulary
(`none, view, create, edit, manage, approve, full`) and never unifies them:

- **Tenant/store ordering** (`TENANT_ORDERING`, mirrors
  `accessConfig.PERMISSION_HIERARCHY`):
  `none < view < create < edit < manage < approve < full` (**manage < approve**).
- **Platform ordering** (`PLATFORM_ORDERING`, mirrors
  `platformPermissionsConfig.PLATFORM_PERMISSION_LEVELS`):
  `none < view < create < edit < approve < manage < full` (**approve < manage**).

Each has its own comparison helper (`meetsTenantPermissionLevel`,
`meetsPlatformPermissionLevel`). The catalog static check asserts both orderings
match their frozen frontend sources by read-only parity, that the two arrays are
not identical, and — semantically — that the tenant helper ranks `approve` above
`manage` while the platform helper ranks `manage` above `approve`. Collapsing the
two would be a correctness bug and is rejected by the diagnostic.

---

## 5. Role mapping approach

**Tenant/store roles** (mirror `tenantRoles` in `accessConfig`):
- `store_owner` — `_grant: 'full'` owner short-circuit → every domain `full`,
  every sub-permission granted, **after** plan/entitlement gating and **subject
  to** read-only status capping.
- `manager` / `technician` / `sales_staff` — verbatim per-domain level maps + the
  verbatim explicit sub-permission boolean maps from the frontend role defaults.

**Platform roles** (mirror `DEFAULT_PLATFORM_FEATURE_LEVELS`): defaults defined for
all five (`system_owner`, `support_admin`, `billing_admin`, `operations_admin`,
`security_admin`). Platform sub-permissions inherit their parent feature's default
level and must additionally satisfy the platform **prerequisite/dependency** map
(transitive, cycle-guarded) — mirroring `explainAccessDecision` with no overrides.

**Platform-role vocabulary drift (still deferred):** the durable migration uses
`platform_owner | platform_admin | platform_ops | platform_support |
platform_readonly`; the contract/frontend use `system_owner | support_admin |
billing_admin | operations_admin | security_admin`. The resolver's existing
`PLATFORM_ROLE_COMPAT_MAP` only maps the **unambiguous** subset
(`platform_owner→system_owner`, `platform_support→support_admin`,
`platform_ops→operations_admin`). Ambiguous/unmapped durable roles
(`platform_admin`, `platform_readonly`) **fail closed** (deny → `authorization:
null`) and never reach materialization. No durable mapping was invented for
`billing_admin`/`security_admin`.

---

## 6. Entitlement / plan gating approach (cap-only)

Entitlements **reduce only; they never expand** role-derived permissions. The
resolver passes the enabled-only, in-scope-tenant entitlement map
(`FeatureEntitlements`); the catalog only ever *tests membership* of known gate
keys against it.

- **Tenant domains:** `TENANT_DOMAIN_ENTITLEMENT` maps each domain to the feature
  key that must be entitled. Five core domains (`dashboard, sales, customers,
  invoices, support`) are ungated (always available). A plan-disabled gated domain
  is capped to `none`.
- **Tenant sub-permissions:** `requiredEntitlementsForTenantSub` = the parent
  domain's gate (if any) ∪ the `TENANT_FEATURE_PERMISSION_DEPENDENCIES` feature
  gates. **All** required keys must be entitled; otherwise the sub is `false`.
  This mirrors `isSubPermissionPlanAvailable` (parent domain in plan **and** every
  feature gate live).
- **Unknown entitlement keys fail closed:** an entitlement key outside the
  catalog's known set can never enable anything (the diagnostic proves an unknown
  key produces output identical to an empty entitlement map).
- **Platform side is not plan-gated** (platform staff have no tenant plan); the
  resolver passes `{}` entitlements for platform scope.

**Documented drift:** the frontend `planFeatures` uses `supply-chain` (hyphen)
while the domain id is `supply_chain` (underscore). The server domain gate uses
the `planFeatures` key form (`supply-chain`) so entitlement rows assembled from
durable state line up. Full reconciliation of durable feature-key conventions is
deferred.

Tenant sub-permission materialization precedence (mirrors
`permissionDecision.requireSubPermission`):
1. Plan/entitlement availability — if any required gate is absent → `false`.
2. Owner short-circuit (`store_owner`) — **only after** plan gating.
3. Parent-domain `minModuleLevel` must be met (this is why technician's explicit
   `adjust_stock: true` resolves to `false` — inventory `create` < required
   `edit`; the parent-level gate shadows the explicit grant).
4. Explicit per-role grant wins.
5. Default-by-level fallback.
6. Read-only status cap.

---

## 7. Status / read-only capping

Deny statuses (`suspended`, `pending_activation`, inactive/suspended tenant or
store, non-active membership) still short-circuit to `authorization: null` —
unchanged by this milestone.

Limited statuses (`read_only`, `overdue` on user/tenant/store) set the resolver's
`limited` flag, which the catalog applies during materialization:
- Domain/feature levels are capped to `view` (write levels removed) using the
  appropriate ordering.
- Mutating sub-permissions (write/create/edit/manage/approve/override/configure/
  execute) → `false`. Read-safe sub-permissions (`view_*` visibility + benign
  open/print) are preserved **only where role + entitlement already grant them**.
- Platform: non-`view`-threshold and sensitive sub-permissions → `false` under
  read-only; `view`-threshold non-sensitive subs survive.

---

## 8. Resolver materialization summary

`allow()` computes `{ permissions, subPermissions } = materializeCapabilities({
platformRoleId, tenantRoleId, entitlements, limited })`. `materializeCapabilities`
selects the platform materializers when a platform role resolved, the tenant
materializers when a tenant/store role resolved, and returns empty maps **only**
when neither role resolved — a state `allow()` never reaches, so an empty map is
never interpreted as "full". The DTO key set, version (`authz.v1`), and all other
fields are byte-for-byte unchanged.

---

## 9. Contract compatibility

No structural contract change. `authorizationVersion` stays `authz.v1`. The DTO
shape (`ServerDerivedAuthorizationV1`) is unchanged — `permissions` is still
`Record<string, PermissionLevelValue>` and `subPermissions` is still
`Record<string, boolean>`; this milestone only changes their *contents* on allow.
The output carries only permission-level strings and sub-permission booleans plus
the existing safe role/scope/status/entitlement fields — no token, JWT, key, DB
URL, or secret field. `diagnostics-authorization-contract-check` remains 12/12.

---

## 10. Diagnostics added

- **`diagnostics-permission-catalog-static-check.ts`** (35 checks): no duplicate
  keys; both orderings exact + frontend parity; manage/approve divergence; valid
  parents; valid + complete role defaults; entitlement-key consistency; unknown
  keys fail closed; no secret-like keys; catalog inertness (imports only inert
  modules, no `src/`, no I/O).
- **`diagnostics-authorization-permission-materialization-check.ts`** (37 checks):
  deny → null; allow fills non-empty maps; `store_owner` full capped by plan +
  status; `system_owner` full platform; manager/technician/sales_staff role
  defaults (incl. the parent-level shadowing proof); plan-disabled feature removes
  dependents; entitlements reduce-only; read-only/overdue capping; platform
  unmapped roles fail closed; mapped partial roles (support_admin/operations_admin)
  materialize the expected subset; no secret fields in output.

Both are offline (`npx tsx`), require no `package.json` change, and write zero
audit rows.

---

## 11. QA run (this pass — non-live only)

| Command | Result |
| --- | --- |
| `npx tsc --noEmit` | 12 errors, all pre-existing unrelated files; **0 in any M1 file**. |
| `npm run build` | ✓ built (advisory chunk-size note only). |
| `npx tsx scripts/diagnostics-permission-catalog-static-check.ts` | **35/35** |
| `npx tsx scripts/diagnostics-authorization-permission-materialization-check.ts` | **37/37** |
| `npx tsx scripts/diagnostics-authorization-resolver-check.ts` | **27/27** |
| `npx tsx scripts/diagnostics-authorization-contract-check.ts` | **12/12** |
| `npx tsx scripts/diagnostics-session-authorization-service-static-check.ts` | **30/30** |
| `npx tsx scripts/diagnostics-session-resolve-live-authorization-static-check.ts` (DB-free static) | **28/28** |
| `npx tsx scripts/diagnostics-session-resolve-contract-check.ts` | **15/15** |
| `npx tsx scripts/diagnostics-protected-action-check.ts` | **8/8** |

No live route diagnostic, DB-backed diagnostic, audit-writer live check, session
resolve live authorization route diagnostic, or DEV live materialization
diagnostic was run. No DB connection was made; no SQL ran; no Supabase MCP was
used; no `audit_event` row was written.

---

## 12. Deferred items / follow-ups

- Full durable↔contract platform-role vocabulary reconciliation (`platform_admin`,
  `platform_readonly`, `billing_admin`, `security_admin`).
- Durable feature-key convention reconciliation (e.g. `supply_chain` vs
  `supply-chain`).
- Optional DEV-only live materialization route exposure (intentionally NOT added).
- Future true single-source-of-truth catalog imported by BOTH `src/` and
  `server/` (this milestone keeps the server mirror; `src/` is untouched).

---

## 13. Rollback plan

No DB rollback and no audit rollback are required (no migration, seed, SQL,
schema/RLS/Auth change, or DB/audit write occurred). Code rollback:

1. Revert `authorizationResolver.ts` `allow()` to emit `permissions: {}` and
   `subPermissions: {}` (and remove the `materializeCapabilities` import + the two
   JSDoc/header edits).
2. Revert the one-line allowlist change in
   `scripts/diagnostics-authorization-resolver-check.ts`.
3. Delete `server/platform-identity/permissionCatalog.ts`.
4. Delete the two new static diagnostics.
5. Delete this strategy doc.

Equivalently, `git checkout 7dac091 -- <paths>` / remove the untracked new files.
