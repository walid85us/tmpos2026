// M7A-CUSTOMERS-P5 — the shop's server-backed Customer directory: the customers the tenant server holds for this store,
// read from GET /api/v1/customers (cursor pages) and GET /api/v1/customers/{id}/profile, and added through the idempotent
// POST /api/v1/customers. The server holds an id, a name and — since M7A-CUSTOMERS-P6 — an optional phone and email and
// the time it created the customer (none for a customer created before it kept one). The Customers screen's own contact,
// loyalty and history data stays in this browser and is not linked to these records.
//
//   - The server decides everything: who may view or add, which store this is, what a valid name is, what was stored.
//     `canCreate` is a hint from the local role state; a 403 is the answer that counts. Nothing here names a tenant,
//     store, role or actor.
//   - Server rows live in this page's own state and nowhere else: never in the local customer state, browser storage,
//     a URL query or a log. A detail shows its own answer (the profile read), never a list row; a phone or an email is
//     shown only there — never in a list row, a notice or the unresolved card.
//   - The form refuses here what the server would refuse (customersClient.ts restates its name, phone and email rules):
//     every invalid field says so, the first takes focus, and nothing is sent and no key taken. A blank phone or email is
//     left OUT of the body, so a name-only create keeps its exact bytes `{"name":"…"}`; otherwise the keys are name, phone,
//     email in that order. Contact drafts follow the name draft: kept across a connection change, cleared with it.
//   - A GENERATION is one store connection as this page knows it: a counter and the session's CSRF token, kept in refs.
//     `connect()` (the session client's `ensure`) runs before EVERY request, reads included. The first token fixes the
//     generation; a later DIFFERENT token starts a new one — reads in flight are cancelled, rows, cursor, detail and
//     notices are cleared, an unresolved create is detached, and the reads start again. A customer answer names no
//     store, so token EQUALITY is the only witness of "same session, same store"; inequality proves nothing and nothing
//     is inferred from it. A window focus or a return to the tab runs `connect()` so a changed session is noticed.
//   - A read answer applies only under the generation that started it, as the latest read started of its kind and — for
//     a detail — for the id the route still names. A superseded read is cancelled.
//   - Every read carries the token `connect()` just answered (M7A-CUSTOMERS-P5-R1, DA-138), and the server answers it
//     only under that session: when another tab replaced the cookie between the check and the read, the read is refused
//     (403) and nothing of the other session's reaches this page. A read refused 403 is followed by ONE session check:
//     another token starts a new generation, the same token leaves the refusal ("may not view") standing, and a check
//     that cannot decide (an outage, a wait) leaves it standing too — a refused read shows nothing either way.
//   - A create is NEVER sent automatically, and never under a token other than the one it was first sent with. "Add
//     customer" sends one POST under a new Idempotency-Key, only once `connect()` has answered this generation's own
//     token. It is "Saved on the server" ONLY on a validated 201 (a fresh execution or the same key's sealed replay)
//     that names the name sent. A refusal that decides this request (401, 403, 400/413/415, 404, 422, 429 on the first
//     send) ends the attempt with its own text and keeps the draft. Every other answer — a 409 in progress, a 5xx, a
//     200, a body it cannot name, no answer — leaves the attempt UNRESOLVED: a card that says the server may have saved
//     it, never "not saved".
//   - The unresolved attempt is held per user in a hold store (in memory only: its key, its exact body string, its
//     normalized name, the token it was sent with, a monotonic send time). "Check again" re-sends the SAME key and the
//     SAME bytes, only while this page's token is still the attempt's and the attempt is younger than 23 hours (the
//     server keeps a key for 24). After a token change the attempt is detached for good: it cannot be checked from
//     here, and a row with the same name is not proof. "Stop tracking" forgets it, after saying what that does not do.
//     Create answers are reconciled by KEY in the store, not by generation: a late answer is never dropped. An answer
//     that arrives after its page has gone is kept in the store as a terminal OUTCOME (saved, or conclusively refused)
//     until a mounted page holding a session token shows it; an undecided one stays as the unresolved attempt. The
//     React view of an attempt is token-free (the token stays in refs and the store). The store survives in-app
//     navigation, not a reload (persisting it would put a name, a key and a token in browser storage), though since
//     M7A-CUSTOMERS-P5-R1 a reloaded page usually reuses the same session (DA-137).
//   - A session END reaches the held create (M7B-INVOICES-P1-R2, DA-200). The hold store hears every sign-out from its
//     module's load (the session client's `onSessionEnd`), mounted page or not: every user's attempt loses its token
//     and its whole body (a name-only one too) and every recorded outcome its token — the in-memory holders are
//     cleared; bytes already sent, or copies the JavaScript engine still keeps, are not. A mounted page hears it too:
//     a new generation with no token, its reads stale, the form's name, phone and email, its notices and a wait gone,
//     and the ended state shown. An ended session a read finds (clearBoth) detaches the user's attempt the same way.
//     A detached-by-an-end attempt keeps its key, state, send time and name ONLY to settle a late answer by key and
//     validate a 201: it is never sent again (there is no token), never named again (its card and its "saved" or
//     "refused" news say "a customer sent before your server session ended"), and its late answer — while that end
//     stands, mounted or not — settles in the store only: nothing is shown, read or sent, and no token or body comes
//     back; the next generation's page (after Reconnect, or the next sign-in) shows it — that unnamed notice only: in no
//     later session does its result read, wait or touch the draft or the hold note. Every session check, read and
//     Add notes `sessionEndsSoFar` before asking and takes nothing from an answer asked for before a sign-out began;
//     Check again keeps only the key across its session check and reads the token and bytes from the store after it.
//     A remote expiry or revocation is learned only by a read or a check that asks (focus, a tab return, a click).
//   - A read the server refuses (a 401 or a 403 on the list or on a detail, or a session check that finds the session
//     ended or a sign-in the server no longer accepts) clears BOTH views: no rows, no cursor and no customer, whichever
//     view was reading. No read starts during a rate limit's wait (the later deadline wins; a wait text states the wait
//     running when written): a blocked page-one read is remembered and runs, once, when the wait ends (a read, never a
//     create); the first reads of a fresh page or generation still run. A failed "Load more" is a failed refresh: phase
//     unavailable / rate-limited, the rows kept under the last-known label, "Try again" reads page one.
//   - One page per signed-in user (keyed by UID): a user switch mounts a fresh page, and one user's attempt is never
//     shown to another.
//   - A session that ENDS is never re-established on its own (M7A-CUSTOMERS-P6): once the session client has confirmed
//     this user's session, its expiry or revocation makes `connect()` answer `ended` with no login and no ID token, and
//     the page shows the refusal state (both views cleared, "Reconnect"). Focus, a tab return, Refresh, Load more, a route
//     change, a wait's end, Add, Check again, Stop tracking and the check after a 403 all stay there: only the two
//     Reconnect buttons (directory-retry, directory-detail-retry, while signed out) ask the client to log in again. A
//     valid session of the same user that a read finds (another tab) is still taken with no login. The Reconnect's new
//     token is a new generation, so an unresolved create is detached, never re-sent. A Reconnect already pressed is never
//     cancelled by an `ended` that a plain caller reports meanwhile (the other view's read, a focus check out before the
//     click): that view waits for the Reconnect's own answer. An ended session also removes a "Saved on the server" notice.
//   - EDIT (M7A-CUSTOMERS-P7, PATCH /api/v1/customers/{id}). "Edit" is offered only on a profile this generation read
//     and confirmed (never a last-known one) that came with its row version, and only while `canEdit` (the local role
//     state's hint that Customers is at Edit or above) — the server's 403 is the answer that counts. The form starts
//     from that profile; its rules, texts and focus are the create form's. The body is built ONCE per attempt
//     (customersClient's `customerEditBody`: expectedVersion, name, and only the contacts that differ — a blank one is a
//     clear) and sent under a NEW key, only once `connect()` (plain: never a sign-in) has answered this generation's own
//     token. "Saved" ONLY on a 200 naming this customer and the name sent at the expected version (+1 when changed); then
//     the list is read again from page one (its row for this customer, when shown, takes the confirmed name meanwhile)
//     and the profile is read again — the values shown before the edit are never shown as last known, and a refresh
//     that fails says so without unsaying the save (a session end or a new connection that a refresh meets is said with
//     the save, on the list as on the profile). A 409 write_conflict keeps the
//     draft and offers "Review latest" (a read, nothing sent); only a later deliberate Save sends, built from the reviewed
//     version under a new key. Nothing is ever merged or sent on its own.
//   - An undecided edit (a 5xx, an unexpected answer, no answer) is held per user in its own hold store (in memory only:
//     the target id, the exact body, its expected version, the normalized name, the key, the token it was sent with, a
//     monotonic send time). "Check again" re-sends the SAME bytes under the SAME key to the SAME customer, only on a
//     click, only under that token and inside the create's 23-hour window; past it the body is emptied and only
//     "Discard" is left. A matching profile is never taken as proof. A held edit, in any state, is dropped (never
//     re-sent) as soon as another token is seen — a tenant switch, a Reconnect — or the session ends, and the page says
//     the change could not be confirmed; a user change or a sign-out drops the previous user's held edit too.
//   - A tenant switch (a new generation), a user change, a route change and a refusal clear the form, its draft and the
//     edit's notices; an answer that arrives for a dropped attempt changes nothing. A 403 on the edit closes the form.
//     Cancel sends nothing, also while Save is still checking the session. "Review latest" keeps only the fields the
//     user touched and takes every other one from the reviewed profile, so a save never reverts a field it did not
//     change. Notices go to two fixed live regions (a polite status, an assertive alert); focus moves to Edit after
//     Cancel or Discard, to "Review latest" on a conflict, and to the status after a confirmed save.
//   - SEARCH (M7A-CUSTOMERS-P8, GET /api/v1/customers?q=…). The list has a form labelled "Search customers by name". Its
//     input is a DRAFT: only Search (or Enter) APPLIES it, normalized by customersClient's `normalizeCustomerSearch`
//     (trimmed; blank is the unfiltered list; a refused character or more than 200 characters is said inline, and nothing
//     is sent); Clear empties the draft and applies no search. Applying drops the collected pages and the cursor and reads
//     page one. The applied query is part of the list state, with the rows it answered, so typing never relabels them:
//     Refresh, Load more, Try again, the read after a wait and a cursor's one reload all read under it. The server
//     matches; the page never filters, ranks or inserts a row: a confirmed create reloads page one under the applied
//     query, and a confirmed edit reloads the list from page one whether or not a search is applied (an outdated page
//     chain is never continued). "No customers match" is said only for a successful filtered page with no rows; a failed read shows the
//     list's own state, never "no matches". A search is a read: the same generation, sequence and session checks, no
//     search while a wait runs or once the session has ended (Reconnect stays the only sign-in), and nothing of a held
//     create or edit is touched. A refusal clears the applied query with the rows, an ended session clears the draft
//     too, and a new generation starts unfiltered (a tenant switch also empties the draft). The text lives only in this
//     page's state: never in the address, history, browser storage or a log.

import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { onAuthStateChanged } from 'firebase/auth';
import { Link, useParams } from 'react-router-dom';
import { useAccess } from '../context/AccessContext';
import { onSessionEnd, sessionEndsSoFar, tenantSession, type SessionResult, type TenantSessionClient } from './tenantSessionClient';
import {
  CONTACT_INVALID, customers as customersClient, isCustomerId, normalizeCustomerEmail, normalizeCustomerName, normalizeCustomerPhone, normalizeCustomerSearch,
  customerEditBody, type CreateResult, type CustomerEntry, type CustomerProfile, type CustomersClient, type UpdateResult,
} from './customersClient';
import { firebaseShopIdentity, type ShopIdentity } from './ServerCustomerLevels';
import { auth } from '../firebase';

export const DIRECTORY_PATH = '/customers/directory';
/** No "Check again" from here on: a conservative client cutoff under the server's 24-hour key retention. */
export const CHECK_CUTOFF_MS = 23 * 60 * 60_000;
const DEFAULT_WAIT_SECONDS = 60;

export const EMPTY_TEXT = 'No customers are saved on the server for this store yet.';
export const NOT_FOUND_TEXT = 'No customer with this address is available in this store.';
export const CONNECTION_CHANGED_TEXT = 'The store connection changed. Check the list, then add again.';
export const LAST_KNOWN_TEXT = 'Last known list — could not refresh';
export const savedEarlierText = (name: string): string => `"${name}" was saved on the server under the earlier connection.`;
/**
 * What is said of an attempt a session END detached (M7B-INVOICES-P1-R2, DA-200), on the signed-out page and on every
 * page after it: never its name or a contact — the next session may be another tenant's, as the drafts section's
 * "earlier" texts.
 */
export const ENDED_TEXT = Object.freeze({
  sending: 'A customer sent before your server session ended is still waiting for the server\'s answer.',
  unresolved: 'Not confirmed yet: a customer sent before your server session ended. The server may have saved it.',
  saved: 'A customer sent before your server session ended was saved on the server.',
  refused: 'A customer sent before your server session ended was not added: the server refused that request.',
});
export const STOP_WARNING_TEXT =
  'Stop tracking does not cancel the request, and adding the same name again can create a second customer.';
export const NAME_RULE_TEXT = 'Enter a name of 1 to 200 characters, without control or text-direction characters.';
export const PHONE_RULE_TEXT = 'Enter a phone number of up to 64 characters with at least one digit and no control or text-direction characters, or leave it blank.';
export const EMAIL_RULE_TEXT = 'Enter an email address of up to 254 characters with exactly one @, no spaces and no control or text-direction characters, or leave it blank.';
export const SEARCH_RULE_TEXT = 'Enter up to 200 characters to search, without control or text-direction characters.';
/** What a list says of the search its rows answer (M7A-CUSTOMERS-P8). */
export const searchMatchingText = (query: string): string => `Customers matching “${query}”`;
/** Said only for a successful page of that search with no rows. */
export const searchNoneText = (query: string): string => `No customers match “${query}”.`;
export const NOT_PROVIDED_TEXT = 'Not provided';
export const NOT_RECORDED_TEXT = 'Not recorded';
/** A creation time (`YYYY-MM-DDTHH:mm:ss.sssZ`, as the client admits it) as `YYYY-MM-DD HH:mm UTC`. */
export const createdText = (iso: string): string => `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
export const unresolvedText = (name: string): string => `Not confirmed yet: "${name}". The server may have saved it.`;
export const EDIT_SAVED_TEXT = 'Saved';
export const EDIT_SAVED_UNREFRESHED_TEXT = 'Saved, but the latest details could not be loaded.';
export const EDIT_NO_CHANGES_TEXT = 'No changes to save.';
export const EDIT_CONFLICT_TEXT = 'Someone else changed this customer. Review the latest details, then save again.';
export const EDIT_REVIEWED_TEXT = 'The latest details are loaded. Your changes are still in the form: save again to apply them.';
export const EDIT_UNKNOWN_TEXT = "We couldn't confirm whether your changes were saved.";
export const EDIT_DENIED_TEXT = "You can't edit this customer.";
export const EDIT_DISCARD_WARNING_TEXT = 'Discard does not cancel the request: the change may still be applied on the server.';
const EDIT_TEXT = Object.freeze({
  notFound: 'This customer is no longer available in this store. Nothing was changed.',
  invalid: 'The server did not accept these customer details. Nothing was changed.',
  keyReused: 'The server rejected this request. Nothing was changed.',
  ended: 'Not saved: your server session ended. Reconnect to continue.',
  endedHeld: 'Your server session ended before a change could be confirmed. After you reconnect, check the customer\'s details.',
  connectionHeld: 'The store connection changed before a change could be confirmed. Check the customer\'s details.',
  connectionRefused: 'Not saved: the store connection changed. Nothing was changed.',
  savedThenEnded: 'Your changes were saved, but your server session then ended. Reconnect to see the latest details.',
  savedThenChanged: 'Your changes were saved, but the store connection then changed.',
  tooOld: 'Not checked: it was sent too long ago.',
  conflictClosed: 'Your changes were not saved: someone else changed this customer first. The latest details are shown: edit again to change them.',
  saving: 'Saving your changes…',
  checking: 'Checking your changes with the server…',
  deniedHeld: "You can't edit this customer. Whether the earlier change was saved could not be confirmed.",
  reviewFailed: 'The latest details could not be loaded. Try again.',
});
/** What became of an edit, said for a customer that is not the one shown (named by the name that was sent). */
export type EditOutcomeKind = 'saved' | 'conflict' | 'gone' | 'denied' | 'deniedHeld' | 'refused' | 'unconfirmed' | 'undecided';
export function editNamedText(kind: EditOutcomeKind, name: string): string {
  switch (kind) {
    case 'saved': return `Your changes to "${name}" were saved.`;
    case 'conflict': return `Your changes to "${name}" were not saved: someone else changed that customer first. Open it to review the latest details.`;
    case 'gone': return `Your changes to "${name}" were not saved: that customer is no longer available in this store.`;
    case 'denied': return `Your changes to "${name}" were not saved: you can't edit that customer.`;
    case 'deniedHeld': return `Your changes to "${name}" could not be confirmed: you can't edit that customer.`;
    case 'refused': return `Your changes to "${name}" were not saved.`;
    case 'undecided': return `Your changes to "${name}" could not be confirmed. Check them again, or check the customer's details.`;
    default: return `Your changes to "${name}" could not be confirmed. Check the customer's details.`;
  }
}
/**
 * A confirmed save's later news, said by name on another page: only that the session then ended (shown under that same
 * ended session; a Reconnect drops it). Every notice that follows a CONNECTION change stays unnamed — "saved, then the
 * connection changed", a held edit dropped by a changed connection or an ended session, a save refused by either: after
 * a connection change (possibly to another tenant) no customer name from before it is ever shown.
 */
const editEventText = Object.freeze({
  savedThenEnded: (name: string) => `Your changes to "${name}" were saved, but your server session then ended. Reconnect to see the latest details.`,
});
const waitText = (seconds: number): string => `Too many requests. Wait ${seconds} second${seconds === 1 ? '' : 's'}, then try again.`;
const waitHint = (seconds: number): string => `Wait ${seconds} second${seconds === 1 ? '' : 's'}.`;

const TEXT = Object.freeze({
  loading: 'Loading customers from the server…',
  denied: 'This account may not view the customers saved on the server for this store.',
  sessionEnded: 'Your server session ended. Reconnect to see the customers saved on the server.',
  noIdentity: 'Sign in with your store account to see the customers saved on the server.',
  refused: 'The store server did not accept this sign-in. Reconnect, or sign out and sign in again.',
  unreachable: 'The customer directory is unavailable right now.',
  reloaded: 'The list changed on the server, so it was loaded again from the start.',
  detailLoading: 'Loading this customer from the server…',
});

/** What a first send's conclusive refusal says: this request did not go through. Never "saved". */
const REFUSED_TEXT = Object.freeze({
  'signed-out': 'Not sent through: your server session ended. Reconnect, then add again.',
  denied: 'Refused by the server. This account may not add customers to this store.',
  invalid: 'The server did not accept these customer details. Nothing was added.',
  absent: 'The store server does not offer adding customers here. Nothing was added.',
  'key-reused': 'The server rejected this request.',
});

/** Why a check left the attempt unresolved. Never "not saved": only a validated 201 for the same key decides it. */
function reasonOf(answer: CreateResult, waitSeconds?: number): string {
  switch (answer.kind) {
    case 'in-progress': return 'The server is still working on it. Check again in a moment.';
    case 'signed-out': return 'Sign-in needed: your server session ended. Reconnect, then check again.';
    case 'denied': return 'The server refused this check.';
    case 'rate-limited': return `Too many requests. ${waitHint(waitSeconds ?? answer.retryAfterSeconds)}`;
    case 'key-reused': return 'The server no longer accepts this as the same request.';
    case 'invalid': return 'The server did not accept this check.';
    case 'absent': return 'The store server does not offer this check here.';
    case 'created': return 'The server answered with a different customer name.';
    default: return answer.responded ? 'The server answered, but not with a result.' : 'No answer from the server.';
  }
}

/** Why a check left an edit unresolved. Never "not saved": only a validated 200 for the same key decides it. */
function editReasonOf(answer: UpdateResult, waitSeconds?: number): string {
  switch (answer.kind) {
    case 'in-progress': return 'The server is still working on it. Check again in a moment.';
    case 'rate-limited': return `Too many requests. ${waitHint(waitSeconds ?? answer.retryAfterSeconds)}`;
    case 'key-reused': return 'The server no longer accepts this as the same request.';
    case 'invalid': return 'The server did not accept this check.';
    case 'saved': return 'The server answered with different details.';
    case 'unknown': return answer.responded ? 'The server answered, but not with a result.' : 'No answer from the server.';
    default: return 'The server answered, but not with a result.';
  }
}

/** A create whose outcome is not known yet: exactly what a check must send again, and the connection it belongs to. */
export interface HeldCreate {
  readonly key: string;
  /**
   * The exact request body string — `{ name }`, with a phone and an email when given — never rebuilt. Once the attempt
   * can never be sent again (detached, or past the check cutoff) a body that carries a contact is emptied (''), so no
   * phone or email is kept for an attempt that cannot use it; a name-only body holds nothing but the name and stays.
   */
  readonly body: string;
  /** The normalized name that was sent. */
  readonly name: string;
  /** The session token it was sent with; null once detached (the page's connection changed since, or the session ended). */
  readonly csrf: string | null;
  /** A monotonic reading taken when it was sent. */
  readonly sentAt: number;
  readonly state: 'sending' | 'unresolved' | 'checking';
  /**
   * Detached by a session END (M7B-INVOICES-P1-R2, DA-200: a sign-out, or an ended session a read found): its body is
   * gone, and its name is kept only to validate a late 201 for its key — it is never shown again.
   */
  readonly ended?: true;
}

/** What a create that settled after its page had gone ended as; kept until a mounted page shows it. */
export type HoldOutcome =
  | {
    readonly kind: 'saved'; readonly customer: CustomerEntry; /** The token the attempt was sent with; null once detached. */ readonly csrf: string | null;
    /** Whether the body sent was name-only (no contact): only then can a later page's draft be matched against it. */ readonly plain: boolean;
    /** Its attempt was detached by a session end, or a session ended since it settled: shown without its name. */ readonly ended?: true;
  }
  | { readonly kind: 'refused'; readonly name: string; readonly ended?: true };

/** What React sees of an attempt: everything but the session token, frozen and stable between store changes. */
interface HeldView {
  readonly key: string;
  /** '' once a session end detached it: React never sees that name. */
  readonly name: string;
  readonly state: HeldCreate['state'];
  readonly sentAt: number;
  readonly detached: boolean;
  readonly ended: boolean;
}
const views = new WeakMap<HeldCreate, HeldView>();
function viewOf(held: HeldCreate | undefined): HeldView | undefined {
  if (held === undefined) return undefined;
  let view = views.get(held);
  if (view === undefined) {
    const ended = held.ended === true;
    view = Object.freeze({ key: held.key, name: ended ? '' : held.name, state: held.state, sentAt: held.sentAt, detached: held.csrf === null, ended });
    views.set(held, view);
  }
  return view;
}

/** What an attempt that can never be sent again keeps of its body: a name-only body (nothing but the name), else ''. */
const unusableBody = (attempt: Pick<HeldCreate, 'body' | 'name'>): string =>
  attempt.body === JSON.stringify({ name: attempt.name }) ? attempt.body : '';

/** What was sent, as the draft is compared with it; null when the body no longer says (a contact was sent, then emptied). */
interface Sent { readonly name: string; readonly phone: string | null; readonly email: string | null }
function sentOf(attempt: Pick<HeldCreate, 'body' | 'name'>): Sent | null {
  if (attempt.body === '') return null;
  const fields = JSON.parse(attempt.body) as { phone?: string; email?: string }; // this page's own string
  return { name: attempt.name, phone: fields.phone ?? null, email: fields.email ?? null };
}

/** At most one held create per user, in memory only. */
export interface HoldStore {
  get(uid: string): HeldCreate | undefined;
  /** Hold `attempt` for `uid`; false (and nothing held) when that user already has one. */
  put(uid: string, attempt: HeldCreate): boolean;
  /** Change the attempt under `key`; false when the store's attempt is another (a stale continuation is a no-op). */
  /** Detaching (`csrf: null`) also empties a body that carries a contact (see HeldCreate.body). */
  change(uid: string, key: string, next: Partial<Pick<HeldCreate, 'csrf' | 'state' | 'body' | 'ended'>>): boolean;
  remove(uid: string, key: string): boolean;
  /** Remove the attempt under `key` and record its terminal `outcome` (one per user; a newer one replaces it). */
  finish(uid: string, key: string, outcome: HoldOutcome): boolean;
  /** The recorded outcome, forgotten as it is returned. */
  takeOutcome(uid: string): HoldOutcome | undefined;
  /**
   * A session end (M7B-INVOICES-P1-R2, DA-200), for every user: each held attempt loses its token and its whole body
   * (a name-only one too) and is marked `ended`; each recorded outcome loses its token and is marked `ended`. Keys,
   * states, send times and names stay, so a late answer still settles its attempt by key.
   */
  detachAll(): void;
  subscribe(listener: () => void): () => void;
}

export function createHoldStore(): HoldStore {
  const held = new Map<string, HeldCreate>();
  const outcomes = new Map<string, HoldOutcome>();
  const listeners = new Set<() => void>();
  const tell = (): void => { for (const listener of [...listeners]) listener(); };
  return Object.freeze({
    get: (uid: string) => held.get(uid),
    put(uid: string, attempt: HeldCreate): boolean {
      if (held.has(uid)) return false;
      held.set(uid, Object.freeze({ ...attempt }));
      tell();
      return true;
    },
    change(uid: string, key: string, next: Partial<Pick<HeldCreate, 'csrf' | 'state' | 'body' | 'ended'>>): boolean {
      const current = held.get(uid);
      if (current === undefined || current.key !== key) return false;
      const changed = { ...current, ...next };
      held.set(uid, Object.freeze(next.csrf === null ? { ...changed, body: unusableBody(changed) } : changed));
      tell();
      return true;
    },
    remove(uid: string, key: string): boolean {
      if (held.get(uid)?.key !== key) return false;
      held.delete(uid);
      tell();
      return true;
    },
    finish(uid: string, key: string, outcome: HoldOutcome): boolean {
      if (held.get(uid)?.key !== key) return false;
      held.delete(uid);
      outcomes.set(uid, outcome);
      tell();
      return true;
    },
    takeOutcome(uid: string): HoldOutcome | undefined {
      const outcome = outcomes.get(uid);
      outcomes.delete(uid);
      return outcome;
    },
    detachAll(): void {
      let changed = false;
      for (const [uid, current] of held) {
        if (current.ended === true) continue; // already token-less and body-less
        held.set(uid, Object.freeze({ ...current, csrf: null, body: '', ended: true as const }));
        changed = true;
      }
      for (const [uid, outcome] of outcomes) {
        if (outcome.ended === true) continue;
        outcomes.set(uid, Object.freeze(outcome.kind === 'saved' ? { ...outcome, csrf: null, ended: true as const } : { ...outcome, ended: true as const }));
        changed = true;
      }
      if (changed) tell();
    },
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  });
}

/** Tie a hold store to the session client's `onSessionEnd`: every sign-out detaches every attempt. Returns the unbinding. */
export function bindHoldsToSessionEnd(store: HoldStore): () => void {
  return onSessionEnd(() => store.detachAll());
}

/**
 * The shop's one hold store: it outlives the page across in-app navigation, and ends with the page load. It hears every
 * sign-out from the module's load, whether or not a directory page is mounted (a hot reload unbinds it with the module).
 */
const holdStore: HoldStore = createHoldStore();
const unbindHolds = bindHoldsToSessionEnd(holdStore);
import.meta.hot?.dispose(unbindHolds);

/** An edit whose outcome is not known yet (M7A-CUSTOMERS-P7): exactly what "Check again" sends again, and where. */
export interface HeldEdit {
  readonly key: string;
  /** The customer the PATCH names. */
  readonly customerId: string;
  /** The exact request body string, never rebuilt; '' once it can never be sent again (past the check cutoff). */
  readonly body: string;
  /** The version the body expects (its `expectedVersion`). */
  readonly expectedVersion: number;
  /** The normalized name that was sent. */
  readonly name: string;
  /** The session token it was sent with: a held edit is never sent under another (it is dropped instead). */
  readonly csrf: string;
  readonly sentAt: number;
  readonly state: 'sending' | 'unresolved' | 'checking';
}

/** At most one held edit per user, in memory only; separate from the create's store. */
export interface EditHoldStore {
  get(uid: string): HeldEdit | undefined;
  /** Hold `attempt` for `uid`; false (and nothing held) when that user already has one. */
  put(uid: string, attempt: HeldEdit): boolean;
  /** Change the attempt under `key`; false when the store's attempt is another. */
  change(uid: string, key: string, next: Partial<Pick<HeldEdit, 'state' | 'body'>>): boolean;
  remove(uid: string, key: string): boolean;
  /** Remove the attempt under `key` and record what became of it, for the next page of that user (one per user). */
  finish(uid: string, key: string, outcome: EditOutcome): boolean;
  /** Record what a page that has gone learned of the attempt under `key`, keeping the attempt held (an undecided answer). */
  announce(uid: string, key: string, outcome: EditOutcome): boolean;
  /** The recorded outcome, forgotten as it is returned. */
  takeOutcome(uid: string): EditOutcome | undefined;
  /** Drop every other user's held edit and outcome (a user change or a sign-out): nothing is kept for anyone else. */
  keepOnly(uid: string | null): void;
  subscribe(listener: () => void): () => void;
}

/**
 * An edit that settled after its page had gone: no body, no contact. `csrf` is the token it was sent under: a page shows
 * it only under that same token (the same session, so the same tenant), as a create's outcome; otherwise it is dropped.
 */
export interface EditOutcome { readonly kind: EditOutcomeKind; readonly customerId: string; readonly name: string; readonly csrf: string }

export function createEditHoldStore(): EditHoldStore {
  const held = new Map<string, HeldEdit>();
  const outcomes = new Map<string, EditOutcome>();
  const listeners = new Set<() => void>();
  const tell = (): void => { for (const listener of [...listeners]) listener(); };
  return Object.freeze({
    get: (uid: string) => held.get(uid),
    put(uid: string, attempt: HeldEdit): boolean {
      if (held.has(uid)) return false;
      held.set(uid, Object.freeze({ ...attempt }));
      tell();
      return true;
    },
    change(uid: string, key: string, next: Partial<Pick<HeldEdit, 'state' | 'body'>>): boolean {
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
    finish(uid: string, key: string, outcome: EditOutcome): boolean {
      if (held.get(uid)?.key !== key) return false;
      held.delete(uid);
      outcomes.set(uid, Object.freeze({ ...outcome }));
      tell();
      return true;
    },
    announce(uid: string, key: string, outcome: EditOutcome): boolean {
      if (held.get(uid)?.key !== key) return false;
      outcomes.set(uid, Object.freeze({ ...outcome }));
      tell();
      return true;
    },
    takeOutcome(uid: string): EditOutcome | undefined {
      const outcome = outcomes.get(uid);
      outcomes.delete(uid);
      return outcome;
    },
    keepOnly(uid: string | null): void {
      for (const who of [...outcomes.keys()]) if (who !== uid) outcomes.delete(who);
      const others = [...held.keys()].filter((who) => who !== uid);
      for (const who of others) held.delete(who);
      if (others.length > 0) tell();
    },
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  });
}

/** The shop's one edit hold store, like `holdStore`. */
const editHoldStore: EditHoldStore = createEditHoldStore();

/**
 * Tie a store to the signed-in user: on a sign-out or another user, every other user's held edit and outcome is dropped
 * — whether or not a directory page is mounted. The same user keeps them (in-app navigation). Returns the unbinding.
 */
export function bindEditHoldsToAuth(store: EditHoldStore, watch: (listener: (uid: string | null) => void) => () => void): () => void {
  return watch((uid) => store.keepOnly(uid));
}
let editHoldStoreBound = false;
/** The shop's store follows the app's own sign-in state (the provider the access context listens to). */
function bindShopEditHolds(): void {
  if (editHoldStoreBound) return;
  editHoldStoreBound = true;
  bindEditHoldsToAuth(editHoldStore, (listener) => onAuthStateChanged(auth, (user) => listener(user?.uid ?? null)));
}

/** What React sees of a held edit: no token, no body. */
interface HeldEditView { readonly key: string; readonly name: string; readonly state: HeldEdit['state']; readonly sentAt: number }
const editViews = new WeakMap<HeldEdit, HeldEditView>();
function editViewOf(held: HeldEdit | undefined): HeldEditView | undefined {
  if (held === undefined) return undefined;
  let view = editViews.get(held);
  if (view === undefined) {
    view = Object.freeze({ key: held.key, name: held.name, state: held.state, sentAt: held.sentAt });
    editViews.set(held, view);
  }
  return view;
}

type ListPhase = 'loading' | 'ready' | 'denied' | 'signed-out' | 'rate-limited' | 'unavailable';
type DetailPhase = ListPhase | 'not-found';
interface ListState {
  readonly phase: ListPhase;
  readonly text: string;
  readonly rows: readonly CustomerEntry[]; // in arrival order (the server's byte order); never re-sorted
  readonly next: string | null;
  readonly note: string;
  readonly query: string; // the applied search the rows and the cursor answer ('' for none: the unfiltered list)
}
interface DetailState {
  readonly id: string | null;
  readonly phase: DetailPhase;
  readonly text: string;
  readonly customer: CustomerProfile | null; // this id's own answer (its profile) in this generation
  readonly version?: number; // that answer's row version: only on a profile read and confirmed now ('ready')
}
/** An edit notice: `customerId` binds it to a customer (its own `text` there, `named` anywhere else). */
interface EditNotice { readonly alert: boolean; readonly text: string; readonly customerId?: string; readonly named?: string }
/** The open edit form: the customer, and the profile and version it was loaded (or last reviewed) from. */
interface EditForm { readonly id: string; readonly base: CustomerProfile; readonly version: number; readonly conflict: boolean }
/** A read or a session that did not answer with rows: the phase it puts the page in and what it says. */
interface Failure { readonly kind: 'denied' | 'signed-out' | 'rate-limited' | 'unavailable'; readonly text: string; readonly seconds?: number }

const LIST_INITIAL: ListState = Object.freeze({ phase: 'loading', text: TEXT.loading, rows: [], next: null, note: '', query: '' });
const DETAIL_NONE: DetailState = Object.freeze({ id: null, phase: 'loading', text: '', customer: null });
interface Fields { readonly name: string; readonly phone: string; readonly email: string }
const NO_FIELDS: Fields = Object.freeze({ name: '', phone: '', email: '' });

function sessionFailure(s: Exclude<SessionResult, { kind: 'ok' }>): Failure {
  if (s.kind === 'no-identity') return { kind: 'signed-out', text: TEXT.noIdentity };
  if (s.kind === 'refused') return { kind: 'signed-out', text: TEXT.refused };
  if (s.kind === 'ended') return { kind: 'signed-out', text: TEXT.sessionEnded };
  if (s.kind === 'rate-limited') {
    const seconds = s.retryAfterSeconds ?? DEFAULT_WAIT_SECONDS;
    return { kind: 'rate-limited', text: waitText(seconds), seconds };
  }
  return { kind: 'unavailable', text: TEXT.unreachable };
}

/** A read answer that is not a result (`ok`, and a read's own `not-found` / `bad-cursor`, are decided before this). */
function readFailure(answer: { readonly kind: string; readonly retryAfterSeconds?: number }): Failure {
  if (answer.kind === 'rate-limited') {
    const seconds = answer.retryAfterSeconds ?? DEFAULT_WAIT_SECONDS;
    return { kind: 'rate-limited', text: waitText(seconds), seconds };
  }
  if (answer.kind === 'denied') return { kind: 'denied', text: TEXT.denied };
  if (answer.kind === 'signed-out') return { kind: 'signed-out', text: TEXT.sessionEnded };
  return { kind: 'unavailable', text: TEXT.unreachable };
}

export interface ServerCustomerDirectoryProps {
  /** The signed-in shop user's UID (the Firebase UID), or null when nobody is signed in. */
  readonly uid: string | null;
  /** The route's `:id`, exactly as the address names it; null on the list. */
  readonly routeId: string | null;
  /** The local role state's hint that this user may add customers. The server decides. */
  readonly canCreate: boolean;
  /** The local role state's hint that this user may edit customers (Customers at Edit or above). The server decides. */
  readonly canEdit?: boolean;
  readonly session?: TenantSessionClient;
  readonly customers?: CustomersClient;
  readonly identity?: Pick<ShopIdentity, 'idToken'>;
  readonly holds?: HoldStore;
  readonly editHolds?: EditHoldStore;
  readonly newKey?: () => string;
  /** A monotonic clock in milliseconds (default `performance.now()`). */
  readonly now?: () => number;
}

/** The routed page: the address's id, the signed-in user and the local create hint; everything else is the server's. */
export function CustomerDirectoryPage(inject: Omit<ServerCustomerDirectoryProps, 'uid' | 'routeId' | 'canCreate' | 'canEdit'>) {
  const { id } = useParams();
  const access = useAccess();
  return (
    <ServerCustomerDirectory
      {...inject}
      uid={access.session?.user.id ?? null}
      routeId={id ?? null}
      canCreate={access.hasPermission('customers')}
      canEdit={access.checkPermission('customers', 'edit')}
    />
  );
}

/**
 * One page per signed-in user: a user switch or sign-out mounts a fresh page (keyed by UID), so its first render shows
 * nothing of the previous user, and nothing that user's reads answer later ever reaches it.
 */
export default function ServerCustomerDirectory(props: ServerCustomerDirectoryProps) {
  return <UserPage key={props.uid ?? ''} {...props} />;
}

function UserPage({
  uid, routeId, canCreate, canEdit = false, session = tenantSession, customers = customersClient, identity = firebaseShopIdentity,
  holds = holdStore, editHolds = editHoldStore, newKey, now,
}: ServerCustomerDirectoryProps) {
  const [list, setList] = useState<ListState>(LIST_INITIAL);
  const [listBusy, setListBusy] = useState(false);
  const [detail, setDetail] = useState<DetailState>(DETAIL_NONE);
  const [draft, setDraft] = useState<Fields>(NO_FIELDS);
  const [errors, setErrors] = useState<Fields>(NO_FIELDS); // each field's rule text while it is refused here
  const [createStatus, setCreateStatus] = useState<{ readonly refusal: boolean; readonly text: string; readonly named?: true } | null>(null);
  // A confirmed create: this session's (named, with its link), or an earlier connection's (named, or `null` once a session
  // end detached it: unnamed).
  const [saved, setSaved] = useState<CustomerEntry | { readonly earlier: string | null } | null>(null);
  const [connectionChanged, setConnectionChanged] = useState(false);
  const [wait, setWait] = useState<number | null>(null); // the seconds a rate limit asked for, while that wait runs
  const [adding, setAdding] = useState(false);
  const [holdNote, setHoldNote] = useState<{ readonly key: string; readonly text: string } | null>(null);
  const [, setTick] = useState(0);
  const attempt = useSyncExternalStore(holds.subscribe, () => (uid === null ? undefined : viewOf(holds.get(uid)))); // token-free
  const [edit, setEdit] = useState<EditForm | null>(null);
  const [editDraft, setEditDraft] = useState<Fields>(NO_FIELDS);
  const [editErrors, setEditErrors] = useState<Fields>(NO_FIELDS);
  // A notice; `customerId` binds it to a customer: shown as `text` there, as `named` anywhere else.
  const [editStatus, setEditStatus] = useState<EditNotice | null>(null);
  const [editNote, setEditNote] = useState<{ readonly key: string; readonly text: string } | null>(null);
  const [editing, setEditing] = useState(false); // a save, a check or a review is out
  const editHeld = useSyncExternalStore(editHolds.subscribe, () => (uid === null ? undefined : editViewOf(editHolds.get(uid)))); // token-free
  const [searchDraft, setSearchDraft] = useState(''); // the search box's text; the APPLIED query is the list's own
  const [searchRefused, setSearchRefused] = useState(false); // the draft last applied is one the server would refuse

  const gen = useRef<{ n: number; csrf: string | null }>({ n: 0, csrf: null }); // the token never leaves refs and the hold store
  const alive = useRef(false);
  const listRef = useRef<ListState>(LIST_INITIAL);
  const detailRef = useRef<DetailState>(DETAIL_NONE);
  const routeRef = useRef<string | null>(routeId);
  const lastRoute = useRef<string | null | undefined>(undefined);
  const listSeq = useRef(0); // the start order of list reads
  const detailSeq = useRef(0);
  // The read a Reconnect click started, per view, while its session step is still out (0: none): an ended session that a
  // plain caller reports meanwhile does not cancel it — the Reconnect is the user's own request, and it answers itself.
  const reconnecting = useRef({ list: 0, detail: 0 });
  const listCtl = useRef<AbortController | null>(null);
  const detailCtl = useRef<AbortController | null>(null);
  const addRef = useRef(false);
  const checkRef = useRef(false);
  const waitRef = useRef(false);
  const waitUntil = useRef(0); // the monotonic deadline of the running wait
  const reloadAfterWait = useRef<{ readonly note: string } | null>(null); // a page-one read a wait blocked
  const waitTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const listTitle = useRef<HTMLHeadingElement | null>(null);
  const detailTitle = useRef<HTMLHeadingElement | null>(null);
  const savedNotice = useRef<HTMLParagraphElement | null>(null);
  const nameInput = useRef<HTMLInputElement | null>(null);
  const phoneInput = useRef<HTMLInputElement | null>(null);
  const emailInput = useRef<HTMLInputElement | null>(null);
  const focusSaved = useRef(false);
  const editRef = useRef<EditForm | null>(null);
  const editBusy = useRef(false);
  // Bumped when the context an edit request belongs to is gone (a new generation, an ended session): that request's
  // own end then changes nothing, and the new context's controls are free at once.
  const editEpoch = useRef(0);
  const endedSeen = useRef(0); // counts confirmed session ends (clearBoth): a refresh after a save learns of one from it
  // Set by a session end (a sign-out heard here, or an ended session a read found) until the next generation's first
  // token: meanwhile a create's late answer settles in the hold store only — nothing is shown, read or sent for it.
  const signedOut = useRef(false);
  const cancelledForm = useRef<EditForm | null>(null); // the form an explicit Cancel closed (navigation is not a Cancel)
  const editStatusRef = useRef<EditNotice | null>(null); // the notice as last put (the state may be mid-announcement)
  const announceSeq = useRef(0);
  const editName = useRef<HTMLInputElement | null>(null);
  const editPhone = useRef<HTMLInputElement | null>(null);
  const editEmail = useRef<HTMLInputElement | null>(null);
  const focusTarget = useRef<'name' | 'edit' | 'review' | 'status' | 'alert' | 'hold' | 'title' | null>(null);
  const editButton = useRef<HTMLButtonElement | null>(null);
  const reviewButton = useRef<HTMLButtonElement | null>(null);
  const editPolite = useRef<HTMLParagraphElement | null>(null);
  const editAlertRef = useRef<HTMLParagraphElement | null>(null);
  const editForm = useRef<HTMLFormElement | null>(null);
  const editCard = useRef<HTMLDivElement | null>(null);
  const searchInput = useRef<HTMLInputElement | null>(null);
  const checkButton = useRef<HTMLButtonElement | null>(null); // the held create's Check again
  const titleFrom = useRef<Element | null>(null); // where focus was when the heading was chosen as its destination

  const clock = (): number => (now ?? (() => performance.now()))();
  const nextKey = (): string => (newKey ?? (() => crypto.randomUUID()))(); // one fresh Idempotency-Key per new attempt
  /** The session for `who`: plain (never signs in after an end), `fresh` (the check after a 403) or `reconnect` (the user's click). */
  const connect = (who: string, mode?: 'fresh' | 'reconnect'): Promise<SessionResult> =>
    session.ensure(who, () => identity.idToken(who), mode === 'fresh' ? { fresh: true } : mode === 'reconnect' ? { reconnect: true } : undefined);
  /** Whether a create's news may be shown and acted on here: mounted, holding a token, and no session end since it. */
  const live = (): boolean => alive.current && gen.current.csrf !== null && !signedOut.current;
  const putList = (next: ListState): void => { listRef.current = next; setList(next); };
  /** Focus goes to the heading once the control it is on has gone — unless the user has put it elsewhere by then. */
  const toTitle = (): void => { focusTarget.current = 'title'; titleFrom.current = document.activeElement; };
  const putDetail = (next: DetailState): void => { detailRef.current = next; setDetail(next); };
  const putEdit = (next: EditForm | null): void => { editRef.current = next; setEdit(next); };
  /** Close the edit form: its draft and field errors go with it. */
  const closeEdit = (): void => { putEdit(null); setEditDraft(NO_FIELDS); setEditErrors(NO_FIELDS); };
  /**
   * Put an edit notice. The same notice again (same region, same words) is cleared first and set on the next task, so a
   * screen reader announces it again; a later notice always wins over a pending one.
   */
  const putEditStatus = (next: EditNotice | null): void => {
    const seq = ++announceSeq.current;
    const was = editStatusRef.current;
    editStatusRef.current = next;
    if (next !== null && was !== null && was.alert === next.alert && was.text === next.text) {
      setEditStatus(null);
      setTimeout(() => { if (seq === announceSeq.current && alive.current) setEditStatus(next); }, 0);
      return;
    }
    setEditStatus(next);
  };
  /** The edit controls belong to a new context now: an older request still out no longer holds them. */
  const freeEdit = (): void => { editEpoch.current += 1; editBusy.current = false; setEditing(false); };
  /** Start an edit request's busy span; the returned function ends it, unless its context has been replaced meanwhile. */
  const busyEdit = (): (() => void) => {
    const epoch = editEpoch.current;
    editBusy.current = true;
    setEditing(true);
    return () => { if (epoch === editEpoch.current) { editBusy.current = false; setEditing(false); } };
  };

  const clearWait = (): void => {
    if (waitTimer.current !== null) clearTimeout(waitTimer.current);
    waitTimer.current = null;
    waitRef.current = false;
    reloadAfterWait.current = null; // a new generation reads anyway
    setWait(null);
  };
  /**
   * A rate limit's delay: it only re-enables the controls when it has passed, and a running wait is never shortened.
   * Returns the whole seconds the wait that is actually running still has. When it ends, a page-one read it blocked
   * runs once (a read; never a create).
   */
  const startWait = (seconds: number): number => {
    const until = clock() + seconds * 1000;
    if (waitRef.current && until <= waitUntil.current) return Math.max(1, Math.ceil((waitUntil.current - clock()) / 1000));
    if (waitTimer.current !== null) clearTimeout(waitTimer.current);
    waitUntil.current = until;
    waitRef.current = true;
    setWait(seconds);
    waitTimer.current = setTimeout(() => {
      waitTimer.current = null;
      waitRef.current = false;
      setWait(null);
      const blocked = reloadAfterWait.current;
      reloadAfterWait.current = null;
      if (blocked !== null && alive.current) void loadList('first', blocked.note);
    }, seconds * 1000);
    return seconds;
  };
  /** A failure whose wait text states the wait that is actually running. */
  const withWait = (failure: Failure): Failure =>
    failure.seconds === undefined ? failure : { ...failure, text: waitText(startWait(failure.seconds)) };

  /** An attempt sent with another token than `csrf` is detached for good: it can no longer be checked from this page. */
  const detach = (who: string, csrf: string): void => {
    const held = holds.get(who);
    if (held !== undefined && held.csrf !== null && held.csrf !== csrf) holds.change(who, held.key, { csrf: null });
    // A held edit is never sent under another token: it is dropped, with its bytes, and the page says so.
    const heldEdit = editHolds.get(who);
    if (heldEdit !== undefined && heldEdit.csrf !== csrf) dropHeldEdit(who, heldEdit.key, 'connectionHeld');
  };
  /** Drop a held edit that can never be checked again, and say (a page-level notice, unnamed) that its outcome is not known. */
  function dropHeldEdit(who: string, key: string, event: 'connectionHeld' | 'endedHeld'): void {
    if (!editHolds.remove(who, key)) return;
    setEditNote(null);
    putEditStatus({ alert: true, text: EDIT_TEXT[event] });
  }
  /** A confirmed save's later news: its own text on that customer's page, by name anywhere else. */
  function savedNews(event: keyof typeof editEventText, held: Pick<HeldEdit, 'customerId' | 'name'>): void {
    putEditStatus({ alert: true, text: EDIT_TEXT[event], customerId: held.customerId, named: editEventText[event](held.name) });
  }

  /**
   * Take a confirmed session token. The first one fixes this generation; the same one changes nothing; a different one
   * starts a new generation (true): whatever the caller was about to do under the old one must not happen.
   */
  function adopt(who: string, csrf: string): boolean {
    const wasSignedOut = signedOut.current;
    signedOut.current = false; // a session confirmed now: an end seen before it no longer stands
    if (gen.current.csrf === csrf) {
      if (wasSignedOut) consumeOutcome(); // news that settled meanwhile (the same session, found valid again)
      return false;
    }
    if (gen.current.csrf === null) {
      gen.current.csrf = csrf;
      detach(who, csrf);
      consumeOutcome();
      consumeEditOutcome();
      return false;
    }
    begin(csrf, false);
    consumeOutcome();
    consumeEditOutcome();
    return true;
  }

  /** A refusal or an ended session shows nothing of the server's on either view: no rows, no cursor, no customer. */
  function clearBoth(failure: Failure): void {
    const ended = failure.kind === 'signed-out';
    // A view whose Reconnect is still out is left to it: whatever it answers, it shows (no rows are on it meanwhile).
    const spareList = ended && reconnecting.current.list !== 0 && reconnecting.current.list === listSeq.current;
    const spareDetail = ended && reconnecting.current.detail !== 0 && reconnecting.current.detail === detailSeq.current;
    // Reads already in flight must not repaint over the refusal.
    if (!spareList) {
      listSeq.current += 1;
      listCtl.current?.abort();
      setListBusy(false);
      putList({ phase: failure.kind as 'denied' | 'signed-out', text: failure.text, rows: [], next: null, note: '', query: '' });
      // An ended session takes the search text too; a refusal only the applied query (it went with the rows).
      if (ended) { setSearchDraft(''); setSearchRefused(false); }
    }
    if (!spareDetail) {
      detailSeq.current += 1;
      detailCtl.current?.abort();
      const id = routeRef.current;
      if (id === null) putDetail(DETAIL_NONE); // no customer is shown: nothing to stamp
      else if (isCustomerId(id)) putDetail({ id, phase: failure.kind as 'denied' | 'signed-out', text: failure.text, customer: null });
    }
    // The profile is gone, and with it the edit form and its draft (focus that was in it goes to the heading).
    if (editRef.current !== null && owningFocus()) toTitle();
    closeEdit();
    // Signed out: no notice of a save or of a settled create stays either (they name a customer of a session that is
    // gone). The hold note and every other create status stay: Add, Check again and a refused send write theirs.
    if (ended) {
      setSaved(null);
      setCreateStatus((status) => (status?.named === true ? null : status));
      // An unresolved create's token has ended too (DA-200): it is detached for good, its body goes and its name is no
      // longer shown; a late answer for it settles in the store only until the next generation (`signedOut`).
      signedOut.current = true;
      if (checkButton.current !== null && checkButton.current === document.activeElement) toTitle(); // it goes
      const heldCreate = uid === null ? undefined : holds.get(uid);
      if (uid !== null && heldCreate !== undefined && heldCreate.ended !== true) holds.change(uid, heldCreate.key, { csrf: null, body: '', ended: true });
      // A held edit, in any state, can never be checked again (its token has ended): dropped, and said so. An answer still
      // out for it then finds nothing to settle.
      const heldEdit = uid === null ? undefined : editHolds.get(uid);
      endedSeen.current += 1;
      freeEdit();
      setEditNote(null);
      putEditStatus(null);
      if (uid !== null && heldEdit !== undefined) dropHeldEdit(uid, heldEdit.key, 'endedHeld');
    }
  }
  const isRefusal = (failure: Failure): boolean => failure.kind === 'denied' || failure.kind === 'signed-out';

  /**
   * Show what a create that settled after its page had gone ended as — once this page holds a session token, and not
   * while a session end stands (`live`). One a session end touched is said without its name.
   */
  function consumeOutcome(): void {
    if (uid === null || !live()) return;
    const outcome = holds.takeOutcome(uid);
    if (outcome === undefined) return;
    if (outcome.ended === true) return endedNews(outcome.kind);
    if (outcome.kind === 'refused') return setCreateStatus({ refusal: true, text: `"${outcome.name}" was not added: the server refused that request.`, named: true });
    const sent = outcome.plain ? { name: outcome.customer.name, phone: null, email: null } : null;
    confirmed(outcome.customer, sent, outcome.csrf === gen.current.csrf, false); // the user may be typing: no focus move
  }

  /**
   * What a page says of a result for an attempt a session END detached (DA-200): only the unnamed notice — no read, no
   * wait, no draft or hold note touched, no focus moved. The session it was sent under is gone; nothing of its result
   * applies to the one shown now.
   */
  function endedNews(kind: HoldOutcome['kind']): void {
    if (kind === 'saved') return setSaved({ earlier: null });
    setCreateStatus({ refusal: true, text: ENDED_TEXT.refused });
  }

  /**
   * A validated 201 naming the name sent: the notice, the draft only when ALL its fields still are what was sent (a
   * same-named customer with other contacts being typed stays; `sent` null: unknown, so nothing is cleared), and page one again.
   */
  function confirmed(customer: CustomerEntry, sent: Sent | null, here: boolean, focus: boolean): void {
    setHoldNote(null);
    setDraft((d) => (sent !== null && normalizeCustomerName(d.name) === sent.name && normalizeCustomerPhone(d.phone) === sent.phone
      && normalizeCustomerEmail(d.email) === sent.email ? NO_FIELDS : d));
    setCreateStatus(null);
    if (here) {
      setErrors(NO_FIELDS);
      setSaved(customer);
      focusSaved.current = focus;
    } else {
      setSaved({ earlier: customer.name });
    }
    void loadList('first');
  }

  /**
   * After a read refused 403. The server gives the same answer to a read whose cookie is another session's than the
   * token it carried (DA-138), so ONE session check tells them apart: another token starts a new generation (which reads
   * again and shows nothing of this one; the caller is then stale), a failed check is returned as that failure, and the
   * same token leaves the refusal standing (null). The caller shows the read's own refusal unless the check itself was
   * refused (signed out): a check that cannot decide never turns a refused read into last-known rows.
   */
  async function recheck(who: string): Promise<Failure | null> {
    const since = sessionEndsSoFar();
    const s = await connect(who, 'fresh'); // a session read sent AFTER the 403, never one already in flight before it
    if (s.kind !== 'ok') return sessionFailure(s);
    if (alive.current && since === sessionEndsSoFar()) adopt(who, s.csrf); // never a token from before a sign-out
    return null;
  }

  /** Returns the failure as shown (its wait text states the wait that runs). */
  function failList(failure: Failure): Failure {
    const shown = withWait(failure);
    // A refusal or an ended session shows nothing of the server's: no rows, and no local fallback.
    if (isRefusal(shown)) clearBoth(shown);
    // Otherwise the rows this generation confirmed stay, under the last-known label — after a failed "Load more" too.
    else putList({ ...listRef.current, phase: shown.kind, text: shown.text, note: '' });
    return shown;
  }

  /**
   * Page one (`first`) or the page after the last shown (`more`). Rows are appended in arrival order, once per id.
   * `reconnect` only from the list's Reconnect button: the one read that may sign in again after the session ended.
   */
  async function loadList(mode: 'first' | 'more', note = '', reconnect = false): Promise<void> {
    if (uid === null) return;
    const cursor = mode === 'more' ? listRef.current.next : null;
    const query = listRef.current.query; // a read is always of the applied search, its cursor that search's own
    if (mode === 'more' && cursor === null) return;
    if (waitRef.current) { // no read starts during a rate limit's wait; a page-one read runs when it ends
      if (mode === 'first') reloadAfterWait.current = { note };
      return;
    }
    const mine = gen.current.n;
    const since = sessionEndsSoFar(); // an answer asked for before a sign-out began is stale too, mounted or not
    const seq = ++listSeq.current;
    listCtl.current?.abort(); // a superseded read is cancelled
    const controller = new AbortController();
    listCtl.current = controller;
    const stale = (): boolean => mine !== gen.current.n || seq !== listSeq.current || since !== sessionEndsSoFar();
    setListBusy(true);
    if (mode === 'first') putList({ ...listRef.current, phase: 'loading', text: TEXT.loading, note });
    try {
      if (reconnect) reconnecting.current.list = seq;
      const s = await connect(uid, reconnect ? 'reconnect' : undefined).finally(() => {
        if (reconnecting.current.list === seq) reconnecting.current.list = 0;
      });
      if (stale()) return;
      if (s.kind !== 'ok') { failList(sessionFailure(s)); return; }
      if (adopt(uid, s.csrf)) return; // a new generation has started its own reads
      const answer = await customers.list(cursor, s.csrf, controller.signal, query);
      if (stale()) return;
      if (answer.kind === 'ok') {
        const was = listRef.current;
        const shown = new Set(mode === 'more' ? was.rows.map((row) => row.id) : []);
        const fresh = answer.customers.filter((row) => !shown.has(row.id) && shown.add(row.id) !== undefined);
        return putList({
          phase: 'ready', text: '', rows: mode === 'more' ? [...was.rows, ...fresh] : fresh, next: answer.nextCursor,
          note: mode === 'more' ? '' : was.note, query,
        });
      }
      if (answer.kind === 'bad-cursor') {
        // The continuation no longer names a customer of this store: ONE reload from page one. That reload carries no
        // cursor, so it cannot come back here.
        if (mode === 'more') return void loadList('first', TEXT.reloaded);
        { failList({ kind: 'unavailable', text: TEXT.unreachable }); return; }
      }
      if (answer.kind === 'denied') {
        const again = await recheck(uid);
        if (stale()) return;
        if (again !== null && isRefusal(again)) { failList(again); return; }
        if (again !== null) withWait(again); // an undecided check: its wait still runs, and the refused read shows nothing
      }
      failList(readFailure(answer));
    } finally {
      if (!stale()) {
        setListBusy(false);
      }
    }
  }

  /**
   * Apply a search (M7A-CUSTOMERS-P8): `raw` normalized, '' for none. A text the server would refuse is said here and
   * nothing is sent. The pages and the cursor of the previous query go, and page one is read: a read like Refresh —
   * never while a wait runs, never once the session has ended (only Reconnect signs in again).
   */
  function applySearch(raw: string): void {
    if (uid === null || waitRef.current || listRef.current.phase === 'signed-out') return;
    const query = normalizeCustomerSearch(raw);
    if (query === null) {
      setSearchRefused(true);
      searchInput.current?.focus();
      return;
    }
    setSearchRefused(false);
    putList({ ...LIST_INITIAL, query });
    void loadList('first');
  }
  /** Clear: no draft, no search — the unfiltered page one. Focus stays in the search box. */
  function clearSearch(): void {
    if (uid === null || waitRef.current || listRef.current.phase === 'signed-out') return;
    setSearchDraft('');
    applySearch('');
    searchInput.current?.focus();
  }

  function failDetail(id: string, raw: Failure, shown: CustomerProfile | null): void {
    const failure = withWait(raw);
    if (isRefusal(failure)) return clearBoth(failure);
    // An answer already shown for this id in this generation may stay, as last known, when the server cannot be asked.
    putDetail({ id, phase: failure.kind, text: failure.text, customer: shown });
  }

  /** `reconnect` only from the detail's Reconnect button, as for the list. */
  async function loadDetail(id: string, reconnect = false): Promise<void> {
    const mine = gen.current.n;
    const since = sessionEndsSoFar();
    const seq = ++detailSeq.current;
    detailCtl.current?.abort();
    const controller = new AbortController();
    detailCtl.current = controller;
    const stale = (): boolean => mine !== gen.current.n || seq !== detailSeq.current || id !== routeRef.current || since !== sessionEndsSoFar();
    if (uid === null) return putDetail({ id, phase: 'signed-out', text: TEXT.noIdentity, customer: null });
    // One generic answer for a malformed, a missing and another store's id; a malformed one is never sent.
    if (!isCustomerId(id)) return putDetail({ id, phase: 'not-found', text: NOT_FOUND_TEXT, customer: null });
    const shown = detailRef.current.id === id ? detailRef.current.customer : null;
    if (waitRef.current) { // no read starts during a rate limit's wait: the detail waits with it
      const left = Math.max(1, Math.ceil((waitUntil.current - clock()) / 1000));
      return putDetail({ id, phase: 'rate-limited', text: waitText(left), customer: shown });
    }
    putDetail({ id, phase: 'loading', text: TEXT.detailLoading, customer: shown });
    if (reconnect) reconnecting.current.detail = seq;
    const s = await connect(uid, reconnect ? 'reconnect' : undefined).finally(() => {
      if (reconnecting.current.detail === seq) reconnecting.current.detail = 0;
    });
    if (stale()) return;
    if (s.kind !== 'ok') return failDetail(id, sessionFailure(s), shown);
    if (adopt(uid, s.csrf)) return;
    const answer = await customers.profile(id, s.csrf, controller.signal);
    if (stale()) return;
    if (answer.kind === 'ok') return putDetail({ id, phase: 'ready', text: '', customer: answer.customer, version: answer.version });
    if (answer.kind === 'not-found') return putDetail({ id, phase: 'not-found', text: NOT_FOUND_TEXT, customer: null });
    if (answer.kind === 'denied') {
      const again = await recheck(uid);
      if (stale()) return; // another session started its own generation, which reads this id again
      if (again !== null && isRefusal(again)) return failDetail(id, again, shown);
      if (again !== null) withWait(again); // an undecided check: its wait still runs, and the refused read shows nothing
    }
    failDetail(id, readFailure(answer), shown);
  }

  /**
   * Start a new generation: cancel this one's reads, forget every row, cursor, detail and notice, reset the read flags
   * and the rate-limit wait, detach an unresolved create, and read again. A create is never restarted.
   */
  function begin(csrf: string | null, user: boolean): void {
    gen.current = { n: gen.current.n + 1, csrf };
    signedOut.current = false;
    listCtl.current?.abort();
    detailCtl.current?.abort();
    setListBusy(false);
    clearWait();
    putDetail(DETAIL_NONE);
    setSaved(null);
    setCreateStatus(null);
    setHoldNote(null);
    closeEdit();
    freeEdit();
    putEditStatus(null);
    setEditNote(null);
    setConnectionChanged(!user);
    if (!user) { setSearchDraft(''); setSearchRefused(false); } // a tenant switch: the draft was typed for the other tenant
    if (uid === null) return putList({ ...LIST_INITIAL, phase: 'signed-out', text: TEXT.noIdentity });
    putList(LIST_INITIAL);
    if (csrf !== null) detach(uid, csrf);
    void loadList('first');
    if (!user && routeRef.current !== null) void loadDetail(routeRef.current);
  }

  // "This page is gone" flips during the commit that removes it, not in the passive cleanup that runs after it.
  useLayoutEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, [uid]);

  useEffect(() => {
    if (editHolds === editHoldStore) bindShopEditHolds();
    editHolds.keepOnly(uid); // a user change or a sign-out: the previous user's held edit goes
    begin(null, true);
    // A changed session is noticed without a click: reads only, one at a time, and never while a create is out. Its
    // check is plain: it signs in only when no session is confirmed yet for this user or the cookie names another
    // identity's session; an ended session stays ended (`ended`), and only a Reconnect click logs in again.
    const reconnect = (): void => {
      if (uid === null || document.visibilityState === 'hidden' || gen.current.csrf === null) return;
      if (addRef.current || checkRef.current || editBusy.current || waitRef.current) return;
      const held = holds.get(uid);
      if (held !== undefined && held.state !== 'unresolved') return;
      const heldEdit = editHolds.get(uid);
      if (heldEdit !== undefined && heldEdit.state !== 'unresolved') return;
      const mine = gen.current.n;
      const since = sessionEndsSoFar();
      const seen = endedSeen.current; // an end a read found meanwhile is not undone by this check's earlier answer
      void connect(uid).then((s) => {
        if (mine !== gen.current.n || since !== sessionEndsSoFar() || seen !== endedSeen.current) return;
        if (s.kind === 'ok') adopt(uid, s.csrf);
        // Definitely gone; the rest teaches nothing. Always cleared (a route change moves a read counter without a read):
        // clearBoth spares only a view whose Reconnect is still out.
        else if (s.kind === 'ended' || s.kind === 'refused' || s.kind === 'no-identity') clearBoth(sessionFailure(s));
      });
    };
    window.addEventListener('focus', reconnect);
    document.addEventListener('visibilitychange', reconnect);
    const unsubscribe = holds.subscribe(consumeOutcome); // an outcome that settles while this page is mounted
    const unsubscribeEdits = editHolds.subscribe(consumeEditOutcome); // the same for an edit an older page sent
    // DA-200 (M7B-INVOICES-P1-R2): a sign-out, heard where it starts (the session client's `onSessionEnd`) while this page
    // is mounted — on a direct switch to another user AccessContext.tsx keeps it mounted until that user's profile has
    // loaded. Everything in flight is stale from here (a new generation with no token; reads cancelled, a Reconnect's
    // too); the create form's name, phone and email, its notices and a rate limit's wait go; and the page shows the
    // ended session (clearBoth: no rows, no customer, no edit; the held create detached). The hold store has heard it
    // already (its own module-level listener). Nothing is read, sent or signed in because of it: only Reconnect.
    const unhear = onSessionEnd(() => {
      if (uid === null) return;
      gen.current = { n: gen.current.n + 1, csrf: null };
      reconnecting.current = { list: 0, detail: 0 };
      clearWait();
      setDraft(NO_FIELDS);
      setErrors(NO_FIELDS);
      setHoldNote(null);
      setSaved(null);
      setCreateStatus(null);
      setConnectionChanged(false);
      clearBoth({ kind: 'signed-out', text: TEXT.sessionEnded });
    });
    return () => {
      unhear();
      unsubscribe();
      unsubscribeEdits();
      window.removeEventListener('focus', reconnect);
      document.removeEventListener('visibilitychange', reconnect);
      gen.current = { n: gen.current.n + 1, csrf: null };
      editEpoch.current += 1; // an edit request still out no longer touches this page's state when it ends
      reloadAfterWait.current = null;
      listCtl.current?.abort();
      detailCtl.current?.abort();
      if (waitTimer.current !== null) clearTimeout(waitTimer.current);
      // A create already sent is NOT cancelled: its answer still settles the attempt in the hold store.
    };
    // A page serves one UID (see ServerCustomerDirectory); the clients are fixed for the page's life.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uid]);

  // The route decides what the detail shows: another id is another read, and leaving the detail cancels its read. The
  // answer last shown stays in memory (never on the list) so a return to the SAME id in this generation can fall back
  // to it as last known; another id or a new generation forgets it.
  // The route is taken in the layout phase, together with the edit clear: an answer that settles after this commit sees
  // the new route (and names its notice accordingly), and no later clear erases it. An edit belongs to the customer it
  // was opened on: another route closes it (an attempt already out still settles).
  const clearedRoute = useRef<string | null | undefined>(undefined);
  useLayoutEffect(() => {
    const from = clearedRoute.current;
    clearedRoute.current = routeId;
    routeRef.current = routeId;
    if (from !== undefined && from !== routeId) {
      closeEdit();
      putEditStatus(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routeId]);

  useEffect(() => {
    const from = lastRoute.current;
    lastRoute.current = routeId;
    if (routeId === null) {
      detailSeq.current += 1;
      detailCtl.current?.abort();
      if (from !== undefined && from !== null) listTitle.current?.focus();
      return;
    }
    void loadDetail(routeId);
    detailTitle.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routeId, uid]);

  useEffect(() => {
    const target = focusTarget.current;
    if (target !== null) {
      const element = target === 'name' ? editName.current : target === 'review' ? reviewButton.current
        : target === 'edit' ? editButton.current ?? editPolite.current : target === 'alert' ? editAlertRef.current
          : target === 'hold' ? editCard.current : target === 'title' ? detailTitle.current ?? listTitle.current : editPolite.current;
      // The heading only takes focus that fell to the page (the control it was on has gone) or still sits on that
      // control (disabled): focus the user has moved elsewhere since stays there.
      const active = document.activeElement;
      if (target === 'title' && active !== null && active !== document.body && active !== titleFrom.current) focusTarget.current = null;
      else if (element !== null) {
        focusTarget.current = null;
        element.focus();
      }
    }
    if (!focusSaved.current) return;
    focusSaved.current = false;
    savedNotice.current?.focus();
  });

  /** What a create answer does to the list: an ended session shows nothing; otherwise the server is asked again. */
  function listAfter(kind: CreateResult['kind'], here: boolean): void {
    if (kind === 'signed-out' && here) return void failList({ kind: 'signed-out', text: TEXT.sessionEnded });
    if (kind === 'signed-out' || kind === 'denied') void loadList('first'); // re-proves view access under the current session
  }

  /**
   * One create answer, reconciled by KEY: a continuation whose key is no longer the store's is a no-op, and an answer
   * that arrives after this page has gone — or while a session end stands (`live`: DA-200) — updates the store only: no
   * notice, no read, no send, no token or body restored; the next generation's page shows it. `first` is the attempt's
   * first send. An attempt a session END detached (`ended`) is bookkeeping only, whenever its answer comes: it settles
   * by key, and a page that may show news shows nothing but its unnamed ENDED_TEXT notice — no read, no wait, no hold
   * note, nothing of the session shown now (`endedNews`).
   */
  function settle(who: string, key: string, answer: CreateResult, first: boolean): void {
    const held = holds.get(who);
    if (held === undefined || held.key !== key) return;
    const shown = live();
    // This page still holds the connection the attempt was sent under.
    const here = shown && held.csrf !== null && held.csrf === gen.current.csrf;
    const kind = answer.kind;
    const created = kind === 'created' && answer.customer.name === held.name;
    const conclusive = first && (kind === 'signed-out' || kind === 'denied' || kind === 'invalid' || kind === 'absent' || kind === 'key-reused' || kind === 'rate-limited');
    if (held.ended === true) {
      if (!created && !conclusive) return void holds.change(who, key, { state: 'unresolved' });
      const outcome: HoldOutcome = created && answer.kind === 'created'
        ? { kind: 'saved', customer: answer.customer, csrf: null, plain: false, ended: true }
        : { kind: 'refused', name: held.name, ended: true };
      if (!shown) return void holds.finish(who, key, outcome);
      holds.remove(who, key);
      return endedNews(outcome.kind);
    }
    if (created && answer.kind === 'created') {
      // CONFIRMED: a validated 201 naming the name that was sent
      if (!shown) {
        return void holds.finish(who, key, { kind: 'saved', customer: answer.customer, csrf: held.csrf, plain: held.body === JSON.stringify({ name: held.name }) });
      }
      holds.remove(who, key);
      return confirmed(answer.customer, sentOf(held), here, true);
    }
    if (conclusive) {
      // conclusive for this request: nothing was reserved or executed; the draft stays
      if (!shown) return void holds.finish(who, key, { kind: 'refused', name: held.name });
      holds.remove(who, key);
      if (answer.kind === 'rate-limited') {
        const left = startWait(answer.retryAfterSeconds);
        return setCreateStatus({ refusal: true, text: `Not sent through: too many requests. ${waitHint(left)} Then add again.` });
      }
      setCreateStatus({ refusal: true, text: REFUSED_TEXT[kind as keyof typeof REFUSED_TEXT] });
      return listAfter(kind, here);
    }
    // Undecided, or any answer to a check that is not the confirming 201: the key may have committed.
    holds.change(who, key, { state: 'unresolved' });
    if (!shown) return;
    setHoldNote({ key, text: reasonOf(answer, answer.kind === 'rate-limited' ? startWait(answer.retryAfterSeconds) : undefined) });
    if (!first) listAfter(kind, here);
  }

  async function add(): Promise<void> {
    if (uid === null || addRef.current) return;
    const token = gen.current.csrf;
    if (!canCreate || token === null || listRef.current.phase !== 'ready' || waitRef.current || holds.get(uid) !== undefined) return;
    const name = normalizeCustomerName(draft.name);
    const phone = normalizeCustomerPhone(draft.phone);
    const email = normalizeCustomerEmail(draft.email);
    // Refused here: no request and no key (the server would bind the key before refusing a field). Every refused field
    // says so; the first takes focus.
    if (name === null || phone === CONTACT_INVALID || email === CONTACT_INVALID) {
      setErrors({ name: name === null ? NAME_RULE_TEXT : '', phone: phone === CONTACT_INVALID ? PHONE_RULE_TEXT : '', email: email === CONTACT_INVALID ? EMAIL_RULE_TEXT : '' });
      (name === null ? nameInput : phone === CONTACT_INVALID ? phoneInput : emailInput).current?.focus();
      return;
    }
    const mine = gen.current.n;
    const since = sessionEndsSoFar();
    addRef.current = true;
    setAdding(true);
    setErrors(NO_FIELDS);
    setCreateStatus(null);
    setSaved(null);
    setConnectionChanged(false);
    try {
      const s = await connect(uid);
      // The page or its connection was replaced, or a sign-out began after this check asked: nothing is sent.
      if (!alive.current || mine !== gen.current.n || since !== sessionEndsSoFar()) return;
      if (s.kind !== 'ok') {
        return setCreateStatus({ refusal: true, text: `Not sent. ${failList(sessionFailure(s)).text}` });
      }
      // Another token than this generation's: a new generation, and NOTHING is sent under it.
      if (s.csrf !== token) return void adopt(uid, s.csrf);
      const key = nextKey();
      // A blank contact is left out, so a name-only body keeps its bytes; the keys are name, phone, email in that order.
      const body = JSON.stringify({ name, ...(phone !== null ? { phone } : {}), ...(email !== null ? { email } : {}) });
      // Held BEFORE the request leaves: whatever happens to this page, the key and the bytes are not lost.
      if (!holds.put(uid, { key, body, name, csrf: token, sentAt: clock(), state: 'sending' })) return;
      settle(uid, key, await customers.create(body, key, token), true);
    } finally {
      addRef.current = false;
      setAdding(false);
    }
  }

  async function checkAgain(): Promise<void> {
    if (uid === null || checkRef.current) return;
    const held = holds.get(uid);
    if (held === undefined || held.state !== 'unresolved' || held.csrf === null || waitRef.current) return;
    if (clock() - held.sentAt >= CHECK_CUTOFF_MS) return setTick((n) => n + 1); // too old: the card now says so
    // Only the key is kept across the session check: the token and the bytes are read from the store again after it.
    const { key } = held;
    const since = sessionEndsSoFar();
    checkRef.current = true;
    holds.change(uid, key, { state: 'checking' });
    setHoldNote(null);
    try {
      const s = await connect(uid);
      const now = holds.get(uid);
      if (now === undefined || now.key !== key) return;
      // A sign-out began after this check asked (its token and body are gone from the store): nothing is sent or taken.
      if (since !== sessionEndsSoFar()) return void holds.change(uid, key, { state: 'unresolved' });
      if (s.kind !== 'ok') {
        holds.change(uid, key, { state: 'unresolved' });
        if (!alive.current) return;
        return setHoldNote({ key, text: `Not checked. ${failList(sessionFailure(s)).text}` });
      }
      // Detached or ended meanwhile (a read noticed another connection or an end while this one was confirming).
      if (now.csrf === null || now.ended === true) return void holds.change(uid, key, { state: 'unresolved' });
      if (s.csrf !== now.csrf) {
        // Another connection answers now: the attempt is detached for good and NOTHING is sent.
        holds.change(uid, key, { state: 'unresolved', csrf: null });
        if (alive.current) adopt(uid, s.csrf);
        return;
      }
      if (alive.current) adopt(uid, s.csrf); // a page that had no token yet takes this one: the attempt's own
      // The attempt as the store holds it NOW, still under the token the check confirmed and still inside the window;
      // its bytes are copied straight into the one request: the SAME key, the SAME body, its own token.
      const sending = holds.get(uid);
      if (sending === undefined || sending.key !== key || sending.ended === true || sending.csrf !== s.csrf || sending.body === ''
        || clock() - sending.sentAt >= CHECK_CUTOFF_MS) return void holds.change(uid, key, { state: 'unresolved' });
      settle(uid, key, await customers.create(sending.body, key, sending.csrf), false);
    } finally {
      checkRef.current = false;
    }
  }

  function stopTracking(): void {
    if (uid === null) return;
    const held = holds.get(uid);
    if (held === undefined || held.state !== 'unresolved') return;
    holds.remove(uid, held.key);
    setHoldNote(null);
    void loadList('first');
  }

  /** Whether focus is in the edit form or the held-edit card, or nowhere: only then may an edit outcome move it. */
  function owningFocus(): boolean {
    const active = document.activeElement;
    return active === null || active === document.body || (editForm.current?.contains(active) ?? false) || (editCard.current?.contains(active) ?? false);
  }
  /** A notice about `held`'s customer: its own text on that customer's page, the named text anywhere else. */
  function noticeFor(kind: EditOutcomeKind, held: Pick<HeldEdit, 'customerId' | 'name'>, text: string): void {
    putEditStatus({ alert: kind !== 'saved', text, customerId: held.customerId, named: editNamedText(kind, held.name) });
  }
  /**
   * What a page shows of an edit that settled while its own page was gone — once this page holds a session token, and
   * only under the token it was sent with (another session, so possibly another tenant: dropped, with no text).
   */
  function consumeEditOutcome(): void {
    if (uid === null || !alive.current || gen.current.csrf === null) return;
    const outcome = editHolds.takeOutcome(uid);
    if (outcome === undefined || outcome.csrf !== gen.current.csrf) return;
    const id = outcome.customerId;
    const own: Partial<Record<EditOutcomeKind, string>> = {
      saved: EDIT_SAVED_TEXT, conflict: EDIT_TEXT.conflictClosed, gone: EDIT_TEXT.notFound, denied: EDIT_DENIED_TEXT, deniedHeld: EDIT_TEXT.deniedHeld,
      undecided: EDIT_UNKNOWN_TEXT,
    };
    noticeFor(outcome.kind, outcome, own[outcome.kind] ?? editNamedText(outcome.kind, outcome.name));
    if (outcome.kind === 'saved') {
      void reloadAfterSave(id, outcome.name); // the list is the server's answer (to its search, if any): asked again from page one
    }
    if (outcome.kind === 'saved' || outcome.kind === 'conflict' || outcome.kind === 'gone') {
      // What this page shows of that customer may be from before: read again (or forgotten).
      if (routeRef.current === id) void (outcome.kind === 'saved' ? refreshAfterSave(id, outcome.name) : loadDetail(id));
      else if (detailRef.current.id === id) putDetail(DETAIL_NONE);
    }
  }
  /** The send itself: a client that throws is an attempt with no answer. */
  const sendEdit = (id: string, body: string, key: string, csrf: string): Promise<UpdateResult> =>
    customers.update(id, body, key, csrf).catch((): UpdateResult => Object.freeze({ kind: 'unknown', responded: false }));

  /** Open the form on the profile this generation confirmed, at its version. */
  function openEdit(): void {
    const d = detailRef.current;
    if (!canEdit || uid === null || d.id === null || d.id !== routeRef.current || d.phase !== 'ready' || d.customer === null || d.version === undefined) return;
    if (editHolds.get(uid) !== undefined) return;
    putEdit({ id: d.id, base: d.customer, version: d.version, conflict: false });
    setEditDraft({ name: d.customer.name, phone: d.customer.phone ?? '', email: d.customer.email ?? '' });
    setEditErrors(NO_FIELDS);
    putEditStatus(null);
    setEditNote(null);
    focusTarget.current = 'name';
  }

  /** Cancel: the form and its draft go; nothing is sent. An attempt already out still settles on its own answer. */
  function cancelEdit(): void {
    const form = editRef.current;
    cancelledForm.current = form;
    closeEdit();
    // A conflicted form shows a version somebody else has moved on from: read the profile again, so Edit starts current.
    if (form !== null && form.conflict && routeRef.current === form.id) void loadDetail(form.id);
    putEditStatus(null);
    focusTarget.current = 'edit';
  }

  async function saveEdit(): Promise<void> {
    const form = editRef.current;
    if (uid === null || editBusy.current || form === null || form.conflict) return;
    const token = gen.current.csrf;
    if (token === null || waitRef.current || editHolds.get(uid) !== undefined) return;
    const built = customerEditBody(form.base, form.version, editDraft);
    // Refused here: no request and no key. Every refused field says so; the first takes focus.
    if (built.kind === 'invalid') {
      setEditErrors({ name: built.name ? NAME_RULE_TEXT : '', phone: built.phone ? PHONE_RULE_TEXT : '', email: built.email ? EMAIL_RULE_TEXT : '' });
      (built.name ? editName : built.phone ? editPhone : editEmail).current?.focus();
      return;
    }
    setEditErrors(NO_FIELDS);
    if (built.kind === 'unchanged') return putEditStatus({ alert: false, text: EDIT_NO_CHANGES_TEXT });
    const mine = gen.current.n;
    const epoch = editEpoch.current;
    const done = busyEdit();
    putEditStatus(null);
    try {
      // Plain: it signs in only when no session is confirmed yet for this user or the cookie names another identity's
      // session; after a confirmed session end it is `ended`, and only the explicit Reconnect signs in.
      const s = await connect(uid);
      // The page, its connection or its session was replaced: nothing is sent.
      if (!alive.current || mine !== gen.current.n || epoch !== editEpoch.current) return;
      const open = editRef.current === form; // false: cancelled (or reopened) meanwhile — nothing is sent either way
      if (s.kind !== 'ok') {
        const failure = withWait(sessionFailure(s));
        if (isRefusal(failure)) clearBoth(failure);
        if (open) putEditStatus({ alert: true, text: `Not sent. ${failure.text}` });
        return;
      }
      if (s.csrf !== token) return void adopt(uid, s.csrf); // another token: a new generation, and NOTHING is sent
      if (!open) return;
      const key = nextKey();
      // Held BEFORE the request leaves: whatever happens to this page, the key, the target and the bytes are not lost.
      const held: HeldEdit = { key, customerId: form.id, body: built.body, expectedVersion: form.version, name: built.name, csrf: token, sentAt: clock(), state: 'sending' };
      if (!editHolds.put(uid, held)) return;
      putEditStatus({ alert: false, text: EDIT_TEXT.saving, customerId: form.id, named: `Saving your changes to "${built.name}"…` });
      const answer = await sendEdit(form.id, built.body, key, token);
      if (answer.kind === 'denied' && editHolds.get(uid)?.key === key) {
        // A 403 decides this request (nothing was done), but it may be another session's cookie (DA-138): ONE session
        // check tells a changed connection from a permission loss, as a read's 403 does. It answers only for this user,
        // this generation and this form: anything that replaced one of them meanwhile makes it do nothing here.
        const focus = alive.current && owningFocus();
        const s2 = await connect(uid, 'fresh');
        if (editHolds.get(uid)?.key !== key) return; // dropped meanwhile (a new connection, an ended session)
        if (!alive.current) { // the page went first: the next page of this user and token is told
          editHolds.finish(uid, key, { kind: 'refused', customerId: held.customerId, name: held.name, csrf: held.csrf });
          return;
        }
        editHolds.remove(uid, key);
        // Another generation or session owns the page now, or the user cancelled this form: nothing is said here. A
        // form closed by navigation is not a cancel — the refusal is still said (by name on another page).
        if (mine !== gen.current.n || epoch !== editEpoch.current) return;
        if (editRef.current !== form && cancelledForm.current === form) return;
        if (s2.kind !== 'ok') {
          const failure = withWait(sessionFailure(s2));
          if (!isRefusal(failure)) return editRefused(held, answer, true, focus); // undecided check: the refusal stands
          clearBoth(failure);
          return putEditStatus({ alert: true, text: EDIT_TEXT.ended });
        }
        if (s2.csrf !== token) {
          adopt(uid, s2.csrf);
          return putEditStatus({ alert: true, text: EDIT_TEXT.connectionRefused });
        }
        return editRefused(held, answer, true, focus);
      }
      settleEdit(uid, key, answer, true);
    } finally {
      done();
    }
  }

  /** The outcome kind of a conclusive answer, for a page that is not there to show it. */
  const outcomeOf = (kind: UpdateResult['kind'], first: boolean): EditOutcomeKind =>
    kind === 'conflict' ? 'conflict' : kind === 'not-found' ? 'gone' : kind === 'denied' ? (first ? 'denied' : 'deniedHeld') : 'refused';

  /**
   * One edit answer, reconciled by KEY: an answer for an attempt that is no longer held (dropped by a new token, an
   * ended session or Discard) changes nothing. One that arrives after the page has gone is recorded for the next page of
   * this user. `first` is the attempt's first send.
   */
  function settleEdit(who: string, key: string, answer: UpdateResult, first: boolean): void {
    const held = editHolds.get(who);
    if (held === undefined || held.key !== key) return;
    const focus = alive.current && owningFocus();
    if (answer.kind === 'saved' && answer.customer.name === held.name && answer.version === held.expectedVersion + (answer.changed ? 1 : 0)) {
      // CONFIRMED: this customer, the name sent, at the version the body expected
      if (!alive.current) return void editHolds.finish(who, key, { kind: 'saved', customerId: held.customerId, name: held.name, csrf: held.csrf });
      editHolds.remove(who, key);
      return editSaved(held, focus);
    }
    const kind = answer.kind;
    // Conclusive for this key: a conflict or a refusal of the edit itself, on any send; the rest only on the first.
    if (kind === 'conflict' || kind === 'not-found' || kind === 'denied'
      || (first && (kind === 'signed-out' || kind === 'invalid' || kind === 'key-reused' || kind === 'rate-limited'))) {
      if (!alive.current) return void editHolds.finish(who, key, { kind: outcomeOf(kind, first), customerId: held.customerId, name: held.name, csrf: held.csrf });
      editHolds.remove(who, key);
      return editRefused(held, answer, first, focus);
    }
    if (kind === 'signed-out') { // a check whose session has ended: it can never be checked again
      if (!alive.current) return void editHolds.finish(who, key, { kind: 'unconfirmed', customerId: held.customerId, name: held.name, csrf: held.csrf });
      editHolds.remove(who, key);
      clearBoth({ kind: 'signed-out', text: TEXT.sessionEnded });
      putEditStatus({ alert: true, text: EDIT_TEXT.endedHeld });
      if (focus) focusTarget.current = 'alert';
      return;
    }
    // Undecided, or any answer to a check that does not confirm: the key may have committed.
    editHolds.change(who, key, { state: 'unresolved' });
    if (!alive.current) {
      // The page that sent it has gone: a page open now (or the next one, under the same token) says so.
      editHolds.announce(who, key, { kind: 'undecided', customerId: held.customerId, name: held.name, csrf: held.csrf });
      return;
    }
    holdNoteOf(key, first ? '' : editReasonOf(answer, answer.kind === 'rate-limited' ? startWait(answer.retryAfterSeconds) : undefined));
    if (focus) focusTarget.current = 'hold';
  }

  /** An undecided edit, announced through the fixed alert region; the reason is shown on the card too. */
  function holdNoteOf(key: string, reason: string): void {
    setEditNote({ key, text: reason });
    const held = uid === null ? undefined : editHolds.get(uid);
    const text = reason === '' ? EDIT_UNKNOWN_TEXT : `${EDIT_UNKNOWN_TEXT} ${reason}`;
    if (held === undefined || held.key !== key) return putEditStatus({ alert: true, text });
    putEditStatus({ alert: true, text, customerId: held.customerId, named: `${editNamedText('unconfirmed', held.name)}${reason === '' ? '' : ` ${reason}`}` });
  }

  /** A confirmed edit: the notice, the form closed, the list read again from page one, and the profile read again (or forgotten). */
  function editSaved(held: HeldEdit, focus: boolean): void {
    const id = held.customerId;
    const mine = editRef.current?.id === id;
    if (mine) closeEdit();
    setEditNote(null);
    noticeFor('saved', held, EDIT_SAVED_TEXT);
    if (mine || focus) focusTarget.current = 'status';
    // The list is the server's answer (to its search, if any): it is asked again from page one.
    void reloadAfterSave(id, held.name);
    if (routeRef.current === id) void refreshAfterSave(id, held.name);
    // Not shown now: the profile kept from before the edit is forgotten, so it is never shown as last known.
    else if (detailRef.current.id === id) putDetail(DETAIL_NONE);
  }

  /**
   * A confirmed save's list read, from page one. The customer's row, when shown, takes the confirmed name first: a
   * reload that fails keeps the rows as last known, and the name from before the edit is not one of them. Away from
   * that customer's route (no profile refresh is there to say it), a new connection or an ended session this reload
   * meets clears the notices, so the save is said again with it, as refreshAfterSave says it.
   */
  async function reloadAfterSave(id: string, name: string): Promise<void> {
    const was = listRef.current;
    if (was.rows.some((row) => row.id === id)) putList({ ...was, rows: was.rows.map((row) => (row.id === id ? Object.freeze({ id, name }) : row)) });
    const told = routeRef.current === id; // there, refreshAfterSave says what its own read meets
    const mine = gen.current.n;
    const ends = endedSeen.current;
    await loadList('first');
    if (!alive.current || told) return;
    if (mine !== gen.current.n) {
      if (statusHasFocus()) focusTarget.current = 'alert';
      return putEditStatus({ alert: true, text: EDIT_TEXT.savedThenChanged }); // unnamed: the connection changed
    }
    if (ends !== endedSeen.current) {
      if (statusHasFocus()) focusTarget.current = 'alert';
      savedNews('savedThenEnded', { customerId: id, name });
    }
  }

  async function refreshAfterSave(id: string, name: string): Promise<void> {
    const mine = gen.current.n;
    const ends = endedSeen.current;
    // The values shown before the edit are not current any more: never shown again, not even as last known.
    const d = detailRef.current;
    if (d.id === id) putDetail({ id, phase: d.phase, text: d.text, customer: null });
    await loadDetail(id);
    if (!alive.current) return;
    if (mine !== gen.current.n) { // a new connection cleared the notices: the save is still true
      if (statusHasFocus()) focusTarget.current = 'alert';
      return putEditStatus({ alert: true, text: EDIT_TEXT.savedThenChanged }); // unnamed: the connection changed
    }
    // The ended session's policy clears notices: the save is still true, and said with the end (by name elsewhere).
    if (ends !== endedSeen.current) {
      if (statusHasFocus()) focusTarget.current = 'alert';
      return savedNews('savedThenEnded', { customerId: id, name });
    }
    if (routeRef.current !== id) return;
    const after = detailRef.current;
    if (after.id !== id || after.phase === 'ready' || after.phase === 'loading') return;
    const status = editStatusRef.current;
    if (status?.text === EDIT_SAVED_TEXT) putEditStatus({ ...status, text: EDIT_SAVED_UNREFRESHED_TEXT });
  }
  /** Whether focus sits on the edit status (or nowhere): a notice that replaces it in the alert region takes it along. */
  function statusHasFocus(): boolean {
    const active = document.activeElement;
    return active === null || active === document.body || active === editPolite.current;
  }

  /** A conclusive answer: the edit did not apply. What it says, and what stays of the form. */
  function editRefused(held: HeldEdit, answer: UpdateResult, first: boolean, focus: boolean): void {
    setEditNote(null);
    const mine = editRef.current?.id === held.customerId;
    switch (answer.kind) {
      case 'conflict':
        // The draft stays, for this customer only; nothing is sent until the user reviews and saves again.
        if (mine && editRef.current !== null) {
          putEdit({ ...editRef.current, conflict: true });
          focusTarget.current = 'review';
          return noticeFor('conflict', held, EDIT_CONFLICT_TEXT);
        }
        // The form is gone (cancelled): the profile is read again (or forgotten), so a new Edit starts from the current version.
        if (focus) focusTarget.current = 'alert';
        if (routeRef.current === held.customerId) void loadDetail(held.customerId);
        else if (detailRef.current.id === held.customerId) putDetail(DETAIL_NONE);
        return noticeFor('conflict', held, EDIT_TEXT.conflictClosed);
      case 'not-found':
        if (mine) closeEdit();
        if (mine || focus) focusTarget.current = 'alert';
        noticeFor('gone', held, EDIT_TEXT.notFound);
        if (routeRef.current === held.customerId) void loadDetail(held.customerId);
        return;
      case 'denied':
        if (mine) closeEdit();
        if (mine || focus) focusTarget.current = 'alert';
        return first ? noticeFor('denied', held, EDIT_DENIED_TEXT) : noticeFor('deniedHeld', held, EDIT_TEXT.deniedHeld);
      case 'signed-out':
        if (mine || focus) focusTarget.current = 'alert';
        clearBoth({ kind: 'signed-out', text: TEXT.sessionEnded });
        return putEditStatus({ alert: true, text: EDIT_TEXT.ended });
      default:
        // The form stays (its Save was disabled while out): focus goes to what is said.
        if (mine || focus) focusTarget.current = 'alert';
        if (answer.kind === 'rate-limited') {
          return noticeFor('refused', held, `Not sent through: too many requests. ${waitHint(startWait(answer.retryAfterSeconds))} Then save again.`);
        }
        return noticeFor('refused', held, answer.kind === 'key-reused' ? EDIT_TEXT.keyReused : EDIT_TEXT.invalid);
    }
  }

  /** "Check again": the SAME bytes, the SAME key, the SAME customer, under the token it was first sent with. */
  async function checkEdit(): Promise<void> {
    if (uid === null || editBusy.current) return;
    const held = editHolds.get(uid);
    if (held === undefined || held.state !== 'unresolved' || held.body === '' || waitRef.current) return;
    if (clock() - held.sentAt >= CHECK_CUTOFF_MS) return setTick((n) => n + 1); // too old: the card now says so
    const { key, body, csrf, customerId, sentAt } = held;
    const done = busyEdit();
    if (owningFocus()) focusTarget.current = 'hold'; // the button goes while it checks: the card keeps focus
    editHolds.change(uid, key, { state: 'checking' });
    setEditNote(null);
    putEditStatus({ alert: false, text: EDIT_TEXT.checking, customerId, named: `Checking your changes to "${held.name}" with the server…` });
    try {
      // Plain, as a Save's: it signs in only when no session is confirmed yet for this user or the cookie names another
      // identity's session; after a confirmed session end only the explicit Reconnect signs in.
      const s = await connect(uid);
      if (editHolds.get(uid)?.key !== key) return;
      if (s.kind !== 'ok') {
        editHolds.change(uid, key, { state: 'unresolved' });
        if (!alive.current) return; // the page is gone: no wait is started for it
        const failure = withWait(sessionFailure(s));
        if (isRefusal(failure)) return clearBoth(failure); // ended: the held edit is dropped there, and said so
        return holdNoteOf(key, `Not checked. ${failure.text}`);
      }
      if (s.csrf !== csrf) {
        // Another connection answers now: dropped, NOTHING is sent, and the page says so. A new generation drops it
        // itself (after clearing the notices); a page already on that token drops it here.
        if (alive.current) adopt(uid, s.csrf);
        else {
          // The page went first: the outcome is recorded under the token the edit was sent with. Under the token rule it
          // is shown only by a page that holds that token again; a page on the new token drops it with no text.
          const now = editHolds.get(uid);
          if (now?.key === key) editHolds.finish(uid, key, { kind: 'unconfirmed', customerId, name: now.name, csrf });
          return;
        }
        dropHeldEdit(uid, key, 'connectionHeld');
        return;
      }
      if (alive.current) adopt(uid, s.csrf);
      if (editHolds.get(uid)?.key !== key) return; // dropped meanwhile
      if (clock() - sentAt >= CHECK_CUTOFF_MS) { // the window closed during the session step: nothing is sent
        editHolds.change(uid, key, { state: 'unresolved', body: '' });
        if (alive.current) holdNoteOf(key, EDIT_TEXT.tooOld);
        return;
      }
      settleEdit(uid, key, await sendEdit(customerId, body, key, csrf), false);
    } finally {
      const now = editHolds.get(uid);
      if (now?.key === key && now.state === 'checking') editHolds.change(uid, key, { state: 'unresolved' }); // never stuck
      done();
    }
  }

  /** "Discard": forget the held edit and the draft. The request is not cancelled (the card says so). */
  function discardEdit(): void {
    if (uid === null) return;
    const held = editHolds.get(uid);
    if (held === undefined || held.state !== 'unresolved') return;
    editHolds.remove(uid, held.key);
    setEditNote(null);
    putEditStatus(null);
    closeEdit();
    focusTarget.current = 'edit';
  }

  /**
   * "Review latest" after a conflict: the profile read again (nothing sent). A field whose value differs from the
   * profile the form was loaded from stays as typed; every other field takes the reviewed value, so a save never
   * reverts another editor's change to a field this user did not change (a field typed and restored is unchanged).
   */
  async function reviewEdit(): Promise<void> {
    const form = editRef.current;
    if (uid === null || editBusy.current || form === null) return;
    const { id, base: before } = form;
    const mine = gen.current.n;
    const done = busyEdit();
    putEditStatus(null);
    try {
      await loadDetail(id);
    } finally {
      done();
    }
    if (!alive.current || mine !== gen.current.n || routeRef.current !== id || editRef.current?.id !== id) return;
    const d = detailRef.current;
    if (d.id === id && d.phase === 'not-found') { // gone: the form and its draft go with it
      closeEdit();
      focusTarget.current = 'alert';
      return noticeFor('gone', { customerId: id, name: before.name }, EDIT_TEXT.notFound);
    }
    if (d.id === id && d.phase === 'ready' && d.customer !== null && d.version !== undefined) {
      const latest = d.customer;
      setEditDraft((draft) => ({
        name: normalizeCustomerName(draft.name) !== before.name ? draft.name : latest.name,
        phone: normalizeCustomerPhone(draft.phone) !== before.phone ? draft.phone : latest.phone ?? '',
        email: normalizeCustomerEmail(draft.email) !== before.email ? draft.email : latest.email ?? '',
      }));
      putEdit({ id, base: latest, version: d.version, conflict: false });
      focusTarget.current = 'status'; // the Review button goes
      return putEditStatus({ alert: false, text: EDIT_REVIEWED_TEXT });
    }
    focusTarget.current = 'alert';
    putEditStatus({ alert: true, text: EDIT_TEXT.reviewFailed });
  }

  const waiting = wait !== null;
  const detached = attempt !== undefined && attempt.detached;
  const tooOld = attempt !== undefined && clock() - attempt.sentAt >= CHECK_CUTOFF_MS;
  // Past the cutoff the attempt can never be sent again: a body that carries a contact is not kept for it either.
  useEffect(() => {
    const held = uid === null || !tooOld ? undefined : holds.get(uid);
    if (uid !== null && held !== undefined && held.body !== unusableBody(held)) holds.change(uid, held.key, { body: unusableBody(held) });
  });
  const editTooOld = editHeld !== undefined && clock() - editHeld.sentAt >= CHECK_CUTOFF_MS;
  // Past the cutoff a held edit can never be sent again: its bytes are not kept for it either.
  useEffect(() => {
    const held = uid === null || !editTooOld ? undefined : editHolds.get(uid);
    if (uid !== null && held !== undefined && held.body !== '' && held.state === 'unresolved') editHolds.change(uid, held.key, { body: '' });
  });
  const canAdd = canCreate && list.phase === 'ready' && attempt === undefined && !waiting && !adding;
  const addHint = adding ? 'Sending…'
    : attempt !== undefined ? 'An earlier customer is not confirmed yet. Check it again or stop tracking it first.'
      : waiting ? waitHint(wait)
        : list.phase !== 'ready' ? 'Available once the list has loaded from the server.' : '';
  const busyHint = listBusy ? 'Loading…' : waiting ? waitHint(wait) : '';
  const lastKnown = (list.phase === 'unavailable' || list.phase === 'rate-limited') && list.rows.length > 0;
  const canSearch = uid !== null && !waiting && list.phase !== 'signed-out';
  const searchHint = waiting ? waitHint(wait) : list.phase === 'signed-out' && uid !== null ? 'Reconnect to search.' : '';
  // Until the route's own read has started, nothing of another id is shown.
  const shownDetail: DetailState = routeId === null || detail.id === routeId ? detail
    : { id: routeId, phase: isCustomerId(routeId) ? 'loading' : 'not-found', text: isCustomerId(routeId) ? TEXT.detailLoading : NOT_FOUND_TEXT, customer: null };
  const detailKnown = shownDetail.customer !== null && (shownDetail.phase === 'unavailable' || shownDetail.phase === 'rate-limited');
  const button = 'px-4 py-2 bg-primary text-white text-xs font-black uppercase tracking-widest rounded-xl disabled:opacity-50 disabled:cursor-not-allowed';
  const quiet = 'px-4 py-2 bg-white text-primary border border-slate-300 text-xs font-black uppercase tracking-widest rounded-xl disabled:opacity-50 disabled:cursor-not-allowed';
  const hintClass = 'text-[11px] font-medium text-slate-500';
  const inputClass = 'w-full text-sm px-3 py-2 rounded-lg border border-slate-300 bg-white';
  const labelClass = 'block text-[10px] font-black text-slate-500 uppercase tracking-widest';
  const errorClass = 'text-xs font-bold text-rose-700';
  const canOfferEdit = canEdit && uid !== null && edit === null && editHeld === undefined && shownDetail.phase === 'ready'
    && shownDetail.customer !== null && shownDetail.version !== undefined;
  // A notice bound to a customer is said as such on that customer's page, and by name everywhere else.
  const editNotice = editStatus === null ? '' : editStatus.customerId === undefined || editStatus.customerId === routeId ? editStatus.text : editStatus.named ?? '';
  const canSaveEdit = edit !== null && !edit.conflict && !editing && editHeld === undefined && !waiting;
  const editHint = editing ? 'Working…' : edit?.conflict === true ? 'Review the latest details first.'
    : editHeld !== undefined ? 'An earlier change is not confirmed yet. Check it again or discard it first.' : waiting ? waitHint(wait) : '';
  /** One edit field: a label, the input with its error wiring, and the error when the field is refused. */
  const editField = (field: keyof Fields, label: string, ref: typeof editName, inputMode?: 'tel' | 'email') => (
    <div className="space-y-1">
      <label htmlFor={`directory-edit-${field}`} className={labelClass}>{label}</label>
      <input
        ref={ref}
        id={`directory-edit-${field}`}
        data-testid={`directory-edit-${field}`}
        type="text"
        inputMode={inputMode}
        autoComplete="off"
        aria-required={field === 'name' ? 'true' : undefined}
        readOnly={editing || editHeld !== undefined}
        value={editDraft[field]}
        aria-invalid={editErrors[field] !== ''}
        aria-describedby={[editErrors[field] !== '' ? `directory-edit-${field}-error` : '', editHeld !== undefined ? 'directory-edit-hold-text' : ''].filter((id) => id !== '').join(' ') || undefined}
        onChange={(e) => { const value = e.target.value; setEditDraft((d) => ({ ...d, [field]: value })); setEditErrors((x) => ({ ...x, [field]: '' })); }}
        className={inputClass}
      />
      {editErrors[field] !== '' && <p id={`directory-edit-${field}-error`} data-testid={`directory-edit-${field}-error`} role="alert" className={errorClass}>{editErrors[field]}</p>}
    </div>
  );

  return (
    <section
      data-testid="customer-directory"
      aria-labelledby="customer-directory-title"
      className="bg-white/80 backdrop-blur-xl rounded-[2.5rem] border border-slate-200 p-8 shadow-sm space-y-4"
    >
      <h1 id="customer-directory-title" className="text-3xl font-black text-primary tracking-tight">Customer directory</h1>
      <p className="text-slate-600 text-sm font-medium">Saved on the server for this store: each customer&apos;s name, and a phone and an email when they are given.</p>
      <p className="text-slate-500 text-sm font-medium">
        The Customers page&apos;s own contact details, loyalty and history are held only in this browser&apos;s memory and are not linked to these records.
      </p>

      {connectionChanged && (
        <p data-testid="directory-connection-changed" role="alert" className="text-sm font-bold text-amber-800">{CONNECTION_CHANGED_TEXT}</p>
      )}
      {saved !== null && !('earlier' in saved) && (
        <p ref={savedNotice} tabIndex={-1} data-testid="directory-saved" role="status" className="text-sm font-bold text-emerald-800">
          Saved on the server: &quot;{saved.name}&quot;.{' '}
          <Link data-testid="directory-saved-link" to={`${DIRECTORY_PATH}/${saved.id}`} className="underline">View this customer</Link>
        </p>
      )}
      {saved !== null && 'earlier' in saved && (
        <p data-testid="directory-saved-earlier" role="status" className="text-sm font-bold text-slate-700">{saved.earlier === null ? ENDED_TEXT.saved : savedEarlierText(saved.earlier)}</p>
      )}

      {attempt !== undefined && (
        <div
          role="group"
          aria-label="A customer that is not confirmed yet"
          data-testid="directory-hold"
          data-state={attempt.state}
          data-detached={detached ? 'true' : 'false'}
          className="p-4 rounded-2xl bg-amber-50 border border-amber-200 space-y-2"
        >
          {/* A session end detached it: nothing names it here (its view carries no name). */}
          {attempt.state !== 'unresolved' && attempt.ended && <p role="status" className="text-sm font-bold text-amber-900">{ENDED_TEXT.sending}</p>}
          {attempt.state === 'sending' && !attempt.ended && <p role="status" className="text-sm font-bold text-amber-900">Sending &quot;{attempt.name}&quot; to the server…</p>}
          {attempt.state === 'checking' && !attempt.ended && <p role="status" className="text-sm font-bold text-amber-900">Checking &quot;{attempt.name}&quot; with the server…</p>}
          {attempt.state === 'unresolved' && (
            <>
              <p role="status" className="text-sm font-bold text-amber-900">{attempt.ended ? ENDED_TEXT.unresolved : unresolvedText(attempt.name)}</p>
              {holdNote !== null && holdNote.key === attempt.key && (
                <p data-testid="directory-hold-reason" role="status" className="text-xs font-bold text-amber-800">{holdNote.text}</p>
              )}
              {detached || tooOld ? (
                <p data-testid="directory-hold-detached" className="text-xs font-bold text-amber-800">
                  {detached ? 'It was sent under an earlier connection' : 'It was sent too long ago'} and cannot be checked from here. The directory may
                  show it, but a row with the same name is not proof.
                </p>
              ) : (
                <div className="flex flex-wrap items-center gap-3">
                  <button ref={checkButton} type="button" data-testid="directory-check-again" disabled={waiting} aria-describedby="directory-check-hint" onClick={() => { void checkAgain(); }} className={button}>
                    Check again
                  </button>
                  <span id="directory-check-hint" className={hintClass}>{waiting ? waitHint(wait) : ''}</span>
                </div>
              )}
              <p id="directory-stop-warning" className="text-xs font-medium text-amber-900">{STOP_WARNING_TEXT}</p>
              <button type="button" data-testid="directory-stop-tracking" aria-describedby="directory-stop-warning" onClick={stopTracking} className={quiet}>
                Stop tracking
              </button>
            </>
          )}
        </div>
      )}

      {editHeld !== undefined && (
        <div
          ref={editCard}
          tabIndex={-1}
          role="group"
          aria-label="A customer change that is not confirmed yet"
          data-testid="directory-edit-hold"
          data-state={editHeld.state}
          className="p-4 rounded-2xl bg-amber-50 border border-amber-200 space-y-2"
        >
          {/* Announced through the fixed live regions above; the card only shows. */}
          {editHeld.state === 'sending' && <p id="directory-edit-hold-text" className="text-sm font-bold text-amber-900">Saving your changes to &quot;{editHeld.name}&quot;…</p>}
          {editHeld.state === 'checking' && <p id="directory-edit-hold-text" className="text-sm font-bold text-amber-900">Checking your changes to &quot;{editHeld.name}&quot; with the server…</p>}
          {editHeld.state === 'unresolved' && (
            <>
              <p id="directory-edit-hold-text" className="text-sm font-bold text-amber-900">{EDIT_UNKNOWN_TEXT}</p>
              {editNote !== null && editNote.key === editHeld.key && editNote.text !== '' && (
                <p data-testid="directory-edit-hold-reason" className="text-xs font-bold text-amber-800">{editNote.text}</p>
              )}
              {editTooOld ? (
                <p data-testid="directory-edit-hold-too-old" className="text-xs font-bold text-amber-800">
                  It was sent too long ago and cannot be checked from here. Open the customer to see its current details; matching details are not proof.
                </p>
              ) : (
                <div className="flex flex-wrap items-center gap-3">
                  <button type="button" data-testid="directory-edit-check" disabled={waiting || editing} aria-describedby="directory-edit-check-hint" onClick={() => { void checkEdit(); }} className={button}>
                    Check again
                  </button>
                  <span id="directory-edit-check-hint" className={hintClass}>{waiting ? waitHint(wait) : ''}</span>
                </div>
              )}
              <p id="directory-edit-discard-warning" className="text-xs font-medium text-amber-900">{EDIT_DISCARD_WARNING_TEXT}</p>
              <button type="button" data-testid="directory-edit-discard" aria-describedby="directory-edit-discard-warning" onClick={discardEdit} className={quiet}>
                Discard
              </button>
            </>
          )}
        </div>
      )}
      <div data-testid="directory-edit-notices">
        <p ref={editPolite} tabIndex={-1} data-testid="directory-edit-status" role="status" className="text-sm font-bold text-slate-700">
          {editStatus !== null && !editStatus.alert ? editNotice : ''}
        </p>
        <p ref={editAlertRef} tabIndex={-1} data-testid="directory-edit-alert" role="alert" className="text-sm font-bold text-rose-800">
          {editStatus !== null && editStatus.alert ? editNotice : ''}
        </p>
      </div>

      {/* Keyed: the list's elements (its state text above all) are never reused for the detail's, or the other way round. */}
      {routeId !== null ? (
        <section
          key="detail"
          data-testid="directory-detail"
          data-phase={shownDetail.phase}
          aria-labelledby="directory-detail-title"
          aria-busy={shownDetail.phase === 'loading'}
          className="space-y-3"
        >
          <Link data-testid="directory-back" to={DIRECTORY_PATH} className="text-sm font-bold text-primary underline">Back to directory</Link>
          <h2 id="directory-detail-title" ref={detailTitle} tabIndex={-1} className="text-xl font-black text-primary tracking-tight">Customer</h2>
          {shownDetail.phase === 'not-found' ? (
            <p data-testid="directory-not-found" role="alert" className="text-sm font-bold text-slate-700">{NOT_FOUND_TEXT}</p>
          ) : (
            <p data-testid="directory-detail-state" role={shownDetail.phase === 'denied' ? 'alert' : 'status'} className="text-sm font-bold text-slate-600">
              {shownDetail.text}
              {detailKnown && <span data-testid="directory-detail-last-known" className="block text-xs font-black uppercase tracking-widest text-amber-800">Last known — could not refresh</span>}
            </p>
          )}
          {shownDetail.customer !== null && (shownDetail.phase === 'ready' || detailKnown) && (
            <dl className="grid grid-cols-[8rem_1fr] gap-2 text-sm">
              <dt className="font-black text-slate-500">Name</dt>
              <dd data-testid="directory-detail-name" className="font-bold text-slate-900 break-words">{shownDetail.customer.name}</dd>
              <dt className="font-black text-slate-500">Phone</dt>
              <dd data-testid="directory-detail-phone" className="font-bold text-slate-900 break-words">{shownDetail.customer.phone ?? NOT_PROVIDED_TEXT}</dd>
              <dt className="font-black text-slate-500">Email</dt>
              <dd data-testid="directory-detail-email" className="font-bold text-slate-900 break-all">{shownDetail.customer.email ?? NOT_PROVIDED_TEXT}</dd>
              <dt className="font-black text-slate-500">Created</dt>
              <dd data-testid="directory-detail-created" className="text-slate-700">
                {shownDetail.customer.createdAt === null ? NOT_RECORDED_TEXT
                  : <time dateTime={shownDetail.customer.createdAt}>{createdText(shownDetail.customer.createdAt)}</time>}
              </dd>
              <dt className="font-black text-slate-500">Customer ID</dt>
              <dd data-testid="directory-detail-id" className="font-mono text-slate-700 break-all">{shownDetail.customer.id}</dd>
            </dl>
          )}
          {canOfferEdit && (
            <button ref={editButton} type="button" data-testid="directory-edit" onClick={openEdit} className={quiet}>Edit</button>
          )}
          {edit !== null && edit.id === routeId && (
            <form ref={editForm} noValidate aria-labelledby="directory-edit-title" onSubmit={(e) => { e.preventDefault(); void saveEdit(); }} className="pt-4 border-t border-slate-100 space-y-2">
              <h3 id="directory-edit-title" className="text-sm font-black text-primary uppercase tracking-widest">Edit customer</h3>
              {editField('name', 'Customer name (required)', editName)}
              <div className="flex flex-wrap gap-3">
                <div className="flex-1 min-w-[14rem]">{editField('phone', 'Phone (optional)', editPhone, 'tel')}</div>
                <div className="flex-1 min-w-[14rem]">{editField('email', 'Email (optional)', editEmail, 'email')}</div>
              </div>
              <p className={hintClass}>Leave a phone or an email blank to remove it.</p>
              <div className="flex flex-wrap items-center gap-3">
                <button type="submit" data-testid="directory-edit-save" disabled={!canSaveEdit} aria-describedby="directory-edit-hint" className={button}>Save</button>
                {edit.conflict && (
                  <button ref={reviewButton} type="button" data-testid="directory-edit-review" disabled={editing} onClick={() => { void reviewEdit(); }} className={quiet}>Review latest</button>
                )}
                <button type="button" data-testid="directory-edit-cancel" onClick={cancelEdit} className={quiet}>Cancel</button>
                <p id="directory-edit-hint" data-testid="directory-edit-hint" className={`${hintClass} min-h-[1rem]`}>{editHint}</p>
              </div>
            </form>
          )}
          {(shownDetail.phase === 'unavailable' || shownDetail.phase === 'signed-out' || shownDetail.phase === 'rate-limited') && uid !== null && (
            <div className="flex flex-wrap items-center gap-3">
              <button type="button" data-testid="directory-detail-retry" disabled={waiting} aria-describedby="directory-detail-hint" onClick={() => { void loadDetail(routeId, shownDetail.phase === 'signed-out'); }} className={button}>
                {shownDetail.phase === 'signed-out' ? 'Reconnect' : 'Try again'}
              </button>
              <span id="directory-detail-hint" className={hintClass}>{waiting ? waitHint(wait) : ''}</span>
            </div>
          )}
        </section>
      ) : (
        <section key="list" aria-labelledby="directory-list-title" aria-busy={listBusy} className="space-y-3">
          <h2 id="directory-list-title" ref={listTitle} tabIndex={-1} className="text-xl font-black text-primary tracking-tight">Customers on the server</h2>
          {uid !== null && (
            <form role="search" noValidate data-testid="directory-search" onSubmit={(e) => { e.preventDefault(); applySearch(searchDraft); }} className="space-y-1">
              <label htmlFor="directory-search-input" className={labelClass}>Search customers by name</label>
              <div className="flex flex-wrap items-center gap-3">
                <input
                  ref={searchInput}
                  id="directory-search-input"
                  data-testid="directory-search-input"
                  type="search"
                  autoComplete="off"
                  value={searchDraft}
                  aria-invalid={searchRefused}
                  aria-describedby={searchRefused ? 'directory-search-error' : undefined}
                  onChange={(e) => { setSearchDraft(e.target.value); setSearchRefused(false); }}
                  className="flex-1 min-w-[14rem] text-sm px-3 py-2 rounded-lg border border-slate-300 bg-white"
                />
                <button type="submit" data-testid="directory-search-submit" disabled={!canSearch} aria-describedby="directory-search-hint" className={button}>Search</button>
                <button type="button" data-testid="directory-search-clear" disabled={!canSearch || (searchDraft === '' && list.query === '')} onClick={clearSearch} className={quiet}>Clear</button>
                <span id="directory-search-hint" data-testid="directory-search-hint" className={hintClass}>{searchHint}</span>
              </div>
              {searchRefused && <p id="directory-search-error" data-testid="directory-search-error" role="alert" className={errorClass}>{SEARCH_RULE_TEXT}</p>}
            </form>
          )}
          <p data-testid="directory-state" data-phase={list.phase} role={list.phase === 'denied' ? 'alert' : 'status'} className="text-sm font-bold text-slate-600 min-h-[1rem]">
            {list.text}
            {list.query !== '' && list.rows.length > 0 && <span data-testid="directory-search-summary" className="block font-medium text-slate-700 break-words">{searchMatchingText(list.query)}</span>}
            {lastKnown && <span data-testid="directory-last-known" className="block text-xs font-black uppercase tracking-widest text-amber-800">{LAST_KNOWN_TEXT}</span>}
            {list.phase === 'ready' && list.rows.length === 0 && (list.query === ''
              ? <span data-testid="directory-empty" className="block font-medium text-slate-600">{EMPTY_TEXT}</span>
              : <span data-testid="directory-search-none" className="block font-medium text-slate-600 break-words">{searchNoneText(list.query)}</span>)}
          </p>
          {list.note !== '' && <p data-testid="directory-list-note" role="status" className="text-sm font-bold text-amber-800">{list.note}</p>}

          <div className="flex flex-wrap items-center gap-3">
            {(list.phase === 'unavailable' || list.phase === 'signed-out' || list.phase === 'rate-limited') && uid !== null && (
              <button type="button" data-testid="directory-retry" disabled={listBusy || waiting} aria-describedby="directory-busy-hint" onClick={() => { void loadList('first', '', list.phase === 'signed-out'); }} className={button}>
                {list.phase === 'signed-out' ? 'Reconnect' : 'Try again'}
              </button>
            )}
            {(list.phase === 'ready' || list.phase === 'denied' || list.phase === 'loading') && uid !== null && (
              <button type="button" data-testid="directory-refresh" disabled={listBusy || waiting} aria-describedby="directory-busy-hint" onClick={() => { void loadList('first'); }} className={quiet}>
                Refresh
              </button>
            )}
            <span id="directory-busy-hint" className={hintClass}>{busyHint}</span>
          </div>

          {list.rows.length > 0 && (
            <ul data-testid="directory-list" className="divide-y divide-slate-100 border border-slate-100 rounded-2xl">
              {list.rows.map((row) => (
                <li key={row.id} data-testid="directory-row" data-id={row.id} className="px-4 py-3">
                  <Link to={`${DIRECTORY_PATH}/${row.id}`} className="block min-h-[24px] text-sm font-bold text-primary underline break-words">{row.name}</Link>
                </li>
              ))}
            </ul>
          )}
          {list.phase === 'ready' && list.next !== null && (
            <div className="flex flex-wrap items-center gap-3">
              <button type="button" data-testid="directory-load-more" disabled={listBusy || waiting} aria-describedby="directory-more-hint" onClick={() => { void loadList('more'); }} className={quiet}>
                Load more
              </button>
              <span id="directory-more-hint" className={hintClass}>{busyHint}</span>
            </div>
          )}

          {canCreate ? (
            <form noValidate onSubmit={(e) => { e.preventDefault(); void add(); }} className="pt-4 border-t border-slate-100 space-y-2">
              <label htmlFor="directory-name" className="block text-[10px] font-black text-slate-500 uppercase tracking-widest">Customer name (required)</label>
              <input
                ref={nameInput}
                id="directory-name"
                data-testid="directory-name"
                type="text"
                autoComplete="off"
                aria-required="true"
                value={draft.name}
                aria-invalid={errors.name !== ''}
                aria-describedby={errors.name !== '' ? 'directory-name-error' : undefined}
                onChange={(e) => { const name = e.target.value; setDraft((d) => ({ ...d, name })); setErrors((x) => ({ ...x, name: '' })); }}
                className="w-full text-sm px-3 py-2 rounded-lg border border-slate-300 bg-white"
              />
              {errors.name !== '' && <p id="directory-name-error" data-testid="directory-name-error" role="alert" className="text-xs font-bold text-rose-700">{errors.name}</p>}
              <div className="flex flex-wrap gap-3">
                <div className="flex-1 min-w-[14rem] space-y-1">
                  <label htmlFor="directory-phone" className="block text-[10px] font-black text-slate-500 uppercase tracking-widest">Phone (optional)</label>
                  <input
                    ref={phoneInput}
                    id="directory-phone"
                    data-testid="directory-phone"
                    type="text"
                    inputMode="tel"
                    autoComplete="off"
                    value={draft.phone}
                    aria-invalid={errors.phone !== ''}
                    aria-describedby={errors.phone !== '' ? 'directory-phone-error' : undefined}
                    onChange={(e) => { const phone = e.target.value; setDraft((d) => ({ ...d, phone })); setErrors((x) => ({ ...x, phone: '' })); }}
                    className="w-full text-sm px-3 py-2 rounded-lg border border-slate-300 bg-white"
                  />
                  {errors.phone !== '' && <p id="directory-phone-error" data-testid="directory-phone-error" role="alert" className="text-xs font-bold text-rose-700">{errors.phone}</p>}
                </div>
                <div className="flex-1 min-w-[14rem] space-y-1">
                  <label htmlFor="directory-email" className="block text-[10px] font-black text-slate-500 uppercase tracking-widest">Email (optional)</label>
                  <input
                    ref={emailInput}
                    id="directory-email"
                    data-testid="directory-email"
                    type="text"
                    inputMode="email"
                    autoComplete="off"
                    value={draft.email}
                    aria-invalid={errors.email !== ''}
                    aria-describedby={errors.email !== '' ? 'directory-email-error' : undefined}
                    onChange={(e) => { const email = e.target.value; setDraft((d) => ({ ...d, email })); setErrors((x) => ({ ...x, email: '' })); }}
                    className="w-full text-sm px-3 py-2 rounded-lg border border-slate-300 bg-white"
                  />
                  {errors.email !== '' && <p id="directory-email-error" data-testid="directory-email-error" role="alert" className="text-xs font-bold text-rose-700">{errors.email}</p>}
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-3">
                <button type="submit" data-testid="directory-add" disabled={!canAdd} aria-describedby="directory-add-hint" className={button}>Add customer</button>
                <p id="directory-add-hint" data-testid="directory-add-hint" className={`${hintClass} min-h-[1rem]`}>{addHint}</p>
              </div>
            </form>
          ) : (
            <p data-testid="directory-create-unavailable" className="pt-4 border-t border-slate-100 text-sm font-medium text-slate-600">
              Your role in this store does not include adding customers.
            </p>
          )}
        </section>
      )}
      <p data-testid="directory-create-status" role={createStatus?.refusal ? 'alert' : 'status'} className="text-sm font-bold text-slate-700 min-h-[1rem]">
        {createStatus?.text ?? ''}
      </p>
    </section>
  );
}
