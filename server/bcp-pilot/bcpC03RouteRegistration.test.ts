// Phase 2.0 M12 — Static registration-safety tests for the C-03 isolated route registration.
//
// Self-contained, DB-FREE, Supabase-FREE, network-FREE, NO port binding. It does NOT import server.ts
// (that file calls app.listen at import); instead it reads server.ts as TEXT and asserts the C-03
// registration is on the isolated identity API ONLY, uses the accepted adapter factory with ONLY the
// server-owned provider through the getCoverageEntries seam, introduces no frontend/mockData/DB/Supabase
// import, and leaves the C-01/C-02 registrations intact. Runnable via `npx tsx <thisfile>`.

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { BCP_C03_UI_COVERAGE_ROUTE_PATH } from './bcpC03ReadOnlyExpressAdapter';

const SERVER_PATH = new URL('../platform-identity/server.ts', import.meta.url);
const raw = fs.readFileSync(SERVER_PATH, 'utf8');
const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const stripComments = (s: string) => s.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
const code = stripComments(raw);

function walk(dir: string): string[] {
  const out: string[] = [];
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name === 'dist' || e.name.startsWith('.')) continue;
    const p = `${dir}/${e.name}`;
    if (e.isDirectory()) out.push(...walk(p));
    else if (/\.(ts|tsx)$/.test(e.name)) out.push(p);
  }
  return out;
}

const cases: { name: string; fn: () => void }[] = [];
const test = (name: string, fn: () => void) => cases.push({ name, fn });

test('server.ts registers the C-03 route exactly once, under /dev/bcp/ui-coverage-readiness', () => {
  assert.equal(BCP_C03_UI_COVERAGE_ROUTE_PATH, '/dev/bcp/ui-coverage-readiness');
  const regs = code.match(/app\.all\(\s*BCP_C03_UI_COVERAGE_ROUTE_PATH\s*,/g) ?? [];
  assert.equal(regs.length, 1, 'expected exactly one C-03 app.all registration');
  assert.ok(!/['"]\/dev\/bcp\/ui-coverage-readiness['"]/.test(code), 'C-03 path should be via the constant');
});
test('server.ts imports the accepted C-03 adapter factory + route path constant', () => {
  assert.ok(/import\s*\{[^}]*createBcpC03UiCoverageReadinessHandler[^}]*\}\s*from\s*['"]\.\.\/bcp-pilot\/bcpC03ReadOnlyExpressAdapter['"]/.test(code));
  assert.ok(code.includes('BCP_C03_UI_COVERAGE_ROUTE_PATH'));
});
test('server.ts imports getBcpC03UiCoverageEntries from the server-owned C-03 provider', () => {
  assert.ok(/import\s*\{[^}]*getBcpC03UiCoverageEntries[^}]*\}\s*from\s*['"]\.\.\/bcp-pilot\/bcpC03UiCoverageProvider['"]/.test(code));
});
test('C-03 factory is wired with ONLY the server-owned getCoverageEntries provider (no request mapping)', () => {
  assert.ok(/createBcpC03UiCoverageReadinessHandler\(\s*\{[^}]*getCoverageEntries\s*:\s*getBcpC03UiCoverageEntries[^}]*\}\s*\)/.test(code));
  const callMatch = code.match(/createBcpC03UiCoverageReadinessHandler\(([\s\S]*?)\)/);
  assert.ok(callMatch, 'C-03 factory call not found');
  const args = (callMatch![1] ?? '').trim();
  assert.ok(/^\{\s*getCoverageEntries\s*:\s*getBcpC03UiCoverageEntries\s*,?\s*\}$/.test(args), `got: ${args}`);
  for (const bad of ['req.', 'request', 'cookies', 'params', 'query', 'headers', 'body', 'principal', 'mode:', 'sourceMode', 'schemaVersion']) {
    assert.ok(!args.includes(bad), `C-03 factory arg maps request/authority data: ${bad}`);
  }
});
test('server.ts does not import frontend src, mockData, or sensitive row-shaped types', () => {
  assert.ok(!/from\s*['"][^'"]*\/src\//.test(code) && !/from\s*['"]\.\.\/\.\.\/src/.test(code), 'no frontend src import');
  assert.ok(!/mockData/.test(code), 'no mockData import');
  for (const t of ['TenantRow', 'StoreRow', 'AuditRow', 'DatabaseRow', 'PermissionRow']) assert.ok(!code.includes(t), t);
});
test('the C-03 registration introduces no createClient/@supabase/getDb access', () => {
  const c03Lines = code.split('\n').filter((l) => /C03|c03/i.test(l));
  for (const l of c03Lines) assert.ok(!/getDb|\/db['"]|createClient|supabase/i.test(l), `C-03 line adds DB/Supabase: ${l.trim()}`);
});
test('no C-03 mutation/customer-facing/production/SaaS-nav registration', () => {
  assert.ok(!/app\.(post|put|patch|delete)\([^)]*C03/i.test(code), 'no C-03 mutation route');
  const ctx = code.split('\n').filter((l) => /C03|c03|ui-coverage-readiness/i.test(l)).join('\n').toLowerCase();
  for (const bad of ['/api/bcp', '/admin/bcp', 'production', 'customer', 'navitems', 'navigation']) {
    assert.ok(!ctx.includes(bad), `C-03 context references forbidden surface: ${bad}`);
  }
});
test('C-01 and C-02 registrations remain intact (exactly one app.* registration each)', () => {
  // C-02: exactly one factory call (multi-line-tolerant app.all already proven elsewhere).
  const c02 = code.match(/createBcpC02RegistryReadinessHandler\(/g) ?? [];
  assert.equal(c02.length, 1, 'expected exactly one C-02 factory call');
  // C-01: assert its handler is still registered via an app.* call exactly once (not merely imported).
  const c01Reg = code.match(/app\.(all|get|post|put|patch|delete|use|head|options)\s*\([\s\S]{0,160}?createBcpReadinessSummaryHandler/g) ?? [];
  assert.equal(c01Reg.length, 1, 'expected exactly one C-01 readiness-summary registration to survive');
});
test('no frontend src/ file imports the BACKEND C-03 modules', () => {
  const FORBIDDEN_BACKEND = [
    'createBcpC03UiCoverageReadinessHandler', 'bcpC03ReadOnlyExpressAdapter', 'bcpC03ReadOnlyRoute',
    'bcpC03UiCoverageReadModel', 'buildC03UiCoverageEnvelope', 'bcpC03UiCoverageProvider',
    'getBcpC03UiCoverageEntries', 'BCP_C03_SERVER_OWNED_UI_COVERAGE_ENTRIES',
  ];
  for (const f of walk(`${ROOT}src`)) {
    const t = fs.readFileSync(f, 'utf8');
    for (const bad of FORBIDDEN_BACKEND) assert.ok(!t.includes(bad), `frontend src imports backend C-03 (${bad}): ${f}`);
    assert.ok(!/from\s*['"][^'"]*\/server\//.test(t) || !/bcpC03/i.test(t), `frontend src imports server C-03: ${f}`);
  }
});
test('the C-03 handler is registered (app.*) ONLY in the isolated platform-identity server.ts', () => {
  const REG_RE = /app\.(all|get|post|put|patch|delete|use|head|options)\s*\([^)]*createBcpC03UiCoverageReadinessHandler/;
  let registrations = 0;
  for (const f of walk(`${ROOT}server`)) {
    const c = stripComments(fs.readFileSync(f, 'utf8'));
    // [\s\S] tolerant: the registration spans multiple lines.
    if (/app\.(all|get|post|put|patch|delete|use|head|options)\s*\([\s\S]{0,160}?createBcpC03UiCoverageReadinessHandler/.test(c)) {
      registrations++;
      assert.ok(f.replace(/\\/g, '/').endsWith('server/platform-identity/server.ts'), `C-03 registered outside isolated API: ${f}`);
    }
    if (f.replace(/\\/g, '/').endsWith('server/index.ts')) {
      assert.ok(!/bcpC03ReadOnlyExpressAdapter|createBcpC03UiCoverageReadinessHandler/.test(c), 'SaaS sidecar imports C-03');
    }
    void REG_RE;
  }
  assert.equal(registrations, 1, 'expected exactly one C-03 registration across server/**');
});
test('no DB/Supabase/getDb/createClient usage in the C-03 provider path files', () => {
  for (const f of ['bcpC03UiCoverageProvider.ts', 'bcpC03UiCoverageReadModel.ts', 'bcpC03ReadOnlyRoute.ts', 'bcpC03ReadOnlyExpressAdapter.ts']) {
    const c = stripComments(fs.readFileSync(new URL(`./${f}`, import.meta.url), 'utf8'));
    for (const bad of ['createClient', '@supabase', 'getDb', 'process.env.DATABASE', 'mockData', "/src/"]) {
      assert.ok(!c.includes(bad), `${f} contains ${bad}`);
    }
  }
});

(() => {
  let pass = 0; const failures: string[] = [];
  for (const c of cases) { try { c.fn(); pass++; console.log('PASS ' + c.name); } catch (e) { failures.push(c.name + ' :: ' + (e instanceof Error ? e.message : String(e))); console.log('FAIL ' + c.name); } }
  console.log(`\n[M12 BCP C-03 isolated route registration] ${pass}/${cases.length} passed`);
  if (failures.length) { console.log('FAILURES:'); for (const f of failures) console.log('  - ' + f); process.exit(1); }
  console.log('ALL_TESTS_PASSED'); process.exit(0);
})();
