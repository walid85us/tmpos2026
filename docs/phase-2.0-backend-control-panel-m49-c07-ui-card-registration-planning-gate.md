# Phase 2.0 — Backend Control Panel — M49 — C-07 UI Card Registration Planning Gate

Status: DOCS-ONLY PLANNING GATE. Proposed, not implemented. No source, test, screen,
package, runtime, or UI change is made by this milestone. This document decides the
smallest safe next package to make the already-built C-07 UI card reachable inside the
Backend Control Panel UI while preserving every frozen backend and exposure boundary.

Accepted pre-change checkpoint: `12b8c56ff6865166222b97e67f0b4283891cb092`
(Phase 2.0 M48 add backend control panel C07 ui card).

Backend freeze governance commit: `2efe9415c610d1d349787a1ba106bf73cbaac2c6`.

Because HEAD == origin/main at gate open, the accepted checkpoint is itself the
pre-change backup for M49.

---

## Section 1 — Executive Summary

M49 is a documentation-only planning gate. It performs no implementation. It confirms the
M48 card is backed up and registration-ready, identifies the exact existing registry
pattern C-07 must mirror, and locks the smallest safe registration package.

The investigation confirms that the C-01 through C-06 cards are all hosted inside a single
already-reachable screen — the Readiness Gate screen (`BackendCpReadinessGate`), which is
the `readiness-gate` module already present in the `MODULES` sidebar. Each card is a
sub-tab (`c01`…`c06`) selected by an **inline `SectionTabs` array defined within
`screens.tsx`**, and dispatched by inline `section === 'cNN'` blocks in the same file. The
module → screen mapping (`ScreenRouter`) already routes this screen.

Therefore making C-07 reachable requires only three additive edits, all inside
`screens.tsx`: (a) import `C07DataSourceBoundaryReadinessCard`; (b) add a `c07` tab entry
to the inline section-tab array; (c) add a `section === 'c07'` dispatch block rendering the
card. No `MODULES`/`mockData.ts`, `types.ts`, `src/App.tsx`, SaaS-navigation, `ScreenRouter`,
card, client, backend, or package change is needed. The card already has a default export
compatible with the default-import registry.

Decision: **Decision A — C-07 UI Card Registration Plan Locked; proceed to a
screens.tsx-only registration implementation milestone (M50).** Browser evidence remains
waived for M50 (screens-only, DEV-only/internal, no browser tooling, no production or
customer-facing claim).

---

## Section 2 — Preflight Result

All preflight checks passed.

1. Branch is `main`. PASS.
2. HEAD and origin/main both equal `12b8c56ff6865166222b97e67f0b4283891cb092`. PASS.
3. Ahead/behind is 0/0. PASS.
4. `git status` shows only `M .replit` and `?? goose-x86_64-unknown-linux-gnu.tar.bz2`.
   PASS.
5. `package.json` is clean. PASS.
6. `package-lock.json` is clean. PASS.
7. Nothing is staged. PASS.
8. `.gitattributes` is absent. PASS.
9. M48 commit is present at HEAD. PASS.
10. HEAD == origin/main, so this is the pre-change backup checkpoint. PASS.
11. No implementation change occurs during M49. PASS.
12. No commit, push, or backup occurs during M49. PASS.

---

## Section 3 — Files Created

- `docs/phase-2.0-backend-control-panel-m49-c07-ui-card-registration-planning-gate.md`
  (this file). No other file created.

## Section 4 — Files Modified

None. M49 is docs-only.

## Section 5 — Files Confirmed Untouched

No source, test, screen, `src/App.tsx`, SaaS-navigation, card, client, route, adapter,
provider, read-model, guard, server-mount, registration-test, transport-matrix, package,
lockfile, migration, `shared/**`, auth/audit/identity/session, DB/Supabase, or
browser-tooling file was created or modified. `.replit` remains unstaged/untouched; the
goose tarball remains untracked; `.gitattributes` remains absent.

---

## Section 6 — M48 Backup Review

1. M48 commit hash: `12b8c56ff6865166222b97e67f0b4283891cb092`. Confirmed.
2. M48 commit subject: `Phase 2.0 M48 add backend control panel C07 ui card`. Confirmed.
3. origin/main matches local HEAD (0/0). Confirmed.
4. The M48 push was fast-forward and non-force. Confirmed.
5. Exactly one M48 file was committed
   (`src/backend-control-plane/C07DataSourceBoundaryReadinessCard.tsx`). Confirmed.
6. No docs file was committed. Confirmed.
7. No test file was committed. Confirmed.
8. No `screens.tsx` file was committed. Confirmed.
9. No `src/App.tsx` or SaaS-navigation file was committed. Confirmed.
10. No C-07 client file was committed. Confirmed.
11. No backend frozen surface was committed. Confirmed.
12. No package or lockfile was committed. Confirmed.
13. No DB/Supabase/browser-tooling was committed. Confirmed.
14. M48 test baseline remained 1351/1351. Confirmed (re-run at gate open).
15. Typecheck remained 12 baseline / 0 BCP-surface. Confirmed.
16. Static scan was clean. Confirmed.
17. The card remains unregistered. Confirmed.

---

## Section 7 — C-07 Card Registration Readiness Review

Inspected the M48 card and the screen registry. All readiness checks pass:

1. The C-07 card component exists
   (`src/backend-control-plane/C07DataSourceBoundaryReadinessCard.tsx`). Confirmed.
2. It has a `default export` (`C07DataSourceBoundaryReadinessCard`), matching the
   default-import shape the registry uses for C-01…C-06. Confirmed.
3. It imports only `react`, `./bcpC07Client`, and `./ui`. Confirmed.
4. It is read-only (button-triggered GET only; no `useEffect`/auto-fetch). Confirmed.
5. It has no mutation/approval/override/write controls. Confirmed.
6. It renders no `generatedAt`, timestamp, raw JSON, raw error, diagnostic, stack trace,
   env value, secret, token, URL/route/`VITE_IDENTITY_API_BASE`, package/file path, or
   production-readiness / browser / real-socket claim. Confirmed.
7. It uses no `dangerouslySetInnerHTML`. Confirmed.
8. It fetches only via the accepted C-07 client (no direct fetch). Confirmed.
9. It remains unregistered before M49. Confirmed.
10. It can be registered **without modifying the card file** (registration is done by the
    hosting screen importing and placing it). Confirmed.
11. It can be registered without modifying the C-07 client. Confirmed.
12. It can be registered without touching backend frozen surfaces. Confirmed.
13. It can be registered without package/lockfile changes. Confirmed.

Registration readiness: PASS.

---

## Section 8 — Screen Registry Pattern Review

Findings from `src/backend-control-plane/screens.tsx`, `Shell.tsx`, and `mockData.ts`:

1. **Registered-card import pattern.** Cards are default-imported at the top of
   `screens.tsx` (`import C0<n>…Card from './C0<n>…Card';`).
2. **Card placement pattern.** Each card is rendered inside a single host screen behind a
   local `section` key: `{section === 'c0<n>' && (<div className="mt-1"><C0<n>…Card /></div>)}`.
3. **Section-key pattern.** The host screen owns a local `section` state (`React.useState`)
   and an **inline `SectionTabs` array** listing `{ key, label }` entries; selecting a tab
   sets the section. This array is defined inline in `screens.tsx` (not in a data file).
4. **Card key/id pattern.** The key is a short string literal (`'c01'`…`'c06'`); the label
   is a short human string (e.g. `'C-06 Quality Gates'`).
5. **Title/description pattern.** The screen has a heading from its module metadata; each
   card renders its own `Panel` title/subtitle. No separate per-card registry descriptor
   file exists.
6. **Ordering pattern.** Tabs render in array order; the contract tabs sit between a
   `readiness` tab and a `coverage` tab.
7. **Gating pattern.** The authoritative boundary is the build-time route gate
   `BCP_ROUTE_ENABLED` (a DEV-only Vite build AND `VITE_ENABLE_BACKEND_CONTROL_PLANE ===
   'true'`; the entire shell is a `React.lazy` route excluded from production builds).
   `AccessGate` is only an in-shell click-through info screen, not a security control. No
   per-card feature flag is represented in the registry (the C-07 flag lives on the DEV
   API, surfaced by the card's own states).
8. **DEV-only posture.** The Backend Control Panel shell is DEV-only/internal; the host
   screen carries read-only/mock/DEV badges.
9. **C-01…C-06 registration shape.** All six live inside the Readiness Gate screen
   (`BackendCpReadinessGate`, the `readiness-gate` module already present in `MODULES` and
   already reachable via `ScreenRouter`), each as a `c0<n>` sub-tab.
10. **C-07 registration requires only:** importing `C07DataSourceBoundaryReadinessCard`,
    adding a `c07` tab entry to the host screen's inline section-tab array, and adding a
    `section === 'c07'` dispatch block. All three are in `screens.tsx`.
11. **No file besides `screens.tsx` is required.** Two independent reasons: (a) the host
    module already exists in `MODULES` and the module → screen route already exists in
    `ScreenRouter`, so no new module — and hence no `mockData.ts`/`Shell.tsx` change — is
    needed; and (b) the section keys are plain string literals local to `screens.tsx` and
    are not part of the `BcpModule` type (`BcpModule.id` is a plain `string`), so `types.ts`
    needs no change either.
12. **No `App.tsx`, SaaS-nav, route config, package, or backend change is required.**
13. **No customer-facing exposure is introduced.** The card is reachable only inside the
    Backend Control Panel shell, which mounts only when the build-time `BCP_ROUTE_ENABLED`
    gate is on (DEV build + explicit Vite flag; production-excluded); `AccessGate` adds an
    in-shell click-through on top of that.
14. **Registration remains inside the Backend Control Panel only.** Confirmed.

`screens.tsx` was not modified during this review.

---

## Section 9 — Registration Implementation Options

- **Option A — M50 screens.tsx-only registration.** SELECTED. Import the card and add a
  `c07` tab + dispatch block to the already-reachable Readiness Gate screen. Card, client,
  backend, `MODULES`, `App.tsx`, SaaS-nav, and package files all unchanged. Risk:
  medium-low.
- **Option B — screens.tsx + one additional frontend metadata file.** Not required; the
  registry needs no separate per-card descriptor file, and the host module already exists.
- **Option C — Card correction before registration.** Not required; the card is
  registration-ready as-is (Section 7).
- **Option D — Another docs-only planning pass.** Not required; the package is lockable now.
- **Option E — Blocked.** Not applicable; registration needs no prohibited change.

---

## Section 10 — Registration Contract Lock (for M50)

If Option A is accepted, the M50 registration is confined to exactly one file and the
following normative contract.

Allowed file: `src/backend-control-plane/screens.tsx` (only).

1. Import `C07DataSourceBoundaryReadinessCard` from `./C07DataSourceBoundaryReadinessCard`
   (default import), alongside the existing C-01…C-06 imports.
2. Add exactly one `SectionTabs` entry to the Readiness Gate screen's inline tab array,
   inserted immediately after the `c06` entry (intentionally placing it between `c06` and
   the `coverage` tab): `{ key: 'c07', label: 'C-07 Data Source Boundary' }`.
3. Add exactly one dispatch block after the `c06` block:
   `{section === 'c07' && (<div className="mt-1"><C07DataSourceBoundaryReadinessCard /></div>)}`.
4. Safe screen/tab title: "C-07 Data Source Boundary Readiness" (card `Panel` title is
   already set by the card; the tab label is the short "C-07 Data Source Boundary").
5. Safe description (for any doc/report use): "Declared code/config data-source boundary
   readiness for the DEV-only Backend Control Panel."
6. Keep the card inside the Backend Control Panel only.
7. Do not add normal SaaS navigation.
8. Do not add customer-facing routes.
9. Do not add `src/App.tsx` route changes.
10. Do not add backend calls beyond the existing card/client behavior.
11. Do not add mutation/action/approval/override controls.
12. Do not add browser tooling.
13. Do not add a card-render test.
14. Do not modify the card component.
15. Do not modify `bcpC07Client.ts`.
16. Do not modify backend frozen surfaces.
17. Do not modify package files.
18. Do not claim production readiness.
19. Do not claim browser evidence unless explicitly reopened and actually performed.
20. Keep browser evidence waived for Phase 2.0 (this gate selects that posture — Section 11).
21. Preserve all existing C-01…C-06 entries unchanged in content; the only change to them
    is positional adjacency from inserting the `c07` entry after `c06`.

---

## Section 11 — Browser Evidence Decision

**Decision A — Browser evidence remains waived for M50.** Registration is screens.tsx-only,
adds no browser tooling, and makes no production/customer-facing claim. The card is
reachable only inside the Backend Control Panel shell, whose authoritative boundary is the
build-time `BCP_ROUTE_ENABLED` route gate (DEV-only Vite build AND
`VITE_ENABLE_BACKEND_CONTROL_PLANE === 'true'`; a `React.lazy` route excluded from
production builds) — `AccessGate` is only an in-shell click-through, not the security
control. M50 acceptance relies on typecheck, a concrete static scan, and the unchanged test
corpus. Because M50 is the card's first-ever render, a single one-time manual DEV smoke of
the registered sub-tab is recommended as an informal render-correctness floor — explicitly
distinct from, and not a substitute for, the deferred formal/production browser evidence.
Formal browser evidence must reopen before production readiness, Phase 3, Phase 4,
customer-facing release, or any milestone that claims real browser behavior. The Phase 2.0
waiver remains explicitly documented.

---

## Section 12 — Test / Typecheck / Static Scan Requirements for M50

Tests: full BCP corpus 1351/1351; test files 42/42 green; C-07 client 67/67; guard/pilot
35/35; all C-07 backend lenses and C-01…C-06 unchanged and green. **No test-count
increase** (no test file is added).

Typecheck: 12 unrelated baseline errors unchanged; 0 errors in `screens.tsx`,
`C07DataSourceBoundaryReadinessCard.tsx`, `bcpC07Client.ts`, and the frozen backend BCP
surfaces.

Static scan (concrete grep checklist over the `screens.tsx` diff): confirm the change adds
none of — package/lockfile change, dependency install, browser tooling, backend import,
DB/Supabase import, direct `fetch(` in `screens.tsx`, absolute/production URL,
Authorization header, credentials include/same-origin, request body, query authority,
localStorage/sessionStorage/window/env authority, client-supplied
tenant/store/customer/user/role/capability authority, production/customer-facing exposure,
normal SaaS-navigation exposure outside the Backend Control Panel, mutation/action
behavior, approval/override controls, raw JSON/error/diagnostics/stack-trace/env/secret/
token/package/file-path exposure, `generatedAt`/timestamp display, `dangerouslySetInnerHTML`,
production-readiness claims, browser/real-socket claims, or frozen backend/source drift.
The only intended additions are: one default-import of the existing card, one `{ key: 'c07',
label: … }` tab entry, and one `section === 'c07'` dispatch block.

Enforcement note: because M47/M48 bar any registration/render test, the registration shape
is guarded only by this manual static-scan checklist plus independent review — there is no
automated assertion of the tab set. M50 must therefore also confirm (concrete check) that no
screen-render or snapshot test has begun enumerating the Readiness Gate tab set or the `c0N`
keys, so that inserting the `c07` tab keeps the "no test-count increase" invariant true.

---

## Section 13 — Stop Conditions for M50

Stop and re-plan if M50 registration requires: touching any file outside `screens.tsx`;
changing the card or the C-07 client; changing any test file; changing `package.json`/
lockfile; adding a dependency or browser tooling; modifying `src/App.tsx` or SaaS
navigation; modifying backend frozen surfaces or the transport matrix; importing
backend/DB/Supabase files; adding a direct `fetch` in `screens.tsx`; adding
mutation/action/approval/override behavior; exposing raw evidence/diagnostics/errors/env
values; rendering `generatedAt`/timestamps; claiming production readiness; claiming browser
evidence without actually performing an authorized browser-evidence step; causing
unexplained test-count drift; introducing BCP-surface typecheck errors or unsafe static
scan findings; an unresolved independent-review blocker; or touching `.replit`,
`.gitattributes`, or the goose tarball.

---

## Section 14 — Next Path After Registration

After a successful M50, the expected next path is **M51 — Registration Closeout / UI
Visibility Gate** (docs-only: verify the card is registered safely, still DEV-only/internal,
and decide whether browser evidence should reopen), unless the owner prioritizes a Browser
Evidence Planning Gate, a DEV-Gate Coordinated Tightening Planning Gate, or a Real-Socket
Evidence Planning Gate first.

---

## Section 15 — Baseline Reconfirmation

Run at gate open, at the accepted (unchanged) checkpoint. Safe summaries only.

- Full BCP corpus: 42/42 files green, 1351/1351 assertions passed, 0 non-green. Matches
  the accepted M48 baseline.
- C-07 client 67/67; guard/pilot 35/35; C-07 route 39/39, adapter 26/26, registration
  18/18, provider 43/43, read-model 41/41, transport matrix 124/124; C-01…C-06 unchanged
  and green — all contained within, and consistent with, the 42/42 corpus run (no source
  changed at this checkpoint).
- Typecheck: 12 unrelated baseline errors unchanged; 0 in `src/backend-control-plane`; 0 in
  frozen BCP surfaces.
- Static state: no package/lockfile change; no DB/Supabase/live-provider exposure; no
  production/customer-facing exposure; no unauthorized screen/`App`/SaaS-navigation change
  exists before M49 (working tree shows only `.replit` and the untracked goose tarball).

---

## Section 16 — Test Results

Corpus 42/42 files green; 1351/1351 assertions passed; 0 non-green. C-07 client 67/67.
Guard/pilot 35/35. All green. Safe summaries only.

## Section 17 — Typecheck Result

12 unrelated baseline errors, unchanged; 0 in `src/backend-control-plane`; 0 on any BCP
surface. No baseline error was fixed. Safe summary only.

## Section 18 — Static Scan Results

No package/lockfile change; no DB/Supabase/live-provider exposure; no production/
customer-facing exposure; no unauthorized screen/`App`/SaaS-navigation change before M49;
no raw env-value, value-oracle, log-output, diagnostics, package-detail, command-output,
raw-evidence, file-path, or production-claim surface in the C-07 card or registration plan.
Safe summaries only.

---

## Section 19 — Independent Review Results

Verdicts are recorded honestly; unavailable reviews are marked with the reason; no verdict
is invented.

- **Review 1 — UI registration exposure review: APPROVE-WITH-NITS.** The full reachability
  chain was independently traced; the locked contract (Section 10) and diff-scoped static
  scan (Section 12) genuinely bar any customer-facing route, SaaS-navigation,
  App/`MODULES`/route change, backend/DB import, direct fetch, mutation/approval/authority
  surface, or raw/diagnostic/timestamp output, and confine the card to the DEV-build-only
  shell. No residual exposure hole found. Findings (all Low/Nit, documentation-precision):
  name the authoritative build-time `BCP_ROUTE_ENABLED` gate rather than `AccessGate`; state
  that registration activates already-reviewed runtime behavior; note a one-time manual DEV
  smoke as an informal render floor; acknowledge manual-grep enforcement; confirm the `c07`
  tab ordering. Reconciled into Sections 8.7, 8.13, 10.2, 11, 12, and 26.
- **Review 2 — Scope / frozen-boundary preservation review: APPROVE-WITH-NITS.** All five
  load-bearing claims were independently verified against the code: the C-01…C-06 host +
  inline `SectionTabs` + inline dispatch; the `readiness-gate` module already in `MODULES`
  and routed by `ScreenRouter`; `BcpModule.id` a plain `string` (no union to reject `'c07'`);
  the card's default export matching the registry; and no hidden nav/route/type file between
  the click and the card — so **screens.tsx-only is genuinely sufficient and Decision B is
  not required.** Findings (Info-level, documentation-clarity): split the two independent
  reasons in Section 8.11; keep an M50 check that no screen-render test enumerates the tab
  set. Reconciled into Sections 8.11 and 12.
- **Review 3 — Cross-model review (Codex, gpt-5.5/high): UNAVAILABLE (timeout).** Codex was
  authenticated this session but timed out on a lean single-question prompt (recurring
  heavy-prompt timeout, not a logout). No Codex verdict is claimed. Per the fallback rule the
  independent third lens was the in-context verification pass below.
- **In-context verification (verification-before-completion pass): PASS.** Every load-bearing
  claim was re-verified with fresh, this-turn evidence: the registry wiring (host screen,
  inline tab array, dispatch blocks, already-routed module) traced directly in `screens.tsx`,
  `mockData.ts`, `Shell.tsx`, and `types.ts`, plus the baseline re-run (corpus 42/42 &
  1351/1351, guard/pilot 35/35, client 67/67, typecheck 12/0, pre-change tree clean).
  Decision A is the evidence-driven outcome.

Two independent review passes succeeded (Reviews 1 and 2), plus the in-context verification
pass. Every valid finding is addressed in documentation only; none required a
source/test/runtime change, and none blocked acceptance.

---

## Section 20 — M49 Decision

**Decision A — C-07 UI CARD REGISTRATION PLAN LOCKED; PROCEED TO SCREENS-ONLY
REGISTRATION.** screens.tsx-only registration is sufficient and confirmed; the card and
client remain unchanged; backend frozen surfaces, `App.tsx`, SaaS navigation, and package
files remain untouched; browser evidence remains waived for Phase 2.0; no blocker exists.

## Section 21 — Next Governed Step Selection

**Candidate 1 — Phase 2.0 M50 — C-07 UI Card Registration Implementation (screens.tsx
only).**

## Section 22 — Recommended Next Milestone

Phase 2.0 M50 — C-07 UI Card Registration Implementation (screens.tsx only), unless the
owner prioritizes browser-evidence, DEV-gate, or real-socket planning first.

## Section 23 — Allowed Files for Next Milestone (M50)

- `src/backend-control-plane/screens.tsx` (modify — additive registration only).

No other file may be created or modified.

## Section 24 — Prohibited Files for Next Milestone (M50)

Everything else, including but not limited to: any test file;
`C07DataSourceBoundaryReadinessCard.tsx`; `bcpC07Client.ts`; `src/App.tsx`; SaaS-navigation
files; `mockData.ts`/`types.ts`/`Shell.tsx` (no new module or `BcpModule` shape change);
any backend frozen surface (`server/bcp-pilot/**`, `server/platform-identity/server.ts`,
routes/adapters/providers/read-models/registration/transport-matrix); `package.json`;
`package-lock.json`; migrations/seeds; `shared/**`; auth/audit/identity/session; DB/Supabase
files; browser tooling; `.replit`; `.gitattributes`; the goose tarball.

---

## Section 25 — Non-Readiness Statements

Phase 2.0 remains: not production readiness; not customer-facing release; not Phase 3
controlled actions; not Phase 4 production readiness; not live DB/Supabase reads; not live
provider reads; not Supabase auth enablement; not Firebase-to-Supabase cutover; not
browser-evidence completion for production/customer-facing release.

Firebase remains authoritative. Supabase remains dormant/shadow/readiness-only. The Backend
Control Panel remains DEV-only/read-only in Phase 2.0.

M49 does not implement screen registration, browser evidence, or real-socket evidence, and
does not reopen production readiness.

---

## Section 26 — Risks / Accepted Residuals

- **Registration inserts a `c07` sub-tab adjacent to `c06` (accepted).** The existing
  C-01…C-06 entries are unchanged in content; only their positional adjacency shifts by one
  inserted entry.
- **Registration activates already-reviewed runtime behavior (accepted).** Making the card
  reachable moves it from never-executed code to code that fires the already-M48-accepted
  dev-proxy GET (via `bcpC07Client`) on button click. This introduces no NEW exposure class —
  the client output is closed-enum-normalized and was accepted in M48 (Section 7) — but it
  does activate that reviewed runtime path; the "no new exposure" claim holds precisely
  because it inherits the M48 card acceptance, not because nothing executes.
- **No card-render test in M50 (accepted, per M47/M48).** Card safety continues to ride on
  the frozen client suite (67/67) + typecheck + static scan + React auto-escaping.
- **Browser evidence remains waived (Phase 2.0 only).** Must reopen before any real-browser
  claim, production readiness, or customer-facing release.
- **DEV-gate exact-development tightening and real-socket/live-transport evidence remain
  formally deferred.**

---

## Section 27 — Git Status

Working tree shows only:

- `M .replit`
- `?? docs/phase-2.0-backend-control-panel-m49-c07-ui-card-registration-planning-gate.md`
- `?? goose-x86_64-unknown-linux-gnu.tar.bz2`

Nothing is staged. `.gitattributes` is absent.

## Section 28 — No Commit / Push / Backup Confirmation

No commit, push, or backup was performed during M49. This gate stops for owner review.

## Section 29 — Acceptance Recommendation

Accept Decision A. The M48 card is backed up and registration-ready; the smallest safe
package is a screens.tsx-only additive registration into the already-reachable Readiness
Gate screen; and browser evidence is correctly kept waived for Phase 2.0.

## Section 30 — Recommended Next Step

If accepted: **Phase 2.0 M49 — Scoped Commit and Backup Authorization** (commit only this
M49 doc, scoped staging, fast-forward non-force push, numbered backup report). After the
M49 backup, proceed to **Phase 2.0 M50 — C-07 UI Card Registration Implementation
(screens.tsx only)**, unless the owner prioritizes browser-evidence, DEV-gate, or
real-socket planning first.

Do not commit, push, or back up from within M49. Stop for owner review.
