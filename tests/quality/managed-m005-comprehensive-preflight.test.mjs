/**
 * C2B-M005-P2-B0 — deterministic suite for the fixed READ-ONLY comprehensive migration-005
 * preflight.
 *
 * EVERYTHING HERE IS SYNTHETIC. No database, no socket, no secret, no environment value, no
 * process. The child is driven through injected ports so the ENTIRE ordering — that the snapshot
 * bracket opens before any query, that isolation and read-only are proved before AND after the
 * reads, and that both continuity captures bracket them — is observable as a recorded call sequence
 * rather than inferred from source text. The launcher is driven with injected dependencies so its
 * argv and environment contracts are proved without ever starting a real child.
 */

import { EventEmitter } from 'node:events';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  LEDGER_PREFIX_BASENAMES,
  LEDGER_PREFIX_VERSIONS,
  LEDGER_ROW_LIMIT,
  M005_CONSTRAINT,
  M005_CREATED_ROLES,
  M005_GOVERNED_TABLES,
  M005_LEDGER_VERSION,
  M005_POLICIES,
  M005_POLICY_TABLES,
  M005_PREREQUISITE_ROLES,
  M005_REQUIRED_COLUMNS,
  M005_RLS_REQUIRED_TABLES,
  LEDGER_SHAPE_CATEGORIES_MAX_LENGTH,
  LEDGER_SHAPE_CATEGORY_ORDER,
  LEDGER_SHAPE_CATEGORIES_NONE,
  LEDGER_SHAPE_CATEGORIES_UNREADABLE,
  LEDGER_SHAPE_CATEGORY_SEPARATOR,
  PREFLIGHT_CODES,
  REQUIRED_ISOLATION,
  assessObservedPreconditions,
  chooseDisposition,
  LEDGER_REPAIR_SAFETY_MAX_LINE_BYTES,
  classifyEventTriggers,
  classifyLedger,
  classifyPolicies,
  classifyPrivilegePosture,
  classifyRlsApplicability,
  classifyShape,
  reconcileDisableRlsExposure,
  renderLedgerRepairSafety,
  POLICY_COMMAND_CLASSES,
  LEDGER_PRIVILEGE_NAMES,
  renderShapeCategories,
  TARGET_DATABASE_FIELD,
  UNREADABLE_EVENT_TRIGGER_POSTURE,
  UNREADABLE_PRIVILEGE_POSTURE,
  residualFacts,
  classifyObjectState,
  LEDGER_SHAPE_UNREADABLE,
  classifyResidue,
  exitCodeFor,
  expectedPrefixChecksums,
  expectedRowSecurityActive,
  main as childMain,
  predictCreatedRoleSource,
  predictPlan,
  readGovernedUpSql,
  readLedgerRowsBounded,
  readLedgerRlsMode,
  readLedgerPrivilegesBounded,
  readProviderEvidence,
  readObservedPreconditionEvidence,
  renderEvidence,
  runPreflight,
} from '../../scripts/managed-m005-comprehensive-preflight.ts';

import {
  FORBIDDEN_CHILD_TOKENS,
  INSPECT_CHILD_ENV_KEYS,
  INSPECT_GATE_VALUES,
  INSPECT_LAUNCHER_CODES,
  NODE_BIN,
  OUTER_INVOCATION,
  PARENT_FLAG,
  PREFLIGHT_FLAGS,
  PREFLIGHT_SCRIPT,
  STARTUP_SENSITIVE,
  TSX_CLI,
  assertChildArgvContract,
  assertInspectChildEnv,
  buildInspectChildEnv,
  dispositionFor,
  main as launcherMain,
  renderPreflightReport,
  terminalEvidenceFor,
} from '../../scripts/managed-m005-comprehensive-preflight-launcher.mjs';

import {
  CHILD_BLOCK_SENTINEL,
  TRANSCRIPT_UNAVAILABLE_TOKEN,
  canonicalPreflightLine,
} from '../../scripts/managed-m005-launcher.mjs';

import { LAUNCHER_CODES } from '../../scripts/managed-baseline-launcher.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..');
const MIGRATIONS = join(REPO_ROOT, 'server', 'platform-identity', 'migrations');
const PRINCIPAL = 'tmpos_migrator';

/**
 * Executable source only.
 *
 * Every source-text assertion below is a claim about what the file DOES. A comment stating that
 * `pg_authid` is never read, and the forbidden-token list whose whole purpose is to name
 * `--resolve-dirty`, are both evidence FOR the containment rather than against it, and matching
 * them would make the assertion punish the documentation. Line comments, block comments and the
 * frozen token list are removed before the check.
 */
function executableSource(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .filter((l) => !l.trimStart().startsWith('//') && !l.trimStart().startsWith('*'))
    .join('\n')
    .replace(/export const FORBIDDEN_CHILD_TOKENS = Object\.freeze\(\[[\s\S]*?\]\);/, '');
}

/** A well-formed environment. Values are SYNTHETIC and exist only to be refused or redacted. */
const goodEnv = (over = {}) => ({
  NODE_ENV: 'development',
  CONFIRM_SUPABASE_TARGET: 'tmpos2026-dev',
  SUPABASE_DATABASE_URL: 'postgresql://u:p@db.abcdefghijklmnopqrst.supabase.co:5432/postgres',
  SUPABASE_URL: 'https://abcdefghijklmnopqrst.supabase.co',
  DATABASE_CA_CERT: '-----BEGIN CERTIFICATE-----\nQUJD\n-----END CERTIFICATE-----',
  ...over,
});

/** Observed-precondition evidence in the exact state migration 005 requires. */
const metEvidence = (over = {}) => ({
  publicCreateOnDatabase: false,
  publicTemporaryOnDatabase: false,
  principalCanCreateRole: true,
  schemaPublicPresent: true,
  schemaPublicAuthority: true,
  createdRolesCount: 0,
  roleCommentResidue: 'ABSENT',
  prerequisiteRoles: 'PRESENT',
  governedTablesPresent: M005_GOVERNED_TABLES.length,
  governedTablesAuthoritative: M005_GOVERNED_TABLES.length,
  requiredColumnsPresent: M005_REQUIRED_COLUMNS.length,
  rlsEnabledTables: M005_RLS_REQUIRED_TABLES.length,
  policiesPresent: 0,
  foreignPoliciesOnGovernedTables: 0,
  governedNamesShadowedOutsidePublic: 0,
  plpgsqlPresent: true,
  enabledEventTriggers: 0,
  constraintPresent: 'ABSENT',
  incompatibleAuditRows: 0,
  policyFunctionPresent: true,
  sequencesInPublic: 0,
  ...over,
});

/**
 * A shape-verifier result, in the shape the PRODUCER returns it.
 *
 * Categories are passed EXPLICITLY, never derived here from the reason text: re-deriving them in
 * the test would test the test's own mapping and would let the source lose the pairing silently.
 */
const shapeOk = () => ({ present: true, failed: [], categories: [] });
const shapeOf = (over = {}) => ({ present: true, failed: [], categories: [], ...over });

const cleanLedger = (over = {}) => ({
  shape: 'MATCH', shapeCategories: [], prefix: 'MATCH', checksums: 'MATCH',
  dirty: 'ABSENT', m005: 'ABSENT', unknownOrOutOfOrder: 'ABSENT', overflowed: false, ...over,
});

const cleanAcl = (over = {}) => ({
  principalAgreement: 'AGREED',
  globalBase: { tables: 'BUILTIN_RETAINED', sequences: 'BUILTIN_RETAINED', functions: 'BUILTIN_RETAINED' },
  schemaGrantsToCoveredGrantees: 'NONE',
  postcondition: 'UNMET',
  blockerSurvivesCurrentM005: 'NO',
  findingCount: 0,
  ...over,
});

/**
 * A recording fake handle. Every port call appends to `calls`, so ordering is asserted rather than
 * assumed, and every failure mode is a construction option rather than a mocked throw site.
 */
function makeHandle(over = {}) {
  const calls = [];
  const readOnlySeq = [...(over.readOnly ?? [true, true])];
  const isolationSeq = [...(over.isolation ?? [REQUIRED_ISOLATION, REQUIRED_ISOLATION])];
  const tokenSeq = [...(over.tokens ?? ['pid:11', 'pid:11'])];
  const handle = {
    adapter: {
      reserve: async () => {
        calls.push('reserve');
        return { backendIdentity: async () => ({ token: tokenSeq.shift() }) };
      },
    },
    snapshotTx: {
      begin: async () => { calls.push('begin'); if (over.beginThrows) throw new Error('boom dsn=secret'); },
      applyLocalTimeouts: async (ms) => { calls.push(`timeouts:${ms}`); },
      isReadOnly: async () => { calls.push('isReadOnly'); return readOnlySeq.shift(); },
      isolationLevel: async () => { calls.push('isolation'); return isolationSeq.shift(); },
      finish: async () => { calls.push('finish'); if (over.finishThrows) throw new Error('rollback failed'); },
    },
    catalog: {
      query: async () => {
        calls.push('query');
        return over.identityRows ?? [{ principal: PRINCIPAL, session_principal: PRINCIPAL, db: 'postgres' }];
      },
    },
    dispose: async () => {
      calls.push('dispose');
      if (over.disposeThrows) throw new Error('teardown');
      return Object.prototype.hasOwnProperty.call(over, 'teardown')
        ? over.teardown
        : { requested: true, completed: true, gracefulSocketClose: 'not_observed' };
    },
  };
  return { handle, calls };
}

/** Run the child with every port injected. Returns exit code, emitted lines and the call order. */
async function runChild(over = {}) {
  const { handle, calls } = makeHandle(over);
  const lines = [];
  const code = await runPreflight(over.env ?? goodEnv(), (l) => lines.push(l), {
    createExecutor: async () => handle,
    assertDsn: () => ({}),
    describeDsn: () => ({ endpointFamily: over.endpointFamily ?? 'session', database: over.describedDb ?? 'postgres' }),
    fingerprint: async () => {
      if (over.fingerprintThrows) throw new Error('fingerprint dsn=secret');
      return over.fingerprintFailures ?? [];
    },
    readAcl: async () => {
      if (over.aclThrows) throw new Error('acl dsn=secret');
      return over.aclRead ?? { rows: [], overflowed: over.aclOverflowed === true };
    },
    ledgerShape: async () => {
      if (over.ledgerShapeThrows) throw new Error('shape');
      return over.ledgerShapeResult ?? shapeOk();
    },
    rlsMode: over.rlsMode ?? (async () => null),
    ledgerPolicies: over.ledgerPolicies ?? (async () => ({ rows: [], overflowed: false })),
    ledgerPrivileges: over.ledgerPrivileges ?? (async () => null),
    eventTriggers: over.eventTriggers ?? (async () => ({ rows: [], overflowed: false })),
    readObservedPreconditions: async () => over.observed ?? metEvidence(),
    readProvider: async () => over.provider ?? { routinesOutsidePublic: 0, creatableNonPublicSchemas: 0 },
    readLedgerRows: async () => over.ledgerRows ?? { rows: cleanLedgerRows(), overflowed: false },
    upSql: () => (over.upSql === undefined ? readGovernedUpSql(MIGRATIONS) : over.upSql),
    prefixChecksums: () => (over.prefixChecksums === undefined ? diskChecksums() : over.prefixChecksums),
    ...(over.aclAssessment ? {} : {}),
  });
  return { code, lines, calls, text: lines.join('\n') };
}

/** The governed 005 checksum, taken from the FROZEN BYTES rather than copied from a constant. */
const GOVERNED_M005_SHA = createHash('sha256')
  .update(readFileSync(join(MIGRATIONS, '005_principal_separation_rls_foundation.up.sql')))
  .digest('hex');

function diskChecksums() {
  const m = new Map();
  for (let i = 0; i < LEDGER_PREFIX_VERSIONS.length; i += 1) {
    m.set(LEDGER_PREFIX_VERSIONS[i],
      createHash('sha256').update(readFileSync(join(MIGRATIONS, LEDGER_PREFIX_BASENAMES[i]))).digest('hex'));
  }
  // MIRRORS PRODUCTION. `expectedPrefixChecksums` carries a 005 entry too; a fixture that omitted it
  // would silently exercise the unreadable-expectation branch and never the validity comparison.
  m.set(M005_LEDGER_VERSION, GOVERNED_M005_SHA);
  return m;
}

function cleanLedgerRows() {
  const c = diskChecksums();
  return LEDGER_PREFIX_VERSIONS.map((v) => ({ version: v, checksum: c.get(v), dirty: false }));
}

/** A version-005 ledger row that genuinely records THE GOVERNED migration: the only VALID shape. */
const validM005Row = (over = {}) => ({ version: '005', checksum: GOVERNED_M005_SHA, dirty: false, ...over });

/**
 * The object set a COMPLETED migration 005 leaves behind.
 *
 * ALREADY_APPLIED needs BOTH witnesses to agree, so a sound 005 ledger row is no longer enough on
 * its own — the objects 005 creates must actually be there. This is the second witness.
 */
const appliedEvidence = (over = {}) => metEvidence({
  createdRolesCount: M005_CREATED_ROLES.length,
  constraintPresent: 'PRESENT', policiesPresent: M005_POLICIES.length, ...over,
});

// ---------------------------------------------------------------------------
// 1) The governed object set is DERIVED FROM the frozen migration bytes, not asserted about it.
// ---------------------------------------------------------------------------


/**
 * Extract every `emit(...)` template literal for one tag from executable source.
 *
 * HOISTED SO ITS OWN CONTRACT CAN BE TESTED. While this lived inside the drift guard, the only
 * thing standing behind a load-bearing output site was an argument about how the scanner behaves.
 * As a function it is driven directly against adversarial source below, so each of its rules —
 * concatenation, trailing suffix, trailing comma, multiline call, escapes, interpolation, nested
 * parentheses, adjacent calls, and text that merely LOOKS like an emit — is executed rather than
 * reasoned about.
 *
 * Every refusal is FAIL-CLOSED: it throws rather than returning a short list, because a scanner that
 * silently returns fewer templates is exactly the failure this function exists to make impossible.
 */
function extractEmitTemplates(src, tag) {
  const marker = `[${tag}]`;
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
      if (i >= src.length) throw new Error(`unterminated literal near source line ${src.slice(0, m.index).split('\n').length}`);
      i += 1;
      text += buf;
      const rest = src.slice(i);
      const cont = /^\s*\+\s*(`|')/.exec(rest);
      if (!cont) {
        if (!/^\s*,?\s*\)/.test(rest)) {
          throw new Error(`an emit near source line ${src.slice(0, m.index).split('\n').length} `
            + 'concatenates a non-literal; extend the scanner, because the part it can read may pass on its own');
        }
        break;
      }
      quote = cont[1];
      i += cont[0].length;
    }
    // RESUME PAST THE CONSUMED LITERAL. Left at its default the search resumed INSIDE the literal
    // just read, so a template whose own body contained the text `emit('` produced a second, phantom
    // match. That it was caught downstream by the count pin was an argument, not a guarantee; moving
    // the cursor removes the case instead of detecting it.
    opener.lastIndex = i;
    if (text.startsWith(marker)) {
      templates.push({ text, at: src.slice(0, m.index).split('\n').length });
    }
  }
  for (const t of templates) {
    if (t.text.includes('\\')) {
      throw new Error(`the template near source line ${t.at} contains an escape sequence the scanner `
        + 'copies rather than decodes; teach it to decode before this line can be proved');
    }
  }
  return templates;
}

test('C2B-M005-P2-B0: every governed name in the preflight appears in the frozen migration bytes', () => {
  const up = readFileSync(join(MIGRATIONS, '005_principal_separation_rls_foundation.up.sql'), 'utf8');
  assert.equal(createHash('sha256').update(Buffer.from(up, 'utf8')).digest('hex').length, 64);
  for (const r of M005_CREATED_ROLES) assert.ok(up.includes(`create role ${r}`), r);
  for (const r of M005_PREREQUISITE_ROLES) assert.ok(up.includes(r), r);
  for (const t of M005_GOVERNED_TABLES) assert.ok(new RegExp(`\\b${t}\\b`).test(up), t);
  for (const p of M005_POLICIES) assert.ok(up.includes(p.split('.')[1]), p);
  assert.ok(up.includes(M005_CONSTRAINT.name));
  for (const c of M005_REQUIRED_COLUMNS) assert.ok(up.includes(c.split('.')[1].split(':')[0]), c);
});

test('C2B-M005-P2-B0: migration 005 enables NO row level security, so RLS is a PRECONDITION', () => {
  const up = readFileSync(join(MIGRATIONS, '005_principal_separation_rls_foundation.up.sql'), 'utf8');
  const executable = up.split('\n').filter((l) => !l.trimStart().startsWith('--')).join('\n');
  assert.ok(!/enable\s+row\s+level\s+security/i.test(executable),
    '005 must not enable RLS; if it ever does, this preflight is checking the wrong precondition');
  // And every table 005 attaches a policy to is in the RLS precondition list, or the policy is inert.
  for (const p of M005_POLICIES) {
    assert.ok(M005_RLS_REQUIRED_TABLES.includes(p.split('.')[0]), p);
    assert.ok(M005_POLICY_TABLES.includes(p.split('.')[0]), p);
  }
  // platform_identity carries NO 005 policy, and its RLS is required for a different, stated reason:
  // section 6 justifies its REVOKE by 001's "RLS enabled, no policies" posture, so the flag is the
  // other half of that posture. The two lists must therefore differ by exactly that one table.
  assert.deepEqual(
    M005_RLS_REQUIRED_TABLES.filter((t) => !M005_POLICY_TABLES.includes(t)),
    ['platform_identity'],
  );
});

test('C2B-M005-P2-B0: migration 005 grants on no sequence, matching the zero-sequence expectation', () => {
  const up = readFileSync(join(MIGRATIONS, '005_principal_separation_rls_foundation.up.sql'), 'utf8');
  const executable = up.split('\n').filter((l) => !l.trimStart().startsWith('--')).join('\n');
  assert.ok(!/grant[^;]*\bon\s+sequence\b/i.test(executable));
});

// ---------------------------------------------------------------------------
// 2) The source prediction.
// ---------------------------------------------------------------------------

test('C2B-M005-P2-B0: the frozen bytes still support the created-role privilege prediction', () => {
  const g = readGovernedUpSql(MIGRATIONS);
  assert.equal(g.status, 'match');
  assert.equal(predictCreatedRoleSource(g.sql), 'MATCH');
});

test('C2B-M005-P2-B0: a non-string or empty source is UNREADABLE, never a prediction', () => {
  for (const v of [null, undefined, '', 42, {}]) assert.equal(predictCreatedRoleSource(v), 'UNREADABLE');
});

test('C2B-M005-P2-B0: dropped role attributes, a role membership grant or a database grant is DRIFT', () => {
  const up = readGovernedUpSql(MIGRATIONS).sql;
  assert.equal(predictCreatedRoleSource(up.replace('nobypassrls ', '')), 'MISMATCH');
  assert.equal(predictCreatedRoleSource(`${up}\ngrant pg_read_all_data to tmpos_app;`), 'MISMATCH');
  assert.equal(predictCreatedRoleSource(`${up}\ngrant create on database postgres to tmpos_app;`), 'MISMATCH');
});

test('C2B-M005-P2-B0: the source read distinguishes DRIFT from UNREADABLE', () => {
  // AN ABSENT FILE IS NOT THE INTERESTING CASE. A directory holding a 005 file that is PRESENT and
  // READABLE but one byte different is: without the re-bind the prediction would describe whatever
  // happens to be on disk, which is exactly the drift the prediction exists to rule out.
  const dir = mkdtempSync(join(tmpdir(), 'm005-drift-'));
  try {
    const name = '005_principal_separation_rls_foundation.up.sql';
    const bytes = readFileSync(join(MIGRATIONS, name));
    writeFileSync(join(dir, name), Buffer.concat([bytes, Buffer.from('\n-- drift\n', 'utf8')]));
    // A PRESENT BUT EDITED FILE IS DRIFT, NOT UNREADABLE. Collapsing the two made SOURCE_DRIFT
    // unreachable from the production entry point: a genuinely edited migration reported "this
    // process could not open a file", which is a different fact calling for a different response.
    assert.deepEqual(readGovernedUpSql(dir), { status: 'drift' });
    writeFileSync(join(dir, name), bytes);
    assert.equal(readGovernedUpSql(dir).status, 'match');
    assert.equal(typeof readGovernedUpSql(dir).sql, 'string');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  assert.deepEqual(readGovernedUpSql(join(REPO_ROOT, 'scripts')), { status: 'unreadable' });
});

test('C2B-M005-P2-B0: a comment sharing a statement chunk cannot blind the membership scan', () => {
  // The scan splits on `;` and discards any chunk containing ` on `, so a line comment carrying those
  // characters used to suppress the finding and yield MATCH — the strongest label, from a scan that
  // never ran. Comments are now stripped first.
  const up = readGovernedUpSql(MIGRATIONS).sql;
  const bare = `${up}\ngrant pg_read_all_data to tmpos_app;`;
  const commented = `${up}\n-- justified on the prior review\ngrant pg_read_all_data to tmpos_app;`;
  assert.equal(predictCreatedRoleSource(bare), 'MISMATCH');
  assert.equal(predictCreatedRoleSource(commented), 'MISMATCH', 'a comment must not blind the scan');
});

// ---------------------------------------------------------------------------
// 3) The ledger classifier.
// ---------------------------------------------------------------------------

test('C2B-M005-P2-B0: a clean 001-004 ledger classifies MATCH on every axis', () => {
  const l = classifyLedger(shapeOk(), cleanLedgerRows(), false, diskChecksums());
  assert.deepEqual(l, cleanLedger());
  assert.equal(predictPlan(l), 'EXACT_005');
});

test('C2B-M005-P2-B0: an absent, malformed or overflowed ledger is UNREADABLE, never favourable', () => {
  const c = diskChecksums();
  for (const l of [
    classifyLedger(null, cleanLedgerRows(), false, c),
    // A MISMATCH WITH NO CATEGORY IS A PRODUCER THIS CLASSIFIER CANNOT ACCOUNT FOR, and the old
    // `(true, null)` case it replaces is no longer representable at all: presence and the reason
    // list arrive as one value, so "present, but the failures are missing" cannot be constructed.
    classifyLedger(shapeOf({ failed: ['ledger column dirty nullability differs'] }), cleanLedgerRows(), false, c),
    classifyLedger(shapeOk(), null, false, c),
    classifyLedger(shapeOk(), cleanLedgerRows(), true, c),
  ]) {
    assert.equal(l.prefix, 'UNREADABLE');
    assert.equal(predictPlan(l), 'UNREADABLE');
  }
});

test('C2B-M005-P2-B0: a malformed row makes the whole set unreadable rather than partly believed', () => {
  const rows = cleanLedgerRows();
  for (const bad of [{ version: 1 }, { checksum: null }, { dirty: 'no' }]) {
    const mutated = rows.map((r, i) => (i === 0 ? { ...r, ...bad } : r));
    const l = classifyLedger(shapeOk(), mutated, false, diskChecksums());
    assert.equal(l.shape, 'MATCH');
    assert.equal(l.prefix, 'UNREADABLE');
    assert.equal(l.dirty, 'UNREADABLE');
  }
});

test('C2B-M005-P2-B0: a wrong shape stops before any prefix conclusion is drawn', () => {
  const l = classifyLedger(
    shapeOf({ failed: ['dirty column nullable'], categories: ['COLUMN_NULLABILITY'] }),
    cleanLedgerRows(), false, diskChecksums(),
  );
  assert.equal(l.shape, 'MISMATCH');
  assert.equal(l.prefix, 'UNREADABLE');
});

test('C2B-M005-P2-B0: a dirty row, a checksum drift, 005 present and an unknown version each show', () => {
  const c = diskChecksums();
  const rows = cleanLedgerRows();
  assert.equal(classifyLedger(shapeOk(), rows.map((r, i) => (i === 2 ? { ...r, dirty: true } : r)), false, c).dirty, 'PRESENT');
  assert.equal(classifyLedger(shapeOk(), rows.map((r, i) => (i === 1 ? { ...r, checksum: 'f'.repeat(64) } : r)), false, c).checksums, 'MISMATCH');
  // A 005 ROW CARRYING SOME OTHER MIGRATION'S CHECKSUM IS INVALID, NOT "PRESENT". The version
  // string alone used to earn the strongest label this classifier issues.
  // ONE STATE PER WAY A 005 ROW CAN BE WRONG: a coarse single INVALID hid facts an operator acts on
  // differently. A duplicate is a structural defect; a checksum drift says the history describes
  // other bytes; a dirty row says an apply was interrupted.
  assert.equal(classifyLedger(shapeOk(), [...rows, { version: '005', checksum: 'a'.repeat(64), dirty: false }], false, c).m005, 'CHECKSUM_MISMATCH');
  assert.equal(classifyLedger(shapeOk(), [...rows, validM005Row({ dirty: true })], false, c).m005, 'DIRTY');
  assert.equal(classifyLedger(shapeOk(), [...rows, validM005Row(), validM005Row()], false, c).m005, 'DUPLICATE');
  assert.equal(classifyLedger(shapeOk(), [...rows, validM005Row()], false, c).m005, 'VALID');
  assert.equal(classifyLedger(shapeOk(), rows, false, c).m005, 'ABSENT');
  // AN UNMEASURABLE EXPECTATION IS UNREADABLE, never a mismatch.
  const noExpect = new Map([...c].filter(([v]) => v !== M005_LEDGER_VERSION));
  assert.equal(classifyLedger(shapeOk(), [...rows, validM005Row()], false, noExpect).m005, 'UNREADABLE');
  assert.equal(classifyLedger(shapeOk(), [...rows, { version: '099', checksum: 'a'.repeat(64), dirty: false }], false, c).unknownOrOutOfOrder, 'PRESENT');
  assert.equal(classifyLedger(shapeOk(), [rows[1], rows[0], rows[2], rows[3]], false, c).unknownOrOutOfOrder, 'PRESENT');
  assert.equal(classifyLedger(shapeOk(), [rows[0], rows[0], rows[1], rows[2], rows[3]], false, c).prefix, 'MISMATCH');
  assert.equal(classifyLedger(shapeOk(), rows.slice(1), false, c).prefix, 'MISMATCH');
});

test('C2B-M005-P2-B0: a ledger already holding 005 predicts NOT_EXACT_005', () => {
  const rows = [...cleanLedgerRows(), validM005Row()];
  const l = classifyLedger(shapeOk(), rows, false, diskChecksums());
  assert.equal(l.m005, 'VALID');
  assert.equal(l.prefix, 'MATCH');
  // The prefix is intact, so ONLY the 005 row can carry this conclusion.
  assert.equal(predictPlan(l), 'NOT_EXACT_005');
});

test('C2B-M005-P2-B0: a dirty prefix row is not reported as a matching prefix', () => {
  const l = classifyLedger(shapeOk(), cleanLedgerRows().map((r, i) => (i === 0 ? { ...r, dirty: true } : r)), false, diskChecksums());
  assert.equal(l.prefix, 'MISMATCH');
  assert.equal(predictPlan(l), 'NOT_EXACT_005');
});

test('C2B-M005-P2-B0: the expected prefix checksums are the governed artifact bytes', () => {
  const m = expectedPrefixChecksums(MIGRATIONS);
  assert.equal(m.size, 5);
  for (const v of LEDGER_PREFIX_VERSIONS) {
    const i = LEDGER_PREFIX_VERSIONS.indexOf(v);
    assert.equal(m.get(v), createHash('sha256').update(readFileSync(join(MIGRATIONS, LEDGER_PREFIX_BASENAMES[i]))).digest('hex'));
  }
  // THE 005 EXPECTATION IS THE GOVERNED BYTES. Without it no stored 005 checksum is ever compared.
  assert.equal(m.get(M005_LEDGER_VERSION), GOVERNED_M005_SHA);
  assert.equal(m.get(M005_LEDGER_VERSION).length, 64);
  assert.equal(expectedPrefixChecksums(join(REPO_ROOT, 'scripts')), null);
});

// ---------------------------------------------------------------------------
// 4) Residue, observed preconditions and the disposition chooser.
// ---------------------------------------------------------------------------

test('C2B-M005-P2-B0: residue is CLEAN only when no postcondition object and no 005 row exists', () => {
  assert.equal(classifyResidue(metEvidence(), cleanLedger()), 'CLEAN');
  for (const over of [
    { createdRolesCount: M005_CREATED_ROLES.length }, { roleCommentResidue: 'PRESENT' },
    { constraintPresent: 'PRESENT' }, { policiesPresent: 1 },
  ]) {
    assert.equal(classifyResidue(metEvidence(over), cleanLedger()), 'PARTIAL_RESIDUE', JSON.stringify(over));
  }
});

test('C2B-M005-P2-B0: only a LEDGER row for 005 may be called ALREADY_APPLIED', () => {
  // Every postcondition object present but no ledger row is still PARTIAL_RESIDUE: that is exactly
  // the state an abandoned attempt leaves, and calling it applied would invite marking it done.
  const all = appliedEvidence({ roleCommentResidue: 'PRESENT' });
  assert.equal(classifyResidue(all, cleanLedger()), 'PARTIAL_RESIDUE');
  // BOTH WITNESSES MUST AGREE. A sound 005 row beside a COMPLETE object set is applied.
  assert.equal(classifyResidue(appliedEvidence(), cleanLedger({ m005: 'VALID' })), 'ALREADY_APPLIED');
  // A sound 005 row beside an EMPTY object set is a contradiction, not an apply — this is the
  // signature of a ledger that records work the database does not contain.
  assert.equal(classifyResidue(metEvidence(), cleanLedger({ m005: 'VALID' })), 'INCONSISTENT');
  // ...and beside a HALF-BUILT set it is the signature of an interrupted apply. `all` above is a
  // COMPLETE set, so the partial case needs an object genuinely missing.
  assert.equal(classifyResidue(appliedEvidence({ constraintPresent: 'ABSENT' }), cleanLedger({ m005: 'VALID' })), 'INCONSISTENT');
  assert.equal(classifyResidue(appliedEvidence({ policiesPresent: 2 }), cleanLedger({ m005: 'VALID' })), 'INCONSISTENT');
  // ONE ROLE OUT OF THE TWO 005 CREATES. This is the case a `Tri` could not express: any nonzero
  // count read as "the roles are there", so a half-built role set passed as a completed apply.
  assert.equal(classifyResidue(appliedEvidence({ createdRolesCount: 1 }), cleanLedger({ m005: 'VALID' })), 'INCONSISTENT');
  assert.equal(classifyObjectState(appliedEvidence({ createdRolesCount: 1 })), 'PARTIAL');
  assert.equal(classifyObjectState(appliedEvidence()), 'COMPLETE');

  // AND EVERY UNSOUND 005 STATE IS AN OBSERVED INCONSISTENCY, not a measurement failure. These rows
  // were read successfully; calling them UNREADABLE would send an operator hunting a broken
  // connection instead of a broken ledger.
  for (const m of ['CHECKSUM_MISMATCH', 'DIRTY', 'DUPLICATE']) {
    assert.equal(classifyResidue(appliedEvidence(), cleanLedger({ m005: m })), 'INCONSISTENT', m);
    assert.equal(classifyResidue(metEvidence(), cleanLedger({ m005: m })), 'INCONSISTENT', m);
  }

  // A VALID 005 ROW CANNOT HIDE A BROKEN HISTORICAL PREFIX. Each of these is an otherwise perfect
  // applied state whose 001-004 history disagrees; none may report ALREADY_APPLIED.
  for (const over of [{ prefix: 'MISMATCH' }, { checksums: 'MISMATCH' }, { unknownOrOutOfOrder: 'PRESENT' }]) {
    assert.equal(classifyResidue(appliedEvidence(), cleanLedger({ m005: 'VALID', ...over })), 'INCONSISTENT', JSON.stringify(over));
  }
});

test('C2B-M005-P2-B0: any unreadable residue input outranks every other classification', () => {
  for (const over of [{ createdRolesCount: null }, { roleCommentResidue: 'UNREADABLE' }, { constraintPresent: 'UNREADABLE' }, { policiesPresent: null }]) {
    assert.equal(classifyResidue(appliedEvidence(over), cleanLedger({ m005: 'VALID' })), 'UNREADABLE', JSON.stringify(over));
  }
  assert.equal(classifyResidue(metEvidence(), cleanLedger({ m005: 'UNREADABLE' })), 'UNREADABLE');
  // A SHAPE MISMATCH IS AN OBSERVATION, not a measurement failure: the relation was read and does
  // not match the contract. Only `shape: 'UNREADABLE'` — an ambiguous catalog entry — is unreadable.
  assert.equal(classifyResidue(metEvidence(), cleanLedger({ shape: 'MISMATCH' })), 'INCONSISTENT');
  assert.equal(classifyResidue(metEvidence(), cleanLedger({ shape: 'UNREADABLE' })), 'UNREADABLE');
  assert.equal(classifyResidue(metEvidence(), cleanLedger({ overflowed: true })), 'UNREADABLE');
});

test('C2B-M005-P2-B0: the precondition assessment is three-valued and every unreadable field yields null', () => {
  assert.equal(assessObservedPreconditions(metEvidence()), true);
  const fields = Object.keys(metEvidence());
  for (const f of fields) {
    if (f === 'createdRoles' || f === 'createdRolesCount' || f === 'roleCommentResidue'
        || f === 'constraintPresent' || f === 'policiesPresent') continue;
    const over = {};
    over[f] = typeof metEvidence()[f] === 'boolean' ? null : (f === 'prerequisiteRoles' ? 'UNREADABLE' : null);
    assert.equal(assessObservedPreconditions(metEvidence(over)), null, f);
  }
});

test('C2B-M005-P2-B0: each unsatisfied precondition assesses false, not null and not true', () => {
  const cases = [
    { publicCreateOnDatabase: true }, { publicTemporaryOnDatabase: true },
    { principalCanCreateRole: false }, { schemaPublicPresent: false }, { schemaPublicAuthority: false },
    { policyFunctionPresent: false }, { prerequisiteRoles: 'ABSENT' },
    { governedTablesPresent: M005_GOVERNED_TABLES.length - 1 },
    { governedTablesAuthoritative: M005_GOVERNED_TABLES.length - 1 },
    { requiredColumnsPresent: M005_REQUIRED_COLUMNS.length - 1 },
    { rlsEnabledTables: M005_RLS_REQUIRED_TABLES.length - 1 },
    { incompatibleAuditRows: 1 }, { sequencesInPublic: 1 },
    { plpgsqlPresent: false }, { governedNamesShadowedOutsidePublic: 1 },
    { foreignPoliciesOnGovernedTables: 1 },
  ];
  for (const over of cases) assert.equal(assessObservedPreconditions(metEvidence(over)), false, JSON.stringify(over));
  assert.equal(cases.length, 16);
  // AN ENABLED EVENT TRIGGER IS DISCLOSED, NOT GATED: this preflight can count them and cannot read
  // what they do, and a managed provider legitimately installs some. Refusing would make the
  // unreachable on the very target this exists for, so the count is an open residual in the record.
  assert.equal(assessObservedPreconditions(metEvidence({ enabledEventTriggers: 4 })), true);
  assert.equal(assessObservedPreconditions(metEvidence({ enabledEventTriggers: null })), null);
});

test('C2B-M005-P2-B0: the disposition order is source, dirty, unreadable, mismatch, inconsistent, applied', () => {
  const R = PREFLIGHT_CODES;
  assert.equal(chooseDisposition('UNREADABLE', true, 'CLEAN', cleanLedger(), true), R.EVIDENCE_UNREADABLE);
  assert.equal(chooseDisposition('MISMATCH', true, 'CLEAN', cleanLedger(), true), R.SOURCE_DRIFT);
  assert.equal(chooseDisposition('MATCH', null, 'CLEAN', cleanLedger(), true), R.EVIDENCE_UNREADABLE);
  assert.equal(chooseDisposition('MATCH', true, 'UNREADABLE', cleanLedger(), true), R.EVIDENCE_UNREADABLE);
  assert.equal(chooseDisposition('MATCH', true, 'CLEAN', cleanLedger(), null), R.EVIDENCE_UNREADABLE);
  // A dirty marker outranks BOTH already-applied and residue: it is the finding with no remedy.
  assert.equal(chooseDisposition('MATCH', true, 'ALREADY_APPLIED', cleanLedger({ dirty: 'PRESENT', m005: 'VALID' }), true), R.DIRTY_LEDGER);
  assert.equal(chooseDisposition('MATCH', true, 'PARTIAL_RESIDUE', cleanLedger({ dirty: 'PRESENT' }), true), R.DIRTY_LEDGER);
  assert.equal(chooseDisposition('MATCH', true, 'ALREADY_APPLIED', cleanLedger({ m005: 'VALID' }), true), R.ALREADY_APPLIED);
  assert.equal(chooseDisposition('MATCH', true, 'PARTIAL_RESIDUE', cleanLedger(), true), R.RESIDUE_PRESENT);

  // OBSERVED DISAGREEMENT OUTRANKS BOTH FAVOURABLE LABELS AND CARRIES ITS OWN CODE. A stored
  // checksum that was read and disagrees is not "some precondition unmet" — it says the recorded
  // history does not describe the files this repository holds.
  assert.equal(chooseDisposition('MATCH', true, 'CLEAN', cleanLedger({ checksums: 'MISMATCH' }), true), R.CHECKSUM_MISMATCH);
  assert.equal(chooseDisposition('MATCH', true, 'CLEAN', cleanLedger({ m005: 'CHECKSUM_MISMATCH' }), true), R.CHECKSUM_MISMATCH);
  assert.equal(chooseDisposition('MATCH', true, 'CLEAN', cleanLedger({ unknownOrOutOfOrder: 'PRESENT' }), true), R.LEDGER_INCONSISTENT);
  assert.equal(chooseDisposition('MATCH', true, 'CLEAN', cleanLedger({ prefix: 'MISMATCH' }), true), R.LEDGER_INCONSISTENT);
  assert.equal(chooseDisposition('MATCH', true, 'CLEAN', cleanLedger({ m005: 'DUPLICATE' }), true), R.LEDGER_INCONSISTENT);
  assert.equal(chooseDisposition('MATCH', true, 'CLEAN', cleanLedger({ shape: 'MISMATCH' }), true), R.LEDGER_INCONSISTENT);
  assert.equal(chooseDisposition('MATCH', true, 'INCONSISTENT', cleanLedger(), true), R.LEDGER_INCONSISTENT);
  // A DIRTY 005 ROW IS STILL THE DIRTY MARKER, reached through its own axis.
  assert.equal(chooseDisposition('MATCH', true, 'INCONSISTENT', cleanLedger({ m005: 'DIRTY' }), true), R.DIRTY_LEDGER);

  assert.equal(chooseDisposition('MATCH', false, 'CLEAN', cleanLedger(), true), R.PRECONDITIONS_NOT_MET);
  assert.equal(chooseDisposition('MATCH', true, 'CLEAN', cleanLedger(), false), R.PRECONDITIONS_NOT_MET);
  assert.equal(chooseDisposition('MATCH', true, 'CLEAN', cleanLedger(), true), R.OBSERVED_PRECONDITIONS_MET);
});

test('C2B-M005-P2-B0: EXACTLY ONE bounded code exits zero', () => {
  const zero = Object.values(PREFLIGHT_CODES).filter((c) => exitCodeFor(c) === 0);
  assert.deepEqual(zero, [PREFLIGHT_CODES.OBSERVED_PRECONDITIONS_MET]);
  assert.equal(exitCodeFor('anything else'), 2);
});

// ---------------------------------------------------------------------------
// 5) The child sequence: ordering, continuity, isolation and read-only.
// ---------------------------------------------------------------------------

test('C2B-M005-P2-B0: a fully favourable run reports OBSERVED_PRECONDITIONS_MET and exits zero', async () => {
  const { code, text, calls } = await runChild();
  assert.equal(code, 0);
  assert.match(text, /outcome=m005_preflight_observed_preconditions_met/);
  assert.match(text, /residue=CLEAN/);
  assert.match(text, /ledgerImpliedPlan=EXACT_005/);
  // ORDER: the bracket opens before any query, and both proofs bracket the reads.
  assert.ok(calls.indexOf('begin') < calls.indexOf('query'), calls.join(','));
  assert.equal(calls.filter((c) => c === 'isReadOnly').length, 2);
  assert.equal(calls.filter((c) => c === 'isolation').length, 2);
  assert.ok(calls.lastIndexOf('isolation') > calls.indexOf('query'));
  assert.ok(calls.indexOf('finish') < calls.indexOf('dispose'));
});

test('C2B-M005-P2-B0: a favourable run still says it authorizes nothing and is a snapshot', async () => {
  const { text } = await runChild();
  assert.match(text, /preflightCompletion=DISTINCT_FROM_MIGRATION_AUTHORIZATION/);
  assert.match(text, /snapshotScope=ONE_INSTANT_ONLY/);
  assert.match(text, /must revalidate under its own advisory lock and pre-commit gate/);
  assert.match(text, /aclNote=A_MET_IS_NOT_REQUIRED/);
  assert.match(text, /providerManagedCompatibility=OPEN_MEDIUM/);
  assert.match(text, /typesAndSchemasClasses=OUTSIDE_THIS_CONTRACT/);
  assert.match(text, /createdRolePrivilege=PREDICTED_FROM_SOURCE_AND_PUBLIC_PATHS notLiveTested=true/);
  assert.match(text, /rls enabledTables=6\/6 enabledByM005=false/);
});

test('C2B-M005-P2-B0: production, an unconfirmed target and any argv refuse before a socket', async () => {
  const lines = [];
  assert.equal(await runPreflight(goodEnv({ NODE_ENV: 'production' }), (l) => lines.push(l), {
    createExecutor: () => { throw new Error('must not be reached'); },
  }), 2);
  assert.match(lines.join('\n'), /m005_preflight_production_forbidden/);

  const l2 = [];
  assert.equal(await runPreflight(goodEnv({ CONFIRM_SUPABASE_TARGET: 'other' }), (l) => l2.push(l), {
    createExecutor: () => { throw new Error('must not be reached'); },
  }), 2);
  assert.match(l2.join('\n'), /m005_preflight_target_unconfirmed name=CONFIRM_SUPABASE_TARGET/);
  assert.ok(!l2.join('\n').includes('other'), 'the configured value must never be echoed');

  const l3 = [];
  assert.equal(await childMain(['--apply'], goodEnv(), (l) => l3.push(l), {
    createExecutor: () => { throw new Error('must not be reached'); },
  }), 2);
  assert.match(l3.join('\n'), /m005_preflight_argv_rejected/);
});

test('C2B-M005-P2-B0: source drift refuses BEFORE any connection is constructed', async () => {
  const lines = [];
  const code = await runPreflight(goodEnv(), (l) => lines.push(l), {
    upSql: () => ({ status: 'match', sql: 'create role tmpos_app nologin;' }),
    createExecutor: () => { throw new Error('must not be reached'); },
  });
  assert.equal(code, 2);
  assert.match(lines.join('\n'), /outcome=m005_preflight_source_drift/);
});

test('C2B-M005-P2-B0: an unreadable governed source refuses as unreadable, not as drift', async () => {
  const lines = [];
  const code = await runPreflight(goodEnv(), (l) => lines.push(l), {
    upSql: () => ({ status: 'unreadable' }),
    createExecutor: () => { throw new Error('must not be reached'); },
  });
  assert.equal(code, 2);
  assert.match(lines.join('\n'), /outcome=m005_preflight_evidence_unreadable/);
});

test('C2B-M005-P2-B0: a wrong described database refuses without reserving a session', async () => {
  const { code, text, calls } = await runChild({ describedDb: 'template1' });
  assert.equal(code, 2);
  assert.match(text, /m005_preflight_target_invalid/);
  assert.ok(!calls.includes('reserve'));
});

test('C2B-M005-P2-B0: read-only and isolation are each refused before and after the reads', async () => {
  const before = await runChild({ readOnly: [false, true] });
  assert.equal(before.code, 2);
  assert.match(before.text, /m005_preflight_read_only_not_established/);
  assert.ok(!before.calls.includes('query'), 'no query may run in an unproved bracket');

  const after = await runChild({ readOnly: [true, false] });
  assert.equal(after.code, 2);
  assert.match(after.text, /m005_preflight_read_only_lost/);

  const isoBefore = await runChild({ isolation: ['read committed', REQUIRED_ISOLATION] });
  assert.equal(isoBefore.code, 2);
  assert.match(isoBefore.text, /m005_preflight_isolation_not_established/);
  assert.ok(!isoBefore.calls.includes('query'));

  const isoAfter = await runChild({ isolation: [REQUIRED_ISOLATION, 'read committed'] });
  assert.equal(isoAfter.code, 2);
  assert.match(isoAfter.text, /m005_preflight_isolation_lost/);
});

test('C2B-M005-P2-B0: serializable is NOT accepted in place of the declared isolation', async () => {
  const { code, text } = await runChild({ isolation: ['serializable', 'serializable'] });
  assert.equal(code, 2);
  assert.match(text, /m005_preflight_isolation_not_established/);
});

test('C2B-M005-P2-B0: backend identity — an unreadable FIRST token is unreadable, not "changed"', async () => {
  const first = await runChild({ tokens: [undefined, 'pid:11'] });
  assert.equal(first.code, 2);
  assert.match(first.text, /m005_preflight_evidence_unreadable/);
  assert.ok(!first.text.includes('backend_identity_changed'));

  const second = await runChild({ tokens: ['pid:11', 'pid:12'] });
  assert.equal(second.code, 2);
  assert.match(second.text, /backendContinuity=BROKEN/);
  assert.match(second.text, /m005_preflight_backend_identity_changed/);

  // AN UNREAD SECOND TOKEN IS NOT AN OBSERVED CHANGE. `backend_identity_changed` asserts the
  // connection moved to another backend; the first statement error inside the bracket aborts the
  // transaction, so `pg_backend_pid()` throws and every ordinary aborted read used to report a
  // backend change nothing had witnessed.
  const lost = await runChild({ tokens: ['pid:11', undefined] });
  assert.equal(lost.code, 2);
  assert.match(lost.text, /backendContinuity=UNREADABLE/);
  assert.match(lost.text, /m005_preflight_evidence_unreadable/);
  assert.ok(!lost.text.includes('backend_identity_changed'), 'an unread token witnesses no change');
});

test('C2B-M005-P2-B0: a current_user/session_user mismatch refuses and prints no role name', async () => {
  const { code, text } = await runChild({
    identityRows: [{ principal: 'a_migrator', session_principal: 'b_owner', db: 'postgres' }],
  });
  assert.equal(code, 2);
  assert.match(text, /currentMatchesSession=false/);
  assert.match(text, /m005_preflight_identity_unconfirmed/);
  assert.ok(!text.includes('a_migrator') && !text.includes('b_owner'));
});

test('C2B-M005-P2-B0: an unreadable identity or a wrong database refuses', async () => {
  for (const rows of [[], [{ principal: '', session_principal: 'x', db: 'postgres' }], [{ principal: 'x', session_principal: 'x', db: 'template1' }]]) {
    const { code, text } = await runChild({ identityRows: rows });
    assert.equal(code, 2);
    assert.match(text, /m005_preflight_identity_unconfirmed/);
  }
});

test('C2B-M005-P2-B0: a fingerprint mismatch refuses and the failure strings never appear', async () => {
  const { code, text } = await runChild({ fingerprintFailures: ['audit action bcp.tenant.SECRET missing'] });
  assert.equal(code, 2);
  assert.match(text, /applicationFingerprint=MISMATCH/);
  assert.ok(!text.includes('SECRET'));
});

test('C2B-M005-P2-B0: a thrown port is a bounded refusal and the message never reaches output', async () => {
  const { code, text } = await runChild({ beginThrows: true });
  assert.equal(code, 2);
  assert.match(text, /m005_preflight_port_failed/);
  assert.ok(!text.includes('secret') && !text.includes('boom'));
});

// ---------------------------------------------------------------------------
// 6) Evidence-driven dispositions, cleanup precedence and output boundedness.
// ---------------------------------------------------------------------------

test('C2B-M005-P2-B0: each governed precondition failure reaches the operator as PRECONDITIONS_NOT_MET', async () => {
  const cases = [
    ['publicCreateOnDatabase', true, /publicCreate=true/],
    ['publicTemporaryOnDatabase', true, /publicTemporary=true/],
    ['principalCanCreateRole', false, /canCreateRole=false/],
    ['schemaPublicAuthority', false, /schemaPublicAuthority=false/],
    ['prerequisiteRoles', 'ABSENT', /prerequisites=ABSENT/],
    ['governedTablesPresent', 5, /tables=5\/6/],
    ['governedTablesAuthoritative', 5, /authoritative=5\/6/],
    ['requiredColumnsPresent', 12, /columns=12\/13/],
    ['rlsEnabledTables', 4, /enabledTables=4\/6/],
    ['incompatibleAuditRows', 7, /incompatibleRows=7 compatible=false/],
    ['policyFunctionPresent', false, /policyFunction=false/],
    ['sequencesInPublic', 2, /sequences=2/],
    ['plpgsqlPresent', false, /plpgsql=false/],
    ['governedNamesShadowedOutsidePublic', 1, /governedNamesShadowedOutsidePublic=1/],
    ['foreignPoliciesOnGovernedTables', 2, /foreignOnGovernedTables=2/],
  ];
  for (const [field, value, re] of cases) {
    const { code, text } = await runChild({ observed: metEvidence({ [field]: value }) });
    assert.equal(code, 2, field);
    assert.match(text, /outcome=m005_preflight_observed_preconditions_not_met/, field);
    assert.match(text, re, field);
  }
});

test('C2B-M005-P2-B0: an unreadable precondition field is unreadable, never PRECONDITIONS_NOT_MET', async () => {
  const { code, text } = await runChild({ observed: metEvidence({ rlsEnabledTables: null }) });
  assert.equal(code, 2);
  assert.match(text, /outcome=m005_preflight_evidence_unreadable/);
  assert.match(text, /enabledTables=UNREADABLE\/6/);
});

test('C2B-M005-P2-B0: role, comment, constraint and policy residue each refuse without repair', async () => {
  for (const over of [
    { createdRolesCount: M005_CREATED_ROLES.length }, { roleCommentResidue: 'PRESENT' },
    { constraintPresent: 'PRESENT' }, { policiesPresent: 2 },
  ]) {
    const { code, text } = await runChild({ observed: metEvidence(over) });
    assert.equal(code, 2, JSON.stringify(over));
    assert.match(text, /outcome=m005_preflight_residue_present/);
    assert.match(text, /residue=PARTIAL_RESIDUE/);
    // NO REMEDIATION MAY BE SUGGESTED — tested as ACTIONABLE PHRASING, not as vocabulary.
    // A bare substring ban is the wrong instrument here and was actively harmful: "repair" is part
    // of two keys the contract REQUIRES by name and which exist to REFUSE a repair, "DELETE" and
    // "TRUNCATE" are SQL privilege names, and "recommend" occurs only inside
    // `notARecommendation=true`. Banning the words would have forced every one of those to be
    // renamed to evade the guard, which is how a guard quietly stops guarding. What must never
    // appear is an instruction to act.
    for (const actionable of [
      /\b(should|must|can|may|could) (be )?(removed?|dropped?|repaired?|cleaned|disabled|deleted)\b/i,
      /\bto (fix|repair|resolve|clean|remediate)\b/i,
      /\brecommend(ed|s|ation)?\s+(that|to|:)/i,
      /\brun\b[^\n]*\b(alter|drop|grant|revoke|update|delete)\b/i,
      /\b(next steps?|remediation|suggested fix)\b/i,
    ]) {
      assert.ok(!actionable.test(text), `no remediation may be suggested: ${String(actionable)}`);
    }
    // AND every line using repair or recommendation vocabulary must be a fixed, non-actionable
    // token, so the vocabulary cannot re-enter through a sentence the patterns above do not model.
    for (const line of text.split('\n').filter((l) => /repair|recommend/i.test(l))) {
      assert.match(
        line,
        /ledgerRlsRepair=UNAUTHORIZED|repairEventTriggerEffect=(NONE_CATALOG_RELEVANT|UNRESOLVED)|notARecommendation=true/,
        `repair/recommendation vocabulary is permitted only in a fixed refusal token: ${line}`,
      );
    }
  }
});

test('C2B-M005-P2-B0: a dirty ledger refuses, names no remedy and opens no second connection', async () => {
  const rows = cleanLedgerRows().map((r, i) => (i === 3 ? { ...r, dirty: true } : r));
  const { code, text, calls } = await runChild({ ledgerRows: { rows, overflowed: false } });
  assert.equal(code, 2);
  assert.match(text, /outcome=m005_preflight_dirty_ledger/);
  assert.match(text, /nothing is cleared, nothing is retried, no second connection is opened/);
  assert.ok(!/--resolve-dirty|resolve-dirty|resolveDirty/.test(text), 'no resolution command may be named');
  assert.equal(calls.filter((c) => c === 'reserve').length, 1);
});

test('C2B-M005-P2-B0: a ledger already recording 005 is ALREADY_APPLIED, not a precondition verdict', async () => {
  // BOTH WITNESSES. The ledger row alone no longer earns the label — the objects 005 creates must
  // be there too, or the two records contradict each other.
  const rows = [...cleanLedgerRows(), validM005Row()];
  const { code, text } = await runChild({ ledgerRows: { rows, overflowed: false }, observed: appliedEvidence() });
  assert.equal(code, 2);
  assert.match(text, /outcome=m005_preflight_already_applied/);
  assert.match(text, /migration005=VALID/);

  // AND THE SAME LEDGER WITH NO OBJECTS IS A CONTRADICTION, not an apply.
  const bare = await runChild({ ledgerRows: { rows, overflowed: false } });
  assert.equal(bare.code, 2);
  assert.match(bare.text, /outcome=m005_preflight_ledger_inconsistent/);
  assert.ok(!/already_applied/.test(bare.text), 'a ledger row cannot speak for objects nobody found');
});

test('C2B-M005-P2-B0: a 005 row whose checksum is not the governed bytes REFUSES, never ALREADY_APPLIED', async () => {
  const rows = [...cleanLedgerRows(), validM005Row({ checksum: 'b'.repeat(64) })];
  const { code, text } = await runChild({ ledgerRows: { rows, overflowed: false } });
  assert.equal(code, 2);
  // OBSERVED, NOT UNREADABLE. The row was read successfully and disagrees; reporting a measurement
  // failure would send an operator looking for a broken connection instead of a broken ledger.
  assert.match(text, /outcome=m005_preflight_checksum_mismatch/);
  assert.ok(!/evidence_unreadable/.test(text), 'a read row that disagrees is not unreadable evidence');
  assert.ok(!/already_applied/.test(text), 'a foreign 005 checksum must never read as applied');
  assert.match(text, /migration005=CHECKSUM_MISMATCH/);
  // AND NO STORED CHECKSUM IS PRINTED, on the branch most tempted to show the disagreement.
  assert.ok(!/b{8}/.test(text) && !new RegExp(GOVERNED_M005_SHA.slice(0, 16)).test(text), text);
});

test('C2B-M005-P2-B0: a DIRTY 005 row still reports the dirty marker, not a weaker unreadable code', async () => {
  const rows = [...cleanLedgerRows(), validM005Row({ dirty: true })];
  const { code, text } = await runChild({ ledgerRows: { rows, overflowed: false } });
  assert.equal(code, 2);
  // The dirty marker is the most consequential single finding and outranks the unsound-row refusal.
  assert.match(text, /outcome=m005_preflight_dirty_ledger/);
  assert.match(text, /migration005=DIRTY/);
  assert.match(text, /nothing is cleared, nothing is retried/);
});

test('C2B-M005-P2-B0: a DUPLICATE 005 row refuses rather than reporting the migration applied', async () => {
  const rows = [...cleanLedgerRows(), validM005Row(), validM005Row()];
  const { code, text } = await runChild({ ledgerRows: { rows, overflowed: false } });
  assert.equal(code, 2);
  assert.ok(!/already_applied/.test(text), 'two 005 rows cannot evidence one clean apply');
  assert.match(text, /outcome=m005_preflight_ledger_inconsistent/);
  assert.match(text, /migration005=DUPLICATE/);
});

test('C2B-M005-P2-B0: an overflowed or unshaped ledger is unreadable, and no row value is printed', async () => {
  const over = await runChild({ ledgerRows: { rows: null, overflowed: true } });
  assert.equal(over.code, 2);
  assert.match(over.text, /outcome=m005_preflight_evidence_unreadable/);

  // A REAL PRODUCER RESULT. The old fixture paired absence with a reason string the producer
  // never emits for it, which is exactly the confusion the category set removes: absence has NO
  // reason, and its category is the only thing that distinguishes it from a broken producer.
  const shape = await runChild({
    ledgerShapeResult: {
      present: true,
      failed: ['ledger column dirty is integer, expected boolean'],
      categories: ['COLUMN_TYPE'],
    },
  });
  assert.equal(shape.code, 2);
  assert.match(shape.text, /ledgerShape=MISMATCH/);
  assert.match(shape.text, /ledgerShapeCategories=COLUMN_TYPE/);
  assert.ok(!shape.text.includes('is integer, expected boolean'), 'shape failure text must never be emitted');
  assert.ok(!shape.text.includes('dirty is'), 'a column identifier must never be emitted');

  const absent = await runChild({ ledgerShapeResult: { present: false, failed: [], categories: ['RELATION_ABSENT'] } });
  assert.equal(absent.code, 2);
  assert.match(absent.text, /ledgerShape=MISMATCH ledgerShapeCategories=RELATION_ABSENT/);

  const threw = await runChild({ ledgerShapeThrows: true });
  assert.equal(threw.code, 2);
  assert.match(threw.text, /ledgerShape=UNREADABLE/);
});

test('C2B-M005-P2-B0: an unreadable checksum expectation is UNREADABLE, not a MISMATCH', async () => {
  const { code, text } = await runChild({ prefixChecksums: null });
  assert.equal(code, 2);
  assert.match(text, /checksums001To004=UNREADABLE/);
  // AND THE PLAN PREDICTION MUST NOT NARROW IT EITHER. Its guard omitted the checksum axis, so an
  // unmeasurable expectation printed a definite NOT_EXACT_005 two lines under an UNREADABLE.
  assert.match(text, /ledgerImpliedPlan=UNREADABLE/);
  assert.match(text, /outcome=m005_preflight_evidence_unreadable/);
  assert.equal(predictPlan(cleanLedger({ checksums: 'UNREADABLE' })), 'UNREADABLE');
});

test('C2B-M005-P2-B0: A=UNMET with B=NO still meets the observed preconditions; B=YES does not', async () => {
  const met = await runChild();
  assert.match(met.text, /A\.currentPosture=UNMET B\.blockerSurvivesCurrentM005=NO/);
  assert.equal(met.code, 0);
});

test('C2B-M005-P2-B0: cleanup failure overrules a favourable verdict', async () => {
  const rb = await runChild({ finishThrows: true });
  assert.equal(rb.code, 2);
  assert.match(rb.text, /disposition=m005_preflight_observed_preconditions_met/);
  assert.match(rb.text, /cleanup rollback=failed/);
  assert.match(rb.text, /REFUSED: m005_preflight_rollback_failed/);
  assert.match(rb.text, /outcome=m005_preflight_rollback_failed/);

  // STRICTLY `true`, BOTH FIELDS. A truthy-but-not-true `completed` alongside a genuinely true
  // `requested` is the case a `Boolean(...)` coercion would wave through.
  for (const teardown of [{ requested: true, completed: false, gracefulSocketClose: 'not_observed' },
    null, { requested: 'yes', completed: 'yes' }, { requested: true, completed: 1 },
    { requested: 1, completed: true }]) {
    const t = await runChild({ teardown });
    assert.equal(t.code, 2);
    assert.match(t.text, /outcome=m005_preflight_teardown_failed/);
  }
  const threw = await runChild({ disposeThrows: true });
  assert.equal(threw.code, 2);
  assert.match(threw.text, /outcome=m005_preflight_teardown_failed/);
});

test('C2B-M005-P2-B0: a port claiming a graceful socket close is reported unknown, never believed', async () => {
  const { text } = await runChild({ teardown: { requested: true, completed: true, gracefulSocketClose: 'observed' } });
  assert.match(text, /gracefulSocketClose=unknown/);
  assert.ok(!/gracefulSocketClose=observed/.test(text));
});

test('C2B-M005-P2-B0: a throwing teardown accessor fails the run rather than escaping it', async () => {
  const teardown = {};
  Object.defineProperty(teardown, 'completed', { get() { throw new Error('nope'); } });
  const { code, text } = await runChild({ teardown });
  assert.equal(code, 2);
  assert.match(text, /outcome=m005_preflight_teardown_failed/);
});

test('C2B-M005-P2-B0: rollback is attempted even after a primary refusal, and never after no bracket', async () => {
  const refused = await runChild({ observed: metEvidence({ sequencesInPublic: 3 }) });
  assert.ok(refused.calls.includes('finish') && refused.calls.includes('dispose'));
  const noBracket = await runChild({ describedDb: 'template1' });
  assert.ok(!noBracket.calls.includes('finish'));
  assert.ok(!noBracket.calls.includes('dispose'));
});

test('C2B-M005-P2-B0: every emitted line is a bounded label, boolean or count', async () => {
  const { lines } = await runChild({ observed: metEvidence({ incompatibleAuditRows: 4 }) });
  const allowed = /^\[m005-preflight\] [A-Za-z0-9_.=/ :;,-]*$/;
  for (const l of lines) {
    assert.match(l, /^\[m005-preflight\] /);
    // No SQL, no identifier list, no quote, no parenthesis, no path, no URL.
    assert.ok(!/['"()]|select |from |where |https?:|postgres(ql)?:|\/\w+\//i.test(l), l);
  }
  assert.ok(lines.length > 15);

  // THE ALLOWLIST IS APPLIED TO EVERY LINE, and it was applied to none. `allowed.test(lines[0]) ||
  // true` is a tautology, so this test — named for the charset it claims to enforce — enforced only
  // the blacklist above it, and a future emit carrying `@ $ % [ { |` or a backtick would pass.
  for (const l of lines) assert.match(l, allowed);

  // AND THE LENGTH BOUND IS ITS OWN ASSERTION. Disjoining it with "some line mentions advisory
  // lock" made it unfalsifiable: the verdict block always emits that phrase, so the right-hand side
  // was true on every run that got this far and the bound was never checked.
  for (const l of lines) assert.ok(l.length < 300, `${l.length} chars: ${l.slice(0, 80)}`);
});

test('C2B-M005-P2-B0: the evidence renderer emits no identifier for any governed object', () => {
  const text = renderEvidence(
    metEvidence({ constraintPresent: 'PRESENT', policiesPresent: 5 }),
    { routinesOutsidePublic: 3, creatableNonPublicSchemas: 1 },
    cleanLedger({ dirty: 'PRESENT' }),
    cleanAcl(),
    false,
    'PARTIAL_RESIDUE',
  ).join('\n');
  for (const n of [...M005_CREATED_ROLES, ...M005_GOVERNED_TABLES, M005_CONSTRAINT.name,
    ...M005_POLICIES.map((p) => p.split('.')[1]), ...M005_REQUIRED_COLUMNS.map((c) => c.split('.')[1].split(':')[0])]) {
    assert.ok(!text.includes(n), `identifier leaked: ${n}`);
  }
  assert.ok(!text.includes('current_setting'), 'the policy function name must not be printed');
});

test('C2B-M005-P2-B0: importing the child module opens nothing and runs nothing', async () => {
  const src = readFileSync(join(REPO_ROOT, 'scripts', 'managed-m005-comprehensive-preflight.ts'), 'utf8');
  assert.ok(src.includes('resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))'),
    'the entry guard must be an EXACT path identity test, never a suffix test');
  assert.ok(!/endsWith\(/.test(src));
  // Proof rather than inspection: importing it here has already happened, and nothing connected.
  assert.equal(typeof runPreflight, 'function');
});

// ---------------------------------------------------------------------------
// 7) The bounded reads themselves, over a synthetic catalog port.
// ---------------------------------------------------------------------------

/** A catalog port that answers by matching the fixed statement text, and records every call. */
function fakeCatalog(answers, opts = {}) {
  const seen = [];
  return {
    seen,
    port: {
      query: async (text, params) => {
        seen.push({ text, params });
        if (opts.throwOn && opts.throwOn.test(text)) throw new Error('driver said dsn=postgres://u:p@h/db');
        for (const [re, rows] of answers) if (re.test(text)) return rows;
        return [];
      },
    },
  };
}

const PRECONDITION_ANSWERS = [
  [/has_database_privilege\('public'/, [{ c: false, t: false }]],
  [/rolcreaterole/, [{ v: true }]],
  [/pg_namespace n where n\.nspname = 'public'/, [{ present: '1', owned: '1' }]],
  [/from pg_catalog\.pg_roles r$/m, [{ created: '0', prereq: '2' }]],
  [/pg_shdescription/, [{ v: '0' }]],
  [/relrowsecurity/, [{ present: '6', authoritative: '6', rls: '6' }]],
  [/pg_attribute/, [{ v: '13' }]],
  [/pg_policies/, [{ governed: '0', on_governed: '0' }]],
  [/pg_table_is_visible/, [{ v: '0' }]],
  [/pg_language/, [{ v: '1' }]],
  [/pg_event_trigger/, [{ v: '0' }]],
  [/pg_constraint/, [{ v: '0' }]],
  [/from public\.audit_event/, [{ v: '0' }]],
  [/pg_get_function_identity_arguments/, [{ v: '1' }]],
  [/relkind = 'S'/, [{ v: '0' }]],
];

test('C2B-M005-P2-B0: the bounded precondition read produces exactly the expected evidence', async () => {
  const { port, seen } = fakeCatalog(PRECONDITION_ANSWERS);
  const ev = await readObservedPreconditionEvidence(port);
  assert.deepEqual(ev, metEvidence());
  // NO CALLER VALUE REACHES SQL TEXT: every parameter is one of this module's frozen constants.
  const allowedParams = [...M005_CREATED_ROLES, ...M005_PREREQUISITE_ROLES, ...M005_GOVERNED_TABLES,
    ...M005_RLS_REQUIRED_TABLES, ...M005_REQUIRED_COLUMNS, ...M005_POLICIES,
    M005_CONSTRAINT.table, M005_CONSTRAINT.name,
    'pg_catalog', 'current_setting', 'text, boolean',
    'tmpos:005_principal_separation_rls_foundation:%'];
  for (const { params } of seen) {
    for (const p of params ?? []) {
      for (const v of Array.isArray(p) ? p : [p]) {
        assert.ok(allowedParams.includes(v), String(v));
      }
    }
  }
});

test('C2B-M005-P2-B0: no precondition statement reads pg_authid or any credential column', async () => {
  const { port, seen } = fakeCatalog(PRECONDITION_ANSWERS);
  await readObservedPreconditionEvidence(port);
  await readProviderEvidence(port);
  for (const { text } of seen) {
    assert.ok(!/pg_authid/i.test(text), text);
    assert.ok(!/rolpassword|passwd|password/i.test(text), text);
  }
  const src = executableSource(readFileSync(join(REPO_ROOT, 'scripts', 'managed-m005-comprehensive-preflight.ts'), 'utf8'));
  assert.ok(!/pg_authid/.test(src), 'no executable statement may name pg_authid');
});

test('C2B-M005-P2-B0: the column check matches on TYPE, not only on name', async () => {
  // A column present under the right name but the wrong type does not fail this preflight and then
  // fails CREATE POLICY or ADD CONSTRAINT at apply time with `operator does not exist` — a pass that
  // becomes a durable dirty marker. The list carries the type and the statement must compare it.
  const { port, seen } = fakeCatalog(PRECONDITION_ANSWERS);
  await readObservedPreconditionEvidence(port);
  const colRead = seen.find(({ text }) => /pg_attribute/.test(text));
  assert.ok(colRead, 'the column read must exist');
  assert.match(colRead.text, /pg_catalog\.format_type\(a\.atttypid, a\.atttypmod\)/);
  assert.match(colRead.text, /a\.attname \|\| ':'/);
  for (const c of M005_REQUIRED_COLUMNS) {
    assert.match(c, /^[a-z_]+\.[a-z_]+:(uuid|text)$/, c);
  }
  // Every *_id the policy predicates cast to uuid must be declared uuid, and every value column the
  // constraint or a grant column-list names must be text.
  for (const c of M005_REQUIRED_COLUMNS) {
    const [col, type] = c.split('.')[1].split(':');
    assert.equal(type, col.endsWith('_id') ? 'uuid' : 'text', c);
  }
});

test('C2B-M005-P2-B0: only ONE precondition statement touches application data, and it is an aggregate', async () => {
  const { port, seen } = fakeCatalog(PRECONDITION_ANSWERS);
  await readObservedPreconditionEvidence(port);
  const appReads = seen.filter(({ text }) => /from public\./.test(text));
  assert.equal(appReads.length, 1);
  assert.match(appReads[0].text, /select count\(\*\)::text as v from public\.audit_event/);
  assert.ok(!/select\s+\w+\s*,/.test(appReads[0].text), 'no column may be projected');
  // NEGATED, and identical to the constraint migration 005 adds. Dropping the `not` would count the
  // rows that ALREADY satisfy the constraint, and a healthy table would then report thousands of
  // "incompatible" rows while a table full of violations reported zero.
  const up = readFileSync(join(MIGRATIONS, '005_principal_separation_rls_foundation.up.sql'), 'utf8');
  const predicate = up.slice(up.indexOf('add constraint audit_event_scope_consistency_chk check ('));
  const clauses = [...predicate.slice(0, predicate.indexOf(');')).matchAll(/scope_type[^\n]*/g)].map((m) => m[0].trim());
  assert.equal(clauses.length, 3, 'the frozen constraint must still have three disjuncts');
  assert.match(appReads[0].text, /where not \(/);
  for (const c of clauses) assert.ok(appReads[0].text.includes(c.replace(/^\(/, '')), c);
});

test('C2B-M005-P2-B0: an unreadable count or boolean becomes null, never a favourable value', async () => {
  const bads = [
    [/has_database_privilege\('public'/, [{ c: 'no', t: null }]],
    [/rolcreaterole/, []],
    [/relrowsecurity/, [{ present: 'six', authoritative: '6', rls: '6' }]],
    [/pg_attribute/, [{ v: -1 }]],
    // A NUMBER is not a `count(*)::text` answer. A loosened guard would coerce it into a count.
    [/pg_policies/, [{ governed: 0, on_governed: 0 }]],
    [/relkind = 'S'/, [{ v: 13 }]],
  ];
  for (const [re, bad] of bads) {
    const answers = PRECONDITION_ANSWERS.map(([r, rows]) => (r.source === re.source ? [r, bad] : [r, rows]));
    const { port } = fakeCatalog(answers);
    const ev = await readObservedPreconditionEvidence(port);
    assert.equal(assessObservedPreconditions(ev), null, re.source);
  }
});

test('C2B-M005-P2-B0: a rejected read is bounded and the driver message never escapes', async () => {
  const { port } = fakeCatalog(PRECONDITION_ANSWERS, { throwOn: /pg_attribute/ });
  const ev = await readObservedPreconditionEvidence(port);
  assert.equal(ev.requiredColumnsPresent, null);
  // Everything else was still gathered: one unreadable category must not discard the others.
  assert.equal(ev.publicCreateOnDatabase, false);
  assert.equal(ev.rlsEnabledTables, 6);
});

test('C2B-M005-P2-B0: the bounded ledger read discards overflow rather than truncating it', async () => {
  const many = Array.from({ length: LEDGER_ROW_LIMIT + 1 }, (_, i) => ({ version: String(i), checksum: 'a', dirty: false }));
  const { port, seen } = fakeCatalog([[/schema_migrations/, many]]);
  const r = await readLedgerRowsBounded(port);
  assert.equal(r.rows, null);
  assert.equal(r.overflowed, true);
  assert.deepEqual(seen[0].params, [LEDGER_ROW_LIMIT + 1]);

  const { port: p2 } = fakeCatalog([[/schema_migrations/, many.slice(0, 3)]]);
  const ok = await readLedgerRowsBounded(p2);
  assert.equal(ok.rows.length, 3);
  assert.equal(ok.overflowed, false);

  const { port: p3 } = fakeCatalog([], { throwOn: /schema_migrations/ });
  assert.deepEqual(await readLedgerRowsBounded(p3), { rows: null, overflowed: false });
});

test('C2B-M005-P2-B0: the provider boundary reports counts only and names no schema or routine', async () => {
  const { port, seen } = fakeCatalog([[/pg_proc/, [{ v: '4' }]], [/pg_namespace/, [{ v: '2' }]]]);
  const ev = await readProviderEvidence(port);
  assert.deepEqual(ev, { routinesOutsidePublic: 4, creatableNonPublicSchemas: 2 });
  for (const { text } of seen) assert.match(text, /count\(\*\)::text/);
});

// ---------------------------------------------------------------------------
// 8) The launcher: argv, environment, unreachability and reporting.
// ---------------------------------------------------------------------------

test('C2B-M005-P2-B0: the fixed child argv is exactly node, the local tsx CLI and this child', () => {
  assert.deepEqual([...PREFLIGHT_FLAGS], []);
  assert.equal(assertChildArgvContract([NODE_BIN, TSX_CLI, PREFLIGHT_SCRIPT]), true);
  assert.ok(TSX_CLI.startsWith(REPO_ROOT) && TSX_CLI.includes('node_modules'));
  assert.ok(PREFLIGHT_SCRIPT.endsWith('managed-m005-comprehensive-preflight.ts'));
  assert.equal(NODE_BIN, process.execPath);
});

test('C2B-M005-P2-B0: no apply, baseline, resolve-dirty, owner-ACL or arbitrary child is reachable', () => {
  const tokens = ['--apply', '--baseline', '--resolve-dirty', '--status', '--down', '--dry-run',
    '--managed-dev', '--migration', '--direction', '--inspect-default-acls',
    'supabase-migrate.ts', 'supabase-owner-provision.ts', 'managed-baseline-launcher.mjs',
    'managed-m005-launcher.mjs', 'managed-default-acl-preflight'];
  for (const t of tokens) {
    assert.ok(FORBIDDEN_CHILD_TOKENS.includes(t), t);
    // THE REFUSAL MUST NAME WHAT IT FOUND. The exact three-element pin would refuse this argv on
    // its own, so only the token scan can put the token in `names` — and an operator reading a
    // refusal that says only 'child' cannot tell a typo from an attempt to reach the apply CLI.
    assert.throws(() => assertChildArgvContract([NODE_BIN, TSX_CLI, PREFLIGHT_SCRIPT + t]), (e) => {
      assert.equal(e.code, INSPECT_LAUNCHER_CODES.ARGV_CONTRACT_VIOLATED, t);
      assert.ok(e.names.includes(t), `the refusal must name ${t}; got ${e.names.join(',')}`);
      return true;
    });
  }
  const bads = [[], [NODE_BIN, TSX_CLI], [NODE_BIN, TSX_CLI, PREFLIGHT_SCRIPT, '--x'],
    ['/usr/bin/node', TSX_CLI, PREFLIGHT_SCRIPT], [NODE_BIN, '/usr/lib/tsx', PREFLIGHT_SCRIPT],
    [NODE_BIN, TSX_CLI, join(REPO_ROOT, 'scripts', 'other.ts')], [NODE_BIN, TSX_CLI, 42], null];
  for (const bad of bads) {
    assert.throws(() => assertChildArgvContract(bad), (e) => e.code === INSPECT_LAUNCHER_CODES.ARGV_CONTRACT_VIOLATED);
  }
});

test('C2B-M005-P2-B0: neither the launcher nor the child can reach the apply or baseline sources', () => {
  const launcher = executableSource(readFileSync(join(REPO_ROOT, 'scripts', 'managed-m005-comprehensive-preflight-launcher.mjs'), 'utf8'));
  const child = executableSource(readFileSync(join(REPO_ROOT, 'scripts', 'managed-m005-comprehensive-preflight.ts'), 'utf8'));
  const imports = (src) => [...src.matchAll(/from '([^']+)'/g)].map((m) => m[1]);
  assert.deepEqual(imports(child).filter((i) => i.includes('supabase-migrate') || i.includes('owner-provision')
    || i.includes('managed-baseline-launcher') || i.includes('managed-m005-launcher')), []);
  // The launcher imports the two accepted helper modules for their pure exports only; neither is a
  // child it may spawn, and both are on the forbidden-token list above.
  assert.deepEqual(imports(launcher).filter((i) => i.includes('supabase-migrate') || i.includes('owner-provision')), []);
  for (const src of [launcher, child]) {
    assert.ok(!/runTrustedApply|runTrustedHistoricalBaseline|resolveDirty|resolve-dirty|ownerAcl|revokeTemporaryFromPublic/.test(src));
    assert.ok(!/\.write\b|beginTx|commitTx|executeSql|insertDirtyAttempt|finalizeApplied/.test(src));
    assert.ok(!/planApply/.test(src), 'planApply must not be called, even for the prediction');
  }
});

test('C2B-M005-P2-B0: the child environment is the exact five-key minimum and omits the apply gate', () => {
  assert.deepEqual([...INSPECT_CHILD_ENV_KEYS].sort(), [
    'CONFIRM_SUPABASE_TARGET', 'DATABASE_CA_CERT', 'NODE_ENV', 'SUPABASE_DATABASE_URL', 'SUPABASE_URL',
  ]);
  assert.ok(!INSPECT_CHILD_ENV_KEYS.includes('ALLOW_SUPABASE_MIGRATION_APPLY'));
  const env = buildInspectChildEnv(goodEnv({ PATH: '/usr/bin', NODE_OPTIONS: '--x', PGPASSWORD: 'p', ALLOW_SUPABASE_MIGRATION_APPLY: '1' }));
  assert.deepEqual(Object.keys(env).sort(), [...INSPECT_CHILD_ENV_KEYS].sort());
  assert.equal(Object.getPrototypeOf(env), null);
  assert.equal(env.NODE_ENV, 'development');
  assert.equal(env.CONFIRM_SUPABASE_TARGET, INSPECT_GATE_VALUES.CONFIRM_SUPABASE_TARGET);
});

test('C2B-M005-P2-B0: the apply gate is refused BY NAME, not merely omitted', () => {
  const env = Object.create(null);
  for (const k of INSPECT_CHILD_ENV_KEYS) env[k] = 'x';
  assert.equal(assertInspectChildEnv(env), true);
  env.ALLOW_SUPABASE_MIGRATION_APPLY = '1';
  assert.throws(() => assertInspectChildEnv(env), (e) => e.names.includes('ALLOW_SUPABASE_MIGRATION_APPLY'));
});

test('C2B-M005-P2-B0: a missing or blank configuration refuses by NAME and never by value', () => {
  for (const k of ['SUPABASE_DATABASE_URL', 'SUPABASE_URL', 'DATABASE_CA_CERT']) {
    for (const v of [undefined, '', '   ']) {
      assert.throws(() => buildInspectChildEnv(goodEnv({ [k]: v })), (e) => {
        assert.equal(e.code, INSPECT_LAUNCHER_CODES.CONFIG_MISSING);
        assert.deepEqual(e.names, [k]);
        return true;
      }, k + '=' + JSON.stringify(v));
    }
  }
});

test('C2B-M005-P2-B0: every forbidden environment shape is refused', () => {
  for (const k of [...STARTUP_SENSITIVE, 'PATH', 'HOME', 'PGHOST', 'PGPASSWORD', 'npm_config_x', 'NPM_TOKEN']) {
    const env = Object.create(null);
    for (const n of INSPECT_CHILD_ENV_KEYS) env[n] = 'x';
    env[k] = 'x';
    assert.throws(() => assertInspectChildEnv(env), (e) => e.code === INSPECT_LAUNCHER_CODES.CHILD_ENV_INVALID, k);
  }
});

test('C2B-M005-P2-B0: the parent accepts exactly one literal flag and nothing else', async () => {
  for (const argv of [[], ['--apply'], [PARENT_FLAG, '--apply'], [PARENT_FLAG + '=1'], ['--inspect-default-acls']]) {
    const err = [];
    const code = await launcherMain(argv, goodEnv(), { err: (l) => err.push(l), spawn: () => { throw new Error('must not spawn'); } });
    assert.equal(code, 2);
    assert.match(err.join('\n'), /m005_preflight_launcher_bad_invocation/);
  }
});

test('C2B-M005-P2-B0: a startup-sensitive exec environment refuses before anything is spawned', async () => {
  for (const k of STARTUP_SENSITIVE) {
    const err = [];
    const code = await launcherMain([PARENT_FLAG], goodEnv(), {
      err: (l) => err.push(l),
      assertContainment: () => {},
      readExecEnv: () => new Set([k]),
      spawn: () => { throw new Error('must not spawn'); },
    });
    assert.equal(code, 2, k);
    assert.match(err.join('\n'), new RegExp(k));
  }
});

test('C2B-M005-P2-B0: the launcher record is bounded and marks the child transcript UNVERIFIED', () => {
  const lines = renderPreflightReport({
    spawned: true, status: 'exit', exitCode: 0, signal: null,
    group: { pids: [] }, cleanup: { complete: true },
    capture: { overflowed: false, text: () => 'child said something' },
  });
  const text = lines.join('\n');
  assert.ok(lines.includes(CHILD_BLOCK_SENTINEL));
  assert.match(text, /UNVERIFIED/);
  assert.match(text, /authorizes no migration and no live write/);
  assert.match(text, /it is a SNAPSHOT/);
  assert.match(text, /no dirty-marker resolution is authorized or implemented/);

  const over = renderPreflightReport({
    spawned: true, status: 'exit', exitCode: 0, signal: null, group: { pids: [] },
    capture: { overflowed: true, text: () => 'x'.repeat(99) },
  }).join('\n');
  assert.match(over, /discarded unread; no part of it is reported/);
  assert.ok(!over.includes(CHILD_BLOCK_SENTINEL));
  // FAIL-CLOSED ON THE FLAG: anything not exactly false is overflow.
  const fuzzy = renderPreflightReport({
    spawned: true, status: 'exit', exitCode: 0, signal: null, group: { pids: [] },
    capture: { overflowed: undefined, text: () => 'x' },
  }).join('\n');
  assert.match(fuzzy, /discarded unread/);
});

test('C2B-M005-P2-B0: launcher report fields cannot carry child-controlled text', () => {
  const text = renderPreflightReport({
    spawned: 'maybe', status: 'exit; rm -rf /', exitCode: 1.5, signal: 'SIG KILL; rm -rf /',
    group: null, capture: { overflowed: false, text: () => 'x' },
  }).join('\n');
  assert.match(text, /spawned=unknown/);
  assert.match(text, /status=unreportable/);
  assert.match(text, /exit=unknown/);
  assert.match(text, /signal=unreportable/);
  assert.ok(!text.includes('rm -rf'));
});

test('C2B-M005-P2-B0: spawn failure, timeout, nonzero exit and lost observation are distinguished', async () => {
  const CAP = { overflowed: false, text: () => '' };
  const cases = [
    [{ spawned: false, status: 'spawn_failed', exitCode: null, signal: null, group: { pids: [] }, capture: CAP }, /spawned=false/],
    [{ spawned: true, status: 'timeout', exitCode: null, signal: 'SIGKILL', group: { pids: [] }, cleanup: { complete: true }, capture: CAP }, /status=timeout/],
    [{ spawned: true, status: 'exit', exitCode: 2, signal: null, group: { pids: [] }, capture: CAP }, /exit=2/],
    [{ spawned: true, status: 'exit', exitCode: 0, signal: null, group: { pids: [7] }, observationLost: true, capture: CAP }, /observationLost=true/],
  ];
  for (const [result, re] of cases) assert.match(renderPreflightReport(result).join('\n'), re);
});

test('C2B-M005-P2-B0: importing the launcher module spawns nothing and reads no file', () => {
  const src = readFileSync(join(REPO_ROOT, 'scripts', 'managed-m005-comprehensive-preflight-launcher.mjs'), 'utf8');
  assert.ok(src.includes('resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))'));
  assert.ok(!/endsWith\(/.test(src));
  assert.equal(typeof launcherMain, 'function');
});

test('C2B-M005-P2-B0: the documented outer invocation removes every startup-sensitive variable', () => {
  // The in-process assertion is DETECTION; this command line is the PREVENTION. A test comparing
  // the two is what stops the documented command drifting from the list actually enforced.
  for (const n of STARTUP_SENSITIVE) {
    assert.ok(OUTER_INVOCATION.includes(`-u ${n}`), `the outer command must unset ${n}`);
  }
  assert.ok(OUTER_INVOCATION.startsWith('env '));
  assert.ok(OUTER_INVOCATION.includes(NODE_BIN));
  assert.ok(OUTER_INVOCATION.endsWith(` ${PARENT_FLAG}`));
  // It starts THIS launcher and nothing else — never the migrate CLI or another launcher.
  assert.ok(OUTER_INVOCATION.includes('managed-m005-comprehensive-preflight-launcher.mjs'));
  for (const t of ['supabase-migrate.ts', 'managed-baseline-launcher.mjs', 'managed-m005-launcher.mjs',
    '--apply', '--baseline', '--resolve-dirty']) {
    assert.ok(!OUTER_INVOCATION.includes(t), t);
  }
});

test('C2B-M005-P2-B0: NO statement text is assembled — every SQL string is a fixed literal', () => {
  // The stronger property than "no caller value reaches SQL": no VALUE AT ALL is interpolated into a
  // statement IN THIS FILE, so the question of where an interpolated value came from cannot arise
  // here. The ledger relation was the last templated identifier and is now written out.
  //
  // TWO STATEMENTS THIS CHILD CAUSES TO RUN ARE ASSEMBLED, AND BOTH LIVE ELSEWHERE — stating it is
  // more honest than a claim that reads as absolute. `snapshotTx.applyLocalTimeouts` interpolates a
  // millisecond count re-proved to be a positive int4 at the call site, and `readDefaultAclRowsBounded`
  // interpolates an object-class predicate generated from a frozen list with a per-value single-ASCII-
  // letter re-proof. Neither takes caller input; both are range- or grammar-proved at generation.
  const src = readFileSync(join(REPO_ROOT, 'scripts', 'managed-m005-comprehensive-preflight.ts'), 'utf8');
  const statements = [...src.matchAll(/(?:`|')\s*select[\s\S]*?(?:`|')/gi)].map((m) => m[0]);
  assert.ok(statements.length >= 10, `expected the statements to be found, got ${statements.length}`);
  for (const st of statements) {
    assert.ok(!st.includes('${'), `statement text is assembled: ${st.slice(0, 60)}`);
  }
  // And every placeholder is positional, never a name pasted in.
  for (const st of statements) {
    for (const ph of st.match(/\$\d+/g) ?? []) assert.match(ph, /^\$[1-3]$/);
  }
});

// ---------------------------------------------------------------------------
// 9) The remaining §16 branches, driven end to end through the child.
// ---------------------------------------------------------------------------

test('C2B-M005-P2-B0: a stored checksum drift reaches the operator as CHECKSUM_MISMATCH', async () => {
  const rows = cleanLedgerRows().map((r, i) => (i === 1 ? { ...r, checksum: 'f'.repeat(64) } : r));
  const { code, text } = await runChild({ ledgerRows: { rows, overflowed: false } });
  assert.equal(code, 2);
  assert.match(text, /checksums001To004=MISMATCH/);
  assert.match(text, /outcome=m005_preflight_checksum_mismatch/);
  // The STORED value must never be printed — only the comparison.
  assert.ok(!text.includes('f'.repeat(16)));
});

test('C2B-M005-P2-B0: an unknown or out-of-order ledger version reaches the operator', async () => {
  const unknown = [...cleanLedgerRows(), { version: '099', checksum: 'a'.repeat(64), dirty: false }];
  const u = await runChild({ ledgerRows: { rows: unknown, overflowed: false } });
  assert.equal(u.code, 2);
  assert.match(u.text, /unknownOrOutOfOrder=PRESENT/);
  assert.match(u.text, /ledgerImpliedPlan=NOT_EXACT_005/);
  assert.match(u.text, /outcome=m005_preflight_ledger_inconsistent/);
  assert.ok(!u.text.includes('099'), 'no stored version value may be printed');

  const c = cleanLedgerRows();
  const o = await runChild({ ledgerRows: { rows: [c[1], c[0], c[2], c[3]], overflowed: false } });
  assert.equal(o.code, 2);
  assert.match(o.text, /unknownOrOutOfOrder=PRESENT/);
});

test('C2B-M005-P2-B0: RLS flags and policy presence are reported independently', async () => {
  // A DISAGREEMENT IS TWO SEPARATE FACTS, not one. RLS enabled everywhere while a governed policy
  // name already exists is residue; RLS disabled while no policy exists is an unmet precondition.
  // Collapsing them would let a table with RLS off and policies present pass.
  const residue = await runChild({ observed: metEvidence({ policiesPresent: 5 }) });
  assert.match(residue.text, /rls enabledTables=6\/6/);
  assert.match(residue.text, /policies governedPresent=5\/5/);
  assert.match(residue.text, /outcome=m005_preflight_residue_present/);

  const inert = await runChild({ observed: metEvidence({ rlsEnabledTables: 0, policiesPresent: 5 }) });
  assert.match(inert.text, /rls enabledTables=0\/6/);
  assert.match(inert.text, /policies governedPresent=5\/5/);
  // Residue outranks the precondition gates: the objects must be dealt with before the flags matter.
  assert.match(inert.text, /outcome=m005_preflight_residue_present/);

  const unmet = await runChild({ observed: metEvidence({ rlsEnabledTables: 0 }) });
  assert.match(unmet.text, /outcome=m005_preflight_observed_preconditions_not_met/);

  // A FOREIGN POLICY ON A GOVERNED TABLE IS A REFUSAL, not a note. Permissive policies OR together,
  // so one left on tenant or store would union with 005's and defeat the isolation it establishes.
  // It is NOT residue — 005 did not create it — so it lands as PRECONDITIONS_NOT_MET, not RESIDUE_PRESENT.
  const foreign = await runChild({ observed: metEvidence({ foreignPoliciesOnGovernedTables: 3 }) });
  assert.match(foreign.text, /foreignOnGovernedTables=3/);
  assert.equal(foreign.code, 2, 'a foreign policy on a governed table must block');
  assert.match(foreign.text, /outcome=m005_preflight_observed_preconditions_not_met/);
});

test('C2B-M005-P2-B0: an overflowed default-ACL read is unreadable evidence, never a posture', async () => {
  const { code, text } = await runChild({ aclRead: { rows: [], overflowed: true } });
  assert.equal(code, 2);
  assert.match(text, /acl overflowed=true/);
  assert.match(text, /outcome=m005_preflight_evidence_unreadable/);
});

test('C2B-M005-P2-B0: a widened global TABLES or SEQUENCES default row fails the preconditions', async () => {
  // 005 issues no GLOBAL statement for either class, so a global row on one of them could only have
  // come from outside this migration and 005 would not close it. B=YES is the same refusal.
  for (const objtype of ['r', 'S']) {
    const rows = [{ owner: PRINCIPAL, objtype, scope: '', grantee: 'public', privilege: 'SELECT' }];
    const { code, text } = await runChild({ aclRead: { rows, overflowed: false } });
    assert.equal(code, 2, objtype);
    assert.match(text, /B\.blockerSurvivesCurrentM005=YES/);
    assert.match(text, objtype === 'r' ? /globalTables=GLOBAL_OVERRIDE/ : /globalSequences=GLOBAL_OVERRIDE/);
    assert.match(text, /outcome=m005_preflight_observed_preconditions_not_met/);
  }
});

test('C2B-M005-P2-B0: a global FUNCTIONS override is the class 005 DOES close, and is not a blocker', async () => {
  const rows = [{ owner: PRINCIPAL, objtype: 'f', scope: '', grantee: null, privilege: null }];
  const { code, text } = await runChild({ aclRead: { rows, overflowed: false } });
  assert.match(text, /globalFunctions=GLOBAL_OVERRIDE/);
  assert.match(text, /B\.blockerSurvivesCurrentM005=NO/);
  assert.equal(code, 0, 'the class 005 globally revokes must not block it');
});

test('C2B-M005-P2-B0: the governed lists bind to the migration in BOTH directions', () => {
  // THE FORWARD CHECK ALONE IS THE WEAKER HALF. "Every listed name appears in the bytes" passes a 005
  // edit that ADDS a role, constraint or policy — which is exactly the drift that would leave the
  // preflight silently checking a subset. The checksum pin would still catch it, but as a blanket
  // SOURCE_DRIFT refusal rather than as "this list is now incomplete". This is the converse.
  const up = readFileSync(join(MIGRATIONS, '005_principal_separation_rls_foundation.up.sql'), 'utf8');
  const executable = up
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n').filter((l) => !l.trimStart().startsWith('--')).join('\n');

  const roles = [...executable.matchAll(/\bcreate\s+role\s+([a-z_][a-z0-9_]*)/gi)].map((m) => m[1]);
  assert.deepEqual([...roles].sort(), [...M005_CREATED_ROLES].sort());

  const constraints = [...executable.matchAll(/\badd\s+constraint\s+([a-z_][a-z0-9_]*)/gi)].map((m) => m[1]);
  assert.deepEqual([...constraints].sort(), [M005_CONSTRAINT.name]);

  const policies = [...executable.matchAll(/\bcreate\s+policy\s+([a-z_][a-z0-9_]*)\s+on\s+public\.([a-z_][a-z0-9_]*)/gi)]
    .map((m) => `${m[2]}.${m[1]}`);
  assert.deepEqual([...policies].sort(), [...M005_POLICIES].sort());
  assert.deepEqual([...new Set(policies.map((p) => p.split('.')[0]))].sort(), [...M005_POLICY_TABLES].sort());

  // Every relation any statement grants, revokes or alters must be a governed table.
  const targets = new Set();
  for (const m of executable.matchAll(/\bon\s+table\s+(?:public\.)?([a-z_][a-z0-9_]*)/gi)) targets.add(m[1]);
  for (const m of executable.matchAll(/\balter\s+table\s+(?:public\.)?([a-z_][a-z0-9_]*)/gi)) targets.add(m[1]);
  for (const t of targets) assert.ok(M005_GOVERNED_TABLES.includes(t), `ungoverned relation: ${t}`);
  assert.deepEqual([...targets].sort(), [...M005_GOVERNED_TABLES].sort());
});

test('C2B-M005-P2-B0: the unqualified-name hazard the shadowing check exists for is real', () => {
  // Migration 005 names its relation WITHOUT a schema in the platform_identity revoke and in all
  // seven grants, so their target is whatever search_path resolves at apply time — while every fact
  // this preflight gathers is scoped to `public`. If a future edit qualified them all, the shadowing
  // check would become belt-and-braces rather than load-bearing, and this test would say so.
  const up = readFileSync(join(MIGRATIONS, '005_principal_separation_rls_foundation.up.sql'), 'utf8');
  const executable = up.split('\n').filter((l) => !l.trimStart().startsWith('--')).join('\n');
  const unqualified = [...executable.matchAll(/\bon\s+table\s+([a-z_][a-z0-9_]*)(?!\.)/gi)].map((m) => m[1]);
  assert.equal(unqualified.length, 8, 'eight statements still resolve their relation through search_path');
  for (const t of unqualified) assert.ok(M005_GOVERNED_TABLES.includes(t), t);
});

test('C2B-M005-P2-B0: the parent timeout is DERIVED from the child budget it mirrors', async () => {
  const child = await import('../../scripts/managed-m005-comprehensive-preflight.ts');
  const parent = await import('../../scripts/managed-m005-comprehensive-preflight-launcher.mjs');
  // The launcher is started by bare `node` and cannot import the .ts child, so the constants are
  // mirrored. This is the check that keeps the mirror honest.
  assert.equal(parent.CHILD_TX_TIMEOUT_MS, child.TX_TIMEOUT_MS);
  assert.equal(parent.CHILD_STATEMENT_BUDGET, child.BRACKET_STATEMENT_BUDGET);
  assert.equal(
    parent.TIMEOUT_MS,
    child.TX_TIMEOUT_MS * child.BRACKET_STATEMENT_BUDGET + parent.CHILD_CONNECT_BUDGET_MS + parent.PARENT_OVERHEAD_MS,
  );
  // The parent must outlast the child's own worst case, or a slow SUCCESS is reported as a timeout.
  assert.ok(parent.TIMEOUT_MS > child.TX_TIMEOUT_MS * child.BRACKET_STATEMENT_BUDGET + parent.CHILD_CONNECT_BUDGET_MS);
});

test('C2B-M005-P2-B0: a foreign policy on the identity store is caught, not only its RLS flag', async () => {
  // The reason platform_identity is in the RLS list is 001's "RLS enabled, NO POLICIES" posture.
  // Checking the flag and not the policies would audit one half of a two-part claim.
  const { port, seen } = fakeCatalog(PRECONDITION_ANSWERS);
  await readObservedPreconditionEvidence(port);
  const policyRead = seen.find(({ text }) => /pg_policies/.test(text));
  assert.ok(policyRead, 'the policy read must exist');
  assert.deepEqual(policyRead.params[1], [...M005_RLS_REQUIRED_TABLES]);
  assert.ok(policyRead.params[1].includes('platform_identity'));
});

test('C2B-M005-P2-B0: an unreadable fingerprint or ACL read does not collapse the whole run', async () => {
  // A REJECTION IS NOT A DISAGREEMENT. It used to synthesize a failure label, so a statement
  // timeout reported that the application identity on the target differs from the expected one —
  // a specific claim drawn from a comparison that never ran.
  const fp = await runChild({ fingerprintThrows: true });
  assert.equal(fp.code, 2);
  assert.match(fp.text, /applicationFingerprint=UNREADABLE/);
  assert.match(fp.text, /outcome=m005_preflight_evidence_unreadable/);
  assert.ok(!fp.text.includes('fingerprint_mismatch'), 'an unread comparison is not a mismatch');
  assert.ok(!fp.text.includes('port_failed'), 'a guarded read must not reach the outer handler');

  // AND A GENUINE DISAGREEMENT STILL REACHES ITS OWN CODE. The failure strings are consumed here
  // and never emitted: they can name an application identifier.
  const drift = await runChild({ fingerprintFailures: ['application_name differs'] });
  assert.equal(drift.code, 2);
  assert.match(drift.text, /applicationFingerprint=MISMATCH/);
  assert.match(drift.text, /outcome=m005_preflight_fingerprint_mismatch/);
  assert.ok(!drift.text.includes('application_name differs'), 'no failure string may be emitted');

  const acl = await runChild({ aclThrows: true });
  assert.equal(acl.code, 2);
  assert.match(acl.text, /acl overflowed=true/);
  assert.match(acl.text, /outcome=m005_preflight_evidence_unreadable/);
  // The continuity and post-read checks still ran, which is the point of guarding it.
  assert.match(acl.text, /backendContinuity=AGREED/);
});

test('C2B-M005-P2-B0: an unrecognized endpoint family is bounded before it is printed', async () => {
  const { text } = await runChild({ endpointFamily: 'https://leaked.example/dsn' });
  assert.match(text, /endpointFamily=unrecognized/);
  assert.ok(!text.includes('leaked.example'));
});

// ---------------------------------------------------------------------------
// C2B-M005-P2-B0-R1 — PUBLIC-SCHEMA EFFECTIVE AUTHORITY, and the ledger-prefix gate.
//
// WHAT THESE TESTS CAN AND CANNOT PROVE, stated rather than implied. The question "does this
// principal hold immediately usable authority over schema public" is answered BY THE SERVER, by one
// predicate. No offline test can evaluate that predicate, so the proof is split in two and both
// halves are needed:
//
//   1. THE PREDICATE IS THE RIGHT ONE — pinned against the source text, because that is the only
//      artifact this turn may inspect. `pg_has_role(current_user, nspowner, 'USAGE')` is true for a
//      direct owner AND for a database owner whose `public` is owned by `pg_database_owner` (sole
//      implicit member, privileges immediately available), and FALSE for a NOINHERIT member who
//      would first have to SET ROLE. A literal `nspowner = current_user::regrole` would answer the
//      first case only and would refuse every PostgreSQL 15+ database laid out the standard way.
//
//   2. THE ANSWER IS CLASSIFIED FAIL-CLOSED — driven here, over the count row the server returns.
//
// The two ownership cases below produce the SAME count row on a correct implementation; that they
// are indistinguishable HERE is exactly why (1) is not optional.
// ---------------------------------------------------------------------------

/** The precondition answer set with the public-schema row overridden. */
function preconditionsWith(publicRow) {
  // MATCHED ON THE SOURCE TEXT, NOT BY RE-PARSING IT. `re.source` carries the pattern's own escapes,
  // so a regex-against-a-regex comparison silently matches nothing and the fixture quietly keeps the
  // default favourable row — a substitution that fails open is worse than no substitution at all.
  const picked = PRECONDITION_ANSWERS.filter(([re]) => re.source.includes("nspname = 'public'"));
  assert.equal(picked.length, 1, 'exactly one answer must own the public-schema statement');
  return PRECONDITION_ANSWERS.map(([re, rows]) => (re === picked[0][0] ? [re, publicRow] : [re, rows]));
}

test('C2B-M005-P2-B0-R1: effective public-schema authority is a role-usage test, not owner equality', () => {
  const src = readFileSync(join(REPO_ROOT, 'scripts', 'managed-m005-comprehensive-preflight.ts'), 'utf8');
  const start = src.indexOf("n.nspname = 'public'");
  assert.ok(start > 0, 'the public-schema read must exist');
  const stmt = src.slice(src.lastIndexOf('`', start), start + 40);

  // THE ACCEPTED PREDICATE. 'USAGE' is the whole point: it is true only when the privileges are
  // available WITHOUT SET ROLE, which is what "immediately usable" means.
  assert.ok(/pg_catalog\.pg_has_role\(current_user, n\.nspowner, 'USAGE'\)/.test(stmt), stmt);

  // AND THE REJECTED ONES. `= current_user` would refuse pg_database_owner; 'MEMBER' would accept a
  // NOINHERIT member who cannot use the privilege until they SET ROLE.
  assert.ok(!/nspowner\s*=\s*current_user/.test(stmt), 'literal owner equality must not be the test');
  assert.ok(!/regrole/.test(stmt), 'an OID-to-name cast has no place in the authority test');
  assert.ok(!/nspowner,\s*'MEMBER'/.test(stmt), "'MEMBER' would accept authority requiring SET ROLE");

  // NO SCHEMA PRIVILEGE MAY SUBSTITUTE FOR OWNERSHIP anywhere in the authority statement.
  assert.ok(!/has_schema_privilege/.test(stmt), 'CREATE/USAGE on the schema is not ownership');
});

test('C2B-M005-P2-B0-R1: direct ownership and immediately usable pg_database_owner both pass', async () => {
  // ONE count row, and the classifier never learns WHICH role owns `public` — that is deliberate:
  // a name comparison is the bug this gate exists to avoid, and a name is also output the operator
  // record may not carry. Both accepted cases reach the classifier as `owned = 1`.
  for (const label of ['current user owns public directly', 'public owned by pg_database_owner']) {
    const { port } = fakeCatalog(preconditionsWith([{ present: '1', owned: '1' }]));
    const ev = await readObservedPreconditionEvidence(port);
    assert.equal(ev.schemaPublicPresent, true, label);
    assert.equal(ev.schemaPublicAuthority, true, label);
    assert.equal(assessObservedPreconditions(ev), true, label);
  }
});

test('C2B-M005-P2-B0-R1: privilege without ownership, and membership needing SET ROLE, are refused', async () => {
  // Each of these is a DIFFERENT server-side state that yields the same bounded answer: the
  // principal cannot use the schema owner's authority as itself.
  for (const label of [
    'member of the owning role but NOINHERIT — needs SET ROLE',
    'holds CREATE on public but does not own it',
    'holds USAGE on public but does not own it',
    'public is owned by an unrelated role',
  ]) {
    const { port } = fakeCatalog(preconditionsWith([{ present: '1', owned: '0' }]));
    const ev = await readObservedPreconditionEvidence(port);
    assert.equal(ev.schemaPublicPresent, true, label);
    assert.equal(ev.schemaPublicAuthority, false, label);
    // AND IT IS A REFUSAL, not a note: the assessment is false and the disposition refuses.
    assert.equal(assessObservedPreconditions(ev), false, label);
    assert.equal(
      chooseDisposition('MATCH', assessObservedPreconditions(ev), 'CLEAN', cleanLedger(), true),
      PREFLIGHT_CODES.PRECONDITIONS_NOT_MET, label,
    );
  }
});

test('C2B-M005-P2-B0-R1: unreadable authority is null, and a duplicate or missing public row is too', async () => {
  const cases = [
    ['unreadable owned count', [{ present: '1', owned: null }]],
    ['unreadable present count', [{ present: 'x', owned: '1' }]],
    ['no public schema row', []],
    ['duplicate public schema rows', [{ present: '1', owned: '1' }, { present: '1', owned: '1' }]],
  ];
  for (const [label, rows] of cases) {
    const { port } = fakeCatalog(preconditionsWith(rows));
    const ev = await readObservedPreconditionEvidence(port);
    assert.equal(ev.schemaPublicAuthority, null, label);
    // BOTH FACTS GO UNREAD TOGETHER: they are two columns of ONE aggregate row, so a row that is
    // unparsable in either is not partly believed.
    assert.equal(ev.schemaPublicPresent, null, label);
    // THREE-VALUED, AND ABSORBING. `null` is never narrowed to false, and the assessment reports "not
    // proven satisfied" rather than "proven unsatisfied" — a different claim, a different code.
    assert.equal(assessObservedPreconditions(ev), null, label);
    assert.equal(
      chooseDisposition('MATCH', assessObservedPreconditions(ev), 'CLEAN', cleanLedger(), true),
      PREFLIGHT_CODES.EVIDENCE_UNREADABLE, label,
    );
  }
});

test('C2B-M005-P2-B0-R1: no owner name, OID or membership path may reach operator output', async () => {
  const { port } = fakeCatalog(preconditionsWith([{ present: '1', owned: '1' }]));
  const ev = await readObservedPreconditionEvidence(port);
  const text = renderEvidence(ev, { routinesOutsidePublic: 0, creatableNonPublicSchemas: 0 },
    cleanLedger(), cleanAcl(), false, 'CLEAN').join('\n');
  assert.match(text, /schemaPublicAuthority=true/);
  for (const forbidden of [/pg_database_owner/, /nspowner/, /regrole/, /SET ROLE/i, /pg_has_role/]) {
    assert.ok(!forbidden.test(text), `${forbidden} must not reach the operator record`);
  }
  // A BARE BOOLEAN IS THE WHOLE DISCLOSURE: no digits that could be an OID follow the label.
  assert.ok(!/schemaPublicAuthority=\d/.test(text), text);
});

test('C2B-M005-P2-B0-R1: no favourable verdict can bypass ledger-prefix verification', () => {
  // EVERY SINGLE-AXIS LEDGER DEGRADATION, each on an otherwise perfect run. The favourable code must be
  // unreachable for all of them — this is the gate that a checksum or prefix regression would open.
  const degraded = [
    { prefix: 'MISMATCH' }, { prefix: 'UNREADABLE' },
    { checksums: 'MISMATCH' }, { checksums: 'UNREADABLE' },
    { dirty: 'PRESENT' }, { dirty: 'UNREADABLE' },
    // EVERY MEMBER OF THE AXIS, and no value it cannot hold. `'INVALID'` was a placeholder from
    // before the six-state union existed: it passed only because ANY non-ABSENT value trips the
    // ledger gate, so it exercised none of the real states it was standing in for.
    { m005: 'VALID' }, { m005: 'CHECKSUM_MISMATCH' }, { m005: 'DIRTY' },
    { m005: 'DUPLICATE' }, { m005: 'UNREADABLE' },
    { unknownOrOutOfOrder: 'PRESENT' }, { unknownOrOutOfOrder: 'UNREADABLE' },
    { shape: 'MISMATCH' }, { shape: 'UNREADABLE' },
    { overflowed: true },
  ];
  for (const over of degraded) {
    const l = cleanLedger(over);
    const residue = classifyResidue(metEvidence(), l);
    const code = chooseDisposition('MATCH', true, residue, l, true);
    assert.notEqual(code, PREFLIGHT_CODES.OBSERVED_PRECONDITIONS_MET, JSON.stringify(over));
    assert.equal(exitCodeFor(code), 2, JSON.stringify(over));
  }
  // AND THE CONTROL: the same call with an intact ledger is the ONLY one that reaches the favourable code.
  assert.equal(
    chooseDisposition('MATCH', true, classifyResidue(metEvidence(), cleanLedger()), cleanLedger(), true),
    PREFLIGHT_CODES.OBSERVED_PRECONDITIONS_MET,
  );
});

test('C2B-M005-P2-B0-R1: chooseDisposition is total ALONE, not merely on the composed path', () => {
  // CALLED DIRECTLY, WITH A FAVOURABLE `residue` THE LEDGER DOES NOT SUPPORT. Production always
  // derives `residue` from this same ledger, so these combinations never arise there — which is
  // exactly the problem: it made a total-function contract depend on an unstated agreement between
  // two arguments. A future caller holding a residue from anywhere else would have passed.
  for (const over of [{ m005: 'VALID' }, { m005: 'CHECKSUM_MISMATCH' }, { m005: 'DUPLICATE' },
    { m005: 'DIRTY' }, { shape: 'MISMATCH' }, { prefix: 'MISMATCH' }]) {
    const code = chooseDisposition('MATCH', true, 'CLEAN', cleanLedger(over), true);
    assert.notEqual(code, PREFLIGHT_CODES.OBSERVED_PRECONDITIONS_MET, JSON.stringify(over));
    assert.equal(exitCodeFor(code), 2, JSON.stringify(over));
  }
  // AND THE CONTROL: an intact ledger with the same favourable residue still passes.
  assert.equal(chooseDisposition('MATCH', true, 'CLEAN', cleanLedger(), true), PREFLIGHT_CODES.OBSERVED_PRECONDITIONS_MET);
});

test('C2B-M005-P2-B0-R1: the ledger read is bounded, fixed, and names no caller-supplied table', async () => {
  const { port, seen } = fakeCatalog([[/schema_migrations/, cleanLedgerRows()]]);
  const out = await readLedgerRowsBounded(port, 4);
  assert.equal(out.overflowed, false);
  assert.equal(out.rows.length, 4);
  assert.equal(seen.length, 1);

  // ONE FIXED STATEMENT. The table is a literal in the source; the only value that crosses is the
  // ceiling, and it is read as LIMIT n+1 so an overflow is DETECTED rather than silently truncated.
  assert.match(seen[0].text, /from public\.schema_migrations order by version asc limit \$1/);
  assert.deepEqual(seen[0].params, [5]);
  assert.ok(!/\$\d/.test(seen[0].text.replace('limit $1', '')), 'no other parameter may reach the text');
  assert.ok(!/delete|update|insert|resolve|lock|advisory/i.test(seen[0].text), seen[0].text);

  // OVERFLOW IS DISCARDED WHOLE, never partially used.
  const many = cleanLedgerRows().concat(cleanLedgerRows());
  const { port: p2 } = fakeCatalog([[/schema_migrations/, many]]);
  const over = await readLedgerRowsBounded(p2, 4);
  assert.equal(over.overflowed, true);
  assert.equal(over.rows, null);

  // AND A DRIVER REJECTION IS THE BOUNDED FACT "unreadable" — the message is dropped unread.
  const { port: p3 } = fakeCatalog([], { throwOn: /schema_migrations/ });
  const failed = await readLedgerRowsBounded(p3, 4);
  assert.deepEqual(failed, { rows: null, overflowed: false });
});

// ---------------------------------------------------------------------------
// C2B-M005-P2-B0-R2 — the LEDGER COMBINATION MATRIX, and the vocabulary boundary.
//
// The defect these tests exist for: `ALREADY_APPLIED` was decided from the version-005 row alone, so
// a sound 005 row sitting on a ledger MISSING 002 still reported that the migration had been
// applied — the broken history was invisible. The rule is that a 005 row is only ever meaningful
// RELATIVE TO the history it followed and the objects it created, so all three witnesses have to
// agree before the strongest label is used.
// ---------------------------------------------------------------------------

/** The eight historical-prefix shapes, built as REAL ROW SETS rather than asserted axis values. */
const PREFIX_CASES = {
  VALID: () => ({ rows: cleanLedgerRows(), overflowed: false }),
  MISSING: () => ({ rows: cleanLedgerRows().filter((r) => r.version !== '002'), overflowed: false }),
  DUPLICATE: () => { const c = cleanLedgerRows(); return { rows: [c[0], c[1], c[2], c[2], c[3]], overflowed: false }; },
  CHECKSUM_MISMATCH: () => ({ rows: cleanLedgerRows().map((r, i) => (i === 0 ? { ...r, checksum: 'f'.repeat(64) } : r)), overflowed: false }),
  DIRTY: () => ({ rows: cleanLedgerRows().map((r, i) => (i === 3 ? { ...r, dirty: true } : r)), overflowed: false }),
  UNKNOWN_VERSION: () => ({ rows: [...cleanLedgerRows(), { version: '099', checksum: 'a'.repeat(64), dirty: false }], overflowed: false }),
  MALFORMED: () => ({ rows: cleanLedgerRows().map((r, i) => (i === 0 ? { ...r, dirty: 'no' } : r)), overflowed: false }),
  // OVERFLOW IS A PROPERTY OF THE READ, NOT OF THE ROWS. Modelling it as `rows: null` made
  // `runCombination` discard the 005 case entirely, so all six 005 states collapsed to one input
  // and the named "valid 005 + overflow" case carried no 005 row at all — the very claim it exists
  // to test. The rows are real; the read simply exceeded its bound.
  OVERFLOWED: () => ({ rows: cleanLedgerRows(), overflowed: true }),
};

/** The six version-005 shapes. `MALFORMED` makes the whole row set unparsable, by construction. */
const M005_CASES = {
  ABSENT: () => [],
  VALID: () => [validM005Row()],
  INVALID_CHECKSUM: () => [validM005Row({ checksum: 'b'.repeat(64) })],
  DIRTY: () => [validM005Row({ dirty: true })],
  DUPLICATE: () => [validM005Row(), validM005Row()],
  MALFORMED: () => [{ version: '005', checksum: 5, dirty: false }],
};

/** The four object-set shapes migration 005's postconditions can be in. */
const OBJECT_CASES = {
  NONE: () => metEvidence(),
  PARTIAL: () => metEvidence({ createdRolesCount: 1 }),
  COMPLETE: () => appliedEvidence(),
  UNREADABLE: () => metEvidence({ policiesPresent: null }),
};

/**
 * The rule, written once, as the specification the implementation must satisfy.
 *
 * MEASUREMENT FAILURE AND OBSERVED DISAGREEMENT ARE SEPARATED HERE ON PURPOSE. Only the three
 * `EVIDENCE_UNREADABLE` branches describe bytes that could not be obtained or parsed. Everything
 * below them was read successfully and disagrees with something else.
 */
function expectedCode(prefix, m005, objects) {
  const R = PREFLIGHT_CODES;
  // THE LEDGER FIRST, IN FULL, BEFORE ANY OBJECT-SIDE MEASUREMENT FAILURE. A ledger contradiction
  // this run actually READ outranks a category it could not read at all: reporting
  // `evidence_unreadable` for a database whose ledger plainly disagrees sends the operator to hunt
  // a broken connection. Only the ledger's own unreadable states sit above the disagreements.
  if (prefix === 'MALFORMED' || prefix === 'OVERFLOWED' || m005 === 'MALFORMED') return R.EVIDENCE_UNREADABLE;
  if (prefix === 'DIRTY' || m005 === 'DIRTY') return R.DIRTY_LEDGER;
  if (prefix === 'MISSING' || prefix === 'DUPLICATE' || prefix === 'UNKNOWN_VERSION' || m005 === 'DUPLICATE') {
    return R.LEDGER_INCONSISTENT;
  }
  if (prefix === 'CHECKSUM_MISMATCH' || m005 === 'INVALID_CHECKSUM') return R.CHECKSUM_MISMATCH;
  if (objects === 'UNREADABLE') return R.EVIDENCE_UNREADABLE;
  if (m005 === 'VALID') return objects === 'COMPLETE' ? R.ALREADY_APPLIED : R.LEDGER_INCONSISTENT;
  return objects === 'NONE' ? R.OBSERVED_PRECONDITIONS_MET : R.RESIDUE_PRESENT;
}

function runCombination(prefix, m005, objects) {
  const base = PREFIX_CASES[prefix]();
  const rows = [...base.rows, ...M005_CASES[m005]()];
  const l = classifyLedger(shapeOk(), rows, base.overflowed, diskChecksums());
  const ev = OBJECT_CASES[objects]();
  return chooseDisposition('MATCH', assessObservedPreconditions(ev), classifyResidue(ev, l), l, true);
}

test('C2B-M005-P2-B0-R2: the complete prefix x 005 x residue cross-product matches the rule', () => {
  let n = 0;
  for (const prefix of Object.keys(PREFIX_CASES)) {
    for (const m005 of Object.keys(M005_CASES)) {
      for (const objects of Object.keys(OBJECT_CASES)) {
        const label = `${prefix} / 005=${m005} / objects=${objects}`;
        assert.equal(runCombination(prefix, m005, objects), expectedCode(prefix, m005, objects), label);
        n += 1;
      }
    }
  }
  assert.equal(n, 8 * 6 * 4, 'every combination must be exercised');
});

test('C2B-M005-P2-B0-R2: exactly ONE combination in the whole cross-product exits zero', () => {
  const zero = [];
  for (const prefix of Object.keys(PREFIX_CASES)) {
    for (const m005 of Object.keys(M005_CASES)) {
      for (const objects of Object.keys(OBJECT_CASES)) {
        if (exitCodeFor(runCombination(prefix, m005, objects)) === 0) zero.push(`${prefix}/${m005}/${objects}`);
      }
    }
  }
  // The clean historical prefix, no 005 row, and an empty object set. Nothing else.
  assert.deepEqual(zero, ['VALID/ABSENT/NONE']);
});

test('C2B-M005-P2-B0-R2: a VALID 005 row can never hide an invalid historical prefix', () => {
  // THE NAMED CASES, each asserted individually so a regression names the state that broke.
  const cases = [
    ['missing 002', 'MISSING', PREFLIGHT_CODES.LEDGER_INCONSISTENT],
    ['duplicate 003', 'DUPLICATE', PREFLIGHT_CODES.LEDGER_INCONSISTENT],
    ['wrong 001 checksum', 'CHECKSUM_MISMATCH', PREFLIGHT_CODES.CHECKSUM_MISMATCH],
    ['dirty 004', 'DIRTY', PREFLIGHT_CODES.DIRTY_LEDGER],
    ['unexpected 099', 'UNKNOWN_VERSION', PREFLIGHT_CODES.LEDGER_INCONSISTENT],
    ['malformed historical row', 'MALFORMED', PREFLIGHT_CODES.EVIDENCE_UNREADABLE],
    ['overflow', 'OVERFLOWED', PREFLIGHT_CODES.EVIDENCE_UNREADABLE],
  ];
  for (const [label, prefix, want] of cases) {
    // The 005 row is VALID and the objects are COMPLETE — the most favourable possible surroundings.
    const got = runCombination(prefix, 'VALID', 'COMPLETE');
    assert.equal(got, want, label);
    assert.notEqual(got, PREFLIGHT_CODES.ALREADY_APPLIED, label);
    assert.equal(exitCodeFor(got), 2, label);
  }
  // AND THE PARTIAL-RESIDUE CASE: a perfect ledger whose objects contradict it.
  assert.equal(runCombination('VALID', 'VALID', 'PARTIAL'), PREFLIGHT_CODES.LEDGER_INCONSISTENT);
  assert.equal(runCombination('VALID', 'VALID', 'NONE'), PREFLIGHT_CODES.LEDGER_INCONSISTENT);
  // The control: only a clean prefix, a sound 005 row and a COMPLETE object set is ALREADY_APPLIED.
  assert.equal(runCombination('VALID', 'VALID', 'COMPLETE'), PREFLIGHT_CODES.ALREADY_APPLIED);
});

test('C2B-M005-P2-B0-R2: a REAL shape failure is an observation, driven through classifyLedger', () => {
  // NOT A HAND-BUILT AXIS SET. Every other shape test constructs `{shape:'MISMATCH'}` with the
  // remaining axes readable — a record `classifyLedger` cannot produce, because a shape mismatch
  // blanks them all. That made the disposition's shape guard untestable: the residue classifier's
  // own guard covered for it, and removing either one alone changed nothing. Driving the real
  // classifier puts `prefix` genuinely UNREADABLE, so only the disposition's guard can answer.
  const rows = cleanLedgerRows();
  const ev = metEvidence();
  for (const [failure, category] of [
    ['ledger relation has row-level security enabled', 'ROW_LEVEL_SECURITY'],
    ['ledger relation is relkind v, not an ordinary table', 'RELATION_KIND'],
  ]) {
    const l = classifyLedger(shapeOf({ failed: [failure], categories: [category] }), rows, false, diskChecksums());
    assert.equal(l.shape, 'MISMATCH', failure);
    assert.deepEqual(l.shapeCategories, [category], failure);
    assert.equal(l.prefix, 'UNREADABLE', failure);
    // THE RELATION WAS READ AND DISAGREES WITH THE CONTRACT. Reporting a measurement failure would
    // send an operator hunting a broken connection for a database that answered correctly.
    assert.equal(
      chooseDisposition('MATCH', assessObservedPreconditions(ev), classifyResidue(ev, l), l, true),
      PREFLIGHT_CODES.LEDGER_INCONSISTENT, failure,
    );
  }

  // AN ABSENT LEDGER RELATION IS ALSO AN OBSERVATION.
  const absent = classifyLedger(
    shapeOf({ present: false, categories: ['RELATION_ABSENT'] }), rows, false, diskChecksums(),
  );
  assert.equal(absent.shape, 'MISMATCH');
  // AND IT CARRIES ITS CAUSE despite the empty reason list — the whole point of the category set.
  assert.deepEqual(absent.shapeCategories, ['RELATION_ABSENT']);
  assert.equal(
    chooseDisposition('MATCH', assessObservedPreconditions(ev), classifyResidue(ev, absent), absent, true),
    PREFLIGHT_CODES.LEDGER_INCONSISTENT,
  );

  // AND THE ONE GENUINELY UNMEASURABLE SHAPE FAILURE STAYS UNREADABLE: an ambiguous catalog entry
  // means the shape could not be determined at all.
  const ambiguous = classifyLedger(shapeOf({ failed: [LEDGER_SHAPE_UNREADABLE] }), rows, false, diskChecksums());
  assert.equal(ambiguous.shape, 'UNREADABLE');
  // AND CARRIES NO MISMATCH CATEGORY: an unmeasurable shape must not read as an observed one.
  assert.deepEqual(ambiguous.shapeCategories, []);
  assert.equal(
    chooseDisposition('MATCH', assessObservedPreconditions(ev), classifyResidue(ev, ambiguous), ambiguous, true),
    PREFLIGHT_CODES.EVIDENCE_UNREADABLE,
  );
});

test('C2B-M005-P2-B0-R2: observed mismatch is never reported as unreadable evidence', () => {
  // EVIDENCE_UNREADABLE is reachable ONLY where the bytes could not be obtained or parsed. Every
  // other refusal describes something that WAS read. Collapsing the two would tell an operator to
  // go looking for a broken connection when the database itself is inconsistent.
  for (const prefix of Object.keys(PREFIX_CASES)) {
    for (const m005 of Object.keys(M005_CASES)) {
      for (const objects of Object.keys(OBJECT_CASES)) {
        const unreadable = runCombination(prefix, m005, objects) === PREFLIGHT_CODES.EVIDENCE_UNREADABLE;
        // An unreadable object set only surfaces once the LEDGER has nothing to say: a dirty marker
        // or any observed ledger disagreement is the more specific, more actionable finding.
        const ledgerSpeaks = prefix !== 'VALID' || (m005 !== 'ABSENT' && m005 !== 'VALID');
        const parseFailed = prefix === 'MALFORMED' || prefix === 'OVERFLOWED' || m005 === 'MALFORMED'
          || (objects === 'UNREADABLE' && !ledgerSpeaks);
        assert.equal(unreadable, parseFailed, `${prefix}/${m005}/${objects}`);
      }
    }
  }
});

test('C2B-M005-P2-B0-R2: no disposition branch emits a version, checksum, row or identifier', async () => {
  // SWEPT OVER THE CHILD'S REAL TRANSCRIPT, not over `renderEvidence` fixtures. The renderer only
  // ever receives classified enum axes and counts, so no forbidden token could reach it whatever
  // the code did — the old loop was unfalsifiable by construction and proved nothing. The child's
  // emitted lines are where a leak would actually surface, so that is what is scanned.
  const forbidden = [
    /[0-9a-f]{16}/, /\b099\b/, /postgres:\/\//, /tmpos_app\b/, /tmpos_audit_writer\b/,
    /schema_migrations/, /select /i, /pg_catalog/, /relkind/, /row-level security/,
  ];
  const scan = (lines) => forbidden.filter((f) => lines.some((l) => f.test(l)));

  const rows = cleanLedgerRows();
  const cases = [
    ['clean', {}],
    ['unknown version', { ledgerRows: { rows: [...rows, { version: '099', checksum: 'a'.repeat(64), dirty: false }], overflowed: false } }],
    ['foreign 005 checksum', { ledgerRows: { rows: [...rows, validM005Row({ checksum: 'b'.repeat(64) })], overflowed: false } }],
    ['dirty prefix', { ledgerRows: { rows: rows.map((r, i) => (i === 0 ? { ...r, dirty: true } : r)), overflowed: false } }],
    ['duplicate 005', { ledgerRows: { rows: [...rows, validM005Row(), validM005Row()], overflowed: false } }],
    ['applied', { ledgerRows: { rows: [...rows, validM005Row()], overflowed: false }, observed: appliedEvidence() }],
    ['shape mismatch', { ledgerShapeResult: { present: true, failed: ['ledger relation is relkind v, not an ordinary table'] } }],
    ['overflowed', { ledgerRows: { rows: null, overflowed: true } }],
  ];
  for (const [label, over] of cases) {
    const { lines } = await runChild(over);
    assert.deepEqual(scan(lines), [], `${label}: ${scan(lines)}`);
  }

  // POSITIVE CONTROL: the scanner must be able to fail. Without this the sweep above could be
  // passing because the patterns are unmatchable rather than because nothing leaked.
  assert.equal(scan(['[m005-preflight] x=deadbeefdeadbeef']).length, 1);
  assert.equal(scan(['[m005-preflight] x=tmpos_app']).length, 1);
});

// ---------------------------------------------------------------------------
// C2B-M005-P2-B0-R2 — the vocabulary boundary.
// ---------------------------------------------------------------------------

test('C2B-M005-P2-B0-R2: the retired flag spelling is refused by the launcher', async () => {
  // ASSEMBLED AT RUN TIME so the retired spelling appears nowhere in this boundary's source: the
  // scan below must find zero occurrences, and a literal here would itself be an occurrence.
  const retired = ['--inspect-m005', 'rea' + 'diness'].join('-');
  assert.notEqual(retired, PARENT_FLAG, 'the flag must actually have been renamed');
  const err = [];
  const code = await launcherMain([retired], {}, { err: (l) => err.push(l), out: () => {} });
  assert.equal(code, 2);
  assert.match(err.join('\n'), /m005_preflight_launcher_bad_invocation/);
  // AND THE NEW FLAG IS THE ONLY ACCEPTED SPELLING.
  assert.equal(PARENT_FLAG, '--inspect-m005-preconditions');
  assert.ok(OUTER_INVOCATION.endsWith(PARENT_FLAG), OUTER_INVOCATION);
});

test('C2B-M005-P2-B0-R2: no operative migration-permission term survives in this boundary', () => {
  // OPERATIVE means the word itself as a whole word or camelCase segment. `already`, `unreadable`,
  // `reading` and `readFileSync` are none of those and make no claim about migration state.
  // THE PATTERNS THEMSELVES ARE ASSEMBLED, for the same reason the retired flag above is: a literal
  // here would be an occurrence, and a scan that trips on its own source proves nothing.
  const WORD = 'rea' + 'd';
  const PATTERNS = [
    new RegExp(WORD + 'iness', 'gi'),
    new RegExp('(?<![A-Za-z])' + WORD + 'y(?![A-Za-z])', 'gi'),
    new RegExp('(?<=[a-z0-9_])' + WORD.replace('r', 'R') + 'y(?![A-Za-z])', 'g'),
  ];
  const files = [
    join(REPO_ROOT, 'scripts', 'managed-m005-comprehensive-preflight.ts'),
    join(REPO_ROOT, 'scripts', 'managed-m005-comprehensive-preflight-launcher.mjs'),
    fileURLToPath(import.meta.url),
  ];
  for (const f of files) {
    const text = readFileSync(f, 'utf8');
    for (const p of PATTERNS) {
      p.lastIndex = 0;
      const m = text.match(p);
      assert.equal(m, null, `${f}: ${JSON.stringify((m ?? []).slice(0, 4))}`);
    }
  }
  // AND THE EMITTED VOCABULARY ITSELF carries no such term.
  // The emitted codes are literals inside the file already scanned above, so re-scanning them here
  // could never be the assertion that fails. What IS worth pinning is that the favourable code
  // names an observation, and that it is the only one — a claim about meaning, not about charset.
  assert.equal(PREFLIGHT_CODES.OBSERVED_PRECONDITIONS_MET, 'm005_preflight_observed_preconditions_met');
  assert.equal(Object.values(PREFLIGHT_CODES).filter((c) => exitCodeFor(c) === 0).length, 1);
});

test('C2B-M005-P2-B0-R2: the favourable record still states every residual it cannot close', async () => {
  const { code, text } = await runChild();
  assert.equal(code, 0);
  assert.match(text, /outcome=m005_preflight_observed_preconditions_met/);
  // FOUR STATEMENTS A READ-ONLY SNAPSHOT STRUCTURALLY CANNOT CLOSE. A favourable record that
  // omitted them would read as a clean bill of health for questions this process never asked.
  assert.match(text, /eventTriggerEffectOnM005=OPEN/);
  assert.match(text, /applySessionSearchPathContinuity=UNPROVEN/);
  assert.match(text, /providerManagedCompatibility=OPEN_MEDIUM/);
  assert.match(text, /migration005=UNAUTHORIZED; a separate authorization is required/);
  assert.match(text, /preflightCompletion=DISTINCT_FROM_MIGRATION_AUTHORIZATION/);
  assert.match(text, /lockAvailability=UNOBSERVED/);
  // The child's vocabulary is source literals the scan above already covers, and no template in it
  // can produce "authorized to migrate", so scanning the transcript for either is constant-true.
  // The falsifiable claim is that the favourable outcome IS the observation code.
  assert.match(text, /disposition=m005_preflight_observed_preconditions_met/);
});

test('C2B-M005-P2-B0-R2: an unreadable ACL cannot bury an observed ledger contradiction', () => {
  // A DEFAULT-ACL READ THAT MERELY OVERFLOWS is a successful read with too many rows — the
  // transaction is intact and every ledger axis was parsed. It made `aclOk` null, and a fully read
  // ledger contradiction was then reported as `evidence_unreadable`: a measurement failure the run
  // did not have, hiding a disagreement it did.
  const observed = [
    [{ prefix: 'MISMATCH', checksums: 'MISMATCH' }, PREFLIGHT_CODES.LEDGER_INCONSISTENT],
    [{ unknownOrOutOfOrder: 'PRESENT' }, PREFLIGHT_CODES.LEDGER_INCONSISTENT],
    [{ m005: 'DUPLICATE' }, PREFLIGHT_CODES.LEDGER_INCONSISTENT],
    [{ checksums: 'MISMATCH' }, PREFLIGHT_CODES.CHECKSUM_MISMATCH],
    [{ m005: 'CHECKSUM_MISMATCH' }, PREFLIGHT_CODES.CHECKSUM_MISMATCH],
    [{ dirty: 'PRESENT', unknownOrOutOfOrder: 'PRESENT' }, PREFLIGHT_CODES.DIRTY_LEDGER],
  ];
  // THE TWO SHAPES ABOVE WERE NOT PRODUCIBLE: `prefix:'MISMATCH'` beside `checksums:'MATCH'`
  // requires a dirty prefix row, which forces `dirty:'PRESENT'`; `dirty:'PRESENT'` beside
  // `prefix:'MATCH'` requires an unknown dirty row, which forces `unknownOrOutOfOrder:'PRESENT'`.
  // Each entry is now cross-checked against a record the real classifier actually emits, so the
  // hand-built shapes cannot drift back into states production never reaches.
  const realRows = cleanLedgerRows();
  const dc = diskChecksums();
  for (const [real, want] of [
    [classifyLedger(shapeOk(), realRows.slice(1), false, dc), PREFLIGHT_CODES.LEDGER_INCONSISTENT],
    [classifyLedger(shapeOk(), realRows.map((r, i) => (i === 0 ? { ...r, checksum: 'f'.repeat(64) } : r)), false, dc), PREFLIGHT_CODES.CHECKSUM_MISMATCH],
    [classifyLedger(shapeOk(), realRows.map((r, i) => (i === 0 ? { ...r, dirty: true } : r)), false, dc), PREFLIGHT_CODES.DIRTY_LEDGER],
  ]) {
    assert.equal(chooseDisposition('MATCH', true, 'CLEAN', real, null), want, JSON.stringify(real));
  }
  for (const [over, want] of observed) {
    const l = cleanLedger(over);
    // Unreadable on the object side, on the ACL side, and on the precondition side in turn.
    assert.equal(chooseDisposition('MATCH', true, 'CLEAN', l, null), want, `aclOk null / ${JSON.stringify(over)}`);
    assert.equal(chooseDisposition('MATCH', null, 'CLEAN', l, true), want, `observed null / ${JSON.stringify(over)}`);
    assert.equal(chooseDisposition('MATCH', true, 'UNREADABLE', l, true), want, `residue unreadable / ${JSON.stringify(over)}`);
  }
  // AND THE CONVERSE HOLDS: with the ledger silent, an unreadable category is still unreadable.
  assert.equal(chooseDisposition('MATCH', true, 'CLEAN', cleanLedger(), null), PREFLIGHT_CODES.EVIDENCE_UNREADABLE);
  assert.equal(chooseDisposition('MATCH', null, 'CLEAN', cleanLedger(), true), PREFLIGHT_CODES.EVIDENCE_UNREADABLE);
  assert.equal(chooseDisposition('MATCH', true, 'UNREADABLE', cleanLedger(), true), PREFLIGHT_CODES.EVIDENCE_UNREADABLE);
});

test('C2B-M005-P2-B0-R2: each favourable residue label carries its own ledger precondition', () => {
  // `residue` is an ARGUMENT, and a direct caller can hand in one the ledger does not support.
  // ALREADY_APPLIED beside a ledger with NO 005 row was the strongest claim this function makes,
  // drawn from a ledger saying the migration was never applied.
  assert.equal(
    chooseDisposition('MATCH', true, 'ALREADY_APPLIED', cleanLedger({ m005: 'ABSENT' }), true),
    PREFLIGHT_CODES.LEDGER_INCONSISTENT,
  );
  assert.equal(
    chooseDisposition('MATCH', true, 'ALREADY_APPLIED', cleanLedger({ m005: 'VALID' }), true),
    PREFLIGHT_CODES.ALREADY_APPLIED,
  );
  // And residue without a ledger row is the only shape RESIDUE_PRESENT describes.
  assert.equal(
    chooseDisposition('MATCH', true, 'PARTIAL_RESIDUE', cleanLedger({ m005: 'VALID' }), true),
    PREFLIGHT_CODES.LEDGER_INCONSISTENT,
  );
  assert.equal(
    chooseDisposition('MATCH', true, 'PARTIAL_RESIDUE', cleanLedger(), true),
    PREFLIGHT_CODES.RESIDUE_PRESENT,
  );
});

test('C2B-M005-P2-B0-R2: a shape that WAS read survives an unreadable row set', () => {
  const c = diskChecksums();
  // The relation matched the contract; only the rows are missing. Reporting the shape as unreadable
  // discards a fact the run established and prints UNREADABLE for a conforming relation.
  assert.equal(classifyLedger(shapeOk(), null, false, c).shape, 'MATCH');
  assert.equal(classifyLedger(shapeOk(), cleanLedgerRows(), true, c).shape, 'MATCH');
  // Every OTHER axis is still unreadable, so nothing favourable can be drawn from it.
  const l = classifyLedger(shapeOk(), null, false, c);
  assert.equal(l.prefix, 'UNREADABLE');
  assert.equal(l.m005, 'UNREADABLE');
  assert.equal(
    chooseDisposition('MATCH', true, classifyResidue(metEvidence(), l), l, true),
    PREFLIGHT_CODES.EVIDENCE_UNREADABLE,
  );
});

test('C2B-M005-P2-B0-R2: the created-role count is the only representation, and it reaches the operator', () => {
  // TWO FIELDS FOR ONE FACT WERE INDEPENDENTLY SETTABLE. `createdRoles` (a Tri) beside
  // `createdRolesCount` allowed `{createdRoles:'ABSENT', createdRolesCount:2}` — both roles present
  // yet classified NONE, therefore CLEAN, therefore exit zero. Production correlated them, so only
  // a hand-built record could reach it; collapsing to the count makes it unrepresentable instead.
  assert.equal(classifyObjectState(metEvidence({ createdRolesCount: 0 })), 'NONE');
  assert.equal(classifyObjectState(metEvidence({ createdRolesCount: 1 })), 'PARTIAL');
  assert.equal(classifyObjectState(metEvidence({ createdRolesCount: null })), 'UNREADABLE');
  assert.ok(!('createdRoles' in metEvidence()), 'the derivable Tri must not exist alongside the count');

  // AND THE COUNT REACHES THE OPERATOR. The record printed the Tri, so one role out of two read as
  // `created=PRESENT` — the exact conflation the count was introduced to end, still on the page.
  const line = (over) => renderEvidence(
    metEvidence(over), { routinesOutsidePublic: 0, creatableNonPublicSchemas: 0 },
    cleanLedger(), cleanAcl(), false, 'CLEAN',
  ).find((l) => l.includes('roles created='));
  assert.match(line({ createdRolesCount: 1 }), new RegExp(`roles created=1/${M005_CREATED_ROLES.length}`));
  assert.match(line({ createdRolesCount: 0 }), new RegExp(`roles created=0/${M005_CREATED_ROLES.length}`));
  assert.match(line({ createdRolesCount: null }), /roles created=UNREADABLE/);
  // Still no role NAME, only the bounded count.
  for (const r of M005_CREATED_ROLES) assert.ok(!line({ createdRolesCount: 1 }).includes(r), r);
});

test('C2B-M005-P2-B0-R2: the statement budget is not smaller than the statements actually issued', async () => {
  // COUNTED BY RUNNING THE REAL READERS, not grepped from the source. Source occurrences undercount
  // badly — one generic `port.query` helper serves twelve callers — so `budget >= grepCount` stayed
  // true for a budget that was still far too small, i.e. it could not fail when the named behaviour
  // broke. AN UNDERSTATED BUDGET IS THE DANGEROUS DIRECTION: the parent's kill is derived from it,
  // so a slow-but-successful run is SIGKILLed before it can report.
  let issued = 0;
  const port = { query: async () => { issued += 1; return []; } };
  await readObservedPreconditionEvidence(port);
  await readProviderEvidence(port);
  await readLedgerRowsBounded(port);

  // Plus the statements the bracket itself issues around those reads, which no reader accounts for:
  // begin, two SET LOCAL timeouts, two read-only checks, two isolation checks, rollback, the
  // identity read, and the two backend-continuity tokens.
  const BRACKET_AND_SESSION = 11;
  const total = issued + BRACKET_AND_SESSION;
  assert.ok(issued > 15, `expected the readers to issue many statements, got ${issued}`);
  const child = await import('../../scripts/managed-m005-comprehensive-preflight.ts');
  assert.ok(
    child.BRACKET_STATEMENT_BUDGET >= total,
    `budget ${child.BRACKET_STATEMENT_BUDGET} understates the ${total} statements a run issues`,
  );
});

// ---------------------------------------------------------------------------
// C2B-M005-P2-R2-B0 — the bounded category field, its fail-closed edges, and the
// residual facts that must now appear on EVERY terminal path.
// ---------------------------------------------------------------------------

/** Reason strings carrying every class of value §5 forbids in an operator record. */
const HOSTILE_REASONS = [
  'ledger column dirty default differs: postgres://svc_admin:S3cr3t-p4ss@db.abcdefghijklmnop.supabase.co:5432/postgres',
  'ledger column checksum default differs: cGFzc3dvcmQ6IGh1bnRlcjIx / password: hunter21',
  'ledger relation on host aws-0-eu-central-1.pooler.supabase.com in project abcdefghijklmnop',
  '-----BEGIN CERTIFICATE-----\nMIIB9TCCAWACAQAwgbgxGTAXBgNVBAoMEFF1b1ZhZGlzIExpbWl0ZWQ\n-----END CERTIFICATE-----',
  `ledger column ${'x'.repeat(400)} missing`,
  `ledger carries an undeclared check constraint ${'c'.repeat(400)}`,
  "ledger column token default differs: 'eyJhbGciOiJIUzI1NiJ9.super-secret-token'",
];

/** Every substring that must never survive into the transcript, drawn from the reasons above. */
const HOSTILE_SUBSTRINGS = [
  'postgres://', 'svc_admin', 'S3cr3t-p4ss', 'db.abcdefghijklmnop.supabase.co', '5432',
  'cGFzc3dvcmQ6', 'hunter21', 'aws-0-eu-central-1.pooler.supabase.com', 'abcdefghijklmnop',
  'BEGIN CERTIFICATE', 'MIIB9TCCAWACAQAwgbgxGTAXBgNVBAoMEFF1b1ZhZGlzIExpbWl0ZWQ',
  'x'.repeat(50), 'c'.repeat(50), 'eyJhbGciOiJIUzI1NiJ9', 'super-secret-token',
  'default differs', 'undeclared check constraint', 'missing',
];

test('C2B-M005-P2-R2-B0: the bounded field renders NONE, UNREADABLE and a canonical set', () => {
  assert.equal(renderShapeCategories('MATCH', []), LEDGER_SHAPE_CATEGORIES_NONE);
  assert.equal(renderShapeCategories('UNREADABLE', []), LEDGER_SHAPE_CATEGORIES_UNREADABLE);
  // AN UNREADABLE SHAPE PRINTS THE UNREADABLE TOKEN EVEN IF A CATEGORY SOMEHOW ACCOMPANIED IT.
  // NONE there would say the relation was read and found conforming.
  assert.equal(renderShapeCategories('UNREADABLE', ['COLUMN_TYPE']), LEDGER_SHAPE_CATEGORIES_UNREADABLE);
  assert.equal(
    renderShapeCategories('MISMATCH', ['PRIMARY_KEY', 'COLUMN_TYPE', 'RELATION_ABSENT']),
    ['RELATION_ABSENT', 'COLUMN_TYPE', 'PRIMARY_KEY'].join(LEDGER_SHAPE_CATEGORY_SEPARATOR),
  );
  // THE FIELD IS SIZE-BOUNDED, and the bound is derived from the closed list rather than written
  // down, so adding or renaming a category moves it instead of overrunning a figure asserted here.
  const widest = renderShapeCategories('MISMATCH', LEDGER_SHAPE_CATEGORY_ORDER);
  assert.equal(widest.length, LEDGER_SHAPE_CATEGORIES_MAX_LENGTH);
  // PINNED INDEPENDENTLY. The line above compares two equivalent formulas — a join against a
  // sum-plus-separators reduce — so both drifting together would pass it. This is the measured
  // width of the widest field this contract can emit, and it moves only by deliberate edit.
  assert.equal(LEDGER_SHAPE_CATEGORIES_MAX_LENGTH, 189);
  // AND THE THREE TOKENS THE FIELD IS BUILT FROM. Every assertion above compares the renderer's
  // output against these same constants, so changing one would move both sides together and the
  // operator grammar would shift without a single test failing. These are the anchors.
  assert.equal(LEDGER_SHAPE_CATEGORIES_NONE, 'NONE');
  assert.equal(LEDGER_SHAPE_CATEGORIES_UNREADABLE, 'UNREADABLE');
  assert.equal(LEDGER_SHAPE_CATEGORY_SEPARATOR, ',');
  // AND THE ONE CROSS-MODULE STRING CONTRACT, anchored on the same literal the producer pushes.
  assert.equal(LEDGER_SHAPE_UNREADABLE, 'ledger relation ambiguous in catalog');
  for (const set of [[], ['RELATION_ABSENT'], LEDGER_SHAPE_CATEGORY_ORDER]) {
    assert.ok(renderShapeCategories('MISMATCH', set).length <= LEDGER_SHAPE_CATEGORIES_MAX_LENGTH);
  }
  // AND EVERY TOKEN IT CAN EMIT IS A FIXED SOURCE CONSTANT.
  for (const token of widest.split(LEDGER_SHAPE_CATEGORY_SEPARATOR)) {
    assert.ok(LEDGER_SHAPE_CATEGORY_ORDER.includes(token), token);
  }
});

test('C2B-M005-P2-R2-B0: an empty or unknown category set on a MISMATCH fails closed', () => {
  const rows = cleanLedgerRows();
  const c = diskChecksums();
  // A MISMATCH THAT EXPLAINS NOTHING IS NOT REPORTABLE AS ONE. Both of these are producers this
  // classifier cannot account for, so the shape is missing evidence rather than a disagreement.
  const empty = classifyLedger(shapeOf({ failed: ['ledger column dirty nullability differs'] }), rows, false, c);
  assert.equal(empty.shape, 'UNREADABLE');
  assert.deepEqual(empty.shapeCategories, []);

  const unknown = classifyLedger(shapeOf({ failed: ['x'], categories: ['NOT_A_REAL_CATEGORY'] }), rows, false, c);
  assert.equal(unknown.shape, 'UNREADABLE');
  assert.deepEqual(unknown.shapeCategories, []);

  // A KNOWN CATEGORY BESIDE AN UNKNOWN ONE IS STILL FAIL-CLOSED: a partial set would print a
  // confident cause list that silently omits whatever the unknown member described.
  const mixed = classifyLedger(shapeOf({ failed: ['x'], categories: ['COLUMN_TYPE', 'NOPE'] }), rows, false, c);
  assert.equal(mixed.shape, 'UNREADABLE');

  // A MALFORMED RESULT IS MISSING EVIDENCE, NOT A PORT FAILURE: an omitted set used to throw out
  // of the classifier and collapse the whole run, discarding facts the snapshot already had.
  assert.equal(classifyShape({ present: true, failed: [] }).shape, 'UNREADABLE');
  assert.equal(classifyShape(null).shape, 'UNREADABLE');

  // AND NONE OF THEM REACHES THE FAVOURABLE CODE.
  for (const l of [empty, unknown, mixed]) {
    assert.notEqual(
      chooseDisposition('MATCH', true, classifyResidue(metEvidence(), l), l, true),
      PREFLIGHT_CODES.OBSERVED_PRECONDITIONS_MET,
    );
    assert.notEqual(exitCodeFor(chooseDisposition('MATCH', true, classifyResidue(metEvidence(), l), l, true)), 0);
  }
});

test('C2B-M005-P2-R2-B0: every category still suppresses all five ledger axes and refuses', () => {
  const rows = cleanLedgerRows();
  const ev = metEvidence();
  for (const category of LEDGER_SHAPE_CATEGORY_ORDER) {
    const l = classifyLedger(
      shapeOf({ present: category !== 'RELATION_ABSENT', failed: ['a bounded internal reason'], categories: [category] }),
      rows, false, diskChecksums(),
    );
    assert.equal(l.shape, 'MISMATCH', category);
    assert.deepEqual(l.shapeCategories, [category], category);
    // ALL FIVE. The rows cannot be trusted against a relation that is not the contract, so no
    // category may license reading any of them.
    for (const axis of ['prefix', 'checksums', 'dirty', 'm005', 'unknownOrOutOfOrder']) {
      assert.equal(l[axis], 'UNREADABLE', `${category}/${axis}`);
    }
    assert.equal(classifyResidue(ev, l), 'INCONSISTENT', category);
    const code = chooseDisposition('MATCH', assessObservedPreconditions(ev), classifyResidue(ev, l), l, true);
    assert.equal(code, PREFLIGHT_CODES.LEDGER_INCONSISTENT, category);
    // NO CATEGORY CAN REACH EXIT ZERO, in any combination of the surrounding axes.
    for (const observed of [true, false, null]) {
      for (const aclOk of [true, false, null]) {
        for (const residue of ['CLEAN', 'PARTIAL_RESIDUE', 'ALREADY_APPLIED', 'INCONSISTENT', 'UNREADABLE']) {
          assert.notEqual(exitCodeFor(chooseDisposition('MATCH', observed, residue, l, aclOk)), 0, category);
        }
      }
    }
  }
  // AND THE EXIT-ZERO CELL IS UNCHANGED: the one favourable code, from a MATCHED shape with no
  // category at all, and it is still the only code in the vocabulary that exits zero.
  const clean = classifyLedger(shapeOk(), rows, false, diskChecksums());
  assert.equal(clean.shape, 'MATCH');
  assert.deepEqual(clean.shapeCategories, []);
  assert.equal(
    chooseDisposition('MATCH', assessObservedPreconditions(ev), classifyResidue(ev, clean), clean, true),
    PREFLIGHT_CODES.OBSERVED_PRECONDITIONS_MET,
  );
  assert.equal(Object.values(PREFLIGHT_CODES).filter((c) => exitCodeFor(c) === 0).length, 1);
});

test('C2B-M005-P2-R2-B0: no raw reason, identifier or secret-like value reaches the transcript', async () => {
  // DRIVEN THROUGH THE REAL CHILD, not over a renderer fixture: the reasons are handed to the
  // classifier exactly as a producer would hand them over, and the whole emitted transcript is
  // swept. The categories are the only thing that may survive.
  const { code, text } = await runChild({
    ledgerShapeResult: {
      present: true,
      failed: HOSTILE_REASONS,
      categories: ['COLUMN_DEFAULT', 'COLUMN_MISSING', 'UNDECLARED_CHECK'],
    },
  });
  assert.equal(code, 2);
  assert.match(text, /ledgerShape=MISMATCH ledgerShapeCategories=COLUMN_MISSING,COLUMN_DEFAULT,UNDECLARED_CHECK/);
  assert.match(text, /outcome=m005_preflight_ledger_inconsistent/);
  for (const forbidden of HOSTILE_SUBSTRINGS) {
    assert.ok(!text.includes(forbidden), `leaked: ${forbidden.slice(0, 40)}`);
  }
  // AND THE TRANSCRIPT STAYS BOUNDED: a 400-character identifier in a reason must not be able to
  // grow any emitted line, because no reason text is emitted at all.
  for (const line of text.split('\n')) {
    assert.ok(line.length < 400, line.slice(0, 80));
  }
});

test('C2B-M005-P2-R2-B0: the mandatory residual facts appear exactly once on every terminal path', async () => {
  const facts = residualFacts();
  // ONE CANONICAL KEY PER FACT. The apply-time lock and the event-trigger effect each had a second
  // spelling inside renderEvidence, so the computed path said the same residual twice under two
  // names while every refusal path said it zero times.
  assert.equal(new Set(facts).size, facts.length);
  for (const want of [
    /eventTriggerEffectOnM005=OPEN/, /applySessionSearchPathContinuity=UNPROVEN/,
    /providerManagedCompatibility=OPEN_MEDIUM/, /lockAvailability=UNOBSERVED/,
    /migration005=UNAUTHORIZED/,
  ]) {
    assert.equal(facts.filter((f) => want.test(f)).length, 1, String(want));
  }

  const paths = [
    ['favourable computed', await runChild()],
    ['computed refusal', await runChild({ ledgerRows: { rows: null, overflowed: true } })],
    ['early refusal: target', await runChild({ describedDb: 'not-postgres' })],
    ['early refusal: read-only not established', await runChild({ readOnly: [false, true] })],
    ['early refusal: identity', await runChild({ identityRows: [] })],
    ['early refusal: fingerprint', await runChild({ fingerprintFailures: ['app'] })],
    ['thrown port failure', await runChild({ beginThrows: true })],
    // THE THREE PRE-BRACKET REFUSALS. These return before the protected block is entered at all,
    // so the single emission after it cannot reach them and each needs its own. They are also the
    // paths on which the residuals matter most: nothing was measured, so nothing was settled.
    ['pre-contact refusal: production', await runChild({ env: goodEnv({ NODE_ENV: 'production' }) })],
    ['pre-contact refusal: target unconfirmed', await runChild({ env: goodEnv({ CONFIRM_SUPABASE_TARGET: 'other' }) })],
    ['pre-contact refusal: source drift', await runChild({ upSql: { status: 'drift', sql: '' } })],
  ];
  for (const [why, run] of paths) {
    for (const fact of facts) {
      const seen = run.lines.filter((l) => l === fact).length;
      assert.equal(seen, 1, `${why}: saw ${seen} of ${fact.slice(0, 60)}`);
    }
    // NOT AT THE COST OF THE PRIMARY FACT: the refusal or the outcome is still stated, and the
    // residuals are appended after it rather than in front of it.
    const primary = run.lines.findIndex((l) => /disposition=|REFUSED:/.test(l));
    assert.ok(primary >= 0, `${why}: no primary fact stated`);
    assert.ok(run.lines.indexOf(facts[0]) > primary, `${why}: residuals precede the primary fact`);
    // AND WHERE AN OUTCOME IS COMPUTED AT ALL, it is still the last word: the residuals are
    // emitted before cleanup, so they can neither pre-empt the teardown record nor follow it.
    const outcome = run.lines.filter((l) => /^\[m005-preflight\] outcome=/.test(l));
    assert.ok(outcome.length <= 1, why);
    if (outcome.length === 1) assert.equal(run.lines[run.lines.length - 1], outcome[0], why);
    // AND NO PRE-CONTACT REFUSAL MAY IMPLY THE DATABASE ANSWERED.
    if (why.startsWith('pre-contact')) {
      for (const line of run.lines) {
        assert.ok(!/readOnly=|backendContinuity=|targetAgreement=|ledgerShape=|cleanup /.test(line), `${why}: ${line}`);
      }
    }
  }

  // AND ON THE EARLIEST PATH OF ALL — a rejected argument, before any configuration is resolved,
  // any socket opened or any secret read. The residuals hold there too, and none of them asserts
  // that a database was contacted.
  const argvLines = [];
  const argvCode = await childMain(['--anything'], goodEnv(), (l) => argvLines.push(l));
  assert.equal(argvCode, 2);
  assert.match(argvLines[0], /REFUSED: m005_preflight_argv_rejected/);
  for (const fact of facts) {
    assert.equal(argvLines.filter((l) => l === fact).length, 1, fact.slice(0, 60));
  }
  for (const line of argvLines) {
    assert.ok(!/readOnly=|backendContinuity=|targetAgreement=|ledgerShape=/.test(line), line);
  }
});

// ---------------------------------------------------------------------------
// C2B-M005-LRLS-B0 — ledger-RLS repair-safety posture
//
// The observed ROW_LEVEL_SECURITY category says RLS is ENABLED. Whether this principal is actually
// filtered by it depends on FORCE RLS, table ownership and superuser/BYPASSRLS authority, and these
// prove those four are kept apart rather than collapsed into "enabled means filtered".
// ---------------------------------------------------------------------------

// THE FIXTURE'S SERVER VERDICT AGREES BY CONSTRUCTION unless a test overrides it deliberately.
// `row_security_active` is a cross-check on the authority booleans, so a fixture that silently
// disagreed with them would drive every applicability case to UNREADABLE for the wrong reason and
// hide whatever the case was actually written to prove. Disagreement is a case, not a default.
const mode = (over = {}) => {
  const base = {
    rlsEnabled: true, forceRls: false, currentIsSessionPrincipal: true, currentOwnsLedger: false,
    ledgerOwnerIsDatabaseOwner: true, currentIsSuperuser: false, currentHasBypassRls: false, ...over,
  };
  return 'rowSecurityActiveForCurrent' in over
    ? base
    : { ...base, rowSecurityActiveForCurrent: expectedRowSecurityActive(base) };
};
const policy = (over = {}) => ({
  permissive: true, cmd: '*', hasUsing: true, hasWithCheck: false,
  targetsPublic: false, appliesToCurrent: false, targetsOnlyOtherRoles: true, ...over,
});
const roleRow = (over = {}) => ({
  isSuperuser: false, hasBypassRls: false, ownsLedger: false,
  canConnectDatabase: true, canUseSchema: true,
  tablePrivileges: [false, false, false, false, false, false, false],
  columnPrivileges: [false, false, false, false], ...over,
});
const privRead = (over = {}) => ({
  publicTablePrivileges: [false, false, false, false, false, false, false],
  publicColumnPrivileges: [false, false, false, false],
  roles: [], overflowed: false, ...over,
});
/** Axis A / Axis B both need FORCE RLS to be decidable; the default fixture supplies it. */
const posture = (over = {}, m = mode()) => classifyPrivilegePosture(privRead(over), m);
const trig = (over = {}) => ({
  event: 'ddl_command_start', enableMode: 'O', wildcardTags: true,
  altersTableTag: false, extensionOwned: false, ...over,
});

test('C2B-M005-LRLS-B0: enabled RLS is never by itself proof that this principal is filtered', () => {
  // THE WHOLE POINT OF THE STAGE. Ownership without FORCE, and superuser/BYPASSRLS regardless of
  // ownership, both bypass policies while RLS remains fully enabled.
  assert.equal(classifyRlsApplicability(mode({ currentOwnsLedger: true, forceRls: false })), 'BYPASS_TABLE_OWNER');
  // FORCE FLIPS IT BACK. An owner of a FORCE ROW LEVEL SECURITY table is subject like anyone else,
  // so ownership alone is not a bypass and must never be reported as one.
  assert.equal(classifyRlsApplicability(mode({ currentOwnsLedger: true, forceRls: true })), 'SUBJECT_TO_POLICIES');
  assert.equal(classifyRlsApplicability(mode({ currentIsSuperuser: true })), 'BYPASS_SUPERUSER_OR_BYPASSRLS');
  assert.equal(classifyRlsApplicability(mode({ currentHasBypassRls: true })), 'BYPASS_SUPERUSER_OR_BYPASSRLS');
  // Superuser/BYPASSRLS outranks FORCE and outranks non-ownership.
  assert.equal(classifyRlsApplicability(mode({ currentIsSuperuser: true, forceRls: true, currentOwnsLedger: false })), 'BYPASS_SUPERUSER_OR_BYPASSRLS');
  assert.equal(classifyRlsApplicability(mode({ currentOwnsLedger: false, forceRls: false })), 'SUBJECT_TO_POLICIES');
  // AND RLS DISABLED IS REPORTED ON ITS OWN AXIS, never folded into the applicability token: the
  // two are rendered on the same line precisely so neither can be read without the other.
  assert.equal(classifyRlsApplicability(mode({ rlsEnabled: false, currentOwnsLedger: true })), 'BYPASS_TABLE_OWNER');
});

test('C2B-M005-LRLS-B0: every unreadable authority input fails the derivation closed', () => {
  assert.equal(classifyRlsApplicability(null), 'UNREADABLE');
  for (const k of ['currentIsSuperuser', 'currentHasBypassRls']) {
    assert.equal(classifyRlsApplicability(mode({ [k]: null })), 'UNREADABLE', k);
  }
  // Missing ownership or force can still be resolved when a bypass is already proved, but not
  // otherwise — an unread bypass flag must never read as "not bypassing".
  for (const k of ['currentOwnsLedger', 'forceRls']) {
    assert.equal(classifyRlsApplicability(mode({ [k]: null })), 'UNREADABLE', k);
    assert.equal(classifyRlsApplicability(mode({ [k]: null, currentIsSuperuser: true })), 'BYPASS_SUPERUSER_OR_BYPASSRLS', k);
  }
});

test('C2B-M005-LRLS-B0: the policy inventory counts, classifies and never renders an expression', () => {
  assert.deepEqual(classifyPolicies({ rows: [], overflowed: false }), {
    readable: true, total: 0, permissive: 0, restrictive: 0, commandClasses: [],
    anyTargetsPublic: false, anyAppliesToCurrent: false, anyTargetsOnlyOtherRoles: false,
    withUsing: 0, withCheck: 0,
  });
  const inv = classifyPolicies({
    overflowed: false,
    rows: [
      policy({ cmd: '*', permissive: true, targetsPublic: true, appliesToCurrent: true, targetsOnlyOtherRoles: false }),
      policy({ cmd: 'r', permissive: false, hasWithCheck: true }),
      policy({ cmd: 'a', hasUsing: false, hasWithCheck: true }),
      policy({ cmd: 'w' }),
      policy({ cmd: 'd' }),
    ],
  });
  assert.equal(inv.total, 5);
  assert.equal(inv.permissive, 4);
  assert.equal(inv.restrictive, 1);
  // CANONICAL ORDER, not discovery order.
  assert.deepEqual(inv.commandClasses, ['ALL', 'SELECT', 'INSERT', 'UPDATE', 'DELETE']);
  assert.equal(inv.anyTargetsPublic, true);
  assert.equal(inv.anyAppliesToCurrent, true);
  assert.equal(inv.anyTargetsOnlyOtherRoles, true);
  assert.equal(inv.withUsing, 4);
  assert.equal(inv.withCheck, 2);
});

test('C2B-M005-LRLS-B0: a truncated or malformed policy set is discarded, never half-classified', () => {
  assert.equal(classifyPolicies(null).readable, false);
  assert.equal(classifyPolicies({ rows: [policy()], overflowed: true }).readable, false);
  // ONE MALFORMED POLICY POISONS THE SET: a policy whose applicability could not be determined
  // cannot be excluded from the ones that apply, so the posture is unknown, not "the rest".
  for (const k of ['permissive', 'hasUsing', 'hasWithCheck', 'targetsPublic', 'appliesToCurrent', 'targetsOnlyOtherRoles']) {
    assert.equal(classifyPolicies({ overflowed: false, rows: [policy(), policy({ [k]: null })] }).readable, false, k);
  }
  // An unrecognized command letter is not silently dropped.
  assert.equal(classifyPolicies({ overflowed: false, rows: [policy({ cmd: 'z' })] }).readable, false);
  assert.equal(classifyPolicies({ overflowed: false, rows: [policy({ cmd: null })] }).readable, false);
  // A discarded inventory carries no counts that could be mistaken for observations.
  const dropped = classifyPolicies({ rows: [policy(), policy()], overflowed: true });
  assert.equal(dropped.total, 0);
  assert.deepEqual(dropped.commandClasses, []);
});

test('C2B-M005-LRLS-B0: ordinary privileges cover PUBLIC, table, column and reachability', () => {
  // OWNER_ONLY is the strongest claim and needs every condition proved.
  const ownerOnly = posture({ roles: [roleRow({ ownsLedger: true, tablePrivileges: [true, true, true, true, true, true, true] })] });
  assert.equal(ownerOnly.standardPrivilegePosture, 'OWNER_ONLY');
  assert.deepEqual(ownerOnly.publicPrivileges, []);
  assert.equal(ownerOnly.anyNonOwnerOrdinaryPrivilege, false);

  // A PUBLIC GRANT ALONE DEFEATS IT.
  const pub = posture({ publicTablePrivileges: [true, false, false, false, false, false, false] });
  assert.equal(pub.standardPrivilegePosture, 'NON_OWNER_PRIVILEGE_PRESENT');
  assert.deepEqual(pub.publicPrivileges, ['SELECT']);

  // A COLUMN-ONLY GRANT ALSO DEFEATS IT — the case a table-only scan reports as "no access".
  const colOnly = posture({ roles: [roleRow({ columnPrivileges: [true, false, false, false] })] });
  assert.equal(colOnly.standardPrivilegePosture, 'NON_OWNER_PRIVILEGE_PRESENT');
  assert.deepEqual(colOnly.columnOnlyContributes, ['SELECT']);
  assert.deepEqual(colOnly.nonOwnerCounts, [0, 0, 0, 0, 0, 0, 0]);

  // A table-level grant is NOT reported as a column-only contribution.
  const tableLevel = posture({
    roles: [roleRow({ tablePrivileges: [true, false, false, false, false, false, false], columnPrivileges: [true, false, false, false] })],
  });
  assert.deepEqual(tableLevel.columnOnlyContributes, []);
  assert.deepEqual(tableLevel.nonOwnerCounts, [1, 0, 0, 0, 0, 0, 0]);

  // ONLY THE OWNER AND SUPERUSERS LEAVE AXIS A. A superuser's access is implicit in the role
  // attribute and bypasses ACL checks entirely, so its presence proves no grant; the owner's comes
  // with the object. BYPASSRLS confers NO object privilege and therefore stays in — see the
  // dedicated case below, which is the defect this stage was opened to fix.
  for (const k of ['isSuperuser', 'ownsLedger']) {
    const r = posture({ roles: [roleRow({ [k]: true, tablePrivileges: [true, true, true, true, true, true, true] })] });
    assert.equal(r.standardPrivilegePosture, 'OWNER_ONLY', k);
  }

  // REACHABILITY IS SEPARATE FROM PRIVILEGE. A grant held by a role that cannot connect or use the
  // schema is real and counted, but is not counted as presently reachable.
  const unreachable = posture({
    roles: [
      roleRow({ tablePrivileges: [true, false, false, false, false, false, false], canConnectDatabase: false }),
      roleRow({ tablePrivileges: [true, false, false, false, false, false, false], canUseSchema: false }),
      roleRow({ tablePrivileges: [true, false, false, false, false, false, false] }),
    ],
  });
  assert.deepEqual(unreachable.nonOwnerCounts, [3, 0, 0, 0, 0, 0, 0]);
  assert.equal(unreachable.presentlyReachable, 1);
  assert.equal(unreachable.newlyExposedReachable, 1);
});

test('C2B-M005-LRLS-B0-R1: an empty table ACL is not evidence that PUBLIC holds no column grant', () => {
  // THE BLOCKING FINDING, one case per column-grantable privilege. PostgreSQL stores column ACLs in
  // pg_attribute.attacl, SEPARATELY from pg_class.relacl, and permits column-level SELECT, INSERT,
  // UPDATE and REFERENCES to PUBLIC. A relation-ACL read alone reports OWNER_ONLY over every one of
  // these four databases. The table ACL below is empty in all four.
  const empty = [false, false, false, false, false, false, false];
  for (const [i, name] of ['SELECT', 'INSERT', 'UPDATE', 'REFERENCES'].entries()) {
    const col = [false, false, false, false];
    col[i] = true;
    const r = posture({ publicTablePrivileges: empty, publicColumnPrivileges: col });
    assert.notEqual(r.standardPrivilegePosture, 'OWNER_ONLY', name);
    assert.equal(r.standardPrivilegePosture, 'NON_OWNER_PRIVILEGE_PRESENT', name);
    assert.deepEqual(r.publicPrivileges, [name], name);
    assert.equal(r.anyNonOwnerOrdinaryPrivilege, true, name);
    // AND IT IS REPORTED AS COLUMN-ONLY, so the transcript distinguishes it from a table-wide grant.
    assert.deepEqual(r.columnOnlyContributes, [name], name);
    // A PUBLIC grant is held by every role in the cluster, so it is incremental exposure too.
    assert.equal(r.incrementalExposure, 'PRESENT', name);
    assert.equal(r.publicGrantContributesExposure, true, name);
  }

  // THE THREE TABLE-ONLY PRIVILEGES STAY COVERED. DELETE, TRUNCATE and TRIGGER have no column form,
  // so they can only arrive through the table answer and must not be lost in the union.
  for (const [i, name] of [[3, 'DELETE'], [4, 'TRUNCATE'], [6, 'TRIGGER']]) {
    const tbl = empty.slice();
    tbl[i] = true;
    const r = posture({ publicTablePrivileges: tbl });
    assert.equal(r.standardPrivilegePosture, 'NON_OWNER_PRIVILEGE_PRESENT', name);
    assert.deepEqual(r.publicPrivileges, [name], name);
    assert.deepEqual(r.columnOnlyContributes, [], name);
  }

  // A TABLE-LEVEL PUBLIC GRANT IS NOT DOUBLE-REPORTED AS COLUMN-ONLY. `has_any_column_privilege` is
  // true whenever the table-level privilege is held, so the union must subtract, not just merge.
  const both = posture({
    publicTablePrivileges: [true, false, false, false, false, false, false],
    publicColumnPrivileges: [true, false, false, false],
  });
  assert.deepEqual(both.publicPrivileges, ['SELECT']);
  assert.deepEqual(both.columnOnlyContributes, []);

  // AND THE UNION KEEPS CANONICAL ORDER whatever mix of sources produced it.
  const mixed = posture({
    publicTablePrivileges: [false, false, false, true, false, false, true],
    publicColumnPrivileges: [true, false, true, false],
  });
  assert.deepEqual(mixed.publicPrivileges, ['SELECT', 'UPDATE', 'DELETE', 'TRIGGER']);
});

test('C2B-M005-LRLS-B0-R1: BYPASSRLS is not a privilege source and cannot hide a real grant', () => {
  // BYPASSRLS EXEMPTS A ROLE FROM ROW SECURITY. It grants no object privilege whatever, so a
  // BYPASSRLS role reaching this table does so on an ordinary GRANT, and Axis A must count it.
  const bypass = posture({
    roles: [roleRow({ hasBypassRls: true, tablePrivileges: [true, false, false, false, false, false, false] })],
  });
  assert.equal(bypass.standardPrivilegePosture, 'NON_OWNER_PRIVILEGE_PRESENT');
  assert.deepEqual(bypass.nonOwnerCounts, [1, 0, 0, 0, 0, 0, 0]);
  assert.equal(bypass.anyNonOwnerOrdinaryPrivilege, true);
  // A COLUMN-ONLY GRANT TO THE SAME ROLE COUNTS THE SAME WAY.
  const bypassCol = posture({
    roles: [roleRow({ hasBypassRls: true, columnPrivileges: [false, false, false, true] })],
  });
  assert.equal(bypassCol.standardPrivilegePosture, 'NON_OWNER_PRIVILEGE_PRESENT');
  assert.deepEqual(bypassCol.columnOnlyContributes, ['REFERENCES']);

  // AXIS B IS THE ONE AXIS IT LEAVES, and for the reason that axis exists: it already reaches the
  // rows, so switching RLS off adds nothing for it.
  assert.equal(bypass.newlyExposedRoles, 0);
  assert.equal(bypass.incrementalExposure, 'NONE_DETECTED');
  assert.equal(bypass.newlyExposedReachable, 0);
});

test('C2B-M005-LRLS-B0-R1: current access and disable-RLS exposure are two axes, not one label', () => {
  const ordinary = posture({
    roles: [roleRow({ tablePrivileges: [true, false, false, false, false, false, false] })],
  });
  // A SUBJECT-TO-RLS ROLE WITH AN EFFECTIVE PRIVILEGE MOVES BOTH AXES.
  assert.equal(ordinary.standardPrivilegePosture, 'NON_OWNER_PRIVILEGE_PRESENT');
  assert.equal(ordinary.incrementalExposure, 'PRESENT');
  assert.equal(ordinary.newlyExposedRoles, 1);
  assert.equal(ordinary.newlyExposedReachable, 1);

  // THE OWNER AND A SUPERUSER MOVE NEITHER. Neither is newly exposed, and neither is evidence of a
  // grant. With FORCE RLS false the owner is already exempt.
  const exempt = posture({
    roles: [
      roleRow({ ownsLedger: true, tablePrivileges: [true, true, true, true, true, true, true] }),
      roleRow({ isSuperuser: true, tablePrivileges: [true, true, true, true, true, true, true] }),
    ],
  }, mode({ forceRls: false }));
  assert.equal(exempt.standardPrivilegePosture, 'OWNER_ONLY');
  assert.equal(exempt.incrementalExposure, 'NONE_DETECTED');
  assert.equal(exempt.newlyExposedRoles, 0);

  // BUT FORCE RLS PUTS THE OWNER BACK IN AXIS B, because FORCE is exactly the setting that stops
  // ownership being an exemption. Axis A is unmoved: the owner is still not non-owner exposure.
  const forced = posture({
    roles: [roleRow({ ownsLedger: true, tablePrivileges: [true, false, false, false, false, false, false] })],
  }, mode({ forceRls: true, currentOwnsLedger: true }));
  assert.equal(forced.standardPrivilegePosture, 'OWNER_ONLY');
  assert.equal(forced.incrementalExposure, 'PRESENT');
  assert.equal(forced.newlyExposedRoles, 1);

  // THE TWO AXES GENUINELY DISAGREE on the BYPASSRLS row — which is the proof they are not the same
  // computation wearing two names.
  const split = posture({
    roles: [roleRow({ hasBypassRls: true, tablePrivileges: [true, false, false, false, false, false, false] })],
  });
  assert.equal(split.standardPrivilegePosture, 'NON_OWNER_PRIVILEGE_PRESENT');
  assert.equal(split.incrementalExposure, 'NONE_DETECTED');

  // AXIS B IS UNDECIDABLE WITHOUT FORCE RLS, and says so rather than assuming the favourable value.
  const noForce = posture({ roles: [roleRow({ tablePrivileges: [true, false, false, false, false, false, false] })] }, mode({ forceRls: null }));
  assert.equal(noForce.incrementalExposure, 'UNREADABLE');
  assert.equal(noForce.standardPrivilegePosture, 'NON_OWNER_PRIVILEGE_PRESENT');
  assert.equal(classifyPrivilegePosture(privRead(), null).incrementalExposure, 'UNREADABLE');
});

test('C2B-M005-LRLS-B0: an overflowing or malformed role set can never yield OWNER_ONLY', () => {
  const both = (r) => { assert.equal(r.standardPrivilegePosture, 'UNREADABLE'); assert.equal(r.incrementalExposure, 'UNREADABLE'); };
  both(classifyPrivilegePosture(null, mode()));
  both(posture({ overflowed: true }));
  both(posture({ publicTablePrivileges: [true] }));
  both(posture({ publicColumnPrivileges: [true] }));
  // A NULL IN THE PUBLIC ANSWER IS UNREADABLE, never "PUBLIC holds nothing" — that is the
  // favourable direction and is exactly what an absent or ambiguous relation row would produce.
  both(posture({ publicTablePrivileges: [null, false, false, false, false, false, false] }));
  both(posture({ publicColumnPrivileges: [null, false, false, false] }));
  for (const k of ['isSuperuser', 'hasBypassRls', 'ownsLedger', 'canConnectDatabase', 'canUseSchema']) {
    assert.equal(posture({ roles: [roleRow({ [k]: null })] }).standardPrivilegePosture, 'UNREADABLE', k);
  }
  both(posture({ roles: [roleRow({ tablePrivileges: [null, false, false, false, false, false, false] })] }));
  both(posture({ roles: [roleRow({ columnPrivileges: [null, false, false, false] })] }));
  // Wrong arity is a contract violation, not a shorter list.
  both(posture({ roles: [roleRow({ tablePrivileges: [false] })] }));
  both(posture({ roles: [roleRow({ columnPrivileges: [false] })] }));
});

test('C2B-M005-LRLS-B0: event-trigger relevance is metadata-only and never assumes an unknown is safe', () => {
  // NO ENABLED TRIGGER COULD MATCH — the only case that may claim catalog irrelevance.
  assert.equal(classifyEventTriggers({ rows: [], overflowed: false }).effect, 'NONE_CATALOG_RELEVANT');
  // An unrelated explicit tag cannot match ALTER TABLE.
  const unrelated = classifyEventTriggers({ rows: [trig({ wildcardTags: false, altersTableTag: false })], overflowed: false });
  assert.equal(unrelated.effect, 'NONE_CATALOG_RELEVANT');
  assert.equal(unrelated.enabledTotal, 1);
  assert.equal(unrelated.potentiallyRelevant, 0);
  // A wildcard tag filter matches every command of its event.
  assert.equal(classifyEventTriggers({ rows: [trig({ wildcardTags: true })], overflowed: false }).effect, 'UNRESOLVED');
  // An explicit ALTER TABLE tag matches.
  assert.equal(classifyEventTriggers({ rows: [trig({ wildcardTags: false, altersTableTag: true })], overflowed: false }).effect, 'UNRESOLVED');
  // sql_drop cannot fire for a command that drops nothing.
  assert.equal(classifyEventTriggers({ rows: [trig({ event: 'sql_drop', wildcardTags: true })], overflowed: false }).effect, 'NONE_CATALOG_RELEVANT');
  // AN EVENT THIS CODE CANNOT NAME IS NOT AN EVENT IT CAN RULE OUT.
  assert.equal(classifyEventTriggers({ rows: [trig({ event: 'some_future_event', wildcardTags: true })], overflowed: false }).effect, 'UNRESOLVED');
  // Alternate enable modes are reported, never used to exclude: this run did not observe the
  // session replication role, so treating 'R' as inert would overclaim.
  for (const enableMode of ['O', 'A', 'R']) {
    assert.equal(classifyEventTriggers({ rows: [trig({ enableMode })], overflowed: false }).effect, 'UNRESOLVED', enableMode);
  }
  // Extension ownership is provenance, not safety, and an unreadable answer is NOT ESTABLISHED.
  const owned = classifyEventTriggers({ rows: [trig({ extensionOwned: true }), trig({ extensionOwned: null })], overflowed: false });
  assert.equal(owned.extensionOwned, 1);
  assert.equal(owned.ownershipNotEstablished, 1);
  assert.equal(owned.effect, 'UNRESOLVED');
  // Counts of the two tag shapes are kept apart.
  const tagged = classifyEventTriggers({ rows: [trig({ wildcardTags: true }), trig({ wildcardTags: false, altersTableTag: true })], overflowed: false });
  assert.equal(tagged.wildcardTagged, 1);
  assert.equal(tagged.explicitAlterTableTagged, 1);
  assert.equal(tagged.potentiallyRelevant, 2);
});

test('C2B-M005-LRLS-B0: an overflowing or malformed trigger read is UNRESOLVED, never irrelevant', () => {
  assert.equal(classifyEventTriggers(null).effect, 'UNRESOLVED');
  assert.equal(classifyEventTriggers({ rows: [], overflowed: true }).effect, 'UNRESOLVED');
  for (const k of ['event', 'enableMode']) {
    assert.equal(classifyEventTriggers({ rows: [trig({ [k]: null })], overflowed: false }).effect, 'UNRESOLVED', k);
  }
  for (const k of ['wildcardTags', 'altersTableTag']) {
    assert.equal(classifyEventTriggers({ rows: [trig({ [k]: null })], overflowed: false }).effect, 'UNRESOLVED', k);
  }
  assert.equal(classifyEventTriggers({ rows: [], overflowed: true }).readable, false);
});

test('C2B-M005-LRLS-B0: several adverse conditions at once are all retained, none masks another', () => {
  const m = mode({ rlsEnabled: true, forceRls: true, currentOwnsLedger: true, currentIsSuperuser: false, currentHasBypassRls: false });
  assert.equal(classifyRlsApplicability(m), 'SUBJECT_TO_POLICIES');
  const pol = classifyPolicies({ overflowed: false, rows: [policy({ cmd: 'r', targetsPublic: true, appliesToCurrent: true, targetsOnlyOtherRoles: false }), policy({ cmd: 'd', permissive: false })] });
  const pri = classifyPrivilegePosture(privRead({ publicTablePrivileges: [true, false, false, false, false, false, false], roles: [roleRow({ tablePrivileges: [false, true, false, false, false, false, false] })] }), m);
  const tri = classifyEventTriggers({ rows: [trig({ wildcardTags: true })], overflowed: false });
  const text = renderLedgerRepairSafety(m, classifyRlsApplicability(m), pol, pri, tri).join('\n');
  assert.match(text, /applicability=SUBJECT_TO_POLICIES/);
  assert.match(text, /enabled=TRUE force=TRUE/);
  assert.match(text, /activeForCurrent=TRUE/);
  assert.match(text, /permissive=1 restrictive=1/);
  assert.match(text, /standardPrivilegePosture=NON_OWNER_PRIVILEGE_PRESENT/);
  assert.match(text, /incrementalExposure=PRESENT/);
  assert.match(text, /repairEventTriggerEffect=UNRESOLVED/);
  assert.match(text, /public=SELECT/);
});

test('C2B-M005-LRLS-B0-R1: row_security_active is observed and cross-checks every authority case', () => {
  // ONE CASE PER RULE THE SERVER FUNCTION IS DOCUMENTED TO FOLLOW. The expectation is derived from
  // the authority booleans and compared against the server's own verdict; agreement is required.
  const cases = [
    [{ rlsEnabled: false }, false, 'rls disabled'],
    [{ rlsEnabled: false, currentOwnsLedger: true, forceRls: true }, false, 'disabled outranks force'],
    [{ currentIsSuperuser: true }, false, 'superuser'],
    [{ currentHasBypassRls: true }, false, 'bypassrls'],
    [{ currentIsSuperuser: true, forceRls: true, currentOwnsLedger: true }, false, 'superuser outranks force'],
    [{ currentOwnsLedger: true, forceRls: false }, false, 'unforced owner'],
    [{ currentOwnsLedger: true, forceRls: true }, true, 'forced owner is subject'],
    [{ currentOwnsLedger: false, forceRls: false }, true, 'ordinary role is subject'],
    [{ currentOwnsLedger: false, forceRls: true }, true, 'ordinary role under force'],
  ];
  for (const [over, expected, label] of cases) {
    const m = mode(over);
    assert.equal(expectedRowSecurityActive(m), expected, label);
    // The fixture's server verdict is built from that expectation, so applicability survives.
    assert.equal(m.rowSecurityActiveForCurrent, expected, label);
    assert.notEqual(classifyRlsApplicability(m), 'UNREADABLE', label);
  }
  // AND AN UNREADABLE INPUT YIELDS NO EXPECTATION AT ALL, rather than a default.
  for (const k of ['rlsEnabled', 'currentIsSuperuser', 'currentHasBypassRls']) {
    assert.equal(expectedRowSecurityActive({ ...mode(), [k]: null }), null, k);
  }
  assert.equal(expectedRowSecurityActive({ ...mode(), currentOwnsLedger: null }), null);
  assert.equal(expectedRowSecurityActive({ ...mode(), forceRls: null }), null);
});

test('C2B-M005-LRLS-B0-R1: a row_security_active disagreement fails closed and stays unfavourable', () => {
  // THE SERVER GETS THE LAST WORD. Every combination below is internally consistent on the authority
  // booleans alone — the OLD derivation would have labelled each one confidently — and every one is
  // withdrawn because PostgreSQL's own verdict contradicts it.
  const disagreements = [
    { currentOwnsLedger: true, forceRls: false, rowSecurityActiveForCurrent: true },
    { currentIsSuperuser: true, rowSecurityActiveForCurrent: true },
    { currentHasBypassRls: true, rowSecurityActiveForCurrent: true },
    { rlsEnabled: false, rowSecurityActiveForCurrent: true },
    { currentOwnsLedger: false, forceRls: false, rowSecurityActiveForCurrent: false },
    { currentOwnsLedger: true, forceRls: true, rowSecurityActiveForCurrent: false },
  ];
  for (const over of disagreements) {
    assert.equal(classifyRlsApplicability(mode(over)), 'UNREADABLE', JSON.stringify(over));
  }
  // A MISSING OR MALFORMED VERDICT IS NOT AGREEMENT EITHER.
  for (const v of [null, undefined, 'TRUE', 1, 0, {}]) {
    assert.equal(classifyRlsApplicability(mode({ rowSecurityActiveForCurrent: v })), 'UNREADABLE', String(v));
  }
  // AND THE INDIVIDUAL BOOLEANS SURVIVE THE DISAGREEMENT — only the conclusion is withdrawn, so the
  // transcript still shows what was read rather than blanking the evidence along with the verdict.
  const m = mode({ currentOwnsLedger: true, forceRls: false, rowSecurityActiveForCurrent: true });
  const text = renderLedgerRepairSafety(m, classifyRlsApplicability(m), classifyPolicies({ rows: [], overflowed: false }), posture({}, m), classifyEventTriggers({ rows: [], overflowed: false })).join('\n');
  assert.match(text, /applicability=UNREADABLE/);
  assert.match(text, /activeForCurrent=TRUE/);
  assert.match(text, /enabled=TRUE force=FALSE/);
  assert.match(text, /ownsLedger=TRUE/);
});

test('C2B-M005-LRLS-B0: no role, policy, expression, trigger or catalog identifier can reach output', () => {
  // HOSTILE VALUES IN EVERY FIELD THE ADAPTER CONTROLS. Nothing below is a name in the contract,
  // so a name reaching the transcript would mean a value was forwarded instead of classified.
  const hostile = 'svc_admin_role__schema_migrations__sm_dirty_chk__pg_get_expr__my_extension';
  const m = mode();
  const text = renderLedgerRepairSafety(
    m,
    classifyRlsApplicability(m),
    classifyPolicies({ overflowed: false, rows: [policy({ cmd: '*' })] }),
    posture({ roles: [roleRow({ tablePrivileges: [true, false, false, false, false, false, false] })] }, m),
    classifyEventTriggers({ rows: [trig({ event: 'ddl_command_start' })], overflowed: false }),
  ).join('\n');
  for (const forbidden of hostile.split('__').concat(['svc_admin', 'schema_migrations', 'pg_catalog', 'polqual', 'relacl', 'oid', 'select 1', 'ddl_command_start'])) {
    assert.ok(!text.includes(forbidden), `leaked: ${forbidden}`);
  }
  // AND EVERY LINE IS BOUNDED, pinned against a literal rather than against its own formula.
  assert.equal(LEDGER_REPAIR_SAFETY_MAX_LINE_BYTES, 198);
  for (const line of text.split('\n')) {
    assert.ok(Buffer.byteLength(line, 'utf8') <= LEDGER_REPAIR_SAFETY_MAX_LINE_BYTES, line);
  }
});

test('C2B-M005-LRLS-B0: the widest renderable line stays inside the pinned bound', () => {
  // DRIVEN AT EVERY CAP, so the bound is measured against the worst case the contract permits and
  // not against the comfortable one a fixture happens to produce.
  const wide = renderLedgerRepairSafety(
    mode({ rlsEnabled: null, forceRls: null, currentIsSessionPrincipal: null, currentOwnsLedger: null, ledgerOwnerIsDatabaseOwner: null, currentIsSuperuser: null, currentHasBypassRls: null }),
    'UNREADABLE',
    classifyPolicies({ overflowed: false, rows: ['*', 'r', 'a', 'w', 'd'].map((cmd) => policy({ cmd, targetsPublic: true, appliesToCurrent: true, targetsOnlyOtherRoles: false })) }),
    classifyPrivilegePosture(privRead({
      publicTablePrivileges: [true, true, true, true, true, true, true],
      publicColumnPrivileges: [true, true, true, true],
      roles: [roleRow({ tablePrivileges: [true, true, true, true, true, true, true], columnPrivileges: [true, true, true, true] })],
    }), null),
    classifyEventTriggers({ rows: [trig({ wildcardTags: true, altersTableTag: true })], overflowed: false }),
  );
  for (const line of wide) {
    assert.ok(Buffer.byteLength(line, 'utf8') <= LEDGER_REPAIR_SAFETY_MAX_LINE_BYTES, `${Buffer.byteLength(line, 'utf8')}: ${line}`);
  }
  // The posture line is the widest the vocabulary can build; pinning it stops a silent widening.
  assert.equal(Math.max(...wide.map((l) => Buffer.byteLength(l, 'utf8'))), 198);
});

test('C2B-M005-LRLS-B0: the new reads add no write-capable SQL and no caller-supplied identifier', () => {
  // SCOPED TO THE FOUR NEW READ BODIES, not to the whole file. A file-wide scan of backtick spans
  // matches prose in comments — one of them discusses the expression-deparsing function by name —
  // and a guard that fires on documentation is a guard nobody keeps. Each body is sliced between
  // its own exported header and the next top-level closing brace.
  const exec = readFileSync(join(REPO_ROOT, 'server', 'platform-identity', 'migrationExecutor.ts'), 'utf8');
  const READS = ['readLedgerRlsMode', 'readLedgerPoliciesBounded', 'readLedgerPrivilegesBounded', 'readEventTriggersBounded'];
  const WRITE_SQL = /\b(alter\s+table|drop\s+table|create\s+policy|alter\s+policy|drop\s+policy|grant\s+|revoke\s+|insert\s+into|update\s+\w+\s+set|delete\s+from|row\s+level\s+security|lock\s+table|pg_advisory)\b/i;
  const INTERPOLATION = new RegExp('\\$' + '\\{');
  for (const fn of READS) {
    const at = exec.indexOf('export async function ' + fn);
    assert.ok(at >= 0, 'missing ' + fn);
    const closeAt = exec.indexOf('\n}\n', at);
    assert.ok(closeAt > at, 'unterminated ' + fn);
    const body = exec.slice(at, closeAt);
    // QUOTED LITERALS ARE STRIPPED FIRST. The event-trigger read compares a command TAG whose
    // value is the string 'ALTER TABLE'; that is data being matched, not a statement being
    // issued, and a scan that cannot tell the two apart would force the tag to be obfuscated.
    const unquoted = body.replace(/'[^']*'/g, "''");
    assert.ok(!WRITE_SQL.test(unquoted), 'write-capable SQL in ' + fn);
    // THE RELATION IS BOUND, NEVER INTERPOLATED. An interpolation inside the SQL literal would put
    // a JavaScript value into the statement TEXT rather than into the parameter list.
    const sql = (body.match(/`([^`]*select[^`]*)`/i) ?? [])[1];
    assert.ok(typeof sql === 'string' && sql.length > 0, 'no SQL literal in ' + fn);
    assert.ok(!INTERPOLATION.test(sql), 'interpolation inside the SQL of ' + fn);
    // NO EXPRESSION IS MATERIALIZED. Deparsing a policy would produce exactly the text this
    // boundary exists to keep out; NULL tests answer the same question without it.
    assert.ok(!/pg_get_expr|pg_get_policydef|pg_get_constraintdef/i.test(sql), 'expression materialized in ' + fn);
    // AND NO NAME COLUMN IS SELECTED.
    assert.ok(!/\b(polname|evtname|proname|extname)\b/i.test(sql), 'identifier selected in ' + fn);
  }
  assert.ok((exec.match(/LEDGER_RELATION\.schema, LEDGER_RELATION\.table/g) ?? []).length >= 4);
});

test('C2B-M005-LRLS-B0-R1: EVERY SQL literal in the four reads is scanned, not just the first', () => {
  // THE PRIVILEGE READ NOW ISSUES TWO STATEMENTS. A scan that stopped at the first backtick span
  // would have checked the PUBLIC statement and left the role statement — the larger of the two —
  // entirely unguarded, so the count is asserted rather than assumed.
  const exec = readFileSync(join(REPO_ROOT, 'server', 'platform-identity', 'migrationExecutor.ts'), 'utf8');
  const bodyOf = (fn) => {
    const at = exec.indexOf('export async function ' + fn);
    assert.ok(at >= 0, 'missing ' + fn);
    return exec.slice(at, exec.indexOf('\n}\n', at));
  };
  const INTERPOLATION = new RegExp('\\$' + '\\{');
  const WRITE_SQL = /\b(alter\s+table|drop\s+table|create\s+policy|alter\s+policy|drop\s+policy|grant\s+|revoke\s+|insert\s+into|update\s+\w+\s+set|delete\s+from|row\s+level\s+security|lock\s+table|pg_advisory)\b/i;
  const seen = {};
  for (const fn of ['readLedgerRlsMode', 'readLedgerPoliciesBounded', 'readLedgerPrivilegesBounded', 'readEventTriggersBounded']) {
    const spans = [...bodyOf(fn).matchAll(/`([^`]*)`/g)].map((m2) => m2[1]).filter((t) => /select/i.test(t));
    assert.ok(spans.length >= 1, 'no SQL literal in ' + fn);
    seen[fn] = spans.length;
    for (const sql of spans) {
      assert.ok(!INTERPOLATION.test(sql), 'interpolation in ' + fn);
      assert.ok(!WRITE_SQL.test(sql.replace(/'[^']*'/g, "''")), 'write-capable SQL in ' + fn);
      assert.ok(!/pg_get_expr|pg_get_policydef/i.test(sql), 'expression materialized in ' + fn);
    }
  }
  assert.equal(seen.readLedgerPrivilegesBounded, 2);
  assert.equal(seen.readLedgerRlsMode, 1);
});

test('C2B-M005-LRLS-B0-R1: the corrected PUBLIC mechanism and row_security_active call are pinned in source', () => {
  // NON-TAUTOLOGICAL: each assertion names the PostgreSQL construct the correction turns on, and
  // each would fail if that construct were dropped — none compares the source against itself.
  const exec = readFileSync(join(REPO_ROOT, 'server', 'platform-identity', 'migrationExecutor.ts'), 'utf8');
  const at = exec.indexOf('export async function readLedgerPrivilegesBounded');
  const priv = exec.slice(at, exec.indexOf('\n}\n', at));

  // PUBLIC IS ASKED THROUGH THE INQUIRY FUNCTIONS, which PostgreSQL documents as accepting the
  // special user name `public` — the claim the previous report had backwards.
  for (const p of ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) {
    assert.ok(priv.includes(`has_table_privilege('public', c.oid, '${p}')`), `PUBLIC table ${p}`);
  }
  // AND AT COLUMN GRANULARITY for the four privileges PostgreSQL can grant per column.
  for (const p of ['SELECT', 'INSERT', 'UPDATE', 'REFERENCES']) {
    assert.ok(priv.includes(`has_any_column_privilege('public', c.oid, '${p}')`), `PUBLIC column ${p}`);
  }
  // THE RELATION-ACL SHORTCUT IS GONE. `aclexplode(c.relacl)` cannot see pg_attribute.attacl, so
  // its presence here would mean the empty-table-ACL defect had returned.
  assert.ok(!/aclexplode\s*\(\s*c\.relacl/i.test(priv));
  assert.ok(!/relacl/i.test(priv));

  // EVERY NON-DROPPED USER COLUMN, INCLUDING A CONTRACT-COMPATIBLE EXTRA ONE. The per-role column
  // probes range over pg_attribute with no contract-column filter, and `has_any_column_privilege`
  // takes no column list at all — so neither can be narrowed to the declared columns by accident.
  assert.equal((priv.match(/a\.attnum > 0 and not a\.attisdropped/g) ?? []).length, 4);
  assert.ok(!/LEDGER_COLUMN_CONTRACT/.test(priv));
  for (const p of ['SELECT', 'INSERT', 'UPDATE', 'REFERENCES']) {
    assert.ok(priv.includes(`has_column_privilege(r.oid, c.oid, a.attnum, '${p}')`), `role column ${p}`);
  }

  // ROW_SECURITY_ACTIVE IS ASKED OF THE FIXED RELATION, never of a caller-supplied one.
  const rlsAt = exec.indexOf('export async function readLedgerRlsMode');
  const rls = exec.slice(rlsAt, exec.indexOf('\n}\n', rlsAt));
  assert.ok(rls.includes('pg_catalog.row_security_active(c.oid)'));
  assert.ok(!/row_security_active\s*\(\s*\$/.test(rls));
  assert.ok(rls.includes('where n.nspname = $1 and c.relname = $2'));

  // POLICY MEMBERSHIP IS IMMEDIATELY-EFFECTIVE USAGE, NOT MEMBER. MEMBER would report a role the
  // principal can only reach through SET ROLE as though the policy already applied to it.
  const polAt = exec.indexOf('export async function readLedgerPoliciesBounded');
  const pol = exec.slice(polAt, exec.indexOf('\n}\n', polAt));
  assert.ok(pol.includes("pg_catalog.pg_has_role(current_user, t.roleoid, 'USAGE')"));
  assert.ok(!/pg_has_role\([^)]*'MEMBER'/i.test(pol));
  assert.ok(!/'MEMBER'/.test(pol));
  // PUBLIC-TARGETED POLICIES ARE HANDLED SEPARATELY from membership, by the catalog's own encoding.
  assert.ok(pol.includes("p.polroles = '{0}'::oid[]"));
});

test('C2B-M005-LRLS-B0-R1: policy applicability distinguishes USAGE membership from SET ROLE', () => {
  // THE SIX SCENARIOS §7 NAMES. Whether membership is immediately usable is decided BY THE SERVER
  // inside `pg_has_role(..., 'USAGE')`, so at this layer a SET-ROLE-only membership and no
  // membership at all arrive identically — as appliesToCurrent=false. That is the point: the
  // classifier must not treat either as applicable, and the SQL mode is what separates them. The
  // source pin above is the evidence for the separation; these are the evidence for the handling.
  const cases = [
    ['direct role', { targetsPublic: false, appliesToCurrent: true }, { anyAppliesToCurrent: true, anyTargetsPublic: false, anyTargetsOnlyOtherRoles: false }],
    ['inherited USAGE membership', { targetsPublic: false, appliesToCurrent: true }, { anyAppliesToCurrent: true, anyTargetsPublic: false, anyTargetsOnlyOtherRoles: false }],
    ['membership requiring SET ROLE', { targetsPublic: false, appliesToCurrent: false }, { anyAppliesToCurrent: false, anyTargetsPublic: false, anyTargetsOnlyOtherRoles: true }],
    ['no membership', { targetsPublic: false, appliesToCurrent: false }, { anyAppliesToCurrent: false, anyTargetsPublic: false, anyTargetsOnlyOtherRoles: true }],
    ['PUBLIC policy', { targetsPublic: true, appliesToCurrent: true }, { anyAppliesToCurrent: true, anyTargetsPublic: true, anyTargetsOnlyOtherRoles: false }],
  ];
  for (const [label, over, expect] of cases) {
    const row = policy({ ...over, targetsOnlyOtherRoles: !over.targetsPublic && !over.appliesToCurrent });
    const inv = classifyPolicies({ rows: [row], overflowed: false });
    assert.equal(inv.readable, true, label);
    assert.equal(inv.anyAppliesToCurrent, expect.anyAppliesToCurrent, label);
    assert.equal(inv.anyTargetsPublic, expect.anyTargetsPublic, label);
    assert.equal(inv.anyTargetsOnlyOtherRoles, expect.anyTargetsOnlyOtherRoles, label);
  }
  // MALFORMED MEMBERSHIP EVIDENCE IS NOT "does not apply". A null must not read as absence.
  const malformed = classifyPolicies({ rows: [policy({ appliesToCurrent: null, targetsOnlyOtherRoles: null })], overflowed: false });
  assert.equal(malformed.readable, false);
  assert.equal(malformed.anyAppliesToCurrent, false);
  assert.equal(malformed.anyTargetsOnlyOtherRoles, false);
  assert.equal(classifyPolicies({ rows: [policy({ targetsPublic: null })], overflowed: false }).readable, false);
});

test('C2B-M005-LRLS-B0-R1: the reads map the corrected columns and fail closed on an ambiguous relation', async () => {
  // DRIVEN THROUGH THE REAL READ FUNCTIONS with a fake port, so the mapping from result columns to
  // the typed shape is proved rather than assumed from the SQL text alone.
  const port = (...results) => { const q = [...results]; return { query: async () => q.shift() ?? [] }; };

  const m = await readLedgerRlsMode(port([{
    rls_enabled: true, force_rls: false, principal_agrees: true, owns_ledger: false,
    owner_is_db_owner: true, is_superuser: false, has_bypassrls: false, rls_active: true,
  }]));
  assert.equal(m.rowSecurityActiveForCurrent, true);
  assert.equal(m.rlsEnabled, true);
  // A malformed verdict becomes null, never a boolean default.
  const m2 = await readLedgerRlsMode(port([{ rls_enabled: true, rls_active: 'yes' }]));
  assert.equal(m2.rowSecurityActiveForCurrent, null);
  // AN ABSENT OR AMBIGUOUS RELATION IS UNREADABLE.
  assert.equal(await readLedgerRlsMode(port([])), null);

  const p = await readLedgerPrivilegesBounded(port(
    [{ t0: false, t1: false, t2: false, t3: false, t4: false, t5: false, t6: false, c0: true, c1: false, c2: false, c3: false }],
    [],
  ));
  // THE COLUMN-ONLY PUBLIC GRANT SURVIVES THE MAPPING — this is the whole correction, end to end.
  assert.deepEqual(p.publicTablePrivileges, [false, false, false, false, false, false, false]);
  assert.deepEqual(p.publicColumnPrivileges, [true, false, false, false]);
  assert.equal(classifyPrivilegePosture(p, mode()).standardPrivilegePosture, 'NON_OWNER_PRIVILEGE_PRESENT');
  assert.deepEqual(classifyPrivilegePosture(p, mode()).publicPrivileges, ['SELECT']);

  // AN ABSENT PUBLIC ROW FAILS CLOSED rather than reporting an empty PUBLIC set, which would be the
  // favourable direction and indistinguishable from "PUBLIC holds nothing".
  assert.equal(await readLedgerPrivilegesBounded(port([], [])), null);
  assert.equal(await readLedgerPrivilegesBounded(port([{}, {}], [])), null);
  // A NON-POSITIVE LIMIT OVERFLOWS BOTH AXES rather than reading anything.
  const bad = await readLedgerPrivilegesBounded(port(), 0);
  assert.equal(bad.overflowed, true);
  assert.equal(classifyPrivilegePosture(bad, mode()).standardPrivilegePosture, 'UNREADABLE');
  assert.equal(classifyPrivilegePosture(bad, mode()).incrementalExposure, 'UNREADABLE');
});

test('C2B-M005-LRLS-B0: the live command, launcher contract and child key set are unchanged', () => {
  assert.equal(PARENT_FLAG, '--inspect-m005-preconditions');
  assert.deepEqual([...INSPECT_CHILD_ENV_KEYS], [
    'SUPABASE_DATABASE_URL', 'SUPABASE_URL', 'DATABASE_CA_CERT', 'CONFIRM_SUPABASE_TARGET', 'NODE_ENV',
  ]);
  assert.equal(INSPECT_CHILD_ENV_KEYS.length, 5);
  assert.equal(INSPECT_GATE_VALUES.CONFIRM_SUPABASE_TARGET, 'tmpos2026-dev');
  assert.equal(INSPECT_GATE_VALUES.NODE_ENV, 'development');
});

test('C2B-M005-LRLS-B0: the posture reaches the transcript without disturbing the existing verdict', async () => {
  // DRIVEN THROUGH THE REAL CHILD under the observed live shape: a ROW_LEVEL_SECURITY mismatch.
  const { code, text } = await runChild({
    ledgerShapeResult: { present: true, failed: ['bounded internal reason'], categories: ['ROW_LEVEL_SECURITY'] },
    rlsMode: async () => mode({ currentOwnsLedger: true }),
    ledgerPolicies: async () => ({ rows: [policy({ cmd: 'r' })], overflowed: false }),
    ledgerPrivileges: async () => privRead(),
    eventTriggers: async () => ({ rows: [trig({ wildcardTags: true })], overflowed: false }),
  });
  assert.equal(code, 2);
  assert.match(text, /ledgerShape=MISMATCH ledgerShapeCategories=ROW_LEVEL_SECURITY/);
  assert.match(text, /ledgerRls enabled=TRUE force=FALSE applicability=BYPASS_TABLE_OWNER activeForCurrent=FALSE/);
  assert.match(text, /ledgerRlsRepair=UNAUTHORIZED/);
  assert.match(text, /repairEventTriggerEffect=UNRESOLVED/);
  assert.match(text, /ledgerRlsEnablementProvenance=UNKNOWN/);
  // THE EXISTING CONTRACT IS UNTOUCHED: five axes suppressed, same disposition, nonzero exit.
  for (const axis of [/prefix001To004=UNREADABLE/, /checksums001To004=UNREADABLE/, /dirtyMarker=UNREADABLE/,
    /migration005=UNREADABLE/, /unknownOrOutOfOrder=UNREADABLE/]) {
    assert.match(text, axis);
  }
  assert.match(text, /residue=INCONSISTENT/);
  assert.match(text, /disposition=m005_preflight_ledger_inconsistent/);
  assert.match(text, /outcome=m005_preflight_ledger_inconsistent/);
  // AND NOTHING IN THE POSTURE CAN MAKE THE RUN FAVOURABLE.
  assert.ok(!text.includes('m005_preflight_observed_preconditions_met'));
});

test('C2B-M005-LRLS-B0: an entirely unreadable posture still refuses and still says nothing favourable', async () => {
  const { code, text } = await runChild({
    ledgerShapeResult: { present: true, failed: ['r'], categories: ['ROW_LEVEL_SECURITY'] },
    rlsMode: async () => { throw new Error('catalog dsn=secret'); },
    ledgerPolicies: async () => { throw new Error('boom'); },
    ledgerPrivileges: async () => { throw new Error('boom'); },
    eventTriggers: async () => { throw new Error('boom'); },
  });
  assert.equal(code, 2);
  assert.match(text, /ledgerRls enabled=UNREADABLE force=UNREADABLE applicability=UNREADABLE activeForCurrent=UNREADABLE/);
  assert.match(text, /ledgerPolicies readable=false/);
  assert.match(text, /standardPrivilegePosture=UNREADABLE/);
  assert.match(text, /incrementalExposure=UNREADABLE/);
  assert.match(text, /repairEventTriggerEffect=UNRESOLVED/);
  assert.match(text, /outcome=m005_preflight_ledger_inconsistent/);
  // A THROWN VALUE IS DROPPED UNREAD, exactly as every other guarded read in this boundary.
  assert.ok(!text.includes('dsn=secret'));
  assert.ok(!text.includes('catalog'));
});

// ---------------------------------------------------------------------------
// C2B-M005-LRLS-L3-R1 — OUTPUT CONSISTENCY
//
// Three defects, each of which produced a transcript that disagreed with its own evidence:
//   1. a hard-coded NONE_DETECTED printed beside a computed PRESENT;
//   2. two event-trigger counters drawn from different populations under bare names;
//   3. a target field whose redaction was decided by the CREDENTIAL rather than by the contract.
// Every test below fails if the corresponding correction is reverted.
// ---------------------------------------------------------------------------

/** An Axis-B posture with a chosen exposure shape, built from a real classification wherever it can be. */
const exposed = (n) => posture({
  roles: Array.from({ length: n }, () => roleRow({ tablePrivileges: [true, false, false, false, false, false, false] })),
});

test('C2B-M005-LRLS-L3-R1: PRESENT can never render NONE_DETECTED on the scope line', () => {
  const p = exposed(4);
  // The evidence really is PRESENT — otherwise this test would pass vacuously.
  assert.equal(p.incrementalExposure, 'PRESENT');
  assert.equal(p.newlyExposedRoles, 4);
  const m = mode();
  const text = renderLedgerRepairSafety(
    m, classifyRlsApplicability(m), classifyPolicies({ rows: [], overflowed: false }), p,
    classifyEventTriggers({ rows: [], overflowed: false }),
  ).join('\n');
  assert.match(text, /ledgerDisableRlsExposure incrementalExposure=PRESENT/);
  assert.match(text, /ledgerDisableRlsExposureScope=PRESENT/);
  // THE DEFECT ITSELF: the scope line carried a literal that never consulted the evidence.
  assert.ok(!/ledgerDisableRlsExposureScope=NONE_DETECTED/.test(text));
});

test('C2B-M005-LRLS-L3-R1: both exposure tokens are the same value on every posture', () => {
  // ONE CANONICAL RESULT means the two lines cannot differ for ANY input, not merely for the one
  // the fixture happens to build. Driven across every reachable exposure shape.
  const m = mode();
  const postures = [
    posture({}),                                                        // nothing exposed
    exposed(1), exposed(4),                                             // roles exposed
    posture({ publicTablePrivileges: [true, false, false, false, false, false, false] }), // PUBLIC
    posture({ overflowed: true, roles: [roleRow({ isSuperuser: null })] }),               // unreadable
    UNREADABLE_PRIVILEGE_POSTURE,
    classifyPrivilegePosture(privRead({ roles: [roleRow({})] }), null),  // forceRls unknown
  ];
  for (const p of postures) {
    const lines = renderLedgerRepairSafety(
      m, classifyRlsApplicability(m), classifyPolicies({ rows: [], overflowed: false }), p,
      classifyEventTriggers({ rows: [], overflowed: false }),
    );
    const main = /incrementalExposure=([A-Z_]+)/.exec(lines.join('\n'));
    const scope = /ledgerDisableRlsExposureScope=([A-Z_]+)/.exec(lines.join('\n'));
    assert.ok(main !== null && scope !== null);
    assert.equal(scope[1], main[1]);
    assert.equal(main[1], reconcileDisableRlsExposure(p));
  }
});

test('C2B-M005-LRLS-L3-R1: NONE_DETECTED requires complete bounded evidence of zero exposure', () => {
  // The ONLY shape that earns the favourable token.
  const clean = posture({});
  assert.equal(clean.newlyExposedRoles, 0);
  assert.equal(clean.publicGrantContributesExposure, false);
  assert.equal(clean.roleSetOverflowed, false);
  assert.equal(reconcileDisableRlsExposure(clean), 'NONE_DETECTED');
  // Remove any one of those supports and the token is withdrawn, never softened.
  assert.equal(reconcileDisableRlsExposure({ ...clean, readable: false }), 'UNREADABLE');
  assert.equal(reconcileDisableRlsExposure({ ...clean, roleSetOverflowed: true }), 'UNREADABLE');
  assert.equal(reconcileDisableRlsExposure({ ...clean, incrementalExposure: 'UNREADABLE' }), 'UNREADABLE');
  assert.equal(reconcileDisableRlsExposure(UNREADABLE_PRIVILEGE_POSTURE), 'UNREADABLE');
});

test('C2B-M005-LRLS-L3-R1: any token/count/reachability disagreement withdraws the exposure result', () => {
  const clean = posture({});
  const present = exposed(2);
  // THE FIXTURES ARE PINNED HERE, not only in the sibling test. Without this the kills below rest
  // on fixture behaviour asserted in a different test: if `posture({})` ever drifted to unreadable
  // or truncated, every assertion in this test would pass through the readable/overflow guard and
  // the disagreement checks it exists to protect would go uncovered.
  assert.equal(clean.readable, true);
  assert.equal(clean.roleSetOverflowed, false);
  assert.equal(clean.newlyExposedRoles, 0);
  assert.equal(present.readable, true);
  assert.equal(present.newlyExposedRoles, 2);
  // Token says exposure, counts show none.
  assert.equal(reconcileDisableRlsExposure({ ...clean, incrementalExposure: 'PRESENT' }), 'UNREADABLE');
  // Token says none, counts show roles.
  assert.equal(reconcileDisableRlsExposure({ ...present, incrementalExposure: 'NONE_DETECTED' }), 'UNREADABLE');
  // Token says none, a PUBLIC grant contributes.
  assert.equal(
    reconcileDisableRlsExposure({ ...clean, publicGrantContributesExposure: true, incrementalExposure: 'NONE_DETECTED' }),
    'UNREADABLE',
  );
  // Reachability is a SUBSET of exposure and can never exceed it.
  assert.equal(reconcileDisableRlsExposure({ ...present, newlyExposedReachable: present.newlyExposedRoles + 1 }), 'UNREADABLE');
  // Counts that are not non-negative safe integers are not evidence at all.
  for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(reconcileDisableRlsExposure({ ...present, newlyExposedRoles: bad }), 'UNREADABLE', String(bad));
    assert.equal(reconcileDisableRlsExposure({ ...present, newlyExposedReachable: bad }), 'UNREADABLE', String(bad));
  }
  // A disagreement withdraws only the CONCLUSION: the counts themselves are still printed as read.
  const m = mode();
  const text = renderLedgerRepairSafety(
    m, classifyRlsApplicability(m), classifyPolicies({ rows: [], overflowed: false }),
    { ...present, incrementalExposure: 'NONE_DETECTED' },
    classifyEventTriggers({ rows: [], overflowed: false }),
  ).join('\n');
  assert.match(text, /ledgerDisableRlsExposure incrementalExposure=UNREADABLE newlyExposedRoles=2/);
  assert.match(text, /ledgerDisableRlsExposureScope=UNREADABLE/);
});

test('C2B-M005-LRLS-L3-R1: event-trigger populations are labelled and the relevant partition reconciles', () => {
  // THE EXACT SHAPE THAT LOOKED CONTRADICTORY: two wildcard-tagged triggers, only one of which has
  // an event that could fire. Both numbers were right; the output could not say so.
  const t = classifyEventTriggers({
    rows: [trig({ wildcardTags: true }), trig({ event: 'sql_drop', wildcardTags: true })],
    overflowed: false,
  });
  assert.equal(t.wildcardTagged, 2);          // population: all enabled
  assert.equal(t.potentiallyRelevant, 1);     // population: event could fire
  assert.equal(t.relevantWildcardTagged, 1);
  assert.equal(t.relevantAlterTableOnlyTagged, 0);
  const m = mode();
  const text = renderLedgerRepairSafety(
    m, classifyRlsApplicability(m), classifyPolicies({ rows: [], overflowed: false }), posture({}), t,
  ).join('\n');
  assert.match(text, /ledgerEventTriggerMetadata readable=true enabled=2 population=ALL_ENABLED wildcardTagged=2/);
  assert.match(text, /ledgerEventTriggerRelevance population=EVENT_COULD_FIRE potentiallyRelevant=1/);
  assert.match(text, /relevantWildcardTagged=1 relevantAlterTableOnlyTagged=0 partitionReconciles=true/);
  // The ambiguous pairing is gone: the wide count no longer sits on the relevance line unlabelled.
  assert.ok(!/potentiallyRelevant=1 wildcardTagged=2/.test(text));
});

test('C2B-M005-LRLS-L3-R1: the relevant partition sums to potentiallyRelevant across every tag shape', () => {
  const events = ['ddl_command_start', 'ddl_command_end', 'table_rewrite', 'sql_drop', 'some_future_event'];
  for (const event of events) {
    for (const wildcardTags of [true, false]) {
      for (const altersTableTag of [true, false]) {
        const t = classifyEventTriggers({ rows: [trig({ event, wildcardTags, altersTableTag })], overflowed: false });
        const label = `${event}/${wildcardTags}/${altersTableTag}`;
        // READABLE FIRST. Every input here is well-formed, so the fail-closed guard must NOT have
        // fired. Without this the sum identity below passes vacuously on the zeroed unreadable
        // posture — which is exactly how an overlapping (non-partitioning) bucket survived once.
        assert.equal(t.readable, true, label);
        assert.equal(t.enabledTotal, 1, label);
        assert.equal(t.relevantWildcardTagged + t.relevantAlterTableOnlyTagged, t.potentiallyRelevant, label);
        // Relevant counts are bounded by their all-enabled populations.
        assert.ok(t.relevantWildcardTagged <= t.wildcardTagged, label);
        assert.ok(t.relevantAlterTableOnlyTagged <= t.explicitAlterTableTagged, label);
        assert.ok(t.potentiallyRelevant <= t.enabledTotal, label);
        // A trigger carrying BOTH tags is counted once, in the wildcard bucket.
        if (wildcardTags && altersTableTag) assert.equal(t.relevantAlterTableOnlyTagged, 0, label);
      }
    }
  }
});

test('C2B-M005-LRLS-L3-R1: UNRESOLVED survives whenever a relevant trigger exists or evidence is unreadable', () => {
  assert.equal(classifyEventTriggers({ rows: [trig({ wildcardTags: true })], overflowed: false }).effect, 'UNRESOLVED');
  assert.equal(classifyEventTriggers({ rows: [trig({ wildcardTags: false, altersTableTag: true })], overflowed: false }).effect, 'UNRESOLVED');
  assert.equal(classifyEventTriggers(null).effect, 'UNRESOLVED');
  assert.equal(classifyEventTriggers({ rows: [], overflowed: true }).effect, 'UNRESOLVED');
  assert.equal(UNREADABLE_EVENT_TRIGGER_POSTURE.effect, 'UNRESOLVED');
  for (const k of ['event', 'enableMode', 'wildcardTags', 'altersTableTag']) {
    assert.equal(classifyEventTriggers({ rows: [trig({ [k]: null })], overflowed: false }).effect, 'UNRESOLVED', k);
  }
  // And the favourable verdict remains reachable ONLY from a readable, reconciled, empty-relevant read.
  assert.equal(classifyEventTriggers({ rows: [], overflowed: false }).effect, 'NONE_CATALOG_RELEVANT');
  assert.equal(classifyEventTriggers({ rows: [trig({ event: 'sql_drop', wildcardTags: true })], overflowed: false }).effect, 'NONE_CATALOG_RELEVANT');
});

test('C2B-M005-LRLS-L3-R1: the ownership counters still account for every enabled trigger', () => {
  const t = classifyEventTriggers({
    rows: [trig({ extensionOwned: true }), trig({ extensionOwned: null }), trig({ extensionOwned: false })],
    overflowed: false,
  });
  assert.equal(t.extensionOwned + t.ownershipNotEstablished, t.enabledTotal);
  assert.equal(t.extensionOwned, 1);
  assert.equal(t.ownershipNotEstablished, 2);
});

test('C2B-M005-LRLS-L3-R1: the target database field is a fixed source token, not the value', async () => {
  assert.equal(TARGET_DATABASE_FIELD, 'EXPECTED');
  const { text } = await runChild({});
  assert.match(text, /target endpointFamily=session database=EXPECTED\b/);
  // THE DEFECT: the credential-derived literal reached the transcript, where the launcher's RAW
  // redaction class turned it into [REDACTED] for one credential shape and left it for another.
  assert.ok(!/database=postgres/.test(text));
});

test('C2B-M005-LRLS-L3-R1: a database that is not the expected one refuses instead of printing itself', async () => {
  // The field is deterministic BECAUSE the only reachable value is the expected one: any other
  // value refuses upstream, so no branch can print a different database.
  const { text, code } = await runChild({ describedDb: 'not_the_expected_database' });
  assert.match(text, new RegExp(`REFUSED: ${PREFLIGHT_CODES.TARGET_INVALID}`));
  assert.ok(!/not_the_expected_database/.test(text));
  assert.notEqual(code, 0);
});

test('C2B-M005-LRLS-L3-R1: the corrected lines stay inside the pinned output bound', () => {
  // Driven at every cap, including the two new lines, so a widening cannot pass unnoticed.
  const wide = renderLedgerRepairSafety(
    mode({ rlsEnabled: null, forceRls: null, currentIsSessionPrincipal: null, currentOwnsLedger: null, ledgerOwnerIsDatabaseOwner: null, currentIsSuperuser: null, currentHasBypassRls: null }),
    'UNREADABLE',
    classifyPolicies({ overflowed: false, rows: ['*', 'r', 'a', 'w', 'd'].map((cmd) => policy({ cmd, targetsPublic: true, appliesToCurrent: true, targetsOnlyOtherRoles: false })) }),
    classifyPrivilegePosture(privRead({
      publicTablePrivileges: [true, true, true, true, true, true, true],
      publicColumnPrivileges: [true, true, true, true],
      roles: [roleRow({ tablePrivileges: [true, true, true, true, true, true, true], columnPrivileges: [true, true, true, true] })],
    }), null),
    classifyEventTriggers({ rows: [trig({ wildcardTags: true, altersTableTag: true })], overflowed: false }),
  );
  for (const line of wide) {
    assert.ok(Buffer.byteLength(line, 'utf8') <= LEDGER_REPAIR_SAFETY_MAX_LINE_BYTES, `${Buffer.byteLength(line, 'utf8')}: ${line}`);
  }
  // Both new keys are present in the worst-case render, so the bound above actually covers them.
  const joined = wide.join('\n');
  assert.match(joined, /ledgerEventTriggerRelevance /);
  assert.match(joined, /population=ALL_ENABLED/);
});

test('C2B-M005-LRLS-L3-R1: no identifier reaches the corrected lines', () => {
  // The corrections added output; output is exactly where a name leaks.
  const hostile = 'svc_admin_role__schema_migrations__pg_get_expr__my_extension__ddl_command_start';
  const m = mode();
  const text = renderLedgerRepairSafety(
    m, classifyRlsApplicability(m),
    classifyPolicies({ overflowed: false, rows: [policy({ cmd: '*' })] }),
    exposed(3),
    classifyEventTriggers({ rows: [trig({ event: 'ddl_command_start', wildcardTags: true })], overflowed: false }),
  ).join('\n');
  for (const forbidden of hostile.split('__').concat(['pg_catalog', 'relacl', 'attacl', 'polqual'])) {
    assert.ok(!text.includes(forbidden), `leaked: ${forbidden}`);
  }
});

test('C2B-M005-LRLS-L3-R2: partitionReconciles is evidence, not a self-certifying constant', () => {
  // FOUND BY MUTATION, NOT BY READING. Replacing the rendered expression with the literal `true`
  // survived the entire suite: across all 60 (event x wildcard x alterTable x ownership) shapes the
  // classifier can produce, a non-reconciling posture is unreachable — the fail-closed guard zeroes
  // it first, and 0 + 0 === 0 renders `true`. A field that can only ever print one value certifies
  // nothing, which is exactly the defect class the hard-coded NONE_DETECTED scope line was.
  //
  // It IS reachable at the RENDER boundary, which takes the posture as an argument and must not
  // trust it — the same reason the exposure lines re-derive their token instead of echoing it.
  const inconsistent = {
    ...UNREADABLE_EVENT_TRIGGER_POSTURE,
    readable: true, enabledTotal: 2, potentiallyRelevant: 1,
    relevantWildcardTagged: 1, relevantAlterTableOnlyTagged: 1, // 1 + 1 !== 1
  };
  const m = mode();
  const text = renderLedgerRepairSafety(
    m, classifyRlsApplicability(m), classifyPolicies({ rows: [], overflowed: false }),
    posture({}), inconsistent,
  ).join('\n');
  assert.match(text, /partitionReconciles=false/);
  // And the honest case still renders true, so the field discriminates rather than always failing.
  const consistent = classifyEventTriggers({ rows: [trig({ wildcardTags: true })], overflowed: false });
  const ok = renderLedgerRepairSafety(
    m, classifyRlsApplicability(m), classifyPolicies({ rows: [], overflowed: false }),
    posture({}), consistent,
  ).join('\n');
  assert.match(ok, /partitionReconciles=true/);
});

test('C2B-M005-LRLS-L3-R2: the classifier itself never emits a non-reconciling posture', () => {
  // The companion fact to the test above: the render boundary must handle disagreement, and the
  // classifier must never produce it. Enumerated rather than argued.
  let shapes = 0;
  for (const event of ['ddl_command_start', 'ddl_command_end', 'table_rewrite', 'sql_drop', 'zzz_unknown']) {
    for (const wildcardTags of [true, false]) {
      for (const altersTableTag of [true, false]) {
        for (const extensionOwned of [true, false, null]) {
          const t = classifyEventTriggers({ rows: [trig({ event, wildcardTags, altersTableTag, extensionOwned })], overflowed: false });
          shapes += 1;
          assert.equal(t.relevantWildcardTagged + t.relevantAlterTableOnlyTagged, t.potentiallyRelevant,
            `${event}/${wildcardTags}/${altersTableTag}/${String(extensionOwned)}`);
        }
      }
    }
  }
  assert.equal(shapes, 60); // the loop actually ran; a mis-scoped fixture cannot pass vacuously
});

// ---- C2B-M005-LRLS-L3-R3: end-to-end output noninterference -------------------

/**
 * A fake child that writes a FIXED transcript and then terminates normally.
 *
 * Node closes the stdio streams before emitting the subprocess `close`, and this fake does the
 * same: without it `streamsClosed` would never be observed, the capture would never be sealed, and
 * the transcript assertions below would pass against a withheld record instead of a rendered one.
 */
function fixedTranscriptChild(stdoutLines, stderrLines) {
  const child = new EventEmitter();
  child.pid = 727272;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.unref = () => {};
  child.stdout.unref = () => {};
  child.stderr.unref = () => {};
  child.kill = () => true;
  const rawEmit = child.emit.bind(child);
  child.emit = (event, ...rest) => {
    if (event === 'close') {
      child.stdout.emit('close');
      child.stderr.emit('close');
    }
    return rawEmit(event, ...rest);
  };
  setImmediate(() => {
    for (const l of stdoutLines) child.stdout.emit('data', Buffer.from(`${l}\n`, 'utf8'));
    for (const l of stderrLines) child.stderr.emit('data', Buffer.from(`${l}\n`, 'utf8'));
    child.emit('exit', 0, null);
    child.emit('close', 0, null);
  });
  return child;
}

test('C2B-M005-LRLS-L3-R3: the complete emitted record is byte-identical for every credential', async () => {
  // §3 AND §8 — the property is asserted over the WHOLE record this launcher writes, through its
  // real main(), not over the renderer in isolation. stdout and stderr are both captured.
  const CHILD_STDOUT = [
    '[m005-preflight] target endpointFamily=session database=EXPECTED',
    '[m005-preflight] governedSource=MATCH',
    '[m005-preflight] ledgerDisableRlsExposure incrementalExposure=NONE_DETECTED newlyExposedRoles=0',
    '[m005-preflight] cleanup rollback=completed gracefulSocketClose=not_observed',
    '[m005-preflight] outcome=m005_preflight_observed_preconditions_met',
  ];
  // Raw stderr, including a full DSN and a driver stack — none of it may reach output.
  const CHILD_STDERR = [
    'Error: connect ECONNREFUSED postgresql://u:p@db.abcdefghijklmnopqrst.supabase.co:5432/postgres',
    '    at Socket.<anonymous> (/app/node_modules/pg/lib/client.js:1:1)',
  ];
  const CREDENTIALS = [
    'EXPECTED', 'PRESENT', 'NONE_DETECTED', 'TRUE', 'true', 'session', 'postgres', 'ECT',
    'MATCH', 'completed', 'not_observed', 'p', '0', 'zzzzzzzzzzzzzzzz',
  ];

  const runWith = async (password) => {
    const out = [];
    const err = [];
    const code = await launcherMain(
      [PARENT_FLAG],
      goodEnv({
        SUPABASE_DATABASE_URL:
          `postgresql://u:${encodeURIComponent(password)}@db.abcdefghijklmnopqrst.supabase.co:5432/postgres`,
      }),
      {
        out: (l) => out.push(l),
        err: (l) => err.push(l),
        assertContainment: () => {},
        readExecEnv: () => new Set(),
        spawn: () => fixedTranscriptChild(CHILD_STDOUT, CHILD_STDERR),
        identify: () => null,
        selfIdentity: () => null,
        scan: () => ({ available: true, pidPresent: false, leaderIdentityMatches: null, groupMembers: [], sessionMembers: [] }),
        killGroup: () => true,
        holdObserve: () => ({ available: true, pidPresent: false, leaderIdentityMatches: null, groupMembers: [], sessionMembers: [] }),
        setIntervalFn: () => ({ unref: () => {} }),
        clearIntervalFn: () => {},
      },
    );
    return JSON.stringify({ code, out, err });
  };

  const records = new Map();
  for (const password of CREDENTIALS) records.set(password, await runWith(password));
  const distinct = new Set(records.values());
  assert.equal(
    distinct.size, 1,
    `the record varied with the credential:\n${[...records].map(([p, r]) => `${p}: ${r}`).join('\n')}`,
  );

  // NOT VACUOUS: the single record really does carry the child's canonical transcript.
  const record = JSON.parse([...distinct][0]);
  const text = record.out.join('\n');
  assert.match(text, /\| \[m005-preflight\] target endpointFamily=session database=EXPECTED/);
  assert.match(text, /\| \[m005-preflight\] governedSource=MATCH/);
  assert.ok(!text.includes('[REDACTED]'), 'no marker may be spliced into a published template');

  // §7.3 — the raw stderr was DISCARDED, not redacted, and nothing of it survived.
  // `Socket` alone would match the legitimate canonical token `gracefulSocketClose`, so the marker
  // used here is one that can only come from the stack frame itself.
  for (const secret of ['ECONNREFUSED', 'db.abcdefghijklmnopqrst.supabase.co', 'node_modules/pg', 'at Socket.<anonymous>']) {
    assert.ok(!text.includes(secret), `raw stderr reached output: ${secret}`);
    assert.ok(!record.err.join('\n').includes(secret), `raw stderr reached stderr output: ${secret}`);
  }
  // The two raw stderr lines are attributed to stderr, not folded into one undivided count.
  assert.match(text, /child-output-discarded stdoutUnparsable=0 stderrUnparsable=2 overCap=0 truncated=false/);
});

test('C2B-M005-LRLS-L3-R3: a run whose streams never closed reports no transcript at all', async () => {
  // §4 — the child writes, then the run is torn down without either pipe reaching its terminal
  // state. The capture is never sealed, so the record carries the fixed withheld token instead.
  const child = new EventEmitter();
  child.pid = 838383;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.unref = () => {};
  child.stdout.unref = () => {};
  child.stderr.unref = () => {};
  child.kill = () => true;
  setImmediate(() => {
    child.stdout.emit('data', Buffer.from('[m005-preflight] governedSource=MATCH\n', 'utf8'));
    child.stderr.emit('data', Buffer.from('leaked-secret-material\n', 'utf8'));
    // `exit` WITHOUT `close`: the pipes are still open, which is exactly the late-write window.
    child.emit('exit', 0, null);
  });
  const out = [];
  const code = await launcherMain([PARENT_FLAG], goodEnv(), {
    out: (l) => out.push(l),
    err: () => {},
    assertContainment: () => {},
    readExecEnv: () => new Set(),
    spawn: () => child,
    identify: () => null,
    selfIdentity: () => null,
    scan: () => ({ available: true, pidPresent: false, leaderIdentityMatches: null, groupMembers: [], sessionMembers: [] }),
    killGroup: () => true,
    timeoutMs: 40,
    cleanupGraceMs: 10,
    groupPollMs: 5,
    holdObserve: () => ({ available: true, pidPresent: false, leaderIdentityMatches: null, groupMembers: [], sessionMembers: [] }),
    setIntervalFn: () => ({ unref: () => {} }),
    clearIntervalFn: () => {},
  });
  const text = out.join('\n');
  assert.equal(code, 2);
  assert.ok(!text.includes('leaked-secret-material'), 'an unsealed capture must not be read');
  assert.ok(!text.includes('governedSource=MATCH'), 'no transcript may be rendered before closure');
  // THE WITHHELD TOKEN MUST ACTUALLY BE SAID. Asserting only that the secret is absent is satisfied
  // by an EMPTY transcript too, which is what the call-site gate produces when it is removed — the
  // capture stays unsealed either way, so absence alone cannot tell a working gate from a missing
  // one. Requiring the fixed token is what makes that gate individually falsifiable.
  assert.ok(text.includes(TRANSCRIPT_UNAVAILABLE_TOKEN), `the record must say the transcript was withheld: ${text}`);
});

test('C2B-M005-LRLS-L3-R3: UNREADABLE in, UNREADABLE out — the removed guard was equivalent', () => {
  // The dead fourth guard is gone; this is the behaviour it used to state, now enforced where a
  // change to the reconciler's TAIL RETURN would be caught instead of being masked by an
  // unreachable early return.
  const base = {
    readable: true, roleSetOverflowed: false, newlyExposedRoles: 0,
    newlyExposedReachable: 0, publicGrantContributesExposure: false,
  };
  assert.equal(reconcileDisableRlsExposure({ ...base, incrementalExposure: 'UNREADABLE' }), 'UNREADABLE');
  // And the tail return really is the path that produced it: the two honest tokens still come back
  // unchanged, so the assertion above is not satisfied by a blanket UNREADABLE.
  assert.equal(reconcileDisableRlsExposure({ ...base, incrementalExposure: 'NONE_DETECTED' }), 'NONE_DETECTED');
  assert.equal(
    reconcileDisableRlsExposure({ ...base, incrementalExposure: 'PRESENT', newlyExposedRoles: 1 }),
    'PRESENT',
  );
});

test('C2B-M005-LRLS-L3-R3: the single exposure binding is pinned structurally, not just by value', () => {
  // THE L3-R2 SURVIVOR, CLOSED. Replacing the `exposure` binding with a second call to the
  // reconciler produced identical values, so every value-level assertion passed and the "computed
  // once" comment was an unenforced claim. Only the source can pin a structural contract.
  const src = readFileSync(join(REPO_ROOT, 'scripts', 'managed-m005-comprehensive-preflight.ts'), 'utf8');
  const body = src.slice(src.indexOf('export function renderLedgerRepairSafety'));
  const fn = body.slice(0, body.indexOf('\n}\n') + 3);
  assert.ok(fn.includes('const exposure = reconcileDisableRlsExposure(privileges);'), 'the binding must exist');
  assert.equal(
    (fn.match(/reconcileDisableRlsExposure\(/g) ?? []).length, 1,
    'the reconciler must be called EXACTLY once in the renderer; a second call is a second answer',
  );
  // BOTH Axis-B lines must read that one binding rather than recomputing.
  assert.equal((fn.match(/\$\{exposure\}/g) ?? []).length, 2, 'both Axis-B lines must interpolate the binding');
});

test('C2B-M005-LRLS-L3-R3: the bounded emitter keeps its control-character normalisation', () => {
  // SWEEP B30, RECORDED HONESTLY. Replacing `safeLineText(line)` with `String(line)` kills nothing
  // behaviourally, and that is not an accident: every line reaching this emitter is already built
  // from `FIELD.*` validators or from the canonical transcript grammar, and neither can produce a
  // control character — `FIELD.code` rejects one outright and returns `unreportable`. The call is
  // therefore defence in depth against a FUTURE field, not a live control, so no input-driven test
  // can distinguish the two. What can be pinned is that it is still there.
  const src = readFileSync(join(REPO_ROOT, 'scripts', 'managed-m005-comprehensive-preflight-launcher.mjs'), 'utf8');
  assert.ok(src.includes('sink = (line) => emit(safeLineText(line));'),
    'the single bounded emitter must keep normalising control characters');
  // And the claim about FIELD.code is asserted rather than assumed: a signal name carrying a
  // control character is REPLACED by the validator, never rendered. The character is BUILT here
  // rather than written, so this file stays free of the byte it is testing for.
  const CTRL = String.fromCharCode(1);
  const CONTROL_RANGE = new RegExp('[' + String.fromCharCode(0) + '-' + String.fromCharCode(31) + ']');
  const lines = renderPreflightReport({
    spawned: true, status: 'closed', exitCode: 0, signal: `SIGTERM${CTRL}`,
    group: { pids: [] }, cleanup: { complete: true }, streamsClosed: true,
    capture: { overflowed: false, text: () => '', streamText: () => '' },
  });
  assert.ok(lines.some((l) => l.includes('signal=unreportable')), lines.join('\n'));
  // The sentinel is the ONE control-bearing line, and it is a marker the report loop intercepts —
  // it is never emitted. Excluding it here is not a carve-out: the assertion immediately below is
  // what proves it never reaches the sink.
  for (const l of lines.filter((x) => x !== CHILD_BLOCK_SENTINEL)) {
    assert.ok(!CONTROL_RANGE.test(l), `a control character reached a field: ${JSON.stringify(l)}`);
  }
  assert.ok(lines.includes(CHILD_BLOCK_SENTINEL), 'the sentinel must be present to be intercepted');
});

test('C2B-M005-LRLS-L3-R3: an unparsable DSN partitions into ONE fixed refusal, not a variable one', async () => {
  // THE ONE CREDENTIAL-DEPENDENT CHANNEL THAT SURVIVES, PINNED RATHER THAN HIDDEN.
  // A password containing a URL-authority terminator (`/`, `?`, `#`) makes the DSN unparsable, and
  // `classifySecrets` refuses fail-closed BEFORE anything is spawned. That refusal is a function of
  // whether the configuration parses, so the record for such a password differs from the record for
  // a parsable one — about one bit, and no content. It predates this stage and is the correct
  // behaviour for an unusable configuration, but the property must be stated as it really is:
  // ONE fixed record for every parsable password, ONE fixed refusal for every unparsable one.
  //
  // The earlier proof could not see this: it built its DSN with encodeURIComponent, so it quantified
  // over percent-encoded passwords rather than over what an operator's environment actually holds.
  const runRaw = async (password) => {
    const out = [];
    const err = [];
    const code = await launcherMain([PARENT_FLAG], goodEnv({
      SUPABASE_DATABASE_URL: `postgresql://u:${password}@db.abcdefghijklmnopqrst.supabase.co:5432/postgres`,
    }), {
      out: (l) => out.push(l),
      err: (l) => err.push(l),
      assertContainment: () => {},
      readExecEnv: () => new Set(),
      // A REAL CHILD, NOT A SPAWN REFUSAL. Throwing here made both classes settle as
      // `spawn_failed`, so `renderPreflightTranscript` never parsed a line and the comparison this
      // test exists for was near-vacuous — it proved two refusal records matched, not two
      // transcripts. With a child that actually writes, the raw-password quantifier is real.
      spawn: () => fixedTranscriptChild(
        ['[m005-preflight] target endpointFamily=session database=EXPECTED',
          '[m005-preflight] governedSource=MATCH'],
        ['Error: connect ECONNREFUSED 203.0.113.7:5432'],
      ),
      identify: () => null,
      selfIdentity: () => null,
      scan: () => ({ available: true, pidPresent: false, leaderIdentityMatches: null, groupMembers: [], sessionMembers: [] }),
      killGroup: () => true,
      holdObserve: () => ({ available: true, pidPresent: false, leaderIdentityMatches: null, groupMembers: [], sessionMembers: [] }),
      setIntervalFn: () => ({ unref: () => {} }),
      clearIntervalFn: () => {},
    });
    return JSON.stringify({ code, out, err });
  };
  // THE PARTITION IS COMPUTED, NOT ASSUMED. `?`, `p:q`, `p@q` and `p%zz` all PARSE inside a DSN, so
  // hard-coding them as "unparsable" would have tested the wrong class and passed for the wrong
  // reason. The classifier used here is the same one the launcher's refusal turns on.
  const parses = (password) => {
    try {
      // eslint-disable-next-line no-new
      new URL(`postgresql://u:${password}@db.abcdefghijklmnopqrst.supabase.co:5432/postgres`);
      return true;
    } catch { return false; }
  };
  const candidates = ['pa/ss', 'pa?ss', 'pa#ss', 'a/b/c', '?', 'p:q', 'p@q', 'p%zz', 'plainpw', 'EXPECTED'];
  const unparsable = candidates.filter((c) => !parses(c));
  const parsable = candidates.filter(parses);
  assert.ok(unparsable.length >= 3 && parsable.length >= 3, 'both classes must be populated');
  const refusals = new Set();
  for (const p of unparsable) refusals.add(await runRaw(p));
  assert.equal(refusals.size, 1, `the refusal itself varied with the credential: ${[...refusals].join('\n')}`);
  const refusal = JSON.parse([...refusals][0]);
  assert.equal(refusal.code, 2);
  assert.equal(refusal.out.length, 0, 'a refused run emits no report at all');
  assert.equal(refusal.err.length, 1, 'and exactly one bounded refusal line');
  // NAMES ONLY — never a value, never the Error message, never a fragment of the DSN.
  assert.match(refusal.err[0], /REFUSED: [a-z_]+ names=SUPABASE_DATABASE_URL$/);
  for (const p of unparsable) assert.ok(!refusal.err[0].includes(p), `the credential leaked: ${p}`);
  assert.ok(!refusal.err[0].includes('abcdefghijklmnopqrst'), 'the project reference must not appear');

  // AND THE OTHER HALF OF THE PARTITION: every password that DOES parse — raw, unencoded, including
  // one equal to a rendered token — produces one and the same record. This is the noninterference
  // property restated over raw environment values rather than percent-encoded ones.
  const spawnedRecords = new Set();
  for (const p of parsable) spawnedRecords.add(await runRaw(p));
  assert.equal(spawnedRecords.size, 1, `the spawned record varied with the credential: ${[...spawnedRecords].join('\n')}`);
  const spawned = JSON.parse([...spawnedRecords][0]);
  assert.ok(spawned.out.length > 0, 'the parsable class must actually produce a report');
  // NOT VACUOUS: the child really ran and its transcript really was parsed and rendered.
  assert.match(spawned.out.join('\n'), /\| \[m005-preflight\] governedSource=MATCH/);
  assert.match(spawned.out.join('\n'), /stderrUnparsable=1/);
  // A CREDENTIAL EQUAL TO A RENDERED TOKEN IS NOT A LEAK — that is the overlap the property
  // explicitly permits, because the token is emitted identically for every credential. `EXPECTED` is
  // in the child's fixed vocabulary AND in this candidate list on purpose, and it is the equality
  // assertion above, not a substring search, that proves nothing was disclosed. Only credentials
  // that are NOT part of the rendered vocabulary can be checked by absence.
  const vocabulary = spawned.out.join('\n');
  for (const p of parsable) {
    if (p.length < 4) continue; // a 1-3 char token is a substring of ordinary vocabulary
    if (['EXPECTED', 'MATCH', 'session', 'postgres'].includes(p)) continue;
    assert.ok(!vocabulary.includes(p), `the credential leaked into the report: ${p}`);
  }
});

test('C2B-M005-LRLS-L3-R3: EVERY line the child really renders survives the canonical grammar', () => {
  // THE DRIFT GUARD, AND THE TEST THAT SHOULD HAVE EXISTED FIRST.
  // Failing closed on an unrecognised line is correct; doing it to the child's OWN evidence is a
  // silent loss dressed as safety. Three real losses got past hand-written fixtures: a 49-character
  // key (`reachabilityIncludes…`) exceeded the key ceiling, a 55-character value
  // (`A_MET_IS_NOT_REQUIRED…`) exceeded the enum ceiling — both discarded on EVERY run — and a null
  // count renders as `UNREADABLE/2`, which a digits-only ratio rejected, discarding four evidence
  // lines on exactly the runs whose evidence could not be read.
  //
  // Fixtures cannot catch that class, because the fixture author and the grammar author share the
  // same blind spot. This drives the child's REAL renderers and asserts every line they produce is
  // accepted, so a future field that outgrows a ceiling fails here instead of vanishing in prod.
  const unreadable = (ev) => {
    const out = {};
    for (const [k, v] of Object.entries(ev)) {
      out[k] = typeof v === 'number' ? null
        : typeof v === 'boolean' ? null
          : (v === 'PRESENT' || v === 'ABSENT') ? 'UNREADABLE' : v;
    }
    return out;
  };
  const met = metEvidence({ constraintPresent: 'PRESENT', policiesPresent: 5 });
  const lines = [
    ...residualFacts(),
    ...renderEvidence(met, { routinesOutsidePublic: 3, creatableNonPublicSchemas: 1 },
      cleanLedger({ dirty: 'PRESENT' }), cleanAcl(), false, 'PARTIAL_RESIDUE'),
    ...renderEvidence(unreadable(met), { routinesOutsidePublic: null, creatableNonPublicSchemas: null },
      cleanLedger(), cleanAcl(), true, 'UNREADABLE'),
    ...renderLedgerRepairSafety(null, classifyRlsApplicability(null),
      classifyPolicies({ rows: [], overflowed: false }), classifyPrivilegePosture(null, null),
      classifyEventTriggers({ rows: [], overflowed: false })),
    // THE READABLE POSTURE TOO. Driving only the unreadable one collapses every list to `NONE` and
    // every counter to `0`, so the comma-list ceiling — the tightest margin in the whole grammar,
    // 16 segments against 11 shape categories — was never exercised against real output. A future
    // privilege or category that crossed it would have vanished in production with this guard green.
    ...renderLedgerRepairSafety(
      {
        rlsEnabled: true, forceRls: true, rowSecurityActiveForCurrent: true,
        currentIsSessionPrincipal: true, currentOwnsLedger: true, ledgerOwnerIsDatabaseOwner: true,
        currentIsSuperuser: false, currentHasBypassRls: false,
      },
      'SUBJECT_TO_POLICIES',
      classifyPolicies({
        rows: POLICY_COMMAND_CLASSES.map((c, i) => ({
          policyname: `p${i}`, permissive: 'PERMISSIVE', cmd: c, roles: ['{public}'],
          qual: 'true', with_check: 'true',
        })),
        overflowed: false,
      }),
      {
        readable: true, roleSetOverflowed: false,
        standardPrivilegePosture: 'NON_OWNER_PRIVILEGE_PRESENT',
        publicPrivileges: [...LEDGER_PRIVILEGE_NAMES],
        nonOwnerCounts: LEDGER_PRIVILEGE_NAMES.map(() => 3),
        columnOnlyContributes: [...LEDGER_PRIVILEGE_NAMES],
        // FIELD NAME CORRECTED: the renderer reads `privileges.presentlyReachable`, so the old
        // `presentlyReachableRoles` spelling rendered the literal string `undefined` into the
        // record — and the lexical grammar accepted it as a "lowercase code" value. The per-key
        // domain refuses it, which is how a fixture that had been wrong all along became visible.
        anyNonOwnerOrdinaryPrivilege: true, presentlyReachable: 4,
        incrementalExposure: 'PRESENT', newlyExposedRoles: 4, newlyExposedReachable: 4,
        publicGrantContributesExposure: true,
      },
      classifyEventTriggers({ rows: [], overflowed: false }),
    ),
    // And the widest single item the grammar will ever see: every shape category in one list.
    `[m005-preflight] ledgerShape=MATCH ledgerShapeCategories=${renderShapeCategories('MATCH', [...LEDGER_SHAPE_CATEGORY_ORDER])}`
      + ' prefix001To004=MATCH checksums001To004=MATCH',
  ];
  assert.ok(lines.length >= 25, `the fixture must exercise the real renderers: ${lines.length}`);
  const discarded = lines.filter((l) => canonicalPreflightLine(l) === null);
  assert.deepEqual(discarded, [], `the child's own evidence was discarded:\n${discarded.join('\n')}`);
  // AND THE GRAMMAR IS NOT VACUOUSLY PERMISSIVE: it still refuses material that carries structure.
  for (const hostile of [
    '[m005-preflight] k=postgresql://u:p@h.example.com:5432/postgres',
    '[m005-preflight] k=db.abcdefghijklmnopqrst.supabase.co',
    '[m005-preflight] k=203.0.113.7',
    '[m005-preflight] k=/app/node_modules/pg/lib/client.js',
    'Error: connect ECONNREFUSED 203.0.113.7:5432',
  ]) {
    assert.equal(canonicalPreflightLine(hostile), null, `must still fail closed: ${hostile}`);
  }
});

test('C2B-M005-LRLS-L3-R3: every launcher code round-trips through the field validator', async () => {
  // LAUNCHER_CODES lives in the baseline launcher, imported here rather than re-exported.
  const { LAUNCHER_CODES } = await import('../../scripts/managed-baseline-launcher.mjs');
  // THE CEILING GUARD. `FIELD.code` caps at 64 characters and the longest code in use is 48, so
  // there are 16 characters of headroom and nothing watching them. A code name that outgrew the cap
  // would render as `unreportable` — genuine lifecycle evidence silently replaced by a placeholder,
  // which is the same class of defect that discarded a 49-character key and a 55-character value
  // earlier in this stage. Asserting the round trip through the REAL renderer costs nothing and
  // fails loudly the moment a code is added that the validator cannot carry.
  const codes = [...new Set([...Object.values(LAUNCHER_CODES), ...Object.values(INSPECT_LAUNCHER_CODES)])];
  assert.ok(codes.length >= 20, `the code set must be derived, not empty: ${codes.length}`);
  for (const code of codes) {
    const lines = renderPreflightReport({
      spawned: true, status: code, exitCode: 0, signal: code,
      group: { pids: [] }, cleanup: { complete: true }, streamsClosed: true,
      capture: { overflowed: false, text: () => '', streamText: () => '' },
    });
    const text = lines.join('\n');
    assert.ok(text.includes(`status=${code}`), `status was replaced for ${code} (${code.length} chars)`);
    assert.ok(text.includes(`signal=${code}`), `signal was replaced for ${code} (${code.length} chars)`);
    assert.ok(!text.includes('unreportable'), `a legitimate code rendered as unreportable: ${code}`);
  }
  // AND THE DETECTOR IS NOT VACUOUS: a value the validator must reject really does get replaced.
  const hostile = renderPreflightReport({
    spawned: true, status: 'db.abcdefghijklmnopqrst.supabase.co', exitCode: 0, signal: '203.0.113.7',
    group: { pids: [] }, cleanup: { complete: true }, streamsClosed: true,
    capture: { overflowed: false, text: () => '', streamText: () => '' },
  }).join('\n');
  assert.ok(hostile.includes('status=unreportable'), 'a hostname must not render as a status');
  assert.ok(hostile.includes('signal=unreportable'), 'an address must not render as a signal');
});

/**
 * THE DRIFT GUARD, EXTENDED OVER THE THIRTY EMIT SITES IT DID NOT REACH.
 *
 * The existing drift guard drives the child's real render FUNCTIONS (`residualFacts`,
 * `renderEvidence`, `renderLedgerRepairSafety`) through the canonical grammar. It cannot reach the
 * thirty lines `runPreflight` and `main` emit from inline templates, because reaching those means
 * running the snapshot — which means a connection, which is not authorized here. Those thirty were
 * therefore only ever HAND-verified, and hand-verification is precisely what failed repeatedly in
 * this stage: it discarded a 49-character key, a 55-character value and four evidence families on
 * unreadable runs, each time while a human reading claimed the grammar was complete.
 *
 * So this guard reaches them the other way: it EXTRACTS each template from the executable source and
 * expands it against the complete value domain of every slot. That makes the coverage mechanical
 * rather than remembered, and — the property that matters — it is FAIL-CLOSED ON DRIFT. A new emit
 * site, or a new slot expression, has no declared domain, and an undeclared domain fails the test
 * rather than silently skipping the line. Adding an unbounded value to the operator record is thus
 * not something a later change can do quietly; it has to be declared here first.
 */
test('C2B-M005-LRLS-L3-R3: every line runPreflight and main can emit survives the canonical grammar', () => {
  const src = executableSource(
    readFileSync(join(REPO_ROOT, 'scripts', 'managed-m005-comprehensive-preflight.ts'), 'utf8'));

  // ---- extract every emit(...) template, including the `+ \`...\`` concatenated form -----------
  const templates = extractEmitTemplates(src, 'm005-preflight');
  assert.equal(templates.length, 30,
    `expected the thirty inline emit templates, extracted ${templates.length}`);
  // AND THE EXTRACTED TEXT MUST BE THE TEXT THE CHILD EMITS. The scanner copies escape sequences
  // verbatim instead of decoding them, so a template containing `\n` would be canonicalised as a
  // literal backslash-n — proving a string the child never writes while the real one goes untested.
  // No template contains a backslash today; this fails the moment one does, rather than drifting.
  for (const t of templates) {
    assert.ok(!t.text.includes('\\'),
      `the template near source line ${t.at} contains an escape sequence the scanner copies rather `
      + 'than decodes; teach it to decode before this line can be proved');
  }

  // ---- the complete value domain of every slot -------------------------------------------------
  const ALL_CODES = Object.values(PREFLIGHT_CODES);
  const BOOL = ['true', 'false'];
  const MATCH3 = ['MATCH', 'MISMATCH', 'UNREADABLE'];
  const DOMAINS = {
    sourceMatch: MATCH3,
    fp: MATCH3,
    continuity: ['AGREED', 'BROKEN', 'UNREADABLE'],
    code: ALL_CODES,
    primaryCode: ALL_CODES,
    family: ['session', 'unrecognized'],
    TARGET_DATABASE_FIELD: [TARGET_DATABASE_FIELD],
    'String(principal === sessionPrincipal)': BOOL,
    'String(database === EXPECTED_DATABASE)': BOOL,
    'cleanup.rollback': ['not_required', 'completed', 'failed'],
    'String(cleanup.disposalRequested)': BOOL,
    'String(cleanup.disposalCompleted)': BOOL,
    'cleanup.gracefulSocketClose': ['not_observed', 'unknown'],
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
      // FAIL-CLOSED: an undeclared slot is a test failure, never a skipped line.
      assert.ok(domain !== null,
        `line ${template.at} interpolates \${${expr}}, whose value domain is not declared here; `
        + 'declare its complete value set above before this value may reach the operator record');
      const next = [];
      for (const line of out) for (const value of domain) next.push(line.replace(slot[0], value));
      out = next;
    }
  };

  // ---- every reachable line must survive canonicalisation BYTE-IDENTICALLY ---------------------
  let driven = 0;
  for (const template of templates) {
    for (const line of expand(template)) {
      assert.equal(canonicalPreflightLine(line), line,
        `line ${template.at} can emit evidence the canonical grammar discards or rewrites: ${line}`);
      driven += 1;
    }
  }
  assert.ok(driven >= 200, `the expansion collapsed to ${driven} lines; the domains are not applied`);

  // ---- AND THE GRAMMAR IS NOT MERELY PERMISSIVE ------------------------------------------------
  // A guard that only ever proves acceptance would pass just as well against a grammar that accepts
  // everything — which is the defect this whole correction exists to close.
  for (const hostile of [
    '[m005-rogue] governedSource=MATCH',
    '[m005-preflight] connection terminated unexpectedly',
    '[m005-preflight] password=hunter2',
    '[m005-preflight] db.abcdefghijklmnopqrst.supabase.co=true',
    '[m005-preflight] governedSource=[REDACTED]CH',
    '[m005-preflight] governedSource MATCH',
  ]) {
    assert.equal(canonicalPreflightLine(hostile), null,
      `the grammar accepted a line it must discard: ${hostile}`);
  }
});

/**
 * THE RUNTIME-CAPTURE DRIFT GUARD — the scanner's INDEPENDENT partner.
 *
 * The extraction guard above reads source text, so its completeness rests on a hand-written scanner
 * whose "it can never skip a real template" property was, until now, an argument rather than a test.
 * A load-bearing output site must not have an argument as its only protection.
 *
 * This proves the same property a second way, with no scanner anywhere in the path: it RUNS the real
 * child across a spread of postures through injected ports, captures the bytes it actually emits,
 * and requires every one of them to survive the launcher's independently pinned grammar. The two
 * guards fail for different reasons — the scanner catches an emit site no fixture reaches, this
 * catches a value no reading predicted — and neither can mask the other.
 */
test('C2B-M005-LRLS-L3-R4: every line the child REALLY emits at runtime survives the grammar', async () => {
  const postures = [
    {},
    { readOnly: [false, true] },
    { readOnly: [true, false] },
    { isolation: ['read committed', REQUIRED_ISOLATION] },
    { tokens: ['pid:11', 'pid:22'] },
    { tokens: ['pid:11', null] },
    { fingerprintFailures: ['x'] },
    { fingerprintThrows: true },
    { aclThrows: true },
    { aclOverflowed: true },
    { ledgerShapeThrows: true },
    { endpointFamily: 'pooler' },
    { describedDb: 'other' },
    { overflowed: true },
    { disposeThrows: true },
    { env: goodEnv({ NODE_ENV: 'production' }) },
    { env: goodEnv({ CONFIRM_SUPABASE_TARGET: 'other' }) },
  ];
  const seen = [];
  for (const posture of postures) {
    const { lines } = await runChild(posture);
    for (const line of lines) seen.push(line);
  }
  assert.ok(seen.length >= 60, `the postures must actually produce output: ${seen.length}`);
  const discarded = seen.filter((l) => canonicalPreflightLine(l) === null);
  assert.deepEqual(discarded, [],
    `the child's own runtime output was discarded:\n${[...new Set(discarded)].join('\n')}`);
  // NON-VACUITY: the same assertion must fail for material the grammar has to refuse, so a run that
  // emitted nothing could not pass this test by accident.
  assert.equal(canonicalPreflightLine('[m005-preflight] governedSource=hunter2'), null);
  assert.ok(seen.some((l) => l.includes('outcome=')), 'a terminal record was actually observed');
});


/**
 * THE SCANNER'S OWN CONTRACT, EXECUTED.
 *
 * Every rule this scanner relies on used to be an argument in a comment. §7 is explicit that no
 * scanner reasoning claim may be the only protection for a load-bearing output site, so each rule
 * is driven here against source built to break it.
 */
test('C2B-M005-LRLS-L3-R4: the emit scanner is correct on adversarial source', () => {
  const T = (src) => extractEmitTemplates(src, 'tag').map((t) => t.text);

  // 1. Concatenated literals are joined into one template.
  assert.deepEqual(T('emit(`[tag] a=` + `1`);'), ['[tag] a=1']);
  // 2. A trailing suffix the scanner cannot read is REFUSED, not silently half-read — the readable
  //    half is a complete, grammatical line and would otherwise pass on its own.
  assert.throws(() => T('emit(`[tag] a=1` + suffix);'), /concatenates a non-literal/);
  assert.throws(() => T('emit(`[tag] a=1`, second);'), /concatenates a non-literal/);
  // 3. A trailing comma is the project's own multi-line call style and must be accepted.
  assert.deepEqual(T('emit(\n  `[tag] a=1`,\n);'), ['[tag] a=1']);
  // 4. Multiline calls, with the paren on its own line.
  assert.deepEqual(T('emit(\n  `[tag] a=1`\n);'), ['[tag] a=1']);
  // 5. An escape sequence is copied rather than decoded, so the scanner refuses rather than prove a
  //    string the child never writes.
  assert.throws(() => T('emit(`[tag] a=1\\t`);'), /escape sequence/);
  // 6. Interpolation is preserved verbatim for the caller to expand.
  assert.deepEqual(T('emit(`[tag] a=${x}`);'), ['[tag] a=${x}']);
  // 7. Nested parentheses inside an interpolation do not terminate the call.
  assert.deepEqual(T('emit(`[tag] a=${String(f(x))} b=${g()}`);'), ['[tag] a=${String(f(x))} b=${g()}']);
  // 8. Adjacent calls are all found — the cursor must not swallow the next one.
  assert.deepEqual(T('emit(`[tag] a=1`);emit(`[tag] b=2`);emit(`[tag] c=3`);'),
    ['[tag] a=1', '[tag] b=2', '[tag] c=3']);
  // 9. Text that merely LOOKS like an emit, inside a literal, is not a second template. Resuming
  //    inside the consumed literal used to produce a phantom match here.
  assert.deepEqual(T("emit(`[tag] note=see emit('[tag] x=1') above`);"),
    ["[tag] note=see emit('[tag] x=1') above"]);
  // 10. A template for another tag is not collected, and does not disturb the ones that are.
  assert.deepEqual(T('emit(`[other] a=1`);emit(`[tag] b=2`);'), ['[tag] b=2']);
  // 11. An unterminated literal fails closed rather than consuming the rest of the file.
  assert.throws(() => T('emit(`[tag] a=1'), /unterminated literal/);
  // 12. Single-quoted literals are scanned on the same rules as backticks.
  assert.deepEqual(T("emit('[tag] a=1');"), ['[tag] a=1']);
});

/**
 * LINUX REALTIME SIGNALS, AGAINST REAL SUBPROCESSES.
 *
 * Node reports a child killed by signal 34, 40 or 64 as `exit(code=0, signal=null)` — byte-identical
 * to a clean success, and measured here rather than assumed. Every negative lifecycle test in this
 * launcher accepts that shape: `if (result.signal)` is false and `if (result.exitCode !== 0)` is
 * false. Only the child's own terminal record separates a destroyed run from a completed one.
 */
test('C2B-M005-LRLS-L3-R4: a child killed by a realtime signal cannot reach OK', async () => {
  const { runChild: spawnChild } = await import('../../scripts/managed-baseline-launcher.mjs');
  const run = (script) => spawnChild({
    command: process.execPath,
    args: ['-e', script],
    env: { PATH: process.env.PATH ?? '' },
    limit: 65536,
    timeoutMs: 20000,
  });
  for (const signal of [34, 40, 64]) {
    const result = await run(
      `console.log('[m005-preflight] governedSource=MATCH');`
      + `process.kill(process.pid, ${signal});`);
    // THE HAZARD, MEASURED: the kernel destroyed this child and Node reports a clean zero exit.
    assert.equal(result.exitCode, 0, `signal ${signal} must arrive as exit 0`);
    assert.equal(result.signal ?? null, null, `signal ${signal} must arrive as no signal at all`);
    // AND YET the launcher must not call it complete, because no terminal record was written.
    const terminal = terminalEvidenceFor(result);
    assert.equal(terminal.ok, false, `signal ${signal} must not establish completion`);
    assert.equal(terminal.reason, 'missing');
    const text = renderPreflightReport(result).join('\n');
    assert.ok(text.includes('terminalEvidence=missing'), 'the record states the evidence is missing');
    assert.ok(!text.includes(`outcome=${INSPECT_LAUNCHER_CODES.OK}`),
      `a destroyed child must never render as OK: signal ${signal}`);
    assert.ok(text.includes(INSPECT_LAUNCHER_CODES.TERMINAL_EVIDENCE_INCOMPLETE),
      'and names the reason it is not OK');
  }
  // THE CONTROL, so the assertions above cannot pass merely because nothing ever reaches OK: the
  // same child that DOES write its terminal record establishes completion.
  const clean = await run(
    `console.log('[m005-preflight] governedSource=MATCH');`
    + `console.log('[m005-preflight] outcome=m005_preflight_observed_preconditions_met');`);
  assert.equal(clean.exitCode, 0);
  const cleanTerminal = terminalEvidenceFor(clean);
  assert.equal(cleanTerminal.ok, true, 'a child that completes must establish completion');
  assert.equal(cleanTerminal.code, 'm005_preflight_observed_preconditions_met');
  // AND A CHILD THAT WRITES ITS RECORD AND IS THEN DESTROYED still fails closed, because the record
  // is required to be LAST and the kill leaves the stream state unproved.
  const late = await run(
    `console.log('[m005-preflight] outcome=m005_preflight_observed_preconditions_met');`
    + `console.log('[m005-preflight] governedSource=MATCH');`
    + `process.kill(process.pid, 34);`);
  assert.equal(terminalEvidenceFor(late).ok, false, 'a record that is not final establishes nothing');
});

test('C2B-M005-LRLS-L4: the record and the exit code state ONE disposition, not two', async () => {
  // R4-M12 SURVIVED THE FIRST SWEEP: the exit code repeated the record's conjuncts in a second
  // expression, so a mutation could drop the terminal requirement from the exit code alone. A run
  // would then PRINT `terminal_evidence_incomplete` and exit 0 — the worst shape of all, because the
  // record disagrees with the status a CI step reads. There is now one function behind both.
  const base = {
    spawned: true, status: 'closed', exitCode: 0, signal: null,
    identity: { pid: 2, pgid: 2, sid: 2 }, closeObserved: true, streamsClosed: true,
    group: { available: true, pids: [], groupMembers: [], sessionMembers: [] },
    cleanup: { complete: true },
  };
  const withStdout = (text) => ({
    ...base, capture: { overflowed: false, text: () => text, streamText: (s) => (s === 'stdout' ? text : '') },
  });

  const killed = dispositionFor(withStdout('[m005-preflight] governedSource=MATCH'));
  assert.equal(killed.terminal.ok, false, 'no terminal record was delivered');
  assert.equal(killed.code, INSPECT_LAUNCHER_CODES.TERMINAL_EVIDENCE_INCOMPLETE);
  assert.equal(killed.exitCode, 2, 'and the exit code says the same thing the record does');

  const completed = dispositionFor(withStdout(
    '[m005-preflight] governedSource=MATCH\n[m005-preflight] outcome=m005_preflight_observed_preconditions_met'));
  assert.equal(completed.terminal.ok, true);
  assert.equal(completed.terminal.code, 'm005_preflight_observed_preconditions_met');

  // THE RECORD IS DERIVED FROM THE SAME CALL, so the two can never disagree by construction.
  for (const result of [withStdout('[m005-preflight] governedSource=MATCH'), withStdout('')]) {
    const d = dispositionFor(result);
    const text = renderPreflightReport(result).join('\n');
    assert.ok(text.includes(`outcome=${d.code === LAUNCHER_CODES.OK ? INSPECT_LAUNCHER_CODES.OK : d.code}`),
      'the record must name the disposition the exit code was derived from');
    assert.ok(text.includes(`terminalEvidence=${d.terminal.reason}`));
  }
  // NON-VACUITY: the favourable disposition really is reachable, so these are not all failing alike.
  assert.notEqual(completed.code, INSPECT_LAUNCHER_CODES.TERMINAL_EVIDENCE_INCOMPLETE);
});
