import React from 'react';
import { createBrowserRouter, RouterProvider, Navigate } from 'react-router-dom';
import { AccessProvider } from './context/AccessContext';
import AccessGuard from './components/AccessGuard';
import DevSessionSwitcher from './components/DevSessionSwitcher';
import TenantLayout from './layouts/TenantLayout';
import OwnerLayout from './layouts/OwnerLayout';
import ErrorBoundary from './components/ErrorBoundary';
import DashboardOverview from './components/DashboardOverview';
import POS from './components/POS';
import RepairTickets from './components/RepairTickets';
import Inventory from './components/Inventory';
import Customers from './components/Customers';
import Employees from './components/Employees';
import EmployeesInvitePage from './tenant/EmployeesInvitePage';
import EmployeesRolesPage from './tenant/EmployeesRolesPage';
import EmployeesPermissionsPage from './tenant/EmployeesPermissionsPage';
import SettingsUsersAccessPage from './tenant/SettingsUsersAccessPage';
import Invoices from './components/Invoices';
import Services from './components/Services';
import SupplyChain from './components/SupplyChain';
import Settings from './components/Settings';
import Support from './components/Support';
import Reports from './components/Reports';
import Prospects from './components/Prospects';
import Marketing from './components/Marketing';
import Integrations from './components/Integrations';
import Widgets from './components/Widgets';
import TenantsPage from './owner/TenantsPage';
import TenantDetailPage from './owner/TenantDetailPage';
import DomainsPage from './owner/DomainsPage';
import SupportToolsPage from './owner/SupportToolsPage';
import CommandCenterPage from './owner/CommandCenterPage';
import PlatformSettingsPage from './owner/PlatformSettingsPage';
import AuditSecurityPage from './owner/AuditSecurityPage';
import RolesPage from './owner/RolesPage';
import PermissionsPage from './owner/PermissionsPage';
import TeamManagementPage from './owner/TeamManagementPage';
import DashboardPage from './owner/DashboardPage';
import PlansPage from './owner/PlansPage';
import FeatureMatrixPage from './owner/FeatureMatrixPage';
import AddOnsPage from './owner/AddOnsPage';
import SubscriptionsPage from './owner/SubscriptionsPage';
import BillingPage from './owner/BillingPage';
import UsagePage from './owner/UsagePage';
import ProvisioningPage from './owner/ProvisioningPage';
import WarrantyManagement from './components/WarrantyManagement';
import ShippingCenter from './components/ShippingCenter';
import ShippingProvidersPage from './components/ShippingProvidersPage';
import ReturnsPortal from './components/ReturnsPortal';
import PageShell from './components/PageShell';

import Login from './components/Login';
import NotProvisioned from './components/NotProvisioned';

// Phase 1.5 M4 — dev-only Supabase Auth pilot. Lazy-loaded and registered ONLY
// when PILOT_ROUTE_ENABLED (Vite DEV build + explicit VITE_ENABLE_SUPABASE_PILOT
// opt-in). It lives OUTSIDE the guarded '/' and '/owner' trees, is NOT wrapped by
// AccessGuard, and does not affect any existing route.
import { PILOT_ROUTE_ENABLED } from './pilot/pilotEnv';
const SupabaseAuthPilot = React.lazy(() => import('./pilot/SupabaseAuthPilot'));
// ...
const router = createBrowserRouter([
  {
    path: '/login',
    element: <Login />,
  },
  {
    path: '/not-provisioned',
    element: <NotProvisioned />,
  },
  {
    path: '/',
    element: <AccessGuard allowedUserTypes={['tenant']} redirectPath="/owner"><TenantLayout /></AccessGuard>,
    errorElement: <ErrorBoundary />,
    children: [
      { path: '/', element: <DashboardOverview onNewRepair={() => {}} /> },
      { path: '/sales', element: <AccessGuard feature="sales"><POS /></AccessGuard> },
      { path: '/sales/new', element: <AccessGuard feature="sales"><POS /></AccessGuard> },
      { path: '/sales/scan', element: <Navigate to="/sales" replace /> },
      { path: '/sales/quick-intake', element: <Navigate to="/sales" replace /> },
      { path: '/repairs', element: <AccessGuard feature="repairs"><RepairTickets /></AccessGuard> },
      { path: '/repairs/new', element: <Navigate to="/repairs" replace /> },
      { path: '/repairs/:id', element: <Navigate to="/repairs" replace /> },
      { path: '/inventory', element: <AccessGuard feature="inventory"><Inventory /></AccessGuard> },
      { path: '/inventory/new', element: <Navigate to="/inventory" replace /> },
      { path: '/inventory/categories', element: <Navigate to="/inventory" replace /> },
      { path: '/customers', element: <AccessGuard feature="customers"><Customers /></AccessGuard> },
      { path: '/customers/new', element: <Navigate to="/customers" replace /> },
      { path: '/customers/:id', element: <Navigate to="/customers" replace /> },
      { path: '/employees', element: <AccessGuard feature="employees"><Employees /></AccessGuard> },
      { path: '/employees/new', element: <Navigate to="/employees" replace /> },
      { path: '/employees/roles', element: <Navigate to="/employees" replace /> },
      { path: '/employees/payroll', element: <Navigate to="/employees" replace /> },
      { path: '/warranties', element: <AccessGuard feature="warranties"><WarrantyManagement /></AccessGuard> },
      { path: '/invoices', element: <AccessGuard feature="invoices"><Invoices /></AccessGuard> },
      { path: '/invoices/new', element: <Navigate to="/invoices" replace /> },
      { path: '/services', element: <AccessGuard feature="services"><Services /></AccessGuard> },
      { path: '/services/new', element: <Navigate to="/services" replace /> },
      { path: '/services/categories', element: <Navigate to="/services" replace /> },
      { path: '/supply-chain', element: <AccessGuard feature="supply-chain"><SupplyChain /></AccessGuard> },
      { path: '/supply-chain/po/new', element: <Navigate to="/supply-chain" replace /> },
      { path: '/supply-chain/po/:id', element: <Navigate to="/supply-chain" replace /> },
      { path: '/shipping', element: <AccessGuard feature="shipping"><ShippingCenter /></AccessGuard> },
      { path: '/shipping/settings', element: <AccessGuard feature="shipping"><ShippingProvidersPage /></AccessGuard> },
      { path: '/returns', element: <AccessGuard feature="returns"><ReturnsPortal /></AccessGuard> },
      { path: '/integrations', element: <AccessGuard feature="integrations"><Integrations /></AccessGuard> },
      { path: '/widgets', element: <AccessGuard feature="widgets"><Widgets /></AccessGuard> },
      { path: '/prospects', element: <AccessGuard feature="prospects"><Prospects /></AccessGuard> },
      { path: '/app-store', element: <AccessGuard feature="app-store"><PageShell title="App Store"><div className="bg-white/80 backdrop-blur-xl p-12 rounded-[3rem] border border-slate-200 flex flex-col items-center justify-center text-center"><div className="w-20 h-20 bg-primary/5 rounded-full flex items-center justify-center mb-6"><span className="material-symbols-outlined text-4xl text-primary">store</span></div><h3 className="text-xl font-black text-primary mb-2">App Store</h3><p className="text-sm text-slate-500 max-w-md">Browse and install third-party integrations, plugins, and extensions to enhance your store operations.</p><span className="mt-4 px-4 py-1.5 bg-amber-50 text-amber-700 text-[10px] font-black uppercase tracking-widest rounded-lg border border-amber-200">Coming Soon</span></div></PageShell></AccessGuard> },
      { path: '/mail-in', element: <AccessGuard feature="mail-in"><PageShell title="Mail-In Repairs"><div className="bg-white/80 backdrop-blur-xl p-12 rounded-[3rem] border border-slate-200 flex flex-col items-center justify-center text-center"><div className="w-20 h-20 bg-primary/5 rounded-full flex items-center justify-center mb-6"><span className="material-symbols-outlined text-4xl text-primary">local_shipping</span></div><h3 className="text-xl font-black text-primary mb-2">Mail-In Repairs</h3><p className="text-sm text-slate-500 max-w-md">Accept repair devices via mail, track shipping, and manage remote customer repair workflows.</p><span className="mt-4 px-4 py-1.5 bg-amber-50 text-amber-700 text-[10px] font-black uppercase tracking-widest rounded-lg border border-amber-200">Coming Soon</span></div></PageShell></AccessGuard> },
      { path: '/ledger', element: <AccessGuard feature="ledger"><PageShell title="General Ledger"><div className="bg-white/80 backdrop-blur-xl p-12 rounded-[3rem] border border-slate-200 flex flex-col items-center justify-center text-center"><div className="w-20 h-20 bg-primary/5 rounded-full flex items-center justify-center mb-6"><span className="material-symbols-outlined text-4xl text-primary">account_balance</span></div><h3 className="text-xl font-black text-primary mb-2">General Ledger</h3><p className="text-sm text-slate-500 max-w-md">Full double-entry bookkeeping, chart of accounts, journal entries, and financial statements.</p><span className="mt-4 px-4 py-1.5 bg-amber-50 text-amber-700 text-[10px] font-black uppercase tracking-widest rounded-lg border border-amber-200">Coming Soon</span></div></PageShell></AccessGuard> },
      { path: '/marketing', element: <AccessGuard feature="marketing"><Marketing /></AccessGuard> },
      { path: '/reports', element: <AccessGuard feature="reports"><Reports /></AccessGuard> },
      { path: '/settings', element: <AccessGuard feature="settings"><Settings /></AccessGuard> },
      { path: '/settings/configurations', element: <Navigate to="/settings" replace /> },
      { path: '/settings/shipping-providers', element: <Navigate to="/shipping/settings" replace /> },
      { path: '/support', element: <AccessGuard feature="support"><Support /></AccessGuard> },
    ],
  },
  {
    path: '/owner',
    element: <AccessGuard allowedUserTypes={['platform']} redirectPath="/"><OwnerLayout /></AccessGuard>,
    errorElement: <ErrorBoundary />,
    children: [
      { path: '/owner', element: <DashboardPage /> },
      { path: '/owner/command-center', element: <AccessGuard feature="command_center"><CommandCenterPage /></AccessGuard> },
      { path: '/owner/tenants', element: <AccessGuard feature="tenants"><TenantsPage /></AccessGuard> },
      { path: '/owner/tenants/:id', element: <AccessGuard feature="tenants"><TenantDetailPage /></AccessGuard> },
      { path: '/owner/plans', element: <AccessGuard feature="plans"><PlansPage /></AccessGuard> },
      { path: '/owner/feature-matrix', element: <AccessGuard feature="plans"><FeatureMatrixPage /></AccessGuard> },
      { path: '/owner/add-ons', element: <AccessGuard feature="plans"><AddOnsPage /></AccessGuard> },
      { path: '/owner/subscriptions', element: <AccessGuard feature="subscriptions"><SubscriptionsPage /></AccessGuard> },
      { path: '/owner/billing', element: <AccessGuard feature="billing"><BillingPage /></AccessGuard> },
      { path: '/owner/provisioning', element: <AccessGuard feature="provisioning"><ProvisioningPage /></AccessGuard> },
      { path: '/owner/domains', element: <AccessGuard feature="domains"><DomainsPage /></AccessGuard> },
      { path: '/owner/usage', element: <AccessGuard feature="usage"><UsagePage /></AccessGuard> },
      { path: '/owner/support-tools', element: <AccessGuard feature="support_tools"><SupportToolsPage /></AccessGuard> },
      { path: '/owner/platform-settings', element: <AccessGuard feature="platform_settings"><PlatformSettingsPage /></AccessGuard> },
      { path: '/owner/audit-security', element: <AccessGuard feature="audit_security"><AuditSecurityPage /></AccessGuard> },
      { path: '/owner/team-management', element: <AccessGuard feature="team_management"><TeamManagementPage /></AccessGuard> },
    ],
  },
  // Phase 1.5 M4 — additive, dev-only pilot route (default OFF). Excluded entirely
  // unless Vite DEV + VITE_ENABLE_SUPABASE_PILOT === 'true'.
  ...(PILOT_ROUTE_ENABLED
    ? [{
        path: '/dev/supabase-pilot',
        element: (
          <React.Suspense fallback={<div className="min-h-screen flex items-center justify-center text-slate-500">Loading Supabase pilot…</div>}>
            <SupabaseAuthPilot />
          </React.Suspense>
        ),
      }]
    : []),
]);

export default function App() {
  return (
    <AccessProvider>
      <RouterProvider router={router} />
    </AccessProvider>
  );
}
