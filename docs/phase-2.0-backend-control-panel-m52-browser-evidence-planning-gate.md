# Phase 2.0 — Backend Control Panel — M52 Browser Evidence Planning Gate

Status: DOCS-ONLY PLANNING GATE. No browser evidence is executed, no server is
started, no browser tooling is added, and no source/test/package/runtime file is
changed by M52. This document decides the smallest safe next milestone for gathering
browser evidence now that the C-07 Data Source Boundary Readiness card is registered
and visible inside the existing Backend Control Panel readiness gate.

Accepted pre-change checkpoint: `d528e096e5731720473bfe0562e6385b3dbed346`.
Most recent committed milestone: `Phase 2.0 M51 close out backend control panel C07 ui visibility`.

---

## 1. Executive Summary

The C-07 UI card is registered and visible as a DEV-only sub-tab; formal browser
evidence remains waived (Phase 2.0 only). M52 plans the smallest safe browser-evidence
increment. The repository already ships an existing dev server (`npm run dev` =
`tsx server/index.ts & vite --port=5000 --host=0.0.0.0`), an existing `vite preview`
script, and a Replit workflow bound to port 5000 — so a manual DEV smoke can be
performed **without any package, lockfile, tooling, or source change**. Reaching the
Backend Control Panel route additionally requires the DEV build plus the environment
flag `VITE_ENABLE_BACKEND_CONTROL_PLANE=true` (`BCP_ROUTE_ENABLED = IS_DEV &&
BCP_FLAG_ON`, `bcpEnv.ts:40`) — an environment-config setting, not a code/package
change; if the flag is off, the safe disabled/unavailable render is itself a valid
evidence objective. No browser tooling (Playwright/Cypress/vitest-browser) is present
and none is proposed.

**Decision A — Browser Evidence Execution Plan Locked.** Proceed to **M53 — Manual
DEV Browser Evidence Report** (docs-only, evidence-only): safe summary observations
only; no source/test/package change; no browser tooling; no screenshots, logs,
traces, videos, or raw network/response bodies committed. All baselines remain green
or explicitly unchanged.

---

## 2. Preflight Result

PASS. Branch `main`; HEAD == origin/main == `d528e096e5731720473bfe0562e6385b3dbed346`;
ahead/behind 0/0. Working tree shows only ` M .replit` and
`?? goose-x86_64-unknown-linux-gnu.tar.bz2` (both out of scope). `package.json` and
`package-lock.json` clean; nothing staged; `.gitattributes` absent. M51 commit present.
Because HEAD == origin/main, this is the pre-change backup checkpoint. No implementation
change, no browser-evidence execution, and no commit/push/backup occurs during M52.

---

## 3. Files Created

- `docs/phase-2.0-backend-control-panel-m52-browser-evidence-planning-gate.md` (this
  file only, if accepted for commit under the separate scoped-commit milestone).

## 4. Files Modified

None.

## 5. Files Confirmed Untouched

`screens.tsx`, C-07 card, C-07 client, all tests, `App.tsx`, SaaS navigation,
`mockData.ts`, `types.ts`, `Shell.tsx`, all `server/**` backend frozen surfaces,
`server/platform-identity/server.ts`, transport-matrix / route / adapter / provider /
read-model / guard files, `package.json`, `package-lock.json`, `shared/**`,
DB/Supabase files, browser tooling. `.replit` remains an unstaged, out-of-scope
pre-existing modification; the goose tarball remains untracked; `.gitattributes`
remains absent.

---

## 6. M51 Backup Review

1. M51 commit hash: `d528e096e5731720473bfe0562e6385b3dbed346`. Confirmed.
2. M51 commit subject: `Phase 2.0 M51 close out backend control panel C07 ui visibility`. Confirmed.
3. `origin/main` matches local HEAD (0/0). Confirmed.
4. Push was fast-forward and non-force: the M51 commit's parent is the M50 checkpoint
   `1a3d40e...`, a linear fast-forward with no forced-update marker. Confirmed.
5. Exactly one M51 docs file was committed (401 insertions). Confirmed.
6. No source/test/package/runtime file was committed. Confirmed.
7. C-07 UI registration closeout was accepted (M51 Decision A). Confirmed.
8. Browser evidence remained waived after M51. Confirmed.
9. M52 Browser Evidence Planning Gate was selected as the next path. Confirmed.

---

## 7. Current UI Target Review

High-level inspection of `screens.tsx`, `C07DataSourceBoundaryReadinessCard.tsx`, and
`bcpC07Client.ts`:

1. C-07 card is registered inside `BackendCpReadinessGate` (import at `screens.tsx:85`;
   dispatch at `screens.tsx:1672-1676`). Confirmed.
2. C-07 appears as a sub-tab labelled **"C-07 Data Source Boundary"** (`screens.tsx:1612`). Confirmed.
3. Registration is inside the existing Backend Control Panel readiness-gate UI only. Confirmed.
4. No `App.tsx` route was added. Confirmed.
5. No SaaS-navigation entry was added. Confirmed.
6. C-07 card uses button-triggered load (`React.useCallback` `load` at
   `…Card.tsx:199`, bound to `onClick={load}` at line 216). Confirmed.
7. C-07 card does not auto-fetch on mount (no `useEffect` fetch; the only `useEffect`
   token is a comment stating no auto-fetch). Confirmed.
8. C-07 card does not render `generatedAt`, timestamps, raw JSON, raw errors,
   diagnostics, stack traces, env values, secrets, tokens, package/file paths,
   production-readiness claims, browser-evidence claims, or real-socket claims (view
   model renders closed-enum labels and bounded counts only; the C-07 view model has
   no `generatedAt`/timestamp). Confirmed.
9. C-07 client remains a same-origin Backend CP proxy call only. Confirmed.
10. C-07 client remains GET-only (`method: 'GET'`, `bcpC07Client.ts:327`). Confirmed.
11. C-07 client uses `credentials: 'omit'` (`bcpC07Client.ts:328`). Confirmed.
12. C-07 client sends no Authorization header (`headers: { accept: 'application/json' }`
    only, `bcpC07Client.ts:329`; the only `Authorization` tokens are comments stating
    none is sent). Confirmed.
13. C-07 client sends no request body. Confirmed.
14. C-07 client uses no query authority. Confirmed.
15. C-07 client emits a safe sanitized view model only. Confirmed.
16. Browser evidence can be targeted at the readiness-gate screen and the C-07 tab
    only. Confirmed.

Route-gate mechanism (relevant to M53 reachability): `BCP_ROUTE_ENABLED = IS_DEV &&
BCP_FLAG_ON` where `IS_DEV = (import.meta.env.DEV === true)` and `BCP_FLAG_ON =
(import.meta.env.VITE_ENABLE_BACKEND_CONTROL_PLANE === 'true')` (`bcpEnv.ts:29/32/40`);
the `BackendControlPlaneApp` route is `React.lazy`-registered only when
`BCP_ROUTE_ENABLED` (`App.tsx:69/166-171`) and is excluded from production builds.

---

## 8. Browser Evidence Objectives (for M53)

The minimum M53 evidence objectives, each recordable as a safe pass/fail observation:

1. DEV preview/app loads using the existing dev server / Replit preview, with no
   package change.
2. Backend Control Panel readiness-gate screen is reachable through the existing UI
   path (with the DEV build and `VITE_ENABLE_BACKEND_CONTROL_PLANE=true`).
3. The "C-07 Data Source Boundary" sub-tab is visible.
4. Selecting the C-07 tab renders the C-07 card.
5. The card initially renders a safe static/idle state.
6. The card exposes only safe labels and disclaimers.
7. The card does not display `generatedAt` or timestamps.
8. The card does not display raw JSON, diagnostics, stack traces, raw errors, command
   output, env values, secrets, tokens, package/file paths, URLs, production-readiness
   claims, browser-evidence claims, or real-socket claims.
9. The card's load button is visible and clearly labelled.
10. Triggering load requires no user/tenant/store/customer authority input.
11. Triggering load sends no credentials, Authorization header, request body, or query
    authority — recorded only if network observation is available safely (high-level
    summary, no raw dumps).
12. The loaded result renders safe sanitized fields only (if the DEV flag and route
    are available).
13. If the route/flag is disabled, the card renders a safe disabled / unavailable /
    dev-only / error state without raw details.
14. No mutation/action/approval/override/write controls are visible.
15. No customer-facing navigation exposure is introduced.
16. No normal SaaS navigation outside Backend CP exposes C-07 directly.
17. No formal production-readiness claim is made.

Screenshots are not required and are not requested; raw logs and raw network dumps are
not required.

---

## 9. Evidence Collection Boundaries (for M53)

Allowed M53 evidence: safe summary observations; a pass/fail checklist; internal
non-sensitive route/screen names only; high-level network-observation summaries (if
available without raw dumps); high-level render-state summaries; confirmation that no
unsafe strings are visible; confirmation that no package/lockfile/source change
occurred; confirmation that browser evidence remains DEV-only and not production
readiness.

Note on names vs URLs: the "internal non-sensitive route/screen names" permitted in the
M53 report prose (e.g. the "readiness gate" screen or the "C-07 Data Source Boundary"
tab label) are distinct from the card-render prohibition in Section 8 objective 8 —
the rendered C-07 card must display no URLs, and these permitted names are plain
internal labels carrying no URL, query authority, or identifier.

Prohibited M53 evidence (must not be captured, committed, or pasted): raw screenshots
committed to the repo; raw browser console logs; raw network HAR files; raw
request/response headers; raw response bodies; cookies; tokens; credentials; session
data; tenant/store/customer/user identifiers; localStorage/sessionStorage dumps; stack
traces; runtime diagnostic dumps; package/dependency inventories; file-path
inventories; environment variables; command-output dumps; videos/traces; any generated
artifact committed.

If the owner takes screenshots manually, they must remain local/uncommitted and must
not include sensitive content; prefer safe textual summaries.

---

## 10. M53 Evidence Options

- **Option A — M53 Manual DEV Browser Smoke Evidence, docs-only report. SELECTED.**
  Use the existing dev server / Replit preview (no code/tooling/package change) to
  navigate to the Backend CP readiness gate, select the C-07 tab, optionally click
  load, and record safe summary pass/fail evidence. Chosen because browser evidence
  can be performed with existing infrastructure and no changes.
- Option B — M53 Browser Evidence Dry-Run Checklist Only. Fallback if preview/server
  access turns out to be unavailable or unsafe at M53 execution time.
- Option C — M53 Browser Evidence Environment Readiness Fix. Only if the smoke cannot
  run due to environment configuration; planned separately, not implemented in M52.
- Option D — Defer browser evidence and proceed to DEV-gate planning. Only on explicit
  owner redirect.

---

## 11. Locked M53 Plan (Option A)

**M53 title:** Phase 2.0 M53 — Manual DEV Browser Evidence Report.

**Allowed final artifact:** `docs/phase-2.0-backend-control-panel-m53-browser-evidence-report.md` (only).

**Hard constraints:** no source file change; no test file change; no package/lockfile
change; no browser tooling added; no screenshots/logs/traces/videos committed;
evidence recorded as safe summaries only; anything not observed marked NOT RUN /
NOT OBSERVED; no overclaim.

**M53 must report:** (1) preflight git state; (2) existing server/preview command used
(safe summary); (3) whether DEV preview opened; (4) whether the Backend CP readiness
gate was reachable; (5) whether the C-07 tab was visible; (6) whether the C-07 card
rendered; (7) whether the initial state was safe; (8) whether the load action was
available; (9) whether load was clicked; (10) whether the result was a safe success or
safe non-success; (11) whether unsafe strings were absent; (12) whether no
mutation/action/approval/override controls were visible; (13) whether no
customer-facing / SaaS-nav exposure was observed; (14) whether no package/source/test
change occurred; (15) whether no screenshots/logs/traces/videos were committed; (16)
whether browser evidence remains DEV-only and not production readiness.

Reachability note for M53: to exercise the loaded (non-disabled) path, the DEV server
must run with `VITE_ENABLE_BACKEND_CONTROL_PLANE=true` (environment config, not a
code/package change). If the flag is not set, M53 records the safe disabled/dev-only
render as the observed state (objective 13) rather than forcing any config change
beyond a DEV environment variable.

---

## 12. Test / Typecheck / Static Scan Reconfirmation

Fresh this gate (safe summaries):

- Tests: full BCP corpus 1351/1351 assertions; 42/42 test files green; 0 non-green;
  no test-count drift. The C-07 client (67/67), guard/pilot (35/35), C-07 route
  (39/39), C-07 adapter (26/26), C-07 registration (18/18), C-07 provider (43/43),
  C-07 read-model (41/41), and C-07 transport-matrix (124/124) suites are subsumed in
  the green corpus at their accepted counts; C-01…C-06 unchanged and green.
- Typecheck: 12 unrelated baseline errors, unchanged, all in the same non-BCP files;
  0 errors in `src/backend-control-plane`; 0 BCP-surface errors. (The editor LSP
  `react`-declaration TS7016 diagnostic remains a non-authoritative artifact; the
  authoritative `tsc --noEmit` is 0 on BCP surfaces.)
- Static scan: no change to package files, browser tooling, source/test files, the
  C-07 card, the C-07 client, `screens.tsx`, or backend frozen surfaces — M52 modifies
  no such file.

Nothing was left NOT RUN.

---

## 13. Browser Evidence Safety / Privacy Review

The planned M53 evidence is constrained to safe summary observations and a pass/fail
checklist. Prohibited artifacts (screenshots, console logs, HAR files, raw headers,
response bodies, cookies, tokens, credentials, session data, identifiers, storage
dumps, stack traces, env values, command output, videos/traces) are explicitly barred
from capture and commit. The C-07 client is GET-only, `credentials: 'omit'`, no
Authorization header, no body, no query — so a network observation, if made, carries
no credential/identity payload. The route is DEV-only and production-excluded. No
privacy or secret-exposure risk is introduced by the planned evidence.

---

## 14. Independent Review Results

Four independent lenses were run against this planning document and the live target;
verdicts are captured as produced.

- Browser-evidence safety / privacy review — **APPROVE-WITH-NITS.** All five
  safety/privacy checks PASS: the plan bars capture/commit of every sensitive artifact
  (screenshots-in-repo, console logs, HAR, raw headers/bodies, cookies, tokens,
  credentials, session data, identifiers, storage dumps, stack traces, env values,
  command output, videos/traces); evidence is constrained to safe summaries; the
  GET-only / credentials-omit / no-auth client carries no credential payload; and the
  document makes no "already-gathered" or production/real-socket claim. It further
  confirmed the client's allow-list normalization plus a secondary denylist guard the
  two free-text fields, so even a rendered/screenshotted card cannot surface
  identifiers/secrets/URLs. Two non-blocking nits were reconciled in this pass: the
  names-vs-URLs terminology clarification (added to Section 9) and filling these
  concrete verdicts here (Section 14).
- Browser-evidence scope / no-tooling + factual-accuracy review — **APPROVE.** All
  seven checks PASS: git state and the M51 commit shape verified; `package.json`
  `dev`/`preview` scripts confirmed and zero Playwright/Cypress/vitest-browser/
  puppeteer/webdriver/selenium dependencies present (so M53 needs no package/tooling
  change); the `bcpEnv.ts` route-gate and `App.tsx` lazy registration verified with
  exact line citations; the C-07 target claims (tab label, button-triggered load,
  GET-only client) verified; only the one M52 doc created; no overclaim. Two advisory
  notes (the Section 12 baseline figures were asserted rather than re-executed under
  that lens — they were, however, re-run fresh in this gate; and the Section 2
  preflight tree vs Section 21 post-write tree is an internally-consistent
  preflight-vs-post-write distinction) — both non-blocking, no change required.
- Cross-model plan-soundness / non-readiness review — **SOUND.** No overclaim: the
  document is docs-only, keeps browser evidence unexecuted/waived until M53, asserts no
  production/customer-facing/real-socket/live-provider readiness, and constrains M53 to
  the existing dev server with safe summaries only. No findings.
- In-context verification pass (fresh-evidence gate) — **PASS.** Every factual claim in
  this document is backed by fresh this-turn evidence (git probes, corpus run,
  typecheck run, static scan, and line-context inspection of the dev scripts, route
  gate, card, and client).

No review returned an unresolved blocker. All actionable findings were reconciled in
this docs-only pass. No review verdict is claimed that was not actually produced, and
no review evidence is invented.

---

## 15. M52 Decision

**Decision A — BROWSER EVIDENCE EXECUTION PLAN LOCKED.** M53 can run a safe manual DEV
browser smoke using the existing dev server / Replit preview; no source/test/package/
tooling change is needed; evidence can be reported as safe summaries only; no
screenshots/logs/traces/videos need be committed; no production/customer-facing claim
is made.

---

## 16. Next Governed Step Selection

Proceed to the **M52 Scoped Commit and Backup Authorization** (commit only this M52
doc), then execute **Phase 2.0 M53 — Manual DEV Browser Evidence Report** (docs-only,
evidence-only). Options B/C/D remain available if, at execution time, preview access
is unavailable (B), an environment-readiness fix is required (C), or the owner
redirects to DEV-gate/real-socket work first (D).

## 17. Allowed Files for Next Milestone (M53)

- `docs/phase-2.0-backend-control-panel-m53-browser-evidence-report.md` (only).

## 18. Prohibited Files for Next Milestone (M53)

All source, test, screen, card, client, backend, route/adapter/provider/read-model/
guard, transport-matrix, `App.tsx`, SaaS-navigation, `package.json`,
`package-lock.json`, `shared/**`, DB/Supabase, and browser-tooling files; plus
`.replit`, `.gitattributes`, and the goose tarball. No screenshots/logs/traces/videos
or other generated evidence artifacts may be committed.

---

## 19. Non-Readiness Statements

Browser-evidence planning is not: production readiness; customer-facing release; Phase
3 controlled actions; Phase 4 production readiness; live DB/Supabase readiness; live
provider readiness; Supabase auth enablement; a Firebase-to-Supabase cutover;
real-socket/live-transport completion; security certification. Firebase remains
authoritative. Supabase remains dormant / shadow / readiness-only. Backend CP remains
DEV-only / read-only in Phase 2.0. M52 executes no browser evidence and implements no
browser tooling, no DEV-gate tightening, and no real-socket evidence.

## 20. Risks / Accepted Residuals

- The M53 smoke depends on the existing dev server / Replit preview being usable at
  execution time; if not, M53 falls back to Option B (checklist only) without any
  package/tooling change.
- Reaching the loaded (non-disabled) C-07 path requires a DEV environment flag; absent
  it, the safe disabled render is recorded — no config change beyond a DEV env var.
- Browser/render behavior remains unverified by formal evidence until M53 completes
  (waived, Phase 2.0 only), with the documented reopen triggers unchanged.
- Prior accepted residuals persist: no card-render test; DEV-gate tightening deferred;
  real-socket/live-transport evidence deferred; 12 unrelated typecheck baseline errors;
  non-authoritative editor LSP `react`-declaration artifact.

None is an accept blocker for this planning gate.

## 21. Git Status

Expected working tree after writing this document (safe summary):

```
 M .replit
?? docs/phase-2.0-backend-control-panel-m52-browser-evidence-planning-gate.md
?? goose-x86_64-unknown-linux-gnu.tar.bz2
```

## 22. No Commit / Push / Backup Confirmation

M52 performs no commit, no push, and no backup. HEAD remains
`d528e096e5731720473bfe0562e6385b3dbed346` (== origin/main). This document is an
untracked working-tree file awaiting the separate scoped-commit milestone.

## 23. Acceptance Recommendation

Accept **Decision A — Browser Evidence Execution Plan Locked**, and proceed to the M52
scoped commit/backup.

## 24. Recommended Next Step

1. **Phase 2.0 M52 — Scoped Commit and Backup Authorization** (commit only this M52
   document; scoped selective staging; fast-forward non-force push).
2. After M52 backup: **Phase 2.0 M53 — Manual DEV Browser Evidence Report** (docs-only,
   evidence-only), unless preview access is unavailable (fall back to Option B) or the
   owner redirects.
