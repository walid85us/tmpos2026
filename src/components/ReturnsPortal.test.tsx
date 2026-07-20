import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import ReturnsPortal, { resolveActorName } from './ReturnsPortal';

// Behaviour-bearing fix (TS2339): Session exposes the display name at `user.name`
// and has no top-level `name`. The former `session?.name` was always undefined, so
// every return action (performedBy / receivedBy / createdBy) recorded the 'System'
// fallback instead of the actual actor.
describe('resolveActorName', () => {
  it('uses the canonical Session display name when present', () => {
    expect(resolveActorName({ user: { name: 'Dana Reyes' } })).toBe('Dana Reyes');
  });

  it('falls back to System whenever no display name is available', () => {
    expect(resolveActorName(null)).toBe('System');
    expect(resolveActorName(undefined)).toBe('System');
    expect(resolveActorName({})).toBe('System');
    expect(resolveActorName({ user: {} })).toBe('System');
    expect(resolveActorName({ user: { name: '' } })).toBe('System');
  });
});

// Phase 4.0 M3 — Returns Portal must not hand a provider-controlled URL to the browser.
//
// Two surfaces linked straight to `returnInfo.returnLabelUrl`: the Return Shipment panel in
// the detail modal ("View Return Label") and the label-delivery modal ("Download Return
// Label"). A third leaked it as TEXT — the customer-instructions block embedded the raw URL,
// which was rendered in a <pre>, copied to the clipboard, and pushed into a mailto body.
//
// The label proxy that used to launder these URLs is deleted and, per the owner ruling, is
// not to be substituted — not by a proxy, not by a data: URL. So the URL must reach no
// browser-fetching sink AND must not appear as text, and the surface says so plainly.
//
// The sentinel is checked against innerHTML and against every attribute, because an href is
// only the most obvious sink; a title or aria-label would leak it just as effectively.

/** Hostile stand-in for a provider-controlled label URL. */
const LABEL_URL = 'https://provider-controlled.example/return-label-should-not-load.pdf';
const SENTINEL = 'provider-controlled.example';

const openSpy = vi.fn();
const writeText = vi.fn((_text: string) => Promise.resolve());

const labelledShipment = {
  id: 'shp-ret-1', shipmentNumber: 'SHP-RET-0001', status: 'Label Created',
  type: 'inbound', sourceType: 'return', sourceId: 'ret-1', sourceNumber: 'RET-0001',
  carrier: 'USPS', serviceLevel: 'Priority', trackingNumber: '1ZRETURNTEST',
  originAddress: {}, destinationAddress: {}, packages: [], events: [],
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  labelUrl: LABEL_URL,
  returnInfo: { isReturn: true, returnLabelUrl: LABEL_URL },
};

const returnRecord = {
  id: 'ret-1', returnNumber: 'RET-0001', status: 'Approved',
  sourceType: 'invoice', sourceId: 'inv-1', sourceNumber: 'INV-0001',
  customerId: 'cus-1', customerName: 'Test Customer', customerEmail: 'customer@example.test',
  reason: 'defective', requestedResolution: 'refund',
  items: [{ id: 'ri-1', name: 'Widget', quantity: 1, sku: 'W-1', unitPrice: 10 }],
  returnShipmentId: 'shp-ret-1',
  createdBy: 'Tester', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  statusHistory: [],
};

const noop = vi.fn();

// Both context values are STABLE singletons, exactly as the real providers return them.
// Rebuilding them per call would hand `shipments` a fresh array identity on every render,
// which re-fires the shipment→return status-sync effect (deps `[shipments]`) on every
// render; once a return is selected that effect calls `setSelectedReturn`, and the result
// is an infinite synchronous render loop that no test timeout can interrupt. That is a
// fixture artefact, not a product defect — the real store returns a stable array.
const storeValue = {
  returns: [returnRecord], shipments: [labelledShipment],
  customers: [], invoices: [], repairTickets: [], rmas: [],
  addReturn: noop, updateReturn: noop, addShipment: noop,
};
vi.mock('../context/StoreLocalState', () => ({ useStoreLocalState: () => storeValue }));

const accessValue = {
  session: { user: { name: 'Tester' } },
  checkPermission: () => true,
  checkSubPermission: () => true,
  isWriteBlocked: false,
  canAccess: () => true,
};
vi.mock('../context/AccessContext', () => ({ useAccess: () => accessValue }));

function renderPortal() {
  return render(
    <MemoryRouter initialEntries={['/returns']}>
      <ReturnsPortal />
    </MemoryRouter>,
  );
}

/** Open the return so the detail modal (and its Return Shipment panel) renders. */
function openReturnDetail() {
  fireEvent.click(screen.getAllByText('RET-0001')[0]);
  // Positive control: the branch under test really rendered.
  expect(screen.getByText(/Return Shipment/i)).toBeInTheDocument();
}

/** Every attribute value on every element — an href is not the only leak. */
function allAttributeValues(container: HTMLElement): string[] {
  const out: string[] = [];
  for (const el of Array.from(container.querySelectorAll('*'))) {
    for (const attr of Array.from(el.attributes)) out.push(attr.value);
  }
  return out;
}

describe('ReturnsPortal — provider label URL containment', () => {
  beforeEach(() => {
    openSpy.mockClear();
    writeText.mockClear();
    vi.stubGlobal('open', openSpy);
    Object.defineProperty(globalThis.navigator, 'clipboard', {
      value: { writeText }, configurable: true, writable: true,
    });
  });

  it('never renders the provider label URL in the return detail', () => {
    const { container } = renderPortal();
    openReturnDetail();
    expect(container.innerHTML).not.toContain(SENTINEL);
    for (const v of allAttributeValues(container)) expect(v).not.toContain(SENTINEL);
  });

  it('exposes no browser-fetching sink pointed at the provider URL', () => {
    const { container } = renderPortal();
    openReturnDetail();
    // Measured: this collection is EMPTY, so iterating it and asserting "no element
    // contains the sentinel" proved nothing. The real, falsifiable invariant is that the
    // Return Shipment panel exposes NO browser-fetching sink at all — restoring the
    // deleted <a href={returnLabelUrl}> makes this 1 and fails the test.
    const panel = screen.getByTestId('return-label-unavailable').closest('div')!.parentElement!;
    const sinks = panel.querySelectorAll(
      'a[href], img[src], iframe, object, embed, [download], [style*="url("]',
    );
    expect(sinks).toHaveLength(0);
    // Belt-and-braces across the whole tree, for any sink outside that panel.
    for (const el of Array.from(container.querySelectorAll('a[href], img[src], iframe, object, embed, [download]'))) {
      expect(el.outerHTML).not.toContain(SENTINEL);
    }
  });

  it('states the label preview is unavailable, with words and an icon', () => {
    renderPortal();
    openReturnDetail();
    const banner = screen.getByTestId('return-label-unavailable');
    expect(banner.textContent).toMatch(/unavailable/i);
    // Icon + words, and a status semantic so it is not colour-only.
    expect(banner.querySelector('.material-symbols-outlined')).toBeTruthy();
    expect(banner.getAttribute('role')).toBe('status');
  });

  it('keeps the surrounding return and shipment details usable', () => {
    renderPortal();
    openReturnDetail();
    const panel = screen.getByTestId('return-label-unavailable').parentElement!;
    expect(panel.textContent).toMatch(/SHP-RET-0001/);
    expect(panel.textContent).toMatch(/USPS/);
    expect(panel.textContent).toMatch(/Priority/);
    expect(panel.textContent).toMatch(/1ZRETURNTEST/);
  });

  it('never leaks the provider URL through the label-delivery modal', () => {
    const { container } = renderPortal();
    openReturnDetail();
    fireEvent.click(screen.getByRole('button', { name: /send label to customer/i }));
    // Positive control: the modal really opened.
    expect(screen.getByText(/Share Return Label/i)).toBeInTheDocument();

    expect(container.innerHTML).not.toContain(SENTINEL);
    for (const v of allAttributeValues(container)) expect(v).not.toContain(SENTINEL);
    expect(screen.getByTestId('return-label-unavailable-share')).toBeInTheDocument();
  });

  it('does not let a customer email field inject extra mailto headers', () => {
    // `customerEmail` was interpolated into the mailto URL raw while subject/body were
    // encoded. A stored value like `real@x.test?bcc=attacker@evil.test&` therefore opens a
    // draft that BCCs an attacker, carrying the RA number, tracking number, customer name
    // and the itemised return list.
    const hostile = { ...returnRecord, customerEmail: 'real@cust.test?bcc=attacker@evil.test&' };
    storeValue.returns = [hostile as typeof returnRecord];
    try {
      renderPortal();
      openReturnDetail();
      fireEvent.click(screen.getByRole('button', { name: /send label to customer/i }));
      fireEvent.click(screen.getByRole('button', { name: /email/i }));

      expect(openSpy).toHaveBeenCalled();
      const url = String(openSpy.mock.calls[0][0]);
      // Everything after the recipient must be OUR parameters only.
      const query = url.slice(url.indexOf('?') + 1);
      const params = [...new URLSearchParams(query).keys()];
      expect(params).toEqual(['subject', 'body']);
      // The recipient must carry no raw separator, so nothing in it can become a header.
      // "bcc" may still appear as inert percent-encoded DATA — that is harmless; what
      // matters is that it cannot terminate the address and start a new field.
      const recipient = url.slice('mailto:'.length, url.indexOf('?'));
      expect(recipient).not.toMatch(/[?&=]/);
    } finally {
      storeValue.returns = [returnRecord];
    }
  });

  it('keeps the provider URL out of the clipboard and the mailto body', () => {
    renderPortal();
    openReturnDetail();
    fireEvent.click(screen.getByRole('button', { name: /send label to customer/i }));

    fireEvent.click(screen.getByRole('button', { name: /copy/i }));
    expect(writeText).toHaveBeenCalled();
    for (const call of writeText.mock.calls) expect(String(call[0])).not.toContain(SENTINEL);

    fireEvent.click(screen.getByRole('button', { name: /email/i }));
    expect(openSpy).toHaveBeenCalled();
    for (const call of openSpy.mock.calls) {
      expect(decodeURIComponent(String(call[0]))).not.toContain(SENTINEL);
    }
  });
});
