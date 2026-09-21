// Phase 4.0 M5-GIAM-D1-P3 — the console's Tenant Management client: the one place the browser reads the platform tenant
// directory (GET /admin/v1/tenants, server/runtime/tenantDirectory.ts) and sends the two platform tenant commands
// (PATCH /admin/v1/tenants/display-name and /status, through the session client's `command`).
//
//   - The server is the authority for everything: who may read, who may rename or suspend, what a valid name or reason is,
//     which version is current and what the tenant's status now is. This client reports what it answered and decides
//     nothing. `actions` in a page are the server's presentation hints; hiding a control is never the control.
//   - The directory answer is untrusted: only a 200 JSON body of bounded size that matches the contract exactly is a
//     page; anything else is `unavailable`, so the page never renders half an answer.
//   - A command answer maps to one outcome. Only a server answer that settles the intent is DEFINITIVE; a lost answer, a
//     timeout, a 5xx, a request still in progress and a rate limit are UNCERTAIN or not yet decided, and the caller retries
//     the same intent under the SAME Idempotency-Key (createIntentKeys), so a retry can never apply a change twice.
//   - The name and reason checks below mirror the server's own (normalizeTenantDisplayName, normalizeTenantStatusReason)
//     so a person sees the rule before sending — the server applies it again and its answer wins.
//   - It keeps nothing: no cache, no storage, no cookie access, no log.

import { REQUEST_TIMEOUT_MS } from './adminSessionClient';
import type { AdminSessionClient } from './adminSessionClient';

export const TENANTS_PATH = '/admin/v1/tenants';
export const DISPLAY_NAME_PATH = '/admin/v1/tenants/display-name';
export const STATUS_PATH = '/admin/v1/tenants/status';
export const PAGE_SIZE = 25;
const MAX_BODY_CHARS = 262_144;
const MAX_NAME_UNITS = 4_096; // server/runtime/tenantDirectory.ts TENANT_DIRECTORY_MAX_NAME_UNITS
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CURSOR_RE = /^[A-Za-z0-9_-]{23}$/;
const JSON_TYPE = /^application\/json\s*(?:;|$)/i;

export const TENANT_STATUSES = ['active', 'trialing', 'overdue', 'suspended', 'read_only', 'pending_activation'] as const;
export type TenantStatus = (typeof TENANT_STATUSES)[number];

export interface TenantEntry {
  readonly tenantId: string;
  readonly displayName: string | null;
  readonly status: TenantStatus;
  readonly version: number;
}

export interface TenantPage {
  readonly tenants: readonly TenantEntry[];
  readonly nextCursor: string | null;
  /** The server's presentation hints for this session. They authorize nothing. */
  readonly actions: { readonly editDisplayName: boolean; readonly changeStatus: boolean };
}

export type ListOutcome =
  | { readonly kind: 'ok'; readonly page: TenantPage }
  | { readonly kind: 'expired' | 'forbidden' | 'rate-limited' | 'invalid' | 'unavailable' | 'aborted' };

/** The server-confirmed result a command answered with: exactly what it committed (or found already in place). */
export interface ConfirmedTenant {
  readonly tenantId: string;
  readonly version: number;
  readonly displayName?: string;
  readonly status?: TenantStatus;
}

export type CommandOutcome =
  | { readonly kind: 'applied'; readonly tenant: ConfirmedTenant }
  /** Definitive refusals: the intent is settled and a new attempt is a new intent with a new key. */
  | { readonly kind: 'conflict' | 'invalid-state' | 'not-found' | 'invalid' | 'forbidden' | 'step-up' | 'expired' | 'key-reused' }
  /** Not settled: nothing was decided (rate-limited) or the outcome is unknown (uncertain). Retry under the same key. */
  | { readonly kind: 'rate-limited' | 'uncertain' };

export interface TenantManagementClient {
  /** One page of the directory after `cursor` (null for the first). Never rejects. */
  list(cursor: string | null, signal: AbortSignal): Promise<ListOutcome>;
  rename(request: { tenantId: string; displayName: string; expectedVersion: number }, idempotencyKey: string): Promise<CommandOutcome>;
  changeStatus(request: { tenantId: string; status: 'active' | 'suspended'; reason: string; expectedVersion: number }, idempotencyKey: string): Promise<CommandOutcome>;
}

/** Whether an outcome settles its intent, so the next attempt must carry a new key. */
export const isDefinitive = (outcome: CommandOutcome): boolean => outcome.kind !== 'uncertain' && outcome.kind !== 'rate-limited';

// ---------------------------------------------------------------------------------------------------------------------
// the server's own input rules, restated for presentation
// ---------------------------------------------------------------------------------------------------------------------

// C0 controls (NUL included), DEL, C1 controls, the line and paragraph separators, a lone surrogate and every Bidi_Control
// character — exactly the set server/runtime/tenantDisplayName.ts and tenantStatus.ts refuse.
const REFUSED_CHARACTER_RE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]|\p{Cs}|\p{Bidi_Control}/u;
export const DISPLAY_NAME_MAX = 120;
export const REASON_MIN = 10;
export const REASON_MAX = 500;

export type TextProblem = 'empty' | 'too-short' | 'too-long' | 'character';
export type TextCheck = { readonly value: string } | { readonly problem: TextProblem };

function checkText(raw: string, min: number, max: number): TextCheck {
  const trimmed = raw.trim();
  if (REFUSED_CHARACTER_RE.test(trimmed)) return { problem: 'character' };
  const scalars = [...trimmed].length;
  if (scalars === 0) return { problem: 'empty' };
  if (scalars < min) return { problem: 'too-short' };
  if (scalars > max) return { problem: 'too-long' };
  return { value: trimmed };
}

/** The display name as the server would store it, or why the server would refuse it. */
export const checkDisplayName = (raw: string): TextCheck => checkText(raw, 1, DISPLAY_NAME_MAX);
/** The lifecycle reason as the server would record it, or why the server would refuse it. */
export const checkReason = (raw: string): TextCheck => checkText(raw, REASON_MIN, REASON_MAX);

// ---------------------------------------------------------------------------------------------------------------------
// one key per intent
// ---------------------------------------------------------------------------------------------------------------------

export interface IntentKeys {
  /** The key for `intent`: the one already held when it is the same intent (a retry), otherwise a new one. */
  keyFor(intent: string): string;
  /** The held intent received a definitive answer: the next attempt, even of the same change, is a new intent. */
  settle(): void;
}

export function createIntentKeys(generate: () => string = () => crypto.randomUUID()): IntentKeys {
  let held: { readonly intent: string; readonly key: string } | null = null;
  return Object.freeze({
    keyFor(intent: string): string {
      if (held !== null && held.intent === intent) return held.key;
      held = Object.freeze({ intent, key: generate() });
      return held.key;
    },
    settle(): void {
      held = null;
    },
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// answers
// ---------------------------------------------------------------------------------------------------------------------

type Data = Record<string, unknown>;
const isPlain = (value: unknown): value is Data => {
  if (typeof value !== 'object' || value === null) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};
const hasKeys = (data: Data, keys: readonly string[]): boolean => {
  const own = Object.keys(data);
  return own.length === keys.length && keys.every((key) => own.includes(key));
};
const isStatus = (value: unknown): value is TenantStatus => (TENANT_STATUSES as readonly unknown[]).includes(value);
const isVersion = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 && value < Number.MAX_SAFE_INTEGER;

/** The page when `body` is exactly the directory contract (then frozen), otherwise null. Never throws. */
export function parseTenantPage(body: unknown): TenantPage | null {
  try {
    if (!isPlain(body) || !hasKeys(body, ['tenants', 'nextCursor', 'actions'])) return null;
    const { tenants, nextCursor, actions } = body;
    if (!Array.isArray(tenants) || tenants.length > 50) return null;
    if (nextCursor !== null && (typeof nextCursor !== 'string' || !CURSOR_RE.test(nextCursor))) return null;
    if (!isPlain(actions) || !hasKeys(actions, ['editDisplayName', 'changeStatus'])) return null;
    if (typeof actions.editDisplayName !== 'boolean' || typeof actions.changeStatus !== 'boolean') return null;
    const seen = new Set<string>();
    const out: TenantEntry[] = [];
    for (const entry of tenants) {
      if (!isPlain(entry) || !hasKeys(entry, ['tenantId', 'displayName', 'status', 'version'])) return null;
      const { tenantId, displayName, status, version } = entry;
      if (typeof tenantId !== 'string' || !UUID_RE.test(tenantId) || seen.has(tenantId)) return null;
      if (displayName !== null && (typeof displayName !== 'string' || displayName.length > MAX_NAME_UNITS)) return null;
      if (!isStatus(status) || !isVersion(version)) return null;
      seen.add(tenantId);
      out.push(Object.freeze({ tenantId, displayName: displayName as string | null, status, version }));
    }
    return Object.freeze({
      tenants: Object.freeze(out),
      nextCursor: nextCursor as string | null,
      actions: Object.freeze({ editDisplayName: actions.editDisplayName, changeStatus: actions.changeStatus }),
    });
  } catch {
    return null;
  }
}

/** The confirmed tenant of a 200 command answer, exactly the command's response shape; null otherwise. */
function confirmedOf(body: unknown, request: Data, field: 'displayName' | 'status'): ConfirmedTenant | null {
  if (!isPlain(body) || !hasKeys(body, ['tenantId', field, 'version'])) return null;
  const { tenantId, version } = body;
  const value = body[field];
  if (typeof tenantId !== 'string' || tenantId !== request.tenantId || !isVersion(version)) return null;
  if (field === 'displayName') return typeof value === 'string' ? Object.freeze({ tenantId, version, displayName: value }) : null;
  // The confirmed status must be the one requested: any other is not a confirmation of this change.
  return isStatus(value) && value === request.status ? Object.freeze({ tenantId, version, status: value }) : null;
}

const errorOf = (body: unknown): unknown => (isPlain(body) ? body.error : undefined);

const OUTCOME = (kind: Exclude<CommandOutcome['kind'], 'applied'>): CommandOutcome => Object.freeze({ kind }) as CommandOutcome;

/** One command answer as its outcome. Anything this contract does not name is uncertain, never assumed either way. */
export function commandOutcomeOf(status: number, body: unknown, request: Data, field: 'displayName' | 'status'): CommandOutcome {
  const error = errorOf(body);
  if (status === 200) {
    const tenant = confirmedOf(body, request, field);
    return tenant === null ? OUTCOME('uncertain') : Object.freeze({ kind: 'applied', tenant });
  }
  if (status === 409 && error === 'write_conflict') return OUTCOME('conflict');
  if (status === 409 && error === 'invalid_state') return OUTCOME('invalid-state');
  if (status === 404) return OUTCOME('not-found');
  if (status === 400) return OUTCOME('invalid');
  if (status === 401) return OUTCOME('expired');
  if (status === 403 && error === 'step_up_required') return OUTCOME('step-up');
  if (status === 403) return OUTCOME('forbidden');
  if (status === 422) return OUTCOME('key-reused');
  if (status === 429) return OUTCOME('rate-limited');
  // 409 request_in_progress (the same key still running), 5xx and anything unnamed: the outcome is not known.
  return OUTCOME('uncertain');
}

const BY_STATUS: Readonly<Record<number, ListOutcome | undefined>> = Object.freeze({
  400: Object.freeze({ kind: 'invalid' }),
  401: Object.freeze({ kind: 'expired' }),
  403: Object.freeze({ kind: 'forbidden' }),
  429: Object.freeze({ kind: 'rate-limited' }),
});
const UNAVAILABLE: ListOutcome = Object.freeze({ kind: 'unavailable' });
const ABORTED: ListOutcome = Object.freeze({ kind: 'aborted' });

export function createTenantManagementClient(options: {
  session: Pick<AdminSessionClient, 'command'>;
  fetch?: typeof fetch;
  timeoutMs?: number;
}): TenantManagementClient {
  const send = options.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init));
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
  const { session } = options;

  async function read(cursor: string | null, signal: AbortSignal): Promise<ListOutcome> {
    const query = cursor === null ? `?limit=${PAGE_SIZE}` : `?limit=${PAGE_SIZE}&cursor=${cursor}`;
    const res = await send(`${TENANTS_PATH}${query}`, {
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
    const text = await res.text();
    if (text.length > MAX_BODY_CHARS) return UNAVAILABLE;
    const page = parseTenantPage(JSON.parse(text));
    return page === null ? UNAVAILABLE : Object.freeze({ kind: 'ok', page });
  }

  async function command(path: string, body: Data, idempotencyKey: string, field: 'displayName' | 'status'): Promise<CommandOutcome> {
    let answer: Awaited<ReturnType<AdminSessionClient['command']>>;
    try {
      answer = await session.command({ path, body, idempotencyKey });
    } catch {
      return OUTCOME('uncertain'); // a sender that broke its contract sent nothing we can confirm
    }
    if (answer.kind === 'no-session') return OUTCOME('expired');
    if (answer.kind === 'failed') return OUTCOME('uncertain');
    return commandOutcomeOf(answer.status, answer.body, body, field);
  }

  return Object.freeze({
    async list(cursor: string | null, signal: AbortSignal): Promise<ListOutcome> {
      if (signal.aborted) return ABORTED;
      if (cursor !== null && !CURSOR_RE.test(cursor)) return UNAVAILABLE;
      const controller = new AbortController();
      const stop = (): void => controller.abort();
      signal.addEventListener('abort', stop, { once: true });
      const timer = setTimeout(stop, timeoutMs);
      let outcome: ListOutcome;
      try {
        outcome = await read(cursor, controller.signal);
      } catch {
        outcome = UNAVAILABLE;
      } finally {
        clearTimeout(timer);
        signal.removeEventListener('abort', stop);
      }
      return signal.aborted ? ABORTED : outcome;
    },
    rename(request: { tenantId: string; displayName: string; expectedVersion: number }, idempotencyKey: string): Promise<CommandOutcome> {
      const { tenantId, displayName, expectedVersion } = request;
      return command(DISPLAY_NAME_PATH, { tenantId, displayName, expectedVersion }, idempotencyKey, 'displayName');
    },
    changeStatus(request: { tenantId: string; status: 'active' | 'suspended'; reason: string; expectedVersion: number }, idempotencyKey: string): Promise<CommandOutcome> {
      const { tenantId, status, reason, expectedVersion } = request;
      return command(STATUS_PATH, { tenantId, status, reason, expectedVersion }, idempotencyKey, 'status');
    },
  });
}
