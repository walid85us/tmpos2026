// Phase 3.0 M3 Gate 1 — focused tests for the DEV-only Firebase Admin verification adapter.
// Runs via `npx tsx`. Uses ONLY dependency-injected fake verifiers + pure functions — NO real firebase-admin
// init, NO real credential, NO network. Proves Bearer parsing, sanitized error mapping, no token/claim leakage,
// and credential-structure validation. Server-side only.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { generateKeyPairSync } from 'node:crypto';
import {
  extractBearerCredential,
  verifyFirebaseBearer,
  parseServiceAccountJson,
  getDefaultFirebaseVerifier,
  FIREBASE_ID_TOKEN_MAX_LEN,
  createRuntimeIdentityVerifier,
  IdentityCompositionError,
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

// ---------- runtime composition: the production authenticator in the runtime's port shape ----------
// A freshly generated key (never a real credential): composition parses the key locally.
const PEM = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const SA_ENV = { FIREBASE_ADMIN_SERVICE_ACCOUNT_JSON: sa({ private_key: PEM }) };
test('runtime verifier refuses to compose without a valid service-account configuration', () => {
  // The last case has every field but a key that does not parse ('PK').
  for (const env of [{}, { FIREBASE_ADMIN_SERVICE_ACCOUNT_JSON: '' }, { FIREBASE_ADMIN_SERVICE_ACCOUNT_JSON: '{nope' }, { FIREBASE_ADMIN_SERVICE_ACCOUNT_JSON: sa({ private_key: undefined }) }, { FIREBASE_ADMIN_SERVICE_ACCOUNT_JSON: sa() }]) {
    assert.throws(() => createRuntimeIdentityVerifier(env, { verifier: NEVER_CALLED }),
      (e: unknown) => e instanceof IdentityCompositionError && e.code === 'identity_verifier_unconfigured' && !e.message.includes('proj-a'));
  }
});
test('runtime verifier yields only a verified firebase identity key and its (absent) evidence', async () => {
  const v = createRuntimeIdentityVerifier(SA_ENV, { verifier: okVerifier });
  assert.deepEqual(await v.verify(Object.freeze({ bearerToken: 'good.token' })),
    { verified: true, authProvider: 'firebase', authProviderUid: 'fbuid_stub_abc', authenticatedAt: null, secondFactor: null });
});
test('runtime verifier reports the provider-verified sign-in time and second factor, and nothing malformed', async () => {
  const withClaims = (authTime: unknown, secondFactor: unknown): FirebaseIdTokenVerifier => ({ verify: async () => ({ uid: 'fbuid_stub_abc', authTime, secondFactor }) });
  assert.deepEqual(await createRuntimeIdentityVerifier(SA_ENV, { verifier: withClaims(1_700_000_000, 'totp') }).verify({ bearerToken: 't' }),
    { verified: true, authProvider: 'firebase', authProviderUid: 'fbuid_stub_abc', authenticatedAt: 1_700_000_000_000, secondFactor: 'totp' });
  for (const [authTime, secondFactor] of [[undefined, undefined], ['1700000000', 42], [1.5, null], [-1, {}], [0, ['totp']]] as const) {
    const r = await createRuntimeIdentityVerifier(SA_ENV, { verifier: withClaims(authTime, secondFactor) }).verify({ bearerToken: 't' });
    assert.equal(r?.authenticatedAt, null, `auth_time ${String(authTime)}`);
    assert.equal(r?.secondFactor, null, `second factor ${JSON.stringify(secondFactor)}`);
  }
});
test('the DEV pilot result carries no evidence: verifyFirebaseBearer still returns only ok + firebaseUid', async () => {
  const r = await verifyFirebaseBearer('Bearer t', { verifier: { verify: async () => ({ uid: 'fbuid_stub_abc', authTime: 1_700_000_000, secondFactor: 'totp' }) } });
  assert.deepEqual(r, { ok: true, firebaseUid: 'fbuid_stub_abc' });
});
test('runtime verifier refuses an already-cancelled call without consulting the provider', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(createRuntimeIdentityVerifier(SA_ENV, { verifier: NEVER_CALLED }).verify({ bearerToken: 't' }, controller.signal),
    (e: unknown) => e instanceof Error && e.message === 'firebase_admin_unavailable');
});
test('provider outages and configuration faults → authentication_unavailable, never a credential verdict', async () => {
  for (const code of ['app/network-error', 'app/network-timeout', 'app/internal-error', 'app/invalid-credential', 'auth/invalid-credential', 'auth/insufficient-permission']) {
    assert.equal((await verifyFirebaseBearer('Bearer t', { verifier: throwing(code) })).code, 'authentication_unavailable', code);
  }
});
test('an unlisted provider code or a bare fault → unavailable; only the enumerated verdicts are credential failures', async () => {
  for (const code of ['auth/quota-exceeded', 'auth/some-future-code', 'app/no-app', '']) {
    assert.equal((await verifyFirebaseBearer('Bearer t', { verifier: throwing(code) })).code, 'authentication_unavailable', code || '(no code)');
  }
  const fault: FirebaseIdTokenVerifier = { verify: async () => { throw new TypeError('sdk fault'); } };
  assert.equal((await verifyFirebaseBearer('Bearer t', { verifier: fault })).code, 'authentication_unavailable');
  for (const code of ['auth/user-not-found', 'auth/invalid-id-token', 'auth/mismatching-tenant-id']) {
    assert.equal((await verifyFirebaseBearer('Bearer t', { verifier: throwing(code) })).code, 'authentication_invalid', code);
  }
});
const throwingWith = (code: string, message: string): FirebaseIdTokenVerifier => ({
  verify: async () => { const e: any = new Error(message); e.code = code; throw e; },
});
test('a signing-key fetch failure the SDK reports as argument-error → unavailable; a malformed token stays invalid', async () => {
  for (const message of ['Error fetching public keys for Google certs: 503 Service Unavailable', 'Error while making request: connect ECONNREFUSED. Error code: ECONNREFUSED']) {
    assert.equal((await verifyFirebaseBearer('Bearer t', { verifier: throwingWith('auth/argument-error', message) })).code, 'authentication_unavailable', message);
  }
  for (const message of ['Decoding Firebase ID token failed.', 'Firebase ID token has invalid signature.', 'Firebase ID token has incorrect "aud" (audience) claim.', 'x Error fetching public keys']) {
    assert.equal((await verifyFirebaseBearer('Bearer t', { verifier: throwingWith('auth/argument-error', message) })).code, 'authentication_invalid', message);
  }
});
test('the installed SDK still reports key-fetch failures with those message prefixes (guards the mapping on upgrade)', () => {
  const lib = (p: string): string => readFileSync(new URL(`../../node_modules/firebase-admin/lib/${p}`, import.meta.url), 'utf8');
  assert.ok(lib('utils/jwt.js').includes("'Error fetching public keys for Google certs: '"), 'key-fetch HTTP failure prefix');
  assert.ok(lib('utils/api-request.js').includes('`Error while making request: '), 'network failure prefix');
  // Why the prefixes are needed: the token verifier folds a key-fetch failure into INVALID_ARGUMENT.
  assert.ok(lib('auth/token-verifier.js').includes('return new error_1.FirebaseAuthError(error_1.AuthClientErrorCode.INVALID_ARGUMENT, error.message);'));
});
test('runtime verifier fails closed with null, never detail, on every credential failure', async () => {
  for (const code of ['auth/id-token-expired', 'auth/id-token-revoked', 'auth/user-disabled', 'auth/argument-error']) {
    assert.equal(await createRuntimeIdentityVerifier(SA_ENV, { verifier: throwing(code) }).verify({ bearerToken: 't' }), null, code);
  }
  assert.equal(await createRuntimeIdentityVerifier(SA_ENV, { verifier: { verify: async () => ({ uid: '' }) } }).verify({ bearerToken: 't' }), null);
});
test('runtime verifier throws on an outage, so an outage never reads as a bad credential', async () => {
  for (const code of ['firebase_admin_unavailable', 'auth/internal-error', 'auth/network-error']) {
    await assert.rejects(createRuntimeIdentityVerifier(SA_ENV, { verifier: throwing(code) }).verify({ bearerToken: 't' }),
      (e: unknown) => e instanceof Error && e.message === 'firebase_admin_unavailable', code);
  }
});

(async () => {
  let p = 0; const f: string[] = [];
  for (const c of cases) { try { await c.fn(); p++; } catch (e) { f.push(c.name + ' :: ' + (e instanceof Error ? e.message : String(e))); } }
  console.log(`\n[P3.0 M3 firebaseAdminAuthAdapter] ${p}/${cases.length} passed`);
  if (f.length) { console.log('FAILURES:'); for (const x of f) console.log('  - ' + x); process.exit(1); }
  console.log('ALL_TESTS_PASSED'); process.exit(0);
})();
