// Phase 4.0 M3 — the one closed security-header policy for every runtime response.
//
// `lockSecurityHeaders` re-asserts the policy inside writeHead — the last moment
// headers can change, and the call that res.end()/res.write()/res.json() all reach
// implicitly — so no handler, refusal or error path can drop or weaken a mandatory
// header. A header passed inline to writeHead would win Node's merge, so every
// mandatory name among them is stripped first. The CSP is API-only: responses are
// JSON, never documents, so nothing may load, frame or submit.
//
// Phase 4.0 M4 — HSTS is a flag of the deployment boundary, never of a handler: it is
// sent only when the caller says responses leave over TLS (server.ts: the production
// classification); a handler can neither add nor weaken it, by setHeader or inline.
import type { ServerResponse } from 'node:http';

export const SECURITY_HEADERS = Object.freeze({
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'geolocation=(), camera=(), microphone=(), payment=(), usb=()',
  'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  'Cross-Origin-Resource-Policy': 'same-origin',
} as const);

export const HSTS_HEADER = Object.freeze({
  name: 'Strict-Transport-Security',
  value: 'max-age=31536000; includeSubDomains',
} as const);

const MANDATORY = new Set([...Object.keys(SECURITY_HEADERS), HSTS_HEADER.name].map((name) => name.toLowerCase()));

export function applySecurityHeaders(res: ServerResponse, hsts = false): void {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value);
  if (hsts) res.setHeader(HSTS_HEADER.name, HSTS_HEADER.value);
}

/** Inline writeHead headers minus every mandatory name (object or flat [name, value, ...] form). */
function withoutMandatory(headers: unknown): unknown {
  if (Array.isArray(headers)) {
    const kept: unknown[] = [];
    for (let i = 0; i < headers.length; i += 2) {
      if (!MANDATORY.has(String(headers[i]).toLowerCase())) kept.push(headers[i], headers[i + 1]);
    }
    return kept;
  }
  if (typeof headers === 'object' && headers !== null) {
    return Object.fromEntries(Object.entries(headers).filter(([name]) => !MANDATORY.has(name.toLowerCase())));
  }
  return headers; // a statusMessage string
}

export function lockSecurityHeaders(res: ServerResponse, hsts = false): void {
  const writeHead = res.writeHead as unknown as (this: ServerResponse, ...args: unknown[]) => ServerResponse;
  res.writeHead = function lockedWriteHead(this: ServerResponse, ...args: unknown[]): ServerResponse {
    applySecurityHeaders(this, hsts);
    if (!hsts) this.removeHeader(HSTS_HEADER.name); // nor may a handler's setHeader add it
    // Node may take the header map from the 2nd OR 3rd argument; strings pass through.
    for (let i = 1; i < args.length; i++) args[i] = withoutMandatory(args[i]);
    return writeHead.apply(this, args);
  } as unknown as ServerResponse['writeHead'];
}
