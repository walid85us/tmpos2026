import React, { useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import PageShell from '../components/PageShell';
import { useAccess } from '../context/AccessContext';

export default function TeamManagementPage() {
  const { session, platformRolesState = [], addPlatformRole, updatePlatformRole } = useAccess();
  const [activeTab, setActiveTab] = useState<'team' | 'roles' | 'permissions' | 'activity'>('team');
  const [searchQuery, setSearchQuery] = useState('');
  const [showAddModal, setShowAddModal] = useState(false);
  const [showCreateRoleModal, setShowCreateRoleModal] = useState(false);
  const [editingMember, setEditingMember] = useState<{ id: string, name: string, email: string, role: string } | null>(null);

  const [newRole, setNewRole] = useState({ name: '', description: '', status: 'active' as string, permissions: [] as string[] });

  const [team, setTeam] = useState([
    { id: 'u1', name: 'Admin User', email: 'admin@platform.com', role: 'System Owner', status: 'Active' },
    { id: 'u2', name: 'Support Rep', email: 'support@platform.com', role: 'Support Admin', status: 'Active' },
  ]);

  const [activityLogs, setActivityLogs] = useState([
    { id: 'a1', user: 'Admin User', action: 'Created Role', details: 'Added new Billing Admin role', time: '2024-03-20 10:00' },
    { id: 'a2', user: 'Support Rep', action: 'Reset Password', details: 'Reset password for store tenant-1', time: '2024-03-20 11:30' },
  ]);

  const platformFeatures = [
    { id: 'tenants', name: 'Manage Tenants' },
    { id: 'billing', name: 'Billing & Subscriptions' },
    { id: 'platform_settings', name: 'Platform Settings' },
    { id: 'audit_security', name: 'Audit Logs' },
    { id: 'support_tools', name: 'Support Tools' },
    { id: 'team_management', name: 'Team Management' },
    { id: 'provisioning', name: 'Provisioning' },
    { id: 'domains', name: 'Domains' },
    { id: 'feature_matrix', name: 'Feature Matrix' },
  ];

  const logActivity = (action: string, details: string) => {
    setActivityLogs(prev => [{
      id: `a${Date.now()}`,
      user: session?.user?.name || 'Unknown',
      action,
      details,
      time: new Date().toLocaleString()
    }, ...prev]);
  };

  const handleCreateRole = () => {
    if (!newRole.name.trim()) return;
    const roleId = newRole.name.toLowerCase().replace(/\s+/g, '_');
    addPlatformRole({
      id: roleId,
      name: newRole.name,
      permissions: newRole.permissions,
      description: newRole.description || 'Custom platform role'
    });
    logActivity('Created Role', `Created new platform role: ${newRole.name} with permissions: ${newRole.permissions.length > 0 ? newRole.permissions.join(', ') : 'none assigned'}`);
    setNewRole({ name: '', description: '', status: 'active', permissions: [] });
    setShowCreateRoleModal(false);
  };

  const togglePermission = (permId: string) => {
    setNewRole(prev => ({
      ...prev,
      permissions: prev.permissions.includes(permId)
        ? prev.permissions.filter(p => p !== permId)
        : [...prev.permissions, permId]
    }));
  };

  const renderTeam = () => (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <div className="relative">
          <span className="material-symbols-outlined absolute left-4 top-1/2 -translate-y-1/2 text-slate-400 text-sm">search</span>
          <input 
            type="text" 
            placeholder="Search team members..."
            className="pl-11 pr-6 py-3 bg-white/80 backdrop-blur-xl rounded-2xl border border-slate-200 focus:outline-none focus:ring-2 focus:ring-primary/20 text-sm font-bold text-slate-900 w-64 shadow-sm"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
        </div>
        {session?.role === 'system_owner' && (
          <button 
            onClick={() => setShowAddModal(true)}
            className="px-6 py-3 bg-primary text-white font-black text-xs rounded-2xl hover:bg-primary/90 transition-all shadow-lg shadow-primary/20 uppercase tracking-widest flex items-center gap-2"
          >
            <span className="material-symbols-outlined text-sm">person_add</span>
            Add Member
          </button>
        )}
      </div>

      <div className="bg-white/80 backdrop-blur-xl rounded-[2.5rem] border border-slate-200 overflow-hidden shadow-sm">
        <table className="w-full text-left border-collapse">
          <thead>
            <tr className="border-b border-slate-100 bg-slate-50/50">
              <th className="px-8 py-6 text-[10px] font-black text-slate-400 uppercase tracking-widest">Name</th>
              <th className="px-8 py-6 text-[10px] font-black text-slate-400 uppercase tracking-widest">Email</th>
              <th className="px-8 py-6 text-[10px] font-black text-slate-400 uppercase tracking-widest">Role</th>
              <th className="px-8 py-6 text-[10px] font-black text-slate-400 uppercase tracking-widest">Status</th>
              <th className="px-8 py-6 text-[10px] font-black text-slate-400 uppercase tracking-widest text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {team.filter(u => u.name.toLowerCase().includes(searchQuery.toLowerCase()) || u.email.toLowerCase().includes(searchQuery.toLowerCase())).map((user) => (
              <tr key={user.id} className="hover:bg-slate-50/50 transition-colors border-b border-slate-50 last:border-0">
                <td className="px-8 py-6">
                  <p className="text-sm font-black text-primary">{user.name}</p>
                </td>
                <td className="px-8 py-6 text-sm font-bold text-slate-600">{user.email}</td>
                <td className="px-8 py-6">
                  <span className="px-3 py-1 bg-slate-100 text-slate-600 text-[10px] font-black uppercase tracking-widest rounded-lg">
                    {user.role}
                  </span>
                </td>
                <td className="px-8 py-6">
                  <span className="px-3 py-1 bg-emerald-500/10 text-emerald-600 border border-emerald-500/20 text-[10px] font-black uppercase tracking-widest rounded-lg">
                    {user.status}
                  </span>
                </td>
                <td className="px-8 py-6 text-right">
                  <button 
                    onClick={() => setEditingMember(user)}
                    className="p-2 hover:bg-slate-100 text-slate-400 rounded-xl transition-colors"
                  >
                    <span className="material-symbols-outlined text-sm">edit</span>
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );

  const renderRoles = () => (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <h2 className="text-2xl font-black text-primary tracking-tight">Platform Roles</h2>
        {session?.role === 'system_owner' && (
          <button 
            onClick={() => {
              setNewRole({ name: '', description: '', status: 'active', permissions: [] });
              setShowCreateRoleModal(true);
            }}
            className="px-6 py-3 bg-primary text-white font-black text-xs rounded-2xl hover:bg-primary/90 transition-all shadow-lg shadow-primary/20 uppercase tracking-widest flex items-center gap-2"
          >
            <span className="material-symbols-outlined text-sm">add</span>
            Create Role
          </button>
        )}
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {platformRolesState.map(role => (
          <div key={role.id} className="bg-white/80 backdrop-blur-xl p-8 rounded-[2.5rem] border border-slate-200 shadow-sm hover:shadow-md transition-all group">
            <div className="w-12 h-12 rounded-2xl bg-primary/5 flex items-center justify-center mb-6">
              <span className="material-symbols-outlined text-2xl text-primary">admin_panel_settings</span>
            </div>
            <h3 className="text-xl font-black text-primary mb-2">{role.name}</h3>
            <p className="text-xs font-medium text-slate-500 mb-6">{role.description || 'Platform-level access'}</p>
            <div className="flex flex-wrap gap-2 mb-8">
              {Array.isArray(role.permissions) 
                ? role.permissions.map(p => (
                    <span key={p} className="px-2 py-1 bg-slate-100 text-slate-500 text-[8px] font-black uppercase tracking-widest rounded-md">
                      {p}
                    </span>
                  ))
                : Object.entries(role.permissions).map(([k, v]) => (
                    v !== 'none' && (
                      <span key={k} className="px-2 py-1 bg-slate-100 text-slate-500 text-[8px] font-black uppercase tracking-widest rounded-md">
                        {k}: {v}
                      </span>
                    )
                  ))}
            </div>
            {session?.role === 'system_owner' && (
              <button 
                onClick={() => setActiveTab('permissions')}
                className="w-full py-3 bg-slate-50 text-slate-600 text-[10px] font-black uppercase tracking-widest rounded-xl hover:bg-slate-100 transition-colors"
              >
                Manage Permissions
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  );

  const getPermissionLevel = (role: any, featureId: string): string => {
    if (Array.isArray(role.permissions)) {
      if (role.permissions.includes('all')) return 'full';
      if (role.permissions.includes(featureId)) return 'full';
      if (role.permissions.includes(`${featureId}_read`)) return 'view';
      return 'none';
    }
    if (role.permissions?.['all'] === 'full') return 'full';
    return role.permissions?.[featureId] || 'none';
  };

  const renderPermissions = () => (
    <div className="bg-white/80 backdrop-blur-xl rounded-[2.5rem] border border-slate-200 p-8 shadow-sm">
      <h2 className="text-2xl font-black text-primary tracking-tight mb-6">Global Permissions Matrix</h2>
      <p className="text-slate-500 text-sm font-medium mb-8">Configure which roles have access to specific platform features.</p>
      
      <div className="overflow-x-auto">
        <table className="w-full text-left border-collapse">
          <thead>
            <tr className="border-b border-slate-100">
              <th className="px-4 py-4 text-[10px] font-black text-slate-400 uppercase tracking-widest">Feature</th>
              {platformRolesState.map(role => (
                <th key={role.id} className="px-4 py-4 text-[10px] font-black text-slate-400 uppercase tracking-widest text-center">{role.name}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {platformFeatures.map(feature => (
              <tr key={feature.id} className="border-b border-slate-50">
                <td className="px-4 py-4 text-sm font-bold text-slate-700">{feature.name}</td>
                {platformRolesState.map(role => {
                  const currentLevel = getPermissionLevel(role, feature.id);
                  return (
                    <td key={role.id} className="px-4 py-4 text-center">
                      <select
                        disabled={session?.role !== 'system_owner' || role.id === 'system_owner'}
                        value={currentLevel}
                        onChange={(e) => {
                          if (session?.role !== 'system_owner' || role.id === 'system_owner') return;
                          const newLevel = e.target.value;
                          const newPermissions = Array.isArray(role.permissions) 
                            ? { ...role.permissions.reduce((acc: any, p: string) => ({ ...acc, [p]: 'full' }), {}), [feature.id]: newLevel }
                            : { ...role.permissions, [feature.id]: newLevel };
                          updatePlatformRole(role.id, newPermissions as any);
                          logActivity('Updated Permissions', `Set ${feature.name} to ${newLevel} for ${role.name}`);
                        }}
                        className="text-xs font-bold text-slate-700 bg-slate-50 border border-slate-200 rounded-lg px-2 py-1 focus:ring-2 focus:ring-primary/20 focus:outline-none disabled:opacity-50"
                      >
                        <option value="none">None</option>
                        <option value="view">View Only</option>
                        <option value="create">Create</option>
                        <option value="edit">Edit</option>
                        <option value="approve">Approve</option>
                        <option value="manage">Manage</option>
                        <option value="full">Full Access</option>
                      </select>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );

  const renderActivity = () => (
    <div className="bg-white/80 backdrop-blur-xl rounded-[2.5rem] border border-slate-200 overflow-hidden shadow-sm">
      <table className="w-full text-left border-collapse">
        <thead>
          <tr className="border-b border-slate-100 bg-slate-50/50">
            <th className="px-8 py-6 text-[10px] font-black text-slate-400 uppercase tracking-widest">User</th>
            <th className="px-8 py-6 text-[10px] font-black text-slate-400 uppercase tracking-widest">Action</th>
            <th className="px-8 py-6 text-[10px] font-black text-slate-400 uppercase tracking-widest">Details</th>
            <th className="px-8 py-6 text-[10px] font-black text-slate-400 uppercase tracking-widest">Time</th>
          </tr>
        </thead>
        <tbody>
          {activityLogs.map((log) => (
            <tr key={log.id} className="hover:bg-slate-50/50 transition-colors border-b border-slate-50 last:border-0">
              <td className="px-8 py-6 text-sm font-black text-primary">{log.user}</td>
              <td className="px-8 py-6">
                <span className="px-3 py-1 bg-primary/5 text-primary text-[10px] font-black uppercase tracking-widest rounded-lg border border-primary/10">
                  {log.action}
                </span>
              </td>
              <td className="px-8 py-6 text-sm font-medium text-slate-600">{log.details}</td>
              <td className="px-8 py-6 text-sm font-bold text-slate-400">{log.time}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );

  return (
    <PageShell title="Team Management">
      <div className="space-y-8">
        <div className="flex items-center gap-2 bg-white/80 backdrop-blur-xl p-1.5 rounded-2xl border border-slate-200 shadow-sm w-fit">
          {[
            { id: 'team', label: 'Team', icon: 'group' },
            { id: 'roles', label: 'Roles', icon: 'security' },
            { id: 'permissions', label: 'Permissions', icon: 'key' },
            { id: 'activity', label: 'Activity Log', icon: 'history' }
          ].map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id as any)}
              className={`flex items-center gap-2 px-6 py-2.5 rounded-xl text-[10px] font-black uppercase tracking-widest transition-all ${
                activeTab === tab.id 
                  ? 'bg-primary text-white shadow-lg shadow-primary/20' 
                  : 'text-slate-400 hover:text-primary hover:bg-slate-50'
              }`}
            >
              <span className="material-symbols-outlined text-sm">{tab.icon}</span>
              {tab.label}
            </button>
          ))}
        </div>

        <AnimatePresence mode="wait">
          <motion.div
            key={activeTab}
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            transition={{ duration: 0.2 }}
          >
            {activeTab === 'team' && renderTeam()}
            {activeTab === 'roles' && renderRoles()}
            {activeTab === 'permissions' && renderPermissions()}
            {activeTab === 'activity' && renderActivity()}
          </motion.div>
        </AnimatePresence>

        <AnimatePresence>
          {(showAddModal || editingMember) && (
            <div key="add-modal" className="fixed inset-0 z-50 flex items-center justify-center p-6">
              <motion.div 
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                onClick={() => { setShowAddModal(false); setEditingMember(null); }}
                className="absolute inset-0 bg-slate-900/40 backdrop-blur-md"
              />
              <motion.div 
                initial={{ opacity: 0, scale: 0.9, y: 20 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.9, y: 20 }}
                className="relative w-full max-w-xl bg-white rounded-[3rem] shadow-2xl border border-slate-200 overflow-hidden"
              >
                <div className="p-8 border-b border-slate-100 flex justify-between items-center bg-slate-50/50">
                  <div>
                    <h3 className="text-2xl font-black text-primary tracking-tight">{editingMember ? 'Edit Platform Member' : 'Add Platform Member'}</h3>
                  </div>
                  <button onClick={() => { setShowAddModal(false); setEditingMember(null); }} className="w-10 h-10 rounded-full hover:bg-slate-200 flex items-center justify-center transition-colors">
                    <span className="material-symbols-outlined text-slate-400">close</span>
                  </button>
                </div>
                
                <div className="p-8 space-y-6">
                  <form onSubmit={(e) => {
                    e.preventDefault();
                    const formData = new FormData(e.currentTarget);
                    const name = formData.get('name') as string;
                    const email = formData.get('email') as string;
                    const role = formData.get('role') as string;
                    
                    if (name && email && role) {
                      if (editingMember) {
                        setTeam(prev => prev.map(u => u.id === editingMember.id ? { ...u, name, email, role } : u));
                        logActivity('Edited Member', `Updated ${name} (${email}) to ${role}`);
                        setEditingMember(null);
                      } else {
                        setTeam(prev => [...prev, {
                          id: `u${Date.now()}`,
                          name,
                          email,
                          role,
                          status: 'Active'
                        }]);
                        logActivity('Added Member', `Invited ${name} (${email}) as ${role}`);
                        setShowAddModal(false);
                      }
                    }
                  }}>
                    <div className="space-y-4">
                      <div className="space-y-2">
                        <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-4">Name</label>
                        <input name="name" defaultValue={editingMember?.name} required className="w-full px-6 py-4 bg-slate-50 rounded-2xl border border-slate-200 focus:outline-none focus:ring-2 focus:ring-primary/20 font-bold text-slate-700" placeholder="Jane Doe" />
                      </div>
                      <div className="space-y-2">
                        <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-4">Email</label>
                        <input name="email" type="email" defaultValue={editingMember?.email} required className="w-full px-6 py-4 bg-slate-50 rounded-2xl border border-slate-200 focus:outline-none focus:ring-2 focus:ring-primary/20 font-bold text-slate-700" placeholder="jane@platform.com" />
                      </div>
                      <div className="space-y-2">
                        <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-4">Role</label>
                        <select name="role" defaultValue={editingMember?.role} required className="w-full px-6 py-4 bg-slate-50 rounded-2xl border border-slate-200 focus:outline-none focus:ring-2 focus:ring-primary/20 font-bold text-slate-700">
                          {platformRolesState.map(r => <option key={r.id} value={r.name}>{r.name}</option>)}
                        </select>
                      </div>
                    </div>
                    <button type="submit" className="w-full mt-6 py-4 bg-primary text-white font-black text-sm rounded-2xl shadow-lg shadow-primary/20 uppercase tracking-widest hover:bg-primary/90 transition-all">
                      {editingMember ? 'Save Changes' : 'Send Invite'}
                    </button>
                  </form>
                </div>
              </motion.div>
            </div>
          )}
        </AnimatePresence>

        <AnimatePresence>
          {showCreateRoleModal && (
            <div key="create-role-modal" className="fixed inset-0 z-50 flex items-center justify-center p-6">
              <motion.div 
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                onClick={() => setShowCreateRoleModal(false)}
                className="absolute inset-0 bg-slate-900/40 backdrop-blur-md"
              />
              <motion.div 
                initial={{ opacity: 0, scale: 0.9, y: 20 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.9, y: 20 }}
                className="relative w-full max-w-xl bg-white rounded-[3rem] shadow-2xl border border-slate-200 overflow-hidden flex flex-col max-h-[90vh]"
              >
                <div className="p-8 border-b border-slate-100 flex justify-between items-center bg-slate-50/50">
                  <div>
                    <h3 className="text-2xl font-black text-primary tracking-tight">Create Platform Role</h3>
                    <p className="text-xs font-bold text-slate-400 uppercase tracking-widest mt-1">Define a new role for the platform</p>
                  </div>
                  <button onClick={() => setShowCreateRoleModal(false)} className="w-10 h-10 rounded-full hover:bg-slate-200 flex items-center justify-center transition-colors">
                    <span className="material-symbols-outlined text-slate-400">close</span>
                  </button>
                </div>
                
                <div className="p-8 overflow-y-auto flex-1 space-y-6">
                  <div className="space-y-2">
                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-4">Role Name</label>
                    <input 
                      value={newRole.name}
                      onChange={(e) => setNewRole(prev => ({ ...prev, name: e.target.value }))}
                      className="w-full px-6 py-4 bg-slate-50 rounded-2xl border border-slate-200 focus:outline-none focus:ring-2 focus:ring-primary/20 font-bold text-slate-700" 
                      placeholder="e.g. Content Manager"
                    />
                  </div>
                  <div className="space-y-2">
                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-4">Description</label>
                    <textarea 
                      value={newRole.description}
                      onChange={(e) => setNewRole(prev => ({ ...prev, description: e.target.value }))}
                      className="w-full px-6 py-4 bg-slate-50 rounded-2xl border border-slate-200 focus:outline-none focus:ring-2 focus:ring-primary/20 font-bold text-slate-700 resize-none h-20" 
                      placeholder="Describe what this role does..."
                    />
                  </div>
                  <div className="space-y-2">
                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-4">Status</label>
                    <select 
                      value={newRole.status}
                      onChange={(e) => setNewRole(prev => ({ ...prev, status: e.target.value }))}
                      className="w-full px-6 py-4 bg-slate-50 rounded-2xl border border-slate-200 focus:outline-none focus:ring-2 focus:ring-primary/20 font-bold text-slate-700"
                    >
                      <option value="active">Active</option>
                      <option value="inactive">Inactive</option>
                    </select>
                  </div>
                  <div className="space-y-3">
                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-4">Permission Assignments</label>
                    <div className="grid grid-cols-2 gap-3">
                      {platformFeatures.map(feature => (
                        <label 
                          key={feature.id}
                          className={`flex items-center gap-3 p-4 rounded-2xl border cursor-pointer transition-all ${
                            newRole.permissions.includes(feature.id)
                              ? 'bg-primary/5 border-primary/20'
                              : 'bg-slate-50 border-slate-200 hover:border-slate-300'
                          }`}
                        >
                          <input 
                            type="checkbox"
                            checked={newRole.permissions.includes(feature.id)}
                            onChange={() => togglePermission(feature.id)}
                            className="w-4 h-4 text-primary rounded border-slate-300 focus:ring-primary"
                          />
                          <span className="text-xs font-bold text-slate-700">{feature.name}</span>
                        </label>
                      ))}
                    </div>
                  </div>
                </div>

                <div className="p-8 border-t border-slate-100 bg-slate-50/50 flex gap-4">
                  <button 
                    onClick={() => setShowCreateRoleModal(false)}
                    className="flex-1 py-4 bg-white text-slate-600 font-black text-sm rounded-2xl border border-slate-200 hover:bg-slate-50 transition-all uppercase tracking-widest"
                  >
                    Cancel
                  </button>
                  <button 
                    onClick={handleCreateRole}
                    disabled={!newRole.name.trim()}
                    className="flex-1 py-4 bg-primary text-white font-black text-sm rounded-2xl shadow-lg shadow-primary/20 uppercase tracking-widest hover:bg-primary/90 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    Create Role
                  </button>
                </div>
              </motion.div>
            </div>
          )}
        </AnimatePresence>
      </div>
    </PageShell>
  );
}
