// Phase 4.0 M4 — the administration console's session client: the one place the browser
// talks to the administrative session boundary (/admin/v1/session*, docs/phase-4/03 §3).
//
//   - The HttpOnly `__Host-` session cookie belongs to the browser: every request goes out with
//     credentials "include", and this module never constructs, reads or sends a cookie.
//   - The session CSRF token lives in this closure only — never in the published state,
//     storage, a URL or the DOM — and rides the one unsafe request the console makes (logout),
//     beside the intent header the runtime requires on every unsafe request.
//   - The provider ID token is handed in once, sent once as the login Bearer, and not kept.
//   - Every operation that supersedes earlier work advances `epoch`; a response that arrives
//     under an older epoch is dropped, so a slow read can never restore a session that a
//     logout, an expiry or a newer login has already replaced.
//   - The server stays the authority: this client reports what the boundary answered and makes
//     no authorization decision of its own.

export const ADMIN_SESSION_PATHS = Object.freeze({
  current: '/admin/v1/session',
  login: '/admin/v1/session/login',
  logout: '/admin/v1/session/logout',
});

const INTENT_HEADER = 'X-TMPOS-CSRF'; // server/runtime/requestSecurity.ts CSRF_HEADER; value '1'
const SESSION_CSRF_HEADER = 'X-TMPOS-Session-CSRF'; // server/runtime/sessions.ts SESSION_CSRF_HEADER
const CSRF_RE = /^[A-Za-z0-9_-]{43}$/;
const BEARER_RE = /^[A-Za-z0-9\-._~+/]+=*$/; // RFC 6750 b64token
const MAX_BEARER_LENGTH = 4096; // server/runtime/access.ts MAX_TOKEN_LENGTH
export const REQUEST_TIMEOUT_MS = 15_000;

export type SessionNotice = 'expired' | 'logged-out' | 'logged-out-unconfirmed' | 'denied' | 'rate-limited' | 'unavailable';

export type SessionState =
  | { readonly phase: 'checking' }
  | { readonly phase: 'signed-out'; readonly notice: SessionNotice | null }
  | { readonly phase: 'signing-in' }
  /** `interrupted`: a re-read could not confirm the session, so its content stays hidden. */
  | { readonly phase: 'active'; readonly interrupted: boolean; readonly signOutFailed: boolean }
  | { readonly phase: 'signing-out' };

export interface AdminSessionClient {
  getState(): SessionState;
  subscribe(listener: () => void): () => void;
  /** Read the current session: the first load, every re-check, and the retry after an outage. */
  bootstrap(): Promise<void>;
  /**
   * Exchange one provider ID token for a server session, then publish it only once a session read
   * confirms it. A call while another exchange or a logout runs is dropped.
   */
  exchange(idToken: string): Promise<void>;
  logout(): Promise<void>;
  /**
   * End an active session on this page because a data request answered 401. Sends nothing:
   * in-flight reads are superseded and the page returns to sign-in with the expiry notice. A
   * running exchange or logout decides the state itself, so this does nothing then, nor when no
   * session is active.
   */
  expire(): void;
  /** Abandon in-flight requests (unmount, navigation away); whatever they return is ignored. */
  abort(): void;
}

type Outcome =
  | { readonly kind: 'response'; readonly status: number; readonly body: unknown }
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

export function createAdminSessionClient(options: { fetch?: typeof fetch; timeoutMs?: number } = {}): AdminSessionClient {
  const send = options.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init));
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
  const listeners = new Set<() => void>();
  const controllers = new Set<AbortController>();
  let state: SessionState = Object.freeze({ phase: 'checking' });
  let csrf: string | null = null;
  let epoch = 0;
  let heldSession = false; // this page held a session, so a later 401 reads as an expiry
  let reading: Promise<void> | null = null;
  let busy: Promise<void> | null = null; // an exchange or a logout

  const publish = (next: SessionState): void => {
    state = Object.freeze(next);
    for (const listener of [...listeners]) listener();
  };
  const activate = (token: string): void => {
    csrf = token;
    heldSession = true;
    publish({ phase: 'active', interrupted: false, signOutFailed: false });
  };
  const end = (notice: SessionNotice | null): void => {
    csrf = null;
    publish({ phase: 'signed-out', notice });
  };
  const supersede = (): number => {
    for (const controller of controllers) controller.abort();
    controllers.clear();
    reading = null;
    return ++epoch;
  };

  async function request(method: 'GET' | 'POST', path: string, headers: Record<string, string>, mine: number): Promise<Outcome> {
    const controller = new AbortController();
    controllers.add(controller);
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
      // Exact media type (as commandCenterClient.ts): `\b` would also admit application/json-patch+json.
      const json = res.status === 200 && /^application\/json\s*(?:;|$)/i.test(res.headers.get('content-type') ?? '');
      const body: unknown = json ? await res.json().catch(() => undefined) : undefined;
      return mine === epoch ? { kind: 'response', status: res.status, body } : { kind: 'superseded' };
    } catch {
      // A timeout is an outage; an abort by a newer operation (or an unmount) is not an answer at all.
      return mine === epoch ? { kind: 'failed' } : { kind: 'superseded' };
    } finally {
      clearTimeout(timer);
      controllers.delete(controller);
    }
  }

  function bootstrap(): Promise<void> {
    if (busy !== null) return busy; // an exchange or logout decides the state; a read would race it
    if (reading !== null) return reading;
    const mine = supersede();
    const run = (async (): Promise<void> => {
      try {
        const outcome = await request('GET', ADMIN_SESSION_PATHS.current, {}, mine);
        if (outcome.kind === 'superseded' || mine !== epoch) return;
        const token = csrfOf(outcome);
        if (token !== null) return activate(token);
        const status = statusOf(outcome);
        if (status === 401) return end(heldSession ? 'expired' : null);
        if (status === 403) return end('denied');
        // Unconfirmed — an outage, a rate limit, a malformed or unreachable answer. A held session
        // is kept (it may still be valid) but hidden; otherwise the sign-in page says why.
        if (state.phase === 'active') return publish({ phase: 'active', interrupted: true, signOutFailed: false });
        end(status === 429 ? 'rate-limited' : 'unavailable');
      } finally {
        if (reading === run) reading = null;
      }
    })();
    reading = run;
    return run;
  }

  function exchange(idToken: string): Promise<void> {
    if (busy !== null) return busy; // duplicate suppression: one login exchange at a time
    const mine = supersede(); // a pending read can no longer decide the state
    if (typeof idToken !== 'string' || idToken.length > MAX_BEARER_LENGTH || !BEARER_RE.test(idToken)) {
      end('denied');
      return Promise.resolve();
    }
    publish({ phase: 'signing-in' });
    const run = (async (): Promise<void> => {
      try {
        const outcome = await request('POST', ADMIN_SESSION_PATHS.login, { Authorization: `Bearer ${idToken}`, [INTENT_HEADER]: '1' }, mine);
        if (outcome.kind === 'superseded' || mine !== epoch) return;
        if (csrfOf(outcome) === null) {
          const status = statusOf(outcome);
          if (status === 401 || status === 403) return end('denied'); // one generic refusal, whatever the reason
          return end(status === 429 ? 'rate-limited' : 'unavailable');
        }
        // The login answered, but the shell waits until a session read — riding the new cookie,
        // never the bearer — confirms it; that read supplies the CSRF token the page keeps.
        const check = await request('GET', ADMIN_SESSION_PATHS.current, {}, mine);
        if (check.kind === 'superseded' || mine !== epoch) return;
        const token = csrfOf(check);
        if (token !== null) return activate(token);
        const status = statusOf(check);
        end(status === 403 ? 'denied' : status === 429 ? 'rate-limited' : 'unavailable');
      } finally {
        if (busy === run) busy = null;
      }
    })();
    busy = run;
    return run;
  }

  function logout(): Promise<void> {
    if (busy !== null) return busy;
    if (state.phase !== 'active') return Promise.resolve();
    const mine = supersede();
    publish({ phase: 'signing-out' });
    const post = (): Promise<Outcome> =>
      request('POST', ADMIN_SESSION_PATHS.logout, { [INTENT_HEADER]: '1', [SESSION_CSRF_HEADER]: csrf ?? '' }, mine);
    // 204 ended the session; 401 means it had already ended.
    const ended = (outcome: Outcome): boolean => statusOf(outcome) === 204 || statusOf(outcome) === 401;
    const signedOut = (notice: 'logged-out' | 'logged-out-unconfirmed'): void => {
      heldSession = false;
      end(notice);
    };
    const run = (async (): Promise<void> => {
      try {
        const first = await post();
        if (first.kind === 'superseded' || mine !== epoch) return;
        if (ended(first)) return signedOut('logged-out');
        // Anything else leaves it unproven. Ask the boundary: no session means the cookie is gone;
        // a session means a stale token (it rotated in another tab) or a transient fault — retry once.
        const check = await request('GET', ADMIN_SESSION_PATHS.current, {}, mine);
        if (check.kind === 'superseded' || mine !== epoch) return;
        // Gone after a stale-token refusal: nothing was left to revoke. Gone after an outage or a lost
        // answer: the cookie was cleared, but the server may not have revoked the record, which then
        // lapses at its idle timeout — the page says so rather than claim a confirmed sign-out.
        if (statusOf(check) === 401) return signedOut(statusOf(first) === 403 ? 'logged-out' : 'logged-out-unconfirmed');
        const token = csrfOf(check);
        if (token !== null) {
          csrf = token;
          const second = await post();
          if (second.kind === 'superseded' || mine !== epoch) return;
          if (ended(second)) return signedOut('logged-out');
        }
        // Confirmed neither way (a 503 may already have cleared the cookie): hidden until a re-read answers.
        publish({ phase: 'active', interrupted: true, signOutFailed: true });
      } finally {
        if (busy === run) busy = null;
      }
    })();
    busy = run;
    return run;
  }

  return Object.freeze({
    getState: () => state,
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    bootstrap,
    exchange,
    logout,
    expire(): void {
      if (busy !== null || state.phase !== 'active') return;
      supersede();
      end('expired');
    },
    abort(): void {
      supersede();
      busy = null;
    },
  });
}
