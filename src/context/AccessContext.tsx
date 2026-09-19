import React, { createContext, useContext, useState, useEffect, useRef, useCallback, useMemo, ReactNode } from 'react';
import { onAuthStateChanged } from 'firebase/auth';
import { doc, getDoc } from 'firebase/firestore';
import { auth, db } from '../firebase';
import { Role, Plan, AccountStatus, platformRoles as initialPlatformRoles, tenantRoles as initialTenantRoles, planFeatures, adminPermissions, PERMISSION_DOMAINS } from './accessConfig';
import { isPermissionLevel, meetsFamilyLevel } from '../authorization/permissionFamilies';
import {
  decideSupervisorRefundApproval,
  decideTenantPermission,
  decideTenantSubPermission,
  tenantPermissionLevel,
  type TenantDecisionInput,
} from './tenantAccessDecisions';
import { EmployeeRole, PermissionLevel } from '../types';
import { NAV_FEATURE_TO_PLATFORM_KEY, NAV_FEATURE_SECONDARY_KEYS, hasEffectiveFeatureAccess } from '../owner/platformPermissionsConfig';
// Phase 1.6 M8 — TYPE-ONLY import (erased at runtime; pulls NO module into the bundle).
// Shape of the dormant, non-secret awareness record produced by the M7 helper. Used solely
// to type a PRIVATE observer ref; it is NEVER added to the context value or any permission path.
import type { AccessAwarenessRecord } from '../auth/supabaseAccessAwarenessTypes';

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

// Routes App.tsx gates (Coming Soon placeholders) that belong to no permission or plan catalog.
export const NAVIGATION_ONLY_FEATURES = ['app-store', 'ledger', 'mail-in'];

// The full vocabulary of feature strings canAccess() may legitimately be
// asked about: every platform nav key, every tenant plan feature, every
// admin action id, every onboarding-allowed module, every store permission
// domain, the supply-chain/supply_chain alias pair, and the navigation-only
// placeholders above. Bounds the System Owner's blanket access so an
// unknown or empty feature string denies instead of silently passing.
const KNOWN_NAVIGATION_FEATURES: ReadonlySet<string> = new Set<string>([
  ...Object.keys(NAV_FEATURE_TO_PLATFORM_KEY),
  ...Object.keys(NAV_FEATURE_SECONDARY_KEYS),
  ...Object.values(planFeatures).flat(),
  ...adminPermissions,
  ...ONBOARDING_ALLOWED_MODULES,
  ...PERMISSION_DOMAINS.map(d => d.id),
  'supply-chain', 'supply_chain',
  ...NAVIGATION_ONLY_FEATURES,
]);

export function isKnownNavigationFeature(feature: string): boolean {
  return KNOWN_NAVIGATION_FEATURES.has(feature);
}

interface AccessContextType {
  session: Session | null;
  tenant: Tenant | null;
  loading: boolean;
  authError: string | null;
  canAccess: (feature: string) => boolean;
  isStoreActivated: () => boolean;
  resolveLandingRoute: (session: Session) => string;
  isPreviewModeEnabled: boolean;
  isDevSession: boolean;
  isWriteBlocked: boolean;
  enablePreviewMode: () => void;
  disablePreviewMode: () => void;
  disableWriteBlock: () => void;
  activateDevSession: () => void;
  deactivateDevSession: () => void;
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

export const AccessProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [realSession, setRealSession] = useState<Session | null>(null);
  const [realTenant, setRealTenant] = useState<Tenant | null>(null);
  const [loading, setLoading] = useState(true);
  const [authError, setAuthError] = useState<string | null>(null);

  // EmployeeRole is the canonical role shape this context already exposes
  // (platformRolesState/tenantRolesState: EmployeeRole[]). The seed arrays only ever
  // use the string[] permissions form, so without this annotation the state narrows to
  // that seed shape and rejects the canonical Record<string, PermissionLevel> form.
  const [platformRolesState, setPlatformRolesState] = useState<EmployeeRole[]>(initialPlatformRoles);
  const [tenantRolesState, setTenantRolesState] = useState<EmployeeRole[]>(initialTenantRoles);

  const [isPreviewModeEnabled, setIsPreviewModeEnabled] = useState(false);
  const [isDevSession, setIsDevSession] = useState(false);
  const [previewSession, setPreviewSession] = useState<Session | null>(null);
  const [previewTenant, setPreviewTenant] = useState<Tenant | null>(null);
  const [posOperatorRole, setPosOperatorRole] = useState<string | null>(null);
  const [supervisorRefundAuth, setSupervisorRefundAuth] = useState<{ active: boolean; supervisorName: string } | null>(null);

  // Phase 1.6 M8 — PRIVATE, non-authoritative observer ref (NOT React state, NOT in the
  // provider value). Holds the latest dormant Supabase awareness record for DEV-only
  // inspection. It is read by NOTHING — not session/tenant/role/plan/permissions/loading/
  // routing/AccessGuard. Firebase remains the sole authoritative session source.
  const supabaseAwarenessRef = useRef<AccessAwarenessRecord | null>(null);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (user) => {
      if (user) {
        try {
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

            if (isPlatformRole) {
              setRealTenant(null);
            } else {
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
            setRealSession(null);
            setRealTenant(null);
            setAuthError('account_not_provisioned');
          }
        } catch {
          setRealSession(null);
          setRealTenant(null);
          setAuthError('firestore_error');
        }
      } else {
        setRealSession(null);
        setRealTenant(null);
        setAuthError(null);
        setPosOperatorRole(null);
      }

      setLoading(false);
    });
    return unsubscribe;
  }, [platformRolesState]);

  // Phase 1.6 M8 — DORMANT, DEV+flag-gated, one-shot Supabase awareness OBSERVER.
  // This effect is SEPARATE from the Firebase listener above (which is unchanged) and is
  // strictly observational: it never affects session/tenant/role/plan/permissions/loading/
  // routing/AccessGuard, and its result lives ONLY in the private ref above.
  //
  // The DEV/flag guards are read through a narrow cast because this repo ships no
  // `vite/client` env types (bare `import.meta.env` is a pre-existing typing gap). After
  // TypeScript erases the cast, the JS is the EXACT `import.meta.env.DEV` /
  // `import.meta.env.VITE_…` member access that Vite statically folds to `false`/`undefined`
  // in production — so the dynamic import below becomes dead code and is tree-shaken OUT of
  // the production bundle (proven by the bundle secret scan). Default behaviour is OFF:
  // absent/false flag (and any production build) means no import, no call, no observation.
  useEffect(() => {
    if ((import.meta as unknown as { env: { DEV?: boolean } }).env.DEV !== true) return;
    if ((import.meta as unknown as { env: { VITE_ENABLE_ACCESSCONTEXT_SUPABASE_AWARENESS?: string } }).env.VITE_ENABLE_ACCESSCONTEXT_SUPABASE_AWARENESS !== 'true') return;
    // Run only AFTER Firebase initialization has completed (loading flipped to false).
    // We only READ loading here; we never write it, so loading semantics are unchanged.
    if (loading) return;

    const controller = new AbortController();
    // One-shot. The M7 helper self-gates, is no-throw, and is cancellation-safe; we pass the
    // signal so StrictMode's mount→cleanup→remount aborts the first run cleanly. The catch is
    // defensive only (the helper already never throws). No token/session payload is logged.
    void (async () => {
      try {
        const mod = await import('../auth/supabaseAccessAwareness');
        const record = await mod.runAccessContextSupabaseAwarenessObservation({ signal: controller.signal });
        if (!controller.signal.aborted) {
          supabaseAwarenessRef.current = record;
        }
      } catch {
        /* no-op: never surface awareness detail; Firebase remains authoritative */
      }
    })();

    return () => controller.abort();
  }, [loading]);

  const session = isDevSession ? previewSession : realSession;
  const tenant = isDevSession ? previewTenant : realTenant;
  const isWriteBlocked = isPreviewModeEnabled;
  const effectiveRole = (session?.userType === 'tenant' && posOperatorRole) ? posOperatorRole : (session?.role || '');

  const isStoreActivated = (): boolean => {
    if (!session || !tenant) return false;
    if (session.userType === 'platform') return true;
    const stage = tenant.onboardingStage || (tenant.status === 'active' || tenant.status === 'trialing' ? 'active' : 'pending_setup');
    return stage === 'active' && (tenant.status === 'active' || tenant.status === 'trialing' || tenant.status === 'overdue');
  };

  // Every store-plane decision is a pure function of this runtime data (tenantAccessDecisions.ts):
  // the session, the effective role, the runtime roles (built-in, owner-edited and custom alike) and
  // the tenant's plan. Plan availability runs before every shortcut, owners included; money
  // capabilities are decided by their explicit grant only (M5-GAP11-P5).
  const decisionInput = useMemo<TenantDecisionInput>(() => ({
    hasSession: session !== null,
    effectiveRole,
    roles: tenantRolesState,
    tenant: tenant ? { id: tenant.id, plan: tenant.plan } : null,
  }), [session, effectiveRole, tenantRolesState, tenant]);

  const getPermissionLevel = useCallback(
    (domain: string): PermissionLevel => tenantPermissionLevel(decisionInput, domain),
    [decisionInput],
  );

  const checkPermission = useCallback(
    (domain: string, requiredLevel: PermissionLevel): boolean => decideTenantPermission(decisionInput, domain, requiredLevel),
    [decisionInput],
  );

  const checkSubPermission = useCallback(
    (actionId: string): boolean => decideTenantSubPermission(decisionInput, actionId),
    [decisionInput],
  );

  const updateTenantRoleSubPermission = (roleId: string, actionId: string, granted: boolean) => {
    setTenantRolesState(prev => prev.map(r => {
      if (r.id !== roleId) return r;
      const existing = r.subPermissions || {};
      return { ...r, subPermissions: { ...existing, [actionId]: granted } };
    }));
  };

  const canAccess = (feature: string) => {
    if (!session) return false;

    // Owner keeps every KNOWN feature; an unknown or empty one is refused
    // rather than silently passing through a blanket "role is owner" check.
    if (session.role === 'system_owner') return isKnownNavigationFeature(feature);

    if (session.userType === 'platform') {
      const platformKey = NAV_FEATURE_TO_PLATFORM_KEY[feature];
      if (platformKey) {
        if (hasEffectiveFeatureAccess(session.role, platformKey)) return true;
        const secondaryKeys = NAV_FEATURE_SECONDARY_KEYS[feature];
        if (secondaryKeys) {
          for (const sk of secondaryKeys) {
            if (hasEffectiveFeatureAccess(session.role, sk)) return true;
          }
        }
        return false;
      }
      const roleConfig = platformRolesState.find(r => r.id === session.role);
      if (!roleConfig) return false;
      const hasPermission = Array.isArray(roleConfig.permissions)
        ? roleConfig.permissions.includes(feature) || roleConfig.permissions.includes(`${feature}_read`) || roleConfig.permissions.includes('all')
        // Own-property reads: the stored value must be exactly a canonical
        // level other than 'none' (a truthy-but-malformed value no longer
        // grants access).
        : (Object.prototype.hasOwnProperty.call(roleConfig.permissions, feature) && isPermissionLevel(roleConfig.permissions[feature]) && roleConfig.permissions[feature] !== 'none')
          || (Object.prototype.hasOwnProperty.call(roleConfig.permissions, 'all') && roleConfig.permissions['all'] === 'full');
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
        const baselineFeatures = planFeatures[tenant.plan] || [];
        let features = [...baselineFeatures];
        try {
          const storedFeatures = sessionStorage.getItem('features_data');
          if (storedFeatures) {
            const parsed = JSON.parse(storedFeatures);
            const planKey = tenant.plan === 'starter' ? 'essential' : tenant.plan;
            if (Array.isArray(parsed) && parsed.length > 0) {
              if (parsed[0].planAvailability) {
                const matrixIds = new Set(parsed.map((f: { id: string }) => f.id));
                const enabledIds = parsed
                  .filter((f: { planAvailability?: Record<string, boolean> }) => f.planAvailability?.[planKey])
                  .map((f: { id: string }) => f.id);
                const enabledSet = new Set(enabledIds);
                features = baselineFeatures.filter(f => {
                  const normalizedF = f === 'supply-chain' ? 'supply_chain' : f;
                  if (matrixIds.has(f) || matrixIds.has(normalizedF)) {
                    return enabledSet.has(f) || enabledSet.has(normalizedF);
                  }
                  return true;
                });
                enabledIds.forEach((id: string) => {
                  if (!features.includes(id)) features.push(id);
                });
              } else {
                const legacyPlanKey = tenant.plan === 'starter' ? 'essential' : tenant.plan;
                const planEntry = parsed.find((f: { planId: string }) => f.planId === tenant.plan || f.planId === legacyPlanKey);
                if (planEntry && Array.isArray(planEntry.features)) {
                  const matrixIds = new Set(planEntry.features.map((f: { id: string }) => f.id));
                  const enabledIds = planEntry.features
                    .filter((f: { enabled: boolean }) => f.enabled)
                    .map((f: { id: string }) => f.id);
                  const enabledSet = new Set(enabledIds);
                  features = baselineFeatures.filter(f => {
                    const normalizedF = f === 'supply-chain' ? 'supply_chain' : f;
                    if (matrixIds.has(f) || matrixIds.has(normalizedF)) {
                      return enabledSet.has(f) || enabledSet.has(normalizedF);
                    }
                    return true;
                  });
                  enabledIds.forEach((id: string) => {
                    if (!features.includes(id)) features.push(id);
                  });
                }
              }
            }
          }
        } catch {}
        if (!features.includes(feature) && !features.includes(normalizedFeature)) return false;
      }

      if (effectiveRole === 'store_owner') return true;

      // An unknown tenant role (not present in tenantRolesState) must not
      // reach the default-allow-if-not-a-permission-domain branch below.
      if (!tenantRolesState.some(r => r.id === effectiveRole)) return false;

      const isPermissionDomain = PERMISSION_DOMAINS.some(d => d.id === normalizedFeature);
      if (!isPermissionDomain) return true;

      const level = getPermissionLevel(normalizedFeature);
      return meetsFamilyLevel('tenant_store', level, 'view');
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
    setPlatformRolesState(prev => {
      // Same rule as addTenantRole: never an id a platform or store role already uses.
      const taken = new Set([...prev, ...tenantRolesState].map(r => r.id));
      let id = role.id;
      for (let n = 2; taken.has(id); n++) id = `${role.id}_${n}`;
      return [...prev, { ...role, id }];
    });
  };

  const updatePlatformRole = (roleId: string, permissions: Record<string, PermissionLevel> | string[]) => {
    setPlatformRolesState(prev => prev.map(r => r.id === roleId ? { ...r, permissions } : r));
  };

  const addTenantRole = (role: EmployeeRole) => {
    setTenantRolesState(prev => {
      // Roles are looked up by id everywhere, so a new role never takes an id a store or platform role
      // already uses: a duplicate would share or shadow that role's levels and money grants.
      const taken = new Set([...prev, ...platformRolesState].map(r => r.id));
      let id = role.id;
      for (let n = 2; taken.has(id); n++) id = `${role.id}_${n}`;
      return [...prev, { ...role, id }];
    });
  };

  const updateTenantRole = (roleId: string, permissions: Record<string, PermissionLevel> | string[]) => {
    setTenantRolesState(prev => prev.map(r => r.id === roleId ? { ...r, permissions } : r));
  };

  const requestSupervisorRefundAuth = (supervisorId: string, pin: string): boolean => {
    if (pin !== '1234') return false;
    const supervisorRole = tenantRolesState.find(r => r.id === supervisorId);
    if (!supervisorRole) return false;
    // The same refund-approval capability checkSubPermission('approve_refunds') decides: plan, the
    // Refunds parent-module minimum, and the explicit grant (exactly true). No level grants it.
    if (!decideSupervisorRefundApproval(decisionInput, supervisorId)) return false;
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
      isDevSession,
      isWriteBlocked,
      enablePreviewMode: () => setIsPreviewModeEnabled(true),
      disablePreviewMode: () => { setIsPreviewModeEnabled(false); setIsDevSession(false); setPosOperatorRole(null); setSupervisorRefundAuth(null); },
      disableWriteBlock: () => setIsPreviewModeEnabled(false),
      activateDevSession: () => setIsDevSession(true),
      deactivateDevSession: () => { setIsDevSession(false); setIsPreviewModeEnabled(false); setPosOperatorRole(null); setSupervisorRefundAuth(null); },
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
