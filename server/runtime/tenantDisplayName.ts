// Phase 4.0 M5 — the first server-authorized business command: update a tenant's display name
// (owner decision D1, M5-GIAM-D1-P1; G-IAM, G-IDEMPOT, G-AUDIT; docs/phase-4/10 ADR-20).
//
// PATCH /admin/v1/tenants/display-name — the brief's /api/platform/tenants/:tenantId/display-name in the
// form the established route conventions call for, per routes.ts: a platform command belongs to the
// administrative session boundary, whose routes live under /admin/v1 (/api is the tenant boundary's
// namespace), and a path is literal — no parameter — so the target tenant travels in the body, where the
// idempotency fingerprint covers it. The target tenant identifies the resource only: it is never
// authorization evidence and never selects a scope.
//
// Request  { tenantId, displayName, expectedVersion } — exactly these three fields.
// Response { tenantId, displayName, version } — 200 once committed, or 200 unchanged.
//
// AUTHORITY. The route requires the canonical platform permission edit_tenant_profile: the platform
// feature tenant_management at Edit or above (the platform ordering), non-sensitive, with no
// prerequisite and no money grant (server/platform-identity/permissionCatalog.ts). The chain decides it
// on the server — the admin session, then the canonical platform authorizer, which resolves the session's
// verified principal to its app-owned actor and decides the role that actor holds at platform scope
// (server/composition/platformAuthorization.ts) — and hands this command the trusted scope it decided on.
// The command transaction re-reads that scope after the idempotency fence (007), so a revoked actor
// commits nothing. Nothing in the body is authority: the planner reads three fields and nothing else.
//
// INPUT (owner decision D1). displayName must be a string; leading and trailing whitespace is trimmed;
// the trimmed value must hold 1-120 Unicode scalar values, with no control character (C0, DEL, C1) and no
// line or paragraph separator, which no display name carries and no event payload accepts; internal
// whitespace and every other character are kept exactly — no case folding, no normalization. Names may
// repeat across tenants. expectedVersion is a positive safe integer. tenantId is a canonical lowercase
// UUID. Anything else is a 400 invalid_request, decided once the idempotency record is acquired; like a
// conflict it commits and records nothing, and the attempt's lease waits out its time.
//
// OUTCOMES. The store locks the tenant row and answers: not found (404), another version (409
// write_conflict), the same name already in place at that version (200 with the current version — no
// version moves, no audit record, no event), or applied: the name and the version move together with the
// audit record and exactly one tenant.display_name_changed event, atomically (migration 008,
// server/persistence/tenantDisplayNameMutator.ts). Only displayName changes — never the legal name, the
// status, the plan, an entitlement, a membership, a role or billing state.
//
// PURE AND PORTABLE: part of the emitted runtime artifact, importing only the runtime. The planner holds
// no infrastructure, reads nothing but the body and writes nothing.
import { UUID_RE } from './outbox.js';
import type { EventContract } from './outbox.js';
import type { CommandContract } from './commandTransaction.js';
import { COMMAND_REQUEST_INVALID } from './routes.js';
import type { CommandContext, CommandPlan, RouteDefinition } from './routes.js';

export const TENANT_DISPLAY_NAME_PATH = '/admin/v1/tenants/display-name';
/** The canonical platform permission: tenant_management at Edit or above. */
export const TENANT_DISPLAY_NAME_PERMISSION = 'edit_tenant_profile';
/** The longest display name, in Unicode scalar values. */
export const TENANT_DISPLAY_NAME_MAX_SCALARS = 120;
/** The same bound in UTF-16 code units, which is how a record schema counts: every scalar is one or two. */
const MAX_CODE_UNITS = TENANT_DISPLAY_NAME_MAX_SCALARS * 2;
/** A bounded body: three fields, a name of at most 120 scalars in any JSON spelling, and room for padding. */
const MAX_BODY_BYTES = 4_096;

const DISPLAY_NAME_FIELD = Object.freeze({ type: 'string', maxLength: MAX_CODE_UNITS } as const);

export const TENANT_DISPLAY_NAME_CHANGED: EventContract = Object.freeze({
  type: 'tenant.display_name_changed',
  version: 1,
  aggregateType: 'tenant',
  payload: Object.freeze({ displayName: DISPLAY_NAME_FIELD }),
});

/** The event contracts this command enqueues: what an entry composing the route hands createApp as `events`. */
export const TENANT_DISPLAY_NAME_EVENTS: readonly EventContract[] = Object.freeze([TENANT_DISPLAY_NAME_CHANGED]);

export const TENANT_DISPLAY_NAME_CONTRACT: CommandContract = Object.freeze({
  kind: 'platform.tenant.display_name.update',
  mode: 'update',
  aggregateType: 'tenant',
  changes: Object.freeze({ displayName: DISPLAY_NAME_FIELD }),
  events: Object.freeze([Object.freeze({ type: TENANT_DISPLAY_NAME_CHANGED.type, version: TENANT_DISPLAY_NAME_CHANGED.version })]),
});

const BODY_FIELDS: readonly string[] = ['tenantId', 'displayName', 'expectedVersion'];
// C0 controls (NUL included), DEL, C1 controls, and the line and paragraph separators; a lone surrogate is
// no Unicode scalar value at all.
const REFUSED_CHARACTER_RE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]|\p{Cs}/u;

/** The display name as it is stored — trimmed, 1-120 Unicode scalar values, no refused character — or null. */
export function normalizeTenantDisplayName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (REFUSED_CHARACTER_RE.test(trimmed)) return null;
  const scalars = [...trimmed].length; // code points; with no lone surrogate, exactly the scalar values
  return scalars >= 1 && scalars <= TENANT_DISPLAY_NAME_MAX_SCALARS ? trimmed : null;
}

/**
 * The command's plan from the body alone, or COMMAND_REQUEST_INVALID. The response is the committed
 * representation (the version the update produces); `unchanged` is the one the store sends when the name
 * is already this one at the expected version, so nothing moved.
 */
export function planTenantDisplayName(ctx: CommandContext): CommandPlan | typeof COMMAND_REQUEST_INVALID {
  const body: unknown = ctx.body;
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return COMMAND_REQUEST_INVALID;
  // A parsed JSON object: own enumerable data properties only, so its keys are exactly what was sent.
  const keys = Object.keys(body);
  if (keys.length !== BODY_FIELDS.length || !BODY_FIELDS.every((field) => keys.includes(field))) return COMMAND_REQUEST_INVALID;
  const { tenantId, displayName, expectedVersion } = body as Record<string, unknown>;
  if (typeof tenantId !== 'string' || !UUID_RE.test(tenantId)) return COMMAND_REQUEST_INVALID;
  if (typeof expectedVersion !== 'number' || !Number.isSafeInteger(expectedVersion) || expectedVersion < 1
    || expectedVersion > Number.MAX_SAFE_INTEGER - 1) return COMMAND_REQUEST_INVALID;
  const name = normalizeTenantDisplayName(displayName);
  if (name === null) return COMMAND_REQUEST_INVALID;
  return {
    aggregateId: tenantId,
    expectedVersion,
    changes: { displayName: name },
    events: [{ type: TENANT_DISPLAY_NAME_CHANGED.type, payload: { displayName: name } }],
    response: { status: 200, body: { tenantId, displayName: name, version: expectedVersion + 1 } },
    unchanged: { status: 200, body: { tenantId, displayName: name, version: expectedVersion } },
  };
}

const ROUTE: RouteDefinition = {
  method: 'PATCH',
  path: TENANT_DISPLAY_NAME_PATH,
  policy: { access: 'session', audience: 'admin', authorization: { scope: 'platform', permission: TENANT_DISPLAY_NAME_PERMISSION } },
  body: { kind: 'json', maxBytes: MAX_BODY_BYTES, required: true },
  idempotency: 'required',
  command: { contract: TENANT_DISPLAY_NAME_CONTRACT, plan: planTenantDisplayName },
};

/** The route, as the production inventory registers it (server/composition/productionTransactions.ts). */
export const TENANT_DISPLAY_NAME_ROUTE: RouteDefinition = Object.freeze(ROUTE);
