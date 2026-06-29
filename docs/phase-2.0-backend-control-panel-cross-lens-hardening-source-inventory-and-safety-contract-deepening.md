# Phase 2.0 M23 — Cross-Lens Hardening Source Inventory / Safety Contract Deepening

> **Status:** DRAFT pending owner review. Docs-only milestone. No source/test/runtime change. No commit, push, or backup performed in M23.
> **Accepted checkpoint at M23 start:** `1e26c8859b0db851745ad50f1be9a5cdd7d3d82c`
> **Most recent committed milestone:** Phase 2.0 M22 plan backend control panel cross-lens hardening

---

## 1. Executive Summary

M23 is a **docs-only safety-contract deepening** milestone. It freezes an implementation-ready cross-lens hardening contract across the six Backend Control Panel (BCP) read-only lenses C-01 through C-06, **without changing any code, test, route, client, UI, provider, read-model, package, migration, auth, DB, Supabase, configuration, or runtime behavior**, and without weakening any frozen baseline.

A safe source inventory of C-01..C-06 was performed (family-label level only). The seven M22 hardening topics were each deepened into an implementation-ready or deferral contract. The current accepted baseline was reconfirmed: **aggregate tests 980/980 (0 failures)**, **typecheck 12 unrelated baseline errors / 0 in BCP surfaces**, **static/exposure scan clean** (no live access, no value oracles, no raw diagnostics, no production-readiness claims in C-01..C-06).

**Deepening decision: Decision B — Cross-Lens Hardening Contract Partially Deepened; Safe for M24 Partial Implementation.** The single bounded, deterministically-executable, parity-preserving subset selected for the next implementation milestone is **Client Sanitizer / Closed Allow-List generalization for the three lower-rigor clients (C-01, C-02, C-03)**, raising them to the proven C-04/C-05/C-06 closed-enum standard. The **Live Transport Harness** is selected for a **dedicated subsequent milestone behind a sandbox-feasibility gate** (its risk is environmental, not code). All other hardening items are deferred with stated rationale. **The new read-only lens pause remains ACTIVE.**

---

## 2. Preflight Result (Section A)

| # | Check | Result |
|---|-------|--------|
| 1 | Branch is `main` | ✅ PASS |
| 2 | HEAD == origin/main == `1e26c8859b0db851745ad50f1be9a5cdd7d3d82c` | ✅ PASS |
| 3 | ahead/behind 0/0 | ✅ PASS |
| 4 | git status only `M .replit` + `?? goose-x86_64-unknown-linux-gnu.tar.bz2` | ✅ PASS |
| 5 | Nothing staged | ✅ PASS |
| 6 | `.gitattributes` absent | ✅ PASS |
| 7 | M22 commit present (`1e26c88`) | ✅ PASS |
| 8 | HEAD == origin/main ⇒ this is the pre-change backup checkpoint; no extra backup created | ✅ PASS |
| 9 | No source/test/backend/frontend/route/UI/package/migration/DB/Supabase/auth/runtime change will occur | ✅ HELD |
| 10 | No commit/push/backup will occur in M23 | ✅ HELD |

**Preflight passed.** Pre-change backup checkpoint confirmed at the accepted M22 commit; no additional backup required.

---

## 3. Files Created

- `docs/phase-2.0-backend-control-panel-cross-lens-hardening-source-inventory-and-safety-contract-deepening.md` (this file) — the only artifact.

## 4. Files Modified

- None.

## 5. Files Confirmed Untouched

Source, tests, frontend, backend, `server/platform-identity/server.ts`, `server/bcp-pilot/bcpAuthorizationGuard.ts`, `src/backend-control-plane/screens.tsx`, `src/App.tsx`, SaaS navigation, `package.json`, `package-lock.json`, migrations, seeds, `shared/**`, auth/audit-writer/identity-repository/sessionResolve, all DB/Supabase files, all C-01..C-06 implementation/test files. `.replit` unstaged/untouched; `goose` tarball untracked; `.gitattributes` absent.

## 6. Deepening Decision

**Decision B — Cross-Lens Hardening Contract Partially Deepened; Safe for M24 Partial Implementation.** (Full rationale in §41 / §P.)

---

## 7. M22 Backup and Planning Review (Section B)

| # | Confirmation | Status |
|---|--------------|--------|
| 1 | M22 commit hash `1e26c8859b0db851745ad50f1be9a5cdd7d3d82c` | ✅ |
| 2 | M22 subject "Phase 2.0 M22 plan backend control panel cross-lens hardening" | ✅ |
| 3 | origin/main matches local HEAD | ✅ |
| 4 | Push was fast-forward and non-force | ✅ (per M22 record `4e46f17..1e26c88`) |
| 5 | Exactly one docs file committed in M22 | ✅ |
| 6 | No source/test/frontend/backend/runtime change committed | ✅ |
| 7 | No package or lockfile change committed | ✅ |
| 8 | M22 selected M23 safety-contract deepening | ✅ |
| 9 | New read-only lens implementation remains paused | ✅ |
| 10 | Candidate I (Next Read-Only Lens Discovery Gate) deferred | ✅ |
| 11 | Candidate E (Audit/Security Posture Lens) HIGH risk, deferred | ✅ |
| 12 | Candidate F (Identity/Session Posture Lens) HIGH risk, deferred | ✅ |
| 13 | Browser evidence waived for Phase 2.0 only | ✅ |
| 14 | C-01..C-06 baselines unaffected | ✅ (reconfirmed §46) |

---

## 8. Cross-Lens Source Inventory Summary (Section C)

Inventory performed at **family-label** granularity (no raw code dumps, no large snippets, no raw file-path inventories beyond accepted implementation-family labels). All findings are safe summaries.

**Cross-lens uniformities (machine-verified):**
- **DEV gate:** every adapter uses the uniform production-disabled guard `process.env.NODE_ENV !== 'production'` (all adapters consistent).
- **Proxy:** every client resolves the identity base as `VITE_IDENTITY_API_BASE || '/__identity'` (same-origin dev proxy default), with `credentials: 'omit'` uniformly.
- **Authorization guard:** all six lenses require the same `overview_viewer` visibility floor. *(The role name `overview_viewer` is disclosed here as a documented least-privilege, read-only viewer invariant — it is not a secret, an RBAC key, or a credential, and confers no access; it is recorded deliberately as the cross-lens guard invariant, not as exposed permission data.)*
- **Method/transport contract:** uniform fail-closed gate order (DEV gate → default-off flag gate where applicable → OPTIONS 204 → method 405 → server guard → HEAD bodyless / GET 200).
- **Source authority:** every lens is server-owned code/config only; no DB, no Supabase, no live provider, no network, no filesystem on the data path.

**Cross-lens rigor gradient (machine-verified):**
- **Provider fitness assertions (test-time only, never on the runtime data path):** C-01 = 0, C-02 = 0, C-03 = 0, C-04 = 1, C-05 = 2, C-06 = 6.
- **Client sanitizer posture:** C-01/C-02/C-03 = denylist-only (closed allow-list sets = 0); C-04 & C-05 add closed allow-lists; C-06 strongest (allow-list + expanded denylist).
- **Feature flag:** C-01 has **no** flag (always-on in DEV — base readiness summary); C-02..C-06 each carry a distinct **default-off** `ENABLE_BCP_DEV_C0x_*` flag.

### 9. C-01 Source Inventory Summary — Readiness Summary

| # | Field | Safe summary |
|---|-------|--------------|
| 1 | Lens ID | C-01 |
| 2 | Purpose | Code/config readiness summary (foundation lens) |
| 3 | Route pattern | Base inert read-only route (shared `bcpReadOnlyRoute` family) on the isolated platform-identity API |
| 4 | Proxy pattern | `VITE_IDENTITY_API_BASE \|\| '/__identity'`, `credentials:'omit'` |
| 5 | Feature flag | **None** — always-on in DEV (foundation) |
| 6 | DEV gate | `NODE_ENV !== 'production'` (base adapter) |
| 7 | Production-disabled | Yes (DEV gate) |
| 8 | Provider source | `bcpReadinessSummaryHarness` family (server-owned, dependency-injected inputs) |
| 9 | Read-model / DTO | `bcpC01CodeConfigReadModel` family (pure, no-throw, safe-label projection) |
| 10 | Route handler | Shared base route handler family |
| 11 | Adapter | Shared base Express adapter family (reads only `req.method`) |
| 12 | Registration | Single `app.all` on the isolated API |
| 13 | Authorization guard | `overview_viewer` floor |
| 14 | Client parser | `bcpC01Client` family — GET-only, denylist sanitizer |
| 15 | UI card | `C01ReadinessCard` (button-load only, DEV shell) |
| 16 | Current sanitizer | Denylist-only (no closed allow-list) |
| 17 | Tuple/allow-list assertion | None at provider (0 fitness assertions) |
| 18 | Transport evidence | Route+adapter unit-tested; live matrix NOT RUN (sandbox lifecycle) |
| 19 | Browser evidence | Waived (Phase 2.0 only) |
| 20 | Tests / regression | C-01 family 106/106 (lens-specific 35 + shared foundation 71) |
| 21 | Frozen baseline | Frozen & safe |
| 22 | Accepted residuals | Live transport NOT RUN; browser waived; denylist-only client (candidate for allow-list hardening) |

### 10. C-02 Source Inventory Summary — Registry Readiness

| # | Field | Safe summary |
|---|-------|--------------|
| 1 | Lens ID | C-02 |
| 2 | Purpose | Module registry readiness posture |
| 3 | Route | Own `bcpC02ReadOnlyRoute` family |
| 4 | Proxy | `VITE_IDENTITY_API_BASE \|\| '/__identity'`, `credentials:'omit'` |
| 5 | Feature flag | `ENABLE_BCP_DEV_C02_REGISTRY_READINESS` (default-off) |
| 6 | DEV gate | `NODE_ENV !== 'production'` |
| 7 | Production-disabled | Yes |
| 8 | Provider | `bcpC02RegistryProvider` (server-owned) |
| 9 | Read-model/DTO | `bcpC02RegistryReadModel` (pure, no-throw; reads only module id/name/status) |
| 10 | Route handler | Own route handler family |
| 11 | Adapter | Own Express adapter family |
| 12 | Registration | Single `app.all` |
| 13 | Guard | `overview_viewer` |
| 14 | Client parser | `bcpC02Client` — GET-only, denylist sanitizer |
| 15 | UI card | `C02RegistryReadinessCard` |
| 16 | Sanitizer | Denylist-only |
| 17 | Tuple/assertion | 0 provider fitness assertions |
| 18 | Transport | Route+adapter unit-tested; live NOT RUN |
| 19 | Browser | Waived (Phase 2.0) |
| 20 | Tests | 122/122 |
| 21 | Frozen | Frozen & safe |
| 22 | Residuals | Live transport NOT RUN; denylist-only client (allow-list hardening candidate) |

### 11. C-03 Source Inventory Summary — UI Coverage Readiness

| # | Field | Safe summary |
|---|-------|--------------|
| 1–7 | Lens / purpose / route / proxy / flag / DEV gate / prod-disabled | C-03; UI coverage readiness; own `bcpC03ReadOnlyRoute` family; uniform proxy; `ENABLE_BCP_DEV_C03_UI_COVERAGE_READINESS` (default-off); `NODE_ENV !== 'production'`; yes |
| 8–13 | Provider / read-model / handler / adapter / registration / guard | `bcpC03UiCoverageProvider`; `bcpC03UiCoverageReadModel` (pure, no-throw, safe label/enum per field); own handler; own adapter; single `app.all`; `overview_viewer` |
| 14–17 | Client / UI / sanitizer / assertion | `bcpC03Client` GET-only denylist; `C03UiCoverageReadinessCard`; denylist-only; 0 provider fitness assertions |
| 18–22 | Transport / browser / tests / frozen / residuals | Unit-tested, live NOT RUN; browser waived; 126/126; frozen & safe; denylist-only client (allow-list hardening candidate) |

### 12. C-04 Source Inventory Summary — Route Exposure Readiness

| # | Field | Safe summary |
|---|-------|--------------|
| 1–7 | Lens / purpose / route / proxy / flag / DEV gate / prod-disabled | C-04; route exposure readiness; own `bcpC04ReadOnlyRoute` family; uniform proxy; `ENABLE_BCP_DEV_C04_ROUTE_EXPOSURE_READINESS` (default-off); `NODE_ENV !== 'production'`; yes |
| 8–13 | Provider / read-model / handler / adapter / registration / guard | `bcpC04RouteExposureProvider` (1 fitness assertion); `bcpC04RouteExposureReadModel` (pure, no-throw; closed-enum `DataSourcePosture` incl. `no_db`/`no_supabase` safe labels); own handler; own adapter; single `app.all`; `overview_viewer` |
| 14–17 | Client / UI / sanitizer / assertion | `bcpC04Client` GET-only; **closed allow-list + denylist**; `C04RouteExposureReadinessCard`; 1 provider fitness assertion |
| 18–22 | Transport / browser / tests / frozen / residuals | Unit-tested, live NOT RUN; browser waived; 146/146; frozen & safe; live transport NOT RUN |

### 13. C-05 Source Inventory Summary — Feature Flag / Environment Posture

| # | Field | Safe summary |
|---|-------|--------------|
| 1–7 | Lens / purpose / route / proxy / flag / DEV gate / prod-disabled | C-05; feature-flag/environment posture; own `bcpC05ReadOnlyRoute` family; uniform proxy; `ENABLE_BCP_DEV_C05_FEATURE_FLAG_POSTURE_READINESS` (default-off); `NODE_ENV !== 'production'`; yes |
| 8–13 | Provider / read-model / handler / adapter / registration / guard | `bcpC05FeatureFlagPostureProvider` (2 fitness assertions); `bcpC05FeatureFlagPostureReadModel` (pure, no-throw; **presence-only** flag posture — never flag values); own handler; own adapter; single `app.all`; `overview_viewer` |
| 14–17 | Client / UI / sanitizer / assertion | `bcpC05Client` GET-only; **closed allow-list + denylist**; `C05FeatureFlagPostureReadinessCard`; 2 provider fitness assertions |
| 18–22 | Transport / browser / tests / frozen / residuals | Unit-tested, live NOT RUN; browser waived; 170/170; frozen & safe; live transport NOT RUN |

### 14. C-06 Source Inventory Summary — Quality Gates / Evidence Coverage Posture

| # | Field | Safe summary |
|---|-------|--------------|
| 1–7 | Lens / purpose / route / proxy / flag / DEV gate / prod-disabled | C-06; quality-gates/evidence-coverage posture; own `bcpC06ReadOnlyRoute` family; uniform proxy; `ENABLE_BCP_DEV_C06_QUALITY_GATES_EVIDENCE_COVERAGE_READINESS` (default-off); `NODE_ENV !== 'production'`; yes |
| 8–13 | Provider / read-model / handler / adapter / registration / guard | `bcpC06QualityGatesEvidenceProvider` (**6 fitness assertions**; 12-category allow-list; production-readiness-claim ban-list); `bcpC06QualityGatesEvidenceReadModel` (pure, no-throw; closed-enum projection, redaction fallbacks); own handler; own adapter; single `app.all`; `overview_viewer` |
| 14–17 | Client / UI / sanitizer / assertion | `bcpC06Client` GET-only; **strongest closed allow-list + expanded denylist + readiness-claim regex + SAFE label allow-list**; `C06QualityGatesEvidenceReadinessCard`; 6 provider fitness assertions |
| 18–22 | Transport / browser / tests / frozen / residuals | Unit-tested, live NOT RUN; browser waived; 310/310; frozen & safe; live transport NOT RUN |

---

## 15. DEV Gate Safety Contract (Section D — Hardening Item 1)

**Current state (verified):** uniform `process.env.NODE_ENV !== 'production'` across all adapters; already consistent C-01..C-06.

**Decisions:**
1. Select for future implementation? **No — DEFER.** The gate is already uniform and production-disabled; the only available "hardening" is adding stricter dev-only *success* conditions, which is not needed for safety.
2. Affect all C-01..C-06 at once? Not applicable (deferred).
3. Preserve existing production-disabled behavior exactly? **Yes (mandatory invariant) — unchanged.**
4. Introduce stricter dev-only success conditions? **No** — would risk frozen baseline parity (980 tests pin current behavior) and local preview, for negligible safety gain.
5. Route/adapter/shared helper ownership? If ever pursued, a **shared helper** would be preferred over per-lens duplication — but deferred.
6. Tests pin current or stricter behavior? Current behavior remains pinned; no change.
7. Affects transport evidence/local preview? Potential negative impact on local preview — a reason to defer.
8. Safe for M24? **Deferred** (not selected).

**Frozen for any future implementation:** affected lenses = all six; affected files = adapter family (+ optional shared helper); allowed change = consolidate the *identical* existing check into one helper with **byte-identical behavior**; prohibited change = any new runtime denial path, any production-behavior change, any local-preview regression; tests must remain green with no semantic change; static scan must confirm no new env reads; transport evidence unchanged; **stop condition:** any test delta or behavior delta ⇒ abort.

## 16. Frontend Proxy Path Safety Contract (Section E — Hardening Item 2)

**Current state (verified):** uniform `VITE_IDENTITY_API_BASE || '/__identity'` across all six clients, `credentials:'omit'`.

**Decisions:**
1. Select? **No — DEFER.** Already uniform same-origin default.
2. Hardcode same-origin only? Not recommended — removing the build-time base override could break accepted dev workflows.
3. Keep build-time base behavior? **Yes — preserve.**
4. Apply to all clients uniformly? Not applicable (deferred).
5. Frontend test migration? None (deferred).
6. Static scans forbid absolute origins? Could be added as a **guard-only** lint in a future pass, but low value now.
7. Safe for M24? **Deferred.**

**Frozen for future:** affected files = client family; allowed = optional static-scan guard that *forbids hardcoded absolute origins* without changing runtime behavior; prohibited = removing the configurable base, any runtime proxy behavior change; tests unchanged; **stop condition:** any client runtime behavior delta ⇒ abort.

## 17. Client Sanitizer / Closed Allow-List Safety Contract (Section F — Hardening Item 3) — **SELECTED**

**Current state (verified):** C-01/C-02/C-03 clients are denylist-only (0 closed allow-list sets); C-04/C-05 add closed allow-lists; C-06 strongest. All clients are safe today; this item raises the three lower-rigor clients to the proven C-04+ standard.

**Decisions:**
1. Select for future implementation? **YES.** Highest value-per-risk item that is deterministically executable in this sandbox (pure client + test code; no server lifecycle).
2. Target all clients or lower-rigor first? **Lower-rigor first** — C-01, C-02, C-03 only. C-04/C-05/C-06 already meet the standard and stay untouched.
3. Each lens its own closed enum set? **Yes** — per-lens closed enum sets matched to each lens's bounded output shape (no forced cross-lens uniformity that would be unsafe).
4. Lens-specific shapes make full uniformity unsafe? **Yes acknowledged** — that is exactly why each lens keeps its own enum set rather than a shared schema.
5. Denylist remains as secondary defense? **Yes** — allow-list becomes primary; existing denylist retained as defense-in-depth.
6. Reject / redact / normalize unsafe fields? **Normalize to a safe fallback label** (mirrors C-06's `SAFE_*_LABELS` pattern), never reject the whole envelope, never surface a raw unsafe value.
7. UI safe-label tests? **Yes** — add **client-output safe-label assertions** (string assertions on the client-parsed envelope) **inside the six allowed `*Client.test.ts` files**; no card, `screens.tsx`, or new `.tsx` test file is created.
8. Safe for M24? **YES — as M24 Part 1.**

**Frozen for future implementation (exact):**
- **Affected client files:** `src/backend-control-plane/bcpC01Client.ts`, `bcpC02Client.ts`, `bcpC03Client.ts`.
- **Affected test files:** `bcpC01Client.test.ts`, `bcpC02Client.test.ts`, `bcpC03Client.test.ts`.
- **Fields to allow-list by lens:** C-01 readiness labels/enums; C-02 module id/name/status enums; C-03 coverage labels/enums — each as its own closed `Set`.
- **Fallback labels:** a per-lens safe fallback (e.g. `unknown`/`redacted`-class label already used by C-04+), never a raw value.
- **Unsafe-field behavior:** unknown/unsafe field value → safe fallback label; envelope shape preserved; denylist retained as secondary.
- **Output-parity requirement:** for valid server-owned closed data the rendered output must remain **byte-equivalent** (server data never trips the allow-list redaction path; redaction only triggers on values that cannot occur from the server-owned constants).
- **Tests:** existing C-01/02/03 client+UI tests must stay green; add allow-list pass/normalize tests + **client-output safe-label assertions, all within the six allowed `*Client.test.ts` files** (no card/`screens.tsx`/new `.tsx` test file — a separate test file would breach the six-file allow-list and self-trigger the M24 stop condition).
- **Static scans:** confirm no new exposure surface; confirm denylist retained.
- **Stop conditions:** any change to C-04/C-05/C-06; any output delta for valid server data; any test regression; any new network/DB/Supabase/provider surface.

## 18. Runtime Tuple Assertion Safety Contract (Section G — Hardening Item 4)

**Current state (verified):** provider fitness assertions are **test-time only** (C-04=1, C-05=2, C-06=6; C-01/02/03=0); runtime relies on server-owned closed-enum projection + tests.

**Decisions:**
1. Select? **No — DEFER.** Invalid provider states are impossible in production because providers emit server-owned constants; runtime assertion adds little assurance over the existing closed-enum projection + tests.
2. Providers / read-models / both? If ever pursued, read-model projection layer only — but deferred.
3. Fail closed / redact / normalize? Would be **normalize to safe unknown** (never throw on the data path) — deferred.
4. Byte-equivalent for valid input? Mandatory if ever pursued.
5. Invalid states impossible in production? **Yes** (server-owned constants) — which is why value is low.
6. All lenses or newer only? Not applicable (deferred).
7. Safe for M24? **Deferred.**

**Frozen for future:** affected = provider/read-model families; valid tuple contracts per lens = the existing closed-enum sets; failure behavior = normalize to safe unknown, never throw on data path; **byte-equivalence for valid output mandatory**; tests must pin parity; static scan confirms no new exposure; **stop condition:** any output delta for valid input ⇒ abort.

## 19. Live Transport Harness Safety Contract (Section H — Hardening Item 5) — **SELECTED (dedicated milestone, feasibility-gated)**

**Current state (verified):** route+adapter semantics fully unit-tested; live transport matrix **NOT RUN** across all prior milestones due to sandbox server-lifecycle limits (slow/unstable identity API startup; detached server trees not reliably reaped; EADDRINUSE; foreground sleep blocked).

**Decisions:**
1. Select? **YES**, but for a **dedicated milestone**, not bundled into M24 — its risk is environmental/feasibility, not code.
2. Target boundary? **Adapter boundary + route handler boundary (hybrid), preferred over the full identity API** to sidestep the lifecycle wall; full-API only if a reliable start/stop can be proven.
3. Without package changes? **Yes — required** (no new dependency).
4. Avoid browser tooling? **Yes — required.**
5. Avoid committed logs/artifacts? **Yes — required** (safe summary only, nothing committed).
6. Avoid raw command output exposure? **Yes — required** (pass/fail + classification only).
7. Guarantee process cleanup? **Required** — harness must self-clean (trap-based teardown); if cleanup cannot be guaranteed, the harness must degrade to documented **NOT RUN** rather than leak processes.
8. Cover C-01..C-06 uniformly? **Yes** (one parametrized harness).
9. Before code-hardening items? **No** — sequence after M24 Part 1 (client sanitizer), because the harness is feasibility-risky and must not block a deterministic win.
10. Safe for M24 or dedicated milestone? **Dedicated milestone, feasibility-gated.**

**Frozen for future:** target = adapter+route boundary (hybrid); allowed files = a single self-cleaning harness script + optional test, **no package change**; prohibited = any source/route/client/UI change, any committed log/artifact, any browser tooling; required scenarios = feature disabled/flag-off (where applicable), flag-on/success (where applicable), GET success, HEAD bodyless, OPTIONS 204, mutation methods 405, production-disabled behavior, hostile request ignored/no leak, **safe-summary output only**; cleanup = trap-based guaranteed teardown; **stop conditions:** any leaked process, any committed artifact, any raw-output exposure, any source change ⇒ abort and mark NOT RUN.

## 20. Browser Evidence Reopening Contract (Section I — Hardening Item 6)

**Current state:** browser evidence waived for **Phase 2.0 only**; must reopen before production readiness, Phase 3, Phase 4, customer-facing release, or any separately authorized browser-tooling milestone.

**Decisions:**
1. Remain deferred through the rest of Phase 2.0? **Yes.**
2. Schedule a browser-evidence planning milestone at the Phase 2→3 boundary? **Yes — recommended.**
3. Browser tooling requires package/lockfile changes? **Likely yes** — therefore excluded from M24 (which is package-frozen).
4. Gatherable with existing tooling? **No** (no browser tooling installed; none to be added in M23/M24).
5. Should browser work block cross-lens hardening implementation? **No.**
6. Reopening triggers tracked? **Yes** — tracked as the explicit Phase 2→3 / production-readiness / Phase 3 / Phase 4 / customer-facing / authorized-tooling triggers listed above.
7. Included in M24? **Explicitly EXCLUDED.**

**Recommendation adopted:** keep browser evidence excluded from M24; carry to a future Phase 2→3 planning milestone. **No browser tooling added in M23; no browser evidence run in M23** (not feasible without tooling/package changes).

## 21. New Read-Only Lens Pause Contract (Section J — Hardening Item 7)

**Decisions:**
1. New read-only lens implementation remains paused after M23? **Yes — pause REMAINS ACTIVE.**
2. Hardening implementation before Candidate I discovery? **Yes** — at least one hardening implementation (or explicit deferral) precedes new-lens discovery.
3. Candidate I resume after M24? **Only after** M24 completes and a hardening implementation or explicit deferral decision is recorded.
4. Candidates E and F remain HIGH risk and deferred? **Yes.**
5. New lens planning allowed while hardening pending? **No.**
6. Safest sequence after M23? M23 (this) → M24 Part 1 (client sanitizer) → dedicated transport-harness milestone (feasibility-gated) → revisit Candidate I discovery → Phase 2→3 browser-evidence planning.

**Adopted recommendation:** keep new read-only lens implementation paused until at least one cross-lens hardening implementation or an explicit deferral decision is complete.

---

## 22. Hardening Selection Matrix (Section K)

| Item | Classification | Value | Risk | Affected lenses | Output parity required | Frozen baseline expected to change |
|------|----------------|-------|------|-----------------|------------------------|-----------------------------------|
| 1. DEV gate | **Deferred** | Low | Med (parity) | All (already uniform) | n/a | No |
| 2. Proxy path | **Deferred** | Low | Med | All (already uniform) | n/a | No |
| 3. Client sanitizer / allow-list | **Selected → M24 Part 1** | Med-High | Med (touches frozen clients) | C-01, C-02, C-03 | **Yes (byte-equiv for valid data)** | Yes — C-01/02/03 client+test files (scoped unfreeze) |
| 4. Runtime tuple assertion | **Deferred** | Low | Med (parity) | (newer lenses if ever) | Yes | No |
| 5. Live transport harness | **Selected → dedicated milestone (feasibility-gated)** | High | Low (code) / High (environmental) | All | n/a (additive) | No (additive script/test only) |
| 6. Browser evidence | **Deferred → Phase 2→3 planning** | Med | Med (tooling/package) | All | n/a | No |
| 7. New read-only lens pause | **Pause remains ACTIVE** | n/a | n/a | n/a | n/a | No |

For the **selected** items, detailed value/risk/files/tests/scans/typecheck/transport/browser/parity/route/client/baseline/stop fields are frozen in §17 (item 3) and §19 (item 5), and consolidated in §27–§39 and §42–§45.

## 23. Selected Hardening Items
- **Item 3 — Client Sanitizer / Closed Allow-List generalization** for C-01, C-02, C-03 → **M24 Part 1** (deterministic, parity-preserving, bounded).
- **Item 5 — Live Transport Harness** → **dedicated subsequent milestone, sandbox-feasibility-gated** (additive, no source/package change).

## 24. Deferred Hardening Items
- Item 1 (DEV gate) — already uniform; parity risk; negligible safety gain.
- Item 2 (Proxy path) — already uniform; removing configurable base risks dev workflows.
- Item 4 (Runtime tuple assertion) — invalid states already impossible in production; low value, parity risk.
- Item 6 (Browser evidence) — requires tooling/package; carried to Phase 2→3 planning; remains waived Phase 2.0 only.
- Item 7 (New lens pause) — pause remains active (a constraint, not a deferral of work).

## 25. Blocked or Rejected Hardening Items
- None blocked. No unsafe exposure, unavoidable prohibited scope, or unresolved blocker identified.

## 26. Affected Lenses
- **Item 3:** C-01, C-02, C-03 (clients + tests only). C-04/C-05/C-06 untouched.
- **Item 5:** all six, via one additive parametrized harness (no existing file changed).

## 27. Affected Files for Future Implementation
- **Item 3 (M24 Part 1):** `src/backend-control-plane/bcpC01Client.ts`, `bcpC02Client.ts`, `bcpC03Client.ts` and their `.test.ts` counterparts — **only**.
- **Item 5 (dedicated milestone):** one new self-cleaning transport-harness script (+ optional test) — no existing file modified, no package change.

## 28. Prohibited Files for Future Implementation
For both selected items, prohibited: `server/platform-identity/server.ts`, `server/bcp-pilot/bcpAuthorizationGuard.ts`, `src/backend-control-plane/screens.tsx`, `src/App.tsx`, SaaS navigation, `package.json`, `package-lock.json`, migrations, seeds, `shared/**`, auth/audit-writer/identity-repository/sessionResolve, all DB/Supabase files, `.replit`, `.gitattributes`, the `goose` tarball, **and (for Item 3) the C-04/C-05/C-06 clients/providers/read-models/routes/adapters/registrations/cards and all provider/read-model/route/adapter/registration files of every lens.**

## 29. Behavior Preservation Contract
- DEV-only, default-off (where flags apply), production-disabled, read-only, code/config-only, server-sourced authority only.
- No DB/SQL/Supabase/Supabase-MCP/live-provider/backend-action/mutation/production/customer-facing/SaaS-nav exposure.
- Fail-closed gate order and `overview_viewer` guard floor preserved on every lens.

## 30. Output Parity Contract
- **Item 3:** for all valid server-owned closed data, the client-parsed and UI-rendered output must be **byte-equivalent** to current behavior; allow-list redaction may trigger only on values that cannot be produced by the server-owned constants.
- **Item 5:** no output parity concern (additive evidence only; no existing data path touched).

## 31. Route / Adapter Contract
- No route, adapter, registration, method-handling, status-code, or gate-order change for any lens in either selected item. Item 3 is client-only; Item 5 only *observes* the existing route/adapter boundary.

## 32. Client / UI Contract
- **Item 3:** allow-list becomes primary sanitizer for C-01/02/03; denylist retained as secondary; unsafe values normalize to a safe fallback label; envelope shape and all safe labels render unchanged; new **client-output safe-label assertions** added **within the six allowed `*Client.test.ts` files** (no card/`screens.tsx` change).
- C-04/C-05/C-06 clients and all UI cards unchanged.

## 33. Provider / Read Model Contract
- No provider or read-model change in either selected item. Fitness assertions remain test-time only; closed-enum projection unchanged. (Item 4, which would touch this layer, is deferred precisely to keep providers/read-models frozen.)

## 34. Test Requirements for Future Milestone
- **Item 3:** all existing C-01/02/03 client+UI tests stay green; add (a) allow-list pass tests, (b) unsafe-value normalize tests, (c) client-output safe-label assertions. **All three test types live inside the six allowed `*Client.test.ts` files; no card/`screens.tsx`/new `.tsx` test file is created** (a separate test file would breach the six-file allow-list and self-trigger the M24 stop condition). C-04/05/06 and all other suites must remain at current counts. Aggregate must remain ≥ 980 plus the new C-01/02/03 tests, 0 failures.
- **Item 5:** harness emits safe-summary scenario results; no assertion-framework change; existing 980/980 unaffected.

## 35. Static Scan Requirements for Future Milestone
- Confirm no new network/DB/Supabase/provider/filesystem surface; denylist retained; no raw value/oracle/log/diagnostic/production-claim surface introduced; no package/lockfile change. *(A "no absolute-origin hardcode" scan is listed as optional **defense-in-depth carried from deferred Item 2 (proxy path)** — it is **not** part of Item 3's selected scope and is not required for M24 Part 1.)*

## 36. Typecheck Requirements for Future Milestone
- `tsc --noEmit` must show **0 errors in `server/bcp-pilot/**` and `src/backend-control-plane/**`**; the 12 unrelated baseline errors may remain unchanged but must not increase in BCP surfaces.

## 37. Transport Evidence Requirements for Future Milestone
- **Item 3:** unit-level client/UI evidence only (no live transport needed).
- **Item 5:** the live-transport scenario matrix in §19 with safe-summary output; if the sandbox still cannot run it reliably, record **NOT RUN** with the environmental reason — never fabricate.

## 38. Browser Evidence Handling
- Excluded from M24 and from the transport-harness milestone. Remains waived for Phase 2.0 only. Reopen at Phase 2→3 / production readiness / Phase 3 / Phase 4 / customer-facing / authorized-tooling triggers. No browser tooling added.

## 39. Future Stop Conditions
- Any change to a prohibited file; any output delta for valid server data; any test regression; any new exposure surface; any package/lockfile change; any leaked process or committed artifact (Item 5); any C-04/05/06 modification (Item 3) ⇒ **stop and report a blocker** rather than proceed.

---

## 40. Selected Next Milestone (Section L)
**Option B — Phase 2.0 M24 — Cross-Lens Hardening Implementation Part 1** (client sanitizer / closed allow-list generalization for C-01, C-02, C-03).

**Section L option legend (from the M23 charter):** **A** = M24 Cross-Lens Hardening Implementation (full); **B** = M24 Cross-Lens Hardening Implementation Part 1 (smaller safe subset — *selected*); **C** = M24 Live Transport Harness Implementation; **D** = M24 Cross-Lens Hardening Planning Follow-Up (another docs-only pass); **E** = M24 Next Read-Only Lens Discovery Gate; **F** = a different named docs-only/implementation milestone if justified.

**Section P decision legend (from the M23 charter):** **A** = contract deepened, safe for full M24 implementation; **B** = contract partially deepened, safe for M24 *partial* implementation (*selected*); **C** = live transport harness should be implemented first; **D** = hardening still requires a docs-only follow-up; **E** = hardening deferred, resume next read-only lens discovery; **F** = blocked (unsafe exposure / unavoidable prohibited scope / unresolved blocker).

## 41. Selection Rationale (Section P decision)
**Decision B — Cross-Lens Hardening Contract Partially Deepened; Safe for M24 Partial Implementation.**

Rationale: the client-sanitizer subset is the **highest value-per-risk item that is deterministically executable in this sandbox** — pure client + test code, no server lifecycle, an already-proven closed-enum pattern (C-04/05/06), and provable output parity for valid server-owned data. The live transport harness, though the lowest-risk *to the frozen baseline* (purely additive), has repeatedly proven **environmentally infeasible** in this sandbox; recommending it *first* would likely yield another NOT-RUN, so it is selected for a **dedicated feasibility-gated milestone** sequenced after the deterministic win. Decision A is intentionally **not** forced (not every selected item is exact-and-safe for a single bundled implementation); Decision C is declined for the feasibility reason above; Decision D is unnecessary because a bounded safe subset *is* available; Decisions E/F do not apply.

## 42. Next Milestone Package (Section M — frozen M24 package)
1. **Name:** Phase 2.0 M24 — Cross-Lens Hardening Implementation Part 1.
2. **Purpose:** raise C-01/C-02/C-03 clients to the proven C-04+ closed allow-list standard, output-parity-preserving.
3. **Selected items:** Item 3 (client sanitizer / closed allow-list) for C-01/C-02/C-03.
4. **Excluded items:** Items 1, 2, 4, 5, 6; new-lens work (pause active).
5. **Affected lenses:** C-01, C-02, C-03.
6. **Allowed files:** `bcpC01Client.ts`, `bcpC02Client.ts`, `bcpC03Client.ts` + their `.test.ts` (six files total).
7. **Prohibited files:** per §28.
8. **Behavior-preservation:** per §29.
9. **Output-parity:** byte-equivalent for valid server data (§30).
10. **Route behavior:** unchanged (§31).
11. **Client behavior:** allow-list primary, denylist secondary, safe-fallback normalize (§32).
12. **UI behavior:** safe labels render unchanged; add client-output safe-label assertions within the allowed `*Client.test.ts` files (§32) — no card/`screens.tsx` change.
13. **Provider/read-model:** unchanged (§33).
14. **Guard/registration:** unchanged.
15. **Tests required:** §34.
16. **Static scans required:** §35.
17. **Typecheck:** §36.
18. **Transport evidence:** unit-level only (§37).
19. **Browser-evidence waiver handling:** excluded; waiver intact (§38).
20. **Independent review:** ≥2 independent passes (security/exposure + implementation-contract) + cross-model where available; explicit verdict capture.
21. **Stop conditions:** §39.
22. **Final report requirements:** full scoped report mirroring prior milestones (files created/modified/untouched, baseline, tests, typecheck, scans, reviews, non-readiness, residuals, git status).
23. **Commit/backup rules:** scoped commit of exactly the six allowed files; fast-forward non-force push; backup report; only on explicit M24 Scoped Commit authorization.

## 43. Allowed Files for Next Milestone
`src/backend-control-plane/bcpC01Client.ts`, `bcpC02Client.ts`, `bcpC03Client.ts`, `bcpC01Client.test.ts`, `bcpC02Client.test.ts`, `bcpC03Client.test.ts`. (M24 carries the scoped unfreeze authorization for exactly these six.)

## 44. Prohibited Files for Next Milestone
Per §28 — including all C-04/C-05/C-06 files and every provider/read-model/route/adapter/registration/guard/registration file of every lens, plus all platform/package/DB/Supabase/auth/protected files.

## 45. Stop Conditions for Next Milestone
Per §39. Additionally: if any C-01/02/03 client cannot be hardened without an output delta for valid data, **stop and report a blocker** (do not weaken the contract).

---

## 46. Current Baseline Reconfirmation (Section N)

## 47. Test Results
**Aggregate 980/980, 0 failures** (safe summary; raw output not exposed).

| Lens | Result | Expected |
|------|--------|----------|
| C-01 family | 106/106 (lens-specific 35 + shared foundation 71) | 106 |
| C-02 | 122/122 | 122 |
| C-03 | 126/126 | 126 |
| C-04 | 146/146 | 146 |
| C-05 | 170/170 | 170 |
| C-06 | 310/310 | 310 |
| **Aggregate** | **980/980** | **980** |

(The C-01 "106" reconciles exactly: the M23 runner reports the lens-specific C-01 suite as 35 and the shared foundation suite as 71; 35 + 71 = 106, the M22-accepted C-01 family figure.)

## 48. Typecheck Result
`tsc --noEmit`: **12 baseline errors, unchanged; 0 in `server/bcp-pilot/**`; 0 in `src/backend-control-plane/**`; 0 in C-01..C-06 evidence surfaces.** The 12 errors are in unrelated application files outside BCP.

## 49. Static Scan Results
Clean. Verified (safe summary): no change to frozen BCP surfaces; no package/lockfile change; no DB/Supabase/live-provider exposure in C-01..C-06; no production/customer-facing exposure; no raw env-value, value-oracle, log-output, diagnostics, package-detail, command-output, raw-evidence, file-path, or production-claim surface in the BCP C-01..C-06 evidence lenses. The only matches for sensitive tokens were **defensive**: binding-safety *comments* documenting absence (e.g. "no `process.env.DATABASE`"), sanitizer **denylist tokens**, closed-enum **safe labels** (e.g. `no_db`/`no_supabase`), the C-06 production-readiness **ban-list**, and mock fixture data — no live access, no value reads, no data-path console emission.

## 50. Independent Review Results (Section O)
Two independent review passes were required with explicit verdict capture, plus a cross-model pass where available. Verdicts are recorded honestly below; no verdict is claimed that was not actually obtained, and no review evidence is invented. All findings were documentation-only and have been reconciled in this document; **no finding required a source/test/runtime change, so no blocker was raised.**

**Review log (finalized):**
- **Pass 1 — Security / cross-lens hardening exposure review:** **COMPLETED.** Verdict: **DOC SAFE WITH MINOR FINDINGS** (2 LOW). Findings: (1) Section R row 22 read as a pre-claimed verdict while §50 was pending — **applied** (§50 finalized; Section R row 22 annotated). (2) `overview_viewer` role name disclosed — assessed an acceptable least-privilege read-only viewer floor (no secret, confers no access) — **applied** as an explicit documented-invariant acceptance (§8 note). Source corroboration (read-only) confirmed: `credentials:'omit'` ×6, `VITE_IDENTITY_API_BASE || '/__identity'` ×6, `NODE_ENV !== 'production'` across adapters, `overview_viewer` guard floor, and the monotonic sanitizer-rigor gradient.
- **Pass 2 — Planning / implementation-contract review:** **COMPLETED.** Verdict: **DOC READY WITH MINOR FINDINGS** (3 MED + 3 LOW, no blockers). Findings reconciled: (MED) UI-test artifact could collide with the six-file allow-list — **applied** (UI tests fixed to live inside the six allowed `*Client.test.ts`; §17/§32/§34/§42). (MED) test-terminology drift — **applied** (unified to "client-output safe-label assertions"). (MED) Decision/Option menus referenced but not defined inline — **applied** (legends added at §40). (LOW) Section R row 22 — **applied**. (LOW) no 15-question answer map — **applied** (appendix added). (LOW) §35 absolute-origin scan pertains to deferred Item 2 — **applied** (annotated as defense-in-depth). Confirmed clean: selection matrix complete/unambiguous; M24 package exact/bounded (six files); baseline arithmetic sound (35+71=106; aggregate 980); output-parity contract self-protecting.
- **Pass 3 — Cross-model review (Codex gpt-5.5):** **UNAVAILABLE.** Codex authenticated and the runtime started, but its sandboxed shell could not read the document — the `bwrap` sandbox failed to initialize in this environment (`bwrap: Unexpected capabilities but not setuid`), so both file-read attempts exited non-zero and no cross-model verdict was produced. This is a known infrastructure limitation of this sandbox (trivial Codex prompts succeed; file-reading via the sandboxed shell does not). **Fallback:** the two completed read-only specialist review passes above (one of which independently corroborated the doc's machine-verified claims against source) served as the independent lenses. No Codex verdict is claimed.

## 51. Non-Readiness Statements (Section Q)
Phase 2.0 remains: **not** production readiness; **not** customer-facing release; **not** Phase 3 controlled actions; **not** Phase 4 production readiness; **not** live DB/Supabase reads; **not** live provider reads; **not** Supabase auth enablement; **not** Firebase-to-Supabase cutover; **not** browser-evidence completion for production/customer-facing release. **Firebase remains authoritative. Supabase remains dormant/shadow/readiness-only. Backend CP remains DEV-only and read-only in Phase 2.0.**

## 52. Risks / Accepted Residuals
- Live transport matrix **NOT RUN** (sandbox server-lifecycle limit) — selected for a dedicated feasibility-gated milestone; unit tests fully cover route/adapter semantics meanwhile.
- Browser evidence **waived for Phase 2.0 only** — must reopen at the stated triggers.
- 12 unrelated typecheck baseline errors (outside BCP) — pre-existing, unchanged.
- Item 3 touches frozen client files — gated behind M24's scoped unfreeze authorization; output parity preserved.
- Cross-model (Codex) review availability is environment-dependent; if unavailable, the fallback is recorded honestly (see §50).

## 53. Git Status
Expected at end of M23 work:
```
 M .replit
?? docs/phase-2.0-backend-control-panel-cross-lens-hardening-source-inventory-and-safety-contract-deepening.md
?? goose-x86_64-unknown-linux-gnu.tar.bz2
```

## 54. No Commit / Push / Backup Confirmation
No commit, push, or backup performed in M23. HEAD remains `1e26c88…` (= origin/main). The pre-change backup checkpoint is the accepted M22 commit; no extra backup created.

## 55. Acceptance Recommendation
**Recommend acceptance** of this docs-only safety-contract deepening, contingent on the §50 independent-review passes completing with no blocker. Decision B; M24 Part 1 (client sanitizer for C-01/02/03) frozen and bounded; transport harness sequenced to a dedicated feasibility-gated milestone; new-lens pause active.

## 56. Recommended Next Step
**Phase 2.0 M23 — Scoped Commit and Backup Authorization** (commit this single doc; fast-forward non-force push; backup report). After M23 backup, proceed to **Phase 2.0 M24 — Cross-Lens Hardening Implementation Part 1** per the frozen package (§42). Do not commit, push, or back up without explicit authorization.

---

## Section R — Verification Before Final Report

| # | Verification | Result |
|---|--------------|--------|
| 1 | Only the M23 documentation file created | ✅ |
| 2–16 | No source/test/frontend/backend/`server.ts`/`bcpAuthorizationGuard.ts`/`screens.tsx`/`App.tsx`/SaaS-nav/`package.json`/`package-lock.json`/migration/seed/`shared/**`/auth-audit-identity-session/DB-Supabase change | ✅ |
| 17 | `.replit` unstaged and untouched | ✅ |
| 18 | `goose` tarball untracked | ✅ |
| 19 | `.gitattributes` absent | ✅ |
| 20 | Tests/scans/typecheck/planning reported honestly | ✅ |
| 21 | Not-run evidence clearly marked NOT RUN (live transport) | ✅ |
| 22 | Independent-review verdict capture explicit and honest | ✅ §50 finalized — Pass 1 SAFE w/ minor, Pass 2 READY w/ minor, Pass 3 (Codex) UNAVAILABLE (bwrap); all findings doc-only and applied |
| 23 | Git status shows only `M .replit` + `?? <this doc>` + `?? goose…` | ✅ |

---

## Appendix — M23 15-Question Coverage Map

Traceability index proving every M23 charter question is answered (sections refer to the numbered report sections above).

| # | M23 question | Answered in |
|---|--------------|-------------|
| 1 | Which hardening items are selected? | §22, §23 (Items 3 + 5) |
| 2 | Which are deferred? | §22, §24 (Items 1, 2, 4, 6; pause 7) |
| 3 | Which exact lenses are affected per selected item? | §22, §26 (Item 3 → C-01/02/03; Item 5 → all) |
| 4 | Which exact files would be allowed in future implementation? | §27, §43 (six client+test files) |
| 5 | Which exact files remain prohibited? | §28, §44 |
| 6 | Source-contract rules preventing raw evidence/diagnostics/DB/production/mutation exposure | §29, §35, §49 |
| 7 | Route/client/provider/read-model behavior to preserve | §30, §31, §32, §33 |
| 8 | Migration strategy preserving frozen-baseline parity | §30 (byte-equivalence) + §39/§45 (stop on any valid-data delta) |
| 9 | Exact tests required | §34, §42.15 |
| 10 | Exact static scans required | §35, §42.16 |
| 11 | Typecheck expectations | §36, §42.17, §48 |
| 12 | Transport-evidence requirements | §19, §37, §42.18 |
| 13 | Browser-evidence handling | §20, §38, §42.19 |
| 14 | Can next milestone be implementation, or must stay docs-only? | §40, §41 (implementation — M24 Part 1, bounded) |
| 15 | Does the new read-only lens pause remain active? | §21 (YES — pause ACTIVE) |
