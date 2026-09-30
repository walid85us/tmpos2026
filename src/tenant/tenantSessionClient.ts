// M7A-CUSTOMERS-P3-R2 — the shop's tenant session client: the one place the shop app talks to the tenant session
// boundary (/api/v1/session*, server/runtime/sessions.ts), mirroring the admin console's adminSessionClient.ts.
//
//   - The HttpOnly `__Host-` session cookie belongs to the browser: every request goes out same-origin with credentials
//     "include", and this module never constructs, reads or sends a cookie.
//   - The only credential it ever sends is the signed-in user's own Firebase ID token, once, as the login Bearer; the
//     server verifies it and decides who this is. Nothing here knows or builds an issuer key, a proof or a database key.
//   - The session CSRF token lives in this closure only (beside the UID it was issued for) — never in React state,
//     storage, a URL, the DOM or a log — and is handed to the caller only to ride the next unsafe request. The customer
//     directory page (ServerCustomerDirectory.tsx, M7A-CUSTOMERS-P5) is its second in-memory holder: it keeps the token
//     it was handed in refs, and beside an unresolved create in its in-memory hold store, only to compare it with the
//     next one and to re-send that create on the same session — under the same rule (no state, storage, URL, DOM, log).
//   - A session is only ever reused for the UID that established it: a different UID (a user switch in this browser)
//     always logs in again, so one person's session can never answer for another.
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
 * here to present (nothing was sent); `refused` — the server did not accept the sign-in or the session it made;
 * `rate-limited` — with `retryAfterSeconds` ONLY when the refusal carried a valid `Retry-After` (the key is absent
 * otherwise, M7A-CUSTOMERS-P5); `unavailable` — nothing could be confirmed (an outage, a timeout, a malformed answer, or
 * superseded).
 */
export type SessionResult =
  | { readonly kind: 'ok'; readonly csrf: string }
  | { readonly kind: 'no-identity' | 'refused' | 'unavailable' }
  | { readonly kind: 'rate-limited'; readonly retryAfterSeconds?: number };

export interface TenantSessionClient {
  /**
   * A confirmed tenant session for `uid`. When this page already holds one for the same UID a session read confirms it
   * (and supplies its current CSRF token — another tab may have rotated it); otherwise, or when that read answers 401,
   * the user's ID token (from `idToken`, null when that user is not signed in here) is exchanged at the login route and
   * a session read confirms the new cookie. Concurrent calls for one UID share one attempt.
   */
  ensure(uid: string, idToken: () => Promise<string | null>): Promise<SessionResult>;
  /**
   * A recent sign-in by the user already signed in: `freshToken` (after a real provider re-authentication) sent once to
   * the login route in its re-authentication mode, beside this page's cookie. `ok` only when the server rotated the
   * session to one carrying the new sign-in and a session read confirmed it.
   */
  reauthenticate(uid: string, freshToken: string): Promise<SessionResult>;
  /**
   * End the tenant session this browser holds, best effort. Everything in flight before it is abandoned and the memo is
   * cleared at once, whatever the server answers. With no session remembered it reads the current one first (none →
   * nothing is sent). Logouts run one after another, and every later `ensure` waits until they have finished.
   */
  logout(): Promise<void>;
  /** Forget this page's session and abandon everything in flight (a user switch). Sends nothing. */
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

const statusOf = (outcome: Outcome): number | null => (outcome.kind === 'response' ? outcome.status : null);
const wellFormed = (token: unknown): token is string =>
  typeof token === 'string' && token.length <= MAX_BEARER_LENGTH && BEARER_RE.test(token);
const UNAVAILABLE: SessionResult = Object.freeze({ kind: 'unavailable' });
const result = (kind: 'no-identity' | 'refused' | 'unavailable'): SessionResult => Object.freeze({ kind });
/** A 429 is `rate-limited`, carrying the server's delay only when it named one; any other undecided answer is `unavailable`. */
function undecided(outcome: Outcome): SessionResult {
  if (statusOf(outcome) !== 429) return UNAVAILABLE;
  const seconds = outcome.kind === 'response' ? outcome.retryAfter : null;
  return Object.freeze(seconds === null ? { kind: 'rate-limited' } : { kind: 'rate-limited', retryAfterSeconds: seconds });
}

export function createTenantSessionClient(options: { fetch?: typeof fetch; timeoutMs?: number } = {}): TenantSessionClient {
  const send = options.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init));
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
  const controllers = new Set<AbortController>();
  let memo: { readonly uid: string; readonly csrf: string } | null = null;
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

  /** A session read after a login: the new cookie, never the bearer, must answer for the session kept. */
  async function confirm(uid: string, mine: number): Promise<SessionResult> {
    const check = await request('GET', TENANT_SESSION_PATHS.current, {}, mine);
    if (check.kind === 'superseded' || mine !== epoch) return UNAVAILABLE;
    const token = csrfOf(check);
    if (token !== null) {
      memo = Object.freeze({ uid, csrf: token });
      return Object.freeze({ kind: 'ok', csrf: token });
    }
    const status = statusOf(check);
    if (status === 401 || status === 403) return result('refused');
    return undecided(check);
  }

  function ensure(uid: string, idToken: () => Promise<string | null>): Promise<SessionResult> {
    if (pending !== null && pending.uid === uid) return pending.run;
    // Another user's session is never reused, nor is any of their work in flight allowed to answer.
    if (pending !== null || (memo !== null && memo.uid !== uid)) supersede();
    if (memo !== null && memo.uid !== uid) memo = null;
    const mine = epoch;
    const after = ending;
    const run = (async (): Promise<SessionResult> => {
      // A logout still running finishes first: it can never end the session this call reads or makes.
      if (after !== null) await after;
      if (mine !== epoch) return UNAVAILABLE;
      if (memo !== null && memo.uid === uid) {
        const current = await request('GET', TENANT_SESSION_PATHS.current, {}, mine);
        if (current.kind === 'superseded' || mine !== epoch) return UNAVAILABLE;
        const token = csrfOf(current);
        if (token !== null) {
          memo = Object.freeze({ uid, csrf: token });
          return Object.freeze({ kind: 'ok', csrf: token });
        }
        const status = statusOf(current);
        if (status !== 401) return undecided(current);
        memo = null; // the session ended (expiry, logout elsewhere, revocation): sign in again below
      }
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
    supersede(); // its own epoch: whatever was in flight before this logout answers for nothing
    const remembered = memo?.csrf ?? null;
    memo = null;
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
      supersede();
      memo = null;
    },
  });
}

/** The shop's one tenant session client, shared by the role-levels panel, the customer directory and the sign-out hook in AccessContext. */
export const tenantSession: TenantSessionClient = createTenantSessionClient();
