// M7A-CUSTOMERS-P5 — the shop's server-backed Customer directory: the customers the tenant server holds for this store,
// read from GET /api/v1/customers (cursor pages) and GET /api/v1/customers/{id}, and added through the idempotent
// POST /api/v1/customers. Only an id and a name exist on the server; the Customers screen's contact, loyalty and history
// data stays in this browser and is not linked to these records.
//
//   - The server decides everything: who may view or add, which store this is, what a valid name is, what was stored.
//     `canCreate` is a hint from the local role state; a 403 is the answer that counts. Nothing here names a tenant,
//     store, role or actor.
//   - Server rows live in this page's own state and nowhere else: never in the local customer state, browser storage,
//     a URL query or a log. A detail shows its own answer, never a list row.
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

import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useAccess } from '../context/AccessContext';
import { tenantSession, type SessionResult, type TenantSessionClient } from './tenantSessionClient';
import {
  customers as customersClient, isCustomerId, normalizeCustomerName, type CreateResult, type CustomerEntry, type CustomersClient,
} from './customersClient';
import { firebaseShopIdentity, type ShopIdentity } from './ServerCustomerLevels';

export const DIRECTORY_PATH = '/customers/directory';
/** No "Check again" from here on: a conservative client cutoff under the server's 24-hour key retention. */
export const CHECK_CUTOFF_MS = 23 * 60 * 60_000;
const DEFAULT_WAIT_SECONDS = 60;

export const EMPTY_TEXT = 'No customers are saved on the server for this store yet.';
export const NOT_FOUND_TEXT = 'No customer with this address is available in this store.';
export const CONNECTION_CHANGED_TEXT = 'The store connection changed. Check the list, then add again.';
export const LAST_KNOWN_TEXT = 'Last known list — could not refresh';
export const savedEarlierText = (name: string): string => `"${name}" was saved on the server under the earlier connection.`;
export const STOP_WARNING_TEXT =
  'Stop tracking does not cancel the request, and adding the same name again can create a second customer.';
export const NAME_RULE_TEXT = 'Enter a name of 1 to 200 characters, without control or text-direction characters.';
export const unresolvedText = (name: string): string => `Not confirmed yet: "${name}". The server may have saved it.`;
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
  invalid: 'The server did not accept this name. Nothing was added.',
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

/** A create whose outcome is not known yet: exactly what a check must send again, and the connection it belongs to. */
export interface HeldCreate {
  readonly key: string;
  /** The exact request body string: `JSON.stringify({ name })`, never rebuilt. */
  readonly body: string;
  /** The normalized name that was sent. */
  readonly name: string;
  /** The session token it was sent with; null once detached (the page's connection changed since). */
  readonly csrf: string | null;
  /** A monotonic reading taken when it was sent. */
  readonly sentAt: number;
  readonly state: 'sending' | 'unresolved' | 'checking';
}

/** What a create that settled after its page had gone ended as; kept until a mounted page shows it. */
export type HoldOutcome =
  | { readonly kind: 'saved'; readonly customer: CustomerEntry; /** The token the attempt was sent with; null once detached. */ readonly csrf: string | null }
  | { readonly kind: 'refused'; readonly name: string };

/** What React sees of an attempt: everything but the session token, frozen and stable between store changes. */
interface HeldView {
  readonly key: string;
  readonly name: string;
  readonly state: HeldCreate['state'];
  readonly sentAt: number;
  readonly detached: boolean;
}
const views = new WeakMap<HeldCreate, HeldView>();
function viewOf(held: HeldCreate | undefined): HeldView | undefined {
  if (held === undefined) return undefined;
  let view = views.get(held);
  if (view === undefined) {
    view = Object.freeze({ key: held.key, name: held.name, state: held.state, sentAt: held.sentAt, detached: held.csrf === null });
    views.set(held, view);
  }
  return view;
}

/** At most one held create per user, in memory only. */
export interface HoldStore {
  get(uid: string): HeldCreate | undefined;
  /** Hold `attempt` for `uid`; false (and nothing held) when that user already has one. */
  put(uid: string, attempt: HeldCreate): boolean;
  /** Change the attempt under `key`; false when the store's attempt is another (a stale continuation is a no-op). */
  change(uid: string, key: string, next: Partial<Pick<HeldCreate, 'csrf' | 'state'>>): boolean;
  remove(uid: string, key: string): boolean;
  /** Remove the attempt under `key` and record its terminal `outcome` (one per user; a newer one replaces it). */
  finish(uid: string, key: string, outcome: HoldOutcome): boolean;
  /** The recorded outcome, forgotten as it is returned. */
  takeOutcome(uid: string): HoldOutcome | undefined;
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
    change(uid: string, key: string, next: Partial<Pick<HeldCreate, 'csrf' | 'state'>>): boolean {
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
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  });
}

/** The shop's one hold store: it outlives the page across in-app navigation, and ends with the page load. */
const holdStore: HoldStore = createHoldStore();

type ListPhase = 'loading' | 'ready' | 'denied' | 'signed-out' | 'rate-limited' | 'unavailable';
type DetailPhase = ListPhase | 'not-found';
interface ListState {
  readonly phase: ListPhase;
  readonly text: string;
  readonly rows: readonly CustomerEntry[]; // in arrival order (the server's byte order); never re-sorted
  readonly next: string | null;
  readonly note: string;
}
interface DetailState {
  readonly id: string | null;
  readonly phase: DetailPhase;
  readonly text: string;
  readonly customer: CustomerEntry | null; // this id's own answer in this generation
}
/** A read or a session that did not answer with rows: the phase it puts the page in and what it says. */
interface Failure { readonly kind: 'denied' | 'signed-out' | 'rate-limited' | 'unavailable'; readonly text: string; readonly seconds?: number }

const LIST_INITIAL: ListState = Object.freeze({ phase: 'loading', text: TEXT.loading, rows: [], next: null, note: '' });
const DETAIL_NONE: DetailState = Object.freeze({ id: null, phase: 'loading', text: '', customer: null });

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
  readonly session?: TenantSessionClient;
  readonly customers?: CustomersClient;
  readonly identity?: Pick<ShopIdentity, 'idToken'>;
  readonly holds?: HoldStore;
  readonly newKey?: () => string;
  /** A monotonic clock in milliseconds (default `performance.now()`). */
  readonly now?: () => number;
}

/** The routed page: the address's id, the signed-in user and the local create hint; everything else is the server's. */
export function CustomerDirectoryPage(inject: Omit<ServerCustomerDirectoryProps, 'uid' | 'routeId' | 'canCreate'>) {
  const { id } = useParams();
  const access = useAccess();
  return (
    <ServerCustomerDirectory
      {...inject}
      uid={access.session?.user.id ?? null}
      routeId={id ?? null}
      canCreate={access.hasPermission('customers')}
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
  uid, routeId, canCreate, session = tenantSession, customers = customersClient, identity = firebaseShopIdentity,
  holds = holdStore, newKey, now,
}: ServerCustomerDirectoryProps) {
  const [list, setList] = useState<ListState>(LIST_INITIAL);
  const [listBusy, setListBusy] = useState(false);
  const [detail, setDetail] = useState<DetailState>(DETAIL_NONE);
  const [draft, setDraft] = useState('');
  const [nameError, setNameError] = useState('');
  const [createStatus, setCreateStatus] = useState<{ readonly refusal: boolean; readonly text: string; readonly named?: true } | null>(null);
  const [saved, setSaved] = useState<CustomerEntry | { readonly earlier: string } | null>(null);
  const [connectionChanged, setConnectionChanged] = useState(false);
  const [wait, setWait] = useState<number | null>(null); // the seconds a rate limit asked for, while that wait runs
  const [adding, setAdding] = useState(false);
  const [holdNote, setHoldNote] = useState<{ readonly key: string; readonly text: string } | null>(null);
  const [, setTick] = useState(0);
  const attempt = useSyncExternalStore(holds.subscribe, () => (uid === null ? undefined : viewOf(holds.get(uid)))); // token-free

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
  const focusSaved = useRef(false);
  routeRef.current = routeId;

  const clock = (): number => (now ?? (() => performance.now()))();
  const nextKey = (): string => (newKey ?? (() => crypto.randomUUID()))(); // one fresh Idempotency-Key per new attempt
  /** The session for `who`: plain (never signs in after an end), `fresh` (the check after a 403) or `reconnect` (the user's click). */
  const connect = (who: string, mode?: 'fresh' | 'reconnect'): Promise<SessionResult> =>
    session.ensure(who, () => identity.idToken(who), mode === 'fresh' ? { fresh: true } : mode === 'reconnect' ? { reconnect: true } : undefined);
  const putList = (next: ListState): void => { listRef.current = next; setList(next); };
  const putDetail = (next: DetailState): void => { detailRef.current = next; setDetail(next); };

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
  };

  /**
   * Take a confirmed session token. The first one fixes this generation; the same one changes nothing; a different one
   * starts a new generation (true): whatever the caller was about to do under the old one must not happen.
   */
  function adopt(who: string, csrf: string): boolean {
    if (gen.current.csrf === csrf) return false;
    if (gen.current.csrf === null) {
      gen.current.csrf = csrf;
      detach(who, csrf);
      consumeOutcome();
      return false;
    }
    begin(csrf, false);
    consumeOutcome();
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
      putList({ phase: failure.kind as 'denied' | 'signed-out', text: failure.text, rows: [], next: null, note: '' });
    }
    if (!spareDetail) {
      detailSeq.current += 1;
      detailCtl.current?.abort();
      const id = routeRef.current;
      if (id === null) putDetail(DETAIL_NONE); // no customer is shown: nothing to stamp
      else if (isCustomerId(id)) putDetail({ id, phase: failure.kind as 'denied' | 'signed-out', text: failure.text, customer: null });
    }
    // Signed out: no notice of a save or of a settled create stays either (they name a customer of a session that is
    // gone). The hold note and every other create status stay: Add, Check again and a refused send write theirs.
    if (ended) {
      setSaved(null);
      setCreateStatus((status) => (status?.named === true ? null : status));
    }
  }
  const isRefusal = (failure: Failure): boolean => failure.kind === 'denied' || failure.kind === 'signed-out';

  /** Show what a create that settled after its page had gone ended as — once this page holds a session token. */
  function consumeOutcome(): void {
    if (uid === null || !alive.current || gen.current.csrf === null) return;
    const outcome = holds.takeOutcome(uid);
    if (outcome === undefined) return;
    if (outcome.kind === 'refused') return setCreateStatus({ refusal: true, text: `"${outcome.name}" was not added: the server refused that request.`, named: true });
    confirmed(outcome.customer, outcome.csrf === gen.current.csrf, false); // the user may be typing: no focus move
  }

  /** A validated 201 naming the name sent: the notice, the draft only when it still is that name, and page one again. */
  function confirmed(customer: CustomerEntry, here: boolean, focus: boolean): void {
    setHoldNote(null);
    setDraft((d) => (normalizeCustomerName(d) === customer.name ? '' : d));
    setCreateStatus(null);
    if (here) {
      setNameError('');
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
    const s = await connect(who, 'fresh'); // a session read sent AFTER the 403, never one already in flight before it
    if (s.kind !== 'ok') return sessionFailure(s);
    if (alive.current) adopt(who, s.csrf);
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
    if (mode === 'more' && cursor === null) return;
    if (waitRef.current) { // no read starts during a rate limit's wait; a page-one read runs when it ends
      if (mode === 'first') reloadAfterWait.current = { note };
      return;
    }
    const mine = gen.current.n;
    const seq = ++listSeq.current;
    listCtl.current?.abort(); // a superseded read is cancelled
    const controller = new AbortController();
    listCtl.current = controller;
    const stale = (): boolean => mine !== gen.current.n || seq !== listSeq.current;
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
      const answer = await customers.list(cursor, s.csrf, controller.signal);
      if (stale()) return;
      if (answer.kind === 'ok') {
        const was = listRef.current;
        const shown = new Set(mode === 'more' ? was.rows.map((row) => row.id) : []);
        const fresh = answer.customers.filter((row) => !shown.has(row.id) && shown.add(row.id) !== undefined);
        return putList({
          phase: 'ready', text: '', rows: mode === 'more' ? [...was.rows, ...fresh] : fresh, next: answer.nextCursor,
          note: mode === 'more' ? '' : was.note,
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

  function failDetail(id: string, raw: Failure, shown: CustomerEntry | null): void {
    const failure = withWait(raw);
    if (isRefusal(failure)) return clearBoth(failure);
    // An answer already shown for this id in this generation may stay, as last known, when the server cannot be asked.
    putDetail({ id, phase: failure.kind, text: failure.text, customer: shown });
  }

  /** `reconnect` only from the detail's Reconnect button, as for the list. */
  async function loadDetail(id: string, reconnect = false): Promise<void> {
    const mine = gen.current.n;
    const seq = ++detailSeq.current;
    detailCtl.current?.abort();
    const controller = new AbortController();
    detailCtl.current = controller;
    const stale = (): boolean => mine !== gen.current.n || seq !== detailSeq.current || id !== routeRef.current;
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
    const answer = await customers.detail(id, s.csrf, controller.signal);
    if (stale()) return;
    if (answer.kind === 'ok') return putDetail({ id, phase: 'ready', text: '', customer: answer.customer });
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
    listCtl.current?.abort();
    detailCtl.current?.abort();
    setListBusy(false);
    clearWait();
    putDetail(DETAIL_NONE);
    setSaved(null);
    setCreateStatus(null);
    setHoldNote(null);
    setConnectionChanged(!user);
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
    begin(null, true);
    // A changed session is noticed without a click: reads only, one at a time, and never while a create is out. It never
    // signs in: an ended session stays ended (`ended`), and only a Reconnect click logs in again.
    const reconnect = (): void => {
      if (uid === null || document.visibilityState === 'hidden' || gen.current.csrf === null) return;
      if (addRef.current || checkRef.current || waitRef.current) return;
      const held = holds.get(uid);
      if (held !== undefined && held.state !== 'unresolved') return;
      const mine = gen.current.n;
      void connect(uid).then((s) => {
        if (mine !== gen.current.n) return;
        if (s.kind === 'ok') adopt(uid, s.csrf);
        // Definitely gone; the rest teaches nothing. Always cleared (a route change moves a read counter without a read):
        // clearBoth spares only a view whose Reconnect is still out.
        else if (s.kind === 'ended' || s.kind === 'refused' || s.kind === 'no-identity') clearBoth(sessionFailure(s));
      });
    };
    window.addEventListener('focus', reconnect);
    document.addEventListener('visibilitychange', reconnect);
    const unsubscribe = holds.subscribe(consumeOutcome); // an outcome that settles while this page is mounted
    return () => {
      unsubscribe();
      window.removeEventListener('focus', reconnect);
      document.removeEventListener('visibilitychange', reconnect);
      gen.current = { n: gen.current.n + 1, csrf: null };
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
   * that arrives after this page has gone updates the store only. `first` is the attempt's first send.
   */
  function settle(who: string, key: string, answer: CreateResult, first: boolean): void {
    const held = holds.get(who);
    if (held === undefined || held.key !== key) return;
    // This page still holds the connection the attempt was sent under.
    const here = alive.current && held.csrf !== null && held.csrf === gen.current.csrf;
    if (answer.kind === 'created' && answer.customer.name === held.name) {
      // CONFIRMED: a validated 201 naming the name that was sent
      if (!alive.current) return void holds.finish(who, key, { kind: 'saved', customer: answer.customer, csrf: held.csrf });
      holds.remove(who, key);
      return confirmed(answer.customer, here, true);
    }
    const kind = answer.kind;
    if (first && (kind === 'signed-out' || kind === 'denied' || kind === 'invalid' || kind === 'absent' || kind === 'key-reused' || kind === 'rate-limited')) {
      // conclusive for this request: nothing was reserved or executed; the draft stays
      if (!alive.current) return void holds.finish(who, key, { kind: 'refused', name: held.name });
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
    if (!alive.current) return;
    setHoldNote({ key, text: reasonOf(answer, answer.kind === 'rate-limited' ? startWait(answer.retryAfterSeconds) : undefined) });
    if (!first) listAfter(kind, here);
  }

  async function add(): Promise<void> {
    if (uid === null || addRef.current) return;
    const token = gen.current.csrf;
    if (!canCreate || token === null || listRef.current.phase !== 'ready' || waitRef.current || holds.get(uid) !== undefined) return;
    const name = normalizeCustomerName(draft);
    if (name === null) { // refused here: no request and no key (the server would bind the key before refusing the name)
      setNameError(NAME_RULE_TEXT);
      nameInput.current?.focus();
      return;
    }
    const mine = gen.current.n;
    addRef.current = true;
    setAdding(true);
    setNameError('');
    setCreateStatus(null);
    setSaved(null);
    setConnectionChanged(false);
    try {
      const s = await connect(uid);
      if (!alive.current || mine !== gen.current.n) return; // the page or its connection was replaced: nothing is sent
      if (s.kind !== 'ok') {
        return setCreateStatus({ refusal: true, text: `Not sent. ${failList(sessionFailure(s)).text}` });
      }
      // Another token than this generation's: a new generation, and NOTHING is sent under it.
      if (s.csrf !== token) return void adopt(uid, s.csrf);
      const key = nextKey();
      const body = JSON.stringify({ name });
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
    const { key, body, csrf } = held;
    checkRef.current = true;
    holds.change(uid, key, { state: 'checking' });
    setHoldNote(null);
    try {
      const s = await connect(uid);
      if (holds.get(uid)?.key !== key) return;
      if (s.kind !== 'ok') {
        holds.change(uid, key, { state: 'unresolved' });
        if (!alive.current) return;
        return setHoldNote({ key, text: `Not checked. ${failList(sessionFailure(s)).text}` });
      }
      if (s.csrf !== csrf) {
        // Another connection answers now: the attempt is detached for good and NOTHING is sent.
        holds.change(uid, key, { state: 'unresolved', csrf: null });
        if (alive.current) adopt(uid, s.csrf);
        return;
      }
      if (alive.current) adopt(uid, s.csrf); // a page that had no token yet takes this one: the attempt's own
      // Detached meanwhile (a read noticed another connection while this one was confirming): nothing is sent.
      if (holds.get(uid)?.csrf !== csrf) return void holds.change(uid, key, { state: 'unresolved' });
      // The SAME key and the SAME body string, with the token it was first sent with.
      settle(uid, key, await customers.create(body, key, csrf), false);
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

  const waiting = wait !== null;
  const detached = attempt !== undefined && attempt.detached;
  const tooOld = attempt !== undefined && clock() - attempt.sentAt >= CHECK_CUTOFF_MS;
  const canAdd = canCreate && list.phase === 'ready' && attempt === undefined && !waiting && !adding;
  const addHint = adding ? 'Sending…'
    : attempt !== undefined ? 'An earlier customer is not confirmed yet. Check it again or stop tracking it first.'
      : waiting ? waitHint(wait)
        : list.phase !== 'ready' ? 'Available once the list has loaded from the server.' : '';
  const busyHint = listBusy ? 'Loading…' : waiting ? waitHint(wait) : '';
  const lastKnown = (list.phase === 'unavailable' || list.phase === 'rate-limited') && list.rows.length > 0;
  // Until the route's own read has started, nothing of another id is shown.
  const shownDetail: DetailState = routeId === null || detail.id === routeId ? detail
    : { id: routeId, phase: isCustomerId(routeId) ? 'loading' : 'not-found', text: isCustomerId(routeId) ? TEXT.detailLoading : NOT_FOUND_TEXT, customer: null };
  const detailKnown = shownDetail.customer !== null && (shownDetail.phase === 'unavailable' || shownDetail.phase === 'rate-limited');
  const button = 'px-4 py-2 bg-primary text-white text-xs font-black uppercase tracking-widest rounded-xl disabled:opacity-50 disabled:cursor-not-allowed';
  const quiet = 'px-4 py-2 bg-white text-primary border border-slate-300 text-xs font-black uppercase tracking-widest rounded-xl disabled:opacity-50 disabled:cursor-not-allowed';
  const hintClass = 'text-[11px] font-medium text-slate-500';

  return (
    <section
      data-testid="customer-directory"
      aria-labelledby="customer-directory-title"
      className="bg-white/80 backdrop-blur-xl rounded-[2.5rem] border border-slate-200 p-8 shadow-sm space-y-4"
    >
      <h1 id="customer-directory-title" className="text-3xl font-black text-primary tracking-tight">Customer directory</h1>
      <p className="text-slate-600 text-sm font-medium">Saved on the server for this store. Only the customer&apos;s name is stored here.</p>
      <p className="text-slate-500 text-sm font-medium">
        Contact details, loyalty and history on the Customers page are held only in this browser&apos;s memory and are not linked to these records.
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
        <p data-testid="directory-saved-earlier" role="status" className="text-sm font-bold text-slate-700">{savedEarlierText(saved.earlier)}</p>
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
          {attempt.state === 'sending' && <p role="status" className="text-sm font-bold text-amber-900">Sending &quot;{attempt.name}&quot; to the server…</p>}
          {attempt.state === 'checking' && <p role="status" className="text-sm font-bold text-amber-900">Checking &quot;{attempt.name}&quot; with the server…</p>}
          {attempt.state === 'unresolved' && (
            <>
              <p role="status" className="text-sm font-bold text-amber-900">{unresolvedText(attempt.name)}</p>
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
                  <button type="button" data-testid="directory-check-again" disabled={waiting} aria-describedby="directory-check-hint" onClick={() => { void checkAgain(); }} className={button}>
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

      {routeId !== null ? (
        <section
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
              <dt className="font-black text-slate-500">Customer ID</dt>
              <dd data-testid="directory-detail-id" className="font-mono text-slate-700 break-all">{shownDetail.customer.id}</dd>
            </dl>
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
        <section aria-labelledby="directory-list-title" aria-busy={listBusy} className="space-y-3">
          <h2 id="directory-list-title" ref={listTitle} tabIndex={-1} className="text-xl font-black text-primary tracking-tight">Customers on the server</h2>
          <p data-testid="directory-state" data-phase={list.phase} role={list.phase === 'denied' ? 'alert' : 'status'} className="text-sm font-bold text-slate-600 min-h-[1rem]">
            {list.text}
            {lastKnown && <span data-testid="directory-last-known" className="block text-xs font-black uppercase tracking-widest text-amber-800">{LAST_KNOWN_TEXT}</span>}
            {list.phase === 'ready' && list.rows.length === 0 && <span data-testid="directory-empty" className="block font-medium text-slate-600">{EMPTY_TEXT}</span>}
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
              <label htmlFor="directory-name" className="block text-[10px] font-black text-slate-500 uppercase tracking-widest">Customer name</label>
              <div className="flex flex-wrap items-center gap-3">
                <input
                  ref={nameInput}
                  id="directory-name"
                  data-testid="directory-name"
                  type="text"
                  autoComplete="off"
                  value={draft}
                  aria-invalid={nameError !== ''}
                  aria-describedby={nameError !== '' ? 'directory-name-error' : undefined}
                  onChange={(e) => { setDraft(e.target.value); setNameError(''); }}
                  className="flex-1 min-w-[14rem] text-sm px-3 py-2 rounded-lg border border-slate-300 bg-white"
                />
                <button type="submit" data-testid="directory-add" disabled={!canAdd} aria-describedby="directory-add-hint" className={button}>Add customer</button>
              </div>
              <p id="directory-add-hint" data-testid="directory-add-hint" className={`${hintClass} min-h-[1rem]`}>{addHint}</p>
              {nameError !== '' && <p id="directory-name-error" data-testid="directory-name-error" role="alert" className="text-xs font-bold text-rose-700">{nameError}</p>}
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
