// Phase 3.0 M2 — Registration/isolation tests for the "acknowledge readiness review" controlled action.
// Proves the mount is a SINGLE additive POST via the route-path constant, adjacent to C-07, inside
// createPlatformIdentityApp, with no catch-all shadow, no frontend import, no durable/DB/provider access,
// and no customer-facing / SaaS-navigation exposure.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { BCP_ACTION_ACK_ROUTE_PATH } from './bcpActionAcknowledgeReadinessReviewExpressAdapter';
import { BCP_ELIGIBILITY_ROUTE_PATH } from './bcpActionEligibilityExpressAdapter';

const ROOT = new URL('../../', import.meta.url).pathname; // repo root (…/server/bcp-pilot/ -> …/)
const code = fs.readFileSync(new URL('../platform-identity/server.ts', import.meta.url), 'utf8');
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
function walk(dir: string): string[] {
  const out: string[] = [];
  let entries: string[] = [];
  try { entries = fs.readdirSync(dir); } catch { return out; }
  for (const e of entries) {
    if (e === 'node_modules' || e === '.git' || e === 'dist') continue;
    const full = `${dir}/${e}`;
    let stat: fs.Stats;
    try { stat = fs.statSync(full); } catch { continue; }
    if (stat.isDirectory()) out.push(...walk(full));
    else if (/\.(ts|tsx)$/.test(e)) out.push(full);
  }
  return out;
}

const cases: { name: string; fn: () => void }[] = [];
const test = (n: string, fn: () => void) => cases.push({ name: n, fn });

test('route path constant is the accepted POST action path', () =>
  assert.equal(BCP_ACTION_ACK_ROUTE_PATH, '/dev/bcp/actions/acknowledge-readiness-review'));

test('registers the action exactly once via app.post(constant)', () => {
  assert.equal((code.match(/app\.post\(\s*BCP_ACTION_ACK_ROUTE_PATH\s*,/g) ?? []).length, 1);
  assert.ok(!/['"]\/dev\/bcp\/actions\/acknowledge-readiness-review['"]/.test(code), 'path must be via the constant, not a literal');
});

test('imports the action adapter factory + route-path constant from the adapter module', () => {
  assert.ok(/import\s*\{[^}]*createBcpActionAcknowledgeReadinessReviewHandler[^}]*\}\s*from\s*['"]\.\.\/bcp-pilot\/bcpActionAcknowledgeReadinessReviewExpressAdapter['"]/.test(code));
  assert.ok(code.includes('BCP_ACTION_ACK_ROUTE_PATH'));
});

test('action mount is placed AFTER the C-07 mount and BEFORE `return app`', () => {
  const idxC07 = code.search(/app\.all\(\s*BCP_C07_DATA_SOURCE_BOUNDARY_ROUTE_PATH/);
  const idxAction = code.search(/app\.post\(\s*BCP_ACTION_ACK_ROUTE_PATH/);
  const idxReturn = code.search(/\breturn app\b/);
  assert.ok(idxC07 >= 0 && idxAction >= 0 && idxReturn >= 0, 'all anchors present');
  assert.ok(idxAction > idxC07, 'action mount must be after C-07');
  assert.ok(idxAction < idxReturn, 'action mount must precede `return app`');
});

test('no wildcard / catch-all route shadows the action mount', () => {
  const idxAction = code.search(/app\.post\(\s*BCP_ACTION_ACK_ROUTE_PATH/);
  const before = code.slice(0, idxAction);
  assert.ok(!/app\.(all|get|post|put|patch|delete|use)\(\s*['"][*]/.test(before), 'no wildcard catch-all before the action');
  assert.ok(!/app\.(all|get|post)\(\s*['"]\/\*/.test(before), 'no /* catch-all before the action');
});

test('the action mount line introduces NO DB / Supabase / durable-audit / provider access', () => {
  const line = (code.split('\n').find((l) => /app\.post\(\s*BCP_ACTION_ACK_ROUTE_PATH/.test(l)) ?? '');
  for (const bad of ['getDb', 'createClient', '@supabase', 'writeAuditEvent', 'buildAuthorizationDecisionAuditEvent']) assert.ok(!line.includes(bad), bad);
});

test('no mutation/customer-facing/SaaS-nav registration around the action', () => {
  const ctx = stripComments(code).split('\n').filter((l) => /BCP_ACTION_ACK|acknowledge-readiness/i.test(l)).join('\n').toLowerCase();
  for (const bad of ['/api/bcp', '/admin', 'customer', 'navitems', 'navigation', 'writeauditevent', 'getdb']) assert.ok(!ctx.includes(bad), bad);
});

test('no frontend src/ file imports the BACKEND action modules', () => {
  const FB = [
    'createBcpActionAcknowledgeReadinessReviewHandler', 'bcpActionAcknowledgeReadinessReviewExpressAdapter',
    'bcpActionAcknowledgeReadinessReview', 'bcpActionAuthorizationGuard', 'bcpActionAuditSink',
  ];
  for (const f of walk(`${ROOT}src`)) {
    const t = fs.readFileSync(f, 'utf8');
    for (const b of FB) assert.ok(!t.includes(b), `${f} imports ${b}`);
  }
});

test('the action handler is registered (app.*) ONLY in the isolated server.ts', () => {
  let n = 0;
  for (const f of walk(`${ROOT}server`)) {
    const c = stripComments(fs.readFileSync(f, 'utf8'));
    if (/app\.(all|get|post|put|patch|delete|use|head|options)\s*\([\s\S]{0,240}?createBcpActionAcknowledgeReadinessReviewHandler/.test(c)) {
      n++; assert.ok(f.replace(/\\/g, '/').endsWith('server/platform-identity/server.ts'), f);
    }
  }
  assert.equal(n, 1);
});

test('the action source modules never CALL/import a durable/DB/provider sink (comments may name the prohibition)', () => {
  for (const name of ['bcpActionAcknowledgeReadinessReview.ts', 'bcpActionAuthorizationGuard.ts', 'bcpActionAuditSink.ts', 'bcpActionAcknowledgeReadinessReviewExpressAdapter.ts']) {
    // Strip comments first: the audit-sink doc-comment intentionally NAMES `writeAuditEvent`/`getDb` to state the
    // hard prohibition. The test verifies the CODE never references them, not that the prohibition goes unmentioned.
    const src = stripComments(fs.readFileSync(new URL('./' + name, import.meta.url), 'utf8'));
    for (const bad of ['writeAuditEvent', 'getDb', '@supabase', 'createClient', "from '../db", 'firebase-admin']) {
      assert.ok(!src.includes(bad), `${name} must not reference ${bad} in code`);
    }
  }
});

// ---- Phase 3.0 M3 Gate 1: Firebase Admin verification boundary ----
test('firebase-admin is imported ONLY by the dedicated adapter, and ONLY app+auth subpaths', () => {
  const prohibitedSub = ['firestore', 'database', 'storage', 'messaging', 'remote-config', 'app-check'];
  const importers: string[] = [];
  for (const f of walk(`${ROOT}server`)) {
    const src = stripComments(fs.readFileSync(f, 'utf8'));
    const imports = src.match(/from\s+['"]firebase-admin(\/[a-z-]+)?['"]/g) ?? [];
    if (imports.length) {
      importers.push(f.replace(/\\/g, '/'));
      for (const imp of imports) assert.ok(/firebase-admin\/(app|auth)['"]/.test(imp), `${f}: only firebase-admin/app|auth allowed, saw ${imp}`);
    }
    for (const sub of prohibitedSub) assert.ok(!src.includes(`firebase-admin/${sub}`), `${f} must not import firebase-admin/${sub}`);
  }
  assert.equal(importers.length, 1, `exactly one firebase-admin importer; saw: ${importers.join(', ')}`);
  assert.ok(importers[0].endsWith('server/platform-identity/firebaseAdminAuthAdapter.ts'), importers[0]);
});

test('bcpAction* source modules never import the durable-audit-writing service or a Supabase verifier', () => {
  for (const f of walk(`${ROOT}server/bcp-pilot`)) {
    if (!/\/bcpAction[^/]*\.ts$/.test(f) || /\.test\.ts$/.test(f)) continue;
    const src = stripComments(fs.readFileSync(f, 'utf8'));
    for (const bad of ['sessionAuthorizationService', 'writeAuditEvent', 'auditEventWriter', 'supabaseAuthAdapter', '@supabase', 'createClient', 'firebase-admin']) {
      assert.ok(!src.includes(bad), `${f} must not reference ${bad} in code (use injected/dedicated seams)`);
    }
  }
});

test('no frontend src/ imports the new backend verification/resolution modules', () => {
  const FB = ['firebaseAdminAuthAdapter', 'bcpActionLivePrincipalResolver', 'bcpActionCanonicalAuthzResolver', 'findInternalUserIdByProviderSubject'];
  for (const f of walk(`${ROOT}src`)) {
    const t = fs.readFileSync(f, 'utf8');
    for (const b of FB) assert.ok(!t.includes(b), `${f} imports ${b}`);
  }
});

// ---- Phase 3.0 M3: hardening-primitive boundaries (security guard / rate limiter / idempotency store) ----
test('no frontend src/ imports the server-only hardening primitives', () => {
  const FB = ['bcpActionRequestSecurityGuard', 'bcpActionRateLimiter', 'bcpActionIdempotencyStore'];
  for (const f of walk(`${ROOT}src`)) {
    const t = fs.readFileSync(f, 'utf8');
    for (const b of FB) assert.ok(!t.includes(b), `${f} imports server-only ${b}`);
  }
});

test('hardening primitives are pure/server-local: no express/DB/firebase/network/fs imports', () => {
  for (const name of ['bcpActionRequestSecurityGuard.ts', 'bcpActionRateLimiter.ts', 'bcpActionIdempotencyStore.ts']) {
    const src = stripComments(fs.readFileSync(new URL('./' + name, import.meta.url), 'utf8'));
    for (const bad of ['express', 'getDb', '@supabase', 'firebase', 'writeAuditEvent', "from 'node:fs'", "from 'node:net'", "from 'node:http'", 'fetch(']) {
      assert.ok(!src.includes(bad), `${name} must not reference ${bad} (must stay a pure in-memory primitive)`);
    }
  }
});

// ---- Phase 3.0 M3: READ-ONLY eligibility probe registration + side-effect boundary ----
test('eligibility route constant is the GET eligibility sub-path', () =>
  assert.equal(BCP_ELIGIBILITY_ROUTE_PATH, '/dev/bcp/actions/acknowledge-readiness-review/eligibility'));

test('registers the eligibility probe exactly once via app.all(constant), never app.get/app.post', () => {
  assert.equal((code.match(/app\.all\(\s*BCP_ELIGIBILITY_ROUTE_PATH\s*,/g) ?? []).length, 1);
  assert.equal((code.match(/app\.get\(\s*BCP_ELIGIBILITY_ROUTE_PATH/g) ?? []).length, 0);
  assert.equal((code.match(/app\.post\(\s*BCP_ELIGIBILITY_ROUTE_PATH/g) ?? []).length, 0);
  assert.ok(!/['"]\/dev\/bcp\/actions\/acknowledge-readiness-review\/eligibility['"]/.test(code), 'path via constant, not literal');
});

test('POST action route remains exactly once (unchanged) and is NOT a GET', () => {
  assert.equal((code.match(/app\.post\(\s*BCP_ACTION_ACK_ROUTE_PATH\s*,/g) ?? []).length, 1);
  assert.equal((code.match(/app\.get\(\s*BCP_ACTION_ACK_ROUTE_PATH/g) ?? []).length, 0);
});

test('eligibility mount is placed AFTER the action mount and BEFORE `return app`', () => {
  const idxAction = code.search(/app\.post\(\s*BCP_ACTION_ACK_ROUTE_PATH/);
  const idxElig = code.search(/app\.all\(\s*BCP_ELIGIBILITY_ROUTE_PATH/);
  const idxReturn = code.search(/\breturn app\b/);
  assert.ok(idxAction >= 0 && idxElig >= 0 && idxReturn >= 0, 'all anchors present');
  assert.ok(idxElig > idxAction, 'eligibility mount must be after the action mount');
  assert.ok(idxElig < idxReturn, 'eligibility mount must precede `return app`');
});

test('eligibility module + adapter never import the action handler, advisory sink, or idempotency store', () => {
  for (const name of ['bcpActionEligibility.ts', 'bcpActionEligibilityExpressAdapter.ts']) {
    const src = stripComments(fs.readFileSync(new URL('./' + name, import.meta.url), 'utf8'));
    for (const bad of ['bcpActionAuditSink', 'bcpActionIdempotencyStore', 'handleBcpActionAcknowledgeReadinessReview', "from './bcpActionAcknowledgeReadinessReview'", 'advisoryLogActionAuditSink', 'BcpActionIdempotencyStore']) {
      assert.ok(!src.includes(bad), `${name} must not reference ${bad} (read probe = no action-execution graph)`);
    }
  }
});

test('the eligibility handler is registered (app.all) ONLY in the isolated server.ts', () => {
  let n = 0;
  for (const f of walk(`${ROOT}server`)) {
    const c = stripComments(fs.readFileSync(f, 'utf8'));
    if (/app\.(all|get|post|put|patch|delete|use|head|options)\s*\([\s\S]{0,240}?createBcpActionEligibilityHandler/.test(c)) {
      n++; assert.ok(f.replace(/\\/g, '/').endsWith('server/platform-identity/server.ts'), f);
    }
  }
  assert.equal(n, 1);
});

test('no frontend src/ imports the eligibility backend modules', () => {
  const FB = ['bcpActionEligibilityExpressAdapter', 'createBcpActionEligibilityHandler', 'bcpActionEligibility'];
  for (const f of walk(`${ROOT}src`)) {
    const t = fs.readFileSync(f, 'utf8');
    for (const b of FB) assert.ok(!t.includes(b), `${f} imports backend ${b}`);
  }
});

(() => { let p = 0; const f: string[] = []; for (const c of cases) { try { c.fn(); p++; } catch (e) { f.push(c.name + ' :: ' + (e instanceof Error ? e.message : String(e))); } } console.log(`\n[P3.0 M2 BCP action registration] ${p}/${cases.length} passed`); if (f.length) { console.log('FAILURES:'); for (const x of f) console.log('  - ' + x); process.exit(1); } console.log('ALL_TESTS_PASSED'); process.exit(0); })();
