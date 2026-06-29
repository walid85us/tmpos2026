# Phase 2.0 — Backend Control Panel — M26 Live Transport Harness Feasibility Planning Gate

- **Milestone:** Phase 2.0 M26 (docs-only feasibility + safety-contract planning gate)
- **Date:** 2026-06-29
- **Accepted checkpoint under review:** `2dd98a9a6996a9d507bf7c2f12a463f4f0731a34`
- **Most recent committed milestone:** *Phase 2.0 M25 freeze backend control panel client sanitizer baseline*
- **Feasibility decision:** **C — Feasible only at the adapter/route boundary → proceed to M27 Boundary Transport Harness Implementation.** The full-identity-API real-socket smoke is **deferred** (accepted residual) until in-sandbox process cleanup is provably safe.
- **Scope rule:** M26 implements nothing. The ONLY artifact produced is this document. No harness, no script, no source/test, no commit/push/backup inside M26.

> **Evidence-reporting rule (binding for this doc):** all command results are recorded as **safe summaries only** (pass/fail counts, high-level classifications). No raw logs, raw command output, raw transport logs, stack traces, file-path inventories, package/dependency inventories, or build/runtime diagnostics are reproduced here.

---

## Decision legend (Section O)

- **A — FEASIBLE: proceed to M27 live transport harness implementation** (full package frozen, exact, low risk).
- **B — PARTIALLY FEASIBLE: proceed to M27 transport harness safety-contract deepening** (promising; package not yet exact enough).
- **C — FEASIBLE ONLY AT ADAPTER/ROUTE BOUNDARY: proceed to M27 boundary harness implementation** (full identity-API harness too risky; boundary harness safe and valuable). **← SELECTED**
- **D — DEFER live transport harness; accept unit coverage for Phase 2.0.**
- **E — BLOCKED** (unsafe exposure / dependency / package change / cleanup blocker / evidence-output blocker).

**Selected: C.** The transport *contract* is already covered in-process by per-lens route + adapter + registration unit tests; the genuine remaining gap is real over-the-socket HTTP, which requires a running server whose in-sandbox cleanup cannot yet be guaranteed. A single consolidated, no-process, mock-`req`/`res` **boundary transport matrix** is exact, low-risk, cleanup-trivial, and adds a unified cross-lens evidence artifact + reusable scaffold; the real-socket smoke is deferred behind a future cleanup-feasibility proof.

---

## Section A — Preflight result

| Check | Expected | Observed | Pass |
|---|---|---|---|
| Branch | `main` | `main` | ✅ |
| HEAD | `2dd98a9` | `2dd98a9` | ✅ |
| origin/main | `2dd98a9` | `2dd98a9` | ✅ |
| ahead / behind | 0 / 0 | 0 / 0 | ✅ |
| `git status --porcelain` | `M .replit` + `?? goose…` only | `M .replit` + `?? goose-x86_64-unknown-linux-gnu.tar.bz2` | ✅ |
| Staged | none | none | ✅ |
| `.gitattributes` | absent | absent | ✅ |
| M25 commit present | yes | yes (`2dd98a9`, correct subject) | ✅ |
| src/server drift since M24 `b62b862` | none | none (`git diff b62b862 HEAD -- src server` empty) | ✅ |

HEAD == origin/main with 0/0 → **pre-change backup checkpoint** confirmed; no extra backup. No source / test / backend / frontend / route / UI / package / migration / DB / Supabase / auth / runtime change occurs during M26; no commit / push / backup occurs during M26. **Preflight: PASS.**

---

## Section B — M25 backup and baseline review

| # | Confirmation | Result |
|---|---|---|
| 1 | M25 commit hash | `2dd98a9a6996a9d507bf7c2f12a463f4f0731a34` |
| 2 | M25 commit subject | *Phase 2.0 M25 freeze backend control panel client sanitizer baseline* |
| 3 | origin/main matches local HEAD | ✅ |
| 4 | Push was fast-forward and non-force | ✅ (`b62b862..2dd98a9`) |
| 5 | Exactly one docs file committed | ✅ |
| 6 | No source/test/frontend/backend/runtime change committed | ✅ |
| 7 | M24 client-sanitizer hardening baseline frozen | ✅ |
| 8 | C-01 / C-02 / C-03 client sanitizer hardening frozen | ✅ |
| 9 | C-04 / C-05 / C-06 frozen and passing | ✅ |
| 10 | Tests documented at 991/991 | ✅ (reconfirmed this milestone) |
| 11 | Typecheck 12 unrelated baseline / 0 BCP | ✅ (reconfirmed) |
| 12 | Static scan clean | ✅ (reconfirmed) |
| 13 | Browser evidence waived for Phase 2.0 only | ✅ |
| 14 | New read-only lens implementation pause ACTIVE | ✅ |
| 15 | M26 Live Transport Harness Feasibility Planning Gate selected | ✅ |

---

## Section C — Live transport problem statement (safe summary)

1. Prior implementation/QA milestones built strong **route/adapter/registration unit-test coverage** for every lens (in-process, deterministic).
2. **Live over-the-socket transport-matrix evidence** (a real running server answering real HTTP) has at times been partial due to sandbox **server-lifecycle / process-cleanup** limits.
3. M24 was **client-parser-only**, so live transport was not required for that milestone.
4. A future harness could improve evidence quality **only if it can be built safely** — without weakening any frozen baseline.
5. Any harness must introduce **no** logs / raw output / artifacts / package changes / browser tooling / production exposure / DB-Supabase access / mutation behavior, and must guarantee process cleanup.

---

## Section D — Current C-01..C-06 transport inventory (safe summary)

The six lenses share **one uniform transport contract** (verified: a shared base route + per-lens routes each carry the same gate/method markers). The pure route handler owns gating + method handling; a thin Express adapter translates `req`→pure-input and writes the safe response; an `app.all` registration mounts it on the **isolated platform-identity API only** (never the SaaS app, never the client bundle). Gate order is fail-closed and identical per lens:

`dev_only (404)` → `feature_disabled (404)` → `OPTIONS (204, Allow: GET, no body)` → non-GET/HEAD `(405, Allow: GET)` → guard `(409 parity_blocked / 403 not_authorized)` → `HEAD (200, no body)` → `GET (200, safe envelope)` → catch `(500, {status:'error'})`.

> **Uniformity scope (review-clarified):** the contract is uniform across all six lenses **at the pure route-handler / gate level**. Adapter-edge behavior is *not* fully uniform: the C-02..C-06 adapters accept injectable gate inputs (`deps`) and wrap the handler call in a try/catch (adapter-edge 500), whereas the **C-01 adapter is non-injectable** — it derives `isDevEnvironment`/`featureEnabled` directly from `process.env` / the flag helper and relies solely on the handler's internal no-throw. This asymmetry is benign (the C-01 handler is no-throw) but is load-bearing for the M27 harness design (see Section P).

| Lens | Route family | Flag posture | DEV-only / prod-disabled | GET | HEAD | OPTIONS | Mutation | Hostile req | Unit coverage | Live evidence | Residual | Include in harness |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| **C-01** Readiness Summary | readiness-summary | production-disabled flag | DEV-only; prod ⇒ uniform unavailable | 200 safe code/config envelope | 200 no body | 204 Allow:GET | 405 Allow:GET | ignored (authority server-side only) | route + adapter + (shared base) | partial (sandbox) | live socket residual | yes |
| **C-02** Registry Readiness | registry-readiness | production-disabled flag | DEV-only; prod ⇒ unavailable | 200 safe registry envelope | 200 no body | 204 Allow:GET | 405 Allow:GET | ignored | route + adapter + registration | partial | live socket residual | yes |
| **C-03** UI Coverage Readiness | ui-coverage-readiness | production-disabled flag | DEV-only; prod ⇒ unavailable | 200 safe coverage envelope | 200 no body | 204 Allow:GET | 405 Allow:GET | ignored | route + adapter + registration | partial | live socket residual | yes |
| **C-04** Route Exposure Readiness | route-exposure readiness | production-disabled flag | DEV-only; prod ⇒ unavailable | 200 safe exposure envelope | 200 no body | 204 Allow:GET | 405 Allow:GET | ignored | route + adapter + registration | partial | live socket residual | yes |
| **C-05** Feature-Flag / Env Posture | feature-flag posture | production-disabled flag | DEV-only; prod ⇒ unavailable | 200 safe posture envelope | 200 no body | 204 Allow:GET | 405 Allow:GET | ignored | route + adapter + registration | partial | live socket residual | yes |
| **C-06** Quality-Gates / Evidence Posture | quality-gates evidence | production-disabled flag | DEV-only; prod ⇒ unavailable | 200 safe evidence envelope | 200 no body | 204 Allow:GET | 405 Allow:GET | ignored | route + adapter + registration | partial | live socket residual | yes |

**Key finding:** the transport *contract* (gates, method matrix, hostile-request non-authority, prod-disabled) is already covered **deterministically in-process** for all six lenses. The only uncovered surface is **real over-the-socket HTTP** through a running identity API.

---

## Section E — Option 1: full identity API harness feasibility

| Planning question | Assessment |
|---|---|
| Start the identity API using existing scripts only? | Yes — `npm run identity:api` (`tsx server/platform-identity/server.ts`) exists; no new script needed |
| Avoid package/lockfile changes? | Yes |
| Avoid dependency installation? | Yes (uses installed `tsx`/Express) |
| Bind a controlled local port without production exposure? | Yes — isolated platform-identity port; DEV-only; prod ⇒ uniform unavailable |
| Set feature flags safely without leaking values? | Yes — flags are server-derived; harness sets env, asserts behavior, never prints values |
| Test C-01..C-06 route behavior uniformly? | Yes — uniform contract |
| **Guarantee process cleanup?** | **NOT GUARANTEED in this sandbox** — the recurring server-lifecycle limit; orphan-process risk |
| Avoid orphan processes? | Cannot be guaranteed under current sandbox lifecycle |
| Avoid raw logs / artifacts? | Yes if designed for safe-summary output only |
| Avoid startup-diagnostics exposure? | Yes if suppressed/summarized |
| Provide only safe-summary output? | Yes |
| Risks due to sandbox lifecycle | Orphan server, port retention, unreliable teardown |
| Suitable for M27 implementation now? | **No** — fails the process-cleanup fail-closed contract (Section N) |

**Decision for Option 1: DEFER** (feasible only with deeper planning + a proven sandbox-cleanup mechanism). Retained as the live-socket residual.

---

## Section F — Option 2: adapter-boundary harness feasibility

| Planning question | Assessment |
|---|---|
| Test the Express adapter without starting the full server? | Yes — call `create*Handler()` with mock `req`/`res`; no socket, no lifecycle |
| Use existing test-runner patterns? | Yes — `tsx` file emitting `X/Y passed` + `ALL_TESTS_PASSED` |
| Cover GET / HEAD / OPTIONS / mutation behavior? | Yes — drives `req.method` through the real adapter + real pure handler |
| Simulate production-disabled behavior safely? | Yes — set `NODE_ENV`/gate inputs at the boundary, assert uniform unavailable |
| Simulate feature-disabled behavior safely? | Yes |
| Confirm hostile request data ignored? | Yes — pass non-authority hints/body/query, assert no influence |
| Avoid raw logs / artifacts? | Yes |
| Provide only safe-summary output? | Yes (matrix of lens × scenario → pass/fail) |
| Duplicate existing unit tests? | **Partially** — overlaps per-lens adapter tests; net-new value is a *consolidated cross-lens matrix* + reusable scaffold |
| Enough additional transport evidence? | Adds unified cross-lens regression matrix; does **not** add real-socket evidence |
| Suitable for M27 implementation? | **Yes** — exact, low-risk, cleanup-trivial (no process) |

**Decision for Option 2: FEASIBLE FOR IMPLEMENTATION** (the basis of the selected M27 package).

---

## Section G — Option 3: route-handler-boundary harness feasibility

| Planning question | Assessment |
|---|---|
| Test the pure handler without Express/server lifecycle? | Yes — `handle*Request({method,...})` is pure/no-throw |
| Cover gate order? | Yes |
| Cover GET success/failure states? | Yes |
| Cover method rejection? | Yes (the handler owns method handling) |
| Cover hostile-request non-authority? | Yes |
| Avoid server-lifecycle limits? | Yes (no server) |
| Live transport evidence, or stronger unit evidence? | **Unit evidence only** — not transport |
| Enough to close the residual? | No — does not exercise the HTTP boundary or socket |
| Suitable for M27 implementation? | Redundant — already covered by existing route tests |

**Decision for Option 3: REJECT** as a standalone harness (already covered by existing per-lens route tests; adds no transport evidence).

---

## Section H — Option 4: hybrid strategy feasibility

Hybrid = adapter-boundary matrix (deterministic, all 6 lenses) **+ optional** short-lived identity-API socket smoke **gated on a proven cleanup mechanism**.

| Planning question | Assessment |
|---|---|
| Safest evidence improvement? | The adapter-boundary half is the safest; the socket half is the only real-transport add but carries cleanup risk |
| Avoid sandbox server-lifecycle problems? | Only the boundary half does; the socket half does not (today) |
| Cover C-01..C-06 uniformly? | Yes (boundary half) |
| Keep implementation scope small? | Yes for the boundary half; the socket half enlarges scope/risk |
| Avoid touching route/provider/read-model/client/UI files? | Yes (test-only) |
| Files required in M27 | One new test-only file (boundary half) |
| Stop conditions | If socket half cannot guarantee cleanup → omit it (fail closed) |
| Safest M27 candidate? | The boundary half **is** the safest candidate; the socket half should be deferred |

**Decision for Option 4: FEASIBLE ONLY WITH DEEPER PLANNING** for the socket half → collapse to the boundary-only package now (Section J Option 1), defer the socket half.

---

## Section I — Required scenario feasibility matrix

Legend: **FullAPI** = full identity API harness · **Adapter** = adapter-boundary harness · **Route** = route-handler harness · **Hybrid** = hybrid · **Unit** = already covered by existing unit tests.

| # | Scenario | FullAPI | Adapter | Route | Hybrid | Status |
|---|---|---|---|---|---|---|
| 1 | flag-off / feature-disabled | feasible | feasible | feasible | feasible | already covered (Unit) + re-asserted in matrix |
| 2 | flag-on / success | feasible | feasible | feasible | feasible | covered (Unit) + matrix |
| 3 | GET success | feasible (socket) | feasible (boundary) | feasible (logic) | feasible | covered (Unit) + matrix |
| 4 | HEAD bodyless | feasible | feasible | feasible | feasible | covered (Unit) + matrix |
| 5 | OPTIONS 204 | feasible | feasible | feasible | feasible | covered (Unit) + matrix |
| 6 | mutation methods → 405 | feasible | feasible | feasible | feasible | covered (Unit) + matrix |
| 7 | production-disabled behavior | feasible | feasible | feasible | feasible | covered (Unit) + matrix |
| 8 | hostile request ignored / no leak | feasible | feasible | feasible | feasible | covered (Unit) + matrix |
| 8a | guard: parity_blocked (409) | feasible | feasible | feasible | feasible | covered (Unit) + **matrix (added per review)** |
| 8b | guard: not_authorized (403) | feasible | feasible | feasible | feasible | covered (Unit) + **matrix (added per review)** |
| 8c | catch-path safe error (500 `{status:'error'}`) | feasible | feasible (route-handler level) | feasible | feasible | covered (Unit) + **matrix (added per review)** |
| 9 | no raw evidence / no diagnostics | enforced by output contract | enforced | enforced | enforced | safe-summary contract (Section M) |
| 10 | no DB/Supabase/live-provider access | enforced | enforced | enforced | enforced | static scan + design |
| 11 | safe-summary reporting only | feasible | feasible | feasible | feasible | output contract (Section M) |
| 12 | **guaranteed process cleanup** | **NOT feasible without unsafe changes (sandbox)** | feasible (no process) | feasible (no process) | boundary-only feasible | **drives Decision C** |

**Conclusion:** every transport scenario (1–8c) is feasible at the **adapter boundary with no process**, satisfying the cleanup contract (12). The matrix scope is the **full** contract — including the guard outcomes (8a 409 / 8b 403) and the catch-path safe error (8c 500), added per independent review so the consolidated matrix asserts the *complete* uniform contract across all six lenses (the property that distinguishes Decision C from a duplicate of the per-lens tests). Only the *socket-level* realisation of scenarios 3–8c needs a running server, which fails (12) today → defer the FullAPI realisation.

---

## Section J — Future implementation file-package feasibility

| Option | Value | Risk | Allowed files | Package/lock change | Source/runtime change | Committed artifacts | Cleanup guaranteed | Safe summary | Select for M27 |
|---|---|---|---|---|---|---|---|---|---|
| **1 — One new test-only harness file** | Consolidated cross-lens transport matrix + reusable scaffold | Low | one new `*.test.ts` (test-only) | No | No | No | **Yes (no process)** | Yes | **SELECTED** |
| 2 — Docs-only runner plan, no code | Documents intent only | Very low | one doc | No | No | No | Yes | Yes | No (no new evidence) |
| 3 — New script file + tests | Real-socket option | Medium-high (lifecycle/cleanup) | script + tests | No | adds runtime script | risk of artifacts | **No (sandbox)** | Yes | No (defer) |
| 4 — Modify existing route/adapter tests only | Marginal | Low-medium | existing tests | No | test edits | No | Yes | Yes | No (touches frozen tests; duplicative) |
| 5 — Implement nothing, keep residual | Zero cost | None | none | No | No | No | n/a | n/a | No (a safe exact package exists) |

**Selected M27 package: Option 1 — one new test-only harness file** (the adapter-boundary cross-lens transport matrix). Nothing is implemented in M26.

---

## Section K — Prohibited future-implementation boundaries

A future transport harness must NOT: change `package.json` / `package-lock.json`; install dependencies; add browser tooling; modify providers / read-models / routes / adapters / registration / clients / UI cards / Backend CP screens; modify auth / audit / identity / session / DB / Supabase files; create committed logs / reports / screenshots / traces / videos; expose raw command output / raw transport output / stack traces / runtime diagnostics / process details / package-dependency details / DB-Supabase-live-provider details; add production or customer-facing exposure; add mutation/action behavior; or depend on browser evidence for Phase 2.0 acceptance. (Adapters/registration may be touched **only** if explicitly selected and proven safe in a separately authorized milestone — the selected M27 package touches **none** of them: it is test-only and imports the frozen modules.)

**Additional explicit prohibitions (added per independent review).** The selected (no-process) boundary harness must also NOT: open a socket or listener; bind a port; perform any outbound network I/O (`fetch`/socket/HTTP); spawn any child or background process; write to the filesystem (no temp/PID/output files); or leave `process.env` mutated after any scenario. **"No process started"** means strictly: no child process, no background process, and no listening/socket process — the harness runs entirely in the test runner's own process. It must NOT add DI to the frozen C-01 adapter (or any frozen module) to make it testable — see the C-01 workaround in Section P.

---

## Section L — Future M27 test / typecheck / static-scan requirements

**Tests (if M27 implementation selected):** harness self-check; C-01..C-06 transport-scenario coverage — the **full** matrix (flag-off, flag-on GET, HEAD bodyless, OPTIONS 204, mutation 405, prod-disabled, hostile-request-ignored, **guard 409 parity_blocked, guard 403 not_authorized, catch-path 500 safe error**); all existing C-01..C-06 tests still passing; aggregate BCP suite still passing (≥ 991/991, plus the new matrix's own count). **Output format (mandatory):** the harness must follow the established style — emit a final `X/Y passed` count and `ALL_TESTS_PASSED` on success — and must wrap every scenario so an assertion/import failure is caught and reported as a **safe failure category** (lens + scenario + status label), never a raw stack or raw value.

**Typecheck:** 12 unrelated baseline errors unchanged (if still present); 0 in the new harness/test file; 0 in Backend CP surfaces.

**Static scans:** confirm no package/lockfile change; no DB/Supabase/live-provider access; no production/customer-facing exposure; no mutation/action behavior; no raw logs/output/artifacts; no runtime-diagnostics exposure; no browser tooling; no unsafe process-lifecycle behavior (the selected package starts no process).

---

## Section M — Evidence-output format safety contract

**Allowed:** safe pass/fail summary counts; lens IDs; scenario IDs; high-level status labels; safe error categories.
**Forbidden:** raw response bodies; raw headers; raw request data; raw environment values; stack traces; log dumps; command output; file paths; package/dependency versions; runtime diagnostics.

A future report MAY say: *"C-01 GET success passed"*, *"C-02 mutation method rejected (405)"*, *"C-06 production-disabled behavior passed"*, *"aggregate transport matrix passed"*. It MUST NOT include raw HTTP payloads, raw server logs, raw command output, raw stack traces, or raw environment values.

**Clarifications (added per independent review).** Asserting a **known-safe constant** value — the expected status code (200/204/404/405/409/403/500) and the fixed `Allow: GET` header — as a pass/fail boolean is **permitted** (it is the contract, not leaked data); dumping a raw header map or raw response object is forbidden. On failure the harness emits only a safe category (e.g. `C-03 OPTIONS: FAIL (expected 204)`), never the raw value it saw. If the deferred socket option is ever revived, its output must additionally bar **port numbers, PIDs, and timing/duration values**.

---

## Section N — Process-cleanup safety contract

A future harness must: avoid long-running orphan server processes; use deterministic startup/teardown **if** a server is started; kill only processes it started (no broad kills); avoid relying on global machine state; avoid PID files unless temporary and uncommitted; avoid committed runtime artifacts; **fail closed if cleanup cannot be guaranteed**; report only a safe cleanup summary; and **stop if sandbox lifecycle makes cleanup unreliable**. Where the no-process boundary harness must mutate global state to exercise the non-injectable C-01 adapter (see Section P), it must **snapshot `process.env.NODE_ENV` and the feature flag before each such scenario and restore them in a `finally` block**, so no scenario contaminates another and the environment is left exactly as found. The selected M27 package (mock `req`/`res`, **no process started** — no child/background/listening process, no socket, no network I/O, no filesystem writes) satisfies this contract trivially; the deferred socket option remains gated on a proven cleanup mechanism.

---

## Section O — Transport harness feasibility decision

**Decision C — Feasible only at the adapter/route boundary → proceed to M27 Boundary Transport Harness Implementation.** The full-identity-API real-socket smoke is **deferred** (accepted residual) until in-sandbox process cleanup is provably safe (revisit at the Phase 2→3 boundary alongside browser-evidence reopening). Decision A is not used (socket cleanup not provable); B is not needed (a boundary package is already exact/low-risk); D is not used (a safe value-adding package exists); E is not used (no blocker found).

---

## Section P — Next governed step selection

| Candidate | Selection |
|---|---|
| A — M27 Live Transport Harness Implementation | No — socket cleanup not provable in sandbox |
| B — M27 Transport Harness Safety-Contract Deepening | No — boundary package already exact |
| **C — M27 Boundary Transport Harness Implementation** | **SELECTED** |
| D — M27 Cross-Lens Hardening Implementation Part 2 | No — transport not deferred; no frozen hardening package staged |
| E — M27 Next Read-Only Lens Discovery Gate | No — new-lens pause remains ACTIVE |
| F — other | No |

**Selected next step: Candidate C — Phase 2.0 M27 — Boundary Transport Harness Implementation.**

**Selection rationale.** The transport contract is already deterministically covered in-process for all six lenses; the genuine gap is real-socket HTTP, blocked today by the unresolved sandbox process-cleanup risk (cleanup fail-closed contract). The **load-bearing** justification for the boundary harness over Decision D is the **cross-lens uniformity property**: no existing test asserts that all six lenses share the *complete* gate order and method/guard/catch matrix as a single regressionable property — the M27 matrix (now scoped to the full contract, scenarios 1–8c) makes that uniformity explicit and catches cross-lens drift a per-lens test would not flag as an inconsistency. The reusable-scaffold benefit (a future cleanup-safe milestone re-pointing the matrix at the live socket) is a **bonus, not load-bearing**. The harness is exact, low-risk, cleanup-trivial (no process), and touches no frozen source. **Decision D (defer) is a defensible alternative** — the independent cross-model lens argued the overlap with per-lens tests outweighs the consolidation value — but with the matrix expanded to the full contract, the uniformity check is genuinely net-new, so C is selected. It closes as much of the residual as can be safely closed now and explicitly carries the remaining real-socket gap as a documented residual.

**Allowed files for M27 (Candidate C):** exactly one new **test-only** file — e.g. `server/bcp-pilot/bcpTransportMatrix.test.ts` (imports the frozen adapters/handlers; drives mock `req`/`res`; emits a safe-summary matrix). No other file.

**Prohibited files for M27:** `package.json` / `package-lock.json`; any provider / read-model / route / adapter / registration / client / UI / `screens.tsx` / `server/platform-identity/server.ts` / `bcpAuthorizationGuard.ts` / `src/App.tsx` / SaaS-nav source; migrations / seeds; `shared/**`; auth / audit-writer / identity-repository / sessionResolve; DB / Supabase files; any new dependency; any browser tooling; any committed log/report/screenshot/trace/video/artifact.

**Stop conditions for M27:** stop and report a blocker if the matrix would require starting a server/process; if cleanup cannot be guaranteed; if any frozen source (adapter/route/etc.) would need editing to be testable; if any package/dependency need arises; or if any raw-output / exposure surface would be introduced.

**M27 implementation constraints (mandated by M26 independent review).** The M27 boundary harness MUST:
1. **Cover the full contract** — all of scenarios 1–8c (incl. guard 409 parity_blocked, guard 403 not_authorized, and the catch-path 500 safe error), uniformly across C-01..C-06; a matrix that omits the guard/catch outcomes does not assert the uniform contract and would not justify C over D.
2. **Handle the C-01 DI asymmetry safely.** C-01's adapter is non-injectable (reads `process.env`/the flag helper directly), unlike C-02..C-06 which accept injectable `deps`. For C-01, exercise `dev_only`/`feature_disabled`/`prod-disabled` either by (a) mutating `process.env.NODE_ENV`+flag inside a `try/finally` that snapshots and restores them, or (b) asserting those states at the pure `handleBcpReadinessSummaryRequest` handler level. It MUST NOT add DI to (or otherwise edit) the frozen C-01 adapter — doing so is a freeze-violation blocker.
3. **Snapshot/restore global state** — any `process.env` or flag it mutates is restored in a `finally`, so scenarios cannot contaminate each other and the environment is left as found.
4. **Sanitize failure output** — wrap every scenario; on assertion/import failure emit only a safe `lens + scenario + status-label` category, never a raw stack/value/object/header map. Asserting known-safe constant status codes and the fixed `Allow: GET` header as booleans is permitted (Section M).
5. **Start no process and perform no I/O** — no child/background/listening process, no socket/port/listener, no outbound network, no filesystem writes (Sections K, N).
6. **Note the adapter-edge non-uniformity** — C-01's adapter lacks the C-02..C-06 adapter-edge try/catch; any adapter-edge safe-error assertion must account for this (the "uniform contract" holds at the route-handler/gate level).

**Final-report requirements for M27:** safe-summary transport matrix (lens × scenario → pass/fail); existing 991/991 unchanged; typecheck 0 in BCP surfaces; static scan clean; independent review verdicts; process-cleanup confirmation (no process started); accepted residuals (real-socket smoke still deferred).

---

## Section Q — Baseline reconfirmation (safe summary)

| Family | Expected | Observed | Pass |
|---|---|---|---|
| C-01 family (38 lens + 71 shared base) | 109 | 109 | ✅ |
| C-02 | 126 | 126 | ✅ |
| C-03 | 130 | 130 | ✅ |
| C-04 | 146 | 146 | ✅ |
| C-05 | 170 | 170 | ✅ |
| C-06 | 310 | 310 | ✅ |
| **Aggregate** | **991** | **991** | ✅ |

- **Typecheck:** 12 unrelated baseline errors unchanged; **0** in `src/backend-control-plane`; **0** in `server/bcp-pilot`; **0** in C-01..C-06 evidence surfaces.
- **Static scans:** no package/lockfile change; **0** live DB/Supabase imports, SQL/DDL, mutation fetches, or `dangerouslySetInnerHTML` in C-01..C-06; `createClient`/`getDb` appear **only** in defensive negative-assertion comments (e.g. *"no DB, no Supabase, no createClient, no getDb"*); no production/customer-facing/raw-env-value/value-oracle/log-output/diagnostics/package-detail/command-output/raw-evidence/file-path/production-claim surface exists in the C-01..C-06 evidence lenses.
- All evidence is **byte-identical** to the M25-verified baseline (`git diff b62b862 HEAD -- src server` is empty), and was independently re-run this milestone.

---

## Section R — Independent review results

Three independent lenses were run (decomposed into genuinely independent workstreams; re-varied from the M25 set):

| Lens | Verdict | Actionable on M26 doc |
|---|---|---|
| Security / evidence-exposure / process-cleanup | **MINOR FINDINGS** (1 MED, 3 LOW) | 4 applied to doc |
| Feasibility / implementation-contract / regression | **MINOR FINDINGS** (3 LOW) | 3 applied to doc |
| Cross-model (independent model) | **BLOCKER** (2 HIGH, 3 MED) | 5 applied to doc |

**Reconciliation.** All findings were **plan-spec gaps in this M26 document**, not defects in any frozen source/test/runtime — so none is a true source-change blocker; M26's job is exactly to refine the plan. The cross-model "BLOCKER" verdict (matrix would duplicate per-lens tests; matrix omitted guard/catch outcomes) and the convergent C-01-DI / env-restore / failure-sanitization / process-prohibition findings were **all applied to the document**: the M27 matrix scope was expanded to the **full** contract (added scenarios 8a 409 / 8b 403 / 8c 500), which makes the cross-lens uniformity check genuinely net-new (answering the duplication objection and making C's justification load-bearing); the C-01 non-injectability asymmetry + safe `try/finally` env snapshot-restore workaround was documented (Sections D, N, P) with an explicit bar on editing the frozen C-01 adapter; sanitized failure output, `Allow`/status-as-boolean permission, and explicit no-socket / no-network / no-child-process / no-filesystem prohibitions were added (Sections K, M, N, L, P); and the rationale was reframed so uniformity is load-bearing, the scaffold is a bonus, and Decision D is acknowledged as a defensible alternative. After applying, Decision C stands, better-specified. **0 unresolved findings; 0 source/test/runtime changes required.**

---

## Section S — Non-readiness statements

Phase 2.0 remains: **not** production readiness; **not** customer-facing release; **not** Phase 3 controlled actions; **not** Phase 4 production readiness; **not** live DB/Supabase reads; **not** live provider reads; **not** Supabase auth enablement; **not** Firebase-to-Supabase cutover; **not** browser-evidence completion for production/customer-facing release.

**Firebase remains authoritative. Supabase remains dormant / shadow / readiness-only. Backend CP remains DEV-only and read-only in Phase 2.0** (default-off where flags apply, production-disabled, code/config-only, server-sourced authority only, no DB/SQL/Supabase/Supabase-MCP, no live provider, no backend action, no mutation, no production / normal-SaaS-nav / customer-facing exposure, no live session authorization, no Supabase auth).

---

## Section T — Verification before final report

| # | Check | Result |
|---|---|---|
| 1 | Only the M26 documentation file created | ✅ |
| 2–19 | No source / test / frontend / backend / client / provider / read-model / route / adapter / registration / UI-card / `screens.tsx` / `server.ts` / `bcpAuthorizationGuard.ts` / `App.tsx` / SaaS-nav / `package.json` / `package-lock.json` / migration / seed / `shared/**` / auth-audit-identity-session / DB-Supabase change | ✅ none |
| 20 | `.replit` unstaged and untouched | ✅ |
| 21 | goose tarball untracked | ✅ |
| 22 | `.gitattributes` absent | ✅ |
| 23 | Tests / scans / typecheck / planning findings reported honestly | ✅ |
| 24 | Not-run evidence clearly marked NOT RUN | ✅ (full-API socket harness NOT IMPLEMENTED / live socket NOT RUN) |
| 25 | Independent-review verdict capture explicit and honest | ✅ (final report) |
| 26 | Git status shows only `M .replit` + `?? docs/…m26…md` + `?? goose…` | ✅ (expected post-write tree) |

---

## Accepted residuals

1. **Real over-the-socket live transport (full identity API)** — DEFERRED; cannot guarantee in-sandbox process cleanup. Carried as a residual; revisit at the Phase 2→3 boundary (with browser-evidence reopening) or in a cleanup-safe environment.
2. **Browser evidence** — waived for Phase 2.0 only; must reopen before production readiness / Phase 3 / Phase 4 / customer-facing release.
3. **12 unrelated typecheck baseline errors** in non-BCP surfaces — out of scope.
4. **New read-only lens implementation pause** — remains ACTIVE.

---

## Review log

- **Independent review: PASSED (findings applied)** — 3 independent lenses (security/evidence-exposure/process-cleanup → MINOR FINDINGS; feasibility/implementation-contract/regression → MINOR FINDINGS; cross-model → BLOCKER). All findings were plan-spec gaps in this document (no frozen source/test/runtime defect); **all were applied** to the doc (full-contract matrix scope incl. guard 409/403 + catch 500; C-01 DI-asymmetry workaround with env snapshot/restore and a bar on editing frozen source; sanitized failure output; explicit no-socket/no-network/no-process prohibitions; reframed C-vs-D rationale). Decision C stands, better-specified; 0 unresolved findings; M26 changed no code. See Section R.
- **Acceptance recommendation:** **ACCEPT** — adopt Decision C; proceed to scoped commit/backup authorization for this M26 document, then to M27 Boundary Transport Harness Implementation.
- **Recommended next step:** *Phase 2.0 M26 — Scoped Commit and Backup Authorization* (this document only). No commit / push / backup performed in M26.
