// Phase 4.0 M3 S4.1b C1R — the trusted authorization bootstrap / runtime routing boundary.
//
// DB-FREE: every executor here is an injected in-memory tagged-template fake. Nothing opens a
// socket, resolves a host, reads a secret, or needs APP_DATABASE_URL. The suite proves the two
// planes stay apart and that an unvalidated scope never reaches the runtime plane at all.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  loadAuthorizationBootstrap,
  loadTenantScopeSnapshot,
  buildResolverInputForContext,
  isScopeBackedByActiveMembership,
  scopeNeedsTenantPlane,
  type SqlExecutor,
  type TenantSqlExecutor,
  type TenantScopeRunner,
} from './authorizationRepository';
import { withTenantContext, type SqlTag, type TenantContext } from './db';
import { writeAuditEvent } from './auditEventWriter';
import { createLifecycle } from '../runtime/lifecycle';
import type { MembershipSnapshot, RequestedContext } from './authorizationResolver';

const HERE = dirname(fileURLToPath(import.meta.url));

const TENANT_A = '00000000-0000-4000-8000-00000000000a';
const TENANT_B = '00000000-0000-4000-8000-00000000000b';
const STORE_A = '00000000-0000-4000-8000-0000000000a1';
const INTERNAL_USER = '00000000-0000-4000-8000-000000000001';

const IDENTITY_KEY = { authProvider: 'firebase', authProviderUid: 'verified-subject-uid' };

const MEMBERSHIPS: MembershipSnapshot[] = [
  {
    membership_id: 'm-tenant-a',
    internal_user_id: INTERNAL_USER,
    tenant_id: TENANT_A,
    store_id: null,
    scope_type: 'tenant',
    role_id: 'store_owner',
    status: 'active',
  },
  {
    membership_id: 'm-store-a',
    internal_user_id: INTERNAL_USER,
    tenant_id: TENANT_A,
    store_id: STORE_A,
    scope_type: 'store',
    role_id: 'store_owner',
    status: 'active',
  },
  {
    membership_id: 'm-tenant-b-suspended',
    internal_user_id: INTERNAL_USER,
    tenant_id: TENANT_B,
    store_id: null,
    scope_type: 'tenant',
    role_id: 'store_owner',
    status: 'suspended',
  },
];

interface RecordedQuery { readonly text: string; readonly values: readonly unknown[] }

function tableOf(text: string): string {
  const m = /from\s+([a-z_]+)/.exec(text);
  return m ? m[1] : 'other';
}

/** A control-plane fake: answers identity/app_user/user_membership and records every statement. */
function fakeControlPlane() {
  const queries: RecordedQuery[] = [];
  const exec = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join('?');
    queries.push({ text, values });
    if (text.includes('platform_identity')) {
      return Promise.resolve([{
        internal_user_id: INTERNAL_USER,
        auth_provider: 'firebase',
        auth_provider_uid: 'verified-subject-uid',
        email: null,
      }]);
    }
    if (text.includes('app_user')) {
      return Promise.resolve([{ internal_user_id: INTERNAL_USER, status: 'active', display_name: null }]);
    }
    if (text.includes('user_membership')) {
      return Promise.resolve(MEMBERSHIPS.map((m) => ({ ...m })));
    }
    return Promise.resolve([]);
  }) as unknown as SqlExecutor;
  return { exec, queries, tables: () => queries.map((q) => tableOf(q.text)) };
}

/** A tenant-plane fake: answers tenant/store/entitlement and records every statement. */
function fakeTenantPlane() {
  const queries: RecordedQuery[] = [];
  const exec = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join('?');
    queries.push({ text, values });
    if (text.includes('tenant_feature_entitlement')) {
      return Promise.resolve([{ tenant_id: TENANT_A, feature_key: 'pickup_requests', enabled: true, source: 'plan' }]);
    }
    if (text.includes('from store')) {
      return Promise.resolve([{ store_id: STORE_A, tenant_id: TENANT_A, status: 'active' }]);
    }
    if (text.includes('from tenant')) {
      return Promise.resolve([{ tenant_id: TENANT_A, plan_key: 'pro', status: 'active' }]);
    }
    return Promise.resolve([]);
  }) as unknown as TenantSqlExecutor;
  return { exec, queries, tables: () => queries.map((q) => tableOf(q.text)) };
}

/** A runner that records whether the tenant plane was entered, and with which scope. */
function recordingRunner(tenant: ReturnType<typeof fakeTenantPlane>) {
  const scopes: TenantContext[] = [];
  const runner: TenantScopeRunner = async (scope, fn) => {
    scopes.push(scope);
    return fn(tenant.exec);
  };
  return { runner, scopes, entered: () => scopes.length };
}

const IDENTITY_TABLES = new Set(['platform_identity', 'app_user', 'user_membership']);
const TENANT_TABLES = new Set(['tenant', 'store', 'tenant_feature_entitlement']);

// --- A. VERIFIED PRINCIPAL ---------------------------------------------------

test('C1R-A: the bootstrap keys every read on the identity it resolved, not on caller input', async () => {
  const cp = fakeControlPlane();
  const boot = await loadAuthorizationBootstrap(IDENTITY_KEY, cp.exec);

  assert.ok(boot, 'a verified provider key resolves a bootstrap');
  assert.equal(boot!.identity.internalUserId, INTERNAL_USER);
  assert.deepEqual(cp.tables(), ['platform_identity', 'app_user', 'user_membership']);

  // The identity lookup is keyed on the VERIFIED provider pair; everything after it is keyed on
  // the internal id that lookup produced — never on a value the caller supplied.
  assert.deepEqual(cp.queries[0].values, ['firebase', 'verified-subject-uid']);
  assert.deepEqual(cp.queries[1].values, [INTERNAL_USER]);
  assert.deepEqual(cp.queries[2].values, [INTERNAL_USER]);
});

test('C1R-A2: an unmatched provider key yields no bootstrap and no further reads', async () => {
  const queries: string[] = [];
  const exec = ((strings: TemplateStringsArray) => {
    queries.push(strings.join('?'));
    return Promise.resolve([]);
  }) as unknown as SqlExecutor;

  assert.equal(await loadAuthorizationBootstrap(IDENTITY_KEY, exec), null);
  assert.equal(queries.length, 1, 'it stops at the identity lookup — no app_user, no memberships');
});

// --- B. ARBITRARY SUBJECT DENIAL ---------------------------------------------

test('C1R-B: no entry point accepts a caller-supplied internal_user_id', () => {
  const src = readFileSync(join(HERE, 'authorizationRepository.ts'), 'utf8');
  const boot = /export async function loadAuthorizationBootstrap\s*\(([\s\S]*?)\)\s*:/.exec(src);
  const build = /export async function buildResolverInputForContext\s*\(([\s\S]*?)\)\s*:/.exec(src);
  assert.ok(boot && build);
  const sigs: Array<[string, string]> = [
    ['loadAuthorizationBootstrap', boot![1]],
    ['buildResolverInputForContext', build![1]],
  ];
  for (const [name, sig] of sigs) {
    assert.ok(/identityKey:\s*IdentityKey/.test(sig), `${name} must take the verified provider key`);
    assert.ok(
      !/internalUserId/.test(sig),
      `${name} must NOT accept an internal user id — that would let a caller name another subject`,
    );
  }
});

// --- C/D. SCOPE TRUST --------------------------------------------------------

test('C1R-C: a scope is trusted only when an ACTIVE membership of this user backs it', () => {
  const tenantA: RequestedContext = { scopeType: 'tenant', tenantId: TENANT_A };
  const tenantB: RequestedContext = { scopeType: 'tenant', tenantId: TENANT_B };
  const storeA: RequestedContext = { scopeType: 'store', tenantId: TENANT_A, storeId: STORE_A };
  const foreignStore: RequestedContext = {
    scopeType: 'store',
    tenantId: TENANT_A,
    storeId: 'ffffffff-0000-4000-8000-00000000ffff',
  };

  assert.equal(isScopeBackedByActiveMembership(tenantA, MEMBERSHIPS), true);
  assert.equal(isScopeBackedByActiveMembership(storeA, MEMBERSHIPS), true);
  // Present but SUSPENDED — a membership row is not the same thing as an active grant.
  assert.equal(isScopeBackedByActiveMembership(tenantB, MEMBERSHIPS), false);
  assert.equal(isScopeBackedByActiveMembership(foreignStore, MEMBERSHIPS), false);
  assert.equal(isScopeBackedByActiveMembership(tenantA, []), false, 'no memberships trusts nothing');
});

test('C1R-D: a requested scope is untrusted until validated — it is never taken on faith', async () => {
  const cp = fakeControlPlane();
  const tp = fakeTenantPlane();
  const r = recordingRunner(tp);

  // TENANT_B exists in the membership set but is SUSPENDED, so it must not become trusted.
  const input = await buildResolverInputForContext(
    IDENTITY_KEY,
    { scopeType: 'tenant', tenantId: TENANT_B },
    cp.exec,
    r.runner,
  );

  assert.ok(input, 'the identity still resolves');
  assert.equal(r.entered(), 0, 'the runtime plane was never entered for an unvalidated scope');
  assert.equal(tp.queries.length, 0, 'no tenant SQL was issued');
  assert.equal(input!.tenant, null);
  assert.deepEqual(input!.entitlements, []);
});

// --- E. UNAUTHORIZED SCOPE ---------------------------------------------------

test('C1R-E: a scope absent from the membership set denies BEFORE any tenant SQL', async () => {
  const cp = fakeControlPlane();
  const tp = fakeTenantPlane();
  const r = recordingRunner(tp);

  const foreign = 'cccccccc-0000-4000-8000-0000000000cc';
  const input = await buildResolverInputForContext(
    IDENTITY_KEY,
    { scopeType: 'tenant', tenantId: foreign },
    cp.exec,
    r.runner,
  );

  assert.equal(r.entered(), 0, 'no context was installed for a foreign tenant');
  assert.equal(tp.queries.length, 0, 'no runtime statement executed for a foreign tenant');
  assert.equal(input!.tenant, null, 'the resolver receives no tenant row and denies honestly');
});

// --- F. CONTEXT ORDERING -----------------------------------------------------

test('C1R-F: transaction-local context is installed before the first protected statement', async () => {
  const seen: string[] = [];
  const tx = ((strings: TemplateStringsArray) => {
    const text = strings.join('?');
    seen.push(text);
    if (text.includes('tenant_feature_entitlement')) return Promise.resolve([]);
    if (text.includes('from tenant')) {
      return Promise.resolve([{ tenant_id: TENANT_A, plan_key: 'pro', status: 'active' }]);
    }
    return Promise.resolve([]);
  }) as unknown as SqlTag;
  let beginCount = 0;
  const db = { begin: async (fn: (t: SqlTag) => Promise<unknown>) => { beginCount += 1; return fn(tx); } };

  await withTenantContext(db, { scopeType: 'tenant', tenantId: TENANT_A }, (t) =>
    loadTenantScopeSnapshot(
      { scopeType: 'tenant', tenantId: TENANT_A },
      t as unknown as TenantSqlExecutor,
    ));

  assert.equal(beginCount, 1, 'exactly one transaction');
  const firstProtected = seen.findIndex((s) => /from\s+(tenant|store|tenant_feature_entitlement)/.test(s));
  const lastSetConfig = seen.map((s) => s.includes('set_config')).lastIndexOf(true);
  assert.ok(firstProtected >= 0, 'a protected statement ran');
  assert.ok(
    lastSetConfig >= 0 && lastSetConfig < firstProtected,
    'all three context settings are installed before the first protected statement',
  );
  for (const s of seen.filter((x) => x.includes('set_config'))) {
    assert.match(s, /set_config\([^)]*,\s*true\s*\)/, 'context must be transaction-local');
  }
});

// --- G. ADMIN / RUNTIME SEPARATION -------------------------------------------

test('C1R-G: identity work stays on the control plane, tenant work on the runtime plane', async () => {
  const cp = fakeControlPlane();
  const tp = fakeTenantPlane();
  const r = recordingRunner(tp);

  const input = await buildResolverInputForContext(
    IDENTITY_KEY,
    { scopeType: 'store', tenantId: TENANT_A, storeId: STORE_A },
    cp.exec,
    r.runner,
  );

  assert.ok(input);
  assert.equal(r.entered(), 1, 'the runtime plane was entered exactly once');
  assert.deepEqual(r.scopes[0], { scopeType: 'store', tenantId: TENANT_A, storeId: STORE_A });

  for (const t of cp.tables()) {
    assert.ok(IDENTITY_TABLES.has(t), `control plane touched a tenant table: ${t}`);
  }
  for (const t of tp.tables()) {
    assert.ok(TENANT_TABLES.has(t), `runtime plane touched an identity table: ${t}`);
  }
  assert.ok(tp.queries.length > 0, 'the tenant rows really were read on the runtime plane');
});

// --- H. PLATFORM SEPARATION --------------------------------------------------

test('C1R-H: platform scope never enters the runtime plane', async () => {
  const cp = fakeControlPlane();
  const tp = fakeTenantPlane();
  const r = recordingRunner(tp);

  const input = await buildResolverInputForContext(IDENTITY_KEY, { scopeType: 'platform' }, cp.exec, r.runner);

  assert.ok(input);
  assert.equal(scopeNeedsTenantPlane({ scopeType: 'platform' }), false);
  assert.equal(r.entered(), 0, 'migration 005: the runtime principal never operates at platform scope');
  assert.equal(tp.queries.length, 0);
  assert.equal(input!.tenant, null);
});

// --- I. NO FALLBACK ----------------------------------------------------------

test('C1R-I: an absent runtime DSN fails closed — it never substitutes the admin client', async () => {
  const hadApp = Object.prototype.hasOwnProperty.call(process.env, 'APP_DATABASE_URL');
  assert.equal(hadApp, false, 'this suite must run with no runtime credential configured');

  const cp = fakeControlPlane();
  // No tenantScope override: the production default (runtime client) is used, and must throw.
  const err = await buildResolverInputForContext(
    IDENTITY_KEY,
    { scopeType: 'tenant', tenantId: TENANT_A },
    cp.exec,
  ).then(() => null, (e: unknown) => e as Error);

  assert.ok(err instanceof Error, 'a trusted tenant scope with no runtime credential must throw');
  assert.match(err!.message, /APP_DATABASE_URL/, 'the failure names the missing runtime variable');
  assert.ok(
    !/SUPABASE_DATABASE_URL/.test(err!.message),
    'the failure must not point an operator at the privileged URL',
  );
});

// --- J. AUDIT ----------------------------------------------------------------

test('C1R-J: audit append defaults to the runtime principal, and injection still wins', async () => {
  // The executor is chosen BEFORE the event is validated, so an intentionally invalid event is a
  // clean probe of WHICH executor the writer reached for — no valid-event fixture required.
  const defaulted = await writeAuditEvent({} as never).then(() => null, (e: unknown) => e as Error);
  assert.ok(defaulted instanceof Error);
  assert.match(defaulted!.message, /APP_DATABASE_URL/, 'the default append path is the runtime client');

  let used = false;
  const injected = (() => { used = true; return Promise.resolve([]); }) as never;
  const withExecutor = await writeAuditEvent({} as never, { executor: injected })
    .then(() => null, (e: unknown) => e as Error);
  assert.ok(withExecutor instanceof Error);
  assert.ok(
    !/APP_DATABASE_URL/.test(withExecutor!.message),
    'an explicit executor must win — the runtime client is never constructed',
  );
  assert.equal(used, false, 'validation still rejects the invalid event before any statement');
});

test('C1R-J2: the writer grants itself no UPDATE/DELETE capability', () => {
  const src = readFileSync(join(HERE, 'auditEventWriter.ts'), 'utf8');
  const code = src.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  for (const verb of [/\bupdate\s+audit_event/i, /\bdelete\s+from\s+audit_event/i]) {
    assert.ok(!verb.test(code), `audit remains append-only: ${verb}`);
  }
});

// --- K. LIFECYCLE ------------------------------------------------------------

test('C1R-K: shutdown closes BOTH constructed database clients', async () => {
  const ran: string[] = [];
  const lifecycle = createLifecycle({
    server: null,
    readiness: { setUnavailable: () => ran.push('readiness') },
    hooks: [() => { ran.push('closeDb'); }, () => { ran.push('closeRuntimeDb'); }],
    proc: { on: () => undefined },
    exit: () => undefined,
  });

  await lifecycle.shutdown('unit', 0);
  assert.ok(ran.includes('closeDb'), 'the admin client is closed');
  assert.ok(ran.includes('closeRuntimeDb'), 'the runtime client is closed — no orphaned pool');
});

test('C1R-K2: the entry point wires both close hooks and the runtime readiness probe', () => {
  const src = readFileSync(join(HERE, 'server.ts'), 'utf8');
  const hooks = /hooks:\s*\[([\s\S]*?)\]/.exec(src);
  assert.ok(hooks, 'the entry point installs shutdown hooks');
  assert.match(hooks![1], /closeDb\(\)/);
  assert.match(hooks![1], /closeRuntimeDb\(\)/);
  assert.match(hooks![1], /allSettled/, 'one client failing must not skip closing the other');
  // Readiness must probe BOTH planes: identity/membership work is unconditionally on the control
  // plane, so probing only the runtime client would report ready while every request still failed.
  assert.match(src, /const sql = getRuntimeDb\(\)/, 'readiness probes the runtime capability');
  assert.match(src, /getDb\(\)`select 1`/, 'readiness also probes the control plane');
});

// --- L. REGRESSION -----------------------------------------------------------

test('C1R-L: an authorized scope still assembles the full, unchanged resolver input', async () => {
  const cp = fakeControlPlane();
  const tp = fakeTenantPlane();
  const r = recordingRunner(tp);

  const input = await buildResolverInputForContext(
    IDENTITY_KEY,
    { scopeType: 'tenant', tenantId: TENANT_A },
    cp.exec,
    r.runner,
  );

  assert.ok(input);
  assert.deepEqual(Object.keys(input!).sort(), [
    'appUser', 'entitlements', 'identity', 'memberships', 'requestedContext', 'store', 'tenant',
  ]);
  assert.equal(input!.identity.internalUserId, INTERNAL_USER);
  assert.equal(input!.appUser?.status, 'active');
  assert.equal(input!.memberships.length, MEMBERSHIPS.length, 'RAW membership rows are preserved');
  assert.equal(input!.tenant?.tenant_id, TENANT_A);
  assert.equal(input!.store, null, 'tenant scope carries no store row');
  assert.equal(input!.entitlements.length, 1);
  assert.deepEqual(input!.requestedContext, { scopeType: 'tenant', tenantId: TENANT_A });
});
