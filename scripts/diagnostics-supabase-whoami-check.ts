// Phase 1.5 M3-Revised — dev-only smoke harness for the VERIFIED Supabase
// whoami diagnostic endpoint (FAIL-CLOSED identity).
//
// Hermetic by design: it generates an EC (ES256) keypair, serves a MOCK JWKS
// endpoint, and signs its own test tokens, so the full verification path is
// exercised WITHOUT a live Supabase project and WITHOUT any real secret/token.
// Identity resolution is INJECTED so success / DB-failure / null-id paths are
// all provable without a real database.
//
// FAIL-CLOSED contract under test: a verified token is only an authenticated
// app actor once it maps to a non-null internal_user_id. Verified-token +
// failed/empty resolution ⇒ 503 identity_resolution_error, never 200/authenticated.
//
// Run:  npx tsx scripts/diagnostics-supabase-whoami-check.ts
//
// Prints NO tokens, NO keys, NO secrets.

import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';
import { generateKeyPair, exportJWK, SignJWT, type JWK } from 'jose';
import { VerifiedSupabaseAuthAdapter } from '../server/platform-identity/supabaseAuthAdapter';
import { createSupabaseWhoamiHandler, type ResolveIdentityFn } from '../server/platform-identity/verifiedWhoami';
import { buildRequestContext, type ActorAssertion } from '../server/platform-identity/requestContext';

const ISSUER = 'https://mock-project.supabase.test/auth/v1';
const AUDIENCE = 'authenticated';
const KID = 'test-key-1';
const SUBJECT = '11111111-2222-3333-4444-555555555555';
const FIXED_INTERNAL_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

// ---------- results plumbing ----------
const results: Array<{ name: string; pass: boolean; detail: string }> = [];
function check(name: string, pass: boolean, detail: string) {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name} — ${detail}`);
}
function skip(name: string, detail: string) {
  console.log(`SKIP  ${name} — ${detail}`);
}

// ---------- flag / env helpers ----------
function setFlags(identity: boolean, verified: boolean) {
  if (identity) process.env.ENABLE_SUPABASE_PLATFORM_IDENTITY = 'true';
  else delete process.env.ENABLE_SUPABASE_PLATFORM_IDENTITY;
  if (verified) process.env.PLATFORM_IDENTITY_VERIFIED_DIAGNOSTICS = 'true';
  else delete process.env.PLATFORM_IDENTITY_VERIFIED_DIAGNOSTICS;
}
function setProd(isProd: boolean) {
  process.env.NODE_ENV = isProd ? 'production' : 'development';
}

async function post(base: string, token?: string) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token) headers['authorization'] = `Bearer ${token}`;
  const res = await fetch(`${base}/diagnostics/supabase-whoami`, { method: 'POST', headers, body: '{}' });
  let json: any = null;
  try { json = await res.json(); } catch { /* ignore */ }
  return { status: res.status, json, rawText: JSON.stringify(json ?? {}) };
}

function nowSec() { return Math.floor(Date.now() / 1000); }

// Capture console output (the audit sink) during fn, then restore.
async function captureConsole(fn: () => Promise<any>): Promise<{ result: any; logs: any[][] }> {
  const origLog = console.log, origErr = console.error, origWarn = console.warn;
  const logs: any[][] = [];
  console.log = (...a: any[]) => { logs.push(a); };
  console.error = (...a: any[]) => { logs.push(a); };
  console.warn = (...a: any[]) => { logs.push(a); };
  try {
    const result = await fn();
    return { result, logs };
  } finally {
    console.log = origLog; console.error = origErr; console.warn = origWarn;
  }
}
function findEnvelopes(logs: any[][]): any[] {
  const envs: any[] = [];
  for (const args of logs) for (const a of args) {
    if (a && typeof a === 'object' && 'decision' in a && 'actionId' in a) envs.push(a);
  }
  return envs;
}

// helper to spin an ephemeral app for a given adapter + resolver
async function makeBase(adapter: VerifiedSupabaseAuthAdapter, resolveIdentity?: ResolveIdentityFn): Promise<{ base: string; close: () => void }> {
  const app = express(); app.use(express.json());
  app.post('/diagnostics/supabase-whoami', createSupabaseWhoamiHandler({ adapter, resolveIdentity }));
  const srv = app.listen(0, '127.0.0.1');
  await new Promise<void>((r) => srv.once('listening', () => r()));
  return { base: `http://127.0.0.1:${(srv.address() as AddressInfo).port}`, close: () => srv.close() };
}

async function main() {
  // Hermetic: never touch the real DB. With config incomplete, the DEFAULT
  // resolver returns null ⇒ proves the fail-closed default.
  delete process.env.SUPABASE_DATABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;

  // --- keys: good signer (in JWKS) + rogue signer (not in JWKS) ---
  const { publicKey, privateKey } = await generateKeyPair('ES256', { extractable: true });
  const rogue = await generateKeyPair('ES256', { extractable: true });
  const jwk: JWK = { ...(await exportJWK(publicKey)), kid: KID, alg: 'ES256', use: 'sig' };

  // --- mock JWKS server ---
  const jwksServer = http.createServer((req, res) => {
    if (req.url && req.url.includes('/jwks.json')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ keys: [jwk] }));
    } else { res.writeHead(404); res.end('{}'); }
  });
  await new Promise<void>((r) => jwksServer.listen(0, '127.0.0.1', () => r()));
  const jwksPort = (jwksServer.address() as AddressInfo).port;
  const jwksUri = `http://127.0.0.1:${jwksPort}/auth/v1/.well-known/jwks.json`;

  // --- adapters ---
  const goodAdapter = new VerifiedSupabaseAuthAdapter({ jwksUri, issuer: ISSUER, audience: AUDIENCE });
  const deadAdapter = new VerifiedSupabaseAuthAdapter({
    jwksUri: 'http://127.0.0.1:9/auth/v1/.well-known/jwks.json', issuer: ISSUER, audience: AUDIENCE,
  });

  // --- resolvers (injected) ---
  const resolveOk: ResolveIdentityFn = async () => FIXED_INTERNAL_ID;
  const resolveThrows: ResolveIdentityFn = async () => { throw new Error('simulated DB failure'); };
  const resolveNull: ResolveIdentityFn = async () => null;

  // --- ephemeral apps ---
  const success = await makeBase(goodAdapter, resolveOk);       // verified + resolves
  const dbFail = await makeBase(goodAdapter, resolveThrows);    // verified + repo throws
  const nullId = await makeBase(goodAdapter, resolveNull);      // verified + null id
  const dflt = await makeBase(goodAdapter);                     // verified + DEFAULT resolver (no DB ⇒ null)
  const dead = await makeBase(deadAdapter, resolveOk);          // jwks unreachable (fails before resolve)

  // --- token factory ---
  const baseClaims = { email: 'verified@example.test', user_metadata: { full_name: 'Verified Tester' } };
  const signWith = (key: CryptoKey, opts: { iss?: string; aud?: string; exp?: number; sub?: string }) =>
    new SignJWT({ ...baseClaims })
      .setProtectedHeader({ alg: 'ES256', kid: KID })
      .setIssuedAt()
      .setIssuer(opts.iss ?? ISSUER)
      .setAudience(opts.aud ?? AUDIENCE)
      .setSubject(opts.sub ?? SUBJECT)
      .setExpirationTime(opts.exp ?? nowSec() + 3600)
      .sign(key);

  try {
    // ===== Flag matrix (POST with no token) =====
    setProd(false);
    setFlags(false, false);
    let r = await post(success.base);
    check('F1 all flags OFF → 404', r.status === 404 && r.json?.error?.code === 'FEATURE_DISABLED', `status=${r.status} code=${r.json?.error?.code}`);

    setFlags(true, false);
    r = await post(success.base);
    check('F2 identity ON, verified OFF → 404', r.status === 404, `status=${r.status}`);

    setFlags(false, true);
    r = await post(success.base);
    check('F3 identity OFF, verified ON → 404', r.status === 404, `status=${r.status}`);

    setFlags(true, true);
    setProd(true);
    r = await post(success.base);
    check('F4 both ON + NODE_ENV=production → 404', r.status === 404, `status=${r.status}`);
    setProd(false);

    r = await post(success.base);
    check('F5 both ON + non-prod → reachable (401 unauth, no token)', r.status === 401 && r.json?.reasonCode === 'denied_unauthenticated', `status=${r.status} reason=${r.json?.reasonCode}`);

    // ===== Success path: verified + resolved identity =====
    const validToken = await signWith(privateKey, {});
    r = await post(success.base, validToken);
    check('T1 verified + resolved → 200 authenticated', r.status === 200 && r.json?.authState === 'authenticated' && r.json?.authProvider === 'supabase' && r.json?.authProviderUid === SUBJECT, `status=${r.status} authState=${r.json?.authState}`);
    check('T1b non-null internalUserId on success', r.json?.internalUserId === FIXED_INTERNAL_ID, `internalUserId=${r.json?.internalUserId}`);
    check('T1c sourceOfTruth labelled verified', r.json?.sourceOfTruth === 'supabase_verified_token', `sourceOfTruth=${r.json?.sourceOfTruth}`);

    // ===== Fail-closed identity paths (verified token, resolution fails) =====
    r = await post(dbFail.base, validToken);
    check('T8 verified + repo throws → 503 identity_resolution_error', r.status === 503 && r.json?.reasonCode === 'identity_resolution_error' && r.json?.authState !== 'authenticated', `status=${r.status} reason=${r.json?.reasonCode} authState=${r.json?.authState}`);

    r = await post(nullId.base, validToken);
    check('T9 verified + null id → 503 identity_resolution_error', r.status === 503 && r.json?.reasonCode === 'identity_resolution_error' && r.json?.authState !== 'authenticated', `status=${r.status} reason=${r.json?.reasonCode} authState=${r.json?.authState}`);

    r = await post(dflt.base, validToken);
    check('T10 verified + default resolver (no DB) → 503 identity_resolution_error (fail-closed default)', r.status === 503 && r.json?.reasonCode === 'identity_resolution_error' && r.json?.authState !== 'authenticated', `status=${r.status} reason=${r.json?.reasonCode}`);

    // ===== Token verification failures (resolver never reached) =====
    r = await post(success.base); // no token
    check('T2 missing header → 401 denied_unauthenticated', r.status === 401 && r.json?.reasonCode === 'denied_unauthenticated', `status=${r.status} reason=${r.json?.reasonCode}`);

    const badSig = await signWith(rogue.privateKey, {});
    r = await post(success.base, badSig);
    check('T3 bad signature → supabase_token_invalid', r.status === 401 && r.json?.reasonCode === 'supabase_token_invalid', `status=${r.status} reason=${r.json?.reasonCode}`);

    const expired = await signWith(privateKey, { exp: nowSec() - 3600 });
    r = await post(success.base, expired);
    check('T4 expired → supabase_token_expired', r.status === 401 && r.json?.reasonCode === 'supabase_token_expired', `status=${r.status} reason=${r.json?.reasonCode}`);

    const wrongIss = await signWith(privateKey, { iss: 'https://evil.example/auth/v1' });
    r = await post(success.base, wrongIss);
    check('T5 wrong issuer → supabase_token_wrong_issuer', r.status === 401 && r.json?.reasonCode === 'supabase_token_wrong_issuer', `status=${r.status} reason=${r.json?.reasonCode}`);

    const wrongAud = await signWith(privateKey, { aud: 'not-authenticated' });
    r = await post(success.base, wrongAud);
    check('T6 wrong audience → supabase_token_wrong_audience', r.status === 401 && r.json?.reasonCode === 'supabase_token_wrong_audience', `status=${r.status} reason=${r.json?.reasonCode}`);

    r = await post(dead.base, validToken);
    check('T7 JWKS unavailable → 503 jwks_unavailable', r.status === 503 && r.json?.reasonCode === 'jwks_unavailable', `status=${r.status} reason=${r.json?.reasonCode}`);

    // ===== Secret-safety: response must not echo the raw token / JWT material =====
    const safeProbe = await post(success.base, validToken);
    const leaks = safeProbe.rawText.includes(validToken) || /eyJ[A-Za-z0-9_-]{10,}\./.test(safeProbe.rawText);
    check('S1 response contains no raw token / JWT', !leaks, leaks ? 'LEAK DETECTED' : 'no token/JWT in response body');

    // ===== Audit/evidence: success uses non-null actorId; failure never claims auth =====
    const capSuccess = await captureConsole(() => post(success.base, validToken));
    const successEnvs = findEnvelopes(capSuccess.logs);
    const allowEnv = successEnvs.find((e) => e.decision === 'allow');
    check('A1 success audit uses non-null actorId == internalUserId', !!allowEnv && allowEnv.actorId === FIXED_INTERNAL_ID, `allow envelope actorId=${allowEnv?.actorId}`);

    const capFail = await captureConsole(() => post(nullId.base, validToken));
    const failEnvs = findEnvelopes(capFail.logs);
    const badAllow = failEnvs.some((e) => e.decision === 'allow' && (e.actorId === null || e.actorId === undefined));
    const hasFailLabel = failEnvs.some((e) => e.reasonCode === 'identity_resolution_error' && e.decision !== 'allow');
    check('A2 failure audit never claims authenticated actor with null actorId', !badAllow && hasFailLabel, `badAllow=${badAllow} hasFailLabel=${hasFailLabel}`);

    // ===== buildRequestContext seam =====
    const verifiedAssertion: ActorAssertion = {
      authProvider: 'supabase', authProviderUid: SUBJECT, email: 'v@example.test', displayName: 'V',
      actorType: 'platform_user', scope: { scopeType: 'none', tenantId: null, storeId: null, platformScope: false },
      permissionSnapshot: null, verified: true,
    };
    // FAIL-CLOSED at the request-context seam (requirement #4): a verified token
    // with NO resolved app identity (hermetic mode ⇒ no DB ⇒ null internalUserId)
    // is 'token-verified', NEVER 'authenticated'. authState='authenticated' is
    // only reachable once a durable internal_user_id exists.
    const ctxVerified = await buildRequestContext('req-1', verifiedAssertion);
    check('B1 verified token + no app identity → token-verified (NOT authenticated)', ctxVerified.authState === 'token-verified' && ctxVerified.actor.authProvider === 'supabase' && ctxVerified.actor.internalUserId === null, `authState=${ctxVerified.authState} internalUserId=${ctxVerified.actor.internalUserId}`);

    const devAssertion: ActorAssertion = {
      authProvider: 'firebase', authProviderUid: 'dev-uid', email: null,
      actorType: 'dev_actor', scope: { scopeType: 'none', tenantId: null, storeId: null, platformScope: false },
      permissionSnapshot: null, // verified omitted
    };
    const ctxDev = await buildRequestContext('req-2', devAssertion);
    check('B2 dev assertion (verified omitted) → authState dev-asserted (M2 unchanged)', ctxDev.authState === 'dev-asserted', `authState=${ctxDev.authState}`);

    const ctxNull = await buildRequestContext('req-3', null);
    check('B3 null assertion → authState unauthenticated', ctxNull.authState === 'unauthenticated', `authState=${ctxNull.authState}`);

    // ===== Live identity mapping (needs real token + DB) =====
    skip('I1 live identity mapping (auth_provider=supabase, idempotent internal_user_id)',
      'requires owner-supplied SUPABASE_TEST_ACCESS_TOKEN + applied migration + reachable DB; not run in hermetic mode');

  } finally {
    success.close(); dbFail.close(); nullId.close(); dflt.close(); dead.close(); jwksServer.close();
  }

  const failed = results.filter((x) => !x.pass);
  console.log(`\n[supabase-whoami-smoke] ${results.length - failed.length}/${results.length} checks passed.`);
  if (failed.length) process.exitCode = 1;
}

main().catch((e) => { console.error('[supabase-whoami-smoke] harness error:', e?.name || 'Error'); process.exitCode = 1; });
