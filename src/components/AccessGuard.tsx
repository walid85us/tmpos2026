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
  const { session, loading, authError, isPreviewModeEnabled, resolveLandingRoute, canAccess } = useAccess();

  if (loading) {
    console.log('[AccessGuard] Still loading auth state...');
    return <div className="min-h-screen flex items-center justify-center"><p className="text-slate-500">Loading...</p></div>;
  }

  if (authError) {
    console.log('[AccessGuard] Auth error detected:', authError, '— redirecting to /not-provisioned');
    return <Navigate to="/not-provisioned" replace />;
  }

  if (!session && !isPreviewModeEnabled) {
    console.log('[AccessGuard] No session, not preview — redirecting to /login');
    return <Navigate to="/login" replace />;
  }

  if (session && allowedUserTypes && !allowedUserTypes.includes(session.userType)) {
    const target = resolveLandingRoute(session);
    console.log('[AccessGuard] UserType mismatch. session.userType:', session.userType, 'allowed:', allowedUserTypes, '— redirecting to', target);
    return <Navigate to={target} replace />;
  }

  if (session && requiredRole && session.role !== requiredRole) {
    const target = resolveLandingRoute(session);
    console.log('[AccessGuard] Role mismatch. session.role:', session.role, 'required:', requiredRole, '— redirecting to', target);
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
