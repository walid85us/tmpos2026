// Phase 4.0 M7a — the read-back of the owner's built-in Customers role levels: what the tenant server decides each built-in
// role's Customers access on, shown to the one person who may change it (M7A-CUSTOMERS-P3-R2; G-IAM, DA-85; migration 020),
// with each editable level's version, the precondition an edit asserts (M7A-CUSTOMERS-P4; DA-125; migration 021).
//
// M5-INVOICES-AUTH-P1 SIBLING. GET /api/v1/roles/levels/invoices reads back the built-in roles' INVOICES levels the same way
// (same requirement, same no-query rule, same untrusted-answer validation, same 503 rules; migration 026), answering
// { tenant, domain: 'invoices', roles: [...4] }. The server stores and shows the Invoices level; since M7B-INVOICES-P1 it also
// decides the store-scope invoice draft routes on it (invoiceDrafts.ts, migration 028) and no other invoice operation. The Customers route below is unchanged byte for byte; both are built by one factory
// that differs only in the domain, the path and the port it reads.
//
// GET /api/v1/roles/levels — a session route of the TENANT boundary, beside the edit (PUT, roleLevelUpdate.ts) on the same
// literal path. It carries no tenant, and it takes no query: any `?` in the target is a 400 invalid_request, decided before
// the port is asked. The tenant read is the trusted scope's — the one the authorizer resolved for the presenting session —
// never a path, query, header or body value.
//
// AUTHORITY. The edit's own requirement, edit_role_levels — the OWNER RULE (m5CanonicalPermissions.ts): the selected
// tenant grant's role is the catalog's owner role and the limitation is 'none'. So exactly who may change a level may read
// it back: a manager, a technician, a sales_staff, a store-scope grant, a read-only limitation and any other tenant's owner
// are the chain's generic 403 before this handler runs. The route declares `trustedContext: 'required'`, so the chain also
// refuses it unless the authorizer resolved the actor and the ONE tenant grant it decided on. No recent sign-in: reading is
// not the sensitive change the edit is.
//
// THE ANSWER. The port reads, for the scope's tenant, the level 020 stores for each editable role (manager, technician,
// sales_staff — EDITABLE_TENANT_ROLES) and its version (021's per-row edit counter) on ONE snapshot, and hands each beside
// its catalog default; the owner role comes first, at its fixed level, never stored and never versioned. The port's answer
// is untrusted: only exactly
//   [ { roleId: 'store_owner', stored: null, defaultLevel: 'full', version: null },
//     { roleId: 'manager', stored, defaultLevel, version }, …technician, …sales_staff ]
// — four plain records of exactly those keys, in that order, the owner's record exactly that one, `stored` null or one of
// the seven level words, `defaultLevel` one of them, an editable role's `version` a safe integer of at least 0 — becomes a
// response; anything else, a throw or an overrun is a bounded 503. The owner's record is pinned whole because the response
// calls it fixed Full: a port that named another owner word or level would otherwise have that shown as the owner's truth.
// The response is built field by field from that validated answer:
//   200 { tenant, domain: 'customers', roles: [ { roleId, level, defaultLevel, source, editable, version } ×4 ] }
// where `level` is the stored level when one is stored and the default otherwise — the same replacement the authorizer
// applies (permissionCatalog.ts) — `source` is 'fixed' (the owner), 'stored' or 'default', `editable` is true for the
// three the edit accepts, and `version` is null for the owner and the editable role's version otherwise. A lock row (020's
// NULL level) reads as no edit: 'default'. It carries nothing else: no actor, grant, membership, session or database
// detail. Chain-wide headers mark every response no-store, so neither the browser nor an intermediary keeps a tenant's
// answer.
//
// THE PRECONDITION IT FEEDS (M7A-CUSTOMERS-P4). `tenant` and a role's `version` are what the owner's client sends back with
// an edit of that role as expectedTenant and expectedVersion (roleLevelUpdate.ts): the edit writes only while both still
// hold, so a draft made from this answer can land neither on another tenant nor over a newer edit.
//
// WHAT THIS IS NOT. The effective permission of a PERSON: the authorizer still caps a read-only account (View) at request
// time, and no entitlement gates the Customers domain. It is the configuration the owner edits, as the server holds it.
// Two edits racing from two tabs that asserted the same version: the first to commit wins, and the other writes nothing (409);
// this read shows the one that committed, at its version.
//
// NO AUDIT RECORD, like the customer read: a configuration read writes none. The request log names the route, the status and
// a bounded reason — never a level, a role or the tenant.
//
// PURE AND PORTABLE: part of the emitted tenant runtime artifact, importing only the runtime. It holds no infrastructure and
// imports no catalog: every editable role's default is the port's (server/composition/tenantTransactions.ts). The owner's
// role word and fixed level are restated here only as the one record the port must answer — a check, never a source.
import type { Response } from 'express';
import { PORT_DEADLINE_MS, outage, withDeadline } from './deadline.js';
import { EDITABLE_TENANT_ROLES, ROLE_LEVELS, ROLE_LEVELS_PATH, ROLE_LEVELS_REQUIREMENT, ROLE_LEVEL_DOMAINS } from './roleLevelUpdate.js';
import { EnforcementSetupError } from './routes.js';
import type { RouteContext, RouteDefinition, RouteHandler } from './routes.js';

/** The same literal path as the edit: GET reads what PUT changes. */
export const ROLE_LEVEL_DIRECTORY_PATH = ROLE_LEVELS_PATH;

/** One role as the response shows it. */
export interface RoleLevelView {
  readonly roleId: string;
  readonly level: string;
  readonly defaultLevel: string;
  readonly source: 'fixed' | 'stored' | 'default';
  readonly editable: boolean;
  /** The editable role's version (021's edit counter); null for the owner, which is never edited. */
  readonly version: number | null;
}

/**
 * The port to the stored levels of one tenant, handed the trusted scope's tenant and nothing else. Its answer is untrusted
 * input, expected to be exactly the four records the header names; a throw is an outage.
 */
export interface RoleLevelDirectoryPort {
  levels(tenant: string, signal: AbortSignal): unknown;
}

/** What the route is built from. */
export interface RoleLevelDirectoryPorts {
  readonly roleLevels: RoleLevelDirectoryPort;
}

/** The one owner record the port may answer (header): the catalog's owner role at its fixed level, never stored. */
const OWNER_ROLE_ID = 'store_owner';
const OWNER_LEVEL = 'full';
const ENTRY_KEYS: readonly string[] = ['roleId', 'stored', 'defaultLevel', 'version'];

const isPlain = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};
const isLevel = (value: unknown): value is string => typeof value === 'string' && ROLE_LEVELS.includes(value);
const isVersion = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

/** The port's answer as the four validated roles, owner first — or null for anything out of shape. Never throws. */
export function roleLevelDirectoryOf(raw: unknown): readonly RoleLevelView[] | null {
  try {
    if (!Array.isArray(raw)) return null;
    // The length is read once, so the bound checked is the bound the loop runs to.
    const count = raw.length;
    if (count !== EDITABLE_TENANT_ROLES.length + 1) return null;
    const out: RoleLevelView[] = [];
    // inv: out holds a validated copy of each entry below i; term: i rises to count.
    for (let i = 0; i < count; i++) {
      const entry: unknown = raw[i];
      if (!isPlain(entry)) return null;
      const keys = Object.keys(entry);
      if (keys.length !== ENTRY_KEYS.length || !ENTRY_KEYS.every((key) => keys.includes(key))) return null;
      // Read once each, so a value validated is the value copied.
      const { roleId, stored, defaultLevel, version } = entry;
      if (typeof roleId !== 'string' || !isLevel(defaultLevel)) return null;
      if (i === 0) {
        // The owner: exactly the one record the header names, never stored and never versioned.
        if (roleId !== OWNER_ROLE_ID || stored !== null || defaultLevel !== OWNER_LEVEL || version !== null) return null;
        out.push(Object.freeze({ roleId, level: defaultLevel, defaultLevel, source: 'fixed', editable: false, version: null }));
        continue;
      }
      const level = stored === null ? null : isLevel(stored) ? stored : undefined;
      if (roleId !== EDITABLE_TENANT_ROLES[i - 1] || level === undefined || !isVersion(version)) return null;
      out.push(Object.freeze({
        roleId, level: level ?? defaultLevel, defaultLevel, source: level === null ? 'default' : 'stored', editable: true, version,
      }));
    }
    return Object.freeze(out);
  } catch {
    return null; // a throwing getter or proxy trap is never an answer
  }
}

/** A bounded refusal in the chain's own shape: fixed error word and correlation id; the reason is logged only. */
function refuse(res: Response, ctx: RouteContext, status: number, error: string, reason: string): void {
  res.locals.refusal = reason;
  res.status(status).json({ error, requestId: ctx.requestId });
}

/** The Invoices sibling's literal path: under the Customers read-back's, never a template (routes.ts). */
export const INVOICE_ROLE_LEVEL_DIRECTORY_PATH = `${ROLE_LEVELS_PATH}/invoices`;

/** What the Invoices read-back is built from: its own port, so the two reads can never be handed one another's. */
export interface InvoiceRoleLevelDirectoryPorts {
  readonly invoiceRoleLevels: RoleLevelDirectoryPort;
}

/** The Customers read-back route over `ports`, for a route table; refused at construction without its port. */
export function createRoleLevelDirectoryRoute(ports: RoleLevelDirectoryPorts, options: { deadlineMs?: number } = {}): RouteDefinition {
  return directoryRoute('customers', ROLE_LEVEL_DIRECTORY_PATH, ports?.roleLevels, options);
}

/** The Invoices read-back route over `ports` (header); refused at construction without its port. */
export function createInvoiceRoleLevelDirectoryRoute(ports: InvoiceRoleLevelDirectoryPorts, options: { deadlineMs?: number } = {}): RouteDefinition {
  return directoryRoute('invoices', INVOICE_ROLE_LEVEL_DIRECTORY_PATH, ports?.invoiceRoleLevels, options);
}

function directoryRoute(domain: string, path: string, reader: RoleLevelDirectoryPort | undefined, options: { deadlineMs?: number }): RouteDefinition {
  if (!ROLE_LEVEL_DOMAINS.includes(domain)) throw new EnforcementSetupError('route_handler_invalid');
  if (typeof reader?.levels !== 'function') throw new EnforcementSetupError('route_handler_invalid');
  const deadlineMs = options.deadlineMs ?? PORT_DEADLINE_MS;
  // One more port call in the chain, bounded like the rest so the whole chain fits the socket timeout.
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > PORT_DEADLINE_MS) {
    throw new EnforcementSetupError('port_deadline_invalid');
  }
  const handler: RouteHandler = async (req, res, ctx) => {
    if (typeof req.url === 'string' && req.url.includes('?')) return refuse(res, ctx, 400, 'invalid_request', 'role_level_directory_query_invalid');
    // The chain refused this request already unless a tenant scope was resolved; this states it again.
    const scope = ctx.trusted;
    if (scope === null || scope.scope !== 'tenant' || scope.tenant === null) return refuse(res, ctx, 403, 'forbidden', 'authz_context_missing');
    const tenant: string = scope.tenant;
    let raw: unknown;
    try {
      raw = await withDeadline(deadlineMs, (signal) => reader.levels(tenant, signal));
    } catch (err) {
      return refuse(res, ctx, 503, 'service_unavailable', outage('role_level_directory', err));
    }
    const roles = roleLevelDirectoryOf(raw);
    if (roles === null) return refuse(res, ctx, 503, 'service_unavailable', 'role_level_directory_answer_invalid');
    res.status(200).json({
      tenant,
      domain,
      roles: roles.map((r) => ({ roleId: r.roleId, level: r.level, defaultLevel: r.defaultLevel, source: r.source, editable: r.editable, version: r.version })),
    });
  };
  const route: RouteDefinition = {
    method: 'GET',
    path,
    policy: Object.freeze({ access: 'session', audience: 'tenant', authorization: ROLE_LEVELS_REQUIREMENT }),
    body: Object.freeze({ kind: 'none' }),
    idempotency: 'none',
    // The tenant read is the resolved scope's, never a verified principal alone. No recent sign-in: a read.
    trustedContext: 'required',
    recentAuth: 'none',
    handler,
  };
  return Object.freeze(route);
}
