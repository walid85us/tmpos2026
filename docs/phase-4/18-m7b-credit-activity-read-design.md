# 18 — M7B credit notes: the store-wide credit-activity read (design)

**Status: ADOPTED — DESIGN ONLY (owner adoption of revision 9 on 2026-11-18; §14 records each D-CA decision). Documentation only: the adoption builds nothing and runs nothing. Implementation, commit, push, CI, deployment and managed migrations each need separate owner approval (drafted 2026-11-18; revision 9, adopted 2026-11-18).**
- **What this is.** The contract for the slice that [17](./17-m7b-invoice-credit-note-p2-design.md) D-P2-2 A puts in "its own slice" and D-P2-13 A makes a deployment prerequisite for CN-P2 (D17:6, D17:584, D17:595). D17 §4.2 states the slice's needs only and says it "has no contract yet" (D17:6, D17:942). This document is that contract, adopted as design by the owner on 2026-11-18 (revision 9).
- **Adoption (2026-11-18, documentation only).** The owner chose D-CA-15 B, D-CA-18 C and A for every other D-CA decision (§14, "Owner decisions recorded 2026-11-18"). D-CA-18 C is adopted with D-CA-14 A as the HTTP pause mechanism (D-CA-14 D only as an added first repair). The post-commit write-attribution log (`credit_note_write`, §6.6; §9.3.4) with platform-authenticated source metadata is adopted as part of that design; its implementation and verification are **PENDING**. The Doc 17 amendment of §14.1 is applied to D17:509 under D-CA-12 A, its stale `T` citation corrected; the optional Doc 16 amendment of §14.2 is not applied (D-CA-3 A).
- **Still OPEN after adoption** (each a separate owner decision or a pending precondition, none decided by the adoption): the database write fence (§9.3.4, the complete-window-closure dependency), a separate approval; acceptance of the no-fence residual (§9.3.4): a closing scan with no in-flight writes does not establish that the window is fully closed; D-P2-14's production handling (D17:808); implementation approval (D17:806's pattern); deployment authorization (§12 item 10); reopening QA and CI; the operator-confirmed values of §9.3.1 (unverified, pending); and the log-sink trust base of §9.3.4 (an operational precondition, pending).
- **Implementation status (updated 2026-11-19): the database, HTTP and shop slices are AUTHORED AND UNRUN; local and uncommitted.** Under the owner's separate local-authoring approvals, N is fixed at 039 (§1 rule 2 (i)) and three slices exist in the worktree: the **database slice** of §15(a) (039's up and down, §9.1-§9.2; the preflight's 039 ledger row, pinned checksum and grant line; the three `'039'` fixtures moved to `'040'`, §1 rule 5; `tests/db/storeCreditActivityRoutine.integration.test.mjs`) and the **HTTP slice** (the route of §5, the D-CA-1 A key of §8.1, the read adapter and the composition of §6.6; `tests/db/storeCreditActivityHttp.integration.test.mjs` and the server unit tests), and the **shop slice** (the "Credit activity" sub-section of §4 with the §8.4 classification: `src/tenant/invoiceIssuingClient.ts`, `src/tenant/ServerIssuedInvoices.tsx`, their component and client tests, and browser scenarios SCA-01 to SCA-04 in `tests/browser/shopRoleLevels.browser.test.mjs`, whose credit-route match now also covers `GET /api/v1/stores/{storeId}/credit-notes`). Nothing of any slice has run: no test, typecheck, build, migration, rehearsal, browser check, QA session or CI run, and no database has 039 applied. Nothing is committed, pushed or deployed. The **write setting** of D-CA-14 A (`TMPOS_CREDIT_NOTE_WRITES`, its chain check and its per-instance startup line) and the **write log line** of §9.3.4 are AUTHORED AND UNRUN in the N-built runtime (2026-11-19; files in §6.6, coverage in §13). The startup line's database-clock read (§6.6; §9.3.2, times) is AUTHORED AND UNRUN (spec 2, 2026-11-19): one read-only `pg_catalog.clock_timestamp()` sample through the startup preflight. It fails closed, under the owner's rule recorded in §6.6 on 2026-11-19. Also by the owner's instruction of 2026-11-19, a lost lease writes no write log line (§9.3.4 amended; ICN-15 updated, unrun). CA-35 stays UNVERIFIED, with its shop (C) and browser (B) coverage pending. Not built: the predecessor build (a runtime for 001..N-1 carrying the same setting). **Pending deployment evidence:** the log sink's platform-authenticated source metadata (§9.3.4), which no source can show. **Pending, carried forward:** explicit CI registration of BOTH new database suites (`storeCreditActivityRoutine` and `storeCreditActivityHttp`) before any CI verification; the write setting's cases extend existing suites and need no new registration. Throughout this document "039" means N. Every §13 row stays PLANNED — NOT RUN; nothing authored counts as evidence (§15(b)).
- **QA.** Deferred by the owner on 2026-11-18 until development across all phases is finished. Every acceptance row in §13 is PLANNED — NOT RUN.
- **Gates unchanged.** 37 gates: 29 OPEN, 7 PARTIAL, 1 PASS. ICH-11 stays UNVERIFIED. CN-38 stays a deployment prerequisite. G-APPSEC stays PARTIAL and production-blocking. G-A11Y stays OPEN. F-2 and F-5 stay missing inputs. D-P2-14's production handling stays an OPEN owner decision. CN-P3 (the shop's withdrawal control) stays a separate slice and is not designed here.

**Decision markers.**

| Marker | Meaning |
|---|---|
| [ADOPTED (source)] | Owner-adopted text, cited by document and line |
| [SHIPPED (source)] | Behaviour of code in this worktree (base `eb10f4c`; server files unchanged by the CN-P2 candidate, D17:831), cited by `path:line` |
| [CANDIDATE (source)] | Code in the uncommitted CN-P2 candidate (D17 §8.1): not committed, not SHIPPED. Every `T:` line is candidate code and moves when the candidate changes |
| [PROPOSED] | Label kept from drafting; it does not mean unadopted. Design text of this document: adopted as design on 2026-11-18 together with §14's recorded decisions, which govern where they differ. Not implemented, not built |
| [ADOPTED, D-CA-n X] | An owner decision of 2026-11-18: option X of D-CA-n, recorded in §14. Revision 9 marked these [AWAITING OWNER] |
| [OPEN] | Not decided by the 2026-11-18 adoption: a separate owner decision or a pending precondition (listed in the header and in §14) |

**Short names for citations.**

| Short | Path |
|---|---|
| D08, D09, D10, D16, D17 | `docs/phase-4/08-production-gate-and-risk-register.md`, `09-roadmap-m0-m9.md`, `10-architecture-decision-records.md`, `16-m7b-invoice-credit-note-decision-pack.md`, `17-m7b-invoice-credit-note-p2-design.md` |
| RT, ISS, APP, ROUTES, TE, TS | `server/runtime/invoiceCreditNotes.ts`, `server/runtime/invoiceIssuing.ts`, `server/runtime/app.ts`, `server/runtime/routes.ts`, `server/entry/tenantEntry.ts`, `server/runtime/tenantState.ts` |
| PGCN, PRE, PERM | `server/persistence/postgresInvoiceCreditNotes.ts`, `server/persistence/postgresStartupPreflight.ts`, `server/platform-identity/m5CanonicalPermissions.ts` |
| M34, M38 | `server/platform-identity/migrations/034_m7b_invoice_issue.up.sql`, `…/038_m7b_invoice_credit_note.up.sql` |
| T, INV, DC | `src/tenant/ServerIssuedInvoices.tsx` (CANDIDATE: modified by the uncommitted CN-P2 candidate), `src/components/Invoices.tsx`, `src/tenant/invoiceDraftsClient.ts` |
| IDEM, SPC, MX, SES | `server/runtime/idempotency.ts`, `server/persistence/supervisedPgClient.ts`, `server/platform-identity/migrationExecutor.ts`, `server/runtime/sessions.ts` |
| PRN, TST, CT | `server/runtime/principals.ts`, `server/runtime/tenantStatus.ts`, `server/runtime/commandTransaction.ts` |
| 037 | `server/platform-identity/migrations/037_m7b_invoice_payment_registration.up.sql` (cited as `037:<line>`) |
| SD, AC, PC, TSC | `server/runtime/storeDirectory.ts`, `server/platform-identity/authorizationConstants.ts`, `server/platform-identity/permissionCatalog.ts`, `src/tenant/tenantSessionClient.ts` |
| M36D, M37D, M38D | `server/platform-identity/migrations/036_m7b_invoice_payment.down.sql`, `…/037_m7b_invoice_payment_registration.down.sql`, `…/038_m7b_invoice_credit_note.down.sql` |

---

## 0. Summary

1. **Who and what.** The store-scope store owner of one store reads that store's credit notes, newest first: credit-note number, invoice number, gross amount, reason, issued time and issuing staff name, and, for a withdrawn note, the withdrawal time, reason and withdrawing staff name. [PROPOSED]
2. **One read route**, `GET /api/v1/stores/{storeId}/credit-notes[?after=<creditNoteId>]`, pages of 50, newest credit-note number first; the cursor and page contract is §6.3. [PROPOSED; cursor form ADOPTED, D-CA-6 A]
3. **One new definer routine** in a new migration at the next free number, provisionally 039 (§1, D-CA-3; not created), STABLE, read-only, owner-only by role, tenant- and store-bounded; no new table and, under the adopted row model (D-CA-2 A), no new index. [PROPOSED]
4. **One permission choice** the catalog cannot answer today without a change: no existing store key is both owner-only and a plain view. Adopted: A, a new owner-only key, which **denies read-only and overdue tenants (403)**. [ADOPTED, D-CA-1 A]
5. **One shop sub-section**, "Credit activity", under the store already chosen in the issued-invoices section; read only, no buttons but "Refresh", "Show more" and "Try again" ("Refresh" under D-CA-15 B). [PROPOSED; placement ADOPTED, D-CA-4 A]
6. **What it does not do.** It shows duplicate issuance **after** it has happened; it does not prevent it. D-P2-14's production decision remains OPEN. It adds no withdrawal control (CN-P3). [ADOPTED (D17:586; D17:798; D10:1696)]
7. **Access and recovery.** Who gets what answer, and how the shop tells a route-level denial from a lost context, is §8.4 [ADOPTED, D-CA-1 A, D-CA-12 A, D-CA-13 A]. Production recovery is **forward-only** (adopted, D-CA-18 C, with D-CA-14 A as the HTTP pause mechanism): if the read fails or N is defective, issuance is paused first by a server write setting, tenants stay active and owners keep recovering their own attempts, the cause is repaired forward, and issuance returns only after the read is verified on an authorized session and every write in the evidence window is classified (§9.3.2 to §9.3.5) [ADOPTED, D-CA-8 A, D-CA-14 A, D-CA-18 C; release without the database write fence needs the owner's acceptance of the residual: OPEN, §9.3.4]. N's down runs only in disposable rehearsals (§9.3.7). The pause is HTTP-only: a holder of the runtime's secrets can still issue directly, which the evidence window detects and does not prevent (DA-93). No recovery path deletes or edits a credit note, withdrawal, registration or audit row, apart from an owner's own settlement, which sets one registration's `acknowledged_at` by design (M38:1634-1636).

---

## 1. Numbering evidence (verified 2026-11-18, read-only)

Every check below is a read-only inspection (`ls`, `grep`, `git --no-optional-locks` reads). No build, test, migration or QA ran.

| Check | Command or path | Result |
|---|---|---|
| Worktree docs | `ls docs/phase-4/` in this worktree | Numbered documents 01 to 17; no 18 |
| Worktree migrations | `ls server/platform-identity/migrations/` in this worktree | 38 up and 38 down files; the highest is `038_m7b_invoice_credit_note.{up,down}.sql`; no 039 |
| Owner checkout (read-only) | `ls /home/runner/workspace/server/platform-identity/migrations/`, `ls /home/runner/workspace/docs/phase-4/` | Highest migration 037 (that checkout is on an older branch); no document numbered 16 or above |
| Remote `main` | `git --no-optional-locks ls-tree -r --name-only origin/main` in `/home/runner/workspace` (origin/main at `eb10f4c`) | Migrations up to 038; documents 16 and 17 only above 15; no 039, no 18 |
| Every local and remote ref | `git --no-optional-locks ls-tree -r --name-only <ref>` for each ref of `git --no-optional-locks for-each-ref` | No path `migrations/039*` and no path `docs/phase-4/18*` on any ref |
| Text that names 039 | `grep -rnE '\b039\b' docs server src tests scripts` in this worktree | See below |

**Doc 18 is free.** No ref holds it and no text reserves it.

**039 is free as a file, but three texts name it** [ADOPTED, D-CA-3 A]:
- *For this slice.* D17:6, D17:583 ("a new definer routine in a new migration 039"), D17:584, D17:942; D09:516; D10:1698; D16:828; and the doc 17 row of `docs/phase-4/README.md`. [ADOPTED as design / status text]
- *Under a rejected option.* D17:585 and D17:787 name 039 only for D-P2-2 B ("build it in CN-P2 with migration 039"), which the owner did not choose.
- *For a forward recovery of 038.* D16:384: if 038 must be rolled back after the first durable credit-note registration, "recover **forward** with a 039 migration (for example revoking EXECUTE on the credit-note write routines, or a fix)". [ADOPTED (D16:384)]
- *For F-2 columns.* D16:219 and D16:643: "a later additive migration (039 or after)". This one is not a reservation ("or after"). [ADOPTED]
- *As a test fixture, not a migration.* Three suites use `'039'` as the fake "unknown next migration": `server/persistence/postgresStartupPreflight.test.ts:570-571`, `tests/db/productionEntryPreflight.integration.test.mjs:510`, `:515`, `tests/db/tenantEntry.integration.test.mjs:118`, `:1262-1280`. Creating a real 039 makes those fakes real; implementation must move them to the number after this slice's (§9.4).

**The conflict, recorded both ways.** D17:583 and D17:942 name 039 for this slice. D16:384 names 039 for a forward recovery of 038: after the first durable credit-note registration "the tenant runtime stays stopped and tenants stay suspended until 039". D16:219 and D16:643 name "039 or after" for F-2 columns, which is not a reservation. The first two cannot both hold if a 038 forward recovery is needed before this slice's file exists. The D16:384 contingency arises only if 038 reaches a managed database and must be recovered; nothing is deployed (D17:941), so the texts do not collide today.

**Reconciliation: the number is provisional** [ADOPTED, D-CA-3 A]:
1. **N.** This slice's migration is called **N**: the next free migration number when its file is created, provisionally 039. Its **predecessor ledger** is 001..N-1 (provisionally 001–038). In §9, §12, §13 and §15, "N" and "001..N-1" are used; elsewhere "039" means N.
2. **Deterministic numbering, by stage** (the preflight pins the exact ledger and each checksum, PRE:95-97):
   - (i) *Before this slice's file is committed.* If a 038 forward recovery (D16:384) is needed first, it takes the next free number, and N becomes the number after it (for example: recovery 039, N = 040, predecessor ledger 001–039).
   - (ii) *Committed, but applied to no database other than a disposable test database.* If a 038 forward recovery is then needed first on a managed database, the recovery takes the slice's number and the slice's file is renumbered to the next free number after it, its pinned checksum and preflight row rewritten in the same commit. The slice is the one that waits; the recovery is the urgent one.
   - (iii) *Applied to any managed database.* N is fixed for good. A 038 forward recovery takes the next free number after N and is applied after N, in ledger order.
3. F-2 columns (D16:219; D16:643) take the next free number after all of these. Their "039 or after" already allows that.
4. **A migration is never edited after any database applied it.** A fix to this slice's routine is a new migration at the next free number, applied after N (the checksum is pinned, PRE:95-97).
5. The three suites that use `'039'` as the fake unknown migration move to N+1 (§9.4).

---

## 2. Governing contract

### 2.1 What is adopted

D17 §4.2 (D17:577-595) is headed PROPOSED. D17's status labels say PROPOSED text was "adopted as design on 2026-11-16 together with §7's recorded choices, which govern where they differ" (D17:22). Below, "ADOPTED as design" marks such text; "ADOPTED" alone marks a line D17 itself labels ADOPTED or a §7 decision.

- **The operator task.** Under D-CN-12 A the store owner watches credit activity across the store to notice unusual crediting; that is the accepted owner residual under G-OBSERVE. [ADOPTED (D17:579; D16:322; D16:571)]
- **Who and the boundary.** The store-scope owner of that store; one store. [ADOPTED as design (D17:22; D17:580)]
- **Records and fields.** Issued and withdrawn credit notes across the store's invoices: number, invoice number, amount, reason, issued and withdrawn times, issuing and withdrawing staff names; newest first; keyset pagination. [ADOPTED as design (D17:22; D17:581)]
- **What it takes.** A route and key, a new definer routine in a new migration 039, a DA-132 direct-read entry, decoders and tests, and the 038 cutover-style deployment steps. [ADOPTED as design (D17:22; D17:583)]
- **Where and when.** Its own slice (D-P2-2 A); CN-P2 is not deployed to production until this slice passes its gate (D-P2-13 A). [ADOPTED (D17:787; D17:797; D17:595)]
- **What it does not decide.** D-P2-14 (cross-owner duplicate issuance) is independent: "a store-wide read detects duplicates after the fact; it does not prevent them". [ADOPTED (D17:586; D17:798)]
- **Order against CN-P3.** Not decided in D10 [ADOPTED (D10:1699)]; decided with this document on 2026-11-18: this slice first [ADOPTED, D-CA-10 A] (§14).

### 2.2 Why no shipped read serves it

- The attempts lookup returns only the caller's own registrations, and settled ones for 24 hours. [SHIPPED (M38:1496-1516)]
- The per-invoice list needs one call per invoice and has its invoice in the path. [SHIPPED (RT:13; RT:678-716)]
- 038 has no store-wide credit-note routine other than the lookup. [SHIPPED (M38:1433; D17:582)]

### 2.3 House conventions this design follows

| Convention | Source |
|---|---|
| Session read on the tenant boundary, store scope, trusted context required, no idempotency, no recent sign-in, `sessionBinding: 'required'` (so the CSRF header is required) | RT:378-391; APP:947-952 |
| The path store must equal the trusted scope's store, else 403 `forbidden` | RT:370-375 |
| Refusal body `{ "error": "<word>", "requestId": "<id>" }`; reason logged only | RT:364-367; APP:447-452 |
| 401 `unauthenticated`, 403 `forbidden`, 404 `not_found`, 429 `rate_limited` (with Retry-After), from the chain | APP:426; APP:460; APP:839; APP:871 |
| Credit-note family paging: page 50, ask the routine for 51; `nextCursor` is the last row's id when more exist; query either empty or exactly `after=<canonical uuid>`, anything else 400 | RT:77-81; RT:668-676; RT:715 |
| Unknown or foreign cursor: the same 400 `invalid_request` as a malformed one | RT:701; ISS:745-746 |
| Every port answer decoded exactly; anything out of shape is 503 | RT:633-666; RT:702 |
| Store-scope authority from 034's lock-free store reader, then role `store_owner` | M34:914-916; M34:1028-1029; M38:1477-1484 |
| STABLE definer routine, one snapshot, no row or advisory locks (038's text says "locks nothing"; like any query it holds ACCESS SHARE on the tables it reads until its transaction ends); `search_path` pinned; `row_security` off | M38:1452-1460; M38:1881-1889 |
| Authority checked before the cursor anchor, so a cursor is never an oracle across stores | M38:1477-1495 |
| Names: a display name or `null` ("Name not set"); never an id or email; a name over 1,000 characters or with a control character fails the page with 503 | RT:91-92; RT:609-612; D10:1664; D10:1676 (b) |
| EXECUTE revoked from `public, anon, authenticated, tmpos_app, tmpos_audit_writer`, then granted to `tmpos_app` only | M38:2729-2763 |
| Rollback-order anchor naming the previous migration's objects | M38:2706-2720 |
| No ledger clause in the migration; the startup preflight pins the ledger and the approved grants | M38:72; PRE:97; PRE:137; PRE:143 |

---

## 3. Scope

### 3.1 In scope [PROPOSED]

- The store owner's activity view across one store: every credit note of the store, active or withdrawn.
- Per row: credit-note number (shown "CN-<n>"), invoice number, gross amount, reason, issued time, issuing staff name, and when withdrawn: withdrawal time, withdrawal reason, withdrawing staff name.
- The read route, its routine in migration 039, the permission entry chosen under D-CA-1, the decoders and the shop sub-section.

### 3.2 Withdrawn rows, without designing CN-P3 [PROPOSED]

- **Withdrawals already exist on the server.** The withdrawal route and routine ship today (RT:12; M38:1687), even though the shop has no withdrawal control (D10:1693). So a withdrawn note can exist now and the read must represent it correctly. [SHIPPED]
- **How the read represents it.** Exactly as the per-invoice list does: each row has `withdrawal: null` while active, or `withdrawal: { withdrawnAt, reason, withdrawnByName }` once withdrawn (RT:597; RT:711-713). The withdrawal reasons are the closed set `entered_in_error`, `wrong_amount`, `wrong_invoice` (RT:51). The CN-P2 candidate's invoice-level list shows "Active" or "Withdrawn" as text [CANDIDATE (T:413-414)].
- **Forward-compatible, not guaranteed.** If CN-P3 later adds a shop control, it is expected to write through the same shipped route and routine, in which case this read needs no change; that is subject to CN-P3's own design and to F-2, and any change there may need a revision of this read. If F-2 ever changes what a withdrawal is (D16:219), that is a later additive migration and a later revision of this read.
- **Not designed or implied here.** Any withdrawal button, wording, confirmation, recovery or eligibility; whether a withdrawal may stand in for an offsetting document (F-2). The activity view has no action on any row.

### 3.3 Out of scope

- Preventing duplicates (D-P2-14 stays OPEN); alerts or thresholds (D-CN-12 B to D are not designed, D16:619-620); customer names (G-PRIVACY); tax and net (interim split, D17:792); refunds; filtering, search or export; payment rows; registrations or attempts (the lookup stays the recovery read); any store other than the one in the path.

---

## 4. The operator surface (shop) [PROPOSED; placement ADOPTED, D-CA-4 A]

### 4.1 Placement and who sees it

- **Placement.** A "Credit activity" sub-section inside the existing issued-invoices section (INV:838), for the store the owner has already chosen there ("Choose a store.", T:150). It sits after the issued list and before the issuing settings. Heading at the next level under the section's heading.
- **Who sees it** [ADOPTED, D-CA-4 A]. Under D-CA-4 A the section's shell (heading and state text) renders from the first request and for every outcome except a denial: Loading, Error with Try again, Rate limited and Session ended (§4.3). It is hidden, with no text, after a classified 403 (§8.4) or when the read is skipped (next bullet). Fail-closed, the same way CN-P2 hides its action on a lookup 403 (D17:155).
- **No request that is certain to be refused** [PROPOSED]. Under D-CA-1 A or C, when the section's store-directory entry for the chosen store says `readOnly: true` (SD:21-25), the shop does not send the read and the sub-section is hidden. After a route-level denial (§8.4) for a store, the shop sends no further request of this sub-section for that store until the generation or the chosen store changes, as CN-P2 never retries its lookup within a generation after a 403 (D17:155).
- **A 403 is classified first** (§8.4) [ADOPTED, D-CA-13 A]. A token-mismatch 403 (APP:949-951) has the same body as a permission 403 (D17:501-502), so any 403 from this read first runs the one fresh session check (`recheck`, T:2663-2669; D17:502; D17:504 rule 1): a **new token** → verified context loss, Doc 17 rule 3 (§8.4 (B1)): a new generation (`begin`, T:2589-2602, which also clears the chosen store), the denied answer dropped silently, and this view read from page 1 under the new token once a store is chosen again; the **same token** → the store directory is read directly (`drafts.listStores`, the call at T:2727) under this sub-section's own request number, never through `readStores` (T:2708-2742) or `denialOf` (T:2731-2732 → `cnNoAccess`, T:2676), which would apply rule 4 and empty the picker: a previously listed store no longer listed, or listed under another tenant → verified store loss, Doc 17 rule 4 only (§8.4 (B2)); still listed under the same tenant → a **route-level denial, cause not established** (§8.4 (A)): this view's rows dropped and the sub-section hidden; any failure of the session check or of the directory read → unverified (§8.4 (U)): hidden, no cascade.
- **Rule 4 is not triggered by this read** [ADOPTED, D-CA-12 A]. D17 rule 4 (D17:509) clears every owner-only name and lookup row in the issued-invoices section on a confirmed same-token 403 from "any read or command of the section". This sub-section sits in that section, but its 403 is routine for managers and, under D-CA-1 A, for owners of a read-only or overdue tenant, so it is excluded (D-CA-12 A): a route-level denial from this read (§8.4 (A)) clears only this sub-section's own rows. That **amends** D17 rule 4's second bullet (D17:509, "any read or command of the section") for this one read; under D-CA-12 A that amendment is applied to D17:509 (2026-11-18, §14.1; an edit of D17 on the owner's instruction, not made by this document). The candidate's `denialOf` applies rule 4 to the cards on every confirmed same-token denial (`cnNoAccess`, T:2671-2679), so this read must not call it as it stands; it calls `recheck` and its own judgement (new code). Effect: CN-P2's names and recovery actions are then cleared only by CN-P2's own reads and commands or the other shipped reads rule 4 names, so a demotion seen first by this read is acted on in CN-P2 at its next own answer, within the display delay D17 already accepts (D17:510).
- **No new navigation entry** (D-CA-4 A).

### 4.2 Each row, in this order

| Field | Display | Source |
|---|---|---|
| Number | "CN-<n>" (T:412) | `number` |
| Invoice | "Invoice <n>" | `invoiceNumber` |
| Status | "Active" or "Withdrawn", as text, never by colour, strike or icon alone | `withdrawal` null or not |
| Amount | gross, formatted by the shop's `formatCents` as US dollars (DC:233-240) | `grossCents` |
| Reason | the adopted reason label (D17:561) | `reason` |
| Issued | "Issued {time}" in a `time` element with `datetime`, then "Issued by {name}"; `null` → "Name not set" (T:417, T:419) | `issuedAt`, `issuedByName` |
| Withdrawal | "Withdrawn {time}", the withdrawal reason label, "Withdrawn by {name}" (T:416, T:418) | `withdrawal.*` |

- Names wrap anywhere (`[overflow-wrap:anywhere]`) inside `bdi`, as the candidate's invoice-level list does [CANDIDATE (T:6270-6273)].
- Every `T:` string reference in this section (T:411-419, `CREDIT_TEXT`) is CN-P2 candidate code, not SHIPPED; if the candidate changes, this section follows the committed text.
- A `ul` with one `li` per credit note; newest first as served.
- **Currency.** No currency field is served: an issued invoice's currency is `USD` by constraint (M34:390), and every credit note belongs to one issued invoice (M38:326-327). If a later migration admits another currency, this read must gain a currency field first.

### 4.3 States and text

| State | Text (proposed) | Behaviour |
|---|---|---|
| Loading | "Loading credit activity…" | First page in flight |
| Empty | "No credit notes have been issued at this store yet." | Only after a read to `nextCursor: null` |
| Ready | a "Refresh" button (D-CA-15 B), the rows, then "Show more" while `nextCursor` is not null | "Show more" reads the next page; focus stays on it; "{n} more loaded." is announced (CREDIT_TEXT.moreLoaded, T:411). "Refresh" starts a new traversal at page 1 and replaces the loaded chain (§6.3); focus stays on it |
| Error | "Credit activity couldn't be loaded." and "Try again" | A failed page never shows partial rows as complete; Try again restarts from page 1 |
| Not available (404) | the Error text and "Try again" | A 404 `not_found` (the route is absent, for example on a runtime built for 001..N-1: the production branch of §9.3.3 or the rehearsal of §9.3.7; APP:426) is never data and never Empty: the Error state, no cascade, no automatic retry; Try again reads page 1 again |
| Rate limited | "Too many requests: this comes back once the wait has passed." (LIST_TEXT.waiting, T:166) | Waits Retry-After; no request of this sub-section is sent during the wait, Show more and Try again included |
| Session ended (401) | the section's existing ended text, "Your server session ended. Reconnect to see issued invoices." (ISSUED_TEXT.ended, T:151) | All rows dropped; nothing re-sent until Reconnect |
| Denied (403) | nothing rendered, after the session check and the directory read classify it (§8.4) | (A) route-level denial, cause not established (same token, store still listed): all of this view's rows dropped; the sub-section disappears; D17 rule 4 not triggered (D-CA-12). (U) unverified: the same, plus any wait the failure carries. (B1) new token: D17 rule 3. (B2) previously listed store lost: D17 rule 4 only. (B0) signed out: the session-end path. §8.4 gives each |
| Context change | — | A store switch, sign-in renewal, token or user change drops every loaded row and reloads from page 1, once; a second mismatch shows Error (D17:571's rule, applied here). Reads from page 1 happen only here, on Refresh, on Try again, and after this tab's own successful issue or Confirm at this store (D-CA-15 B; §6.3) |

- *Implementation note (shop slice, AUTHORED AND UNRUN, 2026-11-19; records what was built and changes no adopted text above).* **Recovery:** a failed page, Show more included, drops every loaded row AND the cursor (no Show more is offered and no state keeps a cursor without its rows); recovery is always page 1 — Try again starts a fresh traversal with no `after`, and after a 429 only once the Retry-After wait has passed (nothing of this sub-section is sent during it). **Full-page cursor:** the shop decoder accepts a non-null `nextCursor` only behind a full page of 50 naming its last id, stricter than §4.4's wording, because the server sends one only when a 51st row exists (`server/runtime/invoiceCreditNotes.ts`: `storeCreditActivityOf` :774-800 keeps at most 50 and sets `hasMore` at :795; the route writes `nextCursor` from it at :836). **Test opt-in:** the component's `creditActivity` prop is on by default (the shop passes none); the component test rig defaults it off so the older describes keep their exact request logs and scripted session answers, and the new "store-wide credit activity" describe opts in.
- **Intro line** under the heading: "Credit notes issued at this store, newest first. Use it to spot a credit note issued twice. It does not stop one being issued." Plain statement of detection, not prevention (§10).
- **Words.** No string says paid, unpaid, refund or balance; "withdraw" appears only for a credit note. The strings must pass the shipped word scans that apply outside the Payments section (D17:974-976), with one known exception: D17:976 bans "withdraw" in every string outside the invoice-level list, and this view shows "Withdrawn {time}" and "Withdrawn by {name}" (T:414, T:416, T:418) outside that list. That scan's scope must be widened to this view's list, narrowly, as DIS-16 did for three button names (D17:132); implementation records it. Checking the rest is acceptance row CA-21.
- **Accessibility.** Status by text; times in `time` elements; a live region announces "{n} more loaded."; the screen-reader pass is Q-layer work and stays deferred. G-A11Y stays OPEN.

### 4.4 Shop decoder [PROPOSED]

As strict as the credit-note list decoder (D17:573): exact top-level keys; `store.id` equal to the requested store; exact item keys; positive integer `number` and `invoiceNumber`; `grossCents` 1 to 2^53 − 1; known issue and withdrawal reasons; names a string of at most 1,000 characters without a control character, or `null`; `withdrawnAt` not before `issuedAt`; at most 50 items; **strictly descending `number`**; ids unique within and across pages; `nextCursor`, when not null, equal to the last served item's id (null when no 51st row existed); a repeated cursor or an empty page with a cursor → Error. Every page must share the first page's context (user, token, store, tenant).

### 4.5 Read discipline (inherits D17 §3.6 rules 1-3) [PROPOSED]

This read adopts D17:504-506 in full, with no exception:
1. `connect()` first (it re-reads the session); the generation (number and token) captured **before** the send (D17:502; D17:504).
2. Its own request sequence, separate from the issued list's, the invoice-level list's and the lookup's: a first page, a Show more and a Try again each take the next number; only the latest number may apply.
3. An answer applies only if the generation, the request sequence, the store and `sessionEndsSoFar()` are all unchanged since the send (D17:504); any other answer is stale and dropped silently, with no state change.
4. Rows, cursors and the empty state belong to one generation and one token (D17:505).
5. On any token adoption (a sign-in or Reconnect in this tab, a focus or pre-read check finding another token, the post-403 recheck finding another token), every row and cursor is dropped before any new request (D17:506). The read then starts again from page 1 once a store is chosen: `begin` clears the chosen store, so nothing is sent until then (§4.1, CA-25). `renew` and `renewKeepingView` move the generation without `begin`, so this state is dropped there by new code (D17:506).

---

## 5. The read route [PROPOSED]

### 5.1 Request

| Item | Value |
|---|---|
| Method and path | `GET /api/v1/stores/{storeId}/credit-notes` |
| Query | none, or exactly `after=<canonical lowercase uuid>` (the previous page's `nextCursor`); anything else, a bare `?` and any `limit` key included, is 400 (§6.3, D-CA-6) |
| Body | none (`body: { kind: 'none' }`) |
| Headers | the session cookie; `x-tmpos-session-csrf` with exactly that session's token (APP:947-952) |
| Route shape | `readRoute(...)` as RT:378-391: `access: 'session'`, `audience: 'tenant'`, `idempotency: 'none'`, `trustedContext: 'required'`, `recentAuth: 'none'`, `sessionBinding: 'required'` |
| Permission | the key chosen under D-CA-1, at store scope |
| Registration | a new closed store template beside `GET …/credit-note-attempts` (ROUTES:522) and in the tenant entry's route inventory (TE:178); the template count in ROUTES:85-86 rises by one |

No path collision: the per-invoice list is `…/invoices/{id}/credit-notes` (RT:66); the store-level path has no invoice segment.

### 5.2 Response 200

```json
{
  "store": { "id": "<storeId>" },
  "creditNotes": [
    {
      "id": "<creditNoteId>",
      "number": 42,
      "invoiceId": "<invoiceId>",
      "invoiceNumber": 1007,
      "grossCents": 1500,
      "reason": "pricing_error",
      "issuedAt": "2026-11-18T10:15:30.123456Z",
      "issuedByName": "A. Owner",
      "withdrawal": null
    },
    {
      "id": "<creditNoteId>",
      "number": 41,
      "invoiceId": "<invoiceId>",
      "invoiceNumber": 1003,
      "grossCents": 2000,
      "reason": "billing_error",
      "issuedAt": "2026-11-17T09:00:00.000000Z",
      "issuedByName": null,
      "withdrawal": { "withdrawnAt": "2026-11-17T09:30:00.000000Z", "reason": "wrong_amount", "withdrawnByName": "B. Owner" }
    }
  ],
  "nextCursor": null
}
```

- Exactly these key sets, each value of its stated type (key order is not part of the contract). `invoiceId` and `invoiceNumber` are flat, as the attempts read serves them (RT:576). Times are the database's UTC text with microseconds (M38:1463; M38:1893).
- **Names are always present** (a string or `null`): under every D-CA-1 option only a store owner is answered (A to C by the catalog, D by the routine's own denial), so there is no names-hidden view.
- **No tax or net** [ADOPTED, D-CA-5 A]: the split is interim and not a tax record (D17:792); the per-invoice list keeps carrying them for its own decoders.
- The route serves rows 1 to 50 of what the routine returns. `nextCursor` is the 50th served row's `id` only when a 51st row exists; otherwise `null`.
- Chain-wide headers mark the answer no-store (ISS:67-68).

### 5.3 Error contract

All refusals are `{ "error": "<word>", "requestId": "<id>" }`; the reason in the third column is logged only.

| Status | `error` | When | Log reason (proposed) |
|---|---|---|---|
| 404 | `not_found` | Unknown host or route (chain) | — (APP:861-863 host; APP:426 route) |
| 400 | `invalid_request` | The client address cannot be resolved for the limiter (chain) | the resolver's reason (APP:869) |
| 503 | `service_unavailable` | The rate limiter cannot answer (chain) | the limiter's verdict (APP:835) |
| 429 | `rate_limited` | Per-client limit; `Retry-After`; nothing stored | — (APP:839, APP:871) |
| 417 | `expectation_failed` | An `Expect` header on an HTTP/1.1 request (chain) | `expect_unsupported` (APP:876) |
| 401 | `unauthenticated` | No session, ended, revoked or expired; also a session that admission ends on this request | — (APP:460); when admission ends the session, `session_admission_denied` or `session_version_mismatch` (`server/runtime/sessions.ts:636-642`) |
| 403 | `forbidden` | CSRF header missing, repeated or another session's | — (APP:949-951) |
| 403 | `forbidden` | No trusted context for a route that requires one (chain) | `authz_context_missing` (APP:978) |
| 403 | `forbidden` | Permission denied: not a store-scope `store_owner` with limitation `none` (under D-CA-1 A), a manager included; also no grant at the path's store | `authz_denied`: produced by the access check (`server/runtime/access.ts:202`) and logged by the chain's authorization step (APP:955-956), not by the handler (decision rules PERM:563-565 at base; in this worktree `m5CanonicalPermissions.ts:565` and `:574`) |
| 400 | `invalid_request` | Query not empty and not exactly `after=<uuid>` | `store_credit_activity_query_invalid` |
| 403 | `forbidden` | Handler: the scope is not a store scope, or the path store is not the scope's store | `authz_context_missing` (RT:370-375) |
| 403 | `forbidden` | Routine answered `denied` (role, membership, store, tenant, standing or status no longer admits the caller) | `store_credit_activity_denied` |
| 400 | `invalid_request` | Routine answered `cursor_unknown`: the id is not a credit note of this tenant and store | `store_credit_activity_cursor_unknown` |
| 503 | `service_unavailable` | Deadline, raise, outage, or an answer out of shape (a name over 1,000 characters included) | `store_credit_activity_answer_invalid` or the outage reason |

- The order is the chain's (D17:86, minus step-up and idempotency, which a read does not have), then the handler's: query, scope, port, decode (RT:686-702).
- A store the session has no grant for is 403, never 404: the path store must equal the trusted scope's store (RT:373).

---

## 6. The database routine (migration 039) [PROPOSED]

### 6.1 Signature

```sql
create function tmpos_invoice_credit_note.m7b_store_credit_activity(
  p_session_key text, p_expected_tenant uuid, p_expected_store uuid, p_after_credit_note_id uuid, p_limit integer)
returns table (
  o_outcome                text,    -- 'credit_note' | 'denied' | 'cursor_unknown'
  o_tenant_id              uuid,
  o_store_id               uuid,
  o_credit_note_id         uuid,
  o_credit_note_number     bigint,
  o_invoice_id             uuid,
  o_invoice_number         bigint,
  o_gross_cents            bigint,
  o_reason_code            text,
  o_issued_at              text,
  o_issued_by_name         text,
  o_withdrawn_at           text,
  o_withdrawal_reason_code text,
  o_withdrawn_by_name      text
)
language plpgsql
stable
security definer
set search_path = pg_catalog, pg_temp
set row_security = off
set debug_print_parse = off
set debug_print_rewritten = off
set debug_print_plan = off
```

The name is a proposal; it lives in 038's schema, `tmpos_invoice_credit_note`, beside the lookup and the list.

### 6.2 Body, in order

1. **Arguments.** A malformed session key (the lookup's pattern, M38:1467), a null tenant or store, or a `p_limit` that is null or outside 1 to 51 raises `invalid_parameter_value` with fixed text (M38:1467-1476).
2. **Authority.** `tmpos_invoice_issue.m7b_issue_store_reader(p_session_key, p_expected_tenant, p_expected_store, false, 'view')`: read statuses, Invoices at View or more, Customers at View or more, exactly one store-scope grant at that store on that tenant, still its active membership (M34:1028-1029). Then `o_role = 'store_owner'`. Anything else returns one `('denied', NULLs)` row (M38:1477-1484's pattern). Unlike the lookup, which asks the reader for `'approve'` (M38:1479), this read asks for `'view'`, as the list's name check does (M38:1924); for a `store_owner` (Invoices Full) both pass, so the role check decides.
3. **Cursor anchor**, only after the authority: when `p_after_credit_note_id` is not null, read that note's `credit_note_number` where `credit_note_id = p_after_credit_note_id and tenant_id = <reader tenant> and store_id = p_expected_store`. Not found → one `('cursor_unknown', NULLs)` row (M38:1485-1494's pattern).
4. **Rows.**

```sql
select 'credit_note', c.tenant_id, c.store_id, c.credit_note_id, c.credit_note_number, c.invoice_id, i.number,
       c.gross_cents, c.reason_code::text, to_char(c.issued_at at time zone 'UTC', <format>), ui.display_name::text,
       to_char(w.withdrawn_at at time zone 'UTC', <format>), w.reason_code::text,
       case when w.credit_note_id is not null then uw.display_name::text end
  from tmpos_invoice_credit_note.invoice_credit_note c
  join tmpos_invoice_issue.issued_invoice i
    on i.invoice_id = c.invoice_id and i.tenant_id = c.tenant_id and i.store_id = c.store_id
  left join tmpos_invoice_credit_note.invoice_credit_note_withdrawal w on w.credit_note_id = c.credit_note_id
  left join public.app_user ui on ui.internal_user_id = c.issued_by
  left join public.app_user uw on uw.internal_user_id = w.withdrawn_by
 where c.tenant_id = <reader tenant> and c.store_id = p_expected_store
   and (p_after_credit_note_id is null or c.credit_note_number < <anchor number>)
 order by c.credit_note_number desc
 limit p_limit;
```

   The joins are the ones 038's list and lookup already use (M38:1945-1948; M38:1511-1512). An empty page returns no row (the lookup's convention, M38:1525).
5. **Never returned.** Actor ids, emails, registration ids, attempt ids, session digests, customer data, tax or net.
6. **Writes, locks, audit.** No row written, no audit row, no row locks (no FOR UPDATE or FOR SHARE) and no advisory locks; like any query it holds ACCESS SHARE on the tables it reads until its transaction ends. STABLE: every statement sees one snapshot, so a page is never a mixture of before and after a concurrent issue or withdrawal (M38:1881-1883).

### 6.3 Pagination contract [PROPOSED; cursor form ADOPTED, D-CA-6 A; refresh ADOPTED, D-CA-15 B]

- **Cursor format.** `after=<creditNoteId>`: the previous page's `nextCursor`, a canonical lowercase uuid. The query is either empty or exactly one `after` key with such a value. Anything else is 400 `invalid_request` (log reason `store_credit_activity_query_invalid`) before any port call: a bare `?`, an empty value, uppercase hex, braces, a second key, a repeated `after`, and any `limit`, `cursor` or `before` key. This is the credit-note family's parser (RT:668-676).
- **What the cursor must name.** A credit note of the same tenant and the same store as the request. Every credit note of the store is visible to a caller admitted at that store (§7), so "visible to the caller" adds no further condition. The routine checks the cursor only after the authority (§6.2 step 2, then step 3), inside `tenant_id = <reader tenant> and store_id = p_expected_store`.
- **Malformed versus well-formed but unknown or foreign.** A well-formed id that names no credit note, a credit note of another store, or one of another tenant gives `cursor_unknown`, answered 400 `invalid_request` (log reason `store_credit_activity_cursor_unknown`): the same status, `error` word and body shape as a malformed query; only `requestId` and the logged reason differ. That is the house convention (RT:701; ISS:745-746). A caller not admitted at the store gets 403 before the cursor is read (§6.2). So no answer tells whether an id exists in another store or tenant.
- **Page size.** Fixed: 50 served, 51 asked, as the credit-note family (RT:77-81). There is no `limit` parameter; a `limit` key is 400. Adopted: fixed (D-CA-6 A). Option B's `limit` (minimum 1, maximum 50, default 50: this slice's proposed default; the issued-invoice list's own form defaults to 20, ISS:55) adds a validation surface and no operator need.
- **Order.** `credit_note_number` descending. The number is unique per tenant and store by constraint (M38:323), so it is a total order within the store and **needs no tie-breaker**. The cursor names a credit-note id; the routine re-reads that id's number inside the caller's tenant and store.
- **Why the number and not `issued_at`.** Every issue in a store takes the store's counter row FOR UPDATE before its single clock reading (M38:56-57; M38:65), so a higher number was issued later in that store. Ordering by the number also matches "newest number first" in the issued-invoice list (ISS:10; ISS:56).
- **A live read, not a snapshot.** Each page is one snapshot of its own (STABLE, M38:1881-1883), but the pages of one traversal are read at different times; the traversal as a whole is a live read.
- **Ordering guarantee within one traversal** (page 1, then each "Show more" up to `nextCursor: null`): rows are strictly newest number first; every note that existed when the traversal's page 1 was read appears exactly once, none skipped or repeated, because a note's number never changes and the credit-note and withdrawal tables are insert-only behind guards that refuse UPDATE, DELETE and TRUNCATE (D16:217-218); a note issued during the traversal has a higher number than every loaded row (M38:56-57; M38:65), so it appears only on a new traversal and is never spliced into the loaded chain.
- **Status per page reflects the time that page was read.** A withdrawal adds a withdrawal row; the note keeps its number. So a "Show more" page can show a newer status than page 1 (a note on page 2 withdrawn after page 1 loaded shows Withdrawn, while a note on page 1 withdrawn at the same moment still shows Active). The shop never re-sorts, merges or rewrites loaded rows; the decoder still requires strictly descending numbers across pages (§4.4).
- **A new traversal replaces the loaded chain.** It starts at page 1 on Refresh (D-CA-15 B), Try again, the store chosen again, a context change, a page reload, or once after this tab's own successful issue (201) or Confirm (200) at this store if the view is loaded. Page 1 is then shown alone; rows loaded on later pages are gone until "Show more" loads them again. That own-tab re-read is kept: it is the same operation as Refresh, triggered by the one change this tab knows it made. No timer.
- **Cursor binding.** The cursor is bound to tenant and store by the routine (step 3), and authority is checked first (step 2), so a cursor from another store or tenant answers 400, and only to a caller already admitted at this store. The shop also binds it to its own context (§4.4) and never sends a cursor across a context change (§8.2).

### 6.4 Grants

```sql
revoke all on function tmpos_invoice_credit_note.m7b_store_credit_activity(text, uuid, uuid, uuid, integer)
  from public, anon, authenticated, tmpos_app, tmpos_audit_writer;
grant execute on function tmpos_invoice_credit_note.m7b_store_credit_activity(text, uuid, uuid, uuid, integer) to tmpos_app;
```

`tmpos_app` already holds USAGE on the schema (M38:242-243). The preflight's approved list gains one line in the form of PRE:137 and PRE:143.

### 6.5 Indexes

- **Adopted row model (D-CA-2 A): no new index.** The page is a backward scan of the existing unique index `invoice_credit_note_number_key (tenant_id, store_id, credit_note_number)` (M38:323), and the joins use primary or unique keys: the issued header's `(invoice_id, tenant_id, store_id)` (the foreign-key target, M38:326-327), the withdrawal's primary key (M38:356) and `app_user`'s `internal_user_id`.
- **Under D-CA-2 B (an event feed)**, 039 would need two new indexes: on `invoice_credit_note (tenant_id, store_id, issued_at, credit_note_id)` and on `invoice_credit_note_withdrawal (tenant_id, store_id, withdrawn_at, credit_note_id)`.

### 6.6 Server code that changes (authored 2026-11-19, unrun)

- `server/runtime/invoiceCreditNotes.ts` (or a sibling module): the route, its query parser, its decoder and the port method, in the shape of RT:541-583.
- `server/persistence/postgresInvoiceCreditNotes.ts`: the port method calling the routine with bound parameters, in the shape of PGCN:350-367.
- `server/runtime/routes.ts` (ROUTES:85-86, :522) and `server/entry/tenantEntry.ts` (TE:178): the template and the inventory.
- `server/composition/tenantTransactions.ts`: composes the route into the tenant read inventory over the same `invoiceCreditNotes` port (its new `storeActivity` method), and adds that method to the inert port. Not listed before implementation; the route cannot be served without it.
- `server/platform-identity/m5CanonicalPermissions.ts`: only under D-CA-1 A, B or D as §8.1 states.
- `server/persistence/postgresStartupPreflight.ts`: the ledger row for 039 (PRE:97's form) and the grant line.
- Shop: `src/tenant/invoiceIssuingClient.ts` (helper and decoder) and `src/tenant/ServerIssuedInvoices.tsx` (the sub-section, its frozen text block, and the 403 classification of §8.4: `recheck` plus a store-directory re-read, without the candidate's `denialOf`, which applies rule 4, T:2671-2679).
- Only under D-CA-14 A: the **write setting** of §9.3.1, shipped twice: in the N-built runtime, which pauses issuance in production (§9.3.2), and in the **predecessor build** (a runtime for the ledger 001..N-1, deployed before N is applied), which serves the 001..N-1 branch and the rehearsal (§9.3.3 says why it stays).
  - *Where it is checked.* In the chain in `server/runtime/app.ts`, immediately after authorization (APP:955-957) and before the trusted-context, step-up and target steps and the body read (APP:1053-1056), so before idempotency acquisition (APP:1102). A route declares it by a new route-table attribute (proposed `writeGate: 'credit_note_write'`) on exactly three routes: register (RT:7), issue (RT:9) and withdrawal (RT:12). A check inside the route module would run after the body read and after idempotency acquisition and would break "no key, no lease".
  - *Its configuration.* A new tenant-entry variable beside `APP_DATABASE_URL` (`server/platform-identity/config.ts:87`), proposed `TMPOS_CREDIT_NOTE_WRITES` with exactly `on` or `off`; anything else, or absence, refuses startup, as the preflight refuses a wrong ledger (PRE:432; PRE:444). The runtime logs the value and its instance id once at startup, so an operator can prove which instances run with it off, and since when (§9.3.2 step 3; §9.3.7 step 2). Adopted as design with it on 2026-11-18 (with D-CA-18 C; implementation and verification **PENDING**): the startup line also records the database clock read through the instance's startup preflight (§9.3.2, times; how and against what, and its failure rule, in the clock bullet below, amended 2026-11-19), and the runtime writes the **write log line** of §9.3.4 for each register, issue, settlement and withdrawal command whose commit call returns: in `server/runtime/app.ts`, immediately after `commitCommand` returns (APP:1147) and before the response is sent (APP:1227-1229), from the prepared command's own correlation id and aggregate id (CT:580; CT:680-685), with its closed field list added to `server/runtime/logging.ts` beside the session operation's `operationId` (`server/runtime/logging.ts:22-23`), the precedent for a server-generated id that joins a log line to an audit row (APP:793-796; `server/runtime/sessions.ts:734-735`). It needs no migration, no routine change and no mutation-contract change (§9.3.4).
  - *Files changed (write setting and write log line, authored 2026-11-19, unrun; records what was built and changes no adopted text above).* `server/platform-identity/config.ts` (`CREDIT_NOTE_WRITES_VAR`); `server/entry/tenantEntry.ts` (validation: absent is `credit_note_writes_missing`, any value but `on` or `off` is `credit_note_writes_invalid`; a `randomUUID()` instance id per start; `startup_ready` carries `instanceId` and `creditNoteWrites`); `server/runtime/routes.ts` (the attribute is `writeGate: 'credit_note_write'`, required on exactly the three routes and refused on any other, `route_write_gate_invalid`); `server/runtime/invoiceCreditNotes.ts` (the three declarations); `server/runtime/app.ts` (the check right after the access step, refusal reason `credit_note_writes_disabled`; startup refuses a credit-note writer without the setting or an instance id, `credit_note_writes_invalid`, `instance_id_invalid`; the line after `commitCommand`, `committed` on null and `unconfirmed` on the final 503 except a lost lease, §9.3.4 as amended 2026-11-19); `server/runtime/logging.ts` (the closed fields). Tests and fixtures: `server/runtime/logging.test.ts`, `server/runtime/invoiceCreditNotes.test.ts`, `server/entry/tenantEntry.test.ts`, `server/entry/tenantMain.test.ts`, `tests/db/invoiceCreditNoteHttp.integration.test.mjs`, `tests/db/tenantEntry.integration.test.mjs`, the tenant-entry environment of eighteen `tests/db` suites and `tests/qa/interactive/supervisor.mjs`. The browser suite's environment (`tests/browser/shopRoleLevels.browser.test.mjs`, its `ENV`) also carries `TMPOS_CREDIT_NOTE_WRITES: 'on'`, so its tenant entry still starts.
  - *The startup database clock and its failure rule [AMENDED 2026-11-19 on the owner's instruction; authored, unrun].* This bullet's TE, PRE, SPC and APP line numbers are the worktree's as of 2026-11-19, since the clock code does not exist at the revision the rest of this document cites. The order is fixed. Step 1 checks `TMPOS_CREDIT_NOTE_WRITES`: absent or anything but `on` or `off` refuses startup before any database client is constructed (TE:222-224, at step 1, TE:292-293; step 2 constructs it, TE:298-300). The sample is taken at step 10b, after every startup check and readiness probe and before the listener binds, readiness is set or `startup_ready` is emitted (TE:441-450; TE:486-489).
    - *The read.* One read-only statement in its own transaction: `select pg_catalog.to_char(pg_catalog.clock_timestamp() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')` (PRE:701-709). It is the same UTC text form the migrations already use for row times, for example `to_char(i.issued_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`.
    - *Where it is read.* Through the startup preflight's database client (`tx.preflight`, TE:306), the supervised kernel client over the configured runtime endpoint and login (`server/composition/transactionKernel.ts:136-138`). This is the client through which steps 3-6 connected and validated the runtime login, the migration ledger and parameter logging. It is not one pinned physical connection: the kernel holds pools of one connection, retires any it stops trusting and opens a fresh one for the next transaction (SPC:19-38). So the sample comes from the same configured endpoint and login, not necessarily the same session.
    - *Why the instant cannot shift.* The server computes and formats the value. `AT TIME ZONE 'UTC'` applied to a `timestamptz` gives the UTC wall time whatever the session's `TimeZone`, and `to_char` formats it with no further conversion. The driver returns the text as a string, with `fetch_types` off and no custom type parser (SPC:294 passes the caller's options; `server/platform-identity/db.ts:281-290` and `:369-371` set no `types` or `transform`). The entry and the logger pass that string through unchanged, so the process timezone never touches it.
    - *Failure rule.* No answer within the step's bound, an error, or anything other than exactly one row whose value has the shape `YYYY-MM-DDTHH:MM:SS.ffffffZ` (PRE:498, `DATABASE_CLOCK_RE`), or a value of that shape that does not name a real UTC instant (a round-trip check, PRE:706-708, added on review 2026-11-19), refuses startup: `database_unavailable` with the fixed code `startup_clock_unanswered`. The listener never binds, readiness is never set, no `startup_ready` is emitted, and the database's text is never logged.

---

## 7. Tenant and store isolation [PROPOSED]

| Layer | What isolates |
|---|---|
| Chain | The session is the caller's own (cookie plus that session's CSRF token, APP:947-952); the trusted scope must be a store scope with a tenant and a store, and the path store must equal it (RT:370-375) |
| Permission | A store-scope grant at that store (D-CA-1) |
| Routine authority | 034's reader re-derives tenant, actor, membership and role from the session key on every call, requires exactly one store-scope grant at `p_expected_store` on `p_expected_tenant`, still its active membership (M34:1028-1029); then `store_owner` |
| Routine rows | `c.tenant_id = <reader tenant> and c.store_id = p_expected_store`; the invoice join on all three of invoice, tenant and store |
| Cursor | Re-read inside the same tenant and store, after the authority |
| Shop | One view per load: rows, names and cursors belong to one context (user, token, store, tenant); any change drops them (D17:571) |

Two store-scope owners of one store both see every credit note of that store, including each other's, with names. That is the point of the read: it is how one owner can see another's duplicate (D10:1696).

---

## 8. Access changes, tenant states and permission

### 8.1 Permission [ADOPTED, D-CA-1 A]

**The catalog has no fitting key.** Two shipped facts meet here:
- The owner-only store keys are decided by the store owner rule, which requires role `store_owner` and limitation `none` (PERM:563-565), and the load guard admits an owner-only key only at Invoices `full` (PERM:353-355; PERM:382-391). So any owner-only key is denied while the tenant is read-only or overdue. [SHIPPED]
- The only view-level invoice key, `view_issued_invoices`, is granted by level, so managers and every reader of issued invoices hold it, and it survives read-only (PERM:325-327; PERM:555; D17:83). [SHIPPED]

So "owner-only" and "a plain view that survives read-only" cannot both be had without a catalog change. Options are in §14 (D-CA-1). The owner adopted **A** (2026-11-18): a new owner-only key (proposed name `view_store_credit_activity`, non-sensitive, Invoices `full`), added to the closed `STORE_OWNER_ONLY_ROUTE_PERMISSIONS` map (PERM:353-355), so the existing owner rule decides it unchanged. Under A the read is **denied (403) while the tenant or store is read-only or overdue** (§8.3).

### 8.2 Mid-session changes [PROPOSED; behaviour of shipped components cited]

| Change | Effect on the next request | Effect in the shop |
|---|---|---|
| Sign-out, session revoked or expired | 401 `unauthenticated` (APP:460) | Rows dropped; ended text |
| Tenant or store suspended, or pending activation | Denied at admission: `suspended` and `pending_activation` deny all protected access (TS:7-16) | Rows dropped (401 or 403) |
| Role changed (owner demoted) | The shipped server ends the session on a role change (D17:867; D17:882), so 401. Even if a request were admitted, the permission check (PERM:563-565) and the routine's role check deny it, 403 | Rows dropped; section disappears on 403 |
| Store reassignment (the grant moves to another store) | The session ends: 401 `unauthenticated`, log `session_version_mismatch`. Tenant admission is re-read on every request (`server/runtime/sessions.ts:133-136`) and its witness carries each grant's store (`server/persistence/postgresTenantAdmission.ts:200-204`), so the security version no longer matches and that session is revoked (`server/runtime/sessions.ts:640-642`). A 403 arises only in a race: 403 `authz_denied` if it lands between the session's admission read and authorization's own (`server/composition/tenantAuthorization.ts:389`; APP:955-956), or 403 `store_credit_activity_denied` if it lands between authorization and 039's reader (M34:1028-1029); the handler's own check (RT:373) cannot fire after authorization | Rows dropped; ended text (as sign-out) |
| Level edits | No effect under D-CA-1 A, B or C (decided by role). Under D, an Invoices level below View denies | — |
| A cursor from before the change | Checked after the authority, so it is never evaluated for a caller no longer admitted | The shop never sends a cursor across a context change |

Rows already on screen stay visible only until the shop's next request or its context check notices the change; that display delay is the same narrow residual D17 accepted for the invoice-level list (D17:968).

### 8.3 Read-only and overdue tenants

- The status decision maps `read_only` and `overdue` to `read_only`: "reads the role allows still answer" (TS:11-12).
- **Under D-CA-1 A (adopted):** the HTTP read is **denied** while the tenant is read-only or overdue, because the read_only rule denies any store key whose threshold is not View (PERM:555), and an owner-only key must be at Full (PERM:386); the owner rule also requires limitation `none` (PERM:564). The routine itself admits read statuses (step 2), so a direct call with a live key still answers: the same split as residual (a) for the attempts lookup (D10:1676 (a)). Cost of A: while read-only, no new credit note can be issued anyway (every writer requires write statuses, M38:49-50), and each invoice's own credit-note list stays readable under `view_issued_invoices`, which survives read-only (D17:83).
- **Under D-CA-1 B:** the read answers while read-only or overdue; this needs a catalog change for this one key: the read_only rule (PERM:555), the owner rule (PERM:564) and the load guard (PERM:384-391) must each admit it.
- **Suspended:** denied under every option (TS:13).

### 8.4 Access contract: outcome matrix and how the shop tells denials apart [PROPOSED; ADOPTED, D-CA-1 A, D-CA-12 A, D-CA-13 A]

**Roles.** The catalog's tenant roles are `store_owner`, `manager`, `technician` and `sales_staff` (AC:149). Their catalog default Invoices levels: `store_owner` Full by the owner short-circuit (PC:490-491), `manager` `full` (PC:498), `technician` `view` (PC:506), `sales_staff` `create` (PC:514). Levels can be edited by the owner; under D-CA-1 A, B and C the role decides, not the level.

**What the server returns.** 401 `unauthenticated` when the session is gone (APP:940-945; APP:460). Every other refusal in this matrix (404 aside, §4.3) is 403 `forbidden` with the one body `{ "error": "forbidden", "requestId": "<id>" }`, whichever layer refuses (CSRF APP:949-951; authorization APP:955-956; handler RT:370-375 with RT:689; routine `denied`); only the logged reason differs. The server does not tell a route-level denial from a lost store grant in the body: the bodies are identical by design (RT:364-367; APP:447-452; D17:501), and changing that is D-CA-13 B. So the shop classifies a 403 itself, with two shipped reads (below). A store the session has no grant at is 403, never 404 (authorization first, APP:955-956; then the handler, RT:373; RT:689), so nothing about another store's or tenant's existence is revealed.

| # | Requester (the path names this store unless stated) | D-CA-1 A (adopted) | B | C | D | Shop outcome | Class |
|---|---|---|---|---|---|---|---|
| 1 | `store_owner`, store scope at this store, tenant and store `active` or `trialing` | 200 | 200 | 200 | 200 | Rows | — |
| 2 | `manager` at this store | 403 at authorization: the store owner rule (PERM:563-565) | 403 (same) | 403 (same; `recover_invoice_credit_notes` is owner-only, RT:5-6) | 403 from the routine, log `store_credit_activity_denied`: the chain admits by level (PERM:325-327), the routine's role check refuses (§6.2 step 2) | Sub-section hidden; this view only | (A) |
| 3 | `technician` at this store | as row 2 | as row 2 | as row 2 | as row 2 (View holds `view_issued_invoices`) | as row 2 | (A) |
| 4 | `sales_staff` at this store | as row 2 | as row 2 | as row 2 | as row 2 (Create is above View) | as row 2 | (A) |
| 5 | Row 2, 3 or 4 with an owner-edited Invoices level below View | 403 (role decides) | 403 | 403 | 403 at authorization (level below View) | as row 2 | (A) |
| 6 | `store_owner` of another store in the same tenant, the path naming this store | 403 at authorization: no grant at the path's store (APP:955-956); a tenant-scope grant gives no store (SD:17-18) | 403 | 403 | 403 | The shop sends only stores its directory listed (SD:4-18), so this arises only from a store this tab listed before and the session lost (→ (B2)), or from a shop defect naming a store never listed in this tab (→ (A): this view only, no broader clearing) | (B2) or (A) |
| 7 | The path names a store of another tenant, or the expected tenant does not match | 403, the same body as row 6 | 403 | 403 | 403 | as row 6 | (B2) or (A) |
| 8 | `store_owner` of this store, tenant (or store) `read_only` | 403 at authorization (PERM:555; PERM:564) | 200 (catalog change, §8.3) | 403 (PERM:564) | 200 (`view_issued_invoices` survives read-only, PERM:555; the routine admits read statuses, §6.2 step 2) | A, C: the directory entry says `readOnly: true` (SD:21-25), so the shop does not send the read (§4.1); hidden, no cascade. If sent anyway, the 403 classifies as (A). B, D: rows | A, C: skipped or (A) |
| 9 | as row 8, tenant `overdue` | as row 8 (`overdue` maps to `read_only`, TS:11-12) | as row 8 | as row 8 | as row 8 | as row 8 | as row 8 |
| 10a | Tenant or store `suspended` or `pending_activation`, and the session no longer authenticates | 401 at authentication (APP:940-945; APP:460) | same | same | same | Session-end path | (B0) |
| 10b | Tenant or store `suspended` or `pending_activation` while the session was live (TS:13; the grants drop out of admission, D16:375) | 401 at authentication: admission is re-read on every request (`server/runtime/sessions.ts:133-136`). With no tenant or store grant left it is refused (`server/persistence/postgresTenantAdmission.ts:236`) and every session of the principal ends, log `session_admission_denied` (`server/runtime/sessions.ts:636-638`); with another grant left the witness changes and this session ends, log `session_version_mismatch` (`server/runtime/sessions.ts:640-642`). A 403 arises only in a race: 403 `authz_denied` if it lands between the session's admission read and authorization's own (`server/composition/tenantAuthorization.ts:389`; APP:955-956), or 403 `store_credit_activity_denied` if it lands between authorization and 039's reader (M34:1028-1029) | same | same | same | Session-end path, as row 10a; after a race 403 the shop's session check itself revalidates admission and finds the session ended | (B0) |
| 11a | Another session's CSRF token (the cookie now names another session) | 403 (APP:949-951) | same | same | same | Recheck finds a new token | (B1) |
| 11b | Missing or repeated CSRF header (a shop defect: the shop always sends the header, APP:947-952) | 403 (APP:949-951) | same | same | same | Recheck finds the same token and the directory still lists the store: classified (A), this view only. The defect is caught by CA-13, not by the classification | (A) |
| 12 | Signed out, revoked or expired session | 401 (APP:940-945; APP:460) | same | same | same | Ended text, rows dropped | (B0) |

**How the shop classifies a refusal** (new code in this sub-section; it reuses two shipped reads and none of the section's shipped denial handlers):

| Answer | Session check (`recheck`, T:2663-2669) | Store-directory read (`drafts.listStores`, the call at T:2727, under this sub-section's own request number) | Class | What the shop clears | Doc 17 rule |
|---|---|---|---|---|---|
| 401 | — | — | (B0) session ended | The section's shipped session-end path (`failSession`, T:2649-2660): every view cleared, ended text; holds detached on sign-out (T:2650) | Rule 4, first bullet ("a sign-out", D17:508) |
| 403 | Signed out | — | (B0) session ended | as 401 | as 401 |
| 403 | A new token | — | (B1) token adoption | `adopt` → `begin` (T:2604-2609; T:2589-2602): every loaded row of the section dropped, the chosen store cleared, the directory re-read by the section (T:2597-2601); nothing shown for the refused answer; this view reads from page 1 once a store is chosen again | Rule 3 (D17:506), with rule 4's first bullet as D17:508 states for a token adoption |
| 403 | Fails (429, outage, or an unreadable answer; `recheck` returns the failure, T:2666) | — | (U) unverified | This view hidden, no cascade; on 429 the §4.3 wait applies | None until verified |
| 403 | The same token | A store this tab listed before is no longer listed, or is listed under another `tenantId` | (B2) verified store loss with the same token (store reassigned, grant removed, store or tenant suspended) | Every owner-only name and lookup row in the section, and this view; the cards keep their last state with no buttons | Rule 4 only, second bullet (D17:509). Rule 3 does not apply: it needs a token adoption (D17:506) |
| 403 | The same token | The store was never listed in this tab (a shop defect) | (A) | This view only | None |
| 403 | The same token | The store is listed under the same `tenantId` | (A) route-level denial, cause not established | **Only this view**: its rows, cursor, names and request chain; the sub-section hidden; no further request for this store in this generation (§4.1). CN-P2's names, lookup rows and actions are not touched | None (D-CA-12 A, an amendment of D17:509, §4.1) |
| 403 | The same token | The directory read fails (403, 429, outage, unreadable) | (U) unverified | This view hidden, no cascade; on 429 the §4.3 wait applies; a 401 there is (B0) | None until verified |

- **Why the directory, and why read it directly.** The session read identifies the user and the token, not the role or the stores (D17:509; TSC:284-292). The store directory lists exactly the stores where the session holds one active store-scope grant whose tenant and store statuses admit a read, with `tenantId` and `readOnly` (SD:12-25). The section's own `readStores` (T:2708-2742) must not be used: it replaces the picker's list and, on a 403, calls `denialOf` (T:2731-2732), which applies rule 4 (`cnNoAccess`, T:2676). This sub-section calls `drafts.listStores` itself and only compares; the picker is not changed by it.
- **What (A) does not establish.** "Same token, store still listed" is also what a same-token demotion, a revoked permission or a move to read-only looks like. So (A) is named "cause not established", and its clearing is the conservative minimum: this view only. That is safe because (1) everything this read showed is dropped at once; (2) the CN-P2 state left on screen was read with the owner's rights in this session and stays only until CN-P2's own next answer, the delay D17:510 already accepts; and (3) the server still refuses every CN-P2 command under the new rights (PERM:563-565).
- **What (B0), (B1) and (B2) do.** Exactly what the named Doc 17 rule states; this sub-section adds nothing and removes nothing.
- **Order.** The session check runs first; the directory is read only on the same token. Answers to either that arrive after a newer generation or store choice are dropped (§4.5).

---

## 9. Migration N, provisionally 039 (§1 and D-CA-3; proposed contents; not created)

In this section N is this slice's migration number and 001..N-1 its predecessor ledger (§1 rule 1).

### 9.1 Contents [PROPOSED]

1. Transaction settings as 038's (M38:88-89); READ COMMITTED.
2. Apply-time checks, object checks only (no ledger clause, M38:72): 038's schema, tables and list and lookup routines exist; 034's store reader exists; none of N's objects exist; the applier owns, or inherits the owner of, every table the new definer reads (`invoice_credit_note`, `invoice_credit_note_withdrawal`, `issued_invoice`, `public.app_user`), as 038 and 037 check.
3. The routine (§6.1-§6.2) and its comment.
4. A rollback-order anchor, `tmpos_invoice_credit_note.m7b_store_credit_activity_prerequisites()`, a SQL-standard body naming as `reg*` constants 038's `invoice_credit_note`, `invoice_credit_note_withdrawal` and `m7b_invoice_credit_notes_list`, so 038's down fails (2BP01) while N is applied (038's own anchor pattern, M38:2706-2720). Granted to nobody.
5. Grants (§6.4).
6. No table, no column, no trigger, no row written, no index (under D-CA-2 A), and no `LOCK TABLE` statement (only the locks `CREATE FUNCTION`, `GRANT` and the catalog checks take).

### 9.2 N's down [PROPOSED]

- **The house convention it follows.** Each down of 036–038 "removes exactly what the up file created" and restores the previous migration's catalog exactly (M36D:4-12; M37D:4-9; M38D:4-11); each is run with the runtimes stopped, as the apply (M36D:14; M37D:11; M38D:13); each refuses, changing nothing, while its own migration is not applied (M36D:16-18; M37D:13-14; M38D:15-16); the downs of migrations that hold money evidence or unresolved attempts refuse once such rows exist, after which recovery is forward (M36D:19-22; M37D:15-17; M38D:17-20; D16:384); and 038's down ends with a postcondition that refuses if the restored catalog is inexact (M38D:21-22).
- **N's down.** Refuses, changing nothing, while N is not applied. Otherwise drops the anchor and the routine, with the grants that ride on them, and nothing else. It refuses on no data: N writes no row, so there is no evidence to protect.
- **Postcondition** (038's pattern, M38D:21-22): after the drops, the predecessor catalog must be exact, or the whole file rolls back: no function named `m7b_store_credit_activity` or its anchor remains in `tmpos_invoice_credit_note`; each of 038's credit-note routines still exists with exactly its approved ACL (the 038 lines of the preflight's grant list: in this worktree, after 039's ledger row, PRE:138-144 for the seven credit-note routines and PRE:157, PRE:162-163 for 038's three replacements in `tmpos_invoice_payment`; at base `eb10f4c` the same lines are PRE:137-143, PRE:154 and PRE:159-160); 038's tables are unchanged.
- Leaves 038 exactly as it was; afterwards 038's down is possible again under its own one-way rule (D16:383-384). Running 038's down is **not** part of this slice's rollback.
- **Where it runs.** Under D-CA-18 C (adopted) N's down runs only on disposable databases: in its own tests (CA-18) and in the rehearsal (§9.3.7). It is never run on a managed database; production recovery is forward (§9.3.2).

### 9.3 Recovery: forward-only in production; N's down only in disposable rehearsals [PROPOSED; production recovery ADOPTED, D-CA-18 C; coupling D-CA-8 A; means D-CA-14 A; verification D-CA-16 A; tenant access D-CA-17 A; release without the database write fence OPEN, §9.3.4]

**Production recovery is forward-only** (D-CA-18 C, adopted). N's down (§9.2) is never run on a managed database. When the activity read fails, or a defect in N is found, issuance is paused by the server write setting, the cause is repaired **forward** by a new migration at the next free number (§1 rule 4) or a new runtime build, the read is verified on an authorized session, every write in the evidence window is classified, and only then is issuance restored (§9.3.2 to §9.3.5). N's down and the coordinated rollback order stay in the design, and are run only on disposable databases, as a rehearsal (§9.3.7; CA-36). **Forward repair does not remove the runtime-secret exposure** (DA-93): while issuance is paused and the read is failing, a holder of the runtime's secrets can still issue directly; the evidence window (§9.3.4) detects such a write after the fact, it does not prevent it.

**Scope against 038's own recovery (D16:382-384)** [PROPOSED]. This section governs a failure of the activity read or a defect in N. A failure of 038 itself is governed by D16's 038 rollback (D16:382-384), not by this section, and that rollback **takes precedence from the moment the owner decides it**. Until that decision, a 038 failure (found by this section's triggers or otherwise) is handled under this section's runbook: writes `off`, tenants active, N and 038 applied (§9.3.2). From the decision, D16's steps 1–3 apply (D16:373-378: freeze; suspend affected active tenants; stop both runtimes; set every `tmpos_app` member login NOLOGIN and terminate its sessions, D16:377; check the remaining transactions, D16:378), and this section's paused-but-running state (§9.3.2, "Tenant access") does not, whether the 038 incident caused the read's failure or arose separately while a §9.3.2 pause was open. Such a pause resumes, with its baseline and evidence window kept, only after D16's forward recovery is applied and the runtimes restart, the tenant entry with the write setting `off`. A 038 defect fixed forward **without** a rollback decision is an ordinary forward migration at the next free number (§1 rule 4), applied in an apply window of D-CA-7's procedure. If a 038 rollback is decided **after N is applied** to that database (§1 rule 2 (iii)), three phrases of D16 read as follows: (1) D16:384's "until 039" and "a 039 migration" mean the 038 forward-recovery migration at the number §1 rule 2 gives it, so N's apply does not end D16:384's stop; (2) D16:384's "a 038-built runtime" means a runtime built for the database's current ledger (001..N, or 001..N+k after repairs), since a runtime built for 001..038 refuses that database: first at startup step 4, `database_login_unsafe` with `role_privilege_unexpected`, because N's grant is not in its approved list (PRE:402-404; `server/entry/tenantEntry.ts:315-322`; with the standard grants this step-4 refusal was observed in-process for the compiled tenant entry on 2026-11-20, §9.3.1 evidence item 2 and §13, with the production process exit pending), and with `migration_unknown` (PRE:432) only if the grants were aligned by hand (source-traced 2026-11-19, not run); (3) D16:383's clean down is unavailable: 038's down fails on N's anchor (§9.1 item 4), and N's down is not run on a managed database (D-CA-18 C), so only D16:384's forward branch remains. No D16 text is edited; §14.2's optional amendment is not applied (D-CA-3 A).

#### 9.3.1 What every recovery path shares

**Why the runtime and the ledger move together.**
- The startup preflight pins the exact ledger (PRE:97) and the grants. Both entries judge the runtime login's grants (step 4, PRE:395-409, over every routine, table and schema ACL, PRE:579-591) before the ledger (step 5): `server/entry/tenantEntry.ts:315-322` (step 4, its `database_login_unsafe` refusal at :322) and :324 (step 5 begins); `server/entry/productionEntry.ts:194-203`. N adds a grant (039's EXECUTE on `m7b_store_credit_activity`, M39:238; PRE:146). So a runtime built for 001..N refuses the predecessor database at step 4 with `database_login_unsafe` / `role_privilege_missing`, since `tmpos_app` is reached and lacks N's grant (PRE:405-409). A runtime built for 001..N-1 refuses a database with N at step 4 with `database_login_unsafe` / `role_privilege_unexpected` (PRE:404). Both step-4 refusals, with the standard grants, were observed for the compiled tenant entries on 2026-11-20, in-process (§13, "Local build and ledger mismatch startup checks"; results and files under evidence item 2 below, with the production process exit pending); the admin entry's is source-traced only. `migration_missing` (PRE:444) and `migration_unknown` (PRE:432; its generic branch is unit-tested with a fake `040` row, `server/persistence/postgresStartupPreflight.test.ts:587`) answer only when step 4 passes, for example with grants aligned by hand: a separate case, source-traced 2026-11-19 and not run. So every apply, N's or a repair's, needs a runtime restart around it, and in the rehearsal N's down runs with the runtimes stopped and runtimes built for 001..N-1 start after it.
- Under D-P2-13 A, CN-P2 may not be in production without this read (D17:595; D17:942). So every recovery path **pauses CN-P2 issuing first**, and restores it only after the read is verified on an authorized session (and, under §9.3.4, the closing scan backed by the database write fence, which alone closes the window fully, or by check (ii) with the owner's accepted no-fence residual, which permits release without full closure: both OPEN) (D-CA-8 A).

**"Pause CN-P2 issuing" means the issuing controls only**: every control that can send a credit-note register or issue request [CANDIDATE]: "Issue credit note" (T:425; rendered at T:6081 and T:6437), "Continue issuing" and "Issue another credit note" (T:452; T:458; T:6226), and "Check again" while the attempt is at its register or issue stage (T:496; T:6214; D-P2-9, D17:794). The **recovery controls** ("Look up attempt", T:495, T:6233; "Continue checking", T:423; "Confirm credit note", T:464, T:6203, T:6332; "Release attempt", T:466, T:6332; "Hide this attempt", T:500, T:6245; "Check again" at the settlement stage) and the **read controls** (the invoice-level credit-note list, its "Show more" and "Try again") are not part of it and should stay operational, so owners can recover.

**What the code supports today: no switch.**
- Whether "Issue credit note" is offered is computed only from the session, the invoice and the holds (`offered`, T:6541). `grep -nE "process\.env|import\.meta\.env|VITE_|flag|disable"` finds no feature switch in T, `src/tenant/invoiceIssuingClient.ts`, `src/tenant/invoiceCreditNoteHold.ts`, RT or TE (read-only check, 2026-11-18).
- CN-P2 changes no server code (D17:805). The routes its controls call are CN-P1's, shipped, and served by every runtime built for 038 or later (RT:4-13).
- So **today the only means is D-CA-14 C** (redeploy the pre-CN-P2 shop build), which does not meet D-P2-13 A during a pause (table below).

**Each D-CA-14 option, control by control.**

| | A: server write setting | B: shop recovery-only build | C: pre-CN-P2 shop build | D: forward migration revoking EXECUTE |
|---|---|---|---|---|
| Issuing controls, pages loaded after the change | Visible; a press reaches the server and gets 503, nothing written: operationally disabled | Hidden | Absent | Visible; the call fails at the database and the route answers 503 (inference from the routes' outage path, RT:695-696 for the list; not run), nothing written |
| Issuing controls, tabs already open | as above | **Visible and operational** | **Visible and operational** | as above |
| Recovery controls | Operational | Operational (new loads); operational in open tabs | Absent in new loads; operational in open tabs | Operational (settlement, lookup and proof EXECUTE kept) |
| Read controls | Operational | Operational | Absent in new loads | Operational |
| Direct database callers with a live key (DA-132's class, D10:1674; DA-93) | **Not stopped** (HTTP-only). In a production pause a holder of the runtime's secrets can mint keys and call 038's writers directly for every tenant that is not suspended, for the whole pause (§9.3.2; D-CA-18). In the rehearsal the fences hold every principal until step 6's first LOGIN restore (§9.3.7) | Not stopped | Not stopped | Stopped for every caller through `tmpos_app`; not for the owning role, which keeps EXECUTE on every 038 routine because no revoke names it (M38:2734-2745), nor for superusers |
| Meets D-P2-13 A and D-CA-8 A during a pause | Over HTTP, yes throughout. For direct callers, no: while the read is failing a direct call is issuance without the read; it is detected by the evidence window (§9.3.4), not prevented (D-CA-18) | **No**, unless paired with A or D | **No**: open tabs keep every control and CN-P1's routes still answer them, a breach of D-P2-13 A for the pause | Yes, for callers through `tmpos_app` |
| What it needs | New server code in the N-built runtime, and in a **predecessor build** (runtime for 001..N-1) deployed before N is applied, for the 001..N-1 branch (§9.3.3) and the rehearsal (§9.3.7) | New shop code | Nothing new | A migration at the next free number revoking `tmpos_app` EXECUTE on `m7b_invoice_credit_note_register`, `m7b_invoice_credit_note_issue` and `m7b_invoice_credit_note_withdraw` (D16:384 names this lever), and a runtime whose approved grant list drops those three lines (PRE:138-139; PRE:142); restoring issuance later needs a further migration granting them back and a runtime whose list has them again. Forward-only: the ledger runs 001..N, N+1 |

**How the write setting stops new writes** (D-CA-14 A; new code, PROPOSED; placement §6.6). While it is `off`, the chain refuses `POST …/credit-note-registrations` (RT:7), `POST …/invoices/{id}/credit-notes` (RT:9) and `POST …/credit-notes/{creditNoteId}/withdrawal` (RT:12) with 503 `service_unavailable` (log reason `credit_note_writes_disabled`) after authorization and before the body read and idempotency acquisition. So a refused request reserves no idempotency key, takes no lease, opens no command transaction and calls no routine. Its limits, stated plainly:
- **HTTP only.** The setting is read by the tenant runtime's chain and changes no database grant. A holder of the runtime login and the tenant session issuer key (DA-93, D08:383; `TENANT_SESSION_ISSUER_KEY`, TE:9-10, :203) can mint a `store_owner` key for any tenant that is not suspended and call 038's register, issue or withdraw directly (M38:76-77); the setting never sees that call.
- **Tenant entry only.** It is a tenant-entry variable. The admin entry serves no credit-note route (`server/entry/productionEntry.ts:32`; `:76`), so it carries no setting and needs only the matching build and `startup_ready`.
- The rate limiter has already counted the request (APP:866-871), as for every request; that row is the limiter's, not credit-note data.
- **A retry of a completed key is refused too.** Replays are served at acquisition (APP:1104) while the sealed record is retained (24 h, IDEM:107), which the setting precedes, so an older tab's Check again of an issue that completed gets 503 instead of its recorded 201. Nothing is lost: the note exists, and CN-P2's 503 path [CANDIDATE, untested: P2-37's component test is written and has never run, D17:867; D17:928] leads the owner to "Look up attempt", whose issued row offers "Confirm credit note" (D-P2-16 A, D17:800) whenever the tenant is active (in a production pause, throughout except apply windows, §9.3.2).

The setting covers every HTTP client, including older browser tabs that still show issuing controls: their presses reach the server and get the 503. **Withdrawal is included** (adopted with D-CA-14 A, over leaving RT:12 live as a residual): it writes preserved data, the shop has no withdrawal control (D10:1693), so the cost is nil.

**What can already be in flight, and how it ends.** An admitted register, issue or withdrawal is one HTTP request: the chain, an idempotency acquisition with a 60 s lease (IDEM:107; APP:1102), then one database transaction that calls the definer routine (M38:2754; M38:2756). Every command transaction carries transaction-local lock, statement and idle-in-transaction timeouts fixed in source and derived from the 2,000 ms `COMMAND_TRANSACTION_DEADLINE_MS` (CT:136): 1,400, 1,800 and 4,000 ms (`server/persistence/postgresTransactionalStore.ts:396-400`, applied with `set_config(…, true)` at SPC:174-176 and SPC:513; no environment variable sets them). The runtime abandons a commit at that deadline (CT:701-709), and an abort before COMMIT is handed over rolls the transaction back (SPC:64-66). A lease held by a stopped process expires on its own (IDEM:107), and with the setting `off` no retry of that key is admitted.

**What bounds a row's time, and what does not** [PROPOSED; usable only once the operator has confirmed the values listed below]:
- **An old instance ends at its verified exit.** An old instance, one started with the setting `on`, withdraws its readiness and closes its listener at its stop signal (`server/runtime/lifecycle.ts:87-88; :47`), but requests on connections already open can still be admitted until its process exits. It forces its exit `SHUTDOWN_FORCE_TIMEOUT_MS`, 10,000 ms, after the signal (`server/entry/entryStartup.ts:35`; TE:253; `server/runtime/lifecycle.ts:56; :91`), through a plain timer that can fire late (`server/runtime/lifecycle.ts:60`), and the platform's kill grace bounds a process whose timer cannot fire. Those figures are why the exit must be **observed**, not computed. (A local run on 2026-11-20 observed this timer in each compiled build: with one open connection still draining, each process logged `shutdown_forced` and exited 1, 10 025 ms (N) and 10 016 ms (predecessor) after `SIGTERM`; §13. That is local evidence of the timer, not an operator's verified exit time.) Nothing is admitted by a process after it exits, every row time is read inside the writing transaction (§9.3.4), and a transaction not yet at COMMIT when its process ends is rolled back (SPC:61-66). So the bound for class 1 is the admitting instance's verified exit time Sk (§9.3.2) plus the recorded skew; where an exit is not verified, no row of that instance is class 1 by time.
- **The commit lag** (the pre-baseline period, §9.3.4). A runtime transaction's 2,000 ms deadline before COMMIT is handed over is enforced by a plain timer that can fire late (`server/runtime/deadline.ts:27-29`), and the COMMIT wait itself has no client bound (SPC:394-396); under synchronous replication it may have none at all. So the commit lag is 2,000 ms plus the confirmed event-loop delay plus a confirmed and enforced bound on the COMMIT wait. Where no such bound is confirmed and enforced, there is no commit lag, and the pre-baseline review starts at N's apply (§9.3.4). It bounds runtime transactions only; a direct caller's transaction has no duration fixed in source.
- **What does not bound a committed row's time.** Counted from admission, the body read (up to the 30,000 ms request and socket timeouts, APP:209-214) and the idempotency acquisition (up to 1,000 ms, `server/runtime/idempotency.ts:110`) come before the transaction starts, so admission plus 2,000 ms bounds nothing, and neither does a new instance's Tk or an old instance's stop signal.

**Values the operator must confirm before using either bound (unverified in this design)** [OPEN: pending; adoption does not confirm them]. Each is recorded with the pause; until all are, no row is class 1 by time and there is no commit lag:
- how each old instance's exit is verified (the platform's record that the process ended), the platform's grace between the stop signal and a forced kill, and any rolling-restart overlap or out-of-traffic interval;
- the event-loop delay the runtime can incur, which makes its timers fire late (`server/runtime/deadline.ts:27-29`; `server/runtime/lifecycle.ts:60; :91`);
- whether the managed database uses synchronous replication (`synchronous_commit`, `synchronous_standby_names`), and whether any enforced bound limits a COMMIT's wait;
- the measured maximum absolute clock skew between the database and the platform clock that records each exit (Sk), and between the database and each instance, each with its measurement uncertainty and the period for which the measurement is valid;
- which clock L, each Sk, each Tk, C and R are recorded on;
- that the deployed build's constants equal the source cited here (2,000; 1,400, 1,800 and 4,000; 10,000; 1,000 ms).

**The drain count** (D16:378's step, made exact; used in every D-CA-7 A apply window and in the rehearsal). In `pg_stat_activity`, rows with `backend_type = 'client backend'` and `datname = current_database()`, superusers and table owners included, idle-in-transaction included: the only rows allowed are the dedicated applier's own session and the expected exclusions listed in the principal inventory (for example a managed provider's maintenance sessions, each named). And zero such rows whose `query` names `m7b_invoice_credit_note_register`, `m7b_invoice_credit_note_issue` or `m7b_invoice_credit_note_withdraw`.

**Principal inventory (§12 item 11).** A read-only catalog query lists principal by principal: every login role; its role memberships, transitively; whether it can `SET ROLE` to each; its privileges on 038's tables, sequences and routines (directly or through roles, the owner's included); superuser, `CREATEROLE` and `ADMIN OPTION` on `tmpos_app`, `tmpos_audit_writer` or the owning role. For each principal it names the stop command and the operator responsible, and records that the operator's authority to run it (NOLOGIN, `pg_terminate_backend`) was verified on that database. **Where it is required:** in the rehearsal, on the disposable database before step 1; in production, before every apply window run in D-CA-7 A's shape (under D-CA-7 A, or for a repair the D-CA-7 row says needs A whatever is chosen), whose step 2(c) sets every `tmpos_app` member login NOLOGIN (D16:377), kept with that window's evidence; and under D-CA-18 A or B, before any production rollback. Under D-CA-7 B (not chosen) with D-CA-18 C, and no repair that needs A, no production step would fence principals; under D-CA-7 A, adopted, it is required before every production apply window.

**What a suspended tenant's session can reach (trace of current source).** This matters in every step that suspends tenants: a D-CA-7 A apply window, and the rehearsal.
- The tenant boundary asks admission on **every** protected request, with no grace period (SES:114-118); a denial revokes the principal's sessions and answers 401 (SES:30-34). A suspended tenant's grants drop out of admission (D16:375), and the database key's admission digest no longer matches (037:560-565).
- If the principal still holds another admitted grant, a session that was live when the suspension took effect ends on its next request: the admission witness changes, 401 `session_version_mismatch` (`server/runtime/sessions.ts:640-642`). A session admitted after the suspension no longer holds the suspended grant (it drops out of admission, D16:375), so a request naming that tenant or store is refused at authorization, 403 `authz_denied` (APP:955-956).
- Both refusals come **before** the write setting, which sits after authorization (§6.6), and before any handler. So while a tenant is suspended **no session of it reaches the activity read or the three write routes**: "the read answers 200" and "the writes answer 503" cannot be observed from it. The store directory does not list its stores either (SD:15).
- **One exception in the source:** an unknown route answers 404 to any request on a served host, after the host and rate-limit checks and before any session step (APP:858; APP:878; APP:423-427). But a request to an unserved host also answers 404 (APP:861-863), as does a wrong method. So a sessionless 404 counts as "the activity route is absent" only when paired with a **control request** on the same host to a served route without a session (for example `GET /api/v1/stores`), which must answer 401 (APP:940-945).
- **Trialing tenants are not suspended by the audited route**: it switches only active ↔ suspended (TST:12-18; D16:375). Their sessions keep reaching the runtime whenever a runtime runs.

**Evidence surfaces while tenants are suspended** (the only ones counted then):
1. The ledger: exactly the ledger the step expects (001..N, 001..N+k after a repair, or 001..N-1 in the rehearsal), read by the applier.
2. The runtime's startup result: `startup_ready` (TE:489) only after the preflight passed on the exact grants (step 4, PRE:395-409) and the exact ledger and checksums (PRE:97; PRE:432; PRE:444); otherwise `startup_refused` and a request to exit 1 (TE:282-283). For a build and ledger that do not match, with the standard grants, the expected refusal is step 4's: a `startup_refused` line with `database_login_unsafe` and `role_privilege_unexpected` (predecessor build on 001..N) or `role_privilege_missing` (N-built runtime on 001..N-1), not the ledger codes. It comes from the runtime-login check, before the ledger is validated. Both were observed on 2026-11-20 for the compiled tenant entries, in-process (§13; `scratch/browser/ca35-mismatch-n-on-038-20261120.*` and `scratch/browser/ca35-mismatch-p-on-039-20261120.*`): each entry asked to exit 1, logged no `startup_ready`, opened no listener and left the ledger unchanged. The same day both were also run locally as production processes (each compiled `tenantMain.js`, over a synthetic TLS-only database host): each logged the same refusal and no `startup_ready`, and exited 1, with its fixture's ledger and grant records unchanged (§13; `scratch/pause/ca35-dbstage-r2-20261120/`). Not yet observed: the admin entry. Grants aligned by hand are a separate case (§9.3.3; source-traced, not run).
3. The route set: each build serves exactly its `TENANT_SHIPPING_ROUTES` and refuses to start if the composed table differs (TE:25; TE:131-132; TE:217-219). The N-built inventory contains `GET /api/v1/stores/{storeId}/credit-notes`; the predecessor build's does not. Absence is also observable as a sessionless 404 paired with the 401 control request (above).
4. The write setting's value per instance, from each instance's startup log line (§6.6).
5. The database fences: `rolcanlogin` of every inventoried login, their memberships, the 038 ACLs, and the drain count.

A read 200 or a write 503 is counted **only** from a session authorized to reach that route: a store-scope `store_owner` of an **active** tenant.

**Verification on an authorized session** [ADOPTED, D-CA-16 A]. One tenant that was `active` (not `trialing`: TST:12-18) is named at deployment as the **verification tenant**, with its store-scope `store_owner`. Its owner, in a fresh session, checks:
- the activity read: 200 with a well-formed page (N-built or repaired runtime) or 404 (predecessor build); proves the route and its authority path on an authorized session, for that store only;
- register, issue and withdrawal: 503, with no idempotency row (the applier checks the row); proves the setting on an authorized path; it does not prove that a direct database call is refused;
- the attempts lookup: 200; proves owner recovery works.

*In a production pause* tenants are active (§9.3.2), so these checks run in a fresh session of the verification tenant's owner, with no reactivation. *After an apply window that suspended tenants* (D-CA-7 A), and *in the rehearsal*, the verification tenant (there called the **canary**) is reactivated alone first through the audited `PATCH /admin/v1/tenants/status` (TST:4). That needs the **admin entry** running, which uses the runtime login (D16:376), and an administrator holding `change_tenant_status` with a recent step-up (TST:29-33). The owner's sign-in works under the fences because the runtime login, the only LOGIN, is itself a member of exactly `tmpos_app` and `tmpos_audit_writer` (PRE:27) and writes the session's audit row in the same transaction (SES:65-69). The checks prove nothing for any other tenant. A dedicated synthetic verification tenant would avoid touching a real tenant, but the source has no provisioning path for one that this document can cite; it is option B of D-CA-16.

#### 9.3.2 Production forward-repair runbook [PROPOSED; ADOPTED, D-CA-18 C with D-CA-14 A]

Written for D-CA-14 A: the runbook needs a pause that reaches open tabs, so it needs A. D is not a pause on its own (it needs a migration and an apply window, and this runbook's steps, Sk, Tk and evidence rows assume the setting); it can be added as the first repair (response (c)). Under D-CA-14 C a pause breaches D-P2-13 A (§9.3.1 table). N stays applied throughout; N's down is not run.

**Triggers** (any one starts the runbook):
- **The read fails** for an authorized owner: the shop shows its Error or Not available state (§4.3) and an owner reports it, or the runtime logs 503 for the route with `store_credit_activity_answer_invalid` or an outage reason (§5.3).
- **The read answers wrongly**: rows missing, extra, of another store, or out of order, found by an owner, by comparing with each invoice's own credit-note list (RT:678-716), or by review.
- **A defect in N** found any other way (review of N's text, a failing test on a later commit).
- **Not a trigger:** a decision to roll back 038 itself. It takes precedence over this runbook, which resumes only after D16's forward recovery is applied (§9.3, scope against 038's own recovery).
- Detection is by people. No alerting exists and no automated read-health control switches writes off (G-OBSERVE stays OPEN, §10), so the time between a failure and its detection is not bounded by this design.

**Times recorded.** L, the last known good time: the most recent authorized-session read 200 whose content was checked, or, for a defect in N's own text, the time N was applied. D, the detection time. T0, the baseline time (step 2). **Sk**, each old tenant-runtime instance's **verified exit time**: the time the platform records that the process of an instance started with the setting `on` ended, after its stop signal (taking it out of traffic is not enough: the stop signal follows and the exit is confirmed). **Tk**, each new instance's startup time, from its startup line showing `off` (§6.6). **Toff**, the last Sk: from then no process with the setting `on` exists (§9.3.1). **C**, the closing scan's time (§9.3.4), immediately before R. R, the time the first instance is switched `on` again. Row times are the database clock; Sk is the platform's clock and Tk an instance clock. So either the startup line also records the database clock, read through the instance's startup preflight (the endpoint and login the preflight validated, not a pinned connection; new code with the setting, §6.6, amended 2026-11-19) and each Sk is taken on a recorded clock, or every comparison of Sk or Tk with a row time adds a clock-skew margin measured and recorded at the pause (§9.3.1, values to confirm). No instance id, no startup line with the setting and no startup database-clock read existed in the source at adoption; all three were proposed with the setting (§6.6) and are now authored and unrun.

**Steps** (each with its evidence):
1. **Record the trigger, and confirm the verification tenant.** The owner or operator records the trigger, D and L, and confirms the named verification tenant (D-CA-16) is `active` and has a usable store-scope `store_owner`. If it does not, the owner names another active tenant and its store-scope `store_owner`, and that choice is recorded. Issuance is paused from here even if the trigger later proves false; a false trigger is closed by steps 7 to 9, not by skipping them.
2. **Baseline, then pause at once.** The dedicated applier records the §9.3.4 baseline and T0 before the first instance is switched; if it cannot start at once, step 3 goes first and the baseline follows immediately (the baseline rule, §9.3.4). Evidence: the kept baseline record with T0.
3. **Pause issuance.** Restart every tenant-runtime instance with `TMPOS_CREDIT_NOTE_WRITES=off` (a rolling restart), or start a replacement so configured, take the old one out of traffic, send it the stop signal and confirm its exit. Evidence: the platform's instance list; each new instance's startup line showing `off` with its instance id and time (Tk, §6.6); each old instance's verified exit time (Sk) from the platform; no instance started before the change still in traffic. No tenant is suspended and the database is not touched.
4. **Verify the pause on an authorized session** (§9.3.1, D-CA-16): the verification tenant's store-scope `store_owner`, in a fresh session, sees register, issue and withdrawal answer 503 with no idempotency row, and the lookup answer 200; the answer the activity read gives (the failure being repaired) is recorded.
5. **Respond to the reduced protection** (below). The owner records which responses apply.
6. **Forward repair.** A new migration at the next free number (§1 rule 4; N itself is never edited), with a runtime built for the new ledger that carries the write setting; or, when the cause is outside N (a server or shop defect), a new build only. Either is separately approved by the owner and has its own exact-commit CI under §12 item 3, with the repair's own acceptance rows (isolation and pagination for a change to the read: CA-01 to CA-03, CA-07, CA-09, CA-38) in that CI evidence. **CI is paused by the owner (since 2026-11-18): until it is available again, no repair can meet §12 item 3.** Any emergency deviation from that is a separate owner decision outside this design; the pause holds meanwhile. A migration is applied in an **apply window** by D-CA-7's procedure (below), by the dedicated applier; the new tenant runtime starts with the setting `off`. Evidence: the approval, the CI record, the ledger 001..N+k with each pinned checksum, `startup_ready` on every tenant-entry and admin-entry instance, and the setting `off` on every tenant-entry instance.
7. **Verify the repair.** On an authorized session, the verification tenant's owner, in a fresh session, sees the activity read answer 200 with a well-formed page, register, issue and withdrawal answer 503 with no idempotency row, and the lookup answer 200. Where the trigger was wrong rows, one page is not proof: the dedicated applier also reconciles, read-only, the verification store's full set as the read serves it (every page, to `nextCursor: null`) against 038's tables for that store (every credit note of the tenant and store, with its withdrawal), and records the result. After a D-CA-7 A window the verification tenant is reactivated alone first and the other suspensions are lifted only after these checks (D-CA-17).
8. **Classify the evidence window** (§9.3.4): every row created or changed after the baseline found and classified; the pre-baseline period listed and reviewed.
9. **Restore issuance.** Only when the production evidence list (§9.3.5) is complete and the owner records the decision. If response (c) was used, a further migration granting EXECUTE back has first been applied in an apply window, the ACLs verified against the preflight's approved list (PRE:138-139; PRE:142), and steps 7 and 8 repeated after it. If response (d) was used, each affected tenant's status has first been restored exactly to the value recorded before the change, verified, and its owner's lookup checked, in a fresh session, to answer 200. Immediately before the first switch, the dedicated applier takes the closing scan C (§9.3.4), and its rows are classified and the release predicate (§9.3.4) holds on it, with either the database write fence in place or check (ii) recorded at C together with the owner's recorded acceptance of the no-fence residual (§9.3.4). Both are OPEN after the 2026-11-18 adoption, so this step is conditional on that decision. Then switch writes `on` per instance (R), and record each instance's switching evidence afterwards. After R, the confirmatory scan (§9.3.4) runs; an unexpected row in it re-pauses issuance (back to step 3) and is an incident.

**Apply windows.** Their shape is D-CA-7's, for N's first apply and for every repair alike:
- *Under D-CA-7 A* (the 038 cutover-style steps, D16:372-380), with the principal inventory taken first (§9.3.1): suspend every affected `active` tenant (D16:375); stop both runtimes (D16:376); set every inventoried `tmpos_app` member login NOLOGIN and terminate its sessions (D16:377); run the drain count (§9.3.1); apply; start the tenant entry (setting `off`) and the admin entry on the new build, with LOGIN restored exactly (D16:380); reactivate the verification tenant alone, check (step 7), then lift the remaining suspensions.
- *Under D-CA-7 B*: stop both runtimes; apply under the runner's lock timeout; verify the ledger and the approved grants; start the tenant entry (setting `off`) and the admin entry on the new build. No suspension, no NOLOGIN, no drain count. For a **repair**, B is used only when a repair-specific analysis of its locks and of what can run concurrently with it is recorded and shows B safe; otherwise A (D-CA-7).
- Either way the preflight forces the restart: a runtime built for the old ledger refuses the new one. For N's first apply, the predecessor build refuses 001..N at the runtime-login check (step 4), before the ledger check: `startup_refused` with `database_login_unsafe` / `role_privilege_unexpected` (§9.3.1, evidence item 2; observed in-process for the compiled tenant entry, §13; the production process exit is pending). For a repair at 001..N+k, step 4 refuses if the repair changes the approved grants; otherwise the exact ledger check does (PRE:97; PRE:432; PRE:444). That repair case is source-traced and not run.

**Tenant access.** With N still applied, the setting alone pauses issuance, so tenants are **not** suspended for the pause: they stay active, and owners keep using the shop, with issuing refused (503) and every other read and the recovery routes serving. The activity read itself answers as the failure leaves it until the repair, then as verified in step 7. Tenants are unreachable only during an apply window: under D-CA-7 A from their suspension until it is lifted after the verification checks; under D-CA-7 B from the stop of the runtimes to their start. Trialing tenants are never suspended (TST:12-18).

**Owner attempt recovery** resumes at once and continues throughout the pause, except during apply windows (under D-CA-7 A, until the tenant's suspension is lifted). Its limits are §9.3.6's: the tenant active, a store-scope `store_owner` at limitation `none`, each owner's own attempts only. Settlement is the only write it makes (§9.3.4 class 2).

**The period of reduced protection, and the response.**
- *Before the pause is complete* (from the failure, at or after L, until Toff): issuance over HTTP was possible without a working read, so D-P2-13 A was not met in that interval for any owner who issued then. Nothing in this design undoes that; the evidence window lists those rows (§9.3.4).
- *During the pause* (from Toff, the last verified exit, until R): D-P2-13 A is met **over HTTP only**. The setting is HTTP-only (§9.3.1): a holder of the runtime login and the tenant session issuer key (DA-93) can mint a `store_owner` key for any tenant that is not suspended and call 038's register, issue, withdraw or settle directly (M38:76-77). While the read is failing, such a call is issuance without the read. **Forward repair does not remove this exposure.** It is the exposure DA-93 records for normal operation, coinciding here with a failing read; it is bounded by who holds those secrets.
- *Response.*
  - (a) Pause promptly (steps 2 and 3), and record D, T0, each Sk (verified exit), each Tk, Toff, C and R.
  - (b) Run the evidence window over the whole period and classify every row (§9.3.4); writes stay `off` until the release predicate holds (§9.3.4), and an unexplained row is handled as an incident.
  - (c) If the owner needs direct callers stopped as well, the **first** forward repair can be D-CA-14 D's revoking migration: direct calls through `tmpos_app` then fail at the database. It is forward-only and costs an apply window, and restoring issuance needs a further migration granting EXECUTE back (step 9). It does not stop the owning role, which keeps EXECUTE on every 038 routine, withdraw and settle included, because no revoke names it (M38:2734-2745), nor superusers.
  - (d) Optionally, owner-SQL `read_only` for chosen tenants (D-CA-17 B's lever; 038's writers require write statuses, M38:49-50) closes direct issuance for them at the database. Before the change, the prior status of every tenant or store record the change sets is recorded, and only those records are changed; each must be restored exactly and verified before those tenants reopen and before step 9. Its costs: unaudited status writes, a 403 on their activity read under D-CA-1 A, and their owner recovery waiting, because settlement too requires write statuses (M38:1682).
  - None of (a) to (d) shortens the time before detection.

#### 9.3.3 Production ledger already at 001..N-1 [PROPOSED]

**When it arises.** (i) N was never applied; (ii) N's apply failed and its transaction rolled back, so the ledger read shows 001..N-1; (iii) the ledger is found at 001..N-1 for any other reason, which under D-CA-18 C means N's down or a ledger change ran against this design: record it as an incident, and re-apply nothing until the owner has the cause. The ledger read, not the deployment record, decides that this branch applies.

**Which runtime.** Only a runtime built for 001..N-1 starts on that ledger; the N-built runtime refuses it at step 4 with `database_login_unsafe` / `role_privilege_missing` (N's grant is missing; PRE:405-409). That `startup_refused` line comes from the runtime-login check, before the ledger is validated (§9.3.1, evidence item 2). It was observed on 2026-11-20 for the compiled N-built tenant entry, in-process: the entry asked to exit 1, logged no `startup_ready`, opened no listener and left the ledger unchanged (§13). The production process exit is pending. `migration_missing` (PRE:444) answers instead only if the grants were aligned by hand; that separate case is source-traced (2026-11-19) and not run. The runtime that starts here is the predecessor build. The activity route is absent: the shop shows Not available (404, §4.3).

**If CN-P2's shop controls are deployed** (or may be loaded in any tab: the shop is its own build, `package.json:8-12`, so the runtime's ledger does not decide what a browser has loaded), the state is **outside D-P2-13 A's deployment order** (§12 item 7: never CN-P2 without the read). Record it as an incident. Run the predecessor build with the setting `off` on every tenant-entry instance, with step 3's per-instance evidence (§9.3.2): that **contains** issuance over HTTP; it does not bring the state back within D-P2-13 A, and the direct-call residual of §9.3.2 applies unchanged. Optionally the owner may also redeploy the pre-CN-P2 shop build (D-CA-14 C): new page loads then lose the issuing controls, but open tabs keep them, which is why it is never the pause on its own (§9.3.1 table). Tenants stay active and owner attempt recovery serves; every route it uses is CN-P1's and exists at 001..038 (RT:4-13). The evidence window (§9.3.4) uses the baseline rule; its pre-baseline period starts at the recorded deployment time of the CN-P2 shop artifact (§12 item 7). If that time cannot be established, issuance stays `off` and the whole period is handled as an incident until the owner records a decision.

**Conditions for reopening** (all of them, in order):
1. The **byte-identical** N file (its checksum is pinned, PRE:95-97) applied by D-CA-7's procedure (§9.3.2 apply windows). A changed routine is a later migration at the next free number, applied after N (§1 rule 4).
2. The N-built runtime (or the build for the repaired ledger) reports `startup_ready` on every tenant-entry and admin-entry instance (TE:459) on the ledger exactly 001..N (or 001..N+k), with the setting `off` on every tenant-entry instance.
3. The activity route is in the served inventory (TE:131-132; TE:217-219).
4. On an authorized session of the verification tenant, in a fresh session (§9.3.1): the read answers 200 with a well-formed page; register, issue and withdrawal answer 503 with no idempotency row; the lookup answers 200.
5. The evidence window is classified and the release predicate holds (§9.3.4).
6. The owner records the decision; the closing scan C is taken immediately before the first switch and the release predicate holds on it, with the fence or check (ii) and the owner's acceptance of the residual as in §9.3.2 step 9 (OPEN; §9.3.4); then writes go `on` per instance, with each instance's switching evidence recorded afterwards, and the confirmatory scan follows (§9.3.4).

**If CN-P2 was never deployed**, no shop issuing control exists, so nothing of CN-P2 is paused or reopened; CN-P2 stays undeployed until N is applied and verified (§12 item 7). CN-P1's routes still answer an authorized store owner's HTTP requests on the predecessor build (RT:4-13), exactly as shipped before this slice. That does not breach D-P2-13 A, which governs CN-P2's deployment (D17:595), and this slice changes nothing about it; the setting may stay `on` there.

**Why the predecessor build stays required under forward-only recovery.** It is no longer a production rollback target. It stays because (1) it is the only runtime that can start at 001..N-1 and carries the write setting, which this branch needs whenever a CN-P2 shop can be loaded; and (2) the rehearsal (§9.3.7) starts it after N's down. §12 item 7 keeps it for these two reasons.

#### 9.3.4 Evidence window and classification [PROPOSED]

**What is in scope** (038's credit-note data): credit notes (`invoice_credit_note`, M38:305-334), withdrawals (`invoice_credit_note_withdrawal`, M38:348-361), credit-note registrations (`invoice_credit_note_registration`, M38:261-288), per-store counters (`invoice_credit_note_counter`, M38:248-256), and credit-note audit rows: the `public.audit_event` rows whose action is `store.invoice_credit_note.register`, `…issue`, `…settle` or `…withdraw` (M38:964; M38:1401; M38:1655; M38:1830).

**What can change in them.** Credit notes and withdrawals are insert-only: their guards refuse every update and delete (M38:497-515; M38:553-571), enabled ALWAYS (M38:635; M38:643). A registration changes only in `credit_note_id` (open → issued, by the issue) and `acknowledged_at` (open → released or issued → confirmed, by the settlement); every other column is fixed and deletion is refused (the registration guard, M38:434-437; M38:461-491). A counter's `last_number` advances by one per issue (M38:259).

**The baseline, and the one rule for when it is taken.** In one read-only transaction at REPEATABLE READ (one snapshot for every table): the id of every row in scope; for registrations also `credit_note_id` and `acknowledged_at`; for counters `(tenant_id, store_id, last_number)`; a digest of every full row; and the database clock read in that transaction (T0 in production). **The rule, everywhere** (§9.3.2 step 2, §9.3.3, §9.3.7 step 2): it is taken immediately before the first instance is switched to `off`; if it cannot start at once, the switching goes first and the baseline follows immediately, and the time from the first switch to the baseline then belongs to the pre-baseline period below. In the rehearsal, step 4's full-row ids and digests remain the separate **preservation** comparison of step 5. Everything created or changed after the baseline's snapshot is then found exactly, by comparing ids and fields with the baseline, whatever its timestamps say.

**What the baseline cannot show, and how that period is covered.** It cannot tell which of its own rows were written between the failure and the baseline. That earlier period is covered by timestamps: every row in scope whose `issued_at`, `registered_at`, `withdrawn_at`, `acknowledged_at` or audit `occurred_at` is at or after L (in the §9.3.3 branch, the recorded CN-P2 shop deployment time takes L's place), less the commit lag of §9.3.1 and the recorded skew; where no commit lag is confirmed and enforced (§9.3.1), the period starts at N's apply instead, or at an earlier point the owner records. The commit lag bounds runtime transactions only: a direct caller's transaction has no duration bound, so for every row a direct caller could have written (any row not matched to a `committed` write log line) the period starts at N's apply, or at an earlier point the owner records, unless a database-wide bound on transaction duration or a database write fence exists and is recorded. The margin is needed because each time is read inside the writing transaction (`issued_at` is the issue routine's `clock_timestamp()`, M38:341; `occurred_at` defaults to `now()`, the transaction's start, `server/platform-identity/migrations/002_authorization_audit_foundation.up.sql:251`), so a row that committed after L can carry an earlier time. Counters carry no time; they are reconciled per store (the matching rule, below). These rows were written while writes were on and the read had failed, or may have: the applier lists them, and the owner reviews each against what the store's owners know (who issued it, and why), with the activity read once it serves. A row the owners cannot explain is treated as class 3 below. If L is unknown, the period starts at N's apply.

**The closing scan and the confirmatory scan** [PROPOSED]. The window has a closing point. Settlement stays callable over HTTP throughout the pause, and a holder of the runtime's secrets can call 038's writers directly at any time (DA-93), so a classification made at step 8 can be overtaken before R.
- **Closing scan C.** The dedicated applier takes it immediately before the first instance is switched `on` (§9.3.2 step 9; §9.3.3 condition 6), by the baseline's method (one REPEATABLE READ snapshot, ids, fields, digests, the database clock), compared with the kept baseline snapshot. Every row it finds created or changed after the baseline is classified by the rules below, and the release predicate (below) must hold on it.
- **Confirmatory scan.** After R, the applier compares a new snapshot with C's and classifies every row created or changed after C whose time is before R plus the recorded skew, in the same way; a row matched to a `committed` line from an instance whose startup line shows `on` and started at or after R is a post-restore write, not part of the window. It is taken once the commit lag (§9.3.1) has passed after R or, with no confirmed commit lag, at a time the owner records. An unexpected row found there (class 3, or a `committed` line matching no row) re-pauses issuance, back to §9.3.2 step 3, and is an incident.
- **No credit-note write in progress at C.** With no confirmed COMMIT bound, a transaction begun before R can commit after the confirmatory scan, so neither scan sees it. Release therefore needs one of two things. (i) The database write fence below. (ii) A verified absence, at C, of in-progress credit-note write transactions: a read-only check of `pg_stat_activity` in the drain count's form (§9.3.1), with zero client backends of this database in a transaction whose `query` names `m7b_invoice_credit_note_register`, `m7b_invoice_credit_note_issue`, `m7b_invoice_credit_note_settle` or `m7b_invoice_credit_note_withdraw`, recorded with C. The check sees only the statement a session is running or last ran, so a session in a transaction that could still call a routine is not excluded by it. That gap is stated, not closed. **Under the adopted design (ii) is the operational minimum for release, and it leaves the residual below: a closing scan with a verified absence of in-flight writes does not establish that the window is fully closed.** Whether release may proceed on (ii) without (i), accepting that residual, is an OPEN owner decision, and (i) is a separate dependency not approved by the adoption [OPEN]. Until the owner decides, every release path that relies on (ii) (§9.3.2 step 9; §9.3.3 condition 6; §9.3.5 row 8) is conditional on that decision.
- **Residual, stated plainly.** Between C and R a settlement or a direct call can still commit; the confirmatory scan finds it afterwards and does not prevent it. Without (i), and with (ii) subject to its gap, a transaction already open at C that commits after the confirmatory scan is found by neither scan. This design does not call that normal operation: it is a residual the owner accepts, or closes with (i). Neither is decided [OPEN].
- **Complete-window-closure dependency** (separate from the matching rule, which has none, below): a database-enforced cutoff, for example a write fence the 038 writers check inside their own transaction (a commit-order marker or a write epoch the routines must match), raised at C and lowered at R. That is a mutation-contract and operational change, a dependency for separate owner approval [OPEN: not approved by the 2026-11-18 adoption]; this document describes it and does not design it.

**Attributing a row to an HTTP request: what the source gives today** (trace of current source, read-only, 2026-11-18). The four writes are command routes (RT:172; RT:229; RT:275; RT:329) on one path:
- *Request id.* The chain takes the client's `X-Request-Id` when it matches `^[A-Za-z0-9._-]{8,128}$`, otherwise a server UUID (`server/runtime/correlation.ts:12-21`; APP:776-779). A client can choose it and repeat it, so it is a join field to the request log only, never a matching key.
- *Idempotency.* Acquisition (APP:1102). A replay is answered there from the sealed record: nothing is planned or committed (APP:1104), and the request log's reason is `idempotency_replayed` (APP:491-495). The record holds keyed digests (HMAC, `server/runtime/idempotency.ts:414-415; :437`), a lease, expiry times and a sealed response, with no principal, request or instance (`server/platform-identity/migrations/006_m6_transactional_store.up.sql:88-110`).
- *Planning.* A create's aggregate id is a server UUID (APP:1109). The correlation id is a fresh server UUID v4 per prepared command (CT:580), carried as the audit correlation id (CT:682-685). Neither leaves the server today: no response or log line carries the correlation id.
- *One database transaction.* The idempotency fence, the mutation and the completion commit together, so within the sealed record's retention (24 h, IDEM:107) a retry of a committed write is a replay, never a re-run (`server/persistence/postgresTransactionalStore.ts:836; :863; :965`: the four mutators are routine-audited, PGCN:195-210, so the completion follows the mutation directly). The mutator calls the 038 routine with the correlation id (PGCN:65-71) and the aggregate id: register as `p_registration_id` (PGCN:113-114); issue as `p_credit_note_id`, with the body's registration id (PGCN:134-136); settlement with the attempt id as the aggregate (PGCN:152-156); withdrawal with the path's credit-note id (PGCN:186-187).
- *Durable rows.* The routine writes its domain change and exactly one `public.audit_event` row whose `request_id` is that correlation id: register, subject registration (M38:959-968); issue, subjects credit note and registration (M38:1396-1405); settlement, subject registration (M38:1650-1659), while a repeat of a completed settlement answers `unchanged` and writes nothing (M38:1617-1621; PGCN:160-164); withdrawal, subject credit note (M38:1825-1834). The routine returns the audit event id; the mutator checks it and passes on only the outcome (PGCN:91-94; PGCN:115-117), so after the commit the runtime holds the correlation id and the aggregate id, not the event id.
- *What a match can prove.* `audit_event.request_id` is `text not null` with a non-unique index (`server/platform-identity/migrations/002_authorization_audit_foundation.up.sql:249; :304`; "request_id has no uniqueness rule", `server/platform-identity/migrations/036_m7b_invoice_payment.up.sql:42`), and each routine accepts any UUID v4 its caller passes (M38:858; M38:1189; M38:1573; M38:1738). A direct call skips idempotency (M38:76-77) and writes the same rows (DA-93). So a matching correlation id alone proves nothing; what a direct caller cannot produce is a line written by a tenant-runtime instance. Today none records the correlation id: the request log carries the request id, method, route, status, duration, a refusal `reason` (APP:793) and, for session operations only, `operationId` (APP:786-797).

**The write log line** [ADOPTED as design 2026-11-18 with D-CA-18 C, with the platform-authenticated source metadata below; new code with D-CA-14 A, §6.6; implementation and verification **PENDING**]. The tenant runtime writes one line per register, issue, settlement or withdrawal command whose `commitCommand` call (APP:1147) returns a committed result or a result the chain answers 503 other than a lost lease (amended 2026-11-19, below), after that return and before the response is sent, and for no other result:
- `event` `credit_note_write`, and `outcome`: `committed` when the call returned null, which means exactly that the store answered `committed` (CT:716), which it gives these routine-audited kinds only after the mutator answered `applied` and the completion held (`server/persistence/postgresTransactionalStore.ts:964-965`), and which `client.transaction` returns only once COMMIT is acknowledged (`server/persistence/postgresTransactionalStore.ts:497`; SPC:61-64); `unconfirmed` when it returned a refusal the chain answers 503 (APP:1228: an outage, overrun or broken answer, after which the transaction may have committed, for example a COMMIT never acknowledged, `server/persistence/postgresTransactionalStore.ts:500`). No line for any other answer: a sealed refusal, a settlement's `unchanged` or a 4xx wrote no credit-note row and no audit row (for example M38:907-925; M38:1617-1621).
- **A lost lease writes no line** [AMENDED 2026-11-19 on the owner's instruction]. `transaction_lease_lost` is a 503 the chain answers, but it proves that this invocation applied no write. The store answers it on two paths only:
  - before opening any transaction, when the command's scope or lease cannot be one it granted (`server/persistence/postgresTransactionalStore.ts:635`);
  - from the fence, the body's first statement (after the kernel's BEGIN and transaction settings) and before any business state, when the record is not held under this lease (`server/persistence/postgresTransactionalStore.ts:836`). That answer is thrown as a rollback and reaches the caller only after ROLLBACK is acknowledged (`server/persistence/postgresTransactionalStore.ts:494-499`; SPC:61-64).

  On neither path is COMMIT handed to the driver, and a ROLLBACK that is not acknowledged answers `unavailable`, never `lease_lost`. No other component maps any answer to it (CT:717 maps the store's `lease_lost` alone).

  The runtime therefore skips only the `credit_note_write` line. The 503 `service_unavailable` and the request log line with its refusal reason `transaction_lease_lost` are unchanged (worktree `server/runtime/app.ts:1288-1295`; APP:1228 at the cited revision).

  A lost lease on a retry says nothing about an earlier invocation under the same key. That invocation's own line, or the lack of one, stands, and an earlier `unconfirmed` stays unconfirmed.

  `transaction_unavailable` keeps its `unconfirmed` line. CT maps both the store's own nothing-committed answer and a COMMIT never acknowledged (`server/persistence/postgresTransactionalStore.ts:500`, an outage) to that one word, so the chain cannot tell them apart.
- Fields: `instanceId` (the startup line's, §6.6: a random id the server generates at each process start, never a hostname, an environment value or a secret); `requestId` (a join to the request log, not a key); `kind` (`register`, `issue`, `settle` or `withdraw`); `correlationId`; `storeId`; `invoiceId`; and the subject: `registrationId` (register: the aggregate id; issue: the body's), `creditNoteId` (issue: the aggregate id; withdraw: the path's), `attemptId` (settle: the aggregate id). The line's time is the instance clock.
- Non-secret only: every field is an id the server generated for this command or the shop already holds. Never logged: the idempotency key, scope, fingerprint or lease, the session key, the registration proof, the body's amount or reason.
- **Replays.** A replay served at acquisition writes no line; its request log line (`idempotency_replayed`) never counts as a commit. Within the record's retention (24 h, IDEM:107), a retry re-runs the routine only when the earlier attempt committed nothing, because the completion commits with the mutation (`server/persistence/postgresTransactionalStore.ts:863; :965`). The retry gets a new correlation id and, for a create, a new aggregate id. After the record expires and is purged, a retry is a new attempt: it re-runs the command with a new correlation id and writes its own line. Either way the routine refuses a second registration or issue for the same attempt (`already_issued`, `conflict`, or `invalid_state` for a released registration of that attempt, M38:907-925; M38:1284-1299), so no second row is written.
- It is written only after the commit, so a process that stops between the commit and the line leaves a committed row with no line (below).

**The matching rule.** A row is matched to a line only when every condition holds:
- **Register:** exactly one audit row with `action_id` `store.invoice_credit_note.register`, `request_id` = `correlationId`, `store_id` = `storeId` and subject registration = `registrationId`; and the registration with that id is of `invoiceId`.
- **Issue:** exactly one audit row `store.invoice_credit_note.issue` with `request_id` = `correlationId`, `store_id` = `storeId`, subject credit note = `creditNoteId` and subject registration = `registrationId`; the credit note with that id is of `invoiceId` and `storeId`; that registration moved open → issued to it.
- **Settlement:** exactly one audit row `store.invoice_credit_note.settle` with `request_id` = `correlationId` and `store_id` = `storeId`, whose subject registration is of `invoiceId` and `storeId`, with `attempt_id` = `attemptId` and `registered_by` = the audit row's actor (the attempt id is unique only with invoice, tenant, store and `registered_by`, M38:277-278); and that registration's `acknowledged_at` change.
- **Withdrawal:** exactly one audit row `store.invoice_credit_note.withdraw` with `request_id` = `correlationId`, `store_id` = `storeId` and subject credit note = `creditNoteId`; that credit note is of `invoiceId` and `storeId`; and its withdrawal.
- **Counters, per store:** the final `last_number` minus the baseline `last_number` equals the number of credit notes created for that store after the baseline, and their numbers are exactly the consecutive range above the baseline value. Any other delta is a class 3 row.
- **Every kind:** the line's `outcome` is `committed`; it is the only line carrying that `correlationId`; its `instanceId` is in the platform instance list for the period, with a startup line. Each subject is a primary or unique key (registration M38:276; the attempt only with invoice, tenant, store and `registered_by`, M38:277-278; credit note M38:319; withdrawal M38:356), so a line can match at most one row set; a second audit row carrying the same `correlationId`, under any subject, makes the match ambiguous (below).
- **The log's integrity is an operational precondition** this design cannot cite in source: a line is evidence only if the log sink binds each line to platform-authenticated source metadata (the emitting workload and instance), not only to the payload's `instanceId`, and a holder of the database secrets cannot write to it. If that cannot be shown for the period, no line counts. [OPEN: an operational precondition, pending; the adoption adopts the requirement and does not establish it for any sink or period.]
- **What a match proves, and what it does not.** Platform-authenticated source metadata proves only which listed workload emitted the line. That the write passed through that workload's HTTP chain follows only if the workload ran approved code, and code identity is not attested: the source has no attestation of the running build, so this design claims only emission by a listed workload. A match proves neither that the principal was legitimate (a holder of the runtime login and the tenant session issuer key can mint a session and send it through a live `on` instance, which writes a genuine `committed` line, class 1 before that instance's Sk; DA-93; the audit row proves neither the actor nor the correlation id, `server/platform-identity/migrations/036_m7b_invoice_payment.up.sql:41-42`) nor that the workload ran approved code. The trust base therefore includes whoever can deploy or control a tenant-runtime instance and whoever can read the log.

**Missing, unconfirmed and ambiguous: each makes the row class 3.**
- **No line:** the process stopped between commit and line, the line was lost or not retained, or the row was written directly.
- **Only an `unconfirmed` line:** the runtime abandoned the commit at its deadline (CT:701-709) or got no exact answer (APP:1228). The row is listed with that line for the owner, and stays class 3.
- **Ambiguous:** two or more lines, or two or more audit rows, for one `correlationId`; or any field that disagrees. Making a genuine row ambiguous needs both: obtaining its `correlationId` (by reading the log, or by reading `audit_event`), and authority to insert a conflicting audit row (through `tmpos_audit_writer`, M38:78; DA-114, or through the routines by a direct call, DA-93). Whoever has both can do it; it keeps issuance `off`, so it fails safe.
- **Wrong instance:** a `committed` register, issue or withdrawal line from an instance whose startup line shows the setting `off` (the chain refuses those before acquisition, §9.3.1); a line from an instance not in the platform list; an instance with no startup line, or an old instance with no verified exit (Sk).
- **A line that matches no row:** a `committed` line with no matching row is no row's class. It is an **orphan line**, listed with the window: a lost row or a line that is not the runtime's. The release predicate (below) needs its incident disposition.
- Until the line exists, no row can be matched, and every row created or changed after the baseline is class 3. **A class 3 row stays class 3 after an owner explains it**: the explanation allows a recorded disposition (below), never a change of class.

**Matching-rule dependency: none.** (The complete closure of the window is a separate dependency: the database write fence, above.) The matching rule uses only what 038 and the command path already write: the routine's correlation-id argument, which is the audit `request_id` for all four writes, and the subject columns. `request_id` need not be unique, because every match also needs the subject key. The only new code is the line and the instance id in the runtime, both under D-CA-14 A (§6.6). Removing the log-integrity precondition would need the database itself to tell a runtime call from a direct call. That would be a change to the mutation contract; this rule does not need it, and this document does not design it.

**Classification of every row created or changed after the baseline.**
1. **Completion of an HTTP request admitted before its instance switched.** Class 1 only when the row is matched by the matching rule (above) to a `committed` register, issue or withdrawal line whose instance's startup line shows the setting `on` (an instance started with `off` admits none of those writes, §9.3.1), and the row's time is before that instance's Sk (its verified exit, §9.3.2) plus the recorded skew, with §9.3.1's values confirmed; where that exit is not verified, the row is not class 1 by time. The 60 s idempotency lease (IDEM:107) does not lengthen this: with the setting `off` no retry reaches acquisition (APP:1102; §9.3.1); it would matter only if an instance started before the change kept serving, which step 3's per-instance evidence excludes. Class 1 issuances are still listed for the owner's review: they were issued while the read was failing.
2. **Authorized attempt recovery (settlement).** A settlement through `POST …/credit-note-settlement` (RT:11) changes exactly one existing registration, the caller's own (M38:1601-1605): `acknowledged_at` from null to the settlement time, `credit_note_id` unchanged (M38:1632-1636; M38:481-487); and it adds exactly one audit row, action `store.invoice_credit_note.settle`, permission `recover_invoice_credit_notes`, whose actor is that registration's `registered_by` and whose subject is that registration (M38:1650-1659). It never creates a credit note, registration or withdrawal and never advances a counter. A direct settle writes identical rows (M38:76-77; M38:1650-1659), so a change is class 2 only when the registration change and its audit row match one to one in that way, **and** the row is matched by the matching rule (above) to a `committed` settle line from an instance in the platform list (settlement is not gated by the setting, so the instance's setting does not matter), **and** the owner named as actor confirms it. The lookup is STABLE (M38:1433-1453) and the proof writes nothing (M38:1114-1115).
3. **Unexpected issuance.** Anything else, including every row the matching rule leaves unmatched or makes class 3 (missing, unconfirmed, ambiguous, wrong instance; above): a credit note, registration, withdrawal, a counter change the per-store reconciliation does not explain, or a register, issue or withdraw audit row, created after the baseline and not class 1; a registration moved open → issued and not class 1; a settlement not class 2; a settle audit row without its matching registration change, or the reverse; any other change to a baseline row, which 038's guards refuse (M38:515; M38:571; M38:461-491), so it would also mean a privileged principal went around a guard.

**The release predicate.** For every class 3 row, and every pre-baseline row the owners cannot explain (treated as class 3), the owner records two separate fields: (1) its causal explanation, or "unexplained"; (2) the owner's decision. A third, the incident disposition, is required only for an unexplained row and for every orphan line, including the decision whether to rotate the runtime login's password and the tenant session issuer key. **Issuance may be restored only when every class 3 row has a decision, and every unexplained row and every orphan line has an incident disposition.** That is necessary, not sufficient: the closing scan C must also be backed by (i), the database write fence, which alone closes the window fully, or by (ii) with the owner's recorded acceptance of the no-fence residual (above), which permits release but leaves the window not fully closed; both are OPEN. No recorded field changes a row's class. An unexplained row or an orphan line is treated as possible use of the runtime's secrets (DA-93) and handled as an incident (G-INCIDENT stays OPEN, D08:278). The same predicate governs §9.3.2 step 9, §9.3.3 condition 5, §9.3.5 row 8, the closing scan and CA-47. The row is preserved: it is never deleted or edited; a mistaken note stays until CN-P3 or another approved means withdraws it (D17:944). Rotation does not close the window that has passed, and it does not stop whoever holds the new secrets, because the running runtime needs them (§9.3.7, the direct-call residual).

#### 9.3.5 Evidence required before issuance is restored in production

All of it, recorded, before any instance is switched to `on` (§9.3.2 step 9; §9.3.3 condition 6):

| # | What must be observed | By whom | From which surface or session |
|---|---|---|---|
| 1 | The ledger is exactly 001..N, or 001..N+k after repairs, each migration with its pinned checksum | Dedicated applier | Database ledger; preflight `startup_ready` (TE:459; PRE:97) |
| 2 | Every tenant-entry instance runs the build for that ledger, reports `startup_ready` and shows the setting `off`; every admin-entry instance runs the matching build and reports `startup_ready` (it carries no setting, §9.3.1); each old instance's verified exit time (Sk) and the values §9.3.1 lists for the operator to confirm are recorded | Operator | Platform instance list; startup logs |
| 3 | The activity route is in the served inventory | Operator | The build's `TENANT_SHIPPING_ROUTES` (TE:131-132; TE:217-219) |
| 4 | The activity read answers 200 with a well-formed page; where the trigger was wrong rows, the applier's read-only reconciliation of the verification store's full set (every page) against 038's tables matches (§9.3.2 step 7) | Verification tenant's store-scope `store_owner`; applier | A fresh session of an **active** tenant (D-CA-16); database |
| 5 | Register, issue and withdrawal answer 503 while `off`, leaving no idempotency row | Verification owner; applier for the row check | Same session; database |
| 6 | The attempts lookup answers 200 | Verification owner | Same session |
| 7 | The cause is resolved, and every repair is approved by the owner with its exact-commit CI and the repair's own acceptance rows (§12 item 3; §9.3.2 step 6) | Owner | Owner decision record; CI record |
| 8 | The evidence window is classified up to the closing scan C, taken immediately before the first switch `on` (§9.3.4), with either the database write fence in place (OPEN: not approved) or the check of no credit-note write in progress recorded at C together with the owner's recorded acceptance of the no-fence residual (OPEN; §9.3.4: (ii) leaves the residual and does not establish that the window is fully closed): every row created or changed after the baseline classified, each class 1 or 2 row recorded with the `committed` write log line it was matched to by the matching rule, the per-store counter reconciliation, the log's integrity for the period recorded (or every row class 3), the pre-baseline period listed and reviewed, and the release predicate holds (§9.3.4: every class 3 row with an explanation field and a decision; every unexplained row and orphan line with an incident disposition, rotation decision included) | Dedicated applier; owner | Database, against the kept baseline; the tenant runtime's write log lines and startup lines; owner record |
| 9 | Under D-CA-7 A, for each apply window: the principal inventory taken first, the fences in the state D16:377-380 requires at reopen, and the drain count clean at each repeat | Operator | Catalog (`rolcanlogin`, memberships, ACLs); `pg_stat_activity` |
| 10 | Under D-CA-7 B, for each apply window: the ledger read before and after the apply, the approved grants verified against the preflight's list, the apply log of the dedicated applier, and (for a repair) the recorded lock and concurrency analysis that justified B | Dedicated applier | Database ledger and catalog; apply log; owner record |
| 11 | If response (c) was used: the grant-back migration applied, its ACLs equal to the preflight's approved list (PRE:138-139; PRE:142), and rows 4 to 6 and 8 repeated after it. If response (d) was used: each affected tenant's and store's status restored exactly to its recorded prior value, verified, and its owner's lookup answering 200 in a fresh session | Dedicated applier; operator; owner | Database; catalog; owner record |

The step-5 preservation comparison (rehearsal row 7) has no production row: no down runs in production. After R the confirmatory scan (§9.3.4) is recorded too; an unexpected row in it re-pauses issuance (§9.3.2 step 3).

#### 9.3.6 Recovering unsettled attempts

Whenever the tenant is active: in a production pause throughout, except apply windows (§9.3.2); in the rehearsal, per branch (§9.3.7).
- **Which shop is loaded.** The shop is its own Vite build (`package.json:8`), separate from the server builds (`package.json:9-12`), and no server entry serves it, so a runtime change does not change it. The build owners must load is the deployed CN-P2 shop with this slice's sub-section, **identified by the commit SHA and artifact id recorded at deployment** (§12 item 7). Owners reload the page (a hard reload, so a cached older bundle is not used) and the operator confirms the served artifact id. Every route its credit-note controls call is CN-P1's and exists at 001..038 (RT:4-13).
- **What it exposes.** "Look up attempt" (T:495; T:6233), then "Confirm credit note" on an issued row (T:464; T:6203; T:6332) or "Release attempt" on an open row read in the current generation and token (T:466; T:6332) (D-P2-16 A, D17:800). The issuing controls are visible; every press gets the 503 while the setting is `off`.
- **Fallback, if that build is not the one loaded.** A recovery runbook in which the owner, in their own signed-in session (cookie plus that session's CSRF token, APP:947-952), calls `GET /api/v1/stores/{storeId}/credit-note-attempts`, then `POST …/invoices/{id}/credit-note-settlement` with `{"expectedTenant","attemptId","expectedVersion"}` (version 1 releases an open attempt, 2 confirms an issued one; `src/tenant/invoiceIssuingClient.ts:548-549`). Same limits as the shop.
- **Access limits.** `recover_invoice_credit_notes` (RT:10-11; RT:73): a store-scope `store_owner` at limitation `none` (PERM:563-565), the tenant **active**, and each owner's **own** attempts only (M38:1515).
- **Nothing expires.** The lookup lists "every unsettled row whatever its age" (M38:1496); an owner's own unsettled registration on an invoice makes that owner's next registration there answer `conflict` (M38:990). An `open` attempt holds no credit note; an `issued` one's note already exists and already counts (M38:1500-1503); confirming only acknowledges it.
- **Under D-CA-14 B or C** newly loaded pages have different controls (§9.3.1 table) and open tabs keep live issuing controls; neither meets D-P2-13 A alone.

#### 9.3.7 Disposable-environment rollback rehearsal (CA-36) [PROPOSED]

**Scope.** N's down and this order run only on disposable databases (D-CA-18 C). The rehearsal proves that N's down removes only N's objects and preserves every credit-note row, that the fences, the drain count and the id-and-digest comparison work, and that the coupling with CN-P2 holds while the read is absent. Under D-CA-18 A or B the owner would allow this order in production; then the principal inventory is run on the production database before step 1 (§12 item 11), and the stop rule applies there.

**The direct-call residual once the runtime login can log in again** (in the rehearsal; in production under D-CA-18 A or B) [ADOPTED, D-CA-18 C: A and B were not chosen, so this governs the rehearsal only]. The tenant process holds the runtime login and the tenant session issuer key together (DA-93, D08:383; `TENANT_SESSION_ISSUER_KEY`, TE:9-10, :203). So from the first moment the runtime login has LOGIN again (step 6, R1.1 or R3.3), **anyone holding the runtime's secrets can mint a `store_owner` key for any tenant that is not suspended and call 038's register, issue or withdraw directly**, bypassing the write setting (M38:76-77). In the window that means: every **trialing** tenant (never suspended, TST:12-18) from step 6; the **canary** from its reactivation; every other active tenant from its branch's lift point. While the activity read is absent (from step 5's COMMIT through step 7; in R3 until R3.3; in R2 until R2.6's repair), such a call would breach D-P2-13 A; HTTP alone stays compliant.
- *Operator controls evaluated.* Keeping the runtime login NOLOGIN until the read is verified closes it, but then no session can be established (SES:65-69), so neither the canary nor any owner can sign in and the read can never be verified on an authorized session: not usable. Rotating the issuer key does not close it: the running runtime needs the new key to mint, so its holders hold the new key. Setting trialing tenants (and the canary after its checks) to `read_only` by owner SQL (D16:384's lever; 038's writers require write statuses, M38:49-50) closes direct issuance for them at the database, at the cost of unaudited status writes and, under D-CA-1 A, a 403 on their activity read (D-CA-17 B).
- *What remains in every option:* holders of the runtime's secrets during the window, bounded by who holds them (DA-93), and detected after the fact by evidence row 10 below.

**Principals and their fence** (the classes the inventory must resolve to named logins):

| Principal class | What it can do to preserved data | Fence, and when it is released |
|---|---|---|
| The runtime login named by `APP_DATABASE_URL` (member of exactly `tmpos_app` and `tmpos_audit_writer`, PRE:27; tenant entry and admin entry, D16:376) | EXECUTE on register, issue and withdraw (M38:2754-2759; PRE:138-139); with the issuer key it holds, mint keys and call directly (DA-93; M38:76-77) | Stop both entries, `ALTER ROLE … NOLOGIN`, `pg_terminate_backend` (D16:377) at step 3. LOGIN restored only to start runtimes with writes `off`: step 6, R1.1, R3.3; set NOLOGIN again around every apply (R1.6, R2.6, R3.1) |
| Every other login that is a member of `tmpos_app`, or can `SET ROLE` to it, or holds ADMIN on it | The same, directly (without the issuer key, only with a key minted by someone who has it) | NOLOGIN and terminate at step 3; released only when the evidence list is complete, immediately before writes are switched on: R1.7, R2.7, R3.7 |
| Logins that are members of `tmpos_audit_writer`, **other than the runtime login** | Write audit rows, which the evidence covers (DA-114, M38:78); no credit-note EXECUTE or table privilege (M38:242; M38:372-375) | NOLOGIN and terminate at step 3; released once the preservation comparison has a final result: R1.5, R2.5, R3.6 |
| The owning/applier role of 038's objects, logins that are members of it, and superusers | Write the tables, disable a trigger, run DDL (M38:78-79); the owner keeps EXECUTE on every 038 routine, since no revoke names it (M38:2734-2745) | One **dedicated applier login** is the only privileged login from step 3; every other one NOLOGIN or membership revoked; released with the other `tmpos_app` member logins (R1.7, R2.7, R3.7). A disposable database permits this; where a managed provider makes it impossible (relevant only under D-CA-18 A or B), **do not roll back N** |
| `anon`, `authenticated` | Nothing on credit-note objects (M38:242; M38:372-375; M38:2738-2740) | None needed |
| Live keys of `active` tenants | Pass the routines' authority re-check while their admission digest matches (037:560-565) | Suspension at step 3 (D16:375); the canary at its reactivation, the rest at each branch's lift point (D-CA-17) |
| Live keys of `trialing` tenants, and keys a holder of the runtime's secrets can mint for them | The same | Not suspendable by the audited route (TST:12-18). Fenced only while no `tmpos_app` login can log in (step 3 to step 6); after that, D-CA-18 |

**Stop rule.** If the inventory finds a principal that cannot be fenced, or any drain count does not reach the allowed set, do not roll back N, or, past step 5, follow the branch the ledger is actually in (below). In the rehearsal, the failure is recorded as a finding. Every repair after that is a forward repair (a new migration at the next free number, §1 rule 4; D-CA-14 D is one such repair).

**Order** (each step starts after the previous one completes; written for D-CA-14 A):
0. **Setup, before N is applied:** the predecessor build, carrying the write setting, runs with the setting `on` (writes allowed); the N-built runtime carries the same setting. The shop build is recorded by commit SHA and artifact id. The canary tenant and its owner are named (D-CA-16).
1. **Freeze.** Record the start; no shop use (D16:373). Run the principal inventory on the disposable database; if anything cannot be fenced, stop: do not roll back.
2. **Baseline, then stop new writes while the read still serves.** First, record the §9.3.4 baseline (ids, the registration and counter fields, digests, and the database clock) under its one rule (§9.3.4: immediately before the first instance is switched; if it cannot start at once, immediately after): the evidence window of row 10 starts here. Then restart every tenant-runtime instance with the setting `off`, or take it out of traffic. Evidence: the platform's instance list, each new instance's startup line showing `off` with its instance id (Tk), each old instance's verified exit time (Sk), and no instance started before the change still in traffic. Tenants are still active here, so the canary tenant's store-scope `store_owner`, in a fresh session, also checks the three writes answer 503 with no idempotency row, the read answers 200 and the lookup answers 200.
3. **Close entry points and drain.** Suspend every affected `active` tenant (D16:375); stop both runtimes (D16:376); fence every principal in the table (D16:377); run the drain count. If it does not reach the allowed set: **branch R1**.
4. **Record the preservation evidence.** For every credit note, withdrawal, credit-note registration, per-store counter row and audit row (payload included), its stable id and a digest of the full row; and 038's routine ACLs.
5. **Down, verified before commit.** The house executor applies migrations forward only (MX:4128-4140), so the dedicated applier runs N's down by hand in one explicit transaction (the house downs are written for one: `set local`, M38D:24; "any refusal rolls the whole file back", M38D:15). Inside it: repeat the drain count; run N's down with its postcondition (§9.2); load the step-4 ids and digests into a temporary table; compare. COMMIT only if the count is clean and nothing differs. **ROLLBACK → branch R1. COMMIT → branch R2 or R3** (owner's choice at step 7).
6. **Start the predecessor build** (the tenant entry with the setting `off`, and the admin entry), restoring LOGIN for the runtime login only. Active tenants stay suspended; trialing tenants are reachable from here (D-CA-18). Evidence (surfaces only): ledger exactly 001..N-1; `startup_ready` on every instance; setting `off` on every tenant-entry instance; the activity route absent from the build's inventory, and a sessionless request to it answering 404 while the 401 control request answers 401.
7. **Decide the branch.** R3 if the same N file can be re-applied safely; R2 otherwise.

**Branch R1 — N remains applied** (stopped at step 3, or the down rolled back at step 5). This is the REOPEN path.
1. Start the N-built tenant entry (setting `off`) and admin entry; restore LOGIN for the runtime login only. Surface evidence: ledger 001..N; `startup_ready` on every instance of both; setting `off` per tenant-entry instance; the activity route in the inventory.
2. Canary (D-CA-16): reactivate the canary tenant alone; its store-scope `store_owner`, in a fresh session, checks read 200, writes 503 with no idempotency row, lookup 200.
3. Lift the remaining suspensions (D16:380) [D-CA-17].
4. Owner attempt recovery resumes (needs an active tenant; §9.3.6).
5. Restore LOGIN for `tmpos_audit_writer` member logins other than the runtime login (no down committed; nothing left to compare).
6. If the cause needs a forward repair: the same procedure as R2.6 (runtime login NOLOGIN, drain, apply by the dedicated applier, restart both entries on the repaired build, the tenant entry with the setting `off`, LOGIN for the runtime login only, a new canary check, in a fresh session, of read 200, writes 503 with no idempotency row and lookup 200).
7. When the evidence list below is complete: restore LOGIN for the other `tmpos_app` member logins and the owner/superuser logins; then switch writes `on` per instance, and record step 2's per-instance evidence afterwards.
*Tenant downtime:* from step 3 to R1.3; again from R1.6's stop to its restart if a repair is needed.

**Branch R2 — the down committed and re-apply cannot safely proceed.** The predecessor build runs; the activity read is absent (404).
1. The predecessor tenant entry (setting `off`) and admin entry stay running; the runtime login is the only LOGIN.
2. **Under D-P2-13 A writes stay `off` for as long as the read is absent.** The forward-repair path restores the read.
3. Tenant access [D-CA-17]. Under A: reactivate the canary alone; its `store_owner`, in a fresh session, checks read 404, writes 503 with no idempotency row, lookup 200; then lift the remaining suspensions. From then D-P2-13 A is met **over HTTP only**: a holder of the runtime's secrets can still issue directly while the read is absent (D-CA-18). Under C: tenants stay suspended until R2.6.
4. Owner attempt recovery resumes once the tenant is active: after R2.3 under D-CA-17 A; after R2.6 under C.
5. Restore LOGIN for `tmpos_audit_writer` member logins other than the runtime login (the step-5 comparison passed and committed).
6. Forward repair: stop both entries; set the runtime login NOLOGIN and terminate; run the drain count; the dedicated applier applies the repair; start both entries on the repaired build, the tenant entry with the setting `off`, LOGIN for the runtime login only. Under D-CA-17 A every tenant is down again from the stop to the restart (a second full outage); under C tenants are still suspended. Then reactivate the canary alone (under C) or use it again (under A); its owner, in a fresh session, checks read 200, writes 503 with no idempotency row, lookup 200. Under C, then lift the remaining suspensions.
7. When the evidence list below is complete: restore LOGIN for the other `tmpos_app` member logins and the owner/superuser logins; then switch writes `on` per instance, and record step 2's per-instance evidence afterwards.
*Tenant downtime:* under D-CA-17 A, from step 3 to R2.3, then again for R2.6's apply-and-restart window. Under C, from step 3 until R2.6 completes. Neither duration can be bounded in this document: R2.3 waits on the canary check, and R2.6 waits on a repair. A, in the rehearsal, restores service (writes off) sooner, accepting D-CA-18's residual and a second outage; C has one outage of unknown length.

**Branch R3 — the down committed and re-apply proceeds** (the normal re-enable path). The predecessor build runs with the setting `off`.
1. Stop the predecessor tenant entry and admin entry; set the runtime login NOLOGIN and terminate its sessions; run the drain count. If it fails: restart both predecessor entries, the tenant entry with the setting `off`, and go to **R2**.
2. Re-apply the **same** N file, byte-identical (its checksum is pinned in the preflight's ledger, in the form of PRE:95-97). A changed routine is a new migration at the next free number (§1 rule 4).
3. Start the N-built tenant entry (setting `off`) and admin entry; restore LOGIN for the runtime login only. Surface evidence: ledger 001..N; `startup_ready` on every instance of both; setting `off` per tenant-entry instance; the activity route in the inventory.
4. Canary: reactivate the canary tenant alone; its `store_owner`, in a fresh session, checks read 200, writes 503 with no idempotency row, lookup 200.
5. Lift the remaining suspensions (D16:380) [D-CA-17]. Owner attempt recovery resumes (§9.3.6).
6. Restore LOGIN for `tmpos_audit_writer` member logins other than the runtime login.
7. When the evidence list below is complete: restore LOGIN for the other `tmpos_app` member logins and the owner/superuser logins; then switch writes `on` per instance, and record step 2's per-instance evidence afterwards.
*Tenant downtime:* from step 3 to R3.5, including however long step 7 takes to resolve the cause. Trialing tenants are not down after step 6 (D-CA-18).

Under D-CA-14 D there is no down and no write setting (it exists only under A): steps 1, 3 and 4 (step 2's switching does not apply; its baseline is still taken, under the §9.3.4 rule, before the revoking migration), then apply the revoking migration (register, issue and withdraw) and start runtimes built for the new ledger, then R1's steps 2 to 6, with the writes refused at the database. Issuance returns only after a further migration grants EXECUTE back, its ACLs are verified against the preflight's approved list (PRE:138-139; PRE:142), the canary checks pass again in a fresh session and the evidence list below is complete; R1.7's LOGIN restores then follow.

**Evidence required before re-enabling issuance in the rehearsal** (all of it, recorded, before any instance is switched to `on`):

| # | What must be observed | By whom | From which surface or session |
|---|---|---|---|
| 1 | The ledger is exactly 001..N (or the repaired ledger), with N's pinned checksum | Dedicated applier | Database ledger; preflight `startup_ready` (TE:459; PRE:97) |
| 2 | Every tenant-entry and admin-entry instance started from the N-built (or repaired) build and reports `startup_ready`; the setting is `off` on every tenant-entry instance (the admin entry carries none, §9.3.1) | Operator | Platform instance list; startup logs |
| 3 | The activity route is in the served inventory | Operator | The build's `TENANT_SHIPPING_ROUTES` (TE:131-132; TE:217-219) |
| 4 | The activity read answers 200 with a well-formed page | Canary tenant's store-scope `store_owner` | A fresh session of an **active** tenant (D-CA-16) |
| 5 | Register, issue and withdrawal answer 503 while `off`, leaving no idempotency row | Canary owner; applier for the row check | Same session; database |
| 6 | The attempts lookup answers 200 | Canary owner | Same session |
| 7 | The step-5 preservation comparison committed with no difference (R2, R3), or no down ran (R1) | Dedicated applier | The kept step-4 record |
| 8 | Every fence the inventory listed is in the state its branch requires at that point, and the drain count was clean at each repeat | Operator | Catalog (`rolcanlogin`, memberships, ACLs); `pg_stat_activity` |
| 9 | The cause is resolved, and any forward repair is applied and approved | Owner | Owner decision record |
| 10 | **Evidence window from step 2:** every row created or changed after the step-2 baseline, found by comparing ids and fields with it (§9.3.4), and classified: completions of requests admitted before their instance switched (class 1), the owner's own settlements (class 2), anything else (class 3). Writes go on only when no class 3 row lacks an owner-recorded explanation and decision. This is the rehearsal's own check on a disposable database; it takes no closing scan and does not test or settle the no-fence residual, and production release follows §9.3.4's release predicate and closing-scan condition (OPEN) | Dedicated applier; owner for any explanation | Database, against the kept step-2 baseline |

Per-instance switching evidence is recorded **after** writes go on, as the last part of R1.7, R2.7 and R3.7, not before.

**What is preserved.** A rehearsal rollback never deletes or edits a credit note, a withdrawal, a credit-note registration, a per-store counter row, any audit row, or any of 038's tables, routines or grants. Step 5 proves it by ids and digests inside the down's own transaction, and every writer of that data is fenced from step 3 through step 5's commit. N's down removes only N's objects (§9.2). In production no down runs, and no recovery path deletes or edits any of that data, apart from an owner's own settlement, which sets one registration's `acknowledged_at` by design (M38:1634-1636).

### 9.4 Changes N forces elsewhere (implementation, not done)

- `postgresStartupPreflight.ts`: the N ledger row and its pinned checksum, and the grant line.
- The three suites that use `'039'` as the fake unknown migration move to N+1 (`'040'` under the provisional number; §1, D-CA-3).
- The migration smoke and the DB harness apply 001..N; the QA runbook's migration range ([14](./14-interactive-qa-runbook.md)) is updated when QA resumes.

### 9.5 Deployment steps [PROPOSED; procedure ADOPTED, D-CA-7 A]

- **Design text adopted as design** (D17:22) asks for "the 038 cutover-style deployment steps" (D17:583): freeze, close entry points, check remaining transactions, apply, reopen (D16:362-386).
- **Observation, not a decision.** 038's drained cutover exists to stop stale *writers* from resuming with pre-038 logic (D16:168; D16:368). N changes no writer and has no `LOCK TABLE` step, so that hazard does not arise. The preflight still forces a runtime restart around the apply: with the standard grants, the predecessor build refuses 001..N at its runtime-login check, before its exact ledger check: `startup_refused` with `database_login_unsafe` / `role_privilege_unexpected` (§9.3.1 evidence item 2; §9.3.2, apply windows). That was observed in-process for the compiled tenant entry (§13), and the production process exit is pending. D-CA-7 decided A (2026-11-18, §14); option B is kept there for the record.
- **Unchanged prerequisites.** No tooling applies 034 or later to a managed database; the cutover runbook tooling (CN-38) stays a deployment prerequisite (D10:1675; D16:370).
- **Forward repairs use the same procedure.** Under D-CA-18 C every production repair is a new migration applied in an apply window of D-CA-7 A's procedure (§9.3.2), so that decision governs N's first apply and every repair alike.

---

## 10. Detection, not prevention

- **The activity read gives owners visibility into duplicate issuance after it occurs. It does not prevent it.** Two store-scope owners of one store can still each issue a credit note for one intent (D10:1696; D17:798); the read only lets an owner see both afterwards.
- **D-P2-14's production decision remains OPEN**: accept the residual for production, or make a store- or invoice-wide guard a deployment prerequisite (D17:808). Passing this slice's gate does not decide it.
- **CN-P3 stays separate.** An extra or mistaken note seen in the activity view still cannot be withdrawn from the shop until CN-P3 ships (D17:944).
- **No automated duplicate marker** is proposed (D-CA-9); the view shows facts only.
- **G-OBSERVE stays OPEN.** The view is an owner tool, not observability or alerting (D08:276); refused attempts still leave no audit trace (D16:483).
- **No automated read-health control.** Nothing watches the activity read and switches writes `off` when it fails; a failure is found by people (§9.3.2). Such a control would be new design, and it is not proposed here.

---

## 11. DA-132: the direct-read entry

- **What DA-132 says.** A holder of the runtime login with `tmpos_app` membership plus a live minted tenant session key can call read routines directly. Each answers only that key's own tenant, under the same rechecks as the route, with no per-client rate limit (the limiter applies only to HTTP). It already lists 035's two lifecycle reads, 036's payments read and 038's three reads (the payments read v2, the credit-note list and the attempts lookup). OPEN, "not repaired and not closed" (D08:422; D10:1674).
- **What this slice adds.** One more read in the same class: `m7b_store_credit_activity` returns a store's credit notes (number, invoice id and number, gross, reason, times, withdrawal time and reason) and the issuing and withdrawing staff display names, to a key whose session is a store-scope `store_owner` at that store. A direct call skips the CSRF check, the per-client rate limit and, under D-CA-1 A, the HTTP read-only limitation (the routine admits read statuses). It never returns an actor id, an email or customer data.
- **What this slice satisfies.** The DA-132 entry that D17:583 requires: at implementation, D08's DA-132 row gains a parenthetical for N in the form of its 038 note, and ADR-53's register line (D10:1674) or the slice's own ADR names it. [PROPOSED]
- **What it does not satisfy.** DA-132 stays OPEN. Nothing here repairs direct-call exposure; that remains G-DBROLE's (D08:422, last column).

---

## 12. Gate: what must be true before CN-P2 may be deployed (D-P2-13 A)

Under D-P2-13 A, "CN-P2 is not deployed to production until the store-wide credit-activity read, built in its own slice (D-P2-2 A), passes its gate" (D17:942). This section states that gate's exact evidence. [PROPOSED; ADOPTED, D-CA-11 A, 2026-11-18]

1. **Design adopted.** This document adopted by the owner, with every D-CA decision recorded. **Met as a record on 2026-11-18**: revision 9 adopted, every D-CA decision recorded in §14. No other item is met.
2. **Built and committed.** This slice's migration N at the number §1's rules give it (provisionally 039), the server route, port and permission entry, the preflight change, the shop sub-section, its decoder and its 403 classification (§8.4), and the write setting of D-CA-14 A, in commits the owner approved.
3. **Exact-commit CI green** on every commit that is deployed: both jobs, `quality` and `appsec`, of the one workflow `ci` (`.github/workflows/ci.yml:8`, :25, :732), with any failed-job rerun recorded with its cause. The evidence is **kept** for each such commit: the run id, the head SHA and each job's conclusion. Commits: if this slice and CN-P2 ship together, on that commit; if this slice ships first, on its commit and again on the commit that adds CN-P2; under D-CA-14 A, also on the predecessor build's commit.
4. **Every §13 acceptance row run and passing** at its listed layers, with each recorded limit stated, on the final tree (not an earlier one; D17:916's lesson).
5. **Migration evidence.** N applied and rolled back on a disposable database, its down's postcondition passing (§9.2); 038's down refused while N is applied; the ledger 001..N and the pinned checksum of the committed up file; the approved grants exactly.
6. **Owner-directed synthetic QA** of the activity view, including a cross-owner duplicate seen by the other owner, once the owner reopens QA (deferred since 2026-11-18). Not UAT.
7. **Deployment and recovery order.** N and this read deploy before CN-P2 or in the same deployable unit; never CN-P2 without it. Under D-CA-14 A, the **predecessor build** (a runtime for 001..N-1 carrying the write setting) is deployed and running before N is applied: under forward-only recovery it is not a production rollback target, but it is the only runtime that can serve the 001..N-1 branch with writes `off` and the rehearsal needs it (§9.3.3). The N-built runtime carries the same setting. The deployed shop build is recorded by commit SHA and artifact id (§9.3.6), and the verification tenant and its owner are named (D-CA-16). The production forward-repair runbook (§9.3.2), its evidence window (§9.3.4), its evidence list (§9.3.5) and the 001..N-1 branch (§9.3.3) are written into the owner runbook: pause CN-P2 issuing first (by D-CA-14 A's write setting, which meets D-P2-13 A over HTTP), restore it only after the read is verified on an authorized session and the window is classified (and, under §9.3.4, the closing scan backed by the database write fence, which alone closes the window fully, or by check (ii) with the owner's accepted no-fence residual, which permits release without full closure: both OPEN), as D-CA-8 A decides. The forward-repair runbook is exercised once on a disposable database (CA-48), and N's down with the coordinated rollback order is rehearsed once on a disposable database (CA-36).
8. **DA-132 register entry.** D08's DA-132 row and the slice's ADR name the new direct-read routine, as D17:583 requires (§11).
9. **Deployment procedure.** The N procedure chosen under D-CA-7, written as an owner runbook, with its tooling (CN-38 stays a deployment prerequisite).

10. **Prerequisite, not authorization.** Passing items 1-9, 11 and 12 means only that **this slice's prerequisite for CN-P2 is satisfied** (D-P2-13 A). It is not an **authorization to deploy** CN-P2 or this slice: that is a separate, explicit owner decision (D17:806), taken with D-P2-14's production handling (OPEN) and the gates below.
11. **Production principal inventory, where a production step fences principals.** The read-only inventory of §9.3.1, run against the production database, with every principal resolved to a fence, its stop command and responsible operator, and the operator's authority to run NOLOGIN and `pg_terminate_backend` there verified. It is required before every apply window run in D-CA-7 A's shape, N's or a forward repair's (under D-CA-7 A, or for a repair the D-CA-7 row says needs A), because that window sets every `tmpos_app` member login NOLOGIN (D16:377); and under D-CA-18 A or B, which allow a production rollback. Under D-CA-7 B (not chosen) with D-CA-18 C and no repair that needs A, no production step would fence principals, and this item would be satisfied by recording that; under D-CA-7 A, adopted, it is required for every production apply window. Where it is required, a disposable rehearsal does not replace it.
12. **Doc 17 amendment.** Under D-CA-12 A, the amendment of §14.1 adopted by the owner and applied to D17:509 before §8.4 is implemented, with CA-26 and CA-32 run and passing. **Status 2026-11-18:** the amendment is adopted and applied to D17:509 (§14.1); CA-26 and CA-32 remain PLANNED — NOT RUN, so this item is not met.

**Passing this gate deploys nothing and closes no gate.** CN-P2's production deployment also still needs, unchanged: D-P2-14's production decision (OPEN); CN-38, a deployment prerequisite; G-APPSEC, PARTIAL and production-blocking; ICH-11, UNVERIFIED; G-A11Y, OPEN; F-2 and F-5, missing inputs; and every other OPEN gate that already blocks the invoice slices (D16:564).

---

## 13. Acceptance criteria for later execution (PROPOSED; every row PLANNED — NOT RUN, apart from the local HTTP runs recorded below, which are not §15(b) execution)

Layers: D database, U server unit, H HTTP through the tenant entry, C shop component, B real browser, Q owner-directed synthetic QA (**deferred by the owner, 2026-11-18**). Nothing below has been executed.

| ID | Criterion | Layers |
|---|---|---|
| CA-01 | The owner reads the store's notes newest number first; 51 asked, 50 served, `nextCursor` the 50th id; an empty store answers 200 with `creditNotes: []` and `nextCursor: null` | D, H, C |
| CA-02 | Another store of the same tenant: its notes never appear; its id in the path is 403 | D, H |
| CA-03 | Another tenant, or `p_expected_tenant` mismatch: `denied`, 403 | D, H |
| CA-04 | A manager at Invoices Full: 403 over HTTP; `denied` from the routine | D, H |
| CA-05 | Read-only and overdue tenant: per D-CA-1 (A: 403 over HTTP while the direct call answers, recorded as residual; B: 200) | D, H, B |
| CA-06 | Suspended or pending tenant or store: refused | H |
| CA-07 | Cursor walk over 120+ notes: strictly descending, no repeat, no gap, ends with `null` | D, H, C |
| CA-08 | A note issued between pages appears on no later page and appears first after a reload | D, H |
| CA-09 | Cursor of another store, another tenant, or a random uuid: 400 with the same status, `error` word and body shape as a malformed query (only `requestId` differs); a denied caller's cursor is never evaluated | D, H |
| CA-10 | Malformed query: bare `?`, `after=` with uppercase or non-uuid, a second key, a repeated key: 400 | U, H |
| CA-11 | Withdrawn note: `withdrawal` populated (time not before issue, closed reason, name); active note: `withdrawal: null`; a voided invoice's withdrawn notes appear | D, H, C |
| CA-12 | Names: `null` display name → `null` and "Name not set"; a name over 1,000 characters or with a control character → 503 for the page | D, U, H, C |
| CA-13 | CSRF header missing, repeated or another session's: 403 before authorization | H |
| CA-14 | 401 after sign-out; 429 with `Retry-After`, nothing stored | H, C |
| CA-15a | Role change mid-session, normal path: the server ends the session (D17:882), the next page is 401, the shop drops every loaded row and shows the ended text | H, C, B |
| CA-15b | Role change, any admission race in which a request is still admitted: the permission check or the routine answers 403; after the recheck (same token) rows are dropped and the section hidden | H, C |
| CA-16 | Store reassignment mid-session: 401, the session ends (`session_version_mismatch`, §8.2); in a race where the request is still admitted, 403 (§8.2); rows dropped either way | H, C |
| CA-17 | Grants: only `tmpos_app` holds EXECUTE; `anon`, `authenticated`, `tmpos_audit_writer` and PUBLIC none; the preflight lists it | D |
| CA-18 | N up and down on a disposable database; N's down refuses while N is not applied and its postcondition passes; 038's down fails (2BP01) while N is applied; ledger 001..N; the preflight refuses a fake N+1 (`'040'` under the provisional number, §1, D-CA-3) | D |
| CA-19 | Read-only proof: STABLE; no row written in any table, `audit_event` included; no row or advisory lock taken (ACCESS SHARE only, released at transaction end) | D |
| CA-20 | Shop decoder: exact key sets and types; `store.id` equals the request; strictly descending numbers; `nextCursor`, when not null, equals the last served item's id; a repeated cursor or an empty page with a cursor → Error | C |
| CA-21 | Shop states and text: loading, empty only after a read to the end, error with Try again, nothing on 403, rate-limited wait; the §4.3 strings pass the shipped word scans, with the "withdraw" scan's scope narrowly widened to this list (§4.3) | C, B |
| CA-22 | Focus and announcements: "Show more" keeps focus, "{n} more loaded." announced; status as text; times in `time` elements | C, B, Q |
| CA-23 | Cross-owner duplicate shown: with two notes on one invoice seeded by owner SQL as issued by two store-scope owners (historical data, not created through the product), each owner's activity view shows both, with each issuer's name. Creating such a duplicate through the shop on the final tree is not required; it stays conditional on D-P2-14 (under a preventive option B it must be refused instead) | D, H, B, Q |
| CA-24 | The section never sends a write request; a request log shows GETs only | C, B |
| CA-25 | 403 with an old token: the recheck finds a new token; the answer is dropped silently, nothing is hidden, the chosen store is cleared (`begin`), and the view reads from page 1 under the new token once a store is chosen again | C, B |
| CA-26 | 403 with the same token, the store still listed in the directory under the same tenant (the directory read directly, §8.4): this view's rows dropped, sub-section hidden, no text; D17 rule 4 state (CN-P2 names, lookup rows) is not cleared by it (per D-CA-12) | C |
| CA-27 | Context change (store switch, sign-in renewal, token or user change): every row dropped and one reload from page 1; a second mismatch shows Error | C, B |
| CA-28 | 401: the ended text is shown, rows dropped, nothing re-sent until Reconnect | C |
| CA-29 | 429: no request of this sub-section is sent before Retry-After passes (Show more and Try again included) | C |
| CA-30 | Races: an answer arriving after a store switch, a token adoption, a `renew` or a later request of the same kind is dropped with no state change; `sessionEndsSoFar()` moving during a read drops its answer | C |
| CA-31 | First-load shell: Loading, Error with Try again, Rate limited and Session ended render before any 200 | C |
| CA-32 | 403 classification (§8.4): same token and a previously listed store still listed under the same tenant → (A), only this view cleared and hidden, no hold detached, CN-P2 names and lookup rows kept, no further request for that store in the generation; same token and a previously listed store no longer listed (or under another tenant) → (B2), D17 rule 4's second bullet only, no token adoption; a store never listed in this tab → (A); the directory read is `drafts.listStores` under this sub-section's own request number, sent only after a same-token check, and the picker is unchanged by it (D-CA-12, D-CA-13) | C, B |
| CA-33 | No existence leak: a store of another store owner in the same tenant, a store of another tenant, and a store id that exists nowhere each answer 403 with the same status, `error` word and body shape (only `requestId` differs); never 404 | H |
| CA-34 | Every catalog role at this store (`manager`, `technician`, `sales_staff`, defaults and an owner-edited level) answers 403 under the D-CA-1 option chosen, at the layer §8.4 states | D, H |
| CA-35 | Under D-CA-14 A: with the write setting `off`, in both the predecessor build and the N-built runtime, register, issue and withdrawal each answer 503 and leave **no idempotency row**, no lease and no credit-note row (only the rate limiter's count); an older tab's retry of a completed issue gets 503, and "Look up attempt" then shows the issued row (this relies on CN-P2's 503 path, P2-37, whose component test had not run before 2026-11-20, D17:867; its local run is recorded below); the lookup, proof, settlement and every read answer as before; the startup log shows the value per instance; an invalid or absent value refuses startup. Under B: a newly loaded recovery-only build shows no issuing control and every recovery control. Under D: the three routines refuse `tmpos_app` and a direct call is refused too | U, H, C, B |
| CA-36 | Rollback rehearsal on a disposable database, in §9.3.7's order: the step-2 baseline recorded before the first instance is switched; per-instance evidence of the setting; every principal fenced as the inventory states (runtime login included); the drain count (client backends of this database only) reaches the allowed set; the down, the drain count and the id-and-digest comparison in one transaction, which commits only when both are clean; a deliberate mismatch rolls it back (branch R1); with tenants suspended, only surface evidence is counted (ledger, `startup_ready`, route inventory, per-instance setting, a sessionless 404, fences); branches R1, R2 and R3 each run once with the canary checks in a fresh session (read 200 or 404, writes 503 with no idempotency row, lookup 200) before any other suspension is lifted, and each fence released at its listed step; evidence row 10 compared against the step-2 baseline, not step 4's record (D-CA-8, D-CA-14, D-CA-16, D-CA-17) | D, H, C |
| CA-37 | During a pause (§9.3.2, tenants active) and after the rehearsal's rollback (§9.3.7), an owner's unsettled attempt (one open, one issued) is found by "Look up attempt" and settled by "Release attempt" and "Confirm credit note" (D-CA-14 A or B); each settlement appears in the evidence window only as class 2: one registration's `acknowledged_at` set, `credit_note_id` unchanged, one `store.invoice_credit_note.settle` audit row with that owner as actor, and nothing else (§9.3.4); under C the attempt stays listed by the lookup, unchanged, until CN-P2 controls return | D, H, C |
| CA-38 | Pagination: a `limit`, `cursor` or `before` key, an empty `after`, uppercase hex and braces → 400; within one traversal, rows strictly newest first, every note existing at page 1 exactly once, a note issued during the traversal absent until a new traversal; a new traversal (Refresh, Try again, store re-choice, context change, own-tab issue or Confirm) replaces the loaded chain; a "Show more" page with a newer status than page 1 is appended as served, never re-sorted or merged (D-CA-6, D-CA-15) | D, U, H, C |
| CA-39 | The directory read fails (403, 429, outage, unreadable) after a same-token 403: (U), this view hidden, no rule-4 cascade, the picker unchanged; a 401 there is (B0) (D-CA-13) | C |
| CA-40 | `p_limit` boundaries: null → raises `invalid_parameter_value`; 0 → raises; 1 → at most one row; 51 → at most 51 rows; 52 → raises; nothing written in any case | D |
| CA-41 | The session check itself fails after a 403 (429 or outage): (U), this view hidden, no cascade; on 429 nothing of this sub-section is sent before Retry-After (D-CA-13) | C |
| CA-42 | No certain-403 traffic: under D-CA-1 A or C, a store whose directory entry says `readOnly: true` gets no request of this sub-section and the sub-section is hidden; after an (A) denial no further request for that store until the generation or store changes | C, B |
| CA-43 | 404 `not_found` from the read (route absent): the Error state, never Empty, no cascade, no automatic retry | C |
| CA-44 | This tab's own successful issue (201) or Confirm (200) at the store re-reads page 1 of a loaded activity view once, and the new note appears first (D-CA-15 B) | C, B |
| CA-45 | "Refresh" (D-CA-15 B): starts a new traversal at page 1, replaces the loaded chain, keeps focus on the button, and sends nothing during a rate-limit wait | C, B |
| CA-46 | A session of a suspended tenant gets 401 (the session ends at admission: `session_admission_denied` or `session_version_mismatch`) or 403 `authz_denied` (a session admitted after the suspension through another grant, naming the suspended tenant's store) on the activity read and on all three write routes, before the write setting is consulted; a request to an unregistered route answers 404 with no session, while a sessionless control request to a served route on the same host answers 401; a trialing tenant's session still reaches the runtime; this is what a D-CA-7 A apply window and the rehearsal rely on (D-CA-16, D-CA-17) | U, H |
| CA-47 | Evidence window and classification (§9.3.4; production rows 8 and 11 of §9.3.5; rehearsal row 10): on a disposable database, with the baseline taken under its one rule, every credit note, registration, withdrawal, counter advance and credit-note audit row written after it is reported by id and field comparison. The write log line and the matching rule (§9.3.4), with a test log sink: (a) one HTTP register, issue, settlement and withdrawal each write exactly one `committed` line whose fields match their rows by the rule for that kind, and no line carries the idempotency key, scope, fingerprint or lease, the session key, the registration proof, the amount or the reason; (b) within the sealed record's retention (IDEM:107), a replay of a completed key writes no line and no row, and its request log line carries `idempotency_replayed`; a retry after an attempt that committed nothing gets a new correlation id, and a second registration or issue for the same attempt is refused with no row; (c) a row matched to a `committed` line from an instance whose startup line shows `on`, before that instance's verified exit (Sk) plus the recorded skew, with §9.3.1's values confirmed, is class 1 and still listed for owner review, and with that exit unverified it is not class 1 by time; (d) an owner's own settlement matched to a `committed` settle line and confirmed by that owner is class 2 (one registration's `acknowledged_at`, one settle audit row); (e) the same settlement, or a credit note, made by a direct routine call is class 3, including one that reuses a correlation id copied from a logged line, which also makes the logged row class 3 (ambiguous, (h)): forcing this needs both the correlation id (from the log or `audit_event`) and authority to insert a conflicting audit row (`tmpos_audit_writer` or a direct routine call); it fails safe, keeping writes `off`; (f) a committed row whose line is suppressed (a stop between commit and line) is class 3; (g) a row whose only line is `unconfirmed` (commit deadline forced) is class 3 and is listed with that line; (h) two lines or two audit rows for one correlation id make every row involved class 3; (i) a `committed` register, issue or withdrawal line from an instance whose startup line shows `off`, or from an instance not in the platform list, is class 3; (j) a `committed` line with no matching row is reported as an orphan line; (k) the release predicate (the closing-scan condition is separate and OPEN, §9.3.4): each class 3 row carries two separate fields (explanation or "unexplained", and a decision), and only an unexplained row or an orphan line also carries the incident disposition, including the rotation decision; writes stay `off` until every class 3 row has a decision and every unexplained row and orphan line a disposition; no field changes a class; (l) without the write log every row is class 3; (m) a withdrawal or issue whose credit note is of another invoice or store than the line names, or a settlement whose registration's `registered_by` is not the audit actor, is unmatched; a per-store counter delta that differs from the count of new notes, or a non-consecutive number range, is a class 3 row; (n) a settlement or a direct call committed after step 8 and before the closing scan C is found by C, and one committed between C and R by the confirmatory scan, which re-pauses issuance; (o) a row written between L and the baseline is found by its time with the commit-lag and clock-skew margin (§9.3.1; D-CA-18); with §9.3.1's values unconfirmed, no row is class 1 by time; (p) (added 2026-11-19 with §9.3.4's lost-lease amendment) a register, issue, settlement or withdrawal whose commit the store answers `lease_lost` answers 503 `service_unavailable` with the request log reason `transaction_lease_lost`, and writes no `credit_note_write` line and no row; a lost lease on a retry leaves the earlier attempt's line, or the lack of one, and its class unchanged | D, U |
| CA-48 | Forward-repair runbook exercised on a disposable database (§9.3.2, §9.3.3): baseline, then the pause with per-instance evidence; tenants stay active and the verification tenant's owner, in a fresh session, sees writes 503 with no idempotency row, lookup 200 and settlement working; a repair migration at the next free number applied in a D-CA-7 apply window, the runtime restarting around it; the verification checks after the apply; writes switched on only after §9.3.5's list. The 001..N-1 branch: the N-built runtime refuses that ledger, the predecessor build runs with writes `off` and answers 404 for the read, and reopening happens only after the byte-identical N is applied and conditions 2 to 6 of §9.3.3 hold (D-CA-8, D-CA-14, D-CA-16, D-CA-18) | D, H, C |

A screen-reader pass is Q-layer work; G-A11Y stays OPEN.

**HTTP-layer coverage as authored (2026-11-19; written, NOT RUN).** Traced against the shipped session and authorization code, each case below has one expected status. Session loss and a permission denial under a live session are separate cases:
- *Session loss, 401.* A role change (CA-15a, and CA-15b's demotion) or a store reassignment (CA-16) gives `session_version_mismatch` (`server/runtime/sessions.ts:640-642`). A tenant or store `suspended` or `pending_activation` (CA-06) gives `session_admission_denied` when it removes the principal's last tenant or store grant, as in the suite's fixture (`server/runtime/sessions.ts:636-638`), and `session_version_mismatch` when another grant remains.
- *Permission denial under a live session, 403 `authz_denied`.* A manager, technician or sales_staff at the store (CA-04, CA-34); a `read_only` or `overdue` owner (CA-05); another store or tenant, or a store that exists nowhere (CA-02, CA-03, CA-33).
- *Uncovered over HTTP.* Every "still admitted, then 403" variant: CA-15b's 403 branch, CA-16's and row 10b's 403, and the routine's `denied` (`store_credit_activity_denied`). Each needs a change landing between two reads in the same request (§8.2), a race the HTTP suite cannot construct. The handler's `authz_context_missing` is not a race: it is unreachable through the composed authorizer, which grants only a store scope at the path's store (`server/composition/tenantAuthorization.ts:269-272`, `:430`); the server unit test covers it. **CA-15b is PARTIAL at H**: the HTTP suite covers the demotion's refusal (401); the permission denial is covered separately, by the HTTP authorization refusals per role (403 `authz_denied`) and by the server unit test that maps the routine's `denied` to 403.
- *Shop slice (flag).* Store loss, suspension and a role change end the session, and after a race 403 the shop's session check itself revalidates admission, so these mutations lead to (B0), not (B2). §8.4's (B2) class and the "same token" wording of CA-15b and CA-32 describe a state this runtime is not expected to produce; they are kept as designed (conservative) and are for the owner to confirm or retire when the shop slice is built.

**Write setting and log coverage as authored (2026-11-19; written, NOT RUN except the HTTP suite's local runs recorded below; review fixes applied the same day).** CA-35: U in `server/entry/tenantEntry.test.ts` (M7TU-02 and M7TU-08: absent and invalid values refuse; M7TU-15b: the startup line per instance) and `server/runtime/invoiceCreditNotes.test.ts` (ICN-10: the 503 before body, key and commit, a stale sign-in included; recovery and every read unaffected, the settlement writing its `committed` line with the off instance's id; ICN-13: the composition and route-table guards); H in `tests/db/tenantEntry.integration.test.mjs` (the config matrix) and `tests/db/invoiceCreditNoteHttp.integration.test.mjs` ICH-23 (no idempotency row, lease or credit-note row; a completed issue's retry gets 503; lookup, proof, list, the store-wide activity read listing the issued note, and the settlement, whose `committed` line carries the off instance's id). Startup database clock (spec 2, written, NOT RUN): U in `server/persistence/postgresStartupPreflight.test.ts` (databaseClock: one read-only statement, the answer's exact shape) and tenantEntry M7TU-15b/15c (the field is the preflight's answer and not the instance clock; it comes after every startup check and before the listener; an unanswered or malformed sample refuses), and H in `tests/db/tenantEntry.integration.test.mjs` M7TE-01 (the line carries a database timestamp). **Failure rule decided by the owner, 2026-11-19, and recorded in §6.6:** fail closed, with `database_unavailable` and `startup_clock_unanswered`. No listener binds, readiness is not set, no `startup_ready` is emitted, and the database's text is never logged. §6.6 and §9.3.2 ("times") now describe the read as going through the startup preflight's client: the endpoint and login it validated, not a pinned connection. The read already uses the migrations' UTC text form, which the process timezone cannot shift (§6.6). Review added one check: a value of the right shape that names no real instant (month 13, February 30, hour 24, minute 60) also refuses. The preflight test adds those four cases (written, NOT RUN). CA-35 stays UNVERIFIED. The local runs recorded below exercised the HTTP suite's part of layer H on the sources of both builds; what is still missing is listed there. CA-46: U in ICN-11 and H in ICH-23, each under `off` with nothing acquired, planned, committed or written: a suspended tenant's session is 401 (`session_admission_denied`; H also accepts `session_version_mismatch`) on the three writes and the activity read; no session is 401; a wrong session CSRF token is 403 (`csrf_session_*`); a session without the grant is 403 `authz_denied`; H also covers, while suspended, the unregistered route's sessionless 404 against the served route's sessionless 401, and a trialing tenant's session reaching the setting (503). CA-47: (a), (b) and (g) in ICN-12 (U) and ICH-24 (H, with a test log sink): (b) includes the retry of an unconfirmed register under a new key (one `committed` line, a new correlation id) and a refused second register of that attempt (409, no row, no line); (g) is a register held behind the owner's hold of the issued header, so its row set is empty and its logged reason is `transaction_unavailable` (the 1,400 ms lock timeout) or `transaction_timeout` (deadline.ts:47): a strict commit-deadline case needs a lost-COMMIT relay the suite lacks (OPEN). ICN-14: a throwing log sink never changes the answer (the lost line leaves the row class 3). Outcome trace (`scratch` outcome-trace, refreshed 2026-11-19): every final 503 writes `unconfirmed` except a lost lease, as §9.3.4 now states (amended 2026-11-19 on the owner's instruction).
  - ICN-15 (written, NOT RUN) covers CA-47 (p) at U, for all four kinds. A lost lease answers 503 with its request log reason `transaction_lease_lost` and writes no line; `unavailable` and a broken answer each write one `unconfirmed` line.
  - The store's own nothing-committed `transaction_unavailable` stays `unconfirmed`, because the chain cannot tell it apart from an unacknowledged COMMIT.
  - CA-47 (p) at H: **ICH-25 PASS on the active suite** (authored 2026-11-19; passed in the owner-authorized local runs of 2026-11-20 recorded below, on the uncommitted worktree, not CI; `tests/db/invoiceCreditNoteHttp.integration.test.mjs`, `test('ICH-25 CA-47 (p) …` from line 2212).
    - *First invocation.* The held-header fixture of ICH-24 (g) makes it end 503 with exactly one `unconfirmed` line. The case waits for that transaction to end before going on.
    - *Retry.* The owner lapses the record's lease, so the same-key retry reclaims it over the real HTTP path rather than answering 409 `request_in_progress`. A disposable, test-only owner trigger on `tmpos_internal.idempotency_record` then simulates the competing lease holder by rewriting the lease inside that reclaim. The trigger is created and dropped within the case.
    - *What the assertions check.* The retry reaches the real lease fence, which answers `lease_lost`. It answers 503 `service_unavailable` with the request log reason `transaction_lease_lost`, emits no `credit_note_write` line, and leaves the earlier invocation unresolved in the logs. The first's `unconfirmed` line stays the only line of its correlation id. There is no `committed` line, no audit row under that correlation id, and no row, completion or outbox entry, and the record stays unanswered.
    - *Outside the stated coverage.* An actual loss of COMMIT acknowledgement, and live contention between two real requests for one lease.
    - *Still pending.* CA-35, the operator verification below and deployment. The pass covers this case only, inside the limits above. It is a local run, not CI on a commit (§15(b), D-CA-11), and the predecessor suite has no ICH-25, so CA-47 (p) has no predecessor-build evidence.
  - (c)-(f) and (h)-(o) are the applier's classification and stay OPEN, as does the platform-authenticated log source (pending deployment evidence).
- *Design discrepancy for the owner (recorded 2026-11-19; corrected in §9.1-§9.3.3 the same day under spec 2, source-traced, execution pending).* §9.3.1 ("Why the runtime and the ledger move together"), §9.3.3 and the evidence list of §9.3.1 (item 2) name `migration_unknown` / `migration_missing` (PRE:432; PRE:444) as the mismatched build's refusal. In source the tenant entry judges the runtime login (step 4, `server/entry/tenantEntry.ts:315-322`; PRE:402-409) before the ledger (step 5, `server/entry/tenantEntry.ts:324`), and that step refuses first with `database_login_unsafe`: `role_privilege_unexpected` for a predecessor build on a ledger with 039 (039's grants are unknown to it), `role_privilege_missing` for the N-built runtime on 001..038. The runbooks' expected refusal word should be confirmed or amended by the owner. On 2026-11-20 the owner directed that the runbooks adopt it: §9.3's scope against 038's recovery, §9.3.1, §9.3.2's apply windows, §9.3.3 and §9.5 now cite the in-process observations (§13). The production process exit stays pending, and the hand-aligned-grants case stays source-traced and unrun.

**Local HTTP runs recorded (2026-11-20; owner-authorized; not CI, no commit; not the §15(b) execution or D-CA-11 evidence; QA and CI stay paused).** Each invocation ran `tests/db/invoiceCreditNoteHttp.integration.test.mjs` with the existing runner, `env TMPDIR=/tmp PATH=<Node 20.20.0>:$PATH node_modules/.bin/tsx scripts/run-db-tests.mjs tests/db/invoiceCreditNoteHttp.integration.test.mjs`, from source through tsx (no built artifact). With no supplied target, the runner started a fresh disposable cluster that listened only on its own Unix socket (log target `{"source":"harness","hostKind":"unix_socket"}`). The local `initdb` reported PostgreSQL 16.15 when checked before each run; the logs do not print the version. The logs are kept in the implementation scratch area (`scratch/pause/`).
- *Active suite (the N-built runtime's sources, the uncommitted worktree on `eb10f4c`).* It was invoked three times that day; the recorded result is the third.
  - Log `ich23-rerun2-20261120.log` (sha256 1ef0885c563f7f5af6dbcf2262534d55f0247cde9221c0d476b01da79d9c1bd7): exit 0; 26 tests, 25 passed, 0 failed, 0 cancelled, 1 skipped. ICH-23 (CA-35 H, CA-46 H), ICH-24 (CA-47 (a), (b), (g) H) and ICH-25 (CA-47 (p) H) passed.
  - Teardown: the log shows no failure, and the teardown throws on any failed cleanup step. A check after the run, not recorded in the log, found no PostgreSQL process and no cluster directory left.
  - The first two invocations failed only at ICH-23 (24 passed, 1 failed, 1 skipped each; ICH-25 passed in both). Both failures came from the case's own fixture: a 409 `write_conflict` at its seed, from 038's one unsettled registration per owner per invoice (log `ich25-run-20261120.log`), then a 404 on the proof, which is bound to the registering session (log `ich23-rerun-20261120.log`).
  - The correction is in the test only. A second store owner issues the first note, so its registration stays issued and unacknowledged. Under `off`, the issuing owner's session serves the issued-row lookup and the completed-issue retry with its original key. The registering owner's original session serves the proof read. No assertion changed, and no production code changed.
- *Predecessor build (001-038).* A fresh `git archive` of `eb10f4c21e289d6d88359f429661c4cf5b958c51` with `predecessor-001-038-ich23-fixture.patch` applied (sha256 01a0f9dd9aa8681e8eb8fff2aa6e325b4f1c3e90d6c7f7c838f7850bd4cda31b). That patch is the pinned revision 2 (`predecessor-001-038.patch`, sha256 1aa143c23e392fe012a151094ca42c362471ac0c1efd2d4b75e448381a5cd61d, unchanged) with the same ICH-23 correction and no other difference.
  - The migrations end at 038: there is no 039 file, `REQUIRED_MIGRATIONS` ends at 038, and the suite asserts the latest migration is 038 at setup and teardown.
  - Log `predecessor-run-20261120.log` (sha256 8f7c711fe87def46fe82ada74997ca52e59e412798c55a7be12b38fc0c302381), one invocation: exit 0; 15 tests, 14 passed, 0 failed, 0 cancelled, 1 skipped. ICH-23 and ICH-24 passed. Teardown: no failure in the log, and the same after-run check found no process or directory left.
  - The predecessor suite has no ICH-25. The run used the source tree through tsx, not a built artifact, with the worktree's installed modules (identical `package.json` and lockfile).
- *Skipped in both runs.* ICH-11 (CN-34s1/CN-34s2 over HTTP), declared "not stageable over the real tenant entry". It stays **UNVERIFIED** (doc 16 §8 CN-34s2).
- *What these runs do not change.* CA-35 stays UNVERIFIED (row above). These runs exercised only the HTTP suite's part of layer H, on source trees. Still unrun:
  - layer U, unrun at the time of these runs; its later local unit runs are recorded below;
  - the H config matrix (`tests/db/tenantEntry.integration.test.mjs`), unrun at the time of these runs; its later local M7TE-16 runs are recorded below;
  - layers C and B;
  - the built predecessor and N artifacts;
  - CI on a commit.

  The operator verification and deployment stay pending.

**Local unit runs recorded: layer U for CA-35 (2026-11-20; owner-authorized; local source-level layer U evidence; not CI, no commit; not the §15(b) execution or D-CA-11 evidence; QA and CI stay paused).** The repository's unit runner (`scripts/run-tests.mjs`) takes no case filter. So each named file ran on its own, the way that runner runs each suite: `env TMPDIR=/tmp PATH=<Node 20.20.0>:$PATH node_modules/.bin/tsx <file>`, with the ambient database variables unset and no database. These are source runs through tsx, not a built artifact. The logs are kept in `scratch/pause/`.
- *Active tree (the uncommitted worktree on `eb10f4c`).*
  - `server/entry/tenantEntry.test.ts`: log `unit-active-tenantEntry.test-20261120.log` (sha256 e12dff27f0db49c3db4da0cbb24980f59b48a0864331ab8c706c2832986a0cc4), exit 0, 23 tests, 23 passed. **M7TU-02, M7TU-08 and M7TU-15b PASS.**
  - `server/runtime/invoiceCreditNotes.test.ts`: log `unit-active-invoiceCreditNotes.test-reorder-20261120.log` (sha256 3baf194065a7693f18c37e022efa03be2d293b6520c758a5e10c0c8359b38266), exit 0, 19 tests, 19 passed. **ICN-10, ICN-11 and ICN-13 PASS.**
  - *Two earlier ICN-11 failures, kept.* `unit-active-invoiceCreditNotes.test-20261120.log` (sha256 90acab6c7eb362dd16ba043cd939a3eb87b4e77227fa68369fb83c8bfb10292b) and `unit-active-invoiceCreditNotes.test-rerun-20261120.log` (sha256 fbc103bd8014235ead18f35c5e488451b3da03e8e404345b2a4837ac3698157b) each exit 1, 18 of 19, with ICN-10 and ICN-13 passing.
    - In the first, ICN-11's wrong-CSRF check got 401 instead of 403. The suspended-tenant loop before it had made admission refuse the principal, which ends every session of the principal (`server/runtime/sessions.ts:636-638`, `revokeAllOf`), the case's first session included.
    - In the second, an extra sign-in added for that check got 429 from the per-account login limit (`server/runtime/rateLimit.ts:84`, 5 per 5 minutes).
    - *The correction, in the test only.* ICN-11 now runs its wrong-CSRF block before the suspended-tenant loop, on the still-live first session. That makes five sign-ins. No assertion changed, no production code or login limit changed, and the edit is unstaged in the worktree.
- *Predecessor source tree (001-038; run from source through tsx, not a built artifact).* The checkout `pred-unit/` was a fresh `git archive` of `eb10f4c21e289d6d88359f429661c4cf5b958c51` with `predecessor-001-038-ich23-fixture.patch` (sha256 01a0f9dd9aa8681e8eb8fff2aa6e325b4f1c3e90d6c7f7c838f7850bd4cda31b) applied, checked byte-identical to that tree before the edit.
  - *Its temporary test-only ICN-11 edit.* The same reorder as the active tree, in `server/runtime/invoiceCreditNotes.test.ts` only. Diff `pred-unit-icn11-temporary-test-edit-20261120.diff` (sha256 91680f24d15312a1044d528624fd0ce3407f39d6aa4ee1be57909d88d4b4896d).
  - This edit and checkout are separate from the M7TE-16 edit in the tenant-entry runs' checkout `pred-run/` (below). Neither edit is part of either patch, and both patch files are unchanged (the pinned `predecessor-001-038.patch` is sha256 1aa143c23e392fe012a151094ca42c362471ac0c1efd2d4b75e448381a5cd61d).
  - `server/runtime/invoiceCreditNotes.test.ts`: log `unit-pred-invoiceCreditNotes.test-20261120.log` (sha256 c739b6e42dcc0ce0b9586d570ea96a87ba767a5d087f0417fc1a4095d32c8916), exit 0, 15 tests, 15 passed. **ICN-10, ICN-11 and ICN-13 PASS.**
  - `server/entry/tenantEntry.test.ts` (unedited): log `unit-pred-tenantEntry.test-20261120.log` (sha256 802e482b3aac6dff5e559a6640c10718f2c146ab5806b303a74bf69e177d5128), exit 0, 23 tests, 23 passed. **M7TU-02, M7TU-08 and M7TU-15b PASS.**
- *What these runs do not change.* CA-35 stays **UNVERIFIED**. They cover only the named U cases, on source trees.

**Local tenant-entry runs recorded: the startup log per instance (2026-11-20; owner-authorized; local source-level HTTP evidence; not CI, no commit; not the §15(b) execution or D-CA-11 evidence; QA and CI stay paused).** M7TE-16 (`tests/db/tenantEntry.integration.test.mjs`, `test('M7TE-16 …` from line 1709; test-only, added 2026-11-20) covers CA-35's "the startup log shows the value per instance" at H.
- *What it checks.* It starts one instance with `TMPOS_CREDIT_NOTE_WRITES=on` and then one with `off`, each through the suite's own harness with its own log capture. For each instance:
  - exactly one `startup_ready` line in that instance's log;
  - `creditNoteWrites` equal to the value the instance was started with;
  - an `instanceId` that is a string and a version-4 UUID (§6.6: a random id generated at each process start, `server/entry/tenantEntry.ts:245`, written on the line at `:489`).

  The two ids must differ, which is what tells instances apart when their lines share one log (the case itself reads each instance's capture separately). Adding the case needed no production change.
- *Command.* Each tree ran it once, with the existing runner from source through tsx (no built artifact): `env TMPDIR=/tmp PATH=<Node 20.20.0>:$PATH node_modules/.bin/tsx scripts/run-db-tests.mjs tests/db/tenantEntry.integration.test.mjs`, with the ambient database variables unset. Each run started a fresh disposable cluster on its own Unix socket (log target `{"source":"harness","hostKind":"unix_socket"}`). The local `initdb` reported PostgreSQL 16.15 when checked before the runs; the logs do not print the version.
- *Teardown.* Neither log shows a failure. A check after each run, not recorded in the log, found no PostgreSQL process and no cluster directory left. The logs are kept in `scratch/pause/`.
- *Active suite (the uncommitted worktree on `eb10f4c`, which carries the M7TE-16 test edit).* Log `tenantEntry-integration-m7te16v2-active-20261120.log` (sha256 6ce793a610e78c745f9d76f836fa5bd539d73b47f2aa2399c0172248335e713c): exit 0; 17 tests, 17 passed, 0 failed, 0 skipped. M7TE-16 passed, and so did M7TE-07 (an absent value and the invalid `OFF` refuse startup).
- *Predecessor source tree (001-038; run from source through tsx, not a built artifact).* The disposable checkout (`pred-run/`, separate from the unit runs' `pred-unit/` and its ICN-11 edit) was a fresh `git archive` of `eb10f4c21e289d6d88359f429661c4cf5b958c51` with `predecessor-001-038-ich23-fixture.patch` (sha256 01a0f9dd9aa8681e8eb8fff2aa6e325b4f1c3e90d6c7f7c838f7850bd4cda31b) applied. It was checked byte-identical to that tree before the edit.
  - M7TE-16 was added there as a **temporary test-only edit**: the same lines as the active tree, and the only difference from base plus successor. Diff `pred-run-m7te16-temporary-test-edit-v2-20261120.diff` (sha256 9e73e84853faa04a5b4b7b35bbf28f3ef93921e3f05c196c07a9860a80a3f0d6).
  - The edit is not part of either patch. Neither patch file changed, and the pinned `predecessor-001-038.patch` is still sha256 1aa143c23e392fe012a151094ca42c362471ac0c1efd2d4b75e448381a5cd61d.
  - Log `tenantEntry-integration-m7te16v2-pred-20261120.log` (sha256 fca9a9c79286a2e83a48704f54078cd16d250c4bd863750a7b92271f5cfcce8a): exit 0; 17 tests, 17 passed, 0 failed, 0 skipped. M7TE-16 and M7TE-07 passed.
- *Earlier invocations, kept and superseded.* Each tree first ran the suite without M7TE-16 (`tenantEntry-integration-active-20261120.log`, `tenantEntry-integration-pred-20261120.log`: 16 of 16 each). Each then ran it with M7TE-16 checking the instance id only after converting it to a string (`tenantEntry-integration-m7te16-active-20261120.log`, `tenantEntry-integration-m7te16-pred-20261120.log`: 17 of 17 each). The runs above replace that conversion with the string check.
- *What these runs do not change.* CA-35 stays **UNVERIFIED** (row above). Not covered at H:
  - the compiled entry's startup line (M7TE-C1 does not assert the setting);
  - invalid values other than `OFF`.

  Still pending: layers C and B, the built predecessor and N artifacts, CI on a commit, the operator verification and deployment.

**Local component runs recorded: P2-37's 503 clause (2026-11-20; owner-authorized; local source-level layer C evidence; not CI, no commit; QA and CI stay paused).** Each case below ran on the active tree with the existing component runner: vitest, which `scripts/run-frontend-tests.mjs` wraps, given the file and a case filter. That wrapper runs the whole suite and takes no filter.
- *Command.* `env TMPDIR=/tmp PATH=<Node 20.20.0>:$PATH node_modules/.bin/vitest run src/tenant/ServerIssuedInvoices.test.tsx -t 'P2-37 \(503 clause, scripted\)' --reporter=verbose`. Exit 0.
- *Test.* `P2-37 (503 clause, scripted). 503 at register, proof, issue and settlement → regUnknown / registeredOnly / unresolved / settleUnknown`, from line 12245. 1 passed; the filter skipped the other 541. Log `component-p2-37-503-active-20261120.log` (sha256 2a2263254815bc7837e1580fd93b1c60074f51e8cfe618dd14de3d9fbaeb42e6), in `scratch/pause/`.
- *What that case asserts, against CA-35's two shop behaviors.* It scripts a 503 on a first issue send and asserts:
  - the unresolved card, with Check again and Look up attempt;
  - nothing sent on its own afterwards;
  - no "No credit note was issued" text.

  It retries no completed issue and never presses Look up attempt, so on its own it covers neither behavior in full.
- *The CA-35 case (added 2026-11-20, test-only).* `P2-37 (503 clause, CA-35). an issue the server completed while this older tab still holds it unresolved: Check again resends the same key and bytes and gets 503; Look up attempt then shows that attempt issued, sending no write`, from line 12276, beside the unchanged scripted case. Diff `component-p2-37-ca35-test-edit-20261120.diff` (sha256 a27fce5c7026c7985c7a9615db2011ff073aa897644fb639ea28bdcbba751160): 38 added lines, nothing removed.
  - *Run.* The same command with `-t 'P2-37 \(503 clause, CA-35\)'`. Exit 0; 1 passed, and the filter skipped the other 542. Log `component-p2-37-ca35-active-20261120.log` (sha256 bbe7b435b3d3a32366e5486af73b05b6e18094f82e7c817363fdd5b43aab27a4), in `scratch/pause/`.
  - *(1) The retry's 503: PASS.* The fake commits the issue and loses its answer, which leaves the card unresolved while the server holds the issued note. The documented retry (doc 17 §3.7, "Lost reply at issue": Check again) then:
    - resends the issue with the original `Idempotency-Key`, the same body and the same attempt id;
    - takes the scripted 503 (the case shows the script was consumed by this second request and the card stayed unresolved; it does not read the reply's status itself);
    - leaves one note on the server, the unresolved card, and "Look up attempt" offered, with no "No credit note was issued" text.
  - *(2) "Look up attempt" shows the issued row: PASS.* After the 503, Look up attempt sends one lookup read and no register, issue or settlement. It shows exactly one row, `data-state="issued"`, reading "Issued, not confirmed", with its Confirm control offered. The row exposes no attempt id, so its tie to this attempt rests on the fixture: the fake lists only this one registration, whose attempt id the issue carried.
- *Fixture limits.*
  - The 503 is scripted in the component fake after its session and authority checks. It stands in for the runtime's write setting `off`, whose gate answers before the key is looked up (§6.6). The real gate is covered at H by ICH-23, not here.
  - The rig has one tab. "Older tab" means the tab that still holds the unresolved attempt after the server completed it (the lost reply). No second live tab completes the issue.
  - The fake lists only this attempt, and the case does not press Confirm.
  - This is a component test under jsdom against a fake, not a browser run against the real runtime.
- *What these runs do not change.* CA-35 stays **UNVERIFIED**. Still pending: layer B, the built predecessor and N artifacts, CI on a commit, the operator verification and deployment.

**Local browser run recorded: SCN-23, an older tab's retry of a completed issue while writes are off (2026-11-20; owner-authorized; local browser evidence against the source runtime of the active tree; not CI, no commit; not the built-artifact, §15(b) or D-CA-11 evidence; QA and CI stay paused).**
- *The test change (test-only, `tests/browser/shopRoleLevels.browser.test.mjs`).* `startEntry` and `listenEntry` take an optional write setting that defaults to `on`. The entry object `listenEntry` returns, which `startEntry` stores, records it. `SCN-23` is in the expected scenario IDs, and the scenario `SCN-23` was added after SCN-22. Diff `scratch/pause/browser-scn23-test-edit-20261120.diff` (sha256 62327e7aa666f1ab628780baa0eba0f221b8cef3a9fad5e4f74daaefd5b76b1f); no product code changed.
- *Harness, as inspected before the run.* `scratch/browser/run.sh` copies the worktree (tracked and untracked files) to a throwaway snapshot and runs it in a private network namespace. Its `inner.sh` starts a throwaway cluster with `fsync` on, on a Unix socket only (`listen_addresses=''`), and removes it on exit. The tenant runtime is the TypeScript source, run in the test process, not a built artifact. The shop app is built from the snapshot. Firestore is the file's stand-in (`P3R2_FIRESTORE=stub`), and the browser answers every off-site host locally. The name filter `SCN-23` matches one registered scenario.
- *Run.* `bash /home/runner/workspace/.workflow/cn-p2-impl/scratch/browser/run.sh "SCN-23" ca35-scn23-20261120b`, Node 20.20.0 (`inner.sh`'s PATH). Exit 0 after 59 s; 131 tests, 1 passed, 0 failed, 0 cancelled, 130 skipped. `.replit` unchanged, and no process was left on the snapshot.
  - Files: `scratch/browser/ca35-scn23-20261120b.out` (ee5db2b76930209514606baf888262c099321cd82176a11fb56ce545c9374aed), `….run.txt` (3a64ebb6c72ff79e7d2df87bebe2a0e5032f4933eb0d211272c665c43d2c76ec) and `….snapshot.txt` (1ec6539c0d170a8d990f9adbbcd503ab3fe59dedf017da9725d49e78cbcead1c).
  - The snapshot's hashes of the test file (14699387…) and `ServerIssuedInvoices.tsx` (1939363d…) equal the active tree's.
  - Evidence: `scratch/browser/evidence-ca35-scn23-20261120b/`, with `shop-role-levels.json` (399c8a49…) and `scb-witness.jsonl` (f5a653c1…).
  - An earlier attempt under the tag `ca35-scn23-20261120` was cut off when the session ended. It reached the cluster (`fsync=on`), but its test process wrote no output and no evidence. Its files are kept as `…-interrupted`, it gave no result, and no memory kill was recorded.
- *Observed, each an assertion that passed unless marked recorded.*
  - (1) *Lost reply.* The page's chain was register 201, proof 200, and issue 201 with the reply lost at the front. The database held one note and registration `issued`, with the audits `register`, `issue`. The card was unresolved with Check again, Look up attempt and Hide this attempt.
  - (2) *Restart with writes off.* The page and its session stayed, and the database stayed. The primary entry was stopped and started with `TMPOS_CREDIT_NOTE_WRITES=off`, and its one `startup_ready` line carried `creditNoteWrites: off`. The page still showed the unresolved attempt, with no reload.
  - (3) *Check again.* It sent exactly one issue, with the same Idempotency-Key and body as the lost issue (compared, never printed), to the primary entry. The page received 503 `service_unavailable`, with no `idempotent-replayed` header. The off entry's own log had exactly one 503 request line, with reason `credit_note_writes_disabled`. No proof or settlement was sent. Look up attempt was still offered, and the card stayed unresolved (recorded).
  - (4) *Look up attempt.* It sent one lookup read (200) and no write. The read listed this attempt as `issued`. The row shown was `issued`, "Issued, not confirmed", $12.50, with Confirm credit note.
  - (5) *Database afterwards.* Still one note and registration `issued`, and only the `register` and `issue` audits.
  - (6) *Same entry.* Every request of the page went to the primary entry, never the second entry, and the leak check passed.
  - (7) *Cleanup (recorded).* The `finally` restarted the primary entry with `on`, and its `startup_ready` line read `on`.
- *Limits.* These come from the run and from an independent review of the test change; the test was not changed after its only run.
  - *Timing.* Exactly one retry and no write after the lookup are asserted at a point in time, after every recorded request was answered. They are not asserted after a quiet interval. The scenario's full request record ends after the database checks. After the lost issue it holds only two session reads (200), the one 503 issue and one lookup read.
  - *Session and login.* That the session survived the restart is shown by those 200 session reads and by the absence of any login request after the restart. The test does not assert either.
  - *Log correlation.* The off entry's 503 line is tied to the retry by count, not by route: the log's route class for this path is `other`.
  - *Cleanup check.* The cleanup's `on` startup line is recorded, not asserted.
  - *Scope of this run.* It covers only the shop's retry and lookup behaviour against the source runtime. It does not cover the register or withdrawal refusal, the idempotency-row, lease and credit-note-row absence under `off` (ICH-23 covers that at H), invalid or absent values at startup, layer B's recovery-only build (Under B), or D.
- *What this run does not change.* CA-35 stays **UNVERIFIED**. Still pending:
  - the predecessor browser run (found N/A later the same day for a predecessor-only build; the mixed case, tracked in its own paragraph below, replaces it);
  - the built predecessor and N artifacts;
  - CI on a commit;
  - the operator verification;
  - deployment.

**Predecessor-only browser coverage of CA-35's older-tab step: N/A (2026-11-20; preflight only, no browser scenario run).**
- *The record.* [`scratch/pause/pred-browser-scn23-preflight-20261120.md`](../../../scratch/pause/pred-browser-scn23-preflight-20261120.md) (sha256 0da6fc55f8343301…).
- *The checkout.* `pred-browser-20261120/` is a fresh `git archive eb10f4c` with the successor patch `predecessor-001-038-ich23-fixture.patch` (01a0f9dd…) applied. It matched `pred-ref-20261120/` under `diff -rq --no-dereference -x node_modules` (empty), and its migrations end at 038.
- *Why N/A.* The predecessor leaves out the CN-P2 shop by design. Its base `eb10f4c` is the CN-P2 design-only commit, and its shop has no credit-note issue or recovery UI, so no predecessor tab can hold an unresolved credit-note attempt. The SCN-23 diff does not apply there as a test-only change: the scenario-list hunk fails, and the body needs SCN-17's helpers, which that file lacks.
- *What stays.* This N/A adds no CA-35 evidence and changes none of the predecessor U and H runs recorded above. The active SCN-23 result above stands.
- *Tracked separately.* The case that can occur, a CN-P2 tab left open while the runtime is the predecessor (for example after a rollback), is the mixed browser case, tracked in its own paragraph below.

**Local mixed browser run recorded: SCN-23 with the active shop against the predecessor's source runtime (2026-11-20; owner-authorized; mixed source-level browser evidence; not CI, no commit; not the built-artifact, §15(b) or D-CA-11 evidence; QA and CI stay paused).**
- *What it models.* A CN-P2 tab left open while the runtime is the 001–038 predecessor, for example after a rollback.
- *Which source each part used.*
  - The shop is built with vite from a snapshot of the active worktree: the test runs the build with its working directory set to `P3R2_SPA_SOURCE` (test file :1921), and the evidence records `source: P3R2_SPA_SOURCE` and a 15 s build. The snapshot has `src/` tree 247c00df…, `ServerIssuedInvoices.tsx` 1939363d…, the same as the active run.
  - The test process, and the tenant entry it starts in-process, run from a snapshot of `pred-browser-20261120/`. Its `server/` tree hash 011b69f0… equals the checkout's and differs from N's; its `tenantEntry.ts` is 37980ba5… (N's is 25eb71e2…) and has no store-wide `/credit-notes` row. Its migrations are the predecessor's: 38 up files, the last `038_m7b_invoice_credit_note`, no 039.
  - The test file is the active one, unchanged (14699387…). It is the only repository file overlaid from N onto the predecessor snapshot.
- *Harness (test-only; two new files, `run.sh` and `inner.sh` unchanged).* `scratch/browser/run-mixed.sh` (df14b7bf…) and `inner-mixed.sh` (4a413985…).
  - Before the snapshot, `run-mixed.sh` refuses unless `pred-browser-20261120/` matches `pred-ref-20261120/` and its migrations end at 038 with no 039 file.
  - After the snapshot, it refuses unless the predecessor snapshot's `server/` equals the checkout's and differs from N's, the shop snapshot's `src/` equals N's, and the test file equals N's. It records each hash.
  - `inner-mixed.sh` is `inner.sh` with the test's working directory set to the predecessor snapshot and the shop source set to the N snapshot. It uses the same private network namespace and a throwaway Unix-socket cluster with `fsync` on. After the test it reads the cluster's migration ledger.
- *Run.* `bash /home/runner/workspace/.workflow/cn-p2-impl/scratch/browser/run-mixed.sh "SCN-23" ca35-scn23-mixed-20261120`, Node v20.20.0. The test process exited 0 after 63 s, and the wrapper finished after 103 s; 131 tests, 1 passed, 0 failed, 0 cancelled, 130 skipped. `.replit` unchanged, and no process referring to the temporary snapshots was left.
  - Migration ledger of the cluster used: 38 rows, `001` to `038`, no `039`.
  - Files: `scratch/browser/ca35-scn23-mixed-20261120.out` (636180ef…), `.run.txt` (1c60cac5…) and `.snapshot.txt` (a2790c26…).
  - Evidence: `evidence-ca35-scn23-mixed-20261120/`, with `shop-role-levels.json` (d37fc622…) and `scb-witness.jsonl` (31bfe1fa…).
- *The store-wide read against the predecessor.*
  - The predecessor itself answered both of the shop's `GET /api/v1/stores/{storeId}/credit-notes` reads with `404 not_found`. By the code, those are the store pick and the sign-in renewal; the run does not record which was which. The harness forwarded both to the predecessor entry: the scenario intercepts only the issue's reply, and the `not_found` code is the entry's own JSON.
  - From the source (not captured by this run's evidence), the shop shows that as the Credit activity panel's "Credit activity couldn't be loaded." with Try again (`ServerIssuedInvoices.tsx:2957`, the text at :6541, the button at :6558). It does not retry on its own. The activity state is the panel's own, and a 404 touches no issue or recovery state (a read-only trace of the source).
  - It did not block issuing or recovery.
- *Observed, each an assertion that passed unless marked recorded.* The same SCN-23 assertions as the active run, unchanged.
  - (1) *Lost reply.* Register 201, proof 200, and issue 201 with the reply lost at the front. One note and registration `issued`; the audits `register`, `issue`. The card was unresolved with Check again, Look up attempt and Hide this attempt.
  - (2) *Restart with writes off.* The predecessor entry was restarted with `TMPOS_CREDIT_NOTE_WRITES=off`, and its `startup_ready` line carried `creditNoteWrites: off`. The same page, session and database stayed, and the page still held the unresolved attempt.
  - (3) *Check again.* Exactly one issue, with the same key and body as the lost issue. The page received 503 `service_unavailable`, with no `idempotent-replayed` header. The predecessor entry's own log had one 503 line, with reason `credit_note_writes_disabled`. No proof or settlement was sent.
  - (4) *Look up attempt.* One lookup read (200) and no write. The read listed this attempt as `issued`, and the row was "Issued, not confirmed", $12.50, with Confirm credit note.
  - (5) *Database afterwards.* Still one note and only the `register` and `issue` audits.
  - (6) *Same entry.* Every request of the page went to the primary entry.
  - (7) *Cleanup (recorded).* The entry was restored to `on`, and its startup line read `on`.
  - Recorded: after the lost issue, the page sent only two session reads (200), the 503 issue and the lookup read. It sent no login.
- *Limits.*
  - The active run's limits apply unchanged: point-in-time counts, the session's survival shown but not asserted, the 503 log line tied by count, and the cleanup recorded rather than asserted.
  - This is a source-level mix, not the built predecessor artifact. It does not exercise 039's store-wide read (the panel's 200 path) or a preflight at 039.
- *What this run does not change.* CA-35 stays **UNVERIFIED**. Still pending:
  - the production-process launch of the predecessor and N artifacts (both built, and run through their compiled entries in-process, later the same day; below);
  - CI on a commit;
  - the operator verification;
  - deployment.

**Local builds of N and the predecessor, and SCN-23 through each compiled tenant entry in-process (2026-11-20; owner-authorized; local built-JavaScript browser evidence, not a production launch; not CI, no commit; not the §15(b) or D-CA-11 evidence; QA and CI stay paused).**
- *Builds.* Each was built with the documented command `npm run build:server:tenant`, which is `tsc -p tsconfig.server.tenant.json`: `server/entry/tenantMain.ts` and its import closure, output to `dist-server-tenant/`. Each ran as `node_modules/.bin/tsc -p tsconfig.server.tenant.json` with Node v20.20.0, in a fresh snapshot under `scratch/pause/built-20261120/`. The record is `build.txt` (ed5d2194…).
  - *N*, from a snapshot of the active worktree (its `server/` tree 7da312c1… equals the worktree's). Exit 0, no compiler output. The artifact's `dist-server-tenant/` tree is 1e84ca775ce7294ffef43e3b48d7875623f86a19729b8bf4d6a7feae8a41e39a (68 files), with `tenantMain.js` 06d227a5… and `tenantEntry.js` 63233f48…. The compiled inventory has the store-wide `GET /api/v1/stores/{storeId}/credit-notes` row, and the compiled preflight requires migrations through `039`.
  - *Predecessor*, from a snapshot of `pred-browser-20261120/` (its `server/` tree 011b69f0… equals the checkout's). Exit 0, no compiler output. The artifact is 4f412e5ca63be04e02685f683c2aca89acd281c37d68ae93df22249179453963 (68 files), with `tenantMain.js` 06d227a5… (byte-identical to N's) and `tenantEntry.js` fd709833…. It has no store-wide row, and its preflight requires migrations through `038`.
- *Production-launch preflight: blocked, so nothing was launched as a production process.* `start:tenant` (`node dist-server-tenant/server/entry/tenantMain.js`) cannot serve this browser test with harness-only changes. The record is `scratch/pause/built-20261120/preflight-stop.md` (49d7a83f…), with the trace in `scratch/pause/built-entry-trace-20261120.md`.
  - *First blocker: identity.* `tenantMain.ts:14-18` always passes `PRODUCTION_CONSTRUCTION`, which has no token verifier (`entryStartup.ts:84-87`). The shop's sign-ins therefore go through `verifyIdToken(idToken, true)` (`firebaseAdminAuthAdapter.ts:123`), which needs Google's network. The test's identity stand-ins mint unsigned tokens. The identity-emulator, TLS-verification and trust-store overrides are refused at startup (`entryStartup.ts:216-222`).
  - *Database (a harness workaround is proposed, not verified; the in-process runs below bypass it by injecting the client).* The production database client accepts only `db.<ref>.supabase.co` or `<label>.pooler.supabase.com` on port 5432, with TLS verified against `DATABASE_CA_CERT` (`databaseEndpoint.ts:60-70`).
- *The in-process runs (M7TE-C1's pattern).* Harness: `scratch/browser/run-compiled.sh` (c032b68e…) and `inner-compiled.sh` (adc749d4…), both new; `run.sh` and `run-mixed.sh` are unchanged. The harness writes only to throwaway and scratch paths, edits no repository file, and checks `.replit` unchanged.
  - Before each run, the wrapper checks that the artifact's tree hash equals `build.txt`'s, and that the base's migrations end at the expected level. For the predecessor it also checks that the checkout still matches `pred-ref-20261120/` (`node_modules` excluded).
  - It builds a throwaway test tree from the base (the active worktree for N, the predecessor checkout for the predecessor), copies the artifact in and re-checks its hash. It then writes a harness copy of the active browser test file into that tree. In the copy, three source imports are replaced by the artifact's compiled `server/entry/tenantEntry.js`, `server/persistence/supervisedPgClient.js` (createSupervisedPgClient, MAX_POOLS) and `server/platform-identity/db.js` (runtimeClientOptions). Every entry start goes through one wrapper that logs the compiled module's path, the write setting and the injected dependencies. The harness diff is `<tag>.test-harness.diff` (a061beed…, the same for both runs), and no source import of the entry remains.
  - *Injected by the test, as for the source entry:* the `construction` keys `databaseClient` (the compiled `createSupervisedPgClient` over the test's driver and the cluster's Unix socket), `tokenVerifier` (the test's verifier for its stand-in tokens) and `listen` (port 0 on 127.0.0.1). The test also supplies a test `proc` emitter (the test stops an entry by emitting `SIGTERM` on it, test :1311), an `exit` capture and a `log` capture.
  - *Shop and database.* The shop is built from a snapshot of the active worktree in both runs (`src/` 247c00df…, `ServerIssuedInvoices.tsx` 1939363d…). Each run gets its own throwaway cluster, Unix socket only, `fsync` on, in a private network namespace, migrated by the test from the base tree.
- *N run.* `bash /home/runner/workspace/.workflow/cn-p2-impl/scratch/browser/run-compiled.sh n "SCN-23" ca35-scn23-compiled-n-20261120`. The test process exited 0 after 60 s, and the wrapper exited 0; 131 tests, 1 passed, 0 failed, 130 skipped.
  - The cluster's ledger: 39 rows, `001` to `039`.
  - Resolved module: `<test tree>/dist-server-tenant/server/entry/tenantEntry.js`, sha256 63233f48…. `<test tree>` is the run's throwaway `/tmp/tmpos-cnp2-compiled.<random>/test`, removed after the run; the full path is printed in the `.out` file's `CA35 compiled module` lines. Entry starts 1 to 4 (primary `on`, the second entry `on`, the restart `off`, the restore `on`) all went through it.
  - The shop's store-wide read was answered 200, twice.
  - Files: `scratch/browser/ca35-scn23-compiled-n-20261120.{out,run.txt,snapshot.txt,test-harness.diff}` (efc259e7…, dc8b7b34…, 341e30eb…, a061beed…), and `evidence-ca35-scn23-compiled-n-20261120/` (`shop-role-levels.json` afe3c6ac…, `scb-witness.jsonl` 0c128079…).
- *Predecessor run.* `bash /home/runner/workspace/.workflow/cn-p2-impl/scratch/browser/run-compiled.sh p "SCN-23" ca35-scn23-compiled-p-20261120`. The test process exited 0 after 46 s, and the wrapper exited 0; 131 tests, 1 passed, 0 failed, 130 skipped.
  - The cluster's ledger: 38 rows, `001` to `038`, no `039`.
  - Resolved module: `<test tree>/dist-server-tenant/server/entry/tenantEntry.js`, sha256 fd709833…. Entry starts 1 to 4 went through it, in the same order.
  - The store-wide read was answered `404 not_found`, twice, by the compiled predecessor entry.
  - Files: `scratch/browser/ca35-scn23-compiled-p-20261120.{out,run.txt,snapshot.txt,test-harness.diff}` (15ede729…, b5277349…, b661c232…, a061beed…), and `evidence-ca35-scn23-compiled-p-20261120/` (`shop-role-levels.json` fab1e7dd…, `scb-witness.jsonl` 16b62b71…).
- *Observed in both runs, each an assertion that passed unless marked recorded.* These are the active run's SCN-23 assertions, unchanged.
  - (1) *Lost reply.* Register 201, proof 200, and issue 201 with the reply lost at the front. One note and registration `issued`; audits `register`, `issue`.
  - (2) *Restart with writes off.* The compiled entry was restarted with `TMPOS_CREDIT_NOTE_WRITES=off`, and its `startup_ready` line carried `creditNoteWrites: off`. The same page and database stayed, and the page still held the unresolved attempt (the session's survival is recorded below, not asserted).
  - (3) *Check again.* Exactly one issue, with the same key and body. The page received 503 `service_unavailable`, with no `idempotent-replayed` header. The entry's own log had one 503 line, with reason `credit_note_writes_disabled`. No proof or settlement was sent.
  - (4) *Look up attempt.* One lookup read (200), no write. It listed this attempt as `issued`, and the row was "Issued, not confirmed", $12.50, with Confirm credit note.
  - (5) *No duplicate writes or audits.* Still one note, and only the `register` and `issue` audits.
  - (6) *Same entry.* Every request of the page went to the primary entry.
  - (7) *Cleanup (recorded).* The entry was restored to `on`, and its startup line read `on`.
  - Recorded (each run's `shop-role-levels.json` request list): after the lost issue, the page sent only two session reads (200), the 503 issue and the lookup read. It sent no login, which shows the session survived the restart.
- *What these runs prove, and what stays open.*
  - *Proven.* The emitted JavaScript of each artifact's entry, composition, runtime and persistence served every request of the scenario, before and after each restart, over its own migration level.
  - *Not proven:* the production launch. That is `tenantMain.js`'s `main()` and its entry-point check, `PRODUCTION_CONSTRUCTION`, the production database client's TLS and host rules, the production listener, the Firebase verifier, a real `SIGTERM`, exit codes and stdout, and fresh module state on each start (the restarts reuse the loaded module). (Later the same day, `main()`, its entry-point check, the process exit code and stdout were observed for the offline configuration refusal; then, on a local synthetic TLS database stage, `PRODUCTION_CONSTRUCTION` with its database client, the production listener, a real `SIGTERM` and a fresh process per start. The app's TLS and host rules were exercised there only with a valid certificate and name, and the Firebase verifier was not exercised. See below.)
  - *Other documented built-artifact checks SCN-23 leaves open.*
    - M7TE-C1's own compiled-entry run, which does not assert the write setting.
    - The startup refusal for a build and ledger that do not match: `database_login_unsafe`, with `role_privilege_unexpected` for the predecessor build on 001..039 and `role_privilege_missing` for N on 001..038 (run through the compiled entries in-process later the same day, then through each compiled `tenantMain.js` as its own process; below).
    - The rest of CA-35: register and withdrawal refusals, and the idempotency-row, lease and credit-note-row absence under `off`, all covered at H.
    - Recording the shop build by commit SHA.
  - The active run's limits apply: point-in-time counts, the session's survival shown but not asserted, the 503 log line tied by count, and the cleanup recorded rather than asserted.
- *What these runs do not change.* CA-35 stays **UNVERIFIED**. Still pending:
  - the production-launch verification of both builds, beyond the local offline configuration refusal and the local database-stage startup run later the same day (below): Firebase sign-in and the authenticated browser flow through the real process (deferred by the owner on 2026-11-21; below), and platform verification (forced shutdown was also run locally later the same day, with a stalled connection drain; below);
  - CI on a commit;
  - the operator verification;
  - deployment.

**Local build and ledger mismatch startup checks through the compiled tenant entries (2026-11-20; owner-authorized; local built-JavaScript startup evidence, in-process, not a production launch; not CI, no commit; not the §15(b) or D-CA-11 evidence; QA and CI stay paused).**
- *The documented expectation* (§9.3.1's evidence list item 2, and the design note in the HTTP runs paragraph above). A build and a ledger that do not match refuse at the runtime-login step (step 4, `tenantEntry.ts`; PRE:402-409), before the ledger step. Each refuses with `startup_refused` and `database_login_unsafe`:
  - `role_privilege_missing` for the N-built runtime on 001..038;
  - `role_privilege_unexpected` for the predecessor build on 001..039 (039's grants are unknown to it).
  - In source, a refusal logs `startup_refused`, ends the kernel, asks to exit nonzero (`fatal_startup_refused`, 1) and returns no address. That text was source-traced on 2026-11-19 with execution pending; these runs execute it for the compiled entries, in-process.
- *What M7TE-C1's saved result covers.* `ok 16` in `scratch/pause/tenantEntry-integration-m7te16v2-active-20261120.log` (6ce793a6…) and `…-m7te16v2-pred-20261120.log` (fca9a9c7…), and in the earlier logs of both trees. It covers only the matching case: each tree's own freshly compiled entry (M7TE-C1 runs `tsc -p tsconfig.server.tenant.json` into a temporary directory) starts over that tree's own ledger, listens and serves (`tests/db/tenantEntry.integration.test.mjs` M7TE-C1, :1730 onward). It asserts no mismatch refusal and not the write setting.
- *The matching case, reused.* The compiled SCN-23 runs above reached `startup_ready` on each build's own ledger (N on 001..039, the predecessor on 001..038). They went through the same compiled steps 4 and 5.
- *Harness (new, test-only).* `scratch/browser/mismatch.mjs` (96c03922…) and `run-mismatch.sh` (c9be5258…).
  - Before each run, the wrapper checks that the artifact's tree hash equals the `build.txt` value (copied into the script as a constant), that `pred-browser-20261120/` still matches `pred-ref-20261120/` (`node_modules` excluded), and that the ledger source's migrations end at the expected level.
  - It snapshots the ledger source (the predecessor tree for 001..038, the active tree for 001..039; their 001..038 files are byte-identical, checked file by file with `cmp`), copies the other build's artifact in and re-checks both hashes.
  - In the same private network namespace, with a fresh Unix-socket cluster with `fsync` on, `mismatch.mjs` prepares the database with `setupDatabase()`'s steps (test :711-744), without its restore bookkeeping: the repository's `runTrustedApply` over that tree's migrations directory, then the runtime login and its grants, and the rate-limit, issuer and payment-proof keys.
  - It then reads the ledger: rows, first, last and a digest of `version:checksum`. It starts the artifact's compiled `tenantEntry.js` in-process with the browser test's `ENV` values (test :1258-1273), using fresh synthetic keys. The injected `databaseClient` is the compiled kernel over the cluster's socket, the `tokenVerifier` refuses every token, and the `listen` hook counts its calls.
  - It records the result and every log event, and reads the ledger again. Its verdict requires `refused` with the expected failure and reason, no `startup_ready`, no listen call, no address, a nonzero code passed to the injected `exit` callback, and an unchanged ledger. The harness process exits 0 when the verdict holds.
  - After the process exits, the wrapper reads the ledger once more and counts the namespace's listening TCP sockets.
- *N on 001..038.* `bash /home/runner/workspace/.workflow/cn-p2-impl/scratch/browser/run-mismatch.sh n ca35-mismatch-n-on-038-20261120`. Exit 0, verdict AS DOCUMENTED.
  - Artifact: `dist-server-tenant/` 1e84ca77…, `tenantEntry.js` 63233f48….
  - Ledger before and after the refusal: 38 rows, `001` to `038`, `version:checksum` digest 1cf7ffc58d5ecf2f6162ce78d25f21a899e32381725be551fe01b236f5de4978, unchanged. After the process exited it was still 38 rows, `001` to `038`.
  - Result: `refused`, `database_login_unsafe`, reasons `[role_privilege_missing]`; one `startup_refused` line at level `error`, reason `database_login_unsafe:role_privilege_missing`; events `startup_refused`, `shutdown_begin`, `shutdown_complete`; the injected `exit` callback received code 1.
  - No `startup_ready` line, the listen hook was never called, no address was returned, and the namespace had no listening TCP socket after the run (the cluster listens on its Unix socket only).
  - Files: `scratch/browser/ca35-mismatch-n-on-038-20261120.{json,out,run.txt,snapshot.txt}` (657f5847…, 0be6b155…, 0ad01e46…, 050bf0da…).
- *Predecessor on 001..039.* `bash /home/runner/workspace/.workflow/cn-p2-impl/scratch/browser/run-mismatch.sh p ca35-mismatch-p-on-039-20261120`. Exit 0, verdict AS DOCUMENTED.
  - Artifact: `dist-server-tenant/` 4f412e5c…, `tenantEntry.js` fd709833….
  - Ledger before and after: 39 rows, `001` to `039`, `version:checksum` digest 29d292b4bc4d34e23c23342006e7e5de8058b1bbff8c3efec552718324e1b2dc, unchanged. After exit it was still 39 rows, `001` to `039`.
  - Result: `refused`, `database_login_unsafe`, reasons `[role_privilege_unexpected]`; one `startup_refused` line at level `error`, reason `database_login_unsafe:role_privilege_unexpected`; the same three events; the injected `exit` callback received code 1.
  - No `startup_ready` line, the listen hook was never called, no address was returned, and there was no listening TCP socket.
  - Files: `scratch/browser/ca35-mismatch-p-on-039-20261120.{json,out,run.txt,snapshot.txt}` (a0085dd9…, acabf723…, ffc3834c…, 01d14cdd…).
- *What these checks do and do not settle.*
  - They confirm, for the compiled entries, the step-4 words the 2026-11-19 design note expected (`database_login_unsafe` with the two reasons), not the ledger codes. Whether the runbooks adopt those words is still the owner's call. (Later on 2026-11-20 the owner directed that they adopt them: §9.3's scope against 038's recovery, §9.3.1, §9.3.2's apply windows, §9.3.3 and §9.5.)
  - Not covered: the production launch (`tenantMain.js` and its own exit, the production database client). Later the same day `tenantMain.js` was run for the offline configuration refusal, and then for both of these mismatches through the production database client on a local synthetic stage, each exiting 1 (below). Also not covered: a ledger whose grants were aligned by hand (where §9.3.3 expects `migration_missing`; source-traced, not run); and the admin entry.
- *What these checks do not change.* CA-35 stays **UNVERIFIED**. Still pending:
  - the production-launch verification of both builds, beyond the local offline configuration refusal and the local database-stage startup run later the same day (below): Firebase sign-in and the authenticated browser flow through the real process (deferred by the owner on 2026-11-21; below), and platform verification (forced shutdown was also run locally later the same day, with a stalled connection drain; below);
  - CI on a commit;
  - the operator verification;
  - deployment.

**Local offline startup refusals through each compiled `tenantMain.js` (2026-11-20; owner-authorized; local built-JavaScript process evidence, configuration refusal only; not CI, no commit; not the §15(b) or D-CA-11 evidence; QA and CI stay paused).**
- *Runtime.* For each recorded build:
  - *What ran.* A byte-identical copy of its `dist-server-tenant/`, with no rebuild, run as its own process with Node v20.20.0: `node --import <counter> <copy>/dist-server-tenant/server/entry/tenantMain.js`.
    - `main()` and its entry-point check ran.
    - `PRODUCTION_CONSTRUCTION` was passed to `startTenantEntry`, but its database and listener functions were never called.
    - The exit code and stdout are the process's own.
  - *Where it ran.* In a throwaway directory, inside an unprivileged user and network namespace with no route out. The process is uid 0 inside it.
  - *Configuration.* Synthetic and fresh for each launch:
    - the keys of `tenantEntry.test.ts` `VALID_ENV` (:44-58), with their own synthetic values;
    - only `TMPOS_CREDIT_NOTE_WRITES` changed;
    - `PATH` was the only inherited variable. No database URL, Firebase credential or project secret came from the parent.
  - *Harness.* `scratch/pause/ca35-offline-20261120/run.sh` (336c88f3…) and `launch.mjs` (f2bc2fa7…), both new.
- *Artifacts.*
  - N 1e84ca77… and the predecessor (001–038) 4f412e5c…, 68 files each.
  - `tenantMain.js` 06d227a5… in both. `tenantEntry.js` 63233f48… (N) and fd709833… (predecessor).
  - During the run, the copies were checked against constants copied from `build.txt` (ed5d2194…). After the run, those constants were checked against `build.txt`'s values and found equal.
  - `package.json` was compared with `cmp`.
- *Expectation.*
  - The compiled check (`tenantEntry.js:91-95` in N, :90-94 in the predecessor) refuses:
    - an absent value with `credit_note_writes_missing`;
    - any value other than exactly `on` or `off` with `credit_note_writes_invalid`.
  - M7TU-02's table in `tenantEntry.test.ts` (:137-140) lists `ON` as invalid.
  - The refusal is `config_invalid` (`tenantEntry.js:148-150` in N, :147-149 in the predecessor), before the database client is composed.
- *Runs.* One fresh process each, in this order (`run.log` 0635b84f…):

| Build | `TMPOS_CREDIT_NOTE_WRITES` | `startup_refused` reason | Exit code | Time |
|---|---|---|---|---|
| N | unset | `config_invalid:TMPOS_CREDIT_NOTE_WRITES:credit_note_writes_missing` | 1 | 6914 ms (the first launch) |
| N | `OFF` | `config_invalid:TMPOS_CREDIT_NOTE_WRITES:credit_note_writes_invalid` | 1 | 269 ms |
| Predecessor | unset | `config_invalid:TMPOS_CREDIT_NOTE_WRITES:credit_note_writes_missing` | 1 | 284 ms |
| Predecessor | `OFF` | `config_invalid:TMPOS_CREDIT_NOTE_WRITES:credit_note_writes_invalid` | 1 | 261 ms |

- *In every run.*
  - stdout held exactly three lines: the `startup_refused` line at level `error`, then `shutdown_begin` and `shutdown_complete`, both with reason `fatal_startup_refused`.
  - There was no `startup_ready` line.
  - The counter reported Node v20.20.0 from inside the process.
  - The process's stdout and stderr hold no supplied configuration value. The result records name each case's write setting.
- *Listener and network.*
  - In each run, the preloaded main-process counter observed zero `net.Server.prototype.listen` calls and zero `net.Socket.prototype.connect` calls.
  - There was no socket-table check and no positive control for the counter.
  - Neither artifact imports `worker_threads`, `child_process`, `cluster` or `dgram`.
- *Evidence.* In `scratch/pause/ca35-offline-20261120/`, with sha256 computed after the run:
  - per case, `<n|p>-<missing|OFF>.{result.json,stdout.jsonl,stderr.txt}`:
    - results: bc26ada7…, cdd7585e…, 00438c92…, 0970a7f5…;
    - stdout: ca22c7a1…, 99eae804…, a4962cd8…, 2efa42ec…;
    - stderr: d310db2e… in all four;
  - `review-reconciliation.md` (ad8bf94e…).

  `run.log` records identical values before and after the launches:
  - `build.txt`;
  - both predecessor patches (1aa143c2…, 01a0f9dd…);
  - both artifacts' tree, `tenantMain.js` and `tenantEntry.js` hashes;
  - HEAD eb10f4c;
  - the line count and hash of the worktree's status listing (96, e7041927…). These show which files changed, not their contents.
- *Limits.*
  - The shared `node_modules` (a link to the workspace's), from which the copies loaded their dependencies, was outside the artifact hash.
  - The namespace's DNS failure was checked just before the run and is not in `run.log`.
- *What these runs settle.* For both builds, through the real compiled entry in its own process, offline:
  - an unset write setting and the value `OFF` each refuse with the exact code;
  - neither emits `startup_ready`;
  - each exits with code 1.

  This is process-level evidence for CA-35's "an invalid or absent value refuses startup" for those two inputs. The other invalid values are covered only by the source-level M7TU-02 runs above. The earlier source and in-process compiled evidence above is unchanged.
- *What these runs do not change.* CA-35 stays **UNVERIFIED**. Still pending:
  - the real-process database-stage checks: startup on the matching ledger, the mismatch refusals and their process exit, the listener, and a real `SIGTERM`.
    - When these runs were made, the existing harnesses could not reach them: the production database client's host and TLS rule blocked them (above; `scratch/pause/prod-entry-preflight-20261120.md`, d3aba8b1…), and the TLS harness was deferred.
    - Later the same day the owner authorized a scratch-only TLS harness, and these checks were run through it (the next entry).
  - Firebase sign-in and the authenticated browser flow through the real process (deferred by the owner on 2026-11-21; below);
  - platform verification;
  - CI on a commit;
  - the operator verification;
  - deployment.

**Local database-stage startup through each compiled `tenantMain.js` (2026-11-20; owner-authorized; local built-JavaScript process evidence over a synthetic TLS database host; not CI, no commit; not the §15(b) or D-CA-11 evidence; QA and CI stay paused).**
- *Two runs, both kept.* Both ran the same four cases. They are in `scratch/pause/`.
  - *The first run, historical: its grant snapshots failed.* `ca35-dbstage-20261120/` (`run.log` c3bf7b18…, `ERRATA.md` 0a59c9f3…, `SHA256SUMS` 7a9c33f9…, 60 entries).
    - Every grant snapshot hit the psql error `operator is not unique: text || "char"` at `grants.sql` line 50, and the harness hashed the error text.
    - So its `grants 5 lines sha256 94a5e6c3…` lines are not grant records; the hash is the same on both ledgers.
    - Its "ledger+grant identity unchanged" lines hold for the ledger only (`ERRATA.md` §1). It recorded no grant identity.
    - Its four process verdicts, exit codes and refusal reasons match the rerun's.
  - *The rerun, recorded here.* `ca35-dbstage-r2-20261120/` (`run.log` 7a66d34f…, `SHA256SUMS` 75231e5e…, 112 entries).
    - Its grant snapshot is corrected and checked before it is hashed. Its limits are listed below.
    - `harness.diff` (2be266de…) is its change from the first run's harness.
    - Both `SHA256SUMS` files verified with no failures before this entry was written. The results below are the rerun's.
- *Runtime.*
  - *What ran.* For each recorded build, a byte-identical copy of its `dist-server-tenant/`, with no rebuild, run as its own process with Node v20.20.0: `node --import <counter> <copy>/dist-server-tenant/server/entry/tenantMain.js`, spawned directly (no shell).
    - `main()` passed `PRODUCTION_CONSTRUCTION` (`tenantMain.ts:14-16`; no other construction can be selected there), so no construction dependency was injected or replaced: the database client, listener and shutdown were the production ones. The only addition was the preloaded counter (limits below).
    - Before each case, the copy was checked again against `build.txt` (ed5d2194…): N 1e84ca77…, the predecessor 4f412e5c…, and `tenantMain.js` 06d227a5… in both. `tenantEntry.js` is 63233f48… (N) and fd709833… (predecessor).
  - *Configuration.*
    - `NODE_ENV=production`, `PORT=4443` and `TMPOS_CREDIT_NOTE_WRITES=off`.
    - A database URL naming `db.ca35dbstage20261120.supabase.co` on port 5432, and `DATABASE_CA_CERT` set to a throwaway CA (4fb08474…).
    - Synthetic values for the other keys, the Firebase credential included. No project secret came from the parent.
  - *Where it ran.* Inside an unprivileged user, network and mount namespace with no route out. A connection to an outside address failed with `ENETUNREACH` (`isolation-inside.txt` d77c385e…).
    - The synthetic host name was mapped to 127.0.0.1 by a bind mount of `/etc/hosts` inside the namespace only.
    - The host's `/etc/hosts` was unchanged (497f0c13…).
  - *Database.* PostgreSQL 16.15 on 127.0.0.1:5432 with `ssl=on`.
    - The server certificate names the synthetic host and chains to the throwaway CA (`tls-public.txt` 1ec4b380…).
    - `pg_hba` admits the runtime login only over TLS with SCRAM. The owner connects only over the Unix socket.
    - There were two fixtures, each prepared with the repository's migration apply and the runtime login's grants:
      - A, at 001..038, from the predecessor checkout;
      - B, at 001..039, from the active worktree.
  - *Transport checks, made with `psql`, not the app* (`transport-checks.txt` 26a76a8b…).
    - A plaintext connection was refused by `pg_hba`.
    - `verify-full` against the IP address failed on the host name.
    - The system trust store failed to verify the certificate.
    - The throwaway CA with the synthetic name passed the TLS and name checks and reached SCRAM.
- *Ledger and grant snapshots.* Each fixture got a baseline before any launch, and every case got a snapshot right before and right after it.
  - *The ledger.* Its rows, first and last version, dirty flag, and a digest of `version:checksum`. It must run without gaps from 001 to the fixture's last version and be clean.
  - *The grant record.* `grants.sql` emits one line per role (its attributes), per membership and per privilege or default privilege. A privilege line names the object, grantee, privilege, grantability and grantor.
  - *How each snapshot is checked.* psql runs with `ON_ERROR_STOP=1`, and its stdout and stderr are captured separately.
    - The snapshot fails on any of these: a nonzero psql exit, any error output, empty output, a malformed or duplicate line, lines out of `LC_ALL=C` order, a missing runtime-login line, or no privilege rows for the roles the runtime login reaches.
    - A failed snapshot writes no hash, no summary and no "VALID" or "unchanged" line.
    - A failed or changed snapshot before a case stops the run before that launch. One after a case stops the matrix.
  - *Deliberate failures first* (`failclosed-demo.txt` 038af0dc…). Two snapshots were run on fixture A before any launch:
    - one with a query naming a missing column;
    - one with the first run's own `grants.sql`.

    Each made psql exit 3 and the snapshot exit 1. Neither wrote a hash file or a summary; each wrote only a `SNAPSHOT FAILED` line to `run.log`. The A baseline then succeeded.
  - *Baselines.*
    - A: 38 rows, `001` to `038`, digest 1cf7ffc5…; grant record 151 lines (19348191…).
    - B: 39 rows, `001` to `039`, digest 29d292b4…; grant record 152 lines (52562bad…).
    - Both ledger digests equal those of the in-process mismatch runs above.
  - *The 039 grant difference, expected.* It was derived from the code before the run (`expected-grant-diff.txt` b7bc6b7a…; its last write came before the first launch, which is file-time evidence only).
    - Migration 039 grants one privilege to a role the runtime login reaches: EXECUTE on `m7b_store_credit_activity(text, uuid, uuid, uuid, integer)` to `tmpos_app` (`039_m7b_store_credit_activity.up.sql:238`).
    - N's approved list carries it (PRE:145-146). The predecessor's does not.
    - So N on 001..038 refuses `role_privilege_missing` (PRE:406-409), and the predecessor on 001..039 refuses `role_privilege_unexpected` (PRE:404; :401 in the predecessor's copy).
  - *The 039 grant difference, observed* (`grant-diff-actual.txt` a0c0933e…). B minus A is exactly that one line, and nothing is removed: `+ routine|tmpos_invoice_credit_note.m7b_store_credit_activity(text,uuid,uuid,uuid,integer)|tmpos_app|EXECUTE|grantable=false|grantor=tmpos_s1b_owner`. The harness checked this match before any launch.
  - *Per case.* All eight before and after snapshots were valid: 16 records, a ledger record and a grant record each. Each record was byte-equal to its own fixture's baseline: cases 1 and 4 to B, cases 2 and 3 to A. The error output of every baseline and case snapshot is empty.
  - *What "grant record" covers.*
    - It covers privileges held by the runtime login, every role it reaches, and PUBLIC on:
      - relations, columns and routines outside `pg_catalog`, `information_schema`, `pg_toast*` and `pg_temp*` (`grants.sql` :3, :13);
      - schemas other than `pg_toast*` and `pg_temp*`;
      - the current database.
    - It also covers default privileges, role attributes and memberships.
    - It does not cover types, languages, foreign data wrappers and servers, large objects, tablespaces, parameters or `prokind`.
    - A sequence with no explicit ACL is shown with the table defaults.
    - It is that record and nothing wider (`REVIEW-NOTES.md` 9a5b9628…, item 4).
- *Runs.* One fresh process each, in this order (`run.log` 7a66d34f…):

| Case | Build and ledger | Result | Exit code | Time |
|---|---|---|---|---|
| 1 | N on 001..039 | `startup_ready`, `creditNoteWrites` `off`, `databaseClock` 2026-11-20T22:40:28.310120Z | 0, 12 ms after `SIGTERM` | ready at 10436 ms (the first launch) |
| 2 | N on 001..038 | `startup_refused`, `database_login_unsafe:role_privilege_missing` | 1 | 344 ms |
| 3 | Predecessor on 001..038 | `startup_ready`, `creditNoteWrites` `off`, `databaseClock` 2026-11-20T22:40:30.100120Z | 0, 9 ms after `SIGTERM` | ready at 427 ms |
| 4 | Predecessor on 001..039 | `startup_refused`, `database_login_unsafe:role_privilege_unexpected` | 1 | 361 ms |

- *Matching builds (cases 1 and 3).*
  - *Startup and shutdown.* stdout held `startup_ready`. After the harness sent `SIGTERM` to the process, it held `shutdown_begin` and `shutdown_complete` with reason `signal_sigterm`. The process exited 0 on its own.
  - *Listener.* When `startup_ready` appeared, `ss -Htlnp` inside the namespace showed `0.0.0.0:4443` held by the signalled node process (pid 12350 in case 1, 12680 in case 3). Port 4443 had no listener before the launch or after the exit. The counter recorded one `listen` call.
  - *TLS.* While the process was ready, `pg_stat_ssl` showed the runtime login's session from 127.0.0.1 using TLSv1.3.
- *Mismatches (cases 2 and 4).*
  - *Refusal.* stdout held one `startup_refused` line with the exact reason, then `shutdown_begin` and `shutdown_complete` (`fatal_startup_refused`). There was no `startup_ready` line, and the process exited 1.
  - *Listener.* No `ss` sample showed port 4443: 11 samples during case 2, 12 during case 4, and none after either exit. The counter recorded zero `listen` calls and one `connect` call; the counter does not record the target, which is taken to be the database connection.
- *Evidence.* In `scratch/pause/ca35-dbstage-r2-20261120/`:
  - `case<n>-<build>-on-<ledger>.{result.json,stdout.jsonl,stderr.txt}`, with results 015acdb7…, e6981a3b…, 0808a148… and 215d01b1…, and stdout c8ff346c…, d3adccff…, ca7133eb… and ffb663e2…;
  - `snapshots/`, holding every record with its own error output and, where valid, its hash. The two deliberate failures have no hash file.

  `run.log` records 17 integrity facts, identical before and after the launches (`integrity-before.txt` and `integrity-after.txt`, both f309e3f2…):
  - `build.txt` and both predecessor patches (1aa143c2…, 01a0f9dd…);
  - both artifacts' hashes;
  - Doc 18 as it was before this entry (0f562c37…);
  - HEAD eb10f4c, and the line count and hash of the worktree's status listing (96, e7041927…);
  - the host's `/etc/hosts`;
  - `pred-browser-20261120/` equal to `pred-ref-20261120/`;
  - the first run's `SHA256SUMS` (60 OK).

  Teardown (`teardown.txt` 7b4f3e8d…) left no harness process, removed both work directories, and left no listener on 5432 or 4443.
- *Limits.*
  - *TLS and host rules: no negative test of the app.* The app was not run against a bad certificate, a wrong name or a plaintext server. The refusals in `transport-checks.txt` are psql's.
  - *Listener evidence comes from socket sampling and a preloaded counter.*
    - In the matching cases, `ss` tied the port to the pid.
    - In the refusal cases, samples at intervals of 25 ms or more can miss a very brief bind.
    - The counter sees only main-process calls through `net.Server.prototype.listen` and `net.Socket.prototype.connect`.
    - Because the counter was preloaded with `--import`, the process was not entirely unmodified.
  - *Snapshot checks.*
    - Fail-closed behaviour was demonstrated only for the two deliberate psql errors above.
    - The final write of each hash file is not itself error-checked. After the run, all 20 hash files re-verified against their records.
    - A grant record missing a whole kind of line would pass validation. Both baselines hold every kind the query emits except `defacl`, which has no line in either.
  - *Grant record.*
    - It covers only the scope above.
    - The expected difference assumes that no default privilege targets the runtime login directly.
    - The expected file is pinned only by its write time.
  - *Order of writes.* A case's result file is written before its after-snapshot. Every after-snapshot was valid and unchanged.
  - *Copy and worktree checks.* The copy check hashes file contents, not file modes. The shared `node_modules` is outside the artifact hash. The worktree check uses the status listing only.
  - *Not involved.* The Firebase verifier, a browser and a real database host. Forced shutdown (the 10 s timer) was not tested in this run; it was run later the same day (the next entry).
- *What these runs settle.* For both builds, through each compiled `tenantMain.js` as its own process with the production construction, on a local synthetic database stage:
  - on its own ledger, each reached `startup_ready` with writes `off`, connected over TLSv1.3, bound its listener and exited 0 after `SIGTERM`;
  - on the other build's ledger, each refused with its exact step-4 reason, emitted no `startup_ready`, opened no observed listener and exited 1;
  - no case changed its fixture's ledger or grant record.

  This is local process evidence for CA-35's "the startup log shows the value per instance" (`off`, in both builds), and for the startup results that §9.3's evidence list item 2 relies on. The earlier source, in-process, offline and browser evidence above is unchanged.
- *What these runs do not change.* CA-35 stays **UNVERIFIED**. Still pending:
  - Firebase sign-in and the authenticated browser flow through the real process (deferred by the owner on 2026-11-21; below);
  - forced shutdown on the platform (a local run with a stalled connection drain was made later the same day, the next entry; a stall in the database close was not tested);
  - platform verification;
  - CI on a commit;
  - the operator verification;
  - deployment.

**Local forced shutdown through each compiled `tenantMain.js` (2026-11-20; owner-authorized; local built-JavaScript process evidence on the same synthetic TLS database stage; not CI, no commit; not the §15(b) or D-CA-11 evidence; QA and CI stay paused).**
- *What the build does* (`watchdog-trace.txt` 5ee09ce2…; the compiled `lifecycle.js`, `entryStartup.js`, `app.js` and `tenantMain.js` are byte-identical in both builds).
  - On `SIGTERM` the lifecycle logs `shutdown_begin` (`signal_sigterm`) and arms a referenced timer of `SHUTDOWN_FORCE_TIMEOUT_MS`, 10 000 ms (`server/runtime/lifecycle.ts:85-94`; `server/entry/entryStartup.ts:35`).
  - It then waits for the HTTP server to close, and then for the shutdown hooks (:96-98). The tenant entry's hooks abort any startup step and close the database (`server/entry/tenantEntry.ts:268-271`).
  - If the timer fires first, it logs `shutdown_forced` with reason `fatal_forced_timeout` at level `error` and exits 1. Otherwise it logs `shutdown_complete` (:104-107).
- *The stall* (`STALL.md` 56bca09d…). No app file was changed and no test hook was used.
  - *Simulated:* a slow client. After `startup_ready`, the harness opened one connection to the app's port 4443 inside the namespace, wrote a request whose header block never ends, and then wrote nothing more.
  - *Why it holds the drain:* Node 20's `server.close()` stops accepting and closes only idle connections, and a connection whose request has started is not idle. Its only remaining limit is the app's 30 s socket-inactivity timeout (`server/runtime/app.ts:218; :301`), which is longer than the 10 s timer.
  - *Checked first:* a probe on a bare server with the same limits kept `close()` pending for 12 003 ms while an interval timer kept running (`stall-probe.txt` 5b119d49…).
  - *Real:* each build's compiled `tenantMain.js`, with its own signal handler, timer, log line and exit.
  - *Observation counter:* the process carried the same preloaded `--import` counter as the earlier runs. It counts `listen` and `connect` calls and is not on the shutdown path.
- *Runs.* The harness is a copy of the database-stage rerun's (`harness.diff` 1db5f46c…), with the same namespace, TLS checks and fixtures, Node v20.20.0 and writes `off`. One fresh process per build, N first, received exactly one `SIGTERM`, sent to the pid that held port 4443.

| Build and ledger | SIGTERM → `shutdown_forced` | SIGTERM → exit | Exit code | `shutdown_complete` |
|---|---|---|---|---|
| N on 001..039 | 10 023 ms | 10 025 ms | 1, no signal | none |
| Predecessor on 001..038 | 10 014 ms | 10 016 ms | 1, no signal | none |

- *In both runs.*
  - *Before the signal:* `startup_ready` with writes `off`, and a TLSv1.3 database session for the runtime login.
  - *stdout:* exactly three lines: `startup_ready`, `shutdown_begin` (`signal_sigterm`) and `shutdown_forced` (`fatal_forced_timeout`, level `error`). By the app's own timestamps, `shutdown_begin` to `shutdown_forced` took 10 002 ms (N) and 10 003 ms (predecessor).
  - *Drain pending:* before `SIGTERM`, `ss` showed the stalled connection established on port 4443 and owned by the app's pid. In 46 of 47 samples after the signal (about 220 ms apart, up to +9.8 s), port 4443 no longer listened while an established port-4443 connection owned by the app's pid was still held. The first and last of those samples show it is the stalled client's (limits below). The client's socket closed 0 ms (N) and 1 ms (predecessor) after the process exited.
  - *After exit:* the harness did not kill either process. No process remained, and port 4443 was free.
- *Control.* The clean `SIGTERM` results of the database-stage rerun above, with no stalled connection: exit 0 after 12 ms (N) and 9 ms (predecessor), with `shutdown_complete` (`signal_sigterm`). They are cited, not rerun (`control.txt` bb73ecd2…).
- *Ledger and grants.* Before and after each case, the ledger and grant snapshots were valid and byte-equal to the fixture's baseline: B, 39 rows; A, 38 rows. The grant records are 52562bad… and 19348191…, equal to the rerun's baselines above. The 038→039 grant difference again matched its one expected entry.
- *Evidence.* In `scratch/pause/ca35-watchdog-20261120/` (`SHA256SUMS` e84c9842…, 92 entries, verified before this entry was written):
  - `run.log` 1792f56d…;
  - results 25ad7a5e… (N) and c0756af0… (predecessor), stdout ecb9e3e7… and 160930bf…;
  - `teardown.txt` 9070ccc9…;
  - `REVIEW-RECONCILIATION.md` dd323d7b…, which settles seven review findings about the harness's checks against this evidence; none changes a verdict.

  `run.log` records 18 integrity facts, identical before and after (`integrity-before.txt` and `integrity-after.txt`, both c8ea3fef…). Two earlier attempts stopped before any launch; they are kept in `attempt1-blocked-doc18/` and `attempt2-blocked-prep/`.
- *Limits.*
  - *Connection sampling.* `ss` ran about every 220 ms. The harness's check accepts any established connection on port 4443 owned by the app's pid. The samples before `SIGTERM`, and the first and last drain-pending samples, are tied to the stalled client's own port. The others record only yes or no.
  - *Timings.* They are the harness's. The app's own timestamps agree within 21 ms.
  - *Counter.* Because it was preloaded, the process was not entirely unmodified.
  - *Scope.* Only a stalled connection drain was tested. A stall in the database close (the later shutdown hook) was outside the test.
- *What these runs settle.* For both builds, through each compiled `tenantMain.js` as its own process, with the connection drain held open: one `SIGTERM` led to the build's own forced shutdown about 10 s later, with `shutdown_forced` and `fatal_forced_timeout`, no `shutdown_complete`, exit code 1, and the ledger and grants unchanged. The earlier startup and browser evidence above is unchanged.
- *What these runs do not change.* CA-35 stays **UNVERIFIED**. Still pending:
  - Firebase sign-in and the authenticated browser flow through the real process (deferred by the owner on 2026-11-21; below);
  - platform verification;
  - CI on a commit;
  - the operator verification;
  - deployment.

**Real-Firebase browser run through each compiled `tenantMain.js`: deferred by the owner (2026-11-21; not run; no waiver).**
- *The decision.* The owner deferred the supplemental run of CA-35's authenticated browser flow through each compiled `tenantMain.js` with its own Firebase verifier (N on 001–039, then the predecessor on 001–038 with the N shop). Nothing was provisioned for it and nothing ran: no Firebase account, profile or credential was created, and neither build was launched for it.
- *Preparation, kept as reference only.* An owner-run harness for that run was prepared in scratch and never run: `scratch/pause/ca35-owner-auth-20261121/` (`SHA256SUMS` 3b5f90c7…, 19 files; `OWNER-RUNBOOK.md` 94ea40dd…). It is evidence for no row.
- *What the adopted criteria require.* No adopted acceptance row, gate item or decision names Firebase or `tenantMain.js`, and none requires this supplemental run through each compiled build. Layer B is "real browser" (:900) and does not name the runtime; whether CA-35's layer B is met is not decided here, and §12 item 4 applies unchanged. The real-process authenticated flow appears only in status notes: "Not proven" at :1158 and the "Still pending" lists of the 2026-11-20 entries above. One adopted requirement does depend on a real sign-in: the verification on an authorized session at deployment (§12 item 7, :886; D-CA-16 A, §9.3.1 :586, :588-593), in which the verification tenant's owner signs in with a fresh session; in production that sign-in goes through the deployed runtime's own verifier. It is **unresolved** and stays pending as the operator verification; this deferral does not touch it. CA-48 (:952) asks for the same fresh-session check in the disposable rehearsal and does not name the identity provider. This entry records no waiver and changes no criterion.
- *What stays at its recorded scope, unchanged.* The source-level U, H and C runs; SCN-23 on the active source, the mixed run and both compiled entries in-process; and, through each compiled `tenantMain.js`, the offline configuration refusal, the database-stage startup and mismatch refusals, and the forced shutdown. Each keeps its recorded limits; none of them exercised the Firebase verifier (:1158; :1390).
- *What this does not change.* CA-35 stays **UNVERIFIED**. Still pending:
  - the supplemental run through each compiled `tenantMain.js` (deferred; it resumes only if the owner reopens it);
  - exact-commit CI (§12 item 3, :882; D-CA-11 A) and the rest of §15(b);
  - platform verification;
  - the operator verification on an authorized session at deployment (§12 item 7; D-CA-16 A), which needs a real sign-in;
  - deployment.

**Shop and browser coverage as authored (2026-11-19; written, NOT RUN).** Component tests (`src/tenant/ServerIssuedInvoices.test.tsx`, the describe "the store-wide credit activity", over the fake's store-wide route, the activity read switched on per test) are titled with the rows they cover: CA-01, 07, 11, 12, 14, 15a, 15b (layer C only), 16 (the 401 path and the 403 whose check finds the session ended), 20, 21 (the "withdraw" scan widened to this view's list only), 22, 24, 25, 26, 27 (including a view hidden by an (A) 403, which reads page 1 once after a sign-in renewal), 28, 29, 30, 31, 32 ((A); the directory read's sequence; (B2) as a CONTROLLED fake response, also after a sign-in renewal, since `renew` and `renewKeepingView` keep the picker and carry its "listed before" record over; and a credit-note press waiting for the classification, which a (B2) verdict then stops), 38, 39, 41, 42, 43, 44 and 45; the client tests (`src/tenant/invoiceIssuingClient.test.ts`, IIC-CA-07, IIC-CA-20, IIC-CA-24) pin the path, the GET, the decoder and the status mapping. Each traversal is bound at page 1 to the chosen store's tenant as the directory lists it; a later page under another tenant fails to Error. That mismatch has no UI path in the component rig, so its test pins only the bound case. Existing browser pins keep their meaning: `pickIssuedStore` waits until the chosen store's activity read has settled for that store and FAILS on timeout (opt-out `awaitActivity: false`, used only by SIS-07, which holds a response across the pick and asserts the activity outcome itself after its release); SIS-08's exact list leaves the activity chain out (`withoutActivity`) and asserts that chain separately (ONE activity GET refused, then ONE session read and ONE directory read, in order). A focused component test covers a failed Show more (429 and 503): rows and cursor cleared, page 1 after any wait. Browser scenarios SCA-01 (CA-21, 22, 24, 45), SCA-02 (CA-44, and CA-27's token change only: a second session of the same owner replaces the first in the browser's cookie store and a window focus lets the page find it; the page adopts that session's token with no sign-in request from the page, the chosen store and the activity view clear, and choosing the store again requests page 1 once under that token. Revised 2026-11-22: the first version had another tab sign in as a second store owner, but that sign-in logs the first session out, so the page signs out instead of adopting a token; the scenario timed out in CI run 45028863263, the same timeout reproduced locally, where the trace showed that sign-out), SCA-03 (CA-32 (A) and (B2), CA-42's "no further request", both CONTROLLED by a tampered request at the front) and SCA-04 (CA-15a). **Still open:** CA-15b's live same-token race and CA-32's same-token integration (no runtime path produces them, see the flag above); CA-32's "never listed in this tab" case at C (the shop sends this read only for a store its picker lists, so the rig cannot construct it); CA-42's read-only half at B (no fixture makes the directory say `readOnly`); CA-27's user change — at C the CA-27 test asserts only that the view is no longer shown right after the section is re-rendered for another user, and at B no scenario asserts it (a local diagnostic of SCA-02's original staging on 2026-11-22 only observed another tab's sign-in end the first session and remove the activity view); no test at either layer asserts that the rows are dropped and that page 1 is then requested once under the new user's session after the store is chosen again; name validation — invisible bidi and zero-width characters are accepted by the shared name check on both server and shop — left for a separate shared server-and-shop decision, not changed here; the (B2) class and its CONTROLLED tests are kept as designed; every row above until it runs.

---

## 14. Owner decisions

### Owner decisions recorded 2026-11-18

On 2026-11-18 the owner adopted revision 9 of this document as design, for documentation only. The owner's instruction, verbatim:

> "Record my design adoption of Doc 18 revision 9. This approval is for documentation only.
> 1. Record D-CA-15 B, D-CA-18 C, and A for every other D-CA decision. D-CA-18 C requires D-CA-14 A as the HTTP pause mechanism. Adopt the post-commit write-attribution log with platform-authenticated source metadata as part of that design. Carry its implementation and verification as pending.
> 2. Apply the approved Doc 17 amendment from §14.1 under D-CA-12 A. Verify the current code location for the denied state and correct the stale T citation. Keep the optional Doc 16 amendment unapplied under D-CA-3 A. Update the Phase 4 README to show Doc 18 as adopted.
> 3. Keep the database write fence and any acceptance of the no-fence residual open. A closing scan with no in-flight writes does not establish that the window is fully closed. Keep D-P2-14's production handling, implementation approval, deployment authorization, and QA and CI reopening as separate decisions."

| ID | Decided | What it means here |
|---|---|---|
| D-CA-1 | **A** | A new owner-only key (`view_store_credit_activity`); read-only and overdue tenants get 403 (§8.1; §8.3) |
| D-CA-2 | **A** | One row per credit note, withdrawal nested; no new index (§6.5) |
| D-CA-3 | **A** | Provisional N with §1 rule 2's stages; §14.2 not applied |
| D-CA-4 | **A** | A sub-section of the issued-invoices section; shell from the first request (§4.1) |
| D-CA-5 | **A** | Gross only; no tax, net or customer name (§5.2) |
| D-CA-6 | **A** | `after=<creditNoteId>`, fixed page of 50, no `limit` (§6.3) |
| D-CA-7 | **A** | 038 cutover-style apply windows for N and for every production repair (§9.3.2; §9.5); the production principal inventory is required for each (§12 item 11) |
| D-CA-8 | **A** | Every recovery pauses CN-P2 issuing first and restores it only after the read is verified (§9.3) |
| D-CA-9 | **A** | No duplicate marker (§10) |
| D-CA-10 | **A** | This slice before CN-P3 (§2.1) |
| D-CA-11 | **A** | §12 as the gate's evidence |
| D-CA-12 | **A** | A route-level denial from this read clears only this view; the §14.1 amendment is applied to D17:509 |
| D-CA-13 | **A** | Session check, then a direct store-directory read on the same token (§8.4) |
| D-CA-14 | **A** | The server write setting, as the HTTP pause mechanism D-CA-18 C requires; D only as an added first repair (§9.3.2 response (c)) |
| D-CA-15 | **B** | A "Refresh" button, plus A's re-reads (§4.3; §6.3) |
| D-CA-16 | **A** | A named verification tenant (§9.3.1) |
| D-CA-17 | **A** | Tenants stay active during a pause; unreachable only in apply windows (§9.3.2) |
| D-CA-18 | **C** | Forward-only production recovery, with D-CA-14 A as the HTTP pause mechanism; N's down only on disposable databases (§9.3) |

**Adopted as part of D-CA-18 C's design.** The post-commit write-attribution log: the `credit_note_write` line written after `commitCommand` returns (§6.6; §9.3.4), with its instance id, and the requirement that the log sink bind each line to platform-authenticated source metadata (§9.3.4). Its implementation and verification are **PENDING**; nothing of it exists in the source.

**Applied and not applied.** §14.1 is applied to D17:509 under D-CA-12 A on 2026-11-18, with the stale `T` citation corrected to T:2848-2855. §14.2 is not applied (D-CA-3 A); this adoption makes no Doc 16 edit. The Phase 4 README shows Doc 18 as adopted.

**Still OPEN after the adoption** [OPEN]. None of these is decided by it:
1. **The database write fence** (§9.3.4, the complete-window-closure dependency): a mutation-contract and operational change for separate owner approval.
2. **Acceptance of the no-fence residual** (§9.3.4). A closing scan with no in-flight writes does not establish that the window is fully closed. Check (ii) is the operational minimum for release under the adopted design, and it leaves the residual; whether release may proceed on (ii) without the fence is this open decision, so every release path that relies on (ii) is conditional on it (§9.3.2 step 9; §9.3.3 condition 6; §9.3.5 row 8).
3. **D-P2-14's production handling** (D17:808).
4. **Implementation approval**, separate from adoption (D17:806's pattern; §15).
5. **Deployment authorization** (§12 item 10).
6. **Reopening QA and CI** (both paused by the owner since 2026-11-18).
7. **The operator-confirmed values of §9.3.1**: unverified, pending.
8. **The log-sink trust base** (§9.3.4): an operational precondition, pending.

### Owner decisions recorded 2026-11-19 (two rules for the authored code; neither verifies anything)

1. **Startup database clock: fail closed** (§6.6). A failed or malformed sample refuses startup with `database_unavailable` / `startup_clock_unanswered`, before the listener binds or `startup_ready` is emitted.
2. **No write log line for a lost lease** (§9.3.4; CA-47 (p)). `transaction_lease_lost` keeps its 503 and its request log reason. `transaction_unavailable` keeps `unconfirmed`.

### The decision table (revision 9's options and recommendations, kept for the record)

Each was decidable on its own unless the 'Sections' column names another decision. Every option is stated exactly; where an option is not available, the row says so. The owner decided every row on 2026-11-18; the Decision column records it. The ids run D-CA-1 to D-CA-18 with no gap; every id is referenced in the body, in the sections the last column lists.

| ID | Question | Options | Recommendation (revision 9) | Sections that depend on it | Decision (2026-11-18) |
|---|---|---|---|---|---|
| **D-CA-1** | Which permission gates the read (§8.1; no fitting key exists) | **A** a new owner-only key (`view_store_credit_activity`, non-sensitive, Invoices `full`) in `STORE_OWNER_ONLY_ROUTE_PERMISSIONS`; it **denies read-only and overdue tenants (403)**. **B** as A, and the owner rule also admits limitation `read_only` for this one view key (a rule and load-guard change). **C** reuse `recover_invoice_credit_notes` (no catalog change; a recovery key reused for monitoring; denies read-only and overdue tenants, 403). **D** reuse `view_issued_invoices` and have the routine deny non-owners (no catalog change; authority split between catalog and routine; managers get 403 from the routine) | **A**: the cleanest authority separation. The whole decision stays in one place, the catalog's store owner rule that already decides every credit-note key (PERM:563-565), so the chain refuses non-owners before any database call and the routine's role check is a second, independent check. C would give a recovery key a monitoring meaning; D would split authority between catalog and routine; B would widen the owner rule's read-only behaviour for one key. Its cost, a 403 for read-only and overdue tenants, is low (§8.3) | §0; §3.1; §4.1; §5.1; §5.2; §5.3; §6.6; §7; §8.1; §8.2; §8.3; §8.4; §9.3; §11; §15; CA-05, CA-34, CA-42 | **A** (2026-11-18) |
| **D-CA-2** | Row model | **A** one row per credit note, newest number first, withdrawal nested; no new index. **B** an event feed: one row per event, `{ "kind": "issued" or "withdrawn", "at", "creditNoteId", "number", "invoiceId", "invoiceNumber", "grossCents", "reason", "byName" }` (for `withdrawn`, `reason` is the withdrawal reason and `byName` the withdrawing staff name); ordered by `at` descending, then `kind` (`withdrawn` before `issued`), then `creditNoteId` descending; cursor `after=<kind>:<creditNoteId>`, re-read inside the tenant and store to its (`at`, `kind`, id) anchor; a union of the two tables; two new indexes (§6.5) | **A**: duplicate issuance is an issue-time fact; the withdrawal stays visible on its note | §6.5; §9.1 | **A** (2026-11-18) |
| **D-CA-3** | Migration number and order against a 038 forward recovery and F-2 (§1). Sources conflict: D17:583 and D17:942 name 039 for this slice; D16:384 names 039 for a 038 forward recovery; D16:219 and D16:643 say "039 or after" for F-2 | **A** provisional N, with §1 rule 2's deterministic stages: (i) before commit, a needed recovery takes the next number and N follows it; (ii) committed but applied only to disposable databases, the recovery takes the slice's number and the slice is renumbered after it; (iii) applied to any managed database, N is fixed and a recovery follows it; F-2 follows all; an applied migration is never edited. **B** fix 039 for this slice now; any 038 forward recovery takes 040 (amends D16:384's wording). **C** fix 039 for a 038 forward recovery; this slice takes 040 now (amends D17:583 and D17:942's wording) | **A**: it resolves the conflict without amending either adopted text, and nothing is deployed (D17:941) | Header; §0; §1; §9; §9.4; §15; CA-18 | **A**; §14.2 not applied (2026-11-18) |
| **D-CA-4** | Shop placement and when the shell shows (§4.1) | **A** a sub-section in the issued-invoices section for the chosen store; its shell renders from the first request; hidden after a classified 403 or a skipped read (§4.1). **B** as A, but the shell renders only after the first 200 (no heading for a caller who will be refused; first-load Loading, Error, Rate limited and Session ended then show nothing). **C** a separate shop page with the same view, reached by a link from the issued-invoices section. **D** a new entry in the tenant navigation leading to that page. **E** as A, with a visible "You cannot view credit activity at this store." after a route-level denial | **A**: the skip of §4.1 removes most certain-403 traffic, so the shell rarely appears for a caller who is then refused; B hides first-load failures | §0; §4; §4.1 | **A** (2026-11-18) |
| **D-CA-5** | Fields beyond the adopted list | **A** gross only; no tax, net or customer name. **B** add tax and net. **C** add the customer name | **A**: the split is interim (D17:792); customer names widen G-PRIVACY | §5.2 | **A** (2026-11-18) |
| **D-CA-6** | Cursor form and page size (§6.3) | **A** `after=<creditNoteId>` (canonical lowercase uuid), a fixed page of 50, with no limit parameter (the credit-note family, RT:77-81; RT:668-676). **B** opaque `cursor=` with `limit` (minimum 1, maximum 50; default 50, this slice's choice; the issued-invoice list's form, whose own default is 20, ISS:55-59) | **A**: the family's parser and size; an unknown or foreign cursor is the same 400 either way | §0; §5.1; §6.3; CA-38 | **A** (2026-11-18) |
| **D-CA-7** | Deployment procedure for N, and for every production forward repair (§9.5; §9.3.2) | **A** the 038 cutover-style steps, as D17's design text says (D17:583; D16:372-380): suspend affected active tenants, stop both runtimes, NOLOGIN for every `tmpos_app` member login (so the production principal inventory is required, §12 item 11), drain count, apply, reopen with the verification tenant reactivated first. **B** a lighter procedure written as its own runbook: (1) freeze; (2) stop both runtimes (D16:376's 2(b)); no tenant suspension, no NOLOGIN and no remaining-transaction count, because N has no writer and no `LOCK TABLE`; (3) apply N under the runner's lock timeout; (4) verify the ledger 001..N and the approved grants; (5) start N-built runtimes. Under D-CA-18 C the choice also sets the shape of every repair's apply window (§9.3.2): A suspends tenants for each window, B stops the runtimes only | **A** until the owner amends D17:583; B departs from D17 §4.2's design text (adopted as design, D17:22). For a **repair**, A is the default whatever is chosen for N: B is used for a repair only when a repair-specific analysis of its locks and of what can run concurrently with it is recorded and shows B safe (§9.3.2; §9.3.5 row 10); a repair that adds a writer or a `LOCK TABLE` always needs A | §9.3.1; §9.3.2; §9.3.3; §9.5; §12 | **A** (2026-11-18) |
| **D-CA-8** | Recovery coupling with CN-P2 (§9.3) | **A** every recovery pauses CN-P2 issuing first and restores it only after the activity read is verified on an authorized session: in production by the forward-repair runbook (§9.3.2), with its evidence window (§9.3.4) and evidence list (§9.3.5), and in the 001..N-1 branch by its reopening conditions (§9.3.3); in the disposable rehearsal by step 2 and branches R1 to R3 (§9.3.7). **B** no coupling: **not available** under D-P2-13 A (D17:595), which this document cannot reopen; it becomes an option only if the owner reopens D-P2-13 separately | **A** | §0; §9.3.2; §9.3.3; §9.3.7; §12; CA-36, CA-48 | **A** (2026-11-18) |
| **D-CA-9** | A duplicate marker in the view | **A** none; facts only. **B** a text marker "Same amount and reason as CN-<m>" on a note whose invoice, gross and reason equal those of an earlier active note CN-<m> issued within 24 hours before it, by any owner, computed by the shop over the loaded rows only (so a pair split across unloaded pages is not marked) | **A** for this slice: B is a rule with false positives and misses, and the view's job is facts | §10 | **A** (2026-11-18) |
| **D-CA-10** | Order of this slice and CN-P3 (D10:1699) | **A** this slice first. **B** CN-P3 first. **C** together | **A**: it gates CN-P2's deployment; CN-P3 does not | §2.1 | **A** (2026-11-18) |
| **D-CA-11** | The gate's evidence (§12) | **A** adopt §12 as written: items 1-9, 11 and 12 as the evidence (CI as both jobs `quality` and `appsec` of the `ci` workflow on every deployed commit, run id, head SHA and per-job conclusion kept; the predecessor build and the recorded shop artifact under D-CA-14 A; the forward-repair runbook exercised and the rollback rehearsed, each on a disposable database; the production principal inventory where §12 item 11 requires it; the Doc 17 amendment adopted and applied with its rows), and item 10, which says that passing it satisfies the prerequisite and does not authorize deployment. Only A is offered: an amendment is the owner's own edit of §12, which this document cannot pre-specify | **A** | §12 | **A** (2026-11-18) |
| **D-CA-12** | Does a route-level denial from this read count toward D17 rule 4 (D17:509)? | **A** no: it clears only this sub-section's rows, cursor, names and request chain. This **amends** D17:509 ("any read or command of the section") for this one read; the exact amendment text is §14.1, to be applied to D17 only after adoption (applied to D17:509 on 2026-11-18; see the Decision column and §14.1). **B** yes, as D17:509 stands: it also clears CN-P2's owner-only names and lookup rows in the section | **A**: managers and read-only or overdue owners (under D-CA-1 A) would get it routinely; a verified context loss still applies rules 3 or 4 (§8.4); a demotion is caught by CN-P2's own answers within D17:510's accepted delay | §0; §4.1; §4.3; §8.4; §12; CA-26, CA-32 | **A**; §14.1 applied to D17:509 (2026-11-18) |
| **D-CA-13** | How the shop classifies a 403 from this read, given identical 403 bodies | **A** the one fresh session check (`recheck`, T:2663-2669), then, on the same token only, one direct store-directory read (`drafts.listStores`, T:2727) under this sub-section's own request number, never `readStores` or `denialOf`: (B0) signed out, (B1) new token, (B2) previously listed store lost, (A) still listed (cause not established), (U) either check failing (§8.4). No server change. **B** the server returns a distinct `error` word for a permission denial (a chain change at APP:955-956; departs from the identical-403 convention, RT:364-367; D17:501). **C** treat every same-token 403 as (A) and leave store loss to the section's other reads | **A**: two shipped reads, the house refusal body kept, nothing revealed the caller does not already know | §0; §4.1; §8.4; CA-32, CA-39, CA-41 | **A** (2026-11-18) |
| **D-CA-14** | How CN-P2 issuing is paused (§9.3.1). Today there is no switch (T:6541; no feature switch in T, RT, TE or the shop clients) | **A** a server write setting (`TMPOS_CREDIT_NOTE_WRITES`, §6.6), checked in the chain after authorization and before the body read and idempotency: register, issue and withdrawal (RT:7; RT:9; RT:12) answer 503, recovery routes and reads keep serving; shipped in the N-built runtime and in a predecessor build (001..N-1) deployed before N; reaches open tabs. Its limits are unchanged: HTTP-only, so direct database callers with a live key are **not** stopped (DA-93); a retry of a completed key gets 503; the rate limiter still counts the request. **B** a shop recovery-only build: reaches only new page loads, so it does **not** meet D-P2-13 A unless paired with A or D. **C** no switch, redeploy the pre-CN-P2 shop build: open tabs keep every control, a **breach** of D-P2-13 A for the pause. **D** a forward migration at the next free number revoking `tmpos_app` EXECUTE on the register, issue and withdraw routines (D16:384's lever), with the preflight's grant list changed (PRE:138-139; PRE:142): reaches open tabs and direct callers through `tmpos_app` (not the owning role, which keeps EXECUTE on every 038 routine, M38:2734-2745, nor superusers); forward-only; restoring issuance needs a further migration | **A**: it pauses issuance without a migration or an apply window, stops new register, issue and withdrawal writes from every HTTP client (settlement stays available), older tabs included, before any key, lease or routine (§9.3.1), and keeps the recovery routes and every read serving, so tenants stay active and owners keep recovering their attempts during a pause. It no longer keeps a production rollback of N (D-CA-18 C); it keeps one only in the rehearsal. It does not stop direct callers: forward repair does not remove that exposure. **D** is the forward repair that also stops direct callers through `tmpos_app`, at the cost of an apply window (§9.3.2, response (c)) | §0; §6.6; §9.3.1; §9.3.2; §9.3.3; §12; §15; CA-35, CA-36, CA-37, CA-48 | **A**, the HTTP pause mechanism D-CA-18 C requires; D only as an added first repair (§9.3.2 response (c)) (2026-11-18) |
| **D-CA-15** | When page 1 is read again (§6.3) | **A** page 1 is read again on Try again, choosing the store again, a context change, a page reload, and once after this tab's own successful issue (201) or Confirm (200) at the store; no timer. **B** as A, plus a "Refresh" button that starts a new traversal at page 1 and replaces the loaded chain. Under both, the read is live (§6.3): strict newest-number-first within a traversal, no note existing at its start skipped or repeated, notes issued during it only on a new traversal, statuses as of each page's read | **B**: an owner watching for duplicates needs a way to see new notes without re-choosing the store; it is the same operation as the own-tab re-read, which stays | §0; §4.3; §6.3; CA-38, CA-44, CA-45 | **B** (2026-11-18) |
| **D-CA-16** | How the activity read and the write refusal are verified on an authorized session (§9.3.1), in a production pause, after an apply window, and in the rehearsal (when suspended tenants cannot reach either route) | **A** a named **verification tenant**: one tenant that was `active`, named at deployment, with its store-scope `store_owner`, who, in a fresh session, checks read 200 (or 404 on the predecessor build), writes 503 with no idempotency row, lookup 200. In a production pause tenants are active, so the checks run in a fresh session of its owner, with no reactivation; if it is not usable at the runbook's start, the owner names another active tenant and owner, recorded (§9.3.2 step 1). After an apply window that suspended tenants (D-CA-7 A), and in the rehearsal (where it is the canary), it is reactivated alone first through the audited `PATCH /admin/v1/tenants/status` (TST:4; TST:12-18) on the admin entry (D16:376) by an administrator with `change_tenant_status` and a recent step-up (TST:29-33), and the other suspensions are lifted only after its checks. No new code or data. Every HTTP check stays tied to an authorized session. **B** a dedicated synthetic verification tenant, operator-owned, provisioned at deployment and never suspended: touches no real tenant, but needs a provisioning path and data this document cannot cite in the source (an operational dependency to build first). **C** surface evidence only (ledger, `startup_ready`, route inventory, setting logs, fences): no authorized-session check, so under D-P2-13 A writes may not be switched on | **A**: the only path the current source supports; B is preferable once a provisioning path exists | §9.3.1; §9.3.2; §9.3.3; §9.3.5; §9.3.7; §12; CA-36, CA-46, CA-48 | **A** (2026-11-18) |
| **D-CA-17** | Tenant access while writes are off (§9.3.2; §9.3.7; trialing tenants cannot be suspended by the audited route, TST:12-18) | **A** *Production:* tenants are not suspended for a pause; they stay active, with issuing refused and every other read and the recovery routes serving, and are unreachable only during an apply window (under D-CA-7 A until the verification tenant's checks pass and the suspensions are lifted; under D-CA-7 B from the stop to the start). *Rehearsal:* after the canary checks, lift the remaining suspensions in every branch (R1.3, R2.3, R3.5); trialing tenants are reachable from step 6. In both, direct calls by a holder of the runtime's secrets remain D-CA-18's residual. **B** as A, and also set chosen tenants, trialing included, to `read_only` by owner SQL for the pause (D16:384's lever; 038's writers require write statuses, M38:49-50): blocks direct issuance for them at the database, but these are unaudited status writes that must be restored exactly; under `read_only` the owner rule denies limitation `read_only` (PERM:564), so both the activity read (under D-CA-1 A) and the attempts lookup answer 403, settlement requires write statuses (M38:1682), and **owner recovery waits until the statuses are restored**; the verification tenant must be excluded. **C** *Production:* suspend every affected active tenant for the whole pause, until issuance is restored (their live keys stop admitting, 037:560-565, so direct issuance for them stops too; trialing tenants are not covered); *rehearsal:* keep suspensions until the activity read serves again (under R2, until R2.6), and do not roll back while any trialing tenant exists | **A**: tenants keep working and owners keep recovering during a pause; tenant downtime is limited to apply windows; B and C each trade owner access for closing part of a residual that the evidence window already detects | §9.3.2; §9.3.7; CA-36, CA-46 | **A** (2026-11-18) |
| **D-CA-18** | How production recovers from a failing activity read or a defect in N, given the direct-call residual of the runtime's secrets (DA-93): a holder of the runtime login plus the tenant session issuer key can mint a `store_owner` key for any non-suspended tenant and issue directly, past the HTTP write setting, while the read is failing or absent | **A** allow a production rollback by §9.3.7's order (N's down on the production database, with the production principal inventory, §12 item 11), and accept the residual from the runtime login's first LOGIN restore until writes go on, bounded to the holders of the runtime's secrets, with the evidence window required before writes go on. **B** as A, and close it for trialing tenants and for the verification tenant after its checks by owner-SQL `read_only` (D-CA-17 B's lever, M38:49-50); owner recovery for those tenants then waits until statuses are restored. **C** production recovery is forward-only: N's down and the coordinated rollback order run only on disposable databases (§9.3.7); in production, issuance is paused by the write setting with N still applied, the cause is repaired by a new migration at the next free number or a new build, and issuance returns only after the read is verified on an authorized session and the evidence window is classified (§9.3.2 to §9.3.5). The residual remains during a pause: it is detected by the evidence window (§9.3.4), not eliminated. C's runbook needs a pause that reaches open tabs: D-CA-14 A, with D only as an added first repair (§9.3.2 response (c)); under D-CA-14 C a pause breaches D-P2-13 A, and B alone does not meet it | **C** for production. It keeps the read in place, never removes N's objects from a managed database, needs no production fencing beyond what D-CA-7 chooses for applies, and keeps tenants active while issuance is paused. Its costs: there is no production rollback of N; a defect must be repaired forward; each repair needs a separately approved migration (or build) with its own CI and, for a migration, an apply window with tenant downtime; and the DA-93 residual during a pause stays, detected not prevented. Until CI is available again, a repair cannot meet §12 item 3 and the pause holds (§9.3.2 step 6). A and B keep a production rollback at the price of suspending every tenant, fencing every principal and leaving the read absent for a time this document cannot bound (R2) | §0; §9.2; §9.3; §12; §13; CA-47, CA-48; decided with D-CA-14 (C's runbook needs D-CA-14 A) | **C**, with D-CA-14 A as the HTTP pause mechanism; the write log with platform-authenticated source metadata adopted as design, implementation and verification PENDING; the database write fence and acceptance of the no-fence residual OPEN (§9.3.4) (2026-11-18) |

### 14.1 Doc 17 amendment under D-CA-12 A (APPLIED to Doc 17 on 2026-11-18)

**Status.** Adopted with D-CA-12 A and applied to D17:509 on 2026-11-18 on the owner's instruction, with the stale `T` citation corrected. The edit was made in D17 itself; this document records it and does not edit D17. [ADOPTED, D-CA-12 A]

D17:509 before the amendment read, in part (kept verbatim for the record): "The first answer in the section that shows it does: a 403 `forbidden` to any read or command of the section (credit-note or shipped, for example the issued list's denied state, T:1475-1480) that the one fresh session check confirms with the same token, or a credit-note list page with at least one item and no name keys after a named view (an empty page decides nothing)."

*The citation correction* (read 2026-11-18). `T:1475-1480` is D17's own citation and predates the CN-P2 candidate. In the candidate file (`src/tenant/ServerIssuedInvoices.tsx`) those lines are pay-hold handling; the issued list's denied state, the `answer.kind === 'denied'` branch of the issued list's read (it calls `denialOf`, applies rule 4 through `creditDenied`, and shows `LIST_TEXT.denied`), is T:2848-2855. The applied text cites T:2848-2855. Like every `T:` line it is candidate code and moves when the candidate changes.

Revision 9's proposed replacement (kept for the record; it kept `T:1475-1480` for the owner's edit): "The first answer in the section that shows it does: a 403 `forbidden` to any read or command of the section (credit-note or shipped, for example the issued list's denied state, T:1475-1480) that the one fresh session check confirms with the same token, **except a 403 from the store-wide credit-activity read of [18](./18-m7b-credit-activity-read-design.md), which clears only its own view unless 18 §8.4 classifies it as a verified store loss (B2), which applies this bullet**; or a credit-note list page with at least one item and no name keys after a named view (an empty page decides nothing)."

**Applied text** (the sentence as it now stands in D17:509): "The first answer in the section that shows it does: a 403 `forbidden` to any read or command of the section (credit-note or shipped, for example the issued list's denied state, T:2848-2855) that the one fresh session check confirms with the same token, **except a 403 from the store-wide credit-activity read of [18](./18-m7b-credit-activity-read-design.md), which clears only its own view unless 18 §8.4 classifies it as a verified store loss (B2), which applies this bullet**; or a credit-note list page with at least one item and no name keys after a named view (an empty page decides nothing)."

The rest of D17:509 is unchanged apart from the amendment note D17 adds to it. This document does not edit D17.

Not decided here and still OPEN elsewhere: D-P2-14's production handling (D17:808); the owner decisions O1 to O5 of D17 §8.6 (D17:932-936). O6 is closed ("closed 2026-11-18 on the owner's instruction; implemented, never run", D17:937).

### 14.2 Optional Doc 16 amendment for a 038 rollback after N (NOT APPLIED; not needed under D-CA-3 A; Doc 16 unchanged by this adoption)

**Status.** Not applied, on the owner's instruction of 2026-11-18. Under D-CA-3 A, adopted, the scope note of §9.3 settles how D16:384 reads once N is applied, so no D16 edit is required, and this adoption makes none. The text below is kept for the record only. Had the owner preferred D16 itself to carry it, three replacements in D16:384, the rest unchanged:
- "the tenant runtime stays stopped and tenants stay suspended until 039" becomes "the tenant runtime stays stopped and tenants stay suspended until that forward recovery is applied (the next free migration number, 039 unless another migration, N included, already holds it; [18](./18-m7b-credit-activity-read-design.md) §1)";
- "the admin runtime may restart only as a 038-built runtime" becomes "the admin runtime may restart only as a runtime built for the database's current ledger";
- "recover **forward** with a 039 migration" becomes "recover **forward** with a migration at the next free number".

The clean-down reading (D16:383 unavailable while N is applied) stays in this document only (§9.3 scope note): D16:383 already conditions its branch, and no D16:383 edit is proposed.

Under D-CA-3 B (not chosen), which "amends D16:384's wording" (§14), the same edit with "040" in place of the first replacement's parenthesis is the exact text that option leaves unspecified. This document does not edit D16.

---

## 15. First implementation step after adoption [PROPOSED]

Preconditions: (1) adoption with every D-CA decision recorded: **met on 2026-11-18** (revision 9; §14); (2) a separate owner approval of implementation: **not given** [OPEN] (adoption authorizes no implementation, as for D17, D17:806).

**(a) Local authoring, only after the implementation approval.** Written locally; nothing in (a) is run.
1. Re-run §1's numbering checks read-only and apply §1 rule 2 (D-CA-3) to fix N.
2. Write the database suite first, at layer D: CA-01, CA-02, CA-03, CA-04, CA-07, CA-09, CA-11, CA-17, CA-18, CA-19 and CA-40.
3. Write N's up and down (§6.1-§6.2, §6.4, §9.1, §9.2, with the down's postcondition), the preflight's ledger row, pinned checksum and grant line (§9.4), and move the three `'039'` test fixtures to N+1 (§1 rule 5).
4. Stop for review. No route, permission key, switch or shop code is written in this step; each later layer (the server route and key under D-CA-1, the D-CA-14 A setting with its predecessor build and the adopted write log line of §9.3.4, whose implementation and verification are PENDING, then the shop sub-section with its §8.4 classification) is its own step with its own acceptance rows.

**(b) Execution, which waits for the owner to reopen QA and CI** (both paused since 2026-11-18): applying N and its down on a disposable database, the disposable-database rollback rehearsal (CA-36) and forward-repair exercise (CA-48), running every test written in (a), and CI on the exact commit. Every result of (b) is recorded as **PENDING** until it runs; nothing in (a) counts as evidence.

---

## Not claimed

- That anything of this slice has run or is verified: the database and HTTP slices are authored and unrun (status, top); no shop code, no switch for CN-P2 controls and no write log line exists. No database has 039 applied; nothing is committed, pushed or deployed.
- No test, typecheck, build, migration, browser check, QA session or CI run was made for this document. Every row in §13 is PLANNED — NOT RUN. QA is deferred by the owner (2026-11-18).
- No gate changes status: 37 gates, 29 OPEN, 7 PARTIAL, 1 PASS. ICH-11 stays UNVERIFIED. CN-38 stays a deployment prerequisite. G-APPSEC stays PARTIAL and production-blocking. G-A11Y stays OPEN. F-2 and F-5 stay missing inputs. DA-132 stays OPEN.
- Not claimed: that forward repair, the write setting or any recovery path eliminates the runtime-secret exposure (DA-93): during a pause a holder of the runtime's secrets can still issue directly, and the evidence window only detects it; that issuance before the pause completed met D-P2-13 A; that a failing read is detected within any bound (no alerting exists, and no automated read-health control switches writes off; such a control would be new design, not proposed here); that a credit-note row can be attributed to an HTTP request with the current source (§9.3.4 needs a new write log line for that); that a row matched to a write log line was written by a legitimate principal or by approved code (a match proves only passage through a listed instance's HTTP chain, §9.3.4); that the evidence window closes without a residual between the closing scan and R (§9.3.4); that a closing scan with a verified absence of in-flight credit-note writes establishes that the window is fully closed (it does not; release on it without the database write fence needs the owner's acceptance of the residual, OPEN).
- Not claimed: that the write log line, its instance id or the platform-authenticated source metadata exist or have been verified (adopted as design on 2026-11-18; implementation and verification PENDING); that §9.3.1's operator values or the log sink's trust base are established (pending); that the adoption approves implementation, deployment, the database write fence, acceptance of the no-fence residual, or the reopening of QA or CI (each OPEN).
- Not claimed: that the read prevents duplicate issuance (it does not); any decision on D-P2-14; any design of CN-P3; deployment, production readiness, or any legal or tax meaning of a credit note (F-2).
- Line citations were read in this worktree on 2026-11-18. Shop line numbers are those of the uncommitted CN-P2 candidate and will move when it changes.
- *Exception (2026-11-20, startup citations only).* The PRE, TE and `server/entry/tenantEntry.ts` line numbers in §6.6's write-setting bullet (PRE:432; PRE:444), §9.3's scope against 038's recovery, §9.3.1 ("Why the runtime and the ledger move together" and evidence item 2), §9.3.2's apply windows, §9.3.3 ("Which runtime") and the 2026-11-19 design note in §13, and the `postgresStartupPreflight.test.ts:587` citation in §9.3.1, are those of the current uncommitted worktree files, read on 2026-11-20 and unchanged since 2026-11-19: `server/persistence/postgresStartupPreflight.ts` (sha256 61a41ae5bcb7350d…), `server/entry/tenantEntry.ts` (25eb71e2bae56901…) and `server/persistence/postgresStartupPreflight.test.ts` (f3e8ea61bf8a7d50…). Every other citation keeps the 2026-11-18 reference date, including TE:459 in §9.3.3, §9.3.5 and §9.3.7, which is TE:489 in the current file.
