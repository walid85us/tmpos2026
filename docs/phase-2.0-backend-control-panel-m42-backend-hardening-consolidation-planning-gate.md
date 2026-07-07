# Phase 2.0 — Backend Control Panel (BCP) — M42 Backend Hardening Consolidation Planning Gate

**Status:** DOCS-ONLY planning gate. Proposed, not implemented. No source, test, frontend, client, package, runtime, DB, Supabase, or generated artifact was changed by M42.
**Artifact status:** Draft artifact pending owner acceptance and scoped commit — not yet committed.
**Accepted checkpoint at gate time:** `3c34da2f533533866ddf667ec2622c0c5c2cc41b`
**Most recent committed milestone:** Phase 2.0 M41 — add backend control panel C07 client sanitizer
**Gate decision:** **Decision B — Partial backend hardening plan locked; proceed to a limited, single consolidated M43 implementation** (combine stale-comment cleanup + guard-hardening; defer DEV-gate tightening to a dedicated freeze-aware coordinated milestone).
**M42 replaces** the previously planned C-07 UI-card planning gate. UI-card / screen-registration work remains deferred until backend closeout is accepted.

---

## 1. Executive Summary

M42 is a docs-only consolidation gate whose purpose is to determine the **smallest safe combined backend-hardening implementation package** for M43, without implementing anything.

Three accepted post-M41 backend residuals were inventoried and independently assessed:

1. **Stale M35-era C-07 route/adapter comments** — the C-07 route and adapter still carry M35 "guard-gap / INERT / UNREACHABLE-until-M36 / not-mounted / no-provider-wiring" narratives that are now factually false: the additive `'C-07'` guard entry exists, the route is mounted in `server.ts`, and the provider is wired. This is a **comments-only** documentation-vs-code drift; behavior is already correct.
2. **Guard-hardening edge** — the shared authorization guard looks up `CONTRACT_MIN_VISIBILITY[req.contractId]` on a plain object literal, so a `contractId` equal to an inherited `Object.prototype` key (`__proto__`, `constructor`, `toString`, `valueOf`, `hasOwnProperty`, `isPrototypeOf`) resolves to a truthy inherited member and can fall through to `allow`. It is a **genuine dual logic bug** in the pure guard, but **not live-exploitable**: every call site pins `contractId` to a hardcoded `C-0X` literal and no request field flows into it.
3. **DEV-gate exact-development tightening** — every adapter (C-01..C-07) resolves DEV as `process.env.NODE_ENV !== 'production'` (a negative gate that treats unset / empty / mistyped / staging `NODE_ENV` as DEV). The exact-development target is a positive, fail-closed allow-list. This is a real defense-in-depth weakness, but it is bounded by the per-route default-off feature flag, and **cannot be fixed consistently without modifying the frozen C-01..C-06 adapters**.

**Conclusion.** Residuals 1 and 2 are safe, bounded, additive, and test-safe to combine into a single M43 implementation. Residual 3 cannot be combined safely without violating the C-01..C-06 freeze or creating a divergent per-lens security posture; it is deferred to a dedicated, separately-authorized, freeze-aware family-wide milestone. Real-socket live-transport evidence and UI-card / screen-registration remain deferred. Independent security/authorization review, independent hardening/test-package review, cross-model governance review (drafting and finalization), a documentation-quality pass, and a named accept-readiness verification pass were all run across all three required lens families; all findings are reconciled in this document.

---

## 2. Preflight Result

| Check | Expected | Observed | Result |
|---|---|---|---|
| Branch | `main` | `main` | PASS |
| HEAD | `3c34da2…` | `3c34da2f533533866ddf667ec2622c0c5c2cc41b` | PASS |
| origin/main == HEAD | equal | equal | PASS |
| ahead / behind | 0 / 0 | 0 / 0 | PASS |
| Nothing staged | empty | empty | PASS |
| `.gitattributes` | absent | absent | PASS |
| M41 commit present | yes | `3c34da2 Phase 2.0 M41 add backend control panel C07 client sanitizer` | PASS |
| Working tree | only `M .replit` + `?? goose…` (+ this M42 doc) | package drift found, confirmed unrelated, then **restored to HEAD** | **RESOLVED** |

**Discrepancy — found, diagnosed, and RESOLVED.** During the M42 finalization pass the working tree carried **pre-existing, unstaged** modifications to `package.json` and `package-lock.json`, in addition to the expected `M .replit` and untracked `goose…` tarball. Diagnosis confirmed the drift was **unrelated accidental package drift** from an earlier `@zvec/zvec` install and **not** introduced by M42: HEAD contained no `@zvec/zvec`; the `package.json` diff was a single added dependency line; the `package-lock.json` diff added only `@zvec/zvec` and its transitive dependencies (`bindings`, `file-uri-to-path`); and **no source file in `src/` or `server/` imports `@zvec/zvec`** (it is entirely unused). It is therefore not required for M42 documentation, not required for the accepted M41 client/sanitizer code, not required for any test to run (tests execute via `tsx` on `.ts` source with no `@zvec/zvec` import), and not part of any accepted milestone.

**Resolution.** Both package files were **restored to HEAD** via `git restore package.json package-lock.json` (never staged, never committed). Post-restore the working tree shows exactly `M .replit`, `?? docs/…m42…planning-gate.md`, and `?? goose…`; `package.json` and `package-lock.json` match HEAD cleanly. Package files are **not** part of M42 and will **not** be committed. The M42 scoped commit will use **selective staging** (`git add` of only the M42 doc — never `git add .` / `-A` / `--all`). Preflight is a clean PASS: the gate builds from the exact accepted M41 checkpoint. No implementation, commit, push, or backup occurs during M42.

---

## 3. Files Created

- `docs/phase-2.0-backend-control-panel-m42-backend-hardening-consolidation-planning-gate.md` (this file).

## 4. Files Modified

- None. M42 modifies no source, test, frontend, client, config, package, runtime, DB, or generated file.

## 5. Files Confirmed Untouched

Backend source, backend tests, transport matrix, all providers/read-models/routes/adapters/registrations, the authorization guard, `server/platform-identity/server.ts`, all C-07 client files, `screens.tsx`, `src/App.tsx`, SaaS navigation, `package.json`, `package-lock.json`, migrations, seeds, `shared/**`, auth / audit-writer / identity-repository / sessionResolve, DB/Supabase files, browser tooling. `.replit` remains unstaged and untouched; the `goose…` tarball remains untracked; `.gitattributes` remains absent.

---

## 6. M41 Backup and Baseline Review

| # | Item | Confirmed |
|---|---|---|
| 1 | M41 commit hash | `3c34da2f533533866ddf667ec2622c0c5c2cc41b` |
| 2 | M41 commit subject | Phase 2.0 M41 add backend control panel C07 client sanitizer |
| 3 | origin/main matches local HEAD | Yes |
| 4 | Push was fast-forward, non-force | Yes (per M41 acceptance record) |
| 5 | Exactly two files committed | `src/backend-control-plane/bcpC07Client.ts` + `bcpC07Client.test.ts` |
| 6 | No backend source/test files committed | Confirmed |
| 7 | No transport-matrix file committed | Confirmed |
| 8 | No UI card committed | Confirmed |
| 9 | No `screens.tsx` / `App.tsx` / SaaS nav committed | Confirmed |
| 10 | No package/lockfile change committed | Confirmed |
| 11 | No DB/Supabase/live-provider access | Confirmed |
| 12 | C-07 client tests | 67/67 (per M41 record) |
| 13 | Full BCP corpus | 1349/1349 (per M41 record) |
| 14 | Test files | 42/42 green (per M41 record) |
| 15 | Typecheck | 12 baseline errors, 0 BCP-surface errors |
| 16 | Static scan | Clean |
| 17 | Browser evidence | Deferred (waived Phase 2.0 only) |
| 18 | Real-socket live transport | Deferred |
| 19 | M41 residuals | Accepted |

Since `HEAD == origin/main == 3c34da2` and no file changes in M42, the accepted M41 checkpoint **is** the pre-change backup checkpoint for M42.

---

## 7. Backend Residual Inventory

### Residual 1 — Stale M35-era C-07 route/adapter comments

- **Files:** `server/bcp-pilot/bcpC07DataSourceBoundaryReadOnlyRoute.ts`, `server/bcp-pilot/bcpC07DataSourceBoundaryReadOnlyExpressAdapter.ts`.
- **Nature of stale comments:** The route header and its `GUARD-GAP` block assert the shared guard maps C-01..C-06 only, that a pinned `'C-07'` therefore returns `deny('unknown_contract')`, and that the 200 success branch is "structurally present but UNREACHABLE until an additive 'C-07' guard entry is separately authorized (M36)." The adapter header asserts the route is "NOT mounted," "does not touch server.ts," and has "no C-07 provider wiring in M35."
- **Current live reality:** The additive `'C-07': 'overview_viewer'` guard entry exists; the route **is** mounted in `server.ts`; the provider **is** wired via the `getDataSourceBoundaryItems` seam. With the always-`ready` synthetic principal, an enabled + DEV GET now reaches the authorized 200 envelope path. The comments materially misstate the live posture — an **auditability drift**, not a runtime defect.
- **Behavior already correct:** Yes. No runtime change is required; only the prose is wrong.
- **Cleanup is comments-only:** Yes.
- **Test change required:** None for correctness (see §17). Comment cleanup causes **zero test drift** (proven below).
- **Combine into M43 safely:** **Yes.**

### Residual 2 — Guard-hardening edge

- **File:** `server/bcp-pilot/bcpAuthorizationGuard.ts`.
- **Exact edge condition:** `CONTRACT_MIN_VISIBILITY` is a plain object literal that inherits from `Object.prototype`. `authorizeBcpRead` performs `const required = CONTRACT_MIN_VISIBILITY[req.contractId]; if (!required) return deny('unknown_contract')`. For `contractId ∈ { '__proto__', 'constructor', 'toString', 'valueOf', 'hasOwnProperty', 'isPrototypeOf' }`, the lookup returns a **truthy inherited member**, so the `unknown_contract` deny is skipped; the subsequent `VISIBILITY_RANK[required]` coerces the inherited value to a non-rank key → `undefined`, and `principalRank < undefined` is `false`, so the `insufficient_visibility` deny is also skipped. The function falls through to `allow`. It is a **dual logic bug** (bypasses both the unknown-contract deny and the visibility-rank comparison), independently confirmed.
- **Reachable:** **No, not via any live path.** Every caller pins `contractId` to a hardcoded literal (`bcpReadOnlyRoute` `'C-01'`; C-02 `'C-02'`; … C-07 `'C-07'`), and no route request descriptor carries a client-settable `contractId` field. The only non-literal callers are tests passing literals such as `'C-99'`. There is no HTTP path that reaches the inherited-name branch.
- **Security-relevant:** Latent defense-in-depth (low current severity); it becomes live only if a future caller ever passes a request-derived `contractId`. It is a latent hazard in shared infrastructure and worth closing at the single choke point.
- **Safest fix shape:** An own-property membership guard, strictly additive:
  ```ts
  if (!Object.prototype.hasOwnProperty.call(CONTRACT_MIN_VISIBILITY, req.contractId)) {
    return deny('unknown_contract');
  }
  const required = CONTRACT_MIN_VISIBILITY[req.contractId];
  ```
  (`Object.hasOwn(...)` is equivalent on modern runtimes; `hasOwnProperty.call` is chosen for the widest target compatibility.) For every real pinned literal `'C-01'..'C-07'` the membership check returns true, so the lookup, rank comparison, and decision are byte-for-byte unchanged; the only inputs whose outcome changes are the inherited-property names, which flip from an erroneous `allow` to a correct `deny('unknown_contract')`. `Object.create(null)` and `Map` also close the hole but carry a larger diff on shared C-01..C-07 infrastructure — the one-line own-property guard has the lowest blast radius.
- **Files to touch:** `server/bcp-pilot/bcpAuthorizationGuard.ts` (source) + one test file for the new deny cases (see §17).
- **Guard file freeze status:** The shared guard is **not** a frozen lens; it is shared C-01..C-07 infrastructure that has already been extended additively (the M36 `'C-07'` row). It is safe to modify. Risk to the existing C-01..C-06 `overview_viewer` mappings from this fix: **none** — the fix does not touch the map contents and does not alter any own-key lookup.
- **Combine into M43 safely:** **Yes.**

### Residual 3 — DEV-gate exact-development tightening

- **Files:** DEV gate is inlined in each adapter as `process.env.NODE_ENV !== 'production'` (C-01 `bcpReadOnlyExpressAdapter`, plus C-02..C-07 adapters). `server/platform-identity/server.ts` mounts all BCP routes **unconditionally**; there is no mount-level DEV gate. `server/bcp-pilot/bcpPilotConfig.ts` uses the positive `NODE_ENV === 'production'` form, but that helper governs only the C-01 foundation flag — it is **not** the per-adapter DEV gate.
- **Current DEV-gate posture:** Negative gate — any environment where `NODE_ENV` is not exactly `'production'` (unset, empty, `staging`, typos, preview/QA) is treated as DEV.
- **Exact-development target posture:** Positive allow-list (`NODE_ENV === 'development'`, or an explicit small allowed set) that fails **closed** on any unexpected value.
- **Could changing this affect existing C-01..C-07 dev routes:** The **test-breakage** risk is low — adapter tests inject `isDevEnvironment` via dependency injection and do not rely on the default resolver. The real blockers are governance, not tests:
  1. There is **no shared DEV chokepoint**; the check is inlined seven times. A **consistent** family-wide tightening requires editing every adapter's default (which touches the **frozen** C-01..C-06 adapters) or introducing a shared resolver and retrofitting all seven adapters (also modifies the frozen files).
  2. A **C-07-only** tightening would leave six siblings on `!== 'production'` while C-07 uses `=== 'development'` — a **divergent, inconsistent security posture** across one lens family, which is itself an audit finding and a trap for future readers who assume family uniformity, for marginal benefit.
- **Exposure is double-gated:** The negative DEV gate alone exposes nothing, because each route is **also** behind a default-OFF feature flag. Real leakage would require both a non-production / misconfigured `NODE_ENV` **and** the per-route `C-0X` flag set to `'true'` on that host. The value of tightening is defense-in-depth, not closing a live hole.
- **Safest fix shape (for the eventual dedicated milestone):** One shared fail-closed DEV resolver (positive allow-list) placed in a shared module (e.g. `bcpPilotConfig.ts`), with **all seven** adapters routed through it — a coordinated change that necessarily lifts/coordinates the C-01..C-06 freeze.
- **Expected files to touch (eventual milestone):** the shared resolver module + all seven adapters (frozen C-01..C-06 included) + the adapters' default-resolver tests.
- **Combine into M43 safely:** **No.** Defer to a dedicated, separately-authorized, freeze-aware milestone.

### Residual 4 — Real-socket live-transport deferral

- Real-socket / live-transport evidence is **not** necessary before backend closeout. It requires a different evidence surface (server startup, port binding, runtime transport), and may require integration or browser tooling. It should remain deferred in Phase 2.0 and, if ever required, be planned as a later dedicated milestone — **not** mixed with comment/guard/DEV-gate hardening. See §11.

### Residual 5 — Browser-evidence waiver

- Browser evidence remains **waived for Phase 2.0 only** and is not needed for backend hardening. It must reopen before production readiness, Phase 3, Phase 4, or any customer-facing release.

---

## 8. Stale Comment Cleanup Assessment

- **Scope:** Comments only, in the two C-07 files named in Residual 1. Update the M35 "guard-gap / inert / unreachable / not-mounted / no-provider-wiring" narratives to reflect the current mounted, guard-entried, provider-wired reality. Preserve every real safety statement (DEV-only, default-off, code/config-only, no live read, no production-readiness claim, safe errors, contract pinned server-side).
- **No-drift proof (independently verified):** Every test that reads either changed file's raw text strips comments **before** scanning, and no test greps for the stale prose strings:
  - `bcpC07RouteRegistration.test.ts` reads both files (via its path-files array) but applies a `strip()` that removes `//…` and `/* … */` before every assertion, and scans only for functional substrings.
  - `bcpC07DataSourceBoundaryReadOnlyRoute.test.ts` does not read either changed file's raw text; it imports normally and asserts behavior (e.g. `C-99 → unknown_contract`).
  - `bcpC07DataSourceBoundaryReadOnlyExpressAdapter.test.ts` reads its own source into a comment-stripped buffer and checks only dangerous-operation substrings and `server.ts` mount markers — never the route/adapter comment prose.
  - `bcpTransportMatrix.test.ts` does not read either changed file.
- **Conclusion:** Comment cleanup is **behavior-preserving and test-safe** — zero functional drift, zero test change required. The static scan (comment-stripped) confirms no functional change.

---

## 9. Guard-Hardening Assessment

- **Defect:** Confirmed dual logic bug (see Residual 2). Root cause is a single shared plain-object lookup; the fix is a **root-cause fix at the one choke point** all seven contracts route through, not a per-caller patch.
- **Reachability:** Not reachable via any live path (all call sites pin literal contract ids); low current severity, meaningful as defense-in-depth in shared infrastructure.
- **Fix:** One-line own-property membership guard ahead of the existing lookup; strictly additive; same `GuardResult` shape; reuses the existing `deny('unknown_contract')` path; no I/O; no new field or log surface.
- **Regression guarantee:** C-01..C-07 pinned-literal outcomes are byte-for-byte unchanged; only inherited-property names change (erroneous `allow` → correct `deny`).
- **Tests:** Add prototype-key deny cases (see §17).
- **Combine into M43 safely:** Yes.

---

## 10. DEV-Gate Tightening Assessment

- **Verdict: DEFER** to a dedicated, freeze-aware, family-wide coordinated milestone. A C-07-only tightening is **not** advisable (inconsistent posture); a consistent tightening cannot be done in M43 without modifying the frozen C-01..C-06 adapters. The correct fix is a single shared fail-closed DEV resolver routed through all seven adapters, which requires owner authorization to coordinate the C-01..C-06 freeze.
- **Interim posture:** The negative gate is bounded by the per-route default-off feature flag and by `NODE_ENV === 'production'` returning false in both forms, so the routes are **production-disabled but not yet exactly-development-gated**. As an **operational** mitigation (no code change), `NODE_ENV` should be set explicitly (`production`) on every deployed host so the negative gate cannot fail open.
- **If never authorized:** M44 records the negative DEV gate as an accepted, flag-gated, defense-in-depth residual.

---

## 11. Real-Socket / Live-Transport Decision

**Decision:** Real-socket live-transport evidence remains **deferred** and is **not** part of M43. Reasons: it requires a distinct evidence surface (server startup / port / runtime), may require browser or integration tooling, and increases risk. If it is ever required before backend closeout, it must be planned as a **separate future milestone**, never folded into the comment/guard hardening. M42 does **not** recommend real-socket evidence as a prerequisite for backend closeout.

---

## 12. UI / Client Decision

**Decision:** UI card, screen registration, and browser evidence remain **deferred** until backend hardening and backend closeout are accepted. The existing C-07 client/sanitizer remains **accepted and unchanged**. M43 must **not** touch `src/backend-control-plane/bcpC07Client.ts`, `src/backend-control-plane/bcpC07Client.test.ts`, any C-07 UI card file, `screens.tsx`, `src/App.tsx`, or SaaS navigation.

---

## 13. Combined M43 Implementation Options

| Option | Scope | Risk | M42 evaluation |
|---|---|---|---|
| **A — Combined all** | comment + guard + DEV-gate + tests | Medium→High | **Rejected.** DEV-gate cannot be safely scoped without touching frozen C-01..C-06 adapters or creating divergence. Precondition for Decision A is not met. |
| **B — Comments + guard only** | comment cleanup + guard hardening + guard tests | Low | **Selected.** Both items are bounded, additive, root-cause, and test-safe; DEV-gate deferred. |
| C — DEV-gate only | positive DEV allow-list | Medium→High | Not now. DEV-gate is the deferred item; needs a coordinated freeze-aware milestone. |
| D — Comments only | comment cleanup only | Very low | Not chosen. Guard hardening is safe and valuable; excluding it would waste a milestone. |
| E — Another docs-only pass | re-plan | — | Not needed. The exact package and tests are lockable now. |
| F — Blocked | — | — | Not applicable. No safety/exposure/authority blocker for the selected package. |

---

## 14. Selected M43 Implementation Package

**Option B — Limited combined backend hardening (comments + guard).**

- **Change A:** Stale-comment cleanup in the two C-07 files (comments only, behavior unchanged).
- **Change B:** Guard-hardening own-property fix in the shared authorization guard + focused deny tests.
- **Change C (DEV-gate):** **Excluded / deferred** to a dedicated freeze-aware coordinated milestone.

---

## 15. Allowed Files for M43

Exactly the following, each justified:

| File | Type | Why necessary |
|---|---|---|
| `server/bcp-pilot/bcpC07DataSourceBoundaryReadOnlyRoute.ts` | source (comment-only) | Correct the stale M35 guard-gap / unreachable narrative to current reality. |
| `server/bcp-pilot/bcpC07DataSourceBoundaryReadOnlyExpressAdapter.ts` | source (comment-only) | Correct the stale "not mounted / no provider wiring" narrative. |
| `server/bcp-pilot/bcpAuthorizationGuard.ts` | source | Add the own-property membership guard (root-cause fix). |
| `server/bcp-pilot/bcpPilot.test.ts` | test | Add prototype-key `unknown_contract` deny cases (primary guard-test home). |
| `server/bcp-pilot/bcpC07DataSourceBoundaryReadOnlyRoute.test.ts` | test (optional) | Optionally mirror one prototype-key deny case next to the existing `C-99` check for local convention parity. |

No other file may be created or modified in M43. The two comment-only files carry **no** runtime change.

## 16. Prohibited Files for M43

Prohibited by default (unless a future, separately-authorized milestone changes scope): C-07 provider/read-model source and tests; C-07 client files (`bcpC07Client.ts`, `bcpC07Client.test.ts`); UI card files; `screens.tsx`; `src/App.tsx`; SaaS navigation; the transport matrix; **all frozen C-01..C-06 adapters/routes/providers/read-models/registrations**; `server/platform-identity/server.ts` (no mount change); `package.json`; `package-lock.json`; migrations; seeds; `shared/**`; auth / audit-writer / identity-repository / sessionResolve; DB/Supabase files; browser tooling; generated artifacts; `.replit`; `.gitattributes`; the `goose…` tarball.

**Stop conditions:** if implementing Change A or Change B would require touching any prohibited file (including any frozen C-01..C-06 adapter for the DEV gate), **stop** and return to a planning gate.

---

## 17. M43 Test Requirements

**Regression (must remain green):**

| Suite | Count | Constraint |
|---|---|---|
| `bcpC07RouteRegistration.test.ts` | 18/18 | pinned (server.ts untouched) |
| `bcpC07DataSourceBoundaryReadOnlyExpressAdapter.test.ts` | 26/26 | pinned |
| `bcpC07DataSourceBoundaryProvider.test.ts` | 43/43 | pinned |
| `bcpC07DataSourceBoundaryReadModel.test.ts` | 41/41 | pinned |
| `bcpTransportMatrix.test.ts` | 124/124 | pinned |
| `bcpC07DataSourceBoundaryReadOnlyRoute.test.ts` | 39/39 | pinned (optional mirror excluded from the locked plan) |
| `bcpPilot.test.ts` | 33/33 | grows by exactly +1 → 34/34 (the single Change-B delta) |
| C-01..C-06 route/adapter/provider/read-model/registration suites | all green | pinned, untouched |
| Full BCP corpus | green | pinned, except the single +1 delta in `bcpPilot.test.ts` |

**New / grown (Change B) — exact, locked:**
- `bcpPilot.test.ts` — adds **exactly one (+1)** new test case: a single `test()` that loops over `['__proto__','constructor','toString','valueOf','hasOwnProperty','isPrototypeOf']` and, for each key, asserts `decision === 'deny'` and `reasonCode === 'unknown_contract'`, mirroring the existing "malformed visibility class" defense-in-depth test. Count moves **33 → 34**. This is the sole Change-B test delta.
- The optional mirror in `bcpC07DataSourceBoundaryReadOnlyRoute.test.ts` (next to the existing `C-99` check) is **excluded** from the locked plan; that suite stays pinned at **39/39**. M43 may add it only by also updating this matrix, which is not part of the locked package.

**Guard-hardening proof obligations:** no inherited-property (prototype-key) lookup bypass remains (every prototype-key `contractId` denies with `unknown_contract`); C-01..C-07 guard mappings remain exact; the C-07 authorized 200 remains real and guard-gated; no authorization bypass; no raw diagnostics or authority leak.

**Comment-cleanup proof obligation:** behavior unchanged; static scan (comment-stripped) confirms no functional drift.

**DEV-gate obligations:** not applicable to M43 (deferred).

---

## 18. M43 Static-Scan / Typecheck Requirements

**Static scan must confirm no introduction of:** package/lockfile change; dependency install; browser tooling; client/UI/screen change; normal SaaS-navigation or customer-facing exposure; backend action/mutation behavior; DB/Supabase/SQL/live-provider access; production-readiness claim; raw logs / command / transport / response / header dumps; stack-trace or raw-error exposure; runtime/process/PID/port/timing/env-value exposure; package/dependency/version or file-path inventory exposure; value-oracle behavior; real-socket/live-transport evidence.

**Typecheck must confirm:** 12 unrelated baseline errors unchanged (do **not** fix them); 0 errors in every touched M43 file; 0 errors in `server/bcp-pilot`; 0 errors in `src/backend-control-plane`; 0 errors across all C-01..C-07 BCP surfaces.

---

## 19. Backend Closeout Strategy

Recommended sequence after M43 backup:

- **Phase 2.0 M44 — Backend Control Plane Backend Closeout / Freeze Gate** (docs-only unless M43 reveals a blocker). M44 confirms: all C-01..C-07 backend/read-only evidence green; C-07 client/sanitizer green; residual backend hardening complete or explicitly deferred; Backend CP remains DEV-only / read-only; no production-readiness claim; no customer-facing exposure; no DB/Supabase/live-provider access; no mutation/control actions; browser evidence waived Phase 2.0 only; real-socket evidence deferred or separately planned; UI path may resume only after backend closeout.
- **DEV-gate handling at closeout:** M44 either (a) schedules the dedicated freeze-aware family-wide DEV-gate tightening milestone (shared fail-closed resolver across all seven adapters), or (b) records the negative DEV gate as an accepted, flag-gated, defense-in-depth residual with the operational `NODE_ENV=production` mitigation.

---

## 20. Baseline Reconfirmation

`HEAD == origin/main == 3c34da2`; ahead/behind 0/0; no source, test, or runtime file changed by M42. The full BCP corpus was re-run in this finalization pass (below) and matches the accepted M41 baseline.

## 21. Test Results

Safe summary (full BCP corpus re-run in the M42 finalization pass, after the package-file restore; each suite self-reports pass/fail and exits accordingly):

- **Full BCP corpus: 1349/1349 across 42/42 test files — no failures** (freshly re-run this pass, not inherited).
- C-07 client: 67/67
- C-07 route: 39/39 · C-07 adapter: 26/26 · C-07 registration: 18/18 · C-07 provider: 43/43 · C-07 read-model: 41/41
- C-07 transport matrix (C-01..C-07): 124/124
- Guard / pilot harness: 33/33
- C-01..C-06 suites: green and unchanged

No source, test, or runtime file changed in M42; the restore touched only the package manifest/lock (which no source imports), so the corpus result is unaffected by the restore and matches the accepted baseline.

## 22. Typecheck Result

Safe summary: **12** total TypeScript errors — exactly the documented baseline, re-run post-restore in this finalization pass and unchanged. 0 on `server/bcp-pilot`, `src/backend-control-plane`, or any C-01..C-07 surface. Baseline errors are unrelated and were not touched.

## 23. Static Scan Results

Clean. No source, test, package, client, UI, DB/Supabase, browser-tooling, or generated-artifact change was introduced by M42 (docs-only). No raw logs, command output, transport output, secrets, identifiers, or diagnostics are exposed in this document.

## 24. Independent Review Results

Per Section K, independent reviews were run across two phases (drafting and finalization) and across all three required lens families — specialist/subagent, cross-model, and a named antigravity/superpowers skill. Verdicts are captured honestly and reconciled; reported neutrally (no tool attribution). **Drafting-pass reviews:**

1. **Security / authorization / DEV-gate planning review — PASS with reconciled findings.** Confirmed the guard inherited-property bug as a real dual logic defect and confirmed it is not live-exploitable (all call sites pin literal contract ids). Recommended the one-line own-property guard as the additive root-cause fix. Recommended **deferring** DEV-gate tightening (cannot be consistently fixed without touching frozen C-01..C-06 adapters; C-07-only creates divergence). Flagged the stale C-07 safety comments as contradicting the live guard entry — corrected into the M43 comment-cleanup scope. All findings incorporated above.
2. **Backend hardening / implementation-package planning review — PASS.** Verified comment cleanup causes zero test drift (every raw-text read strips comments first); identified `bcpPilot.test.ts` as the canonical guard-test home (with an optional mirror in the C-07 route test); locked the exact regression matrix and the single justified test-count delta; confirmed the static-scan and typecheck gates. All findings incorporated above.
3. **Cross-model governance review — NEEDS-REVISION → reconciled to PASS.** The cross-model pass confirmed Decision B as the correct conservative call (Decision A would violate the C-01..C-06 freeze; a C-07-only tightening would create divergence) and confirmed the own-property guard as a sound, minimal root-cause fix. It raised six findings: two major (review verdicts must be captured inline rather than placeholdered; the summary "DEV-only" phrasing must not overclaim the current non-production-gated posture), two minor (lock the exact M43 test-count delta; remove the dirty-package-file handling contradiction against the scoped commit), and two nits (label the guard defect an inherited-property / prototype-key lookup bypass rather than "prototype pollution"; Decision B needs no change). All six are reconciled in this revision — see §§10, 17, 25, 29, 33–34 and the terminology corrections in §17.
4. **Documentation-quality pass (named antigravity skill) — PASS (publication-ready).** Returned only minor register/clarity items (informal terms and one missing preposition), all applied; confirmed the formal normative voice; required no factual or structural change.

**Finalization-pass reviews (this correction pass):**

5. **Named accept-readiness verification lens (superpowers family) — PASS.** A named superpowers skill independently verified the finalization with fresh evidence: the package drift was diagnosed as unrelated `@zvec/zvec` drift and restored to HEAD (clean tree = `M .replit` + this doc + goose; nothing staged); the full BCP corpus re-ran 1349/1349 across 42 files and typecheck held at 12 baseline / 0 BCP-surface; exactly one new file (this doc) exists; and Decision B, the M43 package, and the deferrals are intact. All six checks returned PASS. This is the named third-family lens previously missing from the recorded roster — now run and recorded. Findings: none blocking; no source/test/runtime change required; no effect on the M42 decision or the M43 file package.

6. **Cross-model governance finalization re-review — NEEDS-REVISION → reconciled to PASS.** Confirmed both finalization blockers were cleared and raised three documentation-consistency findings — one major (a scoped-commit line still described the restored package files as "dirty"; corrected to "match HEAD and must not be staged"), one minor (§20 said a "representative subset" was re-run, conflicting with the fresh full-corpus run in §21; corrected), and one nit (a stray "§3" cross-reference in §30; corrected to "§2"). All three were applied; none required a source/test/runtime change; none affected the M42 decision or the M43 file package.

No review finding across either phase required a source, test, or runtime change during M42; every actionable substantive finding is captured as an M43 requirement or an explicit deferral, and every finalization finding was a docs-only consistency fix applied in place. No review evidence was invented; all three lens families (specialist/subagent, cross-model, named antigravity/superpowers skill) were run, and no required lens was unavailable.

---

## 25. M42 Decision

**Decision B — Partial backend hardening plan locked; proceed to a single, limited consolidated M43 implementation.**

- Combine into M43: (A) stale C-07 comment cleanup + (B) guard-hardening own-property fix with focused deny tests.
- Defer: DEV-gate exact-development tightening (dedicated freeze-aware coordinated milestone), real-socket live-transport evidence, UI-card / screen-registration, browser evidence (Phase 2.0 waiver).
- Rationale: Decision A's precondition ("DEV-gate tightening can be safely scoped") is not met without violating the C-01..C-06 freeze or creating a divergent posture. Decision B combines as much as is safely possible while **preserving** the 100/100 governance, security, auditability, and backup standard.

---

## 26. Next Governed Step Selection

**Candidate 2 — Phase 2.0 M43 Limited Backend Hardening Implementation** (comment cleanup + guard hardening).

---

## 27. Recommended Next Milestone

**Phase 2.0 M43 — Limited Backend Hardening Implementation** (Option B), followed by **Phase 2.0 M44 — Backend Closeout / Freeze Gate**. The dedicated DEV-gate tightening milestone is authorized separately by the owner when ready to coordinate the C-01..C-06 freeze.

---

## 28. Stop Conditions for M43

Stop and return to a planning gate if any of the following arise during M43:
- Implementing Change A or Change B would require touching any prohibited or frozen file (including any frozen C-01..C-06 adapter for the DEV gate).
- The guard fix would change any C-01..C-07 pinned-literal outcome, or alter any existing `overview_viewer` mapping.
- Any regression count drops, or any pinned suite changes count without an explicitly justified, documented delta.
- Typecheck shows any new error, or a nonzero error in a touched file / `server/bcp-pilot` / `src/backend-control-plane` / any C-01..C-07 surface.
- Any static-scan violation (new dependency, client/UI/screen change, DB/Supabase/live access, raw-diagnostics/timestamp/value-oracle/production-readiness leak).
- Any need to add a runtime change to a comment-only file.

---

## 29. Non-Readiness Statements

Phase 2.0 remains: not production readiness; not customer-facing release; not Phase 3 controlled actions; not Phase 4 production readiness; not live DB/Supabase reads; not live provider reads; not Supabase auth enablement; not a Firebase→Supabase cutover; not browser-evidence completion for production / customer-facing release. Firebase remains authoritative. Supabase remains dormant / shadow / readiness-only. Backend CP remains DEV-only and read-only in Phase 2.0 — a posture currently enforced by a non-production (production-disabled) gate plus per-route default-off feature flags, with exact-development gating deferred to a coordinated freeze-aware milestone (§10). M42 does not implement hardening, does not implement UI, and does not implement real-socket evidence.

---

## 30. Risks / Accepted Residuals

- **Guard inherited-property edge** — real but not live-reachable; scheduled for M43 (Change B). Until M43, mitigated by all call sites pinning literal contract ids.
- **DEV negative gate (fail-open hazard)** — deferred; bounded by per-route default-off flags and by `NODE_ENV === 'production'` returning false in both forms; interim operational mitigation is to set `NODE_ENV=production` on deployed hosts. Correct fix requires a coordinated freeze-aware milestone.
- **Stale C-07 comments** — auditability drift; scheduled for M43 (Change A).
- **Real-socket live transport** — deferred; separate evidence surface.
- **UI card / screen registration** — deferred until backend closeout.
- **Browser evidence** — waived Phase 2.0 only; must reopen before production / Phase 3 / Phase 4 / customer-facing.
- **12 unrelated typecheck baseline errors** — outside Backend CP scope; must not be fixed here.
- **`package.json` / `package-lock.json` drift (`@zvec/zvec`)** — RESOLVED: confirmed unrelated accidental drift and **restored to HEAD** in this finalization pass; not part of M42; not staged; not committed (§2).
- **`.replit` and `goose…` tarball** — out of scope; must not be staged.

---

## 31. Git Status

After the M42 finalization pass (package drift restored to HEAD), the working tree shows exactly: `M .replit`, `?? docs/phase-2.0-backend-control-panel-m42-backend-hardening-consolidation-planning-gate.md`, `?? goose-x86_64-unknown-linux-gnu.tar.bz2`. Nothing is staged. `package.json` and `package-lock.json` match HEAD (restored, see §2). This is the expected final pre-acceptance state.

## 32. No Commit / Push / Backup Confirmation

M42 performed **no** commit, **no** push, and **no** backup. No file was staged. Only the single M42 documentation file was created. No implementation change occurred.

## 33. Acceptance Recommendation

**Decision B — ACCEPT: M42 PARTIAL BACKEND HARDENING PLAN LOCKED; READY FOR SCOPED COMMIT.** Both finalization blockers are cleared: (1) the `package.json` / `package-lock.json` drift was confirmed unrelated and restored to HEAD (§2), leaving the expected clean pre-acceptance working tree; and (2) the required named third-family review lens was run and recorded (§24). The gate delivers a fully lockable, low-risk, limited M43 package (Option B) with exact allowed/prohibited files, an exact test matrix, and explicit deferrals — all preserving the governance standard.

## 34. Recommended Next Step

**Phase 2.0 M42 — Scoped Commit and Backup Authorization** (selective `git add` of **only** the M42 doc — never `git add .` / `-A` / `--all`; fast-forward non-force push; backup report; do not stage `.replit` / `package.json` / `package-lock.json` / `goose…` / `.gitattributes`; `package.json` / `package-lock.json` now match HEAD and must not be staged). After M42 backup, proceed to **Phase 2.0 M43 — Limited Backend Hardening Implementation** per the Decision B package.

**Do not commit. Do not push. Do not run backup. Stop for owner review.**
