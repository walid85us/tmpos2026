import React, { createContext, useContext, useState, useEffect, useCallback, ReactNode } from 'react';
import { onAuthStateChanged } from 'firebase/auth';
import { doc, getDoc } from 'firebase/firestore';
import { auth, db } from '../firebase';
import { Role, Plan, AccountStatus, platformRoles as initialPlatformRoles, tenantRoles as initialTenantRoles, planFeatures, adminPermissions, PERMISSION_HIERARCHY, meetsPermissionLevel, PERMISSION_DOMAINS, SUB_PERMISSIONS } from './accessConfig';
import { EmployeeRole, PermissionLevel } from '../types';

interface Session {
  user: { id: string; name: string; email: string };
  userType: 'platform' | 'tenant';
  role: Role;
  status: 'active' | 'invited' | 'suspended' | 'pending_setup';
}

export type OnboardingStage = 'invited' | 'pending_setup' | 'setup_incomplete' | 'pending_activation' | 'active';
export type DomainMode = 'platform_subdomain' | 'custom_pending' | 'custom_dns_pending' | 'custom_ssl_pending' | 'custom_active';

export interface OnboardingChecklist {
  profileComplete: boolean;
  paymentMethodAdded: boolean;
  firstProductAdded: boolean;
  domainConfigured: boolean;
  teamInvited: boolean;
  storeCustomized: boolean;
  storeSetupComplete: boolean;
}

export interface TenantDomainInfo {
  mode: DomainMode;
  subdomain: string;
  customDomain?: string;
  dnsVerified: boolean;
  sslProvisioned: boolean;
  propagated: boolean;
}

interface Tenant {
  id: string;
  name: string;
  plan: Plan;
  status: AccountStatus;
  onboardingStage?: OnboardingStage;
  onboardingChecklist?: OnboardingChecklist;
  domainInfo?: TenantDomainInfo;
  inviteSentDate?: string;
  setupStartedDate?: string;
  activatedDate?: string;
  trialEndsDate?: string;
}

export const ONBOARDING_ALLOWED_MODULES = ['dashboard', 'settings', 'support'];

interface AccessContextType {
  session: Session | null;
  tenant: Tenant | null;
  loading: boolean;
  authError: string | null;
  canAccess: (feature: string) => boolean;
  isStoreActivated: () => boolean;
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
  posOperatorRole: string | null;
  setPosOperatorRole: (role: string | null) => void;
  effectiveRole: string;
  hasPermission: (perm: string) => boolean;
  getPermissionLevel: (domain: string) => PermissionLevel;
  checkPermission: (domain: string, requiredLevel: PermissionLevel) => boolean;
  checkSubPermission: (actionId: string) => boolean;
  updateTenantRoleSubPermission: (roleId: string, actionId: string, granted: boolean) => void;
  supervisorRefundAuth: { active: boolean; supervisorName: string } | null;
  requestSupervisorRefundAuth: (supervisorId: string, pin: string) => boolean;
  clearSupervisorRefundAuth: () => void;
}

const AccessContext = createContext<AccessContextType | undefined>(undefined);

function resolvePermissionLevel(roleConfig: EmployeeRole, domain: string): PermissionLevel {
  const perms = roleConfig.permissions;
  if (Array.isArray(perms)) {
    if (perms.includes('all')) return 'full';
    if (perms.includes(domain)) return 'full';
    if (perms.includes(`${domain}_read`)) return 'view';
    return 'none';
  }
  if ((perms as Record<string, PermissionLevel>)['_grant'] === 'full') return 'full';
  return (perms as Record<string, PermissionLevel>)[domain] || 'none';
}

export const AccessProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [realSession, setRealSession] = useState<Session | null>(null);
  const [realTenant, setRealTenant] = useState<Tenant | null>(null);
  const [loading, setLoading] = useState(true);
  const [authError, setAuthError] = useState<string | null>(null);

  const [platformRolesState, setPlatformRolesState] = useState(initialPlatformRoles);
  const [tenantRolesState, setTenantRolesState] = useState(initialTenantRoles);

  const [isPreviewModeEnabled, setIsPreviewModeEnabled] = useState(false);
  const [previewSession, setPreviewSession] = useState<Session | null>(null);
  const [previewTenant, setPreviewTenant] = useState<Tenant | null>(null);
  const [posOperatorRole, setPosOperatorRole] = useState<string | null>(null);
  const [supervisorRefundAuth, setSupervisorRefundAuth] = useState<{ active: boolean; supervisorName: string } | null>(null);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (user) => {
      console.log('[AccessContext] onAuthStateChanged fired, user:', user ? user.uid : 'null');

      if (user) {
        try {
          const userDoc = await getDoc(doc(db, 'users', user.uid));

          if (userDoc.exists()) {
            const userData = userDoc.data();
            const role = userData.role as Role;
            const isPlatformRole = platformRolesState.some(r => r.id === role);

            console.log('[AccessContext] User doc found. role:', role, 'isPlatformRole:', isPlatformRole);

            setRealSession({
              user: { id: user.uid, name: userData.name, email: user.email || '' },
              userType: isPlatformRole ? 'platform' : 'tenant',
              role: role,
              status: 'active',
            });

            if (isPlatformRole) {
              console.log('[AccessContext] Platform user — tenant set to null');
              setRealTenant(null);
            } else {
              console.log('[AccessContext] Tenant user — setting mock tenant');
              setRealTenant({
                id: 'tenant-1', name: 'My Store', plan: 'growth', status: 'active',
                onboardingStage: 'active',
                onboardingChecklist: { profileComplete: true, paymentMethodAdded: true, firstProductAdded: true, domainConfigured: true, teamInvited: true, storeCustomized: true, storeSetupComplete: true },
                domainInfo: { mode: 'custom_active', subdomain: 'my-store.repairplatform.io', customDomain: 'mystore.com', dnsVerified: true, sslProvisioned: true, propagated: true },
                activatedDate: '2026-02-15',
              });
            }

            setAuthError(null);
          } else {
            console.warn('[AccessContext] No Firestore user doc for uid:', user.uid);
            setRealSession(null);
            setRealTenant(null);
            setAuthError('account_not_provisioned');
          }
        } catch (err) {
          console.error('[AccessContext] Firestore read failed:', err);
          setRealSession(null);
          setRealTenant(null);
          setAuthError('firestore_error');
        }
      } else {
        console.log('[AccessContext] No Firebase user — clearing session');
        setRealSession(null);
        setRealTenant(null);
        setAuthError(null);
        setPosOperatorRole(null);
      }

      setLoading(false);
    });
    return unsubscribe;
  }, [platformRolesState]);

  const session = isPreviewModeEnabled ? previewSession : realSession;
  const tenant = isPreviewModeEnabled ? previewTenant : realTenant;
  const effectiveRole = (session?.userType === 'tenant' && posOperatorRole) ? posOperatorRole : (session?.role || '');

  const isStoreActivated = (): boolean => {
    if (!session || !tenant) return false;
    if (session.userType === 'platform') return true;
    const stage = tenant.onboardingStage || (tenant.status === 'active' || tenant.status === 'trialing' ? 'active' : 'pending_setup');
    return stage === 'active' && (tenant.status === 'active' || tenant.status === 'trialing' || tenant.status === 'overdue');
  };

  const getPermissionLevel = useCallback((domain: string): PermissionLevel => {
    if (!session) return 'none';
    if (effectiveRole === 'system_owner' || effectiveRole === 'store_owner') return 'full';

    const roleConfig = tenantRolesState.find(r => r.id === effectiveRole);
    if (!roleConfig) return 'none';
    return resolvePermissionLevel(roleConfig, domain);
  }, [session, effectiveRole, tenantRolesState]);

  const checkPermission = useCallback((domain: string, requiredLevel: PermissionLevel): boolean => {
    const actual = getPermissionLevel(domain);
    return meetsPermissionLevel(actual, requiredLevel);
  }, [getPermissionLevel]);

  const checkSubPermission = useCallback((actionId: string): boolean => {
    if (!session) return false;
    if (effectiveRole === 'system_owner' || effectiveRole === 'store_owner') return true;

    const actionDef = SUB_PERMISSIONS.find(sp => sp.id === actionId);
    if (!actionDef) return false;

    const parentLevel = getPermissionLevel(actionDef.parentDomain);
    if (!meetsPermissionLevel(parentLevel, actionDef.minModuleLevel)) return false;

    const roleConfig = tenantRolesState.find(r => r.id === effectiveRole);
    if (!roleConfig) return false;

    if (roleConfig.subPermissions && actionId in roleConfig.subPermissions) {
      return roleConfig.subPermissions[actionId];
    }

    return meetsPermissionLevel(parentLevel, actionDef.defaultLevel);
  }, [session, effectiveRole, tenantRolesState, getPermissionLevel]);

  const updateTenantRoleSubPermission = (roleId: string, actionId: string, granted: boolean) => {
    setTenantRolesState(prev => prev.map(r => {
      if (r.id !== roleId) return r;
      const existing = r.subPermissions || {};
      return { ...r, subPermissions: { ...existing, [actionId]: granted } };
    }));
  };

  const canAccess = (feature: string) => {
    if (!session) return false;

    if (session.role === 'system_owner') return true;

    if (session.userType === 'platform') {
      const roleConfig = platformRolesState.find(r => r.id === session.role);
      if (!roleConfig) return false;

      const hasPermission = Array.isArray(roleConfig.permissions)
        ? roleConfig.permissions.includes(feature) || roleConfig.permissions.includes(`${feature}_read`) || roleConfig.permissions.includes('all')
        : roleConfig.permissions[feature] && roleConfig.permissions[feature] !== 'none' || roleConfig.permissions['all'] === 'full';
      return hasPermission;
    }

    if (tenant) {
      const isAdminPerm = adminPermissions.includes(feature);
      const activated = isStoreActivated();

      if (!isAdminPerm && !activated) {
        if (!ONBOARDING_ALLOWED_MODULES.includes(feature)) return false;
        if (effectiveRole === 'store_owner') return true;
      }

      const normalizedFeature = feature === 'supply-chain' ? 'supply_chain' : feature;

      if (!isAdminPerm && activated) {
        let features = planFeatures[tenant.plan];
        try {
          const storedFeatures = sessionStorage.getItem('features_data');
          if (storedFeatures) {
            const parsed = JSON.parse(storedFeatures);
            const planKey = tenant.plan === 'starter' ? 'essential' : tenant.plan;
            if (Array.isArray(parsed) && parsed.length > 0) {
              if (parsed[0].planAvailability) {
                const enabledIds = parsed
                  .filter((f: { planAvailability?: Record<string, boolean> }) => f.planAvailability?.[planKey])
                  .map((f: { id: string }) => f.id);
                features = enabledIds;
              } else {
                const planEntry = parsed.find((f: { planId: string }) => f.planId === tenant.plan);
                if (planEntry && Array.isArray(planEntry.features)) {
                  const enabledIds = planEntry.features
                    .filter((f: { enabled: boolean }) => f.enabled)
                    .map((f: { id: string }) => f.id);
                  features = enabledIds;
                }
              }
            }
          }
        } catch {}
        if (!features.includes(feature) && !features.includes(normalizedFeature)) return false;
      }

      if (effectiveRole === 'store_owner') return true;

      const level = getPermissionLevel(normalizedFeature);
      return meetsPermissionLevel(level, 'view');
    }

    return false;
  };

  const hasPermission = (perm: string): boolean => {
    return checkPermission(perm, 'create');
  };

  const resolveLandingRoute = (session: Session) => {
    if (session.userType === 'platform') return '/owner';
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

  const requestSupervisorRefundAuth = (supervisorId: string, pin: string): boolean => {
    if (pin !== '1234') return false;
    const supervisorRole = tenantRolesState.find(r => r.id === supervisorId);
    if (!supervisorRole) return false;
    const refundLevel = resolvePermissionLevel(supervisorRole, 'refunds');
    if (!meetsPermissionLevel(refundLevel, 'approve')) return false;
    if (supervisorRole.subPermissions && supervisorRole.subPermissions['approve_refunds'] === false) return false;
    const names: Record<string, string> = { store_owner: 'Store Owner', manager: 'Manager' };
    setSupervisorRefundAuth({ active: true, supervisorName: names[supervisorId] || supervisorRole.name });
    return true;
  };

  const clearSupervisorRefundAuth = () => {
    setSupervisorRefundAuth(null);
  };

  return (
    <AccessContext.Provider value={{
      session,
      tenant,
      loading,
      authError,
      canAccess,
      isStoreActivated,
      resolveLandingRoute,
      isPreviewModeEnabled,
      enablePreviewMode: () => setIsPreviewModeEnabled(true),
      disablePreviewMode: () => { setIsPreviewModeEnabled(false); setPosOperatorRole(null); setSupervisorRefundAuth(null); },
      setPreviewSession: (s: Session) => { setPreviewSession(s); setPosOperatorRole(null); setSupervisorRefundAuth(null); },
      setPreviewTenant,
      getAvailableRoles,
      addPlatformRole,
      updatePlatformRole,
      addTenantRole,
      updateTenantRole,
      platformRolesState,
      tenantRolesState,
      posOperatorRole,
      setPosOperatorRole,
      effectiveRole,
      hasPermission,
      getPermissionLevel,
      checkPermission,
      checkSubPermission,
      updateTenantRoleSubPermission,
      supervisorRefundAuth,
      requestSupervisorRefundAuth,
      clearSupervisorRefundAuth
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
