// Phase 4.0 M4 — the admin web surface's response policy (G-WEBHARDEN).
//
// The frontend is one Vite SPA; the tenant and administrative APIs live on the runtime under
// API_PREFIXES. A frontend server must never answer an API path with the SPA document — the
// console would render and redirect instead of the request failing — so the guard answers it
// with the runtime's own bounded JSON 404 and API header policy. Documents and static assets
// carry the admin document CSP below. Provider-free: the Firebase auth domain is handed in
// and accepted only as a bare hostname, so configuration can never widen the policy.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { API_PREFIXES } from './routes.js';
import { HSTS_HEADER, SECURITY_HEADERS } from './securityHeaders.js';

/**
 * The one API-path decision; the console mirrors it and an integration test pins parity. Fail
 * closed: the path is percent-decoded exactly once (a malformed escape is API); then every `\`,
 * literal or decoded from `%5C`, is `/`; case is ignored; empty and `.` segments are dropped and
 * `..` resolved, never above the root.
 */
export function isApiPath(raw: string): boolean {
  const path = canonicalPath(raw);
  return path === null || API_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

/** The canonical form isApiPath judges, or null for a malformed escape. */
export function canonicalPath(raw: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw).replaceAll('\\', '/');
  } catch {
    return null;
  }
  const segments: string[] = [];
  for (const s of decoded.toLowerCase().split('/')) {
    if (s === '..') segments.pop();
    else if (s !== '' && s !== '.') segments.push(s);
  }
  return `/${segments.join('/')}`;
}

// Two or more lowercase DNS labels, the last starting with a letter (so never an IP literal):
// no scheme, port, path, wildcard, whitespace or quote.
const HOSTNAME_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * The admin document CSP; each allowance is the minimum the implemented console needs:
 * - script-src https://apis.google.com and frame-src https://<authDomain>: only the Google
 *   sign-in popup resolver (it loads apis.google.com/js/api.js and frames <authDomain>/__/auth/iframe);
 * - connect-src https://identitytoolkit.googleapis.com: password, TOTP and popup sign-in;
 * - form-action 'none': a native form submit can never put the entered credentials in a URL;
 * - no 'unsafe-inline', 'unsafe-eval' or wildcard, deliberately: a Vite production build emits
 *   no inline script, and React style props are CSSOM writes, which CSP does not govern;
 * - phone MFA is excluded: reCAPTCHA needs the www.google.com / www.gstatic.com script hosts,
 *   known CSP-bypass hosts, so nothing here admits it.
 */
export function adminDocumentCsp(authDomain: string): string {
  if (typeof authDomain !== 'string' || !HOSTNAME_RE.test(authDomain)) throw new Error('auth_domain_invalid');
  return [
    "default-src 'none'",
    "script-src 'self' https://apis.google.com",
    "style-src 'self'",
    "img-src 'self'",
    "connect-src 'self' https://identitytoolkit.googleapis.com",
    `frame-src https://${authDomain}`,
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
}

// Exactly `true`, as app.ts: a truthy stand-in such as the string "false" never turns HSTS on.
const hstsFor = (https: boolean): Record<string, string> => (https === true ? { [HSTS_HEADER.name]: HSTS_HEADER.value } : {});

// A document is fetched fresh every time; a Vite /assets/ file carries its content hash in its
// name, so it may be cached for good; any other file (a favicon) is revalidated on every use.
const CACHE: Readonly<Record<'document' | 'asset' | 'file', string>> = Object.freeze({
  document: 'no-store',
  asset: 'public, max-age=31536000, immutable',
  file: 'no-cache',
});

/** The admin surface's headers; a document, an /assets/ file and any other file differ only in caching. */
export function adminWebHeaders(
  kind: 'document' | 'asset' | 'file', opts: { authDomain: string; https: boolean },
): Readonly<Record<string, string>> {
  return Object.freeze({
    'Content-Security-Policy': adminDocumentCsp(opts.authDomain),
    'X-Frame-Options': SECURITY_HEADERS['X-Frame-Options'],
    'X-Content-Type-Options': SECURITY_HEADERS['X-Content-Type-Options'],
    'Referrer-Policy': SECURITY_HEADERS['Referrer-Policy'],
    'Permissions-Policy': SECURITY_HEADERS['Permissions-Policy'],
    'Cross-Origin-Resource-Policy': SECURITY_HEADERS['Cross-Origin-Resource-Policy'],
    'Cache-Control': CACHE[kind],
    ...hstsFor(opts.https),
  });
}

/**
 * How a frontend server answers `pathname`. An API path is refused even if a file exists there.
 * `hasFile` answers for the servable files other than the document, by the exact raw path (Vite's
 * content hashes are case-sensitive): an /assets/ file is an 'asset', any other a 'file'. A missing
 * /assets/ file is a 404, never the document (a stale chunk must not come back as HTML); every other
 * path, the document's own included, is the SPA document.
 */
export function classifyAdminWebPath(
  pathname: string, hasFile: (p: string) => boolean,
): 'api' | 'asset' | 'file' | 'missing' | 'document' {
  if (isApiPath(pathname)) return 'api';
  const hashed = pathname.startsWith('/assets/');
  if (hasFile(pathname)) return hashed ? 'asset' : 'file';
  return hashed ? 'missing' : 'document';
}

/** The runtime's bounded 404 for an API path that reached a frontend server; it never echoes the path. */
export function apiPathRefusal(opts: { https: boolean }): {
  readonly status: 404; readonly headers: Readonly<Record<string, string>>; readonly body: string;
} {
  return Object.freeze({
    status: 404,
    headers: Object.freeze({
      ...SECURITY_HEADERS,
      ...hstsFor(opts.https),
      'Content-Type': 'application/json; charset=utf-8',
    }),
    body: JSON.stringify({ error: 'not_found' }),
  });
}

/** Both the raw path and its URL-normalized form (dot segments resolved) are judged; unparsable is API. */
function targetIsApi(url: unknown): boolean {
  if (typeof url !== 'string') return true;
  let normalized: string;
  try {
    normalized = new URL(url, 'http://x').pathname;
  } catch {
    return true;
  }
  return isApiPath(normalized) || isApiPath(url.split(/[?#]/, 1)[0]);
}

/** Connect-style middleware for a frontend server: an API path gets `apiPathRefusal`, all else `next`. */
export function createApiPathGuard(opts: { https: boolean }) {
  const refusal = apiPathRefusal(opts);
  return function apiPathGuard(req: IncomingMessage, res: ServerResponse, next: () => void): void {
    if (!targetIsApi(req.url)) {
      next();
      return;
    }
    res.writeHead(refusal.status, refusal.headers);
    res.end(refusal.body);
  };
}
