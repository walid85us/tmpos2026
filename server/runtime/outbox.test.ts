// Phase 4.0 M6 — the transactional outbox: closed contracts and bounded records, the strict envelope,
// strict delivery answers, the delivery conformance suite with positive controls, and the one bounded pass.
//
// Synthetic contracts, events and stores only; nothing here publishes anywhere. The conformance suite runs
// against the test-only in-memory adapter and an independent adapter over the same synthetic state, and
// fails each broken adapter it exists to catch.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { AUDIT_FORBIDDEN_FIELDS } from '../platform-identity/auditEventContract.js';
import {
  MAX_CLAIM_BATCH, MAX_OUTBOX_ENVELOPE_BYTES, MAX_PUBLISH_DEADLINE_MS, MAX_RECORD_BYTES, OUTBOX_DEADLINE_MS, OUTBOX_DELIVERY_POLICY,
  acknowledgeOutbox, claimOutbox, createOutboxDelivery, deadLetterOutbox, defineOutboxEvents, deliverOutboxBatch, envelopeOf,
  parseRecordSchema, recordOf, retryDelayMs, retryOutbox,
} from './outbox.js';
import type { OutboxClaimRequest, OutboxDelivery, OutboxDeliveryStore, OutboxEnvelope, OutboxSettleRequest } from './outbox.js';
import { EnforcementSetupError } from './routes.js';
import {
  TEST_EVENTS, assertOutboxDeliveryContract, createMemoryOutboxDeliveryStore, createMemoryTransactionalHarness, createMemoryTransactionalState,
} from './transactionalOutbox.testkit.js';
import type { MemoryTransactionalState, TransactionalOutboxHarness } from './transactionalOutbox.testkit.js';

const T0 = 1_700_000_000_000;
const DOWN = { outcome: 'unavailable' };
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// --- contracts, records and envelopes ------------------------------------------------------------

test('a record schema is flat, closed and bounded, and refuses a field named for secret material', () => {
  const sixteen = Object.fromEntries(Array.from({ length: 16 }, (_, i) => [`field${i}`, { type: 'boolean' }]));
  assert.ok(parseRecordSchema({ name: { type: 'string', maxLength: 64 }, count: { type: 'integer', min: 0, max: 9 }, flag: { type: 'boolean' }, kind: { type: 'enum', values: ['a', 'b-c'] } }));
  assert.ok(parseRecordSchema({}) && parseRecordSchema(sixteen), 'from no field up to sixteen');
  for (const [label, schema] of [
    ['seventeen fields', { ...sixteen, extra: { type: 'boolean' } }], ['a snake_case name', { first_name: { type: 'boolean' } }],
    ['an upper-case initial', { Name: { type: 'boolean' } }], ['an Object.prototype member', { constructor: { type: 'boolean' } }],
    ['another one', { toString: { type: 'boolean' } }], ['an unknown type', { a: { type: 'object' } }], ['a nested record', { a: { type: 'record', fields: {} } }],
    ['an unbounded string', { a: { type: 'string' } }], ['a string over 256', { a: { type: 'string', maxLength: 257 } }], ['a zero bound', { a: { type: 'string', maxLength: 0 } }],
    ['an optional flag', { a: { type: 'boolean', optional: true } }], ['an inverted range', { a: { type: 'integer', min: 2, max: 1 } }],
    ['an unsafe bound', { a: { type: 'integer', min: 0, max: 2 ** 53 } }], ['an empty enum', { a: { type: 'enum', values: [] } }],
    ['a repeated enum value', { a: { type: 'enum', values: ['x', 'x'] } }], ['an upper-case enum value', { a: { type: 'enum', values: ['X'] } }],
    ['an array', [{ type: 'boolean' }]],
  ] as const) {
    assert.equal(parseRecordSchema(schema), null, label);
  }
  for (const name of [...AUDIT_FORBIDDEN_FIELDS, 'sessionId', 'csrfToken', 'idempotencyKey', 'apiKey', 'bearerToken', 'cookieValue', 'connectionUri', 'dsn', 'rawBody', 'cvv', 'pin', 'otp', 'jwt']) {
    assert.equal(parseRecordSchema({ [name]: { type: 'boolean' } }), null, `a field named ${name} is refused`);
  }
  assert.ok(parseRecordSchema({ company: { type: 'boolean' }, footprint: { type: 'boolean' } }), 'short names are refused whole, never as a part of another word');
});

test('a record carries exactly its fields in bounds, and at most MAX_RECORD_BYTES whatever its fields allow', () => {
  const schema = parseRecordSchema({ name: { type: 'string', maxLength: 8 }, count: { type: 'integer', min: 0, max: 9 }, flag: { type: 'boolean' }, kind: { type: 'enum', values: ['a', 'b'] } });
  assert.ok(schema);
  const value = { name: 'x', count: 9, flag: false, kind: 'b' };
  assert.deepEqual(recordOf(schema, value), value);
  assert.ok(Object.isFrozen(recordOf(schema, { ...value, name: '' })));
  const hostile = new Proxy({ ...value }, { get: () => { throw new Error('hostile'); } });
  for (const [label, raw] of [
    ['a missing field', { name: 'x', count: 1, flag: true }], ['an extra field', { ...value, extra: 1 }], ['a string over its bound', { ...value, name: 'x'.repeat(9) }],
    ['above the range', { ...value, count: 10 }], ['below it', { ...value, count: -1 }], ['a fraction', { ...value, count: 1.5 }], ['negative zero', { ...value, count: -0 }],
    ['a numeric string', { ...value, count: '1' }], ['a string for a boolean', { ...value, flag: 'true' }], ['an enum outside its values', { ...value, kind: 'c' }],
    ['a NUL', { ...value, name: 'a\u0000' }], ['a line break', { ...value, name: 'a\nb' }], ['a line separator', { ...value, name: 'a\u2028' }],
    ['a lone surrogate', { ...value, name: '\ud800' }], ['a symbol key', { ...value, [Symbol('s')]: 1 }], ['a throwing getter', hostile],
    ['an inherited field', Object.assign(Object.create({ kind: 'a' }), { name: 'x', count: 1, flag: true })], ['an array', ['x', 1, true, 'a']], ['null', null],
  ] as const) {
    assert.equal(recordOf(schema, raw), null, label);
  }
  // The byte cap is independent: a record whose every field is within its own bound can still be refused.
  const names = Array.from({ length: 16 }, (_, i) => `f${String(i).padStart(2, '0')}`);
  const wide = parseRecordSchema(Object.fromEntries(names.map((n) => [n, { type: 'string', maxLength: 256 }])));
  assert.ok(wide);
  let budget = MAX_RECORD_BYTES - Buffer.byteLength(JSON.stringify(Object.fromEntries(names.map((n) => [n, '']))));
  const atCap: Record<string, string> = Object.fromEntries(names.map((n) => { const length = Math.min(256, budget); budget -= length; return [n, 'a'.repeat(length)]; }));
  assert.equal(Buffer.byteLength(JSON.stringify(atCap)), MAX_RECORD_BYTES);
  assert.ok(recordOf(wide, atCap), 'exactly at the cap');
  const over = { ...atCap, f15: `${atCap.f15}a` };
  assert.ok(Object.values(over).every((v) => v.length <= 256), 'every field within its own bound');
  assert.equal(recordOf(wide, over), null, 'yet one byte over the cap is refused');
});

test('event contracts are closed at startup: the grammar, the versions, one aggregate per type', () => {
  const registry = defineOutboxEvents(TEST_EVENTS);
  assert.equal(registry.contract('conformance.item.created', 1)?.aggregateType, 'item');
  assert.equal(registry.contract('conformance.item.created', 2), undefined);
  assert.ok(Object.isFrozen(registry.list()) && Object.isFrozen(registry.list()[0]));
  const base = { type: 'x.y', version: 1, aggregateType: 'thing', payload: {} };
  for (const [label, defs] of [
    ['not an array', base], ['a single segment', [{ ...base, type: 'single' }]], ['an upper-case type', [{ ...base, type: 'X.y' }]],
    ['an overlong type', [{ ...base, type: `x.${'y'.repeat(64)}` }]], ['version 0', [{ ...base, version: 0 }]], ['version 1001', [{ ...base, version: 1_001 }]],
    ['a fractional version', [{ ...base, version: 1.5 }]], ['an upper-case aggregate', [{ ...base, aggregateType: 'Thing' }]],
    ['a secret-named field', [{ ...base, payload: { token: { type: 'boolean' } } }]], ['an extra key', [{ ...base, actor: true }]],
    ['one version twice', [base, base]], ['one type over two aggregates', [base, { ...base, version: 2, aggregateType: 'other' }]],
  ] as const) {
    assert.throws(() => defineOutboxEvents(defs), (e: unknown) => e instanceof EnforcementSetupError && e.code === 'outbox_registry_invalid', label);
  }
  assert.equal(defineOutboxEvents([base, { ...base, version: 2 }]).list().length, 2, 'the versions of one type coexist while events of each can be claimed');
});

const registry = defineOutboxEvents(TEST_EVENTS);
const envelope = (over: Partial<OutboxEnvelope> = {}): OutboxEnvelope => Object.freeze({
  eventId: randomUUID(), type: 'conformance.item.renamed', version: 1, aggregateType: 'item', aggregateId: randomUUID(), aggregateVersion: 2,
  tenant: null, store: null, actor: null, correlationId: randomUUID(), payload: Object.freeze({ name: 'n' }), occurredAt: T0, ...over,
});

test('a stored envelope is obeyed only when strictly in contract, and every envelope is bounded by MAX_OUTBOX_ENVELOPE_BYTES', () => {
  const valid = envelope();
  assert.deepEqual(envelopeOf(registry, valid), valid);
  const digest = 'd'.repeat(43);
  assert.ok(envelopeOf(registry, { ...valid, tenant: digest, store: digest, actor: digest }), 'a scope or actor slot holds a keyed digest once M5 supplies one');
  const { occurredAt: _dropped, ...missing } = valid;
  for (const [label, raw] of [
    ['a version-1 UUID event ID', { ...valid, eventId: '6f1c1f5e-0b1d-11ee-be56-0242ac120002' }], ['an upper-case event ID', { ...valid, eventId: valid.eventId.toUpperCase() }],
    ['an unknown type', { ...valid, type: 'conformance.item.deleted' }], ['an unknown version', { ...valid, version: 2 }], ['another aggregate type', { ...valid, aggregateType: 'order' }],
    ['a malformed aggregate ID', { ...valid, aggregateId: 'item-1' }], ['version 0', { ...valid, aggregateVersion: 0 }], ['no version', { ...valid, aggregateVersion: null }],
    ['a raw tenant', { ...valid, tenant: 'tenant-1' }], ['a raw actor', { ...valid, actor: 'uid-alice' }], ['a digest correlation ID', { ...valid, correlationId: digest }],
    ['no timestamp', missing], ['timestamp 0', { ...valid, occurredAt: 0 }], ['a fractional timestamp', { ...valid, occurredAt: 1.5 }],
    ['a payload field too many', { ...valid, payload: { name: 'n', extra: 1 } }], ['a payload out of schema', { ...valid, payload: { name: 7 } }],
    ['delivery metadata inside the envelope', { ...valid, attempt: 1 }], ['null', null], ['an array', [valid]],
  ] as const) {
    assert.equal(envelopeOf(registry, raw), null, label);
  }
  const bulky = defineOutboxEvents([{ type: 'x.bulky', version: 1, aggregateType: 'thing', payload: Object.fromEntries(Array.from({ length: 16 }, (_, i) => [`f${i}`, { type: 'string', maxLength: 256 }])) }]);
  const fill = Object.fromEntries(Array.from({ length: 16 }, (_, i) => [`f${i}`, 'a'.repeat(250)]));
  let largest = 0;
  for (let cut = 0; cut < 400; cut += 20) {
    const payload = { ...fill, f15: 'a'.repeat(Math.max(0, 250 - cut)) };
    const e = envelopeOf(bulky, envelope({ type: 'x.bulky', aggregateType: 'thing', tenant: digest, store: digest, actor: digest, payload }));
    if (e !== null) largest = Math.max(largest, Buffer.byteLength(JSON.stringify(e)));
  }
  assert.ok(largest > MAX_RECORD_BYTES - 100 && largest <= MAX_OUTBOX_ENVELOPE_BYTES, `the largest envelope a contract admits (${largest} bytes) is within the cap`);
  assert.equal(envelopeOf(bulky, envelope({ type: 'x.bulky', aggregateType: 'thing', payload: fill })), null, 'a payload over MAX_RECORD_BYTES is refused inside an envelope too');
});

// --- strict delivery answers -----------------------------------------------------------------------

const deliveryWith = (store: Partial<OutboxDeliveryStore>): OutboxDelivery => createOutboxDelivery({
  store: { claim: () => ({ outcome: 'claimed', events: [] }), acknowledge: () => ({ outcome: 'acknowledged' }), retry: () => ({ outcome: 'scheduled' }),
    deadLetter: () => ({ outcome: 'dead_lettered' }), probe: () => true, ...store },
  events: TEST_EVENTS,
});
const CLAIM: OutboxClaimRequest = Object.freeze({ claim: 'c'.repeat(43), limit: 2, claimMs: OUTBOX_DELIVERY_POLICY.claimMs });

test('a claim is obeyed only when exact; a bad envelope is its item’s, an unaddressable item breaks the answer', async () => {
  const claimWith = (answer: () => unknown): Promise<unknown> => claimOutbox(deliveryWith({ claim: answer }), CLAIM, 3_000);
  const e = envelope();
  const item = (over: Record<string, unknown> = {}) => ({ eventId: e.eventId, attempt: 1, envelope: e, ...over });
  assert.deepEqual(await claimWith(() => ({ outcome: 'claimed', events: [] })), []);
  assert.deepEqual(await claimWith(() => ({ outcome: 'claimed', events: [item()] })), [{ eventId: e.eventId, attempt: 1, envelope: e, known: true }]);
  const unknownVersion = { ...e, version: 2 };
  assert.deepEqual(await claimWith(() => ({ outcome: 'claimed', events: [item({ envelope: unknownVersion })] })), [{ eventId: e.eventId, attempt: 1, envelope: null, known: false }],
    'a contract this worker lacks is unknown, not invalid');
  for (const [label, broken] of [
    ['a bare type and version', { type: 'future.event', version: 1 }], ['an unknown version under another row’s event ID', { ...unknownVersion, eventId: randomUUID() }],
    ['an unknown version with a malformed correlation ID', { ...unknownVersion, correlationId: 'corr-1' }], ['an unknown version with a list payload', { ...unknownVersion, payload: [] }],
    // No contract could produce these payloads: every contract's is flat, bounded scalars under well-formed names.
    ['an unknown version with a nested payload', { ...unknownVersion, payload: { name: { deep: 1 } } }],
    ['an unknown version with seventeen payload fields', { ...unknownVersion, payload: Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`f${i}`, true])) }],
    ['an unknown version with an over-long string', { ...unknownVersion, payload: { name: 'a'.repeat(257) } }],
    ['an unknown version with a payload over MAX_RECORD_BYTES', { ...unknownVersion, payload: Object.fromEntries(Array.from({ length: 16 }, (_, i) => [`f${i}`, 'a'.repeat(256)])) }],
    ['an unknown version with a field named for secret material', { ...unknownVersion, payload: { apiKey: 'k' } }],
    ['an unknown version with a control character', { ...unknownVersion, payload: { name: 'a\u0000' } }], ['an unknown version with a lone surrogate', { ...unknownVersion, payload: { name: '\ud800' } }],
    ['an unknown version with a symbol key', { ...unknownVersion, payload: { [Symbol('k')]: 1 } }], ['an unknown version with minus zero', { ...unknownVersion, payload: { n: -0 } }],
    ['an unknown version with NaN', { ...unknownVersion, payload: { n: Number.NaN } }], ['an unknown version with an unsafe integer', { ...unknownVersion, payload: { n: 2 ** 53 } }],
    ['an unknown version with a list field', { ...unknownVersion, payload: { n: [1] } }], ['an unknown version with a null field', { ...unknownVersion, payload: { n: null } }],
    // A type keeps one aggregate in every release (release policy), so a newer version under another aggregate is no contract at all.
    ['an unknown version of a known type under another aggregate', { ...unknownVersion, aggregateType: 'order' }],
  ] as const) {
    assert.deepEqual(await claimWith(() => ({ outcome: 'claimed', events: [item({ envelope: broken })] })), [{ eventId: e.eventId, attempt: 1, envelope: null, known: true }],
      `${label}: no well-formed envelope of this row, so invalid — never retried as a contract this worker lacks`);
  }
  let reads = 0;
  const flipping = Object.defineProperty({ ...e }, 'type', { enumerable: true, get: () => (reads++ === 0 ? 'conformance.item.deleted' : e.type) });
  assert.deepEqual(await claimWith(() => ({ outcome: 'claimed', events: [item({ envelope: flipping })] })), [{ eventId: e.eventId, attempt: 1, envelope: null, known: false }]);
  assert.equal(reads, 1, 'each envelope field is read once, so the classification cannot see a second answer');
  for (const broken of [{ ...e, payload: { name: 'n', extra: 1 } }, { ...e, eventId: randomUUID() }, 'not an envelope']) {
    assert.deepEqual(await claimWith(() => ({ outcome: 'claimed', events: [item({ envelope: broken })] })), [{ eventId: e.eventId, attempt: 1, envelope: null, known: true }],
      'an envelope out of contract, or not its row’s, is refused and still addressed by the row key');
  }
  assert.equal(await claimWith(() => ({ outcome: 'unavailable' })), 'outbox_unavailable');
  assert.equal(await claimWith(() => { throw new Error('store-secret-detail'); }), 'outbox_unavailable');
  assert.equal(await claimWith(() => Promise.reject(new Error('x'))), 'outbox_unavailable');
  const other = randomUUID();
  for (const [i, answer] of [
    { outcome: 'Claimed', events: [] }, { outcome: 'claimed', events: [], extra: 1 }, { outcome: 'claimed' }, { outcome: 'claimed', events: {} },
    { outcome: 'unavailable', detail: 'x' }, { outcome: 'claimed', events: [item(), item({ eventId: other }), item({ eventId: randomUUID() })] },
    { outcome: 'claimed', events: [{ eventId: e.eventId, envelope: e }] }, { outcome: 'claimed', events: [item({ extra: 1 })] }, { outcome: 'claimed', events: [item({ attempt: 0 })] },
    { outcome: 'claimed', events: [item({ attempt: 1.5 })] }, { outcome: 'claimed', events: [item({ eventId: 'row-1' })] }, { outcome: 'claimed', events: [item(), item()] },
    null, 'claimed', Object.create({ outcome: 'claimed', events: [] }), new Proxy({}, { get: (_t, name) => { if (name === 'then') return undefined; throw new Error('hostile'); } }),
  ].entries()) {
    assert.equal(await claimWith(() => answer), 'outbox_outcome_invalid', `out-of-contract claim #${i}`);
  }
  const started = Date.now();
  assert.equal(await claimOutbox(deliveryWith({ claim: () => new Promise(() => {}) }), CLAIM, 3_000), 'outbox_timeout');
  assert.ok(Date.now() - started < OUTBOX_DEADLINE_MS + 500, 'bounded by OUTBOX_DEADLINE_MS under a longer caller deadline');
});

test('a settlement is obeyed only when it is exactly its own word', async () => {
  const request: OutboxSettleRequest = Object.freeze({ eventId: randomUUID(), claim: 'c'.repeat(43) });
  for (const [settle, word] of [
    [(d: OutboxDelivery) => acknowledgeOutbox(d, request, 1_000), 'acknowledged'],
    [(d: OutboxDelivery) => retryOutbox(d, { ...request, delayMs: 1_000 }, 1_000), 'scheduled'],
    [(d: OutboxDelivery) => deadLetterOutbox(d, { ...request, reason: 'attempts_exhausted' }, 1_000), 'dead_lettered'],
  ] as const) {
    const answering = (answer: () => unknown): OutboxDelivery => deliveryWith({ acknowledge: answer, retry: answer, deadLetter: answer });
    assert.equal(await settle(answering(() => ({ outcome: word }))), 'settled', word);
    assert.equal(await settle(answering(() => ({ outcome: 'claim_lost' }))), 'claim_lost');
    assert.equal(await settle(answering(() => DOWN)), 'outbox_unavailable');
    assert.equal(await settle(answering(() => { throw new Error('x'); })), 'outbox_unavailable');
    for (const answer of [{ outcome: word, extra: 1 }, { outcome: word === 'scheduled' ? 'acknowledged' : 'scheduled' }, {}, null, word]) {
      assert.equal(await settle(answering(() => answer)), 'outbox_outcome_invalid', `${word}: ${JSON.stringify(answer)}`);
    }
  }
});

// --- conformance ---------------------------------------------------------------------------------

type DeliveryDefect =
  | 'nonAtomicClaim' | 'ignoresLimit' | 'neverExpires' | 'expiresEarly' | 'skewedPeer' | 'anyTokenSettles' | 'forgetsAck' | 'ignoresDelay'
  | 'deadClaimable' | 'attemptNotCounted' | 'rewritesEnvelope' | 'strictExpiry' | 'ignoresAbort' | 'failsOpen' | 'probesOpen' | 'losesState' | 'queuesOutage';

/**
 * An independent delivery adapter — two instances, as over a remote store — over the in-memory harness's
 * state. With no defect it is in contract; each defect breaks exactly one clause of the port contract.
 */
function deliveryHarness(defect: DeliveryDefect | null): TransactionalOutboxHarness {
  const base = createMemoryTransactionalHarness();
  const { outbox } = base.state;
  let broken = false;
  const queued: Array<() => void> = [];
  const eligibleAt = (t: number): string[] => [...outbox].filter(([, e]) => (e.status === 'pending' ? defect === 'ignoresDelay' || e.dueAt <= t
    : e.status === 'claimed' ? defect !== 'neverExpires' && e.claimExpiresAt - (defect === 'expiresEarly' ? 1 : 0) <= t
      : e.status === 'dead' && defect === 'deadClaimable')).map(([id]) => id);
  const take = (ids: readonly string[], request: OutboxClaimRequest, t: number): unknown[] =>
    ids.slice(0, defect === 'ignoresLimit' ? ids.length : request.limit).map((id) => {
      const e = outbox.get(id) as NonNullable<ReturnType<typeof outbox.get>>;
      const attempt = defect === 'attemptNotCounted' ? 1 : e.attempt + 1;
      const env = defect === 'rewritesEnvelope' && e.attempt > 0 ? { ...e.envelope, occurredAt: t } : e.envelope;
      outbox.set(id, { ...e, status: 'claimed', attempt, claim: request.claim, claimExpiresAt: t + request.claimMs });
      return { eventId: id, attempt, envelope: env };
    });
  const instance = (skew: number): OutboxDeliveryStore => {
    const now = (): number => base.state.now() + skew;
    const settle = (request: OutboxSettleRequest, signal: AbortSignal, word: string, next: (e: NonNullable<ReturnType<typeof outbox.get>>, t: number) => NonNullable<ReturnType<typeof outbox.get>>): unknown => {
      if (broken) return defect === 'failsOpen' ? { outcome: word } : DOWN;
      if (signal.aborted && defect !== 'ignoresAbort') return DOWN;
      const e = outbox.get(request.eventId);
      if (e === undefined || e.status !== 'claimed' || (e.claim !== request.claim && defect !== 'anyTokenSettles')
        || (defect === 'strictExpiry' && e.claimExpiresAt <= now())) return { outcome: 'claim_lost' };
      outbox.set(request.eventId, next(e, now()));
      return { outcome: word };
    };
    return {
      async claim(request, signal) {
        if (broken) {
          if (defect === 'queuesOutage') queued.push(() => { take(eligibleAt(now()), request, now()); });
          return defect === 'failsOpen' ? { outcome: 'claimed', events: [] } : DOWN;
        }
        if (signal.aborted && defect !== 'ignoresAbort') return DOWN;
        const t = now();
        const ids = eligibleAt(t);
        if (defect === 'nonAtomicClaim') await new Promise((resolve) => setImmediate(resolve)); // the network gap between read and write
        return { outcome: 'claimed', events: take(ids, request, t) };
      },
      acknowledge: (r, s) => settle(r, s, 'acknowledged', (e) => (defect === 'forgetsAck' ? e : { ...e, status: 'delivered', claim: null })),
      retry: (r, s) => settle(r, s, 'scheduled', (e, t) => ({ ...e, status: 'pending', dueAt: t + r.delayMs, claim: null })),
      deadLetter: (r, s) => settle(r, s, 'dead_lettered', (e) => ({ ...e, status: 'dead', claim: null, reason: r.reason })),
      probe: () => defect === 'probesOpen' || !broken,
    };
  };
  return {
    ...base,
    delivery: instance(0),
    deliveryPeer: instance(defect === 'skewedPeer' ? 1_000 : 0),
    breakStore: () => { broken = true; base.breakStore(); },
    restoreStore: () => {
      broken = false;
      base.restoreStore();
      if (defect === 'losesState') for (const [id, e] of outbox) if (e.status === 'claimed') outbox.set(id, { ...e, status: 'pending', claim: null });
      for (const run of queued.splice(0)) run();
    },
  };
}

test('the in-memory delivery adapter meets the contract every durable adapter must meet', async () => {
  await assertOutboxDeliveryContract(createMemoryTransactionalHarness());
});

test('the delivery conformance suite passes a correct independent adapter and fails every broken one', async () => {
  await assertOutboxDeliveryContract(deliveryHarness(null));
  const caught: Array<[DeliveryDefect, RegExp]> = [
    ['nonAtomicClaim', /no event is claimed by two concurrent claims/], ['ignoresLimit', /no claim exceeds its limit/],
    ['neverExpires', /an expired claim is reclaimed/], ['expiresEarly', /a claim holds until it expires/], ['skewedPeer', /a claim holds until it expires/],
    ['anyTokenSettles', /stale holder's acknowledgement is refused/], ['forgetsAck', /an acknowledged event is never claimed again/],
    ['ignoresDelay', /a retried event waits/], ['deadClaimable', /a dead event is never claimed again/], ['attemptNotCounted', /an expired claim is reclaimed/],
    ['rewritesEnvelope', /the same envelope redelivered/], ['strictExpiry', /an expired claim nobody reclaimed still acknowledges/],
    ['ignoresAbort', /claimed nothing/], ['failsOpen', /an unreachable store claims nothing/], ['probesOpen', /never answers the probe with true/],
    ['losesState', /a claim kept through the outage still settles/], ['queuesOutage', /no claim attempted during the outage was queued/],
  ];
  for (const [defect, check] of caught) {
    await assert.rejects(assertOutboxDeliveryContract(deliveryHarness(defect)), (err: unknown) => err instanceof assert.AssertionError && check.test(err.message), defect);
  }
});

// --- the one bounded pass ----------------------------------------------------------------------------

interface Pass { readonly state: MemoryTransactionalState; readonly clock: { t: number }; readonly delivery: OutboxDelivery }
function pass(events = TEST_EVENTS, store?: (inner: OutboxDeliveryStore) => OutboxDeliveryStore): Pass {
  const clock = { t: T0 };
  const state = createMemoryTransactionalState({ now: () => clock.t });
  const inner = createMemoryOutboxDeliveryStore(state);
  return { state, clock, delivery: createOutboxDelivery({ store: store === undefined ? inner : store(inner), events }) };
}
const enqueue = (state: MemoryTransactionalState, e: OutboxEnvelope, attempt = 0): void => {
  state.outbox.set(e.eventId, { envelope: e, status: 'pending', attempt, dueAt: state.now(), claim: null, claimExpiresAt: 0, reason: null });
};
const statusOf = (state: MemoryTransactionalState, id: string) => state.outbox.get(id);

test('a pass publishes each claimed event once, with the envelope alone, and acknowledges what was delivered', async () => {
  const { state, delivery } = pass();
  const queued = [envelope(), envelope(), envelope()];
  for (const e of queued) enqueue(state, e);
  const published: OutboxEnvelope[] = [];
  const result = await deliverOutboxBatch(delivery, (e, signal) => { published.push(e); assert.ok(signal instanceof AbortSignal); return true; });
  assert.deepEqual(result, { claimed: 3, acknowledged: 3, retried: 0, deadLettered: 0, lost: 0, unsettled: 0 });
  assert.deepEqual([...published].sort((a, b) => a.eventId.localeCompare(b.eventId)), [...queued].sort((a, b) => a.eventId.localeCompare(b.eventId)), 'each exactly as committed');
  assert.ok(published.every((e) => Object.isFrozen(e) && Object.isFrozen(e.payload)), 'a publisher cannot alter the envelope');
  assert.ok(queued.every((e) => statusOf(state, e.eventId)?.status === 'delivered'));
  assert.deepEqual(await deliverOutboxBatch(delivery, () => true), { claimed: 0, acknowledged: 0, retried: 0, deadLettered: 0, lost: 0, unsettled: 0 });
});

test('an undelivered event is retried after bounded exponential backoff and dead-lettered once its attempts are spent', async () => {
  const { maxAttempts, baseDelayMs, maxDelayMs, claimMs } = OUTBOX_DELIVERY_POLICY;
  assert.deepEqual([1, 2, 3, 10, 11, maxAttempts].map(retryDelayMs), [baseDelayMs, 2 * baseDelayMs, 4 * baseDelayMs, 512 * baseDelayMs, maxDelayMs, maxDelayMs]);
  const span = Array.from({ length: maxAttempts - 1 }, (_, i) => retryDelayMs(i + 1)).reduce((sum, d) => sum + d, 0);
  assert.ok(span > 2 * 60 * 60_000, `about three hours before an event is given up (${Math.round(span / 60_000)} min)`);
  assert.ok(MAX_PUBLISH_DEADLINE_MS + 2 * OUTBOX_DEADLINE_MS < claimMs, 'a pass — claim, publish, settle — ends inside its claim');
  for (const [label, publish] of [
    ['false', () => false], ['a truthy non-true', () => 'ok'], ['a throw', () => { throw new Error('publisher-secret-detail'); }],
    ['a rejection', () => Promise.reject(new Error('x'))], ['an overrun', () => new Promise(() => {})],
  ] as const) {
    const { state, clock, delivery } = pass();
    const e = envelope();
    enqueue(state, e);
    let publishes = 0;
    const counted = (env: OutboxEnvelope, signal: AbortSignal): unknown => { publishes++; return (publish as (env: OutboxEnvelope, s: AbortSignal) => unknown)(env, signal); };
    // inv: after pass n the event has been published n times and is pending, due at now + retryDelayMs(n); term: n rises to maxAttempts.
    for (let attempt = 1; attempt < maxAttempts; attempt++) {
      assert.deepEqual(await deliverOutboxBatch(delivery, counted, { deadlineMs: 20 }), { claimed: 1, acknowledged: 0, retried: 1, deadLettered: 0, lost: 0, unsettled: 0 }, `${label} #${attempt}`);
      assert.deepEqual([statusOf(state, e.eventId)?.status, statusOf(state, e.eventId)?.dueAt], ['pending', clock.t + retryDelayMs(attempt)]);
      clock.t += retryDelayMs(attempt);
    }
    assert.deepEqual(await deliverOutboxBatch(delivery, counted, { deadlineMs: 20 }), { claimed: 1, acknowledged: 0, retried: 0, deadLettered: 1, lost: 0, unsettled: 0 });
    assert.deepEqual([statusOf(state, e.eventId)?.status, statusOf(state, e.eventId)?.reason, publishes], ['dead', 'attempts_exhausted', maxAttempts], `${label}: published at most maxAttempts times`);
  }
});

test('an event whose claims outran its attempts, or whose envelope is broken, is dead-lettered unpublished; an unknown version is retried within the attempt cap', async () => {
  const { state, delivery } = pass();
  const spent = envelope();
  const broken = envelope({ payload: Object.freeze({ name: 7 }) as never });
  const newer = envelope({ version: 2 });
  enqueue(state, spent, OUTBOX_DELIVERY_POLICY.maxAttempts);
  enqueue(state, broken);
  enqueue(state, newer);
  let publishes = 0;
  assert.deepEqual(await deliverOutboxBatch(delivery, () => { publishes++; return true; }), { claimed: 3, acknowledged: 0, retried: 1, deadLettered: 2, lost: 0, unsettled: 0 });
  assert.equal(publishes, 0, 'none of them was published');
  assert.deepEqual([statusOf(state, spent.eventId)?.reason, statusOf(state, broken.eventId)?.reason], ['attempts_exhausted', 'envelope_invalid']);
  assert.equal(statusOf(state, newer.eventId)?.status, 'pending', 'a contract this worker lacks (a rolling deploy) is retried, not dead-lettered as invalid');
  const upgraded = createOutboxDelivery({ store: createMemoryOutboxDeliveryStore(state), events: [...TEST_EVENTS, { ...TEST_EVENTS[1], version: 2 }] });
  state.outbox.set(newer.eventId, { ...(statusOf(state, newer.eventId) as NonNullable<ReturnType<typeof statusOf>>), dueAt: state.now() });
  assert.equal((await deliverOutboxBatch(upgraded, () => true) as { acknowledged: number }).acknowledged, 1, 'a worker that knows it delivers it');
  // Bounded like every event: one still unknown on its last attempt is dead-lettered for an audited redrive (M8), never retried
  // forever — and one no contract could produce is dead-lettered as invalid, whatever its attempts.
  const stale = pass();
  const stranded = envelope({ version: 2 });
  const impossible = envelope({ version: 2, aggregateType: 'order' });
  for (const e of [stranded, impossible]) enqueue(stale.state, e, OUTBOX_DELIVERY_POLICY.maxAttempts - 1);
  assert.deepEqual(await deliverOutboxBatch(stale.delivery, () => true), { claimed: 2, acknowledged: 0, retried: 0, deadLettered: 2, lost: 0, unsettled: 0 });
  assert.deepEqual([stranded, impossible].map((e) => statusOf(stale.state, e.eventId)?.reason), ['attempts_exhausted', 'envelope_invalid']);
});

test('a lost acknowledgement redelivers the same event, which a consumer deduplicates by its ID', async () => {
  let losing = true;
  const { state, clock, delivery } = pass(TEST_EVENTS, (inner) => ({ ...inner, acknowledge: (r, s) => (losing ? DOWN : inner.acknowledge(r, s)) }));
  const e = envelope();
  enqueue(state, e);
  const seen: OutboxEnvelope[] = [];
  const applied = new Set<string>();
  const consumer = (env: OutboxEnvelope): true => { seen.push(env); applied.add(env.eventId); return true; };
  assert.deepEqual(await deliverOutboxBatch(delivery, consumer), { claimed: 1, acknowledged: 0, retried: 0, deadLettered: 0, lost: 0, unsettled: 1 });
  losing = false;
  clock.t += OUTBOX_DELIVERY_POLICY.claimMs;
  assert.equal((await deliverOutboxBatch(delivery, consumer) as { acknowledged: number }).acknowledged, 1);
  assert.equal(seen.length, 2, 'delivered twice: at least once, never exactly once');
  assert.deepEqual(seen[1], seen[0], 'the same immutable envelope both times');
  assert.equal(applied.size, 1, 'and a consumer keyed by eventId applies it once');
});

test('a claim that fails or breaks its contract publishes nothing; the pass options are bounded', async () => {
  for (const [answer, reason] of [[() => DOWN, 'outbox_unavailable'], [() => ({ outcome: 'claimed', events: [{ eventId: 'x' }] }), 'outbox_outcome_invalid']] as const) {
    let publishes = 0;
    assert.equal(await deliverOutboxBatch(deliveryWith({ claim: answer }), () => { publishes++; return true; }), reason);
    assert.equal(publishes, 0);
  }
  const { delivery } = pass();
  for (const options of [{ limit: 0 }, { limit: MAX_CLAIM_BATCH + 1 }, { limit: 1.5 }, { deadlineMs: 0 }, { deadlineMs: MAX_PUBLISH_DEADLINE_MS + 1 }]) {
    await assert.rejects(deliverOutboxBatch(delivery, () => true, options), RangeError, JSON.stringify(options));
  }
  let signal: AbortSignal | undefined;
  const hanging = pass();
  enqueue(hanging.state, envelope());
  const started = Date.now();
  await deliverOutboxBatch(hanging.delivery, (_e, s) => { signal = s; return new Promise(() => {}); }, { deadlineMs: 50 });
  assert.ok(signal?.aborted && Date.now() - started < 1_000, 'an overrunning publish is told to stop at the deadline');
  const claims: OutboxClaimRequest[] = [];
  await deliverOutboxBatch(deliveryWith({ claim: (r: OutboxClaimRequest) => { claims.push(r); return { outcome: 'claimed', events: [] }; } }), () => true, { limit: 5 });
  await deliverOutboxBatch(deliveryWith({ claim: (r: OutboxClaimRequest) => { claims.push(r); return { outcome: 'claimed', events: [] }; } }), () => true);
  assert.deepEqual(claims.map((c) => [c.limit, c.claimMs, /^[A-Za-z0-9_-]{43}$/.test(c.claim)]), [[5, OUTBOX_DELIVERY_POLICY.claimMs, true], [MAX_CLAIM_BATCH, OUTBOX_DELIVERY_POLICY.claimMs, true]]);
  assert.notEqual(claims[0].claim, claims[1].claim, 'a fresh fencing token per claim');
  await sleep(0);
});

test('startup refuses a malformed delivery store or event contracts', () => {
  const store = createMemoryOutboxDeliveryStore(createMemoryTransactionalState());
  const code = (raw: unknown): string | undefined => {
    try { createOutboxDelivery(raw); } catch (err) { return err instanceof EnforcementSetupError ? err.code : 'unexpected'; }
    return undefined;
  };
  assert.equal(code({ store, events: TEST_EVENTS }), undefined);
  const { probe: _probe, ...noProbe } = store;
  assert.equal(code({ store: noProbe, events: TEST_EVENTS }), 'outbox_delivery_invalid');
  assert.equal(code({ store, events: TEST_EVENTS, fallback: store }), 'outbox_delivery_invalid', 'no extra part, least of all a fallback');
  assert.equal(code({ store, events: [{ type: 'x' }] }), 'outbox_registry_invalid');
  void randomBytes;
});
