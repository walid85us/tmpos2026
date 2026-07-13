// Phase 3.0 M3 — focused tests for the DEV-only controlled-action request-security / same-origin / CSRF guard.
// PURE header evaluation + trusted-origin resolution (no network, no auth, no DB). Run via `npx tsx`. Proves:
// POST-only, JSON-only, the exact custom action-intent header, Fetch-Metadata cross-site rejection, and — the
// M3 CORRECTION — EXACT trusted-origin enforcement against an injectable trusted origin resolved from
// REPLIT_DEV_DOMAIN (never suffix/substring/prefix/endsWith; never reflected; never wildcard; fail-closed when
// the trusted origin cannot be resolved).
import assert from 'node:assert/strict';
import {
  evaluateRequestSecurity,
  readRequestSecurityInput,
  resolveTrustedOrigin,
  BCP_ACTION_INTENT_HEADER,
  BCP_ACTION_INTENT_VALUE,
  type RequestSecurityInput,
  type TrustedOriginResolution,
} from './bcpActionRequestSecurityGuard';

const cases: { name: string; fn: () => void }[] = [];
const test = (n: string, fn: () => void) => cases.push({ name: n, fn });

const TRUSTED: TrustedOriginResolution = { ok: true, origin: 'https://app-abc.worf.replit.dev' };
const base = (o: Partial<RequestSecurityInput> = {}): RequestSecurityInput => ({
  method: 'POST',
  contentType: 'application/json',
  origin: 'https://app-abc.worf.replit.dev',
  secFetchSite: 'same-origin',
  actionIntent: BCP_ACTION_INTENT_VALUE,
  ...o,
});
const ev = (i: RequestSecurityInput, t: TrustedOriginResolution = TRUSTED) => evaluateRequestSecurity(i, t);
const code = (r: ReturnType<typeof ev>) => (r as any).code;

// ==================== resolveTrustedOrigin (REPLIT_DEV_DOMAIN normalization) ====================
test('resolveTrustedOrigin: hostname-only → https://<host> (§4.2)', () => {
  const r = resolveTrustedOrigin('app-abc.worf.replit.dev');
  assert.equal(r.ok, true); assert.equal(r.origin, 'https://app-abc.worf.replit.dev');
});
test('resolveTrustedOrigin: absolute URL → normalized origin (§4.3)', () => {
  const r = resolveTrustedOrigin('https://app-abc.worf.replit.dev');
  assert.equal(r.ok, true); assert.equal(r.origin, 'https://app-abc.worf.replit.dev');
});
test('resolveTrustedOrigin: absolute URL with trailing slash → origin (no path)', () => {
  assert.equal(resolveTrustedOrigin('https://app-abc.worf.replit.dev/').origin, 'https://app-abc.worf.replit.dev');
});
test('resolveTrustedOrigin: undefined → fail closed (§4.4)', () => assert.equal(resolveTrustedOrigin(undefined).ok, false));
test('resolveTrustedOrigin: empty → fail closed', () => assert.equal(resolveTrustedOrigin('').ok, false));
test('resolveTrustedOrigin: comma-separated (ambiguous) → fail closed (§4.5)', () =>
  assert.equal(resolveTrustedOrigin('a.replit.dev,b.replit.dev').ok, false));
test('resolveTrustedOrigin: whitespace (ambiguous) → fail closed', () =>
  assert.equal(resolveTrustedOrigin('a.replit.dev b.replit.dev').ok, false));
test('resolveTrustedOrigin: userinfo → fail closed', () => assert.equal(resolveTrustedOrigin('https://u:p@app.replit.dev').ok, false));
test('resolveTrustedOrigin: path → fail closed', () => assert.equal(resolveTrustedOrigin('app.replit.dev/x').ok, false));
test('resolveTrustedOrigin: non-http scheme → fail closed', () => assert.equal(resolveTrustedOrigin('ftp://app.replit.dev').ok, false));
test('resolveTrustedOrigin: extra-slash malformed absolute → fail closed (not canonicalize-and-accept)', () => {
  assert.equal(resolveTrustedOrigin('https:////app.replit.dev').ok, false);
  assert.equal(resolveTrustedOrigin('https:/app.replit.dev').ok, false);
});
test('resolveTrustedOrigin: bare hostname with an embedded slash → fail closed', () =>
  assert.equal(resolveTrustedOrigin('app.replit.dev/x').ok, false));

// ==================== happy path ====================
test('exact matching HTTPS Replit dev origin accepted (§4.1, §4.22)', () => assert.equal(ev(base()).ok, true));
test('application/json; charset=utf-8 accepted', () => assert.equal(ev(base({ contentType: 'application/json; charset=utf-8' })).ok, true));

// ==================== trusted-origin unavailable → fail closed ====================
test('trusted origin unavailable → trusted_origin_unavailable (§3.11)', () => {
  assert.equal(code(ev(base(), { ok: false })), 'trusted_origin_unavailable');
});

// ==================== request Origin required + exact match ====================
test('missing request Origin → origin_missing (§4.6)', () => assert.equal(code(ev(base({ origin: undefined }))), 'origin_missing'));
test('exact mismatch → origin_mismatch (§4.7)', () => assert.equal(code(ev(base({ origin: 'https://evil.example' }))), 'origin_mismatch'));
test('http instead of https → origin_mismatch (§4.8)', () => assert.equal(code(ev(base({ origin: 'http://app-abc.worf.replit.dev' }))), 'origin_mismatch'));
test('wrong port → origin_mismatch (§4.9)', () => assert.equal(code(ev(base({ origin: 'https://app-abc.worf.replit.dev:8443' }))), 'origin_mismatch'));
test('sibling subdomain → origin_mismatch (§4.10)', () => assert.equal(code(ev(base({ origin: 'https://app-xyz.worf.replit.dev' }))), 'origin_mismatch'));
test('hostname-PREFIX attack (trusted host is a prefix) → origin_mismatch (§4.11)', () =>
  assert.equal(code(ev(base({ origin: 'https://app-abc.worf.replit.dev.attacker.com' }))), 'origin_mismatch'));
test('hostname-SUFFIX attack (trusted host is a suffix) → origin_mismatch (§4.12)', () =>
  assert.equal(code(ev(base({ origin: 'https://evil-app-abc.worf.replit.dev' }))), 'origin_mismatch'));

// ==================== malformed Origin variants ====================
test('user-info/credential Origin → malformed_origin (§4.13)', () => assert.equal(code(ev(base({ origin: 'https://u:p@app-abc.worf.replit.dev' }))), 'malformed_origin'));
test('Origin with path → malformed_origin (§4.14a)', () => assert.equal(code(ev(base({ origin: 'https://app-abc.worf.replit.dev/evil' }))), 'malformed_origin'));
test('Origin with query → malformed_origin (§4.14b)', () => assert.equal(code(ev(base({ origin: 'https://app-abc.worf.replit.dev?x=1' }))), 'malformed_origin'));
test('Origin with fragment → malformed_origin (§4.14c)', () => assert.equal(code(ev(base({ origin: 'https://app-abc.worf.replit.dev#f' }))), 'malformed_origin'));
test('Origin "null" (opaque) → malformed_origin (§4.15)', () => assert.equal(code(ev(base({ origin: 'null' }))), 'malformed_origin'));
test('Origin "*" wildcard → malformed_origin', () => assert.equal(code(ev(base({ origin: '*' }))), 'malformed_origin'));
test('comma-separated single Origin string → malformed_origin (§4.16)', () => assert.equal(code(ev(base({ origin: 'https://app-abc.worf.replit.dev, https://evil.example' }))), 'malformed_origin'));

// ==================== retained defenses ====================
test('Sec-Fetch-Site: cross-site → cross_site (§4.17)', () => assert.equal(code(ev(base({ secFetchSite: 'cross-site' }))), 'cross_site'));
test('missing action-intent → missing_action_intent (§4.18a)', () => assert.equal(code(ev(base({ actionIntent: undefined }))), 'missing_action_intent'));
test('wrong action-intent → invalid_action_intent (§4.18b)', () => assert.equal(code(ev(base({ actionIntent: 'x' }))), 'invalid_action_intent'));
test('missing content-type → unsupported_media_type (§4.19a)', () => assert.equal(code(ev(base({ contentType: undefined }))), 'unsupported_media_type'));
test('text/plain → unsupported_media_type (§4.19b)', () => assert.equal(code(ev(base({ contentType: 'text/plain' }))), 'unsupported_media_type'));
test('application/json-malformed (prefix not exact) → unsupported_media_type', () => assert.equal(code(ev(base({ contentType: 'application/json-malformed' }))), 'unsupported_media_type'));
test('non-POST → method_not_allowed', () => assert.equal(code(ev(base({ method: 'GET' }))), 'method_not_allowed'));

// ==================== header reader ====================
test('readRequestSecurityInput reads exact lowercase header names', () => {
  const inp = readRequestSecurityInput({
    'content-type': 'application/json', origin: 'https://app-abc.worf.replit.dev',
    'sec-fetch-site': 'same-origin', [BCP_ACTION_INTENT_HEADER]: BCP_ACTION_INTENT_VALUE,
  } as any, 'POST');
  assert.equal(ev(inp).ok, true);
});
test('array-valued Origin header → treated as missing (fail closed) → origin_missing', () => {
  const inp = readRequestSecurityInput({ 'content-type': 'application/json', origin: ['https://a', 'https://b'], 'sec-fetch-site': 'same-origin', [BCP_ACTION_INTENT_HEADER]: BCP_ACTION_INTENT_VALUE } as any, 'POST');
  assert.equal(code(ev(inp)), 'origin_missing');
});

(async () => {
  let p = 0; const f: string[] = [];
  for (const c of cases) { try { c.fn(); p++; } catch (e) { f.push(c.name + ' :: ' + (e instanceof Error ? e.message : String(e))); } }
  console.log(`\n[P3.0 M3 bcpActionRequestSecurityGuard] ${p}/${cases.length} passed`);
  if (f.length) { console.log('FAILURES:'); for (const x of f) console.log('  - ' + x); process.exit(1); }
  console.log('ALL_TESTS_PASSED'); process.exit(0);
})();
