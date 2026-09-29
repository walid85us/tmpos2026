// M7A-CUSTOMERS-P3-R2 — the shop's client for the built-in roles' server-enforced Customers levels:
// GET /api/v1/roles/levels (server/runtime/roleLevelDirectory.ts, the owner's read-back) and
// PUT /api/v1/roles/levels (server/runtime/roleLevelUpdate.ts, R1's owner-only, recent-sign-in, idempotent edit).
//
//   - The server is the authority for everything: who may read or edit, which tenant this is, what a valid reason is,
//     and what level stands. This client reports what it answered and decides nothing.
//   - A read answer is untrusted: only a 200 JSON body that matches the contract exactly is a result; anything else is
//     `unavailable`, so the shop never renders half an answer or a level it cannot name.
//   - A PUT answer maps to one outcome. Only a 200 whose body is exactly the level this request asked for is `ok`;
//     `unknown` is any answer that leaves the outcome undecided (no answer, a timeout, a 5xx, an unexpected body), with
//     `responded` saying whether the server answered at all. Only a retry after NO answer, or after a 409 (the same key
//     still in progress), may reuse the same Idempotency-Key (the caller's policy, createIntentKeys). Nothing here is
//     ever reported as saved: the caller marks an edit saved only after an exact 200 AND a fresh read answering the level
//     it asked for.
//   - It keeps nothing: no cache, no storage, no cookie access, no log. Requests are same-origin with credentials.

import { isPermissionLevel } from '../authorization/permissionFamilies';
import type { PermissionLevel } from '../types';
import { INTENT_HEADER, JSON_TYPE_RE, REQUEST_TIMEOUT_MS, SESSION_CSRF_HEADER } from './tenantSessionClient';

export const ROLE_LEVELS_PATH = '/api/v1/roles/levels';
const MAX_BODY_CHARS = 16_384;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** One of the seven canonical level words the server stores — the family contract's vocabulary, never a second list. */
export type RoleLevel = PermissionLevel;
/** The three built-in roles whose Customers level the owner may change, in display order; store_owner is fixed Full. */
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
}

export type ReadResult =
  | { readonly kind: 'ok'; readonly tenant: string; readonly roles: readonly RoleLevelEntry[] }
  | { readonly kind: 'signed-out' | 'denied' | 'unavailable' };

export type PutResult =
  | { readonly kind: 'ok'; readonly level: RoleLevel }
  | { readonly kind: 'step-up-required' | 'denied' | 'signed-out' | 'invalid' | 'in-progress' | 'key-reused' }
  | { readonly kind: 'unknown'; readonly responded: boolean };

export interface RoleLevelsClient {
  /** The selected tenant's effective built-in Customers levels. Never rejects. */
  read(signal?: AbortSignal): Promise<ReadResult>;
  /** One edit attempt under `idempotencyKey`, on the session whose CSRF token is `csrf`. Never rejects. */
  put(change: { readonly roleId: EditableRoleId; readonly level: RoleLevel; readonly reason: string }, idempotencyKey: string, csrf: string, signal?: AbortSignal): Promise<PutResult>;
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

/** The read answer when `body` is exactly the contract (then frozen, in display order), otherwise null. Never throws. */
export function parseRoleLevels(body: unknown): { tenant: string; roles: readonly RoleLevelEntry[] } | null {
  if (!isPlain(body) || !hasKeys(body, ['tenant', 'domain', 'roles'])) return null;
  const { tenant, domain, roles } = body;
  if (typeof tenant !== 'string' || !UUID_RE.test(tenant) || domain !== 'customers') return null;
  if (!Array.isArray(roles) || roles.length !== ROLE_ORDER.length) return null;
  const byRole = new Map<string, RoleLevelEntry>();
  for (const entry of roles) {
    if (!isPlain(entry) || !hasKeys(entry, ['roleId', 'level', 'defaultLevel', 'source', 'editable'])) return null;
    const { roleId, level, defaultLevel, source, editable } = entry;
    if (!(ROLE_ORDER as readonly unknown[]).includes(roleId) || byRole.has(roleId as string)) return null;
    if (!isLevel(level) || !isLevel(defaultLevel)) return null;
    if (roleId === 'store_owner') {
      if (level !== 'full' || defaultLevel !== 'full' || source !== 'fixed' || editable !== false) return null;
    } else if (editable !== true || (source !== 'stored' && !(source === 'default' && level === defaultLevel))) {
      return null;
    }
    byRole.set(roleId as string, Object.freeze({ roleId, level, defaultLevel, source, editable }) as RoleLevelEntry);
  }
  return Object.freeze({ tenant: tenant.toLowerCase(), roles: Object.freeze(ROLE_ORDER.map((id) => byRole.get(id)!)) });
}

export function createRoleLevelsClient(options: { fetch?: typeof fetch; timeoutMs?: number } = {}): RoleLevelsClient {
  const send = options.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init));
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;

  /** The answer's status and bounded JSON body, or null when no answer arrived (network failure, timeout, abort). */
  async function exchange(init: RequestInit, signal?: AbortSignal): Promise<{ status: number; body: unknown } | null> {
    const controller = new AbortController();
    const abort = (): void => controller.abort();
    if (signal?.aborted) return null;
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, timeoutMs);
    try {
      const res = await send(ROLE_LEVELS_PATH, {
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
    const answer = await exchange({ method: 'GET', headers: { Accept: 'application/json' } }, signal);
    if (answer?.status === 200) {
      const parsed = parseRoleLevels(answer.body);
      if (parsed !== null) return Object.freeze({ kind: 'ok', ...parsed });
    }
    if (answer?.status === 401) return Object.freeze({ kind: 'signed-out' });
    if (answer?.status === 403) return Object.freeze({ kind: 'denied' });
    return Object.freeze({ kind: 'unavailable' });
  }

  async function put(
    change: { readonly roleId: EditableRoleId; readonly level: RoleLevel; readonly reason: string },
    idempotencyKey: string,
    csrf: string,
    signal?: AbortSignal,
  ): Promise<PutResult> {
    const answer = await exchange({
      method: 'PUT',
      headers: {
        Accept: 'application/json', 'Content-Type': 'application/json',
        [INTENT_HEADER]: '1', [SESSION_CSRF_HEADER]: csrf, 'Idempotency-Key': idempotencyKey,
      },
      // Fixed key order: a retry under the same key must send the same bytes (the server fingerprints the raw body).
      body: JSON.stringify({ roleId: change.roleId, domain: 'customers', level: change.level, reason: change.reason }),
    }, signal);
    if (answer === null) return Object.freeze({ kind: 'unknown', responded: false });
    const { status, body } = answer;
    if (status === 200) {
      const roleLevel = isPlain(body) && hasKeys(body, ['roleLevel']) ? body.roleLevel : undefined;
      if (isPlain(roleLevel) && hasKeys(roleLevel, ['roleId', 'domain', 'level'])
        && roleLevel.roleId === change.roleId && roleLevel.domain === 'customers' && roleLevel.level === change.level) {
        return Object.freeze({ kind: 'ok', level: change.level });
      }
      return Object.freeze({ kind: 'unknown', responded: true }); // a 200 this request cannot name: read back to decide
    }
    if (status === 400 || status === 413) return Object.freeze({ kind: 'invalid' });
    if (status === 401) return Object.freeze({ kind: 'signed-out' });
    if (status === 403) {
      const stepUp = isPlain(body) && body.error === 'step_up_required';
      return Object.freeze({ kind: stepUp ? 'step-up-required' : 'denied' });
    }
    if (status === 409) return Object.freeze({ kind: 'in-progress' });
    if (status === 422) return Object.freeze({ kind: 'key-reused' });
    return Object.freeze({ kind: 'unknown', responded: true });
  }

  return Object.freeze({ read, put });
}

/** The shop's one role-levels client. */
export const roleLevels: RoleLevelsClient = createRoleLevelsClient();
