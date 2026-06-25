# Phase 2.0 M8A — C-02 Source Inventory and Schema Readiness Review

**Status:** Documentation / review only. No code, tests, UI, route, DTO, or backend behavior was changed. This milestone inventories the existing code/config surface for the selected **Candidate A — Backend CP Route / Module Registry Readiness Lens** and assesses whether C-02 can safely proceed to an *implementation plan* (not implementation).

**Accepted checkpoint:** `b2e153eb57c5be7231a644c3be9629f59e3ee048`
**Most recent committed milestone:** Phase 2.0 M8 — C-02 planning gate.

---

## 1. Executive Summary

The source inventory is **complete and clean**: every source Candidate A would use is **code/config / static** with **no DB/Supabase/provider/live access** (verified by static scan — no `createClient`/`@supabase`/`getDb`/`process.env.DATABASE` anywhere in `server/bcp-pilot/**` or `src/backend-control-plane/**`). C-01 provides a fully reusable pattern (read model → harness/envelope → authz guard → pure route → express adapter → hardened client → test suites). A safe future DTO concept (`bcp.c02.registry-readiness.v1-code-config`) is defined with every field classified as a bounded label / enum / boolean / bounded count. One firm boundary is recorded: `src/backend-control-plane/mockData.ts` also contains **synthetic tenant/store/audit/database mock rows** which are **out of scope** — C-02 uses only the `MODULES` registry (keys/labels/status) and backend posture metadata, never those row shapes. Decision: **Decision A — PASS: source inventory and schema readiness complete; ready to request an implementation plan** (implementation itself is **not** authorized). Next: **Phase 2.0 M8B — C-02 Implementation Plan and Safety Contract.**

## 2. C-01 Freeze and M8 Planning Context

C-01 is frozen (M7QC) as the Phase 2.0 DEV QA baseline: DEV-only, default-off (`ENABLE_BCP_DEV_READONLY_PILOT`), production-disabled, isolated, read-only, GET-only success (`/dev/bcp/readiness-summary` via `/__identity/...`), code/config posture only, v1 code/config DTO + v0 synthetic compatibility, hardened client, safe labels only, no DB/Supabase/provider/live source, no backend actions, no mutation, no production exposure; 106/106 tests; 0 touched-file type errors. M8 selected **Candidate A** (code/config registry lens). Global constraints unchanged (Firebase authority; Supabase dormant; no cutover; Phase 3 actions; Phase 4 production).

## 3. Review Decision

**Decision A — PASS: C-02 SOURCE INVENTORY AND SCHEMA READINESS COMPLETE; READY TO REQUEST IMPLEMENTATION PLAN.**

Source inventory and schema readiness are complete enough to safely plan implementation. This does **not** authorize C-02 implementation.

## 4. Source Inventory Matrix

| Source / file | Purpose | C-02 use later? | Source type | Data sensitivity | DB/Supabase dep | Route/API dep | UI dep | Redaction need | Test relevance | Impl. readiness | Classification |
|---|---|---|---|---|---|---|---|---|---|---|---|
| `src/backend-control-plane/mockData.ts` (`MODULES`) | Static module registry (id/name/status) | Yes — primary registry input | static code/config | Low (operational labels) | None | None | None | Low (bound labels) | n/a | High | **READY AS CODE/CONFIG SOURCE** |
| `src/backend-control-plane/mockData.ts` (TenantRow/StoreRow/AuditRow/DatabaseRow mock arrays) | Synthetic mock rows for Phase 1.6 mock screens | No | static mock | Sensitive **shape** | None | None | None | N/A (exclude) | n/a | n/a | **BLOCKED / OUT OF SCOPE** |
| `src/backend-control-plane/types.ts` (`BcpModule`, `ModuleStatus`) | Registry type definitions | Yes — registry types | static code/config | Low | None | None | None | Low | n/a | High | **READY AS CODE/CONFIG SOURCE** |
| `src/backend-control-plane/types.ts` (TenantRow/AuditRow/PermissionRow/etc.) | Types for sensitive-shaped rows | No | static code/config | Sensitive shape | None | None | None | N/A (exclude) | n/a | n/a | **BLOCKED / OUT OF SCOPE** |
| `src/backend-control-plane/bcpEnv.ts` | DEV gates/flags (`BCP_ROUTE_ENABLED`, `BCP_FLAG_ON`, route path) | Yes — gate posture input | static code/config | Low | None | None | Yes (gate) | None | n/a | High | **READY AS CODE/CONFIG SOURCE** |
| `src/backend-control-plane/screens.tsx` | Presentational screens (static only) | Pattern + module→screen mapping (safe boolean) | static code/config | Low | None | None | Yes | Low | n/a | Med | **READY AS PATTERN ONLY** |
| `src/backend-control-plane/C01ReadinessCard.tsx` | C-01 preview card | Pattern for a future C-02 card | code | Low | None | None | Yes | n/a | n/a | High | **READY AS PATTERN ONLY** |
| `src/backend-control-plane/bcpC01Client.ts` | GET client + `safeLabel`/`deriveSourceMode` | Pattern + reuse `safeLabel` | code | Low | None | Yes (client) | Yes | n/a | High | High | **READY AS PATTERN ONLY** |
| `src/backend-control-plane/bcpC01Client.test.ts` | Client tests | Pattern for C-02 client tests | test | Low | None | None | None | n/a | High | High | **READY AS PATTERN ONLY** |
| `src/backend-control-plane/{Shell,BackendControlPlaneApp,AccessGate,ui}.tsx` | Shell/gating/UI primitives | Context + UI primitives | code | Low | None | None | Yes | n/a | n/a | Med | **READY AS PATTERN ONLY** |
| `src/App.tsx` | DEV shell route gating context | Read-only context; must not change | code | Low | None | Yes (gate) | Yes | n/a | n/a | n/a | **NEEDS REVIEW BEFORE USE** (do not modify) |
| `server/bcp-pilot/bcpC01CodeConfigReadModel.ts` | C-01 code/config read model | Pattern for C-02 registry read model | code/config | Low | None | None | None | Low | High | High | **READY AS PATTERN ONLY** |
| `server/bcp-pilot/bcpReadinessSummaryHarness.ts` | Envelope builder + `safeLabel` + meta | Pattern for C-02 envelope/DTO | code | Low | None | None | None | High (reuse) | High | High | **READY AS PATTERN ONLY** |
| `server/bcp-pilot/bcpPilotConfig.ts` | Flag const + `isBcpDevReadonlyPilotEnabled()` | Pattern (a new C-02 flag would be added later) | config | Low | None | None | None | None | Med | High | **READY AS PATTERN ONLY** |
| `server/bcp-pilot/bcpAuthorizationGuard.ts` | Server-derived authz guard (`authorizeBcpRead`) | Reusable guard for C-02 | code | Low (synthetic principal) | None | Yes (guard) | None | Med | High | High | **READY AS PATTERN ONLY** (reusable) |
| `server/bcp-pilot/bcpReadOnlyRoute.ts` | Pure route handler boundary | Pattern for C-02 route handler | code | Low | None | Yes | None | Med | High | High | **READY AS PATTERN ONLY** |
| `server/bcp-pilot/bcpReadOnlyExpressAdapter.ts` | Express adapter + route path const | Pattern for C-02 adapter | code | Low | None | Yes | None | Low | High | High | **READY AS PATTERN ONLY** |
| `server/bcp-pilot/*.test.ts` (pilot/route/adapter/readModel) | Test suites | Patterns for C-02 tests | test | Low | None | None | None | n/a | High | High | **READY AS PATTERN ONLY** |
| `server/platform-identity/server.ts` | Isolated API + route registration | Registration point for a future C-02 route (later) | code | Low | None | Yes | None | n/a | n/a | Med | **NEEDS REVIEW BEFORE USE** (do not modify now) |
| Prior C-01/C-02 docs | Decisions, QA, freeze, planning | Cross-reference | docs | None | None | None | None | n/a | n/a | n/a | **READY AS PATTERN ONLY** |

## 5. Selected C-02 Source Set

- **Safe code/config sources (data inputs):** `mockData.ts MODULES`, `types.ts BcpModule/ModuleStatus`, `bcpEnv.ts` gates/flags, and (server-side) the static route-path constants + flag helpers + posture categories already used by C-01.
- **Pattern-only (reuse the shape, write new C-02 equivalents):** `bcpC01CodeConfigReadModel.ts`, `bcpReadinessSummaryHarness.ts`, `bcpAuthorizationGuard.ts` (the guard is directly reusable), `bcpReadOnlyRoute.ts`, `bcpReadOnlyExpressAdapter.ts`, `bcpC01Client.ts` (+`safeLabel`), `C01ReadinessCard.tsx`, and all `*.test.ts`.
- **Excluded / out of scope:** all sensitive-shaped mock rows and types (TenantRow/StoreRow/AuditRow/DatabaseRow/PermissionRow/ApprovalRow), `App.tsx`/`server.ts` (read-only context now; registration is an implementation concern), and any raw file contents/paths beyond safe DEV route labels.

## 6. C-02 Registry Lens Definition

A future DEV-only, read-only **registry readiness lens** that summarizes safe metadata per Backend CP module: module key, display label, readiness status, source mode, route-boundary category, DEV-gate posture, production-disabled posture, read-only posture, mutation posture (none), test-coverage posture, DTO/schema posture, UI-preview posture, data-source class, redaction posture, RBAC/visibility posture, implementation status, evidence status, and empty-state reason. It must **not** show: raw file contents; raw route internals beyond a safe route category/label; raw permission keys; raw auth claims; raw identifiers; tenant/store/customer rows; identity_link rows; audit_event rows; secrets; tokens; DB URLs; emails; domains; row dumps; stack traces; raw errors.

## 7. Proposed DTO / Schema Readiness (design only — not implemented)

Proposed schema: `bcp.c02.registry-readiness.v1-code-config` (with `bcp.c02.registry-readiness.v0-synthetic` for any synthetic/default path).

| Field | Type/Classification |
|---|---|
| `schemaVersion` | safe label (bounded version string) |
| `sourceMode` | enum (`code_config` / `synthetic`) |
| `generatedAt` | synthetic/dev timestamp policy — fixed synthetic value or bounded label (no wall-clock identity) |
| `freshness.lastSuccessfulReadLabel` | safe label (`code-config-no-live-read`) |
| `summaryCounts` | bounded counts (total / included / placeholder / deferred / blocked) |
| `registryItems[]` | bounded array of items (see below) |
| `registryItems[].moduleKey` | safe label (bounded; from `MODULES.id`) |
| `registryItems[].label` | safe label (from `MODULES.name`) |
| `registryItems[].readinessStatus` | enum (`included`/`placeholder`/`deferred`/`blocked`) |
| `registryItems[].routeBoundaryCategory` | enum (safe category, not raw path) |
| `registryItems[].devGatePosture` | enum/boolean |
| `registryItems[].productionPosture` | enum (`production_disabled`) |
| `registryItems[].readOnlyPosture` | boolean (true) |
| `registryItems[].mutationPosture` | enum (`none`) |
| `registryItems[].testCoveragePosture` | enum |
| `registryItems[].dtoSchemaPosture` | enum |
| `registryItems[].uiPreviewPosture` | enum |
| `registryItems[].dataSourceClass` | enum (`code_config`) |
| `registryItems[].redactionPosture` | enum |
| `registryItems[].rbacVisibilityPosture` | enum |
| `registryItems[].implementationStatus` | enum |
| `registryItems[].evidenceStatus` | enum |
| `emptyState` | `{ isEmpty: boolean, reason: safe label }` |
| `warnings[]` | bounded array of safe labels |
| `redactionPosture` | enum |
| `routePosture` | enum |
| `productionPosture` | enum |
| `mutationPosture` | enum (`none`) |
| `evidenceLabels[]` | bounded array of safe labels |

No raw IDs and no raw paths, except a deliberately-exposed DEV route **label** classified as safe (e.g., the category, not the full internal path). Prefer bounded labels/categories over raw implementation details throughout.

## 8. SourceMode and Freshness Readiness

Honest language, mirroring C-01: `sourceMode: code_config` for the code/config registry path (and `synthetic` only for any synthetic/default path); freshness `code-config-no-live-read` (or `synthetic-no-live-read`). `generatedAt` uses a fixed synthetic/dev value or a bounded label — never a value that could correlate identity or environment. These labels truthfully state that the lens performed **no live read**.

## 9. Redaction / Masking Readiness

| Item | Disposition |
|---|---|
| raw IDs, internal_user_id, provider UIDs | **Blocked** |
| auth claims, identity_link rows, audit rows | **Blocked** |
| permission keys, entitlement keys, mismatch lists | **Blocked** (unless a future, separate classification proves a specific value is a safe bounded label) |
| secrets, tokens, DB URLs | **Blocked** |
| emails, domains, payment identifiers | **Blocked** |
| tenant/store/customer rows, row dumps | **Blocked** |
| stack traces, raw errors | **Blocked** (safe error categories only) |
| source filenames | **Redacted / not exposed** — use module keys, not file paths |
| route paths | **Bounded label only** — expose a safe route-boundary *category*, not raw internal routing details |
| feature flag names | **Allowed as bounded label** (config key names, not values) — but prefer a posture enum over the literal name where possible |

Rule: anything not clearly a safe bounded operational label is **blocked or redacted** (reuse C-01's `safeLabel` allow-list + denylist + id-shape + whitespace guards and a `redacted_label`-style sentinel).

## 10. RBAC / Visibility Readiness

System Owner only by default; no tenant user access; no customer-facing access; no normal SaaS navigation exposure; Backend CP DEV area only; DEV flag gate required; server-side authorization guard (`authorizeBcpRead`) required before any success; no reliance on client-supplied identity authority; no production expansion without separate Phase 4 hardening.

## 11. Route / API Boundary Readiness

A future C-02 route may follow the C-01 pattern (label only, **not** implemented): e.g., `/dev/bcp/registry-readiness`. Requirements: isolated identity API only; DEV-only; default-off (a dedicated C-02 flag); production-disabled; GET-only success; HEAD/OPTIONS safe; POST/PUT/PATCH/DELETE blocked (405); server-side authz guard required; parity/blocked handling if applicable; safe error categories; no raw thrown errors; no DB/Supabase/provider access.

## 12. Client / UI Readiness (design only)

Future client mirrors `bcpC01Client.ts`: GET-only; no body; `credentials: 'omit'`; no Authorization; no UID/email/tenant/store/identity fields; same-origin dev proxy; no production endpoint; no auto-fetch; version-agnostic parser; `safeLabel` redaction; `redacted_label` sentinel. Future UI mirrors `C01ReadinessCard.tsx`: a DEV-gated, button-triggered, read-only card under the Backend CP Readiness Gate; safe labels only; no destructive controls; no nav/customer-facing exposure.

## 13. Test Readiness

Required before implementation (mirroring C-01 suites): config/read-model tests; route boundary tests; Express adapter tests; client parser tests; unsafe-payload tests; redaction tests; no-mutation tests; production-disabled tests; feature-disabled tests; authorization-denied tests; unknown-schema compatibility tests; empty-state tests; no-DB/Supabase-access tests; no-raw-IDs/secrets tests; typecheck touched-file checks (0 new errors).

## 14. Data Classification Confirmation

C-02 (Candidate A) remains **code/config-only and no-DB** unless separately authorized later. Confirmed by static scan: no `createClient`/`@supabase`/`getDb`/`process.env.DATABASE|SUPABASE` in the in-scope sources. The only sensitive-shaped data nearby (synthetic mock tenant/store/audit/database rows in `mockData.ts`/`types.ts`) is explicitly excluded from the C-02 source set.

## 15. Stop Conditions

Block implementation planning / implementation if: DB/Supabase access appears without a separately approved source inventory; raw IDs/secrets exposed; tenant/customer/audit rows exposed (including the synthetic mock rows); production/nav/customer-facing exposure; mutation capability or backend actions; auth/cutover implication; route registration changed unexpectedly; test failure; typecheck touched-file errors; incomplete source classification; incomplete redaction rules; undefined RBAC/visibility.

## 16. Explicit Non-Readiness Statements

- C-02 is **not** implemented.
- C-02 source inventory does **not** authorize implementation.
- Backend CP is **not** production-ready.
- Supabase auth is **not** enabled.
- Firebase-to-Supabase cutover is **not** approved.
- Live session authorization is **not** enabled.
- DB/Supabase live reads are **not** implemented.
- Backend actions are **not** implemented.
- Mutation capability is **not** implemented.
- Phase 3 controlled actions are **not** started.
- Phase 4 production hardening is **not** started.

## 17. Recommended Next Milestone

**Phase 2.0 M8B — C-02 Implementation Plan and Safety Contract** (design the implementation steps + binding safety contract; still no implementation). *(Procedural step first: Phase 2.0 M8A — Scoped Commit and Backup Authorization for this review document.)*

## 18. Acceptance Criteria for M8A

- One docs file only; no code/test/runtime changes; no DB/Supabase/live access; no C-02 implementation.
- Source inventory complete; safe source set defined; schema readiness defined; redaction rules defined; RBAC/visibility readiness defined; route/API readiness defined; test readiness defined; next milestone recommended.

All criteria are met.

---

*Documentation/review only. No code, tests, UI, route, DTO, or backend behavior was changed; C-02 was not implemented. No DB connection, SQL, migration, Supabase access, Supabase MCP, live provider, or production call occurred; no commit/push/backup was performed. This document does not implement C-02, does not modify route behavior, does not claim C-02 is implemented, does not claim live session auth or Supabase auth is enabled, does not claim the Backend Control Panel is production-ready, does not authorize production deployment, and does not claim Supabase is ready for a Firebase cutover. No real tenant/store/customer data, raw IDs, internal_user_id, provider UIDs, raw auth claims, identity_link rows, audit rows, permission/entitlement key lists, mismatch lists, secrets, tokens, DB URLs, emails, domains, or payment identifiers appear herein; the module keys/labels referenced are static synthetic registry labels, not live data.*
