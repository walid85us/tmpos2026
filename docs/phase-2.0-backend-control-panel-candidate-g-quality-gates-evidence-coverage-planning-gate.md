# Phase 2.0 — M19: Candidate G Planning Gate — Quality Gates / Evidence Coverage Posture Lens

**Milestone:** Phase 2.0 M19 (docs-only planning and safety-contract gate; **no implementation**)
**Accepted checkpoint under review:** `cf1c33d7256ae1ee567a71033902437a158d2f71`
**Checkpoint subject:** *Phase 2.0 M18 freeze backend control panel C05 baseline*
**This document is the only artifact produced by M19.** No source, test, frontend, backend, route, UI, package, migration, DB, Supabase, auth, configuration, or runtime change was made. No commit, push, or backup was performed.

---

## 1. Executive Summary

M19 is the planning gate for **Candidate G — Quality Gates / Evidence Coverage Posture Lens** (prospective C-06): a future DEV-only, read-only Backend-CP lens that would surface **bounded posture labels** for accepted evidence categories (tests, typecheck, static-scan, transport, frontend-proxy-review, browser-evidence-waiver, regression, independent-review, scoped-commit/backup, source-scope, frozen-baseline, non-readiness) **without** reading live logs, command output, stdout/stderr, stack traces, file paths, source filenames, package/dependency/versions, screenshots/traces/reports, CI logs, runtime diagnostics, build internals, or making production-readiness claims.

Baseline is healthy and unchanged: preflight clean; tests **670/670** (C-01 106 · C-02 122 · C-03 126 · C-04 146 · C-05 170); typecheck **12** pre-existing baseline errors / **0** in BCP surfaces; no executable DB/Supabase/log/diagnostics surface exists in C-01..C-05; no package/lockfile or frozen-surface change.

**Planning Decision: B — Candidate G requires additional, tightly-scoped planning before implementation (→ M19A).** Independent review converges on this: the transport / authority / isolation spine (the proven C-02→C-05 pattern) is ready and reusable, **but the safe source contract is not yet fully frozen**. Four concrete contract points must be frozen — with mechanically-enforceable fitness functions — before code is written. Critically, review demonstrated that the existing C-05 field-level fitness functions **do not transfer as-is** to Candidate G's larger, fuzzier evidence surface. These are bounded, docs-only items, not an open-ended re-plan. After M19A freezes them, implementation (M20) becomes mechanical pattern reuse and Decision A becomes appropriate. (Decision A = authorize C-06 implementation next; Decision B = require a docs-only planning-deepening pass, M19A, first.)

**Candidate G must never become** a log viewer, test-output viewer, build-output viewer, stack-trace viewer, file-path inventory, package/dependency inventory, runtime diagnostics console, CI/CD log surface, command-execution surface, raw-error viewer, production-readiness claim, customer-facing evidence dashboard, or any backend action/mutation surface.

Phase 2.0 remains DEV-only, read-only, code/config-only. Firebase remains authoritative; Supabase remains dormant/shadow/readiness-only. Browser evidence remains waived for Phase 2.0 only (M15A).

---

## 2. Preflight Result (Section A)

| Check | Expected | Observed | Result |
|---|---|---|---|
| Branch | `main` | `main` | PASS |
| `HEAD` | `cf1c33d` | `cf1c33d7256ae1ee567a71033902437a158d2f71` | PASS |
| `origin/main` | `cf1c33d` | `cf1c33d7256ae1ee567a71033902437a158d2f71` | PASS |
| Ahead/behind | `0/0` | `0 0` | PASS |
| `git status` | only `.replit` + goose tarball | `M .replit`, `?? goose-x86_64-unknown-linux-gnu.tar.bz2` | PASS |
| Staged | none | none | PASS |
| `.gitattributes` | absent | absent | PASS |
| M18 commit present | yes | `cf1c33d Phase 2.0 M18 freeze backend control panel C05 baseline` | PASS |
| Pre-change backup | `HEAD == origin/main` ⇒ this is the backup checkpoint | confirmed | PASS |

No source/test/backend/frontend/route/UI/package/migration/DB/Supabase/auth/runtime change occurred during M19. No commit, push, or backup occurred.

## 3. Files Created
- `docs/phase-2.0-backend-control-panel-candidate-g-quality-gates-evidence-coverage-planning-gate.md` (this file) — the only file created.

## 4. Files Modified
- None.

## 5. Files Confirmed Untouched
No change to: C-01..C-05 implementations; `server/platform-identity/server.ts`; `server/bcp-pilot/bcpAuthorizationGuard.ts`; `src/backend-control-plane/screens.tsx`; `src/App.tsx`; main SaaS navigation; `package.json`; `package-lock.json`; migrations/seeds; `shared/**`; auth / the M20 auth area (code module, not the future milestone) / audit-writer / identity-repository / sessionResolve; any DB/Supabase file. `.replit` unstaged/untouched; goose tarball untracked; `.gitattributes` absent. (Temporary read-only verification scripts were used only under the session scratchpad, outside the repository.)

## 6. Planning Decision (Section P)

**Decision B — Candidate G requires additional planning before implementation.** The safe source contract is not yet clear enough to freeze for implementation. Recommended next milestone: **Phase 2.0 M19A — Candidate G Source Inventory / Safety Contract Deepening** (docs-only). Rationale and the exact unknowns to close are in Sections 8–9, 17–18, and the M19A package (Section 27).

This is the gate working as intended: the lens is genuinely the lowest-risk next read-only candidate and the isolation pattern is proven, but going to code with the evidence contract unfrozen would reintroduce precisely the exposure risk this gate exists to prevent.

## 7. M18 Backup and C-05 Freeze Review (Section B)

| # | Item | Result |
|---|---|---|
| 1 | M18 commit `cf1c33d7256ae1ee567a71033902437a158d2f71` | CONFIRMED |
| 2 | Subject *Phase 2.0 M18 freeze backend control panel C05 baseline* | CONFIRMED |
| 3 | `origin/main` matches local `HEAD` | CONFIRMED |
| 4 | Push fast-forward, non-force | CONFIRMED (`913760b..cf1c33d`) |
| 5 | Exactly one docs file committed | CONFIRMED (`…c05-qa-baseline-freeze-and-next-lens-planning.md`) |
| 6 | No source/test/frontend/backend/runtime change committed | CONFIRMED |
| 7 | No package/lockfile change committed | CONFIRMED |
| 8 | C-05 DEV QA baseline frozen | CONFIRMED |
| 9 | Candidate G selected as next read-only lens | CONFIRMED |
| 10 | Candidate E & F deferred HIGH risk | CONFIRMED |
| 11 | Browser evidence waived Phase 2.0 only | CONFIRMED |
| 12 | Browser evidence must reopen before prod/Phase 3/Phase 4/customer-facing/any browser-tooling milestone | CONFIRMED |
| 13 | C-01..C-05 baselines unaffected | CONFIRMED |

## 8. Candidate G Risk Review (Section C)

**Classification: LOW–MEDIUM, currently MEDIUM pending contract freeze.** The lens *can* be LOW risk, but only when hard-scoped to server-owned, code/config-only evidence-category labels and bounded posture labels with no live reads. Risk drivers (all confirmed by independent review): evidence coverage can accidentally expose raw test/typecheck/static-scan logs, stack traces, file paths, command output, package details, build/runtime internals; it can imply production readiness; and it can drift into a diagnostics console because its subject *is* the output of CI tooling — a structural pull stronger than for any prior lens.

**M19 decision treats Candidate G as: MEDIUM risk requiring a planning-deepening step (Decision B).** With the deepened, mechanically-enforced contract in Sections 9, 12–14, and 17–18, it becomes LOW risk and safe to implement at M20. The lens is **not** deferred (it has real operational value as a posture mirror of the governance evidence the project already tracks) and is **not** blocked (no *unavoidable* raw exposure was found — every identified leak path has a closing control).

## 9. Safe Source Contract (Section D, strengthened by review)

The future provider must be **server-owned and code/config-only**, emitting only safe evidence-category names and bounded posture labels. It must **not** read: raw test logs, raw typecheck logs, raw static-scan output, raw transport logs, browser screenshots/traces/videos/reports/artifacts, CI/CD logs, package/dependency details, runtime command output, build output; and must **not** expose file paths or source filenames.

Strengthened controls (the heart of why M19A is required — these make "bounded labels" enforceable rather than merely promised):

1. **Positive allow-list is the PRIMARY control, not the denylist.** Safety must come from a closed allow-list + per-field normalization to a closed enum + a value-shape sanitizer (the proven C-05 mechanism), with any prohibited-field denylist serving only as defense-in-depth. A denylist alone is provably incomplete for this domain.
2. **No live read of any kind.** No `process.env` read for output, no `fs`/`readFile`/`readdir`/`glob`, no `child_process`/`execSync`/`spawn`, no `fetch`/dynamic `import`, no `Date.now()`/`new Date()`/`performance` (use a synthetic `generatedAt` constant). The provider is a deeply-frozen, hand-curated constant.
3. **No exec/shell-out to test/typecheck/scan tooling.** There is no stable machine-readable command contract to parse anyway (tests run per-file via `npx tsx <file>`; typecheck via `npx tsc --noEmit`), so a curated constant is both the safe and the correct design.
4. **Prefer posture labels over counts.** If any count appears it must be the deterministic cardinality of a subset of the frozen constant selected by a bounded-label predicate (env/FS/clock-invariant), never a pass/fail/skip/error/finding/CVE count, coverage %, or duration. Safest option: **omit counts entirely.**
5. **Curated labels may drift from reality** (a maintainer could forget to update after a regression). This is an accepted residual disclaimed by `sourceMode: code_config` + `freshness: code-config-no-live-read` + a UI "labels only, no live reads" warning — analogous to C-05's hand-set status. Do not build a reconciliation mechanism.

## 10. Safe Evidence Category Inventory (Section E)

Built by static inspection only (no raw logs/reports/output/paths read). The lens is, by design, a posture mirror of the governance evidence the repository already tracks. **The final set (and whether it is 6 or 12 categories, after applying the conditional-include rules in Section 11) is NOT frozen here — freezing it as a hard, index-aligned allow-list is an M19A deliverable (Section 27).**

| # | evidenceKey | evidenceLabel (example, bounded) | ownerSurface | purpose | safe posture labels | why safe | include? | raw to exclude |
|---|---|---|---|---|---|---|---|---|
| 1 | `tests` | `tests_documented` | BCP DEV evidence | record that an accepted test posture exists | `documented`, `frozen_baseline`, `unknown` | label only; no counts/names/output | YES | pass/fail counts, test names, assertion text, `X/Y passed` |
| 2 | `typecheck` | `typecheck_documented` | BCP DEV evidence | record typecheck posture | `documented`, `code_config_only`, `unknown` | label only | YES | error text, file:line, error counts |
| 3 | `static_scans` | `static_scan_documented` | BCP DEV evidence | record static-scan posture | `documented`, `no_findings_listed`, `code_config_only` | label only | **CONDITIONAL** | CVE ids, `package@version`, rule ids, file paths, severities, counts |
| 4 | `transport_verification` | `transport_documented` | BCP DEV evidence | record transport posture | `documented`, `code_config_only` | label only | YES | URLs, status dumps, request/response bodies |
| 5 | `frontend_proxy_review` | `frontend_proxy_documented` | BCP DEV evidence | record proxy-review posture | `documented`, `code_config_only` | label only | YES | proxy targets/hosts/ports |
| 6 | `browser_evidence_waiver` | `browser_waived_phase_2_only` | BCP DEV evidence | record the waiver posture | `browser_waived_phase_2_only`, `future_reopen_required` | posture, not the waiver record | YES | who/when/why waiver record |
| 7 | `independent_review` | `independent_review_documented` | BCP DEV evidence | record that independent review occurred | `documented`, `completed` | neutral; **no reviewer/tool/model attribution** | YES | reviewer/tool identity, finding free-text |
| 8 | `scoped_commit_backup` | `scoped_commit_discipline` | BCP DEV evidence | record commit/backup discipline posture | `documented`, `code_config_only` | abstract posture only | **CONDITIONAL** (highest gravity) | commit SHAs, branch, push records, file lists |
| 9 | `source_scope_control` | `source_scope_bounded` | BCP DEV evidence | record source-scope posture | `documented`, `bounded` | abstract posture | **CONDITIONAL** | file paths, changed-file lists, source filenames |
| 10 | `frozen_baseline` | `frozen_baseline` | BCP DEV evidence | record baseline-freeze posture | `frozen_baseline`, `phase_2_only` | label only | YES | raw frozen counts unless accepted static labels |
| 11 | `non_readiness` | `non_readiness_documented` | BCP DEV evidence | structural guard against readiness claims | `not_production_ready`, `phase_2_only` | mandatory non-readiness anchor | **YES (mandatory)** | any readiness/pass/green token |
| 12 | `regression_coverage` | `regression_documented` | BCP DEV evidence | record regression posture | `documented`, `frozen_baseline` | label only | YES | per-lens counts, failing-case names |

## 11. Excluded / Unsafe Evidence Inventory (Section E continued)

The following must **never** appear in Candidate G output, at any depth, in any field, as a value or a field name: raw command output / stdout / stderr; raw test/typecheck/static-scan output; `X/Y passed` or any run-derived count; coverage %, ratios, scores, durations, timestamps of runs; stack traces, raw errors, exception text, assertion diffs, snapshots; file paths, source filenames, directories, globs, import paths; package / dependency / version (`pkg@1.2.3`), lockfile data; CVE ids, advisory ids, rule ids, severities, finding lists; screenshots, videos, traces, reports, report paths; CI job ids/urls, run ids, build numbers, pipeline/workflow/runner names; VCS identity (commit SHA, branch, ref, tag, PR, author, commit message); host/OS/arch/node-version/engine data; secrets, tokens, credentials, passwords, private keys, connection strings, URLs, domains, emails; tenant/store/customer/user/identity/audit data; permission/RBAC keys; **production-readiness claims** of any kind. `static_scan`, `scoped_commit_backup`, and `source_scope_control` are **conditional-include**: keep only if their posture enum can be guaranteed value-free; otherwise **exclude** the category rather than ship it.

## 12. Future DTO / Output Contract (Section F, strengthened)

Proposed (planning recommendations only — not implemented in M19): schemaVersion `bcp.c06.quality-gates-evidence-coverage-readiness.v1-code-config`; route `/dev/bcp/quality-gates-evidence-coverage-readiness`; proxy `/__identity/dev/bcp/quality-gates-evidence-coverage-readiness`; flag `ENABLE_BCP_DEV_C06_QUALITY_GATES_EVIDENCE_COVERAGE_READINESS`.

- **Uniform item model (recommended over bespoke per-category top-level fields):** model every category as a uniform `evidenceItems[]` element of shape `{ evidenceKey, evidenceLabel, ownerSurface, evidencePurpose, posture, evidenceStatus }`, where every string field is a member of a **closed, curated enum** (no free text — `evidenceLabel`/`evidenceKey` must NOT be free text), plus the same invariant top-level posture facts C-05 uses. Uniformity removes the per-category special-casing seam where scope creep begins.
- **Envelope fields:** `schemaVersion`, `sourceMode`, `generatedAt` (synthetic constant), `freshness`, `summaryCounts` (omit or static-cardinality only), `evidenceItems`, `emptyState`, `warnings`, plus bounded posture facts (`redactionPosture`, `logExposurePosture`, `productionPosture`, `mutationPosture`).
- **Positive output-key allow-list is mandatory and recursive:** only an explicitly enumerated set of field names may appear at any depth; everything else is rejected by a fitness function. The prohibited-field denylist below is defense-in-depth only.
- **Prohibited field names (expanded denylist — defense-in-depth):** the original Section F list plus the CI/metrics/timing/VCS/version/free-text families: `coverage`, `coveragePercent`, `percent`, `ratio`, `score`, `metric`, `loc`, `cvss`, `severity`, `passCount`, `failCount`, `passed`, `failed`, `skipped`, `pending`, `errorCount`, `warningCount`, `testCount`, `numPassed`, `numFailed`, `findingCount`, `findings`, `cve`, `cveId`, `vuln`, `advisory`, `lastRun`, `ranAt`, `executedAt`, `timestamp`, `duration`, `elapsed`, `startTime`, `endTime`, `runId`, `runNumber`, `buildNumber`, `jobId`, `pipeline`, `workflow`, `runner`, `ciStatus`, `ciUrl`, `branch`, `sha`, `commit`, `commitHash`, `commitMessage`, `author`, `ref`, `tag`, `pr`, `nodeVersion`, `npmVersion`, `os`, `platform`, `arch`, `hostname`, `cwd`, `dir`, `module`, `importPath`, `glob`, `pattern`, `packageName`, `pkg`, `lockfile`, `rule`, `ruleId`, `lint`, `message`, `msg`, `description`, `text`, `note`, `comment`, `testName`, `testFile`, `suite`, `spec`, `assertion`, `expected`, `actual`, `diff`, `snapshot` (in addition to the base set: log/logs/rawLog/output/rawOutput/commandOutput/stdout/stderr/stack/stackTrace/error/rawError/exception/filePath/path/filename/sourcePath/line/column/package/dependency/version/buildId/artifact/trace/screenshot/video/report/reportPath/ciJob/runtime/command/shell/env/secret/token/url/domain/databaseUrl/supabaseUrl/authProvider/tenantId/storeId/userId/email/raw/details). Do not expose raw status objects, raw logs, or build/runtime data.

## 13. Future Provider Contract (Section G, strengthened)

All Provider Contract requirements (this Section 13; the milestone's lettered Section G) apply (server-owned; code/config-only; hard allow-list of accepted categories; no raw logs/output/test/typecheck/static-scan/transport output; no screenshots/videos/traces/reports; no CI logs; no package/dependency inventory; no file paths/filenames; no runtime diagnostics; no shell exec; no DB/SQL/Supabase/Supabase-MCP/live provider; no network/fetch; no request/auth/tenant/store/customer/identity/audit dependency; no backend action/mutation; no production-readiness claim; no customer-facing exposure; no permission/RBAC keys; no sensitive row import; no frontend `mockData` import; no backend import from frontend `src`; defensive copy; frozen constants; fitness functions that FAIL on a non-allow-listed category, any prohibited field, or any secret-like string). Strengthened additions: **no `fs`/`child_process`/`process.env`-for-output/clock access** (source-token-scanned); the curated frozen constant is the only data source.

## 14. Future Read Model Contract (Section H, strengthened)

All Read Model Contract requirements (this Section 14; the milestone's lettered Section H) apply (accept only provider entries; sanitize/redact all labels; redact secret-like strings; reject/redact non-allow-listed categories; reject raw-log/output/stack/error/file-path/package/screenshot/trace/report/runtime/build/CI fields; bounded counts only; safe empty state; no raw object dumps/stacks/errors; no tenant/store/customer/identity/audit data; no secrets/tokens/URLs/domains/credentials/DB strings; no production-readiness claim; no DB/Supabase/live access; deterministic no-throw; synthetic `generatedAt`). Strengthened: the read model must be a **constructive builder** (read only known fields via a `readField`-style accessor; never spread untrusted input) with **per-field closed-enum normalization** (out-of-vocab → safe fallback, never passthrough) and a **value-shape sanitizer** on every emitted string — exactly the C-05 mechanism, extended to C-06's larger enum set.

## 15. Future Route / Adapter / Registration Contract (Section I)

Reuse the proven C-02→C-05 spine verbatim: DEV-only; default-off feature flag; production-disabled; GET-only success; HEAD bodyless; OPTIONS 204; POST/PUT/PATCH/DELETE 405; server-side guard before success; provider resolved only after DEV+flag gates pass; request values not authority; no request-supplied evidence list; no request-supplied sourceMode/schemaVersion authority; no raw errors/stacks; no DB/Supabase/live provider; no backend action/mutation. Registration is a **single isolated `app.all`** on the platform-identity API only — no SaaS route, no customer-facing route, no production route, no `src/App.tsx` change, no SaaS navigation. Additive authorization-guard entry only if required, at the `overview_viewer` floor, introducing no write/manage/approve visibility. Any change behind an "only if required" / "unless separately approved" carve-out (including any `src/App.tsx` touch) MUST remain DEV-only, non-customer-facing, non-production, and requires an explicit owner-approved milestone gate — the carve-out is never a customer-facing or production door. **C-06 must not modify C-05**: introducing the C-06 flag does not change C-05's "exactly 6 flags" snapshot; C-05 stays frozen and is knowingly not flag-complete (accepted residual R-G3, Section 31).

## 16. Future Client / UI Contract (Section J)

Future client: GET only; accepted DEV proxy only; no body; `credentials: 'omit'`; no Authorization header; no UID/email/tenant/store/customer/identity fields; no evidence-category list sent; no sourceMode/schemaVersion authority; no production endpoint; normalize all failures to safe states; redact unsafe labels; reject raw-log/output/path/error/package-like fields; never surface raw objects/errors/stacks/logs/command output/artifacts. Future UI: Backend-CP DEV internal only; button-triggered (no auto-fetch, no `useEffect` fetch); read-only; no destructive/backend-action/mutation controls; no raw JSON/error/stack rendering; no `dangerouslySetInnerHTML`; display only safe posture labels (no raw logs/command output/test-typecheck-scan output/file paths/package details/screenshot-trace-video-report links/production-readiness claim); include a visible warning that **raw logs and command output are never shown**. Browser evidence remains waived Phase 2.0 only and must reopen before production/Phase 3/Phase 4/customer-facing release.

## 17. Future Test Requirements (Section K, strengthened by review)

All Section K provider/read-model/route-adapter/client/regression tests apply. Review proved the C-05 field-level fitness functions **do not transfer as-is**; the following NEW/strengthened fitness functions are **required** before implementation-ready (these are core M19A deliverables to specify):

1. **Recursive output-key ALLOW-LIST (subset) assertion** — every key at every depth must be in `ALLOWED_FIELD_NAMES`; an allow-list is complete by construction where a denylist is not. (Extends C-05's top-level `deepEqual(keys, KEYS)` recursively.)
2. **VALUE-content scan over the serialized envelope** — regex over `JSON.stringify(envelope)` rejecting path separators / drive letters, file extensions (`.ts/.js/.log/.json/.png/.snap`), `://`, semver `\d+\.\d+\.\d+` and `pkg@version`, `CVE-\d{4}-`, coverage `\d+%` and `\d+/\d+`, stack markers (`at `, `Error:`, `.stack`), emails, long hex/base64. This is the only check that catches a prohibited **value** hidden inside an allowed field — the single most important missing control.
3. **Env/FS/clock-invariance differential test** — run the builder, then mutate every would-be live source (flip/unset candidate env vars; drop fake `coverage-final.json`/`lcov.info`/`junit.xml` in a temp dir; advance the clock), re-run, assert the envelope is byte-identical. Distinguishes a static constant from a live read.
4. **Production-readiness-claim ban** — output scan denying `ready/production_ready/release_ready/certified/approved/pass/passed/green/ship` in any emitted label or value (new — no C-05 list covers this).
5. **Per-category closed-enum vocabulary assertions** — every posture field value ∈ its bounded `Set`; out-of-vocab input → fallback, never passthrough.
6. **Constructive-builder value-injection proof** — feed a hostile entry carrying prohibited fields AND a prohibited value inside `evidenceLabel`; assert the output passes all fitness functions AND the serialized output contains none of the injected tokens.
7. **Static counts only** — if counts exist, assert `total === ALLOWED_CATEGORIES.length`, every count ≤ allow-list cardinality, and (via test 3) invariance; otherwise omit counts.
8. **Regression** — C-01..C-05 remain passing unchanged.

Matching strategy for the denylist layer: anchored allow-list (subset) + suffix-shape rule (a field name is admissible only if it ends in `Posture|Status|Label|Surface|Key|Counts` or is in a small structural allow-list) + stem denylist applied even to suffix-approved names (so `filePathLabel`/`stackTextLabel` are rejected) + the value-content scan — all deep + case-insensitive.

## 18. Future Static Scan Requirements (Section L, strengthened)

All Section L absence-scans apply (no raw log/command-output/stdout/stderr/test/typecheck/static-scan output exposure; no stack/raw-error rendering; no file-path/source-filename exposure; no package/dependency/version exposure; no screenshot/trace/video/report exposure; no CI/CD log exposure; no runtime diagnostics/build internals; no production-readiness claim; no `createClient`/`@supabase`/`getDb`/`DATABASE_URL`/`SUPABASE_URL`/`SUPABASE_KEY`/secret/token/credential/password/private-key/connection-string; no raw JSON rendering; no `dangerouslySetInnerHTML`; no POST/PUT/PATCH/DELETE fetch / Authorization header / credentials include from client; no backend-action/mutation success path; no customer-facing/production endpoint; no SaaS-nav exposure; no `src/App.tsx` route exposure unless separately approved). **Strengthened — source-token scan for "no live read":** provider/read-model source must contain none of `process.env` (output path), `fs.`/`readFile`/`readdir`/`glob`, `child_process`/`execSync`/`spawn`, `fetch(`/dynamic `import(`/`require(`, `Date.now`/`new Date(`/`performance`/`hrtime`, and CI/coverage tokens `coverage/istanbul/nyc/c8/lcov/junit/vitest/jest/mocha`. Matches in denylist/redaction tests and comments must be classified by context (executable vs test-only vs comment) and reported by path — not ignored.

## 19. Future Stop Conditions (Section M)

Stop and report a blocker for any future Candidate G work if any of these is required: reading raw logs / raw test-typecheck-static-scan output / raw transport logs / command output for provider data; showing stack traces, raw errors, file paths/source filenames, package/dependency/version details, screenshots/traces/videos/reports, runtime diagnostics/build internals, or production-readiness claims; adding dependency installs or package/lockfile changes; adding DB/Supabase/live-provider access, backend action/mutation, production route/config, customer-facing route, or SaaS navigation; modifying `src/App.tsx` without separate approval; using a request-supplied evidence list as authority; exposing auth/session/tenant/store/customer data or permission/RBAC keys; any C-01..C-05 regression; tests failing un-fixably within approved scope; typecheck gaining touched-file errors; or static scan finding unsafe exposure.

## 20. Current Baseline Reconfirmation (Section N)

Run via the self-contained C-01..C-05 `tsx` test harness and `tsc --noEmit`; static checks via git/grep. All green and unchanged from the M18 freeze.

## 21. Test Results

| Lens | Total | Expected | Result |
|---|---|---|---|
| C-01 | `106/106` | `106/106` | PASS |
| C-02 | `122/122` | `122/122` | PASS |
| C-03 | `126/126` | `126/126` | PASS |
| C-04 | `146/146` | `146/146` | PASS |
| C-05 | `170/170` | `170/170` | PASS |
| **Aggregate** | **`670/670`** | `670/670` | PASS |

No test skipped; none marked NOT RUN.

## 22. Typecheck Result

`npx tsc --noEmit` → **12** pre-existing baseline errors (unrelated files), unchanged; **0** in `server/bcp-pilot/**`; **0** in `src/backend-control-plane/**`; **0** in C-01..C-05 surfaces. No unrelated baseline error fixed.

## 23. Static Scan Results

- No tracked-modified files except `.replit`; no `package.json`/`package-lock.json` change.
- No executable `createClient`/`@supabase`/`getDb`/`DATABASE_URL` in C-01..C-05 source (matches are comments / test-only denylist assertions).
- No `console.log`/`stdout`/`stderr`/`stackTrace`/`child_process`/`execSync`/`spawn` emit in C-01..C-05 source.
- Confirms no raw env-value, value-oracle, log-output, or diagnostics surface currently exists in the Backend-CP evidence lenses, and no frozen surface changed.

## 24. Independent Review Results (Section O)

Three independent passes were run (security / evidence-exposure red-team; planning / contract architecture & isolation; fitness-function enforceability), exceeding the ≥2 requirement. All three converge on **Decision B**. Key findings, all reconciled into this document (Sections 9, 12–14, 17–18, 31):

- The **positive allow-list must be the primary control**; the prohibited-field denylist is defense-in-depth and was domain-incomplete (CI/metrics/timing/VCS/version/free-text families added in Section 12).
- The C-05 **field-level fitness functions do not transfer as-is** — demonstrated mechanically: exact-match key-walk misses decorated names (`ciJobUrl`/`stackText`/`filePathLabel`) and never inspects values. New checks required (Section 17): recursive output-key allow-list, value-content scan, env/FS/clock-invariance differential, production-readiness-claim ban, per-field enum vocab, value-injection proof.
- **Uniform `evidenceItems[]`** is preferred over bespoke per-category fields; `evidenceLabel`/`evidenceKey` must be closed enums, not free text.
- **Counts** should be omitted or restricted to env/runtime-invariant static cardinalities with a proof test.
- **Category hardening:** `static_scan`, `scoped_commit_backup`, `source_scope_control` are conditional-include (value-free posture only, else exclude); `independent_review` neutral with no reviewer/tool attribution; `browser_evidence_waiver` posture not record; `non_readiness` mandatory.
- **C-05 coupling:** C-06's flag is a 7th DEV flag; C-06 must not touch C-05's frozen 6-flag snapshot (accepted residual R-G3).

No finding requires a source/test/runtime change in M19 (all are contract refinements captured in docs), so no blocker arises. The transport/authority/isolation spine was independently confirmed ready and reusable.

## 25. Browser Evidence Waiver Impact

Browser evidence remains NOT RUN and waived for Phase 2.0 only (M15A). No browser tooling, package, or lockfile change in M19. Browser evidence must reopen before production readiness / Phase 3 / Phase 4 / any customer-facing release / any separately authorized browser-tooling milestone. Candidate G is a posture-label lens and introduces no browser-evidence dependency.

## 26. Non-Readiness Statements (Section R)

Phase 2.0 remains: not production readiness; not customer-facing release; not Phase 3 controlled actions; not Phase 4 production readiness; not live DB/Supabase reads; not live provider reads; not Supabase auth enablement; not Firebase-to-Supabase cutover; not browser-evidence completion for production/customer-facing release. **Firebase remains authoritative. Supabase remains dormant/shadow/readiness-only. Backend CP remains DEV-only and read-only in Phase 2.0.**

## 27. Recommended Next Milestone (Section Q — Decision B branch)

**Phase 2.0 M19A — Candidate G Source Inventory / Safety Contract Deepening (docs-only).**

**Purpose:** freeze, in documentation, the contract points that block implementation, each with a mechanically-enforceable specification. No code, no raw evidence exposure.

**Exact unknowns to close (the M19A deliverable):**
1. **Freeze the evidence-category allow-list** — choose the final set (resolve 6 vs 12), express it as a hard, index-aligned allow-list with tuple correspondence `(evidenceKey, evidenceLabel, ownerSurface, evidencePurpose)`, and confirm the conditional categories (`static_scan`, `scoped_commit_backup`, `source_scope_control`) can be value-free or exclude them.
2. **Freeze the DTO item model** — adopt the uniform `evidenceItems[]` shape and the closed posture-label enum vocabularies per field (readiness-token-free), and the positive output-key allow-list.
3. **Specify the NEW fitness functions** — recursive output-key allow-list (subset), value-content scan over serialized output, env/FS/clock-invariance differential, production-readiness-claim ban, per-field enum vocab, value-injection proof, static-counts-only — with the layered matching strategy (allow-list + suffix-shape + stem denylist + value scan, deep + case-insensitive).
4. **Resolve the C-05 frozen-baseline coupling** — document that C-06 does not modify C-05; C-05 stays a knowingly-not-flag-complete 6-flag snapshot (accepted residual).

**Safe source inventory steps (M19A):** static inspection only of existing C-01..C-05 docs/screens/script names for safe category names and owner surfaces; no raw logs/reports/output/paths read; document using safe posture labels only.

**M19A constraints:** no code/test/frontend/backend/route/UI/package/migration/DB/Supabase/auth/runtime change; no raw-evidence exposure; final report; scoped docs commit only (single new doc). M19A must also **enumerate or precisely cite** the inherited Provider / Read-Model / Test / Static-Scan control sets (this document's Sections 13/14/17/18) so M20 inherits a fully-enumerated baseline rather than count-only references. After M19A freezes the four points, **M20 — C-06 implementation** becomes mechanical pattern reuse and Decision A becomes appropriate; the M20 package (allowed/prohibited files; provider/allow-list/no-raw-evidence/read-model/DTO/route/adapter/registration/client/UI contracts; tests; static scans; typecheck; transport evidence; browser-waiver handling; independent review; stop conditions; final report; commit/backup rules) will be assembled from Sections 12–19 of this document.

## 28. Allowed Files for Next Milestone (M19A)
- `docs/phase-2.0-backend-control-panel-candidate-g-source-inventory-and-safety-contract-deepening.md` (only).

## 29. Prohibited Files for Next Milestone (M19A)
- All source/test/frontend/backend/route/UI/config/package/migration/DB/Supabase/auth files; C-01..C-05 implementations; `server/platform-identity/server.ts`; `server/bcp-pilot/bcpAuthorizationGuard.ts`; `src/backend-control-plane/screens.tsx`; `src/App.tsx`; SaaS navigation; `.replit`; `.gitattributes`; the goose tarball; any other doc or file.

## 30. Stop Conditions for Next Milestone (M19A)
Stop and report a blocker if M19A would require any code/test/runtime change; any raw-evidence (log/output/path/count/CVE/SHA) exposure to make a contract decision; any prohibited-file change; reading live logs/reports/command output; or if a category's safe value-free posture cannot be defined (then exclude that category). Preflight must pass (branch, checkpoint, clean status, `.gitattributes` absent).

## 31. Risks / Accepted Residuals

| # | Residual | Severity | Disposition |
|---|---|---|---|
| R-G1 | Browser evidence NOT RUN, waived Phase 2.0 only. | Accepted | Reopen before prod / Phase 3 / Phase 4 / customer-facing / browser-tooling milestone. |
| R-G2 | Curated posture labels can drift from reality if not updated after a regression. | Accepted | Disclaimed by `sourceMode: code_config` + `freshness: code-config-no-live-read` + UI "labels only, no live reads" warning. No reconciliation mechanism (YAGNI). |
| R-G3 | C-05 enumerates exactly 6 backend-CP flags; C-06 adds a 7th. | Accepted | C-06 must not modify C-05; C-05 stays a knowingly-not-flag-complete 6-flag snapshot. This debt compounds (each future lens widens C-05's known flag-incompleteness); M19A/M20 should set a re-freeze trigger to refresh the C-05 flag snapshot once the BCP flag set stabilizes. |
| R-G4 | Lens subject is CI-tool output → structural scope-creep pull toward a diagnostics/CI console. | Open → closed in M19A | Pinned `sourceMode: code_config` + `freshness: code-config-no-live-read` + the new no-run-derived-data fitness functions (Section 17) make regression into a live console fail a test. |
| R-G5 | `static_scan` / `scoped_commit_backup` / `source_scope_control` categories carry the highest leak gravity. | Open → resolved in M19A | Conditional-include only if value-free posture is guaranteed; otherwise exclude. |

*Residual status: R-G1/R-G2/R-G3 are **accepted** now; R-G4/R-G5 are currently **Open** and close in M19A as noted in their Disposition column.*

## 32. Git Status

Expected at end of M19 (after this doc is created, before any commit):

```
 M .replit
?? docs/phase-2.0-backend-control-panel-candidate-g-quality-gates-evidence-coverage-planning-gate.md
?? goose-x86_64-unknown-linux-gnu.tar.bz2
```

## 33. No Commit / Push / Backup Confirmation

No `git add`, commit, push, or backup was performed during M19. Staging is empty. `.replit` remains unstaged; the goose tarball remains untracked; `.gitattributes` remains absent. The only repository change is the addition of this single untracked documentation file.

## 34. Acceptance Recommendation

**Recommend ACCEPT (Decision B).** Candidate G is the safest next read-only lens and the isolation pattern is proven, but the safe source contract requires a tightly-scoped deepening pass (M19A) — with mechanically-enforceable fitness functions — before implementation. This document captures the strengthened contract so M19A and M20 inherit it.

## 35. Recommended Next Step

If accepted: **Phase 2.0 M19 — Scoped Commit and Backup Authorization** (stage only this M19 doc; fast-forward non-force push), then proceed to **Phase 2.0 M19A — Candidate G Source Inventory / Safety Contract Deepening** (docs-only). Do not commit, push, or back up until explicitly authorized. Stop for owner review.

---

*End of Phase 2.0 M19 report. Docs-only. No source/test/config/runtime change. No commit, push, or backup performed. Decision B — proceed to M19A after owner acceptance. Stop for owner review.*
