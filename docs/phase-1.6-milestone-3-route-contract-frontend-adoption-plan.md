# Phase 1.6 M3 — Route Contract Hardening & Frontend Adoption Plan (Strategy & Closeout)

**Status:** IMPLEMENTED — pending owner review / manual QA. Not committed, not pushed,
not backed up. No DB connection, migration, seed, SQL, audit write, Supabase MCP,
live route call, or production change occurred.

**Accepted base checkpoint:** `08782966048da114cfd485a53aff24ac0e421879`
(Phase 1.6 M2 — reconcile roles and feature keys).

---

## 1. Scope

M3 is a **backend-only route-contract hardening + static-readiness + documentation**
slice (Option B from the accepted M3 planning pass). It corrects a truthfulness
defect in the session-resolve wire contract and proves — statically — that a future
AccessContext adapter could consume server-derived authorization without dropping a
capability and without the frontend importing any server module. **No frontend
adoption is implemented; the frontend is untouched.**

**In scope (backend only):**
- Reconcile the stale "`authorization` is ALWAYS `null`" invariant in
  `sessionResolveContract.ts` to the true M11.5 conditional behavior (comments/types
  only; additive; no DTO/`authz.v1`/wire-field change).
- Add an explicit, documented `SESSION_RESOLVE_AUTHORIZATION_PRESENCE` conditions
  constant (declarative data only).
- Two offline static diagnostics (route-contract stability; AccessContext adoption
  readiness).
- This document.

**Explicitly NOT in scope:** any `src/**` change (incl. `AccessContext.tsx`,
`accessConfig.ts`, `platformPermissionsConfig.ts`, `mapWhoamiToAppSession.ts`,
`appSession.ts`, AccessGuard, Login, App routing), frontend adoption, protected
business APIs, authorization middleware, Backend Control Plane, Database Operations
Console, direct DB control, migrations, seeds, SQL, DB connections, live / DB-backed
/ audit-writer / session-resolve-live diagnostics, Supabase MCP, `authz.v1` shape
changes, or any route behavior change.

---

## 2. Route contract truthfulness — what was corrected

`sessionResolveContract.ts` contained a **self-contradiction**: its M11.5-updated
`SessionResolveAuthorization` block correctly documented conditional non-null
behavior, while the DTO doc-block and the BOUNDARY header still asserted
`authorization` is **"ALWAYS `null`"**. M3 reconciles all three sites to one truth
(comments/types only):

> `authorization` is `null` by **default** (disabled path, deny, fail-closed). It
> MAY be a non-null `ServerDerivedAuthorizationV1` **only** under the DEV-only live
> conditions in `SESSION_RESOLVE_AUTHORIZATION_PRESENCE` — never on the
> default/disabled path and never in production.

The route handler (`sessionResolve.ts`) header already described the M11.5
conditional behavior correctly and was **not changed**.

---

## 3. Authorization presence conditions (the AND-ed gate set)

The wire `authorization` MAY be non-null **only** when ALL of the following hold
(any false ⇒ `null`). Declared as `SESSION_RESOLVE_AUTHORIZATION_PRESENCE` for
documentation + diagnostic assertion (NOT a new wire field):

| Condition | Source |
| --- | --- |
| `ENABLE_SUPABASE_PLATFORM_IDENTITY === 'true'` | `config.isPlatformIdentityEnabled()` (default OFF) |
| `ENABLE_SESSION_RESOLVE === 'true'` | `config.isSessionResolveEnabled()` (default OFF, non-prod) |
| `ENABLE_LIVE_SESSION_AUTHORIZATION === 'true'` | `config.isLiveSessionAuthorizationEnabled()` (default OFF, non-prod) |
| `NODE_ENV !== 'production'` | hard-blocked in production by the two flag helpers |
| resolver decision `allow` | the pure M11 resolver via the M11.4 service |
| durable audit write **succeeded** | M11.4 service: an unaudited allow is downgraded to a forced deny |

---

## 4. Disabled / default path

With any gate off — i.e. the **default** posture (all three flags default OFF) — the
route returns `authorization: null`. The handler initializes `authorization` to
`null` and assigns a value **only** inside the `if (isLiveSessionAuthorizationEnabled())`
block, and only when the service returns `decision === 'allow' && audited &&
authorization`. Deny, forced-deny (audit-write failure), repository error, and any
exception all keep `authorization: null`. Proven statically by
`diagnostics-session-derived-authorization-contract-check.ts` (no live route call).

---

## 5. DEV-only live authorization path (unchanged)

The DEV-only live path (`ENABLE_LIVE_SESSION_AUTHORIZATION=true`, non-production)
derives authorization via the M11.4 service from the durable
`(auth_provider, auth_provider_uid)` identity key only — never from the request
body / `user_metadata` / any client-asserted role/tenant/store/permission. It is
**unchanged** by M3. Identity proof (`internalUserId`) is never downgraded by an
authorization failure. **Audit delta:** when this flag is enabled, each resolution
writes one durable `audit_event` row (the M11.4 service audits every decision; an
unaudited allow fails closed). M3 does **not** enable this flag and writes zero
audit rows.

---

## 6. Server-derived authorization payload shape

`ServerDerivedAuthorizationV1` (inert M9 DTO): `authorizationVersion: 'authz.v1'`,
`userType`, `scope`, `roles`, `status`, `entitlements`, `permissions`
(domain/feature → level), `subPermissions` (id → boolean), `derivedBy`. It carries
**no** token/JWT/key/DB-URL/secret field (enforced by `AUTHORIZATION_FORBIDDEN_FIELDS`
and the `SessionResolveForbiddenField` guard). M3 changes none of this.

---

## 7. AccessContext adoption readiness (static proof)

`diagnostics-accesscontext-adoption-readiness-check.ts` proves an **exact,
bidirectional parity** between the server-derived key space (imported from the inert
catalog) and the frozen frontend vocabulary (read as TEXT):

| Key space | Server | Frontend | Parity |
| --- | --- | --- | --- |
| Tenant domains | 21 | 21 | exact |
| Tenant sub-permissions | 74 | 74 | exact |
| Platform feature keys | 11 | 11 | exact |
| Platform sub-permissions | 78 | 78 | exact |
| Entitlement gate keys → planFeatures (normalized) | 25 | ⊆ 31 | total |

Therefore a future adapter mapping would be **total** — no server authorization key
would be silently dropped, and no frontend permission key is unaccounted for in the
server-derived model (zero documented exceptions needed). `supply_chain` normalizes
to the planFeatures form `supply-chain`.

---

## 8. AccessContext provider mismatch & why adoption is deferred

The production `AccessContext.tsx` derives permissions **client-side from a Firebase
session**; the server authorization path verifies **Supabase tokens only**.
Server-derived authorization therefore **cannot** be wired into the live AccessContext
until the separate **Supabase-auth frontend migration** lands. Adoption is deferred
to a later, separately-approved phase; M3 only proves readiness.

---

## 9. Future adapter / shadow / fallback strategy (documented only)

- **Seam:** the existing pure `src/auth/mapWhoamiToAppSession.ts` (wire DTO is
  superset-compatible with `WhoamiResponseInput`) is the adoption seam. Its flat
  input does **not** yet read `authorization`; the future adapter must read the
  **structured** wire `authorization` field. `AppSession.authorization`
  (`AppAuthorization | null`) is already a forward-compatible slot.
- **Adapter:** a thin read-only adapter maps `authorization.permissions[domain]` →
  level and `authorization.subPermissions[id]` → boolean, exposing the same
  `hasPermission` / `checkSubPermission` surface. The frontend imports **no** server
  module — it consumes the wire DTO only.
- **Shadow / observational first:** behind a future DEV-only flag
  `VITE_ENABLE_SERVER_AUTHZ_SHADOW` (default OFF): compute the legacy client result
  AND the server-derived result, **compare and log mismatches**, keep the **legacy
  engine authoritative**. Only after proven shadow parity (and the Supabase-auth
  migration) does enforcement switch.
- **Fallback / null semantics (binding for the future):** `authorization: null`
  means **fall back to the legacy client engine**. Null must **never** be
  interpreted as full deny, fail-open, or blank permissions. Live authz failure
  (network/5xx/timeout) → same fallback + a non-blocking DEV signal.

---

## 10. Future rollout sequencing

1. **M3 (this slice):** contract hardening + static readiness diagnostics + this doc.
2. Supabase-auth frontend migration (separate phase).
3. Shadow/observational adoption behind `VITE_ENABLE_SERVER_AUTHZ_SHADOW` (separate).
4. Enforcement switch to server-derived authz with legacy-engine fallback (separate).

Production stays off the entire ladder until explicitly approved.

---

## 11. Files added / modified

**Added:** `scripts/diagnostics-session-derived-authorization-contract-check.ts`
(23 checks), `scripts/diagnostics-accesscontext-adoption-readiness-check.ts`
(22 checks), this doc.

**Modified:** `server/platform-identity/sessionResolveContract.ts` (comments/types
only — reconcile invariant + add presence-conditions constant), `replit.md` (one M3
pointer line), `docs/phase-1.6-permission-capability-materialization-strategy.md`
(one truthfulness pointer).

**Untouched:** all `src/**`; `sessionResolve.ts` (already truthful);
`authorizationResolver.ts`/`permissionCatalog.ts`/`sessionAuthorizationService.ts`
behavior; `authorizationRepository.ts`; `auditEventWriter.ts`;
`permissionDecision.ts`; migrations; seeds; `package.json`; `package-lock.json`;
`.replit`.

---

## 12. Deferrals (restated)

- Protected business API enforcement — deferred.
- Backend Control Plane — remains planned; does not start here.
- Database Operations Console / direct DB control — remains planned; when built must
  be backend-API-gated, audited, approval-gated, system_owner only, DEV/staging
  first, production disabled by default, never browser-to-database, never exposing
  service-role keys or DB URLs to the frontend.
- Production migration 003 apply — separate owner-approved pass; keep the legacy
  `PLATFORM_ROLE_COMPAT_MAP` until all environments are confirmed on 003.
- Supabase-auth frontend migration; AccessContext adapter + shadow mode + enforcement
  switch.

---

## 13. QA plan (this pass — offline / non-live only)

| Command | Result |
| --- | --- |
| `npx tsx scripts/diagnostics-session-derived-authorization-contract-check.ts` | **23/23** |
| `npx tsx scripts/diagnostics-accesscontext-adoption-readiness-check.ts` | **22/22** |
| `npx tsx scripts/diagnostics-permission-catalog-static-check.ts` | **48/48** |
| `npx tsx scripts/diagnostics-authorization-permission-materialization-check.ts` | **43/43** |
| `npx tsx scripts/diagnostics-authorization-resolver-check.ts` | **27/27** |
| `npx tsx scripts/diagnostics-platform-role-vocabulary-reconciliation-check.ts` | **21/21** |
| `npx tsx scripts/diagnostics-feature-key-canonicalization-check.ts` | **21/21** |
| `npx tsx scripts/diagnostics-authorization-contract-check.ts` | **12/12** |
| `npx tsx scripts/diagnostics-session-resolve-contract-check.ts` | **15/15** |
| `npx tsx scripts/diagnostics-session-authorization-service-static-check.ts` | **30/30** |
| `npx tsx scripts/diagnostics-session-resolve-live-authorization-static-check.ts` (DB-free static) | **pass** |
| `npx tsx scripts/diagnostics-protected-action-check.ts` | **8/8** |
| `npx tsc --noEmit` (focused on M3 files) | 12 pre-existing unrelated errors; **0 in any M3 file** |

The disabled/default `authorization: null` behavior is proven **statically** — no
live route request is made. No live / DB-backed / audit-writer / session-resolve-live
/ M11.2–M11.5 route diagnostic is run; no DB connection, SQL, Supabase MCP, or
`audit_event` write occurs.

---

## 14. Rollback plan

No DB/audit rollback required (no migration, seed, SQL, schema/RLS/Auth change, or
DB/audit write occurred; static diagnostics write zero audit rows). Code rollback:

1. Delete the two new diagnostics.
2. Delete this doc.
3. Revert the `sessionResolveContract.ts` comment/type edits (the reconciled
   invariant + the `SESSION_RESOLVE_AUTHORIZATION_PRESENCE` constant).
4. Revert the `replit.md` M3 pointer line.
5. Revert the truthfulness pointer in
   `docs/phase-1.6-permission-capability-materialization-strategy.md`.

Equivalently, `git checkout 0878296 -- <paths>` and remove the untracked new files.
(`sessionResolve.ts` was not changed.)
