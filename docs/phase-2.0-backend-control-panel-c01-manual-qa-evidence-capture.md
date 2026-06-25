# Phase 2.0 M7QB — C-01 Manual QA Evidence Capture

**Status:** Documentation / evidence only. No code, tests, UI, route, DTO, or backend behavior was changed. This document records runtime QA evidence for the C-01 Backend Control Panel readiness slice ahead of freezing it as the Phase 2.0 DEV QA baseline.

**Accepted checkpoint:** `ccf9949137257707551d2c0b6724cf30eed471d7`
**Most recent committed milestone:** Phase 2.0 M7QA — C-01 readiness QA package.

---

## 1. Executive Summary

Runtime QA evidence for C-01 was captured at the **API/transport layer** (the source of truth that drives the UI) and corroborated at the **code/configuration layer**. Every captured scenario is **safe**: the isolated identity API returns a safe `unavailable` (transport), `feature_disabled` (404), success (200 v1 envelope with bounded labels only), and `method_not_allowed` (405 for mutations). The success envelope contains **only safe bounded posture labels** — no raw IDs, secrets, tokens, DB URLs, emails, domains, tenant/store/customer data, or authorization primitives. DEV-gating, no-auto-fetch, and navigation isolation are confirmed in code. The full automated suite passes **106/106** and typecheck holds at the **12-error baseline (0 in C-01 touched files)**.

The one evidence class this automated capture **cannot** produce is in-browser visual confirmation of the rendered card pixels (no browser/display is available in this environment). The card's mapping of each API state to a safe UI state is fully covered by the client unit tests and the card source, but the actual rendered view should be spot-checked once by the owner. Accordingly this milestone records **Decision B — PASS WITH FOLLOW-UP**: all capturable runtime evidence passes and is safe; a short owner in-browser confirmation remains before freeze.

## 2. Environment and Boundary

- **DEV app context** — local development; not production; no deployed/production URL used.
- **Backend CP shell route (relative)** — `/dev/backend-control-plane` (DEV-gated; not exercised in a browser here).
- **C-01 route (relative)** — `/dev/bcp/readiness-summary` on the isolated platform-identity API; frontend proxy context `/__identity/dev/bcp/readiness-summary`.
- **Isolated identity API run?** — Yes, locally on the default loopback port, started via the project's existing `identity:api` entrypoint.
- **`ENABLE_BCP_DEV_READONLY_PILOT`** — exercised both unset (feature-disabled scenario) and `=true` (success scenario).
- **`VITE_ENABLE_BACKEND_CONTROL_PLANE`** — relevant to the DEV shell gate (confirmed in code; the shell UI itself was not opened in a browser here).
- **Hostnames/URLs** — only loopback (`localhost`) was used; no environment-specific hostname is recorded.
- **No DB / Supabase / provider access** — confirmed. The platform-identity DB feature flag (`ENABLE_SUPABASE_PLATFORM_IDENTITY`) gates all DB use; `getDb()` is lazy and is only called by `/readiness` and identity routes, none of which were invoked. Only `/health` (presence booleans only) and the code/config BCP route were called. The success envelope's `lastSuccessfulReadLabel: code-config-no-live-read` independently proves no live read occurred.

## 3. Manual QA Decision

**Decision B — PASS WITH FOLLOW-UP: MANUAL QA PARTIALLY CAPTURED; SPECIFIC EVIDENCE STILL NEEDED BEFORE FREEZE.**

All API-layer and code-layer runtime evidence passes and is safe. The remaining specific evidence is the owner's in-browser visual confirmation of the rendered card states (idle / unavailable / feature-disabled / success), which cannot be captured in this headless environment.

## 4. Scenario Evidence Table

| # | Scenario | Setup | Expected | Observed | Evidence Type | Result | Notes |
|---|---|---|---|---|---|---|---|
| 1 | DEV shell reachability | DEV + `VITE_ENABLE_BACKEND_CONTROL_PLANE=true` | Shell reachable only in DEV | `BCP_ROUTE_ENABLED = IS_DEV && BCP_FLAG_ON`; route spread into the router only when enabled, else excluded | Code/config | PASS (code) | Browser open not performed (no display) |
| 2 | Idle state / no auto-fetch | Open card, do not click | Quiet until button click | Fetch only inside `load` bound to button `onClick`; no `useEffect` | Code | PASS (code) | Browser render not viewed |
| 3 | API unavailable | API down, client GET | Safe unavailable, no stack trace | `curl` → exit 7 / HTTP 000 (connection refused) → client maps to `unavailable` | HTTP runtime | PASS | No raw error/transport detail surfaced |
| 4 | Feature disabled | API up, pilot flag OFF, GET | Safe feature-disabled | HTTP **404** `{"status":"unavailable","reason":"feature_disabled"}` | HTTP runtime | PASS | No data rows, no stack trace |
| 5 | Success | API up, pilot flag `=true`, GET | Safe bounded readiness labels | HTTP **200** v1 envelope (see §8); labels only | HTTP runtime | PASS | Full body captured + leak-scanned |
| 6 | Read-only / no mutation | POST / HEAD the route | Mutations blocked | POST → HTTP **405** `{"status":"method_not_allowed"}`; HEAD → 200 (no body) | HTTP runtime | PASS | No mutation success path |
| 7 | Navigation / exposure | Inspect SaaS nav & customer routes | C-01 isolated | Only reference outside the BCP folder is the DEV-gated route registration in `App.tsx`; no SaaS/POS/customer nav link | Code | PASS (code) | No production URL used |

## 5. Idle State Evidence

`C01ReadinessCard` performs no fetch on mount: the only `fetchC01Readiness()` call is inside the `load` callback, which is bound to the button's `onClick`. There is no `useEffect`-driven fetch. The initial render is the idle panel ("click Load C-01 Readiness"). No data is requested or shown until the button is pressed. (Browser-pixel confirmation deferred to owner.)

## 6. API Unavailable Evidence

With no listener on the API port, a client GET to `/dev/bcp/readiness-summary` returns transport failure (`curl` exit 7, HTTP 000 / connection refused). The client's `fetchC01Readiness` catch path maps this to `{ kind: 'unavailable' }`, which the card renders as the fixed safe "C-01 API unavailable" note — no stack trace, no raw error object, no hostname/exception detail.

## 7. Feature Disabled Evidence

With the API running but `ENABLE_BCP_DEV_READONLY_PILOT` unset, a GET returns:

```
HTTP 404
{"status":"unavailable","reason":"feature_disabled"}
```

The `/health` endpoint in this state reported config **presence booleans only** (`supabaseUrl/databaseUrl/serviceRoleKey` as booleans), with `featureEnabled=false`. (Note: `/health`'s `featureEnabled` reflects the *platform-identity* DB flag `ENABLE_SUPABASE_PLATFORM_IDENTITY` — a flag distinct from the BCP pilot flag exercised in this scenario.) The "no DB connection" guarantee does not rest on this reading; it rests on the fact that `getDb()` is lazy and is invoked only by `/readiness` and the identity routes — none of which were called — while `/health` and the code/config BCP route never call it. The client maps `404 + reason feature_disabled` to `{ kind: 'feature_disabled' }` → fixed safe "C-01 disabled" note. No data rows, no backend actions, no destructive controls.

## 8. Success State Evidence

With `ENABLE_BCP_DEV_READONLY_PILOT=true`, a GET returns **HTTP 200** with the additive v1 code/config envelope. Captured body (synthetic posture labels only):

```json
{
  "schemaVersion": "bcp.c01.readiness.v1-code-config",
  "sourceMode": "code_config",
  "environment": "DEV",
  "generatedAt": "2026-01-01T00:00:00.000Z",
  "data": { "categories": [
    { "category": "feature_flag_posture", "status": "enabled" },
    { "category": "route_registration_posture", "status": "ready" },
    { "category": "production_disabled_posture", "status": "production_disabled" },
    { "category": "redaction_posture", "status": "ready" },
    { "category": "synthetic_live_boundary_posture", "status": "code_config_only" },
    { "category": "parity_posture", "status": "static_config" },
    { "category": "phase_boundary_posture", "status": "guarded" },
    { "category": "isolation_posture", "status": "evidence_only" }
  ] },
  "redaction": { "redactionApplied": true, "redactionLevel": "standard", "omittedCategories": [], "maskedCategories": [] },
  "freshness": { "generatedAt": "2026-01-01T00:00:00.000Z", "lastSuccessfulReadLabel": "code-config-no-live-read" },
  "authorizationContext": { "visibilityClass": "overview_viewer", "scopeType": "platform", "environment": "DEV", "parityState": "ready" },
  "emptyState": { "isEmpty": false, "reason": "none" },
  "warnings": ["code_config"]
}
```

All values are short bounded labels. A pattern scan of the raw body for sensitive shapes (`internal_user_id`, provider UID, `service_role`, JWT `eyJ…`, `postgres://`, `sk-…`, email, UUID) returned **no matches**. The `authorizationContext` carries only bounded posture labels — no internal_user_id, no provider UID, no raw claims. `generatedAt` is a fixed synthetic timestamp (not wall-clock), and `lastSuccessfulReadLabel: code-config-no-live-read` confirms code/config posture (no live read).

## 9. Read-only / No Mutation Evidence

- `POST /dev/bcp/readiness-summary` → HTTP **405** `{"status":"method_not_allowed"}` — no mutation success path.
- `HEAD` → 200 with no body — safe.
- The only client action is a GET (Load/Reload); the card exposes no execute/provision/restart/delete/approve control. The client is GET-only with no body, `credentials:'omit'`, no `Authorization`, and no identity fields.

## 10. Navigation / Exposure Evidence

The only reference to the Backend CP shell route outside the `src/backend-control-plane/` folder is the **DEV-gated route registration** in `src/App.tsx` (spread into the router only when `BCP_ROUTE_ENABLED`, excluded entirely otherwise). No normal SaaS navigation, POS, repairs, customer, invoice, service, or store dashboard screen links to C-01. No production/deployed URL was used for this QA.

## 11. Data Boundary Evidence

Across all captured states, no raw IDs, internal_user_id, provider UIDs, raw auth claims, identity_link rows, audit rows, permission keys, entitlement keys, mismatch lists, secrets, tokens, DB URLs, emails, domains, payment identifiers, row dumps, tenant/store/customer data, or destructive controls appeared. Error/disabled states return fixed safe messages (no stack traces, no raw error objects). The success body passed a sensitive-pattern scan with zero matches.

## 12. Automated Test Evidence

| Suite | Result |
|---|---|
| `bcpC01Client.test.ts` | 20/20 |
| `bcpPilot.test.ts` | 33/33 |
| `bcpReadOnlyRoute.test.ts` | 28/28 |
| `bcpReadOnlyExpressAdapter.test.ts` | 10/10 |
| `bcpC01CodeConfigReadModel.test.ts` | 15/15 |
| **Total** | **106/106** |

These suites runtime-execute the route states (unavailable/feature_disabled/success/method_not_allowed), the client state mapping, and the envelope/redaction — corroborating the captured HTTP evidence.

## 13. Typecheck Evidence

`npx tsc --noEmit` → **12** errors total = pre-existing baseline (unrelated files outside the C-01 area); **0** errors in C-01 touched files.

## 14. Static Scan Evidence

- No `src/`, `server/`, or `shared/` changes this milestone (`git diff` clean for those paths).
- No production exposure (route production-disabled + default-off; UI DEV-gated).
- No SaaS navigation exposure (only the DEV-gated route registration references the shell route).
- No DB/Supabase/provider imports introduced; no live calls.
- No mutation method additions (POST→405).
- No raw-ID/secret patterns in this document (success body is synthetic bounded labels).
- `.gitattributes` absent; no `dist/**` changes.

## 15. Stop Conditions Review

No stop condition triggered: no unsafe rendering, no exposure, no route/registration change, no data leak, no destructive control, and no runtime failure. The success path returns 200 with safe labels; the disabled/unavailable/mutation paths return safe 404/000/405 responses.

## 16. Manual QA Limitations

- Evidence is **DEV-only**; this is not production QA.
- Evidence is captured at the **API/transport + code layer**; the rendered **browser UI pixels were not viewed** (no browser/display in this environment).
- No DB / live-data validation (none exists for C-01; intentional).
- No Supabase validation (dormant/readiness-only).
- No Phase 3 controlled-action validation (not started).
- No Phase 4 production-hardening validation (not started).

## 17. Freeze Recommendation

**Do not freeze on automated evidence alone — capture the owner's short in-browser confirmation first, then freeze.** All substantive runtime safety is proven (API responses safe and label-only across every state; mutation blocked; isolation and DEV-gating confirmed; 106/106 tests). The only residual is a brief human visual spot-check of the rendered card states, after which C-01 can be frozen as the Phase 2.0 DEV QA baseline.

## 18. Recommended Next Milestone

**Phase 2.0 M7QB2 — C-01 Manual QA Evidence Follow-up** (owner in-browser visual capture of the idle / unavailable / feature-disabled / success card states). On completion, proceed to **Phase 2.0 M7QC — C-01 Baseline Freeze and Phase 2.0 Entry to C-02**, then **M8 — C-02 Planning Gate**.

---

*Documentation/evidence only. No code, tests, UI, route, DTO, or backend behavior was changed. The isolated identity API was started locally in DEV with only the BCP read-only pilot flag and exercised over loopback; no DB connection, SQL, migration, Supabase access, Supabase MCP, live provider, or production call occurred; no commit/push/backup was performed. This document does not implement code, does not modify route behavior, does not claim C-02 is implemented, does not claim live session auth or Supabase auth is enabled, does not claim the Backend Control Panel is production-ready, and does not claim Supabase is ready for a Firebase cutover. No real tenant/store/customer data, raw IDs, internal_user_id, provider UIDs, raw auth claims, identity_link rows, audit rows, permission/entitlement key lists, mismatch lists, secrets, tokens, DB URLs, emails, domains, or payment identifiers appear herein; the captured success body is synthetic code/config posture labels only.*
