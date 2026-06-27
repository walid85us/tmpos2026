# Phase 2.0 — Backend Control Panel: C-02 Provider QA, Baseline Refresh, Combination-Gap Review, and Next Read-Only Lens Selection (M11)

Status: PROPOSED — review and planning only. This is a documentation-only milestone. It changes no
source code, tests, runtime behaviour, routes, UI, backend, frontend, packages, migrations, auth, DB,
Supabase, or configuration. It records the QA outcome for the M10 provider, refreshes the C-02 DEV QA
baseline, closes consolidation-detail gaps with documentation, and selects the next safe read-only lens.

Accepted checkpoint at the start of M11: `0261b2242be78623543e790ccfeb2258eb6a4c91`
Most recent committed milestone: Phase 2.0 M10 — add backend control panel C02 server owned registry provider.

---

## 1. Executive Summary

M10 introduced a safe, server-owned C-02 module registry provider and wired it through the accepted
`getModules` dependency seam, turning the C-02 registry-readiness lens from an empty default into a
populated, code/config-only view of 33 bounded module records. This M11 review re-verified the complete
M10 provider chain and the surrounding C-02 surface against every frozen safety boundary and found no
safety, exposure, authority, DB/Supabase/live, production, action/mutation, test, typecheck, or
sensitive-data blocker. The full accepted suite passes at 228/228, typecheck remains at the 12-error
baseline with 0 errors in the touched trees, static scans are clean, and live transport evidence
confirms the populated DEV-only envelope plus the disabled/blocked paths.

Decision: **Decision A — REFRESH C-02 BASELINE AND SELECT NEXT READ-ONLY LENS.** The C-02 DEV QA
baseline is refreshed to the safe server-owned provider; the combination-gap review found only
non-blocking documentation/evidence residuals; and the next selected lens is **Candidate D — Backend CP
UI Coverage / Screen Readiness Lens**, the safest remaining read-only option because it can remain
code/config-only with no DB/Supabase/live/auth/environment exposure.

---

## 2. Preflight Result

- Branch is `main`.
- HEAD and `origin/main` both equal `0261b2242be78623543e790ccfeb2258eb6a4c91`.
- ahead/behind is `0/0`.
- `git status --porcelain` at preflight (before this document was created) shows only ` M .replit` and
  `?? goose-x86_64-unknown-linux-gnu.tar.bz2`; the single M11 documentation artifact is then created
  within this milestone (see Section 43 for the post-authoring status).
- Nothing is staged.
- `.gitattributes` is absent.
- Phase 2.0 M10 commit `0261b22` is present.
- HEAD equals `origin/main`, so this is the pre-change backup checkpoint; no extra backup created.
- No source, test, backend, frontend, route, UI, package, migration, DB, Supabase, auth, or runtime
  change will occur during M11. No commit, push, or backup will occur during M11.

Preflight passed.

---

## 3. Files Created

- `docs/phase-2.0-backend-control-panel-c02-provider-baseline-refresh-and-next-lens-selection.md`
  (this file) — the single M11 documentation artifact.

## 4. Files Modified

- None. (No source, test, or configuration file is modified by M11.)

## 5. Files Confirmed Untouched

`server/bcp-pilot/bcpC02RegistryProvider.ts`, `server/bcp-pilot/bcpC02RegistryProvider.test.ts`,
`server/bcp-pilot/bcpC02RegistryReadModel.ts`, `server/bcp-pilot/bcpC02ReadOnlyRoute.ts`,
`server/bcp-pilot/bcpC02ReadOnlyExpressAdapter.ts`, `server/bcp-pilot/bcpC02RouteRegistration.test.ts`,
`server/platform-identity/server.ts`, all C-01 files, all `src/backend-control-plane/**` files
(`bcpC02Client.ts`, `C02RegistryReadinessCard.tsx`, `screens.tsx`, etc.), `src/App.tsx`, the main SaaS
navigation, package files, migrations, seeds, `shared/**`, and all auth/M20/audit-writer/
identity-repository/sessionResolve files. `.replit` remains unstaged and untouched; the goose tarball
remains untracked; `.gitattributes` remains absent.

---

## 6. Review Decision

**Decision A — REFRESH C-02 BASELINE AND SELECT NEXT READ-ONLY LENS.**

Sub-decisions:
- Section B (baseline refresh): **Decision A — REFRESH C-02 DEV QA BASELINE WITH SAFE SERVER-OWNED PROVIDER.**
- Section C (combination-gap): non-blocking residuals only; closed by this documentation.
- Section D (next lens): **Candidate D — Backend CP UI Coverage / Screen Readiness Lens.**

---

## 7. Current Baseline Summary

The Backend Control Plane C-02 registry-readiness lens is a DEV-only, default-off, production-disabled,
read-only, code/config-only readiness view on the isolated platform-identity API. As of M10 it is sourced
by a safe server-owned provider rather than an empty default. The lens performs no DB/SQL/Supabase/
Supabase-MCP/live-provider access, no backend action, no mutation, and has no customer-facing or
production exposure, no live session authorization, no Supabase auth, and no Firebase-to-Supabase
cutover. Firebase remains authoritative; Supabase remains dormant/shadow/readiness-only.

---

## 8. M10 Provider QA Review

Reviewed: `bcpC02RegistryProvider.ts`, `bcpC02RegistryProvider.test.ts`, `server/platform-identity/server.ts`,
`bcpC02RouteRegistration.test.ts`. Confirmations (Section A items 1–36):

1. Server-owned — yes (constant authored in the server tree).
2. Code/config-only — yes.
3. Returns only `id`/`name`/`status` — yes (verified by test and by key-set assertion).
4. Returns exactly 33 modules — yes (actual count 33).
5. Values are bounded safe labels — yes (all survive the read model `safeLabel` allow-list).
6. Status values from accepted vocabulary (`included`/`placeholder`/`deferred`/`blocked`) — yes.
7–12. No DB / SQL / Supabase / Supabase MCP / live provider / network or fetch access — confirmed by
   source and static scan (sole import is a type-only status union, erased at runtime).
13. No `process.env` dependency — confirmed.
14. No request dependency — confirmed (getter arity is 0; nothing from `req` is read).
15. No auth dependency — confirmed.
16. No tenant/store/customer dependency — confirmed.
17. No backend action — confirmed.
18. No mutation capability — confirmed.
19. Does not import frontend `mockData` — confirmed.
20. Does not import frontend `src` files — confirmed.
21. Does not import sensitive row types — confirmed.
22. Emits no raw IDs — confirmed (no UUID/16-alnum/4-digit shapes).
23. Emits no secrets/tokens/DB URLs/emails/domains — confirmed.
24. Emits no tenant/store/customer data — confirmed.
25. Emits no `identity_link`/`audit_event`/`platform_identity` rows — confirmed.
26. Output passes the accepted C-02 read model — yes (no item redacted, no `unknown` status).
27. Output creates a non-empty v1 envelope — yes (33 items).
28. `summaryCounts` reflect provider output — yes (`33/20/9/3/1/0`).
29. `emptyState` is now non-empty safely — yes (`isEmpty:false`, `reason:none`).
30. No DTO schema bump — confirmed (`bcp.c02.registry-readiness.v1-code-config`).
31. No new DTO fields — confirmed.
32. No raw provider dump — confirmed.
33. No raw internal registry object exposed — confirmed.
34. No route internals exposed — confirmed.
35. Defensive-copy behaviour tested and accepted — yes (fresh array + fresh objects per call).
36. Immutability/deep-freeze behaviour tested and accepted — yes (exported constant and its entries are
    `Object.freeze`d; mutation of a returned value does not affect future results).

QA result: PASS, no findings requiring change.

## 9. M10 Server Wiring Review

`server/platform-identity/server.ts` was modified minimally: it imports `getBcpC02RegistryModules` and
changed the single C-02 registration to `createBcpC02RegistryReadinessHandler({ getModules: getBcpC02RegistryModules })`.
The route remains registered exactly once, on the isolated platform-identity API only, at
`/dev/bcp/registry-readiness`, via `app.all`. No new route, method, or behaviour expansion. The adapter
resolves the provider only after the DEV and feature-flag gates pass (gates-first); nothing from the
request (query/body/headers/cookies/params) is mapped into `principal`/`modules`/`mode`. Authority
remains server-sourced only.

## 10. C-02 Baseline Refresh Decision

**Decision A — REFRESH C-02 DEV QA BASELINE WITH SAFE SERVER-OWNED PROVIDER.** All M10 evidence remains
safe; the only behavioural change is that the registry is populated from server-owned code/config rather
than empty. No safety property weakened.

## 11. C-02 Refreshed Baseline Summary

| Property | After M8G (old) | After M10 (refreshed) |
|---|---|---|
| Registry source | safe empty default | safe server-owned provider |
| `registryItems` | empty | 33 |
| `summaryCounts` | all zero | total 33 / included 20 / placeholder 9 / deferred 3 / blocked 1 / unknown 0 |
| `emptyState` | `isEmpty:true`, `reason:no_modules` | `isEmpty:false`, `reason:none` |
| `schemaVersion` | `bcp.c02.registry-readiness.v1-code-config` | unchanged |
| `sourceMode` | `code_config` | unchanged |
| `freshness` | `code-config-no-live-read` | unchanged |
| `warnings` | `['code_config']` | unchanged |
| route / client / UI / backend behaviour | unchanged | unchanged |
| DEV-only / default-off / production-disabled / read-only | yes | yes |

No production readiness; no Phase 3 action authorization; no Phase 4 production authorization.

## 12. Authority / Request Non-Authority Review

Authority is server-sourced only. The provider takes no arguments and reads no request/env/global state.
Live hostile-request evidence (Section 14, scenario 7) confirms injected query/header/cookie values
neither influence output nor appear in the response.

## 13. Feature Flag / DEV / Production-Disabled Review

The lens is gated by `ENABLE_BCP_DEV_C02_REGISTRY_READINESS` (default off) and a DEV gate derived from
`NODE_ENV`. DEV + flag on returns the populated envelope; DEV + flag off returns `feature_disabled`;
production + flag on returns `dev_only`. The provider is resolved only after these gates pass.

## 14. Transport Verification Evidence (RUN — live, DB-free isolated API)

| # | Scenario | Result |
|---|---|---|
| 1 | DEV + flag OFF — GET | 404 `{"status":"unavailable","reason":"feature_disabled"}` |
| 2 | DEV + flag ON — GET | 200; `schemaVersion=bcp.c02.registry-readiness.v1-code-config`; `sourceMode=code_config`; `freshness=code-config-no-live-read`; `registryItems=33`; `summaryCounts={33,20,9,3,1,0}`; `emptyState={isEmpty:false,reason:none}`; no sensitive data |
| 3 | HEAD (enabled) | 200, bodyless |
| 4 | OPTIONS | 204 |
| 5 | POST/PUT/PATCH/DELETE | 405 each, no side effects |
| 6 | production + flag ON — GET | 404 `{"status":"unavailable","reason":"dev_only"}` |
| 7 | Hostile request | injected `tenant_id`/`Authorization: Bearer <synthetic-injected-token>`/hostile cookie/`schemaVersion=evil` absent from response; `summaryCounts` unchanged |

All scenarios passed. Method: the isolated platform-identity API was booted DB-free on disposable ports
with `NODE_ENV`/flag combinations; processes were terminated by captured PID plus port reclaim.

## 15. Frontend / UI / Route Exposure Review

No frontend or UI file changed in M10 or M11. The DEV proxy path remains `/__identity/dev/bcp/registry-readiness`
and the Backend CP DEV shell remains `/dev/backend-control-plane`. No new route, no customer-facing
surface, no SaaS-navigation exposure. No `src/**` file imports the server provider (denylist guard in the
registration test enforces this). UI browser-driven evidence remains NOT RUN for the C-02 chain (static
review plus live transport were used instead); see Section 24 — accepted non-blocking residual.

## 16. Safe Label / Redaction Review

All 33 module `id`/`name` values are bounded safe labels that pass the frozen read model `safeLabel`
allow-list (charset guard, forbidden-substring denylist, and UUID/16-alnum/4-digit/domain/file-extension
shape guards). Representative safe labels include `access-gate` / "Separate Access Gate",
`config-posture` / "Configuration Posture" (re-expressed to avoid the `secret`-shaped substring), and
`risks-alerts-lens` / "Risk and Alerts Lens" (keyed to avoid the `sk-` secret-key prefix). No item is
redacted; no status normalizes to `unknown`. Serialized provider and envelope output contain no sensitive
shapes.

## 17. No DB / SQL / Supabase / Live Provider Review

No `createClient`, no `@supabase`, no `getDb` in the C-02 provider path, no `process.env.DATABASE`, no
Supabase executable access, no DB connection strings, and no `identity_link`/`audit_event`/
`platform_identity` access through C-02. No live tenant/store/customer reads. Confirmed by source review
and static scans of the provider executable code (comment lines that name these tokens to negate them
are excluded).

## 18. No Backend Action / Mutation Review

The lens is read-only. No backend action and no mutation success path exist. Mutation HTTP methods return
405 with no side effects.

## 19. No Production / SaaS Nav / Customer-Facing Exposure Review

No production endpoint, no customer-facing exposure, and no normal SaaS-navigation exposure. The lens is
confined to the isolated DEV-only API and the DEV-only Backend CP shell.

## 20. No Real Data / Sensitive Data Review

No raw IDs, `internal_user_id`, provider UIDs, auth claims, `identity_link`/`audit_event` rows,
permission/entitlement key lists, secrets, tokens, DB URLs, emails, domains, payment identifiers, or
tenant/store/customer rows appear in the provider, the envelope, or this document.

---

## 21. Combination-Gap Review — M8G

M8G (C-02 QA / Exposure Review and Baseline Freeze) included: QA review; exposure review; runtime
transport evidence; frontend proxy/static review; UI static review status; authority/non-authority
review; safe-label/redaction review; tests; static scans; typecheck; accepted residuals; the freeze
decision; no commit/push during review; and a scoped backup after acceptance. Residual carried forward:
UI browser-driven evidence was NOT RUN (static review used). Classification: evidence gap, non-blocking.

## 22. Combination-Gap Review — M9

M9 (Planning Gate for the Next Read-Only Lens) included: candidate selection; source inventory; candidate
risk classification; safety contract; selected-candidate output contract; allowed files; prohibited
files; stop conditions; non-readiness statements; no source/test/runtime change; and a scoped backup
after acceptance. No missing item.

## 23. Combination-Gap Review — M10

M10 (Safe Server-Owned Module Registry Provider) included: provider implementation; provider tests;
minimal server wiring; authority/non-authority review; feature-flag/DEV/production-disabled review;
transport verification; static scans; typecheck; C-02 regressions; C-01 regressions; independent review;
and an exact scoped commit and backup. Two residuals: (a) the registration test was a fourth file beyond
the originally listed three — a legitimate, owner-approved blocker fix to prove the `getModules` wiring;
closed. (b) The independent review was completed via in-context fallback because the preferred cross-model
reviewer was unavailable (authentication lapse) and background specialist passes did not survive process
restarts; at least one successful independent pass was completed. Classification: process/evidence notes,
non-blocking.

## 24. Combination-Gap Findings and Corrections

| Finding | Classification | Recommended action |
|---|---|---|
| UI browser-driven evidence NOT RUN across the C-02 chain (static + transport used) | evidence gap | Make UI browser evidence a REQUIRED M12 deliverable (M12 is the UI-bearing Candidate D lens), retiring the residual rather than carrying it a third time |
| Independent review used in-context fallback in M10 (cross-model auth lapse; background passes not durable) | process gap | M11 obtained two successful independent specialist subagent passes (security/exposure + governance/planning); gate M12 acceptance on at least one successful independent (cross-model or subagent) pass, time-boxed, so the fallback is not carried indefinitely |
| M10 registration test as a fourth file | documentation gap (already resolved) | Closed — owner-approved blocker fix |

No safety-critical gap was found. No source/test/code correction is required, and none was made during M11.
The recurring independent-review-fallback item is the one place the milestone's own cross-model-plus-subagent
standard had not been fully met across M10; it is classified MEDIUM (non-blocking, because the surface is
read-only, code/config-only, DB-free, and transport/unit-verified) and is addressed by the M12 acceptance
gate above.

---

## 25. Tests Run

Command pattern: `npx tsx <test-file>` for each suite (self-contained `node:assert/strict` scripts).

## 26. Test Results

| Suite | Result |
|---|---|
| M10 provider (`bcpC02RegistryProvider.test.ts`) | 25/25 |
| C-02 read model (`bcpC02RegistryReadModel.test.ts`) | 33/33 |
| C-02 route (`bcpC02ReadOnlyRoute.test.ts`) | 25/25 |
| C-02 adapter (`bcpC02ReadOnlyExpressAdapter.test.ts`) | 14/14 |
| C-02 registration (`bcpC02RouteRegistration.test.ts`) | 9/9 |
| C-02 client (`bcpC02Client.test.ts`) | 16/16 |
| C-01 read model (`bcpC01CodeConfigReadModel.test.ts`) | 15/15 |
| C-01 pilot (`bcpPilot.test.ts`) | 33/33 |
| C-01 route (`bcpReadOnlyRoute.test.ts`) | 28/28 |
| C-01 adapter (`bcpReadOnlyExpressAdapter.test.ts`) | 10/10 |
| C-01 client (`bcpC01Client.test.ts`) | 20/20 |
| **Total** | **228/228** |

## 27. Static Scan Results

Provider executable code is clean of `createClient`/`@supabase`/`getDb`/`process.env`/`DATABASE`/
`fetch(`/`require(`/`identity_link`/`audit_event`/`platform_identity`/sensitive-row-types/`mockData`/
`/src/`/route-registration/`listen(`. No `src/**` file imports the provider. The C-02 client/card/screen
files contain no forbidden runtime usage (matches found were a benign function parameter named `body`,
documentation comments, and a UI label string "Identity / Authorization Readiness"). Exactly one C-02
handler registration exists across `server/**`, in `server/platform-identity/server.ts`. Accepted paths
remain `/dev/bcp/registry-readiness`, `/__identity/dev/bcp/registry-readiness`, `/dev/backend-control-plane`.

## 28. Typecheck Result

`npx tsc --noEmit` reports 12 errors, equal to the pre-existing baseline. 0 errors in `server/bcp-pilot/**`;
0 errors in `src/backend-control-plane/**` (C-02 files); C-01 files unaffected. No unrelated baseline
error was fixed.

## 29. Independent Review Results

Two independent specialist review passes completed successfully on this milestone: a security/exposure
pass (confirming this document and the reviewed surface expose no sensitive data and introduce no
boundary crossing) and a governance/planning-consistency pass (confirming the document's load-bearing
claims match the code — 33 modules of `{id,name,status}`, distribution `33/20/9/3/1/0`, the v1 envelope
contract, and the single `getModules` registration — and that the next-lens packaging is internally
consistent and complete). The security pass returned CLEAN with two LOW cosmetic items; the governance
pass returned SOLID with one MEDIUM and three LOW items. All valid findings were reconciled into this
document (documentation-only): the hostile-request placeholder was changed to an unmistakably synthetic
token (Section 14); UI browser evidence is now a REQUIRED M12 deliverable (Sections 24, 37 item 15, 42);
M12 acceptance is gated on a successful independent pass to retire the recurring-fallback risk (Sections
24, 42); the preflight-versus-final git-status note was added (Section 2); and the next-step label was
disambiguated (Section 46). No finding required any source/test/runtime change. The preferred cross-model
reviewer remained unavailable this session (authentication lapse); the two specialist subagent passes
satisfied the independent-review requirement.

---

## 30. Next Lens Candidate Evaluation

| Candidate | Purpose | Risk | Key boundary | Verdict |
|---|---|---|---|---|
| B — Feature Flag / Environment Posture | safe bounded flag/env posture labels | Medium (env can hold secrets) | never expose raw env values/keys/URLs/tokens/secrets/domains/credentials/DB strings | Viable but higher exposure surface; defer |
| C — Route Inventory / Route Exposure Posture | safe bounded route exposure categories | Medium (route internals can leak) | only bounded route categories + accepted safe DEV labels; no broad customer-facing enumeration | Viable but internals-sensitive; defer |
| D — Backend CP UI Coverage / Screen Readiness | safe bounded screen/tab/placeholder/preview readiness | Low–Medium (safe if code/config-only) | no raw screen internals, no tenant/store/customer data, no permission-key leakage, no production/customer-facing exposure | **Selected — safest new lens** |
| E — Audit / Security Posture | audit/security status | High | no `audit_event`/`identity_link` rows, no live DB, no actor IDs, no sensitive metadata | Reject for now (high risk) |
| F — Identity / Session Posture | identity/session readiness | High | no live auth claims, no provider UIDs, no `internal_user_id`, no email authority, no auth cutover | Reject for now (high risk) |

## 31. Selected Next Lens

**Candidate D — Backend CP UI Coverage / Screen Readiness Lens** (working designation: the "C-03"
read-only lens).

## 32. Selection Rationale

Candidate D is the safest remaining option because it can be sourced entirely from server-owned
code/config (a conceptual mirror of the Backend CP screen/tab inventory, re-expressed as safe bounded
labels — exactly the proven M10 pattern) and requires no DB, Supabase, live provider, environment, or
auth access. Its risk is the lowest of the viable candidates; B and C carry inherently higher exposure
(secrets in environment data; route internals) and are deferred; E and F are High risk and rejected for
now. Candidate D also exercises the same hardened read-model/route/adapter/client safety chain already
proven by C-01 and C-02, so it adds capability without expanding the threat surface.

## 33. Selected Next Lens Safety Contract

The C-03 lens must be: DEV-only; default-off (behind a new dedicated default-off flag); production-disabled;
read-only; code/config-only; server-sourced authority only; no DB/SQL/Supabase/Supabase-MCP/live provider;
no network/fetch; no `process.env` data dependency; no request dependency; no auth dependency; no
tenant/store/customer dependency; no mutation; no backend action; no customer-facing or production
exposure; no normal SaaS-navigation exposure; no live session authorization; no Supabase auth; and no
Firebase-to-Supabase cutover. Output must be safe bounded labels/enums/booleans/counts only.

## 34. Selected Next Lens Source Inventory

Read-only code/config inspection only (no runtime import of frontend modules into server code):
- Backend CP screen/tab definitions in `src/backend-control-plane/screens.tsx` and `Shell.tsx`
  (conceptual screen/tab list, preview/placeholder status) — inspected for concept only.
- Backend CP module/readiness metadata in `src/backend-control-plane/mockData.ts` and `types.ts`
  (status vocabulary, coverage concepts) — inspected for concept only.
The server-owned C-03 provider must re-express these as safe bounded labels in a new server file; it must
not import `mockData`, any frontend `src` file, or any sensitive row type at runtime.

## 35. Selected Next Lens DTO / Output Contract

A new minimal DTO, distinct from the C-02 schema (no reuse-by-mutation of the C-02 envelope). Suggested
shape: a versioned envelope (for example `bcp.c03.ui-coverage.v1-code-config`) with `sourceMode:
code_config`, a `code-config-no-live-read` freshness label, bounded `summaryCounts`, a `screenItems[]`
array of safe `{ id, name, status }`-style records (screen id, safe screen label, readiness/preview
status enum), and a safe `emptyState`. No raw screen internals, no raw component identifiers, no file
paths, no route internals, no new DTO fields beyond the contract, and no raw object dump.

## 36. Selected Next Lens Exposure Boundaries

No raw screen internals; no tenant/store/customer data; no permission/entitlement key leakage; no
identity/audit data; no secrets/tokens/URLs/emails/domains/file-paths; no production or customer-facing
exposure; no new customer-facing route; no SaaS-navigation entry. The lens must live only on the isolated
platform-identity API (if a route is added) and the DEV-only Backend CP shell (if a UI preview is added).

---

## 37. Recommended Consolidated Next Milestone

**Phase 2.0 M12 — C-03 Backend CP UI Coverage / Screen Readiness Lens (consolidated, read-only).**

Even though milestones are consolidated, full detail is preserved. The recommended package:

1. **Milestone name:** Phase 2.0 M12 — C-03 Backend CP UI Coverage / Screen Readiness Lens.
2. **Purpose:** add a safe, server-owned, read-only DEV lens reporting bounded Backend CP screen/tab
   readiness (implemented/placeholder/preview/deferred) without exposing any sensitive data.
3. **Allowed files:** a new server-owned read model + DTO; its tests; an inert route handler; a thin
   Express adapter; an isolated registration in `server/platform-identity/server.ts` (minimal); a
   server-owned screen provider + its tests; optionally a DEV-only frontend client + a read-only preview
   card + a tab wiring in the Backend CP shell — to be itemized exactly in the M12 prompt and accepted
   file-by-file. (M12 may be split into sub-milestones mirroring the C-02 chain if preferred.)
4. **Prohibited files:** `src/App.tsx`; main SaaS navigation; package files; migrations; seeds;
   `shared/**`; auth/M20/audit-writer/identity-repository/sessionResolve; any DB/Supabase file; any
   customer-facing/production route or config; `src/backend-control-plane/mockData.ts` as a runtime
   import; the frozen C-01 and C-02 implementation files (except an additive, separately-accepted shell
   tab wiring if a UI preview is included).
5. **Source contract:** server-owned code/config constants only; conceptual mirror of the Backend CP
   screen inventory; no runtime import of frontend modules or sensitive row types.
6. **Provider/read model contract:** pure, deterministic, no-throw, no-I/O, no DB/Supabase/live/network/
   `process.env`/request/auth; emits only safe bounded labels/enums/booleans/counts; defensive copy;
   frozen constant.
7. **DTO/output contract:** new versioned `bcp.c03.ui-coverage.v1-code-config` envelope; `code_config`
   source mode; `code-config-no-live-read` freshness; bounded counts; safe `screenItems[]`; safe
   `emptyState`; no schema reuse-by-mutation; no raw dumps.
8. **Route contract (if applicable):** a new DEV-only path (for example `/dev/bcp/ui-coverage`) on the
   isolated platform-identity API only; gate order DEV → feature flag → method handling → success;
   whole-body try/catch to a safe error.
9. **Registration contract (if applicable):** single `app.all` registration on the isolated API only;
   server-sourced dependencies through an accepted seam; no request data mapped into authority/content.
10. **Client/UI contract (if applicable):** GET-only client, `credentials:'omit'`, accept-JSON, no
    Authorization/body/query; defense-in-depth `safeLabel`; button-triggered read-only preview card; no
    `dangerouslySetInnerHTML`; no destructive controls; DEV-only shell tab.
11. **Authority/non-authority contract:** authority server-sourced only; nothing from the request
    influences output.
12. **Tests required:** provider/read-model tests; route tests; adapter tests; registration tests; client
    tests (if a client is added); plus C-01/C-02 regressions; expected new total documented.
13. **Static scans required:** the same forbidden-usage scan set applied in M10/M11.
14. **Typecheck requirements:** baseline unchanged; 0 errors in touched files; `server/bcp-pilot/**` and
    C-03 frontend files clean.
15. **Transport/UI evidence requirements:** the seven C-02-style transport scenarios for any new route;
    and, because Candidate D is a UI-bearing lens, UI browser-driven evidence is REQUIRED (not optional)
    if a preview card / shell tab is included — this retires the UI-evidence residual carried since M8G
    rather than perpetuating it.
16. **Independent review requirements:** at least two independent passes (security/exposure +
    implementation/regression) with successful completion; fall back to another tool if one is unavailable.
17. **Stop conditions:** stop and report a blocker if any source cannot be safely re-expressed without
    importing frontend `mockData`/sensitive rows, if any DB/Supabase/live/auth access appears necessary,
    or if any sensitive-data or production/customer-facing exposure would result.
18. **Final report requirements:** the standard numbered milestone report with explicit safety
    confirmations and honest NOT-RUN marking.
19. **Commit/backup rules:** scoped staging of only the accepted files; fast-forward non-force push;
    commit message ending with the required co-author trailer; backup report; stop for owner review.

## 38. Allowed Files for Next Milestone

As enumerated in Section 37 item 3; the exact accepted file list is to be fixed in the M12 prompt and
staged file-by-file.

## 39. Prohibited Files for Next Milestone

As enumerated in Section 37 item 4 (App routing, SaaS navigation, packages, migrations, seeds,
`shared/**`, auth/M20/audit-writer/identity-repository/sessionResolve, DB/Supabase, customer-facing/
production, `mockData` runtime import, and the frozen C-01/C-02 implementation files).

## 40. Stop Conditions for Next Milestone

As enumerated in Section 37 item 17.

## 41. Non-Readiness Statements

The C-03 lens, when built, will not constitute production readiness, customer-facing readiness, live data
readiness, Supabase readiness, auth readiness, or any Phase 3 (controlled actions) or Phase 4
(production) authorization. It will remain a DEV-only, read-only, code/config readiness preview. Firebase
remains authoritative; Supabase remains dormant/shadow/readiness-only; no cutover is authorized.

## 42. Risks / Accepted Residuals

- UI browser-driven evidence remains NOT RUN for the C-01/C-02 chain (static review plus live transport
  used). Non-blocking residual; scheduled to be retired in M12, where UI browser evidence is a REQUIRED
  deliverable for the UI-bearing Candidate D lens (Sections 24, 37 item 15).
- Independent review used an in-context fallback in M10 (cross-model reviewer unavailable; background
  passes not durable). M11 obtained two successful independent specialist subagent passes. To prevent the
  fallback from being carried indefinitely, M12 acceptance is gated on at least one successful independent
  (cross-model or subagent) pass, time-boxed (MEDIUM, non-blocking).
- Candidate D requires careful re-expression of screen labels to avoid redaction-triggering substrings
  (the same care applied to C-02 module labels). Mitigated by the safe-label contract and tests.

---

## 43. Git Status

```
 M .replit
?? docs/phase-2.0-backend-control-panel-c02-provider-baseline-refresh-and-next-lens-selection.md
?? goose-x86_64-unknown-linux-gnu.tar.bz2
```

## 44. No Commit / Push / Backup Confirmation

No `git add`, no commit, no push, and no backup were performed during M11. Working tree only.

## 45. Acceptance Recommendation

Accept M11. The C-02 baseline is safely refreshed to the server-owned provider, the combination-gap
review found only non-blocking residuals closed by this documentation, and Candidate D is selected as the
next safe read-only lens with a fully detailed milestone package.

## 46. Recommended Next Step

Phase 2.0 M11 — Scoped Commit and Backup Authorization (the commit/backup sub-step of this same M11
milestone, committing only this single documentation file). After that M11 backup, proceed to Phase 2.0
M12 — C-03 Backend CP UI Coverage / Screen Readiness Lens.
