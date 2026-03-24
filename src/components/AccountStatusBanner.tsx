import React from 'react';
import { useAccess } from '../context/AccessContext';
import { accountStatusConfig } from '../context/accessConfig';

const AccountStatusBanner: React.FC = () => {
  const { tenant, loading } = useAccess();

  if (loading || !tenant) return null;

  const getMessage = (status: string) => {
    switch (status) {
      case 'active': return 'All systems operational.';
      case 'trialing': return 'You are currently on a trial plan. Upgrade to unlock all features.';
      case 'overdue': return 'Your account is overdue. Please update your billing information.';
      case 'suspended': return 'Your account has been suspended. Please contact support.';
      case 'read_only': return 'Your account is in read-only mode. Please update your billing information.';
      case 'pending_activation': return 'Your account is pending activation. Please check your email.';
      default: return 'Please contact support.';
    }
  };

  return (
    <div className={`px-8 py-3 ${accountStatusConfig[tenant.status].color} border-b border-slate-200 text-xs font-black uppercase tracking-widest text-center`}>
      Account Status: {accountStatusConfig[tenant.status].label}. {getMessage(tenant.status)}
    </div>
  );
};

export default AccountStatusBanner;
