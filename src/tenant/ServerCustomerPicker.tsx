// M7A-CUSTOMERS-P9 — choosing a customer saved on the tenant server for a draft (an invoice being created): a dialog over
// GET /api/v1/customers (page one, "Load more", search by name), and the draft's field that holds what was chosen. A
// reduced copy of the customer directory's LIST read path (ServerCustomerDirectory.tsx): the same session, generation,
// sequence and failure rules, nothing of its create or edit, and no route.
//
//   - Choosing a customer only puts a reference in the draft (customerReference.ts): the server's id and name, the user
//     and an opaque session context. Nothing is written anywhere — no request but reads leaves here, and nothing reaches
//     the local customer state, browser storage, a URL or a log. The server decides who may view; `canView` is the local
//     role state's hint, and a 403 is the answer that counts.
//   - `connect()` (the session client's `ensure`) runs before EVERY read, exactly as the directory's: plain, `fresh` only
//     for the one check after a 403, `reconnect` only from the dialog's Reconnect button. Opening the dialog is the same
//     connection the directory page makes on open; once a confirmed session has ENDED, only Reconnect signs in again.
//   - A GENERATION is one store connection as this dialog knows it: a counter and the session's CSRF token, in a ref. The
//     first token fixes it and is reported as a context (`onContext`); a later DIFFERENT token starts a new one — reads in
//     flight are cancelled, rows, cursor, applied query and search draft go, `onLost('changed')` is said, and page one is
//     read again. Token EQUALITY is the only witness of "same session, same store"; a list answer names no store.
//   - A read answer applies only under the generation that started it, as the latest read started, while the dialog is
//     mounted; anything else changes nothing. A choice is made only from a row the current generation read, by a click,
//     never automatically (not even for a single match), and it is bound to that generation's context.
//   - A refusal (a 401 or an ended session, a 403 the one check confirms for the same token) clears every row, the cursor
//     and the applied query — an ended session the search draft too — and says so to the draft (`onLost`), which drops a
//     chosen customer: a reference never outlives the session it was chosen under. An outage, a malformed answer or a
//     rate limit keeps the rows under the last-known label; a failure never says "no customers" or "no match".
//   - The session token is held in a ref only to compare it with the next one, and `sessionContextOf` keeps the latest
//     (UID, token) pair in module scope only to hand out one context per session — never React state, storage, a URL,
//     the DOM or a log (tenantSessionClient.ts lists the holders).

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { tenantSession, type SessionResult, type TenantSessionClient } from './tenantSessionClient';
import { customers as customersClient, normalizeCustomerSearch, type CustomerEntry, type CustomersClient } from './customersClient';
import { firebaseShopIdentity, type ShopIdentity } from './ServerCustomerLevels';
import { EMPTY_TEXT, LAST_KNOWN_TEXT, SEARCH_RULE_TEXT, searchMatchingText, searchNoneText } from './ServerCustomerDirectory';
import { serverCustomerReference, type ServerCustomerReference, type SessionContext } from './customerReference';

export const PICKER_TITLE_TEXT = 'Select a customer';
export const NOT_AVAILABLE_TEXT = "Server customers aren't available with your role or your store's plan.";
export const PICK_ENDED_TEXT =
  'Your server session ended, so the server customer was removed from this draft. Choose "Select a server customer", then Reconnect to select one again.';
export const PICK_CHANGED_TEXT =
  'The store connection changed, so the server customer was removed from this draft. Select the customer again.';
export const PICK_DENIED_TEXT = "You can't view the customers saved on the server, so the server customer was removed from this draft.";
/** Said beside a draft that holds a server customer: it cannot be created (yet), and how to create it here instead. */
export const SERVER_DRAFT_LIMIT_TEXT =
  "This draft uses a customer saved on the server. Creating an invoice for a server customer isn't available yet, so this draft can't be created. To create the invoice here, choose a customer from this browser's list instead.";
export const PICKER_TEXT = Object.freeze({
  loading: 'Loading customers from the server…',
  denied: 'This account may not view the customers saved on the server for this store.',
  ended: 'Your server session ended. Reconnect to see the customers saved on the server.',
  noIdentity: 'Sign in with your store account to see the customers saved on the server.',
  refused: 'The store server did not accept this sign-in. Reconnect, or sign out and sign in again.',
  unavailable: 'The customer directory is unavailable right now.',
  reloaded: 'The list changed on the server, so it was loaded again from the start.',
  connection: 'The store connection changed, so the list was loaded again.',
});
// Stays true once the wait is over (the text is still shown then): it says what to do, not when the controls come back.
export const pickerWaitText = (seconds: number): string => `Too many requests. Wait ${seconds} second${seconds === 1 ? '' : 's'}, then try again.`;
/** What tells two customers of the same name apart: the end of the server's id. */
export const idEndingText = (id: string): string => `ID ending ${id.slice(-8)}`;
const DEFAULT_WAIT_SECONDS = 60;

// The latest (UID, token) pair and the one context handed out for it: the only place a token sits beside a context.
// Forgotten when the draft's field unmounts (ServerCustomerField), so a pair outlives no sign-out in module scope.
let latest: { readonly uid: string; readonly csrf: string; readonly context: SessionContext } | null = null;

/**
 * The opaque context of the session whose token is `csrf`, for `uid`: the SAME frozen object as the last call for the
 * same pair, a new one otherwise. Only the latest pair is kept, so a context outlives its session only as an object
 * nothing will ever be handed again — a reference chosen under it compares unequal to every later session's.
 */
export function sessionContextOf(uid: string, csrf: string): SessionContext {
  if (latest === null || latest.uid !== uid || latest.csrf !== csrf) latest = { uid, csrf, context: Object.freeze({}) as SessionContext };
  return latest.context;
}

type Phase = 'loading' | 'ready' | 'denied' | 'signed-out' | 'rate-limited' | 'unavailable';
interface ListState {
  readonly gen: number; // the generation whose session answered these rows
  readonly phase: Phase;
  readonly text: string;
  readonly rows: readonly CustomerEntry[]; // in arrival order (the server's byte order); never re-sorted
  readonly next: string | null;
  readonly note: string;
  readonly query: string; // the applied search the rows and the cursor answer ('' for none)
}
/** A read or a session that did not answer with rows: the phase it puts the dialog in and what it says. */
interface Failure { readonly kind: 'denied' | 'signed-out' | 'rate-limited' | 'unavailable'; readonly text: string; readonly seconds?: number }

const initial = (gen: number, query = ''): ListState =>
  Object.freeze({ gen, phase: 'loading', text: PICKER_TEXT.loading, rows: [], next: null, note: '', query });
const UNAVAILABLE: Failure = Object.freeze({ kind: 'unavailable', text: PICKER_TEXT.unavailable });

function sessionFailure(s: Exclude<SessionResult, { kind: 'ok' }>): Failure {
  if (s.kind === 'no-identity') return { kind: 'signed-out', text: PICKER_TEXT.noIdentity };
  if (s.kind === 'refused') return { kind: 'signed-out', text: PICKER_TEXT.refused };
  if (s.kind === 'ended') return { kind: 'signed-out', text: PICKER_TEXT.ended };
  if (s.kind === 'rate-limited') return { kind: 'rate-limited', text: '', seconds: s.retryAfterSeconds ?? DEFAULT_WAIT_SECONDS };
  return UNAVAILABLE;
}

/** A list answer that is not a result (`ok` and `bad-cursor` are decided before this; malformed is `unavailable`). */
function readFailure(answer: { readonly kind: string; readonly retryAfterSeconds?: number }): Failure {
  if (answer.kind === 'rate-limited') return { kind: 'rate-limited', text: '', seconds: answer.retryAfterSeconds ?? DEFAULT_WAIT_SECONDS };
  if (answer.kind === 'denied') return { kind: 'denied', text: PICKER_TEXT.denied };
  if (answer.kind === 'signed-out') return { kind: 'signed-out', text: PICKER_TEXT.ended };
  return UNAVAILABLE;
}

const button = 'px-4 py-2 bg-primary text-white text-xs font-black uppercase tracking-widest rounded-xl disabled:opacity-50 disabled:cursor-not-allowed';
const quiet = 'px-4 py-2 bg-white text-primary border border-slate-300 text-xs font-black uppercase tracking-widest rounded-xl disabled:opacity-50 disabled:cursor-not-allowed';
const hintClass = 'text-[11px] font-medium text-slate-500';

export interface ServerCustomerPickerProps {
  /** The signed-in shop user's UID: the dialog serves this user only (a new UID is a new dialog). */
  readonly uid: string;
  /** A row the user chose, bound to this user and to the session it was read under. */
  readonly onSelect: (ref: ServerCustomerReference) => void;
  readonly onCancel: () => void;
  /** The session ended or was refused, the server refused the read, or the store connection changed. */
  readonly onLost: (why: 'ended' | 'denied' | 'changed') => void;
  /** The context of each session this dialog fixes a generation on (the first, and each new one). */
  readonly onContext: (context: SessionContext) => void;
  readonly session?: TenantSessionClient;
  readonly customers?: CustomersClient;
  readonly identity?: Pick<ShopIdentity, 'idToken'>;
  /** A monotonic clock in milliseconds (default `performance.now()`). */
  readonly now?: () => number;
}

/** One dialog per signed-in user (keyed by UID): nothing a previous user's reads answer ever reaches it. */
export function ServerCustomerPicker(props: ServerCustomerPickerProps) {
  return <PickerDialog key={props.uid} {...props} />;
}

function PickerDialog({
  uid, onSelect, onCancel, onLost, onContext, session = tenantSession, customers = customersClient, identity = firebaseShopIdentity, now,
}: ServerCustomerPickerProps) {
  const [list, setList] = useState<ListState>(() => initial(0));
  const [busy, setBusyState] = useState(false); // a read or a session check is out: Select waits for its answer
  const [wait, setWait] = useState<number | null>(null); // the seconds a rate limit asked for, while that wait runs
  const [draft, setDraft] = useState(''); // the search box's text; the APPLIED query is the list's own
  const [refused, setRefused] = useState(false); // the draft last applied is one the server would refuse
  const [changed, setChanged] = useState(false);

  const gen = useRef<{ n: number; csrf: string | null }>({ n: 0, csrf: null }); // the token never leaves refs
  const alive = useRef(false);
  const listRef = useRef<ListState>(list);
  const seq = useRef(0); // the start order of reads
  const ctl = useRef<AbortController | null>(null);
  const waitRef = useRef(false);
  const waitUntil = useRef(0); // the monotonic deadline of the running wait
  const waitTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const busyRef = useRef(false);
  const checkLater = useRef(false); // a return to the tab came while a read or check was out: check when it settles
  const searchInput = useRef<HTMLInputElement | null>(null);
  const dialog = useRef<HTMLDivElement | null>(null);
  // The caller's latest callbacks: an answer that arrives after a re-render reports to the draft as it is now.
  const events = useRef({ onSelect, onCancel, onLost, onContext });
  useLayoutEffect(() => { events.current = { onSelect, onCancel, onLost, onContext }; });

  const clock = (): number => (now ?? (() => performance.now()))();
  /** The session: plain (never signs in after an end), `fresh` (the check after a 403) or `reconnect` (the user's click). */
  const connect = (mode?: 'fresh' | 'reconnect'): Promise<SessionResult> =>
    session.ensure(uid, () => identity.idToken(uid), mode === 'fresh' ? { fresh: true } : mode === 'reconnect' ? { reconnect: true } : undefined);
  const put = (next: ListState): void => { listRef.current = next; setList(next); };
  const setBusy = (next: boolean): void => { busyRef.current = next; setBusyState(next); };

  /** End a rate limit's wait early: only a new generation does (its page one must not stay 'loading' behind the wait). */
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

  /** A new generation: whatever this one read is gone, the draft is told, and page one is read under the new token. */
  function begin(csrf: string): void {
    gen.current = { n: gen.current.n + 1, csrf };
    ctl.current?.abort();
    clearWait(); // the wait was the other session's; this one's page one is read now (the directory's begin does the same)
    setDraft(''); // typed for the other connection (possibly another store)
    setRefused(false);
    setChanged(true);
    put(initial(gen.current.n));
    events.current.onContext(sessionContextOf(uid, csrf));
    events.current.onLost('changed');
    void read('first');
  }

  /** Take a confirmed token: the first fixes the generation, the same changes nothing, another starts a new one (true). */
  function adopt(csrf: string): boolean {
    if (gen.current.csrf === csrf) return false;
    if (gen.current.csrf === null) {
      gen.current.csrf = csrf;
      events.current.onContext(sessionContextOf(uid, csrf));
      return false;
    }
    begin(csrf);
    return true;
  }

  /** A refusal shows nothing of the server's and tells the draft; anything else keeps this generation's rows as last known. */
  function fail(raw: Failure): void {
    const failure = raw.seconds === undefined ? raw : { ...raw, text: pickerWaitText(startWait(raw.seconds)) };
    if (failure.kind === 'denied' || failure.kind === 'signed-out') {
      put({ ...initial(gen.current.n), phase: failure.kind, text: failure.text });
      if (failure.kind === 'signed-out') {
        setDraft(''); // an ended session takes the search text too
        setRefused(false);
        setChanged(false);
        // Nothing is fixed after a confirmed end (`n` stays, so its late answers stay stale): the Reconnect's token is a
        // FIRST token (onContext only), not a "connection changed" generation after the user's own click.
        gen.current = { n: gen.current.n, csrf: null };
      }
      events.current.onLost(failure.kind === 'signed-out' ? 'ended' : 'denied');
      return;
    }
    put({ ...listRef.current, phase: failure.kind, text: failure.text, note: '' });
  }

  /**
   * After a read refused 403: the server says the same to a read whose cookie is another session's (another tab signed
   * in), so ONE fresh session check tells them apart — another token starts a new generation (the caller is then stale),
   * a failed check is returned, and the same token leaves the refusal standing (null).
   */
  async function recheck(): Promise<Failure | null> {
    const s = await connect('fresh');
    if (s.kind !== 'ok') return sessionFailure(s);
    if (alive.current) adopt(s.csrf);
    return null;
  }

  /**
   * Page one (`first`) or the page after the last shown (`more`), of the applied search. Rows are appended in arrival
   * order, once per id. `reconnect` only from the Reconnect button: the one read that may sign in again after an end.
   */
  async function read(mode: 'first' | 'more', note = '', reconnect = false): Promise<void> {
    const cursor = mode === 'more' ? listRef.current.next : null;
    const query = listRef.current.query;
    if ((mode === 'more' && cursor === null) || waitRef.current) return; // no read during a rate limit's wait
    const mine = gen.current.n;
    const n = ++seq.current;
    ctl.current?.abort(); // a superseded read is cancelled
    const controller = new AbortController();
    ctl.current = controller;
    const stale = (): boolean => !alive.current || mine !== gen.current.n || n !== seq.current;
    setBusy(true);
    if (mode === 'first') put({ ...listRef.current, phase: 'loading', text: PICKER_TEXT.loading, note });
    try {
      const s = await connect(reconnect ? 'reconnect' : undefined);
      if (stale()) return;
      if (s.kind !== 'ok') return fail(sessionFailure(s));
      if (adopt(s.csrf)) return; // a new generation has started its own read
      const answer = await customers.list(cursor, s.csrf, controller.signal, query);
      if (stale()) return;
      if (answer.kind === 'ok') {
        const was = listRef.current;
        const shown = new Set(mode === 'more' ? was.rows.map((row) => row.id) : []);
        const fresh = answer.customers.filter((row) => !shown.has(row.id) && shown.add(row.id) !== undefined);
        return put({
          gen: mine, phase: 'ready', text: '', rows: mode === 'more' ? [...was.rows, ...fresh] : fresh, next: answer.nextCursor,
          note: mode === 'more' ? '' : was.note, query,
        });
      }
      // A continuation that no longer names a customer of this store: ONE reload from page one (which has no cursor).
      if (answer.kind === 'bad-cursor') return mode === 'more' ? void read('first', PICKER_TEXT.reloaded) : fail(UNAVAILABLE);
      if (answer.kind === 'denied') {
        const again = await recheck();
        if (stale()) return;
        if (again !== null && (again.kind === 'denied' || again.kind === 'signed-out')) return fail(again);
        if (again?.seconds !== undefined) startWait(again.seconds); // an undecided check: its wait runs, the refusal stands
      }
      fail(readFailure(answer));
    } finally {
      if (!stale()) {
        setBusy(false);
        // A return to the tab while this read was out: its rows may already be another session's, so check now.
        if (checkLater.current) { checkLater.current = false; checkSession(); }
      }
    }
  }

  /**
   * A changed session is noticed without a click, as on the directory page: on a return to the tab, ONE plain check
   * (it never signs in) once a token is fixed and while the dialog is not signed out (only Reconnect reads then). Select
   * waits for it. A return while a read is out is checked when that read settles, so no row it brings is selectable
   * unchecked. Another token starts a new generation; a definite end clears the dialog; an undecided answer (outage,
   * rate limit) keeps the rows and starts no wait. An answer after a read began, a new generation or the unmount
   * changes nothing.
   */
  function checkSession(): void {
    if (document.visibilityState === 'hidden' || gen.current.csrf === null) return;
    if (busyRef.current) { checkLater.current = true; return; }
    if (listRef.current.phase === 'signed-out') return;
    const mine = gen.current.n;
    const n = seq.current;
    setBusy(true);
    void connect().then((s) => {
      if (!alive.current || mine !== gen.current.n || n !== seq.current) return;
      setBusy(false);
      if (s.kind === 'ok' ? adopt(s.csrf) : s.kind === 'ended' || s.kind === 'refused' || s.kind === 'no-identity') {
        if (s.kind !== 'ok') fail(sessionFailure(s));
        checkLater.current = false; // the new generation's read, or the cleared dialog, answers for that later return
        return;
      }
      if (checkLater.current) { checkLater.current = false; checkSession(); } // another return came during this check
    });
  }

  /** Apply the search draft: normalized, '' for none; a text the server would refuse is said and nothing is sent. */
  function applySearch(raw: string): void {
    if (waitRef.current || listRef.current.phase === 'signed-out') return; // only Reconnect reads after an end
    const query = normalizeCustomerSearch(raw);
    if (query === null) {
      setRefused(true);
      searchInput.current?.focus();
      return;
    }
    setRefused(false);
    put(initial(gen.current.n, query)); // the previous query's rows and cursor go
    void read('first');
  }
  function clearSearch(): void {
    if (waitRef.current || listRef.current.phase === 'signed-out') return;
    setDraft('');
    applySearch('');
    searchInput.current?.focus();
  }

  /** A click on a row this generation read, while the dialog is mounted: the reference, bound to this session. */
  function select(row: CustomerEntry): void {
    const shown = listRef.current;
    const csrf = gen.current.csrf;
    if (!alive.current || csrf === null || shown.gen !== gen.current.n || !shown.rows.includes(row)) return;
    const ref = serverCustomerReference(row, uid, sessionContextOf(uid, csrf));
    if (ref !== null) events.current.onSelect(ref);
  }

  // "This dialog is gone" flips during the commit that removes it, not in the passive cleanup that runs after it.
  useLayoutEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  useEffect(() => {
    searchInput.current?.focus();
    void read('first');
    const check = (): void => checkSession();
    window.addEventListener('focus', check);
    document.addEventListener('visibilitychange', check);
    return () => {
      window.removeEventListener('focus', check);
      document.removeEventListener('visibilitychange', check);
      gen.current = { n: gen.current.n + 1, csrf: null };
      ctl.current?.abort();
      if (waitTimer.current !== null) clearTimeout(waitTimer.current);
    };
    // A dialog serves one UID (see ServerCustomerPicker); the clients are fixed for its life.
  }, []);

  // Focus never falls out of the dialog: a focused control that goes away (Try again or Reconnect after an answer, Load
  // more on the last page) or is disabled (Search during a wait — the browser then moves focus to <body>) leaves it on
  // <body>; the search box takes it back. Not a full focus trap (Tab can still leave): only a loss the dialog caused.
  useEffect(() => {
    if (dialog.current !== null && !dialog.current.contains(document.activeElement)) searchInput.current?.focus();
  }, [list, busy, wait]);

  const waiting = wait !== null;
  const signedOut = list.phase === 'signed-out';
  const canSearch = !waiting && !signedOut;
  const hint = waiting ? `Wait ${wait} second${wait === 1 ? '' : 's'}.` : signedOut ? 'Reconnect to search.' : '';
  const lastKnown = (list.phase === 'unavailable' || list.phase === 'rate-limited') && list.rows.length > 0;

  return createPortal(
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-slate-900/40">
      <div
        ref={dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby="picker-title"
        aria-busy={busy}
        data-testid="picker-dialog"
        onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); events.current.onCancel(); } }}
        className="w-full max-w-lg max-h-[90vh] overflow-y-auto bg-white rounded-3xl border border-slate-200 shadow-2xl p-6 space-y-3"
      >
        <div className="flex items-start justify-between gap-3">
          <h2 id="picker-title" className="text-xl font-black text-primary tracking-tight">{PICKER_TITLE_TEXT}</h2>
          <button type="button" data-testid="picker-cancel" onClick={() => events.current.onCancel()} className={quiet}>Cancel</button>
        </div>
        <p className="text-sm font-medium text-slate-600">Customers saved on the server for this store. Choosing one only adds it to this draft.</p>
        {changed && <p data-testid="picker-connection-changed" role="alert" className="text-sm font-bold text-amber-800">{PICKER_TEXT.connection}</p>}

        <form role="search" noValidate data-testid="picker-search" onSubmit={(e) => { e.preventDefault(); applySearch(draft); }} className="space-y-1">
          <label htmlFor="picker-search-input" className="block text-[10px] font-black text-slate-500 uppercase tracking-widest">Search customers by name</label>
          <div className="flex flex-wrap items-center gap-3">
            <input
              ref={searchInput}
              id="picker-search-input"
              data-testid="picker-search-input"
              type="search"
              autoComplete="off"
              value={draft}
              aria-invalid={refused}
              aria-describedby={refused ? 'picker-search-error' : undefined}
              onChange={(e) => { setDraft(e.target.value); setRefused(false); }}
              className="flex-1 min-w-[10rem] text-sm px-3 py-2 rounded-lg border border-slate-300 bg-white"
            />
            <button type="submit" data-testid="picker-search-submit" disabled={!canSearch} aria-describedby="picker-search-hint" className={button}>Search</button>
            <button type="button" data-testid="picker-search-clear" disabled={!canSearch || (draft === '' && list.query === '')} onClick={clearSearch} className={quiet}>Clear</button>
            <span id="picker-search-hint" data-testid="picker-search-hint" className={hintClass}>{hint}</span>
          </div>
          {refused && <p id="picker-search-error" data-testid="picker-search-error" role="alert" className="text-xs font-bold text-rose-700">{SEARCH_RULE_TEXT}</p>}
        </form>

        <p data-testid="picker-state" data-phase={list.phase} role={list.phase === 'denied' ? 'alert' : 'status'} className="text-sm font-bold text-slate-600 min-h-[1rem]">
          {list.text}
          {list.query !== '' && list.rows.length > 0 && <span data-testid="picker-search-summary" className="block font-medium text-slate-700 break-words">{searchMatchingText(list.query)}</span>}
          {lastKnown && <span data-testid="picker-last-known" className="block text-xs font-black uppercase tracking-widest text-amber-800">{LAST_KNOWN_TEXT}</span>}
          {list.phase === 'ready' && list.rows.length === 0 && (list.query === ''
            ? <span data-testid="picker-empty" className="block font-medium text-slate-600">{EMPTY_TEXT}</span>
            : <span data-testid="picker-search-none" className="block font-medium text-slate-600 break-words">{searchNoneText(list.query)}</span>)}
        </p>
        {list.note !== '' && <p data-testid="picker-note" role="status" className="text-sm font-bold text-amber-800">{list.note}</p>}
        {(list.phase === 'unavailable' || list.phase === 'rate-limited' || list.phase === 'denied' || signedOut) && (
          <button type="button" data-testid="picker-retry" disabled={busy || waiting} aria-describedby="picker-search-hint" onClick={() => { void read('first', '', signedOut); }} className={button}>
            {signedOut ? 'Reconnect' : 'Try again'}
          </button>
        )}

        {list.rows.length > 0 && (
          <ul data-testid="picker-list" className="divide-y divide-slate-100 border border-slate-100 rounded-2xl">
            {list.rows.map((row) => (
              <li key={row.id} data-testid="picker-row" data-id={row.id} className="flex items-center justify-between gap-3 px-4 py-3">
                <div className="min-w-0">
                  <p className="text-sm font-bold text-primary break-words">{row.name}</p>
                  <p id={`picker-row-${row.id}`} className={hintClass}>{idEndingText(row.id)}</p>
                </div>
                <button
                  type="button"
                  data-testid="picker-select"
                  aria-label={`Select ${row.name}`}
                  aria-describedby={`picker-row-${row.id}`}
                  disabled={busy}
                  onClick={() => select(row)}
                  className={quiet}
                >
                  Select
                </button>
              </li>
            ))}
          </ul>
        )}
        {list.phase === 'ready' && list.next !== null && (
          <button type="button" data-testid="picker-load-more" disabled={busy || waiting} onClick={() => { void read('more'); }} className={quiet}>Load more</button>
        )}
      </div>
    </div>,
    document.body,
  );
}

const NOTICE = Object.freeze({ ended: PICK_ENDED_TEXT, changed: PICK_CHANGED_TEXT, denied: PICK_DENIED_TEXT });

export interface ServerCustomerFieldProps extends Pick<ServerCustomerPickerProps, 'session' | 'customers' | 'identity' | 'now'> {
  /** The signed-in shop user's UID, or null when nobody is signed in. */
  readonly uid: string | null;
  /** The draft's server customer, or null. A reference chosen by another user is never shown. */
  readonly value: ServerCustomerReference | null;
  /** The local role state's hint that this user may view customers. The server decides. */
  readonly canView: boolean;
  readonly onChange: (next: ServerCustomerReference | null, why: 'selected' | 'removed' | 'ended' | 'denied' | 'changed') => void;
}

/**
 * The draft's server-customer control: an entry point, the chosen customer (unmistakably the server's), and the dialog.
 * A reference is dropped — with a notice — as soon as the session it was chosen under is known to be over: the dialog
 * says so (`onLost`, or a first context that is not the reference's), and while the dialog is closed a window focus or
 * a return to the tab checks the session once (plain: it never signs in). An undecided check keeps it.
 */
export function ServerCustomerField({ uid, value, canView, onChange, ...inject }: ServerCustomerFieldProps) {
  const session = inject.session ?? tenantSession;
  const identity = inject.identity ?? firebaseShopIdentity;
  const shown = uid !== null && canView && value !== null && value.uid === uid ? value : null;
  const [openFor, setOpenFor] = useState<string | null>(null); // the UID the dialog was opened for
  // Open only for that user and while they may view: a user switch or lost access closes it in the same render.
  const open = openFor !== null && openFor === uid && canView;
  const [notice, setNotice] = useState<keyof typeof NOTICE | null>(null);
  const held = useRef(shown); // the reference as shown last, until this field drops it
  const change = useRef(onChange); // the caller's latest: it re-checks what it needs at call time
  const focusEntry = useRef(false);
  const selectButton = useRef<HTMLButtonElement | null>(null);
  const changeButton = useRef<HTMLButtonElement | null>(null);
  useLayoutEffect(() => { held.current = shown; change.current = onChange; });
  // The module's (UID, token) pair goes with the field: contexts stay stable while it is mounted, none outlives it.
  useEffect(() => () => { latest = null; }, []);

  /** Drop the held reference once, whichever report comes first, and say why. */
  const drop = (why: keyof typeof NOTICE): void => {
    if (held.current === null) return;
    held.current = null;
    setNotice(why);
    change.current(null, why);
  };
  const close = (): void => { setOpenFor(null); focusEntry.current = true; };

  // Closed by a user switch or lost access (unmounted, so nothing it was reading reaches the draft): it stays closed.
  useEffect(() => { if (openFor !== null && !open) setOpenFor(null); }, [openFor, open]);

  // Focus goes back to the control that stands for the draft's customer now: Change, or "Select a server customer".
  useEffect(() => {
    if (!focusEntry.current || open) return;
    focusEntry.current = false;
    (shown !== null ? changeButton : selectButton).current?.focus();
  });

  useEffect(() => {
    if (uid === null || shown === null || open) return;
    let current = true; // off once this listener goes: a late answer then changes nothing
    const check = (): void => {
      if (document.visibilityState === 'hidden') return;
      void session.ensure(uid, () => identity.idToken(uid)).then((s) => {
        if (!current || held.current !== shown) return;
        if (s.kind === 'ok') { if (sessionContextOf(uid, s.csrf) !== shown.context) drop('changed'); }
        else if (s.kind === 'ended' || s.kind === 'refused' || s.kind === 'no-identity') drop('ended'); // definitely gone
      });
    };
    window.addEventListener('focus', check);
    document.addEventListener('visibilitychange', check);
    return () => {
      current = false;
      window.removeEventListener('focus', check);
      document.removeEventListener('visibilitychange', check);
    };
  }, [uid, shown, open, session, identity]);

  if (uid === null) return null;
  if (!canView) return <p data-testid="picker-unavailable" className={hintClass}>{NOT_AVAILABLE_TEXT}</p>;
  return (
    <div data-testid="picker-field" className="space-y-2">
      {shown === null ? (
        <button ref={selectButton} type="button" data-testid="picker-open" onClick={() => setOpenFor(uid)} className={quiet}>Select a server customer</button>
      ) : (
        <div data-testid="picker-value" data-id={shown.id} className="p-4 rounded-2xl border border-sky-200 bg-sky-50 space-y-2">
          <span data-testid="picker-value-badge" className="inline-block px-2 py-0.5 rounded-full bg-sky-100 text-sky-900 text-[10px] font-black uppercase tracking-widest">Server customer</span>
          <p data-testid="picker-value-name" className="text-sm font-bold text-primary break-words">{shown.name}</p>
          <p className={hintClass}>{idEndingText(shown.id)}</p>
          <div className="flex flex-wrap gap-3">
            <button ref={changeButton} type="button" data-testid="picker-change" onClick={() => setOpenFor(uid)} className={quiet}>Change</button>
            <button
              type="button"
              data-testid="picker-remove"
              onClick={() => { held.current = null; setNotice(null); focusEntry.current = true; change.current(null, 'removed'); }}
              className={quiet}
            >
              Remove
            </button>
          </div>
        </div>
      )}
      {notice !== null && <p data-testid="picker-notice" role="alert" className="text-sm font-bold text-amber-800">{NOTICE[notice]}</p>}
      {open && (
        <ServerCustomerPicker
          uid={uid}
          {...inject}
          onSelect={(ref) => { close(); setNotice(null); change.current(ref, 'selected'); }}
          onCancel={close}
          onLost={drop}
          onContext={(context) => { if (held.current !== null && held.current.context !== context) drop('changed'); }}
        />
      )}
    </div>
  );
}
