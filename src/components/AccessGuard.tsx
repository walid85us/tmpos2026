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
  const { session, loading, isPreviewModeEnabled, resolveLandingRoute, canAccess } = useAccess();

  if (loading) return <div>Loading...</div>;

  // If not authenticated AND not in preview mode, redirect to login
  if (!session && !isPreviewModeEnabled) return <Navigate to="/login" replace />;

  // If in preview mode, we assume session is valid for the sake of the guard
  if (session && allowedUserTypes && !allowedUserTypes.includes(session.userType)) {
    return <Navigate to={resolveLandingRoute(session)} replace />;
  }

  if (session && requiredRole && session.role !== requiredRole) {
    return <Navigate to="/unauthorized" replace />;
  }

  if (session && feature && !canAccess(feature)) {
    return <Navigate to={resolveLandingRoute(session)} replace />;
  }

  return <>{children}</>;
};

export default AccessGuard;
