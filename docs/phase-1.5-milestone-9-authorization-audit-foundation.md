# Phase 1.5 — Milestone 9: Server-Derived Authorization + Durable Audit Contract Foundation (Option B)

Status: **Implemented locally — NOT committed, NOT pushed, NOT backed up. Pending review.**
Owner UI QA: **not required** (contract-only; no visible UI change).

Checkpoint before M9: `dfe46e6256f0830520906070cf855d18cd3e19e6` ("Phase 1.5 M8 pilot session resolve integration").

---

## 1. M9 scope

M9 adds **only inert, contract-only** server-side type definitions and pure diagnostics that
declare the SHAPE of a future **server-derived authorization** model and a future **durable,
append-only audit** event. It changes **no runtime behavior**, adds **no schema/migration/RLS**,
and adds **no dependency**. `/auth/session/resolve` continues to return `authorization: null`.

### Added (allowed scope)

- `server/platform-identity/authorizationContract.ts` — inert server-derived authorization DTO/types.
- `server/platform-identity/auditEventContract.ts` — inert durable audit-event DTO/types.
- `server/platform-identity/authorizationConstants.ts` — inert shared vocabulary (versions, labels, orderings, status/level/role/scope values, evidence levels, future shared-catalog target).
- `scripts/diagnostics-authorization-contract-check.ts` — pure/offline (12 checks).
- `scripts/diagnostics-audit-event-contract-check.ts` — pure/offline (10 checks).
- `docs/phase-1.5-milestone-9-authorization-audit-foundation.md` (this file).

### Modified

- None. (Pure additive — the contracts are imported by nothing at runtime, mirroring the M5/M6 inert-contract precedent.)

### Explicitly NOT done

No schema, migration, RLS, runtime endpoint change, AccessContext/Login/AccessGuard/App change,
M4/M8 pilot change, M5 mapper change, M6/M7 endpoint change, business-module change, dependency
change, Supabase MCP/config change, Firebase/Firestore change, or Backend Control Plane work.

---

## 2. Why Option B was selected

The accepted M9 planning recommended **Option B — contract-only authorization + durable-audit
design foundation**. Rationale:

- **Lowest runtime risk.** Inert types + pure diagnostics; imported by nothing at runtime;
  reversible by deletion.
- **Schema is mature enough to express, not to migrate.** Phase 1.4 M2 already produced a
  conceptual durable domain model; the missing artifact is the *typed, diagnosable contract* that
  the eventual migration, RLS, and endpoint wiring will be generated from. B produces that and
  de-risks the later migration (Option D).
- **Proven pattern.** M5 (`AppSession`) and M6 (`SessionResolveResponseDTO`) were inert contracts
  that later guided runtime (M7) and UI (M8). M9 repeats that shape for authorization + audit.
- **Keeps the honest `authorization: null` invariant** until a separately-approved wiring slice.

Rejected: A (more planning — state is clear); D (migrations — premature); E (mock resolver — false
confidence); F/G/H (require a durable model that does not exist; out of scope).

---

## 3. Current auth/session foundation

Identity is server-proven and fail-closed: a verified Supabase token (M3 JWKS verification) maps to
an app-owned `internal_user_id` (M1), surfaced through a single inert seam
(`AppSession` ← `mapWhoamiToAppSession` ← M6 DTO), exercised by the M7 prototype and M8 pilot. A
verified token with no resolved id is honestly `token-verified` / `503 identity_resolution_error`,
never `authenticated`. `authorization` is uniformly `null`. The only durable domain is
`platform_identity` (RLS enabled, no policies → deny-all to anon/authenticated; the server reaches
it via the owner-role direct-Postgres connection, which bypasses RLS).

## 4. Current client-side authorization gap

Authorization today is entirely **client/UI-gated**: `AccessContext` sources identity from Firebase
Auth + a single Firestore `users/{uid}` role read, then builds a **mocked** tenant/plan/status
(`tenant-1` / `growth` / `active`). The permission catalog (`accessConfig.ts`,
`platformPermissionsConfig.ts`) is client config with `localStorage` overrides
(`platform_permissions_v1`). `permissionDecision.ts` mirrors the level orderings server-side but
carries an explicit **DRIFT RISK** note (the two orderings are duplicated and must stay in sync).
None of this is durable or server-authoritative.

## 5. Current advisory audit gap

`auditEnvelope.ts` (M2) emits a truthfully-labelled decision envelope to **one sink: the safe server
log**, explicitly **advisory** (`evidenceLevel: 'dev_sidecar_log_advisory'`, "NOT compliance
evidence"). The client "Audit & Security" surfaces read a local/advisory log. **No durable audit
table exists.**

## 6. Proposed server-derived authorization model (future — NOT built in M9)

Layered, server-authoritative, deny-by-default: identity (`internal_user_id` → `app_user`) →
tenancy (`tenant` plan/status → `store` status) → membership (`(user, tenant, store?) → role`) →
role→permissions (shared catalog + optional per-tenant overrides) → entitlements (plan gates) →
status precedence. **Decision precedence** mirrors the existing client engine: authenticated →
scope match → tenant/store resolvable → **status active** → **plan/entitlement available** → owner
short-circuit (`system_owner`/`store_owner`) → permission level / sub-permission grant. The two
distinct level orderings (tenant `manage<approve`; platform `approve<manage`) are preserved.

## 7. Proposed durable audit model (future — NOT built in M9)

A single append-only `audit_event` table: INSERT + SELECT only (no UPDATE/DELETE), enforced later by
least-privilege grants + a reject-update/delete rule + RLS deny-all to anon/authenticated (the
`platform_identity` pattern). `evidenceLevel` distinguishes advisory dev logs from durable
compliance events. Retention aligns to the Phase 1.4 gate (7-year financial/audit retention) —
captured as a design note, not implemented.

## 8. DTO / contract descriptions

**`ServerDerivedAuthorizationV1`** (`authz.v1`): `authorizationVersion`, `userType`, `scope`
(`scopeType`/`tenantId`/`storeId`), `roles` (`platformRoleId`/`tenantRoleId`), `status`
(`user`/`tenant`/`store`), `entitlements` (featureKey→boolean), `permissions`
(domain→PermissionLevel), `subPermissions` (id→boolean), `derivedBy`. Server-derived only; never
client-asserted; carries no token/JWT/secret field (`AUTHORIZATION_FORBIDDEN_FIELDS`). Runtime
`authorization` stays `null` (`RUNTIME_SESSION_RESOLVE_AUTHORIZATION`).

**`DurableAuditEventV1`** (`audit.v1`): `eventId`, `requestId`, `traceId`, `occurredAt`,
`actorInternalUserId` (app-owned UUID, never raw provider uid), `actorAuthProvider`,
`onBehalfOfInternalUserId`, `scopeType`/`tenantId`/`storeId`, `actionId`, `requiredPermission`,
`decision`, `reasonCode`, `humanReadableReason`, `resultStatus`, `sourceOfTruth`, `evaluatedBy`,
`evidenceLevel`, `metadata` (allow-listed, redacted). Never-capture list = `AUDIT_FORBIDDEN_FIELDS`.

## 9. User / tenant / store / role / permission / scope model

Durable tables (future): `app_user` (1:1 with `internal_user_id`, status), `tenant` (plan, status),
`store` (tenant_id, status), `membership` (user×tenant×store? → role, status),
`tenant_feature_entitlement` (plan gates), `audit_event`. `internal_user_id` remains the bridge key
and FK. Roles are **mixed** (global platform roles + tenant/store-scoped). Permissions are a
**shared code-constant catalog** (single source of truth target) + durable per-tenant override rows
later; levels stay typed enums with both orderings preserved.

## 10. Feature entitlement / plan-gate relationship

Plan gates are part of authorization. `tenant_feature_entitlement` gates whether a capability
*exists*; role decides who may use it. **Role can never resurrect a plan-disabled capability**
(mirrors `checkSubPermission`: plan-locked denies before the owner short-circuit and before any
role grant).

## 11. Disabled / suspended strategy

Status is part of authorization (`AccountStatus`: active/trialing/overdue/suspended/read_only/
pending_activation). A suspended/disabled **user** → deny (honestly `authenticated`-identity but
authorization-denied; matches the reserved M6 `account_disabled`/`account_suspended` rows). A
suspended **tenant/store** → deny scoped actions (or `read_only` → allow read, deny write). Status
checks run with precedence **before** role evaluation.

## 12. `/auth/session/resolve` future strategy

Today and through M9: `authorization: null` stays — no endpoint change. Eventually, once the durable
model + a later approved slice exist, the endpoint returns `ServerDerivedAuthorizationV1` for an
`authenticated` actor (null on `token-verified`/failure). The M5 `AppAuthorization` and the M6 DTO
are **extended additively and versioned** so the single `mapWhoamiToAppSession` seam keeps working —
no second mapper, no fork.

## 13. Protected action future strategy

Future protected business APIs run on: verified identity → server-derived authorization → durable
audit → handler (the M2 `withProtectedAction` template, upgraded from advisory to durable audit).
Record the decision durably **before** a state-changing handler; record the outcome
(`resultStatus`) **after**. **Audit-write failure** → for sensitive/state-changing actions, **fail
closed** (deny/abort, no un-audited mutation); reads may degrade to advisory + flag. Default posture
is fail-closed (`AUDIT_WRITE_FAILURE_STRATEGY`).

## 14. RLS future strategy

Business tables get RLS **enabled with deny-all to anon/authenticated** (the `platform_identity`
pattern), so PostgREST + anon key can never read business data. Policies depend on **app-managed
authorization tables** (`membership`/`tenant`/`app_user`), **not raw JWT claims** (the JWT carries
identity, not roles). The API layer is the **primary guard**; RLS is **defense-in-depth**.
Implemented later alongside migrations — not in M9.

## 15. Service-role / server-only access strategy

The service-role key and DB URL stay strictly **server-only** — never `VITE_`-prefixed, never
bundled, never returned/logged. The **frontend never calls PostgREST directly for business data**;
all business reads/writes flow through the authenticated, audited API. The browser anon key is
limited to Supabase Auth + RLS-denied tables.

## 16. Backend Control Plane roadmap note

- The future **Backend Control Plane remains planned** as a separate parallel workstream.
- **It is NOT implemented in M9. No control-plane tool is connected.**
- **Server-derived authorization and durable audit are prerequisites** for it.
- `/auth/session/resolve` is **one prerequisite/access contract** for it.
- When built, it must be **API-only, fully audited, least-privilege, approval-gated**, and **must
  not** use the service-role key or direct Postgres access from any tool runtime.
- M9 supports it by specifying the authorization + audit contracts it will depend on.

## 17. Supabase MCP scope

**Not used.** No Supabase MCP, no Supabase configuration, no Auth-settings/schema/RLS change in M9.

## 18. Hostinger / deployment scope

**Not now.** Per the Phase 1.4 gate: Hostinger = static frontend/marketing/demo only; Replit =
dev-only; Supabase Postgres = production DB direction. No production API host decision in M9.

## 19. Prisma / ORM strategy

**Deferred.** The Phase 1.4 gate chose SQL-first/Supabase migrations with ORM deferred. The identity
sidecar continues to use the direct `postgres` helper. No ORM introduced in M9.

## 20. Migration-sequence design (future order — NONE executed in M9)

1. **Contract foundation** (this M9 slice) — inert authorization + audit contracts + diagnostics.
2. **Reviewed SQL migrations** — `app_user`, `tenant`, `store`, `membership`,
   `tenant_feature_entitlement`, `audit_event` (append-only); RLS deny-all; generated from the
   accepted contracts.
3. **Durable authorization resolver** — server-side resolution of `ServerDerivedAuthorizationV1`
   from durable state (still not wired into the endpoint).
4. **Durable audit writes** — append-only writer with the fail-closed strategy; advisory log retained.
5. **Session-resolve authorization wiring** — `/auth/session/resolve` returns the server-derived
   authorization (additive/versioned through the existing mapper seam).
6. **Protected business APIs** — built on identity → authorization → durable audit → handler.
7. **AccessContext migration** — the frontend begins consuming server-derived authorization
   (Firebase login retired per the reviewed migration).
8. **Backend Control Plane** — connected last, API-only, audited, least-privilege, approval-gated.

Each step is a separately-approved, reversible slice with its own QA.

## 21. Security rules (preserved)

No service-role key / DB URL / JWT secret in the frontend; no test password / access token
committed; no raw provider token printed/logged/returned/rendered; no refresh token / raw JWT
payload rendered or logged; no Supabase `user_metadata` trusted for authorization; no client-asserted
tenant/store/role/permission trusted; no Firestore auto-provisioning from a Supabase session; no
automatic real-user migration; no Firebase fallback verifier; no production auth/AccessContext
adoption; no backend route/schema/RLS change; no durable table added; no Backend Control Plane
implemented; no control-plane tool connected. The M9 contracts import nothing at runtime and
reference no secret.

## 22. QA evidence (Claude-run)

- `diagnostics-authorization-contract-check.ts` → **12/12 PASS**.
- `diagnostics-audit-event-contract-check.ts` → **10/10 PASS**.
- `npx tsc --noEmit` → pre-existing baseline errors only; **0 errors in M9 files**.
- `npm run build` → **success**; no runtime behavior changed; no secret bundled (server-side inert
  contracts are not imported by the client).
- Static safety grep — M9 files: no env reads, no DB/Supabase/Firebase/Express imports, no
  service-role/DB-URL/JWT-secret, no raw-DB-error field; secret/token names appear only inside the
  never-capture guard lists.
- Backend regression — M7 19/19, M6 15/15, M5 7/7, M3 23/23 (live I1 skip), M2 8/8, M8 13/13 — all PASS.
- Runtime isolation — M9 contracts imported only by the two M9 diagnostics; no AccessContext /
  AccessGuard / Login / App / pilot / business / server-runtime / endpoint import.
- Forbidden-file diff — none.

## 23. Rollback plan

Reversible by deletion: remove the three contract/constant files, the two diagnostics, and this doc
(and the optional `replit.md` line, if added). No migration, schema, RLS, runtime, endpoint, or
dependency change → nothing else to roll back. Mirrors the M5/M6/M8 rollback pattern.

## 24. Deferred items (after M9)

Durable migrations; RLS policies; durable authorization resolver; durable audit writes; wiring
server-derived authorization into `/auth/session/resolve`; protected business APIs; AccessContext
consuming server authorization; shared-catalog code unification touching `src/`; Backend Control
Plane connection; Supabase MCP/config; Hostinger/production host decision; ORM introduction;
Firebase→Supabase auth migration.

---

**Not committed / not pushed / not backed up; pending review.** Working tree contains only the
allowed uncommitted M9 changes.
