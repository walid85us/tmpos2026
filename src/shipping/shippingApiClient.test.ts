// Phase 4.0 M3 — Shipping client migration-containment contract.
//
// The legacy DEV sidecar that backed every operation below was ELIMINATED
// (22 unauthenticated routes incl. an arbitrary-URL label proxy). The client
// keeps its exported surface so callers still compile, but performs NO network
// call at all: each operation resolves to a bounded, non-retryable
// SHIPPING_UNAVAILABLE envelope.
//
// This suite is the guard against the two ways that could go wrong: a
// reintroduced fetch (the sidecar creeping back), and a fabricated success
// (a caller shown rates/labels/credentials that do not exist). It also pins the
// non-throwing contract — four call sites in ShippingCenter have no try/catch,
// so a throw here becomes a permanently stuck spinner in the UI.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as client from './shippingApiClient';

/** If this value ever appears in a response, the client echoed caller input. */
const SENTINEL = 'SENTINEL_SECRET_MUST_NOT_ECHO';

let fetchCalls = 0;
let logCalls = 0;

globalThis.fetch = ((..._args: unknown[]) => {
  fetchCalls++;
  throw new Error('the Shipping client must never call fetch');
}) as unknown as typeof fetch;

for (const m of ['log', 'warn', 'error', 'info', 'debug'] as const) {
  const original = console[m].bind(console);
  console[m] = ((...a: unknown[]) => { logCalls++; original(...a); }) as typeof console[typeof m];
}

const addr = {
  name: 'Test', line1: '1 Main St', city: 'Springfield', state: 'IL', postalCode: '62701', country: 'US',
} as never;
const pkg = { weight: 1, length: 1, width: 1, height: 1 } as never;

/** Every exported operation that used to reach the sidecar. */
const OPERATIONS: { name: string; run: () => Promise<Record<string, unknown>> }[] = [
  { name: 'storeProviderCredentials', run: () => client.storeProviderCredentials('easypost', { apiKey: SENTINEL }, 'test') as never },
  { name: 'removeProviderCredentials', run: () => client.removeProviderCredentials('easypost') as never },
  { name: 'setActiveProvider', run: () => client.setActiveProvider('easypost') as never },
  { name: 'getActiveProvider', run: () => client.getActiveProvider() as never },
  { name: 'getProvidersStatus', run: () => client.getProvidersStatus() as never },
  { name: 'testConnection', run: () => client.testConnection('easypost') as never },
  { name: 'validateAddress', run: () => client.validateAddress(addr) as never },
  { name: 'getRates', run: () => client.getRates(addr, addr, [pkg]) as never },
  { name: 'purchaseLabel', run: () => client.purchaseLabel(addr, addr, [pkg], 'rate_1', 'USPS', 'Priority', SENTINEL) as never },
  { name: 'createProviderPickup', run: () => client.createProviderPickup({ pickupAddress: addr, minDatetime: 'a', maxDatetime: 'b' }) as never },
  { name: 'buyProviderPickup', run: () => client.buyProviderPickup('pickup_1', 'rate_1') as never },
  { name: 'cancelProviderPickup', run: () => client.cancelProviderPickup('pickup_1') as never },
  { name: 'syncTracking', run: () => client.syncTracking(SENTINEL, 'USPS') as never },
  { name: 'bulkSyncTracking', run: () => client.bulkSyncTracking([{ shipmentId: 's1', trackingNumber: SENTINEL }]) as never },
  { name: 'simulateTrackingEvent', run: () => client.simulateTrackingEvent(SENTINEL, 'USPS') as never },
  { name: 'getWebhookLog', run: () => client.getWebhookLog({ providerId: 'easypost' }) as never },
  { name: 'replayWebhookEvent', run: () => client.replayWebhookEvent('evt_1') as never },
];

test('every Shipping operation resolves to a bounded, non-retryable unavailable envelope', async () => {
  assert.equal(OPERATIONS.length, 17, 'all 17 formerly-networked operations must be covered');
  for (const op of OPERATIONS) {
    let result: Record<string, unknown>;
    try {
      result = await op.run();
    } catch (err) {
      assert.fail(`${op.name} threw instead of resolving: ${err instanceof Error ? err.message : String(err)}`);
    }
    assert.equal(typeof result, 'object', `${op.name}: must resolve to an object`);
    assert.equal(result.success, false, `${op.name}: success must be false`);

    const error = result.error as Record<string, unknown> | undefined;
    assert.ok(error, `${op.name}: must carry an error`);
    assert.equal(error.code, 'SHIPPING_UNAVAILABLE', `${op.name}: bounded code`);
    assert.equal(error.retryable, false, `${op.name}: must not invite a retry`);
    assert.equal(typeof error.message, 'string', `${op.name}: message must be a string`);
    assert.ok((error.message as string).length > 0 && (error.message as string).length <= 200, `${op.name}: bounded message`);
  }
});

test('no operation fabricates provider, credential, rate, label, or tracking data', async () => {
  for (const op of OPERATIONS) {
    const result = await op.run();
    const serialized = JSON.stringify(result);
    assert.ok(!serialized.includes(SENTINEL), `${op.name}: echoed caller input back`);

    // Outright fabrication: these keys must never be populated.
    for (const key of ['rates', 'label', 'results', 'summary', 'maskedCredentials', 'credentials', 'message', 'providerShipmentId', 'confirmationNumber']) {
      assert.equal(result[key], undefined, `${op.name}: must not fabricate '${key}'`);
    }
    // Shape-preserving empties are allowed, populated ones are not.
    if ('providers' in result) assert.deepEqual(result.providers, [], `${op.name}: providers must be empty`);
    if ('events' in result) assert.deepEqual(result.events, [], `${op.name}: events must be empty`);
    if ('activeProviderId' in result) assert.equal(result.activeProviderId, null, `${op.name}: no active provider`);
    if ('total' in result) assert.equal(result.total, 0, `${op.name}: no webhook events`);
  }
});

test('the client performs no network call and no logging, and never retries', async () => {
  const before = fetchCalls;
  for (const op of OPERATIONS) { await op.run(); await op.run(); }
  assert.equal(fetchCalls, before, 'no operation may call fetch, on first call or retry');
  assert.equal(fetchCalls, 0, 'the client must be entirely network-free');
  assert.equal(logCalls, 0, 'the client must not log');
});

test('the locator surface is preserved — it never depended on the sidecar', () => {
  assert.equal(typeof client.findServicePoints, 'function');
  assert.equal(typeof client.isAnyLocatorConfigured, 'function');
  assert.equal(typeof client.getConfiguredCarriers, 'function');
});
