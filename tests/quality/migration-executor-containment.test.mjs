// Phase 4.0 M3 S1b — trusted-executor containment.
//
// The migration executor is the ONE module that opens a database connection and runs migration
// SQL. It is a short-lived OPERATOR capability, not an application capability, so the production
// application server must not be able to reach it — not by import, not by bundling, not by a
// transitive edge through a shared helper.
//
// This suite walks the real static import graph from the production server entrypoint and proves
// the executor (and the database driver it uses) is unreachable, that the compiled server build
// cannot contain it, and that the public S1 entry point stays fail-closed.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..');

const EXECUTOR = 'server/platform-identity/migrationExecutor.ts';
/** The compiled production API runtime: everything tsconfig.server.json emits. */
const PRODUCTION_ROOT = 'server/runtime';
/** The production server's entrypoint, where the import-graph walk starts. */
const PRODUCTION_ENTRY = 'server/runtime/server.ts';

const read = (p) => readFileSync(join(REPO, p), 'utf8');

/** Drop comments so a denylist never trips on prose that merely NAMES the contained module. */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
}

/** Static AND dynamic import/require specifiers referenced by a source file. */
function importSpecifiers(source) {
  const specs = [];
  const re = /\bfrom\s*['"]([^'"]+)['"]|\bimport\s*['"]([^'"]+)['"]|\b(?:import|require)\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  let m;
  while ((m = re.exec(source)) !== null) specs.push(m[1] || m[2] || m[3]);
  return specs;
}

/** Tracked source files under the given prefixes, via git so node_modules is never walked. */
function trackedSources(...prefixes) {
  const out = execFileSync('git', ['ls-files', '-z', ...prefixes], { cwd: REPO, encoding: 'utf8' });
  return out
    .split('\0')
    .filter((p) => /\.(ts|tsx|mjs|cjs|js|jsx)$/.test(p))
    .filter((p) => existsSync(join(REPO, p)));
}

/** Files present on disk under the given prefixes, tracked or not — an untracked module must not
 *  be able to slip past the containment check merely by not being committed yet. */
function localSources(...prefixes) {
  const tracked = new Set(trackedSources(...prefixes));
  const out = execFileSync('git', ['ls-files', '-z', '--others', '--exclude-standard', ...prefixes], {
    cwd: REPO,
    encoding: 'utf8',
  });
  for (const p of out.split('\0')) {
    if (/\.(ts|tsx|mjs|cjs|js|jsx)$/.test(p) && existsSync(join(REPO, p))) tracked.add(p);
  }
  return [...tracked];
}

const isFile = (abs) => {
  try {
    return statSync(abs).isFile();
  } catch {
    return false;
  }
};

/** Resolve a relative specifier to a repo-relative file path, trying the usual extensions. */
function resolveLocal(fromFile, spec) {
  if (!spec.startsWith('.')) return null;
  const base = resolve(dirname(join(REPO, fromFile)), spec);
  // A NodeNext source imports './config.js' from './config.ts'; without this the walk stops at
  // the entrypoint and the containment assertion becomes vacuously true.
  const tsTwin = base.replace(/\.(js|mjs|cjs)$/, '.ts');
  for (const cand of [base, tsTwin, `${base}.ts`, `${base}.tsx`, `${base}.mjs`, `${base}.js`, join(base, 'index.ts')]) {
    if (isFile(cand)) return cand.slice(REPO.length + 1);
  }
  return null;
}

/** Every repo file transitively reachable from `entry` through local imports. */
function reachableFrom(entry) {
  const seen = new Set();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    let src;
    try {
      src = stripComments(read(file));
    } catch {
      continue;
    }
    for (const spec of importSpecifiers(src)) {
      const local = resolveLocal(file, spec);
      if (local !== null && !seen.has(local)) queue.push(local);
    }
  }
  return seen;
}

test('the executor exists and is the module under containment', () => {
  assert.ok(existsSync(join(REPO, EXECUTOR)), `${EXECUTOR} must exist`);
  assert.ok(existsSync(join(REPO, PRODUCTION_ENTRY)), `${PRODUCTION_ENTRY} must exist`);
});

test('S1b-25: the production application-server import graph cannot reach migrationExecutor', () => {
  const reachable = reachableFrom(PRODUCTION_ENTRY);
  assert.ok(reachable.size > 1, 'the graph walk must actually traverse imports');
  assert.equal(
    reachable.has(EXECUTOR),
    false,
    `the production server graph reached the executor via: ${[...reachable].join(', ')}`,
  );
});

test('S1b-25: no production runtime or frontend source names the executor at all', () => {
  const offenders = [];
  for (const file of localSources(PRODUCTION_ROOT, 'src')) {
    const src = stripComments(read(file));
    if (src.includes('migrationExecutor')) offenders.push(file);
  }
  assert.deepEqual(offenders, [], 'production runtime/frontend code must not reference the executor');
});

test('S1b-25: the PostgreSQL driver has a declared, unchanged set of importers', () => {
  // The application's own data layer legitimately holds a runtime client; that is a DIFFERENT
  // principal from the migrator and is out of S1b scope. What must not happen is a NEW driver
  // importer appearing unnoticed — especially one inside the production runtime graph. So the
  // inventory is asserted exactly, and each entry is named with the reason it is allowed.
  const APPLICATION_RUNTIME_CLIENTS = [
    'server/platform-identity/authorizationRepository.ts', // request-time authorization reads
    'server/platform-identity/db.ts',                      // application runtime connection pool
  ];
  const importers = [];
  for (const file of localSources('server')) {
    const src = stripComments(read(file));
    for (const spec of importSpecifiers(src)) {
      if (spec === 'postgres' || spec === 'pg') { importers.push(file); break; }
    }
  }
  assert.deepEqual(
    importers.sort(),
    [...APPLICATION_RUNTIME_CLIENTS, EXECUTOR].sort(),
    'a new PostgreSQL driver importer appeared under server/ and must be reviewed',
  );
  assert.ok(importers.includes(EXECUTOR), 'the executor is the migrator-side driver importer');

  // The decisive property: NOTHING in the compiled production runtime graph imports a driver
  // through the executor. The application clients above are not reachable from it either.
  const reachable = reachableFrom(PRODUCTION_ENTRY);
  for (const client of [...APPLICATION_RUNTIME_CLIENTS, EXECUTOR]) {
    assert.equal(reachable.has(client), false, `${client} must not be reachable from the production entrypoint`);
  }
});

test('S1b-25: the compiled production build cannot contain the executor', () => {
  const cfg = JSON.parse(read('tsconfig.server.json'));
  assert.equal(cfg.compilerOptions.rootDir, PRODUCTION_ROOT, 'the emitting build is rooted at the runtime only');
  assert.deepEqual(cfg.include, [`${PRODUCTION_ROOT}/**/*.ts`], 'the build includes only the production runtime');
  assert.ok(
    !EXECUTOR.startsWith(`${PRODUCTION_ROOT}/`),
    'the executor lives outside the emitting root, so tsc cannot emit it',
  );
});

// --- C2B-R2A: the managed apply path is FORWARD-ONLY -------------------------
//
// The exact-[005] gate constrains WHICH migration may run and proves nothing about direction.
// Direction is decided at the CLI seam, so it is held here.

const MIGRATE_CLI = 'scripts/supabase-migrate.ts';

/** The `if (wantManagedDev) { … }` dispatch branch, comments stripped. */
function managedDispatchBranch() {
  const m = stripComments(read(MIGRATE_CLI)).match(/if \(wantManagedDev\)[\s\S]*?\n {2}\}/);
  assert.ok(m, 'the managed dispatch branch must exist');
  return m[0];
}

test('C2B-R2A: the managed apply resolves direction BEFORE entering the managed runner', () => {
  // Decisive because of WHERE the call sits, not merely that it exists: the gate is an ARGUMENT
  // to runThroughManagedExecutor, so JavaScript evaluates it before the runner is entered — and
  // the runner is where the operator gates, the DSN read, the client, the live fingerprint, the
  // advisory lock and every write live. A gate inside the runner would already be too late.
  assert.match(
    managedDispatchBranch(),
    /return runThroughManagedExecutor\(`apply\(\$\{managedApplyDirectionOrRefuse\(\)\}\)`, PRODUCTION_MANAGED_PORTS\)/,
    'the managed apply label must come from the direction gate and nowhere else',
  );
  const cli = stripComments(read(MIGRATE_CLI));
  assert.match(
    cli,
    /function managedApplyDirectionOrRefuse\(\): 'up' \{[\s\S]*?resolveManagedApplyDirection\(managedDirectionTokens\(\), hasFlag\('--down'\)\)/,
    'both direction sources must be fed to the shared resolver',
  );
  // Not getOpt: it is first-wins and cannot distinguish "no --direction" from "--direction with
  // no value", so a repeated or valueless token would resolve silently instead of refusing.
  assert.ok(
    !/resolveManagedApplyDirection\(getOpt\(/.test(cli),
    'the managed resolver must not be fed by the first-wins getOpt helper',
  );
});

test('C2B-R2A: the managed dispatch cannot express a DOWN direction at all', () => {
  // Requirement: error/report wording must never describe a DOWN request as a permitted apply.
  // Since the only direction the resolver can return is UP, the op label is structurally unable
  // to say otherwise — and the branch names no reverse direction anywhere.
  assert.ok(!/\bdown\b/i.test(managedDispatchBranch()), 'the managed dispatch must not name a down direction');
});

test('C2B-R2A: no generic managed rollback capability exists', () => {
  const exec = stripComments(read(EXECUTOR));
  const resolver = exec.match(/export function resolveManagedApplyDirection\([\s\S]*?\n\}/);
  assert.ok(resolver, 'the resolver must exist in the executor');
  assert.match(resolver[0], /\): 'up' \{/, "the resolver's return type is the literal 'up'");
  const returns = (resolver[0].match(/\breturn\b[^;]*/g) ?? []).map((r) => r.trim());
  assert.deepEqual(returns, ["return 'up'"], 'exactly one return, and it is forward');
  // No override, force flag, or environment escape hatch may re-open a managed reverse path.
  assert.ok(
    !/managedRollback|runManagedDown|applyManagedDown|ALLOW_MANAGED_DOWN|FORCE_MANAGED/i.test(exec),
    'no managed rollback entry point or escape hatch may exist',
  );
});

test('C2B-R2B: the managed apply supplies the authoritative post-lock plan policy', () => {
  const cli = stripComments(read(MIGRATE_CLI));
  // The preflight remains, but it is advisory. What makes the run safe is the policy handed to the
  // trusted runner, evaluated with the lock held — so the wiring itself is pinned here.
  // C2B-M005-B0 widened this: the managed apply now hands the SINGLE-PURPOSE 005 policy, which
  // re-derives the ledger RELATION SHAPE and the migration ARTIFACT under the lock in addition to
  // the plan. The plain exact-plan policy is no longer what guards the one live apply path.
  assert.match(
    cli,
    /runTrustedApply\(\{[\s\S]*?executionPolicy: createManagedM005Policy\(\{[\s\S]*?catalog: handle\.catalog/,
    'the managed apply must pass the single-purpose 005 policy into runTrustedApply',
  );
  assert.match(
    cli,
    /postCommitPolicy: createM005PostCommitPolicy\(\{/,
    'the managed apply must pass the post-commit verification policy',
  );
  assert.ok(
    !/createManagedExactPlanPolicy/.test(cli),
    'the weaker exact-plan policy must not remain wired into the live apply path',
  );
  // Same discovery source for the runner and the gate: a policy reading a DIFFERENT fsPort would
  // authorize a world the executor never saw.
  assert.match(cli, /const fsPort = createNodeFsPort\(/, 'one shared discovery port');
  assert.match(cli, /fsPort,[\s\S]{0,400}?executionPolicy/, 'the runner and the policy share it');
});

test('C2B-R2B: the trusted runner authorizes under the lock and cannot be bypassed', () => {
  const exec = stripComments(read(EXECUTOR));
  // The gate hangs off a SUCCESSFUL acquire_lock — not off entry, and not off the caller.
  assert.match(
    exec,
    /effect\.kind === 'acquire_lock' && event\.type === 'lock' && event\.acquired === true/,
    'authorization must be triggered by a genuinely acquired lock',
  );
  // And a program that never emits acquire_lock must not therefore run unpoliced.
  assert.match(exec, /MUTATING_EFFECT_KINDS\.has\(effect\.kind\)/, 'mutating effects are guarded');
  assert.match(exec, /EXECUTION_POLICY_UNEVALUATED/, 'an unevaluated policy is fail-closed');
  // The gate must judge what EXECUTES, not the plan object it was built from.
  assert.match(
    exec,
    /programExecutionPlan\(result\.state\.program\)/,
    "the authorized plan comes from the frozen program's own execute effects",
  );
  // Binding the VERSION alone is not binding the plan: two SQL bodies can wear one version label,
  // so a content edit between freeze and re-read would pass a label-only comparison while stale
  // bytes execute. The checksum comparison is what makes "same plan" mean "same bytes".
  assert.match(
    exec,
    /will\.checksum !== want\.checksum/,
    'the authorized checksum must be compared to the executed checksum',
  );
});

test('C2B-M005-B1-R1: the managed apply supplies the PRE-commit gate, over the same catalog', () => {
  const cli = stripComments(read(MIGRATE_CLI));
  // The gate that can still PREVENT the mutation, as opposed to the post-commit one that can only
  // decline to call a durable mutation verified. Pinned here because the executor can require that
  // SOME gate is supplied but cannot verify which one — the wiring is the only place that decides.
  assert.match(
    cli,
    /preCommitPolicy: createM005PreCommitPolicy\(\{/,
    'the managed apply must pass the pre-commit default-ACL gate into runTrustedApply',
  );
  // The SAME catalog the other policies use, which is the handle's — built over the one reserved
  // connection. A different port would read the pre-migration catalog and approve anything.
  assert.match(
    cli,
    /preCommitPolicy: createM005PreCommitPolicy\(\{ catalog: handle\.catalog \}\)/,
    'the gate must read through the handle catalog, not a second port',
  );
  // ORDER IN THE LITERAL IS NOT THE CONTRACT, but the pair being present together is: a post-commit
  // policy without a pre-commit one is exactly the B1 shape this stage exists to remove.
  assert.match(cli, /preCommitPolicy:[\s\S]{0,400}?postCommitPolicy:/, 'both gates are wired');
  // And NO headline may present a finalized-but-abandoned migration as an applied one: the
  // tx-scoped finalize runs inside the bracket, one effect before the gate, so a refusal leaves
  // `report.applied` holding a version whose transaction was then abandoned. C2B-M005-B1-R2
  // extends this to the disposable branch, which counts the same field and had the same wrong
  // word — so the assertion is now the ABSENCE of "applied=", not a count of where it survives.
  assert.equal((cli.match(/outcome=\$\{report\.outcome\} finalized=/g) ?? []).length, 2,
    'both apply headlines report a FINALIZED count');
  assert.equal((cli.match(/outcome=\$\{report\.outcome\} applied=/g) ?? []).length, 0,
    'and no headline says "applied" of a count that includes an abandoned finalize');
  // The disposable branch owes no gated mutation state, so its durability evidence is the commit
  // outcome AND the read-back. Without the second, `outcome=complete commit=resolved` is readable
  // as "durably verified" when nothing verified it — `resolved` is client-side evidence only.
  assert.match(cli, /commit=\$\{applyCommitOutcome\(report\.commit\)\} readBack=\$\{report\.commit\.readBackVerified\}/,
    'the disposable headline must carry the read-back alongside the commit outcome');
  assert.match(cli, /classifyApplyMutationState\(report\)/, 'the mutation state is surfaced to the operator');
});

test('C2B-M005-B1-R1: the pre-commit requirement is derived from the program, not from a caller flag', () => {
  const exec = stripComments(read(EXECUTOR));
  // A flag a caller must remember to set is bypassed by forgetting it. The requirement is computed
  // from the frozen program's own execution plan, so the only way to avoid owing the gate is to
  // stop being the exact-[005] execution.
  assert.match(
    exec,
    /requiredPreCommitEntryRefusal\(executionPlan, preCommit !== undefined, totalCommits\)/,
    'the requirement must be derived from the frozen program',
  );
  assert.match(exec, /MANAGED_PRECOMMIT_POLICY_MISSING/, 'a missing gate is fail-closed');
  assert.match(exec, /MANAGED_PRECOMMIT_NOT_TRANSACTIONAL/, 'an ungatable program is fail-closed');
  // The gate is evaluated BEFORE the effect is interpreted. `interpretEffect` is what calls
  // `session.commitTx()`, so a gate evaluated after it would be the post-commit shape again.
  const gateAt = exec.indexOf("effect.kind === 'commit_tx'");
  const interpretAt = exec.indexOf('const event = await interpretEffect(');
  assert.ok(gateAt > 0 && interpretAt > 0, 'both landmarks must exist');
  assert.ok(gateAt < interpretAt, 'the pre-commit gate must be evaluated before the effect is interpreted');
  // Only an explicit null passes, and the refusal is bounded to a pre-commit code.
  assert.match(exec, /PRE_COMMIT_GATE_CODES\.has\(raw\)/, 'the gate refusal is bounded to a pre-commit code');
  assert.match(exec, /report\.preCommitVerified = true/, 'approval is recorded, and only on a null return');
  // The compensating unlock must not run while an uncommitted bracket is open.
  assert.match(exec, /&& !bracketOpen/, 'no advisory unlock inside an open, uncommitted bracket');
});

test('C2B-R2C: no session disposal swallows a failed client close', () => {
  const exec = stripComments(read(EXECUTOR));
  // The decisive rule. `.catch()` on the shutdown is what turned "termination attempted" into
  // "termination achieved" — and, by implication, a session-scoped advisory lock reported as
  // released on no evidence. Both factories are covered by one rule so neither can regress alone.
  assert.ok(
    !/client\.end\([^)]*\)\s*\.catch/.test(exec),
    'client.end() failure must never be swallowed at the shutdown call itself',
  );
  // The latch must follow the shutdown: setting it first lets a FAILING end() disable its own
  // compensating retry via the `if (destroyed) return` guard.
  const latched = exec.match(/await client\.end\(\{ timeout: 0 \}\);\s*destroyed = true;/g) ?? [];
  assert.equal(latched.length, 2, 'both the managed and disposable disposers latch AFTER the shutdown resolves');
});

test('C2B-R2C: terminate() is loud and only the handle-level disposer is quiet', () => {
  const exec = stripComments(read(EXECUTOR));
  // terminate() feeds the runner's disposal verdict, so it must be able to fail. The HANDLE
  // disposer is different: callers run it in a `finally`, where a throw would replace the real
  // failure — so that one stays quiet by design.
  assert.match(
    exec,
    /terminate: async \(\) => \{\s*reservedConn = null;\s*await dispose\(\);\s*\}/,
    'the managed terminate must use the loud disposer',
  );
  assert.match(exec, /return \{ adapter, ledger, dispose: disposeQuietly \}/, 'disposable handle disposer stays quiet');
  // C2B-M005-B0 — THE MANAGED HANDLE NO LONGER DISCARDS ITS TEARDOWN. It still never throws (the
  // CLI runs it in a `finally`, where a throw would replace the real failure), but the outcome is
  // now a value the caller must deal with rather than a silent no-op.
  assert.match(exec, /dispose: disposeReporting \}/, 'the managed handle disposer REPORTS its result');
  assert.match(
    exec,
    /code: EXECUTOR_CODES\.CLIENT_TEARDOWN_FAILED/,
    'a failed managed teardown produces a bounded code',
  );
  assert.match(
    exec,
    /gracefulSocketClose: 'not_observed'/,
    'teardown completion is never presented as observed graceful socket closure',
  );
  // And the runner must not invent a success: a failed destroy is 'none', never 'terminated',
  // and it may only supply a code when none was already recorded.
  assert.match(
    exec,
    /report\.disposal = 'none';[\s\S]{0,200}?report\.code = report\.code \?\? EXECUTOR_CODES\.DISPOSAL_FAILED;/,
    'a failed disposal preserves any primary code',
  );
});

test('C2B-R2A: the disposable/local path keeps its DOWN semantics unchanged', () => {
  const cli = stripComments(read(MIGRATE_CLI));
  assert.match(
    cli,
    /runThroughExecutor\(rawDirection === 'down' \? 'apply\(down\)' : 'apply\(up\)', true\)/,
    'the disposable apply still selects a direction',
  );
  assert.match(
    cli,
    /rawDirection === 'down' && !hasFlag\('--allow-down'\)/,
    'the historical --allow-down operator gate is untouched',
  );
  assert.match(cli, /runDryRun\(direction\)/, 'the database-free dry-run still accepts both directions');
});

test('S1b-25: only the operator CLI and the test suites may import the executor', () => {
  const importers = [];
  for (const file of localSources('server', 'src', 'scripts', 'tests')) {
    if (file === EXECUTOR) continue;
    const src = stripComments(read(file));
    for (const spec of importSpecifiers(src)) {
      if (spec.includes('migrationExecutor')) { importers.push(file); break; }
    }
  }
  const allowed = new Set([
    'tests/quality/migration-executor-containment.test.mjs', // the validator-to-driver equality proof
    'scripts/supabase-migrate.ts',
    'server/platform-identity/migrationExecutor.test.ts',
    'tests/db/migrationEngine.integration.test.mjs',
    // S2: the tenant/store isolation proof applies migrations 001-005 through the SAME trusted
    // executor rather than inventing a second apply path. It is a tests/db/ suite, the category
    // already permitted here, and it changes nothing about the decisive containment property
    // asserted above — that the production import graph reaches no driver and no executor.
    'tests/db/rlsIsolation.integration.test.mjs',
    // S3: the durable-audit atomicity proof needs the real 001-005 schema before it can say
    // anything about audit privileges or transaction behaviour, and it obtains it the same way
    // the S2 suite does — through the SAME trusted executor. The alternative is executing the
    // .sql files directly, which is the second apply path the entry above exists to avoid.
    // Same category (a tests/db/ suite), same reasoning, and the decisive containment property
    // asserted above is untouched: the production import graph still reaches no driver and no
    // executor.
    'tests/db/auditAtomicity.integration.test.mjs',
    // M6-PG-P4: the PostgreSQL transactional-store proof needs 001-006 applied before it can say anything about
    // the adapter, and applies them the same way the S2 and S3 suites do — through the SAME trusted executor,
    // never a second apply path. Same category (a tests/db/ suite), same reasoning; the decisive containment
    // property asserted above is untouched.
    'tests/db/transactionalStore.integration.test.mjs',
    // C2B-M005-P2-B0: the fixed READ-ONLY comprehensive migration-005 preflight child. It imports
    // the executor for the SAME reason the default-ACL diagnostic does — the sealed managed target,
    // the bounded catalog port and the accepted pure classifiers — rather than opening a second
    // connection path or re-deriving the DSN contract. It is a single-purpose diagnostic with its
    // own launcher and its own five-key child environment, it calls no write, apply, baseline,
    // dirty-resolution or owner-ACL surface, and the tests below assert each of those directly. The
    // decisive containment property asserted above is untouched: the PRODUCTION import graph still
    // reaches no driver and no executor.
    'scripts/managed-m005-comprehensive-preflight.ts',
    // C2B-R2: the owner-side database-ACL provisioning CLI. Migration 005 verifies that PUBLIC no
    // longer holds database-level TEMPORARY and refuses to apply while it does, but it cannot
    // CLOSE that privilege — a non-owner REVOKE inside a migration is a silent no-op that emits
    // only a warning. Closing it is a database-owner action and 005 is immutable, so it needs its
    // own operator entry point. It reuses the SAME validated managed handle rather than opening a
    // second connection path, which is why it belongs here; it is an operator CLI and never part
    // of the runtime import graph.
    'scripts/supabase-owner-provision.ts',
    // C2B-M005-P0: the fixed READ-ONLY default-ACL diagnostic and its deterministic suite. The
    // diagnostic answers one catalog question and has no apply path of its own; it reuses the SAME
    // validated managed target, sealed TLS construction and environment containment rather than
    // opening a second connection route, which is precisely why it must import this module. It is
    // an operator diagnostic and never part of the runtime import graph, so the decisive property
    // asserted above — that the production graph reaches no driver and no executor — is unchanged.
    'scripts/managed-default-acl-preflight.ts',
    'tests/quality/managed-default-acl-preflight.test.mjs',
  ]);
  const unexpected = importers.filter((f) => !allowed.has(f));
  assert.deepEqual(unexpected, [], `unexpected importer(s) of the executor: ${unexpected.join(', ')}`);
});

test('S1b-26: the public S1 runMigrations entry point is still an unconditional refusal', () => {
  const engine = read('server/platform-identity/migrationEngine.ts');
  assert.match(
    engine,
    /export async function runMigrations\([\s\S]{0,2000}?throw engineError\(ENGINE_CODES\.MIGRATION_EXECUTION_UNAVAILABLE\)/,
    'runMigrations must still throw before reading any argument',
  );
  // The kernel must stay database-free: no driver import, no connection string, no SQL execution.
  const code = stripComments(engine);
  for (const forbidden of ["from 'postgres'", "require('postgres')", '.unsafe(', 'DATABASE_URL']) {
    assert.ok(!code.includes(forbidden), `the pure kernel must not contain ${forbidden}`);
  }
});

// --- C2B-R2D: session-level advisory-lock ownership ------------------------

test('C2B-R2D: the historical baseline balances its ONE acquisition before the session is pooled', () => {
  const src = stripComments(read(EXECUTOR));
  const start = src.indexOf('export async function runTrustedHistoricalBaseline');
  assert.ok(start > 0, 'the baseline runner must exist');
  const body = src.slice(start, src.indexOf('export function assertExactManagedApplyPlan', start));

  assert.equal((body.match(/session\.acquireRunLock\(/g) ?? []).length, 1, 'exactly one physical acquisition');
  assert.equal((body.match(/session\.releaseRunLock\(/g) ?? []).length, 1, 'and exactly one corresponding unlock');

  // ORDER, by index rather than one brittle span. `close()` RELEASES the connection to the pool
  // rather than ending it, so an unlock placed after it — or skipped when unverified — would hand
  // back a connection that still holds the run's session-scoped lock.
  const iUnlock = body.indexOf('releaseRunLock(deps.lockKey)');
  const iGuard = body.indexOf('if (!released.ok || released.value !== true)');
  const iClose = body.indexOf('session.close()');
  assert.ok(iUnlock > 0, 'the baseline must release its own acquisition');
  assert.ok(iGuard > iUnlock, 'and must guard on the unlock being VERIFIED true');
  assert.ok(iClose > iGuard, 'and must only pool the connection after that guard');
  assert.match(
    body.slice(iGuard, iClose),
    /await destroy\(\);[\s\S]*?return report;/,
    'an unverified release must destroy the session and return, never fall through to close()',
  );
  assert.match(
    body,
    /report\.code = report\.code \?\? ENGINE_CODES\.RUN_UNLOCK_FAILED/,
    'an unverified release is recorded, and `??` keeps any primary failure',
  );

  // The cleanup detail must be derived from the ACTUAL disposal, never asserted ahead of it.
  assert.ok(
    body.indexOf('await destroy();', iGuard) < body.indexOf("report.disposal === 'terminated'", iGuard),
    'the cleanup detail must be written AFTER destroy(), from its real result',
  );

  // A failed close is recorded, matching runTrustedLedgerRead and the kernel — otherwise the report
  // is `complete / code:null / terminated`, which the CLI's code-keyed gate reads as clean.
  assert.match(
    body.slice(iClose),
    /if \(!closed\.ok\)[\s\S]{0,400}?report\.code = report\.code \?\? ENGINE_CODES\.PORT_OPERATION_FAILED/,
    'a failed connection release must never be silent',
  );

  // A post-commit read-back failure must preserve the adoption evidence, not refuse it away.
  assert.match(
    body,
    /if \(!back\.ok\)[\s\S]{0,800}?report\.adopted = want\.slice\(\);/,
    'a committed adoption is never reported as "nothing happened"',
  );
});

// --- C2B-R2E: commit resolution -------------------------------------------

test('C2B-R2E: COMMIT submission is marked BEFORE the await, and never rolled back after', () => {
  const code = stripComments(read(EXECUTOR));
  const start = code.indexOf('writeAdoptedPrefix: async (rows, observe)');
  assert.ok(start > 0, 'the managed write port must accept the commit observer');
  const body = code.slice(start, code.indexOf('const ownerAcl', start));

  // ORDER is the whole mechanism: marked before the await, the flag survives a rejection AND a
  // deadline that abandons the promise. Marked after, it would tell us nothing on either path.
  const iMark = body.indexOf('observe.commitSubmitted()');
  const iCommit = body.indexOf("c.unsafe('commit')");
  const iAck = body.indexOf('observe.commitAcknowledged()');
  assert.ok(iMark > 0 && iCommit > iMark, 'commitSubmitted() must precede the COMMIT await');
  assert.ok(iAck > iCommit, 'commitAcknowledged() must follow it');

  // A ROLLBACK after COMMIT is submitted cannot undo anything and would dress an undetermined
  // outcome as a rolled-back one.
  assert.match(
    body,
    /if \(!submitted\) await c\.unsafe\('rollback'\)/,
    'rollback must be skipped once COMMIT is submitted',
  );
});

test('C2B-R2E: a timeout can never be reported as "did not commit"', () => {
  const src = stripComments(read(EXECUTOR));
  const start = src.indexOf('export async function runTrustedHistoricalBaseline');
  const body = src.slice(start, src.indexOf('export function assertExactManagedApplyPlan', start));

  // A deadline abandons the write rather than cancelling it, so `timedOut` alone forces UNKNOWN
  // even when COMMIT has not been reached — the write may still issue it after this line.
  assert.match(
    body,
    /wrote\.timedOut \|\| submitted\) \? 'unknown' : 'not_committed'/,
    'timeout OR submission must yield unknown; only a definite pre-commit rejection may claim non-commit',
  );
  assert.match(
    body,
    /wrote\.ok \|\| acknowledged\s*\n?\s*\? 'committed'/,
    'an acknowledged or resolved write is committed',
  );

  // The bare claim may appear ONLY in the branch that positively established it.
  const claims = body.match(/did not commit[^']*/g) ?? [];
  assert.equal(claims.length, 1, `exactly one "did not commit" claim may exist, found ${claims.length}`);
  assert.match(claims[0], /never submitted/, 'and it must state the evidence that licenses it');
  assert.match(body, /BASELINE_COMMIT_UNKNOWN/, 'the unknown branch must carry its own code');

  // GUARDED, not fallen-through: `commit` can be 'committed' here too, when a port rejects after
  // acknowledging. Reaching the definite claim by `else` would assert non-commit over a commit.
  assert.match(
    body,
    /\} else if \(report\.commit === 'not_committed'\) \{/,
    'the definite non-commit claim must be guarded on the verdict itself',
  );

  // And the UNKNOWN detail must be DERIVED from whether submission was established — asserting
  // "COMMIT WAS SUBMITTED" on a deadline that fired first is the same defect mirrored.
  assert.match(
    body,
    /submitted\s*\n?\s*\? 'COMMIT WAS SUBMITTED/,
    'the unknown detail must branch on submitted, never assert it',
  );
});

test("C2B-R2E: commit resolution is its own dimension, out of the catch-all's reach", () => {
  const src = stripComments(read(EXECUTOR));
  const start = src.indexOf('export async function runTrustedHistoricalBaseline');
  const body = src.slice(start, src.indexOf('export function assertExactManagedApplyPlan', start));
  // The catch-all writes outcome and code unconditionally. It must never write commit or adopted,
  // which is what makes established mutation evidence survive it.
  const tail = body.slice(body.lastIndexOf('} catch {'));
  // GUARD: a negative-only assertion over a collapsed slice passes vacuously. `lastIndexOf` returns
  // -1 when the catch clause is reformatted, and `slice(-1)` is one character.
  assert.ok(tail.length > 40, 'the catch slice must be found, not collapsed to a suffix'),
  assert.ok(!tail.includes('report.commit'), 'the catch-all must not touch commit resolution');
  assert.ok(!tail.includes('report.adopted'), 'nor the adoption evidence');
  // And no cleanup path may derive commit state from disposal.
  assert.ok(
    !/report\.commit\s*=\s*[^;]*disposal/.test(body),
    'commit resolution must never be computed from session disposal',
  );
});

test('C2B-R2E: the managed CLI surfaces an UNKNOWN commit as a non-zero operational refusal', () => {
  const cli = stripComments(read(MIGRATE_CLI));
  const fn = cli.indexOf('async function runThroughManagedExecutor');
  const start = cli.indexOf("} else if (op === 'baseline') {", fn);
  const end = cli.indexOf('\n      } else {', start);
  const branch = cli.slice(start, end);

  assert.match(branch, /commit=\$\{report\.commit\}/, 'commit resolution must be visible');
  // Checked FIRST: `baseline did not complete: <code>` reads as "nothing happened", which is the
  // reading that invites the re-run this state forbids.
  const iUnknown = branch.indexOf("report.commit === 'unknown'");
  // The GENERIC branch, anchored on its own `else if` so the identical sub-expression inside the
  // committed-evidence condition above it cannot be mistaken for it.
  const iGeneric = branch.indexOf("} else if (report.outcome !== 'complete') {");
  assert.ok(iUnknown > 0 && iGeneric > iUnknown, 'the UNKNOWN branch must be evaluated first');
  assert.match(branch, /Do NOT re-run baseline/, 'and must forbid the re-run');
  assert.match(branch, /Do NOT run apply\/migration 005/, 'and forbid continuation');
  assert.match(branch, /refusal =/, 'and it must be a refusal, so the CLI exits non-zero');

  // A CERTAIN commit must be branched on before the generic outcome check. `baseline did not
  // complete` over a transaction that landed is the same "nothing happened" mis-report the
  // executor's own post-commit branches exist to prevent.
  const iCommitted = branch.indexOf("report.commit === 'committed'");
  assert.ok(iCommitted > 0 && iCommitted < iGeneric, 'committed evidence must outrank the generic message');
  assert.match(branch.slice(iCommitted, iGeneric), /Do NOT re-run baseline/, 'and must forbid the re-run too');
});

test('C2B-R2D: a destroyed managed handle cannot be revived into a fresh backend', () => {
  const code = stripComments(read(EXECUTOR));
  const start = code.indexOf('export async function createManagedDevExecutor');
  assert.ok(start > 0, 'the managed factory must exist');
  const body = code.slice(start);
  // terminate() ends the client AND nulls the reservation, so without this guard a later phase's
  // reserve() would connect a BRAND-NEW backend holding none of the run's locks — which the
  // handle's own `destroyed` latch would then refuse to tear down.
  assert.match(
    body,
    /reserve: async \(\) => \{[\s\S]{0,200}?if \(destroyed\) return fail\([\s\S]{0,120}?if \(reservedConn === null\) reservedConn = await client\.reserve\(\)/,
    'reserve must fail closed on a destroyed handle, before it can open a new connection',
  );
});

test('C2B-R2D: no blanket unlock, and no caller-supplied "already locked" bypass', () => {
  const code = stripComments(read(EXECUTOR));
  // pg_advisory_unlock_all would release locks this run never took, including another session's
  // work on a shared backend. The only permitted release is the keyed one.
  assert.ok(!code.includes('advisory_unlock_all'), 'the executor must never release locks in bulk');
  // A boolean that says "someone else already holds it" cannot be bound to THIS session's actual
  // ownership, so it must not exist: each trusted runner acquires and releases its own.
  for (const bypass of ['alreadyLocked', 'skipLock', 'assumeLocked', 'reuseLock']) {
    assert.ok(!code.includes(bypass), `no lock bypass switch may exist (${bypass})`);
  }
});

test('C2B-R2D: the managed baseline CLI branch surfaces disposal and refuses an unclean run', () => {
  const cli = stripComments(read(MIGRATE_CLI));
  // Scope to the MANAGED function: the disposable path has a same-shaped baseline branch earlier
  // in the file, and pinning that one would prove nothing about the managed recovery path.
  const fn = cli.indexOf('async function runThroughManagedExecutor');
  assert.ok(fn > 0, 'the managed executor entry point must exist');
  const start = cli.indexOf("} else if (op === 'baseline') {", fn);
  assert.ok(start > fn, 'the managed baseline branch must exist');
  // End at the APPLY branch, matched on its exact indentation so the nested `} else {` inside the
  // allowlist check cannot truncate the slice into a vacuous pass.
  const end = cli.indexOf('\n      } else {', start);
  assert.ok(end > start, 'the managed apply branch must follow the baseline branch');
  const branch = cli.slice(start, end);

  assert.match(branch, /disposal=\$\{report\.disposal\}/, 'cleanup disposition must be visible to the operator');
  assert.match(
    branch,
    /else if \(report\.code !== null\)[\s\S]{0,400}?refusal =/,
    'a COMPLETE adoption carrying a code must not exit clean',
  );
  assert.match(
    branch,
    /report\.disposal === 'none'[\s\S]{0,600}?advisory-lock release is UNKNOWN/,
    'an unproven closure must report the lock release as UNKNOWN, never as released',
  );
  assert.match(
    branch,
    /refusal = refusal === null \?[\s\S]{0,200}?: `\$\{refusal\}\./,
    'the cleanup note is APPENDED, never replacing the primary refusal',
  );
});

test('S1b: the executor never reads an ambient application DSN', () => {
  const code = stripComments(read(EXECUTOR));
  for (const forbidden of ['SUPABASE_DATABASE_URL', 'APP_DATABASE_URL']) {
    assert.ok(!code.includes(forbidden), `the executor must never name ${forbidden}`);
  }
  // `DATABASE_URL` may appear only as the tail of the one variable it is allowed to read.
  const dsnReads = code.match(/[A-Z_]*DATABASE_URL/g) ?? [];
  assert.deepEqual([...new Set(dsnReads)], ['TM_POS_TEST_DATABASE_URL'], 'exactly one DSN variable may be named');
});

// --- C2B-R3A-C1: the project-url corroboration parser -------------------------
//
// The gateway url and the database host are DIFFERENT provider artifacts. C1 gave each its own
// parser, so the shape accepted for one can never be reached from the other, and so the rejected
// `split('.')[0]` heuristic cannot creep back into either.

test('C1 containment: the two url artifacts are parsed by two SEPARATE, explicitly named parsers', () => {
  const code = stripComments(read(EXECUTOR));
  assert.match(code, /function dbHostProjectRefOf\(host: string\)/, 'the database-host parser is named for its input');
  assert.match(code, /function apiProjectRefOf\(url: URL\)/, 'the gateway-url parser is named for its input');
  // Each is applied to its OWN artifact, and to nothing else.
  assert.match(code, /userRef = userProjectRefOf\(declaredUser\)/, 'the username reference is read');
  assert.match(
    code,
    /hostRef = endpointFamily === 'direct' \? dbHostProjectRefOf\(host\) : null/,
    'the host reference follows the classified endpoint family, not whichever pattern matched',
  );
  assert.match(code, /dsnRef = userRef \?\? hostRef/, 'the username still takes precedence when only it is present');
  // ...but precedence may never RESOLVE a disagreement: a DSN naming two different projects has
  // no exact identity and must fail closed, not silently pick one half.
  assert.match(
    code,
    /if \(userRef !== null && hostRef !== null && userRef !== hostRef\) \{\s*return fail\(EXECUTOR_CODES\.MANAGED_DSN_PROJECT_MISMATCH/,
    'a DSN whose username and host name different projects is refused',
  );
  assert.match(code, /projRef = apiProjectRefOf\(proj\)/, 'the project reference comes from the gateway parser');
  assert.ok(!/apiProjectRefOf\(url\)/.test(code), 'the gateway parser must never be applied to the DSN');
  assert.ok(!/dbHostProjectRefOf\(proj/.test(code), 'the database-host parser must never be applied to the gateway url');
});

test('C1 containment: the reference grammar is single-sourced, so the two parsers cannot drift', () => {
  const code = stripComments(read(EXECUTOR));
  assert.match(code, /const PROJECT_REF = '\[a-z0-9\]\{16,\}';/, 'the canonical grammar is one literal');
  // Every reference pattern is BUILT from it — a second hand-written class would let the looser of
  // the two silently decide which references corroborate.
  for (const name of ['DB_HOST_REF', 'USER_REF', 'BARE_REF']) {
    assert.match(
      code,
      new RegExp(`const ${name} = new RegExp\\(\`[^\`]*\\$\\{PROJECT_REF\\}`),
      `${name} must be derived from PROJECT_REF`,
    );
  }
  const withoutDeclaration = code.replace("const PROJECT_REF = '[a-z0-9]{16,}';", '');
  assert.ok(!/\[a-z0-9\]\{16,\}/.test(withoutDeclaration), 'the grammar literal may appear exactly once');
});

test('C1 containment: the gateway host shape is EXACT, never a suffix test or a first label', () => {
  const code = stripComments(read(EXECUTOR));
  const fn = code.slice(code.indexOf('function apiProjectRefOf'));
  const body = fn.slice(0, fn.indexOf('\n}\n') + 1);
  assert.match(
    body,
    /labels\.length !== 3 \|\| labels\[1\] !== 'supabase' \|\| labels\[2\] !== 'co'/,
    'exactly three labels, and the last two are fixed literals',
  );
  assert.match(body, /BARE_REF\.test\(labels\[0\]\)/, 'the first label must satisfy the canonical grammar');
  // Every url component that could carry a different destination is contained.
  for (const [pattern, why] of [
    [/url\.protocol !== 'https:'/, 'a scheme downgrade is refused'],
    [/url\.username !== '' \|\| url\.password !== ''/, 'embedded credentials are refused'],
    [/url\.port !== ''/, 'an unexpected port is refused'],
    [/url\.pathname !== '' && url\.pathname !== '\/'/, 'a non-root path is refused'],
    [/url\.search !== '' \|\| url\.hash !== ''/, 'a query or fragment is refused'],
  ]) {
    assert.match(body, pattern, why);
  }
  // The rejected heuristic must not exist anywhere in the module, in either parser.
  assert.ok(!/split\('\.'\)\[0\]/.test(code), 'no first-label heuristic may be reintroduced');
  assert.ok(!/endsWith\('\.supabase\.co'\)/.test(code), 'the gateway shape is not a suffix test');
});

test('C1 containment: corroboration stays EXACT equality, and still precedes client construction', () => {
  const code = stripComments(read(EXECUTOR));
  assert.match(
    code,
    /if \(dsnRef === null \|\| projRef === null \|\| dsnRef !== projRef\)/,
    'null on either side, or any difference, refuses — never a prefix, suffix or substring match',
  );
  const validator = code.slice(
    code.indexOf('export function assertManagedDevDsn'),
    code.indexOf('export function describeManagedDsn'),
  );
  assert.ok(validator.length > 0, 'the validator body was located');
  for (const forbidden of ['postgres(', 'await import(', 'client.', 'reserve(']) {
    assert.ok(!validator.includes(forbidden), `target validation must not contain "${forbidden}" — no client may exist yet`);
  }
  // The SEALED ROUTING TARGET the executor factory needs is minted on the LAST lines of a
  // successful validation, so any refusal above leaves nothing a client could ever be built from.
  assert.match(validator, /MANAGED_TARGET\.set\(handle, Object\.freeze\(\{/);
  assert.match(validator, /\}\)\);\s*return handle;\s*\}/, 'the seal is the last act of the validator');
  assert.ok(!code.includes('MANAGED_RAW_DSN'), 'the raw DSN is no longer stored as a routing source');
});

// --- C2B-R3A-C1H1: the DIRECT database host is matched WHOLE ------------------
//
// C1's database-host parser was PREFIX-ONLY, so a hostname needed only to BEGIN like the
// documented direct endpoint to yield a project reference. These rules keep the anchor, keep the
// two endpoint families apart, and keep the pooler domain from conferring direct-host identity.

test('H1 containment: the direct-host PATTERN itself refuses every near-miss hostname', () => {
  // PROPERTY, not prose. An earlier draft of this rule grepped the declaration for the literal
  // `supabase.com` — which the source can never contain, because it writes the pattern with
  // escaped dots (`supabase\\.co`). That rule passed on every widening it was written to catch.
  // So: extract the pattern, BUILD it, and run hostnames through it. A rule that cannot fail is
  // worse than no rule, because it reads like coverage.
  const code = stripComments(read(EXECUTOR));
  const grammar = /const PROJECT_REF = '([^']+)';/.exec(code);
  const pattern = /const DB_HOST_REF = new RegExp\(`([^`]+)`\s*,\s*'i'\)/.exec(code);
  assert.ok(grammar !== null, 'the canonical grammar literal was located');
  assert.ok(pattern !== null, 'the direct-host pattern was located');
  // The source is a template literal, so its `\\.` are two source bytes meaning one regex escape.
  const re = new RegExp(pattern[1].split('${PROJECT_REF}').join(grammar[1]).replace(/\\\\/g, '\\'), 'i');

  const REF = 'abcdefghijklmnop';
  assert.ok(re.test(`db.${REF}.supabase.co`), 'the documented direct host must still match');
  assert.ok(re.test(`DB.${REF.toUpperCase()}.SUPABASE.CO`), 'DNS case-insensitivity is preserved');
  for (const host of [
    `db.${REF}.supabase.com`, // the pooler domain must not confer direct-host identity
    `db.${REF}.extra.supabase.co`, // the prefix-only defect itself
    `db.${REF}.attacker.supabase.co`,
    `db.${REF}.supabase.co.evil.example`, // a missing end anchor
    `db.${REF}.supabase.co.`, // trailing-dot FQDN
    `attacker.db.${REF}.supabase.co`, // a missing start anchor
    `db.${REF}supabase.co`, // no label boundary after the reference
    `db.abcdefghijklmno.supabase.co`, // one character short of the grammar
    'db..supabase.co',
  ]) {
    assert.ok(!re.test(host), `${host} must not match the direct-host pattern`);
  }
});

test('H1 containment: a malformed direct-host CLAIM fails closed instead of falling through', () => {
  // The anchor alone was a REGRESSION: a stricter pattern yields `hostRef === null` for more
  // hostnames, and null is the state a legitimate pooler host occupies — so the agreement check
  // stopped firing and `userRef ?? hostRef` fell through to the username. The claim guard is what
  // makes the tightening a net narrowing, so its ABSENCE must be visible here.
  const code = stripComments(read(EXECUTOR));
  assert.match(code, /const DB_HOST_CLAIM = \/\^db\\\.\/i;/, 'a `db.` first label is recognised as a direct-host claim');
  assert.match(
    code,
    /if \(DB_HOST_CLAIM\.test\(host\) && !DB_HOST_REF\.test\(host\)\) \{\s*return fail\(/,
    'a claim that does not resolve to the exact documented host is refused',
  );
  // ORDER is the whole point: the guard must precede the family classification, the agreement
  // check and the `??`. H2 moved it earlier still, so a malformed `db.` claim keeps reporting the
  // endpoint-family refusal instead of being flattened into "not a recognised endpoint".
  const classifyAt = code.indexOf('const endpointFamily = classifyManagedHost(host)');
  const claimAt = code.indexOf('DB_HOST_CLAIM.test(host)');
  assert.ok(claimAt > 0 && classifyAt > claimAt, 'the claim guard runs before classification');
  const agreeAt = code.indexOf('userRef !== null && hostRef !== null');
  const coalesceAt = code.indexOf('dsnRef = userRef ?? hostRef');
  assert.ok(claimAt > 0 && agreeAt > claimAt && coalesceAt > claimAt, 'the claim guard runs first');
  // H2 replaced the provider-SUFFIX boundary with two EXACT endpoint grammars. A suffix test must
  // not come back: it judges only a hostname's tail, which is what let a comma-bearing authority
  // through. Evaluate the pooler grammar rather than grepping it.
  assert.ok(!code.includes('MANAGED_HOST_SUFFIXES'), 'the provider-suffix allowlist must not return');
  assert.ok(!/endsWith\('\.supabase\./.test(code), 'no suffix test may classify a managed host');
  assert.match(code, /const endpointFamily = classifyManagedHost\(host\)/, 'the host is classified exactly');
  const label = /const DNS_LABEL = '([^']+)';/.exec(code);
  const pooler = /const POOLER_HOST = new RegExp\(`([^`]+)`\s*,\s*'i'\)/.exec(code);
  assert.ok(label !== null && pooler !== null, 'the pooler grammar was located');
  const re = new RegExp(pooler[1].split('${DNS_LABEL}').join(label[1]).replace(/\\\\/g, '\\'), 'i');
  assert.ok(re.test('aws-0-eu-west-1.pooler.supabase.com'), 'a documented pooler region host matches');
  assert.ok(re.test(`${'a'.repeat(63)}.pooler.supabase.com`), '63 characters is a legal DNS label');
  for (const host of [
    `${'a'.repeat(64)}.pooler.supabase.com`, // one character over the DNS maximum
    '-x.pooler.supabase.com', 'x-.pooler.supabase.com', 'x_y.pooler.supabase.com',
    'x.y.pooler.supabase.com', 'pooler.supabase.com', '.pooler.supabase.com',
    'a,b.pooler.supabase.com', 'a%2Fb.pooler.supabase.com', 'a:1.pooler.supabase.com',
    'anything.supabase.co', 'aws-0-eu-west-1.pooler.supabase.com.',
  ]) {
    assert.ok(!re.test(host), `${host} must not match the pooler grammar`);
  }
});

test('H1 containment: direct-host validation still constructs nothing', () => {
  // H1 lands inside the C1 purity boundary, so re-assert it: the tokens below all occur elsewhere
  // in this module, so the denylist genuinely discriminates rather than matching nothing.
  const code = stripComments(read(EXECUTOR));
  const validator = code.slice(
    code.indexOf('export function assertManagedDevDsn'),
    code.indexOf('export function describeManagedDsn'),
  );
  assert.ok(validator.length > 0, 'the validator body was located');
  for (const forbidden of ['postgres(', 'await import(', 'client.', 'reserve(']) {
    assert.ok(code.includes(forbidden), `"${forbidden}" must exist elsewhere, or this rule is vacuous`);
    assert.ok(!validator.includes(forbidden), `direct-host validation must not contain "${forbidden}"`);
  }
});

test('C1 containment: the executor never reaches the weaker TLS-only connection path', () => {
  // db.ts:getDb() opens the same managed database on a TLS check ALONE — no project-reference
  // corroboration, no provider-host boundary, no live fingerprint. It remains OPEN/HIGH, and the
  // trusted path must not become reachable from it or route around itself through it.
  const code = stripComments(read(EXECUTOR));
  for (const forbidden of ['getDb', 'getRuntimeDb']) {
    assert.ok(!code.includes(forbidden), `the executor must never call ${forbidden}`);
  }
});


// --- C2B-R3A-C1H2: validator-to-driver authority equality --------------------
//
// This suite is the right home for it: it sits OUTSIDE `server/`, so it can import the installed
// driver without adding a driver edge to a directory whose driver edges are inventoried by two
// separate containment rules.

test('H2 containment: client construction consumes the SEALED target, never a connection string', () => {
  const code = stripComments(read(EXECUTOR));
  const factory = code.slice(code.indexOf('export async function createManagedDevExecutor'));
  const call = factory.slice(factory.indexOf('const client = postgres('), factory.indexOf('type Reserved'));
  assert.ok(call.length > 0, 'the construction call was located');
  // Every routing field comes from the sealed target...
  for (const field of [
    'host: target.host', 'port: target.port', 'user: target.user',
    'pass: target.password', 'database: target.database',
  ]) {
    assert.ok(call.includes(field), `the driver must receive ${field}`);
  }
  // ...and NO connection string is passed, which is the only way postgres.js reaches its own
  // authority parser at all. `postgres(raw, {...})` is exactly the shape H2 removed.
  assert.match(call, /const client = postgres\(\{/, 'the driver is given an options object, not a URL');
  assert.ok(!/postgres\(\s*raw/.test(factory), 'a raw connection string must never be the first argument');
  assert.ok(!/postgres\(\s*[a-zA-Z_$][\w$]*\s*,/.test(factory), 'no string may precede the options object');
  // The TLS policy still reads the ORIGINAL operator string — policy only, never routing.
  assert.match(factory, /resolveDatabaseTls\(target\.tlsPolicySource\)/, 'TLS policy reads the original DSN');
  assert.ok(!/path\s*:/.test(call), 'no UNIX-socket path may be supplied');
});

test('H2 containment: the installed driver resolves the sealed authority and ignores a raw multihost DSN', async () => {
  // Measured against the INSTALLED postgres.js, not against a reading of its documentation.
  // Construction resolves options eagerly while leaving `socket = null` until a query runs, so
  // nothing here opens a socket, resolves a name or performs a handshake.
  const { default: postgres } = await import('postgres');
  const before = process.getActiveResourcesInfo();
  const REF = 'abcdefghijklmnop';
  const HOST = `db.${REF}.supabase.co`;

  const sealed = postgres({
    host: HOST, port: 5432, user: 'postgres', pass: 'synthetic', database: 'postgres',
    max: 1, prepare: false, idle_timeout: 0, connect_timeout: 15,
    onnotice: () => {}, ssl: { rejectUnauthorized: true },
  });
  assert.deepEqual(sealed.options.host, [HOST], 'the driver host equals the sealed host');
  assert.deepEqual(sealed.options.port, [5432], 'the driver port equals the sealed port');
  assert.equal(sealed.options.path, false, 'no UNIX-socket path is selected');
  assert.equal(sealed.options.database, 'postgres');
  assert.equal(sealed.options.user, 'postgres');

  // THE DEFECT, still reproducible when the driver is allowed to parse the string itself: the
  // validator saw one opaque host, the driver splits it and dials the attacker's first.
  const hostile = `postgres://postgres.${REF}:pw@attacker.example,${HOST}:5432/postgres`;
  assert.deepEqual(postgres(hostile, {}).options.host, ['attacker.example', HOST]);
  // Percent-escapes are decoded by the driver alone, producing a port and then a socket path.
  assert.deepEqual(postgres(`postgres://u:p@attacker.example%3A9999,x.supabase.co:5432/d`, {}).options.port[0], 9999);
  assert.equal(typeof postgres(`postgres://u:p@%2Ftmp%2Fevil,x.supabase.co:5432/d`, {}).options.path, 'string');

  // ...and the property H2 rests on: an explicit host OUTRANKS that multihost list.
  const overridden = postgres(hostile, { host: HOST, port: 5432 });
  assert.deepEqual(overridden.options.host, [HOST]);
  assert.deepEqual(overridden.options.port, [5432]);
  assert.equal(overridden.options.path, false);

  assert.deepEqual(
    process.getActiveResourcesInfo(),
    before,
    'resolving driver options must not open a socket, timer or lookup',
  );
});

test('H2 containment: the VALIDATOR output and the DRIVER options are compared in one process', () => {
  // THE CLOSING LINK, and the one this suite was missing. Every other assertion compares the
  // validator's seam against literals, or the driver against literals — never the two against each
  // other. That is precisely the shape of the defect H2 exists to fix: two components, each
  // self-consistent, disagreeing about the same value with nothing looking at both.
  //
  // The comparison has to happen in one process that holds the TypeScript validator AND the
  // driver, and it must not happen inside `server/`, where every driver import is inventoried by
  // two separate containment rules. So it runs here, in a child process, under hostile ambient
  // environment — because the ambient fallback is exactly how an empty sealed value would escape.
  const script = `
    import { assertManagedDevDsn, describeManagedDriverRouting } from './server/platform-identity/migrationExecutor.ts';
    import postgres from 'postgres';
    const REF = 'abcdefghijklmnop';
    const GW = 'https://' + REF + '.supabase.co';
    const out = [];
    for (const raw of [
      'postgres://postgres:pw@db.' + REF + '.supabase.co:5432/postgres',
      'postgres://postgres.' + REF + ':pw@aws-0-eu-west-1.pooler.supabase.com:5432/postgres',
    ]) {
      const r = describeManagedDriverRouting(assertManagedDevDsn(raw, GW, 'postgres'));
      const o = postgres({
        host: r.host, port: r.port, user: r.user, pass: 'synthetic', database: r.database,
        max: 1, prepare: false, idle_timeout: 0, connect_timeout: 15, onnotice: () => {},
        ssl: { rejectUnauthorized: true }, debug: false,
        connection: { application_name: 'tmpos-migrator' },
      }).options;
      out.push({
        validated: { host: r.host, port: r.port, user: r.user, database: r.database },
        driver: { host: o.host, port: o.port, user: o.user, database: o.database },
        path: o.path, socket: o.socket === undefined, debug: o.debug,
        appName: o.connection.application_name,
      });
    }
    console.log(JSON.stringify(out));
  `;
  const raw = execFileSync('npx', ['tsx', '--input-type=module', '-e', script], {
    cwd: REPO,
    encoding: 'utf8',
    // HOSTILE AMBIENT ENVIRONMENT. Every one of these is a fallback postgres.js consults when the
    // corresponding option is absent or falsy; none may appear in the resolved options.
    env: {
      ...process.env,
      PGHOST: 'evil.example', PGPORT: '9999', PGDATABASE: 'evildb',
      PGUSER: 'evil_user', PGUSERNAME: 'evil_user', PGPASSWORD: 'evil_pw',
      PGTARGETSESSIONATTRS: 'standby', PGAPPNAME: 'evil_app',
    },
  });
  const results = JSON.parse(raw.trim().split('\n').pop());
  assert.equal(results.length, 2, 'both endpoint families were exercised');
  for (const r of results) {
    assert.deepEqual(r.driver.host, [r.validated.host], 'driver host equals the validated host');
    assert.deepEqual(r.driver.port, [r.validated.port], 'driver port equals the validated port');
    assert.equal(r.driver.user, r.validated.user, 'driver principal equals the validated principal');
    assert.equal(r.driver.database, r.validated.database);
    assert.equal(r.path, false, 'no UNIX-socket path is selected');
    assert.equal(r.socket, true, 'no custom socket factory is supplied');
    assert.equal(r.debug, false, 'PGDEBUG cannot make SQL text and parameters enumerable');
    assert.equal(r.appName, 'tmpos-migrator', 'PGAPPNAME cannot reach the startup packet');
    assert.ok(!r.validated.host.includes('evil') && r.driver.user !== 'evil_user', 'nothing ambient leaked');
  }
});

// ---------------------------------------------------------------------------
// Phase 4.0 M3 S4.1b — C2B-M005-B0
//
// The single-purpose migration-005 launcher, and the CLI-level contracts the executor cannot
// enforce for itself: teardown reporting, the commit evidence line, and the lock-release refusal.
// ---------------------------------------------------------------------------

const M005_LAUNCHER = 'scripts/managed-m005-launcher.mjs';
const BASELINE_LAUNCHER = 'scripts/managed-baseline-launcher.mjs';

test('C2B-M005-B0: the 005 launcher is unreachable from the production import graph', () => {
  // Same rule the executor lives under: a parent that can apply a migration must not be reachable
  // from anything the application server can load.
  const reachable = reachableFrom(PRODUCTION_ENTRY);
  assert.ok(!reachable.has(M005_LAUNCHER), 'the production graph must not reach the 005 launcher');
  for (const file of localSources('server/runtime', 'src')) {
    const src = stripComments(read(file));
    assert.ok(!src.includes('managed-m005-launcher'), `${file} must not name the 005 launcher`);
  }
});

test('C2B-M005-B0: the 005 launcher spawns only the migrate CLI, through the repo-local tsx', () => {
  const src = stripComments(read(M005_LAUNCHER));
  assert.match(src, /const args = Object\.freeze\(\[TSX_CLI, MIGRATE_SCRIPT, \.\.\.M005_FLAGS\]\)/);
  // No second spawn site, and no shell.
  assert.equal((src.match(/runChild\(/g) ?? []).length, 1, 'exactly one child is ever started');
  assert.ok(!/shell:\s*true/.test(src));
  // The absolute executables come from the accepted parent's constants, not from PATH.
  assert.ok(!/node_modules\/\.bin/.test(src), 'no repository .bin shim');
  assert.ok(!/\bnpx\b|\bnpm\b|\bdlx\b/.test(src), 'no package-manager launcher');
});

test('C2B-M005-B0: the 005 launcher cannot express another version, direction or mode', () => {
  const src = stripComments(read(M005_LAUNCHER))
    .replace(/export const FORBIDDEN_CHILD_TOKENS = Object\.freeze\(\[[\s\S]*?\]\);/, '');
  // Built from fragments so this assertion cannot match its own text.
  for (const token of [
    ['--', 'baseline'].join(''),
    ['--', 'status'].join(''),
    ['--', 'migration'].join(''),
    ['--', 'direction'].join(''),
    ['--', 'down'].join(''),
    ['--', 'allow-down'].join(''),
  ]) {
    assert.ok(!src.includes(token), `the 005 launcher must not contain ${token}`);
  }
  assert.ok(!/BASELINE_FLAGS/.test(src), 'the baseline argv must be unreachable from the 005 launcher');
});

test('C2B-M005-B0: the 005 launcher preserves the accepted containment properties', () => {
  const src = stripComments(read(M005_LAUNCHER));
  // It REUSES the accepted lifecycle rather than re-deriving it, so these are import assertions:
  // a second implementation is exactly what would let the two drift apart.
  for (const symbol of ['runChild', 'normalCompletion', 'outcomeCode', 'enterContainmentHold', 'assertContainmentPreconditions']) {
    assert.match(src, new RegExp(`\\b${symbol}\\b`), `the 005 launcher must reuse ${symbol}`);
  }
  assert.ok(!/\.unref\s*\(/.test(src), 'no handle release');
  assert.ok(!/process\.exit\s*\(/.test(src), 'no process.exit');
  assert.match(src, /process\.exitCode\s*=/, 'the entry guard sets exitCode instead');
});

test('C2B-M005-B0: the baseline launcher is byte-unchanged by this stage', () => {
  // The 005 launcher imports from it; that import must not have been an excuse to edit it.
  const src = read(BASELINE_LAUNCHER);
  assert.match(src, /export const BASELINE_FLAGS = Object\.freeze\(\[/);
  assert.match(src, /'--baseline-versions=001,002,003,004'/);
  // The baseline parent still accepts only its own literal flag, and the 005 parent uses another.
  assert.match(src, /argv\[0\] !== '--execute'/);
  assert.match(stripComments(read(M005_LAUNCHER)), /PARENT_FLAG = '--execute-m005'/);
});

test('C2B-M005-B0: the managed CLI DELEGATES its verdict to the pure classifier', () => {
  const cli = stripComments(read(MIGRATE_CLI));
  // THE CHANGE THIS PINS. The refusal ladder used to be inline here, and the only thing asserting
  // it was a regex over this file's own text — which cannot see ORDERING. Four mutations that kept
  // the matched text and destroyed the behaviour all passed, including reordering the branches so
  // an UNDETERMINED commit rendered as "did not complete". The ladder is now a pure exported
  // function, table-tested behaviourally in the executor suite; what this file asserts is that the
  // CLI has no second copy of it.
  // C2B-M005-B1-R3 — the call is pinned by its ARGUMENTS, not by its formatting. The evidence must
  // be the unmodified report, the teardown must reach it, and the durable ledger marker must be
  // derived from that same report rather than passed as a caller opinion.
  assert.match(cli, /refusal = classifyManagedApplyRefusal\(op, \{[\s\S]{0,400}?\}\);/,
    'the verdict is delegated to the pure classifier');
  const call = cli.slice(cli.indexOf('refusal = classifyManagedApplyRefusal(op, {'));
  assert.ok(call.length > 60, 'the delegation call must be found, not collapsed');
  const args = call.slice(0, call.indexOf('});') + 3);
  assert.match(args, /\.\.\.applyEvidence/, 'the report is spread in unmodified');
  assert.match(args, /ledgerMarker: classifyLedgerMarker\(applyEvidence\)/,
    'the durable ledger marker is derived from the same evidence the ledger line printed');
  assert.match(args, /\bteardown\b/, 'the teardown result reaches the verdict');
  assert.match(cli, /applyEvidence = report;/, 'the apply report is the evidence, unmodified');
  // Scoped to the APPLY branch: the historical-baseline branch keeps its own wording, is a
  // different runner with a different report type, and is out of this stage's scope.
  assert.ok(cli.includes('const fsPort = createNodeFsPort'), 'the apply-branch start marker must match');
  const applyBranch = cli.slice(cli.indexOf('const fsPort = createNodeFsPort'), cli.indexOf('} catch (err) {', cli.indexOf('applyEvidence = report;')));
  assert.ok(!/COMMIT OUTCOME IS UNKNOWN/.test(applyBranch), 'no second copy of the verdict text');
  assert.ok(!/advisory-lock release is UNVERIFIED/.test(applyBranch), 'no second copy of the lock residual');
  assert.ok(!/did not complete/.test(applyBranch), 'no second copy of the incomplete-run wording');
  // The verdict must be computed ONCE, after the teardown — the last evidence available.
  assert.equal((cli.match(/classifyManagedApplyRefusal\(/g) ?? []).length, 1);
});

test('C2B-M005-B0: the managed CLI never discards the client teardown result', () => {
  const cli = stripComments(read(MIGRATE_CLI));
  assert.match(cli, /const teardown = await handle\.dispose\(\)/, 'the teardown result is captured');
  assert.match(cli, /if \(!teardown\.completed\)/, 'an incomplete teardown is a refusal');
  assert.match(cli, /gracefulSocketClose=\$\{teardown\.gracefulSocketClose\}/, 'the record distinguishes request from socket');
  // Exactly one request per run: postgres.js caches its shutdown promise, so a retry would only
  // re-await a settled rejection.
  assert.equal((cli.match(/await handle\.dispose\(\)/g) ?? []).length, 2, 'one disposal site per executor path');
});

test('C2B-M005-B0: the executor fails closed on a ledger dirty value it cannot represent', () => {
  const exec = stripComments(read(EXECUTOR));
  // The coercion this replaces mapped NULL, 't'/'f' and 0/1 to `false` — the word this system uses
  // for "completed cleanly". Both adapters are covered so neither can regress alone.
  assert.ok(
    !/dirty: r\.dirty === true/.test(exec),
    'no ledger read may coerce an unrepresentable dirty value to clean',
  );
  assert.equal(
    (exec.match(/toLedgerRowStrict\(r as Record<string, unknown>\)/g) ?? []).length,
    2,
    'both the managed and disposable ledger reads use the strict mapper',
  );
});

test('C2B-M005-B0: the executor re-derives artifact identity under the lock, against a frozen hash', () => {
  const exec = stripComments(read(EXECUTOR));
  assert.match(exec, /export const M005_UP_SHA256 = '[0-9a-f]{64}'/, 'the governed hash is a source constant');
  // A self-consistency check would pass an edited artifact: discovery would hash the new bytes and
  // the plan would agree with itself perfectly. The comparison must be against the constant.
  assert.match(
    exec,
    /authoritative\[0\]\.checksum !== M005_UP_SHA256/,
    'the re-derived checksum is compared to the GOVERNED hash, not only to itself',
  );
  assert.match(exec, /opts\.fsPort\.entryType\(basename\) !== 'file'/, 'a non-regular entry is refused, not read');
});

test('C2B-M005-B1-R2: no operator-visible record uses rollback wording, because no rollback happens', () => {
  // THE CORRECTION THIS STAGE EXISTS FOR. The apply path has no rollback port: `ExecutorSession`
  // declares no rollback operation and the kernel emits no rollback effect. An open bracket is
  // abandoned by destroying the connection, and what PostgreSQL then does is never observed here.
  const exec = read(EXECUTOR);
  const iface = exec.slice(exec.indexOf('export interface ExecutorSession'), exec.indexOf('export interface ExecutorAdapter'));
  // GUARD FIRST: this is a negative-only assertion, so an empty slice would make it unfalsifiable.
  assert.ok(iface.includes('commitTx()') && iface.includes('terminate()'),
    'the session interface must actually be sliced, not collapsed');
  assert.ok(!/rollback/i.test(iface), 'the session port must expose no rollback operation');

  // AND THE APPLY DEPENDENCY SURFACE, which is what makes `rollback_observed=false` a fact rather
  // than a hopeful constant: the two real rollback submissions live on `BaselineWritePort` and
  // `ReadOnlyTxPort`, and `TrustedApplyDeps` declares neither.
  const deps = exec.slice(exec.indexOf('export interface TrustedApplyDeps'), exec.indexOf('export interface ExecutionUnit'));
  assert.ok(deps.includes('adapter') && deps.includes('ledger'), 'the apply deps must actually be sliced');
  assert.ok(!/\bwrite\s*[:?]|\breadOnlyTx\s*[:?]|\bsnapshotTx\s*[:?]/.test(deps),
    'runTrustedApply must not gain a port that can submit a ROLLBACK without the CLI line changing');

  // The mutation-state vocabulary the operator actually reads.
  const union = exec.slice(exec.indexOf('export type ApplyMutationState'), exec.indexOf('export const PRE_COMMIT_GATE_CODES'));
  const labels = [...union.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
  // EXACTLY six, matching the set the runtime sweep in migrationExecutor.test.ts reaches. A lower
  // bound let a seventh label be declared here without ever being produced or classified.
  assert.equal(labels.length, 6, `the union must be read exactly, not missed: ${labels.join(',')}`);
  for (const l of labels) assert.ok(!/rollback/i.test(l), `no mutation-state label may claim a rollback: ${l}`);
  assert.ok(labels.includes('pre_commit_refusal_connection_disposal_resolved'), 'the resolved disposal label');
  assert.ok(labels.includes('pre_commit_refusal_connection_disposal_unverified'), 'the unverified disposal label');

  // And the CLI, which is the record an operator sees. Comments are stripped first: the point is
  // that no printed line names a rollback, not that the file never explains why.
  // The ONE permitted occurrence is the explicit negative: stating `rollback_observed=false` is
  // how the record refuses to leave the question open. Everything else is forbidden, so it is
  // removed before the check rather than excused by a looser pattern.
  const cli = stripComments(read(MIGRATE_CLI));
  assert.equal((cli.match(/rollback_observed=false/g) ?? []).length, 1, 'exactly one negative statement');
  assert.ok(!/rollback/i.test(cli.replaceAll('rollback_observed=false', '')),
    'no other CLI output may name a rollback on a path that submits none');
});

test('C2B-M005-B1-R2: the managed mutation line states the commit attempt and rollback observability', () => {
  const cli = stripComments(read(MIGRATE_CLI));
  // A pre-commit refusal must say plainly that COMMIT was never submitted — inferring it from a
  // label is what let "applied=1" stand next to an abandoned transaction in the first place.
  assert.match(cli, /commit_attempted=\$\{report\.commit\.submitted\}/,
    'the mutation line must state the commit attempt from the evidence, not from a constant');
  assert.match(cli, /rollback_observed=false/,
    'and must state that no rollback was observed rather than leave it to be inferred');
  // Same line as the mutation state, so neither can be read without the other.
  assert.match(cli, /mutation: \$\{classifyApplyMutationState\(report\)\}[\s\S]{0,200}?commit_attempted=/,
    'the commit attempt travels with the mutation state');
});

test('C2B-M005-B1-R2: the gated mutation classifier has exactly one production call site', () => {
  // THE STRUCTURAL BOUND ON THE UNGATED-APPLY RESIDUAL. `classifyApplyMutationState` withholds the
  // success label unless a pre-commit gate approved, which is correct for the managed exact-[005]
  // apply and would be a wrong word for an ordinary apply that owes no gate. That downgrade is
  // unreachable only while this is the sole non-test caller AND it sits on the managed path, where
  // the executor refuses the program outright when the gate is absent.
  const cli = stripComments(read(MIGRATE_CLI));
  const calls = (cli.match(/classifyApplyMutationState\(/g) ?? []).length;
  assert.equal(calls, 1, 'a second caller would make the ungated downgrade reachable');
  const managed = cli.indexOf('async function runThroughManagedExecutor');
  assert.ok(managed > 0, 'the managed entry point must be found');
  assert.ok(cli.indexOf('classifyApplyMutationState(') > managed,
    'the only call site must be inside the managed executor path');
  // And the disposable branch must NOT adopt it: there the flag is legitimately false.
  assert.ok(cli.includes('async function runThroughExecutor'), 'the disposable entry point must be found');
  const disposable = cli.slice(cli.indexOf('async function runThroughExecutor'), managed);
  assert.ok(disposable.includes('runTrustedApply'), 'and the disposable slice must be non-empty');
  assert.ok(!disposable.includes('classifyApplyMutationState'),
    'the disposable path owes no gate and must not be classified by a gated verdict');
});

test('C2B-M005-B1-R3: the managed record discloses the durable ledger consequence', () => {
  const cli = stripComments(read(MIGRATE_CLI));
  // A SEPARATE LINE from the mutation line, because they answer different questions.
  // `commit_attempted=false` speaks for the migration transaction; the marker is a ledger
  // mutation that committed before that transaction opened.
  assert.match(cli, /\[migrate\] \$\{op\} ledger: version=\$\{AUTHORIZED_APPLY_VERSION\}/,
    'the managed record must carry a ledger line naming the version it is about');
  for (const field of [
    /marker=\$\{marker\}/,
    /markerWrite=\$\{report\.dirtyMarkerWrite\}/,
    /cleanVerified=\$\{marker === 'clean_verified'\}/,
    /ddlMayHaveCommitted=\$\{report\.commit\.submitted\}/,
  ]) {
    assert.match(cli, field, `the ledger line must carry ${field}`);
  }
  // Derived from the report, never asserted as a caller opinion.
  assert.match(cli, /const marker = classifyLedgerMarker\(report\);/,
    'the marker must be derived from the run evidence');
  // The disposable branch owes no ledger line: it prints commit and read-back evidence instead,
  // and has no managed version to name.
  assert.equal((cli.match(/ ledger: version=/g) ?? []).length, 1, 'exactly the managed record');
});

test('C2B-M005-B1-R3: a known bounded ledger failure is converted AT THE THROW, not lost', () => {
  const cli = stripComments(read(MIGRATE_CLI));
  // THE DEFECT. Both ledger-read boundaries threw a bare `Error`, and `planApply` throws a
  // MigrationEngineError — neither of which the catches can tell from an arbitrary throw. So a
  // real `unresolved_dirty_attempt`, the follow-on state of the durable marker this stage
  // discloses, surfaced as the operator-GATE code: "you did not satisfy the gates", for a run
  // that satisfied every gate.
  //
  // THE CORRECTION IS AT THE THROW, deliberately. The catches' exact shape is pinned by an
  // existing source-integrity contract outside this stage's authorized paths, so converting there
  // would have required editing a file this stage may not touch. Converting here needs neither.
  assert.equal((cli.match(/throw new Error\('ledger unreadable'\)/g) ?? []).length, 0,
    'a bare Error discards the code the read already produced');
  assert.equal((cli.match(/throw boundedExecutorError\(read\.code, 'ledger unreadable'\)/g) ?? []).length, 2,
    'both ledger-read boundaries must carry their bounded code');
  assert.match(cli, /planned = planApply\(pairs, read\.rows\)[\s\S]{0,320}?throw boundedExecutorError\(/,
    'the apply planner refusal must be converted rather than collapsed');
  // The catches are UNCHANGED — that is the point, and it is asserted rather than assumed.
  assert.equal((cli.match(/const code = err instanceof MigrationExecutorError \? err\.code : PG_VALIDATION_REQUIRED;/g) ?? []).length, 3,
    'every catch keeps the shape its existing contract pins');

  // And the conversion is an ALLOWLIST, so nothing caller-controlled is echoed.
  const exec = stripComments(read(EXECUTOR));
  const fnStart = exec.indexOf('export function boundedExecutorError');
  assert.ok(fnStart > 0, 'the converter must exist');
  const body = exec.slice(fnStart, exec.indexOf('\nexport function', fnStart + 10));
  assert.match(body, /isKnownBoundedCode\(code\) \? code : EXECUTOR_CODES\.PORT_FAILED/,
    'an unrecognized code must collapse to a safe generic one');
  assert.ok(!/message|stack|JSON\.stringify|String\(/.test(body),
    'the converter must read only a code, never a message, stack or serialization');
});

test('C2B-M005-B1-R3: the executor exposes no automatic dirty-marker cleanup', () => {
  const exec = stripComments(read(EXECUTOR));
  // NO RECOVERY WAS INTRODUCED. The marker is observed and reported; nothing clears, resolves or
  // rewrites it, and no second connection is opened to try.
  const marker = exec.slice(exec.indexOf('export type DirtyMarkerWrite'), exec.indexOf('export function classifyManagedApplyRefusal'));
  assert.ok(marker.includes('classifyLedgerMarker'), 'the marker section must actually be sliced');
  assert.ok(!/delete\s+from|update .*dirty\s*=\s*false|resolveDirty|clearMarker/i.test(marker),
    'the marker evidence path must contain no write, resolve or cleanup operation');
  // `classifyLedgerMarker` takes ONLY the two evidence inputs — disposal is deliberately not one,
  // so a disposal outcome cannot clear or downgrade the marker through the signature.
  const sig = exec.slice(exec.indexOf('export function classifyLedgerMarker'), exec.indexOf('): LedgerMarkerState {'));
  assert.ok(sig.length > 40, 'the signature must be found');
  assert.ok(!/disposal/.test(sig), 'connection disposal must not be an input to the ledger verdict');

  // NO CATCH-ALL CERTAINTY. `durable_dirty` is the strongest negative claim in the vocabulary, so
  // the branch that speaks it must NAME the commit outcome that entails it. A bare
  // `return 'durable_dirty'` is behaviourally identical today and would keep asserting the
  // certainty if `applyCommitOutcome` ever gained a fourth value — a structural property, which
  // is why it is asserted structurally rather than through a behavioural case that cannot exist.
  const fnStart = exec.indexOf('): LedgerMarkerState {');
  const body = exec.slice(fnStart, exec.indexOf('export function classifyManagedApplyRefusal', fnStart));
  assert.ok(body.includes("outcome === 'resolved'"), 'the classifier body must be found');
  assert.match(body, /return outcome === 'not_submitted' \? 'durable_dirty' : 'unknown';/,
    'the durable claim must name the outcome that earns it');
  assert.ok(!/^\s*return 'durable_dirty';\s*$/m.test(body), 'and must not be reached by fall-through');
});

test('C2B-M005-P2-B0: the snapshot bracket is consumed ONLY by the comprehensive preflight', () => {
  // A read-only snapshot port is harmless while nothing on a WRITE path holds it. The failure this
  // guards against is a later edit that reaches for `snapshotTx` from the apply CLI or an apply
  // launcher because it happens to be on the same handle — at which point a bracket with no commit
  // entry point would be opened around work that must commit.
  const consumers = [
    ['scripts/supabase-migrate.ts', false],
    ['scripts/managed-m005-launcher.mjs', false],
    ['scripts/managed-baseline-launcher.mjs', false],
    ['scripts/managed-default-acl-preflight.ts', false],
    ['scripts/managed-m005-comprehensive-preflight.ts', true],
  ];
  for (const [rel, expected] of consumers) {
    const src = read(rel);
    assert.equal(/\bsnapshotTx\b/.test(src), expected, rel);
  }
});

test('C2B-M005-P2-B0: the comprehensive preflight reaches no write, apply or dirty-resolution surface', () => {
  const child = read('scripts/managed-m005-comprehensive-preflight.ts');
  const executable = child
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n').filter((l) => !l.trimStart().startsWith('//') && !l.trimStart().startsWith('*')).join('\n');

  // The imported surface is the containment: everything this child can call from the executor is
  // named here, and every name is a pure classifier or a bounded read.
  const imported = executable.slice(
    executable.indexOf("import {"), executable.indexOf("} from '../server/platform-identity/migrationExecutor'"),
  );
  const names = [...imported.matchAll(/^\s{2}([A-Za-z][A-Za-z0-9]*),$/gm)].map((m) => m[1]);
  assert.ok(names.length >= 8, 'the executor import list must actually be sliced');
  for (const forbidden of ['runTrustedApply', 'runTrustedHistoricalBaseline', 'runTrustedLedgerRead',
    'createPostgresExecutor', 'planApply', 'createManagedM005Policy', 'createM005PreCommitPolicy']) {
    assert.ok(!names.includes(forbidden), forbidden);
  }
  // And no write-capable member of the handle is touched, however it was obtained.
  for (const member of ['.write', '.ownerAcl', 'beginTx', 'commitTx', 'executeSql',
    'insertDirtyAttempt', 'finalizeApplied', 'acquireLock', 'releaseLock']) {
    assert.ok(!executable.includes(member), member);
  }
  // `reserve` IS called — the continuity token needs the session object — and the session's
  // write-capable members must stay untouched, which the loop above already establishes.
  assert.ok(executable.includes("adapter.reserve('session')"));
});

test('C2B-M005-P2-B0: the comprehensive preflight launcher can spawn nothing but its own child', () => {
  const src = read('scripts/managed-m005-comprehensive-preflight-launcher.mjs');
  // Exactly one frozen argv, and the command is the first element of it rather than a separate
  // value the contract never sees.
  assert.ok(src.includes('const fullArgv = Object.freeze([NODE_BIN, TSX_CLI, PREFLIGHT_SCRIPT, ...PREFLIGHT_FLAGS]);'));
  assert.ok(src.includes('assertChildArgvContract(fullArgv)'));
  assert.ok(src.includes('command: fullArgv[0]') && src.includes('args: fullArgv.slice(1)'));
  assert.equal((src.match(/runChild\(/g) ?? []).length, 1, 'exactly one spawn site');
  // The sealed environment is FIVE keys and the apply gate is refused by name, not merely omitted.
  assert.ok(src.includes("if (k === 'ALLOW_SUPABASE_MIGRATION_APPLY') problems.push(k);"));
  assert.ok(!/GATE_VALUES\s*=\s*Object\.freeze\(\{[^}]*ALLOW_SUPABASE_MIGRATION_APPLY/.test(src));
});
