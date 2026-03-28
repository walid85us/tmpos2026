import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAccess } from '../context/AccessContext';
import { Role } from '../context/accessConfig';

const storeScenarios = [
  {
    id: 'active',
    label: 'Active Store',
    tenant: {
      id: 'preview-tenant', name: 'Preview Store', plan: 'growth' as const, status: 'active' as const,
      onboardingStage: 'active' as const,
      onboardingChecklist: { profileComplete: true, paymentMethodAdded: true, firstProductAdded: true, domainConfigured: true, teamInvited: true, storeCustomized: true, storeSetupComplete: true },
      domainInfo: { mode: 'custom_active' as const, subdomain: 'preview-store.repairplatform.io', customDomain: 'previewstore.com', dnsVerified: true, sslProvisioned: true, propagated: true },
      activatedDate: '2026-02-15',
    }
  },
  {
    id: 'trial',
    label: 'Trial Store',
    tenant: {
      id: 'preview-tenant', name: 'Trial Store', plan: 'growth' as const, status: 'trialing' as const,
      onboardingStage: 'active' as const,
      onboardingChecklist: { profileComplete: true, paymentMethodAdded: false, firstProductAdded: true, domainConfigured: false, teamInvited: false, storeCustomized: true, storeSetupComplete: true },
      domainInfo: { mode: 'platform_subdomain' as const, subdomain: 'trial-store.repairplatform.io', dnsVerified: false, sslProvisioned: false, propagated: false },
      activatedDate: '2026-03-20',
      trialEndsDate: '2026-04-20',
    }
  },
  {
    id: 'invited',
    label: 'Invited',
    tenant: {
      id: 'preview-tenant', name: 'New Store', plan: 'starter' as const, status: 'pending_activation' as const,
      onboardingStage: 'invited' as const,
      onboardingChecklist: { profileComplete: false, paymentMethodAdded: false, firstProductAdded: false, domainConfigured: false, teamInvited: false, storeCustomized: false, storeSetupComplete: false },
      domainInfo: { mode: 'platform_subdomain' as const, subdomain: 'new-store.repairplatform.io', dnsVerified: false, sslProvisioned: false, propagated: false },
      inviteSentDate: '2026-03-25',
    }
  },
  {
    id: 'setup_incomplete',
    label: 'Setup Incomplete',
    tenant: {
      id: 'preview-tenant', name: 'Setting Up Store', plan: 'growth' as const, status: 'pending_activation' as const,
      onboardingStage: 'setup_incomplete' as const,
      onboardingChecklist: { profileComplete: true, paymentMethodAdded: false, firstProductAdded: false, domainConfigured: false, teamInvited: true, storeCustomized: false, storeSetupComplete: false },
      domainInfo: { mode: 'platform_subdomain' as const, subdomain: 'setting-up.repairplatform.io', dnsVerified: false, sslProvisioned: false, propagated: false },
      setupStartedDate: '2026-03-24',
    }
  },
  {
    id: 'domain_pending',
    label: 'Domain Pending',
    tenant: {
      id: 'preview-tenant', name: 'Domain Setup Store', plan: 'advanced' as const, status: 'active' as const,
      onboardingStage: 'active' as const,
      onboardingChecklist: { profileComplete: true, paymentMethodAdded: true, firstProductAdded: true, domainConfigured: true, teamInvited: true, storeCustomized: true, storeSetupComplete: true },
      domainInfo: { mode: 'custom_dns_pending' as const, subdomain: 'domain-setup.repairplatform.io', customDomain: 'mydomain.com', dnsVerified: false, sslProvisioned: false, propagated: false },
      activatedDate: '2026-03-10',
    }
  },
  {
    id: 'pending_activation',
    label: 'Pending Activation',
    tenant: {
      id: 'preview-tenant', name: 'Almost Ready Store', plan: 'growth' as const, status: 'pending_activation' as const,
      onboardingStage: 'pending_activation' as const,
      onboardingChecklist: { profileComplete: true, paymentMethodAdded: false, firstProductAdded: false, domainConfigured: false, teamInvited: true, storeCustomized: true, storeSetupComplete: true },
      domainInfo: { mode: 'platform_subdomain' as const, subdomain: 'almost-ready.repairplatform.io', dnsVerified: false, sslProvisioned: false, propagated: false },
      setupStartedDate: '2026-03-22',
    }
  },
  {
    id: 'read_only',
    label: 'Read Only',
    tenant: {
      id: 'preview-tenant', name: 'Read Only Store', plan: 'growth' as const, status: 'read_only' as const,
      onboardingStage: 'active' as const,
      onboardingChecklist: { profileComplete: true, paymentMethodAdded: true, firstProductAdded: true, domainConfigured: true, teamInvited: true, storeCustomized: true, storeSetupComplete: true },
      domainInfo: { mode: 'custom_active' as const, subdomain: 'readonly.repairplatform.io', customDomain: 'readonly-store.com', dnsVerified: true, sslProvisioned: true, propagated: true },
      activatedDate: '2026-01-15',
    }
  },
  {
    id: 'suspended',
    label: 'Suspended',
    tenant: {
      id: 'preview-tenant', name: 'Suspended Store', plan: 'growth' as const, status: 'suspended' as const,
      onboardingStage: 'active' as const,
      onboardingChecklist: { profileComplete: true, paymentMethodAdded: true, firstProductAdded: true, domainConfigured: true, teamInvited: true, storeCustomized: true, storeSetupComplete: true },
      domainInfo: { mode: 'custom_active' as const, subdomain: 'suspended.repairplatform.io', customDomain: 'suspended-store.com', dnsVerified: true, sslProvisioned: true, propagated: true },
      activatedDate: '2026-01-10',
    }
  },
  {
    id: 'overdue',
    label: 'Overdue',
    tenant: {
      id: 'preview-tenant', name: 'Overdue Store', plan: 'growth' as const, status: 'overdue' as const,
      onboardingStage: 'active' as const,
      onboardingChecklist: { profileComplete: true, paymentMethodAdded: true, firstProductAdded: true, domainConfigured: true, teamInvited: true, storeCustomized: true, storeSetupComplete: true },
      domainInfo: { mode: 'custom_active' as const, subdomain: 'overdue.repairplatform.io', customDomain: 'overdue-store.com', dnsVerified: true, sslProvisioned: true, propagated: true },
      activatedDate: '2026-02-01',
    }
  },
  {
    id: 'pending_setup',
    label: 'Pending Setup',
    tenant: {
      id: 'preview-tenant', name: 'New Setup Store', plan: 'starter' as const, status: 'pending_activation' as const,
      onboardingStage: 'pending_setup' as const,
      onboardingChecklist: { profileComplete: false, paymentMethodAdded: false, firstProductAdded: false, domainConfigured: false, teamInvited: false, storeCustomized: false, storeSetupComplete: false },
      domainInfo: { mode: 'platform_subdomain' as const, subdomain: 'new-setup.repairplatform.io', dnsVerified: false, sslProvisioned: false, propagated: false },
      inviteSentDate: '2026-03-20',
      setupStartedDate: '2026-03-24',
    }
  },
  {
    id: 'custom_pending',
    label: 'Domain Registering',
    tenant: {
      id: 'preview-tenant', name: 'Domain Register Store', plan: 'growth' as const, status: 'active' as const,
      onboardingStage: 'active' as const,
      onboardingChecklist: { profileComplete: true, paymentMethodAdded: true, firstProductAdded: true, domainConfigured: true, teamInvited: true, storeCustomized: true, storeSetupComplete: true },
      domainInfo: { mode: 'custom_pending' as const, subdomain: 'domain-register.repairplatform.io', customDomain: 'newdomain.com', dnsVerified: false, sslProvisioned: false, propagated: false },
      activatedDate: '2026-03-01',
    }
  },
  {
    id: 'ssl_pending',
    label: 'SSL Pending',
    tenant: {
      id: 'preview-tenant', name: 'SSL Setup Store', plan: 'advanced' as const, status: 'active' as const,
      onboardingStage: 'active' as const,
      onboardingChecklist: { profileComplete: true, paymentMethodAdded: true, firstProductAdded: true, domainConfigured: true, teamInvited: true, storeCustomized: true, storeSetupComplete: true },
      domainInfo: { mode: 'custom_ssl_pending' as const, subdomain: 'ssl-setup.repairplatform.io', customDomain: 'ssldomain.com', dnsVerified: true, sslProvisioned: false, propagated: true },
      activatedDate: '2026-02-20',
    }
  },
];

const DevSessionSwitcher: React.FC = () => {
  const navigate = useNavigate();
  const { 
    enablePreviewMode, 
    disablePreviewMode, 
    isPreviewModeEnabled, 
    setPreviewSession,
    setPreviewTenant,
    session,
    getAvailableRoles,
    resolveLandingRoute
  } = useAccess();

  const [showScenarios, setShowScenarios] = useState(false);
  const [activeScenario, setActiveScenario] = useState<string | null>(null);

  const { platform, tenant } = getAvailableRoles();

  const switchSession = (role: Role, userType: 'platform' | 'tenant', scenarioId?: string) => {
    enablePreviewMode();
    const newSession = {
      user: { id: 'dev-user', name: 'Dev User', email: 'dev@example.com' },
      userType: userType,
      role: role,
      status: 'active' as const,
    };
    setPreviewSession(newSession);
    
    if (userType === 'tenant') {
      const scenario = scenarioId
        ? storeScenarios.find(s => s.id === scenarioId)
        : storeScenarios[0];
      setPreviewTenant(scenario ? scenario.tenant : storeScenarios[0].tenant);
      setActiveScenario(scenario?.id || 'active');
    } else {
      setPreviewTenant(null);
      setActiveScenario(null);
    }
    
    const landingRoute = resolveLandingRoute(newSession);
    navigate(landingRoute);
  };

  const switchScenario = (scenarioId: string) => {
    const scenario = storeScenarios.find(s => s.id === scenarioId);
    if (!scenario) return;
    enablePreviewMode();
    setPreviewSession({
      user: { id: 'dev-user', name: 'Dev User', email: 'dev@example.com' },
      userType: 'tenant',
      role: 'store_owner',
      status: 'active',
    });
    setPreviewTenant(scenario.tenant);
    setActiveScenario(scenarioId);
    navigate('/');
  };

  return (
    <div className="fixed bottom-4 right-4 bg-white p-4 rounded-xl border border-slate-200 shadow-lg z-50 w-72 max-h-[80vh] overflow-y-auto">
      <div className="flex justify-between items-center mb-3">
        <h4 className="text-[10px] font-black text-slate-400 uppercase tracking-widest">
          Preview Mode: {isPreviewModeEnabled ? 'ON' : 'OFF'}
        </h4>
        {isPreviewModeEnabled && (
          <button 
            onClick={disablePreviewMode} 
            className="text-[10px] bg-slate-100 hover:bg-slate-200 px-2 py-1 rounded font-bold text-slate-700"
          >
            Exit Preview
          </button>
        )}
      </div>
      
      {isPreviewModeEnabled && session && (
        <div className="mb-3 text-[10px] text-slate-600 bg-slate-50 p-2 rounded border border-slate-100">
          Active Role: <span className="font-bold text-slate-900">{session.role}</span>
          {activeScenario && <span className="ml-1 text-violet-600">({activeScenario})</span>}
        </div>
      )}

      <div className="space-y-3">
        <div>
          <h5 className="text-[9px] font-bold text-slate-400 uppercase mb-1">Platform</h5>
          <div className="flex gap-2 flex-wrap">
            {platform.map(role => (
              <button key={role.id} onClick={() => switchSession(role.id as Role, 'platform')} className="px-2 py-1 bg-slate-100 hover:bg-slate-200 text-[10px] font-bold rounded-lg">{role.name}</button>
            ))}
          </div>
        </div>
        <div>
          <div className="flex items-center justify-between mb-1">
            <h5 className="text-[9px] font-bold text-slate-400 uppercase">Store</h5>
            <button onClick={() => setShowScenarios(!showScenarios)} className="text-[8px] font-bold text-violet-600 hover:text-violet-800">
              {showScenarios ? 'Hide Scenarios' : 'Test Scenarios'}
            </button>
          </div>
          <div className="flex gap-2 flex-wrap">
            {tenant.map(role => (
              <button key={role.id} onClick={() => switchSession(role.id as Role, 'tenant')} className="px-2 py-1 bg-slate-100 hover:bg-slate-200 text-[10px] font-bold rounded-lg">{role.name}</button>
            ))}
          </div>
        </div>
        {showScenarios && (
          <div className="border-t border-slate-100 pt-2">
            <h5 className="text-[9px] font-bold text-violet-500 uppercase mb-1.5">Store Owner Scenarios</h5>
            <div className="flex gap-1.5 flex-wrap">
              {storeScenarios.map(scenario => (
                <button
                  key={scenario.id}
                  onClick={() => switchScenario(scenario.id)}
                  className={`px-2 py-1 text-[9px] font-bold rounded-lg border transition-colors ${
                    activeScenario === scenario.id
                      ? 'bg-violet-100 border-violet-300 text-violet-800'
                      : 'bg-white border-slate-200 text-slate-600 hover:bg-violet-50 hover:border-violet-200'
                  }`}
                >
                  {scenario.label}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default DevSessionSwitcher;
