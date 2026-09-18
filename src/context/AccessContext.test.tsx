import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { platformRoles } from './accessConfig';
import type { PermissionLevel } from '../types';

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

import { AccessProvider, useAccess, isKnownNavigationFeature } from './AccessContext';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

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

// Captures the live context value so tests can call its functions directly
// (checkPermission/checkSubPermission/canAccess/requestSupervisorRefundAuth
// are not otherwise reachable from plain DOM assertions).
let ctx: ReturnType<typeof useAccess> | null = null;
function CaptureCtx() {
  ctx = useAccess();
  return null;
}

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

  it('14. checkPermission denies an unknown domain for store_owner (control: a real domain still checked)', async () => {
    getDoc.mockResolvedValue(existing('store_owner'));
    render(<AccessProvider><CaptureCtx /></AccessProvider>);
    await fireAuth({ uid: 'u-so', email: 'so@synthetic.test' });
    expect(ctx!.checkPermission('sales', 'view')).toBe(true); // control: real domain, store_owner is full
    expect(ctx!.checkPermission('not_a_real_domain', 'view')).toBe(false);
  });

  it('15. checkPermission denies an unknown domain for manager (control: a real domain still checked)', async () => {
    getDoc.mockResolvedValue(existing('manager'));
    render(<AccessProvider><CaptureCtx /></AccessProvider>);
    await fireAuth({ uid: 'u-mgr', email: 'mgr@synthetic.test' });
    expect(ctx!.checkPermission('sales', 'view')).toBe(true); // control
    expect(ctx!.checkPermission('not_a_real_domain', 'view')).toBe(false);
  });

  it('16. checkPermission denies an unknown/garbage required level (control: a real level still checked)', async () => {
    getDoc.mockResolvedValue(existing('manager'));
    render(<AccessProvider><CaptureCtx /></AccessProvider>);
    await fireAuth({ uid: 'u-mgr2', email: 'mgr2@synthetic.test' });
    expect(ctx!.checkPermission('sales', 'view')).toBe(true); // control
    expect(ctx!.checkPermission('sales', 'GARBAGE_LEVEL' as unknown as PermissionLevel)).toBe(false);
  });

  it('17. checkSubPermission denies a stored explicit non-boolean value (control: stored true/false booleans still behave)', async () => {
    getDoc.mockResolvedValue(existing('manager'));
    render(<AccessProvider><CaptureCtx /></AccessProvider>);
    await fireAuth({ uid: 'u-mgr3', email: 'mgr3@synthetic.test' });
    expect(ctx!.checkSubPermission('process_refunds')).toBe(true); // control: stored true

    act(() => { ctx!.updateTenantRoleSubPermission('manager', 'process_refunds', false); });
    expect(ctx!.checkSubPermission('process_refunds')).toBe(false); // control: stored false

    act(() => { ctx!.updateTenantRoleSubPermission('manager', 'process_refunds', 'not-a-boolean' as unknown as boolean); });
    expect(ctx!.checkSubPermission('process_refunds')).toBe(false); // denial: present non-boolean
  });

  it('18. canAccess resolves normally for a known tenant role (control)', async () => {
    getDoc.mockResolvedValue(existing('manager'));
    render(<AccessProvider><CaptureCtx /></AccessProvider>);
    await fireAuth({ uid: 'u-mgr4', email: 'mgr4@synthetic.test' });
    expect(ctx!.canAccess('sales')).toBe(true);
  });

  it('19. canAccess denies an unknown tenant role for a non-domain feature the unknown-role branch actually governs (control: a real tenant role still resolves that same feature)', async () => {
    // 'manage_employees' is an adminPermissions id, not a PERMISSION_DOMAINS
    // id, so it reaches the `!isPermissionDomain -> allow` branch this line
    // guards — unlike a domain id such as 'sales', which is already denied
    // for an unknown role by a different, pre-existing path (getPermissionLevel's
    // own `!roleConfig -> 'none'`), making that probe vacuous.
    getDoc.mockResolvedValue(existing('manager'));
    render(<AccessProvider><CaptureCtx /></AccessProvider>);
    await fireAuth({ uid: 'u-mgr5', email: 'mgr5@synthetic.test' });
    expect(ctx!.canAccess('manage_employees')).toBe(true); // control: a real tenant role

    getDoc.mockResolvedValue(existing('__definitely_not_a_tenant_role__'));
    render(<AccessProvider><CaptureCtx /></AccessProvider>);
    await fireAuth({ uid: 'u-unknown', email: 'unknown@synthetic.test' });
    expect(ctx!.canAccess('manage_employees')).toBe(false);
  });

  it('20. resolvePermissionLevel (via getPermissionLevel/checkPermission) denies a present-but-falsy malformed stored value even against a "none" requirement (control: an absent domain key still resolves "none" and clears "none")', async () => {
    getDoc.mockResolvedValue(existing('manager'));
    render(<AccessProvider><CaptureCtx /></AccessProvider>);
    await fireAuth({ uid: 'u-mgr6', email: 'mgr6@synthetic.test' });

    // control: 'employees' is absent from a permissions Record missing that key entirely.
    act(() => { ctx!.updateTenantRole('manager', { dashboard: 'full' } as unknown as Record<string, PermissionLevel>); });
    expect(ctx!.getPermissionLevel('employees')).toBe('none');
    expect(ctx!.checkPermission('employees', 'none')).toBe(true); // absent legitimately clears 'none'

    for (const malformed of ['', null, 0]) {
      act(() => { ctx!.updateTenantRole('manager', { refunds: malformed } as unknown as Record<string, PermissionLevel>); });
      expect(ctx!.getPermissionLevel('refunds')).toBe(malformed as unknown as PermissionLevel);
      expect(ctx!.checkPermission('refunds', 'none')).toBe(false); // present-but-malformed no longer satisfies 'none'
    }
  });

  it('21. requestSupervisorRefundAuth denies a malformed explicit approve_refunds entry (control: absent and exactly-true both still authorize)', () => {
    render(<AccessProvider><CaptureCtx /></AccessProvider>);
    expect(ctx!.requestSupervisorRefundAuth('store_owner', '1234')).toBe(true); // control: subPermissions absent entirely
    act(() => { ctx!.clearSupervisorRefundAuth(); });
    expect(ctx!.requestSupervisorRefundAuth('manager', '1234')).toBe(true); // control: present and exactly true
    act(() => { ctx!.clearSupervisorRefundAuth(); });

    act(() => { ctx!.updateTenantRoleSubPermission('manager', 'approve_refunds', 'not-a-boolean' as unknown as boolean); });
    expect(ctx!.requestSupervisorRefundAuth('manager', '1234')).toBe(false); // denial: present, not exactly true
  });

  it('22. canAccess: System Owner denies an unknown/empty feature (F5) (controls: a real platform nav feature and a navigation-only placeholder both true)', async () => {
    getDoc.mockResolvedValue(existing(platformRoles[0].id));
    render(<AccessProvider><CaptureCtx /></AccessProvider>);
    await fireAuth({ uid: 'u-owner2', email: 'owner2@synthetic.test' });
    expect(ctx!.canAccess('tenants')).toBe(true); // control: a real platform nav feature
    expect(ctx!.canAccess('ledger')).toBe(true); // control: a navigation-only placeholder
    expect(ctx!.canAccess('')).toBe(false);
    expect(ctx!.canAccess('not_a_feature')).toBe(false);
  });
});

describe('isKnownNavigationFeature — static AccessGuard vocabulary guard', () => {
  it('every literal feature="..." on <AccessGuard> in App.tsx is a known navigation feature, so a new route cannot silently lock the owner out', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const appTsxPath = resolve(here, '../App.tsx');
    const source = readFileSync(appTsxPath, 'utf8');
    const literals = [...source.matchAll(/<AccessGuard\b[^>]*\bfeature="([^"]*)"/g)].map(m => m[1]);
    expect(literals.length).toBeGreaterThanOrEqual(30); // non-vacuous extraction
    const unknown = literals.filter(f => !isKnownNavigationFeature(f));
    expect(unknown).toEqual([]);
  });
});
