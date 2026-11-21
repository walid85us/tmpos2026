# 17 — M7B credit notes, CN-P2: the shop's issue control and recovery (design)

**Status: ADOPTED; CN-P2 IMPLEMENTED IN CODE IN AN UNCOMMITTED LOCAL CANDIDATE — QA DEFERRED BY THE OWNER — RELEASE NOT AUTHORIZED (recorded 2026-11-18; §8 is the delivery record).**
- **Development.** CN-P2 is implemented in code in an uncommitted local candidate on base `eb10f4c` (this document's adoption commit), under the owner's authorization of 2026-11-16 for local implementation and verification only (§8.1). It has no commit and no CI run; commit, push and CI each need separate owner approval. Development is not complete: the last full local verification ran on an earlier tree, and named test work remains (§8.4, §8.6).
- **QA.** Deferred by the owner on 2026-11-18, until development across all phases is finished. The earlier synthetic runs were RAM-backed UI observations only, with no crash-durability evidence, and the durable run on Replit could not seed (§8.5). No QA result is claimed as acceptance.
- **Release.** Not authorized. Under D-P2-13 A, CN-P2 is not deployed until the store-wide credit-activity read, built in its own slice, passes its gate; that slice has no contract yet and its migration 039 does not exist. How the cross-owner duplicate residual is handled in production (D-P2-14) is an open owner decision (§8.7).
- **Gates unchanged.** 37 gates: 29 OPEN, 7 PARTIAL, 1 PASS. ICH-11 stays UNVERIFIED, CN-38 stays a deployment prerequisite, G-APPSEC stays PARTIAL and production-blocking, F-2 and F-5 stay missing inputs, and G-A11Y stays OPEN (the P2-61 screen-reader pass is deferred; the P2-52 automated scan is not established).

**Status at adoption, 2026-11-16 (history): ADOPTED — DESIGN ONLY (owner decisions of 2026-11-16; §7 records each choice). Implementation, push, CI, deployment and managed migrations each need separate approval.**

- **Baseline.** `main` at `8148eebb0cb7270cd96acdbed912f5afcb8818ee` (CN-P1 closeout records on top of CN-P1 at `064b5f1`). Push CI run 43778230600 on that commit passed, attempt 1.
- **What this document is.** The design for CN-P2, the slice that [16](./16-m7b-invoice-credit-note-decision-pack.md) D-CN-11 A names "the shop's issue control and recovery" (D16:307). D16:810 says CN-P2 "is not started and needs its own approval". The owner adopted this design on 2026-11-16 with the choices in §7. Building it is a separate approval.
- **Adopted scope.** The invoice-level credit-note list stays in CN-P2 (D-P2-1 A). The store-wide activity read is built in its own slice (D-P2-2 A) and is a deployment prerequisite for CN-P2 (D-P2-13 A). Withdrawal stays in CN-P3 (D16:308). No server, migration, route or permission change.
- **Unchanged by this document.** 37 gates: 29 OPEN, 7 PARTIAL, 1 PASS (D16:807). ICH-11, the HTTP cutover variant, stays UNVERIFIED (D16:803). CN-38, the cutover rehearsal, stays a deployment prerequisite (D16:803). G-APPSEC stays PARTIAL and production-blocking (D16:804). F-2 and F-5 stay missing inputs (D16:805). CN-P3 (the withdrawal control) stays out of scope (D16:308). Payment, reversal and void behaviour do not change, except that Void and Reverse are hidden while a credit-note attempt needs them hidden (§2.3).

**Status labels.**

| Label | Meaning |
|---|---|
| ADOPTED | Owner-adopted text (D16 is ADOPTED, D16:3); cited by document and line |
| SHIPPED | Behaviour of the code on `main` at the baseline; cited by `path:line` |
| PROPOSED | Design text written for owner review; adopted as design on 2026-11-16 together with §7's recorded choices, which govern where they differ. Not implemented |
| DECISION | An owner choice; §7 records the options, the recommendation and the choice made |

**Short names for citations.**

| Short | Path |
|---|---|
| D16, D15, D13, D10, D09, D08, D14 | `docs/phase-4/16-…credit-note-decision-pack.md`, `15-…payment-recording…`, `13-…void-and-correction…`, `10-architecture-decision-records.md`, `09-roadmap-m0-m9.md`, `08-production-gate-and-risk-register.md`, `14-interactive-qa-runbook.md` |
| RT, APP, PG, PTS, IDEM, RL | `server/runtime/invoiceCreditNotes.ts`, `server/runtime/app.ts`, `server/persistence/postgresInvoiceCreditNotes.ts`, `server/persistence/postgresTransactionalStore.ts`, `server/runtime/idempotency.ts`, `server/runtime/rateLimit.ts` |
| M38, M06 | `server/platform-identity/migrations/038_m7b_invoice_credit_note.up.sql`, `…/006_m6_transactional_store.up.sql` (the idempotency record) |
| PERM | `server/platform-identity/m5CanonicalPermissions.ts` |
| SES, PAY | `server/runtime/sessions.ts`, `server/runtime/invoicePayments.ts` |
| T, C, CL, TSC | `src/tenant/ServerIssuedInvoices.tsx`, `src/tenant/invoiceIssuingClient.ts`, `src/tenant/ServerCustomerLevels.tsx`, `src/tenant/tenantSessionClient.ts` |
| PH, RH, VH, DR | `src/tenant/invoicePaymentHold.ts`, `invoiceReversalHold.ts`, `invoiceVoidHold.ts`, `ServerInvoiceDrafts.tsx` (shared hold store and dialog frame) |
| TEST, BR, ICH | `src/tenant/ServerIssuedInvoices.test.tsx`, `tests/browser/shopRoleLevels.browser.test.mjs`, `tests/db/invoiceCreditNoteHttp.integration.test.mjs` |

**Terms (defined once).**
- *Attempt*: one intent to issue one credit note, named by a client-made UUID `attemptId`.
- *Registration*: the server row binding an attempt to this owner, session, invoice, amount and reason (M38:931-938; D16:342).
- *Proof*: a server-made code that lets the issue use the registration (M38:1101-1104). Memory only, never shown.
- *Hold*: the shop's in-memory record of one live attempt. Its *hold generation* changes only when the hold is replaced or detached, never on a hide or a Check again (a hidden hold keeps its generation, so positive evidence still lifts its blockers, §2.6 item 4).
- *Settlement*: the deliberate end of a registration: version 1 **releases** an unused one, version 2 **confirms** an issued one (D16:335).
- *Stage*: register, proof, issue or settlement. *Stage key*: the idempotency key of one register, issue or settlement; the proof has none.
- *First send*: a stage's first request. *Check again*: a user-pressed replay of a stage with the same key and exact bytes (a re-read for the proof).
- *Unresolved*: the shop cannot tell whether a sent step took effect.

---

## 0. Summary

**Adopted scope (design only).**
1. An "Issue credit note" action in the issued-invoice dialog's Payments section, for the store-scope store owner only.
2. A first send runs register → proof → issue within one press, after a shop-observed sign-in no more than 8 minutes old, with the hold stored before each request leaves.
3. A deliberate "Confirm credit note" press after a successful issue (settlement version 2).
4. Recovery: "Check again" for one stage at a time; it can finish that stage's original request but never runs on into the next stage. A registered attempt that never sent an issue continues only by a "Continue issuing" press under its own eligibility rule (E1-E7, §3.2). Release and recovery are lookup-first (D-P2-16): the normal "Confirm credit note" after the attempt's own issue 201 needs no lookup; otherwise "Confirm credit note" only on an issued lookup row; "Release attempt" only from a current lookup row (current generation and token) last observed as open; a lost settlement reply offers Check again until its limit, then "Look up attempt"; cards in a confirmed no-access state have no buttons; every other card offers "Look up attempt". A missing row stays unresolved while this page keeps the attempt; a reload forgets it (memory only), and an exhausted lookup with no row restores the action as an operational choice (D-P2-5), resolving nothing.
5. Answers are judged as stored definitive, unstored definitive, provisional or stale (§2.6); among non-stale answers for the same hold generation, stage and key, a stored answer wins, in any order, and never starts a later stage. Reads follow latest-request sequencing; a command and its same-key replays are attributed to their live attempt, never superseded by a later send (§3.6).
6. An invoice-level "Credit notes" list inside the Payments section, through the shipped list route.
7. No server, migration, permission or route change.

**Decisions recorded (§7, 2026-11-16).** Part A: the factual corrections are accepted, each for its listed delivery or deferral point (D-P2-11). Part B: option A for D-P2-1, D-P2-2, D-P2-3, D-P2-5, D-P2-6, D-P2-7, D-P2-8, D-P2-9, D-P2-10, D-P2-12, D-P2-13, D-P2-15 and D-P2-16; D-P2-4's wording approved, with exactly three label exceptions (Appendix A); D-P2-14's residual accepted for building and synthetic verification only, with production handling left as an explicit owner decision.

**Not decided here.** The store-wide read's own contract (§4.2 states its needs only). The withdrawal control and its wording (CN-P3). Any legal or tax meaning of a credit note (F-2; D16:42, :696). Refunds. How the cross-owner duplicate residual is handled in production (D-P2-14). Deployment.

---

## 1. Governing contract

### 1.1 Routes CN-P2 uses (SHIPPED)

All are tenant `session` routes with a store-scope permission (RT:4-13, RT:161-391). `…` = `/api/v1/stores/{storeId}/invoices/{id}`.

| Use | Method and path | Key | Recent sign-in (10 min) | CSRF `x-tmpos-session-csrf` | Idempotency-Key | Success body |
|---|---|---|---|---|---|---|
| Register | POST `…/credit-note-registrations` | `issue_invoice_credit_notes` | required (RT:169) | yes | required | 201 `{registration:{id, invoiceId, attemptId, grossCents, reason, state:'open'}}` (RT:157) |
| Proof | GET `…/credit-note-registration-proof?registration=<id>` | `recover_invoice_credit_notes` | none | yes (session-bound read, APP:947-952) | none | 200 `{registration:{id, invoiceId, attemptId}, proof}` (RT:459) |
| Issue | POST `…/credit-notes` | `issue_invoice_credit_notes` | required (RT:227) | yes | required | 201 `{creditNote:{id, invoiceId, attemptId, grossCents, reason}}`, no number (RT:216) |
| Attempts lookup | GET `/api/v1/stores/{storeId}/credit-note-attempts[?after=<invoiceId>.<attemptId>]` | `recover_invoice_credit_notes` | none | yes (APP:947-952) | none | 200 `{attempts, nextCursor}` (RT:541-581) |
| Settlement | POST `…/credit-note-settlement` | `recover_invoice_credit_notes` | none (RT:274) | yes | required | 200 `{settlement:{invoiceId, attemptId, state:'released'\|'confirmed'}}` (RT:262-263) |
| List | GET `…/credit-notes[?after=<creditNoteId>]` | `view_issued_invoices` | none | yes (APP:947-952) | none | 200 `{invoice:{id}, creditNotes, nextCursor}` (RT:706-716) |
| Payments read | GET `…/payments` | `view_issued_invoices` | none | yes (session-bound read, PAY:289-300, :466) | none | `amounts` = `{currency, dueCents, creditedCents, appliedCents, remainingCents}` |

- **Who.** The three credit-note keys go to role `store_owner` at limitation `none` only (PERM:563-565). A `read_only` limitation (read-only or overdue tenant) denies all three, recover included (PERM:555). `view_issued_invoices` survives read-only. ADOPTED as D-CN-7 A (D16:668).
- **Bodies.** Register `{expectedTenant, attemptId, grossCents, reason}`; issue `{expectedTenant, registrationId, attemptId, grossCents, reason, registrationProof}`; settlement `{expectedTenant, attemptId, expectedVersion: 1|2}`. Exact key sets, else 400 (RT:138-151, :196-210, :248-261). Reasons `pricing_error`, `service_issue`, `goodwill`, `billing_error` (RT:48).
- **Sealed vs unsealed.** A sealed answer is stored as the key's completion, body exactly `{"error":"<word>"}` with no `requestId` (IDEM:372-392; body at IDEM:390), and replayed with `Idempotent-Replayed: true` (APP:491-503, :1104) until 24 h after the key's acquisition or last reclaim (IDEM:107; M06:334, :355). An unsealed answer is `{error, requestId}`, records nothing, and the key's 60 s lease must expire before a retry runs (IDEM:107); a retry after that re-runs the command unless the original committed (M06:346-357). Both shapes can carry `write_conflict`: sealed is a state answer; unsealed is a tenant mismatch (PG:168; APP:534-536, :1160). The shop tells them apart by body shape. PROPOSED.
- **Refusal order.** Host (404, APP:861-863) → rate limit (429, Retry-After; APP:871; RL:80; nothing stored) → session (401) → CSRF (403 `forbidden`) → authorization (403 `forbidden`) → step-up (403 `step_up_required`, never a replay) → idempotency acquisition (APP:1102-1104: 409 `request_in_progress`, 422 `idempotency_key_reused`, replay with `Idempotent-Replayed: true`) → routine (APP:861-1228; APP:940-957, :983-986).
- **Routine answers.** Register: sealed 409 `already_issued`, `write_conflict` (an own unsettled registration on this invoice), `invalid_state` (attempt released, or invoice voided). Issue: sealed 409 `already_issued` (M38:1284-1287, :1296-1301; body `{"error":"already_issued"}`, no credit-note id), `write_conflict` (bound values differ), `invalid_state` with exactly two causes, released (M38:1288-1291) checked before voided (M38:1302-1305), and `amount_exceeds_remaining` (M38:1316-1318). Settlement: sealed 409 `write_conflict` when the version does not fit the row (M38:1618-1629); no void check (M38:1582-1677). `not_found` is 404 unsealed. `refused` (incl. a role that is no longer `store_owner`, M38:1202, :1585) and any raise or timeout are 503, unsealed (PG:13-20).
- **Settlement repeats.** A settlement that names the state the row is already in answers 200 `unchanged`: no audit row, no version change, no event (M38:1617-1629; only an applied settlement writes its audit row, M38:1648-1677). This is positive evidence for a lost settlement reply.
- **Release vs a late issue.** Both lock the invoice header first (issue M38:1211-1215; settle M38:1593-1595), then the registration (M38:1229-1235; M38:1601-1605). Release first → the late issue is 404 or sealed `invalid_state`. Issue first → the release is sealed `write_conflict` (M38:1626-1628). So "Release attempt" needs no quiet period.
- **CSRF on reads.** The proof, lookup and list GETs are session-bound and need the CSRF header (RT:387; APP:949-951). The token is an HMAC keyed by the session id (SES:416-417), compared in fixed time with exactly one header line (SES:866-877). Every unsafe method and every session-bound read must carry exactly that session's token, else 403 `forbidden` before authorization (APP:949-951; DA-138; M7A-CUSTOMERS-P5-R1), with the same body as an authorization 403 (APP:448-451). So a 2xx to a lookup or list page answers the session whose token it carried (§3.6). Settlement and withdrawal are not `sessionBinding` routes (no session digest, no check that the registration's session is current) but, as unsafe POSTs, still carry the current session's token (APP:949-951). CN-12 (D16:516) does not limit CSRF to commands, so this is a note, not a disagreement.
- **A seventh route, not used.** `POST …/credit-notes/{creditNoteId}/withdrawal` also ships (RT:12, RT:321-330): recent sign-in, not session-bound. CN-P2 does not call it; CN-P3 owns its control. It can lower `creditedCents` (§3.2, D-P2-15).

### 1.2 Adopted recovery terms (ADOPTED)

- A registration is **released** (unused; version 1) or **confirmed** (issued; version 2). "Withdrawn" is used only for a credit note (D16:335).
- Open and issued hold the slot; released and confirmed are terminal. A missing credit-note row is never terminal (D16:336).
- Proof, lookup and settlement match only the caller's own registrations; two owners of one store cannot see or settle each other's (D16:339).
- An uncertain outcome is never re-sent automatically. "Check again" while a replay is available; otherwise the lookup and a deliberate confirm or release; a missing lookup result stays unresolved; then re-read amounts and the list (D16:272-276; CN-07b, D16:509). This document leaves that text unchanged; D-P2-16 A adds the lost-register-reply case and adopts lookup-first settlement.
- A refused issue leaves the registration open and releasable (D16:347). PROPOSED reading: the server row may be releasable and needs no quiet period (§1.1), but the shop offers Release only from a current lookup row last observed as open (D-P2-16).

### 1.3 The slot rule

- SHIPPED and ADOPTED: an open or issued registration by this owner on this invoice blocks a new registration by the same owner, sealed 409 `write_conflict` (M38:914-919; D16:347). A released attempt id can never be registered again, sealed `invalid_state` (M38:920-925); a new attempt needs a new `attemptId`.
- PROPOSED: the shop therefore asks for a deliberate "Confirm credit note" after every successful issue, before the owner can issue again on that invoice.

### 1.4 The issue 201 carries no number

- SHIPPED and ADOPTED: the issue answer has no number and no tax or net (RT:216; D16:494). Its `creditNote.id` is the credit note's id (RT:204, :216). The list carries `id` and `number`, a positive integer (RT:617). The "CN-" prefix is display-only (D16:667).
- PROPOSED: the shop shows "CN-<n>" only from the list row whose id matches, read after the issue (§4.1).

### 1.5 Disagreements between adopted text and shipped behaviour (resolved in §7)

Resolutions were proposed and are now recorded in §7 (2026-11-16). §7 Part A lists the factual corrections (D-P2-11); Part B names the decision that settles each policy item.

| # | Adopted or documented text | Shipped behaviour or other text | Recommended resolution |
|---|---|---|---|
| DIS-1 | D-CN-12 A: "a per-store credit-activity read is planned for CN-P2" (D16:314; D16:633) | CN-P2 is the shop's issue control and recovery only (D16:307; D16:810; D09:516); no route, key or row defines the read; M38 has no store-wide list but the lookup (M38:1433) | Its own slice, before deployment (§4.2; D-P2-2, D-P2-13) |
| DIS-2 | Eligibility reads are excluded from CN-P1 and assigned nowhere (D16:306; D16:496) | Every other shop action is gated on its own eligibility read answering `allowed` (T:1216-1231, T:1574, T:1889) | An explicit exception: gate on the lookup's 200 (§2.2). False positive: a 200 while the issue is refused → the server refuses and the shop shows that answer. False negative: a lookup 403 or failure while the issue would pass → the action stays hidden; fail-closed (D-P2-3) |
| DIS-3 | P2B Decision 1: a complete lookup may retire a register-stage attempt (D15:764-770), "govern the shop only" (D15:762) | D16:275: a missing lookup result is "never read as 'not issued'" | Do not extend Decision 1 to credit-note attempts (D-P2-5) |
| DIS-4 | Check again within 10 minutes of sign-in (D16:273) | P2B and P2C use 23 hours from first send (D15:758; PH:99-104) | Accept; credit-note constants, not `CHECK_CUTOFF_MS`: 8 minutes for a first send, 9 minutes for a register or issue Check again, 23 hours for a settlement Check again (§2.5, §3.2; D-P2-9) |
| DIS-5 | "Released" for credit-note registrations (D16:335) | P2B's button for the same settlement says "Withdraw attempt" (T:229; D15:758) | Accept; label "Release attempt" (D-P2-4) |
| DIS-6 | The lookup admits read statuses in SQL (M38:1477-1479) | Over HTTP the read-only limitation denies the recover key (PERM:555); residual (a) (D10:1676) | Accept as residual; mutations and the lookup are unavailable (§2.2) |
| DIS-7 | Recovery contract silent on a lost register reply (D16:320-351) | The registration id is only in the register 201; the lookup never returns it (RT:552-553; M38:1496-1497) | Replay first; then the lookup; release only on a row shown open; confirm only on issued; unresolved if absent or incomplete (D-P2-16) |
| DIS-8 | CN-11 and D16:341: a lapsed sign-in is 403 `step_up_required` (D16:515) | True only at the chain (APP:983-986). A lapse inside the routine is `refused` → 503, unsealed, 60 s lease (M38:1255-1265; PG:117, :138; D16:347) | Doc clarification; the shop treats that 503 as unresolved |
| DIS-9 | CN-33: for a non-owner, "a manager's direct DB read included, the name field is absent (not null)" (D16:538) | The routine returns NULL name columns with a visibility flag (M38:1941, :1944, :1961); absence exists only in the HTTP body (RT:705) | Doc correction; no code change |
| DIS-10 | Register binds amount and reason (D16:329) | Register never checks the remaining amount; only the issue does (M38:907-929; M38:1316-1318) | Accept; the shop validates against its last read; a too-large register leaves an open registration to release |
| DIS-11 | ADR-53 #21: "The shop has no issue, withdrawal or recovery control" (D10:1665) | CN-P2 adds issue and recovery | Record at CN-P2 delivery |
| DIS-12 | QA-CN-11: no Issue control seen (D16:738) | CN-P2 adds the control for the owner | Supersede at CN-P2 delivery; CN-27b's word check survives |
| DIS-13 | ADR-53 #16: the withdrawal routine answers `conflict` for a version other than 1 (D10:1658) | HTTP refuses it with 400 before the routine (RT:311) | Doc note; a CN-P3 matter |
| DIS-14 | PG:19-20 comment: withdrawal `invalid_state` covers "a voided invoice" | The routine checks only "already withdrawn" (M38:1784-1788) | Code-comment correction in a later slice; harmless |
| DIS-15 | Runbook: migrations 001-035 (D14:16, :537) | The QA supervisor applies 001-038 | Doc correction in D14 with the CN-P2 QA additions |
| DIS-16 | SII-153b (TEST:5385): no button named `/credit\|withdraw/i` inside Payments ("CN-P1 adds no credit control") | CN-P2 adds "Issue credit note", "Confirm credit note" and "Issue another credit note" there | Narrow supersession of a shipped guard: allow exactly those names; keep `withdraw` banned until CN-P3 (D-P2-4; Appendix A) |

Note, not a disagreement: a staff name over 1,000 characters or with a control character fails the whole list page with 503 (RT:92; RT:609-612); this residual is already adopted (D10:1664; D10:1676 (b)).

---

## 2. Issue control in the existing layout

### 2.1 Placement (PROPOSED)

- "Issue credit note" sits in the issued-invoice dialog's Payments section (`[data-testid="issued-payments"]`, T:3781), in the action row beside "Record payment" (T:4051), with the shared classes `fitsRow`, `waitable` and `actionFit` (T:125-134). No ellipsis, matching "Record payment" (T:192).
- Every new control inside the issued-invoice dialog has a test id starting `issued-payments-`, which the browser's dialog button inventory skips (BR:8266; Appendix A).
- The credit-note card renders inline in Payments while that invoice's dialog is open, and at section level otherwise, as the reversal card does (T:3812-3821; T:2594).
- A reserved-height placeholder keeps the row still while eligibility loads, as the void row does (T:3702-3709; SII-140).
- The capability is a new optional prop of `IssuedInvoiceDialog`, built by `IssuedSection` as `voiding` and `reversing` are (T:2523-2546; T:2926-2957).

### 2.2 Who sees it (PROPOSED; D-P2-3)

No credit-note eligibility read exists (D16:496, ADOPTED). The action is **shown** only when, under the current section generation:
1. The owner's attempts lookup has been read to exhaustion as observed (§3.3 paging): every page answered 200 under one scan generation and context, and a batch ended with `nextCursor: null`. This is an operational gate, not evidence that no attempt exists: a null cursor cannot prove absence (§3.3), and the slot rule is the backstop (M38:914-919). The lookup's key follows the same store-owner rule as the issue key (PERM:563-565), and the database re-checks the role (D16:338).
2. The invoice is issued, not voided.

- From the start of a lookup (on open, after a reload, after a context change) the action stays hidden until that condition holds.
- A 403 from the lookup hides the action and is never retried within the generation (pattern T:1216-1231).
- A failed lookup hides the action and shows lookupFailed with "Try again". A batch that stops at the 20-page cap, or on a 429, 503 or no answer, hides the action and shows lookupIncomplete with "Continue checking", even when no row of this invoice has loaded yet, and still shows every recovery row found so far. Recovery is never hidden for good.
- **Why the lookup.** Holds are memory-only, so after a reload the lookup is the only way to find this owner's unsettled rows on this invoice (§3.6). One read serves both purposes.
- **Residuals, two kinds.** An authorization or session change after the read is answered by the server with 401, 403, or 503 `refused`. An invoice, registration or amount change is answered with sealed 409 `invalid_state`, `write_conflict` or `amount_exceeds_remaining`. The shop shows each answer as §3.1 says. The server decides.
- **Read-only and overdue tenants.** The recover key is denied over HTTP (PERM:555; D10:1676 (a)), so the action, every mutation and the lookup itself ("Look up attempt", "Continue checking") are unavailable; a card for a known attempt stays, without buttons (§3.1, noAccessShort). The list stays readable, with its paging and "Try again". An issued but unconfirmed registration keeps blocking that owner's next registration on that invoice until the tenant can write again. An issued credit note still counts in Credited and Remaining.

### 2.3 Disabled with a reason, and coordination (PROPOSED; D-P2-10)

Hidden is reserved for permission, role, a voided invoice, failed reads and an eligibility lookup not yet complete (§2.2). Blockers the owner can clear make the action `aria-disabled`, with `aria-describedby` naming the blocker (convention T:3963):
- Any nonterminal credit-note registration of this owner on this invoice (open or issued in the lookup), or a live credit-note hold here, hidden or not: registered, issue unresolved, issued but unconfirmed, or awaiting release → blockedOwn.
- Any payment, reversal or void attempt on this invoice that is unresolved, or any attached one of this user anywhere in this tab → blockedSibling. Reason for "anywhere": a credit note starts with a sign-in (§2.5), a sign-in creates a new session (D16:340), and the shop detaches every hold whose token changed (T:803-810).
- `remainingCents` is 0 → blockedRemaining.

The other direction:
- Record payment, Reverse payment and Void are hidden on this invoice while any nonterminal credit-note registration or live hold of this owner exists there, in any of the states above (extends T:3659-3665; T:984-988).
- Void and Reverse, which need a sign-in, are hidden everywhere while a credit-note hold can still Check again or Continue issuing, because their sign-in would detach it (T:1853-1868). This extends R8 (T:1885).
- **Limits.** Only the invoice dialog's own sign-ins are held back. Other shop sign-ins in the same tab still renew the session and detach the hold: the issuing-settings step-up (T:2356-2380) and the customer-levels step-up (CL:94). So does a sign-in in another tab, which replaces the shared session cookie. Holds are per store and per user in one page (DR:533-576). After such a renewal, recovery goes through "Look up attempt"; no data crosses sessions (§3.6). D-P2-10 option C would also disable those two step-ups while a hold can still Check again or Continue issuing.
- Every new rule joins the existing tests SII-252, 259, 260, 261, 269 and 276.

### 2.4 The form (PROPOSED)

- Pressing the action opens an inline form, like Record payment (T:4058-4093): `form noValidate`, legend legend.
- It shows the last-read invoice number, "Invoice total", "Credited", "Recorded" and "Remaining" (shipped labels, T:3785-3802).
- **Amount.** A text input, `inputMode=decimal`, `aria-describedby` naming both amountHint and the field error. Parsed to exact cents by `paymentAmountOf` (C:435-445): digits with at most two decimals; "$" and "," are not accepted (C:155). ADOPTED rule: gross cents, 1 to remaining, no clamping (D16:96, :156, :175).
- **Reason.** A required radio group in a `fieldset` with legend reasonLegend, no default, adopted labels (D16:204); the label is the hit area. No free text (D16:204).
- **Validation on Continue.** Field errors are text tied by `aria-describedby` with `aria-invalid`; one `role="alert"` summary (errSummary) avoids double reading; the first invalid control takes focus; nothing is sent (pattern T:4021-4030).
- **Pre-dialog review.** Continue re-reads the invoice detail, the payments read and the lookup, one review at a time (pattern T:3530-3551). Remaining too low → errOver (focus on the amount); voided → reviewVoided; lookup failed or capped → lookupFailed or lookupIncomplete, form closed; a nonterminal row of this owner on this invoice → unfinished and its card; a context change → the review restarts. The confirmation opens only after an exhausted lookup under the current context with no such row. Continue also reads this invoice's credit-note list to `nextCursor: null` (at most 20 pages, one generation, one view): the D-P2-15 baseline, frozen when the register's first send leaves (§3.2 E4). The confirmation does not wait for this read. A failed, capped or unfinished list read does not block the confirmation (the lookup is the gate, D-P2-3); it only marks the baseline incomplete. The same review, list included, runs after a sign-in (still before any register). When the review runs again later (after a Check again, or in a "Continue issuing" press), its list read goes into a separate current set for display and E4; it never replaces the baseline (§3.2).

### 2.5 Confirmation and recent sign-in (PROPOSED)

- **The confirmation** is an `alertdialog`, `anchor="top"`, `aria-labelledby` title, `aria-describedby` consequence (pattern T:4430-4438), rendered beside the issued-invoice dialog as the reverse confirmation is. Initial focus: "Don't issue". It shows the invoice number, the amount, the reason, the current remaining amount and consequence. ADOPTED meaning: a credit note moves no money and never changes the invoice (D16:81-82; D16:167). "You can't undo it here" is true until CN-P3 ships the withdrawal control.
- **Sign-in rule (D-P2-9).** Register and issue need a sign-in within 10 minutes (RT:169; RT:227; APP:983-986); the shop steps up before registering (D16:340). ADOPTED. The shop cannot read the session's sign-in time (no such field in `src/tenant`); it knows only when its own reauthentication finished. PROPOSED, two windows measured from that time: **every first send of a register or an issue needs a shop-observed sign-in no more than 8 minutes old** (re-use inside the window is allowed); **a Check-again replay of a register or an issue needs one under 9 minutes old**, one minute inside the server's 10 (§3.2). On "Issue credit note" without one, the dialog shows the existing sign-in group (password field with `autocomplete="current-password"` as shipped at T:4475, paste and password managers allowed, or the provider button; "Stop waiting"; one owner at a time; 30 s bound) (T:1841-1880; `VOID_SIGNIN_WAIT_MS`, T:124). Nothing is sent.
- **Cost.** Normally one sign-in per chain when the last one is older than 8 minutes; a second if the owner waits past the window before pressing. The login limit is 5 per account per 5 minutes in every environment (RL:84), so a sixth sign-in within five minutes waits. This binds production.
- **After the sign-in (D-P2-8).** A new session; the view is kept and the §2.4 review re-runs (pattern T:3634-3639). Anything that no longer fits closes the dialog with its reason. The amount and reason stay shown as facts; nothing is sent; a new press is needed. signedIn gives the sign-in time and the send deadline as fixed clock times. Option B clears them, as the reversal does (T:3634; D15:855).
- **Slow reader, before registering only.** If the 8 minutes pass before "Issue credit note" is pressed, the sign-in group returns with signInExpired and the values still shown; one more sign-in continues. Once a registration exists, a passed window cannot be fixed by signing in (a new session cannot use the registration): the card shows continueLapsed with "Look up attempt" (§3.2). No countdown is shown.
- **While sending.** The dialog stays open with sending. "Don't issue" becomes "Close" with closeWarning as its `aria-describedby`; the change is announced once in the dialog's status region. Focus is on the pressed primary button then, not on the relabelled one. Closing never aborts a request (no `AbortSignal`, as T:1982).

### 2.6 First send: register → proof → issue (PROPOSED)

1. Guards set before any await: a pressing ref, the wait, and the hold store's refusal of a second live attempt (DR:546-551; T:978).
2. **Hold invariant (every stage).** Before a request leaves, the hold stores `{stage, key, exact bytes, registrationId (once known)}` plus the sign-in time, the tenant and the store (as shipped holds do, T:1037-1040). After an uncertain answer the shop never rebuilds bytes or mints a replacement key. An attempt has at most one issue key: before any issue send, an atomic compare-and-set moves the hold from "no issue key" to exactly one stored issue key; a second contender (a late proof handler, a "Continue issuing" press) finds the key set and sends nothing. Applying the shipped payment-hold pattern (PH:35-71; T:1011-1019) to a new credit-note hold is proposed.
3. **Continuation.** Register 201 → proof 200 → issue under a new key with exact held bytes, within one press (pattern `runStage`/`sendStage`, T:897-970). A stage's success continues the chain only while its originating press is still the current chain, before that stage's 30 s boundary, and while the attempt was never marked unresolved. After the boundary or any later press, a success only records its state and the card waits for a press ("Continue issuing", §3.2). Before the issue's first send the shop checks the 8-minute window again; if it has passed, the chain stops at registeredOnly with continueLapsed and "Look up attempt".
4. **Evidence classes.** Each answer is judged per live attempt, stage, stage key and context (user, token, store, tenant, invoice):
   - *Stored definitive*: a 2xx whose body is schema-valid and matches the held request (invoice, attempt, registration, amount, reason, settlement state), original or `Idempotent-Replayed` (APP:491-503); any sealed 409 (`{error}` with no `requestId`, original or replayed, IDEM:386-392). Final; among non-stale answers for the same hold generation, stage and key, a stored answer wins. Two stored answers for one key are the same stored completion (M06:341-345); if they differ, the shop fails closed (internalError → "Look up attempt").
   - *Unstored definitive* (register, issue and settlement first sends only): a refusal decided before the key (401 or 403; APP:940-957, :983-986; the key is acquired at APP:1102-1104), or an unsealed 400, 404 or 409 that rolled back (APP:1121-1123; PTS:897-900, :940-942), or a 429 on a first send while no Check again was sent (decided before the key, APP:871). Final **only while no Check again has been sent under that key**; once a replay was sent it is provisional. A non-stale stored answer for the same key overrides it.
   - *Provisional*: 409 `request_in_progress`; a 429 once a Check again was sent under the key; 503; a network error; no answer within 30 s; any non-stored answer to a Check again (400, 401, 403, 404, unsealed 409, 422); an unstored-definitive answer after a replay was sent.
   - *Proof answers* never decide an issue outcome: a schema-valid 200 means "open now, this session" and only lets the chain go on or makes "Continue issuing" available (it satisfies E5 only inside that press, §3.2); a 404 is neutral (cantContinue); anything else is provisional.
   - *Fail closed*: a 2xx that is malformed or does not match the held request, and a 422 on a first send → internalError, nothing advanced or settled.
   - *Stale*: an answer for a detached or hidden-and-replaced hold (an older hold generation); for a stage already settled by a stored answer; or from another context. A stale answer never changes the UI; it may be counted for diagnostics only. An answer for a hidden hold of the current generation still updates its state, so blockers lift on positive evidence, without showing a card.
   - *Forward only.* State moves registered → issued → confirmed, or registered → released (or refused). A late answer for an earlier stage may fill an immutable fact (the registration id) but never moves the state back or restores an action.
   - Accepting a late stored answer never starts a later stage. Accepting an issue 201 records `creditNote.id` (RT:216) and shows issued with "Confirm credit note"; it never sends the confirm.
5. **No answer.** After 30 s without an answer the card shows the stage's unresolved state with Check again. The original request is not aborted; its late answer is judged by item 4; a concurrent same-key request gets `request_in_progress`.
6. **Issued (201).** The dialog closes; the card shows issued, issuedHint, confirmHint and "Confirm credit note". The shop re-reads the payments read and the list; "CN-<n>" appears when the row with `creditNote.id` loads (§4.1).
7. **Confirm.** Settlement version 2 under a new key, held first. 200 ends the attempt; the payments read and the list are re-read.
8. **Amount changed meanwhile.** The server decides: sealed `amount_exceeds_remaining` (M38:1316-1318). The card shows overRemaining with the re-read amounts and offers "Look up attempt"; the open row it shows carries "Release attempt" with releaseHint (lookup-first, D-P2-16). Settlement identifies the row by `attemptId` and the invoice in the path (RT:248-261).

**Focus transitions.**

| From | Event | Focus moves to |
|---|---|---|
| Action | Form opens | Amount input (as T:3994) |
| Continue | Field errors / review fails with errOver | First invalid control / amount input |
| Continue | Confirmation opens | "Don't issue" |
| "Issue credit note" | Sign-in needed | Password field, else the provider button |
| Sign-in | Succeeds | "Don't issue" (facts re-read; signedIn announced) |
| Dialog | Chain answers and the dialog closes | If focus was inside the dialog or lost: the card's heading (`tabindex=-1`). If the user moved focus elsewhere: not moved |
| "Don't issue", Escape | Dialog closes | The action, else the Payments heading `issued-payments-title` (T:3782) |
| Any control | Vanishes while focused | Payments heading (T:3986-3993) |
| "Check again", "Continue issuing", "Issue another credit note" | Pressed (before the card changes) | The card's heading |
| "Continue issuing" finds another note, or can't compare (D-P2-15) | Card shows anotherNoteFound or anotherNoteUnknown | "Look up attempt" |
| "Check again" | Window expires (§3.2) | The card's heading, if the removed button had focus |
| "Show more" | Next page loads | Stays on the button; if the button goes, the first new item (given `tabindex=-1` until blur); if nothing new loaded, the list heading |

Focus never lands on `body`.

**Escape and Close in flight.** They close the dialog and never abort. The section's status region announces closedInFlight; a late outcome is announced through the section regions. Escape during the sign-in wait ends the wait (pattern SII-148).

**Live regions.** The section has an always-mounted pair, mounted empty before any write: `role="status"` (polite) and `role="alert"`. While the confirmation is open it has its own pair, because the page behind is inert (DR:794-799). One announcement per transition, no duplicates; one sending for the whole chain; rateLimited is static text, no ticking.

| Region | Strings |
|---|---|
| status | sending, registeredOnly, issued, confirmed, released, inProgress, signedIn, closedInFlight, checkUntil, the list's "{n} more loaded.", numberPending |
| alert | errSummary, reviewVoided, every refusal string (issueStale, unfinished and the other definitive texts), regUnknown, unresolved, replayGone, cantContinue, alreadyIssued, continueLapsed, continueAfterSignIn, anotherNoteFound, anotherNoteUnknown, settleUnknown, notListed, noAccess, noAccessShort, endedUnknown, internalError, settleNotDone, lookupFailed, lookupIncomplete, signInTimeout, signInExpired, rateLimited, rateLimitedWait |

**Targets.** Buttons and radio labels are at least 24 × 24 CSS px with spacing (`actionFit`; WCAG 2.5.8). "Hide this attempt" is separated from "Check again", and its warning is its `aria-describedby`.

### 2.7 Wording table (PROPOSED; D-P2-4)

The only source of new user-facing strings. All live in one frozen text block beside `VOID_TEXT` (T:326). Text in braces is filled in. Reasons and withdrawal reasons are ADOPTED labels (D16:204; D16:199). One shipped string is reused and included in the scan check: `ISSUED_TEXT.ended` (T:144).

| Key | Exact text |
|---|---|
| action / send | Issue credit note |
| legend | Issue a credit note |
| amountLabel / amountHint | Amount (USD) / Up to {$X} remaining. |
| reasonLegend | Reason |
| reasons | Pricing error / Service issue / Goodwill / Billing error |
| continue / cancel | Continue / Cancel |
| errFormat | Enter an amount in dollars and cents, such as 12.50, without $ or commas. |
| errDecimals | Enter an amount with no more than two decimal places. |
| errZero | Enter an amount of at least $0.01. |
| errOver | The amount can't be more than the {$X} remaining. |
| errReason | Choose a reason. |
| errSummary | Fix the marked fields to continue. |
| reviewVoided | This invoice was voided, so a credit note can't be issued. |
| title | Issue a credit note? |
| consequence | This creates a separate credit note and lowers what the customer owes on this invoice by {$X}. The issued invoice and its total stay the same. It moves no money and returns nothing to the customer. You can't undo it here. |
| keep / close | Don't issue / Close |
| closeWarning | Closing this window doesn't cancel the credit note. It may still be issued. |
| closedInFlight | Closed. The credit note is still being sent. |
| signInNeeded | Issuing a credit note needs a recent sign-in. Sign in again to continue. No credit note has been issued yet. |
| signInTimeout | Sign-in didn't finish within 30 seconds. No credit note has been issued yet. Try again. |
| signedIn | Signed in again at {time}. Check the details, then press Issue credit note below before {time + 8 min}. |
| signInExpired | Your sign-in from {time} is too old to issue now. Sign in again to continue. No credit note has been issued yet. |
| sending | Issuing the credit note… |
| registeredOnly | Registered. No credit note has been issued from this attempt yet. Check the amounts, then press Continue issuing, or look up this attempt to release it. (The words "press Continue issuing, or" appear only when Continue issuing is offered.) |
| continueIssuing / continueHint | Continue issuing / This uses the attempt you already registered. No new attempt is made. |
| continueLapsed | Your sign-in is too old to continue this attempt, and a new sign-in can't use it. Look up this attempt to release it, then start again. |
| continueAfterSignIn | This attempt can't continue after a new sign-in. Look up this attempt to release it, then start again. |
| anotherNoteFound | Credit notes were issued on this invoice since you started this attempt. Check them before you continue. |
| anotherNoteUnknown | We couldn't compare every credit note on this invoice with the list from when you started, so one may have been issued since. Check the list before you continue. |
| issueAnother / anotherHint | Issue another credit note / This issues one more credit note on this invoice. If one of this invoice's credit notes already covers it, look up this attempt to release it instead. |
| regUnknown | No credit note was issued from this attempt. If the lookup finds it open, you can release it here. |
| issued | Credit note issued: {$X}, {Reason}. |
| issuedHint | Confirm it to finish. Until you confirm, you can't issue another credit note on this invoice. |
| confirmHint | The credit note is already issued. Confirming only closes this attempt. It moves no money. |
| numberPending | The credit note number will show here when its row in the list loads. |
| confirm / confirmed | Confirm credit note / Credit note confirmed. |
| release / released | Release attempt / Attempt released. No credit note was issued from it. |
| releaseHint | Release this attempt to free the invoice. Then you can issue a new credit note, for a smaller amount if needed. |
| overRemaining | No credit note was issued: the amount is more than what remains on this invoice now. |
| voided | No credit note was issued: this invoice was voided. |
| attemptReleased | No credit note was issued: this attempt was released. |
| invalidStateUnknown | No credit note was issued from this attempt. The invoice may have been voided, or the attempt released. Look up this attempt. |
| issueStale | Your sign-in was too old, so no credit note was issued. Look up this attempt to release it, then start again. |
| alreadyIssued | A credit note already exists for this attempt. Look up this attempt to confirm it. |
| cantContinue | This attempt can't continue from here. Look up attempt to see what happened. |
| unfinished | You have an unfinished credit note on this invoice. Confirm or release it before you issue another. |
| notAccepted | No credit note was issued: the server did not accept this request. |
| notAllowed | You can't issue credit notes at this store now. No credit note was issued. |
| unresolved | We can't tell whether this credit note was issued. Don't assume it wasn't. Check again, or look up this attempt. (The words "Check again, or" appear only when Check again is offered.) |
| replayGone | We can't check this attempt from this sign-in, so we don't know whether the credit note was issued. Look up this attempt to see. |
| notListed | We can't tell whether this credit note was issued. The lookup didn't find this attempt. Check this invoice's credit notes later. |
| inProgress | This request is still being processed. We don't know the result yet. Check again in a few seconds. |
| rateLimited | Too many tries at once. Wait {n, plural, one {# second} other {# seconds}}, then try again. |
| rateLimitedWait | Too many tries at once. Wait {n, plural, one {# second} other {# seconds}}, then check again. |
| noAccess | Your access to credit notes at this store changed, so you can't finish this attempt. It may already have been issued. Ask an owner to check this invoice's credit notes. |
| noAccessShort | Your access to credit notes at this store changed, so you can't finish this attempt. |
| endedUnknown | You were signed out, so we can't tell whether this credit note was issued. Sign in again, then look up this attempt. |
| ended (shipped `ISSUED_TEXT.ended`, T:144) | Your server session ended. Reconnect to see issued invoices. |
| internalError | Something went wrong with this request, so nothing more was sent. Look up this attempt. |
| settleNotDone | We couldn't confirm that this attempt was finished for this account. Look up this attempt. |
| settleUnknown | We can't tell whether this attempt was finished. Check again, or look up this attempt to see. (The words "Check again, or" appear only when Check again is offered.) |
| lookupFailed / tryAgain | We couldn't check for unfinished credit notes on this invoice, so issuing is off for now. / Try again |
| lookupIncomplete / continueChecking | We haven't checked all your unfinished credit notes yet, so issuing is off for now. / Continue checking |
| find | Look up attempt |
| checkAgain / checkUntil | Check again / You can check again until {time}. |
| checkReplayHint | Sends the same request again. If it wasn't recorded yet, this can finish it. It never starts a new attempt. |
| checkReadHint | Only checks this attempt. It changes nothing. |
| hide | Hide this attempt |
| hideWarning | This only hides it here. It releases nothing, issues nothing and moves no money, and it doesn't tell us whether the credit note was issued. If the attempt is still open, it still blocks your next credit note on this invoice. Check this invoice's credit notes later. |
| row states | Registered, not issued when checked at {time} / Issued, not confirmed / Released / Confirmed |
| blockedOwn | Confirm or release the unfinished credit note below first. |
| blockedSibling | Finish your unfinished payment, reversal or void attempt first. |
| blockedRemaining | Nothing remains to credit on this invoice. |
| list | Credit notes / No credit notes on this invoice. / (owner only, appended) None have been issued yet. / Loading credit notes… / Credit notes couldn't be loaded. / Try again / Show more / {n} more loaded. / Active / Withdrawn / Issued {time} / Withdrawn {time} / Issued by {name} / Withdrawn by {name} / Name not set |
| withdrawal reasons | Entered by mistake / Wrong amount / Wrong invoice |

- Each "Check again" carries checkReplayHint (register, issue, settlement) or checkReadHint (proof) as its `aria-describedby`; "Continue issuing" carries continueHint; "Issue another credit note" carries anotherHint.
- After a first-send 401 that proves nothing ran (no Check again sent under the key), the shop uses ended; endedUnknown is used whenever an issue may have been sent.
- The list's empty texts appear only after the list has been read to `nextCursor: null` under one view (§4.1).
- **Evidence behind "No credit note … issued" (PROPOSED).** Such a text appears only with one of these: (a) a stored refusal of the attempt's one issue key (sealed `amount_exceeds_remaining`, sealed `invalid_state` after a re-read, sealed `write_conflict`), or a refusal decided before that key on its first send while no Check again was sent under it (overRemaining, voided, attemptReleased, invalidStateUnknown, notAccepted, issueStale, notAllowed); (b) this attempt never sent an issue and cannot have created a credit note, because the proof needs the registration id that only this hold has (RT:552-553; M38:1270-1281) and the hold claims one issue key at most (regUnknown, registeredOnly, signInNeeded, signInTimeout, signInExpired, and the register-stage or Continue-issuing uses of notAccepted, notAllowed, voided and overRemaining); (c) a settlement 200 released, since version 1 fits only an unissued row (M38:1618-1636) (released). Evidence (b) speaks for this attempt only: another device or owner may have issued a separate note on the invoice (D-P2-14, D-P2-15). A proof or issue 404, a refused replay and a missing, failed, capped, incomplete or stale lookup prove none of these: cantContinue, replayGone, endedUnknown, noAccess, unresolved, notListed and settleUnknown claim nothing. Each such string speaks about this attempt in its own dialog or card; none claims anything for the whole invoice.
- **Word rules.** CN-27b: no credit-note control text says "Paid", "Unpaid" or "Refunded" (D16:532, ADOPTED). No string says "refund". "Withdraw" and "withdrawn" appear only for credit notes. Appendix A checks every string against the shipped scans for the scope where it renders; one supersession is needed (DIS-16).

---

## 3. Recovery (CN-07b)

### 3.1 Outcome table (PROPOSED display; server answers SHIPPED per §1.1)

"Hold ends" means the attempt is over. Every row that keeps the hold keeps Record payment, Reverse and Void hidden on this invoice. Answers are judged by class (§2.6 item 4). The first-send column applies while no Check again has been sent under the stage key; once one has, every non-stored answer of either send is read from the Check-again column, and stored answers are accepted in either column. A Check-again refusal never ends the hold and no text claims that nothing was issued because of it; at the register and proof stages regUnknown and registeredOnly rest on evidence (b), not on the refusal. A 401 ends the session in the shop (`sessionEndsSoFar`, T:922-928), which detaches the hold: its bytes are gone, the outcome stays as it was; replayGone and continueAfterSignIn describe what can still be done, not whether an issue happened. "Hide this attempt" (D-P2-6) is offered on every card left unresolved or detached; the table names it only where it is the sole action.

| Stage | Answer | First send: shows → actions | Check again: shows → actions |
|---|---|---|---|
| Register | 201 | Continue to proof in the same press (§2.6 item 3); a 201 after the 30 s boundary: registeredOnly | registeredOnly; review (§2.4 incl. the list) → "Continue issuing" (§3.2) or "Look up attempt" |
| Register | sealed 409 `write_conflict` | unfinished; lookup runs → row actions; hold ends | Same |
| Register | sealed 409 `invalid_state` | voided after a re-read; hold ends | Same |
| Register | sealed 409 `already_issued` | Not expected; alreadyIssued → "Look up attempt" → "Confirm credit note" if the row is issued | Same |
| Register | 403 `step_up_required` | signInNeeded; nothing ran; hold ends | regUnknown; replay unavailable → "Look up attempt" |
| Register | 401 | ended; nothing ran; hold ends | regUnknown; detaches → "Look up attempt" after sign-in |
| Register | 403 `forbidden` | notAllowed; hold ends | regUnknown + noAccessShort; no buttons |
| Register | 400, 404, unsealed 409 `write_conflict` | notAccepted; nothing committed; hold ends | regUnknown; hold kept → "Check again" (window) or "Look up attempt" |
| Register | 409 `request_in_progress` | Not expected; inProgress; hold kept; Check again after 5 s | inProgress; 5 s cool-down; the original's answer still counts |
| Register | 422 | Fail closed: internalError; hold kept; nothing under a new key → "Look up attempt" | regUnknown; replay unavailable → "Look up attempt" |
| Register | 429 | rateLimited; hold ends only if no Check again was sent (nothing ran under the key, APP:871); otherwise as a Check again | regUnknown + rateLimitedWait; Check again cools for Retry-After; the original's answer still counts |
| Register | 503 (incl. a role change before the routine, M38:1202), or no answer in 30 s | regUnknown → "Check again" (window) or "Look up attempt" | Same |
| Proof | 200 (valid body) | Continue to issue in the same press, if §2.6 item 3 still holds; else registeredOnly | registeredOnly; review → "Continue issuing" or "Look up attempt" |
| Proof | 404 (one answer for issued, released, renewed session, rotated key and unknown id; M38:1057-1065; RT:456-458) | cantContinue → "Look up attempt" → open: Release; issued: Confirm; terminal: hold ends; missing: the card stays (cantContinue) | Same |
| Proof | 401 | registeredOnly; detaches → after sign-in continueAfterSignIn + "Look up attempt" (§3.2) | Same |
| Proof | 403 | registeredOnly + noAccessShort; no buttons | Same |
| Proof | 503 or no answer | registeredOnly → "Check again" (reads only), "Continue issuing" (§3.2) or "Look up attempt" | Same |
| Issue | 201 (valid body; original or replay, in any order) | issued, issuedHint, confirmHint → "Confirm credit note"; `creditNote.id` held | Same (one transition, one announcement) |
| Issue | sealed 409 `amount_exceeds_remaining` | overRemaining + re-read amounts → "Look up attempt" → the open row's "Release attempt" (releaseHint) | Same |
| Issue | sealed 409 `invalid_state` | Re-read the invoice: voided → voided + "Look up attempt" (a void settles no registration; settlement has no void check, M38:1582-1677); not voided → attemptReleased (the only other cause, M38:1288-1291), hold ends; re-read fails → invalidStateUnknown → "Look up attempt" | Same |
| Issue | sealed 409 `already_issued` | alreadyIssued → "Look up attempt" → "Confirm credit note" if the row is issued (the body has no id, §1.1) | Same |
| Issue | sealed 409 `write_conflict` | Not expected with held bytes; notAccepted → "Look up attempt" | Same |
| Issue | 404 | cantContinue → "Look up attempt" | Same |
| Issue | 403 `step_up_required` | issueStale (decided before the key) → "Look up attempt" | replayGone → "Look up attempt" |
| Issue | 403 `forbidden` | notAllowed + noAccessShort; no buttons | noAccess; no buttons |
| Issue | 401 | ended (decided before the key); detaches → after sign-in "Look up attempt" → per row | endedUnknown; detaches → "Look up attempt" after sign-in |
| Issue | 409 `request_in_progress` | Not expected; inProgress; 5 s; the original's answer still counts | inProgress; 5 s cool-down |
| Issue | 422 | Fail closed: internalError → "Look up attempt" | replayGone → "Look up attempt" |
| Issue | 429 | rateLimitedWait; nothing ran under the key (APP:871), the registration stays open → "Check again" after Retry-After sends the held issue under the same key and exact bytes (a first execution, not a replay; a stored answer still wins) or "Look up attempt" | unresolved + rateLimitedWait; cools for Retry-After |
| Issue | 503 (incl. a sign-in lapse inside the routine, DIS-8, or a role change, M38:1202), or no answer in 30 s | unresolved → "Check again" (window) or "Look up attempt" | Same |
| Confirm / Release | 200 (valid body; incl. `unchanged`, M38:1617-1629) | confirmed / released; re-read; hold ends | Same |
| Confirm / Release | sealed 409 `write_conflict` (version 1 on an issued row, version 2 on an open row, or the other version on a settled row; M38:1618-1629) | Lookup runs → the row's current state and actions | Same |
| Confirm / Release | unsealed 409 `write_conflict` (tenant mismatch; PG:168) | settleNotDone → "Look up attempt" | Same |
| Confirm / Release | 409 `request_in_progress` | inProgress; 5 s cool-down | Same |
| Confirm / Release | 404 | settleUnknown (without Check again) → "Look up attempt" or "Hide this attempt" (D-P2-6) | Same |
| Confirm / Release | 403 | noAccess (or noAccessShort if no issue was sent); no buttons | Same |
| Confirm / Release | 401 | detaches; after sign-in "Look up attempt" → the row's state, or its own action under a new key; a row not listed stays unresolved | Same |
| Confirm / Release | 429 | rateLimitedWait; cools for Retry-After | Same |
| Confirm / Release | 503 or no answer | settleUnknown → "Check again" (same session and held bytes, under 23 h after the key's first send) or "Look up attempt"; past the limit settleUnknown without Check again + "Look up attempt" (§3.2) | Same |

- **Before any issue has been sent, this attempt cannot have created a credit note** (evidence (b), §2.7). The issue needs the proof, and the proof needs the registration id from the register 201 (RT:157; M38:1057-1065; M38:1270-1281), which only this hold has. Register- and proof-stage texts may say so (regUnknown, registeredOnly); this says nothing about notes from other attempts. After a proof or issue 404 the text is still cantContinue. "We can't tell whether this credit note was issued" is used only once an issue has been sent.
- **A lost reply before or after commit looks the same** to the shop; both are unresolved.
- **A 503 lease.** After an unsealed 503 the key's lease lasts 60 s (IDEM:107); an early Check again gets `request_in_progress`; a later one re-runs the command if the original never committed (M06:346-357), so a Check again can finish the original.
- **Access changes.** When a lookup or settlement answers 403, the card stays visible with the attempt's last known status; only the command buttons go.
- **A 403 `forbidden` on a command or the proof** first runs one fresh session check (§3.6 rule 1): a new token detaches the hold (detached texts; "Look up attempt" after sign-in, as after a 401); only the same token leads to the notAllowed, noAccess or noAccessShort shown above.

### 3.2 When "Check again" is offered (PROPOSED)

All must hold:
1. The user presses it. Nothing else sends.
2. Same session token as the attempt: no sign-in, sign-out or store switch since (T:1037-1040; T:803-810). This applies to every stage, settlement included: the shop detaches every hold on a token change, so no bytes remain (DR:537-543; PH:11-12; D15:759). For settlement this is the shop's own rule: the settlement route is not a `sessionBinding` route (its key's fingerprint has no session digest, and nothing checks that the registration's session is current; RT:266-276; APP:1087-1099; IDEM:437-443), though as an unsafe POST it still carries the current session's token (APP:949-951); so the server would replay a same-key settlement from a new session; the shop never sends one.
3. Per stage: register, issue, settlement — the held key and exact bytes are still in memory; proof — the registration id and attempt id only (a keyless GET; nothing is replayed; it only reads).
4. The stage is not in flight, or its first send has waited 30 s without an answer (§2.6).
5. No cool-down: 5 s after `request_in_progress` (`IN_PROGRESS_WAIT_MS`, T:106) at every stage; Retry-After after a 429.
6. Windows and limits, per stage:
   - Register or issue replay: the shop's sign-in record is under **9 minutes** old (§2.5). checkUntil shows the deadline as a clock time. When it passes, the register and issue bytes are scrubbed, the button is replaced by replayGone (or regUnknown at the register stage) through the alert region, and focus moves to the card heading if the button had focus.
   - Proof: none (a read; session binding is its limit: a new session gets 404).
   - Settlement replay: no sign-in requirement (RT:274), but a replay limit: Check again only while less than **23 hours** have passed since that key's first send. Elapsed time is the larger of monotonic and wall-clock time since the first send (as shipped holds measure it, PH:98-103), checked synchronously in the press handler at every replay press; timers only update the display. The same press-time check applies to the 9-minute window. In practice the session ends first (absolute 8 h, idle 30 min, SES:109-110), which detaches the hold, so 23 h is a backstop: a stated UI bound that cannot prove retention at server receipt. If a delayed same-key settlement arrives after expiry, it runs fresh and the domain answer is still safe (`unchanged`, the applied transition, or sealed `write_conflict`). Reason for 23 h: retention is 24 h from acquisition or last reclaim (IDEM:107; M06:330-357); a reclaim happens only while the key is still in progress, with the same fingerprint, after the 60 s lease, and only extends it; acquisition follows the first send, so 23 h stays inside retention with a one-hour margin. After expiry a same-key request is overwritten and runs fresh (M06:330-337; IDEM:89-91): a new command, not a replay, so the shop never presents it as Check again. When the limit passes, the settlement bytes are scrubbed and the card shows settleUnknown with "Look up attempt" (lookup-first, §3.3). checkUntil shows the settlement deadline too.

- **A Check again never runs on into the issue.** After a Check-again register 201 or proof 200 the shop stops at registeredOnly, re-runs the review (invoice detail, payments read, lookup and this invoice's credit-note list into the current set; this attempt's own row exempt, E3), and needs a "Continue issuing" press under the continuation eligibility rule below. Reason, a two-device sequence: on device A the register's first send answers 503 and rolls back; on device B (the same owner, whose slot was then free, or another owner, M38:907-929) a note is registered, issued and confirmed; A presses Check again, and the replay re-runs the register, which now succeeds, so A's row has a `registeredAt` later than B's `issuedAt`. Running on would issue a second credit note for an intent B already met. The review does not prevent that by itself; D-P2-15 compares the list with the baseline read before A's first send and makes continuing after such a note a separate, explicit choice.
- A 403 `step_up_required`, 422, 401 or 429 on a Check again means "replay unavailable" (or "wait"). The shop never offers a sign-in to replay: a new session cannot replay a register or an issue (422; APP:1085-1099; D16:340).
- **After a sign-in**, a lost settlement is recovered lookup-first: "Look up attempt" shows the row; a settled row shows its state and ends the hold; an open or issued row offers its own action; a row the lookup does not list stays unresolved (D16:275). A settlement already in place answers 200 `unchanged`, with no audit row, no version change and no event (M38:1617-1629).
- The 9-minute and 23-hour values are part of D-P2-9. CN-07b's adopted "within the 10-minute sign-in window" is read, as a proposed implementation, as "within the shop's under-nine-minute replay window, a one-minute margin inside the server's ten-minute limit".

#### Continuation eligibility (PROPOSED)

- **Fresh issue never continues an attempt.** "Issue credit note" stays `aria-disabled` (blockedOwn) while this owner has a nonterminal registration on this invoice in the lookup or a live hold here; its review refuses with unfinished when the lookup shows one; the server refuses a second registration (sealed `write_conflict`, M38:914-919). Continuation never relaxes this and never registers.
- **Continuation** is "Continue issuing", or "Issue another credit note" (D-P2-15). A press first runs its review reads (E3), then continues only if all hold, checked in this order inside that press; the first failure stops with its text and no register, issue or settlement is sent (the press's reads may have gone out):
  - **E1 Exact owned open attempt.** The hold is this tab's for the same user, store, tenant and invoice; it holds a registration id and attempt id from a stored register 201; its state is registered; no issue key was ever claimed. In this press's lookup read (E3), this attempt's row is open (lookup `open` = held registered) or not listed (an exhausted-as-observed lookup can skip it; E5's proof decides). A row for this attempt that is issued, released or confirmed ends continuation and shows that state (forward only).
  - **E2 Current session.** `connect()` returns the hold's token; another token detaches the hold (continueAfterSignIn + "Look up attempt").
  - **E3 Current review.** The press's review reads the invoice detail, the payments read, the lookup (full batch rules, §3.3) and the list (into the current set, E4): the invoice is issued, not voided (else voided + "Look up attempt"); the held `grossCents` ≤ `remainingCents` (else overRemaining + "Look up attempt"); the lookup is exhausted as observed (else lookupFailed or lookupIncomplete); any nonterminal row of this owner on this invoice other than this attempt → unfinished, continuation off. The server still decides (sealed `amount_exceeds_remaining`).
  - **E4 Another-note check (D-P2-15)**, below.
  - **E5 Valid proof in this press.** The press sends the proof GET; only a schema-valid 200 naming the held registration id, attempt id and invoice, answered in this press under the same generation and hold generation, counts. A proof 200 from an earlier press, a Check again or a late answer only makes the button available; it never satisfies E5. A proof 404 → cantContinue → "Look up attempt"; a 503 or no answer → registeredOnly stays; a 401 detaches → after sign-in continueAfterSignIn + "Look up attempt"; a 403 → one fresh session check (§3.6 rule 1): a new token detaches, the same token → noAccessShort, no buttons.
  - **E6 Sign-in window.** Shop-observed sign-in ≤ 8 minutes (the first-send rule, §2.5), checked again immediately before the send; else continueLapsed + "Look up attempt". No sign-in is offered: a new session cannot use this registration (proof and issue 404, M38:1057-1065, :1270-1281; D16:341).
  - **E7 One issue key.** The compare-and-set from "no issue key" to one key succeeds in this press (§2.6 item 2); then the hold stores `{stage: issue, key, exact bytes}` and the first send leaves.
- **E4: baseline and comparison (PROPOSED; D-P2-15).**
  - *Baseline.* The §2.4 review reads this invoice's list to `nextCursor: null` (≤ 20 pages, one generation, one view). The baseline is frozen when the register's first send leaves: only pages answered before that moment count, and a page answering later never joins it. The hold stores it: the set of credit-note ids and `complete` (true only if the read had reached `nextCursor: null` under one generation and view by then; false if it failed, capped, hit 429, 503 or no answer, the view or generation changed, or it was still running). The confirmation does not wait for this read. The baseline is never updated afterwards: later review runs (after a Check again, in a continuation press) read the list into a separate `current` set for display and E4, and never replace it. A failed baseline does not block the fresh issue (the lookup is the gate, D-P2-3); it only makes a later continuation conservative.
  - *Comparison.* In the continuation press the list is read to `nextCursor: null` again; new = current ids − baseline ids. Credit notes are never deleted (M38:515); a withdrawn note stays listed with its withdrawal (RT:597), so the set only grows; the comparison also requires baseline ⊆ current, and a baseline id missing from a complete current read → anotherNoteUnknown. A paged read is not a snapshot: a note committed during the read is seen only if it sorts after the cursor. Within one invoice it does (`issued_at` is `clock_timestamp()` taken after the invoice header lock held to commit, M38:1211-1215, :1344; order (issued_at, id), M38:1949-1952), so a complete read finds every note committed before its last page was read; a note committed later is the TOCTOU residual (*Record*), and a database clock step backwards is a residual. The set arithmetic itself needs no order. Above 1,000 notes the 20-page read is capped, so the comparison is always uncertain (new notes sort last): anotherNoteUnknown.
  - *Why not other signals.* `issuedAt` vs `registeredAt` misses the two-device sequence above (B's note is older than A's row, newer than A's intent). `creditedCents` (only in the payments read, PAY:486-492) falls on a withdrawal (the credited sum excludes withdrawn notes, M38:41-43, :689, :2116; the withdrawal route, RT:321-330), identifies no note, and two changes can cancel; no read exposes a count or a per-issue version. Page one alone misses notes on later pages (pages of 50, RT:77-79).
  - *Outcomes.* The card stores what it showed: the ids it listed as new (for anotherNoteUnknown, every id the current read loaded) and whether the comparison was complete. (a) Baseline complete, current complete, every baseline id present, no new id → continue (E5-E7). (b) Baseline complete, new ids observed (current complete or not) → anotherNoteFound listing them (number, amount, reason, time, status: Active, or Withdrawn with its withdrawal time and reason; names for the owner, from the current generation); if the current read is incomplete, the card also states anotherNoteUnknown's uncertainty. (c) Baseline incomplete, or current incomplete with no new id seen → anotherNoteUnknown, with the loaded list in view. In (b) and (c) focus goes to "Look up attempt", "Issue another credit note" (anotherHint) replaces "Continue issuing", and the list's own "Show more" and "Try again" stay. "Issue another credit note" is the owner's explicit choice to continue despite the stated notes or uncertainty. Its press re-runs E1-E3 and E5-E7 and re-reads the list; it sends only if every id outside the baseline that it now sees was shown on the card, and the re-read is at least as complete as the comparison the card showed. A stated uncertainty that persists (the card stated it and the re-read is again incomplete or fails) is the one the owner accepted, so it does not block. If the card stated no uncertainty and the re-read is incomplete, fails, or misses a baseline id, the card switches to state the uncertainty and no issue is sent until another press; a newly seen, unshown id likewise updates the card and no issue is sent until another press. Option B blocks continuing and requires release through the lookup.
  - *Record.* A paged read is not a snapshot (above). The issue body names no expected count or version (RT:196-210), so another owner, or the same owner on another device, can issue after the review and before this issue commits. The normal one-press chain makes no comparison: a note issued by another device or owner between its review and the press (the confirmation can stay open up to 8 minutes) is not caught; D-P2-15 applies only to continuation. Reviewing the list prevents neither; it only shows what existed when read. Both are D-P2-14's residual. The server's only invoice-level backstop is the amount check (sealed `amount_exceeds_remaining`), which stops over-crediting, not duplicates (D-P2-14).

#### Check again and continue, by stage (PROPOSED)

| Stage | What the press sends | Key and bytes | Session | Sign-in window or replay limit | Can it complete the original? | What a success means | Next step |
|---|---|---|---|---|---|---|---|
| Register: Check again | A replay of the held register | Same key, exact bytes | Same | Shop sign-in < 9 min (server 10) | Yes: a 503 original is reclaimed after 60 s and re-runs (M06:346-357), so it may register now | 201 (stored or fresh) = registered, with the registration id; not proof that it is still open | registeredOnly; never continues |
| Proof: Check again | A keyless GET; read only, writes nothing (M38:1115) | None: a keyless read of the held registration id | Same | None (a read; a new session gets 404) | No | 200 = open now, owned, same session, current key generation (M38:1044-1071). A 404 is one answer for issued, released, confirmed, renewed session, rotated key and unknown id (RT:456-458): it proves nothing about an issue | registeredOnly; "Continue issuing" |
| Continue issuing | Per the continuation eligibility rule (E1-E7): review re-reads and the list comparison, a proof GET, then the first send of the attempt's one issue | The issue key, claimed once by compare-and-set (E7; §2.6 item 2), held with its exact bytes before the send | Same as the registration (E2) | Shop sign-in ≤ 8 min (E6, a first send) | Not applicable | Issue 201 = issued | issued → "Confirm credit note" |
| Issue: Check again | A replay of the held issue | Same key, exact bytes | Same | Shop sign-in < 9 min | Yes: if the original never committed, the replay runs it now | 201 with `creditNote.id` = issued; never confirms | "Confirm credit note" |
| Settlement: Check again | A replay of the held settlement | Same key, exact bytes; retained 24 h from acquisition or last reclaim (M06:334, :355) | Same: a shop rule (holds detach on a token change, T:803-810); the server would replay it from another session (APP:1087-1099) | None needed (RT:274); replay limit < 23 h after the key's first send (retention 24 h) | Yes | 200, `unchanged` included = settled | Hold ends |

**Continue issuing (PROPOSED; D-P2-4).**
- Offered and run only under the continuation eligibility rule (E1-E7, above); "Issue another credit note" follows the same rule.
- Precondition failures, all while no issue was ever sent, end with "Look up attempt" (lookup-first, D-P2-16): overRemaining, voided, continueLapsed, continueAfterSignIn, anotherNoteFound, anotherNoteUnknown.
- **After a sign-in on a detached registered card.** The card keeps the attempt id, invoice, tenant, store and last known state, and shows continueAfterSignIn with "Look up attempt", offered only in that store and tenant for the same user (as shipped holds check, T:1037-1040). A detached card is kept and shown only to the same user (holds are per user, DR:533-576; T:1037-1040); for a different user it is not shown and that user's own lookup governs. The open row it shows carries "Release attempt", a fresh settlement under a new key in the current session: settlement matches the owner's row by attempt and has no session or proof check (M38:1601-1605; RT:248-261).
- It never registers and never claims a second issue key. The main "Issue credit note" action stays disabled (blockedOwn) throughout.
- Once an issue has been sent for a registration, the only issue sends are replays of that key ("Check again"); after the replay window, "Look up attempt".

### 3.3 When replay is unavailable: lookup and deliberate settlement

ADOPTED (D16:274-276): the owner uses the lookup, then confirms an issued attempt or releases an unused one; a missing result stays unresolved; then amounts and list are re-read.

SHIPPED: the lookup lists the caller's own registrations at the store: every unsettled one whatever its age, and settled ones for 24 h (M38:1496-1516). Each item is `{invoiceId, invoiceNumber, attemptId, state: open|issued|released|confirmed, version, registeredAt, settledAt, grossCents, reason, creditNote: {id, issuedAt, withdrawnAt} | null}` (RT:466-477). It never returns the registration id (RT:552-553). Settlement names the row by `attemptId` and the invoice in the path, so the missing id only means a lost register reply cannot be matched by id; the `attemptId` still matches it.

PROPOSED mechanics:
- **Paging.** Pages of 50 (RT:80-81), ascending by (registeredAt, invoiceId, attemptId) (M38:1519). The shop reads in batches of at most 20 pages (`LOOKUP_PAGE_CAP`, T:108; ≤ 1,000 rows). A batch ends with `nextCursor: null` (exhausted) or at the cap (incomplete: lookupIncomplete and "Continue checking", which starts the next batch from the last good cursor).
- **One scan generation.** Every page carries the scan generation and a context snapshot (user, token, store, tenant); a page that returns after either changed is discarded before its rows are added. Each page follows §3.6 rules 1-3 (session isolation): a scan generation lives inside one session generation, so one token. A context change discards the whole generation (rows lose their actions) and restarts at page 1. Each page is validated before its cursor is used; a malformed page, or a cursor that repeats or does not advance, → lookupFailed. A 429, 503 or no answer stops the batch as incomplete ("Continue checking" resumes from the last good cursor). A 400 cursor answer (RT:571; M38:1485-1494) restarts once per lookup generation from page 1, discarding all loaded rows and counters; a second → lookupFailed. A 401 or 403 on any page stops the check and removes row actions; rows keep their last known state. Rows keep actions only after a cap or transport stop within the same verified context.
- **Exhausted as observed, not complete.** The lookup takes no lock (a stable read, M38:1453), and `registered_at` is the clock at insert (M38:932), so a registration that commits during a scan with an earlier `registeredAt` than the cursor can be skipped (M38:1517-1518), on this invoice too (an old page's late register, another tab or device). A null cursor therefore cannot prove absence. The backstops are the server's: a new register meets the slot rule (sealed `write_conflict`, M38:914-919) → unfinished → a new lookup; a settlement meets the version check (M38:1618-1629).
- **Rows of this invoice** are those with this invoice's `invoiceId` in this context; `invoiceNumber` is for display only. Per row: open → "Registered, not issued when checked at {time}" + "Release attempt"; issued → "Issued, not confirmed" + "Confirm credit note" (with confirmHint); released or confirmed → the state word, no action, and a held attempt for that row ends.
- Each settlement runs under a new key, held first (pattern T:1095-1140).
- **Aged-out rows.** A row the lookup no longer lists (settled more than 24 h ago) is never settled from memory. A lost settlement reply is recovered by Check again within the 23-hour limit (§3.2), or by a lookup row; a row the lookup does not list stays unresolved while this page keeps the attempt (D16:275), and no settlement is guessed. A reload forgets it (memory only), and an exhausted lookup with no row restores the action as an operational choice (D-P2-5), resolving nothing.
- **A missing, capped, failed or stale lookup decides nothing.** An attempt with an issue sent shows notListed; an earlier one shows regUnknown (evidence (b)).
- **Confirm and Release, by evidence (D-P2-16).** ADOPTED: confirm an issued attempt, release an unused one (D16:274-276; versions D16:335); a refused issue leaves the registration open and releasable (D16:347). PROPOSED (lookup-first):
  - "Confirm credit note" only on the attempt's own issue 201 (original or replay, same hold) or a lookup row in state issued.
  - "Release attempt" only on a lookup row in state open, read in the current generation and token (§3.6 rule 2). Every card that would otherwise release (overRemaining, voided, notAccepted, issueStale, continueLapsed, continueAfterSignIn, anotherNoteFound, anotherNoteUnknown, a detached registered card, the Continue-issuing review failures, the in-chain window lapse) offers "Look up attempt", which reads and shows the row and its action.
  - SHIPPED backstop: version 1 on an issued row, or 2 on an open row, is sealed `write_conflict` (M38:1626-1628), and the lookup decides.
- **Page lifetime (D-P2-5, D-P2-6).** The hold is memory-only, so the unresolved card lasts until "Hide this attempt" or a reload. After a reload, an exhausted lookup with no row for this invoice restores the action. That is an operational choice, not evidence: it claims nothing about earlier attempts, and it is safe only because of the server's backstops: a register that committed late appears as an open row or meets the slot rule (M38:914-919), and an issue needs this session's proof (M38:1270-1281), which only the lost hold had. Because a Check again never runs on (§3.2), absence at the register or proof stage cannot hide an issued credit note from this attempt.
- **Hide this attempt (D-P2-6).** Hides the card only. The hold stays in memory under its generation: stored answers still update its state, so the blockers (blockedOwn; sibling actions hidden) lift on positive evidence (a stored answer, a lookup state or a settlement answer) or a reload. The warning is hideWarning.

### 3.4 Nothing is sent automatically

ADOPTED (D16:272): an uncertain outcome is never re-sent automatically.
PROPOSED rule: no credit-note command or replay starts automatically: not from a timer, focus, visibility, remount, or the arrival of a late answer. The shipped session client's re-sign-in (§3.6) is existing behaviour outside this rule. Mutations and replays start only on presses of "Issue credit note", "Continue issuing", "Issue another credit note", "Check again", "Confirm credit note" and "Release attempt" (pattern T:906-911; SII-168, SII-185, SII-21/37/57). Reads start on dialog open or remount, on "Look up attempt", "Continue checking", "Try again" and "Show more", as re-reads after an answer (the lookup after a sealed `write_conflict`, the invoice after `invalid_state`, payments and list after a success), and as the list's page follows after an issue (§4.1). The hold store's timer only clears bytes (PH:117-127).

### 3.5 Duplicate presses (PROPOSED)

Buttons are `aria-disabled` while in flight, with an sr-only reason (T:3963). The pressing ref is set before any await; the hold is stored before the send; the issue key is claimed by compare-and-set (§2.6 item 2). The server backstop is the slot rule (M38:914-919).

### 3.6 Navigation, reload and late answers

- SHIPPED pattern: holds live in a module-level store, one live attempt per user, memory only (DR:533-576; PH:15); the source forbids browser storage (TEST:1232; TEST:4058).
- PROPOSED for the credit-note hold: closing and reopening the dialog, or switching invoices in the page, keeps the hold. A reload loses it; on open, the lookup finds this owner's unsettled rows for the invoice and shows the card with lookup actions only (no Check again: the bytes are gone).
- Late answers are judged by §2.6 item 4. Every send carries its attempt, stage, stage key, the hold generation and the session generation (`sessionEndsSoFar`; pattern T:922-928). A stale answer changes nothing; a non-stale stored answer that still belongs to the live attempt is accepted, never moves the state back, and never starts a later stage (beyond item 3's in-press chain).

**Sequencing and attribution (PROPOSED).** Reads and commands are matched to their answers differently.
- *Reads: the latest request wins.* Each read kind (list, lookup, payments read, invoice detail) keeps its own request sequence, as the shipped list does (`seq`, T:629; T:1417-1422). The proof is a read too: it keeps a per-attempt sequence, so only the latest proof's answer updates the card, and an earlier press's proof answer is stale. A new request of a kind increments its sequence. An answer applies only while its sequence is still the latest of its kind and its generation number, token, store and `sessionEndsSoFar()` are unchanged (stale test, T:1422, :1443). Paging: "Show more" (and a lookup "Continue checking") sends only from the cursor the shown chain holds, in its own store, generation and ready state (pattern T:1415, which compares the generation number only; credit-note paging also compares the token, rule 2). Its page is appended once (T:1469), and only if that stale test still passes, so no newer request of that kind started meanwhile. A refresh, a reload from page one or a token change starts a new chain, and an older chain's page is dropped, never appended. A superseded read may be aborted (T:1418-1420). The D-P2-15 baseline is the complete read made before the attempt's first send, frozen at that send; a continuation press compares it only with a current read that press sent itself.
- *Commands and their replays: attribution, not sequence.* An original send and every Check again of one stage carry the same stage key and bytes. They are one logical request, so a later send never supersedes an earlier one, and no command is aborted. A command answer belongs to the attempt only while all of these hold: (a) the hold with that attempt id is live in this tab (shown or hidden), in the hold generation recorded at the send; (b) the answer's stage is one this hold sent, and its key is that stage's one key; (c) the request carried the hold's token, `sessionEndsSoFar()` has not moved since the send, and the hold has not detached (adopting another token or a sign-out detaches it, rule 3 below; T:1287); (d) user, store, tenant and invoice equal the hold's. The proof has no key: its answer must also be the attempt's latest proof (above), and it satisfies E5 only inside the press that sent it (§3.2). An answer that belongs is classified by §2.6 item 4; any other answer is stale. So:
  - A provisional answer to a Check again (409 `request_in_progress`, a 429, a 503, a network error) never closes the stage. A later valid stored answer to the original, or to any send under that key, still updates the same live attempt.
  - Once a stored answer has decided a stage, a later provisional answer for that stage is stale: no inProgress, cool-down or rateLimitedWait text. A later stored answer under the same key is first compared with the first one: the same completion → no second transition or announcement; a different one → internalError and "Look up attempt" (fail closed, §2.6 item 4).
  - A detached hold, or one replaced by a newer hold, stays detached. Its late answers, a stored 201 included, change no card; the lookup (after a reload or through "Look up attempt") shows what the server did.
  - Only a first-send success inside its own press's chain, before the stage's 30 s boundary and before any unresolved mark, runs on into the next stage (§2.6 item 3). Any other accepted answer (to a Check again, a late original, an answer after a later press) never starts a later stage; the next stage then starts only on a press.
  - Session handling is separate from the attempt outcome. A 401 or 403 `forbidden` that changes no attempt state (for example, the original's late refusal after a replay's 201) still runs the section's session handling: a 401 signs the section out (T:1474; holds detach, T:1287); a 403 `forbidden` runs the one fresh session check (rule 1), and its result applies (rule 3 or rule 4). The card keeps the decided state as its last known state.
- *Both arrival orders (P2-28).*

| Stage | Arrival order | Result |
|---|---|---|
| Issue | Check again answers 409 in progress or 429, then the original's 201 | issued + "Confirm credit note"; one transition; nothing else sent |
| Issue | The original's 201, then the Check again's 409 or 429 | issued stays; the late answer is stale (no inProgress, cool-down or rateLimitedWait) |
| Register | Check again answers 409 or 429, then the original's 201 | registeredOnly; no proof or issue sent (the chain stopped when the stage became unresolved, §2.6 item 3) |
| Register | The original's 201, then the Check again's 409 or 429 | registeredOnly stays; the late answer is stale |
| Settlement | Check again answers 409 or 429, then the original's 200 | confirmed or released; one transition |
| Settlement | The original's 200, then the Check again's 409 or 429 | the settled state stays; the late answer is stale |
| Issue | The original's 503, then the Check again's 201 | issued + "Confirm credit note" |
| Issue | The original's 201, then the Check again's stored 201 | compared: the same → one transition, one announcement; different → internalError |
| Issue | The Check again's 201, then the original's refusal before the key | issued stays as the attempt's state; 401 → section signed out, the card detached with issued as its last state; 403 `forbidden` → session check: new token → detached, same token → noAccess, no buttons (rule 4); 403 `step_up_required` → no change. Never a "No credit note" text or a Release |
| Any | Either answer after the hold detached or was replaced | no card changes; the lookup explains |
| Any | A late register 201 or proof 200 after issued or released | no state change; no action restored |

- Sign-out, user change and store switch detach the hold (DR:537-543; T:1287; T:1384-1385). A detached card is shown only to the same user (§3.2).

**Session isolation: attribution and no mixing (PROPOSED on SHIPPED contract).** Guarantee: no page, row or name read under one session is combined with or attributed to another. Rows of the old session stay on screen until this tab detects the change (its next read, a focus or visibility re-read, or a press's re-read), then are dropped; requests already sent under the old session may still complete (they belong to it). Immediate cross-tab scrubbing would need an inter-tab signal (for example BroadcastChannel); the shop has none (no BroadcastChannel or `storage` listener in `src/tenant`). That is a client-only addition, not proposed here; it stays a residual. No server change; no blocker.
- *SHIPPED, server.* The session token is an HMAC keyed by the session id (SES:416-417). Every unsafe method and every `sessionBinding: 'required'` read (proof, lookup, list) must carry exactly that session's token, else 403 `forbidden` before authorization (APP:949-951; DA-138; M7A-CUSTOMERS-P5-R1). The other reads CN-P2 uses are bound the same way: the payments read (PAY:289-300, :466) and the issued-invoice reads (`server/runtime/invoiceIssuing.ts:641-650`). So a 2xx to any of them answers the session whose token the request carried, never another session behind the same cookie jar. The 403 body is the same as an authorization 403 (APP:448-451): the shop cannot tell them apart from the body. The server scopes the lookup and settlement to the session's user (M38:1515; M38:1601-1605), and every read to the session's tenant and store; list names follow the caller's role (M38:1924-1925).
- *SHIPPED, shop.* The token comes only from a session read (TSC:301-310, :340-344, :372-379) and lives in memory (TSC:239; per page `gen {n, csrf}`, T:620). Every read calls `connect()` first (it re-reads the session) and runs under the generation captured before it (T:1410-1487). A different token → `adopt`/`begin` → a new generation, every loaded row dropped (T:1233-1253). Pages re-read the session on focus and visibility (T:2419-2428). A 403 → one fresh session check (`recheck`/`denialOf`, T:1299-1321): a new token → a new generation and the denied read dropped silently; the same token → a real denial. Holds keep their token and detach on any other (T:803-810, :928, :1054, :1078).
- *Rules (PROPOSED).*
  1. Every credit-note read (lookup page, list page, payments read, invoice detail) copies the `readList` skeleton exactly: `connect()` first, the generation captured before the send, the answer applied only if the generation, the request sequence, the store and `sessionEndsSoFar()` are unchanged (T:1410-1487). The proof and every command also call `connect()` first and capture the generation and token before the send, but their answers are judged by attempt attribution (above), not by a request sequence. Every credit-note press (Issue credit note, Continue issuing, Issue another credit note, Check again, Confirm credit note, Release attempt) re-reads the session immediately before its send and detaches the hold on a different token. Any 403 `forbidden` from a credit-note command or the proof runs one fresh session check before its text, as the shipped void does (T:1678-1715; `recheck`/`denialOf`, T:1299-1321): a new token → the hold detaches (detached texts; "Look up attempt" after sign-in); the same token → notAllowed, noAccess or noAccessShort as §3.1 says. "Same token" means the token after the check equals the token the request carried, and the hold is still attached; the shipped void's `denialOf(() => false)` reports a denial even after a new token was adopted (T:1311-1317, :1680) and is not copied. Residual: a session switch between the re-read and the send can still let one request leave; the server answers it 403 before any change (APP:949-951). The re-read can also reuse a session read already in flight from before the switch (concurrent `connect()` calls share one pending read, TSC:319-326).
  2. Attribution: rows, names, cursors, the lookup scan generation and the D-P2-15 baseline belong to one generation and one token. For credit-note state, the *current generation* means the same generation number and the same token: `failSession` keeps the number and Reconnect's token is then adopted as a first token, without a new number (T:1296; T:1248-1250), so on any token change the credit-note state is dropped even if the number did not move. Because the server answers a token only for its own session, every row of one generation and token comes from one session.
  3. Discard: on any token adoption (a sign-in or Reconnect in this tab; a focus or pre-read session check that finds another token; the post-403 recheck finding another token), drop every loaded list row and every owner-only name, the lookup rows and their actions, all cursors and the baseline, before any new request; restart from page 1 under the new token. Holds whose token differs detach (unchanged); a detached card keeps its state text and the attempt, but any listed notes and staff names on it are removed. Within one generation, a view change (name keys present vs absent) still drops all and reloads once (§4.1, unchanged). The user's own sign-ins in this tab, `renew` and `renewKeepingView`, move the generation without `begin` (T:1260-1283), and `renewKeepingView` keeps the open dialog (only `renew` closes it, T:1267); the credit-note state must be dropped there by new code, not inherited.
  4. *What clears owner-only names and recovery actions, and when.*
     - *A known session change in this tab* (any token adoption, rule 3, or a sign-out): at once, before any new request, every list row and owner-only name, every lookup row and its actions, the cursors and the baseline are dropped, and every card loses its listed notes and names (anotherNoteFound's list included). Holds of another token detach: a detached card shows only "Look up attempt" and "Hide this attempt", and only to the same user (§3.2); another user sees no card.
     - *Confirmed access loss with the same token* (a demotion or revocation). The session read cannot show it: it identifies the user and the token, not the role (TSC:284-292, :340-344). The first answer in the section that shows it does: a 403 `forbidden` to any read or command of the section (credit-note or shipped, for example the issued list's denied state, T:2848-2855) that the one fresh session check confirms with the same token, **except a 403 from the store-wide credit-activity read of [18](./18-m7b-credit-activity-read-design.md), which clears only its own view unless 18 §8.4 classifies it as a verified store loss (B2), which applies this bullet**; or a credit-note list page with at least one item and no name keys after a named view (an empty page decides nothing). At that answer every owner-only name and every lookup row is dropped, and every card loses its listed notes and names; the list reloads once in the new view, or shows its denied state; the action is hidden; every card keeps its last known state with no buttons (noAccess): no "Confirm credit note", "Release attempt", "Continue issuing", "Issue another credit note", "Check again" or "Look up attempt".
     - *The delay (documented, not closed).* Until this tab detects the change, rows and names already loaded stay on screen. Another tab's session change is detected at this tab's next read, its focus or visibility session re-read, or a press's re-read. The focus re-read does nothing while the tab is hidden, while the void's sign-in wait runs, or without a token (T:2420-2421), and a press's re-read can reuse a read already in flight (rule 1). A same-token demotion is detected only by an answer in the section: the next list or lookup read (dialog open, "Show more", "Try again", a re-read after an answer), another shipped read's confirmed denial, or the next press, whose command is refused 403. Nothing is re-read on a timer. Names shown during the delay were read with the owner's rights in that session; no name read under one session is shown under another.
- *Cases.*
  - **Owner → owner, identical response shapes.** Another tab signs in as a second owner. This tab's next read re-reads the session and finds another identity's session; the session client then signs this tab's own user in again with its own ID token, a new session with a new token (TSC:340-379). Where the shared sign-in provider instead switches this tab's user, AccessContext signs the old session out (`src/context/AccessContext.tsx:176-179`; inference, not run). Either path changes the token, so the rules hold. Existing shop behaviour, outside CN-P2: tabs of two different users take the shared session from each other on each re-sign-in (login limit 5 per 5 minutes, RL:84). The generation moves and everything is dropped; any page sent with the old token under the new cookie gets 403 → recheck → new token → dropped. No row read for the second owner can join the first owner's pages, and names are never carried across.
  - **Owner → non-owner.** When this page's session becomes a non-owner's: same mechanics. If it is another user (a manager), the former owner's cards and holds are not shown at all (holds are per user, §3.2), the lookup answers 403 and the recheck confirms the denial, the action is hidden, and the list reloads in the new view (names absent, or the denied state); no earlier name survives. If it is the same user whose role changed (a demotion, same token), the first credit-note answer that shows it drops every owner-only name and lookup row, and the cards stay with their last known state and no buttons (noAccess, §3.7; rule 4).
  - **Session change while page two is in flight.** The page went out with the old token. Either the server answers it for the old session (consistent with page one; accepted only if this tab has not adopted another token meanwhile, and the next read drops everything), or the server refuses it (a refusal adds no rows; a 401 signs the section out, T:1474, holds detach and Reconnect follows; a 403 runs the session check), or the browser sent the new cookie (403 → recheck → dropped). If the tab adopted a new token while it was in flight, its answer is stale and dropped. Pages are never mixed.
  - **Same user, new session** (a step-up or Reconnect elsewhere). New token → the same drop; holds detach (the D-P2-10 residual stays: detach, not data crossing).
- No new user string: a token change reloads silently (existing loading texts); a confirmed denial uses the existing texts.

**Reload races (PROPOSED; no browser persistence).** The lookup after a reload can run before a request the old page sent commits. Each case ends in a server answer the next lookup explains:
- *Register in flight.* The lookup may not show it, so Issue can be enabled and the owner may register a new attempt. Whichever registration commits second gets sealed `write_conflict` (slot, M38:914-919). If the old one committed first, the new attempt shows unfinished → lookup → old row open → "Release attempt"; the action is then enabled and nothing starts until the owner presses it. The old registration can never be issued: its proof needs the registration id, held only by the registering session's hold, which the reload lost (RT:552-553).
- *Issue in flight.* The fresh lookup shows the row open, and "Release attempt" races the late issue. Both lock the invoice header, then the registration (M38:1211-1215, :1229-1235; M38:1593-1595, :1601-1605). Release first → the late issue is sealed `invalid_state` (M38:1288-1291), or 404 if its session or proof no longer match (M38:1270-1281); no credit note exists from it. Issue first → the release is sealed `write_conflict` (M38:1626-1628) → the lookup shows issued → "Confirm credit note".
- *Settlement in flight.* The fresh lookup shows the old state, and the old page's original and the owner's fresh settlement (new key) race on one row. Two distinct keys asking for the same target, both reaching the row: exactly one applies the transition, with one audit row (M38:1648-1677); the one that finds the row already in that state answers 200 `unchanged`, with no audit row (M38:1617-1629). Original first → the fresh request answers `unchanged`; fresh first → it answers released or confirmed, and the late original answers `unchanged` at the server (its page is gone).
- *Remaining race.* Between the fresh lookup and a late commit the page may show "Registered, not issued when checked at {time}" for a row that becomes issued seconds later. The time qualifier and the server's version check (M38:1626-1628) keep it safe: a release then fails sealed and the lookup shows issued.

### 3.7 Scenario walk-through

| Scenario | What happens | What the owner sees |
|---|---|---|
| Successful issuance | Sign-in (if needed) → register → proof → issue 201 → re-read | issued; "Confirm credit note" → confirmed; the list is followed to the row whose id matches `creditNote.id`, which shows CN-<n> (else numberPending); Credited and Remaining change |
| Definite refusal | e.g. sealed `amount_exceeds_remaining` | overRemaining, re-read amounts, "Look up attempt" → the open row's "Release attempt" |
| Lost reply at register | Unknown whether registered; this attempt cannot have created a credit note | regUnknown; "Check again" within 9 min can finish the register and stops at registeredOnly → "Continue issuing"; else "Look up attempt" → Release if open |
| Lost reply at proof | Registered; this attempt cannot have created a credit note | registeredOnly; "Check again" only reads the proof; "Continue issuing" or "Look up attempt" |
| Window passes before the issue | The proof returns after the 8-minute window | registeredOnly + continueLapsed; "Look up attempt" |
| Lost reply at issue | Unknown whether issued | unresolved; "Check again" within 9 min can finish the issue; else "Look up attempt" → Confirm (issued) or Release (open) |
| Replay waits, original lands | Check again gets 409 `request_in_progress` or 429 and the original's 201 arrives, in either order | issued + "Confirm credit note", one transition; a 409 or 429 arriving after the 201 changes nothing; nothing else is sent |
| Original refused late, replay issued | The first send stalls; Check again commits 201; the stalled original is then refused before the key (401, 403) | issued + "Confirm credit note"; the late refusal is provisional and claims nothing about the issue; a late 401 or 403 `forbidden` still runs the session handling (§3.6), which can leave the issued card detached or with no buttons |
| Another note meanwhile (D-P2-15) | In the "Continue issuing" press, the list holds a note not in the baseline read before this attempt's first send, or the comparison can't be completed | anotherNoteFound with those notes, or anotherNoteUnknown; focus on "Look up attempt"; "Issue another credit note" only as a separate press |
| Lost reply at confirm | Unknown whether settled | "Check again" in the same session, under 23 h after its first send; after a sign-in or past the limit (settleUnknown), "Look up attempt" → the row's state or action; a row not listed stays unresolved |
| Stale sign-in | First-send issue answers 403 before the key | issueStale; "Look up attempt" → the open row's "Release attempt"; a new attempt needs a new sign-in |
| Renewed sign-in | Proof and issue 404; replay 422 | cantContinue or replayGone; "Look up attempt" → Confirm (version 2) or Release (version 1); a registered card shows continueAfterSignIn + "Look up attempt" |
| Revoked access or demoted owner | Lookup and settlement 403; a demotion between the chain and the routine is 503 (M38:1202, :1585) | Card with its last known status and no buttons (noAccess). The 503: at register or proof, regUnknown or registeredOnly; at the issue, unresolved; at a settlement, settleUnknown. Safe: the issue re-checks the role (D16:341) |
| Duplicate presses | One press sends | One request per stage; one issue key; `write_conflict` backstop |
| Competing payment or credit | Remaining falls before the issue | overRemaining; amounts re-read; "Look up attempt" → Release |
| Navigation or reload | Same page keeps the hold; reload loses it; a request in flight may commit after the fresh lookup | After reload: time-qualified lookup rows with Confirm or Release; no Check again; races end in sealed answers the next lookup explains (§3.6) |
| Two owners of one store | Each sees only their own registrations (D16:339) | Neither can clear the other's attempt; their slots are separate. If A's issue reply is lost and B issues for the same intent, two credit notes can exist (D-P2-14) |

---

## 4. Read surfaces

### 4.1 Invoice-level credit-note list (PROPOSED; D-P2-1)

- **Placement and semantics.** A "Credit notes" heading at the section's next heading level, after the payment history and its "Show more" (T:3837-3877); a `ul` with one `li` per credit note.
- **Read.** The shipped list route, key `view_issued_invoices` (RT:74; RT:685). Owners, managers and every reader of issued invoices see it; only the owner sees names (M38:1923-1925).
- **Each item, in this order.**

| Field | Display | Source |
|---|---|---|
| Number | "CN-<n>" | `number` (RT:617; D16:667) |
| Status | "Active" or "Withdrawn", as text, never by colour, strike or icon alone | `withdrawal` null or not |
| Amount | gross, USD | `grossCents` |
| Reason | adopted label | `reason` (D16:204) |
| Time | "Issued {time}" in a `time` element with `datetime` | `issuedAt` |
| Withdrawal | "Withdrawn {time}" and the withdrawal reason label (D16:199) | `withdrawal.withdrawnAt`, `withdrawal.reason` |
| Attribution (owner only) | "Issued by {name}", "Withdrawn by {name}"; `null` → "Name not set"; absent → nothing | `issuedByName`, `withdrawnByName` (RT:704-713; D16:538) |

- Names wrap anywhere (`[overflow-wrap:anywhere]`), up to 1,000 characters.
- **Tax and net.** Not shown (D-P2-7): the split is interim and not a tax record (D16:664; D16:42).
- **Order and paging.** Oldest first by (issuedAt, id), as the server returns (M38:1950-1951); pages of 50 (RT:78-79); `nextCursor` is the last id when more rows exist (RT:715). "Show more" reads the next page; focus stays on it and "{n} more loaded." is announced; if it disappears, focus goes to the first new item (`tabindex=-1` until blur), or to the list heading if nothing was added.
- **Refresh after an issue or Confirm.** The shop holds `creditNote.id` (RT:204, :216). It reloads from page 1 and follows `nextCursor` automatically (reads only) until the row with that id is loaded or `nextCursor` is null, at most 20 pages (1,000 notes) per batch. A new note sorts last: issues serialize on the invoice header (M38:1211-1215) and take `issued_at` after it (M38:1344, :1357). After the cap, "Show more" continues the same target search from its saved cursor. The issued text stays visible throughout. "CN-<n>" shows only from the row whose id matches, never from another row; if the refresh fails or the row is not reached, the card shows issued + numberPending + "Try again", which resumes from the failed page's cursor. A restart from page 1 happens only on a context or view change, or once on a cursor 400 (RT:701).
- **After a release or settlement**: a re-read from page 1.
- **One view per load.** Name visibility is computed per request from the caller's role (M38:1924-1925; RT:701-705). Every loaded page must share the first page's view (name keys present or absent) and context (user, token, store, tenant); otherwise the shop drops every loaded row and reloads from page 1, once; a second mismatch, or a 401 or 403 on any page, shows the error state. Pages are never mixed. A page returning after a change is discarded. Rows, names and cursors belong to one session generation (§3.6 rules 1-3).
- **States.** Loading, empty (the owner also sees "None have been issued yet."; only after a read to `nextCursor: null` under one view), error with "Try again", fail-closed: a failed page never shows partial rows as complete. The empty texts are display states after a complete read, never recovery evidence. The name residual (503 for the whole page) shows the error state.
- **Decoder**, as strict as the payments decoder (C:740-746): exact top-level keys and `invoice.id` equal to the request; exact item keys plus the optional name keys; positive integer `number`; gross = tax + net (RT:618-619); known issue and withdrawal reasons (RT:48, RT:51); names a string or `null` when present, and either every item of a page has the name keys or none; at most 50 items; ascending (issuedAt, id). Across pages: ids unique; strictly ascending across page boundaries; `nextCursor` equal to the page's last id and advancing; a repeated cursor or an empty page with a cursor → error state.
- **Voided invoices.** Shown too (D-P2-12). They can hold only withdrawn credit notes, since a void is refused while one is active (D13:831).
- **Supersedes** QA-CN-11 for the owner (DIS-12).

### 4.2 Store-wide credit activity (PROPOSED; D-P2-2, D-P2-13)

- **Operator task (ADOPTED).** Under D-CN-12 A, the store owner watches credit activity across the store to notice unusual crediting; this is the accepted owner residual under G-OBSERVE (D16:313-314; D16:562).
- **Who, boundary.** The store-scope owner of that store; one store.
- **Records and fields.** Issued and withdrawn credit notes across the store's invoices: number, invoice number, amount, reason, issued and withdrawn times, issuing and withdrawing staff names. Newest first, keyset pagination.
- **No existing read serves it (SHIPPED).** The lookup shows only the caller's own registrations, and settled ones for 24 h (M38:1496-1516). The per-invoice list needs one call per invoice (RT:668-676). 038 has no store-wide list routine but the lookup (M38:1433).
- **What it would take.** A route and key, a new definer routine in a new migration 039, a DA-132 direct-read entry (D10:1674), decoders and tests, and the 038 cutover-style deployment steps (D16 "038 cutover"; D10:1673).
- **Per-invoice inspection is not the across-store control.** Opening invoices one by one does not let an owner notice unusual crediting across a store. Recommendation: build the read in its own slice (D-P2-2) and make it a deployment prerequisite (D-P2-13). CN-P2 can be developed without migration 039, but under D-P2-13 A production deployment of CN-P2 is blocked until that slice passes its gate. Under D-P2-13 B the owner reopens D-CN-12 A and accepts per-invoice watching only.
- **Alternative.** Include it in CN-P2 with migration 039. CN-P2 then needs a migration, server routes, permission entries, a cutover rehearsal and HTTP and DB suites.
- **Decisions, each decidable on its own.** D-P2-2 decides where the read is built, D-P2-13 whether CN-P2 can deploy without it, D-P2-14 how the duplicate risk is handled (a store-wide read detects duplicates after the fact; it does not prevent them). How D-P2-2 and D-P2-13 combine (§7 Part B):

| D-P2-2 | D-P2-13 | Effect |
|---|---|---|
| A | A | Read in its own slice; CN-P2 not deployed to production until that slice passes its gate |
| A | B | Read in its own slice, not a prerequisite; adopted D-CN-12 A reopened (per-invoice watching only until the read ships) |
| B | A | Read inside CN-P2; the prerequisite is met by CN-P2 itself |
| B | B | The read ships inside CN-P2, so there is nothing to reopen: D-CN-12 A stays as adopted and D-P2-13 B has no effect |

**Recorded (2026-11-16): D-P2-2 A and D-P2-13 A**, the first row. The read is built in its own slice, and CN-P2 is not deployed to production until that slice passes its gate. D-P2-14 is independent of both.

---

## 5. Acceptance matrix (PROPOSED; every row PLANNED — NOT RUN)

*(2026-11-18: the rows below keep their adopted, planned text as history. §8.3 maps each row to the evidence in the uncommitted CN-P2 candidate.)*

Layers: component (C; the real section over a fake server), HTTP (H), DB, browser (B; real entry, disposable PostgreSQL), synthetic manual QA (Q; owner-directed, not UAT). Strings are the §2.7 keys. "New support" names harness work the row needs: **F** component fake credit-note routes; **BF** browser credit-note fixture and a durable target; **AG** a browser `ageSession` helper; **S2** a second browser session; **T2** a second page in the same browser context, sharing the cookie jar; **HG** HTTP request gating; **DB1k** a DB seed of ≥ 1,001 registrations; **DB51** a DB seed of 51+ credit notes; **KA** age an idempotency key past retention on the disposable DB; **QF** QA fault kinds; **AX** axe; **TS** a text-spacing style; **—** none.

| ID | Criterion | Expected outcome | Layer(s) | Staging | New support |
|---|---|---|---|---|---|
| CN-07b | Recovery, shop side (D16:509, verbatim) | A reply dropped after COMMIT is settled only by a staff "Check again" (same session, key and bytes, within the 10-minute sign-in window) or, once that is unavailable, the owner's lookup and a deliberate settlement (confirm an issued attempt, release an unused one); a missing lookup result is shown as unresolved, never as "not issued"; nothing re-sends automatically | Component, browser | Shop reading: the window is read per §3.2 as the under-nine-minute replay window (D-P2-9); "staff" is the store-scope owner here (D-CN-7 A). C `'lose'`; B `st.lose(…,'response')` | F, BF |
| CN-27b | Shop wording (D16:532, verbatim) | No credit-note control text says "Paid", "Unpaid" or "Refunded" | Component, browser | Exact pins plus scans | F, BF |
| P2-01 | Owner sees the action | Store-scope owner, issued invoice, exhausted lookup 200, no blocker → enabled | C, B, Q | B `draftShop` owner; Q owner-a | F, BF |
| P2-02 | Other roles never see it | Manager, technician, sales staff: lookup 403 → hidden, no card; not retried | C, B, Q | B SIS-36 pattern | F, BF |
| P2-03 | Read-only or overdue tenant | Action, mutations, "Look up attempt" and "Continue checking" unavailable; a known card stays without buttons; list shown with its paging and "Try again" | C, B | Account-status SQL | F, BF |
| P2-04 | Voided invoice | Hidden; list shown | C, B, Q | Q `inv-voided` | F, BF |
| P2-05 | Disabled with a reason | Remaining 0, own nonterminal row, live or hidden hold (Continue issuing included), sibling attempt → `aria-disabled` with blockedRemaining / blockedOwn / blockedSibling as `aria-describedby` | C, B | — | F, BF |
| P2-06 | Coordination | A nonterminal credit-note registration or hold hides Record, Reverse and Void here (a registered-only attempt included); a hold that can still Check again or Continue issuing hides Void and Reverse everywhere; an attached payment, reversal or void hold anywhere disables Issue | C | Extend SII-252/259-261/269/276 | F |
| P2-07 | Lookup failed, capped or stopped | Hidden from lookup start; lookupFailed / lookupIncomplete shown even with no row loaded; "Continue checking" resumes from the last good cursor; rows keep actions only within the same context; 401/403 removes actions | C | Fake 503; 21 pages | F |
| P2-08 | Form validation | Each error text; `aria-invalid`; amount `aria-describedby` = hint + error; reasons in fieldset/legend; one errSummary alert; focus on first invalid; no request | C, B | `server.sent` empty | F, BF |
| P2-09 | Pre-dialog review | Remaining fell → errOver, focus on amount; voided → reviewVoided; lookup failed or capped → lookupFailed / lookupIncomplete; own nonterminal row → unfinished; no confirmation in any of these | C, B | Mutate fake; B direct HTTP | F, BF |
| P2-10 | Confirmation content | title, consequence (exact), "Don't issue" focused; `aria-labelledby` title, `aria-describedby` consequence | C, B | Exact pins | F, BF |
| P2-11 | Sign-in before register | No shop sign-in ≤ 8 min → sign-in group with signInNeeded; nothing sent | C, B | C `staleLogins`; B `staleOnce` | F, BF |
| P2-12 | After the sign-in | Review re-runs; amount and reason still visible; signedIn with clock times; a new press sends under new keys; `autocomplete="current-password"`; paste and autofill work | C, B | — | F, BF |
| P2-13 | Sign-in wait | 30 s bound; signInTimeout announced; "Stop waiting" and Escape end the wait; nothing sent | C, B | Fake timers; B `idpGate` | F, BF |
| P2-14 | Slow reader, before registering | Window passes before the press → signInExpired, values kept, one more sign-in continues | C | Injected clock | F |
| P2-15 | First-send chain | One register, one proof, one issue in one press; exact bytes; hold holds stage, key, bytes and registration id before each send | C, B, Q | B durable cluster | F, BF |
| P2-16 | Issued and confirmed | issued, issuedHint, confirmHint; "Confirm credit note" → confirmed; payments and list re-read; CN-<n> shown only from the row whose id matches | C, B, Q | — | F, BF |
| P2-17 | `amount_exceeds_remaining` | overRemaining, re-read amounts; "Look up attempt" → open row → "Release attempt" (releaseHint) → released; action enabled again; no "Release attempt" on the card itself | C, B, Q | B second page (SIS-38); Q tab 2 payment | F, BF |
| P2-18 | Issue `invalid_state` (two causes, M38:1289, :1303) | Re-read voided → voided + "Look up attempt" → open row → "Release attempt" → released; not voided → attemptReleased, hold ends; re-read fails → invalidStateUnknown | C, B | B void by direct HTTP; B release by direct HTTP | F, BF |
| P2-19 | Register `write_conflict` | unfinished; lookup row actions | C, B | Seed an open row | F, BF |
| P2-20 | `already_issued` | alreadyIssued; lookup; Confirm only for an issued row | C | Script | F |
| P2-21 | Register first-send answers | With no Check again sent: 401, 403, 400, 404, unsealed 409 end the hold with their text; 429 ends it; 409 in progress keeps it; 422 fails closed (internalError), nothing under a new key | C | Script each | F |
| P2-22 | Lost register reply | regUnknown; Check again replays register only; a 201 → registeredOnly; a replay 400/404/unsealed 409 → regUnknown, hold kept | C, B | C `'lose'`, `'lose-before'` | F, BF |
| P2-23 | Check again never runs on | A Check-again register 201 or proof 200 stops at registeredOnly; review (incl. list) re-runs; an issue is sent only on a press, after the D-P2-15 comparison (E4; P2-86) | C, B | Two-device sequence: register 503, other session issues and confirms, then Check again | F, BF, S2 |
| P2-24 | Lost proof reply | registeredOnly; Check again re-reads the proof (checkReadHint) and stops | C | Script proof 503 | F |
| P2-25 | Lost issue reply | unresolved; Check again (checkReplayHint) replays the issue; one credit note and one audit row in the DB | C, B | B asserts DB rows | F, BF |
| P2-26 | Lost settlement reply | Check again in the same session with held bytes, under 23 h after the key's first send (P2-85); after a sign-in of the same owner: "Look up attempt" → the row's state (hold ends) or its own action; a row not listed stays unresolved; another principal sees no row or action of the former owner | C, B, H | — | F, BF |
| P2-27 | No answer | After 30 s: unresolved with Check again; original not aborted; a concurrent same-key request gets in progress | C | `server.hold` | F |
| P2-28 | Same-key answers are attributed to the live attempt, in both arrival orders, without starting a later stage (§3.6) | Issue: (1) replay 409 in progress, then the original's 201 → issued; (2) the original's 201, then the replay's 409 → issued stays, no inProgress or cool-down; (3) replay 429, then the original's 201 → issued; (4) the original's 201, then the replay's 429 → issued stays, no rateLimitedWait; (5) original 503, then the replay's 201 → issued; (6) original 201, then the replay's stored 201 → compared: the same → one transition, one announcement; a different stored body → internalError, "Look up attempt". Register: (7) replay 409 or 429, then the original's 201 → registeredOnly, no proof or issue sent; (8) the reverse order → registeredOnly stays. Settlement: (9) replay 409 or 429, then the original's 200 → confirmed or released; (10) the reverse order → the settled state stays. (11) issue: first send stalls, Check again commits 201, then the original is refused before the key → issued stays as the attempt's state, no "No credit note" text, no Release; 401 → the section signs out and the card is detached with issued as its last state; 403 `forbidden` → the session check runs: new token → detached, same token → noAccess with no buttons; 403 `step_up_required` → no change; (12) a late register 201 or proof 200 after issued or released → no state change, no action restored; (13) any of these answers after the hold detached (token change) or was replaced → no card changes; the lookup shows the server's state. Never a confirm sent | C | `server.hold` + `release` | F |
| P2-29 | Check again window | Register and issue only (the proof stage has no window): offered under 9 min; checkUntil shows a clock time; on expiry register and issue bytes scrubbed, button replaced by replayGone (or regUnknown) via alert, focus to the card heading if the button had focus | C | Injected clocks | F |
| P2-30 | Same session | After a sign-in, store switch or sign-out: detached; only "Look up attempt" and "Hide this attempt"; a release only from an open row of that lookup, in its own store and tenant, when the same owner signs in again (P2-67); another principal sees no row or action of the former owner | C | C `otherTab`, `expire` | F |
| P2-31 | Check-again gate answers | Issue stage: 401 → endedUnknown, detached; 403 `step_up_required` → replayGone; 403 `forbidden` → one fresh session check first (§3.6 rule 1): a new token → detached, the same token → noAccess, no buttons; 422 → replayGone; 429 → unresolved + rateLimitedWait, Check again after Retry-After. None ends the outcome or claims nothing was issued. Register stage: regUnknown on evidence (b). In progress cools 5 s at every stage incl. settlement; static text | C | Fake timers | F |
| P2-32 | Lookup → Confirm | Issued row (version 2) → confirmHint, Confirm → confirmed; list re-read | C, B, Q | B SIS-28 pattern | F, BF |
| P2-33 | Lookup → Release | Open row (version 1) of the current generation and token → released; a later issue → sealed `invalid_state` (server) | C, B, H | ICH-05/06 cover the server | F, BF |
| P2-34 | Terminal and aged-out rows | A released or confirmed row ends the hold; a row the lookup no longer lists is never settled from memory and stays unresolved while the page keeps the attempt; a reload forgets it (memory only) and an exhausted lookup with no row restores the action as an operational choice (D-P2-5), resolving nothing; nothing guessed | C | — | F |
| P2-35 | Missing row | notListed (issue sent) or regUnknown; nothing settled; lasts until "Hide this attempt" or reload; after reload an exhausted lookup with no row restores the action, claiming nothing | C, B | `'commit-404'`-style | F, BF |
| P2-36 | Renewed session | Proof 404, issue 404 or replay 422 → cantContinue or replayGone → "Look up attempt" → Confirm if version 2, Release if version 1 | C, B | B `endSessions` + Reconnect | F, BF |
| P2-37 | Demoted owner | Lookup or settlement 403 → card with last known status, no buttons, one fresh session check; a demotion before the routine → 503 → per stage as §3.7 | C, B | B `update user_membership` | F, BF |
| P2-38 | Hide this attempt | Hides the card only; action stays disabled and siblings hidden; a stored answer arriving for the hidden hold lifts the blockers without showing a card; hideWarning is its `aria-describedby` | C | Conditional on D-P2-6; `server.hold` | F |
| P2-39 | Duplicate presses | Double click or Enter → one request per stage | C, B | SII-240 / SIS-26 | F, BF |
| P2-40 | Stale answers change nothing | An answer for an older hold generation (hidden and replaced, or detached), another user, token, store, tenant or invoice, an older session generation or another token under the same generation number (401 → Reconnect), or a stage already settled changes no text, focus or action; a Check again never changes the hold generation | C | `server.hold` | F |
| P2-41 | Reload rediscovery | After reload: lookup row → card with Confirm or Release; no mutating request on mount | C, B, Q | New hold store + remount; B `page.goto` | F, BF |
| P2-42 | Competing balance change | Another session's payment or credit lands first → overRemaining; amounts re-read | C, B, Q | B `gate(…,'request')` | F, BF, S2 |
| P2-43 | Nothing sent automatically | Timers, focus, visibility, remount and late answers send no mutation or replay; only the listed reads | C, B | SII-168/185 pattern | F, BF |
| P2-44 | Cross-owner residual made visible | Owner A's issue reply lost, owner B issues for the same intent: two credit notes exist; both show in the list and Remaining (visibility, not prevention; D-P2-14) | B, H | Second store-scope owner (ICH-12 helper) | BF, S2 |
| P2-45 | List fields and semantics | Heading level, `ul`/`li` count, item order, status words present with colour stripped, `time datetime`, reason labels | C, B | Withdrawal by direct HTTP | F, BF |
| P2-46a | Focus: confirmation | Opens on "Don't issue"; Tab stays in the dialog | C, B | SII-54 pattern | F, BF |
| P2-46b | Focus: close | "Don't issue" or Escape → the action, else the Payments heading | C, B | SII-233 pattern | F, BF |
| P2-46c | Focus: sign-in | Password field, else the provider button | C, B | — | F, BF |
| P2-46d | Focus: result | Focus inside the dialog or lost → the card heading; focus moved elsewhere → unchanged; never `body` | C, B | — | F, BF |
| P2-46e | Focus: vanished control | Removed control → Payments heading; removed Check again → card heading | C | SII-160d pattern | F |
| P2-47 | 320 px, 24 px text, text spacing | Form, confirmation, sign-in group, card and list (incl. a 200-character name) at 320 px with 24 px text and the WCAG 1.4.12 override (line-height 1.5, paragraph spacing 2×, letter 0.12 em, word 0.16 em): `scrollWidth ≤ clientWidth`, no clipped consequence, dialog buttons reachable by scrolling, focused element not obscured (2.4.11) | B, Q | B `Page.setFontSizes` + injected style; Q 400 % zoom | BF, TS |
| P2-48 | Payments, reversals, voids unchanged | Existing SII and SIS suites stay green, with DIS-16's narrow supersession only | C, B | Full suites | F, BF |
| P2-49 | No storage | No browser storage, URL or log of keys, bytes or proofs | C | Extend TEST:1232 scan | — |
| P2-50 | Target size | Every button and radio label ≥ 24 × 24 CSS px with spacing at 320 px (`getBoundingClientRect`); "Hide this attempt" separated from "Check again" | B | — | BF |
| P2-51 | Role, name, state | `alertdialog` named and described; `aria-disabled` controls carry a reason; `aria-invalid` on errors | C, B | — | F, BF |
| P2-52 | Automated accessibility scan | An axe run on each state (form, errors, confirmation, sign-in, sending, each card state, list states) reports no violations | B | New; none run for payments (D15:885) | BF, AX |
| P2-53 | Live regions | Region identity and level per state as §2.6; mounted empty before any write; one announcement per transition; no duplicates; one sending per chain; the dialog's own pair while open | C | — | F |
| P2-54 | Escape in flight | At each stage Escape closes and never aborts; closedInFlight announced; the late outcome announced in the section regions | C, B | `server.hold` | F, BF |
| P2-55 | List paging | "Show more" keeps focus, announces "{n} more loaded."; if it disappears focus goes to the first new item (`tabindex=-1`), or the list heading if none | C, B | 51+ notes | F, BF, DB51 |
| P2-56 | Attribution, three cases | Owner + name → "Issued by {name}"; owner + null → "Name not set"; non-owner (absent) → nothing | C, B | B owner SQL sets a name | F, BF |
| P2-57 | List states | Loading, empty (owner variant, only after a read to null), error with Try again; name residual 503 → error | C | Fake | F |
| P2-58 | List refresh | Re-read from page 1 after issue, confirm, release, recovery settlement | C | Count requests | F |
| P2-59 | List decoder | Unknown keys or words, mixed name presence within a page, gross ≠ tax + net, wrong order, wrong invoice id, over 50 items, duplicate ids or backward order across pages, a repeated cursor, an empty page with a cursor → fails closed | C (unit) | — | — |
| P2-60 | Wording | All §2.7 strings pinned exactly; no "Paid", "Unpaid", "Refunded", "refund"; "withdraw" only for credit notes; the Appendix A scan check passes; `FORBIDDEN`, `NOT_SAID` and the Payments scans pass, with only DIS-16's supersession | C, B | Mirror `REVERSE_SAID` (BR:11516) | F, BF |
| P2-61 | Manual screen-reader pass | A screen-reader walk-through of issue, recovery and list in synthetic QA | Q | Requested; G-A11Y | QF |
| P2-62 | Proof 404 wording | A proof 404 (first send, Check again or Continue issuing) → cantContinue → "Look up attempt"; no text says no credit note was issued | C | Script proof 404 | F |
| P2-63 | Refused replay wording | Each Check-again refusal at the issue stage maps as P2-31; at the register stage regUnknown (evidence (b)); B: the session aged past 10 min on the server, Check again → replayGone | C, B | Script each; B ages the session | F, BF, AG |
| P2-64 | Missing, incomplete or stale lookup wording | With an issue sent: notListed or unresolved, never "not issued"; open rows read "Registered, not issued when checked at {time}" | C | Fake: no row; 21 pages; mid-check context change | F |
| P2-65 | Continue issuing allowed | After a Check-again register 201 (or proof 200), E1-E7 all hold → button with continueHint; the press re-reads the review and the list, sends the proof GET, claims one issue key and holds it before the send; never registers; main action stays blockedOwn | C, B | C injected clock; B `st.lose` on register | F, BF |
| P2-66 | Continue issuing blocked by the window | Sign-in over 8 min in this session → continueLapsed + "Look up attempt"; no sign-in offered; no issue sent (the press's reads may have gone out) | C | Injected clock | F |
| P2-67 | Continue issuing blocked after a sign-in | New session of the same owner → continueAfterSignIn + "Look up attempt" in the same store and tenant → open row → "Release attempt" → released; another principal sees no row or action of the former owner | C, B | C new token; B Reconnect | F, BF |
| P2-68 | Continue issuing blocked once an issue was sent | Never offered once the issue key is claimed; only Check again of that key, then "Look up attempt"; one issue key per attempt in the request log | C | `server.hold` | F |
| P2-69 | Continue issuing review failure | Remaining fell → overRemaining + "Look up attempt"; voided → voided + "Look up attempt"; proof 404 → cantContinue; proof 503 or no answer → registeredOnly; 403 → recheck, same token → noAccessShort; in each, no register, issue or settlement is sent (the press's reads may have gone out) | C | Mutate fake | F |
| P2-70 | Reload race: register in flight | Old register held, reload, the lookup shows no row, new register: old first → new sealed `write_conflict` → unfinished → the lookup re-read shows the old row open → "Release attempt" → released → the action is enabled; no new attempt starts unless the owner presses it; new first → old sealed `write_conflict` | C, H | C remount + `server.hold`; H holds the invoice header lock from a SQL client | F, HG |
| P2-71 | Reload race: issue in flight, Release first | Release answers 200 released (required before concluding); the late issue is sealed `invalid_state` (or 404); this attempt issued no credit note (evidence (c)); list and Remaining unchanged | C, H | H gated issue | F, HG |
| P2-72 | Reload race: issue in flight, issue first | Release sealed `write_conflict` → lookup shows issued → Confirm → confirmed | C, H | H gated release | F, HG |
| P2-73 | Reload race: settlement in flight | Fresh lookup shows the old state. Two distinct keys asking for the same target, both reaching the row, in both orders: exactly one applies the transition (one audit event); the one that finds the row already in that state answers 200 `unchanged`. A second fresh request (another new key) for the same target then answers 200 `unchanged`, with no new transition or audit event | C, H, DB (audit count) | H gated settlement | F, HG |
| P2-74 | List: the new note on page 2 | 51+ notes: the refresh follows `nextCursor`, CN-<n> from the row whose id matches; page 2 fails → issued + numberPending + "Try again" resumes from page 2 | C, H | Fake pages; H seed | F, DB51 |
| P2-75 | List: three pages and one view | 101+ notes with the new note last: page 1 followed automatically by pages 2 and 3, three page requests in total; a view or context change between pages → all rows dropped, reload from page 1 once; 401/403 → error; cursor 400 → restart once | C, H | Fake pages; H seed + role change | F, DB51 |
| P2-76 | Lookup over 20 pages | ≥ 1,001 rows: first batch incomplete → lookupIncomplete; "Continue checking" completes; over 40 pages: two continuations; a context change between presses restarts at page 1; one cursor-400 restart per lookup generation; a repeated or non-advancing cursor → lookupFailed | C, H | Fake 41+ pages; H seed | F, DB1k |
| P2-77 | Window lapses inside the chain | Register and proof succeed but the 8-minute window has passed before the issue's first send → registeredOnly + continueLapsed + "Look up attempt"; no issue sent | C | Injected clock | F |
| P2-78 | Late proof vs Continue issuing | A proof times out, the owner presses "Continue issuing", then the first proof's 200 arrives: the late 200 is stale (not the attempt's latest proof, §3.6); only the Continue press's own proof 200 claims the key; exactly one issue key is claimed and one issue sent | C | `server.hold` + `release` | F |
| P2-79 | Another note found (D-P2-15) | The continuation's list read holds a note not in the baseline, here one issued before A's row exists (A's register replayed after B's issue) → anotherNoteFound with the notes and their status (a withdrawn one with its time and reason), focus on "Look up attempt"; "Issue another credit note" sends the issue only on its own press, after E1-E3 and E5-E7 and a list re-read whose ids outside the baseline were all shown on the card | C, B | C list fake; B second session issues | F, BF, S2 |
| P2-80 | List: target beyond 1,000 notes | The refresh stops at 20 pages; "Show more" continues the target search from its cursor; CN-<n> shows when the matching row loads | C | Fake 21+ pages | F |
| P2-81 | Session isolation, owner → owner | A second page in the same browser context signs in as a second owner between list pages one and two (and between lookup pages): this page's next read adopts the new token, or gets 403 → recheck → new generation; every loaded row and name dropped; reload from page 1; no row from the second owner's session ever shown with the first's. C: a Check again or Continue issuing whose send leaves after the other page's sign-in → 403 → recheck → new token → detached, not noAccess; `renew` and `renewKeepingView` drop the credit-note state. H: a request with one session's cookie and another's token → 403 `forbidden`, body identical to an authorization 403. B (also P2-82, P2-83) asserts token-change outcomes (drop, detach, reload), not which user ends signed in. Coverage limit: each layer proves only its own behaviour. If the real browser cannot stage a case (for example, one browser context cannot hold two users stably), the row records that case's browser behaviour as not established; C and H results and the source trace do not stand in for it | C, B, H | Two pages, one cookie jar | F, BF, T2 |
| P2-82 | Session isolation, owner → non-owner | This page's session becomes a manager's (another user): new generation; the former owner's cards and holds are not shown; lookup 403, recheck confirms; action hidden; list reloads without names; no earlier name remains. Same user demoted, same token: before any credit-note answer shows it, the loaded names stay (the documented delay); the first one that does (a 403 to a read or command of the section that the session check confirms with the same token, or a list page with at least one item and no name keys after a named view) drops every owner-only name and lookup row, reloads the list in the new view, hides the action, and leaves each card with no buttons (noAccess) (§3.6 rule 4). Browser coverage limit as P2-81 | C, B | Two pages, one cookie jar; B `update user_membership` for the demotion | F, BF, T2 |
| P2-83 | Session change while page two is in flight | Page two held while the other page switches session; three outcomes: old-session 200 accepted, then everything dropped on the next read; this page adopted first → answer stale, dropped; new cookie → 403 → recheck → dropped; never a mixed list. C: 401 → Reconnect (same generation number, new token) → credit-note state dropped, no row action until a fresh lookup. A 401 on page two signs the section out (T:1474) and the holds detach; Reconnect follows. B: the old-session 200 needs the answer held (`gate(…,'response')`); a request held (`'request'`) and released after the other page's sign-in reaches an ended session and answers 401. Browser coverage limit as P2-81: an outcome the browser gate cannot produce (for example, page two leaving with the new cookie) is recorded as not established in the browser | C, B | C `server.hold`; B holds page two's request or answer with the suite's gate (BR:1519) | F, BF, T2 |
| P2-84 | Continuation eligibility | Each of E1-E7 failing alone shows its text and sends no register, issue or settlement (the press's reads may have gone out); a nonterminal row of this owner on this invoice other than this attempt → unfinished; this attempt's own open or unlisted row passes; a proof 200 from an earlier press does not satisfy E5; H: a forced fresh register while the row is open → sealed `write_conflict` | C, H | Script each | F |
| P2-85 | Settlement replay limit | Check again offered before 23 h after the key's first send (the larger of monotonic and wall-clock elapsed time); at 23 h the bytes are scrubbed → settleUnknown + "Look up attempt"; no same-key send after (request log). A press just after the deadline with the UI timer suppressed → the press-time check refuses, nothing sent. H: a same-key settlement after the key's retention runs fresh → `unchanged` | C, H | Injected monotonic and wall clocks; H ages the key (KA) | F, KA |
| P2-86 | D-P2-15 two-device, note before A's row | A's register first send 503 (rolled back); a second session of the same owner registers, issues and confirms; A's Check again registers → registeredOnly; "Continue issuing" → anotherNoteFound lists that note; no issue sent until "Issue another credit note", whose press then sends exactly one issue when its re-read shows no unshown id. Variant: the second session is another owner | C, B | Two-device sequence | F, BF, S2 |
| P2-87 | D-P2-15 beyond page one | Baseline read with 51+ notes (to `nextCursor: null`), one of them withdrawn afterwards and still listed (not new); the other session's note lands beyond page one → found; a baseline of page one only → anotherNoteUnknown; a baseline id missing from a complete current read → anotherNoteUnknown | C, B | 51+ notes | F, BF, DB51 |
| P2-88 | D-P2-15 incomplete comparison | A failed or capped baseline does not block the fresh issue. Baseline failed (503) or capped (over 1,000 notes), or the current read fails → anotherNoteUnknown, focus "Look up attempt"; "Issue another credit note" re-runs E1-E3 and E5-E7 and re-reads the list: with the stated uncertainty persisting (the re-read again incomplete) and no unshown id, exactly one issue is sent after the press; a newly seen, unshown id → the card updates, no issue sent; an anotherNoteFound card with a complete comparison whose re-read fails or misses a baseline id → the card states the uncertainty, no issue sent until another press | C | Fake 503; 21+ pages | F |
| P2-89 | Lookup-first settlement | No "Release attempt" outside a lookup row of the current generation and token; each former direct-release card shows "Look up attempt" → open row → "Release attempt"; Confirm only after the issue 201 or on an issued row; request log: every first settlement send except the post-201 Confirm follows a lookup read in the same generation and token (a settlement Check again resends that same key and bytes) | C | Request log | F |

**G-A11Y note.** Nothing here is verified with assistive technology; G-A11Y stays OPEN (D08:280). P2-52 and P2-61 are new evidence, not a gate result.

**Cannot be staged with existing harnesses.**

| Gap | Alternative evidence |
|---|---|
| A lost COMMIT acknowledgement inside the server | Clone IIH-07 (`tests/db/invoiceIssueHttp.integration.test.mjs:1420`) into a new ICH case; C and B prove only a lost delivery |
| Truly concurrent credit and payment commits | DB-layer races (CN-01, run in ICR); browser "other session commits first" with `gate(…,'request')` |
| A live sign-in aging past 10 minutes in B or Q | An owner-SQL helper in B copying ICH's `ageSession`; C scripted 403; Q a real wait, recorded as manual |
| Role demotion mid-session in Q | B and H `update user_membership`; C denied sets; Q "not stageable" |
| Credit-note fault injection in Q | New fault kind (below); until then B `st.lose` and Q "not exercised" |
| A named staff member in Q | B owner SQL `update app_user set display_name`; H `displayName` |
| Local clusters are not `fsync`-on, so the proof routine raises (M38:1073) | B on CI's durable service, or the uncommitted `{ durable: true }` overlay, as CN-29 did (D16:724) |
| ≥ 1,001 lookup rows or 51+ credit notes over HTTP | A DB seed fixture (new); the C fake meanwhile; the browser is not required |
| Holding a request at a chosen point over HTTP | ICH has no gating helper; a SQL client holding the invoice header lock (new) |
| Holding a list or lookup page at a chosen point | Those routines take no row lock (M38:1433-1525, :1860-1961), so a held header lock cannot hold them; P2-83 holds page two with the browser suite's gate (BR:1519) or the component fake |
| Two users in one browser context; a page leaving with another session's cookie | T2 (`sameContextTab`, BR:1591-1599) where the browser allows two users in turn. Otherwise that case's browser behaviour is recorded as not established (P2-81 to P2-83); C, H and the source trace stay evidence for their own layers only |

**New harness support, summarized.**
- **F.** The six credit-note routes CN-P2 uses (not the withdrawal route) in the component fake: key ledger by key, store and exact bytes; session-bound proof and issue; sealed answers; lookup and list pages with cursors; settlement `unchanged`; held and released answers for ordering cases. Its defaults answer the lookup 403 and the list with an empty 200, so existing tests keep their control inventories (TEST:2031, :2348, :4883; Appendix A).
- **BF.** A `creditShop` browser fixture and a durable target (CI's service or the overlay).
- **HG.** HTTP request gating for the race rows: a SQL client holding the invoice header lock (`FOR UPDATE`) while a request waits.
- **DB1k, DB51.** HTTP seed fixtures for ≥ 1,001 registrations of one owner and 51+ credit notes on one invoice.
- **S2.** A second browser session of the same owner (or a second owner) for cross-context and competing-change rows.
- **T2.** A second page in the same browser context, sharing the cookie jar, for the session-isolation rows (P2-81 to P2-83); the suite's `sameContextTab` (BR:1591-1599) is the starting point.
- **AG.** A browser `ageSession` helper copied from ICH.
- **KA.** An HTTP/DB helper that ages an idempotency key past retention on the disposable DB, for P2-85's H clause.
- **QF.** A `takeCreditNote` fault kind in `front.mjs` (copy of `takeVoid`), read-only `evidence` queries over `tmpos_invoice_credit_note`, and the D14 runbook update.
- **AX, TS.** An axe run and a text-spacing style in the browser suite.

---

## 6. Implementation handoff (PROPOSED)

| Area | Files | Change |
|---|---|---|
| Shop UI | `src/tenant/ServerIssuedInvoices.tsx` | Action, form, confirmation, sign-in reuse, card (Continue issuing and D-P2-15 included), list, coordination, text block, live regions |
| Shop client | `src/tenant/invoiceIssuingClient.ts` | Route helpers, body builders, exact decoders (register, proof, issue, lookup, settlement, list), cross-page invariants |
| Hold | new `src/tenant/invoiceCreditNoteHold.ts` | Memory-only hold: stage, keys (issue key claimed once by compare-and-set), bytes, registration id, tenant, store, sign-in time, hold generation, evidence per send, the D-P2-15 baseline; register and issue bytes scrubbed at 9 min, settlement bytes 23 h after their first send; detach keeps attempt id, invoice, tenant, store and last known state, never listed notes or staff names |
| Tests | `src/tenant/ServerIssuedInvoices.test.tsx`, `src/tenant/invoiceIssuingClient.test.ts`, `tests/browser/shopRoleLevels.browser.test.mjs`, `tests/db/invoiceCreditNoteHttp.integration.test.mjs` | Fake routes for the six routes CN-P2 uses (not the withdrawal route); rows P2-01…P2-89; DIS-16's narrow supersession of TEST:5385; support F, BF, S2, T2, AG, HG, DB1k, DB51, KA, AX, TS (§5) |
| QA harness | `tests/qa/interactive/front.mjs`, `fixtures.mjs`, `evidence.mjs`; D14 | Fault kind, fixtures, evidence, runbook |
| Records at delivery | D16 §12, D09, D10 (ADR-53 addendum or new ADR) | The approved §7 Part A corrections; the Part B decisions |

- With the recommended scope there is **no server, migration, route or permission change**.
- **Sequencing.** (1) Client decoders and helpers. (2) The hold. (3) The list (read-only, paging and refresh). (4) Issue flow and card. (5) Lookup-first recovery, continuation eligibility (E1-E7) and D-P2-15. (6) Browser rows on a durable target. (7) HTTP seeds, gating and race rows. (8) QA additions and the owner's manual QA. (9) Records. (10) Under D-P2-13 A, production deployment waits for the store-wide read's slice to pass its gate, and for the owner's production decision on D-P2-14.
- **Risks.**
  - The 8- and 9-minute margins rest on the shop's clock; a slow chain can still meet a server 403, shown as replay unavailable.
  - Normally one sign-in per chain, a second if the owner waits past the window; both count against the production login limit of 5 per 5 minutes (RL:84).
  - Other shop sign-ins in the same tab (issuing settings, customer levels) and other tabs still detach a hold (§2.3); no rows or names cross sessions (§3.6).
  - The component is already large; a fourth hold kind adds coordination rules and the evidence classes.
  - Accepting late stored answers means a card can change after the owner moved on; the stale and forward-only rules bound it.
  - CI time is a watched risk (D08:909, :927, :945).
  - The proof needs a durable cluster; local browser runs need the overlay.

---

## 7. Owner decisions (RECORDED 2026-11-16)

The owner recorded these choices on 2026-11-16. They adopt this document as design only.

### Part A — Factual documentation corrections (D-P2-11)

The question was whether to approve the corrections below, as a set or item by item; the recommendation was to approve. **Recorded: accepted, each for its listed delivery or deferral point.** Each lands in the adopted documents at CN-P2 delivery, except DIS-14 (a later slice, tracked separately). DIS-11 and DIS-12 depend on CN-P2 itself and land with its delivery.

| Item | Correction | Lands in |
|---|---|---|
| DIS-6 | The read-only limitation makes credit-note recovery unavailable over HTTP although the SQL lookup admits read statuses; already residual (a) | D10 ADR-53 residual note |
| DIS-8 | A sign-in lapse inside a routine is 503 `refused`, unsealed; only the chain answers 403 `step_up_required` | D16 CN-11, :341 |
| DIS-9 | CN-33: a manager's direct DB read returns NULL name columns with a visibility flag; absence is HTTP-only | D16 CN-33 |
| DIS-10 | Register does not check the remaining amount; the issue does | D16 binding note |
| DIS-11 (lands with CN-P2 delivery) | ADR-53 #21 no longer holds once the control ships | D10 ADR-53 |
| DIS-12 (lands with CN-P2 delivery) | QA-CN-11 superseded for the owner once the control exists; CN-27b survives | D16 QA rows |
| DIS-13 | ADR-53 #16's `conflict` is unreachable over HTTP (400 first) | D10 ADR-53 (CN-P3 matter) |
| DIS-14 (deferred) | The adapter comment's withdrawal `invalid_state` does not cover a voided invoice | PG:19-20 in a later slice, tracked separately |
| DIS-15 | The runbook lists 001-035 (D14:16, :537); QA applies 001-038 | D14 |
| DIS-1 to DIS-5, DIS-7, DIS-16 | Policy items (Part B) | D-P2-2/13, D-P2-3, D-P2-5, D-P2-9, D-P2-4, D-P2-16 |

### Part B — Policy and scope decisions

Each row was decided on its own; the last column records the choice. How D-P2-2 and D-P2-13 combine: the table in §4.2; D-P2-14 is independent of both.

| ID | Question | Options | Recommendation | Effect | Adopted text changed | Recorded (2026-11-16) |
|---|---|---|---|---|---|---|
| D-P2-1 | Invoice-level list in CN-P2? | A include; B defer | **A (recommended include)** | The number shows after an issue; CN-33's "Name not set" gets its surface (D16:721) | None | **A** |
| D-P2-2 | The store-wide activity read (DIS-1) | A defer it to its own slice; B build it in CN-P2 with migration 039 | **A**, as an explicit decision | CN-P2 stays shop-only. Decided on its own: this decides where the read is built, not whether CN-P2 can deploy without it (combinations with D-P2-13: §4.2) | D-CN-12 A's "planned for CN-P2" (D16:314, :633) moves to the new slice | **A** |
| D-P2-3 | Visibility gate (DIS-2) | A an exhausted lookup 200 under one scan generation (batches of 20 pages; else hidden with lookupFailed or lookupIncomplete and "Continue checking"), plus an issued invoice; B a new eligibility read (server change); C show to all and let the server refuse | **A** | No server change; an explicit exception to the eligibility-read pattern; operational, not evidence | None; recorded with the delivery | **A** |
| D-P2-4 | Wording (DIS-5, DIS-16) | Approve the §2.7 table, incl. "Issue credit note", "Don't issue", "Continue issuing", "Issue another credit note", "Look up attempt", "Confirm credit note" with confirmHint, "Release attempt", "Hide this attempt", and the Check-again hints | **Approve** | "Released" stays the attempt word; "withdraw" stays for credit notes (D16:335) | None adopted; shipped guard superseded: TEST:5385 (SII-153b), narrowly | **Approved** after the consistency check, with exactly three label exceptions: "Issue credit note", "Issue another credit note", "Confirm credit note" (Appendix A) |
| D-P2-5 | P2B Decision 1 (DIS-3) | A do not extend it to credit-note attempts; B extend it to register- and proof-stage attempts | **A** | Follows D16:275. With a Check again that never runs on, register- and proof-stage absence cannot hide an issued note from that attempt, so A costs only a card that lasts until hidden or reloaded | None | **A** |
| D-P2-6 | "Hide this attempt" | A offer it with hideWarning; it hides the card only, blockers stay until positive evidence or reload; B no such action | **A** | Matches P2B and P2C's Dismiss; a reload has the same effect | None | **A** |
| D-P2-7 | Tax and net | A not shown; B shown | **A** | The split is interim (D16:664) | None | **A** |
| D-P2-8 | Values after a sign-in | A keep amount and reason, require a new press; B clear them (D15:855) | **A** | No re-entry (WCAG 3.3.7 redundant entry); still no send without a new press | None | **A** |
| D-P2-9 | Sign-in windows and replay limits (DIS-4) | A every register or issue first send (Continue issuing included) needs a shop-observed sign-in no more than 8 minutes old; Check again of a register or issue under 9 minutes; Check again of a settlement only under 23 hours after its key's first send (retention 24 h), then settleUnknown and the lookup; B send first and sign in only after a 403 | **A** | The shop knows its window and never presents a fresh run as a replay. Cost: normally one sign-in per chain, under the production login limit (RL:84) | None; CN-07b's window is read as the 9-minute margin | **A** |
| D-P2-10 | Other attempts | A in this tab: disable Issue while any attached payment, reversal or void attempt exists, and hide Void and Reverse everywhere while a credit-note hold can still Check again or Continue issuing; B no extra rule; C as A, and also disable the issuing-settings and customer-levels step-ups meanwhile | **A** | The invoice dialog's own sign-ins never cost a credit-note attempt its recovery. Residual: other shop sign-ins and other tabs still detach holds; no rows or names cross sessions (§3.6); recovery then goes through the lookup | None | **A** |
| D-P2-12 | List on a voided invoice | A show; B hide | **A** | Withdrawn notes stay visible | None | **A** |
| D-P2-13 | Store-wide activity read before deployment (B reopens adopted D-CN-12 A) | A make it a deployment prerequisite: CN-P2 is not deployed to production until the store-wide read passes its gate (in its own slice under D-P2-2 A, or inside CN-P2 under D-P2-2 B); B reopen D-CN-12 A and accept per-invoice watching only | **A**, as an explicit decision | Per-invoice inspection is not the across-store control the residual relies on. Decided on its own; combinations with D-P2-2: §4.2 | The G-OBSERVE owner residual (D16:562) gains a deployment prerequisite | **A** |
| D-P2-14 | Cross-owner duplicate issuance | A accept the risk explicitly: two owners of one store can issue two notes for one intent; the customer's owed amount is then lowered twice, and the shop cannot withdraw the extra note until CN-P3. Operating rule: one owner issues credit notes per invoice and checks the list first. The list and Remaining show both notes: detection, not prevention. B make a store- or invoice-wide guard (server change, separate slice) a deployment prerequisite | **Accept the residual for building and synthetic verification only.** Production handling, A or B, stays an explicit owner decision before production deployment | Not a blocker of the shop design. Independent of D-P2-2 and D-P2-13: a store-wide read detects duplicates after the fact; it does not prevent them | A named residual added to ADR-53's list (D10) | **Residual accepted for building and synthetic verification only.** Production handling stays an explicit owner decision |
| D-P2-15 | Before an attempt continues: notes not in the list read before the attempt began, or a comparison that can't be completed | A show them or the uncertainty (anotherNoteFound, anotherNoteUnknown) and require a separate "Issue another credit note" press, focus on "Look up attempt"; B block continuing and require release through the lookup | **A** | Detection at the decision point, not prevention: a set comparison against a pre-attempt baseline (§3.2 E4) catches a note issued before this attempt's row exists; another note can still be issued after the review (D-P2-14) | None | **A** |
| D-P2-16 | Settlement and recovery rules beyond D16:272-276 (DIS-7) | A (lookup-first, §3.3): "Confirm credit note" only on the attempt's own issue 201 or an issued lookup row; "Release attempt" only on an open lookup row read in the current generation and token; every other card offers "Look up attempt", except a confirmed no-access card, which has no buttons (§3.6 rule 4); a lost register reply is recovered by Check again, then "Continue issuing" or the lookup. B direct release (revision 4): A, plus "Release attempt" directly on a stored issue refusal, an unstored first-send refusal with no Check again sent, or a Continue-issuing precondition failure | **A (recommended for this slice)** | One more read and press before a release; every release acts on a state the server reported in this session; fewer evidence cases to build and test; the version check stays the backstop | D16's recovery contract gains the lost-register-reply case; D16:274-276 unchanged | **A** |

### Adoption record (2026-11-16)

- **Decision IDs.** D-P2-11 accepted (Part A). Option A for D-P2-1, D-P2-2, D-P2-3, D-P2-5, D-P2-6, D-P2-7, D-P2-8, D-P2-9, D-P2-10, D-P2-12, D-P2-13, D-P2-15 and D-P2-16. D-P2-4 approved with the three exact label exceptions. D-P2-14 accepted for building and synthetic verification only.
- **Adopted scope (design only).** §0's scope. The invoice-level list is in CN-P2. The store-wide activity read is a separate slice and a deployment prerequisite for CN-P2. Withdrawal is CN-P3. No server, migration, route or permission change.
- **Not authorized by this adoption.** Implementation, push, CI, deployment and managed migrations. Each needs separate approval.
- **Remaining evidence.** Every §5 row is PLANNED — NOT RUN. P2-81 to P2-83 stay planned browser evidence; a source trace, a component fake or an HTTP test does not establish the browser behaviour, and any case the real browser cannot stage is recorded as such. Screen-reader confirmation of the live regions (P2-61) and G-A11Y (OPEN) remain. Browser rows need a durable target (§5). The owner's synthetic manual QA follows implementation.
- **Production decisions still open.** How the cross-owner duplicate residual is handled in production (D-P2-14: accept it for production, or a store- or invoice-wide guard as a deployment prerequisite). Production deployment of CN-P2 itself, which waits for the store-wide read's slice to pass its gate (D-P2-13 A). Gate statuses are unchanged: ICH-11 UNVERIFIED, CN-38 a deployment prerequisite, G-APPSEC PARTIAL and production-blocking, F-2 and F-5 missing inputs.

---

## 8. CN-P2 delivery record (uncommitted candidate; recorded 2026-11-18)

The three statuses are kept apart:

| Status | Where it stands |
|---|---|
| Development | Implemented in code in an uncommitted local candidate (§8.1). No commit and no CI run. Not complete: the last full local green run was on an earlier tree (§8.4), and §8.6 names the test work that remains |
| QA | Deferred by the owner on 2026-11-18, until development across all phases is finished (§8.5) |
| Release | Not authorized (§8.7) |

### 8.1 What was built, and where

- **Authorization.** On 2026-11-16 the owner authorized local implementation and verification of CN-P2 in an isolated candidate worktree based on `eb10f4c21e289d6d88359f429661c4cf5b958c51`, left uncommitted. No commit, push, CI run, deployment or managed migration was authorized, and none was made.
- **The candidate.** 17 modified tracked files and 2 new files, all uncommitted. Its fingerprint, computed before this record's documentation edits and before the 2026-11-18 additions to `src/tenant/ServerIssuedInvoices.test.tsx` (seven component tests, written and never run, §8.3), by the hand-off method (`git diff --binary eb10f4c`, then each untracked source file as `== path` and its content), is `39911874f063abaea46ef90f4ed0a9d9832506720acfaa711b937fb75289e9ea`; the Git-independent content fingerprint of the same 19 files is `1616e86398091faf83bda61a683386d124e0d3244861b9aea349184a8b1cef32`. This is therefore the fingerprint of the candidate before the 2026-11-18 test and documentation additions, not of the final tree. The test additions and the documentation edits both change the first value when included, and the second value no longer matches the 19 files either. No fingerprint has been recomputed for the final tree, and none is recorded here.
- **Shop code** (the only production code changed):
  - `src/tenant/ServerIssuedInvoices.tsx`: the "Issue credit note" action, form and confirmation with a recent sign-in; the result card with Check again, Continue issuing, Issue another credit note, Look up attempt, Confirm credit note, Release attempt and Hide this attempt; the invoice-level credit-note list; coordination with payment, reversal and void attempts (D-P2-10 A); the §2.7 wording as one frozen block; the live regions.
  - `src/tenant/invoiceIssuingClient.ts`: the route helpers, body builders and exact decoders for register, proof, issue, lookup, settlement and list.
  - `src/tenant/invoiceCreditNoteHold.ts` (new): the memory-only hold, with the D-P2-9 A windows (8 minutes for a first send, 9 minutes for a register or issue Check again, 23 hours for a settlement Check again).
  - `src/tenant/ServerInvoiceDrafts.tsx`: the shared dialog frame (§8.2, item 1).
- **Unchanged.** No server, migration, route, permission, CI workflow, package or lockfile file changed. Product behaviour changed in shop code only; the test, test-runner (`scripts/run-*.mjs` case floors) and QA-harness (`tests/qa/interactive`) paths changed too. The withdrawal route is not used.
- **Tests.** `src/tenant/ServerIssuedInvoices.test.tsx` (rows named by their §5 id), `src/tenant/invoiceIssuingClient.test.ts` (IIC-51 to IIC-60), `src/tenant/invoiceCreditNoteHold.test.tsx` (new; CNH-01 to CNH-14), `tests/db/invoiceCreditNoteHttp.integration.test.mjs` (ICH-12 to ICH-22), `tests/browser/shopRoleLevels.browser.test.mjs` (SCN-01 to SCN-22, and DIS-16's narrow supersession of SII-153b), `tests/quality/qaInteractiveFront.test.mjs`.
- **Runners.** `scripts/run-frontend-tests.mjs` makes the hold suite required and sets its floors to 31 files and 1,543 cases; `scripts/run-tests.mjs` adds the hold suite as a sentinel; `tests/quality/run-frontend-tests-contract.test.mjs` pins both. Without them a missing or skipped hold suite would pass both lanes.
- **QA harness.** `tests/qa/interactive/cli.mjs`, `evidence.mjs`, `fixtures.mjs`, `front.mjs` and `supervisor.mjs`: the `held-credit-note` fault, the `inv-credit` and `inv-credit-list` fixtures, and the credit-note evidence (runbook [14](./14-interactive-qa-runbook.md) §2.4, §3.2 and §6).
- **Not part of the candidate.** The QA-only overlay used for the QA runs (`durable: true` for the QA cluster and the seeder's retry of a `rate_limit_timeout`, in `tests/qa/interactive`) is not in the candidate and is never committed with it.
- **Part A corrections (D-P2-11), landed with this record.** DIS-8, DIS-9, DIS-10 and DIS-12 in [16](./16-m7b-invoice-credit-note-decision-pack.md); DIS-6, DIS-11 and DIS-13 in [10](./10-architecture-decision-records.md) ADR-53; DIS-15 in [14](./14-interactive-qa-runbook.md). DIS-14 stays deferred to a later slice. The Part B decisions that change adopted text (D-P2-2 A, D-P2-13 A, D-P2-14, D-P2-16 A) are recorded in [16](./16-m7b-invoice-credit-note-decision-pack.md) §12.6 and the ADR-53 addendum.

### 8.2 Deviations from §6

1. **The shared dialog frame.** `src/tenant/ServerInvoiceDrafts.tsx` is not in §6. Its `DialogFrame` gained an opt-in `preferReturnFocus` (default unchanged), used once, so that closing the credit-note confirmation sends focus to the Payments heading (P2-46b). After the synthetic QA round of 2026-11-17, a second change made Tab from a heading the script had focused move to the next stop in document order. The frame is shared by the drafts, void, reversal and credit-note dialogs, so this second change also reaches shipped dialogs. The drafts suite passed after it (227 of 227); the browser suite, which covers those dialogs, has not run since (§8.4).
2. **Runner scripts and their contract test** (§8.1), not in §6.
3. **QA harness.** §6 names `front.mjs`, `fixtures.mjs` and `evidence.mjs`; `cli.mjs` and `supervisor.mjs` also changed (the scenario command), and `tests/quality/qaInteractiveFront.test.mjs` covers the new fault.
4. **Support from §5 not built.** AX (an automated accessibility scan; no such tool is installed, so P2-52 is not established); in the browser, DB1k, DB51 and a second store-scope owner (S2 exists in the browser only as a second session of the same owner).

### 8.3 Evidence map (the §5 rows against the candidate)

Layers are §5's: component (C), HTTP (H), browser (B), and the owner's synthetic manual QA (Q). Test families: SII rows named by their §5 id; IIC-51 to IIC-60 (client); CNH-01 to CNH-14 (hold); ICH-12 to ICH-22 (HTTP); SCN-01 to SCN-22 (browser). **Q is deferred for every row that lists it** and is not repeated below.

Status words:
- **Covered.** A test that names or stages the row exists at every automated layer the row lists, and that suite's last recorded local run passed. For the browser suite and the full frontend lane, that run was on the earlier tree (§8.4).
- **Work remains.** A named test is still to be written, or a run is still to be repeated (§8.6).
- **Recorded limit.** The rest of the row cannot be produced or staged at that layer; another layer covers it, or nothing does, as stated.
- **Not established.** No evidence at any layer.
- **Deferred.** Q only.

| Rows | Status | Evidence | Remaining or limit |
|---|---|---|---|
| CN-07b | Covered | SII lost register, issue and settlement tests; SCN-13 (lookup), SCN-17 (Check again) | — |
| CN-27b | Covered | SII (P2-60, DIS-16 scans); SCN-08 | — |
| P2-01, P2-02, P2-04 | Covered | SII; SCN-08, SCN-02, SCN-03 | — |
| P2-03 | Work remains | SII (C) | B: no scenario sets a read-only or overdue tenant |
| P2-05 to P2-08, P2-10, P2-11, P2-14 to P2-17, P2-19 to P2-36, P2-38 to P2-43 | Covered | SII; CNH where the row names the hold; ICH-13 and ICH-14 (P2-26, P2-33); SCN-08 to SCN-22 as each row stages | P2-17's B case is staged by owner SQL, not a second page |
| P2-09 | Recorded limit | SII; SCN-11 | B cannot produce `lookupFailed` or the 20-page cap from the real entry (DB1k not built in B) |
| P2-12 | Recorded limit | SII; SCN-08, SCN-09 | Real paste and password-manager autofill: headless Chromium has neither; Q only (deferred) |
| P2-13 | Recorded limit | SII (the 30 s bound); SCN-09 (Stop waiting, Escape) | B does not wait the 30 s bound |
| P2-18 | Recorded limit | SII; SCN-12 | B does not stage a failed re-read (`invalidStateUnknown`) |
| P2-37 | Work remains | SII (403 at settlement and lookup) | C: a component test for a 503 at each stage ("503 clause, scripted") was written on 2026-11-18. It and a CA-35 case beside it (a completed issue's same-key retry gets 503, then "Look up attempt" shows the issued row) each ran locally on 2026-11-20, in separate runs, and passed; doc 18 §13 records both runs and the fixture limits (local source-level, not CI). B: not stageable (the shipped server ends the session on a role change) |
| P2-44 | Work remains | ICH-15 (H) | B: needs a second store-scope owner |
| P2-45, P2-47, P2-49 to P2-51, P2-53, P2-56 to P2-58 | Covered | SII; CNH-11 (P2-49); SCN-01 to SCN-06, SCN-14 (P2-47 on local fonts, P2-50), SCN-17 | P2-47: 400 % zoom is Q (deferred); CI fonts not verified (no CI run) |
| P2-46a | Work remains | SII (focus on "Don't issue"); SCN-08 (page inert) | C: a component test that Tab and Shift+Tab stay inside the credit-note confirmation was written on 2026-11-18 and has never run; the row stays open until it runs |
| P2-46b, P2-46d, P2-46e | Covered | SII (fix-list and QA-round tests; titles do not name P2-46b); SCN-08, SCN-09, SCN-13 | — |
| P2-46c | Work remains | SII (password field focused) | C: a component test of the provider-button branch was written on 2026-11-18 and has never run; the row stays open until it runs |
| P2-48 | Work remains | Full lanes green on the earlier tree | Every lane to re-run on the final tree (§8.4) |
| P2-52 | Not established | — | No automated accessibility scan tool is installed; adding one is an owner decision (§8.6) |
| P2-54 | Work remains (low) | SII (each stage); SCN-13 (issue stage) | B: Escape at the register and proof stages not staged |
| P2-55 | Recorded limit | SII; SCN-01 | B: "no new item → list heading" is not producible by the real server |
| P2-59 | Covered | IIC-57 to IIC-59 (titles do not name P2-59) | — |
| P2-60 | Covered | SII pins the whole block; the browser mirrors the strings of every state it stages | Strings of unstaged states are pinned in C only |
| P2-61 | Deferred | — | Screen-reader pass (Q); G-A11Y stays OPEN |
| P2-62 to P2-80 | Covered | SII; ICH-16 to ICH-22 (P2-70 to P2-76); SCN-15, SCN-16, SCN-19, SCN-22 | — |
| P2-81 | Work remains | SII; ICH-20 (every way round); SCN-04 | C: component tests for lookup page two across another page's sign-in (81.2), Continue issuing sent after it (81.6) and `renew` dropping the credit-note state (81.7) were written on 2026-11-18 and have never run; the row stays open until they run. B: the shared sign-in switching this tab first, and the old-token-with-new-cookie 403, are not stageable: not established in the browser |
| P2-82 | Recorded limit | SII; SCN-05, SCN-06 | B: a same-token demotion is not stageable (the server ends the session on a role change): not established in the browser |
| P2-83 | Recorded limit | SII; SCN-07 (2 of 4 outcomes) | B: "old-session 200 accepted, then dropped" and "page two leaves with the new cookie → 403" are not producible: not established in the browser |
| P2-84, P2-85 | Covered | SII; ICH-14, ICH-19 | — |
| P2-86 | Work remains | SII (a second session of the same owner); SCN-22 | C: a component test of the "other owner" variant was written on 2026-11-18 and has never run; the row stays open until it runs. B: not tested |
| P2-87 | Work remains | SII (C) | B: no seed of 51+ notes with a later note past page one |
| P2-88, P2-89 | Covered | SII; the P2-89 request-log check runs after every credit-note test and has its own self-check | — |

Counts over the 95 rows: 76 covered, 10 with work remaining (P2-03, P2-37, P2-44, P2-46a, P2-46c, P2-48, P2-54, P2-81, P2-86, P2-87), 7 recorded limits (P2-09, P2-12, P2-13, P2-18, P2-55, P2-82, P2-83), 1 not established (P2-52) and 1 deferred (P2-61).

### 8.4 Local verification record

Node 20, `TMPDIR=/tmp`, all local; no CI run.

**Last full run (2026-11-17), on the earlier candidate tree, fingerprint `648b109af36a4c01a968530e9a0c3fca057777cb4a59dbe41fa1852cbc53de7d`:**

| Lane | Result |
|---|---|
| `ServerIssuedInvoices.test.tsx` (two full runs) | 503 of 503, twice |
| `invoiceCreditNoteHold.test.tsx` | 14 of 14 |
| `ServerInvoiceDrafts.test.tsx` | 226 of 226 |
| `npm run test:frontend` | 31 files, 1,543 cases, ratchet passed at floor 1,543 |
| Ratchet contract test | 15 of 15 |
| `npm run typecheck`, `npm run typecheck:contract` | exit 0; OK |
| `npm run test:existing` | 185 of 185 suites |
| `qaInteractiveFront.test.mjs` | 40 of 40 |
| Browser, full file | 126 of 126 (SCN-01 to SCN-22, SIS-09, SDB-01 to SDB-23) |
| Database suites (last run on this candidate, not repeated in that pass because no server, migration or database test file changed) | credit-note HTTP 22 passed and 1 skipped (ICH-11, UNVERIFIED); routines 28 of 28; cutover 11 of 11; migration smoke 2 of 2; invoice issue HTTP 13 of 13 |

Browser mode: a Firestore stub, a throwaway cluster with `fsync` on, on a Unix socket, in a private network namespace, a fresh snapshot for each run.

**After that run.** The synthetic QA round of 2026-11-17 changed `ServerInvoiceDrafts.tsx` (the dialog frame's Tab handling, §8.2), `ServerInvoiceDrafts.test.tsx` and `ServerIssuedInvoices.test.tsx`, giving the candidate fingerprinted as `39911874…`. Only targeted component runs followed, on that candidate: `ServerIssuedInvoices.test.tsx` 506 of 506, `ServerInvoiceDrafts.test.tsx` 227 of 227 and `invoiceCreditNoteHold.test.tsx` 14 of 14.

**After `39911874…` (2026-11-18).** Seven component tests were added to `ServerIssuedInvoices.test.tsx` (P2-37 "503 clause, scripted", P2-46a, P2-46c, P2-81 items 81.2, 81.6 and 81.7, and P2-86's other-owner variant). Six of them have never run. P2-37's ran once on 2026-11-20, by itself (log `component-p2-37-503-active-20261120.log`: 1 passed, 541 skipped), and a CA-35 case added beside it that day ran once in a separate run (log `component-p2-37-ca35-active-20261120.log`: 1 passed, 542 skipped); both passed, and doc 18 §13 records both runs and their fixture limits. Neither is a run of the suite: the full file has not run since (the owner paused QA on 2026-11-18). So "506 of 506" is a result for the candidate before these additions, not for the final tree; no full run of the final tree's `ServerIssuedInvoices.test.tsx` exists. Also on 2026-11-18, O6 (§8.6) changed one line of product code (the first-send issue 403 on a changed token now shows `ended`) and the 81.6 expectation; neither has run. The final tree has no recorded fingerprint.

**Not re-run on the final tree:** the full frontend lane (whose floor of 1,543 is now below the real count by roughly 11 cases, from the cases added after the last full run, including the seven tests above), the typecheck, the typecheck contract, `test:existing`, the ratchet contract test, `qaInteractiveFront`, the full browser file (the shared dialog changed) and the database suites (their files did not change). So no full green run exists on the final tree, and six of the seven new tests have not run at all (P2-37's ran alone, above).

### 8.5 QA status

- **Deferred by the owner.** On 2026-11-18 the owner paused all QA until development across all phases is finished. The 39-item synthetic checklist for CN-P2 (owner-directed, not UAT) is not complete, and no QA result is claimed as acceptance. P2-61 and every Q column are not run.
- **Earlier results, at their actual scope only.** A RAM-backed synthetic UI run, `qa-20261117t2012-26e3`, on the final candidate tree plus the QA-only overlay, recorded browser and UI observations for part of the checklist. Its cluster data lived in memory, so it is no evidence of crash durability. Several items stayed partial, pending, not reached, or blocked (no screen reader was available). It recorded one open finding, QA-CN-P2-LOGIN-01: once, a renewal after an aged owner sign-in showed "Not signed in" although the identity requests answered 200; no credit note was created by it, a retry succeeded, and the cause is unconfirmed. The checklist, observations and evidence are kept outside the repository.
- **Crash durability: no evidence.** The durable run on Replit could not seed. The suspected cause, a commit's flush taking longer than the rate limiter's 500 ms deadline on that host, is not confirmed. A hand-off for a disk-backed run on another host exists outside the repository; it has not been run.

### 8.6 Remaining development work and open owner decisions

Remaining work, in order (nothing here is decided by this record):
1. Re-run every local lane on the final tree, then set the frontend floor to the measured count and update its pinned literal.
2. Component tests, written on 2026-11-18 and never run: P2-81 (81.2 lookup page two across another page's sign-in; 81.6 Continue issuing sent after that sign-in, which must detach, not show no access; 81.7 `renew` dropping the credit-note state); P2-86's other-owner variant; P2-46a (Tab and Shift+Tab stay in the confirmation); P2-46c (provider-only sign-in focuses the provider button). Each row stays open work until its test runs and passes; the status counts in §8.3 do not change. P2-37's component test (a 503 at each stage, "503 clause, scripted") and the CA-35 case beside it have each run once locally and passed (2026-11-20, doc 18 §13); P2-37 still stays open work, because its browser layer is not established (§8.3).
3. Browser scenarios: P2-03 (read-only or overdue tenant), P2-44 and P2-86 (a second store-scope owner), P2-87 (51+ notes); optionally P2-54, P2-13 and P2-18.

Owner decisions this record surfaces and does not make:
- **O1.** Whether to add an automated accessibility scan tool (a dependency change) for P2-52, or to accept P2-52 as not established.
- **O2.** Whether the local test lanes, the real-browser file included, count as paused QA or as development verification that may run now.
- **O3.** Commit, push and CI, each separately.
- **O4.** D-P2-14's production handling, and deployment (§8.7).
- **O5.** Whether the browser rows in item 3 are built, or accepted as recorded limits as P2-82 and P2-83 are.
- **O6 (closed 2026-11-18 on the owner's instruction; implemented, never run).** The first-send issue 403 with a changed sign-in used to show `replayGone` ("We can't check this attempt from this sign-in…"). §3.1 (the 401 and 403 `forbidden` rows, lines 363-364, and line 383) and §3.6 rule 1 agree with each other. A first send's 403 is decided before the key (line 199). A new token or a sign-out detaches the hold and takes the 401 texts; only the same token gives notAllowed. So the source confirmed the mismatch, and the design stays unchanged. The product now shows `ended` on that path, as the first-send 401 does (`ServerIssuedInvoices.tsx`, lines 2179 and 2185). It does so only when the section is still mounted and its token is no longer the one the request carried. Any other `'gone'` keeps `replayGone`: the section unmounted during the check, or a same-token denial whose hold had already detached or been replaced. `ended` says nothing about whether a note was issued, and nothing is resent. No `shut` is added: a detached card never offers Check again (line 4040), and the first-send 401 path does not shut either. A same-token denial is unchanged (notAllowed + noAccessShort, line 2182). The 81.6 test now expects `ended`. It has never run, and it does not show that "Look up attempt" returns after the store is chosen again (line 4044). Carried forward, unchanged and open: (a) on the new-token path the section is still signed in, so `ended`'s "Reconnect to see issued invoices" is the adopted wording but an instruction the user cannot follow there — an owner wording question; (b) the register stage's first-send 403 on a changed token still shows `regUnknown` (line 2103), although line 383 and §3.6 rule 1 apply to every command; (c) a first-send issue 403 whose check cannot answer (`'unchecked'`) still shows `unresolved` (lines 2191 and 2199).

### 8.7 Release status

- **Not authorized.** Nothing is deployed and no managed database is touched.
- **D-P2-13 A.** CN-P2 is not deployed to production until the store-wide credit-activity read, built in its own slice (D-P2-2 A), passes its gate. That slice has no contract yet (§4.2 states its needs only); it needs a route and key, a definer routine in a new migration 039 (not created), a DA-132 direct-read entry and 038-style cutover steps.
- **D-P2-14.** The cross-owner duplicate residual is accepted for building and synthetic verification only; its production handling is an open owner decision.
- **Withdrawal.** CN-P3 is not built, so an extra or mistaken note cannot be withdrawn from the shop.
- **Gates.** 37: 29 OPEN, 7 PARTIAL, 1 PASS; none changes. ICH-11 UNVERIFIED; CN-38 a deployment prerequisite; G-APPSEC PARTIAL and production-blocking; F-2 and F-5 missing inputs; G-A11Y OPEN.

### 8.8 Residuals found and not changed

- When a chain answer closes the confirmation, focus can rest on the Payments heading before it reaches the card heading (two moves; the final target is right).
- In development builds only (React StrictMode), opening the confirmation can focus the Payments heading for a moment. The QA harness serves a production build.
- Not staged by any test: a store switch during a denial's session check, a cross-store send after a denial, and an attempt switch with identical card words.
- D-P2-10 A leaves other sign-ins (issuing settings, customer levels, other tabs) able to detach a credit-note attempt; recovery then goes through the lookup.

### 8.9 Not claimed

A commit, a push, a CI run, a full green run on the final tree, QA acceptance or UAT, crash durability of a QA run, the browser behaviour of P2-81 to P2-83 beyond what §8.3 records, P2-52, a screen-reader pass, deployment, production readiness, M7b completion, or any legal or tax meaning of a credit note (F-2).

---

## Drafter's notes

1. **D-P2-9 exists because the shop has no sign-in time.** No `authenticatedAt` reaches `src/tenant`. Without a shop-timed sign-in, Check again could not be offered with a known window. Option B keeps fewer sign-ins but makes Check again blind.
2. **D-P2-8 departs from the reversal precedent** (T:3634; D15:855), which clears the reason after a sign-in. The values here are shown facts, not fields, and a new press is still needed; option B follows the precedent.
3. **Two accepted review items met in one row.** The wording review's text for an issue `invalid_state` (invalidStateUnknown, with "Look up this attempt") and the recovery review's rule (say voided or released after a re-read) are both kept: the specific texts when the re-read succeeds, invalidStateUnknown only when it fails. The issue routine has exactly two `invalid_state` causes (M38:1289, :1303), so "not voided" means released.
4. **Live regions while the confirmation is open.** The page behind an open dialog is inert (DR:794-799), and announcements from an inert subtree may be lost, so the dialog gets its own pair while open. Implementation should confirm with a screen reader (P2-61).
5. **"Don't issue" becomes "Close" while sending.** The relabel happens on the primary press, when focus is on the primary button, and is announced once. If the owner prefers, the button can keep one label ("Close") from the start.
6. **Revisions 3 and 4.** "First response wins" became evidence classes; a refusal that was never stored is final only until a Check again is sent, and a stored answer wins among non-stale answers for its own hold generation, stage and key. proofLost and issueNotFound became the neutral cantContinue. "Continue issuing" replaces a second "Issue credit note" press after a registered-only card. Completeness of the lookup is now "exhausted as observed", an operational gate.
7. **Revision 5.** Session isolation is established by the shipped token binding plus the shipped read skeleton (§3.6); the rev4 cross-tab residual ("pages may mix") is withdrawn and there is no blocker; a narrower display-delay residual remains (old rows stay visible until this tab notices the change). Continuation has its own eligibility rule (E1-E7, §3.2). D-P2-15 uses a set comparison against a pre-attempt baseline, not `issuedAt` vs `registeredAt`. Lookup-first settlement is recommended (D-P2-16). A settlement Check again has a 23-hour replay limit (D-P2-9). P2-73 is corrected: the request that finds the row already in the target state answers `unchanged`.
8. **Adoption (2026-11-16).** §3.6 now separates reads (latest-request sequencing, paging included) from commands and their same-key replays (attribution to the live attempt), and P2-28 traces both arrival orders. An earlier sentence applied the read skeleton's request sequence to commands as well; under that rule a replay's 409 or 429 would have made the original's later 201 stale, against P2-28. Rule 4 states when names and recovery actions clear, same-token demotion included. A hide no longer changes the hold generation, matching §2.6 item 4. P2-83 no longer relies on a held header lock, which cannot hold a list read; it uses the browser suite's gate. P2-81 to P2-83 record browser coverage limits instead of moving assertions to other layers. Review at adoption added: the proof under its own per-attempt sequence; command attribution also checks the sign-out counter; same-key stored answers compared before they count as stale; session handling kept separate from the attempt outcome; names stripped from cards on any session change or confirmed access loss; the same-token check compares tokens rather than copying the void's pattern. §7 records the owner's choices.

## Appendix A — Scan check (mechanical, not a test run)

**Method.** A script kept outside the repository (`.workflow/cn-p2-design/scratch/scan-check.mjs`) parses the §2.7 table (the reused `ISSUED_TEXT.ended` included; placeholders filled with sample values), gives each row the scope where it renders (§2.1, §2.5, §2.6), and tests it against the shipped patterns for that scope (counts under Result):
- Outside Payments (the confirmation beside `issued-view`, the section-level card, the section's regions): `FORBIDDEN` (TEST:1768) in its four jsdom scopes and `NOT_SAID` (BR:8105) in its three browser scopes.
- Inside Payments (form, action, blockers, list, inline card): "amount due", `(un)?paid`, "refund" (TEST:5354, :5357, :5384, :5433); a voided invoice's Payments (list and a surviving card): `invoice total|credited|$0.00` (TEST:5399); buttons: `/credit|withdraw/i` (TEST:5385).
- Every string: the source scan (TEST:1232), CN-27b's words, "refund", and "withdraw" outside the list.

**Result.**

Adoption rescan (2026-11-16): 75 table rows, 107 strings, 1,412 checks, 3 trips; the adoption edits add no string. Revision 5 rescan: the same counts. The trips are the same three exact button names as before; no added or changed string (anotherNoteFound, anotherNoteUnknown, anotherHint, continueLapsed, continueAfterSignIn, issueStale, settleUnknown, inProgress, numberPending, checkReadHint) trips any scan. No new button: the Payments button inventory below is unchanged.

| String (key) | Where | Trips | Supersession |
|---|---|---|---|
| Issue credit note (action) | Button inside Payments | TEST:5385 `/credit\|withdraw/i` | DIS-16 (D-P2-4): allow this exact name |
| Confirm credit note (confirm) | Button in the inline card, inside Payments | TEST:5385 | DIS-16: allow this exact name |
| Issue another credit note (issueAnother) | Button in the inline card, inside Payments | TEST:5385 | DIS-16: allow this exact name |

- No string trips `FORBIDDEN`, `NOT_SAID`, the Payments word scans, the voided-Payments scan, the source scan, CN-27b, "refund" or "withdraw"; no `FORBIDDEN` or `NOT_SAID` supersession is needed.
- **Scope matters once.** blockedSibling ("payment", "void") would trip `FORBIDDEN` and `NOT_SAID` outside Payments; it must render only beside the action, inside Payments.
- **Control inventories (not word scans).** The jsdom dialog inventories (TEST:2031, :2348, :4883 and the voided ones) count every button in `issued-view`; the fake's defaults (lookup 403, list empty 200) keep the action, recovery and list buttons out of them, and new tests pin their own. The browser inventory skips `issued-payments-` test ids (BR:8266). The new buttons inside Payments are: Issue credit note, Continue, Cancel, Continue issuing, Issue another credit note, Confirm credit note, Release attempt, Try again, Continue checking, Look up attempt, Check again, Hide this attempt, Show more.
- Not covered: exact-string pins of shipped constants (unchanged) and the drafts-side scans (another surface).

## Not claimed

- No implementation, test run, CI run, push, deployment or managed-database change; the only commit is this document's local, docs-only adoption commit. No row in §5 has run. *(As at adoption, 2026-11-16. §8 records the implementation in an uncommitted candidate and its local runs; there is still no commit, push, CI run or deployment.)*
- The browser behaviour of P2-81 to P2-83 is not established by the source trace in §3.6 or by any component or HTTP row.
- The baseline was confirmed before drafting and again at adoption (2026-11-16): remote `main` at `8148eebb0cb7270cd96acdbed912f5afcb8818ee`, and run 43778230600 (push to `main`, attempt 1) completed with success on that commit.
- No gate changes status: 37 gates, 29 OPEN, 7 PARTIAL, 1 PASS. ICH-11 stays UNVERIFIED. CN-38 stays a deployment prerequisite. G-APPSEC stays PARTIAL and production-blocking. F-2 and F-5 stay missing inputs. G-A11Y stays OPEN.
- No legal or tax meaning of a credit note, its reasons, number or split (F-2).
- The strings are owner-approved as wording (D-P2-4), with three label exceptions. Appendix A checks them against the scan patterns as text; the suites themselves were not run.
- Server lines re-verified for this revision: M38:883-885, :914-919, :932, :1057-1065, :1115, :1202, :1211-1215, :1229-1235, :1270-1281, :1284-1305 (`invalid_state` only at :1289, :1303), :1344, :1357, :1453, :1485-1494, :1515-1519, :1582-1677 (no void check), :1585, :1593-1595, :1601-1605, :1618-1636, :1924-1925, :1941, :1944, :1961, :1950-1951; M06:331-357 (expires_at :334, :355; reclaim :352-357); RT:78-81, :204, :216, :385-389, :456-459, :466-477, :571, :580, :617, :701-705, :715; IDEM:107, :372-373, :386-392; APP:482, :491-503, :838-839, :861-872, :940-957, :983-986, :1102-1104, :1121-1123; PTS:897-900, :940-942; RL:80, :84; APP:534-536, :1160; PG:168; D16:3, :272-276, :335-347; D14:16, :537. Shop lines re-verified: T:106-108, :124, :144, :192, :205-207, :229, :922-928, :930, :1037-1040, :1853-1868, :1885, :2356-2380, :2594, :3634-3639, :3781, :3812-3821, :4430-4438, :4475; CL:90-96; C:155, :435-445; PH:11-12, :15, :99-104; TEST:1232, :4058, :5385; BR:8266. Re-verified for revision 5: SES:416-417, :670-672, :706, :752, :866-877; APP:448-451, :947-951, :1087-1100; T:620, :803-810, :928, :1054, :1078, :1233-1253, :1299-1321, :1410-1487, :2419-2428; TSC:239, :301-310, :340-354, :370-379; M38:515, :914-919, :1211-1215, :1344, :1617-1629, :1648-1677, :1949-1952; RT:12, :77-79, :274, :321-323, :596-597; IDEM:89-91; PAY:486-492. Verified for the revision-5 fixes: `server/runtime/invoiceIssuing.ts:641-650`; IDEM:437-443; APP:871, :949-951; TSC:340-379; RT:321-330; M38:41-43, :689, :2116, :1515, :1601-1605, :1924-1925; T:1248-1250, :1260-1283 (`renew` closes the view at :1267), :1296, :1299-1321, :1678-1715; PH:98-103; SES:109-110; RL:84; `src/context/AccessContext.tsx:176-179`; no BroadcastChannel or `storage` listener in `src/tenant`. Verified at adoption: T:629, :1415, :1417-1422, :1469; BR:1519, :1591-1599; TSC:284-292, :319-326, :340-344; T:1311-1317, :1422, :1443, :1474-1480, :1680, :2420-2421; M38:1433-1525 and :1860-1961 (no row lock). Other shop and test line numbers come from read-only research at the baseline.
