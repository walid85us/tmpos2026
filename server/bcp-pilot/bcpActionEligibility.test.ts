// Phase 3.0 M3 — focused tests for the DEV-only, READ-ONLY controlled-action ELIGIBILITY probe (pure parts).
// PURE header/security evaluation + bounded decision mapping (no network, no auth, no DB). Run via `npx tsx`.
// Proves: GET-only, EXACT trusted-origin enforcement (reused REPLIT_DEV_DOMAIN logic), Fetch-Metadata cross-site
// rejection, the DEDICATED eligibility intent header/value, and the bounded eligible/not_authorized/auth/
// unavailable response mapping — which NEVER leaks role/permission/parity/cap/identity/denial internals.
import assert from 'node:assert/strict';
import {
  evaluateEligibilitySecurity,
  readEligibilitySecurityInput,
  eligibilityDecision,
  BCP_ELIGIBILITY_INTENT_HEADER,
  BCP_ELIGIBILITY_INTENT_VALUE,
  BCP_ELIGIBILITY_ROUTE_PATH,
  BCP_ELIGIBILITY_PROXY_PATH,
  type EligibilitySecurityInput,
} from './bcpActionEligibility';
import type { TrustedOriginResolution } from './bcpActionRequestSecurityGuard';

const cases: { name: string; fn: () => void }[] = [];
const test = (n: string, fn: () => void) => cases.push({ name: n, fn });

const TRUSTED: TrustedOriginResolution = { ok: true, origin: 'https://app-abc.worf.replit.dev' };
const base = (o: Partial<EligibilitySecurityInput> = {}): EligibilitySecurityInput => ({
  method: 'POST', // bodyless authenticated RPC-style probe — POST so the browser reliably sends the protected Origin
  origin: 'https://app-abc.worf.replit.dev',
  secFetchSite: 'same-origin',
  actionIntent: BCP_ELIGIBILITY_INTENT_VALUE,
  ...o,
});
const ev = (i: EligibilitySecurityInput, t: TrustedOriginResolution = TRUSTED) => evaluateEligibilitySecurity(i, t);
const code = (r: ReturnType<typeof ev>) => (r as any).code;

// ==================== intent value is DISTINCT from the action's ====================
test('eligibility intent value is the dedicated eligibility value', () =>
  assert.equal(BCP_ELIGIBILITY_INTENT_VALUE, 'acknowledge-readiness-review-eligibility'));
test('intent header name is the shared lowercase header', () =>
  assert.equal(BCP_ELIGIBILITY_INTENT_HEADER, 'x-bcp-action-intent'));
test('route + proxy paths are the eligibility sub-path', () => {
  assert.equal(BCP_ELIGIBILITY_ROUTE_PATH, '/dev/bcp/actions/acknowledge-readiness-review/eligibility');
  assert.equal(BCP_ELIGIBILITY_PROXY_PATH, '/__identity/dev/bcp/actions/acknowledge-readiness-review/eligibility');
});

// ==================== happy path ====================
test('exact POST same-origin with intent accepted', () => assert.equal(ev(base()).ok, true));

// ==================== method (POST-only; other methods rejected here — adapter maps them to bounded 404) ====================
test('GET → method_not_allowed', () => assert.equal(code(ev(base({ method: 'GET' }))), 'method_not_allowed'));
test('PUT → method_not_allowed', () => assert.equal(code(ev(base({ method: 'PUT' }))), 'method_not_allowed'));

// ==================== trusted origin unavailable → fail closed ====================
test('trusted origin unavailable → trusted_origin_unavailable', () =>
  assert.equal(code(ev(base(), { ok: false })), 'trusted_origin_unavailable'));

// ==================== exact origin match ====================
test('missing Origin → origin_missing', () => assert.equal(code(ev(base({ origin: undefined }))), 'origin_missing'));
test('exact mismatch → origin_mismatch', () => assert.equal(code(ev(base({ origin: 'https://evil.example' }))), 'origin_mismatch'));
test('http scheme → origin_mismatch', () => assert.equal(code(ev(base({ origin: 'http://app-abc.worf.replit.dev' }))), 'origin_mismatch'));
test('sibling subdomain → origin_mismatch', () => assert.equal(code(ev(base({ origin: 'https://app-xyz.worf.replit.dev' }))), 'origin_mismatch'));
test('suffix attack → origin_mismatch', () => assert.equal(code(ev(base({ origin: 'https://evil-app-abc.worf.replit.dev' }))), 'origin_mismatch'));
test('origin with path → malformed_origin', () => assert.equal(code(ev(base({ origin: 'https://app-abc.worf.replit.dev/x' }))), 'malformed_origin'));
test('origin "null" → malformed_origin', () => assert.equal(code(ev(base({ origin: 'null' }))), 'malformed_origin'));

// ==================== fetch-metadata + intent ====================
test('cross-site → cross_site', () => assert.equal(code(ev(base({ secFetchSite: 'cross-site' }))), 'cross_site'));
test('missing intent → missing_action_intent', () => assert.equal(code(ev(base({ actionIntent: undefined }))), 'missing_action_intent'));
test('wrong intent (the ACTION value, not eligibility) → invalid_action_intent', () =>
  assert.equal(code(ev(base({ actionIntent: 'acknowledge-readiness-review' }))), 'invalid_action_intent'));

// ==================== header reader ====================
test('readEligibilitySecurityInput reads lowercase header names + array-origin fails closed', () => {
  const ok = readEligibilitySecurityInput({ origin: 'https://app-abc.worf.replit.dev', 'sec-fetch-site': 'same-origin', [BCP_ELIGIBILITY_INTENT_HEADER]: BCP_ELIGIBILITY_INTENT_VALUE } as any, 'POST');
  assert.equal(ev(ok).ok, true);
  const arr = readEligibilitySecurityInput({ origin: ['https://a', 'https://b'], 'sec-fetch-site': 'same-origin', [BCP_ELIGIBILITY_INTENT_HEADER]: BCP_ELIGIBILITY_INTENT_VALUE } as any, 'POST');
  assert.equal(code(ev(arr)), 'origin_missing');
});

// ==================== bounded decision mapping (NO leak of role/permission/parity/cap/identity) ====================
const bodyKeys = (r: { body: any }) => Object.keys(r.body).sort().join(',');
test('authenticated + guard allow → 200 eligible', () => {
  const r = eligibilityDecision({ outcome: 'authenticated', principal: {} as any, internalUserId: 'x' } as any, true);
  assert.deepEqual(r, { httpStatus: 200, body: { eligible: true, status: 'eligible' } });
});
test('authenticated + guard deny → 200 not_authorized (no internals)', () => {
  const r = eligibilityDecision({ outcome: 'authenticated', principal: {} as any, internalUserId: 'x' } as any, false);
  assert.deepEqual(r, { httpStatus: 200, body: { eligible: false, status: 'not_authorized' } });
  assert.equal(bodyKeys(r), 'eligible,status');
});
test('unmapped (authenticated token, no identity) → 200 not_authorized', () => {
  const r = eligibilityDecision({ outcome: 'unmapped' } as any, null);
  assert.deepEqual(r, { httpStatus: 200, body: { eligible: false, status: 'not_authorized' } });
});
test('auth_failed (present-but-invalid) → 401 authentication_invalid', () => {
  const r = eligibilityDecision({ outcome: 'auth_failed', authCode: 'authentication_invalid' } as any, null);
  assert.deepEqual(r, { httpStatus: 401, body: { eligible: false, status: 'authentication_invalid' } });
});
test('auth_failed authentication_unavailable → 503 unavailable (service failure, fail closed)', () => {
  const r = eligibilityDecision({ outcome: 'auth_failed', authCode: 'authentication_unavailable' } as any, null);
  assert.deepEqual(r, { httpStatus: 503, body: { eligible: false, status: 'unavailable' } });
});
test('resolver_error → 503 unavailable (sanitized fail closed)', () => {
  const r = eligibilityDecision({ outcome: 'resolver_error' } as any, null);
  assert.deepEqual(r, { httpStatus: 503, body: { eligible: false, status: 'unavailable' } });
});

(async () => {
  let p = 0; const f: string[] = [];
  for (const c of cases) { try { c.fn(); p++; } catch (e) { f.push(c.name + ' :: ' + (e instanceof Error ? e.message : String(e))); } }
  console.log(`\n[P3.0 M3 bcpActionEligibility] ${p}/${cases.length} passed`);
  if (f.length) { console.log('FAILURES:'); for (const x of f) console.log('  - ' + x); process.exit(1); }
  console.log('ALL_TESTS_PASSED'); process.exit(0);
})();
