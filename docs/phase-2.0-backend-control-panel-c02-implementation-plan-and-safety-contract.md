# Phase 2.0 M8B — C-02 Implementation Plan and Safety Contract (Backend Control Panel)

**Status:** Documentation / planning only. No code, tests, UI, route, DTO, or backend behavior was changed. This milestone defines, for the selected **Candidate A — Backend CP Route / Module Registry Readiness Lens**, a precise future implementation plan and a binding safety contract: phasing, file boundaries, feature-flag contract, source contract, DTO/schema contract, route/API contract, client/UI contract, RBAC/visibility contract, redaction contract, test/static-scan/manual-QA contracts, and stop conditions. It does **not** implement C-02 and does **not** authorize implementation.

**Accepted checkpoint:** `3daf188d5fdf76d05a55ab33bd69a342006731cf`
**Most recent committed milestone:** Phase 2.0 M8A — C-02 source inventory and schema readiness review.

> **Planning-only framing.** Every route path, flag name, file path, schema version, field, enum value, and label in this document is a **proposal for future work**, not an implemented artifact. Wherever this document names a future route, flag, or file, read it as "the future implementation should use …", never as "this exists." C-02 remains unimplemented.

---

## 1. Executive Summary

The future C-02 implementation plan is **safe, phased, and complete enough to request the first backend-only implementation milestone**. C-02 (Candidate A) will be a DEV-only, default-off, production-disabled, read-only, **code/config-only** registry readiness lens that summarizes bounded posture metadata for the Backend CP module registry — reusing the exact, frozen C-01 pattern (read model → envelope/DTO → authorization guard → pure route handler → Express adapter → hardened client → preview card → test suites). The plan sequences implementation **backend-first** (read model and DTO → inert route boundary → isolated registration → client/UI → QA), so no route is reachable and no UI is exposed until each prior safety layer is tested and accepted. A binding safety contract fixes the environment, source, DTO, sourceMode/freshness, route/API, client/UI, RBAC/visibility, redaction, test, and static-scan obligations, plus the stop conditions that block implementation. The selected source set is code/config/static only, with **no DB / Supabase / provider / live dependency** (M8A static scan confirmed no `createClient` / `@supabase` / `getDb` / `process.env.DATABASE` / `SUPABASE` usage in the in-scope sources). Decision: **Decision A — PASS: C-02 implementation plan and safety contract complete; ready to request M8C backend read model implementation.** Recommended next milestone: **Phase 2.0 M8C — C-02 Backend Read Model and DTO Contract Implementation** (procedural step first: **Phase 2.0 M8B — Scoped Commit and Backup Authorization** for this planning document).

## 2. C-01 Freeze / M8 / M8A Context

- **C-01 freeze (M7QC).** C-01 is frozen as the Phase 2.0 **DEV QA baseline** — not production-ready, not a C-02 authorization. Frozen scope: DEV-only; default-off (`ENABLE_BCP_DEV_READONLY_PILOT`); production-disabled; isolated in the Backend CP DEV area; read-only; GET-only success (`/dev/bcp/readiness-summary` via proxy `/__identity/...`); code/config posture only; v1 code/config DTO with v0 synthetic compatibility; hardened client parser; safe labels only; no DB/Supabase/provider/live source; no backend actions; no mutation; no production exposure; 106/106 tests; 0 C-01 touched-file type errors. Owner explicitly accepted M7QB automated / transport / code evidence in place of owner pixel-level visual evidence, for the DEV QA baseline freeze only.
- **M8 candidate selection.** M8 selected **Candidate A — Backend CP Route / Module Registry Readiness Lens** (Decision A): the safest next slice (same code/config, no-DB risk class as frozen C-01) with new operational value (a registry/map rather than a single readiness summary).
- **M8A source inventory / schema readiness.** M8A completed the source inventory (Decision A): the selected source set is **code/config / static only** with **no DB/Supabase/provider/live access** (static scan clean); C-01 provides a fully reusable pattern; a safe future DTO concept (`bcp.c02.registry-readiness.v1-code-config`) was defined with every field classified as a bounded label / enum / boolean / bounded count; the synthetic tenant/store/audit/database mock rows in `mockData.ts`/`types.ts` were explicitly recorded as **out of scope**.
- **Global constraints (unchanged).** Firebase / legacy AccessContext remains the current frontend/app authority; Supabase remains dormant / shadow / readiness-only and is **not** ready for Firebase cutover; controlled backend actions remain Phase 3; production readiness remains Phase 4; no live session authorization, no backend actions, no mutation capability is enabled.

## 3. Decision

**Decision A — PASS: C-02 IMPLEMENTATION PLAN AND SAFETY CONTRACT COMPLETE; READY TO REQUEST M8C BACKEND READ MODEL IMPLEMENTATION.**

The future implementation plan is safe, phased, and complete enough to request the first backend-only implementation milestone (M8C) later. This decision does **not** authorize C-02 implementation in M8B.

## 4. Future C-02 Implementation Scope

### 4.1 What future C-02 will implement

A DEV-only, default-off, production-disabled, read-only, code/config-only **registry readiness lens** that summarizes safe, bounded metadata for the Backend CP module registry. Future C-02 may summarize, per module and in aggregate, only these bounded fields:

- module key (bounded label, from `MODULES.id`)
- module display label (bounded label, from `MODULES.name`)
- module status / readiness status (enum)
- source mode (enum — `code_config`)
- route boundary category (enum — a safe category, never a raw path)
- DEV gate posture (enum/boolean)
- production-disabled posture (enum)
- read-only posture (boolean)
- mutation posture (enum — `none`)
- test coverage posture (enum)
- DTO/schema posture (enum)
- UI preview posture (enum)
- data source class (enum — `code_config`)
- redaction posture (enum)
- RBAC/visibility posture (enum)
- implementation status (enum)
- evidence status (enum)
- empty-state reason (bounded label)

### 4.2 What future C-02 will explicitly NOT implement

Future C-02 must **never** expose, and must **never** implement: raw file contents; raw route internals beyond bounded route-category labels; raw permission keys (unless a future, separate classification proves a specific value is a safe bounded label); raw auth claims; raw identifiers; tenant rows; store rows; customer rows; identity_link rows; audit_event rows; secrets; tokens; DB URLs; emails; domains; row dumps; stack traces; raw errors; synthetic sensitive mock rows; payment identifiers; provider UIDs; internal_user_id. Future C-02 must **not** implement DB/Supabase/provider/live reads, backend actions, mutation capability, production exposure, normal SaaS navigation exposure, customer-facing exposure, live session authorization, Supabase auth, or any Firebase-to-Supabase cutover step.

## 5. Recommended Implementation Phasing

The plan adopts the milestone-provided sequence, which is **backend-first** and therefore the safest ordering: each phase ships and is accepted before the next phase makes anything more reachable. No route is registered until the handler is tested in isolation; no UI exists until the route is registered and tested; QA is last. This minimizes blast radius at every step and matches the proven C-01 layering.

| Phase | Milestone | Scope (additive, isolated) | Reachable? | Tests required before accept |
|---|---|---|---|---|
| 1 | **M8C — C-02 Backend Read Model and DTO Contract** | Backend-only; code/config-only; pure read model + DTO/envelope builder; **no route registration**; no frontend UI; no DB/Supabase/provider/live access | No (pure functions; not wired) | read model tests, DTO/envelope tests, unsafe-payload/redaction tests, no-DB/Supabase tests, typecheck touched-file = 0 |
| 2 | **M8D — C-02 Inert DEV Route Boundary** | Pure route handler; DEV-only; default-off; production-disabled; GET-only success; HEAD/OPTIONS safe; mutations blocked (405); authz guard; **no server registration yet** | No (handler exists but not mounted) | route boundary tests, Express adapter tests, no-mutation tests, production-disabled tests, feature-disabled tests, unauthorized tests, typecheck |
| 3 | **M8E — C-02 Isolated Route Registration** | Register the route on the **isolated identity API only**; no normal SaaS app route; no frontend UI yet; no DB/Supabase/provider/live access | Yes (DEV-only, default-off, isolated API) | registration/integration tests, transport evidence, no-DB tests, typecheck |
| 4 | **M8F — C-02 Client Parser and UI Preview Card** | Frontend client (GET-only, no auto-fetch); button-triggered card under the Backend CP Readiness Gate; no credentials/auth/body/identity fields; safe labels only; no normal SaaS navigation exposure | Yes (DEV shell only) | client parser tests, unsafe payload/redaction tests, unknown-schema tests, no-nav-exposure tests, typecheck |
| 5 | **M8G — C-02 QA / Exposure Review** | Documentation / review-only; confirm safety; decide whether to freeze C-02 as a DEV QA baseline later | n/a | none (review) |

**No alternative sequence is recommended** — the milestone-provided backend-first ordering is already the conservative one (read model before route, route before registration, registration before UI, QA last). Any deviation that exposed a route or UI earlier would increase risk and is rejected.

## 6. Allowed Future File Boundary

### 6.1 Files that may be CREATED later (each in its own scoped milestone)

| File | Created in | Mirrors (C-01 analog) |
|---|---|---|
| `server/bcp-pilot/bcpC02RegistryReadModel.ts` | M8C | `bcpC01CodeConfigReadModel.ts` |
| `server/bcp-pilot/bcpC02RegistryReadModel.test.ts` | M8C | `bcpC01CodeConfigReadModel.test.ts` |
| *(DTO/envelope builder — either folded into the read model file above, or a sibling)* `server/bcp-pilot/bcpC02RegistryReadinessEnvelope.ts` (+ `.test.ts`) | M8C | `bcpReadinessSummaryHarness.ts` |
| `server/bcp-pilot/bcpC02ReadOnlyRoute.ts` | M8D | `bcpReadOnlyRoute.ts` |
| `server/bcp-pilot/bcpC02ReadOnlyRoute.test.ts` | M8D | `bcpReadOnlyRoute.test.ts` |
| `server/bcp-pilot/bcpC02ReadOnlyExpressAdapter.ts` | M8D | `bcpReadOnlyExpressAdapter.ts` |
| `server/bcp-pilot/bcpC02ReadOnlyExpressAdapter.test.ts` | M8D | `bcpReadOnlyExpressAdapter.test.ts` |
| *(C-02 flag config — either folded into the read model/adapter, or)* `server/bcp-pilot/bcpC02PilotConfig.ts` (+ `.test.ts`) | M8C or M8D | `bcpPilotConfig.ts` |
| `src/backend-control-plane/bcpC02Client.ts` | M8F | `bcpC01Client.ts` |
| `src/backend-control-plane/bcpC02Client.test.ts` | M8F | `bcpC01Client.test.ts` |
| `src/backend-control-plane/C02RegistryReadinessCard.tsx` | M8F | `C01ReadinessCard.tsx` |

The authorization guard (`server/bcp-pilot/bcpAuthorizationGuard.ts`, `authorizeBcpRead`) is **directly reusable**; C-02 should import and reuse it rather than fork it. If reuse requires no change, the guard file is **not** modified.

### 6.2 Files that may be MODIFIED later, only in their specific phase

| File | May be modified in | Reason | Constraint |
|---|---|---|---|
| `server/platform-identity/server.ts` | **M8E only** (isolated route registration) | Register the inert C-02 route on the isolated identity API | Add only an isolated, DEV-only, default-off `app.all(...)` registration mirroring the C-01 line; no DB call at construction; no other change |
| `src/backend-control-plane/screens.tsx` | **M8F only** (UI integration) | Mount the C-02 preview card under the Backend CP Readiness Gate | Additive, DEV-gated, button-triggered; no auto-fetch; no nav exposure |

No other file may be modified. In particular, `src/App.tsx` is **read-only context** (the DEV shell route gate) and must **not** be modified by C-02; the shell route gating already in place is sufficient.

### 6.3 Files that must stay UNTOUCHED unless separately authorized

`src/**` (except the new `src/backend-control-plane/bcpC02*` client/UI files created in M8F per §6.1, and the M8F additive edit to `src/backend-control-plane/screens.tsx` per §6.2 — all other existing `src` files, including `src/App.tsx`, stay untouched), `server/**` (except the new `server/bcp-pilot/bcpC02*` files created in M8C/M8D per §6.1 and the M8E `server/platform-identity/server.ts` registration per §6.2), `shared/**`, package files, migrations, seeds, `.replit`, `.gitattributes`, `dist/**`, auth files, App routing (`src/App.tsx`), main SaaS navigation, frontend routes, M20 identity-link files, audit writer, identity repository, `sessionResolve`, and all C-01 files (C-02 reuses C-01 patterns by writing new files, never by editing C-01).

## 7. Environment / Feature Flag Contract

- **Future backend flag:** `ENABLE_BCP_DEV_C02_REGISTRY_READINESS` — default-off; production-disabled; DEV-only. Mirrors `ENABLE_BCP_DEV_READONLY_PILOT`: a dedicated helper (e.g. `isBcpDevC02RegistryReadinessEnabled()`) reads the flag; the route returns a safe feature-disabled response when off.
- **Future frontend behavior:** the C-02 card remains behind the existing `VITE_ENABLE_BACKEND_CONTROL_PLANE` flag **and** the Backend CP DEV shell gate (Vite DEV + flag → `BCP_ROUTE_ENABLED = IS_DEV && BCP_FLAG_ON`). No new always-on frontend exposure is introduced. C-02 adds **no** production flag and **no** customer-facing flag.
- **Environment contract:** DEV-only; default-off; production-disabled; isolated identity API; Backend CP DEV area only; no production/deployed route; no live session authorization; no Supabase auth.

## 8. Source Contract

**Allowed (code/config / static data inputs):**

- `MODULES` registry — `id` / `name` / `status` (`src/backend-control-plane/mockData.ts`)
- `BcpModule` / `ModuleStatus` types (`src/backend-control-plane/types.ts`)
- `bcpEnv` gates/flags (`src/backend-control-plane/bcpEnv.ts`)
- static route-path constants (server-side)
- flag helpers
- posture categories
- backend posture metadata

**Pattern-only (reuse the shape; write new C-02 equivalents — do not edit the C-01 originals):**

- C-01 read model (`bcpC01CodeConfigReadModel.ts`)
- C-01 harness / envelope builder (`bcpReadinessSummaryHarness.ts`)
- C-01 authorization guard (`bcpAuthorizationGuard.ts`, `authorizeBcpRead` — directly reusable)
- C-01 route (`bcpReadOnlyRoute.ts`)
- C-01 Express adapter (`bcpReadOnlyExpressAdapter.ts`)
- C-01 client (`bcpC01Client.ts`, incl. `safeLabel`)
- C-01 UI card (`C01ReadinessCard.tsx`)
- C-01 tests (all `*.test.ts`)

**Blocked (must never be a C-02 source or output):**

- `TenantRow`, `StoreRow`, `AuditRow`, `DatabaseRow`, `PermissionRow`, and any row-shaped mock data
- DB rows, Supabase rows, `audit_event` rows, `identity_link` rows
- auth claims, provider UIDs, `internal_user_id`
- secrets, tokens, DB URLs
- emails, domains, payment identifiers
- tenant / store / customer data

The synthetic tenant/store/audit/database mock arrays and their types are physically present in `mockData.ts` / `types.ts` but are **structurally excluded** from the C-02 source set; the read model must read only the `MODULES` registry and bounded posture metadata.

## 9. DTO / Schema Contract

Future schema version (code/config path): **`bcp.c02.registry-readiness.v1-code-config`**. Optional synthetic/default path: **`bcp.c02.registry-readiness.v0-synthetic`**. The DTO is additive and version-aware; parsing is shape-based so unknown schema versions degrade safely (mirroring C-01).

| Property | Type category | Allowed values | Safety classification | Redaction behavior | Test requirement |
|---|---|---|---|---|---|
| `schemaVersion` | bounded version string | `bcp.c02.registry-readiness.v1-code-config` / `…v0-synthetic` | safe label | unknown → handled, never raw-echoed | version + unknown-schema tests |
| `sourceMode` | enum | `code_config` / `synthetic` | safe enum | unsafe → `redacted_label` sentinel | sourceMode precedence/fallback tests |
| `generatedAt` | timestamp policy | fixed synthetic/dev value or bounded label | safe (no wall-clock identity) | never a value correlating identity/env | fixed-value test |
| `freshness` (`lastSuccessfulReadLabel`) | bounded label | `code-config-no-live-read` / `synthetic-no-live-read` | safe label | unsafe → sentinel | freshness honesty test |
| `summaryCounts` | bounded counts | total / included / placeholder / deferred / blocked | safe (bounded integers, no values) | n/a (counts only) | count-bounds test |
| `registryItems[]` | bounded array | items per §4.1 | safe (each field classified) | per-field (below) | per-field tests + bounded-length test |
| `registryItems[].moduleKey` | bounded label | from `MODULES.id` | safe label | unsafe → `redacted_label` | safeLabel test |
| `registryItems[].label` | bounded label | from `MODULES.name` | safe label | unsafe → `redacted_label` | safeLabel test |
| `registryItems[].readinessStatus` | enum | `included`/`placeholder`/`deferred`/`blocked` | safe enum | unknown → sentinel | enum test |
| `registryItems[].routeBoundaryCategory` | enum | safe category (not raw path) | safe enum | raw path → never emitted | no-raw-path test |
| `registryItems[].devGatePosture` | enum/boolean | bounded | safe | unsafe → sentinel | posture test |
| `registryItems[].productionPosture` | enum | `production_disabled` | safe enum | n/a | posture test |
| `registryItems[].readOnlyPosture` | boolean | `true` | safe | n/a | posture test |
| `registryItems[].mutationPosture` | enum | `none` | safe enum | n/a | no-mutation test |
| `registryItems[].testCoveragePosture` | enum | bounded | safe enum | unknown → sentinel | posture test |
| `registryItems[].dtoSchemaPosture` | enum | bounded | safe enum | unknown → sentinel | posture test |
| `registryItems[].uiPreviewPosture` | enum | bounded | safe enum | unknown → sentinel | posture test |
| `registryItems[].dataSourceClass` | enum | `code_config` | safe enum | n/a | source-class test |
| `registryItems[].redactionPosture` | enum | bounded | safe enum | n/a | posture test |
| `registryItems[].rbacVisibilityPosture` | enum | bounded | safe enum | n/a | posture test |
| `registryItems[].implementationStatus` | enum | bounded | safe enum | unknown → sentinel | posture test |
| `registryItems[].evidenceStatus` | enum | bounded | safe enum | unknown → sentinel | posture test |
| `emptyState` | object | `{ isEmpty: boolean, reason: safe label }` | safe | reason unsafe → sentinel | empty-state test |
| `warnings[]` | bounded array | safe labels (e.g. `code_config` / `synthetic`) | safe labels | unsafe → sentinel | warnings test |
| `redactionPosture` | enum | bounded | safe enum | n/a | posture test |
| `routePosture` | enum | bounded | safe enum | n/a | posture test |
| `productionPosture` | enum | `production_disabled` | safe enum | n/a | posture test |
| `mutationPosture` | enum | `none` | safe enum | n/a | no-mutation test |
| `evidenceLabels[]` | bounded array | safe labels | safe labels | unsafe → sentinel | evidence-label test |

No raw IDs and no raw paths anywhere, except a deliberately-exposed DEV route **label/category** classified as safe. Prefer bounded labels/categories/enums/booleans/counts over raw implementation detail throughout.

## 10. SourceMode / Freshness Contract

Honest language mirroring C-01: `sourceMode: code_config` for the code/config registry path (and `synthetic` only for any synthetic/default path); freshness `code-config-no-live-read` (or `synthetic-no-live-read`). `generatedAt` uses a fixed synthetic/dev value or a bounded label — never a value that could correlate identity or environment. These labels must truthfully state that the lens performed **no live read**. The wording must never imply a live DB/Supabase/provider read, a live session, production data, or freshness the lens cannot honestly claim. Unsafe `sourceMode` values are reduced to a `redacted_label`-style sentinel (mirroring C-01's `deriveSourceMode`).

## 11. Route / API Contract

Future C-02 route label (proposal): **`/dev/bcp/registry-readiness`**. Future frontend proxy label: **`/__identity/dev/bcp/registry-readiness`** (prefix-stripped DEV proxy, mirroring C-01).

- isolated identity API only (registered via `app.all(...)` on the platform-identity app; never the main SaaS server, never the client bundle)
- DEV-only
- default-off (the dedicated C-02 flag, §7)
- production-disabled
- GET-only success
- HEAD/OPTIONS safe (HEAD → 200 no body; OPTIONS → 204)
- POST/PUT/PATCH/DELETE blocked (405 `method_not_allowed`)
- server-side authorization guard required (`authorizeBcpRead`) before any success
- feature-disabled safe response (flag off)
- dev-only safe response (non-DEV)
- unauthorized safe response (guard denies)
- parity/blocked safe response if applicable
- internal error safe response (safe error category only)
- no raw thrown errors; no stack traces
- no DB/Supabase/provider/live access; no `getDb()` at construction; no DB connection from this route

## 12. Client / UI Contract

**Client contract (future `bcpC02Client.ts`):**

- GET-only
- no request body
- `credentials: 'omit'`
- no `Authorization` header
- no UID/email/tenant/store/identity fields
- same DEV proxy style as C-01 (`/__identity/...`)
- no production endpoint
- version-agnostic parser (shape-based)
- unknown schema handled safely
- unsafe values redacted (`safeLabel` allow-list + denylist + id-shape + whitespace guards; `redacted_label` sentinel)
- safe labels only

**UI contract (future `C02RegistryReadinessCard.tsx`, mounted via `screens.tsx`):**

- Backend CP DEV area only, under the Readiness Gate / registry-readiness section
- button-triggered; **no auto-fetch** (no `useEffect`-driven load)
- read-only; no destructive controls
- safe labels only; no raw object rendering; no stack traces
- no normal SaaS navigation exposure
- no customer-facing exposure
- no production exposure

## 13. RBAC / Visibility Contract

- System Owner only by default; no tenant user access; no customer access
- no normal SaaS navigation exposure
- server-side guard (`authorizeBcpRead`) before any success response
- no reliance on client-supplied identity authority (server-derived, mirroring C-01)
- feature flags remain required (backend C-02 flag + frontend `VITE_ENABLE_BACKEND_CONTROL_PLANE` + DEV shell gate)
- Backend CP area isolation remains required
- no production expansion without separate Phase 4 hardening

## 14. Redaction / Masking Contract

Future C-02 must block or redact: raw IDs; `internal_user_id`; provider UIDs; auth claims; `identity_link` rows; audit rows; permission keys (unless separately safe-classified later); entitlement keys; mismatch lists; secrets; tokens; DB URLs; emails; domains; payment identifiers; tenant rows; store rows; customer rows; row dumps; stack traces; raw errors; raw source filenames (use module keys, not file paths); raw route internals (expose a safe route-boundary **category**, not raw routing detail); synthetic sensitive mock rows.

Output is restricted to **bounded labels, enums, booleans, and bounded counts only**. Any value failing the safe-label rules becomes a neutral sentinel (`redacted_label`), never the raw value. Feature-flag names may appear as bounded config-key labels (names, not values), but a posture enum is preferred over the literal name where possible.

## 15. Test Contract

Required tests, mapped to the phase that must add them before acceptance (mirroring the C-01 suites; all use the self-contained `node:assert/strict` + `npx tsx` pattern):

- **M8C (read model + DTO):** read model tests; DTO/envelope tests; unsafe-payload tests; redaction tests; unknown-schema tests; empty-state tests; no-DB/Supabase/provider tests; no-raw-IDs/secrets tests; typecheck touched-file checks (0 new errors).
- **M8D (route boundary + adapter):** route boundary tests; Express adapter tests; no-mutation tests; production-disabled tests; feature-disabled tests; unauthorized tests; safe-error-category tests; typecheck.
- **M8E (registration):** isolated-registration / transport tests; no-DB/Supabase/provider tests; (no normal SaaS nav exposure — registration is on the isolated API only); typecheck.
- **M8F (client + UI):** client parser tests; unsafe payload tests; redaction tests; unknown-schema tests; no-auto-fetch / button-triggered tests where testable; no-normal-SaaS-nav-exposure tests; typecheck.

Every implementation phase must achieve a green run of its new tests **and** keep the existing 106/106 C-01 suite passing, with 0 touched-file type errors, before it is accept-ready.

## 16. Static Scan Contract

Each implementation phase must pass these static scans over the C-02 in-scope files before acceptance:

- no `createClient`
- no `@supabase`
- no `getDb`
- no `process.env.DATABASE`
- no `SUPABASE`
- no POST/PUT/PATCH/DELETE success path (mutation methods reach 405 only)
- no `identity_link` / audit row exposure
- no raw secret / token / DB URL patterns
- no normal SaaS navigation exposure (no C-02 entry from SaaS/POS/repairs/customer/invoice/service/store-dashboard navigation)
- no customer-facing exposure
- no production exposure (no production route, no production flag)

## 17. Manual QA Contract

Future owner manual QA (per the C-01 precedent) should cover, in a DEV browser with the C-02 flag on: DEV shell opens; the C-02 registry-readiness card is visible under the Readiness Gate; idle state safe before load (no auto-fetch, no data, no destructive controls); load button is the only action; API-unavailable state safe (no stack trace / raw error / hostname / token / DB URL / data); feature-disabled state safe; success state shows bounded labels only (none of the forbidden data classes; no action/mutation controls); read-only / no-mutation behavior; navigation isolation (no SaaS/POS/customer link to C-02; DEV area only); data boundary (all labels pass `safeLabel`). Per the C-01 precedent, owner pixel-level visual evidence is captured **or** the owner explicitly accepts the automated / transport / code evidence in its place; no visual observation may be invented.

## 18. Stop Conditions

Future implementation is **blocked** (stop and report before proceeding) if any of the following appears: DB/Supabase/provider/live access; raw IDs or secrets exposed; tenant/store/customer rows exposed; synthetic sensitive mock rows used; production route exposure; normal SaaS navigation exposure; customer-facing exposure; mutation capability; backend actions; auth/cutover implication; route registration changed outside the isolated identity API; tests fail; typecheck has touched-file errors; redaction contract incomplete; RBAC/visibility undefined; sourceMode/freshness dishonest; DTO contains raw data; UI auto-fetches without explicit action; destructive controls appear.

## 19. Explicit Non-Readiness Statements

- C-02 is **not** implemented.
- M8B does **not** authorize C-02 implementation.
- Backend CP is **not** production-ready.
- Supabase auth is **not** enabled.
- Firebase-to-Supabase cutover is **not** approved.
- Live session authorization is **not** enabled.
- DB/Supabase live reads are **not** implemented.
- Backend actions are **not** implemented.
- Mutation capability is **not** implemented.
- Phase 3 controlled actions are **not** started.
- Phase 4 production hardening is **not** started.

## 20. Recommended Next Milestone

**Phase 2.0 M8C — C-02 Backend Read Model and DTO Contract Implementation** (backend-only; code/config-only; pure read model + DTO/envelope builder + tests; no route registration; no UI; no DB/Supabase/provider/live access). *(Procedural step first: Phase 2.0 M8B — Scoped Commit and Backup Authorization for this planning document.)*

## 21. Acceptance Criteria for M8B

- one docs file only ✓
- no code changes ✓
- no tests modified ✓
- no runtime changes ✓
- no DB/Supabase/live access ✓
- no C-02 implementation ✓
- implementation phasing defined ✓ (§5)
- file boundaries defined ✓ (§6)
- feature flag contract defined ✓ (§7)
- source contract defined ✓ (§8)
- DTO/schema contract defined ✓ (§9)
- route/API contract defined ✓ (§11)
- client/UI contract defined ✓ (§12)
- RBAC/visibility contract defined ✓ (§13)
- redaction contract defined ✓ (§14)
- test/static scan/manual QA contracts defined ✓ (§15–§17)
- stop conditions defined ✓ (§18)
- next milestone recommended ✓ (§20)

All criteria are met.

---

*Documentation/planning only. No code, tests, UI, route, DTO, or backend behavior was changed; C-02 was not implemented. No DB connection, SQL, migration, Supabase access, Supabase MCP, live provider, or production call occurred; no commit/push/backup was performed. This document does not implement C-02, does not modify route behavior, does not authorize C-02 implementation (it only recommends a future implementation milestone), does not claim C-02 is implemented, does not claim live session auth or Supabase auth is enabled, does not claim the Backend Control Panel is production-ready, does not authorize production deployment, and does not claim Supabase is ready for a Firebase cutover. Every route path, flag name, file path, schema version, field, and label herein is a proposal for future work, not an implemented artifact. No real tenant/store/customer data, raw IDs, internal_user_id, provider UIDs, raw auth claims, identity_link rows, audit rows, permission/entitlement key lists, mismatch lists, secrets, tokens, DB URLs, emails, domains, or payment identifiers appear herein; the module keys/labels referenced are static synthetic registry labels, not live data.*
