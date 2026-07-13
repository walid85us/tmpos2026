// Phase 3.0 M3 — DEV-only controlled-action request-security / same-origin / CSRF guard.
//
// PURE, dependency-free header evaluation. No network, no auth, no DB, no env. Runs BEFORE authentication, the
// rate limiter, the authorization guard, the handler, and the advisory marker (see the express adapter). A denial
// here consumes NO idempotency state and emits NO marker.
//
// TRUSTED-ORIGIN ENFORCEMENT (M3 correction — EXACT match, not syntax-only):
//   The DEV app is served from the single Replit Project-Editor development origin (REPLIT_DEV_DOMAIN). The
//   browser loads that origin and calls the SAME-ORIGIN relative path `/__identity/dev/bcp/actions/...`; Vite
//   proxies it to the identity API (:5002) with `changeOrigin: true`. `changeOrigin` rewrites the upstream `Host`
//   header — it does NOT alter the browser `Origin` header, which is forwarded verbatim. So the identity API
//   validates the browser `Origin` DIRECTLY, by EXACT equality against the one trusted origin it resolves from
//   REPLIT_DEV_DOMAIN (platform-provided config, not a new secret). There is NO suffix/substring/prefix/endsWith
//   matching, the Origin is NEVER reflected, and NO wildcard is ever accepted. If the trusted origin cannot be
//   resolved (env absent/malformed/ambiguous), the guard fails CLOSED (request-security-unavailable) and no
//   downstream Firebase/DB/rate/idempotency/handler/marker work runs.
//   Layered with: Fetch-Metadata `Sec-Fetch-Site: cross-site` rejection, the required non-safelisted custom
//   header `X-BCP-Action-Intent` (preflight-gated cross-origin), strict `application/json`, Bearer-only authority
//   (no cookie/ambient authority ⇒ classic CSRF structurally impossible), and POST-only.
//
// Server-side only. Never imported by the client bundle.

/** Exact lowercase header name and required value for the controlled-action intent assertion. */
export const BCP_ACTION_INTENT_HEADER = 'x-bcp-action-intent';
export const BCP_ACTION_INTENT_VALUE = 'acknowledge-readiness-review';

export type RequestSecurityDenyCode =
  | 'method_not_allowed'
  | 'unsupported_media_type'
  | 'missing_action_intent'
  | 'invalid_action_intent'
  | 'cross_site'
  | 'origin_missing'
  | 'malformed_origin'
  | 'origin_mismatch'
  | 'trusted_origin_unavailable';

/** Authority-neutral, already-normalized single-string view of the security-relevant request headers. */
export interface RequestSecurityInput {
  method: string;
  contentType: string | undefined;
  origin: string | undefined;
  secFetchSite: string | undefined;
  actionIntent: string | undefined;
}

/** The single trusted development origin, or a fail-closed marker when it cannot be resolved. Single-interface
 *  (optional `origin`) form because this project is non-strict TS where boolean-discriminant narrowing is lossy. */
export type TrustedOriginResolution = { ok: boolean; origin?: string };

/** Single-interface (optional `code`) form — non-strict TS boolean-discriminant narrowing is lossy. */
export type RequestSecurityResult = { ok: boolean; code?: RequestSecurityDenyCode };

/**
 * Strict request-Origin normalization: returns the canonical origin ONLY when the raw Origin header IS its own
 * exact canonical origin. The round-trip (`u.origin === origin`) rejects userinfo, path/query/fragment, wrong
 * scheme, trailing slash, explicit default port, backslashes, and all WHATWG normalization tricks.
 */
function normalizeRequestOrigin(origin: string): string | null {
  let u: URL;
  try { u = new URL(origin); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (u.username !== '' || u.password !== '') return null;   // credentials in URL
  if (u.pathname !== '/' && u.pathname !== '') return null;  // path beyond root
  if (u.search !== '' || u.hash !== '') return null;         // query / fragment
  return u.origin === origin ? u.origin : null;              // must round-trip exactly
}

/**
 * Resolve the ONE trusted development origin from REPLIT_DEV_DOMAIN (accepts a bare hostname → https://<host>, or
 * an absolute http(s) URL). Fails CLOSED on absent/empty/ambiguous (comma/whitespace = multiple) / malformed /
 * non-http / userinfo / path input. Malformed absolute input that merely CANONICALIZES to a clean origin (e.g.
 * `https:////host`, extra slashes) is rejected too: the candidate must equal its canonical origin (± one trailing
 * slash), so only a genuinely clean bare-host or absolute-origin representation is trusted.
 */
export function resolveTrustedOrigin(rawReplitDevDomain: string | undefined): TrustedOriginResolution {
  if (typeof rawReplitDevDomain !== 'string') return { ok: false };
  const trimmed = rawReplitDevDomain.trim();
  if (trimmed === '' || /[,\s]/.test(trimmed)) return { ok: false }; // empty or ambiguous (multiple values)
  const hasScheme = /^https?:\/\//i.test(trimmed);
  if (!hasScheme && /[/\\@]/.test(trimmed)) return { ok: false };    // bare hostname must be host[:port] only
  const candidate = hasScheme ? trimmed : `https://${trimmed}`;
  let u: URL;
  try { u = new URL(candidate); } catch { return { ok: false }; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { ok: false };
  if (u.username !== '' || u.password !== '') return { ok: false };
  if (u.pathname !== '/' && u.pathname !== '') return { ok: false };
  if (u.search !== '' || u.hash !== '') return { ok: false };
  if (candidate !== u.origin && candidate !== `${u.origin}/`) return { ok: false }; // reject extra-slash/non-canonical
  return { ok: true, origin: u.origin };
}

/**
 * Fail-closed request-security evaluation with EXACT trusted-origin enforcement. `trusted` is injected (resolved
 * by the caller from REPLIT_DEV_DOMAIN) for deterministic tests. Every non-ok result maps at the adapter to a
 * sanitized 403 SAFE DENIED, EXCEPT `trusted_origin_unavailable` → 503 (server misconfig). No info leak, no marker.
 */
export function evaluateRequestSecurity(input: RequestSecurityInput, trusted: TrustedOriginResolution): RequestSecurityResult {
  if (input.method !== 'POST') return { ok: false, code: 'method_not_allowed' };

  // Exact media type (params like `; charset=utf-8` allowed) — `application/json-malformed` must NOT pass.
  const mediaType = (input.contentType ?? '').toLowerCase().split(';')[0].trim();
  if (mediaType !== 'application/json') return { ok: false, code: 'unsupported_media_type' };

  // Fetch Metadata: reject the definitively-cross-origin case (the browser sets this, JS cannot).
  if (input.secFetchSite === 'cross-site') return { ok: false, code: 'cross_site' };

  // Trusted origin must be resolvable — else fail closed BEFORE any origin comparison (server misconfig).
  if (!trusted.ok) return { ok: false, code: 'trusted_origin_unavailable' };

  // The request Origin header is REQUIRED, must be a clean absolute origin, and must EXACTLY equal the trusted
  // origin. No suffix/substring/prefix/endsWith; never reflected; never wildcard.
  if (input.origin === undefined) return { ok: false, code: 'origin_missing' };
  const requestOrigin = normalizeRequestOrigin(input.origin);
  if (requestOrigin === null) return { ok: false, code: 'malformed_origin' };
  if (requestOrigin !== trusted.origin) return { ok: false, code: 'origin_mismatch' };

  // The custom intent header — the CSRF linchpin. Exact match; no trimming (a padded value is rejected).
  if (input.actionIntent === undefined) return { ok: false, code: 'missing_action_intent' };
  if (input.actionIntent !== BCP_ACTION_INTENT_VALUE) return { ok: false, code: 'invalid_action_intent' };

  return { ok: true };
}

/** Only a single string header value is trusted; arrays/duplicates normalize to undefined (fail closed). */
function single(v: string | string[] | undefined): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

/** Extract the normalized security view from an Express-style (lowercased) headers object. */
export function readRequestSecurityInput(
  headers: Record<string, string | string[] | undefined>,
  method: string,
): RequestSecurityInput {
  return {
    method,
    contentType: single(headers['content-type']),
    origin: single(headers['origin']),
    secFetchSite: single(headers['sec-fetch-site']),
    actionIntent: single(headers[BCP_ACTION_INTENT_HEADER]),
  };
}
