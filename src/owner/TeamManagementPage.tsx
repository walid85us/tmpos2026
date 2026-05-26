import React, { useEffect, useMemo, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import PageShell from '../components/PageShell';
import { useAccess } from '../context/AccessContext';
import { platformTeamMembers, type PlatformTeamStatus } from './mockData';
import { pushPlatformAudit } from './platformOpsAudit';
import type { PermissionLevel } from '../types';
import type { Role } from '../context/accessConfig';
import {
  PLATFORM_FEATURE_GROUPS,
  PLATFORM_PERMISSION_LEVELS,
  PLATFORM_PERMISSION_LEVEL_LABEL,
  PLATFORM_PERMISSION_DEPENDENCIES,
  findSubPermissionDef,
  explainAccessDecision,
  PLATFORM_ROLE_DISPLAY_LABEL,
  DEFAULT_PLATFORM_FEATURE_LEVELS,
  readPlatformPermissionsOverrides,
  writePlatformPermissionsOverrides,
  platformPermissionMeets,
  getPlatformFeatureLevel,
  getPlatformSubPermissionLevel,
  type PlatformFeatureKey,
  type PlatformPermissionsOverrides,
} from './platformPermissionsConfig';

// Phase 1.1.3A correction — the Global Permissions Matrix is governed by the
// 5 hardcoded platform roles. Custom roles created via "Create Role" still
// live in AccessContext.platformRolesState (legacy permissions array) and
// are NOT shown as columns here — they remain visible on the Roles tab.
const MATRIX_ROLES: Role[] = [
  'system_owner',
  'support_admin',
  'billing_admin',
  'operations_admin',
  'security_admin',
];

type TeamMember = { id: string; name: string; email: string; role: string; status: PlatformTeamStatus };

const STATUS_BADGE_STYLES: Record<PlatformTeamStatus, string> = {
  invited: 'bg-amber-400/10 text-amber-700 border-amber-400/20',
  active: 'bg-emerald-500/10 text-emerald-600 border-emerald-500/20',
  suspended: 'bg-orange-400/10 text-orange-700 border-orange-400/20',
  disabled: 'bg-slate-200 text-slate-600 border-slate-300',
};

export default function TeamManagementPage() {
  const { session, platformRolesState = [], addPlatformRole, updatePlatformRole } = useAccess();
  const [activeTab, setActiveTab] = useState<'team' | 'roles' | 'permissions' | 'activity'>('team');
  const [searchQuery, setSearchQuery] = useState('');
  const [showAddModal, setShowAddModal] = useState(false);
  const [showCreateRoleModal, setShowCreateRoleModal] = useState(false);
  const [editingMember, setEditingMember] = useState<TeamMember | null>(null);

  const [newRole, setNewRole] = useState({ name: '', description: '', status: 'active' as string, permissions: [] as string[] });

  const [team, setTeam] = useState<TeamMember[]>(() =>
    platformTeamMembers.map(m => ({ id: m.id, name: m.name, email: m.email, role: m.role, status: m.status }))
  );

  const [activityLogs, setActivityLogs] = useState([
    { id: 'a1', user: 'Admin User', action: 'Created Role', details: 'Added new Billing Admin role', time: '2024-03-20 10:00' },
    { id: 'a2', user: 'Support Rep', action: 'Reset Password', details: 'Reset password for store tenant-1', time: '2024-03-20 11:30' },
  ]);

  const [showResetConfirm, setShowResetConfirm] = useState(false);

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
    pushPlatformAudit({
      actor: session?.user?.name || 'System Owner',
      action: 'platform_role_created',
      target: newRole.name,
      category: 'team',
      severity: 'notice',
      note: newRole.permissions.length > 0 ? `Permissions: ${newRole.permissions.join(', ')}` : 'No permissions assigned',
    });
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
                  <span className={`px-3 py-1 text-[10px] font-black uppercase tracking-widest rounded-lg border ${STATUS_BADGE_STYLES[user.status] || STATUS_BADGE_STYLES.active}`}>
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

  // ----- Phase 1.1.3A correction — Global Permissions Matrix -------------
  // The matrix now reads from / writes to sessionStorage
  // `platform_permissions_v1` and uses `platformPermissionsConfig` as the
  // single source of truth. System Owner remains locked at Full Access.
  // Sub-permission rows are collapsible per parent feature.
  const [overrides, setOverrides] = useState<PlatformPermissionsOverrides>(() => readPlatformPermissionsOverrides());
  const [expandedFeatures, setExpandedFeatures] = useState<Record<PlatformFeatureKey, boolean>>(() => ({} as any));
  const [matrixSearch, setMatrixSearch] = useState('');
  const [previewRole, setPreviewRole] = useState<Role | null>(null);

  useEffect(() => {
    const onChange = () => setOverrides(readPlatformPermissionsOverrides());
    window.addEventListener('platform_permissions:changed', onChange);
    window.addEventListener('storage', onChange);
    return () => {
      window.removeEventListener('platform_permissions:changed', onChange);
      window.removeEventListener('storage', onChange);
    };
  }, []);

  const isOwner = session?.role === 'system_owner';

  const setFeatureLevel = (role: Role, featureKey: PlatformFeatureKey, level: PermissionLevel) => {
    if (!isOwner || role === 'system_owner') return;
    const oldLevel = getPlatformFeatureLevel(role, featureKey, overrides);
    if (oldLevel === level) return;
    const next: PlatformPermissionsOverrides = { ...overrides };
    const roleEntry = { ...(next[role] || {}) };
    const features = { ...(roleEntry.features || {}) };
    features[featureKey] = level;
    roleEntry.features = features;
    next[role] = roleEntry;
    setOverrides(next);
    writePlatformPermissionsOverrides(next);
    const featureLabel = PLATFORM_FEATURE_GROUPS.find(g => g.key === featureKey)?.label || featureKey;
    const roleLabel = PLATFORM_ROLE_DISPLAY_LABEL[role];
    logActivity('Updated Permissions', `Set ${featureLabel} to ${level} for ${roleLabel}`);
    pushPlatformAudit({
      actor: session?.user?.name || 'System Owner',
      action: 'platform_permission_changed',
      target: `${roleLabel} · ${featureLabel}`,
      category: 'team',
      oldValue: oldLevel,
      newValue: level,
      severity: 'warning',
    });
  };

  const setSubLevel = (role: Role, featureKey: PlatformFeatureKey, subKey: string, level: PermissionLevel) => {
    if (!isOwner || role === 'system_owner') return;
    const oldLevel = getPlatformSubPermissionLevel(role, subKey, overrides);
    if (oldLevel === level) return;
    const next: PlatformPermissionsOverrides = { ...overrides };
    const roleEntry = { ...(next[role] || {}) };
    const subs = { ...(roleEntry.subs || {}) };
    subs[subKey] = level;
    roleEntry.subs = subs;
    next[role] = roleEntry;
    setOverrides(next);
    writePlatformPermissionsOverrides(next);
    const group = PLATFORM_FEATURE_GROUPS.find(g => g.key === featureKey);
    const subDef = group?.subPermissions.find(s => s.id === subKey);
    const roleLabel = PLATFORM_ROLE_DISPLAY_LABEL[role];
    logActivity('Updated Sub-Permission', `Set ${subDef?.label || subKey} to ${level} for ${roleLabel}`);
    pushPlatformAudit({
      actor: session?.user?.name || 'System Owner',
      action: 'platform_sub_permission_changed',
      target: `${roleLabel} · ${group?.label || featureKey} · ${subDef?.label || subKey}`,
      category: 'team',
      oldValue: oldLevel,
      newValue: level,
      severity: 'warning',
    });
  };

  const enabledSubCount = (role: Role, featureKey: PlatformFeatureKey): { enabled: number; total: number } => {
    const group = PLATFORM_FEATURE_GROUPS.find(g => g.key === featureKey);
    if (!group) return { enabled: 0, total: 0 };
    let enabled = 0;
    for (const sp of group.subPermissions) {
      const lvl = getPlatformSubPermissionLevel(role, sp.id, overrides);
      if (platformPermissionMeets(lvl, sp.threshold)) enabled++;
    }
    return { enabled, total: group.subPermissions.length };
  };

  const renderLevelSelect = (
    value: PermissionLevel,
    onChange: (lvl: PermissionLevel) => void,
    disabled: boolean,
    testId?: string
  ) => (
    <select
      data-testid={testId}
      disabled={disabled}
      value={value}
      onChange={e => onChange(e.target.value as PermissionLevel)}
      className="text-[11px] font-bold text-slate-700 bg-slate-50 border border-slate-200 rounded-lg px-2 py-1 focus:ring-2 focus:ring-primary/20 focus:outline-none disabled:opacity-50 disabled:cursor-not-allowed"
    >
      {PLATFORM_PERMISSION_LEVELS.map(lvl => (
        <option key={lvl} value={lvl}>{PLATFORM_PERMISSION_LEVEL_LABEL[lvl]}</option>
      ))}
    </select>
  );

  const allExpanded = PLATFORM_FEATURE_GROUPS.every(g => expandedFeatures[g.key]);

  const toggleExpandAll = () => {
    if (allExpanded) {
      setExpandedFeatures({} as any);
    } else {
      const all: Record<PlatformFeatureKey, boolean> = {} as any;
      PLATFORM_FEATURE_GROUPS.forEach(g => { all[g.key] = true; });
      setExpandedFeatures(all);
    }
  };

  const resetToDefaults = () => {
    setShowResetConfirm(true);
  };

  const confirmReset = () => {
    writePlatformPermissionsOverrides({});
    setOverrides({});
    logActivity('Reset Permissions', 'All overrides cleared — reverted to default levels');
    pushPlatformAudit({
      actor: session?.user?.name || 'System Owner',
      action: 'platform_permissions_reset',
      target: 'All roles',
      category: 'team',
      severity: 'warning',
      note: 'All overrides cleared to defaults',
    });
    setShowResetConfirm(false);
  };

  const filteredGroups = useMemo(() => {
    if (!matrixSearch.trim()) return PLATFORM_FEATURE_GROUPS;
    const q = matrixSearch.toLowerCase();
    return PLATFORM_FEATURE_GROUPS.filter(g =>
      g.label.toLowerCase().includes(q) ||
      g.description.toLowerCase().includes(q) ||
      g.subPermissions.some(sp => sp.label.toLowerCase().includes(q) || sp.description.toLowerCase().includes(q))
    );
  }, [matrixSearch]);

  const hasOverrides = Object.keys(overrides).length > 0;

  const renderPreviewPanel = () => {
    if (!previewRole) return null;
    const roleLabel = PLATFORM_ROLE_DISPLAY_LABEL[previewRole];
    return (
      <div className="bg-indigo-50/60 border border-indigo-200/60 rounded-2xl p-5 mb-6">
        <div className="flex items-center justify-between gap-3 mb-3">
          <h3 className="text-sm font-black text-indigo-900 uppercase tracking-widest flex items-center gap-2">
            <span className="material-symbols-outlined text-base">visibility</span>
            Effective Access — {roleLabel}
          </h3>
          <button onClick={() => setPreviewRole(null)} className="text-indigo-400 hover:text-indigo-600 transition-colors">
            <span className="material-symbols-outlined text-sm">close</span>
          </button>
        </div>
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-2">
          {PLATFORM_FEATURE_GROUPS.map(g => {
            const lvl = previewRole === 'system_owner' ? 'full' as PermissionLevel : getPlatformFeatureLevel(previewRole, g.key, overrides);
            const { enabled, total } = enabledSubCount(previewRole, g.key);
            const isNone = lvl === 'none';
            const isFull = lvl === 'full';
            const childGranted = isNone && enabled > 0;
            // Count child sub-permissions that are blocked by a prerequisite
            // for this role — surfaces prerequisite-driven gating in the
            // Effective Access Preview ("X blocked by prerequisite").
            const prereqBlocked = previewRole === 'system_owner' ? 0 : g.subPermissions.reduce((n, sp) => {
              const dec = explainAccessDecision(previewRole, sp.id, overrides);
              return n + (!dec.allowed && dec.source === 'denied_prerequisite' ? 1 : 0);
            }, 0);
            return (
              <div key={g.key} className={`px-3 py-2.5 rounded-xl border text-xs ${
                childGranted ? 'bg-amber-50 border-amber-200 text-amber-700' :
                isNone ? 'bg-red-50 border-red-200 text-red-700' :
                isFull ? 'bg-emerald-50 border-emerald-200 text-emerald-700' :
                'bg-white border-slate-200 text-slate-700'
              }`}>
                <p className="font-black text-[10px] uppercase tracking-widest truncate">{g.label}</p>
                <p className="font-bold mt-0.5">{PLATFORM_PERMISSION_LEVEL_LABEL[lvl]}</p>
                <p className="text-[9px] font-medium mt-0.5 opacity-70">{enabled}/{total} subs enabled</p>
                {childGranted && (
                  <p className="text-[8px] font-black mt-1 text-amber-600 uppercase tracking-widest">Sidebar visible via child</p>
                )}
                {prereqBlocked > 0 && (
                  <p
                    data-testid={`preview-prereq-blocked-${g.key}`}
                    title="Some child actions in this feature are auto-disabled because a prerequisite permission is None or below its threshold. Hover the matrix row for details."
                    className="text-[8px] font-black mt-1 text-indigo-600 uppercase tracking-widest"
                  >
                    {prereqBlocked} blocked by prereq
                  </p>
                )}
                {previewRole === 'system_owner' && (
                  <p className="text-[8px] font-black mt-1 text-emerald-600 uppercase tracking-widest">Locked</p>
                )}
              </div>
            );
          })}
        </div>
      </div>
    );
  };

  const renderPermissions = () => (
    <div className="bg-white/80 backdrop-blur-xl rounded-[2.5rem] border border-slate-200 p-8 shadow-sm" data-testid="global-permissions-matrix">
      <div className="flex items-start justify-between gap-6 flex-wrap mb-4">
        <div>
          <h2 className="text-2xl font-black text-primary tracking-tight">Global Permissions Matrix</h2>
          <p className="text-slate-500 text-sm font-medium mt-1 max-w-3xl">
            Configure platform-side feature access for each platform role using the same 7-level hierarchy used elsewhere in the app
            (None / View Only / Create / Edit / Approve / Manage / Full Access). Expand a row to fine-tune approval-sensitive sub-permissions.
          </p>
        </div>
      </div>
      <div className="bg-amber-400/10 border border-amber-400/30 rounded-2xl p-4 flex items-start gap-3 mb-6" data-testid="matrix-truth-banner">
        <span className="material-symbols-outlined text-amber-700 text-lg mt-0.5">info</span>
        <div className="text-xs font-medium text-amber-900 leading-relaxed space-y-1">
          <p><span className="font-black uppercase tracking-widest">Scope:</span> these permissions control System Owner / platform staff access. Tenant / store employee access is governed separately by the Store Permissions Matrix.</p>
          <p><span className="font-black uppercase tracking-widest">Limitations:</span> permissions are UI-enforced only — there is no server-side RBAC, PIM, or PAM in this phase. Server-side enforcement is planned for Phase 1.3. System Owner is always Full Access and is intentionally not editable.</p>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3 mb-4">
        <div className="relative flex-1 min-w-[220px] max-w-sm">
          <span className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 text-sm">search</span>
          <input
            type="text"
            placeholder="Search features or sub-permissions..."
            value={matrixSearch}
            onChange={e => setMatrixSearch(e.target.value)}
            className="w-full pl-9 pr-4 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-xs font-bold text-slate-700 focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary placeholder:text-slate-400"
          />
          {matrixSearch && (
            <button onClick={() => setMatrixSearch('')} className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600">
              <span className="material-symbols-outlined text-sm">close</span>
            </button>
          )}
        </div>
        <button
          onClick={toggleExpandAll}
          className="px-4 py-2.5 bg-slate-100 hover:bg-slate-200 text-slate-600 font-black text-[10px] rounded-xl uppercase tracking-widest transition-all flex items-center gap-1.5"
        >
          <span className="material-symbols-outlined text-sm">{allExpanded ? 'unfold_less' : 'unfold_more'}</span>
          {allExpanded ? 'Collapse All' : 'Expand All'}
        </button>
        {isOwner && hasOverrides && (
          <button
            onClick={resetToDefaults}
            className="px-4 py-2.5 bg-amber-50 hover:bg-amber-100 text-amber-700 font-black text-[10px] rounded-xl uppercase tracking-widest transition-all flex items-center gap-1.5 border border-amber-200"
          >
            <span className="material-symbols-outlined text-sm">restart_alt</span>
            Reset to Defaults
          </button>
        )}
        <div className="flex items-center gap-2">
          <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Preview:</span>
          <select
            value={previewRole || ''}
            onChange={e => setPreviewRole(e.target.value ? e.target.value as Role : null)}
            className="text-[11px] font-bold text-slate-700 bg-slate-50 border border-slate-200 rounded-lg px-2 py-1.5 focus:ring-2 focus:ring-primary/20 focus:outline-none"
          >
            <option value="">Select role...</option>
            {MATRIX_ROLES.map(r => (
              <option key={r} value={r}>{PLATFORM_ROLE_DISPLAY_LABEL[r]}</option>
            ))}
          </select>
        </div>
      </div>

      {renderPreviewPanel()}

      {matrixSearch && filteredGroups.length === 0 && (
        <div className="text-center py-12 text-slate-400">
          <span className="material-symbols-outlined text-4xl mb-2 block">search_off</span>
          <p className="text-sm font-bold">No features match "{matrixSearch}"</p>
        </div>
      )}

      <div className="overflow-x-auto">
        <table className="w-full text-left border-collapse min-w-[920px]">
          <thead>
            <tr className="border-b border-slate-100 bg-white/90 backdrop-blur-sm sticky top-0 z-10">
              <th className="px-4 py-4 text-[10px] font-black text-slate-400 uppercase tracking-widest w-[28%]">Feature / Sub-Permission</th>
              {MATRIX_ROLES.map(role => (
                <th key={role} className="px-3 py-4 text-[10px] font-black text-slate-400 uppercase tracking-widest text-center">
                  {PLATFORM_ROLE_DISPLAY_LABEL[role]}
                  {role === 'system_owner' && <div className="text-[9px] font-medium text-slate-400 normal-case tracking-normal mt-0.5">(locked)</div>}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {filteredGroups.map(group => {
              const expanded = !!expandedFeatures[group.key];
              const searchActive = !!matrixSearch.trim();
              const q = matrixSearch.toLowerCase();
              const matchingSubs = searchActive
                ? group.subPermissions.filter(sp => sp.label.toLowerCase().includes(q) || sp.description.toLowerCase().includes(q))
                : group.subPermissions;
              const showExpanded = expanded || (searchActive && matchingSubs.length > 0);
              return (
                <React.Fragment key={group.key}>
                  <tr className="border-b border-slate-100 bg-slate-50/40" data-testid={`matrix-feature-row-${group.key}`}>
                    <td className="px-4 py-4 align-top">
                      <button
                        type="button"
                        onClick={() => setExpandedFeatures(prev => ({ ...prev, [group.key]: !prev[group.key] }))}
                        data-testid={`matrix-expand-${group.key}`}
                        className="flex items-center gap-2 text-sm font-black text-slate-800 hover:text-primary transition-colors"
                      >
                        <span className={`material-symbols-outlined text-base transition-transform ${showExpanded ? 'rotate-90' : ''}`}>chevron_right</span>
                        {group.label}
                      </button>
                      <p className="text-[10px] font-medium text-slate-500 mt-0.5 ml-6">{group.description}</p>
                    </td>
                    {MATRIX_ROLES.map(role => {
                      const lvl = getPlatformFeatureLevel(role, group.key, overrides);
                      const { enabled, total } = enabledSubCount(role, group.key);
                      const lockedRow = !isOwner || role === 'system_owner';
                      const displayLvl: PermissionLevel = role === 'system_owner' ? 'full' : lvl;
                      return (
                        <td key={role} className="px-3 py-4 text-center align-top">
                          {renderLevelSelect(
                            displayLvl,
                            (next) => setFeatureLevel(role, group.key, next),
                            lockedRow,
                            `matrix-feature-${group.key}-${role}`
                          )}
                          <div className="text-[9px] font-bold uppercase tracking-widest text-slate-400 mt-1">
                            {role === 'system_owner' ? `${total} / ${total} enabled` : `${enabled} / ${total} enabled`}
                          </div>
                        </td>
                      );
                    })}
                  </tr>
                  {showExpanded && (searchActive ? matchingSubs : group.subPermissions).map(sp => {
                    // Permission Dependency / Prerequisite Map feedback
                    // (spec PART G). When this sub-permission depends on
                    // others, render a quiet inline indicator so editors
                    // know which prerequisite gates this action.
                    const depKeys = PLATFORM_PERMISSION_DEPENDENCIES[sp.id] || [];
                    const depLabels = depKeys
                      .map(k => findSubPermissionDef(k)?.def.label)
                      .filter(Boolean) as string[];
                    return (
                    <tr key={`${group.key}-${sp.id}`} className="border-b border-slate-50" data-testid={`matrix-sub-row-${sp.id}`}>
                      <td className="px-4 py-3 pl-12">
                        <p className="text-xs font-bold text-slate-700 flex items-center gap-2 flex-wrap">
                          {sp.label}
                          {sp.sensitive && (
                            <span className="px-1.5 py-0.5 text-[8px] font-black uppercase tracking-widest rounded bg-amber-400/10 text-amber-700 border border-amber-400/20">sensitive</span>
                          )}
                          {depLabels.length > 0 && (
                            <span
                              data-testid={`matrix-sub-dep-${sp.id}`}
                              title={`Depends on: ${depLabels.join(', ')}. If any prerequisite is None / below its threshold, this action is auto-disabled.`}
                              className="px-1.5 py-0.5 text-[8px] font-black uppercase tracking-widest rounded bg-indigo-400/10 text-indigo-700 border border-indigo-400/20"
                            >
                              depends on {depLabels.length === 1 ? depLabels[0] : `${depLabels.length} prereqs`}
                            </span>
                          )}
                        </p>
                        <p className="text-[10px] font-medium text-slate-500 mt-0.5">
                          {sp.description}
                          <span className="text-slate-400"> · Requires {PLATFORM_PERMISSION_LEVEL_LABEL[sp.threshold]} or higher.</span>
                        </p>
                      </td>
                      {MATRIX_ROLES.map(role => {
                        const lvl = getPlatformSubPermissionLevel(role, sp.id, overrides);
                        const lockedRow = !isOwner || role === 'system_owner';
                        const displayLvl: PermissionLevel = role === 'system_owner' ? 'full' : lvl;
                        // Use explainAccessDecision so prerequisite-denied
                        // is surfaced as a distinct, explanatory state
                        // ("blocked by prerequisite") rather than just
                        // "disabled".
                        const dec = explainAccessDecision(role, sp.id, overrides);
                        const meets = dec.allowed;
                        const blockedByPrereq = !meets && dec.source === 'denied_prerequisite';
                        return (
                          <td key={role} className="px-3 py-3 text-center">
                            {renderLevelSelect(
                              displayLvl,
                              (next) => setSubLevel(role, group.key, sp.id, next),
                              lockedRow,
                              `matrix-sub-${sp.id}-${role}`
                            )}
                            <div
                              title={!meets ? dec.reason : ''}
                              className={`text-[9px] font-bold uppercase tracking-widest mt-1 ${
                                meets ? 'text-emerald-600' :
                                blockedByPrereq ? 'text-indigo-500' :
                                'text-slate-400'
                              }`}
                            >
                              {meets ? 'enabled' : blockedByPrereq ? 'blocked by prereq' : 'disabled'}
                            </div>
                          </td>
                        );
                      })}
                    </tr>
                    );
                  })}
                </React.Fragment>
              );
            })}
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
        <div className="bg-amber-400/10 border border-amber-400/30 rounded-2xl p-4 flex items-start gap-3">
          <span className="material-symbols-outlined text-amber-700 text-lg mt-0.5">verified_user</span>
          <div>
            <p className="text-xs font-black text-amber-900 uppercase tracking-widest">Authentication & SSO not enforced</p>
            <p className="text-xs font-medium text-amber-800 mt-1">This directory governs the in-app role display only. The application does not currently enforce SSO, MFA, or session policies for platform team members.</p>
          </div>
        </div>

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
                    const status = (formData.get('status') as PlatformTeamStatus) || 'invited';

                    if (name && email && role) {
                      const actor = session?.user?.name || 'System Owner';
                      if (editingMember) {
                        const prev = editingMember;
                        setTeam(list => list.map(u => u.id === prev.id ? { ...u, name, email, role, status } : u));
                        logActivity('Edited Member', `Updated ${name} (${email}) to ${role} [${status}]`);
                        if (prev.role !== role) {
                          pushPlatformAudit({
                            actor,
                            action: 'platform_team_member_role_changed',
                            target: `${name} (${email})`,
                            category: 'team',
                            oldValue: prev.role,
                            newValue: role,
                            severity: 'warning',
                          });
                        }
                        if (prev.status !== status) {
                          pushPlatformAudit({
                            actor,
                            action: 'platform_team_member_status_changed',
                            target: `${name} (${email})`,
                            category: 'team',
                            oldValue: prev.status,
                            newValue: status,
                            severity: status === 'suspended' || status === 'disabled' ? 'warning' : 'notice',
                          });
                        }
                        if (prev.role === role && prev.status === status && (prev.name !== name || prev.email !== email)) {
                          pushPlatformAudit({
                            actor,
                            action: 'platform_team_member_updated',
                            target: `${name} (${email})`,
                            category: 'team',
                            severity: 'info',
                            note: 'Profile updated',
                          });
                        }
                        setEditingMember(null);
                      } else {
                        setTeam(list => [...list, {
                          id: `u${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
                          name,
                          email,
                          role,
                          status,
                        }]);
                        logActivity('Added Member', `Invited ${name} (${email}) as ${role} [${status}]`);
                        pushPlatformAudit({
                          actor,
                          action: 'platform_team_member_invited',
                          target: `${name} (${email})`,
                          category: 'team',
                          severity: 'notice',
                          note: `Role: ${role}; Initial status: ${status}`,
                        });
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
                      <div className="space-y-2">
                        <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-4">Status</label>
                        <select name="status" defaultValue={editingMember?.status || 'invited'} className="w-full px-6 py-4 bg-slate-50 rounded-2xl border border-slate-200 focus:outline-none focus:ring-2 focus:ring-primary/20 font-bold text-slate-700">
                          <option value="invited">Invited</option>
                          <option value="active">Active</option>
                          <option value="suspended">Suspended</option>
                          <option value="disabled">Disabled</option>
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

        <AnimatePresence>
          {showResetConfirm && (
            <div className="fixed inset-0 bg-black/40 backdrop-blur-md z-50 flex items-center justify-center p-4" onClick={() => setShowResetConfirm(false)} onKeyDown={e => { if (e.key === 'Escape') setShowResetConfirm(false); }}>
              <motion.div
                initial={{ opacity: 0, scale: 0.95, y: 10 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.95, y: 10 }}
                transition={{ duration: 0.2 }}
                onClick={e => e.stopPropagation()}
                className="bg-white rounded-3xl shadow-2xl w-full max-w-md overflow-hidden border border-slate-200"
              >
                <div className="p-8">
                  <div className="flex items-center gap-3 mb-4">
                    <span className="material-symbols-outlined text-amber-500 text-2xl">warning</span>
                    <h3 className="text-xl font-black text-slate-900 tracking-tight">Reset to Defaults</h3>
                  </div>
                  <p className="text-sm text-slate-600 mb-2">
                    This will clear all permission overrides for every platform role and revert them to their default levels.
                  </p>
                  <p className="text-xs text-slate-500 mb-6">
                    Affected roles: {MATRIX_ROLES.filter(r => r !== 'system_owner').map(r => PLATFORM_ROLE_DISPLAY_LABEL[r]).join(', ')}. System Owner remains locked at Full Access.
                  </p>
                  <div className="flex gap-3">
                    <button
                      onClick={() => setShowResetConfirm(false)}
                      className="flex-1 py-3 bg-white text-slate-600 font-black text-[10px] rounded-2xl border border-slate-200 hover:bg-slate-50 transition-all uppercase tracking-widest"
                    >
                      Cancel
                    </button>
                    <button
                      onClick={confirmReset}
                      className="flex-1 py-3 bg-amber-500 text-white font-black text-[10px] rounded-2xl shadow-lg shadow-amber-500/20 uppercase tracking-widest hover:bg-amber-600 transition-all"
                    >
                      Confirm Reset
                    </button>
                  </div>
                </div>
              </motion.div>
            </div>
          )}
        </AnimatePresence>
      </div>
    </PageShell>
  );
}
