# Phase 2.0 — Backend CP: C-04 QA, Baseline Freeze, Browser UI Evidence Closure & Next Lens Planning (M15)

Status: PROPOSED — review and planning only. Documentation-only milestone; changes no source/test/config/
runtime. Accepted checkpoint at start: `a904913a946d2af7d5e7ec20b2dcbd813285c41c`. Most recent committed
milestone: Phase 2.0 M14 — implement backend control panel C04 route exposure lens.

---

## 1. Executive Summary
M14 delivered the C-04 Route Inventory / Route Exposure Posture lens with an enforced route allow-list.
This M15 review re-verified the entire C-04 surface against every frozen boundary and found no safety,
exposure, authority, DB/Supabase/live, production, action/mutation, route-enumeration, test, typecheck, or
sensitive-data blocker. Suite **500/500**, typecheck at the 12-error baseline (0 in `server/bcp-pilot/**`
and C-04 files), static scans clean, all seven live transport scenarios verify, and the route allow-list
holds at runtime (exactly the 4 accepted routes, 0 redacted). Browser-driven UI evidence remains **NOT
RUN** (no browser/playwright is installed and installing one is out of scope for a docs-only milestone).
Decision: **Decision B — FREEZE C-04 DEV QA BASELINE, BUT REQUIRE BROWSER UI EVIDENCE CLOSURE BEFORE THE
NEXT UI-BEARING LENS.** Selected next step: **M15A — Browser UI Evidence Closure** (then the Candidate B
planning gate).

## 2. Preflight Result
Branch `main`; HEAD == origin/main == `a904913…`; ahead/behind 0/0; nothing staged; `.gitattributes`
absent; M14 commit present; status (at preflight) only ` M .replit` + `?? goose…` (the M15 doc is created
within this milestone). Pre-change checkpoint — no extra backup. ✅

## 3. Files Created
- `docs/phase-2.0-backend-control-panel-c04-qa-baseline-freeze-browser-evidence-and-next-lens-planning.md`.

## 4. Files Modified
None.

## 5. Files Confirmed Untouched
All C-04 implementation/test files; `server/platform-identity/server.ts`; `bcpAuthorizationGuard.ts`;
`screens.tsx`; all C-01/C-02/C-03 files; `src/App.tsx`; SaaS nav; packages; migrations; seeds;
`shared/**`; auth/M20/audit-writer/identity-repo/sessionResolve; DB/Supabase. `.replit` unstaged; goose
untracked; `.gitattributes` absent.

## 6. Review / Freeze Decision
**Decision B — FREEZE C-04 DEV QA BASELINE; REQUIRE BROWSER UI EVIDENCE CLOSURE (M15A) BEFORE THE NEXT
UI-BEARING LENS.** Next step: M15A; then M16 Candidate B planning gate.

## 7. M14 Backup and Scope Review
Commit `a904913a946d2af7d5e7ec20b2dcbd813285c41c` ("Phase 2.0 M14 implement backend control panel C04
route exposure lens"); origin/main == local HEAD; fast-forward non-force `164a4bb..a904913`; exactly 15
accepted files (12 created + 3 modified), 1374 insertions, no extra files; `.replit`/goose/`.gitattributes`/
dist not committed; no C-01/C-02/C-03 impl, App.tsx, SaaS-nav, package/migration/seed/shared/auth/M20/
audit/identity/session, DB/Supabase/customer-facing/production files committed; final tree only `.replit`
+ goose. Verified clean.

## 8. C-04 Provider QA Summary
`bcpC04RouteExposureProvider.ts` — server-owned, code/config-only; exactly 4 entries = the 4 accepted
Backend CP DEV routes, no extra/customer-facing/production/broad/auth/session/admin/store/invoice/repair/
POS route; accepted bounded fields only; no DB/SQL/Supabase/MCP/live/network/env/request/auth/tenant-
store-customer/identity-audit dependency; no backend action/mutation; no mockData/frontend-src/sensitive-
row import; no permission/RBAC keys; **no runtime route scan / router introspection / Express
inspection**; no raw paths/filenames/IDs/secrets/tokens/URLs/emails/domains; deep-frozen + defensive copy
(tested); output passes the C-04 read model. Tests 42/42 (incl. allow-list). PASS.

## 9. C-04 Enforced Allow-List QA Summary
Hard backend/proxy/route-key allow-lists exist; exactly 4 allowed; `assertBcpC04RouteExposureAllowList`
enforces: every backend/proxy/key allow-listed, **tuple correspondence** (key↔backend↔proxy index-
aligned), duplicate-key rejection, missing/extra/wrong-count rejection, unknown/customer-facing/
production/broad/auth/admin route rejection, and a **descriptive safe error on null/non-array input**
(hardened in M14 review). Serialized output contains only accepted paths; static scan confirms no runtime
scanner/introspection. Allow-list tests passed. PASS.

## 10. C-04 Read Model / DTO QA Summary
`schemaVersion: bcp.c04.route-exposure-readiness.v1-code-config`, `sourceMode: code_config`, `freshness:
code-config-no-live-read`, `warnings:['code_config']`; fixed safe `generatedAt`; bounded summaryCounts/
routeItems; `safeRoutePath` exact-match allow-list (non-accepted → `redacted_route`, never a valid item);
`safeLabel`/`normalizeEnum` for other fields; redacts domains/emails/tokens/secrets/DB-URLs/UUID/long-hex/
long-digit/filenames; no raw object dumps/errors/stacks; no permission/RBAC keys, tenant/store/customer/
identity/audit data, customer-facing/production/broad routes; deterministic; no DB/Supabase/live. Tests
24/24. PASS.

## 11. C-04 Route Handler QA Summary
Pure, transport-agnostic, no-throw; gate order DEV→flag→OPTIONS(204)→method(405)→guard(pinned C-04)→HEAD→
GET; production-disabled; safe feature_disabled/dev_only/not_authorized/parity_blocked/error responses; no
raw Error/stack; query/body/header/cookie/path never authority; request-supplied route list / paths /
sourceMode / schemaVersion ignored; no DB/Supabase/live, no runtime scan/introspection, no action/
mutation, no production/customer-facing exposure. Tests 24/24. PASS.

## 12. C-04 Express Adapter QA Summary
Inert factory only (no `express()`/`Router`/`listen`/`app.*`); reads only `req.method`; no query/body/
headers/cookies/params authority; no request→principal/provider/mode/sourceMode/schemaVersion mapping; no
runtime scan/introspection; fixed synthetic principal; gates-first provider resolution; transport try/
catch→safe 500; HEAD bodyless; OPTIONS safe; mutations 405; no raw errors/stacks. Tests 18/18. PASS.

## 13. C-04 Isolated Registration QA Summary
Single `app.all(BCP_C04_ROUTE_EXPOSURE_ROUTE_PATH, createBcpC04RouteExposureReadinessHandler({ getRouteExposureEntries: getBcpC04RouteExposureEntries }))`
on the isolated platform-identity API only; route `/dev/bcp/route-exposure-readiness`; no SaaS/customer-
facing/production/App route; no method expansion; no DB/Supabase/live; no runtime scan; provider server-
sourced only; default-off + production-disabled + DEV-only + read-only. C-01/C-02/C-03 registrations each
unchanged (one each). Tests 13/13. PASS.

## 14. C-04 Authorization Guard QA Summary
`bcpAuthorizationGuard.ts` adds exactly one additive row `'C-04':'overview_viewer'`; C-01/C-02/C-03 rows,
`VISIBILITY_RANK`, and `authorizeBcpRead` logic unchanged; no write/manage/approve visibility introduced.
PASS.

## 15. C-04 Client Parser QA Summary
`bcpC04Client.ts` — GET-only; proxy `/__identity/dev/bcp/route-exposure-readiness`; no body; `credentials:
'omit'`; no Authorization; no UID/email/tenant/store/customer/identity or principal/routes/mode/sourceMode/
schemaVersion sent; no query params; no production endpoint; no DB/Supabase/provider/live; no mutation/
action; safe unavailable handling; version-tolerant; unknown schema safe; unsafe sourceMode/labels
redacted; **client-side route allow-list** (non-accepted → 'redacted'); no raw objects/errors/stacks;
bounded item cap. Tests 25/25. PASS.

## 16. C-04 UI Preview Card QA Summary
`C04RouteExposureReadinessCard.tsx` — Backend CP DEV internal only; button-triggered (no auto-fetch / no
`useEffect` fetch); read-only; no destructive/approve/revoke/provision/delete/execute/backend-action/
mutation/nav controls; no raw JSON/error/stack rendering; no `dangerouslySetInnerHTML`; no tenant/store/
customer/identity/audit data, secrets/tokens/DB-URLs/emails/domains, permission/RBAC keys, customer-facing
route enumeration, or production/customer-facing language; C-01/C-02/C-03 cards unchanged; no `App.tsx`
change; no SaaS-nav exposure. PASS.

## 17. Authority / Request Non-Authority Review
Server-sourced authority only (fixed synthetic principal); only `req.method` read. Live hostile test:
injected a deliberately non-allow-listed route path, a synthetic bearer token (`Bearer <fake-token>`), a
hostile cookie, and `schemaVersion=<fake>` → none appeared in the response and counts were unchanged.

## 18. Feature Flag / DEV / Production-Disabled Review
`ENABLE_BCP_DEV_C04_ROUTE_EXPOSURE_READINESS` default-off + `NODE_ENV` DEV gate; provider resolved only
after both gates. DEV+on → populated; DEV+off → `feature_disabled`; production+on → `dev_only`.

## 19. Route Allow-List Review
Live DEV+ON response contained exactly the 4 accepted backend routes (`/dev/bcp/readiness-summary`,
`/dev/bcp/registry-readiness`, `/dev/bcp/ui-coverage-readiness`, `/dev/bcp/route-exposure-readiness`) and
the 4 accepted proxy routes, with **0** `redacted_route` (all genuine) and no sensitive markers. Hostile-
supplied non-accepted route paths are redacted by the builder (proven in tests).

## 20. No Runtime Scanner / No Broad Route Enumeration Review
Provider/read-model/route/adapter executable code contain no `app._router`/`router.stack`/`.stack`/
`express()`/route enumeration (static-scanned + tested). The lens is a hand-curated, allow-listed constant.

## 21. Transport Verification Summary (RUN — DB-free local)
| # | Scenario | Result |
|---|---|---|
| 1 | DEV+OFF GET | 404 `feature_disabled` |
| 2 | DEV+ON GET | 200 v1 envelope; 4 items (the accepted routes only); counts `4/4/4/4/4/4/0`; `emptyState{isEmpty:false,reason:none}`; 0 redacted; no sensitive data |
| 3 | HEAD | 200 bodyless |
| 4 | OPTIONS | 204 |
| 5 | POST/PUT/PATCH/DELETE | 405 each |
| 6 | production+ON GET | 404 `dev_only` |
| 7 | Hostile request | injected route/header/cookie markers absent; counts unchanged |

Method: isolated platform-identity API booted DB-free on disposable ports; killed by PID + port reclaim.
DB-free local verification of already-committed code — not a runtime/product change.

## 22. Frontend Proxy Review
Static: `vite.config.ts` maps `/__identity` → `http://localhost:5002` (prefix stripped) → the isolated
C-04 route (same working pattern as C-01/C-02/C-03). Reaches the isolated route in DEV.

## 23. Browser-Driven UI Evidence Summary — NOT RUN (repeated residual)
Browser-driven UI evidence is **NOT RUN**. Reason (honest): no headless browser is available — no
`playwright`/`puppeteer` dependency in `package.json`, no playwright/chromium binaries on disk, and
installing one would require a package/dev-dependency change, which is **out of scope for a docs-only
milestone (M15)**. The UI is otherwise verified by static review + the client/card unit tests (25/25
client) + live transport evidence. This is the **third consecutive carry** of this residual (M13, M14,
M15). Per this milestone's browser-evidence-closure mandate, it is classified a **repeated evidence residual**; it does **not** block freezing the
C-04 code baseline (the code-level safety evidence is complete), but per **Decision B** it MUST be closed
by a dedicated milestone (**M15A**) before any further UI-bearing lens is implemented.

## 24. Safe Label / Redaction Review
All 4 entries' labels pass server + client `safeLabel`; route paths via the hard allow-list; the
recommended `no_customer_facing_exposure` value is expressed as `no_external_facing_exposure` to avoid the
`customer_` substring; serialized output scanned clean.

## 25. No Auto-Fetch / No Mutation / No Destructive Controls Review
Card is button-triggered only (no `useEffect` fetch); read-only; no mutation/destructive/backend-action
controls. Verified by static review + UI-static test assertions.

## 26–30. Test Results
Commands: `npx tsx <test-file>` per suite. **C-04 146/146** (provider+allow-list 42, read model 24, route
24, adapter 18, registration 13, client 25) · **C-03 126/126** · **C-02 122/122** · **C-01 106/106** ·
**aggregate 500/500**.

## 31. Static Scan Results
C-04 executable code clean of `createClient`/`@supabase`/`getDb`/`process.env.DATABASE`/`fetch`/`/src/`/
`mockData`/`app._router`/`router.stack`/`.stack`/`express()`/route-enumeration/customer-facing/production
route fragments (matches only in comments/denylist). No `src/**` import of C-04 backend. Guard shows
`C-01/C-02/C-03/C-04` all `overview_viewer` (additive). Accepted paths only.

## 32. Typecheck Result
`tsc --noEmit` → 12 errors = baseline; 0 in `server/bcp-pilot/**`; 0 in C-04 files; C-01/C-02/C-03
unaffected.

## 33. Independent Review Results
Two specialist-subagent review passes completed successfully (same reviewer class — cross-model Codex was
attempted but its ChatGPT auth token has been lapsing repeatedly (401), so true cross-model independence
was not available this run; per the mandatory-fallback rule the specialist passes served as the
independent lenses, ≥1 successful): a security/exposure pass (CLEAN; 3 LOW hygiene) and a governance/
factual-consistency/freeze-planning pass (SOLID; no HIGH; 2 MED + 3 LOW). Both confirm the document's
claims match the verified test/typecheck/transport/scan evidence and the C-04 code (already independently
reviewed and reconciled at M14, where four LOW findings were applied). All valid findings were reconciled
into this document (documentation-only): synthetic hostile-test markers (§17); reviewer-class wording
(this section); M15A now requires a browser-feasibility probe + package/lockfile rollback BEFORE the
dependency add, a pinned dev-only tool, and an explicit deadlock-escape/waiver outcome so the UI roadmap
cannot be blocked indefinitely (§39); the undefined "Section K" reference relabeled (§23/§39); the nested
`freshness.lastSuccessfulReadLabel` shape clarified (§34); and the M16 secret-risk control pre-stated as a
flag-NAME allow-list only (§39). No finding required any source/test/runtime change.

## 34. C-04 Frozen Baseline Summary (Decision B)
DEV-only · default-off (`ENABLE_BCP_DEV_C04_ROUTE_EXPOSURE_READINESS`) · production-disabled · read-only ·
code/config-only · server-sourced authority only · no runtime scanner · no router introspection · no broad
route enumeration · no customer-facing route enumeration. Route `/dev/bcp/route-exposure-readiness`; proxy
`/__identity/dev/bcp/route-exposure-readiness`; schema `bcp.c04.route-exposure-readiness.v1-code-config`;
`code_config` / `code-config-no-live-read`; exactly 4 entries; accepted allow-list = the 4 Backend CP DEV
routes; counts `4/4/4/4/4/4/0`; no DB/Supabase/live; no backend action/mutation; no production/SaaS-nav/
customer-facing exposure. **Browser UI evidence closure (M15A) required before the next UI-bearing lens.**

## 35. Accepted Residuals
- Browser-driven UI evidence NOT RUN (3rd carry) — to be closed by M15A (a dedicated, properly-scoped
  milestone allowed to add a browser/e2e dev-dependency and capture evidence for C-01..C-04 cards).
- Production `dev_only` JSON 404 mildly signals a dev-gated route exists — accepted (exact C-01/C-02/C-03
  baseline parity; no data leak).
- Cross-model (Codex) reviewer intermittently unavailable (auth token lapses) — specialist-subagent
  fallback used.

## 36. Next Lens Candidate Evaluation Summary
| Candidate | Purpose | Risk | Verdict |
|---|---|---|---|
| B — Feature Flag / Environment Posture | bounded flag/env posture labels | Medium (env can hold secrets) | Selected as next lens, but via a **planning/safety-contract gate first** (M16), and only after M15A |
| E — Audit / Security Posture | audit/security status | High | Reject for now |
| F — Identity / Session Posture | identity/session readiness | High | Reject for now |

## 37. Selected Next Step
**M15A — Browser UI Evidence Closure** (Option 1), then **M16 — Candidate B Planning Gate** (Option 2).
Candidate B is a UI-bearing lens with inherent secret-risk, so the browser-evidence residual must be
closed (M15A) and a safety contract established (M16) before any Candidate B implementation.

## 38. Selection Rationale
The C-04 code baseline is fully verified (500/500, transport, two clean independent passes, enforced
allow-list), so it can be frozen now. The single open gap is browser UI evidence, carried three times;
closing it requires installing a browser/e2e tool — a package change that does not belong in a docs-only
milestone, hence a dedicated M15A. Because the next lens (Candidate B) is itself UI-bearing AND carries
environment-secret risk, the safe ordering is: close the UI-evidence residual (M15A) → establish a
Candidate B safety contract (M16 planning gate) → implement only if proven bounded. B is preferred over E/F
(both High risk).

## 39. Recommended Next Milestone — M15A — Browser UI Evidence Closure
1. **Name:** Phase 2.0 M15A — Backend CP Browser UI Evidence Closure.
2. **Purpose:** capture browser-driven evidence that the DEV Backend CP shell renders the C-01..C-04
   readiness cards safely (button-triggered, no auto-load, no raw JSON/errors/destructive controls, C-04
   shows only the 4 allow-listed routes), retiring the carried residual.
3. **Allowed files:** a dev-only e2e test/harness (e.g. `tests/e2e/backend-cp-cards.spec.ts` or
   `scripts/`), and the **minimal** `package.json`/lockfile change to add a dev-only browser tool
   (playwright or puppeteer) — explicitly accepted because this milestone's purpose IS to add browser
   evidence; plus an optional evidence output dir. Constraints on the dependency add: (a) run a one-shot
   **browser-feasibility probe FIRST** (attempt headless chromium launch / check required shared libs)
   BEFORE committing the dependency — three prior carries suggest a sandbox/system-lib limitation, not a
   missing package; (b) if the browser still cannot launch, **roll back** the `package.json`/lockfile so
   M15A leaves no heavy unused dev-dependency (no new residual); (c) the tool must be **pinned to an exact
   version with lockfile integrity** and marked **dev-only (never bundled to production)**; (d) prefer
   text assertion logs over committing binary screenshots into git (retention policy). Each file accepted
   in the M15A prompt.
4. **Prohibited files:** any C-01/C-02/C-03/C-04 implementation file; `src/App.tsx`; SaaS nav; migrations;
   seeds; `shared/**`; auth/M20/audit/identity/session; DB/Supabase; production/customer-facing files;
   `mockData` as a runtime backend import.
5. **Source/provider contract:** none new — drives the EXISTING DEV shell + isolated API; no new lens.
6. **DTO/output contract:** n/a (no new DTO).
7. **Route/adapter/registration contract:** n/a (no new route).
8. **Client/UI contract:** read-only e2e navigation + button clicks only; capture states; no mutation.
9. **Authority/non-authority contract:** e2e runs against the DEV isolated API with flags on; no
   production target; no real credentials; no live DB/Supabase.
10. **Test requirements:** the e2e spec asserts the browser-evidence checklist (shell loads; each card visible
    only in the DEV shell; no auto-load; button-triggered; safe success/empty/disabled states; C-04 shows
    only the 4 allow-listed routes; no broad/customer-facing routes; no raw JSON/error/stack; no
    destructive controls); the existing 500 unit tests must still pass.
11. **Static scans:** confirm the e2e harness adds no production target, no real secrets, no customer-
    facing route assertions, no DB/Supabase.
12. **Typecheck:** baseline unchanged (allow the new dev-tool types); 0 in touched files.
13. **Transport evidence:** reuse the C-01..C-04 transport scenarios as the API backing for the e2e run.
14. **Browser/UI evidence:** REQUIRED and captured (this is the milestone's purpose); if the feasibility
    probe (item 3a) or a post-install launch shows the environment genuinely cannot run a browser, report
    NOT RUN with the precise blocker and apply the **deadlock-escape outcome** so the UI roadmap is NOT
    blocked indefinitely: either (i) run the e2e in an environment/CI that can launch chromium and attach
    that evidence, or (ii) record an explicit owner-signed waiver accepting the existing static + 25/25
    client/card unit + transport evidence as sufficient for UI-bearing lenses. Do not loop; the
    browser-closure gate on the next UI-bearing lens is satisfied by captured evidence OR the signed
    waiver, not by repeated NOT-RUN carries.
15. **Independent review:** ≥2 passes (security/exposure + implementation), at least one successful.
16. **Stop conditions:** stop+blocker if browser evidence requires production access, real credentials,
    live DB/Supabase, customer-facing routes, or any change to a frozen C-01..C-04 implementation file.
17. **Final report:** standard numbered report with captured evidence (or honest NOT-RUN + blocker).
18. **Commit/backup rules:** scoped staging of only accepted files; fast-forward non-force push; co-author
    trailer; backup report; stop for owner review.

(After M15A: **M16 — Candidate B Planning Gate** with its own allowed/prohibited/contract/stop-condition
detail, mirroring the M9 planning-gate format, before any Candidate B implementation. M16 must mandate the
same allow-list discipline that made C-04 safe: a curated allow-list of feature-flag NAMES with boolean
presence/enabled posture ONLY — never raw environment enumeration, raw env values, secrets, keys, URLs, or
a full env-key inventory.)

Note on envelope shape: where this document renders `freshness: code-config-no-live-read` as shorthand,
the actual envelope field is the nested `freshness.lastSuccessfulReadLabel` (value `code-config-no-live-read`).

## 40. Allowed Files for Next Milestone
As enumerated in §39 item 3 (M15A): dev-only e2e harness + minimal package/lockfile dev-dependency +
optional evidence output dir; exact list fixed in the M15A prompt.

## 41. Prohibited Files for Next Milestone
As enumerated in §39 item 4.

## 42. Stop Conditions for Next Milestone
As enumerated in §39 item 16.

## 43. Non-Readiness Statements
Phase 2.0 remains: not production readiness; not customer-facing release; not Phase 3 controlled actions;
not Phase 4 production readiness; not live DB/Supabase reads; not live provider reads; not Supabase auth
enablement; not Firebase-to-Supabase cutover. Firebase remains authoritative; Supabase remains dormant/
shadow/readiness-only; Backend CP remains DEV-only and read-only in Phase 2.0.

## 44. Risks / Accepted Residuals
- Browser UI evidence NOT RUN (3rd carry) — closed by M15A (required before next UI-bearing lens).
- Production `dev_only` 404 parity accepted.
- Candidate B (env/feature-flag posture) carries secret-risk — requires the M16 planning gate + a
  hard-scoped safe-posture-labels-only contract before implementation.

## 45. Git Status
```
 M .replit
?? docs/phase-2.0-backend-control-panel-c04-qa-baseline-freeze-browser-evidence-and-next-lens-planning.md
?? goose-x86_64-unknown-linux-gnu.tar.bz2
```

## 46. No Commit / Push / Backup Confirmation
No `git add`, commit, push, or backup performed during M15. Working tree only.

## 47. Acceptance Recommendation
Accept M15. C-04 is frozen as the Phase 2.0 DEV QA baseline (code evidence complete); the browser UI
evidence residual is honestly classified and assigned to M15A (required before the next UI-bearing lens);
Candidate B is selected for a later planning gate. All evidence reported honestly (browser UI NOT RUN with
the precise blocker; cross-model fallback noted).

## 48. Recommended Next Step
Phase 2.0 M15 — Scoped Commit and Backup Authorization (commit this single documentation file). After the
M15 backup, proceed to Phase 2.0 M15A — Backend CP Browser UI Evidence Closure.
