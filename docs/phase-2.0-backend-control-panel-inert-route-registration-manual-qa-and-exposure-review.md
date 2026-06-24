# Phase 2.0 M7H — Inert Route Registration Manual QA and Exposure Review

**Status:** Review/documentation-only · QA + exposure review of the M7G inert route registration (no code change)
**Accepted checkpoint at authoring:** `68c41f76a0abdbb17ee21498fd9fe101c30e0242` (Phase 2.0 M7G)
**Authoring milestone:** Phase 2.0 M7H

> Redaction-first. No real tenant/store/customer data, raw IDs, emails, domains,
> DB URLs, tokens, secrets, payment identifiers, permission/entitlement key lists,
> mismatch lists, raw auth claims, raw provider UIDs, or raw `identity_link` rows.
> This milestone makes no code/runtime/route/auth/DB/Supabase/UI change; nothing is
> staged, committed, pushed, or backed up.

---

## 1. Executive Summary

QA result: **the M7G inert DEV-only route registration is accepted-safe.** Static review, exposure scans, the full unit-test suite, and a typecheck all confirm the route is registered **only** on the isolated platform-identity API, is **not** reachable from the SaaS/Vite app or Backend CP UI, is **default-off and production-disabled**, is **GET-only / synthetic-only / fail-closed**, and adds **no** live data, DB, Supabase, mutation, or production exposure. **61/61 tests pass; 0 new type errors.** No blocker found. **Decision A — PASS.**

## 2. Current State and Boundary

- Route path: `GET /dev/bcp/readiness-summary`, registered via `app.all(BCP_READINESS_ROUTE_PATH, …)` in `server/platform-identity/server.ts`.
- Registered **only** on the isolated `createPlatformIdentityApp()` express app (own port `5002`, started only via `npm run identity:api`).
- The pure M7E handler decides all behavior; the M7G adapter is a thin boundary that injects a fixed synthetic principal + synthetic source and serializes the safe result.
- Firebase / legacy AccessContext remains current frontend/app authority; Supabase dormant/readiness-only; no cutover; no live pilot/C-01 authorized; Phase 3/4 boundaries intact.

## 3. QA Decision

**Decision A — PASS: INERT ROUTE REGISTRATION IS ACCEPTED-SAFE.** All QA checks pass and no exposure/auth/data/mutation/UI/production risk was found. The only residual items are forward-looking (future live-C-01 / real-principal work), which are out of M7G scope and tracked in the risk register (§16) as non-blocking.

## 4. Route Registration Review

| Check | Result |
|---|---|
| Route path | `GET /dev/bcp/readiness-summary` ✓ |
| Registration file | `server/platform-identity/server.ts` (import line 32 + `app.all` line 177) ✓ |
| Isolated platform API only | ✓ (route refs only in adapter, server.ts, adapter test) |
| No SaaS/Vite app mount | ✓ (`npm run dev` runs `server/index.ts` + Vite, **not** platform-identity) |
| No frontend route | ✓ (0 `src/**` references) |
| No Backend CP UI adapter | ✓ |
| No frontend fetch | ✓ (0 fetch refs to the route) |
| No normal SaaS navigation exposure | ✓ |

## 5. Feature Flag and Environment Review

- **Flag:** `ENABLE_BCP_DEV_READONLY_PILOT`.
- **Default-off:** unset → `feature_disabled` (404). ✓
- **Non-`true` values disabled:** `''`/`false`/`1`/`yes`/`TRUE` → off. ✓
- **Production-disabled:** `isBcpDevReadonlyPilotEnabled()` returns false when `NODE_ENV==='production'`; adapter also derives `isDevEnvironment` from `NODE_ENV` (defense-in-depth). ✓
- **DEV-only:** non-production only. ✓
- **Rollback:** flip flag off → instant `feature_disabled`, no data dependency. ✓

## 6. Method Handling Review

- GET success only under enabled+DEV synthetic conditions. ✓
- HEAD → 200, no body. ✓
- OPTIONS → 204, `Allow: GET`, no body. ✓
- POST/PUT/PATCH/DELETE → 405 `Allow: GET`, `{status:'method_not_allowed'}`, **no side effect** (method gate returns before guard/envelope). ✓
- `app.all` delegates all method semantics to the pure handler. ✓

## 7. Authority Boundary Review

- No client UID authority. ✓
- No email authority. ✓
- No body/query authority (adapter reads only `req.method`). ✓
- No frontend role authority. ✓
- Fixed server-constructed synthetic principal only. ✓
- No live session resolver wired. ✓
- No Supabase auth. ✓
- No cutover. ✓

## 8. Synthetic-only Data Review

- C-01 only; no C-02. ✓
- No live C-01 read model. ✓
- No DB/Supabase/provider source. ✓
- No real tenant/store/billing/customer data. ✓
- No raw identifiers (synthetic placeholder only). ✓

## 9. Error and Leak Review

- No stack traces / file paths / SQL or provider errors / auth-claim dumps / existence hints / permission-entitlement key dumps / raw IDs / secrets / tokens / DB URLs. ✓
- Handler `catch` → generic `{status:'error'}`; adapter adds no logging and echoes no request value. ✓
- GET-success body asserted free of `postgres://`/`Bearer`/`eyJ`/`service_role`/`@`. ✓

## 10. Production and UI Exposure Review

- No production exposure (production-disabled flag + isolated API). ✓
- No customer-facing route mount (0 `src/**` refs). ✓
- No public API-doc exposure (route lives only in server-side isolated code). ✓
- No frontend fetch / Backend CP UI link / SaaS navigation link. ✓

## 11. No-Mutation Review

- No write methods (GET-only). ✓
- No DB writes / audit writes / `identity_link` writes. ✓
- No backend actions / job dispatch / external provider calls. ✓
- The only `identity_link` token in `server/bcp-pilot/**` is a **comment** in the harness header listing it as a *forbidden* field — not access. ✓

## 12. Test Review

- `npx tsx server/bcp-pilot/bcpPilot.test.ts` → **28/28** (`ALL_TESTS_PASSED`).
- `npx tsx server/bcp-pilot/bcpReadOnlyRoute.test.ts` → **26/26** (`ALL_TESTS_PASSED`).
- `npx tsx server/bcp-pilot/bcpReadOnlyExpressAdapter.test.ts` → **7/7** (`ALL_TESTS_PASSED`).
- **Total: 61/61 passing.** ✓

## 13. Typecheck Review

- `npx tsc --noEmit` → **12 total errors = pre-existing baseline** (unrelated files: `TemplateEditor.tsx`, `OwnerLayout.tsx`, `TenantLayout.tsx`, `BillingPage.tsx`, etc.).
- **0 errors in `server/bcp-pilot/**`.** ✓
- **0 errors in `server/platform-identity/server.ts`.** ✓

## 14. Static Scan Review

| Scan | Result |
|---|---|
| Route path references | Only adapter (definition), `server.ts` (import + registration), adapter test |
| `src/**` references to route/adapter | **0** |
| Frontend fetch references to route | **0** |
| DB/Supabase/live-provider imports in `server/bcp-pilot/**` (non-test) | **0** |
| Adapter express import | type-only (`import type { Request, Response }`) |
| `identity_link` / audit-write / mutation in `server/bcp-pilot/**` | **0 code** (1 comment reference to the forbidden field) |
| Raw secrets / URLs / tokens / sensitive values | **0** |
| `npm run dev` includes platform-identity API | **No** (`dev` = `server/index.ts` + Vite; `identity:api` is separate) |

## 15. Manual QA Checklist

| Behavior | Result |
|---|---|
| Flag off | `feature_disabled` (404), no data ✓ |
| Production-disabled | `dev_only`/unavailable even if flag `true` ✓ |
| DEV-only | available only non-production ✓ |
| Unauthorized | uniform `not_authorized` (403) (handler-enforced) ✓ |
| Parity-blocked | `parity_blocked` (409) (handler-enforced) ✓ |
| Synthetic-success | redacted synthetic C-01 envelope, no forbidden values ✓ |
| Method rejection | mutations → 405, no side effect ✓ |
| No UI link | ✓ |
| No frontend fetch | ✓ |
| Rollback/disable | flag-off → instant disable ✓ |

## 16. Risk Register

| ID | Risk | Severity | Status | Mitigation | Blocks next milestone? |
|---|---|---|---|---|---|
| R-1 | Route exists on the isolated API (registered, though inert) | Low | Accepted | Self-gating handler; isolated own-port app; default-off | No |
| R-2 | Synthetic-only but registered (could be mistaken for live) | Low | Accepted | Fixed synthetic principal/source; no live source imports | No |
| R-3 | No full HTTP server-startup test (adapter tested directly) | Low | Accepted | `server.ts` calls `app.listen` at import (port-bind side effect); direct fake-req/res tests instead | No |
| R-4 | Future live C-01 integration risk | Medium | Future | Remains separately authorized; not part of M7G | No |
| R-5 | Future real-principal wiring risk | Medium | Future | No live resolver wired; later gated milestone | No |
| R-6 | Future observability/audit decision risk | Low | Future | No audit writes now; plan later | No |
| R-7 | Production exposure drift | Medium | Mitigated | Production-disabled flag + DEV gate; covered by tests | No |
| R-8 | UI fetch exposure drift | Medium | Mitigated | 0 `src/**` refs; covered by static scan | No |

No risk blocks the next milestone.

## 17. Stop Conditions

This QA would flag a blocker (Decision C) if any were found: route mounted in the SaaS app; `src/**` fetch/navigation added; production route exposure; flag enabled in production; live DB/Supabase/provider access; real tenant/store/billing/customer data; client UID/email authority; live session resolver wiring; Supabase auth enablement; cutover implication; backend actions; mutation; or any raw IDs/secrets/DB URLs/tokens/payment identifiers/key dumps/mismatch lists/raw auth claims/provider UIDs/`identity_link` rows. **None were found.**

## 18. Acceptance Criteria

This milestone is acceptable when: the single QA doc exists under `docs/` and is redaction-safe; it records an honest QA decision (A/B/C) with evidence; it reports the route-registration, flag/environment, method, authority, synthetic-only, error/leak, exposure, no-mutation, test, typecheck, and static-scan reviews; it preserves all M2.1–M7G assumptions; it claims no live C-01 integration, no live session/Supabase auth, no production/cutover readiness; and no code/runtime/route/auth/DB/Supabase/UI change was made (nothing staged/committed/pushed/backed up).

## 19. Recommended Next Milestone

**Phase 2.0 M7I — Live C-01 Read Model Planning Gate** (a planning gate that designs how a real C-01 read model could later replace the synthetic source, under the full parity/safety/redaction gates) — *not* live implementation. The inert registration is accepted-safe, so the conservative next step is to **plan** the live read model behind a gate, keeping the route synthetic-only until that gate and its parity/isolation/redaction prerequisites are separately satisfied.
