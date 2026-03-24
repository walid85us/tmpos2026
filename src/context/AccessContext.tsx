import React, { createContext, useContext, useState, useEffect, ReactNode } from 'react';
import { onAuthStateChanged } from 'firebase/auth';
import { doc, getDoc } from 'firebase/firestore';
import { auth, db } from '../firebase';
import { Role, Plan, AccountStatus, platformRoles as initialPlatformRoles, tenantRoles as initialTenantRoles, planFeatures } from './accessConfig';
import { EmployeeRole, PermissionLevel } from '../types';

interface Session {
  user: { id: string; name: string; email: string };
  userType: 'platform' | 'tenant';
  role: Role;
  status: 'active' | 'invited' | 'suspended' | 'pending_setup';
}

interface Tenant {
  id: string;
  name: string;
  plan: Plan;
  status: AccountStatus;
}

interface AccessContextType {
  session: Session | null;
  tenant: Tenant | null;
  loading: boolean;
  canAccess: (feature: string) => boolean;
  resolveLandingRoute: (session: Session) => string;
  isPreviewModeEnabled: boolean;
  enablePreviewMode: () => void;
  disablePreviewMode: () => void;
  setPreviewSession: (session: Session) => void;
  setPreviewTenant: (tenant: Tenant) => void;
  getAvailableRoles: () => { platform: EmployeeRole[], tenant: EmployeeRole[] };
  addPlatformRole: (role: EmployeeRole) => void;
  updatePlatformRole: (roleId: string, permissions: Record<string, PermissionLevel> | string[]) => void;
  addTenantRole: (role: EmployeeRole) => void;
  updateTenantRole: (roleId: string, permissions: Record<string, PermissionLevel> | string[]) => void;
  platformRolesState: EmployeeRole[];
  tenantRolesState: EmployeeRole[];
}

const AccessContext = createContext<AccessContextType | undefined>(undefined);

export const AccessProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [realSession, setRealSession] = useState<Session | null>(null);
  const [realTenant, setRealTenant] = useState<Tenant | null>(null);
  const [loading, setLoading] = useState(true);

  // Dynamic roles state
  const [platformRolesState, setPlatformRolesState] = useState(initialPlatformRoles);
  const [tenantRolesState, setTenantRolesState] = useState(initialTenantRoles);

  // Preview state
  const [isPreviewModeEnabled, setIsPreviewModeEnabled] = useState(false);
  const [previewSession, setPreviewSession] = useState<Session | null>(null);
  const [previewTenant, setPreviewTenant] = useState<Tenant | null>(null);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (user) => {
      if (user) {
        const userDoc = await getDoc(doc(db, 'users', user.uid));
        if (userDoc.exists()) {
          const userData = userDoc.data();
          const role = userData.role as Role;
          const isPlatformRole = platformRolesState.some(r => r.id === role);
          
          setRealSession({
            user: { id: user.uid, name: userData.name, email: user.email || '' },
            userType: isPlatformRole ? 'platform' : 'tenant',
            role: role,
            status: 'active',
          });
          // Mock tenant data
          setRealTenant({ id: 'tenant-1', name: 'My Store', plan: 'growth', status: 'active' });
        }
      } else {
        setRealSession(null);
        setRealTenant(null);
      }
      setLoading(false);
    });
    return unsubscribe;
  }, [platformRolesState]);

  const session = isPreviewModeEnabled ? previewSession : realSession;
  const tenant = isPreviewModeEnabled ? previewTenant : realTenant;

  const canAccess = (feature: string) => {
    if (!session) return false;
    
    // System Owner has access to everything
    if (session.role === 'system_owner') return true;

    // Tenant-level checks
    if (tenant) {
      // Check plan features
      const features = planFeatures[tenant.plan];
      if (!features.includes(feature)) return false;
      
      // Store Owner has access to everything in tenant
      if (session.role === 'store_owner') return true;
      
      // Role-based permission check from dynamic state
      const roleConfig = tenantRolesState.find(r => r.id === session.role);
      if (!roleConfig) return false;
      
      const hasPermission = Array.isArray(roleConfig.permissions) 
        ? roleConfig.permissions.includes(feature) || roleConfig.permissions.includes(`${feature}_read`) || roleConfig.permissions.includes('all')
        : roleConfig.permissions[feature] && roleConfig.permissions[feature] !== 'none' || roleConfig.permissions['all'] === 'full';
      return hasPermission;
    } else if (session.userType === 'platform') {
      // Platform-level checks
      const roleConfig = platformRolesState.find(r => r.id === session.role);
      if (!roleConfig) return false;
      
      const hasPermission = Array.isArray(roleConfig.permissions)
        ? roleConfig.permissions.includes(feature) || roleConfig.permissions.includes(`${feature}_read`) || roleConfig.permissions.includes('all')
        : roleConfig.permissions[feature] && roleConfig.permissions[feature] !== 'none' || roleConfig.permissions['all'] === 'full';
      return hasPermission;
    }
    
    return false;
  };

  const resolveLandingRoute = (session: Session) => {
    if (session.userType === 'platform') return '/owner';
    // Default tenant route
    return '/';
  };

  const getAvailableRoles = () => ({ platform: platformRolesState, tenant: tenantRolesState });

  const addPlatformRole = (role: EmployeeRole) => {
    setPlatformRolesState(prev => [...prev, role]);
  };

  const updatePlatformRole = (roleId: string, permissions: Record<string, PermissionLevel> | string[]) => {
    setPlatformRolesState(prev => prev.map(r => r.id === roleId ? { ...r, permissions } : r));
  };

  const addTenantRole = (role: EmployeeRole) => {
    setTenantRolesState(prev => [...prev, role]);
  };

  const updateTenantRole = (roleId: string, permissions: Record<string, PermissionLevel> | string[]) => {
    setTenantRolesState(prev => prev.map(r => r.id === roleId ? { ...r, permissions } : r));
  };

  return (
    <AccessContext.Provider value={{ 
      session, 
      tenant, 
      loading, 
      canAccess,
      resolveLandingRoute,
      isPreviewModeEnabled,
      enablePreviewMode: () => setIsPreviewModeEnabled(true),
      disablePreviewMode: () => setIsPreviewModeEnabled(false),
      setPreviewSession,
      setPreviewTenant,
      getAvailableRoles,
      addPlatformRole,
      updatePlatformRole,
      addTenantRole,
      updateTenantRole,
      platformRolesState,
      tenantRolesState
    }}>
      {children}
    </AccessContext.Provider>
  );
};

export const useAccess = () => {
  const context = useContext(AccessContext);
  if (!context) throw new Error('useAccess must be used within an AccessProvider');
  return context;
};

