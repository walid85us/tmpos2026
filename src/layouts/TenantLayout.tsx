import React from 'react';
import { Outlet, Link, useLocation } from 'react-router-dom';
import TenantHeader from '../components/TenantHeader';
import AccountStatusBanner from '../components/AccountStatusBanner';
import DevSessionSwitcher from '../components/DevSessionSwitcher';
import { useAccess } from '../context/AccessContext';

const navItems = [
  { id: 'dashboard', label: 'Dashboard', icon: 'dashboard', path: '/' },
  { id: 'sales', label: 'Sales', icon: 'payments', path: '/sales' },
  { id: 'repairs', label: 'Repairs', icon: 'build', path: '/repairs' },
  { id: 'inventory', label: 'Inventory', icon: 'inventory_2', path: '/inventory' },
  { id: 'customers', label: 'Customers', icon: 'group', path: '/customers' },
  { id: 'employees', label: 'Employees', icon: 'badge', path: '/employees' },
  { id: 'invoices', label: 'Invoices', icon: 'receipt_long', path: '/invoices' },
  { id: 'services', label: 'Services', icon: 'settings_suggest', path: '/services' },
  { id: 'supply-chain', label: 'Supply Chain', icon: 'local_shipping', path: '/supply-chain' },
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
  const { loading, canAccess } = useAccess();

  if (loading) {
    return <div className="min-h-screen flex items-center justify-center">Loading...</div>;
  }

  const filteredNavItems = navItems.filter(item => canAccess(item.id));

  return (
    <div className="min-h-screen bg-surface flex">
      {/* Sidebar Navigation */}
      <aside className="bg-teal-950 font-sans antialiased tracking-tight h-screen w-64 fixed left-0 top-0 overflow-y-auto flex flex-col py-6 shadow-2xl z-50">
        <div className="px-6 mb-8">
          <h1 className="text-xl font-bold tracking-tighter text-white">Teal Metrics</h1>
          <p className="text-[10px] uppercase tracking-[0.2em] text-lime-400/70 font-bold mt-1">Main Branch</p>
        </div>
        
        <nav className="flex-1 px-2 space-y-1">
          {filteredNavItems.map((item) => (
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
        </nav>
      </aside>

      {/* Main Canvas */}
      <main className="ml-64 flex-1 min-h-screen flex flex-col">
        {/* Top Navigation */}
        <AccountStatusBanner />
        <TenantHeader />
        
        {/* View Content */}
        <div className="p-8 max-w-7xl mx-auto w-full">
          <Outlet />
        </div>
      </main>
      <DevSessionSwitcher />
    </div>
  );
}
