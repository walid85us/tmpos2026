// M7A-CUSTOMERS-P3-R1 Checkpoint 1 — where an owner's role edit in the shop app actually lives.
//
// WHAT THIS PROVES. updateTenantRole (the Employees editor's only write path for a role's levels) narrows the decision of
// the provider it was called on — a signed-in sales_staff session loses Customers Create in that tab — and it does so
// with ZERO network requests: no fetch, no XMLHttpRequest, no Firestore read or write. A second provider mounted afterwards
// (another tab), and a fresh provider after the first unmounts (a reload), still answer the catalog default for the same
// signed-in role (Customers Create allowed). So the edit is client memory of one tab only; nothing server-authoritative
// exists for the server to enforce, which is why migration 020 and PUT /api/v1/roles/levels carry the durable level.
//
// Only the Firebase boundary is mocked (as AccessContext.test.tsx does): no real Firebase contact. Each provider's auth
// callback is kept separately so each mounted tree can be signed in on its own.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, act, cleanup } from '@testing-library/react';
import type { PermissionLevel } from '../types';

const authCallbacks: Array<(user: unknown) => void | Promise<void>> = [];
vi.mock('../firebase', () => ({ auth: {}, db: {} }));
vi.mock('firebase/auth', () => ({
  onAuthStateChanged: vi.fn((_auth: unknown, cb: (u: unknown) => void) => {
    authCallbacks.push(cb);
    return () => {};
  }),
}));
const getDoc = vi.fn();
vi.mock('firebase/firestore', () => ({
  doc: vi.fn(() => ({})),
  getDoc: (...a: unknown[]) => getDoc(...a),
}));

import { AccessProvider, useAccess } from './AccessContext';
import { tenantRoles } from './accessConfig';

type Ctx = ReturnType<typeof useAccess>;
const captured: Record<string, Ctx | null> = {};
function Capture({ name }: { name: string }) {
  captured[name] = useAccess();
  return null;
}

/** Mounts a provider (one "tab") and signs its own auth listener in as a sales_staff user. */
async function mountSignedIn(name: string) {
  const before = authCallbacks.length;
  const view = render(<AccessProvider><Capture name={name} /></AccessProvider>);
  // StrictMode is not used here, so exactly one listener registers per mount; take the newest.
  expect(authCallbacks.length).toBeGreaterThan(before);
  const cb = authCallbacks[authCallbacks.length - 1];
  await act(async () => { await cb({ uid: `u-${name}`, email: `${name}@synthetic.test` }); });
  expect(captured[name]!.session?.role).toBe('sales_staff');
  return view;
}

let fetchSpy: ReturnType<typeof vi.fn>;
let xhrOpen: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  authCallbacks.length = 0;
  for (const k of Object.keys(captured)) delete captured[k];
  getDoc.mockReset();
  getDoc.mockResolvedValue({ exists: () => true, data: () => ({ role: 'sales_staff', name: 'Synthetic' }) });
  fetchSpy = vi.fn(() => Promise.reject(new Error('no network in this test')));
  vi.stubGlobal('fetch', fetchSpy);
  xhrOpen = vi.spyOn(XMLHttpRequest.prototype, 'open');
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('an owner role edit is client memory of one tab (M7A-CUSTOMERS-P3-R1 Checkpoint 1)', () => {
  it('RLE-1. updateTenantRole narrows only its own provider, with zero network requests; another tab and a reload keep the catalog default', async () => {
    const salesDefaults = tenantRoles.find((r) => r.id === 'sales_staff')!.permissions as Record<string, PermissionLevel>;
    expect(salesDefaults.customers).toBe('create'); // the catalog default the server's 019 allow-list also encoded

    const tabA = await mountSignedIn('a');
    expect(captured.a!.checkPermission('customers', 'create')).toBe(true); // control: the default allows Create
    expect(captured.a!.checkPermission('customers', 'view')).toBe(true);
    const firestoreReads = getDoc.mock.calls.length;

    // The owner narrows Sales Associate's Customers level to View, exactly as the Employees editor does.
    act(() => { captured.a!.updateTenantRole('sales_staff', { ...salesDefaults, customers: 'view' }); });

    expect(captured.a!.checkPermission('customers', 'create')).toBe(false); // this tab's decision narrowed
    expect(captured.a!.checkPermission('customers', 'view')).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(0);
    expect(xhrOpen).toHaveBeenCalledTimes(0);
    expect(getDoc.mock.calls.length).toBe(firestoreReads); // the edit read or wrote nothing through Firestore either

    // Another tab: a second provider mounted now, same signed-in role — the catalog default, not the edit.
    await mountSignedIn('b');
    expect(captured.b!.checkPermission('customers', 'create')).toBe(true);
    expect(captured.a!.checkPermission('customers', 'create')).toBe(false); // the first tab keeps its own memory

    // A reload: the edited tab goes away and a fresh provider mounts — the edit is gone.
    tabA.unmount();
    await mountSignedIn('c');
    expect(captured.c!.checkPermission('customers', 'create')).toBe(true);

    expect(fetchSpy).toHaveBeenCalledTimes(0);
    expect(xhrOpen).toHaveBeenCalledTimes(0);
  });
});
