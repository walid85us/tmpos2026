# TM POS2026 — Critical QA Shortlist

**Prepared:** October 22, 2026 (America/Chicago).  
**Coverage:** Delivered work through M7B-INVOICES-VOID-P2-R1, with the reported Preview/dependency repairs.  
**Status:** PLANNED — NOT EXECUTED. Every result starts PENDING.  
**Your workload:** 16 owner checks. **Claude's workload:** 12 technical checks. Maximum three checks per original section.

> **Repository copy (QA-HANDOFF-CLOSE-P1, 2026-10-23).** This file is the shortlist the owner supplied, copied into the repository so the runbook can link it. The sixteen owner checks and the twelve technical checks are unchanged, and every result stays **PENDING**. Only the environment notes that had become out of date are changed, under *Environment and responsibilities*: three notes are rewritten and one note is extended, and each change is marked with its date. How each check maps onto the isolated QA session (fixtures, menu steps, sign-ins, and READY or BLOCKED) is in [runbook 14 §4.1](./14-interactive-qa-runbook.md#41-readiness). The operator's results for B01–B12 are in [runbook 14 §9](./14-interactive-qa-runbook.md#9-operator-backend-evidence-b01b12). The owner starts with **U01–U05 only**.

This replaces the 145-case pack as the immediate manual acceptance list. The extended pack remains a reference for regression and launch work; its omitted cases are not silently passed or deleted. This shortlist is deliberately narrower and does not establish whole-app acceptance or close a production gate.

The selection prioritizes unauthorized access, wrong customer/store identity, lost or duplicate writes, monetary accuracy, terminal invoice history, and usable failure recovery. It does not hide the original role/browser/viewport matrices inside each short case.

## Environment and responsibilities

- Use synthetic accounts and data only. No real Firebase sign-in, managed database, real provider, deployment or managed migration.
- *(Updated 2026-10-23.)* The ordinary development Preview (`npm run dev`) still proves rendering only: its persona panel is not a server session, and `/api/*` is not served there. The server-backed owner checks run in the isolated QA session instead (`npm run qa:interactive`, [runbook 14](./14-interactive-qa-runbook.md)). That session serves the app on the same Preview address through a QA front, in front of the real tenant runtime, an owned disposable PostgreSQL with migrations 001–035, and the Firebase Auth and Firestore emulators under the demo project `demo-tmpos-qa`.
- *(Updated 2026-10-23.)* "Real sign-in" here means the application's normal sign-in screen and flow against the **synthetic Auth emulator**, with the fictional accounts that `npm run qa:interactive -- status` prints. No real account, provider or Firebase project is used, and no real credential is ever needed.
- Use this shortlist with QA-INTERACTIVE-P1. It replaces the owner's manual checklist in that prompt; do not assign its separate setup-acceptance cases as another owner checklist. Claude still verifies setup, lifecycle, isolation and containment itself. *(Added 2026-10-23: the twelve setup procedures from QA-INTERACTIVE-P1 are kept in runbook 14 §4A as operator reference only.)*
- Do not build additional historical product backends, an admin QA platform, a worker or a Data API stack merely to remove a BLOCKED label. Reuse existing technical suites for those boundaries.
- Claude prepares the accounts, fixtures, exact launch/fault/evidence commands and expected adopted behavior. The owner should not have to inspect SQL, capture tokens or configure faults by hand.
- Claude may reuse relevant existing exact-commit test evidence for the technical checks. Run a focused check when current evidence is missing or an implementation changed. Record the actual SHA, test name, command and result. A CI job title alone is insufficient evidence.
- Run builds and technical checks serially where memory requires it. Do not reproduce OOM, flood the limiter or kill unrelated processes.
- *(Updated 2026-10-23.)* The entry this shortlist was written against was `67db6c8b2cc57b56b6937e53992e04d8da53e985`. Runbook 14 records the checkout, commits and CI runs that the QA session actually uses. Confirm them there before testing.

For current void-stage acceptance, begin with **U01–U05**. The remaining eleven owner checks are the compact regression pass across preceding work. Stop a journey on a failure; do not repeat its downstream steps against broken state.

**Results:** PASS or FAIL only after execution. Otherwise use PENDING, BLOCKED with a specific missing prerequisite, or NOT APPLICABLE with a reason. A passing synthetic check never proves a live deployment boundary.

## Owner checklist — 16 checks

### Manual QA — Invoice Void Recovery Corrections Final Review

#### U01) Recovery controls are reachable — PASS / FAIL

**Test:**
1. Have Claude prepare one unresolved void attempt and give you the exact page to open.
2. Open it at 320 px width, 600 px height and 24 px text; record how text size was set.
3. Scroll to the recovery card. Confirm its invoice identity and buttons are readable and unobstructed.
4. Use Tab to focus Check invoice, then activate it with Enter. Confirm the intended invoice opens or its current state is read.
5. Return to the card and click Dismiss with an ordinary pointer. Confirm the card closes and no new void is submitted.

**Result:** PASS / FAIL — PENDING  
**Notes:**  
**Original references:** R1-01, R1-02. This is one critical layout, not the full responsive matrix.

#### U02) A stalled sign-in stops waiting at its deadline — PASS / FAIL

**Test:**
1. Have Claude arm the synthetic stalled-provider scenario on an invoice needing recent sign-in.
2. Open the sign-in prompt and press Confirm sign-in once; start a timer.
3. At approximately 30 seconds, confirm the page explains that it stopped waiting rather than claiming the provider was cancelled.
4. Confirm the password field is cleared and usable again.
5. Leave the dialog and open Customer Directory. Confirm navigation works without reloading the application.

**Result:** PASS / FAIL — PENDING  
**Notes:**  
**Original reference:** R1-05. Exact millisecond timing belongs to the existing automated test.

#### U03) Stop waiting prevents an abandoned sign-in from voiding — PASS / FAIL

**Test:**
1. Have Claude hold a fresh provider response before any tenant-session renewal has been sent.
2. Start sign-in, then click Stop waiting.
3. Move to another page.
4. Ask Claude to release the held successful response.
5. Confirm the old confirmation does not reopen or report a void. Claude must confirm that the abandoned continuation sent no renewal or void command.

**Result:** PASS / FAIL — PENDING  
**Notes:**  
**Original references:** R1-06, R1-07. An already-sent session renewal has different semantics and is covered by existing automated regression; this case does not claim to cancel one.

### Manual QA — Issued Invoice Voiding and Recovery Final Review

#### U04) An explicit void changes only the selected invoice — PASS / FAIL

**Test:**
1. As an eligible synthetic user, open a fresh issued invoice and note its number, customer and Total.
2. Open Void invoice and confirm the dialog names that invoice and has no reason selected automatically.
3. If recent sign-in is required, complete it. Confirm that signing in does not itself void the invoice; select a reason and explicitly confirm again.
4. Wait for server confirmation, then reload the invoice.
5. Confirm it is Voided with the selected reason while its original number, customer and Total remain unchanged. Claude checks one transition and one audit record, with no refund or payment operation.

**Result:** PASS / FAIL — PENDING  
**Notes:**  
**Original references:** VOID-02, VOID-03, VOID-04, R1-11.

#### U05) A lost void answer recovers without a duplicate — PASS / FAIL

**Test:**
1. Have Claude arm the existing lost-response scenario for a different fresh invoice and state whether its database transaction committed.
2. Submit Void once. Confirm an uncertain outcome is shown rather than invented success or rollback.
3. Leave and return to Invoices. Confirm the attempt remains identified and is not automatically resent.
4. Click Check again once when enabled.
5. Confirm recovery resolves the original attempt. Claude verifies identical target/key/body bytes and no second void or audit record.

**Result:** PASS / FAIL — PENDING  
**Notes:**  
**Original references:** VOID-05, VOID-06. Suppressing the browser response does not prove a lost database COMMIT acknowledgement.

### Manual QA — Customers and Session-Bound Reads Final Review

#### U06) A customer and contacts survive reload — PASS / FAIL

**Test:**
1. Open the server Customer Directory and choose Add customer.
2. Enter a fictional name, an invented phone and an `example.invalid` email.
3. Save once and wait for confirmed success.
4. Reload and open that exact customer's profile.
5. Confirm the saved values and database creation time are shown, with no duplicate customer. The list must not expose the contact details.

**Result:** PASS / FAIL — PENDING  
**Notes:**  
**Original references:** CUS-01, CUS-03, CUS-04. This does not approve contact visibility or retention policy.

#### U07) An older customer edit cannot overwrite a newer one — PASS / FAIL

**Test:**
1. Open the same customer's edit form in two browser profiles using synthetic accounts.
2. Change and save its name in the first profile.
3. In the second profile, submit its older edit.
4. Confirm a conflict is shown and the second draft remains available for review.
5. Reload the profile and confirm the first saved name remains; no silent overwrite occurred.

**Result:** PASS / FAIL — PENDING  
**Notes:**  
**Original reference:** CUS-06. Claude verifies the HTTP version conflict and audit effects.

#### U08) An ended session clears customer data and waits for Reconnect — PASS / FAIL

**Test:**
1. Open a contact-bearing customer profile and wait until its session is confirmed.
2. Ask Claude to end that synthetic session while the page remains open.
3. Use the normal refresh/read action. Confirm customer data clears and Reconnect appears.
4. Leave and return to the browser tab. Confirm it does not silently sign in again.
5. Press Reconnect explicitly and confirm the synthetic sign-in flow begins.

**Result:** PASS / FAIL — PENDING  
**Notes:**  
**Original references:** CUS-09, CUS-10. Fresh-page expired-cookie behavior is a separate recorded limitation.

### Manual QA — Server-Saved Role Levels and Authorization Hints Final Review

#### U09) A Customers level saves and affects the restricted actor — PASS / FAIL

**Test:**
1. As the synthetic owner, open Employees → Permissions → Server-saved Customers level.
2. Lower one prepared built-in role from Edit to View and Save.
3. Confirm Saved appears only after acceptance and matching readback; reload and confirm the stored value remains.
4. In the prepared restricted actor's browser, attempt a customer edit.
5. Confirm the edit is refused and the customer remains unchanged. Claude verifies the server refusal even if browser hints were stale.

**Result:** PASS / FAIL — PENDING  
**Notes:**  
**Original references:** ROLE-01, ROLE-06. Restore the fixture only through the supported owner action or QA reset.

#### U10) An Invoices level saves independently of Customers — PASS / FAIL

**Test:**
1. As the owner, record one built-in role's stored Customers level.
2. In the Invoices panel, change that same role's level and Save.
3. Wait for matching readback, reload and confirm the Invoices value persists.
4. Confirm the Customers value did not change.
5. Open the prepared manager's Permissions view and confirm it cannot perform the owner-only level change. Claude verifies the corresponding direct API refusal.

**Result:** PASS / FAIL — PENDING  
**Notes:**  
**Original references:** ROLE-01, ROLE-03.

### Manual QA — Saved Invoice Draft Lifecycle Final Review

#### U11) A saved draft retains the exact server customer and edits — PASS / FAIL

**Test:**
1. In the designated store, create a saved draft using one explicitly selected server customer; note its ID ending.
2. Enter the prepared supported USD lines and Save once.
3. Reload and reopen the same saved draft.
4. Change one supported field and save, then reload again.
5. Confirm the change persists on one draft in that store and the selected customer identity has not changed or become a browser-local customer.

**Result:** PASS / FAIL — PENDING  
**Notes:**  
**Original references:** DRAFT-01, DRAFT-04, CUS-12.

#### U12) Discard is final and retains history — PASS / FAIL

**Test:**
1. Have Claude confirm the adopted discard policy and prepare a different fresh saved draft with eligible authority.
2. Open Discard and check the exact draft named in the confirmation.
3. Confirm once and wait for the server answer.
4. Confirm the draft's list/detail visibility follows the adopted policy and it cannot be edited or restored through the application.
5. Ask Claude to confirm a retained terminal record and the expected audit, rather than deletion of history.

**Result:** PASS / FAIL — PENDING  
**Notes:**  
**Original references:** DRAFT-07, DRAFT-08. If adoption or implementation is absent in the actual checkout, mark BLOCKED; the old proposed decision pack is not approval.

### Manual QA — Invoice Settings and Issuing Final Review

#### U13) Invoice settings save only under the owner rule — PASS / FAIL

**Test:**
1. As the synthetic owner, open the server invoice settings.
2. Change one supported seller setting using fictional information.
3. Complete explicit recent sign-in if requested, then confirm Save.
4. Wait for acceptance and reload to confirm the saved value.
5. In the prepared manager profile, confirm the same settings change is unavailable or refused. Claude verifies no unauthorized database change.

**Result:** PASS / FAIL — PENDING  
**Notes:**  
**Original reference:** ISSUE-01. Do not enter real seller, postal or tax details.

#### U14) Issuing preserves exact totals and a historical snapshot — PASS / FAIL

**Test:**
1. Open Claude's prepared unissued draft with an independently calculated subtotal, tax and Total; compare the issue review with those expected cents.
2. Explicitly issue once and wait for the server's confirmation.
3. Reload the issued invoice and confirm its number, customer, lines and amounts match the reviewed snapshot; its source draft is no longer editable.
4. Have Claude change the synthetic customer's current name through the supported command.
5. Reload the issued invoice and confirm its historical customer name and amounts did not change.

**Result:** PASS / FAIL — PENDING  
**Notes:**  
**Original references:** ISSUE-04, ISSUE-05, ISSUE-09. Issuing is not payment, a refund or a legal/accounting sign-off.

### Manual QA — Platform Identity, Tenant Commands and Money-Action UI Final Review

#### U15) Suspension blocks access and reactivation does not revive the old session — PASS / FAIL

**Test:**
1. Use an existing isolated admin fixture and a separate signed-in synthetic tenant browser. Have Claude identify the adopted status behavior.
2. Suspend that exact synthetic tenant through the served management flow.
3. Request tenant data and confirm the documented refusal with no new write.
4. Reactivate through the allowed management transition.
5. Confirm the old invalidated session remains invalid and a deliberate fresh sign-in is needed.

**Result:** PASS / FAIL — PENDING  
**Notes:**  
**Original reference:** PLAT-03. If the isolated admin UI is unavailable, mark this owner check BLOCKED and use the existing endpoint/race evidence separately. Do not expand QA-INTERACTIVE-P1 into a new admin platform for this one case.

### Manual QA — Earlier Modules — Browser and Demo Regression Final Review

#### U16) A basic demo POS sale has correct totals and resets — PASS / FAIL

**Test:**
1. Open POS in the synthetic Preview Store with local demo products only.
2. Add the prepared items and quantities and compare the displayed total with Claude's independent calculation using the accepted demo tax rules.
3. Record one simulated cash sale and check change due.
4. Start another order.
5. Confirm the cart resets and only one local sale was recorded.

**Result:** PASS / FAIL — PENDING  
**Notes:**  
**Original reference:** LEG-02. This is browser/demo regression, not server persistence, real payment or coverage of every earlier module.

## Backend checklist — Claude executes 12 checks

The owner reviews a compact result table and findings. These are not another set of terminal tasks for the owner. Use current existing suites and local fixtures wherever possible; a missing capability is BLOCKED, not a request to invent one.

### Manual QA — Backend Identity, HTTP Policy and Isolation Final Review

#### B01) Revoked authority cannot authorize a new request or command — PASS / FAIL

**Test:**
1. Record a successful protected request under an owned synthetic session.
2. End its session and repeat the request; confirm the documented refusal and no session revival.
3. Use the existing transaction barrier case where revocation commits before a sensitive command's deciding transaction check.
4. Confirm that command cannot commit and that business/audit effects match its documented refusal contract.
5. Cite the actual HTTP results, transaction ordering and exact test names; do not generalize admin race evidence to the tenant boundary.

**Result:** PASS / FAIL — PENDING  
**Notes:**  
**Original references:** AUTH-03, AUTH-05, AUTH-06. Preserve the distinction between invalid authority and an unavailable store.

#### B02) Tenant and store identifiers cannot cross authority boundaries — PASS / FAIL

**Test:**
1. Prepare a valid tenant-A/store-A1 session and one permitted customer and invoice request as positive controls.
2. Substitute tenant B's customer ID and confirm no foreign customer data is returned.
3. Substitute another store's invoice ID/path under the A1-only authority and confirm refusal.
4. Compare relevant business and audit state before and after; no unauthorized mutation may occur.
5. Record that customers are tenant-owned: access from A1 to A2 in the same tenant is not automatically a customer-isolation failure.

**Result:** PASS / FAIL — PENDING  
**Notes:**  
**Original reference:** AUTH-02.

#### B03) Origin, Host and CSRF are checked independently — PASS / FAIL

**Test:**
1. Capture one valid synthetic mutating request and establish a successful positive control.
2. On a fresh target, submit it with missing/mismatched CSRF and confirm refusal.
3. Reset the request, change only Origin, and confirm the foreign-origin refusal.
4. Reset again, change only Host, and confirm the documented host refusal.
5. Verify no prohibited business change or session creation; record local/proxy evidence without calling it production-edge verification.

**Result:** PASS / FAIL — PENDING  
**Notes:**  
**Original reference:** AUTH-07.

### Manual QA — Backend Trusted Proxy and Distributed Rate Limiting Final Review

#### B04) Forwarding headers cannot move an attacker's bucket — PASS / FAIL

**Test:**
1. Use the existing real-loopback client-address harness, not the public Preview as an attack target.
2. Record the pseudonymous bucket for a direct request.
3. Forge forwarding headers from that untrusted peer; confirm the bucket remains unchanged.
4. In the trusted-proxy fixture, add a client-written prefix to a valid chain; confirm the selected client stays unchanged. Check one malformed examined entry is refused without spending a bucket.
5. Confirm the result contains/logs no raw client address and cite the actual socket-based assertions.

**Result:** PASS / FAIL — PENDING  
**Notes:**  
**Original references:** RATE-01, RATE-02.

#### B05) Shared rate limits enforce the budget and refuse on outage — PASS / FAIL

**Test:**
1. Identify the actual approved limiter adapter and local shared store; record contract-only coverage if no adapter is composed.
2. Seed one bucket near its limit and consume through two separate instances using the existing bounded fixture.
3. Confirm the shared budget cannot be exceeded and the refused consume does not extend the window.
4. Make only that owned limiter store unavailable and send one controlled request.
5. Confirm the documented bounded unavailable response, with no local allow-all fallback or offline replay; do not run a load campaign.

**Result:** PASS / FAIL — PENDING  
**Notes:**  
**Original references:** RATE-05, RATE-06. An intermittent performance test passing on rerun is not a repaired timing issue.

### Manual QA — Backend Transactions, Idempotency and Invoice State Final Review

#### B06) An audit failure cannot leave a partial void — PASS / FAIL

**Test:**
1. Record a fresh invoice's state and the relevant audit, completion and lease state.
2. Inject the existing local audit-write failure and submit one valid void command.
3. Confirm the command reports failure/uncertainty according to its contract, with no successful void, audit or completion partially committed.
4. Inspect the acquisition separately: its committed lease must not be described as rolled back with the command transaction or silently released.
5. Recover only through the route's existing same-key replay/wait/expiry rules and cite the evidence. Do not treat every route's conflict/no-op sealing as identical.

**Result:** PASS / FAIL — PENDING  
**Notes:**  
**Original references:** TX-01, TX-03. U05 supplies the complementary committed-but-browser-answer-lost check; a real lost-COMMIT-ack branch remains separately labelled if untested.

#### B07) Concurrent issuing creates one invoice per source — PASS / FAIL

**Test:**
1. Prepare one fresh source draft in real disposable PostgreSQL.
2. Use the existing two-caller barrier fixture to issue it concurrently under different keys.
3. Confirm exactly one permanent invoice/source link and the route-specific refused/replayed result for the competing attempt.
4. Inspect the number allocation, immutable snapshot, completion and audit effects for duplicate successful issuance.
5. Cite the existing post-idempotency-retention source-link assertion if available; mark that sub-evidence unavailable otherwise, rather than claiming temporary key retention supplies permanent uniqueness.

**Result:** PASS / FAIL — PENDING  
**Notes:**  
**Original reference:** TX-07. Source uniqueness is not a global exactly-once claim or a legal gapless-numbering guarantee.

### Manual QA — Outbox, Audit and Store-Contract Foundations Final Review

#### B08) Trusted audit history cannot be rewritten by the runtime — PASS / FAIL

**Test:**
1. Read the actual audit record for U04 or another genuinely changing synthetic command.
2. Compare its actor and subject with trusted server context; confirm no raw contact/password/token payload was copied.
3. As the runtime role, attempt the existing local prohibited audit UPDATE, DELETE and TRUNCATE fixtures.
4. Confirm each is refused and the original history remains unchanged.
5. Verify the selected command's event contract: do not add an outbox event for invoice void or claim an outbox worker was exercised.

**Result:** PASS / FAIL — PENDING  
**Notes:**  
**Original references:** FOUND-01, FOUND-02. Detailed outbox delivery/redrive checks remain automated/future work where no worker exists.

### Manual QA — Migrations, Runtime Grants and Direct-Call Boundaries Final Review

#### B09) A fresh disposable database matches the runtime preflight — PASS / FAIL

**Test:**
1. Confirm the actual approved chain and protected-file hashes; the supplied baseline is migrations 001–035 plus four frozen paths, 74 files.
2. Use the approved local runner to apply that unchanged chain to a newly owned disposable database.
3. Start the current runtime and confirm exact schema/grant preflight acceptance.
4. Cite or run the existing missing/wrong-migration preflight refusal case.
5. Record the actual SHA and results; do not use the managed launcher, edit frozen migrations or claim managed migration evidence.

**Result:** PASS / FAIL — PENDING  
**Notes:**  
**Original references:** DB-01, DB-02.

#### B10) Runtime grants match the approved narrow surface — PASS / FAIL

**Test:**
1. Inspect local runtime role memberships and schema/table/column/function ACLs against the current approved grant table.
2. Run the existing direct-table-write refusal fixture for a protected business object.
3. Verify protected definer search paths and PUBLIC EXECUTE revocations using current contract evidence.
4. Record intentionally executable fixed routines and the authority/audit guarantees their direct calls do not provide.
5. Report mismatches and keep DA-118/119 or their current successors open; passing HTTP requests do not prove direct-call risks are closed.

**Result:** PASS / FAIL — PENDING  
**Notes:**  
**Original references:** DB-05, DB-06. PASS here means conformance to the approved scoped privilege contract, not resolution of every known capability risk.

### Manual QA — Supabase October 30 Grant Change Final Review

#### B11) Required access does not rely on automatic public-table grants — PASS / FAIL

**Test:**
1. Classify the current application's relevant objects as direct runtime SQL, intentionally Data-API exposed, or internal-only using repository configuration and migrations.
2. Use a separate disposable database without automatic public-table grants and apply the approved chain as intended.
3. Confirm the intended runtime operation works through explicit approved privileges and protected internals remain inaccessible to unintended roles.
4. If an intentionally exposed Data API object exists, cite its local grant/RLS HTTP evidence; if absent, record NOT APPLICABLE for that HTTP surface. If the stack is missing, mark HTTP coverage BLOCKED without building one for this checklist.
5. Report any missing privilege for later reviewed remediation; do not paste the notice's broad grant examples, alter old migrations or inspect/change managed settings.

**Result:** PASS / FAIL — PENDING  
**Notes:**  
**Original references:** SUPA-01, SUPA-02, SUPA-03, SUPA-04. Local SQL ACL evidence is not a managed Supabase exposure check.

### Manual QA — Operations, Privacy, Containment and Deferred Launch QA Final Review

#### B12) The isolated QA setup cannot leak into production or live services — PASS / FAIL

**Test:**
1. Verify QA startup uses only its owned disposable database, synthetic identity and explicit local configuration.
2. Exercise one normal browser journey without DevTools interception and inspect destinations; confirm no live provider is contacted.
3. Build the normal production artifacts and run existing containment/security checks; confirm synthetic verifiers, fixtures and operator controls are absent.
4. Check the selected journey's sanitized logs and browser storage for prohibited token/contact/request-body leakage; respect the documented in-memory recovery limitations.
5. Verify owned reset/stop behavior with the launcher tests and give the owner actual start/reset/stop commands; leave unrelated processes and owner storage untouched.

**Result:** PASS / FAIL — PENDING  
**Notes:**  
**Original references:** OPS-01, OPS-04, plus QA-INTERACTIVE-P1 setup acceptance. Retention, real edge/provider checks, backup/restore and availability remain launch work.

## Handoff and stopping rule

Claude returns one table with U01–U16 fixture readiness and B01–B12 evidence/results. Owner U results stay PENDING until the owner executes them. A blocked admin fixture does not block testing tenant invoices, and a layout-only Preview result does not pass the API/database cases.

The owner reports only the check ID, PASS/FAIL and useful Notes. A failure needs expected versus observed behavior and the synthetic fixture/run ID; never send a real password, session cookie, token or contact data.

Any unexpected unauthorized access, cross-tenant disclosure, duplicate invoice, wrong total, lost saved change or revived revoked authority is a stop-and-review finding. Known deferred behavior remains explicitly recorded. This shortened plan does not approve production deployment or close any of the reported 37 gates.

**Review skills applied:** E2E Testing Patterns; API Security Testing; Intent-Driven Development. The exposed skill inventory and definitions were read before selection; no skill instructions are being added to Claude's task.
