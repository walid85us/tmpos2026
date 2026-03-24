import React from 'react';
import { createBrowserRouter, RouterProvider } from 'react-router-dom';
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
import TenantsPage from './owner/TenantsPage';
import TenantDetailPage from './owner/TenantDetailPage';
import DomainsPage from './owner/DomainsPage';
import SupportToolsPage from './owner/SupportToolsPage';
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
import PageShell from './components/PageShell';

import Login from './components/Login';
// ...
const router = createBrowserRouter([
  {
    path: '/login',
    element: <Login />,
  },
  {
    path: '/',
    element: <AccessGuard allowedUserTypes={['tenant']} redirectPath="/owner"><TenantLayout /></AccessGuard>,
    errorElement: <ErrorBoundary />,
    children: [
      { path: '/', element: <DashboardOverview onNewRepair={() => {}} /> },
      { path: '/sales', element: <AccessGuard feature="sales"><PageShell title="Sales"><POS /></PageShell></AccessGuard> },
      { path: '/sales/new', element: <AccessGuard feature="sales"><PageShell title="New Sale"><POS /></PageShell></AccessGuard> },
      { path: '/sales/scan', element: <AccessGuard feature="sales"><PageShell title="Scan QR"><div /></PageShell></AccessGuard> },
      { path: '/sales/quick-intake', element: <AccessGuard feature="sales"><PageShell title="Quick Intake"><div /></PageShell></AccessGuard> },
      { path: '/repairs', element: <AccessGuard feature="repairs"><RepairTickets /></AccessGuard> },
      { path: '/repairs/new', element: <AccessGuard feature="repairs"><PageShell title="New Repair"><div /></PageShell></AccessGuard> },
      { path: '/repairs/:id', element: <AccessGuard feature="repairs"><PageShell title="Repair Detail"><div /></PageShell></AccessGuard> },
      { path: '/inventory', element: <AccessGuard feature="inventory"><Inventory /></AccessGuard> },
      { path: '/inventory/new', element: <AccessGuard feature="inventory"><PageShell title="Add Product"><div /></PageShell></AccessGuard> },
      { path: '/inventory/categories', element: <AccessGuard feature="inventory"><PageShell title="Categories"><div /></PageShell></AccessGuard> },
      { path: '/customers', element: <AccessGuard feature="customers"><Customers /></AccessGuard> },
      { path: '/customers/new', element: <AccessGuard feature="customers"><PageShell title="New Customer"><div /></PageShell></AccessGuard> },
      { path: '/customers/:id', element: <AccessGuard feature="customers"><PageShell title="Customer Profile"><div /></PageShell></AccessGuard> },
      { path: '/employees', element: <AccessGuard feature="employees"><Employees /></AccessGuard> },
      { path: '/employees/new', element: <AccessGuard feature="employees"><PageShell title="Add Employee"><div /></PageShell></AccessGuard> },
      { path: '/employees/roles', element: <AccessGuard feature="employees"><PageShell title="Roles"><div /></PageShell></AccessGuard> },
      { path: '/employees/payroll', element: <AccessGuard feature="employees"><PageShell title="Payroll"><div /></PageShell></AccessGuard> },
      { path: '/invoices', element: <AccessGuard feature="invoices"><Invoices /></AccessGuard> },
      { path: '/invoices/new', element: <AccessGuard feature="invoices"><PageShell title="Create Invoice"><div /></PageShell></AccessGuard> },
      { path: '/services', element: <AccessGuard feature="services"><Services /></AccessGuard> },
      { path: '/services/new', element: <AccessGuard feature="services"><PageShell title="New Service"><div /></PageShell></AccessGuard> },
      { path: '/services/categories', element: <AccessGuard feature="services"><PageShell title="Service Categories"><div /></PageShell></AccessGuard> },
      { path: '/supply-chain', element: <AccessGuard feature="supply-chain"><SupplyChain /></AccessGuard> },
      { path: '/supply-chain/po/new', element: <AccessGuard feature="supply-chain"><PageShell title="Create PO"><div /></PageShell></AccessGuard> },
      { path: '/supply-chain/po/:id', element: <AccessGuard feature="supply-chain"><PageShell title="PO Detail"><div /></PageShell></AccessGuard> },
      { path: '/integrations', element: <AccessGuard feature="integrations"><PageShell title="Integrations"><div /></PageShell></AccessGuard> },
      { path: '/widgets', element: <AccessGuard feature="widgets"><PageShell title="Widgets"><div /></PageShell></AccessGuard> },
      { path: '/prospects', element: <AccessGuard feature="prospects"><PageShell title="Prospects"><div /></PageShell></AccessGuard> },
      { path: '/app-store', element: <AccessGuard feature="app-store"><PageShell title="App Store"><div /></PageShell></AccessGuard> },
      { path: '/mail-in', element: <AccessGuard feature="mail-in"><PageShell title="Mail-In"><div /></PageShell></AccessGuard> },
      { path: '/ledger', element: <AccessGuard feature="ledger"><PageShell title="Ledger"><div /></PageShell></AccessGuard> },
      { path: '/marketing', element: <AccessGuard feature="marketing"><PageShell title="Marketing"><div /></PageShell></AccessGuard> },
      { path: '/reports', element: <AccessGuard feature="reports"><PageShell title="Reports"><div /></PageShell></AccessGuard> },
      { path: '/settings', element: <AccessGuard feature="settings"><Settings /></AccessGuard> },
      { path: '/settings/configurations', element: <AccessGuard feature="settings"><PageShell title="Configurations"><div /></PageShell></AccessGuard> },
      { path: '/support', element: <AccessGuard feature="support"><Support /></AccessGuard> },
    ],
  },
  {
    path: '/owner',
    element: <AccessGuard allowedUserTypes={['platform']} redirectPath="/"><OwnerLayout /></AccessGuard>,
    errorElement: <ErrorBoundary />,
    children: [
      { path: '/owner', element: <DashboardPage /> },
      { path: '/owner/tenants', element: <AccessGuard feature="tenants"><TenantsPage /></AccessGuard> },
      { path: '/owner/tenants/:id', element: <AccessGuard feature="tenants"><TenantDetailPage /></AccessGuard> },
      { path: '/owner/plans', element: <AccessGuard feature="plans"><PlansPage /></AccessGuard> },
      { path: '/owner/feature-matrix', element: <AccessGuard feature="feature_matrix"><FeatureMatrixPage /></AccessGuard> },
      { path: '/owner/add-ons', element: <AccessGuard feature="add_ons"><AddOnsPage /></AccessGuard> },
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
]);

export default function App() {
  return (
    <AccessProvider>
      <RouterProvider router={router} />
    </AccessProvider>
  );
}
