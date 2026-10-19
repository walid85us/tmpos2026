# 12 — Issuing a saved store invoice draft: decision pack and conditional contract

**Status: ADOPTED AS AMENDED; server foundation IMPLEMENTED in code (M7B-INVOICES-ISSUE-P1, [ADR-50](./10-architecture-decision-records.md)); the shop's settings, issue, recovery and issued reads IMPLEMENTED in code (M7B-INVOICES-ISSUE-P2, §10.12); nothing deployed.** The owner's stage instruction of 2026-10-16 accepted D-ISS-2, D-ISS-3 and D-ISS-6, accepted D-ISS-1, D-ISS-5 and D-ISS-7 with amendments, and changed D-ISS-4 to a per-store tax mode. The adopted contract is §10, at the end of this document; it governs wherever it differs from §4–§5. §1 to §9 below are kept as the proposal's history: their alternatives are not adopted, and the launch facts (F-2, F-5, each merchant's real values) stay open. The "no stage may implement it" and "nothing is decided" statements below describe the pack before acceptance.

**Original status: PROPOSED / UNADOPTED.** This is a proposal for the owner to decide (stage M7B-INVOICES-ISSUE-D1-P1, documentation only). Nothing in it is implemented, and it adopts no new policy. Each statement is labelled:
- **FIXED** quotes policy already adopted, with a citation to where it is set.
- **EXISTING** describes current code.
- **OPEN** names an item the register already records as undecided.
- **MISSING** names a factual input that exists nowhere in the repository and that only the owner (or the owner's advisers) can supply.
- **PROPOSED** marks every new rule.

**"Owner" in this pack.** "The owner" is the product owner who decides §9. The `store_owner` role, the shop account that owns a tenant's stores, is always written as "the store owner (`store_owner`)".

Until the owner records the decisions in §9 as accepted, issuing stays deferred, exactly as [08](./08-production-gate-and-risk-register.md) DA-186 and [09](./09-roadmap-m0-m9.md) (M7b, "Owner decisions remaining") say, and no stage may implement it. Pushing this document is not approval, and neither is a green CI run. Accepting the decisions adopts them but does not deliver the feature. Implementation also needs the MISSING facts in §2.5, or an explicit owner choice of the branch that does without them.

If the owner accepts the decisions, they become the owner's decision for the issuing route, recorded the way each tenant and store route's has been since the owner's repository decision D1 ([09](./09-roadmap-m0-m9.md): M7A-CUSTOMERS-P1 and P3, M7B-INVOICES-P1, P2 and DISCARD-P1). The decided form would then be written up as an ADR (the next free number is ADR-50) in [10](./10-architecture-decision-records.md) as the slice is delivered (§8). This pack adds no ADR: nothing in it is decided.

**Source references.** `path:line` references are to commit `fba801b` and drift as files change. Migration paths are relative to `server/platform-identity/migrations/`.

## 1. The proposed first operation, in plain language

**What a user could do (PROPOSED).** A shop operator with issuing authority opens one saved draft, reviews it in a confirmation that shows the customer, every line, the tax and the total, and presses **Issue invoice**. The server turns that draft into an issued invoice only if the draft, the store's issuing settings and the customer are still at the versions the operator reviewed; otherwise nothing is issued and the operator reviews again. The issued invoice carries the next number in the store's series and the date and time of issue. It keeps a snapshot of the seller details, the customer name, the lines and the amounts. The draft leaves the drafts list for good, and the issued invoice appears in a separate list of issued invoices, where anyone allowed to read issued invoices can open it.

**What "issued" would promise (PROPOSED).** That this store produced this numbered invoice document, with exactly these contents, at this time, and that nobody can change those contents afterwards through the product. It would **not** promise:
- an amount due, a receivable, a payment obligation, a ledger entry or a paid / unpaid / overdue status;
- a stock movement, a shipment or a fulfilment;
- that the document meets any jurisdiction's legal invoice requirements: that needs the owner's legal review (§2.5, D-ISS-7);
- that the customer has received it: the product sends nothing.

**What becomes immutable.** The issued invoice's number, seller snapshot, customer snapshot, lines, amounts, tax, total, currency, source draft and issue time. The source draft becomes terminal (`issued`), as a discarded draft is terminal (`discarded`).

**What stays outside the slice.** Voiding, credit notes and any other correction; payment recording and payment providers; amounts due and receivables; discounts, shipping, surcharges and fees; per-line tax categories and exemptions; fractional quantities, negative lines and catalog prices; delivery by email or print templates; and legacy browser invoices or customers (DA-176). §6 lists each item with whether it blocks implementation, launch or only a later capability.

**Why this slice next.** These are reasons for a recommendation, not product research; no usage data is claimed.
- Saved, editable and discardable drafts exist ([05](./05-canonical-data-ownership-and-api-db-contracts.md) §2; ADR-47, ADR-48, ADR-49). A draft that can never become an invoice is not yet useful to a shop.
- Issuing is the smallest step that turns a draft into a business record. Payments, receivables, voids and credit notes all hang off an issued invoice, so it has to come first.
- The money representation, store scope, stored Invoices levels, command transaction, idempotency and audit machinery already exist, so the new work is concentrated in numbering, snapshots, tax and the lifecycle change.

**The shapes compared.**

| Shape | What it is | Consequence |
|---|---|---|
| **A. Issue a draft into a separate issued invoice (recommended)** | A new issued-invoice record, created from one open draft in one transaction; the draft becomes terminal `issued`. | Drafts stay drafts and issued invoices stay immutable documents with their own reads. It needs a forward migration (§5 I) and new reads. |
| B. Mark the draft itself as issued | The draft row gains a number, a snapshot and a terminal `issued` status. | Fewer tables, but the draft table becomes a financial record. Draft reads, the draft's edit history and the issued document then share one row and one lifecycle. Snapshot fields that drafts never need would sit on every draft. |
| C. Issue without a draft, or build the full lifecycle at once | A direct "create invoice" operation, or issuing together with voiding, payments and amounts due. | It discards the draft work already built, or makes the first slice much larger and blocks it on payment and receivable policy (G-PCI, DA-186). |

## 2. Capability map (source-grounded)

### 2.1 Adopted rules that constrain issuing (FIXED)

| Rule | Source |
|---|---|
| A draft is owned by a real store in a tenant. Store authority is exactly one active store-scope grant at the path's store, with no tenant-to-store inheritance; `{storeId}` only selects among the actor's own grants. | ADR-47 d1 ([10](./10-architecture-decision-records.md)); [11](./11-m7b-invoice-draft-discard-decision-pack.md) §3, item 1 |
| Customers are tenant-owned. A draft names a customer of its store's tenant by id only, and a name is resolved through the Customers-authorized read, "never copied into the draft". | [05](./05-canonical-data-ownership-and-api-db-contracts.md) §2 (draft detail); ADR-47 |
| Money is USD in integer cents. A save has 1–50 lines, whole quantities ≥ 1, unit prices ≥ 0 cents with `-0` refused, every product and the sum computed in BigInt (never a float) and ≤ 2^53 − 1, and a body ≤ 64 KiB. The server derives the id, status, currency, version, creation time and subtotal. | ADR-46, ADR-47 d4; [05](./05-canonical-data-ownership-and-api-db-contracts.md) §2 (save contract) |
| "Draft prices are user-entered draft information: they set no catalog price, amount due, payment obligation or ledger entry." | [05](./05-canonical-data-ownership-and-api-db-contracts.md) §2; DA-186 |
| The draft lifecycle is `draft` → `discarded` (terminal). A draft in any other state than `draft` is refused with `invalid_state`: "that means `discarded`, and later any new state, such as an issued one". | ADR-49 d1; D-DIS-1 ([11](./11-m7b-invoice-draft-discard-decision-pack.md) §4) |
| `expectedVersion` is required on a state change; a stale one is the sealed 409 `write_conflict`; state is decided before version. A rollback never resets a version. | ADR-48 d9, ADR-49 d5 |
| The stored levels are ordered `none < view < create < edit < manage < approve < full`; `approve` satisfies `manage`, never the reverse. Defaults: `store_owner` Full (never stored), `manager` Full, `technician` View, `sales_staff` Create. A browser-only custom role has no server authority. Read-only caps at View. | ADR-19, ADR-46, ADR-47 d2, ADR-49 d2 |
| Every new invoice operation decides on the stored Invoices level on the server, and adds its own HTTP witness. | [11](./11-m7b-invoice-draft-discard-decision-pack.md) §3, item 2; DA-183, DA-184 |
| Money approvals are explicit editable boolean grants; no level or ordering grants one. | ADR-19 |
| One transaction commits the authorized mutation, the lease-checked idempotency completion, the audit record and zero or more outbox events, or none of them; delivery is at least once and exactly-once is not claimed. An event is emitted "where cross-domain or provider effects occur". | ADR-17; [05](./05-canonical-data-ownership-and-api-db-contracts.md) per-domain contract |
| Past its retention, "the key is no longer the same key". Idempotency gives no permanent uniqueness. | ADR-17 amendment |
| A lost COMMIT answer is a 503 with the lease kept; only an explicit retry with the same key and bytes resolves it, under current authority. The shop sends a mutation only on an explicit action. | ADR-47 d8; [11](./11-m7b-invoice-draft-discard-decision-pack.md) §3, item 3 |
| Server drafts never enter the browser's invoices, and the shop shows no amount due, number, issued status or payment action for them. (The proposal narrows this for issued invoices only: §5 G.) | ADR-47 d9 |
| `audit_event` is immutable for every role, and hard purge is "a governed retention job" (§4). The per-domain contract requires a retention/deletion rule and a sensitive-data classification (§2). | [05](./05-canonical-data-ownership-and-api-db-contracts.md) §2 and §4 |
| Money paths need transaction, idempotency and rollback tests. | [07](./07-quality-and-test-strategy.md) §4 |
| Migration 033's terminal rules stand: a discarded draft admits no update and no delete, and its lines never change; 033's down refuses while any draft is discarded and never deletes one. Migrations 001–033 stay byte-identical. | ADR-49; [11](./11-m7b-invoice-draft-discard-decision-pack.md) §3 |
| The role levels are written through a tenant route permission decided by the owner rule (`edit_role_levels`); a store or platform grant never satisfies it, and its route requires a recent sign-in. The tenant guard admits exactly that one owner-only permission. | ADR-35 d3; `server/runtime/roleLevelUpdate.ts:160-166`; `server/platform-identity/m5CanonicalPermissions.ts:197-212` |
| No universal-compliance claim: final privacy policy and jurisdictional obligations require owner and legal review. The privacy contract also requires correcting inaccurate personal data with audit, and deleting or anonymizing it where legally permitted; where deletion is barred (for example by financial-record retention), the restriction reason is recorded. The tenant is the data controller for its store, customer and employee data. | [05](./05-canonical-data-ownership-and-api-db-contracts.md) §6; G-PRIVACY |

### 2.2 Current implementation facts (EXISTING)

| Area | Fact | Source and evidence |
|---|---|---|
| Draft routes | Eight store-templated tenant-session routes: save, list, reopen, create eligibility, edit, edit eligibility, discard, discard eligibility. Every one has `recentAuth: 'none'`. | `server/runtime/invoiceDrafts.ts:5-19`; route sets closed in `server/runtime/routes.ts:437-453` and `server/entry/tenantEntry.ts:108-130` |
| Request order | Host, request limiter, route match, body headers (400/413/415), Origin and pre-session CSRF, session with admission re-read, session CSRF, authorizer, store-target check, body read, `Idempotency-Key`, plan, one commit. | `server/runtime/app.ts:3-100`; IDDH-19 |
| Commit order | Lease fence → revalidator → one definer-routine call → sealed or rolled-back answer → one audit row → outbox events → sealed completion → COMMIT. A refusal in the revalidator is a 503 that looks like an outage. | `server/persistence/postgresTransactionalStore.ts:649-761` |
| Second decision | Each draft routine re-derives the caller from the session key. The edit and the discard lock the header `FOR UPDATE` and then hold the Invoices level under advisory key 530030 SHARED; the save locks no header and holds the Invoices and Customers levels under that key before inserting. Level writers take the key EXCLUSIVE; `store_owner` takes no key (Full by catalog). | `030…up.sql:25-31`; `032…up.sql:868`; `033…up.sql:28-62`; IDD-07, IDD-11, IDDH-04 |
| Kernel limits | A command changes one aggregate, in create or update mode; the only typed sealed refusal on a create is `customer_not_found`; the audit table has typed subject columns only for drafts, customers and tenants. A sealed refusal COMMITS with its completion, so a mutator must decide every refusal before it writes anything (DA-36). | `server/runtime/commandTransaction.ts`; `server/persistence/postgresTransactionalStore.ts:614-627` |
| Idempotency | Lease 60 s, retention 24 h from acquisition; after that the same key is a new operation. Only 200/201/409/422 answers are replayed, and a replay body is capped at 16 KiB. A replay re-checks the chain's current authorization before the key is looked up. | `server/runtime/idempotency.ts:89-122`; IDDH-09, IDDH-17, IEH-17 |
| Lost COMMIT | Answered 503 with the lease kept; a same-key retry replays if it landed, or re-plans under current authority after the lease expires. | `server/runtime/commandTransaction.ts:83-93`; IDH-10, IEH-10, IDDH-12, IDDH-13 |
| Draft schema | `bigint` integer cents; `currency = 'USD'` CHECK; `line_count` 1–50; `subtotal_cents` 0–2^53 − 1; lines with `quantity` 1–2^53 − 1, `unit_price_cents` ≥ 0, `line_total_cents = quantity × unit_price_cents`; `created_at` and `created_by` only; no tax, discount, number, sequence, issue date or issuer column. | `028…up.sql:340-397`; `029…up.sql:252-254` |
| Lifecycle guard | `status in ('draft','discarded')`; `trg_invoice_draft_terminal` (ENABLE ALWAYS) refuses every transition except open → `discarded` at version + 1 with nothing else changed, and makes any status other than `draft` terminal; the line trigger refuses line writes under a non-`draft` header; reads serve `status = 'draft'` only. | `033…up.sql:359-368, 379-507, 997, 1156`; IDD-05, IDD-09, IDD-10 |
| Rollback | 033's down refuses while any draft is not `draft`; the anchor routine blocks the downs of 028, 029, 030 and 032 while 033 is applied. 033's down also requires the CHECK, the terminal trigger's name and binding, and the triggers on the draft tables to be exactly as 033 left them. | `033…down.sql:79-98, 119-128, 176-203`; `033…up.sql:1185-1201`; IDD-13 |
| Startup | The ledger must be exactly 001–033 with pinned checksums, and the runtime role's grants must equal an approved list exactly. A runtime and a database at different migration heads refuse each other. | `server/persistence/postgresStartupPreflight.ts:11-185`; M7TE-10, M6PF-02 |
| Permissions | Four store route permissions: `view_invoice_drafts` (View), `create_invoice_drafts` (Create + Customers View), `edit_invoice_drafts` (Edit), `discard_invoice_drafts` (Manage). The load-time guard admits only non-sensitive View/Create/Edit keys plus exactly that one Manage key, so a store permission cannot require a recent sign-in today; the revalidator itself would accept a sensitive store permission with a deadline. The owner rule exists for tenant routes only. | `server/platform-identity/m5CanonicalPermissions.ts:239-274` (guard at `:263-266`); `server/composition/tenantAuthorization.ts:341-345` |
| Level writes | The owner's role-level write accepts all seven levels; the shop's Invoices picker offers `none`, `view`, `create`, `edit` and `full` ("Full Access") only. | `server/runtime/roleLevelUpdate.ts:86`; `src/context/accessConfig.ts:31` |
| Seller data | `public.tenant` has `display_name` (admin-edited) and a nullable `legal_name` that no command writes; `public.store` has a nullable `store_name`. Nothing else describes a seller. | `002…up.sql:101-139`; `009…up.sql:42-46`; DA-29 |
| Customer data | Tenant-owned: id, name, optional phone and email, creation time, version; edited in place; no address, no history, and a customer edit emits no event. | `017…`, `023…`, `024…up.sql`; `server/runtime/customerUpdate.ts:44-47` |
| Events | Save and edit emit `invoice_draft.created` / `invoice_draft.updated` v1; discard emits none. No outbox consumer or publisher is composed. | `server/runtime/invoiceDrafts.ts:233-249`; `server/persistence/postgresTransactionalStore.ts:6-9` |
| Shop | Save attempts are held in a per-user in-memory store that survives closing the dialog (but not a reload); edit and discard attempts live only while their dialog is open. "Check again" re-sends the same key and bytes within 23 hours. Actions are offered only on the server's eligibility answers. Nothing is kept in browser storage. | `src/tenant/ServerInvoiceDrafts.tsx:45-131`; save: SID-44, SID-51, SDB-02; edit: SID-84, SDB-13; discard: SID-114..147, SDB-20 |
| Accessibility patterns | `DialogFrame` (dialog / alertdialog, inert background, focus in and back, Tab wrap, Escape on the top dialog only), focus never left on `<body>`, `role="status"` and `role="alert"` regions, `aria-describedby` on disabled or warning controls. | `src/tenant/ServerInvoiceDrafts.tsx:137-157, 526-645`; SID-117, SID-139, SDB-06, SDB-18 |

### 2.3 Open product decisions (OPEN)

- **DA-186**: issuing and official numbering, tax, discounts, shipping, payment, fractional quantities, negative lines and catalog price authority are undecided. This pack proposes issuing, numbering and tax; it leaves the rest open.
- **DA-187**: draft retention and privacy are undecided, and nothing removes a draft, a line or an audit record that names one. Issued invoices would add personal data under the same open decision.
- **DA-118** and **DA-119** (pre-deployment blockers): a runtime-role holder with a live key can call the draft routines directly, and with a live store-owner key change Invoices levels directly, with no audit, idempotency or outbox record. An issuing routine would join DA-118's class, and an issuing-settings routine DA-119's.
- **DA-208** and **DA-212**: whether an unknown outcome should outlive its editor or confirmation. D-ISS-6 decides only issuing's own tracking and leaves both open for the edit and the discard.
- **DA-213** and **G-BACKUP**: a data-only restore into a schema at 033 meets the ENABLE ALWAYS terminal guards. Issued invoices would add the same restore concern.
- **DA-176**, **DA-188**, **DA-189**, **DA-203**: legacy mapping, store provisioning, store-only customer picking and the customer-existence disclosure on edits all stay open.
- **DA-60**, **G-PERF**, **G-OBSERVE**: availability under load and observability stay open. Per-store number allocation (D-ISS-3) adds a serialization point that must be measured there.

### 2.4 Where the proposed rules are

Every new rule is in §4 (the owner decisions) and §5 (the conditional technical contract). Nothing in §2 is a proposal.

### 2.5 Missing factual inputs (MISSING)

None of these exists in the repository, and this pack does not invent them. Each row says what it blocks and which branch of §4 works without it.

| # | Missing input | What it blocks | Branch available without it |
|---|---|---|---|
| **F-1** | **The legal issuer for each store**: the legal name, the postal address and any tax registration identifier of the business that issues invoices from that store. Whether every store in a tenant issues under one legal entity or some stores under their own; several legal entities in one tenant also need owner and legal confirmation against the single-controller rule ([05](./05-canonical-data-ownership-and-api-db-contracts.md) §6). | The seller snapshot (D-ISS-5). The only server-side seller data is an unwritten `tenant.legal_name` and a nullable `store.store_name`. | Two different needs. **Before implementation:** the owner confirms which issuer fields the settings must hold (the field list, and whether one entity or several per tenant). **Before live issuing:** each store's real values, entered by the store owner as configuration, not code. |
| **F-2** | **The jurisdiction(s) the stores operate in**, and whether they impose invoice-content, numbering or retention rules. | Whether D-ISS-3's continuous per-store series, D-ISS-4's tax branch and D-ISS-5's field list are sufficient. | The recommended branches are generic; legal review before launch (D-ISS-7) checks them against the jurisdiction. |
| **F-3** | **Whether sales tax applies and how**: one rate per store, several rates, tax-exclusive or tax-inclusive prices, exempt customers or lines. | D-ISS-4's calculation. | Branch T1 (one store-owner-entered exclusive rate per store) or T0 (no tax line, only on the owner's explicit statement that this is correct for the stores concerned). |
| **F-4** | **The store's time zone**, if the document must show a local calendar date. | A local "invoice date", and any number series that resets by date. | Show the issue time in UTC with an explicit "UTC" label, and the viewer's local rendering labelled with its zone; no date-based reset. |
| **F-5** | **How long issued invoices must be kept**, and how that interacts with privacy requests. | The retention rule before launch (D-ISS-7; DA-187). | The first implementation needs only "nothing deletes an issued invoice"; the period is a pre-launch decision. |

### 2.6 Not policy: the browser-only invoices

The legacy browser invoice screen keeps invoices in memory only. It computes tax as `(subtotal - discount) * 0.08` in binary floating point (`src/components/Invoices.tsx:192-197`), while the POS uses `0.0825` (`src/components/POS.tsx:25`). It numbers invoices `INV-<year>-<count + 1>` from the in-memory list (`src/components/Invoices.tsx:226`), which is not unique after a delete, and it carries `Unpaid` / `Paid` / `Overdue` statuses, balances and due dates. **None of this is policy, and nothing here inherits from it**: not the rates, not the number format, not the statuses and not the float arithmetic. The earlier proposed draft shape is likewise "not adopted as policy" (ADR-46 (d); ADR-47 Context).

## 3. Fixed constraints for any issuing design

1. **Store scope** is adopted and is not re-asked: an issued invoice belongs to the store of its draft, and authority is the actor's own grant at that store (§2.1).
2. **The stored Invoices level decides on the server**, inside the transaction, with the route's own HTTP witness (DA-183, DA-184).
3. **Only an explicit user action sends a mutation**; an unknown outcome is never re-sent under a new key automatically (§2.1).
4. **Amounts are exact integer cents in USD** and stay within 2^53 − 1; no float arithmetic anywhere.
5. **Migration 033's discard rules stay intact**: discarded drafts stay terminal; 001–033 stay byte-identical; no history is deleted by a rollback. (Today only the table owner can read a discarded draft; a view of discarded drafts is still OPEN, ADR-49.)
6. **Route-level atomicity is not database enforcement**: until DA-118 closes, a direct routine call by a runtime-role holder can bypass the route's audit record.
7. **No receivable, payment or legal-validity claim** is made by issuing until the owner decides one (§1).

## 4. Owner decisions

These are the choices the first issuing slice needs, grouped as seven decisions. Each recommendation is **PROPOSED / UNADOPTED**. D-ISS-1 to D-ISS-7 number this pack's decisions; they are not the repository's D2, D3 or D4, nor D-DIS-n.

| # | Decision | Recommended (PROPOSED) | Main alternative | Blocks |
|---|---|---|---|---|
| **D-ISS-1** | Meaning, lifecycle and issuer | Issue one open draft at its reviewed version into a separate, immutable, store-numbered issued invoice; the draft becomes terminal `issued`. No amount due, payment or legal-validity claim. The legal issuer per store comes from store-owner-entered issuing settings. Corrections never edit an issued invoice; a void is the next slice and a launch prerequisite. | Mark the draft itself issued (§1 shape B), or issue with an amount due from the start. | Implementation; launch (void, legal review) |
| **D-ISS-2** | Authority | A new store permission `issue_invoices` at Invoices **Approve** or above, with Customers View on the same role; refused when read-only; no recent sign-in in this slice. A separate `view_issued_invoices` at Invoices View with Customers View reads issued invoices. Issuing settings are written through a new tenant-scope permission under the owner rule, with a recent sign-in. | `issue_invoices` at Manage (the discard's threshold), or an explicit boolean grant. | Implementation |
| **D-ISS-3** | Numbering | One continuous series of positive integers per store, starting at 1, allocated inside the issuing transaction from a per-store counter row; unique per store; no prefix, no date and no reset in this slice. No gaps from the product's own failures, retries or concurrency, but no legal gaplessness claim. | A tenant-wide series, or a database sequence (which gaps on rollback). | Implementation (format: launch, with F-2) |
| **D-ISS-4** | Amounts, tax, discounts and totals | The draft's own amounts at the reviewed version; **T1**: one store-owner-entered tax rate per store in thousandths of a percent, tax-exclusive, applied once to the subtotal and rounded half-up to the cent; total = subtotal + tax ≤ 2^53 − 1. No discounts or charges. | **T0**: no tax line, only if the owner states that is correct; or per-line rates. | Implementation (needs F-3) |
| **D-ISS-5** | Immutable contents and privacy | Snapshot the seller settings, the customer id and name (no phone or email), the lines, the amounts, the tax rate and amount, the number, the issue time and the source draft and version. The live customer link stays an id. Reading issued invoices is its own permission. | Copy the customer's email and phone too, or keep only a live customer link. | Implementation |
| **D-ISS-6** | Concurrency, replay and uncertain answers | The request binds the reviewed draft, settings and customer versions; state before version; one issued invoice per draft enforced by a permanent database uniqueness rule, not by idempotency. A different key on an issued draft is the sealed 409 `invalid_state`. The shop holds an unresolved attempt per user until session end and offers "Check again" within 23 h and "Find issued invoice" (a read by source draft); after a reload, the issued list settles it, under current read authority. | Dialog-only tracking, as for the discard. | Implementation |
| **D-ISS-7** | Retention, correction and launch prerequisites | Nothing deletes an issued invoice or its audit record; 034's rollback refuses once any issuing settings exist or anything is issued. The first slice has no correction; **void** (keeps the invoice and number, records a reason) *(resolved by [ADR-51](./10-architecture-decision-records.md), M7B-INVOICES-VOID-P1: "records a reason" means a required reason code from a closed list of six; no free text)* is the next slice and must exist before live issuing. Retention period, the privacy duties of [05](./05-canonical-data-ownership-and-api-db-contracts.md) §6, legal review and DA-118/DA-119 are launch prerequisites. | Ship voids and credit notes in the first slice. | Implementation (no-delete rule, one-way rollback); launch (void, retention, privacy, legal review, DA-118/119) |

### D-ISS-1 — Meaning, lifecycle and ownership

**Recommended wording (PROPOSED).** "Issuing turns one saved open draft, at the version the operator reviewed, into a separate issued invoice of the same store. The issued invoice records the store's next invoice number, the issue time, and a snapshot of the seller details, the customer name, the lines and the amounts. Nothing in it can be changed afterwards through the product. The draft becomes `issued`, which is terminal like `discarded`. Issuing records what the store invoiced; in this slice it creates no amount due, receivable, payment, ledger entry, stock movement or shipment, and the product shows no paid or unpaid status. The issuer is the legal business named in the store's issuing settings, which only the store owner (`store_owner`) enters. An issued invoice is never edited: a later void marks it void with a reason and keeps it and its number, and credit notes come with payments."

**Lifecycle (PROPOSED).**

| Before | Action | After |
|---|---|---|
| draft `draft` | edit (existing) | draft `draft`, version + 1 |
| draft `draft` | discard (existing, D-DIS-1) | draft `discarded` (terminal) |
| draft `draft` | **issue** | draft `issued` (terminal), version + 1, plus issued invoice `issued` with number n |
| draft `discarded` or `issued` | edit, discard or issue | sealed 409 `invalid_state` (D-DIS-1's rule); the draft list and reopen already exclude it (the reopen is the missing draft's 404) |
| issued invoice `issued` | void (next slice, not in this pack) | issued invoice `void`, number kept |

**Does issuing create a financial obligation?** Not in this slice. It fixes an invoice document. The total on it is the amount the store invoiced. Whether that total becomes an amount due, and how payment, part payment and balance are tracked, is the payment slice's decision (DA-186, G-PCI). The shop must therefore not label an issued invoice "Unpaid". ADR-47 d9 (no number, issued status or amount due shown for server drafts) would be narrowed only so far as the issued-invoice list, its detail and the issue confirmation need; the drafts section itself still shows no number or issued status.

**Issuer and numbering identity.** Store scope is adopted. What this decision adds is the **legal issuer**: the business whose name, address and tax identifier appear on the document. Because number series and issuing are per store, and a multi-store tenant may trade under more than one legal entity, the recommendation keeps the issuer details in **per-store issuing settings** entered by the store owner (`store_owner`). A tenant with one legal entity enters the same details for each store. The alternative, one issuer per tenant, is simpler, but cannot represent stores that trade under different entities without a later migration. Several legal entities inside one tenant also meet the adopted rule that the tenant is the data controller ([05](./05-canonical-data-ownership-and-api-db-contracts.md) §6); that combination needs owner and legal confirmation (F-1).

**Correcting an issued invoice.** Never by editing it. The recommended path is a **void** in the next slice: the issued invoice is marked `void` with a reason, its number stays used and visible, and the operator issues a new invoice from a new draft. Credit notes and partial corrections belong with payments, because they adjust an amount due.

**Usability of the first slice.** Without a void, a mistakenly issued invoice cannot be corrected in the product. That is acceptable for implementation and testing on disposable data, and **not acceptable for live use**. D-ISS-7 therefore makes the void slice a launch prerequisite, not an optional later feature.

**Constraints and dependencies.** ADR-47 store scope; D-DIS-1's `invalid_state` rule for every non-open state; 033's terminal discard rules; DA-186.

**What it unlocks.** Numbering, snapshots, the issued-invoice reads, and later voids, payments and amounts due.

**Alternative and its consequence.** Shape B (issue the draft row itself) avoids a second table but mixes the draft's edit history and the financial document, and puts snapshot columns on every draft. Issuing with an amount due at once forces the payment and receivable policy (DA-186, G-PCI) into this slice.

**Blocks:** implementation (the meaning and lifecycle); launch (the void slice, legal review).

### D-ISS-2 — Authority

**Recommended wording (PROPOSED).**
- "A new store permission, `issue_invoices`, at Invoices **Approve** or above on the store grant's role, with **Customers View** on the same role. It covers any open draft in the trusted store, with no creator rule. It is refused when the actor, tenant or store is read-only. It needs no recent sign-in in this slice."
- "A new store permission, `view_issued_invoices`, at Invoices View or above with Customers View on the same role, reads the issued-invoice list and detail."
- "The store's issuing settings (§5 F) are written through a new **tenant-scope** permission, `edit_issuing_settings`, decided by the same owner rule as `edit_role_levels` (ADR-35): only the store owner (`store_owner`) on a tenant grant satisfies it, a store or platform grant never does, and the route requires a recent sign-in. The store is a selector checked against the trusted tenant. The settings are read, with their version, by anyone who holds `issue_invoices` at that store."
- **This is a new rule.** No store-scope owner rule exists, and the store guard refuses Full thresholds and sensitive keys, so the write is a tenant route. The tenant guard admits exactly one owner-only permission today (`edit_role_levels`), so it must widen to a second key; the owner rule itself is reused unchanged. A wrong tax rate or legal name would be printed on every later invoice, which is why the write takes the same step-up as the role levels.

**Effect under the actual server model (defaults; the owner can change the three non-owner levels):**

| Role | Invoices default | Customers default | Issue | Read issued | Edit issuing settings (tenant grant, owner rule) |
|---|---|---|---|---|---|
| `store_owner` | Full (fixed) | Full (fixed) | yes, with a store grant at that store | yes, with a store grant | yes, on its tenant grant, with a recent sign-in |
| `manager` | Full | Full | yes | yes | no |
| `technician` | View | View | no | yes | no |
| `sales_staff` | Create | Create | no | yes | no |
| browser-only custom role | — | — | no (no server authority) | no | no |
| any role, actor, tenant or store that is read-only | capped at View | capped at View | no | yes, if View is held | no |

- **Picker versus server.** The shop's Invoices picker offers only None, View, Create, Edit and Full Access, so with the picker the owner lets a role issue only by choosing Full Access. The server's level write accepts all seven levels, so a level stored as Manage lets a role discard but not issue, and Approve lets it do both. These shop labels are local hints; the server's stored level and its HTTP answer are what count.
- **Why not inherit.** Not Create or Edit: issuing finalizes an external document with a number, which is more than preparing a draft, so a role that edits drafts should not automatically issue them. Not the discard's Manage: discard is internal clean-up, while issuing creates a lasting financial document, so the recommendation puts issuing one level higher. The separation runs one way only: a role at Manage can discard but not issue, while a role that can issue (Approve or Full) can always also discard, because Approve satisfies Manage. Not a boolean money grant: ADR-19 reserves those for actions that move money (refunds, returns, billing), and issuing in this slice moves none. **The Customers View corequisite** is not inherited from the save either: it is needed because the issued invoice shows the customer's name, and the issuer sees it in the confirmation. **No role-name shortcut** is used anywhere: authority comes only from the stored level on the store grant's role (the owner's Full is a fixed level, not a name check), plus the owner rule for the tenant-scope settings write.
- **Recent sign-in.** Recommended: none in this slice, with a confirmation that names the draft and its total. Requiring one would need a store step-up path that does not exist: the load-time guard refuses a sensitive store permission today (`m5CanonicalPermissions.ts:263-266`; the revalidator would accept one with a deadline), and the shop has no store re-authentication flow for it.

**Constraints and dependencies.** ADR-19's ordering and money-grant rule; ADR-47 d2; [11](./11-m7b-invoice-draft-discard-decision-pack.md) §3, item 2; the load-time guard must widen to admit exactly one Approve key with a Customers View corequisite (it already admits a View corequisite on another key); a second owner-only tenant permission is a second catalog and guard change; DA-119 (Invoices levels can still be changed directly without audit) stays a pre-deployment blocker.

**HTTP evidence required (FIXED by [11](./11-m7b-invoice-draft-discard-decision-pack.md) §3, item 2).** The issue route, its eligibility read and the issued-invoice reads each need their own real-HTTP witness over stored levels, revocation and cross-store isolation (§7).

**What it unlocks.** The route and its eligibility read; the shop's Issue button offered only on the server's `allowed`.

**Alternative and its consequence.** At Manage, with today's picker the effect is the same (only Full Access issues), but a role stored at Manage could then both discard and issue, and no stored level could allow discarding without issuing. A boolean grant would let the owner give issuing to one role independently of its level, but adds a new editable grant, a shop control and an audit path for it.

**Blocks:** implementation.

### D-ISS-3 — Numbering

**Recommended wording (PROPOSED).** "Each store has one continuous series of invoice numbers: the positive integers from 1. Issuing takes the next number inside the same transaction that writes the issued invoice, from a per-store counter row it locks. A number is unique within its store and is never reused, reassigned or edited. The internal identity of an issued invoice is a separate UUID. The number has no prefix, date or yearly reset in this slice. It is at most 2^53 − 1, so it is exact as a JSON number; the counter refuses to go past it."

**Allocation and concurrency.**
- The counter row is created at 0 in the same transaction as the store's first issuing settings, so it always exists before an issue; a store without one is `issuing_not_configured`. It is locked `FOR UPDATE` in the issuing transaction, after the draft header and the authority keys (§5 B lock order). Two issues at the same store, from two server instances, serialize on that row; issues at different stores never wait for each other.
- Because the counter moves in the same transaction as the issued invoice, a transaction that rolls back (a fault, a timeout, a lost connection) returns its number. A sealed refusal is different: it commits with its idempotency completion (DA-36). So the routine decides every refusal (state, version, settings, customer, amounts) **before** it touches the counter, and a refused issue consumes no number for that reason, not because of a rollback.
- A lost acknowledgement leaves exactly two states: the transaction committed (the invoice exists with its number) or it rolled back (no invoice, no number used). A number is never assigned to an outcome that is later abandoned. A same-key retry replays the committed number; a different-key retry on the same draft is the sealed `invalid_state`, and the operator finds the number by reading the issued invoice for that draft (D-ISS-6).
- **Gaps.** The product's own operations are designed to leave no gaps: failures, refusals, retries and races do not skip a number, and the tests in §7 would assert it. **No legal gaplessness is promised**: the table owner, a data restore, or an out-of-band database change can still skip, and a database sequence or an idempotency record is not what provides this property. A void (next slice) keeps its number, so it creates no gap.
- **Throughput cost.** Issuing serializes per store. That is unmeasured and belongs to G-PERF.
- **Issue time.** The database clock read with `clock_timestamp()` after the counter lock is held, in UTC. Not the transaction's start time (`now()`, which `created_at` uses): a transaction that started earlier but waited for the counter would otherwise carry a later number with an earlier time. With the lock-then-clock order, number order and time order agree within a store. A local calendar date needs the store's time zone (F-4).

**Conditional options by jurisdiction (F-2).**
- If the stores' jurisdiction requires a prefix, a per-year series or a registered range, the counter is keyed by (store, series), and the series rule becomes part of the issuing settings. This needs the requirement stated and, for a date-based series, the store's time zone.
- If a single numbering across all stores of a tenant is required, the counter becomes per tenant, and every issue in the tenant serializes on it.
- If gaps are acceptable and throughput matters more, a sequence could replace the counter row. Not recommended without that statement, because a sequence gaps on every rollback.

**Constraints and dependencies.** [05](./05-canonical-data-ownership-and-api-db-contracts.md) §4's M1 contract that natural keys such as "invoice number per tenant/store" are unique within the tenant (a design contract, not an owner decision); G-DBCONSTRAINTS; idempotency gives no permanent uniqueness.

**What it unlocks.** A document reference customers and staff can quote; later voids and payments refer to it.

**Alternative and its consequence.** A tenant-wide series makes numbers unique across stores, but every store's issuing waits on one row. A sequence never blocks, but leaves gaps that an auditor or a jurisdiction may object to.

**Blocks:** implementation (the allocation model); launch (format confirmation against F-2).

### D-ISS-4 — Amounts, tax, discounts and totals

**Adopted starting point (FIXED).** USD; integer cents in `bigint`; 1–50 lines; whole quantities ≥ 1; unit prices ≥ 0 cents with `-0` refused; line total = quantity × unit price, exactly; subtotal = the sum of line totals; every value ≤ 2^53 − 1; BigInt arithmetic, never float. Draft prices are user-entered and "set no catalog price, amount due, payment obligation or ledger entry".

**What issuing adds.** A draft today carries only a subtotal. An issued invoice would be the first record that states a tax and a total to a customer, so these rules are new financial promises, not draft editing.

**Recommended wording (PROPOSED), branch T1.**
- "**Line prices**: the issued lines are exactly the draft's lines at the reviewed version, with their user-entered prices. There is no catalog price."
- "**Tax**: each store has one tax rate, entered by the store owner (`store_owner`) in the store's issuing settings in thousandths of a percent, from 0 to 100,000 (0% to 100%). Prices are tax-exclusive. Tax is computed once, on the subtotal, as an integer: `tax = floor((subtotal × rate + 50,000) / 100,000)` cents, which rounds a half cent up. The rate and the tax amount are stored in the snapshot."
- "**Total**: `total = subtotal + tax`, which must be at most 2^53 − 1 cents. A draft whose total would exceed that is refused, and nothing is written."
- "**Not configured**: if the store's issuing settings have not been entered, issuing is refused and nothing is written (under T1 the settings cannot be saved without a rate). A rate of 0 is allowed only when the store owner has entered 0; there is no default rate."
- "**Discounts and charges**: none in this slice. No discount, shipping, surcharge or fee line, and no negative line. A discounted price is entered as the line's unit price."

**Worked examples (branch T1).** Amounts in cents; rate in thousandths of a percent.

| Lines | Subtotal | Rate | Exact tax (subtotal × rate / 100,000) | Tax, rounded half-up | Total |
|---|---|---|---|---|---|
| 2 × $50.00 | 10,000 | 8,250 (8.250%) | 825 | 825 ($8.25) | 10,825 ($108.25) |
| 1 × $19.99 | 1,999 | 8,875 (8.875%) | 177.41125 | 177 ($1.77) | 2,176 ($21.76) |
| 1 × $0.10 | 10 | 5,000 (5.000%) | 0.5 (exactly half a cent) | 1 ($0.01) | 11 ($0.11) |
| 3 × $2.00 | 600 | 0 (entered as 0) | 0 | 0 | 600 ($6.00) |
| 1 × $0.00 | 0 | 8,250 (8.250%) | 0 | 0 | 0 |
| quantity 1, price 2^53 − 1 | 9,007,199,254,740,991 | 1 (0.001%) | 90,071,992,547.40991 | 90,071,992,547 | 9,007,289,326,733,538, above 2^53 − 1: **refused** |

The rounded column is `floor((subtotal × rate + 50,000) / 100,000)`, which equals the exact tax rounded half-up to the cent. It is computed in exact integer arithmetic, never in floating point: BigInt division in the runtime, and in the database `div(subtotal::numeric * rate + 50000, 100000)`, the exact integer quotient. Not `floor(a / b)` on `numeric`: PostgreSQL rounds a `numeric` quotient to a scale it chooses. On a disposable PostgreSQL 16 this is wrong inside the allowed range: a subtotal of 1,000,000,000,050,001 cents at a rate of 99,999 gives `floor` 999,990,000,050,001 where the exact tax is 999,990,000,050,000, while `div` was exact in every case tried.

**Branch T0 (no tax line).** If the owner accepts T0 in §9, the product is built without tax: the issuing settings have no tax field, every issued invoice records its tax mode as "none", shows no tax line, has a total equal to its subtotal, and states "No tax calculated". It is one product-wide branch, not a per-store setting. This is acceptable **only** on the owner's explicit statement that it is correct for the stores concerned; zero tax is not assumed to be universally valid, and undefined tax is never silently omitted.

**Later branch T2.** Per-line tax categories, several rates, tax-inclusive prices and exemptions need F-3 and a richer settings model; they are deferred.

**Implementation blocker.** Without F-3, the owner must choose T1 or T0 explicitly before implementation. Everything else in this pack is independent of that choice.

**Constraints and dependencies.** ADR-47 d4; DA-186; [07](./07-quality-and-test-strategy.md) §4 (money paths need transaction, idempotency and rollback tests).

**What it unlocks.** A complete document total; later amounts due and payments.

**Alternative and its consequence.** Per-line rounding makes each line's tax visible, but the sum of rounded line taxes can differ from the tax on the subtotal by up to one cent per line. Tax-inclusive prices change what the operator types into the draft and need the owner's statement of local practice.

**Blocks:** implementation (T1 or T0 must be chosen).

### D-ISS-5 — Immutable document contents and privacy

**Recommended wording (PROPOSED).** "An issued invoice keeps a snapshot of exactly the fields below, taken in the issuing transaction. The customer stays linked by id, and the snapshot keeps the customer's name as it was at issue. The customer's phone and email are not copied. Reading issued invoices needs `view_issued_invoices`, which is separate from issuing."

| Field | Trusted source | Why it is needed |
|---|---|---|
| Invoice id (UUID) | Server-generated | Internal identity, independent of the number. |
| Tenant and store | The revalidated trusted scope | Store ownership (ADR-47). |
| Invoice number | The store's counter, in the transaction (D-ISS-3) | The document reference. |
| Issue time (UTC) | `clock_timestamp()` after the counter lock (D-ISS-3) | When the document was issued. |
| Issuing actor | The trusted actor's internal user id | Accountability; also in the audit record. Not returned by the issued-invoice reads and not shown in the shop (the draft reads return no creator either). |
| Source draft id and version | The locked draft header | Ties the document to what was reviewed; enforces one issue per draft. |
| Seller legal name, postal address, tax registration identifier if entered | The store's issuing settings at the reviewed settings version (§5 F) | The issuer block (F-1). |
| Store name | `public.store.store_name`, read in the transaction | Which store issued it. |
| Customer id | The draft | The live link, for later payments and lookups. |
| Customer name at issue | The customer row at the reviewed customer version, read `FOR SHARE` in the transaction | What the document says, even if the customer is renamed later. |
| Lines: position, description, quantity, unit price, line total | The draft's lines at the reviewed version | The document body. |
| Currency (USD), subtotal, tax mode, tax rate and tax (T1 only), total | Computed in the transaction (D-ISS-4) | The amounts; under T0 the mode is "none" and there is no rate or tax field. |

**When the customer or the seller changes later.** The snapshot does not change: the issued invoice keeps the name and the seller details it was issued with. The live customer id still lets a reader with Customers View see the current customer. A changed issuing setting affects only invoices issued after the change.

**Privacy.**
- The snapshot holds personal data: the customer name and free-text line descriptions. **In the first implementation** nothing erases or corrects it, under DA-187's open decision. That cannot be the final rule: [05](./05-canonical-data-ownership-and-api-db-contracts.md) §6 requires correcting inaccurate personal data with audit, deleting or anonymizing it where legally permitted, and recording the restriction reason where deletion is barred (for example by financial-record retention). Before launch the owner must decide how an issued snapshot meets those duties (for example a recorded restriction, or anonymizing the customer name after the retention period), and the snapshot's design must leave room for it. It must also be classified in the per-domain contract ([05](./05-canonical-data-ownership-and-api-db-contracts.md) §2).
- Phone and email are not copied by default: nothing in this slice uses them, and copying them would put contact data, which already has its own open read and retention questions (DA-153, DA-155), into a record that is never edited.
- No address is copied because none exists (customer addresses are MISSING); if a jurisdiction requires a customer address, that is a new customer field and a new decision.
- **Readers are decided independently of issuers**: `view_issued_invoices` at Invoices View with Customers View. A role with Invoices View but no Customers View sees no issued invoice, because the snapshot names the customer.

**Constraints and dependencies.** ADR-47 (the draft keeps a customer id only); [05](./05-canonical-data-ownership-and-api-db-contracts.md) §6; DA-187; G-PRIVACY; DA-153; DA-155; F-1; F-2.

**What it unlocks.** A self-contained document that later voids, payments and printing can rely on.

**Alternative and its consequence.** Copying email and phone makes later delivery simpler but adds contact data to a permanent record now. Keeping only a live link makes the document change when the customer is renamed, which defeats immutability.

**Blocks:** implementation.

### D-ISS-6 — Concurrency, replay and uncertain answers

**Recommended wording (PROPOSED).**
- "Issuing names the versions the operator reviewed: the draft's `expectedVersion`, the store's `expectedSettingsVersion` and the customer's `expectedCustomerVersion`. State is decided before version: a draft that is not open is the sealed 409 `invalid_state`; any of the three versions that has moved is the sealed 409 `write_conflict`, and the operator reviews again. A request can therefore never issue a tax, a total, a seller block or a customer name the operator did not see."
- "A draft can produce at most one issued invoice, ever. This is enforced by a database uniqueness rule on the issued invoice's source draft and by the draft's terminal `issued` state, not by the idempotency record."
- "The same key with the same body replays the stored answer after the chain's current authorization. A different key on an already issued draft is the sealed 409 `invalid_state`, never a second invoice. Nothing is ever re-sent under a new key automatically."
- "The shop holds an unresolved issuing attempt per user, in memory, until the session ends, the user changes or the user signs out, even after the confirmation closes. 'Check again' re-sends the same key and bytes within 23 hours. 'Find issued invoice' reads the issued invoice for that draft, which settles the outcome without sending anything. After a reload the in-memory attempt is gone; the operator then settles it from the lists, where an issued draft has left the drafts list and its invoice appears in the issued list. Every read needs the reader's current `view_issued_invoices`."

**Outcomes.**

| Race or retry | Outcome |
|---|---|
| Settings or customer changed after the confirmation opened | Sealed `write_conflict` before any number is taken; nothing issued. |
| Issue versus edit (same draft) | Serialized on the header lock. If the issue wins, the edit gets `invalid_state`; if the edit wins, the issue gets `write_conflict` and the operator reviews the new version. |
| Issue versus discard | Serialized on the header lock. Whichever commits first wins; the other gets `invalid_state`. |
| Two issues, two instances, different keys | One succeeds with number n; the other gets the sealed `invalid_state`. Exactly one issued invoice, one audit record, one number. |
| Two issues at the same store, different drafts | Serialized on the store's counter row; numbers n and n + 1, in commit order. |
| Same key, same body, after success | The stored answer is replayed, with the same invoice id and number, after the chain's current authorization (a 403 if authority was lowered, a 401 if the session is gone). |
| Same key, other body or draft | 422 `idempotency_key_reused`. |
| Lost COMMIT acknowledgement | 503, lease kept. "Check again" replays the result if it committed; if it did not, it re-plans once the lease expires, under current authority and the same reviewed versions, so a changed draft, settings or customer answers `write_conflict`. Or "Find issued invoice" reads the result. |
| Different key after a lost acknowledgement that committed | `invalid_state`; the operator uses "Find issued invoice". |
| Any retry after the 24-hour key retention | The key is a new operation; the draft is already `issued`, so the answer is `invalid_state`, never a second invoice. |

**A confirmed refusal versus an unknown outcome.** A 409, 422, 403 or 401 with a body is a definite answer; the shop says what it means and offers no automatic retry. A 503, a lost answer or a closed connection is unknown; the shop says "Not confirmed yet: the server may have issued this invoice", never "issued" and never "failed", until a replay or a read settles it.

**Recovery lifetime.** The recommendation is deliberately wider than the discard's dialog-only tracking (D-DIS-5). An unknown discard cannot duplicate anything, but an unknown issue is a numbered external document, and the operator must be able to find out whether it exists. The attempt survives closing the confirmation; after the 23-hour window, or after a reload ends the in-memory attempt, the issued list still settles the outcome, without any resubmission. Both need the operator's current read authority: an operator who has lost it needs someone who still holds it. DA-208 and DA-212 stay open for the edit and the discard; this decision settles neither.

**Constraints and dependencies.** ADR-17; ADR-47 d8; ADR-49 d5 and d7; D-DIS-1; [11](./11-m7b-invoice-draft-discard-decision-pack.md) §3, items 3 and 8; idempotency retention 24 h and replay cap 16 KiB (the answer carries ids and the number, not the snapshot).

**What it unlocks.** Safe retries and recoverable unknown outcomes for a non-repeatable financial action.

**Alternative and its consequence.** Dialog-only tracking (as for the discard) is simpler, but an operator who closes the dialog during an unknown outcome could then only look through the issued list by hand, which the recommendation leaves only for the reload case. A durable server-side hold store is more robust across devices, but is a new capability with its own retention question.

**Blocks:** implementation.

### D-ISS-7 — Retention, correction and launch prerequisites

**Recommended wording (PROPOSED).**
- "In the first implementation, nothing in the product deletes, redacts or ages out an issued invoice, its lines, its snapshot or the audit record of its issue. Migration 034's rollback refuses while anything has been issued or configured, and never deletes either; after the first settings write it is one-way in practice, and recovery is a forward migration."
- "The first slice offers no correction. **Void** (mark an issued invoice void with a reason, keeping it and its number) is the next slice and must be delivered before any live issuing."
- "Before live issuing: a retention period and privacy behaviour for issued invoices and their audit records, including how an issued snapshot meets [05](./05-canonical-data-ownership-and-api-db-contracts.md) §6's correction, anonymization and restriction-reason duties (DA-187, F-5); a legal review of the document's contents, numbering and tax against the stores' jurisdiction (F-2); DA-118 and DA-119 closed; and the applicable gates."

| Item | Needed for the first implementation | Needed before launch | Later capability |
|---|---|---|---|
| Nothing deletes issued invoices | Yes | — | — |
| Retention period, erasure and correction behaviour (DA-187, F-5, [05](./05-canonical-data-ownership-and-api-db-contracts.md) §6) | No | **Yes** | Governed purge job |
| Void | No | **Yes** | — |
| Credit notes, partial corrections | No | No | With payments |
| Legal review of content, numbering and tax (F-2) | No | **Yes** | — |
| DA-118, DA-119 closed | No | **Yes** (pre-deployment blockers) | — |
| G-BACKUP restore rehearsal including issued invoices (DA-213) | No | **Yes** | — |

**Implications of keeping discarded drafts and issued records.** Discarded drafts already stay forever (D-DIS-1), and 033's rollback is one-way in practice. Issued invoices add a second permanent record set, a counter per store and a new terminal draft state. Every later migration must preserve them: no rollback may delete or rewrite them, a restore rehearsal must load them with their guards enabled (the DA-213 pattern), and a change to their shape is a forward migration with old readers kept compatible (§5 I).

**What it unlocks.** Implementation on disposable data with a clear no-delete rule and rollback behaviour, the void slice's scope, and a concrete pre-launch checklist for issuing.

**Next product slice.** Void, then payment recording, which needs the owner's amount-due and payment policy (DA-186, G-PCI).

**Constraints and dependencies.** DA-187; G-PRIVACY; G-BACKUP; DA-213; DA-118; DA-119; [05](./05-canonical-data-ownership-and-api-db-contracts.md) §4 (soft-delete and governed purge); ADR-49's rollback rule.

**Alternative and its consequence.** Delivering void and credit notes in the first slice makes it usable live sooner, but roughly doubles its size and pulls in the amount-due policy for credit notes.

**Blocks:** implementation (the no-delete rule and the one-way rollback); launch (void, retention, privacy duties, legal review, DA-118 and DA-119).

## 5. Conditional implementation contract (applies only once §9 is accepted)

Every detail below is a conditional proposal. It follows the existing API conventions (§2.2). None of it is built, and none of it is to be scaffolded before acceptance.

### A. Operation, request, response and errors

- **Issue.** `POST /api/v1/stores/{storeId}/invoice-drafts/{id}/issue`, tenant session, `trustedContext: 'required'`, `recentAuth: 'none'`, `Idempotency-Key` required, JSON body ≤ 1 KiB, exactly `{ "expectedTenant": <uuid>, "expectedVersion": <1..2^53−2>, "expectedSettingsVersion": <1..2^53−1>, "expectedCustomerVersion": <1..2^53−1> }`. The draft's bound stops at 2^53 − 2 because issuing steps it by one, as the discard's does; the other two are read, not stepped. The suffix route reuses the generic `{id}`-before-suffix reading (`server/runtime/app.ts:974-979`).
- **Success.** `201 { "invoice": { "id", "number", "sourceDraftId", "status": "issued" }, "draft": { "id", "version": n+1, "status": "issued" } }` with a `Location` to the issued invoice; `number` is a JSON integer ≤ 2^53 − 1. Small enough to be replayed (≤ 16 KiB).
- **Eligibility.** `GET …/invoice-drafts/{id}/issue-eligibility`: `200 { "eligibility": "allowed" }` exactly when the actor may issue at this store, target-blind, as the discard's.
- **Reads.** `GET /api/v1/stores/{storeId}/invoices` (keyset-paged list: id, number, sourceDraftId, customerId, customer name at issue, total, issuedAt) with an exact `sourceDraft` filter for "Find issued invoice"; `GET /api/v1/stores/{storeId}/invoices/{id}` (the snapshot, without the issuing actor). Both under `view_issued_invoices`; a missing and a foreign id are the same 404.
- **Issue preview.** `GET …/invoice-drafts/{id}/issue-preview` under `issue_invoices`: the draft's version, its customer's name and version, the store's issuing settings and their version, and the computed subtotal, tax and total; no number. This is what the confirmation shows and what the POST's three expected versions come from. Because customers are tenant-owned and today readable only on tenant routes (DA-189), this is a **new store-scope disclosure** of one customer's name, the draft's own, decided on the store grant's Customers View corequisite like the save's; without it a store-only actor could not issue at all.
- **Issuing settings.** A tenant template, as the router requires (any path with `/{storeId}` is a store route: `server/runtime/routes.ts:428-447`): `GET` and `PUT /api/v1/issuing-settings/{id}`, where `{id}` is the store id, a selector that must name a store of the trusted tenant. Both under `edit_issuing_settings` (owner rule, recent sign-in); the `PUT` takes `Idempotency-Key` and `expectedVersion`, where `0` means "the store has no settings yet"; the first write creates the settings at version 1 and the store's counter at 0. A first write when settings exist, or a later write at a stale version, is the sealed `write_conflict`. One audit record per change; no event.
  - Fields: legal name, postal address, tax registration identifier (optional), and, only if T1 is the accepted branch, the rate in thousandths of a percent. Only the branch the owner accepts in §9 is built: under T1 every store has a rate; under T0 no store has one and the settings carry no tax field. A per-store choice between T0 and T1 is not proposed. Exact field bounds follow F-1 and F-2.
- **Errors.** The existing words where they fit: 400 `invalid_request`; 401; 403 `forbidden`; 404 `not_found`; sealed 409 `invalid_state` (not open) and `write_conflict` (stale version); 409 `request_in_progress`; 422 `idempotency_key_reused`; 413, 415, 429, 503. New sealed refusals, each a 409 decided after authorization and before anything is written: `issuing_not_configured` (no settings for the store) and `amount_out_of_range` (total above 2^53 − 1, or the store's counter at 2^53 − 1). The kernel's typed sealed refusals must widen to carry them (§2.2, kernel limits).

### B. Trusted context, authorization, version and fencing

- The chain resolves the session, the store grant and `issue_invoices` exactly as for the discard; the body's `expectedTenant` is a precondition, never authority.
- The transaction runs the existing order: lease fence, revalidator (the same permission, re-decided on this transaction), then **one** definer routine that re-derives the caller from the session key and decides again under locks.
- **Lock order inside the routine (PROPOSED):** 016's standing hold; session and ledger rows; the draft header `FOR UPDATE`; advisory key 530030 SHARED for Invoices **and** Customers levels (the save's pattern, migration 032); the customer row `FOR SHARE` (so its name cannot change before COMMIT); the store's issuing settings `FOR SHARE`; the store's counter row `FOR UPDATE`; then `clock_timestamp()` for the issue time. Level writers keep taking key 530030 EXCLUSIVE. A settings writer takes the settings row `FOR UPDATE` and no counter; a customer edit takes the customer row `FOR UPDATE` and no key. No cycle forms, but two waits are expected: a queued level writer delays later issues, and an issue and a customer edit wait for each other at the customer row. This must be argued in the migration header, as 030's and 033's are.
- **Decision order:** state, then whether the store has issuing settings (`issuing_not_configured`), then the three versions, then amounts, and only then the counter. A sealed refusal commits (DA-36), so nothing may be written before the last refusal is decided.
- **The settings write** is authorized the same way at each layer: the chain's owner rule and recent sign-in; the transaction's revalidator re-deciding `edit_issuing_settings`; and a definer routine that takes the same opening order as the issue (016's standing hold, then the session and ledger rows), re-derives the store owner (`store_owner`) on a tenant grant from the session key after those waits, checks that the store belongs to that tenant, refuses read-only, and then takes a transaction-scoped advisory key for that store's settings (a new key class, not 530030) before it reads, creates or locks the settings row, so two concurrent first writes serialize and the second answers `write_conflict`.

### C. One atomic transaction

In one transaction, or none of it: the number allocation; the issued invoice header, lines and snapshot; the draft's move to `issued` at version + 1; one audit record (`store.invoice.issue`, subject the draft and the issued invoice, metadata `{}`); the lease-checked idempotency completion; and no outbox row unless D below is decided otherwise.

**The kernel.** Today a command changes one aggregate in create or update mode (§2.2). The proposal keeps that shape: the command's aggregate is the **draft**, in update mode with its expected version, and the one definer routine also writes the issued invoice, its lines and the counter as part of the same call. Three kernel extensions are still needed and must be designed and tested as such: an update-mode command answering `201` with a `Location`; the two new typed sealed refusals (§5 A); and a second audit subject, a typed column for the issued invoice on `public.audit_event` (a forward change; the draft subject column already exists).

### D. Is an event needed?

**Not in this slice (PROPOSED).** No domain or provider consumes an issuance yet: there is no payment, receivable, inventory or notification consumer, and no outbox publisher is composed (§2.2). An event added only for symmetry with the draft events would be retained data without a reader. This is decided on its own facts, not copied from the discard. When the payment slice or a notification consumer is decided, an `invoice.issued` v1 event can be added; issuances made before then would not be covered, which the consumer's design must accept or backfill from the issued records.

### E. The long-term invariant against duplicate issuance

The invariant is a database unique constraint on the issued invoice's source draft id: it refuses a second issued invoice for one draft on any path, including a direct insert, long after the idempotency record has expired. The draft's terminal `issued` state under the lifecycle guard is the routine path's second barrier; it alone would not stop an insert into the issued table. Alongside: `unique (tenant, store, number)`, `number > 0`, and the counter `0 ≤ value ≤ 2^53 − 1`. The 24-hour key is only a retry convenience.

### F. Immutability, reads, snapshots and privacy

- Issued invoice rows and their lines: insert only, through the issuing routine; an ENABLE ALWAYS guard refuses every update and delete (as 033's guards do for discarded drafts), except the void transition in the next slice.
- The issued snapshot is read only through `view_issued_invoices` reads; the draft reads stay open-only and never show an issued draft.
- Issuing settings are a per-store record maintained by the store owner, with a version and an audit record per change. A settings change never rewrites an issued snapshot. The audit record is route-level: a direct call of the settings routine with a live store-owner key would change the rate or the legal issuer with no audit record (DA-119's class, §5 J).
- Logs, notices, browser storage and URLs never carry the session key, the idempotency key, the body or snapshot contents (the IDDH-18 / SID-132 rules).

### G. Manual unknown-outcome flow in the shop

- One press of **Issue invoice** sends one POST under one fresh key; a second activation in the same task sends nothing (the SID-146 rule).
- The attempt (key, exact body, store, draft, session generation, send times) is held in a per-user in-memory hold store like the save's, and survives closing the confirmation. A user change, session end or sign-out drops it.
- While unresolved, the card says "Not confirmed yet: the server may have issued this invoice", and offers "Check again" (same key and bytes, within 23 hours, under the same session) and "Find issued invoice" (a read by source draft). Nothing re-sends on a timer, focus, reload or reconnect.
- The shop never shows "Issued", a number or a total as issued until a 201, a replayed 201 or a read of the issued invoice confirms it.

### H. Accessibility of the later confirmation, validation and recovery UI

- The confirmation is an `alertdialog` (the existing `DialogFrame`) whose name and description identify the draft and state the consequence ("This issues the store's next invoice number for $…; it cannot be changed"). The number is not shown in advance: another issue at the store can take the next one first. It appears only after a confirmed 201 or a read.
- It shows the customer, every line, the subtotal, the tax rate and amount, and the total; initial focus is on **Keep draft**, not on **Issue invoice**; Escape closes it only while nothing has been sent.
- Refusals (`invalid_state`, `write_conflict`, `issuing_not_configured`, `amount_out_of_range`) are announced with `role="alert"` and focus moves to the message; attempt state uses `role="status"`; disabled controls are tied to their reason with `aria-describedby`.
- Focus returns to the row's own control after closing, and never falls to `<body>`. Every action is keyboard operable, with distinct accessible names.
- No whole-app WCAG claim; the browser evidence covers only the configurations its tests name.

### I. Migration implications

- **033 permits only `draft` → `discarded`.** Issuing cannot reuse 033's guard unchanged and is not an ordinary draft edit: 033's CHECK refuses any new status, its terminal trigger refuses any other transition, and its line trigger already freezes lines under any non-open header.
- **Options.**
  - **(1) Separate issued representation plus a forward lifecycle change (recommended, conditional).** Migration 034, in a new schema (033's precedent for new objects; its changes to 033's own CHECK and trigger are undone exactly by its down, below), adds the issued invoice tables, the per-store counter, the issuing settings and the issuing routine and reads. On the draft table it widens the status CHECK to `('draft','discarded','issued')`, and replaces 033's terminal trigger with a successor whose discard branch is the same and which adds one branch: open → `issued` at version + 1 with nothing else changed. Discarded rows stay exactly as terminal as today.
  - **(2) Issued state on the draft row** (§1 shape B). Rejected for the reasons in §1.
  - **(3) No draft status change**, with a new trigger that refuses edits to a draft that has an issued invoice. Avoids touching 033's guard, but leaves an issued draft looking open to every existing draft read and routine, which would then need replacing anyway.
- **Old readers.** 033's open-only reads already hide any non-`draft` row, and the edit and discard routines already answer `invalid_state` for any non-`draft` status. A runtime at 033 would therefore treat an issued draft safely, but the startup preflight refuses a runtime and a database at different heads anyway.
- **033's down while 034 is applied.** 034 must not leave 033 rollable: like 033's own anchor for 028–032, 034 adds a dependency anchor on the objects it builds on, so 033's down refuses (2BP01) while 034 is applied.
- **034's down must restore exactly what 033 left.** The CHECK text (`draft`, `discarded`), the terminal trigger's name, binding to 033's function, `ENABLE ALWAYS` state and type, and 033's function itself (034 replaces the trigger's binding, not 033's function body), because 033's down accepts only that catalog (`033…down.sql:79-98, 176-203`). It refuses before touching anything if the catalog is not 034's exact postcondition.
- **Grants.** New routines are granted to the runtime role only. No existing grant becomes obsolete: the draft routines keep serving open drafts. `APPROVED_ROLE_GRANTS` and `REQUIRED_MIGRATIONS` change in the same change as 034.
- **Upgrade order.** Stop the 033 runtime; apply 034 in a maintenance window (it takes ACCESS EXCLUSIVE on 033's seven writer-order tables, including `public.audit_event`, which gains the issued-invoice subject column); start the 034 runtime. There is no mixed-version window.
- **Rollback.** 034's down refuses while any draft is `issued`, any issued invoice exists, any issuing settings or counter row exists, or any audit record names an issued invoice (as 028's down refuses while an audit record names a draft), and never deletes financial, configuration or audit history. After the first issue, recovery is a forward migration. 033's down keeps refusing while any draft is discarded.
- **Unchanged.** Migrations 001–033 stay byte-identical. This pack writes no migration 034 and no skeleton.

### J. What route-level atomicity does not resolve

The issuing routine would be executable by the runtime role, so a holder of that role with a live session key could call it directly and issue without the route's audit record, idempotency completion or HTTP checks. That is DA-118's class, widened; it is not closed by the route being atomic and is not database-enforced. DA-119 (direct Invoices-level changes with a live store-owner key) likewise stays a pre-deployment blocker, and the issuing-settings routine would widen it to the tax rate and the legal issuer. G-AUDIT, G-IDEMPOT, G-PERSIST, G-IAM, G-PRIVACY, G-DBCONSTRAINTS, G-DBROLE, G-BACKUP, G-PERF, G-OBSERVE and the other production gates stay open.

## 6. Dependencies and explicit deferrals

| Item | Required for the first slice | Preserved constraint | Later capability | Before launch |
|---|---|---|---|---|
| Issuing settings | Yes (routes; F-1's field list confirmed) | Store owner only, tenant-scope owner rule, recent sign-in | — | Each store's real F-1 values entered |
| Tax branch T1 or T0 (F-3) | Yes (choice) | Integer cents, no float | T2 | Legal review |
| Store time zone (F-4) | No (UTC shown) | DB time | Local dates, date series | If required |
| Void | No | Immutability | — | **Yes** |
| Credit notes, payments, amount due | No | No receivable claim | Payment slice | — |
| Discounts, shipping, fees, negative lines | No | Prices ≥ 0 | Later | — |
| Catalog prices, fractional quantities | No | User-entered whole quantities | Later | — |
| Customer address | No | Not invented | If a jurisdiction requires it | If required |
| Delivery (email, print) | No | Nothing sent | Later | — |
| Event `invoice.issued` | No | No consumer | With a consumer | — |
| Legacy mapping (DA-176) | No | Separation | Owner decision | — |
| DA-118, DA-119 | No | Route-level audit only | — | **Yes** |
| Retention (DA-187, F-5) | No | Nothing deletes | Governed purge | **Yes** |
| Store step-up | No | No recent sign-in | If the owner wants it | — |

## 7. Planned acceptance tests — FUTURE TESTS, NOT RUN

None of these exists or has run. They map the proposed requirements to decisive assertions and to the existing harness that each would reuse (§2.2; the invoice HTTP suites' relay, `trapCommit`, `withEntry`, `withTrigger` and `expireLease`; the routine suites' `holding`, `blockedBy` and `stateOf`; `catalogOf`; the shop's `fakeServer`; the browser's `st.lose` and `gate`). A synthetic test does not prove deployment behaviour.

| ID | Requirement | Layer | Decisive assertion | Reuses |
|---|---|---|---|---|
| ISS-01 | Stored levels decide | HTTP | Over every role and stored level, `issue_invoices` succeeds exactly at Invoices ≥ Approve with Customers ≥ View; eligibility equals the real POST's authorization | IDDH-02, IDH-15 |
| ISS-02 | Read-only and custom roles | HTTP | Read-only actor, tenant or store and a browser-only custom role cannot issue | IDDH-03, SDB-07 |
| ISS-03 | Revocation and narrowing while waiting | HTTP + routine | A committed revocation or level narrowing while the issue waits on the header or role key refuses it and writes nothing | IDDH-04, IDDH-05, IDD-07 |
| ISS-04 | Cross-store isolation | HTTP | Another store's or tenant's draft, settings or invoice is the same 404 or 403; numbers of two stores are independent | IDH-02, IDDH-06 |
| ISS-05 | Issue / edit / discard races | Routine + HTTP | Each pair serializes on the header; exactly one wins; the loser gets the stated sealed answer; nothing partial | IDD-06, IDDH-08 |
| ISS-06 | Two instances, different keys | HTTP | One 201, one sealed `invalid_state`; one issued invoice, one audit record, one number | IDDH-08, IDH-08 |
| ISS-07 | Version checks | HTTP | Stale and future draft, settings and customer versions are each sealed `write_conflict`, with the counter unchanged; a non-open draft is `invalid_state` whatever the versions | IDDH-07, IDD-05 |
| ISS-08 | One issue per draft after key expiry | HTTP + store clock | With the store clock advanced past retention, the same key and a new key both get `invalid_state`; still one issued invoice | transactionalStore frozen clock (new lever for HTTP suites), IDDH-10 |
| ISS-09 | Number allocation | Routine + HTTP | Concurrent issues at one store get consecutive numbers in commit order, with issue times in the same order; after each committed sealed refusal and each rolled-back fault the counter is unchanged; the first two issues at a new store get 1 and 2 | M6-PG-09 pattern, `withTrigger` |
| ISS-10 | Lost acknowledgement and numbers | HTTP | Both `trapCommit` branches: `lose` → the number exists once and replays; `cut` → no invoice and the next issue takes the same number | IDDH-13 |
| ISS-11 | Amount bounds and rounding | Unit + routine | Each §4 worked example, the half-cent case, a subtotal of 2^53 − 1 at the 100,000 rate, a subtotal of 1,000,000,000,050,001 at 99,999 (where `floor` on `numeric` is one cent high) and the 2^53 − 1 refusal, computed identically in the runtime (BigInt) and the database (`div`) | IDC-09..11, IDH-06 |
| ISS-12 | Not configured (T1) | HTTP | No settings → sealed `issuing_not_configured`, nothing written; a rate of 0 entered by the store owner issues with tax 0 | — |
| ISS-12b | Branch T0 (only if T0 is accepted instead of T1) | HTTP | The snapshot's tax mode is "none" with no rate or tax field, total = subtotal and the "No tax calculated" statement; without settings, `issuing_not_configured` | — |
| ISS-13 | Snapshot immutability | Routine | Every update and delete of an issued invoice or line is refused by the guard, including as the table owner and as a replica session | IDD-09 |
| ISS-14 | Snapshot independence | HTTP | Renaming the customer or changing settings after issue leaves the issued snapshot unchanged | IEH-01 pattern |
| ISS-15 | Read permissions | HTTP | `view_issued_invoices` needs Invoices View and Customers View: an Invoices View role without Customers View reads nothing; a View-only reader reads but cannot issue; every issuer can read; the reads never return the issuing actor | IDDH-14 |
| ISS-16 | Atomicity | HTTP | A fault at the invoice insert, the line insert, the draft transition, the counter, the audit record or the completion leaves nothing written and the number unused | IDDH-11, IDH-07 |
| ISS-17 | Exact audit and event record | HTTP | One `store.invoice.issue` record with both subjects, metadata `{}`; none on refusals or replays; zero outbox rows on success, refusal and replay | IDDH-16, IDDH-01 |
| ISS-18 | Same-key replay under current authority | HTTP | Replay after a level narrowing is 403, after revocation 401, and after restoration the stored bytes | IDDH-17 |
| ISS-19 | Manual recovery, both lost-COMMIT outcomes | jsdom + browser | Unresolved card; "Check again" sends the same key and bytes; "Find issued invoice" settles by a read; nothing re-sent on focus, reload or timer; the attempt survives closing the confirmation and is dropped on sign-out | SID-119, SID-125, SID-128, SDB-02, SDB-20 |
| ISS-20 | Migration 034 | Routine | Apply, postcondition, refused re-apply; down refuses after an issue, after settings exist and while an audit record names an issued invoice; on a clean database 034 up then down leaves a catalog snapshot identical to 033's; 033's down refuses while 034 is applied; 033's discard rules unchanged (IDD-01..14 still pass); old routines answer `invalid_state` on an issued draft | IDD-01, IDD-13, IDE-22, `catalogOf` |
| ISS-21 | Startup and least privilege | DB + unit | Ledger exactly 001–034; approved grants exact; catalog snapshot of the new schema with fixed ordering | M7TE-10, M6PF-*, IDD-02 |
| ISS-22 | Real-socket body bounds | HTTP | 1 KiB bound, 413 and 415 over real sockets | IDDH-19 |
| ISS-23 | Confirmation and keyboard | jsdom + browser | Alertdialog name and description; initial focus on Keep draft; Escape; focus return; distinct names; refusals announced | SID-117, SID-139, SDB-18 |
| ISS-24 | No sensitive data leaks | jsdom + browser + HTTP | No key, body, token or snapshot in storage, URL, notices or logs | SID-132, IDDH-18, `assertNoLeak` |
| ISS-25 | Settings write authority | HTTP + routine | The store owner on a tenant grant with a recent sign-in writes settings with the version check and exactly one audit record and no event; a manager, a store grant alone, a read-only tenant, a stale version and a missing recent sign-in are refused and write nothing; two concurrent first writes give one version 1 and one `write_conflict`; a revocation committed while the write waits refuses it | roleLevels (M7RLH-*) pattern, IDDH-05 |

**Harness gaps (not present today).** No number allocator or gap checker; no retention-expiry lever in the invoice HTTP suites (only the store-layer frozen clock); no fixture with issuer data; no shared relay module (each suite copies it).

## 8. Conditional implementation sequence

Only after §9 is accepted and the MISSING inputs are supplied or explicitly branched:

1. **Server and migration 034**: issuing settings, counter, issued tables, guards, the issuing routine, reads, startup pins and grants; ISS-01..18, 20..22, 25. Commit and exact-SHA CI.
2. **Shop**: the issued-invoice list and detail, the settings form (owner), the Issue confirmation, the hold store and recovery; ISS-19, 23, 24. Commit and exact-SHA CI.
3. **Docs**: an ADR for the decided form; [05](./05-canonical-data-ownership-and-api-db-contracts.md), [08](./08-production-gate-and-risk-register.md) and [09](./09-roadmap-m0-m9.md) updates; this pack's status update.
4. **Void** (its own decision pack and slice) before any live issuing.

Nothing is deployed by any of these steps; deployment remains behind the production gates.

## 9. Owner decisions and response template

**Decision table.**

| # | Decision | Recommendation in brief | Main alternative | Blocks |
|---|---|---|---|---|
| D-ISS-1 | Meaning, lifecycle, issuer | Separate immutable issued invoice; draft → `issued` terminal; no amount due; per-store issuing settings; void next | Issue the draft row; or with an amount due | Implementation; launch (void, legal review) |
| D-ISS-2 | Authority | `issue_invoices` at Invoices Approve + Customers View; `view_issued_invoices` at View + Customers View; settings written by the store owner (tenant-scope owner rule, recent sign-in); no step-up to issue | At Manage; or a boolean grant | Implementation |
| D-ISS-3 | Numbering | Per-store continuous integers from 1, allocated in the transaction; no prefix, date or reset | Tenant-wide series; a sequence | Implementation; format at launch |
| D-ISS-4 | Amounts and tax | T1: one store-owner-entered exclusive rate per store, invoice-level half-up rounding; no discounts or charges | T0: no tax line; per-line rates | Implementation |
| D-ISS-5 | Contents and privacy | Snapshot seller, customer name, lines, amounts, number, time, source; no phone or email | Copy contact data; live link only | Implementation |
| D-ISS-6 | Concurrency and recovery | Request binds draft, settings and customer versions; one issue per draft in the database; `invalid_state` on a new key; per-user hold until session end; Check again; Find issued invoice; the issued list after a reload | Dialog-only tracking | Implementation |
| D-ISS-7 | Retention and correction | Nothing deletes in the first implementation; one-way rollback; void before live use; retention, §6 privacy duties, legal review, DA-118/119 before launch | Void and credit notes in the first slice | Implementation; launch |

**Response template.** Copy, fill in each line and send. Each line starts as a placeholder; nothing is recorded as accepted until the owner sends it.

```
M7B invoice issuing — owner decisions
D-ISS-1 meaning and lifecycle:    [ACCEPT | CHANGE: … | DEFER]
D-ISS-2 authority:                [ACCEPT | CHANGE: … | DEFER]
D-ISS-3 numbering:                [ACCEPT | CHANGE: … | DEFER]
D-ISS-4 amounts and tax:          [ACCEPT T1 | ACCEPT T0 | CHANGE: … | DEFER]
D-ISS-5 contents and privacy:     [ACCEPT | CHANGE: … | DEFER]
D-ISS-6 concurrency and recovery: [ACCEPT | CHANGE: … | DEFER]
D-ISS-7 retention and correction: [ACCEPT | CHANGE: … | DEFER]

Facts (needed before implementation unless marked):
F-1 legal issuer: which fields an issued invoice must show (legal name, postal address,
    tax registration id, other), and whether one legal entity covers all stores or which differ;
    each store's real values are entered later, before live issuing:  …
F-2 jurisdiction(s) of the stores, and any invoice-content or numbering rule
    the owner already knows of (before launch at the latest): …
F-3 sales tax: does it apply; one rate per store or several; prices exclusive or inclusive: …
F-4 store time zone, if the invoice must show a local date (optional): …
F-5 how long issued invoices must be kept (before launch): …
```

For information, not an owner decision: the proposed routes are `POST /api/v1/stores/{storeId}/invoice-drafts/{id}/issue`, `GET …/{id}/issue-eligibility`, `GET /api/v1/stores/{storeId}/invoices[/{id}]` and `GET …/{id}/issue-preview`, and `GET` and `PUT /api/v1/issuing-settings/{id}` (§5 A).

## 10. Adopted contract (M7B-INVOICES-ISSUE-P1)

**Status of this section: ADOPTED as amended by the owner's stage instruction of 2026-10-16 ([ADR-50](./10-architecture-decision-records.md)).** It is the implementation contract the server foundation is built to, written down before it was wired. *(M7B-INVOICES-ISSUE-P1, delivered: the server foundation is IMPLEMENTED in code to this section, with no shop UI; facts settled while building are marked "As built" where they belong, and §10.11 maps each planned test of §7 to the executed ones.)* *(M7B-INVOICES-ISSUE-P2: the shop's use of §10.3's routes is built in code, in the Invoices page's Issued invoices section and its Server drafts section, with no change to this contract; §10.12 records it and its deviations.)* §4's recommendations as accepted and §5's contract stay adopted except where this section amends them, and where it does it says why; §4's alternatives, the single product-wide T0/T1 choice and the launch facts are not adopted, and §1–§3 and §6–§9 are kept as the proposal's history. Launch facts (the stores' jurisdictions, each merchant's real issuer values, tax applicability and rates, retention periods and privacy mechanisms) remain unknown and are not filled in here.

### 10.1 What the owner changed relative to §4

| Decision | Adopted | Change from the pack |
|---|---|---|
| D-ISS-1 | Accepted as amended | The issued amount is labelled **Total** and claims no amount due, unpaid status, balance, due date, deposit or payment; the issued list is never an unpaid list. The document's meaning is frozen under a **snapshot contract version** (§10.5): no later feature, payments included, silently reinterprets version-1 records or relabels their totals as balances. No privacy bypass or generic override is added now; a controlled privacy mechanism is a pre-launch decision. No integration event is emitted in this first slice (no provider or other domain consumes issuing here); the issue audit record is mandatory. Void remains the next capability and must exist before live issuing. |
| D-ISS-2 | Accepted | — (read-only authority can neither issue nor change settings; Customers View loss also loses issued reads and recovery access under that role; the corequisite grants no directory or contact access.) |
| D-ISS-3 | Accepted | — |
| D-ISS-4 | **Changed** | Not one product-wide T1 or T0 branch: **each store owner explicitly selects one mode per store** — `exclusive_rate` (one integer rate in thousandths of a percent, 0–100,000) or `none` ("No tax calculated", total = subtotal). No default mode or rate; an explicit 0 rate is not `none`. Choosing `none` is the merchant's audited configuration choice; the product does not verify tax applicability. ISS-12 and ISS-12b both apply. §5 A's "A per-store choice between T0 and T1 is not proposed" is superseded. |
| D-ISS-5 | Accepted with field choices | Settings hold: legal seller name (required), **invoice-facing store name (required; versioned issuing configuration, not a store rename and not `public.store.store_name`)**, postal address (required, bounded free text with a line-break rule), tax registration id (optional), and the tax mode/rate. The snapshot also records the reviewed settings and customer versions and the snapshot contract version. Display wording is fixed by the contract: the rate mode's line is **Tax**, the no-tax statement is **No tax calculated**. UTC is authoritative; no store time-zone setting. |
| D-ISS-6 | Accepted | — (server contract only; the shop's manual "Check again", with no automatic resend, and its hold store are the next slice). |
| D-ISS-7 | Accepted with privacy qualification | Normal immutability does not decide the future privacy process; retention, privacy mechanisms, legal review, backup/restore assurance, void and DA-118/119 remain pre-launch. |

The approved field structure and per-store tax model resolve the design inputs §2.5 F-1 (field list) and F-3 (model) needed for a synthetic build; F-4 is answered for this slice by the UTC rule (no store time-zone setting); F-2, F-5 and each merchant's values stay open. No single legal entity is assumed to cover every tenant or store.

### 10.2 Permissions

| Key | Scope | Rule | Recent sign-in |
|---|---|---|---|
| `issue_invoices` | store | stored Invoices level ≥ **Approve** on the store grant's role **and** Customers ≥ View on the same role; never under read-only | none |
| `view_issued_invoices` | store | Invoices ≥ View and Customers ≥ View | none |
| `edit_issuing_settings` | tenant | the owner rule (`store_owner` on exactly one tenant grant, limitation `none`), as `edit_role_levels`; sensitive, threshold Full, parent `invoices`; a store or platform grant never satisfies it | required on the write (the route's `recentAuth`), as the owner's "writes require recent sign-in"; §5 A's "both under … recent sign-in" is narrowed to the write |

The store guard admits exactly one Approve key (`issue_invoices`, Invoices, Customers View corequisite) beside the one Manage key; no other threshold widens. The tenant guard admits exactly two owner-only keys. Read-only authority can neither issue nor change settings, and the existing actor, tenant and store status rules apply unchanged. No role-name shortcut beyond the adopted owner rule, no System Owner bypass and no browser-only role authority. Every definer read re-decides its own authority from the session key (§10.9), so a level lowered between the chain and the read is honoured.

### 10.3 Routes

All are tenant-session routes with `trustedContext: 'required'`; every path id selects, none grants. Reads are `no-store`, refuse any query they do not define, and pass the session key to a session-bound definer read. *(As built: the two commands, the issue and the settings write, accept and ignore a query string exactly as the existing edit and discard do; only the reads refuse one.)*

| Method and path | Permission | Body | Idempotency |
|---|---|---|---|
| `GET /api/v1/issuing-settings/{id}` (`{id}` = a store of the trusted tenant) | `edit_issuing_settings` | none | none |
| `PUT /api/v1/issuing-settings/{id}` | `edit_issuing_settings`, `recentAuth: 'required'` | JSON ≤ 8 KiB | required |
| `GET /api/v1/stores/{storeId}/invoice-drafts/{id}/issue-eligibility` | `issue_invoices` | none | none |
| `GET /api/v1/stores/{storeId}/invoice-drafts/{id}/issue-preview` | `issue_invoices` | none | none |
| `POST /api/v1/stores/{storeId}/invoice-drafts/{id}/issue` | `issue_invoices` | JSON ≤ 1 KiB | required |
| `GET /api/v1/stores/{storeId}/invoices` | `view_issued_invoices` | none | none |
| `GET /api/v1/stores/{storeId}/invoices/{id}` | `view_issued_invoices` | none | none |

### 10.4 Wire shapes

**Tax setting** — exactly one of `{ "mode": "exclusive_rate", "rateMilliPercent": <integer 0..100000> }` or `{ "mode": "none" }`. Any other key, mode or combination (a rate with `none`, none with `exclusive_rate`), a fractional, negative, `-0` or out-of-range rate is a 400.

**Text fields** reuse the customer name's existing rules: the runtime's `normalizePlainText` (`server/runtime/customerCreate.ts`: trim, refuse C0/C1 controls, DEL, U+2028/U+2029, lone surrogates and every Bidi_Control character, require a visible character, count Unicode scalar values) and, in SQL, the 009/017 CHECK set (`char_length` bounds, the same controls, each Bidi_Control character listed, no edge white space). As in 028, the visible-character rule is the runtime's alone; the database refuses everything else independently.
- `legalName` 1–200 scalar values; `storeName` 1–120; `taxRegistrationId` `null` or 1–64;
- `postalAddress`: 1–8 lines joined by a single U+000A (LF, the only control admitted, and only here); the runtime trims each line and requires each to be 1–120 scalar values with a visible character; SQL admits LF only between lines (no leading, trailing or doubled LF; at most 7) and applies the shared check to each line from `string_to_array(value, E'\n')`; CR is refused. *(As built: the runtime trims the whole value first, then splits it on LF and trims each line, and a CR anywhere is refused, never trimmed away. Inside the kernel the address is carried as one bounded rows field of `{ line }` records, at most 8, because the kernel's change-set strings refuse every control character, LF included; the mutator joins the lines with one LF before the routine stores them, and the settings read returns that LF-joined text.)*
- These limits are a technical choice for the synthetic build; F-2 may revise them before launch.

**Settings read** — `200 { "issuingSettings": { "storeId", "version": 0, "configured": false } }` when the store has none, or `200 { "issuingSettings": { "storeId", "version": n, "configured": true, "legalName", "storeName", "postalAddress", "taxRegistrationId": string|null, "tax": <tax setting> } }`. A store id that is not a store of the trusted tenant in a readable status (active, trialing, overdue, read_only) is `404 not_found`; no store grant is needed or consulted.

**Settings write** — exactly `{ "expectedTenant": <uuid>, "expectedVersion": <0..2^53−2>, "legalName", "storeName", "postalAddress", "taxRegistrationId": string|null, "tax": <tax setting> }`. `expectedVersion` 0 means "the store has no settings yet": the first write creates version 1 and the store's number counter at 0 in the same transaction. Answer `200` with the settings-read body at `expectedVersion + 1`. **Every accepted write is a new version** — the version moves by one and one audit record is written even when every value equals the previous version's (there is no no-op), so a change-away/change-back never recreates a reviewed version.

**Issue eligibility** — `200 { "eligibility": "allowed" }` exactly when the chain admits `issue_invoices` at the store; target-blind, reads no draft, takes no lease (the discard eligibility's form).

**Issue preview** — one STABLE definer read, one snapshot, no lock, no lease, no number:
`200 { "preview": { "draft": { "id", "version", "lines": [{ "position", "description", "quantity", "unitPriceCents", "lineTotalCents" }], "subtotalCents" }, "customer": { "id", "name", "version" }, "issuingSettings": { "version", "legalName", "storeName", "postalAddress", "taxRegistrationId", "tax": <tax setting> }, "amounts": <amounts>, "expected": { "expectedTenant", "expectedVersion", "expectedSettingsVersion", "expectedCustomerVersion" } } }` — `expected` is exactly the issue body this preview supports. In this order: a missing, foreign or non-open draft is `404 not_found`; a draft at version 2^53 − 1 (whose version cannot step) is `409 invalid_state`; a store without settings is `409 issuing_not_configured`; a total above 2^53 − 1 or an exhausted number series is `409 amount_out_of_range` (all unsealed: a read).

**Amounts** — `{ "currency": "USD", "subtotalCents", "tax": { "mode": "exclusive_rate", "label": "Tax", "rateMilliPercent", "amountCents" } | { "mode": "none", "description": "No tax calculated" }, "totalCents" }`, every amount a JSON integer ≤ 2^53 − 1.

**Issue** — exactly `{ "expectedTenant": <uuid>, "expectedVersion": <1..2^53−2>, "expectedSettingsVersion": <1..2^53−1>, "expectedCustomerVersion": <1..2^53−1> }`. Success `201 { "invoice": { "id", "sourceDraftId", "status": "issued" }, "draft": { "id", "version": expectedVersion + 1, "status": "issued" } }` with `Location: /api/v1/stores/{storeId}/invoices/{invoiceId}`. **The number is not in the 201**: the kernel seals the success response before the transaction (ADR-17; `commandTransaction.ts` `prepareCommand`), and the number is allocated inside it; carrying it would need the store to author a sealed response, which the kernel forbids. The number is read from the invoice the `Location` names (every issuer holds `view_issued_invoices`). This replaces §5 A's `"number"` in the 201.

**Issued list** — `GET …/invoices?limit=<1..50, default 20>&cursor=<23-char base64url>` or `?sourceDraft=<uuid>` (the "Find issued invoice" filter: at most one item; a cursor with it is a 400). An unknown, another store's or tenant's, an open or a discarded draft id gives the same empty page. Newest number first. `200 { "invoices": [{ "id", "number", "sourceDraftId", "customerId", "customerName", "currency", "totalCents", "issuedAt", "status": "issued", "snapshotVersion": 1 }], "nextCursor": string|null }`. The cursor is a tag byte and the last served invoice's 16 id bytes, canonical spelling only; an unknown or foreign anchor is a 400.

**Issued detail** — `200 { "invoice": { "id", "number", "status": "issued", "snapshotVersion": 1, "issuedAt", "sourceDraft": { "id", "version" }, "seller": { "legalName", "storeName", "postalAddress", "taxRegistrationId" }, "issuingSettingsVersion", "customer": { "id", "name", "version" }, "lines": [{ "position", "description", "quantity", "unitPriceCents", "lineTotalCents" }], "amounts": <amounts> } }`, lines in position order 1..n. A missing and a foreign id are the same 404. No read returns the issuing actor, a customer phone or email, or anything labelled due, paid, unpaid or balance. `issuedAt` is the database's UTC time, `YYYY-MM-DDTHH:MM:SS.ffffffZ`.

### 10.5 Snapshot contract version 1

Every issued invoice stores `snapshot_version = 1`, meaning: the document records what the store invoiced at issue time; **Total** is `subtotal + tax` (or the subtotal under `none`) and is not an amount due, a balance or a payment status; tax is computed once on the subtotal, tax-exclusive; amounts are USD integer cents. Any later change to the issued snapshot or read semantics introduces a new version for new records; no later feature, payments included, silently reinterprets version-1 records or relabels their totals as balances.

### 10.6 Errors and refusal precedence

The existing words only, plus two new sealed 409s: `issuing_not_configured` and `amount_out_of_range` (a total above 2^53 − 1, or the store's counter at 2^53 − 1).

**Issue** (in order): the chain's 400/413/415, 403 origin/CSRF, 401, 403 `forbidden`, 400 target, body read, 400 key, the idempotency answers (replay; 409 `request_in_progress`; 422 `idempotency_key_reused`), 400 `invalid_request` from the plan (lease acquired, nothing recorded, the lease waits out its time); then inside the transaction: fence (503 `lease_lost`), revalidation (503), and the routine: authority (503, rolled back) → `expectedTenant` mismatch (409 `write_conflict`, unsealed, rolled back) → draft missing or another store's (404, rolled back) → not open (sealed 409 `invalid_state`) → no settings (sealed 409 `issuing_not_configured`) → draft version (sealed 409 `write_conflict`) → settings version (sealed `write_conflict`) → customer version (sealed `write_conflict`) → total or counter out of range (sealed 409 `amount_out_of_range`) → 201. A sealed refusal commits its completion and nothing else (no number, invoice, draft change or audit row); a rolled-back refusal commits nothing and leaves the lease to expire. *(As built: like every sealed answer, a sealed `issuing_not_configured` or `amount_out_of_range` is replayed byte for byte under its key for the key's retention, even after the owner has since configured the settings; a later client must mint a new key to issue after the owner configures them.)*

**Settings write**: the same chain (with 403 `step_up_required`), then authority (503) → tenant mismatch (unsealed 409 `write_conflict`) → store missing, another tenant's or not in a write status (404, rolled back) → version mismatch, including a first write when settings exist (sealed 409 `write_conflict`) → the recent-authentication deadline judged again on the database clock after the routine's lock waits (passed: 503, rolled back, as the role-level write does) → 200.

### 10.7 Transaction and lock order

The issue is one update-mode command on the draft (`store.invoice.issue`, contract scope `store`), committed by the existing kernel and store: lease fence → revalidator (`issue_invoices`, the session hold) → ONE definer routine → sealed or rolled-back answer → one audit record → no outbox event → sealed completion → COMMIT. That needs one bounded kernel extension, built and tested as such: an update contract may opt into the two sealed 409s (`issuing_not_configured`, `amount_out_of_range`), minted from the runtime's own words and recorded by the store exactly as `invalid_state` is; `store.invoice.issue` joins the closed list of update kinds whose `expectedTenant` mismatch is the unsealed 409; one closed create kind (the settings write) may answer `not_found` as the rolled-back 404; and the store names the audit subjects of §10.9. No other contract's answers change.

The routine `tmpos_invoice_issue.m7b_invoice_issue` re-derives the caller from the session key and locks in this order: 016's standing hold → session and ledger rows → issuer key → membership and store rows → **draft header FOR UPDATE** → advisory key 530030 SHARED for the role (Invoices and Customers re-read under it with plain, non-locking reads) → **issuing settings FOR SHARE** → **customer FOR SHARE** → **store counter FOR UPDATE** → `clock_timestamp()`. It never waits on a draft, customer, settings or authority row after it holds the counter. The settings and the customer are locked by key only, never filtered by version, so in READ COMMITTED the newest committed row is re-read under the lock and a concurrent write or rename answers `write_conflict`; the role-level re-reads are plain SELECTs at the routine's top level, never inside an exception block; a missing counter while settings exist is a fault that raises, not a refusal. Edit and discard take the same prefix and the header before the key; the save takes the key and the customer FOR KEY SHARE; level writers take the role row then the key EXCLUSIVE; a customer edit takes its Customers role row FOR SHARE then the customer FOR UPDATE and no key; a settings write takes the owner prefix, the store row FOR SHARE, a per-store advisory key EXCLUSIVE (class 530034), then the settings row FOR UPDATE, and never the counter after creating it. No cycle forms: the role-level re-reads take no row lock, so a level writer holding a role row and waiting for the key EXCLUSIVE never blocks an issue that holds the key; the expected waits are an issue behind a queued level writer, and an issue and a customer edit behind each other at the customer row. The settings are locked before the customer (the reverse of §5 B) so that `issuing_not_configured` is decided before any customer row is locked; no writer takes both, so the order cannot cycle.

The settings write is a create-mode command, as the role-level PUT is, because an update-mode command cannot carry `expectedVersion` 0; it decides its version only after the per-store key, so two first writes give one version 1 and one sealed `write_conflict` (never a uniqueness error); its recent-authentication deadline is judged again after the routine (§10.6).

Expected waits, each bounded by the transaction's lock and statement timeouts (1,400 ms and 1,800 ms under the 2,000 ms command deadline): issues of one store serialize from the counter lock to COMMIT; an issue waits behind a queued level writer; an issue and a customer edit wait for each other at the customer row; a settings write waits for issues holding the settings row FOR SHARE and can be delayed while they keep arriving (FOR SHARE lockers do not queue behind a waiting FOR UPDATE).

Within the routine: decide every refusal, then lock the counter, then (after the counter) refuse only number exhaustion; then insert the issued header and lines, advance the counter by one, and move the draft to `issued` at version + 1. *(As built: after the counter lock the routine also re-checks the session's liveness, and a session that fails it is `refused` (rolled back, the 503) before any write, so no number is used; every other refusal precedes the counter.)*

### 10.8 Amounts

The inputs are the draft's own amounts at the reviewed version, in 028's domain: quantities 1..2^53 − 1, unit prices ≥ 0, each line total = quantity × unit price ≤ 2^53 − 1, and S = Σ line totals ≤ 2^53 − 1, all re-checked in the issuing transaction; no negative amount exists. `tax = floor((S × R + 50,000) / 100,000)` in exact integers: BigInt in the runtime, `pg_catalog.div(S::numeric * R + 50000, 100000)` in SQL; `total = S + tax` must be ≤ 2^53 − 1, decided before the counter. Under `none` the snapshot has no rate and no tax and `total = S`. The database re-derives the tax in a CHECK constraint, so a header whose tax differs from the formula cannot be stored by any path.

### 10.9 Storage (migration 034, schema `tmpos_invoice_issue`)

- `store_issuing_settings` (one row per store; version ≥ 1, moves by exactly one; no delete), `store_invoice_counter` (one row per store, created at 0 with the first settings; moves by exactly one; no delete), `issued_invoice` and `issued_invoice_line` (insert only).
- `issued_invoice`: its own UUID; `unique (source_draft_id)` (one invoice per draft, forever, independent of idempotency); `unique (tenant_id, store_id, number)`, `number` 1..2^53 − 1; foreign keys to the source draft's (draft, tenant, store) key, the store and the customer, `ON DELETE RESTRICT`, so no tenant, store, customer or draft deletion can cascade through an issued invoice; text and amount CHECKs as §10.4 and §10.8; `snapshot_version = 1`.
- The draft table: `invoice_draft_status_chk` is replaced under its own name to admit (`draft`, `discarded`, `issued`), and `trg_invoice_draft_terminal` keeps its name, timing, events, comment and `ENABLE ALWAYS` state but is bound to a 034 function whose only addition to 033's rules is `draft → issued` at version + 1 with nothing else changed, admitted only when the draft's issued invoice at the reviewed version exists; `draft → discarded` stays exactly as 033 wrote it. 034 adds no index or other trigger on the draft tables. 034's down restores 033's CHECK text, binding, comment and `ENABLE ALWAYS` state exactly. While 034 is applied, 033's down refuses at its own catalog prerequisites (55000, "033 is not applied") as well as at 034's anchor. *(As built: 034's terminal function raises its own fixed messages for an issued draft and for a refused move to `issued`, and keeps 033's texts for open and discarded drafts. A line insert, update or delete under an issued draft is refused by 033's unchanged line trigger, `trg_invoice_draft_line_terminal`, with its existing wording, "a line of a discarded invoice draft never changes"; the refusal is right and only the word is 033's.)*
- Guards, all `ENABLE ALWAYS`, the deferred one on `issued_invoice`: issued headers and lines refuse every UPDATE, DELETE and TRUNCATE; a header insert requires its source draft still `draft` at the reviewed version with the same tenant, store, customer, currency, line count and subtotal, the settings and the customer at their recorded versions with the recorded values, and the number equal to the counter's value plus one; a line insert requires the draft still `draft`, a position within the line count and a line equal to the draft's line there; a counter update moves it by exactly one and requires an issued invoice of that number; at COMMIT a deferred check requires every line present with the header's line count and sum, the draft `issued` at the reviewed version + 1, and the counter at the number. The tax CHECK tests every branch's NULLs explicitly (a CHECK that evaluates to NULL passes). The routine's write order — header, lines, counter, draft — is the one these guards admit.
- `issued_invoice.issued_by` keeps the issuing actor's internal user id; no read returns it, and the audit record names the same actor.
- `public.audit_event` gains `subject_issued_invoice_id` and `subject_store_id` (nullable, no FK, as the other subjects). The issue's record names the draft, the issued invoice and the customer as subjects at store scope — the owner's instruction records invoice, source-draft, tenant, store and customer subjects, which §5 C's two-subject record (and ISS-17's "both subjects") did not — through one fixed statement used only for that action, the customer taken from the routine's verified answer (the row it locked), never from the request; every other action keeps at most one subject. A settings write's record names the store alone at tenant scope, with a reason code that records the tax mode (`issuing_settings_tax_exclusive_rate` / `issuing_settings_tax_none`) and a fixed reason naming the version and rate — never seller text.
- Each definer read decides its own authority from the session key, with one `denied` for every refusal: the page and the detail a store grant at that store, a read status and Invoices ≥ View with Customers ≥ View; the preview the issue's authority (write status, Invoices ≥ Approve, Customers ≥ View); the settings read the owner rule and a store of the session's tenant. The two writes map every constraint violation to fixed text, as 033's discard does, so no seller, customer or line text reaches a driver message or a log.
- Routines granted to `tmpos_app` only: `m7b_issuing_settings_get`, `m7b_issuing_settings_set`, `m7b_invoice_issue_preview`, `m7b_invoice_issue`, `m7b_issued_invoice_page`, `m7b_issued_invoice_get`; trigger functions, the tax function, the three helpers (`m7b_issue_text_ok`, `m7b_issue_postal_address_ok`, `m7b_issue_store_reader`) and the anchor are granted to nobody. No runtime role holds any table privilege on the new tables. No existing routine or grant is removed: every existing draft routine already refuses a non-open draft, and the runtime's draft reads (033's `page_v2` and `get_v2`) serve open drafts only; 028's owner-only reads, granted to no runtime role, still return an issued draft (IIR-14).
- 034's down refuses, before changing anything, while any settings, counter, issued invoice, issued draft or audit record naming an issued invoice or a store subject exists, and never deletes any of them; otherwise it restores 033's exact catalog. 033's down refuses while 034 is applied.

### 10.10 Residuals kept open

DA-118 widens: a runtime-role holder with a live store session key can call `m7b_invoice_issue` directly and issue — consuming the store's next number under an invoice id of its choosing — without the route's audit record, idempotency completion or HTTP checks. DA-119 widens: a live store-owner key can call `m7b_issuing_settings_set` directly and create a store's first settings and counter, or change the legal issuer or tax mode, with no audit record, reason, recent sign-in or idempotency completion; and since issuing is now decided on the stored levels, a direct level set (021, 026) changes who can issue. Neither is closed by the route being atomic. The runtime login can also insert audit rows through `tmpos_audit_writer` (an existing G-AUDIT class): a forged row naming an issued invoice proves nothing, and one naming a store subject would make 034's down refuse (failing safe). Retention (DA-187, F-5), the §6 privacy duties for issued snapshots, legal review (F-2), void, G-BACKUP/DA-213 for issued rows, DA-60/G-PERF for the new per-store serialization point, and every production gate stay open.

### 10.11 Implementation and evidence map (§7)

Each planned test of §7 against the executed ones (M7B-INVOICES-ISSUE-P1; disposable PostgreSQL and local sockets only). `IIR-` is `tests/db/invoiceIssueRoutine.integration.test.mjs` (IIR-01 to IIR-17), `IIH-` is `tests/db/invoiceIssueHttp.integration.test.mjs` (IIH-01 to IIH-13, the composed tenant entry), `ISH-` is `tests/db/issuingSettingsHttp.integration.test.mjs` (ISH-01 to ISH-09); the unit files are `server/runtime/invoiceIssuing.test.ts` (ISS-R01 to ISS-R13), `server/runtime/issuingSettings.test.ts` (ISS-S01 to ISS-S11) and `server/persistence/postgresInvoiceIssuing.test.ts` (ISS-P01 to ISS-P12, with ISS-P06b and ISS-P11b). This stage built no shop code, so every planned shop half is the next slice (doc 11 §10 is the precedent for the form).

| Planned | Executed (server) | Shop |
|---|---|---|
| ISS-01 | IIR-08 (the authority matrix over real sessions: Invoices ≥ Approve with Customers ≥ View; the stored level decides, never the role name); IIH-01 (the stored levels set through the real `PUT /api/v1/roles/levels`); the permission unit suite | — |
| ISS-02 | IIR-08 (read-only actor, tenant and store refused); IIH-01 | — |
| ISS-03 | IIR-12 (an issue waiting on key 530030 while a level narrowing commits, and at 016's hold while a grant suspension or a session revocation commits, deterministic); IIH-13 (over two tenant entries: a narrowing through the real `PUT /api/v1/roles/levels` holding key 530030 while the issue waits on it, and a session revocation committed while the issue waits at 016's hold — each the 503, rolled back, the lease the only effect, no number used) | — |
| ISS-04 | IIR-08 (a tenant grant only, a grant at another store); IIH-02 (one 404 for a missing, another store's and another tenant's draft and invoice; the same empty page for every unusable source draft); IIR-11 (another store's numbers start at 1) | — |
| ISS-05 | IIR-12 (issue against edit and against discard, both orders); IIH-09 (two tenant entries ordered by an owner's hold of the header) | — |
| ISS-06 | IIR-12 (issue against issue on one draft); IIH-09 (one 201 and one sealed `invalid_state`; one invoice, one audit record, one number) | — |
| ISS-07 | IIR-09 (the decision order; not open is `invalid_state` before configuration and versions); IIH-04 (stale and future draft, settings and customer versions, sealed and replayed; the counter unchanged, no audit); IIH-13 (a customer rename through the real PATCH and a settings write through the real PUT on a second tenant entry, each committed while the issue waits: the sealed `write_conflict`, replayed byte for byte, nothing allocated) | — |
| ISS-08 | IIH-06 (past its retention the same key is a new operation answering `invalid_state`; a new key `invalid_state`; still one invoice) | — |
| ISS-09 | IIR-11 (1 and 2 at a new store; a rolled-back issue leaves the counter unchanged and the next issue takes that number); IIR-12 (two issues of one store serialize at the counter in commit order); IIR-09, IIH-04 (sealed refusals leave the counter unchanged) | — |
| ISS-10 | IIH-07 (the COMMIT lands and its answer is lost: the invoice exists once and replays; the COMMIT is cut: no invoice, the counter unchanged, and the retry takes the same number) | — |
| ISS-11 | IIR-07 (SQL through issued rows and through the CHECK equals BigInt, including 1,000,000,000,050,001 at 99,999 and the 2^53 − 1 refusal); IIH-05; ISS-R (the runtime's BigInt tax and totals) | — |
| ISS-12 | IIR-09, IIR-10, IIH-04, IIH-05 (no settings is the sealed `issuing_not_configured`; an explicit 0 rate issues a tax line of 0) | — |
| ISS-12b | IIR-10, IIH-04, IIH-05 (mode `none`: no rate and no tax, total = subtotal, "No tax calculated"; per store, beside ISS-12, as D-ISS-4 was changed) | — |
| ISS-13 | IIR-13 (UPDATE, DELETE and TRUNCATE of issued headers, lines, settings and counter refused as the table owner, in normal and replica mode; forged inserts refused) | — |
| ISS-14 | IIR-15; IIH-10 (a customer rename through the real PATCH and a settings write through the real PUT leave the issued detail and list byte for byte) | — |
| ISS-15 | IIR-17 (the page and the get denied below Invoices View or without Customers View); IIH-01 (the issued list and detail on the stored levels set through the real PUT: allowed at Invoices View or above with Customers View, the technician default among them while its issue is refused; the 403 at Invoices none or Customers none); IIH-03 (the reads return no actor, phone or email and nothing labelled due, paid or balance) | — |
| ISS-16 | IIH-08 (a fault at the issued-invoice INSERT, the issued-line INSERT, the draft's transition UPDATE, the counter UPDATE, the audit INSERT and the completion: each the 503, the draft open at its version, no invoice or line, the counter unchanged, no audit or completion — the open lease the only effect); IIR-11 (a fault raised after the counter update: nothing written, the number unused) | — |
| ISS-17 | IIH-03; ISH-06 (one audit record per accepted settings write, the store its one subject); the audit-writer unit suite (the issue's draft, issued-invoice and customer subjects, §10.9's three in place of "both subjects") | — |
| ISS-18 | IIH-06 (a replay after the owner narrows the level, and the stored bytes otherwise) | — |
| ISS-19 | — | SID-161 (a lost reply stays unresolved; Check again sends the same key and bytes under the same token, and its replayed 201 is the one invoice), SID-162, SID-163 (the 23-hour window, not extended), SID-164 (Find issued invoice, one sourceDraft read at the attempt's store), SID-165 and SID-166 (detach, and survival across close, store change and remount), SID-175 (a Location that is not the exact path stays unresolved); SIS-12 (a lost browser response after a committed issue: one invoice, one issue audit, one completion; this is browser delivery only, IIH-07 covers COMMIT acknowledgement) |
| ISS-20 | IIR-01 (apply, postcondition, refused re-apply), IIR-02 (the up over existing drafts byte-identical), IIR-03 (a clean down to 033's exact catalog, then re-apply), IIR-04 (the down refused over each kind of issuing data), IIR-05 (033's down refused while 034 is applied), IIR-14 (the old routines answer `invalid_state` on an issued draft); the discard routine suite, threaded through 034 | — |
| ISS-21 | IIR-01 (the ledger exactly 001–034), IIR-06 (the exact surface and grants); the preflight unit suite | — |
| ISS-22 | IIH-11 (the issue's 1 KiB bound, 413 and 415 over real sockets); ISH-07 (the settings write's 8 KiB bound) | — |
| ISS-23 | — | SID-149 (dialog semantics, preview-only content), SID-152 (one press, one POST), SID-154 and SID-155 (refusals announced; Review again), SID-169, SID-170 and SID-174 (late answers and StrictMode), SID-179 (focus returns to View invoice), SID-182 (a preview refusal takes focus), SID-184 (the held press is described), SID-185 (a detached attempt is described); SII-54, SII-64 and SII-65 (focus in the issued dialog and list); SIS-10, SIS-13 and SIS-14 (the confirmation and alerts in the browser); SIS-15 (the confirmation's layout and keyboard at the bounded widths) |
| ISS-24 | the server half: IIH-12, ISH-08 (no log line carries a key, a body, seller, customer or line text or an id) | the client half: SII-25 and SII-60 (no browser storage, address, log or DOM exposure in the settings and the issued sources), SID-167 (the issue's key, body and token stay in memory, never in storage, a URL, a log or the DOM) |
| ISS-25 | ISH-01 to ISH-04, ISH-06 (the owner's writes, the refused roles and stale sign-in, the conflicts, two concurrent first writes, the audit record); ISH-09 (a session revocation committed while the write waits at 016's hold: the 503, rolled back, settings and counter unchanged, no audit or completion, the lease the only effect); ISH-05 (the bodies); IIR-16 (the settings routine) | — |

### 10.12 The shop slice (M7B-INVOICES-ISSUE-P2, code only, not deployed)

The shop calls the seven routes of §10.3 through one typed client, `src/tenant/invoiceIssuingClient.ts` (22 client tests). It builds each request body once (the caller mints the key and keeps it with the body), sends no automatic retry for a mutation, and accepts a 201 only when its `Location` is exactly the invoice's path at the store asked (compared, never followed; the invoice is then read by id). No route, permission, body, answer, limit, server file or migration changed; the server and the 29 tenant route contracts are as §10.1 to §10.11 describe them. Commit `1b20041` holds the client and the owner's settings, `c834b4d` (with the test-only `a7d645d`) the issued list and detail, and `45c9e55` (with the test-only `ae3d2b1`) the issue review, confirmation and recovery. The executed evidence is in §10.11.

Deviations from the stage design that a user can see:
- **Issue time.** The UTC issue time in the issued dialog wraps at its spaces, so at narrow widths it can break onto two lines. The first build kept it on one line; SIS-09 showed it overflowing the dialog at 320 px, and now proves that each cell fits.
- **A detached attempt blocks a new issue.** An unresolved issue attempt that has been detached (for example by a sign-out) still blocks a new issue until it is dismissed, and its card offers only Dismiss (SID-185).
- **Taller reopen dialog.** The reopen dialog reserves the height of its edit, discard and issue rows, so it is taller for every draft whatever each eligibility answer is (SDB-22, SDB-23).
- **Lines table at 1440 px.** SIS-09 requires the lines table to scroll where it overflows and allows it to scroll where it fits. On other fonts it may scroll at 1440 px too; CI's fonts did, and the expectation was made one-sided in `a7d645d`.

Not claimed: payments, amounts due, void, printing, sending, legal-invoice readiness, M7b completion, production readiness or deployment.
