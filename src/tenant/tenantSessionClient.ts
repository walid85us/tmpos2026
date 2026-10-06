// M7A-CUSTOMERS-P3-R2 — the shop's tenant session client: the one place the shop app talks to the tenant session
// boundary (/api/v1/session*, server/runtime/sessions.ts), mirroring the admin console's adminSessionClient.ts.
//
//   - The HttpOnly `__Host-` session cookie belongs to the browser: every request goes out same-origin with credentials
//     "include", and this module never constructs, reads or sends a cookie.
//   - The only credential it ever sends is the signed-in user's own Firebase ID token, once, as the login Bearer; the
//     server verifies it and decides who this is. Nothing here knows or builds an issuer key, a proof or a database key.
//   - The session CSRF token lives in this closure only (beside the UID it was issued for) — never in React state (one
//     exception, below), storage, a URL, the DOM or a log — and is handed to the caller only to ride its next request (an
//     unsafe one, or a session-bound read). Three more in-memory holders keep what they were handed, under the same rule
//     (never storage, a URL, the DOM or a log); their refs and dialog state go with their page, which a sign-out unmounts
//     (the route guard, AccessGuard.tsx; a DEV-only session excepted), and a reload drops everything:
//       - The customer directory page (ServerCustomerDirectory.tsx, M7A-CUSTOMERS-P5), second: in refs, to compare it with
//         the next one; in its module-level hold store beside a held create and a create's recorded "saved" outcome, to
//         re-send that create on the same session and to tell whether the outcome is this session's; and in its edit hold
//         store beside a held edit and an edit's recorded outcome. Its create hold store hears `onSessionEnd` from its
//         module's load, whether or not a directory page is mounted (M7B-INVOICES-P1-R2, doc 08 DA-200): every user's held
//         create loses its token and its whole body, and every recorded outcome its token. A mounted directory page hears
//         it too (its refs lose the token with its generation, and it drops that user's held edit). Its edit hold store
//         does not: it drops every other user's edit and outcome on a sign-out or another user (the page binds it to the
//         sign-in state); otherwise a held edit keeps its token until a mounted page of its user hears `onSessionEnd` or
//         sees another token or an ended session (the edit is dropped), or the page reloads.
//       - The server-customer picker (ServerCustomerPicker.tsx, M7A-CUSTOMERS-P9), third: its open dialog in a ref, to
//         compare it with the next one, until the dialog closes or hears `onSessionEnd`; and its `sessionContextOf` keeps
//         the latest (UID, token) pair in module scope, to hand out one opaque context per session,
//         until the last draft field unmounts or `onSessionEnd` is heard — never again for a session confirmed before.
//       - The Invoices page's server drafts section (ServerInvoiceDrafts.tsx, M7B-INVOICES-P1), fourth: in refs, to compare
//         it with the next one and send its reads; in an open new-draft dialog's state, to send that dialog's save (the one
//         React-state exception) — both until the section unmounts or, while it is mounted, hears `onSessionEnd` (which
//         also closes that dialog); and on each save attempt in its module-level hold store, to re-send an unresolved one
//         on the same session (Check again) and to read a created one back only under that session. `onSessionEnd` takes it
//         from every user's attempt (an unconfirmed one loses its body too, and is never sent again); otherwise it stays
//         until the attempt is detached, read back or removed, or the page reloads.
//   - A sign-out is heard where it starts: `onSessionEnd` listeners run synchronously at the START of every `logout()`
//     (and `reset()`), before anything is sent or awaited — so they run whatever the server answers. AccessContext.tsx
//     starts that logout, without awaiting it, on every signed-out state and before another user's session is used; the
//     logout itself is best effort (a failed one leaves the server session to its idle timeout). The module-scope holders
//     listen from their module's load (and stop on a hot reload), whether or not their page is still mounted; a mounted
//     view (the directory page, the picker's dialog and each draft's server-customer field, the drafts section) listens
//     while it is mounted. The broadcast carries nothing (no user, reason or tenant) and only a logout or a reset here
//     publishes it: a remote expiry or revocation reaches a holder only when that holder asks (`ensure`). A listener
//     that throws stops neither the logout nor the other listeners, and its error is rethrown unchanged in a queued
//     microtask once they have all run (reported by the platform as an uncaught error, never thrown into the logout). An
//     answer asked for before a sign-out began can still arrive after it: `sessionEndsSoFar` counts the ends, and a
//     holder that read it before asking takes no token from such an answer.
//   - A session is only ever reused for the user it belongs to. Every `ensure` first reads the session this browser
//     already holds (M7A-CUSTOMERS-P5-R1, DA-143) and reuses it — with no login — only when the server's `subject` for it
//     equals the digest of the UID asked for; the digest is recomputed here from that UID and never sent. No session, or
//     another identity's, logs in (a login ends the session presented to it); an outage, a rate limit or a malformed
//     answer logs in nothing. So a page load reuses the signed-in user's session, and one person's session can never
//     answer for another.
//   - A session this client has CONFIRMED for a user in this page's life is never re-established on its own
//     (M7A-CUSTOMERS-P6): once one was kept for that UID, a session read answering 401 (expiry, revocation, a logout
//     elsewhere) is `ended` — no ID token is asked for and no login is sent — and stays so on every later `ensure` until
//     a read finds a valid session of that user again (another tab's, reused with no login) or the caller passes
//     `reconnect` (the page's Reconnect button, the only caller that does). The marker lives in this closure only and is
//     forgotten by a reset, a logout or another user: a fresh page (a reload) has confirmed nothing, so its first 401 is
//     a first establishment and logs in — the server's 401 does not say "expired", and nothing is stored to tell
//     (a stated residual). Another identity's session still logs this user in, as above.
//   - Every reset supersedes earlier work: an answer that arrives under an older epoch is dropped, so a slow login for a
//     user who has since signed out can never re-establish their session here.
//   - A logout runs to completion and every later session step waits for it (M7A-CUSTOMERS-P3-R2 AM4): a user switch
//     ends the previous user's session BEFORE the next user reads or logs in, so a late logout can never end the next
//     user's session. Its own requests are not abandoned by a later reset; only its timeout ends them.
//   - The server stays the authority: this client reports what the boundary answered and decides nothing.

export const TENANT_SESSION_PATHS = Object.freeze({
  current: '/api/v1/session',
  login: '/api/v1/session/login',
  logout: '/api/v1/session/logout',
});

export const INTENT_HEADER = 'X-TMPOS-CSRF'; // server/runtime/requestSecurity.ts CSRF_HEADER; value '1'
export const SESSION_CSRF_HEADER = 'X-TMPOS-Session-CSRF'; // server/runtime/sessions.ts SESSION_CSRF_HEADER
const REAUTHENTICATE_HEADER = 'X-TMPOS-Reauthenticate'; // the login's re-authentication mode; value '1'
const CSRF_RE = /^[A-Za-z0-9_-]{43}$/;
const SUBJECT_RE = CSRF_RE; // a SHA-256 in base64url, as server/runtime/sessions.ts sessionSubjectOf writes it
const SUBJECT_PREFIX = 'tmpos-session-subject:v1\nfirebase\n'; // sessionSubjectOf's label and the shop's one provider
const BEARER_RE = /^[A-Za-z0-9\-._~+/]+=*$/; // RFC 6750 b64token
const MAX_BEARER_LENGTH = 4096; // server/runtime/access.ts MAX_TOKEN_LENGTH
export const JSON_TYPE_RE = /^application\/json\s*(?:;|$)/i; // exact media type: `\b` would admit application/json-patch+json
export const REQUEST_TIMEOUT_MS = 15_000;
const RETRY_AFTER_RE = /^[0-9]{1,9}$/; // whole seconds, as the server sends them (server/runtime/app.ts); never an HTTP-date
const RETRY_AFTER_MAX_SECONDS = 300;

/** A `Retry-After` header as whole seconds, clamped to 1..300; null when it is missing or is not a whole number. */
export function parseRetryAfter(header: string | null): number | null {
  if (header === null || !RETRY_AFTER_RE.test(header)) return null;
  return Math.min(RETRY_AFTER_MAX_SECONDS, Math.max(1, Number(header)));
}

/**
 * What asking for a session for one UID ended in: `ok` with the session's CSRF token; `no-identity` — no signed-in user
 * here to present (nothing was sent); `refused` — the server did not accept the sign-in or the session it made; `ended`
 * — the session this client confirmed for that user is gone and no login was sent (only a `reconnect` signs in again);
 * `rate-limited` — with `retryAfterSeconds` ONLY when the refusal carried a valid `Retry-After` (the key is absent
 * otherwise, M7A-CUSTOMERS-P5); `unavailable` — nothing could be confirmed (an outage, a timeout, a malformed answer, or
 * superseded).
 */
export type SessionResult =
  | { readonly kind: 'ok'; readonly csrf: string }
  | { readonly kind: 'no-identity' | 'refused' | 'unavailable' | 'ended' }
  | { readonly kind: 'rate-limited'; readonly retryAfterSeconds?: number };

/** `fresh`: describe the session as it stands after an answer the caller holds. `reconnect`: the user asked to sign in again. */
export interface EnsureOptions { readonly fresh?: boolean; readonly reconnect?: boolean }

export interface TenantSessionClient {
  /**
   * A confirmed tenant session for `uid`. A session read comes first: a session the server names as `uid`'s is reused
   * with its current CSRF token (another tab may have rotated it) and no login. Only when that read answers 401, or names
   * another identity's session, is the user's ID token (from `idToken`, null when that user is not signed in here)
   * exchanged at the login route, and a session read confirms the new cookie — except that a 401 for a user whose session
   * this client has already confirmed is `ended`, with no ID token asked and no login, unless `reconnect` is set. Any
   * other answer to the first read (an outage, a 429, a malformed body) ends the attempt without a login. Concurrent
   * calls for one UID share one attempt, except a `fresh` call: it must describe the session as it stands AFTER an
   * answer the caller already holds (a read refused 403), so it waits for an attempt in flight — which may have read
   * before that answer — and then reads again; if another user's attempt, a logout or a reset came in between, it
   * answers `unavailable` and sends nothing — as it does at once for a user other than the one this client is attempting,
   * keeping, or confirmed (even after that session `ended`). A `reconnect` call never takes an attempt in flight's `ended` as its own
   * answer: it waits for it and then runs its own.
   */
  ensure(uid: string, idToken: () => Promise<string | null>, options?: EnsureOptions): Promise<SessionResult>;
  /**
   * A recent sign-in by the user already signed in: `freshToken` (after a real provider re-authentication) sent once to
   * the login route in its re-authentication mode, beside this page's cookie. `ok` only when the server rotated the
   * session to one carrying the new sign-in and a session read confirmed it.
   */
  reauthenticate(uid: string, freshToken: string): Promise<SessionResult>;
  /**
   * End the tenant session this browser holds, best effort. First, synchronously, every `onSessionEnd` listener is told.
   * Everything in flight before it is abandoned and the memo
   * (with the confirmed-session marker) is cleared at once, whatever the server answers. With no session remembered it reads the current one first (none →
   * nothing is sent). Logouts run one after another, and every later `ensure` waits until they have finished.
   */
  logout(): Promise<void>;
  /**
   * Forget this page's session (and that one was ever confirmed) and abandon everything in flight (a user switch). Sends
   * nothing. First, synchronously, every `onSessionEnd` listener is told.
   */
  reset(): void;
}

type Outcome =
  | { readonly kind: 'response'; readonly status: number; readonly body: unknown; readonly retryAfter: number | null }
  | { readonly kind: 'failed' }
  | { readonly kind: 'superseded' };

function csrfOf(outcome: Outcome): string | null {
  if (outcome.kind !== 'response' || outcome.status !== 200) return null;
  const body = outcome.body;
  if (typeof body !== 'object' || body === null) return null;
  const { status, csrfToken } = body as { status?: unknown; csrfToken?: unknown };
  return status === 'active' && typeof csrfToken === 'string' && CSRF_RE.test(csrfToken) ? csrfToken : null;
}

/** A session read's 200: its CSRF token and whose session it is; null for anything else, a missing subject included. */
function heldOf(outcome: Outcome): { readonly csrf: string; readonly subject: string } | null {
  const csrf = csrfOf(outcome);
  if (csrf === null) return null;
  const { subject } = (outcome as { body: { subject?: unknown } }).body;
  return typeof subject === 'string' && SUBJECT_RE.test(subject) ? { csrf, subject } : null;
}

/** The `subject` the server names for `uid`'s session: SHA-256 over the label and the UID, in base64url. */
export async function sessionSubjectOf(uid: string): Promise<string> {
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(SUBJECT_PREFIX + uid)));
  let binary = '';
  for (const byte of digest) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const statusOf = (outcome: Outcome): number | null => (outcome.kind === 'response' ? outcome.status : null);
const wellFormed = (token: unknown): token is string =>
  typeof token === 'string' && token.length <= MAX_BEARER_LENGTH && BEARER_RE.test(token);
const UNAVAILABLE: SessionResult = Object.freeze({ kind: 'unavailable' });
const ENDED: SessionResult = Object.freeze({ kind: 'ended' });
const result = (kind: 'no-identity' | 'refused' | 'unavailable'): SessionResult => Object.freeze({ kind });
/** A 429 is `rate-limited`, carrying the server's delay only when it named one; any other undecided answer is `unavailable`. */
function undecided(outcome: Outcome): SessionResult {
  if (statusOf(outcome) !== 429) return UNAVAILABLE;
  const seconds = outcome.kind === 'response' ? outcome.retryAfter : null;
  return Object.freeze(seconds === null ? { kind: 'rate-limited' } : { kind: 'rate-limited', retryAfterSeconds: seconds });
}

const sessionEndListeners = new Set<() => void>();
let sessionEnds = 0;

/**
 * Hear every end of a session this module's clients hold (the shop makes one: `tenantSession`): `listener` runs
 * synchronously at the start of each `logout()` and `reset()`, before anything is sent or awaited. For the in-memory token
 * holders: the module-scope ones register once, a mounted view for its life. Returns the unsubscription.
 */
export function onSessionEnd(listener: () => void): () => void {
  sessionEndListeners.add(listener);
  return () => { sessionEndListeners.delete(listener); };
}

/**
 * How many session ends (logouts and resets) this page has announced. Read BEFORE a session is asked for and compared
 * when its answer is used: a different count means a sign-out began in between, so the token that answer carries is from
 * before it and is taken nowhere (it can resolve after `logout()` has begun, when its promise settled just before).
 */
export const sessionEndsSoFar = (): number => sessionEnds;

/**
 * Tell every listener. One that throws stops neither the logout nor the listeners after it; its error is not swallowed:
 * once every listener has run, each one caught is rethrown as it was, in a queued microtask of its own — an uncaught error
 * the platform reports (the browser's console and `error` event), never thrown into this logout.
 */
function announceSessionEnd(): void {
  sessionEnds += 1; // first: a listener, and every continuation after it, already reads the new count
  const failures: unknown[] = [];
  for (const listener of [...sessionEndListeners]) {
    try {
      listener();
    } catch (error) {
      failures.push(error); // a holder's own failure: the sign-out goes on, and the error is surfaced below
    }
  }
  for (const error of failures) queueMicrotask(() => { throw error; });
}

export function createTenantSessionClient(
  options: { fetch?: typeof fetch; timeoutMs?: number; subjectOf?: (uid: string) => Promise<string> } = {},
): TenantSessionClient {
  const send = options.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init));
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
  const subjectOf = options.subjectOf ?? sessionSubjectOf;
  const controllers = new Set<AbortController>();
  let memo: { readonly uid: string; readonly csrf: string } | null = null;
  let confirmedUid: string | null = null; // the UID a session was kept for in this page's life: its 401 is `ended`, not a login
  let epoch = 0;
  let pending: { readonly uid: string; readonly run: Promise<SessionResult> } | null = null;
  let ending: Promise<void> | null = null; // the last logout still running

  const supersede = (): number => {
    for (const controller of controllers) controller.abort();
    controllers.clear();
    pending = null;
    return ++epoch;
  };

  /** One exchange under epoch `mine`; `null` is a logout's own request: never superseded, ended only by its timeout. */
  async function request(method: 'GET' | 'POST', path: string, headers: Record<string, string>, mine: number | null): Promise<Outcome> {
    const controller = new AbortController();
    if (mine !== null) controllers.add(controller);
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await send(path, {
        method,
        headers: { Accept: 'application/json', ...headers },
        credentials: 'include',
        mode: 'same-origin',
        cache: 'no-store',
        redirect: 'error',
        referrerPolicy: 'no-referrer',
        signal: controller.signal,
      });
      const json = res.status === 200 && JSON_TYPE_RE.test(res.headers.get('content-type') ?? '');
      const body: unknown = json ? await res.json().catch(() => undefined) : undefined;
      const retryAfter = res.status === 429 ? parseRetryAfter(res.headers.get('retry-after')) : null;
      return mine === null || mine === epoch ? { kind: 'response', status: res.status, body, retryAfter } : { kind: 'superseded' };
    } catch {
      return mine === null || mine === epoch ? { kind: 'failed' } : { kind: 'superseded' };
    } finally {
      clearTimeout(timer);
      controllers.delete(controller);
    }
  }

  /**
   * Whose session a session read's 200 names: `uid`'s (its CSRF token), `other`, `failed` when the digest could not be
   * made, or null when the answer is no such 200 (a 401, an outage, a malformed body, a 200 without a subject…).
   */
  async function whose(check: Outcome, uid: string): Promise<{ readonly csrf: string } | 'other' | 'failed' | null> {
    const held = heldOf(check);
    if (held === null) return null;
    try {
      return held.subject === (await subjectOf(uid)) ? { csrf: held.csrf } : 'other';
    } catch {
      return 'failed';
    }
  }

  const keep = (uid: string, csrf: string): SessionResult => {
    memo = Object.freeze({ uid, csrf });
    confirmedUid = uid;
    return Object.freeze({ kind: 'ok', csrf });
  };

  /** A session read after a login: the new cookie, never the bearer, must answer for the session kept — and be `uid`'s. */
  async function confirm(uid: string, mine: number): Promise<SessionResult> {
    const check = await request('GET', TENANT_SESSION_PATHS.current, {}, mine);
    if (check.kind === 'superseded' || mine !== epoch) return UNAVAILABLE;
    const held = await whose(check, uid);
    if (mine !== epoch) return UNAVAILABLE;
    if (held !== null) return typeof held === 'string' ? UNAVAILABLE : keep(uid, held.csrf); // another sign-in replaced it: nothing confirmed
    const status = statusOf(check);
    if (status === 401 || status === 403) return result('refused');
    return undecided(check);
  }

  function ensure(uid: string, idToken: () => Promise<string | null>, options: EnsureOptions = {}): Promise<SessionResult> {
    // A check for a user this client has moved on from answers nothing and supersedes nothing — nor clears the end of
    // the session it confirmed for another user (after an `ended` there is no memo, but that marker still names who).
    if (
      options.fresh === true
      && ((pending !== null && pending.uid !== uid) || (memo !== null && memo.uid !== uid) || (confirmedUid !== null && confirmedUid !== uid))
    ) return Promise.resolve(UNAVAILABLE);
    if (pending !== null && pending.uid === uid) {
      if (options.fresh === true) {
        const waited = epoch;
        return pending.run.then(() => (waited === epoch ? ensure(uid, idToken, options) : UNAVAILABLE));
      }
      // A Reconnect is the user's own request to sign in: an attempt in flight that ends `ended` does not answer it.
      if (options.reconnect === true) return pending.run.then((r) => (r.kind === 'ended' ? ensure(uid, idToken, options) : r));
      return pending.run;
    }
    // Another user's session is never reused, nor is any of their work in flight allowed to answer.
    if (pending !== null || (memo !== null && memo.uid !== uid)) supersede();
    if (memo !== null && memo.uid !== uid) memo = null;
    if (confirmedUid !== uid) confirmedUid = null; // another user: nothing of the previous one's session decides this one's login
    const mine = epoch;
    const after = ending;
    const run = (async (): Promise<SessionResult> => {
      // A logout still running finishes first: it can never end the session this call reads or makes.
      if (after !== null) await after;
      if (mine !== epoch) return UNAVAILABLE;
      // The session this browser already holds — from this page, an earlier page load or another tab — is reused when
      // the server names it as this user's (M7A-CUSTOMERS-P5-R1, DA-143): a reload or a reopen sends no login.
      const current = await request('GET', TENANT_SESSION_PATHS.current, {}, mine);
      if (current.kind === 'superseded' || mine !== epoch) return UNAVAILABLE;
      const held = await whose(current, uid);
      if (mine !== epoch || held === 'failed') return UNAVAILABLE;
      if (held !== null && held !== 'other') return keep(uid, held.csrf);
      // Only no session (none yet, or — on a reconnect — expiry, logout elsewhere, revocation) or another identity's signs
      // in; that login ends the session it is presented with. Anything else — an outage, a 429, a malformed answer — signs
      // nothing in.
      if (held === null && statusOf(current) !== 401) return undecided(current);
      // The session this client confirmed for this user is gone (M7A-CUSTOMERS-P6): nothing signs in on its own — no ID
      // token is asked for and no login is sent — until the user asks to reconnect. Its token is forgotten with it.
      if (held === null && confirmedUid === uid && options.reconnect !== true) {
        memo = null;
        return ENDED;
      }
      // The digest the confirming read is compared with is made before any login: one that cannot be made signs nothing in.
      try {
        await subjectOf(uid);
      } catch {
        return UNAVAILABLE;
      }
      if (mine !== epoch) return UNAVAILABLE;
      memo = null;
      let token: string | null;
      try {
        token = await idToken();
      } catch {
        return UNAVAILABLE;
      }
      if (mine !== epoch) return UNAVAILABLE;
      if (token === null) return result('no-identity');
      if (!wellFormed(token)) return result('refused');
      const login = await request('POST', TENANT_SESSION_PATHS.login, { Authorization: `Bearer ${token}`, [INTENT_HEADER]: '1' }, mine);
      if (login.kind === 'superseded' || mine !== epoch) return UNAVAILABLE;
      if (csrfOf(login) === null) {
        const status = statusOf(login);
        if (status === 401 || status === 403) return result('refused'); // one generic refusal, whatever the reason
        return undecided(login);
      }
      return confirm(uid, mine);
    })();
    const entry = { uid, run };
    pending = entry;
    void run.finally(() => {
      if (pending === entry) pending = null;
    });
    return run;
  }

  async function reauthenticate(uid: string, freshToken: string): Promise<SessionResult> {
    if (!wellFormed(freshToken)) return result('refused'); // sent nowhere
    if (memo === null || memo.uid !== uid) return result('refused'); // no session of this user here to renew; sent nowhere
    // Everything the old session had in flight is abandoned: whatever it answers now is not this session's answer.
    const mine = supersede();
    const login = await request(
      'POST',
      TENANT_SESSION_PATHS.login,
      { Authorization: `Bearer ${freshToken}`, [INTENT_HEADER]: '1', [REAUTHENTICATE_HEADER]: '1' },
      mine,
    );
    if (login.kind === 'superseded' || mine !== epoch) return UNAVAILABLE;
    const status = statusOf(login);
    if (status === 429) return undecided(login);
    // Whatever the login answered, a session read says what stands now; its CSRF token is the one kept.
    const confirmed = await confirm(uid, mine);
    if (confirmed.kind !== 'ok') {
      if (confirmed.kind === 'refused' && mine === epoch) memo = null;
      return confirmed;
    }
    return csrfOf(login) !== null ? confirmed : result(status === 401 || status === 403 ? 'refused' : 'unavailable');
  }

  function logout(): Promise<void> {
    announceSessionEnd(); // first: the holders hear it before anything is sent or awaited
    supersede(); // its own epoch: whatever was in flight before this logout answers for nothing
    const remembered = memo?.csrf ?? null;
    memo = null;
    confirmedUid = null;
    const previous = ending;
    const run = (async (): Promise<void> => {
      if (previous !== null) await previous;
      try {
        let csrf = remembered;
        if (csrf === null) {
          // A session may survive from an earlier page load of this browser: ask for its token to end it.
          csrf = csrfOf(await request('GET', TENANT_SESSION_PATHS.current, {}, null));
          if (csrf === null) return;
        }
        await request('POST', TENANT_SESSION_PATHS.logout, { [INTENT_HEADER]: '1', [SESSION_CSRF_HEADER]: csrf }, null);
      } catch {
        // best effort: the server's idle timeout ends a session this could not
      }
    })();
    ending = run;
    void run.finally(() => {
      if (ending === run) ending = null;
    });
    return run;
  }

  return Object.freeze({
    ensure,
    reauthenticate,
    logout,
    reset(): void {
      announceSessionEnd();
      supersede();
      memo = null;
      confirmedUid = null;
    },
  });
}

/**
 * The shop's one tenant session client, shared by the role-levels panels, the customer directory, the customer picker, the
 * server drafts section and the sign-out hook in AccessContext.
 */
export const tenantSession: TenantSessionClient = createTenantSessionClient();
