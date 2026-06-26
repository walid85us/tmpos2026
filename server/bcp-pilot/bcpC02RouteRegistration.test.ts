// Phase 2.0 M8E — Static registration-safety tests for the C-02 isolated route registration.
//
// Self-contained, DB-FREE, Supabase-FREE, network-FREE, NO port binding. It does NOT import
// server.ts (that file calls app.listen at import); instead it reads server.ts as TEXT and asserts the
// C-02 registration is on the isolated identity API ONLY, uses the accepted adapter factory with NO
// request-derived arguments, and introduces no frontend/mockData/DB/Supabase import. Runnable via
// `npx tsx <thisfile>`. No real ids/secrets.

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { BCP_C02_REGISTRY_READINESS_ROUTE_PATH } from './bcpC02ReadOnlyExpressAdapter';

const SERVER_PATH = new URL('../platform-identity/server.ts', import.meta.url);
const raw = fs.readFileSync(SERVER_PATH, 'utf8');
const ROOT = fileURLToPath(new URL('../../', import.meta.url)); // workspace root

/** Recursively collect .ts/.tsx files under a dir (skipping node_modules/dist/dot-dirs). */
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
const stripComments = (s: string) => s.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
// Strip comments so documentation prose (which mentions tokens to negate them) is ignored.
const code = raw.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');

const cases: { name: string; fn: () => void }[] = [];
const test = (name: string, fn: () => void) => cases.push({ name, fn });

// 1 + 11.
test('server.ts registers the C-02 route exactly once, under /dev/bcp/registry-readiness', () => {
  assert.equal(BCP_C02_REGISTRY_READINESS_ROUTE_PATH, '/dev/bcp/registry-readiness');
  const regs = code.match(/app\.all\(\s*BCP_C02_REGISTRY_READINESS_ROUTE_PATH\s*,/g) ?? [];
  assert.equal(regs.length, 1, 'expected exactly one C-02 app.all registration');
  // The path constant is the only C-02 path reference; no hardcoded alternate path.
  assert.ok(!/['"]\/dev\/bcp\/registry-readiness['"]/.test(code), 'C-02 path should be referenced via the constant, not hardcoded');
});

// 2.
test('server.ts imports the accepted C-02 adapter factory + route path constant', () => {
  assert.ok(/import\s*\{[^}]*createBcpC02RegistryReadinessHandler[^}]*\}\s*from\s*['"]\.\.\/bcp-pilot\/bcpC02ReadOnlyExpressAdapter['"]/.test(code),
    'expected import of createBcpC02RegistryReadinessHandler from the C-02 adapter');
  assert.ok(code.includes('BCP_C02_REGISTRY_READINESS_ROUTE_PATH'));
});

// 6-10 + 20-21 (server-sourced authority): factory called with NO request-derived args.
test('C-02 handler factory is called with NO arguments (no request mapping into principal/modules/mode)', () => {
  // The registration must be `createBcpC02RegistryReadinessHandler()` — empty parens.
  assert.ok(/createBcpC02RegistryReadinessHandler\(\s*\)/.test(code), 'factory must be called with empty args');
  // It must NOT be called with anything referencing the request.
  const callMatch = code.match(/createBcpC02RegistryReadinessHandler\(([^)]*)\)/);
  assert.ok(callMatch, 'C-02 factory call not found');
  const args = (callMatch![1] ?? '').trim();
  assert.equal(args, '', `C-02 factory must take no args; got: ${args}`);
  // Defense-in-depth: no req.* / cookies / params mapped into the C-02 registration line region.
  const c02Line = (code.split('\n').find((l) => l.includes('createBcpC02RegistryReadinessHandler(')) ?? '');
  for (const bad of ['req.query', 'req.body', 'req.headers', 'req.cookies', 'req.params', 'req.principal', 'principal:', 'modules:', 'mode:', 'sourceMode', 'schemaVersion']) {
    assert.ok(!c02Line.includes(bad), `C-02 registration maps request data: ${bad}`);
  }
});

// 3 + 4 + 5.
test('server.ts does not import frontend src, mockData, or sensitive row-shaped types', () => {
  assert.ok(!/from\s*['"][^'"]*\/src\//.test(code) && !/from\s*['"]\.\.\/\.\.\/src/.test(code), 'no frontend src import');
  assert.ok(!/mockData/.test(code), 'no mockData import');
  for (const t of ['TenantRow', 'StoreRow', 'AuditRow', 'DatabaseRow', 'PermissionRow']) {
    assert.ok(!code.includes(t), `sensitive row type imported/referenced: ${t}`);
  }
});

// 14.
test('the C-02 registration introduces no createClient/@supabase access', () => {
  assert.ok(!/createClient/.test(code), 'no createClient');
  assert.ok(!/@supabase/.test(code), 'no @supabase import');
  // server.ts pre-existing identity routes use getDb from ./db; the C-02 route must not add DB access.
  // Assert the C-02 registration line and import carry no getDb/db reference.
  const c02Lines = code.split('\n').filter((l) => /C02|c02/i.test(l));
  for (const l of c02Lines) {
    assert.ok(!/getDb|\/db['"]|createClient|supabase/i.test(l), `C-02 line introduces DB/Supabase access: ${l.trim()}`);
  }
});

// 12 + 13 + 15.
test('no customer-facing / SaaS-nav / production / mutation registration is introduced for C-02', () => {
  // No C-02 mutation registration (app.post/put/patch/delete with the C-02 handler/path).
  assert.ok(!/app\.(post|put|patch|delete)\([^)]*C02/i.test(code), 'no C-02 mutation route registered');
  // C-02 appears only via the isolated app.all on the identity API (this file is the isolated API).
  // No production/customer/nav label tied to C-02.
  for (const bad of ['/api/bcp', '/admin/bcp', 'production', 'customer', 'navItems', 'navigation']) {
    const c02Context = code.split('\n').filter((l) => /C02|c02|registry-readiness/i.test(l)).join('\n');
    assert.ok(!c02Context.toLowerCase().includes(bad.toLowerCase()), `C-02 context references forbidden surface: ${bad}`);
  }
});

// Repo-wide uniqueness: C-02 must be registered ONLY in the isolated server.ts, and the BACKEND C-02
// modules must never be pulled into the client bundle. (M8F adds a DEV-only frontend CLIENT that talks
// to the proxy path — that consumer is allowed; importing the server-side adapter/route/read-model is not.)
test('no frontend src/ file imports the BACKEND C-02 modules (no server code in the client bundle)', () => {
  const FORBIDDEN_BACKEND = [
    'createBcpC02RegistryReadinessHandler', 'bcpC02ReadOnlyExpressAdapter', 'bcpC02ReadOnlyRoute',
    'bcpC02RegistryReadModel', 'buildC02RegistryReadinessEnvelope',
  ];
  for (const f of walk(`${ROOT}src`)) {
    const t = fs.readFileSync(f, 'utf8');
    for (const bad of FORBIDDEN_BACKEND) {
      assert.ok(!t.includes(bad), `frontend src imports backend C-02 module (${bad}): ${f}`);
    }
    // The client bundle must never import from the server tree.
    assert.ok(!/from\s*['"][^'"]*\/server\//.test(t) || !/bcpC02/i.test(t), `frontend src imports server C-02: ${f}`);
  }
});

test('the C-02 handler is registered (app.*) ONLY in the isolated platform-identity server.ts', () => {
  const REG_RE = /app\.(all|get|post|put|patch|delete|use|head|options)\s*\([^)]*createBcpC02RegistryReadinessHandler/;
  let registrations = 0;
  for (const f of walk(`${ROOT}server`)) {
    const code = stripComments(fs.readFileSync(f, 'utf8'));
    if (REG_RE.test(code)) {
      registrations++;
      assert.ok(
        f.replace(/\\/g, '/').endsWith('server/platform-identity/server.ts'),
        `C-02 registered outside the isolated identity API: ${f}`,
      );
    }
    // server/index.ts (the SaaS sidecar) must not even import the C-02 adapter.
    if (f.replace(/\\/g, '/').endsWith('server/index.ts')) {
      assert.ok(!/bcpC02ReadOnlyExpressAdapter|createBcpC02RegistryReadinessHandler/.test(code), 'SaaS sidecar imports C-02');
    }
  }
  assert.equal(registrations, 1, 'expected exactly one C-02 registration across server/**');
});

// ---- Runner ----
(() => {
  let pass = 0;
  const failures: string[] = [];
  for (const c of cases) {
    try { c.fn(); pass++; console.log('PASS ' + c.name); }
    catch (e) { failures.push(c.name + ' :: ' + (e instanceof Error ? e.message : String(e))); console.log('FAIL ' + c.name); }
  }
  console.log(`\n[M8E BCP C-02 isolated route registration] ${pass}/${cases.length} passed`);
  if (failures.length) { console.log('FAILURES:'); for (const f of failures) console.log('  - ' + f); process.exit(1); }
  console.log('ALL_TESTS_PASSED');
  process.exit(0);
})();
