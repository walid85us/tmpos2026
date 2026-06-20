# Phase 1.6 — Milestone 16.2: Safe Server Error Classification / Corrective Instrumentation

**Status:** Implemented (observability-only). Awaiting owner review. **No live re-attempt performed.**
**Accepted checkpoint at start:** `6d45502e13658d8ded6b19ae6387c233674c20b3` (M15 guarded live shadow feed harness).
**Type:** Observability instrumentation only — **no behavior change**, no commit/push performed.

---

## 1. M16 result (recap)

The owner-approved M16 null-authz one-shot was executed **exactly once** from the DEV browser harness:

| Field | Value |
|---|---|
| harness phase | `completed` |
| harness ok | `false` |
| feed status | `500` |
| feed phase | `server_error` |
| serverAuthzPresent | `false` |
| comparisonPhase | `null` |
| `audit_event` delta | `0` (`5 → 5`) |
| `platform_identity` presence delta | `0` (`1 → 1`) |

Expected was `200 / server_authz_unavailable / authorization: null`. Instead a `500 / server_error` was returned. **M16 did not pass. M17 is blocked.**

## 2. M16.1 findings (recap)

- The frontend feed (`src/auth/serverAuthzShadowFeed.ts`) **correctly** maps any `status >= 500` to `server_error` and **deliberately hides the response body**, so the feed alone cannot say *where* the 500 came from.
- The backend route (`server/platform-identity/sessionResolve.ts`) **catches every internal failure** and maps it to a **non-500** status with a **visible** `safeLog` line: DB/upsert/identity errors → **503**; all token-verification errors → **401/503**. The only 500 the handler can emit is its outer catch-all (`session_resolve_error`), which **also logs**.
- `server/safe-log.ts` forwards `safeLog.info/warn/error` to `console.*` **unconditionally**. Every handler path past the two feature gates emits an advisory-audit `console.log`.
- The owner observed **no error log and no advisory-audit log** on the identity API console (`:5002`) — only the startup banner. The absence of *any* identity-API output most likely indicates the request **never executed the handler body**, pointing at the **Vite proxy / transport boundary** (whose errors log on `:5000`, not `:5002`). A handler-side 500 with a *missed* log could not be fully excluded from static inspection.
- `{}` is the correct request body. Live authorization was OFF. The GoTrue "multiple GoTrueClient instances" warning is a benign frontend warning, not the 500 cause.

**Root-cause area, ranked:** (1) Vite proxy/transport-layer 500; (2) feed correct but backend lacked a safe, attributable error reason; (3) handler catch-all from an uncaught verify error (e.g., a malformed `SUPABASE_URL` → `new URL` throw) with a missed log.

## 3. Why M16 did not pass

The route returned a `500` instead of the expected `200 / server_authz_unavailable`. The system could not, from the available evidence, attribute the 500 to a specific boundary because there was **no safe, non-secret breadcrumb** proving whether the request reached the identity API handler, and **no proxy-error log** attributing a transport failure.

## 4. Why M17 is blocked

M17 (frontend adoption of a non-null server-derived authorization) cannot proceed until M16 yields a clean `200 / server_authz_unavailable` on a future, separately-approved instrumented re-attempt. A route that returns an unattributable 500 is not a safe foundation for adoption.

## 5. Why M16.2 adds observability (not a behavior fix)

The two leading hypotheses (proxy-layer 500 vs handler catch-all 500 with a missed log) differ **only** in runtime evidence the system does not currently capture safely. M16.2 therefore adds **non-secret, attributable instrumentation on both sides of the proxy boundary** so the next attempt is unambiguous. It does **not** change route semantics, does **not** enable live authorization, and does **not** "fix" a route bug (none is yet confirmed). Observability is preferred over behavior change.

## 6. Boundaries honored in M16.2

- **No re-run boundary** — the M16 one-shot was **not** re-run; `/auth/session/resolve` was **not** called; the M14 feed / M15 harness / M11 token bridge were **not** invoked; no Supabase token was acquired; no DB connection; no SQL; no Supabase MCP; live authorization **not** enabled; M17 **not** started.
- **No token logging** — no token, Authorization header, or Bearer value is ever logged (server or proxy).
- **No raw response logging** — neither the route nor the proxy logs any request/response body.
- **No identity logging** — no `internalUserId` / `authProviderUid` / `email` / `displayName` / tenant id / store id / permission key or level is ever logged. Success logs only an authorization **presence boolean**.

## 7. Safe server breadcrumb strategy

In `server/platform-identity/sessionResolve.ts`, a single local helper `sessionResolveBreadcrumb(requestId, phase, fields)` emits a stable, greppable marker (`[platform-identity] session-resolve …`). It is **leak-proof by construction**: it accepts only a `requestId` string, a phase from a fixed union, and a small fixed-key `fields` object of primitives (`status`, `reasonCode`, `authorizationPresent`, `errorClass`, `errorCode`). It accepts **no** `Request`, assertion, or identity object, and forwards through the redaction-applying `safeLog`.

Phases instrumented:

| Phase | When | Safe fields |
|---|---|---|
| `received` | handler entry (before gates) | route, requestId |
| `feature_disabled` | gate 1 / gate 2 → 404 | status 404, reasonCode |
| `denied_unauthenticated` | no bearer → 401 | status, reasonCode |
| `token_rejected` | `SupabaseTokenError` → 401/503 | status (from DTO), reasonCode |
| `identity_resolution_threw` | upsert/resolve threw (swallowed → 503) | errorClass, errorCode (sanitized) |
| `identity_unresolved` | no internal id → 503 | status 503, reasonCode |
| `authenticated` | success → 200 | status 200, reasonCode, **authorizationPresent boolean** |
| `unexpected_error` | outer catch-all → 500 | status (from contract matrix), reasonCode, errorClass, errorCode (sanitized) |

`requestId` is now generated at handler entry (behavior-neutral; the gate 404 bodies are unchanged). Feature-disabled stays 404; identity failure stays 503; success stays 200; the catch-all 500 status is bound to `SESSION_RESOLVE_MATRIX[session_resolve_error].status`.

## 8. Safe Vite proxy instrumentation strategy

In `vite.config.ts`, the `/__identity` proxy gains a `configure(proxy)` hook that registers:

- `proxy.on('error', …)` → logs `[vite-proxy:identity-api] upstream_error route=/__identity/* target=identity-api method=<M> code=<ECONNREFUSED|ECONNRESET|ETIMEDOUT|…>`
- `proxy.on('proxyRes', …)` → logs `[vite-proxy:identity-api] upstream_response route=/__identity/* target=identity-api method=<M> status=<code>`

These print on the **Vite dev-server console (`:5000`)**, making a transport-boundary 500 attributable. They log **only** a stable marker, the route **family** (`/__identity/*`, never the raw URL or query), the upstream label, the method, an upstream status code, and a transport error code — **never** headers, the Authorization header, cookies, body, token, query values, or identity fields.

## 9. Static diagnostic strategy

`scripts/diagnostics-session-resolve-error-classification-static-check.ts` is **offline/static** (fs/path only, read-only, no env/network/DB/child-process/Supabase MCP). It reads the source as text and asserts (61 checks):

- the breadcrumb helper exists, takes only `requestId`/phase/fields, and allow-lists only safe primitive keys;
- entry + every exit breadcrumb is present; the catch-all 500 is attributable (status from contract matrix, class+code only, no stack);
- **every** route log-call argument is scanned and carries no bearer/token/jwt/headers/body/query/identity/tenant/store/raw-authorization/cookie/secret;
- the proxy has `error` + `proxyRes` handlers and its log calls carry no headers/authorization/cookie/body/token/raw-url/query;
- the M14 feed + M15 harness remain un-instrumented (no breadcrumb, no console) and the feed still maps 5xx → `server_error`;
- the instrumentation calls no live shadow/harness/feed/bridge function, makes no fetch, enables no live authorization, and adds no DOM/window/global;
- the diagnostic is itself self-inert.

## 10. QA plan (all offline; no live route/DB)

1. `npx tsc --noEmit` — confirm **0 new** TypeScript errors and no M16.2 file in the error list (baseline 12 = post-edit 12, verified by stash comparison).
2. `npx tsx scripts/diagnostics-session-resolve-error-classification-static-check.ts` — 61/61.
3. Existing session-resolve + service + live-authz static diagnostics — pass.
4. Existing M11–M15 dormancy diagnostics — pass.
5. `npm run build` + `npx tsx scripts/diagnostics-frontend-bundle-secret-scan-check.ts` — build green; bundle scan 15/15 (M14/M15 still tree-shaken).

**Not run:** live route diagnostics, DB-backed diagnostics, audit-writer live diagnostics, browser harness, M16 re-attempt, SQL, migrations, seeds, Supabase MCP, production.

## 11. Rollback plan

1. Revert the safe breadcrumbs from `server/platform-identity/sessionResolve.ts` (`git checkout -- server/platform-identity/sessionResolve.ts`).
2. Revert the proxy instrumentation from `vite.config.ts` (`git checkout -- vite.config.ts`).
3. Delete `scripts/diagnostics-session-resolve-error-classification-static-check.ts`.
4. Delete this doc (`docs/phase-1.6-milestone-16.2-safe-error-classification-plan.md`).
5. Revert the optional `replit.md` pointer line if it was added.
6. **No DB rollback** — no DB connection or write occurred.
7. **No audit rollback** — no route call occurred; `audit_event` unchanged.
8. The pre-existing `.replit` modification and the untracked goose tarball remain out-of-scope and untouched.

## 12. M16.3 re-attempt criteria (deferred, separate owner approval)

A future **M16.3** would re-run the owner-approved single one-shot **with the M16.2 instrumentation live**, then read the consoles:

- **Identity API `:5002`** shows `session-resolve received` → a single exit breadcrumb. If the exit is `authenticated status=200 authorizationPresent=false` → the route is healthy (expected `server_authz_unavailable`); a prior 500 was transport. If the exit is `unexpected_error status=500 errorClass/errorCode` → a genuine handler 500; the class+code names the cause (e.g., `TypeError`/`ERR_INVALID_URL` ⇒ malformed `SUPABASE_URL`).
- **Vite `:5000`** shows `[vite-proxy:identity-api] upstream_error … code=ECONNREFUSED|ECONNRESET|ETIMEDOUT` with **no** matching identity-API `received` breadcrumb ⇒ a proxy/transport 500 (the request never reached the handler).

M16.3 preserves every M16 boundary (single one-shot, no token/raw-body/identity logging, DB-delta verification, no live authorization). If M16.3 confirms a handler-side bug (e.g., the `new URL` path), a small defensive route fix (mapping malformed config to 503 `jwks_unavailable`) would be a further, separately-approved step.

## 13. Deferred items

- **M17 non-null server-derived authorization** (frontend adoption of a live `authorization` object) remains **deferred and blocked** until M16 passes.
- **Backend Control Plane / Backend UI** remain **deferred** — out of scope for M16.x.
