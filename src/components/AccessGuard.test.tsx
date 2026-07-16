import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import AccessGuard from './AccessGuard';
import * as AccessCtx from '../context/AccessContext';

vi.mock('../context/AccessContext', () => ({ useAccess: vi.fn() }));
const useAccess = vi.mocked(AccessCtx.useAccess);
// Test code assigns partial access values to the hook mock; keep tsc clean
// without weakening the real hook's type.
const asAccess = (v: unknown) => v as ReturnType<typeof AccessCtx.useAccess>;

const base = {
  session: null,
  loading: false,
  authError: null,
  isDevSession: false,
  resolveLandingRoute: () => '/landing',
  canAccess: () => true,
};

function renderGuard(props: Record<string, unknown> = {}) {
  return render(
    <MemoryRouter initialEntries={['/protected']}>
      <Routes>
        <Route path="/protected" element={<AccessGuard {...props}><div>PROTECTED</div></AccessGuard>} />
        <Route path="/login" element={<div>LOGIN</div>} />
        <Route path="/not-provisioned" element={<div>NOT_PROV</div>} />
        <Route path="/landing" element={<div>LANDING</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => useAccess.mockReset());

describe('AccessGuard', () => {
  it('shows a loading state while auth resolves', () => {
    useAccess.mockReturnValue(asAccess({ ...base, loading: true }));
    renderGuard();
    expect(screen.getByText('Loading...')).toBeInTheDocument();
  });

  it('redirects to /login when there is no session', () => {
    useAccess.mockReturnValue(asAccess({ ...base, session: null }));
    renderGuard();
    expect(screen.getByText('LOGIN')).toBeInTheDocument();
  });

  it('redirects to /not-provisioned on an auth error (non-dev)', () => {
    useAccess.mockReturnValue(asAccess({ ...base, authError: 'denied' }));
    renderGuard();
    expect(screen.getByText('NOT_PROV')).toBeInTheDocument();
  });

  it('renders children for an allowed user type', () => {
    useAccess.mockReturnValue(asAccess({ ...base, session: { userType: 'tenant', role: 'owner' } }));
    renderGuard({ allowedUserTypes: ['tenant'] });
    expect(screen.getByText('PROTECTED')).toBeInTheDocument();
  });

  it('redirects a denied user type to the landing route', () => {
    useAccess.mockReturnValue(asAccess({ ...base, session: { userType: 'platform', role: 'x' } }));
    renderGuard({ allowedUserTypes: ['tenant'] });
    expect(screen.getByText('LANDING')).toBeInTheDocument();
  });

  it('allows a matching required role', () => {
    useAccess.mockReturnValue(asAccess({ ...base, session: { userType: 'tenant', role: 'owner' } }));
    renderGuard({ requiredRole: 'owner' });
    expect(screen.getByText('PROTECTED')).toBeInTheDocument();
  });

  it('redirects a mismatched required role', () => {
    useAccess.mockReturnValue(asAccess({ ...base, session: { userType: 'tenant', role: 'staff' } }));
    renderGuard({ requiredRole: 'owner' });
    expect(screen.getByText('LANDING')).toBeInTheDocument();
  });

  it('does not log session identifiers (uid/role) on redirect', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    useAccess.mockReturnValue(asAccess({ ...base, session: { userType: 'platform', role: 'secret-role-xyz', uid: 'uid-abc-123' } }));
    renderGuard({ allowedUserTypes: ['tenant'] });
    const logged = spy.mock.calls.flat().join(' ');
    expect(logged).not.toContain('uid-abc-123');
    expect(logged).not.toContain('secret-role-xyz');
    spy.mockRestore();
  });
});
