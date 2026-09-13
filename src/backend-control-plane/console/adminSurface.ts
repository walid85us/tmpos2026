// Phase 4.0 M4 — which surface a page is: the tenant application or the administration
// console. Decided from the address before either loads (src/main.tsx), so the two never
// share a page: no tenant-app code, tenant Firebase instance or tenant session runs on a
// console page, and the reverse.
//
// Production (docs/phase-4/03 §2 #1, ADR-02): the console runs only on a configured,
// dedicated administration origin — VITE_ADMIN_CONSOLE_ORIGINS, a comma-separated list of
// exact https origins fixed at build time — and owns that origin entirely. Anywhere else the
// console path renders a refusal and makes no administrative request, and a missing or
// malformed list refuses on every host.
//
// Local development (a Vite dev server only): the console shares the development host under
// CONSOLE_BASE. Vite replaces `import.meta.env.DEV` with `false` in a production build, so
// that branch is compiled out (tests/browser/admin-console.browser.test.mjs proves it).
//
// Either way, an API address (/admin/v1, /api/v1) is never a page on any origin: it is settled
// before every other rule, and src/main.tsx renders a bounded "not found" for it.

export const CONSOLE_BASE = '/admin';

export type Surface = 'tenant' | 'admin' | 'admin-refused' | 'api-path';

/** The versioned API namespaces the server reserves (server/runtime/adminWeb.ts API_PREFIXES). */
export const API_PREFIXES = Object.freeze(['/api/v1', '/admin/v1'] as const);

/** The configured administration origins, or null when the list is absent, not exact, or ambiguous. */
export function parseAdminOrigins(raw: unknown): readonly string[] | null {
  if (typeof raw !== 'string' || raw === '') return null;
  const origins: string[] = [];
  for (const entry of raw.split(',')) {
    if (entry.includes('*')) return null; // never a wildcard (server/runtime/requestSecurity.ts normalizeOrigin)
    let url: URL;
    try {
      url = new URL(entry);
    } catch {
      return null;
    }
    // Exactly its own canonical https origin: no path, whitespace, case variant or default port.
    if (url.protocol !== 'https:' || url.origin !== entry || origins.includes(entry)) return null;
    origins.push(entry);
  }
  return Object.freeze(origins);
}

export function isConsolePath(pathname: string): boolean {
  return pathname === CONSOLE_BASE || pathname.startsWith(`${CONSOLE_BASE}/`);
}

/**
 * Whether an address is in an API namespace, by the one canonical rule shared with
 * server/runtime/adminWeb.ts isApiPath (ledger item 20): the path is decoded exactly once, and a
 * malformed one counts as API (the not-found page, never the console); then every backslash,
 * literal or decoded from %5C, is a slash; case is ignored; empty and '.' segments drop and '..'
 * resolves, never above the root.
 */
export function isApiPath(pathname: string): boolean {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname).replace(/\\/g, '/');
  } catch {
    return true;
  }
  const segments: string[] = [];
  for (const segment of decoded.toLowerCase().split('/')) {
    if (segment === '..') segments.pop();
    else if (segment !== '' && segment !== '.') segments.push(segment);
  }
  const path = `/${segments.join('/')}`;
  return API_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

/** The production rule, for any origin and a path outside the API namespaces. */
export function productionSurface(origin: string, pathname: string, adminOrigins: readonly string[] | null): Surface {
  if (adminOrigins !== null && adminOrigins.includes(origin)) return 'admin';
  return isConsolePath(pathname) ? 'admin-refused' : 'tenant';
}

export function currentSurface(location: { readonly origin: string; readonly pathname: string }): Surface {
  if (isApiPath(location.pathname)) return 'api-path'; // first: on any origin, in any build
  // Only a page the Vite dev server itself serves: DEV and MODE are build inputs (a build run with
  // NODE_ENV=development and --mode development folds both to true), but `import.meta.hot` exists
  // only under the dev server and is undefined in every build.
  if (import.meta.env.DEV && import.meta.env.MODE === 'development' && import.meta.hot !== undefined) {
    return isConsolePath(location.pathname) ? 'admin' : 'tenant';
  }
  return productionSurface(location.origin, location.pathname, parseAdminOrigins(import.meta.env.VITE_ADMIN_CONSOLE_ORIGINS));
}
