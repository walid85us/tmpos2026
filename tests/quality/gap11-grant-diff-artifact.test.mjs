// Phase 4.0 M5-GAP11-P1 — the committed GAP-11 grant-diff artifact, and the containment that keeps
// the candidate evaluator observational (04 §3 safeguards #2 and #5).
//
// Two jobs. First: the artifact under docs/ is the owner's evidence for decisions D2 and D3, so it
// must be regenerable, byte-stable, and identical to what the catalog says right now — a stale
// artifact is worse than none, because it reads as current. Second: the modules that produce it must
// stay out of every request path. Nothing that decides an authorization may import them.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import ts from 'typescript';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');
const GENERATOR = 'scripts/generate-gap11-grant-diff.ts';
const ARTIFACT = 'docs/phase-4/evidence/gap11-ordering-flip-grant-diff.md';

/** The modules this stage adds. They are observational and must remain unreachable from a decision. */
const OBSERVATIONAL_MODULES = [
  'server/platform-identity/gap11GrantDiff.ts',
  'server/platform-identity/gap11ShadowComparator.ts',
];

/**
 * The only files permitted to name them, until D3 approves the diff and a cutover is decided. Every
 * entry but the modules themselves and the generator is a test suite (M5-GAP11-P2 adds the D2 suite
 * and the two client suites that check server/client agreement).
 */
const PERMITTED_NAMERS = [
  'scripts/generate-gap11-grant-diff.ts',
  'server/platform-identity/gap11GrantDiff.test.ts',
  'server/platform-identity/gap11GrantDiff.ts',
  'server/platform-identity/gap11MoneyActionGrants.test.ts',
  'server/platform-identity/gap11ShadowComparator.test.ts',
  'server/platform-identity/gap11ShadowComparator.ts',
  'src/context/AccessContext.test.tsx',
  'src/context/authorizationVocabulary.test.ts',
  'tests/quality/gap11-grant-diff-artifact.test.mjs',
  // The test ratchet names the new SUITES in its sentinel list, which is required of it. The test
  // below proves it names only `*.test.*` paths, so it cannot become a route to the modules.
  'scripts/run-tests.mjs',
];

const runGenerator = (...args) => spawnSync('npx', ['tsx', GENERATOR, ...args], {
  cwd: REPO, encoding: 'utf8', timeout: 180_000,
});

/** Git paths, NUL-separated and unquoted, so no legal filename is dropped or mangled. */
const gitPaths = ([command, ...rest], cwd = REPO) =>
  execFileSync('git', [command, '-z', ...rest], { cwd, encoding: 'utf8' }).split('\0').filter(Boolean);

/** Tracked AND untracked sources, so an uncommitted module cannot slip past containment. */
function localSources(...roots) {
  const out = new Set();
  for (const args of [['ls-files'], ['ls-files', '--others', '--exclude-standard']]) {
    for (const f of gitPaths([...args, '--', ...roots])) {
      if (/\.(m|c)?[jt]sx?$/.test(f) && existsSync(join(REPO, f))) out.add(f);
    }
  }
  return [...out].sort();
}

// =============================================================================
// The artifact
// =============================================================================

test('the committed grant-diff artifact exists and is not stale', () => {
  assert.ok(existsSync(join(REPO, ARTIFACT)), `${ARTIFACT} must be committed`);
  const r = runGenerator('--check');
  assert.equal(r.status, 0,
    `the committed artifact does not match the catalog — regenerate with \`npx tsx ${GENERATOR}\`.\n${r.stdout ?? ''}${r.stderr ?? ''}`);
});

test('regenerating on unchanged inputs produces a byte-identical file and no working-tree diff', () => {
  const gitView = () => [
    execFileSync('git', ['status', '--porcelain', '--', ARTIFACT], { cwd: REPO, encoding: 'utf8' }),
    execFileSync('git', ['diff', '--', ARTIFACT], { cwd: REPO, encoding: 'utf8' }),
  ];
  const gitBefore = gitView();
  const before = readFileSync(join(REPO, ARTIFACT), 'utf8');
  const first = runGenerator();
  assert.equal(first.status, 0, first.stderr);
  const afterOne = readFileSync(join(REPO, ARTIFACT), 'utf8');
  const second = runGenerator();
  assert.equal(second.status, 0, second.stderr);
  const afterTwo = readFileSync(join(REPO, ARTIFACT), 'utf8');

  assert.equal(afterOne, before, 'regeneration did not change the committed bytes');
  assert.equal(afterTwo, afterOne, 'two runs agree byte for byte');

  // And git agrees regeneration touched nothing — the strongest form of "leaves no diff". Compared
  // before and after rather than against a clean status, so it holds on a committed tree (both empty)
  // and on a candidate whose artifact is not yet committed (both the same pending change).
  assert.deepEqual(gitView(), gitBefore, 'regeneration changed git\'s view of the artifact');
});

test('the artifact carries no timestamp, host, absolute path or other run-varying value', () => {
  const text = readFileSync(join(REPO, ARTIFACT), 'utf8');
  const varying = [
    ['ISO timestamp', /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/],
    ['date stamp', /\b\d{4}-\d{2}-\d{2}\b/],
    ['absolute repo path', /\/home\/[A-Za-z0-9_-]+\//],
    ['tmp path', /\/tmp\//],
    ['node_modules path', /node_modules/],
    ['generated-at wording', /generated (?:at|on)\b/i],
    ['run id', /\brun[_-]?id\b/i],
  ];
  for (const [why, re] of varying) {
    assert.ok(!re.test(text), `the artifact must contain no ${why}`);
  }
});

test('the artifact carries no secret, credential or identity', () => {
  const text = readFileSync(join(REPO, ARTIFACT), 'utf8');
  const forbidden = [
    /postgres(?:ql)?:\/\//i, /BEGIN [A-Z ]*PRIVATE KEY/, /service_role/i, /SUPABASE_[A-Z_]*KEY/,
    /\bDATABASE_URL\b/, /\bBearer\b/, /@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/, /\bcookie\b/i,
    /\bpassword\b/i, /\baccess[_ ]?token\b/i,
  ];
  for (const re of forbidden) assert.ok(!re.test(text), `artifact must not contain ${re}`);
});

test('the artifact states what it does not decide — GAP-11 is not closed by it', () => {
  const text = readFileSync(join(REPO, ARTIFACT), 'utf8');
  // Whitespace-tolerant: the generator hard-wraps prose, so a match must survive a line break
  // falling anywhere inside the phrase.
  assert.match(text, /safeguard\s+\*\*#1\*\*[\s\S]*?D2/i, 'names safeguard #1 as owner decision D2');
  assert.match(text, /safeguard\s+\*\*#3\*\*[\s\S]*?D3/i, 'names safeguard #3 as owner decision D3');
  assert.match(text, /GAP-11 is \*\*not\*\*\s*closed/i, 'says plainly that GAP-11 is not closed');
  assert.match(text, /Generated file\. Do not edit by hand\./);
});

test('the path inventory keeps filenames git would quote or a trim would change', () => {
  // Newline-split output C-quotes a non-ASCII or newline-bearing path and a trim eats edge spaces —
  // either way the path fails existsSync and silently leaves the containment scan.
  const dir = mkdtempSync(join(tmpdir(), 'gap11-paths-'));
  try {
    execFileSync('git', ['init', '-q'], { cwd: dir });
    const names = ['café.ts', ' lead.ts', 'line\nbreak.ts', 'plain.ts'];
    for (const n of names) writeFileSync(join(dir, n), '');
    assert.deepEqual(gitPaths(['ls-files', '--others', '--exclude-standard'], dir).sort(), [...names].sort());
    // Control, independent of core.quotePath: git always quotes a newline-bearing name, and a trim
    // always eats an edge space, so the old parse loses both names.
    const legacy = execFileSync('git', ['ls-files', '--others', '--exclude-standard'], { cwd: dir, encoding: 'utf8' })
      .split('\n').map((s) => s.trim()).filter(Boolean);
    assert.ok(!legacy.includes(' lead.ts') && !legacy.includes('line\nbreak.ts'),
      'control: newline-split, trimmed output does lose these names');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the generator writes exactly one file, under the governed evidence directory', () => {
  const src = readFileSync(join(REPO, GENERATOR), 'utf8');
  const writes = src.match(/writeFileSync\s*\(/g) ?? [];
  assert.equal(writes.length, 1, 'one write call');
  assert.match(src, /ARTIFACT_RELATIVE_PATH = 'docs\/phase-4\/evidence\//);
  for (const re of [/\bfetch\s*\(/, /from\s+['"](?:postgres|pg)['"]/, /process\s*\.\s*env\b/, /execSync|spawnSync|execFileSync/]) {
    assert.ok(!re.test(src), `the generator must not use ${re}`);
  }
});

// =============================================================================
// Containment — the observational modules stay out of every decision path
// =============================================================================

/** The observational modules, and the candidate-only D2 table and evaluator they export (M5-GAP11-P2). */
const OBSERVATIONAL_NAMES = /gap11GrantDiff|gap11ShadowComparator|D2_EXPLICIT_MONEY_ACTION_GRANTS|evaluateAfterRepinCandidate|computeRepinnedGrantDiff/;

test('nothing outside the permitted set names the observational modules', () => {
  const offenders = [];
  for (const file of localSources('server', 'src', 'scripts', 'tests')) {
    if (PERMITTED_NAMERS.includes(file)) continue;
    const text = readFileSync(join(REPO, file), 'utf8');
    if (OBSERVATIONAL_NAMES.test(text)) offenders.push(file);
  }
  assert.deepEqual(offenders, [],
    'the candidate evaluators, the D2 grant table and the shadow comparator must remain unreachable from any decision path');
  // Every permitted namer outside the modules and the generator is a test suite or the test ratchet.
  for (const f of PERMITTED_NAMERS) {
    if (OBSERVATIONAL_MODULES.includes(f) || f === GENERATOR || f === 'scripts/run-tests.mjs') continue;
    assert.match(f, /\.test\.(ts|tsx|mjs)$/, `${f} may name the modules only as a test`);
  }
});

test('the test ratchet names only the new SUITES, never the modules themselves', () => {
  // scripts/run-tests.mjs is on the permitted list because its sentinel array must name the suites.
  // That exemption is only safe while every mention is a `.test.` path, so assert exactly that.
  const text = readFileSync(join(REPO, 'scripts/run-tests.mjs'), 'utf8');
  const mentions = [...text.matchAll(/'([^']*gap11[^']*)'/g)].map((m) => m[1]);
  assert.ok(mentions.length > 0, 'the ratchet does name the new suites');
  for (const m of mentions) {
    assert.ok(/\.test\.(ts|mjs)$/.test(m), `the ratchet may name only suites, found: ${m}`);
  }
  assert.ok(!/from\s+['"][^'"]*gap11/.test(text), 'the ratchet imports neither module');
});

test('no production authorization module imports the observational modules', () => {
  // The direction that matters: the authority must not depend on the candidate. Checked against the
  // real entry points rather than a blanket rule, so the assertion names what it protects.
  const AUTHORITY = [
    'server/platform-identity/permissionCatalog.ts',
    'server/platform-identity/permissionDecision.ts',
    'server/platform-identity/protectedAction.ts',
    'server/platform-identity/authorizationResolver.ts',
    'server/platform-identity/sessionAuthorizationService.ts',
    'server/platform-identity/m5CanonicalPermissions.ts',
  ];
  for (const f of AUTHORITY) {
    assert.ok(existsSync(join(REPO, f)), `${f} exists`);
    const text = readFileSync(join(REPO, f), 'utf8');
    assert.ok(!OBSERVATIONAL_NAMES.test(text),
      `${f} must not reach the observational modules or the candidate-only D2 table`);
  }
  // And no production module anywhere — every non-test source under server/ and src/ — does either.
  const production = localSources('server', 'src').filter((f) => !/\.test\.(m|c)?[jt]sx?$/.test(f)
    && !OBSERVATIONAL_MODULES.includes(f));
  assert.ok(production.length > 100, 'the scan covers the real tree');
  const importers = production.filter((f) => OBSERVATIONAL_NAMES.test(readFileSync(join(REPO, f), 'utf8')));
  assert.deepEqual(importers, [], 'no production module names a candidate-only module, table or evaluator');
});

test('the observational modules never import a production decision entry point', () => {
  for (const f of OBSERVATIONAL_MODULES) {
    const text = readFileSync(join(REPO, f), 'utf8');
    const specifiers = [...text.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]);
    for (const s of specifiers) {
      assert.ok(!/permissionDecision|protectedAction|authorizationResolver|sessionAuthorizationService|authorizationRepository/.test(s),
        `${f} imports a decision entry point: ${s}`);
    }
  }
});

test('the compiled deployable server cannot contain the observational modules', () => {
  // The mechanism, not a scan of an artifact that CI has not built yet when this suite runs: the
  // server build's rootDir is server/runtime, so tsc refuses to emit anything outside it, and the
  // include globs name nothing else. production-runtime-contract separately forbids server/runtime
  // from importing platform-identity at all.
  const cfg = JSON.parse(readFileSync(join(REPO, 'tsconfig.server.json'), 'utf8'));
  assert.equal(cfg.compilerOptions.rootDir, 'server/runtime');
  assert.ok(Array.isArray(cfg.include) && cfg.include.length > 0);
  for (const glob of cfg.include) assert.ok(glob.startsWith('server/runtime/'), `include ${glob} stays in server/runtime`);
  for (const f of OBSERVATIONAL_MODULES) assert.ok(!f.startsWith('server/runtime/'), `${f} lives outside the build root`);
});

/**
 * Every identifier, bracket-access key and import specifier in a module, read from the TypeScript
 * syntax tree. A text regex misses `globalThis['fetch']`, `const { env } = process` or an alias of
 * `console`; an identifier census does not, because each of those still has to NAME the global.
 */
function census(source, file = 'module.ts') {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const identifiers = new Set();
  const keys = new Set();
  const specifiers = [];
  let dynamicImport = false;
  const visit = (n) => {
    if (ts.isIdentifier(n)) identifiers.add(n.text);
    if (ts.isElementAccessExpression(n) && ts.isStringLiteralLike(n.argumentExpression)) keys.add(n.argumentExpression.text);
    if ((ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) && n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier)) specifiers.push(n.moduleSpecifier.text);
    if (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword) dynamicImport = true;
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return { identifiers, keys, specifiers: specifiers.sort(), dynamicImport };
}

/** Ambient capabilities a pure evaluator has no business naming: I/O, network, time, randomness, eval. */
const FORBIDDEN_NAMES = [
  'globalThis', 'global', 'window', 'self', 'process', 'console', 'fetch', 'require', 'XMLHttpRequest',
  'WebSocket', 'setTimeout', 'setInterval', 'setImmediate', 'queueMicrotask', 'eval', 'Function', 'Date',
  'performance', 'crypto', 'getRuntimeDb',
];

const ALLOWED_SPECIFIERS = {
  'server/platform-identity/gap11GrantDiff.ts': ['./authorizationConstants', './authorizationContract', './permissionCatalog'],
  'server/platform-identity/gap11ShadowComparator.ts': ['./authorizationConstants', './gap11GrantDiff'],
};

test('the GAP-11 sources carry no raw control bytes — a NUL separator is written as an escape', () => {
  // A literal NUL makes `file`, grep and ripgrep treat a source as binary and skip it, so a scanner or
  // a reviewer can silently miss the module (it happened twice: P1 and P2 each wrote one by accident).
  const isControl = (b) => b < 0x09 || b === 0x0b || b === 0x0c || (b > 0x0d && b < 0x20);
  const files = [...OBSERVATIONAL_MODULES, GENERATOR, 'server/platform-identity/gap11GrantDiff.test.ts',
    'server/platform-identity/gap11MoneyActionGrants.test.ts', 'server/platform-identity/gap11ShadowComparator.test.ts',
    'tests/quality/gap11-grant-diff-artifact.test.mjs', ARTIFACT];
  for (const f of files) {
    const at = readFileSync(join(REPO, f)).findIndex(isControl);
    assert.equal(at, -1, `${f} has a raw control byte at offset ${at}`);
  }
  // Control: the check does see one.
  assert.notEqual(Buffer.from(`a${String.fromCharCode(0)}b`).findIndex(isControl), -1);
});

test('the observational modules name no ambient capability and import only their inert inputs', () => {
  for (const f of OBSERVATIONAL_MODULES) {
    const c = census(readFileSync(join(REPO, f), 'utf8'), f);
    for (const name of FORBIDDEN_NAMES) {
      assert.ok(!c.identifiers.has(name), `${f} names ${name}`);
      assert.ok(!c.keys.has(name), `${f} reaches ${name} through bracket access`);
    }
    assert.equal(c.dynamicImport, false, `${f} uses a dynamic import`);
    assert.deepEqual([...new Set(c.specifiers)].sort(), ALLOWED_SPECIFIERS[f], `${f} imports only its inert inputs`);
  }
});

test('control: the census catches the evasions a text regex misses', () => {
  const evasions = [
    ["const f = globalThis['fetch']; f('x');", 'globalThis'],
    ["const { env } = process; export const x = env.SECRET;", 'process'],
    ["const c = console; c.log('leak');", 'console'],
    ["export const t = Date.now();", 'Date'],
  ];
  for (const [source, name] of evasions) {
    assert.ok(census(source).identifiers.has(name), `census sees ${name} in: ${source}`);
  }
  assert.ok(census("const g: any = {}; g['fetch'];").keys.has('fetch'), 'bracket-access key is seen');
  assert.equal(census("export const m = () => import('node:fs');").dynamicImport, true, 'dynamic import is seen');
  assert.deepEqual(census("export * from 'pg';").specifiers, ['pg'], 're-export specifier is seen');
});

test('no migration is changed, and no role default or explicit grant is re-pinned', async () => {
  // A grant-diff stage that quietly edited the grants it measures would be measuring itself.
  // Migrations: file level — tracked changes AND untracked files, so a new, not-yet-staged migration
  // fails this too.
  const changed = [...gitPaths(['diff', '--name-only', 'HEAD', '--']), ...gitPaths(['ls-files', '--others', '--exclude-standard'])];
  assert.deepEqual(changed.filter((f) => f.startsWith('server/platform-identity/migrations/')), [],
    'no migration may be modified or added');
  // Grants: DATA level. M5-GAP11-P1-R1 had to change the catalog's and the client's COMPARISON code
  // (deny-by-default on unknown vocabulary), so a file-level ban on those files would forbid the very
  // correction; what must never move is the grant data they hold. Every role default, every explicit
  // sub-permission grant, and the client's own role tables are fingerprinted with sorted keys and
  // pinned — the value is unchanged from b61612d9, before R1.
  const cat = await import('../../server/platform-identity/permissionCatalog.ts');
  const acc = await import('../../src/context/accessConfig.ts');
  const plat = await import('../../src/owner/platformPermissionsConfig.ts');
  const stable = (v) => Array.isArray(v) ? v.map(stable)
    : v !== null && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, stable(v[k])])) : v;
  const grants = {
    server: { tenant: cat.TENANT_ROLE_PERMISSION_DEFAULTS, tenantSubs: cat.TENANT_ROLE_SUBPERMISSION_DEFAULTS, platform: cat.PLATFORM_ROLE_FEATURE_DEFAULTS },
    client: {
      tenantRoles: acc.tenantRoles.map((r) => ({ id: r.id, permissions: r.permissions, subPermissions: r.subPermissions ?? null })),
      platformDefaults: plat.DEFAULT_PLATFORM_FEATURE_LEVELS,
    },
  };
  const fingerprint = createHash('sha256').update(JSON.stringify(stable(grants))).digest('hex');
  assert.equal(fingerprint, '4c08356343ec6ef98acc2f76b09b0f68683a3f1b7a72752f2071d74cd01f4eed',
    'the production role defaults and explicit grants must not change: D2\'s re-pin lives in the candidate only');
});

test('the artifact keeps the structural diff and the D2 money actions apart, in three sections', () => {
  const text = readFileSync(join(REPO, ARTIFACT), 'utf8');
  const at = (heading) => text.indexOf(heading);
  const a = at('## A. Structural ordering diff');
  const b = at('## B. Authoritatively identified money actions (D2)');
  const c = at('## C. Unresolved mapping');
  assert.ok(a > 0 && b > a && c > b, 'sections A, B and C, in that order');
  // The P1 wording that read a structural count as a count of D2 rows is gone, and so is the
  // ambiguous "D3 only" framing of the refunds narrowing.
  for (const stale of [/waiting on D2 \(approve-gated/i, /approve-gated \| D2 \|/i, /D3 only/i, /D3's approval of the diff only/i]) {
    assert.ok(!stale.test(text), `stale wording ${stale}`);
  }
  // The structural count and the D2 count are separate numbers, and they reconcile with the rows.
  assert.match(text, /changed rows whose decisive level is `approve` \(structural\) \| 12 \|/);
  assert.match(text, /\| `money_action` \| 0 \|\n\| `unresolved` \| 12 \|\n\| `not_money_action` \| 1 \|/);
  // The narrowing is explained in full — including after the re-pin D2 chose (M5-GAP11-P2).
  const narrowing = text.slice(at('## The `manager` / `refunds` narrowing'));
  for (const q of ['level held', 'level required', 'BEFORE', 'AFTER-CANDIDATE', 'AFTER-REPIN', 'a real refund money action?', 'does D2 affect it?', 'what remains for D3']) {
    assert.ok(narrowing.includes(`| ${q} |`), `the narrowing answers: ${q}`);
  }
});

/**
 * The artifact the owner is asked to approve as D3, pinned byte for byte. Regenerating it with any
 * change — a catalog edit, a D2 grant value, a wording change in the generator — moves this hash, and
 * a moved hash is a new D3 question, not a refresh.
 */
const D3_ARTIFACT_SHA256 = 'f49ca74baf0d46a628bdcc066b95aade8f0f4ff92ef8eef20c5c8e7e394bd7c0';

test('the artifact carries the three views, the D2 grants, every unresolved mapping and the D3 decision — pinned', () => {
  const text = readFileSync(join(REPO, ARTIFACT), 'utf8');
  assert.equal(createHash('sha256').update(text, 'utf8').digest('hex'), D3_ARTIFACT_SHA256,
    'the D3 artifact changed: review the new diff, then pin its hash deliberately');
  const at = (heading) => text.indexOf(heading);
  const c = at('## C. Unresolved mapping');
  const d = at('## D. The D2 re-pin — explicit money-action grants (candidate only)');
  const e = at('## E. The final diff for D3');
  const decision = at('## The D3 decision');
  assert.ok(c > 0 && d > c && e > d && decision > e, 'sections C, D, E and the D3 decision, in that order');

  // D2 is recorded as made, in the candidate only; D3 is open; nothing asks for D2 again.
  assert.match(text, /owner decision \*\*D2\*\*, now made/);
  assert.match(text, /in the candidate only: production is not re-pinned and\s+nothing is cut over/);
  for (const stale of [/can D2 affect it\?/, /D2 has to say which representation/, /D2 is not forced by this diff/, /Both remain open/]) {
    assert.ok(!stale.test(text), `stale pre-D2 wording ${stale}`);
  }

  // Both views' counts, and the four kinds of change kept apart.
  assert.match(text, /\| pre-re-pin candidate \(the ordering flip alone\) \| 1659 \| 1646 \| 12 \| 1 \|/);
  assert.match(text, /\| post-re-pin candidate \(the flip with D2's grants\) \| 1659 \| 1646 \| 12 \| 1 \|/);
  assert.match(text, /\*\*explicit-grant representation changes\*\* — how a tuple is decided \| 17 \|/);
  assert.match(text, /\*\*re-pin effect\*\* — pre-re-pin vs post-re-pin \| 0 \|/);
  assert.match(text, /\| \*\*still unapproved\*\* \| 13 \|/);

  // Section D: seventeen explicit grants, every one preserved.
  const dRows = text.slice(d, e).split('\n').filter((l) => /^\| `(tenant|platform)\/(sub_permission|domain_threshold)` \|/.test(l));
  assert.equal(dRows.length, 17);
  assert.ok(dRows.every((l) => l.endsWith('| yes |')), 'every money action preserved');
  assert.equal(dRows.filter((l) => l.includes('| `true` |')).length, 8);
  assert.match(text, /\*\*Preserved: 17 of 17\*\*/);

  // Section C: every one of the 188 unresolved tuples, grouped; only the twelve widened ones change.
  const allUnresolved = text.slice(at('### All 188 unresolved mappings'), d);
  const groups = allUnresolved.split('\n').filter((l) => /^\| `(tenant|platform)\//.test(l));
  assert.equal(groups.reduce((n, l) => n + Number(l.split(' | ')[3]), 0), 188);
  assert.equal(groups.filter((l) => l.endsWith('| **1** |')).length, 12);

  // Section E: every changed tuple once, with every column the D3 decision needs.
  const changed = text.slice(at('### Every changed tuple'), at('## The `manager` / `refunds` narrowing'));
  assert.match(changed, /\| scope \| role \| domain \| action \| D2 classification \| authoritative \| pre-re-pin \| post-re-pin \| explicit grant \| classification source \| reason \|/);
  assert.equal(changed.split('\n').filter((l) => l.startsWith('| `tenant` |') || l.startsWith('| `platform` |')).length, 13);

  // The D3 decision offers approve, reject and revise, and approval is not a cutover.
  const d3 = text.slice(decision);
  for (const option of ['**Approve**', '**Reject**', '**Revise**']) assert.ok(d3.includes(option), option);
  assert.match(d3, /Approval does not cut anything over/);
});

test('the run-tests ratchet lists the new suites as sentinels', async () => {
  const { REQUIRED_SENTINELS, MIN_SUITES, discover } = await import('../../scripts/run-tests.mjs');
  for (const s of [
    'server/platform-identity/gap11GrantDiff.test.ts',
    'server/platform-identity/gap11ShadowComparator.test.ts',
    'tests/quality/gap11-grant-diff-artifact.test.mjs',
    // M5-GAP11-P2: the D2 explicit money-action grant suite.
    'server/platform-identity/gap11MoneyActionGrants.test.ts',
    // M5-GAP11-P1-R1: the direct deny-by-default suites.
    'server/platform-identity/permissionDecision.test.ts',
    'server/platform-identity/protectedAction.test.ts',
    'server/platform-identity/authorizationFailClosed.test.ts',
    'src/context/authorizationVocabulary.test.ts',
  ]) {
    assert.ok(REQUIRED_SENTINELS.includes(s), `${s} is a named sentinel`);
  }
  assert.ok(discover().length >= MIN_SUITES, 'the discovered count still clears the ratchet');
});
