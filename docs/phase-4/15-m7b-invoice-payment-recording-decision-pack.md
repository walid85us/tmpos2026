# 15 — Recording payments against an issued store invoice: decision pack

**Status: PROPOSED — NOT ADOPTED (stage M7B-PAYMENTS-D1-P0, documentation only).**
- Recording payments is not available in the product.
- This document adopts no policy. It adds no payment, amount due, permission, route, read change, grant or migration.
- Pushing it is not approval, and a green CI run is not approval either. Every recommendation below waits for the owner's explicit choice in §11.
- Accepting the decisions adopts them; it does not deliver the feature. PAYMENTS-P1 is a separate stage, built only to the accepted text.
- Until then, payments and amounts due stay undecided, as [08](./08-production-gate-and-risk-register.md) DA-186 and [09](./09-roadmap-m0-m9.md) (M7b) record. G-PCI stays OPEN.

**Why this pack now (ADOPTED).**
- The roadmap names this slice: "**Next product slice.** Void, then payment recording, which needs the owner's amount-due and payment policy (DA-186, G-PCI)" ([12](./12-m7b-invoice-issue-decision-pack.md) §4, D-ISS-7).
- Void is built in code ([13](./13-m7b-invoice-void-and-correction-decision-pack.md) §12; VOID-P1 `b607d51`, VOID-P2 and VOID-P2-R1).
- [06](./06-module-migration-map-m7.md) places payments in M7b, before M7c.

**Labels.** Each statement carries one class:
- **EXISTING**: verified in source at commit `ab7a7bf`, cited `path:line`.
- **ADOPTED**: policy already accepted, cited by document and section.
- **PROPOSED**: a new policy this pack recommends. It awaits the owner.
- **AMENDMENT**: a proposal that would change adopted text. It needs its own explicit owner choice and is never implied by accepting something else.
- **CONDITIONAL**: an implementation choice that applies only if the related proposal is accepted.
- **DEFERRED**: outside this pack.

"Not established" marks what the repository does not show. `path:line` references drift as files change. Migration file names are relative to `server/platform-identity/migrations/`. "The owner" is the product owner who decides §11. The `store_owner` role is always written as "the store owner (`store_owner`)".

## 1. The capability in plain language

**PROPOSED meaning.**
- An authorized store team member records that money was received against one issued invoice of the store: an amount in US cents and a method.
- The product then shows, beside the unchanged invoice, the payments recorded so far and the amount remaining.
- A recording is the operator's statement. It is not proof that funds arrived, and not a processor authorization, capture or settlement.

| Term | What it is | Status |
|---|---|---|
| **Recorded payment** | An append-only record: amount, method, time and recorder, against one issued invoice | PROPOSED |
| **Reversal** | An append-only record that says one recorded payment was recorded by mistake. No money moves, and the original record stays | PROPOSED |
| **Refund** | Money returned to a customer | DEFERRED |
| **Credit note, partial correction** | A document that adjusts what is owed. Adopted text places them with payments ([12](./12-m7b-invoice-issue-decision-pack.md) D-ISS-1), but this pack keeps them out of the first slice | DEFERRED |
| **Void** | Issued → voided, terminal; the invoice keeps its number and contents | ADOPTED ([13](./13-m7b-invoice-void-and-correction-decision-pack.md) §12.1) |
| **Integrated payment** | Terminal or hosted card flows through a provider: authorization, capture, settlement, webhooks, reconciliation | ADOPTED direction (G-PCI; [05](./05-canonical-data-ownership-and-api-db-contracts.md) §5), not built, DEFERRED |
| **Demo POS payments** | The browser-only POS screen's cart payments, cash drawer and refund choices | EXISTING, legacy, untouched (§2) |

**Recommended first slice (PROPOSED).** It is server-side only:
- record a payment;
- reverse a mistaken recording;
- read an invoice's payments and remaining amount;
- refuse a void while a payment is recorded.

The shop's recording control is a later P2 (D-PAY-10).

**Outside the slice (DEFERRED):**
- refunds, credit notes, store credit and customer balances;
- deposits taken before issue;
- discounts, surcharges, tips and cash rounding;
- integrated card or provider flows, provider selection, webhooks and reconciliation;
- receipts, printing and sending;
- cash drawers and shifts;
- accounting exports and tax filings;
- un-reversing a reversal;
- deletion, erasure and a retention period;
- legal readiness and deployment.

## 2. What exists today

| Area | Where | What it establishes (EXISTING unless ADOPTED) |
|---|---|---|
| The issued amount | `034_m7b_invoice_issue.up.sql:357-363`, `:390-401` | `currency` is exactly `USD`. `subtotal_cents`, `tax_cents` and `total_cents` are bigint integer cents. Under `exclusive_rate` the Total is the subtotal plus the tax; under `none` it is the subtotal, with no tax. Every amount lies in 0 to 2^53 − 1, so a Total of 0 is possible |
| Tax rounding | `034_m7b_invoice_issue.up.sql:280-292` | Tax = `div(S × R + 50,000, 100,000)`, with R in thousandths of a percent and half-cent ties rounding up. The tax is fixed at issue |
| No amount due today | `034_m7b_invoice_issue.up.sql:405`; ADOPTED [12](./12-m7b-invoice-issue-decision-pack.md) D-ISS-1 and [10](./10-architecture-decision-records.md) ADR-50 | The issued row is "never an amount due, a balance or a payment status". The shop "must therefore not label an issued invoice 'Unpaid'" |
| Immutability | ADOPTED [13](./13-m7b-invoice-void-and-correction-decision-pack.md) §3.3, constraint 1 | Issued headers and lines refuse every UPDATE, DELETE and TRUNCATE under ENABLE ALWAYS triggers. Seller, customer name, lines and amounts are a frozen snapshot (version 1) |
| Void | ADOPTED [13](./13-m7b-invoice-void-and-correction-decision-pack.md) §12.1, §12.5; `035_m7b_invoice_void.up.sql:49` | Any issued invoice of the store that is not already void can be voided. The routine holds the issued header FOR UPDATE. D-VOID-1 deferred the payment rule: "recorded payments or amounts due (refuse, or require a refund or credit note first)" ([13](./13-m7b-invoice-void-and-correction-decision-pack.md) §4) |
| Store permissions | `server/platform-identity/m5CanonicalPermissions.ts:292-321` | Seven store keys. The load guard admits Approve only for `issue_invoices` (not sensitive) and `void_issued_invoices` (sensitive), each by name |
| Stored role levels | `026_m5_invoice_role_levels.up.sql:2`, `:13` (header) | The server stores per-role levels for exactly two domains, `customers` and `invoices` |
| Shop level picker | ADOPTED [13](./13-m7b-invoice-void-and-correction-decision-pack.md) D-VOID-2 | Invoices offers None, View, Create, Edit and Full. In the shop, only Full reaches Approve |
| Recent sign-in | `server/runtime/sessions.ts:173` | `RECENT_AUTH_MAX_AGE_MS = 10 * 60_000` |
| Idempotency | `server/runtime/idempotency.ts:107` | Lease 60 s, retention 24 h, keys per principal |
| Create-mode ids | `server/runtime/commandTransaction.ts:517` | A create-mode plan's aggregate id must equal the runtime's new id. A client cannot choose the aggregate id |
| Audit path | `server/persistence/postgresTransactionalStore.ts:855`; `002_authorization_audit_foundation.up.sql:251` | The store writes the command's audit record from TypeScript inside the command transaction. `occurred_at` is `now()`, the transaction start |
| No SAVEPOINT | `server/persistence/postgresTransactionalStore.ts:759-760`; [08](./08-production-gate-and-risk-register.md) DA-36 | A routine must write nothing before its last refusal |
| No events delivered | `server/composition/transactionKernel.ts:26` | The tenant root composes no delivery port |
| Startup | `server/persistence/postgresStartupPreflight.ts:11` | Requires exactly migrations 001–035 and an exact grant set. **The next migration is 036** (the folder ends at `035_m7b_invoice_void.*`) |
| Direct calls | [08](./08-production-gate-and-risk-register.md) DA-118, DA-119, DA-132 (OPEN pre-deployment blockers) | `tmpos_app` plus a live minted session key can call the definer routines directly, including 034's issue and 035's void. Such a call writes no audit record, idempotency completion or HTTP check |
| Payment direction | ADOPTED G-PCI ([08](./08-production-gate-and-risk-register.md)); [05](./05-canonical-data-ownership-and-api-db-contracts.md) §5 | Cash, external terminal, semi-integrated terminal and hosted CNP. No PAN, CVV, track, PIN or processor credential ever touches TM POS2026. "Every payment state transition writes a durable append-only `audit_event`". The PCI category stays unvalidated |
| Demo POS | `src/components/POS.tsx:98`, `:143`, `:186`; `src/context/StoreLocalState.tsx:72`, `:358` | Browser state only. Payments are `{ method, amount }` in floating dollars (`215.41`), with cash rounding and refund-method choices. The screen calls no `/api/v1` route. This pack neither connects, migrates nor changes it, and the new feature never reads it |

None of this is a claim of PCI compliance or of any jurisdiction's invoice or payment rules. Excluding card data does not establish PCI compliance.

## 3. Owner decision table

Every **Recommendation** is PROPOSED and unadopted. The **Owner choice** column is left for the owner.

| ID | Existing constraint | Realistic options | Recommendation | Rationale / trade-off | Prerequisite | Owner choice |
|---|---|---|---|---|---|---|
| **D-PAY-1** Amount due and currency | Immutable USD Total in integer cents. No amount due, balance, discount or deposit exists | **A** derived: due = the issued Total; applied = the sum of non-reversed payments; remaining = due − applied, computed at read and under lock, never stored on the invoice. **B** a stored balance updated per payment. **C** a configurable due (for example, excluding tax) | **A**. Tax is included because the Total includes it, and nothing is recomputed. Discounts, deposits, prior balances, surcharges, tips and cash rounding are excluded. Exact cents in USD only, with no rounding step. A Total of 0 has nothing due | One source of truth that the immutable snapshot already fixes. B can drift from the payment rows. C rewrites what was invoiced | Amendment A1 (§7) | — |
| **D-PAY-2** Full, partial, excess | None | **A** partial allowed: each amount from 1 to the remaining amount, with overpayment refused and change not stored. **B** full only: the amount must equal the remaining amount. **C** cash tendered, applied and change all stored | **A**. Zero, negative or non-integer amounts are a 400 before any write. An amount above the remaining amount is a sealed 409 `amount_exceeds_remaining`. For cash, the operator records the applied amount and hands change outside the product | Covers deposits after issue and split tender without creating a credit nobody owns (no customer balance or refund exists). C adds cash-drawer meaning with no drawer | D-PAY-1 | — |
| **D-PAY-3** Methods | G-PCI direction; [05](./05-canonical-data-ownership-and-api-db-contracts.md) §5's hard data boundary; no provider selected | **A** `cash` and `external_card_terminal`, both recorded by staff. **B** A plus cheque, bank transfer or `other`. **C** no manual methods; wait for the integrated provider | **A**. No card fields and no free-text reference in the first slice. The shop labels both "recorded by staff" | A recording is an assertion, not an authorization or settlement. A free-text reference is a channel for card numbers. B widens reconciliation duties with no process behind them | None, and it does not satisfy G-PCI | — |
| **D-PAY-4** History and correction | Append-only precedent (void, discard) | **A** append-only payment records plus a whole-payment reversal record with a required closed reason code: one reversal per payment, no un-reverse. **B** record only, with correction deferred. **C** editable or deletable payments | **A**. Identity: a server id per payment, plus a shop-generated attempt id (D-PAY-7). Time: the database clock when recorded; no operator-entered or back-dated time. No external reference | B leaves a mistaken entry wrong forever, which is not acceptable for live use, by the same reasoning as void. C destroys history | The reason-code list (§4) | — |
| **D-PAY-5** Void interaction | D-VOID-1 (ADOPTED): any issued invoice can be voided | **A** void refused while any non-reversed payment exists (new sealed 409 `payments_recorded`), and recording on a voided invoice refused (`invalid_state`). **B** void allowed, with payments left as they are. **C** void reverses the payments automatically | **A** | B shows money against a void document. C hides a money fact inside a void | **Amendment A2** (§7), an explicit owner choice | — |
| **D-PAY-6** Permissions and sign-in | Seven store keys; Approve admitted only by name; stored levels exist for Customers and Invoices only | Record at: **A** Invoices ≥ Approve with Customers View (the same holders as issue). **B** Invoices ≥ Create with Customers View (sales staff by default). **C** a new Sales or Payments stored level | **A** for recording: a new store key, not sensitive, no recent sign-in. Reversal: its own key at Invoices ≥ Approve with Customers View, sensitive (sign-in within 10 minutes), with a required reason. Reading: the existing issued-invoice readers (`view_issued_invoices`) | A keeps the money statement with the role that made the document. B suits counter staff but lets a Create-level role assert that money arrived. C needs a migration widening 026's domain check and a level editor | The load guard widened by name | — |
| **D-PAY-7** Atomicity, concurrency, replay | Idempotency 24 h per principal; sealed or unsealed answers; no SAVEPOINT | **A** one transaction: the issued header FOR UPDATE, then the attempt-id check, then the void check, then the sum of non-reversed payments, then the decision, then the insert. Same key and same bytes replays; same key with other bytes is a 422; a shop-generated **attempt id** is unique forever, so a new key with a used attempt id is a sealed 409 `already_recorded`. **B** A without the attempt id. **C** the invoice's payment version on the wire | **A** | Unlike void, payments are not one per invoice: after a lost answer, a new-key resend can record twice. The attempt id stops that permanently; B bounds it only by the remaining amount. C makes every concurrent recorder retry | None | — |
| **D-PAY-8** Direct-call prerequisite | DA-118, DA-119, DA-132 OPEN; routines write no audit; the store writes the audit from TypeScript | **A** a bounded remedy for the payment path: the record and reverse routines write their own audit record in the same transaction, so no permitted direct call commits an unaudited payment or reversal. **B** a wider DA-118-class remedy first, across routines 020–035. **C** inherit the class (a deferral) | **A**, required before PAYMENTS-P1 | A route wrapper alone cannot stop a direct definer call. A is the smallest change that makes the payment rows self-auditing. B blocks payments behind a cross-cutting change. C needs its own explicit owner decision, and the existing blockers stay | An architecture review of the kernel change (§8) | — |
| **D-PAY-9** Retention | DA-187 undecided; issued records kept forever | **A** nothing deletes or edits payment, reversal or audit records; 036's down refuses while any exist; keys follow the existing 24 h policy. **B** set a retention period now | **A**, until the owner supplies the business and legal inputs (F-5, F-2) | B needs statutory input that the repository does not hold. Reversal is the only correction and erases nothing | F-5, F-2, G-PRIVACY | — |
| **D-PAY-10** P1 boundary | VOID-P1/P2 split; exact shop decoders | **A** P1 is the server, database and HTTP boundary plus a separate payments read, with the shop control in P2. **B** both in one stage | **A**. The existing issued list and detail answers stay byte-identical, so the shop does not change in P1 | It isolates the money boundary's evidence, and P2 inherits the void's held-attempt pattern. B couples server and shop risk | D-PAY-1 to D-PAY-9 | — |

## 4. Decision notes

**D-PAY-1. How the amount relates to the invoice.**
- The issued invoice stays exactly as issued: its Total, tax line, seller and customer snapshot, number and `snapshotVersion` 1.
- Payments live in their own records beside it, and the remaining amount is derived from them.
- **Due.** `due = total_cents`.
- **Applied.** `applied = Σ amount_cents` over payments with no reversal.
- **Remaining.** `remaining = due − applied`. It is never negative, because D-PAY-2 refuses any overpayment under the header lock.
- **Overflow.** Sums are computed in `numeric`, so they cannot overflow bigint.
- **Status words.** The read returns these numbers and one derived word:
  - `nothing_due` (Total 0);
  - `no_payment_recorded`;
  - `partly_paid`;
  - `paid` (remaining 0, Total above 0).
  - The shop would show the last three as "No payment recorded", "Partly paid (recorded)" and "Paid in full (recorded)", never "Unpaid". Money may have been taken outside the product, as [13](./13-m7b-invoice-void-and-correction-decision-pack.md) D-VOID-1 already warns.
- **Version-1 meaning.** The payment state is a separate read, not a field of the issued snapshot. It reinterprets no recorded value, the reading the owner already accepted for the void ([13](./13-m7b-invoice-void-and-correction-decision-pack.md) §12.1 (i)).

**D-PAY-2. Underpayment.**
- An underpayment is simply a partial payment. The invoice stays `partly_paid` until more is recorded.
- There are no due dates, dunning or late fees in this slice.

**D-PAY-3. What a method means.**
- `cash`: the operator states that cash was received.
- `external_card_terminal`: the operator states that a separate, unconnected terminal approved a charge.
- Neither is a processor authorization, capture or settlement, nor an independently verified receipt of funds.
- The external-terminal record is the fallback that G-PCI and [05](./05-canonical-data-ownership-and-api-db-contracts.md) §5 name. It is not the integrated flow, and the integrated flow's provider selection, store-owned gateway configuration ([05](./05-canonical-data-ownership-and-api-db-contracts.md) §5.1), webhooks, reconciliation and PCI validation stay open under G-PCI.
- **Card data.** The first slice has no card number, CVV, track, PIN, last-4, approval-code or free-text field at all.
- **Alternative.** Adding a terminal reference later is a separate decision, with a bounded character set and a refusal of digit runs shaped like a card number. That refusal would itself need tests, and it reduces risk without eliminating it.

**D-PAY-4. Proposed record shapes** (CONDITIONAL names, fixed at P1).
- **The payment record:**
  - `payment_id`, a server uuid;
  - `attempt_id`, a uuid from the shop, unique forever;
  - tenant, store and `invoice_id`, with a composite foreign key to 034's `issued_invoice_scope_key`;
  - `amount_cents`, from 1 to 2^53 − 1;
  - `method`, checked against D-PAY-3;
  - `recorded_at`, the routine's `clock_timestamp()` after its last lock;
  - `recorded_by`, the actor, never returned by a read.
- **The reversal record:**
  - `payment_id` as its primary key, so there is at most one reversal per payment;
  - `reason_code`;
  - `reversed_at`;
  - `reversed_by`.
- Both tables are insert-only, behind ENABLE ALWAYS guards that refuse UPDATE, DELETE and TRUNCATE, as 035's record does.
- **Proposed reversal reasons**, closed, with no free text:
  - `recorded_in_error` ("Recorded by mistake");
  - `wrong_amount` ("Wrong amount");
  - `wrong_method` ("Wrong method");
  - `wrong_invoice` ("Wrong invoice");
  - `duplicate` ("Duplicate recording");
  - `other` ("Other reason").
- **What a reversal is not.** It states that the recording was wrong. It is not a refund and returns no money.
- **The limitation this leaves.** If money really was received and must go back, the product cannot express it until refunds exist. The operator settles it outside the product and must not reverse a true recording to make the numbers fit. The refund prerequisites are G-PCI's lifecycle work (refunds idempotent, with the refund authorization of [06](./06-module-migration-map-m7.md) M7b) and an owner refund policy.

**D-PAY-6. Boundary.**
- **Scope.**
  - The path's store must equal the trusted store.
  - The invoice must belong to that store and tenant; another store's or tenant's invoice is the same 404.
  - Only the write statuses (`active`, `trialing`) are allowed, so a read-only actor, tenant or store is refused.
  - There is no role-name, System Owner or creator shortcut.
- **New store keys** (illustrative names): `record_invoice_payments` and `reverse_invoice_payments`.
  - The load guard admits each by name only. The second becomes the second sensitive store key.
  - Invoices has no plan gate, so none applies ([13](./13-m7b-invoice-void-and-correction-decision-pack.md) §3.1, item 8).
- **Who qualifies under option A by default.** The store owner (`store_owner`) and `manager` qualify. `technician` and `sales_staff` do not.
- **Option B.** It would add `sales_staff` (Invoices Create by default) for recording.

**D-PAY-7. Which guarantees hold where.**
- **On the HTTP path only:**
  - idempotency replay and the 422;
  - the chain's checks: session, CSRF, route authorizer, recent sign-in for reversal, and the limiter.
- **On every permitted database entry point, including a direct definer call** (enforced inside the routine under the header lock):
  - the remaining-amount bound;
  - the void exclusion;
  - the attempt id's uniqueness;
  - one reversal per payment;
  - the store and tenant derivation from the session key;
  - the stored-level check;
  - with D-PAY-8 A, the audit record.
- **Failure behaviour.**
  - A timeout, fault or ambiguous COMMIT is a 503 with the outcome unknown, never a claimed rollback.
  - Nothing re-sends automatically.
  - The P2 shop holds an unconfirmed attempt (its key, exact bytes and attempt id) outside the dialog, with "Check again" (the same key and bytes, within 23 h) and "Check payments" (the read). This is the pattern adopted in [13](./13-m7b-invoice-void-and-correction-decision-pack.md) D-VOID-5.

## 5. State and operation matrix (recommended policy)

"Active" means a payment with no reversal.

| Invoice state | Record a payment | Reverse a payment | Void the invoice | Read payments |
|---|---|---|---|---|
| Issued, Total 0 (`nothing_due`) | 409 `amount_exceeds_remaining` (remaining 0) | Not applicable: there are no payments | Allowed (unchanged) | 200, all zeros |
| Issued, no active payment (`no_payment_recorded`) | Allowed for 1 ≤ amount ≤ remaining | 409 `invalid_state` if the payment is already reversed; a payment of another invoice is 404 | Allowed (unchanged) | 200 |
| Issued, partly paid | Allowed for 1 ≤ amount ≤ remaining | Allowed; the remaining amount grows again | **409 `payments_recorded`** (A2) | 200 |
| Issued, paid (remaining 0) | 409 `amount_exceeds_remaining` | Allowed | **409 `payments_recorded`** (A2) | 200 |
| Voided (holds only reversed payments, by construction) | 409 `invalid_state` | 409 `invalid_state` (already reversed) | 409 `invalid_state` (unchanged) | 200, history kept |

For each sealed answer above, a same-key replay returns the same answer.

## 6. Worked examples (synthetic)

Invoice **A**:
- subtotal 9,000 cents at an `exclusive_rate` of 8,250 (8.25 %);
- tax = div(9,000 × 8,250 + 50,000, 100,000) = 743;
- Total 9,743 ($97.43).

| # | Situation | Request | Result | Remaining |
|---|---|---|---|---|
| 1 | Full cash payment | A, cash 9,743 | 201 recorded; state `paid` | 0 |
| 2 | Partial, then the rest | A, `external_card_terminal` 5,000, then cash 4,743 | 201 and 201; state `partly_paid`, then `paid` | 4,743, then 0 |
| 3 | Excess cash | After the first payment of #2, the customer hands over $50.00 and the operator enters 5,000 | Sealed 409 `amount_exceeds_remaining`, nothing written. The operator records 4,743 and hands back 257 ($2.57) outside the product; neither the tendered amount nor the change is stored | 4,743, then 0 |
| 4 | Replay and conflicting replay | Key K1 with body {5,000, `external_card_terminal`, attempt P1} → 201. K1 with the same bytes → the stored 201 replayed (`Idempotent-Replayed: true`). K1 with 5,001 → 422 `idempotency_key_reused`. A new key K2 with attempt P1 → sealed 409 `already_recorded` | Exactly one payment of 5,000 | 4,743 |
| 5 | Two concurrent attempts | Invoice **B**, Total 10,000, no payments. Two users each send 6,000 at once (different keys and attempt ids) | Both wait on B's header lock. The first commits (remaining 4,000). The second then sees 4,000 < 6,000 → sealed 409 `amount_exceeds_remaining` | 4,000 |
| 6 | Paid and voided interaction | Void A after #1 → sealed 409 `payments_recorded`. If, and only if, the recording itself was wrong: reverse it (`recorded_in_error`, with a recent sign-in) → remaining 9,743, then the void → 200. Recording on the now-voided A → 409 `invalid_state` | The void and the payment history are both kept | 9,743 shown as history; nothing is due on a void document |
| 7 | Race between void and payment | A void of B and a payment to B arrive together | Both lock B's header. If the void wins, the payment is 409 `invalid_state`; if the payment wins, the void is 409 `payments_recorded` | Depends on the order |

## 7. Proposed amendments to adopted text (each needs its own owner choice)

| # | Adopted text | Proposed change | Required owner decision |
|---|---|---|---|
| **A1** | [12](./12-m7b-invoice-issue-decision-pack.md) D-ISS-1 and ADR-50: issuing creates no amount due, and the shop shows no paid or unpaid status | Once payments are adopted, the amount due is defined in the payment domain (D-PAY-1), derived and never stored on the invoice. Issuing itself still creates nothing, the issued row keeps its "never an amount due" comment, and shop labels say "recorded" | Accept that D-ISS-1's "no paid or unpaid status" is narrowed to permit D-PAY-1's derived state, with no "Unpaid" wording |
| **A2** | [13](./13-m7b-invoice-void-and-correction-decision-pack.md) D-VOID-1 and §12.1: any issued invoice not already void can be voided | A void is refused while any active payment exists (`payments_recorded`). Migration 036 supersedes 035's void routine for `tmpos_app` with a version that checks payments after its header lock, and revokes `tmpos_app`'s EXECUTE on the old routine, as 033 and 035 did. The shop's void confirmation and the void eligibility read gain the new refusal | Accept the void restriction; otherwise choose D-PAY-5's B or C |
| **A3** | [13](./13-m7b-invoice-void-and-correction-decision-pack.md) §12.2 and §12.5: the void routine and the shop's word lists | The new sealed word `payments_recorded` is added to the void's answers, decoders and shop text (P1 server, P2 shop) | Follows from A2 |

No other adopted text is replaced. Doc 13's decisions, reason codes, lock order and held-attempt behaviour stay as adopted.

## 8. Direct-call security prerequisite (D-PAY-8)

**The current state (EXISTING).**
- A holder of the runtime login with `tmpos_app` and a live minted key can already call 034's issue and 035's void routines directly, writing no audit record ([08](./08-production-gate-and-risk-register.md) DA-118).
- A payment routine built the same way would let that holder commit a payment, or a reversal, that no audit record shows. That is a money statement with no trail.
- A route wrapper cannot prevent it, because the direct call never passes through the route.

**Option A (recommended): a bounded remedy for the new payment path.**
- The record and reverse routines insert their own `audit_event` row in the same transaction, after their last refusal (DA-36), with the command's correlation id passed in as an argument.
- The kernel then must not write a second audit record for these two kinds.
- Effect: every committed payment or reversal, by whatever permitted entry point, has an audit record. This follows [05](./05-canonical-data-ownership-and-api-db-contracts.md) §5's "every payment state transition writes a durable append-only `audit_event`".
- **Implications.** The definer routines need INSERT on `public.audit_event`, through their owner. The kernel and store need a named contract change (a closed list of "routine-audited" kinds), reviewed with the same care as DA-19 and DA-20. The audit writer's closed lists, the startup preflight's grant set and the migration contract pins all move.
- **What it does not do:**
  - make a direct call pass the HTTP checks;
  - write an idempotency completion;
  - prove that an audit row is genuine. The runtime login can still insert audit rows through `tmpos_audit_writer`, a G-AUDIT class.
- It closes the "unaudited payment" gap only. DA-118, DA-119 and DA-132 stay OPEN for every earlier routine.

**Option B: a wider DA-118 remedy first.**
- Make every definer command routine (020–035) self-auditing, or adopt another structural boundary.
- It is the stronger end state, but it is cross-cutting, and payments would wait for it.

**Option C: inherit the class.**
- Not recommended. Building payments without A or B is a deliberate deferral that needs its own explicit owner decision, recorded as such.
- Even then, DA-118 and DA-119 remain pre-deployment blockers. Nothing here accepts or waives them.

## 9. PAYMENTS-P1 boundary (CONDITIONAL; for planning only, not implemented)

**Scope:**
- migration **036** (`036_m7b_invoice_payment.up.sql` and `.down.sql`, a new schema);
- `POST /api/v1/stores/{storeId}/invoices/{id}/payments` (record);
- `POST …/invoices/{id}/payments/{paymentId}/reversal` (reverse; recent sign-in);
- action-only eligibility reads for both;
- `GET …/invoices/{id}/payments` (the records, reversals, due, applied, remaining and the derived word);
- the void's new refusal (A2).

The existing issued list and detail answers stay byte-identical.

**Likely files** (inspected; all exist except the new ones):
- **New:** `server/runtime/invoicePayments.ts`, `server/persistence/postgresInvoicePayments.ts`, `tests/db/invoicePaymentRoutine.integration.test.mjs` and `tests/db/invoicePaymentHttp.integration.test.mjs`, each with a CI step in `.github/workflows/ci.yml`.
- **Changed:**
  - `server/platform-identity/m5CanonicalPermissions.ts` (the keys and the load guard);
  - `server/runtime/routes.ts` and `server/entry/tenantEntry.ts` (routes; 31 today);
  - `server/composition/tenantTransactions.ts`;
  - `server/runtime/app.ts` and `server/persistence/postgresTransactionalStore.ts` (`PRECONDITION_UPDATE_KINDS`, `app.ts:526`, and the routine-audited kinds);
  - `server/runtime/commandTransaction.ts`;
  - `server/platform-identity/auditEventWriter.ts`;
  - `server/runtime/invoiceVoid.ts` and `server/persistence/postgresInvoiceVoid.ts` (A2);
  - `server/persistence/postgresStartupPreflight.ts` (001–036 and the grants);
  - the pins in `tests/quality/migration-files-contract.test.mjs`, `tests/quality/production-runtime-contract.test.mjs`, `server/entry/tenantEntry.test.ts` and `tests/db/migrationsThrough.mjs`;
  - the void suites `tests/db/invoiceVoidRoutine.integration.test.mjs` and `tests/db/invoiceVoidHttp.integration.test.mjs`.
- **The shop in P2:** `src/tenant/ServerIssuedInvoices.tsx` and `src/tenant/invoiceIssuingClient.ts`.

**Excluded:**
- `src/components/POS.tsx` and every demo POS state;
- providers, terminals and webhooks;
- refunds and credit notes;
- any card field;
- deployment, managed databases and live services;
- any change to 034's or 035's existing rows.

**Planned evidence (PLANNED — NOT RUN):**
- the bound: no sum above the Total;
- concurrent recordings serialize (two parallel sessions);
- the replay, 422 and `already_recorded` answers;
- another tenant or store answers 404, with nothing written;
- refusals write nothing;
- the payment, its audit record and the completion commit or roll back together;
- **a direct definer call writes an audit record (D-PAY-8 A) and cannot exceed the remaining amount or pay a voided invoice**;
- the void race in both orders;
- the grants equal the approved list;
- 036's down refuses after the first payment;
- green exact-commit CI.

## 10. Dependencies and what stays unchanged

| Item | Effect of this pack |
|---|---|
| DA-186 | Payments and amounts due become decided only when §11 is accepted. Refunds, credit notes and the rest stay undecided |
| DA-187, G-PRIVACY | Unchanged. Payment and reversal records would join the data a retention decision must cover. F-5 and F-2 are missing inputs; no statutory period is assumed |
| DA-118, DA-119, DA-132, DA-36 | Unchanged and OPEN. D-PAY-8 proposes not to widen DA-118 with payments |
| G-PCI | OPEN. Manual recording neither selects a provider nor validates any PCI category |
| G-AUDIT, G-IDEMPOT, G-PERSIST, G-IAM, G-DBROLE | OPEN. No gate closes |
| All 37 gates | OPEN. Nothing is deployed |

**Not claimed:**
- payment recording is available;
- any policy is adopted;
- any jurisdiction's rules are met;
- PCI compliance;
- any test in §9 has run;
- M7b completion;
- production readiness.

## 11. Owner decisions required before PAYMENTS-P1

Each decision blocks the implementation named in its row. No line is accepted until the owner returns it.

| ID | Decision | Recommendation in brief | Blocks | Owner choice |
|---|---|---|---|---|
| D-PAY-1 | Amount due | Due = issued Total (tax included); remaining = Total − non-reversed payments, derived and never stored; USD exact cents; no discounts, deposits or balances | Every amount check and read | — |
| D-PAY-2 | Partial and excess | Partial allowed (1 to remaining); overpayment refused; cash change handed back outside the product, not stored | The bound and the sealed answers | — |
| D-PAY-3 | Methods | `cash` and `external_card_terminal`, recorded by staff; no card or reference field | The method CHECK and the shop's labels | — |
| D-PAY-4 | History and correction | Append-only records; a whole-payment reversal with a closed reason (six codes); no back-dating; refunds deferred | The reversal route and the record shapes | — |
| D-PAY-5 / A2, A3 | Void interaction | Void refused while an active payment exists; recording on a voided invoice refused | 036's void supersession | — |
| A1 | Amount-due wording | Narrow D-ISS-1 to permit a derived payment state labelled "recorded"; never "Unpaid" | The payments read and its labels | — |
| D-PAY-6 | Permissions | Record at Invoices Approve with Customers View, no recent sign-in; reverse at the same levels with a recent sign-in and a reason; read as issued-invoice readers | The keys and the load guard | — |
| D-PAY-7 | Replay and concurrency | Header lock; a permanent attempt id; same key replays; other bytes 422; reused attempt id `already_recorded` | The command contract | — |
| D-PAY-8 | Direct-call prerequisite | Payment routines write their own audit record (bounded remedy); any deferral is a separate explicit decision | **PAYMENTS-P1 as a whole** | — |
| D-PAY-9 | Retention | Keep everything; 036's down refuses once data exists; the period waits for F-5 and F-2 | 036's down; live use | — |
| D-PAY-10 | Slice | P1 server and read only; the shop control in P2 | Stage planning | — |

**Response template.** Copy it, fill in each bracket and send it. ACCEPT accepts that decision's full §3 and §4 text, not only the summary line.

```
M7B payment recording — owner decisions
D-PAY-1 amount due:      [ACCEPT | CHANGE: …]
D-PAY-2 partial/excess:  [ACCEPT | CHANGE: …]
D-PAY-3 methods:         [ACCEPT | CHANGE: …]
D-PAY-4 correction:      [ACCEPT | CHANGE: …]   reversal reasons: [ACCEPT | CHANGE: …]
D-PAY-5 void (A2, A3):   [ACCEPT | CHANGE: …]
A1 amount-due wording:   [ACCEPT | CHANGE: …]
D-PAY-6 permissions:     [ACCEPT | CHANGE: …]
D-PAY-7 replay:          [ACCEPT | CHANGE: …]
D-PAY-8 direct calls:    [ACCEPT A | B | C (explicit deferral) | CHANGE: …]
D-PAY-9 retention:       [ACCEPT | CHANGE: …]
D-PAY-10 slice:          [ACCEPT | CHANGE: …]
```

Only the owner's returned choices authorize adopting any of this policy or starting PAYMENTS-P1.
