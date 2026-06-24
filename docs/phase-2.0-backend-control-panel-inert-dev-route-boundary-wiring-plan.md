# Phase 2.0 M7D — Inert DEV-only Route Boundary Wiring Plan

**Status:** Documentation/planning-only · Route boundary wiring plan (implements, registers, and exposes no route)
**Accepted checkpoint at authoring:** `adebc55e214d7c90e98e244e700a67bd7f670473` (Phase 2.0 M7C)
**Authoring milestone:** Phase 2.0 M7D

> Redaction-first document. Contains no real tenant/store/customer data, raw UIDs,
> raw emails, domains, tenant/store IDs, row dumps, DB URLs, tokens, secrets,
> provider credentials, permission/entitlement key lists, mismatch lists, raw auth
> claims, or raw `identity_link` rows. This milestone makes no runtime, route,
> auth, DB, Supabase, DTO, type, read-model, mapper, test, fixture, UI, or
> `server/bcp-pilot/**` change; enables no live session authorization or Supabase
> auth; registers and exposes no route. Nothing is staged, committed, pushed, or
> backed up.

---

## 1. Executive Summary

This is a **documentation/planning-only** milestone. It plans the safest possible future milestone for wiring an **inert, DEV-only, default-off, GET-only route boundary** over the accepted M7C guard and synthetic C-01 harness. It **does not implement, register, or expose** any route, and changes no runtime, auth, DB, Supabase, UI, or `server/bcp-pilot/**` code.

Grounding (read-only) confirms a clean precedent: the platform-identity backend already runs as an **isolated `express()` API** (`server/platform-identity/server.ts`) — separate from the main SaaS/Vite application and its navigation — with flag-gated, default-off, DEV-only GET handlers. A future inert BCP route can follow that exact pattern: gated by the M7C default-off `ENABLE_BCP_DEV_READONLY_PILOT` flag (and non-production), calling only the M7C **pure** guard + synthetic mapper, and returning only disabled/denied/blocked/synthetic responses with **no live data source**. Because that scope can be safely and narrowly constrained, the decision is **Decision A — ready to request the inert DEV-only route boundary implementation**, bounded by the guardrails below.

## 2. Current State and Boundary

- **M1–M7C are complete and backed up.** M7C added only `server/bcp-pilot/**` pure modules (config flag, fail-closed guard, synthetic C-01 mapper, 24-case test harness); 24/24 tests pass; 0 new type errors.
- **No route exists** for the BCP pilot; **no live API exists**; **no live data integration exists**; **no Backend CP UI adapter exists**.
- The BCP UI remains mock-only and DEV-gated at `/dev/backend-control-plane`.
- **Firebase / legacy AccessContext remains the current frontend/app authority.** Future BCP live read APIs require the server-derived principal after parity/safety gates.
- **Supabase remains dormant / readiness-only and is not ready for a Firebase cutover.**
- **M7D plans a future route wiring milestone only.** Controlled actions remain Phase 3; production readiness remains Phase 4.

## 3. Planning Decision

**Decision A — READY TO REQUEST INERT DEV-ONLY ROUTE BOUNDARY IMPLEMENTATION.**

**Why (and the binding condition):** the route implementation can be safely limited to inert, default-off, DEV-only, synthetic-only behavior because (a) a proven precedent exists — the isolated `express()` platform-identity API already gates GET handlers behind a default-off flag and is not reachable from normal SaaS navigation; (b) the M7C guard and mapper are **pure functions** ready to call, so the route is a thin boundary with no new business logic; and (c) the route returns only safe disabled/denied/blocked/synthetic responses and connects to **no** live data source. Decision A is chosen over "more design" (B) because the architecture and scope are already clear, and over "repair" (C) because no exposure risk or auth ambiguity remains once the guardrails (§6–§11) and stop conditions (§18) are honored. The future implementation (M7E) must wire **only** the inert handler — no live source, no UI link, no production path.

## 4. Proposed Route Boundary Scope

Future route scope (not implemented; the route does not exist today):

- **Proposed internal route namespace:** a DEV-only path on the **isolated** platform API (e.g. `/dev/bcp/readiness-summary`), never on the main SaaS app and never linked from SaaS navigation. (Exact path finalized at implementation.)
- **HTTP method allowed:** GET only.
- **Default-off behavior:** with the flag off, the route returns a safe `feature_disabled` response (or is not registered at all).
- **DEV-only behavior:** outside DEV / in production, the route is unavailable and returns `dev_only` (or is not registered).
- **Disabled response:** `feature_disabled` — safe status, no data.
- **Denied response:** `not_authorized` — safe status, no data.
- **Parity-blocked response:** `parity_blocked` — safe status, no data.
- **Synthetic allowed response:** only under explicit DEV synthetic conditions, the redacted synthetic C-01 envelope (no live source).
- **Safe error shape:** generic status labels only (§8).
- **No live source behavior:** the route never reads DB/Supabase/live providers; the synthetic mapper is the only data path.

## 5. M7C Module Usage Plan

A future route may use the M7C modules as follows (the modules themselves stay **pure and unchanged**):

- **`bcpPilotConfig.ts`** → call `isBcpDevReadonlyPilotEnabled()` at the boundary to gate the handler (default-off, non-production).
- **`bcpAuthorizationGuard.ts`** → call `authorizeBcpRead()` with a server-derived principal (synthetic until separately authorized); the guard remains the only authority decision point and stays pure.
- **`bcpReadinessSummaryHarness.ts`** → call `buildReadinessSummaryEnvelope()` with the guard result + a synthetic source to produce the already-redacted envelope; the mapper stays pure.

**Layering:** the M7C functions remain **pure** (no request/response objects). A thin **route boundary layer** performs HTTP request handling — reading the flag, constructing the (synthetic) principal, calling the pure guard/mapper, and serializing a safe response. No business or redaction logic moves into the route.

## 6. Request Authority Boundary Plan

A future route must **not** trust any of the following as authority:

- Request body UID.
- Request body email.
- Querystring tenant/store.
- Frontend role label.
- Frontend tenant/store selection.
- Local/session storage values.
- Mock fixture values.
- Unverified auth claims.

Safe approach:

- **Server-side principal only** — the route constructs/obtains a server-derived principal and passes it to the guard; nothing from the request is promoted to authority.
- **For M7E specifically:** the principal must be a **fixed synthetic principal or fail closed** — **no live session/user resolver is wired** in the inert route. A real principal resolver is a later, separately authorized step, not part of the inert boundary.
- **Fail closed if the principal is unavailable.**
- **Fail closed if parity is unresolved.**
- **No authority from display labels.**

## 7. Response Shape Plan

| Category | Allowed fields | Blocked fields |
|---|---|---|
| `feature_disabled` | safe status label, environment label | data, identifiers, any payload |
| `dev_only` | safe status label | data, identifiers, internals |
| `not_authorized` | safe status label, safe reason code | data, principal details, existence hints |
| `parity_blocked` | safe status label, safe reason code | data, parity internals, identifiers |
| `safe_empty` | redacted envelope with `data: null`, `emptyState` | raw counts, identifiers, existence of hidden records |
| `synthetic_success` | redacted C-01 envelope (posture labels, redaction/freshness/authorizationContext/emptyState/warnings) | raw IDs, secrets, tokens, DB URLs, emails, `identity_link` rows, permission/entitlement keys, mismatch lists |

All categories carry only the M3 already-redacted envelope shape or a safe status; never a raw payload.

## 8. Error Handling Plan

- No stack traces.
- No SQL errors.
- No raw route internals (handler names, file paths).
- No auth claim dumps.
- No tenant/store existence leakage (uniform denied/not-found shape).
- No raw permission/entitlement keys.
- Safe generic status labels only.

## 9. Production Exposure Prevention Plan

Future checks:

- Route **unavailable in production** (the flag helper returns false in production regardless of the env var).
- Feature flag **ignored in production** (production short-circuits before the flag is read).
- **No production bundle exposure** (server-side isolated API only; never imported into the client/Vite bundle).
- **No normal SaaS navigation link** to the route.
- **No route registration outside DEV.**
- **No server startup side effect outside DEV** (registration guarded so production startup is unchanged).

## 10. No-Mutation Plan

Future checks:

- GET-only.
- No write methods (no POST/PUT/PATCH/DELETE).
- No DB writes.
- No audit writes.
- No `identity_link` writes.
- No backend actions.
- No job dispatch.
- No external provider calls.
- No mutation helpers imported.

## 11. Synthetic-Only Plan

Future route behavior:

- Only the **synthetic** C-01 response may be returned.
- No DB source.
- No Supabase source.
- No live provider source.
- No real tenant/store/billing/customer data.
- No C-02 unless separately authorized.
- No live C-01 read model.

## 12. Test Plan for Future Route Wiring

Tests required before route wiring is accepted:

- Route absent/disabled when the flag is off.
- Route unavailable outside DEV.
- Production disabled even if the flag is `true`.
- GET-only behavior.
- Mutation methods rejected (POST/PUT/PATCH/DELETE).
- **`HEAD`/`OPTIONS` behavior** asserted explicitly (so "GET-only" is not interpreted narrowly when the Express stack auto-handles them) — they must not return data or side-effect.
- Missing principal denied.
- Unverified principal denied.
- Client UID/email ignored.
- Parity unresolved blocked.
- Safe synthetic success only under allowed synthetic conditions.
- Forbidden fields absent from responses.
- **Forced error-path tests** proving no stack traces, SQL/provider errors, file paths, auth-claim dumps, or tenant/store existence hints leak under any failure (errors return only safe generic status labels).
- No DB/Supabase/live-provider imports in the route module.
- No normal SaaS navigation exposure.
- Rollback/disable behavior.

## 13. Manual QA Plan

Future manual QA:

- Flag-off route behavior (`feature_disabled` / not registered).
- Non-DEV route behavior (`dev_only` / unavailable).
- Unauthorized route behavior (`not_authorized`).
- Parity-blocked route behavior (`parity_blocked`).
- Synthetic success behavior (redacted envelope only).
- No raw data in any response.
- No UI navigation link present.
- No production exposure.
- Disable/rollback confirmation (flip flag off → instant revert).

## 14. Evidence Requirements

Future evidence:

- Scoped file list.
- Exact route registration file if touched.
- Feature flag proof (default-off).
- DEV-only proof.
- Disabled response proof.
- Denied response proof.
- Parity-blocked response proof.
- Synthetic response proof.
- Test results.
- Scan for DB/Supabase/live-provider imports (expect none).
- Scan for raw data/secrets (expect none).
- `git status`.

All evidence redacted/aggregate; no raw identifiers.

## 15. Allowed Future File Touch Plan

| Group | Files (future, only if necessary) |
|---|---|
| **Preferred** | A new inert route-boundary module under `server/bcp-pilot/` (e.g. a thin handler factory that calls the pure M7C functions) — keeps the boundary isolated and testable. |
| **Possible route registration** | `server/platform-identity/server.ts` (the **isolated** DEV API) — add a single flag-gated, default-off GET handler; no main-app/SaaS routing touched. |
| **Test files** | New `server/bcp-pilot/*.test.ts` for the route boundary. |
| **Docs** | This plan and a future implementation-evidence doc. |

**Must remain untouched:** `src/**` (main SaaS app + routing), `App.tsx`/`main.tsx`, production config, package files (unless strictly required for tests), migrations, seeds, `.replit`, `.gitattributes`, `dist/**`, auth files, M20 identity-link files, audit writer, identity repository, `sessionResolve`, and — in M7D — `server/bcp-pilot/**` and everything else.

## 16. Explicitly Excluded Scope

Excluded from the planned route wiring:

- Live C-01 data integration.
- C-02 integration.
- Backend CP UI adapter.
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
| R-1 | Accidental route exposure | High | Default-off flag + DEV-only gate + isolated API | Flag-off + DEV-gate tests pass |
| R-2 | Route enabled outside DEV | High | Non-production short-circuit in flag helper | Non-DEV unavailability test |
| R-3 | Route enabled in production | High | Production returns false regardless of env var | Production-disabled test |
| R-4 | Route trusts client authority | High | Authority only from server principal (M7C guard) | Client-UID/email-ignored tests |
| R-5 | Route calls a live source | High | Synthetic mapper only; no DB/Supabase/provider import | No-live-import scan |
| R-6 | Route permits mutation | High | GET-only; no write methods/helpers | Mutation-rejected test |
| R-7 | Route leaks raw response data | High | Already-redacted envelope; forbidden-field blocking (M7C) | Forbidden-fields-absent test |
| R-8 | Route becomes UI-discoverable | Medium | No SaaS navigation link; isolated API | No-navigation-exposure check |
| R-9 | Cutover confusion | Medium | Explicit "no cutover / Supabase not authority" boundary | Documentation + parity guard |
| R-10 | Runtime surface broadened too much | Medium | Single flag-gated GET handler; thin boundary | Scoped-file-list evidence |

No HIGH risk is treated as closed; each maps to a closure requirement that must pass in the future implementation.

## 18. Stop Conditions

Halt and reassess if future route wiring would require any of:

- Production exposure.
- Normal SaaS navigation exposure.
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
- It defines the proposed route boundary scope (§4), the M7C module usage plan (§5), the request authority boundary plan (§6), the response shape plan (§7), and the error handling plan (§8).
- It defines production-exposure-prevention (§9), no-mutation (§10), synthetic-only (§11), the future test plan (§12), manual QA (§13), evidence requirements (§14), the allowed/forbidden file-touch plan (§15), excluded scope (§16), the risk register (§17), and stop conditions (§18).
- It preserves the M2.1–M7C assumptions (two authority planes, M20 posture, redaction/evidence, isolation/RBAC, parity, C-01-first, inert/default-off pilot).
- It claims **no** route implementation/registration/exposure, **no** live API, **no** live session auth, **no** Supabase auth, **no** production readiness, and **no** Supabase cutover readiness.
- No runtime, route, auth, DB, Supabase, DTO, type, read-model, mapper, test, fixture, UI, or `server/bcp-pilot/**` change was made; nothing was staged, committed, pushed, or backed up.

## 20. Recommended Next Milestone

**Phase 2.0 M7E — Inert DEV-only Route Boundary Implementation** — wiring **only** an inert, default-off, DEV-only, GET-only route over the pure M7C guard + synthetic mapper, returning safe disabled/denied/blocked/synthetic responses with **no** live data source, **no** UI navigation, and **no** production path. Live C-01 data integration remains separately authorized by a later milestone.
