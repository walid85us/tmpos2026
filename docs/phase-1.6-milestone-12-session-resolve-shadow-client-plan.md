# Phase 1.6 M12 — Dormant Session-Resolve Shadow Route-Call Helper (DEV-Flag-Gated, Imported-by-Nothing, Invoked-by-Nothing) — Plan & Closeout

**Status:** IMPLEMENTED — pending owner review / manual QA. Not committed, not pushed, not backed
up. No current app behavior changed. **Firebase remains the sole active / default / authoritative
session source.** No DB connection, route call, migration, seed, SQL, audit write, Supabase MCP,
live route call, package change, backend change, or production change occurred. **The helper was
authored but NEVER invoked; `/auth/session/resolve` was NOT called.**

**Accepted base checkpoint:** `a4b115166555fb2150e5db8edfb7743d9ad8374b`
(Phase 1.6 M11 — add dormant Supabase token bridge).

**Selected design:** **Option C** from the accepted M12 planning pass — a dormant, DEV-flag-gated
session-resolve shadow route-call helper that uses the M11 token bridge (`withSupabaseAccessToken`)
to call the backend route with a Bearer header + empty `{}` body, reads only safe status/shape
fields, returns a non-secret status record, and is imported by nothing active / invoked by nothing.

---

## 1. Why this milestone exists

M11 proved raw Supabase-token handling is safe (immediate-use callback; token never returned /
stored / logged / surfaced / transmitted). M12 is the next, still-dormant layer: the *shape* of a
route-call that would, in a future separately-approved step, send that token to the backend
session-resolve route in a SHADOW (observational, non-authoritative) mode. M12 authors that helper
and proves it dormant and safe — and **calls nothing**.

## 2. Scope

**In scope (added):**
- `src/auth/sessionResolveShadowClient.ts` — dormant shadow route-call helper; imports the M11
  token bridge + its own types only.
- `src/auth/sessionResolveShadowClientTypes.ts` — pure types (no imports; no token/authz/identity
  fields).
- `scripts/diagnostics-session-resolve-shadow-client-dormant-check.ts` — 92-check dormancy +
  route/token/response-safety proof (static/offline).
- This document.

**In scope (controlled modifications):**
- `scripts/diagnostics-supabase-token-bridge-dormant-check.ts` — **check 49b** relaxed to allow
  EXACTLY the dormant M12 shadow client as the sole bridge importer, **plus new 49c–49e** asserting
  the shadow client is itself imported by nothing active. No token-safety / storage / logging /
  exposure / no-route-call / foundation-importer / bundle check weakened. The bridge itself still
  references neither `VITE_ENABLE_SESSION_RESOLVE_SHADOW` nor `VITE_ENABLE_SERVER_AUTHZ_SHADOW`.
- `scripts/diagnostics-frontend-bundle-secret-scan-check.ts` — **additive check 2f only**
  (`sessionResolveShadowClient` / `runSessionResolveShadowCheck` / `VITE_ENABLE_SESSION_RESOLVE_SHADOW`
  absent from `dist/**`). No existing check weakened; deliberately NOT a blanket
  `/auth/session/resolve` / `Authorization` / `Bearer` ban (the pilot legitimately uses them).
- `scripts/diagnostics-frontend-auth-provider-inventory-check.ts` — **check 2c only**
  (**owner-authorized controlled allowlist**, beyond the original M12 scope, approved after the
  conflict was surfaced): the non-pilot `/auth/session/resolve` guard now excepts the single
  dormant shadow helper `src/auth/sessionResolveShadowClient.ts`. The check still FAILS for any
  other non-pilot reference.
- `scripts/diagnostics-frontend-supabase-auth-readiness-check.ts` — **check 3c only**
  (**owner-authorized controlled allowlist**, same rationale): identical single-file exception; the
  check still FAILS for any other non-pilot reference.
- `replit.md` — one M12 pointer line.

> **Note on the two extra controlled modifications:** checks 2c/3c ban any non-pilot
> `/auth/session/resolve` reference. The dormant shadow helper must reference the route explicitly
> (no obfuscation — the route literal is kept auditable). This was surfaced to the owner, who
> authorized exempting exactly `src/auth/sessionResolveShadowClient.ts` in both checks, mirroring
> the existing controlled-allowlist precedent (2a/2g/8b). The helper's dormancy is independently
> proven by the M12 diagnostic.

**Explicitly NOT touched:** `src/context/AccessContext.tsx` (M8 observer wiring), the M9
private-surface lock, the M11 token bridge files, Login, AccessGuard, App routing, `src/main.tsx`,
`src/pilot/**`, `src/firebase.ts`, accessConfig, platformPermissionsConfig, M5 foundation files, M6
bootstrap files, M7 helper files, all `server/**`, migrations, seeds, `package.json`,
`package-lock.json`, `.replit`, secrets, Supabase/Firebase config.

## 3. Shadow client API

```ts
runSessionResolveShadowCheck(
  options?: { signal?: AbortSignal },
): Promise<SessionResolveShadowResult>
```

`SessionResolveShadowResult` (non-secret): `{ ok, status, phase, requestId?, authState?, decision?,
reasonCode?, sourceOfTruth?, message }`. `phase` ∈ `disabled | token_bridge_disabled | no_session |
no_token | cancelled | route_disabled | denied | resolved | unreachable | server_error | malformed`.
It NEVER carries a token, the raw response body, server-derived `authorization`,
permissions/subPermissions/role/tenant/plan, or any identity field (`internalUserId` /
`authProvider` / `authProviderUid` / `email` / `displayName` / `identity`). Messages are
PHASE-DERIVED — they never echo server/response content.

## 4. Why dormant / imported by nothing active / invoked by nothing

The helper is imported by **nothing active** (not AccessContext / Login / AccessGuard / App / main /
pilot) and by no other `src/**` file, so the bundler tree-shakes it (and, through it, the token
bridge + foundation) out of production. It has **no import-time side effects** and **no top-level
await**: the token bridge is invoked, and the route is called, ONLY when
`runSessionResolveShadowCheck()` is explicitly called — and **M12 adds no call site**. Proven by the
M12 dormancy diagnostic (checks 22–30, 49c–49e in the bridge check) and the bundle scan (check 2f).

## 5. Why no live route call occurs in M12

There is no active caller and no QA invocation, so `/auth/session/resolve` is never called. A live
call is deliberately deferred because, when backend flags are enabled, the route is **not
side-effect-free**.

## 6. Backend route side-effect facts (binding cautions)

- `/auth/session/resolve` **upserts a `platform_identity` row** on a verified token when backend
  config is complete (even with live-authz OFF).
- An **advisory audit envelope** (server log; no durable table at that layer) is emitted on every
  path when the route runs.
- A **durable `audit_event` row** is written only when `ENABLE_LIVE_SESSION_AUTHORIZATION=true`
  (then `authorization` is non-null only on an allow that was durably audited — fail-closed).
- Backend gates (`ENABLE_SUPABASE_PLATFORM_IDENTITY`, `ENABLE_SESSION_RESOLVE`,
  `ENABLE_LIVE_SESSION_AUTHORIZATION`) are **server-side env vars**, separate from the frontend
  `VITE_*` flags; with the route disabled (default), a call returns 404 with no side effects.

## 7. Required future live-call guardrails (NOT run in M12)

Any future live invocation requires, separately and explicitly: (1) owner approval naming the live
test; (2) confirmation backend route flags are DEV-only; (3) confirmation production is not
targeted; (4) confirmation of whether identity upsert may occur; (5) pre/post identity-row or safe
identity-delta check *only if* DB access is separately approved; (6) pre/post `audit_event` count or
audit-delta check *only if* the live-authz flag is on AND DB access is separately approved; (7) the
expectation that advisory audit logs may occur; (8) a one-time bounded test only; (9) no token
printed; (10) no sensitive response body printed; (11) no route call if DB/audit guardrails are not
approved; (12) immediate stop on any unexpected side effect. **M12 implementation performs none of
these.**

## 8. Token discipline

The raw token is obtained ONLY inside the M11 bridge's immediate-use callback and used ONLY as the
outgoing `Authorization: Bearer <token>` header value. The body is EXACTLY `{}`. The token is never
sent in the body, placed in the URL/query, logged, persisted, stored, returned, or included in the
status record or any message/error.

## 9. Why `authorization` + identity fields are ignored in M12

Server-derived `authorization` is read/compared only in M13 (server-authz shadow comparison). In
M12 the helper does not read `authorization` at all, and reads no identity field into the result —
it classifies shape/status only. This keeps M12 a pure dormancy + route/token/response-safety
proof.

## 10. Flag strategy & default-OFF posture

`VITE_ENABLE_SESSION_RESOLVE_SHADOW` — DEV-only, default OFF, separate from the foundation /
bootstrap / awareness / diagnostic-surface / token-bridge / server-authz-shadow flags. Enablement =
DEV build **and** the flag === `'true'` **and** the M11 token bridge enabled
(`isSupabaseTokenBridgeEnabled()`). No `VITE_ENABLE_SESSION_RESOLVE_ROUTE_HELPER` is introduced
(redundant). `VITE_ENABLE_SERVER_AUTHZ_SHADOW` is NOT referenced (reserved for M13).

## 11. Production bundle exclusion proof (required)

Because M12 adds a frontend helper, an offline `npm run build` + bundle secret scan are required.
The scan (check 2f) asserts the shadow-client identifiers + flag are absent from `dist/**`
(alongside the foundation/bootstrap/awareness/observer/token-bridge identifiers and all privileged
Supabase/DB patterns).

## 12. Diagnostic strategy

`scripts/diagnostics-session-resolve-shadow-client-dormant-check.ts` (static/offline, reads `src/**`
as TEXT only) proves: existence; import allowlist (token bridge + own types only; no SDK / React /
Firebase / foundation-direct / bootstrap / awareness / pilot / server); lazy (no import-time call,
no top-level await); dormancy (imported by nothing active, no call site, invoked by nothing);
DEV+flag gating + token-bridge requirement; Bearer header + `{}` body + content-type; base URL from
`VITE_IDENTITY_API_BASE` (`/__identity` default); token-safety (Bearer-only, never body/URL/log/
store/return); response-safety (safe shape fields only; no `authorization` read; no identity fields;
phase-derived messages); no storage/state/UI/window/DOM-event/browser→DB/secret; cancellation +
no-throw + phase coverage; self-inertness.

## 13. QA plan (non-live, offline only)

`tsc --noEmit` (0 new errors, no M12 file in the list); the new M12 diagnostic; the updated
token-bridge diagnostic; the updated inventory + readiness diagnostics; the full M1–M11 regression
suite; and an offline `npm run build` + bundle secret scan. No live route diagnostics, DB-backed
diagnostics, audit-writer diagnostics, SQL, migrations, seeds, or Supabase MCP.

## 14. Rollback plan

1. Delete `src/auth/sessionResolveShadowClient.ts`, `src/auth/sessionResolveShadowClientTypes.ts`,
   `scripts/diagnostics-session-resolve-shadow-client-dormant-check.ts`, and this doc.
2. Revert the additive bundle-scan check `2f`.
3. Revert the controlled token-bridge allowlist (49b + 49c–49e) to the M11 `49b`.
4. Revert the controlled inventory (2c) and readiness (3c) single-file exceptions.
5. Revert the `replit.md` M12 pointer line.
6. No DB/audit rollback (no route call, migration, seed, SQL, schema/RLS/Auth change, or DB write
   occurred). Runtime is already neutralized by the flag being absent/false (the default).

`git revert` (or reset to `a4b1151`) fully restores M11 state.

## 15. M13 hand-off (deferred)

A private, non-authoritative server-authz SHADOW comparison that reads the server `authorization`
field when present, normalizes it to the permission-catalog key space, and compares **structurally**
(key-space coverage) against the legacy client engine — behind `VITE_ENABLE_SERVER_AUTHZ_SHADOW`.
Private ref/status only; no enforcement; never affects session/permissions/routing/AccessGuard/
loading.

## 16. Explicitly deferred stages (post-M12)

Live `/auth/session/resolve` invocation; identity/audit delta guardrails; server-derived
`authorization` read; server-authz shadow comparison (M13); AccessContext shadow wiring; pilot
`authorization: null` pin update; enforcement; Login migration; protected business APIs; Backend
Control Plane; Backend UI Control Panel; Database Operations Console / direct DB control; production
migration 003. Each requires its own explicit, separately-approved milestone.
