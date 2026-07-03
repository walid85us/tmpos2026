# Phase 2.0 — Backend Control Panel — M38: C‑07 Transport Matrix Extension Planning Gate

**Status:** DOCS‑ONLY planning gate. No source, test, transport‑matrix, guard, server‑mount, provider, read‑model, route, adapter, registration, client, UI, package, or runtime change is made by M38.
**Milestone:** Phase 2.0 M38.
**Pre‑change accepted checkpoint:** `ded6cc55df65bf986925be58abfc958861b5adc2` (subject: *Phase 2.0 M37 add backend control panel C07 authorization mount*).
**Purpose:** Decide whether the next milestone should extend `server/bcp-pilot/bcpTransportMatrix.test.ts` to include C‑07, and lock the exact safe single‑file package **before** touching that frozen test surface.

> This gate implements nothing. It reads the M35–M37 C‑07 decisions, the frozen C‑01..C‑06 transport matrix, and the current git/test/typecheck state, then locks the smallest safe next plan. The C‑07 matrix row is **not** added in M38.

---

## Section A — Preflight Result

All preflight conditions **PASS**. This is the pre‑change backup checkpoint; no extra backup is created.

| # | Condition | Result |
|---|-----------|--------|
| 1 | Branch is `main` | PASS |
| 2 | Local `HEAD` == `origin/main` == `ded6cc55df65bf986925be58abfc958861b5adc2` (confirmed via `rev-parse` **and** `ls-remote origin main`) | PASS |
| 3 | ahead/behind is `0/0` | PASS |
| 4 | `git status` shows only ` M .replit` and `?? goose-x86_64-unknown-linux-gnu.tar.bz2` | PASS |
| 5 | Nothing staged | PASS |
| 6 | `.gitattributes` absent | PASS |
| 7 | M37 commit present (`ded6cc5 Phase 2.0 M37 add backend control panel C07 authorization mount`) | PASS |
| 8 | Since `HEAD == origin/main`, this is the pre‑change backup checkpoint | PASS — no extra backup |
| 9 | No source/test/backend/frontend/route/adapter/registration/guard/mount/UI/package/migration/DB/Supabase/auth/runtime change occurs in M38 | PASS (docs‑only) |
| 10 | No commit, push, or backup occurs in M38 | PASS |

---

## Section B — M37 Backup and Authorization / Mount Baseline Review

The M37 authorization/mount/registration baseline is safely committed and backed up.

| # | Confirmation | Result |
|---|--------------|--------|
| 1 | M37 commit hash | `ded6cc55df65bf986925be58abfc958861b5adc2` |
| 2 | M37 commit subject | `Phase 2.0 M37 add backend control panel C07 authorization mount` |
| 3 | `origin/main` matches local `HEAD` | PASS |
| 4 | Push was fast‑forward and non‑force | PASS (remote `main` == local `HEAD`, `0/0`) |
| 5 | Exactly five M37 files were committed | PASS (guard + server.ts + registration test + route test + adapter test) |
| 6 | No docs file committed at M37 | PASS |
| 7 | No package/lockfile change | PASS |
| 8 | No C‑07 provider/read‑model source or tests changed | PASS |
| 9 | No C‑07 route source changed | PASS |
| 10 | No C‑07 adapter source changed | PASS |
| 11 | No `bcpTransportMatrix.test.ts` change | PASS (still exactly 6 lenses) |
| 12 | No client/UI/screen integration | PASS |
| 13 | No DB/Supabase/live provider access | PASS |
| 14 | Full BCP corpus | 1264/1264 |
| 15 | M27 transport matrix | 106/106 (unchanged) |
| 16 | Typecheck | 12 baseline errors; 0 BCP‑surface errors |
| 17 | Static scan | clean |
| 18 | C‑07 authorized `200` path became live and guard‑gated | PASS |
| 19 | C‑07 transport matrix row remains deferred | PASS (this gate) |
| 20 | M37 residuals accepted | PASS |

---

## Section C — C‑07 Readiness for Transport Matrix Extension

C‑07 is **ready** for transport matrix coverage. Every readiness condition holds and was reverified at M38.

| # | Readiness check | Result |
|---|-----------------|--------|
| 1 | C‑07 provider/read‑model core pure and deterministic | PASS |
| 2 | C‑07 route handler implemented | PASS (`handleBcpC07DataSourceBoundaryRequest`) |
| 3 | C‑07 Express adapter implemented | PASS (`createBcpC07DataSourceBoundaryReadinessHandler`) |
| 4 | C‑07 guard entry implemented | PASS (`'C-07': 'overview_viewer'`) |
| 5 | C‑07 server mount implemented | PASS (`/dev/bcp/data-source-boundary-readiness`) |
| 6 | C‑07 route registration test green | PASS (18/18) |
| 7 | C‑07 authorized `200` path live and guard‑gated | PASS |
| 8 | C‑07 route/adapter tests green | PASS (39/39, 26/26) |
| 9 | C‑07 provider/read‑model tests green | PASS (43/43, 41/41) |
| 10 | No DB/SQL/Supabase/live provider | PASS |
| 11 | No runtime env value exposure (only boolean gates) | PASS |
| 12 | No diagnostics or command output | PASS |
| 13 | No action/mutation behavior | PASS (GET/HEAD/OPTIONS only) |
| 14 | Remains DEV‑only, default‑off, production‑disabled, read‑only | PASS |
| 15 | Suitable for matrix inclusion without modifying route/source/server/guard | PASS (see Section E compatibility) |
| 16 | Matrix extension achievable by changing only `bcpTransportMatrix.test.ts` | PASS |

**Compatibility verification (why C‑07 slots into the injectable matrix pattern like C‑02..C‑06).** The matrix's per‑lens `pureHandlerCases`/`adapterEdgeCases` drive each lens through the shared gate/method/guard/HTTP‑shape contract. With the M37 guard entry, `handleBcpC07DataSourceBoundaryRequest` returns a real `200 success` for a valid principal + GET, `404` for dev‑off/feature‑off, `204` for OPTIONS, `405` for mutations, `403`/`409` for the guard‑denied principals, `200 no‑body` for HEAD, and `500 { status: 'error' }` on the induced‑throw case — identical to the frozen lenses. The matrix `BoundaryReq` shape (`method`/`isDevEnvironment`/`featureEnabled`/`principal`/`hints?`) omits `items`; C‑07's `items` is **optional**, so the handler builds the safe empty‑state envelope (non‑null body) and no matrix change to `BoundaryReq` is required. The injectable adapter’s `getDataSourceBoundaryItems` defaults to EMPTY when unset, so `makeAdapter({ isDevEnvironment, featureEnabled })` yields the same `200`/`204`/`404`/`405` HTTP shapes. The success envelope carries none of the matrix `FORBIDDEN_LEAK` markers (`iu_synthetic_dev`, `service_role`, `Bearer `, `/home/`, `node_modules`, `Error:`, `.ts:`) — it is built purely from the (empty) items and never echoes the principal — and the `500 { status: 'error' }` error body is likewise marker‑free, so both the C‑07 empty‑state success envelope **and** the induced‑error envelope pass `assertNoRawEvidence` / `assertHintsNotLeaked` unchanged.

---

## Section D — Transport Matrix Extension Options

| Option | Description | Risk | Verdict |
|--------|-------------|------|---------|
| **A** | M39: add the C‑07 row to `bcpTransportMatrix.test.ts` **only** (bump lens count 6→7, preserve C‑01..C‑06) | Medium‑low (one frozen test surface) | **SELECTED** |
| B | M39: matrix row **+** additional route/adapter test updates | Medium | Rejected — matrix discovery shows no route/adapter test correction is needed; the C‑07 handler/adapter already satisfy the shared contract |
| C | M39: matrix row **+** real‑socket smoke | High | Rejected — real‑socket live transport requires separate transport/browser authorization; out of Phase 2.0 |
| D | Another docs‑only planning gate | Low | Rejected — the matrix shape and the exact row values are unambiguous (verified against source) |
| E | Defer matrix extension | Low | Rejected — leaves a standing evidence gap for the now‑mounted C‑07 route; the extension is safe and exact now |

**Rationale for A.** The matrix is a self‑contained test harness that imports the frozen handlers/adapters and exercises them in‑process. Adding C‑07 is a single `LENSES` array entry plus two imports plus a lens‑count bump — no guard/server/route/adapter/provider/read‑model/client/UI/package/runtime change. C‑07 is injectable‑compatible, so the delta is predictable (Section F).

---

## Section E — C‑07 Matrix Row Contract Lock

**Binding accuracy note (do not invent fields; do not over‑claim what the matrix asserts).** The frozen matrix does **not** track route path, proxy path, schema version, `sourceMode`, or `freshness` as row fields. A matrix `Lens` has exactly five fields: `id`, `injectable`, `flagEnv`, `handler`, `makeAdapter`. Adding C‑07 to `LENSES` gives it coverage of exactly what the shared generators assert, and nothing more. Precisely:

- **Dynamically asserted by the per‑lens generators for C‑07** (the only new evidence M39 produces): method gates (`OPTIONS → 204 Allow:GET`, `POST/DELETE → 405 Allow:GET`); DEV/feature gates (`isDev=false → 404 dev_only`, `featureEnabled=false → 404 feature_disabled`, adapter dev‑off/feature‑off → 404); guard outcomes (`null principal → 403 not_authorized`, `parity‑unresolved → 409 parity_blocked`); HTTP shape (`GET → 200 success non‑null`, `HEAD → 200 no‑body`, induced‑throw `catch → 500 {status:'error'}`, adapter GET/HEAD/OPTIONS/POST shapes); hostile‑hints‑ignored; and the `assertNoRawEvidence` / `assertHintsNotLeaked` leak scans.
- **Structurally guaranteed** (because the matrix imports the frozen pure modules and injects nothing): no DB/SQL/Supabase/Supabase‑MCP/live provider, no socket/server/listener/port, no outbound network, no child/background process, no filesystem write, no mutation/action.
- **Covered by OTHER frozen C‑07 tests — NOT by the matrix:** route path and mount (registration + adapter tests), proxy path (adapter test), schema version and `design_time_code_config` self‑attestation and `generatedAt` exclusion (read‑model test). **M39 adds NO route‑path or proxy‑path evidence to the matrix**; the matrix never exercises the mounted `/dev/bcp/...` path — it drives the frozen handler/adapter in‑process.

M39 must therefore use the existing five‑field `Lens` shape and add nothing else; it must not add a path/proxy/schema field or any bespoke C‑07 assertion outside the shared generators.

**Locked C‑07 `LENSES` entry (exact shape):**

```
{ id: 'C-07', injectable: true, flagEnv: 'ENABLE_BCP_DEV_C07_DATA_SOURCE_BOUNDARY_READINESS',
  handler: (r) => handleBcpC07DataSourceBoundaryRequest(r),
  makeAdapter: (d) => createBcpC07DataSourceBoundaryReadinessHandler(d) }
```

**Two new imports (frozen symbols; import‑only, no modification):**

```
import { handleBcpC07DataSourceBoundaryRequest } from './bcpC07DataSourceBoundaryReadOnlyRoute';
import { createBcpC07DataSourceBoundaryReadinessHandler } from './bcpC07DataSourceBoundaryReadOnlyExpressAdapter';
```

**Reference values (already asserted by other frozen C‑07 tests; recorded here for traceability, NOT added as matrix fields):** lens id `C-07`; route path `/dev/bcp/data-source-boundary-readiness`; proxy path `/__identity/dev/bcp/data-source-boundary-readiness`; feature flag `ENABLE_BCP_DEV_C07_DATA_SOURCE_BOUNDARY_READINESS` (default‑off); schema `bcp.c07.data-source-boundary-readiness.v1-code-config`; self‑attestation `design_time_code_config`; read‑only; production‑disabled; no customer‑facing exposure; mutation blocked; no DB/SQL/Supabase/Supabase‑MCP/live provider/diagnostics/command output/package inventory/file‑path inventory; matrix (static/mock/in‑process) transport only — **no real‑socket evidence**; no client/UI/browser evidence.

---

## Section F — Matrix Test Update Contract Lock

**File (M39, updated in place):** `server/bcp-pilot/bcpTransportMatrix.test.ts` — the **only** file M39 may change.

| # | Requirement | Locked |
|---|-------------|--------|
| 1 | Modify only `bcpTransportMatrix.test.ts` | ✔ |
| 2 | Add C‑07 to the existing `LENSES` list (five‑field shape) | ✔ |
| 3 | Update the exact lens count from 6 to 7 — **both** guard asserts: `LENSES.length === 7` and the unique‑id `new Set(...).size === 7` | ✔ |
| 4 | Preserve all C‑01..C‑06 entries exactly (only the count/comment/label text updates) | ✔ |
| 5 | Add C‑07 assertions via the existing `pureHandlerCases` / `adapterEdgeCases` generators (no new bespoke assertions); the per‑lens loop guards `pure.length >= 12` and `edge.length >= 2` are satisfied by the shared generators, unchanged | ✔ |
| 6 | Route path | N/A — the matrix does **not** assert or store the route path and never exercises the mounted `/dev/bcp/...` path; route path and mount are covered by the frozen registration + adapter tests. M39 adds **no** route‑path evidence to the matrix |
| 7 | Proxy path represented **if** the matrix tracks proxy paths | N/A — the matrix does not track proxy paths (asserted by the C‑07 adapter test) |
| 8 | Feature flag represented **if** the matrix tracks flags | ✔ (`flagEnv` is a required `Lens` field; for injectable C‑07 it is metadata only — the `withEnv` path that actually consumes `flagEnv` is the C‑01‑specific non‑injectable branch) |
| 9 | Schema represented **if** the matrix tracks schemas | N/A — the matrix does not track schemas (asserted by the C‑07 read‑model test) |
| 10 | C‑07 DEV‑only asserted | ✔ (`pure dev_only → 404`, `adapter dev-off → 404`) |
| 11 | C‑07 production‑disabled asserted | ✔ (dev‑off ⇒ 404, same cases) |
| 12 | C‑07 default‑off asserted | ✔ (`feature_disabled → 404`, `adapter feature-off → 404`) |
| 13 | C‑07 read‑only asserted | ✔ (GET/HEAD success, mutations 405) |
| 14 | C‑07 mutation‑blocked asserted | ✔ (`POST/DELETE → 405 Allow:GET`) |
| 15 | C‑07 no customer‑facing exposure | ✔ (in‑process only; no route/SaaS surface added) |
| 16 | C‑07 no client/UI/browser exposure | ✔ (test‑only harness) |
| 17 | C‑07 no DB/Supabase/live provider | ✔ (imports frozen pure modules only) |
| 18 | C‑07 no raw diagnostics/evidence/value‑oracle | ✔ (`assertNoRawEvidence` / `assertHintsNotLeaked` applied to C‑07 too) |
| 19 | Preserve no‑server/no‑socket/no‑process invariants | ✔ |
| 20 | Preserve no outbound network / no child process / no filesystem artifact | ✔ |
| 21 | Do not add live transport or real‑socket tests | ✔ |
| 22 | Do not start a server | ✔ |
| 23 | Do not open sockets/listeners/ports | ✔ |
| 24 | Do not use outbound network | ✔ |
| 25 | Do not add package/dependency/browser tooling | ✔ |

**Expected test‑count change (predictable).** C‑07 is injectable, so it contributes the same case set as C‑02..C‑06: **12** pure‑handler cases + **6** adapter‑edge cases = **18** new cases. Current baseline **106** → expected **124/124**. Two `C-01..C-06` label sites change to `C-01..C-07`: the `LENSES.length` assert **message string** (`'expected exactly 6 lenses (C-01..C-06)'` → `...7...C-01..C-07`) and the console runner label line (`[... boundary transport matrix C-01..C-06] X/Y passed`); the file header comment may also be refreshed for accuracy. If M39 observes any deviation from +18, it must report the actual delta and reconcile it before acceptance.

---

## Section G — Next Implementation File Package Lock (M39)

**Recommended next milestone:** **Phase 2.0 M39 — C‑07 Transport Matrix Extension Implementation.**

**Allowed file — exactly one:** `server/bcp-pilot/bcpTransportMatrix.test.ts` (MODIFY).

**Prohibited files (M39):** `bcpAuthorizationGuard.ts`; `server/platform-identity/server.ts`; `bcpC07RouteRegistration.test.ts`; `bcpC07DataSourceBoundaryReadOnlyRoute.test.ts`; `bcpC07DataSourceBoundaryReadOnlyExpressAdapter.test.ts`; `bcpC07DataSourceBoundaryProvider.ts` (+test); `bcpC07DataSourceBoundaryReadModel.ts` (+test); `bcpC07DataSourceBoundaryReadOnlyRoute.ts`; `bcpC07DataSourceBoundaryReadOnlyExpressAdapter.ts`; all `src/backend-control-plane/*` client/UI/screen; `src/App.tsx`; SaaS navigation; `package.json`/`package-lock.json`; migrations; seeds; `shared/**`; auth/audit/identity/session; DB/Supabase; browser tooling; generated artifacts; `.replit`; `.gitattributes`; goose tarball.

---

## Section H — Test Requirements for M39

**1. Matrix extension tests** (`bcpTransportMatrix.test.ts`): C‑07 included in `LENSES`; lens count asserts updated 6→7 (both `length` and unique‑id `size`); C‑01..C‑06 entries preserved; the matrix asserts C‑07's transport contract, **not** its route path (route path is covered by the frozen registration/adapter tests and is NOT added to the matrix); C‑07 flag present as the `flagEnv` metadata field; C‑07 DEV‑only / default‑off / production‑disabled / read‑only / mutation‑blocked postures asserted by the generated cases; C‑07 no customer‑facing / no client‑UI‑browser / no DB‑Supabase‑live / no diagnostics‑raw‑evidence‑value‑oracle; no‑server/no‑socket/no‑process invariants preserved; **no real‑socket claim**. (Schema/proxy are covered by other frozen tests and are not matrix fields.)

**2. Regression:** C‑01..C‑06 tests remain green; M33 provider/read‑model tests remain green; M35 route/adapter tests remain green; M37 registration/guard/mount tests remain green; full BCP corpus remains green; typecheck unchanged.

**3. Static scan:** `bcpTransportMatrix.test.ts` is the only changed file; no package/lockfile change; no server/source/runtime change; no DB/Supabase/live provider; no client/UI/browser tooling; no real‑socket/live network evidence; no production/customer‑facing exposure; no mutation/action behavior.

---

## Section I — Static Scan / Typecheck Requirements for M39

**Static scans must confirm M39 introduces none of:** package/lockfile changes; dependency installs; browser tooling; source/runtime changes outside `bcpTransportMatrix.test.ts`; server‑startup changes; sockets/listeners/ports; outbound network I/O; child/background processes; filesystem writes; DB/Supabase access; SQL; Supabase MCP; live‑provider calls; production/customer‑facing exposure; normal SaaS‑navigation exposure; mutation/action behavior; raw logs; raw command output; raw transport output; raw response dumps; raw header dumps; stack‑trace exposure; raw error exposure; runtime diagnostics exposure; package/dependency/version exposure; file‑path inventory exposure; process detail exposure; PID/port/timing exposure; `process.env` enumeration; environment‑value exposure; value‑oracle behavior; production‑readiness claims; unintended frozen‑source drift.

**Typecheck posture (M39):** 12 unrelated baseline errors unchanged if still visible; **0** errors in `bcpTransportMatrix.test.ts`; **0** in C‑07 files; **0** in `server/bcp-pilot`; **0** in `src/backend-control-plane`. Do **not** fix unrelated baseline errors.

---

## Section J — Transport / Browser Posture for M39

**Transport.** M39 extends the matrix but must not claim real‑socket evidence. After M39: C‑07 is included in the transport matrix evidence; **matrix (static/mock/in‑process) evidence only**, consistent with the existing matrix design; no live server smoke; no real‑socket evidence; no outbound network; no child/background process. Real‑socket live transport remains deferred.

**Browser.** No client/UI in M39; no browser tooling; no package/lockfile change; no browser evidence required. Browser evidence remains **waived for Phase 2.0 only** and must reopen before production readiness, Phase 3, Phase 4, or any customer‑facing release.

---

## Section K — Client / UI Decision

Client/UI remains **deferred** during the M39 matrix milestone. M39 must not authorize any `src/backend-control-plane/*` client/UI/screen file, `src/App.tsx`, or SaaS navigation. A future client/UI milestone should occur only after: (1) the C‑07 transport matrix extension is accepted and backed up; (2) the client contract is separately planned; (3) the UI card contract is separately planned; (4) screen registration is separately planned; and (5) browser evidence posture is reopened or explicitly deferred with owner approval.

---

## Section L — Baseline Reconfirmation (run at M38)

| Evidence | Expected | Observed at M38 |
|----------|----------|-----------------|
| Full BCP corpus | 1264/1264 | 1264/1264 (41/41 files green) |
| C‑07 route | 39/39 | 39/39 |
| C‑07 adapter | 26/26 | 26/26 |
| C‑07 registration | 18/18 | 18/18 |
| C‑07 provider | 43/43 | 43/43 |
| C‑07 read‑model | 41/41 | 41/41 |
| M27 transport matrix | 106/106 | 106/106 (still exactly 6 lenses) |
| C‑01..C‑06 | unchanged and green | unchanged and green |
| Typecheck | 12 baseline; 0 in `server/bcp-pilot`; 0 in `src/backend-control-plane`; 0 across C‑01..C‑07 | 12 baseline; 0 BCP‑scoped |
| Static scans | no package/lockfile change; no DB/Supabase/live exposure; no production/customer‑facing exposure; no raw env‑value/value‑oracle/log/diagnostics/package‑detail/command‑output/raw‑evidence/file‑path/production‑claim surface in C‑01..C‑07 lenses; no unauthorized client/UI change; `bcpTransportMatrix.test.ts` unchanged during M38 | all confirmed |

All accepted evidence was re‑run at M38 and matches the accepted baseline exactly. Nothing is marked NOT RUN.

---

## Section M — Independent Review Results

Three independent review passes ran (≥2 required); all findings were documentation‑only and are reconciled into this gate — none required a source/test/runtime change, so none was a blocker.

1. **Security / exposure / transport‑matrix review** — VERDICT: APPROVE‑WITH‑NITS. Verified against source that no exposure/leak is introduced (the C‑07 empty‑state and error envelopes carry no `FORBIDDEN_LEAK` marker), invariants are preserved, and the factual claims (five‑field `Lens`, `+18 → 124`, both count asserts) are correct. Reconciled: reworded the `flagEnv` characterization (metadata‑only for injectable C‑07).
2. **Planning / matrix‑row / test‑delta review** — VERDICT: APPROVE‑WITH‑NITS. Empirically confirmed (live 106 baseline + driving the real C‑07 handler/adapter through the matrix cases) that the row is exact and sufficient, the `+18 → 124` delta is correct, both count asserts must bump 6→7, and M39 is not forced into a second file. Reconciled: `sourceMode`/`freshness` camelCase; added the `pure>=12`/`edge>=2` loop‑guard clause; enumerated the two `C-01..C-06` label sites.
3. **Cross‑model governance / safety review (independent model)** — VERDICT: NEEDS‑REVISION (resolved). Reconciled: rewrote Section E to precisely scope what the matrix generators assert vs. what is structurally guaranteed vs. what is covered by other frozen tests (and stated M39 adds no route/proxy‑path evidence); recorded the full `FORBIDDEN_LEAK` set and required both C‑07 envelopes to pass unchanged; added stop condition #11 (any failed shared C‑07 assertion → STOP, never weaken/patch) and #12 (any regression / BCP‑typecheck / static‑scan failure → STOP even at +18).

After reconciliation, no residual finding requires any change outside this documentation gate.

---

## Section N — M38 Decision

**Decision A — C‑07 TRANSPORT MATRIX PLAN LOCKED; PROCEED TO SINGLE‑FILE MATRIX EXTENSION.**

Justification: the M37 baseline is safe and backed up; C‑07 is ready for matrix coverage (verified injectable‑compatible with the frozen pattern); the row values are exact (the existing five‑field `Lens` shape); the next implementation is limited to `bcpTransportMatrix.test.ts` only; no source/runtime/guard/server/route/adapter/client/UI change is needed; no real‑socket or browser evidence is required; and the test delta is predictable (+18 → 124).

---

## Section O — Next Governed Step Selection

**Candidate 1 — Phase 2.0 M39 — C‑07 Transport Matrix Extension Implementation.** SELECTED (Decision A). Modifies only `bcpTransportMatrix.test.ts` to add C‑07.

Candidates 2 (matrix + test cleanup), 3 (another docs‑only pass), and 4 (defer) are not selected.

---

## Section P — Non‑Readiness Statements

Phase 2.0 remains: **not** production readiness; **not** customer‑facing release; **not** Phase 3 controlled actions; **not** Phase 4 production readiness; **not** live DB/Supabase reads; **not** live‑provider reads; **not** Supabase auth enablement; **not** Firebase‑to‑Supabase cutover; **not** browser‑evidence completion for production/customer‑facing release.

Firebase remains authoritative. Supabase remains dormant/shadow/readiness‑only. Backend CP remains DEV‑only and read‑only in Phase 2.0. C‑07 transport matrix extension is **not** implemented during M38.

---

## Section Q — Verification Before Final Report

Verified: only the M38 documentation file was created; no source/test/transport‑matrix/frontend/backend/provider/read‑model/route/adapter/registration/guard/client/UI/screen file changed; `server/platform-identity/server.ts`, `bcpAuthorizationGuard.ts`, and `bcpTransportMatrix.test.ts` unchanged; `src/App.tsx` and main SaaS navigation unchanged; no package/lockfile/migration/seed/`shared/**`/auth/DB/Supabase change; `.replit` remains unstaged and untouched; the goose tarball remains untracked; `.gitattributes` remains absent; tests/scans/typecheck/planning findings reported honestly; nothing incorrectly marked NOT RUN; independent‑review verdict capture is explicit and honest.

Expected post‑M38 `git status`:

```
 M .replit
?? docs/phase-2.0-backend-control-panel-m38-c07-transport-matrix-extension-planning-gate.md
?? goose-x86_64-unknown-linux-gnu.tar.bz2
```

---

## Stop conditions for M39 (binding)

1. Any change to a file other than `server/bcp-pilot/bcpTransportMatrix.test.ts` → **STOP and report a blocker**.
2. Any change to the C‑07 guard entry, server mount, route/adapter source, provider, or read‑model to make the matrix pass → **STOP** (the matrix must exercise the frozen modules as‑is).
3. Any addition of a real‑socket / live‑server / outbound‑network / child‑process test → **STOP**.
4. Any weakening or removal of a C‑01..C‑06 matrix assertion (beyond the count/comment/label bump) → **STOP**.
5. Any new bespoke C‑07 assertion that bypasses the shared `pureHandlerCases` / `adapterEdgeCases` generators or the `assertNoRawEvidence` / `assertHintsNotLeaked` guards → **STOP** (C‑07 must ride the uniform contract).
6. Any DB/SQL/Supabase/Supabase‑MCP/live‑provider/mutation/action introduction → **STOP**.
7. Any raw log/command/transport/response/header/env‑value/diagnostics/stack‑trace/production‑readiness/value‑oracle exposure → **STOP**.
8. Any client/UI/screen/`src/App.tsx`/SaaS‑nav/package/lockfile/migration/seed/`shared/**`/auth/DB change → **STOP**.
9. Any touch of `.replit`, `.gitattributes`, or the goose tarball → **STOP**.
10. If the observed test delta is not `+18` (→ 124), M39 must **STOP and reconcile** the discrepancy before claiming acceptance.
11. Any FAILED generated C‑07 shared matrix assertion — e.g. valid‑principal `GET` not `200` with a non‑null success body, induced‑throw `catch` not `500 { status: 'error' }`, `HEAD` not `200` no‑body, dev‑off/feature‑off not `404`, guard not `403`/`409`, or any `assertNoRawEvidence` / `assertHintsNotLeaked` failure → **STOP and report**. The governed response to a failing C‑07 case is investigation — never weaken the assertion, never edit frozen source to force a pass.
12. Any matrix or full‑corpus regression, any new BCP‑scoped typecheck error, or any prohibited static‑scan finding — **even when the case‑count delta is exactly +18** → **STOP and reconcile** before claiming acceptance.
