// M7A-CUSTOMERS-P3-R2 — the shop's client for the built-in roles' server-enforced Customers levels (and, M5-INVOICES-AUTH-P1, their Invoices LEVEL):
// GET /api/v1/roles/levels (server/runtime/roleLevelDirectory.ts, the owner's read-back) and
// PUT /api/v1/roles/levels (server/runtime/roleLevelUpdate.ts, R1's owner-only, recent-sign-in, idempotent edit).
// M7A-CUSTOMERS-P4 (DA-125): every editable level carries the server's `version` (a per-row counter, +1 per effective
// edit), and a PUT asserts the tenant and version the owner reviewed (`expectedTenant`, `expectedVersion`). They are
// preconditions only — the server still takes the tenant from the session — and a mismatch is refused with nothing written.
//
//   - The server is the authority for everything: who may read or edit, which tenant this is, what a valid reason is,
//     and what level stands. This client reports what it answered and decides nothing.
//   - A read answer is untrusted: only a 200 JSON body that matches the contract exactly is a result; anything else is
//     `unavailable`, so the shop never renders half an answer or a level it cannot name.
//   - A PUT answer maps to one outcome. Only a 200 whose body is exactly the level this request asked for, committed at
//     exactly `expectedVersion + 1`, is `ok`; a 409 `write_conflict` (sealed `{error}` or runtime `{error, requestId}`)
//     is `conflict` — the asserted tenant or version no longer holds and nothing was written;
//     `unknown` is any answer that leaves the outcome undecided (no answer, a timeout, a 5xx, an unexpected body), with
//     `responded` saying whether the server answered at all (a 5xx may still have committed). Only a retry after an
//     `unknown` or a 409 `request_in_progress` (the same key still in progress) may reuse the same Idempotency-Key (the
//     caller's policy, createIntentKeys). Nothing here is ever reported as saved: the caller marks an edit saved only after an exact 200
//     AND a fresh read answering the level it asked for at the committed version.
//   - M5-INVOICES-AUTH-P1: one client per DOMAIN ('customers' by default; 'invoices' reads GET /api/v1/roles/levels/invoices).
//     The PUT is the one route for both, with the domain named in the body; a read or a PUT answer naming another domain
//     is never accepted. Only the stored LEVEL of the role is meant: nothing here says invoices themselves are server-saved.
//   - It keeps nothing: no cache, no storage, no cookie access, no log. Requests are same-origin with credentials.

import { isPermissionLevel } from '../authorization/permissionFamilies';
import type { PermissionLevel } from '../types';
import { INTENT_HEADER, JSON_TYPE_RE, REQUEST_TIMEOUT_MS, SESSION_CSRF_HEADER } from './tenantSessionClient';

export const ROLE_LEVELS_PATH = '/api/v1/roles/levels';
/** The domains whose built-in role levels are server-backed, and the GET path that answers each (the PUT is shared). */
export type RoleLevelsDomain = 'customers' | 'invoices';
export const ROLE_LEVELS_READ_PATHS: Readonly<Record<RoleLevelsDomain, string>> = Object.freeze({
  customers: ROLE_LEVELS_PATH,
  invoices: `${ROLE_LEVELS_PATH}/invoices`,
});
const MAX_BODY_CHARS = 16_384;
// The server's own tenant rule (roleLevelUpdate.ts TENANT_ID_RE): any canonical lowercase UUID — its GET names the tenant
// that way, and a PUT's expectedTenant in any other form is refused.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** One of the seven canonical level words the server stores — the family contract's vocabulary, never a second list. */
export type RoleLevel = PermissionLevel;
/** The three built-in roles whose level (per domain) the owner may change, in display order; store_owner is fixed Full. */
export const EDITABLE_ROLE_IDS = ['manager', 'technician', 'sales_staff'] as const;
export type EditableRoleId = (typeof EDITABLE_ROLE_IDS)[number];
const ROLE_ORDER = ['store_owner', ...EDITABLE_ROLE_IDS] as const;
export type BuiltInRoleId = (typeof ROLE_ORDER)[number];

export interface RoleLevelEntry {
  readonly roleId: BuiltInRoleId;
  readonly level: RoleLevel;
  readonly defaultLevel: RoleLevel;
  readonly source: 'fixed' | 'default' | 'stored';
  readonly editable: boolean;
  /** The server's version of this level (editable roles: a safe integer >= 0, 0 = never edited); null for store_owner. */
  readonly version: number | null;
}

/** One edit: the level asked for, and the tenant and version of the read the owner reviewed (preconditions only). */
export interface LevelChange {
  readonly roleId: EditableRoleId;
  readonly level: RoleLevel;
  readonly reason: string;
  readonly expectedTenant: string;
  readonly expectedVersion: number;
}

export type ReadResult =
  | { readonly kind: 'ok'; readonly tenant: string; readonly roles: readonly RoleLevelEntry[] }
  | { readonly kind: 'signed-out' | 'denied' | 'unavailable' };

export type PutResult =
  | { readonly kind: 'ok'; readonly level: RoleLevel; readonly version: number }
  | { readonly kind: 'step-up-required' | 'denied' | 'signed-out' | 'invalid' | 'in-progress' | 'conflict' | 'key-reused' }
  | { readonly kind: 'unknown'; readonly responded: boolean };

export interface RoleLevelsClient {
  /** The selected tenant's effective built-in levels for this client's domain. Never rejects. */
  read(signal?: AbortSignal): Promise<ReadResult>;
  /** One edit attempt under `idempotencyKey`, on the session whose CSRF token is `csrf`. Never rejects. */
  put(change: LevelChange, idempotencyKey: string, csrf: string, signal?: AbortSignal): Promise<PutResult>;
}

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
const isLevel = isPermissionLevel;
const isVersion = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

/**
 * The one 409 decoder: a body whose keys are within {error, requestId} (requestId a string when present) — the sealed
 * `{error}` and the runtime `{error, requestId}` shapes — is `conflict` for `write_conflict` and `in-progress` for
 * `request_in_progress` (that key still held); anything else decides nothing (null).
 */
export function conflictKind(body: unknown): 'conflict' | 'in-progress' | null {
  if (!isPlain(body)) return null;
  const extra = Object.keys(body).some((key) => key !== 'error' && key !== 'requestId');
  if (extra || ('requestId' in body && typeof body.requestId !== 'string')) return null;
  return body.error === 'write_conflict' ? 'conflict' : body.error === 'request_in_progress' ? 'in-progress' : null;
}

/** The read answer when `body` is exactly the contract (then frozen, in display order), otherwise null. Never throws. */
export function parseRoleLevels(body: unknown, expected: RoleLevelsDomain = 'customers'): { tenant: string; roles: readonly RoleLevelEntry[] } | null {
  if (!isPlain(body) || !hasKeys(body, ['tenant', 'domain', 'roles'])) return null;
  const { tenant, domain, roles } = body;
  if (typeof tenant !== 'string' || !UUID_RE.test(tenant) || domain !== expected) return null;
  if (!Array.isArray(roles) || roles.length !== ROLE_ORDER.length) return null;
  const byRole = new Map<string, RoleLevelEntry>();
  for (const entry of roles) {
    if (!isPlain(entry) || !hasKeys(entry, ['roleId', 'level', 'defaultLevel', 'source', 'editable', 'version'])) return null;
    const { roleId, level, defaultLevel, source, editable, version } = entry;
    if (!(ROLE_ORDER as readonly unknown[]).includes(roleId) || byRole.has(roleId as string)) return null;
    if (!isLevel(level) || !isLevel(defaultLevel)) return null;
    if (roleId === 'store_owner') {
      if (level !== 'full' || defaultLevel !== 'full' || source !== 'fixed' || editable !== false || version !== null) return null;
    } else if (editable !== true || !isVersion(version) || (source !== 'stored' && !(source === 'default' && level === defaultLevel))) {
      return null;
    }
    byRole.set(roleId as string, Object.freeze({ roleId, level, defaultLevel, source, editable, version }) as RoleLevelEntry);
  }
  return Object.freeze({ tenant, roles: Object.freeze(ROLE_ORDER.map((id) => byRole.get(id)!)) });
}

export function createRoleLevelsClient(
  options: { fetch?: typeof fetch; timeoutMs?: number; domain?: RoleLevelsDomain } = {},
): RoleLevelsClient {
  const domain = options.domain ?? 'customers';
  const readPath = ROLE_LEVELS_READ_PATHS[domain];
  const send = options.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init));
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;

  /** The answer's status and bounded JSON body, or null when no answer arrived (network failure, timeout, abort). */
  async function exchange(path: string, init: RequestInit, signal?: AbortSignal): Promise<{ status: number; body: unknown } | null> {
    const controller = new AbortController();
    const abort = (): void => controller.abort();
    if (signal?.aborted) return null;
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, timeoutMs);
    try {
      const res = await send(path, {
        ...init,
        credentials: 'include',
        mode: 'same-origin',
        cache: 'no-store',
        redirect: 'error',
        referrerPolicy: 'no-referrer',
        signal: controller.signal,
      });
      let body: unknown;
      if (JSON_TYPE_RE.test(res.headers.get('content-type') ?? '')) {
        const text = await res.text().catch(() => '');
        if (text.length <= MAX_BODY_CHARS) {
          try { body = JSON.parse(text) as unknown; } catch { body = undefined; }
        }
      }
      return { status: res.status, body };
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    }
  }

  async function read(signal?: AbortSignal): Promise<ReadResult> {
    const answer = await exchange(readPath, { method: 'GET', headers: { Accept: 'application/json' } }, signal);
    if (answer?.status === 200) {
      const parsed = parseRoleLevels(answer.body, domain);
      if (parsed !== null) return Object.freeze({ kind: 'ok', ...parsed });
    }
    if (answer?.status === 401) return Object.freeze({ kind: 'signed-out' });
    if (answer?.status === 403) return Object.freeze({ kind: 'denied' });
    return Object.freeze({ kind: 'unavailable' });
  }

  async function put(
    change: LevelChange,
    idempotencyKey: string,
    csrf: string,
    signal?: AbortSignal,
  ): Promise<PutResult> {
    const answer = await exchange(ROLE_LEVELS_PATH, {
      method: 'PUT',
      headers: {
        Accept: 'application/json', 'Content-Type': 'application/json',
        [INTENT_HEADER]: '1', [SESSION_CSRF_HEADER]: csrf, 'Idempotency-Key': idempotencyKey,
      },
      // Fixed key order: a retry under the same key must send the same bytes (the server fingerprints the raw body).
      body: JSON.stringify({
        roleId: change.roleId, domain, level: change.level, reason: change.reason,
        expectedTenant: change.expectedTenant, expectedVersion: change.expectedVersion,
      }),
    }, signal);
    if (answer === null) return Object.freeze({ kind: 'unknown', responded: false });
    const { status, body } = answer;
    if (status === 200) {
      const roleLevel = isPlain(body) && hasKeys(body, ['roleLevel']) ? body.roleLevel : undefined;
      const committed = change.expectedVersion + 1; // the server commits exactly one step past the asserted version
      if (isPlain(roleLevel) && hasKeys(roleLevel, ['roleId', 'domain', 'level', 'version'])
        && roleLevel.roleId === change.roleId && roleLevel.domain === domain && roleLevel.level === change.level
        && roleLevel.version === committed && Number.isSafeInteger(committed)) {
        return Object.freeze({ kind: 'ok', level: change.level, version: committed });
      }
      return Object.freeze({ kind: 'unknown', responded: true }); // a 200 this request cannot name: read back to decide
    }
    if (status === 400 || status === 413) return Object.freeze({ kind: 'invalid' });
    if (status === 401) return Object.freeze({ kind: 'signed-out' });
    if (status === 403) {
      const stepUp = isPlain(body) && body.error === 'step_up_required';
      return Object.freeze({ kind: stepUp ? 'step-up-required' : 'denied' });
    }
    if (status === 409) {
      const kind = conflictKind(body);
      return Object.freeze(kind === null ? { kind: 'unknown', responded: true } : { kind });
    }
    if (status === 422) return Object.freeze({ kind: 'key-reused' });
    return Object.freeze({ kind: 'unknown', responded: true });
  }

  return Object.freeze({ read, put });
}

/** The shop's Customers role-levels client. */
export const roleLevels: RoleLevelsClient = createRoleLevelsClient();
/** The shop's Invoices role-levels client (the level only; invoices themselves are not stored on the server). */
export const invoiceRoleLevels: RoleLevelsClient = createRoleLevelsClient({ domain: 'invoices' });
