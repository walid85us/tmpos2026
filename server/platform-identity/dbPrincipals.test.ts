// Phase 4.0 M3 S2 — database principal separation + transaction-local tenant context.
// DATABASE-FREE: postgres.js builds a client lazily, so every option here is read off the
// resolved client WITHOUT a connection ever being opened. No DSN in this file is real, none
// carries a credential, and no test dials out.
//
// What this suite proves:
//   * the migration/admin client and the runtime-principal client are DISTINCT clients bound
//     to DISTINCT environment variables, with no silent fallback between them;
//   * both carry the approved server-side session bounds;
//   * configuration diagnostics report variable NAMES and presence booleans, never values;
//   * tenant/store context is installed ONLY inside a transaction, transaction-locally, and
//     read back missing-safe;
//   * the existing owner-backed DEV/admin callers are untouched by S2.
//
// The real proof that a borrowed connection cannot inherit a prior transaction's context is in
// tests/db/rlsIsolation.integration.test.mjs, against real PostgreSQL. What is provable HERE is
// the mechanism: every context write is `set_config(..., true)` (transaction-local), and this
// module issues no session-level SET at all.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  getDb,
  getRuntimeDb,
  closeDb,
  closeRuntimeDb,
  withTenantContext,
  readTenantContext,
  assertTenantContext,
  DB_SESSION_BOUNDS,
  CONTEXT_SETTINGS,
  type TenantContext,
  type SqlTag,
} from './db';
import {
  SUPABASE_DATABASE_URL_VAR,
  APP_DATABASE_URL_VAR,
  getConfigPresence,
  getRequiredServerConfig,
  getRuntimePrincipalConfig,
  isServerConfigComplete,
} from './config';

const HERE = dirname(fileURLToPath(import.meta.url));

// Synthetic, credential-free loopback DSNs. They are never dialled.
const ADMIN_DSN = 'postgres://127.0.0.1:5432/tmpos_unit_admin';
const RUNTIME_DSN = 'postgres://127.0.0.1:5432/tmpos_unit_runtime';

/** Run `fn` with an exact environment, restoring the previous one and both clients after. */
async function withEnv(
  vars: Readonly<Record<string, string | undefined>>,
  fn: () => Promise<void> | void,
): Promise<void> {
  const keys = [SUPABASE_DATABASE_URL_VAR, APP_DATABASE_URL_VAR, 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_ANON_KEY'];
  const saved = new Map(keys.map((k) => [k, process.env[k]]));
  await closeDb();
  await closeRuntimeDb();
  try {
    for (const k of keys) delete process.env[k];
    for (const [k, v] of Object.entries(vars)) if (v !== undefined) process.env[k] = v;
    await fn();
  } finally {
    await closeDb();
    await closeRuntimeDb();
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

const errorOf = async (fn: () => unknown): Promise<Error> => {
  try { await fn(); } catch (e) { return e as Error; }
  throw new Error('expected a throw, got none');
};

// --- the two principals are distinct ----------------------------------------

test('S2-1: the migration/admin client and the runtime-principal client are distinct', async () => {
  await withEnv({ [SUPABASE_DATABASE_URL_VAR]: ADMIN_DSN, [APP_DATABASE_URL_VAR]: RUNTIME_DSN }, () => {
    const admin = getDb();
    const runtime = getRuntimeDb();
    assert.notEqual(admin, runtime, 'the two principals must never share one client');
    // Each is memoized independently.
    assert.equal(getDb(), admin);
    assert.equal(getRuntimeDb(), runtime);
  });
});

test('S2-2: SUPABASE_DATABASE_URL is the migration/admin source; APP_DATABASE_URL is the runtime source', async () => {
  await withEnv({ [SUPABASE_DATABASE_URL_VAR]: ADMIN_DSN, [APP_DATABASE_URL_VAR]: RUNTIME_DSN }, () => {
    assert.equal(getRequiredServerConfig()?.databaseUrl, ADMIN_DSN);
    assert.equal(getRuntimePrincipalConfig()?.databaseUrl, RUNTIME_DSN);
    // The resolved clients really are bound to different databases.
    assert.equal(getDb().options.database, 'tmpos_unit_admin');
    assert.equal(getRuntimeDb().options.database, 'tmpos_unit_runtime');
  });
});

test('S2-3: a missing runtime URL fails at the runtime boundary and NEVER falls back to the owner URL', async () => {
  await withEnv({ [SUPABASE_DATABASE_URL_VAR]: ADMIN_DSN }, async () => {
    // The admin path is unaffected — existing DEV/admin callers keep working.
    assert.equal(getDb().options.database, 'tmpos_unit_admin');
    assert.equal(getRuntimePrincipalConfig(), null, 'no runtime config without APP_DATABASE_URL');

    const err = await errorOf(() => getRuntimeDb());
    assert.ok(err.message.includes(APP_DATABASE_URL_VAR), 'the error must name the missing variable');
    assert.ok(!err.message.includes(ADMIN_DSN), 'the error must never leak the owner DSN');
    assert.ok(!err.message.includes('tmpos_unit_admin'), 'no fallback target may be named');
  });
});

test('S2-4: the admin client is unavailable when only the runtime URL is present', async () => {
  // The symmetric half of S2-3, which already proved the runtime side. A fallback in EITHER
  // direction would be silent and catastrophic: the tenant path running as the owner bypasses
  // every policy S2 installs, and the admin path on a runtime DSN fails obscurely at first use.
  await withEnv({ [APP_DATABASE_URL_VAR]: RUNTIME_DSN }, async () => {
    assert.equal(getRequiredServerConfig(), null);
    const err = await errorOf(() => getDb());
    assert.ok(err.message.includes(SUPABASE_DATABASE_URL_VAR));
    assert.ok(!err.message.includes(RUNTIME_DSN), 'the error must never leak the runtime DSN');
  });
});

// --- server-side bounds on BOTH clients -------------------------------------

test('S2-5: both clients apply the approved statement_timeout and idle_in_transaction_session_timeout', async () => {
  await withEnv({ [SUPABASE_DATABASE_URL_VAR]: ADMIN_DSN, [APP_DATABASE_URL_VAR]: RUNTIME_DSN }, () => {
    assert.ok(Number.isSafeInteger(DB_SESSION_BOUNDS.statement_timeout) && DB_SESSION_BOUNDS.statement_timeout > 0);
    assert.ok(Number.isSafeInteger(DB_SESSION_BOUNDS.idle_in_transaction_session_timeout) && DB_SESSION_BOUNDS.idle_in_transaction_session_timeout > 0);
    assert.ok(Object.isFrozen(DB_SESSION_BOUNDS), 'the bounds must not be mutable at runtime');
    for (const [label, client] of [['admin', getDb()], ['runtime', getRuntimeDb()]] as const) {
      const conn = client.options.connection as Record<string, unknown>;
      assert.equal(conn.statement_timeout, DB_SESSION_BOUNDS.statement_timeout, `${label}: statement_timeout`);
      assert.equal(
        conn.idle_in_transaction_session_timeout,
        DB_SESSION_BOUNDS.idle_in_transaction_session_timeout,
        `${label}: idle_in_transaction_session_timeout`,
      );
    }
  });
});

// --- diagnostics expose names and presence, never values --------------------

test('S2-6: presence diagnostics report variable status only, never a secret value', async () => {
  await withEnv({
    [SUPABASE_DATABASE_URL_VAR]: ADMIN_DSN,
    [APP_DATABASE_URL_VAR]: RUNTIME_DSN,
    SUPABASE_URL: 'https://example.invalid',
    SUPABASE_SERVICE_ROLE_KEY: 'unit-fixture-key',
  }, () => {
    const presence = getConfigPresence();
    for (const [k, v] of Object.entries(presence)) {
      assert.equal(typeof v, 'boolean', `${k} must be a boolean, not a value`);
    }
    assert.equal(presence.databaseUrl, true);
    assert.equal(presence.appDatabaseUrl, true, 'the runtime principal must be visible to diagnostics');
    const serialized = JSON.stringify(presence);
    assert.ok(!serialized.includes(ADMIN_DSN) && !serialized.includes(RUNTIME_DSN), 'no DSN may be serialized');
    assert.ok(!serialized.includes('unit-fixture-key'), 'no key may be serialized');
  });
});

test('S2-7: the variable NAMES are exported constants, so diagnostics never inline a literal', () => {
  assert.equal(SUPABASE_DATABASE_URL_VAR, 'SUPABASE_DATABASE_URL');
  assert.equal(APP_DATABASE_URL_VAR, 'APP_DATABASE_URL');
});

// --- full verification mode --------------------------------------------------

test('S2-8: full verification keeps the EXISTING contract — APP_DATABASE_URL is reported, not required', async () => {
  // Requiring the runtime URL for readiness would take the isolated DEV identity API offline
  // the moment S2 landed, which is exactly the "existing owner-backed DEV/admin callers remain
  // unchanged" constraint. S2 therefore reports its presence and gates nothing on it.
  await withEnv({
    [SUPABASE_DATABASE_URL_VAR]: ADMIN_DSN,
    SUPABASE_URL: 'https://example.invalid',
    SUPABASE_SERVICE_ROLE_KEY: 'unit-fixture-key',
  }, () => {
    assert.equal(getConfigPresence().appDatabaseUrl, false);
    assert.equal(isServerConfigComplete(), true, 'the pre-S2 readiness contract is unchanged');
  });
  await withEnv({ SUPABASE_URL: 'https://example.invalid' }, () => {
    assert.equal(isServerConfigComplete(), false, 'the pre-S2 requirements still bind');
  });
});

// --- transaction-local tenant/store context ---------------------------------

interface RecordedQuery { readonly text: string; readonly values: readonly unknown[] }

/** A transaction-capable fake. The OUTER object is not callable, so a context write issued
 *  outside `begin` would throw rather than silently succeed at session scope. */
function fakeDb() {
  const queries: RecordedQuery[] = [];
  let beginCount = 0;
  const tx = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    queries.push({ text: strings.join('?'), values });
    return Promise.resolve([{ scope_type: null, tenant_id: null, store_id: null }]);
  }) as unknown as SqlTag;
  const db = {
    begin: async (fn: (t: SqlTag) => Promise<unknown>) => { beginCount += 1; return fn(tx); },
  };
  return { db, queries, beginCount: () => beginCount };
}

const TENANT_CTX: TenantContext = { scopeType: 'tenant', tenantId: '00000000-0000-4000-8000-000000000001' };
const STORE_CTX: TenantContext = {
  scopeType: 'store',
  tenantId: '00000000-0000-4000-8000-000000000001',
  storeId: '00000000-0000-4000-8000-0000000000a1',
};

test('S2-9: the context setting names are the approved transaction-local contract', () => {
  assert.deepEqual({ ...CONTEXT_SETTINGS }, {
    scopeType: 'app.scope_type',
    tenantId: 'app.tenant_id',
    storeId: 'app.store_id',
  });
  assert.ok(Object.isFrozen(CONTEXT_SETTINGS));
});

test('S2-10: context is installed ONLY inside a transaction, and exactly once per call', async () => {
  const f = fakeDb();
  await withTenantContext(f.db, TENANT_CTX, async () => 'ok');
  assert.equal(f.beginCount(), 1, 'exactly one transaction is opened');
  const setCalls = f.queries.filter((q) => q.text.includes('set_config'));
  assert.equal(setCalls.length, 3, 'scope_type, tenant_id and store_id are each installed once');
});

test('S2-11: every context write is transaction-local — set_config(..., true)', async () => {
  const f = fakeDb();
  await withTenantContext(f.db, STORE_CTX, async () => 'ok');
  for (const q of f.queries.filter((x) => x.text.includes('set_config'))) {
    assert.match(q.text, /set_config\([^)]*,\s*true\s*\)/, `not transaction-local: ${q.text}`);
  }
  // The values travel as bound parameters, never interpolated into the statement text.
  const scope = f.queries.find((q) => q.values.includes(CONTEXT_SETTINGS.scopeType));
  assert.ok(scope, 'the setting name is a bound parameter');
  assert.ok(!scope.text.includes('app.scope_type'), 'the setting name is never inlined');
  const values = f.queries.flatMap((q) => q.values);
  assert.ok(values.includes(STORE_CTX.tenantId), 'the tenant id is bound');
  assert.ok(values.includes(STORE_CTX.storeId), 'the store id is bound');
});

test('S2-12: this module issues no session-level SET, so no context can outlive its transaction', () => {
  // A single `SET app.tenant_id = ...` (or set_config(..., false)) would persist on the pooled
  // backend and leak into the next borrower. Proven structurally here; proven against real
  // PostgreSQL in tests/db/rlsIsolation.integration.test.mjs.
  const source = readFileSync(join(HERE, 'db.ts'), 'utf8');
  assert.ok(!/set_config\([^)]*,\s*false\s*\)/.test(source), 'no session-scoped set_config');
  assert.ok(!/`\s*set\s+[a-z_]+\.[a-z_]+\s*=/i.test(source), 'no bare session-level SET statement');
  assert.ok(!/\bset\s+local\b/i.test(source), 'SET LOCAL takes no bind parameter — set_config is the contract');
});

test('S2-13: an absent scope id is installed as the empty string, which the policies read as NULL', async () => {
  const f = fakeDb();
  await withTenantContext(f.db, TENANT_CTX, async () => 'ok');
  const storeCall = f.queries.find((q) => q.values.includes(CONTEXT_SETTINGS.storeId));
  assert.ok(storeCall, 'app.store_id is always installed, even when absent');
  assert.ok(storeCall.values.includes(''), 'an absent store id is the empty string, never a stale value');
});

test('S2-14: context reads are missing-safe — current_setting(..., true)', async () => {
  const f = fakeDb();
  const read = await withTenantContext(f.db, TENANT_CTX, (tx) => readTenantContext(tx));
  const readCall = f.queries.find((q) => q.text.includes('current_setting'));
  assert.ok(readCall, 'the read path uses current_setting');
  assert.match(readCall.text, /current_setting\([^)]*,\s*true\s*\)/, 'a missing setting must not raise');
  assert.ok(readCall.text.includes('nullif('), 'the empty-string sentinel is normalized to NULL');
  // The fake returns all-NULL, i.e. "no context installed".
  assert.equal(read, null, 'an absent scope_type reads back as no context at all');
});

test('S2-15: the context shape guard mirrors the database scope contract', () => {
  assert.doesNotThrow(() => assertTenantContext({ scopeType: 'platform' }));
  assert.doesNotThrow(() => assertTenantContext(TENANT_CTX));
  assert.doesNotThrow(() => assertTenantContext(STORE_CTX));
  // platform => neither id; tenant => tenant only; store => both.
  assert.throws(() => assertTenantContext({ scopeType: 'platform', tenantId: TENANT_CTX.tenantId }));
  assert.throws(() => assertTenantContext({ scopeType: 'tenant' }));
  assert.throws(() => assertTenantContext({ scopeType: 'tenant', tenantId: TENANT_CTX.tenantId, storeId: STORE_CTX.storeId }));
  assert.throws(() => assertTenantContext({ scopeType: 'store', tenantId: TENANT_CTX.tenantId }));
  assert.throws(() => assertTenantContext({ scopeType: 'nope' } as unknown as TenantContext));
});

test('S2-16: a malformed context is refused BEFORE any transaction is opened', async () => {
  const f = fakeDb();
  await errorOf(() => withTenantContext(f.db, { scopeType: 'tenant' }, async () => 'ok'));
  assert.equal(f.beginCount(), 0, 'no transaction may be opened for a context that cannot be installed');
  assert.equal(f.queries.length, 0, 'no statement may be issued');
});

// --- S2 does not move any existing caller ------------------------------------

test('S2-17: no existing platform-identity caller was moved to the runtime principal', () => {
  // Caller cutover is a LATER milestone and is why G-DBROLE stays open. If this ever fails, a
  // caller was migrated without the gate being reassessed.
  //
  // The guard looks for USE, not mention. migrationExecutor.ts names APP_DATABASE_URL in a
  // comment stating it is never read, and migrationExecutor.test.ts carries it as a
  // negative-control fixture proving the executor ignores an ambient application DSN. Both are
  // evidence the boundary holds, so a substring match on the variable name would fail this test
  // for exactly the files that prove the opposite of a cutover.
  const exempt = new Set(['db.ts', 'config.ts', 'dbPrincipals.test.ts']);
  const USES_RUNTIME_PRINCIPAL = [
    /\bgetRuntimeDb\s*\(/,
    /\bwithTenantContext\s*\(/,
    /\bgetRuntimePrincipalConfig\s*\(/,
    /process\.env\s*\.\s*APP_DATABASE_URL\b/,
    /process\.env\s*\[\s*APP_DATABASE_URL_VAR\s*\]/,
  ];
  const offenders: string[] = [];
  for (const name of readdirSync(HERE)) {
    if (!name.endsWith('.ts') || exempt.has(name)) continue;
    const src = readFileSync(join(HERE, name), 'utf8');
    if (USES_RUNTIME_PRINCIPAL.some((re) => re.test(src))) offenders.push(name);
  }
  assert.deepEqual(offenders, [], `S2 must not convert any caller: ${offenders.join(', ')}`);
});

test('S2-18: the owner-backed admin client keeps its existing connection contract', async () => {
  await withEnv({ [SUPABASE_DATABASE_URL_VAR]: 'postgres://db.example.invalid:5432/tmpos_unit_admin' }, () => {
    const admin = getDb();
    assert.equal(admin.options.max, 3, 'the admin pool size is unchanged');
    assert.equal(admin.options.prepare, false, 'prepare:false is unchanged (pooler-safe)');
    assert.equal(admin.options.ssl, 'require', 'a remote owner endpoint still requires TLS');
  });
});

test('S2-19: TLS is unconditional — no DSN shape can switch it off', async () => {
  // Every shape, including the two that invite an exemption. Loopback is still a real network
  // hop (a pooler sidecar on 127.0.0.1 carries the same credentials), and a `?host=` URL only
  // LOOKS like a Unix socket — postgres.js resolves the endpoint from the host OPTION and would
  // dial localhost over TCP, so treating that shape as a socket would drop TLS for a real
  // network connection. A caller needing plaintext passes ssl:false itself, in the open.
  const shapes = {
    remote: 'postgres://db.example.invalid:5432/tmpos_unit_remote',
    loopback: ADMIN_DSN,
    'socket-shaped URL': 'postgres:///tmpos_unit_socket?host=/tmp/tmpos-fixture-socket',
  };
  for (const [label, dsn] of Object.entries(shapes)) {
    await withEnv({ [SUPABASE_DATABASE_URL_VAR]: dsn, [APP_DATABASE_URL_VAR]: dsn }, () => {
      assert.equal(getDb().options.ssl, 'require', `${label}: admin endpoint must require TLS`);
      assert.equal(getRuntimeDb().options.ssl, 'require', `${label}: runtime endpoint must require TLS`);
    });
  }
  // Comment-stripped: db.ts documents the call-site `ssl: false` opt-out in prose, and a naive
  // scan would flag its own explanation.
  const code = readFileSync(join(HERE, 'db.ts'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !l.trim().startsWith('//'))
    .join('\n');
  assert.ok(!/ssl:\s*false/.test(code), 'db.ts must never resolve ssl to false');
  assert.ok(/ssl:\s*'require'/.test(code), 'db.ts must set ssl unconditionally');
});
