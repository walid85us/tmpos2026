# Phase 2.0 — Backend Control Panel — M47 — C-07 UI Card Planning Gate

Status: DOCS-ONLY PLANNING GATE. Proposed, not implemented. No source, test, screen,
package, runtime, or UI change is made by this milestone. This document decides the
smallest safe next UI implementation package after the M46 backend closeout/freeze.

Accepted pre-change checkpoint: `2efe9415c610d1d349787a1ba106bf73cbaac2c6`
(Phase 2.0 M46 freeze backend control panel backend).

Backend source/test freeze evidence checkpoint: `1c76c1de9dbe402d6d2b75b885b7788369bab82c`.

Because HEAD == origin/main at gate open, the accepted checkpoint is itself the
pre-change backup for M47.

---

## Section 1 — Executive Summary

M47 is a documentation-only planning gate. It performs no implementation. It answers
whether C-07 is ready for a UI card, which existing Backend Control Panel card pattern
C-07 must mirror, and what the smallest safe next implementation package is.

The investigation confirms:

- The M46 backend closeout/freeze is accepted and backed up (HEAD == origin/main,
  fast-forward, non-force; exactly one M46 docs file committed).
- C-07 is ready for a UI card: its backend provider, read model, route, adapter, guard
  entry, server mount, registration, and transport-matrix coverage are all implemented
  and green, and its accepted frontend client/sanitizer returns a safe, bounded,
  closed-enum view model with no timestamp and no raw/diagnostic/production-claim surface.
- The established Backend Control Panel card pattern (C-01 through C-06) is a single
  presentational `.tsx` card with **no card-level test file**. Card safety is carried by
  the frozen client sanitizer's own test suite, not by a card-rendering test.
- A card-**rendering** unit test is **not feasible without prohibited package/tooling
  changes**: the project has no React test renderer, no jsdom, no testing-library, no
  vitest/jest; the only test script is `tsc --noEmit`; project tests run as `tsx`
  node-`assert` harnesses that exercise pure logic only. The existing cards use React
  hooks (`useState`/`useCallback`), which cannot be invoked outside a renderer. Adding a
  renderer would require `package.json` + lockfile changes, which are prohibited.

Because of the test-feasibility blocker, the conservative outcome is **Decision B —
C-07 UI Card Component-Only Plan Locked**, not the tentatively-anticipated Decision A.
Decision B mirrors the frozen C-01…C-06 pattern exactly (component-only, no card test),
keeps screen registration deferred, keeps browser evidence waived, and confines the next
milestone to a single new file.

Recommended next governed step: **Phase 2.0 M48 — C-07 UI Card Component-Only
Implementation** (Candidate 2), a single card component file, unregistered from
`screens.tsx`, importing only the accepted C-07 client and the existing safe UI
utilities.

---

## Section 2 — Preflight Result

All preflight checks passed.

1. Branch is `main`. PASS.
2. HEAD and origin/main both equal `2efe9415c610d1d349787a1ba106bf73cbaac2c6`. PASS.
3. Ahead/behind is 0/0. PASS.
4. `git status` shows only `M .replit` and `?? goose-x86_64-unknown-linux-gnu.tar.bz2`.
   PASS.
5. `package.json` is clean (no diff). PASS.
6. `package-lock.json` is clean (no diff). PASS.
7. Nothing is staged. PASS.
8. `.gitattributes` is absent. PASS.
9. M46 commit is present at HEAD (`Phase 2.0 M46 freeze backend control panel backend`).
   PASS.
10. HEAD == origin/main, so this is the pre-change backup checkpoint. PASS.
11. No implementation change occurs during M47. PASS.
12. No commit, push, or backup occurs during M47. PASS.

---

## Section 3 — Files Created

- `docs/phase-2.0-backend-control-panel-m47-c07-ui-card-planning-gate.md` (this file).

No other file created.

## Section 4 — Files Modified

None. M47 is docs-only.

## Section 5 — Files Confirmed Untouched

No source, test, route, adapter, provider, read-model, guard, server mount, registration,
transport matrix, client, screen, `src/App.tsx`, SaaS navigation, package, lockfile,
migration, seed, `shared/**`, auth/audit-writer/identity-repository/sessionResolve, DB /
Supabase, or browser-tooling file was created or modified. `.replit` remains unstaged and
untouched; the goose tarball remains untracked; `.gitattributes` remains absent.

---

## Section 6 — M46 Backup and Backend Freeze Review

1. M46 commit hash: `2efe9415c610d1d349787a1ba106bf73cbaac2c6`. Confirmed.
2. M46 commit subject: `Phase 2.0 M46 freeze backend control panel backend`. Confirmed.
3. origin/main matches local HEAD (ahead/behind 0/0). Confirmed.
4. The M46 push was fast-forward and non-force. Confirmed (linear history at HEAD).
5. Exactly one M46 docs file was committed
   (`docs/phase-2.0-backend-control-panel-m46-backend-closeout-freeze-gate.md`).
   Confirmed.
6. No source/test/package/runtime/UI file was committed in M46. Confirmed.
7. The backend freeze statement is documented in the M46 gate. Confirmed.
8. Frozen backend surfaces (C-01…C-07 providers, read models, routes, adapters,
   registrations, shared guard, server mount, transport matrix, and the C-07
   client as a backend-adjacent frozen artifact) are documented. Confirmed.
9. No known guard symmetry residual remains: the shared guard's contract-id lookup and
   visibility-rank lookup are both own-property hardened
   (`Object.prototype.hasOwnProperty.call`), confirmed symmetric at the freeze evidence
   checkpoint `1c76c1de9dbe402d6d2b75b885b7788369bab82c`. Confirmed.
10. DEV-gate exact-development tightening, real-socket/live-transport evidence, the UI
    card, and screen registration are formally deferred; browser evidence is waived for
    Phase 2.0 only. Confirmed.
11. M47 UI-card planning was selected as the next path unless the owner prioritizes
    DEV-gate or real-socket planning first. Confirmed (this gate executes that path).

---

## Section 7 — C-07 Readiness for UI Card

C-07 is ready for UI card planning. Each readiness item is confirmed:

1. Backend closeout/freeze is accepted and backed up. Confirmed.
2. C-07 backend provider and read model are implemented and green. Confirmed.
3. C-07 route and adapter are implemented and green. Confirmed.
4. C-07 guard entry is implemented and green (C-07 reuses the `overview_viewer`
   read-only floor in the shared, own-property-hardened guard). Confirmed.
5. C-07 server mount is implemented and green. Confirmed.
6. C-07 registration test is implemented and green. Confirmed.
7. C-07 transport-matrix coverage is implemented and green. Confirmed.
8. C-07 frontend client/sanitizer is implemented and green. Confirmed.
9. C-07 authorized 200 path is live and guard-gated (server-side authority only).
   Confirmed.
10. The C-07 client returns a safe view model only (closed enums, bounded counts, safe
    labels; unknown values normalize to the closed member `redacted`). Confirmed.
11. The C-07 client excludes `generatedAt` and every timestamp — there is no timestamp
    field on the success view model and no timestamp helper in the client. Confirmed.
12. The C-07 client blocks raw evidence, diagnostics, stack traces, env values, SQL, DB,
    Supabase, live-provider detail, package/file paths, value-oracle content, and
    production-readiness claims (closed allow-list PRIMARY gate plus a defense-in-depth
    denylist on the two free-text display fields). Confirmed.
13. C-07 remains DEV-only, default-off, production-disabled, and read-only (GET only, no
    body, no credentials, no Authorization header, no query authority). Confirmed.
14. A C-07 UI card can be planned without screen registration. Confirmed.
15. A C-07 UI card can be planned without browser tooling. Confirmed.
16. Browser evidence can remain waived in Phase 2.0 unless explicitly reopened. Confirmed.

C-07 readiness gate: PASS. C-07 is ready for a UI card.

---

## Section 8 — Existing UI Pattern Review

The Backend Control Panel already has cards for C-01 through C-06. C-07 must mirror them.

1. **Card component naming.** `C0<n><Name>ReadinessCard.tsx` with a default export:
   `C01ReadinessCard`, `C02RegistryReadinessCard`, `C03UiCoverageReadinessCard`,
   `C04RouteExposureReadinessCard`, `C05FeatureFlagPostureReadinessCard`,
   `C06QualityGatesEvidenceReadinessCard`. The C-07 candidate name is
   `C07DataSourceBoundaryReadinessCard`.
2. **Card file location.** `src/backend-control-plane/`.
3. **Card test files.** None. No `*.test.tsx` (or any card-level test file) exists in the
   project for any card. The `*.test.ts` files under `src/backend-control-plane/` are
   **client** tests (`bcpC0<n>Client.test.ts`), not card tests.
4. **How cards load data.** Explicit **button click only**. The card holds
   `React.useState` for the result and a loading flag and a `React.useCallback` that
   `await`s the client fetch. There is **no auto-fetch and no `useEffect` fetch** — the
   only side effect is a GET on button click.
5. **Data access shape.** Cards call the accepted client fetch function directly and
   consume the client's discriminated-union result type. They import no backend module,
   no route/adapter/provider/read-model, no guard/server, no DB/Supabase.
6. **State patterns.** Idle (result null, not loading), loading, per-`kind` non-success
   state view (feature_disabled / dev_only / unauthorized / parity_blocked /
   method_not_allowed / error / unavailable / unexpected), success view, and a safe empty
   state rendered honestly (not as an error).
7. **Accessibility patterns.** Native `<button type="button">` with visible focus-ring
   utility classes; `aria-pressed` on toggle controls elsewhere in the shell.
8. **Visual styling.** Tailwind utility classes via the shared `./ui` primitives
   (`Panel`, `DeferToneBadge`, `LockIcon`, `ShieldIcon`, `cx`); bounded badge rows and
   chip grids; no raw object rendering.
9. **Static-scan constraints.** Cards render only bounded labels/enums/counts; they never
   render raw logs, command output, stack traces, file paths, package details, runtime
   diagnostics, secrets/tokens/DB URLs/emails, raw JSON objects, or production-readiness
   claims; they use no `dangerouslySetInnerHTML`.
10. **Card without package change.** Yes. A C-07 card mirroring C-06 needs only `react`,
    the existing `./ui` utilities, and the accepted `./bcpC07Client` — all already
    present. No dependency is required.
11. **Card test without package change.** No. See Section 9. A rendering unit test needs
    a React renderer / DOM environment that is not installed; adding it is a prohibited
    package/lockfile change.
12. **Card unregistered from `screens.tsx`.** Yes. `screens.tsx` imports each card and
    places it in a screen render function; a card that is simply not imported there is not
    registered and not reachable through the shell. C-07 can be authored and left
    unregistered.

No files were modified during this review.

---

## Section 9 — Test Feasibility Finding (Blocker for a Card-Rendering Test)

This finding is the decisive input to the M47 decision.

- The project's `package.json` contains **no React test renderer, no jsdom, no
  happy-dom, no @testing-library, no vitest, and no jest**. The only test-adjacent
  dependency is `@vitejs/plugin-react` (a build plugin, not a test runner).
- The only test-related npm script is `"lint": "tsc --noEmit"`. There is **no `test`
  script**.
- Project tests execute as `npx tsx <file>` node-`assert` harnesses: each test file is a
  self-executing IIFE using `node:assert/strict` that prints `N/N passed` and
  `ALL_TESTS_PASSED` and exits 0/1. These exercise **pure logic** (for C-07: the client's
  `classifyC07Response`, `safeEnum`, `safeCount`, `safeLabel`, and the `fetchImpl`-injected
  fetch). They do not render React and do not touch a DOM.
- The existing cards are React function components that call `React.useState` and
  `React.useCallback`. A React hooks component **cannot be invoked outside a renderer** —
  calling it as a plain function throws an invalid-hook-call error because no dispatcher
  is mounted. Therefore the Section 11 "renders X safely" checks are only satisfiable with
  a real renderer.
- Introducing a renderer (jsdom + testing-library, or react-test-renderer) requires
  adding dependencies and changing `package-lock.json`. Those are **explicitly prohibited**
  in M47 and in the next milestone.

Conclusion: a C-07 card-**rendering** unit test is **not feasible without prohibited
package/tooling changes**. Per the rule "if adding a UI test requires new packages,
browser tooling, or a lockfile change, do not implement the test; select the safer
planning decision and document the blocker," the safer decision is component-only.
This matches the established pattern: C-01 through C-06 have **no** card test files, and
card safety is carried by the frozen client sanitizer's own suite plus a typecheck.

To be precise about what is infeasible versus what is chosen: a full card-**rendering**
test is genuinely **infeasible** (the hard blocker above). A narrow **pure-logic** test —
covering any non-hook helper the card might expose (analogous to the C-06 card's static
state-note map and tone helper) — would be feasible under the existing `tsx`/`node:assert`
harness with **no** new package. M48 nonetheless **declines** to add such a test file, by
choice not by inability, in order to (a) preserve the single-file M48 scope this gate
locks and (b) mirror the frozen C-01…C-06 zero-card-test posture. If the owner later wants
a pure-logic helper test, it can be added in a separate milestone without any package
change.

---

## Section 10 — UI Card Implementation Options

- **Option A — Card component + unit tests, no screen registration.** BLOCKED as
  written: a rendering unit test requires a prohibited package/lockfile change (Section 9).
  Not selected.
- **Option B — Card component only, no test file.** SELECTED. Mirrors the frozen
  C-01…C-06 pattern (no card test). Card safety rides on the frozen client sanitizer
  (67/67) plus a typecheck; the card imports only the accepted client and safe UI
  utilities and renders only bounded labels/enums/counts. Risk: medium-low.
- **Option C — Card + `screens.tsx` registration.** Not recommended as the next step;
  `screens.tsx` is a gated surface and registration is separately planned.
- **Option D — Screen-registration planning gate first.** Not required; the existing
  architecture supports authoring an unregistered card before registration is planned.
- **Option E — Another docs-only UI planning pass.** Not required; the card and test
  posture can be locked now (this gate locks them).

---

## Section 11 — UI Card Contract Lock

The next milestone's C-07 card candidate is
`src/backend-control-plane/C07DataSourceBoundaryReadinessCard.tsx`. It must satisfy the
following normative contract.

1. Read-only card. No mutation, action, approval, or override controls.
2. Backend Control Panel internal only; not customer-facing.
3. The only side effect is a GET fetch on explicit button click. No auto-fetch, no
   `useEffect` fetch, no mount-load.
4. Imports **only** the accepted client `./bcpC07Client`
   (`fetchC07DataSourceBoundaryReadiness`, type `C07Result`) plus the existing safe UI
   utilities from `./ui` (`Panel`, `DeferToneBadge`, `LockIcon`, `ShieldIcon`, `cx`) and
   `react`. No backend import. No route/adapter/provider/read-model import. No
   guard/server import. No DB/Supabase import.
5. Renders **only** the fixed fields of the accepted C-07 success view model and the
   discriminated non-success `kind`s. It invents no field the client does not emit.
6. Renders only safe bounded summary counts, safe boundary/item labels, safe closed-enum
   posture values, and safe warnings.
7. Does not render `generatedAt` or any timestamp (the client already excludes them; the
   card surfaces none). This is the **one required divergence** from the C-06 mirror: the
   C-06 card renders a `generatedAt` chip, but the C-07 success view model has no such
   field and M48 must **not** re-add one.
8. Does not render raw JSON, raw response objects, raw error text, raw fetch errors,
   diagnostics, command output, stack traces, DB/Supabase/live-provider detail, env
   values, tokens, secrets, credentials, package/file-path inventories, value-oracle
   content, the client API base / fetch URL / internal route path / `VITE_IDENTITY_API_BASE`,
   or production-readiness claims.
9. Handles every state safely: idle, loading, disabled (during load), unavailable,
   error, empty, and success/ready.
10. Renders the safe empty state honestly (wired lens returning a safe empty result),
    not as an error.
11. Displays a clear self-attestation / declared-source disclaimer and states the declared
    `code_config` posture (schema `bcp.c07.data-source-boundary-readiness.v1-code-config`,
    self-attestation `design_time_code_config`) — a declared design-time code/config
    posture, **not** a live verification and **not** a production-readiness claim.
12. Does not expose client-supplied authority and creates no normal SaaS navigation
    exposure.
13. Uses no `dangerouslySetInnerHTML` and renders no arbitrary HTML from any server- or
    client-supplied string.
14. Claims no browser evidence, no real-socket evidence, and no production readiness.
15. Is not registered in `screens.tsx` unless separately authorized.

**Required divergences from the C-06 mirror (M48 must mirror the _pattern_, not copy the
fields).** C-07's success view model is structurally different from C-06's, so a
copy-paste of the C-06 card would not typecheck and could re-introduce an excluded field.
M48 must: (a) omit the `generatedAt` chip entirely (C-07 has no timestamp field); (b) read
`emptyState: boolean` and `emptyStateReason: string` as **flat** fields (C-06 nests them
under `emptyState.{isEmpty,reason}`); and (c) render C-07's own fields — including
`selfAttestation`, `valueOraclePosture`, and the C-07 posture/summary vocabulary — rather
than C-06's. `tsc --noEmit` enforces this: the card cannot reference any field the C-07
client does not emit.

---

## Section 12 — UI Card Test Contract Lock

Because a card-rendering test is not feasible without prohibited package/tooling changes
(Section 9), **the next milestone adds no card test file** and instead relies on the
existing, frozen safety evidence:

1. The frozen C-07 client sanitizer suite (67/67) already proves the card's data source
   is safe: closed-enum gating, bounded counts, `generatedAt`/timestamp exclusion,
   redaction of unknown/unsafe values, GET-only network shape, and no authority leakage.
2. The card renders only what that sanitized view model contains, so no additional
   behavioral surface is introduced that the client suite does not already cover.
3. **Exposure is closed by three structural facts, not by a card test.** (a) React
   auto-escapes all text children, so a rendered label cannot become active markup;
   (b) the card uses no `dangerouslySetInnerHTML` and renders no raw object; and (c)
   `tsc --noEmit` forbids referencing any field the C-07 client does not emit (including
   `generatedAt`). A card-rendering test would only catch **functional** render
   regressions (an unhandled state, a crash) — booked as an accepted non-exposure residual
   in Section 29 — not a data leak.
4. `tsc --noEmit` must show 0 errors in the new card file and 0 errors in the C-07 client
   and in the frozen backend BCP surfaces (baseline 12 unrelated errors unchanged).
5. A static scan of the new card file must confirm the prohibitions in Sections 11 and 16.

If, in a later separately-authorized milestone, the owner elects to add a real React test
renderer, a card-rendering test package can be planned then; it is out of scope for M48
and must not introduce package/lockfile changes without explicit approval.

---

## Section 13 — Screen Registration Decision

Do **not** register the C-07 UI card in `screens.tsx` in the next milestone.
`screens.tsx` remains a gated surface. Screen registration is considered only after:

1. the C-07 UI card is implemented and accepted;
2. the browser-evidence posture is reopened or explicitly deferred with owner approval;
3. a screen-registration milestone is separately planned (whether to import and place the
   card, whether to add a screen-level check, whether normal SaaS navigation stays
   isolated, and whether customer-facing exposure stays blocked); and
4. no raw exposure or unsafe UI state exists.

Note on what "registration" entails: in `screens.tsx` a card is not merely imported and
placed — it is gated behind a screen `section` key (e.g. `section === 'c06'`). A future
C-07 registration milestone must therefore also add a `c07` section/nav key for the card
to be reachable; a bare import+placement without that key still leaves it unreachable.

---

## Section 14 — Browser Evidence Decision

Browser evidence **remains waived** for the next milestone (M48) because M48 is a single
card component with no screen registration and no browser tooling. Browser evidence must
reopen before: screen registration (if the owner requires it), production readiness,
Phase 3, Phase 4, any customer-facing release, or any milestone that claims real browser
behavior. No browser tooling and no package change for browser evidence may be introduced
in M48 unless separately authorized.

---

## Section 15 — Next Implementation File Package Lock

If Decision B is accepted, the next milestone (M48) is confined to exactly one new file:

- `src/backend-control-plane/C07DataSourceBoundaryReadinessCard.tsx`

No test file, no `screens.tsx` change, no other file.

---

## Section 16 — Static Scan / Typecheck Requirements for M48

M48 static scans must confirm the card introduces none of:

- package/lockfile change, dependency install, browser tooling;
- backend runtime change, server startup change, sockets/listeners/ports;
- outbound network outside the existing client abstraction;
- absolute/production URL, Authorization header, credentials include/same-origin,
  request body, query authority;
- rendering of the client API base / fetch URL / internal route path / `VITE_IDENTITY_API_BASE`;
- localStorage/sessionStorage/window/env authority; client-supplied
  tenant/store/customer/user/role/capability authority;
- backend imports, DB/Supabase access, SQL, Supabase MCP, live-provider calls;
- production/customer-facing exposure or normal SaaS navigation exposure;
- mutation/action behavior, approval/override controls;
- raw JSON/logs/command output/transport output/response dumps/header dumps;
- stack-trace, raw-error, runtime-diagnostic, package/dependency/version, file-path,
  process/PID/port/timing, or environment-value exposure;
- value-oracle behavior or production-readiness claims;
- `dangerouslySetInnerHTML`;
- unintended frozen backend/source drift.

Because the project has no linter (the only script is `tsc --noEmit`), the M48 static scan
is a **concrete grep checklist**, not a judgment call — at minimum, assert the new card
file contains none of: `dangerouslySetInnerHTML`, `generatedAt`, `console.`,
`VITE_IDENTITY_API_BASE`, `fetch(`/`XMLHttpRequest`/`WebSocket`, any backend/DB/Supabase or
`server/`/`bcp-pilot` import, any mutation verb (`POST`/`PUT`/`PATCH`/`DELETE`), and any
forbidden-substring marker — and imports only `react`, `./bcpC07Client`, and `./ui`.

Typecheck must confirm: the 12 unrelated baseline errors unchanged; 0 errors in the M48
card file; 0 errors in the C-07 client file; 0 errors in the frozen backend BCP surfaces;
0 errors in the touched `src/backend-control-plane` UI file. Unrelated baseline errors must
not be fixed.

---

## Section 17 — Baseline Reconfirmation

Run at gate open, at the accepted (unchanged) checkpoint. Results are safe summaries only.

- Full BCP corpus: 42/42 files green, 1351/1351 assertions passed, 0 non-green. Matches
  the accepted M46 baseline.
- C-07 client: 67/67. Matches.
- Guard / pilot harness: 35/35. Matches.
- Typecheck: 12 unrelated baseline errors unchanged; 0 BCP-surface errors; 0 errors in
  `src/backend-control-plane`. Matches.
- Static state: no package or lockfile change; no unauthorized UI/screen change exists
  before M47 (working tree shows only `.replit` and the untracked goose tarball).

The individually named C-07 sub-suites (route 39/39, adapter 26/26, registration 18/18,
provider 43/43, read-model 41/41, transport matrix 124/124) and C-01…C-06 are contained
within, and consistent with, the 42/42 corpus run above; they were not regressed because
no source changed at this checkpoint.

---

## Section 18 — Test Results

Corpus 42/42 files green; 1351/1351 assertions passed; 0 non-green. C-07 client 67/67.
Guard/pilot 35/35. All green. Safe summaries only; no raw test output is reproduced.

## Section 19 — Typecheck Result

12 unrelated baseline errors, unchanged. 0 errors on any BCP surface. 0 errors in
`src/backend-control-plane`. No baseline error was fixed. Safe summary only.

## Section 20 — Static Scan Results

- No package or lockfile change.
- No DB/Supabase/live-provider exposure in the C-01…C-07 evidence lenses.
- No production/customer-facing exposure.
- No raw env-value, value-oracle, log-output, diagnostics, package-detail,
  command-output, raw-evidence, file-path, or production-claim surface currently exists in
  the Backend Control Panel C-01…C-07 evidence lenses.
- No unauthorized UI/screen change exists before M47.

Safe summaries only; no raw scan output is reproduced.

---

## Section 21 — Independent Review Results

Independent review verdicts are recorded here honestly. Verdicts that were unavailable are
marked unavailable with the reason; no verdict is invented.

- **Review 1 — Security / exposure / UI-card planning review: APPROVE-WITH-NITS.** Every
  C-07 client claim in Sections 7 and 9 was independently re-verified against the client
  source (closed-enum gating, bounded counts, `generatedAt`/timestamp exclusion,
  GET-only/no-auth/no-query, exact schema and self-attestation constants returned as
  hardcoded values rather than echoed from the body). All 15 exposure classes are blocked.
  Component-only opens no exposure gap. Findings (all Low/Nit, documentation-completeness):
  add value-oracle content and the client URL / route path / `VITE_IDENTITY_API_BASE` to
  the render-prohibition and static-scan lists; name the one required `generatedAt`
  divergence; state the React-auto-escape + typecheck rationale; make the static scan a
  concrete grep checklist. Reconciled into Sections 11.7, 11.8, 12, and 16.
- **Review 2 — UI implementation package / screen-split planning review: APPROVE-WITH-NITS.**
  The card-pattern mirror (Sections 8, 11), screen-registration gating (Section 13), and
  single-file package boundary (Sections 15, 25, 26) were independently re-verified against
  the actual C-06 card, `screens.tsx`, and the C-07 client; no factual inaccuracy found.
  Findings (Low/Info): the "mirror exactly" framing risks a copy-paste that won't typecheck
  (C-07's success model differs — flat empty-state fields, no `generatedAt`, extra posture
  fields); registration also requires a `section`/nav key, not just import+placement; the
  test framing should distinguish infeasible-render-test from declined-pure-logic-test;
  bound the orphan window by naming the registration milestone. Reconciled into the
  Section 11 divergence note, Sections 9, 12, 13, and 29.
- **Review 3 — Cross-model review (Codex, gpt-5.5/high): UNAVAILABLE (timeout).** Codex was
  authenticated this session but timed out on both the full and an ultra-lean single-question
  prompt (a recurring heavy-prompt timeout, not a logout). No Codex verdict is claimed. Per
  the fallback rule, the independent third lens was provided in-context instead.
- **In-context verification (verification-before-completion pass): PASS.** Every
  load-bearing factual claim was re-verified with fresh, this-turn evidence: baseline
  re-run (corpus 42/42 files & 1351/1351 assertions, C-07 client 67/67, guard/pilot 35/35,
  typecheck 12 baseline / 0 BCP-surface), the test-tooling-absence grep, and both
  subagents' independent re-checks of the source files. Decision B is the evidence-driven
  outcome.

Two independent review passes succeeded (Reviews 1 and 2), plus the in-context
verification pass. Every valid finding is addressed in documentation only; no finding
required a source/test/runtime change, and none blocked acceptance.

---

## Section 22 — M47 Decision

**Decision B — C-07 UI CARD COMPONENT-ONLY PLAN LOCKED.**

Selected because: the M46 backend freeze is safe and backed up; the C-07 client/sanitizer
evidence is complete enough for UI card planning; a card-rendering test is not feasible
without prohibited package/tooling changes (Section 9); a single component file is the
safer next step; screen registration can remain deferred; and browser evidence can remain
waived. Decision A is not selected precisely because its unit-test condition ("feasible
without package/tooling changes") is not met.

---

## Section 23 — Next Governed Step Selection

**Candidate 2 — Phase 2.0 M48 — C-07 UI Card Component-Only Implementation.**

Implement the C-07 UI card component only, unregistered from `screens.tsx`, importing only
the accepted C-07 client and the existing safe UI utilities.

---

## Section 24 — Recommended Next Milestone

Phase 2.0 M48 — C-07 UI Card Component-Only Implementation (single card file), unless the
owner prioritizes DEV-gate exact-development tightening planning or real-socket/live
transport evidence planning first.

---

## Section 25 — Allowed Files for Next Milestone (M48)

- `src/backend-control-plane/C07DataSourceBoundaryReadinessCard.tsx` (create).

No other file may be created or modified.

## Section 26 — Prohibited Files for Next Milestone (M48)

Everything else, including but not limited to: any card test file; `screens.tsx`;
`src/App.tsx`; SaaS navigation; any backend runtime/provider/read-model/route/adapter/
registration/guard file; `server/platform-identity/server.ts` and any server mount;
transport matrix; the C-07 client and any other client; `package.json`;
`package-lock.json`; migrations/seeds; `shared/**`; auth/audit-writer/
identity-repository/sessionResolve; any DB/Supabase file; any browser tooling; `.replit`;
`.gitattributes`; the goose tarball.

## Section 27 — Stop Conditions for Next Milestone (M48)

Stop and do not implement if any of the following would be required: a package or lockfile
change; a dependency install; browser tooling; a backend runtime change; a new
socket/listener/port; a backend/DB/Supabase import; a mutation/action/approval/override
control; a raw-evidence/diagnostics/log/command-output/stack-trace/file-path/env-value/
production-claim/value-oracle surface; `dangerouslySetInnerHTML`; screen registration; or
frozen backend/source drift. Any such requirement converts M48 into a blocked or
re-planned milestone.

---

## Section 28 — Non-Readiness Statements

Phase 2.0 remains: not production readiness; not customer-facing release; not Phase 3
controlled actions; not Phase 4 production readiness; not live DB/Supabase reads; not live
provider reads; not Supabase auth enablement; not Firebase-to-Supabase cutover; not
browser-evidence completion for production/customer-facing release.

Firebase remains authoritative. Supabase remains dormant/shadow/readiness-only. The
Backend Control Panel remains DEV-only/read-only in Phase 2.0.

M47 does not implement UI, screen registration, or real-socket evidence, and does not
reopen browser evidence.

---

## Section 29 — Risks / Accepted Residuals

- **No card-rendering test in M48 (accepted).** Mitigated by the frozen client sanitizer
  suite (67/67), the card importing only safe surfaces, and a typecheck + static scan.
  Residual: card-level render regressions are not caught by an automated card test. This
  mirrors the accepted C-01…C-06 posture and can be revisited if a renderer is later
  authorized.
- **Card not visible in the app after M48 (accepted).** The card stays unregistered from
  `screens.tsx`; it becomes reachable only in a later, separately-authorized
  screen-registration milestone. To bound the orphan window, that registration milestone
  (provisionally M49) is named as the explicit closer so the unregistered card does not
  linger indefinitely; until then it is still compiled by `tsc --noEmit` (tsconfig includes
  `src/**`), so type errors are caught even while unimported.
- **Browser evidence remains waived (accepted, Phase 2.0 only).** Must reopen before any
  real-browser-behavior claim, screen registration (if owner requires), or
  production/customer-facing release.
- **DEV-gate exact-development tightening and real-socket/live-transport evidence remain
  formally deferred (accepted).**

---

## Section 30 — Git Status

Working tree shows only:

- `M .replit`
- `?? docs/phase-2.0-backend-control-panel-m47-c07-ui-card-planning-gate.md`
- `?? goose-x86_64-unknown-linux-gnu.tar.bz2`

Nothing is staged. `.gitattributes` is absent.

## Section 31 — No Commit / Push / Backup Confirmation

No commit, push, or backup was performed during M47. This gate stops for owner review.

---

## Section 32 — Acceptance Recommendation

Accept Decision B. The M46 backend freeze is safe and backed up, C-07 is ready for a UI
card, the smallest safe next package is a single component-only card file, and the
card-rendering test is correctly deferred due to a prohibited-package blocker rather than
implemented unsafely.

## Section 33 — Recommended Next Step

If accepted: **Phase 2.0 M47 — Scoped Commit and Backup Authorization** (commit only this
M47 doc, scoped staging, fast-forward non-force push, numbered backup report). After the
M47 backup, proceed to **Phase 2.0 M48 — C-07 UI Card Component-Only Implementation**
(Candidate 2), unless the owner prioritizes DEV-gate or real-socket planning first.

Do not commit, push, or back up from within M47. Stop for owner review.
