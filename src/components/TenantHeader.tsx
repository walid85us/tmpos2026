import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAccess } from '../context/AccessContext';
import { accountStatusConfig } from '../context/accessConfig';

const TenantHeader: React.FC = () => {
  const { tenant, session, loading } = useAccess();
  const navigate = useNavigate();
  const [checkedIn, setCheckedIn] = useState(false);
  const [showQuickMenu, setShowQuickMenu] = useState(false);
  const [showNotifications, setShowNotifications] = useState(false);

  const notifications = [
    { id: 1, text: 'Repair #1042 is ready for pickup', time: '5 min ago', icon: 'build', unread: true },
    { id: 2, text: 'Low stock alert: iPhone 13 Screens', time: '1 hr ago', icon: 'inventory_2', unread: true },
    { id: 3, text: 'New customer registration', time: '2 hrs ago', icon: 'person_add', unread: false },
  ];

  const quickActions = [
    { label: 'New Sale', icon: 'shopping_cart', path: '/sales' },
    { label: 'New Repair', icon: 'build', path: '/repairs' },
    { label: 'Add Customer', icon: 'person_add', path: '/customers' },
    { label: 'Inventory', icon: 'inventory_2', path: '/inventory' },
    { label: 'Reports', icon: 'bar_chart', path: '/reports' },
    { label: 'Settings', icon: 'settings', path: '/settings' },
  ];

  const unreadCount = notifications.filter(n => n.unread).length;

  if (loading || !tenant) return <div className="h-20 bg-white border-b border-slate-200" />;

  const status = accountStatusConfig[tenant.status];
  const userName = session?.user?.name || 'User';
  const userInitials = userName.split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2);

  const handleCheckIn = () => {
    setCheckedIn(!checkedIn);
  };

  return (
    <>
      <div className="bg-white border-b border-slate-200 px-8 py-4 flex justify-between items-center">
        <div>
          <h1 className="text-xl font-black text-primary">{tenant.name}</h1>
          <div className="flex gap-2 mt-1">
            <span className="px-2 py-0.5 bg-indigo-100 text-indigo-700 text-[10px] font-black uppercase tracking-widest rounded-lg border border-indigo-200">{tenant.plan.toUpperCase()}</span>
            <span className={`px-2 py-0.5 ${status.color} text-[10px] font-black uppercase tracking-widest rounded-lg border`}>{status.label}</span>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <button
            onClick={handleCheckIn}
            className={`flex items-center gap-2 px-5 py-2.5 rounded-2xl font-black text-xs uppercase tracking-widest transition-all shadow-sm ${
              checkedIn
                ? 'bg-rose-500 text-white shadow-rose-500/20 hover:bg-rose-600'
                : 'bg-emerald-500 text-white shadow-emerald-500/20 hover:bg-emerald-600'
            }`}
          >
            <span className="material-symbols-outlined text-sm">{checkedIn ? 'logout' : 'login'}</span>
            {checkedIn ? 'Clock Out' : 'Check In'}
          </button>

          <div className="relative">
            <button
              onClick={() => { setShowNotifications(!showNotifications); setShowQuickMenu(false); }}
              className="relative p-2.5 bg-slate-100 rounded-xl hover:bg-slate-200 transition-colors"
            >
              <span className="material-symbols-outlined text-slate-600 text-xl">notifications</span>
              {unreadCount > 0 && (
                <span className="absolute -top-1 -right-1 w-5 h-5 bg-rose-500 text-white text-[9px] font-black flex items-center justify-center rounded-full border-2 border-white">
                  {unreadCount}
                </span>
              )}
            </button>

            {showNotifications && (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setShowNotifications(false)} />
                <div className="absolute right-0 top-full mt-2 w-80 bg-white rounded-2xl shadow-2xl border border-slate-200 z-50 overflow-hidden">
                  <div className="p-4 border-b border-slate-100 flex justify-between items-center">
                    <h4 className="text-xs font-black text-slate-900 uppercase tracking-widest">Notifications</h4>
                    <span className="text-[10px] font-bold text-primary cursor-pointer hover:underline">Mark all read</span>
                  </div>
                  <div className="max-h-64 overflow-y-auto">
                    {notifications.map(n => (
                      <div key={n.id} className={`flex items-start gap-3 p-4 hover:bg-slate-50 transition-colors cursor-pointer ${n.unread ? 'bg-primary/[0.02]' : ''}`}>
                        <div className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 ${n.unread ? 'bg-primary/10 text-primary' : 'bg-slate-100 text-slate-400'}`}>
                          <span className="material-symbols-outlined text-sm">{n.icon}</span>
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className={`text-xs ${n.unread ? 'font-bold text-slate-900' : 'font-medium text-slate-500'}`}>{n.text}</p>
                          <p className="text-[10px] text-slate-400 mt-0.5">{n.time}</p>
                        </div>
                        {n.unread && <div className="w-2 h-2 bg-primary rounded-full shrink-0 mt-1.5" />}
                      </div>
                    ))}
                  </div>
                </div>
              </>
            )}
          </div>

          <div className="relative">
            <button
              onClick={() => { setShowQuickMenu(!showQuickMenu); setShowNotifications(false); }}
              className="p-2.5 bg-slate-100 rounded-xl hover:bg-slate-200 transition-colors"
            >
              <span className="material-symbols-outlined text-slate-600 text-xl">apps</span>
            </button>

            {showQuickMenu && (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setShowQuickMenu(false)} />
                <div className="absolute right-0 top-full mt-2 w-64 bg-white rounded-2xl shadow-2xl border border-slate-200 z-50 overflow-hidden p-4">
                  <h4 className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-3 ml-1">Quick Actions</h4>
                  <div className="grid grid-cols-3 gap-2">
                    {quickActions.map(action => (
                      <button
                        key={action.label}
                        onClick={() => { setShowQuickMenu(false); navigate(action.path); }}
                        className="flex flex-col items-center gap-1.5 p-3 rounded-xl hover:bg-slate-50 transition-colors group"
                      >
                        <div className="w-10 h-10 bg-slate-100 rounded-xl flex items-center justify-center group-hover:bg-primary group-hover:text-white text-slate-600 transition-all">
                          <span className="material-symbols-outlined text-lg">{action.icon}</span>
                        </div>
                        <span className="text-[9px] font-bold text-slate-500 uppercase tracking-wider text-center leading-tight">{action.label}</span>
                      </button>
                    ))}
                  </div>
                </div>
              </>
            )}
          </div>

          <div className="w-px h-8 bg-slate-200 mx-1" />

          <button className="flex items-center gap-3 pl-2 pr-4 py-1.5 rounded-2xl hover:bg-slate-50 transition-colors">
            <div className="w-9 h-9 bg-primary rounded-xl flex items-center justify-center text-white text-xs font-black shadow-sm">
              {userInitials}
            </div>
            <div className="text-left hidden lg:block">
              <p className="text-xs font-bold text-slate-900 leading-none">{userName}</p>
              <p className="text-[10px] font-medium text-slate-400 capitalize">{session?.role?.replace('_', ' ')}</p>
            </div>
          </button>
        </div>
      </div>
    </>
  );
};

export default TenantHeader;
