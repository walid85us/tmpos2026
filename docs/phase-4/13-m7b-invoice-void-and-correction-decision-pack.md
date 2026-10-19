# 13 — Voiding an issued store invoice and correcting an issuing mistake: decision pack and conditional contract

**Status: ADOPTED (owner acceptance 2026-10-18, stage M7B-INVOICES-VOID-P1, [ADR-51](./10-architecture-decision-records.md#adr-51--voiding-an-issued-store-invoice-a-terminal-logical-void-recorded-beside-the-immutable-invoice-at-invoices-approve-with-customers-view-and-a-recent-sign-in-with-a-required-closed-reason-code-one-audit-record-and-no-event-decided--m7b-invoices-void-p1)); implementation in progress; nothing deployed.** The owner's stage instruction of 2026-10-18 accepted D-VOID-1 to D-VOID-6 as written in its own §1, which is the complete acceptance and not a blanket acceptance of other text in this pack, and ADR-51 resolves [12](./12-m7b-invoice-issue-decision-pack.md) D-ISS-7's "records a reason" as a required reason code from a closed list, with no free text. Adoption does not deliver the feature: voiding is not available in the product. The P1 implementation (the server, database and HTTP void boundary and the existing shop reads, §12) is in progress, and none of it is committed yet; the shop's Void action, confirmation and recovery are P2 and pending. The adopted implementation contract is §12, at the end of this document; §4–§7 apply only as reconciled by §12. §1 to §11 below are kept as the proposal's record: their alternatives are not adopted, and their "nothing is implemented", "adopts no policy", "no stage may implement it" and "This pack adds no ADR" statements describe the pack before acceptance. ADR-51 records the decisions at adoption, before any wiring, as ADR-50 was recorded, rather than at delivery as the Recording note below expected.

**Original status: PROPOSED / UNADOPTED (stage M7B-INVOICES-VOID-P0, documentation only).** Voiding an issued invoice is not available in the product. Nothing in this pack is implemented, and this document adopts no policy: no void, no correction, no permission, no route, no read change and no migration. Pushing it is not approval, and neither is a green CI run. Until the owner returns §11 with accepted choices, void stays deferred exactly as [08](./08-production-gate-and-risk-register.md) DA-186 and [09](./09-roadmap-m0-m9.md) (M7b, "Owner decisions remaining") say, and no stage may implement it. Accepting the decisions adopts them but does not deliver the feature.

**Labels.** Each statement carries one class:
- **EXISTING** — behaviour verified in source at commit `cbdcf59`, cited `path:line`.
- **ADOPTED** — policy already adopted, cited `doc:line`.
- **RECOMMENDED** — new policy this pack proposes; it awaits the owner.
- **CONDITIONAL** — an implementation choice that applies only if the owner accepts the related recommendation.
- **DEFERRED** — a capability or launch decision this pack does not settle.

Where the repository does not establish a fact, the text says "not established". PostgreSQL behaviour that the design relies on but the repository has not yet proven is marked "(PostgreSQL behaviour; proven only by the planned test named)".

**"Owner" in this pack.** "The owner" is the product owner who decides §11. The `store_owner` role, the shop account that owns a tenant's stores, is always written as "the store owner (`store_owner`)".

**Recording.** If the owner accepts the decisions, they become the owner's decision for the void route, recorded as D-DIS-n and D-ISS-n were ([10](./10-architecture-decision-records.md) ADR-49 and ADR-50), and are written up as the next ADR (ADR-51 at today's numbering) when the slice is delivered. This pack adds no ADR. It adds two register rows, DA-221 and DA-222 (P2 evidence limits found unrecorded, §8); no other row is amended.

**Source references.** `path:line` references are to commit `cbdcf59` and drift as files change. Migration file names are relative to `server/platform-identity/migrations/`. `ADR`, `D05`, `D08`, `D09`, `D11` and `D12` cite lines of [10](./10-architecture-decision-records.md), [05](./05-canonical-data-ownership-and-api-db-contracts.md), [08](./08-production-gate-and-risk-register.md), [09](./09-roadmap-m0-m9.md), [11](./11-m7b-invoice-draft-discard-decision-pack.md) and [12](./12-m7b-invoice-issue-decision-pack.md) (`D08` as this stage amends it); `RM` cites the root `README.md`. Many of those lines are one long paragraph or table row; a line number names the whole row.

## 1. The capability in plain language

**RECOMMENDED meaning.** An authorized store team member marks one issued invoice of the store as **void**. The invoice stays: its number, its version-1 snapshot (seller, customer name, lines, amounts, tax line, Total, issue time) and its link to the draft it was issued from do not change, and it stays visible in the store's issued invoices with a "Voided" label. The number stays used and is never given to another invoice. The source draft stays issued and can never be issued again. A void records a product lifecycle change and nothing else.

| Term | What it is | Status |
|---|---|---|
| **Void** (this pack) | A numbered issued invoice is marked void; it stays visible and keeps everything it recorded. | RECOMMENDED |
| Discard | An unissued saved draft leaves active work; it never had a number, and the product reads no longer show it (ADR:1443, ADR:1447). | ADOPTED |
| Refund | Money returned to a customer. The product records no payment and no refund (`034_m7b_invoice_issue.up.sql:404-405`; no payment table exists in 034). | DEFERRED |
| Credit note, partial correction | A document that adjusts an amount due. Adopted text places them with payments (D12:167; ADR:1512). | DEFERRED |
| Tax reversal or filing | Any change to a tax obligation. The product does not verify tax applicability (ADR:1503) and files nothing. | DEFERRED |
| Deletion, erasure, retention | Removing or redacting data. Undecided (D08:477, DA-187); ordinary operations never change or delete issued contents (ADR:1500). | DEFERRED |

**Why this slice (ADOPTED).** "Void is the next product capability and must exist before live issuing" (ADR:1500); without it "a mistakenly issued invoice cannot be corrected in the product … **not acceptable for live use**" (D12:169). Void is necessary for live issuing but not sufficient: retention, privacy mechanisms, legal review, backup/restore assurance and DA-118/DA-119 also remain pre-launch requirements (ADR:1506).

**Product options compared.**

| Option | What it is | Practical trade-off |
|---|---|---|
| **A. Terminal void (RECOMMENDED)** | Issued → voided, once, with no way back in this slice. | Smallest truthful change: the document and its number stay, the history is append-only, and no other domain is touched. A mistaken void cannot be undone in the product. |
| B. Void with restore | Issued ⇄ voided. | A restore re-activates a document the customer may have been told is void; it needs a second command, permission, audit action and a lifecycle history of several records, and it removes "voided is final" as a guarantee. |
| C. No void; credit notes later | Correct only by credit notes once payments exist. | Leaves live issuing blocked (ADR:1500), and credit notes need payment and amount-due rules that do not exist. |

**Recommended first slice (RECOMMENDED).** One void command with an action-only eligibility read, the lifecycle shown on the two existing issued reads, then the shop's use of them. Outside it (DEFERRED): payments, refunds, credit notes and partial corrections, tax reversals or filings, printing, sending or any document delivery, creating or linking a replacement invoice, unvoid or restore, a voided-only view or filter, free-text reasons, deletion, erasure and retention, legal readiness and deployment.

## 2. Source map

Every row is **EXISTING** unless it names a document, which is **ADOPTED**.

| Area | Where | What it establishes |
|---|---|---|
| Issued storage | `034_m7b_invoice_issue.up.sql:341-410` (`issued_invoice`); keys `:366-372`; `:380` | 24 columns and no status, lifecycle or row-version column; one invoice per source draft forever (`:369-370`); number unique per store (`:372`); `snapshot_version = 1` |
| Immutability | `034_m7b_invoice_issue.up.sql:538-561`, `:765`; lines `:639-642`; truncate `:675-692` | Every UPDATE and DELETE of an issued header or line raises, ENABLE ALWAYS; TRUNCATE refused |
| Source draft | `034_m7b_invoice_issue.up.sql:820-833` | An `issued` draft admits no update or delete, "a no-op and a return to 'draft' included" |
| Counter | `034_m7b_invoice_issue.up.sql:494-531` | Moves only +1 to an issued number; never deleted |
| Issue routine and lock order | `034_m7b_invoice_issue.up.sql:63-68`, `:1833-1837` | The documented order; key 530030 SHARED with levels re-read |
| Store reader | `034_m7b_invoice_issue.up.sql:914-1027`, `:937-940` | Accepts only an Invoices threshold of `view` or `approve`, with Customers ≥ View |
| Issued reads | `034_m7b_invoice_issue.up.sql:2037-2207`; `:2084-2093` | Page and get return no lifecycle field; the `?sourceDraft=` branch filters only tenant, store and draft id |
| Grants and anchor | `034_m7b_invoice_issue.up.sql:2257-2262`; `:2217-2219` | `tmpos_app` EXECUTE on exactly six routines; a rollback-order anchor |
| 034 rollback | `034_m7b_invoice_issue.down.sql:127-140`, `:164-167` | Refuses while any issuing data or audit row naming an issued invoice or store exists; drops without CASCADE |
| Audit table | `002_authorization_audit_foundation.up.sql:251`, `:294-295` | `occurred_at default now()`; append-only trigger, not ENABLE ALWAYS |
| Request chain | `server/runtime/app.ts:841-860`, `:951-959`, `:982-1000`, `:1044` | Limiter, origin/CSRF, trusted context, step-up, command target, replay before commit |
| Kernel | `server/runtime/commandTransaction.ts:126`, `:144-162`, `:517-519`, `:526`; `server/runtime/idempotency.ts:106`, `:133`, `:397-402` | 2,000 ms command deadline; audit annex bounds; update mode needs a version ≥ 1; per-attempt correlation id; 60 s lease and 24 h retention; reserved words; fingerprint |
| Store | `server/persistence/postgresTransactionalStore.ts:40-44`, `:77-79`, `:303`, `:309`, `:740-746`, `:765-826`, `:968-970` | One transaction per port call; no constraint is a business answer; closed kind lists; sealed and unsealed answers; audit-subject rule |
| Revalidation | `server/composition/tenantAuthorization.ts:339-345`, `:363` | A deadline is required exactly for a sensitive permission, judged on the database clock |
| Permissions | `server/platform-identity/m5CanonicalPermissions.ts:274-290`, `:292-322`, `:471`; `server/platform-identity/permissionCatalog.ts:201`, `:493-519`, `:857-858`; `src/context/accessConfig.ts:31`; `server/runtime/roleLevelUpdate.ts:86`; `server/runtime/sessions.ts:173` | Six store keys; the load guard; no plan gate; role defaults; the shop picker; the API's seven levels; the 10-minute sign-in window |
| Audit writer | `server/platform-identity/auditEventWriter.ts:418-432` | "An issued invoice is never named outside that triple" |
| Events | `server/composition/transactionKernel.ts:23-26`; `server/runtime/invoiceIssuing.ts:259` | The tenant root composes no delivery port; the issue emits no event |
| Issuing HTTP | `server/runtime/invoiceIssuing.ts:113`, `:495`, `:539-540`, `:625-639`, `:704-708`, `:737-739`; `server/persistence/postgresInvoiceIssuing.ts:30-33`, `:69-73`, `:108-112`, `:234-237`, `:352-353`, `:491-493` | `status` is a route constant; exact decoders and column sets; an action-only eligibility; the readiness probe |
| Inventories | `server/runtime/routes.ts:445-468`, `:489-494`, `:501-506`; `server/entry/tenantEntry.ts:114-143`, `:177-179`; `server/persistence/postgresStartupPreflight.ts:59-94`, `:110` (034's entries `:137-142`, `:176`), `:375-382` | 13 store templates, 4 store commands, 29 shipping routes, exact ledger 001–034 and exact grants |
| Shop | `src/tenant/invoiceIssuingClient.ts:246-249`, `:376-383`, `:406-407`, `:417-423`, `:674-676`; `src/tenant/ServerInvoiceDrafts.tsx:395`, `:417`, `:474-476`, `:536-549`, `:627-628`, `:892`, `:1209`, `:1249-1254`, `:2406-2441`, `:2449-2452`, `:2491-2498`, `:3276`; `src/tenant/ServerIssuedInvoices.tsx:1147`, `:1280`, `:1341`; `src/tenant/ServerCustomerDirectory.tsx:142` | Exact decoders; the issue hold store and its recovery; the issue confirmation; the "Issued" literals |
| Tests that assert no void | `src/tenant/ServerInvoiceDrafts.tsx:395` (the sentence; SID-149 at `src/tenant/ServerInvoiceDrafts.test.tsx:5248`, assertion `:5264`) and its browser copy `tests/browser/shopRoleLevels.browser.test.mjs:8495`; `src/tenant/ServerIssuedInvoices.test.tsx:1510`; `tests/browser/shopRoleLevels.browser.test.mjs:7950` | "Void is not available." and two word lists that forbid "void" |
| Pins | `tests/quality/migration-files-contract.test.mjs:400-415`; `tests/quality/production-runtime-contract.test.mjs:382-430`; `server/entry/tenantEntry.test.ts:204-247`; `tests/db/invoiceIssueHttp.integration.test.mjs:1872-1877`; `tests/db/invoiceIssueRoutine.integration.test.mjs:993`; `tests/db/migrationsThrough.mjs:30` | Inventories a void moves |
| Adopted policy | ADR-47 d1 (ADR:1346); ADR-49 (ADR:1438-1493); ADR-50 (ADR:1495-1530); D12 §10 (D12:558-713); D05 §2 "Invoices — issuing" (D05:254-268) | Store authority, the discard and issue precedents, the issuing contract |

## 3. Invariants checked against source

### 3.1 The stage's invariants

| # | Invariant | Verdict | Evidence |
|---|---|---|---|
| 1 | An issued invoice belongs to a server store; path ids select access, not authority | CONFIRMED | FK (tenant, store) `034_m7b_invoice_issue.up.sql:375-376`; path store must equal the trusted store `server/runtime/app.ts:982-1000`; the issue binds the revalidated context `server/persistence/postgresInvoiceIssuing.ts:108-112`; ADOPTED ADR:1346, D12:588 |
| 2 | Immutable snapshot and a store-scoped number | CONFIRMED | `034_m7b_invoice_issue.up.sql:558-561`, `:765`, `:372`, `:380`; ADOPTED D12:657, D12:659 |
| 3 | Historical seller, customer name, lines, currency, tax and amounts do not follow later edits | CONFIRMED | values copied into the row `034_m7b_invoice_issue.up.sql:341-410`; ADOPTED ADR:1504 |
| 4 | USD and the exact-cent and tax rules | CONFIRMED | `034_m7b_invoice_issue.up.sql:390`; ADOPTED ADR:1503, D12:652 |
| 5 | Issuing records no payment or proven amount due, processes no refund, settles no tax | CONFIRMED in code; "refund" and "settle tax": NOT STATED verbatim in adopted text | table comment `034_m7b_invoice_issue.up.sql:404-405`; ADOPTED ADR:1500 (no amount due, payment or balance), ADR:1503 ("does not verify tax applicability"). This pack does not cite ADR-50 as saying "no refund". |
| 6 | The source draft is terminal; a void must not reopen it or allow a second invoice from it | CONFIRMED for terminality and permanent uniqueness; the void clause: NOT STATED (a new rule derived from them, RECOMMENDED in D-VOID-1) | `034_m7b_invoice_issue.up.sql:820-833`, `:369-370`; ADOPTED ADR:1505 |
| 7 | Numbers are never reassigned or reused | CONFIRMED in the database; "a void keeps its number" is accepted D-ISS-3 text | `034_m7b_invoice_issue.up.sql:494-531`; ADOPTED D12:220 |
| 8 | Permissions, plan gates, isolation, session revocation and transaction-time revalidation stay server-authoritative | CONFIRMED except **plan gates: CONTRADICTED as worded** | Invoices is a core domain with no plan gate (`server/platform-identity/permissionCatalog.ts:201`); the store decision materializes with an empty entitlement set (`server/platform-identity/m5CanonicalPermissions.ts:471`); G-ENTITLE is OPEN and browser-side (D08:140). The pack's wording: **no plan gate applies to Invoices**, and void claims none. Precision: a same-key replay is gated by the chain's current session, CSRF and route authorizer, not by the transaction-time revalidator (`server/runtime/app.ts:1044` returns before any commit) — ADR:1505's "under current authorization" matches the chain. |
| 9 | Idempotency replay and permanent business uniqueness are distinct | CONFIRMED | per-principal key `server/runtime/idempotency.ts:397-402` vs `unique (source_draft_id)` `034_m7b_invoice_issue.up.sql:369-370`; ADOPTED ADR:1505 |
| 10 | Deletion and erasure, retention, legal readiness and deployment stay open | CONFIRMED | ADOPTED ADR:1506; D08:477 (DA-187); 034's down deletes nothing (`034_m7b_invoice_issue.down.sql:127-140`) |

None of these is a claim of jurisdictional compliance.

### 3.2 Discrepancies found and how this pack treats them

- **"Void records a reason" may already be adopted.** D-ISS-7's accepted recommendation says void "(keeps the invoice and number, records a reason)" (D12:147; also D12:151, D12:167, D12:351), and D12:560 keeps §4's accepted recommendations except where §10 amends them; the adopted D-ISS-7 row (D12:572) and ADR-50 never mention a reason. This is genuinely ambiguous. D-VOID-4 recommends a required reason **code**, which satisfies D12:147 literally; choosing no reason would be a proposed narrowing of D12:147, and choosing free text a proposed widening of what is stored.
- **There is no store clock.** `audit_event.occurred_at` is `now()`, the transaction start (`002_authorization_audit_foundation.up.sql:251`); `issued_at` is `clock_timestamp()` after the counter lock (`034_m7b_invoice_issue.up.sql:408-409`). This pack says "database clock" and states which of the two each void time uses (D-VOID-4).
- **A detached attempt is not forgotten.** ADOPTED ADR:1505 says recovery memory "may survive closing a dialog but not a reload, sign-out, a user change or session end". EXISTING: a sign-out, token change or user change *detaches* the issue attempt — it nulls the session's CSRF token and empties the body (`src/tenant/ServerInvoiceDrafts.tsx:538-539`, `:892`, `:1249-1254`, `:627-628`), so it can no longer be sent, while a non-sendable notice stays until dismissed and still blocks a new issue (D12:709, SID-185). This pack words void recovery the same way: "cannot be re-sent after …", not "is forgotten".
- **D12's proposal history anticipated an in-row void.** D12:415 (history) said the issued-row guard would refuse every update "except the void transition in the next slice". The adopted, as-built rule has no exception: "issued headers and lines refuse every UPDATE, DELETE and TRUNCATE" (D12:659; `034_m7b_invoice_issue.up.sql:558-561`). A status cannot simply be added to the issued row; §5 A recommends a design that changes no 034 object.
- **D05's M1 entity table names `reopened`.** D05:58 lists an Invoices lifecycle "open/paid/void/reopened". It is the M1 target sketch, not adopted lifecycle policy (ADR-50 adopted `issued` and no paid state). The recommendation of no unvoid (D-VOID-1) does not amend D05:58; the delivery documentation would annotate it.
- **The state's name.** D12:161 and D12:167 name the voided state `void`; this pack's value `voided` (§5 E, §10) is illustrative and fixed at implementation.
- **Snapshot version 1 and a lifecycle label.** ADOPTED D12:628: "Any later change to the issued snapshot or read semantics introduces a new version for new records; no later feature … silently reinterprets version-1 records". A void applies to existing version-1 records, so a version bump for new records cannot express it. D-VOID-3 asks the owner for an explicit reading rather than a silent one.

### 3.3 Hard constraints a design must respect (EXISTING)

1. `issued_invoice` has no status or version column, and every UPDATE or DELETE raises under an ENABLE ALWAYS trigger (`034_m7b_invoice_issue.up.sql:558-561`, `:765`). An append-only record in a new schema changes no user-defined 034 object (its foreign key adds internal RI triggers on `issued_invoice` and a dependency, §5 A); an in-row lifecycle replaces an adopted guard.
2. The source draft stays `issued` and one invoice per draft holds forever (`034_m7b_invoice_issue.up.sql:820-833`, `:369-370`). Correction therefore means a different draft and a new number.
3. Readers are exact. The shop accepts only `status === 'issued'`, `snapshotVersion === 1` and exact key sets, and one bad row makes the whole page `unavailable` (`src/tenant/invoiceIssuingClient.ts:376-383`, `:406-407`, `:417-423`); the server decoders, adapter column sets and readiness probe are exact too (`server/runtime/invoiceIssuing.ts:495`, `:539-540`; `server/persistence/postgresInvoiceIssuing.ts:234-237`, `:352-353`, `:491-493`). A lifecycle on the list or detail is a wire contract change on every layer.
4. Update-mode commands need an aggregate version ≥ 1 (`server/runtime/commandTransaction.ts:517-519`); issued invoices have none. `invalid_state` is sealed for update mode only (`server/persistence/postgresTransactionalStore.ts:812-815`).
5. Closed lists must be extended by name: `PRECONDITION_UPDATE_KINDS` (`server/runtime/app.ts:525` and `server/persistence/postgresTransactionalStore.ts:303`), the audit-subject rule (`server/persistence/postgresTransactionalStore.ts:968-970`; `server/platform-identity/auditEventWriter.ts:418-432`), the store templates and commands (`server/runtime/routes.ts:445-468`) and the shipping table (`server/entry/tenantEntry.ts:114-143`, `:177-179`).
6. The lease commits in its own earlier transaction and no refusal releases it; sealed answers are terminal for the key, unsealed ones leave the lease to expire (`server/persistence/postgresTransactionalStore.ts:40-44`, `:765-826`; ADOPTED ADR:1449).
7. No constraint violation is a business answer: a uniqueness error is a 503 (`server/persistence/postgresTransactionalStore.ts:77-79`). A sealed refusal commits whatever the mutator wrote first, and no SAVEPOINT is available (`:740-746`; D08 DA-36), so a routine writes nothing before its last refusal.
8. The load guard admits exactly one Manage key and one Approve key at store scope, refuses Full and refuses every sensitive store key (`server/platform-identity/m5CanonicalPermissions.ts:292-322`); the revalidator already judges a deadline for a sensitive store key (`server/composition/tenantAuthorization.ts:343-345`, `:363`).
9. The audit writer refuses to name an issued invoice outside the issue's triple (`server/platform-identity/auditEventWriter.ts:418-432`).
10. The tenant root composes no delivery port (`server/composition/transactionKernel.ts:23-26`); an event would sit undelivered.
11. Startup requires exactly migrations 001–034 and an exact grant set (`server/persistence/postgresStartupPreflight.ts:59-94`, `:375-382`); the next migration number is **035**, and it moves in lockstep with the runtime.
12. The shop's text and tests assert that void is absent (§2, "Tests that assert no void"); a void UI supersedes them explicitly.

## 4. Owner decisions

These are the choices the void slice needs. Each recommendation is **RECOMMENDED / UNADOPTED**. D-VOID-1 to D-VOID-6 number this pack's decisions; they are not D-DIS-n or D-ISS-n. Internal names (schema, routine, permission key, reason codes) are illustrative engineering choices except where a decision names them.

| # | Decision | Recommended | Main alternative | Implementation depends on it |
|---|---|---|---|---|
| **D-VOID-1** | Meaning and first-slice boundary | Terminal logical void; number, snapshot and source draft kept; no refund, credit note, tax reversal or erasure; any issued invoice of the store; no unvoid | Void with restore in the same slice | Yes — everything |
| **D-VOID-2** | Authority and recent sign-in | New store permission at Invoices **Approve** plus Customers View; never read-only; **recent sign-in required** | No recent sign-in (the issue's rule); or a Full threshold | Yes |
| **D-VOID-3** | Visibility | Voided invoices stay in the list and detail, labelled "Voided", with the original number and snapshot; `?sourceDraft=` keeps finding them; snapshot version stays 1 with lifecycle as a separate field | Hide voided invoices | Yes |
| **D-VOID-4** | Confirmation, reason and records | Confirmation naming the invoice and store; a **required reason code** from a closed list, no free text; one audit record; no event | Free-text reason; or no reason | Yes (the code list) |
| **D-VOID-5** | Repeats and unknown outcomes | No version on the wire; "already void" is a refusal for a new key, never a silent success; attempt held in memory outside the dialog; Check again and Check invoice | Idempotent success; or dialog-only tracking | Yes |
| **D-VOID-6** | Correction scope | Void only; correct by a fresh draft and a new number, unlinked in this slice | Record an explicit link, or build replacement creation now | No for the recommendation; each alternative adds a slice |

### D-VOID-1 — Meaning and first-slice boundary

**Recommended.** A void is a terminal, logical lifecycle change of one issued invoice: `issued` → `voided`, once. The invoice, its number, its version-1 snapshot and its source draft stay exactly as issued, and a separate append-only void record keeps who voided it, when and why (D-VOID-4). In this slice any issued invoice of the store that is not already void can be voided. There is no unvoid or restore. A void records no payment, refund, credit note, tax reversal or amount due, and it deletes, redacts or erases nothing.

**Why "any issued invoice".** EXISTING: the product records no payment, amount due, delivery or export for an issued invoice (`034_m7b_invoice_issue.up.sql:404-405`; no such table exists). That says nothing about money the merchant took outside the product, so the confirmation must not imply "unpaid" (D-VOID-4). DEFERRED: each future integration needs its own void rule before it ships — recorded payments or amounts due (refuse, or require a refund or credit note first), credit notes, printing or sending (a sent document needs a notice), and accounting or tax exports (a reversal entry).

**Void is not discard.** A discard takes an unissued draft out of active work and hides it from the reads (ADOPTED ADR:1443, ADR:1447). A void keeps a numbered document visible. A voided invoice's source draft stays `issued`; it does not become `discarded` and cannot be discarded or edited (EXISTING `034_m7b_invoice_issue.up.sql:820-833`).

**Main alternative.** Void with restore (§1 option B).

**What users see.** An authorized team member can mark an issued invoice void. It stays in Issued invoices, labelled "Voided", with its number; the number is never reused, so the series shows it rather than a gap. A mistaken void cannot be undone in the product.

**Authority and data.** One append-only void record per invoice, beside the untouched 034 rows (§5 A). The number counter does not move. DA-186's void part is decided once accepted; DA-187 is unchanged, because nothing is deleted.

**Implementation depends on it.** Yes — every part of §5.

### D-VOID-2 — Authority and recent sign-in

**Recommended.**
- A new canonical store permission (illustrative key `void_issued_invoices`): the stored Invoices level is **Approve or above** and Customers is at least **View**, on the store grant's role at the path's store; never under a read-only actor, tenant or store.
- **Recent sign-in required** on the void command, with the existing 10-minute window (EXISTING `server/runtime/sessions.ts:173`).
- No role-name bypass, no System Owner shortcut, no creator privilege and no browser-only authority. Void authority is not derived from permission to issue, read issued invoices, create or edit drafts, or configure issuing settings; it is its own key.

**Practical defaults (EXISTING levels; what they would mean for void is CONDITIONAL).** The store owner (`store_owner`) is Full and never stored (`server/platform-identity/permissionCatalog.ts:857-858`); `manager` defaults to Invoices Full and Customers Full, `technician` to View and View, `sales_staff` to Create and Create (`server/platform-identity/permissionCatalog.ts:493-519`). So, if this is adopted, by default the store owner and the manager would qualify to void; the technician and sales staff would not. The shop's role picker offers None, View, Create, Edit and Full for Invoices (`src/context/accessConfig.ts:31`), so in the shop only Full Access reaches Approve: **the roles that would qualify to void are the roles that may issue**. They could differ only for levels set through `PUT /api/v1/roles/levels`, which accepts all seven levels (`server/runtime/roleLevelUpdate.ts:86`), or a direct level set (021/026, DA-119). The dedicated key would keep a later separation a change to this key alone; it would not separate void from issue.

**Why Approve.** It matches the authority that created the document (ADOPTED ADR:1501, `issue_invoices` at Approve), and the existing database helper already decides exactly "Invoices ≥ Approve with Customers ≥ View" (EXISTING `034_m7b_invoice_issue.up.sql:937-940`, `:1004-1020`). Full would make void stricter than issue only for API-set Approve levels and needs the load guard to admit Full at store scope, which it refuses everywhere today (`server/platform-identity/m5CanonicalPermissions.ts:292-322`). Manage (the discard's threshold) would let an API-set Manage role void what it could not issue.

**Customers View corequisite.** Recommended: yes. The confirmation shows the customer name from the issued detail, which already requires Customers View (`view_issued_invoices`, ADOPTED D12:581), and the recovery read is that same detail. The corequisite grants no directory or contact access (ADOPTED ADR:1501).

**Why a recent sign-in.** A void is permanent and business-significant, and it is rare; a stale or unattended session should not be able to void. EXISTING mechanism: a sensitive permission makes the revalidator require and judge the sign-in deadline on the database clock after its locks (`server/composition/tenantAuthorization.ts:343-345`, `:363`), and the chain answers `403 step_up_required` before reading the idempotency key (`server/runtime/app.ts:956-959`). Not established: that the tenant shop's re-authentication wiring works at store scope (the precedent is tenant scope: `src/tenant/ServerCustomerLevels.tsx:77-102`, the issuing-settings write).

**Main alternative.** No recent sign-in, as the issue has (ADOPTED ADR:1501): simpler, and "Check again" stays usable for the whole 23-hour window; any live session of an authorized role can void. A second alternative is the Full threshold above.

**What users see.** If adopted, owners and managers (Full Access) would see the void action and could void; others would not see it. When the provider sign-in is older than 10 minutes, the shop asks the user to sign in again before the void is sent. After an unconfirmed answer, "Check again" works only while that sign-in is still fresh; afterwards "Check invoice" still shows the invoice's current state, but only the user's dismissal ends the attempt (D-VOID-5).

**Authority and data.** One new store key; the load guard widened by name to admit a second Approve key and the first sensitive store key, with refusal tests; the route declares `recentAuth: 'required'`, and because no startup check ties `recentAuth` to `sensitive`, a route-declaration test must pin both. The routine decides both levels again under key 530030 and, as recommended in §5 C (step 5), judges the sign-in window itself, so a direct definer call also needs a fresh sign-in. No default level changes. DA-183 is amended at implementation (one more operation deciding the stored level), and DA-184's rule applies: the route adds its own HTTP witness.

**Implementation depends on it.** Yes — the threshold, the guard widening and the step-up wiring.

### D-VOID-3 — Visibility

**Recommended.**
- A voided invoice stays in the store's issued list, in its number's position (newest number first), with a "Voided" label, and opens in the detail with its original number and snapshot unchanged — the same seller, customer name, lines, tax line and Total, still labelled as issued them — plus the void's database time (UTC) and its reason.
- Readers are those who may read issued invoices today: Invoices View or above with Customers View (ADOPTED D12:581). No new read permission.
- No status filter and no voided-only view in this slice (DEFERRED).
- `GET …/invoices?sourceDraft=<draft>` keeps returning the invoice issued from that draft, now marked voided. "Find issued invoice" must then say the draft was issued as invoice *N*, later voided — never that it was not issued.
- **Snapshot reading (owner's explicit choice):** the snapshot fields and the Total keep their version-1 meaning; the lifecycle is a separate field (`status` with the value `voided`, and a void member on the detail); `snapshotVersion` stays 1. The owner is asked to accept that a lifecycle label is not a change to "the issued snapshot or read semantics" under D12:628, because it reinterprets no recorded value.

**Correction path.** How a mistake is corrected after a void is an independent choice, D-VOID-6; this decision covers only what readers see.

**Main alternative.** Hide voided invoices from the list and the detail, as discarded drafts are hidden. Support and audit could then no longer find a numbered document, the number series would show unexplained gaps, and `?sourceDraft=` would either hide a real issuance or need its own rule; the deployed decoders would still change for the detail.

**What users see.** Voided invoices remain listed and openable, plainly marked "Voided" with when and why. Nothing about their contents changes.

**Authority and data.** The list and detail answers change in place, server and shop together (§5 E, F). Every answer for a never-voided invoice stays byte for byte as today. The reason code is shown to issued-invoice readers, which is one reason D-VOID-4 recommends codes only.

**Implementation depends on it.** Yes — the read routines, decoders and labels.

### D-VOID-4 — Confirmation, reason and records

**Recommended confirmation.** A confirmation dialog titled "Void invoice *N*?" names the invoice number, the invoice-facing store name from its snapshot with the shop's store label, the customer name, the Total and the UTC issue time, all from the detail read. Its consequence text: "Voiding marks this invoice as void. It stays in Issued invoices with its number, which is never reused, and its contents do not change. This cannot be undone in the product. It records no refund or payment: if the customer paid, settle that outside the product. To correct the invoice, issue a new one from a new draft." Initial focus is on "Keep invoice".

**Recommended reason.** Required: exactly one code from a closed list the owner approves, chosen in the dialog with nothing preselected; **no free text**. Proposed starting list, for the owner to keep or change: `issued_in_error` ("Issued by mistake"), `wrong_customer` ("Wrong customer"), `wrong_lines_or_amounts` ("Wrong lines or amounts"), `wrong_seller_details` ("Wrong seller details"), `duplicate` ("Duplicate of another invoice"), `other` ("Other reason"). Who may read it: every holder of issued-read access at that store, on the detail; the audit record keeps the code with a fixed sentence. A closed code avoids a free-text personal-data channel, but it is still invoice-linked information, shown to every issued-invoice reader and kept in the audit record. No shipped tenant route reads audit records (none of the 29, `server/entry/tenantEntry.ts:114-143`), so in this slice the audit copy is reachable only through database owner or operator access; any audit read for store users needs its own permission decision (DEFERRED). Changing the list later is a migration (§5 H).

**Recommended records.**
- **Actor and subject.** Exactly one audit record per void committed through the supported HTTP command path (a direct definer call stays under DA-118, §5 I): action `store.invoice.void`, the void permission, store scope, the trusted actor, tenant and store of the revalidated context, the issued invoice as its single subject, the reason code with its fixed sentence, metadata `{}`.
- **Correlation.** The request id is the command's per-attempt correlation id (EXISTING `server/runtime/commandTransaction.ts:526`), not the HTTP `X-Request-Id`.
- **Time.** The audit time is the database clock at transaction start (`now()`, EXISTING `002_authorization_audit_foundation.up.sql:251`). The void record's time is the database clock after the last lock (`clock_timestamp()`, as `issued_at` is). The two can differ by in-transaction waits, at most the 2,000 ms command deadline. There is no store clock.
- **Provenance.** The void record keeps the actor's internal id, never returned by a read (as `issued_by`, EXISTING `034_m7b_invoice_issue.up.sql:406-407`).
- **Event.** None. No adopted consumer of an invoice lifecycle event exists, and the tenant root composes no delivery port (EXISTING `server/composition/transactionKernel.ts:23-26`); the issue and the discard emit none (ADOPTED ADR:1500, ADR:1462). A future payments or accounting consumer would need its own event decision then, and an event added later would not cover earlier voids.
- **Refusals.** Refusals and same-key replays write no audit record; an audit failure rolls the void back (EXISTING `server/persistence/postgresTransactionalStore.ts:826-839`).

**Main alternative.** A bounded free-text reason, alone or beside the code: more context, but a new personal-data channel in an append-only record that nothing in the product can correct or erase (DA-187; ADOPTED ADR:1461 named the same concern for discard), readable by every issued-invoice reader if the detail returns it, and needing bounds, character rules, log and leak tests. A second alternative is no reason (the discard's choice), which narrows D12:147's "records a reason" and must be labelled so.

**What users see.** One deliberate confirmation with a required reason choice; afterwards the invoice shows "Voided", when, and the reason's label.

**Authority and data.** One void record and one audit record per void through the HTTP command path; no line, customer or seller text is copied into either.

**Implementation depends on it.** Yes — the code list is a database CHECK and a closed contract value.

### D-VOID-5 — Concurrent, repeated and uncertain requests

**Recommended.**
- **No version on the wire.** An issued invoice's contents cannot change, so the only lifecycle precondition is that it is not already void, which the server decides under a lock. The body carries the expected tenant (as every store command does) and the reason code.
- **Racing voids.** Two voids of one invoice: one wins; the other, and any later void under a new key, is the sealed refusal "already void" (`409 invalid_state`), never a silent success, so a user learns that someone else voided it first (ADOPTED precedent ADR:1458, ADR:1505).
- **Same key.** The same key and bytes replay the stored answer while the key is retained (24 hours), under the chain's current session and authorization. The same key with another body or another invoice is `422 idempotency_key_reused`.
- **An unconfirmed answer** (no answer, 503, or 409 `request_in_progress`) leaves the attempt — its key, exact body bytes, store, invoice and first-send times — held in the page's memory **outside the dialog**, one live void attempt per user, in its own hold separate from issue attempts. Closing the dialog or aborting the request does not cancel a database change, and the shop says so.
- **Two recovery actions, each only on the user's press.**
  - **Check again** re-sends the same key and bytes under the same session, within 23 hours of the first send, never extended (EXISTING rule `src/tenant/ServerInvoiceDrafts.tsx:1209`, `src/tenant/ServerCustomerDirectory.tsx:142`; the server keeps a key 24 hours, `server/runtime/idempotency.ts:106`). With D-VOID-2's recent sign-in it works only while that sign-in is fresh; afterwards the chain answers `403 step_up_required` before the replay lookup (EXISTING `server/runtime/app.ts:956-959`, `:1044`).
  - **Check invoice** reads that invoice's detail at the attempt's store under current read authority. A detail showing `voided` is conclusive about the invoice's current state (not about which attempt voided it). A detail showing `issued` does **not** resolve the held attempt: the POST may still be in flight and commit later (its lease is 60 s, EXISTING `server/runtime/idempotency.ts:106`).
- **When it resolves.** Only a sealed same-key answer to "Check again" (the replayed 200 or `invalid_state`) resolves the outcome. Dismissing the attempt abandons tracking; it does not learn the outcome, which may stay unknown.
- **Unsendable, not forgotten.** A sign-out, a user change or a new session token (a renewed sign-in starts one; D08 DA-220) makes the attempt unsendable. It keeps a notice until dismissed and blocks a new void meanwhile, as the issue attempt does (D12:709). A store change does not detach it.
- **Reload.** A reload loses the attempt (memory only, EXISTING `src/tenant/ServerInvoiceDrafts.tsx:474-476`); afterwards the shop shows the invoice's current state (its label and detail) without attributing it to the lost attempt.
- **Nothing automatic.** Nothing re-sends on mount, focus, timers, renewal or navigation. At the cutoff a timer clears the held bytes and never sends (EXISTING pattern `src/tenant/ServerInvoiceDrafts.tsx:2449-2452`). No storage or session retention is extended.

A void cannot have a second effect: the database admits one void per invoice, so a new-key re-send after a lost answer is either applied once or refused "already void". The cost of an unknown outcome is confusion, not duplication.

**Main alternative.** An idempotent success for a new key on a voided invoice (the kernel's sealed `unchanged` 200 with no audit): it hides who voided first and departs from both adopted precedents. A second alternative is dialog-only tracking (the discard's D-DIS-5, ADOPTED ADR:1450): less code, but closing the dialog ends tracking and the user must reopen the invoice to learn the outcome.

**What users see.** After an unconfirmed void the shop keeps saying the outcome is unknown until "Check again" gets the server's sealed answer or the user dismisses the notice. "Check invoice" shows the invoice's current state: "Voided" there is conclusive about the invoice, but "Issued" does not mean the void failed, because the request may still land. A later void of an already voided invoice is answered "already void".

**Authority and data.** No new storage beyond the void record; the shop holds key and bytes in memory only.

**Implementation depends on it.** Yes — the command mode, sealed answers and the shop's hold.

### D-VOID-6 — Correction scope

**Recommended.** The first slice is void only. To correct an issuing mistake, the team member voids the wrong invoice, creates a new draft through the existing drafts screens and issues it; it takes the store's next number. Nothing copies the voided invoice's lines, and no link between the two invoices is recorded in this slice; the void's reason code says why it was voided. The original source draft is never reopened (§3.3, constraint 2) and the snapshot is never edited.

**Main alternative.** Record an explicit link ("replaced by invoice *M*"). The voided invoice's snapshot cannot hold it (immutable), and the new invoice's snapshot cannot either without a snapshot change (D12:628). So it needs a separate append-only link record, written by its own later command after the replacement is issued, with its own permission, audit action and read. A second alternative is replacement creation in this slice (copy into a new draft, or void-and-reissue in one step): it couples two commands, touches the adopted issue contract or the draft save, and duplicates customer and line data (DA-187). Credit notes stay with payments (ADOPTED D12:167).

**What users see.** A corrected invoice is re-entered by hand; nothing in the product ties it to the voided one.

**Authority and data.** Nothing new: the existing draft and issue authority applies.

**Implementation depends on it.** No for the recommendation; each alternative adds its own slice and decision.

## 5. Conditional implementation contract (CONDITIONAL; applies only once §11 is accepted)

Everything in this section is **CONDITIONAL** and written for §4's recommendations; text marked EXISTING restates current code. It is a plan, not new code and not an adopted API. Object names are illustrative.

### A. State and persistence

| Concern | A: append-only void record (CONDITIONAL, recommended) | B: lifecycle on the existing row |
|---|---|---|
| What changes in 034 | No user-defined 034 object changes (no table, column, trigger, function or CHECK). The foreign key adds PostgreSQL's internal RI triggers on `issued_invoice`, which 034's checks filter out (`not tgisinternal`: `034_m7b_invoice_issue.up.sql:2486-2491`, `034_m7b_invoice_issue.down.sql:84-85`), and a dependency that blocks 034's drop (§5 H). `tmpos_app` loses EXECUTE on 034's page and get, which the v2 reads replace (an ACL change made by 035 and undone by its down; 033's precedent, `033_m7b_invoice_draft_discard.up.sql:8-18`). | `issued_invoice` gains lifecycle columns; `trg_issued_invoice_guard` is rebound to a new function admitting exactly one NULL → voided change with all 24 snapshot columns unchanged; the "Insert only" table comment becomes false. |
| Adopted text superseded | None for persistence | D12:659 ("refuse every UPDATE") and ADR-50's immutability as built — an explicit supersession |
| One void per invoice | Decided by the routine under its lock; the primary key is only a backstop (constraint 7) | A guard predicate |
| Risk | A bug can at worst write a wrong void record | A guard bug could change a snapshot; every UPDATE writes a new physical version of the snapshot row (PostgreSQL behaviour) |
| Rollback | Refuse while any void record exists; drop the own schema | Refuse while any row is voided; restore 034's guard binding and comment; drop columns |

**Design A, as planned.** A new schema (illustrative `tmpos_invoice_void`), USAGE for `tmpos_app` only, because every migration since 017 except 029, 031 and 032 owns a new schema: older rollbacks drop their schemas without CASCADE and older suites assert exact inventories (EXISTING reason `020_m7a_tenant_role_levels.up.sql:17-19`).
- **Table** (illustrative `issued_invoice_void`): `invoice_id` primary key; `tenant_id`, `store_id`; a composite foreign key `(invoice_id, tenant_id, store_id)` to 034's `issued_invoice_scope_key`, ON DELETE and ON UPDATE RESTRICT (that key exists for this shape, EXISTING `034_m7b_invoice_issue.up.sql:366-368`); `voided_at` (database clock); `voided_by` (plain uuid, no FK, never returned); `reason_code` with a CHECK over D-VOID-4's list. RLS on, no policy, `revoke all` from every runtime role (034's pattern).
- **Guards**, all ENABLE ALWAYS: BEFORE UPDATE OR DELETE refusing every row change; BEFORE TRUNCATE; BEFORE INSERT admitting a row only for an issued invoice of the same tenant and store, with fixed-text refusals. Terminality follows: no path changes or removes a void record.
- **Projections.** New STABLE definer reads `page_v2` and `get_v2` return 034's columns plus `status` (`issued` or `voided`), `voided_at` and `reason_code`, by a primary-key join to the void table. 034's RETURNS TABLE cannot change in place and 034 must not be edited. The list keeps the 034 number index (`034_m7b_invoice_issue.up.sql:372`); the join needs no new index beyond the void table's primary key.
- **Anchor.** A rollback-order anchor whose SQL-standard body names, as reg* constants, every 034 function 035 calls (034's own pattern, `034_m7b_invoice_issue.up.sql:2217-2219`), because a plpgsql body records no dependency.
- **Kept intact.** The invoice number, the snapshot and the source-draft relationship. Lifecycle concurrency needs no editable snapshot version (§5 B).

### B. Command shape and kernel fit

- **Kind and mode.** `store.invoice.void`: mode update, a new aggregate type `issued_invoice`, aggregate id = the path's invoice id, context scope `store`, no events.
- **Version.** The planner sets `expectedVersion = 1`, because update mode requires an integer ≥ 1 (§3.3, constraint 4). The routine reads no version: it answers `applied` with version 2, the `expectedVersion + 1` that a mutator built on the issue's echo check expects (EXISTING `server/persistence/postgresInvoiceIssuing.ts:112`), and `invalid_state` whatever version is named, as the issue already does (EXISTING `034_m7b_invoice_issue.up.sql:1860-1862`). The store's contract words `invalid_state` as "there at the expected version" (`server/persistence/postgresTransactionalStore.ts:126-129`); the void follows the issue's precedent. The version is never sent on the wire and never stored. A version `conflict` is unreachable, but its sealed slot is still carried, as every command carries one. *(Adopted as refined, M7B-INVOICES-VOID-P1, ADR-51 decision 8 and §12.3: the routine does take the expected version, and decides it after its locks — an already voided invoice is `invalid_state` first, then a version other than 1 is `conflict`, otherwise it applies at version 2. The lifecycle version is 1 while issued and 2 once voided, derived from the void record, never stored and never on the wire; through HTTP `conflict` stays unreachable.)*
- **Why not create mode.** "Already void" could only be the sealed `write_conflict`, which departs from the adopted terminal-target rule (ADR:1447, ADR:1505), and `invalid_state` is sealed for update mode only (EXISTING `server/persistence/postgresTransactionalStore.ts:812-815`).
- **Why not a kernel extension.** A version-less update mode would touch every command's preparation for no gain.
- **Closed lists extended by name, each with its pin.**
  - `PRECONDITION_UPDATE_KINDS` gains `store.invoice.void` in both copies (`server/runtime/app.ts:525`, `server/persistence/postgresTransactionalStore.ts:303`).
  - A distinct audit-subject declaration value (illustrative `'voided_invoice'`), admitted for update mode on aggregate `issued_invoice` at store scope, from which the store derives `subjectIssuedInvoiceId` = the aggregate id. It cannot reuse `'issued_invoice'`: that value requires an `{ outcome: 'applied', subjectCustomerId }` answer, treats a bare `'applied'` as the fault and takes the subject from `changes.invoiceId` (EXISTING `server/persistence/postgresTransactionalStore.ts:752-755`, `:581`), and is admitted only on an `invoice_draft` aggregate (`:968-970`). The void mutator answers the bare `'applied'`; no customer or draft subject is set.
  - The writer rule admits exactly one subject, the issued invoice, for `store.invoice.void` at store scope (`server/platform-identity/auditEventWriter.ts:418-432`).
  - The mutator registry gains the void mutator.
  - No `RESERVED_ERRORS` or sealed-status change (EXISTING `server/runtime/idempotency.ts:133`).
- **The plan's audit annex** carries the reason code and its fixed sentence, within the existing bounds (EXISTING `server/runtime/commandTransaction.ts:144-162`).

### C. Transaction, lock order and races

**One transaction (EXISTING kernel).** Lease fence → revalidation (session hold, standing, scope, the sign-in deadline on the database clock, the void permission) → one definer routine → for `applied`: the void record (written by the routine), one audit record, the sealed completion, COMMIT, then the answer.

**Routine order (CONDITIONAL; mirrors the issue's derivation, `034_m7b_invoice_issue.up.sql:63-68`).**
0. Refuse unless the transaction is READ COMMITTED, as the issue does (EXISTING precedent `034_m7b_invoice_issue.up.sql:1663-1664`), because step 7 relies on it.
1. The caller, derived from the session key exactly as the issue does: 016's standing hold, the session and ledger, the issuer key, exactly one store grant at the store, membership, and the store row FOR SHARE.
2. Levels read unlocked: Invoices ≥ Approve and Customers ≥ View; the store owner is Full; any other role is `refused`.
3. Tenant mismatch → `precondition_failed` (the unsealed 409).
4. **The issued header FOR UPDATE**, selected by invoice id, derived tenant and path store only. A missing invoice, another store's and another tenant's are one `not_found`. A locking read fires no row trigger, so 034's UPDATE guard is not touched (PostgreSQL behaviour; proven only by VOID-04).
5. The session's clock and expiry, as the issue checks after its header lock (EXISTING `034_m7b_invoice_issue.up.sql:1827-1831`). RECOMMENDED: the routine also judges the 10-minute sign-in window itself, from the session row's `authenticated_at` (EXISTING column `011_m5_tenant_admission.up.sql:155`, bound into the mint at `018_m7a_tenant_session_mint.up.sql:241-242`; the routine already reads that row, `034_m7b_invoice_issue.up.sql:943-952`) on `clock_timestamp()`, so a direct definer call also needs a fresh sign-in; a missing `authenticated_at` is `refused`, as the chain refuses it (EXISTING `server/runtime/app.ts:956-957`).
6. For an editable role: `pg_advisory_xact_lock_shared(530030, …)` for that tenant and role, the clock again, and both levels re-read by plain reads, as top-level statements never inside an exception block (EXISTING pattern `034_m7b_invoice_issue.up.sql:1833-1837`).
7. **A separate statement** asks whether a void record of this invoice exists → `invalid_state`. Under READ COMMITTED a statement after a lock wait sees rows committed during the wait; folding this check into step 4's statement would evaluate the void table in the pre-wait snapshot and fall through to the primary-key backstop (a 503). (PostgreSQL behaviour; proven only by VOID-06.)
8. `clock_timestamp()` becomes `voided_at`.
9. One insert, inside one exception block that maps constraint violations to fixed text, then a verification read.
10. The answer `applied` with tenant, store, actor, membership and invoice id. The mutator accepts it only if every identity equals the revalidated context (EXISTING precedent `server/persistence/postgresInvoiceIssuing.ts:108-112`), then judges the sign-in deadline once more on the database clock after the routine's waits (EXISTING precedent `server/persistence/postgresInvoiceIssuing.ts:30-33`).

Nothing is written before the last refusal (DA-36). No draft, settings, customer or counter row is read or locked.

**Lock placement.** Prefix (fence → 016 hold → session/ledger → issuer key → membership/store FOR SHARE) → **issued header FOR UPDATE**, in the slot where the issue takes the draft header → 530030 SHARED → COMMIT. Argument, per path:
- The prefix is the issue's, taken in the same order.
- No existing writer locks a committed issued header. The only lock on an issued header today is the line guard's FOR SHARE on the issue's own uncommitted row, invisible to a void (EXISTING `034_m7b_invoice_issue.up.sql:643-646`). So only another void of the same invoice waits on this lock.
- The void INSERT's RI check takes FOR KEY SHARE on the header the routine already holds FOR UPDATE, so it never waits, and a row lock fires none of 034's triggers on `issued_invoice` (they fire on INSERT, UPDATE, DELETE and TRUNCATE, `034_m7b_invoice_issue.up.sql:762-775`) (PostgreSQL behaviour; proven only by VOID-04). 034's RESTRICT foreign keys (`:373-378`) would lock issued headers FOR KEY SHARE only on a delete or key update of a draft, store or customer row, which no routine performs; only owner teardowns do, and they are outside this argument.
- 530030 SHARED is compatible with the issue, edit and discard holders and the save (`031_m7b_invoice_create_authority.up.sql:626`, `032_m7b_invoice_create_customers_authority.up.sql:774`). Its EXCLUSIVE holders (level writers) take the role row, then wait for the key; they never wait on an issued header, so no cycle forms.
- Placing the header after 530030 is argued against: it would invert the uniform "target before key" rule and hold the key SHARED, delaying level writers, while one void waits behind another.

**Not established:** deadlock freedom. This is a per-path argument like 034's "no cycle" note; composed owner sessions, direct definer calls (DA-118), migrations' ACCESS EXCLUSIVE locks and future writers are outside it. A deadlock or a wait past the 1,400 ms lock timeout raises, rolls back and answers 503 with the lease kept (EXISTING `server/persistence/postgresTransactionalStore.ts:315-320`, lock and statement timeouts at 0.7 and 0.9 of the 2,000 ms deadline).

**Races (CONDITIONAL behaviour, each with a planned test).**
- **Two voids of one invoice:** one commits; the other waits at step 4, then reads the record at step 7 and is the sealed `invalid_state` (VOID-06).
- **Level narrowing:** one committed before step 6 refuses the void (the revalidator or step 6); one started after step 6 waits for the void's COMMIT (VOID-03).
- **Session or grant revocation:** it meets 016's hold in the revalidator and the routine, as for the issue (VOID-03).
- **A source lookup during a void:** the STABLE read sees one committed snapshot, issued or voided, never a mixture (VOID-10).
- **An issue of another draft, a settings write, a customer edit:** they share no lock with the void beyond FOR SHARE and SHARED holds.

### D. Lease, commit, sealed and unsealed answers, repeats

EXISTING kernel behaviour applied to the void (`server/persistence/postgresTransactionalStore.ts:40-44`, `:765-826`; `server/runtime/app.ts:1044`; ADOPTED ADR:1449):

| Answer | Status and body | Key and lease |
|---|---|---|
| Voided | sealed `200 { "invoice": { "id", "status": "voided" } }`, built from the plan before the transaction (no time or number) | sealed; replayed byte for byte with `Idempotent-Replayed: true` |
| Already void | sealed `409 { "error": "invalid_state" }` | sealed |
| Tenant changed | unsealed `409 { "error": "write_conflict", "requestId" }` | rolled back; the separately committed lease stays until it expires (60 s), then a same-key retry is re-planned |
| Missing, another store's or tenant's | unsealed `404`, one shape | as above |
| Revalidation, routine refusal, stale sign-in after the routine's waits, lease lost, timeout | `503` | as above; nothing committed |
| COMMIT sent, acknowledgement lost | `503`, outcome unknown | the lease is not released; a same-key retry replays the sealed 200 if it committed, or gets `409 request_in_progress` until the lease expires and is then re-planned |
| A body the contract refuses | `400 invalid_request` | after the key is taken; nothing recorded; the lease waits out its time |

No refusal releases the lease. Because a void is terminal in the database, no path voids twice either way. A resend after retention is a new operation, answered `invalid_state` if the first void landed: truthful, but not attributable to the first attempt.

### E. HTTP routes, eligibility and reads

| Method and path | Permission | Trusted context | Recent sign-in | Body | Idempotency |
|---|---|---|---|---|---|
| `POST /api/v1/stores/{storeId}/invoices/{id}/void` | the void key | required | **required** | JSON ≤ 1 KiB, exactly `{ "expectedTenant": <uuid>, "reasonCode": <code> }` | required |
| `GET /api/v1/stores/{storeId}/invoices/{id}/void-eligibility` | the void key | required | none | none | none |
| `GET /api/v1/stores/{storeId}/invoices` (answer changes) | `view_issued_invoices`, unchanged | required | none | none | none |
| `GET /api/v1/stores/{storeId}/invoices/{id}` (answer changes) | `view_issued_invoices`, unchanged | required | none | none | none |

- **Target.** The invoice id read directly before the route's own declared suffix, the suffix taken from the template, never the request; the path store must equal the trusted store (EXISTING `server/runtime/app.ts:982-1000`). The id selects; the routine re-derives authority from the session key.
- **Boundaries reused unchanged.** The distributed limiter, the pre-session Origin and CSRF checks (EXISTING `server/runtime/app.ts:841-860`), the session CSRF and the route authorizer. A query string on the command is accepted and ignored, as on the existing commands (ADOPTED D12:588); the reads refuse any query they do not define (D12:588).
- **Precedence.** One ordered list, each step once, in the chain's runtime order (EXISTING `server/runtime/app.ts:841-1061`), after the transport refusals that precede every route (404 `host_not_served`, then 400 when the client address cannot be resolved for the limiter; `server/runtime/app.ts:839-845`): 429 (the limiter, `:847`) → 417 for `Expect` (`:851-853`) → body admission 400/413/415 (framing, declared size, media type) → pre-session Origin/CSRF 403 → 401 (the session) → session CSRF 403 → 403 `forbidden` (the route authorizer) → 403 `authz_context_missing` (no trusted context, `server/runtime/app.ts:951`) → 403 `step_up_required` → 400 non-canonical store segment → 403 `authz_context_missing` (the path store is not the trusted store) → 400 target id → body read (413 past the cap as streamed, 400 malformed) → 400 idempotency key → replay / 409 `request_in_progress` / 422 `idempotency_key_reused` → 400 from the plan (the body schema). Inside the transaction: 503 lease → 503 revalidation → then the routine: 503 authority → unsealed 409 tenant → unsealed 404 → 503 session expiry, stale sign-in or levels re-read after the header lock → sealed 409 `invalid_state` → the adapter's deadline re-check 503 → 200.
- **Eligibility: action-only, labelled so.** It answers `200 { "eligibility": "allowed" }` exactly when the chain admits the void key at that store now, in the issue eligibility's form (EXISTING `server/runtime/invoiceIssuing.ts:625-639`). An allowed answer is not proof that the invoice exists, belongs to the store, is not already void, or that the sign-in is fresh enough. The resource-specific review is the detail read (below); the POST decides again. *(Adopted as refined, M7B-INVOICES-VOID-P1, §12.4: the eligibility keeps `recentAuth: 'none'`, as the read under the sensitive `edit_issuing_settings` key does (`server/runtime/issuingSettings.ts:368`), and is labelled action-only; an allowed answer is not proof that the sign-in is recent enough for the void, whose POST requires a sign-in within 10 minutes and otherwise answers `403 step_up_required`.)*
- **Reads (contract change).**
  - List rows keep their ten keys; `status` becomes `"issued"` or `"voided"`.
  - A voided detail gains one member, `"void": { "voidedAt": <instant>, "reasonCode": <code> }`, with `voidedAt` in the same instant encoding as `issuedAt` (the existing decoder, `src/tenant/invoiceIssuingClient.ts:382`), pinned by the planned HTTP and client tests (VOID-10); a never-voided detail has no such member.
  - `snapshotVersion` stays 1 (D-VOID-3). Cursors keep their meaning, because they anchor by invoice id.
  - `?sourceDraft=` keeps its unconditional branch and returns the voided invoice with its status.
  - No read returns the voiding actor.
- **Replay of an issue after a void.** An issue key replayed after a void replays its recorded `201` with `"status": "issued"` (EXISTING `server/runtime/app.ts:1044`) — true of the issue. The follow-up detail read shows the current lifecycle.

### F. Compatibility with the 29 routes, decoders and snapshot version 1

- **Inventories.** The shipping table goes from 29 to 31 routes (`server/entry/tenantEntry.ts:114-143`; pins `server/entry/tenantEntry.test.ts:204-247`, `tests/db/invoiceIssueHttp.integration.test.mjs:1872-1877`), the pinned business declarations from 24 to 26 (`tests/quality/production-runtime-contract.test.mjs:382-430`), the store templates from 13 to 15 and the store commands from 4 to 5 (`server/runtime/routes.ts:445-468`). All 29 existing declarations stay byte-identical; the answers of two of them change (next bullet).
- **The two changed reads.** Their declarations are unchanged (same path, permission and body); their answers change. That is a contract change even though the historical snapshot is identical. It needs, together: the v2 routines, the adapter's column lists and readiness probe (`server/persistence/postgresInvoiceIssuing.ts:352-353`, `:491-493`), the server decoders (`server/runtime/invoiceIssuing.ts:495`, `:539-540`), the route's status constant (`:113`), the shop decoders and types (`src/tenant/invoiceIssuingClient.ts:376-383`, `:417-423`), the two "Issued" literals (`src/tenant/ServerIssuedInvoices.tsx:1147`, `:1341`), and IIC-16, IIC-17 and IIC-18 kept rejecting every other status and key.
- **Mixed versions.** A shop that predates the change fails closed (`unavailable`) on any page or detail containing a voided invoice; it never shows a voided invoice as issued. This is why §6's checkpoints 1 and 2 are one deployable unit.
- **Explicit supersessions.** "Void is not available." in the issue confirmation (`src/tenant/ServerInvoiceDrafts.tsx:395`, SID-149 at `src/tenant/ServerInvoiceDrafts.test.tsx:5248`, and its browser copy `tests/browser/shopRoleLevels.browser.test.mjs:8495`); `FORBIDDEN` (`src/tenant/ServerIssuedInvoices.test.tsx:1510`) and SII-60's exact button set; `NOT_SAID` (`tests/browser/shopRoleLevels.browser.test.mjs:7950`) and SIS-06's exact button sets. Each changes deliberately, with the reason recorded.
- **Unchanged.** The issue's `201`, the issue preview, the eligibility routes, the settings routes and every draft route.
- **Root README.** It stays true until delivery (RM:318: "voiding an issued invoice is not available"); the delivery documentation changes it only when the void is built.

### G. Shop and recovery

- **Entry point.** The Issued invoices section's detail dialog (EXISTING `src/tenant/ServerIssuedInvoices.tsx:1280`) gains "Void invoice…". It shows only when the void eligibility answered `allowed` for this session, store and invoice and the detail shows the invoice as issued, in a row whose height is reserved from the asking on, with the dialog anchored at the top, so a late answer moves nothing (EXISTING pattern `src/tenant/ServerInvoiceDrafts.tsx:3276`). The drafts section's "View invoice" use of the same dialog does not offer it.
- **Authoritative review.** Opening the confirmation re-reads the detail once. If the invoice is already void, the dialog says so and no confirmation opens.
- **Confirmation.**
  - A stacked `alertdialog` with one description element, the D-VOID-4 text and identity line, and a required reason radio group with nothing preselected.
  - Initial focus is on "Keep invoice". "Keep invoice" and Escape send nothing and return focus to "Void invoice…".
  - "Void invoice" uses `aria-disabled` with a described reason: "Choose a reason first.", "Checking your session before sending…", "Another void is waiting to be confirmed.", or the wait text.
- **From the press.**
  - One press sends one POST under one new key, with the body serialized once, after a synchronous guard and a context recheck (EXISTING pattern `sendIssue`, `src/tenant/ServerInvoiceDrafts.tsx:2242-2284`). The attempt is held before the request leaves.
  - "Void invoice" is removed. "Keep invoice" becomes "Close", described by "Closing does not cancel the void; the server may have voided it anyway."
  - A `403 step_up_required` on a first send is decided before the key is read, so the attempt is dropped and, after re-authentication, a new press mints a new key.
- **Truthful outcomes.**
  - **Success** only after a validated 200 (the same id, `"voided"`): the confirmation closes, the detail is read again by GET — only the GET is retried, by "Load again" — and the section's status region says "Invoice *N* voided."; page one is re-read.
  - **Sealed `invalid_state`:** "Not voided: this invoice is already void.", then the detail is re-read.
  - **404:** "This invoice is no longer available."
  - **Unsealed `write_conflict`:** "Not voided: this store isn't part of that tenant any more."
  - **403:** after one fresh session check, the action is removed.
  - **401:** the existing session-ended path; only Reconnect signs in again (EXISTING `src/tenant/ServerIssuedInvoices.tsx:35`). **429:** the existing wait. **422:** the attempt ends.
  - **503, no answer or `request_in_progress`:** the attempt is unresolved, with "Check again" and "Check invoice" (D-VOID-5). A "Check invoice" read showing the invoice voided reports its current state; one showing it issued leaves the attempt unresolved. Only a sealed same-key answer or the user's dismissal ends the attempt.
- **Late-answer isolation.** Per-kind sequence numbers, an AbortController, the generation and the session-end count, as the issue's reads use; mutation answers settle by key in the hold, never by dialog. Closing a dialog or aborting a fetch never claims a rollback.
- **Hold.** A module-level, per-user, memory-only hold built on the existing generic store (EXISTING `src/tenant/ServerInvoiceDrafts.tsx:532-576`, used for issue at `:627-628`): bound to sign-out, detached on token or user change (`:892`, `:1249-1254`), with the 23-hour cutoff and a scrub timer that never sends. No browser storage, no URL, no `Location` following, no automatic resend. The source scans of SID-27, SID-167, SII-25, SII-60 and IIC-21 cover the new code.

### H. Migration 035 (PLANNED, NOT CREATED) and what moves in lockstep

*(Adopted as refined, M7B-INVOICES-VOID-P1, §12.5: the up and the down each take their ACCESS EXCLUSIVE locks in 034's writers' order before any check — the up on `public.store`, then 034's issuing tables including `issued_invoice`; the down on `public.store`, `issued_invoice`, `issued_invoice_void` and `public.audit_event` — and decide under READ COMMITTED. The up also requires 034's exact objects (`issued_invoice_scope_key` as `UNIQUE (invoice_id, tenant_id, store_id)`, the page and get with their exact signatures and `tmpos_app`'s EXECUTE) and re-words the comment on `public.audit_event.subject_issued_invoice_id` to name the void beside the issue, which the down restores to 034's exact text. The apply and the down run with the tenant runtime stopped. While 035 is applied, 034's down fails at 55000 with issued data and at 2BP01 on an empty issuing state. Every affected `DOWN_034` chain is to run 035's down first (§12.8, VOID-14 (g)). 035 is to be written in this stage; at adoption it is not in the committed migration chain, and the "This stage creates no file" below describes P0.)*

- **Number.** The chain ends at `034_m7b_invoice_issue.{up,down}.sql` and the preflight requires exactly 001–034 (EXISTING `server/persistence/postgresStartupPreflight.ts:59-94`). The next is 035. This stage creates no file.
- **Up.**
  - Apply-time locks in 034's writer order plus the issuing tables.
  - Refusals unless 001–034 are exactly applied, unless none of its own objects exist, and unless the runtime roles exist.
  - Creates the schema, table, guards, routine, v2 reads and anchor; grants USAGE, plus EXECUTE on the void routine and the two v2 reads to `tmpos_app` only; trigger functions to nobody; revokes `tmpos_app` EXECUTE on 034's page and get.
  - Ends with an exact postcondition. It changes no existing row.
- **Down.**
  - The same locks.
  - It refuses unless 035 is exactly applied, and while any void record exists or any audit record of action `store.invoice.void` exists. Such records also name an issued invoice, which 034's down already refuses on (EXISTING `034_m7b_invoice_issue.down.sql:127-140`).
  - It deletes nothing, restores `tmpos_app` EXECUTE on 034's page and get, drops anchor, routines, table and schema without CASCADE, and ends with the exact 034 catalog as its postcondition.
  - After the first void it is one-way in practice.
  - While 035 is applied, 034's down is not refused by a guard of its own on an empty business database: it fails on the dependency (2BP01) from 035's foreign key and anchor. With issuing data it refuses as it does today (`034_m7b_invoice_issue.down.sql:127-140`). Operators roll 035 back first.
- **Runtime and database versions.** They move together. The preflight's `REQUIRED_MIGRATIONS` (with 035's checksum) and its exact `APPROVED_ROLE_GRANTS` (losing 034's page and get, gaining 035's USAGE and three EXECUTE entries) change in the same commit (EXISTING `server/persistence/postgresStartupPreflight.ts:59-94`; the grant list `:110`, 034's entries `:137-142` and `:176`; the check `:375-382`). A 034-built runtime refuses a 035 database, and a 035-built runtime refuses a 034 database.
- **Pins that move with it.**
  - The migration files contract goes from 68 to 70 files, with SHA pins (`tests/quality/migration-files-contract.test.mjs:400-415`).
  - The managed launcher's version lists (`tests/quality/managed-m005-launcher.test.mjs`).
  - IIR-06's exact surface (`tests/db/invoiceIssueRoutine.integration.test.mjs:993`), because 034's reads lose `tmpos_app` EXECUTE.
  - IIR's catalog snapshot, which lists the internal triggers on 034's relations (`tests/db/invoiceIssueRoutine.integration.test.mjs:636-641`), because the foreign key adds two.
  - The level-default restatement pins for the new routine (`tests/db/tenantRoleLevelRoutine.integration.test.mjs`).
- **Test chains.**
  - Eleven database suites hard-code `DOWN_034`. Two are confirmed to meet 035 in committed full-port chains: `tests/db/roleLevelVersionRoutine.integration.test.mjs` (`DOWN_034` committed at `:327-330`) and `tests/db/customerDirectory.integration.test.mjs` (the full apply at `:214`, `DOWN_034` committed at `:1435`); these need `DOWN_035` first or a bound. `tests/db/invoiceIssueRoutine.integration.test.mjs` runs `DOWN_034` inside rolled-back transactions (`:831-839`, `:937`) that would meet 035's dependency. The other eight are not traced.
  - The fourteen suites using `rollBackAbove` take 035 automatically (`tests/db/migrationsThrough.mjs:30`), provided 035's down does not refuse on the shared CI database.
  - CI runs on one shared database, so suites that roll 035 back must run before suites that leave void rows (`.github/workflows/ci.yml:496-555`). The HTTP harness's owner teardown deletes void rows before issued invoices (the foreign key restricts), with guards lifted, and its "nothing left" check includes them.

### I. Observability, privacy and residual exposure

- **Logs (CONDITIONAL; a planned assertion, VOID-13, not an EXISTING guarantee).** The request log line would carry the route class, request id, status and one reason word, and never the key, token, body, reason code, customer or seller text.
- **Codes only.** With D-VOID-4's recommendation no free text exists. The shop renders the code's fixed label as text.
- **Shop memory.** The shop keeps key and bytes in memory only.
- **Audit content.** The audit record copies no line, customer or seller value.
- **DA-118 widens.** A runtime-role holder with a live session key at Invoices Approve could call the void routine directly and void an invoice with no audit record, idempotency completion or HTTP checks (the class recorded at D08:408 for the issue). With §5 C's recommended step 5 the routine still requires a fresh sign-in; without it, a direct call needs none. DA-118 stays an open pre-deployment blocker and would be amended at delivery.
- **DA-119 widens.** A direct level set (021, 026) also changes who can void.
- **Audit evidence is weaker than the void record.** `trg_audit_event_reject_mutation` is not ENABLE ALWAYS (EXISTING `002_authorization_audit_foundation.up.sql:294-295`), so against an owner or superuser session in replica mode a void's audit evidence is weaker than its ENABLE ALWAYS void record. This is inside the declared owner and superuser boundary (the DA-48 class) and is an input to G-AUDIT and G-BACKUP/DA-213; this pack proposes no separate entry.
- **Restore.** A data-only restore of void records meets their ENABLE ALWAYS guards, which extends DA-213's input to G-BACKUP.

## 6. Delivery checkpoints (CONDITIONAL)

**0. Owner decisions recorded.** The owner returns §11. No code starts before that.

**1. Server, database and HTTP (one commit, then exact-SHA CI).**
- Migration 035, the routine and the v2 reads.
- The adapter mutator and readers, and the readiness probe.
- The route, contract and permission; the widened guard; the kernel list extensions; the writer rule.
- The changed list and detail answers; the eligibility route.
- The preflight and inventories.
- The database, HTTP, unit and quality tests of §7.
- CI step order.

Every never-voided answer stays byte-identical, so the existing shop's tests still pass at checkpoint 1, because none of them voids an invoice; but the shop is not compatible with voided invoices until checkpoint 2 (§5 F, mixed versions). Checkpoints 1 and 2 are separate commits but one deployable unit: checkpoint 1 must never be deployed or run against shop users on its own. Nothing is deployed in any case. *(Superseded at adoption, M7B-INVOICES-VOID-P1, §12.0: the server's read switch (the v2 reads, the adapter and the server decoders) and the shop's decoders and labels land in ONE commit, one compatible unit, and no CI run ever runs on a server-only head; the shop's void action, confirmation, hold and recovery form P2. This document's own checkpoint, the adopted contract in §12, precedes that commit.)*

**2. Shop (one commit, then exact-SHA CI).**
- The client methods and decoders.
- The labels, the action, the confirmation, the hold and the recovery.
- The superseded no-void assertions, each named.
- The browser scenarios and the raised floors.

**3. Status documentation (one commit, then CI).**
- The next ADR (ADR-51 at today's numbering).
- [05](./05-canonical-data-ownership-and-api-db-contracts.md) §2's void paragraph and a D05:58 annotation.
- [08](./08-production-gate-and-risk-register.md) amendments to DA-183, DA-186, DA-118 and DA-119, plus residual rows.
- The [09](./09-roadmap-m0-m9.md) progress block.
- RM:318.
- This document marked adopted.

At each checkpoint: stage named paths, verify the staged tree, push an ordinary fast-forward, and read every CI job on that exact commit. A real correction afterwards is a narrow follow-up commit; history is not rewritten. Nothing is deployed.

## 7. Planned acceptance evidence — every row PLANNED — NOT RUN

None of the existing issuing evidence (IIR-01 to IIR-17, IIH-01 to IIH-13, ISH-01 to ISH-09, SID-148 to SID-189, SII-01 to SII-68, SIS-06 to SIS-15) proves anything about a void. Those suites are reused as harnesses and re-run as regression evidence (VOID-15); every other row below is new proof. Layout claims need a real browser; mocks do not prove database or HTTP integration; waits are deterministic barriers (owner-held locks observed in `pg_locks`, parked triggers, the relay's commit trap), never sleeps; no viewport is weakened to obtain a green result.

| ID | Brief §7 | Planned assertion → expected observation | Layer | Extend / template | Status |
|---|---|---|---|---|---|
| VOID-01 | 1 | With levels set through the real `PUT /api/v1/roles/levels`: Invoices Edit or Manage, or Approve without Customers View → 403 at the eligibility and the POST, nothing written. Approve or Full with Customers View, and the store owner, → allowed. `manager` set to Edit → 403 (the role name grants nothing). A read-only actor, tenant or store → 403. A technician's direct POST → 403. The routine below Approve → `refused`. A provider sign-in older than 10 minutes → `403 step_up_required` with no idempotency record; a fresh one → 200. Routine level, with no HTTP chain: a session whose `authenticated_at` is older than 10 minutes, or missing, → `refused` (§5 C step 5). The load guard admits the new key only in its exact shape | HTTP + routine + unit | `tests/db/invoiceIssueHttp.integration.test.mjs` (IIH-01, `putLevel`); `tests/db/invoiceIssueRoutine.integration.test.mjs` (IIR-08); `tests/db/issuingSettingsHttp.integration.test.mjs` (ISH-02 sign-in age); `server/platform-identity/m5CanonicalPermissions.test.ts` | PLANNED — NOT RUN |
| VOID-02 | 2 | A missing id, another store's and another tenant's invoice → the same 404 status, body shape and logged reason (only `requestId` differs). A store where the actor has no grant → 403. A path store unlike the trusted store → 403 `authz_context_missing`. Nothing written; no invoice data in any refusal | HTTP | IIH-02; `tests/db/invoiceDraftDiscardHttp.integration.test.mjs` (IDDH-06) | PLANNED — NOT RUN |
| VOID-03 | 3 | Over two tenant entries: a level narrowing committed while the void waits on key 530030 → 503, nothing but the lease. A session revocation committed while it waits at 016's hold → 503. A sign-in deadline passing during the routine's wait → 503 rolled back, and the routine's own sign-in check refuses it on the database clock after the header lock. A narrowing started after the void's level re-read waits for its COMMIT | HTTP + routine | IIH-13 (c)(d); ISH-06, ISH-09; IIR-12 | PLANNED — NOT RUN |
| VOID-04 | 4 | 200 `{ invoice: { id, status: "voided" } }`. Delta: one void record, one audit record (action, permission, store scope, actor, tenant, store, `subject_issued_invoice_id` = the invoice, the reason code, metadata `{}`), one completion, no outbox row. The issued header and lines byte-identical in every column; the counter unchanged; the source draft still `issued` at its version | HTTP + routine | IIH-03 (`counts`, `delta`); IIR-15; IDDH-16 | PLANNED — NOT RUN |
| VOID-05 | 5 | The same key and bytes → replay with `Idempotent-Replayed: true`, nothing new. The same key with another body or invoice → 422. An issue key reused on the void → 422. A new key on a voided invoice → sealed `invalid_state`, no second audit record. Past retention the same key is a new operation → `invalid_state`. After the role is lowered, a replay → 403, not the stored answer | HTTP + unit | IIH-06 (`expireRetention`); IDDH-09, IDDH-10 | PLANNED — NOT RUN |
| VOID-06 | 6 | Two entries, two keys, the owner holding the issued header: both wait (seen in `pg_locks`); on release exactly one 200 and one sealed `invalid_state`, one void record, one audit record. Routine level: the existence check runs after the header wait; a build that folds it into the locking statement answers 503 from the primary key and fails this test. The routine under REPEATABLE READ and SERIALIZABLE are each refused and READ COMMITTED succeeds (step 0; 034's precedent) | HTTP + routine | IIH-09 (nested `withEntry`, `hold`); IIR-12 (`holding`, `blockedBy`) | PLANNED — NOT RUN |
| VOID-07 | 7 | A stale lifecycle version is inapplicable: no version is accepted on the wire, and a body carrying a version or any extra key → 400 (after the key). A stale `expectedTenant` → unsealed 409 `write_conflict`, rolled back, lease kept. A void committed by another entry while a second waits → `invalid_state`. In the shop, a confirmation opened on an invoice voided meanwhile shows it as void and sends no POST; a confirmation pressed after another void committed is settled under the server lock as `invalid_state` | HTTP + section + browser | IIH-04, IIH-13; SIS-13; SID-155, SID-156 | PLANNED — NOT RUN |
| VOID-08 | 8 | An owner trigger raising at the void record INSERT, at the audit INSERT and at the completion → 503 each, no void record, no audit, no completion, the lease open (the lease-only delta). The same key → `409 request_in_progress` until `expireLease`, then re-planned. The shop shows unresolved, never success | HTTP + section | IIH-08 (`withTrigger`, `fired`); IDDH-11, IDDH-12 | PLANNED — NOT RUN |
| VOID-09 | 9 | Database: the commit trap in "lose" mode (anchored on the audit INSERT) → 503, the invoice voided once, a same-key retry replays the 200; in "cut" mode → rolled back, and after `expireLease` a retry re-plans → 200. Browser, separately: the front drops the response after the commit → the shop is unresolved; "Check again" sends the same key and bytes → the replayed 200 → "voided"; one void, one audit, one completion | HTTP + browser | IIH-07 (`trapCommit`); IDDH-13; SIS-12 (`st.lose`) | PLANNED — NOT RUN |
| VOID-10 | 10 | The list row reads `"voided"` in its number's position. The detail reads `"voided"` with `void { voidedAt, reasonCode }` and an otherwise byte-identical snapshot. `?sourceDraft=` returns the voided invoice. Never-voided answers are byte-identical to the 034 answers. Shop decoders accept `"voided"` only with the void member and still reject every other status and extra key. "Find issued invoice" on an issue attempt whose invoice was later voided says it was issued as invoice *N*, later voided | HTTP + routine + client + section + browser | IIH-02, IIH-03; IIR-17; IIC-16, IIC-17, IIC-18; SII-45 to SII-68; SID-164; SIS-06, SIS-07 | PLANNED — NOT RUN |
| VOID-11 | 11 | With injected clocks: the attempt survives close, reopen, navigation and a store change. It becomes unsendable on sign-out, user change and a new token. Nothing is sent from mount, focus, timers or renewal. "Check again" uses the same key, bytes, token and store. The cutoff is 23 hours from the first send, by the larger of monotonic and wall time, never extended; the scrub clears the bytes without sending. While the attempt is held, "Check invoice" answering `voided` reports the invoice void, and answering `issued` (the POST still held) leaves the attempt unresolved; only a sealed same-key answer or a dismissal ends it. A remount without the module state (a reload's effect) loses the attempt, and the section then shows the invoice's current state without attributing it to the lost attempt. Browser: close, reopen and navigation with a held answer. Expiry has jsdom evidence only: no browser time technique exists | section + browser | SID-161 to SID-166, SID-177 (`rig`, `fakeClock`); SIS-12 (`st.gates`), SIS-14 | PLANNED — NOT RUN |
| VOID-12 | 12 | `alertdialog` with the name "Void invoice *N*?"; the description equal to the consequence and identity text; initial focus "Keep invoice"; Escape before sending sends nothing and returns focus. The reason group is required; "Void invoice" is `aria-disabled` with its described reason; after the press, Close is described by the "does not cancel" warning. At 1440×900, 768×1024, 320×640 and 320×480 and at a 24 px text size, with long seller and customer names, the dialog does not scroll sideways and a late answer does not move Close or "Keep invoice". At every short viewport, including a named cell of 320×480 **with** a forced 24 px text size: the reason choices and both actions are reachable by vertical scroll inside the dialog, the focused element is visible, focus stays inside and returns on close, and Enter and Space activate the controls. No WCAG conformance claim | browser + section | SIS-15 (`Page.setFontSizes`, viewport matrix); SDB-23; SID-149 pattern | PLANNED — NOT RUN |
| VOID-13 | 13 | A body of exactly 1 KiB → accepted; 1 KiB + 1 → 413 with no idempotency record; a wrong media type → 415; an unknown reason code or an extra key → 400 after the key. The reason renders as fixed text. The raw code, key, token and body never appear in logs, browser storage or the URL; the DOM shows only the code's fixed label, in the confirmation and the detail; the source scans cover the new modules | HTTP + client + section + browser | IIH-11 (`rawRequest`, `chunked`), IIH-12; IDDH-19; SID-167; IIC-21; SII-25, SII-60 | PLANNED — NOT RUN |
| VOID-14 | 14 | 035 apply: postcondition and refused re-apply; the up over existing issued invoices leaves them byte-identical; the down restores the exact 034 catalog. The down is refused while any void record or void audit record exists. 034's down, while 035 is applied, fails on the dependency (2BP01) from 035's foreign key and anchor. Exact grants, with 034's page and get no longer executable by `tmpos_app` and restored by the down. The 034 runtime refuses a 035 database and vice versa. The files contract has 70 files. The `DOWN_034` chains are updated | routine + quality + preflight | IIR-01 to IIR-06; `tests/quality/migration-files-contract.test.mjs`; `tests/db/productionEntryPreflight.integration.test.mjs`; the preflight unit suite | PLANNED — NOT RUN |
| VOID-15 | 15 | Every existing behavioural guarantee of the issuing, draft and discard suites holds unchanged, other than the explicitly superseded no-void availability assertions (§5 F). The mechanical pins that must change are named and changed deliberately: the inventories (routes 29 → 31, business declarations 24 → 26, store templates 13 → 15, store commands 4 → 5), the migration files (68 → 70) and their checksums, the grant pins, IIR-06 and IIR's catalog snapshot, the `DOWN_034` chains, the decoders, the readiness probe, the HTTP harness's teardown and the superseded no-void assertions (§5 F). An edit or discard of a voided invoice's source draft is still `invalid_state` (IIR-14), and so is an issue of it (IIR-12, IIH-06). The next issue at the store takes the next number, with no gap filled | all existing layers | IIR-14 (edit, discard); IIR-12, IIH-06 (issue); IIH-01 to IIH-13; IDDH-*; SIS-06 to SIS-15; SID-148 to SID-189; SII-01 to SII-68 | PLANNED — NOT RUN |

Focused negative controls, once per critical boundary, not a mutation campaign: remove the void-record existence check → VOID-05 and VOID-06 fail; drop the adapter's sign-in re-check → VOID-03 fails; let the list decoder ignore `status` → VOID-10 fails.

## 8. P2 residuals carried

These are the M7B-INVOICES-ISSUE-P2 evidence limits, carried as they stand; this pack neither recertifies P2 nor closes any of them. DA-221 and DA-222 are the two limitations this stage found unrecorded and added to the register (D08:511-512), both open.

| Residual | Where it stands | DA |
|---|---|---|
| "Find issued invoice", the `?sourceDraft=` lookup, the 23-hour window and the attempt's survival across close, reopen, store change and navigation have no real-browser coverage; their evidence is client or component (SID-164 to SID-166) or server-only. SIS-12 is the only real-browser case that recovers an outcome; SIS-14 covers the detach at a session end (D12:695) | Recorded by this stage (DA-209 covers the draft editor only, DA-217 layout only) | **DA-221** (D08:511), consolidated with the next row |
| A full reload with an unresolved issue attempt is not tested; the in-memory attempt is lost on reload by design (ADOPTED ADR:1505; EXISTING `src/tenant/ServerInvoiceDrafts.tsx:474-476`) | Recorded by this stage (DA-190 is the save's analogue) | **DA-221** (D08:511) |
| An issuing-settings attempt disappears when its panel unmounts | Recorded | **DA-219** (D08:509) |
| SDB-23's former 600 px case now uses a 1,200 px window height for the 24 px-text cell (`tests/browser/shopRoleLevels.browser.test.mjs:6914`). This does not establish that the former short-height behaviour is preserved. Earlier stage records describe the 1,000 px height (D08:839, D11:417, ADR:1486); they stay as history | Recorded by this stage; D12:710 notes only the taller reopen dialog | **DA-222** (D08:512) |
| The `/invoices` page scrolls sideways at 320 CSS px because of code outside the issuing slice; new-surface layout tests do not close it | Recorded | **DA-214** (D08:504), with DA-216 and DA-217 |
| No screen-reader run and no automated semantic accessibility audit were performed | Covered by the open gate | **G-A11Y** (D08:280, OPEN); no separate entry proposed |
| The owner's Manual QA of the P2 shop | PENDING | Not a register item |
| P2's two failed first CI runs: `c834b4d` run 39029335800 failed SIS-09 and the test-only `a7d645d` had a successful exact-commit run; `45c9e55` run 39070294278 failed SIS-14 and the test-only `ae3d2b1` had a successful exact-commit run | Recorded as failed, with their corrections (D08:875) | — (not a first-attempt success and not a general flake repair) |

No concrete safety defect that blocks the proposed design was found in the source reviewed for this pack. DA-36's structural remedy remains open. Direct definer calls (DA-118) and TypeScript-only audit provenance (DA-114's class, recorded for tenant-scope rows) are existing design properties, recorded, not defects introduced here.

## 9. Dependencies and explicit deferrals

| Item | Needed for the void slice | Effect of this pack |
|---|---|---|
| DA-186 (lifecycle, D08:476) | Its void part, decided by §11 | Stays OPEN until accepted; payments, amounts due, credit notes and the rest stay undecided |
| DA-187 (retention and privacy, D08:477) | No: a void deletes nothing | Unchanged; void records join the data a retention decision must cover |
| DA-118, DA-119 (D08:408-409) | No, but widened at delivery (§5 I) | Stay OPEN pre-deployment blockers |
| DA-183, DA-184 | Yes: decide on the stored level, with an HTTP witness | Amended at delivery |
| DA-36 | Yes: the routine writes nothing before its last refusal | Structural remedy still open |
| DA-213 / G-BACKUP | No | Void records are a further input |
| DA-189, DA-203 | No: the void takes no customer input | Unchanged |
| DA-60 / G-PERF | No: voids serialize per invoice only | Unmeasured, unchanged |
| DA-214 to DA-220 | No | Unchanged |
| G-ENTITLE | No: no plan gate applies to Invoices | Unchanged, OPEN |
| G-A11Y, G-AUDIT, G-IAM, G-PERSIST, G-IDEMPOT, G-PRIVACY | No gate closes because of this pack or its implementation alone | OPEN |

DEFERRED, outside the slice: unvoid or restore; credit notes and partial corrections; payments, refunds and amounts due; tax reversals and filings; printing, sending and delivery; replacement creation and invoice links; a voided-only view or filter; free-text reasons; deletion, erasure and retention; the stores' jurisdictions and legal review (F-2); deployment.

**Not claimed.** Voiding or correction is available; any policy is adopted; any jurisdiction's invoice rules are met; any lock order is deadlock-free; any test in §7 has run; any CI result for the commit that carries this document; M7b completion; legal or production readiness; deployment. All 37 production gates stay OPEN (D08:572, D08:882), and nothing is deployed.

## 10. For information, not owner decisions

The proposed routes are `POST /api/v1/stores/{storeId}/invoices/{id}/void` and `GET /api/v1/stores/{storeId}/invoices/{id}/void-eligibility`, with the lifecycle on the existing list and detail (§5 E). The illustrative names — schema `tmpos_invoice_void`, table `issued_invoice_void`, permission `void_issued_invoices`, kind `store.invoice.void`, status value `voided` — are fixed at implementation.

## 11. Owner decision table and response template

| # | Decision | Recommendation in brief | Main alternative | Implementation depends on it |
|---|---|---|---|---|
| D-VOID-1 | Meaning and boundary | Terminal logical void; number, snapshot, source draft kept; no refund, credit note, tax reversal or erasure; any issued invoice of the store; no unvoid | Void with restore | Yes |
| D-VOID-2 | Authority and sign-in | Dedicated store permission at Invoices Approve + Customers View; never read-only; recent sign-in required | No recent sign-in; or Full | Yes |
| D-VOID-3 | Visibility | Listed and openable, labelled Voided, original number and contents, with the void time and reason shown to issued-invoice readers; no filter; "Find issued invoice" still finds it; the recorded contents keep their meaning and the Voided status is a separate field | Hide voided invoices | Yes |
| D-VOID-4 | Confirmation, reason, records | Named confirmation; a required reason from a closed list, no free text; one audit record (database clock); no event | Free text; or no reason | Yes |
| D-VOID-5 | Repeats and unknown outcomes | A new void of an already voided invoice is refused as already void; re-sending the same request returns its first answer; an unconfirmed attempt is kept outside the dialog; Check again (the same request, within 23 h, while the sign-in is fresh) and Check invoice ("Issued" there does not end the attempt); no automatic resend | Silent success; or tracking only while the dialog is open | Yes |
| D-VOID-6 | Correction scope | Void only; correct by a fresh draft and a new number, unlinked in this slice | Recorded link; or replacement creation now | No (alternatives add a slice) |

**Response template.** Copy, fill in each bracket and send. Each line starts as a placeholder; nothing is recorded as accepted until the owner sends it. ACCEPT accepts the full §4 text of that decision, not only the summary line. "CHANGE" replaces that recommendation in §4 and §5.

```
M7B invoice void and correction — owner decisions
D-VOID-1 meaning:      Terminal logical void of an issued invoice (issued -> voided, once); number, snapshot
                       and source draft kept; no refund, credit note, tax reversal or erasure; any issued
                       invoice of the store may be voided; no unvoid or restore in this slice
                       [ACCEPT | CHANGE: …]
D-VOID-2 authority:    New store permission at Invoices Approve or above plus Customers View on the store
                       grant's role; never read-only; no role-name, System Owner or creator shortcut;
                       recent sign-in (10 minutes) required on the void
                       [ACCEPT | CHANGE: …]
D-VOID-3 visibility:   Voided invoices stay in the issued list and detail, labelled Voided, with the original
                       number and contents; the detail shows the void time and reason to everyone who may
                       read issued invoices; no status filter or voided-only view; "Find issued invoice"
                       still finds them;
                       the recorded contents keep their original meaning and the Voided status is a
                       separate field (the owner's reading of the version-1 rule)
                       [ACCEPT | CHANGE: …]
D-VOID-4 records:      Confirmation naming invoice number, store, customer, Total and issue time; a required
                       reason from a closed list, no free text; one audit record (actor, invoice, store,
                       tenant, database clock); no event sent to other systems
                       [ACCEPT | CHANGE: …]
D-VOID-4 reasons:      Issued by mistake; Wrong customer; Wrong lines or amounts; Wrong seller details;
                       Duplicate of another invoice; Other reason (the internal codes are illustrative)
                       [ACCEPT | CHANGE: …]
D-VOID-5 repeats:      A new void of an already voided invoice is refused as already void (no silent
                       success); re-sending the same request returns its first answer; an unconfirmed
                       attempt is kept in memory outside the dialog; sign-out, a user change or a new
                       session makes it unsendable but keeps its notice; a store change keeps it; a reload
                       loses it; Check again (the same request, within 23 h of the first send, while the
                       sign-in is fresh) and Check invoice, where "Voided" settles the invoice's state but
                       "Issued" leaves the attempt unresolved until Check again answers or the user
                       dismisses it; nothing re-sends on its own
                       [ACCEPT | CHANGE: …]
D-VOID-6 correction:   Void only in this slice; correct by a fresh draft issued under the next number; no
                       copy and no recorded link between the two invoices
                       [ACCEPT | CHANGE: …]
```

Only the owner's returned choices authorize adopting any of this policy.

## 12. P1 implementation contract (ADOPTED, M7B-INVOICES-VOID-P1)

**Status of this section: ADOPTED by the owner's stage instruction of 2026-10-18 ([10](./10-architecture-decision-records.md) ADR-51); implementation in progress.** It is the contract stage M7B-INVOICES-VOID-P1 implements, written down before any of it is wired: at adoption none of it is committed, run or deployed. §4–§7 apply only as reconciled by this section, which names each refinement it makes. The names below are fixed; they are no longer illustrative (§10).

### 12.0 Stage split

- **P1 (this stage).** Migration 035; the void command `POST /api/v1/stores/{storeId}/invoices/{id}/void`; the action-only `GET /api/v1/stores/{storeId}/invoices/{id}/void-eligibility`; the lifecycle on the existing issued list and detail, in the server and the shop decoders together, as one compatible unit (below); the minimum shop display (an "Issued" or "Voided" label, the void time and reason on the detail, and truthful "Find issued invoice" recovery text); tests; documentation.
- **P2 (not this stage; PLANNED — NOT RUN).** The shop's "Void invoice…" action, its confirmation, reason picker, held void attempt, "Check again" and "Check invoice", the step-up wiring for it, and their browser evidence (VOID-11, VOID-12, the shop halves of VOID-07, VOID-08 and VOID-09, and the confirmation's half of VOID-13). The issue confirmation's sentence "Void is not available." stays true in P1, because the shop offers no void, and is superseded only in P2.
- **One compatible unit (overrides §6's checkpoint 1/2 split).** The server's read switch (the v2 reads, the adapter and the server decoders) and the shop's decoders and labels land in ONE commit (the stage's checkpoint B), and no CI run ever runs on a server-only head. Today's shop fails closed on a voided answer: its keys are exact and `status !== 'issued'` makes the page `unavailable`.
- **Record before switching.** This section records §12.4's read contract before any reader switches. The reads change in place under `/api/v1`, with no `/api/v2` route: the smallest compatible wire contract, because the v2 names belong to the database routines only. This documentation checkpoint (A) is to be pushed and CI-green before checkpoint B is committed.

### 12.1 Policy mapping (ACCEPTED; ADR-51 records it)

- **D-VOID-1.** A terminal logical void, recorded once, of any issued invoice of the authorized store; its number, snapshot and source draft unchanged; no unvoid or restore in this slice; no refund, credit note, tax reversal or erasure.
- **D-VOID-2.** A new store permission `void_issued_invoices`: Invoices ≥ Approve and Customers ≥ View on the store grant's role (the built-in `store_owner` role's levels are Full, fixed and never stored, so it qualifies through those levels, never by its name); never under a read-only actor, tenant or store (the write statuses `active` and `trialing` only). A recent sign-in within 10 minutes, judged by the chain, the revalidator, the routine itself (the trusted session row and the database clock) and the adapter after the routine. No role-name, System Owner or creator shortcut; no Invoices plan gate (none exists, §3.1).
- **D-VOID-3.** Voided invoices stay in the list, the detail and `?sourceDraft=`; `snapshotVersion` stays 1; the lifecycle is a separate field.
- **D-VOID-4.** A required closed reason code (§12.2); one audit record through the HTTP command path; no event.
- **D-VOID-5.** A new key on a voided invoice → the sealed `invalid_state` ("already void"); the same key and the same bytes → the sealed answer replayed under the chain's current checks; the shop's parts are P2.
- **D-VOID-6.** Void only; no link, copy or replacement.
- **D-ISS-7's ambiguity, resolved (§3.2; ADR-51).** [12](./12-m7b-invoice-issue-decision-pack.md)'s "records a reason" means a REQUIRED reason code from §12.2's closed list. No free text exists anywhere, and "Other reason" has no hidden free-text field.
- **Other adopted texts the void reinterprets (ADR-51 records each).** (i) Under D-VOID-3 a separate lifecycle field is not a change of the issued snapshot's "read semantics" under D12:628 or ADR-50's Decision 1, so `snapshotVersion` stays 1 and version-1 contents keep their meaning. (ii) The shipped state value is `voided`, replacing the `void` of D12:161 and D12:167; §3.2's illustrative `voided` is now fixed. (iii) ADR-50 carries an addendum: the issued reads will return `issued` or `voided`; at adoption the void is decided but not in code or live.
- **DA-118 and DA-119 will widen when 035 lands (checkpoint B); both stay OPEN.** Once 035 exists, a holder of `tmpos_app` plus a live session key at Invoices ≥ Approve and Customers ≥ View will be able to call `tmpos_invoice_void.m7b_invoice_void` directly and void with no audit record, no idempotency completion and none of the HTTP checks (the void record still records `voided_by`). The routine's own sign-in check narrows this to sessions whose `authenticated_at` is within 10 minutes, but that value is minted evidence (bound into 018's mint message), so an issuer-key holder (DA-93, DA-94) can mint it fresh at will. A direct level set (021, 026) will change who can void (DA-119). The two v2 reads will join DA-132's direct-read class (the void time and reason to a live-key holder; never `voided_by`). Nothing here claims that a direct routine call has the command path's audit coupling. [08](./08-production-gate-and-risk-register.md) amends the DA-118 and DA-119 rows with the stage's final documentation (checkpoint C).

### 12.2 Reason codes

Pinned in this order in the database CHECK, the server enum and the shop's label map:

| Code | Label (shop text and audit sentence) |
|---|---|
| `issued_in_error` | Issued by mistake |
| `wrong_customer` | Wrong customer |
| `wrong_lines_or_amounts` | Wrong lines or amounts |
| `wrong_seller_details` | Wrong seller details |
| `duplicate` | Duplicate of another invoice |
| `other` | Other reason |

The audit annex: `reasonCode` is `invoice_void_<code>` (for example `invoice_void_issued_in_error`), and `reason` is the fixed sentence `Issued invoice voided. Reason: <label>.` Nothing else; no customer, seller or line text.

### 12.3 Lifecycle, version and precedence (REFINES §5 B)

- An issued invoice's lifecycle version is **1 while issued and 2 once voided**, derived from the presence of its void record: never stored, never on the wire. The snapshot stays immutable, and the lifecycle version is not a snapshot version.
- The planner always sets `expectedVersion = 1` (update mode needs a version ≥ 1). The routine takes `p_expected_version` and decides, in this order after its locks: **already void → `invalid_state`** (terminal state before version, the issue's precedent at `034_m7b_invoice_issue.up.sql:1860-1862`); then `p_expected_version <> 1` → `conflict`; otherwise it applies and answers version 2 (expected + 1, the mutator's echo check). Through HTTP `conflict` is unreachable, because the planner pins 1; its sealed slot is carried as for every command.
- **Precedence (explicit, the runtime's real order).** The chain's checks (§12.4's list, ending with the current levels, the trusted context and `403 step_up_required`, the 400 store segment, the 403 path store unlike the trusted store and the 400 target) → the body read → the 400 key → its acquisition: a sealed answer replayed (`Idempotent-Replayed: true`) / `409 request_in_progress` (a live lease) / `422 idempotency_key_reused` → the 400 plan (a body or target the planner refuses) → in the transaction: 503 lease fence → 503 revalidation (with its database-clock sign-in check) → 503 routine authority (`refused`, the caller and the unlocked levels) → unsealed 409 tenant → unsealed 404 missing, another store's or another tenant's invoice → 503 levels re-read, session expiry or stale sign-in after the waits → **sealed 409 `invalid_state` (already void)** → sealed 409 `write_conflict` (stale lifecycle version, HTTP-unreachable) → 503 the adapter's deadline re-check → 200 applied.

### 12.4 HTTP

The tests are to pin the method, path, body and every answer.

| Route | Permission | Trusted context | Recent sign-in | Body | Idempotency |
|---|---|---|---|---|---|
| `POST /api/v1/stores/{storeId}/invoices/{id}/void` | `void_issued_invoices` | required | **required** | JSON ≤ 1,024 bytes, exactly `{"expectedTenant": <canonical lowercase uuid>, "reasonCode": <one of §12.2>}` | required |
| `GET /api/v1/stores/{storeId}/invoices/{id}/void-eligibility` | `void_issued_invoices` | required | none | none | none |
| `GET /api/v1/stores/{storeId}/invoices` (answer changes) | `view_issued_invoices` (unchanged) | unchanged | none | none | none |
| `GET /api/v1/stores/{storeId}/invoices/{id}` (answer changes) | `view_issued_invoices` (unchanged) | unchanged | none | none | none |

- **Sealed, replayable answers — only these three.** `200 {"invoice":{"id":"<invoice id>","status":"voided"}}` (built by the planner; nothing is read back); `409 {"error":"invalid_state"}` (already void); `409 {"error":"write_conflict"}` (the version; HTTP-unreachable). The sealed bodies carry no `requestId`.
- **Unsealed answers.** Every other answer is the chain's `{"error": <word>, "requestId": <id>}` with exactly those two members: `409 write_conflict` (the tenant changed); `404 not_found` (missing, another store's or another tenant's invoice, one shape); `400 invalid_request` (a body the planner refuses — an extra or missing key, a version field, an unknown code, a non-canonical tenant — after the key is taken, and every earlier 400); `401 unauthenticated`; `403 forbidden` or `403 step_up_required`; 413, 415 and 429 with their existing words (429 with `Retry-After`); `503 service_unavailable` for every outage, fault, revalidation refusal, routine `refused`, stale sign-in after the waits, timeout or ambiguous COMMIT (outcome unknown; never a claimed rollback).
- **Clock skew.** The chain judges the sign-in's age on the runtime clock; the revalidator, the routine and the adapter on the database clock. A skew between them can turn a borderline sign-in into a 503 (outcome unknown, nothing committed); a retry under the same key then receives `403 step_up_required`. Every mismatch fails closed.
- **Eligibility (REFINES §5 E's labelling).** `200 {"eligibility":"allowed"}` exactly when the chain admits `void_issued_invoices` at that store now (levels, corequisite, standing), in the issue eligibility's form, with `recentAuth: 'none'` (the precedent is the read under the sensitive `edit_issuing_settings` key, `server/runtime/issuingSettings.ts:368`). It is NOT proof that the invoice exists, belongs to the store or is not already void, or that the sign-in is recent enough for the void: the POST requires a sign-in within 10 minutes and answers `403 step_up_required` otherwise. The detail read is the resource-specific review; the POST decides again.
- **Key and lease (§5 D adopted as binding).** `409 request_in_progress` (the same key while an unsealed attempt's lease is live, 60 s) and `422 idempotency_key_reused` (the same key with other bytes, another target or another route — an issue key on the void route, for example — even after completion), both unsealed `{error, requestId}`; a replay of a sealed answer carries `Idempotent-Replayed: true`. Every unsealed answer rolls back and leaves the separately committed lease to expire; no refusal releases or replaces it. To be pinned in VOID-05 and VOID-08.
- **Target.** The planner answers `400 invalid_request` (after the key) unless the path's invoice id matches the outbox's UUID pattern and the store id is a uuid, as the issue planner's guard does (`server/runtime/invoiceIssuing.ts:274`); never a 500 `command_plan_invalid`.
- **The eligibility declaration.** Restated in the void module, which does not import the issuing module: GET, a tenant session, `trustedContext` required, `recentAuth` none, **`sessionBinding` required**, no body, no idempotency; the handler's order is a query (400) → scope, store or session (403) → the invoice id read directly before `/void-eligibility` (400) → 200.
- **Reads (the read contract, recorded before the readers switch).** List rows keep their ten keys, with `status` ∈ {`issued`, `voided`}. Detail: `status` ∈ {`issued`, `voided`}; the body stays exactly `{"invoice": …}`; a voided detail's `invoice` object has exactly one more member, `void`, serialized LAST (after `amounts`), `{"voidedAt": <instant, issuedAt's exact encoding>, "reasonCode": <code>}` in that key order, its bytes to be pinned by an HTTP test; an issued detail has no `void` member, and every never-voided answer is byte-identical to the 034 answer. No read returns the voiding actor. Ordering (number descending), cursors (anchored by invoice id) and `?sourceDraft=` (unconditional: it returns the invoice, voided or not) are unchanged; no new query parameter or filter. The routes stay in place under `/api/v1`; no `/api/v2` route exists (§12.0).
- **Checks that can stop a same-key replay before idempotency handling.** Host not served (404); client address (400); the limiter (429); `Expect` (417); body admission (400, 413, 415); pre-session Origin and CSRF (403); the session (401: expired, revoked or no longer admitted); session CSRF (403); the route authorizer (403 `forbidden`, current levels); `403 authz_context_missing`; **`403 step_up_required` (a sign-in older than 10 minutes)**; the store segment (400); a path store unlike the trusted store (403); the target id (400); the body read; the key (400). The shop's 23-hour window promises nothing about these.
- **The issue's answers.** The issue's 201 and its same-key replay are unchanged (`"status":"issued"`, true of the issue); a later read shows the current lifecycle.

### 12.5 Database (migration 035, schema `tmpos_invoice_void`)

- **Schema and table.** Schema `tmpos_invoice_void`, owned by the applier, with USAGE for `tmpos_app` only. Table `issued_invoice_void`, append-only: `invoice_id uuid` primary key; `tenant_id uuid not null`, `store_id uuid not null`; a composite foreign key `(invoice_id, tenant_id, store_id)` to 034's `issued_invoice_scope_key`, ON DELETE and ON UPDATE RESTRICT, and no other index (the primary key serves the join); `reason_code text collate "C" not null` with a CHECK over §12.2; `voided_at timestamptz not null`, the routine's `clock_timestamp()` after its last lock; `voided_by uuid not null`, never returned. RLS on, no policy, no runtime-role privilege of any kind. ENABLE ALWAYS guards: BEFORE INSERT (fixed-text refusals unless the issued invoice of the same tenant and store exists and `voided_at` ≥ its `issued_at`), BEFORE UPDATE OR DELETE (every row change refused) and BEFORE TRUNCATE (refused).
- **The void routine.** `tmpos_invoice_void.m7b_invoice_void(p_session_key text, p_store_id uuid, p_invoice_id uuid, p_expected_tenant uuid, p_expected_version bigint, p_reason_code text)`, VOLATILE, SECURITY DEFINER, search path `pg_catalog, pg_temp`, `row_security` off. Words: `refused`, `tenant_mismatch`, `not_found`, `invalid_state`, `conflict`, `applied`. In order: every argument checked before anything is read, locked or written (a NULL, a session key not matching 034's shape check, a version outside 1 to 2^53 − 2 or an unknown code raises `invalid_parameter_value` with fixed text); READ COMMITTED required; the caller derived exactly as 034's issue derives it, restated rather than calling 034's unlocked store reader (016's standing hold, the session and ledger, the issuer key, admission, exactly one store grant at the path's store under write statuses, the membership and the store row FOR SHARE) → `refused`; both levels read unlocked → `refused`; the tenant precondition → `tenant_mismatch`; the issued header FOR UPDATE by invoice id, derived tenant and path store → `not_found`; for an editable role, key 530030 SHARED and both levels read again → `refused`; after the last lock wait, the session's expiry and the recent sign-in from the session row's `authenticated_at` on `clock_timestamp()` (NULL, more than 5,000 ms in the future, or older than 600,000 ms → `refused`; exactly at the bound it still holds); a separate statement asking whether a void record exists → `invalid_state`; a version other than 1 → `conflict`; one insert inside one exception block mapping constraint violations to one fixed integrity error, then a verification read; `applied` with tenant, store, actor, membership, version 2 and the invoice id. Nothing is written before the last refusal (DA-36); no draft, settings, customer, counter or line row is read or locked; the routine writes no audit or outbox row. *(REFINES §5 C: the sign-in and expiry are judged after the last lock wait, key 530030 included.)*
- **The v2 reads.** `m7b_issued_invoice_page_v2` and `m7b_issued_invoice_get_v2` (STABLE, SECURITY DEFINER) return 034's page and get answers row for row and in 034's order, deciding authority exactly as 034's reads do, plus the lifecycle columns: `o_status` on a page row; `o_status`, `o_voided_at` (034's `o_issued_at` encoding) and `o_reason_code` on every detail line row; all NULL on a refusal row. 035 revokes `tmpos_app`'s EXECUTE on 034's page and get (033's precedent), and its down restores it.
- **Grants.** USAGE on `tmpos_invoice_void` and EXECUTE on exactly the three routines, to `tmpos_app`; the trigger functions, the rollback-order anchor and any helper to nobody. The startup preflight's grant list loses 034's page and get lines and gains the USAGE line and the three EXECUTE lines; `REQUIRED_MIGRATIONS` gains 035 with its checksum.
- **Lock order.** The prefix (fence → 016's hold → session and ledger → issuer key → membership and store FOR SHARE) → **the issued header FOR UPDATE** → key 530030 SHARED (editable roles) → COMMIT. No draft, settings, customer or counter row is read or locked. Deadlock freedom is NOT claimed (a per-path argument only, §5 C).
- **Up.** ACCESS EXCLUSIVE locks first, in 034's writers' order (`public.store`, then 034's issuing tables including `issued_invoice`), before any check; then it requires READ COMMITTED, exactly 001–034 applied, 034's objects exactly (`issued_invoice_scope_key` defined as `UNIQUE (invoice_id, tenant_id, store_id)`; the page and get with their exact signatures and `tmpos_app`'s EXECUTE), none of 035's objects, the runtime roles, and an applier that can execute 034's page and get, 016's hold and admission v2 and owns, or inherits the owner of, every table the definers read or lock, none with forced RLS. Fixed-text refusals.
- **Down.** The same kind of locks (`public.store`, `issued_invoice`, `issued_invoice_void`, `public.audit_event`, in the writers' order) before any check; then, under READ COMMITTED, it refuses with fixed text, changing nothing, while any void record exists or any `public.audit_event` row has `action_id = 'store.invoice.void'`; otherwise it restores the exact pre-035 catalog and grants. It never deletes a row, so after the first void it is one-way.
- **034's down while 035 is applied** fails closed: 55000 at 034's data guard while any issued invoice exists, otherwise 2BP01 at its drops. Roll 035 back first.
- **Operations.** 035's apply and its down run with the tenant runtime stopped, as 034's did. A 034 runtime still running across the apply answers 503 on issued reads (`tmpos_app` lost EXECUTE on the page and get: it fails closed and never conceals a void); a 035 runtime across the down meets dropped v2 functions and answers 503. The preflight refuses a mismatched start either way.
- **Clock.** `voided_at` ≥ `issued_at` holds in normal operation; a database clock stepped backwards, or a failover to a host behind, makes a void right after an issue fail closed (503, nothing written) until the clock passes `issued_at`.
- **Column comment.** The up re-words the comment on `public.audit_event.subject_issued_invoice_id` to name both the issue (created) and the void (voided); the down restores 034's exact text.

### 12.6 Kernel and composition

- **Modules.** `server/runtime/invoiceVoid.ts` (the reason codes, the two paths, the contract, the planner and the two routes) and `server/persistence/postgresInvoiceVoid.ts` (the mutator), both new. The issued reads' rows and decoders change in `server/runtime/invoiceIssuing.ts` (its issue 201 and constant `status: 'issued'` unchanged); in `server/persistence/postgresInvoiceIssuing.ts` the page and get statements call the two v2 routines with the exact new column sets, and the readiness probe asks the v2 routines (and still asks the other 034 reads it asks today).
- **The contract and the mutator.** Kind `store.invoice.void`, mode update, aggregate type `issued_invoice`, context scope `store`, no events; the planner takes exactly the two body keys, aggregate id = the path's invoice id, `expectedVersion` 1, the audit annex of §12.2 and the 200 of §12.4. The mutator makes one call to `m7b_invoice_void` with the context's store; it accepts `applied` only when the tenant, store, actor and membership equal the context, the version is the expected one plus one and the invoice is the aggregate id, and then re-judges the sign-in on the database clock; `tenant_mismatch` → the precondition refusal; `not_found`, `invalid_state`, `conflict` and `refused` as words (a refusal must carry every other column NULL); anything else is a mismatch. It requires a numeric sign-in deadline (the sensitive key), else answers unavailable before any statement.
- **Closed lists, extended by name.** `PRECONDITION_UPDATE_KINDS` gains `store.invoice.void` (`server/runtime/app.ts` and `server/persistence/postgresTransactionalStore.ts`, kept equal). The mutator's `auditSubjects` gains `'voided_invoice'`, admitted only in update mode, on aggregate type `issued_invoice`, at context scope `store`; the store names `subjectIssuedInvoiceId` = the aggregate id and no other subject; the mutator answers bare words.
- **The audit writer.** `subjectIssuedInvoiceId` alone is admitted only for action `store.invoice.void` at scope `store`, with one new fixed INSERT shape; the issue's triple rule is unchanged. Dispatch: the triple first, then the issued-invoice-alone statement; the writer refuses `store.invoice.void` without exactly that one subject, and refuses the alone shape for any other action or scope.
- **Audit time.** The audit record's time is the transaction's database time (`occurred_at default now()`, the transaction start); the void record's time is `clock_timestamp()` after the last lock. They differ, up to the lock timeout, and no report claims they are equal.
- **The revalidator.** A unit case is to pin that store scope with `void_issued_invoices` refuses a null sign-in deadline, and that store scope with `issue_invoices` still refuses a numeric one.
- **The permission load guard.** It admits exactly two Approve keys: `issue_invoices` (not sensitive, as today) and `void_issued_invoices` (sensitive, Invoices at Approve, corequisite exactly Customers View); `sensitive` is admitted for that key only, and every other widening still refuses to load, each to be proven by its own test.
- **Route sets.** Store templates 13 → 15; idempotent store commands 4 → 5; the tenant entry's shipping table 29 → 31, the two new entries appended right after `GET /api/v1/stores/{storeId}/invoices/{id}` in the order eligibility, then command; business declarations 24 → 26. Every existing declaration stays byte-identical.
- **Unchanged.** No new `RESERVED_ERRORS`, sealed status, event, outbox row, worker or delivery port.

### 12.7 Shop (P1 minimum; no POST and no new store)

- **Decoders** (`src/tenant/invoiceIssuingClient.ts`). A list row's `status` ∈ {`issued`, `voided`}. Detail: issued ⇒ no `void` key; voided ⇒ exactly the `void` key with exactly `{voidedAt, reasonCode}`, `voidedAt` in `issuedAt`'s encoding and not before `issuedAt`, `reasonCode` in §12.2. Every other status, key or combination is still rejected, and one bad row still makes the page `unavailable`. The decoded `IssuedInvoice.void` is `null` exactly when the status is `issued` (the wire then has no `void` key) and the two-field object exactly when it is `voided`; `voidedAt >= issuedAt` is compared as strings (a fixed-width UTC encoding) after both pass the instant check. No client method is added; the shop keeps its own copy of the six codes and labels in §12.2's order (shop code may not import server code).
- **Display.** `InvoiceSnapshot` (`src/tenant/ServerIssuedInvoices.tsx`) is unchanged, in its props and its output (it is also the issue preview). Only `IssuedInvoiceDialog`'s `<dl>` (`src/tenant/ServerIssuedInvoices.tsx`) changes: its Status value reads "Issued" or "Voided", and a voided invoice adds, after "Issued at", the term "Voided at" with a `<time>` (the issue time's UTC format and wrapping) and the term "Reason" with the code's label. Issued list rows stay byte-identical; a voided row's time reads "Issued <time>" (the prefix outside the `<time>`) and its status "Voided".
- **Word scans.** The existing word and button scans (`FORBIDDEN`, `NOT_SAID`, the SII-60 and SIS-06 button sets and SID-149) stay byte-identical in P1 and are also to be applied to voided fixtures; new shop text never uses the bare word "void". Their supersession is P2's.
- **Layout.** The voided row and dialog are to be checked in the existing viewport cells (SIS-09's 1440×900, 768×1024, 320×640 and 320×480, and 24 px text) at unchanged sizes; a regression is reported, never fixed by enlarging a viewport; DA-214 and DA-222 are carried unchanged.
- **The hold.** Exactly one new `HeldIssue` field (`src/tenant/ServerInvoiceDrafts.tsx`), `voided: boolean` (false at creation; true only from "Find issued invoice"'s found summary or the issued detail's load with `status === 'voided'`); the card then reads "Issued as invoice *N* at *S*; it has since been voided.", with the store name *S* in a `<bdi>`. That is the whole hold change.
- **Parity.** One client test case is to deep-equal the shop's codes with the server's `INVOICE_VOID_REASON_CODES` (the test file may import server code; the client module may not, IIC-21).
- **"Find issued invoice" and `?sourceDraft=` recovery.** A later-voided invoice still proves that the issue committed: the shop says it was issued as invoice *N* and is now voided, never offers a new issue and never says that nothing committed. The issue hold, its session lifecycle and its recovery logic are not refactored.
- **Attribution.** Seeing "Voided" settles the invoice's current state, not which request caused it; seeing "Issued" never settles a void (the contract P2 builds on).
- **P2 handover.** The server does not bind an idempotency key to a session (its scope is the key and the principal; the fingerprint names no session). The shop must make a held void attempt unsendable on a session or token replacement, as the issue attempt's detach rule does.

### 12.8 Evidence map — every row PLANNED — NOT RUN

| ID | P1 (this stage) | P2 (pending) | Status |
|---|---|---|---|
| VOID-01 | Authority: HTTP, routine and unit | — | PLANNED — NOT RUN |
| VOID-02 | Isolation: HTTP | — | PLANNED — NOT RUN |
| VOID-03 | Revocation, levels and the sign-in while waiting: HTTP and routine, with the bound pins below | — | PLANNED — NOT RUN |
| VOID-04 | The transaction delta: HTTP and routine | — | PLANNED — NOT RUN |
| VOID-05 | Replay, already void and mismatch: HTTP and unit | — | PLANNED — NOT RUN |
| VOID-06 | Two-instance race and the isolation-level refusals: HTTP and routine | — | PLANNED — NOT RUN |
| VOID-07 | The server part | The shop half (a confirmation opened or pressed on an invoice voided meanwhile) | PLANNED — NOT RUN |
| VOID-08 | The server part: owner-trigger faults at the void insert, the audit insert and the completion | The shop half (unresolved, never success) | PLANNED — NOT RUN |
| VOID-09 | The database part: the commit trap, "lose" and "cut" | The shop half (a dropped response recovered by "Check again") | PLANNED — NOT RUN |
| VOID-10 | Every layer: HTTP, routine, client, section and one real-browser compatibility scenario (below) | — | PLANNED — NOT RUN |
| VOID-11 | — | The held attempt | PLANNED — NOT RUN |
| VOID-12 | — | The confirmation | PLANNED — NOT RUN |
| VOID-13 | The server part (body bounds, logs), the client part and the section part (below) | The confirmation's half | PLANNED — NOT RUN |
| VOID-14 | Migration: assertions (a) to (j) below | — | PLANNED — NOT RUN |
| VOID-15 | Regression | — | PLANNED — NOT RUN |

- **VOID-14's named assertions.** (a) A clean apply of 001–035 and the up's postcondition. (b) The upgrade over pre-existing issued invoices with lines: every header, line, counter and draft row image byte-identical. (c) 035's down on a clean 035 restores 034's catalog exactly (a catalog and ACL snapshot of every touched object before 035 and after its down, the page's and get's ACL included), and a re-apply works. (d) An unsafe down with one void record, and separately with one `store.invoice.void` audit record, refuses and changes nothing (no partial drop). (e) 034's down while 035 is applied: 55000 with issued data, 2BP01 on an empty issuing state, nothing changed. (f) The up refuses on a wrong predecessor state. (g) Every affected `DOWN_034` chain in the suites runs 035's down first. (h) A re-apply of 035 is refused. (i) An UPDATE, DELETE or TRUNCATE of a void record, and a back-dated INSERT, are refused as the owner in normal and in replica mode. (j) The preflight refuses a 034 runtime on a 035 database and a 035 runtime on a 034 one (the preflight unit suite and `tests/db/productionEntryPreflight.integration.test.mjs`).
- **VOID-13's split.** P1: the server (body bounds, logs), the client and the section (the detail's reason label as fixed text; the IIC-21 and SII-25 scans over the changed client and section; no reason in a URL or browser storage). P2: the confirmation's half.
- **VOID-10's browser scenario.** SIS-12's lost-201 setup, then a void by a direct HTTP call (`directLogin`, a fresh sign-in, one key — never an owner INSERT); "Find issued invoice" shows the voided card text with ONE GET `?sourceDraft=` and no POST; "View invoice" and the list show Voided, the void time and the reason's label; `NOT_SAID` and the exact button sets hold on the voided row and dialog; the SIS-09 viewports on the voided dialog. The harness's `cleanIssuing` is to delete, inside a `to_regclass('tmpos_invoice_void.issued_invoice_void')` check, the `store.invoice.void` audit records with the issue's and the void records (guards lifted and restored as found), before `issued_invoice`.
- **Failure.** Unit: each malformed or identity-mismatched routine row → `unavailable` or `mismatch` (503). HTTP: a deadline or an abort → 503 with only the lease; an outage → 503.
- **Forged inputs.** HTTP: a body carrying a sign-in time, an actor or a store field is 400 (the strict body). A caller-set session setting does not change the routine's decision (it reads only the session row); the routine's 5,001 ms refusal is the forged-row case.
- **Version.** Routine: expected 2 on an issued invoice → `conflict`; expected 1 or 2 on a voided one → `invalid_state`; expected 1 on an issued one → `applied`, version 2. The mutator refuses an `applied` whose version is not the expected one plus one. HTTP: a stale `expectedTenant` → the unsealed 409, with the lease kept.
- **Audit time.** VOID-04 asserts `occurred_at <= voided_at`, never equality.
- **Negative controls, red then green.** Remove the void-record existence check → VOID-05 and VOID-06 fail; drop the adapter's sign-in re-check → VOID-03 fails; let the list decoder ignore `status` → VOID-10 fails.
- **VOID-03's bound pins.** At the routine: `authenticated_at` exactly at the 10-minute bound passes and 1 ms past it refuses; 5,000 ms in the future passes and 5,001 ms refuses; NULL refuses.
- **Declaration pins.** The POST's `recentAuth: 'required'` and the eligibility's `'none'` in the attribute-by-attribute declaration pins (`tests/quality/production-runtime-contract.test.mjs`), and the revalidator unit case of §12.6.
- **Suite hygiene.** Every 035 suite is to end with no void record and no `store.invoice.void` audit record (it lifts the ALWAYS guards as the owner, as the IIR cleanup does), because CI runs every database suite on one database and 035's down refuses otherwise; the two void suites run after every step that rolls 035 or older back (the CI step order).
- **Evidence rules.** HTTP and integration evidence uses the real tenant entry over disposable PostgreSQL; a cross-instance race uses a separate process or adapter instance on the same database, never an in-process mutex; races use deterministic barriers or the established fault injection and assert data, audit and lease state, not status codes alone; intercepting a successful HTTP response does not prove COMMIT-acknowledgement behaviour. No production test flag or fault endpoint is added.

### 12.9 Carried, and not claimed

- **Carried unchanged** (§8): DA-219, DA-221, DA-222, DA-214 (the `/invoices` page scrolls sideways at 320 CSS px), and the owner's Manual QA of the M7B-INVOICES-ISSUE-P2 shop, PENDING. A shared read or display change that touches a short-height case keeps the former viewport guarantee or reports the remaining defect; no viewport is raised to pass.
- **Not claimed.** That voiding is available in the product; that any row of §7 or §12.8 has run; any CI result; deadlock freedom; a managed migration; deployment; M7b completion; legal or production readiness. DA-36's structural remedy, DA-118, DA-119, DA-186's remaining parts and DA-187 stay open, and all 37 production gates stay OPEN. Nothing is deployed.
