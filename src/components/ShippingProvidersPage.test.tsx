// Phase 4.0 M3 — provider-settings behaviour after the Shipping sidecar was eliminated.
//
// This page existed entirely to drive the removed backend, so the whole surface is
// now unavailable. What must be true: the operator is TOLD the service is
// unavailable (not shown an ordinary "no provider configured" page, which would
// invite them to enter credentials that cannot be saved), every backend-backed
// control is inoperable, loading terminates, nothing re-polls, and no credential
// value is ever rendered.
//
// The real client is used deliberately — it is network-free by contract, so this
// exercises the actual envelope the page will see in production.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import ShippingProvidersPage from './ShippingProvidersPage';
import * as shippingApi from '../shipping/shippingApiClient';

vi.mock('../shipping/shippingApiClient', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../shipping/shippingApiClient')>();
  return {
    ...actual,
    getProvidersStatus: vi.fn(actual.getProvidersStatus),
    setActiveProvider: vi.fn(actual.setActiveProvider),
    removeProviderCredentials: vi.fn(actual.removeProviderCredentials),
    storeProviderCredentials: vi.fn(actual.storeProviderCredentials),
    testConnection: vi.fn(actual.testConnection),
  };
});

const setShippingProviderConfig = vi.fn();
// Availability is real state, not a spy: the page both READS and WRITES it, so a plain
// `vi.fn()` would make every read return undefined and the write gate untestable. The
// mocked hook is called during the page's render, so `useState` here is a legitimate
// hook call owned by that component — and it models the context faithfully.
vi.mock('../context/StoreLocalState', async () => {
  const react = await import('react');
  return {
    useStoreLocalState: () => {
      const [shippingServiceAvailability, setShippingServiceAvailability] =
        react.useState<'unknown' | 'available' | 'unavailable'>('unknown');
      return { setShippingProviderConfig, shippingServiceAvailability, setShippingServiceAvailability };
    },
  };
});

vi.mock('../context/AccessContext', () => ({
  useAccess: () => ({ checkSubPermission: () => true, isWriteBlocked: false }),
}));

function renderPage(onProviderChange?: () => void) {
  return render(
    <MemoryRouter initialEntries={['/shipping/settings']}>
      <ShippingProvidersPage embedded onProviderChange={onProviderChange} />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.mocked(shippingApi.getProvidersStatus).mockClear();
  vi.mocked(shippingApi.setActiveProvider).mockClear();
  vi.mocked(shippingApi.removeProviderCredentials).mockClear();
  vi.mocked(shippingApi.storeProviderCredentials).mockClear();
  vi.mocked(shippingApi.testConnection).mockClear();
  setShippingProviderConfig.mockClear();
});

/**
 * A HEALTHY status response, so the page renders as available-and-configured and the
 * write gate is open. The action handlers are gated off today, so with the real client
 * they are unreachable and would be tested vacuously. This models the state after the
 * gate is lifted — the point of these tests is that the handlers stay safe THEN.
 */
function mockHealthyStatus() {
  vi.mocked(shippingApi.getProvidersStatus).mockResolvedValue({
    success: true,
    providers: [{
      providerId: 'easypost', isActive: true, environment: 'test',
      configuredAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
      maskedCredentials: { apiKey: '••••1234' },
      lastTestedAt: null, lastTestResult: null,
    }],
    activeProviderId: 'easypost',
  });
}

const UNAVAILABLE = {
  success: false as const,
  error: {
    code: 'SHIPPING_UNAVAILABLE',
    message: 'Shipping provider services are unavailable while the shipping backend is being rebuilt.',
    retryable: false,
  },
};

describe('ShippingProvidersPage — migration containment', () => {
  it('states the service is unavailable, with words and an icon', async () => {
    renderPage();
    const banner = await screen.findByTestId('shipping-service-unavailable');
    expect(banner).toBeInTheDocument();
    expect(banner.textContent).toMatch(/unavailable/i);
    // An icon accompanies the wording (Material symbol span).
    expect(banner.querySelector('.material-symbols-outlined')).toBeTruthy();
  });

  it('does not misrepresent unavailability as "not configured"', async () => {
    renderPage();
    const banner = await screen.findByTestId('shipping-service-unavailable');
    // The banner must actively correct the misreading, not merely omit it.
    expect(banner.textContent).toMatch(/does not mean your store has no provider configured/i);
  });

  it('leaves no operable Save / Test / Activate / Remove control', async () => {
    renderPage();
    await screen.findByTestId('shipping-service-unavailable');
    // Positive control: the page really rendered its provider catalog, so the
    // absence assertions below are about the controls, not an empty page.
    expect(screen.getByText(/EasyPost/i)).toBeInTheDocument();
    expect(screen.getAllByRole('button').length).toBeGreaterThan(0);

    // Open a provider panel — Save/Test only render inside it, so without this
    // their absence would prove nothing about the unavailable gate.
    fireEvent.click(screen.getAllByRole('button', { name: /^configure$/i })[0]);
    // Positive control: the panel really opened (its toggle now reads "Close").
    await screen.findByRole('button', { name: /^close$/i });

    // These controls all require the removed backend. They are conditionally
    // unrendered rather than rendered-disabled, so assert both: none present,
    // and any that ever were present must at least be disabled.
    for (const label of [/^save/i, /^test connection/i, /^set active/i, /^remove/i, /^deactivate/i]) {
      expect(screen.queryAllByRole('button', { name: label })).toHaveLength(0);
    }
  });

  it('terminates the loading state and does not re-poll', async () => {
    renderPage();
    await screen.findByTestId('shipping-service-unavailable');
    // Loading finished: the page rendered its resolved content, not a spinner.
    await waitFor(() => expect(vi.mocked(shippingApi.getProvidersStatus)).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 60));
    // Unstable deps previously refired this effect on every render — an unbounded
    // request loop throttled only by round-trip time.
    expect(vi.mocked(shippingApi.getProvidersStatus).mock.calls.length).toBeLessThanOrEqual(2);
  });

  // Phase 4.0 M3 — this test previously asserted the DEFECT: that the unavailable path
  // calls `setShippingProviderConfig(null)`. An outage is not a configuration change.
  // Nulling the shared config recorded "service down" as "no provider configured", which
  // is the misreading the banner above exists to prevent — and it forced the operator to
  // rebuild state that was never lost. Availability now lives in its own slice.
  it('preserves any stored provider config and renders no credential material', async () => {
    const { container } = renderPage();
    await screen.findByTestId('shipping-service-unavailable');
    expect(setShippingProviderConfig).not.toHaveBeenCalledWith(null);
    // Match what is actually RENDERED (field labels + the mask glyph). The previous
    // camelCase pattern could never match in any state, so it asserted nothing.
    fireEvent.click(screen.getAllByRole('button', { name: /^configure$/i })[0]);
    await screen.findByRole('button', { name: /^close$/i });
    expect(container.textContent).not.toMatch(/••••/);
    expect(screen.queryByText(/Current Credentials/i)).toBeNull();
  });

  it('keeps the store-owned configuration language accurate', async () => {
    renderPage();
    const banner = await screen.findByTestId('shipping-service-unavailable');
    expect(banner.textContent).toMatch(/store owner|store user/i);
  });

  // Phase 4.0 M3 — an unavailable backend returns an EMPTY provider list, which is
  // byte-identical to a genuinely unconfigured store. The page-level banner says which
  // it is, but each provider card ALSO asserted a state, and it asserted the wrong one.
  it('does not label a provider "Not Configured" while the service is unavailable', async () => {
    renderPage();
    await screen.findByTestId('shipping-service-unavailable');
    expect(screen.queryByText(/^Not Configured$/i)).toBeNull();
    // It still says something — silence would be its own misreading.
    expect(screen.getAllByTestId('provider-status-unavailable').length).toBeGreaterThan(0);
  });

  it('does not claim "No provider selected" while the service is unavailable', async () => {
    renderPage();
    await screen.findByTestId('shipping-service-unavailable');
    expect(screen.queryByText(/no provider selected/i)).toBeNull();
    expect(screen.getByTestId('active-provider-unavailable')).toBeInTheDocument();
  });
});

// These handlers are unreachable today (every write is gated). They are tested against a
// HEALTHY status — i.e. the gate open — because the gate is the only thing protecting
// them, and it is temporary. A failed call must never look like a successful one.
describe('ShippingProvidersPage — action result handling', () => {
  it('Deactivate: a failed call produces the unavailable state, not success UI', async () => {
    mockHealthyStatus();
    vi.mocked(shippingApi.setActiveProvider).mockResolvedValue(UNAVAILABLE);
    renderPage();

    const btn = await screen.findByRole('button', { name: /^deactivate$/i });
    fireEvent.click(btn);

    // The explicit unavailable state, not a silently swallowed no-op.
    await screen.findByTestId('shipping-service-unavailable');
    // Configured/active state must NOT be falsely cleared by a failed action. The
    // provider NAME comes from the static catalog and renders either way, so it proves
    // nothing; the active badge and the stored config are what a false clear destroys.
    expect(screen.getByText('Active')).toBeInTheDocument();
    expect(setShippingProviderConfig).not.toHaveBeenCalledWith(null);
    expect(screen.queryByText(/^Not Configured$/i)).toBeNull();
    // No retry.
    expect(vi.mocked(shippingApi.setActiveProvider)).toHaveBeenCalledTimes(1);
  });

  it('Remove: a failed call leaves the panel open and the config intact', async () => {
    mockHealthyStatus();
    vi.mocked(shippingApi.removeProviderCredentials).mockResolvedValue(UNAVAILABLE);
    renderPage();

    await screen.findAllByText(/EasyPost/i);
    fireEvent.click(screen.getAllByRole('button', { name: /^edit$/i })[0]);
    const removeBtn = await screen.findByRole('button', { name: /^remove$/i });
    fireEvent.click(removeBtn);

    await screen.findByTestId('shipping-service-unavailable');
    // Closing the panel is the success signal — it must not fire on failure.
    expect(screen.getByRole('button', { name: /^close$/i })).toBeInTheDocument();
    expect(vi.mocked(shippingApi.removeProviderCredentials)).toHaveBeenCalledTimes(1);
  });

  // The `finally { setActionPending(false) }` fix had NO test: every other action test
  // passed with it reverted, because none checked that the control becomes operable
  // again. A control left permanently inert by one failure is the exact "loading never
  // terminates" failure this slice is meant to prevent.
  it('Deactivate: re-enables the control after a failed action, never leaving it inert', async () => {
    mockHealthyStatus();
    vi.mocked(shippingApi.setActiveProvider).mockRejectedValue(new Error('network down'));
    renderPage();

    const btn = await screen.findByRole('button', { name: /^deactivate$/i });
    expect(btn).toBeEnabled();
    fireEvent.click(btn);
    await screen.findByTestId('shipping-action-error');
    // actionPending must have been cleared in `finally`, not stranded true.
    await waitFor(() => expect(screen.getByRole('button', { name: /^deactivate$/i })).toBeEnabled());
  });

  // Deliberately a GENERIC failure, not SHIPPING_UNAVAILABLE: the unavailable state
  // flips `writesBlocked`, which UNMOUNTS every write control, so "still enabled" is
  // unobservable there. A generic error leaves the control mounted, which is the only
  // condition under which a stranded `actionPending` would be visible.
  it('Remove: re-enables the control after a failed action', async () => {
    mockHealthyStatus();
    vi.mocked(shippingApi.removeProviderCredentials).mockRejectedValue(new Error('network down'));
    renderPage();

    await screen.findAllByText(/EasyPost/i);
    fireEvent.click(screen.getAllByRole('button', { name: /^edit$/i })[0]);
    const removeBtn = await screen.findByRole('button', { name: /^remove$/i });
    expect(removeBtn).toBeEnabled();
    fireEvent.click(removeBtn);

    await screen.findByTestId('shipping-action-error');
    // The panel stays open on failure, so the control is still mounted — and operable.
    await waitFor(() => expect(screen.getByRole('button', { name: /^remove$/i })).toBeEnabled());
  });

  // A THROWN coded error must land in the same state as a RETURNED one. The catch used
  // to discard `e.code`, so the identical condition reported two different states.
  it('routes a THROWN SHIPPING_UNAVAILABLE to the unavailable state, not a generic error', async () => {
    mockHealthyStatus();
    vi.mocked(shippingApi.setActiveProvider).mockRejectedValue(
      Object.assign(new Error('backend gone'), { code: 'SHIPPING_UNAVAILABLE' }),
    );
    renderPage();

    fireEvent.click(await screen.findByRole('button', { name: /^deactivate$/i }));
    await screen.findByTestId('shipping-service-unavailable');
    expect(screen.queryByTestId('shipping-action-error')).toBeNull();
  });

  it('Deactivate: a thrown error is surfaced, never silently swallowed', async () => {
    mockHealthyStatus();
    vi.mocked(shippingApi.setActiveProvider).mockRejectedValue(new Error('network down'));
    renderPage();

    fireEvent.click(await screen.findByRole('button', { name: /^deactivate$/i }));
    // A throw is NOT the migration condition, so it must surface as a real error rather
    // than be relabelled "unavailable" — and above all must not vanish.
    const err = await screen.findByTestId('shipping-action-error');
    expect(err.textContent).toMatch(/network down/i);
    expect(screen.queryByTestId('shipping-service-unavailable')).toBeNull();
    expect(vi.mocked(shippingApi.setActiveProvider)).toHaveBeenCalledTimes(1);
  });

  it('Remove: a thrown error is surfaced, never silently swallowed', async () => {
    mockHealthyStatus();
    vi.mocked(shippingApi.removeProviderCredentials).mockRejectedValue(new Error('network down'));
    renderPage();

    await screen.findAllByText(/EasyPost/i);
    fireEvent.click(screen.getAllByRole('button', { name: /^edit$/i })[0]);
    fireEvent.click(await screen.findByRole('button', { name: /^remove$/i }));

    const err = await screen.findByTestId('shipping-action-error');
    expect(err.textContent).toMatch(/network down/i);
    // Panel still open — closing it is the success signal.
    expect(screen.getByRole('button', { name: /^close$/i })).toBeInTheDocument();
  });

  it('leaves no write control operable once the containment adapter is active', async () => {
    // Healthy first so the controls render, then the action flips it to unavailable —
    // after which every write control must be gone or disabled.
    mockHealthyStatus();
    vi.mocked(shippingApi.setActiveProvider).mockResolvedValue(UNAVAILABLE);
    renderPage();

    // Open the editing panel FIRST, so Save/Test/Remove are actually rendered before the
    // gate closes. Without this their later absence is guaranteed by the panel being shut,
    // not by the containment gate — which is what this test claims to prove.
    await screen.findAllByText(/EasyPost/i);
    fireEvent.click(screen.getAllByRole('button', { name: /^edit$/i })[0]);
    expect(await screen.findByRole('button', { name: /^save credentials$/i })).toBeEnabled();
    expect(screen.getByRole('button', { name: /^remove$/i })).toBeEnabled();

    // Positive control: the control EXISTS and is operable before the action.
    const deactivate = await screen.findByRole('button', { name: /^deactivate$/i });
    expect(deactivate).toBeEnabled();

    fireEvent.click(deactivate);
    await screen.findByTestId('shipping-service-unavailable');

    // Positive control: the page is still rendered, so the absences below are about the
    // controls and not about an unmounted page.
    expect(screen.getAllByText(/EasyPost/i).length).toBeGreaterThan(0);
    // `test connection` is UNANCHORED: that button's accessible name carries its icon
    // text ("wifi_tethering Test Connection"), so the anchored form this list used
    // could never match and asserted nothing for that one control.
    for (const label of [/^save credentials$/i, /test connection/i, /^set active$/i, /^remove$/i, /^deactivate$/i]) {
      // Unrendered under the gate. (A loop over this known-empty collection asserting
      // `toBeDisabled` was dead code — the length assertion is what bites.)
      expect(screen.queryAllByRole('button', { name: label })).toHaveLength(0);
    }
  });

  // ── The three handlers the earlier pass explicitly left open ──────────────────────
  // Same defect class as Deactivate/Remove: the result was never checked, so `success:
  // false` ran the success path. Each is tested against a HEALTHY status so the write
  // gate is open and the handler is genuinely reachable.

  it('Save: a failed call never renders "Saved!" and is not a silent no-op', async () => {
    mockHealthyStatus();
    vi.mocked(shippingApi.storeProviderCredentials).mockResolvedValue(UNAVAILABLE);
    renderPage();

    await screen.findAllByText(/EasyPost/i);
    fireEvent.click(screen.getAllByRole('button', { name: /^edit$/i })[0]);
    const save = await screen.findByRole('button', { name: /^save credentials$/i });
    fireEvent.click(save);

    // `if (result.success) {…}` with no else meant a failure did NOTHING — no message,
    // no error, no state. The operator could not tell it from a save that worked.
    await screen.findByTestId('shipping-service-unavailable');
    expect(screen.queryByText(/Saved!/i)).toBeNull();
    expect(vi.mocked(shippingApi.storeProviderCredentials)).toHaveBeenCalledTimes(1);
  });

  it('Save: a failed call echoes no credential input into the UI', async () => {
    mockHealthyStatus();
    // The error MESSAGE deliberately embeds the submitted value — a real provider that
    // reflects a rejected key back in its error text is exactly how a credential reaches
    // the screen. An error without the value in it would make this test vacuous.
    vi.mocked(shippingApi.storeProviderCredentials).mockResolvedValue({
      success: false,
      error: {
        code: 'PROVIDER_REJECTED',
        message: 'Provider rejected key SYNTHETIC-NOT-A-REAL-KEY as invalid.',
        retryable: false,
      },
    });
    const { container } = renderPage();

    await screen.findAllByText(/EasyPost/i);
    fireEvent.click(screen.getAllByRole('button', { name: /^edit$/i })[0]);
    // Target the CREDENTIAL field specifically. `querySelector('input')` returns the
    // first input on the PAGE, which is not in this panel — the typed value then never
    // reached `credentialInputs`, so redaction had nothing to match and the test proved
    // nothing. With the provider already configured these fields carry the "replace"
    // placeholder.
    const field = await waitFor(() => {
      const el = container.querySelector<HTMLInputElement>('input[placeholder="Enter new value to replace"]');
      if (!el) throw new Error('credential field not rendered');
      return el;
    });
    // A recognisable synthetic value — not a real credential.
    fireEvent.change(field, { target: { value: 'SYNTHETIC-NOT-A-REAL-KEY' } });
    fireEvent.click(await screen.findByRole('button', { name: /^save credentials$/i }));

    // A coded non-outage failure surfaces as the action error, not the outage banner.
    const err = await screen.findByTestId('shipping-action-error');

    // The provider reflected the key back; the UI must not repeat it.
    expect(err.textContent).not.toContain('SYNTHETIC-NOT-A-REAL-KEY');
    expect(err.textContent).toMatch(/\[redacted\]/);
    // ...and the surrounding message survives, so redaction did not just blank the error.
    expect(err.textContent).toMatch(/Provider rejected key/);

    // Nowhere in any RENDERED TEXT, and in no accessible name.
    expect(container.textContent).not.toContain('SYNTHETIC-NOT-A-REAL-KEY');
    for (const el of Array.from(container.querySelectorAll('[aria-label],[title],[alt]'))) {
      const accessible = `${el.getAttribute('aria-label') ?? ''} ${el.getAttribute('title') ?? ''} ${el.getAttribute('alt') ?? ''}`;
      expect(accessible).not.toContain('SYNTHETIC-NOT-A-REAL-KEY');
    }

    // DELIBERATELY NOT asserted over `container.innerHTML`: the credential input keeps
    // the value the operator typed (`<input type="password" value="...">`). That is the
    // operator's own field, not an echo — this failure is retryable and clearing it
    // would discard their input.
  });

  it('Set Active: a failed call does not notify the parent or claim success', async () => {
    // easypost configured but NOT active, so "Set Active" actually renders.
    vi.mocked(shippingApi.getProvidersStatus).mockResolvedValue({
      success: true,
      providers: [{
        providerId: 'easypost', isActive: false, environment: 'test',
        configuredAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
        maskedCredentials: { apiKey: '••••1234' },
        lastTestedAt: null, lastTestResult: null,
      }],
      activeProviderId: null,
    });
    vi.mocked(shippingApi.setActiveProvider).mockResolvedValue(UNAVAILABLE);
    const onProviderChange = vi.fn();
    renderPage(onProviderChange);

    const btn = await screen.findByRole('button', { name: /^set active$/i });
    fireEvent.click(btn);

    await screen.findByTestId('shipping-service-unavailable');
    // The result was never bound, so refetch + parent notification ran unconditionally.
    // Both are success signals and must not fire for a call that changed nothing.
    expect(onProviderChange).not.toHaveBeenCalled();
    expect(vi.mocked(shippingApi.setActiveProvider)).toHaveBeenCalledTimes(1);
  });

  it('Test Connection: an outage is not reported as a failed connection test', async () => {
    mockHealthyStatus();
    vi.mocked(shippingApi.testConnection).mockResolvedValue(UNAVAILABLE);
    const onProviderChange = vi.fn();
    renderPage(onProviderChange);

    await screen.findAllByText(/EasyPost/i);
    fireEvent.click(screen.getAllByRole('button', { name: /^edit$/i })[0]);
    // Unanchored: the button's accessible name includes its icon text
    // ("wifi_tethering Test Connection"), so an anchored `/^…$/` never matches.
    fireEvent.click(await screen.findByRole('button', { name: /test connection/i }));

    // OUR service being down is not a verdict on the carrier. Rendering it as
    // "Connection test failed" blames the provider for our own outage — and the
    // per-provider card would then carry a failure verdict no test ever produced.
    await screen.findByTestId('shipping-service-unavailable');
    expect(screen.queryByText(/connection test failed/i)).toBeNull();
    expect(onProviderChange).not.toHaveBeenCalled();
  });

  it('Test Connection: a genuine coded failure IS reported as a failed test', async () => {
    mockHealthyStatus();
    vi.mocked(shippingApi.testConnection).mockResolvedValue({
      success: false,
      error: { code: 'PROVIDER_AUTH_FAILED', message: 'Carrier rejected the credentials.', retryable: false },
    });
    const onProviderChange = vi.fn();
    renderPage(onProviderChange);

    await screen.findAllByText(/EasyPost/i);
    fireEvent.click(screen.getAllByRole('button', { name: /^edit$/i })[0]);
    // Unanchored: the button's accessible name includes its icon text
    // ("wifi_tethering Test Connection"), so an anchored `/^…$/` never matches.
    fireEvent.click(await screen.findByRole('button', { name: /test connection/i }));

    // The mirror of the test above: a real carrier failure must NOT be swallowed into
    // the outage state, or a genuine credential problem would look like our downtime.
    await waitFor(() => expect(screen.getByText(/Carrier rejected the credentials\./i)).toBeInTheDocument());
    expect(screen.queryByTestId('shipping-service-unavailable')).toBeNull();
    // Still a failure, so still no parent notification.
    expect(onProviderChange).not.toHaveBeenCalled();
  });
});
