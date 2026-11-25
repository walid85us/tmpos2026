// M7B-INVOICES-ISSUE-P2 — the Invoices page's "Issued invoices" section (docs/phase-4/12 §10, ADR-50), over
// invoiceIssuingClient.ts: choose a store from the server's own list, then read its issued invoices (newest number first,
// "Load more") and open one, and its owner's "Issuing settings" — the legal seller name, the store name on invoices, the
// postal address, an optional tax registration ID and an explicit tax mode (an exclusive rate, or no tax calculated) that
// every invoice issued at that store snapshots.
//
//   - The issued list (commit B): choosing a store is the explicit action that reads its first page (20, the drafts
//     section's precedent); "Load more" sends the nextCursor this client decoded for THAT store under THAT generation only,
//     and a store change, a new generation or a session end discards every page (a late page finds nothing to join). A row
//     says the store's number, the customer's name as the invoice recorded it, the Total and the UTC issue time, and
//     "Issued" or "Voided" (its current state, M7B-INVOICES-VOID-P1) — nothing about payment, and no send, print, edit or delete on a row (voiding is the
//     dialog's, below). Nothing is looked up in this browser's
//     customers. A 403 gets the reads' ONE fresh check, then "You cannot view issued invoices at this store." (no loop).
//   - Open reads ONE issued invoice in the exported IssuedInvoiceDialog: the version-1 snapshot (seller, customer, ordered
//     lines, subtotal, the tax meaning, Total) exactly as the server answered it. The dialog owns its GET (one per open and
//     per Try again, its own sequence and abort); the session work — the check, a 401, a 403's one fresh check, a 429's wait —
//     is the owner's read function, so the drafts section can show the same document under its own generation.
//
//   - Separate from this browser's invoices: nothing here enters the local invoice list, its counters or any browser
//     storage, and nothing read is ever looked up in or merged with local data.
//   - The server decides everything. The settings entry is shown to everyone at a chosen store; the server's answer says
//     who may read or change them (the store owner) — its 403 is the answer that counts, after the reads' ONE fresh check
//     (another token is a new generation, never a refusal). No role name, owner shortcut or local level decides anything.
//     A read-only store's settings can be read, and no Save is offered there (the write would be the server's 404).
//   - Nothing is read before "Show issued invoices"; the issued list when a store is chosen (or by its Try again and Load
//     more), one invoice when its Open is pressed, and the settings only when their panel is opened (or by its own Refresh,
//     Try again or Load current version). The store is ALWAYS an explicit choice from GET /api/v1/stores: nothing is
//     preselected and this browser's store labels are never mapped to it.
//   - A GENERATION is one store connection as this section knows it, exactly as the drafts section's: a counter and the
//     session's CSRF token, in a ref. `connect()` (the session client's `ensure`) runs before every read and write: plain,
//     `fresh` only for the one check after a 403, `reconnect` only from the Reconnect button. A different token starts a
//     new generation: reads in flight are cancelled, the stores, the choice and the panel go, and the stores are read again.
//     A read answer applies only under the generation, store, panel and request that started it, while the section is
//     mounted and no sign-out has begun since it asked (`sessionEndsSoFar`); anything else changes nothing. A tab return
//     or a window focus asks ONE plain session check once a token is fixed — it never reads settings, never saves and
//     never signs in after a confirmed end. A 401 ends the session (only Reconnect signs in again); a 429 starts one
//     section-wide wait whose timer only gives the controls back.
//   - The form is the server's: an unconfigured store (version 0) shows empty fields, NO tax mode and no rate; a configured
//     one its values (the rate as its exact percentage digits). Nothing is filled in from this browser. Every field is
//     checked by the server's own rules first (the client restates them), and an invalid form sends nothing.
//   - Save sends ONE PUT per press, never while an attempt is out or unresolved, during a wait, a conflict, a read or a
//     sign-in (asked for or out): the form locks at the press, and the body (the store's tenant and the version the form
//     was loaded at, then the normalized values) is built once and frozen with a NEW key, the session token it goes with (a
//     ref) and a monotonic and a wall-clock send time BEFORE it leaves.
//     "Saved" is said only after the server's exact 200 AND a fresh read that finds that version with those values; a 200
//     whose read-back fails, or finds a newer version, says so — it is never sent again. A sealed write_conflict keeps the
//     edits and offers "Load current version" (an explicit read that keeps them and moves the version they are based on;
//     the next Save is a new key). A 403 step_up_required (no key acquired) shows the inline sign-in group: only an
//     explicit sign-in renews the session (its new token is adopted as this section's, the attempt-free panel kept), then
//     the settings are read again — the same version says "press Save", another is a conflict; until a read answers, Save
//     waits — and nothing is saved on its own. An answer that decides nothing (a 503, no answer, request_in_progress)
//     leaves the attempt UNRESOLVED: the form is locked, and only "Check again" re-sends — the SAME key and bytes, under the
//     token it was sent with, while max(monotonic, wall) since the FIRST send is under 23 hours, judged again just before
//     it leaves; "Stop tracking" drops it and reads the settings afresh. Editing cannot change a held body (the form is
//     locked; the body is frozen).
//   - A store change, a new generation, a session end or a sign-out (the session client's `onSessionEnd`, heard while
//     mounted) closes the panel synchronously: its values and any attempt — key, body, token — go with it, and an
//     unconfirmed one leaves only a note that a change could not be confirmed. A late answer finds nothing under its key.
//   - The session token sits only in refs (tenantSessionClient.ts lists the holders): never browser storage, a URL, the
//     DOM or a log; no key or body reaches any of those either, and settings values and issued invoices only the DOM.
//
//   - Voiding (M7B-INVOICES-VOID-P2, doc 13 §5 G and §12, ADR-51; design R9–R23): only this section's dialog offers "Void
//     invoice…" (the drafts card's View invoice never does), and only when the action-only eligibility read — sent with the
//     detail read when the dialog opens, never before — answered allowed AND the detail says issued, in a row reserved from
//     the asking on. Pressing it re-reads the detail once (the dialog stays as it is); a voided answer says so, otherwise a
//     stacked alertdialog confirms exactly that read: the number, the store, the customer, the exact Total and the UTC issue
//     time, what voiding means, and a required reason (none chosen). One press is ONE POST under ONE new key: a ref holds a
//     second activation back, the context is checked again, and the body (built once) and key are held in the void hold
//     (invoiceVoidHold.ts, memory only) BEFORE the request leaves; answers settle there BY KEY, whatever is mounted. "Voided"
//     is said only after the validated 200, and the reason and time shown are always the detail read's, never the held
//     reason. An unconfirmed attempt is held outside every dialog (its card): only "Check again" re-sends — the same key
//     and bytes, under the token it went with, within 23 hours of the first send — and "Check invoice" is an ordinary GET
//     that shows the invoice's state now, never which request caused it. A token change, a sign-out or another user
//     detaches it for good. A 403 step_up_required on a first send (nothing ran) offers an explicit sign-in that keeps the
//     dialog, re-reads the invoice and its eligibility and asks for a NEW press; nothing signs in or sends on its own.
//   - Payments (M7B-PAYMENTS-P2A, doc 15 §3 D-PAY-1 and §12.3; decision D4): only this section's dialog shows a read-only
//     "Payments" section — page one read ONCE per open after the detail answered an invoice, under the dialog read's own
//     context and session work; "Load more payments" for the next page; Try again after a failure; once more after this
//     dialog's void is confirmed. Nothing on focus or timers. The amounts and the word are always the server's, every label
//     says "recorded"; nothing here records, reverses or proves a payment.

import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode, type RefObject } from 'react';
import { flushSync } from 'react-dom';
import { onSessionEnd, sessionEndsSoFar, tenantSession, type SessionResult, type TenantSessionClient } from './tenantSessionClient';
import { invoiceDrafts as draftsClient, formatCents, type InvoiceDraftsClient, type StoreEntry } from './invoiceDraftsClient';
import {
  INVOICE_PAYMENT_METHODS, INVOICE_PAYMENT_REVERSAL_REASONS, INVOICE_PAYMENT_STATUSES, INVOICE_VOID_REASONS, VOID_REASON_CODES, invoiceIssuing as issuingClient, isVoidTarget, issuingSettingsBody, rateDigits, rateText, sameSettingsValues, utcText, voidBodyOf,
  paymentAmountOf, recordBodyOf, registerBodyOf, reverseBodyOf, settleBodyOf, type InvoicePaymentReversalReason, type ReverseResult, type InvoicePaymentMethod, type PaymentAttempt, type ProofResult, type RecordResult, type RegisterResult, type SettleResult,
  type InvoiceAmounts, type InvoiceIssuingClient, type InvoiceLine, type InvoicePayment, type InvoiceVoidReasonCode, type IssuedInvoice, type IssuedSummary, type IssuingSettings, type IssuingSettingsErrors,
  type IssuedStatus, type IssuingSettingsFields, type PaymentsPage, type SaveSettingsResult, type Seller, type SettingsValues, type VoidResult,
  INVOICE_CREDIT_NOTE_REASONS, INVOICE_CREDIT_NOTE_WITHDRAWAL_REASONS, creditNoteAttemptsFollow, creditNotesFollow, type CreditNoteAttempt, type InvoiceCreditNote,
  creditNoteIssueBodyOf, creditNoteRegisterBodyOf, type CreditNoteCommandResult, type CreditNoteProofResult, type InvoiceCreditNoteReason,
  storeCreditActivityFollows, type StoreCreditNote,
  creditNoteWithdrawBodyOf, type InvoiceCreditNoteWithdrawalReason, type WithdrawCreditNoteResult,
} from './invoiceIssuingClient';
import {
  isLiveWithdrawal, seeWithdrawal, settleWithdrawal, withdrawalHolds as shopWithdrawalHolds, withdrawalSlot, type HeldWithdrawal, type WithdrawalHoldStore,
} from './invoiceCreditNoteWithdrawalHold';
import {
  CREDIT_NOTE_FIRST_SEND_MS, CREDIT_NOTE_REPLAY_MS, CREDIT_NOTE_SETTLE_REPLAY_MS, CREDIT_NOTE_STAGE_WAIT_MS, creditNoteElapsed, creditNoteHolds as shopCreditNoteHolds,
  isLiveCreditNote, isOpenCreditNote, replayWindowOpen, sendBlockOf, signInFresh,
  type CreditNoteDecision, type CreditNoteHoldStore, type CreditNoteSignIn, type CreditNoteStage, type CreditNoteState, type CreditNoteTicket, type HeldCreditNote,
} from './invoiceCreditNoteHold';
import { firebaseShopIdentity, type ShopIdentity } from './ServerCustomerLevels';
import { CHECK_CUTOFF_MS } from './ServerCustomerDirectory';
import { pickerWaitText } from './ServerCustomerPicker';
import { button, columnHeadClass, DialogFrame, focusRing, hintClass, inputClass, labelClass, quiet, RecordId, recordIdText, storeLabel } from './ServerInvoiceDrafts';
import {
  isLiveReversal, reversalExpired, reversalHolds as shopReversalHolds, seeReversal, settleReversal, type HeldReversal, type ReversalHoldStore,
} from './invoiceReversalHold';
import { VOID_NOTE_TEXT, isLiveVoid, settleVoid, voidExpired, voidHolds as shopVoidHolds, type HeldVoid, type VoidHoldStore, type VoidRefusal } from './invoiceVoidHold';
import {
  isBlockingPayment, isOpenPayment, isPaymentHeldElsewhere, judgePayment, paymentExpired, paymentHolds as shopPaymentHolds, type HeldPayment, type PaymentHoldStore, type PaymentSay,
} from './invoicePaymentHold';

const DEFAULT_WAIT_SECONDS = 60;
/** How long Check again waits after the server said the same request is still in progress (no Retry-After): it only re-enables. */
const IN_PROGRESS_WAIT_MS = 5_000;
/** The attempts lookup reads at most this many pages (50 each) from the start (G2). */
const LOOKUP_PAGE_CAP = 20;
/** R7: the exact-payment lookup reads at most this many history pages (50 each) from the start. */
// shortcut: 20 pages = 1000 payments per invoice; past it a lookup says "couldn't confirm", raise it if invoices ever carry more.
const REVERSAL_LOOKUP_PAGE_CAP = 20;
/**
 * How long after a register's LAST send a lookup's absence may decide it (R4): far past the server's 2 s command transaction
 * deadline (server/runtime/commandTransaction.ts COMMAND_TRANSACTION_DEADLINE_MS) and this client's 15 s request timeout
 * (REQUEST_TIMEOUT_MS), so by then the register's work has ended, committed or rolled back. It equals the server's 60 s
 * idempotency lease (IDEMPOTENCY_POLICY.leaseMs), which by itself ends no transaction.
 */
const REGISTER_QUIET_MS = 60_000;
/**
 * How long the void's explicit sign-in is waited for (M7B-INVOICES-VOID-P2-R1), from the press of Confirm sign-in — never
 * while typing — over the provider's leg, the session's and the hand-back to the dialog. After it this page stops waiting:
 * nothing at the provider is cancelled (it cannot be) and a late answer applies nothing here.
 */
export const VOID_SIGNIN_WAIT_MS = 30_000;
const waitable = 'aria-disabled:opacity-50 aria-disabled:cursor-not-allowed';
/**
 * Every void control fits its row in any font (CI SIS-22 at 320×600 / 24 px text: "Check invoice" was wider than the held
 * card): it may shrink below its longest word, which then wraps inside it (overflow-wrap anywhere lowers its min-content),
 * so a row never runs past its card or dialog. A flex row still wraps whole controls first; text, order and names unchanged.
 */
const fitsRow = 'min-w-0 max-w-full whitespace-normal [overflow-wrap:anywhere]';
/** The reversal confirmation's two actions (owner QA, 320x309): never squeezed, so one line wherever it fits (its row wraps
 *  instead); wider than the panel (24 px text at 320 px) it wraps between words, never inside one. */
const actionFit = 'shrink-0 max-w-full whitespace-normal break-normal';
/** An issued invoice's current state as the server's read says it (never which request made it so). */
export const STATUS_TEXT: Readonly<Record<IssuedStatus, string>> = Object.freeze({ issued: 'Issued', voided: 'Voided' });

export const ISSUED_TEXT = Object.freeze({
  intro: "Invoices issued on the server for one of your stores, and each store's issuing settings. They are kept apart from this browser's invoices.",
  storesLoading: 'Loading your stores from the server…',
  storesDenied: 'This account may not use server invoices.',
  noStores: 'No store is available to this account for server invoices.',
  chooseStore: 'Choose a store.',
  ended: 'Your server session ended. Reconnect to see issued invoices.',
  noIdentity: 'Sign in with your store account to see issued invoices.',
  refused: 'The store server did not accept this sign-in. Reconnect, or sign out and sign in again.',
  unavailable: 'Issued invoices are unavailable right now.',
  connection: 'The store connection changed, so your stores were loaded again. Choose a store.',
});

export const LIST_TEXT = Object.freeze({
  loading: 'Loading issued invoices from the server…',
  empty: 'No issued invoices at this store yet.',
  denied: 'You cannot view issued invoices at this store.',
  unavailable: 'Issued invoices could not be loaded right now. Try again.',
  reloaded: 'The list changed on the server, so it was loaded again from the start.',
  renewed: 'You signed in again, so the list read before was cleared. Try again to load it.',
  lastKnown: 'Last known list — could not refresh',
  waiting: 'Too many requests: this comes back once the wait has passed.',
});

export const VIEW_TEXT = Object.freeze({
  title: 'Issued invoice',
  loading: 'Loading this invoice from the server…',
  notFound: 'This invoice is not available.',
  denied: LIST_TEXT.denied,
  unavailable: 'This invoice could not be loaded right now. Try again.',
  note: "Recorded when it was issued (snapshot version 1): later changes to the store's issuing settings or to the customer do not change it.",
  waiting: LIST_TEXT.waiting,
});

/** The issued dialog's Payments section (M7B-PAYMENTS-P2A, doc 15 §3 D-PAY-1): read-only, every word "recorded". */
export const PAYMENTS_TEXT = Object.freeze({
  title: 'Payments',
  note: 'Payments are recorded by staff; the product does not verify them.',
  loading: 'Loading payments…',
  empty: 'No payments recorded.',
  denied: 'You cannot view payments for this invoice at this store.',
  notFound: 'The payments for this invoice were not found.',
  unavailable: 'Payments could not be loaded.',
  changed: 'The payments changed while loading. Close and reopen this invoice to see them.',
  waiting: LIST_TEXT.waiting,
  loadMore: 'Load more payments',
  reversed: 'Reversed',
});

/**
 * Recording a payment (M7B-PAYMENTS-P2B, slice wording G1): every word "recorded", never "paid"; nothing says a payment
 * was recorded before the server's 201 (or its sealed already_recorded) for this attempt, or the lookup's row.
 */
export const RECORD_TEXT = Object.freeze({
  record: 'Record payment',
  legend: 'Record a payment',
  amount: 'Amount (USD)',
  hint: (remaining: string) => `Up to ${remaining} remaining.`,
  method: 'Method',
  submit: 'Record',
  cancel: 'Cancel',
  amountFormat: 'Enter an amount, such as 12.50.',
  amountDecimals: 'Enter an amount with no more than two decimal places.',
  amountZero: 'Enter an amount of at least $0.01.',
  amountOver: (remaining: string) => `The amount can't be more than the ${remaining} remaining.`,
  methodMissing: 'Choose how the payment was taken.',
  recording: 'Recording the payment…',
  recorded: (amount: string, method: string) => `Payment recorded: ${amount}, ${method}.`,
  recordedHint: "Confirm it to finish. Until you confirm, you can't record another payment.",
  confirm: 'Confirm payment',
  confirming: 'Confirming…',
  withdrawing: 'Withdrawing…',
  confirmed: 'Payment confirmed.',
  uncertain: "We couldn't confirm whether this payment was recorded. Nothing is sent again unless you press Check again.",
  check: 'Check again',
  find: 'Find this payment attempt',
  /** R9: nothing held in this page (after a reload) and nothing remaining, so no Record: the lookup only on a press. */
  findAny: 'Find an unfinished payment attempt',
  inProgress: VOID_NOTE_TEXT.inProgress,
  detached: "This payment attempt can't be checked from here any more. Find it to finish it.",
  record404: "This payment couldn't be finished from here. It may or may not have been recorded. No new payment will be sent. Find this payment attempt to finish it.",
  writeConflict: 'You have an unfinished payment attempt on this invoice. Finish it before recording another payment.',
  amountExceeds: 'No payment was recorded: the amount is more than the remaining balance. Withdraw the attempt, then record the correct amount.',
  invalidState: "No payment was recorded: this invoice can't take this payment now.",
  /** The record's invalid_state: its registration still holds the invoice until the lookup settles it. */
  invalidStateLookup: "No payment was recorded: this invoice can't take this payment now. Find this payment attempt to finish it.",
  denied: 'You cannot record payments for this invoice at this store.',
  notAccepted: 'No payment was recorded: the server did not accept this request.',
  lookingUp: 'Checking your payment attempts…',
  openRow: (time: string) => `Attempt started ${time}: no payment recorded.`,
  recordedRow: (time: string, amount: string, method: string, at: string) => `Attempt started ${time}: ${amount}, ${method} recorded ${at}.`,
  withdraw: 'Withdraw attempt',
  none: 'No unfinished payment attempts were found on this invoice.', // R7: what this read found, not a promise none exist
  failed: 'Your payment attempts could not be loaded.',
  /** R4: a complete read without the held register-stage attempt within REGISTER_QUIET_MS of its last send decides nothing. */
  stillRegistering: 'This payment attempt may still be in progress. Try again in a minute.',
  /** R7: a complete read without a held attempt that may have sent its record and has no known payment: settled over 24 h ago, withdrawn or confirmed (037). */
  notListed: "This payment attempt is no longer listed, so it can't be finished from here. Check this invoice's payments.",
  tryAgain: 'Try again',
  cap: 'There are too many payment attempts to check here.',
  withdrawn: 'Attempt withdrawn. No payment was recorded.',
  /** R1 S11: a press whose context went before anything left. */
  notSent: 'Nothing was sent. Check the details and press Record again.',
  /** R1 S3: a row action held back while another attempt is undecided. */
  finishFirst: 'Finish the payment attempt above first.',
  /** G3: an undecided attempt held for another invoice; its store named when it is another store's (R3 M2). */
  finishOn: (n: number, store: string | null) => `Finish your payment attempt on invoice ${n}${store === null ? '' : ` at ${store}`} first.`,
});

export const SETTINGS_TEXT = Object.freeze({
  explain: 'The seller details and tax mode every invoice issued at this store records. Each saved change is a new version; an invoice already issued keeps the details it was issued with.',
  loading: 'Loading the issuing settings from the server…',
  denied: 'Only the store owner can view or change issuing settings.',
  notFound: "This store's issuing settings are not available.",
  unavailable: 'The issuing settings could not be loaded right now. Try again.',
  unconfigured: 'This store has no issuing settings yet. Invoices cannot be issued here until the store owner saves them.',
  version: (n: number) => `Version ${n} on the server.`,
  readOnly: 'This store is read-only: its issuing settings can be viewed here but not changed.',
  noTax: "No tax is added to invoices issued at this store. This is the store owner's own choice: the product does not check whether tax applies to these sales.",
  rate: 'Added on top of the subtotal. Enter a percentage from 0 to 100 with at most three decimals, like 8.875; 0 is a real rate.',
  sending: 'Saving the issuing settings…',
  checking: 'Checking with the server…',
  readingBack: (n: number) => `Saved as version ${n}. Reading it back from the server…`,
  saved: (n: number) => `Saved: version ${n} is on the server.`,
  newer: (n: number, m: number) => `Saved as version ${n}; the server now has a newer version (${m}), shown here.`,
  unread: (n: number) => `Saved as version ${n}, but the settings could not be read back. Refresh to see them.`,
  mismatch: (n: number) => `Saved as version ${n}, but the settings read back do not match it. Refresh to see what the server has.`,
  savedEnded: (n: number) => `Issuing settings were saved as version ${n}, but they were not read back before the store or the session changed.`,
  conflict: 'Not saved: these settings changed on the server since you loaded them. Your edits are kept.',
  loadedCurrent: (n: number) => `Loaded version ${n} from the server; what it holds is shown below. Your edits are still in the form: Save replaces version ${n} with them.`,
  loadFailed: 'The current settings could not be loaded. Try again.',
  conflictBlocked: 'These settings changed on the server: load the current version first.',
  stepUp: 'Not saved: confirm your sign-in to save this change.',
  reauthTitle: 'Confirm your sign-in to save this change',
  reauthFailed: 'Not saved: your sign-in was not confirmed. Try again.',
  reauthUnconfirmed: 'Not saved: the store server did not confirm your sign-in. Try again.',
  renewing: 'Signed in again. Checking the settings with the server…',
  renewed: 'Signed in again. Press Save to save this change.',
  tenantChanged: 'Not saved: this store is no longer part of the tenant these settings were loaded for. Choose the store again.',
  notFoundWrite: "Not saved: this store's issuing settings cannot be changed here (it may be read-only or no longer available).",
  invalid: 'Not saved: the server did not accept these settings.',
  keyReused: 'Not saved: the server rejected this request.',
  deniedWrite: 'Not saved: only the store owner can change issuing settings.',
  rateLimited: (wait: string) => `Not saved: ${wait}`,
  unresolved: 'Not confirmed yet: the server may have saved these settings. "Check again" sends the same request; it never saves them twice.',
  tooOld: 'Not checked: it was sent too long ago. Stop tracking to see the settings the server has before saving again.',
  stopWarning: 'Stop tracking does not cancel the request: the server may still save it.',
  stopped: 'Stopped tracking. The form shows the settings the server has now: check them before saving again.',
  detached: 'A settings change sent earlier could not be confirmed: the store or the session changed. Open Issuing settings to see what the server has before saving again.',
  saveBlocked: 'The last save is not confirmed yet: check it again or stop tracking it first.',
  saveWaiting: 'Too many requests: Save comes back once the wait has passed.',
  checkWaiting: 'Too many requests: Check again comes back once the wait has passed.',
  signInWaiting: 'Too many requests: the sign-in comes back once the wait has passed.',
  busy: 'Wait for the server to answer first.',
  signInFirst: 'Confirm your sign-in first, then press Save.',
  rereadBlocked: 'You signed in again, but the settings were not checked afterwards: check them again before saving.',
  locked: 'The form is locked while a save is sent or not yet confirmed.',
  rateOff: 'Choose Exclusive rate to enter a rate.',
  confirmingSignIn: 'Confirming your sign-in…',
});

/** Why an answer left a settings attempt unresolved. Never "not saved": only a decisive answer for the same key says that. */
function reasonOf(answer: SaveSettingsResult): string {
  switch (answer.kind) {
    case 'in-progress': return 'The server is still working on it. Check again in a moment.';
    case 'denied': return 'Access lost: the server refused this check, and that refusal stands.';
    case 'step-up': return 'The server asked for a recent sign-in, so this could not be checked. Stop tracking to see what the server has.';
    case 'rate-limited': return pickerWaitText(answer.retryAfterSeconds);
    case 'unknown': return answer.responded ? 'The server answered, but not with a result.' : 'No answer from the server.';
    default: return 'The server answered, but not with a result.';
  }
}
/** The answers that decide a Check again (the key was looked at): its 200, the sealed 409, or a refusal that recorded nothing because nothing ran. */
const CHECK_DECIDES: ReadonlySet<SaveSettingsResult['kind']> = new Set(['saved', 'conflict', 'tenant-changed', 'not-found', 'key-reused']);

const EMPTY_FIELDS: IssuingSettingsFields = Object.freeze({ legalName: '', storeName: '', postalAddress: '', taxRegistrationId: '', taxMode: '', rate: '' });
/** The form as the server's settings fill it: empty with no tax mode when unconfigured; never anything from this browser. */
const fieldsOf = (s: IssuingSettings): IssuingSettingsFields => (!s.configured ? EMPTY_FIELDS : Object.freeze({
  legalName: s.legalName, storeName: s.storeName, postalAddress: s.postalAddress, taxRegistrationId: s.taxRegistrationId ?? '',
  taxMode: s.tax.mode, rate: s.tax.mode === 'exclusive_rate' ? rateDigits(s.tax.rateMilliPercent) : '',
}));
const taxText = (s: Extract<IssuingSettings, { configured: true }>): string => (s.tax.mode === 'none' ? 'No tax calculated' : `Exclusive rate ${rateText(s.tax.rateMilliPercent)}`);

/**
 * The void workflow's texts (M7B-INVOICES-VOID-P2, doc 13 §5 G, design §4): "voided" only after the server's validated 200
 * for that key or a read that shows it; a read showing it voided never says which request did it; nothing says "cancelled"
 * or "rolled back".
 */
export const VOID_TEXT = Object.freeze({
  open: 'Void invoice…',
  reviewing: 'Checking this invoice…',
  reviewWaiting: 'Too many requests: Void invoice… comes back once the wait has passed.',
  reviewFailed: 'This invoice could not be checked right now. Try again.',
  alreadyVoided: 'This invoice is already voided.',
  /** A 404 from the detail READ (never from the POST alone, design R21). */
  gone: 'This invoice is no longer available.',
  title: (n: number) => `Void invoice ${n}?`,
  consequence: 'Voiding is final in the shop: the invoice keeps its number, its contents and its history, and stays in the list as Voided. It does not refund or record a payment, and it is not a credit note or a tax correction.',
  reasonLegend: 'Reason for voiding (required)',
  chooseReason: 'Choose a reason first.',
  sendChecking: 'Checking your session before sending…',
  pending: 'Another void is waiting to be confirmed.',
  sendWaiting: 'Too many requests: Void invoice comes back once the wait has passed.',
  closeWarning: 'Closing does not cancel the void; the server may have voided it anyway.',
  sending: 'Voiding the invoice on the server…',
  finding: 'Checking the invoice…',
  voided: (n: number) => `Invoice ${n} voided.`,
  voidedUnread: (n: number) => `Invoice ${n} was voided. Its details could not be loaded.`,
  afterUnread: 'The invoice could not be loaded again right now.',
  noLongerAllowed: 'You can no longer void invoices at this store.',
  refusedUnchecked: 'Not voided: the server refused this request, and your session could not be checked right now.',
  /** A first send's 403 that no fresh check confirmed (review B1 iam 3): it names no lack of access. */
  refusedPlain: 'Not voided: the server refused this request.',
  /** A send or a check pressed while the void's own sign-in is out (review B1 L2): nothing is sent. */
  signingIn: 'Not sent: a sign-in is in progress.',
  /** In the open dialog, beside an attempt for its invoice that is out or unconfirmed (review B1 F2): where it is tracked. */
  heldOutside: 'The void is tracked under Issued invoices once this invoice is closed.',
  /** Why "Void invoice…" waits while the void's own sign-in is out (review B1 R2-1a): no review under the session it replaces. */
  reviewSignIn: 'A sign-in is in progress: Void invoice… comes back once it has finished.',
  /** A confirmation reviewed under an earlier session generation never sends (R2-1c): it closes, and the user reviews again. */
  staleReview: 'Not sent: this invoice was reviewed before the session changed. Press Void invoice… to review it again.',
  notSendable: 'Not sent: this store could not be confirmed for voiding. Close this and choose the store again.',
  rateLimited: 'Not voided: too many requests. Wait, then press Void invoice again.',
  stepUp: 'Not voided: confirm your sign-in to void this invoice.',
  /** The same step-up when this page has no sign-in to offer (review B1 truth LOW-4): it never asks for one it cannot take. */
  stepUpNoMethod: 'Not voided: your sign-in is too old to void invoices here.',
  reauthTitle: 'Confirm your sign-in to void this invoice',
  reauthExplain: 'Signing in again starts a new session. Other requests on this page that are still waiting to be confirmed can then only be dismissed.',
  /** No sign-in method this page can ask for (the settings precedent, adapted): nothing is offered but this. */
  reauthNone: 'Sign out and sign in again, then void this invoice.',
  reauthFailed: 'Not signed in: your sign-in was not confirmed. Try again.',
  reauthUnconfirmed: 'Not signed in: the store server did not confirm your sign-in. Try again.',
  /** R1: this page's own wait ended — never "cancelled" or "failed": the provider may still answer, and that answer applies nothing here. */
  signInTimedOut: `Not voided: this page stopped waiting for your sign-in after ${VOID_SIGNIN_WAIT_MS / 1000} seconds and sent nothing for this invoice. You can try again.`,
  signInStopped: 'Not voided: this page stopped waiting for your sign-in and sent nothing for this invoice. You can try again.',
  stopWaiting: 'Stop waiting',
  stopWaitingHint: 'This only stops waiting here: nothing is sent for this invoice.',
  renewing: 'Signed in again. Checking this invoice with the server…',
  renewed: 'Signed in again. Choose a reason, then press Void invoice.',
  renewUnread: 'Signed in again, but this invoice could not be checked. Close this and open the invoice again.',
  dismissWarning: 'Dismissing only stops tracking it here. It does not cancel the request, which may still void the invoice.',
  seenVoided: (n: number) => `Invoice ${n} is voided now. This does not show which request voided it.`,
  seenIssued: (n: number) => `Invoice ${n} still shows as issued. That does not mean the void failed: the request may still be processed.`,
  /** The reason the invoice records now (a Check invoice read): another request may have voided it with it. */
  seenReason: (label: string) => `The reason it records: ${label}.`,
  checkFailed: 'The invoice could not be checked right now.',
  checkMissing: 'This invoice is not available to this account now. That does not show whether the void went through.',
  checkDenied: 'You cannot view issued invoices at this store now, so the invoice could not be checked.',
  detached: 'This void could not be confirmed: your session changed. Open the invoice to see its current state.',
  coolDown: 'The server is still working on it: Check again comes back in a moment.',
  waiting: 'Too many requests: this comes back once the wait has passed.',
});

/**
 * Credit notes (M7B-CREDITNOTES-CN-P2, doc 17 §2.7, D-P2-4): the invoice's list and the attempts lookup's states, exactly as
 * the wording table has them. "Withdraw" only ever for a credit note; nothing here says paid, unpaid or refund.
 */
export const CREDIT_TEXT = Object.freeze({
  listTitle: 'Credit notes',
  listEmpty: 'No credit notes on this invoice.',
  /** Appended for the store owner only (the lookup answered them), and only after a read to the end under one view. */
  listEmptyOwner: 'None have been issued yet.',
  listLoading: 'Loading credit notes…',
  listFailed: "Credit notes couldn't be loaded.",
  tryAgain: 'Try again',
  showMore: 'Show more',
  moreLoaded: (n: number) => `${n} more loaded.`,
  number: (n: number) => `CN-${n}`,
  active: 'Active',
  withdrawn: 'Withdrawn',
  issuedAt: 'Issued',
  withdrawnAt: 'Withdrawn',
  issuedBy: 'Issued by',
  withdrawnBy: 'Withdrawn by',
  nameNotSet: 'Name not set',
  numberPending: 'The credit note number will show here when its row in the list loads.',
  lookupFailed: "We couldn't check for unfinished credit notes on this invoice, so issuing is off for now.",
  lookupIncomplete: "We haven't checked all your unfinished credit notes yet, so issuing is off for now.",
  continueChecking: 'Continue checking',
  // The issue side: the action, its form, the confirmation and its sign-in, the card and the lookup rows (§2.7, exact).
  action: 'Issue credit note',
  legend: 'Issue a credit note',
  amountLabel: 'Amount (USD)',
  amountHint: (remaining: string) => `Up to ${remaining} remaining.`,
  reasonLegend: 'Reason',
  continue: 'Continue',
  cancel: 'Cancel',
  errFormat: 'Enter an amount in dollars and cents, such as 12.50, without $ or commas.',
  errDecimals: 'Enter an amount with no more than two decimal places.',
  errZero: 'Enter an amount of at least $0.01.',
  errOver: (remaining: string) => `The amount can't be more than the ${remaining} remaining.`,
  errReason: 'Choose a reason.',
  errSummary: 'Fix the marked fields to continue.',
  reviewVoided: "This invoice was voided, so a credit note can't be issued.",
  title: 'Issue a credit note?',
  consequence: (amount: string) => `This creates a separate credit note and reduces the amount remaining on this invoice by ${amount}. The issued invoice and its total stay the same. It moves no money and returns nothing to the customer.`,
  keep: "Don't issue",
  close: 'Close',
  closeWarning: "Closing this window doesn't cancel the credit note. It may still be issued.",
  closedInFlight: 'Closed. The credit note is still being sent.',
  signInNeeded: 'Issuing a credit note needs a recent sign-in. Sign in again to continue. No credit note has been issued yet.',
  signInTimeout: "Sign-in didn't finish within 30 seconds. No credit note has been issued yet. Try again.",
  signedIn: (at: string, until: string) => `Signed in again at ${at}. Check the details, then press Issue credit note below before ${until}.`,
  signInExpired: (at: string) => `Your sign-in from ${at} is too old to issue now. Sign in again to continue. No credit note has been issued yet.`,
  sending: 'Issuing the credit note…',
  /** The words "press Continue issuing, or" only while Continue issuing is offered. */
  registeredOnly: (canContinue: boolean) => `Registered. No credit note has been issued from this attempt yet. Check the amounts, then ${canContinue ? 'press Continue issuing, or ' : ''}look up this attempt to release it.`,
  continueIssuing: 'Continue issuing',
  continueHint: 'This uses the attempt you already registered. No new attempt is made.',
  continueLapsed: "Your sign-in is too old to continue this attempt, and a new sign-in can't use it. Look up this attempt to release it, then start again.",
  continueAfterSignIn: "This attempt can't continue after a new sign-in. Look up this attempt to release it, then start again.",
  anotherNoteFound: 'Credit notes were issued on this invoice since you started this attempt. Check them before you continue.',
  anotherNoteUnknown: "We couldn't compare every credit note on this invoice with the list from when you started, so one may have been issued since. Check the list before you continue.",
  issueAnother: 'Issue another credit note',
  anotherHint: "This issues one more credit note on this invoice. If one of this invoice's credit notes already covers it, look up this attempt to release it instead.",
  regUnknown: 'No credit note was issued from this attempt. If the lookup finds it open, you can release it here.',
  issued: (amount: string, reason: string) => `Credit note issued: ${amount}, ${reason}.`,
  issuedHint: "Confirm it to finish. Until you confirm, you can't issue another credit note on this invoice.",
  confirmHint: 'The credit note is already issued. Confirming only closes this attempt. It moves no money.',
  confirm: 'Confirm credit note',
  confirmed: 'Credit note confirmed.',
  release: 'Release attempt',
  released: 'Attempt released. No credit note was issued from it.',
  releaseHint: 'Release this attempt to free the invoice. Then you can issue a new credit note, for a smaller amount if needed.',
  overRemaining: 'No credit note was issued: the amount is more than what remains on this invoice now.',
  voided: 'No credit note was issued: this invoice was voided.',
  attemptReleased: 'No credit note was issued: this attempt was released.',
  invalidStateUnknown: 'No credit note was issued from this attempt. The invoice may have been voided, or the attempt released. Look up this attempt.',
  issueStale: 'Your sign-in was too old, so no credit note was issued. Look up this attempt to release it, then start again.',
  alreadyIssued: 'A credit note already exists for this attempt. Look up this attempt to confirm it.',
  cantContinue: "This attempt can't continue from here. Look up attempt to see what happened.",
  unfinished: 'You have an unfinished credit note on this invoice. Confirm or release it before you issue another.',
  notAccepted: 'No credit note was issued: the server did not accept this request.',
  notAllowed: "You can't issue credit notes at this store now. No credit note was issued.",
  /** The words "Check again, or" only while Check again is offered. */
  unresolved: (canCheck: boolean) => `We can't tell whether this credit note was issued. Don't assume it wasn't. ${canCheck ? 'Check again, or look' : 'Look'} up this attempt.`,
  replayGone: "We can't check this attempt from this sign-in, so we don't know whether the credit note was issued. Look up this attempt to see.",
  notListed: "We can't tell whether this credit note was issued. The lookup didn't find this attempt. Check this invoice's credit notes later.",
  inProgress: "This request is still being processed. We don't know the result yet. Check again in a few seconds.",
  rateLimited: (n: number) => `Too many tries at once. Wait ${n} second${n === 1 ? '' : 's'}, then try again.`,
  rateLimitedWait: (n: number) => `Too many tries at once. Wait ${n} second${n === 1 ? '' : 's'}, then check again.`,
  noAccess: "Your access to credit notes at this store changed, so you can't finish this attempt. It may already have been issued. Ask an owner to check this invoice's credit notes.",
  noAccessShort: "Your access to credit notes at this store changed, so you can't finish this attempt.",
  endedUnknown: "You were signed out, so we can't tell whether this credit note was issued. Sign in again, then look up this attempt.",
  /** The shipped session-end text, reused (§2.7): a first-send 401 that proves nothing ran. */
  ended: ISSUED_TEXT.ended,
  internalError: 'Something went wrong with this request, so nothing more was sent. Look up this attempt.',
  settleNotDone: "We couldn't confirm that this attempt was finished for this account. Look up this attempt.",
  /** The words "Check again, or" only while Check again is offered. */
  settleUnknown: (canCheck: boolean) => `We can't tell whether this attempt was finished. ${canCheck ? 'Check again, or look' : 'Look'} up this attempt to see.`,
  find: 'Look up attempt',
  checkAgain: 'Check again',
  checkUntil: (at: string) => `You can check again until ${at}.`,
  checkReplayHint: "Sends the same request again. If it wasn't recorded yet, this can finish it. It never starts a new attempt.",
  checkReadHint: 'Only checks this attempt. It changes nothing.',
  hide: 'Hide this attempt',
  hideWarning: "This only hides it here. It releases nothing, issues nothing and moves no money, and it doesn't tell us whether the credit note was issued. If the attempt is still open, it still blocks your next credit note on this invoice. Check this invoice's credit notes later.",
  rowOpen: (at: string) => `Registered, not issued when checked at ${at}`,
  rowIssued: 'Issued, not confirmed',
  rowReleased: 'Released',
  rowConfirmed: 'Confirmed',
  blockedOwn: 'Confirm or release the unfinished credit note below first.',
  /** Inside Payments only: it names payments and voids (Appendix A). */
  blockedSibling: 'Finish your unfinished payment, reversal or void attempt first.',
  blockedRemaining: 'Nothing remains to credit on this invoice.',
});
/**
 * The store-wide "Credit activity" sub-section (doc 18 §4.3, exact): detection, never prevention. Its rows reuse
 * CREDIT_TEXT's words; "Withdrawn" appears only on a credit note of this list (the word scan's one widened scope, §4.3).
 */
export const ACTIVITY_TEXT = Object.freeze({
  title: 'Credit activity',
  intro: 'Credit notes issued at this store, newest first. Use it to spot a credit note issued twice. It does not stop one being issued.',
  loading: 'Loading credit activity…',
  empty: 'No credit notes have been issued at this store yet.',
  failed: "Credit activity couldn't be loaded.",
  refresh: 'Refresh',
  invoice: (n: number) => `Invoice ${n}`,
});
/** A wall-clock reading as the shop's other times read ("YYYY-MM-DD HH:MM:SS UTC"). */
const clockText = (wallMs: number): string => utcText(new Date(wallMs).toISOString());
/** The credit-note live pair: `n` counts writes, so each transition mounts fresh text (the same words twice still speak). */
interface CreditLive { readonly status: string; readonly alert: string; readonly n: number; readonly sn: number; readonly an: number }
const CN_QUIET: CreditLive = Object.freeze({ status: '', alert: '', n: 0, sn: 0, an: 0 });
/** What a pair shows of `live`: each region only what was written there after `from` (its mount, or the other pair's turn). */
const liveSince = (live: CreditLive, from: number): CreditLive => ({
  ...live, status: live.sn > from ? live.status : '', alert: live.an > from ? live.alert : '',
});
/**
 * What a card said that must outlive the section (a page left in the app and back, §3.6): the stage keys whose replay it said
 * is unavailable, and a confirmed no-access line (rule 4) with the token it was confirmed under. Kept per hold store and user
 * beside the module-level hold, for its attempt only; a reload (a new store) forgets both, as it forgets the hold.
 */
interface CreditCardMemo { readonly attemptId: string; readonly stages: readonly { readonly stage: CreditNoteStage; readonly key: string }[]; readonly bare: CreditSay | null; readonly last: CreditSay | null }
const cnMemos = new WeakMap<CreditNoteHoldStore, Map<string, CreditCardMemo>>();
const cnMemoOf = (store: CreditNoteHoldStore): Map<string, CreditCardMemo> => {
  const was = cnMemos.get(store);
  if (was !== undefined) return was;
  const made = new Map<string, CreditCardMemo>();
  cnMemos.set(store, made);
  return made;
};
/** An attempt that is over (confirmed, released or ended): not a type guard, so the caller keeps its type. */
const cnEnded = (h: HeldCreditNote): boolean => !isOpenCreditNote(h);
/**
 * What a credit-note card says for one attempt (doc 17 §3.1): its line (polite, or an alert), a second line, whether
 * "Look up attempt" is offered, and a confirmed no-access card's "no buttons at all" (rule 4).
 */
export interface CreditSay {
  readonly attemptId: string; readonly text: string; readonly alert: boolean; readonly also: string; readonly find: boolean; readonly bare: boolean;
  /** The token a confirmed no-access (`bare`) was confirmed under: a later known session change lifts it (§3.6 rule 4). */
  readonly bareAt: string | null;
  /** The stage whose "Check again" this line backs (§3.1); shown only while the hold would let it leave now (§3.2). */
  readonly check: CreditNoteStage | null;
  /** "Continue issuing", or "Issue another credit note" once D-P2-15 stated other notes or an uncertainty (§3.2 E4). */
  readonly cont: 'continue' | 'another' | null;
  /** A line whose words follow what is offered at render (the §2.7 variants), else null (`text` as said). */
  readonly kind: 'registeredOnly' | 'unresolved' | 'settleUnknown' | null;
}
/** What a credit-note card shows and offers now (doc 17 §3.1-§3.3; §3.6 rule 4: a confirmed no-access card offers nothing). */
export interface CreditCardView {
  readonly text: string; readonly alert: boolean; readonly also: string; readonly confirm: boolean; readonly find: boolean;
  readonly check: CreditNoteStage | null; readonly until: string; readonly cont: 'continue' | 'another' | null; readonly hide: boolean;
  /** The notes D-P2-15 listed (anotherNoteFound / anotherNoteUnknown), from the current generation's list; never on a detached card. */
  readonly notes: readonly InvoiceCreditNote[];
  /** §4.1: the number's follow failed or did not reach its row — "Try again" resumes it (from the failed page's cursor). */
  readonly retry: boolean;
}
/**
 * D-P2-10 A: a credit-note hold that can still Check again or Continue issuing — Void and Reverse, whose sign-in would detach
 * it, are hidden everywhere meanwhile: a registered attempt with no issue key and a sign-in ≤ 8 minutes old (Continue issuing,
 * and the proof's Check again before it), or an undecided register, issue or settlement inside its replay window (sent, in
 * flight or cooling). `closed`: the stages whose replay the card has said is unavailable ('proof': no continuation either);
 * `bare`: a confirmed no-access card, which offers nothing (rule 4).
 */
export function creditNoteHoldsSignIns(h: HeldCreditNote | undefined, mono: number, wall: number, closed: readonly CreditNoteStage[] = [], bare = false): boolean {
  if (!isLiveCreditNote(h) || bare) return false;
  if (h.state === 'registered' && h.registrationId !== null && h.issue === null && !closed.includes('proof') && signInFresh(h.signIn, mono, wall)) return true;
  // Only a stage the hold could still Check again in its state (a registered hold never replays its register).
  return (['register', 'issue', 'settle'] as const).some((s) => !closed.includes(s) && CHECKS_IN[s].includes(h.state) && h[s] !== null && h[s]?.completion === null && replayWindowOpen(h, s, mono, wall));
}
/** The states in which each stage's Check again means anything: a register only while registering, the proof only before the issue key, the issue only while issuing. */
const CHECKS_IN: Readonly<Record<CreditNoteStage, readonly CreditNoteState[]>> = Object.freeze({
  register: ['registering'], proof: ['registered'], issue: ['issuing'], settle: ['registering', 'registered', 'issuing', 'issued'],
});
/** Whether "Check again" of `stage` may leave now (§3.2 items 2-6): the hold's own gate — token, bytes, window or limit, nothing in flight, no cool-down. */
const checkLeaves = (h: HeldCreditNote, stage: CreditNoteStage, mono: number, wall: number): boolean =>
  CHECKS_IN[stage].includes(h.state) && (stage !== 'proof' || h.issue === null) && sendBlockOf(h, stage, stage !== 'proof', mono, wall) === null;
/** Whether a continuation may be pressed now (E1's own facts and E6's window; its press judges E1-E7 again, in order). */
const continueLeaves = (h: HeldCreditNote, mono: number, wall: number): boolean =>
  isLiveCreditNote(h) && h.state === 'registered' && h.registrationId !== null && h.issue === null && signInFresh(h.signIn, mono, wall)
  && sendBlockOf(h, 'proof', false, mono, wall) === null;
/** Milliseconds until what a card offers can change by time alone — a cool-down, a stage's 30 s, the 8- and 9-minute and 23-hour windows — or null. */
function cnNextChange(h: HeldCreditNote, mono: number, wall: number): number | null {
  const at: number[] = [];
  for (const t of Object.values(h.notBefore)) if (t !== undefined && t > mono) at.push(t - mono);
  for (const s of h.sends) if (!s.answered && s.mono + CREDIT_NOTE_STAGE_WAIT_MS > mono) at.push(s.mono + CREDIT_NOTE_STAGE_WAIT_MS - mono);
  const until = (from: CreditNoteSignIn | null, limit: number): void => {
    const e = from === null ? Number.NaN : creditNoteElapsed(from, mono, wall);
    if (Number.isFinite(e) && e <= limit) at.push(limit - e + 1);
  };
  until(h.signIn, CREDIT_NOTE_FIRST_SEND_MS);
  until(h.signIn, CREDIT_NOTE_REPLAY_MS);
  until(h.settle?.firstMono != null && h.settle.firstWall != null ? { mono: h.settle.firstMono, wall: h.settle.firstWall } : null, CREDIT_NOTE_SETTLE_REPLAY_MS);
  return at.length === 0 ? null : Math.max(0, Math.min(...at));
}
/** What `say` may carry beyond the line (doc 17 §3.1): its region, a second line, the buttons it backs, a focus on Look up attempt. */
interface CreditSayOptions {
  readonly alert?: boolean; readonly also?: string; readonly find?: boolean; readonly bare?: boolean;
  readonly check?: CreditNoteStage; readonly cont?: 'continue' | 'another'; readonly kind?: CreditSay['kind']; readonly focusFind?: boolean;
}

/** The shop's payment reversal (M7B-PAYMENTS-P2C). A reversal is never called a refund: it returns no money. */
export const REVERSE_TEXT = Object.freeze({
  open: 'Reverse payment',
  openLabel: (amount: string) => `Reverse payment of ${amount}`,
  reviewing: 'Checking this payment…',
  voided: 'This invoice was voided.',
  gone: 'This invoice is no longer available.',
  notAllowed: 'You can no longer reverse payments at this store.',
  missing: 'This payment is no longer listed for this invoice.',
  alreadyReversed: 'This payment has already been reversed.',
  unconfirmed: "This payment couldn't be confirmed right now. Try again.",
  title: 'Reverse this payment?',
  consequence: 'Reversing records that this payment was entered in error. It does not return any money.',
  keep: 'Keep payment',
  close: 'Close',
  reasonLegend: 'Reason for reversing (required)',
  chooseReason: 'Choose a reason first.',
  send: 'Reverse payment',
  sending: 'Reversing…',
  sendWhyReason: 'Choose a reason first.',
  sendWhyBusy: 'A request is out: wait for its answer.',
  pending: 'Another request is waiting to be confirmed.',
  voidFirst: 'A void of this invoice is being reviewed. Close it first, then press Reverse payment again.',
  signingIn: 'Not sent: a sign-in is in progress.',
  noLongerAllowed: 'Not sent: you can no longer reverse payments at this store.',
  notSendable: 'Not sent: this store could not be confirmed. Close this and choose the store again.',
  staleReview: 'Not sent: this payment was reviewed before the session changed. Press Reverse payment to review it again.',
  rateLimited: (seconds: number) => `Not reversed: too many requests. Wait ${seconds} second${seconds === 1 ? '' : 's'}, then try again.`,
  denied: 'Not reversed: the server refused this request.',
  notRun: 'Not reversed: the server did not accept this request.',
  stepUp: 'Not reversed: confirm your sign-in to reverse this payment.',
  stepUpNoMethod: 'Not reversed: your sign-in is too old to reverse payments here.',
  renewing: 'Signed in again. Checking this payment with the server…',
  renewed: 'Signed in again. Choose a reason, then press Reverse payment.',
  reversed: 'Payment reversed.',
  refreshFailed: 'The payments could not be loaded again right now.',
  cannotNow: "This payment can't be reversed now.",
  closeWarning: 'Closing does not cancel the reversal; the server may have reversed it anyway.',
  cardTitle: 'Payment reversal not confirmed',
  cardSending: 'Reversing the payment on the server…',
  cardUnresolved: (amount: string, n: number) => `The reversal of the ${amount} payment on invoice ${n} was not confirmed. The server may have reversed it anyway.`,
  /** A Check payment read begun while the attempt was attached whose attempt detached before it answered (fix3 req 4). */
  checkDetached: "This check began under an earlier sign-in, so its answer isn't used. Press Check payment again.",
  cardDetached: 'This reversal can no longer be retried here: your session or store changed. Check payment shows what the server holds.',
  cardReversed: 'Payment reversed.',
  cardSeenReversed: 'This payment shows as reversed now. This does not show which request reversed it.',
  /** A refused attempt's title: this request reversed nothing — never "reversed" (fix3 E1). */
  cardRefusedTitle: 'Reversal request refused',
  cardRefused: "Not reversed: this payment can't be reversed now.",
  seenNotReversed: 'This payment is not reversed as of this read. That does not mean the reversal failed: the request may still be processed.',
  seenUnconfirmed: "The payment couldn't be confirmed right now.",
  retry: 'Retry reversal',
  check: 'Check payment',
  checking: 'Checking the payment…',
  dismiss: 'Dismiss',
  dismissWarning: 'Dismissing only stops tracking it here. It does not cancel the request, which may still reverse the payment.',
  coolDown: 'The server is busy: Retry reversal comes back in a moment.',
});

/**
 * The shop's credit-note withdrawal (M7B-CREDITNOTES-CN-P3): the store owner withdraws a whole active credit note. It
 * returns no money. Its own block; its reason labels are the client's INVOICE_CREDIT_NOTE_WITHDRAWAL_REASONS (the list's too).
 */
export const WITHDRAW_TEXT = Object.freeze({
  open: 'Withdraw credit note…',
  forNote: (n: number, amount: string) => `CN-${n}, ${amount}`,
  reviewing: 'Checking this credit note…',
  voided: 'This invoice was voided.',
  gone: 'This invoice is no longer available.',
  missing: 'This credit note is no longer listed for this invoice.',
  alreadyWithdrawn: 'This credit note is already withdrawn.',
  unconfirmed: "This credit note couldn't be checked right now. Try again.",
  title: 'Withdraw this credit note?',
  consequence: 'The whole credit note will be withdrawn. No money will be returned.',
  keep: 'Keep credit note',
  close: 'Close',
  reasonLegend: 'Reason (required)',
  chooseReason: 'Choose a reason first.',
  send: 'Withdraw credit note',
  sending: 'Withdrawing…',
  pending: 'Another request is waiting to be confirmed.',
  otherFirst: 'Another review is open. Close it first, then try again.',
  signingIn: 'Not sent: a sign-in is in progress.',
  notSendable: 'Not sent: this store could not be confirmed. Close this and choose the store again.',
  staleReview: 'Not sent: the session changed after this review. Open it again.',
  rateLimited: (seconds: number) => `Not withdrawn: too many requests. Wait ${seconds} second${seconds === 1 ? '' : 's'}, then try again.`,
  denied: 'Not withdrawn: the server refused this request.',
  notRun: 'Not withdrawn: the server did not accept this request.',
  stepUp: 'Not withdrawn: confirm your sign-in to withdraw this credit note.',
  stepUpNoMethod: 'Not withdrawn: your sign-in is too old to withdraw credit notes here.',
  renewing: 'Signed in again. Checking this credit note…',
  renewed: 'Signed in again. Choose a reason, then press Withdraw credit note.',
  withdrawn: 'Credit note withdrawn.',
  seenWithdrawn: 'This credit note shows as withdrawn now.',
  cannotNow: "This credit note can't be withdrawn now.",
  closeWarning: "Closing doesn't cancel the withdrawal. It may still go through.",
  cardTitle: 'Withdrawal not confirmed',
  cardSending: 'Withdrawing the credit note…',
  cardUnresolved: (n: number) => `The withdrawal of CN-${n} was not confirmed. The server may have withdrawn it anyway.`,
  cardDetached: 'Your session, store or invoice changed before the answer came back, so it was not used. Check the credit note status to see what the server holds.',
  cardRefusedTitle: 'Withdrawal refused',
  cardRefused: "Not withdrawn: this credit note can't be withdrawn now.",
  /** A 403 step_up_required that came back after the confirmation closed: nothing ran; the sign-in path is a new press. */
  cardStepUpTitle: 'Sign in again to withdraw',
  cardStepUp: 'Not withdrawn: your sign-in was too old. Choose Withdraw credit note… again to sign in, then confirm the withdrawal.',
  /** Any other 403, once the one fresh check confirmed it under the same session (rule 4). */
  noLongerAllowed: 'Not withdrawn: you can no longer withdraw credit notes at this store.',
  seenActive: 'This credit note is still active as of this read. The request may still be processed.',
  seenUnconfirmed: "The credit note couldn't be confirmed right now.",
  checkDetached: "This check began under an earlier sign-in, so its answer isn't used. Check again.",
  check: 'Check credit note status',
  checking: 'Checking the credit note…',
  dismiss: 'Dismiss',
  dismissWarning: "Dismissing only stops tracking it here. It doesn't cancel the request.",
});

/** What a refused void attempt says: this request did not void the invoice — never "rolled back", never another request's outcome. */
export const VOID_REFUSED_TEXT: Readonly<Record<VoidRefusal, string>> = Object.freeze({
  'already-void': 'Not voided: this invoice is already void.',
  'version-conflict': 'Not voided: this invoice changed on the server since it was reviewed.',
  /** M7B-PAYMENTS-P1 (doc 15 §12.6): the key's sealed 409 payments_recorded — exactly this sentence. */
  'payments-recorded': "This invoice has payments recorded, so it can't be voided. If a payment was recorded by mistake, reverse that payment first.",
  /** M7B-CREDITNOTES-P1 (doc 16 D-CN-3, CN-27a): the key's sealed 409 credit_notes_recorded — exactly this sentence. */
  'credit-notes-recorded': "This invoice has credit notes, so it can't be voided. If a credit note was issued by mistake, withdraw it first.",
  'tenant-conflict': "Not voided: this store isn't part of that tenant any more.",
  /** A chain 404 on the POST may be the host's refusal before any route ran (design R21): it names no invoice state. */
  'not-found': 'Not voided: the server refused this request.',
  'key-reused': 'Not voided: the server rejected this request.',
  invalid: 'Not voided: the server did not accept this request.',
  'step-up': 'Not voided: your sign-in was too old. Open the invoice to void it again.',
  denied: 'Not voided: you can no longer void invoices at this store.',
  /** R22: the request was sent and refused before anything ran (review B1 truth LOW-3: never "before it was sent"). */
  'signed-out': 'Not voided: your session had ended when it reached the server.',
  'rate-limited': 'Not voided: too many requests. Open the invoice to void it again once the wait has passed.',
});
/** A first send's refusals after which the dialog that sent it reads the invoice again (its state now, never the request's). */
const AFTER_REFUSALS: ReadonlySet<VoidRefusal> = new Set(['already-void', 'not-found', 'version-conflict']);

/**
 * A refused attempt's text: a first send's 403 says "you can no longer void…" only when the one fresh check confirmed it
 * (`confirmedDenial` is that attempt's key), else the neutral refusal (review B1 iam 3).
 */
function refusalTextOf(held: HeldVoid, confirmedDenial: string | null): string {
  if (held.refusal === null) return '';
  return held.refusal === 'denied' && confirmedDenial !== held.key ? VOID_TEXT.refusedPlain : VOID_REFUSED_TEXT[held.refusal];
}
/** Whether a held attempt proves the invoice is voided now: a validated 200 for its key, or its key's sealed already-void. */
const voidedBy = (held: HeldVoid | undefined): held is HeldVoid =>
  held !== undefined && (held.state === 'voided' || (held.state === 'refused' && held.refusal === 'already-void'));

/** What an attempt is doing, as its card and its confirmation say it (a detached one never names its store, design R6). */
function voidStateText(held: HeldVoid, old: boolean): ReactNode {
  const n = held.number;
  const at = <bdi className="break-words">{held.storeLabel}</bdi>;
  if (held.csrf === null) return held.state === 'voided' ? `Invoice ${n} was voided.` : held.state === 'refused' ? `Void of invoice ${n}` : VOID_TEXT.detached;
  switch (held.state) {
    case 'sending': return <>Voiding invoice {n} at {at} on the server…</>;
    case 'checking': return <>Checking the void of invoice {n} at {at} with the server…</>;
    case 'voided': return <>Invoice {n} at {at} was voided.</>;
    case 'refused': return <>Void of invoice {n} at {at}</>;
    default:
      return old
        ? <>Void of invoice {n} at {at} is not confirmed, and it was sent too long ago to check again here. Use Check invoice to see the invoice's current state.</>
        : <>Void of invoice {n} at {at} is not confirmed. The server may or may not have voided it.</>;
  }
}
/** What the last Check invoice read showed (the invoice now, never this attempt's outcome), or nothing. */
function voidSeenText(held: HeldVoid): string {
  if (held.seen === 'voided') return VOID_TEXT.seenVoided(held.number);
  if (held.seen === 'issued') return VOID_TEXT.seenIssued(held.number);
  return '';
}

export interface ServerIssuedInvoicesProps {
  /** The signed-in shop user's UID, or null: nothing is shown without one. */
  readonly uid: string | null;
  readonly session?: TenantSessionClient;
  readonly issuing?: InvoiceIssuingClient;
  /** The store list's source (GET /api/v1/stores, the drafts client's). */
  readonly drafts?: Pick<InvoiceDraftsClient, 'listStores'>;
  readonly identity?: ShopIdentity;
  /** A monotonic clock in milliseconds (default `performance.now()`). */
  readonly now?: () => number;
  /** The wall clock in milliseconds (default `Date.now()`). */
  readonly wallNow?: () => number;
  /** A new Idempotency-Key (default `crypto.randomUUID()`). */
  readonly newKey?: () => string;
  /** The void hold (default the shop's one, invoiceVoidHold.ts): tests give each rig its own; a new store and a remount is a page load. */
  readonly voidHolds?: VoidHoldStore;
  /** The payment hold (default the shop's one, invoicePaymentHold.ts): tests give each rig its own. */
  readonly paymentHolds?: PaymentHoldStore;
  /** The reversal hold (default the shop's one, invoiceReversalHold.ts): tests give each rig its own. */
  readonly reversalHolds?: ReversalHoldStore;
  /** The credit-note hold (default the shop's one, invoiceCreditNoteHold.ts): tests give each rig its own. */
  readonly creditNoteHolds?: CreditNoteHoldStore;
  /** The credit-note withdrawal hold (default the shop's one, invoiceCreditNoteWithdrawalHold.ts): tests give each rig its own. */
  readonly withdrawalHolds?: WithdrawalHoldStore;
  /** Handed the section's credit-note reads while mounted (null on unmount): the component tests drive the refresh with it; the shop passes none. */
  readonly creditReads?: (reads: CreditReads | null) => void;
  /**
   * Whether the chosen store's "Credit activity" is read (doc 18 §4; default true, the shop passes none). The component
   * tests' older describes pass false so their request logs and scripted session answers stay exactly as written.
   */
  readonly creditActivity?: boolean;
}

/** The section's credit-note reads (doc 17 §4.1 and §3.3) as the issue side calls them. */
export interface CreditReads {
  /** This invoice's list again from page one, followed to `target` (an issue's creditNote.id) when one is given. */
  readonly refresh: (storeId: string, invoiceId: string, target: string | null) => void;
  /** The attempts lookup from page one (a new lookup generation): open, Try again, Look up attempt, a re-read after an answer. */
  readonly lookup: (storeId: string, invoiceId: string) => void;
  /** The number of note `id` once its row has loaded under this generation and token, else null (numberPending). */
  readonly numberOf: (storeId: string, invoiceId: string, id: string) => number | null;
  /** Drop every credit-note row, name, cursor and lookup row now (doc 17 §3.6 rule 3). */
  readonly drop: () => void;
}

/** One section per signed-in user (keyed by UID): nothing a previous user's reads answer ever reaches it. */
export function ServerIssuedInvoices(props: ServerIssuedInvoicesProps) {
  const holds = props.voidHolds ?? shopVoidHolds; // read at render, never at this module's top level (design R3)
  // Another user (or none): every other user's void attempt is detached before anything of this one runs (design R12; a
  // layout effect, so before a late answer of the previous section's request).
  const payHolds = props.paymentHolds ?? shopPaymentHolds;
  const revHolds = props.reversalHolds ?? shopReversalHolds;
  const cnHolds = props.creditNoteHolds ?? shopCreditNoteHolds;
  const wdHolds = props.withdrawalHolds ?? shopWithdrawalHolds;
  useLayoutEffect(() => {
    holds.detachOthers(props.uid); payHolds.detachOthers(props.uid); revHolds.detachOthers(props.uid); cnHolds.detachOthers(props.uid); wdHolds.detachOthers(props.uid);
  }, [holds, payHolds, revHolds, cnHolds, wdHolds, props.uid]);
  if (props.uid === null) return null;
  return <IssuedSection key={props.uid} {...props} uid={props.uid} voidHolds={holds} paymentHolds={payHolds} reversalHolds={revHolds} creditNoteHolds={cnHolds} withdrawalHolds={wdHolds} />;
}

type Phase = 'idle' | 'loading' | 'ready' | 'denied' | 'signed-out' | 'rate-limited' | 'unavailable';
interface StoresState { readonly phase: Phase; readonly text: string; readonly stores: readonly StoreEntry[] }
interface Failure { readonly kind: 'denied' | 'signed-out' | 'rate-limited' | 'unavailable'; readonly text: string; readonly seconds?: number }
/** One settings write frozen before it leaves: the exact body ('' once it may never be sent again), its values, the version it expects, its store. */
interface SettingsAttempt {
  readonly key: string; readonly body: string; readonly values: SettingsValues; readonly base: number; readonly storeId: string;
  readonly sentAt: number; readonly sentWall: number; readonly state: 'sending' | 'unresolved' | 'checking'; readonly note: string;
}
type Tone = 'saved' | 'alert' | 'info';
/** The open settings panel: which open it is (`id`), its store, what the server answered, the form, its attempt and what it says. */
interface SettingsPanel {
  readonly id: number; readonly store: StoreEntry;
  readonly phase: 'loading' | 'ready' | 'denied' | 'not-found' | 'unavailable' | 'rate-limited';
  readonly text: string;
  /** The settings the form is based on: its version is what a Save expects. */
  readonly loaded: IssuingSettings | null;
  readonly fields: IssuingSettingsFields;
  readonly errors: IssuingSettingsErrors | null;
  readonly attempt: SettingsAttempt | null;
  readonly status: { readonly tone: Tone; readonly text: string } | null;
  /** A sealed conflict: Save waits for "Load current version". */
  readonly conflict: boolean;
  /** What "Load current version" found (shown beside the kept edits), or null. */
  readonly serverNow: IssuingSettings | null;
  /** A read that keeps the form is out (Load current version, a sign-in's re-read, a save's read-back). */
  readonly reading: boolean;
  /** The version a confirmed save made while its read-back is out (null otherwise): a session end then still says it was saved. */
  readonly saved: number | null;
  readonly stepUp: { readonly method: 'password' | 'google' | null } | null;
  /** A Save of this panel is out from its press (its session check, before any attempt): the form is locked from there. */
  readonly saving: boolean;
  /** A sign-in of this panel is out: Save and Refresh wait for it. */
  readonly confirming: boolean;
  /** An explicit sign-in renewed the session and the settings have not been read since: Save waits for that read. */
  readonly needsRead: boolean;
}

/** One store's issued list as read under one generation: its pages (rows in the server's order) and the cursor after them. */
interface ListState {
  readonly gen: number; readonly storeId: string;
  readonly phase: 'idle' | 'loading' | 'ready' | 'denied' | 'rate-limited' | 'unavailable';
  readonly text: string; readonly rows: readonly IssuedSummary[]; readonly next: string | null; readonly note: string;
}
/** The open issued-invoice dialog: which open it is, what it reads, and its store as the server's list named it (null: none). */
interface ViewOpen { readonly id: number; readonly storeId: string; readonly invoiceId: string; readonly store: StoreEntry | null }
/**
 * The credit-note reads of ONE invoice under ONE section generation AND token (doc 17 §3.6 rule 2): `failSession` keeps the
 * number and Reconnect's token comes in as a first token, so the token is part of the key. Any token change, a sign-out, a
 * renewal or a confirmed denial drops it whole; nothing read under one session joins another's.
 */
interface CreditSlice {
  readonly id: number; readonly n: number; readonly csrf: string | null; readonly storeId: string; readonly invoiceId: string;
  readonly list: CreditNotesList | null; readonly lookup: CreditNotesLookup | null;
}

/**
 * The chosen store's credit activity (doc 18 §4) under ONE generation AND token: its traversal's rows (newest number first,
 * as served) and the cursor after them. `hidden`: a classified 403 (§8.4) — nothing rendered, nothing asked again for this
 * store under this generation. `via`: which press started the traversal (its button stays, so focus stays on it);
 * `reloaded`: started by a context change (a second one shows the error, D17:571).
 */
interface ActivityState {
  readonly n: number; readonly csrf: string | null; readonly storeId: string;
  readonly phase: 'loading' | 'ready' | 'failed' | 'rate-limited' | 'hidden';
  readonly rows: readonly StoreCreditNote[]; readonly next: string | null; readonly complete: boolean; readonly more: boolean;
  readonly said: string; readonly via: 'refresh' | 'retry' | null; readonly reloaded: boolean;
  /** The chosen store's tenant as the directory listed it when page one was asked: every later page needs the same (§4.4). */
  readonly tenantId: string | null;
}
const STORES_IDLE: StoresState = Object.freeze({ phase: 'idle', text: '', stores: [] });
const listOf = (gen: number, storeId: string, phase: ListState['phase'] = 'idle', text = ''): ListState =>
  Object.freeze({ gen, storeId, phase, text, rows: [], next: null, note: '' });
const LIST_IDLE: ListState = listOf(0, '');
const issuedOpenIdOf = (id: string): string => `issued-open-${id}`;
const UNAVAILABLE: Failure = Object.freeze({ kind: 'unavailable', text: ISSUED_TEXT.unavailable });

function sessionFailure(s: Exclude<SessionResult, { kind: 'ok' }>): Failure {
  if (s.kind === 'no-identity') return { kind: 'signed-out', text: ISSUED_TEXT.noIdentity };
  if (s.kind === 'refused') return { kind: 'signed-out', text: ISSUED_TEXT.refused };
  if (s.kind === 'ended') return { kind: 'signed-out', text: ISSUED_TEXT.ended };
  if (s.kind === 'rate-limited') return { kind: 'rate-limited', text: '', seconds: s.retryAfterSeconds ?? DEFAULT_WAIT_SECONDS };
  return UNAVAILABLE;
}

function IssuedSection({
  uid, session = tenantSession, issuing = issuingClient, drafts = draftsClient, identity = firebaseShopIdentity, now, wallNow, newKey, voidHolds: holds = shopVoidHolds, paymentHolds: payHolds = shopPaymentHolds,
  reversalHolds: revHolds = shopReversalHolds, creditNoteHolds: cnHolds = shopCreditNoteHolds, withdrawalHolds: wdHolds = shopWithdrawalHolds, creditReads, creditActivity = true,
}: ServerIssuedInvoicesProps & { readonly uid: string }) {
  const [open, setOpen] = useState(false);
  const [stores, setStoresState] = useState<StoresState>(STORES_IDLE);
  const [storeId, setStoreIdState] = useState('');
  const [busy, setBusyState] = useState(false);
  const [wait, setWait] = useState<number | null>(null);
  const [changed, setChanged] = useState(false);
  const [notice, setNotice] = useState('');
  const [detached, setDetached] = useState(false);
  const [panel, setPanelState] = useState<SettingsPanel | null>(null);
  const [password, setPassword] = useState('');
  const [focusInvalid, setFocusInvalid] = useState(0);
  const [list, setListState] = useState<ListState>(LIST_IDLE);
  const [view, setViewState] = useState<ViewOpen | null>(null);

  const gen = useRef<{ n: number; csrf: string | null }>({ n: 0, csrf: null }); // the token: refs only
  const alive = useRef(false);
  const storesRef = useRef<StoresState>(stores);
  const storeRef = useRef('');
  const panelRef = useRef<SettingsPanel | null>(null);
  const panelSeq = useRef(0); // which panel open is the latest
  const listRef = useRef<ListState>(list);
  const viewRef = useRef<ViewOpen | null>(null);
  const viewSeq = useRef(0); // which dialog open is the latest
  const seq = useRef({ stores: 0, settings: 0, list: 0, find: 0 });
  const ctl = useRef<Record<'stores' | 'settings' | 'list' | 'find', AbortController | null>>({ stores: null, settings: null, list: null, find: null });
  // The void attempt (M7B-INVOICES-VOID-P2): held in the void hold for this uid, outside every dialog. What its last Check
  // invoice read could not say (by key), the key a Check invoice is out for, the key whose Check again waits after an
  // in-progress answer — and refs that hold a second press back while a send, a check, a read or a sign-in is out.
  const voidHeld = useSyncExternalStore(holds.subscribe, () => holds.get(uid));
  const [voidCheck, setVoidCheck] = useState<{ readonly key: string; readonly text: string } | null>(null);
  const [voidFinding, setVoidFinding] = useState<string | null>(null);
  const [voidCool, setVoidCool] = useState<string | null>(null);
  const voidCoolRef = useRef<string | null>(null);
  const voidCoolTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const voidSending = useRef(false);
  const voidChecking = useRef<string | null>(null);
  const voidReading = useRef<string | null>(null);
  // The void's explicit sign-in this section is waiting for (R11; R1: one owner at a time, bounded): a tab return checks
  // nothing meanwhile. Only that owner releases it — at its own end, its deadline, a stop, a close or a session change.
  const signingIn = useRef<VoidSignInOwner | null>(null);
  const [voidSigning, setVoidSigning] = useState(false); // the same, for the dialog's "Void invoice…" (R2-1a)
  const eligChecked = useRef(new Set<number>()); // the opens whose eligibility 403 had its one fresh check (R14)
  // One fresh check per open shared by its detail and eligibility reads when both are refused (review B1 iam 1).
  const viewDenial = useRef(new Map<number, Promise<'denied' | Failure | null>>());
  // The attempt whose first-send 403 the one fresh check confirmed: only it says "you can no longer void…" (iam 3).
  const [voidDenied, setVoidDenied] = useState<string | null>(null);
  const voidCardHeading = useRef<HTMLHeadingElement | null>(null);
  const revSectionHeading = useRef<HTMLHeadingElement | null>(null);
  // The reversal attempt (M7B-PAYMENTS-P2C): held in the reversal hold for this uid, outside every dialog (the void's model).
  const revHeld = useSyncExternalStore(revHolds.subscribe, () => revHolds.get(uid));
  const [revCheck, setRevCheck] = useState<{ readonly key: string; readonly text: string } | null>(null);
  const [revFinding, setRevFinding] = useState<string | null>(null);
  const [revCool, setRevCool] = useState<string | null>(null);
  const revCoolRef = useRef<string | null>(null);
  const revCoolTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const revSending = useRef(false);
  const revChecking = useRef<string | null>(null);
  const revReading = useRef<string | null>(null);
  const revFindCtl = useRef<AbortController | null>(null);
  // The credit-note withdrawal attempts (CN-P3): one per invoice of this uid in the withdrawal hold (the reversal's model, no Retry).
  const wdMine = useSyncExternalStore(wdHolds.subscribe, () => wdHolds.of(uid));
  const wdSlot = (storeId: string, invoiceId: string): string => withdrawalSlot(uid, storeId, invoiceId);
  const wdAt = (storeId: string, invoiceId: string): HeldWithdrawal | undefined => wdHolds.get(wdSlot(storeId, invoiceId));
  // Per attempt (its key) and per slot: each invoice's Check credit note status runs and says on its own (R2).
  const [wdCheck, setWdCheck] = useState<Readonly<Record<string, string>>>({});
  const [wdFinding, setWdFinding] = useState<ReadonlySet<string>>(new Set());
  const [wdDenied, setWdDenied] = useState<string | null>(null); // the attempt whose 403 the one fresh check confirmed (rule 4)
  const wdSending = useRef(new Set<string>()); // the slots whose POST is out (one per invoice)
  const wdReading = useRef(new Map<string, string>()); // slot → the key its status read is for
  const wdFindCtl = useRef(new Map<string, AbortController>()); // slot → that read's controller
  const dropWdCheck = (key: string): void => setWdCheck((was) => { if (!(key in was)) return was; const { [key]: _gone, ...rest } = was; return rest; });
  // The payment attempt (M7B-PAYMENTS-P2B): held in the payment hold for this uid; the lookup the section ran for the open
  // dialog's invoice; a ref that holds every second payment press back while one chain is out (one chain per press).
  const payHeld = useSyncExternalStore(payHolds.subscribe, () => payHolds.get(uid));
  const [lookup, setLookupState] = useState<PaymentLookup | null>(null);
  const lookupRef = useRef<PaymentLookup | null>(null);
  const lookupSeq = useRef(0);
  const lookupCtl = useRef<AbortController | null>(null);
  const paying = useRef(false);
  const confirming = useRef(false); // a Confirm press out (R1 S12)
  /** R8: per attempt, the stage (and its key) this section's chain last sent — its own hold, not one re-created under that attempt. */
  const sentStage = useRef(new Map<string, Pick<HeldPayment, 'stage' | 'stageKey'>>());
  // Whether a payment chain or Confirm is out (R2 N2): Find and row actions say so instead of ignoring a press.
  const [payOut, setPayOut] = useState(false);
  const setPaying = (on: boolean): void => { paying.current = on; setPayOut(on || confirming.current); };
  const setConfirming = (on: boolean): void => { confirming.current = on; setPayOut(on || paying.current); };
  // Credit notes (M7B-CREDITNOTES-CN-P2): one invoice's list and attempts lookup under one generation and token (CreditSlice),
  // each read kind with its own sequence and abort; and the stores whose lookup 403 the one check confirmed under a
  // generation and token (`${n}:${csrf}:${store}`): never asked again there (doc 17 §2.2).
  const [credit, setCreditState] = useState<CreditSlice | null>(null);
  const creditRef = useRef<CreditSlice | null>(null);
  const creditIds = useRef(0);
  const creditSeq = useRef({ list: 0, lookup: 0 });
  const creditCtl = useRef<Record<'list' | 'lookup', AbortController | null>>({ list: null, lookup: null });
  const lookupDenied = useRef(new Set<string>());
  // The store-wide credit activity (doc 18 §4): its state, its own request sequence and abort (the directory read of a 403's
  // classification takes a number of it too), and every store this tab's directory listed under this generation and token
  // (id → tenantId): what §8.4 compares a same-token 403 against.
  const [activity, setActivityState] = useState<ActivityState | null>(null);
  const activityRef = useRef<ActivityState | null>(null);
  const activitySeq = useRef(0);
  const activityCtl = useRef<AbortController | null>(null);
  const listed = useRef<{ readonly key: string; readonly stores: Map<string, string> }>({ key: '', stores: new Map() });
  // The credit-note attempt (CN-P2 issue side): held in the credit-note hold for this uid, outside every dialog; what its card
  // says (by attempt) and the section's live pair; the shop-observed sign-in under the token it gave (doc 17 §2.5: the only
  // sign-in time this page knows); a press counter (a chain runs on only while its press is the latest credit-note press);
  // a ref that holds a second press back; and a bump that makes the open dialog read its amounts again.
  const cnHeld = useSyncExternalStore(cnHolds.subscribe, () => cnHolds.get(uid));
  const [cnSay, setCnSay] = useState<CreditSay | null>(null);
  const cnSayRef = useRef<CreditSay | null>(null);
  // The stages whose replay the card has said is unavailable for this attempt ('proof': no continuation): never offered again.
  // Kept per stage KEY: a new settlement key starts open again (§3.2 counts each key's own limit).
  const cnMemo = cnMemoOf(cnHolds);
  /** This attempt's memo (another attempt's is dropped). */
  const memoFor = (a: string): CreditCardMemo => { const m = cnMemo.get(uid); return m?.attemptId === a ? m : { attemptId: a, stages: [], bare: null, last: null }; };
  const [cnFocusFind, setCnFocusFind] = useState(0);
  const [, setCnTick] = useState(0);
  const [cnLive, setCnLiveState] = useState<CreditLive>(CN_QUIET);
  const setCnLive = (x: { readonly status: string; readonly alert: string }): void => setCnLiveState((was) => ({ ...x, n: was.n + 1, sn: was.n + 1, an: was.n + 1 }));
  /** A status-only line beside the card's (§2.6 status: checkUntil, numberPending): the alert region is left as it is. */
  const setCnStatus = (status: string): void => setCnLiveState((was) => ({ ...was, status, n: was.n + 1, sn: was.n + 1 }));
  const cnBusyBy = useRef(0);
  // The list chain (by its sequence) that was still out when the lookup's denial was confirmed (rule 4): judged on arrival.
  const creditViewLost = useRef(0);
  // The token of the last same-token denial a check confirmed (rule 1): what a no-access line records (rule 4).
  const cnDeniedAt = useRef<string | null>(null);
  // Same-token denials confirmed so far, and the fresh checks still out (by the token the refused request carried).
  const cnDenials = useRef(0);
  const cnPendingChecks = useRef(new Set<{ readonly token: string | null; readonly check: Promise<void> }>());
  const signedAt = useRef<(CreditNoteSignIn & { readonly csrf: string }) | null>(null);
  const cnPress = useRef(0);
  const cnSending = useRef(false);
  const [cnBusy, setCnBusyState] = useState(false);
  const [cnRereads, setCnRereads] = useState(0);
  const cnTimers = useRef(new Set<ReturnType<typeof setTimeout>>());
  const [payCool, setPayCool] = useState(false);
  const payCoolRef = useRef(false);
  const payCoolTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const waitRef = useRef(false);
  const waitUntil = useRef(0);
  const waitTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const busyRef = useRef(false);
  const busyBy = useRef(0);
  // The panel (by its id) whose Save, Check again or sign-in is out: a second press on THAT panel sends nothing, and a
  // panel opened after it closed is never held up by its request.
  const savingRef = useRef<number | null>(null);
  const checkingRef = useRef<number | null>(null);
  const confirmingRef = useRef<number | null>(null);
  const replacing = useRef(0); // the latest read that replaces the form (its seq)
  // The session token the panel's attempt was sent with (by its key): in a ref only; Check again sends with it and nothing else.
  const attemptToken = useRef<{ readonly key: string; readonly csrf: string } | null>(null);
  const heading = useRef<HTMLHeadingElement | null>(null);
  const section = useRef<HTMLElement | null>(null);
  const panelTitle = useRef<HTMLHeadingElement | null>(null);
  const saveButton = useRef<HTMLButtonElement | null>(null);
  const passwordRef = useRef<HTMLInputElement | null>(null);
  const confirmRef = useRef<HTMLButtonElement | null>(null);
  const loadMore = useRef<HTMLButtonElement | null>(null);
  const listRetry = useRef<HTMLButtonElement | null>(null);
  // The section control that last took focus — and whether it was in the settings panel, judged while it is still attached —
  // and where focus goes if a render removes or disables it while it still has focus (the drafts section's DA-199 rule):
  // `to` when a change named a place (Load more's last page: its first row), else the panel's title, else the heading. A
  // press elsewhere ends the tracking.
  const keepFocus = useRef<{ readonly from: Element; readonly inPanel: boolean; readonly to?: () => HTMLElement | null } | null>(null);

  const clock = (): number => (now ?? (() => performance.now()))();
  const wall = (): number => (wallNow ?? (() => Date.now()))();
  const nextKey = (): string => (newKey ?? (() => crypto.randomUUID()))();
  const connect = (mode?: 'fresh' | 'reconnect'): Promise<SessionResult> =>
    session.ensure(uid, () => identity.idToken(uid), mode === 'fresh' ? { fresh: true } : mode === 'reconnect' ? { reconnect: true } : undefined);
  const putStores = (next: StoresState): void => { storesRef.current = next; setStoresState(next); };
  const putList = (next: ListState): void => { listRef.current = next; setListState(next); };
  /** Close the issued-invoice dialog (its own read's late answer then finds nothing: it is unmounted), and stop waiting for its sign-in (R1). */
  const closeView = (): void => {
    dropSignIn(null);
    dropLookup();
    dropCredit(); // its credit-note rows, names and lookup go with it; an issue's refresh starts its own
    // A decided attempt's text (and a denial) goes with the dialog (R2 R4): a later open offers what its eligibility says.
    const done = payHolds.get(uid);
    const closing = viewRef.current;
    // R3-12: only the closing dialog's own invoice's decided attempt goes.
    if (done !== undefined && done.state === 'done' && closing !== null && done.storeId === closing.storeId && done.invoiceId === closing.invoiceId) payHolds.remove(uid, done.key);
    // The same for a settled reversal attempt of the closing invoice (P2C): an unresolved one stays (its card).
    const rev = revHolds.get(uid);
    if (rev !== undefined && (rev.state === 'reversed' || rev.state === 'refused') && closing !== null && rev.storeId === closing.storeId && rev.invoiceId === closing.invoiceId) revHolds.remove(uid, rev.key);
    // And an ended credit-note attempt of the closing invoice (CN-P2): an open one stays (its card, its blockers).
    const cn = cnHolds.get(uid);
    if (cn !== undefined && cnEnded(cn) && closing !== null && cn.storeId === closing.storeId && cn.invoiceId === closing.invoiceId) cnHolds.remove(uid, cn.attemptId);
    // And a settled withdrawal of the closing invoice (CN-P3): an unresolved one stays (its card when it is opened again).
    const wd = closing === null ? undefined : wdAt(closing.storeId, closing.invoiceId);
    if (wd !== undefined && (wd.state === 'withdrawn' || wd.state === 'refused')) wdHolds.remove(wdSlot(wd.storeId, wd.invoiceId), wd.key);
    revFindCtl.current?.abort();
    for (const c of wdFindCtl.current.values()) c.abort();
    viewRef.current = null;
    setViewState(null);
  };
  const putPanel = (next: SettingsPanel | null): void => {
    panelRef.current = next;
    if (next?.attempt?.key !== attemptToken.current?.key) attemptToken.current = null; // the token goes with its attempt
    setPanelState(next);
  };
  /** Change the open panel when it is still the one `id` names (a closed or replaced panel's continuation changes nothing). */
  const patchPanel = (id: number, next: Partial<SettingsPanel>): boolean => {
    if (panelRef.current === null || panelRef.current.id !== id) return false;
    putPanel({ ...panelRef.current, ...next });
    return true;
  };
  /**
   * Close the panel AT ONCE for a store change, a session that is over or changed (its values, any attempt, its key, body
   * and token go in a render committed here, flushSync); an unconfirmed attempt leaves only the "could not be confirmed"
   * note. Called only outside React's render and commit.
   */
  const dropPanel = (): void => {
    attemptToken.current = null;
    ctl.current.settings?.abort();
    seq.current.settings += 1;
    const p = panelRef.current;
    if (p === null) return;
    panelRef.current = null;
    const lost = p.attempt !== null; // held, aged out or detached: never confirmed either way
    flushSync(() => {
      setPanelState(null);
      setPassword('');
      if (lost) setDetached(true);
      if (p.saved !== null) setNotice(SETTINGS_TEXT.savedEnded(p.saved)); // confirmed, never read back: still said
    });
  };
  const setBusy = (next: boolean): void => { busyRef.current = next; setBusyState(next); };
  const takeBusy = (): number => { setBusy(true); return ++busyBy.current; };
  const giveBusy = (token: number): void => { if (alive.current && busyBy.current === token) setBusy(false); };
  const waitLeft = (): number => Math.max(1, Math.ceil((waitUntil.current - clock()) / 1000));
  const expired = (a: { readonly sentAt: number; readonly sentWall: number }): boolean => Math.max(clock() - a.sentAt, wall() - a.sentWall) >= CHECK_CUTOFF_MS;

  function clearWait(): void {
    if (waitTimer.current !== null) clearTimeout(waitTimer.current);
    waitTimer.current = null;
    waitRef.current = false;
    setWait(null);
  }
  /** A rate limit's delay: the controls come back when it has passed (nothing is read or sent on its own), never sooner. */
  function startWait(seconds: number): number {
    const until = clock() + seconds * 1000;
    if (waitRef.current && until <= waitUntil.current) return waitLeft();
    if (waitTimer.current !== null) clearTimeout(waitTimer.current);
    waitUntil.current = until;
    waitRef.current = true;
    setWait(seconds);
    waitTimer.current = setTimeout(() => { waitTimer.current = null; waitRef.current = false; setWait(null); }, seconds * 1000);
    return seconds;
  }

  /** Cancel every read in flight; their answers are stale from here, and nothing is busy any more. */
  function abortReads(): void {
    ctl.current.stores?.abort();
    ctl.current.settings?.abort();
    ctl.current.list?.abort();
    ctl.current.find?.abort();
    seq.current = { stores: seq.current.stores + 1, settings: seq.current.settings + 1, list: seq.current.list + 1, find: seq.current.find + 1 };
    busyBy.current += 1;
    setBusy(false);
  }

  /**
   * A token this section now holds that the void attempt was not sent with (design R12: the first and every later token
   * `adopt` finds, `begin`, `renew`, `renewKeepingView`): that attempt — live or settled — is detached, never sent again.
   */
  function judgeVoid(csrf: string): void {
    const h = holds.get(uid);
    if (h !== undefined && h.csrf !== null && h.csrf !== csrf) holds.detach(uid);
    const p = payHolds.get(uid);
    if (p !== undefined && p.csrf !== null && p.csrf !== csrf) detachPay(); // a payment attempt too (spec §7)
    const r = revHolds.get(uid);
    if (r !== undefined && r.csrf !== null && r.csrf !== csrf) detachRev(); // and a reversal attempt (P2C)
    const c = cnHolds.get(uid);
    if (c !== undefined && c.csrf !== null && c.csrf !== csrf) cnHolds.detach(uid); // and a credit-note attempt (doc 17 §3.6 rule 3)
    for (const w of wdHolds.of(uid)) if (w.csrf !== null && w.csrf !== csrf) wdHolds.detach(wdSlot(w.storeId, w.invoiceId)); // and withdrawal attempts (CN-P3)
  }
  /** Detach the reversal attempt for good (token change, sign-out, store switch): one still out is never left sending. */
  function detachRev(): void {
    const h = revHolds.get(uid);
    if (h === undefined) return;
    if (h.csrf !== null) revHolds.detach(uid);
    if (h.state === 'sending' || h.state === 'checking') revHolds.change(uid, h.key, { state: 'unresolved', note: '' });
  }
  /** After an in-progress answer (5 s) or a Retry's 429 (its Retry-After), Retry reversal waits; the timer only gives it back. */
  function coolReversal(key: string, ms: number): void {
    if (revCoolTimer.current !== null) clearTimeout(revCoolTimer.current);
    revCoolRef.current = key;
    setRevCool(key);
    revCoolTimer.current = setTimeout(() => { revCoolTimer.current = null; revCoolRef.current = null; setRevCool(null); }, ms);
  }
  /** Past the cutoff, the bytes go (a focus, a tab return; the hold's own timer too). Never a send. */
  function scrubVoid(): void {
    const h = holds.get(uid);
    if (h !== undefined && h.body !== '' && voidExpired(h, clock(), wall())) holds.change(uid, h.key, { body: '' });
    const p = payHolds.get(uid);
    if (p !== undefined && p.body !== '' && paymentExpired(p, clock(), wall())) payHolds.change(uid, p.key, { body: '', proof: null });
    const r = revHolds.get(uid);
    if (r !== undefined && r.body !== '' && reversalExpired(r, clock(), wall())) revHolds.change(uid, r.key, { body: '' });
  }
  /** After an in-progress answer Check again waits a moment; the timer only gives it back. */
  function coolVoid(key: string): void {
    if (voidCoolTimer.current !== null) clearTimeout(voidCoolTimer.current);
    voidCoolRef.current = key;
    setVoidCool(key);
    voidCoolTimer.current = setTimeout(() => { voidCoolTimer.current = null; voidCoolRef.current = null; setVoidCool(null); }, IN_PROGRESS_WAIT_MS);
  }

  // ---- recording a payment (M7B-PAYMENTS-P2B) ----

  const putLookup = (next: PaymentLookup | null): void => { lookupRef.current = next; setLookupState(next); };
  /** The lookup goes with the dialog (its late pages find nothing). */
  function dropLookup(): void {
    lookupSeq.current += 1;
    lookupCtl.current?.abort();
    if (lookupRef.current !== null) putLookup(null);
  }
  /**
   * Detach the payment attempt for good (a token change, a sign-out, a store switch): its token, bytes and proof go, so
   * it is never sent again; one still out or unresolved then says so, and only the lookup decides it.
   */
  function detachPay(): void {
    const h = payHolds.get(uid);
    if (h === undefined) return;
    if (h.csrf !== null) payHolds.detach(uid);
    // Detached elsewhere too (the hold's own sign-out binding): one left out or unresolved is never left "sending" (R1 S1).
    if (h.state === 'sending' || h.state === 'checking' || h.state === 'unresolved') payHolds.change(uid, h.key, { state: 'unresolved', say: 'detached', body: '', proof: null });
    else if (h.state === 'recorded' && h.say !== 'detached') payHolds.change(uid, h.key, { say: 'detached' });
  }
  /** Progressing or settling an attempt (R2 R5): a lookup still out is dropped, so its late answer cannot overwrite what follows. */
  function invalidateLookup(): void {
    lookupSeq.current += 1;
    lookupCtl.current?.abort();
    if (lookupRef.current?.phase === 'loading') putLookup(null);
  }
  /** After a press's chain: an attempt it left out (a context that went mid-way) is never left "sending" or "checking". */
  function unstick(key: string): void {
    const h = payHolds.get(uid);
    if (h === undefined || h.key !== key || (h.state !== 'sending' && h.state !== 'checking')) return;
    const sent = sentStage.current.get(key);
    if (sent !== undefined && (h.stage !== sent.stage || h.stageKey !== sent.stageKey)) return; // R8: another chain's hold, its own send out
    payHolds.change(uid, key, h.csrf === null ? { state: 'unresolved', say: 'detached', body: '', proof: null } : { state: 'unresolved', say: 'uncertain' });
  }
  function coolPay(): void {
    if (payCoolTimer.current !== null) clearTimeout(payCoolTimer.current);
    payCoolRef.current = true;
    setPayCool(true);
    payCoolTimer.current = setTimeout(() => { payCoolTimer.current = null; payCoolRef.current = false; setPayCool(false); }, IN_PROGRESS_WAIT_MS);
  }
  /** One session check before a payment request: its token, or null (the failure handled: a sign-out ends the session, a 429 waits). */
  async function payConnect(stands: () => boolean): Promise<string | null> {
    const s = await connect();
    if (!stands()) return null;
    if (s.kind !== 'ok') {
      const failure = sessionFailure(s);
      if (failure.kind === 'signed-out') failSession(failure);
      else if (failure.seconds !== undefined) startWait(failure.seconds);
      return null;
    }
    return s.csrf;
  }

  /** The held stage's ONE request, with the token it was held with: its exact key and bytes (the proof: the same GET). */
  function sendStage(h: HeldPayment, csrf: string): Promise<RegisterResult | ProofResult | RecordResult | SettleResult> {
    switch (h.stage) {
      case 'register': return issuing.registerPayment(h.storeId, h.invoiceId, h.stageKey, h.body, csrf);
      case 'proof': return issuing.paymentProof(h.storeId, h.invoiceId, h.body, h.key, csrf);
      case 'record': return issuing.recordPayment(h.storeId, h.invoiceId, h.stageKey, h.body, csrf);
      case 'settle': return issuing.settlePayment(h.storeId, h.invoiceId, h.stageKey, h.body, csrf);
    }
  }

  /**
   * The held attempt's chain from its current stage (`first`: that stage's first send, else a Check again): each answer is
   * settled BY ATTEMPT in the hold whatever is mounted, and the next stage is held (key and bytes) BEFORE it leaves —
   * register 201 → the proof GET → the record under a NEW key. An answer after the token changed or a sign-out began
   * proves nothing: the attempt is detached. Never a retry: an undecided answer leaves it for Check again or the lookup.
   */
  async function runStage(attemptId: string, first: boolean): Promise<void> {
    let firstSend = first;
    for (;;) {
      const h = payHolds.get(uid);
      if (h === undefined || h.key !== attemptId || h.csrf === null || h.body === '') return;
      const csrf = h.csrf;
      const since = sessionEndsSoFar();
      payHolds.change(uid, attemptId, { lastSentAt: clock() }); // R4: the stage's LATEST send, for runLookup's quiet window
      sentStage.current.set(attemptId, { stage: h.stage, stageKey: h.stageKey });
      const answer = await sendStage(h, csrf);
      const now = payHolds.get(uid);
      if (now === undefined || now.key !== attemptId) return;
      // R8: an answer settles only the hold that sent it — the same stage under the same stage key, still undecided. A hold
      // re-created under this attempt meanwhile (a row's settlement after a remount, the same token) or one already decided
      // is never changed by it, so a late answer can never start the next stage (a record) on it.
      if (now.stage !== h.stage || now.stageKey !== h.stageKey || now.state === 'done') return;
      if (now.csrf !== csrf || since !== sessionEndsSoFar()) return detachPay();
      if (answer.kind === 'rate-limited') startWait(answer.retryAfterSeconds);
      const v = judgePayment(h.stage, answer, firstSend);
      const bump = (yes: boolean): number => h.rereads + (yes ? 1 : 0);
      if (v.kind === 'registered') {
        payHolds.change(uid, attemptId, { stage: 'proof', stageKey: '', body: v.registrationId, registrationId: v.registrationId, sentAt: clock(), sentWall: wall(), state: 'sending', say: '' });
        firstSend = true;
        continue;
      }
      if (v.kind === 'proof') {
        const body = h.registrationId === null || h.method === null ? null : recordBodyOf({
          expectedTenant: h.tenantId, registrationId: h.registrationId, attemptId, amountCents: h.amountCents, method: h.method, registrationProof: v.proof,
        });
        if (body === null) { payHolds.change(uid, attemptId, { state: 'lookup', say: 'detached', body: '', proof: null }); return; }
        // The record's NEW key and exact bytes are held BEFORE it leaves; the proof stays in memory only.
        payHolds.change(uid, attemptId, { stage: 'record', stageKey: nextKey(), body, proof: v.proof, sentAt: clock(), sentWall: wall(), state: 'sending', say: '' });
        firstSend = true;
        continue;
      }
      if (v.kind === 'recorded') {
        const method = v.payment?.method ?? h.method ?? 'cash';
        payHolds.change(uid, attemptId, {
          state: 'recorded', say: '', body: '', proof: null, payment: v.payment ?? { id: null, amountCents: h.amountCents, method }, rereads: bump(true),
        });
      } else if (v.kind === 'settled') {
        // A confirmation from the lookup (no registration id here) reads page one once; the press's own Confirm reads nothing.
        payHolds.change(uid, attemptId, { state: 'done', say: v.state, body: '', proof: null, rereads: bump(v.state === 'confirmed' && h.registrationId === null) });
        const l = lookupRef.current;
        if (l !== null && l.storeId === h.storeId && l.invoiceId === h.invoiceId) putLookup({ ...l, rows: l.rows.filter((r) => r.attemptId !== attemptId) });
      } else if (v.kind === 'final') {
        payHolds.change(uid, attemptId, { state: 'done', say: v.say, body: '', proof: null, rereads: bump(v.reread) });
        if (v.lookup) void runLookup(h.storeId, h.invoiceId); // this attempt wrote nothing: no hold blocks, the lookup shows the other one
      } else if (v.kind === 'lookup') {
        payHolds.change(uid, attemptId, { state: 'lookup', say: v.say, body: '', proof: null, rereads: bump(v.reread) });
        void runLookup(h.storeId, h.invoiceId);
      } else {
        payHolds.change(uid, attemptId, { state: 'unresolved', say: v.say, retryAfter: v.retryAfter });
        if (v.say === 'inProgress') coolPay();
      }
      if (answer.kind === 'signed-out') failSession({ kind: 'signed-out', text: ISSUED_TEXT.ended });
      return;
    }
  }

  /**
   * One Record press (spec §4): ONE chain. The section's ref holds a second press back before any render; after the
   * session check the context is checked again, then the attempt id and register key are minted and the attempt held
   * BEFORE the register leaves. Null when it went (the hold says what next); otherwise why nothing was sent.
   */
  async function recordPayment(viewId: number, store: StoreEntry, press: PaymentPress): Promise<string | null> {
    if (paying.current) return SETTINGS_TEXT.busy;
    if (waitRef.current) return pickerWaitText(waitLeft());
    // Before anything is minted, and again after the session check (R3 S-3): an undecided attempt elsewhere, at any stage, is
    // finished there, never replaced from here, and named even while it still blocks this store (G3, R5); an undecided one on
    // this invoice is decided only by the lookup and a settlement (G1, G1b, R3 S-1); an unsettled attempt the lookup lists on
    // this invoice holds its slot, so a new press would only be refused again (R5 B).
    const gate = (h: HeldPayment | undefined): string | null => {
      if (lookupListsUnsettled(lookupRef.current, store.id, press.invoiceId)) return RECORD_TEXT.writeConflict;
      // R8 (review F3): never a payment on an invoice while a reversal of one of its payments is unresolved.
      const r = revHolds.get(uid);
      if (isLiveReversal(r) && r.storeId === store.id && r.invoiceId === press.invoiceId) return REVERSE_TEXT.pending;
      if (withdrawingHere(store.id, press.invoiceId)) return REVERSE_TEXT.pending; // nor while a withdrawal on it is unresolved (CN-P3)
      if (h === undefined || !isOpenPayment(h)) return null;
      if (isPaymentHeldElsewhere(h, store.id, press.invoiceId)) return finishOnText(h, store.id);
      if (isBlockingPayment(h) && h.storeId === store.id) return SETTINGS_TEXT.busy;
      return h.storeId === store.id && h.invoiceId === press.invoiceId ? RECORD_TEXT.writeConflict : null;
    };
    const shut = gate(payHolds.get(uid));
    if (shut !== null) return shut;
    setPaying(true);
    try {
      const mine = gen.current.n;
      const since = sessionEndsSoFar();
      const stands = (): boolean => alive.current && mine === gen.current.n && since === sessionEndsSoFar() && storeRef.current === store.id
        && viewRef.current?.id === viewId && viewRef.current.invoiceId === press.invoiceId;
      const csrf = await payConnect(stands);
      if (csrf === null) return !stands() ? RECORD_TEXT.notSent : waitRef.current ? pickerWaitText(waitLeft()) : ISSUED_TEXT.unavailable; // nothing sent: said
      if (adopt(csrf) || !stands()) return RECORD_TEXT.notSent;
      const shutNow = gate(payHolds.get(uid));
      if (shutNow !== null) return shutNow;
      const attemptId = nextKey();
      const stageKey = nextKey();
      const body = registerBodyOf(store.tenantId, attemptId);
      if (body === null) return RECORD_TEXT.notAccepted;
      const held: HeldPayment = {
        key: attemptId, storeId: store.id, tenantId: store.tenantId, invoiceId: press.invoiceId, number: press.number, csrf, stage: 'register', stageKey, body,
        sentAt: clock(), sentWall: wall(), lastSentAt: clock(), registrationId: null, proof: null, amountCents: press.amountCents, method: press.method, payment: null, settleVersion: null,
        state: 'sending', say: '', retryAfter: 0, rereads: 0,
      };
      const was = payHolds.get(uid);
      const wasKey = was?.key;
      if (wasKey !== undefined && !isOpenPayment(was)) payHolds.remove(uid, wasKey); // a decided one only: the gate refuses every open one (R5)
      if (!payHolds.put(uid, held)) return SETTINGS_TEXT.busy;
      dropLookup();
      try { await runStage(attemptId, true); } finally { unstick(attemptId); }
      return null;
    } finally {
      setPaying(false);
    }
  }

  /** A store's label for the text (R3 M2); one no longer listed is "another store". */
  function storeNameOf(id: string): string {
    const entry = storesRef.current.stores.find((s) => s.id === id);
    return entry === undefined ? 'another store' : storeLabel(entry);
  }
  /** "Finish your payment attempt on invoice N first." — its store named when it is not `here`. */
  const finishOnText = (h: HeldPayment, here: string): string => RECORD_TEXT.finishOn(h.number, h.storeId === here ? null : storeNameOf(h.storeId));

  /** Whether the held attempt may be sent here now: same token (session generation), the same store chosen with its tenant, within 23 h. */
  function paySendable(h: HeldPayment): boolean {
    const store = storesRef.current.stores.find((entry) => entry.id === h.storeId);
    return h.csrf !== null && h.csrf === gen.current.csrf && storeRef.current === h.storeId && store?.tenantId === h.tenantId;
  }

  /** "Check again" (spec §5): the held stage's exact bytes under its same key (the proof: the same GET) — only a user press. */
  async function checkPayment(): Promise<void> {
    const h = payHolds.get(uid);
    if (paying.current || h === undefined || h.state !== 'unresolved' || waitRef.current || payCoolRef.current) return;
    if (h.body === '' || paymentExpired(h, clock(), wall())) { payHolds.change(uid, h.key, { body: '', proof: null }); return; }
    if (!paySendable(h)) return detachPay();
    setPaying(true);
    invalidateLookup(); // R3-4: before the await, so a lookup answering during the session check is never shown
    try {
      const since = sessionEndsSoFar();
      const csrf = await payConnect(() => alive.current && since === sessionEndsSoFar());
      if (csrf === null) return;
      if (csrf !== h.csrf) { adopt(csrf); detachPay(); return; }
      const now = payHolds.get(uid);
      if (now === undefined || now.key !== h.key || now.state !== 'unresolved' || now.body === '' || paymentExpired(now, clock(), wall()) || !paySendable(now)) return;
      invalidateLookup();
      payHolds.change(uid, h.key, { state: 'checking' });
      // R8: unstuck only by the press that set 'checking' — one that returned earlier never touches another mount's send.
      try { await runStage(h.key, false); } finally { unstick(h.key); }
    } finally {
      setPaying(false);
    }
  }

  /** The deliberate "Confirm payment" of the held recorded attempt (G5): settle v2 under a NEW key, held before it leaves. */
  async function confirmPayment(): Promise<void> {
    const h = payHolds.get(uid);
    // Its own guard (R1 S12): a recorded attempt's chain is over, so a page-one re-read or the press's tail never swallows it.
    if (confirming.current || waitRef.current || h === undefined || h.state !== 'recorded' || h.csrf === null) return;
    if (!paySendable(h)) return detachPay();
    setConfirming(true);
    invalidateLookup(); // R3-4: before the await
    try {
      const since = sessionEndsSoFar();
      const csrf = await payConnect(() => alive.current && since === sessionEndsSoFar());
      if (csrf === null) return;
      if (csrf !== h.csrf) { adopt(csrf); detachPay(); return; }
      const body = settleBodyOf(h.tenantId, h.key, 2);
      const now = payHolds.get(uid);
      if (body === null || now === undefined || now.key !== h.key || now.state !== 'recorded') return;
      invalidateLookup();
      payHolds.change(uid, h.key, { stage: 'settle', stageKey: nextKey(), body, settleVersion: 2, sentAt: clock(), sentWall: wall(), state: 'sending', say: '' });
      try { await runStage(h.key, true); } finally { unstick(h.key); }
    } finally {
      setConfirming(false);
    }
  }

  /**
   * A lookup row's deliberate action (spec §6): withdraw (v1) an open attempt or confirm (v2) a recorded one, under a NEW
   * key, held before it leaves. It acts only for the row captured at the press (R7): it replaces a decided hold or this
   * row's own attempt, never another undecided one (rowHeldBack holds the row back instead).
   */
  async function settleRow(row: PaymentAttempt, version: 1 | 2): Promise<void> {
    const l = lookupRef.current;
    // R8 (fix2 item 3): no attempt on an invoice is settled while a reversal of one of its payments is unresolved.
    const reversingHere = (storeId: string): boolean => { const r = revHolds.get(uid); return (isLiveReversal(r) && r.storeId === storeId && r.invoiceId === row.invoiceId) || withdrawingHere(storeId, row.invoiceId); };
    if (paying.current || waitRef.current || l === null || l.invoiceId !== row.invoiceId || storeRef.current !== l.storeId || reversingHere(l.storeId)) return;
    const store = storesRef.current.stores.find((entry) => entry.id === l.storeId);
    if (store === undefined) return;
    const cur = payHolds.get(uid);
    if (cur !== undefined && (cur.state === 'sending' || cur.state === 'checking')) return;
    if (rowHeldBack(cur, row) || isPaymentHeldElsewhere(cur, l.storeId, row.invoiceId)) return; // R1 S3/S4, G3: another undecided attempt is never dropped; a sendable settle only by Check again
    setPaying(true);
    // R3-4: a lookup answer still out is dropped before the await; the rows shown stay (R2 R5).
    lookupSeq.current += 1;
    lookupCtl.current?.abort();
    try {
      const mine = gen.current.n;
      const since = sessionEndsSoFar();
      const stands = (): boolean => alive.current && mine === gen.current.n && since === sessionEndsSoFar() && storeRef.current === store.id;
      const csrf = await payConnect(stands);
      if (csrf === null || adopt(csrf) || !stands()) return;
      const body = settleBodyOf(store.tenantId, row.attemptId, version);
      if (body === null) return;
      const was = payHolds.get(uid);
      if (rowHeldBack(was, row) || isPaymentHeldElsewhere(was, store.id, row.invoiceId) || reversingHere(store.id)) return;
      const own = was?.key === row.attemptId ? was : undefined; // R7: only this row's own attempt lends it anything
      if (was !== undefined) payHolds.remove(uid, was.key); // decided, or this row's own attempt: every other undecided one returned above
      const held: HeldPayment = {
        key: row.attemptId, storeId: store.id, tenantId: store.tenantId, invoiceId: row.invoiceId, number: row.invoiceNumber, csrf, stage: 'settle', stageKey: nextKey(), body,
        sentAt: clock(), sentWall: wall(), lastSentAt: clock(), registrationId: null, proof: null, amountCents: row.payment?.amountCents ?? own?.amountCents ?? 0,
        method: row.payment?.method ?? null, payment: row.payment === null ? null : { id: row.payment.id, amountCents: row.payment.amountCents, method: row.payment.method },
        settleVersion: version, state: 'sending', say: '', retryAfter: 0, rereads: own?.rereads ?? 0,
      };
      if (!payHolds.put(uid, held)) return;
      // The lookup's rows stay shown; only an answer still out is dropped (R2 R5).
      lookupSeq.current += 1;
      lookupCtl.current?.abort();
      try { await runStage(row.attemptId, true); } finally { unstick(row.attemptId); }
    } finally {
      setPaying(false);
    }
  }

  /**
   * "Find this payment attempt" (spec §6, G2): this user's attempts at the store, paged from the start to the end (at most
   * LOOKUP_PAGE_CAP pages), kept for THIS invoice in state open or recorded. A withdrawn or confirmed row for the held
   * attempt decides it at any time; its absence from a COMPLETE read decides only an attempt that never sent a record, or
   * one whose payment is known (confirmed) (R7), and a register-stage one only once its last send is REGISTER_QUIET_MS before the read started (R4): that
   * register may still be committing, so the hold stays undecided and the lookup fails with Try again. Only for the open
   * dialog's invoice; a later lookup or a close drops it.
   */
  async function runLookup(storeId: string, invoiceId: string): Promise<void> {
    const startedAt = clock(); // before the session check: an earlier start only widens the quiet window (R4)
    const v = viewRef.current;
    if (v === null || v.storeId !== storeId || v.invoiceId !== invoiceId || storeRef.current !== storeId) return;
    const n = ++lookupSeq.current;
    lookupCtl.current?.abort();
    const controller = new AbortController();
    lookupCtl.current = controller;
    const base = { storeId, invoiceId, rows: [] as readonly PaymentAttempt[] };
    putLookup({ ...base, phase: 'loading', text: RECORD_TEXT.lookingUp });
    const mine = gen.current.n;
    const since = sessionEndsSoFar();
    const stale = (): boolean => !alive.current || controller.signal.aborted || n !== lookupSeq.current || mine !== gen.current.n || storeRef.current !== storeId
      || since !== sessionEndsSoFar() || viewRef.current?.storeId !== storeId || viewRef.current.invoiceId !== invoiceId;
    const failed = (text = ''): void => { if (!stale()) putLookup({ ...base, phase: 'failed', text: text === '' ? RECORD_TEXT.failed : `${RECORD_TEXT.failed} ${text}` }); };
    // An answer a stale guard drops (another generation while this dialog stays, R1 S9) never leaves "Checking…" for good:
    // the latest lookup of this still-open invoice says it could not be loaded, with Try again.
    const dropped = (): void => {
      if (alive.current && n === lookupSeq.current && lookupRef.current?.phase === 'loading' && viewRef.current?.storeId === storeId && viewRef.current.invoiceId === invoiceId) {
        putLookup({ ...base, phase: 'failed', text: RECORD_TEXT.failed });
      }
    };
    if (waitRef.current) return failed(pickerWaitText(waitLeft()));
    const csrf = await payConnect(() => !stale());
    if (csrf === null) { failed(waitRef.current ? pickerWaitText(waitLeft()) : ''); return dropped(); }
    if (adopt(csrf) || stale()) return dropped();
    const rows: PaymentAttempt[] = [];
    let after: string | null = null;
    let capped = false;
    // shortcut: 20-page cap (1,000 rows), upgrade with a server per-invoice filter
    for (let page = 0; ; page += 1) {
      if (page === LOOKUP_PAGE_CAP) { capped = true; break; }
      const answer = await issuing.paymentAttempts(storeId, after, csrf, controller.signal);
      if (stale()) return dropped();
      if (answer.kind !== 'ok') {
        if (answer.kind === 'signed-out') { failSession({ kind: 'signed-out', text: ISSUED_TEXT.ended }); return; }
        return failed(answer.kind === 'rate-limited' ? pickerWaitText(startWait(answer.retryAfterSeconds)) : '');
      }
      for (const a of answer.attempts) if (a.invoiceId === invoiceId) rows.push(a);
      if (answer.nextCursor === null) break;
      after = answer.nextCursor;
    }
    const h = payHolds.get(uid);
    let notListed = false;
    if (h !== undefined && h.state !== 'done' && h.storeId === storeId && h.invoiceId === invoiceId) {
      const row = rows.find((r) => r.attemptId === h.key);
      if (row?.state === 'withdrawn') payHolds.change(uid, h.key, { state: 'done', say: 'withdrawn', body: '', proof: null });
      if (row?.state === 'confirmed') payHolds.change(uid, h.key, { state: 'done', say: 'confirmed', body: '', proof: null, rereads: h.rereads + 1 });
      // R3 L-M1: a COMPLETE read lists every unsettled registration of this caller at the store whatever its age (037), so no
      // row of it means it never registered or was settled over 24 h ago. A capped, failed or dropped read (returned above)
      // never decides it. R7: that absence decides only an attempt that never sent a record (stage register or proof) — a
      // record needs its registration id and this session's proof (037 :1109-1128), so no payment came of it. Once a record
      // may have been sent, a registration settled over 24 h ago is unlisted whether withdrawn or confirmed (037 :1328): unless
      // its payment is known, the hold stays as it is and the lookup says so. R4 (R3-1): nor does a read started within REGISTER_QUIET_MS of
      // a register-stage attempt's last send decide it — that register may still be committing.
      if (row === undefined && !capped && h.state !== 'sending' && h.state !== 'checking') {
        if (h.stage === 'record' || h.stage === 'settle') {
          // A payment known before it went unlisted was confirmed: v1 refuses a registration with a payment and settled is
          // final (037 :1435-1446, :298-325). Otherwise withdrawn and confirmed both look like this: nothing decided.
          if (h.payment !== null) payHolds.change(uid, h.key, { state: 'done', say: 'confirmed', body: '', proof: null, rereads: h.rereads + 1 });
          else notListed = true;
        } else if (h.stage === 'register' && startedAt - h.lastSentAt < REGISTER_QUIET_MS) return putLookup({ ...base, phase: 'failed', text: RECORD_TEXT.stillRegistering });
        else payHolds.change(uid, h.key, { state: 'done', say: '', body: '', proof: null, rereads: h.rereads + 1 });
      }
    }
    const unsettled = rows.filter((r) => r.state === 'open' || r.state === 'recorded');
    const text = capped ? RECORD_TEXT.cap : notListed ? RECORD_TEXT.notListed : unsettled.length === 0 ? RECORD_TEXT.none : '';
    putLookup({ ...base, rows: unsettled, phase: capped ? 'cap' : 'ready', text });
  }

  /** The dialog's recording eligibility (spec §1): 'allowed' only for the exact allowed; a 403 is 'not' and never retried. */
  async function readPaymentEligibility(viewId: number, storeId: string, invoiceId: string, signal: AbortSignal): Promise<'allowed' | 'not' | null> {
    if (waitRef.current) return 'not';
    const mine = gen.current.n;
    const since = sessionEndsSoFar();
    const stale = (): boolean => !alive.current || signal.aborted || mine !== gen.current.n || storeId !== storeRef.current || since !== sessionEndsSoFar()
      || viewRef.current?.id !== viewId || viewRef.current.storeId !== storeId || viewRef.current.invoiceId !== invoiceId;
    const csrf = await payConnect(() => !stale());
    if (csrf === null) return stale() ? null : 'not';
    if (adopt(csrf)) return null;
    const answer = await issuing.paymentEligibility(storeId, invoiceId, csrf, signal);
    if (stale()) return null;
    if (answer.kind === 'allowed') return 'allowed';
    if (answer.kind === 'signed-out') { failSession({ kind: 'signed-out', text: ISSUED_TEXT.ended }); return null; }
    if (answer.kind === 'rate-limited') startWait(answer.retryAfterSeconds);
    return 'not';
  }

  // ---- credit notes: the invoice's list and the attempts lookup (M7B-CREDITNOTES-CN-P2, doc 17 §2.2, §3.3, §3.6, §4.1) ----

  const putCredit = (next: CreditSlice | null): void => { creditRef.current = next; setCreditState(next); };
  /** Change the slice `id` names while it is still the one held (a dropped or replaced slice's continuation changes nothing). */
  function patchCredit(id: number, next: Partial<Pick<CreditSlice, 'list' | 'lookup'>>): void {
    const s = creditRef.current;
    if (s !== null && s.id === id) putCredit({ ...s, ...next });
  }
  /** Whether a slice still belongs to the generation AND the token this section holds now (rule 2). */
  const creditCurrent = (s: CreditSlice): boolean => s.n === gen.current.n && s.csrf === gen.current.csrf;
  /** Every credit-note row, name, cursor and lookup row goes now, and every read out for them is stale (rule 3). */
  function dropCredit(): void {
    creditCtl.current.list?.abort();
    creditCtl.current.lookup?.abort();
    creditSeq.current = { list: creditSeq.current.list + 1, lookup: creditSeq.current.lookup + 1 };
    if (creditRef.current !== null) putCredit(null);
  }
  /**
   * The held slice when it is this invoice's under this generation and token, else a new empty one (the old one dropped) —
   * or null while another invoice's dialog is open: a late refresh for a card never takes that dialog's list away.
   */
  function creditSliceFor(storeId: string, invoiceId: string): CreditSlice | null {
    const s = creditRef.current;
    if (s !== null && s.storeId === storeId && s.invoiceId === invoiceId && creditCurrent(s)) return s;
    const v = viewRef.current;
    if (v !== null && (v.storeId !== storeId || v.invoiceId !== invoiceId)) return null;
    dropCredit();
    const next: CreditSlice = { id: ++creditIds.current, n: gen.current.n, csrf: gen.current.csrf, storeId, invoiceId, list: null, lookup: null };
    putCredit(next);
    return next;
  }
  /** A dialog's open (or a renewal that kept it): the list and the lookup from page one, in a new slice. */
  function startCredit(storeId: string, invoiceId: string): void {
    dropCredit();
    void readCreditList(storeId, invoiceId, 'first', null);
    void readCreditLookup(storeId, invoiceId, 'start');
  }

  /**
   * A credit-note read's 403: ONE fresh session check. 'denied' only when the token after it is the token the request
   * carried (rule 1; never the void's `denialOf(() => false)`); 'gone' when another token (adopted here: a new generation)
   * or a sign-out took over, or the asker went; else why it could not be checked.
   */
  function creditDenial(carried: string, stale: () => boolean): Promise<'denied' | 'gone' | Failure> {
    return cnChecking(carried, creditDenialRun(carried, stale));
  }
  async function creditDenialRun(carried: string, stale: () => boolean): Promise<'denied' | 'gone' | Failure> {
    const since = sessionEndsSoFar();
    const s = await connect('fresh');
    if (!alive.current || since !== sessionEndsSoFar()) return 'gone';
    if (s.kind !== 'ok') {
      const failure = sessionFailure(s);
      if (failure.kind === 'signed-out') { failSession(failure); return 'gone'; }
      if (failure.seconds !== undefined) startWait(failure.seconds);
      return failure;
    }
    adopt(s.csrf);
    if (s.csrf !== carried || stale()) return 'gone';
    cnDeniedAt.current = carried; // the token this denial was confirmed under (rule 4's bare keeps it, not a later one)
    cnDenials.current += 1;
    return 'denied';
  }
  /**
   * A 403's one fresh check, marked pending from the moment the 403 is seen (before its read): a chain about to send under
   * that token waits for it (§3.6 rule 4 — a denial observed before the send blocks the send, CX4-01).
   */
  function cnChecking<T>(token: string | null, check: Promise<T>): Promise<T> {
    const mark = { token, check: check.then(() => undefined, () => undefined) };
    cnPendingChecks.current.add(mark);
    void mark.check.then(() => { cnPendingChecks.current.delete(mark); });
    return check;
  }
  /**
   * A confirmed same-token denial in the section, or a list page that lost the owner's names ('view', rule 4): the lookup's
   * rows and actions go (the action is hidden); only a confirmed 403 keeps it from being asked again under this generation
   * and token at this store. A list holding or reading names reloads once from page one in the view the server gives now.
   */
  function creditDenied(source: 'list' | 'lookup' | 'other' | 'view', card = true, storeId?: string, token?: string | null): void {
    if (token !== undefined && token !== null) cnDeniedAt.current = token; // a shipped read's check (denialOf): confirmed under it
    const s = creditRef.current;
    // Every card of this store keeps its last state and loses its buttons and listed notes (rule 4).
    if (card) cnNoAccess(storeId ?? (s !== null && creditCurrent(s) ? s.storeId : storeRef.current));
    if (s === null || !creditCurrent(s) || (storeId !== undefined && s.storeId !== storeId)) return;
    if (source !== 'view') lookupDenied.current.add(`${s.n}:${s.csrf}:${s.storeId}`);
    creditCtl.current.lookup?.abort();
    creditSeq.current.lookup += 1;
    patchCredit(s.id, { lookup: LOOKUP_DENIED });
    const l = s.list;
    if (source === 'list' || source === 'view' || l === null) return;
    if (l.named === true || l.more) void readCreditList(s.storeId, s.invoiceId, 'first', null);
    // A first read still out is not sent again: its page is judged on arrival (names → dropped and read once more; none → kept).
    else if (l.phase === 'loading') creditViewLost.current = creditSeq.current.list;
  }

  /**
   * The invoice's credit notes (doc 17 §4.1) on the readList skeleton (rule 1): a session check first, then pages under the
   * slice's generation and token, this kind's own sequence and abort; an answer applies only while all of them, the store
   * and the sign-out count stand. 'first' starts a chain at page one (following `target`, else the chain's own target);
   * 'next' continues the shown chain from its cursor (Show more, or Try again after a transient failure). With a target
   * the chain follows nextCursor on its own until that note loads, at most LOOKUP_PAGE_CAP pages a batch. Every page keeps
   * the chain's view (names present or absent): a change drops every row and reloads from page one once; a page out of
   * order, a second change or cursor 400, a refusal or a malformed page fails closed (no rows).
   */
  async function readCreditList(storeId: string, invoiceId: string, mode: 'first' | 'next', target: string | null, whole = false): Promise<void> {
    const slice = mode === 'first' ? creditSliceFor(storeId, invoiceId) : creditRef.current;
    if (slice === null || slice.storeId !== storeId || slice.invoiceId !== invoiceId || !creditCurrent(slice)) return;
    const was = slice.list;
    if (mode === 'next' && (was === null || was.next === null || was.more || (was.phase !== 'ready' && was.phase !== 'failed'))) return;
    const n = ++creditSeq.current.list;
    creditCtl.current.list?.abort();
    const controller = new AbortController();
    creditCtl.current.list = controller;
    const since = sessionEndsSoFar();
    const stale = (): boolean => !alive.current || controller.signal.aborted || n !== creditSeq.current.list || creditRef.current?.id !== slice.id
      || !creditCurrent(slice) || since !== sessionEndsSoFar() || storeRef.current !== storeId;
    const base: CreditNotesList = mode === 'next' && was !== null ? { ...was, more: true, said: '' } : { ...CREDIT_LIST_START, target: target ?? was?.target ?? null };
    patchCredit(slice.id, { list: base });
    let notes = base.notes;
    let named = base.named;
    // A chain from page one still knows the slice's last view (one slice: one generation and token): named → unnamed across a
    // refresh is rule 4's access loss; the page itself is already in the new view, so nothing is read again for it.
    let lastView = mode === 'first' ? was?.named ?? null : null;
    // The slice's view outlives a chain that ends without one (an empty page, a failure): the next refresh still compares.
    const keptView = mode === 'first' ? was?.named ?? null : base.named;
    let cursor = base.next;
    let { reloaded, restarted } = base;
    let fresh = mode === 'first'; // a chain started again here says no "{n} more loaded."
    const done = (phase: CreditNotesList['phase'], keep: boolean, complete = false): void => {
      if (stale()) return;
      patchCredit(slice.id, {
        list: keep
          ? { ...base, phase, notes, named: named ?? keptView, next: cursor, complete, more: false, reloaded, restarted, said: !fresh && phase === 'ready' ? CREDIT_TEXT.moreLoaded(notes.length - base.notes.length) : '' }
          : { ...base, phase, notes: [], named: phase === 'denied' ? null : keptView, next: null, complete: false, more: false, reloaded, restarted, said: '' },
      });
    };
    if (waitRef.current) return done('failed', true);
    for (let page = 0; ; page += 1) {
      // Every send re-reads the session first (doc 17 §3.6 rule 1): page one, each page the chain follows on its own (a
      // target, the D-P2-15 `whole` reads), and the first send after a view-change, rule-4 or cursor-400 restart. Another
      // token is adopted as a new generation, which drops this slice's notes, names and cursor.
      const s = await connect();
      if (stale()) return;
      if (s.kind !== 'ok') {
        const failure = sessionFailure(s);
        if (failure.kind === 'signed-out') return failSession(failure);
        if (failure.seconds !== undefined) startWait(failure.seconds);
        return done('failed', true);
      }
      if (adopt(s.csrf) || stale()) return; // another token: a new generation dropped this slice
      const answer = await issuing.listCreditNotes(storeId, invoiceId, cursor, s.csrf, controller.signal);
      if (stale()) return;
      if (answer.kind === 'ok') {
        const got = answer.page;
        if (creditViewLost.current === n && got.named !== null) {
          creditViewLost.current = 0;
          if (got.named) { // read before the confirmed denial with the owner's names: the list reloads once in the new view (rule 4)
            if (reloaded) return done('failed', false);
            reloaded = true;
            fresh = true;
            notes = [];
            named = null;
            cursor = null;
            page = -1;
            continue;
          }
        }
        if (lastView !== null && got.named !== null) {
          if (lastView && !got.named) creditDenied('view');
          lastView = null;
        }
        const follows = creditNotesFollow(named, notes, got);
        if (follows === 'view-changed') {
          if (named === true && got.named === false) creditDenied('view'); // the owner's names are gone: so are the lookup's rows
          if (reloaded) return done('failed', false);
          reloaded = true;
          fresh = true;
          notes = [];
          named = null;
          cursor = null;
          page = -1;
          continue;
        }
        if (follows === 'broken') return done('failed', false);
        notes = [...notes, ...got.creditNotes];
        named = got.named ?? named;
        cursor = got.nextCursor;
        if (cursor === null) return done('ready', true, true);
        // `whole`: the D-P2-15 reads (the baseline, a continuation's current set) follow to nextCursor null, at most a batch.
        if ((whole || (base.target !== null && !notes.some((note) => note.id === base.target))) && page + 1 < LOOKUP_PAGE_CAP) continue;
        return done('ready', true);
      }
      if (answer.kind === 'bad-cursor' && !restarted) {
        restarted = true;
        fresh = true;
        notes = [];
        named = null;
        cursor = null;
        page = -1;
        continue;
      }
      if (answer.kind === 'signed-out') return failSession({ kind: 'signed-out', text: ISSUED_TEXT.ended });
      if (answer.kind === 'denied') {
        const verdict = await creditDenial(s.csrf, stale);
        if (verdict === 'gone' || stale()) return;
        if (verdict !== 'denied') return done('failed', true);
        creditDenied('list');
        return done('denied', false);
      }
      if (answer.kind === 'rate-limited') { startWait(answer.retryAfterSeconds); return done('failed', true); }
      return done('failed', answer.kind === 'unavailable'); // not found, malformed, a second cursor 400: nothing kept
    }
  }

  /**
   * This owner's attempts at the store (doc 17 §2.2, §3.3), kept for this invoice: the issue action's gate (D-P2-3) once
   * read to exhaustion as observed — not evidence that none exists. The readList skeleton under one scan generation, in
   * batches of LOOKUP_PAGE_CAP pages: 'start' begins a lookup generation at page one; 'continue' resumes an incomplete one
   * from its last good cursor (a context change in between made a new slice: page one). A 403 the one check confirms hides
   * it for this generation and token; a malformed page or one that does not advance fails (Try again); the cap, a 429, a
   * 503 or no answer stops it incomplete with its rows (Continue checking); one cursor-400 restart per lookup generation.
   */
  async function readCreditLookup(storeId: string, invoiceId: string, mode: 'start' | 'continue'): Promise<void> {
    const slice = creditSliceFor(storeId, invoiceId);
    if (slice === null) return;
    const was = slice.lookup;
    if (mode === 'continue' && was !== null && was.phase !== 'incomplete') return;
    if (lookupDenied.current.has(`${slice.n}:${slice.csrf}:${storeId}`)) return patchCredit(slice.id, { lookup: LOOKUP_DENIED }); // never asked again here
    const resume = mode === 'continue' && was !== null;
    const n = ++creditSeq.current.lookup;
    creditCtl.current.lookup?.abort();
    const controller = new AbortController();
    creditCtl.current.lookup = controller;
    const since = sessionEndsSoFar();
    const stale = (): boolean => !alive.current || controller.signal.aborted || n !== creditSeq.current.lookup || creditRef.current?.id !== slice.id
      || !creditCurrent(slice) || since !== sessionEndsSoFar() || storeRef.current !== storeId;
    let rows = resume ? was.rows : [];
    let cursor = resume ? was.cursor : null;
    let seen = resume ? was.seen : [];
    let restarted = resume ? was.restarted : false;
    let owner = was?.owner === true;
    const put = (phase: CreditNotesLookup['phase']): void => {
      if (!stale()) patchCredit(slice.id, { lookup: phase === 'failed' ? { ...LOOKUP_FAILED, owner } : { phase, rows, cursor, seen, restarted, owner } });
    };
    put('loading');
    if (waitRef.current) return put('incomplete');
    for (let page = 0; ; page += 1) {
      if (page === LOOKUP_PAGE_CAP) return put('incomplete');
      // Every send re-reads the session first (doc 17 §3.6 rule 1): page one, each later page, and the first send after a
      // cursor-400 restart. Another token is adopted as a new generation, which drops this slice's rows and cursor.
      const s = await connect();
      if (stale()) return;
      if (s.kind !== 'ok') {
        const failure = sessionFailure(s);
        if (failure.kind === 'signed-out') return failSession(failure);
        if (failure.seconds !== undefined) startWait(failure.seconds);
        return put('incomplete');
      }
      if (adopt(s.csrf) || stale()) return; // another token: a new generation dropped this slice
      const answer = await issuing.creditNoteAttempts(storeId, cursor, s.csrf, controller.signal);
      if (stale()) return;
      if (answer.kind === 'ok') {
        if (!creditNoteAttemptsFollow(seen, answer.attempts)) return put('failed'); // out of order, or a row this scan already has
        const checkedAt = wall();
        rows = [...rows, ...answer.attempts.filter((a) => a.invoiceId === invoiceId).map((a) => Object.freeze({ ...a, checkedAt }))];
        seen = [...seen, ...answer.attempts];
        cursor = answer.nextCursor;
        owner = true;
        if (cursor === null) return put('exhausted');
        continue;
      }
      if (answer.kind === 'bad-cursor' && !restarted) {
        restarted = true;
        rows = [];
        cursor = null;
        seen = [];
        page = -1;
        continue;
      }
      if (answer.kind === 'signed-out') return failSession({ kind: 'signed-out', text: ISSUED_TEXT.ended });
      if (answer.kind === 'denied') {
        const verdict = await creditDenial(s.csrf, stale);
        if (verdict === 'gone' || stale()) return;
        return verdict === 'denied' ? creditDenied('lookup') : put('incomplete');
      }
      if (answer.kind === 'rate-limited') { startWait(answer.retryAfterSeconds); return put('incomplete'); }
      return put(answer.kind === 'unavailable' ? 'incomplete' : 'failed'); // malformed, a second cursor 400
    }
  }

  // ---- issuing a credit note (M7B-CREDITNOTES-CN-P2, doc 17 §2.5-§2.6, §3.1, §3.3) ----

  /** The shop-observed sign-in under the token this section holds now, whatever its age; null: none under it. */
  const lastSignIn = (): CreditNoteSignIn | null => (signedAt.current !== null && signedAt.current.csrf === gen.current.csrf ? signedAt.current : null);
  /** The same while a first send may still use it (≤ 8 minutes, §2.5). */
  const freshSignIn = (): CreditNoteSignIn | null => {
    const s = lastSignIn();
    return s !== null && signInFresh(s, clock(), wall()) ? s : null;
  };
  /** Every sign-in this section saw finish (the dialog's, the settings'): when, under the token it gave. */
  function stampSignIn(csrf: string): void { signedAt.current = { mono: clock(), wall: wall(), csrf }; }
  const stageKey = (h: HeldCreditNote | undefined, stage: CreditNoteStage): string => (stage === 'proof' ? '' : h?.[stage]?.key ?? '');
  const shutIn = (h: HeldCreditNote | undefined, stage: CreditNoteStage): boolean =>
    h !== undefined && memoFor(h.attemptId).stages.some((x) => x.stage === stage && x.key === stageKey(h, stage));
  const shutHas = (a: string, stage: CreditNoteStage): boolean => { const h = cnHolds.get(uid); return h?.attemptId === a && shutIn(h, stage); };
  const shut = (a: string, stage: CreditNoteStage): void => {
    const key = stageKey(cnHolds.get(uid), stage);
    const m = memoFor(a);
    cnMemo.set(uid, { ...m, stages: [...m.stages, { stage, key }] });
  };
  /** A confirmed no-access line (rule 4) while the token it was confirmed under is still this section's. */
  // Before this mount has read a session (a remount, nothing pressed yet), the attached hold's own token stands for it: a
  // sign-out detaches the hold, so rule 4 still lifts on a known session change (§3.6).
  const bareNow = (s: CreditSay | null | undefined): boolean => s?.bare === true && s.bareAt !== null && s.bareAt === (gen.current.csrf ?? cnHolds.get(uid)?.csrf ?? null);
  /**
   * What the card says for `attemptId` and which buttons that line backs, announced once in the live pair (polite, or an
   * alert) — nothing for a hidden card (D-P2-6: the hold still judges its answers). A stage shut stays shut.
   */
  function say(attemptId: string, text: string, o: CreditSayOptions = {}): void {
    // Rule 4 sticks: a later answer (a late original, a stale stage) never gives a confirmed no-access card its buttons back.
    // One access-loss transition, one announcement: a second no-access line for the same attempt changes nothing.
    if (bareNow(memoFor(attemptId).bare)) return;
    const alert = o.alert ?? false;
    const next: CreditSay = {
      attemptId, text, alert, also: o.also ?? '', find: o.find ?? false, bare: o.bare ?? false, bareAt: o.bare === true ? cnDeniedAt.current ?? gen.current.csrf : null, kind: o.kind ?? null,
      check: o.check !== undefined && !shutHas(attemptId, o.check) ? o.check : null, cont: o.cont !== undefined && !shutHas(attemptId, 'proof') ? o.cont : null,
    };
    // The card's last line outlives this section (a page left and back keeps it; rule 4's with its token), said or not.
    cnMemo.set(uid, { ...memoFor(attemptId), last: next, ...(next.bare ? { bare: next } : {}) });
    if (!alive.current) return;
    cnSayRef.current = next;
    setCnSay(next);
    if (o.focusFind === true) setCnFocusFind((x) => x + 1);
    const h = cnHolds.get(uid);
    if (h?.attemptId === attemptId && h.hidden) return;
    // The second line is part of the transition (§2.6: noAccessShort, rateLimitedWait … are alert strings): one announcement.
    const words = next.also === '' ? text : `${text} ${next.also}`;
    setCnLive(alert || next.also !== '' ? { status: '', alert: words } : { status: words, alert: '' });
  }
  /** What the live pair says when no card line changes (a press that could not leave, a row that could not be held). */
  const sayAside = (text: string): void => { if (alive.current) setCnLive({ status: '', alert: text }); };
  /** A press that threw (never expected: the client does not reject) fails closed: internalError and "Look up attempt". */
  /**
   * A press that threw (never expected: the client does not reject) fails closed: internalError and "Look up attempt" — on the
   * attempt whose press it was (`a`, read when pressed), never on a newer one; with none (or another), the live pair only.
   */
  const cnThrew = (a: string | undefined) => (): void => {
    const h = cnHolds.get(uid);
    if (h === undefined || a === undefined || h.attemptId !== a) return sayAside(CREDIT_TEXT.internalError);
    if (isOpenCreditNote(h)) cnHolds.change(uid, h.attemptId, h.generation, { unresolved: true });
    say(h.attemptId, CREDIT_TEXT.internalError, { alert: true, find: true });
  };
  /** The attempt a press acts on, read at the press. */
  const pressed = (): string | undefined => cnHolds.get(uid)?.attemptId;
  /** A press whose session check failed (not a sign-out, no wait running): the shipped connect-failure text; the card keeps its line and buttons. */
  const cnUnavailable = (stands: () => boolean): void => { if (stands() && !waitRef.current) sayAside(ISSUED_TEXT.unavailable); };
  /** A line whose words follow what it offers (registeredOnly, unresolved, settleUnknown: §2.7), said with the words true now. */
  function sayOffer(attemptId: string, kind: NonNullable<CreditSay['kind']>, o: CreditSayOptions = {}): void {
    const h = cnHolds.get(uid);
    const can = h !== undefined && h.attemptId === attemptId && (kind === 'registeredOnly'
      ? o.cont === 'continue' && !shutHas(attemptId, 'proof') && continueLeaves(h, clock(), wall())
      : o.check !== undefined && !shutHas(attemptId, o.check) && checkLeaves(h, o.check, clock(), wall()));
    say(attemptId, CREDIT_TEXT[kind](can), { ...o, kind });
  }
  /** Busy has an owner (the list's `busyBy` pattern): only the latest press to take it gives it back. */
  const takeCnBusy = (): number => { cnSending.current = true; if (alive.current) setCnBusyState(true); return ++cnBusyBy.current; };
  const giveCnBusy = (me: number): void => { if (cnBusyBy.current !== me) return; cnSending.current = false; if (alive.current) setCnBusyState(false); };
  const rereadAmounts = (): void => setCnRereads((x) => x + 1);
  /** Mark the attempt unresolved: from here no success runs on into the next stage (§2.6 item 3). */
  const unsure = (a: string, g: number): void => { cnHolds.change(uid, a, g, { unresolved: true }); };

  /**
   * One stage's send through the hold (its last gate and record), its answer judged there (attribution and class, §2.6
   * item 4, §3.6), and the 30 s presentation boundary meanwhile (`late`): the request itself is never aborted.
   */
  async function cnSend<R extends CreditNoteCommandResult | CreditNoteProofResult>(
    a: string, g: number, stage: CreditNoteStage, csrf: string, call: (t: CreditNoteTicket) => Promise<R>, late: () => void, replay = false,
  ): Promise<{ readonly d: CreditNoteDecision; readonly r: R; readonly inTime: boolean } | null> {
    const t = cnHolds.send(uid, a, g, stage, { replay, csrf, sessionEnds: sessionEndsSoFar() });
    if (t === null) return null;
    let inTime = true;
    const pass = (): void => { inTime = false; if (alive.current) late(); };
    const timer = setTimeout(() => { cnTimers.current.delete(timer); pass(); }, CREDIT_NOTE_STAGE_WAIT_MS);
    cnTimers.current.add(timer);
    let r: R;
    try {
      r = await call(t);
    } finally {
      clearTimeout(timer); // a throw too: its press fails closed once, and nothing is said at 30 s
      cnTimers.current.delete(timer);
    }
    // An answer processed past the boundary before its timer ran is late too (the boundary is a time, not a callback).
    if (inTime && clock() - t.mono >= CREDIT_NOTE_STAGE_WAIT_MS) pass();
    // The hold outlives this section (a page left in the app): unmounted, the token is the hold's own — a sign-out still moves
    // `sessionEndsSoFar`, and the next mount detaches on another token (§3.6 (c); the void settles BY KEY likewise).
    const current = alive.current ? gen.current.csrf : cnHolds.get(uid)?.csrf ?? null;
    return { d: cnHolds.decide(uid, t, { csrf: current, sessionEnds: sessionEndsSoFar() }, r), r, inTime };
  }
  /**
   * A command's or the proof's 403 forbidden, apart from what it did to the attempt (§3.6): ONE fresh check comparing tokens
   * (rule 1) — 'denied' (the same token: a confirmed denial, rule 4), 'gone' (another token or a sign-out: detached),
   * 'unchecked' (the check could not answer); 'ok' for any other answer.
   */
  async function cnDenial(r: CreditNoteCommandResult | CreditNoteProofResult, csrf: string, a: string): Promise<'ok' | 'denied' | 'gone' | 'unchecked'> {
    if (r.kind !== 'refused' || r.status !== 403 || r.error === 'step_up_required') return 'ok';
    const verdict = await creditDenial(csrf, () => false);
    // Rule 1: the same token AND the hold still attached; the denial counts at the refused request's store only.
    const h = cnHolds.get(uid);
    if (verdict !== 'denied') return verdict === 'gone' ? 'gone' : 'unchecked';
    if (h === undefined || h.attemptId !== a || h.csrf !== csrf) return 'gone';
    creditDenied('other', false, h.storeId); // the answer's own applier says it on the card
    return 'denied';
  }
  /** A 401 signs the section out once its answer is applied (the hold detaches; T:1474 precedent) — only under the token it went with. */
  const cnSignedOut = (r: CreditNoteCommandResult | CreditNoteProofResult, csrf: string): void => {
    if (r.kind === 'refused' && r.status === 401 && gen.current.csrf === csrf) failSession({ kind: 'signed-out', text: ISSUED_TEXT.ended });
  };
  /** The invoice's state now, for an issue's sealed invalid_state (§3.1): its own read under `csrf`; null when it does not answer. */
  async function cnInvoiceStatus(storeId: string, invoiceId: string, csrf: string): Promise<'issued' | 'voided' | null> {
    const answer = await issuing.getIssued(storeId, invoiceId, csrf, new AbortController().signal);
    return answer.kind === 'ok' ? answer.invoice.status : null;
  }

  /**
   * "Issue credit note" in the confirmation (§2.5-§2.6): only with a shop-observed sign-in ≤ 8 minutes old under this token
   * (else the sign-in group, nothing sent); the session read again; the register's key and exact bytes held — with the
   * sign-in and the D-P2-15 baseline (the list as read so far, frozen here) — BEFORE it leaves; then the chain of this
   * press. Resolves once the confirmation should close (the chain ended, or a stage passed its 30 s boundary).
   */
  async function issueCredit(viewId: number, store: StoreEntry, press: CreditPress): Promise<CreditIssueOutcome> {
    if (cnSending.current) return { kind: 'not-sent', text: SETTINGS_TEXT.busy };
    if (waitRef.current) return { kind: 'not-sent', text: pickerWaitText(waitLeft()) };
    if (freshSignIn() === null) return { kind: 'sign-in', expired: lastSignIn() };
    const me = takeCnBusy();
    const mine = ++cnPress.current;
    let attemptHeld: string | undefined; // the attempt this press held, once it has
    try {
      const n = gen.current.n;
      const since = sessionEndsSoFar();
      const stands = (): boolean => alive.current && n === gen.current.n && since === sessionEndsSoFar() && storeRef.current === store.id && viewRef.current?.id === viewId;
      const csrf = await payConnect(stands);
      if (csrf === null) return stands() ? { kind: 'not-sent', text: waitRef.current ? pickerWaitText(waitLeft()) : ISSUED_TEXT.unavailable } : { kind: 'stale' };
      if (adopt(csrf) || !stands()) return { kind: 'stale' };
      const signIn = freshSignIn();
      if (signIn === null) return { kind: 'sign-in', expired: lastSignIn() };
      const attemptId = nextKey();
      const key = nextKey();
      const body = creditNoteRegisterBodyOf(store.tenantId, attemptId, press.grossCents, press.reason);
      if (body === null) return { kind: 'not-sent', text: CREDIT_TEXT.notAccepted };
      const s = creditRef.current;
      const list = s !== null && s.storeId === store.id && s.invoiceId === press.invoiceId && creditCurrent(s) ? s.list : null;
      const baseline = { ids: list?.notes.map((x) => x.id) ?? [], complete: list?.phase === 'ready' && list.complete };
      const was = cnHolds.get(uid);
      if (was !== undefined && cnEnded(was)) cnHolds.remove(uid, was.attemptId); // an ended one only: put refuses an open one
      const put = cnHolds.put(uid, {
        start: 'register', attemptId, storeId: store.id, tenantId: store.tenantId, invoiceId: press.invoiceId, invoiceNumber: press.number,
        grossCents: press.grossCents, reason: press.reason, csrf, key, body, signIn, baseline,
      });
      if (put.kind === 'lapsed') return { kind: 'sign-in', expired: signIn };
      if (put.kind !== 'held') return { kind: 'not-sent', text: put.kind === 'busy' ? CREDIT_TEXT.unfinished : CREDIT_TEXT.notAccepted };
      attemptHeld = attemptId;
      say(attemptId, CREDIT_TEXT.sending); // once for the whole chain
      return await new Promise<CreditIssueOutcome>((answer) => {
        const shown = (): void => answer({ kind: 'shown' });
        void runCredit(put.held, csrf, mine, shown).catch(cnThrew(put.held.attemptId)).finally(shown);
      });
    } catch {
      cnThrew(attemptHeld)(); // never expected before the chain either: fail closed and close the confirmation (never left on sending)
      return { kind: 'shown' };
    } finally {
      giveCnBusy(me);
    }
  }

  /**
   * One press's first-send chain (§2.6 item 3): register 201 → proof 200 → the ONE issue key claimed and held with its
   * exact bytes → the issue. A stage's success runs on only while this press is still the latest credit-note press, before
   * that stage's 30 s boundary, and while the attempt was never unresolved; and the issue only with the sign-in still
   * ≤ 8 minutes old. Any other accepted answer only records its state; a late one never starts a later stage.
   */
  async function runCredit(h0: HeldCreditNote, csrf: string, press: number, shown: () => void): Promise<void> {
    const a = h0.attemptId;
    const g = h0.generation;
    const onwards = (inTime: boolean): boolean => {
      const h = cnHolds.get(uid);
      return inTime && alive.current && cnPress.current === press && h !== undefined && h.attemptId === a && h.generation === g && h.csrf === csrf && !h.unresolved;
    };
    const reg = await cnSend(a, g, 'register', csrf, (t) => issuing.registerCreditNote(h0.storeId, h0.invoiceId, t.key, t.body, csrf),
      () => { unsure(a, g); say(a, CREDIT_TEXT.regUnknown, { alert: true, find: true, check: 'register' }); shown(); });
    if (reg === null) return say(a, CREDIT_TEXT.internalError, { alert: true, find: true }); // the hold refused the send: nothing left
    const go = await cnRegisterAnswer(h0, csrf, reg.d, reg.r, await cnDenial(reg.r, csrf, a));
    cnSignedOut(reg.r, csrf);
    if (!go) return;
    // Late, or another press since: recorded only — the card waits for "Continue issuing" (§2.6 item 3).
    if (!onwards(reg.inTime)) return sayOffer(a, 'registeredOnly', { find: true, cont: 'continue' });
    if (!(await cnSession(a, csrf, 'continue'))) return;
    if (!onwards(reg.inTime)) return sayOffer(a, 'registeredOnly', { find: true, cont: 'continue' });
    const proof = await cnSend(a, g, 'proof', csrf, (t) => issuing.creditNoteProof(h0.storeId, h0.invoiceId, t.body, a, csrf),
      () => { unsure(a, g); sayOffer(a, 'registeredOnly', { find: true, cont: 'continue', check: 'proof' }); shown(); });
    if (proof === null) return say(a, CREDIT_TEXT.internalError, { alert: true, find: true });
    if (proof.d !== 'open' || proof.r.kind !== 'proof') {
      cnProofAnswer(a, proof.d, proof.r, await cnDenial(proof.r, csrf, a));
      return cnSignedOut(proof.r, csrf);
    }
    if (!onwards(proof.inTime)) return sayOffer(a, 'registeredOnly', { find: true, cont: 'continue' });
    if (!(await cnSession(a, csrf, 'continue'))) return;
    if (!onwards(proof.inTime)) return sayOffer(a, 'registeredOnly', { find: true, cont: 'continue' });
    const h = cnHolds.get(uid) as HeldCreditNote;
    // The 8-minute window again, just before the issue's first send (§2.6 item 3): a registration cannot use a new sign-in.
    const lapsed = (): void => { shut(a, 'proof'); say(a, CREDIT_TEXT.continueLapsed, { alert: true, also: CREDIT_TEXT.registeredOnly(false), find: true }); };
    if (!signInFresh(h.signIn, clock(), wall())) return lapsed();
    const body = creditNoteIssueBodyOf({ expectedTenant: h.tenantId, registrationId: h.registrationId as string, attemptId: a, grossCents: h.grossCents, reason: h.reason, registrationProof: proof.r.proof });
    const claim = body === null ? 'gone' : cnHolds.claimIssueKey(uid, a, g, nextKey(), body);
    if (claim === 'lapsed') return lapsed();
    if (claim !== 'claimed') return say(a, CREDIT_TEXT.internalError, { alert: true, find: true });
    const issue = await cnSend(a, g, 'issue', csrf, (t) => issuing.issueCreditNote(h.storeId, h.invoiceId, t.key, t.body, csrf),
      () => { unsure(a, g); sayOffer(a, 'unresolved', { alert: true, find: true, check: 'issue' }); shown(); });
    if (issue === null) return signInFresh(h.signIn, clock(), wall()) ? say(a, CREDIT_TEXT.internalError, { alert: true, find: true }) : lapsed();
    await cnIssueAnswer(h, csrf, issue.d, issue.r, await cnDenial(issue.r, csrf, a));
    cnSignedOut(issue.r, csrf);
  }

  /**
   * §3.6 rule 1: the session read again immediately before a chain's proof or issue send. True: the same token, send. Else
   * nothing more is sent — another token detached the hold (continueAfterSignIn), a sign-out began, or the read failed.
   */
  async function cnSession(a: string, csrf: string, cont: 'continue' | 'another'): Promise<boolean> {
    const n = gen.current.n;
    const since = sessionEndsSoFar();
    const denials = cnDenials.current;
    const stands = (): boolean => alive.current && n === gen.current.n && since === sessionEndsSoFar();
    const now = await payConnect(stands);
    if (now === null) {
      // Not read: the shipped connect-failure text. The first-send chain's card leaves "sending" for the registration's own
      // line (its press then); a continuation's card keeps the line it stated and what that line offers.
      if (stands() && cnSayRef.current?.attemptId === a && cnSayRef.current.text === CREDIT_TEXT.sending) sayOffer(a, 'registeredOnly', { find: true, cont });
      cnUnavailable(stands);
      return false;
    }
    if (adopt(now) || now !== csrf) {
      say(a, CREDIT_TEXT.continueAfterSignIn, { alert: true, also: CREDIT_TEXT.registeredOnly(false), find: true });
      return false;
    }
    // Every fresh check of a 403 seen under this token settles first; a denial it (or any check) confirmed stops the send.
    for (;;) {
      const out = [...cnPendingChecks.current].filter((x) => x.token === csrf || x.token === null);
      if (out.length === 0) break;
      await Promise.all(out.map((x) => x.check));
    }
    // Rule 4 (store-scoped, RF1-04): this card's own no-access line, or a same-token denial confirmed while this read was out.
    if (bareNow(memoFor(a).bare) || (cnDenials.current !== denials && cnDeniedAt.current === csrf)) {
      // The card waits for its no-access line from the refused read (this store); else it says what it has.
      if (!bareNow(memoFor(a).bare) && cnSayRef.current?.attemptId === a && cnSayRef.current.text === CREDIT_TEXT.sending) sayOffer(a, 'registeredOnly', { find: true, cont });
      return false;
    }
    return true;
  }

  /** A register answer (§3.1, first send): true when the attempt is registered by it and the chain may look further. */
  async function cnRegisterAnswer(h: HeldCreditNote, csrf: string, d: CreditNoteDecision, r: CreditNoteCommandResult, session: string): Promise<boolean> {
    const a = h.attemptId;
    const g = h.generation;
    const end = (text: string, alert = true): false => { cnHolds.change(uid, a, g, { state: 'ended' }); say(a, text, { alert }); return false; };
    if (d === 'stale' || d === 'same') { if (session === 'denied') cnNoAccess(); return false; } // its session handling still applies (§3.6)
    if (d === 'different') { unsure(a, g); say(a, CREDIT_TEXT.internalError, { alert: true, find: true }); return false; } // two stored answers differ (§2.6 item 4)
    if (d === 'first' && r.kind === 'registered') return cnHolds.change(uid, a, g, { state: 'registered', registrationId: r.registrationId });
    if (d === 'first' && r.kind === 'refused') {
      // Sealed: the slot rule (an unfinished attempt here: the lookup shows it), a voided invoice, an existing note.
      if (r.error === 'write_conflict') { end(CREDIT_TEXT.unfinished); void readCreditLookup(h.storeId, h.invoiceId, 'start'); return false; }
      if (r.error === 'invalid_state') {
        // A fresh attempt id cannot be a released one: voided, said only once the invoice's own read says so.
        const now = await cnInvoiceStatus(h.storeId, h.invoiceId, csrf);
        const still = cnHolds.get(uid);
        if (still?.attemptId !== a || still.generation !== g || still.csrf !== csrf) return false; // detached or replaced meanwhile: the lookup explains
        rereadAmounts();
        return end(now === 'voided' ? CREDIT_TEXT.voided : CREDIT_TEXT.invalidStateUnknown);
      }
      if (r.error === 'already_issued') { say(a, CREDIT_TEXT.alreadyIssued, { alert: true, find: true }); return false; }
      // A sealed word §3.1 does not list at the register: fail closed, the hold kept — never "nothing was issued".
      unsure(a, g);
      say(a, CREDIT_TEXT.internalError, { alert: true, find: true });
      return false;
    }
    if (d === 'unstored' && r.kind === 'refused') {
      // Decided before the key, no Check again sent: nothing ran (§2.6 item 4).
      if (r.status === 401) return end(CREDIT_TEXT.ended);
      if (r.status === 403 && r.error === 'step_up_required') { signedAt.current = null; return end(CREDIT_TEXT.signInNeeded); }
      if (r.status === 403 && session === 'denied') return end(CREDIT_TEXT.notAllowed);
      if (r.status === 403) { unsure(a, g); say(a, CREDIT_TEXT.regUnknown, { alert: true, find: true }); return false; }
      if (r.status === 429) { const s = r.retryAfterSeconds ?? DEFAULT_WAIT_SECONDS; startWait(s); return end(CREDIT_TEXT.rateLimited(s)); }
      return end(CREDIT_TEXT.notAccepted);
    }
    unsure(a, g);
    const unknown = (o: CreditSayOptions = {}): false => { say(a, CREDIT_TEXT.regUnknown, { alert: true, find: true, ...o }); return false; };
    if (d === 'fail-closed') { say(a, CREDIT_TEXT.internalError, { alert: true, find: true }); return false; } // nothing under a new key
    if (r.kind !== 'refused') return unknown({ check: 'register' }); // 503-like, no answer: Check again (window) or Look up
    if (r.status === 409 && !r.sealed && r.error === 'request_in_progress') { say(a, CREDIT_TEXT.inProgress, { find: true, check: 'register' }); return false; }
    // A Check again was sent under the key (§3.1's Check-again column): every answer here is regUnknown on evidence (b) —
    // replay unavailable (422, a step-up, a sign-out), a confirmed denial (no buttons), or a wait.
    if (r.status === 422 || r.status === 401 || (r.status === 403 && r.error === 'step_up_required')) { shut(a, 'register'); return unknown(); }
    if (r.status === 403 && session === 'denied') { say(a, CREDIT_TEXT.regUnknown, { alert: true, also: CREDIT_TEXT.noAccessShort, bare: true }); return false; }
    if (r.status === 403) return unknown(session === 'gone' ? {} : { check: 'register' });
    if (r.status === 429) return unknown({ also: CREDIT_TEXT.rateLimitedWait(r.retryAfterSeconds ?? DEFAULT_WAIT_SECONDS), check: 'register' });
    return unknown({ check: 'register' }); // 400, 404, an unsealed 409: the hold is kept
  }

  /** A proof answer that does not let the chain go on (§3.1): never a claim about an issue. */
  function cnProofAnswer(a: string, d: CreditNoteDecision, r: CreditNoteProofResult, session: string): void {
    const registered = (o: CreditSayOptions = {}): void => sayOffer(a, 'registeredOnly', { find: true, cont: 'continue', ...o });
    if (d === 'stale') return void (session === 'denied' && cnNoAccess());
    if (d === 'open') return registered(); // open now: it only makes Continue issuing available (E5 needs that press's own proof)
    if (d === 'neutral') { shut(a, 'proof'); return say(a, CREDIT_TEXT.cantContinue, { alert: true, find: true }); }
    if (d === 'fail-closed') return say(a, CREDIT_TEXT.internalError, { alert: true, find: true });
    if (r.kind === 'refused' && r.status === 403 && session === 'denied') return say(a, CREDIT_TEXT.registeredOnly(false), { also: CREDIT_TEXT.noAccessShort, bare: true });
    if (session === 'gone') return say(a, CREDIT_TEXT.continueAfterSignIn, { alert: true, also: CREDIT_TEXT.registeredOnly(false), find: true });
    if (r.kind === 'refused' && r.status === 401) return say(a, CREDIT_TEXT.registeredOnly(false), { find: true }); // the section signs out next: detached
    registered({ check: 'proof' }); // 503, no answer: Check again (a read), Continue issuing or Look up attempt
  }

  /** An issue answer (§3.1): a stored one in either column; the first send's others while no Check again was sent under its key. */
  async function cnIssueAnswer(h: HeldCreditNote, csrf: string, d: CreditNoteDecision, r: CreditNoteCommandResult, session: string): Promise<void> {
    const a = h.attemptId;
    const g = h.generation;
    const find = (text: string, also = ''): void => say(a, text, { alert: true, also, find: true });
    if (d === 'stale' || d === 'same') return void (session === 'denied' && cnNoAccess());
    if (d === 'different') { unsure(a, g); return find(CREDIT_TEXT.internalError); } // two stored answers that differ (§2.6 item 4)
    const known = cnHolds.get(uid);
    if (r.kind !== 'issued' && known?.attemptId === a && known.generation === g && (known.state === 'issued' || cnEnded(known))) {
      // Forward only (§3.6, P2-28 case 11): issued is already known (a lookup row) — a late refusal claims nothing; only a
      // confirmed same-token denial takes the buttons away.
      if (session === 'denied') say(a, CREDIT_TEXT.noAccess, { alert: true, bare: true });
      return;
    }
    if (d === 'first' && r.kind === 'issued') {
      if (!cnHolds.change(uid, a, g, { state: 'issued', creditNoteId: r.creditNoteId })) {
        // Forward only (§2.6 item 4): a settled attempt whose note this is stays settled; anything else does not fit.
        const k = cnHolds.get(uid);
        if (k?.attemptId === a && k.generation === g && k.state === 'confirmed' && k.creditNoteId === r.creditNoteId) return;
        unsure(a, g);
        return find(CREDIT_TEXT.internalError);
      }
      say(a, CREDIT_TEXT.issued(formatCents(h.grossCents), INVOICE_CREDIT_NOTE_REASONS[h.reason]));
      rereadAmounts();
      void readCreditList(h.storeId, h.invoiceId, 'first', r.creditNoteId); // followed until its row (its number) loads
      activityAfterOwnWrite(h.storeId); // doc 18 CA-44: this tab's own 201 re-reads a loaded activity view's page one
      return;
    }
    if (d === 'first' && r.kind === 'refused') {
      if (r.error === 'amount_exceeds_remaining') { rereadAmounts(); return find(CREDIT_TEXT.overRemaining); }
      if (r.error === 'already_issued') return find(CREDIT_TEXT.alreadyIssued);
      if (r.error === 'invalid_state') {
        // Two causes (M38:1289, :1303): the invoice says which — voided, else released; no answer: either.
        const now = await cnInvoiceStatus(h.storeId, h.invoiceId, csrf);
        const still = cnHolds.get(uid);
        if (still?.attemptId !== a || still.generation !== g || still.csrf !== csrf) return; // detached or replaced meanwhile: the lookup explains
        rereadAmounts();
        if (now === 'voided') return find(CREDIT_TEXT.voided);
        if (now === 'issued') { cnHolds.change(uid, a, g, { state: 'released' }); return say(a, CREDIT_TEXT.attemptReleased, { alert: true }); }
        return find(CREDIT_TEXT.invalidStateUnknown);
      }
      if (r.error === 'write_conflict') return find(CREDIT_TEXT.notAccepted);
      unsure(a, g); // a sealed word §3.1 does not list at the issue: fail closed — never "No credit note was issued"
      return find(CREDIT_TEXT.internalError);
    }
    if (d === 'unstored' && r.kind === 'refused') {
      if (r.status === 401) return say(a, CREDIT_TEXT.ended, { alert: true }); // decided before the key; detached: Look up after a sign-in
      // A first-send refusal that offers no Check again closes the stage (D-P2-10 A: Void and Reverse come back).
      if (r.status === 403 && r.error === 'step_up_required') { signedAt.current = null; shut(a, 'issue'); return find(CREDIT_TEXT.issueStale); }
      if (r.status === 403 && session === 'denied') return say(a, CREDIT_TEXT.notAllowed, { alert: true, also: CREDIT_TEXT.noAccessShort, bare: true });
      // A new token or a sign-out (§3.6 rule 1): decided before the key, the hold detached — as after a 401 (§3.1, line 383).
      // 'gone' with this section's token unchanged (it unmounted, or the hold went another way) keeps replayGone.
      if (r.status === 403 && session === 'gone') return alive.current && gen.current.csrf !== csrf ? say(a, CREDIT_TEXT.ended, { alert: true }) : find(CREDIT_TEXT.replayGone);
      if (r.status === 404) { shut(a, 'issue'); return find(CREDIT_TEXT.cantContinue); }
      // Nothing ran under the key (APP:871): after Retry-After, Check again sends the held issue as its first execution (§3.1).
      if (r.status === 429) return say(a, CREDIT_TEXT.rateLimitedWait(r.retryAfterSeconds ?? DEFAULT_WAIT_SECONDS), { alert: true, find: true, check: 'issue' });
      if (r.status !== 403) { shut(a, 'issue'); return find(CREDIT_TEXT.notAccepted); }
    }
    unsure(a, g);
    if (d === 'fail-closed') return find(CREDIT_TEXT.internalError);
    const unknown = (o: CreditSayOptions = {}): void => sayOffer(a, 'unresolved', { alert: true, find: true, ...o });
    if (r.kind !== 'refused') return unknown({ check: 'issue' }); // 503-like, no answer: Check again (window) or Look up
    if (r.status === 409 && !r.sealed && r.error === 'request_in_progress') return say(a, CREDIT_TEXT.inProgress, { find: true, check: 'issue' });
    // A Check again was sent under the key (§3.1's Check-again column, P2-31): none of these ends the outcome or claims what ran.
    if (r.status === 422 || (r.status === 403 && r.error === 'step_up_required')) { shut(a, 'issue'); return find(CREDIT_TEXT.replayGone); }
    if (r.status === 401) { shut(a, 'issue'); return find(CREDIT_TEXT.endedUnknown); } // the section signs out next: detached
    if (r.status === 403) return session === 'denied' ? say(a, CREDIT_TEXT.noAccess, { alert: true, bare: true }) : unknown(session === 'gone' ? {} : { check: 'issue' });
    if (r.status === 404) { shut(a, 'issue'); return find(CREDIT_TEXT.cantContinue); }
    if (r.status === 429) return unknown({ also: CREDIT_TEXT.rateLimitedWait(r.retryAfterSeconds ?? DEFAULT_WAIT_SECONDS), check: 'issue' });
    unknown({ check: 'issue' });
  }

  /** A settlement (Confirm or Release) under its held key and bytes, and its answer (§3.1, Confirm / Release rows). */
  async function runSettle(h: HeldCreditNote, csrf: string, version: 1 | 2, me: number, replay = false): Promise<void> {
    const a = h.attemptId;
    const g = h.generation;
    const st = await cnSend(a, g, 'settle', csrf, (t) => issuing.settleCreditNote(h.storeId, h.invoiceId, t.key, t.body, csrf),
      () => { giveCnBusy(me); sayOffer(a, 'settleUnknown', { alert: true, find: true, check: 'settle' }); }, replay); // the request runs on; Look up attempt is back
    if (st === null) return say(a, CREDIT_TEXT.internalError, { alert: true, find: true }); // the hold refused the send
    const { d, r } = st;
    const session = await cnDenial(r, csrf, a);
    try { await cnSettleAnswer(a, g, h, d, r, session, version); } finally { cnSignedOut(r, csrf); }
  }
  async function cnSettleAnswer(a: string, g: number, h: HeldCreditNote, d: CreditNoteDecision, r: CreditNoteCommandResult, session: string, version: 1 | 2): Promise<void> {
    const find = (text: string): void => say(a, text, { alert: true, find: true });
    if (d === 'stale' || d === 'same') return void (session === 'denied' && cnNoAccess());
    if (d === 'first' && r.kind === 'settled') {
      if (!cnHolds.change(uid, a, g, { state: r.state })) return find(CREDIT_TEXT.internalError); // a state it cannot move to: fail closed
      say(a, r.state === 'released' ? CREDIT_TEXT.released : CREDIT_TEXT.confirmed);
      rereadAmounts();
      void readCreditList(h.storeId, h.invoiceId, 'first', null);
      void readCreditLookup(h.storeId, h.invoiceId, 'start'); // its row's new state (the gate and the blockers follow it)
      if (r.state === 'confirmed') activityAfterOwnWrite(h.storeId); // doc 18 CA-44: this tab's own Confirm (200)
      return;
    }
    if (d === 'first' && r.kind === 'refused' && r.error === 'write_conflict') {
      // The row is not in the state this version fits: the lookup shows its state and actions.
      await readCreditLookup(h.storeId, h.invoiceId, 'start');
      return cnFromLookup(a);
    }
    if (d === 'first') return find(CREDIT_TEXT.settleNotDone);
    const issueSent = version === 2 || (cnHolds.get(uid) ?? h).sends.some((x) => x.stage === 'issue');
    if (r.kind === 'refused' && r.status === 403 && session === 'denied') return say(a, issueSent ? CREDIT_TEXT.noAccess : CREDIT_TEXT.noAccessShort, { alert: true, bare: true });
    if (d === 'fail-closed' || d === 'different') return find(CREDIT_TEXT.internalError);
    const unknown = (o: CreditSayOptions = {}): void => sayOffer(a, 'settleUnknown', { alert: true, find: true, ...o });
    if (r.kind !== 'refused') return unknown({ check: 'settle' }); // 503-like, no answer: Check again (under 23 h) or Look up
    // The settlement's rows read the same in both columns (§3.1): a tenant mismatch is settleNotDone; a wait cools.
    if (r.status === 400 || (r.status === 409 && !r.sealed && r.error === 'write_conflict')) return find(CREDIT_TEXT.settleNotDone);
    if (r.status === 409 && !r.sealed && r.error === 'request_in_progress') return say(a, CREDIT_TEXT.inProgress, { find: true, check: 'settle' });
    if (r.status === 429) return say(a, CREDIT_TEXT.rateLimitedWait(r.retryAfterSeconds ?? DEFAULT_WAIT_SECONDS), { alert: true, find: true, check: 'settle' });
    // A 404 (D-P2-6: Look up or Hide), a sign-out, a refused replay: settleUnknown without Check again.
    if (r.status === 404 || r.status === 401 || r.status === 422) { shut(a, 'settle'); return unknown(); }
    if (r.status === 403) return unknown(session === 'gone' ? {} : { check: 'settle' });
    unknown({ check: 'settle' });
  }

  /** A settlement of `h` sent and not decided, its bytes still held: no second key may follow (§2.6 item 2). */
  const settleOut = (h: HeldCreditNote): boolean => h.settle !== null && h.settle.completion === null && h.settle.body !== '' && h.sends.some((x) => x.stage === 'settle' && x.key === h.settle?.key);
  /** "Confirm credit note" after the attempt's own issue 201 (D-P2-16): version 2 under a new key, held before it leaves. */
  async function confirmCredit(): Promise<void> {
    const h = cnHolds.get(uid);
    if (h === undefined || h.state !== 'issued' || h.issue?.completion?.kind !== 'issued' || h.csrf === null || settleOut(h) || cnSending.current || waitRef.current) return;
    if (bareNow(memoFor(h.attemptId).bare)) return; // rule 4: no Confirm credit note
    const me = takeCnBusy();
    cnPress.current += 1;
    try {
      const n = gen.current.n;
      const since = sessionEndsSoFar();
      const stands = (): boolean => alive.current && n === gen.current.n && since === sessionEndsSoFar();
      const csrf = await payConnect(stands);
      if (csrf === null) return cnUnavailable(stands);
      if (adopt(csrf)) return; // another token detached it: the lookup decides
      if (bareNow(memoFor(h.attemptId).bare)) return; // rule 4 under the token just read
      const body = settleBodyOf(h.tenantId, h.attemptId, 2);
      if (body === null || !cnHolds.holdSettlement(uid, h.attemptId, h.generation, 2, nextKey(), body)) return say(h.attemptId, CREDIT_TEXT.internalError, { alert: true, find: true });
      await runSettle(h, csrf, 2, me);
    } finally {
      giveCnBusy(me);
    }
  }

  /**
   * "Release attempt" on an open row, "Confirm credit note" on an issued one (lookup-first, D-P2-16): only a row this
   * section's lookup shows now, under this generation and token; a new key, held before it leaves — on the held attempt
   * when the row is its own, else as a new hold of that row (a reload, a detached card).
   */
  async function settleCreditRow(store: StoreEntry, invoiceId: string, row: CreditLookupRow, version: 1 | 2): Promise<void> {
    const s = creditRef.current;
    if (cnSending.current || waitRef.current || s === null || !creditCurrent(s) || s.storeId !== store.id || s.invoiceId !== invoiceId || s.lookup?.rows.includes(row) !== true) return;
    const me = takeCnBusy();
    cnPress.current += 1;
    try {
      const n = gen.current.n;
      const since = sessionEndsSoFar();
      const stands = (): boolean => alive.current && n === gen.current.n && since === sessionEndsSoFar() && creditRef.current === s;
      const csrf = await payConnect(stands);
      if (csrf === null) return cnUnavailable(stands);
      if (adopt(csrf) || creditRef.current?.lookup?.rows.includes(row) !== true) return;
      if (bareNow(memoFor(row.attemptId).bare)) return; // rule 4: no Release or Confirm for this attempt under this token
      const body = settleBodyOf(store.tenantId, row.attemptId, version);
      if (body === null) return sayAside(CREDIT_TEXT.internalError); // nothing held, nothing sent
      const key = nextKey();
      const h = cnHolds.get(uid);
      if (h !== undefined && h.attemptId === row.attemptId && h.csrf !== null) {
        if (settleOut(h)) return; // its own settlement is sent and undecided: Check again, then the lookup after its limit (§3.2)
        if (row.state === 'issued' && row.creditNote !== null) cnHolds.change(uid, h.attemptId, h.generation, { state: 'issued', creditNoteId: row.creditNote.id });
        if (row.state === 'open' && h.state === 'registering') cnHolds.change(uid, h.attemptId, h.generation, { state: 'registered' });
        if (h.settle !== null) cnHolds.retire(uid, h.attemptId, h.generation, 'settle');
        if (!cnHolds.holdSettlement(uid, h.attemptId, h.generation, version, key, body)) return say(h.attemptId, CREDIT_TEXT.internalError, { alert: true, find: true });
      } else {
        if (h !== undefined && cnEnded(h)) cnHolds.remove(uid, h.attemptId);
        const put = cnHolds.put(uid, {
          start: 'settle', version, creditNoteId: row.creditNote?.id ?? null, attemptId: row.attemptId, storeId: store.id, tenantId: store.tenantId, invoiceId,
          invoiceNumber: row.invoiceNumber, grossCents: row.grossCents, reason: row.reason, csrf, key, body,
        });
        if (put.kind !== 'held') return sayAside(put.kind === 'busy' ? CREDIT_TEXT.blockedOwn : CREDIT_TEXT.internalError); // nothing held, nothing sent
      }
      await runSettle(cnHolds.get(uid) as HeldCreditNote, csrf, version, me);
    } finally {
      giveCnBusy(me);
    }
  }

  /** "Look up attempt": the lookup from page one (a new lookup generation), then what it says about the held attempt. */
  async function findCredit(): Promise<void> {
    const h = cnHolds.get(uid);
    if (h === undefined || waitRef.current || cnSending.current) return;
    const mine = ++cnPress.current;
    const me = takeCnBusy();
    try {
      await readCreditLookup(h.storeId, h.invoiceId, 'start');
      if (cnPress.current === mine) cnFromLookup(h.attemptId); // a later press (Continue issuing, Check again) speaks for itself
    } finally {
      giveCnBusy(me);
    }
  }
  /**
   * What the current lookup says about the held attempt, forward only (§3.3): a settled row ends it; an issued or open row
   * moves its known state (its actions are the row's); read to the end without it: notListed once an issue was sent, else
   * regUnknown — never "not issued". A failed or denied lookup decides nothing (its own text says so).
   */
  function cnFromLookup(attemptId: string): void {
    const h = cnHolds.get(uid);
    const s = creditRef.current;
    if (h === undefined || h.attemptId !== attemptId || s === null || s.storeId !== h.storeId || s.invoiceId !== h.invoiceId || !creditCurrent(s)) return;
    const l = s.lookup;
    if (l === null || (l.phase !== 'exhausted' && l.phase !== 'incomplete')) return;
    const row = l.rows.find((x) => x.attemptId === attemptId);
    if (row === undefined) {
      // Evidence (b) only from this hold itself: it registered, never claimed an issue key, and is below issuing; else notListed.
      const noIssue = h.register !== null && h.issue === null && (h.state === 'registering' || h.state === 'registered');
      if (l.phase === 'exhausted') say(attemptId, noIssue ? CREDIT_TEXT.regUnknown : CREDIT_TEXT.notListed, { alert: true, find: true });
      return;
    }
    if (row.state === 'released' || row.state === 'confirmed') {
      if (!cnHolds.change(uid, attemptId, h.generation, { state: row.state })) return say(attemptId, CREDIT_TEXT.internalError, { alert: true, find: true });
      say(attemptId, row.state === 'released' ? CREDIT_TEXT.released : CREDIT_TEXT.confirmed);
      rereadAmounts();
      return;
    }
    if (row.state === 'issued' && row.creditNote !== null) {
      // Issued: its row's Confirm finishes it — no Check again or continuation of an earlier stage any more (forward only).
      if (!cnHolds.change(uid, attemptId, h.generation, { state: 'issued', creditNoteId: row.creditNote.id })) return say(attemptId, CREDIT_TEXT.internalError, { alert: true, find: true });
      if (h.state !== 'issued') say(attemptId, CREDIT_TEXT.alreadyIssued, { alert: true, find: true });
    } else if (row.state === 'open' && h.state === 'registering') cnHolds.change(uid, attemptId, h.generation, { state: 'registered' });
  }

  // ---- recovering a credit-note attempt (CN-P2 recovery side, doc 17 §3.1-§3.3, §3.6) ----

  /** The review's reads after a Check again found the attempt registered (§3.2): amounts, the lookup and the list to its end (display only). */
  function cnReview(h: HeldCreditNote): void {
    rereadAmounts();
    void readCreditLookup(h.storeId, h.invoiceId, 'start');
    void readCreditList(h.storeId, h.invoiceId, 'first', null, true);
  }
  /**
   * A Check again past its window or limit (§3.2 item 6, judged at the press and when the window passes): the hold's own
   * gate refuses it and scrubs the passed bytes; the card says what is left — replayGone (issue), regUnknown (register),
   * settleUnknown without Check again (settlement) — through the alert region.
   */
  function cnExpire(h: HeldCreditNote, stage: CreditNoteStage): void {
    if (stage === 'proof' || !isLiveCreditNote(h) || h[stage] === null || h[stage]?.completion !== null) return;
    const block = sendBlockOf(h, stage, true, clock(), wall());
    // Refused at its window, a send records nothing and scrubs the passed bytes; bytes already gone passed it too.
    if (block === 'window' && cnHolds.get(uid) === h) cnHolds.send(uid, h.attemptId, h.generation, stage, { replay: true, csrf: h.csrf ?? '', sessionEnds: sessionEndsSoFar() });
    else if (block !== 'no-bytes') return; // in flight, cooling or never sent: not its window
    shut(h.attemptId, stage);
    if (stage === 'settle') return sayOffer(h.attemptId, 'settleUnknown', { alert: true, find: true });
    say(h.attemptId, stage === 'issue' ? CREDIT_TEXT.replayGone : CREDIT_TEXT.regUnknown, { alert: true, find: true });
  }

  /**
   * "Check again" (doc 17 §3.2): the card's stage once more under its held key and exact bytes (the proof: one more read),
   * on a press only, only while the hold lets it leave — the window or limit judged here, at the press, whatever the timers
   * did — and with the session read again first (another token detaches the hold, rule 1). A success never runs on into the
   * next stage: a register 201 or a proof 200 stops at registeredOnly; the issue is "Continue issuing", a press of its own.
   */
  async function checkCredit(): Promise<void> {
    const h = cnHolds.get(uid);
    const s = cnSayRef.current?.attemptId === h?.attemptId ? cnSayRef.current : cnSayOf(h); // a remount's card says what its stage allows
    if (h === undefined || s === null || s.attemptId !== h.attemptId || s.check === null || bareNow(s) || cnSending.current || waitRef.current) return;
    const stage = s.check;
    const a = h.attemptId;
    const g = h.generation;
    if (!checkLeaves(h, stage, clock(), wall())) return cnExpire(h, stage); // in flight or cooling: nothing (the button was not offered)
    const me = takeCnBusy();
    cnPress.current += 1; // a chain still out never runs on past this press (§2.6 item 3)
    try {
      const n = gen.current.n;
      const since = sessionEndsSoFar();
      const stands = (): boolean => alive.current && n === gen.current.n && since === sessionEndsSoFar();
      const csrf = await payConnect(stands);
      if (csrf === null) return cnUnavailable(stands);
      if (adopt(csrf) || csrf !== h.csrf) return; // another token detached it (rule 3): the card says what is left
      if (bareNow(memoFor(a).bare)) return; // rule 4 under the token just read: nothing leaves
      const now = cnHolds.get(uid);
      if (now === undefined || now.attemptId !== a || now.generation !== g) return;
      if (!checkLeaves(now, stage, clock(), wall())) return cnExpire(now, stage);
      const back = (): void => giveCnBusy(me); // 30 s without an answer: the card says so again; the request runs on
      if (stage === 'register') {
        const reg = await cnSend(a, g, 'register', csrf, (t) => issuing.registerCreditNote(h.storeId, h.invoiceId, t.key, t.body, csrf),
          () => { back(); say(a, CREDIT_TEXT.regUnknown, { alert: true, find: true, check: 'register' }); }, true);
        if (reg === null) return say(a, CREDIT_TEXT.internalError, { alert: true, find: true }); // the hold refused the send
        const registered = await cnRegisterAnswer(h, csrf, reg.d, reg.r, await cnDenial(reg.r, csrf, a));
        cnSignedOut(reg.r, csrf);
        if (registered) { sayOffer(a, 'registeredOnly', { find: true, cont: 'continue' }); cnReview(h); }
        return;
      }
      if (stage === 'proof') {
        const proof = await cnSend(a, g, 'proof', csrf, (t) => issuing.creditNoteProof(h.storeId, h.invoiceId, t.body, a, csrf),
          () => { back(); sayOffer(a, 'registeredOnly', { find: true, cont: 'continue', check: 'proof' }); }, true);
        if (proof === null) return say(a, CREDIT_TEXT.internalError, { alert: true, find: true });
        cnProofAnswer(a, proof.d, proof.r, await cnDenial(proof.r, csrf, a));
        cnSignedOut(proof.r, csrf);
        if (proof.d === 'open') cnReview(h);
        return;
      }
      if (stage === 'issue') {
        const issue = await cnSend(a, g, 'issue', csrf, (t) => issuing.issueCreditNote(h.storeId, h.invoiceId, t.key, t.body, csrf),
          () => { back(); sayOffer(a, 'unresolved', { alert: true, find: true, check: 'issue' }); }, true);
        if (issue === null) return say(a, CREDIT_TEXT.internalError, { alert: true, find: true });
        await cnIssueAnswer(h, csrf, issue.d, issue.r, await cnDenial(issue.r, csrf, a));
        cnSignedOut(issue.r, csrf);
        return;
      }
      // The held settlement's own version: never a default (Confirm is version 2).
      if (now.settle === null) return say(a, CREDIT_TEXT.internalError, { alert: true, find: true });
      await runSettle(now, csrf, now.settle.version, me, true);
    } finally {
      giveCnBusy(me);
    }
  }

  /** D-P2-15 stated on the card: the notes outside the baseline (or every note read, when it can't compare), and "Issue another credit note". */
  function cnAnother(a: string, g: number, v: { readonly ids: readonly string[]; readonly found: boolean; readonly complete: boolean }): void {
    cnHolds.change(uid, a, g, { shown: { ids: v.ids, complete: v.complete } });
    say(a, v.found ? CREDIT_TEXT.anotherNoteFound : CREDIT_TEXT.anotherNoteUnknown, {
      alert: true, also: v.found && !v.complete ? CREDIT_TEXT.anotherNoteUnknown : '', find: true, cont: 'another', focusFind: true,
    });
  }
  /**
   * "Continue issuing" — or "Issue another credit note" once D-P2-15 stated other notes or an uncertainty (doc 17 §3.2):
   * this press's review reads first (the session, the invoice, its payments, the lookup, the list to its end), then E1-E7
   * in order; the first that fails says why, and nothing is registered, issued or settled (the reads may have gone out).
   * Only a proof 200 answered in this press counts (E5); the sign-in window is judged again just before the send (E6); the
   * ONE issue key is claimed by compare-and-set (E7). It never registers.
   */
  async function continueCredit(another: boolean): Promise<void> {
    const h0 = cnHolds.get(uid);
    const s0 = cnSayRef.current?.attemptId === h0?.attemptId ? cnSayRef.current : cnSayOf(h0);
    if (h0 === undefined || s0 === null || s0.attemptId !== h0.attemptId || bareNow(s0) || s0.cont !== (another ? 'another' : 'continue') || cnSending.current || waitRef.current) return;
    const a = h0.attemptId;
    const g = h0.generation;
    const { storeId: sid, invoiceId: iid } = h0;
    const cont = another ? 'another' : 'continue';
    const afterSignIn = (): void => say(a, CREDIT_TEXT.continueAfterSignIn, { alert: true, also: CREDIT_TEXT.registeredOnly(false), find: true });
    const me = takeCnBusy();
    const mine = ++cnPress.current;
    try {
      const n = gen.current.n;
      const since = sessionEndsSoFar();
      const stands = (): boolean => alive.current && n === gen.current.n && since === sessionEndsSoFar();
      const csrf = await payConnect(stands);
      if (csrf === null) return cnUnavailable(stands);
      if (adopt(csrf) || csrf !== h0.csrf) return afterSignIn(); // E2: another token detached the hold
      if (bareNow(memoFor(a).bare)) return; // rule 4 under the token just read: nothing leaves
      // E3's reads, one at a time; the list read to its end into the current set (never the baseline).
      const detail = await issuing.getIssued(sid, iid, csrf, new AbortController().signal);
      const paid = await issuing.getPayments(sid, iid, null, csrf, new AbortController().signal);
      await readCreditLookup(sid, iid, 'start');
      await readCreditList(sid, iid, 'first', null, true);
      rereadAmounts();
      if (!alive.current || cnPress.current !== mine || bareNow(cnSayRef.current)) return; // a confirmed denial took the buttons (rule 4)
      for (const read of [detail, paid]) {
        if (read.kind === 'signed-out') { failSession({ kind: 'signed-out', text: ISSUED_TEXT.ended }); return afterSignIn(); }
        if (read.kind === 'denied') {
          const verdict = await creditDenial(csrf, () => false);
          if (verdict === 'denied') return creditDenied('other', true, sid);
          // Not checked (the session read failed): the access question stays open, so does the registration (SF-4).
          return verdict === 'gone' ? afterSignIn() : sayOffer(a, 'registeredOnly', { find: true, cont });
        }
      }
      const h = cnHolds.get(uid);
      if (h === undefined || h.attemptId !== a) return;
      if (h.csrf === null || gen.current.csrf !== h.csrf) return afterSignIn(); // E2 again: a token change while the reads were out
      if (h.generation !== g) return;
      const s = creditRef.current;
      const here = s !== null && s.storeId === sid && s.invoiceId === iid && creditCurrent(s) ? s : null;
      const lookup = here?.lookup ?? null;
      const row = lookup?.rows.find((x) => x.attemptId === a);
      // E1: this tab's registered attempt with no issue key; its own row open or not listed (issued, released, confirmed: that state).
      if (row !== undefined && row.state !== 'open') return cnFromLookup(a);
      if (h.state !== 'registered' || h.registrationId === null || h.issue !== null) { shut(a, 'proof'); return say(a, CREDIT_TEXT.cantContinue, { alert: true, find: true }); }
      // E3: an issued invoice, the held amount within the remaining just read, the lookup to its end, no other unfinished row here.
      if ((detail.kind === 'ok' && detail.invoice.status === 'voided') || (paid.kind === 'ok' && paid.page.invoice.status === 'voided')) return say(a, CREDIT_TEXT.voided, { alert: true, find: true });
      if (detail.kind !== 'ok' || paid.kind !== 'ok') return sayOffer(a, 'registeredOnly', { find: true, cont }); // not read: decides nothing
      if (h.grossCents > paid.page.amounts.remainingCents) return say(a, CREDIT_TEXT.overRemaining, { alert: true, find: true });
      if (lookup === null || lookup.phase !== 'exhausted') return say(a, lookup?.phase === 'incomplete' ? CREDIT_TEXT.lookupIncomplete : CREDIT_TEXT.lookupFailed, { alert: true, find: true, cont });
      if (lookup.rows.some((x) => x.attemptId !== a && (x.state === 'open' || x.state === 'issued'))) return say(a, CREDIT_TEXT.unfinished, { alert: true, find: true });
      // E4 (D-P2-15): the list read now against the baseline frozen at the register's first send.
      const list = here?.list ?? null;
      const ids = list?.notes.map((x) => x.id) ?? [];
      const base = h.baseline ?? { ids: [], complete: false };
      const outside = ids.filter((id) => !base.ids.includes(id));
      const covered = list !== null && list.phase === 'ready' && list.complete && base.ids.every((id) => ids.includes(id));
      const verdict = base.complete && covered && outside.length === 0 ? null
        : base.complete && outside.length > 0 ? { ids: outside, found: true, complete: covered } : { ids, found: false, complete: false };
      // "Issue another credit note" accepts what the card stated: it stops only on an id it never showed, or on an uncertainty it never stated.
      const shownIds = h.shown?.ids ?? [];
      if (!another && verdict !== null) return cnAnother(a, g, verdict);
      if (another && verdict !== null && (outside.some((id) => !shownIds.includes(id)) || (h.shown?.complete === true && !verdict.complete))) {
        // What it stated, plus what it now sees: the notes it listed stay listed, the uncertainty is stated.
        const ids = [...new Set([...shownIds, ...verdict.ids])];
        return cnAnother(a, g, { ids, found: verdict.found || (base.complete && ids.length > 0), complete: verdict.complete });
      }
      // E5: a valid proof 200 answered in this press — the session read again just before it (§3.6 rule 1).
      if (!(await cnSession(a, csrf, cont)) || !alive.current || cnPress.current !== mine) return;
      const proof = await cnSend(a, g, 'proof', csrf, (t) => issuing.creditNoteProof(sid, iid, t.body, a, csrf),
        () => { giveCnBusy(me); sayOffer(a, 'registeredOnly', { find: true, cont, check: 'proof' }); });
      if (proof === null) return sayOffer(a, 'registeredOnly', { find: true, cont });
      // An unmounted section has no current press (§2.6 item 3): the proof is recorded, the issue is never sent from here.
      if (proof.d !== 'open' || proof.r.kind !== 'proof' || !proof.inTime || cnPress.current !== mine || !alive.current) {
        cnProofAnswer(a, proof.d, proof.r, await cnDenial(proof.r, csrf, a));
        return cnSignedOut(proof.r, csrf);
      }
      if (!(await cnSession(a, csrf, cont)) || !alive.current || cnPress.current !== mine) return; // and just before the issue
      const ready = cnHolds.get(uid);
      if (ready === undefined || ready.attemptId !== a || ready.generation !== g || ready.csrf !== csrf) return;
      // E6: the sign-in window, judged again just before the send; a new sign-in cannot use this registration.
      const lapsed = (): void => { shut(a, 'proof'); say(a, CREDIT_TEXT.continueLapsed, { alert: true, also: CREDIT_TEXT.registeredOnly(false), find: true }); };
      if (!signInFresh(ready.signIn, clock(), wall())) return lapsed();
      // E7: the ONE issue key, by compare-and-set, held with its exact bytes before the first send.
      const body = creditNoteIssueBodyOf({ expectedTenant: ready.tenantId, registrationId: ready.registrationId as string, attemptId: a, grossCents: ready.grossCents, reason: ready.reason, registrationProof: proof.r.proof });
      const claim = body === null ? 'gone' : cnHolds.claimIssueKey(uid, a, g, nextKey(), body);
      if (claim === 'lapsed') return lapsed();
      if (claim === 'taken') return; // another contender holds the one key: nothing is sent here (§2.6 item 2)
      if (claim !== 'claimed') return say(a, CREDIT_TEXT.internalError, { alert: true, find: true });
      say(a, CREDIT_TEXT.sending);
      const issue = await cnSend(a, g, 'issue', csrf, (t) => issuing.issueCreditNote(sid, iid, t.key, t.body, csrf),
        () => { unsure(a, g); giveCnBusy(me); sayOffer(a, 'unresolved', { alert: true, find: true, check: 'issue' }); });
      if (issue === null) return say(a, CREDIT_TEXT.internalError, { alert: true, find: true });
      await cnIssueAnswer(ready, csrf, issue.d, issue.r, await cnDenial(issue.r, csrf, a));
      cnSignedOut(issue.r, csrf);
    } finally {
      giveCnBusy(me);
    }
  }

  /** The card's "Try again" for its number (§4.1): the follow again, from the failed page's cursor when the chain holds one. */
  function retryNumber(): void {
    const h = cnHolds.get(uid);
    if (h === undefined || h.creditNoteId === null || waitRef.current || cnSending.current || bareNow(memoFor(h.attemptId).bare)) return; // a press still out holds it back
    const s = creditRef.current;
    const l = s !== null && s.storeId === h.storeId && s.invoiceId === h.invoiceId && creditCurrent(s) ? s.list : null;
    const resume = l !== null && l.next !== null && l.target === h.creditNoteId && (l.phase === 'failed' || l.phase === 'ready');
    void readCreditList(h.storeId, h.invoiceId, resume ? 'next' : 'first', h.creditNoteId).catch(cnThrew(h.attemptId));
  }
  /** "Hide this attempt" (D-P2-6 A): the card only — the hold, its generation and its blockers stay; its answers still count. */
  function hideCredit(): void {
    const h = cnHolds.get(uid);
    if (h !== undefined) cnHolds.hide(uid, h.attemptId);
  }
  /**
   * Rule 4 on the card: a confirmed same-token denial in the section — the attempt keeps its last known state, its listed
   * notes go, and it offers nothing (noAccess; noAccessShort while no issue was ever sent).
   */
  function cnNoAccess(storeId?: string): void {
    const h = cnHolds.get(uid);
    // Every card of this user at the store whose denial was confirmed — attached, hidden or detached (P2-03; SEC-4).
    if (!isOpenCreditNote(h) || (storeId !== undefined && h.storeId !== storeId) || bareNow(memoFor(h.attemptId).bare)) return;
    const s = cnSayRef.current?.attemptId === h.attemptId ? cnSayRef.current : cnSayOf(h);
    if (h.shown !== null) cnHolds.change(uid, h.attemptId, h.generation, { shown: null });
    const was = s === null || s.attemptId !== h.attemptId ? '' : s.kind !== null ? CREDIT_TEXT[s.kind](false) : s.text; // its words without the buttons
    say(h.attemptId, h.sends.some((x) => x.stage === 'issue') ? CREDIT_TEXT.noAccess : CREDIT_TEXT.noAccessShort, { alert: true, also: was, bare: true });
  }

  /** A new generation: everything read under the previous token goes, and the stores are read again. */
  function begin(csrf: string): void {
    gen.current = { n: gen.current.n + 1, csrf };
    cnDeniedAt.current = null; // a later denial records the token it is confirmed under (rule 4)
    judgeVoid(csrf);
    abortReads();
    clearWait();
    dropPanel();
    closeView();
    putList(LIST_IDLE);
    dropActivity(); // doc 18 §4.5 rule 5: before any new request; read again once a store is chosen (begin clears it)
    forgetListed(); // a new generation: its directory read lists afresh
    storeRef.current = '';
    setStoreIdState('');
    setChanged(true);
    void readStores();
  }
  /** Take a confirmed token: the first fixes the generation, the same changes nothing, another starts a new one (true). */
  function adopt(csrf: string): boolean {
    if (gen.current.csrf === csrf) return false;
    if (gen.current.csrf === null) { gen.current.csrf = csrf; cnDeniedAt.current = null; judgeVoid(csrf); dropCredit(); dropActivity(); forgetListed(); return false; } // same number, another token (rule 2)
    begin(csrf);
    return true;
  }
  /**
   * The user's own recent sign-in renewed the session (its new token): adopted as this section's without starting over —
   * the same user, by an explicit action — but every read out under the old token is cancelled, the invoices read under it
   * go (the settings panel, read by its own re-read, stays), and an attempt sent with it
   * can never be checked under this one (none is live when the sign-in group shows: a step-up acquires no key).
   */
  function renew(csrf: string): void {
    if (gen.current.csrf === csrf) return;
    const listedUnder = `${gen.current.n}:${gen.current.csrf}`;
    gen.current = { n: gen.current.n + 1, csrf };
    carryListed(listedUnder); // doc 18 §8.4: the picker stays and is not re-read, so what it listed stays "listed before"
    cnDeniedAt.current = null; // a later denial records the token it is confirmed under (rule 4)
    judgeVoid(csrf);
    abortReads();
    // What was read under the old token goes (DESIGN §2): the open invoice, and the list's pages and cursor — the store stays
    // chosen and the list says so, with Try again (page one under this token). Nothing is read on its own.
    closeView();
    activityContextChanged(); // doc 18 §4.5 rule 5: renew moves the generation without begin
    const l = listRef.current;
    if (l.storeId !== '') putList({ ...listOf(gen.current.n, l.storeId), phase: 'unavailable', text: LIST_TEXT.renewed });
  }
  /**
   * The void's own explicit sign-in renewed the session (design R11): its token is adopted and every void attempt sent with
   * the old one detached, as `renew` does — but the open dialog STAYS (it re-reads the invoice and its eligibility itself);
   * the list read under the old token goes as `renew`'s does.
   */
  function renewKeepingView(csrf: string): void {
    if (gen.current.csrf === csrf) return;
    const listedUnder = `${gen.current.n}:${gen.current.csrf}`;
    gen.current = { n: gen.current.n + 1, csrf };
    carryListed(listedUnder); // doc 18 §8.4: the picker stays and is not re-read, so what it listed stays "listed before"
    cnDeniedAt.current = null; // a later denial records the token it is confirmed under (rule 4)
    judgeVoid(csrf);
    abortReads();
    // The kept dialog's credit notes and lookup were read under the old token: dropped, then read again from page one (rule 3).
    const v = viewRef.current;
    const was = creditRef.current;
    dropCredit();
    if (v !== null && was !== null && was.storeId === v.storeId && was.invoiceId === v.invoiceId) startCredit(v.storeId, v.invoiceId);
    activityContextChanged(); // doc 18 §4.5 rule 5, as renew
    const l = listRef.current;
    if (l.storeId !== '') putList({ ...listOf(gen.current.n, l.storeId), phase: 'unavailable', text: LIST_TEXT.renewed });
  }

  /** A refusal of the session clears every view (Reconnect then). */
  function failSession(failure: Failure): void {
    if (failure.kind === 'signed-out') { holds.detach(uid); detachPay(); detachRev(); cnHolds.detach(uid); } // design R12: a sent void can never be checked again under a later session
    abortReads();
    setChanged(false);
    putStores({ phase: failure.kind, text: failure.text, stores: [] });
    storeRef.current = '';
    setStoreIdState('');
    closeView();
    putList(LIST_IDLE);
    dropActivity(); // doc 18 (B0): every row of the activity goes with the store choice
    forgetListed();
    dropPanel();
    if (failure.kind === 'signed-out') { gen.current = { n: gen.current.n, csrf: null }; cnDeniedAt.current = null; } // the Reconnect's token is a FIRST token
  }

  /** After a read refused 403: ONE fresh check tells "another session" (a new generation) from a refusal that stands. */
  async function recheck(): Promise<Failure | null> {
    const since = sessionEndsSoFar();
    const s = await connect('fresh');
    if (s.kind !== 'ok') return sessionFailure(s);
    if (alive.current && since === sessionEndsSoFar()) adopt(s.csrf); // never a token from before a sign-out
    return null;
  }
  /** A 403's verdict after that one check: 'denied' only when it confirmed the same session; null when the caller's context is gone. */
  function denialOf(stale: () => boolean): Promise<'denied' | Failure | null> {
    const token = gen.current.csrf;
    const store = storeRef.current; // the refused read's store, taken when it is refused (N2), not when the check ends
    return cnChecking(token, denialOfRun(stale).then((v) => {
      // Rule 4 for the cards, once (cnNoAccess is idempotent; a caller's own creditDenied then changes no card again).
      if (v === 'denied' && token !== null && token === gen.current.csrf) { cnDeniedAt.current = token; cnDenials.current += 1; cnNoAccess(store === '' ? undefined : store); }
      return v;
    }));
  }
  async function denialOfRun(stale: () => boolean): Promise<'denied' | Failure | null> {
    const n = gen.current.n;
    const since = sessionEndsSoFar();
    const again = await recheck();
    const same = alive.current && n === gen.current.n && since === sessionEndsSoFar();
    if (same && again?.kind === 'signed-out') { failSession(again); return null; }
    // The section's wait starts whether or not the caller is still there (the drafts section's order).
    const waited = same && again?.seconds !== undefined ? startWait(again.seconds) : null;
    if (stale()) return null;
    if (again === null) return 'denied';
    if (again.kind === 'signed-out') { failSession(again); return null; }
    if (again.seconds !== undefined) return { kind: 'rate-limited', text: pickerWaitText(waited ?? startWait(again.seconds)), seconds: again.seconds };
    return UNAVAILABLE;
  }

  /** A 403 of one open's reads: ONE in-flight fresh check shared by its detail and eligibility reads (iam 1); each asks its own `stale` after. */
  async function viewDenialOf(viewId: number, stale: () => boolean): Promise<'denied' | Failure | null> {
    let check = viewDenial.current.get(viewId);
    if (check === undefined) {
      const started = denialOf(() => false);
      check = started;
      viewDenial.current.set(viewId, started);
      void started.finally(() => { if (viewDenial.current.get(viewId) === started) viewDenial.current.delete(viewId); });
    }
    const verdict = await check;
    return stale() ? null : verdict;
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
    putStores({ phase: 'loading', text: ISSUED_TEXT.storesLoading, stores: [] });
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
      if (answer.kind === 'ok') {
        noteListed(answer.stores);
        return putStores({ phase: 'ready', text: answer.stores.length === 0 ? ISSUED_TEXT.noStores : '', stores: answer.stores });
      }
      if (answer.kind === 'signed-out') return failSession({ kind: 'signed-out', text: ISSUED_TEXT.ended });
      if (answer.kind === 'denied') {
        const verdict = await denialOf(stale);
        if (verdict === null) return;
        if (verdict !== 'denied') return putStores({ phase: verdict.kind, text: verdict.text, stores: [] });
        return putStores({ phase: 'denied', text: ISSUED_TEXT.storesDenied, stores: [] });
      }
      if (answer.kind === 'rate-limited') return putStores({ phase: 'rate-limited', text: pickerWaitText(startWait(answer.retryAfterSeconds)), stores: [] });
      putStores({ phase: 'unavailable', text: ISSUED_TEXT.unavailable, stores: [] });
    } finally {
      giveBusy(token);
    }
  }

  function show(): void {
    if (open) return;
    heading.current?.focus(); // the pressed control goes
    setOpen(true);
    void readStores();
  }

  function chooseStore(id: string): void {
    if (busyRef.current && storesRef.current.phase === 'loading') return;
    setNotice(''); // before the drop: a confirmed save that was not read back still says so
    dropPanel(); // a store change takes the panel, its values and any attempt with it
    // A store switch disables a payment attempt's replay for good, even back to its own store (owner decision, spec §7).
    if (payHolds.get(uid)?.storeId !== id) detachPay();
    if (revHolds.get(uid)?.storeId !== id) detachRev(); // the same rule for a reversal attempt (P2C)
    if (cnHolds.get(uid)?.storeId !== id) cnHolds.detach(uid); // and a credit-note attempt (doc 17 §3.6)
    for (const w of wdHolds.of(uid)) if (w.storeId !== id) wdHolds.detach(wdSlot(w.storeId, w.invoiceId)); // and withdrawal attempts (CN-P3)
    closeView();
    // The previous store's pages go (a read still out for it is cancelled; its late page finds another store).
    ctl.current.list?.abort();
    seq.current.list += 1;
    busyBy.current += 1;
    setBusy(false);
    storeRef.current = id;
    setStoreIdState(id);
    putList(listOf(gen.current.n, id));
    dropActivity(); // the previous store's activity goes (a late page finds another store)
    if (id === '') return;
    setChanged(false);
    // Choosing the store is the explicit action that reads its first page; during a wait nothing is read: the wait is said,
    // with Try again (given back once it has passed).
    if (waitRef.current) putList({ ...listOf(gen.current.n, id), phase: 'rate-limited', text: pickerWaitText(waitLeft()) });
    else void readList('first');
    void readActivity('first'); // doc 18 §4.1: its own read, sequence and wait (a wait sends nothing and says so)
  }

  // ---- the store-wide credit activity (doc 18 §4, §8.4) ----

  const putActivity = (next: ActivityState | null): void => { activityRef.current = next; setActivityState(next); };
  /** A fresh state of `storeId` under this generation and token. */
  const activityOf = (storeId: string, phase: ActivityState['phase'], o: Partial<Pick<ActivityState, 'via' | 'reloaded' | 'tenantId'>> = {}): ActivityState =>
    Object.freeze({
      n: gen.current.n, csrf: gen.current.csrf, storeId, phase, rows: [], next: null, complete: false, more: false, said: '', via: o.via ?? null, reloaded: o.reloaded ?? false,
      tenantId: o.tenantId ?? null,
    });
  /** The chosen store's tenant as the section's directory lists it now (null: not listed). */
  const tenantNow = (storeId: string): string | null => storesRef.current.stores.find((s) => s.id === storeId)?.tenantId ?? null;
  /** Whether a state still belongs to the generation AND the token this section holds now (§4.5 rule 4). */
  const activityCurrent = (a: ActivityState): boolean => a.n === gen.current.n && a.csrf === gen.current.csrf;
  /** Every activity row and cursor goes now, and every request of this sub-section out is stale (§4.5 rule 5). */
  function dropActivity(): void {
    activityCtl.current?.abort();
    activitySeq.current += 1;
    if (activityRef.current !== null) putActivity(null);
  }
  /** (A) and (U): this view's rows, cursor, names and request chain go and the sub-section is hidden; nothing else changes. */
  function hideActivity(storeId: string): void {
    // Focus inside the sub-section goes to the section's heading before the sub-section goes (doc 18 §4.1: hidden, no text).
    if (document.querySelector('[data-testid="issued-credit-activity"]')?.contains(document.activeElement) === true) heading.current?.focus();
    dropActivity();
    putActivity(activityOf(storeId, 'hidden'));
  }
  /** The stores this tab's directory listed under this generation and token (§8.4 "previously listed"). */
  function forgetListed(): void { listed.current = { key: '', stores: new Map() }; }
  /** `renew` / `renewKeepingView`: the listing made under the generation and token just replaced carries over to the new one. */
  function carryListed(was: string): void {
    if (listed.current.key === was) listed.current = { key: `${gen.current.n}:${gen.current.csrf}`, stores: listed.current.stores };
  }
  function noteListed(stores: readonly StoreEntry[]): void {
    const key = `${gen.current.n}:${gen.current.csrf}`;
    if (listed.current.key !== key) listed.current = { key, stores: new Map() };
    for (const s of stores) listed.current.stores.set(s.id, s.tenantId);
  }
  /**
   * `renew` / `renewKeepingView` (and a page of an older generation): every row dropped, then page one once, whatever the
   * view showed — a view an (A) or (U) 403 hid included, since the generation moved (§4.1, §4.3 "Context change"); a
   * read-only store still sends nothing and a running wait is honoured first (readActivity). A second mismatch while a
   * reload is still out shows the error (D17:571).
   */
  function activityContextChanged(): void {
    const a = activityRef.current;
    const target = storeRef.current;
    dropActivity();
    if (target === '') return;
    if (a !== null && a.storeId === target && a.reloaded) return putActivity(activityOf(target, 'failed'));
    void readActivity('first', { reloaded: true });
  }
  /** CA-44: this tab's own issue (201) or Confirm (200) at `storeId` re-reads page one of a loaded view there, once. */
  function activityAfterOwnWrite(storeId: string): void {
    const a = activityRef.current;
    if (a !== null && a.storeId === storeId && storeRef.current === storeId && activityCurrent(a) && (a.phase === 'ready' || a.phase === 'loading')) void readActivity('first');
  }

  /**
   * One page of the chosen store's credit activity on the readList skeleton (§4.5): `connect()` first, the generation and
   * token captured before the send, this sub-section's own sequence and abort; an answer applies only while the generation,
   * token, sequence, store and sign-out count all stand. 'first' starts a new traversal at page one that REPLACES the
   * loaded chain (store choice, Refresh, Try again, a context change, an own write); 'more' appends the page after the
   * chain's cursor, as served (§6.3). Nothing is sent during a wait, for a store the directory marks read-only, or for a
   * view a 403 hid under this generation. Any failure shows the error with no rows; a 403 is classified (§8.4).
   */
  async function readActivity(mode: 'first' | 'more', o: { readonly via?: 'refresh' | 'retry'; readonly reloaded?: boolean } = {}): Promise<void> {
    if (!creditActivity) return;
    const target = storeRef.current;
    const was = activityRef.current;
    const entry = storesRef.current.stores.find((s) => s.id === target);
    if (target === '' || entry === undefined || entry.readOnly) return dropActivity(); // §4.1: no request certain to be refused
    if (was !== null && was.storeId === target && was.phase === 'hidden' && activityCurrent(was)) return; // after (A): never again here
    if (mode === 'more') {
      if (was === null || was.storeId !== target || was.phase !== 'ready' || was.next === null || was.more) return;
      if (!activityCurrent(was)) return activityContextChanged(); // never a cursor across a context change
      if (was.tenantId === null || was.tenantId !== entry.tenantId) { // §4.4: another tenant's page never joins this traversal
        dropActivity();
        return putActivity({ ...activityOf(target, 'failed'), reloaded: was.reloaded });
      }
    }
    if (waitRef.current) {
      if (mode === 'first') { dropActivity(); putActivity(activityOf(target, 'rate-limited', o)); } // a Show more still out lands nowhere
      return; // nothing of this sub-section is sent during a wait
    }
    const mine = { n: gen.current.n, csrf: gen.current.csrf };
    const k = ++activitySeq.current;
    activityCtl.current?.abort();
    const controller = new AbortController();
    activityCtl.current = controller;
    const since = sessionEndsSoFar();
    const stale = (): boolean => !alive.current || controller.signal.aborted || k !== activitySeq.current || mine.n !== gen.current.n
      || mine.csrf !== gen.current.csrf || target !== storeRef.current || since !== sessionEndsSoFar();
    const base: ActivityState = mode === 'more' && was !== null ? { ...was, more: true, said: '' } : activityOf(target, 'loading', { ...o, tenantId: entry.tenantId });
    putActivity(base);
    const fail = (phase: 'failed' | 'rate-limited' = 'failed'): void => { if (!stale()) putActivity({ ...activityOf(target, phase), reloaded: base.reloaded }); };
    const s = await connect();
    if (stale()) return;
    if (s.kind !== 'ok') {
      const failure = sessionFailure(s);
      if (failure.kind === 'signed-out') return failSession(failure);
      if (failure.seconds !== undefined) { startWait(failure.seconds); return fail('rate-limited'); }
      return fail();
    }
    if (adopt(s.csrf) || stale()) return; // another token: a new generation dropped this view
    const answer = await issuing.storeCreditActivity(target, mode === 'more' ? base.next : null, s.csrf, controller.signal);
    if (stale()) return;
    if (answer.kind === 'ok') {
      const page = answer.page;
      // Across pages (§4.4): ids new and numbers strictly descending; the page's cursor is its own last id, so a repeated
      // cursor fails here too. User, token and store are the traversal's by `stale`; the tenant bound at page one must
      // still be the store's in the directory.
      if (tenantNow(target) !== base.tenantId) return fail();
      if (mode === 'more' && !storeCreditActivityFollows(base.rows, page)) return fail();
      const rows = mode === 'more' ? [...base.rows, ...page.creditNotes] : page.creditNotes;
      return putActivity({
        ...base, phase: 'ready', rows, next: page.nextCursor, complete: page.nextCursor === null, more: false, reloaded: false, // one load ends here (D17:571)
        said: mode === 'more' ? CREDIT_TEXT.moreLoaded(page.creditNotes.length) : '',
      });
    }
    if (answer.kind === 'signed-out') return failSession({ kind: 'signed-out', text: ISSUED_TEXT.ended }); // (B0)
    // A pending fresh check, as every same-token 403 check of the section: a credit-note press under this token waits for it.
    if (answer.kind === 'denied') return cnChecking(s.csrf, classifyActivityDenial(target, s.csrf, mine.n, since));
    if (answer.kind === 'rate-limited') { startWait(answer.retryAfterSeconds); return fail('rate-limited'); }
    return fail(); // 404 (the route absent: never Empty, no retry), a cursor 400, malformed, an outage
  }

  /**
   * §8.4: a 403 of this read is classified by NEW code — never `denialOf` or `readStores`, which apply D17 rule 4 to the
   * cards and empty the picker. `recheck()` first: signed out → (B0) `failSession`; another token → (B1) its adopt/`begin`
   * already dropped this view and the chosen store (the answer dropped silently); a failed check → (U). The same token →
   * `drafts.listStores` read directly under this sub-section's next request number (the picker is not changed): a store
   * listed before under this generation and token and now gone, or under another tenant → (B2) D17 rule 4's second bullet
   * exactly as a shipped read's confirmed denial applies it, plus this view; never listed, or still listed under the same
   * tenant → (A) this view only. A failed directory read → (U); its 401 → (B0).
   */
  async function classifyActivityDenial(target: string, carried: string, n: number, since: number): Promise<void> {
    const k = activitySeq.current; // the refused read's number
    const again = await recheck();
    if (!alive.current || since !== sessionEndsSoFar()) return; // a sign-out began meanwhile: its own path cleared the views
    if (again?.kind === 'signed-out') return failSession(again); // (B0)
    if (n !== gen.current.n || carried !== gen.current.csrf) return; // (B1): begin cleared this view and the chosen store
    if (again !== null && again.seconds !== undefined) startWait(again.seconds); // (U)'s wait applies whoever still asks
    if (k !== activitySeq.current || target !== storeRef.current) return; // a newer request of this sub-section, or another store
    if (again !== null || waitRef.current) return hideActivity(target); // (U): unverified, no cascade
    const d = ++activitySeq.current;
    activityCtl.current?.abort();
    const controller = new AbortController();
    activityCtl.current = controller;
    const stale = (): boolean => !alive.current || controller.signal.aborted || d !== activitySeq.current || n !== gen.current.n
      || carried !== gen.current.csrf || target !== storeRef.current || since !== sessionEndsSoFar();
    const answer = await drafts.listStores(carried, controller.signal);
    if (stale()) return;
    if (answer.kind === 'signed-out') return failSession({ kind: 'signed-out', text: ISSUED_TEXT.ended }); // (B0)
    if (answer.kind === 'rate-limited') startWait(answer.retryAfterSeconds);
    if (answer.kind !== 'ok') return hideActivity(target); // (U): 403, 429, outage, unreadable
    const before = listed.current.key === `${n}:${carried}` ? listed.current.stores.get(target) : undefined;
    const now = answer.stores.find((s) => s.id === target);
    hideActivity(target); // every outcome below hides this view; nothing more is asked for this store in this generation
    if (before === undefined || (now !== undefined && now.tenantId === before)) return; // (A): cause not established
    // (B2) verified store loss with the same token: the section's rule-4 clearing for that store, as a shipped read's
    // confirmed same-token denial applies it (denialOf's bookkeeping, then creditDenied) — no token adoption.
    cnDenials.current += 1; // creditDenied records cnDeniedAt from the token it is given
    creditDenied('other', true, target, carried);
  }

  // ---- the issued list ----

  /**
   * One page of the chosen store's issued invoices: 'first' (page one, replacing the rows) or 'more' (the page after the
   * cursor this list holds — only for its own store and generation). An answer applies only under the generation, store and
   * request that asked, with no sign-out since; a page never joins another store's rows.
   */
  async function readList(mode: 'first' | 'more', note = ''): Promise<void> {
    const target = storeRef.current;
    const was = listRef.current;
    const cursor = mode === 'more' ? was.next : null;
    if (target === '' || waitRef.current) return;
    if (mode === 'more' && (cursor === null || was.storeId !== target || was.gen !== gen.current.n || was.phase !== 'ready')) return;
    const mine = gen.current.n;
    const n = ++seq.current.list;
    ctl.current.list?.abort();
    const controller = new AbortController();
    ctl.current.list = controller;
    const since = sessionEndsSoFar();
    const stale = (): boolean => !alive.current || mine !== gen.current.n || n !== seq.current.list || target !== storeRef.current || since !== sessionEndsSoFar();
    const token = takeBusy();
    if (mode === 'first') putList({ ...(was.storeId === target && was.gen === mine ? was : listOf(mine, target)), phase: 'loading', text: LIST_TEXT.loading, note });
    // A failed Load more takes the button away: focus still on it goes to the list's Try again (else the heading).
    const handOff = (): void => {
      if (mode === 'more' && loadMore.current !== null && document.activeElement === loadMore.current) {
        keepFocus.current = { from: loadMore.current, inPanel: false, to: () => listRetry.current };
      }
    };
    // A failure keeps what was shown as last known (an outage, a wait); a refusal shows nothing.
    const fail = (phase: 'unavailable' | 'rate-limited', text: string): void => { handOff(); putList({ ...listRef.current, phase, text, note: '' }); };
    try {
      const s = await connect();
      if (stale()) return;
      if (s.kind !== 'ok') {
        const failure = sessionFailure(s);
        if (failure.kind === 'signed-out') return failSession(failure);
        return failure.seconds !== undefined ? fail('rate-limited', pickerWaitText(startWait(failure.seconds))) : fail('unavailable', LIST_TEXT.unavailable);
      }
      if (adopt(s.csrf)) return; // a new generation: the list went with the old one
      const answer = await issuing.listIssued(target, cursor, s.csrf, controller.signal);
      if (stale()) return;
      if (answer.kind === 'ok') {
        const before = listRef.current;
        // A page only continues the rows shown when none of its invoices or source drafts is shown already or comes twice in
        // it, and its numbers stay strictly below the last one shown (the client checks one page alone). Anything else is a
        // malformed answer: nothing joins and the cursor stays — the list is unavailable (rows kept as last known; Try again
        // reads page one).
        if (mode === 'more') {
          const ids = new Set(before.rows.map((row) => row.id));
          const sources = new Set(before.rows.map((row) => row.sourceDraftId));
          let last = before.rows.length === 0 ? Number.POSITIVE_INFINITY : before.rows[before.rows.length - 1].number;
          const joins = answer.invoices.every((row) => {
            const ok = !ids.has(row.id) && !sources.has(row.sourceDraftId) && row.number < last;
            ids.add(row.id);
            sources.add(row.sourceDraftId);
            last = row.number;
            return ok;
          });
          if (!joins) return fail('unavailable', LIST_TEXT.unavailable);
        }
        // The last page takes Load more away: focus still on it goes to the first row this page brought (else the heading).
        const first = mode === 'more' && answer.nextCursor === null ? answer.invoices[0] : undefined;
        if (first !== undefined && loadMore.current !== null && document.activeElement === loadMore.current) {
          keepFocus.current = { from: loadMore.current, inPanel: false, to: () => document.getElementById(issuedOpenIdOf(first.id)) };
        }
        return putList({
          gen: mine, storeId: target, phase: 'ready', text: '', rows: mode === 'more' ? [...before.rows, ...answer.invoices] : answer.invoices, next: answer.nextCursor, note: mode === 'more' ? '' : before.note,
        });
      }
      // A continuation that no longer names an invoice of this store: ONE reload from page one (which has no cursor).
      if (answer.kind === 'bad-cursor') return mode === 'more' ? void readList('first', LIST_TEXT.reloaded) : fail('unavailable', LIST_TEXT.unavailable);
      if (answer.kind === 'signed-out') return failSession({ kind: 'signed-out', text: ISSUED_TEXT.ended });
      if (answer.kind === 'denied') {
        // The server refused this store's list: nothing read before stays on screen, whatever the one fresh check says next.
        putList({ ...listOf(mine, target), phase: 'loading', text: LIST_TEXT.loading });
        const verdict = await denialOf(stale);
        if (verdict === null) return;
        if (verdict === 'denied') creditDenied('other', true, target, gen.current.csrf); // a confirmed same-token denial: owner-only names and lookup rows go (doc 17 §3.6 rule 4)
        if (verdict === 'denied') return putList({ ...listOf(mine, target), phase: 'denied', text: LIST_TEXT.denied });
        return fail(verdict.kind === 'rate-limited' ? 'rate-limited' : 'unavailable', verdict.kind === 'rate-limited' ? verdict.text : LIST_TEXT.unavailable);
      }
      if (answer.kind === 'rate-limited') return fail('rate-limited', pickerWaitText(startWait(answer.retryAfterSeconds)));
      fail('unavailable', LIST_TEXT.unavailable);
    } finally {
      giveBusy(token);
    }
  }

  // ---- one issued invoice ----

  /** Open: the dialog reads the invoice itself; a new open replaces nothing (the page behind is inert while it is up). */
  function openView(row: IssuedSummary): void {
    if (viewRef.current !== null || listRef.current.storeId !== storeRef.current) return;
    const store = storesRef.current.stores.find((entry) => entry.id === storeRef.current) ?? null;
    const next: ViewOpen = { id: ++viewSeq.current, storeId: storeRef.current, invoiceId: row.id, store };
    viewRef.current = next;
    setViewState(next);
  }

  /**
   * The dialog's read, under this section's session: ONE session check, the invoice under that token, a 401 that ends the
   * session, a 403's one fresh check, a 429's wait (during a wait nothing is sent). Null when the context that asked is
   * gone — another generation, another store, a sign-out since, the dialog's open (`viewId`: reopening the same invoice is
   * another open) closed or replaced, or its read cancelled — before any of its answers does anything.
   */
  async function readView(viewId: number, storeId: string, invoiceId: string, signal: AbortSignal): Promise<IssuedReadAnswer | null> {
    if (waitRef.current) return { kind: 'rate-limited', text: pickerWaitText(waitLeft()) };
    const mine = gen.current.n;
    const since = sessionEndsSoFar();
    const stale = (): boolean => !alive.current || signal.aborted || mine !== gen.current.n || storeId !== storeRef.current || since !== sessionEndsSoFar()
      || viewRef.current?.id !== viewId || viewRef.current.storeId !== storeId || viewRef.current.invoiceId !== invoiceId;
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
    if (answer.kind === 'signed-out') { failSession({ kind: 'signed-out', text: ISSUED_TEXT.ended }); return null; }
    if (answer.kind === 'denied') {
      const verdict = await viewDenialOf(viewId, stale);
      if (verdict === null) return null;
      if (verdict === 'denied') creditDenied('other', true, storeId, gen.current.csrf); // doc 17 §3.6 rule 4
      return verdict === 'denied' ? { kind: 'denied' } : verdict.kind === 'rate-limited' ? { kind: 'rate-limited', text: verdict.text } : { kind: 'unavailable' };
    }
    if (answer.kind === 'rate-limited') return { kind: 'rate-limited', text: pickerWaitText(startWait(answer.retryAfterSeconds)) };
    return { kind: 'unavailable' };
  }

  /**
   * The dialog's payments read (M7B-PAYMENTS-P2A): one page under readView's own context and session work — the check, a
   * 401 that ends the session, a 403's one fresh check (shared with the open's other reads), a 429's wait (during a wait
   * nothing is sent). Null when the context that asked is gone.
   */
  async function readPayments(viewId: number, storeId: string, invoiceId: string, after: string | null, signal: AbortSignal): Promise<PaymentsReadAnswer | null> {
    if (waitRef.current) return { kind: 'rate-limited', text: pickerWaitText(waitLeft()) };
    const mine = gen.current.n;
    const since = sessionEndsSoFar();
    const stale = (): boolean => !alive.current || signal.aborted || mine !== gen.current.n || storeId !== storeRef.current || since !== sessionEndsSoFar()
      || viewRef.current?.id !== viewId || viewRef.current.storeId !== storeId || viewRef.current.invoiceId !== invoiceId;
    const s = await connect();
    if (stale()) return null;
    if (s.kind !== 'ok') {
      const failure = sessionFailure(s);
      if (failure.kind === 'signed-out') { failSession(failure); return null; }
      return failure.seconds !== undefined ? { kind: 'rate-limited', text: pickerWaitText(startWait(failure.seconds)) } : { kind: 'unavailable' };
    }
    if (adopt(s.csrf)) return null; // a new generation closed the dialog
    const answer = await issuing.getPayments(storeId, invoiceId, after, s.csrf, signal);
    if (stale()) return null;
    if (answer.kind === 'ok' || answer.kind === 'not-found') return answer;
    if (answer.kind === 'signed-out') { failSession({ kind: 'signed-out', text: ISSUED_TEXT.ended }); return null; }
    if (answer.kind === 'denied') {
      const verdict = await viewDenialOf(viewId, stale);
      if (verdict === null) return null;
      if (verdict === 'denied') creditDenied('other', true, storeId, gen.current.csrf); // doc 17 §3.6 rule 4
      return verdict === 'denied' ? { kind: 'denied' } : verdict.kind === 'rate-limited' ? { kind: 'rate-limited', text: verdict.text } : { kind: 'unavailable' };
    }
    if (answer.kind === 'rate-limited') return { kind: 'rate-limited', text: pickerWaitText(startWait(answer.retryAfterSeconds)) };
    return { kind: 'unavailable' };
  }

  // ---- voiding an issued invoice (M7B-INVOICES-VOID-P2) ----

  /**
   * The dialog's action-only eligibility read (design R14), under the dialog read's context: 'allowed' only for the
   * server's exact allowed; every other answer is 'not' (the dialog then shows nothing but its reserved row) — a 401 ends
   * the session, a 429 starts the section's wait, and a 403 gets the reads' ONE fresh check at most once per open. During a
   * wait nothing is sent. Null when the context that asked is gone.
   */
  async function readVoidEligibility(viewId: number, storeId: string, invoiceId: string, signal: AbortSignal): Promise<'allowed' | 'not' | null> {
    if (waitRef.current) return 'not';
    const mine = gen.current.n;
    const since = sessionEndsSoFar();
    const stale = (): boolean => !alive.current || signal.aborted || mine !== gen.current.n || storeId !== storeRef.current || since !== sessionEndsSoFar()
      || viewRef.current?.id !== viewId || viewRef.current.storeId !== storeId || viewRef.current.invoiceId !== invoiceId;
    const s = await connect();
    if (stale()) return null;
    if (s.kind !== 'ok') {
      const failure = sessionFailure(s);
      if (failure.kind === 'signed-out') { failSession(failure); return null; }
      if (failure.seconds !== undefined) startWait(failure.seconds);
      return 'not';
    }
    if (adopt(s.csrf)) return null; // a new generation closed the dialog
    const answer = await issuing.voidEligibility(storeId, invoiceId, s.csrf, signal);
    if (stale()) return null;
    if (answer.kind === 'allowed') return 'allowed';
    if (answer.kind === 'signed-out') { failSession({ kind: 'signed-out', text: ISSUED_TEXT.ended }); return null; }
    if (answer.kind === 'rate-limited') { startWait(answer.retryAfterSeconds); return 'not'; }
    if (answer.kind === 'denied' && !eligChecked.current.has(viewId)) {
      eligChecked.current.add(viewId);
      return (await viewDenialOf(viewId, stale)) === null ? null : 'not';
    }
    return 'not';
  }

  /**
   * One press of a confirmation's "Void invoice": ONE POST under ONE new key (design §4 "The press"). A ref holds a second
   * activation back; after the session check the context is checked again — the same generation, store, dialog and
   * invoice, the confirmation still open, its eligibility, no live void attempt of this user — then the body is built ONCE
   * (the store's own tenant from the server's store list, R2) and validated, the key minted, and the attempt held BEFORE
   * the request leaves. The POST has no signal: closing a dialog never cancels it. Null when nothing was sent and the
   * context that pressed is gone (another generation, a session end — they close the dialog themselves).
   */
  async function sendVoid(viewId: number, store: StoreEntry, press: VoidPress): Promise<VoidSendOutcome | null> {
    const notSent = (text: string): VoidSendOutcome => ({ kind: 'not-sent', text });
    // Never a silent no-op (review B1 L3): an earlier send still out, the void's sign-in out (L2), a wait, a live attempt,
    // or this invoice already known voided by an attempt of this user (F1) — each said, nothing sent.
    if (voidSending.current) return notSent(VOID_TEXT.pending);
    if (signingIn.current !== null) return notSent(VOID_TEXT.signingIn);
    if (press.reviewGen !== gen.current.n) return { kind: 'stale' }; // reviewed under a replaced session (R2-1c)
    if (waitRef.current) return notSent(`Not sent. ${pickerWaitText(waitLeft())}`);
    if (isLiveVoid(holds.get(uid))) return notSent(VOID_TEXT.pending);
    const voidedHere = (): boolean => { const h = holds.get(uid); return voidedBy(h) && h.storeId === store.id && h.invoiceId === press.invoiceId; };
    if (voidedHere()) return notSent(VOID_TEXT.alreadyVoided);
    // R8 (review F3): never a void of an invoice while a reversal of one of its payments is unresolved.
    const reversingHere = (): boolean => { const r = revHolds.get(uid); return (isLiveReversal(r) && r.storeId === store.id && r.invoiceId === press.invoiceId) || withdrawingHere(store.id, press.invoiceId); };
    if (reversingHere()) return notSent(REVERSE_TEXT.pending);
    voidSending.current = true; // a ref: a second activation in the same task sends nothing
    try {
      const mine = gen.current.n;
      const since = sessionEndsSoFar();
      const viewStands = (): boolean => alive.current && viewRef.current?.id === viewId && viewRef.current.invoiceId === press.invoiceId && storeRef.current === store.id;
      const s = await connect();
      if (!viewStands() || since !== sessionEndsSoFar()) return null;
      if (s.kind !== 'ok') {
        const failure = sessionFailure(s);
        if (failure.kind === 'signed-out') { failSession(failure); return null; }
        return notSent(`Not sent. ${failure.seconds !== undefined ? pickerWaitText(startWait(failure.seconds)) : ISSUED_TEXT.unavailable}`);
      }
      if (adopt(s.csrf) || gen.current.n !== mine) return null; // another session: its new generation closed the dialog
      if (press.reviewGen !== gen.current.n) return { kind: 'stale' }; // the final guard: never a key for a stale review (R2-1c)
      if (!press.open()) return null; // Keep invoice or Escape while the session was checked: nothing is sent
      if (waitRef.current) return notSent(`Not sent. ${pickerWaitText(waitLeft())}`);
      if (!press.allowed()) return notSent(VOID_TEXT.noLongerAllowed);
      if (signingIn.current !== null) return notSent(VOID_TEXT.signingIn);
      if (isLiveVoid(holds.get(uid))) return notSent(VOID_TEXT.pending);
      if (voidedHere()) return notSent(VOID_TEXT.alreadyVoided); // settled voided meanwhile (F1): never a second key for it
      if (reversingHere()) return notSent(REVERSE_TEXT.pending);
      const body = voidBodyOf(store.tenantId, press.reasonCode);
      if (body === null || !isVoidTarget(press.invoiceId)) return notSent(VOID_TEXT.notSendable); // nothing held for what cannot go (R1)
      const key = nextKey();
      const attempt: HeldVoid = {
        key, body, storeId: store.id, storeLabel: storeLabel(store), invoiceId: press.invoiceId, number: press.number, csrf: s.csrf,
        sentAt: clock(), sentWall: wall(), state: 'sending', note: '', refusal: null, seen: null, seenReason: null, retryable: true,
      };
      if (!holds.put(uid, attempt)) return notSent(VOID_TEXT.pending); // HELD BEFORE IT LEAVES
      setVoidCheck(null);
      press.held(key);
      const answer = await issuing.voidInvoice(attempt.storeId, attempt.invoiceId, key, body, s.csrf); // NO AbortSignal
      return await answerVoid(key, answer, true, { csrf: s.csrf, since, mine }, { open: press.open, stale: () => !viewStands() });
    } finally {
      voidSending.current = false;
    }
  }

  /**
   * One void answer: settled BY KEY in the hold (settleVoid: a token or sign-out change since it was sent detaches it,
   * a settled attempt is final), then what the section does about it — only while the session it was sent with still
   * stands: a 429 starts the section's wait, a 401 ends the session (R22; after the settle, so a closed confirmation's
   * attempt keeps its refusal), a first send's 403 gets the one fresh check BEFORE it is settled, an in-progress answer
   * holds Check again a moment. A validated 200 re-reads page one and says so — only while the same generation and the
   * attempt's store are still chosen (R23), whether or not the dialog is open. `view`: the confirmation that pressed (a
   * first send); what it is to say comes back.
   */
  async function answerVoid(
    key: string, answer: VoidResult, first: boolean, sent: { readonly csrf: string; readonly since: number; readonly mine: number },
    view: { readonly open: () => boolean; readonly stale: () => boolean } | null,
  ): Promise<VoidSendOutcome | null> {
    // The same session AND generation (review B1 M3): a token that came back after another one never speaks for it.
    const same = (): boolean => alive.current && gen.current.n === sent.mine && gen.current.csrf === sent.csrf && sent.since === sessionEndsSoFar();
    const before = holds.get(uid);
    const wasVoided = before?.key === key && before.state === 'voided';
    let verdict: 'denied' | Failure | null = null;
    // The check's verdict counts whether or not the dialog is still there (a closed confirmation's card says it, iam 3).
    if (first && answer.kind === 'denied' && same()) verdict = await denialOf(() => false);
    if (verdict === 'denied' && alive.current) setVoidDenied(key);
    if (verdict === 'denied' && same()) creditDenied('other', true, before?.storeId, sent.csrf); // rule 4, only under the token the void carried (rule 1)
    settleVoid(holds, uid, key, answer, first, { csrf: sent.csrf, since: sent.since }, view?.open() ?? false);
    const h = holds.get(uid);
    if (answer.kind === 'rate-limited' && same()) startWait(answer.retryAfterSeconds);
    if (answer.kind === 'in-progress' && h?.key === key && alive.current) coolVoid(key);
    if (answer.kind === 'signed-out' && same()) failSession({ kind: 'signed-out', text: ISSUED_TEXT.ended });
    if (answer.kind === 'denied' && !first && same()) void denialOf(() => true); // the check's 403: its one fresh check (a new token detaches)
    // Only the answer that made the transition says it (a duplicate never re-announces), and only under the same generation
    // with the attempt's store chosen (R23). During a wait page one is owed: the list says so with its Try again, given
    // back when the wait has passed (review B1 F4) — never a read on its own.
    if (h?.key === key && h.state === 'voided' && !wasVoided && alive.current && gen.current.n === sent.mine && storeRef.current === h.storeId) {
      setNotice(VOID_TEXT.voided(h.number));
      const l = listRef.current;
      if (!waitRef.current) void readList('first');
      else if (l.storeId === h.storeId) {
        // Owed: a list read still out (asked before the void) is cancelled and its answer stale, so no older snapshot can
        // replace this — only the user's page-one read after the wait does (review B1 R2-3).
        ctl.current.list?.abort();
        seq.current.list += 1;
        busyBy.current += 1;
        setBusy(false);
        putList({ ...l, phase: 'rate-limited', text: pickerWaitText(waitLeft()), note: '' });
      }
    }
    if (!first || view === null) return { kind: 'sent' };
    switch (answer.kind) {
      case 'not-sent': return { kind: 'not-sent', text: VOID_TEXT.notSendable }; // the client refused it: nothing left (only a defect gets here, R1)
      case 'step-up': return { kind: 'step-up', method: identity.reauthMethod(uid) };
      case 'rate-limited': return { kind: 'rate-limited', text: VOID_TEXT.rateLimited };
      case 'signed-out': return null;
      case 'denied':
        if (view.stale()) return null;
        if (verdict === 'denied') return { kind: 'denied', text: VOID_TEXT.noLongerAllowed, gone: true };
        if (verdict === null) return { kind: 'denied', text: VOID_TEXT.refusedPlain, gone: false }; // no check confirmed it
        return { kind: 'denied', text: verdict.kind === 'rate-limited' ? `Not voided: ${verdict.text}` : VOID_TEXT.refusedUnchecked, gone: false };
      default: return { kind: 'sent' };
    }
  }

  /**
   * "Check again": the SAME key and bytes to the attempt's own store and invoice, under the token it was sent with — only on
   * the user's press, never while detached, withdrawn (retryable), past the cutoff (judged before the session check and
   * again just before it leaves) or in the moment after an in-progress answer. A different current token detaches it (R12).
   * Every path ends unresolved or settled: an attached attempt is never left checking.
   */
  async function checkVoid(): Promise<void> {
    const h = holds.get(uid);
    if (h === undefined || h.state !== 'unresolved' || !h.retryable || h.csrf === null || voidChecking.current !== null || waitRef.current || voidCoolRef.current === h.key) return;
    if (signingIn.current !== null) return void setVoidCheck({ key: h.key, text: VOID_TEXT.signingIn }); // L2: nothing sent beside the sign-in
    if (h.body === '' || voidExpired(h, clock(), wall())) { if (h.body !== '') holds.change(uid, h.key, { body: '' }); return; }
    const { key, csrf } = h;
    voidChecking.current = key;
    const since = sessionEndsSoFar();
    const mine = gen.current.n;
    // A check starts afresh (review B1 L4): an earlier Check invoice failure, and an "issued" observation that may be out of
    // date, go; a "voided" one stays (it is terminal).
    setVoidCheck(null);
    holds.change(uid, key, h.seen === 'issued' ? { state: 'checking', note: '', seen: null, seenReason: null } : { state: 'checking', note: '' });
    let settled = false;
    const leave = (note: string): void => { settled = true; holds.change(uid, key, { state: 'unresolved', note }); };
    try {
      const s = await connect();
      const now = holds.get(uid);
      if (now?.key !== key || now.csrf === null || since !== sessionEndsSoFar() || !alive.current) return;
      if (s.kind !== 'ok') {
        const failure = sessionFailure(s);
        if (failure.kind === 'signed-out') { leave(VOID_NOTE_TEXT.signedOut); return failSession(failure); }
        if (failure.seconds !== undefined) startWait(failure.seconds);
        return leave(failure.seconds !== undefined ? VOID_NOTE_TEXT.rateLimited(failure.seconds) : VOID_NOTE_TEXT.noAnswer);
      }
      if (adopt(s.csrf)) return; // another token: its new generation detached the attempt
      if (s.csrf !== csrf) { holds.detach(uid); return; }
      if (voidExpired(h, clock(), wall())) { settled = true; holds.change(uid, key, { state: 'unresolved', body: '' }); return; } // judged again, just before it leaves
      const answer = await issuing.voidInvoice(h.storeId, h.invoiceId, key, h.body, csrf);
      settled = true;
      await answerVoid(key, answer, false, { csrf, since, mine }, null);
    } finally {
      if (voidChecking.current === key) voidChecking.current = null;
      const now = holds.get(uid);
      if (!settled && now?.key === key && now.state === 'checking' && now.csrf !== null) holds.change(uid, key, { state: 'unresolved', note: '' });
    }
  }

  /**
   * "Check invoice": ONE ordinary GET of the attempt's own store and invoice under the CURRENT session — never another void
   * attempt, and it settles nothing: what it shows is the invoice's state now (`seen`, and the reason it records), never which
   * request caused it. A failure says only that the check failed.
   */
  async function findVoid(): Promise<void> {
    const h = holds.get(uid);
    if (h === undefined || voidReading.current !== null || waitRef.current) return;
    const { key } = h;
    voidReading.current = key;
    setVoidFinding(key);
    setVoidCheck(null);
    let n = ++seq.current.find;
    ctl.current.find?.abort();
    let controller = new AbortController();
    ctl.current.find = controller;
    let mine = gen.current.n;
    const since = sessionEndsSoFar();
    const stale = (): boolean => !alive.current || n !== seq.current.find || mine !== gen.current.n || since !== sessionEndsSoFar() || holds.get(uid)?.key !== key;
    const say = (text: string): void => setVoidCheck({ key, text });
    try {
      const s = await connect();
      if (stale()) return;
      if (s.kind !== 'ok') {
        const failure = sessionFailure(s);
        if (failure.kind === 'signed-out') return failSession(failure);
        return say(failure.seconds !== undefined ? pickerWaitText(startWait(failure.seconds)) : VOID_TEXT.checkFailed);
      }
      if (adopt(s.csrf)) {
        // Another token: its new generation detached the attempt; this read goes on under it — a new authorized read of the
        // invoice's state, never a rebinding of the request (review B1 iam 2).
        mine = gen.current.n;
        n = ++seq.current.find;
        controller = new AbortController();
        ctl.current.find = controller;
      }
      const answer = await issuing.getIssued(h.storeId, h.invoiceId, s.csrf, controller.signal);
      if (stale()) return;
      if (answer.kind === 'ok') {
        if (answer.invoice.id !== h.invoiceId) return say(VOID_TEXT.checkFailed);
        holds.change(uid, key, { seen: answer.invoice.status, seenReason: answer.invoice.void?.reasonCode ?? null });
        return;
      }
      if (answer.kind === 'signed-out') return failSession({ kind: 'signed-out', text: ISSUED_TEXT.ended });
      if (answer.kind === 'not-found') return say(VOID_TEXT.checkMissing);
      if (answer.kind === 'denied') {
        const verdict = await denialOf(stale);
        if (verdict === null) return;
        if (verdict === 'denied') creditDenied('other', true, h.storeId, gen.current.csrf); // rule 4: a confirmed same-token denial in the section
        return say(verdict === 'denied' ? VOID_TEXT.checkDenied : verdict.kind === 'rate-limited' ? verdict.text : VOID_TEXT.checkFailed);
      }
      if (answer.kind === 'rate-limited') return say(pickerWaitText(startWait(answer.retryAfterSeconds)));
      say(VOID_TEXT.checkFailed);
    } finally {
      if (voidReading.current === key) voidReading.current = null;
      if (alive.current) setVoidFinding((was) => (was === key ? null : was));
    }
  }

  /** "Dismiss": stop tracking it here — never a cancel and never a resend. Not while an attached attempt is out (R8). */
  function dismissVoid(): void {
    const h = holds.get(uid);
    if (h === undefined || (h.csrf !== null && (h.state === 'sending' || h.state === 'checking')) || voidReading.current === h.key) return;
    heading.current?.focus(); // the card goes
    holds.remove(uid, h.key);
    setVoidCheck(null);
  }

  /**
   * The void's explicit sign-in after a first send's 403 step_up_required (nothing ran): the provider's re-authentication,
   * then the session's — its new token adopted WITHOUT closing the dialog (renewKeepingView, R11). The dialog re-reads and
   * asks for a new press itself; nothing is sent here. Null when the dialog's context went meanwhile.
   *
   * R1: one owner at a time, waited for at most VOID_SIGNIN_WAIT_MS from this press. Its deadline, Stop waiting, Keep
   * invoice, a close, a store or session change, or unmount ends the wait AT ONCE (releaseSignIn): the dialog gets its one
   * answer then. The provider's and the session's calls cannot be aborted; they run on, observed, and apply nothing once
   * this owner is gone — a session they renewed late is found by the next session check (adopt, then begin).
   */
  function signInForVoid(viewId: number, secret: string | null): Promise<VoidSignIn | null> {
    if (signingIn.current !== null || waitRef.current) return Promise.resolve(null);
    // A new try after the deadline may overlap the previous, uncancellable provider call (e.g. a Google popup the provider then cancels itself); its stale chain applies nothing here (owns()).
    return new Promise((answer) => {
      const t: VoidSignInOwner = { viewId, gen: gen.current.n, since: sessionEndsSoFar(), timer: null, answer };
      signingIn.current = t;
      setVoidSigning(true);
      t.timer = setTimeout(() => releaseSignIn(t, { kind: 'failed', text: VOID_TEXT.signInTimedOut }), VOID_SIGNIN_WAIT_MS);
      runSignIn(t, secret).catch(() => releaseSignIn(t, { kind: 'failed', text: VOID_TEXT.reauthFailed }));
    });
  }
  /** The sign-in's own chain: each step goes on only while `t` still owns it — never the session's renewal for a stopped wait. */
  async function runSignIn(t: VoidSignInOwner, secret: string | null): Promise<void> {
    const owns = (): boolean => alive.current && signingIn.current === t && viewRef.current?.id === t.viewId && t.since === sessionEndsSoFar() && t.gen === gen.current.n;
    let fresh: string | null;
    try { fresh = await identity.reauthenticate(uid, secret); } catch { fresh = null; }
    if (!owns()) return releaseSignIn(t, null);
    if (fresh === null) return releaseSignIn(t, { kind: 'failed', text: VOID_TEXT.reauthFailed });
    const renewed = await session.reauthenticate(uid, fresh);
    if (!owns()) return releaseSignIn(t, null);
    if (renewed.kind !== 'ok') {
      const failure = sessionFailure(renewed);
      if (failure.kind === 'signed-out') return failSession(failure); // its closeView ends the wait
      return releaseSignIn(t, { kind: 'failed', text: failure.seconds !== undefined ? `Not signed in: ${pickerWaitText(startWait(failure.seconds))}` : VOID_TEXT.reauthUnconfirmed });
    }
    renewKeepingView(renewed.csrf);
    stampSignIn(renewed.csrf);
    releaseSignIn(t, { kind: 'renewed', gen: gen.current.n });
  }
  /** End the wait for `t` with its one answer — only while `t` owns it: a released or older attempt never touches a newer one's. */
  function releaseSignIn(t: VoidSignInOwner, out: VoidSignIn | null): void {
    if (signingIn.current !== t) return;
    if (t.timer !== null) clearTimeout(t.timer);
    signingIn.current = null;
    if (alive.current) setVoidSigning(false);
    t.answer(out);
  }
  /** Stop waiting for the sign-in out — any (a close, a session change) or only the one of dialog open `viewId` (its Stop waiting, Keep invoice). */
  function dropSignIn(out: VoidSignIn | null, viewId?: number): void {
    const t = signingIn.current;
    if (t !== null && (viewId === undefined || t.viewId === viewId)) releaseSignIn(t, out);
  }

  // ---- reversing a payment (M7B-PAYMENTS-P2C) ----

  /** R8: any unresolved record, reversal or void attempt of this user, for any invoice — Reverse shows nowhere then. */
  const reverseBlockedNow = (): boolean => isLiveVoid(holds.get(uid)) || isLiveReversal(revHolds.get(uid)) || isOpenPayment(payHolds.get(uid));
  /** CN-P3: an unresolved withdrawal on this invoice holds back its other writes, as an unresolved reversal does — only there (R2). */
  function withdrawingHere(storeId: string, invoiceId: string): boolean { return isLiveWithdrawal(wdAt(storeId, invoiceId)); }

  /** The dialog's reversal eligibility (R1): 'allowed' only for the exact allowed; every other answer 'not'. */
  async function readReversalEligibility(viewId: number, storeId: string, invoiceId: string, signal: AbortSignal): Promise<'allowed' | 'not' | null> {
    if (waitRef.current) return 'not';
    const mine = gen.current.n;
    const since = sessionEndsSoFar();
    const stale = (): boolean => !alive.current || signal.aborted || mine !== gen.current.n || storeId !== storeRef.current || since !== sessionEndsSoFar()
      || viewRef.current?.id !== viewId || viewRef.current.storeId !== storeId || viewRef.current.invoiceId !== invoiceId;
    const csrf = await payConnect(() => !stale());
    if (csrf === null) return stale() ? null : 'not';
    if (adopt(csrf)) return null;
    const answer = await issuing.reversalEligibility(storeId, invoiceId, csrf, signal);
    if (stale()) return null;
    if (answer.kind === 'allowed') return 'allowed';
    if (answer.kind === 'signed-out') { failSession({ kind: 'signed-out', text: ISSUED_TEXT.ended }); return null; }
    if (answer.kind === 'rate-limited') startWait(answer.retryAfterSeconds);
    return 'not';
  }

  /**
   * R7: the exact payment, read-only — the history from its start following nextCursor, each page decoded and validated by
   * the client and joined by paymentsJoin, all under one generation, store and invoice (`stands`). At most
   * REVERSAL_LOOKUP_PAGE_CAP pages. Found: that row as read; `missing` only after a complete traversal; anything else
   * (a refusal, a failure, the cap, a stale context mid-way) `unconfirmed`. Null when the context that asked is gone.
   */
  async function findReversalPayment(storeId: string, invoiceId: string, paymentId: string, stands: () => boolean, signal: AbortSignal): Promise<PaymentFind | null> {
    const unconfirmed: PaymentFind = { kind: 'unconfirmed' };
    if (waitRef.current) return unconfirmed;
    const mine = gen.current.n;
    const since = sessionEndsSoFar();
    const stale = (): boolean => !alive.current || signal.aborted || !stands() || mine !== gen.current.n || since !== sessionEndsSoFar() || storeRef.current !== storeId;
    const csrf = await payConnect(() => !stale());
    if (csrf === null) return stale() ? null : unconfirmed;
    if (adopt(csrf)) return null;
    let joined: PaymentsView | null = null;
    let after: string | null = null;
    for (let n = 0; n < REVERSAL_LOOKUP_PAGE_CAP; n += 1) {
      const answer = await issuing.getPayments(storeId, invoiceId, after, csrf, signal);
      if (stale()) return null;
      if (answer.kind === 'signed-out') { failSession({ kind: 'signed-out', text: ISSUED_TEXT.ended }); return null; }
      if (answer.kind === 'rate-limited') { startWait(answer.retryAfterSeconds); return unconfirmed; }
      if (answer.kind !== 'ok' || answer.page.invoice.id !== invoiceId) return unconfirmed;
      const { page } = answer;
      if (joined !== null && !paymentsJoin(joined, page)) return unconfirmed;
      joined = { phase: 'ready', text: '', page, rows: [...(joined?.rows ?? []), ...page.payments], next: page.nextCursor, more: false };
      const hit = page.payments.find((p) => p.id === paymentId);
      if (hit !== undefined) return { kind: 'found', payment: hit, status: page.invoice.status };
      if (page.nextCursor === null) return { kind: 'missing' };
      after = page.nextCursor;
    }
    return unconfirmed; // the cap: never a guess past it
  }

  /**
   * One press of the confirmation's "Reverse payment" (R4): ONE POST under ONE new key, held BEFORE it leaves. The guards
   * run before and again after the session check: the review's generation, the confirmation open on the same payment, its
   * eligibility, no wait, no sign-in out, no live attempt of this user (R8). No AbortSignal: closing never cancels it.
   */
  async function sendReversal(viewId: number, store: StoreEntry, press: ReversePress): Promise<ReverseSendOutcome | null> {
    const notSent = (text: string): ReverseSendOutcome => ({ kind: 'not-sent', text });
    if (revSending.current) return notSent(REVERSE_TEXT.pending);
    if (signingIn.current !== null) return notSent(REVERSE_TEXT.signingIn);
    if (press.reviewGen !== gen.current.n) return { kind: 'stale' };
    if (waitRef.current) return notSent(`Not sent. ${pickerWaitText(waitLeft())}`);
    if (reverseBlockedNow() || withdrawingHere(store.id, press.invoiceId)) return notSent(REVERSE_TEXT.pending);
    revSending.current = true;
    try {
      const mine = gen.current.n;
      const since = sessionEndsSoFar();
      const viewStands = (): boolean => alive.current && viewRef.current?.id === viewId && viewRef.current.invoiceId === press.invoiceId && storeRef.current === store.id;
      const s = await connect();
      if (!viewStands() || since !== sessionEndsSoFar()) return null;
      if (s.kind !== 'ok') {
        const failure = sessionFailure(s);
        if (failure.kind === 'signed-out') { failSession(failure); return null; }
        return notSent(`Not sent. ${failure.seconds !== undefined ? pickerWaitText(startWait(failure.seconds)) : ISSUED_TEXT.unavailable}`);
      }
      if (adopt(s.csrf) || gen.current.n !== mine) return null;
      if (press.reviewGen !== gen.current.n) return { kind: 'stale' };
      if (!press.open()) return null;
      if (waitRef.current) return notSent(`Not sent. ${pickerWaitText(waitLeft())}`);
      if (!press.allowed()) return notSent(REVERSE_TEXT.noLongerAllowed);
      if (signingIn.current !== null) return notSent(REVERSE_TEXT.signingIn);
      if (reverseBlockedNow() || withdrawingHere(store.id, press.invoiceId)) return notSent(REVERSE_TEXT.pending);
      const body = reverseBodyOf(store.tenantId, press.reasonCode);
      if (body === null || !isVoidTarget(press.invoiceId) || !isVoidTarget(press.payment.id)) return notSent(REVERSE_TEXT.notSendable);
      const key = nextKey();
      const attempt: HeldReversal = {
        key, body, storeId: store.id, storeLabel: storeLabel(store), invoiceId: press.invoiceId, number: press.number, paymentId: press.payment.id,
        amountCents: press.payment.amountCents, reasonCode: press.reasonCode, csrf: s.csrf, sentAt: clock(), sentWall: wall(), state: 'sending',
        note: '', refusal: null, attributed: false, seen: null, retryable: true,
      };
      if (!revHolds.put(uid, attempt)) return notSent(REVERSE_TEXT.pending); // HELD BEFORE IT LEAVES
      setRevCheck(null);
      press.held(key);
      const answer = await issuing.reversePayment(attempt.storeId, attempt.invoiceId, attempt.paymentId, key, body, s.csrf); // NO AbortSignal
      return answerReversal(key, answer, true, { csrf: s.csrf, since, mine }, press.open);
    } finally {
      revSending.current = false;
    }
  }

  /**
   * One reversal answer (R6): settled BY KEY (settleReversal), then — only while the session it went with stands — a 429
   * starts the wait (and cools Retry for its Retry-After), a 401 ends the session; an in-progress cools Retry 5 s; a resend's
   * invalid-state runs Check payment (only the exact row can say reversed). A first send's outcome comes back to say.
   */
  function answerReversal(
    key: string, answer: ReverseResult, first: boolean, sent: { readonly csrf: string; readonly since: number; readonly mine: number }, open: (() => boolean) | null,
  ): ReverseSendOutcome | null {
    const same = (): boolean => alive.current && gen.current.n === sent.mine && gen.current.csrf === sent.csrf && sent.since === sessionEndsSoFar();
    settleReversal(revHolds, uid, key, answer, first, { csrf: sent.csrf, since: sent.since }, open?.() ?? false);
    const h = revHolds.get(uid);
    const ours = h?.key === key && alive.current;
    if (answer.kind === 'rate-limited' && same()) startWait(answer.retryAfterSeconds);
    if (answer.kind === 'rate-limited' && !first && ours) coolReversal(key, answer.retryAfterSeconds * 1000);
    if (answer.kind === 'in-progress' && ours) coolReversal(key, IN_PROGRESS_WAIT_MS);
    if (answer.kind === 'signed-out' && same()) failSession({ kind: 'signed-out', text: ISSUED_TEXT.ended });
    if (!first && answer.kind === 'invalid-state' && ours && h.state === 'unresolved' && same()) queueMicrotask(() => { void findReversal(); });
    if (!first || open === null) return { kind: 'sent' };
    // What settleReversal did decides, not the answer's kind: one left live (detached mid-flight) is the card's (review F6).
    if (ours && isLiveReversal(h)) return { kind: 'sent' };
    switch (answer.kind) {
      case 'not-sent': return { kind: 'not-sent', text: REVERSE_TEXT.notSendable };
      case 'step-up': return { kind: 'step-up', method: identity.reauthMethod(uid) };
      case 'signed-out': return null;
      case 'rate-limited': return { kind: 'not-run', text: REVERSE_TEXT.rateLimited(answer.retryAfterSeconds) };
      case 'denied': return { kind: 'not-run', text: REVERSE_TEXT.denied };
      case 'not-found': case 'tenant-conflict': case 'invalid': return { kind: 'not-run', text: REVERSE_TEXT.notRun };
      case 'invalid-state': case 'write-conflict': return { kind: 'refused' };
      default: return { kind: 'sent' };
    }
  }

  /** "Retry reversal": the SAME key and bytes under the token it was sent with — attached, retryable, not cooling, in time. */
  async function retryReversal(): Promise<void> {
    const h = revHolds.get(uid);
    if (h === undefined || h.state !== 'unresolved' || !h.retryable || h.csrf === null || revChecking.current !== null || revReading.current !== null
      || waitRef.current || revCoolRef.current === h.key) return;
    if (signingIn.current !== null) return void setRevCheck({ key: h.key, text: REVERSE_TEXT.signingIn });
    if (h.body === '' || reversalExpired(h, clock(), wall())) { if (h.body !== '') revHolds.change(uid, h.key, { body: '' }); return; }
    const { key, csrf } = h;
    revChecking.current = key;
    const since = sessionEndsSoFar();
    const mine = gen.current.n;
    setRevCheck(null);
    revHolds.change(uid, key, { state: 'checking', note: '' });
    let settled = false;
    const leave = (note: string): void => { settled = true; revHolds.change(uid, key, { state: 'unresolved', note }); };
    try {
      const s = await connect();
      const now = revHolds.get(uid);
      if (now?.key !== key || now.csrf === null || since !== sessionEndsSoFar() || !alive.current) return;
      if (s.kind !== 'ok') {
        const failure = sessionFailure(s);
        if (failure.kind === 'signed-out') { leave(VOID_NOTE_TEXT.signedOut); return failSession(failure); }
        if (failure.seconds !== undefined) startWait(failure.seconds);
        return leave(failure.seconds !== undefined ? VOID_NOTE_TEXT.rateLimited(failure.seconds) : VOID_NOTE_TEXT.noAnswer);
      }
      if (adopt(s.csrf)) return;
      if (s.csrf !== csrf) { detachRev(); return; }
      if (reversalExpired(h, clock(), wall())) { settled = true; revHolds.change(uid, key, { state: 'unresolved', body: '' }); return; }
      const answer = await issuing.reversePayment(h.storeId, h.invoiceId, h.paymentId, key, h.body, csrf);
      settled = true;
      answerReversal(key, answer, false, { csrf, since, mine }, null);
    } finally {
      if (revChecking.current === key) revChecking.current = null;
      const now = revHolds.get(uid);
      if (!settled && now?.key === key && now.state === 'checking') revHolds.change(uid, key, { state: 'unresolved', note: '' });
    }
  }

  /** "Check payment" (R7): read-only; only `found reversed` settles the attempt (not attributed) — the rest settle nothing. */
  async function findReversal(): Promise<void> {
    const h = revHolds.get(uid);
    if (h === undefined || !isLiveReversal(h) || (h.state === 'checking' && h.csrf !== null) || revReading.current !== null || waitRef.current) return;
    const { key } = h;
    // R8: the read's answer stands only under the generation, session and attached-state it began with (fix2 item 1).
    const attached = h.csrf !== null;
    const mine = gen.current.n;
    const since = sessionEndsSoFar();
    revReading.current = key;
    setRevFinding(key);
    setRevCheck(null);
    revFindCtl.current?.abort();
    const controller = new AbortController();
    revFindCtl.current = controller;
    try {
      const found = await findReversalPayment(h.storeId, h.invoiceId, h.paymentId, () => revHolds.get(uid)?.key === key, controller.signal);
      const now = revHolds.get(uid);
      // Begun attached, detached meanwhile: its answer is not used (FIX2 item 1), and the card says so (review-3 LOW-3).
      if (attached && now?.key === key && now.csrf === null) { if (alive.current) setRevCheck({ key, text: REVERSE_TEXT.checkDetached }); return; }
      if (found === null || mine !== gen.current.n || since !== sessionEndsSoFar()) return;
      seeReversal(revHolds, uid, key, found.kind !== 'found' ? 'unconfirmed' : found.payment.reversal !== null ? 'reversed' : 'not-reversed', attached);
    } finally {
      if (revReading.current === key) revReading.current = null;
      if (alive.current) setRevFinding((was) => (was === key ? null : was));
    }
  }

  /** "Dismiss": stop tracking it here — never a cancel and never a resend. Not while an attached attempt is out. */
  function dismissReversal(): void {
    const h = revHolds.get(uid);
    if (h === undefined || (h.csrf !== null && (h.state === 'sending' || h.state === 'checking')) || revReading.current === h.key) return;
    revHolds.remove(uid, h.key);
    setRevCheck(null);
  }

  // ---- withdrawing a credit note (M7B-CREDITNOTES-CN-P3; the reversal's model, without Retry) ----

  /**
   * The exact credit note, read-only: the invoice's list from page one following nextCursor (creditNotesFollow), all under
   * one generation, store and invoice (`stands`), at most REVERSAL_LOOKUP_PAGE_CAP pages. Found: that row as read; `missing`
   * only after a complete traversal; anything else `unconfirmed`. Null when the context that asked is gone.
   */
  async function findWithdrawalNote(storeId: string, invoiceId: string, creditNoteId: string, stands: () => boolean, signal: AbortSignal): Promise<WithdrawFind | null> {
    const unconfirmed: WithdrawFind = { kind: 'unconfirmed' };
    if (waitRef.current) return unconfirmed;
    const mine = gen.current.n;
    const since = sessionEndsSoFar();
    const stale = (): boolean => !alive.current || signal.aborted || !stands() || mine !== gen.current.n || since !== sessionEndsSoFar() || storeRef.current !== storeId;
    const csrf = await payConnect(() => !stale());
    if (csrf === null) return stale() ? null : unconfirmed;
    if (adopt(csrf)) return null;
    let named: boolean | null = null;
    let notes: readonly InvoiceCreditNote[] = [];
    let after: string | null = null;
    for (let n = 0; n < REVERSAL_LOOKUP_PAGE_CAP; n += 1) {
      const answer = await issuing.listCreditNotes(storeId, invoiceId, after, csrf, signal);
      if (stale()) return null;
      if (answer.kind === 'signed-out') { failSession({ kind: 'signed-out', text: ISSUED_TEXT.ended }); return null; }
      if (answer.kind === 'rate-limited') { startWait(answer.retryAfterSeconds); return unconfirmed; }
      if (answer.kind !== 'ok' || creditNotesFollow(named, notes, answer.page) !== 'follows') return unconfirmed;
      const { page } = answer;
      notes = [...notes, ...page.creditNotes];
      named = page.named ?? named;
      const hit = page.creditNotes.find((x) => x.id === creditNoteId);
      if (hit !== undefined) return { kind: 'found', note: hit };
      if (page.nextCursor === null) return { kind: 'missing' };
      after = page.nextCursor;
    }
    return unconfirmed; // the cap: never a guess past it
  }

  /**
   * One press of the confirmation's "Withdraw credit note": ONE POST under ONE new key, held BEFORE it leaves. The guards run
   * before and again after the session check: the review's generation, the confirmation open, no wait, no sign-in out, no
   * live attempt on this invoice, no credit-note attempt here. No AbortSignal: closing never cancels it.
   */
  async function sendWithdrawal(viewId: number, store: StoreEntry, press: WithdrawPress): Promise<ReverseSendOutcome | null> {
    const notSent = (text: string): ReverseSendOutcome => ({ kind: 'not-sent', text });
    const slot = wdSlot(store.id, press.invoiceId);
    if (wdSending.current.has(slot)) return notSent(WITHDRAW_TEXT.pending);
    if (signingIn.current !== null) return notSent(WITHDRAW_TEXT.signingIn);
    if (press.reviewGen !== gen.current.n) return { kind: 'stale' };
    if (waitRef.current) return notSent(`Not sent. ${pickerWaitText(waitLeft())}`);
    if (reverseBlockedNow() || press.blocked()) return notSent(WITHDRAW_TEXT.pending);
    wdSending.current.add(slot);
    try {
      const mine = gen.current.n;
      const since = sessionEndsSoFar();
      // The attempt's binding: this section, the same dialog on the same invoice, the same store (the hold binds user and token).
      const viewStands = (): boolean => alive.current && viewRef.current?.id === viewId && viewRef.current.invoiceId === press.invoiceId && storeRef.current === store.id;
      const s = await connect();
      if (!viewStands() || since !== sessionEndsSoFar()) return null;
      if (s.kind !== 'ok') {
        const failure = sessionFailure(s);
        if (failure.kind === 'signed-out') { failSession(failure); return null; }
        return notSent(`Not sent. ${failure.seconds !== undefined ? pickerWaitText(startWait(failure.seconds)) : ISSUED_TEXT.unavailable}`);
      }
      if (adopt(s.csrf) || gen.current.n !== mine) return null;
      if (press.reviewGen !== gen.current.n) return { kind: 'stale' };
      if (!press.open()) return null;
      if (waitRef.current) return notSent(`Not sent. ${pickerWaitText(waitLeft())}`);
      if (signingIn.current !== null) return notSent(WITHDRAW_TEXT.signingIn);
      if (reverseBlockedNow() || press.blocked()) return notSent(WITHDRAW_TEXT.pending);
      const body = creditNoteWithdrawBodyOf(store.tenantId, press.reason);
      if (body === null || !isVoidTarget(press.invoiceId) || !isVoidTarget(press.note.id)) return notSent(WITHDRAW_TEXT.notSendable);
      const key = nextKey();
      const attempt: HeldWithdrawal = {
        key, body: '', storeId: store.id, invoiceId: press.invoiceId, number: press.number, creditNoteId: press.note.id, creditNoteNumber: press.note.number,
        grossCents: press.note.grossCents, reason: press.reason, csrf: s.csrf, state: 'sending', refusal: null, attributed: false, seen: null,
      };
      if (!wdHolds.put(slot, attempt)) return notSent(WITHDRAW_TEXT.pending); // HELD BEFORE IT LEAVES
      press.held(key);
      const answer = await issuing.withdrawCreditNote(store.id, press.invoiceId, press.note.id, key, body, s.csrf); // NO AbortSignal
      return await answerWithdrawal(slot, key, answer, { csrf: s.csrf, since, mine }, viewStands, press.open);
    } finally {
      wdSending.current.delete(slot);
    }
  }

  /**
   * One withdrawal answer: settled BY KEY (settleWithdrawal: a changed token, sign-out count, store or invoice detaches it
   * and the answer is not used); then, only while the session it went with stands, a 429 starts the wait and a 401 ends
   * the session. A 403 is classified as the credit notes' are (CN-P2, cnDenial): step_up_required is the client's `step-up`
   * (the sign-in path); any other 403 gets creditDenial's one fresh same-token check BEFORE it is settled, and a confirmed
   * one is rule 4's (creditDenied). A first send's outcome comes back to the confirmation to say.
   */
  async function answerWithdrawal(
    slot: string, key: string, answer: WithdrawCreditNoteResult, sent: { readonly csrf: string; readonly since: number; readonly mine: number }, viewStands: () => boolean, open: () => boolean,
  ): Promise<ReverseSendOutcome | null> {
    const same = (): boolean => alive.current && gen.current.n === sent.mine && gen.current.csrf === sent.csrf && sent.since === sessionEndsSoFar();
    let verdict: 'denied' | 'gone' | Failure | null = null;
    // The check is asynchronous: the attempt's binding is asked again after it (a move to another invoice meanwhile is 'gone').
    if (answer.kind === 'denied' && viewStands() && same()) verdict = await creditDenial(sent.csrf, () => !viewStands());
    // Asked again before each step: a binding that no longer stands only detaches (no denial, no wait, nothing said).
    const before = wdHolds.get(slot);
    if (verdict === 'denied' && viewStands() && same() && before?.key === key && before.csrf === sent.csrf) {
      creditDenied('other', true, before.storeId, sent.csrf);
      if (alive.current) setWdDenied(key);
    }
    settleWithdrawal(wdHolds, slot, key, answer, { csrf: sent.csrf, since: sent.since }, viewStands() && same(), open());
    // A reply for a context that no longer stands (user, session, store or invoice) only detached the attempt: no wait, no
    // session end, nothing said.
    if (!viewStands() || !same()) return null;
    const h = wdHolds.get(slot);
    if (answer.kind === 'rate-limited') startWait(answer.retryAfterSeconds);
    if (answer.kind === 'signed-out') failSession({ kind: 'signed-out', text: ISSUED_TEXT.ended });
    if (h?.key === key && isLiveWithdrawal(h)) return { kind: 'sent' }; // unresolved: the card's
    switch (answer.kind) {
      case 'not-sent': return { kind: 'not-sent', text: WITHDRAW_TEXT.notSendable };
      case 'step-up': return { kind: 'step-up', method: identity.reauthMethod(uid) };
      case 'signed-out': return null;
      case 'rate-limited': return { kind: 'not-run', text: WITHDRAW_TEXT.rateLimited(answer.retryAfterSeconds) };
      case 'denied': return { kind: 'not-run', text: verdict === 'denied' ? WITHDRAW_TEXT.noLongerAllowed : WITHDRAW_TEXT.denied };
      case 'not-found': case 'tenant-conflict': case 'invalid': return { kind: 'not-run', text: WITHDRAW_TEXT.notRun };
      case 'invalid-state': case 'write-conflict': return { kind: 'refused' };
      default: return { kind: 'sent' };
    }
  }

  /** "Check credit note status": read-only; only a fresh read showing the note withdrawn settles it (not attributed). */
  async function findWithdrawal(slot: string): Promise<void> {
    const h = wdHolds.get(slot);
    if (h === undefined || !isLiveWithdrawal(h) || (h.state === 'sending' && h.csrf !== null) || wdReading.current.has(slot) || waitRef.current) return;
    const { key } = h;
    const attached = h.csrf !== null;
    const mine = gen.current.n;
    const since = sessionEndsSoFar();
    wdReading.current.set(slot, key);
    setWdFinding((was) => new Set(was).add(key));
    dropWdCheck(key);
    const controller = new AbortController();
    wdFindCtl.current.set(slot, controller);
    try {
      // Within the attempt's own store and invoice, never the ones chosen now.
      const found = await findWithdrawalNote(h.storeId, h.invoiceId, h.creditNoteId, () => wdHolds.get(slot)?.key === key, controller.signal);
      const now = wdHolds.get(slot);
      if (attached && now?.key === key && now.csrf === null) { if (alive.current) setWdCheck((was) => ({ ...was, [key]: WITHDRAW_TEXT.checkDetached })); return; }
      if (found === null || mine !== gen.current.n || since !== sessionEndsSoFar()) return;
      seeWithdrawal(wdHolds, slot, key, found.kind !== 'found' ? 'unconfirmed' : found.note.withdrawal !== null ? 'withdrawn' : 'active', attached);
    } finally {
      if (wdReading.current.get(slot) === key) wdReading.current.delete(slot);
      if (wdFindCtl.current.get(slot) === controller) wdFindCtl.current.delete(slot);
      if (alive.current) setWdFinding((was) => { if (!was.has(key)) return was; const next = new Set(was); next.delete(key); return next; });
    }
  }

  /**
   * "Dismiss": stop tracking it here — never a cancel and never a resend. Never for a LIVE attempt still attached to this
   * context (owner rule: a second withdrawal stays held back while it is unresolved here); only a settled or refused one, or
   * one detached by a change of session or store.
   */
  function dismissWithdrawal(slot: string): void {
    const h = wdHolds.get(slot);
    if (h === undefined || (isLiveWithdrawal(h) && h.csrf !== null) || wdReading.current.get(slot) === h.key) return;
    wdHolds.remove(slot, h.key);
    dropWdCheck(h.key);
  }

  // ---- the settings panel ----

  /**
   * One settings read for the open panel. `open`, `refresh` and `stopped` replace the form with what the server has; `keep`
   * (Load current version) moves only the version the kept edits are based on and shows what the server holds; `renewed`
   * (after an explicit sign-in) checks that the version the edits are based on still stands — another is a conflict.
   */
  async function readSettings(mode: 'open' | 'refresh' | 'stopped' | 'keep' | 'renewed'): Promise<void> {
    const p = panelRef.current;
    if (p === null) return;
    const { id } = p;
    const target = p.store.id;
    const replace = mode === 'open' || mode === 'refresh' || mode === 'stopped';
    // A read that replaces the form never starts while this panel's Save, Check again or sign-in is out.
    if (replace && (savingRef.current === id || checkingRef.current === id || confirmingRef.current === id)) return;
    if (waitRef.current) {
      const text = pickerWaitText(waitLeft());
      return void (replace ? patchPanel(id, { phase: 'rate-limited', text }) : patchPanel(id, { status: { tone: 'alert', text } }));
    }
    const mine = gen.current.n;
    const n = ++seq.current.settings;
    if (replace) replacing.current = n;
    // A replace read cancelled under a panel that stays (another read took over) gives the loaded form back: never "Loading" for good.
    const recover = (): void => {
      const q = panelRef.current;
      if (replace && alive.current && q !== null && q.id === id && q.phase === 'loading' && q.loaded !== null && replacing.current === n) patchPanel(id, { phase: 'ready', text: '' });
    };
    ctl.current.settings?.abort();
    const controller = new AbortController();
    ctl.current.settings = controller;
    const since = sessionEndsSoFar();
    const stale = (): boolean => !alive.current || mine !== gen.current.n || n !== seq.current.settings || panelRef.current?.id !== id
      || target !== storeRef.current || since !== sessionEndsSoFar();
    if (replace) patchPanel(id, { phase: 'loading', text: SETTINGS_TEXT.loading, status: mode === 'stopped' ? panelRef.current?.status ?? null : null });
    else patchPanel(id, { reading: true });
    const fail = (phase: SettingsPanel['phase'], text: string): void => {
      if (replace) patchPanel(id, { phase, text, loaded: null, reading: false });
      else patchPanel(id, { reading: false, status: { tone: 'alert', text: phase === 'unavailable' ? SETTINGS_TEXT.loadFailed : text } });
    };
    const s = await connect();
    if (stale()) return recover();
    if (s.kind !== 'ok') {
      const failure = sessionFailure(s);
      if (failure.kind === 'signed-out') return failSession(failure);
      return fail(failure.kind === 'rate-limited' ? 'rate-limited' : 'unavailable', failure.seconds !== undefined ? pickerWaitText(startWait(failure.seconds)) : SETTINGS_TEXT.unavailable);
    }
    if (adopt(s.csrf)) return; // a new generation: the panel went with the old one
    const answer = await issuing.getSettings(target, s.csrf, controller.signal);
    if (stale()) return recover();
    if (answer.kind === 'ok') {
      const read = answer.settings;
      if (replace) {
        return void patchPanel(id, {
          phase: 'ready', text: '', loaded: read, fields: fieldsOf(read), errors: null, conflict: false, serverNow: null, reading: false, saved: null, needsRead: false,
          status: mode === 'stopped' ? { tone: 'info', text: SETTINGS_TEXT.stopped } : null,
        });
      }
      // Only a read that answered clears what a sign-in left to check; a failed one keeps Save waiting for another.
      const base = panelRef.current?.loaded?.version ?? 0;
      if (mode === 'renewed' && read.version === base) return void patchPanel(id, { reading: false, needsRead: false, status: { tone: 'info', text: SETTINGS_TEXT.renewed } });
      if (mode === 'renewed') return void patchPanel(id, { reading: false, needsRead: false, conflict: true, status: { tone: 'alert', text: SETTINGS_TEXT.conflict } });
      return void patchPanel(id, { reading: false, needsRead: false, loaded: read, conflict: false, serverNow: read, status: { tone: 'info', text: SETTINGS_TEXT.loadedCurrent(read.version) } });
    }
    if (answer.kind === 'signed-out') return failSession({ kind: 'signed-out', text: ISSUED_TEXT.ended });
    if (answer.kind === 'denied') {
      const verdict = await denialOf(stale);
      if (verdict === null) return recover();
      if (verdict === 'denied') creditDenied('other', true, target, gen.current.csrf); // rule 4
      return verdict === 'denied' ? fail('denied', SETTINGS_TEXT.denied) : fail(verdict.kind === 'rate-limited' ? 'rate-limited' : 'unavailable', verdict.text);
    }
    if (answer.kind === 'not-found') return fail('not-found', SETTINGS_TEXT.notFound);
    if (answer.kind === 'rate-limited') return fail('rate-limited', pickerWaitText(startWait(answer.retryAfterSeconds)));
    fail('unavailable', SETTINGS_TEXT.unavailable);
  }

  /** "Issuing settings": open the panel for the chosen store (its one read), or close it while no attempt of it is live. */
  function toggleSettings(): void {
    const store = storesRef.current.stores.find((entry) => entry.id === storeRef.current);
    if (panelRef.current !== null) {
      if (panelRef.current.attempt !== null) return; // an attempt stays with its panel until it is settled or dropped
      dropPanel();
      return;
    }
    if (store === undefined) return;
    putPanel({
      id: ++panelSeq.current, store, phase: 'loading', text: SETTINGS_TEXT.loading, loaded: null, fields: EMPTY_FIELDS, errors: null, attempt: null, status: null,
      conflict: false, serverNow: null, reading: false, saved: null, stepUp: null, saving: false, confirming: false, needsRead: false,
    });
    setDetached(false);
    void readSettings('open');
  }

  function editField<K extends keyof IssuingSettingsFields>(field: K, value: IssuingSettingsFields[K]): void {
    const p = panelRef.current;
    // A held body is frozen: the form is locked from the Save press, and while an attempt is live.
    if (p === null || p.attempt !== null || p.saving || savingRef.current === p.id) return;
    // Editing a field clears its own error (choosing a tax mode, the rate's too).
    const errors: IssuingSettingsErrors | null = p.errors === null ? null : { ...p.errors, [field]: false, ...(field === 'taxMode' ? { rate: false } : {}) };
    putPanel({ ...p, fields: { ...p.fields, [field]: value }, errors });
  }

  /** Save: ONE PUT per press — validated, then the body, the key and the token frozen before it leaves. */
  async function save(): Promise<void> {
    const p = panelRef.current;
    if (p === null || p.phase !== 'ready' || p.loaded === null || p.store.readOnly || p.attempt !== null || p.conflict || p.reading || p.needsRead) return;
    // Never while a sign-in is asked for or out: only its own explicit Save follows it.
    if (p.saving || p.stepUp !== null || p.confirming) return;
    if (savingRef.current === p.id || checkingRef.current === p.id || confirmingRef.current === p.id || waitRef.current) return;
    const { id } = p;
    const built = issuingSettingsBody(p.store.tenantId, p.loaded.version, p.fields);
    if (built.kind === 'invalid') {
      patchPanel(id, { errors: built.errors, status: null });
      setFocusInvalid((x) => x + 1);
      return; // nothing is sent and no key is minted
    }
    savingRef.current = id;
    patchPanel(id, { saving: true }); // the form locks at the press: what it shows is what is sent
    const since = sessionEndsSoFar();
    try {
      const s = await connect();
      const here = (): boolean => alive.current && panelRef.current?.id === id && since === sessionEndsSoFar();
      if (!here()) return;
      if (s.kind !== 'ok') {
        const failure = sessionFailure(s);
        if (failure.kind === 'signed-out') return failSession(failure);
        const text = failure.seconds !== undefined ? pickerWaitText(startWait(failure.seconds)) : ISSUED_TEXT.unavailable;
        return void patchPanel(id, { status: { tone: 'alert', text: `Not sent: ${text}` } });
      }
      if (adopt(s.csrf)) return; // a new generation took the panel: nothing is sent under another token
      const key = nextKey();
      const attempt: SettingsAttempt = {
        key, body: built.body, values: built.values, base: p.loaded.version, storeId: p.store.id, sentAt: clock(), sentWall: wall(), state: 'sending', note: '',
      };
      if (!patchPanel(id, { attempt, errors: null, status: null, stepUp: null, serverNow: null })) return;
      attemptToken.current = { key, csrf: s.csrf };
      const answer = await issuing.saveSettings(attempt.storeId, attempt.body, key, s.csrf);
      settle(id, key, answer, true, s.csrf, since);
    } finally {
      if (savingRef.current === id) savingRef.current = null;
      if (alive.current) patchPanel(id, { saving: false });
    }
  }

  /** One write answer, by key against the panel's attempt: a first send's every refusal decides; a check only CHECK_DECIDES. */
  function settle(id: number, key: string, answer: SaveSettingsResult, first: boolean, csrf: string, since: number): void {
    const p = panelRef.current;
    if (!alive.current || p === null || p.id !== id || p.attempt?.key !== key) return; // a late answer finds nothing under its key
    const attempt = p.attempt;
    // Sent under a token this section no longer holds: nothing it says — a save, a refusal, a 401 — is this session's.
    // It stays only as a change that could not be confirmed (never sent again: its body goes).
    if (csrf !== gen.current.csrf || since !== sessionEndsSoFar()) {
      return void patchPanel(id, { attempt: { ...attempt, state: 'unresolved', body: '', note: SETTINGS_TEXT.detached } });
    }
    if (answer.kind === 'rate-limited') startWait(answer.retryAfterSeconds);
    if (answer.kind === 'signed-out') return failSession({ kind: 'signed-out', text: ISSUED_TEXT.ended });
    if (answer.kind === 'saved') {
      patchPanel(id, { attempt: null, loaded: answer.settings, saved: answer.settings.version, status: { tone: 'info', text: SETTINGS_TEXT.readingBack(answer.settings.version) } });
      return void readBack(id, answer.settings.version, attempt.values);
    }
    const decisive = first ? answer.kind !== 'unknown' && answer.kind !== 'in-progress' : CHECK_DECIDES.has(answer.kind);
    if (!decisive) return void patchPanel(id, { attempt: { ...attempt, state: 'unresolved', note: reasonOf(answer) } });
    const alert = (text: string, extra: Partial<SettingsPanel> = {}): void => void patchPanel(id, { attempt: null, status: { tone: 'alert', text }, ...extra });
    switch (answer.kind) {
      case 'conflict': return alert(SETTINGS_TEXT.conflict, { conflict: true });
      case 'tenant-changed': return alert(SETTINGS_TEXT.tenantChanged);
      case 'not-found': return alert(SETTINGS_TEXT.notFoundWrite);
      case 'key-reused': return alert(SETTINGS_TEXT.keyReused);
      case 'invalid': return alert(SETTINGS_TEXT.invalid);
      case 'step-up': return alert(SETTINGS_TEXT.stepUp, { stepUp: { method: identity.reauthMethod(uid) } });
      case 'rate-limited': return alert(SETTINGS_TEXT.rateLimited(pickerWaitText(answer.retryAfterSeconds)));
      case 'denied': {
        alert(SETTINGS_TEXT.deniedWrite);
        // The reads' one fresh check: another token is a new generation (the panel goes); the same one, the refusal stands.
        void denialOf(() => panelRef.current?.id !== id);
        return;
      }
      default: return alert(SETTINGS_TEXT.invalid);
    }
  }

  /** After a confirmed save: ONE fresh read. "Saved" only for that version with those values; never another PUT. */
  async function readBack(id: number, version: number, values: SettingsValues): Promise<void> {
    const p = panelRef.current;
    if (p === null || p.id !== id) return;
    const target = p.store.id;
    const mine = gen.current.n;
    const n = ++seq.current.settings;
    ctl.current.settings?.abort();
    const controller = new AbortController();
    ctl.current.settings = controller;
    const since = sessionEndsSoFar();
    const stale = (): boolean => !alive.current || mine !== gen.current.n || n !== seq.current.settings || panelRef.current?.id !== id || since !== sessionEndsSoFar();
    patchPanel(id, { reading: true });
    const unread = (): void => void patchPanel(id, { reading: false, saved: null, status: { tone: 'alert', text: SETTINGS_TEXT.unread(version) } });
    const s = await connect();
    if (stale()) return;
    if (s.kind !== 'ok') {
      if (s.kind === 'ended' || s.kind === 'refused' || s.kind === 'no-identity') return failSession(sessionFailure(s)); // the panel's drop says it was saved
      if (s.kind === 'rate-limited') startWait(s.retryAfterSeconds ?? DEFAULT_WAIT_SECONDS);
      return unread();
    }
    if (adopt(s.csrf)) return; // a new generation took the panel (its drop says the save stands)
    const answer = await issuing.getSettings(target, s.csrf, controller.signal);
    if (stale()) return;
    if (answer.kind === 'signed-out') return failSession({ kind: 'signed-out', text: ISSUED_TEXT.ended });
    if (answer.kind === 'rate-limited') startWait(answer.retryAfterSeconds);
    if (answer.kind === 'denied') {
      // The reads' one fresh check first: another token is a new generation (the panel's drop says the save stands).
      const verdict = await denialOf(stale);
      if (verdict === null) return;
      if (verdict === 'denied') creditDenied('other', true, target, gen.current.csrf); // rule 4
    }
    if (answer.kind !== 'ok') return unread();
    const read = answer.settings;
    if (read.configured && read.version === version && sameSettingsValues(read, values)) {
      return void patchPanel(id, { reading: false, saved: null, loaded: read, fields: fieldsOf(read), conflict: false, status: { tone: 'saved', text: SETTINGS_TEXT.saved(version) } });
    }
    if (read.configured && read.version > version) {
      return void patchPanel(id, { reading: false, saved: null, loaded: read, fields: fieldsOf(read), conflict: false, status: { tone: 'info', text: SETTINGS_TEXT.newer(version, read.version) } });
    }
    patchPanel(id, { reading: false, saved: null, status: { tone: 'alert', text: SETTINGS_TEXT.mismatch(version) } });
  }

  /** "Check again": the SAME key and bytes, under the token it was sent with, within the cutoff — only on the user's press. */
  async function checkAgain(): Promise<void> {
    const p = panelRef.current;
    const a = p?.attempt;
    if (p === null || a == null || a.state !== 'unresolved' || a.body === '' || checkingRef.current === p.id || savingRef.current === p.id || waitRef.current) return;
    const { id } = p;
    const token = attemptToken.current;
    if (expired(a) || token === null || token.key !== a.key) return void patchPanel(id, { attempt: { ...a, body: '', note: SETTINGS_TEXT.tooOld } });
    checkingRef.current = id;
    const since = sessionEndsSoFar();
    patchPanel(id, { attempt: { ...a, state: 'checking', note: '' } });
    try {
      const s = await connect();
      const live = (): SettingsAttempt | null => (alive.current && panelRef.current?.id === id && panelRef.current.attempt?.key === a.key ? panelRef.current.attempt : null);
      if (live() === null || since !== sessionEndsSoFar()) return;
      if (s.kind !== 'ok') {
        const failure = sessionFailure(s);
        if (failure.kind === 'signed-out') return failSession(failure);
        if (failure.seconds !== undefined) startWait(failure.seconds);
        return void patchPanel(id, { attempt: { ...a, state: 'unresolved', note: failure.seconds !== undefined ? pickerWaitText(failure.seconds) : 'No answer from the server.' } });
      }
      if (adopt(s.csrf)) return; // another token: the panel and its attempt went with the old generation
      if (s.csrf !== token.csrf) return void patchPanel(id, { attempt: { ...a, body: '', note: SETTINGS_TEXT.detached } });
      if (expired(a)) return void patchPanel(id, { attempt: { ...a, state: 'unresolved', body: '', note: SETTINGS_TEXT.tooOld } }); // judged again, just before it leaves
      const answer = await issuing.saveSettings(a.storeId, a.body, a.key, token.csrf);
      settle(id, a.key, answer, false, token.csrf, since);
    } finally {
      if (checkingRef.current === id) checkingRef.current = null;
    }
  }

  /** "Stop tracking": the attempt goes (it is not cancelled), and the settings are read afresh. */
  function stopTracking(): void {
    const p = panelRef.current;
    if (p === null || p.attempt === null || p.attempt.state === 'checking' || p.attempt.state === 'sending') return;
    panelTitle.current?.focus(); // the card goes
    putPanel({ ...p, attempt: null, conflict: false, status: { tone: 'info', text: SETTINGS_TEXT.stopped } });
    void readSettings('stopped');
  }

  async function confirmSignIn(): Promise<void> {
    const p = panelRef.current;
    if (p === null || p.stepUp === null || p.stepUp.method === null || confirmingRef.current === p.id || waitRef.current) return;
    const { id } = p;
    const method = p.stepUp.method;
    const secret = method === 'password' ? password : null;
    if (secret === '') return; // nothing typed: the control says so, and nothing is asked
    setPassword('');
    confirmingRef.current = id;
    patchPanel(id, { confirming: true });
    const since = sessionEndsSoFar();
    const mine = gen.current.n;
    const here = (): boolean => alive.current && panelRef.current?.id === id && since === sessionEndsSoFar() && mine === gen.current.n;
    // A sign-in that did not go through: said, and focus back where the user tries again (never left on the title).
    const retry = (text: string): void => {
      patchPanel(id, { status: { tone: 'alert', text } });
      (method === 'password' ? passwordRef.current : confirmRef.current)?.focus();
    };
    try {
      let fresh: string | null;
      try { fresh = await identity.reauthenticate(uid, secret); } catch { fresh = null; }
      if (!here()) return;
      if (fresh === null) return retry(SETTINGS_TEXT.reauthFailed);
      const renewed = await session.reauthenticate(uid, fresh);
      if (!here()) return;
      if (renewed.kind !== 'ok') {
        // An ended or refused session clears everything (Reconnect then); a 429 starts the section's wait.
        const failure = sessionFailure(renewed);
        if (failure.kind === 'signed-out') return failSession(failure);
        return retry(failure.seconds !== undefined ? SETTINGS_TEXT.rateLimited(pickerWaitText(startWait(failure.seconds))) : SETTINGS_TEXT.reauthUnconfirmed);
      }
      renew(renewed.csrf);
      stampSignIn(renewed.csrf);
      // Save waits until the settings are read under the renewed session (a failed read keeps it waiting).
      patchPanel(id, { stepUp: null, needsRead: true, status: { tone: 'info', text: SETTINGS_TEXT.renewing } });
      saveButton.current?.focus(); // the sign-in group goes; Save is what the user presses next
      void readSettings('renewed'); // the version the edits are based on, checked again: never a save
    } finally {
      if (confirmingRef.current === id) confirmingRef.current = null;
      if (alive.current) patchPanel(id, { confirming: false });
    }
  }

  /** "Check the settings again" after a sign-in whose re-read did not answer: the same re-read, never a save. */
  function reread(): void {
    const p = panelRef.current;
    if (p === null || !p.needsRead || p.reading || waitRef.current) return;
    saveButton.current?.focus(); // this control goes once the settings are read
    void readSettings('renewed');
  }

  /** "Load current version" after a conflict: an explicit read that keeps the edits and moves their base. */
  function loadCurrent(): void {
    const p = panelRef.current;
    if (p === null || !p.conflict || p.reading || waitRef.current) return;
    saveButton.current?.focus(); // this control goes once the version is loaded
    void readSettings('keep');
  }

  /**
   * A changed session is noticed without a click: on a return to the tab, ONE plain check once a token is fixed and while
   * not signed out. Another token starts a new generation; a definite end clears the views. It never reads settings or
   * saves, and never signs in after a confirmed end.
   */
  function checkSession(): void {
    if (signingIn.current !== null) return; // the void's sign-in is waited for: its own answer decides (design R11), for its bounded wait only (R1)
    if (document.visibilityState === 'hidden' || gen.current.csrf === null || storesRef.current.phase === 'signed-out') return;
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
  // A render that removed or disabled the control that had focus (Reconnect, Try again, a field the locked form disabled):
  // focus still on it or on <body> goes to the panel's title when it was in the panel and the panel is still there, else to
  // the heading — never left on <body> (the drafts section's DA-199 rule).
  useLayoutEffect(() => {
    const keep = keepFocus.current;
    if (keep === null || (keep.from.isConnected && !keep.from.matches(':disabled'))) return;
    keepFocus.current = null;
    const at = document.activeElement;
    if (at !== null && at !== document.body && at !== keep.from) return;
    (keep.to?.() ?? (keep.inPanel && panelTitle.current?.isConnected === true ? panelTitle.current : heading.current))?.focus();
  });
  useEffect(() => {
    const moved = (e: Event): void => { if (keepFocus.current !== null && !(e.target instanceof Node && keepFocus.current.from.contains(e.target))) keepFocus.current = null; };
    document.addEventListener('pointerdown', moved, true);
    return () => document.removeEventListener('pointerdown', moved, true);
  }, []);
  // The first invalid field takes focus after a Save that sent nothing.
  useEffect(() => {
    if (focusInvalid === 0) return;
    const first = document.querySelector<HTMLElement>('[data-testid="issued-settings"] [aria-invalid="true"]');
    first?.focus();
  }, [focusInvalid]);
  // The sign-in group takes focus when it appears: the password field, or the Google button.
  const stepUpMethod = panel?.stepUp?.method;
  useEffect(() => {
    if (stepUpMethod === undefined || stepUpMethod === null) return;
    (stepUpMethod === 'password' ? passwordRef.current : confirmRef.current)?.focus();
  }, [stepUpMethod]);
  useEffect(() => {
    // A held void past its cutoff loses its bytes on a return too (a throttled timer may not have run); never a send.
    const check = (): void => { scrubVoid(); checkSession(); };
    window.addEventListener('focus', check);
    document.addEventListener('visibilitychange', check);
    // A sign-out, heard where it starts, while this section is mounted: a new generation with no token, every read
    // cancelled, the wait ended, the panel and any attempt dropped at once; nothing is read and nobody is signed in.
    const unhear = onSessionEnd(() => {
      gen.current = { n: gen.current.n + 1, csrf: null };
      clearWait();
      failSession({ kind: 'signed-out', text: ISSUED_TEXT.ended });
    });
    return () => {
      unhear();
      window.removeEventListener('focus', check);
      document.removeEventListener('visibilitychange', check);
      gen.current = { n: gen.current.n + 1, csrf: null };
      attemptToken.current = null;
      ctl.current.stores?.abort();
      ctl.current.settings?.abort();
      ctl.current.list?.abort();
      ctl.current.find?.abort();
      if (waitTimer.current !== null) clearTimeout(waitTimer.current);
      if (voidCoolTimer.current !== null) clearTimeout(voidCoolTimer.current);
      if (payCoolTimer.current !== null) clearTimeout(payCoolTimer.current);
      lookupCtl.current?.abort();
      creditCtl.current.list?.abort();
      creditCtl.current.lookup?.abort();
      activityCtl.current?.abort();
      for (const timer of cnTimers.current) clearTimeout(timer);
      dropSignIn(null); // its deadline goes; a late answer finds no owner (and `alive` already false: no state is set)
    };
    // A section serves one UID (see ServerIssuedInvoices); the clients are fixed for its life.
  }, []);
  // The credit-note reads as the issue side calls them, over this render's functions (they read refs and fixed clients only).
  const creditLatest = useRef({ readCreditList, readCreditLookup, dropCredit });
  creditLatest.current = { readCreditList, readCreditLookup, dropCredit };
  useEffect(() => {
    if (creditReads === undefined) return undefined;
    creditReads(Object.freeze({
      refresh: (storeId: string, invoiceId: string, target: string | null) => { void creditLatest.current.readCreditList(storeId, invoiceId, 'first', target); },
      lookup: (storeId: string, invoiceId: string) => { void creditLatest.current.readCreditLookup(storeId, invoiceId, 'start'); },
      numberOf: (storeId: string, invoiceId: string, id: string) => {
        const s = creditRef.current;
        return s !== null && s.storeId === storeId && s.invoiceId === invoiceId && creditCurrent(s) ? s.list?.notes.find((note) => note.id === id)?.number ?? null : null;
      },
      drop: () => creditLatest.current.dropCredit(),
    }));
    return () => creditReads(null);
  }, []);

  const waiting = wait !== null;
  const signedOut = stores.phase === 'signed-out';
  const storesFailed = stores.phase === 'denied' || stores.phase === 'unavailable' || stores.phase === 'rate-limited' || signedOut;
  const chosen = stores.stores.find((store) => store.id === storeId) ?? null;
  const listFailed = list.phase === 'denied' || list.phase === 'unavailable' || list.phase === 'rate-limited';
  const storePicker = stores.phase === 'ready' && stores.stores.length > 0;
  const listShown = chosen !== null && list.storeId === chosen.id;
  // Why Load more and Try again wait: the section's rate-limit wait, or a list read still out.
  const listHold = waiting ? 'issued-list-wait' : busy ? 'issued-list-busy' : undefined;
  const lastKnown = (list.phase === 'unavailable' || list.phase === 'rate-limited') && list.rows.length > 0;
  /** The Issued section's payment recording for the dialog it opened (M7B-PAYMENTS-P2B; never the drafts card's). */
  const recordingOf = (v: ViewOpen, store: StoreEntry): PaymentRecording => ({
    held: payHeld,
    heldStore: payHeld === undefined || payHeld.storeId === v.storeId ? null : storeNameOf(payHeld.storeId),
    expired: payHeld !== undefined && payHeld.body !== '' && paymentExpired(payHeld, clock(), wall()),
    cooling: payCool,
    out: payOut,
    lookup: lookup !== null && lookup.storeId === v.storeId && lookup.invoiceId === v.invoiceId ? lookup : null,
    record: (press) => recordPayment(v.id, store, press),
    check: () => { void checkPayment(); },
    confirm: () => { void confirmPayment(); },
    find: () => { if (!paying.current && !confirming.current) void runLookup(v.storeId, v.invoiceId); }, // R3-4: never while a chain or Confirm is out
    settle: (row, version) => { void settleRow(row, version); },
  });
  /** The Issued section's void action for the dialog it opened (the drafts card's View invoice never gets one). */
  const voidingOf = (v: ViewOpen, store: StoreEntry): IssuedVoidCapability => ({
    store, held: voidHeld, expired: voidHeld !== undefined && voidExpired(voidHeld, clock(), wall()),
    cooling: voidHeld !== undefined && voidCool === voidHeld.key, finding: voidHeld !== undefined && voidFinding === voidHeld.key,
    checkText: voidHeld !== undefined && voidCheck?.key === voidHeld.key ? voidCheck.text : '', confirmedDenial: voidDenied,
    reauthMethod: () => identity.reauthMethod(uid), signingIn: voidSigning, generation: () => gen.current.n,
    eligibility: (signal) => readVoidEligibility(v.id, v.storeId, v.invoiceId, signal),
    send: (press) => sendVoid(v.id, store, press),
    check: () => { if (!waitRef.current && voidCoolRef.current === null) void checkVoid(); },
    find: () => { if (!waitRef.current) void findVoid(); },
    signIn: (secret) => signInForVoid(v.id, secret),
    stopSignIn: () => dropSignIn({ kind: 'failed', text: VOID_TEXT.signInStopped }, v.id),
  });
  /** The Issued section's reversal action for the dialog it opened (P2C). */
  const reversingOf = (v: ViewOpen, store: StoreEntry): IssuedReversalCapability => ({
    store,
    held: revHeld !== undefined && revHeld.storeId === v.storeId ? revHeld : undefined,
    blocked: isLiveVoid(voidHeld) || isLiveReversal(revHeld) || isOpenPayment(payHeld) || withdrawingHere(v.storeId, v.invoiceId),
    expired: revHeld !== undefined && reversalExpired(revHeld, clock(), wall()),
    cooling: revHeld !== undefined && revCool === revHeld.key, finding: revHeld !== undefined && revFinding === revHeld.key,
    checkText: revHeld !== undefined && revCheck?.key === revHeld.key ? revCheck.text : '',
    signingIn: voidSigning, generation: () => gen.current.n,
    eligibility: (signal) => readReversalEligibility(v.id, v.storeId, v.invoiceId, signal),
    find: (paymentId, signal) => findReversalPayment(v.storeId, v.invoiceId, paymentId, () => viewRef.current?.id === v.id, signal),
    send: (press) => sendReversal(v.id, store, press),
    retry: () => { if (!waitRef.current && revCoolRef.current === null) void retryReversal(); },
    check: () => { if (!waitRef.current) void findReversal(); },
    dismiss: dismissReversal,
    signIn: (secret) => signInForVoid(v.id, secret),
    stopSignIn: () => dropSignIn({ kind: 'failed', text: VOID_TEXT.signInStopped }, v.id),
  });
  /** The Issued section's credit-note withdrawal for the dialog it opened (CN-P3). */
  const withdrawingOf = (v: ViewOpen, store: StoreEntry): IssuedWithdrawCapability => {
    const slot = wdSlot(v.storeId, v.invoiceId);
    const wdHeld = wdHolds.get(slot);
    return {
      held: wdHeld,
      blocked: isLiveVoid(voidHeld) || isLiveReversal(revHeld) || isOpenPayment(payHeld) || isLiveWithdrawal(wdHeld),
      finding: wdHeld !== undefined && wdFinding.has(wdHeld.key),
      checkText: wdHeld === undefined ? '' : wdCheck[wdHeld.key] ?? '',
      confirmedDenial: wdDenied,
      signingIn: voidSigning, generation: () => gen.current.n,
      find: (creditNoteId, signal) => findWithdrawalNote(v.storeId, v.invoiceId, creditNoteId, () => viewRef.current?.id === v.id, signal),
      send: (press) => sendWithdrawal(v.id, store, press),
      check: () => { if (!waitRef.current) void findWithdrawal(slot); },
      dismiss: () => dismissWithdrawal(slot),
      // The list from the server again; after this tab's own withdrawal also CA-44's page one of a loaded activity view.
      refresh: (own) => { void readCreditList(v.storeId, v.invoiceId, 'first', null); if (own) activityAfterOwnWrite(v.storeId); },
      signIn: (secret) => signInForVoid(v.id, secret),
      stopSignIn: () => dropSignIn({ kind: 'failed', text: VOID_TEXT.signInStopped }, v.id),
    };
  };
  /** The Issued section's credit-note reads for the dialog it opened: only this invoice's slice, under this generation and token. */
  const creditingOf = (v: ViewOpen): IssuedCreditCapability => {
    const s = credit !== null && credit.storeId === v.storeId && credit.invoiceId === v.invoiceId && creditCurrent(credit) ? credit : null;
    const ownRow = s?.lookup?.rows.some((x) => x.state === 'open' || x.state === 'issued') === true; // a nonterminal row of this owner here
    return {
      list: s?.list ?? null, lookup: s?.lookup ?? null, owner: s?.lookup?.owner === true, gateOpen: s?.lookup?.phase === 'exhausted',
      start: () => startCredit(v.storeId, v.invoiceId),
      showMore: () => { if (!waitRef.current) void readCreditList(v.storeId, v.invoiceId, 'next', null); },
      retryList: () => {
        const l = creditRef.current?.list;
        if (!waitRef.current) void readCreditList(v.storeId, v.invoiceId, l?.phase === 'failed' && l.next !== null ? 'next' : 'first', null); // a transient failure resumes from its page
      },
      retryLookup: () => { if (!waitRef.current) void readCreditLookup(v.storeId, v.invoiceId, 'start'); },
      continueChecking: () => { if (!waitRef.current) void readCreditLookup(v.storeId, v.invoiceId, 'continue'); },
      held: cnHereOf(v) ? cnHeld : undefined,
      say: cnHereOf(v) ? cnSayOf(cnHeld) : null,
      card: cnHereOf(v) && cnHeld !== undefined && cnSayOf(cnHeld) !== null ? cnCardOf(cnHeld, cnSayOf(cnHeld) as CreditSay) : null,
      focusFind: cnFocusFind,
      check: () => { void checkCredit().catch(cnThrew(pressed())); },
      proceed: (another) => { void continueCredit(another).catch(cnThrew(pressed())); },
      hide: hideCredit,
      retryNumber,
      // While a view dialog is open the section is inert: its pair says every credit-note write, whatever invoice the hold is on.
      live: cnLive,
      hidesHere: ownRow || (cnHereOf(v) && isOpenCreditNote(cnHeld)),
      hidesSignIns: cnHoldsSignIns,
      blocked: ownRow || isOpenCreditNote(cnHeld) ? 'own' : siblingOpen(v) ? 'sibling' : null,
      busy: cnBusy,
      openAttempt: isOpenCreditNote(cnHeld) ? cnHeld.attemptId : null,
      // Only the pair of the hold's own invoice speaks its writes (another invoice's dialog shows none of them).
      spoken: (region, n) => { spokenInline.current = { ...spokenInline.current, [region]: Math.max(spokenInline.current[region], n) }; },
      number: cnHereOf(v) && cnHeld?.creditNoteId != null ? s?.list?.notes.find((x) => x.id === cnHeld.creditNoteId)?.number ?? null : null,
      rereads: cnHereOf(v) ? cnRereads : 0,
      generation: () => gen.current.n,
      reauthMethod: () => identity.reauthMethod(uid),
      lastSignIn,
      freshSignIn,
      lookupNow: async () => {
        await readCreditLookup(v.storeId, v.invoiceId, 'start');
        const x = creditRef.current;
        return x !== null && x.storeId === v.storeId && x.invoiceId === v.invoiceId && creditCurrent(x) ? x.lookup : null;
      },
      listNow: () => { void readCreditList(v.storeId, v.invoiceId, 'first', null, true); }, // the D-P2-15 baseline: to nextCursor null
      ...(v.store === null ? {} : { issue: (press: CreditPress) => issueCredit(v.id, v.store as StoreEntry, press) }),
      confirm: () => { void confirmCredit().catch(cnThrew(pressed())); },
      find: () => { void findCredit().catch(cnThrew(pressed())); },
      settleRow: (row, version) => { if (v.store !== null) void settleCreditRow(v.store, v.invoiceId, row, version).catch(cnThrew(row.attemptId)); },
      closedInFlight: () => { if (alive.current) setCnLive({ status: CREDIT_TEXT.closedInFlight, alert: '' }); },
      signIn: (secret) => signInForVoid(v.id, secret),
      stopSignIn: () => dropSignIn(null, v.id),
    };
  };
  /**
   * A payment, reversal or void attempt that holds "Issue credit note" back (§2.3): unresolved on this invoice, or attached
   * anywhere. A withdrawal holds it back only on its own invoice (CN-P3 R2).
   */
  const siblingOpen = (v: ViewOpen): boolean => {
    const here = (x: { readonly storeId: string; readonly invoiceId: string; readonly csrf: string | null }): boolean => x.csrf !== null || (x.storeId === v.storeId && x.invoiceId === v.invoiceId);
    const out = (state: string): boolean => state === 'sending' || state === 'checking' || state === 'unresolved';
    return (payHeld !== undefined && isOpenPayment(payHeld) && here(payHeld)) || (revHeld !== undefined && out(revHeld.state) && here(revHeld))
      || (voidHeld !== undefined && out(voidHeld.state) && here(voidHeld)) || withdrawingHere(v.storeId, v.invoiceId);
  };
  const cnHereOf = (v: { readonly storeId: string; readonly invoiceId: string }): boolean => cnHeld !== undefined && cnHeld.storeId === v.storeId && cnHeld.invoiceId === v.invoiceId;
  /**
   * What the card says for `h`: its last line, or — for an open attempt this section has said nothing about yet (a remount, the
   * same user back) — its known state's line with Look up attempt only.
   */
  const cnSayOf = (h: HeldCreditNote | undefined): CreditSay | null => {
    if (h === undefined) return null;
    if (cnSay !== null && cnSay.attemptId === h.attemptId) return cnSay;
    const memo = memoFor(h.attemptId); // said before this section mounted (or while it was away)
    if (bareNow(memo.bare)) return memo.bare; // rule 4 still holds under that token
    if (!isOpenCreditNote(h)) return null;
    // Its last line only when that line backs an offer (a stated refusal with Look up, a Check again, a continuation); a line
    // said while a stage was out ("sending") offers nothing, so the state's own line is derived instead (§2.6 item 5).
    const last = memo.last;
    if (last !== null && (last.find || last.check !== null || last.cont !== null)) return last;
    const kind = h.state === 'registered' ? 'registeredOnly' : h.state === 'issuing' ? 'unresolved' : h.state === 'issued' && h.settle !== null ? 'settleUnknown' : null;
    const text = h.state === 'registering' ? CREDIT_TEXT.regUnknown : h.state === 'issued' ? CREDIT_TEXT.issued(formatCents(h.grossCents), INVOICE_CREDIT_NOTE_REASONS[h.reason]) : '';
    // Back after the section was away (the hold kept its bytes): what the stage still allows — cnCardOf judges it now.
    const check = h.state === 'registering' ? 'register' : h.state === 'issuing' ? 'issue' : kind === 'settleUnknown' ? 'settle' : null;
    const own = h.state === 'issued' && kind === null && h.issue?.completion?.kind === 'issued'; // its own 201: Confirm (§2.6 item 6)
    return { attemptId: h.attemptId, text, alert: false, also: '', find: !own, bare: false, bareAt: null, check, cont: h.state === 'registered' ? 'continue' : null, kind };
  };
  /** What the held attempt's card shows and offers now (doc 17 §3.1-§3.3; §3.2 for Check again and continuation; §3.6 rules 3-4). */
  function cnCardOf(h: HeldCreditNote, s: CreditSay): CreditCardView {
    const mono = clock();
    const now = wall();
    const attached = h.csrf !== null;
    const bare = bareNow(s); // rule 4, until a later known session change (then a detached card offers Look up and Hide)
    const open = isOpenCreditNote(h);
    const ownIssue = h.issue?.completion?.kind === 'issued' && h.creditNoteId !== null;
    const settling = h.settle !== null && h.settle.completion === null && h.settle.body !== '';
    const confirm = !bare && !s.find && attached && ownIssue && h.state === 'issued' && !settling; // a line that sends to Look up (internalError) backs no Confirm
    const check = !bare && attached && s.check !== null && !shutHas(h.attemptId, s.check) && checkLeaves(h, s.check, mono, now) ? s.check : null;
    const cont = !bare && attached && s.cont !== null && !shutHas(h.attemptId, 'proof') && continueLeaves(h, mono, now) ? s.cont : null;
    // Look up attempt only in the attempt's own store and tenant, signed in — a detached card's too (§3.2).
    const fits = !signedOut && storeId === h.storeId && stores.stores.some((x) => x.id === h.storeId && x.tenantId === h.tenantId);
    const find = !bare && open && fits && (!attached || (s.find && !confirm));
    // Another session cannot continue a registration (§3.2): a detached registered card says so.
    const lapsed = !bare && !attached && open && h.state === 'registered';
    const text = lapsed ? CREDIT_TEXT.continueAfterSignIn
      : s.kind === 'registeredOnly' ? CREDIT_TEXT.registeredOnly(cont === 'continue') : s.kind === 'unresolved' ? CREDIT_TEXT.unresolved(check !== null)
        : s.kind === 'settleUnknown' ? CREDIT_TEXT.settleUnknown(check !== null) : s.text;
    const deadline = check === 'settle' ? (h.settle?.firstWall ?? now) + CREDIT_NOTE_SETTLE_REPLAY_MS : (h.signIn?.wall ?? now) + CREDIT_NOTE_REPLAY_MS;
    // Left unresolved (D-P2-6): its register or issue neither stored nor refused before the key, a settlement sent and not
    // stored, or a registration a lost reply left behind.
    const undecided = (b: HeldCreditNote['register']): boolean => b !== null && b.completion === null && !b.unstored;
    const settleOut = h.settle !== null && h.settle.completion === null && h.sends.some((x) => x.stage === 'settle' && x.key === h.settle?.key);
    const unresolved = (h.state === 'registering' && undecided(h.register)) || (h.state === 'issuing' && undecided(h.issue)) || settleOut || (h.state === 'registered' && h.unresolved);
    const list = credit !== null && cnHereOf(credit) && creditCurrent(credit) ? credit.list : null;
    // §4.1: issued + numberPending + "Try again" when the follow failed or did not reach the row (never while it reads, while
    // another invoice's dialog holds the list, or on a detached card: Look up and Hide only, rule 4).
    const reached = list?.notes.some((x) => x.id === h.creditNoteId) === true;
    const retry = !bare && attached && h.creditNoteId !== null && (h.state === 'issued' || h.state === 'confirmed') && !reached && (view === null || cnHereOf(view))
      && (list === null || list.phase === 'failed' || (list.phase === 'ready' && !list.more));
    const shown = attached && !bare ? h.shown : null; // a detached or no-access card lists no notes and no names (rules 3-4)
    return {
      text, alert: s.alert || lapsed, also: lapsed ? CREDIT_TEXT.registeredOnly(false) : s.also, confirm, find, check, cont,
      until: check === null || check === 'proof' ? '' : CREDIT_TEXT.checkUntil(clockText(deadline)),
      hide: !bare && open && (!attached || (unresolved && s.find)), // not while the chain is still sending
      notes: shown === null || list === null ? [] : list.notes.filter((x) => shown.ids.includes(x.id)),
      retry,
    };
  }
  const cnHoldsSignIns = creditNoteHoldsSignIns(cnHeld, clock(), wall(), (['register', 'proof', 'issue', 'settle'] as const).filter((x) => shutIn(cnHeld, x)), bareNow(cnSayOf(cnHeld)));
  // What a card offers changes with time alone (a cool-down, a stage's 30 s, the 8- and 9-minute and 23-hour windows): one
  // timer to the next such moment re-renders it; and a Check again whose window passed says so. Neither ever sends (§3.4).
  useEffect(() => {
    if (!isLiveCreditNote(cnHeld)) return undefined;
    const next = cnNextChange(cnHeld, clock(), wall());
    if (next === null) return undefined;
    const timer = setTimeout(() => { if (alive.current) setCnTick((x) => x + 1); }, next);
    return () => clearTimeout(timer);
  });
  useEffect(() => {
    if (!isLiveCreditNote(cnHeld) || cnSay === null || cnSay.attemptId !== cnHeld.attemptId || cnSay.check === null || cnSay.check === 'proof') return;
    if (!replayWindowOpen(cnHeld, cnSay.check, clock(), wall())) cnExpire(cnHeld, cnSay.check);
  });
  const cardHeld = voidHeld?.state === 'refused' && voidHeld.refusal === 'signed-out' && signedOut ? undefined : voidHeld;
  // The credit-note card at section level: no dialog shows its invoice (the dialog shows it inline otherwise), not hidden.
  const cnInline = view !== null && cnHereOf(view);
  // One pair speaks at a time (§2.6): what the dialog's pair already had (`spoken`) is not said again here when it closes.
  const spokenInline = useRef({ s: 0, a: 0 });
  const sectionLive = cnInline ? CN_QUIET
    : { ...cnLive, status: cnLive.sn > spokenInline.current.s ? cnLive.status : '', alert: cnLive.an > spokenInline.current.a ? cnLive.alert : '' };
  const cnSectionHeld = !cnInline && cnHeld !== undefined && !cnHeld.hidden && cnSayOf(cnHeld) !== null ? cnHeld : undefined;
  const cnSectionView = cnSectionHeld === undefined ? null : cnCardOf(cnSectionHeld, cnSayOf(cnSectionHeld) as CreditSay);
  // §2.6 puts checkUntil and numberPending (once the follow stopped short) in the status region: said once per change.
  const cnShownView = cnHeld === undefined || cnHeld.hidden || cnSayOf(cnHeld) === null ? null : cnSectionView ?? cnCardOf(cnHeld, cnSayOf(cnHeld) as CreditSay);
  const cnExtra = cnShownView === null ? '' : [cnShownView.until, cnShownView.retry ? CREDIT_TEXT.numberPending : ''].filter((x) => x !== '').join('\n');
  // null until the first commit: a mount is no transition, so what a card shows then is not announced.
  // What this attempt's card already said of these (A1, fix list 7 F3): a list re-read ending short again, or a deadline
  // coming back after Check again, is no new transition. null until the first commit: a mount announces nothing.
  const cnExtraSaid = useRef<{ readonly attemptId: string; readonly parts: Set<string> } | null>(null);
  useEffect(() => {
    const a = cnHeld?.attemptId ?? '';
    const parts = cnExtra.split('\n').filter((x) => x !== '');
    const was = cnExtraSaid.current;
    if (was === null || was.attemptId !== a) {
      cnExtraSaid.current = { attemptId: a, parts: new Set(was === null ? parts : []) };
      if (was === null) return;
    }
    const said = (cnExtraSaid.current as { readonly parts: Set<string> }).parts;
    const fresh = parts.filter((x) => !said.has(x));
    for (const x of fresh) said.add(x);
    if (fresh.length > 0) setCnStatus(fresh.join(' '));
  }, [cnExtra, cnHeld?.attemptId]); // another attempt with the same words is its own line (CX7-02)
  // Look up attempt shows the attempt's rows and their actions with the card (§3.3), in its own store and tenant only.
  const cnSectionStore = cnSectionHeld === undefined || signedOut || storeId !== cnSectionHeld.storeId ? undefined
    : stores.stores.find((x) => x.id === cnSectionHeld.storeId && x.tenantId === cnSectionHeld.tenantId);
  const cnSectionLookup = cnSectionStore !== undefined && credit !== null && cnHereOf(credit) && creditCurrent(credit) ? credit.lookup : null;
  const cnSectionNumber = cnSectionHeld?.creditNoteId != null && credit !== null && cnHereOf(credit) && creditCurrent(credit)
    ? credit.list?.notes.find((x) => x.id === cnSectionHeld.creditNoteId)?.number ?? null : null;
  const cnSectionHeading = useRef<HTMLHeadingElement | null>(null);
  // F4: with no dialog open, this user's LIVE reversal attempt in the store chosen now (the dialog shows it otherwise).
  const revSectionHeld = view === null && !signedOut && isLiveReversal(revHeld) && revHeld.storeId === storeId ? revHeld : undefined;
  const revSectionKey = revSectionHeld?.key ?? null;
  // F2: that card going (settled by a Retry or Check payment) with focus in it: focus to the section's heading.
  const revSectionWas = useRef<string | null>(null);
  useLayoutEffect(() => {
    const was = revSectionWas.current;
    revSectionWas.current = revSectionKey;
    if (was === null || revSectionKey !== null) return;
    const at = document.activeElement;
    if (at === null || at === document.body) heading.current?.focus();
  }, [revSectionKey]);
  // CN-P3: the same for every LIVE withdrawal attempt: reachable (Check credit note status, Dismiss) with no dialog open, in its own store.
  const wdSectionHeld = view === null && !signedOut ? wdMine.filter((w) => isLiveWithdrawal(w) && w.storeId === storeId) : [];
  const wdSectionKey = wdSectionHeld.length === 0 ? null : wdSectionHeld.map((w) => w.key).join(' ');
  const wdSectionWas = useRef<string | null>(null);
  useLayoutEffect(() => {
    const was = wdSectionWas.current;
    wdSectionWas.current = wdSectionKey;
    if (was === null || wdSectionKey === was) return; // any card leaving (not only the last) may drop focus to <body>
    const at = document.activeElement;
    if (at === null || at === document.body) heading.current?.focus();
  }, [wdSectionKey]);
  const track = (target: EventTarget | null): void => {
    if (target instanceof Element && section.current?.contains(target) === true) keepFocus.current = { from: target, inPanel: target.closest('[data-testid="issued-settings"]') !== null };
  };

  return (
    <section ref={section} onFocus={(e) => track(e.target)} data-testid="issued-section" aria-labelledby="issued-title" className="bg-white/80 backdrop-blur-xl rounded-[2.5rem] border border-slate-200 shadow-sm p-8 space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 ref={heading} id="issued-title" tabIndex={-1} className={`text-xl font-black text-primary tracking-tight ${focusRing}`}>Issued invoices</h3>
          <p className="text-sm font-medium text-slate-600">{ISSUED_TEXT.intro}</p>
        </div>
        {!open && <button type="button" data-testid="issued-show" onClick={show} className={quiet}>Show issued invoices</button>}
      </div>
      <p data-testid={notice === '' ? undefined : 'issued-notice'} role="status" className="text-sm font-bold text-emerald-800">{notice}</p>
      {detached && (
        <div data-testid="issued-detached" className="p-4 rounded-2xl border border-amber-200 bg-amber-50 space-y-2">
          <p role="status" className="text-sm font-bold text-amber-900">{SETTINGS_TEXT.detached}</p>
          <button type="button" data-testid="issued-detached-dismiss" onClick={() => { heading.current?.focus(); setDetached(false); }} className={quiet}>Dismiss</button>
        </div>
      )}
      {/* The credit-note pair (doc 17 §2.6): always mounted, empty before any write; quiet while the open dialog says it inline. */}
      <p data-testid="issued-credit-status" role="status" className="sr-only"><span key={sectionLive.sn}>{sectionLive.status}</span></p>
      <p data-testid="issued-credit-alert" role="alert" className="sr-only"><span key={sectionLive.an}>{sectionLive.alert}</span></p>
      {cnSectionHeld !== undefined && cnSectionView !== null && (
        <CreditCard
          prefix="issued-credit-card" held={cnSectionHeld} view={cnSectionView} number={cnSectionNumber} busy={cnBusy} waiting={waiting} headingRef={cnSectionHeading} focusFind={cnFocusFind}
          onConfirm={() => { cnSectionHeading.current?.focus(); void confirmCredit().catch(cnThrew(pressed())); }} onFind={() => { cnSectionHeading.current?.focus(); void findCredit().catch(cnThrew(pressed())); }}
          onCheck={() => { cnSectionHeading.current?.focus(); void checkCredit().catch(cnThrew(pressed())); }} onContinue={(another) => { cnSectionHeading.current?.focus(); void continueCredit(another).catch(cnThrew(pressed())); }}
          onHide={() => { heading.current?.focus(); hideCredit(); }} onRetry={retryNumber}
        >
          {cnSectionStore !== undefined && (
            <CreditRows
              lookup={cnSectionLookup} busy={cnBusy} waiting={waiting} canSettle openOther={isOpenCreditNote(cnHeld) ? cnHeld.attemptId : null} headingRef={cnSectionHeading}
              onSettle={(row, version) => { void settleCreditRow(cnSectionStore, cnSectionHeld.invoiceId, row, version).catch(cnThrew(row.attemptId)); }}
            />
          )}
        </CreditCard>
      )}
      <VoidCard
        // R22: a first send refused because the session had ended is said once Reconnect has begun a session again, never
        // beside the signed-out section (review B1 iam 4).
        held={cardHeld} confirmedDenial={voidDenied}
        expired={voidHeld !== undefined && voidExpired(voidHeld, clock(), wall())} waiting={waiting} cooling={voidHeld !== undefined && voidCool === voidHeld.key}
        finding={voidHeld !== undefined && voidFinding === voidHeld.key} checkText={voidHeld !== undefined && voidCheck?.key === voidHeld.key ? voidCheck.text : ''} headingRef={voidCardHeading}
        onCheck={() => { if (waitRef.current || voidCoolRef.current !== null) return; voidCardHeading.current?.focus(); void checkVoid(); }}
        onFind={() => { if (waitRef.current) return; voidCardHeading.current?.focus(); void findVoid(); }}
        onDismiss={dismissVoid}
      />
      {revSectionHeld !== undefined && (
        // F4: a live reversal attempt stays reachable (Check payment, Dismiss) with no dialog open — e.g. its invoice no
        // longer opens — in its own store only, for this section's user only.
        <ReversalCard
          held={revSectionHeld} expired={reversalExpired(revSectionHeld, clock(), wall())} waiting={waiting} cooling={revCool === revSectionHeld.key}
          finding={revFinding === revSectionHeld.key} checkText={revCheck?.key === revSectionHeld.key ? revCheck.text : ''} headingRef={revSectionHeading}
          onRetry={() => { if (waitRef.current || revCoolRef.current !== null) return; revSectionHeading.current?.focus(); void retryReversal(); }}
          onCheck={() => { if (waitRef.current) return; revSectionHeading.current?.focus(); void findReversal(); }}
          onDismiss={() => { heading.current?.focus(); dismissReversal(); }}
        />
      )}
      {wdSectionHeld.map((w) => (
        <WithdrawalCard
          key={w.key} held={w} waiting={waiting} finding={wdFinding.has(w.key)} checkText={wdCheck[w.key] ?? ''} confirmedDenial={wdDenied}
          onCheck={() => { if (!waitRef.current) void findWithdrawal(wdSlot(w.storeId, w.invoiceId)); }}
          onDismiss={() => { heading.current?.focus(); dismissWithdrawal(wdSlot(w.storeId, w.invoiceId)); }}
        />
      ))}

      {open && (
        <div className="space-y-4">
          {changed && stores.phase === 'ready' && stores.stores.length > 0 && storeId === '' && (
            <p data-testid="issued-connection-changed" role="alert" className="text-sm font-bold text-amber-800">{ISSUED_TEXT.connection}</p>
          )}
          <p data-testid="issued-stores-state" data-phase={stores.phase} role={stores.phase === 'denied' ? 'alert' : 'status'} className="text-sm font-bold text-slate-600 min-h-[1rem]">{stores.text}</p>
          {storesFailed && (
            <button type="button" data-testid="issued-retry" disabled={busy || (waiting && !signedOut)} onClick={() => { heading.current?.focus(); void readStores(signedOut); }} className={button}>
              {signedOut ? 'Reconnect' : 'Try again'}
            </button>
          )}
          {storePicker && (
            // Before a store is chosen the select is the last thing shown: the empty list region below it adds no space.
            <div className={`space-y-1 ${chosen === null ? 'mb-0' : ''}`}>
              <label htmlFor="issued-store" className={labelClass}>Store</label>
              <select id="issued-store" data-testid="issued-store" value={storeId} onChange={(e) => chooseStore(e.target.value)} className={`${inputClass} max-w-md`}>
                <option value="">Choose a store…</option>
                {stores.stores.map((store) => (
                  <option key={store.id} value={store.id}>{storeLabel(store)}{store.readOnly ? ' (read-only)' : ''}</option>
                ))}
              </select>
              {storeId === '' && <p data-testid="issued-choose" className={hintClass}>{ISSUED_TEXT.chooseStore}</p>}
            </div>
          )}

          {storePicker && (
            // The list's live region is in place, empty, from the moment a store can be chosen: its first text ("Loading…")
            // is a change to a region that exists — announced — not a region inserted together with its text.
            <div data-testid="issued-list-area" className="space-y-3">
              <p
                data-testid="issued-list-state" data-phase={listShown ? list.phase : undefined} role={listShown && list.phase === 'denied' ? 'alert' : 'status'}
                className={`text-sm font-bold text-slate-600 ${listShown ? 'min-h-[1rem]' : ''}`}
              >
                {listShown && list.text}
                {listShown && lastKnown && <span data-testid="issued-last-known" className="block text-xs font-black uppercase tracking-widest text-amber-800">{LIST_TEXT.lastKnown}</span>}
                {listShown && list.phase === 'ready' && list.rows.length === 0 && <span data-testid="issued-empty" className="block font-medium text-slate-600">{LIST_TEXT.empty}</span>}
              </p>
              {listShown && (
                <>
                  {list.note !== '' && <p data-testid="issued-list-note" role="status" className="text-sm font-bold text-amber-800">{list.note}</p>}
                  {listFailed && (
                    // aria-disabled, never disabled, during a read or a wait: it keeps focus, and says why it waits.
                    <button
                      ref={listRetry} type="button" data-testid="issued-list-retry" aria-disabled={busy || waiting} aria-describedby={listHold}
                      onClick={() => { if (!busyRef.current && !waitRef.current) void readList('first'); }}
                      className={`${button} aria-disabled:opacity-50 aria-disabled:cursor-not-allowed`}
                    >
                      Try again
                    </button>
                  )}
                  {list.rows.length > 0 && (
                    <ul data-testid="issued-list" aria-label="Issued invoices at this store" className="divide-y divide-slate-100 border border-slate-100 rounded-2xl">
                      {list.rows.map((row) => (
                        <li key={row.id} data-testid="issued-row" data-id={row.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                          <div className="min-w-0 space-y-0.5">
                            <p data-testid="issued-row-number" className="text-sm font-bold text-primary">Invoice {row.number}</p>
                            <p id={`issued-row-${row.id}`} className={`${hintClass} break-words`}>
                              <bdi data-testid="issued-row-customer">{row.customerName}</bdi>
                              {' · '}<span data-testid="issued-row-total">Total <span className="whitespace-nowrap">{formatCents(row.totalCents)}</span></span>
                              {' · '}{row.status === 'voided' && 'Issued '}<time data-testid="issued-row-issued" dateTime={row.issuedAt} className="whitespace-nowrap">{utcText(row.issuedAt)}</time>
                              {' · '}<span data-testid="issued-row-status">{STATUS_TEXT[row.status]}</span>
                            </p>
                            <p data-testid="issued-row-id" className={`${hintClass} break-all`}>{recordIdText(row.id, list.rows)}</p>
                          </div>
                          <button
                            type="button" id={issuedOpenIdOf(row.id)} data-testid="issued-open" aria-label={`Open invoice ${row.number}`} aria-describedby={`issued-row-${row.id}`}
                            onClick={() => openView(row)} className={quiet}
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
                      data-testid="issued-load-more"
                      aria-disabled={busy || waiting}
                      aria-describedby={listHold}
                      onClick={() => { if (!busyRef.current && !waitRef.current) void readList('more'); }}
                      className={`${quiet} aria-disabled:opacity-50 aria-disabled:cursor-not-allowed`}
                    >
                      Load more
                    </button>
                  )}
                  {waiting && <span id="issued-list-wait" className="sr-only">{LIST_TEXT.waiting}</span>}
                  {busy && !waiting && <span id="issued-list-busy" className="sr-only">{LIST_TEXT.loading}</span>}
                </>
              )}
            </div>
          )}

          {chosen !== null && activity !== null && activity.storeId === chosen.id && activity.phase !== 'hidden' && (
            // doc 18 §4.1: after the issued list, before the issuing settings; hidden (nothing rendered) after a classified 403.
            <CreditActivitySection
              a={activity} waiting={waiting}
              onMore={() => { void readActivity('more'); }} onRefresh={() => { void readActivity('first', { via: 'refresh' }); }} onRetry={() => { void readActivity('first', { via: 'retry' }); }}
            />
          )}

          {chosen !== null && (
            <div data-testid="issued-store-area" className="space-y-4">
              <div className="space-y-3">
                <button
                  type="button"
                  data-testid="issued-settings-open"
                  aria-expanded={panel !== null}
                  aria-controls={panel !== null ? 'issued-settings' : undefined}
                  aria-disabled={panel?.attempt != null}
                  aria-describedby={panel?.attempt != null ? 'issued-settings-open-hint' : undefined}
                  onClick={toggleSettings}
                  className={`${quiet} aria-disabled:opacity-50 aria-disabled:cursor-not-allowed`}
                >
                  Issuing settings
                </button>
                {panel?.attempt != null && <span id="issued-settings-open-hint" className="sr-only">{SETTINGS_TEXT.saveBlocked}</span>}
                {panel !== null && panel.store.id === chosen.id && (
                  <SettingsForm
                    panel={panel}
                    waiting={waiting}
                    titleRef={panelTitle}
                    saveRef={saveButton}
                    passwordRef={passwordRef}
                    confirmRef={confirmRef}
                    password={password}
                    onPassword={setPassword}
                    onField={editField}
                    onSave={() => { void save(); }}
                    onRetry={(mode) => { panelTitle.current?.focus(); void readSettings(mode); }}
                    onLoadCurrent={loadCurrent}
                    onReread={reread}
                    onCheck={() => { void checkAgain(); }}
                    onStop={stopTracking}
                    onConfirm={() => { void confirmSignIn(); }}
                  />
                )}
              </div>
            </div>
          )}
        </div>
      )}

      {view !== null && (
        <IssuedInvoiceDialog
          key={view.id} storeId={view.storeId} invoiceId={view.invoiceId} read={(s, i, signal) => readView(view.id, s, i, signal)} waiting={waiting} onClose={closeView} returnFocus={heading}
          current={() => alive.current && viewRef.current?.id === view.id && storeRef.current === view.storeId}
          voiding={view.store === null ? undefined : voidingOf(view, view.store)}
          reversing={view.store === null ? undefined : reversingOf(view, view.store)}
          withdrawing={view.store === null ? undefined : withdrawingOf(view, view.store)}
          crediting={creditingOf(view)}
          payments={{
            read: (after, signal) => readPayments(view.id, view.storeId, view.invoiceId, after, signal),
            ...(view.store === null ? {} : {
              eligibility: (signal: AbortSignal) => readPaymentEligibility(view.id, view.storeId, view.invoiceId, signal),
              recording: recordingOf(view, view.store),
            }),
          }}
        />
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------------------------------------------------
// One issued invoice (exported: the drafts section shows the invoice it issued with the same dialog, under its own reads).

/** What the owner's read answers the dialog: the invoice, or why there is none to show. */
export type IssuedReadAnswer =
  | { readonly kind: 'ok'; readonly invoice: IssuedInvoice }
  | { readonly kind: 'not-found' | 'denied' | 'unavailable' }
  | { readonly kind: 'rate-limited'; readonly text: string };
/** What the owner's payments read answers the dialog (M7B-PAYMENTS-P2A): one page, or why there is none to show. */
export type PaymentsReadAnswer =
  | { readonly kind: 'ok'; readonly page: PaymentsPage }
  | { readonly kind: 'not-found' | 'denied' | 'unavailable' }
  | { readonly kind: 'rate-limited'; readonly text: string };
/** The Issued section's payments read for the one dialog it opened: the drafts card's View invoice never has one. */
export interface IssuedPaymentsCapability {
  /** ONE page (`after` null: page one) under the owner's session and context; null when that context is gone. */
  readonly read: (after: string | null, signal: AbortSignal) => Promise<PaymentsReadAnswer | null>;
  /** The action-only recording eligibility (M7B-PAYMENTS-P2B), once per open of an issued invoice; null when the context is gone. */
  readonly eligibility?: (signal: AbortSignal) => Promise<'allowed' | 'not' | null>;
  /** Recording and recovering a payment (M7B-PAYMENTS-P2B): the section's hold, lookup and actions. */
  readonly recording?: PaymentRecording;
}

/** The attempts lookup the section ran for one invoice (M7B-PAYMENTS-P2B): this user's unsettled attempts on it. */
export interface PaymentLookup {
  readonly storeId: string;
  readonly invoiceId: string;
  readonly phase: 'loading' | 'ready' | 'failed' | 'cap';
  readonly text: string;
  /** Only this invoice's attempts in state open or recorded, in the server's order. */
  readonly rows: readonly PaymentAttempt[];
}
/**
 * One invoice's credit-note list as one chain read it (doc 17 §4.1): its notes oldest first, its view (`named`: the owner's
 * names present; null before an item), the cursor Show more sends (ready) or Try again resumes from (a transient failure),
 * whether it was read to the end (only then the empty texts), a Show more or follow out (`more`), the note a refresh
 * follows to (`target`, an issue's creditNote.id), "{n} more loaded." (`said`) and the chain's one view reload and one
 * cursor restart.
 */
export interface CreditNotesList {
  readonly phase: 'loading' | 'ready' | 'failed' | 'denied';
  readonly notes: readonly InvoiceCreditNote[];
  readonly named: boolean | null;
  readonly next: string | null;
  readonly complete: boolean;
  readonly more: boolean;
  readonly target: string | null;
  readonly said: string;
  readonly reloaded: boolean;
  readonly restarted: boolean;
}
/** A lookup row of this invoice, with the wall-clock time its page answered ("… when checked at {time}"). */
export type CreditLookupRow = CreditNoteAttempt & { readonly checkedAt: number };
/**
 * This owner's attempts lookup for one invoice (doc 17 §3.3): `exhausted` (the gate, D-P2-3), `incomplete` (a cap or a
 * transport stop: rows kept, Continue checking resumes from `cursor`), `failed` (Try again from page one), `denied` (hidden,
 * not asked again under this generation and token). `rows` are this invoice's; `seen` every row the scan loaded, store-wide
 * (a page repeating one fails it); `owner`: a page answered 200 here.
 */
export interface CreditNotesLookup {
  readonly phase: 'loading' | 'exhausted' | 'incomplete' | 'failed' | 'denied';
  readonly rows: readonly CreditLookupRow[];
  readonly cursor: string | null;
  readonly seen: readonly CreditNoteAttempt[];
  readonly restarted: boolean;
  readonly owner: boolean;
}
const CREDIT_LIST_START: CreditNotesList = Object.freeze({
  phase: 'loading', notes: [], named: null, next: null, complete: false, more: false, target: null, said: '', reloaded: false, restarted: false,
});
const LOOKUP_DENIED: CreditNotesLookup = Object.freeze({ phase: 'denied', rows: [], cursor: null, seen: [], restarted: false, owner: false });
const LOOKUP_FAILED: CreditNotesLookup = Object.freeze({ ...LOOKUP_DENIED, phase: 'failed' });
/** The Issued section's credit-note reads for the one dialog it opened (doc 17 §2.1); the drafts card's View invoice has none. */
export interface IssuedCreditCapability {
  /** This invoice's list under the section's generation and token, or null before its first read. */
  readonly list: CreditNotesList | null;
  /** This owner's lookup for this invoice under the same, or null before it starts. */
  readonly lookup: CreditNotesLookup | null;
  /** The store owner (a lookup page answered 200 here): the empty list says "None have been issued yet." too. */
  readonly owner: boolean;
  /** The issue action's gate (D-P2-3): the lookup read to exhaustion under this generation and token. */
  readonly gateOpen: boolean;
  /** Once per open, after the detail answered an invoice (issued or voided, D-P2-12): the list and the lookup from page one. */
  readonly start: () => void;
  readonly showMore: () => void;
  readonly retryList: () => void;
  readonly retryLookup: () => void;
  readonly continueChecking: () => void;
  // ---- the issue side (doc 17 §2-§3) ----
  /** This user's credit-note attempt when it is this invoice's (hidden or not), and what its card says. */
  readonly held: HeldCreditNote | undefined;
  readonly say: CreditSay | null;
  /** What its card shows and offers now (null: no card here). */
  readonly card: CreditCardView | null;
  /** Bumped when Look up attempt should take focus (D-P2-15 stated other notes or an uncertainty). */
  readonly focusFind: number;
  /** "Check again" of the card's stage (§3.2). */
  readonly check: () => void;
  /** "Continue issuing" (false) or "Issue another credit note" (true), under E1-E7. */
  readonly proceed: (another: boolean) => void;
  /** "Hide this attempt" (D-P2-6 A): the card only. */
  readonly hide: () => void;
  /** The section's live pair while this dialog shows the attempt's invoice (the section's own pair is empty meanwhile). */
  readonly live: CreditLive;
  /** This user's open credit-note hold's attempt (any invoice): another attempt's lookup row waits for it (blockedOwn). */
  readonly openAttempt: string | null;
  /** The card's "Try again" for its credit note's number (§4.1). */
  readonly retryNumber: () => void;
  /** The dialog's pair had its chance to say writes up to `n`: the section pair does not repeat them. */
  readonly spoken: (region: 's' | 'a', n: number) => void;
  /** D-P2-10 A: Record payment, Reverse and Void hidden on this invoice (a nonterminal row or an open hold here). */
  readonly hidesHere: boolean;
  /** D-P2-10 A: Void and Reverse hidden everywhere (a hold that can still Check again or Continue issuing). */
  readonly hidesSignIns: boolean;
  /** Why "Issue credit note" is aria-disabled, beyond Remaining 0 (§2.3): an own nonterminal row or hold, or a sibling attempt. */
  readonly blocked: 'own' | 'sibling' | null;
  /** A credit-note press is out. */
  readonly busy: boolean;
  /** The issued note's number once its row loaded under this generation and token (else numberPending). */
  readonly number: number | null;
  /** Bumped when an outcome needs this invoice's detail and amounts read again. */
  readonly rereads: number;
  readonly generation: () => number;
  readonly reauthMethod: () => 'password' | 'google' | null;
  readonly lastSignIn: () => CreditNoteSignIn | null;
  readonly freshSignIn: () => CreditNoteSignIn | null;
  /** The review's lookup: from page one, resolved with what it read (null: its context went). */
  readonly lookupNow: () => Promise<CreditNotesLookup | null>;
  /** The review's list read from page one (the D-P2-15 baseline): not waited for. */
  readonly listNow: () => void;
  /** Absent for a dialog without its store entry (nothing can be issued there). */
  readonly issue?: (press: CreditPress) => Promise<CreditIssueOutcome>;
  readonly confirm: () => void;
  readonly find: () => void;
  readonly settleRow: (row: CreditLookupRow, version: 1 | 2) => void;
  readonly closedInFlight: () => void;
  readonly signIn: (secret: string | null) => Promise<VoidSignIn | null>;
  readonly stopSignIn: () => void;
}
/** One "Issue credit note" press in the confirmation: what the form and its review fixed. */
export interface CreditPress { readonly invoiceId: string; readonly number: number; readonly grossCents: number; readonly reason: InvoiceCreditNoteReason }
/** What the confirmation hears back: a sign-in first (signInNeeded, or signInExpired with the old time), nothing sent, its context gone, or the chain shown on the card. */
export type CreditIssueOutcome =
  | { readonly kind: 'sign-in'; readonly expired: CreditNoteSignIn | null }
  | { readonly kind: 'not-sent'; readonly text: string }
  | { readonly kind: 'stale' | 'shown' };
/** One Record press: what the form validated. */
export interface PaymentPress { readonly invoiceId: string; readonly number: number; readonly amountCents: number; readonly method: InvoicePaymentMethod }
export interface PaymentRecording {
  /** The user's payment attempt now (the section's hold), whatever invoice it is for. */
  readonly held: HeldPayment | undefined;
  /** Its store's label when it is not this dialog's store (R3 M2), else null. */
  readonly heldStore: string | null;
  /** Whether that attempt's stage is past its 23-hour cutoff. */
  readonly expired: boolean;
  /** Check again waits a moment after an in-progress answer. */
  readonly cooling: boolean;
  /** A payment chain or Confirm of this section is out (R2 N2): Find and row actions wait for it. */
  readonly out: boolean;
  readonly lookup: PaymentLookup | null;
  /** One press: null when it went (the hold says what), else why nothing was sent. */
  readonly record: (press: PaymentPress) => Promise<string | null>;
  readonly check: () => void;
  readonly confirm: () => void;
  readonly find: () => void;
  readonly settle: (row: PaymentAttempt, version: 1 | 2) => void;
}

/** One press of the void confirmation's "Void invoice" (M7B-INVOICES-VOID-P2): what is voided, why, and the confirmation's callbacks. */
export interface VoidPress {
  readonly invoiceId: string;
  readonly number: number;
  readonly reasonCode: InvoiceVoidReasonCode;
  /** Whether the confirmation that pressed is still open: closed before the send, nothing is sent; a pre-key refusal is said there. */
  readonly open: () => boolean;
  /** Whether the dialog's eligibility still says allowed. */
  readonly allowed: () => boolean;
  /** Told the key the moment the attempt is held, before the POST leaves. */
  readonly held: (key: string) => void;
  /** The section generation its review read was made under: another one now, and nothing is sent (review B1 R2-1c). */
  readonly reviewGen: number;
}
/** What a press comes back with for its confirmation to say. 'sent': the server answered — the hold says what, by key. */
export type VoidSendOutcome =
  | { readonly kind: 'not-sent'; readonly text: string }
  | { readonly kind: 'sent' }
  | { readonly kind: 'step-up'; readonly method: 'password' | 'google' | null }
  | { readonly kind: 'rate-limited'; readonly text: string }
  | { readonly kind: 'denied'; readonly text: string; readonly gone: boolean }
  /** Reviewed under an earlier generation (R2-1c): nothing sent; the confirmation closes. */
  | { readonly kind: 'stale' };
/** `gen`: the session generation this sign-in's renewal produced. */
export type VoidSignIn = { readonly kind: 'renewed'; readonly gen: number } | { readonly kind: 'failed'; readonly text: string };
/** The one void sign-in a section waits for (R1): the open, generation and sign-out count it was pressed under, its deadline, its one answer. */
interface VoidSignInOwner {
  readonly viewId: number;
  readonly gen: number;
  readonly since: number;
  timer: ReturnType<typeof setTimeout> | null;
  readonly answer: (out: VoidSignIn | null) => void;
}

/** The Issued section's void action for the one dialog it opened (design §4): the drafts card's View invoice never has one. */
export interface IssuedVoidCapability {
  /** The dialog's store as the server's store list named it when it was opened: its label and its tenant (the body's). */
  readonly store: StoreEntry;
  /** The user's void attempt now (the section's hold), whatever invoice it is for. */
  readonly held: HeldVoid | undefined;
  /** Whether that attempt is past its 23-hour cutoff (the section's clocks). */
  readonly expired: boolean;
  /** Check again waits a moment after an in-progress answer. */
  readonly cooling: boolean;
  /** A Check invoice read of that attempt is out. */
  readonly finding: boolean;
  /** What that attempt's last Check invoice read could not say ('' for none). */
  readonly checkText: string;
  /** The attempt whose first-send 403 the one fresh check confirmed (its refusal then says the access is gone), or null. */
  readonly confirmedDenial: string | null;
  readonly reauthMethod: () => 'password' | 'google' | null;
  /** The void's own sign-in is out: no new review may start until it has finished (review B1 R2-1a). */
  readonly signingIn: boolean;
  /** The section's generation now (a review records it; a send under another is refused, R2-1c). */
  readonly generation: () => number;
  /** The action-only eligibility read (one per call): null when the context that asked is gone. */
  readonly eligibility: (signal: AbortSignal) => Promise<'allowed' | 'not' | null>;
  readonly send: (press: VoidPress) => Promise<VoidSendOutcome | null>;
  readonly check: () => void;
  readonly find: () => void;
  readonly signIn: (secret: string | null) => Promise<VoidSignIn | null>;
  /** Stop waiting here for this dialog's sign-in (R1): its answer says so at once; nothing is cancelled at the provider and nothing is sent. */
  readonly stopSignIn: () => void;
}

/** One press of the reversal confirmation's "Reverse payment" (M7B-PAYMENTS-P2C R4): the payment as the review read it. */
export interface ReversePress {
  readonly invoiceId: string;
  readonly number: number;
  readonly payment: InvoicePayment;
  readonly reasonCode: InvoicePaymentReversalReason;
  readonly open: () => boolean;
  readonly allowed: () => boolean;
  readonly held: (key: string) => void;
  readonly reviewGen: number;
}
/** What a first send comes back with: `sent` (the hold says what, by key), `refused` (sealed: a fresh read says why), or not run. */
export type ReverseSendOutcome =
  | { readonly kind: 'not-sent'; readonly text: string }
  | { readonly kind: 'sent' }
  | { readonly kind: 'refused' }
  | { readonly kind: 'not-run'; readonly text: string }
  | { readonly kind: 'step-up'; readonly method: 'password' | 'google' | null }
  | { readonly kind: 'stale' };
/** R7's answer: the exact row as read, `missing` after a complete traversal, or `unconfirmed`. */
export type PaymentFind =
  | { readonly kind: 'found'; readonly payment: InvoicePayment; readonly status: IssuedStatus }
  | { readonly kind: 'missing' | 'unconfirmed' };
/** The Issued section's reversal action for the one dialog it opened (M7B-PAYMENTS-P2C). */
export interface IssuedReversalCapability {
  /** The dialog's store as the server's store list named it (its label, and its tenant for the body). */
  readonly store: StoreEntry;
  /** The user's reversal attempt when it is for the dialog's store (R8: its card shows only there), else undefined. */
  readonly held: HeldReversal | undefined;
  /** R8: the user holds an unresolved record, reversal or void attempt somewhere — Reverse shows nowhere. */
  readonly blocked: boolean;
  readonly expired: boolean;
  readonly cooling: boolean;
  readonly finding: boolean;
  readonly checkText: string;
  readonly signingIn: boolean;
  readonly generation: () => number;
  readonly eligibility: (signal: AbortSignal) => Promise<'allowed' | 'not' | null>;
  readonly find: (paymentId: string, signal: AbortSignal) => Promise<PaymentFind | null>;
  readonly send: (press: ReversePress) => Promise<ReverseSendOutcome | null>;
  readonly retry: () => void;
  readonly check: () => void;
  readonly dismiss: () => void;
  readonly signIn: (secret: string | null) => Promise<VoidSignIn | null>;
  readonly stopSignIn: () => void;
}

/** CN-P3: the exact credit note as read, `missing` after a complete traversal, or `unconfirmed`. */
export type WithdrawFind = { readonly kind: 'found'; readonly note: InvoiceCreditNote } | { readonly kind: 'missing' | 'unconfirmed' };
/** One press of the withdrawal confirmation (CN-P3): the note as the review read it. */
export interface WithdrawPress {
  readonly invoiceId: string;
  readonly number: number;
  readonly note: InvoiceCreditNote;
  readonly reason: InvoiceCreditNoteWithdrawalReason;
  readonly open: () => boolean;
  /** A credit-note issue attempt here, or one a sign-in would detach, holds it back (asked at the press). */
  readonly blocked: () => boolean;
  readonly held: (key: string) => void;
  readonly reviewGen: number;
}
/** The Issued section's credit-note withdrawal for the one dialog it opened (M7B-CREDITNOTES-CN-P3). */
export interface IssuedWithdrawCapability {
  readonly held: HeldWithdrawal | undefined;
  /** An unresolved void, payment or reversal attempt of this user, or a withdrawal on this invoice: Withdraw does not show here. */
  readonly blocked: boolean;
  readonly finding: boolean;
  readonly checkText: string;
  /** The attempt whose 403 the one fresh check confirmed (rule 4). */
  readonly confirmedDenial: string | null;
  readonly signingIn: boolean;
  readonly generation: () => number;
  readonly find: (creditNoteId: string, signal: AbortSignal) => Promise<WithdrawFind | null>;
  readonly send: (press: WithdrawPress) => Promise<ReverseSendOutcome | null>;
  readonly check: () => void;
  readonly dismiss: () => void;
  readonly refresh: (own: boolean) => void;
  readonly signIn: (secret: string | null) => Promise<VoidSignIn | null>;
  readonly stopSignIn: () => void;
}

export interface IssuedInvoiceDialogProps {
  readonly storeId: string;
  readonly invoiceId: string;
  /**
   * ONE read of the invoice under the owner's session and context — its session check, a 401, a 403's one fresh check, a
   * 429's wait — or null when the context that asked is gone. The dialog calls it once when it opens and on its own Try
   * again; never on a timer, a focus or a re-render. With `voiding`, also on the user's "Void invoice…" (the review), after
   * a void's answer, on "Load again" and after the void's sign-in — each its own read that keeps what is shown.
   */
  readonly read: (storeId: string, invoiceId: string, signal: AbortSignal) => Promise<IssuedReadAnswer | null>;
  /**
   * Whether the context that opened the dialog still stands, asked ONCE when a read answers: an answer that arrives after
   * that context is gone is not shown. A shown invoice is never asked about again — the owner unmounts the dialog itself
   * (onClose, a new key) when its context ends: a token change, a session end or 401, a store change, a detach.
   */
  readonly current: () => boolean;
  /** The owner's rate-limit wait is on: Try again waits for it. */
  readonly waiting: boolean;
  readonly onClose: () => void;
  /** Where focus goes on close when the control that opened the dialog is gone (its row left the list). */
  readonly returnFocus: RefObject<HTMLElement | null>;
  /** The void action (M7B-INVOICES-VOID-P2): only the Issued section gives one; without it the dialog is exactly the read-only one. */
  readonly voiding?: IssuedVoidCapability;
  /**
   * The payments read (M7B-PAYMENTS-P2A): only the Issued section gives one. Page one once per open, only after the detail
   * answered an invoice; again only on its Try again, after this dialog's void was confirmed, and "Load more payments" for
   * the next page. Without it the dialog renders and reads exactly as before.
   */
  readonly payments?: IssuedPaymentsCapability;
  /** The reversal action (M7B-PAYMENTS-P2C): only the Issued section gives one, with `payments`. */
  readonly reversing?: IssuedReversalCapability;
  /** The credit-note withdrawal (M7B-CREDITNOTES-CN-P3): only the Issued section gives one, with `crediting`. */
  readonly withdrawing?: IssuedWithdrawCapability;
  /** The credit-note list and lookup (M7B-CREDITNOTES-CN-P2): only the Issued section gives them, with `payments`. */
  readonly crediting?: IssuedCreditCapability;
}

type ViewState =
  | { readonly phase: 'loading' | 'not-found' | 'denied' | 'unavailable' | 'rate-limited'; readonly text: string; readonly invoice: null }
  | { readonly phase: 'ready'; readonly text: ''; readonly invoice: IssuedInvoice };
const VIEW_LOADING: ViewState = Object.freeze({ phase: 'loading', text: VIEW_TEXT.loading, invoice: null });
/** The first render: loading, with its status region in place but still empty — the loading text is then a change to it (announced). */
const VIEW_OPENING: ViewState = Object.freeze({ phase: 'loading', text: '', invoice: null });
const UNAVAILABLE_READ: IssuedReadAnswer = Object.freeze({ kind: 'unavailable' });

/**
 * The Payments section (M7B-PAYMENTS-P2A): `page` the newest held answer (its amounts and word are the whole history's),
 * `rows` every page joined so far, `next` the cursor Load more sends, `more` a Load more out.
 */
interface PaymentsView {
  readonly phase: 'opening' | 'loading' | 'ready' | 'changed' | 'not-found' | 'denied' | 'unavailable' | 'rate-limited';
  readonly text: string;
  readonly page: PaymentsPage | null;
  readonly rows: readonly InvoicePayment[];
  readonly next: string | null;
  readonly more: boolean;
}
/** Before page one is asked: the live region in place and empty, so "Loading" is a change to it (announced). */
const PAYMENTS_OPENING: PaymentsView = Object.freeze({ phase: 'opening', text: '', page: null, rows: [], next: null, more: false });
const PAYMENTS_LOADING: PaymentsView = Object.freeze({ ...PAYMENTS_OPENING, phase: 'loading', text: PAYMENTS_TEXT.loading });
const UNAVAILABLE_PAYMENTS: PaymentsReadAnswer = Object.freeze({ kind: 'unavailable' });
const paymentAfter = (a: InvoicePayment, b: InvoicePayment): boolean => a.recordedAt < b.recordedAt || (a.recordedAt === b.recordedAt && a.id < b.id);

/**
 * Whether a Load more page continues what is held: the same invoice status, amounts and word; no id again, the order
 * unbroken across pages; the unreversed amounts of every page so far within the recorded amount, and equal to it on the
 * last page. Otherwise the history changed between the reads.
 */
function paymentsJoin(held: PaymentsView, page: PaymentsPage): boolean {
  const was = held.page;
  if (was === null || was.invoice.status !== page.invoice.status || was.paymentStatus !== page.paymentStatus || was.amounts.dueCents !== page.amounts.dueCents
    || was.amounts.creditedCents !== page.amounts.creditedCents || was.amounts.appliedCents !== page.amounts.appliedCents || was.amounts.remainingCents !== page.amounts.remainingCents) return false;
  const ids = new Set(held.rows.map((p) => p.id));
  let prev: InvoicePayment | undefined = held.rows[held.rows.length - 1];
  let active = 0n;
  for (const p of [...held.rows, ...page.payments]) if (p.reversal === null) active += BigInt(p.amountCents);
  for (const p of page.payments) {
    if (ids.has(p.id) || (prev !== undefined && !paymentAfter(prev, p))) return false;
    ids.add(p.id);
    prev = p;
  }
  const applied = BigInt(page.amounts.appliedCents);
  return active <= applied && (page.nextCursor !== null || active === applied);
}

/** The void confirmation over the dialog: which open it is, exactly what it confirms (the review read's invoice), the reason, and where it is. */
interface VoidConfirm {
  readonly id: number;
  readonly invoice: IssuedInvoice;
  readonly reason: InvoiceVoidReasonCode | null;
  /** An empty press: the reasons say "Choose a reason first.". */
  readonly invalid: boolean;
  /** The section generation its review read was made under (R2-1c). */
  readonly gen: number;
  /** The attempt this confirmation pressed (held before it left), or null. */
  readonly key: string | null;
  /** Its press is out (the session check, before any key). */
  readonly saving: boolean;
  readonly status: { readonly alert: boolean; readonly text: string } | null;
  /** A first send's 403 step_up_required (nothing ran): the sign-in group. */
  readonly stepUp: { readonly method: 'password' | 'google' | null } | null;
  readonly confirming: boolean;
  /** The re-read after a sign-in is out. */
  readonly renewing: boolean;
  /** A decisive answer said outside the hold (no longer allowed, not checked): Close only. */
  readonly decided: boolean;
}
/** Each void-side read of the dialog has its own abort (design R9); the detail reads among them share one sequence (F1). */
type VoidReadKind = 'elig' | 'review' | 'after' | 'load' | 'renew' | 'renewElig' | 'revElig' | 'revFind' | 'wdFind';
/**
 * The detail reads of one open — its first read and Try again, the review, the post-void read, Load again and the sign-in's
 * re-read — share ONE sequence: only the latest started may set what is shown, so a review answered before a void's commit
 * can never overwrite the voided detail read after it, nor open a confirmation (review B1 F1).
 */
const DETAIL_KINDS: ReadonlySet<VoidReadKind> = new Set(['review', 'after', 'load', 'renew']);

/**
 * The issued invoice as the server recorded it (snapshot version 1): number, "Issued" or "Voided" (with the UTC void time
 * and the reason's label), the UTC issue time, the seller, the
 * customer, the ordered lines, Subtotal, the tax line — "Tax (8.875%)" and its amount, "Tax (0%)" for an explicit zero, or
 * exactly "No tax calculated" — and the Total. Text is shown as text, each value isolated (<bdi>); amounts never break
 * (whitespace-nowrap; text-sm below sm, SDB-23's rule) and the lines table scrolls sideways in its own named region. Laid
 * out from the top (anchor="top"): an answer that grows the dialog never moves Close, which has the first focus. Escape and
 * Close close it; focus goes back to the row's Open, or `returnFocus` when that row is gone.
 *
 * With `voiding` (the Issued section's only; M7B-INVOICES-VOID-P2): a row under the header, reserved from the open on,
 * where "Void invoice…" shows once the eligibility read (sent with the detail read) answered allowed and the invoice is
 * issued; its own status and alert regions; the review re-read, the confirmation (VoidConfirmDialog) and, once this
 * dialog's attempt is voided or refused for a reason that names the invoice, ONE re-read of the detail ("Load again"
 * retries only that GET). A late answer of any of these reads changes nothing once its open, its kind's latest read or
 * its context is gone.
 */
export function IssuedInvoiceDialog({ storeId, invoiceId, read, current, waiting, onClose, returnFocus, voiding, payments, reversing, withdrawing, crediting }: IssuedInvoiceDialogProps) {
  const closeButton = useRef<HTMLButtonElement | null>(null);
  const [state, setState] = useState<ViewState>(VIEW_OPENING);
  const alive = useRef(false);
  const seq = useRef(0);
  const ctl = useRef<AbortController | null>(null);
  const owner = useRef({ read, current, voiding, payments, reversing, withdrawing, crediting });
  useLayoutEffect(() => { owner.current = { read, current, voiding, payments, reversing, withdrawing, crediting }; });
  // The void action (idle, and nothing of it rendered, without `voiding`).
  // The eligibility answer AND the section generation it was read under (review B1 R3-1b): only an 'allowed' read under
  // the generation that stands now permits the action; an older one counts as not yet known.
  const [elig, setEligState] = useState<{ readonly value: 'asking' | 'allowed' | 'not'; readonly gen: number }>({ value: 'asking', gen: -1 });
  const eligRef = useRef<{ readonly value: 'asking' | 'allowed' | 'not'; readonly gen: number }>({ value: 'asking', gen: -1 });
  // The renewal's own re-reads are out (review B1 R3-1a): no new review or send until they are applied.
  const [renewalOut, setRenewalOutState] = useState(false);
  const renewalRef = useRef(false);
  const [gone, setGoneState] = useState(false); // the action was taken away (a refusal that stands)
  const goneRef = useRef(false);
  const [reviewing, setReviewing] = useState(false);
  const reviewingRef = useRef(false); // a second press of "Void invoice…" sends no second review GET
  const [say, setSay] = useState<{ readonly alert: boolean; readonly text: string } | null>(null);
  const [after, setAfter] = useState<{ readonly busy: boolean; readonly failed: string | null }>({ busy: false, failed: null });
  const [confirm, setConfirmState] = useState<VoidConfirm | null>(null);
  const confirmRef = useRef<VoidConfirm | null>(null);
  const confirmSeq = useRef(0);
  const [voidKey, setVoidKey] = useState<string | null>(null); // the attempt pressed from this open (it may outlive its confirmation)
  const [password, setPassword] = useState('');
  const [focusReasons, setFocusReasons] = useState(0);
  const [focusSignIn, setFocusSignIn] = useState(0);
  const pressing = useRef(false);
  const afterFor = useRef<string | null>(null);
  const liveSeen = useRef(new Set<string>()); // attempts for this invoice seen out (or pressed) while this dialog was open
  const vseq = useRef<Record<VoidReadKind, number>>({ elig: 0, review: 0, after: 0, load: 0, renew: 0, renewElig: 0, revElig: 0, revFind: 0, wdFind: 0 });
  const vctl = useRef<Record<VoidReadKind, AbortController | null>>({ elig: null, review: null, after: null, load: null, renew: null, renewElig: null, revElig: null, revFind: null, wdFind: null });
  const setElig = (value: 'allowed' | 'not', gen: number): void => { const next = { value, gen }; eligRef.current = next; setEligState(next); };
  const setRenewal = (out: boolean): void => { renewalRef.current = out; if (alive.current) setRenewalOutState(out); };
  /** An 'allowed' eligibility read under the generation that stands now (R3-1b). */
  const allowedNow = (): boolean => {
    const v = owner.current.voiding;
    return v !== undefined && eligRef.current.value === 'allowed' && eligRef.current.gen === v.generation();
  };
  const takeAway = (): void => { goneRef.current = true; setGoneState(true); };
  const putConfirm = (next: VoidConfirm | null): void => { confirmRef.current = next; setConfirmState(next); };
  // The Payments section (M7B-PAYMENTS-P2A; nothing of it read or rendered without `payments`). The ref is also the
  // double-press guard: a Load more is out while `more`.
  const [pay, setPayState] = useState<PaymentsView>(PAYMENTS_OPENING);
  const payRef = useRef<PaymentsView>(PAYMENTS_OPENING);
  const payStarted = useRef(false);
  const paySeq = useRef(0);
  const payCtl = useRef<AbortController | null>(null);
  const payHeading = useRef<HTMLHeadingElement | null>(null);
  const loadMorePayments = useRef<HTMLButtonElement | null>(null);
  const payRetry = useRef<HTMLButtonElement | null>(null);
  const payRefocus = useRef<HTMLElement | null>(null);
  // Recording (M7B-PAYMENTS-P2B): the one eligibility read of this open (issued invoices only) and its abort.
  const [payElig, setPayElig] = useState<'asking' | 'allowed' | 'not'>('asking');
  const payEligCtl = useRef<AbortController | null>(null);
  // Reversing (M7B-PAYMENTS-P2C; nothing of it read or rendered without `reversing`): its eligibility AND the generation it
  // was read under (only 'allowed' under the generation now permits it, R1), the row being reviewed, what the payments
  // section says about it, the confirmation, and the attempts for this invoice seen live while this dialog was open.
  const [revElig, setRevEligState] = useState<{ readonly value: 'asking' | 'allowed' | 'not'; readonly gen: number }>({ value: 'asking', gen: -1 });
  const revEligRef = useRef<{ readonly value: 'asking' | 'allowed' | 'not'; readonly gen: number }>({ value: 'asking', gen: -1 });
  const setRevElig = (value: 'allowed' | 'not', gen: number): void => { const next = { value, gen }; revEligRef.current = next; setRevEligState(next); };
  const revAllowedNow = (): boolean => {
    const r = owner.current.reversing;
    return r !== undefined && revEligRef.current.value === 'allowed' && revEligRef.current.gen === r.generation();
  };
  const [revReviewing, setRevReviewing] = useState<string | null>(null);
  const revReviewingRef = useRef(false);
  const [revSay, setRevSay] = useState<{ readonly alert: boolean; readonly text: string } | null>(null);
  const [revConfirm, setRevConfirmState] = useState<ReverseConfirm | null>(null);
  const revConfirmRef = useRef<ReverseConfirm | null>(null);
  const putRevConfirm = (next: ReverseConfirm | null): void => { revConfirmRef.current = next; setRevConfirmState(next); };
  const patchRevConfirm = (id: number, next: Partial<ReverseConfirm>): boolean => {
    const c = revConfirmRef.current;
    if (c === null || c.id !== id) return false;
    putRevConfirm({ ...c, ...next });
    return true;
  };
  const revPressing = useRef(false);
  const [revFocusReasons, setRevFocusReasons] = useState(0);
  const [revFocusSignIn, setRevFocusSignIn] = useState(0);
  const [revFocusCard, setRevFocusCard] = useState(0);
  const [revFocusRow, setRevFocusRow] = useState<{ readonly id: string } | null>(null);
  const revCardHeading = useRef<HTMLHeadingElement | null>(null);
  const revLiveSeen = useRef(new Set<string>());
  // Withdrawing a credit note (CN-P3): the review out (its note id), what it said, the confirmation, focus requests.
  const [wdReviewing, setWdReviewing] = useState<string | null>(null);
  const wdReviewingRef = useRef(false);
  const [wdSay, setWdSay] = useState<{ readonly alert: boolean; readonly text: string } | null>(null);
  const [wdConfirm, setWdConfirmState] = useState<WithdrawConfirm | null>(null);
  const wdConfirmRef = useRef<WithdrawConfirm | null>(null);
  const putWdConfirm = (next: WithdrawConfirm | null): void => { wdConfirmRef.current = next; setWdConfirmState(next); };
  const patchWdConfirm = (id: number, next: Partial<WithdrawConfirm>): boolean => {
    const c = wdConfirmRef.current;
    if (c === null || c.id !== id) return false;
    putWdConfirm({ ...c, ...next });
    return true;
  };
  const wdPressing = useRef(false);
  const [wdFocusReasons, setWdFocusReasons] = useState(0);
  const [wdFocusSignIn, setWdFocusSignIn] = useState(0);
  const [wdFocusCard, setWdFocusCard] = useState(0);
  const wdCardHeading = useRef<HTMLHeadingElement | null>(null);
  const wdLiveSeen = useRef(new Set<string>());
  // Issuing a credit note (CN-P2): the confirmation (its values, its sign-in), Continue's review being out, what the review
  // said, and focus requests (the card's heading, the sign-in, "Don't issue"); a ref holds a second press back.
  const [cnConfirm, setCnConfirmState] = useState<CreditConfirm | null>(null);
  const cnConfirmRef = useRef<CreditConfirm | null>(null);
  // P2-46b: read when the confirmation has closed — the action, else the Payments heading (DialogFrame keeps one target object).
  const cnReturn = useRef<RefObject<HTMLElement | null>>({ get current() { return cnAction.current?.isConnected === true ? cnAction.current : payHeading.current; } }).current;
  const putCnConfirm = (next: CreditConfirm | null): void => { cnConfirmRef.current = next; setCnConfirmState(next); };
  const patchCnConfirm = (id: number, next: Partial<CreditConfirm>): boolean => {
    const c = cnConfirmRef.current;
    if (c === null || c.id !== id) return false;
    putCnConfirm({ ...c, ...next });
    return true;
  };
  const [cnReviewing, setCnReviewing] = useState(false);
  const cnReviewingRef = useRef(false);
  // `at`: the credit-note write count when the review said it — a newer write takes the pair back (fix list 5, A1).
  const [cnNote, setCnNoteState] = useState<{ readonly alert: boolean; readonly text: string; readonly at: number } | null>(null);
  const setCnNote = (x: { readonly alert: boolean; readonly text: string } | null): void => setCnNoteState(x === null ? null : { ...x, at: owner.current.crediting?.live.n ?? 0 });
  // The write count when this dialog opened: what is said while its detail still loads is the issuer's to say (A2).
  const cnOpenedAt = useRef(crediting?.live.n ?? 0);
  const [cnReset, setCnReset] = useState(0);
  const [cnFocusCard, setCnFocusCard] = useState(0);
  const [cnFocusSignIn, setCnFocusSignIn] = useState(0);
  const [cnFocusKeep, setCnFocusKeep] = useState(0);
  const cnPressing = useRef(false);
  const cnCardHeading = useRef<HTMLHeadingElement | null>(null);
  const cnAction = useRef<HTMLButtonElement | null>(null);
  const putPay = (next: PaymentsView): void => {
    // Load more (its last page, a change) or Try again (a read starts) going while focused: focus moves to the section's
    // heading, never to the body.
    const focused = document.activeElement;
    if (focused !== null && (focused === loadMorePayments.current || focused === payRetry.current)) payRefocus.current = focused as HTMLElement;
    payRef.current = next;
    setPayState(next);
  };
  useLayoutEffect(() => {
    const was = payRefocus.current;
    if (was === null) return;
    payRefocus.current = null;
    if (!was.isConnected) payHeading.current?.focus();
  });
  /** Change the open confirmation when it is still the one `id` names (a closed or replaced one's continuation changes nothing). */
  const patchConfirm = (id: number, next: Partial<VoidConfirm>): boolean => {
    const c = confirmRef.current;
    if (c === null || c.id !== id) return false;
    putConfirm({ ...c, ...next });
    return true;
  };

  // Never two reads at once: Try again is offered only once a read has ended, so the effect's cleanup is what cancels one.
  async function load(): Promise<void> {
    const n = ++seq.current;
    const controller = new AbortController();
    ctl.current = controller;
    setState(VIEW_LOADING);
    let answer: IssuedReadAnswer | null;
    try { answer = await owner.current.read(storeId, invoiceId, controller.signal); } catch { answer = { kind: 'unavailable' }; }
    if (!alive.current || n !== seq.current) return; // closed, or another read of this dialog took over
    // A context that is gone shows nothing it read — and never leaves "Loading" for good: Try again asks under the owner's context now.
    if (answer === null || !owner.current.current()) return setState({ phase: 'unavailable', text: VIEW_TEXT.unavailable, invoice: null });
    if (answer.kind === 'ok') return setState({ phase: 'ready', text: '', invoice: answer.invoice });
    if (answer.kind === 'rate-limited') return setState({ phase: 'rate-limited', text: answer.text, invoice: null });
    setState({ phase: answer.kind, text: answer.kind === 'not-found' ? VIEW_TEXT.notFound : answer.kind === 'denied' ? VIEW_TEXT.denied : VIEW_TEXT.unavailable, invoice: null });
  }

  /**
   * One payments read: page one (`after` null; what was held goes) or the page after the held cursor, joined only when it
   * continues what is held (paymentsJoin) — otherwise the held rows stay and the change is said, with no read of its own.
   * Its own sequence and abort: a later read, a close or a context gone drops its answer.
   */
  async function loadPayments(after: string | null, keepShown = false): Promise<void> {
    const p = owner.current.payments;
    if (p === undefined) return;
    const n = ++paySeq.current;
    payCtl.current?.abort();
    const controller = new AbortController();
    payCtl.current = controller;
    const held = payRef.current;
    // The rows stay for Load more; a recording's re-read (`keep`, R2 R6) keeps the shown summary and rows too, so nothing
    // under the pointer jumps while it reads (its phase says loading: no Record on the old remaining).
    putPay(after === null ? (keepShown && held.page !== null ? { ...held, phase: 'loading', text: PAYMENTS_TEXT.loading, more: false } : PAYMENTS_LOADING) : { ...held, text: PAYMENTS_TEXT.loading, more: true });
    let answer: PaymentsReadAnswer | null;
    try { answer = await p.read(after, controller.signal); } catch { answer = UNAVAILABLE_PAYMENTS; }
    if (!alive.current || n !== paySeq.current) return; // closed, or another payments read took over
    // Its context is gone (another generation, store or session): a Load more keeps what is held, said as before; page one
    // is never "Loading" for good. Nothing it read is shown.
    if ((answer === null || !owner.current.current()) && after !== null) return putPay({ ...held, more: false });
    if (answer === null || !owner.current.current()) answer = UNAVAILABLE_PAYMENTS;
    if (answer.kind === 'ok') {
      const { page } = answer;
      if (after === null) return putPay({ phase: 'ready', text: page.payments.length === 0 ? PAYMENTS_TEXT.empty : '', page, rows: page.payments, next: page.nextCursor, more: false });
      if (!paymentsJoin(held, page)) return putPay({ ...held, phase: 'changed', text: PAYMENTS_TEXT.changed, next: null, more: false });
      return putPay({ phase: 'ready', text: '', page, rows: [...held.rows, ...page.payments], next: page.nextCursor, more: false });
    }
    const text = answer.kind === 'rate-limited' ? answer.text : answer.kind === 'not-found' ? PAYMENTS_TEXT.notFound : answer.kind === 'denied' ? PAYMENTS_TEXT.denied : PAYMENTS_TEXT.unavailable;
    // A Load more that could not be read keeps what is shown (and its cursor); a refusal or a page one shows nothing read before.
    // R3-11: a recording's re-read (keepShown) that fails keeps the shown summary and rows too, saying the failure.
    // R4-7: only a transient failure keeps it; a refusal (denied, not found) shows nothing read before.
    const transient = answer.kind === 'unavailable' || answer.kind === 'rate-limited';
    const keep = transient && (after !== null || (keepShown && held.page !== null));
    putPay(keep ? { ...held, phase: answer.kind, text, more: false } : { ...PAYMENTS_OPENING, phase: answer.kind, text });
  }

  /** One void-side read of kind `kind`; null when a later read of that kind took over, the dialog closed or its context is gone. */
  async function voidRead<T>(kind: VoidReadKind, run: (signal: AbortSignal) => Promise<T | null>): Promise<T | null> {
    const detail = DETAIL_KINDS.has(kind);
    const n = detail ? ++seq.current : ++vseq.current[kind];
    vctl.current[kind]?.abort();
    const controller = new AbortController();
    vctl.current[kind] = controller;
    let answer: T | null;
    try { answer = await run(controller.signal); } catch { answer = null; }
    const latest = detail ? n === seq.current : n === vseq.current[kind];
    if (!alive.current || !latest || answer === null || !owner.current.current()) return null;
    return answer;
  }
  /** The detail again, keeping what is shown until it answers (never "Loading" over it). */
  const readDetail = (kind: VoidReadKind): Promise<IssuedReadAnswer | null> =>
    voidRead<IssuedReadAnswer>(kind, (signal) => owner.current.read(storeId, invoiceId, signal).catch(() => UNAVAILABLE_READ));
  const readEligibility = (kind: VoidReadKind): Promise<'allowed' | 'not' | null> => {
    const v = owner.current.voiding;
    return v === undefined ? Promise.resolve(null) : voidRead(kind, (signal) => v.eligibility(signal));
  };

  useEffect(() => {
    alive.current = true;
    // The one read of this open. Closing cancels it; so does StrictMode's first unmount — before its session check has
    // answered, so the client sends nothing for it (an aborted signal never reaches fetch): one open, one GET. The void
    // eligibility, when the owner offers the action, is read beside it (its own read, cancelled the same way).
    void load();
    const opened = owner.current.voiding?.generation();
    if (opened !== undefined) void readEligibility('elig').then((answer) => { if (answer !== null) setElig(answer, opened); });
    return () => {
      alive.current = false;
      ctl.current?.abort();
      payCtl.current?.abort();
      payEligCtl.current?.abort();
      for (const controller of Object.values(vctl.current)) controller?.abort();
    };
    // One dialog per open: its store and invoice are fixed for its life.
  }, []);

  // Payments page one: ONCE per open, and only once the detail has answered an invoice (never on a refused or failed detail).
  useEffect(() => {
    if (state.invoice === null || payStarted.current || owner.current.payments === undefined) return;
    payStarted.current = true;
    void loadPayments(null);
    // The recording eligibility: ONE per open, only for an issued invoice (a voided one sends none), after the detail answered.
    const ask = owner.current.payments?.eligibility;
    if (state.invoice.status === 'issued' && ask !== undefined) {
      const controller = new AbortController();
      payEligCtl.current = controller;
      void ask(controller.signal).catch(() => 'not' as const).then((answer) => { if (alive.current && answer !== null && owner.current.current()) setPayElig(answer); });
      // The reversal eligibility (R1): ONE per open, issued invoices only, under the generation it was asked in.
      const r = owner.current.reversing;
      if (r !== undefined) {
        const opened = r.generation();
        void voidRead('revElig', (signal) => r.eligibility(signal)).then((answer) => { if (answer !== null) setRevElig(answer, opened); });
      }
    }
    // Credit notes (CN-P2): the list (a voided invoice's too, D-P2-12) and the owner's lookup, ONE start per open.
    owner.current.crediting?.start();
  }, [state.invoice]);

  // R6/R8: this invoice's reversal attempt, seen live while this dialog was open, settling as reversed — by its own answer,
  // a Retry or a Check payment read — says so and reads the detail and the history again ONCE (whatever pressed it).
  const revHere = reversing?.held !== undefined && reversing.held.storeId === storeId && reversing.held.invoiceId === invoiceId ? reversing.held : undefined;
  if (revHere !== undefined && isLiveReversal(revHere)) revLiveSeen.current.add(revHere.key);
  const revDoneKey = revHere !== undefined && revHere.state === 'reversed' && revLiveSeen.current.has(revHere.key) ? revHere.key : null;
  useEffect(() => {
    if (revDoneKey === null) return;
    revLiveSeen.current.delete(revDoneKey); // once per attempt
    setRevSay({ alert: false, text: REVERSE_TEXT.reversed });
    void reread('after');
    if (payStarted.current) void loadPayments(null, true);
  }, [revDoneKey]);
  useEffect(() => { if (revFocusCard > 0) (revCardHeading.current ?? payHeading.current)?.focus(); }, [revFocusCard]);
  // CN-P3: this invoice's withdrawal attempt, seen live while this dialog was open, settling as withdrawn — by its own answer
  // or a status read — says so and reads the detail, the payments and the credit notes again ONCE.
  const wdHere = withdrawing?.held !== undefined && withdrawing.held.storeId === storeId && withdrawing.held.invoiceId === invoiceId ? withdrawing.held : undefined;
  if (wdHere !== undefined && isLiveWithdrawal(wdHere)) wdLiveSeen.current.add(wdHere.key);
  const wdDoneKey = wdHere !== undefined && wdHere.state === 'withdrawn' && wdLiveSeen.current.has(wdHere.key) ? wdHere.key : null;
  useEffect(() => {
    if (wdDoneKey === null) return;
    wdLiveSeen.current.delete(wdDoneKey); // once per attempt
    const own = owner.current.withdrawing?.held?.attributed === true;
    setWdSay({ alert: false, text: own ? WITHDRAW_TEXT.withdrawn : WITHDRAW_TEXT.seenWithdrawn });
    void reread('after');
    if (payStarted.current) void loadPayments(null, true);
    owner.current.withdrawing?.refresh(own);
  }, [wdDoneKey]);
  useEffect(() => { if (wdFocusCard > 0) (wdCardHeading.current ?? payHeading.current)?.focus(); }, [wdFocusCard]);
  useLayoutEffect(() => {
    if (wdDoneKey === null) return;
    const at = document.activeElement;
    if (at === null || at === document.body) payHeading.current?.focus();
  }, [wdDoneKey]);
  // CN-P2: an outcome that changes this invoice's amounts or state reads its detail and payments again, once per bump.
  const cnRereads = crediting?.rereads ?? 0;
  const cnRereadsSeen = useRef(cnRereads);
  useEffect(() => {
    if (cnRereads === cnRereadsSeen.current) return;
    cnRereadsSeen.current = cnRereads;
    if (cnRereads === 0) return;
    void reread('after');
    if (payStarted.current) void loadPayments(null, true);
  }, [cnRereads]);
  // A timer queued after DialogFrame's own close-time return (the confirmation's), as the reversal's row focus is.
  useEffect(() => {
    if (cnFocusCard === 0) return undefined;
    const timer = setTimeout(() => (cnCardHeading.current ?? payHeading.current)?.focus(), 0);
    return () => clearTimeout(timer);
  }, [cnFocusCard]);
  // R3 after a not-run close (fix2 item 2): the row's Reverse payment (re-rendered once the hold went), else the heading —
  // a timer queued after DialogFrame's own close-time return (its opener, the old row button, is gone).
  useEffect(() => {
    if (revFocusRow === null) return undefined;
    const timer = setTimeout(() => (document.querySelector<HTMLElement>(`[data-testid="issued-payments-reverse"][data-id="${revFocusRow.id}"]`) ?? payHeading.current)?.focus(), 0);
    return () => clearTimeout(timer);
  }, [revFocusRow]);
  // F2: a settle that takes the card away with focus in it hands focus to the payments heading — a layout effect, so it runs
  // before DialogFrame's lost-focus fallback (Close).
  useLayoutEffect(() => {
    if (revDoneKey === null) return;
    const at = document.activeElement;
    if (at === null || at === document.body) payHeading.current?.focus();
  }, [revDoneKey]);

  // Page one again ONCE per bump of this invoice's payment attempt (a recorded payment, a sealed refusal, a lookup
  // confirmation) — never for what was already so when this dialog opened.
  const payHeldHere = payments?.recording?.held;
  const payTag = payHeldHere !== undefined && payHeldHere.storeId === storeId && payHeldHere.invoiceId === invoiceId ? `${payHeldHere.key}:${payHeldHere.rereads}` : null;
  const payTagSeen = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    if (payTagSeen.current === undefined || payTag === payTagSeen.current) { payTagSeen.current = payTag; return; }
    payTagSeen.current = payTag;
    if (payHeldHere !== undefined && payHeldHere.rereads > 0 && payStarted.current) void loadPayments(null, true);
  }, [payTag]);

  // This invoice's attempt, whichever open pressed it (review B1 F1): the user's held attempt for this store and invoice.
  // `watched`: pressed here or seen out while this dialog was open — only its settling makes the dialog read again or say
  // what its key got. `terminal`: a validated 200 or a sealed already-void for it — the invoice is voided now.
  const held = voiding?.held;
  const mine = held !== undefined && held.storeId === storeId && held.invoiceId === invoiceId ? held : undefined;
  if (mine !== undefined && isLiveVoid(mine)) liveSeen.current.add(mine.key); // idempotent, so safe during a render
  const watched = mine !== undefined && (mine.key === voidKey || liveSeen.current.has(mine.key));
  const terminal = voidedBy(mine);
  const voidedHere = watched && mine.state === 'voided';
  const afterKey = watched && (mine.state === 'voided' || (mine.state === 'refused' && mine.refusal !== null && AFTER_REFUSALS.has(mine.refusal))) ? mine.key : null;
  useEffect(() => {
    // Once per settled attempt (afterFor guards it), so `reread` and the confirmation read here are this render's own.
    if (afterKey === null || afterFor.current === afterKey) return;
    afterFor.current = afterKey;
    const settled = owner.current.voiding?.held;
    const c = confirmRef.current;
    // Voided now: no confirmation stays open — but the one that pressed a sealed already-void, which says so (F1).
    if (voidedBy(settled) && c !== null && (settled.state === 'voided' || c.key !== settled.key)) putConfirm(null);
    void reread('after'); // its shared sequence drops a review answer still out (F1)
    // Every settled outcome that re-reads the detail (voided, a sealed already-void, the after-refusals) reads payments page
    // one again ONCE too (afterFor guards it), so the summary never keeps saying amounts of before.
    if (payStarted.current) void loadPayments(null);
  }, [afterKey]);

  /** The re-read after a void's answer, and its "Load again": a GET only, never another POST. */
  async function reread(kind: 'after' | 'load'): Promise<IssuedInvoice | null> {
    setAfter((was) => ({ busy: true, failed: was.failed })); // Load again and its alert stay until this read answers
    const answer = await readDetail(kind);
    if (answer === null) { if (alive.current) setAfter((was) => ({ ...was, busy: false })); return null; }
    if (answer.kind === 'ok') setState({ phase: 'ready', text: '', invoice: answer.invoice });
    else if (answer.kind === 'not-found') setState({ phase: 'not-found', text: VOID_TEXT.gone, invoice: null });
    else if (answer.kind === 'denied') setState({ phase: 'denied', text: VIEW_TEXT.denied, invoice: null });
    setAfter({ busy: false, failed: answer.kind === 'unavailable' ? '' : answer.kind === 'rate-limited' ? answer.text : null });
    return answer.kind === 'ok' ? answer.invoice : null; // the fresh invoice, for a refusal's words (R6)
  }

  /**
   * "Void invoice…": the current context checked and the detail read ONCE more (the review), while the shown invoice and
   * the trigger stay. Voided by now: said, no confirmation. Otherwise the confirmation opens on exactly that read's invoice.
   */
  async function review(): Promise<void> {
    const v = owner.current.voiding;
    // Not during the sign-in (R2-1a) nor its re-reads (R3-1a), and only on this generation's 'allowed' (R3-1b).
    if (v === undefined || reviewingRef.current || confirmRef.current !== null || waiting || v.signingIn || renewalRef.current) return;
    if (revReviewingRef.current || revConfirmRef.current !== null) return; // never beside a reversal review/confirmation (review F3)
    if (!allowedNow() || goneRef.current || state.invoice?.status !== 'issued') return;
    reviewingRef.current = true;
    setReviewing(true);
    setSay(null);
    const reviewGen = v.generation();
    try {
      const answer = await readDetail('review');
      if (answer === null) return;
      if (answer.kind === 'ok') {
        setState({ phase: 'ready', text: '', invoice: answer.invoice });
        if (answer.invoice.status !== 'issued') return setSay({ alert: false, text: VOID_TEXT.alreadyVoided });
        // Read under a generation that is no longer this one: said, and the user reviews again (review B1 R3-3).
        if (owner.current.voiding?.generation() !== reviewGen) return setSay({ alert: true, text: VOID_TEXT.staleReview });
        return putConfirm({
          id: ++confirmSeq.current, invoice: answer.invoice, reason: null, invalid: false, gen: reviewGen, key: null, saving: false, status: null, stepUp: null, confirming: false, renewing: false, decided: false,
        });
      }
      if (answer.kind === 'not-found') return setState({ phase: 'not-found', text: VOID_TEXT.gone, invoice: null });
      if (answer.kind === 'denied') return setState({ phase: 'denied', text: VIEW_TEXT.denied, invoice: null });
      setSay({ alert: true, text: answer.kind === 'rate-limited' ? answer.text : VOID_TEXT.reviewFailed });
    } finally {
      reviewingRef.current = false;
      if (alive.current) setReviewing(false);
    }
  }

  /** "Void invoice": an empty press only says a reason is needed; otherwise ONE send through the owner (a ref holds a second back). */
  async function press(): Promise<void> {
    const v = owner.current.voiding;
    const c = confirmRef.current;
    if (v === undefined || c === null || pressing.current || c.key !== null || c.saving || c.stepUp !== null || c.decided || c.renewing) return;
    // Reviewed under a replaced session: it can never send, and it says so — before anything else holds it back (R2-1c).
    if (c.gen !== v.generation()) {
      putConfirm(null);
      return setSay({ alert: true, text: VOID_TEXT.staleReview });
    }
    if (c.reason === null) {
      patchConfirm(c.id, { invalid: true });
      setFocusReasons((x) => x + 1);
      return; // nothing is sent and no key is minted
    }
    if (waiting || isLiveVoid(v.held) || !allowedNow() || goneRef.current || renewalRef.current) return; // held back: its reason is said
    pressing.current = true;
    const { id } = c;
    patchConfirm(id, { saving: true, status: null, invalid: false });
    try {
      const out = await v.send({
        invoiceId, number: c.invoice.number, reasonCode: c.reason,
        open: () => alive.current && confirmRef.current?.id === id,
        allowed: () => alive.current && allowedNow() && !goneRef.current, // this generation's 'allowed' only (R3-1b)
        held: (key) => { patchConfirm(id, { key }); if (alive.current) setVoidKey(key); },
        reviewGen: c.gen,
      });
      if (!alive.current || out === null) return;
      // A standing denial takes the action away whether or not its confirmation is still open (review B1 F2).
      if (out.kind === 'denied' && out.gone) {
        takeAway();
        setSay({ alert: true, text: out.text });
      }
      if (confirmRef.current?.id !== id) return;
      if (out.kind === 'stale') { putConfirm(null); return setSay({ alert: true, text: VOID_TEXT.staleReview }); } // nothing sent (R2-1c)
      if (out.kind === 'not-sent') return void patchConfirm(id, { key: null, status: { alert: true, text: out.text } }); // nothing held or sent
      if (out.kind === 'step-up') {
        // With no sign-in this page can offer, the alert never asks for one (review B1 truth LOW-4).
        patchConfirm(id, { key: null, stepUp: { method: out.method }, status: { alert: true, text: out.method === null ? VOID_TEXT.stepUpNoMethod : VOID_TEXT.stepUp } });
        return setFocusSignIn((x) => x + 1);
      }
      if (out.kind === 'rate-limited') return void patchConfirm(id, { key: null, status: { alert: true, text: out.text } });
      if (out.kind === 'denied') return void patchConfirm(id, { key: null, decided: true, status: { alert: true, text: out.text } });
    } finally {
      pressing.current = false;
      if (alive.current) patchConfirm(id, { saving: false });
    }
  }

  /**
   * The void's explicit sign-in (after a first send's step_up_required): the owner renews the session keeping this dialog;
   * then the invoice and its eligibility are read again — voided, missing or no longer allowed closes the confirmation and
   * the dialog says so; otherwise the confirmation stays, its reason cleared, for a NEW press (a new key). Never a send.
   */
  async function signIn(): Promise<void> {
    const v = owner.current.voiding;
    const c = confirmRef.current;
    if (v === undefined || c === null || c.stepUp === null || c.stepUp.method === null || c.confirming || waiting) return;
    const secret = c.stepUp.method === 'password' ? password : null;
    if (secret === '') return; // nothing typed: the control says so, and nothing is asked
    const { id } = c;
    const open = (): boolean => confirmRef.current?.id === id;
    setPassword('');
    patchConfirm(id, { confirming: true, status: null });
    let out: VoidSignIn | null;
    try { out = await v.signIn(secret); } catch { out = { kind: 'failed', text: VOID_TEXT.reauthFailed }; }
    if (!alive.current) return;
    if (out === null) return void patchConfirm(id, { confirming: false });
    if (out.kind === 'failed') {
      if (!open()) return;
      patchConfirm(id, { confirming: false, status: { alert: true, text: out.text } });
      return setFocusSignIn((x) => x + 1);
    }
    // The renewal's generation, taken BEFORE its reads (review B1 R3-2), and the second hold on the action until both are
    // applied (R3-1a) — on every exit, including a closed confirmation or the dialog going.
    const renewGen = v.generation();
    setRenewal(true);
    try {
      await applyRenewal(id, open, renewGen);
    } finally {
      setRenewal(false);
    }
  }

  /** The renewal's re-reads (the detail and the eligibility under the new session) and what they decide. */
  async function applyRenewal(id: number, open: () => boolean, renewGen: number): Promise<void> {
    patchConfirm(id, { confirming: false, stepUp: null, renewing: true, reason: null, invalid: false, status: { alert: false, text: VOID_TEXT.renewing } });
    // The invoice and its eligibility are read again under the new session even when Keep invoice is pressed during these
    // reads (review B1 L2): the dialog never keeps showing what the old session read. (Pressed during the sign-in itself, it
    // ends the wait (R1): no renewal comes back to this dialog then.)
    const detailRead = readDetail('renew');
    const detailRev = seq.current; // this read's place in the shared detail sequence
    const [answered, allowed] = await Promise.all([detailRead, readEligibility('renewElig')]);
    if (!alive.current) return;
    // Applied only if no newer detail read started meanwhile (review B1 R2-2): a newer one's answer is what stands.
    const detail = answered !== null && detailRev === seq.current ? answered : null;
    if (detail?.kind === 'ok') setState({ phase: 'ready', text: '', invoice: detail.invoice });
    if (detail?.kind === 'not-found') setState({ phase: 'not-found', text: VOID_TEXT.gone, invoice: null });
    if (detail?.kind === 'denied') setState({ phase: 'denied', text: VIEW_TEXT.denied, invoice: null });
    if (detail?.kind === 'ok' && detail.invoice.status !== 'issued') setSay({ alert: false, text: VOID_TEXT.alreadyVoided });
    // An unread renewal eligibility (aborted, failed, superseded) is 'not' under the renewal generation, the R14 way as at
    // open (review B1 R4-1): no action in this open, never held for good on the older generation's 'allowed', never said
    // as "not allowed"; the confirmation keeps its renewUnread text below.
    setElig(allowed ?? 'not', renewGen);
    // Voided, missing, refused or no longer allowed: WHATEVER confirmation this dialog has open closes (review B1 R2-1b),
    // not only the one that asked for the sign-in, and the dialog shows that state.
    const closes = allowed === 'not' || detail?.kind === 'not-found' || detail?.kind === 'denied' || (detail?.kind === 'ok' && detail.invoice.status !== 'issued');
    if (closes) return putConfirm(null);
    if (!open()) return;
    if (detail === null || allowed === null) return void patchConfirm(id, { renewing: false, decided: true, status: { alert: true, text: VOID_TEXT.renewUnread } });
    if (detail.kind !== 'ok') {
      return void patchConfirm(id, { renewing: false, decided: true, status: { alert: true, text: detail.kind === 'rate-limited' ? `${VOID_TEXT.renewUnread} ${detail.text}` : VOID_TEXT.renewUnread } });
    }
    // Reviewed again under the new generation: a new press (a new key) may send from it (R2-1c).
    patchConfirm(id, { renewing: false, invoice: detail.invoice, gen: renewGen, status: { alert: false, text: VOID_TEXT.renewed } });
    setFocusReasons((x) => x + 1);
  }

  // ---- reversing a payment (M7B-PAYMENTS-P2C) ----

  /**
   * R2 checks, shared by the review and the renewal: the detail (issued), the eligibility (allowed) and the exact payment
   * (R7: found and not reversed). Each failure is said; the confirmation then never opens (or closes). Null: context gone.
   */
  async function revChecks(r: IssuedReversalCapability, paymentId: string, gen: number, kinds: { readonly detail: VoidReadKind; readonly still?: () => boolean }): Promise<{ readonly payment: InvoicePayment; readonly number: number } | null> {
    // A renewal's failure is said only while the confirmation that asked is still open (fix3 req 2): nothing about a closed one.
    const fail = (text: string, alert = true): null => { if (alive.current && (kinds.still?.() ?? true)) setRevSay({ alert, text }); return null; };
    const detail = await readDetail(kinds.detail);
    if (detail === null) return null;
    if (detail.kind === 'not-found') { setState({ phase: 'not-found', text: VOID_TEXT.gone, invoice: null }); return fail(REVERSE_TEXT.gone); }
    if (detail.kind !== 'ok') return fail(detail.kind === 'rate-limited' ? detail.text : REVERSE_TEXT.unconfirmed);
    setState({ phase: 'ready', text: '', invoice: detail.invoice });
    if (detail.invoice.status !== 'issued') return fail(REVERSE_TEXT.voided);
    const elig = await voidRead('revElig', (signal) => r.eligibility(signal));
    if (elig === null) return null;
    setRevElig(elig, gen);
    if (elig !== 'allowed') return fail(REVERSE_TEXT.notAllowed);
    const found = await voidRead('revFind', (signal) => r.find(paymentId, signal));
    if (found === null) return null;
    if (found.kind !== 'found') return fail(found.kind === 'missing' ? REVERSE_TEXT.missing : REVERSE_TEXT.unconfirmed);
    if (found.status !== 'issued') return fail(REVERSE_TEXT.voided);
    if (found.payment.reversal !== null) { if (payStarted.current) void loadPayments(null, true); return fail(REVERSE_TEXT.alreadyReversed, false); }
    return { payment: found.payment, number: detail.invoice.number };
  }

  /** R2: a row's "Reverse payment" — the checks above, while the trigger stays; the confirmation opens on what they read. */
  async function reviewReverse(paymentId: string): Promise<void> {
    const r = owner.current.reversing;
    // Never beside a void review or confirmation of this invoice (review F3): on entry, and again before it opens.
    const voidOut = (): boolean => reviewingRef.current || confirmRef.current !== null;
    if (r === undefined || revReviewingRef.current || revConfirmRef.current !== null || voidOut() || r.signingIn || waiting) return;
    revReviewingRef.current = true;
    setRevReviewing(paymentId);
    setRevSay(null);
    const gen = r.generation();
    try {
      const fit = await revChecks(r, paymentId, gen, { detail: 'review' });
      if (fit === null || !alive.current) return;
      if (gen !== r.generation()) return setRevSay({ alert: true, text: REVERSE_TEXT.staleReview });
      if (voidOut()) return setRevSay({ alert: true, text: REVERSE_TEXT.voidFirst });
      putRevConfirm({
        id: ++confirmSeq.current, payment: fit.payment, number: fit.number, reason: null, invalid: false, gen, sending: false, status: null, stepUp: null, confirming: false, renewing: false,
      });
    } finally {
      revReviewingRef.current = false;
      if (alive.current) setRevReviewing(null);
    }
  }

  /** R4/R6: the confirmation's "Reverse payment": ONE send (a ref holds a second press back); its outcome said. */
  async function pressReverse(): Promise<void> {
    const r = owner.current.reversing;
    const c = revConfirmRef.current;
    if (r === undefined || c === null || revPressing.current || c.sending || c.stepUp !== null || c.renewing || c.confirming || waiting) return;
    if (c.reason === null) { patchRevConfirm(c.id, { invalid: true, status: null }); return setRevFocusReasons((x) => x + 1); }
    const { id } = c;
    const open = (): boolean => alive.current && revConfirmRef.current?.id === id;
    revPressing.current = true;
    patchRevConfirm(id, { sending: true, status: null, invalid: false });
    let out: ReverseSendOutcome | null;
    try {
      out = await r.send({
        invoiceId, number: c.number, payment: c.payment, reasonCode: c.reason, reviewGen: c.gen, open, allowed: revAllowedNow,
        held: (key) => { revLiveSeen.current.add(key); },
      });
    } catch {
      out = { kind: 'not-sent', text: REVERSE_TEXT.notRun };
    } finally {
      revPressing.current = false;
    }
    if (!alive.current || out === null) return void patchRevConfirm(id, { sending: false });
    switch (out.kind) {
      case 'stale': putRevConfirm(null); return setRevSay({ alert: true, text: REVERSE_TEXT.staleReview });
      case 'not-sent': return void patchRevConfirm(id, { sending: false, status: { alert: true, text: out.text } });
      case 'not-run':
        // The server ran nothing and the key is gone: another press would need a NEW R2 review (fix2 item 2) — so it closes
        // (focus back per R3) and the section's alert says why.
        if (open()) { putRevConfirm(null); setRevFocusRow({ id: c.payment.id }); }
        return setRevSay({ alert: true, text: out.text });
      case 'step-up':
        // R5: only a first send's step-up — nothing ran, the key is gone; the sign-in group opens here.
        patchRevConfirm(id, { sending: false, stepUp: { method: out.method }, status: { alert: true, text: out.method === null ? REVERSE_TEXT.stepUpNoMethod : REVERSE_TEXT.stepUp } });
        return setRevFocusSignIn((x) => x + 1);
      case 'refused': {
        // R6: a sealed refusal; a fresh invoice and history read says why (exact row reversed, voided, or neither).
        if (open()) putRevConfirm(null);
        const found = await voidRead('revFind', (signal) => r.find(c.payment.id, signal));
        const freshRead = reread('after');
        if (payStarted.current) void loadPayments(null, true);
        const fresh = await freshRead;
        if (!alive.current) return;
        if (found?.kind === 'found' && found.payment.reversal !== null) return setRevSay({ alert: false, text: REVERSE_TEXT.alreadyReversed });
        // Voided by either fresh read — the invoice's own, even when the history read failed (SII-244).
        if ((found?.kind === 'found' && found.status !== 'issued') || (fresh !== null && fresh.status !== 'issued')) return setRevSay({ alert: true, text: REVERSE_TEXT.voided });
        return setRevSay({ alert: true, text: REVERSE_TEXT.cannotNow });
      }
      default:
        // Sent: the hold says what, by key. Reversed: the effect above says it and reads again; unresolved: its card.
        if (!open()) return;
        putRevConfirm(null);
        setRevFocusCard((x) => x + 1);
    }
  }

  /** R5: the sign-in after a first send's step-up; success re-runs the R2 checks and keeps the confirmation for a NEW press. */
  async function signInReverse(): Promise<void> {
    const r = owner.current.reversing;
    const c = revConfirmRef.current;
    if (r === undefined || c === null || c.stepUp === null || c.stepUp.method === null || c.confirming || waiting) return;
    const secret = c.stepUp.method === 'password' ? password : null;
    if (secret === '') return;
    const { id } = c;
    const open = (): boolean => revConfirmRef.current?.id === id;
    setPassword('');
    patchRevConfirm(id, { confirming: true, status: null });
    let out: VoidSignIn | null;
    try { out = await r.signIn(secret); } catch { out = { kind: 'failed', text: VOID_TEXT.reauthFailed }; }
    if (!alive.current) return;
    if (out === null) return void patchRevConfirm(id, { confirming: false });
    if (out.kind === 'failed') {
      if (!open()) return;
      patchRevConfirm(id, { confirming: false, status: { alert: true, text: out.text } });
      return setRevFocusSignIn((x) => x + 1);
    }
    // Only the generation THIS sign-in produced, and only for the confirmation that started it (fix3 req 1/2, review-3 LOW-1/2):
    // closed meanwhile it stays closed and nothing is said; another session since closes it, never another confirmation.
    const renewGen = out.gen;
    const ours = (): boolean => alive.current && open();
    if (!ours()) return;
    if (renewGen !== r.generation()) return putRevConfirm(null);
    patchRevConfirm(id, { confirming: false, stepUp: null, renewing: true, reason: null, invalid: false, status: { alert: false, text: REVERSE_TEXT.renewing } });
    const fit = await revChecks(r, c.payment.id, renewGen, { detail: 'renew', still: open });
    if (!ours()) return;
    if (fit === null || renewGen !== r.generation()) return putRevConfirm(null); // anything that no longer fits closes it (and is said)
    patchRevConfirm(id, { renewing: false, payment: fit.payment, number: fit.number, gen: renewGen, status: { alert: false, text: REVERSE_TEXT.renewed } });
    setRevFocusReasons((x) => x + 1);
  }

  // ---- withdrawing a credit note (M7B-CREDITNOTES-CN-P3; the reversal's pattern) ----

  /** The review's checks, shared with the renewal: the detail (issued), then the exact note (found and active). Each failure is said. */
  async function wdChecks(w: IssuedWithdrawCapability, noteId: string, kind: VoidReadKind, still?: () => boolean): Promise<{ readonly note: InvoiceCreditNote; readonly number: number } | null> {
    const fail = (text: string, alert = true): null => { if (alive.current && (still?.() ?? true)) setWdSay({ alert, text }); return null; };
    const detail = await readDetail(kind);
    if (detail === null) return null;
    if (detail.kind === 'not-found') { setState({ phase: 'not-found', text: VOID_TEXT.gone, invoice: null }); return fail(WITHDRAW_TEXT.gone); }
    if (detail.kind !== 'ok') return fail(detail.kind === 'rate-limited' ? detail.text : WITHDRAW_TEXT.unconfirmed);
    setState({ phase: 'ready', text: '', invoice: detail.invoice });
    if (detail.invoice.status !== 'issued') return fail(WITHDRAW_TEXT.voided);
    const found = await voidRead('wdFind', (signal) => w.find(noteId, signal));
    if (found === null) return null;
    if (found.kind !== 'found') return fail(found.kind === 'missing' ? WITHDRAW_TEXT.missing : WITHDRAW_TEXT.unconfirmed);
    if (found.note.withdrawal !== null) { w.refresh(false); return fail(WITHDRAW_TEXT.alreadyWithdrawn, false); }
    return { note: found.note, number: detail.invoice.number };
  }

  /** Never beside another review or confirmation in this dialog (void, reversal, credit note). */
  const wdOtherOut = (): boolean => reviewingRef.current || confirmRef.current !== null || revReviewingRef.current || revConfirmRef.current !== null || cnConfirmRef.current !== null;

  /** A row's "Withdraw credit note…": the checks above, while the trigger stays; the confirmation opens on what they read. */
  async function reviewWithdraw(noteId: string): Promise<void> {
    const w = owner.current.withdrawing;
    if (w === undefined || wdReviewingRef.current || wdConfirmRef.current !== null || wdOtherOut() || w.signingIn || waiting) return;
    wdReviewingRef.current = true;
    setWdReviewing(noteId);
    setWdSay(null);
    const gen = w.generation();
    try {
      const fit = await wdChecks(w, noteId, 'review');
      if (fit === null || !alive.current) return;
      if (gen !== w.generation()) return setWdSay({ alert: true, text: WITHDRAW_TEXT.staleReview });
      if (wdOtherOut()) return setWdSay({ alert: true, text: WITHDRAW_TEXT.otherFirst });
      putWdConfirm({ id: ++confirmSeq.current, note: fit.note, number: fit.number, reason: null, invalid: false, gen, sending: false, status: null, stepUp: null, confirming: false, renewing: false });
    } finally {
      wdReviewingRef.current = false;
      if (alive.current) setWdReviewing(null);
    }
  }

  /** The confirmation's "Withdraw credit note": ONE send (a ref holds a second press back); its outcome said. */
  async function pressWithdraw(): Promise<void> {
    const w = owner.current.withdrawing;
    const c = wdConfirmRef.current;
    if (w === undefined || c === null || wdPressing.current || c.sending || c.stepUp !== null || c.renewing || c.confirming || waiting) return;
    if (c.reason === null) { patchWdConfirm(c.id, { invalid: true, status: null }); return setWdFocusReasons((x) => x + 1); }
    const { id } = c;
    const open = (): boolean => alive.current && wdConfirmRef.current?.id === id;
    const blocked = (): boolean => owner.current.crediting?.hidesHere === true || owner.current.crediting?.hidesSignIns === true;
    wdPressing.current = true;
    patchWdConfirm(id, { sending: true, status: null, invalid: false });
    let out: ReverseSendOutcome | null;
    try {
      out = await w.send({ invoiceId, number: c.number, note: c.note, reason: c.reason, reviewGen: c.gen, open, blocked, held: (key) => { wdLiveSeen.current.add(key); } });
    } catch {
      out = { kind: 'not-sent', text: WITHDRAW_TEXT.notRun };
    } finally {
      wdPressing.current = false;
    }
    if (!alive.current || out === null) return void patchWdConfirm(id, { sending: false });
    switch (out.kind) {
      case 'stale': putWdConfirm(null); return setWdSay({ alert: true, text: WITHDRAW_TEXT.staleReview });
      case 'not-sent': return void patchWdConfirm(id, { sending: false, status: { alert: true, text: out.text } });
      case 'not-run':
        // Nothing ran and the key is gone: another press needs a new review, so it closes and the section says why.
        if (open()) putWdConfirm(null);
        return setWdSay({ alert: true, text: out.text });
      case 'step-up':
        // Reactive: a first send's 403 step_up_required ran nothing; the sign-in group opens, and only a NEW press sends.
        if (!open()) return; // closed meanwhile: the card says the sign-in path
        patchWdConfirm(id, { sending: false, stepUp: { method: out.method }, status: { alert: true, text: out.method === null ? WITHDRAW_TEXT.stepUpNoMethod : WITHDRAW_TEXT.stepUp } });
        return setWdFocusSignIn((x) => x + 1);
      case 'refused': {
        // Sealed (invalid_state: already withdrawn): fresh reads of the note, the invoice and its credit notes say why.
        if (open()) putWdConfirm(null);
        const found = await voidRead('wdFind', (signal) => w.find(c.note.id, signal));
        const fresh = await reread('after');
        if (payStarted.current) void loadPayments(null, true);
        w.refresh(false);
        if (!alive.current) return;
        if (found?.kind === 'found' && found.note.withdrawal !== null) return setWdSay({ alert: false, text: WITHDRAW_TEXT.alreadyWithdrawn });
        if (fresh !== null && fresh.status !== 'issued') return setWdSay({ alert: true, text: WITHDRAW_TEXT.voided });
        return setWdSay({ alert: true, text: WITHDRAW_TEXT.cannotNow });
      }
      default:
        // Sent: the hold says what, by key. Withdrawn: the effect above says it and reads again; unresolved: its card.
        if (!open()) return;
        putWdConfirm(null);
        setWdFocusCard((x) => x + 1);
    }
  }

  /** The sign-in after a first send's step-up: success re-runs the checks and keeps the confirmation for a NEW press (never a send). */
  async function signInWithdraw(): Promise<void> {
    const w = owner.current.withdrawing;
    const c = wdConfirmRef.current;
    if (w === undefined || c === null || c.stepUp === null || c.stepUp.method === null || c.confirming || waiting) return;
    const secret = c.stepUp.method === 'password' ? password : null;
    if (secret === '') return;
    const { id } = c;
    const open = (): boolean => wdConfirmRef.current?.id === id;
    setPassword('');
    patchWdConfirm(id, { confirming: true, status: null });
    let out: VoidSignIn | null;
    try { out = await w.signIn(secret); } catch { out = { kind: 'failed', text: VOID_TEXT.reauthFailed }; }
    if (!alive.current) return;
    if (out === null) return void patchWdConfirm(id, { confirming: false });
    if (out.kind === 'failed') {
      if (!open()) return;
      patchWdConfirm(id, { confirming: false, status: { alert: true, text: out.text } });
      return setWdFocusSignIn((x) => x + 1);
    }
    const renewGen = out.gen;
    const ours = (): boolean => alive.current && open();
    if (!ours()) return;
    if (renewGen !== w.generation()) return putWdConfirm(null);
    patchWdConfirm(id, { confirming: false, stepUp: null, renewing: true, reason: null, invalid: false, status: { alert: false, text: WITHDRAW_TEXT.renewing } });
    const fit = await wdChecks(w, c.note.id, 'renew', open);
    if (!ours()) return;
    if (fit === null || renewGen !== w.generation()) return putWdConfirm(null);
    patchWdConfirm(id, { renewing: false, note: fit.note, number: fit.number, gen: renewGen, status: { alert: false, text: WITHDRAW_TEXT.renewed } });
    setWdFocusReasons((x) => x + 1);
  }

  function closeWithdrawConfirm(): void {
    owner.current.withdrawing?.stopSignIn(); // Keep or Escape while its sign-in is waited for: the wait ends here
    putWdConfirm(null);
    setPassword('');
  }

  // ---- issuing a credit note (CN-P2, doc 17 §2.4-§2.6) ----

  /**
   * Continue's review (§2.4), and the same after a sign-in: the detail, the payments read and the lookup again, one at a
   * time, and this invoice's list beside them (the D-P2-15 baseline, never waited for). 'open' only for an issued invoice,
   * an amount within the remaining just read, and a lookup read to the end with no unfinished row of this owner here.
   */
  async function creditReview(cents: number, kind: VoidReadKind): Promise<{ readonly fit: 'open' | 'over' | 'closed'; readonly number: number; readonly remaining: number } | null> {
    const cr = owner.current.crediting;
    if (cr === undefined) return null;
    setCnNote(null);
    const closed = (text: string | null): { readonly fit: 'closed'; readonly number: number; readonly remaining: number } => {
      if (text !== null) setCnNote({ alert: true, text });
      return { fit: 'closed', number: 0, remaining: 0 };
    };
    const detail = await readDetail(kind);
    if (detail === null) return null;
    if (detail.kind !== 'ok') return closed(detail.kind === 'rate-limited' ? detail.text : VIEW_TEXT.unavailable);
    setState({ phase: 'ready', text: '', invoice: detail.invoice });
    if (detail.invoice.status !== 'issued') return closed(CREDIT_TEXT.reviewVoided);
    cr.listNow();
    await loadPayments(null, true);
    if (!alive.current) return null;
    const page = payRef.current.phase === 'ready' ? payRef.current.page : null;
    if (page === null || page.invoice.status !== 'issued') return closed(page === null ? PAYMENTS_TEXT.unavailable : CREDIT_TEXT.reviewVoided);
    const fact = { number: detail.invoice.number, remaining: page.amounts.remainingCents };
    if (cents > page.amounts.remainingCents) return { fit: 'over', ...fact };
    const lookup = await cr.lookupNow();
    if (!alive.current || lookup === null) return null;
    if (lookup.phase !== 'exhausted') return closed(null); // lookupFailed / lookupIncomplete: the lookup's own region says it
    const live = owner.current.crediting?.held;
    if (lookup.rows.some((x) => x.state === 'open' || x.state === 'issued') || isOpenCreditNote(live)) return closed(CREDIT_TEXT.unfinished);
    return { fit: 'open', ...fact };
  }
  /** The form's Continue: the review, then the confirmation on what it read ('over': the amount is over the remaining just read). */
  async function creditContinue(cents: number, reason: InvoiceCreditNoteReason): Promise<{ readonly kind: 'over'; readonly remaining: number } | { readonly kind: 'closed' | 'open' | 'none' }> {
    const cr = owner.current.crediting;
    if (cr === undefined || cnReviewingRef.current || cnConfirmRef.current !== null || waiting) return { kind: 'none' };
    cnReviewingRef.current = true;
    setCnReviewing(true);
    const opened = cr.generation();
    try {
      const fit = await creditReview(cents, 'review');
      if (fit === null || !alive.current) return { kind: 'none' };
      if (fit.fit === 'over') return { kind: 'over', remaining: fit.remaining };
      if (fit.fit === 'closed' || opened !== cr.generation()) return { kind: 'closed' };
      putCnConfirm({
        id: ++confirmSeq.current, grossCents: cents, reason, number: fit.number, remaining: fit.remaining, gen: opened, sending: false, stepUp: null, confirming: false, renewing: false, status: null,
      });
      return { kind: 'open' };
    } finally {
      cnReviewingRef.current = false;
      if (alive.current) setCnReviewing(false);
    }
  }
  /** No shop-observed sign-in fit for a first send (§2.5): the sign-in group, saying why; nothing is sent. */
  function creditNeedsSignIn(id: number, expired: CreditNoteSignIn | null): void {
    const method = owner.current.crediting?.reauthMethod() ?? null;
    patchCnConfirm(id, { sending: false, stepUp: { method }, status: { alert: true, text: expired === null ? CREDIT_TEXT.signInNeeded : CREDIT_TEXT.signInExpired(clockText(expired.wall)) } });
    setCnFocusSignIn((x) => x + 1);
  }
  /** The confirmation's "Issue credit note": ONE press (a ref holds a second back); the chain is the section's, by attempt. */
  async function creditPress(): Promise<void> {
    const cr = owner.current.crediting;
    const c = cnConfirmRef.current;
    if (cr?.issue === undefined || c === null || cnPressing.current || c.sending || c.stepUp !== null || c.renewing || c.confirming || waiting) return;
    const { id } = c;
    if (c.gen !== cr.generation()) return putCnConfirm(null); // reviewed under an earlier session: never sent (the reversal's staleReview)
    if (cr.freshSignIn() === null) return creditNeedsSignIn(id, cr.lastSignIn());
    cnPressing.current = true;
    patchCnConfirm(id, { sending: true, status: null });
    let out: CreditIssueOutcome;
    try {
      out = await cr.issue({ invoiceId, number: c.number, grossCents: c.grossCents, reason: c.reason });
    } finally {
      cnPressing.current = false;
    }
    if (!alive.current) return;
    if (out.kind === 'sign-in') return creditNeedsSignIn(id, out.expired);
    if (out.kind === 'not-sent') return void patchCnConfirm(id, { sending: false, status: { alert: true, text: out.text } });
    if (out.kind === 'stale') return putCnConfirm(null);
    // The chain answered (or a stage passed its 30 s): the confirmation closes and the card says it — focus to its heading
    // only when the confirmation was still open (focus elsewhere is left where the user put it).
    if (cnConfirmRef.current?.id === id) { putCnConfirm(null); setCnFocusCard((x) => x + 1); }
    setCnReset((x) => x + 1);
  }
  /** The sign-in group's press (the void's sign-in, one owner, 30 s): success keeps the values (D-P2-8 A) and re-runs the review; a new press is needed. */
  async function creditSignIn(): Promise<void> {
    const cr = owner.current.crediting;
    const c = cnConfirmRef.current;
    if (cr === undefined || c === null || c.stepUp === null || c.stepUp.method === null || c.confirming || waiting) return;
    const secret = c.stepUp.method === 'password' ? password : null;
    if (secret === '') return;
    const { id } = c;
    const open = (): boolean => alive.current && cnConfirmRef.current?.id === id;
    setPassword('');
    patchCnConfirm(id, { confirming: true, status: null });
    let out: VoidSignIn | null;
    try { out = await cr.signIn(secret); } catch { out = { kind: 'failed', text: VOID_TEXT.reauthFailed }; }
    if (!open()) return;
    if (out === null) return void patchCnConfirm(id, { confirming: false }); // Stop waiting: nothing was sent, nothing to say
    if (out.kind === 'failed') {
      patchCnConfirm(id, { confirming: false, status: { alert: true, text: out.text === VOID_TEXT.signInTimedOut ? CREDIT_TEXT.signInTimeout : out.text } });
      return setCnFocusSignIn((x) => x + 1);
    }
    const renewGen = out.gen;
    if (renewGen !== cr.generation()) return putCnConfirm(null);
    patchCnConfirm(id, { confirming: false, stepUp: null, renewing: true, status: null });
    const fit = await creditReview(c.grossCents, 'renew');
    if (!open()) return;
    if (fit === null || fit.fit !== 'open' || renewGen !== cr.generation()) {
      // Anything that no longer fits closes it, with its reason (§2.5).
      if (fit?.fit === 'over') setCnNote({ alert: true, text: CREDIT_TEXT.errOver(formatCents(fit.remaining)) });
      return putCnConfirm(null);
    }
    const at = cr.lastSignIn();
    patchCnConfirm(id, {
      renewing: false, number: fit.number, remaining: fit.remaining, gen: renewGen,
      status: at === null ? null : { alert: false, text: CREDIT_TEXT.signedIn(clockText(at.wall), clockText(at.wall + CREDIT_NOTE_FIRST_SEND_MS)) },
    });
    setCnFocusKeep((x) => x + 1);
  }
  /** "Don't issue" / "Close" / Escape: closes, never aborts; in flight the section says closedInFlight; a sign-in wait ends. */
  function closeCreditConfirm(): void {
    const c = cnConfirmRef.current;
    owner.current.crediting?.stopSignIn();
    if (c?.sending === true) owner.current.crediting?.closedInFlight();
    // Only the dialog closes (doc 17 §2.6 focus table): the form keeps its values; DialogFrame sends focus to `cnReturn`.
    putCnConfirm(null);
    setPassword('');
  }

  function closeReverseConfirm(): void {
    owner.current.reversing?.stopSignIn(); // Keep payment or Escape while its sign-in is waited for: the wait ends here
    putRevConfirm(null);
    setPassword('');
  }

  function closeConfirm(): void {
    owner.current.voiding?.stopSignIn(); // Keep invoice or Escape while its sign-in is waited for: the wait ends here (R1)
    putConfirm(null);
    setPassword('');
  }

  const invoice = state.invoice;
  // Allowed under this generation; or allowed under an older one — not yet known again (a renewal's read is out): the
  // trigger is then shown but held with the checking reason, never as "not allowed" (review B1 R3-1b).
  const eligNow = voiding !== undefined && elig.value === 'allowed' && elig.gen === voiding.generation();
  const eligOld = voiding !== undefined && elig.value === 'allowed' && elig.gen !== voiding.generation();
  // R8: while this invoice has an unresolved reversal attempt, neither Void nor Record payment shows on it.
  const revLiveHere = revHere !== undefined && isLiveReversal(revHere);
  const wdLiveHere = wdHere !== undefined && isLiveWithdrawal(wdHere); // CN-P3: the same for an unresolved withdrawal here
  const showTrigger = voiding !== undefined && (eligNow || eligOld) && !gone && invoice !== null && invoice.status === 'issued' && !terminal && !revLiveHere && !wdLiveHere
    && revReviewing === null && wdReviewing === null // nor while a reversal or withdrawal review is out (review F3)
    && crediting?.hidesHere !== true && crediting?.hidesSignIns !== true; // nor beside a credit-note attempt here, or one a sign-in would detach (D-P2-10 A)
  // R1: Reverse shows only on an 'allowed' read under this generation, an issued invoice whose payments page says issued and
  // is not loading, no unresolved record, reversal or void attempt of this user anywhere, and a dialog that is not terminal.
  const canReverse = reversing !== undefined && revElig.value === 'allowed' && revElig.gen === reversing.generation() && !reversing.blocked
    && invoice !== null && invoice.status === 'issued' && pay.phase === 'ready' && pay.page?.invoice.status === 'issued' && !terminal
    && !reviewing && confirm === null // nor while a void review or confirmation is out (review F3)
    && wdReviewing === null && wdConfirm === null
    && crediting?.hidesHere !== true && crediting?.hidesSignIns !== true; // D-P2-10 A, as for Void
  // CN-P3: Withdraw only for the store owner (the lookup answered 200: `owner`; anything else hides it), on an issued invoice,
  // with no unresolved void, payment or reversal attempt of this user anywhere nor withdrawal on this invoice (R2), no other
  // review or confirmation here, and no credit-note attempt here or one a sign-in would detach. The server stays the judge
  // of the write gate (the shop has no signal for it).
  const canWithdraw = withdrawing !== undefined && crediting?.owner === true && !withdrawing.blocked && invoice !== null && invoice.status === 'issued' && !terminal
    && !reviewing && confirm === null && revReviewing === null && revConfirm === null && cnConfirm === null
    && crediting.hidesHere !== true && crediting.hidesSignIns !== true;
  // Once this invoice is known voided (a 200 or a sealed already-void for an attempt of this user), no confirmation is
  // shown — but the one that pressed an already-void, which says so — and it goes in the commit that hides the trigger
  // (design R17): focus then goes to Close, never to a control that is gone.
  const showConfirm = confirm !== null && !(terminal && (mine.state === 'voided' || confirm.key !== mine.key));
  const triggerWhy = reviewing ? 'issued-view-void-busy' : voiding?.signingIn === true ? 'issued-view-void-signin'
    : renewalOut || eligOld ? 'issued-view-void-busy' : waiting ? 'issued-view-void-wait' : undefined;
  const old = mine !== undefined && mine.state === 'unresolved' && (voiding?.expired === true || mine.body === '');
  // What the dialog says on top (review B1 F2/F5): its review being out, this invoice's attempt — out or unconfirmed (where
  // it is tracked once the dialog closes), voided, or refused — whether or not the confirmation that sent it is still open.
  const voidStatus: ReactNode = voidedHere ? VOID_TEXT.voided(mine.number)
    : reviewing ? VOID_TEXT.reviewing
      : say !== null && !say.alert ? say.text
        : mine !== undefined && isLiveVoid(mine) ? <>{voidStateText(mine, old)} {VOID_TEXT.heldOutside}</> : '';
  const voidAlert = after.failed !== null
    ? `${voidedHere ? VOID_TEXT.voidedUnread(mine.number) : VOID_TEXT.afterUnread}${after.failed === '' ? '' : ` ${after.failed}`}`
    : say?.alert === true ? say.text
      : watched && mine.state === 'refused' ? refusalTextOf(mine, voiding?.confirmedDenial ?? null) : '';
  // Known voided while no read has said so yet (a re-read failed or is still out): the status says Voided; the void time
  // and reason come only from a read, never from the held attempt (review B1 F3).
  const statusShown: IssuedStatus | null = invoice === null ? null : terminal && invoice.status === 'issued' ? 'voided' : invoice.status;
  return (
    <>
      <DialogFrame labelledBy="issued-view-title" testId="issued-view" anchor="top" busy={state.phase === 'loading'} onClose={onClose} initialFocus={closeButton} returnFocus={returnFocus}>
        <div className="flex items-start justify-between gap-3">
          <h2 id="issued-view-title" data-testid="issued-view-title" className="text-xl font-black text-primary tracking-tight break-words min-w-0">
            {invoice === null ? VIEW_TEXT.title : `Invoice ${invoice.number}`}
          </h2>
          <button ref={closeButton} type="button" data-testid="issued-view-close" onClick={onClose} className={quiet}>Close</button>
        </div>
        {voiding !== undefined && (
          // Under the header, before the invoice (design R14): the row's height is held from the open on, so a late
          // eligibility answer moves nothing; only "allowed" and an issued invoice put the action in it. Its status and alert
          // regions are in place, empty, before their first text.
          <div data-testid="issued-view-void-area">
            {/* The row's height is the trigger's own, at any text size and wrap, in every state of this open (review B1 L-1):
                an invisible copy of it shares the grid cell from the open on — aria-hidden, nothing focusable, its text
                generated content so the DOM says nothing (the drafts' discard row's pattern) — so the eligibility answer,
                whatever it is, and the trigger going later move nothing below it. No fixed min-height. */}
            <div data-testid="issued-view-void-row" className="grid">
              <div aria-hidden="true" data-testid="issued-view-void-placeholder" className="invisible col-start-1 row-start-1 flex flex-wrap items-center gap-3">
                <span data-reserve={VOID_TEXT.open} className={`${quiet} ${fitsRow} before:content-[attr(data-reserve)]`} />
              </div>
              <div data-testid="issued-view-void-cell" className="col-start-1 row-start-1 flex flex-wrap items-center gap-3">
              {showTrigger && (
                <button
                  type="button" data-testid="issued-view-void" aria-haspopup="dialog" aria-disabled={triggerWhy !== undefined} aria-describedby={triggerWhy}
                  onClick={() => { void review(); }} className={`${quiet} ${waitable} ${fitsRow}`}
                >
                  {VOID_TEXT.open}
                </button>
              )}
              {showTrigger && triggerWhy === 'issued-view-void-busy' && <span id={triggerWhy} className="sr-only">{VOID_TEXT.reviewing}</span>}
              {showTrigger && triggerWhy === 'issued-view-void-wait' && <span id={triggerWhy} className="sr-only">{VOID_TEXT.reviewWaiting}</span>}
              {showTrigger && triggerWhy === 'issued-view-void-signin' && <span id={triggerWhy} className="sr-only">{VOID_TEXT.reviewSignIn}</span>}
              </div>
            </div>
            <p data-testid="issued-view-void-status" role="status" className="text-sm font-bold text-emerald-800">{voidStatus}</p>
            <p data-testid="issued-view-void-alert" role="alert" className="text-sm font-bold text-rose-800">{voidAlert}</p>
            {after.failed !== null && (
              // Stays mounted through its own read (aria-disabled, said why): focus never falls off it (review B1 react).
              <div className="flex flex-wrap items-center gap-3">
                <button
                  type="button" data-testid="issued-view-void-load" aria-disabled={waiting || after.busy}
                  aria-describedby={after.busy ? 'issued-view-void-load-busy' : waiting ? 'issued-view-void-load-wait' : undefined}
                  onClick={() => { if (!waiting && !after.busy) void reread('load'); }} className={`${quiet} ${waitable} ${fitsRow}`}
                >
                  Load again
                </button>
                {after.busy && <span id="issued-view-void-load-busy" className="sr-only">{VIEW_TEXT.loading}</span>}
                {waiting && !after.busy && <span id="issued-view-void-load-wait" className="sr-only">{VIEW_TEXT.waiting}</span>}
              </div>
            )}
          </div>
        )}
        {state.phase !== 'ready' && (
          <p data-testid="issued-view-state" data-phase={state.phase} role={state.phase === 'loading' ? 'status' : 'alert'} className="text-sm font-bold text-slate-600">{state.text}</p>
        )}
        {(state.phase === 'unavailable' || state.phase === 'rate-limited') && (
          <>
            <button
              type="button" data-testid="issued-view-retry" aria-disabled={waiting} aria-describedby={waiting ? 'issued-view-wait' : undefined}
              aria-label="Try again: load this invoice" onClick={() => { if (!waiting) void load(); }}
              className={`${quiet} aria-disabled:opacity-50 aria-disabled:cursor-not-allowed`}
            >
              Try again
            </button>
            {waiting && <span id="issued-view-wait" className="sr-only">{VIEW_TEXT.waiting}</span>}
          </>
        )}
        {invoice !== null && (
          <div className="space-y-4">
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
              <dt className={labelClass}>Status</dt><dd data-testid="issued-view-status" className="font-bold text-slate-700">{STATUS_TEXT[statusShown ?? invoice.status]}</dd>
              <dt className={labelClass}>Issued at</dt>
              {/* The time may wrap at its spaces (never inside the date or the clock): at 320 px it is wider than its column (SIS-09). */}
              <dd className="font-bold text-slate-700 min-w-0"><time data-testid="issued-view-issued-at" dateTime={invoice.issuedAt}>{utcText(invoice.issuedAt)}</time></dd>
              {invoice.void !== null && (
                <>
                  <dt className={labelClass}>Voided at</dt>
                  <dd className="font-bold text-slate-700 min-w-0"><time data-testid="issued-view-voided-at" dateTime={invoice.void.voidedAt}>{utcText(invoice.void.voidedAt)}</time></dd>
                  <dt className={labelClass}>Reason</dt>
                  <dd data-testid="issued-view-void-reason" className="font-bold text-slate-700 min-w-0 break-words">{INVOICE_VOID_REASONS[invoice.void.reasonCode]}</dd>
                </>
              )}
              <RecordId key={invoice.id} label="Invoice record ID" id={invoice.id} copyName="Copy ID (invoice record)" testId="issued-view-id" />
            </dl>
            <InvoiceSnapshot prefix="issued-view" seller={invoice.seller} customerName={invoice.customer.name} lines={invoice.lines} amounts={invoice.amounts} />
            <p data-testid="issued-view-note" className={hintClass}>{VIEW_TEXT.note}</p>
          </div>
        )}
        {payments !== undefined && invoice !== null && (
          // Read-only (M7B-PAYMENTS-P2A): the server's amounts and word over the whole history — never a sum made here — and
          // the pages read so far, oldest first. Summary amounts wrap only when they cannot fit; text wraps (320 px).
          <section aria-labelledby="issued-payments-title" data-testid="issued-payments" className="space-y-3">
            <h3 ref={payHeading} id="issued-payments-title" tabIndex={-1} className="text-base font-black text-primary">{PAYMENTS_TEXT.title}</h3>
            {pay.page !== null && (
              // Stacked below sm: beside its label the largest amount overflows a 320 px dialog (SIS-09, CI run 42911307850).
              <dl className="grid grid-cols-1 sm:grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
                <dt className={labelClass}>Payment status</dt>
                <dd data-testid="issued-payments-status" className="font-bold text-slate-700 min-w-0 break-words">{INVOICE_PAYMENT_STATUSES[pay.page.paymentStatus]}</dd>
                {pay.page.invoice.status === 'issued' && (
                  // A voided invoice shows the word only (CN-37): the snapshot Total stays above; no "$0.00" amounts rows beside it.
                  <>
                    {/* The Total, never "due": after a credit it is not what is owed (CN-31); Remaining is. */}
                    <dt className={labelClass}>Invoice total</dt>
                    <dd className="font-bold text-slate-700"><span data-testid="issued-payments-due" className="[overflow-wrap:anywhere]">{formatCents(pay.page.amounts.dueCents)}</span></dd>
                    <dt className={labelClass}>Credited</dt>
                    <dd className="font-bold text-slate-700"><span data-testid="issued-payments-credited" className="[overflow-wrap:anywhere]">{formatCents(pay.page.amounts.creditedCents)}</span></dd>
                    <dt className={labelClass}>Recorded</dt>
                    <dd className="font-bold text-slate-700"><span data-testid="issued-payments-recorded" className="[overflow-wrap:anywhere]">{formatCents(pay.page.amounts.appliedCents)}</span></dd>
                    <dt className={labelClass}>Remaining</dt>
                    <dd className="font-bold text-slate-700"><span data-testid="issued-payments-remaining" className="[overflow-wrap:anywhere]">{formatCents(pay.page.amounts.remainingCents)}</span></dd>
                  </>
                )}
              </dl>
            )}
            <p data-testid="issued-payments-note" className={hintClass}>{PAYMENTS_TEXT.note}</p>
            {/* Above the state line and the list (R2 R6): what a re-read changes never moves the recording controls. */}
            {payments.recording !== undefined && (
              <PaymentRecorder
                storeId={storeId} invoiceId={invoiceId} number={invoice.number} page={pay.phase === 'ready' ? pay.page : null} allowed={payElig === 'allowed' && !revLiveHere && !wdLiveHere && crediting?.hidesHere !== true} reversing={revLiveHere || wdLiveHere}
                waiting={waiting} recording={payments.recording} headingRef={payHeading}
              />
            )}
            {crediting !== undefined && (
              <CreditIssuer
                c={crediting} offered={crediting.issue !== undefined && crediting.gateOpen && invoice.status === 'issued' && pay.page !== null && pay.page.invoice.status === 'issued'}
                remaining={pay.page !== null && pay.page.invoice.status === 'issued' ? pay.page.amounts.remainingCents : 0} waiting={waiting} reviewing={cnReviewing}
                resetTag={cnReset} note={cnNote} since={cnOpenedAt.current} headingRef={payHeading} actionRef={cnAction} onContinue={creditContinue} confirmOpen={cnConfirm !== null || (voiding !== undefined && showConfirm && confirm !== null) || (reversing !== undefined && revConfirm !== null)}
              />
            )}
            {crediting?.held !== undefined && !crediting.held.hidden && crediting.card !== null && (
              <CreditCard
                prefix="issued-payments-credit-card" held={crediting.held} view={crediting.card} number={crediting.number} busy={crediting.busy} waiting={waiting}
                headingRef={cnCardHeading} focusFind={crediting.focusFind}
                onConfirm={() => { cnCardHeading.current?.focus(); crediting.confirm(); }} onFind={() => { cnCardHeading.current?.focus(); crediting.find(); }}
                onCheck={() => { cnCardHeading.current?.focus(); crediting.check(); }} onContinue={(another) => { cnCardHeading.current?.focus(); crediting.proceed(another); }}
                onHide={() => { payHeading.current?.focus(); crediting.hide(); }} onRetry={crediting.retryNumber}
              />
            )}
            {crediting !== undefined && <CreditLookupState lookup={crediting.lookup} waiting={waiting} headingRef={payHeading} onRetry={crediting.retryLookup} onContinue={crediting.continueChecking} />}
            {crediting !== undefined && (
              <CreditRows lookup={crediting.lookup} busy={crediting.busy} waiting={waiting} canSettle={crediting.issue !== undefined} openOther={crediting.openAttempt} headingRef={payHeading} onSettle={crediting.settleRow} />
            )}
            {reversing !== undefined && (
              // R8: the reversal's always-mounted status and alert regions, and this invoice's held attempt (its card).
              <div data-testid="issued-reverse-area" className="space-y-2">
                <p data-testid="issued-reverse-status" role="status" className="text-sm font-bold text-emerald-800">{revReviewing !== null ? REVERSE_TEXT.reviewing : revSay !== null && !revSay.alert ? revSay.text : ''}</p>
                <p data-testid="issued-reverse-alert" role="alert" className="text-sm font-bold text-rose-800">{revSay?.alert === true ? revSay.text : ''}</p>
                {revHere !== undefined && (revHere.state !== 'reversed' || !revHere.attributed) && (
                  <ReversalCard
                    held={revHere} expired={reversing.expired} waiting={waiting} cooling={reversing.cooling} finding={reversing.finding} checkText={reversing.checkText}
                    // F2: the card's heading takes focus before Retry/Check can take their own controls away (the void's precedent).
                    headingRef={revCardHeading} onRetry={() => { revCardHeading.current?.focus(); reversing.retry(); }}
                    onCheck={() => { revCardHeading.current?.focus(); reversing.check(); }}
                    onDismiss={() => { payHeading.current?.focus(); reversing.dismiss(); }}
                  />
                )}
              </div>
            )}
            <p data-testid="issued-payments-state" data-phase={pay.phase} role={pay.phase === 'denied' ? 'alert' : 'status'} className="text-sm font-bold text-slate-600">{pay.text}</p>
            {(pay.phase === 'not-found' || pay.phase === 'denied' || pay.phase === 'unavailable' || pay.phase === 'rate-limited') && (
              <button
                ref={payRetry} type="button" data-testid="issued-payments-retry" aria-disabled={waiting || pay.more} aria-describedby={waiting ? 'issued-payments-wait' : undefined}
                aria-label="Try again: load the payments" onClick={() => { if (!waiting && !payRef.current.more) void loadPayments(null); }} className={`${quiet} ${waitable}`}
              >
                Try again
              </button>
            )}
            {pay.rows.length > 0 && (
              <ol data-testid="issued-payments-list" aria-label="Payments recorded for this invoice" className="divide-y divide-slate-100 border border-slate-100 rounded-2xl">
                {pay.rows.map((p) => (
                  <li key={p.id} data-testid="issued-payments-item" data-id={p.id} className="px-4 py-3 text-sm min-w-0 break-words">
                    <p className="font-bold text-slate-700">
                      <span data-testid="issued-payments-amount" className="whitespace-nowrap">{formatCents(p.amountCents)}</span>
                      {' · '}<span data-testid="issued-payments-method">{INVOICE_PAYMENT_METHODS[p.method]}</span>
                      {p.reversal !== null && <>{' · '}<span data-testid="issued-payments-reversed" className="text-rose-800">{PAYMENTS_TEXT.reversed}</span></>}
                    </p>
                    <p className={hintClass}>Recorded at <time data-testid="issued-payments-recorded-at" dateTime={p.recordedAt}>{utcText(p.recordedAt)}</time></p>
                    {canReverse && p.reversal === null && (
                      // R1: in its own row, wrapping at 320 px / 24 px text; aria-disabled (never disabled) while a review is out.
                      <button
                        type="button" data-testid="issued-payments-reverse" data-id={p.id} aria-haspopup="dialog" aria-label={REVERSE_TEXT.openLabel(formatCents(p.amountCents))}
                        aria-disabled={revReviewing !== null || waiting} aria-describedby={revReviewing === p.id ? 'issued-reverse-reviewing' : undefined}
                        onClick={() => { if (revReviewing === null && !waiting) void reviewReverse(p.id); }} className={`mt-1 ${quiet} ${waitable} ${fitsRow}`}
                      >
                        {REVERSE_TEXT.open}
                      </button>
                    )}
                    {revReviewing === p.id && <span id="issued-reverse-reviewing" className="sr-only">{REVERSE_TEXT.reviewing}</span>}
                    {p.reversal !== null && (
                      <p className={hintClass}>
                        Reversed at <time data-testid="issued-payments-reversed-at" dateTime={p.reversal.reversedAt}>{utcText(p.reversal.reversedAt)}</time>
                        {' · '}Reason <span data-testid="issued-payments-reason">{INVOICE_PAYMENT_REVERSAL_REASONS[p.reversal.reasonCode]}</span>
                      </p>
                    )}
                  </li>
                ))}
              </ol>
            )}
            {pay.next !== null && (
              // aria-disabled, never disabled: it keeps focus through its own read (a press meanwhile does nothing).
              <button
                ref={loadMorePayments} type="button" data-testid="issued-payments-load-more" aria-disabled={waiting || pay.more}
                aria-describedby={pay.more ? 'issued-payments-busy' : waiting ? 'issued-payments-wait' : undefined}
                onClick={() => { const held = payRef.current; if (!waiting && !held.more && held.next !== null) void loadPayments(held.next); }} className={`${quiet} ${waitable}`}
              >
                {PAYMENTS_TEXT.loadMore}
              </button>
            )}
            {pay.more && <span id="issued-payments-busy" className="sr-only">{PAYMENTS_TEXT.loading}</span>}
            {waiting && <span id="issued-payments-wait" className="sr-only">{PAYMENTS_TEXT.waiting}</span>}
            {withdrawing !== undefined && (
              // CN-P3: the withdrawal's always-mounted status and alert regions, and this invoice's held attempt (its card).
              <div data-testid="issued-payments-cn-withdraw-area" className="space-y-2">
                <p data-testid="issued-payments-cn-withdraw-status" role="status" className="text-sm font-bold text-emerald-800">{wdReviewing !== null ? WITHDRAW_TEXT.reviewing : wdSay !== null && !wdSay.alert ? wdSay.text : ''}</p>
                <p data-testid="issued-payments-cn-withdraw-alert" role="alert" className="text-sm font-bold text-rose-800">{wdSay?.alert === true ? wdSay.text : ''}</p>
                {wdHere !== undefined && wdHere.state !== 'withdrawn' && (
                  <WithdrawalCard
                    held={wdHere} waiting={waiting} finding={withdrawing.finding} checkText={withdrawing.checkText} confirmedDenial={withdrawing.confirmedDenial} headingRef={wdCardHeading}
                    onCheck={withdrawing.check} onDismiss={() => { payHeading.current?.focus(); withdrawing.dismiss(); }}
                  />
                )}
              </div>
            )}
            {crediting !== undefined && (
              <CreditNotesSection
                list={crediting.list} owner={crediting.owner} waiting={waiting} paymentsHeading={payHeading} onMore={crediting.showMore} onRetry={crediting.retryList}
                canWithdraw={canWithdraw} reviewingId={wdReviewing} onWithdraw={(id) => { void reviewWithdraw(id); }}
              />
            )}
          </section>
        )}
      </DialogFrame>
      {voiding !== undefined && showConfirm && confirm !== null && (
        <VoidConfirmDialog
          c={confirm} store={storeLabel(voiding.store)} held={voiding.held} confirmedDenial={voiding.confirmedDenial} expired={voiding.expired} waiting={waiting} cooling={voiding.cooling}
          finding={voiding.finding} checkText={voiding.checkText} password={password} focusReasons={focusReasons} focusSignIn={focusSignIn}
          onPassword={setPassword}
          onReason={(code) => {
            const c = confirmRef.current;
            if (c !== null && c.key === null && !c.saving && c.stepUp === null && !c.decided && !c.renewing) patchConfirm(c.id, { reason: code, invalid: false });
          }}
          onPress={() => { void press(); }} onClose={closeConfirm} onCheck={voiding.check} onFind={voiding.find} onSignIn={() => { void signIn(); }} onStopSignIn={voiding.stopSignIn} returnFocus={closeButton}
        />
      )}
      {crediting !== undefined && cnConfirm !== null && (
        <CreditConfirmDialog
          c={cnConfirm} waiting={waiting} password={password} focusSignIn={cnFocusSignIn} focusKeep={cnFocusKeep} onPassword={setPassword}
          onPress={() => { void creditPress(); }} onClose={closeCreditConfirm} onSignIn={() => { void creditSignIn(); }} onStopSignIn={crediting.stopSignIn}
          returnFocus={cnReturn}
        />
      )}
      {reversing !== undefined && revConfirm !== null && (
        // R3: focus goes back to the row's Reverse payment (what had it), else to the payments heading.
        <ReverseConfirmDialog
          c={revConfirm} store={storeLabel(reversing.store)} waiting={waiting} password={password} focusReasons={revFocusReasons} focusSignIn={revFocusSignIn}
          onPassword={setPassword}
          onReason={(code) => {
            const c = revConfirmRef.current;
            if (c !== null && !c.sending && c.stepUp === null && !c.renewing && !c.confirming) patchRevConfirm(c.id, { reason: code, invalid: false });
          }}
          onPress={() => { void pressReverse(); }} onClose={closeReverseConfirm} onSignIn={() => { void signInReverse(); }} onStopSignIn={reversing.stopSignIn}
          returnFocus={payHeading}
        />
      )}
      {withdrawing !== undefined && wdConfirm !== null && (
        // Focus goes back to the row's Withdraw credit note… (what had it), else to the payments heading.
        <WithdrawConfirmDialog
          c={wdConfirm} waiting={waiting} password={password} focusReasons={wdFocusReasons} focusSignIn={wdFocusSignIn} onPassword={setPassword}
          onReason={(code) => {
            const c = wdConfirmRef.current;
            if (c !== null && !c.sending && c.stepUp === null && !c.renewing && !c.confirming) patchWdConfirm(c.id, { reason: code, invalid: false });
          }}
          onPress={() => { void pressWithdraw(); }} onClose={closeWithdrawConfirm} onSignIn={() => { void signInWithdraw(); }} onStopSignIn={withdrawing.stopSignIn}
          returnFocus={payHeading}
        />
      )}
    </>
  );
}

/**
 * The attempts lookup's state where the issue action goes (doc 17 §2.2): failed → lookupFailed and Try again (a new lookup
 * from page one); incomplete → lookupIncomplete and Continue checking (from the last good cursor). Its alert region is in
 * place, empty, before its first text; a pressed button stays through its own read (aria-disabled), and one that goes while
 * focused hands focus to the Payments heading.
 */
function CreditLookupState({ lookup, waiting, headingRef, onRetry, onContinue }: {
  readonly lookup: CreditNotesLookup | null; readonly waiting: boolean; readonly headingRef: RefObject<HTMLHeadingElement | null>;
  readonly onRetry: () => void; readonly onContinue: () => void;
}) {
  const [pressed, setPressed] = useState<'retry' | 'continue' | null>(null);
  const focused = useRef<HTMLButtonElement | null>(null); // the button pressed while it had focus
  const phase = lookup?.phase ?? null;
  const loading = phase === 'loading';
  useLayoutEffect(() => {
    const was = focused.current;
    if (loading) return;
    if (pressed !== null) setPressed(null);
    focused.current = null;
    if (was !== null && !was.isConnected && (document.activeElement === null || document.activeElement === document.body)) headingRef.current?.focus();
  });
  const press = (which: 'retry' | 'continue', target: HTMLButtonElement): void => {
    if (loading || waiting) return;
    if (document.activeElement === target) focused.current = target;
    setPressed(which);
    (which === 'retry' ? onRetry : onContinue)();
  };
  const text = phase === 'failed' ? CREDIT_TEXT.lookupFailed : phase === 'incomplete' ? CREDIT_TEXT.lookupIncomplete : '';
  const why = loading ? 'issued-payments-credit-lookup-busy' : waiting ? 'issued-payments-credit-lookup-wait' : undefined;
  const describedBy = ['issued-payments-credit-lookup-alert', why].filter(Boolean).join(' ');
  return (
    // Its phase and this invoice's row count (never an attempt id) are on the area for the issue side's controls and the tests.
    <div data-testid="issued-payments-credit-lookup" data-phase={phase ?? 'idle'} data-rows={lookup?.rows.length ?? 0} className="space-y-2">
      <p id="issued-payments-credit-lookup-alert" data-testid="issued-payments-credit-lookup-alert" role="alert" className="text-sm font-bold text-rose-800">{text}</p>
      {(phase === 'failed' || (loading && pressed === 'retry')) && (
        <button
          type="button" data-testid="issued-payments-credit-lookup-retry" aria-disabled={loading || waiting} aria-describedby={describedBy}
          onClick={(e) => press('retry', e.currentTarget)} className={`${quiet} ${waitable} ${fitsRow}`}
        >
          {CREDIT_TEXT.tryAgain}
        </button>
      )}
      {(phase === 'incomplete' || (loading && pressed === 'continue')) && (
        <button
          type="button" data-testid="issued-payments-credit-lookup-continue" aria-disabled={loading || waiting} aria-describedby={describedBy}
          onClick={(e) => press('continue', e.currentTarget)} className={`${quiet} ${waitable} ${fitsRow}`}
        >
          {CREDIT_TEXT.continueChecking}
        </button>
      )}
      {loading && pressed !== null && <span id="issued-payments-credit-lookup-busy" className="sr-only">{VIEW_TEXT.loading}</span>}
      {waiting && !loading && <span id="issued-payments-credit-lookup-wait" className="sr-only">{LIST_TEXT.waiting}</span>}
    </div>
  );
}

/**
 * The invoice's credit notes (doc 17 §4.1, D-P2-1; a voided invoice's too, D-P2-12): a "Credit notes" heading one level
 * below Payments and a list oldest first, one item per note in the doc's order — "CN-<n>", "Active" or "Withdrawn" as
 * words, the gross amount, the reason, "Issued {time}", a withdrawal's time and reason, and the names only when the page
 * carried them (null: "Name not set"). Tax and net are never shown (D-P2-7). The empty texts only after a read to the end;
 * a failed read never shows its rows as complete. Show more keeps focus and says "{n} more loaded."; if it goes, focus
 * moves to the first new item (tabindex -1 until it blurs), else to the list's heading.
 */
function CreditNotesSection({ list, owner, waiting, paymentsHeading, onMore, onRetry, canWithdraw = false, reviewingId = null, onWithdraw }: {
  readonly list: CreditNotesList | null; readonly owner: boolean; readonly waiting: boolean; readonly paymentsHeading: RefObject<HTMLHeadingElement | null>;
  readonly onMore: () => void; readonly onRetry: () => void;
  /** CN-P3: each active note's "Withdraw credit note…" (the owner's, decided by the dialog); aria-disabled while a review is out. */
  readonly canWithdraw?: boolean; readonly reviewingId?: string | null; readonly onWithdraw?: (id: string) => void;
}) {
  const heading = useRef<HTMLHeadingElement | null>(null);
  const more = useRef<HTMLButtonElement | null>(null);
  const retry = useRef<HTMLButtonElement | null>(null);
  const morePressed = useRef<number | null>(null); // the notes shown when Show more was pressed with focus on it
  const retryPressed = useRef<HTMLButtonElement | null>(null);
  const [retrying, setRetrying] = useState(false);
  const [focusId, setFocusId] = useState<string | null>(null);
  const phase = list?.phase ?? null;
  const out = phase === 'loading' || list?.more === true;
  useLayoutEffect(() => {
    if (list === null || out) return;
    if (retrying) setRetrying(false);
    const was = retryPressed.current;
    retryPressed.current = null;
    if (was !== null && !was.isConnected && (document.activeElement === null || document.activeElement === document.body)) paymentsHeading.current?.focus();
    const count = morePressed.current;
    morePressed.current = null;
    if (count === null || more.current !== null) return; // Show more still there: focus stays on it
    const at = document.activeElement;
    if (at !== null && at !== document.body) return;
    if (retry.current !== null) return retry.current.focus();
    const first = list.notes[count];
    if (first === undefined) return heading.current?.focus();
    setFocusId(first.id);
  });
  useLayoutEffect(() => {
    if (focusId !== null) document.querySelector<HTMLElement>(`[data-testid="issued-payments-credit-item"][data-id="${focusId}"]`)?.focus();
  }, [focusId]);
  const failed = phase === 'failed' || phase === 'denied';
  const text = list === null ? '' : phase === 'loading' ? CREDIT_TEXT.listLoading : failed ? CREDIT_TEXT.listFailed
    : list.complete && list.notes.length === 0 ? (owner ? `${CREDIT_TEXT.listEmpty} ${CREDIT_TEXT.listEmptyOwner}` : CREDIT_TEXT.listEmpty) : list.said;
  const moreWhy = list?.more === true ? 'issued-payments-credit-busy' : waiting ? 'issued-payments-credit-wait' : undefined;
  return (
    <div data-testid="issued-payments-credit-notes" className="space-y-2">
      <h4 ref={heading} id="issued-payments-credit-title" data-testid="issued-payments-credit-title" tabIndex={-1} className={`text-sm font-black text-primary ${focusRing}`}>{CREDIT_TEXT.listTitle}</h4>
      <p id="issued-payments-credit-state" data-testid="issued-payments-credit-state" data-phase={phase ?? 'idle'} role="status" className="text-sm font-bold text-slate-600">{text}</p>
      {(failed || (retrying && out)) && (
        <button
          ref={retry} type="button" data-testid="issued-payments-credit-retry" aria-disabled={out || waiting}
          aria-describedby={['issued-payments-credit-state', out ? 'issued-payments-credit-busy' : waiting ? 'issued-payments-credit-wait' : ''].filter(Boolean).join(' ')}
          onClick={(e) => {
            if (out || waiting) return;
            if (document.activeElement === e.currentTarget) retryPressed.current = e.currentTarget;
            setRetrying(true);
            onRetry();
          }}
          className={`${quiet} ${waitable} ${fitsRow}`}
        >
          {CREDIT_TEXT.tryAgain}
        </button>
      )}
      {list !== null && list.notes.length > 0 && (
        <ul data-testid="issued-payments-credit-list" aria-labelledby="issued-payments-credit-title" className="divide-y divide-slate-100 border border-slate-100 rounded-2xl">
          {list.notes.map((note) => (
            <li
              key={note.id} data-testid="issued-payments-credit-item" data-id={note.id} tabIndex={focusId === note.id ? -1 : undefined}
              onBlur={() => { if (focusId === note.id) setFocusId(null); }} className={`px-4 py-3 text-sm min-w-0 break-words ${focusRing}`}
            >
              <CreditNoteFacts note={note} prefix="issued-payments-credit" />
              {canWithdraw && note.withdrawal === null && onWithdraw !== undefined && (
                <>
                  <button
                    type="button" data-testid="issued-payments-cn-withdraw" data-id={note.id} aria-haspopup="dialog" aria-describedby={`issued-cn-withdraw-for-${note.id}`}
                    aria-disabled={reviewingId !== null || waiting} onClick={() => { if (reviewingId === null && !waiting) onWithdraw(note.id); }}
                    className={`mt-1 ${quiet} ${waitable} ${fitsRow}`}
                  >
                    {WITHDRAW_TEXT.open}
                  </button>
                  <span id={`issued-cn-withdraw-for-${note.id}`} className="sr-only">{reviewingId === note.id ? WITHDRAW_TEXT.reviewing : WITHDRAW_TEXT.forNote(note.number, formatCents(note.grossCents))}</span>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
      {list !== null && list.phase === 'ready' && list.next !== null && (
        <button
          ref={more} type="button" data-testid="issued-payments-credit-more" aria-disabled={list.more || waiting} aria-describedby={moreWhy}
          onClick={(e) => {
            if (list.more || waiting) return;
            if (document.activeElement === e.currentTarget) morePressed.current = list.notes.length;
            onMore();
          }}
          className={`${quiet} ${waitable} ${fitsRow}`}
        >
          {CREDIT_TEXT.showMore}
        </button>
      )}
      {out && <span id="issued-payments-credit-busy" className="sr-only">{CREDIT_TEXT.listLoading}</span>}
      {waiting && !out && <span id="issued-payments-credit-wait" className="sr-only">{LIST_TEXT.waiting}</span>}
    </div>
  );
}

/** R5 B: the lookup of this store's invoice lists an unsettled attempt, which holds the invoice's slot: no new Record until it is settled. */
/** The credit-note confirmation (doc 17 §2.5): the values the review fixed, its sign-in, and what it says. */
interface CreditConfirm {
  readonly id: number;
  readonly grossCents: number;
  readonly reason: InvoiceCreditNoteReason;
  readonly number: number;
  /** The remaining amount the review read. */
  readonly remaining: number;
  readonly gen: number;
  readonly sending: boolean;
  readonly stepUp: { readonly method: 'password' | 'google' | null } | null;
  readonly confirming: boolean;
  readonly renewing: boolean;
  readonly status: { readonly alert: boolean; readonly text: string } | null;
}
const CREDIT_REASON_CODES = Object.keys(INVOICE_CREDIT_NOTE_REASONS) as readonly InvoiceCreditNoteReason[];

/**
 * "Issue credit note" and its form (doc 17 §2.1-§2.4) beside Record payment: shown only while the lookup gate is open on an
 * issued invoice; aria-disabled with its reason otherwise (§2.3). The form validates on Continue (one alert summary, the
 * first invalid control focused, nothing sent) and hands its values to the review; the section pair speaks inline here.
 */
function CreditIssuer({ c, offered, remaining, waiting, reviewing, resetTag, note: noteSaid, since, headingRef, actionRef, onContinue, confirmOpen }: {
  readonly c: IssuedCreditCapability; readonly offered: boolean; readonly remaining: number; readonly waiting: boolean; readonly reviewing: boolean;
  /** The confirmation is open (the page behind is inert): this pair waits, so what was said there mounts when it closes. */
  readonly confirmOpen: boolean;
  readonly resetTag: number; readonly note: { readonly alert: boolean; readonly text: string; readonly at: number } | null; readonly since: number;
  readonly headingRef: RefObject<HTMLHeadingElement | null>; readonly actionRef: RefObject<HTMLButtonElement | null>;
  readonly onContinue: (cents: number, reason: InvoiceCreditNoteReason) => Promise<{ readonly kind: 'over'; readonly remaining: number } | { readonly kind: 'closed' | 'open' | 'none' }>;
}) {
  const [formOpen, setFormOpen] = useState(false);
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState<InvoiceCreditNoteReason | null>(null);
  const [errors, setErrors] = useState<{ readonly amount: string; readonly reason: string }>({ amount: '', reason: '' });
  const [focusFirst, setFocusFirst] = useState(0);
  const [focusAction, setFocusAction] = useState(0);
  const amountRef = useRef<HTMLInputElement | null>(null);
  const formRef = useRef<HTMLFormElement | null>(null);
  const firstReason = useRef<HTMLInputElement | null>(null);
  const resetSeen = useRef(resetTag);
  // Mounted empty (§2.6): only what is said after this pair mounted, never an earlier transition's text.
  // The floor moves on as a confirmation opens: what was said before it is not mounted again when it closes (P2-53).
  const floor = useRef(since);
  const note = noteSaid !== null && noteSaid.at >= c.live.n ? noteSaid : null; // a later credit-note write takes the pair back
  const wasOpen = useRef(confirmOpen);
  if (confirmOpen && !wasOpen.current) floor.current = Math.max(floor.current, c.live.n);
  wasOpen.current = confirmOpen;
  const live = confirmOpen ? CN_QUIET : liveSince(c.live, floor.current);
  // Spoken only what this pair rendered: not under a confirmation (inert), not while the review's note holds the region.
  // Per region, only what this pair rendered: none under a confirmation (inert); a region the review's note holds, not.
  useLayoutEffect(() => {
    if (confirmOpen) return;
    if (note === null || note.alert) c.spoken('s', live.sn);
    if (note?.alert !== true) c.spoken('a', live.an);
  });
  useEffect(() => { if (formOpen) amountRef.current?.focus(); }, [formOpen]);
  useEffect(() => { if (focusFirst > 0) (errors.amount !== '' ? amountRef.current : firstReason.current)?.focus(); }, [focusFirst]);
  useEffect(() => { if (focusAction > 0) (actionRef.current ?? headingRef.current)?.focus(); }, [focusAction]);
  useEffect(() => {
    if (resetTag === resetSeen.current) return;
    resetSeen.current = resetTag;
    // A form control that goes with the reset while focused: the Payments heading (§2.6 "Vanishes while focused"), never body.
    if (formRef.current?.contains(document.activeElement) === true) headingRef.current?.focus();
    setFormOpen(false); setAmount(''); setReason(null); setErrors({ amount: '', reason: '' });
  }, [resetTag]);
  const remainingText = formatCents(remaining);
  const blocked = c.blocked === 'own' ? CREDIT_TEXT.blockedOwn : c.blocked === 'sibling' ? CREDIT_TEXT.blockedSibling : remaining <= 0 ? CREDIT_TEXT.blockedRemaining : '';
  const held = blocked !== '' || waiting || c.busy || reviewing;
  // aria-disabled always says why (§2.3; the lookup's sr-only busy/wait pattern): the blocker, a wait, or a press still out.
  const why = blocked !== '' ? 'issued-payments-credit-issue-why' : waiting ? 'issued-payments-wait' : c.busy || reviewing ? 'issued-payments-credit-busy-why' : undefined;
  const contWhy = waiting ? 'issued-payments-wait' : reviewing ? 'issued-payments-credit-busy-why' : undefined;
  const invalid = errors.amount !== '' || errors.reason !== '';

  async function submit(): Promise<void> {
    if (reviewing) return;
    const checked = paymentAmountOf(amount, remaining);
    const next = {
      amount: checked.kind === 'ok' ? '' : checked.kind === 'format' ? CREDIT_TEXT.errFormat : checked.kind === 'decimals' ? CREDIT_TEXT.errDecimals
        : checked.kind === 'zero' ? CREDIT_TEXT.errZero : CREDIT_TEXT.errOver(remainingText),
      reason: reason === null ? CREDIT_TEXT.errReason : '',
    };
    setErrors(next);
    if (checked.kind !== 'ok' || reason === null) return setFocusFirst((n) => n + 1); // nothing is sent
    const out = await onContinue(checked.cents, reason);
    if (out.kind === 'over') { setErrors({ amount: CREDIT_TEXT.errOver(formatCents(out.remaining)), reason: '' }); setFocusFirst((n) => n + 1); }
    if (out.kind === 'closed') { headingRef.current?.focus(); setFormOpen(false); } // §2.6: a control that vanishes while focused → the Payments heading
  }

  const errorId = (field: 'amount' | 'reason'): string => `issued-payments-credit-form-${field}-error`;
  return (
    <div data-testid="issued-payments-credit-issuer" className="space-y-3 min-w-0">
      {!waiting && (c.busy || reviewing) && <span id="issued-payments-credit-busy-why" className="sr-only">{VIEW_TEXT.loading}</span>}
      {/* The section's live pair while this dialog shows the attempt's invoice, and what the review says: always mounted. */}
      <p data-testid="issued-payments-credit-say" role="status" className={`text-sm font-bold text-slate-700 ${fitsRow}`}><span key={live.sn}>{note !== null && !note.alert ? note.text : live.status}</span></p>
      <p data-testid="issued-payments-credit-alert" role="alert" className={`text-sm font-bold text-rose-800 ${fitsRow}`}><span key={live.an}>{note?.alert === true ? note.text : live.alert}</span></p>
      {offered && !formOpen && (
        <div className="flex flex-wrap items-center gap-2 min-w-0">
          <button
            ref={actionRef} type="button" data-testid="issued-payments-credit-issue" aria-disabled={held} aria-describedby={why}
            onClick={() => { if (!held) { setErrors({ amount: '', reason: '' }); setFormOpen(true); } }} className={`${button} ${waitable} ${fitsRow} ${actionFit}`}
          >
            {CREDIT_TEXT.action}
          </button>
          {blocked !== '' && <p id="issued-payments-credit-issue-why" data-testid="issued-payments-credit-issue-why" className={`${hintClass} ${fitsRow}`}>{blocked}</p>}
        </div>
      )}
      {offered && formOpen && (
        <form ref={formRef} data-testid="issued-payments-credit-form" noValidate onSubmit={(e) => { e.preventDefault(); void submit(); }} className="space-y-3 min-w-0">
          <fieldset className="space-y-3 min-w-0">
            <legend className="text-sm font-black text-primary">{CREDIT_TEXT.legend}</legend>
            <div className="space-y-1 min-w-0">
              <label htmlFor="issued-payments-credit-form-amount" className={labelClass}>{CREDIT_TEXT.amountLabel}</label>
              <input
                ref={amountRef} id="issued-payments-credit-form-amount" data-testid="issued-payments-credit-form-amount" type="text" inputMode="decimal" autoComplete="off" value={amount}
                aria-invalid={errors.amount !== ''} aria-describedby={`issued-payments-credit-form-amount-hint${errors.amount !== '' ? ` ${errorId('amount')}` : ''}`}
                onChange={(e) => setAmount(e.target.value)} className={inputClass}
              />
              <p id="issued-payments-credit-form-amount-hint" data-testid="issued-payments-credit-form-amount-hint" className={`${hintClass} ${fitsRow}`}>{CREDIT_TEXT.amountHint(remainingText)}</p>
              {errors.amount !== '' && <p id={errorId('amount')} data-testid={errorId('amount')} className={`text-sm font-bold text-rose-800 ${fitsRow}`}>{errors.amount}</p>}
            </div>
            <fieldset
              data-testid="issued-payments-credit-form-reasons" role="radiogroup" aria-required="true" aria-invalid={errors.reason !== ''}
              aria-describedby={errors.reason !== '' ? errorId('reason') : undefined} className="space-y-1 min-w-0"
            >
              <legend className={labelClass}>{CREDIT_TEXT.reasonLegend}</legend>
              {CREDIT_REASON_CODES.map((code, i) => (
                // The label is the hit area (≥ 24 px tall with the control, §2.6 targets).
                <label key={code} className={`flex items-center gap-2 min-h-[24px] text-sm text-slate-700 ${fitsRow}`}>
                  <input
                    ref={i === 0 ? firstReason : undefined} type="radio" name="issued-payments-credit-form-reason" value={code} checked={reason === code}
                    aria-invalid={errors.reason !== ''} aria-describedby={errors.reason !== '' ? errorId('reason') : undefined} data-testid={`issued-payments-credit-form-reason-${code}`} onChange={() => setReason(code)} className={focusRing}
                  />
                  {INVOICE_CREDIT_NOTE_REASONS[code]}
                </label>
              ))}
              {errors.reason !== '' && <p id={errorId('reason')} data-testid={errorId('reason')} className={`text-sm font-bold text-rose-800 ${fitsRow}`}>{errors.reason}</p>}
            </fieldset>
          </fieldset>
          {/* ONE alert for the whole form (its fields' texts are their descriptions), always in place. */}
          <p data-testid="issued-payments-credit-form-errors" role="alert" className={`text-sm font-bold text-rose-800 ${fitsRow}`}>{invalid ? CREDIT_TEXT.errSummary : ''}</p>
          <div className="flex flex-wrap gap-2">
            <button type="submit" data-testid="issued-payments-credit-continue" aria-disabled={reviewing || waiting} aria-describedby={contWhy} className={`${button} ${waitable} ${actionFit}`}>{CREDIT_TEXT.continue}</button>
            <button
              type="button" data-testid="issued-payments-credit-cancel" className={`${quiet} ${actionFit}`}
              onClick={() => { setFormOpen(false); setErrors({ amount: '', reason: '' }); setFocusAction((n) => n + 1); }}
            >
              {CREDIT_TEXT.cancel}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

/**
 * The held credit-note attempt's card (doc 17 §2.6 items 5-7, §3.1): inline in Payments while its invoice's dialog is open,
 * at section level otherwise. Its line is what the section said (the live pair announced it); "Confirm credit note" only
 * after the attempt's own issue 201 (D-P2-16); "Look up attempt" where the outcome table offers it; a confirmed no-access
 * card has no buttons. The heading takes focus before a press can take the pressed control away.
 */
function CreditCard({ prefix, held, view, number, busy, waiting, headingRef, focusFind, onConfirm, onFind, onCheck, onContinue, onHide, onRetry, children }: {
  readonly prefix: string; readonly held: HeldCreditNote; readonly view: CreditCardView; readonly number: number | null; readonly busy: boolean; readonly waiting: boolean;
  readonly headingRef: RefObject<HTMLHeadingElement | null>; readonly focusFind: number; readonly onConfirm: () => void; readonly onFind: () => void;
  readonly onCheck: () => void; readonly onContinue: (another: boolean) => void; readonly onHide: () => void; readonly onRetry: () => void; readonly children?: ReactNode;
}) {
  const findRef = useRef<HTMLButtonElement | null>(null);
  const focused = useRef<HTMLElement | null>(null);
  const findSeen = useRef(focusFind);
  // A card control that went while it had focus (a window passing, its stage decided): focus to the card's heading, never the body.
  useLayoutEffect(() => {
    const was = focused.current;
    if (was === null || was.isConnected) return;
    focused.current = null;
    const at = document.activeElement;
    if (at === null || at === document.body) headingRef.current?.focus();
  });
  useEffect(() => {
    if (focusFind === findSeen.current) return;
    findSeen.current = focusFind;
    findRef.current?.focus();
  }, [focusFind]);
  const ownIssue = held.issue?.completion?.kind === 'issued' && held.creditNoteId !== null;
  const out = busy || waiting;
  // Why a button is aria-disabled now (the lookup's sr-only busy/wait pattern), after its own hint.
  const outWhy = waiting ? `${prefix}-wait` : busy ? `${prefix}-busy` : '';
  const describe = (hint: string): string | undefined => [hint, outWhy].filter((x) => x !== '').join(' ') || undefined;
  const track = (e: { readonly currentTarget: HTMLElement }): void => { focused.current = e.currentTarget; };
  // Focus moved on by the user: forget it (a removed control still connected at blur was not taken by a change).
  const untrack = (e: { readonly currentTarget: HTMLElement }): void => {
    const el = e.currentTarget;
    queueMicrotask(() => { if (el.isConnected && focused.current === el) focused.current = null; });
  };
  const press = (go: () => void) => (): void => { if (!out) go(); };
  return (
    <div data-testid={prefix} data-state={held.state} className="p-4 rounded-2xl border border-amber-200 bg-amber-50 space-y-2 min-w-0">
      <h4 ref={headingRef} tabIndex={-1} data-testid={`${prefix}-heading`} className={`text-sm font-black text-primary ${focusRing}`}>{CREDIT_TEXT.legend}</h4>
      <p data-testid={`${prefix}-text`} className={`text-sm font-bold ${view.alert ? 'text-rose-800' : 'text-slate-700'} ${fitsRow}`}>{view.text}</p>
      {view.also !== '' && <p data-testid={`${prefix}-also`} className={`text-sm font-bold text-slate-700 ${fitsRow}`}>{view.also}</p>}
      {ownIssue && held.state === 'issued' && <p data-testid={`${prefix}-hint`} className={`${hintClass} ${fitsRow}`}>{CREDIT_TEXT.issuedHint}</p>}
      {held.creditNoteId !== null && (held.state === 'issued' || held.state === 'confirmed') && (
        <p data-testid={`${prefix}-number`} className={`text-sm font-bold text-slate-700 ${fitsRow}`}>{number === null ? CREDIT_TEXT.numberPending : CREDIT_TEXT.number(number)}</p>
      )}
      {view.retry && number === null && (
        <button type="button" data-testid={`${prefix}-retry`} aria-disabled={out} aria-describedby={describe('')} onFocus={track} onBlur={untrack} onClick={press(onRetry)} className={`${quiet} ${waitable} ${actionFit}`}>
          {CREDIT_TEXT.tryAgain}
        </button>
      )}
      {view.notes.length > 0 && (
        <ul data-testid={`${prefix}-notes`} className="divide-y divide-amber-100 border border-amber-100 rounded-2xl bg-white/60">
          {view.notes.map((note) => (
            <li key={note.id} data-testid={`${prefix}-note`} data-id={note.id} className="px-4 py-3 text-sm min-w-0 break-words"><CreditNoteFacts note={note} prefix={`${prefix}-note`} /></li>
          ))}
        </ul>
      )}
      {(view.confirm || view.check !== null || view.cont !== null || view.find) && (
        <div className="flex flex-wrap items-center gap-2">
          {view.confirm && (
            <>
              <button
                type="button" data-testid={`${prefix}-confirm`} aria-disabled={out} aria-describedby={describe(`${prefix}-confirm-hint`)} onFocus={track} onBlur={untrack}
                onClick={press(onConfirm)} className={`${button} ${waitable} ${actionFit}`}
              >
                {CREDIT_TEXT.confirm}
              </button>
              <p id={`${prefix}-confirm-hint`} className={`w-full ${hintClass} ${fitsRow}`}>{CREDIT_TEXT.confirmHint}</p>
            </>
          )}
          {view.check !== null && (
            <>
              <button
                type="button" data-testid={`${prefix}-check`} aria-disabled={out} aria-describedby={describe(`${prefix}-check-hint`)} onFocus={track} onBlur={untrack}
                onClick={press(onCheck)} className={`${button} ${waitable} ${actionFit}`}
              >
                {CREDIT_TEXT.checkAgain}
              </button>
              <p id={`${prefix}-check-hint`} className={`w-full ${hintClass} ${fitsRow}`}>{view.check === 'proof' ? CREDIT_TEXT.checkReadHint : CREDIT_TEXT.checkReplayHint}</p>
              {view.until !== '' && <p data-testid={`${prefix}-until`} className={`w-full ${hintClass} ${fitsRow}`}>{view.until}</p>}
            </>
          )}
          {view.cont !== null && (
            <>
              <button
                type="button" data-testid={`${prefix}-${view.cont}`} aria-disabled={out} aria-describedby={describe(`${prefix}-${view.cont}-hint`)} onFocus={track} onBlur={untrack}
                onClick={press(() => onContinue(view.cont === 'another'))} className={`${button} ${waitable} ${actionFit}`}
              >
                {view.cont === 'another' ? CREDIT_TEXT.issueAnother : CREDIT_TEXT.continueIssuing}
              </button>
              <p id={`${prefix}-${view.cont}-hint`} className={`w-full ${hintClass} ${fitsRow}`}>{view.cont === 'another' ? CREDIT_TEXT.anotherHint : CREDIT_TEXT.continueHint}</p>
            </>
          )}
          {view.find && (
            <button ref={findRef} type="button" data-testid={`${prefix}-find`} aria-disabled={out} aria-describedby={describe('')} onFocus={track} onBlur={untrack} onClick={press(onFind)} className={`${quiet} ${waitable} ${actionFit}`}>
              {CREDIT_TEXT.find}
            </button>
          )}
        </div>
      )}
      {waiting && <span id={`${prefix}-wait`} className="sr-only">{LIST_TEXT.waiting}</span>}
      {busy && !waiting && <span id={`${prefix}-busy`} className="sr-only">{VIEW_TEXT.loading}</span>}
      {children}
      {view.hide && (
        // Apart from Check again (§2.6 targets): its own row, its warning its description.
        <div className="mt-3 pt-3 border-t border-amber-200 space-y-1">
          <button type="button" data-testid={`${prefix}-hide`} aria-describedby={`${prefix}-hide-warning`} onFocus={track} onBlur={untrack} onClick={onHide} className={`${quiet} ${actionFit}`}>
            {CREDIT_TEXT.hide}
          </button>
          <p id={`${prefix}-hide-warning`} className={`${hintClass} ${fitsRow}`}>{CREDIT_TEXT.hideWarning}</p>
        </div>
      )}
    </div>
  );
}
/** One credit note's facts as the list shows them (§4.1): number, status, amount, reason, times, withdrawal and, for the owner, names. */
function CreditNoteFacts({ note, prefix }: { readonly note: InvoiceCreditNote; readonly prefix: string }) {
  return (
    <>
      <p className="font-bold text-slate-700">
        <span data-testid={`${prefix}-number`}>{CREDIT_TEXT.number(note.number)}</span>
        {' · '}<span data-testid={`${prefix}-status`}>{note.withdrawal === null ? CREDIT_TEXT.active : CREDIT_TEXT.withdrawn}</span>
        {' · '}<span data-testid={`${prefix}-amount`} className="whitespace-nowrap">{formatCents(note.grossCents)}</span>
        {' · '}<span data-testid={`${prefix}-reason`}>{INVOICE_CREDIT_NOTE_REASONS[note.reason]}</span>
      </p>
      <p className={hintClass}>{CREDIT_TEXT.issuedAt} <time data-testid={`${prefix}-issued-at`} dateTime={note.issuedAt}>{utcText(note.issuedAt)}</time></p>
      {note.withdrawal !== null && (
        <p className={hintClass}>
          {CREDIT_TEXT.withdrawnAt} <time data-testid={`${prefix}-withdrawn-at`} dateTime={note.withdrawal.withdrawnAt}>{utcText(note.withdrawal.withdrawnAt)}</time>
          {' · '}<span data-testid={`${prefix}-withdrawal-reason`}>{INVOICE_CREDIT_NOTE_WITHDRAWAL_REASONS[note.withdrawal.reason]}</span>
        </p>
      )}
      {note.issuedByName !== undefined && (
        <p data-testid={`${prefix}-issued-by`} className={`${hintClass} [overflow-wrap:anywhere]`}>{CREDIT_TEXT.issuedBy} <bdi>{note.issuedByName ?? CREDIT_TEXT.nameNotSet}</bdi></p>
      )}
      {note.withdrawal !== null && note.withdrawal.withdrawnByName !== undefined && (
        <p data-testid={`${prefix}-withdrawn-by`} className={`${hintClass} [overflow-wrap:anywhere]`}>{CREDIT_TEXT.withdrawnBy} <bdi>{note.withdrawal.withdrawnByName ?? CREDIT_TEXT.nameNotSet}</bdi></p>
      )}
    </>
  );
}

/**
 * The chosen store's "Credit activity" (doc 18 §4.1-§4.3): heading one level below the section's, the intro line, one live
 * state line (Loading, Empty only after a read to the end, the error, the wait, "{n} more loaded."), Refresh while ready,
 * Try again after a failure, the rows as served, then Show more while a cursor stands. Refresh, Try again and Show more stay
 * rendered (aria-disabled) through their own read, so focus stays on them; a Show more that loaded the last page hands
 * focus to the heading. No action on any row.
 */
function CreditActivitySection({ a, waiting, onMore, onRefresh, onRetry }: {
  readonly a: ActivityState; readonly waiting: boolean; readonly onMore: () => void; readonly onRefresh: () => void; readonly onRetry: () => void;
}) {
  const heading = useRef<HTMLHeadingElement | null>(null);
  const more = useRef<HTMLButtonElement | null>(null);
  const refresh = useRef<HTMLButtonElement | null>(null);
  const retry = useRef<HTMLButtonElement | null>(null);
  // The control pressed with focus on it, until its read ends: if it is then gone, focus goes to the control now shown in
  // its place — Try again after a failure, Refresh after a Try again that loaded — else (Show more's last page) the heading.
  const pressed = useRef<'more' | 'refresh' | 'retry' | null>(null);
  useLayoutEffect(() => {
    const was = pressed.current;
    if (was === null || a.more || a.phase === 'loading') return;
    pressed.current = null;
    if ((was === 'more' ? more : was === 'refresh' ? refresh : retry).current?.isConnected === true) return; // still there: focus stays on it
    const at = document.activeElement;
    if (at !== null && at !== document.body) return;
    (retry.current ?? (was === 'more' ? null : refresh.current) ?? heading.current)?.focus();
  });
  const press = (which: 'more' | 'refresh' | 'retry', e: { readonly currentTarget: Element }): void => { pressed.current = document.activeElement === e.currentTarget ? which : null; };
  const loading = a.phase === 'loading';
  const failed = a.phase === 'failed' || a.phase === 'rate-limited';
  const text = loading ? ACTIVITY_TEXT.loading : a.phase === 'failed' ? ACTIVITY_TEXT.failed : a.phase === 'rate-limited' ? LIST_TEXT.waiting
    : a.complete && a.rows.length === 0 ? ACTIVITY_TEXT.empty : a.said;
  const why = waiting ? 'issued-credit-activity-wait' : loading || a.more ? 'issued-credit-activity-busy' : undefined;
  return (
    // data-cursor: whether a cursor is held for Show more (a failed page drops it with the rows; tests read it).
    <div data-testid="issued-credit-activity" data-cursor={a.next === null ? 'none' : 'held'} className="space-y-2">
      <h4 ref={heading} id="issued-credit-activity-title" data-testid="issued-credit-activity-title" tabIndex={-1} className={`text-base font-black text-primary ${focusRing}`}>{ACTIVITY_TEXT.title}</h4>
      <p data-testid="issued-credit-activity-intro" className={hintClass}>{ACTIVITY_TEXT.intro}</p>
      <p data-testid="issued-credit-activity-state" data-phase={a.phase} role="status" className="text-sm font-bold text-slate-600">{text}</p>
      {(a.phase === 'ready' || (loading && a.via === 'refresh')) && (
        <button
          ref={refresh} type="button" data-testid="issued-credit-activity-refresh" aria-disabled={loading || a.more || waiting} aria-describedby={why}
          onClick={(e) => { if (loading || a.more || waiting) return; press('refresh', e); onRefresh(); }} className={`${quiet} ${waitable} ${fitsRow}`}
        >
          {ACTIVITY_TEXT.refresh}
        </button>
      )}
      {(failed || (loading && a.via === 'retry')) && (
        <button
          ref={retry} type="button" data-testid="issued-credit-activity-retry" aria-disabled={loading || waiting} aria-describedby={why}
          onClick={(e) => { if (loading || waiting) return; press('retry', e); onRetry(); }} className={`${quiet} ${waitable} ${fitsRow}`}
        >
          {CREDIT_TEXT.tryAgain}
        </button>
      )}
      {a.phase === 'ready' && a.rows.length > 0 && (
        <ul data-testid="issued-credit-activity-list" aria-labelledby="issued-credit-activity-title" className="divide-y divide-slate-100 border border-slate-100 rounded-2xl">
          {a.rows.map((note) => (
            <li key={note.id} data-testid="issued-credit-activity-item" data-id={note.id} className="px-4 py-3 text-sm min-w-0 break-words">
              <ActivityFacts note={note} />
            </li>
          ))}
        </ul>
      )}
      {a.phase === 'ready' && a.next !== null && (
        <button
          ref={more} type="button" data-testid="issued-credit-activity-more" aria-disabled={a.more || waiting} aria-describedby={why}
          onClick={(e) => {
            if (a.more || waiting) return;
            press('more', e);
            onMore();
          }}
          className={`${quiet} ${waitable} ${fitsRow}`}
        >
          {CREDIT_TEXT.showMore}
        </button>
      )}
      {(loading || a.more) && <span id="issued-credit-activity-busy" className="sr-only">{ACTIVITY_TEXT.loading}</span>}
      {waiting && <span id="issued-credit-activity-wait" className="sr-only">{LIST_TEXT.waiting}</span>}
    </div>
  );
}

/** One activity row in doc 18 §4.2's order: number, invoice, status as text, gross, reason; issued time and by; the withdrawal. */
function ActivityFacts({ note }: { readonly note: StoreCreditNote }) {
  const p = 'issued-credit-activity';
  return (
    <>
      <p className="font-bold text-slate-700">
        <span data-testid={`${p}-number`}>{CREDIT_TEXT.number(note.number)}</span>
        {' · '}<span data-testid={`${p}-invoice`}>{ACTIVITY_TEXT.invoice(note.invoiceNumber)}</span>
        {' · '}<span data-testid={`${p}-status`}>{note.withdrawal === null ? CREDIT_TEXT.active : CREDIT_TEXT.withdrawn}</span>
        {' · '}<span data-testid={`${p}-amount`} className="whitespace-nowrap">{formatCents(note.grossCents)}</span>
        {' · '}<span data-testid={`${p}-reason`}>{INVOICE_CREDIT_NOTE_REASONS[note.reason]}</span>
      </p>
      <p className={hintClass}>{CREDIT_TEXT.issuedAt} <time data-testid={`${p}-issued-at`} dateTime={note.issuedAt}>{utcText(note.issuedAt)}</time></p>
      <p data-testid={`${p}-issued-by`} className={`${hintClass} [overflow-wrap:anywhere]`}>{CREDIT_TEXT.issuedBy} <bdi>{note.issuedByName ?? CREDIT_TEXT.nameNotSet}</bdi></p>
      {note.withdrawal !== null && (
        <>
          <p className={hintClass}>
            {CREDIT_TEXT.withdrawnAt} <time data-testid={`${p}-withdrawn-at`} dateTime={note.withdrawal.withdrawnAt}>{utcText(note.withdrawal.withdrawnAt)}</time>
            {' · '}<span data-testid={`${p}-withdrawal-reason`}>{INVOICE_CREDIT_NOTE_WITHDRAWAL_REASONS[note.withdrawal.reason]}</span>
          </p>
          <p data-testid={`${p}-withdrawn-by`} className={`${hintClass} [overflow-wrap:anywhere]`}>{CREDIT_TEXT.withdrawnBy} <bdi>{note.withdrawal.withdrawnByName ?? CREDIT_TEXT.nameNotSet}</bdi></p>
        </>
      )}
    </>
  );
}

/**
 * This invoice's rows of the owner's lookup (doc 17 §3.3), read under this generation and token: open → "Registered, not
 * issued when checked at {time}" and "Release attempt" (releaseHint); issued → "Issued, not confirmed" and "Confirm credit
 * note" (confirmHint); released or confirmed → the word only. Release and Confirm exist only here (lookup-first, D-P2-16).
 * No attempt id reaches a DOM attribute: the hints are keyed by position.
 */
function CreditRows({ lookup, busy, waiting, canSettle, openOther, headingRef, onSettle }: {
  readonly lookup: CreditNotesLookup | null; readonly busy: boolean; readonly waiting: boolean; readonly canSettle: boolean;
  /** This user's open hold's attempt: another attempt's row cannot be held meanwhile (one live attempt, §2.6 item 1) — blockedOwn. */
  readonly openOther: string | null;
  readonly headingRef: RefObject<HTMLHeadingElement | null>; readonly onSettle: (row: CreditLookupRow, version: 1 | 2) => void;
}) {
  const pressed = useRef<HTMLElement | null>(null);
  // A pressed row button that went (its row settled) while focused: focus to the Payments heading, never the body.
  useLayoutEffect(() => {
    const was = pressed.current;
    if (was === null || was.isConnected) return;
    pressed.current = null;
    const at = document.activeElement;
    if (at === null || at === document.body) headingRef.current?.focus();
  });
  const rows = lookup !== null && (lookup.phase === 'exhausted' || lookup.phase === 'incomplete') ? lookup.rows : [];
  if (rows.length === 0) return null;
  const out = busy || waiting;
  const blockedBy = (row: CreditLookupRow): boolean => openOther !== null && openOther !== row.attemptId;
  const press = (e: { readonly currentTarget: HTMLElement }, row: CreditLookupRow, version: 1 | 2): void => {
    if (out || blockedBy(row)) return;
    pressed.current = e.currentTarget;
    onSettle(row, version);
  };
  return (
    <>
    {canSettle && openOther !== null && rows.some(blockedBy) && <p id="issued-payments-credit-rows-own" data-testid="issued-payments-credit-rows-own" className={`${hintClass} ${fitsRow}`}>{CREDIT_TEXT.blockedOwn}</p>}
    {waiting && <span id="issued-payments-credit-rows-wait" className="sr-only">{LIST_TEXT.waiting}</span>}
    {busy && !waiting && <span id="issued-payments-credit-rows-busy" className="sr-only">{VIEW_TEXT.loading}</span>}
    <ul data-testid="issued-payments-credit-rows" className="space-y-2 min-w-0">
      {rows.map((row, i) => (
        <li key={`${row.invoiceId}.${row.attemptId}`} data-testid="issued-payments-credit-row" data-state={row.state} className="p-3 rounded-xl border border-slate-200 space-y-1 min-w-0">
          <p data-testid="issued-payments-credit-row-state" className={`text-sm font-bold text-slate-700 ${fitsRow}`}>
            {row.state === 'open' ? CREDIT_TEXT.rowOpen(clockText(row.checkedAt)) : row.state === 'issued' ? CREDIT_TEXT.rowIssued : row.state === 'released' ? CREDIT_TEXT.rowReleased : CREDIT_TEXT.rowConfirmed}
          </p>
          <p className={`${hintClass} ${fitsRow}`}>
            <span data-testid="issued-payments-credit-row-amount" className="whitespace-nowrap">{formatCents(row.grossCents)}</span>{' · '}{INVOICE_CREDIT_NOTE_REASONS[row.reason]}
          </p>
          {canSettle && (row.state === 'open' || row.state === 'issued') && (
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button" data-testid={row.state === 'open' ? 'issued-payments-credit-row-release' : 'issued-payments-credit-row-confirm'}
                aria-disabled={out || blockedBy(row)}
                aria-describedby={[`issued-payments-credit-row-hint-${i}`, blockedBy(row) ? 'issued-payments-credit-rows-own' : waiting ? 'issued-payments-credit-rows-wait' : busy ? 'issued-payments-credit-rows-busy' : ''].filter((x) => x !== '').join(' ')} onClick={(e) => press(e, row, row.state === 'open' ? 1 : 2)}
                className={`${quiet} ${waitable} ${actionFit}`}
              >
                {row.state === 'open' ? CREDIT_TEXT.release : CREDIT_TEXT.confirm}
              </button>
              <p id={`issued-payments-credit-row-hint-${i}`} className={`w-full ${hintClass} ${fitsRow}`}>{row.state === 'open' ? CREDIT_TEXT.releaseHint : CREDIT_TEXT.confirmHint}</p>
            </div>
          )}
        </li>
      ))}
    </ul>
    </>
  );
}

/**
 * The credit-note confirmation (doc 17 §2.5): an alertdialog beside the issued dialog, "Don't issue" first (initial focus),
 * the facts the review read and the consequence; the sign-in group when no fit shop-observed sign-in exists; its own live
 * pair (the page behind is inert). While sending, "Don't issue" is "Close" with closeWarning; closing never aborts.
 */
function CreditConfirmDialog({ c, waiting, password, focusSignIn, focusKeep, onPassword, onPress, onClose, onSignIn, onStopSignIn, returnFocus }: {
  readonly c: CreditConfirm; readonly waiting: boolean; readonly password: string; readonly focusSignIn: number; readonly focusKeep: number;
  readonly onPassword: (value: string) => void; readonly onPress: () => void; readonly onClose: () => void; readonly onSignIn: () => void; readonly onStopSignIn: () => void;
  readonly returnFocus: RefObject<HTMLElement | null>;
}) {
  const keep = useRef<HTMLButtonElement | null>(null);
  const passwordRef = useRef<HTMLInputElement | null>(null);
  const signInButton = useRef<HTMLButtonElement | null>(null);
  const signInSeen = useRef(focusSignIn);
  const keepSeen = useRef(focusKeep);
  const method = c.stepUp?.method;
  useEffect(() => {
    if (focusSignIn === signInSeen.current) return;
    signInSeen.current = focusSignIn;
    (method === 'password' ? passwordRef.current : signInButton.current)?.focus();
  }, [focusSignIn, method]);
  useEffect(() => {
    if (focusKeep === keepSeen.current) return;
    keepSeen.current = focusKeep;
    keep.current?.focus();
  }, [focusKeep]);
  const why = c.sending ? CREDIT_TEXT.sending : c.renewing ? VOID_TEXT.renewing : waiting ? VOID_TEXT.waiting : '';
  const signInBlocked = c.confirming || waiting || (method === 'password' && password.length === 0);
  const amount = formatCents(c.grossCents);
  // P2-46b: on close, straight to `returnFocus` (the action, else the Payments heading) — never the form's Continue first.
  return (
    <DialogFrame
      role="alertdialog" labelledBy="issued-credit-title" describedBy="issued-credit-description" testId="issued-credit-confirm" anchor="top"
      busy={false} onClose={onClose} initialFocus={keep} returnFocus={returnFocus} preferReturnFocus
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <h2 id="issued-credit-title" data-testid="issued-credit-title" className="text-xl font-black text-primary tracking-tight break-words min-w-0">{CREDIT_TEXT.title}</h2>
        <button ref={keep} type="button" data-testid="issued-credit-keep" aria-describedby={c.sending ? 'issued-credit-close-warning' : undefined} onClick={onClose} className={`${quiet} ${actionFit}`}>
          {c.sending ? CREDIT_TEXT.close : CREDIT_TEXT.keep}
        </button>
      </div>
      <div className="space-y-2 text-sm font-medium text-slate-700">
        <p data-testid="issued-credit-facts" className="break-words">
          Invoice <span data-testid="issued-credit-number">{c.number}</span>:{' '}
          <span data-testid="issued-credit-amount" className="whitespace-nowrap font-black text-primary">{amount}</span>
          {' · '}<span data-testid="issued-credit-reason">{INVOICE_CREDIT_NOTE_REASONS[c.reason]}</span>
          {' · '}Remaining <span data-testid="issued-credit-remaining" className="whitespace-nowrap">{formatCents(c.remaining)}</span>
        </p>
        <p id="issued-credit-description" data-testid="issued-credit-description">{CREDIT_TEXT.consequence(amount)}</p>
      </div>
      {c.sending && <p id="issued-credit-close-warning" data-testid="issued-credit-close-warning" className={hintClass}>{CREDIT_TEXT.closeWarning}</p>}
      {c.stepUp !== null && (
        // The void's sign-in pattern (one owner, 30 s, Stop waiting), its own ids; paste and password managers allowed.
        // Named by the confirmation's alert: why a sign-in is asked for (signInNeeded, signInExpired) or how the last one went —
        // and by its own explanation, so it keeps a name while the alert is empty.
        <div role="group" aria-labelledby="issued-credit-confirm-alert issued-credit-reauth-explain" data-testid="issued-credit-reauth-group" className="flex flex-wrap items-end gap-3 p-3 rounded-xl bg-amber-50 border border-amber-100">
          <p id="issued-credit-reauth-explain" data-testid="issued-credit-reauth-explain" className="w-full text-[11px] font-medium text-amber-800">{method === null ? VOID_TEXT.reauthNone : VOID_TEXT.reauthExplain}</p>
          {method === 'password' && (
            <div className="flex flex-col gap-1 min-w-0 max-w-full">
              <label htmlFor="issued-credit-reauth-password" className={labelClass}>Your password</label>
              <input
                ref={passwordRef} id="issued-credit-reauth-password" data-testid="issued-credit-reauth-password" type="password" autoComplete="current-password"
                value={password} readOnly={c.confirming} onChange={(e) => onPassword(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); if (!signInBlocked) onSignIn(); } }}
                className={`text-xs px-3 py-2 rounded-lg border border-slate-200 bg-white min-w-0 max-w-full ${focusRing}`}
              />
            </div>
          )}
          {method !== null && method !== undefined && (
            <>
              <button
                ref={signInButton} type="button" data-testid="issued-credit-reauth-confirm" aria-disabled={signInBlocked}
                onClick={() => { if (!signInBlocked) onSignIn(); }}
                className={`px-4 py-2 bg-amber-700 text-white text-xs font-black uppercase tracking-widest rounded-xl ${waitable} ${focusRing} ${fitsRow}`}
              >
                {method === 'password' ? 'Confirm sign-in' : 'Sign in with Google again'}
              </button>
              {c.confirming && <button type="button" data-testid="issued-credit-reauth-stop" onClick={onStopSignIn} className={`${quiet} ${fitsRow}`}>{VOID_TEXT.stopWaiting}</button>}
              {c.confirming && <p data-testid="issued-credit-reauth-stop-hint" className="w-full text-[11px] font-medium text-amber-800">{VOID_TEXT.stopWaitingHint}</p>}
            </>
          )}
        </div>
      )}
      {/* Its own pair while open (the page behind is inert): always mounted. */}
      <p data-testid="issued-credit-confirm-status" role="status" className="text-sm font-bold text-amber-900">{c.sending ? CREDIT_TEXT.sending : c.status !== null && !c.status.alert ? c.status.text : ''}</p>
      <p id="issued-credit-confirm-alert" data-testid="issued-credit-confirm-alert" role="alert" className="text-sm font-bold text-rose-800">{c.status?.alert === true ? c.status.text : ''}</p>
      {c.stepUp === null && (
        <div className="flex flex-wrap justify-end items-center gap-3">
          {why !== '' && <span id="issued-credit-send-why" data-testid="issued-credit-send-why" className="sr-only">{why}</span>}
          <button
            type="button" data-testid="issued-credit-send" aria-disabled={why !== ''} aria-describedby={why !== '' ? 'issued-credit-send-why' : undefined}
            onClick={onPress} className={`${button} ${waitable} ${actionFit}`}
          >
            {CREDIT_TEXT.action}
          </button>
        </div>
      )}
    </DialogFrame>
  );
}

export function lookupListsUnsettled(lookup: PaymentLookup | null, storeId: string, invoiceId: string): boolean {
  return lookup !== null && lookup.storeId === storeId && lookup.invoiceId === invoiceId && lookup.rows.some((r) => r.state === 'open' || r.state === 'recorded');
}

/**
 * Whether a lookup row's action is held back (R1 S3/S4): another attempt of this user is undecided (never dropped for it),
 * or this row's own settlement is held and still sendable (only Check again sends it again, same key and bytes).
 */
export function rowHeldBack(held: HeldPayment | undefined, row: Pick<PaymentAttempt, 'attemptId'>): boolean {
  if (held === undefined || held.state === 'done') return false;
  // R7 (replaces R2 N1): another undecided attempt, attached or not, sendable or not, holds every other row back — a row's
  // settlement never drops it (settleRow), so it stays recoverable and keeps its recording block.
  if (held.key !== row.attemptId) return true;
  return held.stage === 'settle' && held.csrf !== null && held.body !== '';
}

/** What a held payment attempt says in the flow region (spec "Wording"); '' for nothing. */
function paymentFlowText(h: HeldPayment, expired: boolean): string {
  const detached = h.csrf === null || ((h.state === 'unresolved') && (h.body === '' || expired));
  const sayText: Record<Exclude<PaymentSay, ''>, string> = {
    uncertain: RECORD_TEXT.uncertain, inProgress: `${RECORD_TEXT.uncertain} ${RECORD_TEXT.inProgress}`, rateLimited: `${RECORD_TEXT.uncertain} ${pickerWaitText(h.retryAfter)}`,
    detached: RECORD_TEXT.detached, record404: RECORD_TEXT.record404, writeConflict: RECORD_TEXT.writeConflict, amountExceeds: RECORD_TEXT.amountExceeds,
    invalidState: RECORD_TEXT.invalidState, invalidStateLookup: RECORD_TEXT.invalidStateLookup, denied: RECORD_TEXT.denied, signedOut: ISSUED_TEXT.ended, notAccepted: RECORD_TEXT.notAccepted,
    confirmed: RECORD_TEXT.confirmed, withdrawn: RECORD_TEXT.withdrawn,
  };
  switch (h.state) {
    case 'sending':
    case 'checking':
      if (h.csrf === null) return RECORD_TEXT.detached;
      return h.stage !== 'settle' ? RECORD_TEXT.recording : h.settleVersion === 1 ? RECORD_TEXT.withdrawing : RECORD_TEXT.confirming;
    case 'recorded': {
      if (h.csrf === null) return RECORD_TEXT.detached;
      const p = h.payment;
      return p === null ? RECORD_TEXT.recordedHint : `${RECORD_TEXT.recorded(formatCents(p.amountCents), INVOICE_PAYMENT_METHODS[p.method])} ${RECORD_TEXT.recordedHint}`;
    }
    case 'unresolved':
      return detached ? RECORD_TEXT.detached : h.say === '' ? RECORD_TEXT.uncertain : sayText[h.say];
    default:
      return h.say === '' ? '' : sayText[h.say];
  }
}

/**
 * Recording a payment inside the Payments section (M7B-PAYMENTS-P2B): "Record payment" only when the eligibility said
 * allowed, page one says issued with something remaining and no attempt of this user is undecided at this store; the form
 * (amount, method, no default) checks everything first and sends nothing on an error; one press is one chain (the
 * section's). The held attempt for THIS invoice (and store) says where it is — out, recorded (Confirm), undecided (Check
 * again, Find), never sent again (Find) or decided — and the lookup's rows offer their deliberate settlement. With nothing
 * held here and nothing remaining (R9: a reload after recording the whole balance), "Find an unfinished payment attempt"
 * runs the same lookup, on a press only. Every
 * control is aria-disabled, never disabled; a control that goes while focused hands focus to the section's heading.
 */
function PaymentRecorder({ storeId, invoiceId, number, page, allowed, reversing, waiting, recording, headingRef }: {
  readonly storeId: string; readonly invoiceId: string; readonly number: number; readonly page: PaymentsPage | null; readonly allowed: boolean;
  /** R8: a reversal of one of this invoice's payments is unresolved — the lookup rows' Withdraw/Confirm hold back. */
  readonly reversing: boolean;
  readonly waiting: boolean; readonly recording: PaymentRecording; readonly headingRef: RefObject<HTMLHeadingElement | null>;
}) {
  const [formOpen, setFormOpen] = useState(false);
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState<InvoicePaymentMethod | null>(null);
  const [errors, setErrors] = useState<{ readonly amount: string; readonly method: string }>({ amount: '', method: '' });
  const [notSent, setNotSent] = useState('');
  const [focusFirst, setFocusFirst] = useState(0);
  const [focusRecord, setFocusRecord] = useState(0);
  const pressing = useRef(false);
  const [pressingShown, setPressing] = useState(false);
  const amountRef = useRef<HTMLInputElement | null>(null);
  const cashRef = useRef<HTMLInputElement | null>(null);
  const recordRef = useRef<HTMLButtonElement | null>(null);
  const pressed = useRef<HTMLElement | null>(null);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);
  // A pressed control that went while focus was on it (or on <body>): focus goes to the Payments heading, never to the body.
  useLayoutEffect(() => {
    const was = pressed.current;
    if (was === null || was.isConnected) return;
    pressed.current = null;
    const at = document.activeElement;
    if (at === null || at === document.body || at === was) headingRef.current?.focus();
  });
  useEffect(() => { if (formOpen) amountRef.current?.focus(); }, [formOpen]);
  useEffect(() => {
    if (focusFirst === 0) return;
    (errors.amount !== '' ? amountRef.current : cashRef.current)?.focus();
  }, [focusFirst]);
  useEffect(() => { if (focusRecord > 0) (recordRef.current ?? headingRef.current)?.focus(); }, [focusRecord]);

  const held = recording.held;
  const mine = held !== undefined && held.storeId === storeId && held.invoiceId === invoiceId ? held : undefined;
  const blocked = isBlockingPayment(held) && held.storeId === storeId; // R2 N1
  const deniedHere = mine !== undefined && mine.state === 'done' && mine.say === 'denied';
  const remaining = page !== null && page.invoice.status === 'issued' ? page.amounts.remainingCents : 0;
  const undecided = mine !== undefined && isOpenPayment(mine); // G1b, R3 S-1: only Find and a settlement decide it
  const elsewhere = isPaymentHeldElsewhere(held, storeId, invoiceId); // G3, R5: any undecided attempt elsewhere is finished on its own invoice first, named here
  const listed = lookupListsUnsettled(recording.lookup, storeId, invoiceId); // R5 B: a listed unsettled attempt holds this invoice's slot
  const offered = allowed && remaining > 0 && !blocked && !elsewhere && !undecided && !deniedHere && !listed && !pressingShown;
  const remainingText = formatCents(remaining);
  const busy = mine !== undefined && (mine.state === 'sending' || mine.state === 'checking');
  const attached = mine !== undefined && mine.csrf !== null;
  const checkable = mine !== undefined && mine.state === 'unresolved' && attached && mine.body !== '' && !recording.expired;
  const findable = mine !== undefined && !busy && mine.state !== 'done' && !(mine.state === 'recorded' && attached);
  // R9: an attempt left unsettled by a page reload at zero remaining has neither Find (nothing held here) nor Record's conflict path.
  const findAny = allowed && mine === undefined && page !== null && page.invoice.status === 'issued' && page.amounts.remainingCents === 0;
  const lookup = recording.lookup;
  const flow = pressingShown && mine === undefined ? RECORD_TEXT.recording : notSent !== '' ? notSent : mine === undefined ? (held !== undefined && (elsewhere || blocked) ? RECORD_TEXT.finishOn(held.number, recording.heldStore) : '') : paymentFlowText(mine, recording.expired);
  const press = (el: HTMLElement): void => { pressed.current = el; };

  async function submit(): Promise<void> {
    if (pressing.current || page === null) return;
    const checked = paymentAmountOf(amount, remaining);
    const next = {
      amount: checked.kind === 'ok' ? '' : checked.kind === 'format' ? RECORD_TEXT.amountFormat : checked.kind === 'decimals' ? RECORD_TEXT.amountDecimals
        : checked.kind === 'zero' ? RECORD_TEXT.amountZero : RECORD_TEXT.amountOver(remainingText),
      method: method === null ? RECORD_TEXT.methodMissing : '',
    };
    setErrors(next);
    if (checked.kind !== 'ok' || method === null) { setFocusFirst((n) => n + 1); return; } // nothing is sent
    pressing.current = true;
    setPressing(true);
    setNotSent('');
    setFormOpen(false);
    headingRef.current?.focus(); // the form goes: focus to the section's heading
    try {
      const why = await recording.record({ invoiceId, number, amountCents: checked.cents, method });
      if (!alive.current) return;
      if (why !== null) { setNotSent(why); setFormOpen(true); }
      else { setAmount(''); setMethod(null); }
    } finally {
      pressing.current = false;
      if (alive.current) setPressing(false);
    }
  }

  const errorId = (field: 'amount' | 'method'): string => `issued-payments-${field}-error`;
  return (
    <div className="space-y-3 min-w-0">
      <p data-testid="issued-payments-flow" role="status" className={`text-sm font-bold text-slate-700 ${fitsRow}`}>{flow}</p>
      {offered && !formOpen && (
        <button ref={recordRef} type="button" data-testid="issued-payments-record" aria-disabled={waiting} aria-describedby={waiting ? 'issued-payments-wait' : undefined}
          onClick={() => { if (!waiting) { setNotSent(''); setErrors({ amount: '', method: '' }); setFormOpen(true); } }} className={`${button} ${waitable} ${fitsRow}`}
        >
          {RECORD_TEXT.record}
        </button>
      )}
      {offered && formOpen && (
        <form data-testid="issued-payments-form" noValidate onSubmit={(e) => { e.preventDefault(); void submit(); }} className="space-y-3 min-w-0">
          <fieldset className="space-y-3 min-w-0">
            <legend className="text-sm font-black text-primary">{RECORD_TEXT.legend}</legend>
            <div className="space-y-1 min-w-0">
              <label htmlFor="issued-payments-amount" className={labelClass}>{RECORD_TEXT.amount}</label>
              <input
                ref={amountRef} id="issued-payments-amount" data-testid="issued-payments-amount-input" type="text" inputMode="decimal" autoComplete="off" value={amount}
                aria-invalid={errors.amount !== ''} aria-describedby={`issued-payments-amount-hint${errors.amount !== '' ? ` ${errorId('amount')}` : ''}`}
                onChange={(e) => setAmount(e.target.value)} className={inputClass}
              />
              <p id="issued-payments-amount-hint" className={`${hintClass} ${fitsRow}`}>{RECORD_TEXT.hint(remainingText)}</p>
              {errors.amount !== '' && <p id={errorId('amount')} role="alert" className={`text-sm font-bold text-rose-800 ${fitsRow}`}>{errors.amount}</p>}
            </div>
            <fieldset role="radiogroup" aria-required="true" aria-invalid={errors.method !== ''} aria-describedby={errors.method !== '' ? errorId('method') : undefined} className="space-y-1 min-w-0">
              <legend className={labelClass}>{RECORD_TEXT.method}</legend>
              {(['cash', 'external_card_terminal'] as const).map((m) => (
                <label key={m} className={`flex items-center gap-2 text-sm text-slate-700 ${fitsRow}`}>
                  <input
                    ref={m === 'cash' ? cashRef : undefined} type="radio" name="issued-payments-method" value={m} checked={method === m}
                    aria-invalid={errors.method !== ''} aria-describedby={errors.method !== '' ? errorId('method') : undefined}
                    data-testid={m === 'cash' ? 'issued-payments-method-cash' : 'issued-payments-method-card'} onChange={() => setMethod(m)} className={focusRing}
                  />
                  {INVOICE_PAYMENT_METHODS[m]}
                </label>
              ))}
              {errors.method !== '' && <p id={errorId('method')} role="alert" className={`text-sm font-bold text-rose-800 ${fitsRow}`}>{errors.method}</p>}
            </fieldset>
          </fieldset>
          <div className="flex flex-wrap gap-2">
            <button type="submit" data-testid="issued-payments-submit" className={`${button} ${fitsRow}`}>{RECORD_TEXT.submit}</button>
            <button type="button" data-testid="issued-payments-cancel" onClick={() => { setFormOpen(false); setErrors({ amount: '', method: '' }); setFocusRecord((n) => n + 1); }} className={`${quiet} ${fitsRow}`}>
              {RECORD_TEXT.cancel}
            </button>
          </div>
        </form>
      )}
      {mine !== undefined && (mine.state === 'recorded' && attached || checkable || findable) && (
        <div className="flex flex-wrap gap-2">
          {mine.state === 'recorded' && attached && (
            <button type="button" data-testid="issued-payments-confirm" aria-disabled={waiting} aria-describedby={waiting ? 'issued-payments-wait' : undefined}
              onClick={(e) => { if (!waiting) { press(e.currentTarget); recording.confirm(); } }} className={`${button} ${waitable} ${fitsRow}`}
            >
              {RECORD_TEXT.confirm}
            </button>
          )}
          {checkable && (
            <button type="button" data-testid="issued-payments-check" aria-disabled={waiting || recording.cooling}
              aria-describedby={waiting ? 'issued-payments-check-wait' : recording.cooling ? 'issued-payments-check-cool' : undefined}
              onClick={(e) => { if (!waiting && !recording.cooling) { press(e.currentTarget); recording.check(); } }} className={`${button} ${waitable} ${fitsRow}`}
            >
              {RECORD_TEXT.check}
            </button>
          )}
          {findable && (
            <button type="button" data-testid="issued-payments-find" aria-disabled={lookup?.phase === 'loading' || recording.out}
              aria-describedby={recording.out ? 'issued-payments-out' : undefined}
              onClick={(e) => { if (lookup?.phase !== 'loading' && !recording.out) { press(e.currentTarget); recording.find(); } }} className={`${quiet} ${waitable} ${fitsRow}`}
            >
              {RECORD_TEXT.find}
            </button>
          )}
          {waiting && <span id="issued-payments-check-wait" className="sr-only">{SETTINGS_TEXT.checkWaiting}</span>}
          {recording.cooling && <span id="issued-payments-check-cool" className="sr-only">{VOID_TEXT.coolDown}</span>}
          {recording.out && <span id="issued-payments-out" className="sr-only">{SETTINGS_TEXT.busy}</span>}
        </div>
      )}
      {findAny && (
        <div className="flex flex-wrap gap-2">
          <button type="button" data-testid="issued-payments-find-any" aria-disabled={lookup?.phase === 'loading' || recording.out}
            aria-describedby={recording.out ? 'issued-payments-out' : undefined}
            onClick={(e) => { if (lookup?.phase !== 'loading' && !recording.out) { press(e.currentTarget); recording.find(); } }} className={`${quiet} ${waitable} ${fitsRow}`}
          >
            {RECORD_TEXT.findAny}
          </button>
          {recording.out && <span id="issued-payments-out" className="sr-only">{SETTINGS_TEXT.busy}</span>}
        </div>
      )}
      {/* Always mounted (R1 S13): its status line is a live region in place before "Checking your payment attempts…". */}
      <div data-testid="issued-payments-attempts" data-phase={lookup?.phase ?? 'none'} className="space-y-2 min-w-0">
        <p role="status" className={`text-sm font-bold text-slate-600 ${fitsRow}`}>{lookup?.text ?? ''}</p>
        {lookup !== null && lookup.phase === 'failed' && (
          <button type="button" data-testid="issued-payments-attempts-retry" aria-disabled={waiting} aria-describedby={waiting ? 'issued-payments-wait' : undefined}
            aria-label="Try again: check your payment attempts" onClick={(e) => { if (!waiting) { press(e.currentTarget); recording.find(); } }} className={`${quiet} ${waitable}`}
          >
            {RECORD_TEXT.tryAgain}
          </button>
        )}
        {recording.out && <span id="issued-payments-rows-out" className="sr-only">{SETTINGS_TEXT.busy}</span>}
        {reversing && <span id="issued-payments-rows-reversing" className="sr-only">{REVERSE_TEXT.pending}</span>}
        {lookup !== null && lookup.rows.length > 0 && (
          <ul aria-label="Your unfinished payment attempts on this invoice" className="divide-y divide-slate-100 border border-slate-100 rounded-2xl">
            {lookup.rows.map((row, index) => {
              // Keyed by position (R3-1): no attempt id ever reaches a DOM attribute.
              const textId = `issued-payments-attempt-text-${index}`;
              const noteId = `issued-payments-attempt-note-${index}`;
              const heldBack = rowHeldBack(held, row);
              const other = (heldBack && held !== undefined && held.key !== row.attemptId) || elsewhere; // another attempt is undecided (S3, G3)
              const off = waiting || busy || heldBack || elsewhere || recording.out || reversing; // R2 N2: a chain still out holds the row back, said
              const describedBy = [textId, other ? noteId : '', recording.out ? 'issued-payments-rows-out' : '', reversing ? 'issued-payments-rows-reversing' : ''].filter((id) => id !== '').join(' ');
              return (
                <li key={row.attemptId} data-testid="issued-payments-attempt" data-attempt-state={row.state} className={`px-4 py-3 text-sm space-y-2 ${fitsRow}`}>
                  <p id={textId} className="font-bold text-slate-700">
                    {row.payment === null ? RECORD_TEXT.openRow(utcText(row.registeredAt))
                      : RECORD_TEXT.recordedRow(utcText(row.registeredAt), formatCents(row.payment.amountCents), INVOICE_PAYMENT_METHODS[row.payment.method], utcText(row.payment.recordedAt))}
                  </p>
                  {other && <p id={noteId} className={`${hintClass} ${fitsRow}`}>{RECORD_TEXT.finishFirst}</p>}
                  {row.state === 'open' ? (
                    <button type="button" data-testid="issued-payments-withdraw" aria-disabled={off} aria-describedby={describedBy}
                      onClick={(e) => { if (!off) { press(e.currentTarget); recording.settle(row, 1); } }} className={`${quiet} ${waitable} ${fitsRow}`}
                    >
                      {RECORD_TEXT.withdraw}
                    </button>
                  ) : (
                    <button type="button" data-testid="issued-payments-attempt-confirm" aria-disabled={off} aria-describedby={describedBy}
                      onClick={(e) => { if (!off) { press(e.currentTarget); recording.settle(row, 2); } }} className={`${button} ${waitable} ${fitsRow}`}
                    >
                      {RECORD_TEXT.confirm}
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}

/**
 * The void confirmation (M7B-INVOICES-VOID-P2, doc 13 §5 G, design §4 and R16): an alertdialog over the issued dialog,
 * laid out from the top, named "Void invoice N?" and described by ONE element — what it voids (the number, the store, the
 * customer, the UTC issue time and the exact Total, from the review read) and what voiding means. A required reason, none
 * chosen, in the pinned order; "Keep invoice" (its header, the first focus) and Escape close it with nothing sent. Once its
 * attempt is held it reads "Close", which says closing does not cancel; the reasons are locked; the attempt's state, note,
 * Check again and Check invoice are said here as on the card. A step-up dropped the attempt: the sign-in group instead.
 */
function VoidConfirmDialog({
  c, store, held, confirmedDenial, expired, waiting, cooling, finding, checkText, password, focusReasons, focusSignIn, onPassword, onReason, onPress, onClose, onCheck, onFind, onSignIn, onStopSignIn, returnFocus,
}: {
  readonly c: VoidConfirm; readonly store: string; readonly held: HeldVoid | undefined; readonly confirmedDenial: string | null; readonly expired: boolean; readonly waiting: boolean;
  readonly cooling: boolean; readonly finding: boolean; readonly checkText: string; readonly password: string;
  /** Counters: a change moves focus to the first reason (an empty press, a renewed sign-in) or into the sign-in group. */
  readonly focusReasons: number; readonly focusSignIn: number;
  readonly onPassword: (value: string) => void; readonly onReason: (code: InvoiceVoidReasonCode) => void; readonly onPress: () => void;
  readonly onClose: () => void; readonly onCheck: () => void; readonly onFind: () => void; readonly onSignIn: () => void; readonly onStopSignIn: () => void;
  readonly returnFocus: RefObject<HTMLElement | null>;
}) {
  const keep = useRef<HTMLButtonElement | null>(null);
  const firstReason = useRef<HTMLInputElement | null>(null);
  const passwordRef = useRef<HTMLInputElement | null>(null);
  const signInButton = useRef<HTMLButtonElement | null>(null);
  // Only a change of a counter after this confirmation opened moves focus: its first focus is Keep invoice.
  const reasonsSeen = useRef(focusReasons);
  const signInSeen = useRef(focusSignIn);
  useEffect(() => {
    if (focusReasons === reasonsSeen.current) return;
    reasonsSeen.current = focusReasons;
    firstReason.current?.focus();
  }, [focusReasons]);
  const method = c.stepUp?.method;
  useEffect(() => {
    if (focusSignIn === signInSeen.current) return;
    signInSeen.current = focusSignIn;
    (method === 'password' ? passwordRef.current : signInButton.current)?.focus();
  }, [focusSignIn, method]);

  const own = c.key !== null && held?.key === c.key ? held : undefined;
  const pressed = c.key !== null;
  const phase: 'review' | 'sending' | 'unresolved' | 'stepup' | 'decided' = c.decided ? 'decided'
    : pressed ? (own === undefined || own.state === 'sending' ? 'sending' : own.state === 'unresolved' || own.state === 'checking' ? 'unresolved' : 'decided')
      : c.stepUp !== null ? 'stepup' : 'review';
  const out = phase === 'sending' || phase === 'unresolved';
  const attached = own !== undefined && own.csrf !== null;
  const old = own?.state === 'unresolved' && (expired || own.body === '');
  const checking = own?.state === 'checking';
  const locked = pressed || c.saving || c.stepUp !== null || c.decided || c.renewing || c.confirming;
  const pending = !pressed && isLiveVoid(held);
  // Why "Void invoice" waits (aria-disabled, never disabled: it keeps focus): the first that applies.
  const why = c.saving ? VOID_TEXT.sendChecking : c.renewing ? VOID_TEXT.reviewing : waiting ? VOID_TEXT.sendWaiting : pending ? VOID_TEXT.pending : c.reason === null ? VOID_TEXT.chooseReason : '';
  const whyShown = why !== '' && why !== VOID_TEXT.chooseReason && why !== VOID_TEXT.sendChecking; // the rest are for screen readers
  // The press's session check is said in the live region, not only behind aria-describedby (review B1 F5).
  const statusText: ReactNode = own !== undefined && out ? voidStateText(own, old) : phase === 'sending' ? VOID_TEXT.sending
    : phase === 'review' && c.saving ? VOID_TEXT.sendChecking : c.status !== null && !c.status.alert ? c.status.text : '';
  const alertText = own?.state === 'refused' && own.refusal !== null ? refusalTextOf(own, confirmedDenial) : c.status?.alert === true ? c.status.text : '';
  const note = own !== undefined && phase === 'unresolved' && !checking && attached ? own.note : '';
  const seenText = own === undefined || phase !== 'unresolved' ? '' : finding ? VOID_TEXT.finding : checkText !== '' ? checkText : voidSeenText(own);
  const signInBlocked = c.confirming || waiting || (method === 'password' && password.length === 0);
  const invalid = c.invalid && c.reason === null;
  const [issuedDate, issuedClock, issuedZone] = utcText(c.invoice.issuedAt).split(' ');
  return (
    <DialogFrame
      // Never aria-busy: a busy subtree may hold back its own status region (review B1 F5); its controls say what is out.
      role="alertdialog" labelledBy="issued-void-title" describedBy="issued-void-description" testId="issued-void-confirm" anchor="top"
      busy={false} onClose={onClose} initialFocus={keep} returnFocus={returnFocus}
    >
      <div className="flex items-start justify-between gap-3">
        <h2 id="issued-void-title" data-testid="issued-void-title" className="text-xl font-black text-primary tracking-tight break-words min-w-0">{VOID_TEXT.title(c.invoice.number)}</h2>
        <button ref={keep} type="button" data-testid="issued-void-keep" aria-describedby={out ? 'issued-void-close-warning' : undefined} onClick={onClose} className={`${quiet} ${fitsRow}`}>
          {pressed || phase === 'decided' ? 'Close' : 'Keep invoice'}
        </button>
      </div>
      <div id="issued-void-description" data-testid="issued-void-description" className="space-y-2 text-sm font-medium text-slate-700">
        <p data-testid="issued-void-facts" className="break-words">
          Invoice {c.invoice.number} at <bdi data-testid="issued-void-store" className="break-words">{store}</bdi>, for{' '}
          <bdi data-testid="issued-void-customer" className="break-words">{c.invoice.customer.name}</bdi>, issued{' '}
          {/* The date and the clock each stay whole: the time breaks only at its spaces (review B1 L-2). */}
          <time data-testid="issued-void-issued-at" dateTime={c.invoice.issuedAt}>
            <span className="whitespace-nowrap">{issuedDate}</span> <span className="whitespace-nowrap">{issuedClock}</span> {issuedZone}
          </time>.
        </p>
        {/* The Total on its own line, never broken (design R18): wider than a narrow dialog, it scrolls inside this named region, never the page. */}
        {/* Named by its own text (aria-labelledby): the dialog's description, and the region's name, read the amount itself. */}
        <div role="region" aria-labelledby="issued-void-total" tabIndex={0} data-testid="issued-void-total-scroll" className={`overflow-x-auto ${focusRing}`}>
          <p id="issued-void-total" data-testid="issued-void-total" className="font-black text-primary whitespace-nowrap">Total {formatCents(c.invoice.amounts.totalCents)}</p>
        </div>
        <p data-testid="issued-void-consequence">{VOID_TEXT.consequence}</p>
      </div>
      {out && <p id="issued-void-close-warning" data-testid="issued-void-close-warning" className={hintClass}>{VOID_TEXT.closeWarning}</p>}
      <fieldset
        role="radiogroup" aria-labelledby="issued-void-reason-legend" aria-required="true" aria-invalid={invalid} aria-describedby={invalid ? 'issued-void-reason-error' : undefined}
        disabled={locked} data-testid="issued-void-reasons" className="space-y-2"
      >
        <legend id="issued-void-reason-legend" className={labelClass}>{VOID_TEXT.reasonLegend}</legend>
        {VOID_REASON_CODES.map((code, i) => (
          <label key={code} className="flex items-center gap-2 text-sm font-bold text-slate-700">
            <input
              ref={i === 0 ? firstReason : undefined} type="radio" name="issued-void-reason" value={code} data-testid={`issued-void-reason-${code}`}
              checked={c.reason === code} onChange={() => onReason(code)} className={focusRing}
            />
            {INVOICE_VOID_REASONS[code]}
          </label>
        ))}
        {invalid && <p id="issued-void-reason-error" data-testid="issued-void-reason-error" className="text-xs font-bold text-rose-700">{VOID_TEXT.chooseReason}</p>}
      </fieldset>
      {phase === 'stepup' && c.stepUp !== null && (
        <div role="group" aria-labelledby="issued-void-reauth-title" data-testid="issued-void-reauth-group" className="flex flex-wrap items-end gap-3 p-3 rounded-xl bg-amber-50 border border-amber-100">
          <p id="issued-void-reauth-title" className="w-full text-xs font-black text-amber-900">{VOID_TEXT.reauthTitle}</p>
          <p data-testid="issued-void-reauth-explain" className="w-full text-[11px] font-medium text-amber-800">{method === null ? VOID_TEXT.reauthNone : VOID_TEXT.reauthExplain}</p>
          {method === 'password' && (
            <div className="flex flex-col gap-1 min-w-0 max-w-full">
              <label htmlFor="issued-void-reauth-password" className={labelClass}>Your password</label>
              <input
                ref={passwordRef} id="issued-void-reauth-password" data-testid="issued-void-reauth-password" type="password" autoComplete="current-password"
                value={password} readOnly={c.confirming} onChange={(e) => onPassword(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); if (!signInBlocked) onSignIn(); } }}
                className={`text-xs px-3 py-2 rounded-lg border border-slate-200 bg-white min-w-0 max-w-full ${focusRing}`}
              />
            </div>
          )}
          {method !== null && method !== undefined && (
            <>
              <button
                ref={signInButton} type="button" data-testid="issued-void-reauth-confirm" aria-disabled={signInBlocked} aria-describedby="issued-void-reauth-hint"
                onClick={() => { if (!signInBlocked) onSignIn(); }}
                className={`px-4 py-2 bg-amber-700 text-white text-xs font-black uppercase tracking-widest rounded-xl ${waitable} ${focusRing} ${fitsRow}`}
              >
                {method === 'password' ? 'Confirm sign-in' : 'Sign in with Google again'}
              </button>
              {/* R1: while its sign-in is waited for, the wait can be ended here at once (the deadline ends it too). */}
              {c.confirming && (
                <button type="button" data-testid="issued-void-reauth-stop" aria-describedby="issued-void-reauth-stop-hint" onClick={onStopSignIn} className={`${quiet} ${fitsRow}`}>
                  {VOID_TEXT.stopWaiting}
                </button>
              )}
              {c.confirming && <p id="issued-void-reauth-stop-hint" data-testid="issued-void-reauth-stop-hint" className="w-full text-[11px] font-medium text-amber-800">{VOID_TEXT.stopWaitingHint}</p>}
              <p id="issued-void-reauth-hint" data-testid="issued-void-reauth-hint" className="w-full text-[11px] font-medium text-amber-800 min-h-[1rem]">
                {c.confirming ? SETTINGS_TEXT.confirmingSignIn : waiting ? SETTINGS_TEXT.signInWaiting : method === 'google' ? 'A Google sign-in window opens.' : password.length === 0 ? 'Enter your password to confirm your sign-in.' : ''}
              </p>
            </>
          )}
        </div>
      )}
      {/* The attempt this confirmation sent: its status line is mounted (empty) from the start. */}
      <div
        data-testid="issued-void-attempt" data-state={own === undefined ? (pressed ? 'sending' : 'none') : own.csrf === null ? 'detached' : own.state}
        className={out ? 'p-4 rounded-2xl border border-amber-200 bg-amber-50 space-y-2' : 'mb-0'}
      >
        <p data-testid="issued-void-confirm-status" role="status" className="text-sm font-bold text-amber-900">{statusText}</p>
        {note !== '' && <p data-testid="issued-void-confirm-note" className="text-xs font-bold text-amber-900">{note}</p>}
        <p data-testid="issued-void-confirm-seen" role="status" className="text-xs font-bold text-slate-700">{seenText}</p>
        {seenText !== '' && own?.seen === 'voided' && own.seenReason !== null && !finding && checkText === '' && (
          <p data-testid="issued-void-confirm-seen-reason" className="text-xs font-bold text-slate-700">{VOID_TEXT.seenReason(INVOICE_VOID_REASONS[own.seenReason])}</p>
        )}
        {phase === 'unresolved' && !checking && !finding && own !== undefined && (
          <div className="flex flex-wrap items-center gap-3">
            {attached && own.retryable && !old && (
              <button
                type="button" data-testid="issued-void-confirm-check" aria-disabled={waiting || cooling}
                aria-describedby={waiting ? 'issued-void-confirm-wait' : cooling ? 'issued-void-confirm-cool' : undefined}
                onClick={() => { if (!waiting && !cooling) onCheck(); }} className={`${button} ${waitable} ${fitsRow}`}
              >
                Check again
              </button>
            )}
            <button
              type="button" data-testid="issued-void-confirm-find" aria-disabled={waiting} aria-describedby={waiting ? 'issued-void-confirm-wait' : undefined}
              onClick={() => { if (!waiting) onFind(); }} className={`${quiet} ${waitable} ${fitsRow}`}
            >
              Check invoice
            </button>
            {waiting && <span id="issued-void-confirm-wait" className="sr-only">{VOID_TEXT.waiting}</span>}
            {cooling && !waiting && <span id="issued-void-confirm-cool" className="sr-only">{VOID_TEXT.coolDown}</span>}
          </div>
        )}
      </div>
      <p data-testid="issued-void-confirm-alert" role="alert" className="text-sm font-bold text-rose-800">{alertText}</p>
      {phase === 'review' && (
        <div className="flex flex-wrap justify-end items-center gap-3">
          {why !== '' && <span id="issued-void-send-why" data-testid="issued-void-send-why" className={whyShown ? hintClass : 'sr-only'}>{why}</span>}
          <button
            type="button" data-testid="issued-void-send" aria-disabled={why !== ''} aria-describedby={why !== '' ? 'issued-void-send-why' : undefined}
            onClick={onPress} className={`${button} ${waitable} ${fitsRow}`}
          >
            Void invoice
          </button>
        </div>
      )}
    </DialogFrame>
  );
}

/** The reversal confirmation over the dialog (M7B-PAYMENTS-P2C R3): exactly the payment its review read, the reason, the press. */
interface ReverseConfirm {
  readonly id: number;
  readonly payment: InvoicePayment;
  readonly number: number;
  readonly reason: InvoicePaymentReversalReason | null;
  readonly invalid: boolean;
  /** The section generation its review read was made under (R4). */
  readonly gen: number;
  /** Its press is out (the session check and the POST). */
  readonly sending: boolean;
  readonly status: { readonly alert: boolean; readonly text: string } | null;
  readonly stepUp: { readonly method: 'password' | 'google' | null } | null;
  readonly confirming: boolean;
  readonly renewing: boolean;
}
const REVERSAL_REASON_CODES = Object.keys(INVOICE_PAYMENT_REVERSAL_REASONS) as readonly InvoicePaymentReversalReason[];

/** R3: the reversal confirmation (VoidConfirmDialog's structure): Keep payment first, the facts, a required reason, the press. */
function ReverseConfirmDialog({ c, store, waiting, password, focusReasons, focusSignIn, onPassword, onReason, onPress, onClose, onSignIn, onStopSignIn, returnFocus }: {
  readonly c: ReverseConfirm; readonly store: string; readonly waiting: boolean; readonly password: string;
  readonly focusReasons: number; readonly focusSignIn: number;
  readonly onPassword: (value: string) => void; readonly onReason: (code: InvoicePaymentReversalReason) => void; readonly onPress: () => void;
  readonly onClose: () => void; readonly onSignIn: () => void; readonly onStopSignIn: () => void;
  readonly returnFocus: RefObject<HTMLElement | null>;
}) {
  const keep = useRef<HTMLButtonElement | null>(null);
  const firstReason = useRef<HTMLInputElement | null>(null);
  const passwordRef = useRef<HTMLInputElement | null>(null);
  const signInButton = useRef<HTMLButtonElement | null>(null);
  const reasonsSeen = useRef(focusReasons);
  const signInSeen = useRef(focusSignIn);
  useEffect(() => {
    if (focusReasons === reasonsSeen.current) return;
    reasonsSeen.current = focusReasons;
    firstReason.current?.focus();
  }, [focusReasons]);
  const method = c.stepUp?.method;
  useEffect(() => {
    if (focusSignIn === signInSeen.current) return;
    signInSeen.current = focusSignIn;
    (method === 'password' ? passwordRef.current : signInButton.current)?.focus();
  }, [focusSignIn, method]);
  const locked = c.sending || c.stepUp !== null || c.renewing || c.confirming;
  const why = c.sending ? REVERSE_TEXT.sending : c.renewing ? REVERSE_TEXT.renewing : waiting ? VOID_TEXT.waiting : c.reason === null ? REVERSE_TEXT.sendWhyReason : '';
  const invalid = c.invalid && c.reason === null;
  const signInBlocked = c.confirming || waiting || (method === 'password' && password.length === 0);
  const p = c.payment;
  return (
    <DialogFrame
      role="alertdialog" labelledBy="issued-reverse-title" describedBy="issued-reverse-description" testId="issued-reverse-confirm" anchor="top"
      busy={false} onClose={onClose} initialFocus={keep} returnFocus={returnFocus}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <h2 id="issued-reverse-title" data-testid="issued-reverse-title" className="text-xl font-black text-primary tracking-tight break-words min-w-0">{REVERSE_TEXT.title}</h2>
        <button ref={keep} type="button" data-testid="issued-reverse-keep" onClick={onClose} className={`${quiet} ${actionFit}`}>
          {c.sending ? REVERSE_TEXT.close : REVERSE_TEXT.keep}
        </button>
      </div>
      <div id="issued-reverse-description" data-testid="issued-reverse-description" className="space-y-2 text-sm font-medium text-slate-700">
        <p data-testid="issued-reverse-facts" className="break-words">
          Invoice <span data-testid="issued-reverse-number">{c.number}</span> at <bdi data-testid="issued-reverse-store" className="break-words">{store}</bdi>:{' '}
          <span data-testid="issued-reverse-amount" className="whitespace-nowrap font-black text-primary">{formatCents(p.amountCents)}</span>
          {' · '}<span data-testid="issued-reverse-method">{INVOICE_PAYMENT_METHODS[p.method]}</span>
          {', recorded at '}<time data-testid="issued-reverse-recorded-at" dateTime={p.recordedAt}>{utcText(p.recordedAt)}</time>.
        </p>
        <p data-testid="issued-reverse-consequence">{REVERSE_TEXT.consequence}</p>
      </div>
      {c.sending && <p data-testid="issued-reverse-close-warning" className={hintClass}>{REVERSE_TEXT.closeWarning}</p>}
      <fieldset
        role="radiogroup" aria-labelledby="issued-reverse-reason-legend" aria-required="true" aria-invalid={invalid} aria-describedby={invalid ? 'issued-reverse-reason-error' : undefined}
        disabled={locked} data-testid="issued-reverse-reasons" className="space-y-2"
      >
        <legend id="issued-reverse-reason-legend" className={labelClass}>{REVERSE_TEXT.reasonLegend}</legend>
        {REVERSAL_REASON_CODES.map((code, i) => (
          <label key={code} className={`flex items-center gap-2 text-sm font-bold text-slate-700 ${fitsRow}`}>
            <input
              ref={i === 0 ? firstReason : undefined} type="radio" name="issued-reverse-reason" value={code} data-testid={`issued-reverse-reason-${code}`}
              checked={c.reason === code} onChange={() => onReason(code)} className={focusRing}
            />
            {INVOICE_PAYMENT_REVERSAL_REASONS[code]}
          </label>
        ))}
        {invalid && <p id="issued-reverse-reason-error" data-testid="issued-reverse-reason-error" className="text-xs font-bold text-rose-700">{REVERSE_TEXT.chooseReason}</p>}
      </fieldset>
      {c.stepUp !== null && (
        // R5: the void's sign-in pattern (one owner, 30 s wait, Stop waiting), its own ids.
        <div role="group" aria-labelledby="issued-reverse-reauth-title" data-testid="issued-reverse-reauth-group" className="flex flex-wrap items-end gap-3 p-3 rounded-xl bg-amber-50 border border-amber-100">
          <p id="issued-reverse-reauth-title" className="w-full text-xs font-black text-amber-900">{REVERSE_TEXT.stepUp}</p>
          <p data-testid="issued-reverse-reauth-explain" className="w-full text-[11px] font-medium text-amber-800">{method === null ? REVERSE_TEXT.stepUpNoMethod : VOID_TEXT.reauthExplain}</p>
          {method === 'password' && (
            <div className="flex flex-col gap-1 min-w-0 max-w-full">
              <label htmlFor="issued-reverse-reauth-password" className={labelClass}>Your password</label>
              <input
                ref={passwordRef} id="issued-reverse-reauth-password" data-testid="issued-reverse-reauth-password" type="password" autoComplete="current-password"
                value={password} readOnly={c.confirming} onChange={(e) => onPassword(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); if (!signInBlocked) onSignIn(); } }}
                className={`text-xs px-3 py-2 rounded-lg border border-slate-200 bg-white min-w-0 max-w-full ${focusRing}`}
              />
            </div>
          )}
          {method !== null && method !== undefined && (
            <>
              <button
                ref={signInButton} type="button" data-testid="issued-reverse-reauth-confirm" aria-disabled={signInBlocked}
                onClick={() => { if (!signInBlocked) onSignIn(); }}
                className={`px-4 py-2 bg-amber-700 text-white text-xs font-black uppercase tracking-widest rounded-xl ${waitable} ${focusRing} ${fitsRow}`}
              >
                {method === 'password' ? 'Confirm sign-in' : 'Sign in with Google again'}
              </button>
              {c.confirming && (
                <button type="button" data-testid="issued-reverse-reauth-stop" onClick={onStopSignIn} className={`${quiet} ${fitsRow}`}>{VOID_TEXT.stopWaiting}</button>
              )}
              {c.confirming && <p data-testid="issued-reverse-reauth-stop-hint" className="w-full text-[11px] font-medium text-amber-800">{VOID_TEXT.stopWaitingHint}</p>}
            </>
          )}
        </div>
      )}
      {/* Always mounted (R3): what this confirmation says is a change to them. */}
      <p data-testid="issued-reverse-confirm-status" role="status" className="text-sm font-bold text-amber-900">{c.sending ? REVERSE_TEXT.sending : c.renewing ? REVERSE_TEXT.renewing : c.status !== null && !c.status.alert ? c.status.text : ''}</p>
      <p data-testid="issued-reverse-confirm-alert" role="alert" className="text-sm font-bold text-rose-800">{c.status?.alert === true ? c.status.text : ''}</p>
      {c.stepUp === null && (
        <div className="flex flex-wrap justify-end items-center gap-3">
          {why !== '' && <span id="issued-reverse-send-why" data-testid="issued-reverse-send-why" className={why === REVERSE_TEXT.sendWhyReason ? 'sr-only' : hintClass}>{why}</span>}
          <button
            type="button" data-testid="issued-reverse-send" aria-disabled={why !== ''} aria-describedby={why !== '' ? 'issued-reverse-send-why' : undefined}
            onClick={onPress} className={`${button} ${waitable} ${actionFit}`}
          >
            {c.sending ? REVERSE_TEXT.sending : REVERSE_TEXT.send}
          </button>
        </div>
      )}
    </DialogFrame>
  );
}

/** R8: the user's held reversal attempt for the dialog's invoice, in its payments section; it outlives the confirmation. */
function ReversalCard({ held, expired, waiting, cooling, finding, checkText, headingRef, onRetry, onCheck, onDismiss }: {
  readonly held: HeldReversal; readonly expired: boolean; readonly waiting: boolean; readonly cooling: boolean; readonly finding: boolean; readonly checkText: string;
  readonly headingRef: RefObject<HTMLHeadingElement | null>;
  readonly onRetry: () => void; readonly onCheck: () => void; readonly onDismiss: () => void;
}) {
  const attached = held.csrf !== null;
  const title = held.state === 'reversed' ? REVERSE_TEXT.reversed : held.state === 'refused' ? REVERSE_TEXT.cardRefusedTitle : REVERSE_TEXT.cardTitle;
  const live = isLiveReversal(held);
  const amount = formatCents(held.amountCents);
  const state = held.state === 'reversed' ? (held.attributed ? REVERSE_TEXT.cardReversed : REVERSE_TEXT.cardSeenReversed)
    : held.state === 'refused' ? REVERSE_TEXT.cardRefused
      : !attached ? REVERSE_TEXT.cardDetached // before `sending`: a detached attempt is never out here (review F1)
        : held.state === 'sending' ? REVERSE_TEXT.cardSending : REVERSE_TEXT.cardUnresolved(amount, held.number);
  const seen = !live ? '' : finding ? REVERSE_TEXT.checking : checkText !== '' ? checkText
    : held.seen === 'not-reversed' ? REVERSE_TEXT.seenNotReversed : held.seen === 'unconfirmed' ? REVERSE_TEXT.seenUnconfirmed : '';
  const canRetry = attached && held.state === 'unresolved' && held.retryable && !expired && held.body !== '';
  const out = attached && (held.state === 'sending' || held.state === 'checking');
  return (
    <div data-testid="issued-reverse-card" data-state={attached ? held.state : 'detached'} data-id={held.paymentId} className="p-4 rounded-2xl border border-amber-200 bg-amber-50 space-y-2">
      <h4 ref={headingRef} tabIndex={-1} data-testid="issued-reverse-card-title" className="text-sm font-black text-amber-900">{title}</h4>
      <p data-testid="issued-reverse-card-status" role="status" className="text-sm font-bold text-amber-900">{state}</p>
      {live && attached && held.note !== '' && <p data-testid="issued-reverse-card-note" className="text-xs font-bold text-amber-900">{held.note}</p>}
      <p data-testid="issued-reverse-card-seen" role="status" className="text-xs font-bold text-slate-700">{seen}</p>
      <div className="flex flex-wrap items-center gap-3">
        {canRetry && (
          <button
            type="button" data-testid="issued-reverse-retry" aria-disabled={waiting || cooling} aria-describedby={waiting || cooling ? 'issued-reverse-cool' : undefined}
            onClick={() => { if (!waiting && !cooling) onRetry(); }} className={`${button} ${waitable} ${fitsRow}`}
          >
            {REVERSE_TEXT.retry}
          </button>
        )}
        {live && !out && (
          <button
            type="button" data-testid="issued-reverse-check" aria-disabled={waiting || finding} onClick={() => { if (!waiting && !finding) onCheck(); }}
            className={`${quiet} ${waitable} ${fitsRow}`}
          >
            {REVERSE_TEXT.check}
          </button>
        )}
        {!out && (
          <button type="button" data-testid="issued-reverse-dismiss" aria-describedby={live ? 'issued-reverse-dismiss-warning' : undefined} onClick={onDismiss} className={`${quiet} ${fitsRow}`}>
            {REVERSE_TEXT.dismiss}
          </button>
        )}
        {(waiting || cooling) && <span id="issued-reverse-cool" className="sr-only">{waiting ? VOID_TEXT.waiting : REVERSE_TEXT.coolDown}</span>}
      </div>
      {live && <p id="issued-reverse-dismiss-warning" className={hintClass}>{REVERSE_TEXT.dismissWarning}</p>}
    </div>
  );
}

/** The withdrawal confirmation over the dialog (CN-P3): exactly the note its review read, the reason, the press. */
interface WithdrawConfirm {
  readonly id: number;
  readonly note: InvoiceCreditNote;
  /** The invoice's number. */
  readonly number: number;
  readonly reason: InvoiceCreditNoteWithdrawalReason | null;
  readonly invalid: boolean;
  /** The section generation its review read was made under. */
  readonly gen: number;
  readonly sending: boolean;
  readonly status: { readonly alert: boolean; readonly text: string } | null;
  readonly stepUp: { readonly method: 'password' | 'google' | null } | null;
  readonly confirming: boolean;
  readonly renewing: boolean;
}
const WITHDRAWAL_REASON_CODES = Object.keys(INVOICE_CREDIT_NOTE_WITHDRAWAL_REASONS) as readonly InvoiceCreditNoteWithdrawalReason[];

/** CN-P3: the withdrawal confirmation (ReverseConfirmDialog's structure): Keep first, the facts, a required reason (none chosen), the press. */
function WithdrawConfirmDialog({ c, waiting, password, focusReasons, focusSignIn, onPassword, onReason, onPress, onClose, onSignIn, onStopSignIn, returnFocus }: {
  readonly c: WithdrawConfirm; readonly waiting: boolean; readonly password: string;
  readonly focusReasons: number; readonly focusSignIn: number;
  readonly onPassword: (value: string) => void; readonly onReason: (code: InvoiceCreditNoteWithdrawalReason) => void; readonly onPress: () => void;
  readonly onClose: () => void; readonly onSignIn: () => void; readonly onStopSignIn: () => void;
  readonly returnFocus: RefObject<HTMLElement | null>;
}) {
  const keep = useRef<HTMLButtonElement | null>(null);
  const firstReason = useRef<HTMLInputElement | null>(null);
  const passwordRef = useRef<HTMLInputElement | null>(null);
  const signInButton = useRef<HTMLButtonElement | null>(null);
  const reasonsSeen = useRef(focusReasons);
  const signInSeen = useRef(focusSignIn);
  useEffect(() => {
    if (focusReasons === reasonsSeen.current) return;
    reasonsSeen.current = focusReasons;
    firstReason.current?.focus();
  }, [focusReasons]);
  const method = c.stepUp?.method;
  useEffect(() => {
    if (focusSignIn === signInSeen.current) return;
    signInSeen.current = focusSignIn;
    (method === 'password' ? passwordRef.current : signInButton.current)?.focus();
  }, [focusSignIn, method]);
  const locked = c.sending || c.stepUp !== null || c.renewing || c.confirming;
  const why = c.sending ? WITHDRAW_TEXT.sending : c.renewing ? WITHDRAW_TEXT.renewing : waiting ? VOID_TEXT.waiting : c.reason === null ? WITHDRAW_TEXT.chooseReason : '';
  const invalid = c.invalid && c.reason === null;
  const signInBlocked = c.confirming || waiting || (method === 'password' && password.length === 0);
  return (
    <DialogFrame
      role="alertdialog" labelledBy="issued-cn-withdraw-title" describedBy="issued-cn-withdraw-description" testId="issued-cn-withdraw-confirm" anchor="top"
      busy={false} onClose={onClose} initialFocus={keep} returnFocus={returnFocus}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <h2 id="issued-cn-withdraw-title" data-testid="issued-cn-withdraw-title" className="text-xl font-black text-primary tracking-tight break-words min-w-0">{WITHDRAW_TEXT.title}</h2>
        <button ref={keep} type="button" data-testid="issued-cn-withdraw-keep" onClick={onClose} className={`${quiet} ${actionFit}`}>
          {c.sending ? WITHDRAW_TEXT.close : WITHDRAW_TEXT.keep}
        </button>
      </div>
      <div id="issued-cn-withdraw-description" data-testid="issued-cn-withdraw-description" className="space-y-2 text-sm font-medium text-slate-700">
        <p data-testid="issued-cn-withdraw-facts" className="break-words">
          <span data-testid="issued-cn-withdraw-cn">{CREDIT_TEXT.number(c.note.number)}</span> on invoice <span data-testid="issued-cn-withdraw-number">{c.number}</span>:{' '}
          <span data-testid="issued-cn-withdraw-amount" className="whitespace-nowrap font-black text-primary">{formatCents(c.note.grossCents)}</span>.
        </p>
        <p data-testid="issued-cn-withdraw-consequence">{WITHDRAW_TEXT.consequence}</p>
      </div>
      {c.sending && <p data-testid="issued-cn-withdraw-close-warning" className={hintClass}>{WITHDRAW_TEXT.closeWarning}</p>}
      <fieldset
        role="radiogroup" aria-labelledby="issued-cn-withdraw-reason-legend" aria-required="true" aria-invalid={invalid} aria-describedby={invalid ? 'issued-cn-withdraw-reason-error' : undefined}
        disabled={locked} data-testid="issued-cn-withdraw-reasons" className="space-y-2"
      >
        <legend id="issued-cn-withdraw-reason-legend" className={labelClass}>{WITHDRAW_TEXT.reasonLegend}</legend>
        {WITHDRAWAL_REASON_CODES.map((code, i) => (
          <label key={code} className={`flex items-center gap-2 min-h-[24px] text-sm font-bold text-slate-700 ${fitsRow}`}>
            <input
              ref={i === 0 ? firstReason : undefined} type="radio" name="issued-cn-withdraw-reason" value={code} data-testid={`issued-cn-withdraw-reason-${code}`}
              checked={c.reason === code} onChange={() => onReason(code)} className={focusRing}
            />
            {INVOICE_CREDIT_NOTE_WITHDRAWAL_REASONS[code]}
          </label>
        ))}
        {invalid && <p id="issued-cn-withdraw-reason-error" data-testid="issued-cn-withdraw-reason-error" className="text-xs font-bold text-rose-700">{WITHDRAW_TEXT.chooseReason}</p>}
      </fieldset>
      {c.stepUp !== null && (
        <div role="group" aria-labelledby="issued-cn-withdraw-reauth-title" data-testid="issued-cn-withdraw-reauth-group" className="flex flex-wrap items-end gap-3 p-3 rounded-xl bg-amber-50 border border-amber-100">
          <p id="issued-cn-withdraw-reauth-title" className="w-full text-xs font-black text-amber-900">{WITHDRAW_TEXT.stepUp}</p>
          <p data-testid="issued-cn-withdraw-reauth-explain" className="w-full text-[11px] font-medium text-amber-800">{method === null ? WITHDRAW_TEXT.stepUpNoMethod : VOID_TEXT.reauthExplain}</p>
          {method === 'password' && (
            <div className="flex flex-col gap-1 min-w-0 max-w-full">
              <label htmlFor="issued-cn-withdraw-reauth-password" className={labelClass}>Your password</label>
              <input
                ref={passwordRef} id="issued-cn-withdraw-reauth-password" data-testid="issued-cn-withdraw-reauth-password" type="password" autoComplete="current-password"
                value={password} readOnly={c.confirming} onChange={(e) => onPassword(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); if (!signInBlocked) onSignIn(); } }}
                className={`text-xs px-3 py-2 rounded-lg border border-slate-200 bg-white min-w-0 max-w-full ${focusRing}`}
              />
            </div>
          )}
          {method !== null && method !== undefined && (
            <>
              <button
                ref={signInButton} type="button" data-testid="issued-cn-withdraw-reauth-confirm" aria-disabled={signInBlocked}
                onClick={() => { if (!signInBlocked) onSignIn(); }}
                className={`px-4 py-2 bg-amber-700 text-white text-xs font-black uppercase tracking-widest rounded-xl ${waitable} ${focusRing} ${fitsRow}`}
              >
                {method === 'password' ? 'Confirm sign-in' : 'Sign in with Google again'}
              </button>
              {c.confirming && (
                <button type="button" data-testid="issued-cn-withdraw-reauth-stop" onClick={onStopSignIn} className={`${quiet} ${fitsRow}`}>{VOID_TEXT.stopWaiting}</button>
              )}
            </>
          )}
        </div>
      )}
      <p data-testid="issued-cn-withdraw-confirm-status" role="status" className="text-sm font-bold text-amber-900">{c.sending ? WITHDRAW_TEXT.sending : c.renewing ? WITHDRAW_TEXT.renewing : c.status !== null && !c.status.alert ? c.status.text : ''}</p>
      <p data-testid="issued-cn-withdraw-confirm-alert" role="alert" className="text-sm font-bold text-rose-800">{c.status?.alert === true ? c.status.text : ''}</p>
      {c.stepUp === null && (
        <div className="flex flex-wrap justify-end items-center gap-3">
          {why !== '' && <span id="issued-cn-withdraw-send-why" data-testid="issued-cn-withdraw-send-why" className={why === WITHDRAW_TEXT.chooseReason ? 'sr-only' : hintClass}>{why}</span>}
          <button
            type="button" data-testid="issued-cn-withdraw-send" aria-disabled={why !== ''} aria-describedby={why !== '' ? 'issued-cn-withdraw-send-why' : undefined}
            onClick={onPress} className={`${button} ${waitable} ${actionFit}`}
          >
            {c.sending ? WITHDRAW_TEXT.sending : WITHDRAW_TEXT.send}
          </button>
        </div>
      )}
    </DialogFrame>
  );
}

/** CN-P3: the user's held withdrawal for the dialog's invoice, beside its credit notes; it outlives the confirmation. Reads only. */
function WithdrawalCard({ held, waiting, finding, checkText, confirmedDenial, headingRef, onCheck, onDismiss }: {
  readonly held: HeldWithdrawal; readonly waiting: boolean; readonly finding: boolean; readonly checkText: string;
  /** The attempt whose 403 the one fresh check confirmed (rule 4): only it says the access changed. */
  readonly confirmedDenial: string | null;
  /** Focused on Check credit note status (the dialog's, which also focuses it after a send); else the card's own. */
  readonly headingRef?: RefObject<HTMLHeadingElement | null>; readonly onCheck: () => void; readonly onDismiss: () => void;
}) {
  const ownHeading = useRef<HTMLHeadingElement | null>(null);
  const heading = headingRef ?? ownHeading;
  const attached = held.csrf !== null;
  const live = isLiveWithdrawal(held);
  // A refusal says what it was (the 403 classification): a stale sign-in is the sign-in path, a confirmed denial the access.
  const stepUp = held.state === 'refused' && held.refusal === 'step-up';
  const title = stepUp ? WITHDRAW_TEXT.cardStepUpTitle : held.state === 'refused' ? WITHDRAW_TEXT.cardRefusedTitle : WITHDRAW_TEXT.cardTitle;
  const refused = stepUp ? WITHDRAW_TEXT.cardStepUp
    : held.refusal === 'denied' ? (confirmedDenial === held.key ? WITHDRAW_TEXT.noLongerAllowed : WITHDRAW_TEXT.denied) : WITHDRAW_TEXT.cardRefused;
  const state = held.state === 'refused' ? refused : !attached ? WITHDRAW_TEXT.cardDetached
    : held.state === 'sending' ? WITHDRAW_TEXT.cardSending : WITHDRAW_TEXT.cardUnresolved(held.creditNoteNumber);
  const seen = !live ? '' : finding ? WITHDRAW_TEXT.checking : checkText !== '' ? checkText
    : held.seen === 'active' ? WITHDRAW_TEXT.seenActive : held.seen === 'unconfirmed' ? WITHDRAW_TEXT.seenUnconfirmed : '';
  const out = attached && held.state === 'sending';
  const dismissable = !live || !attached; // never while it is unresolved in this context (it holds the second withdrawal back)
  const warning = `issued-cn-withdraw-dismiss-warning-${held.key}`; // one per card: the section may show several
  return (
    <div data-testid="issued-payments-cn-withdraw-card" data-state={attached ? held.state : 'detached'} data-id={held.creditNoteId} className="p-4 rounded-2xl border border-amber-200 bg-amber-50 space-y-2">
      <h4 ref={heading} tabIndex={-1} data-testid="issued-payments-cn-withdraw-card-title" className="text-sm font-black text-amber-900">{title}</h4>
      <p data-testid="issued-payments-cn-withdraw-card-status" role="status" className="text-sm font-bold text-amber-900">{state}</p>
      <p data-testid="issued-payments-cn-withdraw-card-seen" role="status" className="text-xs font-bold text-slate-700">{seen}</p>
      <div className="flex flex-wrap items-center gap-3">
        {live && !out && (
          <button
            type="button" data-testid="issued-payments-cn-withdraw-check" aria-disabled={waiting || finding} onClick={() => { if (!waiting && !finding) { heading.current?.focus(); onCheck(); } }}
            className={`${quiet} ${waitable} ${fitsRow}`}
          >
            {WITHDRAW_TEXT.check}
          </button>
        )}
        {dismissable && (
          <button type="button" data-testid="issued-payments-cn-withdraw-dismiss" aria-describedby={live ? warning : undefined} onClick={onDismiss} className={`${quiet} ${fitsRow}`}>
            {WITHDRAW_TEXT.dismiss}
          </button>
        )}
      </div>
      {live && dismissable && <p id={warning} className={hintClass}>{WITHDRAW_TEXT.dismissWarning}</p>}
    </div>
  );
}

/**
 * The user's void attempt outside every dialog (M7B-INVOICES-VOID-P2, design §4 "The held card"): from the hold for this
 * uid, so it outlives a dialog, a store change and the section itself (memory only: a page load ends it). It is scoped to
 * the attempt's own store and invoice — Check again and Check invoice never use the store chosen now. Unresolved: its
 * state and note, "Check again" (while it may), "Check invoice" and "Dismiss" (which only stops tracking it, and says so).
 * Voided or refused: what its key's answer said, and Dismiss. Detached: that it could not be confirmed, without its store,
 * never Check again. Its status line is always mounted (empty and taking no space with no attempt).
 */
function VoidCard({ held, confirmedDenial, expired, waiting, cooling, finding, checkText, headingRef, onCheck, onFind, onDismiss }: {
  readonly held: HeldVoid | undefined; readonly confirmedDenial: string | null; readonly expired: boolean; readonly waiting: boolean; readonly cooling: boolean; readonly finding: boolean;
  readonly checkText: string; readonly headingRef: RefObject<HTMLHeadingElement | null>;
  readonly onCheck: () => void; readonly onFind: () => void; readonly onDismiss: () => void;
}) {
  const detached = held !== undefined && held.csrf === null;
  const live = isLiveVoid(held);
  const old = held?.state === 'unresolved' && (expired || held.body === '');
  // An attached attempt that is out has no control at all (design R8); a Check invoice read out shows none either.
  const busy = held === undefined || finding || (!detached && (held.state === 'sending' || held.state === 'checking'));
  const seenText = held === undefined ? '' : finding ? VOID_TEXT.finding : checkText !== '' ? checkText : live ? voidSeenText(held) : '';
  const hold = waiting ? 'issued-void-wait' : cooling ? 'issued-void-cool' : undefined;
  return (
    <div
      data-testid="issued-void-card" data-state={held === undefined ? 'none' : detached ? 'detached' : held.state}
      className={held === undefined ? 'mb-0' : 'p-4 rounded-2xl border border-amber-200 bg-amber-50 space-y-2'}
    >
      {held !== undefined && (
        <h4 ref={headingRef} tabIndex={-1} data-testid="issued-void-card-heading" className={`text-xs font-black text-amber-900 uppercase tracking-widest ${focusRing}`}>
          Void of invoice {held.number}
        </h4>
      )}
      <p data-testid="issued-void-card-status" role="status" className="text-sm font-bold text-amber-900">{held === undefined ? '' : voidStateText(held, old)}</p>
      {held?.state === 'refused' && held.refusal !== null && <p data-testid="issued-void-card-refused" role="alert" className="text-sm font-bold text-rose-800">{refusalTextOf(held, confirmedDenial)}</p>}
      {held !== undefined && !detached && held.state === 'unresolved' && held.note !== '' && <p data-testid="issued-void-card-note" className="text-xs font-bold text-amber-900">{held.note}</p>}
      <p data-testid="issued-void-card-seen" role="status" className="text-xs font-bold text-slate-700">{seenText}</p>
      {seenText !== '' && held?.seen === 'voided' && held.seenReason !== null && !finding && checkText === '' && (
        <p data-testid="issued-void-card-seen-reason" className="text-xs font-bold text-slate-700">{VOID_TEXT.seenReason(INVOICE_VOID_REASONS[held.seenReason])}</p>
      )}
      {held !== undefined && !busy && (
        <div className="flex flex-wrap items-center gap-3">
          {!detached && held.state === 'unresolved' && held.retryable && !old && (
            <button type="button" data-testid="issued-void-check" aria-disabled={waiting || cooling} aria-describedby={hold} onClick={onCheck} className={`${button} ${waitable} ${fitsRow}`}>Check again</button>
          )}
          {live && (
            <button type="button" data-testid="issued-void-find" aria-disabled={waiting} aria-describedby={waiting ? 'issued-void-wait' : undefined} onClick={onFind} className={`${quiet} ${waitable} ${fitsRow}`}>
              Check invoice
            </button>
          )}
          <button type="button" data-testid="issued-void-dismiss" aria-describedby={live ? 'issued-void-dismiss-warning' : undefined} onClick={onDismiss} className={`${quiet} ${fitsRow}`}>Dismiss</button>
          {live && <span id="issued-void-dismiss-warning" data-testid="issued-void-dismiss-warning" className={`w-full ${hintClass}`}>{VOID_TEXT.dismissWarning}</span>}
          {waiting && <span id="issued-void-wait" className="sr-only">{VOID_TEXT.waiting}</span>}
          {cooling && !waiting && <span id="issued-void-cool" className="sr-only">{VOID_TEXT.coolDown}</span>}
        </div>
      )}
    </div>
  );
}

/**
 * The parts of an invoice the issued dialog and the drafts section's issue review (M7B-INVOICES-ISSUE-P2, commit C) both
 * show, exactly as the server answered them: the seller, the customer, the ordered lines in their own named scroll region,
 * Subtotal, the tax line — "Tax (8.875%)" and its amount, "Tax (0%)" for an explicit zero, or exactly "No tax calculated" —
 * and the Total. Never a number or a time (the review has none). `prefix` names the test ids and the headings' ids.
 */
export function InvoiceSnapshot({ prefix, seller, customerName, lines, amounts }: {
  readonly prefix: string; readonly seller: Seller; readonly customerName: string; readonly lines: readonly InvoiceLine[]; readonly amounts: InvoiceAmounts;
}) {
  const money = (cents: number) => <span className="whitespace-nowrap">{formatCents(cents)}</span>;
  return (
    <>
      {/* Stacked, never side by side: a long name or address wraps in its own block (break-words) at any width. */}
      <section aria-labelledby={`${prefix}-seller-title`} data-testid={`${prefix}-seller`} className="space-y-0.5 text-sm">
        <h3 id={`${prefix}-seller-title`} className={labelClass}>Seller</h3>
        <p data-testid={`${prefix}-seller-legal`} className="font-bold text-primary break-words"><bdi>{seller.legalName}</bdi></p>
        <p data-testid={`${prefix}-seller-store`} className="text-slate-700 break-words"><bdi>{seller.storeName}</bdi></p>
        <p data-testid={`${prefix}-seller-address`} className="text-slate-700 break-words whitespace-pre-line"><bdi>{seller.postalAddress}</bdi></p>
        {seller.taxRegistrationId !== null && (
          <p data-testid={`${prefix}-seller-tax-id`} className="text-slate-700 break-words">Tax registration ID <bdi>{seller.taxRegistrationId}</bdi></p>
        )}
      </section>
      <section aria-labelledby={`${prefix}-customer-title`} className="space-y-0.5 text-sm">
        <h3 id={`${prefix}-customer-title`} className={labelClass}>Customer</h3>
        <p data-testid={`${prefix}-customer`} className="font-bold text-primary break-words"><bdi>{customerName}</bdi></p>
      </section>
      {/* The lines table scrolls sideways inside its own named region, reached by Tab (the data-table reflow exception, as the reopen dialog's): an amount never breaks. */}
      <div role="region" aria-label="Invoice lines" tabIndex={0} data-testid={`${prefix}-lines-scroll`} className={`overflow-x-auto ${focusRing}`}>
        <table data-testid={`${prefix}-lines`} className="w-full text-left text-sm border-collapse">
          <caption className="sr-only">Invoice lines</caption>
          <thead>
            <tr className="border-b border-slate-100">
              <th scope="col" className={`${columnHeadClass} pr-2 text-left`}>#</th>
              <th scope="col" className={`${columnHeadClass} pr-2 text-left`}>Description</th>
              <th scope="col" className={`${columnHeadClass} pr-2 text-right`}>Quantity</th>
              <th scope="col" className={`${columnHeadClass} pr-2 text-right`}>Unit price</th>
              <th scope="col" className={`${columnHeadClass} text-right`}>Line total</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((line) => (
              <tr key={line.position} data-testid={`${prefix}-line`} className="border-b border-slate-50">
                <td className="py-1 pr-2 text-slate-500">{line.position}</td>
                <td className="py-1 pr-2 font-bold text-slate-800 break-words"><bdi>{line.description}</bdi></td>
                <td className="py-1 pr-2 text-right whitespace-nowrap">{line.quantity}</td>
                <td className="py-1 pr-2 text-right whitespace-nowrap">{formatCents(line.unitPriceCents)}</td>
                <td className="py-1 text-right font-bold whitespace-nowrap">{formatCents(line.lineTotalCents)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {/* Below sm the type steps down (SDB-23): at 320 px the largest amount in 16 px heavy type is wider than the dialog. */}
      <div className="space-y-1 text-right text-sm sm:text-base">
        <p data-testid={`${prefix}-subtotal`} className="font-bold text-slate-700 break-words">Subtotal {money(amounts.subtotalCents)}</p>
        <p data-testid={`${prefix}-tax`} className="font-bold text-slate-700 break-words">
          {amounts.tax.mode === 'none' ? amounts.tax.description : <>{amounts.tax.label} ({rateText(amounts.tax.rateMilliPercent)}) {money(amounts.tax.amountCents)}</>}
        </p>
        <p data-testid={`${prefix}-total`} className="font-black text-primary break-words"><strong>Total</strong> {money(amounts.totalCents)}</p>
      </div>
    </>
  );
}

interface SettingsFormProps {
  readonly panel: SettingsPanel;
  readonly waiting: boolean;
  readonly titleRef: RefObject<HTMLHeadingElement | null>;
  readonly saveRef: RefObject<HTMLButtonElement | null>;
  readonly passwordRef: RefObject<HTMLInputElement | null>;
  readonly confirmRef: RefObject<HTMLButtonElement | null>;
  readonly password: string;
  readonly onPassword: (value: string) => void;
  readonly onField: <K extends keyof IssuingSettingsFields>(field: K, value: IssuingSettingsFields[K]) => void;
  readonly onSave: () => void;
  readonly onRetry: (mode: 'open' | 'refresh') => void;
  readonly onLoadCurrent: () => void;
  readonly onReread: () => void;
  readonly onCheck: () => void;
  readonly onStop: () => void;
  readonly onConfirm: () => void;
}

export const SETTINGS_RULE_TEXT: Readonly<Record<'legalName' | 'storeName' | 'postalAddress' | 'taxRegistrationId' | 'taxMode' | 'rate', string>> = Object.freeze({
  legalName: 'Enter the legal seller name: 1 to 200 characters, without control or text-direction characters.',
  storeName: 'Enter the store name for invoices: 1 to 120 characters, without control or text-direction characters.',
  postalAddress: 'Enter the postal address: 1 to 8 lines of 1 to 120 characters each, with no empty line and no control or text-direction characters.',
  taxRegistrationId: 'Enter a tax registration ID of 1 to 64 characters, or leave it blank.',
  taxMode: 'Choose how tax is handled: an exclusive rate or no tax calculated.',
  rate: 'Enter a rate from 0 to 100 percent with at most three decimals, like 8.875.',
});

function SettingsForm({
  panel, waiting, titleRef, saveRef, passwordRef, confirmRef, password, onPassword, onField, onSave, onRetry, onLoadCurrent, onReread, onCheck, onStop, onConfirm,
}: SettingsFormProps) {
  const { fields, errors, attempt, loaded, status, stepUp, confirming } = panel;
  const readOnly = panel.store.readOnly;
  const live = attempt !== null;
  const ready = panel.phase === 'ready' && loaded !== null;
  const bad = (field: keyof IssuingSettingsErrors): boolean => errors?.[field] === true;
  const errorId = (field: string): string => `issued-settings-${field}-error`;
  const blocked = live ? SETTINGS_TEXT.saveBlocked : panel.saving ? SETTINGS_TEXT.busy : waiting ? SETTINGS_TEXT.saveWaiting
    : stepUp !== null || confirming ? SETTINGS_TEXT.signInFirst : panel.conflict ? SETTINGS_TEXT.conflictBlocked : panel.reading ? SETTINGS_TEXT.busy
      : panel.needsRead ? SETTINGS_TEXT.rereadBlocked : '';
  // Why a field cannot be changed, for every field it locks: a read-only store, or a save out or unconfirmed.
  const lockId = readOnly ? 'issued-settings-read-only' : live || panel.saving ? 'issued-settings-locked' : '';
  const described = (...ids: string[]): string => ids.filter(Boolean).join(' ');
  const confirmBlocked = confirming || waiting || (stepUp?.method === 'password' && password.length === 0);
  const field = (name: 'legalName' | 'storeName' | 'taxRegistrationId', id: string, label: string, hint: string) => (
    <div className="space-y-1">
      <label htmlFor={`issued-settings-${id}`} className={labelClass}>{label}</label>
      <input
        id={`issued-settings-${id}`}
        data-testid={`issued-settings-${id}`}
        type="text"
        autoComplete="off"
        dir="auto"
        aria-required={name !== 'taxRegistrationId'}
        aria-invalid={bad(name)}
        aria-describedby={described(`issued-settings-${id}-hint`, bad(name) ? errorId(id) : '', lockId)}
        value={fields[name]}
        onChange={(e) => onField(name, e.target.value)}
        className={inputClass}
      />
      <p id={`issued-settings-${id}-hint`} className={hintClass}>{hint}</p>
      {bad(name) && <p id={errorId(id)} data-testid={errorId(id)} role="alert" className="text-xs font-bold text-rose-700">{SETTINGS_RULE_TEXT[name]}</p>}
    </div>
  );
  const shown = panel.serverNow;
  return (
    <div id="issued-settings" role="region" aria-labelledby="issued-settings-title" data-testid="issued-settings" className="p-4 rounded-2xl border border-slate-200 space-y-4">
      <div>
        <h4 ref={titleRef} id="issued-settings-title" tabIndex={-1} className={`text-sm font-black text-primary uppercase tracking-widest ${focusRing}`}>Issuing settings</h4>
        <p className={hintClass}>{SETTINGS_TEXT.explain}</p>
      </div>
      <p data-testid="issued-settings-state" data-phase={panel.phase} role={panel.phase === 'denied' || panel.phase === 'not-found' ? 'alert' : 'status'} className="text-sm font-bold text-slate-600 min-h-[1rem]">
        {panel.phase === 'ready' ? '' : panel.text}
      </p>
      {(panel.phase === 'unavailable' || panel.phase === 'rate-limited') && (
        <button type="button" data-testid="issued-settings-retry" disabled={waiting} onClick={() => onRetry('open')} className={button}>Try again</button>
      )}
      {ready && (
        <>
          <div className="flex flex-wrap items-center gap-3">
            <p data-testid="issued-settings-version" className="text-sm font-bold text-slate-600">
              {loaded.configured ? SETTINGS_TEXT.version(loaded.version) : SETTINGS_TEXT.unconfigured}
            </p>
            <button type="button" data-testid="issued-settings-refresh" disabled={live || panel.reading || waiting || panel.saving || confirming} onClick={() => onRetry('refresh')} className={quiet}>Refresh</button>
          </div>
          {readOnly && <p id="issued-settings-read-only" data-testid="issued-settings-read-only" role="status" className="text-sm font-bold text-amber-800">{SETTINGS_TEXT.readOnly}</p>}
          {lockId === 'issued-settings-locked' && <span id="issued-settings-locked" className="sr-only">{SETTINGS_TEXT.locked}</span>}
          <form noValidate onSubmit={(e) => { e.preventDefault(); onSave(); }} className="space-y-4">
            <fieldset disabled={live || readOnly || panel.saving} className="space-y-4">
              <legend className="sr-only">Seller and tax</legend>
              {field('legalName', 'legal-name', 'Legal seller name (required)', 'The legal name of the business that issues the invoices: up to 200 characters.')}
              {field('storeName', 'store-name', 'Store name on invoices (required)', 'Up to 120 characters. It does not rename the store.')}
              <div className="space-y-1">
                <label htmlFor="issued-settings-postal-address" className={labelClass}>Postal address (required)</label>
                <textarea
                  id="issued-settings-postal-address"
                  data-testid="issued-settings-postal-address"
                  rows={4}
                  dir="auto"
                  autoComplete="off"
                  aria-required="true"
                  aria-invalid={bad('postalAddress')}
                  aria-describedby={described('issued-settings-postal-address-hint', bad('postalAddress') ? errorId('postal-address') : '', lockId)}
                  value={fields.postalAddress}
                  onChange={(e) => onField('postalAddress', e.target.value)}
                  className={inputClass}
                />
                <p id="issued-settings-postal-address-hint" className={hintClass}>One line per row: up to 8 lines of up to 120 characters each.</p>
                {bad('postalAddress') && <p id={errorId('postal-address')} data-testid={errorId('postal-address')} role="alert" className="text-xs font-bold text-rose-700">{SETTINGS_RULE_TEXT.postalAddress}</p>}
              </div>
              {field('taxRegistrationId', 'tax-id', 'Tax registration ID (optional)', 'Up to 64 characters; leave it blank when there is none.')}
              {/* The radios carry the tax mode's error (aria-invalid on a fieldset is not exposed). */}
              <fieldset data-testid="issued-settings-tax" className="space-y-2">
                <legend className={labelClass}>Tax (required)</legend>
                <label className="flex items-center gap-2 text-sm font-bold text-slate-700">
                  <input type="radio" name="issued-settings-tax" data-testid="issued-settings-tax-rate" value="exclusive_rate" checked={fields.taxMode === 'exclusive_rate'} onChange={() => onField('taxMode', 'exclusive_rate')}
                    aria-invalid={bad('taxMode')} aria-describedby={described(bad('taxMode') ? errorId('tax-mode') : '', lockId) || undefined} className={focusRing} />
                  Exclusive rate
                </label>
                <div className="pl-6 space-y-1">
                  <label htmlFor="issued-settings-rate" className={labelClass}>Rate (%)</label>
                  <input
                    id="issued-settings-rate"
                    data-testid="issued-settings-rate"
                    type="text"
                    inputMode="decimal"
                    autoComplete="off"
                    disabled={fields.taxMode !== 'exclusive_rate'}
                    aria-invalid={bad('rate')}
                    aria-describedby={described('issued-settings-rate-hint', bad('rate') ? errorId('rate') : '', lockId, fields.taxMode !== 'exclusive_rate' ? 'issued-settings-rate-off' : '')}
                    value={fields.rate}
                    onChange={(e) => onField('rate', e.target.value)}
                    className={`${inputClass} max-w-[10rem]`}
                  />
                  <p id="issued-settings-rate-hint" className={hintClass}>{SETTINGS_TEXT.rate}</p>
                  {fields.taxMode !== 'exclusive_rate' && <span id="issued-settings-rate-off" className="sr-only">{SETTINGS_TEXT.rateOff}</span>}
                  {bad('rate') && <p id={errorId('rate')} data-testid={errorId('rate')} role="alert" className="text-xs font-bold text-rose-700">{SETTINGS_RULE_TEXT.rate}</p>}
                </div>
                <label className="flex items-center gap-2 text-sm font-bold text-slate-700">
                  <input type="radio" name="issued-settings-tax" data-testid="issued-settings-tax-none" value="none" checked={fields.taxMode === 'none'} onChange={() => onField('taxMode', 'none')}
                    aria-invalid={bad('taxMode')} aria-describedby={described(bad('taxMode') ? errorId('tax-mode') : '', lockId) || undefined} className={focusRing} />
                  No tax calculated
                </label>
                <p data-testid="issued-settings-no-tax-note" className={`pl-6 ${hintClass}`}>{SETTINGS_TEXT.noTax}</p>
                {bad('taxMode') && <p id={errorId('tax-mode')} data-testid={errorId('tax-mode')} role="alert" className="text-xs font-bold text-rose-700">{SETTINGS_RULE_TEXT.taxMode}</p>}
              </fieldset>
            </fieldset>
            {stepUp !== null && (
              <div role="group" aria-labelledby="issued-settings-reauth-title" data-testid="issued-settings-reauth-group" className="flex flex-wrap items-end gap-3 p-3 rounded-xl bg-amber-50 border border-amber-100">
                <p id="issued-settings-reauth-title" className="w-full text-xs font-black text-amber-900">{SETTINGS_TEXT.reauthTitle}</p>
                {stepUp.method === 'password' && (
                  <div className="flex flex-col gap-1">
                    <label htmlFor="issued-settings-reauth-password" className={labelClass}>Your password</label>
                    {/* Enter confirms the sign-in: it never submits the settings form around it (a Save nobody pressed). */}
                    <input
                      ref={passwordRef}
                      id="issued-settings-reauth-password"
                      data-testid="issued-settings-reauth-password"
                      type="password"
                      autoComplete="current-password"
                      value={password}
                      readOnly={confirming}
                      onChange={(e) => onPassword(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); if (!confirmBlocked) onConfirm(); } }}
                      className="text-xs px-3 py-2 rounded-lg border border-slate-200 bg-white"
                    />
                  </div>
                )}
                {stepUp.method === null ? (
                  <p className="text-xs font-bold text-amber-800">Sign out and sign in again, then save this change.</p>
                ) : (
                  <>
                    <button
                      ref={confirmRef}
                      type="button"
                      data-testid="issued-settings-reauth-confirm"
                      aria-disabled={confirmBlocked}
                      aria-describedby="issued-settings-reauth-hint"
                      onClick={() => { if (!confirmBlocked) onConfirm(); }}
                      className={`px-4 py-2 bg-amber-700 text-white text-xs font-black uppercase tracking-widest rounded-xl aria-disabled:opacity-50 aria-disabled:cursor-not-allowed ${focusRing}`}
                    >
                      {stepUp.method === 'password' ? 'Confirm sign-in' : 'Sign in with Google again'}
                    </button>
                    <p id="issued-settings-reauth-hint" data-testid="issued-settings-reauth-hint" className="w-full text-[11px] font-medium text-amber-800 min-h-[1rem]">
                      {confirming ? SETTINGS_TEXT.confirmingSignIn : waiting ? SETTINGS_TEXT.signInWaiting : stepUp.method === 'google' ? 'A Google sign-in window opens.' : password.length === 0 ? 'Enter your password to confirm your sign-in.' : ''}
                    </p>
                  </>
                )}
              </div>
            )}
            {attempt !== null && (
              <div data-testid="issued-settings-attempt" data-state={attempt.body === '' ? 'detached' : attempt.state} className="p-4 rounded-2xl border border-amber-200 bg-amber-50 space-y-2">
                <p role="status" className="text-sm font-bold text-amber-900">
                  {attempt.state === 'sending' ? SETTINGS_TEXT.sending : attempt.state === 'checking' ? SETTINGS_TEXT.checking : SETTINGS_TEXT.unresolved}
                </p>
                {attempt.note !== '' && <p data-testid="issued-settings-attempt-note" className="text-xs font-bold text-amber-800">{attempt.note}</p>}
                {attempt.state !== 'sending' && (
                  <div className="flex flex-wrap gap-2">
                    {attempt.body !== '' && (
                      <button
                        type="button"
                        data-testid="issued-settings-check-again"
                        aria-disabled={waiting || attempt.state === 'checking'}
                        aria-describedby={waiting ? 'issued-settings-check-wait' : undefined}
                        onClick={() => { if (!waiting && attempt.state !== 'checking') onCheck(); }}
                        className={`${button} aria-disabled:opacity-50 aria-disabled:cursor-not-allowed`}
                      >
                        Check again
                      </button>
                    )}
                    {waiting && <span id="issued-settings-check-wait" className="sr-only">{SETTINGS_TEXT.checkWaiting}</span>}
                    <button
                      type="button"
                      data-testid="issued-settings-stop"
                      aria-disabled={attempt.state === 'checking'}
                      aria-describedby="issued-settings-stop-warning"
                      onClick={onStop}
                      className={`${quiet} aria-disabled:opacity-50 aria-disabled:cursor-not-allowed`}
                    >
                      Stop tracking
                    </button>
                    <p id="issued-settings-stop-warning" className={`w-full ${hintClass}`}>{SETTINGS_TEXT.stopWarning}</p>
                  </div>
                )}
              </div>
            )}
            <p data-testid="issued-settings-status" data-tone={status?.tone ?? ''} role={status?.tone === 'alert' ? 'alert' : 'status'}
              className={`text-sm font-bold min-h-[1rem] ${status?.tone === 'alert' ? 'text-rose-800' : status?.tone === 'saved' ? 'text-emerald-800' : 'text-slate-600'}`}>
              {status?.text ?? ''}
            </p>
            {panel.conflict && (
              <button type="button" data-testid="issued-settings-load-current" aria-disabled={panel.reading || waiting} onClick={onLoadCurrent}
                className={`${quiet} aria-disabled:opacity-50 aria-disabled:cursor-not-allowed`}>
                Load current version
              </button>
            )}
            {panel.needsRead && !panel.reading && stepUp === null && (
              <button type="button" data-testid="issued-settings-reread" aria-disabled={waiting} onClick={onReread}
                className={`${quiet} aria-disabled:opacity-50 aria-disabled:cursor-not-allowed`}>
                Check the settings again
              </button>
            )}
            {shown !== null && shown.configured && (
              <dl data-testid="issued-settings-server-now" className="grid grid-cols-1 sm:grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm p-3 rounded-xl border border-slate-100">
                <dt className={labelClass}>Legal seller name</dt><dd className="break-words"><bdi>{shown.legalName}</bdi></dd>
                <dt className={labelClass}>Store name on invoices</dt><dd className="break-words"><bdi>{shown.storeName}</bdi></dd>
                <dt className={labelClass}>Postal address</dt><dd className="break-words whitespace-pre-line" dir="auto">{shown.postalAddress}</dd>
                <dt className={labelClass}>Tax registration ID</dt><dd className="break-words">{shown.taxRegistrationId === null ? 'None' : <bdi>{shown.taxRegistrationId}</bdi>}</dd>
                <dt className={labelClass}>Tax</dt><dd>{taxText(shown)}</dd>
              </dl>
            )}
            {!readOnly && (
              <div className="flex flex-wrap items-center justify-end gap-3">
                {blocked !== '' && <span id="issued-settings-save-hint" data-testid="issued-settings-save-hint" className="sr-only">{blocked}</span>}
                <button
                  ref={saveRef}
                  type="submit"
                  data-testid="issued-settings-save"
                  aria-disabled={blocked !== ''}
                  aria-describedby={blocked !== '' ? 'issued-settings-save-hint' : undefined}
                  className={`${button} aria-disabled:opacity-50 aria-disabled:cursor-not-allowed`}
                >
                  Save
                </button>
              </div>
            )}
          </form>
        </>
      )}
    </div>
  );
}
