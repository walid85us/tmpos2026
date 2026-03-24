import React from 'react';
import { useNavigate } from 'react-router-dom';
import { useAccess } from '../context/AccessContext';
import { Role } from '../context/accessConfig';

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

  const { platform, tenant } = getAvailableRoles();

  const switchSession = (role: Role, userType: 'platform' | 'tenant') => {
    enablePreviewMode();
    const newSession = {
      user: { id: 'dev-user', name: 'Dev User', email: 'dev@example.com' },
      userType: userType,
      role: role,
      status: 'active' as const,
    };
    setPreviewSession(newSession);
    
    // Also set a mock tenant for preview mode so tenant features work
    if (userType === 'tenant') {
      setPreviewTenant({ id: 'preview-tenant', name: 'Preview Store', plan: 'growth', status: 'active' });
    } else {
      setPreviewTenant(null);
    }
    
    // Resolve and navigate to the landing route
    const landingRoute = resolveLandingRoute(newSession);
    navigate(landingRoute);
  };

  return (
    <div className="fixed bottom-4 right-4 bg-white p-4 rounded-xl border border-slate-200 shadow-lg z-50 w-72">
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
          <h5 className="text-[9px] font-bold text-slate-400 uppercase mb-1">Store</h5>
          <div className="flex gap-2 flex-wrap">
            {tenant.map(role => (
              <button key={role.id} onClick={() => switchSession(role.id as Role, 'tenant')} className="px-2 py-1 bg-slate-100 hover:bg-slate-200 text-[10px] font-bold rounded-lg">{role.name}</button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
};

export default DevSessionSwitcher;
