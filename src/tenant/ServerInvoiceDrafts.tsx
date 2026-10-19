// M7B-INVOICES-P1 — the Invoices page's "Server drafts" section (design D7, R10): invoice drafts saved on the server for a
// store, over invoiceDraftsClient.ts. Choose a store (from GET /api/v1/stores), see its drafts newest first ("Load more"),
// open one read-only, and save a new one ("New server draft") for a customer saved on the server, in USD.
//
//   - Separate from this browser's invoices: a server draft never enters the local invoice list, its counters or any
//     browser storage, and nothing here offers what a draft is not (no number, no amount owed, no status but "Draft").
//   - The server decides everything. `canViewCustomers` (the customers feature and Customers View) is the local role
//     state's hint only; the server's 403 is the answer that counts.
//   - "New server draft" is offered ONLY on the server's own positive answer (M7B-INVOICES-P1-R2, DA-201): GET
//     /api/v1/stores/{storeId}/invoice-drafts/eligibility, decided by the save's own requirement. No local role state
//     (Invoices Create or Full), role name or earlier answer stands in for it. One eligibility state is kept, bound to
//     the user, the generation (its counter and token), the chosen store and the request that asked: New (and a
//     hand-over's dialog opening on its own) needs `allowed` under exactly the ones there now, so a store change, a new
//     generation or a sign-out takes the offer away at once, and an answer for an older request, store, generation or
//     user, or one arriving after a sign-out began, changes nothing. It is a read, asked only when a writable store is
//     chosen under a confirmed token and by the user's own Try again — never on a timer, a focus or a tab return; a
//     new generation clears the choice, so its own check comes with the next choice; a read-only store asks nothing.
//     Its answers: checking; allowed; denied (a 403 after the reads' one fresh check found the same token — another
//     token starts a new generation instead); unavailable (an outage, a malformed answer, a timeout: Try again, and
//     never said as a refusal); rate-limited (the section's wait, holding New and Try again back until it has passed,
//     then Try again); a 401 ends the session as any read's does. A save or a Check again the server refuses 403 takes
//     New away at its store under that session (nothing is asked again on its own; the attempt keeps the state its own
//     rule gives it), and a save's or a Check again's 429 starts the same wait (only while the session that sent it is
//     still the section's), during which a hand-over's dialog does
//     not open on its own (it opens once the wait has passed). A refusal is announced as an alert of its own; the wait
//     is said once (by the list's note when it names the same wait). The answer is a snapshot: the save still decides on its own when it commits, and an edit made elsewhere is learned only by
//     the next check or the save's refusal.
//   - The store is ALWAYS an explicit choice from the server's own list: nothing is preselected (not even a single store),
//     and this browser's store labels are never mapped to it. A read-only store lists and opens drafts but offers no new
//     one. Reads are opened by "Show server drafts": nothing is read and no session is made before that.
//   - A GENERATION is one store connection as this section knows it: a counter and the session's CSRF token, in a ref,
//     exactly as the customer picker's. `connect()` (the session client's `ensure`) runs before every list or draft read:
//     plain, `fresh` only for the one check after a 403, `reconnect` only from the Reconnect button. A different token
//     starts a new generation: reads in flight are cancelled, the stores, the choice, the drafts, the names and the
//     dialogs go, and the stores are read again. A read answer applies only under the generation, store and request that
//     started it, while the section is mounted; anything else changes nothing.
//   - Customer names come from the EXISTING customer detail read (GET /api/v1/customers/{id}, the Customers-authorized
//     tenant read), deduplicated, at most three at a time, cached for one generation only, and only while the local hint
//     says Customers View. A name that cannot be read is "Customer, ID ending xxxxxxxx"; a 403, 401 or 429 stops the name
//     reads of that generation and never fails the list.
//   - A NEW DRAFT is sent only by "Save draft", at most one POST per press, never while another is out (a ref, not a
//     render, blocks a double click). Every field is checked first (descriptions by the customer name rule with a 256
//     limit; whole quantities; dollar prices parsed EXACTLY to cents; every line and the subtotal at most 2^53-1 cents; the
//     body's exact UTF-8 bytes within the server's 64 KiB) and an invalid form mints no key and sends nothing. The customer is a server reference (customerReference.ts) chosen
//     with the picker under this session; the local invoice form can hand one over ("Save as server draft") as its id and
//     name ONLY, and this dialog confirms its own session and mints its own reference before it is used.
//   - An attempt is held BEFORE it leaves, in a module-level hold store (one per user, in memory only): its key, its exact
//     body string, its store, tenant and customer, the session token it was sent with, a monotonic and a wall-clock send
//     time. Its answer settles it BY KEY whatever happened meanwhile — a dialog closed, a page left, a generation changed:
//     a validated 201 is CREATED (a late one too), a refusal that decides the request ENDS it with its own text, anything
//     else leaves it UNRESOLVED ("Not confirmed yet"). Only "Check again" re-sends: the SAME key and the SAME bytes to the
//     hold's OWN store, only under the token it was sent with, only while max(monotonic, wall) elapsed is under 23 hours
//     (the server keeps a key for 24). Nothing re-sends on a timer, a focus, a tab return, a refresh, a navigation, a
//     read-back, a Reconnect or any session renewal. A 503 or no answer to a check stays unresolved.
//   - Only a user change, a session-token change or a sign-out DETACHES a hold (its token and body are cleared, its
//     key stays only to name it; it can never be sent again, and once no request of it is out the card says to check
//     the store's drafts). Choosing another store never detaches or re-targets it; closing the dialog (Cancel, Escape)
//     only hides it. A user change, once ServerInvoiceDrafts renders the new UID, also takes the token from another
//     user's SETTLED attempt (created, refused). A SIGN-OUT takes it from EVERY user's attempt, settled ones included,
//     at once: the hold store listens to the session client's `onSessionEnd` (bindDraftHoldsToSessionEnd), which runs
//     at the start of every logout — AccessContext.tsx starts one, without awaiting it, on every signed-out state and
//     before another user's session is used — whether or not this page is still mounted. A MOUNTED section hears it
//     too: the route guard unmounts the page only with the render after a sign-out (a DEV-only session excepted), and
//     on a direct switch to another user AccessContext.tsx keeps it mounted until that user's profile has loaded; so
//     the section ends its generation at once — the token leaves its refs, its reads out are cancelled (a created
//     draft's read-back is only ignored) and their late answers change nothing (no row, no name read), the reopen's
//     read goes, a rate limit's wait ends, the new-draft dialog and the editor close, and it says the session ended;
//     nothing is read and nobody is signed in because of it. A save or a Check again whose session was confirmed just
//     before a sign-out began sends nothing: each counts the session ends before it asks (`sessionEndsSoFar`) and
//     compares after the answer; and the sign-out forgets the picker's pair, so a customer chosen before it matches no
//     session any more.
//     The new-draft dialog's hand-over (M7B-INVOICES-P1-R2, AC-07) asks its session check only while no sign-out has
//     begun and the section's generation and token are still the ones it opened under, and uses the answer only if
//     they still are: otherwise it sets no customer and makes no context. What is scrubbed here does not wait for the server: the logout itself is best effort (a failed one leaves that
//     server session to its idle timeout). A created attempt is never read back under a later session: it says it was
//     saved under an earlier connection. A refused one still shows its own text, until Dismiss or Stop tracking.
//   - After CREATED, the draft is read back with a GET (never another POST), only under the hold's own session: "Saved"
//     when it loads, "Saved, but it could not be loaded back" when it does not.
//   - EDITING A SAVED DRAFT (M7B-INVOICES-P2). The reopen dialog offers Edit ONLY on the server's own positive answer (GET
//     …/{id}/edit-eligibility, decided by the edit's requirement), kept exactly as New's eligibility is: bound to the
//     user, the generation's counter and token, the reopen dialog's store and draft and the request that asked; asked
//     once the draft's own read answered at a writable store (and by its Try again), never on a timer or a focus; no local
//     role state stands in for it. Edit replaces the reopen dialog with the editor, seeded from the detail just read: its
//     version (what a save expects), its customer (a server reference made for the session the eligibility confirmed, in
//     the closed server-customer field; without the local Customers View hint the draft's own customer is kept as it is)
//     and its lines in order — each editable, removable and movable up or down. Cancel (or Escape) of an unsent editor
//     only drops these local changes: nothing is sent, and the draft on the server stays as it is. From Save's press until
//     its attempt is settled the working copy is locked (what the screen shows is what was sent), and closing then only
//     stops tracking the request — which the editor says.
//   - Save sends ONE PATCH per press, never while the editor's attempt is out or unresolved, during a rate limit's wait or
//     in a conflict: the attempt — its key, its exact body, its store, draft and expected version, its generation — is
//     frozen in the editor's state before it leaves. "Saved" (or, when the server changed nothing, "No changes were
//     needed") is said only after the server's 200, in the reopen dialog, which reads the draft back ONCE: a read-back
//     that fails keeps the confirmed result and says the current draft could not be read (nothing is sent again), and a
//     read-back at a later version says the draft has changed again since (a replayed answer confirms its own attempt
//     only). A conflict (the sealed 409 write_conflict) keeps the working copy, reads the server's current draft afresh and
//     shows both as text; "Reapply my changes" sends the working copy under a NEW key at the version that read found, and
//     "Discard my changes" replaces the working copy with the server's draft (local only) — neither ever happens on its
//     own. A 404 says the draft or its customer is no longer available (one text). An answer that decides nothing (a 5xx,
//     no answer, one this client cannot name) leaves the attempt UNRESOLVED: only "Check again" re-sends — the SAME key
//     and bytes to the attempt's own store and draft, under the generation it was sent in, within the 23-hour cutoff —
//     and nothing does on a focus, a tab return, a reload, a session renewal or a navigation. A 403 gets the reads' one
//     fresh check (another token is a new generation), a 401 ends the session, a 429 starts the section's wait.
//   - The editor belongs to the generation it opened in: a new generation, a session end the section learns (failSession)
//     and a sign-out (the section's `onSessionEnd` listener) close it synchronously — the closing render is committed
//     there and then (flushSync), so the working copy and the customer chosen, which live in the dialog's own state, go
//     with the held key and body and any read of it still out; a user change unmounts the section. An
//     answer arriving after that — the PATCH may still commit on the server under its old attempt — finds no attempt under
//     its key and changes nothing: no "Saved", no read-back, no name. The token is never in the editor's state: it is the
//     generation's (a ref), as for the reads.
//   - DISCARDING A SAVED DRAFT (M7B-INVOICES-DISCARD-P1). The reopen dialog offers "Discard draft…" beside Edit ONLY on
//     the server's own positive answer (GET …/{id}/discard-eligibility, decided by the discard's requirement), kept
//     exactly as Edit's: its own state, request counter and controller, asked once the draft's own read answered at a
//     writable store (and by its Try again), never on a timer, a focus or a reconnect. While it is asked, and when it is
//     refused, nothing is shown or said for it (the edit's line is the dialog's one announced answer); when it could not
//     be asked, one Try again says why. Discard draft… opens a confirmation (role=alertdialog) naming the draft from the
//     reopen read — customer, store, created time, lines, subtotal, version and its ID — with "Keep draft" (focused; it and
//     Escape close it, nothing sent) and "Discard draft": ONE POST per press, its key, exact body, store, draft, expected
//     version and generation frozen first (the token in a ref, as the edit's); Discard draft is then gone (this dialog
//     never mints a second key) and Keep draft reads "Close", which says it only stops tracking. "Draft discarded." is
//     said only after the server's validated 200 (or its sealed replay): both dialogs close, the notice is said outside
//     them, focus goes to the heading and page one is read again. A stale version reads the draft again in the reopen
//     dialog and says so; a draft no longer open or no longer there closes both and says so; a 403 (after the reads' one
//     fresh check) takes Discard draft… away; an answer that decides nothing leaves the attempt unresolved IN the
//     confirmation, where only "Check again" re-sends — the same key and bytes, under the attempt's own token and
//     generation, never during a wait, within the 23-hour cutoff. Closing it once Discard draft was pressed — its attempt
//     held, or refused — closes the reopen dialog too and reads page one again (a later discard asks the server afresh),
//     saying neither "cancelled" nor "discarded"; only one closed before that press returns to the reopen dialog. A new generation, a session end, a
//     sign-out, a store change or a user change drops the attempt and both dialogs synchronously; a late answer changes
//     nothing, and reopening never revives it.
//   - ISSUING A SAVED DRAFT (M7B-INVOICES-ISSUE-P2, docs/phase-4/12 §10, ADR-50). The reopen dialog asks the issue
//     eligibility beside the edit's and the discard's (its own slot, a writable store only) and offers "Issue invoice…",
//     in a row of its own whose height is held from the asking on, ONLY on the server's `allowed`; while it is asked and
//     when it is refused nothing is shown for it, and when it could not be asked one Try again says why. Issue invoice…
//     opens a confirmation (role=alertdialog, laid out from the top, "Keep draft" first and in its header) that reads the
//     server's issue PREVIEW — never a POST — and shows only what that read answered: the seller, the store name and
//     address, the customer, the ordered lines, Subtotal, the tax line or "No tax calculated", the Total (the exported
//     InvoiceSnapshot of ServerIssuedInvoices.tsx), never a number or a time. The preview's `expected` is the issue body,
//     serialized ONCE (issueBodyOf); "Issue invoice" is offered only while that preview is the one shown, and a review
//     read again ("Review again", after a conflict) says it is the updated invoice. One press is ONE POST under ONE new
//     key (a ref, not a render, holds a second activation back), sent only after the session, the generation, the
//     eligibility, the preview and the user's other issue attempts are checked again; the attempt — its key, its exact
//     body, its store, draft and store label, the token it went with and two send times, nothing of the invoice — is
//     held BEFORE it leaves in a module-level issue hold store (one live attempt per user, in memory only), so closing
//     the confirmation, reopening a draft, choosing another store or leaving the page never loses it. Once sent, "Keep
//     draft" reads "Close" (closing does not cancel; Escape is Close then, and closes the reopen dialog too). A validated
//     201 closes both dialogs, takes the row away and puts focus on the heading; the card outside them says "Issued.
//     Loading the invoice…", reads the invoice ONCE (a GET, never another POST; "Load details again" when it fails) for
//     "Issued as invoice {number} at {store}." (or "…at {store}; it has since been voided." when the read shows it voided:
//     the issue still committed) with "View invoice" (the exported IssuedInvoiceDialog under this section's
//     own reads) — and page one is read again. A sealed refusal is said in an alert that takes focus, each with its own
//     next step (a conflict's Review again, a closed draft's Find issued invoice); an answer that decides nothing leaves it
//     UNRESOLVED: only "Check again" re-sends — the SAME key and bytes to its own store and draft, under the token it was
//     sent with, while max(monotonic, wall) since its FIRST send is under 23 hours, judged again just before — and "Find
//     issued invoice" reads the store's issued invoices by that draft (`?sourceDraft=`, under the same token, at the
//     attempt's own store): one found settles it, none found is never said as "not issued". A sign-out, a user change or
//     a session-token change DETACHES the attempt (token and body cleared); nothing ever re-sends on its own.
//   - The session token sits only in refs, the hold store, an open new-draft dialog's state and the picker's
//     `sessionContextOf` pair (tenantSessionClient.ts lists the holders, and what a sign-out takes from each): never
//     browser storage, a URL, the DOM or a log. No key or body reaches any of those either, and draft content only the
//     DOM (the dialogs show what is typed and read back), never storage, the page's URL or a log; ids leave the page
//     only in API requests (paths, a draft id inside the list cursor, the customer id in the save's body).
//   - Dialogs (the reopen, the new draft and the editor) follow the picker's pattern: a portal, role=dialog and
//     aria-modal, the page behind made inert, Escape closing only the top dialog, Tab wrapping inside it (buttons, inputs,
//     selects, textareas), focus lost to a control the user's press removed or disabled taken back inside without
//     scrolling (never from the picker over it; a line's Remove and Move up/down keep it with the lines themselves), focus
//     returned on close. One of them at a time: the new draft never opens beside the reopen dialog or the editor, and the editor and the reopen dialog
//     replace each other (Edit, a confirmed save) — a closing dialog then leaves focus to the one that opened (its return
//     target is inert behind it). The ONE exception (M7B-INVOICES-DISCARD-P1): the discard confirmation stacks over the
//     reopen dialog, which is inert beneath it; neither the new draft nor the editor opens while it is up.
//     z-[180]: above the invoice dialogs (z-50) and below the picker it opens (z-[190]) and
//     the shop's z-[200] layers.
//   - Outside the dialogs focus never falls to <body> either (DA-199). The section tracks the control that last took
//     focus in it (`trackFocus`); a render that removes or disables it while focus is still on it (or fell from it to
//     <body>) hands focus to the section heading. So a press that takes its own control away — "Show server drafts", the
//     stores' Try again or Reconnect, the list's Try again — lands on the heading, as does any other such render: a new
//     generation, a session end, a rate limit's wait (New, Check again), a page one that drops rows, the eligibility's
//     Try again (its own press), a store change taking New away while the new store is asked. A save's refusal takes New
//     away behind its dialog, whose close then returns focus to the heading. The attempt card's Check again, Stop
//     tracking and Dismiss hand focus to the heading themselves, first. "Load more" is aria-disabled, never disabled, during its read, so it keeps focus while more
//     pages remain; when its answer takes it away, focus goes to the first row that answer added (the last page), else to
//     the heading (a failure, a reload from page one, a session end). Focus on another control or in a dialog is never
//     taken, nor is focus the user left on <body> by a press elsewhere (a press outside the tracked control ends the
//     tracking).

import {
  useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore,
  type Dispatch, type KeyboardEvent, type MutableRefObject, type ReactNode, type RefObject, type SetStateAction,
} from 'react';
import { createPortal, flushSync } from 'react-dom';
import { onSessionEnd, sessionEndsSoFar, tenantSession, type SessionResult, type TenantSessionClient } from './tenantSessionClient';
import { customers as customersClient, type CustomersClient } from './customersClient';
import {
  invoiceDrafts as draftsClient, draftBody, draftDiscardBody, draftEditBody, formatCents, lineAmounts, MAX_CENTS, MAX_DRAFT_LINES, MAX_EXPECTED_VERSION, priceText,
  type CreateDraftResult, type DiscardDraftResult, type DraftBody, type DraftDetail, type DraftLineFields, type DraftSummary, type InvoiceDraftsClient, type StoreEntry,
  type UpdateDraftResult, type UpdatedDraft,
} from './invoiceDraftsClient';
import { firebaseShopIdentity, type ShopIdentity } from './ServerCustomerLevels';
import { CHECK_CUTOFF_MS, createdText } from './ServerCustomerDirectory';
import { ServerCustomerField, idEndingText, isContextOf, pickerWaitText, sessionContextOf } from './ServerCustomerPicker';
import { serverCustomerReference, type ServerCustomerReference } from './customerReference';
import { invoiceIssuing as issuingClient, issueBodyOf, type InvoiceIssuingClient, type IssuePreview, type IssueResult } from './invoiceIssuingClient';
import { IssuedInvoiceDialog, InvoiceSnapshot, type IssuedReadAnswer } from './ServerIssuedInvoices';

const DEFAULT_WAIT_SECONDS = 60;
const NAME_READS_AT_ONCE = 3;

export const DRAFTS_TEXT = Object.freeze({
  intro: "Drafts saved on the server for one of your stores. They are kept apart from this browser's invoices.",
  storesLoading: 'Loading your stores from the server…',
  storesDenied: 'This account may not use server drafts.',
  noStores: 'No store is available to this account for server drafts.',
  chooseStore: 'Choose a store to see its drafts.',
  ended: 'Your server session ended. Reconnect to see server drafts.',
  noIdentity: 'Sign in with your store account to see server drafts.',
  refused: 'The store server did not accept this sign-in. Reconnect, or sign out and sign in again.',
  unavailable: 'Server drafts are unavailable right now.',
  listLoading: 'Loading drafts from the server…',
  listDenied: "This account may not view this store's drafts.",
  listEmpty: 'No drafts are saved on the server for this store yet.',
  reloaded: 'The list changed on the server, so it was loaded again from the start.',
  connection: 'The store connection changed, so your stores were loaded again. Choose a store.',
  readOnly: 'This store is read-only: its drafts can be opened, but no draft can be saved there.',
  lastKnown: 'Last known list — could not refresh',
  draftLoading: 'Loading this draft from the server…',
  draftNotFound: 'This draft is not available at this store.',
  draftDenied: "This account may not open this store's drafts.",
  saved: 'Draft saved on the server.',
  savedUnread: "Draft saved on the server, but it could not be loaded back. It is in this store's server drafts.",
  savedEarlier: 'A server draft was saved under an earlier connection.',
  handoff: (name: string) => `Choose a store, then "New server draft", to save a server draft for "${name}".`,
});

/** What the section says about New server draft at a writable store until the server allows it (M7B-INVOICES-P1-R2). */
export const ELIGIBILITY_TEXT = Object.freeze({
  checking: 'Checking with the server whether drafts can be saved at this store…',
  denied: 'This account may not save drafts at this store.',
  // Not an answer about the user's access: the question could not be asked.
  unavailable: 'The server could not be asked right now whether drafts can be saved at this store. Try again.',
  /** Why New server draft or this Try again is disabled during a rate limit's wait (screen readers). */
  waiting: 'Too many requests: this comes back once the wait has passed.',
});

export const DRAFT_RULE_TEXT = Object.freeze({
  customer: 'Select a customer saved on the server.',
  description: 'Enter a description of 1 to 256 characters, without control or text-direction characters.',
  quantity: 'Enter a whole quantity of 1 or more.',
  unitPrice: 'Enter a price in dollars, like 12 or 12.50, with at most two decimals.',
  total: "This line's total is too large.",
  subtotal: 'The draft subtotal is too large.',
  tooLarge: 'This draft is too large to send (over 64 KiB). Shorten the descriptions or use fewer lines.',
});

/** Said for an attempt that did not leave: nothing was sent and no key was taken. */
export const NOT_SENT_TEXT = Object.freeze({
  connection: 'Not sent: the store connection changed. Close this dialog and choose the store again.',
  customer: 'Not sent: the store connection changed. Select the customer again.',
  pending: 'Not sent: an earlier draft is not confirmed yet. Check it again or stop tracking it first.',
});

export type DraftRefusal = 'customer-not-found' | 'key-reused' | 'conflict' | 'denied' | 'signed-out' | 'invalid' | 'rate-limited';
/** What an attempt's decisive refusal says: this request did not go through. Never "saved". */
export const REFUSED_TEXT: Readonly<Record<DraftRefusal, string>> = Object.freeze({
  'customer-not-found': "Not saved: this customer isn't available for this store. Select the customer again.",
  conflict: "Not saved: this store isn't part of the tenant this draft was for any more. Choose the store again.",
  'key-reused': 'Not saved: the server rejected this request.',
  denied: 'Not saved: this account may not save drafts at this store.',
  'signed-out': 'Not saved: your server session ended. Reconnect, then save again.',
  invalid: 'Not saved: the server did not accept this draft.',
  'rate-limited': 'Not saved: too many requests. Wait a moment, then save again.',
});

export const HOLD_TEXT = Object.freeze({
  sending: 'Saving the draft on the server…',
  checking: 'Checking the draft with the server…',
  unresolved: 'Not confirmed yet: the server may have saved this draft. "Check again" sends the same request; it never makes a second draft.',
  detached: "This draft could not be confirmed: the store connection changed. Check the store's server drafts before saving it again.",
  tooOld: "Not checked: it was sent too long ago. Check the store's server drafts before saving it again.",
  stopWarning: 'Stop tracking does not cancel the request, and saving the draft again can create a second draft.',
  /** Why Save draft is disabled while an earlier attempt is held (screen readers; the card above says the rest). */
  saveBlocked: 'An earlier draft is not confirmed yet: check it again or stop tracking it before saving another.',
  /** Why Check again is disabled during a rate limit's wait (no count: nothing re-renders as the wait runs down). */
  waiting: 'Too many requests: Check again comes back once the wait has passed.',
  /** Why Save draft is disabled during a rate limit's wait (M7B-INVOICES-P1-R2: a save's 429 starts one too). */
  saveWaiting: 'Too many requests: Save draft comes back once the wait has passed.',
});

/** What the reopen dialog says about Edit until the server allows it (M7B-INVOICES-P2). */
export const EDIT_ELIGIBILITY_TEXT = Object.freeze({
  checking: 'Checking with the server whether this draft can be edited…',
  denied: 'This account may not edit drafts at this store.',
  // Not an answer about the user's access: the question could not be asked.
  unavailable: 'The server could not be asked right now whether this draft can be edited. Try again.',
  waiting: 'Too many requests: this comes back once the wait has passed.',
});

/** The editor's texts (M7B-INVOICES-P2). Never "saved" before the server's 200. */
export const EDIT_TEXT = Object.freeze({
  cancelHint: 'Cancel closes the editor and drops your changes here; the draft on the server stays as it is.',
  kept: (name: string) => `Customer: ${name} (kept as it is)`,
  saving: 'Saving your changes on the server…',
  checking: 'Checking your changes with the server…',
  unresolved: 'Not confirmed yet: the server may have saved your changes. "Check again" sends the same request; it never applies them twice.',
  tooOld: 'Not checked: it was sent too long ago. Close the editor and open the draft again to see what the server has.',
  closeWarning: 'Closing the editor stops tracking this save; the server may have saved it anyway.',
  saveHeld: 'Your last save is not confirmed yet: check it again first.',
  saveWaiting: 'Too many requests: Save comes back once the wait has passed.',
  saveConflict: 'Reapply your changes or discard them first.',
  /** A draft at the largest version the server records (2^53-1): no save can name it (expectedVersion ≤ 2^53-2). */
  saveLast: 'This draft has reached the last version the server can record, so it cannot be saved again.',
  reapplyWaiting: 'Too many requests: Reapply comes back once the wait has passed.',
  readWaiting: 'Too many requests: Try again comes back once the wait has passed.',
  conflict: 'Not saved: this draft was changed on the server after you opened it. Compare the two below, then reapply your changes to the current draft or discard them.',
  reviewLoading: 'Loading the current draft from the server…',
  gone: 'Not saved: this draft, or its customer, is no longer available.',
  /** A 403 whose one fresh session check could not answer: refused, but not said as a lack of access. */
  refusedUnchecked: 'Not saved: the server refused this save, and your session could not be checked right now. Save again in a moment.',
  checkUnchecked: 'The server refused this check, and your session could not be checked right now.',
  discarded: (version: number) => `Your changes were discarded. This is the draft as the server has it now (version ${version}).`,
  saved: (version: number) => `Saved on the server: this draft is now version ${version}.`,
  unchanged: (version: number) => `No changes were needed: the server already had this draft exactly like this (version ${version}).`,
  later: (version: number) => `It has been changed on the server again since: this is version ${version}.`,
  unread: 'Your save is confirmed, but the current draft could not be read.',
});

type EditRefusal = 'not-editable' | 'tenant-changed' | 'not-found' | 'key-reused' | 'denied' | 'invalid' | 'rate-limited';
/** What an edit attempt's decisive refusal says: this request did not go through. */
export const EDIT_REFUSED_TEXT: Readonly<Record<EditRefusal, string>> = Object.freeze({
  'not-editable': 'Not saved: this draft can no longer be edited.',
  'tenant-changed': REFUSED_TEXT.conflict,
  'not-found': EDIT_TEXT.gone,
  'key-reused': REFUSED_TEXT['key-reused'],
  denied: 'Not saved: this account may not edit drafts at this store.',
  invalid: REFUSED_TEXT.invalid,
  'rate-limited': 'Not saved: too many requests. Wait a moment, then save again.',
});
/** What the reopen dialog says about Discard draft… (M7B-INVOICES-DISCARD-P1): nothing while it is asked or refused — the edit's line is the dialog's one announced answer — and why its Try again is there when it could not be asked. */
export const DISCARD_ELIGIBILITY_TEXT = Object.freeze({
  checking: '',
  denied: '',
  unavailable: 'The server could not be asked right now whether this draft can be discarded.',
  waiting: 'Too many requests: this comes back once the wait has passed.',
});

/** The discard confirmation's texts (M7B-INVOICES-DISCARD-P1). Never "discarded" before the server's 200. */
export const DISCARD_TEXT = Object.freeze({
  title: 'Discard this draft?',
  explain: "It leaves the store's open drafts. It is not deleted, and it cannot be reopened here.",
  closeWarning: 'Closing stops tracking this discard; the server may have discarded the draft anyway.',
  sending: 'Discarding…',
  checking: 'Checking the discard with the server…',
  unresolved: 'Not confirmed yet: the server may have discarded this draft. "Check again" sends the same request; it never discards it twice.',
  tooOld: "Not checked: it was sent too long ago. Close this, then look at the store's drafts to see what the server has.",
  discarded: 'Draft discarded.',
  sendWaiting: 'Too many requests: Discard draft comes back once the wait has passed.',
  /** A draft at the largest version the server records (2^53-1): no discard can name it (expectedVersion ≤ 2^53-2). */
  last: 'Not sent: this draft has reached the last version the server can record, so it cannot be discarded.',
  /** A 403 whose one fresh session check could not answer: refused, but not said as a lack of access. */
  refusedUnchecked: 'Not discarded: the server refused this request, and your session could not be checked right now. Close this, then open the draft again in a moment.',
});

type DiscardRefusal = 'conflict' | 'not-open' | 'not-found' | 'tenant-changed' | 'key-reused' | 'denied' | 'invalid' | 'rate-limited';
/** What a discard attempt's decisive refusal says: this request did not discard the draft. */
export const DISCARD_REFUSED_TEXT: Readonly<Record<DiscardRefusal, string>> = Object.freeze({
  conflict: 'Not discarded: this draft changed since you opened it. Review it, then discard again if you still want to.',
  'not-open': 'Not discarded: this draft is no longer open.',
  'not-found': 'This draft is no longer available.',
  'tenant-changed': "Not discarded: this store isn't part of the tenant this draft was for any more. Choose the store again.",
  'key-reused': 'Not discarded: the server rejected this request.',
  denied: 'Not discarded: this account may not discard drafts at this store.',
  invalid: 'Not discarded: the server did not accept this request.',
  'rate-limited': 'Not discarded: too many requests. Close this, then open the draft again once the wait has passed.',
});
/** The answers that decide a discard's Check again (M7B-INVOICES-DISCARD-P1): its 200, a sealed 409, or a refusal that recorded nothing because nothing ran. */
const CHECK_DISCARD_DECIDES: ReadonlySet<DiscardDraftResult['kind']> = new Set(['discarded', 'conflict', 'not-open', 'tenant-changed', 'not-found', 'key-reused']);

/** The answers that decide a Check again (the key was looked at): its 200, a sealed 409, or a refusal that recorded nothing because nothing ran. */
const CHECK_DECIDES: ReadonlySet<UpdateDraftResult['kind']> = new Set(['saved', 'conflict', 'not-editable', 'tenant-changed', 'not-found', 'key-reused']);

/** What the reopen dialog says about Issue invoice… (M7B-INVOICES-ISSUE-P2): nothing while it is asked or refused, as the discard's. */
export const ISSUE_ELIGIBILITY_TEXT = Object.freeze({
  checking: '',
  denied: '',
  unavailable: 'The server could not be asked right now whether this draft can be issued.',
  waiting: 'Too many requests: this comes back once the wait has passed.',
});

/** The issued sentence around its store's name, which the card isolates in a <bdi> (merchant text); a later void is the invoice's state now, not this attempt's outcome. */
const issuedAround = (number: number, voided: boolean): readonly [string, string] => [`Issued as invoice ${number} at `, voided ? '; it has since been voided.' : '.'];
/** The issue confirmation's and the attempt card's texts (M7B-INVOICES-ISSUE-P2). Never "issued" before the server's 201 or a read. */
export const ISSUE_TEXT = Object.freeze({
  open: 'Issue invoice…',
  title: 'Issue this invoice?',
  /** The one consequence sentence that describes the confirmation: no payment, no amount due, nothing undone. */
  consequence: (total: string | null) =>
    `This issues the store's next invoice number${total === null ? '' : ` for ${total}`}; it closes the draft and cannot be changed or undone in the product. An issued invoice can later be voided, which keeps its number and contents. It does not record a payment.`,
  previewLoading: 'Loading the invoice to review from the server…',
  previewUnavailable: 'The invoice to review could not be loaded right now. Try again.',
  previewNotFound: 'This draft cannot be issued: it is no longer open at this store.',
  previewLast: 'This draft has reached the last version the server can record, so it cannot be issued.',
  previewNotConfigured: 'This store has no issuing settings yet, so nothing can be issued here. The store owner can set them up under Issued invoices → Issuing settings.',
  previewOutOfRange: 'The total is above the largest amount the server can record, so this draft cannot be issued.',
  previewDenied: 'This account may not issue invoices at this store.',
  updated: 'This is the updated invoice. Check it, then press Issue invoice.',
  closeWarning: 'Closing does not cancel: the server may still issue this invoice.',
  sending: 'Issuing the invoice on the server…',
  checking: 'Checking the issue with the server…',
  finding: 'Looking for the issued invoice…',
  unresolved: 'Not confirmed yet: the server may have issued this invoice. "Check again" sends the same request; it never issues it twice.',
  tooOld: 'Too old to check again: it was sent too long ago. Find the issued invoice, or look in Issued invoices for this store.',
  issuedLoading: 'Issued. Loading the invoice…',
  issued: (number: number, store: string, voided = false) => issuedAround(number, voided).join(store),
  issuedUnread: 'Issued. The invoice details did not load.',
  /** The card's invoice read refused 403 after its one fresh check: the refusal stands (nothing to retry). */
  issuedDenied: 'Issued. You cannot view issued invoices at this store, so the details cannot be shown here.',
  issuedEarlier: 'An invoice was issued under an earlier connection. Look for it in Issued invoices.',
  detached: 'This issue could not be confirmed: the store connection changed. Look in Issued invoices for this store before issuing the draft again.',
  findNone: 'No issued invoice found for this draft yet. This does not mean it was not issued; check again or look in Issued invoices later.',
  findDenied: 'You cannot view issued invoices at this store, so this cannot be checked here.',
  findUnavailable: 'The issued invoices could not be checked right now. Try again.',
  checkDenied: 'Access lost: the server refused this check, and that refusal stands.',
  checkUnchecked: 'The server refused this check, and your session could not be checked right now.',
  stopWarning: 'Stop tracking does not cancel the request: the server may still issue this invoice.',
  pending: 'Not sent: an earlier issue is not confirmed yet. Check it again or stop tracking it first.',
  /** The same block by a DETACHED earlier attempt, whose card offers only Dismiss. */
  pendingDetached: 'Not sent: an earlier issue could not be confirmed under an earlier connection. Look for it in Issued invoices, then dismiss it first.',
  notAllowed: 'Not sent: this account may not issue invoices at this store.',
  sendWaiting: 'Too many requests: Issue invoice comes back once the wait has passed.',
  /** Why Issue invoice is held back while its press's own session check is out (screen readers). */
  sendChecking: 'Checking your session before sending…',
  rateLimited: 'Not issued: too many requests. Wait, then press Issue invoice again.',
  /** ISSUE_REFUSED_TEXT.unchecked as the attempt card says it: the card's control is Dismiss, not the dialog's Close (review D6). */
  uncheckedCard: 'Not issued: the server refused this request, and your session could not be checked right now. Dismiss this, then open the draft again in a moment.',
  /** Why a read button waits during a rate limit's wait (screen readers). */
  waiting: 'Too many requests: this comes back once the wait has passed.',
});

export type IssueRefusal = 'not-configured' | 'conflict' | 'not-open' | 'out-of-range' | 'tenant-changed' | 'not-found' | 'invalid' | 'key-reused' | 'denied' | 'unchecked';
/** What an issue attempt's decisive refusal says: this request did not issue the invoice. Never "rolled back". */
export const ISSUE_REFUSED_TEXT: Readonly<Record<IssueRefusal, string>> = Object.freeze({
  'not-configured': 'Not issued: this store has no issuing settings. The store owner can set them up under Issued invoices → Issuing settings; then review the invoice again.',
  conflict: "Not issued: the draft, the store's issuing settings or the customer changed since this review.",
  'not-open': 'Not issued: this draft is no longer open. It may have been issued or discarded elsewhere.',
  'out-of-range': 'Not issued: the total is above the largest amount the server can record.',
  'tenant-changed': "Not issued: this store isn't part of the tenant this draft was for any more. Choose the store again.",
  'not-found': 'Not issued: this draft is no longer available at this store.',
  invalid: 'Not issued: the server did not accept this request.',
  'key-reused': 'Not issued: the server rejected this request.',
  denied: 'Not issued: this account may not issue invoices at this store.',
  /** A 403 whose one fresh session check could not answer: refused, but not said as a lack of access. */
  unchecked: 'Not issued: the server refused this request, and your session could not be checked right now. Close this, then open the draft again in a moment.',
});
/** The answers that decide an issue's Check again (the key was looked at): its 201, a sealed 409, or a refusal that recorded nothing because nothing ran. */
const CHECK_ISSUE_DECIDES: ReadonlySet<IssueResult['kind']> = new Set(['issued', 'not-open', 'not-configured', 'conflict', 'out-of-range', 'not-found', 'key-reused', 'tenant-changed']);

/** A store as the user chooses it: its name, or the end of its id; never a browser store label. */
export const storeLabel = (store: Pick<StoreEntry, 'id' | 'name'>): string =>
  store.name !== null && store.name.trim() !== '' ? store.name : `Store, ${idEndingText(store.id)}`;
/** A customer whose name could not be read. */
export const customerFallbackText = (id: string): string => `Customer, ${idEndingText(id)}`;
export const lineCountText = (n: number): string => `${n} line${n === 1 ? '' : 's'}`;
/** The DOM id of a listed draft's Open button. */
const openIdOf = (id: string): string => `drafts-open-${id}`;
/** The DOM ids of the reopen dialog's Discard draft… and Close (M7B-INVOICES-DISCARD-P1: where the confirmation hands focus back). */
const DISCARD_OPEN_ID = 'draft-discard-open';
const VIEW_CLOSE_ID = 'draft-view-close';
/** Where the confirmation hands focus back when what had it before is gone: the reopen dialog's Discard draft…, else its Close — none once that dialog has gone too (its own return then decides). */
const DISCARD_RETURN: RefObject<HTMLElement | null> = { get current() { return document.getElementById(DISCARD_OPEN_ID) ?? document.getElementById(VIEW_CLOSE_ID); } };
/** The reopen dialog's Issue invoice… (M7B-INVOICES-ISSUE-P2), and where the issue confirmation hands focus back, as DISCARD_RETURN. */
const ISSUE_OPEN_ID = 'draft-issue-open';
const ISSUE_RETURN: RefObject<HTMLElement | null> = { get current() { return document.getElementById(ISSUE_OPEN_ID) ?? document.getElementById(VIEW_CLOSE_ID); } };
/** The attempt card's View invoice: where the issued dialog hands focus back when what had it before is gone (the heading once it is gone too). */
const ISSUE_VIEW_ID = 'drafts-issue-view';

// ---------------------------------------------------------------------------------------------------------------------
// The hold store: at most one attempt per user, in memory only (never browser storage); it outlives the section across
// in-app navigation, every sign-out detaches every attempt in it, and it ends with the page load.

export interface HeldDraft {
  readonly key: string;
  /** The exact body string sent, never rebuilt; '' once it can never be sent again (detached, past the cutoff, settled). */
  readonly body: string;
  readonly storeId: string;
  readonly tenantId: string;
  readonly customerId: string;
  /** The store's label when it was sent: shown only while the attempt is still this session's. */
  readonly storeLabel: string;
  readonly lineCount: number;
  readonly subtotalCents: number;
  /** The session token it was sent with; null once detached (a user or session change). */
  readonly csrf: string | null;
  /** A monotonic reading and a wall-clock reading taken when it was sent. */
  readonly sentAt: number;
  readonly sentWall: number;
  readonly state: 'sending' | 'unresolved' | 'checking' | 'created' | 'refused';
  /** Why the last answer left it unresolved ('' for none). */
  readonly note: string;
  /** The created draft's id (state created). */
  readonly draftId: string | null;
  /** The refusal that ended it (state refused). */
  readonly refusal: DraftRefusal | null;
}

const LIVE: ReadonlySet<HeldDraft['state']> = new Set(['sending', 'unresolved', 'checking']);
export const isLiveHold = (held: HeldDraft | undefined): held is HeldDraft => held !== undefined && LIVE.has(held.state);

/** What every hold store keeps of an attempt: its key, its exact body, the token it went with and its state. */
export interface HoldBase { readonly key: string; readonly body: string; readonly csrf: string | null; readonly state: string }

export interface HoldStore<T extends HoldBase> {
  get(uid: string): T | undefined;
  /** Hold `attempt` for `uid`; false (nothing held) while that user's earlier attempt is still live. A settled one is replaced. */
  put(uid: string, attempt: T): boolean;
  /** Change the attempt under `key`; false when the store's attempt is another (a stale continuation is a no-op). */
  change(uid: string, key: string, next: Partial<Omit<T, 'key'>>): boolean;
  remove(uid: string, key: string): boolean;
  /**
   * Detach `uid`'s attempt: its token and its body go, so a live one can never be sent again, and a settled one (created,
   * refused) keeps no token either — only what its card and the "saved earlier" path need (its state, store, draft id).
   */
  detach(uid: string): void;
  /** Detach every other user's attempt, live or settled (a user change or a sign-out). */
  detachOthers(uid: string | null): void;
  subscribe(listener: () => void): () => void;
}
export type DraftHoldStore = HoldStore<HeldDraft>;

export function createDraftHoldStore(): DraftHoldStore {
  return holdStoreOf<HeldDraft>(isLiveHold);
}

/** One hold store: at most one attempt per user, `live` telling which may not be replaced (M7B-INVOICES-ISSUE-P2: shared by the issue's). */
export function holdStoreOf<T extends HoldBase>(live: (held: T | undefined) => boolean): HoldStore<T> {
  const held = new Map<string, T>();
  const listeners = new Set<() => void>();
  const tell = (): void => { for (const listener of [...listeners]) listener(); };
  const detachOne = (uid: string): boolean => {
    const current = held.get(uid);
    if (current === undefined || current.csrf === null) return false;
    const next: T = { ...current, csrf: null, body: '' };
    held.set(uid, Object.freeze(next));
    return true;
  };
  return Object.freeze({
    get: (uid: string) => held.get(uid),
    put(uid: string, attempt: T): boolean {
      if (live(held.get(uid))) return false;
      held.set(uid, Object.freeze({ ...attempt }));
      tell();
      return true;
    },
    change(uid: string, key: string, next: Partial<Omit<T, 'key'>>): boolean {
      const current = held.get(uid);
      if (current === undefined || current.key !== key) return false;
      held.set(uid, Object.freeze({ ...current, ...next }));
      tell();
      return true;
    },
    remove(uid: string, key: string): boolean {
      if (held.get(uid)?.key !== key) return false;
      held.delete(uid);
      tell();
      return true;
    },
    detach(uid: string): void { if (detachOne(uid)) tell(); },
    detachOthers(uid: string | null): void {
      let changed = false;
      for (const other of [...held.keys()]) if (other !== uid && detachOne(other)) changed = true;
      if (changed) tell();
    },
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  });
}

/**
 * Tie a hold store to the sign-out: at the start of every logout (tenantSessionClient.ts `onSessionEnd`, heard whether or
 * not a section is mounted) every user's attempt loses its session token, exactly as `detachOthers` detaches another
 * user's — an unconfirmed one its body too, so it can never be sent again (its key stays only to name it). Returns the
 * unbinding.
 */
export function bindDraftHoldsToSessionEnd(holds: Pick<HoldStore<HoldBase>, 'detachOthers'>): () => void {
  return onSessionEnd(() => holds.detachOthers(null));
}

/** The shop's one draft hold store, scrubbed at every sign-out. */
const draftHolds: DraftHoldStore = createDraftHoldStore();
const unbindDraftHolds = bindDraftHoldsToSessionEnd(draftHolds);
import.meta.hot?.dispose(unbindDraftHolds); // a hot reload replaces this module: its listener goes with its store

/**
 * One issue attempt (M7B-INVOICES-ISSUE-P2), held BEFORE it leaves: only what Check again and Find need — never the
 * invoice's seller, customer, lines or amounts. Detached (a user change, a sign-out, a token change) is `csrf` null.
 */
export interface HeldIssue {
  readonly key: string;
  /** The exact body string sent, never rebuilt; '' once it can never be sent again (detached, past the cutoff, settled). */
  readonly body: string;
  readonly storeId: string;
  readonly draftId: string;
  /** The store's label when it was sent: shown only while the attempt is still this session's. */
  readonly storeLabel: string;
  /** The session token it was sent with; null once detached. */
  readonly csrf: string | null;
  /** A monotonic and a wall-clock reading taken at the FIRST send: Check again never moves them. */
  readonly sentAt: number;
  readonly sentWall: number;
  readonly state: 'sending' | 'unresolved' | 'checking' | 'issued' | 'refused';
  /** Why the last answer left it unresolved, or what Find found ('' for none). */
  readonly note: string;
  /** The issued invoice (state issued), and its number once a read has shown it. */
  readonly invoiceId: string | null;
  readonly number: number | null;
  /** Whether the last read that showed the invoice said it is voided now (its current state, never this attempt's outcome). */
  readonly voided: boolean;
  /** The refusal that ended it (state refused); or, issued, its invoice's read refused for good ('denied', after its one fresh check: kept with the attempt, so a section mounted again reads nothing). */
  readonly refusal: IssueRefusal | null;
}
export type IssueHoldStore = HoldStore<HeldIssue>;
const LIVE_ISSUE: ReadonlySet<HeldIssue['state']> = new Set(['sending', 'unresolved', 'checking']);
export const isLiveIssue = (held: HeldIssue | undefined): held is HeldIssue => held !== undefined && LIVE_ISSUE.has(held.state);
/** What a new issue held back by the user's live attempt says: a detached one can only be dismissed. */
const pendingTextOf = (held: HeldIssue | undefined): string => (held?.csrf === null ? ISSUE_TEXT.pendingDetached : ISSUE_TEXT.pending);
export function createIssueHoldStore(): IssueHoldStore {
  return holdStoreOf<HeldIssue>(isLiveIssue);
}
/** The shop's one issue hold store, scrubbed at every sign-out as the draft one. */
const issueHolds: IssueHoldStore = createIssueHoldStore();
const unbindIssueHolds = bindDraftHoldsToSessionEnd(issueHolds);
import.meta.hot?.dispose(unbindIssueHolds);

/** Why an issue answer left the attempt unresolved. Never "not issued": only a decisive answer for the same key says that. */
function issueReasonOf(answer: IssueResult): string {
  switch (answer.kind) {
    case 'in-progress': return 'The server is still working on it. Check again in a moment.';
    case 'signed-out': return 'Sign-in needed: your server session ended. Reconnect, then check again.';
    case 'rate-limited': return `Too many requests. ${waitHint(answer.retryAfterSeconds)}`;
    case 'invalid': return 'The server did not accept this check.';
    case 'unknown': return answer.responded ? 'The server answered, but not with a result.' : 'No answer from the server.';
    default: return 'The server answered, but not with a result.';
  }
}

/**
 * One issue answer, reconciled BY KEY in the hold store whatever dialog or section is (or is not) there now. `first` is
 * the attempt's first send: a 201 issues it; a 401 or a 429 was refused before the key was acquired, so the attempt goes
 * (a new press is a new key); every other answer but unknown and in-progress decides it. A Check again re-sends a key
 * that may already have committed, so only CHECK_ISSUE_DECIDES do. A 403 is the section's to decide (its one fresh
 * check), so it is never settled here.
 */
export function settleIssue(holds: IssueHoldStore, uid: string, key: string, answer: IssueResult, first: boolean): void {
  const held = holds.get(uid);
  if (held === undefined || held.key !== key || answer.kind === 'denied') return;
  if (answer.kind === 'issued') {
    holds.change(uid, key, { state: 'issued', invoiceId: answer.invoiceId, body: '', note: '' });
    return;
  }
  if (first && (answer.kind === 'signed-out' || answer.kind === 'rate-limited')) {
    holds.remove(uid, key);
    return;
  }
  const decisive = first ? answer.kind !== 'unknown' && answer.kind !== 'in-progress' : CHECK_ISSUE_DECIDES.has(answer.kind);
  if (decisive) {
    holds.change(uid, key, { state: 'refused', refusal: answer.kind as IssueRefusal, body: '', note: '' });
    return;
  }
  holds.change(uid, key, { state: 'unresolved', note: issueReasonOf(answer) });
}

const waitHint = (seconds: number): string => `Wait ${seconds} second${seconds === 1 ? '' : 's'}.`;

/** Why an answer left the attempt (a create's or an edit's) unresolved. Never "not saved": only a decisive answer for the same key says that. */
function reasonOf(answer: CreateDraftResult | UpdateDraftResult | DiscardDraftResult): string {
  switch (answer.kind) {
    case 'in-progress': return 'The server is still working on it. Check again in a moment.';
    case 'signed-out': return 'Sign-in needed: your server session ended. Reconnect, then check again.';
    case 'denied': return 'The server refused this check.';
    case 'rate-limited': return `Too many requests. ${waitHint(answer.retryAfterSeconds)}`;
    case 'invalid': return 'The server did not accept this check.';
    case 'unknown': return answer.responded ? 'The server answered, but not with a result.' : 'No answer from the server.';
    default: return 'The server answered, but not with a result.';
  }
}

/**
 * One create answer, reconciled BY KEY in the hold store — whatever page, dialog or generation is (or is not) there now.
 * `first` is the attempt's first send: every refusal of a first send decides it (nothing can have run before it). A
 * check re-sends a key that may already have committed, so only the answers that come after the key was looked at
 * decide it: the sealed customer_not_found, write_conflict and idempotency_key_reused. Everything else stays unresolved.
 */
export function settleDraft(holds: DraftHoldStore, uid: string, key: string, answer: CreateDraftResult, first: boolean): void {
  const held = holds.get(uid);
  if (held === undefined || held.key !== key) return;
  if (answer.kind === 'created') {
    holds.change(uid, key, { state: 'created', draftId: answer.draft.id, body: '', note: '' });
    return;
  }
  const kind = answer.kind;
  const decisive = first
    ? kind !== 'unknown' && kind !== 'in-progress'
    : kind === 'customer-not-found' || kind === 'conflict' || kind === 'key-reused';
  if (decisive) {
    holds.change(uid, key, { state: 'refused', refusal: kind as DraftRefusal, body: '', note: '' });
    return;
  }
  holds.change(uid, key, { state: 'unresolved', note: reasonOf(answer) });
}

// ---------------------------------------------------------------------------------------------------------------------
// The dialog frame shared by the reopen, the new draft and the editor dialogs (exported with the class constants for the
// issued invoices section, M7B-INVOICES-ISSUE-P2: the same look, no change in behaviour).

export const focusRing = 'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-700';
export const button = `px-4 py-2 bg-primary text-white text-xs font-black uppercase tracking-widest rounded-xl disabled:opacity-50 disabled:cursor-not-allowed ${focusRing}`;
export const quiet = `px-4 py-2 bg-white text-primary border border-slate-300 text-xs font-black uppercase tracking-widest rounded-xl disabled:opacity-50 disabled:cursor-not-allowed ${focusRing}`;
export const hintClass = 'text-[11px] font-medium text-slate-500';
export const inputClass = `w-full text-sm px-3 py-2 rounded-lg border border-slate-300 bg-white ${focusRing}`;
export const labelClass = 'block text-[10px] font-black text-slate-500 uppercase tracking-widest';
// [tabindex="0"]: the reopen dialog's lines region (M7B-INVOICES-DISCARD-P1-R1), the only such element in these dialogs.
const STOPS = 'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex="0"]';

export interface DialogFrameProps {
  readonly labelledBy: string;
  /** 'alertdialog' for the discard confirmation (M7B-INVOICES-DISCARD-P1); every other dialog is a 'dialog'. */
  readonly role?: 'dialog' | 'alertdialog';
  /** The id of the ONE element that describes the dialog (aria-describedby), when it has one. */
  readonly describedBy?: string;
  readonly testId: string;
  /**
   * 'top' lays the dialog out from a fixed offset (5vh) below the viewport's top instead of centring it
   * (M7B-INVOICES-DISCARD-P1-R1): content that arrives below its header after it opened — the reopen dialog's late
   * eligibility answers, wrapped at a narrow width or an enlarged text size — then extends it downward and never moves
   * its Close. A centred dialog moves its top by half of any growth. Every other dialog stays centred.
   */
  readonly anchor?: 'center' | 'top';
  readonly busy?: boolean;
  readonly onClose: () => void;
  /** Where focus goes when the dialog opens (the dialog itself when null). */
  readonly initialFocus?: RefObject<HTMLElement | null>;
  /** Where focus goes when the dialog closes, when the element that had it before is gone. */
  readonly returnFocus?: RefObject<HTMLElement | null>;
  readonly children: ReactNode;
}

export function DialogFrame({ labelledBy, role = 'dialog', describedBy, testId, anchor = 'center', busy = false, onClose, initialFocus, returnFocus, children }: DialogFrameProps) {
  const overlay = useRef<HTMLDivElement | null>(null);
  const dialog = useRef<HTMLDivElement | null>(null);
  const opener = useRef<HTMLElement | null>(null);
  const close = useRef(onClose);
  useLayoutEffect(() => { close.current = onClose; });

  // The page behind is inert while the dialog is open, as the picker's: only the nodes THIS dialog made inert are restored.
  useLayoutEffect(() => {
    const own = overlay.current;
    const made = [...document.body.children].filter((node) => node !== own && !node.hasAttribute('inert'));
    for (const node of made) node.setAttribute('inert', '');
    return () => { for (const node of made) node.removeAttribute('inert'); };
  }, []);

  // Focus moves in on open and goes back on close: to what had it before, or to `returnFocus` when that is gone. What had
  // it before is taken ONCE, from outside the dialog: StrictMode's second setup finds focus already in it (the ref keeps
  // the first).
  useEffect(() => {
    const at = document.activeElement;
    if (opener.current === null && at instanceof HTMLElement && !(dialog.current?.contains(at) ?? false)) opener.current = at;
    const before = opener.current;
    (initialFocus?.current ?? dialog.current)?.focus();
    return () => {
      // After the commit that removed the dialog (and its inert marks): what had focus before, unless it is gone or
      // disabled meanwhile (New server draft while an attempt is unconfirmed), else `returnFocus`.
      setTimeout(() => {
        // Never into an inert page: when another dialog has opened in this one's place (Edit, a confirmed save), focus
        // is that dialog's.
        const usable = (node: HTMLElement | null | undefined): node is HTMLElement =>
          node != null && node.isConnected && node !== document.body && !(node as HTMLButtonElement).disabled && node.closest('[inert]') === null;
        const target = usable(before) ? before : returnFocus?.current;
        if (usable(target)) target.focus();
      }, 0);
    };
    // One dialog per open: its targets are fixed for its life.
  }, []);

  /**
   * Focus never falls out of the open dialog (as the picker's search box takes it back): a control the user's own press
   * removes or disables while it has focus — Save draft while it saves, Check again and Stop tracking while a check runs,
   * a line's Remove — leaves focus on <body> (or on the disabled control, until the browser moves it there), where Escape
   * and Tab no longer reach this dialog. After every render, focus that is LOST that way goes to `initialFocus` (when it
   * is still there and enabled), else to the dialog itself — without scrolling: the dialog body scrolls (90vh), the
   * pressed control and the attempt's card sit below the lines, and a default focus() would jump a long form to its top
   * exactly when that card matters. Never taken from anywhere else, and only while this dialog is the top one: the
   * customer picker opened from it makes this overlay inert (its own layout effect), so focus inside the picker — or on
   * <body> between the picker's close and its field's own focus return — is left alone. (A line's Remove hands focus to
   * its neighbour itself, before its line goes: see NewDraftDialog.)
   */
  useEffect(() => {
    const own = dialog.current;
    if (own === null || overlay.current === null || overlay.current.hasAttribute('inert')) return;
    const at = document.activeElement;
    // :disabled, not the property: a control inside a disabled fieldset (the editor's working copy while a save is out)
    // cannot hold focus either.
    const disabled = (node: Element | null): boolean => node?.matches(':disabled') === true;
    const lost = at === null || at === document.body || (own.contains(at) && disabled(at));
    if (!lost) return;
    const first = initialFocus?.current;
    (first != null && first.isConnected && own.contains(first) && !disabled(first) ? first : own).focus({ preventScroll: true });
  });

  /**
   * Escape closes THIS dialog only (a picker opened from it handles its own Escape and stops it); Tab and Shift+Tab wrap
   * around its enabled controls. A key from a nested dialog (the picker, a React child in another portal) is not ours.
   */
  function onKeyDown(e: KeyboardEvent<HTMLDivElement>): void {
    if (dialog.current === null || !(e.target instanceof Node) || !dialog.current.contains(e.target)) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close.current();
      return;
    }
    if (e.key !== 'Tab') return;
    // :disabled too: a control inside a disabled fieldset (the editor's locked working copy) is no stop.
    const stops = [...dialog.current.querySelectorAll<HTMLElement>(STOPS)].filter((stop) => !stop.matches(':disabled'));
    if (stops.length === 0) { e.preventDefault(); return; }
    const first = stops[0];
    const last = stops[stops.length - 1];
    const at = document.activeElement;
    if (!stops.some((stop) => stop === at)) { e.preventDefault(); (e.shiftKey ? last : first).focus(); }
    else if (e.shiftKey && at === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && at === last) { e.preventDefault(); first.focus(); }
  }

  // 'top': 5vh above and below, so the 90vh panel still fits whole and scrolls inside itself as a centred one does.
  return createPortal(
    <div
      ref={overlay}
      onMouseDown={(e) => { if (e.target === e.currentTarget) e.preventDefault(); }}
      className={`fixed inset-0 z-[180] flex justify-center bg-slate-900/40 ${anchor === 'top' ? 'items-start px-4 py-[5vh]' : 'items-center p-4'}`}
    >
      <div
        ref={dialog}
        role={role}
        aria-modal="true"
        aria-labelledby={labelledBy}
        aria-describedby={describedBy}
        aria-busy={busy}
        data-testid={testId}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        className="w-full max-w-2xl max-h-[90vh] overflow-y-auto bg-white rounded-3xl border border-slate-200 shadow-2xl p-6 space-y-4 focus:outline-none"
      >
        {children}
      </div>
    </div>,
    document.body,
  );
}

// ---------------------------------------------------------------------------------------------------------------------
// The section.

export interface ServerInvoiceDraftsProps {
  /** The signed-in shop user's UID, or null: nothing is shown without one. */
  readonly uid: string | null;
  /** The local role state's hint that this user may view server customers (the customers feature and Customers View). */
  readonly canViewCustomers: boolean;
  /** A server customer the invoice form handed over (its id and name only), or null. */
  readonly handoff: { readonly id: string; readonly name: string } | null;
  /** The hand-over was taken (the section keeps it from here). */
  readonly onHandoffTaken: () => void;
  readonly session?: TenantSessionClient;
  readonly drafts?: InvoiceDraftsClient;
  readonly customers?: CustomersClient;
  readonly identity?: Pick<ShopIdentity, 'idToken'>;
  readonly holds?: DraftHoldStore;
  /** The issuing routes' client (M7B-INVOICES-ISSUE-P2: the issue eligibility, preview and POST, the issued reads). */
  readonly issuing?: InvoiceIssuingClient;
  readonly issueHolds?: IssueHoldStore;
  /** A monotonic clock in milliseconds (default `performance.now()`). */
  readonly now?: () => number;
  /** The wall clock in milliseconds (default `Date.now()`). */
  readonly wallNow?: () => number;
  /** A new Idempotency-Key (default `crypto.randomUUID()`). */
  readonly newKey?: () => string;
}

/** One section per signed-in user (keyed by UID): nothing a previous user's reads answer ever reaches it. */
export function ServerInvoiceDrafts(props: ServerInvoiceDraftsProps) {
  const holds = props.holds ?? draftHolds;
  const issues = props.issueHolds ?? issueHolds;
  // A user change or a sign-out detaches every other user's attempt: it can never be sent again from here. In the same
  // commit that ends the earlier user's section (a layout effect, review D1): a passive one runs after the browser may
  // have delivered that section's late answer, which would then still settle its attempt.
  useLayoutEffect(() => { holds.detachOthers(props.uid); issues.detachOthers(props.uid); }, [holds, issues, props.uid]);
  if (props.uid === null) return null;
  return <DraftsSection key={props.uid} {...props} uid={props.uid} holds={holds} issueHolds={issues} />;
}

type Phase = 'idle' | 'loading' | 'ready' | 'denied' | 'signed-out' | 'rate-limited' | 'unavailable';
interface StoresState { readonly phase: Phase; readonly text: string; readonly stores: readonly StoreEntry[] }
interface ListState {
  readonly gen: number;
  readonly storeId: string; // the store these rows answer ('' for none)
  readonly phase: Phase;
  readonly text: string;
  readonly rows: readonly DraftSummary[]; // in arrival order (the server's newest-first order); never re-sorted
  readonly next: string | null;
  readonly note: string;
  /** The wait a rate-limited note says (`waitSeq`), 0 for none: a wait is said once only when two notes name the same one. */
  readonly waitId: number;
}
/** `saved`: the edit the server confirmed just before this read (M7B-INVOICES-P2), said above what the read-back shows. */
interface ReopenState {
  readonly id: string; readonly storeId: string; readonly phase: Phase | 'not-found'; readonly text: string; readonly draft: DraftDetail | null;
  readonly saved: UpdatedDraft | null;
  /** Why a discard of this draft did not go through (M7B-INVOICES-DISCARD-P1: a stale version, a 403), said as an alert here; '' for none. */
  readonly refused: string;
}
/** `n`, `csrf` and `since`: the section's generation and `sessionEndsSoFar()` when the dialog opened (AC-07, the hand-over's checks). */
interface NewDraftState {
  readonly store: StoreEntry; readonly csrf: string; readonly n: number; readonly since: number;
  readonly handoff: { readonly id: string; readonly name: string } | null;
}
/**
 * The server's answer about New server draft (M7B-INVOICES-P1-R2) — or, with a `draftId`, about Edit in the reopen dialog
 * (M7B-INVOICES-P2) — with everything it was asked under: the user, the generation's counter and token, the store (and
 * draft), the request (`seq`) and `sessionEndsSoFar()` before its session check (`since`). It counts only while all of
 * them are the ones now.
 */
type EligPhase = 'checking' | 'allowed' | 'denied' | 'unavailable' | 'rate-limited' | 'ended';
interface EligState {
  readonly uid: string; readonly n: number; readonly csrf: string | null; readonly storeId: string; readonly draftId: string; readonly seq: number;
  readonly since: number; readonly phase: EligPhase; readonly text: string; readonly waitId: number;
}
/** One edit attempt (M7B-INVOICES-P2) — and one discard attempt (M7B-INVOICES-DISCARD-P1), the same shape — frozen before it leaves: the exact body ('' once it may never be sent again), its target, and the generation (`n`) whose token it went with. */
interface EditAttempt {
  readonly key: string; readonly body: string; readonly storeId: string; readonly draftId: string; readonly expectedVersion: number; readonly n: number;
  readonly sentAt: number; readonly sentWall: number;
  readonly state: 'sending' | 'unresolved' | 'checking';
  /** Why the last answer left it unresolved ('' for none). */
  readonly note: string;
}
/**
 * The open editor (M7B-INVOICES-P2): which open it is (`id`), the store and the generation it opened in (`since`: the
 * eligibility's), the server draft its working copy edits (`base`: its version is what a save expects), the customer it
 * was seeded with, its attempt, what it says, and a conflict's fresh read of the server's draft.
 */
interface EditorState {
  readonly id: number; readonly store: StoreEntry; readonly n: number; readonly since: number;
  readonly base: DraftDetail; readonly customer: ServerCustomerReference | null; readonly attempt: EditAttempt | null;
  readonly status: { readonly alert: boolean; readonly text: string } | null;
  readonly conflict: { readonly phase: 'loading' | 'ready' | 'failed'; readonly text: string; readonly current: DraftDetail | null } | null;
}
/**
 * The discard confirmation (M7B-INVOICES-DISCARD-P1), stacked over the reopen dialog: which open it is (`id`), the draft it
 * names (the reopen read's detail: its version is what the discard expects) and its store, the generation it opened in,
 * whether a key was minted in it (`pressed`: it never mints a second), its attempt and what it says.
 */
interface DiscardState {
  readonly id: number; readonly store: StoreEntry; readonly draft: DraftDetail; readonly n: number; readonly pressed: boolean;
  readonly attempt: EditAttempt | null; readonly status: { readonly alert: boolean; readonly text: string } | null;
}
/**
 * The issue confirmation (M7B-INVOICES-ISSUE-P2), stacked over the reopen dialog: which open it is (`id`), the draft and
 * store it reviews, the generation it opened in, the preview read and the body built ONCE from its `expected` (`refused`:
 * the preview read itself was refused, said in `text`), whether that preview replaced an earlier one (`updated`), the
 * attempt it shows (`key`, in the issue hold store) and whether a key was ever minted in it (`pressed`).
 */
interface IssueState {
  readonly id: number; readonly store: StoreEntry; readonly draftId: string; readonly n: number;
  readonly phase: 'opening' | 'loading' | 'ready' | 'unavailable' | 'rate-limited' | 'refused';
  readonly text: string;
  readonly preview: IssuePreview | null; readonly body: string | null; readonly updated: boolean;
  readonly key: string | null; readonly pressed: boolean;
  readonly status: { readonly alert: boolean; readonly text: string } | null;
}
/** The issued invoice opened from the attempt card's View invoice: which open it is, and what it reads. */
interface IssuedViewOpen { readonly id: number; readonly storeId: string; readonly invoiceId: string }
interface Failure { readonly kind: 'denied' | 'signed-out' | 'rate-limited' | 'unavailable'; readonly text: string; readonly seconds?: number }

/** One generation's customer names: what was read (null: not readable), what is asked or queued, how many reads are out. */
interface NameBook { readonly gen: number; readonly map: Map<string, string | null>; readonly pending: Set<string>; readonly queue: string[]; active: number; stopped: boolean }
const newBook = (gen: number): NameBook => ({ gen, map: new Map(), pending: new Set(), queue: [], active: 0, stopped: false });

const STORES_IDLE: StoresState = Object.freeze({ phase: 'idle', text: '', stores: [] });
const listOf = (gen: number, storeId: string, phase: Phase = 'idle', text = ''): ListState =>
  Object.freeze({ gen, storeId, phase, text, rows: [], next: null, note: '', waitId: 0 });
const UNAVAILABLE: Failure = Object.freeze({ kind: 'unavailable', text: DRAFTS_TEXT.unavailable });

function sessionFailure(s: Exclude<SessionResult, { kind: 'ok' }>): Failure {
  if (s.kind === 'no-identity') return { kind: 'signed-out', text: DRAFTS_TEXT.noIdentity };
  if (s.kind === 'refused') return { kind: 'signed-out', text: DRAFTS_TEXT.refused };
  if (s.kind === 'ended') return { kind: 'signed-out', text: DRAFTS_TEXT.ended };
  if (s.kind === 'rate-limited') return { kind: 'rate-limited', text: '', seconds: s.retryAfterSeconds ?? DEFAULT_WAIT_SECONDS };
  return UNAVAILABLE;
}
function readFailure(answer: { readonly kind: string; readonly retryAfterSeconds?: number }, denied: string): Failure {
  if (answer.kind === 'rate-limited') return { kind: 'rate-limited', text: '', seconds: answer.retryAfterSeconds ?? DEFAULT_WAIT_SECONDS };
  if (answer.kind === 'denied') return { kind: 'denied', text: denied };
  if (answer.kind === 'signed-out') return { kind: 'signed-out', text: DRAFTS_TEXT.ended };
  return UNAVAILABLE;
}

/** The parts of a prepared draft the section sends: the body built once, and what it is for. */
interface PreparedDraft {
  readonly store: StoreEntry;
  readonly csrf: string; // the generation's token the dialog was opened under
  readonly customer: ServerCustomerReference;
  readonly body: string;
  readonly lineCount: number;
  readonly subtotalCents: number;
}
/** An edit as the editor sends it: the body built once, the version it expects, its customer; `base` for a Reapply (the draft the conflict's read found). */
interface PreparedEdit { readonly body: string; readonly expectedVersion: number; readonly customer: ServerCustomerReference; readonly base?: DraftDetail }
/** `created`: the attempt's answer was a validated 201 (it may already have been read back and left the store). */
type SendOutcome = { readonly kind: 'sent'; readonly key: string; readonly created: boolean } | { readonly kind: 'not-sent'; readonly text: string } | { readonly kind: 'blocked' };

function DraftsSection({
  uid, canViewCustomers, handoff, onHandoffTaken,
  session = tenantSession, drafts = draftsClient, customers = customersClient, identity = firebaseShopIdentity,
  holds = draftHolds, issuing = issuingClient, issueHolds: issues = issueHolds, now, wallNow, newKey,
}: ServerInvoiceDraftsProps & { readonly uid: string; readonly holds: DraftHoldStore }) {
  const [open, setOpen] = useState(false);
  const [stores, setStoresState] = useState<StoresState>(STORES_IDLE);
  const [storeId, setStoreIdState] = useState('');
  const [list, setListState] = useState<ListState>(() => listOf(0, ''));
  const [reopen, setReopenState] = useState<ReopenState | null>(null);
  const [newDraft, setNewDraft] = useState<NewDraftState | null>(null);
  const [pending, setPending] = useState<{ readonly id: string; readonly name: string } | null>(null); // a hand-over waiting for a store
  const [notice, setNotice] = useState('');
  const [changed, setChanged] = useState(false);
  const [busy, setBusyState] = useState(false);
  const [wait, setWait] = useState<number | null>(null);
  const [elig, setEligState] = useState<EligState>(() => ({ uid, n: 0, csrf: null, storeId: '', draftId: '', seq: 0, since: 0, phase: 'ended', text: '', waitId: 0 }));
  const [editElig, setEditEligState] = useState<EligState>(elig);
  const [discardElig, setDiscardEligState] = useState<EligState>(elig);
  const [editor, setEditorState] = useState<EditorState | null>(null);
  const [discard, setDiscardState] = useState<DiscardState | null>(null);
  const [issueElig, setIssueEligState] = useState<EligState>(elig);
  const [issue, setIssueState] = useState<IssueState | null>(null);
  const [issuedView, setIssuedViewState] = useState<IssuedViewOpen | null>(null);
  // The attempt card's own reads (by the attempt's key): its invoice's detail ('failed' once it did not load; refused for
  // good is the attempt's own `refusal`), a Find out.
  const [detail, setDetail] = useState<{ readonly key: string; readonly phase: 'loading' | 'failed' } | null>(null);
  const [finding, setFinding] = useState<string | null>(null);
  const [, setNamesTick] = useState(0);
  const [, setTick] = useState(0);
  const held = useSyncExternalStore(holds.subscribe, () => holds.get(uid));
  const issueHeld = useSyncExternalStore(issues.subscribe, () => issues.get(uid));

  const gen = useRef<{ n: number; csrf: string | null }>({ n: 0, csrf: null }); // the token: refs, the hold store, the open dialog's state
  const alive = useRef(false);
  const storesRef = useRef<StoresState>(stores);
  const storeRef = useRef('');
  const listRef = useRef<ListState>(list);
  const reopenRef = useRef<ReopenState | null>(null);
  const eligRef = useRef<EligState>(elig);
  const editEligRef = useRef<EligState>(editElig);
  const discardEligRef = useRef<EligState>(discardElig);
  const editorRef = useRef<EditorState | null>(null);
  const editorSeq = useRef(0); // which editor open is the latest: a continuation applies only to its own
  const discardRef = useRef<DiscardState | null>(null);
  const discardSeq = useRef(0); // which confirmation open is the latest
  const issueEligRef = useRef<EligState>(issueElig);
  const issueRef = useRef<IssueState | null>(null);
  const issueSeq = useRef(0); // which issue confirmation open is the latest
  const issuedViewRef = useRef<IssuedViewOpen | null>(null);
  const issuedViewSeq = useRef(0);
  // The confirmation (its `id`) whose Issue invoice press is out, from its session check on: a second activation sends nothing.
  const issueSending = useRef(0);
  // The attempt (by its key) whose Check again, and whose card read (its detail or a Find), is out: an attempt that
  // replaced it is never held back by it.
  const issueChecking = useRef<string | null>(null);
  const issueReading = useRef<string | null>(null);
  const seq = useRef({ stores: 0, list: 0, reopen: 0, elig: 0, editElig: 0, discardElig: 0, review: 0, issueElig: 0, preview: 0, attempt: 0 });
  const ctl = useRef<Record<'stores' | 'list' | 'reopen' | 'names' | 'elig' | 'editElig' | 'discardElig' | 'review' | 'issueElig' | 'preview' | 'attempt', AbortController | null>>(
    { stores: null, list: null, reopen: null, names: null, elig: null, editElig: null, discardElig: null, review: null, issueElig: null, preview: null, attempt: null },
  );
  const names = useRef<NameBook>(newBook(0));
  const waitRef = useRef(false);
  const waitUntil = useRef(0);
  const waitTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const waitSeq = useRef(0); // which wait is running: one more each time a wait (re)starts with a later end
  const busyRef = useRef(false);
  const busyBy = useRef(0); // the read that set `busy` last: only its own exit clears it (or abortReads)
  const sendingRef = useRef(false); // a Save draft is out: a second press sends nothing
  const checkingRef = useRef(false); // a Check again is out
  // The editor (its `id`) whose Save or Reapply is out, from its session check on, and whose Check again is out (0: none):
  // owned by that editor, so a closed one's late operation never holds back the next editor.
  const editBusy = useRef({ sending: 0, checking: 0 });
  // The session token the editor's attempt was sent with (by its key): in a ref only, as every token here; Check again
  // sends with it and with nothing else, and it goes with the attempt and with the editor.
  const editToken = useRef<{ readonly key: string; readonly csrf: string } | null>(null);
  // M7B-INVOICES-DISCARD-P1: the same for the confirmation's discard attempt (by the confirmation's `id` and the attempt's key).
  const discardBusy = useRef({ sending: 0, checking: 0 });
  const discardToken = useRef<{ readonly key: string; readonly csrf: string } | null>(null);
  // The draft whose reopen dialog takes focus back once it has settled, on Discard draft… when offered, else its Close
  // (after the confirmation closed with nothing discarded): taken in a layout effect, before DialogFrame's own recovery.
  const discardFocus = useRef<string | null>(null);
  const readBack = useRef<string | null>(null); // the created key whose read-back is running
  const newButton = useRef<HTMLButtonElement | null>(null);
  const heading = useRef<HTMLHeadingElement | null>(null);
  const loadMore = useRef<HTMLButtonElement | null>(null);
  const section = useRef<HTMLElement | null>(null);
  // The control in this section (outside the dialogs) that last took focus, and where focus goes if a later render removes
  // or disables it while it still has focus (DA-199): the heading, unless a change named another place (Load more's first
  // new row). Kept until that happens, another control in the section takes focus or a press lands outside it — not
  // consumed by an unrelated commit.
  const keepFocus = useRef<{ readonly from: Element; readonly to: () => HTMLElement | null } | null>(null);
  // The props as they are NOW, for continuations: a list, reopen or read-back answer that lands after a re-render reads
  // Customers View here, never from the render its read began in (resolveNames).
  const events = useRef({ onHandoffTaken, canViewCustomers });
  useLayoutEffect(() => { events.current = { onHandoffTaken, canViewCustomers }; });

  const clock = (): number => (now ?? (() => performance.now()))();
  const wall = (): number => (wallNow ?? (() => Date.now()))();
  const nextKey = (): string => (newKey ?? (() => crypto.randomUUID()))();
  const connect = (mode?: 'fresh' | 'reconnect'): Promise<SessionResult> =>
    session.ensure(uid, () => identity.idToken(uid), mode === 'fresh' ? { fresh: true } : mode === 'reconnect' ? { reconnect: true } : undefined);
  /** Track the section control that has focus now; `to` names where focus goes if a render takes it away (default: the heading). */
  const trackFocus = (target: EventTarget | null, to: () => HTMLElement | null = () => heading.current): void => {
    if (target instanceof Element && section.current?.contains(target) === true) keepFocus.current = { from: target, to };
  };
  const putStores = (next: StoresState): void => { storesRef.current = next; setStoresState(next); };
  const putList = (next: ListState): void => { listRef.current = next; setListState(next); };
  const putReopen = (next: ReopenState | null): void => { reopenRef.current = next; setReopenState(next); };
  const putElig = (next: EligState): void => { eligRef.current = next; setEligState(next); };
  const putEditElig = (next: EligState): void => { editEligRef.current = next; setEditEligState(next); };
  const putDiscardElig = (next: EligState): void => { discardEligRef.current = next; setDiscardEligState(next); };
  const putDiscard = (next: DiscardState | null): void => {
    discardRef.current = next;
    if (next?.attempt?.key !== discardToken.current?.key) discardToken.current = null; // the token goes with its attempt
    setDiscardState(next);
  };
  const patchDiscard = (next: Partial<DiscardState>): void => { if (discardRef.current !== null) putDiscard({ ...discardRef.current, ...next }); };
  const putIssueElig = (next: EligState): void => { issueEligRef.current = next; setIssueEligState(next); };
  const putIssue = (next: IssueState | null): void => { issueRef.current = next; setIssueState(next); };
  /** Change the open issue confirmation when it is still the one `id` names (a closed or replaced one's continuation changes nothing). */
  const patchIssue = (id: number, next: Partial<IssueState>): boolean => {
    if (!alive.current || issueRef.current === null || issueRef.current.id !== id) return false;
    putIssue({ ...issueRef.current, ...next });
    return true;
  };
  /**
   * Drop the issue confirmation AND the reopen dialog under it AT ONCE (M7B-INVOICES-ISSUE-P2), as dropDiscard: its
   * preview read is cancelled; the attempt it showed stays in the issue hold store (its own rules decide it).
   */
  const dropIssue = (): void => {
    ctl.current.preview?.abort();
    seq.current.preview += 1;
    if (issueRef.current === null) return;
    issueRef.current = null;
    reopenRef.current = null;
    flushSync(() => { setIssueState(null); setReopenState(null); });
  };
  const closeIssuedView = (): void => { issuedViewRef.current = null; setIssuedViewState(null); };
  /**
   * Drop the discard confirmation AND the reopen dialog under it AT ONCE (M7B-INVOICES-DISCARD-P1), for a session that is
   * over or changed and for a store change: the attempt, its token and both dialogs go in a render committed here
   * (flushSync), so a late answer finds nothing under its key. Nothing when no confirmation is up (the reopen dialog then
   * follows its own rule). Called only outside React's render and commit, as dropEditor.
   */
  const dropDiscard = (): void => {
    discardToken.current = null;
    discardFocus.current = null;
    if (discardRef.current === null) return;
    discardRef.current = null;
    reopenRef.current = null;
    flushSync(() => { setDiscardState(null); setReopenState(null); });
  };
  const putEditor = (next: EditorState | null): void => {
    editorRef.current = next;
    // The attempt's own token goes with its attempt (closed, settled or replaced): never sent for another.
    if (next?.attempt?.key !== editToken.current?.key) editToken.current = null;
    setEditorState(next);
  };
  /** Change the open editor (callers check first that it is still the one they act for). */
  const patchEditor = (next: Partial<EditorState>): void => { if (editorRef.current !== null) putEditor({ ...editorRef.current, ...next }); };
  /**
   * Close the editor AT ONCE for a session that is over or changed (M7B-INVOICES-P2): its working copy and customer live
   * in the dialog's own state, so the render that unmounts it is committed here, synchronously (flushSync) — never left
   * for a later render. Called only outside React's render and commit (the sign-out broadcast, a read's continuation).
   */
  const dropEditor = (): void => {
    editToken.current = null;
    if (editorRef.current === null) return;
    editorRef.current = null;
    flushSync(() => setEditorState(null));
  };
  /**
   * The eligibility answer counts: asked under this user, this generation and token and the latest request — for New, at
   * the store chosen now; for Edit (`editElig`) and Discard (`discardElig`, M7B-INVOICES-DISCARD-P1), at the reopen
   * dialog's store and draft now.
   */
  const current = (e: EligState, slot: 'elig' | 'editElig' | 'discardElig' | 'issueElig' = 'elig'): boolean =>
    e.uid === uid && e.n === gen.current.n && e.csrf === gen.current.csrf && e.seq === seq.current[slot] && (slot !== 'elig'
      ? e.draftId !== '' && e.storeId === reopenRef.current?.storeId && e.draftId === reopenRef.current.id
      : e.draftId === '' && e.storeId === storeRef.current);
  /** New server draft may be offered now: the server's `allowed`, for exactly the context there is now. */
  const allowedNow = (): boolean => eligRef.current.phase === 'allowed' && current(eligRef.current);
  const setBusy = (next: boolean): void => { busyRef.current = next; setBusyState(next); };
  /**
   * `busy` for one read (stores or list): it takes it on start and gives it back on EVERY exit — an answer, a refusal, a
   * session end it reported itself, or being made stale — unless a later read has taken it since (that one gives it
   * back). A stale exit gives it back too: a read that ends the session itself is stale by then (failSession bumps every
   * counter), and a fresh-exit-only rule left Reconnect disabled for good.
   */
  const takeBusy = (): number => { setBusy(true); return ++busyBy.current; };
  const giveBusy = (token: number): void => { if (alive.current && busyBy.current === token) setBusy(false); };
  const waitLeft = (): number => Math.max(1, Math.ceil((waitUntil.current - clock()) / 1000));
  const expired = (h: { readonly sentAt: number; readonly sentWall: number }): boolean => Math.max(clock() - h.sentAt, wall() - h.sentWall) >= CHECK_CUTOFF_MS;
  /** The user's issue attempt under `key` while it is still this session's (not detached), else null. */
  const issueOf = (key: string): HeldIssue | null => { const h = issues.get(uid); return h !== undefined && h.key === key && h.csrf !== null ? h : null; };

  function clearWait(): void {
    if (waitTimer.current !== null) clearTimeout(waitTimer.current);
    waitTimer.current = null;
    waitRef.current = false;
    setWait(null);
  }
  /** A rate limit's delay: the controls come back when it has passed (no read starts on its own), never sooner. */
  function startWait(seconds: number): number {
    const until = clock() + seconds * 1000;
    if (waitRef.current && until <= waitUntil.current) return Math.max(1, Math.ceil((waitUntil.current - clock()) / 1000));
    if (waitTimer.current !== null) clearTimeout(waitTimer.current);
    waitUntil.current = until;
    waitSeq.current += 1;
    waitRef.current = true;
    setWait(seconds);
    waitTimer.current = setTimeout(() => { waitTimer.current = null; waitRef.current = false; setWait(null); }, seconds * 1000);
    return seconds;
  }

  /** Cancel every read in flight; their answers are stale from here, and nothing is busy any more. */
  function abortReads(): void {
    for (const kind of ['stores', 'list', 'reopen', 'names', 'elig', 'editElig', 'discardElig', 'review', 'issueElig', 'preview', 'attempt'] as const) ctl.current[kind]?.abort();
    const s = seq.current;
    seq.current = {
      stores: s.stores + 1, list: s.list + 1, reopen: s.reopen + 1, elig: s.elig + 1, editElig: s.editElig + 1, discardElig: s.discardElig + 1, review: s.review + 1,
      issueElig: s.issueElig + 1, preview: s.preview + 1, attempt: s.attempt + 1,
    };
    busyBy.current += 1;
    setBusy(false);
  }

  /**
   * A session token: detach the user's live draft attempt when it was sent under another (a session change, never a store
   * choice) — and the user's issue attempt, live or settled (M7B-INVOICES-ISSUE-P2: its invoice is read, and checked, only
   * under the session it was sent with).
   */
  function judgeHold(csrf: string): void {
    const h = holds.get(uid);
    if (isLiveHold(h) && h.csrf !== null && h.csrf !== csrf) holds.detach(uid);
    const i = issues.get(uid);
    if (i !== undefined && i.csrf !== null && i.csrf !== csrf) issues.detach(uid);
  }

  /** A new generation: everything read under the previous token goes, and the stores are read again. */
  function begin(csrf: string): void {
    gen.current = { n: gen.current.n + 1, csrf };
    abortReads();
    clearWait();
    judgeHold(csrf);
    names.current = newBook(gen.current.n);
    storeRef.current = '';
    setStoreIdState('');
    putList(listOf(gen.current.n, ''));
    dropDiscard(); // the discard's attempt and both dialogs are the previous session's
    dropIssue(); // M7B-INVOICES-ISSUE-P2: the issue confirmation too (its attempt was judged above)
    closeIssuedView();
    putReopen(null);
    dropEditor(); // the editor's working copy and attempt are the previous session's
    setNewDraft(null);
    setPending(null); // a hand-over is the previous session's: never carried into this one
    setChanged(true);
    void readStores();
  }

  /** Take a confirmed token: the first fixes the generation, the same changes nothing, another starts a new one (true). */
  function adopt(csrf: string): boolean {
    if (gen.current.csrf === csrf) return false;
    if (gen.current.csrf === null) {
      gen.current.csrf = csrf;
      judgeHold(csrf);
      return false;
    }
    begin(csrf);
    return true;
  }

  /** A refusal of the session clears every view (Reconnect then); anything else is said where it happened. */
  function failSession(failure: Failure): void { // a signed-out failure (an ended, refused or unknown sign-in)
    abortReads();
    names.current = newBook(gen.current.n);
    setPending(null);
    setChanged(false); // the end is what the section says now: "choose a store" no longer applies
    putStores({ phase: failure.kind, text: failure.text, stores: [] });
    storeRef.current = '';
    setStoreIdState('');
    putList(listOf(gen.current.n, ''));
    dropDiscard(); // M7B-INVOICES-DISCARD-P1: a confirmation up takes the reopen dialog with it, before the line below
    dropIssue(); // M7B-INVOICES-ISSUE-P2: as the discard's
    closeIssuedView();
    // An issue attempt can never be checked or read under a session that ended: it is detached (said as such).
    if (failure.kind === 'signed-out') issues.detach(uid);
    if (reopenRef.current !== null) putReopen({ ...reopenRef.current, phase: 'signed-out', text: failure.text, draft: null, saved: null, refused: '' });
    // M7B-INVOICES-P2: unlike the reopen dialog, the editor closes — its working copy, customer and attempt go at once.
    dropEditor();
    // Nothing is fixed after a confirmed end: the Reconnect's token is a FIRST token, not a "connection changed".
    if (failure.kind === 'signed-out') gen.current = { n: gen.current.n, csrf: null };
    putElig({ uid, n: gen.current.n, csrf: gen.current.csrf, storeId: '', draftId: '', seq: seq.current.elig, since: 0, phase: 'ended', text: '', waitId: 0 }); // the stores' note says it
  }

  /**
   * A 403's verdict after the reads' ONE fresh check (recheck), shared by the eligibility reads, the reopen read (and so a
   * save's read-back), the editor's conflict read and its PATCH answers (M7B-INVOICES-P2): 'denied' ONLY when the check
   * confirmed the same session; null when `stale()` says the caller's context is gone meanwhile (another token started a
   * new generation, a sign-out began, the dialog closed) or the check found the session over (failSession is done here);
   * otherwise the check's own failure — a 429 starts the section's wait (its text says so), anything else is
   * unavailable, never a refusal. A check that stayed in the SAME session (alive, the same generation, no session end
   * since it was asked) still acts on its 401 (failSession) and its 429 (the wait) when only the caller's dialog closed.
   */
  async function denialOf(stale: () => boolean): Promise<'denied' | Failure | null> {
    const n = gen.current.n;
    const since = sessionEndsSoFar();
    const again = await recheck();
    const same = alive.current && n === gen.current.n && since === sessionEndsSoFar(); // recheck's new token is a new generation
    if (same && again?.kind === 'signed-out') { failSession(again); return null; }
    const waited = same && again?.seconds !== undefined ? startWait(again.seconds) : null;
    if (stale()) return null;
    if (again === null) return 'denied';
    if (again.kind === 'signed-out') { failSession(again); return null; }
    if (again.seconds !== undefined) return { kind: 'rate-limited', text: pickerWaitText(waited ?? startWait(again.seconds)), seconds: again.seconds };
    return UNAVAILABLE;
  }

  /** After a read refused 403: ONE fresh check tells "another session" (a new generation) from a refusal that stands. */
  async function recheck(): Promise<Failure | null> {
    const since = sessionEndsSoFar();
    const s = await connect('fresh');
    if (s.kind !== 'ok') return sessionFailure(s);
    if (alive.current && since === sessionEndsSoFar()) adopt(s.csrf); // never a token from before a sign-out
    return null;
  }

  async function readStores(reconnect = false): Promise<void> {
    if (waitRef.current && !reconnect) return;
    const mine = gen.current.n;
    const n = ++seq.current.stores;
    ctl.current.stores?.abort();
    const controller = new AbortController();
    ctl.current.stores = controller;
    const stale = (): boolean => !alive.current || mine !== gen.current.n || n !== seq.current.stores;
    const token = takeBusy();
    putStores({ phase: 'loading', text: DRAFTS_TEXT.storesLoading, stores: [] });
    try {
      const s = await connect(reconnect ? 'reconnect' : undefined);
      if (stale()) return;
      if (s.kind !== 'ok') {
        const failure = sessionFailure(s);
        if (failure.kind === 'signed-out') return failSession(failure);
        return putStores({ phase: failure.kind, text: failure.seconds !== undefined ? pickerWaitText(startWait(failure.seconds)) : failure.text, stores: [] });
      }
      if (adopt(s.csrf)) return; // a new generation has started its own read
      const answer = await drafts.listStores(s.csrf, controller.signal);
      if (stale()) return;
      if (answer.kind === 'ok') return putStores({ phase: 'ready', text: answer.stores.length === 0 ? DRAFTS_TEXT.noStores : '', stores: answer.stores });
      if (answer.kind === 'denied') {
        const again = await recheck();
        if (stale()) return;
        if (again !== null && again.kind === 'signed-out') return failSession(again);
      }
      if (answer.kind === 'signed-out') return failSession({ kind: 'signed-out', text: DRAFTS_TEXT.ended });
      const failure = readFailure(answer, DRAFTS_TEXT.storesDenied);
      putStores({ phase: failure.kind, text: failure.seconds !== undefined ? pickerWaitText(startWait(failure.seconds)) : failure.text, stores: [] });
    } finally {
      giveBusy(token);
    }
  }

  /**
   * Read the names of `ids` this generation has not asked for: one shared queue per generation, at most three reads out
   * at once whatever asked; a refusal (or a rate limit) stops them all for this generation. Called from a read's late
   * answer: Customers View is the hint as it is when the answer lands (`events`), so a hint lost meanwhile asks nothing.
   */
  function resolveNames(ids: readonly string[], csrf: string): void {
    const book = names.current;
    if (!events.current.canViewCustomers || book.stopped || book.gen !== gen.current.n) return;
    for (const id of new Set(ids)) if (!book.map.has(id) && !book.pending.has(id)) { book.pending.add(id); book.queue.push(id); }
    if (ctl.current.names === null || ctl.current.names.signal.aborted) ctl.current.names = new AbortController();
    const signal = ctl.current.names.signal;
    const worker = async (): Promise<void> => {
      book.active += 1;
      try {
        for (let id = book.queue.shift(); id !== undefined; id = book.queue.shift()) {
          if (book.stopped || book !== names.current) return;
          const answer = await customers.detail(id, csrf, signal);
          if (!alive.current || book !== names.current) return;
          book.pending.delete(id);
          if (answer.kind === 'ok') book.map.set(id, answer.customer.name);
          else if (answer.kind === 'denied' || answer.kind === 'signed-out' || answer.kind === 'rate-limited') { book.map.set(id, null); book.stopped = true; }
          else book.map.set(id, null);
          setNamesTick((t) => t + 1);
        }
      } finally {
        book.active -= 1;
      }
    };
    while (book.active < NAME_READS_AT_ONCE && book.queue.length > 0) void worker();
  }
  // Customers View gone (the local hint): no name is shown or read from here, and the reads out are abandoned.
  useEffect(() => {
    if (canViewCustomers) return;
    ctl.current.names?.abort();
    names.current = newBook(gen.current.n);
    setNamesTick((t) => t + 1);
  }, [canViewCustomers]);
  const customerText = (id: string): string => (canViewCustomers ? names.current.map.get(id) ?? null : null) ?? customerFallbackText(id);

  /** Page one (`first`) or the page after the last shown (`more`) of the chosen store's drafts. */
  async function readDrafts(mode: 'first' | 'more', note = ''): Promise<void> {
    const target = storeRef.current;
    const cursor = mode === 'more' ? listRef.current.next : null;
    if (target === '' || (mode === 'more' && cursor === null) || waitRef.current) return;
    const mine = gen.current.n;
    const n = ++seq.current.list;
    ctl.current.list?.abort();
    const controller = new AbortController();
    ctl.current.list = controller;
    const stale = (): boolean => !alive.current || mine !== gen.current.n || n !== seq.current.list || target !== storeRef.current;
    const token = takeBusy();
    if (mode === 'first') putList({ ...(listRef.current.storeId === target ? listRef.current : listOf(mine, target)), phase: 'loading', text: DRAFTS_TEXT.listLoading, note });
    try {
      const s = await connect();
      if (stale()) return;
      if (s.kind !== 'ok') {
        const failure = sessionFailure(s);
        if (failure.kind === 'signed-out') return failSession(failure);
        const said = failure.seconds !== undefined ? pickerWaitText(startWait(failure.seconds)) : failure.text;
        return putList({ ...listRef.current, phase: failure.kind, text: said, note: '', waitId: waitSeq.current });
      }
      if (adopt(s.csrf)) return;
      const answer = await drafts.listDrafts(target, cursor, s.csrf, controller.signal);
      if (stale()) return;
      if (answer.kind === 'ok') {
        const was = listRef.current;
        const shown = new Set(mode === 'more' ? was.rows.map((row) => row.id) : []);
        const fresh = answer.drafts.filter((row) => !shown.has(row.id) && shown.add(row.id) !== undefined);
        // The last page takes Load more away: focus still on it goes to the first row this page brought (else the heading).
        const first = mode === 'more' && answer.nextCursor === null ? fresh[0] : undefined;
        if (first !== undefined && document.activeElement === loadMore.current) trackFocus(loadMore.current, () => document.getElementById(openIdOf(first.id)));
        putList({ gen: mine, storeId: target, phase: 'ready', text: '', rows: mode === 'more' ? [...was.rows, ...fresh] : fresh, next: answer.nextCursor, note: mode === 'more' ? '' : was.note, waitId: 0 });
        return resolveNames(answer.drafts.map((row) => row.customerId), s.csrf);
      }
      // A continuation that no longer names a draft of this store: ONE reload from page one (which has no cursor).
      if (answer.kind === 'bad-cursor') return mode === 'more' ? void readDrafts('first', DRAFTS_TEXT.reloaded) : putList({ ...listRef.current, phase: 'unavailable', text: DRAFTS_TEXT.unavailable });
      if (answer.kind === 'denied') {
        const again = await recheck();
        if (stale()) return;
        if (again !== null && again.kind === 'signed-out') return failSession(again);
      }
      if (answer.kind === 'signed-out') return failSession({ kind: 'signed-out', text: DRAFTS_TEXT.ended });
      const failure = readFailure(answer, DRAFTS_TEXT.listDenied);
      const text = failure.seconds !== undefined ? pickerWaitText(startWait(failure.seconds)) : failure.text;
      // A refusal shows nothing; an outage or a rate limit keeps the rows as last known.
      putList(failure.kind === 'denied' ? { ...listOf(mine, target), phase: 'denied', text } : { ...listRef.current, phase: failure.kind, text, note: '', waitId: waitSeq.current });
    } finally {
      giveBusy(token);
    }
  }

  /**
   * Open one draft read-only: a fresh read of its own (never a list row), for the store it was listed at. `saved`: the
   * edit the server just confirmed (M7B-INVOICES-P2) — this is then its ONE read-back. Once it loads, the server is asked
   * whether Edit may be offered (a writable store only).
   */
  async function readReopen(id: string, target: string, saved: UpdatedDraft | null = null, refused = ''): Promise<void> {
    const mine = gen.current.n;
    const n = ++seq.current.reopen;
    ctl.current.reopen?.abort();
    const controller = new AbortController();
    ctl.current.reopen = controller;
    // M7B-INVOICES-P2: and no sign-out since it asked (as every new read here), now that it also reads a save back.
    const since = sessionEndsSoFar();
    const stale = (): boolean => !alive.current || mine !== gen.current.n || n !== seq.current.reopen || reopenRef.current?.id !== id || since !== sessionEndsSoFar();
    const put = (phase: ReopenState['phase'], text: string, draft: DraftDetail | null = null): void => putReopen({ id, storeId: target, phase, text, draft, saved, refused });
    put('loading', DRAFTS_TEXT.draftLoading);
    const s = await connect();
    if (stale()) return;
    if (s.kind !== 'ok') {
      const failure = sessionFailure(s);
      if (failure.kind === 'signed-out') return failSession(failure);
      return put(failure.kind, failure.seconds !== undefined ? pickerWaitText(startWait(failure.seconds)) : failure.text);
    }
    if (adopt(s.csrf)) return;
    const answer = await drafts.getDraft(target, id, s.csrf, controller.signal);
    if (stale()) return;
    if (answer.kind === 'ok') {
      put('ready', '', answer.draft);
      void readEligibility(id);
      void readEligibility(id, 'discardElig'); // M7B-INVOICES-DISCARD-P1: its own, in the same place
      void readEligibility(id, 'issueElig'); // M7B-INVOICES-ISSUE-P2: and the issue's
      // An edit that changed the draft changed its row (line count, subtotal): page one is read again, as after a create.
      if (saved?.changed === true && storeRef.current === target) void readDrafts('first');
      return resolveNames([answer.draft.customerId], s.csrf);
    }
    if (answer.kind === 'signed-out') return failSession({ kind: 'signed-out', text: DRAFTS_TEXT.ended });
    if (answer.kind === 'denied') { // M7B-INVOICES-P2: the reads' one fresh check first (a save's `saved` note stays)
      const verdict = await denialOf(stale);
      if (verdict === null) return;
      return verdict === 'denied' ? put('denied', DRAFTS_TEXT.draftDenied) : put(verdict.kind, verdict.text);
    }
    const failure = answer.kind === 'not-found' ? { kind: 'not-found' as const, text: DRAFTS_TEXT.draftNotFound } : readFailure(answer, DRAFTS_TEXT.draftDenied);
    put(failure.kind, 'seconds' in failure && failure.seconds !== undefined ? pickerWaitText(startWait(failure.seconds)) : failure.text);
  }

  /**
   * Ask the server whether New server draft may be offered at the chosen store (M7B-INVOICES-P1-R2, DA-201): a read, never
   * a mutation, and only for a writable store under a confirmed token. Its answer applies only under the user,
   * generation, token, store and request that asked, and only while no sign-out has begun since; anything else changes
   * nothing. A 403 gets the reads' ONE fresh check: another token starts a new generation (the store is chosen again,
   * and asks again), the same token is a refusal that stands. During a rate limit's wait nothing is asked.
   * M7B-INVOICES-P2: with a `draftId`, the same read for Edit in the reopen dialog (GET …/{id}/edit-eligibility, the
   * edit's own requirement) — its own state, request counter and controller, asked at the reopen dialog's store for its
   * draft, and stale once that dialog shows another draft or none. M7B-INVOICES-DISCARD-P1: with `discardElig`, the same
   * for Discard draft… (GET …/{id}/discard-eligibility, the discard's own requirement), in its own slot. M7B-INVOICES-ISSUE-P2:
   * with `issueElig`, the same for Issue invoice… (GET …/{id}/issue-eligibility, the issue's own requirement).
   */
  async function readEligibility(draftId = '', which: 'editElig' | 'discardElig' | 'issueElig' = 'editElig'): Promise<void> {
    const edit = draftId !== '';
    const slot = edit ? which : 'elig';
    ctl.current[slot]?.abort();
    const n = ++seq.current[slot];
    const target = edit ? reopenRef.current?.storeId ?? '' : storeRef.current;
    const store = storesRef.current.stores.find((entry) => entry.id === target);
    const csrf = gen.current.csrf;
    if (store === undefined || store.readOnly || csrf === null) return; // a read-only store keeps its own text and asks nothing
    const since = sessionEndsSoFar();
    const key = { uid, n: gen.current.n, csrf, storeId: target, draftId, seq: n, since };
    const texts = slot === 'elig' ? ELIGIBILITY_TEXT : slot === 'editElig' ? EDIT_ELIGIBILITY_TEXT : slot === 'discardElig' ? DISCARD_ELIGIBILITY_TEXT : ISSUE_ELIGIBILITY_TEXT;
    // `waitId`: the wait running once `text` is made (a rate limit's text starts or names it first).
    const put = (phase: EligPhase, text = ''): void =>
      (slot === 'elig' ? putElig : slot === 'editElig' ? putEditElig : slot === 'discardElig' ? putDiscardElig : putIssueElig)({ ...key, phase, text, waitId: waitSeq.current });
    const waitText = (seconds: number): string => pickerWaitText(startWait(seconds));
    if (waitRef.current) return put('rate-limited', pickerWaitText(waitLeft()));
    const controller = new AbortController();
    ctl.current[slot] = controller;
    const here = (): boolean => (edit ? reopenRef.current?.id === draftId && reopenRef.current.storeId === target : target === storeRef.current);
    const stale = (): boolean => !alive.current || key.n !== gen.current.n || csrf !== gen.current.csrf || n !== seq.current[slot]
      || !here() || since !== sessionEndsSoFar();
    put('checking', texts.checking);
    const s = await connect();
    if (stale()) return;
    if (s.kind !== 'ok') {
      const failure = sessionFailure(s);
      if (failure.kind === 'signed-out') return failSession(failure);
      return failure.seconds !== undefined ? put('rate-limited', waitText(failure.seconds)) : put('unavailable', texts.unavailable);
    }
    if (adopt(s.csrf)) return; // a new generation: its stores are read again, and the next choice asks again
    const answer = await (slot === 'elig' ? drafts.eligibility(target, s.csrf, controller.signal)
      : slot === 'editElig' ? drafts.editEligibility(target, draftId, s.csrf, controller.signal)
        : slot === 'discardElig' ? drafts.discardEligibility(target, draftId, s.csrf, controller.signal) : issuing.issueEligibility(target, draftId, s.csrf, controller.signal));
    if (stale()) return;
    if (answer.kind === 'allowed') return put('allowed');
    if (answer.kind === 'signed-out') return failSession({ kind: 'signed-out', text: DRAFTS_TEXT.ended });
    if (answer.kind === 'rate-limited') return put('rate-limited', waitText(answer.retryAfterSeconds));
    if (answer.kind === 'denied') {
      const verdict = await denialOf(stale); // null: another token (a new generation), a sign-out, anything newer, an end
      if (verdict === null) return;
      if (verdict === 'denied') return put('denied', texts.denied);
      if (verdict.kind === 'rate-limited') return put('rate-limited', verdict.text);
    }
    put('unavailable', texts.unavailable);
  }

  /**
   * The server refused a save 403 (M7B-INVOICES-P1-R2): New goes at that store for the eligibility asked under the same
   * generation and token — by the store the attempt was for, not the one chosen now — and nothing is asked again on its
   * own. A later answer of a check still out for it is dropped.
   */
  function refuseElig(storeId: string, csrf: string): void {
    const e = eligRef.current;
    if (e.uid !== uid || e.storeId !== storeId || e.csrf !== csrf || e.n !== gen.current.n || csrf !== gen.current.csrf) return;
    ctl.current.elig?.abort();
    putElig({ ...e, seq: ++seq.current.elig, phase: 'denied', text: ELIGIBILITY_TEXT.denied });
  }

  /**
   * What a create answer means for the section beyond its attempt — a save's and a Check again's alike: a 403 takes New
   * away at the attempt's store under its token (refuseElig), a 429 starts the section's wait. The attempt itself is
   * settled by `settleDraft` alone, and nothing is asked again because of it. A wait ends with the session that was
   * asked to wait, so a 429 starts one only while the request's token is still the generation's and no sign-out has
   * begun since `since` (taken before the request was sent): a late answer for an earlier session holds nothing back.
   */
  function afterCreate(answer: CreateDraftResult, storeId: string, csrf: string, since: number): void {
    if (!alive.current) return;
    if (answer.kind === 'denied') refuseElig(storeId, csrf);
    if (answer.kind === 'rate-limited' && csrf === gen.current.csrf && since === sessionEndsSoFar()) startWait(answer.retryAfterSeconds);
  }

  /** "Show server drafts": the first read of this section (nothing is read before it). */
  function show(): void {
    if (open) return;
    setOpen(true);
    void readStores();
  }

  function chooseStore(id: string): void {
    if (busyRef.current && storesRef.current.phase === 'loading') return;
    dropDiscard(); // M7B-INVOICES-DISCARD-P1: a store change drops a discard's attempt and both dialogs
    dropIssue(); // M7B-INVOICES-ISSUE-P2: and the issue confirmation (its attempt keeps its own store)
    ctl.current.list?.abort();
    seq.current.list += 1;
    storeRef.current = id;
    setStoreIdState(id);
    setNotice('');
    putList(listOf(gen.current.n, id));
    // The previous store's eligibility goes with it (a check still out for it is dropped); a writable store asks its own.
    void readEligibility();
    if (id === '') return;
    setChanged(false); // "The store connection changed … Choose a store." is answered by the choice
    // During a rate limit's wait nothing is read (readDrafts refuses): never a blank list — the wait is said, with Try
    // again (enabled once the wait has passed), as after any other rate-limited read.
    if (waitRef.current) return putList({ ...listOf(gen.current.n, id), phase: 'rate-limited', text: pickerWaitText(waitLeft()), waitId: waitSeq.current });
    void readDrafts('first');
  }

  const chosen = stores.stores.find((store) => store.id === storeId) ?? null;
  const live = isLiveHold(held);

  function openNewDraft(with_: { readonly id: string; readonly name: string } | null): void {
    const csrf = gen.current.csrf;
    // One dialog at a time: never beside the reopen dialog (up from the Open press on, its read still out or not) or the
    // editor. Their inert page keeps New from a press, but a hand-over can try here on its own (the effect below, when an
    // attempt settles meanwhile); it then stays pending, said by the hand-over note, until New or the effect's next try
    // finds no dialog up.
    if (chosen === null || chosen.readOnly || !allowedNow() || csrf === null || live || waitRef.current || reopenRef.current !== null || editorRef.current !== null) return;
    setNotice('');
    setPending(null);
    setNewDraft({ store: chosen, csrf, n: gen.current.n, since: sessionEndsSoFar(), handoff: with_ });
  }

  // A hand-over from the invoice form: open the section, and the dialog at once when a store is chosen that the server
  // allows a draft at (its eligibility, never a local hint).
  useEffect(() => {
    if (handoff === null) return;
    events.current.onHandoffTaken();
    setPending(handoff);
    if (!open) show();
  }, [handoff]);
  useEffect(() => {
    // Not during a rate limit's wait: the dialog opens once it has passed (`wait` back to null), the allowance still current.
    if (pending !== null && newDraft === null && chosen !== null && !chosen.readOnly && allowedNow() && !live && wait === null && gen.current.csrf !== null) openNewDraft(pending);
  }, [pending, chosen, newDraft, elig, live, wait]);

  /**
   * One explicit Save draft: at most one POST, and none while another is out or the user's earlier attempt is still
   * live. The session is checked first; another token than the dialog's, or a customer chosen under another session,
   * sends nothing. The attempt is held BEFORE the request leaves, and its answer settles it by key.
   */
  async function send(p: PreparedDraft): Promise<SendOutcome> {
    if (sendingRef.current) return { kind: 'blocked' };
    if (isLiveHold(holds.get(uid))) return { kind: 'not-sent', text: NOT_SENT_TEXT.pending };
    sendingRef.current = true;
    try {
      const since = sessionEndsSoFar();
      const s = await connect();
      if (!alive.current) return { kind: 'blocked' };
      // A sign-out began while the session was confirmed: that answer is from before it, so nothing is sent or taken.
      if (since !== sessionEndsSoFar()) return { kind: 'not-sent', text: `Not sent. ${DRAFTS_TEXT.ended}` };
      if (s.kind !== 'ok') {
        const failure = sessionFailure(s);
        if (failure.kind === 'signed-out') failSession(failure);
        return { kind: 'not-sent', text: `Not sent. ${failure.seconds !== undefined ? pickerWaitText(failure.seconds) : failure.text}` };
      }
      if (s.csrf !== p.csrf || s.csrf !== gen.current.csrf) {
        adopt(s.csrf);
        return { kind: 'not-sent', text: NOT_SENT_TEXT.connection };
      }
      if (!isContextOf(p.customer.context, uid, s.csrf)) return { kind: 'not-sent', text: NOT_SENT_TEXT.customer };
      const key = nextKey();
      const attempt: HeldDraft = {
        key, body: p.body, storeId: p.store.id, tenantId: p.store.tenantId, customerId: p.customer.id, storeLabel: storeLabel(p.store),
        lineCount: p.lineCount, subtotalCents: p.subtotalCents, csrf: s.csrf, sentAt: clock(), sentWall: wall(),
        state: 'sending', note: '', draftId: null, refusal: null,
      };
      if (!holds.put(uid, attempt)) return { kind: 'not-sent', text: NOT_SENT_TEXT.pending };
      // Settled by key in the store, whether or not this section or its dialog is still there.
      const answer = await drafts.createDraft(p.store.id, p.body, key, s.csrf);
      settleDraft(holds, uid, key, answer, true);
      // The server's refusal stands for the offer too (New goes at that store, nothing is asked again on its own); its
      // rate limit holds New, the reads and Save back for its Retry-After.
      afterCreate(answer, p.store.id, s.csrf, since);
      return { kind: 'sent', key, created: answer.kind === 'created' };
    } finally {
      sendingRef.current = false;
    }
  }

  /** "Check again": the SAME key and the SAME bytes to the attempt's OWN store, only under the token it was sent with. */
  async function checkAgain(): Promise<void> {
    const h = holds.get(uid);
    if (h === undefined || h.state !== 'unresolved' || h.csrf === null || h.body === '' || checkingRef.current || waitRef.current) return;
    if (expired(h)) { holds.change(uid, h.key, { body: '' }); return setTick((t) => t + 1); } // too old: the card now says so
    const { key, body, csrf, storeId: target } = h;
    checkingRef.current = true;
    holds.change(uid, key, { state: 'checking', note: '' });
    try {
      const since = sessionEndsSoFar();
      const s = await connect();
      if (holds.get(uid)?.key !== key) return;
      // A sign-out began while the session was confirmed: nothing is sent and no token is taken from that answer.
      if (since !== sessionEndsSoFar()) return void holds.change(uid, key, { state: 'unresolved', note: `Not checked. ${DRAFTS_TEXT.ended}` });
      if (s.kind !== 'ok') {
        const failure = sessionFailure(s);
        holds.change(uid, key, { state: 'unresolved', note: `Not checked. ${failure.seconds !== undefined ? pickerWaitText(failure.seconds) : failure.text}` });
        if (alive.current && failure.kind === 'signed-out') failSession(failure);
        return;
      }
      if (s.csrf !== csrf) {
        // Another session answers now: the attempt is detached for good, and NOTHING is sent.
        holds.detach(uid);
        holds.change(uid, key, { state: 'unresolved' });
        if (alive.current) adopt(s.csrf);
        return;
      }
      if (alive.current) adopt(s.csrf);
      // Judged AGAIN at the last moment, on the hold as it is now (by key): the session confirmation above can take any
      // time (a slow server, a suspended device), so the cutoff — max(monotonic, wall) elapsed — and the token are
      // re-read right before the POST. Past the cutoff the body goes and nothing is sent: the server may have dropped the
      // key, so the same key could be a new create.
      const latest = holds.get(uid);
      if (latest === undefined || latest.key !== key || latest.csrf !== csrf || latest.body !== body) return void holds.change(uid, key, { state: 'unresolved' });
      if (expired(latest)) {
        holds.change(uid, key, { state: 'unresolved', body: '' }); // too old: the card now says so
        if (alive.current) setTick((t) => t + 1); // after the session's await: never a state update once unmounted
        return;
      }
      const answer = await drafts.createDraft(target, body, key, csrf);
      settleDraft(holds, uid, key, answer, false);
      afterCreate(answer, target, csrf, since); // the same refusal and rate limit as a save's: the attempt keeps the check rule's state
    } finally {
      checkingRef.current = false;
    }
  }

  function stopTracking(): void {
    const h = holds.get(uid);
    if (h === undefined || h.state === 'sending' || h.state === 'checking') return;
    holds.remove(uid, h.key);
  }

  // ---- the editor (M7B-INVOICES-P2) ----

  /**
   * Edit, from the reopen dialog: only on the server's `allowed` for exactly that dialog's store and draft under this
   * generation (checked again at the press). The editor replaces the dialog, seeded from the detail it shows; its
   * customer is a server reference made for the session the eligibility confirmed (`since`: none if a sign-out began).
   */
  function openEditor(): void {
    const r = reopenRef.current;
    const e = editEligRef.current;
    const csrf = gen.current.csrf;
    if (r === null || r.draft === null || csrf === null || e.phase !== 'allowed' || !current(e, 'editElig') || editorRef.current !== null || discardRef.current !== null || issueRef.current !== null) return;
    const store = storesRef.current.stores.find((entry) => entry.id === r.storeId);
    if (store === undefined || store.readOnly) return;
    const draft = r.draft;
    const customer = serverCustomerReference({ id: draft.customerId, name: customerText(draft.customerId) }, uid, sessionContextOf(uid, csrf, e.since));
    putReopen(null);
    putEditor({ id: ++editorSeq.current, store, n: gen.current.n, since: e.since, base: draft, customer, attempt: null, status: null, conflict: null });
  }

  /**
   * One explicit Save (or Reapply): at most one PATCH, and none while the editor's attempt is out or unresolved, during
   * a rate limit's wait, or — for a Save — in a conflict (Reapply sends at the version the conflict's read found). The
   * session is checked first: another token starts a new generation (which closes the editor) and a customer chosen
   * under another session sends nothing. The attempt is frozen in the editor BEFORE the request leaves.
   */
  async function sendEdit(p: PreparedEdit): Promise<void> {
    const ed = editorRef.current;
    if (ed === null || editBusy.current.sending === ed.id || ed.attempt !== null || waitRef.current) return;
    if (p.base === undefined ? ed.conflict !== null : ed.conflict?.current !== p.base) return;
    const standing = (): boolean => alive.current && editorRef.current?.id === ed.id;
    const say = (text: string): void => { if (standing()) patchEditor({ status: { alert: true, text } }); };
    editBusy.current.sending = ed.id;
    try {
      const since = sessionEndsSoFar();
      const s = await connect();
      if (!standing()) return;
      if (since !== sessionEndsSoFar()) return say(`Not sent. ${DRAFTS_TEXT.ended}`);
      if (s.kind !== 'ok') {
        const failure = sessionFailure(s);
        if (failure.kind === 'signed-out') return failSession(failure);
        return say(`Not sent. ${failure.seconds !== undefined ? pickerWaitText(failure.seconds) : failure.text}`);
      }
      if (adopt(s.csrf) || gen.current.n !== ed.n) return; // another session: its new generation closed the editor
      // A rate limit's wait that began while the session was checked: nothing leaves and no key is taken.
      if (waitRef.current) return say(`Not sent. ${pickerWaitText(waitLeft())}`);
      if (!isContextOf(p.customer.context, uid, s.csrf)) return say(NOT_SENT_TEXT.customer);
      const key = nextKey();
      const attempt: EditAttempt = {
        key, body: p.body, storeId: ed.store.id, draftId: ed.base.id, expectedVersion: p.expectedVersion, n: ed.n,
        sentAt: clock(), sentWall: wall(), state: 'sending', note: '',
      };
      editToken.current = { key, csrf: s.csrf };
      patchEditor(p.base === undefined ? { attempt, status: null } : { attempt, status: null, base: p.base, conflict: null });
      const answer = await drafts.updateDraft(attempt.storeId, attempt.draftId, p.body, key, s.csrf);
      await settleEdit(key, answer, true, since, s.csrf);
    } finally {
      if (editBusy.current.sending === ed.id) editBusy.current.sending = 0;
    }
  }

  /**
   * One edit answer, applied BY KEY to the open editor's attempt: nothing when the editor closed or another opened (a new
   * generation, a session end, a sign-out, Cancel) or the section unmounted — the PATCH may still have committed under
   * its old attempt, and nothing here says so or restores anything. `first`: every answer of a first send but unknown and
   * in-progress decides it; a Check again re-sends a key that may already have committed, so only CHECK_DECIDES do. A
   * 429 starts the section's wait only while the session that sent it is still the section's (as afterCreate).
   */
  async function settleEdit(key: string, answer: UpdateDraftResult, first: boolean, since: number, csrf: string): Promise<void> {
    const mine = (): EditAttempt | null => {
      const a = alive.current ? editorRef.current?.attempt ?? null : null;
      return a !== null && a.key === key ? a : null;
    };
    const a = mine();
    if (a === null) return;
    if (answer.kind === 'rate-limited' && csrf === gen.current.csrf && since === sessionEndsSoFar()) startWait(answer.retryAfterSeconds);
    if (answer.kind === 'saved') {
      putEditor(null);
      return void readReopen(a.draftId, a.storeId, answer.result); // the ONE read-back, in the reopen dialog (a read: no lock held)
    }
    if (answer.kind === 'signed-out') return failSession({ kind: 'signed-out', text: DRAFTS_TEXT.ended });
    if (answer.kind === 'denied') {
      // The one fresh check: denied only for the same session; another token closed the editor (null), and a check that
      // could not answer says so. A first send's 403 is decisive either way (the chain refused it before anything ran);
      // a Check again's leaves the attempt unresolved.
      const verdict = await denialOf(() => mine() === null);
      const now = verdict === null ? null : mine();
      if (verdict === null || now === null) return;
      if (verdict === 'denied') {
        if (first) return patchEditor({ attempt: null, status: { alert: true, text: EDIT_REFUSED_TEXT.denied } });
        return patchEditor({ attempt: { ...now, state: 'unresolved', note: reasonOf(answer) } });
      }
      const waits = verdict.kind === 'rate-limited'; // its wait has begun: Save and Check again are held back through it
      if (first) return patchEditor({ attempt: null, status: { alert: true, text: waits ? EDIT_REFUSED_TEXT['rate-limited'] : EDIT_TEXT.refusedUnchecked } });
      return patchEditor({ attempt: { ...now, state: 'unresolved', note: waits ? verdict.text : EDIT_TEXT.checkUnchecked } });
    }
    if (answer.kind === 'conflict') {
      patchEditor({ attempt: null, status: { alert: true, text: EDIT_TEXT.conflict } });
      return readConflict();
    }
    const decisive = first ? answer.kind !== 'unknown' && answer.kind !== 'in-progress' : CHECK_DECIDES.has(answer.kind);
    if (decisive) return patchEditor({ attempt: null, status: { alert: true, text: EDIT_REFUSED_TEXT[answer.kind as EditRefusal] } });
    patchEditor({ attempt: { ...(mine() ?? a), state: 'unresolved', note: reasonOf(answer) } });
  }

  /**
   * "Check again": the SAME key and the SAME bytes to the attempt's OWN store and draft, under the attempt's OWN session
   * token (editToken) — only while the session check answers that very token and the generation it was sent in is still
   * the section's (another token starts a new one, which closes the editor: nothing is sent), outside a rate limit's
   * wait, and within the cutoff, judged again right before the PATCH. Never on its own.
   */
  async function checkEdit(): Promise<void> {
    const id = editorRef.current?.id ?? 0;
    const a = editorRef.current?.attempt ?? null;
    if (a === null || a.state !== 'unresolved' || a.body === '' || editBusy.current.checking === id || waitRef.current) return;
    const mine = (): EditAttempt | null => {
      const now = alive.current ? editorRef.current?.attempt ?? null : null;
      return now !== null && now.key === a.key ? now : null;
    };
    const mark = (next: Partial<EditAttempt>): void => { const now = mine(); if (now !== null) patchEditor({ attempt: { ...now, ...next } }); };
    if (expired(a)) return mark({ body: '' }); // too old: the card now says so
    editBusy.current.checking = id;
    mark({ state: 'checking', note: '' });
    try {
      const since = sessionEndsSoFar();
      const s = await connect();
      if (mine() === null) return;
      if (since !== sessionEndsSoFar()) return mark({ state: 'unresolved', note: `Not checked. ${DRAFTS_TEXT.ended}` });
      if (s.kind !== 'ok') {
        const failure = sessionFailure(s);
        if (failure.kind === 'signed-out') return failSession(failure);
        return mark({ state: 'unresolved', note: `Not checked. ${failure.seconds !== undefined ? pickerWaitText(failure.seconds) : failure.text}` });
      }
      if (adopt(s.csrf) || gen.current.n !== a.n) return; // another session: NOTHING is sent, and its generation closed the editor
      if (waitRef.current) return mark({ state: 'unresolved', note: `Not checked. ${pickerWaitText(waitLeft())}` });
      const latest = mine();
      const token = editToken.current;
      if (latest === null || latest.body !== a.body || token === null || token.key !== a.key || token.csrf !== s.csrf) return mark({ state: 'unresolved' });
      if (expired(latest)) return mark({ state: 'unresolved', body: '' });
      const answer = await drafts.updateDraft(a.storeId, a.draftId, a.body, a.key, token.csrf);
      await settleEdit(a.key, answer, false, since, token.csrf);
    } finally {
      if (editBusy.current.checking === id) editBusy.current.checking = 0;
    }
  }

  /** After a conflict: ONE fresh, authorized read of the draft for the comparison (and its Try again) — never a PATCH. */
  async function readConflict(): Promise<void> {
    const ed = editorRef.current;
    if (ed === null) return;
    ctl.current.review?.abort();
    const n = ++seq.current.review;
    const controller = new AbortController();
    ctl.current.review = controller;
    const since = sessionEndsSoFar();
    const stale = (): boolean => !alive.current || editorRef.current?.id !== ed.id || n !== seq.current.review || since !== sessionEndsSoFar();
    const put = (phase: 'loading' | 'ready' | 'failed', text: string, found: DraftDetail | null = null): void => patchEditor({ conflict: { phase, text, current: found } });
    if (waitRef.current) return put('failed', pickerWaitText(waitLeft()));
    put('loading', EDIT_TEXT.reviewLoading);
    const s = await connect();
    if (stale()) return;
    if (s.kind !== 'ok') {
      const failure = sessionFailure(s);
      if (failure.kind === 'signed-out') return failSession(failure);
      return put('failed', failure.seconds !== undefined ? pickerWaitText(startWait(failure.seconds)) : failure.text);
    }
    if (adopt(s.csrf)) return;
    const answer = await drafts.getDraft(ed.store.id, ed.base.id, s.csrf, controller.signal);
    if (stale()) return;
    if (answer.kind === 'ok') {
      put('ready', '', answer.draft);
      return resolveNames([answer.draft.customerId], s.csrf);
    }
    if (answer.kind === 'signed-out') return failSession({ kind: 'signed-out', text: DRAFTS_TEXT.ended });
    if (answer.kind === 'not-found') return put('failed', DRAFTS_TEXT.draftNotFound);
    if (answer.kind === 'denied') { // the reads' ONE fresh check: another token is a new generation (which closes the editor)
      const verdict = await denialOf(stale);
      if (verdict === null) return;
      return put('failed', verdict === 'denied' ? DRAFTS_TEXT.draftDenied : verdict.text);
    }
    const failure = readFailure(answer, DRAFTS_TEXT.draftDenied);
    put('failed', failure.seconds !== undefined ? pickerWaitText(startWait(failure.seconds)) : failure.text);
  }

  /**
   * "Discard my changes" after a conflict: local only — the editor now edits the server's draft the conflict's read found
   * (its customer as a reference for the editor's session), and nothing is sent. Returns that customer for the working
   * copy, or undefined when there is nothing to discard to.
   */
  function discardEdit(): ServerCustomerReference | null | undefined {
    const ed = editorRef.current;
    const found = ed?.conflict?.current ?? null;
    const csrf = gen.current.csrf;
    if (ed === null || found === null || ed.attempt !== null || csrf === null || gen.current.n !== ed.n) return undefined;
    const customer = serverCustomerReference({ id: found.customerId, name: customerText(found.customerId) }, uid, sessionContextOf(uid, csrf, ed.since));
    putEditor({ ...ed, base: found, customer, conflict: null, status: { alert: false, text: EDIT_TEXT.discarded(found.version) } });
    return customer;
  }

  // ---- discarding a saved draft (M7B-INVOICES-DISCARD-P1) ----

  /**
   * Discard draft…, from the reopen dialog: only on the server's `allowed` for exactly that dialog's store and draft under
   * this generation (checked again at the press), at a writable store, with no editor or confirmation up. The
   * confirmation names the draft the reopen read found; its version is what the discard will expect.
   */
  function openDiscard(): void {
    const r = reopenRef.current;
    const e = discardEligRef.current;
    if (r === null || r.draft === null || gen.current.csrf === null || e.phase !== 'allowed' || !current(e, 'discardElig')) return;
    if (editorRef.current !== null || discardRef.current !== null || issueRef.current !== null) return;
    const store = storesRef.current.stores.find((entry) => entry.id === r.storeId);
    if (store === undefined || store.readOnly) return;
    discardFocus.current = null;
    // An earlier refusal's line goes (inert beneath the confirmation): a later refusal mounts its alert afresh and is announced.
    if (r.refused !== '') putReopen({ ...r, refused: '' });
    putDiscard({ id: ++discardSeq.current, store, draft: r.draft, n: gen.current.n, pressed: false, attempt: null, status: null });
  }

  /**
   * One explicit Discard draft: at most one POST, and none during a rate limit's wait. The session is checked first:
   * another token starts a new generation (which drops both dialogs) and nothing is sent. The body is built from the
   * store's tenant and the version the reopen read found, the key minted, and the attempt frozen in the confirmation
   * BEFORE the request leaves; from then on this confirmation offers no Discard draft again (never a second key).
   */
  async function sendDiscard(): Promise<void> {
    const d = discardRef.current;
    if (d === null || d.pressed || discardBusy.current.sending === d.id || waitRef.current) return;
    const standing = (): boolean => alive.current && discardRef.current?.id === d.id;
    const say = (text: string): void => { if (standing()) patchDiscard({ status: { alert: true, text } }); };
    const body = draftDiscardBody(d.store.tenantId, d.draft.version);
    if (body === null) return say(DISCARD_TEXT.last);
    discardBusy.current.sending = d.id;
    try {
      const since = sessionEndsSoFar();
      const s = await connect();
      if (!standing()) return;
      if (since !== sessionEndsSoFar()) return say(`Not sent. ${DRAFTS_TEXT.ended}`);
      if (s.kind !== 'ok') {
        const failure = sessionFailure(s);
        if (failure.kind === 'signed-out') return failSession(failure);
        return say(`Not sent. ${failure.seconds !== undefined ? pickerWaitText(failure.seconds) : failure.text}`);
      }
      if (adopt(s.csrf) || gen.current.n !== d.n) return; // another session: its new generation dropped both dialogs
      if (waitRef.current) return say(`Not sent. ${pickerWaitText(waitLeft())}`);
      const key = nextKey();
      const attempt: EditAttempt = {
        key, body, storeId: d.store.id, draftId: d.draft.id, expectedVersion: d.draft.version, n: d.n,
        sentAt: clock(), sentWall: wall(), state: 'sending', note: '',
      };
      discardToken.current = { key, csrf: s.csrf };
      patchDiscard({ pressed: true, attempt, status: null });
      const answer = await drafts.discardDraft(attempt.storeId, attempt.draftId, body, key, s.csrf);
      await settleDiscard(key, answer, true, since, s.csrf);
    } finally {
      if (discardBusy.current.sending === d.id) discardBusy.current.sending = 0;
    }
  }

  /**
   * The draft is no longer open (a validated 200 — this attempt's, or its sealed replay — or a refusal saying it is not
   * open or not there): both dialogs close at once, the notice is said outside them, the draft's row leaves the list it
   * was listed in (so nothing returns focus to its Open), focus goes to the heading and page one is read again.
   */
  function endDiscard(a: EditAttempt, notice: string): void {
    discardToken.current = null;
    discardFocus.current = null;
    discardRef.current = null;
    reopenRef.current = null;
    const was = listRef.current;
    flushSync(() => {
      setDiscardState(null);
      setReopenState(null);
      if (was.storeId === a.storeId) putList({ ...was, rows: was.rows.filter((row) => row.id !== a.draftId) });
    });
    heading.current?.focus();
    setNotice(notice); // after the focus move: a change to the notice's standing live region, said after the heading
    if (storeRef.current === a.storeId) void readDrafts('first');
  }

  /** The confirmation closes and the reopen dialog under it says why (`refused`); it takes focus back once it has settled. */
  function backToReopen(draftId: string, refused: string): void {
    putDiscard(null);
    discardFocus.current = draftId;
    const r = reopenRef.current;
    if (r !== null && r.id === draftId) putReopen({ ...r, refused });
  }

  /**
   * One discard answer, applied BY KEY to the open confirmation's attempt: nothing once it closed or another opened (a
   * new generation, a session end, a sign-out, a store change, Close) or the section unmounted — the POST may still have
   * committed, and nothing here says so. `first`: every answer of a first send but unknown and in-progress decides it; a
   * Check again re-sends a key that may already have committed, so only CHECK_DISCARD_DECIDES do. A 429 starts the
   * section's wait only while the session that sent it is still the section's (as afterCreate).
   */
  async function settleDiscard(key: string, answer: DiscardDraftResult, first: boolean, since: number, csrf: string): Promise<void> {
    const mine = (): EditAttempt | null => {
      const a = alive.current ? discardRef.current?.attempt ?? null : null;
      return a !== null && a.key === key ? a : null;
    };
    const a = mine();
    if (a === null) return;
    if (answer.kind === 'rate-limited' && csrf === gen.current.csrf && since === sessionEndsSoFar()) startWait(answer.retryAfterSeconds);
    if (answer.kind === 'discarded') return endDiscard(a, DISCARD_TEXT.discarded);
    if (answer.kind === 'not-open' || answer.kind === 'not-found') return endDiscard(a, DISCARD_REFUSED_TEXT[answer.kind]);
    if (answer.kind === 'conflict') {
      // Never rebased: the confirmation closes, the reopen dialog reads the draft ONCE and says why; a new press, a new key.
      backToReopen(a.draftId, DISCARD_REFUSED_TEXT.conflict);
      return void readReopen(a.draftId, a.storeId, null, DISCARD_REFUSED_TEXT.conflict);
    }
    if (answer.kind === 'signed-out') return failSession({ kind: 'signed-out', text: DRAFTS_TEXT.ended });
    if (answer.kind === 'denied') {
      // The one fresh check, as the edit's: denied only for the same session (Discard draft… goes); a Check again's 403
      // leaves the attempt unresolved; a check that could not answer says so.
      const verdict = await denialOf(() => mine() === null);
      const now = verdict === null ? null : mine();
      if (verdict === null || now === null) return;
      if (verdict === 'denied') {
        if (!first) return patchDiscard({ attempt: { ...now, state: 'unresolved', note: reasonOf(answer) } });
        const e = discardEligRef.current;
        if (current(e, 'discardElig')) {
          ctl.current.discardElig?.abort();
          putDiscardElig({ ...e, seq: ++seq.current.discardElig, phase: 'denied', text: DISCARD_ELIGIBILITY_TEXT.denied });
        }
        return backToReopen(now.draftId, DISCARD_REFUSED_TEXT.denied);
      }
      const waits = verdict.kind === 'rate-limited'; // its wait has begun: Check again is held back through it
      if (first) return patchDiscard({ attempt: null, status: { alert: true, text: waits ? DISCARD_REFUSED_TEXT['rate-limited'] : DISCARD_TEXT.refusedUnchecked } });
      return patchDiscard({ attempt: { ...now, state: 'unresolved', note: waits ? verdict.text : EDIT_TEXT.checkUnchecked } });
    }
    const decisive = first ? answer.kind !== 'unknown' && answer.kind !== 'in-progress' : CHECK_DISCARD_DECIDES.has(answer.kind);
    if (decisive) return patchDiscard({ attempt: null, status: { alert: true, text: DISCARD_REFUSED_TEXT[answer.kind as DiscardRefusal] } });
    patchDiscard({ attempt: { ...(mine() ?? a), state: 'unresolved', note: reasonOf(answer) } });
  }

  /**
   * "Check again" in the confirmation: the SAME key and the SAME bytes to the attempt's OWN store and draft, under the
   * attempt's OWN token (discardToken) — only while the session check answers that very token and the generation it was
   * sent in is still the section's, outside a rate limit's wait, within the cutoff judged again right before the POST.
   */
  async function checkDiscard(): Promise<void> {
    const id = discardRef.current?.id ?? 0;
    const a = discardRef.current?.attempt ?? null;
    if (a === null || a.state !== 'unresolved' || a.body === '' || discardBusy.current.checking === id || waitRef.current) return;
    const mine = (): EditAttempt | null => {
      const now = alive.current ? discardRef.current?.attempt ?? null : null;
      return now !== null && now.key === a.key ? now : null;
    };
    const mark = (next: Partial<EditAttempt>): void => { const now = mine(); if (now !== null) patchDiscard({ attempt: { ...now, ...next } }); };
    if (expired(a)) return mark({ body: '' }); // too old: the confirmation now says so
    discardBusy.current.checking = id;
    mark({ state: 'checking', note: '' });
    try {
      const since = sessionEndsSoFar();
      const s = await connect();
      if (mine() === null) return;
      if (since !== sessionEndsSoFar()) return mark({ state: 'unresolved', note: `Not checked. ${DRAFTS_TEXT.ended}` });
      if (s.kind !== 'ok') {
        const failure = sessionFailure(s);
        if (failure.kind === 'signed-out') return failSession(failure);
        return mark({ state: 'unresolved', note: `Not checked. ${failure.seconds !== undefined ? pickerWaitText(failure.seconds) : failure.text}` });
      }
      if (adopt(s.csrf) || gen.current.n !== a.n) return; // another session: NOTHING is sent, and its generation dropped both dialogs
      if (waitRef.current) return mark({ state: 'unresolved', note: `Not checked. ${pickerWaitText(waitLeft())}` });
      const latest = mine();
      const token = discardToken.current;
      if (latest === null || latest.body !== a.body || token === null || token.key !== a.key || token.csrf !== s.csrf) return mark({ state: 'unresolved' });
      if (expired(latest)) return mark({ state: 'unresolved', body: '' });
      const answer = await drafts.discardDraft(a.storeId, a.draftId, a.body, a.key, token.csrf);
      await settleDiscard(a.key, answer, false, since, token.csrf);
    } finally {
      if (discardBusy.current.checking === id) discardBusy.current.checking = 0;
    }
  }

  /**
   * Keep draft, Close or Escape. Never pressed (nothing sent): only the confirmation closes, and the reopen dialog takes
   * focus back. Pressed — an attempt out or unresolved, or refused: tracking stops and the reopen dialog closes too (the
   * draft may no longer be open, and a later discard needs a fresh read and eligibility), and page one is read again;
   * nothing says it was cancelled or discarded.
   */
  function closeDiscard(): void {
    const d = discardRef.current;
    if (d === null) return;
    if (!d.pressed) return backToReopen(d.draft.id, reopenRef.current?.refused ?? '');
    const target = d.store.id;
    putDiscard(null);
    putReopen(null);
    if (storeRef.current !== target) return;
    // During a rate limit's wait readDrafts reads nothing: the rows stay, marked last known, with the wait and Try again.
    if (waitRef.current) return putList({ ...listRef.current, phase: 'rate-limited', text: pickerWaitText(waitLeft()), note: '', waitId: waitSeq.current });
    void readDrafts('first');
  }

  // ---- issuing a saved draft (M7B-INVOICES-ISSUE-P2) ----

  /** Page one of `storeId` again when it is the store chosen; during a wait the rows stay, marked last known, with the wait. */
  function rereadDrafts(storeId: string): void {
    if (storeRef.current !== storeId) return;
    if (waitRef.current) return putList({ ...listRef.current, phase: 'rate-limited', text: pickerWaitText(waitLeft()), note: '', waitId: waitSeq.current });
    void readDrafts('first');
  }

  /**
   * Issue invoice…, from the reopen dialog: only on the server's `allowed` for exactly that dialog's store and draft under
   * this generation (checked again at the press), at a writable store, with no editor or other confirmation up. The
   * confirmation opens empty ('opening': its live regions are in place before any text) and reads the preview from an
   * effect, once it is committed.
   */
  function openIssue(): void {
    const r = reopenRef.current;
    const e = issueEligRef.current;
    if (r === null || r.draft === null || gen.current.csrf === null || e.phase !== 'allowed' || !current(e, 'issueElig')) return;
    if (editorRef.current !== null || discardRef.current !== null || issueRef.current !== null) return;
    const store = storesRef.current.stores.find((entry) => entry.id === r.storeId);
    if (store === undefined || store.readOnly) return;
    putIssue({
      id: ++issueSeq.current, store, draftId: r.id, n: gen.current.n, phase: 'opening', text: '', preview: null, body: null, updated: false, key: null, pressed: false, status: null,
    });
  }

  /**
   * The confirmation's ONE preview read (and its Try again, and Review again's `updated` read): GET …/issue-preview, never a
   * POST. A ready preview's `expected` becomes the body, serialized once; anything that replaces it (a read again) takes the
   * body away first, so Issue invoice is offered only for the preview shown. Stale once that confirmation closed or was
   * replaced, its read cancelled, another generation began or a sign-out began since it asked.
   */
  async function readPreview(updated = false): Promise<void> {
    const d = issueRef.current;
    if (d === null) return;
    ctl.current.preview?.abort();
    const n = ++seq.current.preview;
    const controller = new AbortController();
    ctl.current.preview = controller;
    const since = sessionEndsSoFar();
    const stale = (): boolean => !alive.current || controller.signal.aborted || n !== seq.current.preview || issueRef.current?.id !== d.id || gen.current.n !== d.n
      || since !== sessionEndsSoFar();
    // `updated` is kept through loading, a failure and its Try again: the replacement is said as such once it is shown.
    const put = (phase: IssueState['phase'], text: string, preview: IssuePreview | null = null, body: string | null = null): void =>
      void patchIssue(d.id, { phase, text, preview, body, updated });
    if (waitRef.current) return put('rate-limited', pickerWaitText(waitLeft()));
    put('loading', ISSUE_TEXT.previewLoading);
    const s = await connect();
    if (stale()) return;
    if (s.kind !== 'ok') {
      const failure = sessionFailure(s);
      if (failure.kind === 'signed-out') return failSession(failure);
      return failure.seconds !== undefined ? put('rate-limited', pickerWaitText(startWait(failure.seconds))) : put('unavailable', ISSUE_TEXT.previewUnavailable);
    }
    if (adopt(s.csrf)) return; // a new generation dropped the confirmation
    const answer = await issuing.issuePreview(d.store.id, d.draftId, d.store.tenantId, s.csrf, controller.signal);
    if (stale()) return;
    if (answer.kind === 'ok') {
      const body = issueBodyOf(answer.preview.expected);
      return body === null ? put('unavailable', ISSUE_TEXT.previewUnavailable) : put('ready', updated ? ISSUE_TEXT.updated : '', answer.preview, body);
    }
    if (answer.kind === 'signed-out') return failSession({ kind: 'signed-out', text: DRAFTS_TEXT.ended });
    if (answer.kind === 'not-found') return put('refused', ISSUE_TEXT.previewNotFound);
    if (answer.kind === 'invalid-state') return put('refused', ISSUE_TEXT.previewLast);
    if (answer.kind === 'not-configured') return put('refused', ISSUE_TEXT.previewNotConfigured);
    if (answer.kind === 'out-of-range') return put('refused', ISSUE_TEXT.previewOutOfRange);
    if (answer.kind === 'rate-limited') return put('rate-limited', pickerWaitText(startWait(answer.retryAfterSeconds)));
    if (answer.kind === 'denied') {
      const verdict = await denialOf(stale); // the reads' one fresh check: another token is a new generation
      if (verdict === null) return;
      if (verdict === 'denied') {
        takeIssueAway(d.draftId);
        return put('refused', ISSUE_TEXT.previewDenied);
      }
      return verdict.kind === 'rate-limited' ? put('rate-limited', verdict.text) : put('unavailable', ISSUE_TEXT.previewUnavailable);
    }
    put('unavailable', ISSUE_TEXT.previewUnavailable);
  }
  // The confirmation's first read, once it is committed with its regions empty (never in the render that mounts it).
  const issueOpening = issue?.phase === 'opening' ? issue.id : 0;
  useEffect(() => { if (issueOpening !== 0) void readPreview(); }, [issueOpening]);

  /** A refusal of this session at `draftId`'s store stands: Issue invoice… goes from its reopen dialog (nothing is asked again on its own). */
  function takeIssueAway(draftId: string): void {
    const e = issueEligRef.current;
    if (!current(e, 'issueElig') || e.draftId !== draftId) return;
    ctl.current.issueElig?.abort();
    putIssueElig({ ...e, seq: ++seq.current.issueElig, phase: 'denied', text: ISSUE_ELIGIBILITY_TEXT.denied });
  }

  /**
   * One explicit Issue invoice: at most one POST, never during a wait, never while the user's earlier issue attempt is
   * live, and only for the preview shown. The session is checked first — another token starts a new generation (which
   * drops both dialogs) and nothing is sent — then the generation, the wait, the preview and the eligibility again; ONE
   * key is minted and the attempt held BEFORE the request leaves. Its answer settles it by key.
   */
  async function sendIssue(): Promise<void> {
    const d = issueRef.current;
    if (d === null || d.key !== null || issueSending.current === d.id) return;
    const say = (text: string): void => void patchIssue(d.id, { status: { alert: true, text } });
    if (waitRef.current) return say(`Not sent. ${pickerWaitText(waitLeft())}`);
    if (d.phase !== 'ready' || d.body === null) return;
    if (isLiveIssue(issues.get(uid))) return say(pendingTextOf(issues.get(uid)));
    issueSending.current = d.id; // a ref: a second activation in the same task sends nothing
    patchIssue(d.id, { status: null });
    try {
      const since = sessionEndsSoFar();
      const s = await connect();
      if (!alive.current || issueRef.current?.id !== d.id) return;
      if (since !== sessionEndsSoFar()) return say(`Not sent. ${DRAFTS_TEXT.ended}`);
      if (s.kind !== 'ok') {
        const failure = sessionFailure(s);
        if (failure.kind === 'signed-out') return failSession(failure);
        return say(`Not sent. ${failure.seconds !== undefined ? pickerWaitText(failure.seconds) : failure.text}`);
      }
      if (adopt(s.csrf) || gen.current.n !== d.n) return; // another session: its new generation dropped both dialogs
      if (waitRef.current) return say(`Not sent. ${pickerWaitText(waitLeft())}`);
      // Judged again on the confirmation as it is now: the same preview and body shown, nothing sent from it since.
      const latest = issueRef.current;
      if (latest === null || latest.id !== d.id || latest.phase !== 'ready' || latest.body !== d.body || latest.key !== null) return;
      const e = issueEligRef.current;
      if (e.phase !== 'allowed' || !current(e, 'issueElig') || e.draftId !== d.draftId) return say(ISSUE_TEXT.notAllowed);
      const key = nextKey();
      const attempt: HeldIssue = {
        key, body: d.body, storeId: d.store.id, draftId: d.draftId, storeLabel: storeLabel(d.store), csrf: s.csrf, sentAt: clock(), sentWall: wall(),
        state: 'sending', note: '', invoiceId: null, number: null, voided: false, refusal: null,
      };
      if (!issues.put(uid, attempt)) return say(pendingTextOf(issues.get(uid)));
      // The settled attempt it replaced takes its card read with it: cancelled, and its guard is let go.
      ctl.current.attempt?.abort();
      seq.current.attempt += 1;
      issueReading.current = null;
      patchIssue(d.id, { key, pressed: true, status: null });
      const answer = await issuing.issue(attempt.storeId, attempt.draftId, attempt.body, key, s.csrf);
      await settleIssueAnswer(key, answer, true, since, s.csrf);
    } finally {
      if (issueSending.current === d.id) issueSending.current = 0;
    }
  }

  /**
   * One issue answer (a first send's or a Check again's): settled BY KEY in the issue hold store (settleIssue), then what
   * it means here while the section is mounted and the attempt is still this session's — a 429 starts the section's wait
   * (only while the session that sent it is still the section's), a 403 gets the reads' ONE fresh check, a 401 ends the
   * session (and detaches the attempt), a 201 closes the dialogs and reads the invoice.
   */
  async function settleIssueAnswer(key: string, answer: IssueResult, first: boolean, since: number, csrf: string): Promise<void> {
    const sent = issues.get(uid);
    if (sent?.key !== key) return;
    // Detached since it was sent (a sign-out, another token, another user) or sent before a sign-out began: the late answer
    // proves nothing in this context and changes nothing — the attempt stays the earlier connection's note, with Dismiss.
    if (sent.csrf !== csrf || since !== sessionEndsSoFar()) { issues.detach(uid); return; }
    if (answer.kind === 'rate-limited' && alive.current && csrf === gen.current.csrf && since === sessionEndsSoFar()) startWait(answer.retryAfterSeconds);
    if (answer.kind === 'denied') {
      // A first send's 403 was refused before the key was acquired; a Check again's leaves the attempt unresolved. With no
      // section to check it under, or a check that could not answer, it still settles (never left "sending"), and is
      // never said as a lack of access it did not confirm. Detached meanwhile (another token found by the check, a
      // sign-out), it stays the earlier connection's note, as above.
      const unchecked = (): void => void issues.change(uid, key, first ? { state: 'refused', refusal: 'unchecked', body: '' } : { state: 'unresolved', note: ISSUE_TEXT.checkUnchecked });
      if (!alive.current || issueOf(key) === null) return unchecked();
      const verdict = await denialOf(() => issueOf(key) === null);
      if (issues.get(uid)?.key !== key || issueOf(key) === null) return;
      if (verdict === null) return unchecked();
      const draftId = issueOf(key)?.draftId ?? '';
      if (verdict === 'denied') takeIssueAway(draftId);
      if (first) return void issues.change(uid, key, { state: 'refused', refusal: verdict === 'denied' ? 'denied' : 'unchecked', body: '' });
      return void issues.change(uid, key, { state: 'unresolved', note: verdict === 'denied' ? ISSUE_TEXT.checkDenied : verdict.kind === 'rate-limited' ? verdict.text : ISSUE_TEXT.checkUnchecked });
    }
    settleIssue(issues, uid, key, answer, first);
    if (!alive.current) return;
    if (answer.kind === 'signed-out') return failSession({ kind: 'signed-out', text: DRAFTS_TEXT.ended });
    if (first && answer.kind === 'rate-limited') {
      // Refused before the key was acquired: nothing is held; a new press (a new key) once the wait has passed.
      const d = issueRef.current;
      if (d !== null && d.key === key) patchIssue(d.id, { key: null, status: { alert: true, text: ISSUE_TEXT.rateLimited } });
      return;
    }
    const h = issueOf(key);
    if (h === null) return;
    if (h.state === 'issued') return issuedNow(h);
    // The draft is no longer open: its row may be gone (page one again); the alert offers Find issued invoice.
    if (h.state === 'refused' && h.refusal === 'not-open') rereadDrafts(h.storeId);
  }

  /**
   * Issued (a validated 201, its replay, or Find): the confirmation and the reopen dialog of that draft close AT ONCE, its
   * row leaves the list it was listed in, focus goes to the heading (the row's Open is gone), the invoice is read for its
   * number (unless known) and page one is read again.
   */
  function issuedNow(h: HeldIssue): void {
    const ours = issueRef.current?.key === h.key;
    const open = reopenRef.current?.id === h.draftId;
    if (ours) issueRef.current = null;
    if (open || ours) reopenRef.current = null;
    const was = listRef.current;
    const read = h.number === null;
    flushSync(() => {
      if (ours) setIssueState(null);
      if (open || ours) setReopenState(null);
      if (was.storeId === h.storeId) putList({ ...was, rows: was.rows.filter((row) => row.id !== h.draftId) });
      if (read) setDetail({ key: h.key, phase: 'loading' }); // the card's first words are "Loading", never a failure
    });
    if (ours || open) heading.current?.focus();
    if (read) void loadIssued();
    rereadDrafts(h.storeId);
  }

  /**
   * The issued attempt's invoice, read ONCE for its number (a GET, never a POST) — and by "Load details again" — under
   * the session it was sent with: another token detaches the attempt. Never on a timer, a focus or a mount.
   */
  async function loadIssued(): Promise<void> {
    const h = issues.get(uid);
    if (h === undefined || h.state !== 'issued' || h.invoiceId === null || h.csrf === null || h.number !== null || h.refusal !== null || issueReading.current === h.key) return;
    const { key, storeId, invoiceId, csrf } = h;
    if (waitRef.current) return setDetail({ key, phase: 'failed' }); // nothing is read during a wait: Load details again after it
    issueReading.current = key;
    ctl.current.attempt?.abort();
    const n = ++seq.current.attempt;
    const controller = new AbortController();
    ctl.current.attempt = controller;
    const since = sessionEndsSoFar();
    const stale = (): boolean => !alive.current || controller.signal.aborted || n !== seq.current.attempt || since !== sessionEndsSoFar() || issueOf(key) === null;
    const fail = (): void => { if (!stale()) setDetail({ key, phase: 'failed' }); };
    setDetail({ key, phase: 'loading' });
    try {
      const s = await connect();
      if (stale()) return;
      if (s.kind !== 'ok') {
        const failure = sessionFailure(s);
        if (failure.kind === 'signed-out') return failSession(failure);
        if (failure.seconds !== undefined) startWait(failure.seconds);
        return fail();
      }
      if (s.csrf !== csrf) { issues.detach(uid); adopt(s.csrf); return; } // another session: read under none
      adopt(s.csrf);
      const answer = await issuing.getIssued(storeId, invoiceId, csrf, controller.signal);
      if (stale()) return;
      if (answer.kind === 'ok') {
        issues.change(uid, key, { number: answer.invoice.number, voided: answer.invoice.status === 'voided' });
        return setDetail(null);
      }
      if (answer.kind === 'signed-out') return failSession({ kind: 'signed-out', text: DRAFTS_TEXT.ended });
      if (answer.kind === 'rate-limited') startWait(answer.retryAfterSeconds);
      if (answer.kind === 'denied') {
        const verdict = await denialOf(stale);
        if (verdict === null) return;
        if (verdict === 'denied') { issues.change(uid, key, { refusal: 'denied' }); return setDetail(null); } // the refusal stands: nothing to read again
      }
      fail();
    } finally {
      if (issueReading.current === key) issueReading.current = null;
    }
  }

  /**
   * "Check again": the SAME key and the SAME bytes to the attempt's OWN store and draft, only under the token it was sent
   * with, outside a wait, while max(monotonic, wall) since its FIRST send is under 23 hours — judged again right before
   * the POST. Never on its own.
   */
  async function checkIssue(): Promise<void> {
    const h = issues.get(uid);
    if (h === undefined || h.state !== 'unresolved' || h.csrf === null || h.body === '' || issueChecking.current === h.key || issueReading.current === h.key || waitRef.current) return;
    if (expired(h)) { issues.change(uid, h.key, { body: '' }); return; } // too old: the card now says so
    const { key, body, csrf, storeId, draftId } = h;
    issueChecking.current = key;
    issues.change(uid, key, { state: 'checking', note: '' });
    try {
      const since = sessionEndsSoFar();
      const s = await connect();
      if (issues.get(uid)?.key !== key) return;
      // A sign-out began while the session was confirmed: nothing is sent and no token is taken from that answer.
      if (since !== sessionEndsSoFar()) return void issues.change(uid, key, { state: 'unresolved', note: `Not checked. ${DRAFTS_TEXT.ended}` });
      if (s.kind !== 'ok') {
        const failure = sessionFailure(s);
        issues.change(uid, key, { state: 'unresolved', note: `Not checked. ${failure.seconds !== undefined ? pickerWaitText(failure.seconds) : failure.text}` });
        if (alive.current && failure.kind === 'signed-out') failSession(failure);
        return;
      }
      if (s.csrf !== csrf) {
        // Another session answers now: the attempt is detached for good, and NOTHING is sent.
        issues.detach(uid);
        issues.change(uid, key, { state: 'unresolved' });
        if (alive.current) adopt(s.csrf);
        return;
      }
      if (alive.current) adopt(s.csrf);
      if (waitRef.current) return void issues.change(uid, key, { state: 'unresolved', note: `Not checked. ${pickerWaitText(waitLeft())}` });
      const latest = issues.get(uid);
      if (latest === undefined || latest.key !== key || latest.csrf !== csrf || latest.body !== body) return void issues.change(uid, key, { state: 'unresolved' });
      if (expired(latest)) return void issues.change(uid, key, { state: 'unresolved', body: '' });
      const answer = await issuing.issue(storeId, draftId, body, key, csrf);
      await settleIssueAnswer(key, answer, false, since, csrf);
    } finally {
      if (issueChecking.current === key) issueChecking.current = null;
    }
  }

  /**
   * The 23-hour window closes on its own: past the cutoff — max(monotonic, wall) since the FIRST send — the unresolved
   * attempt's held bytes go (the card then says it is too old). Judged by a timer, after every render and when the page
   * is shown again; it only takes the bytes away and never sends anything.
   */
  function scrubIssue(): void {
    const h = issues.get(uid);
    if (h !== undefined && h.state === 'unresolved' && h.body !== '' && expired(h)) issues.change(uid, h.key, { body: '' });
  }
  useEffect(() => {
    scrubIssue();
    const h = issues.get(uid);
    if (h === undefined || h.state !== 'unresolved' || h.body === '') return;
    const left = CHECK_CUTOFF_MS - Math.max(clock() - h.sentAt, wall() - h.sentWall);
    const timer = setTimeout(() => { scrubIssue(); setTick((n) => n + 1); }, Math.max(0, left)); // a render judges it again if early
    return () => clearTimeout(timer);
  });

  /**
   * "Find issued invoice": the store's issued invoices by this draft (GET …/invoices?sourceDraft=, the lookup alone) at
   * the ATTEMPT's store, only under the token it was sent with. One found settles it as issued; none found is said as
   * "not found yet" — never as not issued — and it stays as it was. Sends nothing else.
   */
  async function findIssue(): Promise<void> {
    const h = issues.get(uid);
    if (h === undefined || h.csrf === null || issueReading.current === h.key || waitRef.current) return;
    if (h.state !== 'unresolved' && !(h.state === 'refused' && h.refusal === 'not-open')) return;
    const { key, csrf, storeId, draftId } = h;
    const say = (note: string): void => void issues.change(uid, key, { note });
    issueReading.current = key;
    ctl.current.attempt?.abort();
    const n = ++seq.current.attempt;
    const controller = new AbortController();
    ctl.current.attempt = controller;
    setFinding(key);
    try {
      const since = sessionEndsSoFar();
      const stale = (): boolean => !alive.current || controller.signal.aborted || n !== seq.current.attempt || since !== sessionEndsSoFar() || issueOf(key) === null;
      const s = await connect();
      if (stale()) return;
      if (s.kind !== 'ok') {
        const failure = sessionFailure(s);
        if (failure.kind === 'signed-out') return failSession(failure);
        return say(`Not checked. ${failure.seconds !== undefined ? pickerWaitText(startWait(failure.seconds)) : failure.text}`);
      }
      if (s.csrf !== csrf) { issues.detach(uid); adopt(s.csrf); return; } // another session: nothing is read for it
      adopt(s.csrf);
      const answer = await issuing.findIssued(storeId, draftId, csrf, controller.signal);
      if (stale()) return;
      if (answer.kind === 'ok') {
        if (answer.invoice === null) return say(ISSUE_TEXT.findNone);
        issues.change(uid, key, { state: 'issued', invoiceId: answer.invoice.id, number: answer.invoice.number, voided: answer.invoice.status === 'voided', body: '', note: '', refusal: null });
        const now = issueOf(key);
        return now === null ? undefined : issuedNow(now);
      }
      if (answer.kind === 'signed-out') return failSession({ kind: 'signed-out', text: DRAFTS_TEXT.ended });
      if (answer.kind === 'rate-limited') return say(pickerWaitText(startWait(answer.retryAfterSeconds)));
      if (answer.kind === 'denied') {
        const verdict = await denialOf(stale);
        if (verdict === null) return;
        return say(verdict === 'denied' ? ISSUE_TEXT.findDenied : verdict.kind === 'rate-limited' ? verdict.text : ISSUE_TEXT.findUnavailable);
      }
      say(ISSUE_TEXT.findUnavailable);
    } finally {
      if (issueReading.current === key) issueReading.current = null;
      if (alive.current) setFinding((f) => (f === key ? null : f));
    }
  }

  /** "Review again" after a conflict: the preview read afresh in the same confirmation; a press then mints a NEW key. */
  function reviewIssue(): void {
    const d = issueRef.current;
    if (d === null || d.key === null) return;
    patchIssue(d.id, { key: null, status: null });
    void readPreview(true);
  }

  /**
   * Keep draft, Close or Escape. Nothing sent from it: only the confirmation closes (the reopen dialog takes focus back on
   * Issue invoice…). A key minted in it: tracking goes on outside (the card), the reopen dialog closes too (the draft may
   * no longer be open) and page one is read again; nothing says it was cancelled or issued.
   */
  function closeIssue(): void {
    const d = issueRef.current;
    if (d === null) return;
    ctl.current.preview?.abort();
    seq.current.preview += 1;
    putIssue(null);
    if (!d.pressed) return;
    putReopen(null);
    rereadDrafts(d.store.id);
  }

  /** Stop tracking or Dismiss on the card: never while a request of the attempt is out — unless it is detached (its late answer changes nothing). */
  function stopIssue(): void {
    const h = issues.get(uid);
    if (h === undefined || (h.csrf !== null && (h.state === 'sending' || h.state === 'checking')) || issueReading.current === h.key) return;
    issues.remove(uid, h.key);
    setDetail(null);
  }

  /** "View invoice": the issued invoice in the exported dialog, its read under this section's session. */
  function viewIssued(): void {
    const h = issues.get(uid);
    if (h === undefined || h.state !== 'issued' || h.invoiceId === null || h.csrf === null || issuedViewRef.current !== null) return;
    const next: IssuedViewOpen = { id: ++issuedViewSeq.current, storeId: h.storeId, invoiceId: h.invoiceId };
    issuedViewRef.current = next;
    setIssuedViewState(next);
  }
  /** The issued dialog's read (IssuedInvoiceDialog `read`): ServerIssuedInvoices.tsx readView's discipline under this section's generation. */
  async function readIssuedView(viewId: number, storeId: string, invoiceId: string, signal: AbortSignal): Promise<IssuedReadAnswer | null> {
    if (waitRef.current) return { kind: 'rate-limited', text: pickerWaitText(waitLeft()) };
    const mine = gen.current.n;
    const since = sessionEndsSoFar();
    const stale = (): boolean => !alive.current || signal.aborted || mine !== gen.current.n || since !== sessionEndsSoFar() || issuedViewRef.current?.id !== viewId;
    const s = await connect();
    if (stale()) return null;
    if (s.kind !== 'ok') {
      const failure = sessionFailure(s);
      if (failure.kind === 'signed-out') { failSession(failure); return null; }
      return failure.seconds !== undefined ? { kind: 'rate-limited', text: pickerWaitText(startWait(failure.seconds)) } : { kind: 'unavailable' };
    }
    if (adopt(s.csrf)) return null; // a new generation closed the dialog
    const answer = await issuing.getIssued(storeId, invoiceId, s.csrf, signal);
    if (stale()) return null;
    if (answer.kind === 'ok' || answer.kind === 'not-found') return answer;
    if (answer.kind === 'signed-out') { failSession({ kind: 'signed-out', text: DRAFTS_TEXT.ended }); return null; }
    if (answer.kind === 'denied') {
      const verdict = await denialOf(stale);
      if (verdict === null) return null;
      return verdict === 'denied' ? { kind: 'denied' } : verdict.kind === 'rate-limited' ? { kind: 'rate-limited', text: verdict.text } : { kind: 'unavailable' };
    }
    if (answer.kind === 'rate-limited') return { kind: 'rate-limited', text: pickerWaitText(startWait(answer.retryAfterSeconds)) };
    return { kind: 'unavailable' };
  }

  // A created attempt is read back ONCE (a GET, never a second POST), under the session it was sent with.
  useEffect(() => {
    if (held === undefined || held.state !== 'created' || held.draftId === null || readBack.current === held.key) return;
    const csrf = gen.current.csrf;
    if (csrf === null) return; // no session yet: the card says "saved" until one is confirmed
    const { key, storeId: target, draftId } = held;
    if (held.csrf !== csrf) {
      holds.remove(uid, key);
      return setNotice(DRAFTS_TEXT.savedEarlier);
    }
    readBack.current = key;
    const mine = gen.current.n;
    void drafts.getDraft(target, draftId, csrf).then((answer) => {
      // Gone or another connection meanwhile: the created attempt stays for the next section to say.
      if (!alive.current || mine !== gen.current.n) return void (readBack.current = null);
      holds.remove(uid, key);
      setNotice(answer.kind === 'ok' ? DRAFTS_TEXT.saved : DRAFTS_TEXT.savedUnread);
      if (storeRef.current === target) void readDrafts('first');
    });
  });

  /**
   * A changed session is noticed without a click, as in the picker: on a return to the tab, ONE plain check once a token
   * is fixed and while not signed out. Another token starts a new generation (and detaches a live attempt sent under the
   * old one); a definite end clears the views. It never sends a draft and never signs in after a confirmed end.
   */
  function checkSession(): void {
    // Also while a read is out: a new token starts a new generation, and that read's answer is then stale and dropped.
    if (document.visibilityState === 'hidden' || gen.current.csrf === null) return;
    if (storesRef.current.phase === 'signed-out') return;
    const mine = gen.current.n;
    void connect().then((s) => {
      if (!alive.current || mine !== gen.current.n) return;
      if (s.kind === 'ok') adopt(s.csrf);
      else if (s.kind === 'ended' || s.kind === 'refused' || s.kind === 'no-identity') failSession(sessionFailure(s));
    });
  }

  useLayoutEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);
  /**
   * After every commit, before paint (DA-199): once the tracked control is gone or disabled (a browser then moves focus
   * to <body>) — by the press on it (Show server drafts, Try again, Reconnect), a read's answer, a new generation, a
   * session end, a rate limit's wait, a page one that drops rows, or the role hint taking New away — focus still on it or
   * on <body> goes to the place named for it. Focus on another control or in a dialog is never taken, nor is anything
   * while a dialog holds the page inert (the dialog recovers its own focus), nor after a press elsewhere ended the
   * tracking (below).
   */
  useLayoutEffect(() => {
    const keep = keepFocus.current;
    if (keep === null || (keep.from.isConnected && (keep.from as HTMLButtonElement).disabled !== true)) return;
    keepFocus.current = null;
    const at = document.activeElement;
    if ((at === null || at === document.body || at === keep.from) && section.current?.closest('[inert]') === null) (keep.to() ?? heading.current)?.focus();
  });
  // M7B-INVOICES-DISCARD-P1: after a confirmation closed with nothing discarded, the reopen dialog under it takes focus
  // back once it has settled (its read and the discard's eligibility answered): Discard draft… when it is offered again,
  // else its Close. Before paint, and before DialogFrame's own recovery (a passive effect) could pick another control.
  useLayoutEffect(() => {
    const id = discardFocus.current;
    if (id === null || discardRef.current !== null) return;
    const r = reopenRef.current;
    if (r === null || r.id !== id) { discardFocus.current = null; return; }
    const e = discardEligRef.current;
    if (r.phase === 'loading' || (r.draft !== null && current(e, 'discardElig') && e.phase === 'checking')) return;
    discardFocus.current = null;
    // A control the user moved to while the dialog settled keeps focus: only an unmoved Close or a lost focus is taken.
    const at = document.activeElement;
    if (at !== null && at !== document.body && at.id !== VIEW_CLOSE_ID) return;
    (document.getElementById(DISCARD_OPEN_ID) ?? document.getElementById(VIEW_CLOSE_ID))?.focus();
  });
  // A press anywhere but on the tracked control is the user moving on — a press on plain text leaves focus on <body> with
  // no focus event — so the tracking ends there, and a later render that removes that control takes no focus from where
  // the user left it. A press, not blur or focusout: a browser may fire those when the focused control is REMOVED, the
  // very loss the recovery above is for. Captured, so it runs before the press moves any focus.
  useEffect(() => {
    const moved = (e: Event): void => {
      const keep = keepFocus.current;
      if (keep !== null && !(e.target instanceof Node && keep.from.contains(e.target))) keepFocus.current = null;
    };
    document.addEventListener('pointerdown', moved, true);
    return () => document.removeEventListener('pointerdown', moved, true);
  }, []);
  useEffect(() => {
    const check = (): void => { scrubIssue(); checkSession(); };
    window.addEventListener('focus', check);
    document.addEventListener('visibilitychange', check);
    // A sign-out, heard where it starts (the session client's `onSessionEnd`), while this section is mounted — on a
    // direct switch to another user AccessContext.tsx keeps it mounted until that user's profile has loaded. Everything
    // in flight is stale from here: a new generation with no token (a created draft's read-back answer is then ignored),
    // every read cancelled (the name queue with it), the reopen's read dropped, the new-draft dialog closed (its token
    // goes with it) and the editor closed (its working copy, customer and attempt go with it: failSession), and a rate
    // limit's wait ends with the session that was asked to wait (as `begin` drops another session's); the section says
    // the session ended. Nothing is read and nobody is signed in because of it — only the
    // user's Reconnect reads again.
    const unhear = onSessionEnd(() => {
      gen.current = { n: gen.current.n + 1, csrf: null };
      clearWait();
      setNewDraft(null);
      failSession({ kind: 'signed-out', text: DRAFTS_TEXT.ended });
    });
    return () => {
      unhear();
      window.removeEventListener('focus', check);
      document.removeEventListener('visibilitychange', check);
      gen.current = { n: gen.current.n + 1, csrf: null };
      for (const kind of ['stores', 'list', 'reopen', 'names', 'elig', 'editElig', 'discardElig', 'review', 'issueElig', 'preview', 'attempt'] as const) ctl.current[kind]?.abort();
      if (waitTimer.current !== null) clearTimeout(waitTimer.current);
    };
    // A section serves one UID (see ServerInvoiceDrafts); the clients are fixed for its life.
  }, []);

  const waiting = wait !== null;
  const signedOut = stores.phase === 'signed-out';
  const storesFailed = stores.phase === 'denied' || stores.phase === 'unavailable' || stores.phase === 'rate-limited' || signedOut;
  const listFailed = list.phase === 'denied' || list.phase === 'unavailable' || list.phase === 'rate-limited';
  const lastKnown = (list.phase === 'unavailable' || list.phase === 'rate-limited') && list.rows.length > 0;
  // Not `busy`: a list read never disables New. The refresh after a save runs while the closed dialog hands focus back to
  // New, and a New disabled for that read would send the focus to the heading instead (SID-13). Opening the dialog during
  // a read is harmless: Save confirms the session itself and sends nothing under another token.
  const newBlocked = live || waiting;
  const eligNow = current(elig) ? elig : null;
  const editEligNow = current(editElig, 'editElig') ? editElig : null;
  const discardEligNow = current(discardElig, 'discardElig') ? discardElig : null;
  const issueEligNow = current(issueElig, 'issueElig') ? issueElig : null;
  // A rate limit's wait is said once: by the list's note when it names the SAME wait, else by the eligibility's.
  const sameWait = eligNow?.phase === 'rate-limited' && list.phase === 'rate-limited' && list.waitId === eligNow.waitId;
  const eligText = eligNow === null || eligNow.phase === 'denied' || sameWait ? '' : eligNow.text;
  const describedBy = (...ids: Array<string | false>): string | undefined => (ids.filter(Boolean).join(' ') || undefined);
  /** Where focus goes when the editor closes: the draft's Open button in the list, when it is still there, else the heading. */
  const rowOrHeading = (id: string): RefObject<HTMLElement | null> => ({ get current() { return document.getElementById(openIdOf(id)) ?? heading.current; } });

  return (
    <section ref={section} onFocus={(e) => trackFocus(e.target)} data-testid="drafts-section" aria-labelledby="drafts-title" className="bg-white/80 backdrop-blur-xl rounded-[2.5rem] border border-slate-200 shadow-sm p-8 space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          {/* A programmatic focus target (a press that takes its own control away, a dialog's return, a view change that
              removes or disables the focused control): it shows the ring to a keyboard user. */}
          <h3 ref={heading} id="drafts-title" tabIndex={-1} className={`text-xl font-black text-primary tracking-tight ${focusRing}`}>Server drafts</h3>
          <p className="text-sm font-medium text-slate-600">{DRAFTS_TEXT.intro}</p>
        </div>
        {!open && <button type="button" data-testid="drafts-show" onClick={show} className={quiet}>Show server drafts</button>}
      </div>

      {/* Out here no dialog takes focus back: a press on this card hands focus to the section heading FIRST (as the
          Cancel path's returnFocus does), because the pressed control goes — Check again's whole row while the check
          runs, the card itself on Stop tracking or Dismiss — and focus on a removed control falls to <body>, where the
          next Tab starts over from the top of the page (WCAG 2.4.3). In the dialog, DialogFrame's recovery does it. */}
      {held !== undefined && newDraft === null && (
        <HoldCard
          held={held}
          expired={expired(held)}
          onCheck={() => { heading.current?.focus(); void checkAgain(); }}
          onStop={() => { heading.current?.focus(); stopTracking(); }}
          waiting={waiting}
        />
      )}
      {/* M7B-INVOICES-ISSUE-P2: the user's issue attempt outside the confirmation (its own card there while it shows it).
          Its status line is always mounted, so what it says is a change to a live region that is already there. A press on
          it hands focus to the heading first (its control goes), as the draft card's. */}
      <IssueCard
        held={issueHeld !== undefined && issue?.key !== issueHeld.key ? issueHeld : undefined}
        expired={issueHeld !== undefined && expired(issueHeld)} waiting={waiting} detail={detail?.key === issueHeld?.key ? detail?.phase ?? null : null}
        finding={finding !== null && finding === issueHeld?.key}
        onCheck={() => { if (waitRef.current) return; heading.current?.focus(); void checkIssue(); }} onFind={() => { if (waitRef.current) return; heading.current?.focus(); void findIssue(); }}
        onStop={() => { heading.current?.focus(); stopIssue(); }} onLoad={() => { if (waitRef.current) return; heading.current?.focus(); void loadIssued(); }} onView={viewIssued}
      />
      {/* Always mounted, so a notice is a change to a live region that is already there and is announced; it is the notice
          (`drafts-notice`) only while it says something. */}
      <p data-testid={notice === '' ? undefined : 'drafts-notice'} role="status" className="text-sm font-bold text-emerald-800">{notice}</p>

      {open && (
        <div className="space-y-4">
          {/* Said only while it is true — the stores were loaded again and are there to choose from, none chosen yet: a
              reload that failed (unavailable, denied, rate limited) or is still loading has nothing to choose from. */}
          {changed && stores.phase === 'ready' && stores.stores.length > 0 && storeId === '' && (
            <p data-testid="drafts-connection-changed" role="alert" className="text-sm font-bold text-amber-800">{DRAFTS_TEXT.connection}</p>
          )}
          {pending !== null && newDraft === null && <p data-testid="drafts-handoff" role="status" className="text-sm font-bold text-sky-900 break-words">{DRAFTS_TEXT.handoff(pending.name)}</p>}
          <p data-testid="drafts-stores-state" data-phase={stores.phase} role={stores.phase === 'denied' ? 'alert' : 'status'} className="text-sm font-bold text-slate-600 min-h-[1rem]">{stores.text}</p>
          {storesFailed && (
            <button type="button" data-testid="drafts-retry" disabled={busy || (waiting && !signedOut)} onClick={() => { void readStores(signedOut); }} className={button}>
              {signedOut ? 'Reconnect' : 'Try again'}
            </button>
          )}
          {stores.phase === 'ready' && stores.stores.length > 0 && (
            <div className="space-y-1">
              <label htmlFor="drafts-store" className={labelClass}>Store</label>
              <select
                id="drafts-store"
                data-testid="drafts-store"
                value={storeId}
                onChange={(e) => chooseStore(e.target.value)}
                className={`${inputClass} max-w-md`}
              >
                <option value="">Choose a store…</option>
                {stores.stores.map((store) => (
                  <option key={store.id} value={store.id}>{storeLabel(store)}{store.readOnly ? ' (read-only)' : ''}</option>
                ))}
              </select>
              {storeId === '' && <p data-testid="drafts-choose" className={hintClass}>{DRAFTS_TEXT.chooseStore}</p>}
            </div>
          )}

          {chosen !== null && (
            <div className="space-y-3">
              {chosen.readOnly ? (
                <p data-testid="drafts-read-only" role="status" className="text-sm font-bold text-amber-800">{DRAFTS_TEXT.readOnly}</p>
              ) : (
                <div className="flex flex-wrap items-center gap-3">
                  {eligNow?.phase === 'allowed' && (
                    <>
                      <button
                        ref={newButton}
                        type="button"
                        data-testid="drafts-new"
                        disabled={newBlocked}
                        aria-describedby={describedBy(live && 'drafts-new-hint', waiting && 'drafts-wait-hint')}
                        onClick={() => openNewDraft(pending)}
                        className={button}
                      >
                        New server draft
                      </button>
                      {live && <span id="drafts-new-hint" className={hintClass}>{NOT_SENT_TEXT.pending}</span>}
                    </>
                  )}
                  {/* The server's answer about New, said where New would be, in one live region that keeps its role (empty once
                      allowed); a refusal is an alert of its own, mounted only while it stands, so it is announced as one. */}
                  <p data-testid="drafts-elig" data-phase={eligNow?.phase ?? 'none'} role="status" className="text-sm font-bold text-slate-600">{eligText}</p>
                  {eligNow?.phase === 'denied' && <p data-testid="drafts-elig-alert" role="alert" className="text-sm font-bold text-rose-800">{eligNow.text}</p>}
                  {(eligNow?.phase === 'unavailable' || eligNow?.phase === 'rate-limited') && (
                    <button
                      type="button" data-testid="drafts-elig-retry" disabled={waiting} aria-describedby={describedBy(waiting && 'drafts-wait-hint')}
                      onClick={() => { void readEligibility(); }} className={button}
                    >
                      Try again
                    </button>
                  )}
                  {waiting && <span id="drafts-wait-hint" className="sr-only">{ELIGIBILITY_TEXT.waiting}</span>}
                </div>
              )}
              <p data-testid="drafts-list-state" data-phase={list.phase} role={list.phase === 'denied' ? 'alert' : 'status'} className="text-sm font-bold text-slate-600 min-h-[1rem]">
                {list.text}
                {lastKnown && <span data-testid="drafts-last-known" className="block text-xs font-black uppercase tracking-widest text-amber-800">{DRAFTS_TEXT.lastKnown}</span>}
                {list.phase === 'ready' && list.rows.length === 0 && <span data-testid="drafts-empty" className="block font-medium text-slate-600">{DRAFTS_TEXT.listEmpty}</span>}
              </p>
              {list.note !== '' && <p data-testid="drafts-note" role="status" className="text-sm font-bold text-amber-800">{list.note}</p>}
              {listFailed && (
                <button type="button" data-testid="drafts-list-retry" disabled={busy || waiting} onClick={() => { void readDrafts('first'); }} className={button}>Try again</button>
              )}
              {list.rows.length > 0 && (
                <ul data-testid="drafts-list" className="divide-y divide-slate-100 border border-slate-100 rounded-2xl">
                  {list.rows.map((row) => (
                    <li key={row.id} data-testid="drafts-row" data-id={row.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                      <div className="min-w-0 space-y-0.5">
                        <p className="text-sm font-bold text-primary break-words" data-testid="drafts-row-customer">{customerText(row.customerId)}</p>
                        <p className={hintClass} id={`drafts-row-${row.id}`}>
                          <span data-testid="drafts-row-created">{createdText(row.createdAt)}</span>
                          {' · '}<span data-testid="drafts-row-lines">{lineCountText(row.lineCount)}</span>
                          {' · '}<span data-testid="drafts-row-subtotal">Draft subtotal {formatCents(row.subtotalCents)}</span>
                        </p>
                      </div>
                      <button
                        type="button"
                        id={openIdOf(row.id)}
                        data-testid="drafts-open"
                        aria-label={`Open the draft created ${createdText(row.createdAt)}`}
                        aria-describedby={`drafts-row-${row.id}`}
                        onClick={() => { setNotice(''); void readReopen(row.id, list.storeId); }}
                        className={quiet}
                      >
                        Open
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              {list.phase === 'ready' && list.next !== null && (
                // aria-disabled, never disabled: a browser moves focus off a disabled control, and Load more keeps it
                // through its own read (a press meanwhile does nothing).
                <button
                  ref={loadMore}
                  type="button"
                  data-testid="drafts-load-more"
                  aria-disabled={busy || waiting}
                  onClick={() => { if (!busyRef.current && !waitRef.current) void readDrafts('more'); }}
                  className={`${quiet} aria-disabled:opacity-50 aria-disabled:cursor-not-allowed`}
                >
                  Load more
                </button>
              )}
            </div>
          )}
        </div>
      )}

      {reopen !== null && (
        <ReopenDialog
          state={reopen} customerText={customerText} store={stores.stores.find((s) => s.id === reopen.storeId) ?? null} onClose={() => putReopen(null)} returnFocus={heading}
          edit={editEligNow} waiting={waiting} onEdit={openEditor} onEditAgain={() => { void readEligibility(reopen.id); }}
          discard={discardEligNow} onDiscard={openDiscard} onDiscardAgain={() => { void readEligibility(reopen.id, 'discardElig'); }}
          issue={issueEligNow} onIssue={openIssue} onIssueAgain={() => { void readEligibility(reopen.id, 'issueElig'); }}
        />
      )}
      {issue !== null && (
        <IssueDialog
          state={issue} held={issue.key !== null && issueHeld?.key === issue.key ? issueHeld : undefined} expired={issueHeld !== undefined && expired(issueHeld)}
          waiting={waiting} pending={isLiveIssue(issueHeld) ? pendingTextOf(issueHeld) : ''} finding={finding !== null && finding === issue.key}
          onSend={sendIssue} onCheck={() => { void checkIssue(); }} onFind={() => { void findIssue(); }} onReview={reviewIssue}
          onRetry={() => { void readPreview(issue.updated); }} onClose={closeIssue} returnFocus={ISSUE_RETURN}
        />
      )}
      {issuedView !== null && (
        <IssuedInvoiceDialog
          key={issuedView.id} storeId={issuedView.storeId} invoiceId={issuedView.invoiceId} read={(s, i, signal) => readIssuedView(issuedView.id, s, i, signal)}
          current={() => alive.current && issuedViewRef.current?.id === issuedView.id} waiting={waiting} onClose={closeIssuedView}
          returnFocus={{ get current() { return document.getElementById(ISSUE_VIEW_ID) ?? heading.current; } }}
        />
      )}
      {discard !== null && (
        <DiscardDialog
          state={discard} customerText={customerText} expired={discard.attempt !== null && expired(discard.attempt)} waiting={waiting}
          onSend={sendDiscard} onCheck={() => { void checkDiscard(); }} onClose={closeDiscard} returnFocus={DISCARD_RETURN}
        />
      )}
      {editor !== null && (
        <EditDraftDialog
          uid={uid}
          state={editor}
          canViewCustomers={canViewCustomers}
          customerText={customerText}
          session={session}
          customers={customers}
          identity={identity}
          now={now}
          expired={editor.attempt !== null && expired(editor.attempt)}
          waiting={waiting}
          onSend={sendEdit}
          onCheck={() => { void checkEdit(); }}
          onDiscard={discardEdit}
          onReadAgain={() => { void readConflict(); }}
          onClose={() => putEditor(null)}
          returnFocus={rowOrHeading(editor.base.id)}
        />
      )}
      {newDraft !== null && (
        <NewDraftDialog
          uid={uid}
          state={newDraft}
          generation={gen}
          held={held}
          canViewCustomers={canViewCustomers}
          session={session}
          customers={customers}
          identity={identity}
          now={now}
          expired={held !== undefined && expired(held)}
          waiting={waiting}
          onSend={send}
          onCheck={() => { void checkAgain(); }}
          onStop={stopTracking}
          onClose={() => setNewDraft(null)}
          onRefusalShown={(key) => { holds.remove(uid, key); }}
          returnFocus={heading}
        />
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------------------------------------------------

function HoldCard({ held, expired, onCheck, onStop, waiting }: { readonly held: HeldDraft; readonly expired: boolean; readonly onCheck: () => void; readonly onStop: () => void; readonly waiting: boolean }) {
  const detached = held.csrf === null;
  if (held.state === 'created') {
    return <p data-testid="drafts-hold" data-state="created" role="status" className="text-sm font-bold text-emerald-800">{DRAFTS_TEXT.saved}</p>;
  }
  if (held.state === 'refused') {
    return (
      <div data-testid="drafts-hold" data-state="refused" className="p-4 rounded-2xl border border-rose-200 bg-rose-50 space-y-2">
        <p role="alert" className="text-sm font-bold text-rose-800">{REFUSED_TEXT[held.refusal ?? 'invalid']}</p>
        <button type="button" data-testid="drafts-hold-dismiss" onClick={onStop} className={quiet}>Dismiss</button>
      </div>
    );
  }
  const working = held.state === 'sending' || held.state === 'checking';
  const text = working ? (held.state === 'sending' ? HOLD_TEXT.sending : HOLD_TEXT.checking)
    : detached ? HOLD_TEXT.detached : expired || held.body === '' ? HOLD_TEXT.tooOld : HOLD_TEXT.unresolved;
  const checkable = !working && !detached && !expired && held.body !== '';
  return (
    <div data-testid="drafts-hold" data-state={detached ? 'detached' : held.state} className="p-4 rounded-2xl border border-amber-200 bg-amber-50 space-y-2">
      <p role="status" className="text-sm font-bold text-amber-900">{text}</p>
      {!detached && (
        <p data-testid="drafts-hold-what" className={hintClass}>
          {held.storeLabel} · {lineCountText(held.lineCount)} · Draft subtotal {formatCents(held.subtotalCents)}
        </p>
      )}
      {held.note !== '' && !working && <p data-testid="drafts-hold-note" className="text-xs font-bold text-amber-900">{held.note}</p>}
      {!working && (
        <div className="flex flex-wrap items-center gap-3">
          {checkable && <button type="button" data-testid="drafts-check-again" disabled={waiting} aria-describedby={waiting ? 'drafts-check-wait' : undefined} onClick={onCheck} className={button}>Check again</button>}
          {checkable && waiting && <span id="drafts-check-wait" data-testid="drafts-check-wait" className={hintClass}>{HOLD_TEXT.waiting}</span>}
          <button type="button" data-testid="drafts-stop" aria-describedby="drafts-stop-warning" onClick={onStop} className={quiet}>Stop tracking</button>
          <span id="drafts-stop-warning" className={hintClass}>{HOLD_TEXT.stopWarning}</span>
        </div>
      )}
    </div>
  );
}

/** What the reopen dialog says about an edit the server just confirmed, beside what its one read-back found. */
function savedText(saved: UpdatedDraft, state: ReopenState): string {
  const said = saved.changed ? EDIT_TEXT.saved(saved.version) : EDIT_TEXT.unchanged(saved.version);
  if (state.phase === 'loading') return said;
  if (state.draft === null) return `${said} ${EDIT_TEXT.unread}`;
  // A replayed answer confirms its own attempt only: the draft may have been edited again since.
  return state.draft.version > saved.version ? `${said} ${EDIT_TEXT.later(state.draft.version)}` : said;
}

function ReopenDialog({ state, customerText, store, onClose, returnFocus, edit, waiting, onEdit, onEditAgain, discard, onDiscard, onDiscardAgain, issue, onIssue, onIssueAgain }: {
  readonly state: ReopenState; readonly customerText: (id: string) => string; readonly store: StoreEntry | null;
  readonly onClose: () => void; readonly returnFocus: RefObject<HTMLElement | null>;
  /** The server's answer about Edit for this draft now (M7B-INVOICES-P2), or null (none asked: a read-only store, or not current). */
  readonly edit: EligState | null; readonly waiting: boolean; readonly onEdit: () => void; readonly onEditAgain: () => void;
  /** The server's answer about Discard for this draft now (M7B-INVOICES-DISCARD-P1), or null, as `edit`. */
  readonly discard: EligState | null; readonly onDiscard: () => void; readonly onDiscardAgain: () => void;
  /** The server's answer about Issue for this draft now (M7B-INVOICES-ISSUE-P2), or null, as `discard`. */
  readonly issue: EligState | null; readonly onIssue: () => void; readonly onIssueAgain: () => void;
}) {
  const closeButton = useRef<HTMLButtonElement | null>(null);
  const draft = state.draft;
  return (
    <DialogFrame labelledBy="draft-view-title" testId="draft-view" anchor="top" busy={state.phase === 'loading'} onClose={onClose} initialFocus={closeButton} returnFocus={returnFocus}>
      <div className="flex items-start justify-between gap-3">
        <h2 id="draft-view-title" className="text-xl font-black text-primary tracking-tight">Server draft</h2>
        <button ref={closeButton} type="button" id={VIEW_CLOSE_ID} data-testid="draft-view-close" onClick={onClose} className={quiet}>Close</button>
      </div>
      {state.saved !== null && <p data-testid="draft-view-saved" role="status" className="text-sm font-bold text-emerald-800">{savedText(state.saved, state)}</p>}
      {state.refused !== '' && <p data-testid="draft-view-discard-refused" role="alert" className="text-sm font-bold text-rose-800">{state.refused}</p>}
      {state.phase !== 'ready' && (
        <p data-testid="draft-view-state" data-phase={state.phase} role={state.phase === 'loading' ? 'status' : 'alert'} className="text-sm font-bold text-slate-600">{state.text}</p>
      )}
      {draft !== null && (
        <div className="space-y-3">
          <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
            <dt className={labelClass}>Customer</dt><dd data-testid="draft-view-customer" className="font-bold text-primary break-words">{customerText(draft.customerId)}</dd>
            <dt className={labelClass}>Store</dt><dd data-testid="draft-view-store" className="font-bold text-slate-700 break-words">{store !== null ? storeLabel(store) : `Store, ${idEndingText(draft.storeId)}`}</dd>
            <dt className={labelClass}>Created</dt><dd data-testid="draft-view-created" className="font-bold text-slate-700">{createdText(draft.createdAt)}</dd>
            <dt className={labelClass}>Status</dt><dd data-testid="draft-view-status" className="font-bold text-slate-700">Draft · USD</dd>
            <dt className={labelClass}>Version</dt><dd data-testid="draft-view-version" className="font-bold text-slate-700">{draft.version}</dd>
          </dl>
          {/* The lines table scrolls sideways inside its own named region, reached by Tab (the data-table reflow exception, which covers this table only; M7B-INVOICES-DISCARD-P1-R1): an amount never breaks. Measured (SDB-23): the largest amount the shop accepts ($90,071,992,547,409.91) twice in a row overflows the region at 600 and 320 CSS px and at 600 px with 24 px text, and fits at 1440 px; in those cells the dialog itself does not scroll sideways. Where the table fits, it is laid out as before. */}
          <div role="region" aria-label="Draft lines" tabIndex={0} data-testid="draft-view-lines-scroll" className={`overflow-x-auto ${focusRing}`}>
            <table data-testid="draft-view-lines" className="w-full text-left text-sm border-collapse">
              <caption className="sr-only">Draft lines</caption>
              <thead>
                <tr className="border-b border-slate-100">
                  <th scope="col" className={labelClass}>#</th>
                  <th scope="col" className={labelClass}>Description</th>
                  <th scope="col" className={`${labelClass} text-right`}>Quantity</th>
                  <th scope="col" className={`${labelClass} text-right`}>Unit price</th>
                  <th scope="col" className={`${labelClass} text-right`}>Line total</th>
                </tr>
              </thead>
              <tbody>
                {draft.lines.map((line) => (
                  <tr key={line.position} data-testid="draft-view-line" className="border-b border-slate-50">
                    <td className="py-1 pr-2 text-slate-500">{line.position}</td>
                    <td className="py-1 pr-2 font-bold text-slate-800 break-words">{line.description}</td>
                    <td className="py-1 pr-2 text-right">{line.quantity}</td>
                    <td className="py-1 pr-2 text-right">{formatCents(line.unitPriceCents)}</td>
                    <td className="py-1 text-right font-bold">{formatCents(line.lineTotalCents)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {/* Below sm the type steps down: at 320 px the largest amount can be wider than the dialog in 16 px heavy type, and break-words would split it. */}
          <p data-testid="draft-view-subtotal" className="text-right text-sm sm:text-base font-black text-primary break-words">Draft subtotal {formatCents(draft.subtotalCents)}</p>
          {/* Edit only on the server's answer; its other answers are said in one live region kept while it is asked. */}
          {/* M7B-INVOICES-ISSUE-P2 (review D5): its answer, whenever it lands, moves nothing below it (the discard's and the
              issue's rows): the row holds the height of its tallest answer (that text and Try again) from the asking on, as
              the discard row does (C8), through an invisible copy in the same grid cell. */}
          {edit !== null && (
            <div className="grid">
              <div aria-hidden="true" className="invisible col-start-1 row-start-1 flex flex-wrap items-center gap-3">
                <span data-reserve={EDIT_ELIGIBILITY_TEXT.unavailable} className="text-sm font-bold before:content-[attr(data-reserve)]" />
                <span data-reserve="Try again" className={`${quiet} before:content-[attr(data-reserve)]`} />
              </div>
              <div className="col-start-1 row-start-1 flex flex-wrap content-start items-center gap-3">
                {edit.phase === 'allowed' && <button type="button" data-testid="draft-view-edit" onClick={onEdit} className={button}>Edit draft</button>}
                <p data-testid="draft-view-edit-state" data-phase={edit.phase} role="status" className="text-sm font-bold text-slate-600">{edit.phase === 'allowed' ? '' : edit.text}</p>
                {(edit.phase === 'unavailable' || edit.phase === 'rate-limited') && (
                  <button
                    type="button" data-testid="draft-view-edit-retry" disabled={waiting} aria-describedby={waiting ? 'draft-view-edit-wait' : undefined}
                    aria-label="Try again: can this draft be edited" onClick={onEditAgain} className={quiet}
                  >
                    Try again
                  </button>
                )}
                {waiting && <span id="draft-view-edit-wait" className="sr-only">{EDIT_ELIGIBILITY_TEXT.waiting}</span>}
              </div>
            </div>
          )}
          {/* Discard only on the server's answer, and only at a writable store; asked or refused, nothing is shown or said. */}
          {/* The dialog is laid out from the top (anchor="top", M7B-INVOICES-DISCARD-P1-R1), so whatever this row grows to — Try again and its hint, wrapped at a narrow width or enlarged text — extends the dialog downward and never moves Close, the header or Edit draft. */}
          {/* One control's height is still held from the asking on, so an allowed answer (Discard draft…) or a denied one (403: nothing shown) does not change the dialog's height. */}
          {/* M7B-INVOICES-ISSUE-P2 (review C8): nor does an unavailable or rate-limited one (Try again and its hint), which would
              move Issue invoice… in the row below: the row holds the height of that tallest answer — wrapped at whatever width
              and text size — from the asking on, through an invisible copy of it in the same grid cell (its text is generated
              content, so the DOM says nothing more). */}
          {discard !== null && store !== null && !store.readOnly && (
            <div data-testid="draft-discard-row" className="grid">
              <div aria-hidden="true" className="invisible col-start-1 row-start-1 flex flex-wrap items-center gap-3">
                <span data-reserve="Try again" className={`${quiet} before:content-[attr(data-reserve)]`} />
                <span data-reserve={DISCARD_ELIGIBILITY_TEXT.unavailable} className={`${hintClass} before:content-[attr(data-reserve)]`} />
              </div>
              <div className="col-start-1 row-start-1 flex flex-wrap content-start items-center gap-3 min-h-[2.125rem]">
                {discard.phase === 'allowed' && <button type="button" id={DISCARD_OPEN_ID} data-testid="draft-discard-open" onClick={onDiscard} className={quiet}>Discard draft…</button>}
                {(discard.phase === 'unavailable' || discard.phase === 'rate-limited') && (
                  <>
                    <button
                      type="button" data-testid="draft-discard-elig-again" disabled={waiting} aria-label="Try again: can this draft be discarded"
                      aria-describedby={['draft-discard-elig-why', waiting && 'draft-discard-elig-wait'].filter(Boolean).join(' ')} onClick={onDiscardAgain} className={quiet}
                    >
                      Try again
                    </button>
                    <span id="draft-discard-elig-why" data-testid="draft-discard-elig-why" className={hintClass}>{discard.text}</span>
                    {waiting && <span id="draft-discard-elig-wait" className="sr-only">{DISCARD_ELIGIBILITY_TEXT.waiting}</span>}
                  </>
                )}
              </div>
            </div>
          )}
          {/* M7B-INVOICES-ISSUE-P2: Issue invoice… in a row of its own below, on the server's answer only, held to one control's
              height from the asking on (as the discard's): its answer, whenever it lands, moves nothing above it. */}
          {issue !== null && store !== null && !store.readOnly && (
            <div data-testid="draft-issue-row" className="flex flex-wrap items-center gap-3 min-h-[2.125rem]">
              {issue.phase === 'allowed' && <button type="button" id={ISSUE_OPEN_ID} data-testid="draft-issue-open" onClick={onIssue} className={quiet}>{ISSUE_TEXT.open}</button>}
              {(issue.phase === 'unavailable' || issue.phase === 'rate-limited') && (
                <>
                  <button
                    type="button" data-testid="draft-issue-elig-again" disabled={waiting} aria-label="Try again: can this draft be issued"
                    aria-describedby={['draft-issue-elig-why', waiting && 'draft-issue-elig-wait'].filter(Boolean).join(' ')} onClick={onIssueAgain} className={quiet}
                  >
                    Try again
                  </button>
                  <span id="draft-issue-elig-why" data-testid="draft-issue-elig-why" className={hintClass}>{issue.text}</span>
                  {waiting && <span id="draft-issue-elig-wait" className="sr-only">{ISSUE_ELIGIBILITY_TEXT.waiting}</span>}
                </>
              )}
            </div>
          )}
        </div>
      )}
    </DialogFrame>
  );
}

/**
 * The discard confirmation (M7B-INVOICES-DISCARD-P1): an alertdialog over the reopen dialog, named by its title and
 * described by ONE element — what a discard does and the draft it names, from the reopen read (no contact detail, no
 * reason field). "Keep draft" has the first focus; "Discard draft" sends (the section's sendDiscard) and is then gone for
 * good, and "Keep draft" reads "Close", which says — while an attempt is held — that closing only stops tracking.
 */
function DiscardDialog({ state, customerText, expired, waiting, onSend, onCheck, onClose, returnFocus }: {
  readonly state: DiscardState; readonly customerText: (id: string) => string; readonly expired: boolean; readonly waiting: boolean;
  readonly onSend: () => Promise<void>; readonly onCheck: () => void; readonly onClose: () => void; readonly returnFocus: RefObject<HTMLElement | null>;
}) {
  const keep = useRef<HTMLButtonElement | null>(null);
  const [saving, setSaving] = useState(false);
  const alive = useRef(false);
  useLayoutEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);
  async function send(): Promise<void> {
    if (saving || waiting) return;
    setSaving(true);
    try {
      await onSend();
    } finally {
      if (alive.current) setSaving(false);
    }
  }
  const { draft, attempt } = state;
  const working = attempt !== null && attempt.state !== 'unresolved';
  const old = attempt !== null && (expired || attempt.body === '');
  const text = attempt === null ? '' : attempt.state === 'sending' ? DISCARD_TEXT.sending : attempt.state === 'checking' ? DISCARD_TEXT.checking : old ? DISCARD_TEXT.tooOld : DISCARD_TEXT.unresolved;
  const identity = [
    customerText(draft.customerId), storeLabel(state.store), `created ${createdText(draft.createdAt)}`, lineCountText(draft.lines.length),
    `Draft subtotal ${formatCents(draft.subtotalCents)}`, `version ${draft.version}`, `draft ID ${draft.id}`,
  ].join(' · ');
  return (
    <DialogFrame
      role="alertdialog" labelledBy="draft-discard-title" describedBy="draft-discard-description" testId="draft-discard-confirm"
      busy={saving || working} onClose={onClose} initialFocus={keep} returnFocus={returnFocus}
    >
      <h2 id="draft-discard-title" className="text-xl font-black text-primary tracking-tight">{DISCARD_TEXT.title}</h2>
      <div id="draft-discard-description" data-testid="draft-discard-description" className="space-y-1">
        <p className="text-sm font-medium text-slate-700">{DISCARD_TEXT.explain}</p>
        <p data-testid="draft-discard-identity" className="text-sm font-bold text-primary break-words">{identity}</p>
      </div>
      {attempt !== null && (
        <div data-testid="draft-discard-attempt" data-state={attempt.state} className="p-4 rounded-2xl border border-amber-200 bg-amber-50 space-y-2">
          <p role="status" className="text-sm font-bold text-amber-900">{text}</p>
          {attempt.note !== '' && !working && <p data-testid="draft-discard-attempt-note" className="text-xs font-bold text-amber-900">{attempt.note}</p>}
          {!working && !old && (
            <div className="flex flex-wrap items-center gap-3">
              <button type="button" data-testid="draft-discard-check" disabled={waiting} aria-describedby={waiting ? 'draft-discard-check-wait' : undefined} onClick={onCheck} className={button}>
                Check again
              </button>
              {waiting && <span id="draft-discard-check-wait" className={hintClass}>{HOLD_TEXT.waiting}</span>}
            </div>
          )}
        </div>
      )}
      {state.status !== null && <p data-testid="draft-discard-status" role={state.status.alert ? 'alert' : 'status'} className="text-sm font-bold text-rose-800">{state.status.text}</p>}
      <div className="flex flex-wrap justify-end items-center gap-3">
        {attempt !== null && <span id="draft-discard-close-warning" data-testid="draft-discard-close-warning" className={hintClass}>{DISCARD_TEXT.closeWarning}</span>}
        <button
          ref={keep} type="button" data-testid="draft-discard-keep" aria-describedby={attempt !== null ? 'draft-discard-close-warning' : undefined}
          onClick={onClose} className={quiet}
        >
          {state.pressed ? 'Close' : 'Keep draft'}
        </button>
        {!state.pressed && (
          <>
            {waiting && !saving && <span id="draft-discard-send-wait" className={hintClass}>{DISCARD_TEXT.sendWaiting}</span>}
            <button
              type="button" data-testid="draft-discard-send" disabled={saving || waiting} aria-describedby={waiting && !saving ? 'draft-discard-send-wait' : undefined}
              onClick={() => { void send(); }} className={button}
            >
              Discard draft
            </button>
          </>
        )}
      </div>
    </DialogFrame>
  );
}

const waitable = `aria-disabled:opacity-50 aria-disabled:cursor-not-allowed`;

/**
 * The issue confirmation (M7B-INVOICES-ISSUE-P2): an alertdialog over the reopen dialog, laid out from the top, named by
 * its title and described by ONE sentence — what issuing does (the Total once the preview has answered; no payment; an
 * issued invoice can later be voided, M7B-INVOICES-VOID-P2). "Keep draft" (its header, the first focus) closes it with nothing sent; once a key was minted in it it reads
 * "Close", which says — while the attempt is out or unresolved — that closing does not cancel. What it reviews is the
 * server's preview only (InvoiceSnapshot). "Issue invoice" is there only while that preview is shown and nothing was sent
 * from it since; a refusal of the attempt is an alert that takes focus.
 */
function IssueDialog({ state, held, expired, waiting, pending, finding, onSend, onCheck, onFind, onReview, onRetry, onClose, returnFocus }: {
  readonly state: IssueState; readonly held: HeldIssue | undefined; readonly expired: boolean; readonly waiting: boolean;
  /** While the user has a live issue attempt (this one's or an earlier one): why Issue invoice is held back ('' for none). */
  readonly pending: string; readonly finding: boolean;
  readonly onSend: () => Promise<void>; readonly onCheck: () => void; readonly onFind: () => void; readonly onReview: () => void; readonly onRetry: () => void;
  readonly onClose: () => void; readonly returnFocus: RefObject<HTMLElement | null>;
}) {
  const keep = useRef<HTMLButtonElement | null>(null);
  const refusedRef = useRef<HTMLParagraphElement | null>(null);
  const previewRefusedRef = useRef<HTMLParagraphElement | null>(null);
  const [saving, setSaving] = useState(false);
  const alive = useRef(false);
  useLayoutEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);
  async function send(): Promise<void> {
    if (saving) return;
    setSaving(true);
    try {
      await onSend();
    } finally {
      if (alive.current) setSaving(false);
    }
  }
  const { preview, phase } = state;
  const attempt = held;
  const working = attempt?.state === 'sending' || attempt?.state === 'checking';
  const out = working || attempt?.state === 'unresolved';
  const old = attempt?.state === 'unresolved' && (expired || attempt.body === '');
  const attemptText = attempt === undefined ? '' : finding ? ISSUE_TEXT.finding : attempt.state === 'sending' ? ISSUE_TEXT.sending
    : attempt.state === 'checking' ? ISSUE_TEXT.checking : attempt.state === 'unresolved' ? (old ? ISSUE_TEXT.tooOld : ISSUE_TEXT.unresolved) : '';
  const refusal = attempt?.state === 'refused' ? ISSUE_REFUSED_TEXT[attempt.refusal ?? 'invalid'] : null;
  // A refusal takes focus as it is said (doc 12 §5 H): its message, not a control.
  useEffect(() => { if (refusal !== null) refusedRef.current?.focus(); }, [refusal, attempt?.key]);
  // So does a refusal of the preview read (DESIGN §6).
  useEffect(() => { if (phase === 'refused') previewRefusedRef.current?.focus(); }, [phase, state.text]);
  const canIssue = state.key === null && phase === 'ready' && state.body !== null;
  const why = saving ? 'draft-issue-send-saving' : waiting ? 'draft-issue-send-wait' : pending !== '' ? 'draft-issue-send-held' : undefined;
  const note = attempt !== undefined && attempt.note !== '' && !working && !finding ? attempt.note : '';
  return (
    <DialogFrame
      role="alertdialog" labelledBy="draft-issue-title" describedBy="draft-issue-description" testId="draft-issue-confirm" anchor="top"
      busy={phase === 'loading' || saving || working || finding} onClose={onClose} initialFocus={keep} returnFocus={returnFocus}
    >
      <div className="flex items-start justify-between gap-3">
        <h2 id="draft-issue-title" className="text-xl font-black text-primary tracking-tight">{ISSUE_TEXT.title}</h2>
        <button ref={keep} type="button" data-testid="draft-issue-keep" aria-describedby={out ? 'draft-issue-close-warning' : undefined} onClick={onClose} className={quiet}>
          {state.pressed ? 'Close' : 'Keep draft'}
        </button>
      </div>
      <p id="draft-issue-description" data-testid="draft-issue-description" className="text-sm font-medium text-slate-700">
        {ISSUE_TEXT.consequence(preview === null ? null : formatCents(preview.amounts.totalCents))}
      </p>
      {out && <p id="draft-issue-close-warning" data-testid="draft-issue-close-warning" className={hintClass}>{ISSUE_TEXT.closeWarning}</p>}
      {/* Always mounted (empty on the first render): loading, an outage, a wait and "the updated invoice" are changes to it. */}
      <p data-testid="draft-issue-preview-state" data-phase={phase} role="status" className="text-sm font-bold text-slate-600">{phase === 'refused' ? '' : state.text}</p>
      {phase === 'refused' && <p ref={previewRefusedRef} tabIndex={-1} data-testid="draft-issue-preview-refused" role="alert" className={`text-sm font-bold text-rose-800 ${focusRing}`}>{state.text}</p>}
      {(phase === 'unavailable' || phase === 'rate-limited') && (
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button" data-testid="draft-issue-preview-retry" aria-disabled={waiting} aria-describedby={waiting ? 'draft-issue-preview-wait' : undefined}
            aria-label="Try again: load the invoice to review" onClick={() => { if (!waiting) onRetry(); }} className={`${quiet} ${waitable}`}
          >
            Try again
          </button>
          {waiting && <span id="draft-issue-preview-wait" className="sr-only">{ISSUE_TEXT.waiting}</span>}
        </div>
      )}
      {preview !== null && (
        <div data-testid="draft-issue-preview" className="space-y-4">
          <InvoiceSnapshot prefix="draft-issue-preview" seller={preview.issuingSettings} customerName={preview.customer.name} lines={preview.draft.lines} amounts={preview.amounts} />
        </div>
      )}
      {/* The attempt this confirmation sent: its status line is mounted (empty) from the start. */}
      <div data-testid="draft-issue-attempt" data-state={attempt?.state ?? 'none'} className={attemptText !== '' || (note !== '' && attempt?.state !== 'refused') ? 'p-4 rounded-2xl border border-amber-200 bg-amber-50 space-y-2' : 'mb-0'}>
        <p data-testid="draft-issue-attempt-state" role="status" className="text-sm font-bold text-amber-900">{attemptText}</p>
        {note !== '' && attempt?.state !== 'refused' && <p data-testid="draft-issue-attempt-note" className="text-xs font-bold text-amber-900">{note}</p>}
        {attempt?.state === 'unresolved' && !finding && (
          <div className="flex flex-wrap items-center gap-3">
            {!old && (
              <button type="button" data-testid="draft-issue-check" aria-disabled={waiting} aria-describedby={waiting ? 'draft-issue-check-wait' : undefined} onClick={onCheck} className={`${button} ${waitable}`}>
                Check again
              </button>
            )}
            <button type="button" data-testid="draft-issue-find" aria-disabled={waiting} aria-describedby={waiting ? 'draft-issue-check-wait' : undefined} onClick={onFind} className={`${quiet} ${waitable}`}>
              Find issued invoice
            </button>
            {waiting && <span id="draft-issue-check-wait" className={hintClass}>{ISSUE_TEXT.waiting}</span>}
          </div>
        )}
      </div>
      {refusal !== null && (
        <div className="space-y-2">
          <p ref={refusedRef} tabIndex={-1} data-testid="draft-issue-refused" role="alert" className={`text-sm font-bold text-rose-800 ${focusRing}`}>{refusal}</p>
          {note !== '' && <p data-testid="draft-issue-attempt-note" className="text-xs font-bold text-slate-700">{note}</p>}
          {attempt?.refusal === 'conflict' && <button type="button" data-testid="draft-issue-review-again" onClick={onReview} className={quiet}>Review again</button>}
          {attempt?.refusal === 'not-open' && !finding && (
            <button type="button" data-testid="draft-issue-find" aria-disabled={waiting} aria-describedby={waiting ? 'draft-issue-find-wait' : undefined} onClick={onFind} className={`${quiet} ${waitable}`}>
              Find issued invoice
            </button>
          )}
          {attempt?.refusal === 'not-open' && waiting && <span id="draft-issue-find-wait" className="sr-only">{ISSUE_TEXT.waiting}</span>}
        </div>
      )}
      {state.status !== null && <p data-testid="draft-issue-status" role={state.status.alert ? 'alert' : 'status'} className="text-sm font-bold text-rose-800">{state.status.text}</p>}
      {canIssue && (
        <div className="flex flex-wrap justify-end items-center gap-3">
          {why === 'draft-issue-send-wait' && <span id={why} className={hintClass}>{ISSUE_TEXT.sendWaiting}</span>}
          {why === 'draft-issue-send-held' && <span id={why} className={hintClass}>{pending}</span>}
          {why === 'draft-issue-send-saving' && <span id={why} className="sr-only">{ISSUE_TEXT.sendChecking}</span>}
          <button
            type="button" data-testid="draft-issue-send" aria-disabled={saving || why !== undefined} aria-describedby={why}
            onClick={() => { void send(); }} className={`${button} ${waitable}`}
          >
            Issue invoice
          </button>
        </div>
      )}
    </DialogFrame>
  );
}

/**
 * The user's issue attempt outside the confirmation (M7B-INVOICES-ISSUE-P2): what it is doing or why it is not confirmed,
 * with Check again, Find issued invoice and Stop tracking; once issued, its number and store with View invoice (or Load
 * details again when the read failed) and Dismiss; a refusal; or, detached, that it belongs to an earlier connection. Its
 * status line is always mounted (empty and taking no space with no attempt).
 */
function IssueCard({ held, expired, waiting, detail, finding, onCheck, onFind, onStop, onLoad, onView }: {
  readonly held: HeldIssue | undefined; readonly expired: boolean; readonly waiting: boolean; readonly detail: 'loading' | 'failed' | null; readonly finding: boolean;
  readonly onCheck: () => void; readonly onFind: () => void; readonly onStop: () => void; readonly onLoad: () => void; readonly onView: () => void;
}) {
  const detached = held !== undefined && held.csrf === null;
  const old = held?.state === 'unresolved' && (expired || held.body === '');
  let text: ReactNode = '';
  if (held !== undefined && held.state !== 'refused') {
    if (detached) text = held.state === 'issued' ? ISSUE_TEXT.issuedEarlier : ISSUE_TEXT.detached;
    else if (finding) text = ISSUE_TEXT.finding;
    else if (held.state === 'sending') text = ISSUE_TEXT.sending;
    else if (held.state === 'checking') text = ISSUE_TEXT.checking;
    else if (held.state === 'issued') text = held.number !== null ? <>{issuedAround(held.number, held.voided)[0]}<bdi>{held.storeLabel}</bdi>{issuedAround(held.number, held.voided)[1]}</> : held.refusal === 'denied' ? ISSUE_TEXT.issuedDenied : detail === 'loading' ? ISSUE_TEXT.issuedLoading : ISSUE_TEXT.issuedUnread;
    else text = old ? ISSUE_TEXT.tooOld : ISSUE_TEXT.unresolved;
  }
  const busy = held === undefined || (!detached && (finding || held.state === 'sending' || held.state === 'checking' || (held.state === 'issued' && detail === 'loading')));
  const hold = waiting ? 'drafts-issue-wait' : undefined;
  return (
    <div
      data-testid="drafts-issue-hold" data-state={held === undefined ? 'none' : detached ? 'detached' : held.state}
      className={held === undefined ? 'mb-0' : 'p-4 rounded-2xl border border-amber-200 bg-amber-50 space-y-2'}
    >
      <p data-testid="drafts-issue-hold-status" role="status" className="text-sm font-bold text-amber-900">{text}</p>
      {held !== undefined && held.state === 'refused' && <p data-testid="drafts-issue-hold-refused" role="alert" className="text-sm font-bold text-rose-800">{held.refusal === 'unchecked' ? ISSUE_TEXT.uncheckedCard : ISSUE_REFUSED_TEXT[held.refusal ?? 'invalid']}</p>}
      {held !== undefined && !detached && held.note !== '' && !busy && <p data-testid="drafts-issue-hold-note" className="text-xs font-bold text-amber-900">{held.note}</p>}
      {held !== undefined && !busy && (
        <div className="flex flex-wrap items-center gap-3">
          {!detached && held.state === 'unresolved' && !old && (
            <button type="button" data-testid="drafts-issue-check" aria-disabled={waiting} aria-describedby={hold} onClick={onCheck} className={`${button} ${waitable}`}>Check again</button>
          )}
          {!detached && (held.state === 'unresolved' || (held.state === 'refused' && held.refusal === 'not-open')) && (
            <button type="button" data-testid="drafts-issue-find" aria-disabled={waiting} aria-describedby={hold} onClick={onFind} className={`${quiet} ${waitable}`}>Find issued invoice</button>
          )}
          {!detached && held.state === 'issued' && held.number !== null && <button type="button" id={ISSUE_VIEW_ID} data-testid="drafts-issue-view" onClick={onView} className={button}>View invoice</button>}
          {!detached && held.state === 'issued' && held.number === null && held.refusal === null && (
            <button type="button" data-testid="drafts-issue-load" aria-disabled={waiting} aria-describedby={hold} onClick={onLoad} className={`${quiet} ${waitable}`}>Load details again</button>
          )}
          {!detached && held.state === 'unresolved' ? (
            <>
              <button type="button" data-testid="drafts-issue-stop" aria-describedby="drafts-issue-stop-warning" onClick={onStop} className={quiet}>Stop tracking</button>
              <span id="drafts-issue-stop-warning" className={hintClass}>{ISSUE_TEXT.stopWarning}</span>
            </>
          ) : (
            <button type="button" data-testid="drafts-issue-dismiss" onClick={onStop} className={quiet}>Dismiss</button>
          )}
          {waiting && <span id="drafts-issue-wait" className="sr-only">{ISSUE_TEXT.waiting}</span>}
        </div>
      )}
    </div>
  );
}

interface LineDraft extends DraftLineFields { readonly key: number }
interface FormErrors {
  readonly customer: boolean;
  /** By line key (not position), so removing or moving a line never moves another line's error onto it. */
  readonly lines: ReadonlyMap<number, { readonly description: boolean; readonly quantity: boolean; readonly unitPrice: boolean; readonly total: boolean }>;
  readonly subtotal: boolean;
  /** The body would be over the server's 64 KiB bound (its 413): refused here, before a key exists. */
  readonly tooLarge: boolean;
}
const NO_ERRORS: FormErrors = Object.freeze({ customer: false, lines: new Map(), subtotal: false, tooLarge: false });
const NO_LINE_ERRORS = Object.freeze({ description: false, quantity: false, unitPrice: false, total: false });

/** What a built body says is wrong, by line key (`customer`: none is chosen). */
function formErrorsOf(lines: readonly LineDraft[], built: DraftBody, customer: boolean): FormErrors {
  return {
    customer,
    lines: new Map(lines.map((line, index) => [line.key, built.kind === 'invalid' ? built.lines[index] : NO_LINE_ERRORS])),
    subtotal: built.kind === 'invalid' && built.subtotal,
    tooLarge: built.kind === 'invalid' && built.tooLarge,
  };
}

/** Focus the first invalid field, in reading order: the customer, then each line's description, quantity, price. */
function focusFirstInvalid(root: HTMLElement | null, next: FormErrors, subtotalError: HTMLElement | null, sizeError: HTMLElement | null): void {
  if (root === null) return;
  const target = next.customer ? root.querySelector<HTMLElement>('[data-testid="picker-open"], [data-testid="picker-change"]')
    : root.querySelector<HTMLElement>('[aria-invalid="true"]') ?? (next.subtotal ? subtotalError : next.tooLarge ? sizeError : null);
  target?.focus();
}

/** The live Draft subtotal of the lines as typed: exact cents, or null while a line is incomplete or too large. */
function liveSubtotal(lines: readonly DraftLineFields[]): bigint | null {
  let sum = 0n;
  for (const line of lines) {
    const { total } = lineAmounts(line);
    if (total === null || total > MAX_CENTS) return null;
    sum += total;
  }
  return sum <= MAX_CENTS ? sum : null;
}

/** A saved draft's lines as the editor's fields hold them (M7B-INVOICES-P2), in order, each price as the dollar text it reads back. */
const linesOf = (draft: DraftDetail): readonly LineDraft[] =>
  draft.lines.map((line, index) => ({ key: index + 1, description: line.description, quantity: String(line.quantity), unitPrice: priceText(line.unitPriceCents) }));

/**
 * The lines of a draft being written — the new draft's and the editor's (M7B-INVOICES-P2) — with the live subtotal and
 * the form's subtotal and size errors. Each line's description, quantity and unit price; Remove (disabled at one line);
 * Add line (up to 50); and with `reorder` Move up and Move down. A line's Remove had focus and goes with it, so focus
 * is handed BEFORE the line goes to the neighbour where the user is — the next line's Remove, else the previous one's —
 * or, when one line is left (its Remove then disabled), to that line's description; never DialogFrame's fallback to line
 * 1, a jump up a long form. A move keeps focus on the moved line's own button (its other one where that one is now
 * disabled, at the first or last place) and says where the line went.
 */
function LinesEditor({ prefix, lines, setLines, errors, reorder = false, firstField, subtotalError, sizeError }: {
  /** The testids' prefix: 'draft-new' (the new draft) or 'draft-edit' (the editor). */
  readonly prefix: 'draft-new' | 'draft-edit';
  readonly lines: readonly LineDraft[]; readonly setLines: Dispatch<SetStateAction<readonly LineDraft[]>>; readonly errors: FormErrors;
  readonly reorder?: boolean;
  readonly firstField: MutableRefObject<HTMLElement | null>;
  readonly subtotalError: RefObject<HTMLParagraphElement | null>; readonly sizeError: RefObject<HTMLParagraphElement | null>;
}) {
  const lineKey = useRef(0); // the last key handed out: never one a line holds or held (errors are kept by key)
  const focusAfter = useRef<string | null>(null); // the control a move (or the 50th line's Add) hands focus to, after its render
  const [moved, setMoved] = useState('');
  useLayoutEffect(() => {
    const id = focusAfter.current;
    focusAfter.current = null;
    if (id !== null) document.getElementById(id)?.focus();
  });

  const setLine = (key: number, field: keyof DraftLineFields, value: string): void =>
    setLines((prev) => prev.map((line) => (line.key === key ? { ...line, [field]: value } : line)));
  const addLine = (): void => {
    if (lines.length >= MAX_DRAFT_LINES) return;
    lineKey.current = Math.max(lineKey.current, ...lines.map((line) => line.key)) + 1;
    const key = lineKey.current;
    // The 50th line disables Add line under the press: focus goes to that new line, never back to line 1.
    if (lines.length + 1 >= MAX_DRAFT_LINES) focusAfter.current = `draft-line-${key}-description`;
    setLines((prev) => [...prev, { key, description: '', quantity: '1', unitPrice: '' }]);
  };
  const removeLine = (key: number): void => {
    const at = lines.findIndex((line) => line.key === key);
    if (lines.length <= 1 || at < 0) return;
    const near = lines[at + 1] ?? lines[at - 1];
    document.getElementById(`draft-line-${near.key}-${lines.length > 2 ? 'remove' : 'description'}`)?.focus();
    setLines((prev) => prev.filter((line) => line.key !== key));
  };
  const moveLine = (key: number, by: -1 | 1): void => {
    const at = lines.findIndex((line) => line.key === key);
    const to = at + by;
    if (at < 0 || to < 0 || to >= lines.length) return;
    const next = [...lines];
    [next[at], next[to]] = [next[to], next[at]];
    const way = by < 0 ? (to > 0 ? 'up' : 'down') : (to < lines.length - 1 ? 'down' : 'up');
    focusAfter.current = `draft-line-${key}-${way}`;
    const text = `Line ${at + 1} moved to line ${to + 1}.`;
    setMoved((prev) => (prev === text ? `${text}\u00a0` : text)); // a repeat still changes the live region, so it is said again
    setLines(next);
  };

  const subtotal = liveSubtotal(lines);
  const describe = (id: string, bad: boolean): string | undefined => (bad ? id : undefined);
  return (
    <>
      <fieldset className="space-y-3">
        <legend className={labelClass}>Lines ({lines.length} of {MAX_DRAFT_LINES})</legend>
        {lines.map((line, index) => {
          const e = errors.lines.get(line.key) ?? NO_LINE_ERRORS;
          const n = index + 1;
          const base = `draft-line-${line.key}`;
          return (
            <div key={line.key} data-testid={`${prefix}-line`} className="grid grid-cols-12 gap-2 items-start p-3 rounded-2xl border border-slate-100">
              <div className="col-span-12 sm:col-span-6 space-y-1">
                <label htmlFor={`${base}-description`} className={labelClass}>Line {n} description</label>
                <input
                  ref={index === 0 ? (node) => { firstField.current = node; } : undefined}
                  id={`${base}-description`}
                  data-testid={`${prefix}-description`}
                  type="text"
                  autoComplete="off"
                  value={line.description}
                  aria-invalid={e.description}
                  aria-describedby={describe(`${base}-description-error`, e.description)}
                  onChange={(ev) => setLine(line.key, 'description', ev.target.value)}
                  className={inputClass}
                />
                {e.description && <p id={`${base}-description-error`} role="alert" className="text-xs font-bold text-rose-700">{DRAFT_RULE_TEXT.description}</p>}
              </div>
              <div className="col-span-4 sm:col-span-2 space-y-1">
                <label htmlFor={`${base}-quantity`} className={labelClass}>Line {n} quantity</label>
                <input
                  id={`${base}-quantity`}
                  data-testid={`${prefix}-quantity`}
                  type="text"
                  inputMode="numeric"
                  autoComplete="off"
                  value={line.quantity}
                  aria-invalid={e.quantity}
                  aria-describedby={describe(`${base}-quantity-error`, e.quantity)}
                  onChange={(ev) => setLine(line.key, 'quantity', ev.target.value)}
                  className={inputClass}
                />
                {e.quantity && <p id={`${base}-quantity-error`} role="alert" className="text-xs font-bold text-rose-700">{DRAFT_RULE_TEXT.quantity}</p>}
              </div>
              <div className="col-span-5 sm:col-span-3 space-y-1">
                <label htmlFor={`${base}-price`} className={labelClass}>Line {n} unit price ($)</label>
                <input
                  id={`${base}-price`}
                  data-testid={`${prefix}-price`}
                  type="text"
                  inputMode="decimal"
                  autoComplete="off"
                  value={line.unitPrice}
                  aria-invalid={e.unitPrice || e.total}
                  aria-describedby={describe(`${base}-price-error`, e.unitPrice || e.total)}
                  onChange={(ev) => setLine(line.key, 'unitPrice', ev.target.value)}
                  className={inputClass}
                />
                {(e.unitPrice || e.total) && <p id={`${base}-price-error`} role="alert" className="text-xs font-bold text-rose-700">{e.unitPrice ? DRAFT_RULE_TEXT.unitPrice : DRAFT_RULE_TEXT.total}</p>}
              </div>
              <div className={reorder ? 'col-span-12 flex flex-wrap gap-2' : 'col-span-3 sm:col-span-1 pt-5'}>
                {reorder && (
                  <>
                    <button
                      type="button" id={`${base}-up`} data-testid={`${prefix}-up`} aria-label={`Move line ${n} up`} disabled={index === 0}
                      onClick={() => moveLine(line.key, -1)} className={quiet}
                    >
                      ↑
                    </button>
                    <button
                      type="button" id={`${base}-down`} data-testid={`${prefix}-down`} aria-label={`Move line ${n} down`} disabled={index === lines.length - 1}
                      onClick={() => moveLine(line.key, 1)} className={quiet}
                    >
                      ↓
                    </button>
                  </>
                )}
                <button type="button" id={`${base}-remove`} data-testid={`${prefix}-remove-line`} aria-label={`Remove line ${n}`} disabled={lines.length <= 1} onClick={() => removeLine(line.key)} className={quiet}>×</button>
              </div>
            </div>
          );
        })}
        <button type="button" data-testid={`${prefix}-add-line`} disabled={lines.length >= MAX_DRAFT_LINES} onClick={addLine} className={quiet}>Add line</button>
        {reorder && <p data-testid={`${prefix}-moved`} role="status" className="sr-only">{moved}</p>}
      </fieldset>

      {/* Only the amount is live (atomic): a change reads the new amount, never the label again. */}
      <p data-testid={`${prefix}-subtotal`} className="text-right text-base font-black text-primary">
        Draft subtotal <span data-testid={`${prefix}-subtotal-amount`} aria-live="polite" aria-atomic="true">{subtotal === null ? '—' : formatCents(subtotal)}</span>
      </p>
      {/* Focused by focusFirstInvalid when they are the only errors: the ring shows a keyboard user where focus landed. */}
      {errors.subtotal && <p ref={subtotalError} tabIndex={-1} data-testid={`${prefix}-subtotal-error`} role="alert" className={`text-xs font-bold text-rose-700 text-right ${focusRing}`}>{DRAFT_RULE_TEXT.subtotal}</p>}
      {errors.tooLarge && <p ref={sizeError} tabIndex={-1} data-testid={`${prefix}-size-error`} role="alert" className={`text-xs font-bold text-rose-700 text-right ${focusRing}`}>{DRAFT_RULE_TEXT.tooLarge}</p>}
    </>
  );
}

function NewDraftDialog({
  uid, state, generation, held, canViewCustomers, session, customers, identity, now, expired, waiting, onSend, onCheck, onStop, onClose, onRefusalShown, returnFocus,
}: {
  readonly uid: string; readonly state: NewDraftState; readonly held: HeldDraft | undefined; readonly canViewCustomers: boolean;
  /** The section's generation, read (never written) by the hand-over's checks. */
  readonly generation: { readonly current: { readonly n: number; readonly csrf: string | null } };
  readonly session: TenantSessionClient; readonly customers: CustomersClient; readonly identity: Pick<ShopIdentity, 'idToken'>; readonly now?: () => number;
  readonly expired: boolean; readonly waiting: boolean;
  readonly onSend: (p: PreparedDraft) => Promise<SendOutcome>; readonly onCheck: () => void; readonly onStop: () => void; readonly onClose: () => void;
  readonly onRefusalShown: (key: string) => void; readonly returnFocus: RefObject<HTMLElement | null>;
}) {
  const [customer, setCustomer] = useState<ServerCustomerReference | null>(null);
  const [lines, setLines] = useState<readonly LineDraft[]>([{ key: 1, description: '', quantity: '1', unitPrice: '' }]);
  const [errors, setErrors] = useState<FormErrors>(NO_ERRORS);
  const [status, setStatus] = useState<{ readonly alert: boolean; readonly text: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [mine, setMine] = useState<string | null>(null); // the key of the attempt this dialog sent
  const alive = useRef(false);
  const dialogRoot = useRef<HTMLDivElement | null>(null);
  const firstField = useRef<HTMLElement | null>(null);
  const subtotalError = useRef<HTMLParagraphElement | null>(null);
  const sizeError = useRef<HTMLParagraphElement | null>(null);

  useLayoutEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  // A hand-over carries an id and a name only: this dialog confirms its own session, then mints its own reference.
  // M7B-INVOICES-P1-R2 (AC-07): only while everything it opened under still stands — no sign-out since (`since`), and the
  // section's generation and token unchanged (no new generation, no ended one). Checked before the session check is
  // even asked (so nothing is asked, and nobody signed in, for a session that is over) and again before its answer is
  // used: otherwise the answer changes nothing here, no customer, no context, no notice — the section says what happened.
  useEffect(() => {
    const given = state.handoff;
    if (given === null) return;
    const standing = (): boolean => alive.current && state.since === sessionEndsSoFar()
      && generation.current.n === state.n && generation.current.csrf === state.csrf;
    if (!standing()) return;
    void session.ensure(uid, () => identity.idToken(uid)).then((s) => {
      if (!standing()) return;
      if (s.kind === 'ok' && s.csrf === state.csrf) setCustomer(serverCustomerReference(given, uid, sessionContextOf(uid, s.csrf, state.since)));
      else setStatus({ alert: true, text: NOT_SENT_TEXT.customer });
    });
    // Once per dialog: the hand-over is fixed for its life.
  }, []);

  // This dialog's attempt: created closes it; a refusal is said here (the form is kept) and leaves the store.
  useEffect(() => {
    if (held === undefined || held.key !== mine) return;
    if (held.state === 'created') return onClose();
    if (held.state === 'refused') {
      setStatus({ alert: true, text: REFUSED_TEXT[held.refusal ?? 'invalid'] });
      if (held.refusal === 'customer-not-found') setCustomer(null);
      setMine(null);
      onRefusalShown(held.key);
    }
  }, [held, mine]);

  async function save(): Promise<void> {
    if (saving || isLiveHold(held) || waiting) return;
    const built = draftBody(state.store.tenantId, customer?.id ?? state.store.tenantId, lines);
    const next = formErrorsOf(lines, built, customer === null);
    setErrors(next);
    // Refused here: no key and no request.
    if (customer === null || built.kind === 'invalid') {
      setStatus(null);
      // After the render that marks the fields.
      return void setTimeout(() => focusFirstInvalid(dialogRoot.current, next, subtotalError.current, sizeError.current), 0);
    }
    setSaving(true);
    setStatus(null);
    try {
      const outcome = await onSend({ store: state.store, csrf: state.csrf, customer, body: built.body, lineCount: built.lineCount, subtotalCents: built.subtotalCents });
      if (!alive.current) return;
      if (outcome.kind === 'sent') return outcome.created ? onClose() : setMine(outcome.key);
      else if (outcome.kind === 'not-sent') {
        setStatus({ alert: true, text: outcome.text });
        if (outcome.text === NOT_SENT_TEXT.customer) setCustomer(null);
      }
    } finally {
      if (alive.current) setSaving(false);
    }
  }

  // The user's one live attempt (this dialog's, as only a dialog with none can send): its card, with Check again, is here.
  const liveHold = isLiveHold(held) ? held : undefined;
  const blocked = saving || liveHold !== undefined || waiting;
  const heldBack = liveHold !== undefined && !saving; // disabled by an earlier attempt, not by this press: said to Save
  const waitBack = waiting && !saving && !heldBack; // disabled by a rate limit's wait (a save's 429 starts one)

  return (
    <DialogFrame labelledBy="draft-new-title" testId="draft-new" busy={saving} onClose={onClose} returnFocus={returnFocus} initialFocus={firstField}>
      <div ref={dialogRoot} className="space-y-4">
        <div className="flex items-start justify-between gap-3">
          <h2 id="draft-new-title" className="text-xl font-black text-primary tracking-tight">New server draft</h2>
          <button type="button" data-testid="draft-new-cancel" onClick={onClose} className={quiet}>Cancel</button>
        </div>
        <p className="text-sm font-medium text-slate-600">
          For <span data-testid="draft-new-store" className="font-bold text-primary">{storeLabel(state.store)}</span>, in US dollars. Saving keeps it as a draft on the server.
        </p>

        <fieldset className="space-y-2" aria-describedby={errors.customer ? 'draft-new-customer-error' : undefined}>
          <legend className={labelClass}>Customer</legend>
          <ServerCustomerField
            uid={uid} value={customer} canView={canViewCustomers} invalid={errors.customer} errorId="draft-new-customer-error"
            onChange={(next) => { setCustomer(next); setErrors((e) => ({ ...e, customer: false })); }} session={session} customers={customers} identity={identity} now={now}
          />
          {errors.customer && <p id="draft-new-customer-error" data-testid="draft-new-customer-error" role="alert" className="text-xs font-bold text-rose-700">{DRAFT_RULE_TEXT.customer}</p>}
        </fieldset>

        <LinesEditor prefix="draft-new" lines={lines} setLines={setLines} errors={errors} firstField={firstField} subtotalError={subtotalError} sizeError={sizeError} />

        {liveHold !== undefined && <HoldCard held={liveHold} expired={expired} onCheck={onCheck} onStop={onStop} waiting={waiting} />}
        {status !== null && <p data-testid="draft-new-status" role={status.alert ? 'alert' : 'status'} className="text-sm font-bold text-rose-800">{status.text}</p>}

        <div className="flex justify-end gap-3">
          {heldBack && <span id="draft-new-save-hint" className="sr-only">{HOLD_TEXT.saveBlocked}</span>}
          {waitBack && <span id="draft-new-save-wait" className="sr-only">{HOLD_TEXT.saveWaiting}</span>}
          <button
            type="button" data-testid="draft-new-save" disabled={blocked}
            aria-describedby={heldBack ? 'draft-new-save-hint' : waitBack ? 'draft-new-save-wait' : undefined}
            onClick={() => { void save(); }} className={button}
          >
            Save draft
          </button>
        </div>
      </div>
    </DialogFrame>
  );
}

/** One line of a draft as text, for the conflict's comparison: never colour alone. */
const lineSummary = (n: number, description: string, quantity: string, price: string, total: string): string =>
  `${n}. ${description === '' ? '(no description)' : description} — ${quantity} × ${price} = ${total}`;

/** One side of the conflict's comparison: its customer, its lines in order and its subtotal, as text. */
function DraftSide({ testId, title, customer, lines, subtotal }: {
  readonly testId: string; readonly title: string; readonly customer: string; readonly lines: readonly string[]; readonly subtotal: string;
}) {
  return (
    <div data-testid={testId} className="space-y-1 p-3 rounded-2xl border border-slate-200 bg-white">
      <h4 className={labelClass}>{title}</h4>
      <p className="text-sm font-bold text-primary break-words">Customer: {customer}</p>
      <ol className="text-sm text-slate-800 space-y-0.5 break-words">{lines.map((line, index) => <li key={index}>{line}</li>)}</ol>
      <p className="text-sm font-black text-primary">Draft subtotal {subtotal}</p>
    </div>
  );
}

/** The unconfirmed attempt of the editor (M7B-INVOICES-P2): what it is doing or why it is not confirmed, and Check again. */
function EditAttemptCard({ attempt, expired, waiting, onCheck }: { readonly attempt: EditAttempt; readonly expired: boolean; readonly waiting: boolean; readonly onCheck: () => void }) {
  const working = attempt.state !== 'unresolved';
  const old = expired || attempt.body === '';
  const text = attempt.state === 'sending' ? EDIT_TEXT.saving : attempt.state === 'checking' ? EDIT_TEXT.checking : old ? EDIT_TEXT.tooOld : EDIT_TEXT.unresolved;
  return (
    <div data-testid="draft-edit-attempt" data-state={attempt.state} className="p-4 rounded-2xl border border-amber-200 bg-amber-50 space-y-2">
      <p role="status" className="text-sm font-bold text-amber-900">{text}</p>
      {attempt.note !== '' && !working && <p data-testid="draft-edit-attempt-note" className="text-xs font-bold text-amber-900">{attempt.note}</p>}
      {!working && !old && (
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button" data-testid="draft-edit-check-again" disabled={waiting} aria-describedby={waiting ? 'draft-edit-check-wait' : undefined}
            onClick={onCheck} className={button}
          >
            Check again
          </button>
          {waiting && <span id="draft-edit-check-wait" className={hintClass}>{HOLD_TEXT.waiting}</span>}
        </div>
      )}
    </div>
  );
}

/**
 * The editor (M7B-INVOICES-P2): a working copy of one saved draft — its customer and its ordered lines — seeded from the
 * detail the reopen dialog read, and only ever sent by Save or Reapply (the section's sendEdit). The section owns its
 * attempt and its conflict; the working copy lives here, so closing the editor drops it.
 */
function EditDraftDialog({
  uid, state, canViewCustomers, customerText, session, customers, identity, now, expired, waiting, onSend, onCheck, onDiscard, onReadAgain, onClose, returnFocus,
}: {
  readonly uid: string; readonly state: EditorState; readonly canViewCustomers: boolean; readonly customerText: (id: string) => string;
  readonly session: TenantSessionClient; readonly customers: CustomersClient; readonly identity: Pick<ShopIdentity, 'idToken'>; readonly now?: () => number;
  readonly expired: boolean; readonly waiting: boolean;
  readonly onSend: (p: PreparedEdit) => Promise<void>; readonly onCheck: () => void;
  readonly onDiscard: () => ServerCustomerReference | null | undefined; readonly onReadAgain: () => void;
  readonly onClose: () => void; readonly returnFocus: RefObject<HTMLElement | null>;
}) {
  const [customer, setCustomer] = useState<ServerCustomerReference | null>(state.customer);
  const [lines, setLines] = useState<readonly LineDraft[]>(() => linesOf(state.base));
  const [errors, setErrors] = useState<FormErrors>(NO_ERRORS);
  const [saving, setSaving] = useState(false);
  const alive = useRef(false);
  const dialogRoot = useRef<HTMLDivElement | null>(null);
  const firstField = useRef<HTMLElement | null>(null);
  const subtotalError = useRef<HTMLParagraphElement | null>(null);
  const sizeError = useRef<HTMLParagraphElement | null>(null);

  useLayoutEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  const attempt = state.attempt;
  const conflict = state.conflict;
  const found = conflict?.current ?? null;

  /** The body built ONCE from the working copy at `version`; an invalid form is marked here and nothing is sent (no key). */
  function prepare(version: number): PreparedEdit | null {
    const built = draftEditBody(state.store.tenantId, version, customer?.id ?? state.store.tenantId, lines);
    const next = formErrorsOf(lines, built, customer === null);
    setErrors(next);
    if (customer === null || built.kind === 'invalid') {
      setTimeout(() => focusFirstInvalid(dialogRoot.current, next, subtotalError.current, sizeError.current), 0); // after the render that marks the fields
      return null;
    }
    return { body: built.body, expectedVersion: version, customer };
  }
  async function send(p: PreparedEdit | null): Promise<void> {
    if (p === null) return;
    setSaving(true);
    try {
      await onSend(p);
    } finally {
      if (alive.current) setSaving(false);
    }
  }
  const idle = !saving && attempt === null && !waiting;
  const atLast = state.base.version > MAX_EXPECTED_VERSION; // no save can expect it: said, never a silent no-op
  const foundAtLast = found !== null && found.version > MAX_EXPECTED_VERSION;
  const save = (): void => { if (idle && conflict === null && !atLast) void send(prepare(state.base.version)); };
  // The same working copy, at the version the conflict's read found; the section mints a NEW key for it.
  const reapply = (): void => {
    if (!idle || found === null || foundAtLast) return;
    const p = prepare(found.version);
    void send(p === null ? null : { ...p, base: found });
  };
  const discard = (): void => {
    if (found === null || saving || attempt !== null) return;
    const seeded = onDiscard();
    if (seeded === undefined) return;
    setCustomer(seeded);
    setLines(linesOf(found));
    setErrors(NO_ERRORS);
  };

  const blocked = !idle || conflict !== null || atLast;
  const locked = saving || attempt !== null;
  // Why Save (or Reapply) is disabled, said to it — not while its own press is under way.
  const why = saving ? undefined : attempt !== null ? 'draft-edit-save-held' : waiting ? 'draft-edit-save-wait' : conflict !== null ? 'draft-edit-save-conflict'
    : atLast ? 'draft-edit-save-last' : undefined;
  const reapplyWhy = saving ? undefined : waiting ? 'draft-edit-reapply-wait' : foundAtLast ? 'draft-edit-reapply-last' : undefined;
  const mineSubtotal = liveSubtotal(lines);

  return (
    <DialogFrame labelledBy="draft-edit-title" testId="draft-edit" busy={saving || (attempt !== null && attempt.state !== 'unresolved')} onClose={onClose} returnFocus={returnFocus} initialFocus={firstField}>
      <div ref={dialogRoot} className="space-y-4">
        <div className="flex items-start justify-between gap-3">
          <h2 id="draft-edit-title" className="text-xl font-black text-primary tracking-tight">Edit server draft</h2>
          <button type="button" data-testid="draft-edit-cancel" aria-describedby="draft-edit-cancel-hint" onClick={onClose} className={quiet}>Cancel</button>
        </div>
        <p className="text-sm font-medium text-slate-600">
          For <span data-testid="draft-edit-store" className="font-bold text-primary">{storeLabel(state.store)}</span>, in US dollars, version{' '}
          <span data-testid="draft-edit-version" className="font-bold text-primary">{state.base.version}</span>. Saving replaces this draft's customer and lines on the server.
        </p>
        {/* Once a request is out, closing no longer leaves the server's draft as it was: the hint says so then. */}
        <p id="draft-edit-cancel-hint" data-testid="draft-edit-cancel-hint" className={hintClass}>{attempt === null ? EDIT_TEXT.cancelHint : EDIT_TEXT.closeWarning}</p>

        {/* Locked from Save's press while its request is out or unconfirmed: the screen keeps showing what was sent. */}
        <fieldset disabled={locked} data-testid="draft-edit-working" className="space-y-4 border-0 p-0 m-0 min-w-0">
          <fieldset className="space-y-2" aria-describedby={errors.customer ? 'draft-edit-customer-error' : undefined}>
            <legend className={labelClass}>Customer</legend>
            <ServerCustomerField
              uid={uid} value={customer} canView={canViewCustomers} invalid={errors.customer} errorId="draft-edit-customer-error"
              onChange={(next) => { setCustomer(next); setErrors((e) => ({ ...e, customer: false })); }} session={session} customers={customers} identity={identity} now={now}
            />
            {/* Without the local Customers View hint the field shows no customer: the draft's own is kept, as the server named it. */}
            {!canViewCustomers && customer !== null && <p data-testid="draft-edit-customer-kept" className="text-sm font-bold text-primary break-words">{EDIT_TEXT.kept(customer.name)}</p>}
            {errors.customer && <p id="draft-edit-customer-error" data-testid="draft-edit-customer-error" role="alert" className="text-xs font-bold text-rose-700">{DRAFT_RULE_TEXT.customer}</p>}
          </fieldset>

          <LinesEditor prefix="draft-edit" lines={lines} setLines={setLines} errors={errors} reorder firstField={firstField} subtotalError={subtotalError} sizeError={sizeError} />
        </fieldset>

        {conflict !== null && (
          <section data-testid="draft-edit-conflict" data-phase={conflict.phase} aria-labelledby="draft-edit-conflict-title" className="p-4 rounded-2xl border border-amber-200 bg-amber-50 space-y-3">
            <h3 id="draft-edit-conflict-title" className={labelClass}>Your changes and the draft on the server now</h3>
            {conflict.phase !== 'ready' && <p data-testid="draft-edit-conflict-state" role="status" className="text-sm font-bold text-amber-900">{conflict.text}</p>}
            {conflict.phase === 'failed' && (
              <button type="button" data-testid="draft-edit-read-again" disabled={waiting} aria-describedby={waiting ? 'draft-edit-read-wait' : undefined} onClick={onReadAgain} className={quiet}>
                Try again
              </button>
            )}
            {conflict.phase === 'failed' && waiting && <span id="draft-edit-read-wait" className="sr-only">{EDIT_TEXT.readWaiting}</span>}
            {found !== null && (
              <>
                <div className="grid sm:grid-cols-2 gap-3">
                  <DraftSide
                    testId="draft-edit-server" title={`On the server now (version ${found.version})`} customer={customerText(found.customerId)} subtotal={formatCents(found.subtotalCents)}
                    lines={found.lines.map((line) => lineSummary(line.position, line.description, String(line.quantity), formatCents(line.unitPriceCents), formatCents(line.lineTotalCents)))}
                  />
                  <DraftSide
                    testId="draft-edit-mine" title="Your changes (not saved)" customer={customer?.name ?? 'None selected'} subtotal={mineSubtotal === null ? '—' : formatCents(mineSubtotal)}
                    lines={lines.map((line, index) => {
                      const { quantity, cents, total } = lineAmounts(line); // as typed where a field does not parse
                      return lineSummary(
                        index + 1, line.description.trim(), quantity === null ? line.quantity.trim() : String(quantity),
                        cents === null ? line.unitPrice.trim() : formatCents(cents), total === null ? '—' : formatCents(total),
                      );
                    })}
                  />
                </div>
                <div className="flex flex-wrap gap-3">
                  {reapplyWhy === 'draft-edit-reapply-wait' && <span id={reapplyWhy} className="sr-only">{EDIT_TEXT.reapplyWaiting}</span>}
                  {reapplyWhy === 'draft-edit-reapply-last' && <span id={reapplyWhy} className="sr-only">{EDIT_TEXT.saveLast}</span>}
                  <button type="button" data-testid="draft-edit-reapply" disabled={!idle || foundAtLast} aria-describedby={reapplyWhy} onClick={reapply} className={button}>
                    Reapply my changes
                  </button>
                  <button type="button" data-testid="draft-edit-discard" disabled={saving || attempt !== null} onClick={discard} className={quiet}>Discard my changes</button>
                </div>
              </>
            )}
          </section>
        )}

        {attempt !== null && <EditAttemptCard attempt={attempt} expired={expired} waiting={waiting} onCheck={onCheck} />}
        {state.status !== null && <p data-testid="draft-edit-status" role={state.status.alert ? 'alert' : 'status'} className={`text-sm font-bold ${state.status.alert ? 'text-rose-800' : 'text-slate-700'}`}>{state.status.text}</p>}

        <div className="flex justify-end gap-3">
          {why === 'draft-edit-save-held' && <span id={why} className="sr-only">{EDIT_TEXT.saveHeld}</span>}
          {why === 'draft-edit-save-wait' && <span id={why} className="sr-only">{EDIT_TEXT.saveWaiting}</span>}
          {why === 'draft-edit-save-conflict' && <span id={why} className="sr-only">{EDIT_TEXT.saveConflict}</span>}
          {why === 'draft-edit-save-last' && <span id={why} data-testid="draft-edit-save-last" className="text-xs font-bold text-slate-600">{EDIT_TEXT.saveLast}</span>}
          <button type="button" data-testid="draft-edit-save" disabled={blocked} aria-describedby={why} onClick={save} className={button}>Save changes</button>
        </div>
      </div>
    </DialogFrame>
  );
}
