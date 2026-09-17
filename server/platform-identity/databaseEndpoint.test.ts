// Phase 4.0 M6-PG-P7-R1 — the runtime database endpoint classifier (databaseEndpoint.ts).
//
// Synthetic URLs only: no secret is read, and nothing is contacted — the suite counts every DNS lookup, socket connect and TLS
// connect while it classifies, and requires none. It pins that a direct or session-pooler endpoint on 5432 is accepted and
// nothing else is; that every refusal is one of three bounded codes and an accepted handle carries no routing value or credential;
// and that the grammar is the frozen migration executor's own — each pattern text equal, and both validators agreeing over one
// corpus — so the runtime's reading of an endpoint cannot drift from the governed one.
import test from 'node:test';
import assert from 'node:assert/strict';
import dns from 'node:dns';
import net from 'node:net';
import tls from 'node:tls';
import { inspect } from 'node:util';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ENDPOINT_GRAMMAR, classifyRuntimeDatabaseUrl, sealedRuntimeTarget } from './databaseEndpoint.js';
import type { RuntimeDatabaseEndpoint } from './databaseEndpoint.js';
import { assertManagedDevDsn } from './migrationExecutor.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REF = 'abcdefghijklmnop';
const OTHER = 'qrstuvwxyzabcdef';
const DIRECT = `db.${REF}.supabase.co`;
const POOLER = 'aws-0-eu-west-1.pooler.supabase.com';
const PW = 'synthetic-pw';
const url = (user: string, host: string, rest = ':5432/postgres'): string => `postgres://${user}:${PW}@${host}${rest}`;

const accepted = (raw: string): RuntimeDatabaseEndpoint => {
  const result = classifyRuntimeDatabaseUrl(raw);
  assert.equal(typeof result, 'object', `must be accepted: ${raw}`);
  return result as RuntimeDatabaseEndpoint;
};

/** Every DNS lookup, socket connect and TLS connect made while `fn` runs. */
async function contactsDuring(fn: () => unknown): Promise<number> {
  let contacts = 0;
  const lookup = dns.lookup;
  const promised = dns.promises.lookup;
  const connect = net.Socket.prototype.connect;
  const tlsConnect = tls.connect;
  dns.lookup = ((...args: unknown[]) => { contacts++; return (lookup as (...a: unknown[]) => unknown)(...args); }) as typeof dns.lookup;
  dns.promises.lookup = ((...args: unknown[]) => { contacts++; return (promised as (...a: unknown[]) => unknown)(...args); }) as typeof dns.promises.lookup;
  net.Socket.prototype.connect = function (this: net.Socket, ...args: unknown[]) { contacts++; return (connect as (...a: unknown[]) => net.Socket).apply(this, args); } as typeof connect;
  tls.connect = ((...args: unknown[]) => { contacts++; return (tlsConnect as (...a: unknown[]) => tls.TLSSocket)(...args); }) as typeof tls.connect;
  try {
    await fn();
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    dns.lookup = lookup;
    dns.promises.lookup = promised;
    net.Socket.prototype.connect = connect;
    tls.connect = tlsConnect;
  }
  return contacts;
}

test('a direct database endpoint and the shared session pooler on 5432 are accepted, each sealed exactly as written', () => {
  for (const [raw, family, host, user] of [
    [url('tmpos_runtime', DIRECT), 'direct', DIRECT, 'tmpos_runtime'],
    [url('tmpos_runtime', DIRECT, '/postgres'), 'direct', DIRECT, 'tmpos_runtime'], // no port: 5432
    [`postgresql://tmpos_runtime.${REF}:${PW}@DB.${REF.toUpperCase()}.SUPABASE.CO:5432/postgres`, 'direct', DIRECT, `tmpos_runtime.${REF}`],
    [url(`tmpos_runtime.${REF}`, POOLER), 'session_pooler', POOLER, `tmpos_runtime.${REF}`],
    [url(`tmpos_runtime.${REF}`, 'aws-1-us-east-2.pooler.supabase.com'), 'session_pooler', 'aws-1-us-east-2.pooler.supabase.com', `tmpos_runtime.${REF}`],
  ] as const) {
    const endpoint = accepted(raw);
    assert.equal(endpoint.family, family, raw);
    assert.ok(Object.isFrozen(endpoint));
    assert.deepEqual(Object.keys(endpoint).sort(), ['family', 'kind'], 'the handle names its family and nothing else');
    const target = sealedRuntimeTarget(endpoint);
    assert.deepEqual({ ...target, tlsPolicySource: undefined }, { host, port: 5432, database: 'postgres', user, password: PW, tlsPolicySource: undefined });
    assert.ok(!target.tlsPolicySource.includes(PW) && !target.tlsPolicySource.includes('tmpos_runtime'), 'the transport check never sees the credential');
    assert.ok(Object.isFrozen(target));
  }
  // The provider's custom-role username is taken as configured — a password with reserved characters, percent-encoded, too.
  const encoded = accepted(`postgres://tmpos_runtime.${REF}:p%40ss%3Aword%2F1@${POOLER}:5432/postgres`);
  assert.equal(sealedRuntimeTarget(encoded).password, 'p@ss:word/1');
});

test('a transaction pooler, shared or dedicated, and every other endpoint are unsupported — not by port alone', () => {
  const unsupported = [
    url(`tmpos_runtime.${REF}`, POOLER, ':6543/postgres'), // the shared transaction pooler
    url('tmpos_runtime', DIRECT, ':6543/postgres'), // the dedicated transaction pooler
    url(`tmpos_runtime.${REF}`, POOLER, ':06543/postgres'),
    url('tmpos_runtime', DIRECT, ':5433/postgres'),
    url('tmpos_runtime', DIRECT, ':6432/postgres'),
    url('tmpos_runtime', 'attacker.example'), // the right port on an unknown host
    url('tmpos_runtime', 'localhost'),
    url('tmpos_runtime', '127.0.0.1'),
    url('tmpos_runtime', '10.0.0.9'),
    url('tmpos_runtime', '[::1]'),
    url(`tmpos_runtime.${REF}`, 'db.pooler.supabase.com'), // a `db.` claim that is not the direct host
    url('tmpos_runtime', `db.${REF}.supabase.com`),
    url('tmpos_runtime', `db.${REF}.extra.supabase.co`),
    url('tmpos_runtime', `${DIRECT}.attacker.example`),
    url('tmpos_runtime', `${DIRECT}.`),
    url(`tmpos_runtime.${REF}`, `x.${POOLER}`),
    url(`tmpos_runtime.${REF}`, 'pooler.supabase.com'),
    url(`tmpos_runtime.${REF}`, '-aws.pooler.supabase.com'),
    url('tmpos_runtime', `attacker.example,${DIRECT}`), // a multihost list
    url('tmpos_runtime', `db.%61${REF.slice(1)}.supabase.co`), // an encoded host
    url('tmpos_runtime', `${DIRECT}%3A6543`),
    url('tmpos_runtime', `%2Ftmp%2Fsock`),
    'postgres:///postgres?host=/tmp/sock',
    `${url('tmpos_runtime', DIRECT)}?host=attacker.example`,
    `${url('tmpos_runtime', DIRECT)}?hostaddr=10.0.0.9`,
    `${url(`tmpos_runtime.${REF}`, POOLER)}?port=6543`,
    `${url(`tmpos_runtime.${REF}`, POOLER)}?pgbouncer=true`,
    `${url(`tmpos_runtime.${REF}`, POOLER)}?pool_mode=transaction`,
    `${url(`tmpos_runtime.${REF}`, POOLER)}?sslmode=verify-full&pgbouncer=1`,
  ];
  for (const raw of unsupported) assert.equal(classifyRuntimeDatabaseUrl(raw), 'app_database_endpoint_unsupported', raw);
});

test('a missing, malformed, ambiguous or self-contradicting URL is refused with a bounded code', () => {
  for (const raw of [undefined, null, '']) assert.equal(classifyRuntimeDatabaseUrl(raw), 'app_database_url_missing', String(raw));
  const invalid = [
    '   ', 42, {}, 'not a url', `https://tmpos_runtime:${PW}@${DIRECT}:5432/postgres`, `mysql://tmpos_runtime:${PW}@${DIRECT}:5432/postgres`,
    `postgres://tmpos_runtime:${PW}@${DIRECT}:5432,${POOLER}:5432/postgres`, // a second port: no URL at all
    `postgres://${PW}@${DIRECT}:5432/postgres`, // no role: the driver would use an ambient one
    `postgres://tmpos_runtime@${DIRECT}:5432/postgres`, // no password: likewise
    `postgres://:${PW}@${DIRECT}:5432/postgres`,
    `postgres://tmpos%00runtime:${PW}@${DIRECT}:5432/postgres`,
    `postgres://tmpos_runtime:pw%00x@${DIRECT}:5432/postgres`,
    `postgres://tmpos_runtime:pw%ZZ@${DIRECT}:5432/postgres`,
    `postgres://tmpos%E0runtime:${PW}@${DIRECT}:5432/postgres`,
    url('tmpos_runtime', DIRECT, ':5432/'), // no database: the driver would default one
    url('tmpos_runtime', DIRECT, ':5432'),
    url('tmpos_runtime', DIRECT, ':5432/postgres/extra'),
    url('tmpos_runtime', DIRECT, ':5432/post%ZZgres'),
    `postgres://tmpos_runtime:${PW}@evil@${DIRECT}:5432/postgres`, // two `@`: parsers disagree where the host begins
    url('tmpos_runtime', POOLER), // the pooler routes by `<role>.<ref>`
    url(`tmpos_runtime.${OTHER}`, DIRECT), // one URL naming two projects
    `${url('tmpos_runtime', DIRECT)}?sslmode=verify-full`, // transport is the repository's
    `${url('tmpos_runtime', DIRECT)}?sslmode=disable`,
    `${url('tmpos_runtime', DIRECT)}?options=-c%20search_path%3Dpublic`,
    `${url('tmpos_runtime', DIRECT)}?application_name=a&application_name=b`,
    `${url(`tmpos_runtime.${REF}`, POOLER)}?pgbouncer=false`,
    `${url('tmpos_runtime', DIRECT)}#fragment`,
    `${url('tmpos_runtime', DIRECT)}?`, // an empty query or fragment delimiter is still not the URL as written
    `${url('tmpos_runtime', DIRECT)}#`,
    // Spellings a URL parser would normalise to the governed endpoint: judged as written, they are refused.
    url('tmpos_runtime', `db.${REF}.supa\tbase.co`),
    `${url('tmpos_runtime', DIRECT)}\n`,
    ` ${url('tmpos_runtime', DIRECT)}`,
    `postgres://tmpos_runtime:synthetic\tpw@${DIRECT}:5432/postgres`,
    url('tmpos_runtime', DIRECT, ':05432/postgres'),
    url('tmpos_runtime', DIRECT, ':/postgres'),
  ];
  for (const raw of invalid) assert.equal(classifyRuntimeDatabaseUrl(raw), 'app_database_url_invalid', String(raw));
});

test('nothing classified or refused carries the URL, the role, the host, the project, a query value or the password', () => {
  const secrets = [PW, 'tmpos_runtime', REF, 'supabase', 'aws-0', 'secret-query-value', 'attacker'];
  const outputs = [
    classifyRuntimeDatabaseUrl(url('tmpos_runtime', DIRECT)),
    classifyRuntimeDatabaseUrl(url(`tmpos_runtime.${REF}`, POOLER)),
    classifyRuntimeDatabaseUrl(`${url('tmpos_runtime', DIRECT)}?application_name=secret-query-value`),
    classifyRuntimeDatabaseUrl(url('tmpos_runtime', 'attacker.example')),
    classifyRuntimeDatabaseUrl(`postgres://tmpos_runtime:${PW}@${DIRECT}:5432`),
  ];
  for (const output of outputs) {
    for (const view of [String(output), JSON.stringify(output), inspect(output, { depth: 5, showHidden: true })]) {
      for (const secret of secrets) assert.ok(!view.includes(secret), `${view} carries ${secret}`);
    }
  }
  assert.throws(() => sealedRuntimeTarget(Object.freeze({ kind: 'runtime_database_endpoint', family: 'direct' })), (err: unknown) =>
    err instanceof TypeError && err.message === 'runtime database endpoint invalid', 'a forged handle opens nothing');
});

test('classification resolves no name, opens no socket and starts no TLS', async () => {
  // Positive control: the counters do observe a real attempt.
  const control = await contactsDuring(() => new Promise<void>((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port: 9 });
    socket.on('error', () => resolve());
    socket.on('connect', () => { socket.destroy(); resolve(); });
  }));
  assert.ok(control >= 1, 'the counters see a connect');
  const contacts = await contactsDuring(() => {
    for (const raw of [url('tmpos_runtime', DIRECT), url(`tmpos_runtime.${REF}`, POOLER), url(`tmpos_runtime.${REF}`, POOLER, ':6543/postgres'),
      url('tmpos_runtime', 'attacker.example'), 'not a url']) {
      classifyRuntimeDatabaseUrl(raw);
    }
  });
  assert.equal(contacts, 0);
});

// --- parity with the governed classifier: the frozen managed endpoint validator in migrationExecutor.ts ---

test('every endpoint pattern is the frozen migration executor\'s own text', () => {
  const executor = readFileSync(join(HERE, 'migrationExecutor.ts'), 'utf8');
  const constant = (name: string): string => {
    const m = new RegExp(`^const ${name}(?::[^=]+)? = (.+);$`, 'm').exec(executor);
    assert.ok(m, `the executor defines ${name}`);
    return m[1];
  };
  const stringOf = (name: string): string => {
    const m = /^'([^']*)'$/.exec(constant(name));
    assert.ok(m, `${name} is a string literal`);
    return m[1];
  };
  assert.equal(stringOf('DNS_LABEL'), ENDPOINT_GRAMMAR.DNS_LABEL);
  assert.equal(stringOf('PROJECT_REF'), ENDPOINT_GRAMMAR.PROJECT_REF);
  // Each pattern evaluated from the executor's own expression, over its own constants.
  const evaluate = (name: string): RegExp =>
    new Function('DNS_LABEL', 'PROJECT_REF', `return ${constant(name)};`)(ENDPOINT_GRAMMAR.DNS_LABEL, ENDPOINT_GRAMMAR.PROJECT_REF) as RegExp;
  for (const name of ['POOLER_HOST', 'DB_HOST_REF', 'DB_HOST_CLAIM', 'USER_REF'] as const) {
    const theirs = evaluate(name);
    assert.equal(ENDPOINT_GRAMMAR[name].source, theirs.source, name);
    assert.equal(ENDPOINT_GRAMMAR[name].flags, theirs.flags, name);
  }
  assert.equal(constant('MANAGED_SESSION_PORTS'), `new Set(${JSON.stringify(ENDPOINT_GRAMMAR.SESSION_PORTS).replace(/"/g, "'")})`);
  assert.ok(executor.includes(`!${ENDPOINT_GRAMMAR.ROLE.toString()}.test(declaredUser)`), 'the role grammar');
  const pool = /^const POOL_PARAMS: [^\n]* = \[\n((?:\s+\[.*\],\n)+)\];$/m.exec(executor);
  assert.ok(pool, 'the executor defines POOL_PARAMS');
  const theirs = [...pool[1].matchAll(/\['(\w+)', \(v\) => v !== '(\w+)'\]/g)].map((m) => [m[1], m[2]]);
  assert.equal(theirs.length, ENDPOINT_GRAMMAR.POOL_PARAMS.length);
  for (const [[param, predicate], [name, allowed]] of ENDPOINT_GRAMMAR.POOL_PARAMS.map((p, i) => [p, theirs[i]] as const)) {
    assert.equal(param, name);
    assert.equal(predicate(allowed), false, `${name}=${allowed} declares no pooling`);
    assert.equal(predicate('true'), true, `${name}=true declares pooling`);
  }
});

test('the runtime classifier and the migration executor accept exactly the same endpoints, and the runtime nothing more', () => {
  const hosts = [DIRECT, `DB.${REF.toUpperCase()}.SUPABASE.CO`, POOLER, 'aws-1-us-east-2.pooler.supabase.com', 'db.pooler.supabase.com', `db.${REF}.supabase.com`,
    `x.${POOLER}`, 'pooler.supabase.com', `db.${REF}.extra.supabase.co`, 'attacker.example', 'localhost', '127.0.0.1', `attacker.example,${DIRECT}`,
    `${DIRECT}.`, '-aws.pooler.supabase.com'];
  const ports = ['', ':5432', ':6543', ':5433', ':06543'];
  const users = ['tmpos_runtime', `tmpos_runtime.${REF}`, `postgres.${REF}`];
  const queries = ['', '?pgbouncer=true', '?pool_mode=transaction', '?pgbouncer=false', '?pool_mode=session'];
  const executorAccepts = (raw: string): boolean => {
    try {
      assertManagedDevDsn(raw, `https://${REF}.supabase.co`, 'postgres');
      return true;
    } catch {
      return false;
    }
  };
  let agreedAccepts = 0;
  let agreedRefusals = 0;
  for (const host of hosts) for (const port of ports) for (const user of users) for (const query of queries) {
    const raw = `postgres://${user}:${PW}@${host}${port}/postgres${query}`;
    const runtime = typeof classifyRuntimeDatabaseUrl(raw) === 'object';
    const governed = executorAccepts(raw);
    if (runtime) assert.ok(governed, `the runtime accepts what the governed classifier refuses: ${raw}`);
    // Without a query the two agree exactly; with one, the runtime refuses what it would never hand the driver.
    if (query === '') assert.equal(runtime, governed, raw);
    if (runtime && governed) agreedAccepts++;
    if (!runtime && !governed) agreedRefusals++;
  }
  assert.ok(agreedAccepts >= 10 && agreedRefusals >= 500, `a corpus with both outcomes (${agreedAccepts} accepted, ${agreedRefusals} refused)`);
});
