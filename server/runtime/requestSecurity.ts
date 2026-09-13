// Phase 4.0 M3 — CSRF / exact-origin enforcement for state-changing requests.
//
// Generalises the approved controlled-action contract (the BCP request-security
// guard; restated here because the production runtime may not import it) from one
// route to EVERY unsafe route, in this order:
//   1. Fetch-Metadata `Sec-Fetch-Site: cross-site` is refused (set by the browser,
//      not by page script).
//   2. No configured trusted origin ⇒ refused (fail closed; startup also refuses to
//      register an unsafe route without one).
//   3. `Origin` is required, must be its own exact canonical origin, and must EXACTLY
//      equal a trusted origin — no suffix/substring/prefix match, never reflected,
//      never a wildcard.
//   4. The non-safelisted custom header `X-TMPOS-CSRF: 1` is required: a cross-origin
//      page cannot send it without a CORS preflight, and the runtime answers no
//      preflight (OPTIONS is never admitted).
// Forwarding headers play no part, and a duplicated header (delivered as a list or
// joined with a comma) never matches. Authority is Bearer-only today, so there is
// no ambient cookie to ride; the M4 session-bound token is added on top of this
// check, never instead of it.
import { EnforcementSetupError } from './routes.js';

export const UNSAFE_METHODS: ReadonlySet<string> = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
export const CSRF_HEADER = 'x-tmpos-csrf';
export const CSRF_HEADER_VALUE = '1';

export type RequestSecurityRefusal =
  | 'csrf_cross_site'
  | 'csrf_unavailable'
  | 'csrf_origin_missing'
  | 'csrf_origin_malformed'
  | 'csrf_origin_mismatch'
  | 'csrf_token_missing'
  | 'csrf_token_invalid';

/**
 * The origin, only when `raw` already IS its own exact canonical http(s) origin. The
 * round trip rejects case variants, paths, queries, fragments, userinfo, explicit
 * default ports, backslashes and surrounding whitespace in one comparison.
 */
export function normalizeOrigin(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.includes('*')) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  return url.origin === raw ? raw : null;
}

/** The trusted-origin allowlist; a single non-canonical entry fails startup closed. */
export function parseTrustedOrigins(list: readonly unknown[] | undefined): ReadonlySet<string> {
  const trusted = new Set<string>();
  for (const entry of list ?? []) {
    const origin = normalizeOrigin(entry);
    if (origin === null) throw new EnforcementSetupError('trusted_origin_invalid');
    trusted.add(origin);
  }
  return trusted;
}

const single = (v: string | string[] | undefined): string | undefined => (typeof v === 'string' ? v : undefined);

/** null when the unsafe request carries valid CSRF/origin evidence, else the refusal code. */
export function evaluateRequestSecurity(
  headers: Record<string, string | string[] | undefined>,
  trusted: ReadonlySet<string>,
): RequestSecurityRefusal | null {
  if (single(headers['sec-fetch-site']) === 'cross-site') return 'csrf_cross_site';
  if (trusted.size === 0) return 'csrf_unavailable';
  const origin = single(headers.origin);
  if (origin === undefined) return 'csrf_origin_missing';
  const normalized = normalizeOrigin(origin);
  if (normalized === null) return 'csrf_origin_malformed';
  if (!trusted.has(normalized)) return 'csrf_origin_mismatch';
  const token = single(headers[CSRF_HEADER]);
  if (token === undefined) return 'csrf_token_missing';
  return token === CSRF_HEADER_VALUE ? null : 'csrf_token_invalid';
}
