// Phase 4.0 M6-ENTRY-P1 — postgresStartupPreflight.ts: the pure judgments (evaluateRuntimeLogin,
// evaluateMigrationLedger), the pinned constants (REQUIRED_MIGRATIONS, APPROVED_ROLE_GRANTS) bound to the
// real migration files, and createPostgresStartupPreflight over a FAKE SupervisedPgClient — no database.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  APPROVED_ROLE_GRANTS, LEDGER_READ_GRANT, PREFLIGHT_BOUNDS, REQUIRED_MIGRATIONS, RUNTIME_PRIVILEGE_ROLES,
  createPostgresStartupPreflight, evaluateMigrationLedger, evaluateParameterLogging, evaluateRuntimeLogin,
} from './postgresStartupPreflight.js';
import type {
  LedgerFacts, LedgerRowFacts, LedgerViolation, MembershipFacts, ParameterLoggingFacts, ReachedRoleFacts, RuntimeLoginFacts, RuntimeLoginViolation,
} from './postgresStartupPreflight.js';
import type { PgTransactionScope, SupervisedPgClient, TransactionBounds } from './supervisedPgClient.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = resolve(HERE, '..', 'platform-identity', 'migrations');

// --- A. REQUIRED_MIGRATIONS and APPROVED_ROLE_GRANTS, bound to the real migration files ------------------

test('the migrations directory holds exactly the up files 001..022, and REQUIRED_MIGRATIONS is each one\'s sha256', () => {
  const upFiles = readdirSync(MIGRATIONS_DIR).filter((f) => /\.up\.sql$/.test(f));
  const versions = upFiles.map((f) => /^(\d{3})_/.exec(f)?.[1]).sort();
  assert.deepEqual(versions, Array.from({ length: 22 }, (_, i) => String(i + 1).padStart(3, '0')),
    'the up files are exactly 001..022: a new migration must update the pin');
  assert.deepEqual(REQUIRED_MIGRATIONS.map((m) => m.version), versions, 'REQUIRED_MIGRATIONS names the same versions, in order');
  for (const { version, checksum } of REQUIRED_MIGRATIONS) {
    const file = upFiles.find((f) => f.startsWith(`${version}_`));
    assert.ok(file !== undefined, `an up file for ${version} exists`);
    const bytes = readFileSync(join(MIGRATIONS_DIR, file as string));
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    assert.equal(checksum, sha256, `REQUIRED_MIGRATIONS[${version}] is the migration engine's own sha256 of the up file`);
    assert.match(checksum, /^[0-9a-f]{64}$/, `${version}: a lowercase hex sha256 digest`);
  }
  assert.ok(Object.isFrozen(REQUIRED_MIGRATIONS));
});

test('APPROVED_ROLE_GRANTS is sorted, unique, and every line is role|a-or-r|type|identity|privileges with a known role', () => {
  // Sorted field by field (role, kind, type, identity, privileges), not as one joined string with '|'
  // separators — under a plain string sort a space (in "table column") would sort before the pipe that
  // follows "table", which is not the order the list is kept in.
  const byField = (a: string, b: string): number => {
    const pa = a.split('|');
    const pb = b.split('|');
    for (let i = 0; i < 5; i++) {
      if (pa[i] < pb[i]) return -1;
      if (pa[i] > pb[i]) return 1;
    }
    return 0;
  };
  assert.deepEqual([...APPROVED_ROLE_GRANTS].sort(byField), [...APPROVED_ROLE_GRANTS], 'sorted');
  assert.equal(new Set(APPROVED_ROLE_GRANTS).size, APPROVED_ROLE_GRANTS.length, 'unique');
  const knownRoles = new Set(Object.keys(RUNTIME_PRIVILEGE_ROLES));
  assert.deepEqual([...knownRoles].sort(), ['tmpos_app', 'tmpos_audit_writer']);
  for (const line of APPROVED_ROLE_GRANTS) {
    const parts = line.split('|');
    assert.equal(parts.length, 5, `${line}: role|kind|type|identity|privileges`);
    const [role, kind, type, identity] = parts;
    assert.ok(knownRoles.has(role), `${line}: a known role`);
    assert.ok(kind === 'a' || kind === 'r', `${line}: kind is 'a' or 'r'`);
    assert.ok(type.length > 0, `${line}: a non-empty object type`);
    assert.ok(identity.length > 0, `${line}: a non-empty identity`);
  }
  assert.ok(Object.isFrozen(APPROVED_ROLE_GRANTS));
});

// --- B. evaluateRuntimeLogin: the least-privilege facts -----------------------------------------------

const BASE_LOGIN = Object.freeze({
  canLogin: true, superuser: false, createRole: false, createDb: false, replication: false, bypassRls: false, inherit: true, ownRole: true,
});
const BASE_MEMBERSHIPS: readonly MembershipFacts[] = Object.freeze([
  Object.freeze({ role: 'tmpos_app', adminOption: false, inheritOption: true }),
  Object.freeze({ role: 'tmpos_audit_writer', adminOption: false, inheritOption: true }),
]);
const BASE_REACHED: readonly ReachedRoleFacts[] = Object.freeze([
  Object.freeze({ role: 'tmpos_app', canLogin: false, unsafeAttribute: false, marker: RUNTIME_PRIVILEGE_ROLES.tmpos_app }),
  Object.freeze({ role: 'tmpos_audit_writer', canLogin: false, unsafeAttribute: false, marker: RUNTIME_PRIVILEGE_ROLES.tmpos_audit_writer }),
]);
const BASE_FACTS: RuntimeLoginFacts = Object.freeze({
  login: BASE_LOGIN,
  memberships: BASE_MEMBERSHIPS,
  reached: BASE_REACHED,
  loginOwned: 0,
  rolesOwned: 0,
  roleMemberships: 0,
  foreignDependencies: 0,
  publicExposure: 0,
  loginGrants: Object.freeze([LEDGER_READ_GRANT]),
  roleGrants: APPROVED_ROLE_GRANTS,
  databaseCreate: false,
  databaseTemporary: false,
  schemaCreate: 0,
});

test('evaluateRuntimeLogin: the exact approved least-privilege facts clear every check', () => {
  assert.deepEqual(evaluateRuntimeLogin(BASE_FACTS), []);
});

test('evaluateRuntimeLogin: one targeted case per violation code', () => {
  const cases: Array<[RuntimeLoginViolation, RuntimeLoginFacts]> = [
    ['login_unknown', { ...BASE_FACTS, login: null }],
    ['login_cannot_login', { ...BASE_FACTS, login: { ...BASE_LOGIN, canLogin: false } }],
    ['login_superuser', { ...BASE_FACTS, login: { ...BASE_LOGIN, superuser: true } }],
    ['login_createrole', { ...BASE_FACTS, login: { ...BASE_LOGIN, createRole: true } }],
    ['login_createdb', { ...BASE_FACTS, login: { ...BASE_LOGIN, createDb: true } }],
    ['login_replication', { ...BASE_FACTS, login: { ...BASE_LOGIN, replication: true } }],
    ['login_bypassrls', { ...BASE_FACTS, login: { ...BASE_LOGIN, bypassRls: true } }],
    ['login_role_switched', { ...BASE_FACTS, login: { ...BASE_LOGIN, ownRole: false } }],
    ['login_owns_objects', { ...BASE_FACTS, loginOwned: 1 }],
    ['login_privilege_unexpected', { ...BASE_FACTS, loginGrants: [LEDGER_READ_GRANT, 'a|table|public.foo|SELECT'] }],
    ['login_ledger_read_missing', { ...BASE_FACTS, loginGrants: [] }],
    ['membership_missing', { ...BASE_FACTS, memberships: [BASE_MEMBERSHIPS[0]] }],
    ['membership_unexpected', { ...BASE_FACTS, memberships: [...BASE_MEMBERSHIPS, { role: 'extra_role', adminOption: false, inheritOption: true }] }],
    ['membership_admin_option', { ...BASE_FACTS, memberships: [{ ...BASE_MEMBERSHIPS[0], adminOption: true }, BASE_MEMBERSHIPS[1]] }],
    ['membership_not_inherited', { ...BASE_FACTS, memberships: [{ ...BASE_MEMBERSHIPS[0], inheritOption: false }, BASE_MEMBERSHIPS[1]] }],
    ['role_attribute_unsafe', { ...BASE_FACTS, reached: [{ ...BASE_REACHED[0], unsafeAttribute: true }, BASE_REACHED[1]] }],
    ['role_attribute_unsafe', { ...BASE_FACTS, reached: [{ ...BASE_REACHED[0], canLogin: true }, BASE_REACHED[1]] }],
    ['role_marker_invalid', { ...BASE_FACTS, reached: [{ ...BASE_REACHED[0], marker: 'wrong-marker' }, BASE_REACHED[1]] }],
    ['role_marker_invalid', { ...BASE_FACTS, reached: [{ ...BASE_REACHED[0], marker: null }, BASE_REACHED[1]] }],
    ['role_owns_objects', { ...BASE_FACTS, rolesOwned: 1 }],
    ['role_membership_unexpected', { ...BASE_FACTS, roleMemberships: 1 }],
    ['foreign_database_dependency', { ...BASE_FACTS, foreignDependencies: 1 }],
    ['public_privilege_unexpected', { ...BASE_FACTS, publicExposure: 1 }],
    ['role_privilege_unexpected', { ...BASE_FACTS, roleGrants: [...APPROVED_ROLE_GRANTS, 'tmpos_app|a|table|public.extra|SELECT'] }],
    ['database_create_privilege', { ...BASE_FACTS, databaseCreate: true }],
    ['database_temporary_privilege', { ...BASE_FACTS, databaseTemporary: true }],
    ['schema_create_privilege', { ...BASE_FACTS, schemaCreate: 1 }],
  ];
  for (const [code, facts] of cases) {
    assert.deepEqual(evaluateRuntimeLogin(facts), [code], `${code}: ${JSON.stringify(facts)}`);
  }
});

test('evaluateRuntimeLogin: inheritOption null falls back to login.inherit', () => {
  const membershipsWithNull = [{ ...BASE_MEMBERSHIPS[0], inheritOption: null }, BASE_MEMBERSHIPS[1]] as const;
  assert.deepEqual(evaluateRuntimeLogin({ ...BASE_FACTS, memberships: membershipsWithNull, login: { ...BASE_LOGIN, inherit: true } }), [],
    'null with login.inherit true reads as inherited');
  assert.deepEqual(
    evaluateRuntimeLogin({ ...BASE_FACTS, memberships: membershipsWithNull, login: { ...BASE_LOGIN, inherit: false } }),
    ['membership_not_inherited'],
    'null with login.inherit false reads as not inherited',
  );
});

test('evaluateRuntimeLogin: a missing role grant counts only for a role actually reached', () => {
  // tmpos_audit_writer is a direct membership (so membership_missing does not fire) but is not among the
  // REACHED roles here, and its grants are entirely absent from roleGrants; tmpos_app IS reached, and one of
  // its approved grants is missing too. Only the reached role's missing grant is reported.
  const tmposAppGrants = APPROVED_ROLE_GRANTS.filter((g) => g.startsWith('tmpos_app|'));
  const missingOneAppGrant = tmposAppGrants.slice(1); // drop the first tmpos_app grant
  assert.ok(missingOneAppGrant.length < tmposAppGrants.length && missingOneAppGrant.length > 0);
  const facts: RuntimeLoginFacts = {
    ...BASE_FACTS,
    reached: [BASE_REACHED[0]], // tmpos_audit_writer not reached
    roleGrants: missingOneAppGrant, // no tmpos_audit_writer grants at all, and one tmpos_app grant missing
  };
  assert.deepEqual(evaluateRuntimeLogin(facts), ['role_privilege_missing']);
});

test('evaluateRuntimeLogin: several violations at once are all collected, sorted and unique', () => {
  const facts: RuntimeLoginFacts = {
    ...BASE_FACTS,
    login: { ...BASE_LOGIN, superuser: true, createRole: true },
    databaseCreate: true,
  };
  assert.deepEqual(evaluateRuntimeLogin(facts), ['database_create_privilege', 'login_createrole', 'login_superuser'].sort());
});

// --- C. evaluateMigrationLedger: the exact chain -------------------------------------------------------

const GOLDEN_ROWS: readonly LedgerRowFacts[] = Object.freeze(
  REQUIRED_MIGRATIONS.map((m) => Object.freeze({ version: m.version, checksum: m.checksum, dirty: false, finished: true })),
);
const GOLDEN_LEDGER: LedgerFacts = Object.freeze({ present: true, readable: true, rows: GOLDEN_ROWS });

test('evaluateMigrationLedger: the exact required chain, clean and finished, clears every check', () => {
  assert.deepEqual(evaluateMigrationLedger(GOLDEN_LEDGER), []);
});

test('evaluateMigrationLedger: each ledger code', () => {
  const withRow = (index: number, patch: Partial<LedgerRowFacts>): LedgerFacts =>
    ({ present: true, readable: true, rows: GOLDEN_ROWS.map((r, i) => (i === index ? { ...r, ...patch } : r)) });
  const cases: Array<[LedgerViolation, LedgerFacts]> = [
    ['migration_ledger_missing', { present: false, readable: false, rows: [] }],
    ['migration_ledger_missing', { present: false, readable: true, rows: [] }],
    ['migration_ledger_unreadable', { present: true, readable: false, rows: [] }],
    ['migration_unknown', { present: true, readable: true, rows: [...GOLDEN_ROWS, { version: '023', checksum: 'f'.repeat(64), dirty: false, finished: true }] }],
    ['migration_dirty', withRow(0, { dirty: true })],
    ['migration_dirty', withRow(0, { finished: false })],
    ['migration_checksum_mismatch', withRow(0, { checksum: '0'.repeat(64) })],
    ['migration_checksum_mismatch', withRow(0, { checksum: 'not-a-checksum' })],
    ['migration_missing', { present: true, readable: true, rows: GOLDEN_ROWS.slice(0, -1) }], // 022 absent, above the newest recorded
    ['migration_not_contiguous', { present: true, readable: true, rows: GOLDEN_ROWS.filter((r) => r.version !== '007') }], // gap below 022
  ];
  for (const [code, facts] of cases) {
    assert.deepEqual(evaluateMigrationLedger(facts), [code], `${code}: ${JSON.stringify(facts)}`);
  }

  // A malformed row is skipped before it is recorded, so it necessarily also reads as a missing or
  // discontiguous chain: the code is present among the violations, never isolated from that consequence.
  for (const malformed of [
    { version: 1, checksum: GOLDEN_ROWS[0].checksum, dirty: false, finished: true },
    { version: '001', checksum: 1, dirty: false, finished: true },
    { version: '001', checksum: GOLDEN_ROWS[0].checksum, dirty: 'no', finished: true },
    { version: '001', checksum: GOLDEN_ROWS[0].checksum, dirty: false, finished: 0 },
  ]) {
    const violations = evaluateMigrationLedger({ present: true, readable: true, rows: [malformed] });
    assert.ok(violations.includes('migration_ledger_malformed'), JSON.stringify(malformed));
  }
  // The 22 required rows plus a second, clean, identical row for '022': the key no longer holds — malformed,
  // and nothing else (every required version is still recorded exactly once as far as the chain is concerned).
  assert.deepEqual(
    evaluateMigrationLedger({ present: true, readable: true, rows: [...GOLDEN_ROWS, GOLDEN_ROWS[GOLDEN_ROWS.length - 1]] }),
    ['migration_ledger_malformed'],
  );
});

// --- D. createPostgresStartupPreflight over a FAKE SupervisedPgClient (no database) ----------------------

type Row = Readonly<Record<string, unknown>>;
type QueryKind = 'connect' | 'login' | 'memberships' | 'reached' | 'owned' | 'grants' | 'database' | 'exposure' | 'ledgerAccess' | 'ledgerRows';

/** Which of the preflight's fixed statements `text` is, by a substring only that statement's text carries. */
function classify(text: string): QueryKind {
  if (text.includes('as connected')) return 'connect';
  // Checked before 'login': the reached-roles query also computes an unsafe_attribute from rolsuper et al.
  if (text.includes('unsafe_attribute')) return 'reached';
  if (text.includes('own_role')) return 'login';
  if (text.includes('admin_option')) return 'memberships';
  if (text.includes('login_owned')) return 'owned';
  if (text.includes('public_exposure')) return 'exposure';
  if (text.includes('is_login')) return 'grants';
  if (text.includes('database_create')) return 'database';
  if (text.includes('has_table_privilege')) return 'ledgerAccess';
  if (text.includes('finished_at')) return 'ledgerRows';
  throw new Error(`fakeClient: unrecognized statement: ${text.slice(0, 120)}`);
}

const GOLDEN_LOGIN_ROW: Row = Object.freeze({
  rolcanlogin: true, rolsuper: false, rolcreaterole: false, rolcreatedb: false, rolreplication: false, rolbypassrls: false,
  rolinherit: true, own_role: true,
});
const GOLDEN_MEMBERSHIP_ROWS: readonly Row[] = Object.freeze([
  Object.freeze({ role: 'tmpos_app', admin_option: false, inherit_option: 'true' }),
  Object.freeze({ role: 'tmpos_audit_writer', admin_option: false, inherit_option: 'true' }),
]);
const GOLDEN_REACHED_ROWS: readonly Row[] = Object.freeze([
  Object.freeze({ role: 'tmpos_app', rolcanlogin: false, unsafe_attribute: false, marker: RUNTIME_PRIVILEGE_ROLES.tmpos_app }),
  Object.freeze({ role: 'tmpos_audit_writer', rolcanlogin: false, unsafe_attribute: false, marker: RUNTIME_PRIVILEGE_ROLES.tmpos_audit_writer }),
]);
const GOLDEN_OWNED_ROW: Row = Object.freeze({ login_owned: 0, roles_owned: 0, role_memberships: 0, foreign_dependencies: 0 });
const GOLDEN_EXPOSURE_ROW: Row = Object.freeze({ public_exposure: 0 });
const GOLDEN_GRANT_ROWS: readonly Row[] = Object.freeze([
  Object.freeze({ is_login: true, role: 'runtime_login', kind: 'a', type: 'table', identity: 'public.schema_migrations', privileges: 'SELECT' }),
  ...APPROVED_ROLE_GRANTS.map((line) => {
    const [role, kind, type, identity, privileges] = line.split('|');
    return Object.freeze({ is_login: false, role, kind, type, identity, privileges: privileges === '' ? null : privileges });
  }),
]);
const GOLDEN_DATABASE_ROW: Row = Object.freeze({ database_create: false, database_temporary: false, schema_create: 0 });
const GOLDEN_LEDGER_ACCESS_ROW: Row = Object.freeze({ present: true, readable: true });
const GOLDEN_LEDGER_ROW_ROWS: readonly Row[] = Object.freeze(
  REQUIRED_MIGRATIONS.map((m) => Object.freeze({ version: m.version, checksum: m.checksum, dirty: false, finished: true })),
);
const GOLDEN: Readonly<Record<QueryKind, readonly Row[]>> = Object.freeze({
  connect: Object.freeze([Object.freeze({ connected: 1 })]),
  login: Object.freeze([GOLDEN_LOGIN_ROW]),
  memberships: GOLDEN_MEMBERSHIP_ROWS,
  reached: GOLDEN_REACHED_ROWS,
  owned: Object.freeze([GOLDEN_OWNED_ROW]),
  exposure: Object.freeze([GOLDEN_EXPOSURE_ROW]),
  grants: GOLDEN_GRANT_ROWS,
  database: Object.freeze([GOLDEN_DATABASE_ROW]),
  ledgerAccess: Object.freeze([GOLDEN_LEDGER_ACCESS_ROW]),
  ledgerRows: GOLDEN_LEDGER_ROW_ROWS,
});

/** A FAKE SupervisedPgClient: `script` overrides one or more of the preflight's fixed statements. */
function fakeClient(script: Partial<Record<QueryKind, readonly Row[] | Error>> = {}): { client: SupervisedPgClient; boundsSeen: TransactionBounds[] } {
  const boundsSeen: TransactionBounds[] = [];
  const asked: QueryKind[] = [];
  const sql = Object.assign(
    async (strings: TemplateStringsArray, ..._values: unknown[]): Promise<readonly Row[]> => {
      const kind = classify(strings.join('$'));
      asked.push(kind);
      const answer = script[kind] ?? GOLDEN[kind];
      if (answer instanceof Error) throw answer;
      return answer;
    },
    { json: (v: unknown) => v },
  );
  const client: SupervisedPgClient = Object.freeze({
    transaction: async <T>(_signal: AbortSignal, bounds: TransactionBounds, work: (sql: PgTransactionScope) => Promise<T>): Promise<T> => {
      boundsSeen.push(bounds);
      return work(sql as unknown as PgTransactionScope);
    },
    end: async (): Promise<void> => undefined,
  });
  return { client, boundsSeen };
}

test('connect: uses PREFLIGHT_BOUNDS and throws on a wrong answer', async () => {
  const { client, boundsSeen } = fakeClient();
  const preflight = createPostgresStartupPreflight({ client });
  await preflight.connect(new AbortController().signal);
  assert.deepEqual(boundsSeen, [PREFLIGHT_BOUNDS]);

  for (const bad of [
    fakeClient({ connect: [{ connected: 0 }] }),
    fakeClient({ connect: [] }),
    fakeClient({ connect: [{ connected: '1' }] }),
    fakeClient({ connect: { not: 'an array' } as unknown as Row[] }),
  ]) {
    await assert.rejects(() => createPostgresStartupPreflight({ client: bad.client }).connect(new AbortController().signal));
  }
  // A database-level failure (a rejection from the client, never caught by connect) also throws.
  const failing = fakeClient({ connect: new Error('connection refused') });
  await assert.rejects(() => createPostgresStartupPreflight({ client: failing.client }).connect(new AbortController().signal), /connection refused/);
});

test('runtimeLogin: over the golden facts, uses PREFLIGHT_BOUNDS, and answers []', async () => {
  const { client, boundsSeen } = fakeClient();
  const preflight = createPostgresStartupPreflight({ client });
  const violations = await preflight.runtimeLogin(new AbortController().signal);
  assert.deepEqual(violations, []);
  assert.deepEqual(boundsSeen, [PREFLIGHT_BOUNDS]);
});

test('runtimeLogin: a non-boolean or negative-count answer throws', async () => {
  const cases: Array<Partial<Record<QueryKind, readonly Row[]>>> = [
    { login: [{ ...GOLDEN_LOGIN_ROW, rolcanlogin: 'true' }] }, // non-boolean
    { login: [{ ...GOLDEN_LOGIN_ROW, rolsuper: 1 }] },
    { owned: [{ ...GOLDEN_OWNED_ROW, login_owned: -1 }] }, // negative count
    { owned: [{ ...GOLDEN_OWNED_ROW, roles_owned: -1 }] },
    { owned: [{ ...GOLDEN_OWNED_ROW, login_owned: 'zero' }] }, // non-numeric count
    { owned: [{ ...GOLDEN_OWNED_ROW, login_owned: 1.5 }] }, // not a safe integer
    { owned: [{ ...GOLDEN_OWNED_ROW, role_memberships: -1 }] },
    { owned: [{ ...GOLDEN_OWNED_ROW, foreign_dependencies: -1 }] },
    { exposure: [{ public_exposure: -1 }] },
    { database: [{ ...GOLDEN_DATABASE_ROW, schema_create: -1 }] },
    { grants: [{ is_login: true, role: 'x', kind: 'a', type: 'table', identity: 'public.schema_migrations', privileges: 42 }] },
  ];
  for (const script of cases) {
    const { client } = fakeClient(script);
    await assert.rejects(() => createPostgresStartupPreflight({ client }).runtimeLogin(new AbortController().signal),
      /preflight_answer_invalid/, JSON.stringify(script));
  }
});

test('migrationLedger: over the golden facts, uses PREFLIGHT_BOUNDS, and answers []', async () => {
  const { client, boundsSeen } = fakeClient();
  const preflight = createPostgresStartupPreflight({ client });
  const violations = await preflight.migrationLedger(new AbortController().signal);
  assert.deepEqual(violations, []);
  assert.deepEqual(boundsSeen, [PREFLIGHT_BOUNDS]);
});

test('migrationLedger: reads the ledger rows only when the relation is present and readable', async () => {
  const never = new Error('rows must never be queried when the relation is absent or unreadable');
  for (const access of [{ present: false, readable: false }, { present: false, readable: true }]) {
    const { client } = fakeClient({ ledgerAccess: [access], ledgerRows: never });
    const violations = await createPostgresStartupPreflight({ client }).migrationLedger(new AbortController().signal);
    assert.deepEqual(violations, ['migration_ledger_missing']);
  }
  const { client } = fakeClient({ ledgerAccess: [{ present: true, readable: false }], ledgerRows: never });
  const violations = await createPostgresStartupPreflight({ client }).migrationLedger(new AbortController().signal);
  assert.deepEqual(violations, ['migration_ledger_unreadable']);
});

// --- M7A-CUSTOMERS-P2 — the parameter-logging guard (the tenant entry's) ------------------------------------------------

/** The defaults of a PostgreSQL 16 server, as current_setting renders them, with neither module loaded. */
const SAFE_LOGGING: ParameterLoggingFacts = Object.freeze({
  onError: '0', maxLength: '-1', statement: 'none', minDuration: '-1', minSample: '-1', sampleRate: '0', printPlan: 'off',
  aeMinDuration: null, pgaParameter: null, pgaLog: null,
});

test('M7TL-01 evaluateParameterLogging: the safe defaults pass, and each setting that would log a bound parameter is named alone', () => {
  assert.deepEqual(evaluateParameterLogging(SAFE_LOGGING), []);
  const cases: Array<[string, Partial<ParameterLoggingFacts>, string[]]> = [
    ['parameters on an error, with units', { onError: '64B' }, ['log_parameter_max_length_on_error']],
    ['parameters on an error, unlimited', { onError: '-1' }, ['log_parameter_max_length_on_error']],
    ['mod statements logged with their parameters', { statement: 'mod' }, ['log_statement']],
    ['every statement logged', { statement: 'all' }, ['log_statement']],
    ['statements over a duration', { minDuration: '0' }, ['log_min_duration_statement']],
    ['statements over a duration, with units', { minDuration: '250ms' }, ['log_min_duration_statement']],
    ['sampled statements', { minSample: '250ms' }, ['log_min_duration_sample']],
    ['sampled transactions', { sampleRate: '0.01' }, ['log_transaction_sample_rate']],
    ['plans printed', { printPlan: 'on' }, ['debug_print_plan']],
    ['auto_explain logging every plan', { aeMinDuration: '0' }, ['auto_explain_parameters']],
    ['auto_explain over a duration, with units', { aeMinDuration: '250ms' }, ['auto_explain_parameters']],
    ['pgaudit logging reads with parameters', { pgaParameter: 'on', pgaLog: 'read' }, ['pgaudit_parameters']],
    ['pgaudit logging writes with parameters', { pgaParameter: 'on', pgaLog: 'ddl, write' }, ['pgaudit_parameters']],
    ['pgaudit logging everything with parameters', { pgaParameter: 'on', pgaLog: 'ALL' }, ['pgaudit_parameters']],
    ['pgaudit logging routine calls with parameters', { pgaParameter: 'on', pgaLog: 'function' }, ['pgaudit_parameters']],
    ['pgaudit with no readable class list', { pgaParameter: 'on', pgaLog: null }, ['pgaudit_parameters']],
    // Object auditing (pgaudit.role) logs statements, those inside routines included, with their parameters whatever
    // pgaudit.log names — so parameters on refuses even with no session class logged (the chair's R-A').
    ['pgaudit with parameters on and no session class', { pgaParameter: 'on', pgaLog: 'none' }, ['pgaudit_parameters']],
    ['pgaudit with parameters on and only unparameterized classes', { pgaParameter: 'on', pgaLog: 'ddl, role, misc' }, ['pgaudit_parameters']],
    ['pgaudit with parameters on, every class subtracted', { pgaParameter: 'on', pgaLog: '-read' }, ['pgaudit_parameters']],
    ['pgaudit with parameters in another spelling', { pgaParameter: 'true', pgaLog: 'none' }, ['pgaudit_parameters']],
  ];
  for (const [label, over, expected] of cases) assert.deepEqual(evaluateParameterLogging({ ...SAFE_LOGGING, ...over }), expected, label);
  // Every statement setting at once is named in full, in a fixed order.
  assert.deepEqual(evaluateParameterLogging({ ...SAFE_LOGGING, onError: '64B', statement: 'all', minDuration: '0', minSample: '0', sampleRate: '1',
    printPlan: 'on', aeMinDuration: '0', pgaParameter: 'on', pgaLog: 'all' }), ['auto_explain_parameters', 'debug_print_plan',
    'log_min_duration_sample', 'log_min_duration_statement', 'log_parameter_max_length_on_error', 'log_statement', 'log_transaction_sample_rate',
    'pgaudit_parameters']);
});

test('M7TL-02 evaluateParameterLogging: log_parameter_max_length 0 makes statement logging safe; auto_explain\'s own length and pgaudit\'s class list do not', () => {
  // A logged statement carries no parameter when their length is 0 — but an error still does, and so does a plan.
  assert.deepEqual(evaluateParameterLogging({ ...SAFE_LOGGING, maxLength: '0', statement: 'all', minDuration: '0', minSample: '0', sampleRate: '1' }), []);
  assert.deepEqual(evaluateParameterLogging({ ...SAFE_LOGGING, maxLength: '0', onError: '64B' }), ['log_parameter_max_length_on_error']);
  assert.deepEqual(evaluateParameterLogging({ ...SAFE_LOGGING, maxLength: '0', printPlan: 'on' }), ['debug_print_plan']);
  assert.deepEqual(evaluateParameterLogging({ ...SAFE_LOGGING, maxLength: '64B', statement: 'mod' }), ['log_statement'], 'a nonzero length');
  assert.deepEqual(evaluateParameterLogging({ ...SAFE_LOGGING, statement: 'ddl' }), [], 'DDL takes no bound parameter');
  // auto_explain folds parameter values into the plan text itself: its parameter length does not govern that (the chair's A1).
  assert.deepEqual(evaluateParameterLogging({ ...SAFE_LOGGING, aeMinDuration: '0', maxLength: '0' }), ['auto_explain_parameters'], 'ae_min 0 with ae_params 0');
  assert.deepEqual(evaluateParameterLogging({ ...SAFE_LOGGING, aeMinDuration: '-1' }), [], 'auto_explain loaded, logging nothing');
  // pgaudit loaded with parameters off passes whatever pgaudit.log says; absent (not installed) passes.
  for (const [pgaParameter, pgaLog] of [['off', 'all'], ['off', 'none'], ['off', null], [null, 'all'], [null, null]]) {
    assert.deepEqual(evaluateParameterLogging({ ...SAFE_LOGGING, pgaParameter, pgaLog }), [], `${String(pgaParameter)} / ${String(pgaLog)}`);
  }
});

test('M7TL-03 evaluateParameterLogging: a core setting not answered as text is unreadable, never a pass', () => {
  for (const key of ['onError', 'maxLength', 'statement', 'minDuration', 'minSample', 'sampleRate', 'printPlan'] as const) {
    for (const value of [null, undefined, 0, false]) {
      assert.deepEqual(evaluateParameterLogging({ ...SAFE_LOGGING, [key]: value }), ['log_setting_unreadable'], `${key}: ${String(value)}`);
    }
  }
});

test('M7TL-04 parameterLogging: one statement under PREFLIGHT_BOUNDS reads the ten settings as the login\'s sessions run with them, and no value leaves', async () => {
  const boundsSeen: TransactionBounds[] = [];
  const texts: string[] = [];
  let row: Record<string, unknown> = {
    on_error: '0', max_length: '-1', statement: 'none', min_duration: '-1', min_sample: '-1', sample_rate: '0', print_plan: 'off',
    ae_min_duration: null, pga_parameter: null, pga_log: null,
  };
  const sql = Object.assign(async (strings: TemplateStringsArray, ...values: unknown[]): Promise<readonly Row[]> => {
    texts.push(strings.join('$'));
    assert.equal(values.length, 0, 'the statement binds nothing');
    return [row];
  }, { json: (v: unknown) => v });
  const client: SupervisedPgClient = Object.freeze({
    transaction: async <T>(_signal: AbortSignal, bounds: TransactionBounds, work: (s: PgTransactionScope) => Promise<T>): Promise<T> => {
      boundsSeen.push(bounds);
      return work(sql as unknown as PgTransactionScope);
    },
    end: async (): Promise<void> => undefined,
  });
  const preflight = createPostgresStartupPreflight({ client });
  assert.deepEqual(await preflight.parameterLogging(new AbortController().signal), []);
  assert.deepEqual(boundsSeen, [PREFLIGHT_BOUNDS]);
  assert.equal(texts.length, 1);
  for (const name of ['log_parameter_max_length_on_error', 'log_parameter_max_length', 'log_statement', 'log_min_duration_statement',
    'log_min_duration_sample', 'log_transaction_sample_rate', 'debug_print_plan', 'auto_explain.log_min_duration', 'pgaudit.log_parameter', 'pgaudit.log']) {
    assert.ok(texts[0].includes(`pg_catalog.current_setting('${name}', true)`), `reads ${name}, missing_ok`);
  }
  row = { ...row, on_error: 'M7TL-MARKER-64B', ae_min_duration: '0' };
  const named = await preflight.parameterLogging(new AbortController().signal);
  assert.deepEqual(named, ['auto_explain_parameters', 'log_parameter_max_length_on_error']);
  assert.ok(!JSON.stringify(named).includes('M7TL-MARKER'), 'a setting\'s name, never its value');
  // No row is a question the database did not answer: a throw, never a pass.
  const none = Object.assign(async (): Promise<readonly Row[]> => [], { json: (v: unknown) => v });
  const empty = createPostgresStartupPreflight({ client: {
    ...client,
    transaction: async <T>(_signal: AbortSignal, _bounds: TransactionBounds, work: (s: PgTransactionScope) => Promise<T>): Promise<T> =>
      work(none as unknown as PgTransactionScope),
  } });
  await assert.rejects(() => empty.parameterLogging(new AbortController().signal), /preflight_answer_invalid/);
});
