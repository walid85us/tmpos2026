// Phase 4.0 M3 — runtime shipping-service availability is a SEPARATE slice from the
// stored provider configuration.
//
// The distinction is the whole point. "The shipping service is unreachable" and "this
// store has no provider configured" are different facts with different remedies, and
// the page previously collapsed them: on an unavailable response it nulled the shared
// config, so an outage was recorded as a configuration change. The operator was then
// shown an unconfigured store and invited to re-enter credentials — reconstructing
// state that was never actually lost.
//
// These tests pin the two invariants that prevent that:
//   1. availability is three-valued and starts `unknown` (fail-closed, not assumed up)
//   2. writing availability NEVER writes configuration
import { useEffect } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, act, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { StoreLocalStateProvider, useStoreLocalState } from './StoreLocalState';
import ShippingCenter from '../components/ShippingCenter';
import type { ShippingProviderConfig } from '../types';

// The provider reads exactly one thing from access context — `session?.role`, to detect a
// role change. The remaining fields exist only for the co-render test at the bottom, which
// mounts the real ShippingCenter and, through it, the real ShippingProvidersPage.
// `plan: 'growth'` is the minimum that opens the `shipping_providers` plan gate; without it
// the screen takes the plan-disabled branch and never probes availability at all.
vi.mock('./AccessContext', () => ({
  useAccess: () => ({
    session: { role: 'system_owner', user: { name: 'Tester' } },
    tenant: { id: 't1', name: 'Test Store', plan: 'growth' },
    checkPermission: () => true,
    checkSubPermission: () => true,
    hasPermission: () => true,
    canAccess: () => true,
    isWriteBlocked: false,
  }),
}));

type Ctx = ReturnType<typeof useStoreLocalState>;
let ctx: Ctx;

function Probe() {
  ctx = useStoreLocalState();
  return (
    <div>
      <span data-testid="availability">{ctx.shippingServiceAvailability}</span>
      <span data-testid="config">{ctx.shippingProviderConfig?.providerId ?? 'NO_CONFIG'}</span>
    </div>
  );
}

function renderProbe() {
  return render(
    <StoreLocalStateProvider>
      <Probe />
    </StoreLocalStateProvider>,
  );
}

// No credential VALUES anywhere — only the masked display form the store already holds.
const CONFIG: ShippingProviderConfig = {
  providerId: 'easypost',
  providerName: 'EasyPost',
  status: 'configured',
  isDefault: false,
  credentials: {} as ShippingProviderConfig['credentials'],
  credentialsMasked: { apiKey: '••••1234' },
  environment: 'test',
  configuredAt: '2026-01-01T00:00:00.000Z',
  configuredBy: 'Current User',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

const availability = () => screen.getByTestId('availability').textContent;
const config = () => screen.getByTestId('config').textContent;

describe('StoreLocalState — shipping service availability', () => {
  it('starts unknown, so an unprobed service is never assumed reachable', () => {
    renderProbe();
    // A boolean cannot express this: `false` reads as "probed and down" and `true` as
    // "reachable", so the pre-probe window necessarily lies in one direction or the
    // other. `unknown` is the state that lets callers fail closed until they know.
    expect(availability()).toBe('unknown');
  });

  it('carries availability independently of whether a provider is configured', () => {
    renderProbe();
    // Availability moves while configuration stays empty: the two are not coupled.
    expect(config()).toBe('NO_CONFIG');
    act(() => { ctx.setShippingServiceAvailability('available'); });
    expect(availability()).toBe('available');
    expect(config()).toBe('NO_CONFIG');
  });

  it('an outage does not erase the stored provider configuration', () => {
    renderProbe();
    act(() => { ctx.setShippingProviderConfig(CONFIG); });
    expect(config()).toBe('easypost');

    act(() => { ctx.setShippingServiceAvailability('unavailable'); });

    // The outage IS recorded — this is not a test that unavailability is ignored.
    expect(availability()).toBe('unavailable');
    // But it is recorded as an outage, not as "no provider configured". This is the
    // exact write the page used to perform, and the reason recovery needed the
    // operator to re-enter credentials that were never lost.
    expect(config()).toBe('easypost');
  });

  it('recovers to available without reconstructing the configuration', () => {
    renderProbe();
    act(() => { ctx.setShippingProviderConfig(CONFIG); });
    act(() => { ctx.setShippingServiceAvailability('unavailable'); });
    act(() => { ctx.setShippingServiceAvailability('available'); });

    // Recovery is representable as a single availability transition. Nothing has to
    // be rebuilt, because nothing was destroyed.
    expect(availability()).toBe('available');
    expect(config()).toBe('easypost');
  });

  it('still lets configuration be cleared deliberately, independently of availability', () => {
    renderProbe();
    act(() => { ctx.setShippingProviderConfig(CONFIG); });
    act(() => { ctx.setShippingServiceAvailability('available'); });

    // A genuine removal is a CONFIG write, and it must not disturb availability —
    // otherwise the fix would just invert the original coupling.
    act(() => { ctx.setShippingProviderConfig(null); });
    expect(config()).toBe('NO_CONFIG');
    expect(availability()).toBe('available');
  });
});

// ---------------------------------------------------------------------------
// Phase 4.0 M3 — the SHARED-CONTEXT behaviour, not a mocked stand-in for it.
//
// The tests above drive the context directly, and the component suites mock this module.
// Neither proves the thing that actually matters in production: ShippingCenter and
// ShippingProvidersPage are co-rendered (the Settings tab embeds the page) and read the
// SAME provider instance, so a write by one is immediately visible to the other. A
// per-component mock gives each consumer its own private state and would keep passing even
// if the two had been wired to different providers entirely.
//
// So this renders the REAL provider with the REAL ShippingCenter, opens the Settings tab
// to bring the embedded ShippingProvidersPage into the same tree, and asserts on
// user-visible output.
// ---------------------------------------------------------------------------
/** Seeds a provider the store configured earlier in the session. Synthetic, non-secret. */
function Seeder({ config }: { config: ShippingProviderConfig }) {
  const { setShippingProviderConfig } = useStoreLocalState();
  useEffect(() => { setShippingProviderConfig(config); }, [setShippingProviderConfig, config]);
  return null;
}

describe('StoreLocalState — ShippingCenter and ShippingProvidersPage over one real context', () => {
  function renderCoRendered() {
    return render(
      <MemoryRouter initialEntries={['/shipping']}>
        <StoreLocalStateProvider>
          <Seeder config={CONFIG} />
          <Probe />
          <ShippingCenter />
        </StoreLocalStateProvider>
      </MemoryRouter>,
    );
  }

  /** Bring the embedded ShippingProvidersPage into the tree via the Settings tab. */
  async function openSettingsTab() {
    const tab = await screen.findByRole('button', { name: /settings/i });
    fireEvent.click(tab);
    // Positive control: the embedded page really mounted. Its unavailable banner is a
    // ShippingProvidersPage-only testid, so finding it proves the co-render happened.
    return screen.findByTestId('shipping-service-unavailable');
  }

  it('co-renders both consumers against one provider instance', async () => {
    renderCoRendered();
    await waitFor(() => expect(config()).toBe('easypost'));
    await openSettingsTab();
    // ShippingCenter drove availability from its own probe; the embedded page is reading
    // that same value. If they held separate state this would still say `unknown`.
    expect(availability()).toBe('unavailable');
  });

  it('an outage from the live probe preserves the configured provider', async () => {
    renderCoRendered();
    await waitFor(() => expect(config()).toBe('easypost'));
    await openSettingsTab();

    // The outage is recorded...
    expect(availability()).toBe('unavailable');
    // ...and the configuration a real store had is untouched. This is the invariant the
    // page broke by calling setShippingProviderConfig(null) on an unavailable response.
    expect(config()).toBe('easypost');
  });

  it('neither consumer concludes "no provider configured" from the outage', async () => {
    renderCoRendered();
    const banner = await openSettingsTab();

    // The page states the real cause, with an icon and words rather than colour alone.
    expect(banner.textContent).toMatch(/unavailable/i);
    expect(banner.querySelector('.material-symbols-outlined')).toBeTruthy();
    expect(banner.getAttribute('role')).toBe('status');
    // Unavailability takes precedence over the configuration claim, in both the active
    // provider summary and each provider card's status badge.
    expect(await screen.findByTestId('active-provider-unavailable')).toBeInTheDocument();
    expect(screen.getAllByTestId('provider-status-unavailable').length).toBeGreaterThan(0);
    // The false claims must be absent, not merely accompanied by a warning.
    expect(screen.queryByText(/^No provider selected$/)).toBeNull();
    expect(screen.queryByText(/^Not Configured$/)).toBeNull();
  });

  it('leaves every backend-backed control blocked while unavailable', async () => {
    renderCoRendered();
    await openSettingsTab();
    // `writesBlocked` is availability !== 'available', so these are not rendered at all.
    // Asserted as absence of the control, because a control that is merely styled as
    // disabled can still be activated.
    expect(screen.queryByRole('button', { name: /save credentials/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /set active/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /deactivate/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /^remove$/i })).toBeNull();
  });

  it('renders no credential-like value and settles without a refetch loop', async () => {
    const getStatusSpy = vi.spyOn(await import('../shipping/shippingApiClient'), 'getProvidersStatus');
    const { container } = renderCoRendered();
    await openSettingsTab();
    await new Promise((r) => setTimeout(r, 250));

    // The seeded config carries only a MASKED display string; no credential value exists
    // in this fixture, and nothing may synthesise one into the DOM.
    expect(container.textContent).not.toMatch(/apiSecret|accountId/);
    expect(container.textContent).not.toContain('SHIPPING_UNAVAILABLE');
    // An unstable `fetchStatus` identity previously refired its effect every render.
    expect(getStatusSpy.mock.calls.length).toBeLessThanOrEqual(6);
    getStatusSpy.mockRestore();
  });
});
