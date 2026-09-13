// Phase 4.0 M4 — the console's Command Center client: the one place the browser reads the
// read-only administrative summary, GET /admin/v1/command-center
// (docs/phase-4/03-backend-control-plane-login-session-blueprint.md §2a; the server side is
// server/runtime/commandCenter.ts).
//
//   - One bounded GET per load. Accept is its only header — never the provider bearer, never a
//     CSRF token — and the HttpOnly session cookie rides on credentials "include".
//   - It keeps nothing: no cache, no storage, no cookie access, no log.
//   - The answer is untrusted. Only a 200 JSON body of at most MAX_BODY_CHARS characters that
//     matches the contract's view exactly is a view; anything else is `unavailable`, so the page
//     never renders half a payload. An accepted view is frozen.
//   - The server stays the authority: 401, 403 and 429 are reported as answered.

import { REQUEST_TIMEOUT_MS } from './adminSessionClient';

export const COMMAND_CENTER_PATH = '/admin/v1/command-center';
export const MAX_BODY_CHARS = 65_536;
/** A section read longer ago than this is out of date (server/runtime/commandCenter.ts STALE_AFTER_MS). */
export const STALE_AFTER_MS = 900_000;

export const POSTURE_KEYS = ['tenants', 'stores', 'pending_approvals', 'critical_alerts'] as const;
const SEVERITIES = ['critical', 'warning', 'info'] as const;
const AREAS = ['tenants', 'provisioning', 'billing', 'security', 'platform'] as const;
const SIGNAL_KEYS = ['production_locked', 'approvals_enforced', 'audit_recording'] as const;
const SIGNAL_STATES = ['ok', 'attention', 'unknown'] as const;
const SERVICE_KEYS = ['auth', 'pos', 'repairs', 'inventory', 'identity_link', 'audit', 'worker'] as const;
const SERVICE_STATES = ['healthy', 'warning', 'off', 'unknown'] as const;
const MAX_COUNT = 1_000_000_000;
const MAX_ATTENTION_ITEMS = 15;
/** The server's freshness bounds (server/runtime/commandCenter.ts MAX_FUTURE_MS, MAX_AGE_MS). */
const MAX_FUTURE_MS = 60_000;
export const MAX_AGE_MS = 86_400_000;

export type PostureKey = (typeof POSTURE_KEYS)[number];
export type AttentionSeverity = (typeof SEVERITIES)[number];
export type AttentionArea = (typeof AREAS)[number];
export type GovernanceSignal = (typeof SIGNAL_KEYS)[number];
export type SignalState = (typeof SIGNAL_STATES)[number];
export type ServiceKey = (typeof SERVICE_KEYS)[number];
export type ServiceState = (typeof SERVICE_STATES)[number];

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

export type CommandCenterOutcome =
  | { readonly kind: 'ok'; readonly view: CommandCenterView }
  | { readonly kind: 'expired' | 'forbidden' | 'rate-limited' | 'unavailable' | 'aborted' };

export interface CommandCenterClient {
  /** One read of the Command Center; `signal` abandons it. Never rejects. */
  load(signal: AbortSignal): Promise<CommandCenterOutcome>;
}

type Data = Record<string, unknown>;

/** Plain data only — parsed JSON or an object literal — never an array, Map or class instance. */
function isPlain(value: unknown): value is Data {
  if (typeof value !== 'object' || value === null) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** Exactly these own keys: no more, no fewer. */
function hasKeys(data: Data, keys: readonly string[]): boolean {
  const own = Object.keys(data);
  return own.length === keys.length && keys.every((key) => own.includes(key));
}

const isCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= MAX_COUNT;

/** The canonical ISO-8601 UTC instant the server's toISOString emits, and no other spelling. */
function isInstant(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const ms = Date.parse(value);
  return Number.isFinite(ms) && new Date(ms).toISOString() === value;
}

const rank = (members: readonly string[], value: unknown): number => (members as readonly unknown[]).indexOf(value);

/** Entries in strictly ascending contract order: each one known (rank ≥ 0), none repeated. */
function ranked(value: unknown, max: number, rankOf: (entry: Data) => number): boolean {
  if (!Array.isArray(value) || value.length > max) return false;
  let last = -1;
  for (const entry of value) {
    const next = isPlain(entry) ? rankOf(entry) : -1;
    if (next <= last) return false;
    last = next;
  }
  return true;
}

type Rule = readonly [list: string, max: number, rankOf: (entry: Data) => number];

const SECTION_RULES: Readonly<Record<keyof CommandCenterView['sections'], Rule>> = {
  posture: ['metrics', POSTURE_KEYS.length, (e) => (hasKeys(e, ['key', 'value']) && isCount(e.value) ? rank(POSTURE_KEYS, e.key) : -1)],
  attention: [
    'items',
    MAX_ATTENTION_ITEMS,
    (e) => {
      const severity = rank(SEVERITIES, e.severity);
      const area = rank(AREAS, e.area);
      const valid = hasKeys(e, ['severity', 'area', 'count']) && isCount(e.count) && e.count >= 1 && severity >= 0 && area >= 0;
      return valid ? severity * AREAS.length + area : -1; // sorted by severity, then area
    },
  ],
  governance: ['signals', SIGNAL_KEYS.length, (e) => (hasKeys(e, ['key', 'state']) && rank(SIGNAL_STATES, e.state) >= 0 ? rank(SIGNAL_KEYS, e.key) : -1)],
  services: ['services', SERVICE_KEYS.length, (e) => (hasKeys(e, ['key', 'state']) && rank(SERVICE_STATES, e.state) >= 0 ? rank(SERVICE_KEYS, e.key) : -1)],
};

function isSection(value: unknown, [list, max, rankOf]: Rule, generatedMs: number): boolean {
  if (!isPlain(value)) return false;
  if (value.status === 'unavailable' || value.status === 'not_configured') return hasKeys(value, ['status']);
  if (value.status !== 'available' || !hasKeys(value, ['status', 'asOf', 'stale', list]) || !isInstant(value.asOf)) return false;
  // The server's own freshness rules, recomputed from its two instants (both exact to the millisecond):
  // a reading it could never emit — from the future, over a day old, or flagged against its age — is refused.
  const age = generatedMs - Date.parse(value.asOf);
  return age >= -MAX_FUTURE_MS && age <= MAX_AGE_MS && value.stale === (age > STALE_AFTER_MS) && ranked(value[list], max, rankOf);
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

/** The view when `body` is exactly the contract's schema (then frozen), otherwise null. Never throws. */
export function parseCommandCenterView(body: unknown): CommandCenterView | null {
  try {
    if (!isPlain(body) || !hasKeys(body, ['schemaVersion', 'generatedAt', 'sections'])) return null;
    if (body.schemaVersion !== 1 || !isInstant(body.generatedAt)) return null;
    const generatedMs = Date.parse(body.generatedAt);
    const sections = body.sections;
    if (!isPlain(sections) || !hasKeys(sections, Object.keys(SECTION_RULES))) return null;
    for (const [key, rule] of Object.entries(SECTION_RULES)) {
      if (!isSection(sections[key], rule, generatedMs)) return null;
    }
    return deepFreeze(body) as unknown as CommandCenterView;
  } catch {
    return null; // a throwing getter or proxy trap is never a view
  }
}

const EXPIRED: CommandCenterOutcome = Object.freeze({ kind: 'expired' });
const FORBIDDEN: CommandCenterOutcome = Object.freeze({ kind: 'forbidden' });
const RATE_LIMITED: CommandCenterOutcome = Object.freeze({ kind: 'rate-limited' });
const UNAVAILABLE: CommandCenterOutcome = Object.freeze({ kind: 'unavailable' });
const ABORTED: CommandCenterOutcome = Object.freeze({ kind: 'aborted' });
const BY_STATUS: Readonly<Record<number, CommandCenterOutcome | undefined>> = { 401: EXPIRED, 403: FORBIDDEN, 429: RATE_LIMITED };
const JSON_TYPE = /^application\/json\s*(?:;|$)/i;

export function createCommandCenterClient(options: { fetch?: typeof fetch; timeoutMs?: number } = {}): CommandCenterClient {
  const send = options.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init));
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;

  async function read(signal: AbortSignal): Promise<CommandCenterOutcome> {
    const res = await send(COMMAND_CENTER_PATH, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      credentials: 'include',
      mode: 'same-origin',
      cache: 'no-store',
      redirect: 'error',
      referrerPolicy: 'no-referrer',
      signal,
    });
    if (res.status !== 200) return BY_STATUS[res.status] ?? UNAVAILABLE;
    if (!JSON_TYPE.test(res.headers.get('content-type') ?? '')) return UNAVAILABLE;
    const text = await res.text(); // the timeout bounds a slow or endless body as well
    if (text.length > MAX_BODY_CHARS) return UNAVAILABLE;
    const view = parseCommandCenterView(JSON.parse(text));
    return view === null ? UNAVAILABLE : Object.freeze({ kind: 'ok', view });
  }

  return Object.freeze({
    async load(signal: AbortSignal): Promise<CommandCenterOutcome> {
      if (signal.aborted) return ABORTED;
      const controller = new AbortController();
      const stop = (): void => controller.abort();
      signal.addEventListener('abort', stop, { once: true });
      const timer = setTimeout(stop, timeoutMs);
      let outcome: CommandCenterOutcome;
      try {
        outcome = await read(controller.signal);
      } catch {
        outcome = UNAVAILABLE; // a network failure, the timeout, or a body that is not JSON
      } finally {
        clearTimeout(timer);
        signal.removeEventListener('abort', stop);
      }
      // The caller's abort wins over whatever came back: nobody is waiting for it any more.
      return signal.aborted ? ABORTED : outcome;
    },
  });
}
