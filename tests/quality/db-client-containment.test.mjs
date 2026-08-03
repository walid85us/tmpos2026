// Phase 4.0 M3 S4.1a — PostgreSQL client containment.
//
// The repository owns database transport security. That is only true if it owns every place a
// client is built: one module that resolves the TLS policy is worth nothing if a second module
// can call the driver directly, or if an approved module grows a third construction that skips
// the policy. This suite is the boundary check.
//
// WHAT IT PROVES
//   * exactly which files under the production-capable roots bind the PostgreSQL driver;
//   * exactly which of those construct a client;
//   * every PRODUCTION construction consumes the SHARED TLS policy, once per construction, and
//     resolves it BEFORE the driver is called;
//   * no approved site uses a string TLS policy, disables certificate verification, or replaces
//     hostname verification;
//   * the validator does not restate a private copy of the policy;
//   * the client bundle root never reaches the driver at all.
//
// SCOPE. Only `server/`, `scripts/` and `src/` are inventoried — the roots that can ship or run
// against a real endpoint. `tests/db/` is deliberately NOT inventoried: those suites are the
// disposable-PostgreSQL lanes, they target a task-owned socket or a plaintext loopback service
// that offers no TLS at all, and they pass their own `ssl: false` at the call site precisely so
// the production helper never has to infer plaintext from an endpoint shape. Widening this scan
// to them would force exactly the hostname-sniffing exemption S4.1a exists to avoid.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..');

/** Roots that can reach a real database endpoint. See SCOPE above for what is excluded and why. */
const PRODUCTION_ROOTS = ['server', 'scripts', 'src'];

/** The one module allowed to own the transport policy. */
const POLICY_MODULE = 'server/platform-identity/db.ts';
/** The exported policy resolver every production construction must consume. */
const POLICY_FN = 'resolveDatabaseTls';

/**
 * Files permitted to BIND the driver, each with the reason it is allowed.
 * A new entry here is a deliberate, reviewable decision — which is the entire point.
 */
const APPROVED_DRIVER_IMPORTS = new Map([
  [POLICY_MODULE, 'owns the shared TLS policy and both principal clients'],
  ['scripts/supabase-identity-validate.ts', 'operator validator; consumes the shared policy'],
  ['server/platform-identity/authorizationRepository.ts', 'TYPE-ONLY: postgres.Sql executor type'],
  ['server/platform-identity/migrationExecutor.ts', 'disposable-test executor; contained separately'],
]);

/**
 * Files permitted to CONSTRUCT a client. Split by whether the endpoint can be a real one.
 * The disposable executor is excluded from the policy rule on purpose: it is reachable only
 * through a validated disposable-test DSN handle, its endpoints are a task-owned socket or
 * loopback, and tests/quality/migration-executor-containment.test.mjs proves the production
 * import graph cannot reach it.
 */
const PRODUCTION_CONSTRUCTION_SITES = [POLICY_MODULE, 'scripts/supabase-identity-validate.ts'];
const CONTAINED_CONSTRUCTION_SITES = ['server/platform-identity/migrationExecutor.ts'];

const read = (p) => readFileSync(join(REPO, p), 'utf8');

/** Drop comments so a denylist never trips on prose that merely DESCRIBES a forbidden shape. */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
}

/** Source files under the given prefixes — tracked AND untracked, so an uncommitted module
 *  cannot slip past containment merely by not being staged yet. */
function localSources(...prefixes) {
  const found = new Set();
  for (const args of [['ls-files', '-z'], ['ls-files', '-z', '--others', '--exclude-standard']]) {
    const out = execFileSync('git', [...args, ...prefixes], { cwd: REPO, encoding: 'utf8' });
    for (const p of out.split('\0')) {
      if (/\.(ts|tsx|mjs|cjs|js|jsx)$/.test(p) && existsSync(join(REPO, p))) found.add(p);
    }
  }
  return [...found].sort();
}

/**
 * True when `source` BINDS the PostgreSQL driver.
 *
 * Anchored to a real import form on purpose. Several diagnostics scripts carry the literal
 * text `from 'postgres'` INSIDE a regex that scans for it — a loose match would report those
 * guards as violations, i.e. fail the repository for proving the opposite of a breach.
 */
function bindsDriver(source) {
  const code = stripComments(source);
  return (
    /^[ \t]*import\s[^\n]*\bfrom\s*['"]postgres['"]/m.test(code)
    // A re-export is a binding too: `export { default as postgres } from 'postgres'` hands the
    // driver to any importer while matching no `import` form at all.
    || /^[ \t]*export\s[^\n]*\bfrom\s*['"]postgres['"]/m.test(code)
    || /(?:^|[^\w$.])import\s*\(\s*['"]postgres['"]\s*\)/.test(code)
    || /(?:^|[^\w$.])require\s*\(\s*['"]postgres['"]\s*\)/.test(code)
  );
}

/**
 * True when `source` loads a module through a COMPUTED specifier.
 *
 * `require('post' + 'gres')` and `import(['post','gres'].join(''))` resolve to the driver while
 * matching no string-literal scan — the containment equivalent of assembling a forbidden token at
 * runtime. No legitimate call site in these roots needs a computed specifier, so the shape itself
 * is the violation and there is nothing to whitelist.
 */
function usesComputedSpecifier(source) {
  // String BODIES are blanked first (the quotes survive). Several suites in these roots carry
  // `'require('` and `import('…')` inside their own scan patterns; without this the rule reports
  // those guards as violations — failing the repository for proving the opposite of a breach.
  // Blanking is safe for this rule: a genuine literal specifier stays a literal (`''`), while
  // fragment assembly (`'post' + 'gres'`) stays non-literal and is still caught.
  const code = stripComments(source)
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""');
  const dynamic = /(?:^|[^\w$.])(?:import|require)\s*\(\s*([^)]*)\)/g;
  for (const [, arg] of code.matchAll(dynamic)) {
    const trimmed = arg.trim();
    if (trimmed === '') continue;
    if (!/^(['"])[^'"]*\1$/.test(trimmed)) return true;
  }
  return false;
}

/**
 * Offsets of every client construction in `source`.
 *
 * Only meaningful for a file that binds the driver — in ESM the identifier cannot resolve
 * otherwise — which is why callers filter by bindsDriver() first. That ordering is what makes
 * this robust: many diagnostics scripts contain `postgres(ql)?:\/\/` and `postgres\(` inside
 * scanner regexes, and none of them import the driver.
 */
function constructionOffsets(source) {
  const code = stripComments(source);
  const re = /\bpostgres\s*\(/g;
  const out = [];
  let m;
  while ((m = re.exec(code)) !== null) out.push(m.index);
  return out;
}

/** Offsets of every CALL to the shared policy resolver (its definition/export is not a call). */
function policyCallOffsets(source) {
  const code = stripComments(source);
  const re = new RegExp(`(?<!function\\s)(?<!\\.)\\b${POLICY_FN}\\s*\\(`, 'g');
  const out = [];
  let m;
  while ((m = re.exec(code)) !== null) out.push(m.index);
  return out;
}

const ALL_SOURCES = localSources(...PRODUCTION_ROOTS);
const DRIVER_BINDERS = ALL_SOURCES.filter((f) => bindsDriver(read(f)));

// --- inventory -------------------------------------------------------------

test('S4.1a-C1: exactly the approved files bind the PostgreSQL driver', () => {
  assert.ok(ALL_SOURCES.length > 0, 'the inventory must not be vacuously empty');
  assert.deepEqual(
    DRIVER_BINDERS,
    [...APPROVED_DRIVER_IMPORTS.keys()].sort(),
    'a new driver import must be reviewed and added to APPROVED_DRIVER_IMPORTS with a reason',
  );
});

test('S4.1a-C2: exactly the approved files construct a client', () => {
  const constructing = DRIVER_BINDERS.filter((f) => constructionOffsets(read(f)).length > 0);
  assert.deepEqual(
    constructing,
    [...PRODUCTION_CONSTRUCTION_SITES, ...CONTAINED_CONSTRUCTION_SITES].sort(),
    'a new client construction must be reviewed and added to the approved site list',
  );
});

test('S4.1a-C3: the client bundle root never reaches the driver', () => {
  const clientBinders = DRIVER_BINDERS.filter((f) => f.startsWith('src/'));
  assert.deepEqual(clientBinders, [], 'the browser bundle must never bind a database driver');
});

// --- every production construction consumes the shared policy ---------------

test('S4.1a-C4: EACH production construction has its OWN preceding policy resolution', () => {
  // A file-wide count is not enough, and neither is a cumulative "k calls before construction k"
  // threshold: two resolutions inside getDb() and none inside getRuntimeDb() satisfies both while
  // leaving the runtime principal with no TLS at all. The window is therefore per construction —
  // between the PREVIOUS construction and this one — so every client must resolve its own.
  for (const site of PRODUCTION_CONSTRUCTION_SITES) {
    const src = read(site);
    const constructions = constructionOffsets(src);
    const policyCalls = policyCallOffsets(src);
    assert.ok(constructions.length > 0, `${site}: expected at least one construction`);
    assert.equal(
      policyCalls.length,
      constructions.length,
      `${site}: ${constructions.length} construction(s) but ${policyCalls.length} ${POLICY_FN}() call(s)`,
    );
    let windowStart = -1;
    for (let k = 0; k < constructions.length; k += 1) {
      const inWindow = policyCalls.filter((p) => p > windowStart && p < constructions[k]).length;
      assert.ok(
        inWindow >= 1,
        `${site}: construction #${k + 1} has no ${POLICY_FN}() resolution of its own since the previous `
        + 'construction — that client would be built with whatever transport the driver defaults to',
      );
      windowStart = constructions[k];
    }
  }
});

test('S4.1a-C5: every production construction binds ssl to the resolved policy, never a literal', () => {
  // Closes the gap a pure call-count rule leaves open: `resolveDatabaseTls(dsn); postgres(dsn,
  // {ssl: false})` resolves the policy and then throws it away. `ssl` must be the resolved
  // binding — shorthand `{ ...opts, ssl }` or `ssl: <identifier>` — and never a literal, and it
  // must be present at all, since an ABSENT ssl key means the driver's plaintext default.
  const WINDOW = 400;
  for (const site of PRODUCTION_CONSTRUCTION_SITES) {
    const code = stripComments(read(site));
    for (const offset of constructionOffsets(read(site))) {
      const args = code.slice(offset, offset + WINDOW);
      const literal = args.match(/\bssl\s*:\s*(?:false|true|null|undefined|void\b|['"`{[]|\d)/);
      assert.equal(literal, null, `${site}: ssl is bound to a literal at offset ${offset}`);
      const bound = /[,{]\s*ssl\s*[,}]/.test(args) || /\bssl\s*:\s*[A-Za-z_$][\w$]*/.test(args);
      assert.ok(bound, `${site}: construction at offset ${offset} does not bind ssl to the resolved policy`);
    }
  }
});

test('S4.1a-C11: no production source loads a module through a computed specifier', () => {
  const offenders = ALL_SOURCES.filter((f) => usesComputedSpecifier(read(f)));
  assert.deepEqual(
    offenders,
    [],
    'a computed import/require specifier can reach the driver without matching any literal scan',
  );
});

test('S4.1a-C6: the validator consumes the shared policy instead of restating one', () => {
  const validator = 'scripts/supabase-identity-validate.ts';
  const code = stripComments(read(validator));
  assert.match(
    code,
    new RegExp(`import\\s*\\{[^}]*\\b${POLICY_FN}\\b[^}]*\\}\\s*from\\s*['"][^'"]*platform-identity/db`),
    `${validator} must import ${POLICY_FN} from the policy module`,
  );
  // A private copy of the policy is the failure this rule exists for: it drifts silently, and
  // the drift is invisible until a certificate rotates.
  assert.ok(
    !/rejectUnauthorized/.test(code),
    `${validator} must not restate certificate-verification options — consume ${POLICY_FN}()`,
  );
  assert.ok(!/\bca\s*:/.test(code), `${validator} must not assemble its own CA material`);
});

// --- shapes that are never acceptable at an approved site -------------------

test('S4.1a-C7: no approved site uses a string TLS policy', () => {
  // postgres.js maps 'require' | 'allow' | 'prefer' to rejectUnauthorized:false — TLS with no
  // authentication — and maps 'disable' | 'false' to plaintext. A string is never the contract.
  for (const site of PRODUCTION_CONSTRUCTION_SITES) {
    const code = stripComments(read(site));
    const bad = code.match(/\bssl\s*:\s*['"][^'"]*['"]/g) ?? [];
    assert.deepEqual(bad, [], `${site}: a string TLS policy is never acceptable`);
  }
});

test('S4.1a-C8: certificate verification is never disabled under the production roots', () => {
  // Built from fragments so this assertion cannot match itself.
  const disabled = new RegExp(`${['reject', 'Unauthorized'].join('')}\\s*:\\s*(?:false|0)\\b`);
  const offenders = ALL_SOURCES.filter((f) => disabled.test(stripComments(read(f))));
  assert.deepEqual(offenders, [], 'certificate-chain verification must never be switched off');
});

test('S4.1a-C9: hostname verification is never replaced under the production roots', () => {
  const bypass = new RegExp(['check', 'ServerIdentity'].join(''));
  const offenders = ALL_SOURCES.filter((f) => bypass.test(stripComments(read(f))));
  assert.deepEqual(offenders, [], "Node's default hostname verification must stay in force");
});

test('S4.1a-C10: no production source re-enables the driver TLS env fallback or a DSN downgrade', () => {
  // The driver reads PGSSL as the `ssl` fallback and resolves `?ssl=` / `?sslmode=` from the
  // DSN. Naming them is legitimate ONLY in the policy module, which exists to reject them.
  const envVar = ['PG', 'SSL'].join('');
  const offenders = ALL_SOURCES
    .filter((f) => f !== POLICY_MODULE)
    .filter((f) => new RegExp(`\\b${envVar}\\b`).test(stripComments(read(f))));
  assert.deepEqual(offenders, [], `only ${POLICY_MODULE} may name the driver's TLS environment fallback`);
});
