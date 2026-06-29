# Phase 2.0 M22 — Cross-Lens Hardening Planning Gate

**Status:** docs-only planning gate. No source/test/frontend/backend/route/UI/client/provider/package/migration/auth/DB/Supabase/config/runtime change. No implementation of any hardening item.
**Pre-change accepted checkpoint:** `4e46f1758f9310acc9be4a7e6516bfd5f6c76a97` (Phase 2.0 M21 — freeze backend control panel C06 baseline).
**Planning Decision:** **A — CROSS-LENS HARDENING PLANNING COMPLETE; PROCEED TO M23 SAFETY-CONTRACT DEEPENING.**

---

## Section A — Preflight Result

PASS. Branch `main`; `HEAD == origin/main == 4e46f17`; ahead/behind `0/0`; nothing staged; `.gitattributes` absent; M21 commit present; working tree only `M .replit` + `?? goose…`. HEAD == origin/main ⇒ pre-change backup checkpoint. No source/test/code/config change and no commit/push/backup occur in M22.

## Section B — M21 Backup & C-06 Freeze Review

M21 commit `4e46f17` ("Phase 2.0 M21 freeze backend control panel C06 baseline"); origin/main == HEAD; fast-forward non-force push; exactly one docs file committed; no source/test/frontend/backend/runtime/package/lockfile change. C-06 DEV QA baseline frozen; M22 selected as next governed step; no new read-only lens until M22 completes; browser evidence waived Phase 2.0 only (reopen before production readiness / Phase 3 / Phase 4 / customer-facing release). C-01..C-06 baselines unaffected.

## Section C — Cross-Lens Inventory (safe summary labels only)

| Lens | Purpose | Route family | Flag family | sourceMode | DEV gate | provider | read-model | route/adapter | client | UI | tests | frozen | residuals |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| **C-01** | readiness summary | `/dev/bcp/...readiness` | pilot flag | code_config | `!== 'production'` | code/config | pure DTO | inert handler + adapter | GET-only proxy | DEV card | 106 | yes | browser waived |
| **C-02** | registry readiness | `/dev/bcp/...readiness` | C02 flag | code_config | `!== 'production'` | code/config provider | pure DTO | inert + adapter | GET-only proxy | DEV card | 122 | yes | browser waived |
| **C-03** | UI coverage | `/dev/bcp/...readiness` | C03 flag | code_config | `!== 'production'` | code/config provider | pure DTO | inert + adapter | GET-only proxy | DEV card | 126 | yes | browser waived |
| **C-04** | route exposure | `/dev/bcp/...readiness` | C04 flag | code_config | `!== 'production'` | provider + allow-list (1 fitness fn) | pure DTO | inert + adapter | GET-only proxy + some allow-lists | DEV card | 146 | yes | browser waived |
| **C-05** | feature-flag posture | `/dev/bcp/feature-flag-posture-readiness` | C05 flag | code_config | `!== 'production'` | provider + 2 fitness fns (no-value-oracle) | pure DTO | inert + adapter | GET-only proxy + allow-lists | DEV card | 170 | yes | browser waived |
| **C-06** | quality-gates / evidence coverage | `/dev/bcp/quality-gates-evidence-coverage-readiness` | C06 flag | code_config | `!== 'production'` | provider + **6 fitness fns** (strongest) | pure DTO, closed-enum projection | inert + adapter | GET-only proxy + **closed allow-list (strongest)** | DEV card | 310 | yes | browser waived; live-transport NOT-RUN |

**Observed cross-lens facts:** DEV gate uniform `process.env.NODE_ENV !== 'production'` (all adapters; no stricter variant). Frontend proxy uniform `VITE_IDENTITY_API_BASE || '/__identity'` (6/6 clients; env-configurable build-time base). Client sanitizers all denylist-based; C-04/05/06 add allow-list sets (C-06 strongest); C-01/02/03 lighter. Provider fitness-assertion rigor increases over time (C-02/03=0, C-04=1, C-05=2, C-06=6); **none is invoked on the runtime data path** — every lens relies at runtime on closed-enum/allow-list projection in the read model, with fitness functions enforced at test time. All lenses: DEV-only, default-off (where flagged), production-disabled, read-only, code/config-only, server-authority-only, no DB/Supabase/live, no mutation, no production/SaaS-nav/customer exposure.

## Section D — Topic 1: DEV Gate Consistency

Current pattern is uniform (`!== 'production'`) across all six. Production IS disabled (verified across milestones). A stricter `=== 'development'` would deny staging/test/unset environments — closing the M20 cross-model "staging fail-open" concern — but the lenses expose only bounded safe posture labels even if served outside production, so this is hardening, not a live-exposure fix. Changing it touches **all six** adapters simultaneously (parity), and could regress local-dev/preview/test execution where `NODE_ENV` is unset. **Risk: MEDIUM. Value: MEDIUM. Affected: all 6. Decision: deeper planning before implementation (M23)** — implement uniformly or not at all; current production-disabled behavior is sufficient for Phase 2.0.

## Section E — Topic 2: Frontend Proxy Path Consistency

Uniform `VITE_IDENTITY_API_BASE || '/__identity'` across 6/6 clients. The base is build-time (developer-controlled, not runtime attacker input); default is the safe same-origin proxy. Hardcoding `/__identity` (test-only injection retained) would remove the configurable absolute-origin path but touches all six clients and could break dev workflows that set the base. **Risk: MEDIUM. Value: LOW-MEDIUM. Affected: all 6 clients. Decision: deeper planning (M23)** — confirm no dev workflow depends on a custom base before any change.

## Section F — Topic 3: Client Sanitizer / Closed Allow-List Consistency

Mixed: all clients use a denylist (`FORBIDDEN_SUBSTRINGS`) + per-field `safeLabel`; C-06 (and partly C-04/05) add closed allow-list sets (e.g., C-06 `SAFE_EVIDENCE_LABELS`, category allow-list). C-01/02/03 lean denylist-only. No current client surface is unsafe (server emits only bounded values; clients redact), but uniform closed allow-lists (generalizing C-06's pattern) would strengthen defense-in-depth. Differences are partly justified by differing data shapes. Uniform allow-lists require source/test changes across C-01/02/03 (and verification of 04/05). **Risk: MEDIUM. Value: MEDIUM-HIGH. Affected: C-01/02/03 primarily. Decision: deeper planning (M23)** — define a per-lens closed-vocabulary contract that preserves rendered output.

## Section G — Topic 4: Runtime Tuple Assertion Consistency

No lens invokes its tuple-aware allow-list assertion on the runtime path; all rely on closed-enum/allow-list projection in the read model (safe), with tuple assertions enforced at test time. Live entries are server-owned with correct tuples, so no live drift occurs. Adding runtime tuple assertions could change frozen output (e.g., redacting on a hypothetical mismatch) and must define mismatch handling carefully. **Risk: MEDIUM. Value: LOW-MEDIUM (live entries already correct). Affected: all providers/read models. Decision: deeper planning (M23)** — only if a non-output-changing enforcement is specified.

## Section H — Topic 5: Live Transport Harness Strategy

Recurring residual: full-identity-API live HTTP matrix capture is unreliable in the sandbox (server drops the listener between readiness poll and request; detached process trees not reliably reaped). Unit tests (route + adapter) already prove every transport scenario against the same code paths. A safer no-package harness could (a) target the pure adapter/handler boundary (already covered) and/or (b) drive the server with a single short-lived process, deterministic readiness wait, and guaranteed process-group teardown, capturing only safe pass/fail summaries (no raw logs/artifacts). **Risk: LOW (test-harness only; no lens source change). Value: MEDIUM (closes the recurring NOT-RUN residual). Affected: shared harness, all lenses. Decision: deeper planning (M23)** — specify a no-package, no-artifact, self-cleaning harness; or split into a dedicated gate if it grows.

## Section I — Topic 6: Browser Evidence Reopening Strategy

Browser evidence is waived for Phase 2.0 only (M15A). Reopening would likely need browser tooling (package/lockfile changes) — out of Phase 2.0 scope. **Decision: keep the waiver unchanged through Phase 2.0; recommend a dedicated browser-evidence planning milestone at the Phase 2 → Phase 3 boundary (or before any customer-facing release / production readiness).** Reopening triggers: production readiness, Phase 3, Phase 4, any customer-facing release, or any separately authorized browser-tooling milestone. Track per-lens in that future milestone. No browser tooling in M22.

## Section J — Topic 7: New Read-Only Lens Pause Decision

The C-01..C-06 baseline is strong (980/980, all frozen). Adding new lenses now would multiply the four cross-cutting hardening workstreams (gate/proxy/sanitizer/tuple) before they are contracted, increasing parity risk. **Decision: continue the pause on new read-only lens implementation until cross-lens hardening is contracted (M23).** Candidate I (Next Read-Only Lens Discovery) remains deferred; Candidates E (Audit/Security Posture) and F (Identity/Session Posture) remain HIGH-risk and deferred. Safest sequence: M22 (this) → M23 (hardening source inventory + safety contract) → (future) hardening implementation → only then resume lens discovery.

## Section K — Candidate H Risk Review & Hardening Classification Matrix

Candidate H (this planning gate) is docs-only and safe (Risk: planning = LOW); the *future* hardening implementation is the source of risk (could touch multiple frozen lenses → parity/test/output risk).

| # | Topic | Value | Risk | Affected lenses | Possible files (future impl) | Tests req. (future) | Static scans req. | Transport evidence req. | Deeper planning? | Before new lenses? |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | DEV gate uniformity | Med | Med | all 6 | 6 adapters | per-lens route/adapter + new gate tests | env-read scan | re-run matrix | **Yes (M23)** | yes |
| 2 | Proxy path hardening | Low-Med | Med | all 6 clients | 6 clients | client tests | proxy/origin scan | n/a | **Yes (M23)** | yes |
| 3 | Client closed allow-lists | Med-High | Med | C-01/02/03 (+verify 04/05) | 3-5 clients | client sanitizer tests | exposure scan | n/a | **Yes (M23)** | yes |
| 4 | Runtime tuple assertion | Low-Med | Med | all providers/read-models | 6 providers/read-models | read-model + fitness tests | output-key/value scan | n/a | **Yes (M23)** | yes |
| 5 | Live transport harness | Med | Low | shared harness | scripts/test harness only | harness self-tests | no-artifact scan | the harness itself | **Yes (M23)** | not blocking |
| 6 | Browser evidence reopening | Deferred | — (governance) | all | none in Phase 2.0 | n/a | n/a | n/a | future milestone at Phase 2→3 | n/a |
| 7 | New-lens pause | — | — | — | none | n/a | n/a | n/a | hold pause | n/a |

No topic is classified Blocked; none is safe for immediate implementation without a frozen contract.

## Section L/M — Selected Next Milestone & Package

**Option legend:** A = Cross-Lens Hardening Source Inventory / Safety-Contract Deepening (docs-only); B = direct Cross-Lens Hardening Implementation; C = Live Transport Harness Planning Gate; D = Browser Evidence Reopening Planning Gate; E = resume Next Read-Only Lens Discovery; F = another justified docs-only planning milestone.

**Selected: Option A — Phase 2.0 M23 — Cross-Lens Hardening Source Inventory / Safety Contract Deepening (docs-only).** Rationale: four of five hardening topics touch frozen C-01..C-06 behavior across all lenses (parity/output risk); direct implementation (Option B) is unsafe without a frozen per-topic source inventory + safety contract; transport-harness (Option C) and browser (Option D) are handled as scoped sub-topics within M23 (not yet separate gates); Option E (resume lenses) is rejected — the pause holds.

**M23 package (docs-only) must freeze:** (1) exact hardening items selected; (2) exact affected lenses; (3) exact affected files; (4) exact source contract; (5) route/client/provider/read-model behavior contract (output-preserving); (6) migration strategy; (7) regression strategy; (8) test requirements; (9) static-scan requirements; (10) typecheck requirements; (11) transport-evidence requirements (incl. the no-package harness spec); (12) browser-evidence handling (waiver + reopening trigger); (13) stop conditions; (14) final-report requirements; (15) commit/backup rules.
- **Allowed file (M23):** `docs/phase-2.0-backend-control-panel-cross-lens-hardening-source-inventory-and-safety-contract-deepening.md` only.
- **Prohibited files (M23):** all source/test/client/route/UI/provider/read-model/`screens.tsx`/`server.ts`/guards/`App.tsx`/SaaS-nav/package/lock/migration/seed/`shared/**`/auth/audit/identity/session/DB/Supabase/config; `.replit`; `.gitattributes`; goose; `dist/**`; any C-01..C-06 implementation file.
- **Stop conditions (M23):** stop and report a blocker if any source/test/runtime change appears necessary, or any exposure/authority/DB-Supabase-live/production/action-mutation/test/typecheck/static-scan/raw-evidence/diagnostics/production-claim/sensitive-data issue is found.

## Section N — Current Baseline Reconfirmation

Re-ran the accepted BCP suite and typecheck (no code changed since M21). Results in the final report (Sections 31–33): **980/980** tests; typecheck 12 unrelated baseline errors unchanged with 0 in C-06 / `server/bcp-pilot/**` / `src/backend-control-plane/**` / C-01..C-05; static scan clean (no DB/Supabase/live/production/customer exposure, no raw env-value/value-oracle/log/diagnostics/package-detail/command-output/raw-evidence/file-path/production-claim surface in C-01..C-06).

## Section O — Independent Review

Two passes (docs-only planning over unchanged frozen code): (1) security / cross-lens-exposure — confirms no sensitive data in this doc and that the cross-lens summaries match the frozen code; (2) planning / implementation-contract — confirms the topic classification, decision, and M23 package are accurate and safe. Cross-model (Codex) attempted but its `bwrap` sandbox is unavailable in this environment (infra limit) → honest fallback to a read-only reviewer; no evidence invented. (Reconciliation in the final report.)

## Section P — Planning Decision

**A — CROSS-LENS HARDENING PLANNING COMPLETE; PROCEED TO M23 SAFETY-CONTRACT DEEPENING.** Cross-lens hardening is valuable but implementation scope is too broad and touches frozen baselines; a deeper source inventory + safety contract (M23) is required before any code change.

## Section Q — Non-Readiness Statements

Phase 2.0 remains: not production readiness; not customer-facing release; not Phase 3 controlled actions; not Phase 4 production readiness; not live DB/Supabase reads; not live provider reads; not Supabase auth enablement; not Firebase-to-Supabase cutover; not browser-evidence completion. **Firebase authoritative; Supabase dormant/shadow/readiness-only; Backend CP DEV-only + read-only in Phase 2.0.**

---

*M22 governance artifact. No source/test/code/config changed; no commit/push/backup performed during authoring.*
