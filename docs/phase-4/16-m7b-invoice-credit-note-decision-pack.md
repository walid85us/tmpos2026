# 16 — Credit notes against an issued store invoice: decision pack

**Status: ADOPTED; CN-P1 IMPLEMENTED IN CODE ON `main` `064b5f1` — NOT DEPLOYED (owner decisions of 2026-11-14, stage M7B-CREDITNOTES-D1-P0; delivery stage M7B-CREDITNOTES-P1; closeout recorded 2026-11-15).**
- The owner chose every recommendation; §12 records each choice.
- CN-P1 implements §12.2: migration 038, the server routes and commands, and the shop's decoders and display. It is integrated on `main` at `064b5f1ddafc5579f496cb084415f283fa0cb20c`, a fast-forward from `04bd9d6`. The delivery record is §12.4, the integration and exact-commit CI record is §12.5, and the decision record is [10](./10-architecture-decision-records.md) ADR-53.
- Exact-commit CI (CN-28) passed on `064b5f1`: candidate run 43756236582 (attempt 1), and main run 43759859862, whose `quality` result comes from attempt 2 (one failed-job rerun after a tenant-entry failure in attempt 1) and whose `appsec` result comes from attempt 1 (§12.5).
- Owner-directed manual QA (CN-29) passed 12 of 12 on synthetic data (§12.4; not UAT). It ran on the final candidate tree, after the independent review's findings were applied; since then only Markdown records and test files have changed (§12.5).
- Nothing is deployed, no managed database is touched, and deployment is not authorized. Credit notes are not available in the product: CN-P2 (the shop's issue control and recovery) and CN-P3 (the shop's withdrawal control) are not built.
- No gate changes status. F-2 and F-5 stay missing inputs. Refunds and every money movement stay excluded.

**Status at the CN-P1 candidate, 2026-11-15 (history): ADOPTED; CN-P1 (CANDIDATE) IMPLEMENTED — NOT DEPLOYED.**
- The owner chose every recommendation; §12 records each choice.
- CN-P1 (candidate) implements §12.2 as built on `main` `04bd9d6`: migration 038, the server routes and commands, and the shop's decoders and display. The delivery record is §12.4 and the decision record is [10](./10-architecture-decision-records.md) ADR-53.
- The CN-P1 candidate has had an independent review (no blocker or major finding; minor findings applied). Owner-directed manual QA (CN-29) passed 12 of 12 on synthetic data (§12.4; not UAT). The owner's review and exact-commit CI are pending. Nothing is deployed. Credit notes are not available in the product.
- CN-P2 (the shop's issue control and recovery) and CN-P3 (the shop's withdrawal control) are not built.
- No gate changes status. F-2 and F-5 stay missing inputs. Refunds and every money movement stay excluded.

**Original status at D1-P0 (history): PROPOSED — NOT ADOPTED (stage M7B-CREDITNOTES-D1-P0, documentation only).**
- Credit notes are not available in the product, in code or deployed.
- This document adopts no policy. It adds no credit note, amount, permission, route, read change, grant, audit kind or migration, and it edits no other document.
- Pushing it is not approval, and a green CI run is not approval either. Every recommendation below waits for the owner's explicit choice in §11.
- Accepting the decisions adopts them; it does not deliver the feature. CN-P1 is a separate stage, built only to the accepted text.
- Until then, credit notes stay undecided, as [08](./08-production-gate-and-risk-register.md) DA-186 and [09](./09-roadmap-m0-m9.md) (M7b) record. No gate changes status.
- The text from here to §11 is the proposal as written; §12 records the adoption and is the CN-P1 target contract.

**Baseline.**
- Verified remote `main`: `176c129e14d0ee56b30db98b162f1ab2bb1bdfb2` (the M7B-PAYMENTS-P2C closeout). As at D1-P0, `main` had not advanced beyond it, so the governing contracts are the ones cited here and no contract reconciliation is needed beyond the corrections this revision makes (R4: recovery, cutover, owner-only authority, voided display, sign-in timing).
- P2C implementation: `9c4d2010149c42aee362566a5f40f6897b8243ce`.
- P2C documentation CI: run 43630725465 (push to `main`, attempt 1, success). This run is as given by the stage brief; it was supplied by the owner and is not re-checked here.
- Gates, as [15](./15-m7b-invoice-payment-recording-decision-pack.md) line 9 and [09](./09-roadmap-m0-m9.md) line 513 record them: 37 gates, 29 OPEN, 7 PARTIAL and 1 PASS at repository level. Nothing is deployed.

**Why this pack now.**
- [09](./09-roadmap-m0-m9.md) line 513: "M7b is not complete: refunds, credit notes and the rest remain; credit notes are the next workstream's question."
- Adopted text has always placed credit notes with payments ([12](./12-m7b-invoice-issue-decision-pack.md) line 169; [13](./13-m7b-invoice-void-and-correction-decision-pack.md) line 31; [15](./15-m7b-invoice-payment-recording-decision-pack.md) line 53). Payments and a derived amount due now exist in code ([10](./10-architecture-decision-records.md) ADR-52), so the precondition [13](./13-m7b-invoice-void-and-correction-decision-pack.md) line 43 gave ("credit notes need payment and amount-due rules that do not exist") is met.
- [10](./10-architecture-decision-records.md) ADR-52 decision 4 (line 1605): "An invoice issued by mistake whose payment was truly received cannot be voided through this slice until refunds exist; that payment must not be reversed to make the numbers fit." PROPOSED reading: a credit note covers the part of that gap where the customer owes less but no money goes back; refunds still close the rest.

**Which "credit note".** This pack is about a **store-invoice credit note**: a store's own document that lowers what its customer owes on one of the store's issued invoices. It is not:
- the platform-billing `credit_note` entity of the owner-to-tenant subscription domain ([05](./05-canonical-data-ownership-and-api-db-contracts.md) line 67; [06](./06-module-migration-map-m7.md) line 27, M7f);
- the platform grant `approve_billing_actions` ("Approve refunds, credits, or write-offs", `server/platform-identity/gap11GrantDiff.ts:234`);
- the legacy browser POS "Store Credit" choices, which are in-memory and not policy.

"Credit note" is a product label with no legal status until F-2 is answered. The tax figures it stores are not a tax record or a basis for filing.

**Labels.** Each statement carries one class:
- **EXISTING**: verified in source at commit `176c129`, cited `path:line`.
- **ADOPTED**: policy already accepted, cited by document and line or section.
- **PROPOSED**: a new policy this pack recommends. It awaits the owner.
- **AMENDMENT**: a proposal that would change adopted text. It needs its own explicit owner choice and is never implied by accepting something else.
- **CONDITIONAL**: an implementation choice that applies only if the related proposal is accepted.
- **DEFERRED**: outside this pack.

**Default label.** Everything in §3 to §9 is PROPOSED or CONDITIONAL unless it cites an adopted document or a source line.

**Conventions.**
- "Not established" marks what the repository does not show.
- `path:line` references drift as files change. Migration file names are relative to `server/platform-identity/migrations/`.
- All amounts are USD integer cents. Every cent figure in §5 was produced by a script and checked by its assertions; none is hand-computed.
- "The owner" is the product owner who decides §11. The `store_owner` role is always written as "the store owner (`store_owner`)".
- F-2 is the launch fact for the stores' jurisdictions and legal review ([12](./12-m7b-invoice-issue-decision-pack.md) line 116). F-5 is the retention duration ([08](./08-production-gate-and-risk-register.md) DA-187).
- Next free identifiers, by inference only: document 16; ADR-53; DA-225; migration **038** (`server/persistence/postgresStartupPreflight.ts:11` pins exactly 001–037, and the migrations folder ends at `037_m7b_invoice_payment_registration.*`). This pack reserves none of them and edits neither [08](./08-production-gate-and-risk-register.md) nor [10](./10-architecture-decision-records.md).

**Contents.**
[1. The capability in plain language](#1-the-capability-in-plain-language) ·
[2. What exists today](#2-what-exists-today) ·
[3. Decision notes](#3-decision-notes) ·
[4. State and operation matrix](#4-state-and-operation-matrix) ·
[5. Worked examples in cents](#5-worked-examples-in-cents) ·
[6. Proposed amendments and contract changes](#6-proposed-amendments-and-contract-changes) ·
[7. Direct-call prerequisite and audit](#7-direct-call-prerequisite-and-audit) ·
[8. CN-P1 boundary and acceptance matrix](#8-cn-p1-boundary-and-acceptance-matrix) ·
[9. Dependencies and production-gate map](#9-dependencies-and-production-gate-map) ·
[10. How the owner answers](#10-how-the-owner-answers) ·
[11. Owner decisions required before CN-P1](#11-owner-decisions-required-before-cn-p1) ·
[Recommended first implementation slice](#recommended-first-implementation-slice) ·
[12. Adopted decision record and CN-P1 target contract](#12-adopted-decision-record-and-cn-p1-target-contract-2026-11-14)

## 1. The capability in plain language

**PROPOSED meaning.**
- An authorized store team member issues a credit note against one issued invoice of the store. It states an amount in US cents and a closed reason.
- The amount lowers what remains to be settled on that invoice. The invoice itself does not change: its number, lines, tax, Total and snapshot stay exactly as issued.
- A credit note moves no money. It is the store's statement that the customer owes less.

| Term | What it is | Status |
|---|---|---|
| **Credit note** | An append-only record, with its own number, that lowers the remaining amount of one issued invoice by a gross amount, split into net and tax | PROPOSED |
| **Credit-note withdrawal** | An append-only record that says one credit note was issued in error. The credit note stays, marked withdrawn, and the remaining amount rises again | PROPOSED |
| **Recorded payment, reversal** | Money stated as received; a recording withdrawn as a mistake | ADOPTED ([15](./15-m7b-invoice-payment-recording-decision-pack.md) §12; ADR-52) |
| **Invoice void** | Issued → voided, terminal; "records no refund, credit note, tax reversal or erasure" | ADOPTED (ADR-51 decision 1, [10](./10-architecture-decision-records.md) line 1543) |
| **Refund** | Money returned to a customer | DEFERRED |
| **Store credit, customer balance** | A reusable value held for a customer across invoices | DEFERRED |
| **Tax reversal or filing** | A change reported to a tax authority | DEFERRED ([13](./13-m7b-invoice-void-and-correction-decision-pack.md) line 32) |

**Recommended first slice (PROPOSED, D-CN-1).**
- One credit note applies to exactly one invoice issued by the server (034's `issued_invoice`).
- Its gross amount is 1 cent to the invoice's remaining amount. A request above that is refused whole.
- The original invoice row, its number, its snapshot (version 1) and every payment and reversal row are untouched.
- A mistaken credit note is corrected by withdrawing it whole and issuing a correct one.

**Outside the slice (DEFERRED):**
- refunds and payouts (money going back to anyone);
- provider operations (processor refunds, voids, disputes, webhooks);
- reusable customer balances and store credit;
- one credit spread over several invoices, or credit moved from one invoice to another;
- line-level credits, returned goods and stock movement;
- credit-note drafts;
- printing, PDF, email and any delivery to the customer;
- tax filings and accounting exports.

## 2. What exists today

| Area | Where | What it establishes (EXISTING unless ADOPTED) |
|---|---|---|
| The issued Total | `034_m7b_invoice_issue.up.sql:357-363`, `:390-401` | `currency` is exactly `USD`. `subtotal_cents`, `tax_cents` and `total_cents` are bigint cents in 0 to 2^53 − 1. Under `exclusive_rate` the Total is subtotal plus tax; under `none` it is the subtotal and `tax_cents` is NULL. A Total of 0 is possible |
| Tax rounding | `034_m7b_invoice_issue.up.sql:280-289`; `server/runtime/invoiceIssuing.ts:161-166` | Tax = `div(S × R + 50,000, 100,000)`, R in thousandths of a percent, half a cent rounds up. Tax is computed once on the subtotal; lines carry no tax. The CHECK at `:395-401` re-derives it |
| Meaning of the Total | `034_m7b_invoice_issue.up.sql:404-405`; ADOPTED ADR-50 decision 1 ([10](./10-architecture-decision-records.md) line 1500), amended by A1 (line 1534) | The row is "never an amount due, a balance or a payment status". A1 lets a separate payments read treat the version-1 Total as the starting amount due |
| Immutability | `034_m7b_invoice_issue.up.sql:762-765` | ENABLE ALWAYS guard on the issued header; no UPDATE path exists. A lifecycle fact (the void) lives in a side table keyed by `issued_invoice_scope_key` (`:368`) |
| Invoice numbering | `034_m7b_invoice_issue.up.sql:326-336`, `:372`; ADOPTED ADR-50 decision 3 (line 1502) | A locked per-store counter row, unique (tenant, store, number), from 1, no prefix. "No legal or disaster-recovery gaplessness is promised" |
| Void record | `035_m7b_invoice_void.up.sql:331-346` | One append-only row per voided invoice, composite foreign key onto 034's scope key, closed reason list |
| Payments | `036_m7b_invoice_payment.up.sql:261-281`, `:290-304` | `invoice_payment` (amount 1 to 2^53 − 1, `attempt_id` unique per invoice) and `invoice_payment_reversal` (one per payment, six closed reasons) |
| Amount due | ADOPTED ADR-52 decision 1 (line 1602); `036_m7b_invoice_payment.up.sql:1640-1662` | due = Total; applied = unreversed payments; remaining = due − applied, in `numeric`, never stored. Voided reads 0, 0, 0. Five words: `nothing_due`, `no_payment_recorded`, `recorded_partly`, `recorded_in_full`, `voided` |
| Integrity raises | `036_m7b_invoice_payment.up.sql:1647-1650`, `:1653-1656` | The payments read raises `data_corrupted` if a voided invoice holds an unreversed payment, or if unreversed payments exceed the Total |
| Exact decoders | `server/runtime/invoicePayments.ts:410-412`; `src/tenant/invoiceIssuingClient.ts:729-731` | The server's decoder of the routine's answer requires due = Total (0 if voided) and remaining = due − applied, else 503. The shop's decoder requires `amounts` to have exactly the keys `{currency, dueCents, appliedCents, remainingCents}` and remaining = due − applied; anything else is refused |
| The live cap | `037_m7b_invoice_payment_registration.up.sql:1079-1082`, `:1144-1150` | `record_v2` locks the issued header FOR UPDATE, then, as a separate statement, refuses `amount_exceeds_remaining` if unreversed payments plus the amount exceed `total_cents` |
| Retired routines | `036_m7b_invoice_payment.up.sql:1723`; `037_m7b_invoice_payment_registration.up.sql:1543` | 036 revoked `tmpos_app`'s EXECUTE on 035's void; 037 revoked it on 036's record. Replace-and-revoke is the precedent for changing a live routine |
| Void and payments | `036_m7b_invoice_payment.up.sql:1446-1455`, `:1497-1512`; ADOPTED ADR-52 decision 5 (line 1606) | `m7b_invoice_void_v2` locks the header, refuses `invalid_state` if already void, then `payments_recorded` while any unreversed payment exists |
| Isolation | `036_m7b_invoice_payment.up.sql:563-565`, `:38-40`; `037_m7b_invoice_payment_registration.up.sql:1062` | Every write routine refuses anything but READ COMMITTED (55000), because under REPEATABLE READ a sum would judge a snapshot taken before the lock wait |
| Lock slot | `036_m7b_invoice_payment.up.sql:715-723`, `:732-733` | "Records, reversals and voids of this invoice serialize here": header FOR UPDATE, then key 530030 SHARED for editable roles and the levels re-read |
| Lost-reply recovery | `037_m7b_invoice_payment_registration.up.sql:11-17`; ADOPTED [15](./15-m7b-invoice-payment-recording-decision-pack.md) §12.12–§12.14, line 773 | A durable per-staff registration slot, a post-commit proof, an attempts lookup and a settlement. Owner decision: "A missing row does not resolve the attempt" |
| Store permissions | `server/platform-identity/m5CanonicalPermissions.ts:304-331`, `:343-344` | Nine store keys. The load guard admits Approve only for four keys by name: `issue_invoices`, `void_issued_invoices` (sensitive), `record_invoice_payments`, `reverse_invoice_payments` (sensitive) |
| Plan gates | `server/platform-identity/permissionCatalog.ts:208`; `m5CanonicalPermissions.ts:494-496` | `refunds` is plan-gated; a store route evaluator uses an empty entitlement set, so a key parented on Refunds denies every role. Invoices is core |
| Store scope | `server/composition/tenantAuthorization.ts:72-84`; `server/runtime/invoiceVoid.ts:9-11` | The path's store is a requested target; only the actor's own store grant at exactly that store authorizes |
| Session checks | `server/runtime/sessions.ts:153`, `:173`; `server/runtime/idempotency.ts:107`, `:113`; `server/runtime/rateLimit.ts:78-85` | CSRF header `x-tmpos-session-csrf`; recent sign-in 10 minutes; `idempotency-key` with lease 60 s and retention 24 h; one request limit of 300 a minute per client (the other two, at lines 82 and 84, are login-only), no per-route limit |
| Audit, routine-written | `036_m7b_invoice_payment.up.sql:471-472`, `:819-830`; `server/persistence/postgresTransactionalStore.ts:374-375` | Payment routines insert their own `audit_event` row with a dedicated subject column; `ROUTINE_AUDITED_KINDS` is a closed list |
| Audit, store-written | `server/platform-identity/auditEventWriter.ts:439-448` | The TypeScript writer names an issued invoice only in the issue's triple or alone for the void |
| Audit rule | ADOPTED [05](./05-canonical-data-ownership-and-api-db-contracts.md) line 485 | "every payment state transition writes a durable append-only `audit_event`" |
| Shop wording | `src/tenant/ServerIssuedInvoices.tsx:335`, `:455`; `src/tenant/invoiceIssuingClient.ts:119-125` | The void dialog says a void "is not a credit note or a tax correction"; the `payments_recorded` message; the five shop status labels, none saying "Paid" or "Unpaid" |
| Direct calls | [08](./08-production-gate-and-risk-register.md) DA-118 (line 408), DA-119 (line 409), DA-132 (line 422) | `tmpos_app` with a live minted key can call definer routines directly, past every HTTP check. DA-118 and DA-119 are pre-deployment blockers; DA-132 is OPEN under G-DBROLE |
| Default holders | `server/platform-identity/permissionCatalog.ts:490-491`, `:497-498`, `:858` | The store owner (`store_owner`) is Full by the materializer's short-circuit (`:490-491`, `:858`), never stored; `manager` holds Invoices and Customers Full by default (`:497-498`) |
| Shop "Amount due" | `src/tenant/ServerIssuedInvoices.tsx:3786` | The shop labels `dueCents` "Amount due" |
| Credit notes for store invoices | Not established | No table, routine, route, permission, audit kind, wire word or shop text exists. Nothing defines a credit-note number series or a partial-credit tax rule |

None of this is a claim about any jurisdiction's invoice, credit-note or tax rules.

## 3. Decision notes

The decision table itself is §11. These notes give each decision's detail.

**D-CN-1. The first slice.** As §1. The new records live in their own schema (for example `tmpos_invoice_credit_note`), append-only, with a composite foreign key onto 034's `issued_invoice_scope_key`, as 035's void and 036's payments do. Recommended: **A**, the slice in §1. Rejected, not designed in this pack (choosing either returns the pack for a new design): **B** A plus refunds (needs G-PCI's refund lifecycle and an owner refund policy, [15](./15-m7b-invoice-payment-recording-decision-pack.md) D-PAY-4); **C** A plus cross-invoice or reusable credit (needs a customer-balance model that does not exist).

**D-CN-2. The money model.** An AMENDMENT (CN-A1, CN-A2 in §6).
- **For an issued invoice:**
  - total = `total_cents`, unchanged;
  - credited = the sum of gross amounts of credit notes with no withdrawal;
  - paid = the sum of payments with no reversal, as today;
  - remaining = total − credited − paid, in `numeric`, never stored, never negative.
- **For a voided invoice:** the amounts read's fields (due, credited, paid, remaining) are 0, as today (`036_m7b_invoice_payment.up.sql:1645-1651`); the invoice's own Total is not changed and stays on the issued snapshot. D-CN-3 guarantees a voided invoice holds no active credit.
- **Invariant I-CN:** credited + paid ≤ total. Only two writers increase the left side: recording a payment and issuing a credit note. Both must check the bound under the same issued-header FOR UPDATE, under READ COMMITTED, re-reading both sums in separate statements after the lock (the pattern of `037_m7b_invoice_payment_registration.up.sql:1079-1082`, `:1144-1150`). The decreasing writers (payment reversal, credit-note withdrawal) can never break I-CN.
- **Consequence (CONDITIONAL).** The live payment cap counts only payments, so it must count credits too: 038 adds a replacement record routine and revokes `tmpos_app`'s EXECUTE on 037's `record_v2`, as 036 and 037 did. The payments read's `data_corrupted` check, the HTTP decoder (`server/runtime/invoicePayments.ts:411`) and the shop decoder (`src/tenant/invoiceIssuingClient.ts:731`) change together. So the server and the shop's decoders deploy as one unit, the lesson of exact decoders on both sides ([13](./13-m7b-invoice-void-and-correction-decision-pack.md) §3.3). 038 also revokes `tmpos_app`'s EXECUTE on 036's `m7b_invoice_payments_get` (`036_m7b_invoice_payment.up.sql:1728`), which counts no credits, and grants a replacement read. That read stays STABLE on one snapshot, as 036's is (`:1585-1587`, "STABLE IS LOAD-BEARING"); only the writers use separate statements after their locks.
- **Drained cutover (REQUIRED).** An old `record_v2` or `void_v2` call admitted before 038 commits could resume after a credit commits and apply logic that counts no credits. The operational steps, the migration-enforced checks and the insert-time barrier that close this are in [038 cutover](#038-cutover-cn-34); the barrier is part of the recommended bundle.
- **Corruption raises (CONDITIONAL).** The replacement read raises `data_corrupted` when a voided invoice has an active credit note or an unreversed payment, and when active credited + paid exceeds the Total (CN-35).
- **How the read shows it (the owner's choice):**
  - **A (recommended)** the payments read gains an explicit `creditedCents`: `amounts` becomes `{currency, dueCents, creditedCents, appliedCents, remainingCents}`, with `dueCents` still the Total. An old shop's exact decoder rejects the new key and shows the read as unavailable; it never shows a wrong amount. Because the shop labels `dueCents` "Amount due" (`src/tenant/ServerIssuedInvoices.tsx:3786`), CN-P1 relabels that row "Invoice total" and adds a "Credited" row in the same deployable unit (display only), so the shop never shows the Total as an amount due after a credit. **Voided invoices:** the snapshot shows "Total" (`ServerIssuedInvoices.tsx:3772`, rendered at `:4675`) while the amounts rows show $0.00 today (`:3784-3791`); under A the shop shows only "Payment status: Voided" and hides the amounts rows, so no "Invoice total $0.00" appears under the snapshot Total (CN-37).
  - **B** fold credits into "due": `dueCents` = Total − credited, keeping today's equation. The old shop would accept it silently and show a smaller "Amount due" with no credit named. B still amends ADR-52 decision 1 (CN-A1-B); it does not avoid an amendment.
  - **C** credits only on their own read, remaining unchanged. Rejected: two reads would disagree about what is owed.
- **Status words (owner choice of wording).** Keep the five words where they still fit. Add `credited_in_full` (credited = total, nothing paid) and `settled_by_payment_and_credit` (remaining 0, both credited and paid above 0). Precedence: `voided`, `nothing_due`, then by remaining and by which of credited and paid is above 0. A partly credited invoice with no payment keeps `no_payment_recorded`; the amounts show the credit. Proposed shop labels: "Credited in full", "Settled by payment and credit". No word says "Paid", "Unpaid" or "Refunded".
- **What stays.** The Total is never relabelled (on a voided invoice only the amounts read's fields are 0); the issued list and detail answers and `snapshotVersion` 1 are unchanged (ADR-50 decision 1, line 1500; A1, line 1534). A credit note is a separate record, as ADR-50 decision 1 requires.

**D-CN-3. Behaviour by invoice state, and the void.** See the matrix in §4.
- **Unpaid** (paid 0): a credit of 1 to remaining is allowed.
- **Partly paid**: 1 to remaining.
- **Remaining 0**, whether by payments, credits or both: refused with the sealed 409 `amount_exceeds_remaining`. An overcharge on a fully paid invoice needs a refund, which is DEFERRED. A genuine payment must never be reversed to make room for a credit (ADR-52 decision 4, line 1605).
- **Total 0**: refused the same way (remaining 0), as payments are ([15](./15-m7b-invoice-payment-recording-decision-pack.md) §4).
- **Voided**: refused with the sealed 409 `invalid_state`.
- **Credit above remaining:** refused whole and sealed. No partial application, no clamping.
- **What a refusal writes.** A refusal writes no credit note, number, registration-state change or audit row; a sealed 409 commits only its idempotency completion. The payment routines likewise write their audit record only after their last refusal ([10](./10-architecture-decision-records.md) ADR-52 decision 8, line 1609). One exception: for a store created after 038, the issue routine inserts the store's empty counter row before the clock read, and a refusal may commit that row (no number) (D-CN-6).
- **The void (AMENDMENT CN-A3).** A replacement void routine (v3) refuses while any active credit note exists, with a new sealed answer `credit_notes_recorded`, checked after `payments_recorded` ([13](./13-m7b-invoice-void-and-correction-decision-pack.md) line 138 already requires each integration to bring its own void rule). Options:
  - **A (recommended)** refuse. The operator withdraws the credit notes first (only if they were wrong) or keeps the invoice.
  - Rejected, not designed in this pack (choosing either returns the pack for a new design): **B** allow the void and treat credits as moot (a voided invoice would carry active credits, and reporting would be ambiguous, since the void records no tax reversal and reporting is deferred); **C** the void withdraws credits automatically (it hides a money fact inside a void).
- **No conflict with adopted text.** ADR-51 decision 1 says "A void records no refund, credit note, tax reversal or erasure" (line 1543). Under A that stays true: the void still records none and refuses while one is active.

**D-CN-4. Tax allocation.** EXISTING: one rate per invoice, tax once on the subtotal, half-up; no line tax exists to reverse. The repository has no partial-credit tax rule.
- **A (recommended).** Staff enter the **gross** credit G (what lowers the remaining amount). The routine splits it, fixed at issue and stored:
  - t = clamp( roundHalfUp( tax × (aG + G) / T ) − aT, 0, G ), and net = G − t;
  - T and tax are the invoice's; aG and aT are the gross and tax of the invoice's **active** credit notes; arithmetic is exact (in SQL, `div(2 × tax × (aG + G) + T, 2 × T)` in `numeric`), computed under the header lock;
  - under `none`, t = 0.
- **INTERIM, not tax-validated.** A is an engineering rule, not a tax opinion. Deployment needs F-2; implementation may proceed at rework risk.
- The split is computed only after the bound check, which already refuses a Total of 0, so T > 0 whenever it runs.
- **What A guarantees.** 0 ≤ t ≤ G always. While no credit has been withdrawn, the cumulative credited tax equals the proportional share of the cumulative gross, rounded once, so cents do not drift. Whenever active gross reaches T, active tax equals the invoice's tax exactly (§5, E5 and E12).
- **The clamp** engages only after a withdrawal has left the active credits off their proportional share, at the lower bound (§5, E16) or the upper bound (E17, where the clamped credit is all tax). It keeps every split in bounds; it may not restore proportion immediately (in E16 proportion returns one credit later), and exactness is guaranteed when active gross reaches T.
- **Evidence, not proof.** The §5 script sampled 72,591 credits with random withdrawals: 0 bound violations, 0 full-credit tax mismatches, the clamp engaged once. In 20,000 random sequences without withdrawals, cumulative tax equalled the once-rounded share after every credit. Every two-credit split for subtotals below 300 at five rates: 0 violations. CN-17 requires a property test in CN-P1.
- **B** staff enter the **net**; tax = 034's formula on the net. Rounding each credit separately makes the credits' cumulative net and tax split differ from the invoice's (E15: net 10,001 and tax 887 against the invoice's 10,000 and 888), and can refuse a final credit by a cent.
- **C** no split (gross only). No taxable allocation is recorded, so tax reporting for credits would be undefined (moot under `none`).
- **D** line-level credits. Out of slice; lines carry no tax.
- **Approval needed:** the owner, and a written F-2 reviewer sign-off on the split algorithm, the clamp and the rounding included (CN-30). Deployment needs F-2; implementation may proceed at rework risk.

**D-CN-5. Correction.**
- **A (recommended).** Append-only, whole-credit withdrawal with closed reasons, no edit, no back-dating; then issue a correct new credit note. A withdrawal raises remaining and is always safe for I-CN.
  - Withdrawal reasons, closed: `entered_in_error` ("Entered by mistake"), `wrong_amount` ("Wrong amount"), `wrong_invoice` ("Wrong invoice").
  - **A withdrawal reopens a debt, with no time limit,** even after the customer settled the rest. Sub-choice: **no limit** (recommended for the first slice, named here as a residual) or **a time window**. (Under D-CN-7 A only the store owner withdraws anyway.)
  - A needs F-2 review before deployment: some jurisdictions may require an offsetting document rather than a withdrawal (D-CN-10).
- **B** no correction. A wrong credit could never be undone.
- **C** editable credit notes. Destroys history.
- **Issue reasons**, closed, no free text (the free-text exclusion of [15](./15-m7b-invoice-payment-recording-decision-pack.md) line 157): `pricing_error` ("Pricing error"), `service_issue` ("Service issue"), `goodwill` ("Goodwill"), `billing_error` ("Billing error"). `goods_returned` is left out: the slice moves no stock. The list is provisional until F-2 says whether a credit for a given reason (for example `goodwill`) adjusts tax at all.
- **Record shapes (CONDITIONAL, names fixed at CN-P1).**
  - Credit note: id (the runtime's new id), tenant, store, invoice (composite foreign key), `attempt_id` unique per (invoice, tenant, store), number, gross, tax, net, reason, `issued_at` (`clock_timestamp()` after the last lock, never before the invoice's `issued_at`), `issued_by` (shown only as a display name, D-CN-7).
  - Row-local CHECKs: gross 1 to 2^53 − 1; gross = tax + net; tax ≥ 0; net ≥ 0; number ≥ 1; reason in the closed list (and the withdrawal reason in its list). A CHECK cannot read the parent invoice.
  - **Refusal versus invariant.** Only the bound is a refusal (`amount_exceeds_remaining`). The parent-invoice conditions that D-CN-4 A guarantees by construction (active credit tax ≤ the invoice's `tax_cents`; active credit net ≤ the subtotal; tax = 0 under `none`) are invariants: the issue routine re-checks them under the header lock and raises `data_corrupted` with fixed text if one fails (CN-17).
  - Withdrawal: the credit note's id as primary key (at most one), scope columns with a composite foreign key onto the credit note, reason, `withdrawn_at`, `withdrawn_by`.
  - Both insert-only behind ENABLE ALWAYS guards that refuse UPDATE, DELETE and TRUNCATE and, at insert, a foreign scope and back-dating (`issued_at` before the invoice's `issued_at`; `withdrawn_at` before the credit note's `issued_at`), as 036's guards do.
  - **Provisional shape.** This record shape is provisional: CN-P1 may ship it at rework risk. An F-2 outcome that needs new columns (D-CN-10's list) is a later additive migration (039 or after), never an edit of 038.

**D-CN-6. Numbering.**
- **A (recommended).** A separate per-store credit-note series from 1, with its own locked counter row (the pattern of `034_m7b_invoice_issue.up.sql:326-336`), displayed with a prefix such as "CN-". The number is taken after the last refusal, so a refusal uses no number. No gaplessness is promised, as for invoices (ADR-50 decision 3, line 1502). A withdrawal keeps its number.
- **B** id only, no number.
- **C** share the invoice series. One series for two kinds of document breaks the invoice series' meaning.
- **Counter rows.** 038 creates one counter row per existing store. For a store created after 038, the issue routine inserts the row before the clock read; that empty row (no number) is the one write a refusal may commit.
- **Approval needed:** F-2 review of numbering ([12](./12-m7b-invoice-issue-decision-pack.md) line 227 lists the jurisdiction-dependent options). Deployment needs F-2; implementation may proceed at rework risk.
- G-PERF: a per-store counter serializes credit notes of one store, as invoice numbering does ([12](./12-m7b-invoice-issue-decision-pack.md) line 103).

**D-CN-7. Authorization.**
- **A (recommended): the store owner only.** Issuing and withdrawing require the **store-scope** store owner (`store_owner`) of that store, decided by **role**, not by level:
  - three store keys, each parent `invoices`, threshold `full` (recorded, not compared: the owner is Full, never stored, so the level checks are vacuous for the owner), no corequisite, decided by role through a new store-branch owner rule that mirrors the tenant `OWNER_ONLY_ROUTE_PERMISSIONS` (`server/platform-identity/m5CanonicalPermissions.ts:232`, decided by role at `:542-546`):
    - `issue_invoice_credit_notes`, sensitive: register and issue;
    - `withdraw_invoice_credit_notes`, sensitive: withdrawal;
    - `recover_invoice_credit_notes`, not sensitive: proof, attempts lookup and settlement. These move no value, and the revalidator refuses a command under a sensitive key without a sign-in deadline (`server/composition/tenantAuthorization.ts:343-345`); the tenant owner rule is sensitive (`m5CanonicalPermissions.ts:253-257`), and payments avoid this only because `record_invoice_payments` is not sensitive (`:324-326`);
  - today the store branch decides by level only (`:520-530`) and its load guard refuses Full (`:124-127`, `:343-368`), so a store key compared at Full would admit every role whose Invoices level is Full, the `manager` by default (`permissionCatalog.ts:497-498`). Full is not owner-only;
  - kept: store scope, the level checks (Invoices ≥ Approve, Customers ≥ View; the owner is Full, never stored, `036_m7b_invoice_payment.up.sql:684-686`), the recent sign-in (10 minutes) at register, issue and withdrawal (the [recovery contract](#cn-p1-recovery-contract-d-cn-9-a) explains why at register) and the routine-written audit (D-CN-8 A);
  - in the database, the routines require `v_role = 'store_owner'` from the session's single store-scope membership at that store (the derivation of `036_m7b_invoice_payment.up.sql:622-670`; 037 already branches on the role, `037_m7b_invoice_payment_registration.up.sql:1087`), so a manager's direct call is refused. Every recovery routine, proof and lookup included, re-checks the role;
  - reading credit notes uses `view_issued_invoices`.
- **Store-scope only (owner decision).** A tenant-scope owner never selects a store route (`server/composition/tenantAuthorization.ts:269`), while issuing settings require a tenant-scope owner (`034_m7b_invoice_issue.up.sql:1102-1122`). So the person who configures issuing may not be able to credit unless they also hold the store-scope owner membership of that store.
- **Provisioning prerequisite (owner decision in §10).** No supported workflow creates a store-scope `store_owner` membership: under `server/`, no `user_membership` INSERT exists outside the migrations and the development seed (a grep), and the tenant runtime role cannot write memberships (`005_principal_separation_rls_foundation.up.sql:303-304`: grant issuance is a platform operation); the existing residual is DA-126 ([09](./09-roadmap-m0-m9.md) line 279); tenant and store provisioning is M7h work ([09](./09-roadmap-m0-m9.md) line 86); the only sources are the DEV seed's commented step 4c (`server/platform-identity/seeds/dev_bootstrap_platform_owner.example.sql:83-92`, DEV ONLY at `:4-5`), the interactive QA fixture (`tests/qa/interactive/fixtures.mjs:99-104`) and DB-test grants. The runtime accepts one: admission accepts any tenant or store grant (`server/persistence/postgresTenantAdmission.ts:232-236`); a store route needs exactly one store-scope grant at the path store (`server/composition/tenantAuthorization.ts:267-270`); two roles at one store are ambiguous and denied (`027_m7b_store_access.up.sql:23-24`); the shop lists stores from `GET /api/v1/stores` and the user picks one (`src/tenant/invoiceDraftsClient.ts:75`, `:627`; `src/tenant/ServerIssuedInvoices.tsx:1353`, `:1391`).
  - Until M7h: an owner-approved, recorded SQL procedure inserts exactly one active (`store`, `store_owner`) membership per crediting owner per store, with `tenant_id` set to the store's tenant (otherwise admission drops the grant, `007_m5_trusted_principal_resolution.up.sql:261`); no second role at that store; the tenant-scope grant is kept if the same person configures issuing settings (`034_m7b_invoice_issue.up.sql:1102-1122`). A session acts only while its principal's admission still digests to the standing it was minted at (`027_m7b_store_access.up.sql:18-20`), so existing sessions stop matching and the owner signs in again.
  - Options: an interim owner SQL procedure, or hold credit notes until M7h provisioning. The gap is not new: tenants, stores and tenant-scope owners have no product path either.
- **The manager.** With Invoices Full by default (ordering `manage < approve < full`, `src/authorization/permissionFamilies.ts:27`), the manager can record and reverse payments today; it gets 403 on every credit-note mutation and recovery route over HTTP and a refusal on a direct call (CN-10b).
- **Attribution visibility.** The credit-note list routine derives the role from the session key and returns the issuing and withdrawing staff member's `display_name` (`public.app_user.display_name`, `002_authorization_audit_foundation.up.sql:76`, nullable) to the store owner only; for anyone else it omits the name field entirely (absent, not null). Only an owner-visible null renders the fixed text "Name not set". Never an id or an email. No other read returns staff names, as no payments read does today (`036_m7b_invoice_payment.up.sql:1562-1583`).
- **Remaining risks (named, not closed):**
  - several owners per store are possible (`user_membership` is unique only per user, scope, tenant, store and role, `002_authorization_audit_foundation.up.sql:188-189`), so owner-only is not one person;
  - an owner account can be compromised, and an owner can self-deal;
  - DA-118: a direct call with an owner's minted key is audited under D-CN-8 A but passes no HTTP check; and an issuer-key holder can mint a key for any principal ([08](./08-production-gate-and-risk-register.md) line 408; DA-93, DA-94), so "store owner" in the database is not proof of the person, and the displayed name is not proof of the actor;
  - DA-119 does not widen a role rule (levels are not what decides);
  - no server path writes memberships (a grep-based reading; the only insert found is the development seed `server/platform-identity/seeds/dev_bootstrap_platform_owner.example.sql`): who becomes owner is out-of-band provisioning.
- **B** delegation beyond the owner (to managers or others): an explicit option that needs its own control design (approver, thresholds cumulative per invoice, actor and period). Not designed here.
- **Not on Refunds.** Refunds is plan-gated and has no server-stored level, so a key parented on it denies every role (`permissionCatalog.ts:208`; `m5CanonicalPermissions.ts:494-496`).
- **What A needs (CONDITIONAL).** No role-data migration and no D2/D3 grant-diff change; the store branch gains the owner rule and its load guard admits the three keys by name (CN-I1).
- **Tenant and store scope.** Definer routines take the session key, the path's store and an expected tenant (as `037_m7b_invoice_payment_registration.up.sql:684` does). They derive actor and tenant from the key; the store argument is only a requested target that must match the key's single store grant, and the expected tenant is only a precondition. Another store's or tenant's invoice is the same 404. HTTP adds the CSRF header `x-tmpos-session-csrf`, `idempotency-key` (24 h), and the existing per-client limit only.

**D-CN-8. Audit and direct calls.** The full note is §7. Recommended: **A**, the routines write their own audit record, as payments do.

**D-CN-9. Concurrency, duplicates, replay and recovery.**
- **Waits first, then time, then checks.** Every wait comes before the clock is read: the issued header FOR UPDATE; key 530030 SHARED with the levels re-read (the store owner takes none, `036_m7b_invoice_payment.up.sql:729-731`); the proof key FOR SHARE and the registration FOR UPDATE (D-CN-9 A); the per-store counter row FOR UPDATE. Then session expiry and the recent sign-in on one `clock_timestamp()` reading after the last wait (the template of 036's reversal step 7, `036_m7b_invoice_payment.up.sql:1133-1144`), plus the TypeScript re-check on the database clock after the routine (`server/persistence/postgresSessionStore.ts:417-423`, used at `postgresInvoicePayments.ts:134`). Then each check as its own statement; then the counter increment and the insert. Locking the counter consumes no number, so a refusal still uses none. Non-READ COMMITTED is refused (55000). 037 itself checks only expiry, not a recent sign-in (`037_m7b_invoice_payment_registration.up.sql:1100-1105`).
- **The one precedence list for a credit-note issue (D-CN-9 A).** §4 and CN-04 to CN-07 refer to this list.
  1. HTTP, before the routine: authentication; authorization (the owner keys, D-CN-7); then idempotency. Register and issue are session-bound store commands, as 037's register and record are (`server/runtime/routes.ts:80`, `:522-525`): the fingerprint includes the presenting session's digest (`server/runtime/idempotency.ts:436`; `server/runtime/app.ts:1073-1076`). A replay of register or issue requires all of: the **same session**, the same idempotency key and the same request bytes; current authorization, because session admission and the route authorizer run on every request before idempotency is consulted (`server/runtime/app.ts:933`, `:948`), so a revoked grant, role or store access is refused (401 or 403) and never replayed; and a sign-in that still satisfies the 10-minute freshness check, because register and issue require a recent sign-in and a stale one is 403 `step_up_required` before idempotency is consulted (`server/runtime/app.ts:976-979`; the replay is returned only at `:1092`). The 24 h is how long the completion record is retained, not a replay window: in practice a replay is possible only within 10 minutes of the sign-in. From a renewed session, while the original completion is still retained and the preceding checks pass, the same key and bytes are 422 `idempotency_key_reused` (as `tests/db/invoicePaymentRegistrationHttp.integration.test.mjs:781-786` shows for payments). After the same preceding checks, the same key with another body is 422 `idempotency_key_reused`, and the same key while the first send is in progress is 409 `request_in_progress`.
  2. Routine, refusals before any wait is judged: caller, role and write statuses (`active`, `trialing`; G-STATUS) → `refused`; tenant precondition → `tenant_mismatch`; header → `not_found`.
  3. The waits (proof key FOR SHARE, `037_m7b_invoice_payment_registration.up.sql:1094-1095`; registration FOR UPDATE, `:1109-1114`; counter row), then expiry and recent sign-in → `refused`.
  4. The scope checks together: registration id, session digest (a renewed session), key generation (a rotation), not-the-same-transaction and proof MAC; any mismatch → `not_found` (`:1119-1129`).
  5. Then state, each its own statement: a registration that already carries a credit note (issued or confirmed) → `already_issued` (as `:1132` tests the payment link); a released registration → `invalid_state` (`:1136-1139`); on an open registration, bound values that differ from the registration's → `conflict` (see binding below); the attempt id already used by another credit note on this invoice → `already_issued`; voided → `invalid_state`; the bound → `amount_exceeds_remaining`.
  6. Counter increment; insert, registration link and audit.
  - Consequences: a settled registration presented from a renewed session, or after a key rotation, answers `not_found`, not its state word; the shop then uses the attempts lookup (not session-bound) and the settlement. The same registration presented again with a new idempotency key in the same session answers `already_issued`; with the original key and bytes, the sealed success is replayed only under step 1's conditions (same session, current authorization, a sign-in within 10 minutes); otherwise recovery follows "How the shop verifies the outcome" below.
  - **The credit-note register's answers** mirror 037's register (`037_m7b_invoice_payment_registration.up.sql:775-797`), on the caller's own rows: this attempt already carries a credit note → `already_issued`; any unsettled registration of the caller on this invoice → `conflict`; this attempt already registered and released → `invalid_state`; voided → `invalid_state`. Like 037's, it does not look at other staff members' attempts; a second owner's registration of the same attempt id is caught at issue (step 5, `already_issued`).
  - Unlike 037's `record_v2`, which checks voided (`:1140`), the amount (`:1144-1150`) and then an attempt taken by any payment (`:1153-1158`, answering `invalid_state`), the attempt check precedes voided and the bound, following [15](./15-m7b-invoice-payment-recording-decision-pack.md) §4 and 036's v1 order. Every writer of a credit-note registration row takes the invoice header first, as 037's do (`:55-56`).
- **Without registration (D-CN-9 B):** steps 1, 2 and 3 without the registration, then the attempt check (`already_issued`), voided, the bound, step 6.
- **Amount and reason binding (recommended; amends nothing adopted; differs from 037).** The registration binds `grossCents` and `reason`: the register body carries them, the row stores them and the proof message includes them. On an open registration the issue must present the same values, else `conflict`; a registration that already carries a credit note answers `already_issued` first. Changing the amount or reason means releasing the registration and registering again. 037 binds neither amount nor method (`037_m7b_invoice_payment_registration.up.sql:217`, the message at `:659-680`). If the owner chooses 037 parity instead, a new key on a still-open registration would issue the new amount; if the first send committed, the answer is `already_issued` and the first amount stands; a second credit is never possible either way. Binding adds two registration columns (D-CN-10's shape list). Owner line in §10.
- **Withdrawal order (CONDITIONAL):** as the reversal's ([15](./15-m7b-invoice-payment-recording-decision-pack.md) D-PAY-7): caller (store-owner role); header; the credit note by (id, invoice, tenant, store); expiry and sign-in after the last wait; already withdrawn (`invalid_state`); expected version other than 1 (`conflict`); insert and audit.
- **Kernel modes (CONDITIONAL).** Issue is a create on a credit-note aggregate (its kind joins `NOT_FOUND_CREATE_KINDS`); withdrawal is an update pinned at version 1 (its kind joins `PRECONDITION_UPDATE_KINDS`); `events: []`. The invoice is never the aggregate.
- **Duplicates.** The attempt id is unique per (invoice, tenant, store) and permanent. A new key reusing it is the sealed 409 `already_issued`, also after a withdrawal and after the 24 h key retention, the rule [15](./15-m7b-invoice-payment-recording-decision-pack.md) line 601 adopted for 036 (037's live order answers a taken attempt `invalid_state` instead).
- **Idempotency.** As step 1 of the precedence list above.
- **Lost reply.**
  - **A (recommended)** the [CN-P1 recovery contract](#cn-p1-recovery-contract-d-cn-9-a) below: its own registration table, a post-commit proof, an attempts lookup and a settlement, mirroring 037 routine by routine.
  - **B** same-key replay plus the credit-note list only. A credit note that is not in the list cannot settle an attempt that may still commit: the owner already decided that "A missing row does not resolve the attempt" ([15](./15-m7b-invoice-payment-recording-decision-pack.md) line 773).
  - A withdrawal needs no registration: like the P2C reversal, a read that finds the credit note withdrawn settles it.
- **How the shop verifies the outcome.** An uncertain outcome is never re-sent automatically.
  1. **While replay is available** (step 1's conditions: the same session, key and exact bytes, current authorization, and a sign-in within 10 minutes), a staff member may press "Check again" for a same-key replay. This is narrower than P2B's 23 hours ([15](./15-m7b-invoice-payment-recording-decision-pack.md) line 758) because recording a payment needs no recent sign-in and issuing a credit note does.
  2. **Once replay is unavailable** (a stale sign-in, 403 `step_up_required`; a renewed session; or a completion no longer retained), the authorized store owner uses the attempts lookup (not session-bound, `recover_invoice_credit_notes`, no recent sign-in) and then a deliberate settlement: **confirm** an attempt the lookup shows as issued (settlement at version 2), or **release** an unused open one (settlement at version 1), after which a late issue is the sealed 409 `invalid_state`.
  3. **A missing lookup result leaves the outcome unresolved.** It is never read as "not issued" ([15](./15-m7b-invoice-payment-recording-decision-pack.md) line 773); the owner looks again later and does not register a new attempt for the same intent until it is resolved.
  4. Then the shop re-reads the amounts and the credit-note list.

**D-CN-10. Retention, tax, numbering and jurisdiction.**
- **Interim default (A).** Nothing deletes or edits a credit note, a withdrawal or their audit records; 038's down refuses once any exists ([15](./15-m7b-invoice-payment-recording-decision-pack.md) D-PAY-9 A). This is not a retention policy.
- **Open questions, each "Not established" in the repository and tagged with what it blocks:**
  - F-2: whether a credit note is a separate legal document in the stores' jurisdictions. Blocks deployment;
  - F-2: whether an issued credit note may be withdrawn, or must be offset by a further document. Blocks D-CN-5 A's deployment;
  - F-2: required content: issuer legal name, address and tax id; customer details (the record snapshots none and relies on the foreign key to the invoice); tax rate and registration display. Blocks deployment and may add 038 columns;
  - F-2: copying the original invoice's number and date onto the credit note, or deriving them through the foreign key. Blocks 038's column list (rework risk);
  - F-2: date rules (the credit's tax period against the invoice's). Blocks deployment;
  - F-2: e-invoicing format mandates. Blocks deployment;
  - F-2: delivery to the customer, and tax-authority reporting. Blocks deployment;
  - F-2: numbering obligations (prefix, yearly series, registered range). Blocks deployment (D-CN-6);
  - F-5 and G-PRIVACY: the retention period and DSAR handling. Blocks live use;
  - currencies other than USD (none exist).
- **Unresolved items that could change 038's record shape:**
  - required credit-note content: issuer, customer, and the original invoice's number and date as snapshot columns (F-2);
  - whole withdrawal against an offsetting document (F-2);
  - numbering form: prefix, yearly series and so the counter's key (F-2);
  - tax by reason (F-2);
  - attribution: a name snapshot column, or a join to `app_user` at read time;
  - proof-key reuse, or a separate key (a second key table and generation reference) — decided by the owner (§10);
  - amount and reason binding: two registration columns — decided by the owner (§10);
  - retention and erasure (F-5, G-PRIVACY);
  - delegation controls beyond the owner (approver columns, D-CN-7 B).
- **F-5 and DA-187 must widen.** Both are worded for drafts, issued invoices and payments; before live use they must cover credit notes, withdrawals and their audit rows.
- **Personal data.** `issued_by` and `withdrawn_by` identify staff; through the invoice, a credit note links to the customer's name in the snapshot. Blocks: live use (G-PRIVACY). Append-only records and a down that refuses sit in tension with erasure duties; [05](./05-canonical-data-ownership-and-api-db-contracts.md) §6 (line 547) asks for a per-domain retention policy and legal hold, which credit notes would need.

**D-CN-11. Slice plan.**
- **A (recommended):**
  - **CN-P1** server: migration 038 (credit-note and withdrawal tables, counter, issue and withdraw routines, replacement record routine, void v3, the replacement amounts read, registration if D-CN-9 A); HTTP routes (issue, withdraw, list per invoice, and the recovery routes under D-CN-9 A; eligibility reads are excluded from CN-P1); and, in the **same deployable unit**, the shop's decoder change plus the display changes of D-CN-2 A ("Invoice total" and "Credited" rows; amounts hidden on a voided invoice) and the fixed `credit_notes_recorded` void message, with no issue or withdraw controls.
  - **CN-P2** the shop's issue control and recovery.
  - **CN-P3** the shop's withdrawal control.
- **B** one stage.

**D-CN-12. Separation of duties and limits.**
- **The manager path is closed under D-CN-7 A.** A `manager` with Invoices Full can still record and reverse payments, but cannot credit, so it can no longer record part of a payment and credit the rest, or reverse a real payment and credit it.
- **The owner residual.** The store owner can do both. Credits are unbounded up to 100 % of the Total and unlimited in count. A hijacked owner session inside the 10-minute sign-in window could credit every open invoice of the store.
- **A (recommended for the first slice)** no threshold. The owner residual is named and accepted explicitly under G-OBSERVE; the database's "store owner" is whoever the session key names, and an issuer-key holder can mint one for anyone (DA-93, DA-94), so neither the role nor the displayed name proves the actor; the credit-note list shows the issuing and withdrawing staff member's display name to the store owner (D-CN-7); a per-store credit-activity read is planned for CN-P2.
- **B** a second approver for every credit.
- **C** a credit-specific limit per owner, or above a share of the Total.
- **D** a periodic owner review report as a required operational step.
- Any future threshold must be cumulative per invoice, actor and period, so splitting one credit into several cannot dodge it.

### CN-P1 recovery contract (D-CN-9 A)

Normative under D-CN-9 A; referenced from §8 (CN-07a, CN-21, CN-36) and the recommended slice. Names are CONDITIONAL; shapes are fixed. In this subsection and the next, `037:N` is `037_m7b_invoice_payment_registration.up.sql:N` and "037 down" is its `.down.sql`.

- **Its own table.** 038 adds `…invoice_credit_note_registration` in its own schema. It does not share 037's table: 037's row has no kind column, and its attempt key and unsettled slot are per invoice and staff member (`037:197`, `037:209-211`), so a payment and a credit-note registration by one staff member on one invoice would collide.
- **Operations**, each mirroring a 037 routine, with the store key that authorizes it (D-CN-7 A):

  | Operation | Route (CONDITIONAL) | Body or query | Key | 037 template |
  |---|---|---|---|---|
  | Register | `POST …/invoices/{id}/credit-note-registrations` | `{expectedTenant, attemptId, grossCents, reason}` (amount and reason bound, D-CN-9) | `issue_invoice_credit_notes` (sensitive) | `037:683` |
  | Post-commit proof | `GET …/invoices/{id}/credit-note-registration-proof?registration=<id>` | the query only | `recover_invoice_credit_notes` | `037:867` |
  | Issue | `POST …/invoices/{id}/credit-notes` | `{expectedTenant, registrationId, attemptId, grossCents, reason, registrationProof}` | `issue_invoice_credit_notes` (sensitive) | `037:996` |
  | Attempts lookup | `GET /api/v1/stores/{storeId}/credit-note-attempts` | keyset cursor | `recover_invoice_credit_notes` | `037:1243` |
  | Settlement | `POST …/invoices/{id}/credit-note-settlement` | `{expectedTenant, attemptId, expectedVersion: 1 or 2}` | `recover_invoice_credit_notes` | `037:1342` |

- **Terms.** A registration is **released** (unused; settlement at version 1) or **confirmed** (a credit note was issued; settlement at version 2). 037 calls its unused settled state `withdrawn` (`037:1313`, `:1447`); this pack says "released" for credit-note registrations so that **withdrawn** is used only for a credit note.
- **States.** Open (version 1) and issued (version 2) hold the slot; released and confirmed (version 3) are terminal. The lookup lists every unsettled row and settled rows for 24 hours (`037:1328`). A missing credit-note row is never terminal.
- **Authorized caller.**
  - Only `tmpos_app` has EXECUTE. Every recovery routine, proof and lookup included, re-checks the store-owner role in the database (037's proof and lookup use a level reader instead, `037:917`, `:1290`).
  - Proof, lookup and settlement match only the caller's own registrations, as 037's do (`037:933`, `:1299`, `:1327`, `:1428`). Two owners of one store cannot see or settle each other's registrations.
  - Proof and issue require the registering session's digest (`037:939-941`, `:1119-1121`). A reauthentication creates a new session (`server/persistence/postgresSessionStore.ts:48-50`), so the recent sign-in is required at **register** (the shop steps up before registering) and again at issue; proof, lookup and settlement need none, which is why they sit under a non-sensitive key (the revalidator refuses a sensitive key without a deadline, `server/composition/tenantAuthorization.ts:343-345`).
  - Residuals: if the sign-in lapses between register and issue, the issue is 403 `step_up_required`; after reauthentication the issue is `not_found` (a new session digest), so the owner releases the registration and registers again. An owner later demoted can no longer list or settle their own registrations; that is safe, because the issue re-checks the role.
- **Exact attempt binding.** A registration binds the registration id, tenant, store, invoice, `registered_by`, attempt id, session digest, key generation, registering transaction and, under the recommended binding, `grossCents` and `reason` (both in the proof message); unique per (invoice, tenant, store, staff member, attempt); at most one unsettled per (tenant, store, invoice, staff member). The issue checks the id, digest, not-the-same-transaction (`pg_current_xact_id()`), generation and MAC together, else `not_found` (`037:1119-1129`).
- **Durability prerequisite.** The proof routine requires `fsync` on and the WAL alignment check, samples the insert LSN after reading the committed registration and waits for the flush LSN to pass the record's end; `not_durable` makes the port commit and retry once (`037:945-976`; `server/persistence/postgresInvoicePayments.ts:439-473`). It proves neither money nor a credit, and does not cover an asynchronous-standby failover (`037:62-64`).
- **Proof key (owner line in §10).** Recommended: reuse 037's owner-installed key (read FOR SHARE) with a distinct label, `tmpos-m7b-invoice-credit-note-registration-proof:v1`. The credit-note message also covers `grossCents` and `reason` (the binding), so its layout is not the payment message's; the distinct label is kept as domain separation all the same. With it, a payment proof is never accepted for a credit note and a credit-note proof never by the payment record (037's label is at `037:669`).
  - Reuse means one owner-installed key. A rotation strands open payment **and** credit-note registrations alike: both answer `not_found` until released, and settlement still releases them, because it has no generation check (the proof requires the current generation, `037:934`; the record compares it, `:1123`). A rotation waits for in-flight record and register calls of both kinds (they hold the key FOR SHARE), and the startup gate is shared (`server/entry/tenantEntry.ts:367-376`).
  - A separate key means a second install and rotation step, a second startup check and a second key table in 038; payment registrations stay entirely uncoupled.
- **A refused issue.** A refusal writes no credit note, number, registration-state change or audit row; a sealed 409 commits only its idempotency completion (`server/persistence/postgresTransactionalStore.ts:897-908`); `not_found` rolls back (`:911`), and so does `tenant_mismatch`, mapped to `precondition_failed` (`server/persistence/postgresInvoicePayments.ts:101`; `postgresTransactionalStore.ts:872`). The one exception is D-CN-6's counter row for a store created after 038, which may commit empty (no number). The registration stays open and releasable, and blocks a second registration on that invoice by that staff member (`conflict`) until it is released (`037:782-786`). A late issue after release is the sealed 409 `invalid_state`; after confirmation, the sealed 409 `already_issued`. (`refused` is the 503 word for authority and expiry, never a state answer.)
- **Audit.** Register and settle write their own audit rows too (§7).
- **Rollback.** 038's down refuses, changing nothing, while any credit note, withdrawal, credit-note registration, audit row of an issue, withdraw, register or settle kind, or audit row naming either new subject column exists, as 037's down does (037 down :78-88, :83-85): one-way after the first registration, so durable recovery evidence is never dropped. Otherwise it drops 038's objects, the insert-time triggers included, and restores EXECUTE on 037's `record_v2`, 036's `m7b_invoice_void_v2` and 036's `m7b_invoice_payments_get` exactly, asserting the ACLs (037 down :95, :151-159). The preflight's ledger checksum and pinned grants move in lockstep.
- **Payment registrations created before 038.** 038 changes no 037 registration row or column, so such a registration completes through the replacement record routine while 038 is applied (the same table, key, label and message; CN-36), and through `record_v2` again after a rollback. While 038 is applied, that routine counts credits, so it can refuse `amount_exceeds_remaining` where `record_v2` would have recorded.
- **Correction of [15]'s wording.** For a settled registration with a matching proof, the record answers `invalid_state` (released) or `already_recorded` (confirmed), not 404 (`037:1132`, `037:1136-1139`); [15] line 747's "404 means no open registration matches" is narrower than the routine.

### 038 cutover (CN-34)

**Facts.**
- No tooling applies 034–037 to a managed database: the managed path adopts 001–004 and executes only 005 (`scripts/supabase-migrate.ts:287-294`), and the general executor reaches only a task-owned Unix socket or loopback (`server/platform-identity/migrationExecutor.ts:236`).
- "Runtime stopped" is documented only (`035_m7b_invoice_void.up.sql:113-116`, `036_m7b_invoice_payment.up.sql:62-64`, `037:58`, [15](./15-m7b-invoice-payment-recording-decision-pack.md) line 583).
- Each migration takes its ACCESS EXCLUSIVE locks first (`036_m7b_invoice_payment.up.sql:90-101`, `037:81-85`), and the runner sets a lock timeout per transaction (`server/platform-identity/migrationExecutor.ts:5244`), so a queued apply fails rather than waits forever.
- PostgreSQL checks EXECUTE when a call starts, and the preflight checks the ledger only at startup. So a call admitted before 038 commits keeps the old logic: one held at the 016 hold (`016_m5_tenant_session_ordering.up.sql:555`) or the session row (`037:548`), before its first table lock, could resume after a credit commits. And the routines' owner keeps EXECUTE on the retained `record_v2` and `void_v2` after 038.

**(a) The cutover runbook (planned text; an owner runbook that 038 cannot enforce).** No production runbook or template exists (only DEV and QA runbooks, [14](./14-interactive-qa-runbook.md)); G-INCIDENT is OPEN ([08](./08-production-gate-and-risk-register.md) line 278); and no tooling applies 034 or later to a managed database. So the tooling to execute this runbook is an implementation and deployment prerequisite (CN-38). Entry points are closed **before** remaining transactions are checked.

Apply:
1. **Freeze.** Record the start; no shop use.
2. **Close entry points.**
   - (a) Defence for live keys: suspend every affected **active** tenant through the audited `PATCH /admin/v1/tenants/status` (`server/runtime/tenantStatus.ts:4`, `:35`, `:60`). A suspended tenant's grants drop out of admission (`007_m5_trusted_principal_resolution.up.sql:257`, `:262`), which invalidates live session keys, direct DB callers' included (the digest re-check, `037:560-565`). Cost: reads stop too (`server/runtime/tenantState.ts:50`). Do not suspend `trialing` tenants this way: the route switches only active ↔ suspended (`server/runtime/tenantStatus.ts:12-18`), so lifting would turn them `active`; `trialing` also writes (`server/runtime/tenantState.ts:46`; `037:582-584`), and steps 2(b) and 2(c) cover it.
   - (b) Stop **both** runtimes: the tenant runtime and the admin/production entry, which uses the same `APP_DATABASE_URL` login and runs the same login and ledger checks (`server/entry/productionEntry.ts:194`, `:203`; `server/composition/transactionKernel.ts:47`, `:137`). Steps 2(b) and 2(c) are the closure; 2(a) is defence for live keys.
   - (c) Direct DB callers: for each login that is a member of `tmpos_app`, superusers aside (the runtime login named by `APP_DATABASE_URL`, `server/platform-identity/config.ts:87`; the role both session audiences share, DA-37, [08](./08-production-gate-and-risk-register.md) line 327; any DB test login), `ALTER ROLE … NOLOGIN` (revoking CONNECT from one login does nothing while PUBLIC holds CONNECT, the PostgreSQL default, and no migration revokes it; there is no repository precedent for either), then end existing backends with `pg_terminate_backend` (NOLOGIN does not end live sessions, a PostgreSQL fact; test-only precedent `tests/db/customerDetail.integration.test.mjs:145`).
3. **Check remaining transactions** (only after step 2): in the current database only, exclude superusers first, then count sessions of roles with `pg_has_role(r, 'tmpos_app', 'MEMBER')` (so inherited membership counts, not only direct `pg_auth_members` rows), idle-in-transaction included; the only session allowed is the applier's. This is a runbook check, not a migration check: `pg_has_role(…, 'MEMBER')` is true for every superuser, `pg_stat_activity` spans all databases, and the DB suites run a `tmpos_app` member login beside the applier (`tests/db/localPostgres.harness.mjs:15`; `tests/db/invoicePaymentRoutine.integration.test.mjs:359-362`).
4. **Apply 038**, after repeating the step-3 count immediately before (locks first, the runner's lock timeout); verify the ledger 001–038, the grants and the trigger sets.
5. **Reopen.** Restore LOGIN exactly (revoking the login's `tmpos_app` membership instead would fail the startup check, `server/persistence/postgresStartupPreflight.ts:27-31`); start both runtimes rebuilt for 001–038 (the preflight checks them); lift the suspensions (audited).

Rollback: steps 1–3, then one of:
- **Clean down**, only while no credit note, withdrawal, credit-note registration or credit-note registration audit row exists (payment-registration audit rows, which exist since 037, do not block it): 038's down runs, restores 037's and 036's routine ACLs exactly and removes 038's triggers; then reopen: restore LOGIN exactly, start runtimes built for 001–037, lift the suspensions.
- **After the first durable credit-note registration** the down refuses, changing nothing (one-way, as 037's is). Then: never delete or edit evidence; keep the database at 038; the tenant runtime stays stopped and tenants stay suspended until 039 (for a pause per tenant or store, status `read_only` set by owner SQL also works, only because 038's routines copy the write-status checks, G-STATUS; no route sets it); the admin runtime may restart only as a 038-built runtime, since it runs the same ledger check; recover **forward** with a 039 migration (for example revoking EXECUTE on the credit-note write routines, or a fix). A 037-built runtime refuses to start on a 038 ledger (`server/persistence/postgresStartupPreflight.ts:59`; [15](./15-m7b-invoice-payment-recording-decision-pack.md) line 583). Payment registrations: 038 changes no payment registration row or column, but while 038 is applied they complete only through the credit-aware replacement routine, which can refuse `amount_exceeds_remaining` where `record_v2` would have recorded, because credits now count.

**(b) Migration-enforced checks:**
- 038 first takes ACCESS EXCLUSIVE on the issued header, payment, void and registration tables, so any caller holding them drains, or the apply fails on the runner's lock timeout;
- an apply-time check that the applying principal owns, or inherits the owner of, every table the definers read or lock, as `037:163-175` does.

**(c) The deterministic barrier (in the recommended bundle, not a fallback):** ALWAYS BEFORE INSERT triggers, running as the definer owner:
- on `invoice_payment`: take the issued header FOR UPDATE (a no-op when the caller already holds it), re-sum active credits, unreversed payments and the new amount, and refuse above the Total;
- on the void table: take the header the same way and refuse while any active credit note exists;
- both raise `restrict_violation`, which the old routines already map to 23000 with fixed text (`037:1167-1170`; `036_m7b_invoice_payment.up.sql:1527-1530`).

Triggers fire at insert time whatever routine inserts, so only they catch every call after 038 commits, stale admitted calls and the routines' owner included. Nothing remains for I-CN and the active-credit void rule. 038's down drops them, and the payment and void tables' trigger sets equal 036's pinned sets again (`036_m7b_invoice_payment.up.sql:1900-1913`, `:143-147`).

**The stale-call seam, traced (CN-34s1, CN-34s2).** Claims marked PG are PostgreSQL semantics with no repository citation.
- A call to 037's `record_v2` or 036's `void_v2` passes its EXECUTE check when it starts (PG). Before its first lock on a table 038 locks (the header, `037:1079-1082`; `036_m7b_invoice_payment.up.sql:1449-1455`), it takes 016's hold, `app_user … FOR UPDATE` (`016_m5_tenant_session_ordering.up.sql:555`). A test that holds that row pauses the call after admission and before any 038 table. It must not pause on `issuer_key`, which the crediting owner's call takes too.
- While the call waits, it holds no lock 038 needs, so 038 commits (PG: RowShare conflicts only with EXCLUSIVE and ACCESS EXCLUSIVE). 038 must therefore lock none of `app_user`, `platform_identity`, the session tables or `issuer_key`; CN-34s1 and CN-34s2 assert this.
- After release, the call takes the header after the credit committed, and its own payments-only check passes. Its INSERT fires 038's trigger: the relation lock processes pending catalog invalidations (PG). The trigger locks the header itself (a no-op, the caller holds it) and re-sums in a separate statement; a VOLATILE trigger function takes a fresh READ COMMITTED snapshot per statement (PG), so it sees the credit, and raises `restrict_violation`, which the routines map to 23000 with fixed text (`037:1167-1170`; `036_m7b_invoice_payment.up.sql:1527-1530`).
- Over HTTP the seam is **not stageable**: the revalidator takes 016's hold and the session row before the routine is called (`server/composition/transactionKernel.ts:344-356`; `server/persistence/postgresTransactionalStore.ts:811-826`), so an `app_user` pause lands before EXECUTE, and the call then fails 42501, answered 503, not stale. An HTTP-path stale case is UNVERIFIED; it would need a post-EXECUTE pause point on the HTTP path (whether the session touch locks the actor's `tenant_session` row is unverified).

## 4. State and operation matrix

"Active" means a credit note with no withdrawal, or a payment with no reversal. The order of answers for an issue is the one precedence list in D-CN-9: after the header lock and the waits, the scope checks (`not_found`), then step 5 in its order: a registration that already carries a credit note (`already_issued`); a released registration (`invalid_state`); on an open registration, changed bound values (`conflict`); the attempt id already used by another credit note on this invoice (`already_issued`); voided (`invalid_state`); the bound (`amount_exceeds_remaining`). For each sealed answer, a same-key replay returns the same answer. "Remaining" is total − credited − paid (D-CN-2).

| Invoice state | Issue a credit note | Withdraw a credit note | Record a payment | Reverse a payment | Void | Amounts read |
|---|---|---|---|---|---|---|
| Issued, Total 0 (`nothing_due`) | 409 `amount_exceeds_remaining` | Not applicable | 409 `amount_exceeds_remaining` (unchanged) | Not applicable | Allowed | 200 with (credited, paid, remaining) = (0, 0, 0) |
| Issued, nothing active (`no_payment_recorded`) | Allowed, 1 ≤ G ≤ remaining | 409 `invalid_state` for an already withdrawn one | Allowed, 1 ≤ amount ≤ remaining | 409 `invalid_state` for an already reversed one | Allowed | 200 with (credited, paid, remaining) |
| Issued, credit active, remaining > 0 | Allowed, 1 ≤ G ≤ remaining | Allowed (recent sign-in); remaining rises | Allowed, 1 ≤ amount ≤ remaining (counts credits: CN-A2) | Allowed if a payment is active | **409 `credit_notes_recorded`** (CN-A3), or `payments_recorded` first if a payment is active | 200 with (credited, paid, remaining) |
| Issued, partly paid, no credit (`recorded_partly`) | Allowed, 1 ≤ G ≤ remaining | Not applicable | Allowed | Allowed (recent sign-in) | 409 `payments_recorded` (unchanged) | 200 with (credited, paid, remaining) |
| Issued, remaining 0 (`recorded_in_full`, `credited_in_full` or `settled_by_payment_and_credit`) | 409 `amount_exceeds_remaining` | Allowed if a credit is active | 409 `amount_exceeds_remaining` | Allowed if a payment is active | 409 `payments_recorded` or `credit_notes_recorded` | 200 with (credited, paid, remaining) |
| Voided (only withdrawn credits and reversed payments, by construction) | 409 `invalid_state` | 409 `invalid_state` (already withdrawn) | 409 `invalid_state` (unchanged) | 409 `invalid_state` (unchanged) | 409 `invalid_state` (unchanged) | 200 with (credited, paid, remaining) = (0, 0, 0), history kept |

Another store's or tenant's invoice, and a missing one, are the same 404 in every column.

## 5. Worked examples in cents

All figures come from `examples.py` in the stage's scratch directory (`.workflow/m7b-credit-notes-d1-p0/scratch/calc/`, outside the repository), run with `python3 -I`; every row below is asserted there. The script is not committed; a reader reproduces the figures through CN-18. Synthetic invoice **X**: subtotal 10,000 at an `exclusive_rate` of 8,875 (8.875 %); tax = div(10,000 × 8,875 + 50,000, 100,000) = 888; Total 10,888. Splits use D-CN-4 A. "Remaining" is after the row.

| # | Situation | Request(s) | Result | Credited / paid / remaining |
|---|---|---|---|---|
| E1 | Unpaid credit | Credit 2,000 | Issued: tax 163, net 1,837; word `no_payment_recorded` | 2,000 / 0 / 8,888 |
| E2 | Partly paid, then credit | Pay 5,000; credit 3,000 | Issued: tax 245, net 2,755; `recorded_partly` | 3,000 / 5,000 / 2,888 |
| E3 | Credit, then a payment at the cap | Credit 2,000; pay 9,000; pay 8,888 | 9,000 → sealed 409 `amount_exceeds_remaining`; 8,888 → recorded; `settled_by_payment_and_credit` | 2,000 / 8,888 / 0 |
| E4 | Fully paid | Pay 10,888; credit 1 | 409 `amount_exceeds_remaining`; a refund is deferred | 0 / 10,888 / 0 |
| E5 | Two credits to the full Total | Credit 4,000; credit 6,888 | Taxes 326 + 562 = 888 (exact); nets 3,674 + 6,326 = 10,000; `credited_in_full` | 10,888 / 0 / 0 |
| E6 | Withdraw, then re-issue | Credit 2,000 (tax 163); withdraw `wrong_amount`; credit 1,500 | After the withdrawal remaining is 10,888; the new credit: tax 122, net 1,378 | 1,500 / 0 / 9,388 |
| E7 | Credit above remaining | Pay 5,000; credit 6,000 | Sealed 409 `amount_exceeds_remaining`; no credit note, number or audit row written; only the sealed idempotency completion commits | 0 / 5,000 / 5,888 |
| E8 | Voided invoice | Void X; credit 500 | 409 `invalid_state` | 0 / 0 / 0 |
| E9 | Void with an active credit | Credit 2,000; void; withdraw it; void | First void → 409 `credit_notes_recorded`; after the withdrawal → voided | 0 / 0 / 0 |
| E10 | Tax mode `none` | Invoice of 10,000 (Total 10,000); credit 2,500 | Tax 0, net 2,500 | 2,500 / 0 / 7,500 |
| E11 | A 1-cent credit that is all tax | Seven credits of 1 on X; separately an invoice of subtotal 1 at 100,000 (100 %): tax 1, Total 2, credit 1 | On X the first six carry tax 0 and the seventh tax 1, net 0. On the second invoice the credit is tax 1, net 0 | X: 7 / 0 / 10,881 |
| E12 | Three credits to the full Total | 3,629; 3,629; 3,630 | Taxes 296, 296, 296 = 888; nets 3,333, 3,333, 3,334 | 10,888 / 0 / 0 |
| E13 | Credit and payment race | Credit 6,000 and pay 6,000 at once | Both lock X's header. Credit first: issued (tax 489, net 5,511), payment 409. Payment first: recorded, credit 409 | 4,888 remaining either way |
| E14 | Reversal after a credit | Pay 8,000; credit 2,888; reverse the payment | Before the reversal `settled_by_payment_and_credit`; after it `no_payment_recorded` | 2,888 / 0 / 8,000 |
| E15 | Option B's rounding (net entered) | Nets 1 and 9,999, then a further net 1; separately nets 400, 400 and 9,200 | Taxes 0 and 887 leave 1 cent, which the further net-1 credit (tax 0, gross 1) claims; the credits then total net 10,001 and tax 887 against the invoice's 10,000 and 888. In the second sequence taxes 36, 36 and 817 make the last gross 10,017 against remaining 10,016, so it is refused. Under A, the same gross amounts (1 then 10,887; 436, 436, then 10,016) give taxes 0 + 888 and 36 + 35 + 817 = 888 | First: 10,888 / 0 / 0 |
| E16 | The lower clamp | Invoice of subtotal 4 at 25,000 (25 %): tax 1, Total 5. Credit 2 (tax 0); credit 1 (tax 1); withdraw the first; credit 1; credit 1 | The unclamped value is −1; the clamp sets tax 0, net 1. The next 1-cent credit (tax 0) brings active gross 3 and tax 1, the once-rounded share again | 3 / 0 / 2 |
| E17 | The upper clamp | Invoice of subtotal 5 at 50,000 (50 %): tax 3, Total 8. Credit 1 (tax 0); credit 3 (tax 2); credit 2 (tax 0); withdraw the 3; credit 1 | The unclamped value is 2; the clamp sets tax 1, net 0 | 4 / 0 / 4 |

## 6. Proposed amendments and contract changes

**Amendments of adopted policy text** (each needs its own owner choice):

| # | Adopted text | Proposed change | Required owner decision |
|---|---|---|---|
| **CN-A1** | ADR-52 decision 1 (line 1602) and [15](./15-m7b-invoice-payment-recording-decision-pack.md) D-PAY-1: remaining = due − applied, due = the version-1 Total; five status words. ADR-50 decision 1 through A1 (lines 1500, 1534) | **CN-A1-A** (with D-CN-2 A): remaining = total − credited − paid; `creditedCents` is added and `dueCents` stays the Total. **CN-A1-B** (with D-CN-2 B): `dueCents` = Total − credited. Either adds two new words and amends ADR-52 decision 1. 038 replaces 036's `m7b_invoice_payments_get` and revokes `tmpos_app`'s EXECUTE on it. The Total, the issued reads and `snapshotVersion` 1 stay unchanged; nothing is stored on the invoice | Accept the variant that matches the D-CN-2 choice, as an explicit amendment, not a silent reinterpretation |
| **CN-A2** | ADR-52 decision 2 (line 1603) and D-PAY-2: a recording is 1 cent to "the remaining amount", checked against the Total | The payment cap counts active credits; 038 replaces 037's `record_v2` and revokes `tmpos_app`'s EXECUTE on it | Follows from CN-A1; needed for I-CN |
| **CN-A3** | ADR-52 decision 5 (line 1606), D-PAY-5 and A2/A3: a void is refused only while a payment is active; ADR-51 decision 8's refusal precedence and [13](./13-m7b-invoice-void-and-correction-decision-pack.md) §12, as ADR-52 amended them (line 1617) | A void is also refused while a credit note is active, with the new sealed answer `credit_notes_recorded`; void v3 replaces `m7b_invoice_void_v2`, whose EXECUTE is revoked | Accept; needed for D-CN-3 A (B and C are not designed here) |

**Checked, and not amended.**
- ADR-50 decision 1: credit notes are separate records; the Total is never relabelled.
- ADR-51 decision 1: the void still records no credit note.
- ADR-51 decision 6 (line 1548): correction by void and a fresh invoice stays available; a credit note is an additional route, not a replacement for it.
- ADR-52 decision 4 (line 1605): the "until refunds exist" limitation stands. A credit note does not return money.

**Contract changes at implementation** (not policy; each changes an adopted engineering contract and would be recorded in a CN-P1 ADR):
- **CN-I1.** The store branch of the canonical permission decision gains an owner-only rule (role `store_owner`, store scope, no limitation) for the three credit-note keys (`issue_…`, `withdraw_…`, `recover_invoice_credit_notes`), and the load guard admits all three by name.
- **CN-I2.** `ROUTINE_AUDITED_KINDS` gains the credit-note kinds (and the registration kinds under D-CN-9 A); `audit_event` gains two subject columns, `subject_invoice_credit_note_id` and `subject_invoice_credit_note_registration_id` (§7).
- **CN-I3.** The store gains a sealed slot for `already_issued` and `credit_notes_recorded`; `NOT_FOUND_CREATE_KINDS` and `PRECONDITION_UPDATE_KINDS` each gain one kind.
- **CN-I4.** 038 anchors 037 so 037 cannot roll back under it. It revokes `tmpos_app`'s EXECUTE on 037's `record_v2`, 036's `m7b_invoice_void_v2` and 036's `m7b_invoice_payments_get`; its down restores exactly those grants, so the 001–037 runtime starts again, and refuses while any credit-note evidence exists.
- **CN-I5.** The startup preflight's ledger (001–038) and approved grants, and their pinning tests, move in lockstep.

## 7. Direct-call prerequisite and audit

**The current state (EXISTING).** A `tmpos_app` holder with a live minted key can call definer routines directly, past idempotency, CSRF, rate limit and the chain's step-up ([08](./08-production-gate-and-risk-register.md) DA-118, line 408). The payment routines therefore write their own audit record; issue and void do not (`postgresTransactionalStore.ts:374-375`; [15](./15-m7b-invoice-payment-recording-decision-pack.md) §7).

**Is a credit note a "payment state transition"?** [05](./05-canonical-data-ownership-and-api-db-contracts.md) line 485 requires an audit record for every payment state transition. A credit note changes what remains to be paid, so this pack treats it as one. If the owner reads [05] otherwise, option B below applies.

**Option A (recommended): routine-written audit.**
- The issue and withdraw routines insert their own `audit_event` row after their last refusal and raise unless exactly one row was written, as `036_m7b_invoice_payment.up.sql:819-830` does.
- CONDITIONAL fields: kinds `store.invoice_credit_note.issue` and `store.invoice_credit_note.withdraw`; permissions the issue and withdraw keys; reason codes `invoice_credit_note_issued_<reason>` and `invoice_credit_note_withdrawn_<reason>`; fixed sentences with no customer, line or amount text; metadata `{}`; a new column `subject_invoice_credit_note_id`, as `036_m7b_invoice_payment.up.sql:471-472` added one for payments.
- **Register and settle (under D-CN-9 A).** The register and settle routines write their own audit rows as well, as 037's do: kinds `store.invoice_credit_note.register` and `store.invoice_credit_note.settle`; permissions `issue_invoice_credit_notes` and `recover_invoice_credit_notes`; reason codes `invoice_credit_note_attempt_registered`, `invoice_credit_note_attempt_released` and `invoice_credit_note_attempt_confirmed`; the same fixed fields; a new column `subject_invoice_credit_note_registration_id`, as `037_m7b_invoice_payment_registration.up.sql:478-486` added one for payment registrations. The issue's audit row names both subjects. 038's down refuses while any audit row names either new column, as `037_m7b_invoice_payment_registration.down.sql:83-85` does.
- The TypeScript writer's subject rule (`auditEventWriter.ts:439-448`) is not used for these kinds; it changes only under option B.
- **Apply-time check.** 038 checks that the routine owner can insert into `public.audit_event`, as 036 did ([15](./15-m7b-invoice-payment-recording-decision-pack.md) §7).
- **What A does not do** (the list [15](./15-m7b-invoice-payment-recording-decision-pack.md) lines 351-357 and [08](./08-production-gate-and-risk-register.md) line 408 record for payments):
  - a direct call still skips idempotency, CSRF, the rate limit and the chain's step-up, so credit notes **still widen DA-118, in an audited form** ([15] line 352);
  - the routine's own sign-in check does not close the class: an issuer-key holder mints the sign-in time with the key (DA-93, DA-94), so A proves neither the actor nor the correlation id;
  - once a key's 24 h completion is gone, a direct call's audit row looks the same as an HTTP one;
  - the runtime login can still forge audit rows through `tmpos_audit_writer` (DA-114, G-AUDIT);
  - void v3 stays unaudited on a direct call, like 035's and 036's voids; the amounts and credit-note reads join DA-132.
- **Residual: refusals leave no durable trace.** The audit row is written only after the last refusal (`036_m7b_invoice_payment.up.sql:819-832`), so a run of refused credits is invisible to audit. A G-AUDIT and G-OBSERVE residual.

**Option B: store-written audit.** The issue and void pattern. A direct call then commits an unaudited credit note; [05] line 485 would need an explicit amendment or a time-boxed waiver.

**Option C: a wider DA-118 remedy first.** Stronger, cross-cutting; credit notes wait for it.

DA-118 and DA-119 stay OPEN pre-deployment blockers, and DA-132 stays OPEN under G-DBROLE, whatever is chosen. Nothing here accepts or waives them. CN-P1 would amend their rows in [08](./08-production-gate-and-risk-register.md) and add DA-186 and DA-187 notes; this pack edits none of them.

## 8. CN-P1 boundary and acceptance matrix

**Scope (CONDITIONAL; for planning only, not implemented):**
- migration **038** (up and down, a new schema): the tables, counter, issue and withdraw routines, the replacement record routine, void v3, the amounts read change and, under D-CN-9 A, the registration;
- `POST /api/v1/stores/{storeId}/invoices/{id}/credit-notes` (issue; recent sign-in);
- `POST …/invoices/{id}/credit-notes/{creditNoteId}/withdrawal` (recent sign-in);
- `GET …/invoices/{id}/credit-notes` (the list: number, gross, tax, net, reason, time, withdrawal; staff display names to the store owner only, D-CN-7 A);
- under D-CN-9 A, the registration, proof, attempts and settlement routes of the [CN-P1 recovery contract](#cn-p1-recovery-contract-d-cn-9-a);
- the payments read's new `amounts` shape, and the shop's decoders for it and for `credit_notes_recorded`, plus the "Invoice total" and "Credited" display rows, the voided-invoice display rule (D-CN-2 A) and the `credit_notes_recorded` void message, in the same deployable unit.

**Naming constraint.** Schemas, tables, routines and audit kinds carry the `invoice_credit_note` qualifier, never a bare `credit_note` (the platform-billing entity).

The issued list and detail answers stay byte-identical. As for issuing, the number is not in the issue's 201 ([12](./12-m7b-invoice-issue-decision-pack.md) line 622 is the precedent); the list shows it.

**Excluded:** eligibility reads; everything in §1's DEFERRED list; any change to 034's, 035's, 036's or 037's existing rows; the demo POS; deployment.

**Acceptance matrix (every row PLANNED — NOT RUN).** Evidence layers: DB (routine suite on disposable PostgreSQL, races on separate connections with deterministic barriers); HTTP (the real tenant entry); component (shop decoders and components); browser; manual (owner-directed QA on synthetic data, which is not UAT). "Blocks" names the step the row's evidence gates: implementation (the row must pass before CN-P1 is called done) or deployment. No row blocks design approval; only the owner's §10 return does (§9). The matrix is written for the recommended bundle only (§10): any other selection authorizes nothing until this matrix is revised for it, and the pack returns for that revision before CN-P1.

| ID | Criterion | Expected outcome | Proposed evidence | Blocks |
|---|---|---|---|---|
| CN-01 | I-CN under a concurrent credit and payment | Two sessions, credit G and payment P with G + P > remaining: exactly one commits; the other is sealed `amount_exceeds_remaining`; credited + paid ≤ total | DB (two connections, barrier), HTTP | Implementation |
| CN-02 | Credit and void race | Both orders: credit first → void `credit_notes_recorded`; void first → credit `invalid_state` | DB, HTTP | Implementation |
| CN-03 | Credit and reversal race | Both orders end with I-CN holding and both answers sealed | DB | Implementation |
| CN-04 | Duplicate attempt (D-CN-9 list, step 5) | Same session: the same registration presented again with a new idempotency key → sealed 409 `already_issued`, before voided and the bound. Renewed session: the same presentation → `not_found` (session digest, step 4). Another owner's registration of the same attempt id on this invoice (staged with a second owner, since a tenant session lasts at most 8 h, `server/runtime/sessions.ts:110`, and the same owner cannot re-register the attempt, `037_m7b_invoice_payment_registration.up.sql:197`) → `already_issued` at issue, also after a withdrawal and past 24 h. Another invoice's attempt is independent | DB, HTTP | Implementation |
| CN-05 | Same-key replay (list, step 1) | Same session, key and bytes, current authorization and a sign-in within 10 minutes → the stored answer with `Idempotent-Replayed: true` (the sealed success included); the same with a sign-in older than 10 minutes → 403 `step_up_required` before idempotency is consulted; with the grant, role or store access revoked → 401 or 403 before idempotency, never a replay; from a renewed session, while the original completion is retained (24 h) and the preceding checks pass → 422 `idempotency_key_reused`; same key while in progress → 409 `request_in_progress`; nothing new written in any case | HTTP | Implementation |
| CN-06 | Same key, different body; changed bound values (list, steps 1 and 5) | After CN-05's preceding checks, same key, other body → 422 `idempotency_key_reused`, nothing written. A new key on an **open** registration with a different `grossCents` or `reason` → `conflict`, nothing written; on a registration that already carries a credit note → `already_issued`, and the first amount stands | HTTP, DB | Implementation |
| CN-07a | Recovery, server side | The [CN-P1 recovery contract](#cn-p1-recovery-contract-d-cn-9-a) holds: register, proof, issue, lookup and settlement; release, then a late issue → sealed 409 `invalid_state`; confirm, then a late issue → sealed 409 `already_issued`; the issued registration presented again with a new key in the same session → `already_issued`, and with the original key and bytes under CN-05's conditions → the sealed success replayed; past the 10-minute sign-in window, the owner's lookup and a deliberate settlement confirm an issued attempt or release an unused one, and a missing lookup result leaves the outcome unresolved; a refused issue leaves the registration open and blocks a second registration (`conflict`) until released; a payment proof is never accepted for a credit note, nor a credit-note proof by the payment record; two owners of one store cannot see or settle each other's registrations; a manager's and a demoted owner's direct proof, lookup and settlement calls are refused; a sign-in that lapses between register and issue → 403 `step_up_required`, and after reauthentication the issue is `not_found`, so the owner releases and registers again; a settled registration presented from a renewed session → `not_found` (not its state word), and the lookup and settlement still resolve it; after a proof-key rotation an open registration → `not_found` until released, and settlement still releases it; a missing list row never settles an attempt | DB, HTTP | Implementation (CN-P1) |
| CN-07b | Recovery, shop side | A reply dropped after COMMIT is settled only by a staff "Check again" (same session, key and bytes, within the 10-minute sign-in window) or, once that is unavailable, the owner's lookup and a deliberate settlement (confirm an issued attempt, release an unused one); a missing lookup result is shown as unresolved, never as "not issued"; nothing re-sends automatically | Component, browser | Implementation (CN-P2) |
| CN-08 | Isolation | Any level but READ COMMITTED → 55000 before anything is read | DB | Implementation |
| CN-09 | Cross-tenant and cross-store | Another store's or tenant's invoice, and a missing one, → the same 404 over HTTP and the same answer on a direct routine call; nothing written | HTTP, DB | Implementation |
| CN-10 | Owner-only permission | Only the store-scope store owner of the path store may issue or withdraw: a tenant-scope owner, any other role (custom and unknown included) and an owner whose tenant or store account status is not `active` or `trialing` (`037_m7b_invoice_payment_registration.up.sql:568`; read-only and overdue map to a limitation, `007_m5_trusted_principal_resolution.up.sql:138`) are refused over HTTP and on a direct call; reads follow `view_issued_invoices`; a role narrowed mid-session is denied | HTTP, DB | Implementation |
| CN-10b | Manager denied | A `manager` with Invoices Full, who can record and reverse payments, gets 403 on every credit-note mutation and recovery route over HTTP and a refusal on a direct DB call | HTTP, DB | Implementation |
| CN-10c | Store-scope owner allowed (planned positive HTTP case) | A real store-scope `store_owner` (one active store-scope membership at the path store, created by the disposable fixture as `tests/qa/interactive/fixtures.mjs:99-104` does, and signed in through the tenant entry as IVH-01 does, `tests/db/invoiceVoidHttp.integration.test.mjs:894`, `:1066`, `:1101`) registers, issues, lists, looks up, settles and withdraws over HTTP within the sign-in window; each succeeds, and each mutation (register, issue, settlement, withdrawal) writes its routine audit row; the list and lookup write none. Run on the same invoice and store as CN-10b's manager denials. No existing payment HTTP test covers a store-scope owner, so this is new coverage | HTTP | Implementation |
| CN-11 | Recent sign-in, after the last wait | A sign-in older than 10 minutes → 403 `step_up_required` over HTTP; the routine judges expiry and sign-in on one database-clock reading after its last wait (counter lock included), and the TypeScript re-check refuses a sign-in that lapsed during the routine; register needs a recent sign-in too (`issue_invoice_credit_notes`); proof, lookup and settlement need none (`recover_invoice_credit_notes`) | HTTP, DB | Implementation |
| CN-12 | CSRF | A missing or wrong `x-tmpos-session-csrf` → refused before authorization | HTTP | Implementation |
| CN-13 | Audit present and read back | Each issue, withdrawal, register and settlement writes exactly one audit row with its subject column(s), from HTTP and from a direct call; refusals write none | DB, HTTP | Implementation |
| CN-14 | Rows unchanged | The issued header and lines, the counter of invoice numbers, and every payment and reversal row are byte-identical before and after | DB | Implementation |
| CN-15 | Fully paid refused | §5 E4 | DB, HTTP | Implementation |
| CN-16 | Voided refused | §5 E8; a withdrawal on a voided invoice → `invalid_state` | DB, HTTP | Implementation |
| CN-17 | Tax property test | For random invoices, credits and withdrawals: 0 ≤ t ≤ G; active tax = invoice tax whenever active gross = T; gross = net + tax. Without withdrawals, cumulative active tax equals the once-rounded proportional tax after every credit. Deterministic lower- and upper-clamp fixtures (E16, E17). Invariants: active credit tax ≤ the invoice's tax and active credit net ≤ the subtotal after every issue and withdrawal; a forced violation raises `data_corrupted` | DB or unit, property-based | Implementation |
| CN-18 | Worked examples as fixtures | §5 E1–E14, E16 and E17 reproduce exactly through the routine; E15 is a pure comparison fixture | DB, unit | Implementation |
| CN-19 | Decoders reject inconsistent amounts | Server and shop decoders refuse remaining ≠ total − credited − paid, credited + paid > total, a voided invoice with non-zero amounts, and unknown keys or words | Unit, component | Implementation |
| CN-20 | Old shop fails closed | A shop built before CN-P1, given the new amounts, shows the read as unavailable, never a wrong amount; given the void answer `credit_notes_recorded`, which falls past its known sealed answers (`invoiceIssuingClient.ts:1193-1198`), it fails closed | Component | Implementation |
| CN-21 | Down migration | 038's down refuses, changing nothing, while any credit note, withdrawal, credit-note registration, or audit row of an issue, withdraw, register or settle kind exists; otherwise it restores EXECUTE on `record_v2`, `void_v2` and `m7b_invoice_payments_get` exactly and asserts the ACLs ([recovery contract](#cn-p1-recovery-contract-d-cn-9-a)) | DB | Implementation |
| CN-22 | Numbering | Per-store series from 1; a refusal uses no number; concurrent credits in one store get distinct numbers; a withdrawal keeps its number | DB | Implementation |
| CN-23 | Withdrawal raises remaining | §5 E6; a second withdrawal → `invalid_state` | DB, HTTP | Implementation |
| CN-24 | Payment cap and read count credits | §5 E3 through the replacement record routine; the retired `record_v2` and 036's `m7b_invoice_payments_get` are not executable by `tmpos_app` | DB, HTTP | Implementation |
| CN-25 | Void v3 | §5 E9; `payments_recorded` precedes `credit_notes_recorded`; the retired `void_v2` is not executable by `tmpos_app` | DB, HTTP | Implementation |
| CN-26 | Grants and preflight | Grants equal the approved list, the three revocations included; the preflight requires exactly 001–038 | DB, unit | Implementation |
| CN-27a | Void message for credits | The void flow shows a fixed message for `credit_notes_recorded` (CN-P1, with void v3) | Component, browser | Implementation (CN-P1) |
| CN-27b | Shop wording | No credit-note control text says "Paid", "Unpaid" or "Refunded" | Component, browser | Implementation (CN-P2) |
| CN-28 | Exact-commit CI | The CN-P1 commit passes CI in full | CI | Implementation |
| CN-29 | Manual QA | Owner-directed QA on synthetic data, recorded as not UAT | Manual | Deployment (input to G-UAT) |
| CN-30 | Legal and tax review | A written F-2 reviewer sign-off on every jurisdiction-dependent semantic: the grounds and reasons (`goodwill`, `service_issue` included), whole withdrawal against an offsetting document, refusal on fully paid invoices, delivery, reference requirements and timing, numbering, the tax split (clamp and rounding included) and the required content (D-CN-3, D-CN-5, D-CN-6, D-CN-10); any new column it needs is a later additive migration, never an edit of 038 | Manual (legal) | Deployment |
| CN-31 | No Total shown as due | After a credit, the shop shows "Invoice total" and "Credited", never the Total as an amount due | Component, browser | Implementation |
| CN-32 | One-snapshot amounts read | A read concurrent with a withdrawal plus a payment returns amounts from one snapshot, never a mixture | DB (two connections, barrier) | Implementation |
| CN-33 | Credit attribution | The list returns issuing and withdrawing staff `display_name` to the store owner only; for anyone else, a manager's direct DB read included, the name field is absent (not null); only an owner-visible null shows "Name not set"; no id or email; no other read returns a staff name | HTTP, component | Implementation |
| CN-34 | Drained cutover ([038 cutover](#038-cutover-cn-34)) | Deterministic tests: (i) on invoice X apply 038, commit a credit of 2,000 as B, then call the retained `record_v2` as the routines' owner (who keeps EXECUTE) with a payment of 9,000, so credited + paid would exceed the Total → 23000 with fixed text, nothing written; (ii) the same with `void_v2` on an invoice with an active credit → 23000, no void row; (iii) the apply fails cleanly on the lock timeout while a caller holds the header (helpers `holding`, `running`, `blockers`/`blockedBy` in `tests/db/invoicePaymentRoutine.integration.test.mjs`, :664, :681, :690-691); (iv) 038's down drops the triggers and the payment and void tables' trigger sets equal 036's pinned sets again. The operational session check is a runbook step, not a test of 038 | DB | Implementation |
| CN-34s1 | Stale payment call at the seam (planned, not run) | Direct routine calls on disposable PostgreSQL with a durable target (`fsync` on, as `tests/db/invoicePaymentRegistrationRoutine.integration.test.mjs:130` requires, because proofs need it). The test owner holds actor A's `app_user` row FOR UPDATE (016's hold); A calls 037's `record_v2` on invoice X and is shown waiting there (`holding`, `running`, `blockedBy`, `waitsFor` = transactionid ShareLock, `rowWaitOn` = `['app_user']`, the pattern of `tests/db/invoiceIssueRoutine.integration.test.mjs:1634-1641`). `trustedApply('038')` on its own connection with its lock timeout (pattern `tests/db/invoicePaymentRegistrationRoutine.integration.test.mjs:146-158`) completes while A is still blocked; both are asserted. B, the store-scope owner, issues a credit of 2,000 on X and commits. A is released; its payment of 9,000 passes its own payments-only check, its insert fires 038's trigger, and it fails 23000 with fixed text. No payment, void, reversal or audit row from A; header, payments, credits and counters byte-identical except B's credit; A's registration unchanged. Residue committed earlier, in other transactions, is named, not counted as A's: A's open registration, its register audit row and the still-valid proof. (A direct call creates no idempotency record and no store log line; those exist only on the HTTP path.) 038 locks none of `app_user`, `platform_identity`, the session tables, `tenant_session` or `issuer_key` | DB | Implementation |
| CN-34s2 | Stale void call at the seam (planned, not run) | As CN-34s1 with 036's `void_v2` on an invoice with an active credit: A's void fails 23000 with fixed text, no void row, no other change. Missing harness support, named: 038's files and credit-note helpers; a 038 suite must copy `holding`, `running`, `blockers`, `rowWaitOn` and `waitsFor` (the 037 suite has none); no existing assertion of "the apply completed and A is still blocked"; teardown `rollBackAbove('038')`; `withTriggersLifted` (`invoicePaymentRegistrationRoutine.integration.test.mjs:174-187`) for the counterfactual: it disables the triggers with ALTER TABLE (`:182`, holding SHARE ROW EXCLUSIVE) and restores them in the same transaction, so the counterfactual call runs inside that lifting transaction, not on A's paused connection; there the stale payment would commit and break I-CN. Over HTTP the seam is not stageable and stays UNVERIFIED ([038 cutover](#038-cutover-cn-34)) | DB | Implementation |
| CN-35 | Corruption raises | Rows forced past the guards (a voided invoice with an active credit note; active credited + paid above the Total) make the read raise `data_corrupted` | DB | Implementation |
| CN-36 | Pre-038 payment registrations | A payment registration created before 038 completes, or settles, after 038 through the replacement record routine under the credit-aware cap, and through `record_v2` again after a rollback ([recovery contract](#cn-p1-recovery-contract-d-cn-9-a)) | DB, HTTP | Implementation |
| CN-37 | Voided display | On a voided invoice the shop shows "Payment status: Voided" only and hides the amounts rows; the snapshot Total stays | Component, browser | Implementation |
| CN-38 | Cutover runbook rehearsal | On a disposable or staging database: runbook steps 2–3 leave zero `tmpos_app`-member sessions; apply and a clean down both succeed; the down refuses, changing nothing, after a credit-note registration; the forward-only recovery leaves all evidence | Manual and DB (rehearsal) | Deployment |

## 9. Dependencies and production-gate map

**This pack changes no gate.** Gates block go-live, not development ([08](./08-production-gate-and-risk-register.md) line 3); of its deferred-assurance items it says "none blocks product development" (line 287), while DA-118 and DA-119 are pre-deployment blockers.

| Step | What blocks it |
|---|---|
| **Design approval** (adopting this pack) | Only the owner's returned choices in §10 |
| **Implementation** (CN-P1) | The §11 choices; the amendments CN-A1 to CN-A3 the choices need; under D-CN-8 A, a kernel review of the routine-audited kinds; the load-guard change (CN-I1); the provisional 038 record shape (or a hold until F-2's content decision). No gate needs to change first |
| **Deployment** | Every OPEN gate that already blocks the invoice and payment slices, plus the rows below. Nothing in this pack or in CN-P1 alone closes any of them |

| Item ([08](./08-production-gate-and-risk-register.md) line) | Why it matters to credit notes | Status after this pack |
|---|---|---|
| G-IAM (138), G-ISOLATION (145) | New store keys; tenant and store isolation of new routines | OPEN |
| G-IAMUNIFY (139) | The only PASS. The owner-only store rule decides by role and must keep the family orderings intact; tests for owner-edited and custom roles (CN-10, CN-10b) | PASS at repository level, unchanged |
| G-STATUS (141) | The issue order names the store's and tenant's write-status block (D-CN-9) | OPEN |
| G-OBSERVE (276), G-INCIDENT (278) | Detecting unusual credit activity (D-CN-12); refusals leave no audit trace (§7) | OPEN |
| G-PERF (279) | A per-store credit-note counter serializes one store's credits ([12](./12-m7b-invoice-issue-decision-pack.md) line 103 precedent) | OPEN |
| G-PERSIST (142), G-DBCONSTRAINTS (148), G-MIGRATE (150) | New durable records, constraints and migration 038 | OPEN |
| G-AUDIT (151), G-IDEMPOT (195), G-DBROLE (149) | Routine-written audit; idempotency and attempt rules; direct calls | OPEN |
| G-PRIVACY (144) | Staff ids, staff display names shown to the store owner, and the customer link; retention (F-5) and DSAR | OPEN |
| G-PCI (143) | Under D-CN-1 A only: not assessed here; expected unaffected (a credit note moves no money and touches no card data). No PCI claim. D-CN-1 B (refunds) would bring G-PCI's refund lifecycle into scope | OPEN |
| G-ENTITLE (140) | No plan gate applies to Invoices; the keys are not on Refunds | OPEN, unaffected |
| G-BACKUP (277), G-A11Y (280), G-UAT (281), G-REHEARSAL (282), G-GOLIVE (283) | Restore of terminal guards; the shop's controls; acceptance; go-live | OPEN |
| DA-118 (408) | Widened, in audited form under D-CN-8 A | OPEN, pre-deployment blocker |
| DA-119 (409) | Not widened by the credit-note keys (a role rule, not levels); the replacement record and void routines stay level-decided, unchanged | OPEN, pre-deployment blocker |
| DA-132 (422) | The new reads join the direct-read class | OPEN under G-DBROLE |
| DA-186 (476) | Credit notes become decided only when §11 is accepted; refunds stay undecided | OPEN |
| DA-187 (477) | D-CN-10 is an interim default; DA-187 and F-5 must widen to credit notes before live use | OPEN |
| F-2, F-5 | Jurisdiction, numbering, tax split, retention | Missing inputs |

**Not claimed:** credit notes are available; any policy is adopted; any test in §8 has run; any jurisdiction's rules are met; tax correctness for any authority; M7b completion; production readiness.

## 10. How the owner answers

Copy the template, fill in each bracket and send it. ACCEPT accepts that decision's full §11 row and §3 notes (§7 for D-CN-8), not only a summary. No line counts as accepted until the owner returns it.

```
M7B credit notes — owner decisions
D-CN-1 first slice:            [ACCEPT A | CHANGE: …]
D-CN-2 money model:            [ACCEPT A | B | CHANGE: …]   status words and labels: [ACCEPT | CHANGE: …]
CN-A1 remaining formula:       [ACCEPT CN-A1-A | CN-A1-B | CHANGE: …]   (the variant matching D-CN-2)
CN-A2 payment cap:             [ACCEPT | CHANGE: …]   (needed for I-CN)
D-CN-3 states and void:        [ACCEPT A | CHANGE: …]
CN-A3 void amendment:          [ACCEPT | CHANGE: …]   (needed for D-CN-3 A)
D-CN-4 tax split:              [ACCEPT A as interim, subject to F-2 sign-off | B | C | CHANGE: …]
D-CN-5 correction:             [ACCEPT A | B | C | CHANGE: …]   reasons: [ACCEPT | CHANGE: …]
                               withdrawal limit: [no limit | time window: …]
D-CN-6 numbering:              [ACCEPT A | B | C | CHANGE: …]   prefix: [ACCEPT "CN-" | CHANGE: …]
D-CN-7 authorization:          [ACCEPT A (store-scope owner only) | REQUEST DESIGN B | CHANGE: …]
D-CN-8 audit and direct calls: [ACCEPT A | B (+ its own [05] amendment or waiver) | C | CHANGE: …]
D-CN-9 concurrency, recovery:  [ACCEPT A | REQUEST DESIGN B | CHANGE: …]
Amount and reason binding:     [ACCEPT bind grossCents and reason | 037 parity (no binding) | CHANGE: …]
Proof key:                     [ACCEPT reuse 037's key, distinct label | separate credit-note key]
Store-scope owner provisioning: [ACCEPT interim owner SQL procedure | HOLD credit notes until M7h provisioning]
D-CN-10 retention:             [ACCEPT A (interim default) | B: … | CHANGE: …]
038 record shape:              [ACCEPT provisional shape | HOLD CN-P1 until F-2 content decision]
D-CN-11 slice plan:            [ACCEPT A | B | CHANGE: …]
D-CN-12 duties and limits:     [ACCEPT A | REQUEST DESIGN B, C or D | CHANGE: …]
```

**Valid decision bundles.**
- **Recommended bundle:** D-CN-1 A, D-CN-2 A with CN-A1-A, CN-A2, D-CN-3 A with CN-A3, D-CN-4 A (interim), D-CN-5 A (no withdrawal limit), D-CN-6 A, D-CN-7 A, D-CN-8 A, D-CN-9 A with amount and reason binding and 037's proof key under a distinct label, the interim owner SQL procedure, D-CN-10 A, D-CN-11 A, D-CN-12 A and the provisional 038 shape. This is the bundle §3 to §9 design.
- **Coherence rules.** D-CN-2 A needs CN-A1-A and D-CN-2 B needs CN-A1-B. CN-A2 is needed under either. D-CN-3 A needs CN-A3. D-CN-8 B needs its own [05] line 485 amendment or a time-boxed waiver, which this pack does not draft; D-CN-8 C holds CN-P1 until that wider remedy exists. D-CN-9 B is not coherent with the adopted rule that a missing row does not resolve an attempt ([15](./15-m7b-invoice-payment-recording-decision-pack.md) line 773): it cannot settle an attempt that may still commit, so choosing it returns the pack for a recovery design.
- **Not designed here.** D-CN-1 B and C and D-CN-3 B and C are rejected and not offered. D-CN-7 B (delegation beyond the owner) needs its own control design. D-CN-12 B, C and D are named but need a design note (who approves, which threshold, which period) before CN-P1.
- **The §8 acceptance matrix is written for the recommended bundle only.** The designed non-recommended options (D-CN-2 B, D-CN-4 B or C, D-CN-5 B or C, D-CN-6 B or C, D-CN-8 B or C) stay selectable, but choosing one authorizes nothing until §8 is revised for it; the pack returns for a revised acceptance matrix before CN-P1. The undesigned options (D-CN-7 B, D-CN-9 B, D-CN-12 B to D) are not acceptable as returned: choosing one is a request for a new design (its control design, or a recovery design), and authorizes nothing.
- An inconsistent or undesigned selection returns the pack for revision and authorizes nothing.

Only the owner's returned choices authorize adopting any of this policy or starting CN-P1.

## 11. Owner decisions required before CN-P1

Every recommendation is PROPOSED and unadopted. The Owner choice column is left for the owner. Rejected alternatives are named in §3 and are not offered here.

| ID | Existing constraint | Realistic options | Recommendation | Rationale / trade-off | Prerequisite (and what it blocks) | Owner choice |
|---|---|---|---|---|---|---|
| **D-CN-1** First slice | No store-invoice credit note exists; refunds and balances deferred (ADR-52 "Still open", line 1621) | **A** one credit, one server-issued invoice, 1 to remaining, append-only (refunds and cross-invoice credit are rejected here, §3) | **A** | Smallest change that lowers what is owed without moving money | None. Blocks every other row | — |
| **D-CN-2** Money model | remaining = Total − applied, derived, never stored; exact decoders (ADR-52 d1) | **A** explicit `creditedCents`, "Invoice total" and "Credited" in the shop. **B** fold credits into due | **A**, with two new status words | A keeps one truth and fails closed on old clients; B misleads old clients silently and still amends ADR-52 | CN-A1 (matching variant), CN-A2. Blocks the bound, the reads, the decoders and the shop's amounts rows | — |
| **D-CN-3** States and void | Void refused only while a payment is active (ADR-52 d5) | **A** void refused while a credit is active (allow-and-ignore and auto-withdraw are rejected, §3) | **A** | Keeps a voided invoice free of active credits | CN-A3. Blocks void v3 | — |
| **D-CN-4** Tax split | One rate per invoice, tax once on the subtotal, half-up; no partial-credit rule | **A** gross entered, proportional split re-anchored over active credits, clamped (INTERIM, not tax-validated). **B** net entered. **C** no split | **A** as interim | A is exact at the full Total and never drifts while nothing is withdrawn; B drifts from the invoice's split and can refuse a final credit; C records no taxable allocation | F-2 sign-off (CN-30). Deployment needs F-2; implementation may proceed at rework risk | — |
| **D-CN-5** Correction | Append-only precedent (ADR-52 d4) | **A** whole withdrawal, three closed reasons, then re-issue. **B** none. **C** editable. Withdrawal limit: none, or a time window | **A**, four provisional issue reasons, no withdrawal limit (named residual) | B leaves mistakes; C destroys history; a withdrawal can reopen a settled debt | The reason lists. Blocks the record shapes. Deployment needs F-2 (withdrawal against an offsetting document); implementation may proceed at rework risk | — |
| **D-CN-6** Numbering | Invoice series per store, locked counter, no gaplessness (ADR-50 d3) | **A** own per-store series, "CN-" prefix. **B** id only. **C** shared series | **A** | B gives staff nothing to quote; C changes the invoice series' meaning | Blocks the counter. Deployment needs F-2; implementation may proceed at rework risk | — |
| **D-CN-7** Authorization | Store branch decides by level only; Full admits the manager; owner-only exists only on the tenant branch; DA-119 | **A** the store-scope store owner only, by role: `issue_…` and `withdraw_invoice_credit_notes` sensitive, `recover_invoice_credit_notes` not sensitive. **B** delegation beyond the owner, with its own control design | **A** | A closes the manager's record-and-credit path and is not widened by DA-119; it leaves the owner residual (several owners possible, compromise, self-dealing). B is not designed here | CN-I1 (store owner rule). Blocks the keys, the guard and the routines' role check | — |
| **D-CN-8** Audit and direct calls | DA-118, DA-119 OPEN pre-deployment blockers; DA-132 OPEN; [05] line 485 | **A** routine-written audit. **B** store-written audit, with its own [05] amendment or waiver. **C** a wider DA-118 remedy first | **A** | A meets [05] for every entry point but still widens DA-118 in audited form; B needs a [05] amendment or waiver; C delays credit notes | CN-I2 and a kernel review. Blocks **CN-P1 as a whole** | — |
| **D-CN-9** Concurrency and recovery | Header lock; attempt rule; 037's registration; "a missing row does not resolve the attempt" | **A** header lock, attempt rule, 037's registration state machine and settlement. **B** A without registration | **A** | B cannot settle an attempt that may still commit | CN-I3; the [recovery contract](#cn-p1-recovery-contract-d-cn-9-a); the [038 cutover](#038-cutover-cn-34) (CN-34). Blocks the command contract and CN-P2 | — |
| **D-CN-10** Retention | DA-187 undecided; F-2, F-5 missing | **A** keep everything as an interim default; 038's down refuses once data exists. **B** set a period now | **A** | B needs legal input the repository lacks | F-5, F-2, G-PRIVACY; DA-187 widened. Blocks live use, not 038's interim down | — |
| **D-CN-11** Slice plan | P1/P2 precedent; exact decoders | **A** CN-P1 server plus the shop's decoders and amounts display; CN-P2 issue UI; CN-P3 withdrawal UI. **B** one stage | **A** | A isolates the money boundary's evidence and never leaves a read undecodable or mislabelled | D-CN-1 to D-CN-10, D-CN-12. Blocks stage planning | — |
| **D-CN-12** Separation of duties | Under D-CN-7 A only the store owner credits; no limit; staff names not returned today | **A** no threshold, owner residual accepted under G-OBSERVE, staff names to the owner, activity read in CN-P2. **B** second approver. **C** a per-owner or share-of-Total limit. **D** a required periodic owner review | **A** for the first slice | A is visible but not preventive; B to D need a design note and cumulative limits | G-OBSERVE residual. Blocks the list read's shape | — |
| **038 shape** Record shape | F-2 content, numbering and withdrawal rules unknown | **A** ship the provisional shape at rework risk; F-2 columns come in a later additive migration (039 or after). **B** hold CN-P1 until the F-2 content decision | **A** | A lets CN-P1 proceed; B removes the rework risk but waits on F-2 | F-2. Blocks 038's column list | — |
| **Binding** Amount and reason | 037 binds neither amount nor method (`037_m7b_invoice_payment_registration.up.sql:217`) | **A** the registration binds `grossCents` and `reason`; a mismatch is `conflict`. **B** 037 parity | **A** | A makes the registered intent the issued one; B lets a new key on an open registration change the amount (never a second credit) | Two registration columns. Blocks 038's registration shape | — |
| **Proof key** | 037's owner-installed singleton key | **A** reuse it with a distinct label. **B** a separate credit-note key | **A** | A means fewer owner key operations but couples rotations and the startup gate; B uncouples them at the cost of a second install, check and table | Blocks 038's key reference | — |
| **Owner provisioning** | No product path writes memberships (M7h) | **A** an interim, owner-approved, recorded SQL procedure. **B** hold credit notes until M7h | **A** | D-CN-7 A needs a store-scope owner per crediting owner and store | Blocks live use of D-CN-7 A | — |
| **CN-A1, CN-A2, CN-A3** Amendments | ADR-52 decisions 1, 2 and 5; ADR-51 decision 8 as amended; D-PAY-1, D-PAY-2, D-PAY-5 | Accept each, or change it | Accept CN-A1-A, CN-A2 and CN-A3 with D-CN-2 A and D-CN-3 A | Each is an explicit change of adopted text, never implied | The matching D-CN row. Blocks 038 | — |

### Recommended first implementation slice

CN-P1, under the recommended bundle, once the owner returns §10:
- migration 038 in a new schema with the `invoice_credit_note` qualifier: credit-note and withdrawal tables, a per-store credit-note counter, issue and withdraw routines that write their own audit record, a replacement payment record routine that counts credits, void v3, the replacement amounts read with `creditedCents`, and the credit-note registration slot;
- applied and rolled back only through the operational steps of the [038 cutover](#038-cutover-cn-34);
- the issue, withdrawal and list routes, with the three credit-note keys decided by the store-owner rule, and staff names shown to the store owner only;
- under D-CN-9 A, the [CN-P1 recovery contract](#cn-p1-recovery-contract-d-cn-9-a); and the [038 cutover](#038-cutover-cn-34)'s migration-enforced checks and insert-time barrier;
- in the same deployable unit, the server and shop decoders for the new amounts and for `credit_notes_recorded`, the shop's "Invoice total" and "Credited" rows, the voided-invoice display rule (CN-37) and the fixed `credit_notes_recorded` void message (CN-27a), with no issue or withdraw controls;
- evidence CN-01 to CN-06, CN-07a, CN-08 to CN-10, CN-10b, CN-10c, CN-11 to CN-26, CN-27a, CN-28 and CN-31 to CN-37, CN-34s1 and CN-34s2 in §8 (CN-07b and CN-27b belong to CN-P2; CN-29, CN-30 and CN-38 to deployment).

No gate closes because of it, and nothing is deployed by it.

## 12. Adopted decision record and CN-P1 target contract (2026-11-14)

### 12.1 The owner's choices

```
M7B credit notes — owner decisions (returned 2026-11-14)
D-CN-1 first slice:            ACCEPT A
D-CN-2 money model:            ACCEPT A   status words and labels: ACCEPT
CN-A1 remaining formula:       ACCEPT CN-A1-A
CN-A2 payment cap:             ACCEPT
D-CN-3 states and void:        ACCEPT A
CN-A3 void amendment:          ACCEPT
D-CN-4 tax split:              ACCEPT A as interim, subject to F-2 sign-off
D-CN-5 correction:             ACCEPT A   reasons: ACCEPT
                               withdrawal limit: no limit
D-CN-6 numbering:              ACCEPT A   prefix: ACCEPT "CN-"
D-CN-7 authorization:          ACCEPT A (store-scope owner only)
D-CN-8 audit and direct calls: ACCEPT A
D-CN-9 concurrency, recovery:  ACCEPT A
Amount and reason binding:     ACCEPT bind grossCents and reason
Proof key:                     ACCEPT reuse 037's key, distinct label
Store-scope owner provisioning: ACCEPT interim owner SQL procedure — for disposable verification only; live provisioning stays subject to deployment review
D-CN-10 retention:             ACCEPT A (interim default)
038 record shape:              ACCEPT provisional shape
D-CN-11 slice plan:            ACCEPT A
D-CN-12 duties and limits:     ACCEPT A
```

- This is the recommended bundle of §10 ("Valid decision bundles").
- Explicitly accepted: CN-A1-A, CN-A2 and CN-A3; the status words and labels of D-CN-2; the issue and withdrawal reason lists of D-CN-5; whole-credit withdrawal with no time limit; and the separate per-store "CN-" series of D-CN-6.

### 12.2 Target contract for CN-P1

- CN-P1 is built to §3 to §9 as written under this bundle, including the [CN-P1 recovery contract](#cn-p1-recovery-contract-d-cn-9-a) and the [038 cutover](#038-cutover-cn-34) subsection.
- The amendments are adopted as the **target**; they take effect only when CN-P1 is delivered:
  - **CN-A1-A** ([10](./10-architecture-decision-records.md) ADR-52 decision 1; [15](./15-m7b-invoice-payment-recording-decision-pack.md) D-PAY-1): remaining = total − credited − paid; the payments read gains `creditedCents`; `dueCents` stays the Total.
  - **CN-A2** (ADR-52 decision 2; D-PAY-2): the payment cap counts active credits; 038 replaces 037's `record_v2`.
  - **CN-A3** (ADR-52 decision 5; D-PAY-5; A2/A3; ADR-51 decision 8's precedence): a void is also refused while a credit note is active, with `credit_notes_recorded`, through void v3.
- Until then the shipped behaviour is unchanged: 036's and 037's payments read, the payments-only cap of 037's `record_v2`, and 036's `m7b_invoice_void_v2` (§2 rows "Amount due", "The live cap" and "Void and payments").
- The contract changes CN-I1 to CN-I5 (§6) are recorded at CN-P1 in its ADR (ADR-53).

### 12.3 Carried, not claimed

- CN-10c, CN-34s1 and CN-34s2 are planned, not run; the HTTP cutover variant stays UNVERIFIED; CN-38 is a deployment prerequisite.
- The tax split is interim; F-2 sign-off (CN-30) comes before deployment.
- F-5 and DA-187 must widen to credit notes before live use.
- The unresolved items that could change 038's shape stay listed in D-CN-10; any change is a later additive migration, never an edit of 038.
- Live store-scope owner provisioning stays subject to deployment review.
- No gate changes status. Nothing is deployed.

### 12.4 CN-P1 delivery record (candidate)

**Status.** CN-P1 (candidate) is implemented to §12.2 on a candidate built on `main` `04bd9d6`. The decisions it made beyond this text, and the contract changes CN-I1 to CN-I5 as built, are in [10](./10-architecture-decision-records.md) ADR-53. An independent review found no blocker or major issue and its minor findings are applied; owner-directed manual QA (CN-29) is recorded below; the owner's review and exact-commit CI (CN-28) are pending. Nothing is deployed, no managed database is touched, and credit notes are not available in the product. *(Superseded 2026-11-15: the owner authorized the commit, the candidate push and the integration on `main`; CN-28 passed (§12.5).)*

**Changed areas.**
- **Migration 038** (`server/platform-identity/migrations/038_m7b_invoice_credit_note.{up,down}.sql`): schema `tmpos_invoice_credit_note` with the credit-note, withdrawal, counter and registration tables; the register, proof, issue, attempts, settle, withdraw and list routines; the replacements `m7b_invoice_payment_record_v3`, `m7b_invoice_void_v3` and `m7b_invoice_payments_get_v2` with the three revocations; the insert-time barrier triggers on the payment and void tables; the rollback-order anchor; two audit subject columns.
- **Server:** `server/persistence/postgresInvoiceCreditNotes.ts`, `server/runtime/invoiceCreditNotes.ts` (seven new store routes), the route table and session-bound command list, the transactional store and command kernel, the canonical permissions (three keys, the store owner rule), the payments and void runtime decoders, the tenant entry and the startup preflight (ledger 001–038 and the approved grants).
- **Shop:** the payments decoder and display (`creditedCents`, the two new status words, "Invoice total" and "Credited", the voided-invoice rule) and the void refusal for `credit_notes_recorded`; no issue, withdrawal or recovery control.
- **Tests and CI:** server and persistence unit suites for the credit-note routes and store, database suites for the routine, the cutover, the HTTP surface and the migration smoke, edits to the existing database and unit suites for the 001–038 ledger and the new amounts shape, new steps in the CI workflow, and `MIN_SUITES` 185.

**Evidence.** Each row of §8 is recorded here, with its level and limits, only once it has run. No result is claimed in this text.

Recorded 2026-11-15 on the uncommitted candidate (Node 20.20.0, PostgreSQL 16, every database suite on its own disposable socket-only cluster; durable, `fsync` on, where proofs need it). Pinned 038 checksums: up `f0d6988cd8ba514e4516d8be67997478a53ec04d86324b04bab806be147a77f9`, down `34654e6d2ab14fae5496e022ef47c095baef0079249d0cab67d7812eef7549e7`. This is local evidence, not CI.

- **Full local run:** typecheck and its contract 0 errors; the deterministic suites 185 of 185; the shop suites 1,388 of 1,388; the 56 database suites of the CI list (1,048 tests) 1,047 passed, 0 failed, 1 skipped (ICH-11, below). The new suites: migration smoke (ICS) 2 of 2, routines (ICR) 28 of 28, cutover (ICC) 11 of 11, HTTP through the real tenant entry (ICH) 12 of 13 with ICH-11 skipped.
- **Run, database layer (ICR, ICC):** CN-01, CN-02 and CN-03 (separate connections, the second call shown waiting before release); CN-04; CN-06; CN-07a; CN-08 (the writers); CN-09; CN-10 and CN-10b (tenant and store `read_only`, `overdue` and store `suspended` refused, each beside a passing owner control; only the four built-in roles exist, so a custom role is not stageable); CN-11; CN-13; CN-14; CN-15; CN-16; CN-17 (seeded property test, seed `0x0c4e0038`, plus E16 and E17 and a forced `data_corrupted`); CN-18 (E1–E14, E16 and E17 exact through the routines; E15 as a comparison fixture); CN-21; CN-22 to CN-25; CN-32; CN-33; CN-35; CN-36.
- **Run, cutover:** CN-34 (i)–(iv) call the retained routines after the migration (ICC-01–03, ICC-06). Distinct from them, CN-34s1 (ICC-08) and CN-34s2 (ICC-09) stage a call admitted before 038 and paused on 016's hold: 038 commits while the call is still blocked, a credit commits, and the call then fails 23000 at the barrier with nothing of its own written; the counterfactual with the barrier lifted commits and breaks I-CN. ICC-07, a property check tagged with both, shows 038 applies while `app_user`, `platform_identity`, `issuer_key`, `tenant_session` and the session tables are held.
- **Run, HTTP layer (ICH):** CN-10c (a real store-scope `store_owner`, signed in through the tenant entry, registers, proves, issues, lists, looks up, confirms and withdraws within the sign-in window; one routine audit row per mutation, none for the list and lookup), on the same invoice and store as CN-10b's manager denials; CN-04; CN-05; CN-06; CN-07a; CN-09 (real foreign ids); CN-10; CN-11; CN-12; CN-13; CN-15; CN-16; CN-23; CN-24; CN-25; CN-33.
- **Run, unit and component:** CN-19 (the server decoder cases in `server/runtime/invoicePayments.test.ts` and `server/runtime/invoiceCreditNotes.test.ts`, and the shop's IIC-34), CN-20 (a frozen copy of the pre-change shop decoder refuses the new amounts and does not know `credit_notes_recorded`; the real pre-change module was also run once outside the suite), CN-26 (the 001–038 ledger and approved-grant pins in `server/persistence/postgresStartupPreflight.test.ts`), CN-27a, CN-31 and CN-37 (component).
- **Not run, or limited:** the HTTP cutover variant (ICH-11) stays UNVERIFIED; CN-36 and true concurrency are database-layer only; CN-04's "past 24 h" is covered by the permanent attempt constraint, not by staging key expiry; the browser assertions added for CN-27a, CN-31 and CN-37 did not run locally (the browser file ran in CI, §12.5); CN-33's "Name not set" has no shop surface until CN-P2.
- **Pending at the candidate stage:** exact-commit CI (CN-28), F-2 sign-off (CN-30) and the cutover rehearsal (CN-38, deployment). *(Updated 2026-11-15: CN-28 passed (§12.5); CN-30 and CN-38 stay pending.)*

**Manual QA (CN-29), recorded 2026-11-15.** Owner-directed browser QA on synthetic data, **not UAT**, not a deployment and not a legal or tax review. Isolated QA run `qa-20261115t1238-732c`, generation 1, on candidate tree `d970dc6035f6d05ad0607531f62931d4229226a8` (based on `04bd9d6`). The QA tree added one local, uncommitted, QA-only line so the disposable cluster was crash-durable (`` resolveDisposableTarget(`QA ${runId}`, { durable: true }) `` in `tests/qa/interactive/supervisor.mjs`; overlay diff sha256 `19906b48521a32dcb8dc34403737df6f5222ac63f646241b739c47308d8d6c6d`); it is not part of the candidate. The QA database applied 001–038; a read-only check at the start showed `fsync`, `synchronous_commit` and `full_page_writes` on. Credit notes were made over the real routes by the store-scope `store_owner`, since CN-P1 has no shop control for them. The owner set every result:

| Case | Invoice | Result | Owner's note |
|---|---|---|---|
| QA-CN-01, credit only | 8 | PASS | Invoice total $108.88, Credited $20.00, Recorded $0.00, Remaining $88.88; "No payment recorded"; the total labelled "Invoice total". |
| QA-CN-02, partial payment | 11 | PASS | Credited $30.00, Recorded $50.00, Remaining $28.88; "Payment recorded in part"; one $50.00 cash row. |
| QA-CN-03, fully credited | 12 | PASS | "Credited in full"; $108.88 credited, $0.00 recorded and remaining; no Record payment action. |
| QA-CN-04, mixed settlement | 13 | PASS | "Settled by payment and credit"; $20.00 credited, one $88.88 cash payment, $0.00 remaining; no Record payment action. |
| QA-CN-05, no activity | 7 | PASS | "No payment recorded"; $0.00 credited and recorded, $108.88 remaining. |
| QA-CN-06, zero total | 14 | PASS | "Nothing due"; total and every amount $0.00; no Record payment action. |
| QA-CN-07, voided (CN-37) | 5 and 6 | PASS | Issued totals still shown ($50.00, $108.88); payment amount rows, Void and Record payment hidden. |
| QA-CN-08, void with an active credit (CN-27a) | 10 | PASS | The refusal below shown; the invoice stayed issued with $20.00 credited and $88.88 remaining. |
| QA-CN-09, payment cap | 9 | PASS | $90.00 rejected inline before any request; $88.88 cash recorded and confirmed; one payment row, $20.00 credited, $0.00 remaining. |
| QA-CN-10, manager view (CN-10b) | 8 | PASS | Same totals as the owner; the existing payment and void actions kept; no credit-note mutation or recovery control. |
| QA-CN-11, issued-invoice controls (CN-27b) | 8 | PASS | Neither role saw an Issue, Withdraw or Recover credit-note control in the issued-invoice views checked. |
| QA-CN-12, narrow width (CN-31) | 13 | PASS | At 320 × 309 CSS px and 24 px text the mixed status wrapped between words, amounts stayed readable, no horizontal overflow of page or dialog. |

- **Void wording (CN-27a):** approved by the owner as written: "This invoice has credit notes, so it can't be voided. If a credit note was issued by mistake, withdraw it first."
- **Saved evidence, read-only, captured before the run was stopped** (neither action repeated). Invoice 10: the browser sent one void request, answered 409; there is no void row and no void audit row for it, and its credit note is still active. The front's request log keeps no response body, so that the 409 carried `credit_notes_recorded` rests on the owner's browser observation. Invoice 9: one payment registration, one $88.88 cash payment and one confirmation, one audit row each; no reversal, no duplicate (3 payments for 3 distinct attempts in the store), and no request and no stored row from the rejected $90.00 entry.
- **API checks while the fixtures were made** (not browser results): the store owner issued, confirmed and listed credit notes and withdrew one; the manager was refused 403 on all six credit-note mutation and recovery routes, and the manager's list carried no staff-name field while the owner's did (CN-10b, CN-33).
- **Separate layout observation, not a CN-P1 result.** At the QA-CN-12 size the shared dialog heading ("Invoice 13", beside Close) split inside the word. The heading markup, its dialog frame and every styling input are byte-identical to `04bd9d6`, so this is base behaviour by source comparison; a rendered comparison with `04bd9d6` was not performed. It is left outside CN-P1.

**Carried, not claimed** (§12.3 as adopted; CN-10c, CN-34s1 and CN-34s2 have since run, as recorded above).
- The HTTP cutover variant stays UNVERIFIED; CN-38 is a deployment prerequisite.
- The tax split is interim; F-2 sign-off (CN-30) comes before deployment.
- F-5 and DA-187 must widen to credit notes before live use.
- The unresolved items that could change 038's shape stay listed in D-CN-10; any change is a later additive migration, never an edit of 038.
- Live store-scope owner provisioning stays subject to deployment review.
- No gate changes status. Nothing is deployed.

### 12.5 CN-P1 integration and exact-commit CI (closeout, 2026-11-15)

**Repository integration.** With the owner's authorization, `refs/heads/main` was fast-forwarded once, without force, from `04bd9d6` to `064b5f1ddafc5579f496cb084415f283fa0cb20c`. The branch `m7b-credit-notes-p1-candidate` stays at the same commit. CN-P1 consists of four commits:

| Commit | What it changes |
|---|---|
| `c20b7f79af8dfb56cab380a8d921c530f7270b1c` | The implementation: 82 paths (10 added, 72 modified). It is the final candidate tree `d970dc6035f6d05ad0607531f62931d4229226a8` (after the independent review's findings were applied) plus the CN-P1 records in docs 09, 10, 13, 15 and 16 and the Phase 4 index |
| `2773871525acb746d3b11b4a8aab77878e26e8a8` | Test only: the payment registration HTTP suite (IRH-10 to IRH-12) holds autovacuum off its flush-controlled windows, and IRH-11 proves its unflushed precondition before it judges the 503 |
| `079c772b905c9f14434c90c03b6a90fc317b6930` | Test only: the migration smoke (ICS-02) resolves the credit-note proof routine on its proving connection before the registration |
| `064b5f1ddafc5579f496cb084415f283fa0cb20c` | Test only: the cutover suite (ICC) does the same before each registration, and the shop browser teardown (R-DB-1) expects 038's void barrier trigger once 038 is applied |

The 038 checksums pinned in §12.4 are unchanged at `064b5f1`.

**The final candidate tree and the manual QA.** The 12 results in §12.4 come from their original run, `qa-20261115t1238-732c` on tree `d970dc60…`. That is the final candidate tree, after the independent review's findings were applied; the review itself read an earlier revision. Between that tree and `064b5f1`, `git diff --name-only` lists only six Markdown records under `docs/phase-4/` (in `c20b7f7`) and four test files (the three follow-ups). No server, shop, migration, CI workflow, package or lockfile path changed, so the server and shop code the QA exercised is the code on `main`. The QA-only overlay line is not in the repository. The QA was not repeated on `064b5f1`. Its limits stand as §12.4 records them: synthetic data, one isolated run, not UAT, not a deployment, and not a legal or tax review.

**Exact-commit CI (CN-28).**

| Run | Event and head | Attempt | `quality` | `appsec` |
|---|---|---|---|---|
| 43756236582 | `workflow_dispatch` on `m7b-credit-notes-p1-candidate`, `064b5f1` | 1 | success | success |
| 43759859862 | push to `main`, `064b5f1` | 1 | failure at step 30 (tenant entry) | success |
| 43759859862 | the same | 2 (one owner-authorized failed-job rerun) | success, run fresh (22:24:51–22:51:23 UTC) | carried from attempt 1 (same job times) |

- **Main, attempt 1.** `quality` failed at step 30, "Tenant entry runtime against disposable PostgreSQL". 14 of the 16 cases passed. M7TE-14's login and M7TE-C1's customer create on the compiled entry each got 503 `service_unavailable` (expected 200 and 201). Steps 31 onward were skipped, so attempt 1 verified nothing after the tenant entry. The original log is kept.
- **The 503 cause is UNCONFIRMED.**
  - The CI output carries neither the server's logged refusal reason for those requests nor any database log line for them.
  - The same tree passed every step in the candidate run.
  - A local investigation reproduced the same refusal class on both `04bd9d6` and `064b5f1`, but only under induced disk-write load: the rate limiter's 500 ms fail-closed write budget was exceeded and the request refused as `rate_limit_timeout`. This is consistent with the CI failure but does not establish its cause.
- **Main, attempt 2.** Every `quality` step passed and none was skipped. The log has no failing test and exactly one skipped test case. By suite:
  - Tenant entry: 16 of 16, M7TE-14 and M7TE-C1 included.
  - Payment registration HTTP (IRH): 13 of 13.
  - Credit-note migration smoke (ICS): 2 of 2.
  - Credit-note routines (ICR): 28 of 28.
  - Credit-note cutover (ICC): 11 of 11. This includes CN-34s1 (ICC-08), CN-34s2 (ICC-09) and ICC-07, which is tagged with both.
  - Credit-note HTTP (ICH): 13 tests, 12 passed, 0 failed, 1 skipped. The passes include CN-10c (ICH-01: a real store-scope `store_owner` through the tenant entry). The skip is the single test case ICH-11, the CN-34s1 and CN-34s2 HTTP variant, reported "NOT ATTEMPTED — not stageable over the real tenant entry"; the rest of the suite ran. The HTTP cutover variant stays UNVERIFIED.
  - Rate-limited runtime (M6RS): 17 of 17.
  - Payment proof durability: 14 of 14.
  - The shop browser file: 104 of 104 in Firestore-emulator mode (the emulator started). This includes CN-P1's additions to it (the payment summary's "Invoice total" and "Credited" labels and the Credited value, CN-31). Its R-DB-1 teardown, which now expects 038's void barrier, passed.
  - The Firestore emulator suite: 41 of 41.
  - The deterministic suites: 185 of 185.
  - The shop suites: 1,388 cases, ratchet passed.
  - Builds: build integrity passed, both builds succeeded, and the forbidden-artifact scan passed.
  - The dependency audit passed with 0 Critical. The production tree has 0 High, 14 moderate and 3 low; the full tree has 10 High, 32 moderate and 3 low. G-APPSEC stays PARTIAL and production-blocking.
- **`appsec` (attempt 1, carried into attempt 2).** Semgrep rule tests 6 of 6, the repository scan reconciled against its manifest, and Gitleaks reconciled.
- **CI on earlier heads (history).** Each run stopped at or before the first credit-note suite, so the credit-note routine, cutover and HTTP suites (ICR, ICC, ICH) did not run. The follow-ups correct test timing preconditions and, in `064b5f1`, one teardown expectation; none changes product code. The M6RS-07 failure is not attributed to any follow-up.
  - `c20b7f7`: run 43722088580. Attempt 1 failed at M6RS-07; attempt 2, a failed-job rerun, failed at IRH-11.
  - `2773871`: run 43741302186. Attempt 1 failed in the credit-note migration smoke itself (ICS-02), before ICR, ICC and ICH.

**Open items, unchanged by this closeout.**
- ICH-11, the HTTP cutover variant, stays UNVERIFIED. CN-38, the cutover runbook rehearsal, stays a deployment prerequisite.
- G-APPSEC stays PARTIAL and production-blocking.
- F-2 and F-5 stay missing inputs, and CN-30 (the F-2 sign-off) stays pending. DA-187 stays OPEN: as §12.3 records, it and F-5 must still widen to credit notes before live use.
- Live store-scope owner provisioning stays subject to deployment review.
- 37 gates: 29 OPEN, 7 PARTIAL and 1 PASS at repository level; no gate row changes.
- Deployment is not authorized. Nothing is deployed, and no managed database is touched.

**Next slice.** Under D-CN-11 A, the next slice is CN-P2, the shop's issue control and recovery. It is not started and needs its own approval.

**Not claimed:** deployment, production readiness, M7b completion, any jurisdiction's rules, the tax split's correctness, the HTTP cutover variant, or the cutover runbook.
