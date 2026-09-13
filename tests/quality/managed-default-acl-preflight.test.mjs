/**
 * C2B-M005-P0 — deterministic suite for the fixed READ-ONLY default-ACL diagnostic.
 *
 * EVERYTHING HERE IS SYNTHETIC. No database, no socket, no secret, no process. The child is driven
 * through injected ports so the ENTIRE ordering — including that the READ ONLY bracket opens before
 * any diagnostic query — is observable as a recorded call sequence rather than inferred from source
 * text. The launcher is driven with injected dependencies so its argv contract is proved without
 * ever starting a real child.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_ACL_ROW_LIMIT,
  M005_DEFAULT_ACL_CLASSES,
  M005_DEFAULT_ACL_GRANTEES,
  M005_UNCOVERED_DEFAULT_ACL_CLASSES,
  assessDefaultAclPosture,
  classifyDefaultPrivileges,
  defaultAclObjtypePredicate,
  readDefaultAclRowsBounded,
} from '../../server/platform-identity/migrationExecutor.ts';

import {
  EXPECTED_DATABASE,
  EXPECTED_DEV_TARGET,
  PREFLIGHT_CODES,
  TX_TIMEOUT_MS,
  choosePosture,
  exitCodeFor,
  main as childMain,
  runDiagnostic,
} from '../../scripts/managed-default-acl-preflight.ts';

import {
  PREFLIGHT_FIELD_KEYS,
  PREFLIGHT_TRANSCRIPT_TAGS,
  TERMINAL_OUTCOME_VOCABULARY,
  canonicalPreflightLine,
  terminalCompletion,
} from '../../scripts/managed-m005-launcher.mjs';

import {
  CHILD_ENV_KEYS,
  FORBIDDEN_CHILD_TOKENS,
  PARENT_FLAG,
  PREFLIGHT_FLAGS,
  PREFLIGHT_LAUNCHER_CODES,
  PREFLIGHT_SCRIPT,
  STARTUP_SENSITIVE,
  assertChildArgvContract,
  dispositionFor,
  main as launcherMain,
  renderPreflightReport,
} from '../../scripts/managed-default-acl-preflight-launcher.mjs';

import { CHILD_BLOCK_SENTINEL } from '../../scripts/managed-m005-launcher.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..');
const PRINCIPAL = 'tmpos_migrator';

/** A well-formed environment. Values are SYNTHETIC and exist only to be refused or redacted. */
const goodEnv = (over = {}) => ({
  NODE_ENV: 'development',
  CONFIRM_SUPABASE_TARGET: EXPECTED_DEV_TARGET,
  ALLOW_SUPABASE_MIGRATION_APPLY: '1',
  // The username is a realistic multi-character identifier ON PURPOSE. The accepted redactor
  // promotes every secret-derived token, so a one-character username becomes a token that matches
  // inside ordinary words and redacts the launcher's own report wholesale — correct fail-closed
  // behaviour, but it would make this fixture prove nothing about the record's content.
  SUPABASE_DATABASE_URL: 'postgresql://synthuser:SYNTHETICPASSWORD@db.synthref0000000.supabase.co:5432/postgres',
  SUPABASE_URL: 'https://synthref0000000.supabase.co',
  DATABASE_CA_CERT: '-----BEGIN CERTIFICATE-----\nSYNTHETIC\n-----END CERTIFICATE-----',
  ...over,
});

/** One default-ACL row, spelled the way the catalog projection spells it. */
const row = (o = {}) => ({ owner: PRINCIPAL, objtype: 'f', scope: '', grantee: null, privilege: null, ...o });

/**
 * A fake managed handle that RECORDS every port call in order.
 *
 * The ports the diagnostic must never touch — ledger, write, ownerAcl — are present and THROW. A
 * test cannot then pass by accident because a forbidden port happened to be unused in one
 * arrangement; reaching it fails loudly wherever it is reached.
 */
function fakeHandle({
  aclRows = [], readOnly = [true, true], identity = {}, teardown = true, failAt = null,
  // The BACKEND CONTINUITY tokens, consumed in order by the two `backendIdentity()` captures.
  // Equal by default, because continuity is the ordinary case; a second, different entry models a
  // driver-level reconnect and an `undefined`/malformed entry models an unreadable one.
  backendTokens = ['pid:4242', 'pid:4242'],
} = {}) {
  const calls = [];
  const forbid = (name) => () => { calls.push(`FORBIDDEN:${name}`); throw new Error('forbidden port'); };
  const step = (name, fn) => async (...a) => {
    calls.push(name);
    if (failAt === name) throw new Error('injected failure');
    return await fn(...a);
  };
  let roIdx = 0;
  let tokIdx = 0;
  const session = {
    backendIdentity: step('backendIdentity', async () => {
      const t = backendTokens[tokIdx];
      tokIdx += 1;
      return t === null ? null : { token: t };
    }),
    // Every write-capable member of the real session is present and THROWS, so capturing the
    // session in the child cannot quietly become a route to one.
    executeSql: forbid('executeSql'),
    beginTx: forbid('beginTx'),
    commitTx: forbid('commitTx'),
    acquireRunLock: forbid('acquireRunLock'),
    releaseRunLock: forbid('releaseRunLock'),
    close: forbid('close'),
    terminate: forbid('terminate'),
  };
  const who = { principal: PRINCIPAL, session_principal: PRINCIPAL, db: EXPECTED_DATABASE, ...identity };
  const handle = {
    adapter: { reserve: step('reserve', async () => session), cancelReserve: forbid('cancelReserve') },
    readOnlyTx: {
      begin: step('begin', async () => {}),
      applyLocalTimeouts: step('applyLocalTimeouts', async (ms) => { calls.push(`timeout:${String(ms)}`); }),
      isReadOnly: step('isReadOnly', async () => { const v = readOnly[roIdx]; roIdx += 1; return v === undefined ? true : v; }),
      finish: step('finish', async () => {}),
    },
    catalog: {
      query: step('query', async (text) => {
        if (text.includes('current_user as principal')) return [who];
        if (text.includes('pg_default_acl')) return aclRows;
        return [];
      }),
    },
    ledger: { readLedger: forbid('readLedger'), insertDirtyAttempt: forbid('insertDirtyAttempt'), finalizeApplied: forbid('finalizeApplied') },
    write: { writeAdoptedPrefix: forbid('writeAdoptedPrefix') },
    ownerAcl: {
      databasePublicPrivileges: forbid('databasePublicPrivileges'),
      isCurrentPrincipalDatabaseOwner: forbid('isCurrentPrincipalDatabaseOwner'),
      revokeTemporaryFromPublic: forbid('revokeTemporaryFromPublic'),
    },
    // A boolean keeps the original meaning (`completed`); an OBJECT is returned verbatim so the
    // cleanup matrix can supply missing, malformed and truthy-but-not-`true` completion evidence.
    dispose: step('dispose', async () => (
      (typeof teardown === 'object' && teardown !== null) || typeof teardown === 'string'
        ? teardown
        : { requested: true, completed: teardown, gracefulSocketClose: 'not_observed', code: teardown ? null : 'x' }
    )),
  };
  return { handle, calls };
}

/** Drive the child with a fake handle and capture its bounded output. */
async function drive(env, opts = {}) {
  const { handle, calls } = fakeHandle(opts);
  const out = [];
  let created = 0;
  const rc = await runDiagnostic(env, (l) => out.push(l), {
    assertDsn: () => ({}),
    describeDsn: () => ({ endpointFamily: 'session', database: opts.database ?? EXPECTED_DATABASE }),
    createExecutor: async () => { created += 1; calls.push('createExecutor'); return handle; },
    fingerprint: async () => opts.fingerprintFailures ?? [],
    readAcl: opts.readAcl ?? (async (p, limit) => await readDefaultAclRowsBounded(p, limit)),
  });
  return { rc, out, calls, created };
}

// ---------------------------------------------------------------------------
// 1. fixed action, argv and import safety
// ---------------------------------------------------------------------------

test('C2B-M005-P0: the launcher accepts exactly one action and refuses everything else', async () => {
  const seen = [];
  const deps = { out: (l) => seen.push(l), err: (l) => seen.push(l) };
  for (const argv of [[], ['--execute'], ['--execute-m005'], ['--status'], [PARENT_FLAG, '--apply'], ['--inspect-default-acls=1']]) {
    assert.equal(await launcherMain(argv, {}, deps), 2, JSON.stringify(argv));
  }
  assert.ok(seen.some((l) => l.includes(PREFLIGHT_LAUNCHER_CODES.BAD_INVOCATION)));
});

test('C2B-M005-P0: the child argv is the fixed two-element command and carries no migration token', () => {
  const tsxCli = join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  assert.equal(PREFLIGHT_FLAGS.length, 0, 'the fixed tail is empty');
  assert.equal(assertChildArgvContract([tsxCli, PREFLIGHT_SCRIPT]), true);
  for (const bad of [
    [tsxCli],
    [tsxCli, PREFLIGHT_SCRIPT, '--apply'],
    // A BENIGN extra element, deliberately: the case above is caught by the forbidden-token list,
    // so it proves nothing about the length guard. Only an extra argument that is on no list can
    // show that the argv LENGTH is itself part of the contract.
    [tsxCli, PREFLIGHT_SCRIPT, '--verbose'],
    [tsxCli, PREFLIGHT_SCRIPT, 'trailing'],
    ['/usr/bin/other', PREFLIGHT_SCRIPT],
    [tsxCli, join(REPO_ROOT, 'scripts', 'supabase-migrate.ts')],
    [tsxCli, join(REPO_ROOT, 'scripts', 'managed-m005-launcher.mjs')],
  ]) {
    assert.throws(() => assertChildArgvContract(bad), /argv_contract_violated/, JSON.stringify(bad));
  }
});

test('C2B-M005-P0: the forbidden-token list names the migration CLI and every migration flag', () => {
  for (const t of ['supabase-migrate.ts', '--apply', '--managed-dev', '--baseline', '--status', '--execute-m005']) {
    assert.ok(FORBIDDEN_CHILD_TOKENS.includes(t), t);
  }
});

test('C2B-M005-P0: neither new module imports the migration CLI or another launcher entry point', () => {
  const child = readFileSync(join(REPO_ROOT, 'scripts/managed-default-acl-preflight.ts'), 'utf8');
  assert.ok(!/from\s+'[^']*supabase-migrate/.test(child));
  assert.ok(!/from\s+'[^']*managed-(baseline|m005)-launcher/.test(child));
  const launcher = readFileSync(join(REPO_ROOT, 'scripts/managed-default-acl-preflight-launcher.mjs'), 'utf8');
  assert.ok(!/from\s+'[^']*supabase-migrate/.test(launcher));
});

test('C2B-M005-P0: importing either new module starts nothing', () => {
  // Both were imported at the top of this file. If either had an unguarded entry point, importing
  // it would have opened a client or spawned a child before this line ran.
  assert.equal(typeof runDiagnostic, 'function');
  assert.equal(typeof launcherMain, 'function');
  assert.equal(PARENT_FLAG, '--inspect-default-acls');
});

// ---------------------------------------------------------------------------
// 2. refusals BEFORE any client is constructed
// ---------------------------------------------------------------------------

test('C2B-M005-P0: production and an unconfirmed target refuse before a client exists', async () => {
  for (const env of [
    goodEnv({ NODE_ENV: 'production' }),
    goodEnv({ CONFIRM_SUPABASE_TARGET: 'other' }),
    goodEnv({ CONFIRM_SUPABASE_TARGET: undefined }),
  ]) {
    const r = await drive(env);
    assert.equal(r.rc, 2);
    assert.equal(r.created, 0, 'no executor may be constructed on a refused gate');
    assert.deepEqual(r.calls, [], 'no port may be touched on a refused gate');
  }
});

test('C2B-M005-P0: the target refusal names the variable and never its value', async () => {
  const r = await drive(goodEnv({ CONFIRM_SUPABASE_TARGET: 'SECRETLOOKINGVALUE' }));
  assert.ok(r.out.some((l) => l.includes('name=CONFIRM_SUPABASE_TARGET')));
  assert.ok(!r.out.some((l) => l.includes('SECRETLOOKINGVALUE')));
});

test('C2B-M005-P0: a database other than the confirmed one refuses before reserving', async () => {
  const r = await drive(goodEnv(), { database: 'not_postgres' });
  assert.equal(r.rc, 2);
  assert.ok(r.out.some((l) => l.includes(PREFLIGHT_CODES.TARGET_INVALID)));
  assert.ok(!r.calls.includes('reserve'));
});

// ---------------------------------------------------------------------------
// 3-5. READ ONLY ordering, transaction-local bounds, and cleanup
// ---------------------------------------------------------------------------

test('C2B-M005-P0: READ ONLY begins before EVERY diagnostic query', async () => {
  const r = await drive(goodEnv(), { aclRows: [row()] });
  assert.equal(r.rc, 0, r.out.join(' | '));
  const beginAt = r.calls.indexOf('begin');
  assert.ok(beginAt >= 0 && r.calls.includes('query'), r.calls.join(','));
  // EVERY query, not merely the first: an `indexOf` check would keep passing if a future edit added
  // a second query call site above the bracket.
  assert.ok(
    r.calls.every((c, i) => c !== 'query' || i > beginAt),
    `every query must follow begin: ${r.calls.join(',')}`,
  );
  assert.ok(r.calls.indexOf('reserve') < beginAt);
  assert.ok(beginAt < r.calls.indexOf('applyLocalTimeouts'));
});

test('C2B-M005-P0: the transaction-local bound is applied with the fixed value', async () => {
  const r = await drive(goodEnv(), { aclRows: [row()] });
  assert.ok(r.calls.includes(`timeout:${String(TX_TIMEOUT_MS)}`), r.calls.join(','));
});

test('C2B-M005-P0: read-only state is verified before and again after the diagnostic queries', async () => {
  const r = await drive(goodEnv(), { aclRows: [row()] });
  assert.equal(r.calls.filter((c) => c === 'isReadOnly').length, 2, r.calls.join(','));
  assert.ok(r.calls.indexOf('isReadOnly') < r.calls.indexOf('query'));
  assert.ok(r.calls.lastIndexOf('isReadOnly') > r.calls.lastIndexOf('query'));
});

test('C2B-M005-P0: a bracket that is not read only refuses without reading anything', async () => {
  const r = await drive(goodEnv(), { readOnly: [false] });
  assert.equal(r.rc, 2);
  assert.ok(r.out.some((l) => l.includes(PREFLIGHT_CODES.READ_ONLY_NOT_ESTABLISHED)));
  assert.ok(!r.calls.includes('query'), 'no diagnostic query may run outside a proven read-only bracket');
});

test('C2B-M005-P0: read-only state lost mid-run is a refusal, not a downgraded result', async () => {
  const r = await drive(goodEnv(), { readOnly: [true, false], aclRows: [row()] });
  assert.equal(r.rc, 2);
  assert.ok(r.out.some((l) => l.includes(PREFLIGHT_CODES.READ_ONLY_LOST)));
});

test('C2B-M005-P0: the bracket is closed and the client disposed on success AND on failure', async () => {
  const ok = await drive(goodEnv(), { aclRows: [row()] });
  assert.ok(ok.calls.includes('finish'));
  assert.ok(ok.calls.lastIndexOf('dispose') > ok.calls.lastIndexOf('finish'));

  const bad = await drive(goodEnv(), { aclRows: [row()], failAt: 'query' });
  assert.equal(bad.rc, 2);
  assert.ok(bad.calls.includes('finish'), 'the bracket must still be closed on failure');
  assert.ok(bad.calls.includes('dispose'), 'the client must still be disposed on failure');
  assert.ok(bad.out.some((l) => l.includes(PREFLIGHT_CODES.PORT_FAILED)));
});

test('C2B-M005-P0: a failed teardown is reported, never described as a graceful close', async () => {
  const r = await drive(goodEnv(), { aclRows: [row()], teardown: false });
  assert.ok(r.out.some((l) => l.includes(PREFLIGHT_CODES.TEARDOWN_FAILED)));
  assert.ok(r.out.some((l) => l.includes('gracefulSocketClose=not_observed')));
});

test('C2B-M005-P0: a failure produces no retry and no second connection', async () => {
  const r = await drive(goodEnv(), { failAt: 'begin' });
  assert.equal(r.rc, 2);
  assert.equal(r.created, 1, 'exactly one executor is ever constructed');
  assert.equal(r.calls.filter((c) => c === 'reserve').length, 1);
  assert.equal(r.calls.filter((c) => c === 'begin').length, 1);
});

// ---------------------------------------------------------------------------
// 6. no write, ledger or migration path is reachable
// ---------------------------------------------------------------------------

test('C2B-M005-P0: no write port, ledger call or owner-ACL surface is ever invoked', async () => {
  const r = await drive(goodEnv(), { aclRows: [row()] });
  assert.ok(!r.calls.some((c) => c.startsWith('FORBIDDEN:')), r.calls.join(','));
});

test('C2B-M005-P0: the fixed call path contains no write operation, including to temporary objects', () => {
  const src = readFileSync(join(REPO_ROOT, 'scripts/managed-default-acl-preflight.ts'), 'utf8');
  const code = src.split('\n')
    .filter((l) => {
      const t = l.trimStart();
      return !t.startsWith('*') && !t.startsWith('//') && !t.startsWith('/*');
    })
    .join('\n')
    .toLowerCase();
  for (const w of ['insert ', 'update ', 'delete ', 'truncate', 'create table', 'drop ', 'alter ', 'grant ', 'revoke ', 'copy ', 'commit']) {
    assert.ok(!code.includes(w), `the diagnostic must contain no ${w.trim()} operation`);
  }
});

// ---------------------------------------------------------------------------
// 7-8. the default-ACL question: A and B are separate conclusions
// ---------------------------------------------------------------------------

const assess = (rows, over = {}) =>
  assessDefaultAclPosture(PRINCIPAL, PRINCIPAL, { rows, overflowed: false, ...over });

test('C2B-M005-B1: an absent global functions row still fails A, and the CORRECTED 005 removes it', () => {
  // A is unchanged: the built-in PUBLIC EXECUTE is retained right now, so the postcondition is not
  // met. B FLIPPED with the migration — the corrected 005 issues a GLOBAL functions revoke, which
  // substitutes for `acldefault()` and displaces exactly this blocker. Under the previous
  // schema-only migration this same evidence was B=YES, and that is the whole point of the change.
  const a = assess([]);
  assert.equal(a.globalBase.functions, 'BUILTIN_RETAINED');
  assert.equal(a.postcondition, 'UNMET');
  assert.equal(a.blockerSurvivesCurrentM005, 'NO');
});

test('C2B-M005-B1: a GLOBAL grant on a class 005 does not globally revoke survives', () => {
  // TABLES and SEQUENCES get no global statement, deliberately: an unexpected global grant on them
  // is evidence something outside 005 widened the defaults, and it must stay a fail-closed blocker
  // rather than be silently repaired.
  for (const objtype of ['r', 'S']) {
    const a = assess([
      row({ objtype: 'f', scope: '' }),
      row({ objtype, scope: '', grantee: 'anon', privilege: 'SELECT' }),
    ]);
    assert.equal(a.postcondition, 'UNMET', objtype);
    assert.equal(a.blockerSurvivesCurrentM005, 'YES', `${objtype}: no global statement can remove it`);
  }
});

test('C2B-M005-P0: a valid explicitly empty global ACL is a global override and meets the postcondition', () => {
  const a = assess([row({ scope: '' })]);
  assert.equal(a.globalBase.functions, 'GLOBAL_OVERRIDE');
  assert.equal(a.postcondition, 'MET');
  assert.equal(a.blockerSurvivesCurrentM005, 'NO');
  assert.equal(a.schemaGrantsToCoveredGrantees, 'NONE');
});

test('C2B-M005-P0: a schema-only forbidden grant establishes A but NOT B', () => {
  // 005 is written to revoke exactly this. It fails the current postcondition and is removable, so
  // it must never by itself say a blocker would survive the migration.
  const a = assess([row({ scope: '' }), row({ scope: 'public', grantee: 'anon', privilege: 'EXECUTE' })]);
  assert.equal(a.postcondition, 'UNMET', 'A holds');
  assert.equal(a.schemaGrantsToCoveredGrantees, 'PRESENT');
  assert.equal(a.blockerSurvivesCurrentM005, 'NO', 'B must NOT be established by a removable schema grant');
});

test('C2B-M005-B1: a forbidden GLOBAL grant on a globally-revoked class does NOT survive', () => {
  // FUNCTIONS is the one class the corrected 005 revokes globally, so a covered global grant on it
  // is removable by the migration and must not be reported as surviving. A still fails.
  const a = assess([row({ objtype: 'f', scope: '', grantee: 'public', privilege: 'EXECUTE' })]);
  assert.equal(a.postcondition, 'UNMET');
  assert.equal(a.blockerSurvivesCurrentM005, 'NO', 'the global FUNCTIONS statement removes it');
});

test('C2B-M005-P0: the mirror used for the global base agrees with the accepted classifier', () => {
  const cases = [
    [], [row({ scope: '' })], [row({ scope: 'public' })],
    [row({ scope: '', grantee: 'reporting_svc', privilege: 'EXECUTE' })],
    [row({ scope: 'public', grantee: 'public', privilege: 'EXECUTE' }), row({ scope: '' })],
    [row({ objtype: 'r', scope: '' })],
  ];
  for (const rows of cases) {
    const findings = classifyDefaultPrivileges(PRINCIPAL, rows);
    const retained = findings.some((f) => /retain PostgreSQL's built-in grant to PUBLIC/.test(f));
    const a = assess(rows);
    assert.equal(a.globalBase.functions, retained ? 'BUILTIN_RETAINED' : 'GLOBAL_OVERRIDE', JSON.stringify(rows));
  }
});

test('C2B-M005-P0: TYPES and SCHEMAS stay outside the contract', () => {
  const a = assess([row({ scope: '' }), row({ scope: '', objtype: 'T', grantee: 'public', privilege: 'USAGE' })]);
  assert.deepEqual(Object.keys(a.globalBase).sort(), ['functions', 'sequences', 'tables']);
});

// ---------------------------------------------------------------------------
// 9. malformed evidence and overflow refuse
// ---------------------------------------------------------------------------

test('C2B-M005-P0: a malformed applicable row makes every category UNREADABLE', () => {
  const a = assess([row({ scope: '', grantee: 7, privilege: false })]);
  assert.equal(a.postcondition, 'UNREADABLE');
  assert.equal(a.blockerSurvivesCurrentM005, 'UNREADABLE');
  assert.equal(a.globalBase.functions, 'UNREADABLE');
});

test('C2B-M005-P0: overflow is unreadable and never a verdict computed from truncated rows', async () => {
  const a = assessDefaultAclPosture(PRINCIPAL, PRINCIPAL, { rows: [], overflowed: true });
  assert.equal(a.postcondition, 'UNREADABLE');
  assert.equal(a.blockerSurvivesCurrentM005, 'UNREADABLE');
  assert.equal(a.findingCount, 0);

  const port = { query: async () => Array.from({ length: 5 }, () => row()) };
  const read = await readDefaultAclRowsBounded(port, 3);
  assert.equal(read.overflowed, true);
  assert.deepEqual(read.rows, [], 'a truncated page must not reach the classifier');
});

/**
 * Capture the pg_default_acl statement the PRODUCTION diagnostic path actually sends.
 *
 * No `readAcl` dependency is injected, so `runDiagnostic` uses its own binding to
 * `readDefaultAclRowsBounded`; the text recorded here is therefore the statement the real path
 * emits, not one a fixture composed. A fake that filtered rows itself would prove nothing about the
 * SQL, which is exactly what this avoids.
 */
async function productionAclSql(aclRows = []) {
  const { handle } = fakeHandle({ aclRows });
  const seen = [];
  const wrapped = {
    ...handle,
    catalog: { query: async (t, p) => { seen.push(t); return await handle.catalog.query(t, p); } },
  };
  const out = [];
  await runDiagnostic(goodEnv(), (l) => out.push(l), {
    assertDsn: () => ({}),
    describeDsn: () => ({ endpointFamily: 'session', database: EXPECTED_DATABASE }),
    createExecutor: async () => wrapped,
    fingerprint: async () => [],
    // deliberately NO readAcl override
  });
  const sql = seen.find((t) => t.includes('pg_default_acl'));
  assert.ok(sql !== undefined, `the production path issued no default-ACL statement: ${seen.join(' | ')}`);
  return sql;
}

test('C2B-M005-P0-R1: the diagnostic SQL restricts the object class, and does so BEFORE the limit', async () => {
  const sql = await productionAclSql([row({ scope: '' })]);
  const predicate = sql.indexOf("d.defaclobjtype in ('r', 'S', 'f')");
  assert.ok(predicate >= 0, `the object-class predicate is absent: ${sql}`);
  // BEFORE LIMIT: a predicate applied after the bound would let uncovered-class rows consume the
  // row budget and drive the diagnostic into a false overflow.
  const limitAt = sql.indexOf('limit $2');
  assert.ok(limitAt > predicate, `the object-class predicate must precede the limit: ${sql}`);
  // COMBINED with the executing-principal and namespace predicates, not replacing either.
  assert.match(sql, /rolname = current_user/);
  assert.match(sql, /nspname = \$1/);
  assert.match(sql, /d\.defaclnamespace = 0/);
  assert.match(sql, /and\s+d\.defaclobjtype in \('r', 'S', 'f'\)/);
  // And the LEFT JOIN LATERAL that makes an empty ACL visible is still there.
  assert.match(sql, /left join lateral pg_catalog\.aclexplode\(d\.defaclacl\) a on true/);
});

test('C2B-M005-P0-R1: the SQL class list is exactly the covered classes and excludes the uncovered ones', async () => {
  const sql = await productionAclSql();
  const list = sql.match(/d\.defaclobjtype in \(([^)]*)\)/);
  assert.ok(list !== null, sql);
  const inSql = list[1].split(',').map((s) => s.trim().replace(/^'|'$/g, '')).sort();
  assert.deepEqual(inSql, [...M005_DEFAULT_ACL_CLASSES].map((c) => c.objtype).sort(),
    'the SQL literal must not drift from the migration-derived class set');
  for (const u of M005_UNCOVERED_DEFAULT_ACL_CLASSES) {
    assert.ok(!inSql.includes(u.objtype), `uncovered class ${u.objtype} must not be selected`);
  }
});

test('C2B-M005-P0-R1: a valid global and a valid schema row for EVERY covered class remains eligible', async () => {
  // The predicate must narrow the class set, never the scope set: for each covered class, both an
  // applicable global row and an applicable public-schema row must still reach the classifier.
  const sql = await productionAclSql();
  for (const cls of M005_DEFAULT_ACL_CLASSES) {
    assert.ok(sql.includes(`'${cls.objtype}'`), `class ${cls.objtype} is not selectable: ${sql}`);
    for (const scope of ['', 'public']) {
      const read = { rows: [row({ objtype: cls.objtype, scope })], overflowed: false };
      const a = assessDefaultAclPosture(PRINCIPAL, PRINCIPAL, read);
      assert.equal(a.globalBase[cls.label], scope === '' ? 'GLOBAL_OVERRIDE' : 'BUILTIN_RETAINED',
        `${cls.label} in scope '${scope}'`);
    }
  }
});

test('C2B-M005-P0: the bounded read requests limit+1 and names the cap explicitly', async () => {
  const seen = [];
  const port = { query: async (t, p) => { seen.push({ t, p }); return []; } };
  await readDefaultAclRowsBounded(port, DEFAULT_ACL_ROW_LIMIT);
  assert.match(seen[0].t, /limit \$2/);
  assert.deepEqual(seen[0].p, ['public', DEFAULT_ACL_ROW_LIMIT + 1]);
  assert.equal(Number.isSafeInteger(DEFAULT_ACL_ROW_LIMIT) && DEFAULT_ACL_ROW_LIMIT > 0, true);
});

test('C2B-M005-P0: unreadable evidence refuses at the child rather than reporting a verdict', async () => {
  const r = await drive(goodEnv(), { readAcl: async () => ({ rows: [], overflowed: true }) });
  assert.equal(r.rc, 2);
  assert.ok(r.out.some((l) => l.includes(PREFLIGHT_CODES.EVIDENCE_UNREADABLE)));
  assert.ok(r.out.some((l) => l.includes('overflowed=true')));
});

// ---------------------------------------------------------------------------
// 10-11. output containment and the authorization boundary
// ---------------------------------------------------------------------------

test('C2B-M005-P0: raw catalog metadata never enters operator output', async () => {
  const r = await drive(goodEnv(), {
    aclRows: [row({ scope: '' }), row({ scope: 'public', grantee: 'anon', privilege: 'EXECUTE' })],
  });
  const text = r.out.join('\n');
  for (const leak of ['anon', 'EXECUTE', 'tmpos_migrator', 'pg_default_acl', 'defaclrole']) {
    assert.ok(!text.includes(leak), `operator output leaked ${leak}: ${text}`);
  }
  assert.ok(text.includes('A.currentDefaultAclPostcondition='));
  assert.ok(text.includes('B.blockerSurvivesCurrentM005='));
});

test('C2B-M005-P0: synthetic secret material never enters operator output', async () => {
  const r = await drive(goodEnv(), { aclRows: [row({ scope: '' })] });
  const text = r.out.join('\n');
  for (const leak of ['SYNTHETICPASSWORD', 'synthref0000000', 'BEGIN CERTIFICATE']) {
    assert.ok(!text.includes(leak), `operator output leaked ${leak}`);
  }
});

test('C2B-M005-P0: an application fingerprint mismatch reports only MATCH/MISMATCH', async () => {
  const r = await drive(goodEnv(), { fingerprintFailures: ['expected durable audit action absent: bcp.secret.action'] });
  assert.equal(r.rc, 2);
  assert.ok(r.out.some((l) => l.includes('applicationFingerprint=MISMATCH')));
  assert.ok(!r.out.some((l) => l.includes('bcp.secret.action')), 'no application identifier may be emitted');
});

test('C2B-M005-P0: diagnostic completion is stated as DISTINCT from migration readiness', async () => {
  const r = await drive(goodEnv(), { aclRows: [row({ scope: '' })] });
  assert.equal(r.rc, 0);
  assert.equal(r.out.filter((l) => l.includes('diagnosticCompletion=DISTINCT_FROM_MIGRATION_READINESS')).length, 1);
});

/**
 * Drive the launcher far enough to observe the argv it ACTUALLY builds.
 *
 * The containment primitives are stubbed only where they would touch the host (`/proc`, a real
 * process group); everything the fixed-command contract depends on — the action check, the
 * environment seal, the argv construction and its assertion — runs for real. `spawn` records what
 * it was asked to start and then fails, so no child ever exists.
 */
async function launcherSpawnAttempt(argv, env = goodEnv()) {
  const lines = [];
  let captured = null;
  const rc = await launcherMain(argv, env, {
    out: (l) => lines.push(l),
    err: (l) => lines.push(l),
    assertContainment: () => {},
    // The accepted primitive expects a Set-like exec environment; an object has no `has`.
    readExecEnv: () => new Set(),
    spawn: (command, args, options) => {
      captured = { command, args: [...args], env: Object.keys((options ?? {}).env ?? {}) };
      throw new Error('no child');
    },
    selfIdentity: () => ({ pid: 1, pgid: 1, sid: 1 }),
    scan: () => ({ observed: true, members: [] }),
    cleanupGraceMs: 1,
    groupPollMs: 1,
  });
  return { rc, lines, captured };
}

test('C2B-M005-P0: the launcher spawns EXACTLY the fixed two-element command', async () => {
  const r = await launcherSpawnAttempt([PARENT_FLAG]);
  assert.notEqual(r.captured, null, `spawn was never reached: ${r.lines.join(' | ')}`);
  assert.equal(r.captured.args.length, 2, JSON.stringify(r.captured.args));
  assert.equal(r.captured.args[1], PREFLIGHT_SCRIPT);
  assert.match(r.captured.args[0], /node_modules\/tsx\/dist\/cli\.mjs$/);
  // And nothing in the built argv names the migration CLI or any migration flag.
  for (const a of r.captured.args) {
    for (const t of FORBIDDEN_CHILD_TOKENS) {
      assert.ok(!a.includes(t), `built argv carried forbidden token ${t}: ${a}`);
    }
  }
});

test('C2B-M005-P0: the launcher refuses a non-fixed action before it builds or spawns anything', async () => {
  for (const argv of [[], ['--execute'], ['--execute-m005'], ['--status'], [PARENT_FLAG, '--apply'], ['--apply']]) {
    const r = await launcherSpawnAttempt(argv);
    assert.equal(r.rc, 2, JSON.stringify(argv));
    assert.equal(r.captured, null, `a non-fixed action reached spawn: ${JSON.stringify(argv)}`);
    assert.ok(r.lines.some((l) => l.includes(PREFLIGHT_LAUNCHER_CODES.BAD_INVOCATION)), JSON.stringify(argv));
  }
});

test('C2B-M005-P0: the launcher record carries no synthetic secret material', async () => {
  const r = await launcherSpawnAttempt([PARENT_FLAG]);
  const text = r.lines.join('\n');
  for (const leak of ['SYNTHETICPASSWORD', 'synthref0000000', 'BEGIN CERTIFICATE']) {
    assert.ok(!text.includes(leak), `launcher record leaked ${leak}`);
  }
  assert.ok(text.includes('this diagnostic authorizes no migration and no live write'));
});

test('C2B-M005-P0: the child refuses any argument at all', async () => {
  const out = [];
  assert.equal(await childMain(['--anything'], goodEnv(), (l) => out.push(l)), 2);
  assert.ok(out.some((l) => l.includes(PREFLIGHT_CODES.ARGV_REJECTED)));
  assert.equal(out.length, 1, 'a rejected argv performs nothing else');
});

test('C2B-M005-P0: the confirmed target and database are the literals the contract names', () => {
  assert.equal(EXPECTED_DEV_TARGET, 'tmpos2026-dev');
  assert.equal(EXPECTED_DATABASE, 'postgres');
});

test('C2B-M005-P0: the spawned command and child environment are the sealed ones', async () => {
  const r = await launcherSpawnAttempt([PARENT_FLAG]);
  assert.notEqual(r.captured, null);
  // The runtime is the CURRENT executable, resolved absolutely — never a PATH lookup.
  assert.equal(r.captured.command, process.execPath);
  // And the child environment is the sealed EXACT set, not the parent's environment.
  assert.deepEqual([...r.captured.env].sort(), [...CHILD_ENV_KEYS].sort());
  for (const k of STARTUP_SENSITIVE) assert.ok(!r.captured.env.includes(k), `startup-sensitive ${k} reached the child`);
});

test('C2B-M005-P0: an overflowed capture prints no part of the transcript', () => {
  const overflowed = renderPreflightReport({
    spawned: true, status: 'exited', exitCode: 0, signal: null,
    group: { observed: true, members: [] }, observationLost: false,
    capture: { overflowed: true, byteLength: 999999, text: () => 'SYNTHETICPASSWORD leaked' },
  });
  const text = overflowed.join('\n');
  assert.ok(text.includes('output_limit_exceeded') || text.includes('OUTPUT_LIMIT'), text);
  assert.ok(!text.includes('SYNTHETICPASSWORD'));
  assert.ok(!text.includes('999999'), 'a secret-derived length must not be reported');
  assert.ok(!overflowed.includes(CHILD_BLOCK_SENTINEL), 'no transcript block on overflow');

  // A non-overflowed capture DOES place the transcript behind the sentinel, so the sink can redact
  // it as one block rather than the report printing it directly.
  const clean = renderPreflightReport({
    spawned: true, status: 'exited', exitCode: 0, signal: null,
    group: { observed: true, members: [] }, observationLost: false,
    capture: { overflowed: false, text: () => 'child said something' },
  });
  assert.ok(clean.includes(CHILD_BLOCK_SENTINEL));
});

test('C2B-M005-P0: anything that is not exactly false on the overflow flag is treated as overflow', () => {
  for (const flag of [true, undefined, null, 0, 'false']) {
    const lines = renderPreflightReport({
      spawned: true, status: 'exited', exitCode: 0, signal: null,
      capture: { overflowed: flag, text: () => 'SYNTHETICPASSWORD' },
    });
    assert.ok(!lines.includes(CHILD_BLOCK_SENTINEL), `flag ${String(flag)} must be treated as overflow`);
    assert.ok(!lines.join('\n').includes('SYNTHETICPASSWORD'));
  }
});

test('C2B-M005-P0: every statement the diagnostic sends is a read, asserted on the SQL itself', async () => {
  // Behavioural, not a source grep: the text of every statement that actually reaches the catalog
  // port is captured and checked. A write verb built at run time would still be caught here.
  const seen = [];
  const { handle } = fakeHandle({ aclRows: [row({ scope: '' })] });
  const wrapped = { ...handle, catalog: { query: async (t, p) => { seen.push(t); return await handle.catalog.query(t, p); } } };
  const out = [];
  await runDiagnostic(goodEnv(), (l) => out.push(l), {
    assertDsn: () => ({}),
    describeDsn: () => ({ endpointFamily: 'session', database: EXPECTED_DATABASE }),
    createExecutor: async () => wrapped,
    fingerprint: async () => [],
  });
  assert.ok(seen.length > 0, 'the diagnostic must issue at least one statement');
  // WORD BOUNDARIES, not substrings: the catalog projection legitimately names `grantee` and
  // `defaclacl`, and a substring test would read those as write verbs and pass for the wrong reason.
  const WRITE_VERB = /\b(insert|update|delete|truncate|create|drop|alter|grant|revoke|copy|commit|do)\b/;
  for (const sql of seen) {
    const s = sql.toLowerCase();
    assert.ok(/^\s*(select|show)\b/.test(s), `a diagnostic statement is not a read: ${sql}`);
    assert.ok(!WRITE_VERB.test(s), `a diagnostic statement contained a write verb: ${sql}`);
  }
});

// ---------------------------------------------------------------------------
// P0-R3 — fail-closed identity and the cleanup state machine
// ---------------------------------------------------------------------------

/** The single `outcome=` line, or a marker naming how many there actually were. */
const outcomeOf = (out) => {
  const P = '[acl-preflight] outcome=';
  const lines = out.filter((l) => l.startsWith(P));
  return lines.length === 1 ? lines[0].slice(P.length) : `OUTCOME_LINE_COUNT:${lines.length}`;
};

/** Lines that assert a verdict. None of these may exist on a refusal path. */
const verdictLines = (out) => out.filter((l) =>
  l.includes('A.currentDefaultAclPostcondition')
  || l.includes('B.blockerSurvivesCurrentM005')
  || l.includes('globalBase.')
  || l.includes('schemaGrantsToCoveredGrantees'));

/** Drive the child while counting the two ports a refusal must never reach. */
async function driveCounting(env, opts = {}) {
  const { handle, calls } = fakeHandle(opts);
  const out = [];
  let fingerprintCalls = 0;
  let aclCalls = 0;
  let created = 0;
  const rc = await runDiagnostic(env, (l) => out.push(l), {
    assertDsn: () => ({}),
    describeDsn: () => ({ endpointFamily: 'session', database: opts.database ?? EXPECTED_DATABASE }),
    createExecutor: async () => { created += 1; calls.push('createExecutor'); return handle; },
    fingerprint: async () => { fingerprintCalls += 1; return []; },
    readAcl: async () => { aclCalls += 1; return { rows: opts.aclRows ?? [], overflowed: false }; },
  });
  return { rc, out, calls, created, fingerprintCalls, aclCalls };
}

test('P0-R3 RED-1: a principal mismatch stops before the fingerprint and the ACL read', async () => {
  const r = await driveCounting(goodEnv(), {
    identity: { session_principal: 'a_different_role' },
    aclRows: [row({ scope: '' })],
  });
  assert.equal(r.rc, 2, 'a mismatch must be a nonzero result');
  assert.ok(r.out.some((l) => l.includes('currentMatchesSession=false')), 'the boolean must be recorded');
  assert.ok(r.out.some((l) => l.includes(PREFLIGHT_CODES.IDENTITY_UNCONFIRMED)), 'a bounded identity code');
  assert.equal(r.fingerprintCalls, 0, 'the fingerprint must not run under a principal mismatch');
  assert.equal(r.aclCalls, 0, 'default ACLs must not be inspected under a principal mismatch');
  assert.deepEqual(verdictLines(r.out), [], 'no verdict-shaped line may be emitted');
  // No role NAME may appear anywhere in the record.
  assert.ok(!r.out.some((l) => l.includes('a_different_role') || l.includes(PRINCIPAL)));
  // Cleanup still happens, exactly once each, and there is no retry.
  assert.equal(r.calls.filter((c) => c === 'finish').length, 1, 'exactly one rollback attempt');
  assert.equal(r.calls.filter((c) => c === 'dispose').length, 1, 'exactly one disposal request');
  assert.equal(r.created, 1);
  assert.equal(r.calls.filter((c) => c === 'reserve').length, 1);
  assert.equal(outcomeOf(r.out), PREFLIGHT_CODES.IDENTITY_UNCONFIRMED);
});

test('P0-R3 RED-2: an incomplete disposal fails the result and forbids outcome=ok', async () => {
  const r = await drive(goodEnv(), { aclRows: [row({ scope: '' })], teardown: false });
  assert.equal(r.rc, 2, 'a favourable verdict must not survive an incomplete disposal');
  assert.notEqual(outcomeOf(r.out), PREFLIGHT_CODES.POSTURE_MET);
  assert.equal(outcomeOf(r.out), PREFLIGHT_CODES.TEARDOWN_FAILED);
  assert.ok(r.out.some((l) => l.includes(PREFLIGHT_CODES.TEARDOWN_FAILED)));
});

test('P0-R3 RED-3: a failed rollback is bounded evidence and fails the result', async () => {
  const r = await drive(goodEnv(), { aclRows: [row({ scope: '' })], failAt: 'finish' });
  assert.equal(r.rc, 2, 'a failed rollback must fail the result');
  assert.ok(r.out.some((l) => l.includes(PREFLIGHT_CODES.ROLLBACK_FAILED)), 'a bounded rollback code');
  assert.ok(r.out.some((l) => l.includes('cleanup rollback=failed')));
  assert.equal(r.calls.filter((c) => c === 'dispose').length, 1, 'disposal still runs after a failed rollback');
  // EXACT, not merely "not OK": `outcomeOf` returns a marker when the line is missing, so a bare
  // notEqual would also be satisfied by the outcome line disappearing entirely.
  assert.equal(outcomeOf(r.out), PREFLIGHT_CODES.ROLLBACK_FAILED);
  assert.ok(!r.out.some((l) => l.includes('injected failure')), 'no raw thrown value may be printed');
});

test('P0-R3 RED-4: a pure principal mismatch can never yield A=MET or B=NO', () => {
  // Otherwise-favourable evidence: a valid empty GLOBAL row for every covered class.
  const favourable = M005_DEFAULT_ACL_CLASSES.map((c) => row({ objtype: c.objtype, scope: '' }));
  const a = assessDefaultAclPosture(PRINCIPAL, 'a_different_role', { rows: favourable, overflowed: false });
  assert.equal(a.principalAgreement, 'MISMATCH');
  assert.equal(a.postcondition, 'UNREADABLE');
  assert.equal(a.blockerSurvivesCurrentM005, 'UNREADABLE');
  assert.equal(a.schemaGrantsToCoveredGrantees, 'UNREADABLE');
  for (const c of M005_DEFAULT_ACL_CLASSES) assert.equal(a.globalBase[c.label], 'UNREADABLE');
});

test('P0-R3: pure assessment table — agreement gates every derived category', () => {
  const favourable = M005_DEFAULT_ACL_CLASSES.map((c) => row({ objtype: c.objtype, scope: '' }));
  const schemaOnlyGrant = [
    ...M005_DEFAULT_ACL_CLASSES.map((c) => row({ objtype: c.objtype, scope: '' })),
    row({ objtype: 'r', scope: 'public', grantee: 'public', privilege: 'SELECT' }),
  ];
  const noGlobalFunctions = [row({ objtype: 'r', scope: '' }), row({ objtype: 'S', scope: '' })];

  const cases = [
    // [label, principal, sessionUser, rows, agreement, postcondition, blocker]
    ['equal readable principals, favourable', PRINCIPAL, PRINCIPAL, favourable, 'AGREED', 'MET', 'NO'],
    ['unequal readable principals', PRINCIPAL, 'other', favourable, 'MISMATCH', 'UNREADABLE', 'UNREADABLE'],
    ['missing current principal', undefined, PRINCIPAL, favourable, 'UNREADABLE', 'UNREADABLE', 'UNREADABLE'],
    ['missing session principal', PRINCIPAL, undefined, favourable, 'UNREADABLE', 'UNREADABLE', 'UNREADABLE'],
    ['empty current principal', '', PRINCIPAL, favourable, 'UNREADABLE', 'UNREADABLE', 'UNREADABLE'],
    ['empty session principal', PRINCIPAL, '', favourable, 'UNREADABLE', 'UNREADABLE', 'UNREADABLE'],
    ['non-string current principal', 7, PRINCIPAL, favourable, 'UNREADABLE', 'UNREADABLE', 'UNREADABLE'],
    ['non-string session principal', PRINCIPAL, { a: 1 }, favourable, 'UNREADABLE', 'UNREADABLE', 'UNREADABLE'],
    ['clean favourable ACL + mismatch', PRINCIPAL, 'other', favourable, 'MISMATCH', 'UNREADABLE', 'UNREADABLE'],
    ['schema-only grant + mismatch', PRINCIPAL, 'other', schemaOnlyGrant, 'MISMATCH', 'UNREADABLE', 'UNREADABLE'],
    ['absent global functions + mismatch', PRINCIPAL, 'other', noGlobalFunctions, 'MISMATCH', 'UNREADABLE', 'UNREADABLE'],
    // The agreed comparators, so the table proves the gate and not merely a constant.
    ['schema-only grant, agreed', PRINCIPAL, PRINCIPAL, schemaOnlyGrant, 'AGREED', 'UNMET', 'NO'],
    // B is NO because the CORRECTED migration revokes functions globally; A still fails.
    ['absent global functions, agreed', PRINCIPAL, PRINCIPAL, noGlobalFunctions, 'AGREED', 'UNMET', 'NO'],
    ['global table grant, agreed', PRINCIPAL, PRINCIPAL,
      [...favourable, row({ objtype: 'r', scope: '', grantee: 'anon', privilege: 'SELECT' })],
      'AGREED', 'UNMET', 'YES'],
  ];

  for (const [label, principal, sessionUser, rows, agreement, postcondition, blocker] of cases) {
    const a = assessDefaultAclPosture(principal, sessionUser, { rows, overflowed: false });
    assert.equal(a.principalAgreement, agreement, `${label}: principalAgreement`);
    assert.equal(a.postcondition, postcondition, `${label}: postcondition`);
    assert.equal(a.blockerSurvivesCurrentM005, blocker, `${label}: blocker`);
    if (agreement !== 'AGREED') {
      assert.notEqual(a.postcondition, 'MET', `${label}: a mismatch must never be MET`);
      assert.notEqual(a.blockerSurvivesCurrentM005, 'NO', `${label}: a mismatch must never be NO`);
    }
  }
});

/** A disposal result whose completion accessors THROW when read. Malformed evidence, not an error. */
function throwingTeardown() {
  return Object.defineProperties({}, {
    requested: { get() { throw new Error('injected accessor failure'); }, enumerable: true },
    completed: { get() { throw new Error('injected accessor failure'); }, enumerable: true },
    gracefulSocketClose: { get() { throw new Error('injected accessor failure'); }, enumerable: true },
  });
}

test('P0-R3: cleanup outcome matrix A-N', async () => {
  const good = [row({ scope: '' })];
  const OK_TD = { requested: true, completed: true, gracefulSocketClose: 'not_observed' };
  // Every expectation is written out per case rather than derived from the fixture: a derived
  // expectation would recompute the same rule the source uses and could agree with it while both
  // were wrong.
  // [label, opts, rc, outcome, finishCalls, disposeCalls, rollbackFact, disposalRequested, disposalCompleted]
  const cases = [
    ['A favourable + rollback ok + disposal ok', { aclRows: good }, 0, PREFLIGHT_CODES.POSTURE_MET, 1, 1, 'completed', true, true],
    ['B favourable + rollback fails + disposal ok', { aclRows: good, failAt: 'finish' }, 2, PREFLIGHT_CODES.ROLLBACK_FAILED, 1, 1, 'failed', true, true],
    ['C favourable + disposal completed=false', { aclRows: good, teardown: { ...OK_TD, completed: false } }, 2, PREFLIGHT_CODES.TEARDOWN_FAILED, 1, 1, 'completed', true, false],
    ['D disposal requested=false completed=true', { aclRows: good, teardown: { ...OK_TD, requested: false } }, 2, PREFLIGHT_CODES.TEARDOWN_FAILED, 1, 1, 'completed', false, true],
    ['E disposal evidence missing', { aclRows: good, teardown: { gracefulSocketClose: 'not_observed' } }, 2, PREFLIGHT_CODES.TEARDOWN_FAILED, 1, 1, 'completed', false, false],
    ['E2 disposal evidence malformed', { aclRows: good, teardown: 'not-an-object' }, 2, PREFLIGHT_CODES.TEARDOWN_FAILED, 1, 1, 'completed', false, false],
    ['F disposal rejects', { aclRows: good, failAt: 'dispose' }, 2, PREFLIGHT_CODES.TEARDOWN_FAILED, 1, 1, 'completed', false, false],
    ['G rollback and disposal both fail', { aclRows: good, failAt: 'finish', teardown: { ...OK_TD, completed: false } }, 2, PREFLIGHT_CODES.ROLLBACK_FAILED, 1, 1, 'failed', true, false],
    ['H primary refusal + cleanup ok', { aclRows: good, readOnly: [true, false] }, 2, PREFLIGHT_CODES.READ_ONLY_LOST, 1, 1, 'completed', true, true],
    ['I primary refusal + cleanup failure', { aclRows: good, readOnly: [true, false], teardown: { ...OK_TD, completed: false } }, 2, PREFLIGHT_CODES.TEARDOWN_FAILED, 1, 1, 'completed', true, false],
    ['J BEGIN failure', { failAt: 'begin' }, 2, PREFLIGHT_CODES.PORT_FAILED, 0, 1, 'not_required', true, true],
    ['K pre-handle validation failure', { database: 'not_postgres' }, 2, PREFLIGHT_CODES.TARGET_INVALID, 0, 0, null, null, null],
    ['L principal mismatch', { aclRows: good, identity: { session_principal: 'other_role' } }, 2, PREFLIGHT_CODES.IDENTITY_UNCONFIRMED, 1, 1, 'completed', true, true],
    ['M completion values other than literal true', { aclRows: good, teardown: { requested: 'true', completed: 'true', gracefulSocketClose: 'not_observed' } }, 2, PREFLIGHT_CODES.TEARDOWN_FAILED, 1, 1, 'completed', false, false],
    ['N a port whose completion accessors throw', { aclRows: good, teardown: throwingTeardown() }, 2, PREFLIGHT_CODES.TEARDOWN_FAILED, 1, 1, 'completed', false, false],
  ];

  for (const [label, opts, rc, outcome, finishCalls, disposeCalls, rollbackFact, dispReq, dispDone] of cases) {
    const r = await drive(goodEnv(), opts);
    assert.equal(r.rc, rc, `${label}: returned number`);
    assert.equal(outcomeOf(r.out), outcome, `${label}: final outcome code`);
    assert.equal(r.calls.filter((c) => c === 'finish').length, finishCalls, `${label}: rollback attempts`);
    assert.equal(r.calls.filter((c) => c === 'dispose').length, disposeCalls, `${label}: disposal attempts`);
    if (rc !== 0) {
      assert.notEqual(outcomeOf(r.out), PREFLIGHT_CODES.POSTURE_MET, `${label}: a failure may never end in the OK code`);
    }
    if (finishCalls > 0 && disposeCalls > 0) {
      assert.ok(r.calls.lastIndexOf('dispose') > r.calls.lastIndexOf('finish'), `${label}: disposal follows rollback`);
    }
    assert.ok(!r.out.some((l) => l.includes('injected')), `${label}: no raw thrown value`);
    const rec = r.out.find((l) => l.includes('cleanup rollback='));
    if (disposeCalls === 0) {
      assert.equal(rec, undefined, `${label}: no cleanup claim without a handle`);
    } else {
      // THE RECORD ITSELF, not only the exit code. Hardcoding these booleans while leaving the exit
      // logic correct would otherwise pass the whole matrix and still lie to the operator.
      assert.ok(rec !== undefined, `${label}: a cleanup record must exist`);
      assert.ok(rec.includes(`rollback=${rollbackFact}`), `${label}: rollback fact — ${rec}`);
      assert.ok(rec.includes(`disposalRequested=${String(dispReq)}`), `${label}: disposalRequested — ${rec}`);
      assert.ok(rec.includes(`disposalCompleted=${String(dispDone)}`), `${label}: disposalCompleted — ${rec}`);
    }
  }
});

test('P0-R3: a port CLAIMING a graceful socket close is reported as unknown, never believed', async () => {
  const r = await drive(goodEnv(), {
    aclRows: [row({ scope: '' })],
    teardown: { requested: true, completed: true, gracefulSocketClose: 'closed_gracefully' },
  });
  const rec = r.out.find((l) => l.includes('cleanup rollback='));
  assert.ok(rec !== undefined);
  assert.ok(rec.includes('gracefulSocketClose=unknown'), 'an unrecognised claim must map to unknown');
  assert.ok(!rec.includes('closed_gracefully'), 'the port\'s own claim must not be echoed');
  // The disposal itself was complete, so this alone does not fail the run.
  assert.equal(r.rc, 0);
});

test('P0-R3: a rejecting executor construction claims no rollback and no disposal', async () => {
  const out = [];
  const rc = await runDiagnostic(goodEnv(), (l) => out.push(l), {
    assertDsn: () => ({}),
    describeDsn: () => ({ endpointFamily: 'session', database: EXPECTED_DATABASE }),
    createExecutor: async () => { throw new Error('injected construction failure'); },
    fingerprint: async () => [],
    readAcl: async () => ({ rows: [], overflowed: false }),
  });
  assert.equal(rc, 2);
  assert.equal(outcomeOf(out), PREFLIGHT_CODES.PORT_FAILED);
  assert.ok(!out.some((l) => l.includes('cleanup rollback=')), 'no cleanup claim for a handle that never existed');
  assert.ok(!out.some((l) => l.includes('injected construction failure')));
});

test('P0-R3 E2E: a cleanup failure reaches a nonzero result from the child main', async () => {
  const { handle } = fakeHandle({ aclRows: [row({ scope: '' })], teardown: { requested: true, completed: false, gracefulSocketClose: 'not_observed' } });
  const out = [];
  // The DSN is deliberately unparsable so that if `main` ever STOPPED forwarding these test ports,
  // the real validator refuses locally instead of the run reaching a socket. Nothing here can
  // contact a network on either path.
  const rc = await childMain([], goodEnv({ SUPABASE_DATABASE_URL: 'not-a-dsn' }), (l) => out.push(l), {
    assertDsn: () => ({}),
    describeDsn: () => ({ endpointFamily: 'session', database: EXPECTED_DATABASE }),
    createExecutor: async () => handle,
    fingerprint: async () => [],
    readAcl: async () => ({ rows: [row({ scope: '' })], overflowed: false }),
  });
  assert.equal(rc, 2, 'main must return nonzero when cleanup did not complete');
  assert.ok(out.some((l) => l.includes(PREFLIGHT_CODES.TEARDOWN_FAILED)), 'the bounded teardown fact must reach main output');
  assert.equal(outcomeOf(out), PREFLIGHT_CODES.TEARDOWN_FAILED);
  // The unchanged parent classifies success from the child exit code alone, so a nonzero result
  // here is exactly what denies it an OK classification.
  assert.notEqual(rc, 0);
});


// ---------------------------------------------------------------------------
// C2B-M005-B1 — the owner-scoped global FUNCTIONS correction
//
// Everything below is SYNTHETIC and offline: migration SQL is read from disk as TEXT, the catalog
// is a list of literal row objects, and the "application" of the migration is a pure model. No
// database, no socket, no process.
// ---------------------------------------------------------------------------

const M005_DIR = join(REPO_ROOT, 'server', 'platform-identity', 'migrations');
const readMigration = (side) =>
  readFileSync(join(M005_DIR, `005_principal_separation_rls_foundation.${side}.sql`), 'utf8');

/** Executable statements only: `--` comments stripped, whitespace collapsed, lowercased. */
function statementsOf(sql) {
  return sql
    .split('\n')
    .map((l) => l.replace(/--.*$/, ''))
    .join('\n')
    .split(';')
    .map((s2) => s2.replace(/\s+/g, ' ').trim().toLowerCase())
    .filter((s2) => s2.length > 0);
}

/**
 * The default-privilege statements, with scope, class, privileges and grantees parsed out.
 *
 * THE CLAUSE ORDER MATTERS AND THE PREVIOUS PATTERN HAD IT WRONG. PostgreSQL's grammar is
 * `ALTER DEFAULT PRIVILEGES [FOR ROLE ...] [IN SCHEMA ...] <grant_or_revoke>`, and it accepts the
 * two optional clauses in either order. The earlier regex allowed `FOR ROLE` only AFTER `IN
 * SCHEMA`, so the canonical `for role x in schema public revoke ...` did not parse at all — which
 * made the FOR-ROLE assertion a tautology for any well-formed migration and left the scope and
 * class guards silently no-oping on `undefined` fields.
 */
function defaultPrivilegeStatements(sql) {
  return statementsOf(sql)
    .filter((st) => st.startsWith('alter default privileges'))
    .map((st) => {
      const m = /^alter default privileges( for role (\S+))?( in schema (\w+))?( for role (\S+))? (revoke|grant) (.+?) on (\w+) (from|to) (.+)$/.exec(st);
      return m === null
        ? { raw: st, parsed: false, scope: null, forRole: null, verb: null, privileges: null, objectClass: null, grantees: [] }
        : {
          raw: st,
          parsed: true,
          scope: m[4] ?? '',
          forRole: m[2] !== undefined || m[6] !== undefined,
          verb: m[7],
          privileges: m[8].split(',').map((g) => g.trim()).sort(),
          objectClass: m[9],
          grantees: m[11].split(',').map((g) => g.trim()),
        };
    });
}

/**
 * Default-privilege text reachable ONLY through dynamic SQL.
 *
 * `defaultPrivilegeStatements` sees top-level statements. A dollar-quoted `EXECUTE` body is one
 * statement beginning `do`, so every shape proof in this section is blind to it — verified by
 * mutation: appending the exact compensating GRANT this stage removes left the whole suite green.
 */
function smuggledDefaultPrivilegeText(sql) {
  return statementsOf(sql).filter((st) => !st.startsWith('alter default privileges') && st.includes('alter default privileges'));
}

const CLASS_LABEL_BY_OBJTYPE = Object.fromEntries(M005_DEFAULT_ACL_CLASSES.map((c) => [c.objtype, c.label]));

// --- §10.1-7 — the migration's own default-privilege contract -----------------

test('C2B-M005-B1: no default-privilege change is reachable only through dynamic SQL', () => {
  for (const side of ['up', 'down']) {
    assert.deepEqual(smuggledDefaultPrivilegeText(readMigration(side)), [],
      `${side}: a default-privilege change is hidden inside dynamic SQL, where every shape proof below is blind to it`);
  }
});

test('C2B-M005-B1: migration 005 contains exactly one global FUNCTIONS revoke and three IN SCHEMA public revokes', () => {
  const st = defaultPrivilegeStatements(readMigration('up'));
  for (const s2 of st) assert.equal(s2.parsed, true, `unparsable default-privilege statement: ${s2.raw}`);
  // REVOKE ALL, not merely REVOKE: `revoke usage on functions` is valid SQL that removes nothing
  // PostgreSQL grants PUBLIC on a routine, so the global statement would read as the required
  // revoke while leaving the built-in EXECUTE exactly where it was.
  for (const s2 of st) assert.deepEqual(s2.privileges, ['all'], `must revoke ALL: ${s2.raw}`);
  const global = st.filter((s2) => s2.scope === '');
  const scoped = st.filter((s2) => s2.scope === 'public');
  assert.equal(st.length, 4, st.map((s2) => s2.raw).join(' | '));
  assert.equal(global.length, 1, 'exactly one global statement');
  assert.equal(global[0].objectClass, 'functions', 'the global statement is FUNCTIONS only');
  assert.equal(global[0].verb, 'revoke');
  assert.deepEqual(scoped.map((s2) => s2.objectClass).sort(), ['functions', 'sequences', 'tables']);
  for (const s2 of scoped) assert.equal(s2.verb, 'revoke');
});

test('C2B-M005-B1: the global statement PRECEDES every schema statement', () => {
  const st = defaultPrivilegeStatements(readMigration('up'));
  const lastGlobal = st.map((s2) => s2.scope).lastIndexOf('');
  const firstScoped = st.map((s2) => s2.scope).indexOf('public');
  assert.ok(lastGlobal >= 0 && firstScoped >= 0);
  assert.ok(lastGlobal < firstScoped, 'the global functions revoke must come first');
});

test('C2B-M005-B1: the grantee set is exactly public, anon, authenticated and no FOR ROLE appears', () => {
  for (const side of ['up', 'down']) {
    for (const s2 of defaultPrivilegeStatements(readMigration(side))) {
      assert.deepEqual([...s2.grantees].sort(), [...M005_DEFAULT_ACL_GRANTEES].sort(), `${side}: ${s2.raw}`);
      assert.equal(s2.forRole, false, `${side}: FOR ROLE must never appear — ${s2.raw}`);
    }
  }
});

test('C2B-M005-B1: no GLOBAL tables or sequences statement, and no TYPES or SCHEMAS statement, on either side', () => {
  for (const side of ['up', 'down']) {
    for (const s2 of defaultPrivilegeStatements(readMigration(side))) {
      if (s2.scope === '') {
        assert.ok(!['tables', 'sequences'].includes(s2.objectClass),
          `${side}: a GLOBAL ${s2.objectClass} statement was introduced — ${s2.raw}`);
      }
      assert.ok(!['types', 'schemas'].includes(s2.objectClass),
        `${side}: ${s2.objectClass} is outside migration 005's contract — ${s2.raw}`);
    }
  }
});

test('C2B-M005-B1: neither the up nor the down migration contains a default-privilege GRANT', () => {
  for (const side of ['up', 'down']) {
    for (const s2 of defaultPrivilegeStatements(readMigration(side))) {
      assert.notEqual(s2.verb, 'grant', `${side}: a compensating default-privilege GRANT appeared — ${s2.raw}`);
    }
  }
  // And the down migration performs NO default-privilege statement at all: the hardening is
  // retained, and no catalog manipulation stands in for the grant that was removed.
  assert.deepEqual(defaultPrivilegeStatements(readMigration('down')), []);
  assert.ok(!statementsOf(readMigration('down')).some((st) => /pg_default_acl/.test(st)),
    'the rollback must not manipulate the default-ACL catalog directly');
});

// --- §8 — the assessor's class flags are BOUND to the migration statements ----

test('C2B-M005-B1: the class constant’s revoke flags are exactly what migration 005 issues', () => {
  const st = defaultPrivilegeStatements(readMigration('up')).filter((s2) => s2.verb === 'revoke');
  const globalClasses = new Set(st.filter((s2) => s2.scope === '').map((s2) => s2.objectClass));
  const schemaClasses = new Set(st.filter((s2) => s2.scope === 'public').map((s2) => s2.objectClass));
  for (const cls of M005_DEFAULT_ACL_CLASSES) {
    assert.equal(cls.globallyRevokedByM005, globalClasses.has(cls.label),
      `${cls.label}: globallyRevokedByM005 has drifted from the migration`);
    assert.equal(cls.schemaRevokedByM005, schemaClasses.has(cls.label),
      `${cls.label}: schemaRevokedByM005 has drifted from the migration`);
  }
  // And the binding is TWO-WAY. Checking only "every statement is modelled" let a phantom class be
  // added to the constant — silently widening the production SQL predicate — and pass, because a
  // class the migration never names satisfies `globallyRevokedByM005 === false` vacuously.
  for (const c of [...globalClasses, ...schemaClasses]) {
    assert.ok(Object.values(CLASS_LABEL_BY_OBJTYPE).includes(c), `005 governs ${c} but the assessor does not model it`);
  }
  const named = new Set([...globalClasses, ...schemaClasses]);
  for (const cls of M005_DEFAULT_ACL_CLASSES) {
    assert.ok(named.has(cls.label),
      `the assessor models ${cls.label} but migration 005 issues no default-privilege statement for it`);
  }
  assert.deepEqual([...named].sort(), M005_DEFAULT_ACL_CLASSES.map((c) => c.label).sort());
});

// --- §5 / §10.14-15 — the reader's class predicate is GENERATED ---------------

test('C2B-M005-B1: the reader’s class predicate derives from the governed class set', async () => {
  const generated = defaultAclObjtypePredicate();
  assert.equal(generated, `d.defaclobjtype in (${M005_DEFAULT_ACL_CLASSES.map((c) => `'${c.objtype}'`).join(', ')})`);
  // The PRODUCTION statement contains exactly that fragment — not a hand-written copy of it.
  const sql = await productionAclSql();
  assert.ok(sql.includes(generated), `the production SQL does not carry the generated predicate: ${sql}`);
  // DRIFT: a different class set produces a different predicate, so the two cannot diverge silently.
  assert.equal(defaultAclObjtypePredicate([{ objtype: 'r' }]), "d.defaclobjtype in ('r')");
  assert.notEqual(defaultAclObjtypePredicate([{ objtype: 'r' }]), generated);
  // The bound stays a DISTINCT parameter equal to limit + 1, and the predicate precedes it.
  const seen = [];
  await readDefaultAclRowsBounded({ query: async (t, prm) => { seen.push({ t, prm }); return []; } }, 7);
  assert.deepEqual(seen[0].prm, ['public', 8]);
  assert.ok(seen[0].t.indexOf(generated) < seen[0].t.indexOf('limit $2'));
});

test('C2B-M005-B1: uncovered classes can never enter the predicate or consume the row budget', async () => {
  const generated = defaultAclObjtypePredicate();
  for (const u of M005_UNCOVERED_DEFAULT_ACL_CLASSES) {
    assert.ok(!generated.includes(`'${u.objtype}'`), `${u.objtype} must not be selectable`);
  }
  // NO CALLER-SUPPLIED STRING: anything that is not a single ASCII letter is refused outright
  // rather than formatted into the statement.
  for (const bad of ["r'), 1=1 --", '', 'rr', 'r ', 7, null, undefined, {}]) {
    assert.throws(() => defaultAclObjtypePredicate([{ objtype: bad }]), /invalid default-acl object class/,
      `objtype ${JSON.stringify(bad)} must be refused`);
  }
  assert.throws(() => defaultAclObjtypePredicate([]), /no governed default-acl classes/);
  // And the SQL the production path sends still filters BEFORE the limit, so a database full of
  // T/n rows cannot drive the diagnostic into a false overflow.
  const sql = await productionAclSql();
  assert.ok(sql.indexOf(generated) < sql.indexOf('limit $2'));
});

// --- §10.8-13 — the migration MODELLED against catalog evidence ---------------

/**
 * Apply migration 005's default-privilege statements to a modelled catalog state.
 *
 * Faithful to the two rules the whole correction rests on:
 *   * a GLOBAL revoke removes the covered grantees from the class's global entry AND leaves a
 *     global entry in place, because that entry is what substitutes for `acldefault()`;
 *   * an IN SCHEMA revoke removes the covered grantees from the class's public-schema entry only.
 * Rows owned by another role are NEVER touched: `ALTER DEFAULT PRIVILEGES` without FOR ROLE alters
 * the executing principal's own defaults and nothing else.
 *
 * THE PREMISE THIS CANNOT VERIFY, stated rather than left implicit. "A global revoke leaves a global
 * entry in place, and that entry substitutes for `acldefault()`" is the same belief
 * `classifyDefaultPrivileges` encodes as `.has('global')`. Both halves of these proofs rest on it,
 * and no offline model can confirm it — the stage forbids contacting PostgreSQL. It is asserted
 * from the documented `SetDefaultACL` / `get_user_default_acl` behaviour and remains an
 * inspection-derived assumption, not evidence produced by this suite.
 */
function applyModelled(rows, principal = PRINCIPAL) {
  const st = defaultPrivilegeStatements(readMigration('up')).filter((s2) => s2.verb === 'revoke');
  const objtypeOf = (label) => M005_DEFAULT_ACL_CLASSES.find((c) => c.label === label)?.objtype;
  const covered = (g) => typeof g === 'string' && M005_DEFAULT_ACL_GRANTEES.includes(g.toLowerCase());
  let out = [...rows];
  for (const s2 of st) {
    const objtype = objtypeOf(s2.objectClass);
    if (objtype === undefined) continue;
    out = out.filter((r) => !(r.owner === principal && r.objtype === objtype && r.scope === s2.scope && covered(r.grantee)));
    if (s2.scope === '' && !out.some((r) => r.owner === principal && r.objtype === objtype && r.scope === '')) {
      // The global entry now exists and grants nothing to a covered grantee.
      out.push({ owner: principal, objtype, scope: '', grantee: null, privilege: null });
    }
  }
  return out;
}

test('C2B-M005-B1: modelled application table', () => {
  const g = (objtype, grantee, privilege) => row({ objtype, scope: '', grantee, privilege });
  const sch = (objtype, grantee, privilege) => row({ objtype, scope: 'public', grantee, privilege });
  const foreign = { owner: 'supabase_admin', objtype: 'f', scope: '', grantee: 'public', privilege: 'EXECUTE' };

  const BASE = (tables, sequences, functions) => ({ tables, sequences, functions });
  const OVR = 'GLOBAL_OVERRIDE';
  const RET = 'BUILTIN_RETAINED';
  // [label, startingRows, postApplyPostcondition, postApplyBlocker, postApplyFindingCount, postApplyGlobalBase]
  const cases = [
    ['8  clean global table/sequence defaults + built-in function default', [], 'MET', 'NO', 0, BASE(RET, RET, OVR)],
    ['9  global function grants to covered grantees', [g('f', 'public', 'EXECUTE'), g('f', 'anon', 'EXECUTE')], 'MET', 'NO', 0, BASE(RET, RET, OVR)],
    ['10 public-schema grants across r/S/f',
      [sch('r', 'anon', 'SELECT'), sch('S', 'authenticated', 'USAGE'), sch('f', 'public', 'EXECUTE')], 'MET', 'NO', 0, BASE(RET, RET, OVR)],
    ['11 a global TABLE grant survives', [g('r', 'anon', 'SELECT')], 'UNMET', 'YES', 1, BASE(OVR, RET, OVR)],
    ['12 a global SEQUENCE grant survives', [g('S', 'public', 'USAGE')], 'UNMET', 'YES', 1, BASE(RET, OVR, OVR)],
  ];

  for (const [label, start, postcondition, blocker, findingCount, base] of cases) {
    const after = applyModelled(start);
    // THE MODEL MUST HAVE DONE SOMETHING, in every case. Cases 11 and 12 assert a SURVIVING blocker,
    // so their A/B expectations would hold unchanged under a do-nothing `applyModelled` — they would
    // then be exercising the assessor and nothing about the migration. The one thing the migration
    // always does is establish the global FUNCTIONS entry, so that is what is asserted here.
    assert.notDeepEqual(after, start, `${label}: the modelled application changed nothing`);
    const a = assessDefaultAclPosture(PRINCIPAL, PRINCIPAL, { rows: after, overflowed: false });
    assert.equal(a.postcondition, postcondition, `${label}: A after modelled application`);
    assert.equal(a.blockerSurvivesCurrentM005, blocker, `${label}: B after modelled application`);
    assert.equal(a.findingCount, findingCount, `${label}: finding count after modelled application`);
    // THE PER-CLASS BASE, not only the two verdicts. Without this the table could pass while the
    // functions class was never actually closed, or while a table/sequence base was invented.
    assert.deepEqual({ ...a.globalBase }, base, `${label}: globalBase after modelled application`);
    if (start.length > 0 && blocker === 'NO') {
      const before = assessDefaultAclPosture(PRINCIPAL, PRINCIPAL, { rows: start, overflowed: false });
      assert.equal(before.postcondition, 'UNMET', `${label}: the starting state must actually be unmet`);
    }
  }

  // 13 — another owner's defaults are neither credited nor altered.
  //
  // NOT ALTERED: `ALTER DEFAULT PRIVILEGES` without FOR ROLE touches only the executing principal's
  // own entries, so the model leaves the foreign row exactly as found.
  const after = applyModelled([foreign]);
  assert.ok(after.some((r) => r.owner === 'supabase_admin' && r.grantee === 'public' && r.privilege === 'EXECUTE'),
    'a foreign owner’s row must be left exactly as found');
  assert.equal(after.filter((r) => r.owner === 'supabase_admin').length, 1, 'no foreign row may be added or removed');
  const a = assessDefaultAclPosture(PRINCIPAL, PRINCIPAL, { rows: after, overflowed: false });
  // NOT CREDITED, IN EITHER DIRECTION. It never closes a class for this principal, so B stays NO on
  // the strength of the principal's OWN global functions entry — and it is REFUSED out loud rather
  // than ignored, which is why A is unmet and one finding is recorded. Silence would be the defect.
  assert.equal(a.blockerSurvivesCurrentM005, 'NO', 'a foreign row must never be credited as a surviving blocker');
  assert.equal(a.postcondition, 'UNMET', 'a foreign row is refused, not ignored');
  assert.equal(a.findingCount, 1, 'exactly the foreign-owner refusal');
  // And a foreign GLOBAL row can never substitute for the principal's missing one.
  const foreignOnly = assessDefaultAclPosture(PRINCIPAL, PRINCIPAL, { rows: [foreign], overflowed: false });
  assert.equal(foreignOnly.globalBase.functions, 'BUILTIN_RETAINED',
    'a foreign global row must not be read as this principal’s global override');
});

// --- §6 / §10.16-17 — backend continuity -------------------------------------

test('C2B-M005-B1: backend identity is captured twice and agreement permits the verdict', async () => {
  const r = await drive(goodEnv(), { aclRows: [row({ scope: '' })] });
  assert.equal(r.rc, 0, r.out.join(' | '));
  assert.equal(r.calls.filter((c) => c === 'backendIdentity').length, 2, r.calls.join(','));
  // ORDER: capture 1 after the read-only proof and before the identity read; capture 2 after the
  // ACL read and before the closing read-only recheck and the verdict.
  const first = r.calls.indexOf('backendIdentity');
  const last = r.calls.lastIndexOf('backendIdentity');
  assert.ok(r.calls.indexOf('isReadOnly') < first, 'the first token follows the read-only proof');
  assert.ok(first < r.calls.indexOf('query'), 'the first token precedes the identity read');
  assert.ok(last > r.calls.lastIndexOf('query'), 'the second token follows the ACL read');
  assert.ok(last < r.calls.lastIndexOf('isReadOnly'), 'the second token precedes the closing read-only recheck');
  assert.ok(r.out.some((l) => l.includes('backendContinuity=AGREED')));
  // The token itself is never emitted.
  assert.ok(!r.out.some((l) => l.includes('pid:')), 'no backend identifier may reach operator output');
});

test('C2B-M005-B1: a changed or unreadable backend identity emits no verdict and exits nonzero', async () => {
  // An unreadable FIRST token established nothing, so it is unreadable evidence rather than a
  // change; only the second capture can report a broken continuity.
  const cases = [
    ['a changed backend', ['pid:1', 'pid:2'], 1, 1, PREFLIGHT_CODES.BACKEND_IDENTITY_CHANGED],
    ['an unreadable second token', ['pid:1', undefined], 1, 1, PREFLIGHT_CODES.BACKEND_IDENTITY_CHANGED],
    ['a null second result', ['pid:1', null], 1, 1, PREFLIGHT_CODES.BACKEND_IDENTITY_CHANGED],
    ['a token standing for an unread pid', ['pid:undefined', 'pid:undefined'], 0, 0, PREFLIGHT_CODES.EVIDENCE_UNREADABLE],
    ['an unreadable first token', [undefined, undefined], 0, 0, PREFLIGHT_CODES.EVIDENCE_UNREADABLE],
  ];
  for (const [label, backendTokens, fingerprintCalls, aclCalls, code] of cases) {
    const r = await driveCounting(goodEnv(), { backendTokens, aclRows: [row({ scope: '' })] });
    assert.equal(r.rc, 2, `${label}: must exit nonzero`);
    assert.equal(outcomeOf(r.out), code, `${label}: bounded code`);
    assert.deepEqual(verdictLines(r.out), [], `${label}: no verdict-shaped line may be emitted`);
    assert.equal(r.fingerprintCalls, fingerprintCalls, `${label}: fingerprint calls`);
    assert.equal(r.aclCalls, aclCalls, `${label}: ACL reads`);
    // NO RETRY, NO SECOND CONNECTION, and cleanup still runs exactly once each.
    assert.equal(r.created, 1, `${label}: exactly one executor`);
    assert.equal(r.calls.filter((c) => c === 'reserve').length, 1, `${label}: exactly one reserve`);
    assert.equal(r.calls.filter((c) => c === 'finish').length, 1, `${label}: exactly one rollback`);
    assert.equal(r.calls.filter((c) => c === 'dispose').length, 1, `${label}: exactly one disposal`);
    assert.ok(!r.out.some((l) => l.includes('pid:')), `${label}: no backend identifier in output`);
  }
});

// --- §7 / §10.18-22 — only A=MET/B=NO exits zero ------------------------------

test('C2B-M005-B1: the posture disposition table', () => {
  const P = PREFLIGHT_CODES;
  const c = (postcondition, blockerSurvivesCurrentM005, overflowed = false, principalAgreement = 'AGREED') =>
    choosePosture({ principalAgreement, postcondition, blockerSurvivesCurrentM005 }, overflowed);
  assert.equal(c('MET', 'NO'), P.POSTURE_MET);
  assert.equal(c('UNMET', 'NO'), P.POSTURE_UNMET);
  assert.equal(c('UNMET', 'YES'), P.SURVIVING_BLOCKER);
  assert.equal(c('MET', 'YES'), P.POSTURE_INCONSISTENT);
  assert.equal(c('UNREADABLE', 'NO'), P.EVIDENCE_UNREADABLE);
  assert.equal(c('MET', 'UNREADABLE'), P.EVIDENCE_UNREADABLE);
  assert.equal(c('MET', 'NO', true), P.EVIDENCE_UNREADABLE, 'overflow outranks a favourable pair');
  assert.equal(c('MET', 'NO', false, 'MISMATCH'), P.EVIDENCE_UNREADABLE, 'a mismatch can never be MET');
});

test('C2B-M005-B1: the exit rule itself — exactly one bounded code returns zero', () => {
  // THIS DRIVES THE RULE, NOT THE CONSTANT. The assertion this replaces filtered
  // `Object.values(PREFLIGHT_CODES)` for equality with `POSTURE_MET` and asserted the count was 1 —
  // true whenever the constant appears once, whatever the exit rule does. A mutation adding
  // POSTURE_INCONSISTENT to the zero-exit set passed the entire suite.
  const codes = Object.values(PREFLIGHT_CODES);
  const zero = codes.filter((code) => exitCodeFor(code) === 0);
  assert.deepEqual(zero, [PREFLIGHT_CODES.POSTURE_MET], `exactly one code may exit zero; got ${JSON.stringify(zero)}`);
  for (const code of codes) {
    assert.equal(exitCodeFor(code), code === PREFLIGHT_CODES.POSTURE_MET ? 0 : 2, code);
  }
  // An unrecognised code is nonzero too: a future disposition that forgets to register here must
  // fail rather than inherit success.
  for (const unknown of ['', 'default_acl_preflight_ok', 'anything_else']) {
    assert.equal(exitCodeFor(unknown), 2, unknown);
  }
  // The retired bare-completion VALUE is gone, not merely its key: a rename to `COMPLETED` would
  // reintroduce the same string while a key check kept passing.
  assert.ok(!codes.includes('default_acl_preflight_ok'), 'the retired bare completion code must not exist under any key');
});

test('C2B-M005-B1: the child exit code follows the posture, not mere completion', async () => {
  const empty = (objtype) => row({ objtype, scope: '' });
  const all = M005_DEFAULT_ACL_CLASSES.map((cl) => empty(cl.objtype));
  // [label, rows, rc, outcome]
  const cases = [
    ['A=MET  B=NO  -> zero', all, 0, PREFLIGHT_CODES.POSTURE_MET],
    ['A=UNMET B=NO -> nonzero', [], 2, PREFLIGHT_CODES.POSTURE_UNMET],
    ['B=YES        -> nonzero', [...all, row({ objtype: 'r', scope: '', grantee: 'anon', privilege: 'SELECT' })],
      2, PREFLIGHT_CODES.SURVIVING_BLOCKER],
  ];
  for (const [label, rows, rc, outcome] of cases) {
    const r = await drive(goodEnv(), { readAcl: async () => ({ rows, overflowed: false }) });
    assert.equal(r.rc, rc, `${label}: ${r.out.join(' | ')}`);
    assert.equal(outcomeOf(r.out), outcome, label);
    assert.ok(r.out.some((l) => l.includes(`disposition=${outcome}`)), `${label}: the disposition is stated`);
    if (rc !== 0) assert.ok(r.out.some((l) => l.includes(`REFUSED: ${outcome}`)), `${label}: an unfavourable posture refuses`);
  }
  // A=MET together with B=YES is UNREACHABLE from real evidence — a covered global grant that
  // establishes B is itself a finding that fails A — so the contradiction is proved at the pure
  // decision instead, and it too exits nonzero because only POSTURE_MET does not.
  assert.notEqual(
    choosePosture({ principalAgreement: 'AGREED', postcondition: 'MET', blockerSurvivesCurrentM005: 'YES' }, false),
    PREFLIGHT_CODES.POSTURE_MET,
  );
});

test('C2B-M005-B1: every nonzero result carries a REFUSED line naming its own outcome', async () => {
  const good = [row({ scope: '' })];
  const runs = [
    ['rollback failure on a met posture', { aclRows: good, failAt: 'finish' }],
    ['disposal failure on a met posture', { aclRows: good, teardown: false }],
    ['an unfavourable posture', { readAcl: async () => ({ rows: [], overflowed: false }) }],
    ['a surviving blocker', { readAcl: async () => ({ rows: [row({ objtype: 'r', scope: '', grantee: 'anon', privilege: 'SELECT' })], overflowed: false }) }],
    ['a broken backend identity', { aclRows: good, backendTokens: ['pid:1', 'pid:2'] }],
    ['unreadable evidence', { readAcl: async () => ({ rows: [], overflowed: true }) }],
    ['a principal mismatch', { aclRows: good, identity: { session_principal: 'other_role' } }],
    ['a lost read-only bracket', { aclRows: good, readOnly: [true, false] }],
  ];
  for (const [label, opts] of runs) {
    const r = await drive(goodEnv(), opts);
    assert.equal(r.rc, 2, `${label}: must exit nonzero`);
    const outcome = outcomeOf(r.out);
    assert.ok(r.out.some((l) => l === `[acl-preflight] REFUSED: ${outcome}`),
      `${label}: no REFUSED line names the outcome ${outcome} — ${r.out.join(' | ')}`);
  }
});

test('C2B-M005-B1: cleanup failure still overrides a MET posture', async () => {
  const all = M005_DEFAULT_ACL_CLASSES.map((cl) => row({ objtype: cl.objtype, scope: '' }));
  for (const [label, opts, outcome] of [
    ['rollback failure', { failAt: 'finish' }, PREFLIGHT_CODES.ROLLBACK_FAILED],
    ['disposal failure', { teardown: false }, PREFLIGHT_CODES.TEARDOWN_FAILED],
  ]) {
    const r = await drive(goodEnv(), { ...opts, readAcl: async () => ({ rows: all, overflowed: false }) });
    assert.ok(r.out.some((l) => l.includes(`disposition=${PREFLIGHT_CODES.POSTURE_MET}`)), `${label}: the posture was met`);
    assert.equal(r.rc, 2, `${label}: cleanup failure must override it`);
    assert.equal(outcomeOf(r.out), outcome, label);
  }
});

// --- §10.23 — nothing raw reaches the record on any new path ------------------

test('C2B-M005-B1: no role, privilege, ACL, DSN or thrown value reaches output on the new paths', async () => {
  // EVERY FIXTURE CARRIES EVERY TOKEN IT IS CHECKED FOR. A leak list containing values no run could
  // possibly emit passes unconditionally and proves nothing; a third of the previous list was in
  // that state. Each row set below is built to contain the whole vocabulary, so each assertion is
  // load-bearing on every run, and the run list now also covers the overflow, fingerprint-mismatch
  // and target-invalid paths that emit their own lines.
  const loaded = [
    row({ objtype: 'r', scope: '', grantee: 'anon', privilege: 'SELECT' }),
    row({ objtype: 'S', scope: 'public', grantee: 'authenticated', privilege: 'USAGE' }),
    row({ objtype: 'f', scope: 'public', grantee: 'public', privilege: 'EXECUTE' }),
    { owner: 'supabase_admin', objtype: 'f', scope: '', grantee: 'public', privilege: 'EXECUTE' },
  ];
  const LEAKS = [
    PRINCIPAL, 'supabase_admin', 'anon', 'authenticated', 'SELECT', 'EXECUTE', 'USAGE',
    'pg_default_acl', 'defaclrole', 'pid:', '31337', '99999',
    'SYNTHETICPASSWORD', 'synthref0000000', 'BEGIN CERTIFICATE', 'injected',
  ];
  // The fixture vocabulary really does contain the catalog half of the list, so those assertions
  // are exercised rather than vacuous.
  const fixtureText = JSON.stringify(loaded);
  for (const t of [PRINCIPAL, 'supabase_admin', 'anon', 'authenticated', 'SELECT', 'EXECUTE', 'USAGE']) {
    assert.ok(fixtureText.includes(t), `the leak list checks ${t} but no fixture can produce it`);
  }
  const runs = [
    ['broken continuity', await drive(goodEnv(), { backendTokens: ['pid:31337', 'pid:99999'], aclRows: loaded })],
    ['surviving blocker', await drive(goodEnv(), { readAcl: async () => ({ rows: loaded, overflowed: false }) })],
    ['unmet posture', await drive(goodEnv(), { readAcl: async () => ({ rows: [], overflowed: false }) })],
    ['overflowed evidence', await drive(goodEnv(), { readAcl: async () => ({ rows: loaded, overflowed: true }) })],
    ['fingerprint mismatch', await drive(goodEnv(), { aclRows: loaded, fingerprintFailures: ['bcp.secret.action for supabase_admin'] })],
    ['target invalid', await drive(goodEnv(), { database: 'not_postgres' })],
    ['a throwing identity port', await drive(goodEnv(), { failAt: 'backendIdentity' })],
  ];
  for (const [label, r] of runs) {
    const text = r.out.join('\n');
    for (const leak of LEAKS) {
      assert.ok(!text.includes(leak), `${label}: operator output leaked ${leak}: ${text}`);
    }
    assert.ok(r.out.every((l) => l.startsWith('[acl-preflight] ')), `${label}: every line is a bounded record line`);
  }
});


/**
 * THE DEFAULT-ACL DRIFT GUARD.
 *
 * Its sibling had one; this child did not, and the launcher's grammar already whitelisted the
 * `acl-preflight` tag — so the tag was trusted with nothing holding the trust to account. That is
 * the worst of the two states: a grammar that names a child it never checks.
 *
 * The 32 inline emit templates are EXTRACTED from executable source and expanded over the complete
 * value domain of every interpolation slot, then driven through the launcher's independently pinned
 * table. It is FAIL-CLOSED ON DRIFT: a new emit site, or a slot whose domain is not declared here,
 * fails this test rather than silently reducing coverage.
 */
test('C2B-M005-LRLS-L3-R4: every line the default-ACL child can emit survives the canonical grammar', () => {
  const src = readFileSync(join(REPO_ROOT, 'scripts', 'managed-default-acl-preflight.ts'), 'utf8');

  const templates = [];
  const opener = /emit\(\s*(`|')/g;
  let m;
  while ((m = opener.exec(src)) !== null) {
    let i = m.index + m[0].length;
    let quote = m[1];
    let text = '';
    for (;;) {
      let buf = '';
      while (i < src.length && src[i] !== quote) {
        if (src[i] === '\\') { buf += src[i] + src[i + 1]; i += 2; continue; }
        buf += src[i]; i += 1;
      }
      i += 1;
      text += buf;
      const rest = src.slice(i);
      const cont = /^\s*\+\s*(`|')/.exec(rest);
      if (!cont) {
        assert.match(rest, /^\s*,?\s*\)/,
          `an emit near source line ${src.slice(0, m.index).split('\n').length} concatenates a `
          + 'non-literal; extend the scanner, because the part it can read may pass on its own');
        break;
      }
      quote = cont[1];
      i += cont[0].length;
    }
    if (text.startsWith('[acl-preflight]')) {
      templates.push({ text, at: src.slice(0, m.index).split('\n').length });
    }
  }
  assert.equal(templates.length, 32, `expected the 32 inline emit templates, extracted ${templates.length}`);
  for (const t of templates) {
    assert.ok(!t.text.includes('\\'),
      `the template near source line ${t.at} contains an escape sequence the scanner copies rather `
      + 'than decodes; teach it to decode before this line can be proved');
  }

  const CODES = Object.values(PREFLIGHT_CODES);
  const BOOL = ['true', 'false'];
  const DOMAINS = {
    'String(DEFAULT_ACL_ROW_LIMIT)': ['200'],
    'String(assessment.findingCount)': ['0', '1', '201'],
    'String(cleanup.disposalCompleted)': BOOL,
    'String(cleanup.disposalRequested)': BOOL,
    'String(database === EXPECTED_DATABASE)': BOOL,
    'String(principal === sessionPrincipal)': BOOL,
    'String(read.overflowed)': BOOL,
    'assessment.blockerSurvivesCurrentM005': ['YES', 'NO', 'UNREADABLE'],
    'assessment.postcondition': ['MET', 'UNMET', 'UNREADABLE'],
    'assessment.principalAgreement': ['AGREED', 'MISMATCH', 'UNREADABLE'],
    'assessment.schemaGrantsToCoveredGrantees': ['PRESENT', 'NONE', 'UNREADABLE'],
    base: ['GLOBAL_OVERRIDE', 'BUILTIN_RETAINED', 'UNREADABLE'],
    'cleanup.gracefulSocketClose': ['not_observed', 'unknown'],
    'cleanup.rollback': ['not_required', 'completed', 'failed'],
    code: CODES,
    primaryCode: CODES,
    "continuous ? 'AGREED' : 'BROKEN'": ['AGREED', 'BROKEN'],
    fp: ['MATCH', 'MISMATCH'],
    label: ['tables', 'sequences', 'functions'],
    'shape.database': ['postgres'],
    'shape.endpointFamily': ['session'],
  };
  const domainFor = (expr) => {
    if (Object.prototype.hasOwnProperty.call(DOMAINS, expr)) return DOMAINS[expr];
    const named = /^PREFLIGHT_CODES\.([A-Z_]+)$/.exec(expr);
    if (named && named[1] in PREFLIGHT_CODES) return [PREFLIGHT_CODES[named[1]]];
    return null;
  };

  const expand = (template) => {
    let out = [template.text];
    for (;;) {
      const slot = /\$\{([^}]*)\}/.exec(out[0]);
      if (!slot) return out;
      const expr = slot[1].trim();
      const domain = domainFor(expr);
      assert.ok(domain !== null,
        `line ${template.at} interpolates \${${expr}}, whose value domain is not declared here; `
        + 'declare its complete value set above before this value may reach the operator record');
      const next = [];
      for (const line of out) for (const value of domain) next.push(line.replace(slot[0], value));
      out = next;
    }
  };

  let driven = 0;
  for (const template of templates) {
    for (const line of expand(template)) {
      assert.equal(canonicalPreflightLine(line), line,
        `line ${template.at} can emit evidence the canonical grammar discards or rewrites: ${line}`);
      driven += 1;
    }
  }
  assert.ok(driven >= 100, `the expansion collapsed to ${driven} lines; the domains are not applied`);

  // AND THE GRAMMAR IS NOT MERELY PERMISSIVE ON THIS TAG EITHER.
  for (const hostile of [
    '[acl-rogue] applicationFingerprint=MATCH',
    '[acl-preflight] connection terminated unexpectedly',
    '[acl-preflight] password=hunter2',
    '[acl-preflight] A.password=hunter2',
    '[acl-preflight] db.abcdefghijklmnopqrst.supabase.co=true',
    '[acl-preflight] applicationFingerprint=[REDACTED]CH',
    '[acl-preflight] applicationFingerprint=deadbeefcafebabe0123456789abcdef',
    '[acl-preflight] outcome=m005_preflight_port_failed',
  ]) {
    assert.equal(canonicalPreflightLine(hostile), null, `the grammar accepted a line it must discard: ${hostile}`);
  }
});

test('C2B-M005-LRLS-L3-R4: the default-ACL launcher requires the child own terminal record', () => {
  // A CHILD KILLED BY A LINUX REALTIME SIGNAL arrives as `exit=0 signal=null`, which every negative
  // lifecycle test accepts. Only the child's own final record separates it from a clean run.
  const ok = terminalCompletion(
    '[acl-preflight] applicationFingerprint=MATCH\n[acl-preflight] outcome=default_acl_preflight_posture_met',
    'acl-preflight', true);
  assert.deepEqual({ ...ok }, { ok: true, reason: 'complete', code: 'default_acl_preflight_posture_met' });
  // Every way the evidence can fail, fails closed.
  for (const [text, reason] of [
    ['[acl-preflight] applicationFingerprint=MATCH', 'missing'],
    ['[acl-preflight] outcome=default_acl_preflight_posture_met\n[acl-preflight] outcome=default_acl_preflight_posture_met', 'duplicated'],
    ['[acl-preflight] outcome=default_acl_preflight_posture_met\n[acl-preflight] applicationFingerprint=MATCH', 'not_final'],
    // AN UNKNOWN CODE READS AS MISSING, because the grammar refuses the line before this sees it.
    ['[acl-preflight] outcome=default_acl_preflight_not_a_code', 'missing'],
    ['', 'missing'],
  ]) {
    const got = terminalCompletion(text, 'acl-preflight', true);
    assert.equal(got.ok, false, `must fail closed: ${reason}`);
    assert.equal(got.reason, reason);
    assert.equal(got.code, null, 'no code is returned unless the evidence is complete');
  }
  // An unsealed capture yields nothing at all, whatever it contains.
  assert.equal(terminalCompletion('[acl-preflight] outcome=default_acl_preflight_posture_met', 'acl-preflight', false).reason,
    'streams_not_proved_closed');
  // And this launcher's tag is one the grammar actually declares fields for.
  assert.ok(PREFLIGHT_TRANSCRIPT_TAGS.includes('acl-preflight'));
  assert.ok(PREFLIGHT_FIELD_KEYS['acl-preflight'].length >= 20);
  // THE INVARIANT THAT MAKES A MEMBERSHIP TEST UNNECESSARY INSIDE `terminalCompletion`: the
  // grammar's `outcome` domain and the terminal vocabulary are the same set. Asserted here so a
  // future divergence fails loudly instead of opening a gap neither side checks.
  for (const [tag, codes] of Object.entries(TERMINAL_OUTCOME_VOCABULARY)) {
    for (const code of codes) {
      assert.equal(canonicalPreflightLine(`[${tag}] outcome=${code}`), `[${tag}] outcome=${code}`,
        `every terminal code must also be renderable by the grammar: ${tag} ${code}`);
    }
  }
});

/**
 * THE RUNTIME-CAPTURE DRIFT GUARD for this child — the scanner's independent partner.
 *
 * The extraction guard above reads source text, so its completeness rests on a hand-written scanner.
 * This proves the same property with no scanner in the path at all: it RUNS the real child across a
 * spread of postures through injected ports and requires every byte it emits to survive the
 * launcher's independently pinned grammar. The two fail for different reasons and neither can mask
 * the other.
 */
test('C2B-M005-LRLS-L3-R4: every line the ACL child REALLY emits at runtime survives the grammar', async () => {
  const postures = [
    [goodEnv(), {}],
    [goodEnv(), { fingerprintFailures: ['x'] }],
    [goodEnv(), { database: 'other' }],
    [goodEnv({ NODE_ENV: 'production' }), {}],
    [goodEnv({ CONFIRM_SUPABASE_TARGET: 'other' }), {}],
    [goodEnv(), { readAcl: async () => ({ rows: [], overflowed: true }) }],
    [goodEnv(), { readAcl: async () => { throw new Error('acl dsn=secret'); } }],
  ];
  const seen = [];
  for (const [env, opts] of postures) {
    try {
      const { out } = await drive(env, opts);
      for (const line of out) seen.push(line);
    } catch {
      // A posture that throws produces no transcript; the other postures still carry the proof.
    }
  }
  assert.ok(seen.length >= 15, `the postures must actually produce output: ${seen.length}`);
  const discarded = seen.filter((l) => canonicalPreflightLine(l) === null);
  assert.deepEqual(discarded, [],
    `the child's own runtime output was discarded:\n${[...new Set(discarded)].join('\n')}`);
  // NON-VACUITY: the same assertion must fail for material the grammar has to refuse.
  assert.equal(canonicalPreflightLine('[acl-preflight] applicationFingerprint=hunter2'), null);
});

test('C2B-M005-LRLS-L4: the ACL record and its exit code state ONE disposition, not two', () => {
  // The sibling launcher had this test and this one did not, so R4-M13 — dropping the terminal
  // requirement from the ACL disposition — survived a sweep its twin failed. An asymmetry between
  // two launchers running the same contract is exactly the shape a mutation sweep exists to find.
  const base = {
    spawned: true, status: 'closed', exitCode: 0, signal: null,
    identity: { pid: 2, pgid: 2, sid: 2 }, closeObserved: true, streamsClosed: true,
    group: { available: true, pids: [], groupMembers: [], sessionMembers: [] },
    cleanup: { complete: true },
  };
  const withStdout = (text) => ({
    ...base, capture: { overflowed: false, text: () => text, streamText: (s) => (s === 'stdout' ? text : '') },
  });

  const killed = dispositionFor(withStdout('[acl-preflight] applicationFingerprint=MATCH'));
  assert.equal(killed.terminal.ok, false, 'no terminal record was delivered');
  assert.equal(killed.code, PREFLIGHT_LAUNCHER_CODES.TERMINAL_EVIDENCE_INCOMPLETE);
  assert.equal(killed.exitCode, 2, 'and the exit code says what the record says');

  const completed = dispositionFor(withStdout(
    '[acl-preflight] applicationFingerprint=MATCH\n[acl-preflight] outcome=default_acl_preflight_posture_met'));
  assert.equal(completed.terminal.ok, true);
  assert.equal(completed.terminal.code, 'default_acl_preflight_posture_met');
  assert.notEqual(completed.code, PREFLIGHT_LAUNCHER_CODES.TERMINAL_EVIDENCE_INCOMPLETE,
    'the favourable disposition is reachable, so these do not all fail alike');

  // THE RECORD IS DERIVED FROM THE SAME CALL, so the two cannot disagree by construction.
  for (const result of [withStdout('[acl-preflight] applicationFingerprint=MATCH'), withStdout('')]) {
    const d = dispositionFor(result);
    const text = renderPreflightReport(result).join('\n');
    assert.ok(text.includes(`terminalEvidence=${d.terminal.reason}`));
    assert.ok(text.includes(`outcome=${d.code}`),
      'the record must name the disposition the exit code was derived from');
  }
});
