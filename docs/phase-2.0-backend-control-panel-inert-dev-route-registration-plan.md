# Phase 2.0 M7F — Inert DEV-only Route Registration Plan

**Status:** Documentation/planning-only · Route registration plan (registers, exposes, and implements no route)
**Accepted checkpoint at authoring:** `f4e4b656613d48e6aa0514729df7ce12be24f0bc` (Phase 2.0 M7E)
**Authoring milestone:** Phase 2.0 M7F

> Redaction-first document. Contains no real tenant/store/customer data, raw UIDs,
> raw emails, domains, tenant/store IDs, row dumps, DB URLs, tokens, secrets,
> provider credentials, permission/entitlement key lists, mismatch lists, raw auth
> claims, or raw `identity_link` rows. This milestone makes no runtime, route,
> auth, DB, Supabase, UI, or `server/bcp-pilot/**` change; registers and exposes no
> route. Nothing is staged, committed, pushed, or backed up.

---

## 1. Executive Summary

This is a **documentation/planning-only** milestone. It plans the safest possible future milestone for **registering the existing inert M7E route boundary handler** into the isolated DEV API. It **does not register, expose, or implement** any live route and changes no runtime, auth, DB, Supabase, UI, or `server/bcp-pilot/**` code.

Grounding (read-only) confirms a clean, isolated registration surface: `server/platform-identity/server.ts` builds a standalone `express()` app that listens on its **own port** (`PLATFORM_IDENTITY_API_PORT`, default `5002`) — entirely separate from the main SaaS/Vite application and its navigation — and registers flag-gated, default-off, DEV-intended handlers (with an established `404 FEATURE_DISABLED` shape). A future milestone can add a single `GET` handler there that is a **thin adapter** over the pure M7E `handleBcpReadinessSummaryRequest`, gated by the default-off `ENABLE_BCP_DEV_READONLY_PILOT` flag and non-production, returning only the handler's safe disabled/denied/blocked/synthetic responses with **no live data source**. Because that scope is narrow and isolated, the decision is **Decision A — ready to request the inert DEV-only route registration implementation**, bounded by the guardrails below.

## 2. Current State and Boundary

- **M1–M7E are complete and backed up.** M7E added the inert handler (`bcpReadOnlyRoute.ts`) + tests and hardened the M7C harness; 54/54 tests pass; 0 new type errors.
- **The M7E route handler exists but is registered with nothing** — no live route, no exposed endpoint.
- **No live C-01 data integration, no C-02, no Backend CP UI adapter, no SaaS navigation exposure, no DB/Supabase/provider access.**
- **Firebase / legacy AccessContext remains the current frontend/app authority**; future BCP live read APIs require the server-derived principal after parity/safety gates.
- **Supabase remains dormant / readiness-only and is not ready for a Firebase cutover.**
- **M7F plans a future route registration milestone only.** Controlled actions remain Phase 3; production readiness remains Phase 4.

## 3. Planning Decision

**Decision A — READY TO REQUEST INERT DEV-ONLY ROUTE REGISTRATION IMPLEMENTATION.**

**Why (and the binding condition):** route registration can be safely limited to the isolated DEV/default-off/synthetic-only surface because (a) a proven, isolated host exists — the platform-identity `express()` app on its own port, not reachable from SaaS navigation and not part of the client bundle; (b) the registration is a **thin adapter** over the already-tested pure M7E handler, adding no business/authorization/redaction/mapper logic; and (c) the handler already returns only safe disabled/denied/blocked/synthetic responses and touches no live source. Decision A is chosen over "more design" (B) because the exact file and runtime pattern are now clear, and over "repair" (C) because no exposure or auth ambiguity remains once the guardrails (§7–§12) and stop conditions (§18) are honored. The future milestone (M7G) must register **only** the inert handler — no live source, no UI link, no production path.

## 4. Proposed Registered Route Scope

Future registered route (not implemented; it does not exist today):

- **Proposed route path:** `GET /dev/bcp/readiness-summary` on the **isolated** platform API (own port; never the SaaS app; never linked from SaaS navigation). Exact path finalized at implementation.
- **HTTP method:** GET (success); HEAD/OPTIONS safe; other methods rejected.
- **Registration location candidate:** `server/platform-identity/server.ts`, inside `createPlatformIdentityApp()` (see §6).
- **DEV-only behavior:** available only in a non-production process.
- **Default-off behavior:** with the flag off, returns the handler's `feature_disabled` (uniform 404 unavailable).
- **Production-disabled behavior:** the flag helper returns false in production regardless of the env var → uniform unavailable.
- **feature_disabled response / not_authorized response / parity_blocked response / synthetic_success response / safe error behavior:** exactly as the M7E handler already produces them (no new logic).
- **No live data source behavior:** the adapter supplies only a synthetic source; no DB/Supabase/provider read.

## 5. Existing Handler Usage Plan

Future registration should call the M7E handler and its M7C dependencies **only through the handler path** — never re-implement them:

- **`handleBcpReadinessSummaryRequest`** (from `bcpReadOnlyRoute.ts`) is the single entry point the adapter calls.
- **`isBcpDevReadonlyPilotEnabled`** — the adapter resolves the flag and passes `featureEnabled` into the handler (the handler also encodes the gate order).
- **`authorizeBcpRead`** — reached only *inside* the handler; the adapter never calls it directly and never makes its own authorization decision.
- **`buildReadinessSummaryEnvelope`** — reached only *inside* the handler; the adapter never builds or redacts a payload itself.

**Binding:** route registration must remain a **thin adapter** and must **not** duplicate business, authorization, redaction, or mapper logic. All of that stays in the pure M7C/M7E modules.

## 6. Registration File Touch Plan

| Aspect | Detail |
|---|---|
| **Preferred file** | `server/platform-identity/server.ts`, inside `createPlatformIdentityApp()`. |
| **Why isolated** | This app listens on its own port (`PLATFORM_IDENTITY_API_PORT`, default 5002), separate from the main SaaS/Vite app; it is server-side only and never imported into the client bundle. |
| **Why it avoids SaaS navigation** | It is not part of the customer-facing app router; no navigation entry, link, or menu references it. |
| **Why it avoids production exposure** | The handler/flag are production-disabled; the route returns uniform unavailable in production even if mounted, and the isolated API is a DEV foundation surface. |
| **Why safer than broader app routes** | It avoids touching `src/**` app routing, `App.tsx`/`main.tsx`, or any customer-facing route table — the blast radius is one isolated, flag-gated GET handler. |
| **Allowed later** | A single `app.get('/dev/bcp/...')` thin adapter that resolves the flag + dev state, constructs a fixed synthetic principal/source, calls `handleBcpReadinessSummaryRequest`, and writes its safe response/status/headers. |
| **Not allowed later** | Mutation verbs, DB/Supabase/provider calls, live read model, business/redaction/mapper logic in the adapter, mounting on the SaaS app, or any production route registration. |

The file is **not edited now**; this only identifies it as the future candidate.

## 7. Request / Response Adapter Plan

Future adapter requirements:

- **Translate the HTTP request into the M7E transport-agnostic input** (`method`, `isDevEnvironment`, `featureEnabled`, synthetic `principal`/`source`).
- **Pass only controlled synthetic/server-side context** — a fixed synthetic principal and synthetic source; never live data.
- **Never use client UID/email/body/query as authority** — these are not read into the principal.
- **Derive `isDevEnvironment` server-side** from `NODE_ENV !== 'production'` — never from a request header, query, or body.
- **Server-construct the envelope-shaping inputs** (`syntheticSource`, `generatedAt`, `environment`) as fixed server-side values — **never map them from request input** (this honors the handler's FORWARD-GUARD: those fields shape the success envelope and must not become a client-controlled content/injection path).
- **Return the handler's safe response as-is** — status code, category, and body unchanged.
- **Preserve safe headers** (e.g. `Allow: GET` on OPTIONS/405).
- **Preserve safe status codes** (200/204/403/404/405/409/500 as the handler returns).
- **Avoid stack traces** and **avoid raw route internals** in any response.

## 8. Production Exposure Prevention Plan

Future checks:

- **No route registration outside DEV** (or, if always registered, the handler returns uniform unavailable in production).
- **Production-disabled even if the feature flag is true** (the flag helper short-circuits in production).
- **No production bundle exposure** (server-side isolated API only; never in the client/Vite bundle).
- **No normal SaaS navigation link.**
- **No frontend fetch addition.**
- **No route mounted under customer-facing app paths.**
- **No route included in public API docs.**

## 9. Method Handling Plan

Future behavior (already implemented in the M7E handler; the adapter must not alter it):

- **GET** is the only success method.
- **HEAD** safe (GET-status, no body).
- **OPTIONS** safe (`204`, `Allow: GET`, no body).
- **POST/PUT/PATCH/DELETE** rejected safely (`405`, no side effect).
- **No side effects for any method.**
- **Tests for every method category.**

## 10. Synthetic-only Plan

Future behavior:

- Route returns only the **synthetic C-01** response under allowed conditions.
- **No live C-01 read model.**
- **No C-02.**
- **No DB / Supabase / live provider source.**
- **No real tenant/store/billing/customer data.**
- **No raw identifiers.**

## 11. Authorization and Parity Plan

Future behavior (enforced by the M7E handler/guard; the adapter must not weaken it):

- **Missing principal denied** (uniform 403).
- **Unverified principal denied.**
- **Forbidden client authority ignored** (client UID/email/body/query never authority).
- **Parity unresolved blocked** (409).
- **No unreviewed auth claims.**
- **No live session resolver wiring** (a fixed synthetic principal only, or fail closed).
- **No Supabase auth wiring.**
- **No Firebase-to-Supabase cutover.**

## 12. Error and Leak Prevention Plan

Future behavior:

- **No stack traces.**
- **No file paths.**
- **No SQL/provider errors.**
- **No auth claim dumps.**
- **No tenant/store existence hints.**
- **No permission/entitlement key dumps.**
- **No raw IDs.**
- **No secrets/tokens/DB URLs.**
- **Safe generic error category only** (`safe_error`).

## 13. Test Plan for Future Route Registration

Tests required before registration is accepted:

- Route not registered or unavailable when the flag is off.
- Route unavailable outside DEV.
- Production disabled even if the flag is `true`.
- GET synthetic success only under allowed synthetic conditions.
- HEAD safe.
- OPTIONS safe.
- Mutation methods rejected.
- Missing/unverified principal denied.
- Client UID/email/body/query ignored.
- Parity unresolved blocked.
- Safe error path (no internals).
- Forbidden fields absent.
- No DB/Supabase/live-provider imports in the registration/adapter module.
- No UI navigation or frontend fetch added.
- No production exposure.
- **Adapter does not map `isDevEnvironment` / `syntheticSource` / `generatedAt` / `environment` from request input** — they are server-derived/constructed (pairs with §7).
- **Response sets only the safe `Allow` header (on OPTIONS/405) and no others** — no route internals, handler names, or framework headers echoed.
- Rollback/disable behavior.
- Existing M7C/M7E tests remain passing.

## 14. Manual QA Plan

Future manual QA:

- Flag-off behavior.
- Non-DEV behavior.
- Production-disabled behavior.
- Unauthorized behavior.
- Parity-blocked behavior.
- Synthetic-success behavior.
- Method rejection behavior.
- No raw data in response.
- No UI link.
- No frontend fetch.
- No production route.
- Disable/rollback confirmation.

## 15. Evidence Requirements

Future evidence:

- Scoped file list.
- Exact registration file touched.
- Route path.
- Feature flag proof (default-off).
- DEV-only proof.
- Production-disabled proof.
- Disabled response proof.
- Denied response proof.
- Parity-blocked response proof.
- Synthetic response proof.
- Method handling proof.
- Test results.
- Import scan for DB/Supabase/live providers (expect none).
- Raw-data/secret scan (expect none).
- `git status`.

All evidence redacted/aggregate; no raw identifiers.

## 16. Explicitly Excluded Scope

Excluded from the planned registration:

- Live C-01 data integration.
- C-02 integration.
- Backend CP UI adapter.
- Frontend fetch.
- Normal SaaS navigation exposure.
- Production route.
- Supabase auth.
- Live session auth enablement.
- Firebase-to-Supabase cutover.
- DB reads / DB writes / SQL / migrations.
- Backend actions / audit writes / `identity_link` writes.
- Live provider calls.
- Tenant/store/billing/customer live data.

## 17. Risk Register

| ID | Risk | Severity | Mitigation | Closure requirement |
|---|---|---|---|---|
| R-1 | Accidental production route | High | Production-disabled flag + isolated DEV API | Production-disabled test |
| R-2 | Route mounted under a customer-facing path | High | Register only on the isolated platform API; never `src/**` routing | No-SaaS-mount check + file-scope evidence |
| R-3 | Route enabled by feature flag in production | High | Flag helper returns false in production regardless of env var | Production-disabled test |
| R-4 | Route trusts client authority | High | Adapter passes no client field as authority; guard decides | Client-ignored tests |
| R-5 | Route bypasses the M7E handler | High | Adapter must call `handleBcpReadinessSummaryRequest` only | Code review + no-duplication check |
| R-6 | Adapter duplicates redaction logic incorrectly | Medium | No redaction in the adapter; mapper owns it | Forbidden-fields-absent test |
| R-7 | Route calls a live source | High | Synthetic source only; no DB/Supabase/provider import | No-live-import scan |
| R-8 | Route permits mutation | High | GET-only; handler rejects other methods | Mutation-rejected test |
| R-9 | Route becomes UI-discoverable | Medium | No SaaS nav link; isolated API; no frontend fetch | No-navigation/no-fetch check |
| R-10 | Cutover confusion | Medium | Explicit "no cutover / Supabase not authority" boundary | Documentation + parity guard |
| R-11 | Broad server wiring change | Medium | Single flag-gated GET handler; no startup restructure | Scoped-file-list evidence |

No HIGH risk is treated as closed; each maps to a closure requirement that must pass in the future implementation.

## 18. Stop Conditions

Halt and reassess if future route registration would require any of:

- Production exposure.
- Normal SaaS navigation exposure.
- Frontend fetch addition.
- Live DB reads.
- DB writes.
- SQL/DDL/migration.
- Supabase calls.
- Supabase MCP.
- Live provider calls.
- A live C-01 data source.
- A C-02 data source.
- A UI adapter.
- Backend actions.
- Mutation.
- Live session auth enablement.
- Supabase auth enablement.
- An auth cutover.
- Client UID/email authority.
- UI-side security filtering.
- Raw IDs, raw `identity_link` rows, raw audit logs, secrets, tokens, DB URLs, payment identifiers, permission keys, entitlement keys, mismatch lists, raw auth claims, or raw provider UIDs.

## 19. Acceptance Criteria

This milestone is acceptable when:

- The single documentation file exists under `docs/` and is redaction-safe.
- It records an honest planning decision (A/B/C) with rationale and a binding constraint (§3).
- It defines the proposed registered route scope (§4), the existing-handler usage plan (§5), the registration file touch plan (§6), and the request/response adapter plan (§7).
- It defines production-exposure prevention (§8), method handling (§9), synthetic-only (§10), authorization/parity (§11), error/leak prevention (§12), the future test plan (§13), manual QA (§14), evidence requirements (§15), excluded scope (§16), the risk register (§17), and stop conditions (§18).
- It preserves the M2.1–M7E assumptions (two authority planes, M20 posture, redaction/evidence, isolation/RBAC, parity, inert/default-off pilot, thin-adapter rule).
- It claims **no** route registration/exposure/implementation, **no** live API, **no** live session auth, **no** Supabase auth, **no** production readiness, and **no** Supabase cutover readiness.
- No runtime, route, auth, DB, Supabase, UI, or `server/bcp-pilot/**` change was made; nothing was staged, committed, pushed, or backed up.

## 20. Recommended Next Milestone

**Phase 2.0 M7G — Inert DEV-only Route Registration Implementation** — registering **only** the inert M7E handler as a DEV-only, default-off, GET-only, synthetic-only `GET` endpoint on the isolated platform API, with **no** live C-01 data source, **no** UI adapter, **no** frontend fetch, and **no** production path. Live C-01 data integration remains separately authorized by a later milestone.
