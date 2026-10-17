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
//     "Issued" — nothing about payment, and no send, print, void, edit or delete. Nothing is looked up in this browser's
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

import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { flushSync } from 'react-dom';
import { onSessionEnd, sessionEndsSoFar, tenantSession, type SessionResult, type TenantSessionClient } from './tenantSessionClient';
import { invoiceDrafts as draftsClient, formatCents, type InvoiceDraftsClient, type StoreEntry } from './invoiceDraftsClient';
import {
  invoiceIssuing as issuingClient, issuingSettingsBody, rateDigits, rateText, sameSettingsValues, utcText,
  type InvoiceAmounts, type InvoiceIssuingClient, type InvoiceLine, type IssuedInvoice, type IssuedSummary, type IssuingSettings, type IssuingSettingsErrors,
  type IssuingSettingsFields, type SaveSettingsResult, type Seller, type SettingsValues,
} from './invoiceIssuingClient';
import { firebaseShopIdentity, type ShopIdentity } from './ServerCustomerLevels';
import { CHECK_CUTOFF_MS } from './ServerCustomerDirectory';
import { pickerWaitText } from './ServerCustomerPicker';
import { button, DialogFrame, focusRing, hintClass, inputClass, labelClass, quiet, storeLabel } from './ServerInvoiceDrafts';

const DEFAULT_WAIT_SECONDS = 60;

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
}

/** One section per signed-in user (keyed by UID): nothing a previous user's reads answer ever reaches it. */
export function ServerIssuedInvoices(props: ServerIssuedInvoicesProps) {
  if (props.uid === null) return null;
  return <IssuedSection key={props.uid} {...props} uid={props.uid} />;
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
/** The open issued-invoice dialog: which open it is, and what it reads. */
interface ViewOpen { readonly id: number; readonly storeId: string; readonly invoiceId: string }

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
  uid, session = tenantSession, issuing = issuingClient, drafts = draftsClient, identity = firebaseShopIdentity, now, wallNow, newKey,
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
  const seq = useRef({ stores: 0, settings: 0, list: 0 });
  const ctl = useRef<Record<'stores' | 'settings' | 'list', AbortController | null>>({ stores: null, settings: null, list: null });
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
  /** Close the issued-invoice dialog (its own read's late answer then finds nothing: it is unmounted). */
  const closeView = (): void => { viewRef.current = null; setViewState(null); };
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
    seq.current = { stores: seq.current.stores + 1, settings: seq.current.settings + 1, list: seq.current.list + 1 };
    busyBy.current += 1;
    setBusy(false);
  }

  /** A new generation: everything read under the previous token goes, and the stores are read again. */
  function begin(csrf: string): void {
    gen.current = { n: gen.current.n + 1, csrf };
    abortReads();
    clearWait();
    dropPanel();
    closeView();
    putList(LIST_IDLE);
    storeRef.current = '';
    setStoreIdState('');
    setChanged(true);
    void readStores();
  }
  /** Take a confirmed token: the first fixes the generation, the same changes nothing, another starts a new one (true). */
  function adopt(csrf: string): boolean {
    if (gen.current.csrf === csrf) return false;
    if (gen.current.csrf === null) { gen.current.csrf = csrf; return false; }
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
    gen.current = { n: gen.current.n + 1, csrf };
    abortReads();
    // What was read under the old token goes (DESIGN §2): the open invoice, and the list's pages and cursor — the store stays
    // chosen and the list says so, with Try again (page one under this token). Nothing is read on its own.
    closeView();
    const l = listRef.current;
    if (l.storeId !== '') putList({ ...listOf(gen.current.n, l.storeId), phase: 'unavailable', text: LIST_TEXT.renewed });
  }

  /** A refusal of the session clears every view (Reconnect then). */
  function failSession(failure: Failure): void {
    abortReads();
    setChanged(false);
    putStores({ phase: failure.kind, text: failure.text, stores: [] });
    storeRef.current = '';
    setStoreIdState('');
    closeView();
    putList(LIST_IDLE);
    dropPanel();
    if (failure.kind === 'signed-out') gen.current = { n: gen.current.n, csrf: null }; // the Reconnect's token is a FIRST token
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
  async function denialOf(stale: () => boolean): Promise<'denied' | Failure | null> {
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
      if (answer.kind === 'ok') return putStores({ phase: 'ready', text: answer.stores.length === 0 ? ISSUED_TEXT.noStores : '', stores: answer.stores });
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
    closeView();
    // The previous store's pages go (a read still out for it is cancelled; its late page finds another store).
    ctl.current.list?.abort();
    seq.current.list += 1;
    busyBy.current += 1;
    setBusy(false);
    storeRef.current = id;
    setStoreIdState(id);
    putList(listOf(gen.current.n, id));
    if (id === '') return;
    setChanged(false);
    // Choosing the store is the explicit action that reads its first page; during a wait nothing is read: the wait is said,
    // with Try again (given back once it has passed).
    if (waitRef.current) return putList({ ...listOf(gen.current.n, id), phase: 'rate-limited', text: pickerWaitText(waitLeft()) });
    void readList('first');
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
    const next: ViewOpen = { id: ++viewSeq.current, storeId: storeRef.current, invoiceId: row.id };
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
      const verdict = await denialOf(stale);
      if (verdict === null) return null;
      return verdict === 'denied' ? { kind: 'denied' } : verdict.kind === 'rate-limited' ? { kind: 'rate-limited', text: verdict.text } : { kind: 'unavailable' };
    }
    if (answer.kind === 'rate-limited') return { kind: 'rate-limited', text: pickerWaitText(startWait(answer.retryAfterSeconds)) };
    return { kind: 'unavailable' };
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
    const check = (): void => checkSession();
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
      if (waitTimer.current !== null) clearTimeout(waitTimer.current);
    };
    // A section serves one UID (see ServerIssuedInvoices); the clients are fixed for its life.
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
                              {' · '}<time data-testid="issued-row-issued" dateTime={row.issuedAt} className="whitespace-nowrap">{utcText(row.issuedAt)}</time>
                              {' · '}<span data-testid="issued-row-status">Issued</span>
                            </p>
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

export interface IssuedInvoiceDialogProps {
  readonly storeId: string;
  readonly invoiceId: string;
  /**
   * ONE read of the invoice under the owner's session and context — its session check, a 401, a 403's one fresh check, a
   * 429's wait — or null when the context that asked is gone. The dialog calls it once when it opens and on its own Try
   * again; never on a timer, a focus or a re-render.
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
}

type ViewState =
  | { readonly phase: 'loading' | 'not-found' | 'denied' | 'unavailable' | 'rate-limited'; readonly text: string; readonly invoice: null }
  | { readonly phase: 'ready'; readonly text: ''; readonly invoice: IssuedInvoice };
const VIEW_LOADING: ViewState = Object.freeze({ phase: 'loading', text: VIEW_TEXT.loading, invoice: null });
/** The first render: loading, with its status region in place but still empty — the loading text is then a change to it (announced). */
const VIEW_OPENING: ViewState = Object.freeze({ phase: 'loading', text: '', invoice: null });

/**
 * The issued invoice as the server recorded it (snapshot version 1): number, "Issued", the UTC issue time, the seller, the
 * customer, the ordered lines, Subtotal, the tax line — "Tax (8.875%)" and its amount, "Tax (0%)" for an explicit zero, or
 * exactly "No tax calculated" — and the Total. Text is shown as text, each value isolated (<bdi>); amounts never break
 * (whitespace-nowrap; text-sm below sm, SDB-23's rule) and the lines table scrolls sideways in its own named region. Laid
 * out from the top (anchor="top"): an answer that grows the dialog never moves Close, which has the first focus. Escape and
 * Close close it; focus goes back to the row's Open, or `returnFocus` when that row is gone.
 */
export function IssuedInvoiceDialog({ storeId, invoiceId, read, current, waiting, onClose, returnFocus }: IssuedInvoiceDialogProps) {
  const closeButton = useRef<HTMLButtonElement | null>(null);
  const [state, setState] = useState<ViewState>(VIEW_OPENING);
  const alive = useRef(false);
  const seq = useRef(0);
  const ctl = useRef<AbortController | null>(null);
  const owner = useRef({ read, current });
  useLayoutEffect(() => { owner.current = { read, current }; });

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

  useEffect(() => {
    alive.current = true;
    // The one read of this open. Closing cancels it; so does StrictMode's first unmount — before its session check has
    // answered, so the client sends nothing for it (an aborted signal never reaches fetch): one open, one GET.
    void load();
    return () => { alive.current = false; ctl.current?.abort(); };
    // One dialog per open: its store and invoice are fixed for its life.
  }, []);

  const invoice = state.invoice;
  return (
    <DialogFrame labelledBy="issued-view-title" testId="issued-view" anchor="top" busy={state.phase === 'loading'} onClose={onClose} initialFocus={closeButton} returnFocus={returnFocus}>
      <div className="flex items-start justify-between gap-3">
        <h2 id="issued-view-title" data-testid="issued-view-title" className="text-xl font-black text-primary tracking-tight break-words min-w-0">
          {invoice === null ? VIEW_TEXT.title : `Invoice ${invoice.number}`}
        </h2>
        <button ref={closeButton} type="button" data-testid="issued-view-close" onClick={onClose} className={quiet}>Close</button>
      </div>
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
            <dt className={labelClass}>Status</dt><dd data-testid="issued-view-status" className="font-bold text-slate-700">Issued</dd>
            <dt className={labelClass}>Issued at</dt>
            {/* The time may wrap at its spaces (never inside the date or the clock): at 320 px it is wider than its column (SIS-09). */}
            <dd className="font-bold text-slate-700 min-w-0"><time data-testid="issued-view-issued-at" dateTime={invoice.issuedAt}>{utcText(invoice.issuedAt)}</time></dd>
          </dl>
          <InvoiceSnapshot prefix="issued-view" seller={invoice.seller} customerName={invoice.customer.name} lines={invoice.lines} amounts={invoice.amounts} />
          <p data-testid="issued-view-note" className={hintClass}>{VIEW_TEXT.note}</p>
        </div>
      )}
    </DialogFrame>
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
              <th scope="col" className={labelClass}>#</th>
              <th scope="col" className={labelClass}>Description</th>
              <th scope="col" className={`${labelClass} text-right`}>Quantity</th>
              <th scope="col" className={`${labelClass} text-right`}>Unit price</th>
              <th scope="col" className={`${labelClass} text-right`}>Line total</th>
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
