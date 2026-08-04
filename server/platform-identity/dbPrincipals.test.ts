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
import { X509Certificate } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { rootCertificates } from 'node:tls';
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
  runtimeClientOptions,
  DRIVER_TLS_ENV_VAR,
  type TenantContext,
  type SqlTag,
} from './db';
import {
  SUPABASE_DATABASE_URL_VAR,
  APP_DATABASE_URL_VAR,
  DATABASE_CA_CERT_VAR,
  getConfigPresence,
  getRequiredServerConfig,
  getRuntimePrincipalConfig,
  isServerConfigComplete,
} from './config';

const HERE = dirname(fileURLToPath(import.meta.url));

// Synthetic, credential-free loopback DSNs. They are never dialled.
const ADMIN_DSN = 'postgres://127.0.0.1:5432/tmpos_unit_admin';
const RUNTIME_DSN = 'postgres://127.0.0.1:5432/tmpos_unit_runtime';

// --- S4.1a synthetic secret markers -----------------------------------------
// Distinctive on purpose: every failure path below is checked for these exact strings, so a
// message that ever grew to include a DSN, a password or CA material fails loudly here rather
// than in a log aggregator.
// Taken from the exported constants rather than inlined, exactly as S2-7 requires of the DSN
// variable names; their literal values are pinned once, in S4.1a-13.
const CA_VAR = DATABASE_CA_CERT_VAR;
const DRIVER_TLS_ENV = DRIVER_TLS_ENV_VAR;
// Base64 alphabet, correctly framed, and STILL NOT A CERTIFICATE. This is the exact shape the
// S4.1a correction exists to refuse: it satisfies every delimiter/base64/length check yet decodes
// to bytes that are not an X.509 certificate, so a trust store built from it holds ZERO anchors
// and every "verified" connection is doomed to fail hours later at the driver. Only an actual
// X.509 parse of the block tells this apart from a real certificate.
const CA_MARKER = 'TMPOSSYNTHETICCAMARKERNOTAREALCERTIFICATEXYZ';
const NOT_A_CERTIFICATE_CA = ['-----BEGIN CERTIFICATE-----', CA_MARKER, '-----END CERTIFICATE-----'].join('\n');
// GENUINE, public, certificate-only fixtures: the first two roots of the runtime's bundled
// Mozilla store. Nothing secret, no private key exists for them anywhere in this repository, and
// nothing is generated. They are test INPUT for the explicit-CA path only — the production policy
// still refuses to fall back to any trust store. Self-checked here so a fixture problem fails as
// "fixture", never as a false policy verdict.
assert.ok(rootCertificates.length >= 2, 'fixture: the runtime must bundle at least two root certificates');
const VALID_CA = rootCertificates[0].trim();
const SECOND_VALID_CA = rootCertificates[1].trim();
for (const pem of [VALID_CA, SECOND_VALID_CA]) new X509Certificate(pem);
/** A distinctive slice of the genuine certificate body, for the no-leak assertions. */
const VALID_CA_MARKER = VALID_CA.split('\n')[1];
const PASSWORD_MARKER = ['tmpos', 'synthetic', 'password', 'marker'].join('-');
/** A DSN carrying a credential — the shape whose leakage would matter most. */
const CREDENTIALED_DSN = `postgres://tmpos_unit:${PASSWORD_MARKER}@db.example.invalid:5432/tmpos_unit_secret`;

/** Every marker that must never appear in a thrown error, in any order. */
const SECRET_MARKERS = [CA_MARKER, NOT_A_CERTIFICATE_CA, VALID_CA_MARKER, PASSWORD_MARKER, CREDENTIALED_DSN];

/** Inspect the WHOLE error, not just its message: a stack frame or an attached property carries
 *  just as far into a log aggregator as the message does. */
const assertNoSecret = (err: Error | string, label: string): void => {
  const surface = typeof err === 'string'
    ? err
    : [err.message, err.stack ?? '', JSON.stringify(err, Object.getOwnPropertyNames(err))].join('\n');
  for (const marker of SECRET_MARKERS) {
    assert.ok(!surface.includes(marker), `${label}: a synthetic secret marker leaked into the error`);
  }
};

/**
 * Run `fn` with an exact environment, restoring the previous one and both clients after.
 *
 * The CA is supplied BY DEFAULT so that suites about principal separation stay about principal
 * separation; the S4.1a cases below override it (including to `undefined`) when the CA itself is
 * what is under test.
 */
async function withEnv(
  vars: Readonly<Record<string, string | undefined>>,
  fn: () => Promise<void> | void,
): Promise<void> {
  const keys = [
    SUPABASE_DATABASE_URL_VAR, APP_DATABASE_URL_VAR, 'SUPABASE_URL',
    'SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_ANON_KEY', CA_VAR, DRIVER_TLS_ENV,
  ];
  const saved = new Map(keys.map((k) => [k, process.env[k]]));
  const merged: Record<string, string | undefined> = { [CA_VAR]: VALID_CA, ...vars };
  await closeDb();
  await closeRuntimeDb();
  try {
    for (const k of keys) delete process.env[k];
    for (const [k, v] of Object.entries(merged)) if (v !== undefined) process.env[k] = v;
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
  });
});

// --- S4.1a: verified transport, fail-closed ---------------------------------
//
// The defect this section replaces: both principals were built with `ssl: 'require'`. In the
// installed driver that string means "encrypt, then accept ANY certificate" — postgres.js maps
// 'require' | 'allow' | 'prefer' to rejectUnauthorized:false. Encryption without authentication
// stops a passive eavesdropper and does nothing at all against an active one, so a DSN that
// resolved to an attacker-controlled endpoint would connect happily and hand over the password.
// The contract below is the repair: an explicit CA, chain verification ON, hostname verification
// left to Node, and every driver-controlled downgrade input refused BEFORE the client is built.

/** The exact TLS shape both principals must resolve to. Derived from the security contract,
 *  not read back from the implementation. */
const EXPECTED_TLS = { ca: VALID_CA, rejectUnauthorized: true };

test('S4.1a-1: both principals get an explicit verified-TLS object, never a string policy', async () => {
  // Catches: reverting to `ssl: 'require'`, or any string policy, at either construction site.
  await withEnv({ [SUPABASE_DATABASE_URL_VAR]: ADMIN_DSN, [APP_DATABASE_URL_VAR]: RUNTIME_DSN }, () => {
    for (const [label, client] of [['admin', getDb()], ['runtime', getRuntimeDb()]] as const) {
      const ssl = client.options.ssl as Record<string, unknown>;
      assert.equal(typeof ssl, 'object', `${label}: a string TLS policy is never the contract`);
      assert.deepEqual(ssl, EXPECTED_TLS, `${label}: exact verified-TLS options`);
    }
  });
});

test('S4.1a-2: no DSN shape can weaken the policy', async () => {
  // Catches: a hostname/loopback/socket-shaped heuristic that quietly drops verification.
  // Loopback is still a real network hop (a pooler sidecar on 127.0.0.1 carries the same
  // credentials), and a `?host=` URL only LOOKS like a Unix socket — postgres.js resolves the
  // endpoint from the host OPTION, so that shape actually dials localhost over TCP.
  const shapes = {
    remote: 'postgres://db.example.invalid:5432/tmpos_unit_remote',
    loopback: ADMIN_DSN,
    'localhost by name': 'postgres://localhost:5432/tmpos_unit_localhost',
    'socket-shaped URL': 'postgres:///tmpos_unit_socket?host=/tmp/tmpos-fixture-socket',
  };
  for (const [label, dsn] of Object.entries(shapes)) {
    await withEnv({ [SUPABASE_DATABASE_URL_VAR]: dsn, [APP_DATABASE_URL_VAR]: dsn }, () => {
      assert.deepEqual(getDb().options.ssl, EXPECTED_TLS, `${label}: admin`);
      assert.deepEqual(getRuntimeDb().options.ssl, EXPECTED_TLS, `${label}: runtime`);
    });
  }
});

/** Both principals resolve the policy INDEPENDENTLY, so every property is proved on both. */
const PRINCIPALS = [['admin', getDb], ['runtime', getRuntimeDb]] as const;
/** Configure both DSN variables at once, so a single case can exercise either principal. */
const bothDsns = (dsn: string) => ({ [SUPABASE_DATABASE_URL_VAR]: dsn, [APP_DATABASE_URL_VAR]: dsn });

test('S4.1a-3: hostname verification is left to Node — it is never replaced or disabled', async () => {
  // Catches: a `checkServerIdentity: () => undefined` "fix" for a certificate-name mismatch,
  // which silently re-opens the impersonation hole an explicit CA was added to close.
  await withEnv(bothDsns(ADMIN_DSN), () => {
    for (const [label, get] of PRINCIPALS) {
      const ssl = get().options.ssl as Record<string, unknown>;
      assert.deepEqual(Object.keys(ssl).sort(), ['ca', 'rejectUnauthorized'], `${label}: no extra TLS knobs`);
      assert.equal(ssl.rejectUnauthorized, true, `${label}: chain verification stays on`);
      assert.equal(ssl[['check', 'ServerIdentity'].join('')], undefined, `${label}: no hostname-check override`);
      assert.ok(Object.isFrozen(ssl), `${label}: the resolved policy must not be editable after construction`);
    }
  });
});

test('S4.1a-4: a missing CA fails closed, for BOTH principals, naming the variable only', async () => {
  // Catches: falling back to the platform trust store when the CA variable is unset — which
  // would connect successfully in most environments and hide the misconfiguration entirely.
  await withEnv({ ...bothDsns(CREDENTIALED_DSN), [CA_VAR]: undefined }, async () => {
    for (const [label, get] of PRINCIPALS) {
      const err = await errorOf(() => get());
      assert.ok(err.message.includes(CA_VAR), `${label}: the error must name the missing variable`);
      assertNoSecret(err, label);
    }
  });
});

test('S4.1a-5: a blank CA is absent, and a malformed CA is refused — on BOTH principals', async () => {
  // Catches: `!!value` presence checks that accept an empty secret; accepting a file path or a
  // truncated paste where PEM certificate material is required; an EMPTY certificate block,
  // which is well-formed to a delimiter check yet installs zero trust anchors; and — the S4.1a
  // correction — any block that is not an actually PARSEABLE X.509 certificate, any bundle with
  // one unparseable member (first OR last), and any non-whitespace content outside the blocks.
  for (const [label, ca] of [
    ['empty', ''],
    ['whitespace', '   \n\t '],
    ['not PEM', 'this-is-not-certificate-material'],
    ['a file path', '/etc/ssl/certs/ca.pem'],
    ['begin without end', '-----BEGIN CERTIFICATE-----\nQUJD'],
    ['end before begin', '-----END CERTIFICATE-----\nQUJD\n-----BEGIN CERTIFICATE-----'],
    ['empty block', '-----BEGIN CERTIFICATE-----\n\n-----END CERTIFICATE-----'],
    ['non-base64 body', '-----BEGIN CERTIFICATE-----\nnot base64!!\n-----END CERTIFICATE-----'],
    ['truncated base64 body', '-----BEGIN CERTIFICATE-----\nQUJDR\n-----END CERTIFICATE-----'],
    // Repeated BEGIN with no END: the shape a backtracking matcher scans quadratically.
    ['many unterminated blocks', '-----BEGIN CERTIFICATE-----'.repeat(500)],
    // The shapes the S4.1a CORRECTION adds: base64-legal and correctly framed, so every
    // structural check passes — only actually PARSING each block as X.509 refuses them. A trust
    // store loaded from any of these holds zero (or fewer-than-configured) anchors, and "the
    // first block parsed" says nothing about the anchors a handshake will actually need.
    ['base64-legal but not a certificate', NOT_A_CERTIFICATE_CA],
    ['genuine certificate then non-certificate block', [VALID_CA, NOT_A_CERTIFICATE_CA].join('\n')],
    ['non-certificate block then genuine certificate', [NOT_A_CERTIFICATE_CA, VALID_CA].join('\n')],
    ['non-whitespace content outside the blocks', `${VALID_CA}\ntrailing-operator-note`],
    ['duplicate BEGIN boundary inside a block',
      ['-----BEGIN CERTIFICATE-----', '-----BEGIN CERTIFICATE-----', 'QUJD', '-----END CERTIFICATE-----'].join('\n')],
    // Space-joined GENUINE certificates: every block parses in isolation, but a PEM loader only
    // recognises a marker at the start of a line, so the runtime trust store would SILENTLY load
    // only the first anchor. The validator sees normalised slices; the loader sees the whole
    // string — the accepted grammar must therefore be line-canonical at every marker.
    ['genuine certificate blocks joined on one line', [VALID_CA, SECOND_VALID_CA].join(' ')],
  ] as const) {
    await withEnv({ ...bothDsns(CREDENTIALED_DSN), [CA_VAR]: ca }, async () => {
      for (const [principal, get] of PRINCIPALS) {
        const err = await errorOf(() => get());
        assert.ok(err.message.includes(CA_VAR), `${principal} ${label}: must name the CA variable`);
        assertNoSecret(err, `${principal} ${label}`);
        // The marker list cannot cover every rejected input (a file path carries no marker), so
        // the raw value itself is also checked: a refusal may never echo what it refused.
        if (ca.trim() !== '') {
          assert.ok(!err.message.includes(ca.trim()), `${principal} ${label}: must not echo the rejected value`);
        }
      }
    });
  }
});

test('S4.1a-6: every driver-recognised downgrade value in the DSN is refused', async () => {
  // Derived from the installed driver's own resolution, verified independently: `?ssl=` and
  // `?sslmode=` both feed the driver's `ssl` option; 'disable'/'false' resolve to PLAINTEXT and
  // 'require'/'allow'/'prefer' resolve to unauthenticated TLS. Catches: an operator "fixing" a
  // certificate error by appending ?sslmode=disable to the connection string.
  //
  // The DSN carries a CREDENTIAL on purpose. Without one the no-leak assertions here are
  // vacuous — there would be no password in the environment for a message to leak — and the
  // realistic regression is exactly interpolating the raw DSN into this refusal.
  const values = ['require', 'allow', 'prefer', 'disable', 'false'];
  const variants = (v: string) => [v, v.toUpperCase(), `${v[0].toUpperCase()}${v.slice(1)}`, ` ${v} `];
  const cases: Array<{ key: string; value: string; dsn: string }> = [];
  for (const key of ['ssl', 'sslmode']) {
    for (const base of values) {
      for (const value of variants(base)) {
        cases.push({
          key,
          value,
          dsn: `postgres://tmpos_unit:${PASSWORD_MARKER}@db.example.invalid:5432/tmpos_unit_dg`
            + `?${key}=${encodeURIComponent(value)}`,
        });
      }
    }
    // A safe-looking FIRST value must not shield a downgrade in a repeated key: the driver
    // resolves last-wins, so a rule that read only the first value would miss this entirely.
    cases.push({
      key,
      value: 'disable',
      dsn: `postgres://tmpos_unit:${PASSWORD_MARKER}@db.example.invalid:5432/tmpos_unit_dup`
        + `?${key}=verify-full&${key}=disable`,
    });
  }
  for (const { key, value, dsn } of cases) {
    await withEnv(bothDsns(dsn), async () => {
      for (const [label, get] of PRINCIPALS) {
        const where = `${label} ${key}=${value}`;
        const err = await errorOf(() => get());
        assert.ok(err.message.includes(key), `${where}: must name the offending key`);
        assert.ok(!err.message.includes(value.trim()), `${where}: must not echo the value`);
        assertNoSecret(err, where);
      }
    });
  }
});

test('S4.1a-7: a secure DSN value cannot override or replace the repository-owned policy', async () => {
  // Catches: treating the DSN as authoritative when it happens to LOOK safe. `verify-full` is
  // not a downgrade, so it is not refused — but it must be inert, because it carries no CA and
  // the repository, not the connection string, owns this decision. An empty `?ssl=` is likewise
  // not a downgrade value and must not be mistaken for one.
  for (const dsn of [
    'postgres://db.example.invalid:5432/tmpos_unit_vf?sslmode=verify-full',
    'postgres://db.example.invalid:5432/tmpos_unit_empty?ssl=',
  ]) {
    await withEnv(bothDsns(dsn), () => {
      for (const [label, get] of PRINCIPALS) {
        assert.deepEqual(get().options.ssl, EXPECTED_TLS, `${label}: the repository object must win`);
      }
    });
  }
});

test(`S4.1a-8: a defined ${DRIVER_TLS_ENV} cannot select driver TLS policy, and is never mutated`, async () => {
  // The driver falls back to env['PG' + KEY] for an unset option, so this variable can select
  // transport security from outside the repository. Catches: deleting or overwriting it as the
  // "fix" — mutating process-wide state is invisible to every other consumer in the process.
  // '   ' belongs on the REFUSED list, not the ignored one: the driver resolves this fallback as
  // `env[KEY] || default`, so a whitespace-only value is truthy and really does become the ssl
  // option. Only the empty string falls through.
  for (const value of ['require', 'disable', 'prefer', 'verify-full', '   ']) {
    await withEnv({ ...bothDsns(CREDENTIALED_DSN), [DRIVER_TLS_ENV]: value }, async () => {
      for (const [label, get] of PRINCIPALS) {
        const err = await errorOf(() => get());
        assert.ok(err.message.includes(DRIVER_TLS_ENV), `${label} ${value}: must name the variable`);
        assertNoSecret(err, `${label} ${value}`);
      }
      assert.equal(process.env[DRIVER_TLS_ENV], value, 'the environment must not be mutated');
    });
  }
  // The EMPTY STRING selects nothing — `'' || default` is the default — so refusing it would
  // strand deployments that inject empty environment variables for no security gain.
  await withEnv({ ...bothDsns(ADMIN_DSN), [DRIVER_TLS_ENV]: '' }, () => {
    for (const [label, get] of PRINCIPALS) {
      assert.deepEqual(get().options.ssl, EXPECTED_TLS, `${label}: an empty fallback is not a policy`);
    }
  });
});

test('S4.1a-9: every refusal happens BEFORE the driver is invoked, on BOTH principals', async () => {
  // A DSN the DRIVER itself rejects with `Invalid URL`. If the repository guard ran second we
  // would see the driver's TypeError instead of ours, which is exactly how a "validate after
  // constructing" ordering bug would present. Catches: moving the policy call below postgres().
  const unparsable = 'postgres://[';
  for (const [label, vars, expected] of [
    ['missing CA', { [CA_VAR]: undefined }, CA_VAR],
    ['malformed CA', { [CA_VAR]: 'not-pem' }, CA_VAR],
    ['driver env fallback', { [DRIVER_TLS_ENV]: 'disable' }, DRIVER_TLS_ENV],
  ] as const) {
    await withEnv({ ...bothDsns(unparsable), ...vars }, async () => {
      for (const [principal, get] of PRINCIPALS) {
        const err = await errorOf(() => get());
        assert.ok(err.message.includes(expected), `${principal} ${label}: expected the repository refusal`);
        assert.ok(!/Invalid URL/i.test(err.message), `${principal} ${label}: the driver was reached first`);
      }
    });
  }
});

test('S4.1a-10: a refusal leaves no client behind, and recovery works in the SAME session', async () => {
  // Catches: memoizing a partially-built client on the failure path, which would hand a later
  // caller a connection whose transport was never validated — and the mirror defect, caching the
  // FAILURE so that repairing the configuration cannot take effect without a restart.
  await withEnv({ ...bothDsns(CREDENTIALED_DSN), [CA_VAR]: undefined }, async () => {
    for (const [label, get] of PRINCIPALS) {
      await errorOf(() => get());
      const second = await errorOf(() => get());
      assert.ok(second.message.includes(CA_VAR), `${label}: a refusal must not be cached into a success`);
    }
    // Repair the configuration in place — no closeDb(), no fresh scope — and both principals
    // must now build from the CURRENT settings.
    process.env[CA_VAR] = VALID_CA;
    for (const [label, get] of PRINCIPALS) {
      assert.deepEqual(get().options.ssl, EXPECTED_TLS, `${label}: recovery must not require a restart`);
    }
  });
  await withEnv({ [SUPABASE_DATABASE_URL_VAR]: ADMIN_DSN }, () => {
    assert.equal(getDb().options.database, 'tmpos_unit_admin', 'the client reflects the current DSN');
  });
});

test('S4.1a-11: the shared runtime options carry no transport decision of their own', async () => {
  // The disposable-PostgreSQL lanes import runtimeClientOptions() and supply their OWN transport
  // for a task-owned socket / plaintext loopback target. Two properties must hold together: the
  // helper must not smuggle a TLS decision into those call sites, and it must not fail-closed
  // there either — the CA contract binds the endpoints the REPOSITORY dials, not a caller that
  // brings its own. Catches: folding resolveDatabaseTls() into the shared options builder, which
  // would break every disposable lane the moment a CA is absent.
  await withEnv({ [CA_VAR]: undefined }, () => {
    const opts = runtimeClientOptions(ADMIN_DSN) as Record<string, unknown>;
    assert.ok(!('ssl' in opts), 'the shared options must not decide transport');
    const conn = opts.connection as Record<string, unknown>;
    assert.equal(conn.statement_timeout, DB_SESSION_BOUNDS.statement_timeout, 'bounds are preserved');
    assert.equal(opts.prepare, false, 'pooler-safe prepare:false is preserved');
  });
});

test('S4.1a-12: db.ts resolves no string TLS policy and never resolves ssl to false', async () => {
  // A structural backstop for the behavioural cases above: the two shapes that would silently
  // undo them are absent from the source itself.
  const code = readFileSync(join(HERE, 'db.ts'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !l.trim().startsWith('//'))
    .join('\n');
  assert.ok(!/ssl:\s*false/.test(code), 'db.ts must never resolve ssl to false');
  assert.ok(!/ssl:\s*['"]/.test(code), 'db.ts must never resolve a string TLS policy');
});

test('S4.1a-13: the S4.1a variable NAMES are exported constants, never inlined literals', async () => {
  // The counterpart to S2-7 for the transport variables. Pinning the literals HERE is what lets
  // every case above use the constants without the suite becoming a tautology over a rename.
  assert.equal(DATABASE_CA_CERT_VAR, 'DATABASE_CA_CERT');
  assert.equal(DRIVER_TLS_ENV_VAR, ['PG', 'SSL'].join(''));
  // Presence is reported, never enforced here — and a blank secret reports ABSENT, because
  // `!!process.env.X` on a whitespace value would claim a trust anchor that does not exist.
  await withEnv({ [SUPABASE_DATABASE_URL_VAR]: ADMIN_DSN }, () => {
    assert.equal(getConfigPresence().databaseCaCert, true);
  });
  await withEnv({ [SUPABASE_DATABASE_URL_VAR]: ADMIN_DSN, [CA_VAR]: '   ' }, () => {
    assert.equal(getConfigPresence().databaseCaCert, false, 'a blank CA is not a configured CA');
  });
});

test('S4.1a-14: every accepted CA block is an actually parseable X.509 certificate', async () => {
  // The success half first: genuine certificates — single and bundled — are ACCEPTED, so the
  // parser cannot degenerate into reject-all. The fixtures are public roots from the runtime's
  // bundled store; accepting them proves offline PARSEABILITY and nothing more — no chain trust,
  // no validity at connection time, no hostname match, no live endpoint behaviour.
  await withEnv(bothDsns(ADMIN_DSN), () => {
    for (const [label, get] of PRINCIPALS) {
      assert.deepEqual(get().options.ssl, EXPECTED_TLS, `${label}: a genuine certificate is accepted`);
    }
  });
  const bundle = [VALID_CA, SECOND_VALID_CA].join('\n');
  await withEnv({ ...bothDsns(ADMIN_DSN), [CA_VAR]: bundle }, () => {
    for (const [label, get] of PRINCIPALS) {
      assert.deepEqual(
        get().options.ssl,
        { ca: bundle, rejectUnauthorized: true },
        `${label}: a bundle of genuine certificates is accepted whole`,
      );
    }
  });
  // CRLF line endings are how a Windows operator's paste arrives; '\r' is whitespace to the
  // outside-block checks and legal inside a PEM body, so the value must be accepted verbatim.
  const crlf = VALID_CA.replace(/\n/g, '\r\n');
  await withEnv({ ...bothDsns(ADMIN_DSN), [CA_VAR]: crlf }, () => {
    for (const [label, get] of PRINCIPALS) {
      assert.deepEqual(get().options.ssl, { ca: crlf, rejectUnauthorized: true }, `${label}: CRLF PEM is accepted`);
    }
  });

  // The rejection half happens BEFORE the driver could be invoked: with a DSN the driver itself
  // rejects, a base64-legal non-certificate CA must still surface the repository's own refusal —
  // naming the CA variable, not the driver's `Invalid URL` — so ZERO clients are constructed for
  // either principal. Same construction-ordering technique as S4.1a-9.
  await withEnv({ ...bothDsns('postgres://['), [CA_VAR]: NOT_A_CERTIFICATE_CA }, async () => {
    for (const [label, get] of PRINCIPALS) {
      const err = await errorOf(() => get());
      assert.ok(err.message.includes(CA_VAR), `${label}: the X.509 refusal must name the CA variable`);
      assert.ok(!/Invalid URL/i.test(err.message), `${label}: the driver must never be reached`);
      assertNoSecret(err, label);
    }
  });

  // Same-session recovery: replacing the non-certificate value with a genuine one must build a
  // client without a restart — the X.509 refusal is not cached, mirroring S4.1a-10.
  await withEnv({ ...bothDsns(CREDENTIALED_DSN), [CA_VAR]: NOT_A_CERTIFICATE_CA }, async () => {
    for (const [, get] of PRINCIPALS) await errorOf(() => get());
    process.env[CA_VAR] = VALID_CA;
    for (const [label, get] of PRINCIPALS) {
      assert.deepEqual(get().options.ssl, EXPECTED_TLS, `${label}: recovery in the same session`);
    }
  });
});
