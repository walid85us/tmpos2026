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

/** The only files permitted to name them, until safeguards #1 and #3 land and a cutover is decided. */
const PERMITTED_NAMERS = [
  'scripts/generate-gap11-grant-diff.ts',
  'server/platform-identity/gap11GrantDiff.test.ts',
  'server/platform-identity/gap11GrantDiff.ts',
  'server/platform-identity/gap11ShadowComparator.test.ts',
  'server/platform-identity/gap11ShadowComparator.ts',
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
  const before = readFileSync(join(REPO, ARTIFACT), 'utf8');
  const first = runGenerator();
  assert.equal(first.status, 0, first.stderr);
  const afterOne = readFileSync(join(REPO, ARTIFACT), 'utf8');
  const second = runGenerator();
  assert.equal(second.status, 0, second.stderr);
  const afterTwo = readFileSync(join(REPO, ARTIFACT), 'utf8');

  assert.equal(afterOne, before, 'regeneration did not change the committed bytes');
  assert.equal(afterTwo, afterOne, 'two runs agree byte for byte');

  // And git agrees the file is untouched — the strongest form of "leaves no diff".
  const status = execFileSync('git', ['status', '--porcelain', '--', ARTIFACT], { cwd: REPO, encoding: 'utf8' });
  assert.ok(status.trim() === '' || status.trim().startsWith('??'),
    `regeneration left a modification in the working tree: ${status}`);
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

test('nothing outside the permitted set names the observational modules', () => {
  const offenders = [];
  for (const file of localSources('server', 'src', 'scripts', 'tests')) {
    if (PERMITTED_NAMERS.includes(file)) continue;
    const text = readFileSync(join(REPO, file), 'utf8');
    if (/gap11GrantDiff|gap11ShadowComparator/.test(text)) offenders.push(file);
  }
  assert.deepEqual(offenders, [],
    'the candidate evaluator and shadow comparator must remain unreachable from any decision path');
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
    assert.ok(!/gap11GrantDiff|gap11ShadowComparator/.test(text),
      `${f} must not reach the observational modules`);
  }
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

test('the stage changed no migration and re-pinned no role default', () => {
  // A grant-diff stage that quietly edited the catalog it measures would be measuring itself.
  // Tracked changes AND untracked files: a new, not-yet-staged migration must fail this too.
  const changed = [...gitPaths(['diff', '--name-only', 'HEAD', '--']), ...gitPaths(['ls-files', '--others', '--exclude-standard'])];
  const forbidden = changed.filter((f) =>
    f.startsWith('server/platform-identity/migrations/')
    || f === 'server/platform-identity/permissionCatalog.ts'
    || f === 'src/context/accessConfig.ts'
    || f === 'src/owner/platformPermissionsConfig.ts');
  assert.deepEqual(forbidden, [],
    'this stage must not modify a migration, the permission catalog, or either client permission config');
});

test('the run-tests ratchet lists the new suites as sentinels', async () => {
  const { REQUIRED_SENTINELS, MIN_SUITES, discover } = await import('../../scripts/run-tests.mjs');
  for (const s of [
    'server/platform-identity/gap11GrantDiff.test.ts',
    'server/platform-identity/gap11ShadowComparator.test.ts',
    'tests/quality/gap11-grant-diff-artifact.test.mjs',
  ]) {
    assert.ok(REQUIRED_SENTINELS.includes(s), `${s} is a named sentinel`);
  }
  assert.ok(discover().length >= MIN_SUITES, 'the discovered count still clears the ratchet');
});
