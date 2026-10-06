// M7B-INVOICES-P1 — the Invoices page's "Server drafts" section (design D7, R10): invoice drafts saved on the server for a
// store, over invoiceDraftsClient.ts. Choose a store (from GET /api/v1/stores), see its drafts newest first ("Load more"),
// open one read-only, and save a new one ("New server draft") for a customer saved on the server, in USD.
//
//   - Separate from this browser's invoices: a server draft never enters the local invoice list, its counters or any
//     browser storage, and nothing here offers what a draft is not (no number, no amount owed, no status but "Draft").
//   - The server decides everything. `canCreate` (Invoices Create) and `canViewCustomers` (the customers feature and
//     Customers View) are the local role state's hints only; the server's 403 is the answer that counts.
//   - The store is ALWAYS an explicit choice from the server's own list: nothing is preselected (not even a single store),
//     and this browser's store labels are never mapped to it. A read-only store lists and opens drafts but offers no new
//     one. Reads are opened by "Show server drafts": nothing is read and no session is made before that.
//   - A GENERATION is one store connection as this section knows it: a counter and the session's CSRF token, in a ref,
//     exactly as the customer picker's. `connect()` (the session client's `ensure`) runs before every list or draft read:
//     plain, `fresh` only for the one check after a 403, `reconnect` only from the Reconnect button. A different token
//     starts a new generation: reads in flight are cancelled, the stores, the choice, the drafts, the names and both
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
//     read goes, a rate limit's wait ends, the new-draft dialog closes, and it says the session ended; nothing is read
//     and nobody is signed in because of it. A save or a Check again whose session was confirmed just before a sign-out
//     began sends nothing: each counts the session ends before it asks (`sessionEndsSoFar`) and compares after the
//     answer; and the sign-out forgets the picker's pair, so a customer chosen before it matches no session any more.
//     The new-draft dialog's hand-over (M7B-INVOICES-P1-R2, AC-07) asks its session check only while no sign-out has
//     begun and the section's generation and token are still the ones it opened under, and uses the answer only if
//     they still are: otherwise it sets no customer and makes no context. What is scrubbed here does not wait for the server: the logout itself is best effort (a failed one leaves that
//     server session to its idle timeout). A created attempt is never read back under a later session: it says it was
//     saved under an earlier connection. A refused one still shows its own text, until Dismiss or Stop tracking.
//   - After CREATED, the draft is read back with a GET (never another POST), only under the hold's own session: "Saved"
//     when it loads, "Saved, but it could not be loaded back" when it does not.
//   - The session token sits only in refs, the hold store, an open new-draft dialog's state and the picker's
//     `sessionContextOf` pair (tenantSessionClient.ts lists the holders, and what a sign-out takes from each): never
//     browser storage, a URL, the DOM or a log. No key or body reaches any of those either, and draft content only the
//     DOM (the dialogs show what is typed and read back), never storage, the page's URL or a log; ids leave the page
//     only in API requests (paths, a draft id inside the list cursor, the customer id in the save's body).
//   - Dialogs (the reopen and the new draft) follow the picker's pattern: a portal, role=dialog and aria-modal, the page
//     behind made inert, Escape closing only the top dialog, Tab wrapping inside it (buttons, inputs, selects, textareas),
//     focus lost to a control the user's press removed or disabled taken back inside without scrolling (never from the
//     picker over it; a line's Remove hands it to the neighbouring line itself), focus returned on close. One of the two
//     at a time: the new draft never opens beside the reopen dialog. z-[180]: above the invoice dialogs (z-50) and below
//     the picker it opens (z-[190]) and the shop's z-[200] layers.
//   - Outside the dialogs focus never falls to <body> either (DA-199). The section tracks the control that last took
//     focus in it (`trackFocus`); a render that removes or disables it while focus is still on it (or fell from it to
//     <body>) hands focus to the section heading. So a press that takes its own control away — "Show server drafts", the
//     stores' Try again or Reconnect, the list's Try again — lands on the heading, as does any other such render: a new
//     generation, a session end, a rate limit's wait (New, Check again), a page one that drops rows, the local role hint
//     (`canCreate`) taking New away. The attempt card's Check again, Stop tracking and Dismiss hand focus to the heading
//     themselves, first. "Load more" is aria-disabled, never disabled, during its read, so it keeps focus while more
//     pages remain; when its answer takes it away, focus goes to the first row that answer added (the last page), else to
//     the heading (a failure, a reload from page one, a session end). Focus on another control or in a dialog is never
//     taken, nor is focus the user left on <body> by a press elsewhere (a press outside the tracked control ends the
//     tracking).

import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { onSessionEnd, sessionEndsSoFar, tenantSession, type SessionResult, type TenantSessionClient } from './tenantSessionClient';
import { customers as customersClient, type CustomersClient } from './customersClient';
import {
  invoiceDrafts as draftsClient, draftBody, formatCents, lineAmounts, MAX_CENTS, MAX_DRAFT_LINES,
  type CreateDraftResult, type DraftDetail, type DraftLineFields, type DraftSummary, type InvoiceDraftsClient, type StoreEntry,
} from './invoiceDraftsClient';
import { firebaseShopIdentity, type ShopIdentity } from './ServerCustomerLevels';
import { CHECK_CUTOFF_MS, createdText } from './ServerCustomerDirectory';
import { ServerCustomerField, idEndingText, isContextOf, pickerWaitText, sessionContextOf } from './ServerCustomerPicker';
import { serverCustomerReference, type ServerCustomerReference } from './customerReference';

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
});

/** A store as the user chooses it: its name, or the end of its id; never a browser store label. */
export const storeLabel = (store: Pick<StoreEntry, 'id' | 'name'>): string =>
  store.name !== null && store.name.trim() !== '' ? store.name : `Store, ${idEndingText(store.id)}`;
/** A customer whose name could not be read. */
export const customerFallbackText = (id: string): string => `Customer, ${idEndingText(id)}`;
export const lineCountText = (n: number): string => `${n} line${n === 1 ? '' : 's'}`;
/** The DOM id of a listed draft's Open button. */
const openIdOf = (id: string): string => `drafts-open-${id}`;

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

export interface DraftHoldStore {
  get(uid: string): HeldDraft | undefined;
  /** Hold `attempt` for `uid`; false (nothing held) while that user's earlier attempt is still live. A settled one is replaced. */
  put(uid: string, attempt: HeldDraft): boolean;
  /** Change the attempt under `key`; false when the store's attempt is another (a stale continuation is a no-op). */
  change(uid: string, key: string, next: Partial<Omit<HeldDraft, 'key'>>): boolean;
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

export function createDraftHoldStore(): DraftHoldStore {
  const held = new Map<string, HeldDraft>();
  const listeners = new Set<() => void>();
  const tell = (): void => { for (const listener of [...listeners]) listener(); };
  const detachOne = (uid: string): boolean => {
    const current = held.get(uid);
    if (current === undefined || current.csrf === null) return false;
    held.set(uid, Object.freeze({ ...current, csrf: null, body: '' }));
    return true;
  };
  return Object.freeze({
    get: (uid: string) => held.get(uid),
    put(uid: string, attempt: HeldDraft): boolean {
      if (isLiveHold(held.get(uid))) return false;
      held.set(uid, Object.freeze({ ...attempt }));
      tell();
      return true;
    },
    change(uid: string, key: string, next: Partial<Omit<HeldDraft, 'key'>>): boolean {
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
export function bindDraftHoldsToSessionEnd(holds: DraftHoldStore): () => void {
  return onSessionEnd(() => holds.detachOthers(null));
}

/** The shop's one draft hold store, scrubbed at every sign-out. */
const draftHolds: DraftHoldStore = createDraftHoldStore();
const unbindDraftHolds = bindDraftHoldsToSessionEnd(draftHolds);
import.meta.hot?.dispose(unbindDraftHolds); // a hot reload replaces this module: its listener goes with its store

const waitHint = (seconds: number): string => `Wait ${seconds} second${seconds === 1 ? '' : 's'}.`;

/** Why an answer left the attempt unresolved. Never "not saved": only a decisive answer for the same key says that. */
function reasonOf(answer: CreateDraftResult): string {
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
// The dialog frame shared by the reopen and the new draft dialogs.

const focusRing = 'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-700';
const button = `px-4 py-2 bg-primary text-white text-xs font-black uppercase tracking-widest rounded-xl disabled:opacity-50 disabled:cursor-not-allowed ${focusRing}`;
const quiet = `px-4 py-2 bg-white text-primary border border-slate-300 text-xs font-black uppercase tracking-widest rounded-xl disabled:opacity-50 disabled:cursor-not-allowed ${focusRing}`;
const hintClass = 'text-[11px] font-medium text-slate-500';
const inputClass = `w-full text-sm px-3 py-2 rounded-lg border border-slate-300 bg-white ${focusRing}`;
const labelClass = 'block text-[10px] font-black text-slate-500 uppercase tracking-widest';
const STOPS = 'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href]';

interface DialogFrameProps {
  readonly labelledBy: string;
  readonly testId: string;
  readonly busy?: boolean;
  readonly onClose: () => void;
  /** Where focus goes when the dialog opens (the dialog itself when null). */
  readonly initialFocus?: RefObject<HTMLElement | null>;
  /** Where focus goes when the dialog closes, when the element that had it before is gone. */
  readonly returnFocus?: RefObject<HTMLElement | null>;
  readonly children: ReactNode;
}

function DialogFrame({ labelledBy, testId, busy = false, onClose, initialFocus, returnFocus, children }: DialogFrameProps) {
  const overlay = useRef<HTMLDivElement | null>(null);
  const dialog = useRef<HTMLDivElement | null>(null);
  const close = useRef(onClose);
  useLayoutEffect(() => { close.current = onClose; });

  // The page behind is inert while the dialog is open, as the picker's: only the nodes THIS dialog made inert are restored.
  useLayoutEffect(() => {
    const own = overlay.current;
    const made = [...document.body.children].filter((node) => node !== own && !node.hasAttribute('inert'));
    for (const node of made) node.setAttribute('inert', '');
    return () => { for (const node of made) node.removeAttribute('inert'); };
  }, []);

  // Focus moves in on open and goes back on close: to what had it before, or to `returnFocus` when that is gone.
  useEffect(() => {
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    (initialFocus?.current ?? dialog.current)?.focus();
    return () => {
      // After the commit that removed the dialog (and its inert marks): what had focus before, unless it is gone or
      // disabled meanwhile (New server draft while an attempt is unconfirmed), else `returnFocus`.
      setTimeout(() => {
        const usable = (node: HTMLElement | null | undefined): node is HTMLElement =>
          node != null && node.isConnected && node !== document.body && !(node as HTMLButtonElement).disabled;
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
    const disabled = (node: Element | null): boolean => (node as HTMLButtonElement | null)?.disabled === true;
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
    const stops = [...dialog.current.querySelectorAll<HTMLElement>(STOPS)];
    if (stops.length === 0) { e.preventDefault(); return; }
    const first = stops[0];
    const last = stops[stops.length - 1];
    const at = document.activeElement;
    if (!stops.some((stop) => stop === at)) { e.preventDefault(); (e.shiftKey ? last : first).focus(); }
    else if (e.shiftKey && at === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && at === last) { e.preventDefault(); first.focus(); }
  }

  return createPortal(
    <div
      ref={overlay}
      onMouseDown={(e) => { if (e.target === e.currentTarget) e.preventDefault(); }}
      className="fixed inset-0 z-[180] flex items-center justify-center p-4 bg-slate-900/40"
    >
      <div
        ref={dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
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
  /** The local role state's hint that this user may create invoices (Invoices Create). The server decides. */
  readonly canCreate: boolean;
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
  // A user change or a sign-out detaches every other user's attempt: it can never be sent again from here.
  useEffect(() => { holds.detachOthers(props.uid); }, [holds, props.uid]);
  if (props.uid === null) return null;
  return <DraftsSection key={props.uid} {...props} uid={props.uid} holds={holds} />;
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
}
interface ReopenState { readonly id: string; readonly storeId: string; readonly phase: Phase | 'not-found'; readonly text: string; readonly draft: DraftDetail | null }
/** `n`, `csrf` and `since`: the section's generation and `sessionEndsSoFar()` when the dialog opened (AC-07, the hand-over's checks). */
interface NewDraftState {
  readonly store: StoreEntry; readonly csrf: string; readonly n: number; readonly since: number;
  readonly handoff: { readonly id: string; readonly name: string } | null;
}
interface Failure { readonly kind: 'denied' | 'signed-out' | 'rate-limited' | 'unavailable'; readonly text: string; readonly seconds?: number }

/** One generation's customer names: what was read (null: not readable), what is asked or queued, how many reads are out. */
interface NameBook { readonly gen: number; readonly map: Map<string, string | null>; readonly pending: Set<string>; readonly queue: string[]; active: number; stopped: boolean }
const newBook = (gen: number): NameBook => ({ gen, map: new Map(), pending: new Set(), queue: [], active: 0, stopped: false });

const STORES_IDLE: StoresState = Object.freeze({ phase: 'idle', text: '', stores: [] });
const listOf = (gen: number, storeId: string, phase: Phase = 'idle', text = ''): ListState =>
  Object.freeze({ gen, storeId, phase, text, rows: [], next: null, note: '' });
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
/** `created`: the attempt's answer was a validated 201 (it may already have been read back and left the store). */
type SendOutcome = { readonly kind: 'sent'; readonly key: string; readonly created: boolean } | { readonly kind: 'not-sent'; readonly text: string } | { readonly kind: 'blocked' };

function DraftsSection({
  uid, canCreate, canViewCustomers, handoff, onHandoffTaken,
  session = tenantSession, drafts = draftsClient, customers = customersClient, identity = firebaseShopIdentity,
  holds = draftHolds, now, wallNow, newKey,
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
  const [, setNamesTick] = useState(0);
  const [, setTick] = useState(0);
  const held = useSyncExternalStore(holds.subscribe, () => holds.get(uid));

  const gen = useRef<{ n: number; csrf: string | null }>({ n: 0, csrf: null }); // the token: refs, the hold store, the open dialog's state
  const alive = useRef(false);
  const storesRef = useRef<StoresState>(stores);
  const storeRef = useRef('');
  const listRef = useRef<ListState>(list);
  const reopenRef = useRef<ReopenState | null>(null);
  const seq = useRef({ stores: 0, list: 0, reopen: 0 });
  const ctl = useRef<{ stores: AbortController | null; list: AbortController | null; reopen: AbortController | null; names: AbortController | null }>(
    { stores: null, list: null, reopen: null, names: null },
  );
  const names = useRef<NameBook>(newBook(0));
  const waitRef = useRef(false);
  const waitUntil = useRef(0);
  const waitTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const busyRef = useRef(false);
  const busyBy = useRef(0); // the read that set `busy` last: only its own exit clears it (or abortReads)
  const sendingRef = useRef(false); // a Save draft is out: a second press sends nothing
  const checkingRef = useRef(false); // a Check again is out
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
  const setBusy = (next: boolean): void => { busyRef.current = next; setBusyState(next); };
  /**
   * `busy` for one read (stores or list): it takes it on start and gives it back on EVERY exit — an answer, a refusal, a
   * session end it reported itself, or being made stale — unless a later read has taken it since (that one gives it
   * back). A stale exit gives it back too: a read that ends the session itself is stale by then (failSession bumps every
   * counter), and a fresh-exit-only rule left Reconnect disabled for good.
   */
  const takeBusy = (): number => { setBusy(true); return ++busyBy.current; };
  const giveBusy = (token: number): void => { if (alive.current && busyBy.current === token) setBusy(false); };
  const expired = (h: HeldDraft): boolean => Math.max(clock() - h.sentAt, wall() - h.sentWall) >= CHECK_CUTOFF_MS;

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
    waitRef.current = true;
    setWait(seconds);
    waitTimer.current = setTimeout(() => { waitTimer.current = null; waitRef.current = false; setWait(null); }, seconds * 1000);
    return seconds;
  }

  /** Cancel every read in flight; their answers are stale from here, and nothing is busy any more. */
  function abortReads(): void {
    for (const kind of ['stores', 'list', 'reopen', 'names'] as const) ctl.current[kind]?.abort();
    seq.current = { stores: seq.current.stores + 1, list: seq.current.list + 1, reopen: seq.current.reopen + 1 };
    busyBy.current += 1;
    setBusy(false);
  }

  /** A session token: detach the user's live attempt when it was sent under another (a session change, never a store choice). */
  function judgeHold(csrf: string): void {
    const h = holds.get(uid);
    if (isLiveHold(h) && h.csrf !== null && h.csrf !== csrf) holds.detach(uid);
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
    putReopen(null);
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
    if (reopenRef.current !== null) putReopen({ ...reopenRef.current, phase: 'signed-out', text: failure.text, draft: null });
    // Nothing is fixed after a confirmed end: the Reconnect's token is a FIRST token, not a "connection changed".
    if (failure.kind === 'signed-out') gen.current = { n: gen.current.n, csrf: null };
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
        return putList({ ...listRef.current, phase: failure.kind, text: failure.seconds !== undefined ? pickerWaitText(startWait(failure.seconds)) : failure.text, note: '' });
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
        putList({ gen: mine, storeId: target, phase: 'ready', text: '', rows: mode === 'more' ? [...was.rows, ...fresh] : fresh, next: answer.nextCursor, note: mode === 'more' ? '' : was.note });
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
      putList(failure.kind === 'denied' ? { ...listOf(mine, target), phase: 'denied', text } : { ...listRef.current, phase: failure.kind, text, note: '' });
    } finally {
      giveBusy(token);
    }
  }

  /** Open one draft read-only: a fresh read of its own (never a list row), for the store it was listed at. */
  async function readReopen(id: string, target: string): Promise<void> {
    const mine = gen.current.n;
    const n = ++seq.current.reopen;
    ctl.current.reopen?.abort();
    const controller = new AbortController();
    ctl.current.reopen = controller;
    const stale = (): boolean => !alive.current || mine !== gen.current.n || n !== seq.current.reopen || reopenRef.current?.id !== id;
    putReopen({ id, storeId: target, phase: 'loading', text: DRAFTS_TEXT.draftLoading, draft: null });
    const s = await connect();
    if (stale()) return;
    if (s.kind !== 'ok') {
      const failure = sessionFailure(s);
      if (failure.kind === 'signed-out') return failSession(failure);
      return putReopen({ id, storeId: target, phase: failure.kind, text: failure.seconds !== undefined ? pickerWaitText(startWait(failure.seconds)) : failure.text, draft: null });
    }
    if (adopt(s.csrf)) return;
    const answer = await drafts.getDraft(target, id, s.csrf, controller.signal);
    if (stale()) return;
    if (answer.kind === 'ok') {
      putReopen({ id, storeId: target, phase: 'ready', text: '', draft: answer.draft });
      return resolveNames([answer.draft.customerId], s.csrf);
    }
    if (answer.kind === 'signed-out') return failSession({ kind: 'signed-out', text: DRAFTS_TEXT.ended });
    const failure = answer.kind === 'not-found' ? { kind: 'not-found' as const, text: DRAFTS_TEXT.draftNotFound } : readFailure(answer, DRAFTS_TEXT.draftDenied);
    putReopen({ id, storeId: target, phase: failure.kind, text: 'seconds' in failure && failure.seconds !== undefined ? pickerWaitText(startWait(failure.seconds)) : failure.text, draft: null });
  }

  /** "Show server drafts": the first read of this section (nothing is read before it). */
  function show(): void {
    if (open) return;
    setOpen(true);
    void readStores();
  }

  function chooseStore(id: string): void {
    if (busyRef.current && storesRef.current.phase === 'loading') return;
    ctl.current.list?.abort();
    seq.current.list += 1;
    storeRef.current = id;
    setStoreIdState(id);
    setNotice('');
    putList(listOf(gen.current.n, id));
    if (id === '') return;
    setChanged(false); // "The store connection changed … Choose a store." is answered by the choice
    // During a rate limit's wait nothing is read (readDrafts refuses): never a blank list — the wait is said, with Try
    // again (enabled once the wait has passed), as after any other rate-limited read.
    if (waitRef.current) {
      const seconds = Math.max(1, Math.ceil((waitUntil.current - clock()) / 1000));
      return putList({ ...listOf(gen.current.n, id), phase: 'rate-limited', text: pickerWaitText(seconds) });
    }
    void readDrafts('first');
  }

  const chosen = stores.stores.find((store) => store.id === storeId) ?? null;
  const live = isLiveHold(held);

  function openNewDraft(with_: { readonly id: string; readonly name: string } | null): void {
    const csrf = gen.current.csrf;
    // One dialog at a time: never beside the reopen dialog (up from the Open press on, its read still out or not). Its
    // inert page keeps New from a press, but a hand-over can try here on its own (the effect below, when an attempt
    // settles meanwhile); it then stays pending, said by the hand-over note, until New or the effect's next try finds no
    // dialog up.
    if (chosen === null || chosen.readOnly || !canCreate || csrf === null || live || reopenRef.current !== null) return;
    setNotice('');
    setPending(null);
    setNewDraft({ store: chosen, csrf, n: gen.current.n, since: sessionEndsSoFar(), handoff: with_ });
  }

  // A hand-over from the invoice form: open the section, and the dialog at once when a writable store is chosen.
  useEffect(() => {
    if (handoff === null) return;
    events.current.onHandoffTaken();
    setPending(handoff);
    if (!open) show();
  }, [handoff]);
  useEffect(() => {
    if (pending !== null && newDraft === null && chosen !== null && !chosen.readOnly && canCreate && !live && gen.current.csrf !== null) openNewDraft(pending);
  }, [pending, chosen, newDraft, canCreate, live]);

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
      settleDraft(holds, uid, key, await drafts.createDraft(target, body, key, csrf), false);
    } finally {
      checkingRef.current = false;
    }
  }

  function stopTracking(): void {
    const h = holds.get(uid);
    if (h === undefined || h.state === 'sending' || h.state === 'checking') return;
    holds.remove(uid, h.key);
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
    const check = (): void => checkSession();
    window.addEventListener('focus', check);
    document.addEventListener('visibilitychange', check);
    // A sign-out, heard where it starts (the session client's `onSessionEnd`), while this section is mounted — on a
    // direct switch to another user AccessContext.tsx keeps it mounted until that user's profile has loaded. Everything
    // in flight is stale from here: a new generation with no token (a created draft's read-back answer is then ignored),
    // every read cancelled (the name queue with it), the reopen's read dropped and the new-draft dialog closed (its token
    // goes with it), and a rate limit's wait ends with the session that was asked to wait (as `begin` drops another
    // session's); the section says the session ended. Nothing is read and nobody is signed in because of it — only the
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
      for (const kind of ['stores', 'list', 'reopen', 'names'] as const) ctl.current[kind]?.abort();
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
      {notice !== '' && <p data-testid="drafts-notice" role="status" className="text-sm font-bold text-emerald-800">{notice}</p>}

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
              ) : canCreate && (
                <div className="flex flex-wrap items-center gap-3">
                  <button
                    ref={newButton}
                    type="button"
                    data-testid="drafts-new"
                    disabled={newBlocked}
                    aria-describedby={live ? 'drafts-new-hint' : undefined}
                    onClick={() => openNewDraft(pending)}
                    className={button}
                  >
                    New server draft
                  </button>
                  {live && <span id="drafts-new-hint" className={hintClass}>{NOT_SENT_TEXT.pending}</span>}
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
        <ReopenDialog state={reopen} customerText={customerText} store={stores.stores.find((s) => s.id === reopen.storeId) ?? null} onClose={() => putReopen(null)} returnFocus={heading} />
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

function ReopenDialog({ state, customerText, store, onClose, returnFocus }: {
  readonly state: ReopenState; readonly customerText: (id: string) => string; readonly store: StoreEntry | null;
  readonly onClose: () => void; readonly returnFocus: RefObject<HTMLElement | null>;
}) {
  const closeButton = useRef<HTMLButtonElement | null>(null);
  const draft = state.draft;
  return (
    <DialogFrame labelledBy="draft-view-title" testId="draft-view" busy={state.phase === 'loading'} onClose={onClose} initialFocus={closeButton} returnFocus={returnFocus}>
      <div className="flex items-start justify-between gap-3">
        <h2 id="draft-view-title" className="text-xl font-black text-primary tracking-tight">Server draft</h2>
        <button ref={closeButton} type="button" data-testid="draft-view-close" onClick={onClose} className={quiet}>Close</button>
      </div>
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
          </dl>
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
          <p data-testid="draft-view-subtotal" className="text-right text-base font-black text-primary">Draft subtotal {formatCents(draft.subtotalCents)}</p>
        </div>
      )}
    </DialogFrame>
  );
}

interface LineDraft extends DraftLineFields { readonly key: number }
interface FormErrors {
  readonly customer: boolean;
  /** By line key (not position), so removing a line never moves another line's error onto it. */
  readonly lines: ReadonlyMap<number, { readonly description: boolean; readonly quantity: boolean; readonly unitPrice: boolean; readonly total: boolean }>;
  readonly subtotal: boolean;
  /** The body would be over the server's 64 KiB bound (its 413): refused here, before a key exists. */
  readonly tooLarge: boolean;
}
const NO_ERRORS: FormErrors = Object.freeze({ customer: false, lines: new Map(), subtotal: false, tooLarge: false });

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
  const lineKey = useRef(1);
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

  const setLine = (key: number, field: keyof DraftLineFields, value: string): void =>
    setLines((prev) => prev.map((line) => (line.key === key ? { ...line, [field]: value } : line)));
  const addLine = (): void => {
    if (lines.length >= MAX_DRAFT_LINES) return;
    lineKey.current += 1;
    setLines((prev) => [...prev, { key: lineKey.current, description: '', quantity: '1', unitPrice: '' }]);
  };
  /**
   * Remove one line. Its Remove had focus and goes with it, so focus is handed BEFORE the line goes to the neighbour where
   * the user is — the next line's Remove, else the previous one's — or, when one line is left (its Remove then disabled),
   * to that line's description; never DialogFrame's fallback to line 1, a jump up a long form.
   */
  const removeLine = (key: number): void => {
    const at = lines.findIndex((line) => line.key === key);
    if (lines.length <= 1 || at < 0) return;
    const near = lines[at + 1] ?? lines[at - 1];
    document.getElementById(`draft-line-${near.key}-${lines.length > 2 ? 'remove' : 'description'}`)?.focus();
    setLines((prev) => prev.filter((line) => line.key !== key));
  };

  /** Focus the first invalid field, in reading order: the customer, then each line's description, quantity, price. */
  function focusFirst(next: FormErrors): void {
    const root = dialogRoot.current;
    if (root === null) return;
    const target = next.customer ? root.querySelector<HTMLElement>('[data-testid="picker-open"], [data-testid="picker-change"]')
      : root.querySelector<HTMLElement>('[aria-invalid="true"]') ?? (next.subtotal ? subtotalError.current : next.tooLarge ? sizeError.current : null);
    target?.focus();
  }

  async function save(): Promise<void> {
    if (saving || isLiveHold(held)) return;
    const built = draftBody(state.store.tenantId, customer?.id ?? state.store.tenantId, lines);
    const lineErrors = new Map(lines.map((line, index) => [line.key, built.kind === 'invalid' ? built.lines[index] : { description: false, quantity: false, unitPrice: false, total: false }]));
    const next: FormErrors = { customer: customer === null, lines: lineErrors, subtotal: built.kind === 'invalid' && built.subtotal, tooLarge: built.kind === 'invalid' && built.tooLarge };
    setErrors(next);
    // Refused here: no key and no request.
    if (customer === null || built.kind === 'invalid') {
      setStatus(null);
      // After the render that marks the fields.
      return void setTimeout(() => focusFirst(next), 0);
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

  const subtotal = liveSubtotal(lines);
  // The user's one live attempt (this dialog's, as only a dialog with none can send): its card, with Check again, is here.
  const liveHold = isLiveHold(held) ? held : undefined;
  const blocked = saving || liveHold !== undefined;
  const heldBack = liveHold !== undefined && !saving; // disabled by an earlier attempt, not by this press: said to Save
  const describe = (id: string, bad: boolean): string | undefined => (bad ? id : undefined);

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

        <fieldset className="space-y-3">
          <legend className={labelClass}>Lines ({lines.length} of {MAX_DRAFT_LINES})</legend>
          {lines.map((line, index) => {
            const e = errors.lines.get(line.key) ?? { description: false, quantity: false, unitPrice: false, total: false };
            const n = index + 1;
            const base = `draft-line-${line.key}`;
            return (
              <div key={line.key} data-testid="draft-new-line" className="grid grid-cols-12 gap-2 items-start p-3 rounded-2xl border border-slate-100">
                <div className="col-span-12 sm:col-span-6 space-y-1">
                  <label htmlFor={`${base}-description`} className={labelClass}>Line {n} description</label>
                  <input
                    ref={index === 0 ? (node) => { firstField.current = node; } : undefined}
                    id={`${base}-description`}
                    data-testid="draft-new-description"
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
                  <label htmlFor={`${base}-quantity`} className={labelClass}>Quantity</label>
                  <input
                    id={`${base}-quantity`}
                    data-testid="draft-new-quantity"
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
                  <label htmlFor={`${base}-price`} className={labelClass}>Unit price ($)</label>
                  <input
                    id={`${base}-price`}
                    data-testid="draft-new-price"
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
                <div className="col-span-3 sm:col-span-1 pt-5">
                  <button type="button" id={`${base}-remove`} data-testid="draft-new-remove-line" aria-label={`Remove line ${n}`} disabled={lines.length <= 1} onClick={() => removeLine(line.key)} className={quiet}>×</button>
                </div>
              </div>
            );
          })}
          <button type="button" data-testid="draft-new-add-line" disabled={lines.length >= MAX_DRAFT_LINES} onClick={addLine} className={quiet}>Add line</button>
        </fieldset>

        {/* Only the amount is live (atomic): a change reads the new amount, never the label again. */}
        <p data-testid="draft-new-subtotal" className="text-right text-base font-black text-primary">
          Draft subtotal <span data-testid="draft-new-subtotal-amount" aria-live="polite" aria-atomic="true">{subtotal === null ? '—' : formatCents(subtotal)}</span>
        </p>
        {/* Focused by focusFirst when they are the only errors: the ring shows a keyboard user where focus landed. */}
        {errors.subtotal && <p ref={subtotalError} tabIndex={-1} data-testid="draft-new-subtotal-error" role="alert" className={`text-xs font-bold text-rose-700 text-right ${focusRing}`}>{DRAFT_RULE_TEXT.subtotal}</p>}
        {errors.tooLarge && <p ref={sizeError} tabIndex={-1} data-testid="draft-new-size-error" role="alert" className={`text-xs font-bold text-rose-700 text-right ${focusRing}`}>{DRAFT_RULE_TEXT.tooLarge}</p>}

        {liveHold !== undefined && <HoldCard held={liveHold} expired={expired} onCheck={onCheck} onStop={onStop} waiting={waiting} />}
        {status !== null && <p data-testid="draft-new-status" role={status.alert ? 'alert' : 'status'} className="text-sm font-bold text-rose-800">{status.text}</p>}

        <div className="flex justify-end gap-3">
          {heldBack && <span id="draft-new-save-hint" className="sr-only">{HOLD_TEXT.saveBlocked}</span>}
          <button type="button" data-testid="draft-new-save" disabled={blocked} aria-describedby={heldBack ? 'draft-new-save-hint' : undefined} onClick={() => { void save(); }} className={button}>Save draft</button>
        </div>
      </div>
    </DialogFrame>
  );
}
