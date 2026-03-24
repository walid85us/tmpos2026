import React from 'react';
import { Outlet, Link, useLocation } from 'react-router-dom';
import DevSessionSwitcher from '../components/DevSessionSwitcher';
import { useAccess } from '../context/AccessContext';

const navItems = [
  { label: 'Overview', path: '/owner', feature: 'dashboard' },
  { label: 'Tenants', path: '/owner/tenants', feature: 'tenants' },
  { label: 'Team Management', path: '/owner/team-management', feature: 'team_management' },
  { label: 'Plans', path: '/owner/plans', feature: 'plans' },
  { label: 'Feature Matrix', path: '/owner/feature-matrix', feature: 'feature_matrix' },
  { label: 'Add-ons', path: '/owner/add-ons', feature: 'add_ons' },
  { label: 'Subscriptions', path: '/owner/subscriptions', feature: 'subscriptions' },
  { label: 'Billing', path: '/owner/billing', feature: 'billing' },
  { label: 'Provisioning', path: '/owner/provisioning', feature: 'provisioning' },
  { label: 'Domains', path: '/owner/domains', feature: 'domains' },
  { label: 'Usage', path: '/owner/usage', feature: 'usage' },
  { label: 'Support Tools', path: '/owner/support-tools', feature: 'support_tools' },
  { label: 'Platform Settings', path: '/owner/platform-settings', feature: 'platform_settings' },
  { label: 'Audit & Security', path: '/owner/audit-security', feature: 'audit_security' },
];

export default function OwnerLayout() {
  const location = useLocation();
  const { canAccess } = useAccess();

  const filteredNavItems = navItems.filter(item => item.feature === 'dashboard' || canAccess(item.feature));

  return (
    <div className="min-h-screen bg-surface flex">
      {/* Owner Sidebar */}
      <aside className="bg-teal-950 font-sans antialiased tracking-tight h-screen w-64 fixed left-0 top-0 overflow-y-auto flex flex-col py-6 shadow-2xl z-50">
        <div className="px-6 mb-8">
          <h1 className="text-xl font-bold tracking-tighter text-white">Platform Owner</h1>
          <p className="text-[10px] uppercase tracking-[0.2em] text-lime-400/70 font-bold mt-1">Control Panel</p>
        </div>
        
        <nav className="flex-1 px-2 space-y-1">
          <div className="text-teal-100/70 px-4 py-2 text-xs font-bold uppercase tracking-widest">Platform</div>
          {filteredNavItems.map(item => (
            <Link 
              key={item.path} 
              to={item.path}
              className={`w-full flex items-center gap-3 px-4 py-3 rounded-lg transition-all ${
                location.pathname === item.path 
                  ? 'bg-teal-900/50 text-lime-400 border-r-4 border-lime-400 font-semibold' 
                  : 'text-teal-100/70 hover:text-white hover:bg-teal-900/30'
              }`}
            >
              <span className="text-sm">{item.label}</span>
            </Link>
          ))}
        </nav>
      </aside>

      {/* Main Canvas */}
      <main className="ml-64 flex-1 min-h-screen flex flex-col">
        <header className="sticky top-0 w-full z-40 bg-white/80 backdrop-blur-md flex items-center justify-between px-8 py-3 border-b border-teal-900/10">
          <h2 className="text-lg font-bold text-primary">Owner Panel</h2>
        </header>

        <div className="p-8 max-w-7xl mx-auto w-full">
          <Outlet />
        </div>
      </main>
      <DevSessionSwitcher />
    </div>
  );
}
