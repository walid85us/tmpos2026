# Phase 1.5 — Milestone 7: Default-Off `/auth/session/resolve` Dev-Only Prototype

**Status:** Implemented (Option D — default-off, dev-only, production-force-disabled) — not committed / not pushed / not backed up; pending review.
**Checkpoint:** built on `89c64254a205acfb03c0295594d0988e610d2c4d` (Phase 1.5 M6 session resolve contract).

## Scope

M7 implements a **default-off, dev-only, production-force-disabled** `/auth/session/resolve` runtime prototype in the **isolated identity API only**. It verifies a Supabase token (M3 verifier), resolves the app-owned `internal_user_id` (M1 mapping, fail-closed), emits an advisory audit envelope (M2), and returns the **M6 contract DTO** aligned to the M5 `AppSession` mapper, with `authorization` **always null**.

Added:
1. `server/platform-identity/sessionResolve.ts` — `createSessionResolveHandler({ adapter?, resolveIdentity? })`.
2. `scripts/diagnostics-session-resolve-check.ts` — hermetic check (mock adapter + resolver; no live Supabase/DB).
3. This document.

Modified (additive only):
4. `server/platform-identity/config.ts` — `ENABLE_SESSION_RESOLVE` flag + `isSessionResolveEnabled()`.
5. `server/platform-identity/server.ts` — register one `POST /auth/session/resolve` route.

**No frontend adoption, no AccessContext change, no M4 pilot change, no schema/RLS, no durable audit, no production enablement, no new dependency, no Backend Control Plane implementation.**

## Why Option D was selected

The M3 `/diagnostics/supabase-whoami` endpoint is an exact, already-accepted precedent: a registered, default-OFF, production-disabled, hermetically-tested dev route in the *same* isolated sidecar performing the *same* verify→resolve→audit→safe-response flow. Every building block already existed and is injectable, so Option D could be proven default-off, dev-only, isolated, and fully regression-tested with zero live dependencies. The endpoint returns `authorization: null` and is not a business-data API, so it does not trip the architecture-direction §16 gate.

## Why default-off / dev-only / production-force-disabled

- **Two independent default-OFF flags:** the route does nothing unless `ENABLE_SUPABASE_PLATFORM_IDENTITY === 'true'` **AND** `ENABLE_SESSION_RESOLVE === 'true'`.
- **Production force-disable:** `isSessionResolveEnabled()` returns `false` whenever `NODE_ENV === 'production'`, regardless of the flag — so even a leaked flag yields `404 FEATURE_DISABLED` in production. Conservative by design: `NODE_ENV` is used only to *disable*, never to *enable*.
- **Isolated:** the route lives only in the identity sidecar (`server/platform-identity/server.ts`, run via `npm run identity:api`, not in the `static` deploy, not started by `npm run dev`). It is absent from `server/index.ts` and from `src/`.

## Request contract

- `POST /auth/session/resolve`. `Authorization: Bearer <token>` is the **only** authority. Missing/blank/non-bearer ⇒ `denied_unauthenticated`.
- Body empty / ignored. The handler reads **no** authority from the body — any `role`, `userType`, `tenantId`, `storeId`, `permissions`, `subPermissions`, `user_metadata`, or `internalUserId` on it is ignored entirely.

## Response contract

Returns the M6 `SessionResolveResponseDTO`. Success (200): `authState: 'authenticated'`, `identity` populated (`internalUserId`, `authProvider: 'supabase'`, reference `authProviderUid`/`email`/`displayName`), `authorization: null`, `sourceOfTruth: 'supabase_verified_token'`, `requestId`, `reasonCode: 'verified_supabase'`. Non-success: `identity: null`, `authorization: null`, appropriate `authState`/`reasonCode`, safe `error`. **No** secret/token field ever appears.

## Status / reason matrix

Driven by the M6 `SESSION_RESOLVE_MATRIX`:

| Reason | HTTP | decision | authState |
|---|---|---|---|
| `verified_supabase` | 200 | allow | authenticated |
| `denied_unauthenticated` | 401 | deny | unauthenticated |
| `supabase_token_invalid` | 401 | deny | unauthenticated |
| `supabase_token_expired` | 401 | deny | unauthenticated |
| `supabase_token_wrong_issuer` | 401 | deny | unauthenticated |
| `supabase_token_wrong_audience` | 401 | deny | unauthenticated |
| `jwks_unavailable` | 503 | deferred | unauthenticated |
| `identity_resolution_error` | 503 | deferred | **token-verified** |
| `session_resolve_error` | 500 | deferred | unauthenticated |
| `account_disabled` / `account_suspended` | 403 | deny | authenticated | **RESERVED/FUTURE — not emitted in M7** |

## Identity resolution behavior

Resolve-or-create via the M1 mapping (`auth_provider='supabase'`), reusing the same path as M3 whoami (maps a provider sub → app id only; creates **no** business/role/Firestore data). Success requires a non-empty `internalUserId`. A verified token with **no** resolved id — whether the resolver returns null, config is incomplete, or the DB is unavailable (resolver throws) — is **fail-closed** to `identity_resolution_error` / `token-verified` / 503, never `authenticated`, never a fabricated id.

## Authorization remains null

`authorization` is `null` on every path. No role/scope/tenant/store/permissions are derived or returned. `user_metadata` and any client assertion are never trusted. Server-derived authorization is a later, separately-approved milestone.

## Audit is advisory only

Reuses the M2 `auditEnvelope` (log-only, `evidenceLevel: 'dev_sidecar_log_advisory'`, **not** compliance evidence), emitted on **every** path (allow/deny/deferred), with `actionId = platform.auth.session-resolve`, `evaluatedBy = session_resolve@v0`, `sourceOfTruth = supabase_verified_token`. `actorId` = the app-owned `internal_user_id` on success, `null` on every failure/deferred path (never claims an authenticated actor with a null id). Never logs the raw token, JWT payload, JWKS keys, secrets, DB URL, service-role key, connection string, or raw DB errors (sanitized summaries only).

## Production prerequisites (deferred)

Before any production enablement: durable append-only audit; a real production API host (not the dev sidecar); explicit CORS allow-list; rate limiting; server-only secrets; clear rollback. None are in scope for M7.

## M3 whoami unchanged

`server/platform-identity/verifiedWhoami.ts` and `supabaseAuthAdapter.ts` are reused (verifier + `SupabaseTokenError`) but **not modified**. The M3 diagnostic endpoint is untouched.

## M4 pilot unchanged

`src/pilot/**` is untouched. A future, separately-approved slice may add an optional pilot call to this endpoint.

## M5 mapper unchanged

`src/auth/mapWhoamiToAppSession.ts` is reused in tests (the success DTO maps cleanly to an authenticated `AppSession`; `token-verified` is preserved, never upgraded) but **not modified**.

## M6 contract reused

`server/platform-identity/sessionResolveContract.ts` provides the DTO, reason codes, matrix, action id, evaluator label, and source-of-truth — imported and **not modified**.

## Firebase coexistence

Firebase Auth remains the active/default login (`Login.tsx`, `AccessContext`, Firestore `users/{uid}` read), untouched. No Firebase token verifier (the `StubFirebaseAuthAdapter` still throws `firebase_verification_not_implemented`). No Firebase→Supabase migration, no Firestore auto-provisioning from a Supabase session.

## Supabase coexistence

M3 whoami and M4 pilot remain the only other Supabase runtime paths, unchanged. No Supabase Auth settings, schema, RLS, or MCP.

## Backend Control Plane roadmap note

- The Backend Control Plane remains a **planned future parallel workstream**. It is **not implemented in M7** and **no control-plane tool is connected** to live data.
- `/auth/session/resolve` is **one prerequisite / access contract** for it: operators would authenticate (separate SSO+MFA), obtain a server-derived session via this endpoint, then call protected actions through the enforced API.
- Any future control plane must remain **API-only, audited, least-privilege**, and **must never** use the service-role key or direct Postgres access from the tool runtime.

## QA evidence

Recorded in the implementation pass report (Claude-run). Summary:

- `npx tsx scripts/diagnostics-session-resolve-check.ts` — **19/19 PASS** (flag matrix incl. production force-disable; every reason-code row; AppSession mapping; fail-closed; forged-authority ignored; secret-free DTO; advisory audit on all paths with correct actorId).
- `npx tsx scripts/diagnostics-session-resolve-contract-check.ts` — 15/15 PASS.
- `npx tsx scripts/diagnostics-appsession-map-check.ts` — 7/7 PASS.
- `npx tsx scripts/diagnostics-supabase-whoami-check.ts` — 23/23 PASS.
- `npx tsx scripts/diagnostics-protected-action-check.ts` — 8/8 PASS.
- `npx tsc --noEmit` — 12 pre-existing baseline errors, **0 in M7-touched files**.
- `npm run build` — success.
- Runtime isolation — handler imported only by `server.ts` + the M7 diagnostic; route absent from `server/index.ts` and `src/`.
- Secret-safety — no token/JWT/JWKS/secret/DB-URL; no env reads in the handler (flag checks live in `config.ts`).
- Forbidden-file diff — only the allowed files changed.

## Rollback plan

Delete `server/platform-identity/sessionResolve.ts`, `scripts/diagnostics-session-resolve-check.ts`, and this doc; `git checkout --` the additive edits to `server/platform-identity/config.ts` and `server/platform-identity/server.ts`. The flag defaults OFF and the route is production-force-disabled, so even an un-reverted route is inert by default and in production. `git checkout -- .replit` if port noise reappears. HEAD stays at the accepted checkpoint until an explicit commit.

---

**Not committed / not pushed / not backed up; pending review.**
