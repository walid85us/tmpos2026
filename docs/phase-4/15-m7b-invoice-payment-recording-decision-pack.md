# 15 — Recording payments against an issued store invoice: decision pack

**Status: ADOPTED (owner decisions of 2026-11-07, stage M7B-PAYMENTS-P1; [10](./10-architecture-decision-records.md) ADR-52); the P1 server slice is delivered in code at commit B `3081aa3` (migration 036, the five payment routes (the payments read among them), the void's replacement routine and the shop's void message); P2, the shop's recording and reversal controls, is pending and not started; nothing is deployed.**
- The owner chose D-PAY-1 to D-PAY-10 and accepted amendments A1, A2 and A3; A4 is not adopted and not needed under D-PAY-8 A. §12.1 records each choice, and §12 is the P1 implementation contract.
- Adoption is not delivery. At adoption nothing of §12 is committed, run or deployed; the stage records its delivered state in §12 and in [08](./08-production-gate-and-risk-register.md).
- Delivered (2026-11-07): commit B `3081aa3` (tree `14c8696c…`, 82 paths), pushed fast-forward from commit A `8a92a14`; its CI run 42406847370: attempt 1 FAILED in the appsec job only (the Semgrep manifest reconciliation, on six synthetic card-data keys in two new test inputs; Gitleaks skipped; quality 72 of 72 steps passed); the owner's decision on a scoped manifest exception is pending — see [08](./08-production-gate-and-risk-register.md)'s stage record. §12.10 maps PAY-01 to PAY-15 to named assertions and layers; §12.11 records the evidence limits, the residuals accepted by review and where the code differs from §12's text. Recording and reversing a payment exist in code as the server's HTTP commands, backed by definer routines that a runtime-role holder with a live key can also call directly ([08](./08-production-gate-and-risk-register.md) DA-118); the shop has no recording or reversal controls, so staff cannot record a payment from the shop.
- Every production gate stays OPEN (37), including G-PCI. Nothing here is a PCI, legal or production-readiness claim.
- The text from here to §11 is the proposal as written at D1-P0. It is kept as history, except for two wording corrections marked "(narrowed 2026-11-07)" (§7's Effect, §11's D-PAY-6 rationale) and one note above §11's table. §12 reconciles anything in it that the P1 contract refines.

**Original status at D1-P0 (history): PROPOSED — NOT ADOPTED (stage M7B-PAYMENTS-D1-P0, documentation only).**
- Recording payments is not available in the product.
- This document adopts no policy. It adds no payment, amount due, permission, route, read change, grant or migration.
- Pushing it is not approval, and a green CI run is not approval either. Every recommendation below waits for the owner's explicit choice in §11.
- Accepting the decisions adopts them; it does not deliver the feature. PAYMENTS-P1 is a separate stage, built only to the accepted text.
- Until then, payments and amounts due stay undecided, as [08](./08-production-gate-and-risk-register.md) DA-186 and [09](./09-roadmap-m0-m9.md) (M7b) record. G-PCI stays OPEN.

**Why this pack now.**
- The roadmap names this slice. [12](./12-m7b-invoice-issue-decision-pack.md) §4, in the D-ISS-7 section (doc 12 line 368), says: "**Next product slice.** Void, then payment recording, which needs the owner's amount-due and payment policy (DA-186, G-PCI)".
- EXISTING: void is built in code ([13](./13-m7b-invoice-void-and-correction-decision-pack.md) §12; VOID-P1 `b607d51`, VOID-P2 and VOID-P2-R1).
- [06](./06-module-migration-map-m7.md) places payments in M7b, before M7c.

**Labels.** Each statement carries one class:
- **EXISTING**: verified in source at commit `ab7a7bf`, cited `path:line`.
- **ADOPTED**: policy already accepted, cited by document and section.
- **PROPOSED**: a new policy this pack recommends. It awaits the owner.
- **AMENDMENT**: a proposal that would change adopted text. It needs its own explicit owner choice and is never implied by accepting something else.
- **CONDITIONAL**: an implementation choice that applies only if the related proposal is accepted.
- **DEFERRED**: outside this pack.

**Default label.** Everything in §3 to §9 is PROPOSED or CONDITIONAL unless it cites an adopted document or a source line.

**Conventions.**
- "Not established" marks what the repository does not show.
- `path:line` references drift as files change.
- Migration file names are relative to `server/platform-identity/migrations/`.
- "The owner" is the product owner who decides §11. The `store_owner` role is always written as "the store owner (`store_owner`)".
- F-2 is the launch fact for the stores' jurisdictions and legal review. F-5 is the retention duration ([08](./08-production-gate-and-risk-register.md) DA-187; [13](./13-m7b-invoice-void-and-correction-decision-pack.md) §9).

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
| **Credit note, partial correction** | A document that adjusts what is owed. [12](./12-m7b-invoice-issue-decision-pack.md) D-ISS-1 places them with payments; this pack keeps them out of the first slice | DEFERRED |
| **Invoice void** | Issued → voided, terminal; the invoice keeps its number and contents | ADOPTED ([13](./13-m7b-invoice-void-and-correction-decision-pack.md) §12.1) |
| **Integrated payment** | Terminal or hosted card flows through a provider: authorization, capture, settlement, a processor void, refund, dispute, webhooks and reconciliation | ADOPTED direction (G-PCI; [05](./05-canonical-data-ownership-and-api-db-contracts.md) §5), not built, DEFERRED |
| **Demo POS payments** | The browser-only POS screen's cart payments, cash drawer and refund choices | EXISTING, legacy, untouched (§2) |

**How a staff recording relates to [05] §5's payment model (PROPOSED).**
- [05](./05-canonical-data-ownership-and-api-db-contracts.md) §5 defines a `payment` aggregate with an append-only `payment_event` log. Its lifecycle is initiated → authorized → captured → settled, plus void, refund, dispute and failed.
- A staff recording is a **manual payment**. It enters directly in one terminal state, *recorded*, which is asserted by staff. It never passes through initiated, authorized, captured or settled, because no processor is involved.
- A reversal is an append-only **correction event** on that manual payment. It is not a processor void, a refund or an invoice void.
- When integrated flows are built, their `payment` and `payment_event` design must absorb or sit beside these manual records, through a later decision and migration. This pack does not design that.
- The word "void" stays reserved for the invoice ([13](./13-m7b-invoice-void-and-correction-decision-pack.md)) and for [05]'s processor void.

**Recommended first slice (PROPOSED).** It is server-side only:
- record a payment;
- reverse a mistaken recording;
- read an invoice's payments and remaining amount;
- refuse a void while a payment is recorded, with the shop told how to word that refusal (D-PAY-10).

The shop's recording control is a later P2.

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
| Void | ADOPTED [13](./13-m7b-invoice-void-and-correction-decision-pack.md) §12.1, §12.5; `035_m7b_invoice_void.up.sql:34-69` | Any issued invoice of the store that is not already void can be voided. The routine is VOLATILE and requires READ COMMITTED. It holds the issued header FOR UPDATE (step 4), takes key 530030 SHARED and re-reads the levels for editable roles (step 5), then judges session expiry and the 10-minute recent sign-in itself on `clock_timestamp()` after its last lock wait (step 6). The "already void" check runs as a separate statement after every lock (step 7). D-VOID-1 deferred the payment rule: "recorded payments or amounts due (refuse, or require a refund or credit note first)" ([13](./13-m7b-invoice-void-and-correction-decision-pack.md) §4) |
| Store permissions | `server/platform-identity/m5CanonicalPermissions.ts:291-321` | Seven store keys. The load guard admits Approve only for `issue_invoices` (not sensitive) and `void_issued_invoices` (sensitive), each by name |
| Stored role levels | `026_m5_invoice_role_levels.up.sql:2`, `:13` (header) | The server stores per-role levels for exactly two domains, `customers` and `invoices` |
| Shop level picker | ADOPTED [13](./13-m7b-invoice-void-and-correction-decision-pack.md) D-VOID-2 | Invoices offers None, View, Create, Edit and Full. In the shop, only Full reaches Approve |
| Recent sign-in | `server/runtime/sessions.ts:173` | `RECENT_AUTH_MAX_AGE_MS = 10 * 60_000` |
| Idempotency | `server/runtime/idempotency.ts:107`, `:397-402` | Lease 60 s, retention 24 h, keys per principal |
| Kernel modes | `server/runtime/commandTransaction.ts:517` | A create-mode plan's aggregate id must equal the runtime's new id; a client cannot choose it. An update-mode plan names an existing aggregate at an expected version |
| Sealed answers | `server/persistence/postgresTransactionalStore.ts:710-713`, `:798-831` | The store has named sealed slots only for `conflict`, `invalidState`, `customerNotFound`, `issuingNotConfigured` and `amountOutOfRange`. `invalid_state` is sealed only in update mode. A create-mode `not_found` is a 503 unless its kind is in `NOT_FOUND_CREATE_KINDS` |
| Audit path | `server/persistence/postgresTransactionalStore.ts:855`; `002_authorization_audit_foundation.up.sql:251` | The store writes the command's audit record from TypeScript inside the command transaction. `occurred_at` is `now()`, the transaction start |
| Audit guard | ADOPTED [05](./05-canonical-data-ownership-and-api-db-contracts.md) line 38 | "When payments land", the audit forbidden-key guard and the log and error redaction must be extended to CVV/CVC, track1/2 and PIN block |
| No SAVEPOINT | `server/persistence/postgresTransactionalStore.ts:759-760`; [08](./08-production-gate-and-risk-register.md) DA-36 | A routine must write nothing before its last refusal |
| No events delivered | `server/composition/transactionKernel.ts:26` | The tenant root composes no delivery port |
| Startup | `server/persistence/postgresStartupPreflight.ts:11` | Requires exactly migrations 001–035 and an exact grant set. **The next migration is 036** (the folder ends at `035_m7b_invoice_void.*`) |
| Direct calls | [08](./08-production-gate-and-risk-register.md) DA-118, DA-119, DA-132, DA-114 (OPEN) | `tmpos_app` plus a live minted session key can call the definer routines directly, including 034's issue and 035's void. Such a call writes no audit record or idempotency completion and passes no HTTP check (DA-118, a pre-deployment blocker). DA-132 is the matching class for direct reads. A live store-owner key can set role levels directly (DA-119). An issuer-key holder can mint a session for any principal, with any `authenticated_at` (DA-93, DA-94). Audit provenance is TypeScript-only (DA-114) |
| Payment direction | ADOPTED G-PCI ([08](./08-production-gate-and-risk-register.md)); [05](./05-canonical-data-ownership-and-api-db-contracts.md) §5 | Cash, external terminal or manual reference, semi-integrated terminal, and hosted CNP. No PAN, CVV, track, PIN or processor credential ever touches TM POS2026. "Every payment state transition writes a durable append-only `audit_event`". No SAQ category is claimed |
| Demo POS | `src/components/POS.tsx:98`, `:143`, `:186`; `src/context/StoreLocalState.tsx:72`, `:358` | Browser state only. Payments are `{ method, amount }` in floating dollars (`215.41`), with cash rounding and refund-method choices. The screen calls no `/api/v1` route. This pack neither connects, migrates nor changes it, and the new feature never reads it |

None of this is a claim of PCI compliance or of any jurisdiction's invoice or payment rules. Excluding card data does not establish PCI compliance.

## 3. Decision notes

The decision table itself is §11. These notes give each decision's detail.

**D-PAY-1. Amount due and currency.**
- The issued invoice stays exactly as issued: its Total, tax line, seller and customer snapshot, number and `snapshotVersion` 1.
- Payments live in their own records beside it, and the remaining amount is derived from them, never stored on the invoice.
- **For an issued invoice:**
  - due = `total_cents`;
  - applied = the sum of `amount_cents` over payments with no reversal;
  - remaining = due − applied, computed in `numeric` so it cannot overflow.
  - Remaining is never negative, because D-PAY-2 refuses overpayment under the header lock.
- **For a voided invoice:** due, applied and remaining are all 0. Nothing is owed on a void document, and A2 guarantees that a voided invoice holds only reversed payments.
- **What is in and out of the amount.** Tax is included because the Total includes it, and nothing is recomputed. Discounts, deposits, prior balances, surcharges, tips and cash rounding are excluded. Amounts are exact US cents only, with no rounding step.
- **Status words on the wire.** Each carries the "recorded" sense, so no client can render one as a verified fact:

  | Word | When | Shop label |
  |---|---|---|
  | `nothing_due` | issued, Total 0 | "Nothing due" |
  | `no_payment_recorded` | no active payment | "No payment recorded" |
  | `recorded_partly` | partly recorded | "Payment recorded in part" |
  | `recorded_in_full` | remaining 0, Total above 0 | "Payment recorded in full" |
  | `voided` | the invoice is voided | "Voided" |

  Exactly one word applies. `voided` takes precedence, then `nothing_due`, then the other three by the remaining amount. The shop never says "Unpaid". Money may have been taken outside the product, as [13](./13-m7b-invoice-void-and-correction-decision-pack.md) D-VOID-1 already warns.
- **Version-1 meaning.** ADR-50 decision 1 says that "no later feature, payments included, silently reinterprets version-1 records or relabels their totals as balances", and that "the issued list is never described as an unpaid list".
  - Under A, the payment state is a separate read, not a field of the issued snapshot.
  - The issued list and detail answers do not change.
  - Using the Total as the starting amount due changes that adopted meaning, so it is an explicit amendment (A1) for the owner to accept or reject; the alternative is a new snapshot version.
  - This is the same reading the owner accepted for the void's lifecycle field ([13](./13-m7b-invoice-void-and-correction-decision-pack.md) §12.1 (i)).

**D-PAY-2. Full, partial and excess payment.**
- Partial payments are allowed: each amount is from 1 to the remaining amount.
- An underpayment is simply a partial payment. There are no due dates, dunning or late fees.
- Zero, negative or non-integer amounts are a 400 before any write.
- An amount above the remaining amount is a sealed 409 `amount_exceeds_remaining`.
- For cash, the operator records the applied amount and hands change back outside the product. Neither the tendered amount nor the change is stored.
- Concurrent recordings serialize on the header lock, so the second sees the reduced remaining amount (D-PAY-7).

**D-PAY-3. Methods.**
- `cash`: the operator states that cash was received.
- `external_card_terminal`: the operator states that a separate, unconnected terminal approved a charge.
- **Shop labels.** "Cash" and "Card on a separate terminal", with one note beside the payment status: "Payments are recorded by staff; the product does not verify them."
- Neither is a processor authorization, capture or settlement, nor an independently verified receipt of funds.
- This is the fallback that G-PCI and [05](./05-canonical-data-ownership-and-api-db-contracts.md) §5 name. Integrated flows, provider selection, store-owned gateway configuration ([05](./05-canonical-data-ownership-and-api-db-contracts.md) §5.1), webhooks, reconciliation and PCI validation stay open under G-PCI.
- **Card data.** The first slice has no card number, CVV, track, PIN, last-4, approval-code or free-text field at all.
- **A deliberate departure.** [05] §5 names "external-terminal/manual-reference". Leaving out the reference is a deliberate, recommended departure. Option D in §11 offers a bounded reference instead, with its risk stated.

**D-PAY-4. History and correction.** Record shapes are CONDITIONAL, with names fixed at P1.
- **The payment record:**
  - `payment_id`, the runtime's new id (the kernel's create-mode aggregate id);
  - `attempt_id`, a uuid generated by the shop for each attempt;
  - tenant, store and `invoice_id`, with a composite foreign key to 034's `issued_invoice_scope_key`;
  - `amount_cents`, from 1 to 2^53 − 1;
  - `method`, checked against D-PAY-3;
  - `recorded_at`, the routine's `clock_timestamp()` after its last lock;
  - `recorded_by`, the actor, never returned by a read;
  - a unique key on (tenant, store, invoice, attempt).
- **The reversal record:**
  - `payment_id` as its primary key, so there is at most one reversal per payment;
  - tenant, store and `invoice_id`, with a composite foreign key onto the payment's (payment, invoice, tenant, store);
  - `reason_code`;
  - `reversed_at`;
  - `reversed_by`.
- Both tables are insert-only, behind ENABLE ALWAYS guards that refuse UPDATE, DELETE and TRUNCATE, as 035's record does.
- **Time.** There is no effective or back-dated time: a payment taken while the system was unavailable is recorded later, under the later time. The audit record's `occurred_at` is the transaction start (`now()`), while `recorded_at` is `clock_timestamp()` after the locks. The two can differ by the in-transaction wait, as [13](./13-m7b-invoice-void-and-correction-decision-pack.md) D-VOID-4 notes for the void.
- **No external reference** is stored (D-PAY-3).
- **Reversal reasons**, closed, with no free text:
  - `recorded_in_error` ("Recorded by mistake");
  - `wrong_amount` ("Wrong amount");
  - `wrong_method` ("Wrong method");
  - `wrong_invoice` ("Wrong invoice");
  - `duplicate` ("Payment recorded twice");
  - `other` ("Other reason").
- **What a reversal is not.** It states that the recording was wrong. It is not a refund and returns no money.
- **The limitation this leaves.** If money really was received and must go back, the product cannot express it until refunds exist. The operator settles it outside the product and must not reverse a true recording to make the numbers fit. The refund prerequisites are G-PCI's lifecycle work (refunds idempotent, with [06](./06-module-migration-map-m7.md)'s M7b refund authorization) and an owner refund policy.

**D-PAY-5. How payments interact with an invoice void.** These are four different things:
- **Invoice void:** the document is withdrawn.
- **Payment reversal:** a recording is withdrawn.
- **Refund:** money goes back (deferred).
- **Credit note:** what is owed changes (deferred).

The recommended rules:
- A void is refused while any active payment exists, with the sealed 409 `payments_recorded`.
- Recording on a voided invoice is refused (`invalid_state`).
- Option B (void allowed, payments left as they are) shows money against a void document. Option C (void reverses payments automatically) hides a money fact inside a void.
- **The trade-off to weigh.** Under A, an invoice issued by mistake whose payment was genuinely received cannot be voided until refunds exist. The only in-product route is a reversal, which must not be used for a true recording. That creates a pressure to falsify a reversal. The owner should weigh this against B and C, and operators need an outside-the-product procedure until refunds land.

**D-PAY-6. Permissions and sign-in.**
- **Scope.**
  - The path's store must equal the trusted store.
  - The invoice must belong to that store and tenant; another store's or tenant's invoice is the same 404.
  - Only the write statuses (`active`, `trialing`) are allowed, so a read-only actor, tenant or store is refused.
  - There is no role-name, System Owner or creator shortcut.
- **New store keys** (illustrative names): `record_invoice_payments` and `reverse_invoice_payments`.
  - The load guard admits each by name only. The second becomes the second sensitive store key.
  - Invoices has no plan gate, so none applies ([13](./13-m7b-invoice-void-and-correction-decision-pack.md) §3.1, item 8).
- **Recording, option A:** Invoices ≥ Approve with Customers View, not sensitive. By default the store owner (`store_owner`) and `manager` qualify; `technician` and `sales_staff` do not.
- **Recording, option A′:** the same levels plus a recent sign-in.
- **Recording, option B:** Invoices ≥ Create, which adds `sales_staff` by default.
- **The trade-off for A.** With no sign-in check, a hijacked idle session can mark invoices "Payment recorded in full". Under A2 that blocks their void until a reversal, which does need a fresh sign-in. Issuing has the same holders and is also non-sensitive (`m5CanonicalPermissions.ts:299-302`).
- **Reversal:** its own key at Invoices ≥ Approve with Customers View, sensitive (sign-in within 10 minutes), with a required reason.
- **Reading:** the existing issued-invoice readers (`view_issued_invoices`).
- **Inherited and widened: DA-119.** A live store-owner key can set the Invoices and Customers levels directly (migrations 021 and 026), with no audit record. That already changes who can issue and void ([08](./08-production-gate-and-risk-register.md) DA-119). It would equally change who can record and reverse payments.

**D-PAY-7. Atomicity, concurrency and replay.**
- **Kernel modes** (CONDITIONAL):
  - *Recording* is a **create** on a payment aggregate. Its id is the runtime's new id. Its kind joins `NOT_FOUND_CREATE_KINDS` so a missing invoice answers 404.
  - *Reversal* is an **update** on that payment, with `expectedVersion` pinned at 1 as the void pins it. Its kind joins `PRECONDITION_UPDATE_KINDS`.
  - The invoice is never the aggregate: a payment does not move the invoice.
- **Routine rules** for the record, reverse and replacement void routines: plpgsql, VOLATILE, SECURITY DEFINER; READ COMMITTED required (else 55000); nothing written before the last refusal (DA-36). Every check made after a lock wait is its own statement, as `035_m7b_invoice_void.up.sql:58-60` explains. Under REPEATABLE READ, the sum would read the snapshot taken before the wait and could let an overpayment commit.
- **Recording order:**
  1. the arguments;
  2. the caller, derived as 035 derives it (016's hold, session, issuer key, admission, one store grant, write statuses) → `refused`;
  3. the levels, unlocked → `refused`;
  4. the tenant precondition → `tenant_mismatch`;
  5. **the issued header FOR UPDATE** (035's step-4 slot) → `not_found`;
  6. key 530030 SHARED and both levels re-read (editable roles) → `refused`;
  7. session expiry after the last wait (plus the recent sign-in under option A′) → `refused`;
  8. a separate statement: this attempt already recorded on this invoice → **`already_recorded`**;
  9. a separate statement: the invoice is voided → `invalid_state`;
  10. a separate statement: the active sum plus the amount exceeds the Total → `amount_exceeds_remaining`;
  11. the payment insert and its audit record (D-PAY-8 A) → `applied`.
- **Reversal order:**
  1. steps 1–4 as for recording;
  2. the issued header of the path's invoice FOR UPDATE → `not_found`;
  3. the payment, read by (payment, invoice, tenant, store) → `not_found`;
  4. key 530030 SHARED and the levels re-read → `refused`;
  5. session expiry and **the 10-minute recent sign-in, judged by the routine itself** on `clock_timestamp()` after the last wait, as 035's step 6 does → `refused`;
  6. a separate statement: already reversed → `invalid_state`;
  7. `p_expected_version` other than 1 → `conflict` (sealed `write_conflict`, unreachable through HTTP because the planner pins 1, as for the void);
  8. the reversal insert and its audit record → `applied`.
- **The void's new order (A2).** 035's order is unchanged until its step 7. After step 7, and before the version check, a separate statement asks whether an active payment exists → `payments_recorded`.
- **Lock order** (the argument 035's header asks to redo, `035_m7b_invoice_void.up.sql:98-101`). Both payment routines take 035's prefix, then the issued header FOR UPDATE at 035's step-4 slot, before key 530030 and before touching any payment or reversal row. Their foreign-key checks take FOR KEY SHARE on a header the transaction already holds, so there is no wait. Records, reversals and voids of one invoice therefore serialize on its header, and no new wait cycle is introduced. Deadlock freedom is argued per path, not proven.
- **The attempt id's scope.** It is unique per (tenant, store, invoice). Only a reuse on the same invoice answers `already_recorded`. A different invoice is a different attempt, so the answer reveals nothing across invoices, stores or tenants, and the header lock covers the check. The point is that a resend after a lost answer, even under a new key or after the 24 h key retention, can never record twice against the same invoice.
- **Idempotency:**
  - the same key and the same bytes replay the stored answer;
  - the same key with other bytes is a 422;
  - for sealed answers (`already_recorded`, `amount_exceeds_remaining`, `invalid_state`, `payments_recorded`), the kernel needs new named sealed slots (§6, I3). `invalid_state` must also be sealed for the record command, which runs in create mode.
- **Which guarantees hold where.**
  - **HTTP only:** idempotency replay and the 422; CSRF; the per-client rate limit; the route authorizer; the chain's own step-up check.
  - **Every permitted database entry point, a direct definer call included** (enforced inside the routine):
    - session liveness, expiry, standing and write statuses;
    - the store and tenant derivation from the key;
    - the stored levels;
    - the reversal's recent sign-in;
    - the remaining-amount bound;
    - the void exclusion;
    - the attempt rule;
    - one reversal per payment;
    - with D-PAY-8 A, the audit record, for the record and reverse routines only. The replacement void routine stays unaudited on a direct call (§7).
  - **Caveat:** the sign-in check stops a stale real session, not an issuer-key holder, who can mint a fresh `authenticated_at` (DA-93, DA-94; [13](./13-m7b-invoice-void-and-correction-decision-pack.md) §12.1).
- **Failure behaviour.**
  - A timeout, fault or ambiguous COMMIT is a 503 with the outcome unknown, never a claimed rollback.
  - Nothing re-sends automatically.
  - The P2 shop holds an unconfirmed attempt (its key, exact bytes and attempt id) outside the dialog, with "Check again" (the same key and bytes, within 23 h) and "Check payments" (the read). This is the pattern adopted in [13](./13-m7b-invoice-void-and-correction-decision-pack.md) D-VOID-5.

**D-PAY-8. Direct-call prerequisite.** The full note is §7: the options, what the recommended option does and does not guarantee, and the register amendments PAYMENTS-P1 must make. Accepting D-PAY-8 accepts §7's text for the chosen option.

**D-PAY-9. Retention.**
- Nothing deletes or edits a payment, a reversal, or the audit records that name them.
- Idempotency records follow the existing 24 h policy.
- 036's down refuses while any payment, reversal or payment audit record exists (§6, I4).
- This is an **interim engineering default, not a retention policy**.
- **Missing inputs:**
  - the retention duration (F-5);
  - the stores' jurisdictions and legal review (F-2);
  - the owner's business retention and DSAR decision under G-PRIVACY.
- **Personal data.** `recorded_by` and `reversed_by` identify staff. Through the invoice, a payment links to the customer's name in the snapshot.
- No statutory period is assumed.

**D-PAY-10. The PAYMENTS-P1 boundary.**
- P1 is the server, database and HTTP boundary plus a separate payments read (§8).
- The existing issued list and detail answers stay byte-identical.
- **One shop change belongs in P1.** The shop's decoders are exact ([13](./13-m7b-invoice-void-and-correction-decision-pack.md) §3.3, constraint 3), so its void flow must accept the new `payments_recorded` refusal with a fixed message: "This invoice has payments recorded, so it can't be voided. If a payment was recorded by mistake, reverse that payment first." (It never mentions a refund, and the reversal applies only to a recording that was itself wrong.) Otherwise, between P1 and P2, voiding an invoice that has payments recorded through the API would meet an unknown 409 word.
- The shop's recording and reversal controls are P2.

## 4. State and operation matrix (recommended policy)

"Active" means a payment with no reversal. The precedence after the header lock is: a reused attempt on this invoice (`already_recorded`), then voided (`invalid_state`), then the amount bound (`amount_exceeds_remaining`). So a reused attempt on a voided invoice answers `already_recorded`. For each sealed answer, a same-key replay returns the same answer.

| Invoice state (read word) | Record a payment | Reverse a payment | Void the invoice | Read payments |
|---|---|---|---|---|
| Issued, Total 0 (`nothing_due`) | 409 `amount_exceeds_remaining` (remaining 0) | Not applicable: there are no payments | Allowed (unchanged) | 200: due 0, applied 0, remaining 0 |
| Issued, no active payment (`no_payment_recorded`) | Allowed for 1 ≤ amount ≤ remaining | 409 `invalid_state` for an already reversed payment; another invoice's payment is 404 | Allowed (unchanged) | 200 |
| Issued, partly paid (`recorded_partly`) | Allowed for 1 ≤ amount ≤ remaining | Allowed (recent sign-in); the remaining amount grows again | **409 `payments_recorded`** (A2) | 200 |
| Issued, paid (`recorded_in_full`) | 409 `amount_exceeds_remaining` | Allowed (recent sign-in) | **409 `payments_recorded`** (A2) | 200 |
| Voided (`voided`; only reversed payments, by construction) | 409 `invalid_state` | 409 `invalid_state` (already reversed) | 409 `invalid_state` (unchanged) | 200: due, applied and remaining 0, history kept |

## 5. Worked examples (synthetic)

Invoice **A**:
- subtotal 9,000 cents at an `exclusive_rate` of 8,250 (8.25 %);
- tax = div(9,000 × 8,250 + 50,000, 100,000) = 743;
- Total 9,743 ($97.43).

| # | Situation | Request | Result | Remaining |
|---|---|---|---|---|
| 1 | Full cash payment | A, cash 9,743 | 201 recorded; `recorded_in_full` | 0 |
| 2 | Partial, then the rest | A, `external_card_terminal` 5,000, then cash 4,743 | 201 and 201; `recorded_partly`, then `recorded_in_full` | 4,743, then 0 |
| 3 | Excess cash | After the first payment of #2, the customer hands over $50.00 and the operator enters 5,000 | Sealed 409 `amount_exceeds_remaining`, nothing written. The operator records 4,743 and hands back 257 ($2.57) outside the product; neither the tendered amount nor the change is stored | 4,743, then 0 |
| 4 | Replay and conflicting replay | Key K1 with body {5,000, `external_card_terminal`, attempt P1} on A → 201. K1 with the same bytes → the stored 201 replayed (`Idempotent-Replayed: true`). K1 with 5,001 → 422 `idempotency_key_reused`. A new key K2 with attempt P1 on A → sealed 409 `already_recorded` (it precedes the amount check, so 5,000 > 4,743 does not matter) | Exactly one payment of 5,000 | 4,743 |
| 5 | Two concurrent attempts | Invoice **B**, Total 10,000, no payments. Two users each send 6,000 at once (different keys and attempt ids) | One acquires B's header lock and the other waits. The first commits (remaining 4,000). The second's separate sum statement then sees 4,000 < 6,000 → sealed 409 `amount_exceeds_remaining` | 4,000 |
| 6 | Paid and voided interaction | Void A after #1 → sealed 409 `payments_recorded`. If, and only if, the recording itself was wrong: reverse it (`recorded_in_error`, with a recent sign-in) → remaining 9,743, then the void → 200. Recording on the now-voided A → 409 `invalid_state` | The void and the payment history are both kept; A reads `voided` | 0 (nothing is due on a voided invoice) |
| 7 | Race between void and payment | A void of B and a payment to B arrive together | Both lock B's header. If the void wins, the payment is 409 `invalid_state`; if the payment wins, the void is 409 `payments_recorded` | Depends on the order |

## 6. Proposed amendments, and contract changes at implementation

**Amendments of adopted policy text** (each needs its own owner choice):

| # | Adopted text | Proposed change | Required owner decision |
|---|---|---|---|
| **A1** | [12](./12-m7b-invoice-issue-decision-pack.md) D-ISS-1 and ADR-50 decision 1: the Total claims no amount due, unpaid status or balance; the shop shows no paid or unpaid status; no later feature, payments included, silently reinterprets version-1 records or relabels their totals as balances | Once payments are adopted, the amount due is defined in the payment domain (D-PAY-1): derived from the version-1 Total on a separate payments read, and never stored on the invoice. Issuing itself still creates nothing. The issued row keeps its "never an amount due" comment, the issued list and detail stay unchanged, and labels say "recorded". `snapshotVersion` stays 1 | Accept A1 as an explicit amendment of ADR-50 decision 1's and D-ISS-1's meaning of the Total (not a silent reinterpretation): it allows a separate payments read to treat the Total as the starting amount due, and narrows D-ISS-1's "no paid or unpaid status", with no "Unpaid" wording. The alternative is a new snapshot version for invoices issued after payments exist |
| **A2** | [13](./13-m7b-invoice-void-and-correction-decision-pack.md) D-VOID-1 and §12.1: any issued invoice not already void can be voided | A void is refused while any active payment exists (`payments_recorded`). 036 adds a replacement void routine with the extra check (D-PAY-7) and revokes `tmpos_app`'s EXECUTE on 035's `m7b_invoice_void`, as 033 and 035 did for earlier routines. The void eligibility read and the shop's void flow gain the refusal (D-PAY-10) | Accept the void restriction and its trade-off (D-PAY-5); otherwise choose B or C |
| **A3** | [13](./13-m7b-invoice-void-and-correction-decision-pack.md) §12.4 and §12.5: the void's sealed answers | `payments_recorded` becomes a fourth sealed void answer | Follows from A2 |
| **A4** | [05](./05-canonical-data-ownership-and-api-db-contracts.md) §5: "every payment state transition writes a durable append-only `audit_event`" | Needed **only if** D-PAY-8 B (without A) or C is chosen. A direct definer call could then commit an unaudited payment, so [05] §5 needs an explicit amendment or a time-boxed waiver | Only with D-PAY-8 B or C |

**Contract changes at implementation.** These are not policy, but each changes an adopted engineering contract and is recorded in the P1 ADR:
- **I1.** The store-permission load guard admits two more keys by name (`m5CanonicalPermissions.ts`).
- **I2.** The kernel and store gain "routine-audited" kinds, whose audit record the routine writes. The store must then not write a second one (D-PAY-8 A).
- **I3.** The store gains named sealed slots: `already_recorded`, `amount_exceeds_remaining`, the create-mode `invalid_state` and `payments_recorded`. `NOT_FOUND_CREATE_KINDS` and `PRECONDITION_UPDATE_KINDS` each gain one kind.
- **I4.** 036's up adds an anchor that keeps 035 from rolling back under it, as 035 anchored 034 (`035_m7b_invoice_void.up.sql:13-14`). 036's down restores `tmpos_app`'s EXECUTE on 035's void routine exactly, so the 001–035 runtime starts again. The down refuses while any payment, reversal or payment-action audit record exists, as 035's down does for voids.

No other adopted text is replaced. Doc 13's decisions, reason codes and held-attempt behaviour stay as adopted.

## 7. Direct-call security prerequisite (D-PAY-8)

**The current state (EXISTING).**
- A holder of the runtime login with `tmpos_app` and a live minted key can already call 034's issue and 035's void routines directly, writing no audit record ([08](./08-production-gate-and-risk-register.md) DA-118).
- A payment routine built the same way would let that holder commit a payment or a reversal that no audit record shows. That is a money statement with no trail.
- A route wrapper cannot prevent it, because the direct call never passes through the route.

**Option A (recommended): a bounded remedy for the payment path.**
- The record and reverse routines insert their own `audit_event` row in the same transaction, after their last refusal. Each raises unless that insert wrote exactly one row, which guards against a trigger silently dropping it.
- Every value in the audit row except the correlation id is derived by the routine itself: actor, tenant, store, permission, action and the fixed sentence. The correlation id must be a canonical uuid.
- The store does not write a second audit record for these kinds (I2).
- **Effect.** Every committed payment or reversal, through any permitted entry point, has an audit record, which meets [05] §5's audit rule. (Narrowed 2026-11-07.) This addresses audit coupling only. It does not close the other direct-call bypasses listed below.
- **Apply-time checks for 036.** The routine owner can insert into `public.audit_event` (whether it can is not established), and row security is not forced on that table. This follows the pattern of 035's prerequisite checks.
- **What A does not do:**
  - A direct call still commits with no idempotency completion, CSRF check, rate limit or chain step-up. **So under A, payments still widen DA-118, in an audited form.**
  - It does not prove who acted. The actor is whoever the session key names, and an issuer-key holder can mint a key for any principal (DA-93, DA-94).
  - It does not prove the correlation id. A direct caller can reuse a real request's id, because `request_id` has no uniqueness rule.
  - Once a key's 24 h completion is gone, a direct call's audit row looks the same as an HTTP one.
  - The runtime login can still forge audit rows through `tmpos_audit_writer` (G-AUDIT; DA-114).
  - It does not cover 036's replacement void routine. That stays inside DA-118, unaudited, like 035's.
  - The payments read joins DA-132's direct-read class.
- **Register amendments PAYMENTS-P1 must make**, as [13](./13-m7b-invoice-void-and-correction-decision-pack.md) §12.1 did for the void: DA-118, DA-119, DA-132, DA-183 and DA-184, DA-186 and DA-187. All stay OPEN pre-deployment blockers unless a later decision closes them.

**Option B: a wider DA-118 remedy first.**
- Make every definer command routine (020–035) self-auditing, or adopt another structural boundary.
- It is the stronger end state, but it is cross-cutting, and payments would wait for it.
- If B's boundary covers 036's payment routines, so that no direct call can commit a payment unaudited, then A4 is not needed and the DA-118 widening in this section does not arise. If it does not cover them, A4 is needed.

**Option C: inherit the class.**
- Not recommended. Building payments without A or B is a deliberate deferral that needs its own explicit owner decision, recorded as such, plus A4.
- DA-118 and DA-119 remain pre-deployment blockers whatever is chosen. Nothing here accepts or waives them.

## 8. PAYMENTS-P1 boundary (CONDITIONAL; for planning only, not implemented)

**Scope:**
- migration **036** (`036_m7b_invoice_payment.up.sql` and `.down.sql`, a new schema);
- `POST /api/v1/stores/{storeId}/invoices/{id}/payments` (record);
- `POST …/invoices/{id}/payments/{paymentId}/reversal` (reverse; recent sign-in);
- action-only eligibility reads for both;
- `GET …/invoices/{id}/payments` (the records, reversals, due, applied, remaining and the read word);
- the void's replacement routine and its new refusal (A2, A3);
- the shop's void decoder for that refusal (D-PAY-10);
- the audit guard extension to CVV/CVC, track1/2 and PIN block, with its test ([05] line 38).

The existing issued list and detail answers stay byte-identical.

**Likely files** (inspected; all exist except the new ones):
- **New:** `server/runtime/invoicePayments.ts`, `server/persistence/postgresInvoicePayments.ts`, `tests/db/invoicePaymentRoutine.integration.test.mjs` and `tests/db/invoicePaymentHttp.integration.test.mjs`, each with a CI step in `.github/workflows/ci.yml`.
- **Changed:**
  - `server/platform-identity/m5CanonicalPermissions.ts` (I1);
  - `server/runtime/routes.ts` and `server/entry/tenantEntry.ts` (routes; 31 today);
  - `server/composition/tenantTransactions.ts`;
  - `server/runtime/app.ts` and `server/persistence/postgresTransactionalStore.ts` (`PRECONDITION_UPDATE_KINDS`, `NOT_FOUND_CREATE_KINDS`, the sealed slots and the routine-audited kinds; I2, I3);
  - `server/runtime/commandTransaction.ts`;
  - `server/platform-identity/auditEventWriter.ts` (the forbidden-key guard and the closed lists);
  - `server/runtime/invoiceVoid.ts` and `server/persistence/postgresInvoiceVoid.ts` (A2, A3);
  - `server/persistence/postgresStartupPreflight.ts` (001–036 and the grants);
  - the pins in `tests/quality/migration-files-contract.test.mjs`, `tests/quality/production-runtime-contract.test.mjs`, `server/entry/tenantEntry.test.ts` and `tests/db/migrationsThrough.mjs`;
  - the void suites `tests/db/invoiceVoidRoutine.integration.test.mjs` and `tests/db/invoiceVoidHttp.integration.test.mjs`;
  - the shop's void client decoder and its message. These sit under `src/tenant/`; the exact file is fixed at P1.
- **The shop in P2:** `src/tenant/ServerIssuedInvoices.tsx` and `src/tenant/invoiceIssuingClient.ts`.

**Excluded:**
- `src/components/POS.tsx` and every demo POS state;
- providers, terminals and webhooks;
- refunds and credit notes;
- any card or reference field;
- deployment, managed databases and live services;
- any change to 034's or 035's existing rows.

**Planned evidence (PLANNED — NOT RUN):**
- the bound: no sum above the Total, including under REPEATABLE READ, which is refused;
- concurrent recordings serialize (two parallel sessions);
- the replay, 422 and `already_recorded` answers, and a cross-invoice attempt being independent;
- another tenant or store answers 404, with nothing written;
- refusals write nothing;
- the payment, its audit record and the completion commit or roll back together;
- **a direct definer call writes exactly one audit record, cannot exceed the remaining amount, cannot pay a voided invoice, and cannot reverse without a fresh session sign-in**;
- the void race in both orders;
- the grants equal the approved list;
- 036's anchor holds, and its down refuses after the first payment and restores 035's grant;
- the audit guard refuses card-shaped keys;
- green exact-commit CI.

## 9. Dependencies and what stays unchanged

| Item | Effect of this pack |
|---|---|
| DA-186 | Payments and amounts due become decided only when §11 is accepted. Refunds, credit notes and the rest stay undecided |
| DA-187, G-PRIVACY | Unchanged. D-PAY-9 is an interim default; F-5, F-2 and the owner's DSAR decision are missing inputs; no statutory period is assumed |
| DA-118, DA-119, DA-132, DA-114, DA-36 | Unchanged and OPEN now. Under A or C, PAYMENTS-P1 widens DA-118 (audited under A), DA-119 and DA-132; under a B that covers 036, the DA-118 widening does not arise (§7) |
| G-PCI | OPEN. Manual recording neither selects a provider nor validates any PCI category |
| G-AUDIT, G-IDEMPOT, G-PERSIST, G-IAM, G-DBROLE | OPEN. No gate closes |
| All 37 gates | OPEN. Nothing is deployed |

**Not claimed:**
- payment recording is available;
- any policy is adopted;
- any jurisdiction's rules are met;
- PCI compliance, an SAQ category or eligibility, or the platform's own PCI service-provider (TPSP) scope;
- any test in §8 has run;
- M7b completion;
- production readiness.

## 10. How the owner answers

Copy the template, fill in each bracket and send it. ACCEPT accepts that decision's full §11 row and §3 notes (§7 for D-PAY-8), not only a summary. No line counts as accepted until the owner returns it.

```
M7B payment recording — owner decisions
D-PAY-1 amount due:      [ACCEPT | CHANGE: …]
D-PAY-2 partial/excess:  [ACCEPT | CHANGE: …]
D-PAY-3 methods:         [ACCEPT A | B | C | D | CHANGE: …]
D-PAY-4 correction:      [ACCEPT | CHANGE: …]   reversal reasons: [ACCEPT | CHANGE: …]
D-PAY-5 void:            [ACCEPT A | B | C | CHANGE: …]
A2, A3 void amendments:  [ACCEPT | CHANGE: …]   (needed for D-PAY-5 A)
A1 amount-due wording:   [ACCEPT | CHANGE: …]
D-PAY-6 permissions:     [ACCEPT A | A′ | B | CHANGE: …]
D-PAY-7 replay:          [ACCEPT | CHANGE: …]
D-PAY-8 direct calls:    [ACCEPT A | B (+A4 unless B covers 036) | C (explicit deferral, +A4) | CHANGE: …]
D-PAY-9 retention:       [ACCEPT interim default | CHANGE: …]
D-PAY-10 slice:          [ACCEPT | CHANGE: …]
```

Only the owner's returned choices authorize adopting any of this policy or starting PAYMENTS-P1.

## 11. Owner decisions required before PAYMENTS-P1

Every recommendation is PROPOSED and unadopted. The Owner choice column is left for the owner.

*(2026-11-07: the owner's choices are recorded in §12.1. The table is kept as proposed, with the "—" cells unchanged as history.)*

| ID | Existing constraint | Realistic options | Recommendation | Rationale / trade-off | Prerequisite (and what it blocks) | Owner choice |
|---|---|---|---|---|---|---|
| **D-PAY-1** Amount due and currency | Immutable USD Total in integer cents; no amount due, balance, discount or deposit | **A** derived: due = Total; remaining = Total − active payments, never stored; voided → 0. **B** a stored balance. **C** a configurable due | **A**, with tax included and discounts, deposits, balances, tips and rounding excluded | One source of truth that the snapshot already fixes; B can drift; C rewrites what was invoiced | A1. Blocks every amount check and read | — |
| **D-PAY-2** Full, partial, excess | None | **A** partial (1 to remaining), overpayment refused, change not stored. **B** full only. **C** store tendered, applied and change | **A** | Covers deposits after issue and split tender without an unowned credit; C adds drawer meaning with no drawer | D-PAY-1. Blocks the bound and the sealed answers | — |
| **D-PAY-3** Methods | G-PCI; [05] §5's data boundary; no provider | **A** `cash` and `external_card_terminal`, recorded by staff, no reference. **B** A plus cheque, bank transfer or `other`. **C** wait for the integrated flow. **D** A plus a bounded, non-card-shaped terminal reference, with refusal tests | **A** | An assertion, not a settlement. A reference is a card-number channel, and D reduces that risk but does not remove it | Does not satisfy G-PCI. Blocks the method CHECK and the labels | — |
| **D-PAY-4** History and correction | Append-only precedent | **A** append-only payments plus a whole-payment reversal with six closed reasons, and no back-dating. **B** record only. **C** editable payments | **A** | B leaves mistakes uncorrectable; C destroys history; refunds stay deferred | The reason list. Blocks the reversal and the record shapes | — |
| **D-PAY-5** Void interaction | D-VOID-1: any issued invoice is voidable | **A** void refused while a payment is active; recording on a voided invoice refused. **B** void allowed. **C** void auto-reverses | **A** | B shows money on a void document; C hides it. A blocks voiding a genuinely paid wrong invoice until refunds exist | A2, A3. Blocks 036's void replacement | — |
| **D-PAY-6** Permissions and sign-in | Seven store keys; levels stored for Customers and Invoices only; DA-119 | Record at **A** Approve + Customers View; **A′** A plus a recent sign-in; **B** Create + Customers View | **A** for recording; reversal at Approve + Customers View, sensitive, with a reason; reading as issued-invoice readers | A matches issue's holders, but a hijacked idle session could record. A′ narrows that to sessions with a recent sign-in, at the cost of re-authentication; it does not stop a hijacked fresh session or an issuer-key holder (narrowed 2026-11-07). B widens who asserts money arrived | I1. Blocks the keys and the guard | — |
| **D-PAY-7** Atomicity, concurrency, replay | Idempotency 24 h; header lock pattern; no SAVEPOINT; sealed-slot list | **A** header FOR UPDATE under READ COMMITTED, separate checks, attempt id unique per invoice, record = create and reverse = update. **B** A without the attempt id. **C** a version on the wire | **A** | Payments are not one per invoice, so a new-key resend can duplicate; B bounds that only by the remaining amount | I3. Blocks the command contract | — |
| **D-PAY-8** Direct-call prerequisite | DA-118, DA-119, DA-132 OPEN; TypeScript audit only; [05] §5 audit rule | **A** routines write their own audit record (bounded). **B** a wider DA-118 remedy first. **C** inherit the class | **A**, required before PAYMENTS-P1 | A makes payments self-auditing but still widens DA-118 in audited form; B delays payments; C needs explicit deferral and A4 | I2 and a kernel review. Blocks **PAYMENTS-P1 as a whole** | — |
| **D-PAY-9** Retention | DA-187 undecided; F-5, F-2 missing | **A** keep everything as an interim default; 036's down refuses once data exists. **B** set a period now | **A** | B needs legal input the repository lacks; reversal erases nothing; staff ids are personal data | F-5, F-2, G-PRIVACY. Blocks the final retention policy and live use, not 036's interim down | — |
| **D-PAY-10** P1 boundary | VOID-P1/P2 split; exact shop decoders | **A** P1 server plus the payments read plus the shop's void decoder; recording UI in P2. **B** everything in one stage | **A** | It isolates the money boundary's evidence, and the void's refusal is not left undecodable | D-PAY-1 to D-PAY-9. Blocks stage planning | — |

## 12. P1 implementation contract (ADOPTED, M7B-PAYMENTS-P1)

**Status of this section: ADOPTED by the owner's stage instruction of 2026-11-07 ([10](./10-architecture-decision-records.md) ADR-52); implementation in progress at adoption and delivered in code at commit B `3081aa3`, except its P2 parts (§12.1, §12.6, §12.7); see §12.10–§12.11.** It is the contract stage M7B-PAYMENTS-P1 implements, written before any shared code changes. At adoption none of it is committed, run or deployed. §3 to §8 apply as reconciled here; each refinement is named. The names below are fixed, no longer illustrative.

### 12.1 The owner's choices (2026-11-07)

| Decision | Choice | What it fixes |
|---|---|---|
| D-PAY-1 | **A** | Amounts are derived in USD integer cents (§12.4). |
| A1 | **ACCEPTED** | A separate payments read treats the version-1 Total as the starting amount due. The issued list and detail answers, the snapshot and `snapshotVersion` 1 are unchanged. It is an explicit amendment of ADR-50 decision 1 and D-ISS-1, not a silent reinterpretation; no shop text says "Unpaid". |
| D-PAY-2 | **A** | Partial recording is allowed; an applied overpayment is refused; tendered cash and change are not stored. |
| D-PAY-3 | **A** | `cash` and `external_card_terminal`, entered by staff, with no reference or card-data field. |
| D-PAY-4 | **A**, the six reasons **ACCEPTED** | Append-only records and whole-recording reversal; no back-dating. |
| D-PAY-5 | **A** | No void while an active payment exists; no recording on a voided invoice. |
| A2, A3 | **ACCEPTED** | The void restriction, and `payments_recorded` as the void's sealed refusal. |
| D-PAY-6 | **A** | Recording at Invoices ≥ Approve with Customers ≥ View, no recent sign-in. Reversal is its own sensitive capability at the same levels, with a sign-in within 10 minutes and a required closed reason. Reads use `view_issued_invoices`. |
| D-PAY-7 | **A** | The shared issued-header lock, separate checks, an attempt id unique per (tenant, store, invoice), and the existing HTTP idempotency. |
| D-PAY-8 | **A** | The two payment routines write their own audit record atomically. §7's residual risks are kept for bounded development. A4 is not adopted and not required. |
| D-PAY-9 | **ACCEPTED** (interim default) | Nothing is deleted; 036's down refuses once payment evidence exists. Final retention and live use stay unresolved (F-5, F-2, G-PRIVACY). |
| D-PAY-10 | **A** | Backend, the payments read and the void's compatibility in P1; the shop's recording and reversal controls in P2. |

**Bounded clarifications of the stage instruction.**
1. **D-PAY-10's row.** Checked: its recommendation, rationale and prerequisite cells are complete in §11, so the row is unchanged.
2. **Security wording.** Self-auditing addresses audit coupling, not every direct-call bypass. A′ (not chosen) would reduce stale-session exposure; it would not stop a hijacked fresh session or an issuer-key holder. §7 and §11 carry the narrowed text; the choice stays A.
3. **Events and outbox.** Resolved from adopted contracts, not a new policy. No approved event contract exists for payments, and none is invented, as for the customer create ([10](./10-architecture-decision-records.md) ADR-34), the draft discard, the issue and the void. The three commands declare `events: []`: nothing is enqueued, no outbox row is written, and there is no worker, publisher or delivery promise. The tenant root composes no delivery port. The payment and reversal rows are themselves the append-only record of each manual payment's transitions ([05](./05-canonical-data-ownership-and-api-db-contracts.md) §5's `payment_event` role for a manual recording); integrated flows will need their own decision.

**A2's eligibility text, reconciled.** §6 said "the void eligibility read … gain[s] the refusal". The adopted void eligibility is action-only and target-blind ([13](./13-m7b-invoice-void-and-correction-decision-pack.md) §12.4), and the stage instruction keeps eligibility advisory. So the eligibility answer is unchanged and is not proof that an invoice has no active payment; the POST decides `payments_recorded`, and the shop's void flow decodes it.

### 12.2 Names

| Item | Name |
|---|---|
| Migration | `036_m7b_invoice_payment.up.sql` and `.down.sql`, schema `tmpos_invoice_payment` (the next free number: the folder ends at 035) |
| Tables | `invoice_payment`, `invoice_payment_reversal` |
| Routines (EXECUTE to `tmpos_app`) | `m7b_invoice_payment_record`, `m7b_invoice_payment_reverse`, `m7b_invoice_void_v2`, `m7b_invoice_payments_get` |
| Granted to nobody | `m7b_invoice_payment_guard`, `m7b_invoice_payment_truncate_guard`, `m7b_invoice_payment_reversal_guard`, `m7b_invoice_payment_reversal_truncate_guard`, the anchor `m7b_invoice_payment_prerequisites` |
| Store permissions | `record_invoice_payments` (not sensitive), `reverse_invoice_payments` (sensitive) |
| Command kinds | `store.invoice_payment.record` (create), `store.invoice_payment.reverse` (update); aggregate `invoice_payment`; context scope `store`; also the audit action ids |
| Audit additions | column `public.audit_event.subject_invoice_payment_id`; index `idx_audit_event_subject_invoice_payment_occurred`; CHECK `audit_event_metadata_no_card_data_keys_chk` |
| Server modules | `server/runtime/invoicePayments.ts`, `server/persistence/postgresInvoicePayments.ts` |

**Methods**, pinned in this order in the database CHECK, the server enum and the audit text: `cash` ("Cash"), `external_card_terminal` ("Card on a separate terminal").

**Reversal reasons**, pinned in this order: `recorded_in_error` ("Recorded by mistake"), `wrong_amount` ("Wrong amount"), `wrong_method` ("Wrong method"), `wrong_invoice` ("Wrong invoice"), `duplicate` ("Payment recorded twice"), `other` ("Other reason"). Changing either list is a migration.

### 12.3 HTTP

| Route | Permission | Recent sign-in | Body | Idempotency |
|---|---|---|---|---|
| `POST /api/v1/stores/{storeId}/invoices/{id}/payments` | `record_invoice_payments` | none | JSON ≤ 1,024 bytes, exactly `{"expectedTenant", "attemptId", "amountCents", "method"}` | required |
| `GET /api/v1/stores/{storeId}/invoices/{id}/payment-eligibility` | `record_invoice_payments` | none | none | none |
| `POST /api/v1/stores/{storeId}/invoices/{id}/payments/{paymentId}/reversal` | `reverse_invoice_payments` | **required** | JSON ≤ 1,024 bytes, exactly `{"expectedTenant", "reasonCode"}` | required |
| `GET /api/v1/stores/{storeId}/invoices/{id}/payment-reversal-eligibility` | `reverse_invoice_payments` | none | none | none |
| `GET /api/v1/stores/{storeId}/invoices/{id}/payments` | `view_issued_invoices` | none | none; query empty or exactly `?after=<payment id>` | none |
| `POST /api/v1/stores/{storeId}/invoices/{id}/void` (changed) | `void_issued_invoices` | required | unchanged | required |

Every route is a tenant session route with a trusted store context, CSRF, session binding and the per-client limit, as the void's. Server-derived actor, tenant, store and times are never caller assertions.

- **Body values.** `expectedTenant` and `attemptId`: canonical lowercase uuids. `amountCents`: a JSON safe integer, 1 to 2^53 − 1. `method`: one of the two codes. `reasonCode`: one of the six. Any other key, a missing key, a version, an actor, a time, a reference or a card-shaped field is the 400 `invalid_request` after the key is taken.
- **Targets.** `{id}` (the issued invoice) and `{paymentId}` must be canonical lowercase uuids in the outbox's aggregate-id shape; otherwise 400 after the key. The reversal is the route table's one template with two id segments. Its idempotency fingerprint appends the invoice id and then the payment id, so one key sent to another invoice or another payment is a 422, never a replay. Every existing fingerprint is unchanged.
- **Record answers.** Sealed and replayable: `201 {"payment": {"id", "invoiceId", "attemptId", "amountCents", "method"}}` (the runtime's new payment id; built by the planner, nothing read back, no Location header); `409 {"error": "already_recorded"}`; `409 {"error": "invalid_state"}` (voided); `409 {"error": "amount_exceeds_remaining"}`; `409 {"error": "write_conflict"}` (carried by every command, unreachable here).
- **Reversal answers.** Sealed: `200 {"payment": {"id", "invoiceId", "status": "reversed"}}`; `409 invalid_state` (already reversed); `409 write_conflict` (a version other than 1, unreachable through HTTP because the planner pins 1).
- **Void answers.** Unchanged, plus the sealed `409 {"error": "payments_recorded"}`.
- **Unsealed answers**, the chain's `{error, requestId}`: `409 write_conflict` (the tenant changed); `404 not_found` (missing, another store's or another tenant's invoice, or a payment not of this invoice, one shape); 400, 401, 403 (`forbidden`, `step_up_required`), 413, 415, 429 with their existing words; `409 request_in_progress`; `422 idempotency_key_reused`; `503 service_unavailable` for every outage, routine refusal, stale session or sign-in after the waits, timeout or ambiguous COMMIT (the outcome unknown; never a claimed rollback). Nothing re-sends automatically.
- **Eligibility.** Each answers `200 {"eligibility": "allowed"}` exactly when the chain admits its permission at that store now. Action-only and target-blind: not proof that the invoice exists, is not voided, has a remaining amount or a reversible payment, or that the sign-in is recent enough for the reversal.
- **The payments read.** `200` with exactly these members, in this order:
  - `invoice`: `{"id", "status"}`, status `issued` or `voided`;
  - `amounts`: `{"currency": "USD", "dueCents", "appliedCents", "remainingCents"}`;
  - `paymentStatus`: one of the five words of §3 D-PAY-1;
  - `payments`: a page of at most 50, oldest first by (recorded time, payment id), each `{"id", "attemptId", "amountCents", "method", "recordedAt", "reversal"}`, where `reversal` is `null` or `{"reversedAt", "reasonCode"}`;
  - `nextCursor`: the last payment id of a full page when more exist, else `null`.

  Times use the issued reads' exact encoding (UTC, microseconds, `Z`). The amounts and the word cover the invoice's complete history, never one page. The page, the amounts, the word and the invoice's status come from one statement and one snapshot, so a concurrent record, reversal or void is seen wholly or not at all. No staff identifier, audit field or correlation id is returned. Refusals: `400 invalid_request` (any query but `after`, a bad id, an unknown cursor); `403 forbidden`; `404 not_found`; `503`. The issued list and detail answers stay byte-identical.

**Precedence, record (the runtime's real order).** The chain's checks → the body read → the key and its acquisition (replay, `request_in_progress`, `422`) → the 400 plan → in the transaction: the lease fence (503) → revalidation, `record_invoice_payments` decided again (503) → the routine: authority (503), tenant (409 unsealed), the invoice header (404), levels re-read and session expiry after the waits (503), **reused attempt on this invoice → sealed `already_recorded`**, **voided → sealed `invalid_state`**, **amount above remaining → sealed `amount_exceeds_remaining`**, then the payment and its audit record → the completion → 201.

**Precedence, reversal.** The chain (including `403 step_up_required` past 10 minutes) → body → key → plan → fence → revalidation with the deadline → the routine: authority, tenant, the path invoice's header (404), the payment by (payment, invoice, tenant, store) (404), levels re-read, session expiry and the 10-minute sign-in after the waits (503), **already reversed → sealed `invalid_state`**, **version other than 1 → sealed `write_conflict`**, then the reversal and its audit record → the adapter's sign-in re-check (503) → the completion → 200.

**Precedence, void.** Doc 13 §12.3 unchanged to "already void → sealed `invalid_state`", then **an active payment → sealed `payments_recorded`**, then the version → `write_conflict`.

### 12.4 Database (migration 036, schema `tmpos_invoice_payment`)

- **`invoice_payment`.** `payment_id uuid` primary key (the runtime's new aggregate id); `tenant_id`, `store_id`, `invoice_id uuid not null`; `attempt_id uuid not null`; `amount_cents bigint not null` CHECK 1 to 9,007,199,254,740,991; `method text collate "C" not null` CHECK the two codes; `recorded_at timestamptz not null` (the routine's `clock_timestamp()` after its last lock); `recorded_by uuid not null` (never returned). Composite foreign key `(invoice_id, tenant_id, store_id)` onto 034's `issued_invoice_scope_key`, RESTRICT both ways. UNIQUE `(invoice_id, tenant_id, store_id, attempt_id)`: the attempt is permanently unique within its tenant, store and invoice. UNIQUE `(payment_id, invoice_id, tenant_id, store_id)` as the reversal's reference target.
- **`invoice_payment_reversal`.** `payment_id uuid` primary key (at most one reversal per payment); `tenant_id`, `store_id`, `invoice_id uuid not null`; `reason_code text collate "C" not null` CHECK the six; `reversed_at timestamptz not null`; `reversed_by uuid not null` (never returned). Composite foreign key `(payment_id, invoice_id, tenant_id, store_id)` onto the payment's key, RESTRICT both ways.
- **No other column.** No stored balance, due or status, no back-dated or effective time, no reference, free text or card field, no tendered amount or change.
- **Guards.** Both tables: row security on, no policy, no runtime-role privilege. ENABLE ALWAYS BEFORE INSERT OR UPDATE OR DELETE row guards refuse every update and delete, and admit an insert only for its own scope (a payment of an issued invoice of the same tenant and store, recorded at or after the issue; a reversal of a payment of the same invoice, tenant and store, reversed at or after the recording). ENABLE ALWAYS BEFORE TRUNCATE guards refuse every truncate. Not covered, as for 033 to 035: the table owner disabling a trigger, replaced functions, DDL and a superuser.
- **Amounts.** For an issued invoice: due = `total_cents`; applied = the sum of unreversed `amount_cents`; remaining = due − applied, all in `numeric`. For a voided invoice: due, applied and remaining are 0 and the history stays. A read that finds applied above due, or an unreversed payment on a voided invoice, raises (503) rather than hide it.
- **`m7b_invoice_payment_record(p_session_key text, p_store_id uuid, p_invoice_id uuid, p_expected_tenant uuid, p_payment_id uuid, p_attempt_id uuid, p_amount_cents bigint, p_method text, p_correlation_id uuid)`.** plpgsql, VOLATILE, SECURITY DEFINER, search path `pg_catalog, pg_temp`, `row_security` off. In order: every argument (fixed-text `invalid_parameter_value`; the correlation id a version-4 uuid); READ COMMITTED (else 55000); the caller derived as 035's void derives it → `refused`; both levels unlocked (Invoices ≥ Approve, Customers ≥ View) → `refused`; the tenant precondition → `tenant_mismatch`; **the issued header FOR UPDATE** by id, derived tenant and path store → `not_found`; key 530030 SHARED and the levels re-read (editable roles) → `refused`; session expiry on `clock_timestamp()` after the last wait → `refused`; separate statements: the attempt on this invoice → `already_recorded`; a void record → `invalid_state`; active sum + amount > Total → `amount_exceeds_remaining`; then one payment insert, its verification read, one audit insert and its verification; `applied` with tenant, store, actor, membership, payment, invoice and the audit event id. Nothing is written before the last refusal (DA-36).
- **`m7b_invoice_payment_reverse(p_session_key text, p_store_id uuid, p_invoice_id uuid, p_payment_id uuid, p_expected_tenant uuid, p_expected_version bigint, p_reason_code text, p_correlation_id uuid)`.** The same attributes. In order: arguments (version 1 to 2^53 − 2; the six reasons); READ COMMITTED; caller; levels; tenant; **the path invoice's header FOR UPDATE** → `not_found`; the payment by (payment, invoice, tenant, store) → `not_found`; key 530030 and the levels re-read; on one `clock_timestamp()` after the last wait, the session's expiry and its `authenticated_at` (NULL, more than 5,000 ms ahead, or older than 600,000 ms → `refused`; exactly at the bound holds) — the routine's own check, as 035's step 6; separate statement: a reversal exists → `invalid_state`; a version other than 1 → `conflict`; one reversal insert and verification, one audit insert and verification; `applied` with tenant, store, actor, membership, version 2, payment and the audit event id (a payment's lifecycle version is 1 while active and 2 once reversed, derived, never stored).
- **`m7b_invoice_void_v2`.** 035's void, argument for argument and step for step, with one more separate statement after "already void" and before the version: an unreversed payment of this invoice → `payments_recorded`. It writes no audit record (as 035's). 036 revokes `tmpos_app`'s EXECUTE on 035's `m7b_invoice_void`, so A2 cannot be bypassed through the older entry point; 035's function stays in place for the rollback.
- **`m7b_invoice_payments_get(p_session_key text, p_expected_tenant uuid, p_expected_store uuid, p_invoice_id uuid, p_after_payment_id uuid, p_limit integer)`.** STABLE, SECURITY DEFINER, one snapshot, locks nothing. Its authority is 035's `m7b_issued_invoice_get_v2`'s, called inside it: `denied` and `not_found` are that read's words; `cursor_unknown` when `p_after_payment_id` is not a payment of this invoice; otherwise `payments` rows (one per payment on the page, each also carrying the header, amounts and word; one row with null payment columns for an empty page). `p_limit` 1 to 51.
- **The audit record each payment routine writes**, after its last refusal, in the same transaction: `request_id` = the correlation id; `occurred_at` default `now()` (the transaction start); the derived actor, `scope_type` `store`, tenant and store; `action_id` = the kind; `required_permission` = the permission; `decision` `allow`; `result_status` `succeeded`; `reason_code` `invoice_payment_recorded_<method>` or `invoice_payment_reversed_<reason>`; the fixed sentence "Payment recorded against an issued invoice. Method: <label>." or "Recorded payment reversed. Reason: <label>."; `source_of_truth` `invoice_payment_routine`; `evaluated_by` `m7b_invoice_payment_routine@v1`; `evidence_level` `durable_compliance_event`; metadata `{}`; `subject_invoice_payment_id` = the payment and no other subject. The routine raises unless exactly one row was inserted and reads it back, so a trigger that silently drops it rolls the money record back. No amount, customer, seller or line text is in the audit record; the payment row holds the amount.
- **Grants.** USAGE on `tmpos_invoice_payment` and EXECUTE on the four routines to `tmpos_app`; nothing else to any runtime role. The startup preflight requires exactly 001–036 and the grant list loses `tmpos_app`'s EXECUTE on 035's void and gains the USAGE line and the four EXECUTE lines.
- **Lock order.** Record and reverse: the prefix (fence → 016's hold → session and ledger → issuer key → membership and store FOR SHARE) → **the issued header FOR UPDATE** (035's step-4 slot) → for the reversal, the payment read → key 530030 SHARED → the payment or reversal reads → the insert (its foreign-key check takes FOR KEY SHARE on a header, or a payment row, this transaction already holds or that nothing locks exclusively) → the audit insert → (the runtime) completion → COMMIT. The void v2: 035's order, with plain payment reads after the header lock. Records, reversals and voids of one invoice serialize on its header; no new wait cycle is introduced. Deadlock freedom is argued per path, not proven.
- **Apply.** ACCESS EXCLUSIVE locks first, before any check, in the writers' order (`public.store`, the role tables, `tmpos_customer.customer`, the draft tables, 034's four issuing tables, 035's void table, `public.audit_event`); then READ COMMITTED; 035's objects exactly as 035 left them (the void routine and its two-entry ACL, the v2 get, the void table, the anchor); none of 036's objects; the runtime roles; and the applier's reach: EXECUTE on 016's hold and admission read and on 035's v2 get, ownership (or the owner's role) of every table the definers read, lock or insert into, `public.audit_event` and the void table included, none with forced row security, and INSERT on `public.audit_event`. Fixed-text refusals. No ledger clause (R-GATE-2).
- **The audit table's additions.** `subject_invoice_payment_id uuid` (nullable, no default, no FK; comment), its partial index, and the CHECK refusing the metadata keys `cvv`, `cvc`, `track1`, `track2` and `pinBlock` (002's CHECK is unchanged). The audit writer's table-wide INSERT (005) covers the column.
- **Anchor.** `m7b_invoice_payment_prerequisites()` names only 035's `m7b_invoice_void` and `m7b_issued_invoice_get_v2`, so 035's down fails closed (2BP01) while 036 is applied; the payment foreign key also blocks 034's drop. Roll 036 back first.
- **Down.** The same locks first; READ COMMITTED; it refuses, changing nothing, while any payment, any reversal, any audit record of the two payment actions, or any audit record with `subject_invoice_payment_id` set exists. Otherwise it drops 036's objects, the audit column, index and CHECK, and restores `tmpos_app`'s EXECUTE on 035's `m7b_invoice_void` exactly. It never deletes a row, so after the first payment it is one-way.
- **Operations.** Apply and rollback run with the tenant runtime stopped, as 034's and 035's do. The preflight refuses a mismatched start either way.

### 12.5 Kernel, store and composition

- **Contracts.** The record contract declares `paymentRefusals: 'record'` (a create): its command carries the three usual slots with `invalidState` sealed (the create-mode `invalid_state`), plus `alreadyRecorded` and `amountExceedsRemaining`. The void contract declares `paymentRefusals: 'void'`: its command adds `paymentsRecorded`. Every other command's slots are unchanged. The three words join the runtime's reserved, sealed 409 words.
- **Closed kind lists, extended by name.** `NOT_FOUND_CREATE_KINDS` gains `store.invoice_payment.record`; `PRECONDITION_UPDATE_KINDS` gains `store.invoice_payment.reverse` (`server/runtime/app.ts` and `server/persistence/postgresTransactionalStore.ts`, kept equal).
- **Routine-audited dispatch (I2).** The store holds a closed literal list of the two payment kinds. A mutator must declare `routineAudited: true` exactly when its kind is in that list, or the store refuses to build. For those kinds alone the store writes no audit record of its own; for every other kind it writes exactly as before. Nothing in a request, a plan, a change set or a routine's answer can change this. The store hands the routine-audited mutators the command's correlation id; the mutator accepts `applied` only with a canonical audit event id from the routine. The audit writer refuses the two payment actions on its TypeScript path.
- **Mutators.** One call each into the routines, with the revalidated store context and session key. The record checks that `applied` names this transaction's tenant, store, actor and grant, the command's payment id and the path invoice. The reversal checks the same and version 2, then re-judges the sign-in deadline on the database clock (the void's rule). `tenant_mismatch` → the rolled-back precondition; `not_found` → the rolled-back 404; every sealed word → its completion alone. Anything else is a mismatch (503).
- **Composition.** Five new routes (36 in the tenant entry; store templates 15 → 20; idempotent store commands 5 → 7); the payments read over one new port, `invoicePayments`, with a readiness probe asking 036's read last; the void's mutator calls `m7b_invoice_void_v2`.
- **Redaction.** `AUDIT_FORBIDDEN_FIELDS` and the safe log's key fragments gain CVV/CVC, track1/2 and PIN block; the outbox's forbidden names, which already refuse `cvv`, `cvc` and `pin`, gain track1/2 and the PIN block. Each with tests ([05](./05-canonical-data-ownership-and-api-db-contracts.md) line 38).

### 12.6 Shop (P1 minimum)

The void client decodes the sealed `409 payments_recorded` as its own result, and the void flow shows, exactly: "This invoice has payments recorded, so it can't be voided. If a payment was recorded by mistake, reverse that payment first." Layout, every other refusal, session invalidation and held-attempt recovery are unchanged. No recording or reversal control, client method or read is added (P2). `src/components/POS.tsx` and every demo POS state are untouched.

### 12.7 Attempts, retries and failures

- Same key, identical bytes → the stored answer replayed under the chain's current checks; same key, other bytes or another target → 422.
- A new key reusing an attempt on the same invoice → sealed `already_recorded`, also after that payment's reversal and after the 24-hour key retention. The same attempt id on another invoice is a different attempt.
- The attempt rule stops one attempt being recorded twice. It does not verify funds and does not detect two separately asserted receipts.
- Timeout, connection loss or an ambiguous COMMIT → 503, outcome unknown; cleanup is not proof of rollback; no automatic resend. The server binds a key to the principal, not the session; P2's held attempt must become unsendable on a sign-out or session replacement, as the void's does.

### 12.8 Planned evidence (every row PLANNED — NOT RUN at adoption; the delivered status is §12.10)

| ID | What it proves | Layers |
|---|---|---|
| PAY-01 | Full, partial and mixed-method arithmetic, Total 0, the 2^53 − 1 bound, input refusals | routine, HTTP, unit |
| PAY-02 | Tenant and store isolation; edited grants; session and standing changes; the reversal's sign-in after a wait | routine, HTTP |
| PAY-03 | Scoped foreign keys, append-only guards (normal and replica mode), permanent attempt uniqueness, one reversal per payment | routine |
| PAY-04 | Replay, 422, the sealed 409s and their precedence, an attempt retried after a reversal and after key expiry | HTTP, unit |
| PAY-05 | Concurrent recordings never exceed the Total; record, reverse and void races obey the header lock | routine, HTTP |
| PAY-06 | REPEATABLE READ and SERIALIZABLE are refused | routine |
| PAY-07 | Direct calls enforce scope, amount, lifecycle, attempt and the reversal's sign-in, and write exactly one audit record | routine |
| PAY-08 | A failed or silently dropped audit insert commits no money record; one HTTP success writes one audit record and its completion atomically | routine, HTTP |
| PAY-09 | No other kind can skip its audit; their audit behaviour is unchanged | unit, HTTP |
| PAY-10 | No outbox row is written | routine, HTTP |
| PAY-11 | The read is one consistent snapshot, keeps history, pages correctly and exposes no staff id | routine, HTTP |
| PAY-12 | The void's `payments_recorded`, its old routine revoked, the shop decoder and message; the issued wire contracts unchanged | routine, HTTP, client, section |
| PAY-13 | 036's prerequisites, exact grants, anchor, empty rollback restoring 035's grant, and the data-preserving down refusal | migration, preflight |
| PAY-14 | The card-data keys are refused by the audit CHECK and writer, and redacted by the safe log and outbox guards | unit, routine |
| PAY-15 | Every existing suite, pin and CI step still passes | all |

Evidence rules: disposable PostgreSQL and the real tenant entry; races use separate connections and deterministic lock barriers; refusals may keep their established lease and audit bookkeeping but never the refused money effect; failed, skipped and resource-limited runs are recorded, never rewritten by a later green run.

### 12.9 Carried, and not claimed

- **Register (P1 must amend, all stay OPEN).** DA-118 (widened by the two payment routines in audited form, and by the replacement void unaudited), DA-119 (direct level sets change who can record and reverse), DA-132 (the payments read joins the direct-read class), DA-183 and DA-184 (§3 notes), DA-186 (payments and amounts due decided; refunds, credit notes and the rest open) and DA-187 (D-PAY-9's interim default). DA-36, DA-114, DA-93 and DA-94 are unchanged.
- **Not claimed.** Shop recording or reversal controls (P2); M7b completion; PCI validation or any SAQ; any jurisdiction's rules; statutory retention; event delivery; deadlock freedom; a managed migration; deployment; production readiness. All 37 gates stay OPEN.

### 12.10 Delivered evidence (M7B-PAYMENTS-P1, 2026-11-07)

**Gate basis (local runs; failures kept, none rewritten by a later pass).**
- Unit runner: 180 of 180 suites in the final round. Round 1 failed 179 of 180 (`server/runtime/app.test.ts` test 6, "readiness answers 503": standalone re-runs 1 failed and 3 passed, 2 failures in 6 runs, attributed to a pre-existing timing race in unchanged code; not repaired); its re-run passed 180 of 180.
- Database chain, final run (run 3, 18:52:40–19:06:08Z, one shared cluster): 47 runs (`test:db` and the 46 suites of the CI order), 945 of 945 passed, none failed, cancelled or skipped; IPR 21 of 21, IPH 8 of 8. Run 1 of that round was interrupted at 18:42:52 when its supervising session returned early (mid `transactionalStore`; `test:db` 75 of 75 had completed), and run 2 was stopped at about 18:47 by a process restart (17 suites completed, each exit 0). Neither is a test result.
- Typecheck (the proxy): 0 errors. `test:frontend` 1,202 of 1,202 and `build:check` PASS are round-1 results, not re-run in the final round. The typecheck and the unit runner were not re-run after the last IPH edit: the typecheck proxy lists the file but does not type-check JavaScript (`allowJs` without `checkJs`), the unit runner does not run it, and `node --check` passed after the edit.
- Not run locally: the shop browser file `tests/browser/shopRoleLevels.browser.test.mjs` (SKIPPED in round 1, resource-limited: 1,787 MB available, round 1's reading, against 2,500 MB, and no Java); the Firestore emulator (SKIPPED in round 1, no Java); docker (daemon unavailable), semgrep (crashes locally) and gitleaks (not installed), SKIPPED as tools unavailable in both rounds; npm audit (SKIPPED in round 1, no network). The final round did not attempt the browser file (no Java), the emulator or the dependency audit. `security:gates` passed structurally only (manifest OK, 7 itemized findings); its scanner reconciliation was not run.
- These are local results on the stage's working tree, not on commit B. Migration 036's committed bytes equal the tested ones (up `93fe0ba9…`, down `131e112e…`). The commit-B witness is CI run 42406847370: attempt 1 FAILED in the appsec job only (the Semgrep manifest reconciliation, on six synthetic card-data keys in two new test inputs; Gitleaks skipped; quality 72 of 72 steps passed); the owner's decision on a scoped manifest exception is pending — see [08](./08-production-gate-and-risk-register.md)'s stage record.

Named assertions are test IDs in `tests/db/invoicePaymentRoutine.integration.test.mjs` (IPR), `tests/db/invoicePaymentHttp.integration.test.mjs` (IPH), `server/runtime/invoicePayments.test.ts` (IPU, 10 tests; their own count is not recorded apart from the runner's 180 of 180), `server/persistence/postgresInvoicePayments.test.ts` (IPP, 6 of 6), `src/tenant/invoiceIssuingClient.test.ts` (IIC) and `src/tenant/ServerIssuedInvoices.test.tsx` (SII, 177 of 177 after SII-152).

| ID | Criterion | Named assertions | Layer | Status |
|---|---|---|---|---|
| PAY-01 | Full, partial and mixed-method arithmetic, Total 0, the 2^53 − 1 bound, input refusals | IPR-06; IPH-01, IPH-02 (input refusals), IPH-07 (Total 0); IPU-02, IPU-03, IPU-09 | routine, HTTP, unit | P1 DONE |
| PAY-02 | Tenant and store isolation; edited grants; session and standing changes; the reversal's sign-in after a wait | IPR-05, IPR-09; IPR-19 (a level narrowing waiting on key 530030); IPR-20 (a session expiring during the header wait); IPR-21 (an expired session, a suspended account and a suspended membership, by direct call); IPH-02, IPH-05 | routine, HTTP | P1 DONE, partly: 036's own membership re-read has no isolating case (§12.11) |
| PAY-03 | Scoped foreign keys, append-only guards (normal and replica mode), permanent attempt uniqueness, one reversal per payment | IPR-08; IPR-15 (normal and replica mode); IPH-03 | routine, HTTP | P1 DONE |
| PAY-04 | Replay, 422, the sealed 409s and their precedence, an attempt retried after a reversal and after key expiry | IPR-07 (`already_recorded` before `invalid_state` before `amount_exceeds_remaining`; an attempt after its reversal); IPH-01, IPH-02, IPH-03 (an attempt after its reversal over HTTP); IPU-05, IPU-09, IPU-10 | routine, HTTP, unit | P1 DONE, except "after key expiry": no named case, PLANNED — NOT RUN |
| PAY-05 | Concurrent recordings never exceed the Total; record, reverse and void races obey the header lock | IPR-14 (two records behind a header holder; a record and a void in both orders); IPH-07 (two records, and a record against a void, on a `pg_stat_activity` barrier) | routine, HTTP | P1 DONE for records and voids; a reversal racing a record or a void: no named case, PLANNED — NOT RUN |
| PAY-06 | REPEATABLE READ and SERIALIZABLE are refused | IPR-13 | routine | P1 DONE |
| PAY-07 | Direct calls enforce scope, amount, lifecycle, attempt and the reversal's sign-in, and write exactly one audit record | IPR-05, IPR-06, IPR-08, IPR-11, IPR-21 | routine | P1 DONE |
| PAY-08 | A failed or silently dropped audit insert commits no money record; one HTTP success writes one audit record and its completion atomically | IPR-11; IPR-12 (an audit trigger returning NULL rolls the payment back); IPH-01, IPH-03; `server/persistence/postgresTransactionalStore.test.ts:1537` | routine, HTTP, unit | P1 DONE |
| PAY-09 | No other kind can skip its audit; their audit behaviour is unchanged | `server/persistence/postgresTransactionalStore.test.ts:1511`, `:1537`, `:1580`; S3-W-PAY-1 (`server/platform-identity/auditEventWriter.test.ts:879`); IPH-04 | unit, HTTP | P1 DONE |
| PAY-10 | No outbox row is written | IPR-06; IPH-01 | routine, HTTP | P1 DONE |
| PAY-11 | The read is one consistent snapshot, keeps history, pages correctly and exposes no staff id | IPR-16 (with the two `data_corrupted` raises); IPH-01; IPH-06 (no staff id); IPU-07, IPU-08, IPP-05, IPP-06 | routine, HTTP, unit | P1 DONE |
| PAY-12 | The void's `payments_recorded`, its old routine revoked, the shop decoder and message; the issued wire contracts unchanged | IPR-10; IPH-04; IIC-32 (`src/tenant/invoiceIssuingClient.test.ts:1066`); SII-73, SII-74, SII-90, SII-152 (`src/tenant/ServerIssuedInvoices.test.tsx:2578`, `:2609`, `:3293`, `:3316`) | routine, HTTP, client, section | P1 DONE locally; the shop browser file SKIPPED locally (resource-limited, no Java) and runs only in CI, where it passed (run 42406847370 attempt 1, job quality; that run failed in appsec, see [08](./08-production-gate-and-risk-register.md)) |
| PAY-13 | 036's prerequisites, exact grants, anchor, empty rollback restoring 035's grant, and the data-preserving down refusal | IPR-01 to IPR-04, IPR-18; `server/persistence/postgresStartupPreflight.test.ts` 30 of 30; `tests/quality/migration-files-contract.test.mjs` 14 of 14 | migration, preflight | P1 DONE on PostgreSQL 16; postcondition (g) under PostgreSQL 18 not exercised (§12.11) |
| PAY-14 | The card-data keys are refused by the audit CHECK and writer, and redacted by the safe log and outbox guards | IPR-17; S3-W-PAY-2 (`server/platform-identity/auditEventWriter.test.ts:893`); SLG-01 (`server/safe-log.test.ts:7`); `server/runtime/outbox.test.ts:30` | routine, unit | P1 DONE |
| PAY-15 | Every existing suite, pin and CI step still passes | Unit runner 180 of 180; database chain 945 of 945; typecheck proxy 0 errors; full CI: NOT met — run 42406847370 attempt 1 failed in appsec | all | NOT MET, pending the owner's decision on a narrowly scoped manifest exception for the six synthetic negative-test inputs. Local: as the gate basis above; docker, semgrep, gitleaks, the emulator and npm audit not run locally; CI: quality 72 of 72 steps passed; appsec failed the Semgrep manifest reconciliation and gitleaks was skipped |

Other payment unit tests: `server/runtime/routes.test.ts:1109`, `:1137`; `server/runtime/commandTransaction.test.ts:1049`, `:1065`, `:1092`, `:1108`; `server/persistence/postgresTransactionalStore.test.ts:1560`, `:1605`; `server/platform-identity/m5CanonicalPermissions.test.ts:944`, `:978`; IPP-01 to IPP-06; M7TK-06 (`productionTransactions.test.ts:1715`).

### 12.11 Evidence limits, residuals and deviations (2026-11-07)

**Evidence limits (recorded, not repaired).**
- **PAY-02.** 036's own membership re-read (036 up :659–671) has no isolating case. IPR-21's suspended-account and suspended-membership refusals come from 016's admission; no mutation of 036 alone reaches them. The routine takes 016's standing hold before any wait, so a suspension queues behind it; the re-read is defence in depth under that hold.
- **PAY-04.** No named case retries an attempt after the 24-hour key retention. The routine's attempt check does not read the key.
- **PAY-05.** No named case races a reversal against a record or a void; IPR-19 covers a reversal waiting on key 530030 only.
- **PAY-11.** A partial page cannot re-derive `appliedCents`. The decoder requires equality only when the whole history is on one page (`server/runtime/invoicePayments.ts:415`); judged inherent, not a defect.
- **PAY-13.** Postcondition (g) now compares only the constraint kinds `c`, `p`, `u`, `f`, `x` and `t` (036 up :1929, review fix M036-01). On PostgreSQL 16 that filter drops nothing; the PostgreSQL 18 behaviour it guards against is not exercised (no PostgreSQL 18 was available).

**Residuals accepted by review (carried, not repaired).**
1. MEDIUM, accepted as a residual: IPH's lever waits 1.5 s against a lock wait of about 1.4 s (0.7 of the production 2 s command deadline, which the test cannot set). A slow runner fails loudly, never vacuously. Recorded as a CI flake risk to watch.
2. MEDIUM, accepted: the PAY-02 limit above (IPR-21 does not isolate 036's membership re-read).
3. LOW: IPR-20 depends on wall-clock session lifetimes (up to three attempts of up to 12 s; each discarded attempt asserts the exact refusal).
4. LOW: IPR-20's 12 s lifetime against a role `lock_timeout`. No role sets `lock_timeout` or `statement_timeout` in the migrations or the test harness.
5. LOW: IPR-19 has no in-test control that narrows before the reversal; the review fix's recorded red runs supply it.
6. LOW, found by the documentation review: 036's audit CHECK `audit_event_metadata_no_card_data_keys_chk` (036 up :482–484) refuses exactly the top-level keys `cvv`, `cvc`, `track1`, `track2` and `pinBlock` (`?|`, case-sensitive), as §12.4 names them; a differently cased or nested key is not refused by the CHECK. The audit writer's sanitizer strips card-data keys before its validator and the safe log redacts them case-insensitively; the record and reversal routines write their own audit rows with metadata `{}` (036 up :823–833, :1192–1202).

The full pre-commit review confirmed six findings: M036-01 (LOW, the postcondition filter above), F1 (MEDIUM, IPR-19), F2 (MEDIUM, IPR-20 and IPR-21), F3 (LOW, IPR-16's `data_corrupted` cases), F4 (LOW, SII-152) and F5 (LOW, IPH-07's barrier and the record-against-void pair). F1 to F5 each have a red run with the fixed behaviour removed and a green run with it restored; F5's red run changed the record routine inside the HTTP suite's own disposable database, not migration 036's file. M036-01 has no red run: on PostgreSQL 16 the added filter excludes no constraint row of the two tables, and no PostgreSQL 18 was available. The review of those fixes applied one more change: IPH-07 settles its in-flight requests when a barrier check fails.

**Deviations of the delivered code from §12's text (§12's text is kept above; this is what shipped).**
1. **Target refusals come before the key (§12.3, "Targets").** §12.3 says a target that is not a canonical lowercase uuid is the 400 "after the key". The runtime reads `{id}`, and for the reversal `{paymentId}` too, from the path at the point where it reads the void's target, and refuses a non-canonical id with 400 `invalid_request` before any key is taken (`server/runtime/app.ts:995–1021`). For the record, the planner's later checks (the outbox's aggregate-id shape, a payment id on that route, a bad store or new id) remain after the key (`server/runtime/invoicePayments.ts:159–160`).
2. **The membership row is not locked (§12.4, "Lock order").** §12.4 lists "membership and store FOR SHARE". The record routine re-reads the membership row without a row lock, because 016's standing hold already holds it, and takes only the store row FOR SHARE (036 up :658–683). The reversal and the void v2 take the store row FOR SHARE at :1044 and :1406.
3. **Additions the text does not name (no clause contradicted).** A routine-audited command that declares an event is refused as unavailable (`server/persistence/postgresTransactionalStore.ts:707–708`). The tenant and platform roots refuse startup with `command_mutator_unavailable` when a contract's and its mutator's `paymentRefusals` differ (`server/composition/transactionKernel.ts:313–317`, `server/composition/productionTransactions.ts:204–208`; a review fix).

No other difference from §12.1–§12.7 was found when each clause was checked against commit B's source.

**What is enforced, and where.** Only the HTTP chain enforces the idempotency key and its completion record, CSRF, session binding, the per-client limit, the trusted store context, the 403 `step_up_required` before the body, the body's shape and size, and the mutators' identity checks and the reversal's sign-in re-check on the database clock. The record and reverse routines enforce, for any caller of `tmpos_app` with a live session key (an HTTP request or a direct call): their arguments and a version-4 correlation id, READ COMMITTED, the session, mint ledger, issuer digest and expiry, 016's standing hold, admission, one store grant, an active membership, the store's write status, the levels before and after the header wait, the expiry after the last wait, the reversal's 10-minute sign-in, the attempt, void and amount checks, the reversal's state and version, and exactly one audit record, read back. A direct call therefore still skips idempotency, CSRF, the rate limit and the chain's step-up (DA-118, in audited form for the two payment routines). The routine's audit record proves neither the actor (an issuer-key holder can mint a session: DA-93, DA-94) nor the correlation id. `m7b_invoice_void_v2` writes no audit record on any path; over HTTP the store writes the void's audit, so a direct call to it is unaudited. The payments read joins the direct-read class (DA-132).

**Failures, interruptions and restarts (kept distinct; none erased).**
- Commit A's CI run 42317230025: attempt 1 FAILED (the quality job's SRL browser step, 89 of 89 failed in its hook: "Chromium did not answer on the pipe: Browser.getVersion: timed out"; every other step passed); attempt 2, a re-run of the failed job, passed. Attempt 1 stays on record.
- IVH-01 answered 503 once where 403 was expected (with ECONNRESET, a load average of about 15 and the `oom_kill` counter at 3); the next run passed 15 of 15.
- Earlier development runs that failed: IPR's first run (3 failures: a defect in 036's read, whose first page raised, fixed in 036; and two in the test); ripple failures (M7CE-02, ICA-10, M6R-11, IVH-13) and route-count pins (IIH-12, the role-levels pin, IVH-13); `managed-m005-launcher` 130 of 131; a shared-service simulation whose first snapshots were invalid; a unit run under Node 24 at 57 of 180 (121 reporter, 2 environment); a typecheck killed out of memory (exit 137); IPH-07 at 7 of 8, and a run with 7 failures against a mid-edit 036 checksum; the migration-files contract under Node 20 (`ERR_UNKNOWN_FILE_EXTENSION`). Later runs passed; they do not rewrite these.
- Intended red runs, the mutation proofs of the review fixes and of the startup parity check, failed as designed; they are not failures of the tree.
- Host and session: the VM was down 01:11–09:12 and about 10:49–15:30; process restarts at about 16:00, 16:25 and 18:47 stopped runs and reviews, which were resumed or re-run. The `oom_kill` counter reached 20 by 19:05, when an orphaned helper process of 2.7 GB was observed and not terminated. The wait loop of the final chain run was killed at 19:32 (exit 144) after that run had finished; that is not a test result.

**Carried, and not claimed.** DA-36, DA-114, DA-93 and DA-94 are unchanged, and so is the qualification that the audit record proves neither the actor nor the correlation id. §12.9's register rows stay OPEN, none repaired. Nothing is deployed and no managed database is touched. Not claimed: the shop's recording and reversal controls (P2, not started); M7b completion; any event, outbox row, worker or delivery promise; any provider integration, refund, credit note, receipt, cash drawer or customer balance; PCI validation; deadlock freedom; deployment; production readiness. All 37 production gates stay OPEN.
