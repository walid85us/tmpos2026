// Phase 4.0 M3 — ShippingCenter behaviour after the Shipping sidecar was eliminated.
//
// Scoped deliberately: this is an ~11k-line screen, so there is no whole-page
// snapshot here. What is asserted is exactly what the elimination put at risk —
// that the screen still renders from local state, that mounting it issues no
// request to the removed backend, and that the label surface never exposes a
// provider-controlled URL.
//
// The fixture carries a shipment that ALREADY HAS a purchased label, and the
// label test opens that shipment, because the print/view surface only renders for
// a selected shipment. Without the selection the assertions would pass against an
// unrendered branch — which is exactly the surface this change replaced.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import ShippingCenter from './ShippingCenter';
import * as shippingApi from '../shipping/shippingApiClient';

// Phase 4.0 M3 — the tenant is a MUTABLE fixture, because the two things under test need
// opposite plan states. Without `shipping_providers` the screen takes the plan-disabled
// hard-purge branch (asserted below); with it, the availability probes run at all. A single
// fixed tenant could only ever exercise one of them, which is exactly why the probe
// branches previously had no end-to-end coverage.
const fixtures = vi.hoisted(() => ({
  tenant: { id: 't1', name: 'Test Store' } as { id: string; name: string; plan?: string },
}));
const TENANT_NO_PLAN = { id: 't1', name: 'Test Store' };
const TENANT_WITH_PROVIDERS = { id: 't1', name: 'Test Store', plan: 'growth' }; // shipping_providers: true

/** Every URL any code path asks for while this screen is mounted. */
const requestedUrls: string[] = [];
globalThis.fetch = ((input?: unknown) => {
  const url = typeof input === 'string'
    ? input
    : String((input as { url?: string } | undefined)?.url ?? '');
  if (url) requestedUrls.push(url);
  return Promise.resolve({
    ok: true, status: 200,
    json: () => Promise.resolve({}),
    text: () => Promise.resolve(''),
  });
}) as unknown as typeof fetch;

const noop = vi.fn();

/** Hostile stand-in for a provider-controlled label URL: it must never reach an
 *  href/src and must never be fetched. */
const LABEL_URL = 'https://provider-controlled.example/label-should-not-load.png';
const labelledShipment = {
  id: 'shp-1', shipmentNumber: 'SHP-0001', status: 'Label Created',
  type: 'outbound', sourceType: 'manual', sourceId: '', sourceNumber: '',
  carrier: 'USPS', serviceLevel: 'Priority', trackingNumber: '1Z-TEST',
  originAddress: {}, destinationAddress: {}, packages: [], events: [],
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  labelUrl: LABEL_URL,
  label: { url: LABEL_URL, format: 'png', carrier: 'USPS', service: 'Priority', trackingNumber: '1Z-TEST', cost: 9.99 },
};

// The webhook log only renders in PROVIDER mode, and `getShipmentMode` calls a shipment
// with `carrier`+`serviceLevel` and no `selectedRate` "manual" — which the label fixture
// above is. A separate provider-mode shipment reaches that surface without disturbing the
// label assertions, which depend on the fixture above staying exactly as it is.
const providerShipment = {
  ...labelledShipment,
  id: 'shp-2',
  shipmentNumber: 'SHP-0002',
  selectedRate: { carrier: 'USPS', service: 'Priority', rate: 9.99, currency: 'USD' },
};

const store = {
  shipments: [labelledShipment, providerShipment], invoices: [], repairTickets: [], rmas: [], inventoryTransfers: [],
  suppliers: [], customers: [], automationRules: [], automationLogs: [], shipmentBatches: [],
  addShipment: noop, updateShipment: noop, resolveShipmentReview: noop, setReviewOutcome: noop,
  addAutomationRule: noop, updateAutomationRule: noop, deleteAutomationRule: noop,
  bumpAutomationRuleStats: noop, appendAutomationLogs: noop, addShipmentBatch: noop,
  updateShipmentBatch: noop, startPacking: noop, recordPackingItemVerification: noop,
  recordPackingPackageVerification: noop, addPackingException: noop, resolvePackingException: noop,
  completePackingForShipment: noop, reopenPacking: noop, markPackingNotRequired: noop,
  setShippingProviderConfig: noop,
};

// Availability is REAL state, not a constant: ShippingCenter both reads and writes it,
// so a fixed value would hide a failure to adopt the shared slice and make the
// fail-closed `unknown` window untestable. The mocked hook runs during the component's
// render, so `useState` here is a legitimate hook call owned by that component.
vi.mock('../context/StoreLocalState', async () => {
  const react = await import('react');
  return {
    useStoreLocalState: () => {
      const [shippingServiceAvailability, setShippingServiceAvailability] =
        react.useState<'unknown' | 'available' | 'unavailable'>('unknown');
      return { ...store, shippingServiceAvailability, setShippingServiceAvailability };
    },
  };
});
vi.mock('../context/AccessContext', () => ({
  useAccess: () => ({
    checkPermission: () => true,
    checkSubPermission: () => true,
    hasPermission: () => true,
    isWriteBlocked: false,
    canAccess: () => true,
    tenant: fixtures.tenant,
    session: { user: { name: 'Tester' } },
  }),
}));

// The REAL containment client, wrapped in spies. Not a hand-written stub: the point is to
// prove the screen's behaviour against the envelope the shipped client actually returns
// (`success:false` / SHIPPING_UNAVAILABLE), while still being able to count invocations.
// A stub could drift from the client and quietly assert against a fiction.
vi.mock('../shipping/shippingApiClient', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../shipping/shippingApiClient')>();
  return {
    ...actual,
    getActiveProvider: vi.fn(actual.getActiveProvider),
    getProvidersStatus: vi.fn(actual.getProvidersStatus),
    setActiveProvider: vi.fn(actual.setActiveProvider),
    removeProviderCredentials: vi.fn(actual.removeProviderCredentials),
    getWebhookLog: vi.fn(actual.getWebhookLog),
  };
});

function renderCenter() {
  return render(
    <MemoryRouter initialEntries={['/shipping']}>
      <ShippingCenter />
    </MemoryRouter>,
  );
}

/** Open the labelled shipment so the label/print surface actually renders. */
async function openLabelledShipment() {
  await waitFor(() => expect(screen.getAllByText(/SHP-0001/).length).toBeGreaterThan(0));
  fireEvent.click(screen.getAllByText(/SHP-0001/)[0]);
  // Positive control: the branch under test really rendered.
  await waitFor(() => expect(screen.queryByTestId('label-preview-unavailable')).not.toBeNull());
}

beforeEach(() => {
  requestedUrls.length = 0;
  vi.clearAllMocks();
  fixtures.tenant = TENANT_NO_PLAN;
});
afterEach(() => { fixtures.tenant = TENANT_NO_PLAN; });

describe('ShippingCenter — migration containment', () => {
  it('still renders its local Shipping UI with the backend gone', async () => {
    const { container } = renderCenter();
    await waitFor(() => expect(container.textContent).toMatch(/shipment/i));
    expect(container.textContent!.length).toBeGreaterThan(0);
  });

  it('requests nothing from the removed Shipping backend on mount', async () => {
    renderCenter();
    await new Promise((r) => setTimeout(r, 80));
    // The legacy path is gone, so it must not even be attempted-and-failed.
    expect(requestedUrls.filter((u) => u.includes('/api/shipping'))).toEqual([]);
    expect(requestedUrls.filter((u) => u.includes('label-proxy'))).toEqual([]);
    // And nothing reaches a carrier directly from the browser either.
    expect(requestedUrls.filter((u) => /easypost|goshippo|shipstation/i.test(u))).toEqual([]);
  });

  it('shows a bounded label-preview unavailable state instead of the label', async () => {
    renderCenter();
    await openLabelledShipment();
    const banner = screen.getByTestId('label-preview-unavailable');
    expect(banner.textContent).toMatch(/unavailable/i);
    expect(banner.querySelector('.material-symbols-outlined')).toBeTruthy();
  });

  // Phase 4.0 M3 accessibility acceptance for the new unavailable state. Focused
  // assertions, not a snapshot: what matters is that the state is perceivable without
  // colour, announced when it appears, and leaks nothing into an accessible name.
  it('announces the unavailable state with a status semantic, icon, and words', async () => {
    renderCenter();
    await openLabelledShipment();
    const banner = screen.getByTestId('label-preview-unavailable');

    // Perceivable without colour: a real icon AND real words, not a coloured chip.
    expect(banner.querySelector('.material-symbols-outlined')).toBeTruthy();
    expect(banner.textContent!.trim().length).toBeGreaterThan(0);
    expect(banner.textContent).toMatch(/unavailable/i);
    // Announced: it appears asynchronously once a shipment is selected.
    expect(banner.getAttribute('role')).toBe('status');
  });

  it('puts no provider URL or credential into an accessible name or description', async () => {
    const { container } = renderCenter();
    await openLabelledShipment();
    // aria-label / aria-describedby text / title are read aloud — a URL hidden there is
    // still exposed, and is invisible to a DOM-text-only check.
    const named = container.querySelectorAll('[aria-label],[title],[aria-describedby]');
    for (const el of Array.from(named)) {
      const describedBy = (el.getAttribute('aria-describedby') ?? '')
        .split(/\s+/).filter(Boolean)
        .map((id) => container.ownerDocument.getElementById(id)?.textContent ?? '')
        .join(' ');
      const accessible = `${el.getAttribute('aria-label') ?? ''} ${el.getAttribute('title') ?? ''} ${describedBy}`;
      expect(accessible).not.toContain('provider-controlled.example');
      expect(accessible).not.toMatch(/apiKey|apiSecret|accountId/);
    }
  });

  it('exposes no activatable control on the label surface', async () => {
    renderCenter();
    await openLabelledShipment();
    // Measured: there are ZERO `button[disabled]` here, so asserting over them proved
    // nothing. The label controls were REMOVED, not disabled, so the falsifiable
    // invariant is that this surface carries no interactive control at all — restoring
    // the print/view buttons makes this non-empty and fails.
    const banner = screen.getByTestId('label-preview-unavailable');
    expect(banner.querySelectorAll('button, a, input, select, [tabindex], [role="button"]')).toHaveLength(0);
    // Nothing may fake a disabled state with styling while staying focusable. Asserted
    // as an emptiness check: looping a known-empty collection proves nothing.
    expect(banner.querySelectorAll('[aria-disabled="true"]:not([disabled])')).toHaveLength(0);
  });

  // Phase 4.0 M3 regression guard. The plan-downgrade hard-purge treated ONLY a thrown
  // exception as failure. The containment client resolves `{success:false}` and never
  // throws, so `serverPurgeFailed` stayed false and the "credentials may not have been
  // cleared" warning was suppressed — the operator was told the purge succeeded when
  // nothing was purged. (This fixture has no `tenant.plan`, so the plan gate is closed
  // and this branch really runs.)
  it('warns that server-side credentials may not have been cleared when the purge cannot succeed', async () => {
    renderCenter();
    await openLabelledShipment();
    await waitFor(() =>
      expect(screen.getByText(/some server-side credentials may not have been cleared/i))
        .toBeInTheDocument(),
    );
  });

  // Phase 4.0 M3 — `loadWebhookLog` read `result.events || []` and never read `success`.
  // The unavailable envelope carries no `events`, so it collapsed to `[]` and rendered
  // "No webhook events recorded yet." — a POSITIVE claim about the carrier's history,
  // made from a call that returned nothing. An operator checking whether a webhook
  // arrived would be told, definitively, that none did.
  it('does not render an unavailable webhook log as an empty one', async () => {
    renderCenter();
    // Provider-mode shipment: the webhook surface is unrendered in manual mode.
    await waitFor(() => expect(screen.getAllByText(/SHP-0002/).length).toBeGreaterThan(0));
    fireEvent.click(screen.getAllByText(/SHP-0002/)[0]);

    const toggle = await screen.findByRole('button', { name: /webhook log/i });
    fireEvent.click(toggle);

    await waitFor(() => expect(screen.getByTestId('webhook-log-unavailable')).toBeInTheDocument());
    const banner = screen.getByTestId('webhook-log-unavailable');
    expect(banner.textContent).toMatch(/unavailable/i);
    expect(banner.querySelector('.material-symbols-outlined')).toBeTruthy();
    // The false-healthy claim must be gone, not merely accompanied by a warning.
    expect(screen.queryByText(/No webhook events recorded yet/i)).toBeNull();
  });


  it('never exposes the provider label URL for a shipment that HAS a label', async () => {
    const { container } = renderCenter();
    await openLabelledShipment();
    // The removed print/view controls opened `pdfUrl || label.url`. That URL must
    // appear nowhere in the DOM, in any attribute, and must never be requested.
    expect(container.innerHTML).not.toContain('provider-controlled.example');
    for (const el of Array.from(container.querySelectorAll('[href],[src]'))) {
      const v = (el.getAttribute('href') ?? '') + (el.getAttribute('src') ?? '');
      expect(v).not.toContain('provider-controlled.example');
      expect(v).not.toMatch(/label-proxy/);
    }
    expect(requestedUrls.filter((u) => u.includes('provider-controlled.example'))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Phase 4.0 M3 — the availability PROBE sites, with the plan gate actually passed.
//
// These branches previously had no end-to-end guard, and the reason was a fixture bug
// rather than a design limit: the tenant carried no `plan`, so `isPlanFeatureLive
// ('shipping_providers')` was false and the effect took the plan-disabled purge branch.
// `getActiveProvider` / `getProvidersStatus` were never called, so every assertion about
// their result handling would have been made against an unrendered branch.
//
// `plan: 'growth'` is the minimum context that opens the gate (the feature matrix marks
// shipping_providers true for growth/advanced, false for essential). The first test below
// asserts the gate is open before anything else is claimed — a positive control, so a
// future fixture regression fails loudly here instead of silently emptying the suite.
// ---------------------------------------------------------------------------
describe('ShippingCenter — availability probes (plan gate open)', () => {
  beforeEach(() => { fixtures.tenant = TENANT_WITH_PROVIDERS; });

  /** Select the provider-mode shipment; its detail panel hosts the provider surfaces. */
  async function openProviderShipment() {
    await waitFor(() => expect(screen.getAllByText(/SHP-0002/).length).toBeGreaterThan(0));
    fireEvent.click(screen.getAllByText(/SHP-0002/)[0]);
  }

  it('POSITIVE CONTROL: the plan gate is open, so the probes actually run', async () => {
    renderCenter();
    // Proves the operations are INVOKED. Without the plan the mount effect takes the
    // purge branch and neither of these is ever called.
    await waitFor(() => expect(shippingApi.getActiveProvider).toHaveBeenCalled());
    await waitFor(() => expect(shippingApi.getProvidersStatus).toHaveBeenCalled());
    // And the plan-disabled branch must NOT have run: its purge warning is the tell.
    expect(screen.queryByText(/some server-side credentials may not have been cleared/i)).toBeNull();
  });

  it('the probed client really returns success:false, not a fabricated success', async () => {
    // The assertions below are only meaningful if the envelope under test is a genuine
    // failure. Checked against the real client, not a stub's promise.
    const active = await shippingApi.getActiveProvider();
    const status = await shippingApi.getProvidersStatus();
    expect(active.success).toBe(false);
    expect(status.success).toBe(false);
    if (active.success === false) expect(active.error.code).toBe(shippingApi.SHIPPING_UNAVAILABLE_CODE);
    // The failure envelope carries NO success-only data for a careless caller to read.
    expect(Object.prototype.hasOwnProperty.call(status, 'providers')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(active, 'activeProviderId')).toBe(false);
  });

  it('renders the explicit unavailable state with an icon and words, announced', async () => {
    renderCenter();
    await openProviderShipment();
    const banner = await screen.findByTestId('shipping-unavailable-banner');
    // Perceivable without colour: a real icon AND real words.
    expect(banner.querySelector('.material-symbols-outlined')).toBeTruthy();
    expect(banner.textContent).toMatch(/unavailable/i);
    // Announced, and non-assertive: it reports a condition, not the outcome of an action.
    expect(banner.getAttribute('role')).toBe('status');
    expect(banner.getAttribute('aria-live')).toBe('polite');
    // It must say the outage is not a statement about the store's configuration.
    expect(banner.textContent).toMatch(/does not mean your store has no provider configured/i);
  });

  // DISCLOSED COVERAGE BOUNDARY (mutation-verified): the mount effect runs the
  // `getActiveProvider` availability guard and then, unconditionally, `loadProviderStatuses()`
  // — which re-derives availability from a second (also failing) call. So inverting the mount
  // guard ALONE changes nothing observable: loadProviderStatuses sets the rendered state, and
  // MUT-B proves THAT guard is load-bearing. The mount guard's distinct job — not overwriting a
  // prior GOOD activeProviderIdRaw with a failed envelope — cannot be exercised here because the
  // containment client never returns a success to establish that prior value. So the assertions
  // below cover `loadProviderStatuses` + `refreshProviderState`; the mount `getActiveProvider`
  // availability write is not independently observable under the always-unavailable client.
  it('applies no success-only data and renders no healthy or provider-verdict state', async () => {
    const { container } = renderCenter();
    await openProviderShipment();
    await screen.findByTestId('shipping-unavailable-banner');

    // The failure envelope has no `activeProviderId`/`providers`, so nothing may be shown
    // as connected, verified, or active off the back of a failed probe.
    expect(screen.queryByText(/^Connected$/i)).toBeNull();
    expect(screen.queryByText(/^Verified$/i)).toBeNull();
    // Nor may the outage be reported as a carrier verdict.
    expect(screen.queryByText(/connection test failed/i)).toBeNull();
    // A failed probe must not surface the client's internal error code to the operator.
    expect(container.textContent).not.toContain(shippingApi.SHIPPING_UNAVAILABLE_CODE);
  });

  it('does not retry in a loop and reaches no network', async () => {
    renderCenter();
    await openProviderShipment();
    await screen.findByTestId('shipping-unavailable-banner');
    // Let any runaway effect chain settle before counting.
    await new Promise((r) => setTimeout(r, 250));

    // A bounded number of probes. An unstable callback identity previously refired the
    // status effect on every render — an unbounded request loop; this is the guard.
    const activeCalls = (shippingApi.getActiveProvider as unknown as { mock: { calls: unknown[] } }).mock.calls.length;
    const statusCalls = (shippingApi.getProvidersStatus as unknown as { mock: { calls: unknown[] } }).mock.calls.length;
    expect(activeCalls).toBeGreaterThan(0);
    expect(activeCalls).toBeLessThanOrEqual(5);
    expect(statusCalls).toBeLessThanOrEqual(5);

    // And no probe path opens a direct or proxied connection.
    expect(requestedUrls.filter((u) => u.includes('/api/shipping'))).toEqual([]);
    expect(requestedUrls.filter((u) => /easypost|goshippo|shipstation/i.test(u))).toEqual([]);
  });
});
