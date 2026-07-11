// Phase 3.0 M3 Gate 1 — dedicated tests for the additive READ-ONLY identity lookup in identityRepository.ts.
// DB-FREE: injects a fake tagged-template `sql` executor (never calls getDb / a real DB). Proves exact
// provider+subject resolution, fail-closed not-found/ambiguous/db-error, provider isolation, SELECT-only
// (no write), and no email fallback. Runs via `npx tsx`. Server-side only.
import assert from 'node:assert/strict';
import { findInternalUserIdByProviderSubject } from './identityRepository';

type Rows = any[];
function makeSql(handler: (provider: string, uid: string, text: string) => Rows) {
  const calls: { provider: string; uid: string; text: string }[] = [];
  const sql = (strings: TemplateStringsArray, ...values: any[]) => {
    const text = strings.join(' ? ');
    const provider = values[0];
    const uid = values[1];
    calls.push({ provider, uid, text });
    return Promise.resolve(handler(provider, uid, text));
  };
  return { sql, calls };
}
const failingSql = () => Promise.reject(new Error('db down'));

const cases: { name: string; fn: () => Promise<void> }[] = [];
const test = (n: string, fn: () => Promise<void>) => cases.push({ name: n, fn });

test('exact match → ok + internalUserId', async () => {
  const { sql } = makeSql(() => [{ internal_user_id: 'iu_alpha' }]);
  const r = await findInternalUserIdByProviderSubject('firebase', 'fbuid1', sql as any);
  assert.equal(r.ok, true); assert.equal(r.internalUserId, 'iu_alpha');
});
test('no match → fail closed not_found', async () => {
  const { sql } = makeSql(() => []);
  const r = await findInternalUserIdByProviderSubject('firebase', 'nobody', sql as any);
  assert.equal(r.ok, false); assert.equal(r.reason, 'not_found');
});
test('ambiguous (>1 row) → fail closed ambiguous', async () => {
  const { sql } = makeSql(() => [{ internal_user_id: 'a' }, { internal_user_id: 'b' }]);
  const r = await findInternalUserIdByProviderSubject('firebase', 'dup', sql as any);
  assert.equal(r.ok, false); assert.equal(r.reason, 'ambiguous');
});
test('empty internal_user_id → fail closed not_found', async () => {
  const { sql } = makeSql(() => [{ internal_user_id: '' }]);
  const r = await findInternalUserIdByProviderSubject('firebase', 'x', sql as any);
  assert.equal(r.ok, false); assert.equal(r.reason, 'not_found');
});
test('provider isolation → exact provider+subject bound in query', async () => {
  const { sql, calls } = makeSql((p, u) => (p === 'firebase' && u === 'fbuid1' ? [{ internal_user_id: 'iu_1' }] : []));
  const ok = await findInternalUserIdByProviderSubject('firebase', 'fbuid1', sql as any);
  assert.equal(ok.ok, true);
  const wrongProvider = await findInternalUserIdByProviderSubject('supabase', 'fbuid1', sql as any);
  assert.equal(wrongProvider.ok, false); assert.equal(wrongProvider.reason, 'not_found');
  assert.equal(calls[0].provider, 'firebase'); assert.equal(calls[0].uid, 'fbuid1');
});
test('DB failure → fail closed db_error', async () => {
  const r = await findInternalUserIdByProviderSubject('firebase', 'x', failingSql as any);
  assert.equal(r.ok, false); assert.equal(r.reason, 'db_error');
});
test('query is SELECT-only (no insert/update/delete/upsert)', async () => {
  const { sql, calls } = makeSql(() => [{ internal_user_id: 'iu' }]);
  await findInternalUserIdByProviderSubject('firebase', 'x', sql as any);
  const text = calls[0].text.toLowerCase();
  assert.match(text, /select/);
  for (const bad of ['insert', 'update', 'delete', 'upsert', 'on conflict']) assert.ok(!text.includes(bad), 'query must not ' + bad);
});
test('no email fallback (query never references email)', async () => {
  const { sql, calls } = makeSql(() => []);
  await findInternalUserIdByProviderSubject('firebase', 'x', sql as any);
  assert.ok(!calls[0].text.toLowerCase().includes('email'));
});

(async () => {
  let p = 0; const f: string[] = [];
  for (const c of cases) { try { await c.fn(); p++; } catch (e) { f.push(c.name + ' :: ' + (e instanceof Error ? e.message : String(e))); } }
  console.log(`\n[P3.0 M3 identityRepository read-only lookup] ${p}/${cases.length} passed`);
  if (f.length) { console.log('FAILURES:'); for (const x of f) console.log('  - ' + x); process.exit(1); }
  console.log('ALL_TESTS_PASSED'); process.exit(0);
})();
