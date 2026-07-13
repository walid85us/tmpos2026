// Phase 3.0 M3 — DEV-only controlled-action browser client + pure presentation helpers.
//
// Transport: POST, same-origin, application/json to the `/__identity` proxy path, carrying the CURRENT signed-in
// user's FRESH Firebase ID token as `Authorization: Bearer` plus the required `X-BCP-Action-Intent` header. The
// token is fetched per-submit and used only for the immediate request — never displayed, logged, persisted,
// cached, or placed in React state. The body carries ONLY { confirm, reason, idempotencyKey, lensKey } — never
// actor/uid/internalUserId/email/role/visibility/permission/parity/cap/plan. Idempotency keys use Web Crypto
// (never Math.random). Every response is normalized to a bounded, sanitized discriminated-union state.
//
// The Firebase token fetch is behind a DEFAULT provider that lazily (dynamic-import) reads the existing client
// Firebase Auth — so importing this module for pure tests pulls in NO Firebase. The server remains the sole
// authority; nothing here is trusted for authorization.

const viteEnv = (import.meta as unknown as { env?: { VITE_IDENTITY_API_BASE?: string } }).env ?? {};
const API_BASE = (viteEnv.VITE_IDENTITY_API_BASE || '/__identity').replace(/\/+$/, '');
/** Same-origin proxy path for the controlled action (mirrors BCP_ACTION_ACK_PROXY_PATH on the server). */
export const ACK_ACTION_URL = `${API_BASE}/dev/bcp/actions/acknowledge-readiness-review`;

export const ACTION_INTENT_HEADER = 'X-BCP-Action-Intent';
export const ACTION_INTENT_VALUE = 'acknowledge-readiness-review';
/** Same-origin proxy path for the READ-ONLY eligibility probe (bodyless POST; mirrors BCP_ELIGIBILITY_PROXY_PATH). */
export const ELIGIBILITY_ACTION_URL = `${API_BASE}/dev/bcp/actions/acknowledge-readiness-review/eligibility`;
/** Dedicated eligibility intent value — DISTINCT from the action's ACTION_INTENT_VALUE. */
export const ELIGIBILITY_INTENT_VALUE = 'acknowledge-readiness-review-eligibility';
export const REASON_MIN = 3;
export const REASON_MAX = 280;
/** Lens options shown in the selector (ALL first, then C-01..C-07). */
export const ACK_LENS_OPTIONS = ['ALL', 'C-01', 'C-02', 'C-03', 'C-04', 'C-05', 'C-06', 'C-07'] as const;
export type AckLensOption = (typeof ACK_LENS_OPTIONS)[number];

export type AckClientResult =
  | { kind: 'success'; correlationKey?: string; lensKey?: string }
  | { kind: 'duplicate' }
  | { kind: 'invalid'; code?: string }
  | { kind: 'auth_required' }
  | { kind: 'forbidden' }
  | { kind: 'request_denied' }
  | { kind: 'conflict' }
  | { kind: 'rate_limited'; retryAfterSeconds?: number }
  | { kind: 'unavailable'; retryable?: boolean }
  | { kind: 'error' };

/** Read a single bounded string field from an unknown body without trusting its shape. */
function str(body: unknown, key: string): string | undefined {
  if (body && typeof body === 'object' && typeof (body as Record<string, unknown>)[key] === 'string') {
    return (body as Record<string, string>)[key];
  }
  return undefined;
}

/** Pure, no-throw normalization of the (status, body, retry-after) into a bounded client state. */
export function classifyAckResponse(status: number, body: unknown, retryAfterHeader?: string | null): AckClientResult {
  const statusField = str(body, 'status');
  if (status === 200) {
    if (statusField === 'duplicate') return { kind: 'duplicate' };
    return { kind: 'success', correlationKey: str(body, 'correlationKey'), lensKey: str(body, 'lensKey') };
  }
  if (status === 400) return { kind: 'invalid', code: str(body, 'code') };
  if (status === 401) return { kind: 'auth_required' };
  if (status === 403) return statusField === 'request_denied' ? { kind: 'request_denied' } : { kind: 'forbidden' };
  // 404 = flag OFF / dev-only (feature not currently exposed) — a config state, not a transient error.
  if (status === 404) return { kind: 'unavailable', retryable: false };
  if (status === 409) return { kind: 'conflict' };
  if (status === 429) {
    const n = retryAfterHeader ? parseInt(retryAfterHeader, 10) : NaN;
    return { kind: 'rate_limited', retryAfterSeconds: Number.isFinite(n) && n > 0 ? n : undefined };
  }
  if (status === 503) return { kind: 'unavailable', retryable: true };
  return { kind: 'error' };
}

/** Web-Crypto idempotency key (never Math.random); matches the server key format /^[A-Za-z0-9._-]{8,80}$/. */
export function newIdempotencyKey(): string {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  if (c && typeof c.getRandomValues === 'function') {
    const bytes = new Uint8Array(16);
    c.getRandomValues(bytes);
    return 'ik-' + Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  }
  // Fail closed — never fall back to Math.random. Web Crypto is present in every supported runtime.
  throw new Error('web_crypto_unavailable');
}

/**
 * One OPAQUE idempotency key per OPEN-DIALOG attempt, held CONSTANT for every submit in that attempt and
 * INDEPENDENT of the payload. The server decides duplicate-vs-conflict from its own payload fingerprint:
 *   - unchanged repeat (same key, same lens/reason)      → server 200 duplicate ("Already acknowledged")
 *   - changed payload  (same key, different lens/reason)  → server 409 conflict
 * A NEW attempt (dialog reopened) starts with no key, so the next submit mints a fresh one → success. The
 * key is never derived from payload/identity and is never logged, persisted, or shown.
 */
export interface IdempotencyAttempt { readonly key: string | null; }

/** A fresh attempt with no key yet — the first submit mints one. */
export function newIdempotencyAttempt(): IdempotencyAttempt { return { key: null }; }

/**
 * Resolve the key to send for a submit within this attempt: reuse the attempt's key, minting exactly once
 * when the attempt has none. Payload-independent by construction. Returns the (possibly updated) attempt so
 * the same key is reused for every later submit in the same attempt.
 */
export function resolveAttemptKey(
  attempt: IdempotencyAttempt,
  mint: () => string = newIdempotencyKey,
): { attempt: IdempotencyAttempt; key: string } {
  if (attempt.key !== null) return { attempt, key: attempt.key };
  const key = mint();
  return { attempt: { key }, key };
}

/** Plain-text charset the server accepts (mirrors sanitizeAckReason on the server). Presentation only. */
const REASON_SAFE_CHARSET = /^[A-Za-z0-9 .,:;'"()\-_/]+$/;

/** Presentation-only reason validation mirroring the server bounds + charset. The server remains authoritative. */
export function validateReasonForSubmit(reason: string): { ok: boolean; message?: string } {
  const t = reason.trim();
  if (t.length < REASON_MIN) return { ok: false, message: `Enter at least ${REASON_MIN} characters.` };
  if (t.length > REASON_MAX) return { ok: false, message: `Keep the reason under ${REASON_MAX} characters.` };
  if (!REASON_SAFE_CHARSET.test(t)) return { ok: false, message: 'Use plain text only (letters, numbers, basic punctuation).' };
  return { ok: true };
}

export interface AckDisplay { tone: 'success' | 'info' | 'warning' | 'error'; title: string; detail: string; }

/** Map a client result to a distinct, accessible (tone + title + detail — never color-only) display. */
export function describeAckResult(r: AckClientResult): AckDisplay {
  switch (r.kind) {
    case 'success': return { tone: 'success', title: 'Acknowledged', detail: 'The readiness review was acknowledged (advisory only).' };
    case 'duplicate': return { tone: 'info', title: 'Already acknowledged', detail: 'This request was already recorded — no duplicate was created.' };
    case 'invalid': return { tone: 'warning', title: 'Check your input', detail: r.code ? `The server rejected the request (${r.code}).` : 'The request was invalid.' };
    case 'auth_required': return { tone: 'warning', title: 'Sign-in required', detail: 'No valid signed-in session was found. Sign in and try again.' };
    case 'forbidden': return { tone: 'error', title: 'Not authorized', detail: 'Your account is not authorized to perform this action.' };
    case 'request_denied': return { tone: 'error', title: 'Request blocked', detail: 'The request failed the same-origin security check.' };
    case 'conflict': return { tone: 'warning', title: 'Conflicting request', detail: 'This key was already used with a different payload. Start a new action.' };
    case 'rate_limited': return { tone: 'warning', title: 'Too many attempts', detail: r.retryAfterSeconds ? `Please wait ${r.retryAfterSeconds}s and try again.` : 'Please wait a moment and try again.' };
    case 'unavailable': return { tone: 'warning', title: 'Temporarily unavailable', detail: 'The action is temporarily unavailable. You can retry shortly.' };
    default: return { tone: 'error', title: 'Something went wrong', detail: 'An unexpected error occurred. No action was recorded.' };
  }
}

export interface AckSubmission { lensKey: string; reason: string; idempotencyKey: string; }
export interface AckClientDeps {
  fetchImpl?: typeof fetch;
  url?: string;
  /** Returns a FRESH Firebase ID token for the signed-in user, or null when there is none. */
  getToken?: () => Promise<string | null>;
  timeoutMs?: number;
}

/** Default token provider: lazily reads the existing client Firebase Auth and force-refreshes the ID token. */
async function defaultGetToken(): Promise<string | null> {
  const { auth } = await import('../../firebase');
  const { getIdToken } = await import('firebase/auth');
  const user = auth.currentUser;
  if (!user) return null;
  return await getIdToken(user, true); // forceRefresh — never cached beyond this call
}

/**
 * Submit the controlled acknowledgement. No-throw: every failure normalizes to a bounded client state. The token
 * is a local const, never returned, logged, or persisted; the reason text is sent only in the request body.
 */
export async function submitAcknowledgeReadinessReview(sub: AckSubmission, deps: AckClientDeps = {}): Promise<AckClientResult> {
  const fetchImpl = deps.fetchImpl ?? (globalThis.fetch as typeof fetch | undefined);
  const url = deps.url ?? ACK_ACTION_URL;
  const getToken = deps.getToken ?? defaultGetToken;
  if (!fetchImpl) return { kind: 'unavailable' };

  let token: string | null;
  try { token = await getToken(); } catch { return { kind: 'auth_required' }; }
  if (!token) return { kind: 'auth_required' };

  const controller = typeof AbortController !== 'undefined' ? new AbortController() : undefined;
  const timer = controller ? setTimeout(() => controller.abort(), deps.timeoutMs ?? 8000) : undefined;

  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      credentials: 'omit', // Bearer carries authority; no cookies/ambient authority.
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        authorization: `Bearer ${token}`,
        [ACTION_INTENT_HEADER]: ACTION_INTENT_VALUE,
      },
      body: JSON.stringify({ confirm: true, reason: sub.reason, idempotencyKey: sub.idempotencyKey, lensKey: sub.lensKey }),
      signal: controller?.signal,
    });
  } catch {
    return { kind: 'unavailable' };
  } finally {
    if (timer) clearTimeout(timer);
  }

  let json: unknown = null;
  try { json = await res.json(); } catch { json = null; }
  const retryAfter = res.headers && typeof res.headers.get === 'function' ? res.headers.get('Retry-After') : null;
  return classifyAckResponse(res.status, json, retryAfter);
}

// ============================ READ-ONLY canonical eligibility probe ============================
// Answers "does the SERVER's authorization chain currently allow this action for the signed-in user?" — so the
// UI enables the control on SERVER eligibility, not on a Firestore role hint. It executes NOTHING: a BODYLESS POST
// (POST used solely so the browser attaches its protected Origin header — same-origin GETs omit it) that is
// strictly read-only and never mutates. The bounded server body is { eligible, status } — no role/permission/cap.

/** Bounded client-side eligibility state (`checking` is set by the UI while the probe is in flight). */
export type EligibilityClientState =
  | 'checking'
  | 'eligible'
  | 'not_authorized'
  | 'authentication_required'
  | 'unavailable'
  | 'error';

/** Pure, no-throw mapping of the (status, bounded body) to a client eligibility state. Fail-closed. */
export function classifyEligibilityResponse(status: number, body: unknown): EligibilityClientState {
  const statusField = str(body, 'status');
  const eligible = !!body && typeof body === 'object' && (body as Record<string, unknown>).eligible === true;
  if (status === 200) return eligible && statusField === 'eligible' ? 'eligible' : 'not_authorized';
  if (status === 401) return 'authentication_required'; // required OR invalid ⇒ a sign-in problem
  if (status === 404) return 'unavailable';             // feature disabled / dev-only
  return 'error';                                        // 403 / 429 / 5xx / malformed ⇒ fail closed, retryable
}

export interface EligibilityClientDeps {
  fetchImpl?: typeof fetch;
  url?: string;
  /** Returns a FRESH Firebase ID token for the signed-in user, or null when there is none. */
  getToken?: () => Promise<string | null>;
  timeoutMs?: number;
}

/**
 * Probe canonical server eligibility. A BODYLESS same-origin POST (POST used SOLELY so the browser reliably
 * attaches its protected `Origin` header — same-origin GETs omit it, which the server exact-matches),
 * credentials:'omit', cache:'no-store', carrying the CURRENT signed-in user's FRESH Firebase ID token as Bearer +
 * the dedicated eligibility intent header. No request body, no Content-Type, no authority fields, and Origin is
 * NEVER set manually (forbidden header — the browser supplies it). The token is a local const — never displayed,
 * logged, persisted, cached, or placed in React state. No-throw: every failure (no user, token failure,
 * 401/403/404/429/5xx, malformed, network) normalizes to a fail-closed state.
 */
export async function checkAcknowledgeEligibility(deps: EligibilityClientDeps = {}): Promise<EligibilityClientState> {
  const fetchImpl = deps.fetchImpl ?? (globalThis.fetch as typeof fetch | undefined);
  const url = deps.url ?? ELIGIBILITY_ACTION_URL;
  const getToken = deps.getToken ?? defaultGetToken;
  if (!fetchImpl) return 'unavailable';

  let token: string | null;
  try { token = await getToken(); } catch { return 'authentication_required'; }
  if (!token) return 'authentication_required';

  const controller = typeof AbortController !== 'undefined' ? new AbortController() : undefined;
  const timer = controller ? setTimeout(() => controller.abort(), deps.timeoutMs ?? 8000) : undefined;

  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: 'POST', // bodyless authenticated RPC-style probe — POST so the browser reliably sends its protected Origin.
      credentials: 'omit',
      cache: 'no-store', // the eligibility answer must never be cached
      headers: {
        // No Content-Type (there is no body). NEVER set Origin manually — it is a forbidden header the browser supplies.
        accept: 'application/json',
        authorization: `Bearer ${token}`,
        [ACTION_INTENT_HEADER]: ELIGIBILITY_INTENT_VALUE,
      },
      signal: controller?.signal,
    });
  } catch {
    return 'error';
  } finally {
    if (timer) clearTimeout(timer);
  }

  let json: unknown = null;
  try { json = await res.json(); } catch { json = null; }
  return classifyEligibilityResponse(res.status, json);
}
