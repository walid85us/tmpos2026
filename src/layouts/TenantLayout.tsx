import React, { useEffect } from 'react';
import { Outlet, Link, useLocation, useNavigate } from 'react-router-dom';
import TenantHeader from '../components/TenantHeader';
import AccountStatusBanner from '../components/AccountStatusBanner';
import DevSessionSwitcher from '../components/DevSessionSwitcher';
import { useAccess, ONBOARDING_ALLOWED_MODULES } from '../context/AccessContext';
import { planFeatures } from '../context/accessConfig';
import { StoreLocalStateProvider } from '../context/StoreLocalState';

const navItems = [
  { id: 'dashboard', label: 'Dashboard', icon: 'dashboard', path: '/' },
  { id: 'sales', label: 'Sales', icon: 'payments', path: '/sales' },
  { id: 'repairs', label: 'Repairs', icon: 'build', path: '/repairs' },
  { id: 'inventory', label: 'Inventory', icon: 'inventory_2', path: '/inventory' },
  { id: 'customers', label: 'Customers', icon: 'group', path: '/customers' },
  { id: 'employees', label: 'Employees', icon: 'badge', path: '/employees' },
  { id: 'warranties', label: 'Warranties', icon: 'verified_user', path: '/warranties' },
  { id: 'invoices', label: 'Invoices', icon: 'receipt_long', path: '/invoices' },
  { id: 'services', label: 'Services', icon: 'settings_suggest', path: '/services' },
  { id: 'supply-chain', label: 'Supply Chain', icon: 'local_shipping', path: '/supply-chain' },
  { id: 'shipping', label: 'Shipping', icon: 'package_2', path: '/shipping' },
  { id: 'prospects', label: 'Prospects', icon: 'contact_mail', path: '/prospects' },
  { id: 'marketing', label: 'Marketing', icon: 'campaign', path: '/marketing' },
  { id: 'reports', label: 'Reports', icon: 'bar_chart', path: '/reports' },
  { id: 'integrations', label: 'Integrations', icon: 'extension', path: '/integrations' },
  { id: 'widgets', label: 'Widgets', icon: 'widgets', path: '/widgets' },
  { id: 'settings', label: 'Settings', icon: 'settings', path: '/settings' },
  { id: 'support', label: 'Support', icon: 'help', path: '/support' },
];

export default function TenantLayout() {
  const location = useLocation();
  const navigate = useNavigate();
  const { loading, canAccess, isStoreActivated, session, tenant } = useAccess();

  const activated = isStoreActivated();
  const isTenantUser = session?.userType === 'tenant';

  useEffect(() => {
    if (loading || !isTenantUser) return;
    if (activated) return;

    const currentPath = location.pathname;
    const currentNavItem = navItems.find(item => currentPath === item.path || (item.path !== '/' && currentPath.startsWith(item.path)));
    if (currentNavItem && !ONBOARDING_ALLOWED_MODULES.includes(currentNavItem.id)) {
      navigate('/', { replace: true });
    }
  }, [loading, activated, isTenantUser, location.pathname, navigate]);

  if (loading) {
    return <div className="min-h-screen flex items-center justify-center">Loading...</div>;
  }

  const showLockedItems = isTenantUser && !activated;

  const accessibleItems = navItems.filter(item => canAccess(item.id));

  const lockedItems = showLockedItems
    ? navItems.filter(item =>
        !canAccess(item.id) && !ONBOARDING_ALLOWED_MODULES.includes(item.id) && tenant && (planFeatures[tenant.plan] || []).includes(item.id)
      )
    : [];

  return (
    <div className="min-h-screen bg-surface flex">
      <aside className="bg-teal-950 font-sans antialiased tracking-tight h-screen w-64 fixed left-0 top-0 overflow-y-auto flex flex-col py-6 shadow-2xl z-50">
        <div className="px-6 mb-8">
          <h1 className="text-xl font-bold tracking-tighter text-white">Teal Metrics</h1>
          <p className="text-[10px] uppercase tracking-[0.2em] text-lime-400/70 font-bold mt-1">Main Branch</p>
        </div>

        <nav className="flex-1 px-2 space-y-1">
          {accessibleItems.map((item) => (
            <Link
              key={item.id}
              to={item.path}
              className={`w-full flex items-center gap-3 px-4 py-3 rounded-lg transition-all ${
                location.pathname === item.path
                  ? 'bg-teal-900/50 text-lime-400 border-r-4 border-lime-400 font-semibold'
                  : 'text-teal-100/70 hover:text-white hover:bg-teal-900/30'
              }`}
            >
              <span className="material-symbols-outlined text-xl">{item.icon}</span>
              <span className="text-sm">{item.label}</span>
            </Link>
          ))}

          {lockedItems.length > 0 && (
            <>
              <div className="pt-4 pb-2 px-4">
                <div className="flex items-center gap-2">
                  <div className="h-px flex-1 bg-teal-800/50" />
                  <span className="text-[8px] font-black uppercase tracking-widest text-teal-600">After Activation</span>
                  <div className="h-px flex-1 bg-teal-800/50" />
                </div>
              </div>
              {lockedItems.map((item) => (
                <div
                  key={item.id}
                  className="w-full flex items-center gap-3 px-4 py-3 rounded-lg text-teal-700/40 cursor-not-allowed select-none"
                  title="Complete activation to unlock"
                >
                  <span className="material-symbols-outlined text-xl">{item.icon}</span>
                  <span className="text-sm flex-1">{item.label}</span>
                  <span className="material-symbols-outlined text-xs">lock</span>
                </div>
              ))}
            </>
          )}
        </nav>
      </aside>

      <main className="ml-64 flex-1 min-h-screen flex flex-col">
        <AccountStatusBanner />
        <TenantHeader />
        <div className="p-8 max-w-7xl mx-auto w-full">
          <StoreLocalStateProvider>
            <Outlet />
          </StoreLocalStateProvider>
        </div>
      </main>
      {import.meta.env.DEV && <DevSessionSwitcher />}
    </div>
  );
}
