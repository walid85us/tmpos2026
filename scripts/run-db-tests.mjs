// M7A-DBTEST-ISOLATION-P0 — the launcher for database suites (`npm run test:db`, and each CI step).
// Run with tsx: `tsx scripts/run-db-tests.mjs tests/db/<suite>.integration.test.mjs [...]`.
//
// Each named suite runs in its own `tsx --test` child with a minimal, explicit environment: no PG*
// setting and no project database URL, only the target this launcher validated. A supplied
// TM_POS_TEST_DATABASE_URL that is missing a field, altered or not disposable is refused here,
// before any suite starts; each suite resolves it again, and every client checks it once more.
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { childEnv, suppliedTarget, describeTarget, DisposableTargetRefused } from '../tests/db/localPostgres.harness.mjs';

const suites = process.argv.slice(2);
if (suites.length === 0 || suites.some((s) => !/^tests\/db\/[A-Za-z]+\.integration\.test\.mjs$/.test(s))) {
  console.error('run-db-tests: name one or more tests/db/<suite>.integration.test.mjs files');
  process.exit(2);
}

let target;
try {
  target = suppliedTarget(); // undefined: each suite starts its own socket-only cluster
} catch (e) {
  // A bounded reason only; the DSN never reaches the output.
  console.error(e instanceof DisposableTargetRefused ? e.message : `disposable test target refused: ${typeof e?.code === 'string' ? e.code : 'invalid DSN'}`);
  process.exit(2);
}
console.log(`run-db-tests: target ${target === undefined ? '{"source":"harness","hostKind":"unix_socket"}' : JSON.stringify(describeTarget(target))}`);

const tsx = join(process.cwd(), 'node_modules', '.bin', 'tsx');
for (const suite of suites) {
  const r = spawnSync(tsx, ['--test', suite], { env: childEnv(target), stdio: 'inherit' });
  if (r.status !== 0) process.exit(r.status ?? 1);
}
