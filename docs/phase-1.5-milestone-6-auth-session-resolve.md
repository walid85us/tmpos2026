# Phase 1.5 — Milestone 6: Production-Safe `/auth/session/resolve` — Contract-Only Foundation

**Status:** Implemented (Option B — contract-only) — not committed / not pushed / not backed up; pending review.
**Option:** B — inert contract/types/constants + pure tests + this doc. **No route, no runtime endpoint, no frontend adoption.**
**Checkpoint:** built on `45a1649673fcf7285245dbb046424794140f3178` (Phase 1.5 M5 provider-agnostic session model).

## Scope

M6 (Option B) adds **inert** foundations only for a *future* production-safe session-resolution endpoint:

1. A shared **contract module** — wire response DTO + reason-code constants + action/evaluator labels + the status/decision/authState matrix (`server/platform-identity/sessionResolveContract.ts`).
2. A **pure offline diagnostic** proving the DTO is representable for every row, aligns with the M5 `AppSession` mapper, keeps `authorization` null, fails closed, ignores forged authority, and carries no secrets (`scripts/diagnostics-session-resolve-contract-check.ts`).
3. This document.

There is **no route**, **no runtime endpoint**, **no frontend adoption**, **no AccessContext change**, **no M4 pilot change**, **no schema/RLS/MCP/deployment change**, **no new dependency**, and **no Backend Control Plane implementation**.

## Why this is contract-only (Option B)

- The contract module contains **types and const data only** — no functions, no I/O, no side effects.
- It imports **nothing** (no Express, DB, Supabase, Firebase, `jose`); reads **no** env; parses **no** token; emits **no** audit.
- It is imported by **nothing at runtime** — only by the M6 diagnostic script (and referenced by this doc). The live app and all server routes do not reference it.
- Removing the three files restores the exact pre-M6 state (see Rollback).
- The current identity API is a **dev-only sidecar** (`npm run identity:api`, not in the `static` deploy). There is **no durable production API host, no durable audit table, and no server-derived authorization** yet — so a route advertised as "production-safe" would be production-safe *in name only*. Building the contract first de-risks a later endpoint slice without any runtime surface.

## Why no route is added

A real `/auth/session/resolve` route depends on prerequisites that do not yet exist (durable append-only audit, a production API host, CORS/rate-limit strategy, and — for full value — server-derived authorization). M6 establishes the **shared contract** those future slices will implement against; it does not register a route or add endpoint behavior.

## Why M3 whoami remains diagnostic-only

`POST /diagnostics/supabase-whoami` is double feature-gated (`ENABLE_SUPABASE_PLATFORM_IDENTITY` **and** `PLATFORM_IDENTITY_VERIFIED_DIAGNOSTICS`) and **never served in production**. It proves the verification mechanism; it is not a production session source. M6 **reuses its verifier and reason codes by reference** and does **not** modify it.

## Why the M4 pilot remains isolated

The Supabase pilot under `src/pilot/**` stays dev+flag gated and isolated at `/dev/supabase-pilot` (outside `/` and `/owner`, not wrapped by `AccessGuard`). M6 does not modify it and does not wire it to the contract. A future, separately-approved slice may let the pilot call the real endpoint once it exists.

## Why M5 AppSession is reused / aligned

The contract DTO's **flat fields** (`status..error`) are a superset that is assignment-compatible with the M5 mapper input (`WhoamiResponseInput`), so the existing pure `mapWhoamiToAppSession` remains the **single client-side normalization seam** — there is no second mapping to maintain. The DTO's **structured fields** (`identity`, `authorization`) mirror the resulting `AppSession` view. The M6 diagnostic runs success/failure DTOs through the real M5 mapper to prove alignment.

## Proposed future request contract

- **Method/path:** `POST /auth/session/resolve` (declared as `SESSION_RESOLVE_PATH`; **not registered** in M6).
- **Authority:** `Authorization: Bearer <provider access token>` — the **only** trusted input. Missing/blank/non-bearer ⇒ `denied_unauthenticated`.
- **Body:** empty / ignored. The endpoint reads **no** authority from the body. Optional non-authority correlation hints only (e.g. a sanitized `clientRequestId`).
- **Never read (even if present):** any user object, `internalUserId`, `role`, `userType`, `tenantId`, `storeId`, `permissions`, `subPermissions`, `user_metadata`, or provider claims as authority.

## Response contract

Safe, M5-`AppSession`-aligned (`SessionResolveResponseDTO`):

- Success (200): `authState: 'authenticated'`, `identity` populated (`internalUserId`, `authProvider`, reference `authProviderUid`/`email`/`displayName`), `authorization: null`, `sourceOfTruth: 'supabase_verified_token'`, `requestId`, `reasonCode: 'verified_supabase'`.
- Non-success: `identity: null`, `authorization: null`, the appropriate `authState` + `reasonCode`, and a safe structured `error`.
- **Invariants:** `authorization` is **always** `null`; `identity` is non-null only on an authenticated success; `token-verified` is **never** represented as `authenticated`; **no** secret/token field ever appears (`accessToken`, `refreshToken`, `rawJwt`, `jwtPayload`, `jwks`, `serviceRoleKey`, `databaseUrl`, `connectionString`).

## Status / reason matrix

Single source of truth: `SESSION_RESOLVE_MATRIX`.

| Reason code | HTTP | decision | authState | Notes |
|---|---|---|---|---|
| `verified_supabase` | 200 | allow | `authenticated` | verified token + resolved `internal_user_id` |
| `denied_unauthenticated` | 401 | deny | `unauthenticated` | no/blank/non-bearer header |
| `supabase_token_invalid` | 401 | deny | `unauthenticated` | bad signature/format/no subject |
| `supabase_token_expired` | 401 | deny | `unauthenticated` | expired |
| `supabase_token_wrong_issuer` | 401 | deny | `unauthenticated` | issuer claim mismatch |
| `supabase_token_wrong_audience` | 401 | deny | `unauthenticated` | audience claim mismatch |
| `jwks_unavailable` | 503 | deferred | `unauthenticated` | infra/transient |
| `identity_resolution_error` | 503 | deferred | **`token-verified`** | token proven, no app id (incl. DB unavailable) — **fail-closed, never authenticated** |
| `account_disabled` | 403 | deny | `authenticated` | **RESERVED/FUTURE** — needs account-status persistence |
| `account_suspended` | 403 | deny | `authenticated` | **RESERVED/FUTURE** — needs account-status persistence |
| `session_resolve_error` | 500 | deferred | `unauthenticated` | unexpected handler error |

## Identity resolution rules

- `internal_user_id` is resolved via the M1 mapping (`auth_provider='supabase'`, `auth_provider_uid=<verified sub>`).
- Success **requires** a non-empty `internal_user_id`. No id ⇒ fail-closed `token-verified` / `identity_resolution_error`; **never fabricate** an id; **never** emit `authenticated`.
- Resolve-or-create is acceptable in the identity-only era (it maps a provider sub to an app id only — **not** Firestore user provisioning and creates **no** tenant/business/role data). A stricter read-only "must pre-exist" variant is a future option.
- Only verified claims are trusted; `user_metadata` name is a reference display value only — never authority.

## Authorization rules

- `authorization` is **ALWAYS `null`** in this era. No role/scope/tenant/store/permissions are derived or returned.
- Identity-only success is allowed and expected (authentication ≠ authorization).
- **Never fabricate** tenant/store/role/permissions; **never trust** `user_metadata` or any client assertion for authorization.

## Audit / logging plan

- Future endpoint reuses the M2/M3 audit envelope with `actionId = platform.auth.session-resolve`, `evaluatedBy = session_resolve@v0`, `sourceOfTruth = supabase_verified_token`; `actorId` = `internal_user_id` on success, `null` on a failure-labelled envelope.
- **Production prerequisite:** a **durable, append-only, server-written** audit table must replace advisory logging before production enablement.
- **Never log:** raw token, JWT payload/header, JWKS keys, secrets, DB URL, service-role, connection string, raw DB errors (use `sanitizeError`).

## Browser safety rules

Return only safe AppSession fields. `authProviderUid` and verified `email` are reference/display only. **Never** return raw access/refresh tokens, JWT payload/header, JWKS material, service-role key, DB URL, JWT secret, or connection string. No raw JWT payload is ever rendered.

## Production-safety prerequisites

Before any production-enabled endpoint: (1) durable append-only audit; (2) a real production API host (not the dev sidecar / not `static`); (3) explicit CORS allow-list (no wildcard-with-credentials); (4) rate limiting / abuse protection; (5) JWKS verification (no `SUPABASE_JWT_SECRET`); (6) server-only secrets; (7) clear rollback. None are in scope for M6.

## Feature flag / default-off strategy (future endpoint)

A future endpoint must be gated behind a dedicated default-OFF flag (e.g. `ENABLE_SESSION_RESOLVE`) **plus** `ENABLE_SUPABASE_PLATFORM_IDENTITY`, and — for a dev prototype — non-production only (mirroring `isVerifiedDiagnosticsEnabled`). Default app behavior never changes; flags default OFF.

## Server placement strategy

Contract/types live under `server/platform-identity/`. A future endpoint would prototype in the **isolated identity API** (dev only); the **production home is deferred** to the durable-API-tier decision. Do not assume the dev sidecar becomes the production host.

## Provider adapter strategy

Supabase only first, via the existing `AuthAdapter` seam (JWKS verifier from M3). The shape stays provider-neutral (`SessionAuthProvider`). **No Firebase verifier** is implemented (`StubFirebaseAuthAdapter` continues to throw `firebase_verification_not_implemented` — never a silent allow).

## Firebase coexistence

Firebase Auth remains the **active/default** login (`Login.tsx`, `AccessContext`, Firestore `users/{uid}` read), untouched. M6 adds no Firebase token verification, no Firebase→Supabase migration, no Firestore auto-provisioning from a Supabase session. Firebase retirement is a far-future, separately-approved milestone.

## Supabase coexistence

The M3 whoami and M4 pilot remain the only Supabase-touching runtime paths, both dev/flag-gated and unchanged. M6 reuses the M3 verifier and M5 mapper by reference without modifying them. No Supabase Auth settings, schema, RLS, or MCP.

## Backend Control Plane dependency note

- `/auth/session/resolve` is a **future prerequisite / access contract** for the planned, separate **Backend Control Plane** workstream: operators would authenticate (separate SSO+MFA) and obtain a server-derived session via this endpoint, then call protected actions through the enforced API.
- The **Backend Control Plane is NOT implemented in M6.** No control-plane tool (Retool/ToolJet/Budibase/Forest Admin/Directus/etc.) is connected, configured, or referenced in code.
- It is documented here only to record the dependency direction (control plane depends on this contract, not the reverse).

## Files added

- `server/platform-identity/sessionResolveContract.ts` — inert contract types + constants + matrix.
- `scripts/diagnostics-session-resolve-contract-check.ts` — pure offline contract/alignment check.
- `docs/phase-1.5-milestone-6-auth-session-resolve.md` — this document.

## Files modified

- None.

## QA evidence

Recorded in the implementation pass report (Claude-run). Summary of checks:

- `npx tsx scripts/diagnostics-session-resolve-contract-check.ts` — all cases PASS.
- `npx tsx scripts/diagnostics-appsession-map-check.ts` — 7/7 PASS.
- `npx tsx scripts/diagnostics-supabase-whoami-check.ts` — existing PASS count.
- `npx tsx scripts/diagnostics-protected-action-check.ts` — 8/8 PASS.
- `npx tsc --noEmit` — 0 errors in M6 files (pre-existing baseline noted).
- `npm run build` — success.
- Runtime isolation grep — M6 contract imported by nothing except the M6 diagnostic.
- Secret-safety scan — no token/JWT/JWKS/secret/DB-URL; no env reads in M6 modules.
- Forbidden-file diff — none changed.

## Deferred items

- The actual `/auth/session/resolve` route (Option C/D) and its production enablement.
- Durable append-only audit; production API host; CORS/rate-limit.
- Server-derived authorization (role/scope/tenant/store/permissions) and its tables.
- Account disabled/suspended status persistence and the reserved reason codes.
- AccessContext adoption (flagged), M4 pilot integration, full Supabase Auth adoption, Firebase retirement.
- Schema/RLS/migrations; Supabase MCP; Hostinger/deployment; OAuth/redirect/CORS.
- Backend Control Plane workstream (separate; depends on this contract).

## Rollback plan

Delete the three added files (or `git checkout -- .` / revert the slice). Because no runtime code imports them, removal cannot affect app behavior.

---

**Not committed / not pushed / not backed up; pending review.**
