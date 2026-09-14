// Phase 4.0 M6 — durable idempotency: the key grammar, keyed identity and sealing, strict answers,
// the store conformance suite with positive controls, and the chain over real loopback sockets.
//
// Synthetic keys, principals and stores only. The conformance suite runs against the test-only
// in-memory store and a correct shared-store adapter over two instances, and fails each broken
// adapter it exists to catch. The socket half drives createApp with synthetic idempotency-required
// routes (never in the production table) and records exactly what crosses the store port.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { createApp, createBoundedServer, createReadinessState } from './app.js';
import type { AppDeps } from './app.js';
import {
  IDEMPOTENCY_DEADLINE_MS, IDEMPOTENCY_POLICY, MAX_REPLAY_BODY_BYTES, MAX_SEALED_LENGTH, REPLAY_CONTENT_TYPE,
  acquireIdempotency, completeIdempotency, createIdempotency, createIdempotencyKeyring, envelopeFromOutcome, readIdempotencyKey,
} from './idempotency.js';
import type { DurableIdempotencyStore, IdempotencyAcquireRequest, IdempotencyCompleteRequest, ReplayEnvelope } from './idempotency.js';
import { CSRF_HEADER, CSRF_HEADER_VALUE } from './requestSecurity.js';
import { EnforcementSetupError } from './routes.js';
import type { IdempotentContext, IdempotentOperation, RouteDefinition, VerifiedPrincipal } from './routes.js';
import { SECURITY_HEADERS } from './securityHeaders.js';
import { TEST_RATE_LIMIT_KEY, testRequestLimits } from './rateLimiter.testkit.js';
import {
  TEST_IDEMPOTENCY_KEY, assertIdempotencyStoreContract, createMemoryIdempotencyState, createMemoryIdempotencyStore, testIdempotency,
} from './idempotencyStore.testkit.js';
import type { IdempotencyStoreHarness } from './idempotencyStore.testkit.js';

const T0 = 1_700_000_000_000;
const uuid = (): string => randomUUID();
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// --- conformance -------------------------------------------------------------------------------

type Defect =
  | 'nonAtomic' | 'perInstanceMutex' | 'fingerprintBlind' | 'extendsLeaseOnRefusal' | 'extendsLeaseOnConflict' | 'extendsRetentionOnRefusal'
  | 'extendsRetentionOnReplay' | 'extendsRetentionOnComplete' | 'keepsRetentionOnReclaim' | 'anyLeaseCompletes' | 'overwritesCompleted'
  | 'reclaimsEarly' | 'neverReclaims' | 'reclaimsAnyFingerprint' | 'strictLeaseExpiry' | 'skewedPeerClock' | 'ignoresAbort' | 'failsOpen'
  | 'probesOpen' | 'losesState' | 'queuesOutage' | 'truncatesResponse';

interface Rec { fingerprint: string; lease: string; leaseExpiresAt: number; expiresAt: number; response: string | null }

/**
 * Two adapter instances over one shared record store, as over a remote store: an acquisition
 * reads, may wait on the network, then writes. With no defect it is atomic and in contract; each
 * defect breaks exactly one clause of the port contract.
 */
function storeHarness(defect: Defect | null): IdempotencyStoreHarness {
  const records = new Map<string, Rec>();
  const clock = { t: T0 };
  let broken = false;
  const queued: Array<() => void> = [];
  const acquireAt = async (r: IdempotencyAcquireRequest, t: number): Promise<unknown> => {
    const record = records.get(r.scope);
    if (defect === 'nonAtomic' || defect === 'perInstanceMutex') await new Promise((resolve) => setImmediate(resolve)); // the network gap
    if (record === undefined || t >= record.expiresAt) {
      records.set(r.scope, { fingerprint: r.fingerprint, lease: r.lease, leaseExpiresAt: t + r.leaseMs, expiresAt: t + r.retentionMs, response: null });
      return { outcome: 'acquired', reclaimed: false };
    }
    const expired = defect === 'reclaimsEarly' ? t >= record.leaseExpiresAt - 1 : t >= record.leaseExpiresAt;
    const reclaimsOther = defect === 'reclaimsAnyFingerprint' && expired && record.response === null;
    if (record.fingerprint !== r.fingerprint && defect !== 'fingerprintBlind' && !reclaimsOther) {
      if (defect === 'extendsLeaseOnConflict') records.set(r.scope, { ...record, leaseExpiresAt: t + r.leaseMs });
      return { outcome: 'conflict' };
    }
    if (record.response !== null) {
      if (defect === 'extendsRetentionOnReplay') records.set(r.scope, { ...record, expiresAt: t + r.retentionMs });
      return { outcome: 'replay', response: record.response };
    }
    if (!expired || defect === 'neverReclaims') {
      if (defect === 'extendsLeaseOnRefusal') records.set(r.scope, { ...record, leaseExpiresAt: t + r.leaseMs });
      if (defect === 'extendsRetentionOnRefusal') records.set(r.scope, { ...record, expiresAt: t + r.retentionMs });
      return { outcome: 'in_progress' };
    }
    const expiresAt = defect === 'keepsRetentionOnReclaim' ? record.expiresAt : t + r.retentionMs;
    records.set(r.scope, { ...record, fingerprint: r.fingerprint, lease: r.lease, leaseExpiresAt: t + r.leaseMs, expiresAt });
    return { outcome: 'acquired', reclaimed: true };
  };
  const completeAt = (r: IdempotencyCompleteRequest, t: number): unknown => {
    const record = records.get(r.scope);
    if (record === undefined || t >= record.expiresAt || (record.response !== null && defect !== 'overwritesCompleted')
      || (record.lease !== r.lease && defect !== 'anyLeaseCompletes') || (defect === 'strictLeaseExpiry' && t >= record.leaseExpiresAt)) {
      return { outcome: 'lease_lost' };
    }
    const response = defect === 'truncatesResponse' ? r.response.slice(0, 1_024) : r.response;
    records.set(r.scope, { ...record, response, expiresAt: defect === 'extendsRetentionOnComplete' ? t + 600_000 : record.expiresAt });
    return { outcome: 'completed' };
  };
  const instance = (skew: number): DurableIdempotencyStore => {
    let queue: Promise<unknown> = Promise.resolve(); // this instance's own lock
    return {
      acquire: (r: IdempotencyAcquireRequest, signal: AbortSignal) => {
        if (broken) return defect === 'failsOpen' ? { outcome: 'acquired', reclaimed: false } : { outcome: 'unavailable' };
        if (signal.aborted && defect !== 'ignoresAbort') return { outcome: 'unavailable' };
        if (defect !== 'perInstanceMutex') return acquireAt(r, clock.t + skew);
        const run = queue.then(() => acquireAt(r, clock.t + skew));
        queue = run.catch(() => undefined);
        return run;
      },
      complete: (r: IdempotencyCompleteRequest, signal: AbortSignal) => {
        if (broken) {
          if (defect === 'queuesOutage') queued.push(() => { completeAt(r, clock.t + skew); });
          return { outcome: 'unavailable' };
        }
        return signal.aborted ? { outcome: 'unavailable' } : completeAt(r, clock.t + skew);
      },
      probe: () => defect === 'probesOpen' || !broken,
    };
  };
  return {
    store: instance(0),
    peer: instance(defect === 'skewedPeerClock' ? 1_000 : 0),
    advance: (ms) => { clock.t += ms; },
    breakStore: () => { broken = true; },
    restoreStore: () => {
      broken = false;
      if (defect === 'losesState') records.clear();
      for (const run of queued.splice(0)) run();
    },
  };
}

test('the in-memory test store meets the port contract every durable adapter must meet', async () => {
  let t = T0;
  let broken = false;
  const state = createMemoryIdempotencyState({ now: () => t });
  // Two adapter objects over one process-local state: the only kind of peer the in-memory store has.
  const instance = (): DurableIdempotencyStore => {
    const inner = createMemoryIdempotencyStore(state);
    return {
      acquire: (r: IdempotencyAcquireRequest, s: AbortSignal) => (broken ? { outcome: 'unavailable' } : inner.acquire(r, s)),
      complete: (r: IdempotencyCompleteRequest, s: AbortSignal) => (broken ? { outcome: 'unavailable' } : inner.complete(r, s)),
      probe: (s: AbortSignal) => !broken && inner.probe(s),
    };
  };
  await assertIdempotencyStoreContract({
    store: instance(), peer: instance(), advance: (ms) => { t += ms; }, breakStore: () => { broken = true; }, restoreStore: () => { broken = false; },
  });
});

test('the conformance suite passes a correct shared-store adapter and fails every broken one', async () => {
  await assertIdempotencyStoreContract(storeHarness(null));
  const caught: Array<[Defect, RegExp]> = [
    ['nonAtomic', /exactly one concurrent caller acquires/],
    ['perInstanceMutex', /exactly one concurrent caller acquires/],
    ['fingerprintBlind', /another body under an operation in progress conflicts/],
    ['extendsLeaseOnRefusal', /a refused acquisition extended nothing/],
    ['extendsLeaseOnConflict', /a conflict extended nothing/],
    ['extendsRetentionOnRefusal', /no refusal extended it/],
    ['extendsRetentionOnReplay', /nor a replay extended the retention/],
    ['extendsRetentionOnComplete', /neither the completion nor a replay extended the retention/],
    ['keepsRetentionOnReclaim', /a reclaim restarted the retention/],
    ['anyLeaseCompletes', /the conflicting caller holds no lease/],
    ['overwritesCompleted', /never completed again, even by its holder/],
    ['reclaimsEarly', /the lease holds until it expires/],
    ['neverReclaims', /the caller reclaims explicitly/],
    ['reclaimsAnyFingerprint', /reclaimed only under its own binding/],
    ['strictLeaseExpiry', /an expired but unreclaimed lease still completes/],
    ['skewedPeerClock', /the lease holds until it expires/],
    ['ignoresAbort', /the aborted acquisition created nothing/],
    ['failsOpen', /an unreachable store acquires nothing/],
    ['probesOpen', /never answers the probe with true/],
    ['losesState', /kept its lease through the outage/],
    ['queuesOutage', /kept its lease through the outage/],
    ['truncatesResponse', /replays the stored response byte for byte/],
  ];
  for (const [defect, check] of caught) {
    await assert.rejects(assertIdempotencyStoreContract(storeHarness(defect)),
      (err: unknown) => err instanceof assert.AssertionError && check.test(err.message), defect);
  }
});

// --- the key, identity and sealing ------------------------------------------------------------

const headersWith = (...values: string[]): string[] => values.flatMap((value) => ['Idempotency-Key', value]);

test('the Idempotency-Key is one UUID version 4 in hyphenated hexadecimal form, case-insensitive and normalized', () => {
  const key = uuid();
  assert.deepEqual(readIdempotencyKey(['Host', 'x', ...headersWith(key)]), { key });
  assert.deepEqual(readIdempotencyKey(headersWith(key.toUpperCase())), { key }, 'hexadecimal is case-insensitive on input (RFC 9562)');
  assert.deepEqual(readIdempotencyKey(['idempotency-KEY', key]), { key }, 'so is the field name');
  assert.equal(readIdempotencyKey(['Host', 'x']), 'idempotency_key_missing');
  assert.equal(readIdempotencyKey(headersWith(key, key)), 'idempotency_key_duplicated', 'two lines, even identical ones');
  const [a, b, c, d, e] = key.split('-');
  for (const bad of [
    '', ' ', key.slice(0, 35), `${key}0`, ` ${key}`, `${key} `, `"${key}"`, `{${key}}`, `urn:uuid:${key}`, key.replace(/-/g, ''),
    `${a}-${b}-1${c.slice(1)}-${d}-${e}`, `${a}-${b}-7${c.slice(1)}-${d}-${e}`, `${a}-${b}-${c}-c${d.slice(1)}-${e}`,
    '00000000-0000-0000-0000-000000000000', `${key.slice(0, 35)}g`, `${key.slice(0, 20)}\t${key.slice(21)}`,
    `${key.slice(0, 20)} ${key.slice(21)}`, 'x'.repeat(4_096), `${key},${uuid()}`,
  ]) {
    assert.equal(readIdempotencyKey(headersWith(bad)), 'idempotency_key_invalid', JSON.stringify(bad.slice(0, 48)));
  }
});

const principal = (uid: string): VerifiedPrincipal => Object.freeze({ authProvider: 'synthetic', authProviderUid: uid });
const binding = (over: Record<string, unknown> = {}) => ({
  method: 'POST' as const, path: '/v1/items', audience: null, tenant: null, store: null, body: Buffer.from('{"n":1}'), ...over,
});

test('the scope binds the client key and the principal; the fingerprint binds everything the operation sees', () => {
  const keyring = createIdempotencyKeyring(TEST_IDEMPOTENCY_KEY);
  const key = uuid();
  const base = keyring.operationOf(key, principal('uid-a'), binding());
  for (const digest of [base.scope, base.fingerprint]) assert.match(digest, /^[A-Za-z0-9_-]{43}$/);
  assert.deepEqual(createIdempotencyKeyring(new Uint8Array(TEST_IDEMPOTENCY_KEY)).operationOf(key, principal('uid-a'), binding()), base,
    'deterministic on every instance holding the secret');
  for (const other of [uuid(), key.toUpperCase()]) assert.notEqual(keyring.operationOf(other, principal('uid-a'), binding()).scope, base.scope);
  for (const who of [principal('uid-b'), Object.freeze({ authProvider: 'other', authProviderUid: 'uid-a' })]) {
    assert.notEqual(keyring.operationOf(key, who, binding()).scope, base.scope, 'each principal has its own key namespace');
  }
  const seen = new Set([base.fingerprint]);
  for (const over of [
    { method: 'PUT' }, { path: '/v1/items/other' }, { audience: 'tenant' }, { audience: 'admin' }, { tenant: 'tenant-1' }, { store: 'tenant-1' },
    { body: Buffer.from('{"n":2}') }, { body: Buffer.from('{"n": 1}') }, { body: Buffer.alloc(0) },
  ]) {
    const moved = keyring.operationOf(key, principal('uid-a'), binding(over));
    assert.equal(moved.scope, base.scope, 'the binding never moves the record');
    assert.ok(!seen.has(moved.fingerprint), JSON.stringify(over));
    seen.add(moved.fingerprint);
  }
  const elsewhere = createIdempotencyKeyring(new Uint8Array(32).fill(1)).operationOf(key, principal('uid-a'), binding());
  assert.ok(elsewhere.scope !== base.scope && elsewhere.fingerprint !== base.fingerprint, 'no digest is a bare hash: both depend on the secret');
  const secret = new Uint8Array(32).fill(9);
  const copied = createIdempotencyKeyring(secret);
  const before = copied.operationOf(key, principal('uid-a'), binding());
  secret.fill(0);
  assert.deepEqual(copied.operationOf(key, principal('uid-a'), binding()), before, 'the keyring holds its own copy of the secret');
  for (const bad of [undefined, 'a'.repeat(64), new Uint8Array(31), new Uint8Array(65), [1, 2, 3]]) {
    assert.throws(() => createIdempotencyKeyring(bad), (e: unknown) => e instanceof EnforcementSetupError && e.code === 'idempotency_key_invalid');
  }
});

const ENVELOPE: ReplayEnvelope = Object.freeze({
  status: 201, contentType: REPLAY_CONTENT_TYPE, headers: Object.freeze({ location: '/v1/items/1' }), body: '{"id":1}',
});

test('a sealed response opens only for the operation and key it was sealed under, and only when still strictly valid', () => {
  const keyring = createIdempotencyKeyring(TEST_IDEMPOTENCY_KEY);
  const op = keyring.operationOf(uuid(), principal('uid-a'), binding());
  const sealed = keyring.seal(ENVELOPE, op);
  assert.ok(sealed.length <= MAX_SEALED_LENGTH && !sealed.includes('"id"'), 'the store sees ciphertext only');
  assert.deepEqual(keyring.unseal(sealed, op), ENVELOPE);
  const other = keyring.operationOf(uuid(), principal('uid-a'), binding());
  const flipped = `${sealed.slice(0, 20)}${sealed[20] === 'A' ? 'B' : 'A'}${sealed.slice(21)}`;
  for (const [label, token, operation] of [
    ['another scope', sealed, { ...op, scope: other.scope }], ['another fingerprint', sealed, { ...op, fingerprint: other.fingerprint }],
    ['an altered byte', flipped, op], ['a truncated token', sealed.slice(0, -4), op], ['not base64url', `${sealed}=`, op],
    ['over the length cap', 'A'.repeat(MAX_SEALED_LENGTH + 1), op], ['not a string', 7, op],
  ] as const) {
    assert.equal(keyring.unseal(token, operation), null, label);
  }
  assert.equal(createIdempotencyKeyring(new Uint8Array(32).fill(1)).unseal(sealed, op), null, 'another key');
  // An envelope that is no longer in contract is refused even when authentic.
  for (const [label, hostile] of [
    ['a 500', { ...ENVELOPE, status: 500 }], ['HTML', { ...ENVELOPE, contentType: 'text/html' }],
    ['Set-Cookie', { ...ENVELOPE, headers: { 'set-cookie': 'sid=1' } }], ['a protocol-relative Location', { ...ENVELOPE, headers: { location: '//evil.test' } }],
    ['a reserved error word', { ...ENVELOPE, status: 409, body: '{"error":"request_in_progress"}' }],
    ['an oversized body', { ...ENVELOPE, body: JSON.stringify('a'.repeat(MAX_REPLAY_BODY_BYTES)) }],
  ] as const) {
    assert.equal(keyring.unseal(keyring.seal(hostile as unknown as ReplayEnvelope, op), op), null, label);
  }
});

test('an outcome is retainable only with an approved status, a bounded JSON body, allowlisted headers and no reserved error word', () => {
  assert.deepEqual(envelopeFromOutcome({ status: 201, body: { id: 1 }, headers: { location: '/v1/items/1' } }), ENVELOPE);
  for (const status of [200, 201, 409, 422]) assert.equal(envelopeFromOutcome({ status, body: [1, 'two'] })?.body, '[1,"two"]', String(status));
  const atCap = 'a'.repeat(MAX_REPLAY_BODY_BYTES - 2);
  assert.equal(envelopeFromOutcome({ status: 200, body: atCap })?.body.length, MAX_REPLAY_BODY_BYTES, 'exactly at the cap');
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  for (const [label, outcome] of [
    ['a 500', { status: 500, body: {} }], ['a 503', { status: 503, body: {} }], ['a 204', { status: 204, body: {} }], ['a 202', { status: 202, body: {} }],
    ['a NaN', { status: 200, body: { amount: Number.NaN } }], ['an Infinity', { status: 200, body: [Number.POSITIVE_INFINITY] }],
    ['a nested undefined', { status: 200, body: { note: undefined } }], ['a nested function', { status: 200, body: { f: () => 1 } }],
    ['a symbol key', { status: 200, body: { [Symbol('s')]: 1 } }], ['a Date', { status: 200, body: new Date(0) }],
    ['a sparse array', { status: 200, body: [1, , 3] }], ['a Map', { status: 200, body: new Map() }],
    ['a 400', { status: 400, body: {} }], ['a redirect', { status: 302, body: {} }], ['a status string', { status: '200', body: {} }],
    ['no body', { status: 201 }], ['a function body', { status: 201, body: () => 1 }], ['a BigInt body', { status: 201, body: 1n }],
    ['a cyclic body', { status: 201, body: cyclic }], ['a throwing toJSON', { status: 201, body: { toJSON() { throw new Error('x'); } } }],
    ['one byte over the cap', { status: 200, body: `${atCap}a` }], ['Set-Cookie', { status: 201, body: {}, headers: { 'set-cookie': 'sid=1' } }],
    ['WWW-Authenticate', { status: 201, body: {}, headers: { 'www-authenticate': 'Bearer' } }], ['a trace header', { status: 201, body: {}, headers: { traceparent: '00' } }],
    ['a CSRF header', { status: 201, body: {}, headers: { 'x-csrf-token': 'x' } }], ['an absolute Location', { status: 201, body: {}, headers: { location: 'https://evil.test/' } }],
    ['a backslash Location', { status: 201, body: {}, headers: { location: '/\\evil.test' } }], ['a broken escape', { status: 201, body: {}, headers: { location: '/x%GG' } }],
    ['a Location with a line break', { status: 201, body: {}, headers: { location: '/x\r\nSet-Cookie: a=b' } }], ['null headers', { status: 201, body: {}, headers: null }],
    ['a reserved error word', { status: 422, body: { error: 'idempotency_key_reused' } }], ['an extra field', { status: 201, body: {}, cookie: 'x' }],
    ['not an object', 'ok'], ['an array', [201, {}]],
  ] as const) {
    assert.equal(envelopeFromOutcome(outcome), null, label);
  }
});

// --- strict answers ------------------------------------------------------------------------------

const idem = createIdempotency(testIdempotency());
const REQUEST: IdempotencyAcquireRequest = Object.freeze({
  ...idem.keyring.operationOf(uuid(), principal('uid-a'), binding()), lease: 'l'.repeat(43), ...IDEMPOTENCY_POLICY,
});
const withStore = (store: Partial<DurableIdempotencyStore>) => ({ ...idem, store: { acquire: () => ({}), complete: () => ({}), probe: () => true, ...store } });

test('only an exact, in-contract acquisition is obeyed; a replay only when it unseals for this operation', async () => {
  const verdictOf = (answer: () => unknown): Promise<unknown> => acquireIdempotency(withStore({ acquire: answer }), REQUEST, 1_000);
  assert.deepEqual(await verdictOf(() => ({ outcome: 'acquired', reclaimed: false })), { outcome: 'acquired', reclaimed: false });
  assert.deepEqual(await verdictOf(async () => ({ outcome: 'acquired', reclaimed: true })), { outcome: 'acquired', reclaimed: true });
  assert.deepEqual(await verdictOf(() => ({ outcome: 'replay', response: idem.keyring.seal(ENVELOPE, REQUEST) })), { outcome: 'replay', response: ENVELOPE });
  assert.equal(await verdictOf(() => ({ outcome: 'in_progress' })), 'idempotency_in_progress');
  assert.equal(await verdictOf(() => ({ outcome: 'conflict' })), 'idempotency_conflict');
  assert.equal(await verdictOf(() => ({ outcome: 'unavailable' })), 'idempotency_unavailable');
  assert.equal(await verdictOf(() => { throw new Error('store-secret-detail'); }), 'idempotency_unavailable');
  assert.equal(await verdictOf(() => Promise.reject(new Error('store-secret-detail'))), 'idempotency_unavailable');
  const other = idem.keyring.operationOf(uuid(), principal('uid-b'), binding());
  for (const [i, answer] of [
    { outcome: 'acquired' }, { outcome: 'acquired', reclaimed: 'false' }, { outcome: 'Acquired', reclaimed: false }, { outcome: 'completed' },
    { outcome: 'acquired', reclaimed: false, error: 'write_failed' }, { outcome: 'conflict', detail: 'x' }, { outcome: 'in_progress', until: 1 },
    { outcome: 'replay' }, { outcome: 'replay', response: idem.keyring.seal(ENVELOPE, other) }, { outcome: 'replay', response: ENVELOPE },
    undefined, null, 'acquired', true, 7, Object.assign([], { outcome: 'conflict' }), Object.create({ outcome: 'conflict' }),
    new Proxy({}, { get: (_target, name) => { if (name === 'then') return undefined; throw new Error('hostile'); } }),
  ].entries()) {
    assert.equal(await verdictOf(() => answer), 'idempotency_outcome_invalid', `out-of-contract answer #${i}`);
  }
});

test('only an exact completion completes; a lost lease, an outage or anything else is reported for what it is', async () => {
  const request: IdempotencyCompleteRequest = Object.freeze({ scope: REQUEST.scope, lease: REQUEST.lease, response: 'sealed' });
  const verdictOf = (answer: () => unknown): Promise<unknown> => completeIdempotency(withStore({ complete: answer }), request, 1_000);
  assert.equal(await verdictOf(() => ({ outcome: 'completed' })), null);
  assert.equal(await verdictOf(() => ({ outcome: 'lease_lost' })), 'idempotency_lease_lost');
  assert.equal(await verdictOf(() => ({ outcome: 'unavailable' })), 'idempotency_unavailable');
  assert.equal(await verdictOf(() => { throw new Error('x'); }), 'idempotency_unavailable');
  for (const answer of [{ outcome: 'Completed' }, { completed: true }, { outcome: 'acquired', reclaimed: false }, { outcome: 'completed', durable: false }, null, 'completed', true]) {
    assert.equal(await verdictOf(() => answer), 'idempotency_outcome_invalid', JSON.stringify(answer));
  }
});

test('a store call is bounded by IDEMPOTENCY_DEADLINE_MS under a longer port deadline, and told to cancel', async () => {
  const signals: AbortSignal[] = [];
  const hanging = withStore({
    acquire: (_r: unknown, s: AbortSignal) => { signals.push(s); return new Promise(() => {}); },
    complete: (_r: unknown, s: AbortSignal) => { signals.push(s); return new Promise(() => {}); },
  });
  const started = Date.now();
  assert.equal(await acquireIdempotency(hanging, REQUEST, 3_000), 'idempotency_timeout');
  assert.equal(await completeIdempotency(hanging, { scope: REQUEST.scope, lease: REQUEST.lease, response: 'x' }, 3_000), 'idempotency_timeout');
  const elapsed = Date.now() - started;
  assert.ok(elapsed >= 2 * IDEMPOTENCY_DEADLINE_MS - 100 && elapsed < 4_000, `${elapsed} ms`);
  assert.ok(signals.length === 2 && signals.every((s) => s.aborted));
});

// --- the chain over real loopback sockets ---------------------------------------------------------

const TRUSTED = 'http://pos.trusted.test';
const WRITE = { access: 'authenticated', authorization: { scope: 'platform', permission: 'probe.write' } } as const;
const JSON_BODY = { kind: 'json', maxBytes: 1_024, required: false } as const;
const PRINCIPALS: Record<string, unknown> = {
  'tok-alice': { verified: true, authProvider: 'synthetic', authProviderUid: 'uid-alice' },
  'tok-bob': { verified: true, authProvider: 'synthetic', authProviderUid: 'uid-bob' },
  'tok-mallory': { verified: true, authProvider: 'synthetic', authProviderUid: 'uid-mallory' },
};

interface Reply { status: number; headers: http.IncomingHttpHeaders; body: string }
interface Send { token?: string | null; key?: string | string[] | null; body?: string; path?: string; headers?: Record<string, string> }
interface Recorded { acquires: IdempotencyAcquireRequest[]; completes: IdempotencyCompleteRequest[] }
interface Harness { port: number; logs: string[]; runs: IdempotentContext[]; recorded: Recorded; clock: { t: number } }
interface Setup {
  perform?: IdempotentOperation;
  store?: (memory: DurableIdempotencyStore) => DurableIdempotencyStore;
  limits?: AppDeps['limits'];
  deadlineMs?: number;
}

/** One POST on its own connection: the request (so a test can hang up) and its reply. */
function open(port: number, { token = 'tok-alice', key = null, body = '{"n":1}', path = '/v1/items', headers = {} }: Send = {}) {
  const sent: Record<string, string | string[]> = {
    origin: TRUSTED, [CSRF_HEADER]: CSRF_HEADER_VALUE, 'sec-fetch-site': 'same-origin',
    'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)), ...headers,
  };
  if (token !== null) sent.authorization = `Bearer ${token}`;
  if (key !== null) sent['idempotency-key'] = key;
  const req = http.request({ host: '127.0.0.1', port, method: 'POST', path, headers: sent as http.OutgoingHttpHeaders, agent: false });
  const reply = new Promise<Reply>((resolve, reject) => {
    req.on('response', (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: text }));
    });
    req.on('error', reject);
  });
  req.end(body);
  return { req, reply };
}
const post = (port: number, send: Send = {}): Promise<Reply> => open(port, send).reply;

/** Serve synthetic idempotency-required routes over a recording store for `fn`; always closes the server. */
async function withIdem(setup: Setup, fn: (h: Harness) => Promise<void>): Promise<void> {
  const logs: string[] = [];
  const runs: IdempotentContext[] = [];
  const recorded: Recorded = { acquires: [], completes: [] };
  const clock = { t: T0 };
  const memory = createMemoryIdempotencyStore(createMemoryIdempotencyState({ now: () => clock.t }));
  const base = setup.store === undefined ? memory : setup.store(memory);
  const store: DurableIdempotencyStore = {
    acquire: (r: IdempotencyAcquireRequest, s: AbortSignal) => { recorded.acquires.push(r); return base.acquire(r, s); },
    complete: (r: IdempotencyCompleteRequest, s: AbortSignal) => { recorded.completes.push(r); return base.complete(r, s); },
    probe: (s: AbortSignal) => base.probe(s),
  };
  const perform: IdempotentOperation = async (ctx) => {
    runs.push(ctx);
    return setup.perform === undefined ? { status: 201, body: { created: runs.length }, headers: { location: `/v1/items/${runs.length}` } } : setup.perform(ctx);
  };
  const routes: RouteDefinition[] = [
    { method: 'POST', path: '/v1/items', policy: WRITE, body: JSON_BODY, idempotency: 'required', perform },
    { method: 'POST', path: '/v1/items/other', policy: WRITE, body: JSON_BODY, idempotency: 'required', perform },
  ];
  const readiness = createReadinessState();
  readiness.setReady();
  const app = createApp({
    readiness, now: () => clock.t, log: { log: (line: string) => { logs.push(line); } }, routes, trustedOrigins: [TRUSTED],
    limits: setup.limits ?? testRequestLimits(), ...(setup.deadlineMs === undefined ? {} : { portDeadlineMs: setup.deadlineMs }),
    authenticator: { async verify(view): Promise<unknown> { return PRINCIPALS[view.bearerToken] ?? null; } },
    authorizer: { authorize: (p: VerifiedPrincipal) => p.authProviderUid !== 'uid-mallory' },
    idempotency: { store, keySecret: TEST_IDEMPOTENCY_KEY },
  });
  const server = createBoundedServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    await fn({ port: (server.address() as AddressInfo).port, logs, runs, recorded, clock });
  } finally {
    await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); });
  }
}

/** The reason codes of the first `count` request-log records, once they have flushed. */
async function reasons(logs: string[], count: number): Promise<unknown[]> {
  const records = (): Array<Record<string, unknown>> => logs.map((line) => JSON.parse(line) as Record<string, unknown>).filter((r) => r.event === 'request');
  for (let i = 0; i < 200 && records().length < count; i++) await sleep(5);
  return records().map((r) => r.reason);
}

test('the idempotency step runs after the limit, CSRF, authentication, authorization and the body, and before the operation', async () => {
  const limited = testRequestLimits({ limiter: { consume: () => ({ outcome: 'limited', retryAfterMs: 1_000 }), probe: () => true } });
  await withIdem({ limits: limited }, async ({ port, recorded, runs }) => {
    assert.equal((await post(port, { key: uuid() })).status, 429);
    assert.equal(recorded.acquires.length + runs.length, 0, 'a limited request reserves nothing');
  });
  await withIdem({}, async ({ port, logs, recorded, runs }) => {
    const key = uuid();
    const cases: Array<[Send, number]> = [
      [{ key, token: null }, 401], [{ key, headers: { origin: 'http://evil.test' } }, 403], [{ key, token: 'tok-mallory' }, 403],
      [{ key, body: `"${'x'.repeat(2_048)}"` }, 413], [{ key, body: '{"n":' }, 400],
      [{}, 400], [{ key: [key, key] }, 400], [{ key: `"${key}"` }, 400],
    ];
    for (const [send, status] of cases) assert.equal((await post(port, send)).status, status, JSON.stringify({ ...send, key: undefined }));
    assert.equal(recorded.acquires.length, 0, 'no refusal reserves anything');
    assert.equal(runs.length, 0, 'and the operation never ran');
    const logged = (await reasons(logs, cases.length)).filter((r) => typeof r === 'string' && r.startsWith('idempotency'));
    assert.deepEqual(logged, ['idempotency_key_missing', 'idempotency_key_duplicated', 'idempotency_key_invalid']);
  });
});

test('the first execution is recorded and every retry replays it byte for byte, with its own request ID and no cookie', async () => {
  await withIdem({}, async ({ port, runs }) => {
    const key = uuid();
    const first = await post(port, { key });
    assert.equal(first.status, 201);
    assert.equal(first.body, '{"created":1}');
    assert.equal(first.headers.location, '/v1/items/1');
    assert.equal(first.headers['content-type'], REPLAY_CONTENT_TYPE);
    assert.equal(first.headers['content-length'], String(Buffer.byteLength(first.body)));
    assert.equal(first.headers['idempotent-replayed'], undefined);
    for (const retry of [await post(port, { key }), await post(port, { key: key.toUpperCase() })]) {
      assert.equal(retry.status, 201);
      assert.equal(retry.body, first.body, 'byte for byte');
      assert.equal(retry.headers.location, '/v1/items/1');
      assert.equal(retry.headers['idempotent-replayed'], 'true');
      assert.notEqual(retry.headers['x-request-id'], first.headers['x-request-id'], 'each replay carries its own request ID');
      assert.equal(retry.headers['set-cookie'], undefined);
      for (const [name, value] of Object.entries(SECURITY_HEADERS)) assert.equal(retry.headers[name.toLowerCase()], value, name);
    }
    assert.equal(runs.length, 1, 'the operation ran once');
    assert.deepEqual(Object.keys(runs[0]).sort(), ['attempt', 'audience', 'body', 'principal', 'signal'], 'it sees its context and nothing else');
    assert.deepEqual([runs[0].body, runs[0].audience, runs[0].attempt.reclaimed], [{ n: 1 }, null, false]);
  });
});

test('under one client key another body or operation is the same 422, and another principal is its own operation', async () => {
  await withIdem({}, async ({ port, runs }) => {
    const key = uuid();
    assert.equal((await post(port, { key })).status, 201);
    for (const send of [{ key, body: '{"n":2}' }, { key, path: '/v1/items/other' }, { key, body: '{"n": 1}' }]) {
      const conflict = await post(port, send);
      assert.equal(conflict.status, 422, JSON.stringify(send));
      const body = JSON.parse(conflict.body) as Record<string, unknown>;
      assert.deepEqual([Object.keys(body).sort(), body.error], [['error', 'requestId'], 'idempotency_key_reused'], 'identical whatever differs');
    }
    const theirs = await post(port, { key, token: 'tok-bob' });
    assert.deepEqual([theirs.status, theirs.body, theirs.headers['idempotent-replayed']], [201, '{"created":2}', undefined],
      "another principal's use of the key is its own operation, never the first principal's response");
    assert.equal((await post(port, { key })).body, '{"created":1}', 'the first principal still replays its own');
    assert.equal(runs.length, 2);
  });
});

test('a request in progress is a 409; completion survives a client that hangs up, and the retry replays it', async () => {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  await withIdem({ perform: async () => { await gate; return { status: 200, body: { done: true } }; } }, async ({ port, recorded }) => {
    const key = uuid();
    const inflight = open(port, { key });
    inflight.reply.catch(() => undefined);
    for (let i = 0; i < 200 && recorded.acquires.length === 0; i++) await sleep(5);
    const waiting = await post(port, { key });
    assert.deepEqual([waiting.status, (JSON.parse(waiting.body) as Record<string, unknown>).error], [409, 'request_in_progress']);
    inflight.req.destroy(); // the client hangs up while its operation runs
    release();
    for (let i = 0; i < 200 && recorded.completes.length === 0; i++) await sleep(5);
    const retry = await post(port, { key });
    assert.deepEqual([retry.status, retry.body, retry.headers['idempotent-replayed']], [200, '{"done":true}', 'true'],
      "completion ran on the runtime's own deadline, whatever the client did");
  });
});

test('a store that fails, hangs or answers out of contract is a bounded 503; the operation never runs and nothing leaks', async () => {
  const cases: Array<[string, (m: DurableIdempotencyStore) => DurableIdempotencyStore, string]> = [
    ['unavailable', (m) => ({ ...m, acquire: () => ({ outcome: 'unavailable' }) }), 'idempotency_unavailable'],
    ['throwing', (m) => ({ ...m, acquire: () => { throw new Error('store-secret-detail'); } }), 'idempotency_unavailable'],
    ['rejecting', (m) => ({ ...m, acquire: () => Promise.reject(new Error('store-secret-detail')) }), 'idempotency_unavailable'],
    ['hanging', (m) => ({ ...m, acquire: () => new Promise(() => {}) }), 'idempotency_timeout'],
    ['malformed', (m) => ({ ...m, acquire: () => ({ outcome: 'acquired' }) }), 'idempotency_outcome_invalid'],
    ['a forged replay', (m) => ({ ...m, acquire: () => ({ outcome: 'replay', response: 'forged-response-from-the-store' }) }), 'idempotency_outcome_invalid'],
  ];
  for (const [label, store, reason] of cases) {
    await withIdem({ store }, async ({ port, logs, runs }) => {
      const refused = await post(port, { key: uuid() });
      assert.deepEqual([refused.status, (JSON.parse(refused.body) as Record<string, unknown>).error], [503, 'service_unavailable'], label);
      assert.equal(runs.length, 0, label);
      assert.deepEqual(await reasons(logs, 1), [reason], label);
      assert.doesNotMatch(`${refused.body}${logs.join('')}`, /store-secret-detail|forged/, label);
    });
  }
});

test('a completion the store cannot confirm is a 503, and a retry replays only what the store really recorded', async () => {
  await withIdem({ store: (m) => ({ ...m, complete: () => ({ outcome: 'lease_lost' }) }) }, async ({ port, logs, runs }) => {
    const key = uuid();
    assert.equal((await post(port, { key })).status, 503);
    assert.equal((await post(port, { key })).status, 409, 'the unrecorded operation waits out its lease');
    assert.equal(runs.length, 1);
    assert.deepEqual(await reasons(logs, 2), ['idempotency_lease_lost', 'idempotency_in_progress']);
  });
  // A completion that took effect but whose answer was lost in flight: indeterminate, so a 503 — and its retry replays.
  await withIdem({ store: (m) => ({ ...m, complete: (r, s) => { m.complete(r, s); return new Promise(() => {}); } }) }, async ({ port, runs }) => {
    const key = uuid();
    assert.equal((await post(port, { key })).status, 503);
    const retry = await post(port, { key });
    assert.deepEqual([retry.status, retry.headers['idempotent-replayed'], runs.length], [201, 'true', 1]);
  });
});

test('a failing or overrunning operation is never recorded; its lease then holds, and an explicit reclaim runs it again', async () => {
  let fail = true;
  const perform: IdempotentOperation = () => {
    if (fail) throw new Error('operation-secret-detail');
    return { status: 201, body: { ok: true } };
  };
  await withIdem({ perform }, async ({ port, logs, runs, recorded, clock }) => {
    const key = uuid();
    const crashed = await post(port, { key });
    assert.deepEqual([crashed.status, (JSON.parse(crashed.body) as Record<string, unknown>).error], [500, 'internal_error']);
    assert.equal(recorded.completes.length, 0, 'a crash completes nothing');
    assert.equal((await post(port, { key })).status, 409, 'the reservation holds while its lease does');
    fail = false;
    clock.t += IDEMPOTENCY_POLICY.leaseMs;
    assert.equal((await post(port, { key })).status, 201);
    assert.deepEqual(runs.map((r) => r.attempt.reclaimed), [false, true], 'the rerun is told an earlier attempt may have run');
    await reasons(logs, 3);
    assert.ok(logs.some((line) => (JSON.parse(line) as Record<string, unknown>).event === 'idempotency_reclaimed'));
    assert.doesNotMatch(`${crashed.body}${logs.join('')}`, /operation-secret-detail/);
  });
  let signal: AbortSignal | undefined;
  await withIdem({ deadlineMs: 200, perform: (ctx) => { signal = ctx.signal; return new Promise(() => {}); } }, async ({ port, logs, recorded }) => {
    assert.equal((await post(port, { key: uuid() })).status, 503);
    assert.deepEqual(await reasons(logs, 1), ['idempotent_operation_timeout']);
    assert.ok(signal?.aborted, 'the overrunning operation was told to stop');
    assert.equal(recorded.completes.length, 0);
  });
});

test('an outcome that cannot be retained is a bounded 500 and is never recorded; an approved rejection is', async () => {
  const outcomes: unknown[] = [
    { status: 500, body: {} }, { status: 204, body: {} }, { status: 201, body: {}, headers: { 'set-cookie': 'sid=1' } },
    { status: 201, body: 'x'.repeat(MAX_REPLAY_BODY_BYTES) }, { status: 409, body: { error: 'request_in_progress' } }, { status: 201 },
  ];
  let next = 0;
  await withIdem({ perform: () => outcomes[next++] as never }, async ({ port, logs, recorded }) => {
    for (const _ of outcomes) {
      const refused = await post(port, { key: uuid() });
      assert.deepEqual([refused.status, refused.headers['set-cookie']], [500, undefined]);
    }
    assert.equal(recorded.completes.length, 0);
    assert.deepEqual(await reasons(logs, outcomes.length), outcomes.map(() => 'idempotent_outcome_invalid'));
  });
  await withIdem({ perform: () => ({ status: 422, body: { error: 'insufficient_stock' } }) }, async ({ port, runs }) => {
    const key = uuid();
    const first = await post(port, { key });
    const again = await post(port, { key });
    assert.deepEqual([first.status, again.status, again.body, again.headers['idempotent-replayed']], [422, 422, first.body, 'true']);
    assert.equal(runs.length, 1);
  });
});

test('no raw key, principal, credential, body or cookie crosses the port or reaches the log', async () => {
  await withIdem({ perform: () => ({ status: 201, body: { receipt: 'RESPONSE-BODY-CANARY-9c1e' } }) }, async ({ port, logs, recorded }) => {
    const key = uuid();
    const body = JSON.stringify({ canary: 'REQUEST-BODY-CANARY-7f3a' });
    const replies: Reply[] = [];
    for (const send of [{ key, body }, { key, body }, { key, body: '{"n":9}' }]) {
      replies.push(await post(port, { ...send, headers: { cookie: 'sid=COOKIE-CANARY-7f3a' } }));
    }
    assert.deepEqual(replies.map((r) => [r.status, r.headers['idempotent-replayed']]), [[201, undefined], [201, 'true'], [422, undefined]]);
    assert.ok(replies[1].body.includes('RESPONSE-BODY-CANARY'), 'the replay carries the recorded response');
    assert.ok(!recorded.completes[0].response.includes('RESPONSE-BODY-CANARY'), 'the store holds the response sealed, never readable');
    assert.deepEqual(await reasons(logs, 3), [undefined, 'idempotency_replayed', 'idempotency_conflict'], 'the request log tells a replay from the call that ran');
    const seen = `${JSON.stringify(recorded)}${logs.join('')}`;
    for (const secret of [key, key.toUpperCase(), 'uid-alice', 'tok-alice', 'REQUEST-BODY-CANARY', 'COOKIE-CANARY', 'RESPONSE-BODY-CANARY']) {
      assert.ok(!seen.includes(secret), secret);
    }
    assert.ok(recorded.acquires.length === 3 && recorded.completes.length === 1);
    for (const r of recorded.acquires) {
      assert.deepEqual(Object.keys(r).sort(), ['fingerprint', 'lease', 'leaseMs', 'retentionMs', 'scope']);
      for (const field of [r.scope, r.fingerprint, r.lease]) assert.match(field, /^[A-Za-z0-9_-]{43}$/);
      assert.deepEqual([r.leaseMs, r.retentionMs], [IDEMPOTENCY_POLICY.leaseMs, IDEMPOTENCY_POLICY.retentionMs]);
    }
    assert.deepEqual(Object.keys(recorded.completes[0]).sort(), ['lease', 'response', 'scope']);
  });
});

// --- startup and readiness -------------------------------------------------------------------------

test('startup refuses a required route without a store and key, a malformed store, and a secret shared with the limiter', () => {
  const route: RouteDefinition = { method: 'POST', path: '/v1/items', policy: WRITE, body: JSON_BODY, idempotency: 'required', perform: () => ({ status: 200, body: {} }) };
  const code = (over: Partial<AppDeps>): string | undefined => {
    try {
      createApp({
        readiness: createReadinessState(), routes: [route], trustedOrigins: [TRUSTED], limits: testRequestLimits(),
        authenticator: { verify: async () => null }, authorizer: { authorize: () => true }, ...over,
      });
    } catch (err) {
      return err instanceof EnforcementSetupError ? err.code : 'unexpected';
    }
    return undefined;
  };
  assert.equal(code({}), 'idempotency_required');
  assert.equal(code({ idempotency: { store: { acquire: () => ({}), complete: () => ({}) }, keySecret: TEST_IDEMPOTENCY_KEY } as never }), 'idempotency_invalid',
    'a store without a probe');
  assert.equal(code({ idempotency: { ...testIdempotency(), fallback: createMemoryIdempotencyStore() } as never }), 'idempotency_invalid', 'no extra part, least of all a fallback');
  assert.equal(code({ idempotency: testIdempotency({ keySecret: new Uint8Array(16) }) }), 'idempotency_key_invalid');
  assert.equal(code({ idempotency: testIdempotency({ keySecret: new Uint8Array(TEST_RATE_LIMIT_KEY) }) }), 'idempotency_key_shared');
  assert.equal(code({ idempotency: testIdempotency() }), undefined);
});

test('readiness reports the idempotency store through one shared probe per second', async () => {
  let healthy = true;
  let probes = 0;
  const clock = { t: T0 };
  const store = { ...createMemoryIdempotencyStore(), probe: () => { probes++; return healthy; } };
  const readiness = createReadinessState();
  readiness.setReady();
  const app = createApp({ readiness, now: () => clock.t, log: { log: () => {} }, limits: testRequestLimits(), idempotency: { store, keySecret: TEST_IDEMPOTENCY_KEY } });
  const server = createBoundedServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const status = (): Promise<number> => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: (server.address() as AddressInfo).port, path: '/readiness', agent: false }, (res) => { res.resume(); resolve(res.statusCode ?? 0); });
    req.on('error', reject);
    req.end();
  });
  try {
    assert.deepEqual([await status(), await status()], [200, 200]);
    assert.equal(probes, 1, 'one shared probe answers every readiness request within a second');
    healthy = false;
    clock.t += 1_000;
    assert.equal(await status(), 503, 'a store that cannot serve makes the instance unready');
  } finally {
    await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); });
  }
});
