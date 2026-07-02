# Phase 2.0 — Backend Control Panel — M34 — C-07 Route / Adapter Planning Gate

**Status:** Docs-only planning gate. No source, test, route, adapter, registration, client, UI, package, migration, DB, Supabase, auth, or runtime change was made during M34.
**Accepted checkpoint at gate open:** `e133d518408c39a9c71f16619312b95dd8789a04`
**Most recent committed milestone:** `Phase 2.0 M33 add backend control panel C07 core provider read model`
**This document is the ONLY artifact M34 may create.** It decides the smallest safe next route/adapter package and locks its stop conditions **before** any gated surface is touched. It implements nothing.

---

## 1. Executive Summary

M34 evaluates whether the C-07 Data Source Boundary Readiness lens should next receive a route handler and Express adapter, and — if so — locks the exact safe file package, contracts, test matrix, and stop conditions.

**Decision: A — C-07 route / adapter plan LOCKED; proceed to isolated route / adapter implementation (M35).** The M33 core (provider + read-model) is committed, backed up, pure, deterministic, and fully green (84/84). The frozen C-02…C-06 route/adapter/registration pattern is precise and directly reusable, leaving no design ambiguity. The smallest safe next step is a **four-file isolated route + adapter + their tests**, with **no server mount, no route-registration test, no guard change, and no frozen-surface touch**.

**Pivotal M34 finding (drives the split):** the authorization guard `bcpAuthorizationGuard.ts` maps `CONTRACT_MIN_VISIBILITY` for **C-01…C-06 only — there is no `C-07` entry** — and `authorizeBcpRead` returns `deny('unknown_contract')` for any unmapped contract id. A C-07 route built to the frozen pattern (which pins the contract id server-side and calls the guard) is therefore fully implementable in isolation, and **every gate path except the guard-gated `200` success path is testable in M35** — because it **fail-closes to `403 not_authorized` (`unknown_contract`) on authorized GET/HEAD** until an **additive** `'C-07': 'overview_viewer'` guard entry lands. (The success *wiring* is written in M35 but is only exercisable once that guard entry lands — it is not testable through the frozen route contract in M35.) Per Section H, that guard edit is a **stop condition** and must be a **separate, explicitly-authorized authorization gate** — it is NOT bundled into M35. Consequently the route/adapter's **`200` success-envelope path is deferred** to that later gate. This is the primary accepted residual for M35 and is called out throughout §9, §12, §14, and §30.

No blocker was found. Firebase remains authoritative; Supabase remains dormant/readiness-only; Backend CP remains DEV-only and read-only in Phase 2.0.

---

## 2. Preflight Result (Section A)

All preflight checks **PASS**. Evidence is reported as safe summaries.

| # | Check | Result |
|---|-------|--------|
| 1 | Branch is `main` | PASS — `main` |
| 2 | HEAD == origin/main == `e133d51…` | PASS — both equal `e133d518408c39a9c71f16619312b95dd8789a04` |
| 3 | ahead/behind is 0/0 | PASS — `0  0` |
| 4 | status shows only `.replit` (M) + goose tarball (??) | PASS — ` M .replit` and `?? goose-x86_64-unknown-linux-gnu.tar.bz2` only |
| 5 | Nothing staged | PASS — staged name-list empty |
| 6 | `.gitattributes` absent | PASS — ABSENT |
| 7 | M33 commit present | PASS — `e133d51 Phase 2.0 M33 add backend control panel C07 core provider read model` |
| 8 | HEAD == origin/main ⇒ this IS the pre-change backup checkpoint | PASS — no extra backup created |
| 9 | No source/test/backend/frontend/route/adapter/UI/package/migration/DB/Supabase/auth/runtime change during M34 | PASS — docs-only |
| 10 | No commit/push/backup during M34 | PASS |

**Pre-change checkpoint / backup rule:** HEAD equals origin/main at 0/0, so the accepted checkpoint `e133d51…` is itself the pre-change backup. No extra backup was created.

---

## 3. Files Created

- `docs/phase-2.0-backend-control-panel-m34-c07-route-adapter-planning-gate.md` (this file) — the only artifact.

## 4. Files Modified

- None.

## 5. Files Confirmed Untouched

All source, test, frontend, backend, client, provider, read-model, route, adapter, registration, and UI files; `server/platform-identity/server.ts`; `server/bcp-pilot/bcpAuthorizationGuard.ts`; `server/bcp-pilot/bcpTransportMatrix.test.ts`; `src/backend-control-plane/screens.tsx`; `src/App.tsx`; SaaS navigation; `package.json`; `package-lock.json`; migrations; seeds; `shared/**`; auth/audit-writer/identity-repository/sessionResolve; DB/Supabase files; browser tooling. `.replit` remains unstaged and untouched; the goose tarball remains untracked; `.gitattributes` remains absent.

---

## 6. M33 Backup and Core Baseline Review (Section B)

| # | Item | Result |
|---|------|--------|
| 1 | M33 commit hash | `e133d518408c39a9c71f16619312b95dd8789a04` |
| 2 | M33 commit subject | `Phase 2.0 M33 add backend control panel C07 core provider read model` |
| 3 | origin/main matches local HEAD | Yes (0/0) |
| 4 | Push was fast-forward, non-force | Yes (prior milestone; HEAD==origin/main confirms it landed) |
| 5 | Exactly four M33 files committed | Yes — provider, provider.test, read-model, read-model.test |
| 6 | No docs file committed in M33 | Yes (no M33 doc exists; `docs/` shows only M31, M32 for the m3x range) |
| 7 | No existing file modified | Yes |
| 8–13 | No route / adapter / registration / client / UI card / screen integration created | Yes — `server/bcp-pilot` contains only the 4 `bcpC07DataSourceBoundary*` core files for C-07 |
| 14 | No `server/platform-identity/server.ts` change | Yes |
| 15 | No `bcpAuthorizationGuard.ts` change | Yes (still C-01…C-06 only) |
| 16 | No `bcpTransportMatrix.test.ts` change | Yes (106/106, unmodified) |
| 17 | No package/lockfile change | Yes |
| 18 | No DB/Supabase/live provider access | Yes |
| 19 | New C-07 tests | 84/84 (provider 43/43 + read-model 41/41) |
| 20 | Full BCP corpus | 1181/1181 across 38 test files |
| 21 | Typecheck | 12 unrelated baseline errors; 0 BCP-surface errors |
| 22 | Static scan | Clean (0 forbidden-surface tokens in C-07 core) |
| 23 | M33 residuals accepted | Yes |

**M33 backup conclusion:** the C-07 core baseline is safely committed and backed up at the accepted checkpoint. It is sufficient to plan a route/adapter wrapper.

---

## 7. C-07 Core Readiness for Route / Adapter (Section C)

| # | Readiness criterion | Result |
|---|---------------------|--------|
| 1 | Provider pure and deterministic | Yes — 7 hardcoded `code_config` items derived from frozen maps; no I/O |
| 2 | Read-model pure and deterministic | Yes — canonical enums/labels/caps + `buildC07DataSourceBoundaryEnvelope`; fixed ordering |
| 3 | No runtime source access | Yes |
| 4 | No DB/SQL/Supabase/live provider | Yes (static scan: 0 hits) |
| 5 | No runtime env-value reads | Yes |
| 6 | No diagnostics exposed | Yes |
| 7 | No command output exposed | Yes |
| 8 | No inventories exposed | Yes |
| 9 | No production-readiness claim | Yes — `assertBcpC07ProductionReadinessClaimBan` fitness gate |
| 10 | No action/mutation path | Yes |
| 11 | Closed enums | Yes — all sourceMode/posture/label/warning enums are closed unions |
| 12 | Safe fallbacks | Yes — unknown sourceMode → `none`; unknown key → dropped; unknown posture → redacted+retained |
| 13 | Deterministic ordering | Yes — fixed `C07_BOUNDARY_KEYS` order; first-wins dedup |
| 14 | Bounded output | Yes — `C07_MAX_BOUNDARY_ITEMS=7`, `C07_ITEM_CEILING=12`, `C07_MAX_WARNINGS=12`, `C07_MAX_EVIDENCE_LABELS=4`, `C07_SUMMARY_COUNT_FIELDS=16` |
| 15 | Tests sufficient to support route/adapter planning | Yes — 84/84; envelope shape/schema/redaction fully covered at the read-model layer |
| 16 | No route/adapter code needed to change provider/read-model | Yes — a route/adapter only *wraps* the existing pure builder |

**Readiness conclusion:** the M33 core is ready to be wrapped by a route/adapter without any core change. Schema `bcp.c07.data-source-boundary-readiness.v1-code-config`, `selfAttestation = design_time_code_config`, and the permanent exclusion of `generatedAt` are the fixed envelope invariants a route must preserve verbatim.

---

## 8. Route / Adapter Implementation Options (Section D)

| Option | Package | Risk | Verdict |
|--------|---------|------|---------|
| **A** | Route handler + Express adapter + their two tests only; no server mount, no registration test, no guard change | **Low–medium** | **SELECTED** — smallest package that proves the route/adapter transport boundary without touching any frozen surface |
| B | A + `bcpC07RouteRegistration.test.ts` (5th file) | Medium | **Rejected as unsafe next step** — see finding below |
| C | Route/adapter + `server/platform-identity/server.ts` mount | Med–high | Deferred — touches a frozen surface |
| D | Route/adapter + `bcpTransportMatrix.test.ts` extension | Medium | Deferred — touches a frozen surface; matrix extension planned only *after* route/adapter is accepted |
| E | Another docs-only gate | Low | Not needed — planning is now exact (see §9–§14) |

**Why Option B is rejected as the next step (evidence-backed):** the frozen registration-test pattern (`bcpC0xRouteRegistration.test.ts`) does **not** register a route — it *statically reads* `server/platform-identity/server.ts` via `fs.readFileSync` and **asserts the route is already mounted there** (`app.all(BCP_C0x_..._ROUTE_PATH, …)` exactly once) and that the guard already carries the additive contract entry. A C-07 registration test following this pattern therefore **cannot pass unless `server.ts` is first modified to mount C-07 and the guard carries `C-07`** — both frozen surfaces. Option B is thus not achievable in an isolated milestone and is deferred to the later authorization+mount gate (§17).

**Considered alternative — guard-entry micro-gate first (weighed, not selected as the *next* step):** an alternative ordering would land a bare one-line additive `'C-07': 'overview_viewer'` guard entry in its own micro-gate *before* M35, letting M35 then unit-test its own `200` success path. This was weighed and **not** selected because (a) it front-loads a live-but-unconsumed C-07 authorization entry (nothing mounts C-07 yet), (b) the frozen C-06 precedent bundles the guard entry with the `server.ts` mount and registration test in **one** milestone, and (c) the mount/registration half structurally depends on M35's adapter anyway. Decision A (route/adapter first) therefore stays faithful to precedent; it remains defensible **only on the condition** that the subsequent **M36** gate tests the newly-reachable `200` success path atomically with — or before — the `server.ts` mount/exposure (locked in §17).

---

## 9. Route Contract Lock (Section E)

Locks the **future** C-07 route handler contract (to be implemented in M35, not now). Mirrors the frozen C-02…C-06 `bcpC0xReadOnlyRoute.ts` pattern exactly.

- **Route path candidate:** `/dev/bcp/data-source-boundary-readiness` (DEV-only, on the isolated platform-identity API).
- **Pinned contract id:** `'C-07'` — server-side constant; **never** taken from the request.
- **Handler:** `handleBcpC07DataSourceBoundaryRequest(req)` — pure, transport-agnostic, **fail-closed, no-throw** (wrap body in `try { … } catch { safe 500 }`).
- **Request descriptor (authority never from request):** `{ method, isDevEnvironment, featureEnabled, principal, hints?, items? }`, where `items?: readonly C07BoundaryItemInput[]`. `hints` present only so tests can prove they are ignored; `items` are **server-supplied** code_config boundary items (default `[]`), never mapped from untrusted HTTP input. *(Type note: the M33 provider `getBcpC07DataSourceBoundaryItems()` returns `C07BoundaryItem[]`, which is assignable to `readonly C07BoundaryItemInput[]` — every input field is optional/`unknown` — so the M36 provider wiring typechecks cleanly; M35 pins the field to the builder's input type.)*
- **Response:** `{ httpStatus, category, headers?, body }` where `body` is the C-07 envelope, a `{ status, reason? }` safe object, or `null`.

**Locked gate order (identical to C-06):**

| Step | Condition | Result |
|------|-----------|--------|
| 1 | `!isDevEnvironment` | `404` `dev_only` |
| 2 | `!featureEnabled` | `404` `feature_disabled` |
| 3 | `OPTIONS` (DEV+enabled) | `204` `no_content`, header `Allow: GET`, no body |
| 4 | method ∉ {GET, HEAD} | `405` `method_not_allowed`, header `Allow: GET` |
| 5 | guard `authorizeBcpRead({contractId:'C-07', featureEnabled:true, principal, hints})` → `blocked` | `409` `parity_blocked` |
| 5 | guard → not `allow` | `403` `not_authorized` |
| 6 | `HEAD` + allowed | `200` `success`, no body |
| 7 | `GET` + allowed | `200` `success`, body = `buildC07DataSourceBoundaryEnvelope(items ?? [])` |
| — | thrown error | `500` `safe_error`, body `{ status: 'error' }` |

**Binding requirements (1–24 from Section E):** read-only; no DB/SQL/Supabase/Supabase-MCP/live provider; no runtime env values exposed; no request-body/query/header/cookie/client-identity authority; server-sourced authority only; safe success envelope from the existing C-07 read-model; safe disabled/error envelopes per the frozen pattern; no raw errors, stack traces, diagnostics, command output; no production-readiness claim; no action/mutation; no customer-facing exposure; **no route registration and no server mount in M35 unless separately authorized.**

**Pure/injectable posture:** the route handler is a pure function of its request descriptor (no injected provider needed at the handler layer — the adapter supplies `items`). Consistent with C-02…C-06.

> **⚠ Guard-gap carve-out (pivotal):** step 5 calls `authorizeBcpRead` with `contractId:'C-07'`. The current guard has **no `C-07` entry**, so it returns `deny('unknown_contract')` → the route yields `403 not_authorized` on every authorized GET/HEAD. Therefore **the `200` success path (steps 6–7) is UNREACHABLE in M35** and its assertion is deferred to the separate authorization gate (§12, §17). The envelope’s correctness is already independently proven by the M33 read-model tests (41/41); only the route-level success *wiring* is deferred.

---

## 10. Express Adapter Contract Lock (Section F)

Locks the **future** C-07 adapter contract. Mirrors the frozen C-06 `bcpC0xReadOnlyExpressAdapter.ts` exactly.

- **Exports:**
  - `BCP_C07_DATA_SOURCE_BOUNDARY_ROUTE_PATH = '/dev/bcp/data-source-boundary-readiness'`
  - `BCP_C07_DATA_SOURCE_BOUNDARY_PROXY_PATH = '/__identity/dev/bcp/data-source-boundary-readiness'`
  - `BCP_C07_DATA_SOURCE_BOUNDARY_FLAG = 'ENABLE_BCP_DEV_C07_DATA_SOURCE_BOUNDARY_READINESS'`
  - `createBcpC07DataSourceBoundaryReadinessHandler(deps?)`
- **Fixed synthetic principal:** server-derived, obvious placeholder id (`iu_synthetic_dev`), `parityState: 'ready'`, `visibilityClass: 'overview_viewer'`. Wires **no** live session resolver.
- **Injectable deps (all default to safe/default-off):** `isDevEnvironment?` (default `NODE_ENV !== 'production'`), `featureEnabled?` (default `process.env[FLAG] === 'true'` — boolean **gate only**, never surfaced), `getDataSourceBoundaryItems?: () => readonly C07BoundaryItemInput[]` (default **EMPTY** `[]` — no `src/` import, no live read; wired to the M33 provider `getBcpC07DataSourceBoundaryItems`, whose `C07BoundaryItem[]` output is assignable to this input type, only at the separately-authorized registration gate).
- **Gates-first:** items provider resolved **only** when DEV **and** enabled.
- **Express import is type-only** (erased at runtime).
- **Serialization:** set `result.headers`, `res.status(httpStatus)`, `res.end()` for `null` body / `res.json(body)` otherwise; safe `500 { status: 'error' }` at the transport edge if `!res.headersSent`.

**Binding requirements (1–23 from Section F):** wraps the route handler only; no server startup; no socket/listener/port; no outbound network; no child/background process; no filesystem writes; no DB/Supabase/live provider; no package/dependency inventory; handles GET; HEAD bodyless; OPTIONS `204` with `Allow: GET`; mutation methods → `405` `Allow: GET`; production-disabled + flag-disabled behavior; safe `500`; hostile request values ignored; no request-body/query/header/cookie authority; no raw response/header dumps beyond the fixed `Allow` behavior; no diagnostics/stack traces; client is not required to send credentials/auth headers; **no route registration and no server mount unless separately authorized.**

**Exported-but-unmounted:** the adapter factory is **implemented and unit-tested in isolation**; it is **not** wired into `server.ts` in M35.

---

## 11. Feature Flag / DEV-Only Behavior Lock (Section G)

- **Flag:** `ENABLE_BCP_DEV_C07_DATA_SOURCE_BOUNDARY_READINESS`.
- **Behavior:** default-off; DEV-only; production-disabled; flag value never exposed; no runtime flag value returned in the response; no environment value oracle; safe feature-disabled behavior (`404 feature_disabled`); safe production-disabled behavior (`404 dev_only`).
- **Mechanism:** reuse the **established** BCP flag pattern used by C-02…C-06 — a single boolean read `process.env[FLAG] === 'true'` used purely as a **gate**, dependency-injectable so tests need not mutate global env. **No new configuration framework. No package change.**
- **Tests must cover:** flag-off behavior; production-disabled behavior; hostile-input-ignored; and (once the guard entry lands, at the later gate) flag-on success. Static scan must confirm no flag/env value is emitted anywhere in the response.

---

## 12. Authorization / Guard Posture Lock (Section H)

- **`bcpAuthorizationGuard.ts` is reuse-only and MUST NOT be modified in M35.** No new guard system; no live session authorization; no DB/Supabase read for auth; no request-body/query/header/cookie authority; server-sourced authority only.
- **Finding (documented per Section H point 7/8):** the existing pinned-lens guard pattern **does not yet support C-07 for a success result.** `CONTRACT_MIN_VISIBILITY` covers `C-01…C-06`; `authorizeBcpRead` returns `deny('unknown_contract')` for `C-07`. A **success** result requires an **additive** `'C-07': 'overview_viewer'` entry (identical shape to the C-01…C-06 rows — additive, read-only, introduces no write/manage visibility).
- **Per Section H point 8, this guard change is a STOP CONDITION for M35** and is deferred to a **separate, explicitly-authorized authorization gate** (§17, recommended **M36**), which — mirroring the C-06 registration precedent — bundles the additive guard entry with the `server.ts` mount and the registration test. **Any attempt to touch `bcpAuthorizationGuard.ts` inside M35 halts M35.**

---

## 13. Next Implementation File Package Lock (Section I)

**Recommended next milestone: Phase 2.0 M35 — C-07 Route Handler / Express Adapter Implementation.**

**Allowed files (exactly four):**
1. `server/bcp-pilot/bcpC07DataSourceBoundaryReadOnlyRoute.ts`
2. `server/bcp-pilot/bcpC07DataSourceBoundaryReadOnlyRoute.test.ts`
3. `server/bcp-pilot/bcpC07DataSourceBoundaryReadOnlyExpressAdapter.ts`
4. `server/bcp-pilot/bcpC07DataSourceBoundaryReadOnlyExpressAdapter.test.ts`

> **Naming note:** these four filenames are locked verbatim from the M34 authorization and share the `bcpC07DataSourceBoundary` stem established by the M33 core (`bcpC07DataSourceBoundaryProvider.ts` / `…ReadModel.ts`), keeping every C-07 file under one stem. They intentionally use the long-form C-07 stem rather than the shorter `bcpC0NReadOnly*` form of the C-02…C-06 route/adapter siblings; the registration-test name below (`bcpC07RouteRegistration.test.ts`) follows the short-form sibling convention. What the eventual registration wiring imports are the **export symbols** (§10), not the filenames — so the convention split is cosmetic. M35 confirms the exact final filenames at implementation; the owner may normalize either way.

**Prohibited files (must not be created or modified in M35):**
`server/platform-identity/server.ts`; `server/bcp-pilot/bcpAuthorizationGuard.ts`; `server/bcp-pilot/bcpTransportMatrix.test.ts`; `server/bcp-pilot/bcpC07RouteRegistration.test.ts` (Option B not selected); `src/backend-control-plane/bcpC07Client.ts`; `src/backend-control-plane/bcpC07Client.test.ts`; `src/backend-control-plane/C07DataSourceBoundaryReadinessCard.tsx`; `src/backend-control-plane/screens.tsx`; `src/App.tsx`; SaaS navigation; `package.json`; `package-lock.json`; migrations; seeds; `shared/**`; auth/audit/identity/session files; DB/Supabase files; browser tooling; generated artifacts; `.replit`; `.gitattributes`; `goose-x86_64-unknown-linux-gnu.tar.bz2`.

**Import boundary for M35:** the route imports the guard (`authorizeBcpRead`, types) + the C-07 read-model builder/types; the adapter imports the route handler + a type-only `express` import + C-07 item types. Neither is imported by `src/` (the client bundle).

---

## 14. Route / Adapter Test Matrix Lock (Section J)

**Route handler tests (`…ReadOnlyRoute.test.ts`) — reachable in M35 (gate precedence must be asserted explicitly):**
- `dev_only` → `404`; `feature_disabled` → `404` (both run first, before any method/guard check).
- `OPTIONS` (DEV+enabled) → `204` + `Allow: GET`, no body.
- mutation methods (POST/PUT/PATCH/DELETE) → `405` + `Allow: GET`, no side effect.
- **Guard authority-denial matrix — all reachable NOW (these guard checks precede the unknown-contract lookup, so they do not depend on a C-07 entry):** null principal → `403` (`no_server_principal`); hints-only, no principal → `403` (`untrusted_authority_only`, proving hints are never authority); unverified principal → `403` (`unverified_principal`); principal with null `internalUserId` → `403` (`no_internal_user_id`); non-`ready` parity → `409 parity_blocked` (precedence: parity is checked *before* the contract lookup).
- **Guard-gap assertion (current fail-closed default):** a fully-valid `ready` `overview_viewer` principal on `GET`/`HEAD` → `403 not_authorized` (`unknown_contract`) — proves the route fail-closes while the guard lacks C-07.
- **HEAD carries no body** on every branch; **denied requests never build the envelope and never consume `items`** (assert the `items` provider is not read on any non-`allow` path).
- safe `500` envelope; no raw error / diagnostics; no request-body/query/header/cookie authority; no DB/Supabase/live provider; no mutation/action; no production-readiness claim.
- envelope invariants (already proven at the read-model layer; re-asserted at the route once the `200` path is reachable in M36): schema `bcp.c07.data-source-boundary-readiness.v1-code-config`; `generatedAt` excluded; `selfAttestation = design_time_code_config`.

**Express adapter tests (`…ReadOnlyExpressAdapter.test.ts`) — reachable in M35:** with the fixed synthetic (always-`ready`) principal, `GET` currently serializes the fail-closed **`403 not_authorized`** (not `200`) and `HEAD` → `403` bodyless — because the guard lacks C-07; OPTIONS `204` + `Allow: GET`; POST `405`; DELETE `405`; unsupported mutation methods rejected; flag-off / production-disabled behavior (and **the items provider is NOT called on any disabled/production gate** — gates-first); hostile request ignored; safe `500`; no raw body/header dumps beyond the fixed `Allow`; no stack trace/diagnostics; no DB/Supabase/live provider; no server/socket/listener/port; no outbound network; no child/background process; no filesystem artifact. *(The adapter's `409 parity_blocked` branch is not reachable here — the fixed principal is always `parityState: 'ready'`; that branch is covered at the route-handler layer only.)*

**Deferred to the later authorization gate (§17), NOT M35 (guard-gap):** `GET` `200` success-envelope-from-C-07-read-model, `HEAD` `200`, and flag-on success — all require the additive guard `C-07` entry to be reachable. *(This is the single revision M34 makes to the Section J wish-list: the `200` success assertions move to the gate that unlocks them.)*

**Regression (M35 acceptance):** M33 provider/read-model remain green; C-01…C-06 remain green; M27 transport matrix remains 106/106 and unmodified; full BCP corpus remains green.

---

## 15. Static Scan / Typecheck Requirements Lock (Section K)

**Static scans must confirm the M35 package introduces none of:** package/lockfile change; dependency install; browser tooling; server-startup change; sockets/listeners/ports; outbound network I/O; child/background process; filesystem scan/write; DB/Supabase access; SQL; Supabase MCP; live provider calls; production/customer-facing exposure; mutation/action behavior; raw logs/command/transport output; raw response/header dumps; stack-trace/raw-error/diagnostics exposure; package/dependency/version exposure; file-path inventory; process/PID/port/timing exposure; `process.env` enumeration; environment value exposure; value-oracle behavior; production-readiness claims; frozen-source drift outside the four authorized files.

**Typecheck must confirm:** 12 unrelated baseline errors unchanged (do **not** fix them); 0 errors in the four M35 files; 0 errors in the C-07 core files; 0 errors in `server/bcp-pilot`; 0 errors in `src/backend-control-plane`.

---

## 16. Transport / Browser Posture Lock (Section L)

**Transport:** M35 may provide route/adapter unit-level and mock `req`/`res` evidence only. It must **not** claim real-socket evidence; **not** start a server; **not** open socket/listener/port; **not** use outbound network; **not** modify `bcpTransportMatrix.test.ts`. Extending the boundary transport matrix with a C-07 row is planned as a **later gated milestone after route/adapter is accepted**. Real-socket live transport remains **deferred**.

**Browser:** no client/UI in M35; no browser tooling; no package/lockfile change; no browser evidence required. Browser evidence remains **waived for Phase 2.0 only** and **must reopen** before production readiness, Phase 3, Phase 4, or any customer-facing release.

---

## 17. Gated Touchpoints Decision (Section M)

| Gated surface | M35 decision | Future condition to touch it |
|---------------|--------------|------------------------------|
| `server/platform-identity/server.ts` | **Keep gated — do not touch in M35** | A separately-authorized mount gate (recommended **M36**), after M35 route/adapter is accepted |
| `bcpAuthorizationGuard.ts` | **Reuse-only — modification halts M35** | The same separately-authorized authorization gate (**M36**): a single additive `'C-07': 'overview_viewer'` row, read-only, no write/manage visibility |
| `bcpTransportMatrix.test.ts` | **Keep gated — defer matrix extension** | A later gate after route/adapter + mount are accepted |
| `src/backend-control-plane/screens.tsx` | **Keep gated — defer to a future client/UI milestone** | A later, separately-authorized client/UI gate |

**Recommended subsequent gate — Phase 2.0 M36 — C-07 Authorization Entry + Server Mount + Registration** (mirrors the C-06 registration precedent, which bundled the additive guard entry + `server.ts` mount + registration test in one milestone). M36 unlocks the deferred `200` success path from §14. M36 is **not** authorized by M34 — it is recorded here as the planned follow-on.

**M36 will necessarily edit the two M35 test files.** Once the additive guard entry lands, the M35 fail-closed `403 unknown_contract` assertions on authorized `GET`/`HEAD` become invalid and must **flip to the `200` success-envelope (and `HEAD 200`) assertions**. M36 must therefore explicitly allow modifying `…ReadOnlyRoute.test.ts` and `…ReadOnlyExpressAdapter.test.ts`, and must add/prove the `200` success path **atomically with — or before — the `server.ts` mount**, so C-07 is never exposed through the identity API without its success path under test.

---

## 18. Baseline Reconfirmation (Section N)

Reconfirmed live during M34 (safe summaries only):

| Evidence | Expected | Reconfirmed |
|----------|----------|-------------|
| Provider tests | 43/43 | **43/43** |
| Read-model tests | 41/41 | **41/41** |
| New C-07 tests | 84/84 | **84/84** |
| Full BCP corpus | 1181/1181 | **1181/1181** across **38/38** green files |
| M27 boundary transport matrix | 106/106 | **106/106** |
| C-01…C-06 | unchanged & green | included in the 38/38 green corpus |
| Typecheck (total) | 12 baseline | **12** |
| Typecheck (`server/bcp-pilot`) | 0 | **0** |
| Typecheck (`src/backend-control-plane`) | 0 | **0** |
| Typecheck (C-01…C-07 surfaces) | 0 | **0** (BCP-scoped errors = 0) |
| Static scan (C-07 core + M27 harness) | clean | **0 forbidden-surface tokens** (no DB/Supabase/socket/network/fs/child-process/mockData/src import) |

No package/lockfile change, no DB/Supabase/live-provider exposure, no production/customer-facing exposure, and no raw env-value / value-oracle / log-output / diagnostics / package-detail / command-output / raw-evidence / file-path / production-claim surface exists across the C-01…C-07 evidence lenses. No server/socket/network/process/filesystem artifact posture exists in the M27 harness or the M33 core files.

---

## 19. Test Results

Provider 43/43; Read-model 41/41; New C-07 84/84; Full BCP corpus 1181/1181 (38/38 files green); M27 matrix 106/106. All green. Raw test output withheld; counts only.

## 20. Typecheck Result

12 total baseline errors (unrelated, unchanged; not fixed); 0 in the C-07 core files; 0 in `server/bcp-pilot`; 0 in `src/backend-control-plane`; 0 across C-01…C-07 BCP surfaces.

## 21. Static Scan Results

Clean. 0 forbidden-surface tokens in the C-07 core provider/read-model and the M27 transport harness. No DB/Supabase/live-provider/socket/network/filesystem/child-process/env-enumeration/value-oracle/production-claim surface present. Raw scan output withheld; classifications only.

---

## 22. Independent Review Results (Section O)

Section O required at least two independent passes; **three** independent lenses ran (three tool families), each verifying the load-bearing guard-gap claim and the Option B rejection against the actual source. All three returned **PASS WITH NOTES**; no lens returned a blocker. Every valid finding was reconciled **in this document only** — none required a source/test/runtime change (had one, M34 would have stopped and reported a blocker).

| Lens | Scope | Verdict |
|------|-------|---------|
| 1 — Security / exposure | Forbidden-surface avoidance; guard-gap + Option B correctness; no doc leakage | **PASS WITH NOTES** — both load-bearing claims verified technically correct; fail-closed-until-enabled confirmed safety-positive; notes informational |
| 2 — Planning / split-package / test-matrix | Decision soundness; minimality; test-matrix revision; contract locks; internal consistency | **PASS WITH NOTES** — decision defensible; split minimal; `200`-deferral correct; naming + reachable-403 + type-pin refinements |
| 3 — Cross-model planning (independent model) | Guard-gap trace; gate precedence; ordering; forward M36 coupling | **PASS WITH NOTES** — guard-gap trace confirmed; guard-first named as a cleaner alternative; the M36-must-edit-the-M35-tests coupling flagged |

**Findings reconciled into this document (all doc-only):** (a) softened §1 wording — the success *wiring* is implemented in M35 but is not testable through the frozen route contract there; (b) added the guard-first considered-alternative and the Decision-A defensibility condition (§8); (c) expanded the §14 route test matrix with the full guard authority-denial set, gate precedence, HEAD-bodyless, and "denied requests never consume `items`"; (d) clarified that the adapter's `GET` currently serializes `403` (not `200`) and the items provider is not called on disabled/production gates (§14); (e) pinned the `items` / provider-dep input types and noted provider-output assignability (§9/§10); (f) added the M36-must-edit-the-two-M35-test-files coupling with the atomic-with-mount requirement (§17); (g) added the filename-convention note (§13). The pivotal guard-gap finding (§9/§12/§14) originated from this gate's own investigation; all reviewers concurred the plan is conservative and fail-closed, and no unaddressed valid finding remains.

---

## 23. M34 Decision (Section P)

**Decision A — C-07 ROUTE / ADAPTER PLAN LOCKED; PROCEED TO ISOLATED ROUTE / ADAPTER IMPLEMENTATION.**

Justification: the M33 core baseline is safe and green; the route/adapter can be limited to four files; no server mount, route registration, client/UI, transport-matrix extension, guard change, or frozen-surface touch is needed for the M35 package. The one nuance — the `200` success path is guard-gated — does **not** block Decision A: the isolated route/adapter boundary has standalone safety value (it fail-closes correctly until explicitly enabled at the guard), the design is unambiguous, and the guard entry is cleanly a separate subsequent gate (§17).

---

## 24. Next Governed Step Selection (Section Q)

**Candidate 1 — Phase 2.0 M35 — C-07 Route Handler / Express Adapter Implementation** (four files: route, route test, adapter, adapter test). Selected because Decision A is selected.

---

## 25. Recommended Next Milestone

**Phase 2.0 M35 — C-07 Route Handler / Express Adapter Implementation** (isolated, four files, no server mount, no registration test, no guard change), followed later by the separately-authorized **M36 — C-07 Authorization Entry + Server Mount + Registration** gate to unlock the deferred `200` success path.

---

## 26. Allowed Files for Next Milestone (M35)

1. `server/bcp-pilot/bcpC07DataSourceBoundaryReadOnlyRoute.ts`
2. `server/bcp-pilot/bcpC07DataSourceBoundaryReadOnlyRoute.test.ts`
3. `server/bcp-pilot/bcpC07DataSourceBoundaryReadOnlyExpressAdapter.ts`
4. `server/bcp-pilot/bcpC07DataSourceBoundaryReadOnlyExpressAdapter.test.ts`

## 27. Prohibited Files for Next Milestone (M35)

`server/platform-identity/server.ts`; `bcpAuthorizationGuard.ts`; `bcpTransportMatrix.test.ts`; `bcpC07RouteRegistration.test.ts`; all `src/backend-control-plane/*` C-07 client/card files; `screens.tsx`; `src/App.tsx`; SaaS navigation; `package.json`; `package-lock.json`; migrations; seeds; `shared/**`; auth/audit/identity/session files; DB/Supabase files; browser tooling; generated artifacts; `.replit`; `.gitattributes`; `goose-x86_64-unknown-linux-gnu.tar.bz2`.

## 28. Stop Conditions for Next Milestone (M35)

M35 must **STOP and request guidance** if any of these arises:
- Any need to modify `bcpAuthorizationGuard.ts` (e.g., to reach the `200` success path) — that is the separate **M36** gate, not M35.
- Any need to modify `server/platform-identity/server.ts` (mount) or add a registration test.
- Any need to touch `bcpTransportMatrix.test.ts`, `screens.tsx`, `src/App.tsx`, or SaaS nav.
- Any package/lockfile change, dependency install, or new configuration framework.
- Any DB/SQL/Supabase/Supabase-MCP/live-provider/runtime-env-value/command-output/diagnostics/package-inventory/file-path-inventory need.
- Any server startup, socket/listener/port, outbound network, child/background process, or filesystem write.
- Any mutation/action, production/customer-facing exposure, or production-readiness claim.
- Any change to the frozen envelope invariants (schema id, `generatedAt` exclusion, `selfAttestation`).
- More than the four allowed files needing to change.

---

## 29. Non-Readiness Statements (Section R)

Phase 2.0 remains: **not** production readiness; **not** customer-facing release; **not** Phase 3 controlled actions; **not** Phase 4 production readiness; **not** live DB/Supabase reads; **not** live provider reads; **not** Supabase auth enablement; **not** Firebase-to-Supabase cutover; **not** browser-evidence completion for production/customer-facing release. Firebase remains authoritative. Supabase remains dormant/shadow/readiness-only. Backend CP remains DEV-only and read-only in Phase 2.0. **C-07 route/adapter was NOT implemented during M34.**

---

## 30. Risks / Accepted Residuals

1. **Guard-gated `200` success path (primary residual).** The C-07 route fail-closes to `403 unknown_contract` until the additive guard entry lands in M36. *Accepted:* this is a safety-positive default (nothing is served until explicitly enabled at the guard), the envelope is already proven at the read-model layer (41/41), and the success wiring is cleanly deferred to M36. M35 remains a fully-green, four-file, frozen-surface-free package.
2. **12 unrelated baseline typecheck errors.** Pre-existing, outside BCP scope; not fixed by design.
3. **Browser evidence waived** for Phase 2.0; must reopen before production/Phase 3/Phase 4/customer-facing release.
4. **Real-socket live transport deferred**; M35 uses unit + mock `req`/`res` evidence only.
5. **Transport-matrix C-07 row deferred** until after route/adapter + mount are accepted.

---

## 31. Git Status

```
 M .replit
?? docs/phase-2.0-backend-control-panel-m34-c07-route-adapter-planning-gate.md
?? goose-x86_64-unknown-linux-gnu.tar.bz2
```

Matches Section S #30 expectation exactly. `.replit` remains modified+unstaged (untouched by M34); the goose tarball remains untracked; `.gitattributes` remains absent.

## 32. No Commit / Push / Backup Confirmation

M34 performed **no commit, no push, and no backup**. HEAD remains `e133d51…` == origin/main at 0/0. The only working-tree addition is this documentation file.

## 33. Acceptance Recommendation

**Accept M34** and authorize the scoped commit + backup of this single documentation file. The plan is exact, evidence-backed, and conservative; the one design nuance (guard-gated success path) is surfaced honestly and cleanly deferred.

## 34. Recommended Next Step

Upon acceptance: **Phase 2.0 M34 — Scoped Commit and Backup Authorization** (commit only this one doc; fast-forward non-force push; backup). After the M34 backup, proceed to **Phase 2.0 M35 — C-07 Route Handler / Express Adapter Implementation** (four files, isolated), then the separate **M36 — C-07 Authorization Entry + Server Mount + Registration** gate.

**Do not commit. Do not push. Do not run backup. Stop for owner review.**
