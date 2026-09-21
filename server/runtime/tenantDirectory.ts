// Phase 4.0 M5 — the platform tenant directory: the one bounded read the administration console's Tenant
// Management page lists tenants through (M5-GIAM-D1-P3; G-IAM; docs/phase-4/10 ADR-24).
//
// GET /admin/v1/tenants[?limit=N][&cursor=C] — a session route of the administrative boundary, under the
// established conventions (routes.ts): platform administration lives under /admin/v1, and the path is
// literal. The chain proves the admin session and asks the canonical platform authorizer for
// view_tenants — the platform feature tenant_management at View or above (permissionCatalog.ts) — before
// this handler runs, so a 401, a 403 or an authorization outage never reaches it. The route declares
// `trustedContext: 'required'`: the chain refuses it unless the authorizer resolved the session's actor and
// the one platform grant it decided on, and that trusted scope — never anything the request carries — is
// the only authority this handler acts on. There is no request-selected scope at all.
//
// THE QUERY. Exactly two optional parameters, each at most once and nothing else: `limit`, a decimal
// 1-50 (default 25), and `cursor`, the continuation a previous page returned. Any other key, a repeat, an
// empty pair, an encoding, a non-canonical spelling or an overlong query is a 400 invalid_request, decided
// before any port is asked — so a malformed query reads nothing and changes nothing (this route changes
// nothing at all). The cursor is opaque to the client: 23 base64url characters encoding a version byte and
// the last tenant id of the previous page, accepted only in its one canonical spelling. It carries no
// authority: a caller who forges one can only start a page at another tenant it is already allowed to list.
//
// THE PAGE. The port asks migration 012's routine for at most `limit` tenants after the cursor, ordered by
// (created_at, tenant_id) — a total order no rename or status change moves, so pages never overlap. The
// routine re-confirms, in the snapshot it reads, that the trusted scope's grant still holds. Its answer is
// untrusted: only an exactly shaped answer becomes a page — canonical tenant ids, none repeated and none
// the cursor's own, a status from migration 002's closed set, a version the commands can take, a stored
// display name of bounded length (or null) — and anything else is a bounded 503. The response is built
// field by field from that validated answer:
//   { tenants: [{ tenantId, displayName, status, version }], nextCursor, actions }
// It carries nothing else: no access version or admission witness, no role, grant or membership, no
// session data, no audit record, no database detail. `version` is the row version both platform commands
// take as expectedVersion (tenantDisplayName.ts, tenantStatus.ts).
//
// `actions` ARE PRESENTATION, NOT AUTHORITY. Two booleans — whether this session's decided role holds
// edit_tenant_profile and change_tenant_status — decided by the same canonical rule the authorizer applies
// (the injected `permits`, platformAuthorization.ts createPlatformPermits), so the page can show only the
// controls the server would allow. They grant nothing: each command is authorized again, from the
// beginning, by the chain that serves it. Neither names a role.
//
// FAILURES. The routine's 'denied' (the grant stopped holding between the authorizer and the read) is the
// same generic 403 every other denial is; a continuation naming no tenant is a 400; a port that throws,
// overruns its deadline or answers out of shape is a 503 whose reason goes to the request log alone. No
// failure says which tenant, actor or grant was involved.
//
// PURE AND PORTABLE: part of the emitted runtime artifact, importing only the runtime. It holds no
// infrastructure; the port and the permission decision are handed to it by the composition root.
import { Buffer } from 'node:buffer';
import type { Response } from 'express';
import { PORT_DEADLINE_MS, outage, withDeadline } from './deadline.js';
import { UUID_RE } from './outbox.js';
import type { TrustedScope } from './principals.js';
import { EnforcementSetupError } from './routes.js';
import type { AuthorizationRequirement, RouteContext, RouteDefinition, RouteHandler } from './routes.js';
import { TENANT_DISPLAY_NAME_PERMISSION } from './tenantDisplayName.js';
import { TENANT_STATUS_PERMISSION } from './tenantStatus.js';

export const TENANT_DIRECTORY_PATH = '/admin/v1/tenants';
/** The canonical platform permission: tenant_management at View or above. */
export const TENANT_DIRECTORY_PERMISSION = 'view_tenants';
export const TENANT_DIRECTORY_REQUIREMENT: AuthorizationRequirement = Object.freeze({ scope: 'platform', permission: TENANT_DIRECTORY_PERMISSION });
export const TENANT_DIRECTORY_DEFAULT_LIMIT = 25;
export const TENANT_DIRECTORY_MAX_LIMIT = 50;
/**
 * The longest stored display name a page carries, in UTF-16 code units. Names written by the display-name
 * command hold at most 120 scalar values (240 units); older rows were never bounded, and are shown as
 * stored rather than rewritten. A longer one makes the page a 503 rather than an unbounded response.
 */
export const TENANT_DIRECTORY_MAX_NAME_UNITS = 4_096;
/** Migration 002's tenant_status_chk: every lifecycle value a tenant row can hold. */
export const TENANT_LIFECYCLE_STATUSES: readonly string[] = Object.freeze(['active', 'trialing', 'overdue', 'suspended', 'read_only', 'pending_activation']);

/** The continuation to read after, as a tenant id, and the page size. Both already validated. */
export interface TenantDirectoryQuery {
  readonly after: string | null;
  readonly limit: number;
}

/** One tenant as the page shows it. */
export interface TenantDirectoryEntry {
  readonly tenantId: string;
  readonly displayName: string | null;
  readonly status: string;
  readonly version: number;
}

/**
 * The port to migration 012's routine. Its answer is untrusted input, expected to be one of
 *   { outcome: 'page', tenants: TenantDirectoryEntry[], hasMore: boolean }  — at most query.limit tenants;
 *   { outcome: 'denied' }                                                  — the scope's grant no longer holds;
 *   { outcome: 'cursor_unknown' }                                          — query.after names no tenant.
 * A throw is an outage.
 */
export interface TenantDirectoryPort {
  page(scope: TrustedScope, query: TenantDirectoryQuery, signal: AbortSignal): unknown;
}

/** Whether a scope's decided role holds a platform permission, by the canonical rule. Presentation only here. */
export type PlatformPermits = (scope: TrustedScope, permission: string) => boolean;

/** What the route is built from: the port, and the canonical permission decision for its `actions`. */
export interface TenantDirectoryPorts {
  readonly tenantDirectory: TenantDirectoryPort;
  readonly permits: PlatformPermits;
}

const QUERY_PAIR_RE = /^(limit|cursor)=([A-Za-z0-9_-]{1,32})$/;
const LIMIT_RE = /^[1-9][0-9]?$/;
/** 17 bytes — a version byte and a 16-byte tenant id — as unpadded base64url. */
const CURSOR_RE = /^[A-Za-z0-9_-]{23}$/;
const CURSOR_VERSION = 1;
const MAX_QUERY_LENGTH = 128;
const PAGE_KEYS: readonly string[] = ['outcome', 'tenants', 'hasMore'];
const ENTRY_KEYS: readonly string[] = ['tenantId', 'displayName', 'status', 'version'];
const STATUSES: ReadonlySet<string> = new Set(TENANT_LIFECYCLE_STATUSES);

/** The opaque continuation for a page that ends at `tenantId`. */
export function encodeTenantCursor(tenantId: string): string {
  return Buffer.concat([Buffer.from([CURSOR_VERSION]), Buffer.from(tenantId.replace(/-/g, ''), 'hex')]).toString('base64url');
}

/** The tenant id a continuation names, or null unless it is exactly the canonical spelling of one. */
export function decodeTenantCursor(cursor: string): string | null {
  if (!CURSOR_RE.test(cursor)) return null;
  const bytes = Buffer.from(cursor, 'base64url');
  // Canonical only: decoding ignores the unused low bits of the last character, so a re-encoding that
  // differs means a second spelling of the same bytes, which is refused rather than accepted.
  if (bytes.length !== 17 || bytes[0] !== CURSOR_VERSION || bytes.toString('base64url') !== cursor) return null;
  const hex = bytes.subarray(1).toString('hex');
  const id = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  return UUID_RE.test(id) ? id : null;
}

/** The request target's query as a validated TenantDirectoryQuery, or null for anything the contract refuses. */
export function parseTenantDirectoryQuery(target: string): TenantDirectoryQuery | null {
  const at = target.indexOf('?');
  if (at < 0) return Object.freeze({ after: null, limit: TENANT_DIRECTORY_DEFAULT_LIMIT });
  const raw = target.slice(at + 1);
  if (raw.length > MAX_QUERY_LENGTH) return null;
  let after: string | null = null;
  let limit: number | null = null;
  const seen = new Set<string>();
  for (const pair of raw.split('&')) {
    const match = QUERY_PAIR_RE.exec(pair);
    if (match === null || seen.has(match[1])) return null;
    seen.add(match[1]);
    if (match[1] === 'limit') {
      if (!LIMIT_RE.test(match[2])) return null;
      limit = Number(match[2]);
      if (limit > TENANT_DIRECTORY_MAX_LIMIT) return null;
    } else {
      after = decodeTenantCursor(match[2]);
      if (after === null) return null;
    }
  }
  return Object.freeze({ after, limit: limit ?? TENANT_DIRECTORY_DEFAULT_LIMIT });
}

const isPlain = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};
const hasExactly = (value: Record<string, unknown>, keys: readonly string[]): boolean => {
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((key) => own.includes(key));
};

type PageAnswer = { readonly tenants: readonly TenantDirectoryEntry[]; readonly hasMore: boolean } | 'denied' | 'cursor_unknown';

/** The port's answer as a validated page, 'denied', 'cursor_unknown' — or null for anything out of shape. Never throws. */
export function tenantDirectoryPageOf(raw: unknown, query: TenantDirectoryQuery): PageAnswer | null {
  try {
    if (!isPlain(raw)) return null;
    const { outcome } = raw;
    if (outcome === 'denied') return hasExactly(raw, ['outcome']) ? 'denied' : null;
    if (outcome === 'cursor_unknown') return hasExactly(raw, ['outcome']) && query.after !== null ? 'cursor_unknown' : null;
    if (outcome !== 'page' || !hasExactly(raw, PAGE_KEYS)) return null;
    const { tenants, hasMore } = raw;
    if (!Array.isArray(tenants) || typeof hasMore !== 'boolean') return null;
    // The length is read once, so the bound checked is the bound the loop runs to.
    const count = tenants.length;
    if (count > query.limit) return null;
    // A next page exists only behind a full one: the port read one row more than it returned.
    if (hasMore && count !== query.limit) return null;
    const seen = new Set<string>();
    const out: TenantDirectoryEntry[] = [];
    // inv: out holds a validated copy of each entry below i, and seen their ids; term: i rises to count.
    for (let i = 0; i < count; i++) {
      const entry: unknown = tenants[i];
      if (!isPlain(entry) || !hasExactly(entry, ENTRY_KEYS)) return null;
      // Read once each, so a value validated is the value copied.
      const { tenantId, displayName, status, version } = entry;
      if (typeof tenantId !== 'string' || !UUID_RE.test(tenantId) || seen.has(tenantId) || tenantId === query.after) return null;
      if (displayName !== null && (typeof displayName !== 'string' || displayName.length > TENANT_DIRECTORY_MAX_NAME_UNITS)) return null;
      if (typeof status !== 'string' || !STATUSES.has(status)) return null;
      if (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 1 || version > Number.MAX_SAFE_INTEGER - 1) return null;
      seen.add(tenantId);
      out.push(Object.freeze({ tenantId, displayName: displayName as string | null, status, version }));
    }
    return Object.freeze({ tenants: Object.freeze(out), hasMore });
  } catch {
    return null; // a throwing getter or proxy trap is never a page
  }
}

/** A bounded refusal in the chain's own shape: fixed error word and correlation id; the reason is logged only. */
function refuse(res: Response, ctx: RouteContext, status: number, error: string, reason: string): void {
  res.locals.refusal = reason;
  res.status(status).json({ error, requestId: ctx.requestId });
}

/** Whether `permits` grants `permission` to `scope`: exactly true, and false for any throw or other answer. */
function holds(permits: PlatformPermits, scope: TrustedScope, permission: string): boolean {
  try {
    return permits(scope, permission) === true;
  } catch {
    return false;
  }
}

/** The directory route over `ports`, for a route table; refused at construction without both. */
export function createTenantDirectoryRoute(ports: TenantDirectoryPorts, options: { deadlineMs?: number } = {}): RouteDefinition {
  const reader = ports?.tenantDirectory;
  const permits = ports?.permits;
  if (typeof reader?.page !== 'function' || typeof permits !== 'function') throw new EnforcementSetupError('route_handler_invalid');
  const deadlineMs = options.deadlineMs ?? PORT_DEADLINE_MS;
  // One more port call in the chain, bounded like the rest so the whole chain fits the socket timeout.
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > PORT_DEADLINE_MS) {
    throw new EnforcementSetupError('port_deadline_invalid');
  }
  const handler: RouteHandler = async (req, res, ctx) => {
    const query = parseTenantDirectoryQuery(typeof req.url === 'string' ? req.url : '');
    if (query === null) return refuse(res, ctx, 400, 'invalid_request', 'tenant_directory_query_invalid');
    // The chain refused this request already unless a platform scope was resolved; this states it again.
    const scope = ctx.trusted;
    if (scope === null || scope.scope !== 'platform') return refuse(res, ctx, 403, 'forbidden', 'authz_context_missing');
    let raw: unknown;
    try {
      raw = await withDeadline(deadlineMs, (signal) => reader.page(scope, query, signal));
    } catch (err) {
      return refuse(res, ctx, 503, 'service_unavailable', outage('tenant_directory', err));
    }
    const page = tenantDirectoryPageOf(raw, query);
    if (page === 'denied') return refuse(res, ctx, 403, 'forbidden', 'tenant_directory_denied');
    if (page === 'cursor_unknown') return refuse(res, ctx, 400, 'invalid_request', 'tenant_directory_cursor_unknown');
    if (page === null) return refuse(res, ctx, 503, 'service_unavailable', 'tenant_directory_answer_invalid');
    const last = page.tenants[page.tenants.length - 1];
    res.status(200).json({
      tenants: page.tenants.map((t) => ({ tenantId: t.tenantId, displayName: t.displayName, status: t.status, version: t.version })),
      nextCursor: page.hasMore && last !== undefined ? encodeTenantCursor(last.tenantId) : null,
      actions: {
        editDisplayName: holds(permits, scope, TENANT_DISPLAY_NAME_PERMISSION),
        changeStatus: holds(permits, scope, TENANT_STATUS_PERMISSION),
      },
    });
  };
  const route: RouteDefinition = {
    method: 'GET',
    path: TENANT_DIRECTORY_PATH,
    policy: Object.freeze({ access: 'session', audience: 'admin', authorization: TENANT_DIRECTORY_REQUIREMENT }),
    body: Object.freeze({ kind: 'none' }),
    idempotency: 'none',
    // A read, but one that names whose authority it reads under: the routine re-confirms that exact grant,
    // so the route needs the resolved scope, never a verified principal alone. No recent authentication.
    trustedContext: 'required',
    recentAuth: 'none',
    handler,
  };
  return Object.freeze(route);
}
