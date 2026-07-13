import React from 'react';
import { Navigate } from 'react-router-dom';
import { useAccess } from '../context/AccessContext';

interface AccessGuardProps {
  children: React.ReactNode;
  allowedUserTypes?: ('platform' | 'tenant')[];
  requiredRole?: string;
  requiredPlan?: string;
  feature?: string;
  redirectPath?: string;
}

const AccessGuard: React.FC<AccessGuardProps> = ({ children, allowedUserTypes, requiredRole, feature, redirectPath = '/' }) => {
  const { session, loading, authError, isDevSession, resolveLandingRoute, canAccess } = useAccess();

  if (loading) {
    console.log('[AccessGuard] Still loading auth state...');
    return <div className="min-h-screen flex items-center justify-center"><p className="text-slate-500">Loading...</p></div>;
  }

  // DEV-only dev session must win over a stale/residual Firebase authError.
  // `isDevSession` can only ever be true through the DEV-gated DevSessionSwitcher
  // (import.meta.env.DEV), so production Firebase Auth behavior is unchanged:
  // when no dev session is active this is identical to `if (authError)`.
  if (authError && !isDevSession) {
    console.log('[AccessGuard] Auth error detected:', authError, '— redirecting to /not-provisioned');
    return <Navigate to="/not-provisioned" replace />;
  }

  if (!session && !isDevSession) {
    console.log('[AccessGuard] No session, not dev session — redirecting to /login');
    return <Navigate to="/login" replace />;
  }

  if (session && allowedUserTypes && !allowedUserTypes.includes(session.userType)) {
    const target = resolveLandingRoute(session);
    return <Navigate to={target} replace />;
  }

  if (session && requiredRole && session.role !== requiredRole) {
    const target = resolveLandingRoute(session);
    return <Navigate to={target} replace />;
  }

  if (session && feature && !canAccess(feature)) {
    const target = resolveLandingRoute(session);
    console.log('[AccessGuard] Feature not accessible:', feature, '— redirecting to', target);
    return <Navigate to={target} replace />;
  }

  return <>{children}</>;
};

export default AccessGuard;
