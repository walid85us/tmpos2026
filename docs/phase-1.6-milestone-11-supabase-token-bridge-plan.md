# Phase 1.6 M11 — Dormant Supabase Token Bridge Helper (DEV-Flag-Gated, Immediate-Use, No Route Call) — Plan & Closeout

**Status:** IMPLEMENTED — pending owner review / manual QA. Not committed, not pushed,
not backed up. No current app behavior changed. **Firebase remains the sole active / default /
authoritative session source.** No DB connection, route call, migration, seed, SQL, audit write,
Supabase MCP, live route call, package change, backend change, or production change occurred.

**Accepted base checkpoint:** `3ed357d48218a901611c68987c8ad6fc895d4496`
(Phase 1.6 M9 — lock private Supabase observer surface).

**Selected design:** **Option C** from the accepted M10 planning pass — a dormant, DEV-flag-gated
token bridge that yields a Supabase access token to an **immediate-use callback** and nothing
else. No `/auth/session/resolve` call, no AccessContext wiring, no token exposure.

---

## 1. Why this milestone exists

The M10 planning pass established that a **live** `/auth/session/resolve` call is **not
side-effect-free** when the backend route is enabled: the route verifies the bearer token,
**upserts a durable `platform_identity` row** (via `upsertIdentity`), emits an **advisory audit
envelope** (server log; no durable table at that layer) on every path, and writes a **durable
`audit_event` row** only when `ENABLE_LIVE_SESSION_AUTHORIZATION=true`. Therefore, before any
route call, the frontend must first prove **raw token handling is safe**. M11 does exactly that
and nothing more: obtain a token on demand, pass it to an immediate-use callback, and never
return / store / log / persist / surface / transmit it.

## 2. Scope

**In scope (added):**
- `src/auth/supabaseTokenBridge.ts` — dormant token bridge; imports the M5 foundation only.
- `src/auth/supabaseTokenBridgeTypes.ts` — pure types (no imports; no token fields).
- `scripts/diagnostics-supabase-token-bridge-dormant-check.ts` — 75-check dormancy + token-safety proof.
- This document.

**In scope (controlled modifications):**
- `scripts/diagnostics-supabase-auth-foundation-dormant-check.ts` — **check 8b only**: the M5
  foundation may now be imported by the M6 bootstrap **and** the M11 token bridge. All other
  foundation checks (DEV gating, default-OFF, no service-role/DB URL, no browser→DB, no
  import-time side effects, entrypoint/AccessContext/Login/AccessGuard/App/main isolation,
  bundle exclusion) are unchanged.
- `scripts/diagnostics-frontend-auth-provider-inventory-check.ts` — **check 2g only**
  (owner-authorized addition to the M11 scope): identical controlled allowlist (foundation
  imported by the bootstrap **and** the token bridge), mirroring the M6 precedent that updated
  both this check and 8b. The SDK allowlist (2a), pilot isolation (2b/2c), entrypoint dormancy
  (2f), env-name (4), and all other inventory checks are unchanged.
- `scripts/diagnostics-frontend-bundle-secret-scan-check.ts` — **additive check 2e only**
  (`supabaseTokenBridge` / `withSupabaseAccessToken` / `VITE_ENABLE_SUPABASE_TOKEN_BRIDGE`
  absent from `dist/**`). No existing check weakened; deliberately NOT a blanket `access_token`
  ban (the pilot legitimately reads `session.access_token`).
- `replit.md` — one M11 pointer line.

**Explicitly NOT touched:** `src/context/AccessContext.tsx` (M8 observer wiring), the M9
private-surface lock, Login, AccessGuard, App routing, `src/main.tsx`, `src/pilot/**`,
`src/firebase.ts`, accessConfig, platformPermissionsConfig, M6 bootstrap files, M7 helper files,
all `server/**`, migrations, seeds, `package.json`, `package-lock.json`, `.replit`, secrets,
Supabase/Firebase config.

## 3. Token bridge immediate-use callback contract

```ts
withSupabaseAccessToken<T>(
  use: (accessToken: string) => Promise<T> | T,
  options?: { signal?: AbortSignal },
): Promise<SupabaseTokenBridgeResult<T>>
```

The raw token is acquired (via the M5 foundation's browser client `getSession()`) and passed
**only** to `use(accessToken)` for the synchronous duration of that call. It is **never** returned
to a storable caller, stored in module scope / React state / a ref / context / provider value,
written to `localStorage`/`sessionStorage`/IndexedDB/`window`/`globalThis`, logged, rendered,
serialized, or placed in a URL/query/body. There is **no** `getAccessToken()`/`getToken()` that
returns the raw string — the callback shape makes accidental storage harder than a plain getter.
The non-secret `SupabaseTokenBridgeResult<T>` carries only the callback's own return value plus a
status (`disabled | foundation_unavailable | no_session | no_token | cancelled | callback_error |
success`) and a safe message — never a token/JWT/refresh/provider token or any authz payload.

## 4. Flag strategy & default-OFF posture

`VITE_ENABLE_SUPABASE_TOKEN_BRIDGE` — DEV-only, default OFF, separate from the foundation /
bootstrap / awareness / diagnostic-surface / session-resolve-shadow / server-authz-shadow flags.
Enablement = DEV build **and** the flag === `'true'` **and** the M5 foundation enabled
(`isSupabaseAuthFoundationEnabled()`). Absent/false flag (and any production build) ⇒ the bridge
returns `disabled` and acquires nothing.

## 5. Dormancy & production exclusion

The bridge is imported by **nothing active** (not AccessContext/Login/AccessGuard/App/main/pilot)
and by no other `src/**` file — so the bundler tree-shakes it (and, through it, the foundation)
out of production. Proven by the M11 dormancy diagnostic (checks 43–49b) and the bundle secret
scan (`supabaseTokenBridge` / `withSupabaseAccessToken` / the flag absent from `dist/**`).

## 6. No route call / no AccessContext / no exposure (M11 boundaries)

No `/auth/session/resolve` call, no `runSessionResolve`, no fetch/XHR/sendBeacon, no token-to-route
integration, no server-authz read; no AccessContext import or wiring; no public context API; no
UI; no `window` hook; no DOM event; no persistence; no logging; no network transmission; no
browser→database access; no service-role key / DB URL reference.

## 7. Cancellation & error handling

Cancellation-safe via an optional `AbortSignal`, honored **before** acquisition, **after**
acquisition and before the callback, and **after** the callback (result discarded on teardown).
No-throw: a getSession failure → `foundation_unavailable` (safe), a callback throw →
`callback_error` (safe; no token detail), and all messages/errors are token-free.

## 8. Controlled foundation-importer update

Two diagnostics enforce the foundation-importer allowlist (the M6 precedent updated both):
`diagnostics-supabase-auth-foundation-dormant-check.ts` (8b) and
`diagnostics-frontend-auth-provider-inventory-check.ts` (2g). M11 adds `supabaseTokenBridge.ts` as
the second permitted importer in **both** (owner-authorized), weakening no other check.

## 9. Production bundle exclusion proof (required)

Because M11 adds a frontend helper, an offline `npm run build` + bundle secret scan are required.
The scan asserts the token-bridge identifiers + flag are absent from `dist/**` (alongside the
foundation/bootstrap/awareness/observer identifiers and all privileged Supabase/DB patterns).

## 10. QA results (non-live, offline only)

- `tsc --noEmit`: **12 pre-existing errors, 0 new, 0 in any M11 file**.
- token-bridge dormancy (new): **75/75**.
- foundation dormancy (updated 8b): **37/37**; provider inventory (updated 2g): **21/21**.
- bootstrap dormancy **44/44**, awareness observational **55/55**, observer wiring **45/45**,
  private-surface **46/46**, firebase authority **36/36**, supabase-readiness **20/20**,
  adoption-readiness **22/22**.
- Full M1–M9 regression green; protected-action (DB-free) **8/8**.
- Offline `vite build` OK + bundle secret-scan **11/11** (token-bridge identifiers + flag absent).

## 11. Rollback plan

1. Delete `src/auth/supabaseTokenBridge.ts`, `src/auth/supabaseTokenBridgeTypes.ts`,
   `scripts/diagnostics-supabase-token-bridge-dormant-check.ts`, and this doc.
2. Revert the additive bundle-scan check `2e`.
3. Revert the controlled foundation-importer allowlist in `diagnostics-supabase-auth-foundation-dormant-check.ts` (8b) and `diagnostics-frontend-auth-provider-inventory-check.ts` (2g).
4. Revert the `replit.md` M11 pointer line.
5. No DB/audit rollback (no route call, migration, seed, SQL, schema/RLS/Auth change, or DB write
   occurred). Runtime is already neutralized by the flag being absent/false (the default).

`git revert` (or reset to `3ed357d`) fully restores M9 state.

## 12. M12 route-call shadow strategy (deferred)

A dormant route-call shadow helper that uses `withSupabaseAccessToken` to call the backend
session-resolve route (Bearer header + empty `{}` body, mirroring the proven pilot discipline),
reads only safe DTO status/shape fields, returns a non-secret status record, and never logs the
token/response bodies — behind `VITE_ENABLE_SESSION_RESOLVE_SHADOW` (requires the token-bridge
flag). **No live call** without explicit owner approval, because the enabled backend route upserts
identity and emits advisory audit (and durable `audit_event` under the live flag); live runs must
be owner-approved with identity/audit-delta guardrails.

## 13. M13 server-authz comparison strategy (deferred)

A private, non-authoritative shadow that reads the server `authorization` field when present,
normalizes it to the permission-catalog key space, and compares **structurally** (key-space
coverage) against the legacy client engine — behind `VITE_ENABLE_SERVER_AUTHZ_SHADOW`. Private
ref/status only; no enforcement; never affects session/permissions/routing/AccessGuard/loading.

## 14. Backend route side-effect facts (binding cautions for M12+)

- `/auth/session/resolve` **upserts a `platform_identity` row** on a verified token when backend
  config is complete (even with live-authz OFF).
- An **advisory audit envelope** (server log; no durable table) is emitted on every path when the
  route runs.
- A **durable `audit_event` row** is written only when `ENABLE_LIVE_SESSION_AUTHORIZATION=true`
  (then `authorization` is non-null only on an allow that was durably audited — fail-closed).
- Backend gates (`ENABLE_SUPABASE_PLATFORM_IDENTITY`, `ENABLE_SESSION_RESOLVE`,
  `ENABLE_LIVE_SESSION_AUTHORIZATION`) are **server-side env vars**, separate from frontend
  `VITE_*` flags; with the route disabled (default), a frontend call returns 404 with no side
  effects. **Any live route call requires explicit owner approval and guardrails.**

## 15. Explicitly deferred stages (post-M11)

Route-call shadow helper (M12); live `/auth/session/resolve`; audit/identity delta guardrails;
pilot `authorization: null` pin update; server-authz shadow comparison (M13);
`VITE_ENABLE_SESSION_RESOLVE_SHADOW` / `VITE_ENABLE_SERVER_AUTHZ_SHADOW` wiring; server-derived
authorization adapter; enforcement; Login migration; protected business APIs; Backend Control
Plane; Backend UI Control Panel; Database Operations Console / direct DB control; production
migration 003. Each requires its own explicit, separately-approved milestone.
