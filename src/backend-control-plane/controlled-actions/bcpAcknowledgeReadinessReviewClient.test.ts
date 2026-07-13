// Phase 3.0 M3 — pure-logic tests for the DEV-only controlled-action browser client + state helpers.
// No DOM, no real Firebase, no network: fetch + token provider are injected. Proves: Bearer + intent header +
// JSON body shape (only confirm/reason/idempotencyKey/lensKey — never actor/uid/role/etc.), Web-Crypto
// idempotency keys, one opaque key per dialog attempt (reused across all submits), full sanitized response classification, and that
// the raw token is never returned/retained. Run via `npx tsx`.
import assert from 'node:assert/strict';
import {
  classifyAckResponse,
  newIdempotencyKey,
  newIdempotencyAttempt,
  resolveAttemptKey,
  validateReasonForSubmit,
  describeAckResult,
  submitAcknowledgeReadinessReview,
  ACK_ACTION_URL,
  ACTION_INTENT_HEADER,
  ACTION_INTENT_VALUE,
  REASON_MIN,
  REASON_MAX,
  classifyEligibilityResponse,
  checkAcknowledgeEligibility,
  ELIGIBILITY_ACTION_URL,
  ELIGIBILITY_INTENT_VALUE,
  type AckClientResult,
} from './bcpAcknowledgeReadinessReviewClient';

const cases: { name: string; fn: () => Promise<void> | void }[] = [];
const test = (n: string, fn: () => Promise<void> | void) => cases.push({ name: n, fn });

// ---------- response classification (pure) ----------
test('200 success → success (carries correlationKey + lensKey)', () => {
  const r = classifyAckResponse(200, { status: 'success', correlationKey: 'k1', lensKey: 'ALL' });
  assert.equal(r.kind, 'success'); assert.equal((r as any).correlationKey, 'k1'); assert.equal((r as any).lensKey, 'ALL');
});
test('200 duplicate → duplicate', () => assert.equal(classifyAckResponse(200, { status: 'duplicate' }).kind, 'duplicate'));
test('400 → invalid (code surfaced)', () => {
  const r = classifyAckResponse(400, { status: 'invalid', code: 'reason_too_long' });
  assert.equal(r.kind, 'invalid'); assert.equal((r as any).code, 'reason_too_long');
});
test('401 → auth_required', () => assert.equal(classifyAckResponse(401, { status: 'unauthenticated' }).kind, 'auth_required'));
test('403 request_denied → request_denied', () => assert.equal(classifyAckResponse(403, { status: 'request_denied' }).kind, 'request_denied'));
test('403 not_authorized → forbidden', () => assert.equal(classifyAckResponse(403, { status: 'not_authorized' }).kind, 'forbidden'));
test('409 → conflict', () => assert.equal(classifyAckResponse(409, { status: 'idempotency_conflict' }).kind, 'conflict'));
test('429 → rate_limited (retry-after parsed)', () => {
  const r = classifyAckResponse(429, { status: 'rate_limited' }, '30');
  assert.equal(r.kind, 'rate_limited'); assert.equal((r as any).retryAfterSeconds, 30);
});
test('503 → unavailable (retryable)', () => {
  const r = classifyAckResponse(503, { status: 'unavailable' });
  assert.equal(r.kind, 'unavailable'); assert.equal((r as any).retryable, true);
});
test('404 (flag off / dev-only) → unavailable (NOT a generic error)', () => {
  const r = classifyAckResponse(404, { status: 'unavailable', reason: 'feature_disabled' });
  assert.equal(r.kind, 'unavailable'); assert.equal((r as any).retryable, false);
});
test('500/unknown → error', () => assert.equal(classifyAckResponse(500, { status: 'error' }).kind, 'error'));
test('null body → error (no throw)', () => assert.equal(classifyAckResponse(500, null).kind, 'error'));

// ---------- idempotency key ----------
test('newIdempotencyKey matches the server key format and is unique', () => {
  const re = /^[A-Za-z0-9._-]{8,80}$/;
  const a = newIdempotencyKey(); const b = newIdempotencyKey();
  assert.match(a, re); assert.match(b, re); assert.notEqual(a, b);
});
// One OPAQUE key per open-dialog attempt, reused for EVERY submit in that attempt and INDEPENDENT of the
// payload (the server decides duplicate-vs-conflict from its own fingerprint). A new attempt mints a fresh key.
test('one dialog attempt yields exactly one key, reused across unchanged repeat submissions', () => {
  let minted = 0;
  const mint = () => `ik-${++minted}`;
  const attempt0 = newIdempotencyAttempt();
  assert.equal(attempt0.key, null, 'a fresh attempt holds no key until the first submit');
  const s1 = resolveAttemptKey(attempt0, mint);   // first submit
  const s2 = resolveAttemptKey(s1.attempt, mint); // immediate unchanged repeat
  const s3 = resolveAttemptKey(s2.attempt, mint); // another unchanged repeat
  assert.equal(s1.key, s2.key, 'unchanged repeat reuses the same key');
  assert.equal(s2.key, s3.key, 'every repeat in the attempt reuses the same key');
  assert.equal(minted, 1, 'the key is minted exactly once per attempt');
});
test('a changed payload within the SAME attempt retains the key (→ server conflict, not a new success)', () => {
  // resolveAttemptKey is payload-INDEPENDENT: the caller changing lens/reason does not change the key, so the
  // server sees the same key with a different fingerprint and returns 409 conflict (never a second success).
  let minted = 0;
  const mint = () => `ik-${++minted}`;
  const s1 = resolveAttemptKey(newIdempotencyAttempt(), mint);
  const s2 = resolveAttemptKey(s1.attempt, mint); // caller submits a CHANGED payload with the same attempt
  assert.equal(s2.key, s1.key, 'a changed-payload submit within the attempt keeps the same key');
  assert.equal(minted, 1, 'no new key is minted for a changed payload in the same attempt');
});
test('a genuinely new dialog attempt mints a new key', () => {
  let minted = 0;
  const mint = () => `ik-${++minted}`;
  const a = resolveAttemptKey(newIdempotencyAttempt(), mint);
  const b = resolveAttemptKey(newIdempotencyAttempt(), mint); // reopened dialog → fresh attempt
  assert.notEqual(b.key, a.key, 'a new attempt gets a distinct key');
  assert.equal(minted, 2, 'each new attempt mints its own key');
});
test('newIdempotencyAttempt + resolveAttemptKey use the real crypto minter to a server-valid key', () => {
  const re = /^[A-Za-z0-9._-]{8,80}$/;
  const { key } = resolveAttemptKey(newIdempotencyAttempt(), newIdempotencyKey);
  assert.match(key, re, 'the attempt key matches the server key format');
});

// ---------- reason presentation validation ----------
test('validateReasonForSubmit enforces the shared bounds + charset (presentation only)', () => {
  assert.equal(validateReasonForSubmit('ok').ok, false);            // < MIN
  assert.equal(validateReasonForSubmit('a'.repeat(REASON_MAX + 1)).ok, false); // > MAX
  assert.equal(validateReasonForSubmit('Reviewed the readiness lens.').ok, true);
  // mirrors the server charset: chars the server rejects fail client-side too (no false-accept)
  assert.equal(validateReasonForSubmit('why not?! 🚀').ok, false);
  assert.equal(validateReasonForSubmit('see http://x').ok, true); // charset ok here; server rejects '://' separately
  assert.ok(REASON_MIN >= 1 && REASON_MAX > REASON_MIN);
});

// ---------- display mapping (no color-only: every state has a distinct title + tone) ----------
test('describeAckResult gives a distinct tone+title for each state', () => {
  const kinds: AckClientResult[] = [
    { kind: 'success' }, { kind: 'duplicate' }, { kind: 'invalid' }, { kind: 'auth_required' },
    { kind: 'forbidden' }, { kind: 'request_denied' }, { kind: 'conflict' },
    { kind: 'rate_limited' }, { kind: 'unavailable' }, { kind: 'error' },
  ];
  const titles = new Set<string>();
  for (const k of kinds) {
    const d = describeAckResult(k);
    assert.ok(['success', 'info', 'warning', 'error'].includes(d.tone));
    assert.ok(d.title.length > 0 && d.detail.length > 0);
    titles.add(d.title);
  }
  assert.equal(titles.size, kinds.length, 'each state has a distinct title (not color-only)');
});
test('duplicate maps to the visible "Already acknowledged"; success maps only to "Acknowledged"', () => {
  assert.equal(describeAckResult({ kind: 'duplicate' }).title, 'Already acknowledged');
  assert.equal(describeAckResult({ kind: 'success' }).title, 'Acknowledged');
  assert.notEqual(describeAckResult({ kind: 'duplicate' }).title, describeAckResult({ kind: 'success' }).title);
});

// ---------- submit (injected fetch + token) ----------
function fakeRes(status: number, body: unknown, retryAfter?: string) {
  return { status, headers: { get: (k: string) => (k.toLowerCase() === 'retry-after' ? retryAfter ?? null : null) }, json: async () => body } as any;
}

test('submit sends POST + Bearer + intent header + closed JSON body (no identity fields)', async () => {
  let captured: any = null;
  const fetchImpl = (async (url: string, init: any) => { captured = { url, init }; return fakeRes(200, { status: 'success', correlationKey: 'k' }); }) as any;
  const r = await submitAcknowledgeReadinessReview(
    { lensKey: 'C-07', reason: 'Reviewed readiness.', idempotencyKey: 'ack-key-0001' },
    { fetchImpl, getToken: async () => 'TOKEN123' },
  );
  assert.equal(r.kind, 'success');
  assert.equal(captured.url, ACK_ACTION_URL);
  assert.equal(captured.init.method, 'POST');
  assert.equal(captured.init.credentials, 'omit');
  assert.equal(captured.init.headers.authorization, 'Bearer TOKEN123');
  assert.equal(captured.init.headers[ACTION_INTENT_HEADER.toLowerCase()] ?? captured.init.headers[ACTION_INTENT_HEADER], ACTION_INTENT_VALUE);
  const sent = JSON.parse(captured.init.body);
  assert.deepEqual(Object.keys(sent).sort(), ['confirm', 'idempotencyKey', 'lensKey', 'reason']);
  assert.equal(sent.confirm, true);
  for (const forbidden of ['actor', 'uid', 'internalUserId', 'email', 'role', 'visibilityClass', 'permission', 'parity']) {
    assert.ok(!(forbidden in sent), `body must not carry ${forbidden}`);
  }
});
test('submit with no signed-in user (token null) → auth_required, fetch NOT called', async () => {
  let called = false;
  const fetchImpl = (async () => { called = true; return fakeRes(200, {}); }) as any;
  const r = await submitAcknowledgeReadinessReview({ lensKey: 'ALL', reason: 'x', idempotencyKey: 'ack-key-0001' }, { fetchImpl, getToken: async () => null });
  assert.equal(r.kind, 'auth_required'); assert.equal(called, false);
});
test('submit when token provider throws → auth_required (no leak)', async () => {
  const fetchImpl = (async () => fakeRes(200, {})) as any;
  const r = await submitAcknowledgeReadinessReview({ lensKey: 'ALL', reason: 'x', idempotencyKey: 'ack-key-0001' }, { fetchImpl, getToken: async () => { throw new Error('firebase down'); } });
  assert.equal(r.kind, 'auth_required');
});
test('submit on network throw → unavailable (no throw)', async () => {
  const fetchImpl = (async () => { throw new Error('network'); }) as any;
  const r = await submitAcknowledgeReadinessReview({ lensKey: 'ALL', reason: 'x', idempotencyKey: 'ack-key-0001' }, { fetchImpl, getToken: async () => 'T' });
  assert.equal(r.kind, 'unavailable');
});
test('submit maps a 429 with Retry-After to rate_limited', async () => {
  const fetchImpl = (async () => fakeRes(429, { status: 'rate_limited' }, '42')) as any;
  const r = await submitAcknowledgeReadinessReview({ lensKey: 'ALL', reason: 'x', idempotencyKey: 'ack-key-0001' }, { fetchImpl, getToken: async () => 'T' });
  assert.equal(r.kind, 'rate_limited'); assert.equal((r as any).retryAfterSeconds, 42);
});
test('client result never contains the raw token', async () => {
  const fetchImpl = (async () => fakeRes(200, { status: 'success' })) as any;
  const r = await submitAcknowledgeReadinessReview({ lensKey: 'ALL', reason: 'x', idempotencyKey: 'ack-key-0001' }, { fetchImpl, getToken: async () => 'SUPERSECRET-TOKEN' });
  assert.ok(!JSON.stringify(r).includes('SUPERSECRET-TOKEN'));
});
test('ACK_ACTION_URL is the same-origin proxy path', () => {
  assert.equal(ACK_ACTION_URL, '/__identity/dev/bcp/actions/acknowledge-readiness-review');
});

// ---------- eligibility classification (pure, fail-closed) ----------
test('eligibility 200 eligible → eligible', () => assert.equal(classifyEligibilityResponse(200, { eligible: true, status: 'eligible' }), 'eligible'));
test('eligibility 200 not_authorized → not_authorized', () => assert.equal(classifyEligibilityResponse(200, { eligible: false, status: 'not_authorized' }), 'not_authorized'));
test('eligibility 200 eligible:false + status eligible → not_authorized (both required)', () => assert.equal(classifyEligibilityResponse(200, { eligible: false, status: 'eligible' }), 'not_authorized'));
test('eligibility 200 malformed/null body → not_authorized (fail closed)', () => assert.equal(classifyEligibilityResponse(200, null), 'not_authorized'));
test('eligibility 401 → authentication_required', () => assert.equal(classifyEligibilityResponse(401, { status: 'authentication_invalid' }), 'authentication_required'));
test('eligibility 404 → unavailable', () => assert.equal(classifyEligibilityResponse(404, { status: 'unavailable' }), 'unavailable'));
test('eligibility 403 → error (fail closed)', () => assert.equal(classifyEligibilityResponse(403, { status: 'request_denied' }), 'error'));
test('eligibility 429 → error', () => assert.equal(classifyEligibilityResponse(429, { status: 'rate_limited' }), 'error'));
test('eligibility 500 → error', () => assert.equal(classifyEligibilityResponse(500, { status: 'unavailable' }), 'error'));

// ---------- eligibility probe (injected fetch + token) ----------
test('eligibility probe sends bodyless POST + Bearer + dedicated intent + no-store + no Content-Type + no manual Origin', async () => {
  let captured: any = null;
  const fetchImpl = (async (url: string, init: any) => { captured = { url, init }; return fakeRes(200, { eligible: true, status: 'eligible' }); }) as any;
  const s = await checkAcknowledgeEligibility({ fetchImpl, getToken: async () => 'TOK' });
  assert.equal(s, 'eligible');
  assert.equal(captured.url, ELIGIBILITY_ACTION_URL);
  assert.equal(captured.init.method, 'POST'); // POST so the browser reliably supplies its protected Origin header
  assert.equal(captured.init.credentials, 'omit');
  assert.equal(captured.init.cache, 'no-store'); // response must not be cached
  assert.equal(captured.init.headers.authorization, 'Bearer TOK');
  assert.equal(captured.init.headers[ACTION_INTENT_HEADER] ?? captured.init.headers[ACTION_INTENT_HEADER.toLowerCase()], ELIGIBILITY_INTENT_VALUE);
  assert.ok(!('body' in captured.init), 'eligibility probe sends no request body');
  // No Content-Type (no body) and NEVER a manually-set Origin (forbidden header — the browser supplies it).
  const hk = Object.keys(captured.init.headers).map((k) => k.toLowerCase());
  assert.ok(!hk.includes('content-type'), 'no Content-Type on a bodyless probe');
  assert.ok(!hk.includes('origin'), 'must not set Origin manually (forbidden header)');
});
test('eligibility: no signed-in user (token null) → authentication_required, fetch NOT called', async () => {
  let called = false;
  const fetchImpl = (async () => { called = true; return fakeRes(200, {}); }) as any;
  const s = await checkAcknowledgeEligibility({ fetchImpl, getToken: async () => null });
  assert.equal(s, 'authentication_required'); assert.equal(called, false);
});
test('eligibility: token provider throws → authentication_required', async () => {
  const fetchImpl = (async () => fakeRes(200, {})) as any;
  const s = await checkAcknowledgeEligibility({ fetchImpl, getToken: async () => { throw new Error('down'); } });
  assert.equal(s, 'authentication_required');
});
test('eligibility: network throw → error (fail closed, no throw)', async () => {
  const fetchImpl = (async () => { throw new Error('net'); }) as any;
  const s = await checkAcknowledgeEligibility({ fetchImpl, getToken: async () => 'T' });
  assert.equal(s, 'error');
});
test('eligibility: Firestore system_owner hint + canonical server DENIAL → not_authorized (server wins)', async () => {
  const fetchImpl = (async () => fakeRes(200, { eligible: false, status: 'not_authorized' })) as any;
  const s = await checkAcknowledgeEligibility({ fetchImpl, getToken: async () => 'T' });
  assert.equal(s, 'not_authorized');
});
test('eligibility result is a bounded state string that never contains the raw token', async () => {
  const fetchImpl = (async () => fakeRes(200, { eligible: true, status: 'eligible' })) as any;
  const s = await checkAcknowledgeEligibility({ fetchImpl, getToken: async () => 'SUPERSECRET-ELIG-TOKEN' });
  assert.ok(!JSON.stringify(s).includes('SUPERSECRET-ELIG-TOKEN'));
  assert.equal(typeof s, 'string');
});
test('ELIGIBILITY_ACTION_URL is the same-origin eligibility proxy path; intent value is dedicated + distinct', () => {
  assert.equal(ELIGIBILITY_ACTION_URL, '/__identity/dev/bcp/actions/acknowledge-readiness-review/eligibility');
  assert.equal(ELIGIBILITY_INTENT_VALUE, 'acknowledge-readiness-review-eligibility');
  assert.notEqual(ELIGIBILITY_INTENT_VALUE, ACTION_INTENT_VALUE);
});

(async () => {
  let p = 0; const f: string[] = [];
  for (const c of cases) { try { await c.fn(); p++; } catch (e) { f.push(c.name + ' :: ' + (e instanceof Error ? e.message : String(e))); } }
  console.log(`\n[P3.0 M3 bcpAcknowledgeReadinessReviewClient] ${p}/${cases.length} passed`);
  if (f.length) { console.log('FAILURES:'); for (const x of f) console.log('  - ' + x); process.exit(1); }
  console.log('ALL_TESTS_PASSED'); process.exit(0);
})();
