// Phase 4.0 M5 — the second server-authorized business command: suspend or reactivate a tenant
// (M5-GIAM-D1-P2; G-IAM, G-IDEMPOT, G-AUDIT, GAP-13; docs/phase-4/10 ADR-22).
//
// PATCH /admin/v1/tenants/status — the established convention (routes.ts, tenantDisplayName.ts): a platform
// command belongs to the administrative session boundary, whose routes live under /admin/v1, and a path is
// literal, so the target tenant travels in the body where the idempotency fingerprint covers it. The target
// identifies the resource only: it is never authorization evidence and never selects a scope.
//
// Request  { tenantId, status, reason, expectedVersion } — exactly these four fields.
// Response { tenantId, status, version } — 200, once committed.
//
// EXACTLY TWO TRANSITIONS. active -> suspended and suspended -> active, and nothing else: read_only,
// overdue, trialing and pending_activation — the other four values of 002's tenant_status_chk — are not
// reachable, not changed, and not a source a transition may start from. A request whose target equals the
// tenant's current status is an INVALID TRANSITION (409 invalid_state), never a successful no-op: this
// command carries no `unchanged` response, so the store has none to record. The from-status is not a
// request field and is never guessed: the command names only its target, the mutator requires the row to
// hold exactly the opposite value under the expected version, and anything else commits nothing.
//
// AUTHORITY. The route requires the canonical platform permission change_tenant_status: the platform
// feature tenant_management at Manage or above, sensitive (permissionCatalog.ts). The chain decides it on
// the server — the admin session, then the canonical platform authorizer, which resolves the session's
// verified principal to its app-owned actor and decides the role that actor holds at platform scope — and
// hands this command the trusted scope it decided on, which the command transaction re-reads after the
// idempotency fence. No role name is a shortcut: System Owner is granted by the same rule as every role,
// and a stored custom platform role passes only if its current definition reaches Manage. Nothing in the
// body is authority: the planner reads four fields and nothing else.
//
// STEP-UP. The route declares `recentAuth: 'required'`: the chain refuses it (403 step_up_required) unless
// the session carries trusted authentication evidence — the provider's own verified authentication time,
// bound to the session at login — no older than RECENT_AUTH_MAX_AGE_MS. The transaction re-checks the same
// deadline against the database's clock, so an authorization that was fresh when the request arrived cannot
// commit once it has gone stale. Nothing about it is request-supplied (app.ts, sessions.ts).
//
// INPUT. tenantId is a canonical lowercase UUID. status is exactly 'active' or 'suspended'. expectedVersion
// is a positive safe integer. reason is trimmed and must then hold 10-500 Unicode scalar values with no
// control character (C0, NUL included, DEL, C1), no line or paragraph separator, no lone surrogate and no
// Bidi_Control character — the same refusal set the display-name command applies, for the same reason: the
// value is kept verbatim in a durable, append-only audit row that people read. Anything else is a 400
// invalid_request, decided once the idempotency record is acquired; like a conflict it commits and records
// nothing, and the attempt's lease waits out its time.
//
// WHAT IT RECORDS. The reason never reaches the tenant row and never reaches an event: it travels on the
// plan's audit annex to the durable audit record alone (commandTransaction.ts), as the bounded
// sensitive-action reason pair the audit row already has — reason_code, which names the transition in both
// directions, and human_readable_reason, the operator's own words. Each transition enqueues exactly one
// event, tenant.suspended v1 or tenant.reactivated v1, whose payload carries the status the tenant left and
// nothing else: no session data, no credential, no authorization evidence, no reason text.
//
// PURE AND PORTABLE: part of the emitted runtime artifact, importing only the runtime. The planner holds no
// infrastructure, reads nothing but the body and writes nothing.
import { UUID_RE } from './outbox.js';
import type { EventContract } from './outbox.js';
import type { CommandContract } from './commandTransaction.js';
import { COMMAND_REQUEST_INVALID } from './routes.js';
import type { CommandContext, CommandPlan, RouteDefinition } from './routes.js';

export const TENANT_STATUS_PATH = '/admin/v1/tenants/status';
/** The canonical platform permission: tenant_management at Manage or above, sensitive. */
export const TENANT_STATUS_PERMISSION = 'change_tenant_status';
/** The two lifecycle values this command moves between, and nothing else. */
export const TENANT_STATUS_ACTIVE = 'active';
export const TENANT_STATUS_SUSPENDED = 'suspended';
/** The shortest and longest reason, in Unicode scalar values. */
export const TENANT_STATUS_REASON_MIN_SCALARS = 10;
export const TENANT_STATUS_REASON_MAX_SCALARS = 500;
/** A bounded body: four fields, a reason of at most 500 scalars in any JSON spelling, and room for padding. */
const MAX_BODY_BYTES = 8_192;

const STATUS_FIELD = Object.freeze({ type: 'enum', values: Object.freeze([TENANT_STATUS_ACTIVE, TENANT_STATUS_SUSPENDED]) } as const);

export const TENANT_SUSPENDED_EVENT: EventContract = Object.freeze({
  type: 'tenant.suspended',
  version: 1,
  aggregateType: 'tenant',
  payload: Object.freeze({ fromStatus: STATUS_FIELD }),
});

export const TENANT_REACTIVATED_EVENT: EventContract = Object.freeze({
  type: 'tenant.reactivated',
  version: 1,
  aggregateType: 'tenant',
  payload: Object.freeze({ fromStatus: STATUS_FIELD }),
});

/** The event contracts this command enqueues: what an entry composing the route hands createApp as `events`. */
export const TENANT_STATUS_EVENTS: readonly EventContract[] = Object.freeze([TENANT_SUSPENDED_EVENT, TENANT_REACTIVATED_EVENT]);

export const TENANT_STATUS_CONTRACT: CommandContract = Object.freeze({
  kind: 'platform.tenant.status.change',
  mode: 'update',
  aggregateType: 'tenant',
  // The scope of the trusted context it commits under, declared (M7B-INVOICES-P1, design R4: required, never defaulted).
  contextScope: 'platform',
  // The target status alone. The status the tenant leaves is not a change: it is the precondition the
  // mutator requires, derived here from the target because only two transitions exist.
  changes: Object.freeze({ status: STATUS_FIELD }),
  events: Object.freeze([
    Object.freeze({ type: TENANT_SUSPENDED_EVENT.type, version: TENANT_SUSPENDED_EVENT.version }),
    Object.freeze({ type: TENANT_REACTIVATED_EVENT.type, version: TENANT_REACTIVATED_EVENT.version }),
  ]),
});

/** The audit reason code of each transition, by target status: it names the status left and the status taken. */
export const TENANT_STATUS_REASON_CODES: Readonly<Record<string, string>> = Object.freeze({
  [TENANT_STATUS_SUSPENDED]: 'tenant_status_active_to_suspended',
  [TENANT_STATUS_ACTIVE]: 'tenant_status_suspended_to_active',
});

const BODY_FIELDS: readonly string[] = ['tenantId', 'status', 'reason', 'expectedVersion'];
// Exactly the display-name command's refused set (tenantDisplayName.ts): C0 controls (NUL included), DEL,
// C1 controls, the line and paragraph separators, a lone surrogate — no Unicode scalar value at all — and
// every Bidi_Control character, which would make the stored reason render other than it reads.
const REFUSED_CHARACTER_RE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]|\p{Cs}|\p{Bidi_Control}/u;

/** The reason as it is recorded — trimmed, 10-500 Unicode scalar values, no refused character — or null. */
export function normalizeTenantStatusReason(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (REFUSED_CHARACTER_RE.test(trimmed)) return null;
  const scalars = [...trimmed].length; // code points; with no lone surrogate, exactly the scalar values
  return scalars >= TENANT_STATUS_REASON_MIN_SCALARS && scalars <= TENANT_STATUS_REASON_MAX_SCALARS ? trimmed : null;
}

/** The status a tenant must hold for `target` to be reachable: the one other value, never the same one. */
export function tenantStatusPredecessor(target: string): string {
  return target === TENANT_STATUS_SUSPENDED ? TENANT_STATUS_ACTIVE : TENANT_STATUS_SUSPENDED;
}

/**
 * The command's plan from the body alone, or COMMAND_REQUEST_INVALID. There is no `unchanged` response:
 * a target equal to the current status is an invalid transition the store refuses, not a no-op.
 */
export function planTenantStatus(ctx: CommandContext): CommandPlan | typeof COMMAND_REQUEST_INVALID {
  const body: unknown = ctx.body;
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return COMMAND_REQUEST_INVALID;
  // A parsed JSON object: own enumerable data properties only, so its keys are exactly what was sent.
  const keys = Object.keys(body);
  if (keys.length !== BODY_FIELDS.length || !BODY_FIELDS.every((field) => keys.includes(field))) return COMMAND_REQUEST_INVALID;
  const { tenantId, status, reason, expectedVersion } = body as Record<string, unknown>;
  if (typeof tenantId !== 'string' || !UUID_RE.test(tenantId)) return COMMAND_REQUEST_INVALID;
  if (status !== TENANT_STATUS_ACTIVE && status !== TENANT_STATUS_SUSPENDED) return COMMAND_REQUEST_INVALID;
  if (typeof expectedVersion !== 'number' || !Number.isSafeInteger(expectedVersion) || expectedVersion < 1
    || expectedVersion > Number.MAX_SAFE_INTEGER - 1) return COMMAND_REQUEST_INVALID;
  const text = normalizeTenantStatusReason(reason);
  if (text === null) return COMMAND_REQUEST_INVALID;
  const fromStatus = tenantStatusPredecessor(status);
  const event = status === TENANT_STATUS_SUSPENDED ? TENANT_SUSPENDED_EVENT : TENANT_REACTIVATED_EVENT;
  return {
    aggregateId: tenantId,
    expectedVersion,
    changes: { status },
    events: [{ type: event.type, payload: { fromStatus } }],
    response: { status: 200, body: { tenantId, status, version: expectedVersion + 1 } },
    audit: { reasonCode: TENANT_STATUS_REASON_CODES[status], reason: text },
  };
}

const ROUTE: RouteDefinition = {
  method: 'PATCH',
  path: TENANT_STATUS_PATH,
  policy: { access: 'session', audience: 'admin', authorization: { scope: 'platform', permission: TENANT_STATUS_PERMISSION } },
  body: { kind: 'json', maxBytes: MAX_BODY_BYTES, required: true },
  idempotency: 'required',
  trustedContext: 'required',
  recentAuth: 'required',
  command: { contract: TENANT_STATUS_CONTRACT, plan: planTenantStatus },
};

/** The route, as the production inventory registers it (server/composition/productionTransactions.ts). */
export const TENANT_STATUS_ROUTE: RouteDefinition = Object.freeze(ROUTE);
