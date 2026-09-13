// Phase 4.0 M4 — the Command Center read model: one bounded, read-only administrative summary.
//
// GET /admin/v1/command-center is a session route of the administrative boundary. The shared
// chain (app.ts) proves the admin session and asks the server authorizer for
// COMMAND_CENTER_REQUIREMENT — the existing view_command_center platform permission — before this
// handler runs, so a 401, a 403 or an authorization outage never reaches it, and hiding the page
// is never the control. The handler asks one injected reader port, under the port deadline and
// with nothing but its AbortSignal (no request, principal or session data), for the four summary
// sections, and answers with the bounded view described in
// docs/phase-4/03-backend-control-plane-login-session-blueprint.md §2a and defined by
// commandCenterView below. A reader that throws or overruns is a bounded 503
// whose reason (command_center_unavailable / command_center_timeout) goes to the request log
// alone. There is no other method or path, so the route has no state-changing operation.
//
// The reader's answer is untrusted. commandCenterView is pure and total and fails closed per
// section: a missing, malformed, future, over-age or out-of-range reading reads `unavailable` —
// never a partly trusted section or an invented number — and only an explicit `not_configured`
// reads not configured. Unknown keys are dropped, and no string the reader supplies is emitted:
// every string in the view is one of this module's constants or an ISO instant it formats
// itself, so no secret, token, identifier or personal data can pass through.
//
// Nothing composes this module in production — server.ts and server/composition import none of
// it (tests/quality/production-runtime-contract.test.mjs) — because the admin boundary is itself
// uncomposed there (no durable session store, admission or authorizer adapter, and no store
// compare-and-set for the admission-revalidation race) and no authoritative source exists.
import { EnforcementSetupError } from './routes.js';
import type { AuthorizationRequirement, RouteDefinition, RouteHandler } from './routes.js';
import { PORT_DEADLINE_MS, outage, withDeadline } from './deadline.js';

export const COMMAND_CENTER_PATH = '/admin/v1/command-center';
/** The existing permission (permissionCatalog.ts: view_command_center, command_center / view). */
export const COMMAND_CENTER_REQUIREMENT: AuthorizationRequirement = Object.freeze({ scope: 'platform', permission: 'view_command_center' });
/** A section older than this is flagged stale; its values are still shown. */
export const STALE_AFTER_MS = 900_000;
/** A reading older than this is unavailable rather than stale. */
export const MAX_AGE_MS = 86_400_000;

/** The one port to a future authoritative source. What it returns is untrusted input. */
export interface CommandCenterReader {
  read(signal: AbortSignal): unknown;
}

const POSTURE_KEYS = ['tenants', 'stores', 'pending_approvals', 'critical_alerts'] as const;
const SEVERITIES = ['critical', 'warning', 'info'] as const;
const AREAS = ['tenants', 'provisioning', 'billing', 'security', 'platform'] as const;
const SIGNAL_KEYS = ['production_locked', 'approvals_enforced', 'audit_recording'] as const;
const SIGNAL_STATES = ['ok', 'attention', 'unknown'] as const;
const SERVICE_KEYS = ['auth', 'pos', 'repairs', 'inventory', 'identity_link', 'audit', 'worker'] as const;
// The BCP Services Health vocabulary (Service Healthy / Queue Warning / Default OFF) plus unknown.
const SERVICE_STATES = ['healthy', 'warning', 'off', 'unknown'] as const;

export type PostureKey = typeof POSTURE_KEYS[number];
export type AttentionSeverity = typeof SEVERITIES[number];
export type AttentionArea = typeof AREAS[number];
export type GovernanceSignal = typeof SIGNAL_KEYS[number];
export type SignalState = typeof SIGNAL_STATES[number];
export type ServiceKey = typeof SERVICE_KEYS[number];
export type ServiceState = typeof SERVICE_STATES[number];

/** A section with no trustworthy reading, or with no source connected: its status and nothing else. */
export interface AbsentSection { readonly status: 'unavailable' | 'not_configured' }
interface Fresh { readonly status: 'available'; readonly asOf: string; readonly stale: boolean }
export interface AttentionItem { readonly severity: AttentionSeverity; readonly area: AttentionArea; readonly count: number }
export interface PostureSection extends Fresh { readonly metrics: readonly { readonly key: PostureKey; readonly value: number }[] }
export interface AttentionSection extends Fresh { readonly items: readonly AttentionItem[] }
export interface GovernanceSection extends Fresh { readonly signals: readonly { readonly key: GovernanceSignal; readonly state: SignalState }[] }
export interface ServicesSection extends Fresh { readonly services: readonly { readonly key: ServiceKey; readonly state: ServiceState }[] }

export interface CommandCenterView {
  readonly schemaVersion: 1;
  readonly generatedAt: string;
  readonly sections: {
    readonly posture: PostureSection | AbsentSection;
    readonly attention: AttentionSection | AbsentSection;
    readonly governance: GovernanceSection | AbsentSection;
    readonly services: ServicesSection | AbsentSection;
  };
}

const UNAVAILABLE: AbsentSection = Object.freeze({ status: 'unavailable' });
const NOT_CONFIGURED: AbsentSection = Object.freeze({ status: 'not_configured' });
const MAX_COUNT = 1_000_000_000;
const MAX_FUTURE_MS = 60_000;
const MAX_ATTENTION_ITEMS = 15;
const MAX_TIME_MS = 8.64e15; // the last instant a Date can represent

type Data = Record<string, unknown>;

/**
 * Plain data only — an object literal, parsed JSON or a null-prototype object — never an array,
 * Map or class instance. False, never a throw, for a proxy whose prototype trap throws.
 */
function isPlain(value: unknown): value is Data {
  if (typeof value !== 'object' || value === null) return false;
  try {
    const proto: unknown = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
  } catch {
    return false;
  }
}

// Own keys only, so an inherited or polluted prototype key never reads as data.
const own = (data: Data, key: string): unknown => (Object.hasOwn(data, key) ? data[key] : undefined);
const isCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= MAX_COUNT;
const isInstant = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
/** This module's own constant equal to `value`: the view never carries a reader's string. */
const constant = <T extends string>(set: readonly T[], value: unknown): T | undefined => set.find((member) => member === value);

/** The `keys` present in `data`, in that order, each accepted into a value; null if one is rejected. */
function present<K extends string, V>(data: unknown, keys: readonly K[], accept: (value: unknown) => V | undefined): Array<[K, V]> | null {
  if (!isPlain(data)) return null;
  const out: Array<[K, V]> = [];
  for (const key of keys) {
    if (!Object.hasOwn(data, key)) continue;
    const value = accept(data[key]); // an own key holding undefined is a failed value, not an absent one
    if (value === undefined) return null;
    out.push([key, value]);
  }
  return out;
}

function posture(data: unknown): Pick<PostureSection, 'metrics'> | null {
  const metrics = present(data, POSTURE_KEYS, (value) => (isCount(value) ? value : undefined));
  return metrics && { metrics: metrics.map(([key, value]) => ({ key, value })) };
}

function attention(data: unknown): Pick<AttentionSection, 'items'> | null {
  if (!isPlain(data)) return null;
  const items = own(data, 'items');
  if (!Array.isArray(items)) return null;
  // Indexed up to a length read once and bounded, so no reader-defined iterator ever runs.
  const length: unknown = items.length;
  if (!isCount(length) || length > MAX_ATTENTION_ITEMS) return null;
  const out: AttentionItem[] = [];
  for (let i = 0; i < length; i++) {
    const item: unknown = Object.hasOwn(items, i) ? items[i] : undefined; // a hole never reads the prototype
    if (!isPlain(item)) return null;
    const severity = constant(SEVERITIES, own(item, 'severity'));
    const area = constant(AREAS, own(item, 'area'));
    const count = own(item, 'count');
    if (severity === undefined || area === undefined || !isCount(count) || count < 1) return null;
    // One count per (severity, area): a second would contradict the first.
    if (out.some((kept) => kept.severity === severity && kept.area === area)) return null;
    out.push({ severity, area, count });
  }
  const rank = (item: AttentionItem): number => SEVERITIES.indexOf(item.severity) * AREAS.length + AREAS.indexOf(item.area);
  return { items: out.sort((a, b) => rank(a) - rank(b)) };
}

function governance(data: unknown): Pick<GovernanceSection, 'signals'> | null {
  if (!isPlain(data)) return null;
  const signals = present(own(data, 'signals'), SIGNAL_KEYS, (value) => constant(SIGNAL_STATES, value));
  return signals && { signals: signals.map(([key, state]) => ({ key, state })) };
}

function services(data: unknown): Pick<ServicesSection, 'services'> | null {
  const list = present(data, SERVICE_KEYS, (value) => constant(SERVICE_STATES, value));
  return list && { services: list.map(([key, state]) => ({ key, state })) };
}

/** One reading: its freshness and parsed body, or a bare status. Never throws. */
function section<T extends object>(raw: Data, key: string, nowMs: number, parse: (data: unknown) => T | null): (Fresh & T) | AbsentSection {
  try {
    const reading = own(raw, key);
    // A missing section is unavailable: only an explicit not_configured may say "no source".
    if (!isPlain(reading)) return UNAVAILABLE;
    const status = own(reading, 'status');
    if (status === 'not_configured') return NOT_CONFIGURED;
    const asOf = own(reading, 'asOf');
    if (status !== 'available' || !isInstant(asOf)) return UNAVAILABLE;
    const age = nowMs - asOf;
    if (age < -MAX_FUTURE_MS || age > MAX_AGE_MS) return UNAVAILABLE;
    const body = parse(own(reading, 'data'));
    if (body === null) return UNAVAILABLE;
    return { status: 'available', asOf: new Date(asOf).toISOString(), stale: age > STALE_AFTER_MS, ...body };
  } catch {
    return UNAVAILABLE; // a throwing getter or proxy trap in the reader's value
  }
}

/** Freeze a freshly built view all the way down; it holds only objects built in this module. */
function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

/** Map a reader's raw answer to the bounded view at server time `nowMs`: pure, total, fail closed. */
export function commandCenterView(raw: unknown, nowMs: number): CommandCenterView {
  // A clock that cannot judge freshness leaves every section unavailable, stamped at the epoch.
  const clock = Number.isSafeInteger(nowMs) && nowMs > 0 && nowMs <= MAX_TIME_MS;
  const source = clock && isPlain(raw) ? raw : null;
  const read = <T extends object>(key: string, parse: (data: unknown) => T | null): (Fresh & T) | AbsentSection =>
    (source === null ? UNAVAILABLE : section(source, key, nowMs, parse));
  const view: CommandCenterView = {
    schemaVersion: 1,
    generatedAt: new Date(clock ? nowMs : 0).toISOString(),
    sections: {
      posture: read('posture', posture),
      attention: read('attention', attention),
      governance: read('governance', governance),
      services: read('services', services),
    },
  };
  return deepFreeze(view);
}

/** The Command Center route over `reader`, for a route table; refused at construction without a reader. */
export function commandCenterRoutes(
  reader: CommandCenterReader,
  options: { deadlineMs?: number; now?: () => number } = {},
): readonly RouteDefinition[] {
  if (typeof reader?.read !== 'function') throw new EnforcementSetupError('route_handler_invalid');
  const deadlineMs = options.deadlineMs ?? PORT_DEADLINE_MS;
  // The read is one more port call in the chain, bounded like the rest so the chain fits the socket timeout.
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > PORT_DEADLINE_MS) {
    throw new EnforcementSetupError('port_deadline_invalid');
  }
  const now = options.now ?? Date.now;
  const handler: RouteHandler = async (_req, res, ctx) => {
    let raw: unknown;
    try {
      raw = await withDeadline(deadlineMs, (signal) => reader.read(signal));
    } catch (err) {
      res.locals.refusal = outage('command_center', err); // logged by the request frame, never echoed
      res.status(503).json({ error: 'service_unavailable', requestId: ctx.requestId });
      return;
    }
    res.status(200).json(commandCenterView(raw, now()));
  };
  const route: RouteDefinition = {
    method: 'GET',
    path: COMMAND_CENTER_PATH,
    policy: Object.freeze({ access: 'session', audience: 'admin', authorization: COMMAND_CENTER_REQUIREMENT }),
    body: Object.freeze({ kind: 'none' }),
    handler,
  };
  return Object.freeze([Object.freeze(route)]);
}
