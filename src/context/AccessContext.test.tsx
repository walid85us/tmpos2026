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
import { CANONICAL_DIFF_CONTEXT, computeRepinnedGrantDiff } from '../../server/platform-identity/gap11GrantDiff';
import { BUILT_IN_MONEY_GRANT_DEFAULTS } from '../authorization/moneyCapabilities';
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

  it('21. requestSupervisorRefundAuth is the one refund-approval capability: explicit grant exactly true, a session, the plan (M5-GAP11-P5)', async () => {
    render(<AccessProvider><CaptureCtx /></AccessProvider>);
    // No session: the converged capability denies (checkSubPermission always required one).
    expect(ctx!.requestSupervisorRefundAuth('store_owner', '1234')).toBe(false);
    getDoc.mockResolvedValue(existing('sales_staff'));
    await fireAuth({ uid: 'u-sup', email: 'sup@synthetic.test' });
    expect(ctx!.requestSupervisorRefundAuth('store_owner', '1234')).toBe(true); // control: store_owner's explicit default grant
    act(() => { ctx!.clearSupervisorRefundAuth(); });
    expect(ctx!.requestSupervisorRefundAuth('manager', '1234')).toBe(true); // control: present and exactly true
    act(() => { ctx!.clearSupervisorRefundAuth(); });
    expect(ctx!.requestSupervisorRefundAuth('manager', '0000')).toBe(false); // the PIN still gates first

    act(() => { ctx!.updateTenantRoleSubPermission('manager', 'approve_refunds', 'not-a-boolean' as unknown as boolean); });
    expect(ctx!.requestSupervisorRefundAuth('manager', '1234')).toBe(false); // malformed: denied
    act(() => { ctx!.updateTenantRoleSubPermission('manager', 'approve_refunds', false); });
    expect(ctx!.requestSupervisorRefundAuth('manager', '1234')).toBe(false); // owner revoke is honoured
    act(() => { ctx!.updateTenantRoleSubPermission('manager', 'approve_refunds', true); });
    // Refunds lowered to Create, grant kept: the capability's gate is the catalog minimum (Refunds View),
    // so both refund-approval forms answer the same — the supervisor check and checkSubPermission.
    act(() => { ctx!.updateTenantRole('manager', { refunds: 'create' } as Record<string, PermissionLevel>); });
    expect(ctx!.requestSupervisorRefundAuth('manager', '1234')).toBe(true);
    act(() => { ctx!.updateTenantRole('manager', { refunds: 'none' } as Record<string, PermissionLevel>); });
    expect(ctx!.requestSupervisorRefundAuth('manager', '1234')).toBe(false); // parent-module minimum still denies
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

  it('23. M5-GAP11-P5: every built-in store role\'s refund and return approval equals its built-in default grant; the retired level form is refused', async () => {
    let granted = 0;
    for (const role of ['store_owner', 'manager', 'sales_staff', 'technician']) {
      getDoc.mockResolvedValue(existing(role));
      const { unmount } = render(<AccessProvider><CaptureCtx /></AccessProvider>);
      await fireAuth({ uid: `u-money-${role}`, email: `money-${role}@synthetic.test` });
      const defaults = BUILT_IN_MONEY_GRANT_DEFAULTS[role];
      expect({ role, client: ctx!.checkSubPermission('approve_refunds') }).toEqual({ role, client: defaults.approve_refunds === true });
      expect({ role, client: ctx!.checkSubPermission('approve_return') }).toEqual({ role, client: defaults.approve_return === true });
      // Refunds at Approve is the retired level form of refund approval: refused, owners included.
      expect({ role, client: ctx!.checkPermission('refunds', 'approve') }).toEqual({ role, client: false });
      if (ctx!.checkSubPermission('approve_refunds')) granted += 1;
      if (ctx!.checkSubPermission('approve_return')) granted += 1;
      unmount();
    }
    expect(granted).toBe(4); // control: store_owner and manager on both capabilities, nobody else
  });

  it('24. M5-GAP11-P5: the store family keeps every answer the rejected global ordering would have changed', async () => {
    // The superseded P2/P3 candidate (one global ordering + D2) changes 13 domain thresholds against the
    // authority. The client decides them in the tenant/store family, so each keeps the authority's answer.
    const rows = computeRepinnedGrantDiff(CANONICAL_DIFF_CONTEXT).rows
      .filter((r) => r.plane === 'tenant' && r.stratum === 'domain_threshold');
    let allowed = 0;
    let checked = 0;
    for (const role of ['manager', 'technician']) {
      getDoc.mockResolvedValue(existing(role));
      const { unmount } = render(<AccessProvider><CaptureCtx /></AccessProvider>);
      await fireAuth({ uid: `u-fam-${role}`, email: `fam-${role}@synthetic.test` });
      for (const r of rows.filter((x) => x.role === role)) {
        const level = r.action.replace(/^require:/, '') as PermissionLevel;
        const client = ctx!.checkPermission(r.scope, level);
        const l = `${r.role}/${r.scope}/${r.action}`;
        expect({ l, client }).toEqual({ l, client: r.before === 'granted' });
        expect({ l, differsFromRejectedCandidate: client !== (r.after === 'granted') }).toEqual({ l, differsFromRejectedCandidate: true });
        if (client) allowed += 1;
        checked += 1;
      }
      unmount();
    }
    expect(checked).toBe(13);
    expect(allowed).toBe(1); // control: only the manager's refunds `manage` gate is allowed
  });
});

describe('AccessProvider — POS operator switch onto edited and custom roles (M5-GAP11-P5)', () => {
  it('25. the operator\'s runtime role decides: store-family levels for non-money checks, explicit grants for money', async () => {
    getDoc.mockResolvedValue(existing('store_owner'));
    render(<AccessProvider><CaptureCtx /></AccessProvider>);
    await fireAuth({ uid: 'u-pos', email: 'pos@synthetic.test' });
    // Edited built-in role: Inventory set to Approve, Returns set to Approve (the P4 witnesses).
    act(() => { ctx!.updateTenantRole('technician', { inventory: 'approve', returns: 'approve' } as Record<string, PermissionLevel>); });
    act(() => { ctx!.setPosOperatorRole('technician'); });
    expect(ctx!.effectiveRole).toBe('technician');
    expect(ctx!.checkPermission('inventory', 'manage')).toBe(true); // store family: Approve satisfies Manage
    expect(ctx!.checkSubPermission('complete_return_disposition')).toBe(false); // explicit false kept from the shipped role
    expect(ctx!.checkSubPermission('approve_return')).toBe(false); // default grant: denied
    act(() => { ctx!.updateTenantRoleSubPermission('technician', 'approve_return', true); });
    expect(ctx!.checkSubPermission('approve_return')).toBe(true); // owner grant honoured
    act(() => { ctx!.updateTenantRole('manager', { returns: 'approve' } as Record<string, PermissionLevel>); });
    act(() => { ctx!.setPosOperatorRole('manager'); });
    expect(ctx!.checkSubPermission('approve_return')).toBe(true);
    expect(ctx!.checkSubPermission('complete_return_disposition')).toBe(true);
    // Custom role: a high level never grants a money capability; Manage does not satisfy Approve.
    act(() => { ctx!.addTenantRole({ id: 'custom_counter', name: 'Counter', permissions: { returns: 'full', refunds: 'full', inventory: 'manage' }, subPermissions: {} }); });
    act(() => { ctx!.setPosOperatorRole('custom_counter'); });
    expect(ctx!.checkSubPermission('approve_return')).toBe(false);
    expect(ctx!.checkSubPermission('approve_refunds')).toBe(false);
    expect(ctx!.checkPermission('inventory', 'approve')).toBe(false);
    expect(ctx!.checkPermission('inventory', 'manage')).toBe(true);
    act(() => { ctx!.updateTenantRoleSubPermission('custom_counter', 'approve_return', true); });
    expect(ctx!.checkSubPermission('approve_return')).toBe(true);
    expect(ctx!.requestSupervisorRefundAuth('custom_counter', '1234')).toBe(false); // no refund grant
    // A custom role named like a built-in or platform role gets its own id: it never shares or shadows
    // that role's levels and money grants.
    act(() => { ctx!.addTenantRole({ id: 'manager', name: 'Manager', permissions: { refunds: 'full' }, subPermissions: {} }); });
    act(() => { ctx!.addTenantRole({ id: 'system_owner', name: 'System Owner', permissions: { refunds: 'full' }, subPermissions: {} }); });
    const ids = ctx!.tenantRolesState.map((r) => r.id);
    expect(ids.filter((id) => id === 'manager')).toHaveLength(1);
    expect(ids).toEqual(expect.arrayContaining(['manager_2', 'system_owner_2']));
    expect(ids).not.toContain('system_owner');
    act(() => { ctx!.updateTenantRoleSubPermission('manager_2', 'approve_refunds', false); });
    expect(ctx!.tenantRolesState.find((r) => r.id === 'manager')!.subPermissions!.approve_refunds).toBe(true); // the built-in manager keeps its grant
    expect(ctx!.tenantRolesState.find((r) => r.id === 'manager_2')!.subPermissions!.approve_refunds).toBe(false);
    expect(ctx!.requestSupervisorRefundAuth('system_owner', '1234')).toBe(false); // still no store role with that id
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
