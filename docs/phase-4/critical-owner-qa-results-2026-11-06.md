# Critical owner QA results — recorded 2026-11-06 (QA-OWNER-CLOSEOUT-P1)

**Status: evidence record only.**
- It records the owner's results for the compact checks U01–U16 of the [critical-QA shortlist](./TMPOS2026-critical-qa-shortlist.md) and the owner's acceptance of QA-UI-01 and QA-UI-02.
- It also records the operator evidence B01–B12 already held in [runbook 14 §9](./14-interactive-qa-runbook.md#9-operator-backend-evidence-b01b12).
- It closes no gate. All 37 production gates in [doc 08](./08-production-gate-and-risk-register.md) stay **OPEN**.
- It is not acceptance of the application or of Phase 4.0, and it makes no production-readiness claim.
- The extended 145-case pack was not executed.

All dates are 2026 and all times are UTC.

**Source of these results.** They are the owner's reports and the UI and CLI observations the owner supplied. This stage performed none of the application checks again; it only reconciled them with the evidence in the repository.
- The shortlist itself is left unchanged: it is the planning copy, and it still reads PENDING.
- The procedures are runbook 14 §4 (U01–U05) and §4.3 (U06–U16).

**Summary.**
- 12 checks PASS: U02, U03, U04, U05, U06, U07, U09, U11, U12, U13, U14 and U16.
- 2 checks PASS with one portion BLOCKED: U01 (exact layout) and U10 (direct API).
- 2 checks are BLOCKED: U08 and U15.
- Every PASS is limited to what the owner observed, as written below.

## 1. Owner checks U01–U16

| Check | Result | Run | What was observed | Limits kept |
|---|---|---|---|---|
| U01 — Recovery controls are reachable | Functional **PASS**. Exact 320×600 / 24 px layout: **BLOCKED** | `qa-20261027t1929-120c` | Keyboard focus was visible. Tab then Enter worked **Check invoice**. A mouse click worked **Dismiss**. The recorded invoice effects were unchanged | The exact 320×600 / 24 px text check could not be run: the owner's PC prohibits Developer Tools. That restriction was not bypassed, and an ordinary window screenshot was not taken as exact layout evidence |
| U02 — A stalled sign-in releases the page at its deadline | **PASS** | `qa-20261027t1929-120c` | The page was released after about 30 seconds. The password was cleared and Customer Directory stayed usable. The late release was not delivered, and the invoice was unchanged | The owner's timing is approximate |
| U03 — Stop waiting prevents the old attempt from resuming | **PASS** for the observed manual criteria | `qa-20261027t1929-120c` | The wait ended and the password was cleared. Navigation stayed usable. The late release reopened no old dialog, and the invoice stayed issued | This owner pass did not separately capture every abandoned renewal or void HTTP request |
| U04 — Explicit void changes the selected invoice only | **PASS** | `qa-20261104t2107-92e8` | A recent sign-in alone did not void the invoice: a reason and the explicit action were required. The voided invoice was `inv-void` `4cf2853b-da2f-45f2-850c-55481bfca7f1`, at 2026-11-04T21:21:23.273Z. After reload it kept its identity, its customer and its $50 total. The supplied CLI evidence showed one void audit and one added completion | — |
| U05 — A lost answer recovers without duplication | **PASS** for the observed recovery and the recorded effects of the successful retry | Retry: `qa-20261104t2225-b4c0` | On `inv-held` `114b84e1-2863-4dcd-9611-8959fcade590`, the void came back upstream 200 with committed true. The uncertainty notice stayed across navigation until **Check again**. The void was at 22:34:56.639Z on November 4, and the held-response record at 22:34:56.642Z. Completions went 21 → 22, tenant-A voids and audits 1 → 2, and pending stayed 0. Tenant B was unchanged in the supplied output. One void audit and one added completion | The owner's evidence did not capture the raw key or body-byte identity. Holding back the browser's response is not a test of a lost database COMMIT acknowledgement. The earlier refused attempt is kept in §5 |
| U06 — Customer persistence | **PASS** | Not supplied | The owner reported the saved values after save, reload and on the profile, and one matching customer entry | No new direct SQL or audit evidence was supplied |
| U07 — Customer edit conflict | **PASS** | Not supplied | The owner reported that the first successful save survived an older edit | The owner swapped the example's A and B labels. "Saved B" was the value already saved successfully, so it is not evidence of a later unauthorized edit |
| U08 — Ended session / Reconnect | **BLOCKED** | — | — | No supported interactive control for ending a synthetic session was supplied. The existing technical evidence (B01) is separate and is not an owner result |
| U09 — Stored Customers permission | **PASS** for the observed refusal | Not supplied | The manager's edit was refused, and the screenshot reads "You can't edit this customer". The owner confirmed the name and contacts were unchanged after reload | No direct HTTP or SQL evidence was collected in this owner check |
| U10 — Independent Invoices level | UI **PASS**. Direct-API subcheck: **BLOCKED** | Not supplied | The owner reported that the level saved and read back, that it is independent of Customers, and that the manager's write was unavailable | Restoring the Full Access value does not by itself prove that an explicit override was removed or that its Default marker came back |
| U11 — Server draft creation and editing | **PASS** within the selected manual coverage, in two separately identified portions | Editing: `qa-20261104t2358-fd91`. Creation: not supplied | **Editing an existing draft:** the $42 line was kept, a $50 line was added, and the subtotal was $92 after reload. **Creating a new draft:** Ben Placeholder (QA) was explicitly selected, with the line "QA U11 new draft", quantity 1 and a $50.00 unit price and subtotal. The new draft's ID is `52965341-15c6-4e22-907c-a634743ade5e`, shown as "ID ending 743ade5e". The screenshot shows Northwind Main (QA), Draft · USD, version 1, created 2026-11-05 23:20 UTC. The owner confirmed one matching list entry and the reload | These are two separate portions on different drafts and in different runs. They are not one continuous create-and-edit trace on the new draft |
| U12 — Discard | **PASS** | `qa-20261105t1317-8eaa` | The owner confirmed the discard in the UI, with CLI evidence before and after. `draft-discard` `e3f28425-22c5-4b17-b5a6-a5c80e9b2047` went from draft / version 1 to discarded / version 2, and one discard audit was added. Its customer, line count, $15 subtotal, creation time and earlier create outbox entry were kept | The discarded draft is kept as a terminal record. History is not erased, and no retention policy is adopted |
| U13 — Issuing settings | **PASS** | Reported as following `qa-20261105t2119-6519` | The owner reported that the legal seller name Northwind Repairs U13 (QA) was saved and read back after reload. A manager change was unavailable or refused, and the settings the owner sees were unchanged | No new direct HTTP or SQL proof |
| U14 — Issue and historical snapshot | **PASS** | Not supplied | The owner reviewed $29 + $30 = $59 with "No tax calculated", issued it explicitly and reloaded. The issued invoice kept the historical customer, Ada Fictional (QA), after the current customer was renamed Ada U14 Updated (QA). The invoice record ID is `db5f130e-c433-4da4-9724-31ab5150bd91`, shown as "ID ending 5150bd91". A follow-up screenshot shows it issued as **invoice 6** at Northwind Main (QA) | **Invoice 6** is the business number; `db5f130e-…` is the record's UUID. The actual source draft differed from the earlier instruction's draft ending `1b6e7ee6`. The actual source draft ID and run were not supplied, so the result is not bound to that outdated reference |
| U15 — Suspend and reactivate | **BLOCKED** | — | — | No isolated admin UI was supplied, and none was built for this record |
| U16 — Demo POS sale | **PASS** | Corner label `qa-20261105t2359-9daf`; generation and SHA not supplied | The sale was 2 × USB-C Charging Cable at $12.99 (SKU USB-C-CBL-01): subtotal $25.98, tax 8.25% rounded to $2.14, total $28.12. Paid $30.00 cash in Exact mode, remaining $0.00, change $1.88. The checkout label before the sale was TRX-99210. The success screen showed receipt **INV-1007**, Walk-in Customer, $28.12. The owner's notes confirm that New Transaction reset the cart and payment, and that there is one INV-1007 record | The owner's reply kept the PASS / FAIL template heading; its notes confirm the remaining criteria. This is demo and browser coverage only. It shows no production payment, no external receipt delivery and no database-level uniqueness. INV-1007 belongs to this demo journey, not to U14's server-issued invoice 6 |

## 2. Owner acceptance of the QA-UI fixes

| Item | Result | Run | What was accepted | Not cleared by it |
|---|---|---|---|---|
| QA-UI-01 — the line headings sit over their columns (`7baf307`) | **2/2 PASS**: heading alignment, and values and controls preserved | `qa-20261105t1317-8eaa` | Accepted after the original heading defect and the reported fix | The Close-button clipping at enlarged text (§6), and U01's blocked exact layout |
| QA-UI-02 — visible record IDs and Copy ID (`ddd612d`) | **3/3 PASS**: the right record IDs, the full value copied in the owner's browser, and layout and values preserved in an ordinary window | `qa-20261105t1747-b23a` | Target draft `cba3d44a-37f0-4a5b-a915-3d5ef9510138`; invoice 4, whose record ID is `552c07ba-12fb-48b8-ab46-8c1379bf4f85` | The same two items. Ordinary-window acceptance is not an enlarged-text layout check |

## 3. Runs and their executables

The run manifests that are still kept record no commit SHA. They are `current.json` and `launch.json`: for example, the preserved records of `qa-20261104t2358-fd91` and `qa-20261105t1317-8eaa`, and `qa-20261105t2359-9daf` in `.cache/tmpos-qa`. So no historical run is bound to an exact executable fingerprint.

The "HEAD by time" column is an inference only: it names the commit that was HEAD when the run started, from commit timestamps. It does not show that the run's bundle matched that commit, because uncommitted working-tree changes are not recorded. A later commit and its green CI do not certify an earlier owner run. Every `start` and `reset` recreates the fixture IDs, so each ID above belongs to its own run.

| Run | Used for | HEAD by time (inferred) | Recorded binding |
|---|---|---|---|
| `qa-20261027t1929-120c` | U01–U03 | `8a3dcc9` | Not recorded |
| `qa-20261104t2107-92e8` | U04; the refused U05 attempt (§5) | `8a3dcc9` | Not recorded |
| `qa-20261104t2225-b4c0` | U05, the successful retry | `8a3dcc9` | Not recorded |
| `qa-20261104t2358-fd91` | U11, the editing portion | `8a3dcc9` | Not recorded. The run died at about 00:35Z on November 5, cause unknown |
| `qa-20261105t1317-8eaa` | QA-UI-01 acceptance; U12 | `7baf307` | Not recorded. The run stopped at about 14:14Z on November 5, cause unknown. Its record, logs and cluster are preserved locally |
| `qa-20261105t1747-b23a` | QA-UI-02 acceptance | `ddd612d` | Operator observation at start, not in the manifest: the checkout was `ddd612d` plus the uncommitted one-line supervisor edit later committed as `64f1433`. The served `App-CEs2RR14.js` held the new ID labels and the heading fix |
| `qa-20261105t2119-6519` | Reported as the run U13 followed | `64f1433` | Not recorded. It is not assigned to U14 or to the new U11 draft |
| `qa-20261105t2359-9daf` | U16 (corner label) | `64f1433` | Not recorded; no generation supplied |
| Not supplied | U06, U07, U09, U10, U14, and U11's creation portion | — | Not recorded |

## 4. Implementation commits and their CI

| Commit | Change | Exact-SHA CI |
|---|---|---|
| `7baf307` (`7baf307eb4527e3757afd6d017e243cd1b65445d`, tree `5d4a61d76b43e2c8d21fe46b01adced85bfc6216`) | The line headings over their columns (QA-UI-01), with browser scenario SLH-01 | Run 41947198432. **Attempt 1 failed:** `quality` failed at M7CC-11 on a sign-in 503 and its later steps were skipped; `appsec` succeeded. A failed-job rerun, **attempt 2, succeeded**. Both attempts stay on record |
| `ddd612d` (`ddd612d655f23bb2dfc53eed5acb5e7fe09e32e9`, tree `b826296af7834149b8de7cb34591da8a6d6840b9`) | Visible record IDs and Copy ID (QA-UI-02), with SRI-01–06 and SLH-02 | Run 42051795782, **attempt 1 succeeded**. Its report described it in a repeated paragraph: that is one run, not two passes |
| `64f1433` (`64f1433704b84ef80b6bdb9cfa9e101056cd5542`, tree `3e5d52bba931223f1e36abbccf30cb70e57948ad`) | A one-line QA supervisor diagnostic: the start-failure message now names the runtime's refusal reason | Run 42079393105, **attempt 1 succeeded**. It changes only what a future failure reports. It neither recovers nor explains the failed start in §6 |

## 5. The refused fresh-sign-in attempt (U05, kept)

- **What happened.** In run `qa-20261104t2107-92e8`, on `inv-held` `70795702-bbe4-4ae5-85b4-0657eb4890f4`, at 2026-11-04T21:45:50.893Z, the void came back upstream **403** with committed false.
- **Its effect.** The invoice stayed issued, and no void or completion was added.
- **The sign-in.** The owner confirmed a fresh password sign-in immediately beforehand. The "sign-in too old" text seen later does not establish which guard refused the first attempt.
- **Status.** The 403 is unexplained and stays open. The later successful retry (§1, U05) does not explain it.

## 6. Unresolved findings

- **Draft dialog Close-button clipping.** At 320×600 with 24 px text, the reopen dialog's header **Close** reaches past the dialog's edge. This was measured on `7baf307`'s bundle before QA-UI-02. It is unresolved, and neither the ordinary-window owner acceptance nor the other viewport tests clear it.
- **U01's exact layout check** is BLOCKED (§1).
- **Failed QA start `qa-20261105t1726-74b6`.**
  - At 17:28 on November 5, the tenant runtime exited with code 1, reporting "refused" with no reason. The reason was lost because cleanup deleted the runtime's log.
  - Firestore's exit 143 was later shutdown output, not the cause.
  - The surviving logs are preserved locally under `.workflow/qa-ui-02-p1/preserved/failed-74b6/`.
  - The VM had restarted at about 17:24.
  - The successful retry (`qa-20261105t1747-b23a`) and `64f1433` do not diagnose the original cause.
- **The fresh-sign-in 403** (§5).
- **QA interruptions without an established cause:** the deaths of runs `fd91` and `8eaa` (§3); VM reboots; out-of-memory kills observed during local browser runs (`oom_kill` rose to 20 on November 5; the victims are unknown).
- **QA session residuals carried from runbook 14:**
  - the shared login-limiter client identity;
  - the Preview edge's 502 for a held void;
  - fault records surviving `reset`;
  - the unrecorded-cluster and check-then-signal windows in process and cluster ownership (runbook §7);
  - the session cookie held with `SameSite=None` in the QA Preview (B12).
- **Dependency and CI findings, as recorded in doc 08:**
  - M6R-PERF's CI flake and its five unimplemented diagnostics;
  - the CI runner's intermittent Chromium start and the launcher's diagnostics gap;
  - the top-level `qs` 6.14.2's moderate advisories and the full tree's ten development-only Highs;
  - GHSA-46jr's upstream gap;
  - the zod fix's unbounded-container residual;
  - CI duration close to the `quality` job's limit;
  - the gitignored `dist/`.
- **U08's, U10's direct-API and U15's missing prerequisites** (§1).

## 7. Operator backend evidence B01–B12 (retained, not re-run)

These rows summarize runbook 14 §9, which holds the full assertion lists and excluded scope.
- The cited assertions ran in exact-SHA CI 39980272453 on `089c622`, attempt 1. The B12 live journeys are the runs §9 names.
- Nothing was executed again in this stage, so none of these results is new.
- Names marked *(suite count)* in §9 are shown only by their suite's pass count.

| Check | Result as retained | Evidence (runbook 14 §9) | Scope | Gap |
|---|---|---|---|---|
| B01 — revoked session or authority cannot authorize | PASS | `adminRevocation` M5R-03a/04a; `adminBoundary` M5E-B3/G; `tenantAdmission` M5A-04b; `tenantSessionOrdering` M5T-D2/L1; IDDH-05, IDH-09, IVH-10, IIH-06 | PG | Tenant revocation reaches the session through harness-only routes. No live revocation check exists (U08 BLOCKED) |
| B02 — ids cannot cross tenant or store authority | PASS | M7TE-14, M7CD-03, M7C-04, M7CH-03; IDH-02, IIH-02, IVH-03, IDR-04 | PG | No live cross-tenant probe; DA-93 open; G-ISOLATION OPEN |
| B03 — Origin, Host and CSRF, with a positive control | PASS | M5IRLH-04, M7CC-02, M7TE-05/06, M6EP-10/11/04; QA front Host *(suite count)*; live `probe --positive` (`qa-20261023t2047-d5e0` gen 3) | PG, HTTP, proxy | Some refusal batches have no per-refusal row count. The live Origin and Host refusals kept only the operator's record. Not production-edge evidence |
| B04 — forwarding headers cannot move a client bucket | PASS | M6RS-09/01/06; `clientAddress` and `enforcement` *(suite count)*; the front's `forwardHeaders` (contract) | PG, HTTP, contract | `True-Client-IP` and `CF-Connecting-IP` are passed through, and the runtime ignoring them rests on source only. The chain from front to runtime to limiter is not exercised in CI; DA-9 open |
| B05 — the shared limiter enforces its budget and refuses on outage | PASS | RLR-04, M6R-09, M6RS-00/03/10/11/14; `enforcement` *(suite count)* | PG, HTTP, contract | A slow store is not driven end to end. No outage test of the QA session's limiter; DA-52 open; no load campaign |
| B06 — an audit failure cannot leave a partial void | PASS | IVH-08/09/11/11b; IVR-08 | PG | No real lost COMMIT acknowledgement. Lease expiry is forced. DA-118 and DA-119 OPEN |
| B07 — concurrent issuing makes one invoice per source | PASS | IIR-12/13; IIH-08/09 | PG | No concurrent same-key issue and no load test. Not an exactly-once or gapless-numbering claim |
| B08 — trusted audit history cannot be rewritten by the runtime | PASS | IVH-04/06; IDDH-16; M6AA-14; S2-DB-23/24/27; IVR-08 | PG, contract | The trigger is not `ENABLE ALWAYS`: owner or superuser rewrites in replica mode are not blocked. "No outbox worker" is static only; DA-118 open |
| B09 — a fresh database matches the runtime preflight | PASS | preflight and migration-files contracts *(suite count)*; S2-DB-1; M7C-01; M6PF-02/22; M7TE-10 | PG, contract | No single CI step applies 001–035 to an empty database. Ledger drift is not re-read (DA-55). No managed database; G-MIGRATE OPEN |
| B10 — runtime grants match the approved narrow surface | PASS for the approved narrow-grant contract only | M6PF-01/14; M7CC-09; IDR-02; S2-DB-6/7 | PG | **The approved direct-grant capability risks stay OPEN:** DA-118, DA-119 (pre-deployment blockers) and DA-132; DA-29 and DA-37 are recorded. M6PF-01 proves equality with the approved list, not minimality. The startup preflight does not inspect `anon` or `authenticated`, so a grant added outside the migrations is not excluded by that evidence. G-DBROLE OPEN |
| B11 — no reliance on automatic public-table grants | SQL half **PASS**. Hosted Data API half **BLOCKED** (NOT APPLICABLE inside the repository) | S2-DB-22c, S2-DB-0; M6PF-30/31/36; IVR-05 | PG (SQL only) | The Data API HTTP half was never performed. Schema exposure, object grants and RLS on a hosted Data API are deployment properties |
| B12 — the isolated QA setup cannot leak | **QUALIFIED**: PASS for the observed runs only | `qaInteractiveContainment` and `qaInteractiveFront` *(suite count)*; host lists and a socket snapshot of the live runs; the read-only journey of `qa-20261027t0327-f61e` (runbook §12) | contract, proxy, host `/proc` | The log and storage inspection was limited to one read-only journey. The void-recovery memory claim was checked in source only. The browser held the Preview session cookie with `SameSite=None` although the server sets `Strict`; the QA proxy reportedly passed it through unchanged. A Replit-layer explanation is unverified and is not a production-edge conclusion. The lifecycle windows of runbook §7 remain |

## 8. Not claimed

- Any gate's movement: all 37 stay OPEN (21 BLOCKER, 14 HIGH, 2 MED).
- Acceptance of the application or of Phase 4.0, or production readiness.
- Execution of the extended 145-case pack.
- That B01–B12 were executed again.
- An exact executable for any historical owner run.
- Exact layout at enlarged text, from any ordinary-window result.
- Production payments, external receipt delivery or database uniqueness, from U16.
- A cause for the 403, for the failed start, for the run deaths, reboots or out-of-memory kills.

## 9. Owner document review

The owner's three review checks of this record are left for the owner:

1. **Results match the owner's completed checks** — Result: PASS / FAIL — PENDING
2. **Record identities and evidence are truthful** — Result: PASS / FAIL — PENDING
3. **Open coverage and launch state remain explicit** — Result: PASS / FAIL — PENDING
