# 11 — Discarding a saved server invoice draft: decision pack and route contract

**Status: PROPOSED / UNADOPTED.** This is a proposal for the owner to decide (stage M7B-INVOICES-D1-P1, documentation only). Nothing in it is implemented, and it adopts no new policy. Each rule is labelled:
- **FIXED** quotes policy already adopted, with a citation to where it is set.
- **EXISTING** describes current code.
- **PROPOSED** marks every new rule.

Until the owner records the decisions in §9 as accepted, discarding a draft stays deferred, exactly as [08](./08-production-gate-and-risk-register.md) DA-186 and [09](./09-roadmap-m0-m9.md) (M7b, "Owner decisions remaining") say, and no stage may implement it. Pushing this document is not approval. Accepting it adopts the decisions but does not deliver the feature.

If the owner accepts the decisions, they become the owner's decision for the discard route. That decision is recorded the way each tenant and store route's has been since D1 ([09](./09-roadmap-m0-m9.md): M7A-CUSTOMERS-P1 and P3, M7B-INVOICES-P1 and P2). It is then written up as ADR-49 in [10](./10-architecture-decision-records.md) as the slice is delivered (§8).

**Source references.** `path:line` references are to commit `8cc0f01` and drift as files change. Migration paths are relative to `server/platform-identity/migrations/`.

## 1. The capability, and why this slice

**The capability (PROPOSED).** An authorized shop operator deliberately removes one saved server invoice draft from the store's active work. A discard issues no invoice, takes no payment and makes no refund, stock movement or shipment. It deletes no customer and no data.

**Why this slice next.** These are reasons for a recommendation, not product research; no usage data is claimed.
- Save, list, reopen and edit of store drafts exist in code (M7B-INVOICES-P1 and P2, not deployed). The current code gives no way to remove a saved draft from active work. How long a draft is kept is a separate, undecided question (DA-187).
- Discard can be bounded without numbering, tax, issuing or payment rules, and without changing the customer or the amounts.
- **The existing structure can take a logical state change.** The draft has a `status` column (`028_m7b_invoice_drafts.up.sql:357`). Its version is checked by the edit and moves only by one (`029_m7b_invoice_draft_edit.up.sql:252-254, 288-291`). The edit routine already answers `invalid_state` for any draft that is not `draft` (`030_m7b_invoice_edit_authority.up.sql:748-752`). The command kernel already seals `write_conflict` and `invalid_state` for every update-mode command (`server/runtime/commandTransaction.ts:528-534`).
- Permanent deletion, privacy erasure and recovery have different consequences, so they stay separate decisions.

**The three options compared.**

| Option | What it is | Practical trade-off |
|---|---|---|
| **A. Logical discard (recommended)** | The draft moves from `draft` to a terminal `discarded` state. Its current row and lines, its id, its version counter and its existing audit records stay. | Ends active work with no data loss and no foreign-key change. It needs one forward migration: a wider status CHECK, a discard routine, and reads that leave discarded drafts out. It does not settle retention (DA-187). |
| B. Permanent deletion | The header and lines are deleted. | Loses the data with no recovery. Audit records would name an id that no longer exists (`subject_invoice_draft_id` has no foreign key, `028_m7b_invoice_drafts.up.sql:321`). It would re-open customer and store deletion, which DA-186's foreign-key consequence currently blocks. It would pre-empt the open retention and DSAR decision (DA-187). It would also amend the design contract in [05](./05-canonical-data-ownership-and-api-db-contracts.md) §4, which sets "soft-delete + status; hard purge is a governed retention job". |
| C. Defer discard; issue first | Build issuing next. | Issuing needs numbering, tax, payment and amount-due rules (DA-186): a much larger set of owner decisions. Unwanted drafts keep accumulating meanwhile. |

**Recommended next implementation slice:** option A, as specified in §5, built in two code checkpoints (§8) once the §9 decisions are recorded.

## 2. Current state (source-grounded; EXISTING)

| Surface | Current behaviour | Source / test | Proposed effect | Unresolved dependency |
|---|---|---|---|---|
| Routes | Six store-template routes: POST and GET on the list, GET `{id}`, GET `eligibility`, PATCH `{id}`, GET `{id}/edit-eligibility`. Only the POST and the PATCH are commands. No command has a literal segment after `{id}`. | `server/runtime/invoiceDrafts.ts:4-14`; closed sets `server/runtime/routes.ts:430-440`; shipping list `server/entry/tenantEntry.ts:118-123` | Two routes are added: POST `{id}/discard` (a command) and GET `{id}/discard-eligibility`. | D-DIS-2 |
| Scope | `{storeId}` only selects which of the actor's own store grants is checked. Authority is the trusted store scope, and a command's path store must equal it. Mutators bind the revalidated store, never the request. | `server/runtime/invoiceDrafts.ts:15-19`; `server/runtime/app.ts:959-968`; `server/persistence/postgresInvoiceDrafts.ts:100-108, 139-149` | Unchanged; discard is store-scoped the same way. | — |
| States | One state, `draft`. The owner set it for the P1 stage (ADR-47), and a DB CHECK pins it. Every reader treats any other status as a fault (503), and the shop's parsers turn a whole page into "unavailable". | `028_m7b_invoice_drafts.up.sql:357`; `server/runtime/invoiceDrafts.ts:173, 573, 604`; `server/persistence/postgresInvoiceDrafts.ts:239, 265`; `src/tenant/invoiceDraftsClient.ts:361, 413` | `discarded` is added as a terminal state. Reads serve `draft` only, so no current reader sees the new status. | D-DIS-1, D-DIS-3 |
| Reads | The page and get routines do not filter on status, and neither does the page's cursor-anchor lookup. A missing draft, another store's and another tenant's are one 404. The page index has no status column. | `028_m7b_invoice_drafts.up.sql:403, 955-978, 1127-1133`; `server/runtime/invoiceDrafts.ts:723-724` | New page and get versions serve `draft` only, and a discarded draft reads as the same 404. The cursor anchor stays status-blind. | D-DIS-3 |
| Version | A draft is created at 1. Each edit steps the version by exactly one, checked against the body's `expectedVersion` after the header lock. 029's trigger keeps the id, tenant, store, creation time and creator fixed and lets the version stay or step by one; it does not pin the status. No earlier contents are kept as history. | `029_m7b_invoice_draft_edit.up.sql:252-254, 267-304`; `030_m7b_invoice_edit_authority.up.sql:754-758` | A discard names `expectedVersion` and steps the version by one. | D-DIS-3 |
| Authority | Three permissions: `view_invoice_drafts` (View); `create_invoice_drafts` (Create, plus Customers View); `edit_invoice_drafts` (Edit, no corequisite). A load-time guard allows store route permissions only at a non-sensitive View, Create or Edit threshold. Ordering: none < view < create < edit < manage < approve < full. The shop's Invoices picker offers none, view, create, edit and full. | `server/platform-identity/m5CanonicalPermissions.ts:225-244`; `src/authorization/permissionFamilies.ts:25-27`; `src/context/accessConfig.ts:31` | A new key, `discard_invoice_drafts`, at Manage, with the guard widened to admit it. | D-DIS-2 |
| Role defaults | `store_owner` is Full and never stored; `manager` Full; `technician` View; `sales_staff` Create. The owner edits the three non-owner levels per tenant. A browser-only custom role has no server authority. | `server/platform-identity/permissionCatalog.ts:492-519`; `026_m5_invoice_role_levels.up.sql:296-297`; `server/runtime/invoiceDrafts.ts:22-24` | With the defaults, `store_owner` and `manager` may discard: the same set that may edit. | D-DIS-2 |
| Creator | `created_by` is written once and frozen. No authority decision reads it, and no read returns it. | `028_m7b_invoice_drafts.up.sql:351, 368-369`; `029_m7b_invoice_draft_edit.up.sql:284` | Unchanged: authority covers any draft in the trusted store, as the edit's does. | D-DIS-2 |
| Customer data | Reads return `customerId` only. The edit needs no Customers level; DA-203 records its existence signal. | `server/runtime/invoiceDrafts.ts:69-70, 93-95` | Discard takes no customer input and returns no customer data. | — |
| Idempotency | Commands require an `Idempotency-Key`. The fingerprint binds the method, template, actor, tenant, store, exact body bytes and target. For the edit the target is the draft id, read as the path's final segment. A replay is served after the chain's current authorization. A lost COMMIT acknowledgement is a 503 that makes no claim about the outcome. | `server/runtime/idempotency.ts:389-394`; `server/runtime/app.ts:964-968, 1004-1018`; `server/runtime/routes.ts:454-465`; `server/runtime/commandTransaction.ts:87-93` | Reused. The chain must also learn to read the target before a command's literal suffix (§5 B). | — |
| Sealing | For update mode the kernel seals `write_conflict` and `invalid_state` (409) and an `unchanged` 200. `not_found` is an unsealed 404. An unsealed 409 for a tenant mismatch exists only for the one kind `store.invoice_draft.update`; any other update kind's tenant mismatch is the 503. | `server/runtime/commandTransaction.ts:528-534`; `server/runtime/app.ts:513-519, 1058-1092`; `server/persistence/postgresTransactionalStore.ts:265-270, 684-735` | Discard reuses the update-mode sealing. The precondition kind becomes a closed set of two. | — |
| Audit, outbox | One audit record per committed change; the draft is the subject automatically for an `invoice_draft` aggregate in create or update mode. Events: `invoice_draft.created` and `invoice_draft.updated` v1. No outbox consumer exists. The request log line carries the route class, status and one reason word, not the command kind. | `server/persistence/postgresTransactionalStore.ts:596-623`; `server/runtime/invoiceDrafts.ts:187-203`; `server/runtime/outbox.ts:62-72`; `server/runtime/app.ts:744-758` | One audit record (`store.invoice_draft.discard`). No outbox event (D-DIS-4). | D-DIS-4 |
| Shop | The Server drafts section offers List, reopen (read-only), New and Edit. New and Edit appear only on the server's eligibility answers. An edit's unknown outcome is held only while its editor is open (DA-208). Only "Check again" re-sends it, with the same key and bytes, within 23 hours (the server keeps a key for 24). Its dialogs open one at a time. "Discard" already names local-only actions ("Discard my changes"). The section's `DialogFrame` is a plain `role="dialog"` with no confirmation variant; other screens have confirmation dialogs (`src/backend-control-plane/console/TenantManagementPage.tsx:116, 168`; `src/components/Inventory.tsx:2184-2188`). | `src/tenant/ServerInvoiceDrafts.tsx:52-53, 116-121, 468-572, 1953-1967, 2323-2344, 2491`; `src/tenant/invoiceDraftsClient.ts:494-509, 635` | A "Discard draft…" action in the reopen dialog, behind its own eligibility and a confirmation dialog. | D-DIS-4, D-DIS-5 |
| Local invoices | The browser-only Invoices screen is separate. Server drafts never enter its list, counters or storage. | `src/components/Invoices.tsx:835`; `src/tenant/ServerInvoiceDrafts.tsx:5-6`; tests INV-13, INV-16 and INV-17 (`src/components/Invoices.serverCustomer.test.tsx`), SID-27 (`src/tenant/ServerInvoiceDrafts.test.tsx`) | Unchanged. | — |

## 3. Fixed constraints

These are **FIXED**. They are not owner choices in this pack.
1. **A draft is owned by a real store within a tenant, and the trusted store scope is the only authority.** The `{storeId}` segment selects a grant; it never grants anything (ADR-47; `server/runtime/invoiceDrafts.ts:15-19`). A session's key is never read as a business store id.
2. **Every new invoice operation decides on the stored Invoices level on the server, and adds its own HTTP witness** (DA-183, DA-184).
3. **Only an explicit user action sends a mutation.** Nothing is re-sent on focus, reload, renewal or navigation, and an unknown outcome is re-sent only by an explicit "Check again" with the same key and bytes (ADR-47 and ADR-48; [05](./05-canonical-data-ownership-and-api-db-contracts.md) §2, "Invoices — editing a saved draft").
4. **Closing an unsaved form is not a server discard.** "Cancel of an unsent editor drops local changes only; it does not discard the draft" ([05](./05-canonical-data-ownership-and-api-db-contracts.md) §2). The New dialog's Cancel only closes it (`src/tenant/ServerInvoiceDrafts.tsx:2268`).
5. **Nothing else about the draft changes.** Amounts stay USD in integer cents. Customer references, customer ownership and the customer-read policy are unchanged (ADR-47, ADR-48).
6. **Foreign keys do not cascade.** A store or customer holding drafts cannot be deleted, and a store holding drafts cannot move tenant (DA-186). A logical discard keeps the rows, so this consequence stands.
7. **Retention and privacy are undecided** (DA-187). Nothing here removes, redacts or ages out data, and nothing here adopts a retention period.
8. **Command semantics come from the existing kernel.**
   - One transaction: fence, revalidation, one routine, then (for a change) audit, completion and COMMIT.
   - A sealed refusal writes only its completion; replays write nothing.
   - A lost COMMIT acknowledgement is an unknown outcome.
   - A client closing or cancelling a request is not proof of a rollback.
   (ADR-17; `server/runtime/commandTransaction.ts:87-93`; `server/persistence/postgresTransactionalStore.ts:666-754`.)
9. **Protected bytes and rollbacks.**
   - Migrations 001–032 and the four frozen operator and executor paths stay byte-identical; each stage records this in its evidence (e.g. [10](./10-architecture-decision-records.md) ADR-37 and ADR-40).
   - A rollback never silently discards data or resets a version: deleting a draft or resetting its version "is a deliberate owner decision, never a rollback's side effect" (`029_m7b_invoice_draft_edit.down.sql:15-20`).

## 4. Owner decisions

These are the only choices this slice needs. Each recommendation is **PROPOSED / UNADOPTED**. D-DIS-1 to D-DIS-5 number this pack's decisions. Accepted together, they are the owner's decision for the discard route; they are not the repository's D2, D3 or D4.

| # | Decision | Recommended (PROPOSED) | Meaningful alternative | Consequence of the recommendation | Source constraint |
|---|---|---|---|---|---|
| **D-DIS-1** | What discard means | **A logical, terminal discard of a saved draft.** `draft` → `discarded`. The current row and lines, id, version counter and audit records stay; no row or customer is deleted. There is no undo or restore in this slice. Once the slice lands, a draft in any state other than `draft` is refused with `invalid_state`: that means `discarded`, and later any new state, such as an issued one. | (a) Permanent deletion (option B, §1); this would also amend [05](./05-canonical-data-ownership-and-api-db-contracts.md) §4. (b) Discard with a restore in the same slice. | Rows accumulate until a retention decision (DA-187). An operator who discards by mistake cannot restore it in the shop. The row stays in the database, so a later restore remains possible, though it would need its own routine and trigger change. Accepting this ends the deferral recorded by ADR-48 and widens the status set fixed for P1 by ADR-47 (§8 amends both). | ADR-47, ADR-48; 028's status CHECK; [05](./05-canonical-data-ownership-and-api-db-contracts.md) §4; DA-186, DA-187 |
| **D-DIS-2** | Who may discard which draft | **A new store permission, `discard_invoice_drafts`, at Invoices Manage or above, on the store grant's role.** It covers any draft in the trusted store (no creator rule). It has no Customers corequisite. Like the edit, it is refused when the actor, tenant or store is read-only. It needs no recent sign-in. With the defaults: `store_owner` and `manager`. With today's picker, the owner separates the two actions per role: Edit lets a role edit but not discard; Full lets it do both. | (a) The same new key at Edit: no guard change, but edit and discard can then never be separated for a role. (b) Reuse `edit_invoice_drafts`: one fewer key, and the same coupling. | Discard is more than an edit: it removes the draft from every product read and ends editing for good in this slice, so it sits one step above Edit. The defaults are unchanged. The only extra code is widening the load-time guard to admit Manage for this key. Adding Manage to the picker is optional. A role the owner set to exactly Edit can edit but not discard. | `server/platform-identity/m5CanonicalPermissions.ts:225-244`; `src/context/accessConfig.ts:31`; `026_m5_invoice_role_levels.up.sql:297` (the setter accepts `manage`). A store permission cannot require a recent sign-in today: `server/composition/tenantAuthorization.ts:344-345`, `m5CanonicalPermissions.ts:237`. |
| **D-DIS-3** | Visibility, repetition and competing edits | **Discarded drafts leave the list and the direct read**; the read answers the same 404 as a missing draft. **`expectedVersion` is required**; a stale one is the sealed 409 `write_conflict` (EXISTING kernel behaviour). **A discard steps the version by one.** A new key against an already-discarded draft is the sealed 409 `invalid_state`; there is no no-op success. A same-key retry replays the stored answer (EXISTING). Edit and discard race on the header lock: if the edit wins, the discard gets `write_conflict`; if the discard wins, the edit gets `invalid_state`. **Disclosure, accepted:** `invalid_state` tells a user who holds discard authority at that store that this id was once a draft there. The edit already tells holders of Edit the same (`030…:748-752`). | (a) Keep discarded drafts listable in a "Discarded" view; this needs a status filter and widened validators in the routines, runtime and shop. (b) An idempotent no-op: a new discard of a discarded draft answers 200 `changed: false`, sealed with no audit record, which hides that someone else discarded it first. (c) Answer 404 for a discarded draft on the discard route too, hiding past existence; the edit would still answer `invalid_state`. (d) No `expectedVersion`: simpler, but it can discard an edit the operator never saw. | Nothing the operator has not seen is discarded. A second operator learns the draft is no longer open. A discarded draft cannot be viewed in the product; its audit record stays. | `030_m7b_invoice_edit_authority.up.sql:748-758` (state checked before version); `commandTransaction.ts:528-534`; reads `028…:955-978, 1127-1133` |
| **D-DIS-4** | Confirmation, reason, audit and event | **A confirmation dialog naming the exact draft**: customer name or fallback, store, created time, line count, subtotal and version. **No reason field.** **One audit record per discard**: action `store.invoice_draft.discard`, the draft as subject, metadata `{}`. **No outbox event.** | (a) A closed reason code (a short fixed list, no free text): more context in the audit record, but a list the owner must define. (b) A free-text reason, as tenant suspension has: a new personal-data channel needing bounds and DA-187's retention decision. (c) Emit `invoice_draft.discarded` v1 `{ storeId }`, matching the convention of the two existing draft events. It is not required: no consumer exists, and it would promise no replay or retention. Adding it later would not cover discards made before then. | The audit record answers who discarded which draft, and when, without copying lines or customer. [05](./05-canonical-data-ownership-and-api-db-contracts.md)'s per-domain contract asks for an event only "where cross-domain or provider effects occur", and a discard has none. | `postgresTransactionalStore.ts:596-623`; `outbox.ts:62-72`; [05](./05-canonical-data-ownership-and-api-db-contracts.md) §2 per-domain contract; DA-187 |
| **D-DIS-5** | Unknown outcome | **An unresolved attempt is held only while its confirmation dialog stays open**, the same bounded policy as the edit's (DA-208). "Check again" re-sends the same key and bytes within 23 hours, because the server keeps a key for 24 (EXISTING policy). Closing the dialog stops the tracking, and the close control says so. Several events drop the attempt: a session end, a sign-out, a user change, a store change, or a new session generation, which a renewed session token starts. A late answer changes nothing. **DA-208 is not a prerequisite.** | Hold the attempt in a session-scoped store that survives closing the dialog (DA-208's wider option). | Low risk: a discard cannot create a duplicate. A re-send under a new key, after an unknown outcome whose first send landed, is answered `invalid_state`. The operator learns the true outcome only from "Check again" or from re-reading the list. | `ServerInvoiceDrafts.tsx:52-53, 254, 1445-1478`; `src/tenant/ServerCustomerDirectory.tsx:142`; DA-208 |

**Not owner choices (FIXED, §3):** the store scope and its source (§3.1); a decision on the stored server Invoices level, with an HTTP witness (§3.2); sending only on explicit action (§3.3); Cancel of an unsaved form staying local (§3.4); amounts and customer references unchanged (§3.5); no cascade (§3.6); retention left open, so logical discard is not erasure and keeps all personal data (§3.7).

**Technical recommendations, not owner policy** (detailed in §5):
- **The proposed route is `POST …/invoice-drafts/{id}/discard`.**
  - Not `DELETE`: this repository's route contract registers no request body on DELETE (`server/runtime/routes.ts:27-28, 400`), and nothing processes If-Match, so the preconditions could not travel.
  - Not `{id}:discard`: a literal segment allows only `[a-z0-9_-]` (`routes.ts:404`).
  - Not the edit's PATCH: that would put a second command under one template, permission and fingerprint.
- **Alternative:** a status `PATCH …/{id}/status`, after the tenant-status precedent (`server/runtime/tenantStatus.ts:4-17`), if more transitions are expected. It needs the same chain change as `/discard` (§5 B).

## 5. Conditional implementation contract (applies only once §9 is accepted)

Everything here is **PROPOSED** and written for the §4 recommendations. Text marked **EXISTING** restates current behaviour. If the owner picks an alternative, the affected parts change as §4 says.

### A. State transitions
- **States.** `draft` (EXISTING) and `discarded` (new, terminal).
- **Allowed transition.** Only `draft` → `discarded`, at `expectedVersion`, stepping the version to `expectedVersion + 1`. Nothing else changes: customer, lines, line count, subtotal, currency, creation time and creator all stay.
- **Terminal.** A discarded draft admits no edit, no second discard, no return to `draft`, and no change to its lines.
- **Order of decisions.** This follows the edit's routine (`030_m7b_invoice_edit_authority.up.sql:553-758`):
  1. Caller derivation.
  2. The Invoices level, read unlocked as an early pre-check; below Manage → `refused`.
  3. `tenant_mismatch`.
  4. The header `FOR UPDATE`: a missing or foreign draft → `not_found`, decided before the guard key. Then the session's clock is checked again.
  5. For a role whose level can be configured: the guard key SHARED, the clock again, and the level decided again; below Manage → `refused`.
  6. Status is not `draft` → `invalid_state`.
  7. Version differs → `conflict`.
  8. Otherwise → `applied`.
  The routine's outcome words map to HTTP answers in §5 B.
- **Competing orderings.**
  - A discard and an edit of one draft serialize on the header's `FOR UPDATE`.
    - The edit commits first (version v → v+1): a discard naming v gets `conflict`.
    - The discard commits first: the edit gets `invalid_state` (EXISTING, 030's own state check).
  - Two discards under different keys: the second waits on the header, then gets `invalid_state`.
- **No mutation outside the draft's trusted scope.** The routine locks and writes only the header row matched by id, tenant and store, all derived from the session and the revalidated context.

### B. Route
- **Method and path.** `POST /api/v1/stores/{storeId}/invoice-drafts/{id}/discard` is a store template with a literal suffix, like `/edit-eligibility`. It is added to `STORE_TEMPLATED_ROUTES` and `IDEMPOTENT_STORE_TEMPLATED_ROUTES` (`routes.ts:430-440`), to the tenant inventory and to `TENANT_SHIPPING_ROUTES`.
- **New chain code: target derivation.**
  - It is the first command with a segment after `{id}`. Today the chain reads a command's target only as the path's final segment (`pathIdOf`, `app.ts:964-968`; `routes.ts:454-457`), so every discard would be refused with 400 `command_target_invalid`.
  - The chain must read the id before the matched route's own declared suffix (`pathIdBeforeSuffixOf`, `routes.ts:463-465`). The suffix is chosen by the matched route, never by the request.
  - The check runs, as now, after authorization and the store-scope check and before the body is read or a key is acquired.
  - A unit pin proves two things: a mismatched suffix is still the 400, and the save's and the edit's fingerprints stay byte-identical.
- **Eligibility.** `GET /api/v1/stores/{storeId}/invoice-drafts/{id}/discard-eligibility` mirrors the edit's eligibility exactly. It is session-bound, has no body and no query, and decides by the discard's own requirement object. It is target-blind: it reads no draft, answers the same for every well-formed id, and answers 200 `{ "eligibility": "allowed" }` or one of the chain's refusals.
- **Boundary.**
  - A session route of the tenant boundary, with `trustedContext: 'required'`, `recentAuth: 'none'` and `idempotency: 'required'`.
  - Requirement `{ scope: 'store', permission: 'discard_invoice_drafts' }`.
  - The request security that every unsafe tenant command carries: Origin, Sec-Fetch-Site, `X-TMPOS-CSRF` and the session CSRF.
- **Revalidation in the transaction (EXISTING).** The tenant store re-holds the presenting session and the actor's standing, re-selects the grant at the trusted store and decides the level again. The routine then derives the caller from the session key and decides once more, under the guard key.
- **Body.**
  - Exactly `{ "expectedTenant": <uuid>, "expectedVersion": <int> }`, with no other key.
  - `expectedTenant` is the tenant that `GET /api/v1/stores` answered for the store, as a canonical lowercase uuid. It is a precondition, never authority.
  - `expectedVersion` is the version the reopen read reported: a safe integer from 1 to 2^53 − 2.
  - A small fixed body bound applies (proposed: 1 KiB).
  - The path's draft id must match the outbox's aggregate-id shape, as for the edit (`invoiceDrafts.ts:98-100`).
  - A query string is ignored, as it is for the save and the edit; the command path never reads it.
- **Response.** 200 `{ "draftId": <id>, "version": expectedVersion + 1, "status": "discarded" }`, sealed. A command may answer only 200 or 201 (`commandTransaction.ts:122`).

**Status and error mapping.** Each row's answer and its key or lease effect:

| Answer | Status and body | Key and lease |
|---|---|---|
| Discarded | 200 as above | sealed |
| Stale version | 409 `{ "error": "write_conflict" }` | sealed |
| Not `draft` (already discarded, or any later state) | 409 `{ "error": "invalid_state" }` | sealed |
| Missing draft, or another store's or tenant's | 404 `not_found`; only the per-request `requestId` differs | not sealed; rolled back, the lease waits out its time |
| `expectedTenant` mismatch | 409 `{ "error": "write_conflict", "requestId" }`, the chain's shape | not sealed; rolled back, the lease waits out its time |
| Revalidation or routine refusal, lease lost | 503 `service_unavailable` | not sealed; nothing committed |
| COMMIT sent, acknowledgement lost | 503 `service_unavailable` | unknown: a same-key retry replays the completion if it committed; otherwise it gets 409 `request_in_progress` until the lease expires, then re-plans |
| A body the contract refuses (wrong or missing fields) | 400 `invalid_request` | after the key is taken; nothing committed, the lease waits out its time |
| Malformed id or store segment, malformed JSON, over the bound (413), wrong content type (415) | 400 / 413 / 415 | before any key is read; nothing recorded |
| Session invalid | 401 | before the key |
| Denied role; foreign or unknown store; session-CSRF mismatch; read-only actor, tenant or store | 403 `forbidden` | before the key |
| Key reused for another body or draft | 422 `idempotency_key_reused` | — |
| Same key in progress | 409 `request_in_progress` | — |
| Request limit | 429 with `Retry-After` | — |

- **Non-disclosure.**
  - A missing draft, another store's and another tenant's give one 404, with one body shape and one logged reason.
  - The eligibility route never reads a draft.
  - The one accepted exception is `invalid_state` (D-DIS-3).

### C. Atomicity and idempotency
- **One transaction (EXISTING kernel).** It always runs:
  1. the lease fence;
  2. revalidation;
  3. one call into the discard routine.
  Then:
  - for `applied`, it writes the state change, one audit record and the sealed completion, then COMMIT, and only then sends the 200;
  - for a sealed `write_conflict` or `invalid_state`, it writes only the sealed completion;
  - every unsealed outcome rolls back every write.
- **Authority held to the end.** For every role whose level can be configured, the routine takes the header `FOR UPDATE`, then the guard key `pg_advisory_xact_lock_shared(530030, hashtext(tenant || '/' || role))`, then decides the Invoices level. `store_owner` is Full and takes no key, as in 030 (`030_m7b_invoice_edit_authority.up.sql:25-35, 68`). So each sealed answer (`applied`, `invalid_state`, `conflict`) is decided with the level held until the transaction ends. Writers of the role's Invoices level (030's trigger) and of its Customers level (032's trigger) take that key EXCLUSIVE. A discard therefore also delays the owner's Customers-level writes for that role, which affects availability only.
- **No no-op.** D-DIS-3 proposes none. If the owner chooses alternative (b), the no-op is sealed inside the same protected transaction, with no business or audit write, as the edit's `unchanged` is.
- **Key binding.** The fingerprint binds the method, the template, the trusted tenant, store and actor, the exact body bytes, and the draft id as the target (EXISTING, `app.ts:1004-1014`). The id is read before the `/discard` suffix (new, §5 B). One key used at two drafts, or with another body, is the 422 and never a replay. A create or edit key reused on the discard route is a 422, because the method or template differs.
- **Replay (EXISTING).** A completed key's stored answer is sent byte for byte with `Idempotent-Replayed: true`. This happens after the chain's current authentication, CSRF check and authorization (`app.ts:1018`), so an actor who has since lost discard authority gets 403 or 401, not the replay. A replay runs no routine and takes no lock.
- **What is sealed.** The existing update-mode sealed set, minus `unchanged`, which a discard never produces: success, `write_conflict` and `invalid_state` (`postgresTransactionalStore.ts:684-735`). The single-kind precondition literal becomes a closed set of the edit's and the discard's kinds, in `app.ts:519` and `postgresTransactionalStore.ts:270`, and its pin test (`server/persistence/postgresTransactionalStore.test.ts`) is extended. Without that change, a discard's tenant mismatch would be the 503.
- **Lost COMMIT acknowledgement (EXISTING).** The answer is a 503 that makes no claim about whether anything committed; the table above gives the retry behaviour. A client closing or cancelling a request is never treated as a rollback.

### D. Database and privileges
- **Number.** One forward migration, numbered from the chain at the time. This stage creates none.
- **Apply refusals.** The up refuses in each of these cases, as 032's does (`032_m7b_invoice_create_customers_authority.up.sql:217-252`):
  - 001–032 are not all applied with their expected catalog (028's tables, 030's guard and trigger, 032's routines);
  - any of its own objects already exists;
  - the runtime roles are missing.
  It changes no existing row.
- **Schema and privileges.**
  - The migration works in a new schema of its own, so that the exact routine inventories pinned by 029's and 032's down migrations stay true (`029_m7b_invoice_draft_edit.down.sql:147`; `032_m7b_invoice_create_customers_authority.down.sql:137-139`).
  - PUBLIC privileges on the schema are revoked, and `tmpos_app` gains `USAGE` on it, as 030 granted for its schema.
  - Every routine is owned by the applying principal, as the existing ones are. `EXECUTE` is revoked from everyone, then granted to `tmpos_app` only, on the exact signatures of the discard routine and the two new reads.
  - Trigger functions are granted to nobody.
- **Status CHECK.** `invoice_draft_status_chk` is replaced under its own name with `status in ('draft', 'discarded')`, as 029 replaced the version check.
- **Terminal state at the database.** These triggers have their own functions, are ENABLE ALWAYS as 029's is, and leave 029's function unchanged.
  - On the header, BEFORE UPDATE: a status change is allowed only from `draft` to `discarded`, with the version stepping by exactly one and no other column changing. A `discarded` header admits no update at all.
  - On the lines, BEFORE INSERT, UPDATE or DELETE (required): any change to a line whose header is `discarded` is refused.
- **The discard routine.**
  - `SECURITY DEFINER`, with `search_path = pg_catalog, pg_temp`, `row_security = off` and fixed SQL. It runs under READ COMMITTED only.
  - It locks and decides in the §5 A order:
    1. the caller derivation (016's standing hold; the session and ledger `FOR SHARE`; the issuer `FOR SHARE`; the store `FOR SHARE`);
    2. the unlocked level pre-check;
    3. the header `FOR UPDATE` by id, tenant and store, never by version;
    4. the guard key SHARED, in the routine's outermost block and never inside `BEGIN … EXCEPTION`;
    5. the Invoices level by plain read (the stored level, else the catalog default);
    6. the state, then the version;
    7. one header UPDATE;
    8. a verification read.
  - It takes no customer lock and no role or version row, and it never materializes a default level row.
  - It writes no audit or idempotency row; the runtime writes those.
- **Lock order across transactions.** No path takes a lock that an earlier step of another path holds, in reverse.

  | Path | Order |
  |---|---|
  | Command revalidation (EXISTING) | 016's hold, then the session and standing, then the levels by plain read, all before the routine |
  | Discard and edit | caller rows, then the header `FOR UPDATE`, then the key SHARED; never a role or version row after the key |
  | Create (032) | caller rows, then the key SHARED; no header lock |
  | Level writers (026 Invoices setter, 021 Customers setter) | role row `FOR UPDATE`, then the version row `FOR UPDATE`, then the level UPDATE, whose trigger takes the key EXCLUSIVE; never a draft header (`030_m7b_invoice_edit_authority.up.sql:97-130`; the Customers writers through 032's trigger, `032_m7b_invoice_create_customers_authority.up.sql:28-41`) |
  | Revocations | the session, grant and standing rows behind 016's hold, which the routine takes first |
  | Apply and down | `ACCESS EXCLUSIVE` on the established seven tables in their order, before any check (`030_m7b_invoice_edit_authority.up.sql:207-221`) |

- **Reads.**
  - New page and get versions serve `status = 'draft'` only. The page's cursor-anchor lookup stays status-blind, so a cursor naming a just-discarded draft still pages.
  - A partial index `(tenant_id, store_id, created_at desc, draft_id desc) WHERE status = 'draft'` keeps the list's cost independent of accumulated discarded rows. It is built in the maintenance window.
  - `EXECUTE` on 028's two read routines is revoked in the same migration, as 031 and 032 revoked their predecessors, and the runtime switches to the new names.
  - The runtime and the migration move together. The startup preflight's `REQUIRED_MIGRATIONS` gains the migration. Its `APPROVED_ROLE_GRANTS`, an exact set, gains the new routines' entries and loses the two 028 read entries (`server/persistence/postgresStartupPreflight.ts:130-131, 364`). This build refuses the previous schema, and the previous build refuses this one.
- **Rollback.**
  - The down takes the same table locks before any check. It refuses while any draft is not `draft`, and it refuses on catalog shape as 030–032 do. It restores the CHECK, the old read grants and the previous inventory. Newer migrations roll back first.
  - After the first real discard, this rollback is one-way in practice. A rollback would need each discarded draft deleted or returned to `draft`, and either is an owner decision on data, never a rollback step (§3.9). Every discard also steps a version above 1, which 029's down already refuses.

### E. Shop
- **Where.**
  - The reopen dialog gains "Discard draft…" beside "Edit draft". It is shown only when the discard eligibility, asked once per reopen at this draft's path, answers `allowed` for this session, store, draft and generation, and only at a writable store.
  - While the eligibility is asked, and when it is denied, the action is simply absent and nothing extra is announced; the edit's status line stays the dialog's only announced eligibility answer.
  - When the eligibility is unavailable or rate-limited, one "Try again" is shown for it, described (non-live `aria-describedby`) by "The server could not be asked right now whether this draft can be discarded." or by the wait text.
  - The action is never offered inside the editor, beside the local "Discard my changes" (`ServerInvoiceDrafts.tsx:2491`), or for an unsaved New draft.
- **The confirmation dialog.**
  - It is the one exception to the section's "one dialog at a time" rule (`ServerInvoiceDrafts.tsx:116-121`), which is amended. It is a second `DialogFrame`, stacked over the reopen dialog, which is inert beneath it. New draft and the editor cannot open while it is up.
  - `DialogFrame` gains two optional props, `role` (default `dialog`; `alertdialog` here) and `describedBy`. Its other dialogs are unchanged.
  - The title "Discard this draft?" is the accessible name. The accessible description is one element and never the buttons. It holds "It leaves the store's open drafts. It is not deleted, and it cannot be reopened here." and one line naming the draft: customer name or fallback, store, created time, line count, subtotal and version, all from the reopen read.
- **Before anything is sent.** Initial focus is on "Keep draft". "Keep draft" and Escape close the confirmation, send nothing, and return focus to "Discard draft…" in the unchanged reopen dialog.
- **From the press of "Discard draft".**
  - One POST is sent under a new key, and the exact body bytes are kept with the attempt.
  - "Discard draft" is removed, so this dialog never mints a second key.
  - "Keep draft" is relabelled "Close". Its accessible description (as the editor's Cancel has) is "Closing stops tracking this discard; the server may have discarded the draft anyway." Escape does the same as Close. No interrupting prompt is added.
  - While the dialog is locked, focus that the lock takes away is recovered inside it, using `DialogFrame`'s existing recovery.
- **Success.**
  - It happens only after a validated 200: the same draft id, version `expectedVersion + 1`, status `discarded`.
  - Both dialogs close, "Draft discarded." is set in the section's existing notice region (`drafts-notice`, `role="status"`, outside the dialogs, `ServerInvoiceDrafts.tsx:1674`), as the create's saved notice is (`:1549`), and focus is put on the section heading explicitly.
  - Page one is then re-read; the re-read does not clear the notice.
- **Refusals.** Each answer is told apart by status and body shape, as the edit's client does (`src/tenant/invoiceDraftsClient.ts:695-719`).
  - **Stale version** (sealed 409 `write_conflict`): the confirmation closes and the reopen dialog reads the draft again once. It says, in its own `role="alert"` line, "Not discarded: this draft changed since you opened it. Review it, then discard again if you still want to." Focus goes to "Discard draft…" if it is still offered, else to the reopen dialog's Close. A new confirmation and a new key need a new press.
  - **Tenant changed** (the chain's unsealed 409 `write_conflict`, `{ error, requestId }`): the attempt ends with "Not discarded: this store isn't part of the tenant this draft was for any more. Choose the store again.", as the edit's `tenant-changed` does (`ServerInvoiceDrafts.tsx:214, 279`).
  - **`invalid_state` and 404:** both dialogs close and page one is re-read. "Not discarded: this draft is no longer open." or "This draft is no longer available." is set in `drafts-notice`, and focus goes to the heading.
  - **403:** after one fresh session check (EXISTING), the confirmation closes and "Discard draft…" is removed. The refusal is said in a `role="alert"` line in the reopen dialog, and focus goes to its Close.
  - **401:** the existing session-ended path. **429:** the existing wait. **422 `idempotency_key_reused`:** the attempt ends, as the edit's `key-reused` does.
- **Unknown outcome** (503, no answer, or 409 `request_in_progress`).
  - The attempt stays unresolved in the confirmation.
  - "Check again" re-sends the same key and bytes. It does so only in the same generation and under the same session token, never during a wait, and only within 23 hours.
  - Closing an unresolved confirmation also closes the reopen dialog and re-reads page one. No Edit or Discard stays offered for a draft that may no longer be open.
- **Session and scope.**
  - A session end, sign-out, user change, store change or new generation (a renewed token starts one, EXISTING) drops the attempt and both dialogs synchronously. A late answer changes nothing.
  - After Reconnect the list is re-read, and a discarded draft is no longer in it.
- **Compatibility.** The local Invoices screen and the section's props (`uid`, `canViewCustomers`, `handoff`, `onHandoffTaken`) are unchanged. The role-levels panel's description (`src/tenant/ServerCustomerLevels.tsx:160`) gains "and, at Manage or above, discard" (Full, in today's picker).

### F. Observability and privacy
- **Logs (EXISTING request log, `app.ts:744-758`).** Each answer logs its route class, request id, status and one reason word. The command kind is in the audit record's action, not the log line.
- **No sensitive content.** No log line or notice carries line descriptions, customer details, session tokens, CSRF tokens or idempotency keys. The key is only ever stored as a digest (`idempotency.ts:15, 389`).
- **Audit.** The audit record identifies the draft by `subject_invoice_draft_id`, with the actor, tenant, store and time. It copies no lines and no customer.
- **No retention or deletion claim.** The shop and the docs never say a discarded draft is deleted or erased, and no retention period is implied.

## 6. Dependencies and explicit deferrals

| Item | Required for this slice | Preserved constraint | Later capability | Pre-launch only |
|---|---|---|---|---|
| DA-186 (lifecycle and financial rules) | Only its discard part, decided by this pack | The foreign-key consequences stand; the status set stays closed | Delete, issue, number, tax, discounts, shipping, payment, fractional quantities, catalog prices, store moves and deletions | — |
| DA-187 (retention, privacy) | No: logical discard removes nothing | Nothing is removed, redacted or aged out, and no retention period is adopted | Retention period, purge job, DSAR for drafts and audit subjects | Owner decision before live use |
| DA-176 (legacy customer mapping) | No: discard changes no customer | Customer references unchanged | Legacy mapping | — |
| DA-188 (store provisioning and grants) | No: the same store-grant selection as the edit | No tenant-to-store inheritance | Grant management | — |
| DA-189, DA-87 Option B (store-scope customer reads) | No: discard takes no customer input | The shop shows a customer name only if the existing Customers read gave it | Store-scope customer reads | — |
| DA-203 (Edit without Customers View naming a customer) | No: discard supplies no customer id | Unchanged | — | — |
| DA-208 (an unknown outcome outliving the editor) | No: the same bounded, dialog-scoped policy | The attempt ends with its dialog | A persisted hold, if wanted | — |
| DA-183, DA-184 | Yes: decide on the stored level and add the HTTP witness | — | Every later Invoices operation | — |
| G-PERF, G-OBSERVE, a performance host, availability targets (DA-60, DA-52) | No | The M6R-PERF and M6RS-07 tests, G-PERF's status and R3's evidence distinctions are unchanged | — | M8 launch decisions |

Outside this slice unless an invariant forces it: permanent deletion, restore, a "Discarded" view, issuing and numbering, tax, discounts, shipping, payments, fractional quantities, catalog price authority, store moves or deletion, and legacy import. No gate closes because of this pack or of its implementation alone. G-IAM, G-PERSIST, G-AUDIT, G-IDEMPOT and G-PRIVACY stay `OPEN`.

## 7. Planned acceptance tests (PLANNED; none executed)

**Harnesses to reuse (EXISTING):**
- Unit: the edit's chain harness, `withChain`, in `server/runtime/invoiceDraftEdit.test.ts`.
- Adapter: the fake-SQL recorder (`recorder`) in `server/persistence/postgresInvoiceDrafts.test.ts`.
- Routine, edit suite: `holding`, `blockedBy`, `guardLock`, `stateOf`, `get`, `trustedApply` and `rolledBack` in `tests/db/invoiceDraftEditRoutine.integration.test.mjs`, plus `rollBackAbove`, imported there from `tests/db/migrationsThrough.mjs`.
- Routine, 028 reads: `page` in `tests/db/invoiceDraftRoutine.integration.test.mjs`.
- Routine, grants: `grantsOf` in `tests/db/invoiceDraftCreateAuthority.integration.test.mjs`.
- HTTP: in `tests/db/invoiceDraftEditHttp.integration.test.mjs`:
  - `withEntry`, also nested for two instances;
  - `counts`, `delta`, `stateOf`, `leaseOpen` and `expireLease`;
  - `trapCommit`, with `AUDIT_ANCHOR` or `COMPLETION_ANCHOR`;
  - `withTrigger` and `holdHeader`.
- HTTP, authority race: `narrowedWhileCreateWaits` in `tests/db/invoiceDraftCreateAuthorityHttp.integration.test.mjs`.
- Client: `src/tenant/invoiceDraftsClient.test.ts`.
- Section: the `fakeServer` in `src/tenant/ServerInvoiceDrafts.test.tsx`; its dialog focus is tested through SID-92, since `DialogFrame` has no direct tests.
- Browser: `tests/browser/shopRoleLevels.browser.test.mjs` (`st.lose`, `gate`).

**Missing seams:**
- a discard branch in `withEntry`'s `ctx` and in `fakeServer`;
- `counts()` parameterized by action, or given discard buckets, because its per-tenant audit bucket is pinned to the edit's action (`invoiceDraftEditHttp.integration.test.mjs:115-116`). It also needs a bucket counting discarded headers and a `ONE_DISCARD` expectation beside `ONE_EDIT`;
- the route pins: `routes.test.ts`, `tests/quality/production-runtime-contract.test.mjs`, and the tenant entry's route table, currently twenty routes and becoming twenty-two (M7TE-01 in `tests/db/tenantEntry.integration.test.mjs`; M7RLH-C1 in `tests/db/roleLevels.integration.test.mjs`);
- the migration-head pins in the database suites and in `tests/quality/migration-files-contract.test.mjs`.

| ID | Invariant | Layer | Decisive assertion | Harness |
|---|---|---|---|---|
| DSC-01 | An eligible discard commits, and the shop says so only after the server confirms | HTTP + section | 200 `{draftId, version: v+1, status: "discarded"}`. Delta: one header change, one audit record, one completion, no outbox row. "Draft discarded." appears in `drafts-notice` only after the validated 200 | `withEntry`, `counts`; `fakeServer` |
| DSC-02 | Threshold boundary | Routine + HTTP | HTTP: Invoices `edit` → 403; `manage`, `full` and `store_owner` → 200. Routine: `edit` → `refused`; `manage` and above → `applied`. The default `manager` → 200. A `manager` the owner set to Edit → 403, so the role's name grants nothing | `setInvoices`; `ctx.levels` |
| DSC-03 | An owner-edited level decides at commit | HTTP, two entries | The owner lowers or raises a role between Edit and Full through `PUT /api/v1/roles/levels` while a discard waits behind the guard key: lowered → 503, nothing written; raised → 200 | `narrowedWhileCreateWaits` pattern; `guardLock` |
| DSC-04 | Read-only and suspended standing; revoked or expiring session | Routine + HTTP | Read-only → 403 at the chain. A grant suspended or a session revoked while waiting on 016's hold → 503, nothing written. A session that expires while the discard waits on the header or on the key → `refused`, nothing written | IEH-11 pattern (`AT_HOLD`); IDE-19 pattern |
| DSC-05 | Missing and foreign targets look the same | HTTP | A missing id, another store's and another tenant's draft give the same status, error and body shape (only `requestId` differs) and the same logged reason; nothing written | IEH-07 pattern |
| DSC-06 | Stale version | Routine + HTTP | `expectedVersion` ≠ current → sealed 409 `write_conflict`; only the completion written; a same-key retry replays it | `COMPLETION_ONLY` |
| DSC-07 | Edit/discard race | Routine | An edit holds the header; the discard waits on the header, then gets `conflict`. In the reverse order, the edit gets `invalid_state` | `holding`, `blockedBy` |
| DSC-08 | Two concurrent discards across two instances | HTTP, two entries | Different keys: exactly one 200, the other sealed `invalid_state`; one audit record | nested `withEntry` |
| DSC-09 | Same-key replay and mismatch | Unit + HTTP | Same key and bytes → replay with `Idempotent-Replayed: true`. Another version or another draft under the key → 422. An edit key reused on the discard → 422. The suffix target derivation leaves the save's and the edit's fingerprints byte-identical | `withChain`; IEU-07 pattern |
| DSC-10 | New key after a discard | HTTP | Sealed 409 `invalid_state`; no second audit record; version unchanged | `counts`, `stateOf` |
| DSC-11 | Atomicity of state, audit and completion | HTTP | Each injected failure → 503, header unchanged, nothing recorded: the audit INSERT raised, then the completion write raised | `withTrigger(raise)` |
| DSC-12 | Lease behaviour on refusal | HTTP | A 503 refusal leaves the lease. The same key → 409 in progress until `expireLease`, then it re-plans under current authority | `leaseOpen`, `expireLease` |
| DSC-13 | Lost COMMIT acknowledgement | HTTP + section | COMMIT lands, answer dropped → 503; a same-key retry replays the 200. COMMIT cut → a retry after the lease expires re-plans. The shop keeps the attempt unresolved, and "Check again" sends the same key and bytes | `trapCommit` (`AUDIT_ANCHOR`); `fakeServer` hold |
| DSC-14 | Navigation, session end, scope switch, late answer | Section + browser | Closing the confirmation, a sign-out, a token renewal (new generation), a user change or a store change each drop the attempt; a late 200 changes nothing; after Reconnect the list omits the draft. Closing an unresolved confirmation closes the reopen dialog too and re-reads the list | SID-89..91 and SID-106 patterns; `st.lose` |
| DSC-15 | Active list and direct read | Routine + HTTP + section | A discarded draft is absent from pages; `get` → 404; a cursor naming it still pages; the shop shows no "unavailable" | `page`, `get`; `listDrafts` |
| DSC-16 | Terminal state at the database | Routine | The triggers refuse: `discarded` → `draft`; any update of a discarded header; a status change with any other column change; and any line insert, update or delete under a discarded header | `rolledBack` (owner transaction) |
| DSC-17 | Migration apply, upgrade, guard, rollback, privileges | Routine | Apply postconditions. Apply refusals: 032 missing; own objects already present. Upgrade over drafts at versions above 1 with edit audit records: every row unchanged, then edit, save and discard all work. Schema `USAGE` and `EXECUTE` only for `tmpos_app`; 028's reads revoked; triggers ENABLE ALWAYS. The down refuses while a discarded draft exists; it rolls back only after the suite deletes its own discarded drafts on the disposable database. 029 and 032 downs still pass in order | `trustedApply`, `rollBackAbove`, `grantsOf` |
| DSC-18 | Only the revalidated scope is used | Adapter | The mutator binds the revalidated store and refuses a context-store mismatch before any statement | `recorder` |
| DSC-19 | Target-blind eligibility | Unit + HTTP + section | `discard-eligibility` answers the same for every well-formed id and reads no draft; Discard appears only on `allowed`; a View-level role hears one denial announcement, not two | IEU-05 pattern; SID-77 |
| DSC-20 | Local invoice compatibility | Section | The local Invoices list, counters and hand-over are unchanged; server drafts never enter the local list or browser storage | INV-13, INV-16, INV-17; SID-27 |
| DSC-21 | Accessible confirmation | Section + browser | `role="alertdialog"`; name "Discard this draft?"; description equal to the consequence and identity text; initial focus "Keep draft"; Escape before sending keeps the draft and returns focus to "Discard draft…". After success, focus is on the heading and never passes the discarded row's Open. After an unresolved answer, the close control is named Close and described by the close warning, "Discard draft" is absent, and Escape sends nothing. Refusal focus targets as in §5 E | SID-92 pattern |
| DSC-22 | Logs and secrets | HTTP | No description, customer id, token or key in any log line across the suite | IEH-14 canary pattern |
| DSC-23 | Route and permission inventory | Unit + quality + HTTP | The two new templates and `discard_invoice_drafts` appear in every pinned inventory; the widened load-time guard admits Manage for that key only | `routes.test.ts`; `production-runtime-contract.test.mjs`; M7TE-01; M7RLH-C1 |
| DSC-24 | Exact audit record | HTTP | Actor, tenant, store, draft subject, action `store.invoice_draft.discard`, permission `discard_invoice_drafts`, scope `store`, metadata `{}` | owner read of `audit_event` |
| DSC-25 | Replay respects current authority | HTTP | Complete a success, a conflict and an `invalid_state` under three keys. Lower the role below Manage or revoke the session: each same-key retry gets 403 or 401, not the stored answer. Restore authority: each retry replays | `ctx.levels`; `withEntry` |
| DSC-26 | No deadlock against writers | Routine | A discard holding the header against an edit, and a discard holding the key against a level writer (Invoices and Customers), each complete in both orders without a deadlock | IDE-11, IDE-17 and IDE-20 patterns |

Focused negative controls, run once per critical boundary, not a mutation campaign:
- remove the state check → DSC-10 fails;
- remove the guard key → DSC-03 fails;
- drop the reads' status filter → DSC-15 fails;
- drop the line trigger → DSC-16 fails.

## 8. Implementation slices and commit checkpoints

**0. Owner approval recorded.** The owner records the §9 answers. No code starts before that.

**1. Server (one commit, then exact-commit CI).**
- The migration (§5 D).
- The routine.
- The adapter mutator and the switch to the new reads.
- The route, contract and permission, the widened guard, and the precondition-kind set.
- The suffix-aware command-target derivation in `app.ts`.
- The eligibility route.
- The inventories and the preflight.
- Tests: DSC-01 to DSC-13 and DSC-15 to DSC-19 at their unit, adapter, routine and HTTP layers; DSC-22 to DSC-26.
- The missing seams of §7.
- CI ordering: the new suite runs where suites that leave drafts may run.

**2. Shop (one commit, then exact-commit CI).**
- `discardDraft` and `discardEligibility` in the client.
- The `DialogFrame` props, the reopen-dialog action, the confirmation and the unknown-outcome handling.
- The role-levels description.
- Tests: DSC-01, DSC-13, DSC-14, DSC-15 and DSC-19 at their client, section and browser layers; DSC-20 and DSC-21.
- The frontend floors raised to the new counts.

**3. Documentation of record (one commit, then CI).**
- ADR-49 (DECIDED) in [10](./10-architecture-decision-records.md).
- Inline amendments to ADR-47 (the status set and its Behaviour line) and ADR-48 (discarding no longer deferred).
- A [05](./05-canonical-data-ownership-and-api-db-contracts.md) §2 paragraph "Invoices — discarding a saved draft". The P1 and P2 paragraphs' "Not in this slice" bullets are amended: discarding is delivered, deleting is still deferred.
- [08](./08-production-gate-and-risk-register.md): amendments to DA-183, DA-184, DA-186 and DA-187, and new DA rows for any residual, including the discard attempt's dialog-scoped hold beside DA-208.
- The [09](./09-roadmap-m0-m9.md) M7b progress.
- The root README, only where its statement that a draft "cannot yet be discarded" becomes untrue.
- This document, marked as adopted or superseded.

At each checkpoint:
1. stage the named paths;
2. check the staged tree against the verified candidate;
3. push an ordinary fast-forward;
4. read every CI job on that exact commit.

Nothing is deployed.

## 9. Owner approval response template

Copy, edit and send. Changing a selection replaces that recommendation in §4 and §5.

```
M7B invoice draft discard — owner decisions
D-DIS-1 meaning:      ACCEPT logical terminal discard (draft -> discarded; nothing deleted; no restore in this slice)
D-DIS-2 authority:    ACCEPT new store permission discard_invoice_drafts at Invoices Manage or above;
                      any draft in the store; no Customers corequisite; no recent sign-in
D-DIS-3 visibility:   ACCEPT hidden from list and read (404); expectedVersion required; version +1;
                      new key on a discarded draft = 409 invalid_state (no no-op; its disclosure accepted)
D-DIS-4 confirmation: ACCEPT confirmation naming the draft; no reason field; one audit record; no outbox event
D-DIS-5 unknown:      ACCEPT attempt held only while its confirmation is open, with Check again (DA-208 not required)
```

For information, not an owner decision: the proposed route is `POST /api/v1/stores/{storeId}/invoice-drafts/{id}/discard`, with `GET …/{id}/discard-eligibility` (§4, §5 B).
