# Phase 2.0 M7I — Backend Control Panel Live C-01 Read Model Planning Gate

**Status:** Planning/documentation-only · Plans (does not implement) a future live C-01 Readiness Summary read model behind the accepted inert DEV-only route
**Accepted checkpoint at authoring:** `0207201675faae7f4c4871c33e5ca7b6d3767379` (Phase 2.0 M7H)
**Authoring milestone:** Phase 2.0 M7I

> Redaction-first. No real tenant/store/customer data, raw IDs, emails, domains,
> DB URLs, tokens, secrets, payment identifiers, permission/entitlement key lists,
> mismatch lists, raw auth claims, raw provider UIDs, or raw `identity_link` rows.
> All DTO/posture values shown are **synthetic placeholders only**. This milestone
> implements **nothing**: no live read model, no DTO/mapper code, no route change,
> no DB/SQL/Supabase access, no auth/runtime/route/UI change. Nothing is staged,
> committed, pushed, or backed up.

---

## 1. Executive Summary

A future live C-01 Readiness Summary read model is **conditionally promising but not yet ready to implement**. C-01 is uniquely the lowest-risk contract in the inventory because its content is **self-referential system posture** — feature-flag state, route-registration state, parity posture, redaction posture, and phase-boundary posture — and **not** tenant/store/customer business data. That property means a live C-01 read model can plausibly be built as a **code/config-posture reader that touches no database, no Supabase, and no provider at all**. However, the candidate source areas have **not yet been inventoried, ownership-classified, or proven DB-free**, and the safest source for parity posture has not been separated from identity-touching paths. Because source ownership and readiness are not fully proven from existing code/docs, the conservative decision is **Decision B — READY TO REQUEST A C-01 SOURCE INVENTORY AND SCHEMA READINESS REVIEW BEFORE IMPLEMENTATION**. The existing M7G/M7H route remains synthetic-only, default-off, production-disabled, and is **not modified** by this milestone.

## 2. Current State and Boundary

Accepted route state (M7G/M7H), restated and unchanged:

- Route path: `GET /dev/bcp/readiness-summary`, registered via `app.all(BCP_READINESS_ROUTE_PATH, …)` in `server/platform-identity/server.ts` on the **isolated** platform-identity API only (own port `5002`, started only via `npm run identity:api`).
- The route is **default-off** (`ENABLE_BCP_DEV_READONLY_PILOT`), **production-disabled**, **DEV-only**, **GET-only for success**, **synthetic-only**, and **fail-closed**.
- It is **not** mounted in the SaaS/Vite app, has **no** Backend CP UI adapter, **no** frontend fetch, and **no** normal SaaS navigation exposure.
- It performs **no** live C-01 data integration, **no** C-02 integration, **no** DB/Supabase/provider access, **no** backend actions, and **no** mutation path.
- The source is a fixed, server-constructed **synthetic** posture object; the principal is a fixed, server-constructed **synthetic** server-derived principal (no live session resolver wired).
- **61/61** unit tests pass; **0** new type errors in M7G-touched files.

Global constraints (restated, unchanged): Firebase / legacy AccessContext remains current frontend/app authority; future BCP live read APIs require a server-derived authorization principal after parity/safety gates; Supabase remains dormant/shadow/readiness-only and is not ready for Firebase cutover; no live pilot is authorized; no live C-01 read model is authorized; controlled backend actions remain Phase 3; production readiness remains Phase 4.

**C-01 is still synthetic-only today.** This document plans only; it changes nothing.

## 3. Planning Decision

**Decision B — READY TO REQUEST C-01 SOURCE INVENTORY AND SCHEMA READINESS REVIEW BEFORE IMPLEMENTATION.**

Rationale (conservative):

- **Why not Decision A (request implementation now):** Decision A requires that source ownership, authorization, isolation, redaction, DTO shape, test plan, and stop conditions are *all* clear enough for a tightly scoped implementation. The DTO shape (M7C/M7E envelope), the redaction rules (M4 + the harness allow-list/strip logic), the authorization boundary (M7C guard), and the test plan **are** clear and already exist as code/docs. What is **not** yet proven is the **source boundary**: exactly which code/config modules would supply each posture category, who owns them, and a confirmed guarantee that none of them require a DB/Supabase/identity read. Implementing before that inventory risks silently wiring a posture category to an identity- or DB-touching source. This blocks Decision A.
- **Why not Decision C (not ready / repair required):** No unresolved authority, isolation, source-safety, or route-safety *defect* exists. The route is accepted-safe; the authority model, isolation rules, and redaction rules are defined and proven against synthetic inputs. Nothing currently *forces* C-01 to read tenant/store rows, a DB, or Supabase — so there is nothing to repair. C-01's content is self-referential posture, which is the safest possible class. This rules out Decision C.
- **Why Decision B is correct:** The single missing artifact is a **source inventory and readiness classification**. Producing it (a) confirms each posture category maps to a code/config source rather than a DB/identity source, (b) records ownership and sensitivity per source, and (c) lets a subsequent implementation milestone be tightly and safely scoped. This mirrors the milestone chain's established gate-before-implement discipline (M7 Decision B → M7A → M7B foundation/test-harness before any live API).

## 4. C-01 Definition

**C-01 Readiness Summary** is an **aggregate, status/posture-only** read contract that reports the **Backend Control Panel's own readiness posture** — i.e., the system's self-referential state, not business data. It is redacted before response, safe-empty-state capable, DEV-only at first, and returns **no** raw rows or raw identifiers.

Allowed C-01 contributions (posture labels / status only):

- **Route foundation status** — whether the inert read-only route foundation exists.
- **Feature-flag posture** — enabled/disabled posture of `ENABLE_BCP_DEV_READONLY_PILOT` (state label, not secret).
- **Route registration posture** — registered/unregistered posture on the isolated platform API.
- **Production-disabled posture** — whether the route is disabled outside DEV.
- **Test posture** — pass/fail posture label (sourced from documentation/CI evidence, not a live runtime read).
- **Typecheck posture** — clean/baseline posture label (documentation/CI-derived).
- **Isolation posture** — whether tenant/store isolation rules are defined/enforced (posture label).
- **Redaction posture** — whether redaction/forbidden-field stripping is active (posture label).
- **Parity posture** — Firebase/Supabase parity readiness posture label (`ready`/`unresolved`/`blocked`).
- **Synthetic/live-source boundary posture** — whether the route is serving a synthetic or a (future, separately authorized) live source.

Forbidden in C-01 (binding — never exposed):

- Raw tenant/store/customer rows · raw IDs · raw `internal_user_id` · raw provider UIDs
- Raw audit logs · raw `identity_link` rows · raw auth claims
- Raw permission keys · raw entitlement keys · raw mismatch lists
- Secrets · tokens · DB URLs · provider credentials
- Billing / payment identifiers

This matches the M2 contract-map C-01 sketch (`{ devReview, liveReadOnly, controlledActions, production, redacted }`) and the M7C/M7E synthetic envelope already in code.

## 5. Candidate Source Areas

Listed from existing code/docs only. Each is classified by readiness category.

| # | Candidate source area | Classification |
|---|---|---|
| S-1 | BCP feature-flag posture — `server/bcp-pilot/bcpPilotConfig.ts` (`isBcpDevReadonlyPilotEnabled()`, production-disable gate) | **Candidate for aggregate posture** · code-derived |
| S-2 | Route registration posture — `BCP_READINESS_ROUTE_PATH` constant + `app.all(...)` registration in `server/platform-identity/server.ts` | **Candidate for aggregate posture** · code-derived |
| S-3 | Production-disabled / environment posture — `NODE_ENV` gate logic (read as a posture label, not the value) | **Candidate for aggregate posture** · code-derived |
| S-4 | Redaction posture — presence/activeness of the harness allow-list + forbidden-field stripping (`bcpReadinessSummaryHarness.ts`) | **Candidate for aggregate posture** · code-derived |
| S-5 | Synthetic/live-source boundary posture — whether the adapter is wired to a synthetic vs live source | **Candidate for aggregate posture** · code-derived |
| S-6 | Phase-boundary posture — governance constants (`liveReadOnly: blocked`, `controlledActions: blocked`, `production: blocked`) from the M2 contract map | **Documentation-only source** (safe constants) |
| S-7 | Test posture — pass/fail label for the 61-case suite | **Documentation-only source** (CI/evidence-derived; not a live runtime read) |
| S-8 | Typecheck posture — clean/baseline label | **Documentation-only source** (CI/evidence-derived) |
| S-9 | Isolation posture — whether tenant/store isolation rules are defined/enforced (label) | **Documentation-only source** (M5 test-plan-derived label) |
| S-10 | Parity posture — Firebase/Supabase parity readiness label (M6) | **Blocked pending authorization review** — a live parity *check* could touch identity; only a static/config-derived parity **label** is acceptable, to be confirmed by the inventory |
| S-11 | Any DB/Supabase-sourced counts or rows | **Blocked pending schema review** — not required by C-01; not eligible until separately authorized |
| S-12 | Tenant/store/billing/identity_link/audit content | **Out of scope** — these belong to C-04/C-06/C-07/C-09, never C-01 |

The inventory milestone (Decision B) must confirm S-1…S-5 are strictly code/config reads, downgrade S-10 to a static label or defer it, and keep S-11/S-12 excluded.

## 6. Source Readiness Matrix

| Source area | Source type | Expected data sensitivity | Allowed C-01 contribution | Forbidden fields | Isolation requirement | Redaction requirement | Current readiness | Next action |
|---|---|---|---|---|---|---|---|---|
| S-1 Feature-flag posture | Code/config | Low (non-secret state) | Flag enabled/disabled **label** | Raw env values, secrets | None (platform-level) | Emit label only; never the raw value | Likely-ready, unconfirmed | Confirm code-only read in inventory |
| S-2 Route registration posture | Code | Low | Registered/foundation **label** | Internal paths beyond the known route label | None | Label only | Likely-ready, unconfirmed | Confirm in inventory |
| S-3 Production/env posture | Code/config | Low | Production-disabled **label** | Raw `NODE_ENV`/host values | None | Label only | Likely-ready, unconfirmed | Confirm in inventory |
| S-4 Redaction posture | Code | Low | Redaction-active **label** | The forbidden-key list contents | None | Label only | Likely-ready, unconfirmed | Confirm in inventory |
| S-5 Synthetic/live boundary posture | Code | Low | Source-mode **label** | None | None | Label only | Likely-ready, unconfirmed | Confirm in inventory |
| S-6 Phase-boundary posture | Doc constant | Low | `blocked`/`ready` governance **labels** | None | None | Label only | Ready | Adopt as constants |
| S-7 Test posture | Doc/CI | Low | Pass/fail **label** | Raw logs, stack traces | None | Label only | Ready (as label) | Decide live-vs-static in inventory |
| S-8 Typecheck posture | Doc/CI | Low | Clean/baseline **label** | Raw compiler output | None | Label only | Ready (as label) | Decide live-vs-static in inventory |
| S-9 Isolation posture | Doc (M5) | Low | Defined/enforced **label** | Tenant/store specifics | Must not reveal tenant/store existence | Label only | Ready (as label) | Adopt as label |
| S-10 Parity posture | Config/Doc (M6) | Medium | Parity-state **label** | Identity rows, raw claims, provider UIDs | Must not read identity to compute | Label only | **Blocked pending authorization review** | Confirm static/config-only label or defer |
| S-11 DB/Supabase counts | DB/Supabase | High | **None for C-01** | Raw rows/IDs, connection data | Full server-side scope if ever used | N/A (excluded) | **Blocked pending schema review** | Keep excluded; separate gate if ever needed |
| S-12 Tenant/store/identity/audit content | DB/provider | High/Restricted | **None for C-01** | All raw business/identity/audit data | N/A | N/A | **Out of scope** | Keep excluded (belongs to other contracts) |

## 7. Server Authorization Plan

Future C-01 live read model authorization requirements (no wiring in this milestone):

- **Server-derived principal only** — authority comes solely from the M7C-style server-derived principal (`source: 'server_derived'`, `verified`, durable `internalUserId`).
- **No client UID authority · no email authority · no request-body authority · no querystring tenant/store authority · no frontend-only claim authority.** These remain non-authority hints, present only to prove they are ignored.
- **Fail closed** — missing/invalid principal ⇒ deny; unresolved parity ⇒ blocked; unknown contract/visibility ⇒ deny.
- **Parity-ready required** — only `parityState === 'ready'` may proceed.
- **RBAC visibility required** — principal must meet C-01's minimum visibility (`overview_viewer`); denials collapse to one uniform shape.
- **Tenant/store scope enforced server-side** *only if* a source is tenant/store-scoped — C-01 is platform-level, so no tenant/store scoping is expected; if any source ever implies scope, it must be enforced server-side.
- **No live session resolver change in this milestone** and none in the inventory milestone; live-principal wiring remains a later, separately authorized step.
- **`internalUserId` stays server-internal** — the durable anchor is used only to make the authorization decision and must **never** appear in the C-01 DTO, including the `authorizationContext` block (which carries posture labels only, never raw IDs).

## 8. Tenant / Store Isolation Plan

Future requirements (C-01 is platform-level posture):

- C-01 must **avoid tenant/store-specific detail** unless a scope is explicitly authorized — which is not anticipated for C-01.
- Aggregate posture must **not reveal unauthorized tenant/store existence** (no counts or labels that imply which tenants/stores exist).
- **Empty states must be safe** — an empty result is indistinguishable from a hidden/redacted one.
- **Cross-tenant access must fail closed.**
- **Store scope must be enforced server-side** if any future source is store-scoped (not anticipated for C-01).

## 9. Redaction and DTO Plan

Future C-01 DTO must reuse the **existing M7C/M7E envelope pattern** (no new shape invented):

- `schemaVersion` — a stable versioned label (the synthetic version is `bcp.c01.readiness.v0-synthetic`; a live version would be a new explicit label, e.g. a proposed `bcp.c01.readiness.v1`, decided at implementation).
- `generatedAt` — **server-side source only**, ISO-validated; never echoed from a request.
- `environment` — explicit `DEV` label.
- `data.categories[]` — readiness categories as **safe bounded labels** (`category`/`status`/`severity`), content-validated by the existing `safeLabel` allow-list.
- `redaction` — redaction metadata (`redactionApplied`, `redactionLevel`, `omittedCategories`, `maskedCategories`), reporting omissions as **generic categories**, never raw field names/values.
- `freshness` — `generatedAt` + a freshness label.
- `authorizationContext` — posture labels only (`visibilityClass`, `scopeType`, `environment`, `parityState`); never raw role/user/tenant/store IDs.
- `emptyState` — `isEmpty` + safe reason.
- `warnings` — safe labels only.
- **No raw source passthrough** — never spread a raw source object; copy only allow-listed fields.
- **Forbidden-field stripping** — the harness `FORBIDDEN_KEY_CATEGORY` strip-and-report logic remains binding.
- **Safe error and blocked states** — failures collapse to a generic `{ status: 'error' }`; non-allow guard decisions yield safe denied/blocked empty envelopes.

Synthetic/redacted DTO illustration (placeholder values only — **not** real data, **not** an implemented response):

```jsonc
{
  "schemaVersion": "bcp.c01.readiness.v1",            // PROPOSED future label — NOT implemented; today's synthetic version is bcp.c01.readiness.v0-synthetic
  "environment": "DEV",
  "generatedAt": "<server-time-iso>",                  // server-side only, ISO-validated
  "data": {
    "categories": [
      { "category": "route_foundation", "status": "ready",   "severity": "low" },
      { "category": "feature_flag",     "status": "ready",   "severity": "low" },
      { "category": "live_read_only",   "status": "blocked", "severity": "low" },
      { "category": "controlled_actions","status": "blocked","severity": "low" },
      { "category": "production",       "status": "blocked", "severity": "low" }
    ]
  },
  "redaction": { "redactionApplied": true, "redactionLevel": "standard", "omittedCategories": [], "maskedCategories": [] },
  "freshness": { "generatedAt": "<server-time-iso>", "lastSuccessfulReadLabel": "redacted" },
  "authorizationContext": { "visibilityClass": "overview_viewer", "scopeType": "platform", "environment": "DEV", "parityState": "ready" },
  "emptyState": { "isEmpty": false, "reason": "none" },
  "warnings": []
}
```

## 10. Read Model Boundary Plan

Future live C-01 read model boundary (binding):

- **Server-owned** — the read model lives on the server, behind the isolated platform API.
- **Read-only** — no writes, no mutation helpers, no backend actions.
- **No route logic duplication** — the M7E pure handler keeps deciding gates/authorization/shape; the read model only *replaces the synthetic source* with a server-owned posture reader.
- **No UI-side security filtering** — filtering is presentation, never an authorization boundary.
- **No direct table passthrough · no raw rows · no raw IDs.**
- **No DB access** unless a *separate* implementation milestone explicitly authorizes a specific, schema-reviewed source — which C-01 is expected **not** to need.

## 11. Route Integration Plan

Future integration with the existing route (binding):

- The existing route remains **default-off**, **production-disabled**, and on the **isolated platform API only**.
- A live read model may replace the **synthetic source only**, and only after a separate implementation approval — the gate order, method handling, and authorization in the M7E handler are unchanged.
- The **adapter stays thin** — it continues to inject a server-constructed principal/source and serialize the safe result; it gains no business/redaction logic.
- The handler **preserves the existing response categories** (`feature_disabled`, `dev_only`, `method_not_allowed`, `not_authorized`, `parity_blocked`, `synthetic_success`/success, `no_content`, `safe_error`).
- **No frontend fetch / UI adapter** is added in the live read model milestone unless separately authorized.

## 12. Test Plan for Future Implementation

Required tests before any live C-01 read model is accepted (none written here):

- Source disabled/fallback behavior (live source unavailable ⇒ safe fallback, no leak).
- Route remains flag-gated (default-off ⇒ unavailable).
- Production-disabled behavior (production ⇒ unavailable, no existence disclosure).
- Server authorization fail-closed (missing/invalid principal ⇒ deny).
- No client UID/email/body/query authority (hints proven ignored).
- Tenant/store isolation (no tenant/store existence leakage; cross-scope fails closed).
- RBAC visibility (below `overview_viewer` ⇒ uniform deny).
- Parity blocked (`parityState !== 'ready'` ⇒ blocked).
- Redaction / forbidden-field stripping (forbidden keys stripped, reported as generic categories).
- Safe empty state (empty indistinguishable from hidden).
- No raw rows · no mutation · no DB writes.
- No `identity_link` exposure · no audit writes (unless separately authorized).
- No UI/frontend exposure (0 `src/**` references; 0 fetch references).
- The existing **61** tests remain passing.

## 13. Evidence Requirements

Future evidence to be produced at implementation (none produced here):

- Exact files touched.
- Exact source areas used (per the §6 matrix) and their sensitivity classification.
- A DTO sample with **synthetic/redacted values only**.
- Tests passed (full count) · typecheck result (baseline + 0 new in touched files).
- Import scan (no DB/Supabase/provider imports in non-test C-01 code unless separately authorized).
- Leak scan (no secrets/URLs/tokens/raw IDs).
- No-mutation proof · no-production-exposure proof · no-UI-exposure proof.
- `git status`.

## 14. Explicitly Excluded Scope

Excluded from M7I (this milestone) and from the recommended next milestone unless separately authorized:

- Implementation of the live C-01 read model in M7I.
- DB connection · SQL/migration · Supabase access · live provider access.
- C-02 integration.
- Backend CP UI adapter · frontend fetch · normal SaaS navigation exposure · production route exposure.
- Live session auth enablement · Supabase auth enablement · Firebase-to-Supabase cutover.
- Backend actions · mutation · audit writes · `identity_link` writes.
- Raw `identity_link` rows · raw audit logs · raw auth claims · real tenant/store/customer details · billing/payment identifiers.

## 15. Risk Register

| ID | Risk | Severity | Mitigation | Blocks next milestone? |
|---|---|---|---|---|
| R-1 | **C-01 scope creep** — posture grows into business data | Medium | Pin C-01 to self-referential posture labels (§4); inventory classifies every source | No (inventory enforces) |
| R-2 | **Source ownership unclear** | Medium | The Decision-B inventory records owner + type per source before any code | No (this is the next step) |
| R-3 | **Source sensitivity underestimated** | Medium | §6 matrix forces a sensitivity + forbidden-fields classification per source | No |
| R-4 | **Tenant/store leakage** | High | C-01 is platform-level; no tenant/store sources (S-12 out of scope); isolation tests required | No (none in scope) |
| R-5 | **Redaction gap** | Medium | Reuse the proven M7C/M7E strip+allow-list envelope; redaction tests required | No |
| R-6 | **Route becomes live too early** | High | Synthetic source stays until a separate implementation approval; route unchanged here | No |
| R-7 | **UI fetch added too early** | Medium | No UI/fetch in inventory or implementation unless separately authorized; static scan | No |
| R-8 | **Real principal wiring too early** | High | No live session resolver in M7I or the inventory; later gated milestone | No |
| R-9 | **DB access introduced without a gate** | High | C-01 needs no DB; S-11 blocked pending schema review; import scan enforces | No |
| R-10 | **Supabase cutover confusion** | High | Supabase stays dormant/readiness-only; no auth/cutover implied | No |
| R-11 | **Synthetic/live boundary confusion** | Medium | Source-mode posture label (S-5) makes the boundary explicit and testable | No |
| R-12 | **Mutation leakage** | High | GET-only handler; no write methods/helpers; no-mutation tests required | No |

No risk blocks the recommended next milestone (a source inventory), and the high-severity risks are all *future-implementation* prerequisites rather than present defects.

## 16. Stop Conditions

Halt and reassess (escalate toward Decision C) if a future C-01 source ever:

- Requires unreviewed DB access · requires Supabase MCP · requires SQL/migration.
- Requires raw rows/IDs · reveals tenant/store existence.
- Requires client UID/email authority · requires UI-side security filtering.
- Requires a live session resolver change · requires Supabase auth/cutover.
- Requires backend actions/mutation.
- Requires raw secrets/tokens/DB URLs/payment identifiers/key dumps/mismatch lists/auth claims/provider UIDs/`identity_link` rows.

## 17. Acceptance Criteria

M7I is acceptable when: the single planning doc exists under `docs/` and is redaction-safe; it records an honest planning decision (A/B/C) with rationale; it defines C-01, the candidate source areas, the source readiness matrix, and the server-authorization, tenant/store-isolation, redaction/DTO, read-model-boundary, route-integration, test, and evidence plans, plus excluded scope, a risk register, and stop conditions; it preserves all M1–M7H assumptions (two authority planes, synthetic-only route, parity/isolation/RBAC/redaction gates, Supabase dormancy, Phase 3/4 boundaries); it claims **no** live C-01 integration, **no** live session/Supabase auth, **no** production/cutover readiness; and **no** code/runtime/route/auth/DB/Supabase/UI change was made (nothing staged/committed/pushed/backed up).

## 18. Recommended Next Milestone

**Phase 2.0 M7J — C-01 Source Inventory and Schema Readiness Review** (per Decision B). It must inventory and ownership-classify each candidate source area (§5/§6), confirm S-1…S-5 are strictly code/config reads, resolve S-10 parity posture to a static/config-derived label or defer it, keep S-11/S-12 excluded, and produce the source-readiness evidence required before any **separately scoped** DEV-only live C-01 read model implementation is requested. Implementation is **not** recommended until the source boundary is proven exceptionally clear and safe by that inventory.
