import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { platformRoles } from './accessConfig';

// Mock the Firebase boundary only — no real Firebase contact. onAuthStateChanged
// captures the provider's callback so tests can drive auth transitions; getDoc is
// controlled per test.
let authCallback: ((user: unknown) => void | Promise<void>) | null = null;
const unsubscribe = vi.fn();
vi.mock('../firebase', () => ({ auth: {}, db: {} }));
vi.mock('firebase/auth', () => ({
  onAuthStateChanged: vi.fn((_auth: unknown, cb: (u: unknown) => void) => {
    authCallback = cb;
    return unsubscribe;
  }),
}));
const getDoc = vi.fn();
vi.mock('firebase/firestore', () => ({
  doc: vi.fn(() => ({})),
  getDoc: (...a: unknown[]) => getDoc(...a),
}));

import { AccessProvider, useAccess } from './AccessContext';

const PLATFORM_ROLE = platformRoles[0].id;
const TENANT_ROLE = '__definitely_not_a_platform_role__';

function Probe() {
  const a = useAccess();
  return (
    <div>
      <span data-testid="loading">{a.loading ? 'LOADING' : 'READY'}</span>
      <span data-testid="userType">{a.session?.userType ?? 'NO_SESSION'}</span>
      <span data-testid="role">{a.session?.role ?? 'NO_ROLE'}</span>
      <span data-testid="tenant">{a.tenant?.id ?? 'NO_TENANT'}</span>
      <span data-testid="authError">{a.authError ?? 'NO_ERROR'}</span>
      <span data-testid="api">{typeof a.canAccess === 'function' && typeof a.resolveLandingRoute === 'function' ? 'API_OK' : 'API_BAD'}</span>
    </div>
  );
}

const existing = (role: string) => ({ exists: () => true, data: () => ({ role, name: 'Synthetic' }) });
const missing = () => ({ exists: () => false, data: () => ({}) });

async function fireAuth(user: unknown) {
  await act(async () => {
    await authCallback?.(user);
  });
}

let logSpy: ReturnType<typeof vi.spyOn>;
let errSpy: ReturnType<typeof vi.spyOn>;
let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  authCallback = null;
  unsubscribe.mockClear();
  getDoc.mockReset();
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  logSpy.mockRestore();
  errSpy.mockRestore();
  warnSpy.mockRestore();
});

const allConsole = () => [...logSpy.mock.calls, ...errSpy.mock.calls, ...warnSpy.mock.calls].flat().map(String).join(' ');

describe('AccessProvider (Firebase-boundary render behavior)', () => {
  it('1. starts in a loading state before auth resolves', () => {
    render(<AccessProvider><Probe /></AccessProvider>);
    expect(screen.getByTestId('loading')).toHaveTextContent('LOADING');
  });

  it('2. signed-out clears session and tenant with no error', async () => {
    render(<AccessProvider><Probe /></AccessProvider>);
    await fireAuth(null);
    expect(screen.getByTestId('loading')).toHaveTextContent('READY');
    expect(screen.getByTestId('userType')).toHaveTextContent('NO_SESSION');
    expect(screen.getByTestId('tenant')).toHaveTextContent('NO_TENANT');
    expect(screen.getByTestId('authError')).toHaveTextContent('NO_ERROR');
  });

  it('3. a platform/system-owner profile maps to a platform session with no tenant', async () => {
    getDoc.mockResolvedValue(existing(PLATFORM_ROLE));
    render(<AccessProvider><Probe /></AccessProvider>);
    await fireAuth({ uid: 'u-plat', email: 'p@synthetic.test' });
    expect(screen.getByTestId('userType')).toHaveTextContent('platform');
    expect(screen.getByTestId('tenant')).toHaveTextContent('NO_TENANT');
    expect(screen.getByTestId('authError')).toHaveTextContent('NO_ERROR');
  });

  it('4. a tenant/store profile maps to a tenant session with tenant state', async () => {
    getDoc.mockResolvedValue(existing(TENANT_ROLE));
    render(<AccessProvider><Probe /></AccessProvider>);
    await fireAuth({ uid: 'u-tenant', email: 't@synthetic.test' });
    expect(screen.getByTestId('userType')).toHaveTextContent('tenant');
    expect(screen.getByTestId('tenant')).toHaveTextContent('tenant-1');
  });

  it('5. a missing Firestore profile fails closed to account_not_provisioned only', async () => {
    getDoc.mockResolvedValue(missing());
    render(<AccessProvider><Probe /></AccessProvider>);
    await fireAuth({ uid: 'u-x', email: 'x@synthetic.test' });
    expect(screen.getByTestId('userType')).toHaveTextContent('NO_SESSION');
    expect(screen.getByTestId('authError')).toHaveTextContent('account_not_provisioned');
  });

  it('6. a Firestore read failure fails closed to a bounded firestore_error only', async () => {
    getDoc.mockRejectedValue(new Error('SECRET raw firestore detail 12345'));
    render(<AccessProvider><Probe /></AccessProvider>);
    await fireAuth({ uid: 'u-y', email: 'y@synthetic.test' });
    expect(screen.getByTestId('userType')).toHaveTextContent('NO_SESSION');
    expect(screen.getByTestId('authError')).toHaveTextContent('firestore_error');
  });

  it('7. raw Firebase/Firestore error details are neither rendered nor logged', async () => {
    getDoc.mockRejectedValue(new Error('SECRET raw firestore detail 12345'));
    const { container } = render(<AccessProvider><Probe /></AccessProvider>);
    await fireAuth({ uid: 'u-z', email: 'z@synthetic.test' });
    expect(container.textContent).not.toContain('SECRET raw firestore detail');
    expect(allConsole()).not.toContain('SECRET raw firestore detail');
  });

  it('8. an auth-state change fully replaces prior session state', async () => {
    getDoc.mockResolvedValue(existing(TENANT_ROLE));
    render(<AccessProvider><Probe /></AccessProvider>);
    await fireAuth({ uid: 'u-1', email: '1@synthetic.test' });
    expect(screen.getByTestId('userType')).toHaveTextContent('tenant');
    await fireAuth(null);
    expect(screen.getByTestId('userType')).toHaveTextContent('NO_SESSION');
    expect(screen.getByTestId('tenant')).toHaveTextContent('NO_TENANT');
  });

  it('9. tenant state does not leak from a previous account (tenant → platform)', async () => {
    getDoc.mockResolvedValueOnce(existing(TENANT_ROLE));
    render(<AccessProvider><Probe /></AccessProvider>);
    await fireAuth({ uid: 'u-t', email: 't@synthetic.test' });
    expect(screen.getByTestId('tenant')).toHaveTextContent('tenant-1');
    getDoc.mockResolvedValueOnce(existing(PLATFORM_ROLE));
    await fireAuth({ uid: 'u-p', email: 'p@synthetic.test' });
    expect(screen.getByTestId('userType')).toHaveTextContent('platform');
    expect(screen.getByTestId('tenant')).toHaveTextContent('NO_TENANT');
  });

  it('10. unmount invokes the returned unsubscribe exactly once', async () => {
    const { unmount } = render(<AccessProvider><Probe /></AccessProvider>);
    await fireAuth(null);
    unmount();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('11. a late auth callback after unmount does not throw or error', async () => {
    const { unmount } = render(<AccessProvider><Probe /></AccessProvider>);
    unmount();
    await expect(fireAuth({ uid: 'late', email: 'late@synthetic.test' })).resolves.toBeUndefined();
    expect(errSpy).not.toHaveBeenCalled();
  });

  it('12. no console output exposes uid/email/role/token across flows', async () => {
    getDoc.mockResolvedValue(existing(TENANT_ROLE));
    render(<AccessProvider><Probe /></AccessProvider>);
    await fireAuth({ uid: 'uid-super-secret', email: 'leak@synthetic.test' });
    const out = allConsole();
    expect(out).not.toContain('uid-super-secret');
    expect(out).not.toContain('leak@synthetic.test');
    expect(out).not.toContain(TENANT_ROLE);
  });

  it('13. existing public context API is present and unchanged', async () => {
    render(<AccessProvider><Probe /></AccessProvider>);
    await fireAuth(null);
    expect(screen.getByTestId('api')).toHaveTextContent('API_OK');
  });
});
