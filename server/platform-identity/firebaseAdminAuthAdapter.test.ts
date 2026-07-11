// Phase 3.0 M3 Gate 1 — focused tests for the DEV-only Firebase Admin verification adapter.
// Runs via `npx tsx`. Uses ONLY dependency-injected fake verifiers + pure functions — NO real firebase-admin
// init, NO real credential, NO network. Proves Bearer parsing, sanitized error mapping, no token/claim leakage,
// and credential-structure validation. Server-side only.
import assert from 'node:assert/strict';
import {
  extractBearerCredential,
  verifyFirebaseBearer,
  parseServiceAccountJson,
  getDefaultFirebaseVerifier,
  FIREBASE_ID_TOKEN_MAX_LEN,
  type FirebaseIdTokenVerifier,
} from './firebaseAdminAuthAdapter';

const cases: { name: string; fn: () => void | Promise<void> }[] = [];
const test = (n: string, fn: () => void | Promise<void>) => cases.push({ name: n, fn });

const okVerifier: FirebaseIdTokenVerifier = { verify: async () => ({ uid: 'fbuid_stub_abc' }) };
const throwing = (code: string): FirebaseIdTokenVerifier => ({
  verify: async () => { const e: any = new Error('x'); e.code = code; throw e; },
});
const NEVER_CALLED: FirebaseIdTokenVerifier = { verify: async () => { throw new Error('verifier must not be called'); } };

// ---------- Bearer credential extraction ----------
test('missing header → authentication_required', () => {
  const r = extractBearerCredential(undefined);
  assert.equal(r.ok, false); assert.equal(r.code, 'authentication_required');
});
test('empty header → authentication_required', () => {
  assert.equal(extractBearerCredential('').code, 'authentication_required');
});
test('non-Bearer scheme → authentication_invalid', () => {
  assert.equal(extractBearerCredential('Basic abcdef').code, 'authentication_invalid');
});
test('Bearer with empty token → authentication_invalid', () => {
  assert.equal(extractBearerCredential('Bearer   ').code, 'authentication_invalid');
});
test('multiple credentials as array → authentication_invalid', () => {
  assert.equal(extractBearerCredential(['Bearer a', 'Bearer b']).code, 'authentication_invalid');
});
test('two tokens after Bearer → authentication_invalid', () => {
  assert.equal(extractBearerCredential('Bearer aaaa bbbb').code, 'authentication_invalid');
});
test('oversized token → authentication_invalid', () => {
  assert.equal(extractBearerCredential('Bearer ' + 'x'.repeat(FIREBASE_ID_TOKEN_MAX_LEN + 1)).code, 'authentication_invalid');
});
test('valid single Bearer → ok + token (scheme case-insensitive)', () => {
  const r = extractBearerCredential('bearer good.token.value');
  assert.equal(r.ok, true); assert.equal(r.token, 'good.token.value'); assert.equal(r.code, undefined);
});

// ---------- verifyFirebaseBearer (async, injected verifier) ----------
test('valid token → ok + firebaseUid; NO token/claims leakage', async () => {
  const r = await verifyFirebaseBearer('Bearer good.token', { verifier: okVerifier });
  assert.equal(r.ok, true); assert.equal(r.firebaseUid, 'fbuid_stub_abc');
  assert.ok(!('token' in r) && !('idToken' in r) && !('claims' in r) && !('email' in r) && !('decoded' in r));
});
test('missing credential → required, verifier NOT called', async () => {
  const r = await verifyFirebaseBearer(undefined, { verifier: NEVER_CALLED });
  assert.equal(r.ok, false); assert.equal(r.code, 'authentication_required');
});
test('malformed scheme → invalid, verifier NOT called', async () => {
  const r = await verifyFirebaseBearer('Basic xyz', { verifier: NEVER_CALLED });
  assert.equal(r.code, 'authentication_invalid');
});
test('expired token → authentication_expired', async () => {
  const r = await verifyFirebaseBearer('Bearer t', { verifier: throwing('auth/id-token-expired') });
  assert.equal(r.ok, false); assert.equal(r.code, 'authentication_expired');
});
test('revoked token → authentication_revoked', async () => {
  assert.equal((await verifyFirebaseBearer('Bearer t', { verifier: throwing('auth/id-token-revoked') })).code, 'authentication_revoked');
});
test('disabled user → authentication_disabled', async () => {
  assert.equal((await verifyFirebaseBearer('Bearer t', { verifier: throwing('auth/user-disabled') })).code, 'authentication_disabled');
});
test('invalid token (argument-error) → authentication_invalid', async () => {
  assert.equal((await verifyFirebaseBearer('Bearer t', { verifier: throwing('auth/argument-error') })).code, 'authentication_invalid');
});
test('admin unavailable (init/network) → authentication_unavailable', async () => {
  assert.equal((await verifyFirebaseBearer('Bearer t', { verifier: throwing('firebase_admin_unavailable') })).code, 'authentication_unavailable');
});
test('firebase internal-error → authentication_unavailable', async () => {
  assert.equal((await verifyFirebaseBearer('Bearer t', { verifier: throwing('auth/internal-error') })).code, 'authentication_unavailable');
});
test('verifier returns empty uid → authentication_invalid', async () => {
  const r = await verifyFirebaseBearer('Bearer t', { verifier: { verify: async () => ({ uid: '' }) } });
  assert.equal(r.code, 'authentication_invalid');
});

// ---------- parseServiceAccountJson (credential-config validation; pure, no firebase-admin) ----------
const sa = (o: Record<string, unknown> = {}) => JSON.stringify({ type: 'service_account', project_id: 'proj-a', client_email: 'x@proj-a.iam', private_key: 'PK', ...o });
test('missing raw → not ok', () => { assert.equal(parseServiceAccountJson(undefined).ok, false); });
test('malformed JSON → not ok', () => { assert.equal(parseServiceAccountJson('{nope').ok, false); });
test('wrong type → not ok', () => { assert.equal(parseServiceAccountJson(JSON.stringify({ type: 'user' })).ok, false); });
test('missing project_id → not ok', () => { assert.equal(parseServiceAccountJson(sa({ project_id: undefined })).ok, false); });
test('missing client_email → not ok', () => { assert.equal(parseServiceAccountJson(sa({ client_email: undefined })).ok, false); });
test('missing private_key → not ok', () => { assert.equal(parseServiceAccountJson(sa({ private_key: undefined })).ok, false); });
test('valid → ok + parsed fields', () => {
  const r = parseServiceAccountJson(sa());
  assert.equal(r.ok, true); assert.equal(r.serviceAccount?.projectId, 'proj-a'); assert.equal(r.serviceAccount?.clientEmail, 'x@proj-a.iam');
});
test('expected project mismatch → not ok (project_mismatch)', () => {
  const r = parseServiceAccountJson(sa(), 'proj-OTHER');
  assert.equal(r.ok, false); assert.equal(r.reason, 'project_mismatch');
});
test('expected project match → ok', () => {
  assert.equal(parseServiceAccountJson(sa(), 'proj-a').ok, true);
});

// ---------- default (real) verifier composition: fail-closed when the credential is absent ----------
test('default verifier fails closed as unavailable when the service-account secret is absent', async () => {
  const saved = process.env.FIREBASE_ADMIN_SERVICE_ACCOUNT_JSON;
  delete process.env.FIREBASE_ADMIN_SERVICE_ACCOUNT_JSON;
  try {
    await assert.rejects(
      getDefaultFirebaseVerifier().verify('x.y.z'),
      (e: any) => e && e.code === 'firebase_admin_unavailable',
    );
  } finally {
    if (saved !== undefined) process.env.FIREBASE_ADMIN_SERVICE_ACCOUNT_JSON = saved;
  }
});

(async () => {
  let p = 0; const f: string[] = [];
  for (const c of cases) { try { await c.fn(); p++; } catch (e) { f.push(c.name + ' :: ' + (e instanceof Error ? e.message : String(e))); } }
  console.log(`\n[P3.0 M3 firebaseAdminAuthAdapter] ${p}/${cases.length} passed`);
  if (f.length) { console.log('FAILURES:'); for (const x of f) console.log('  - ' + x); process.exit(1); }
  console.log('ALL_TESTS_PASSED'); process.exit(0);
})();
