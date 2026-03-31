import React from 'react';
import { PERMISSION_DOMAINS, PERMISSION_HIERARCHY } from '../context/accessConfig';
import { useAccess } from '../context/AccessContext';
import { PermissionLevel } from '../types';

const EmployeesPermissionsPage: React.FC = () => {
  const { tenantRolesState, updateTenantRole } = useAccess();

  const editableRoles = tenantRolesState.filter(r => r.id !== 'store_owner');

  const getLevel = (role: typeof tenantRolesState[0], domainId: string): PermissionLevel => {
    const perms = role.permissions;
    if (Array.isArray(perms)) {
      if (perms.includes('all')) return 'full';
      if (perms.includes(domainId)) return 'full';
      if (perms.includes(`${domainId}_read`)) return 'view';
      return 'none';
    }
    if ((perms as Record<string, PermissionLevel>)['_grant'] === 'full') return 'full';
    return (perms as Record<string, PermissionLevel>)[domainId] || 'none';
  };

  const handleChange = (roleId: string, domainId: string, newLevel: PermissionLevel) => {
    const role = tenantRolesState.find(r => r.id === roleId);
    if (!role) return;
    let perms: Record<string, PermissionLevel>;
    if (Array.isArray(role.permissions)) {
      perms = {} as Record<string, PermissionLevel>;
      PERMISSION_DOMAINS.forEach(d => {
        perms[d.id] = getLevel(role, d.id);
      });
    } else {
      perms = { ...(role.permissions as Record<string, PermissionLevel>) };
    }
    perms[domainId] = newLevel;
    updateTenantRole(roleId, perms);
  };

  const levelColors: Record<PermissionLevel, string> = {
    none: 'bg-slate-100 text-slate-400 border-slate-200',
    view: 'bg-sky-50 text-sky-700 border-sky-200',
    create: 'bg-emerald-50 text-emerald-700 border-emerald-200',
    edit: 'bg-amber-50 text-amber-700 border-amber-200',
    manage: 'bg-violet-50 text-violet-700 border-violet-200',
    approve: 'bg-orange-50 text-orange-700 border-orange-200',
    full: 'bg-teal-50 text-teal-700 border-teal-200',
  };

  return (
    <div className="space-y-8">
      <div>
        <h2 className="text-2xl font-black text-primary tracking-tight">Permissions Matrix</h2>
        <p className="text-slate-500 font-medium">Assign permission levels to each role. Store Owner always has Full Access.</p>
      </div>

      <div className="bg-white/80 backdrop-blur-xl rounded-[2.5rem] border border-slate-200 shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left">
            <thead>
              <tr className="border-b border-slate-200">
                <th className="px-6 py-4 text-[10px] font-black uppercase tracking-widest text-slate-400 w-48">Domain</th>
                {editableRoles.map(role => (
                  <th key={role.id} className="px-4 py-4 text-[10px] font-black uppercase tracking-widest text-slate-500 text-center min-w-[140px]">
                    {role.name}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {PERMISSION_DOMAINS.map((domain) => (
                <tr key={domain.id} className="border-b border-slate-100 last:border-0 hover:bg-slate-50/50 transition-colors">
                  <td className="px-6 py-3">
                    <span className="text-sm font-bold text-primary">{domain.label}</span>
                  </td>
                  {editableRoles.map(role => {
                    const current = getLevel(role, domain.id);
                    return (
                      <td key={role.id} className="px-4 py-3 text-center">
                        <select
                          value={current}
                          onChange={(e) => handleChange(role.id, domain.id, e.target.value as PermissionLevel)}
                          className={`text-[10px] font-black uppercase tracking-wider px-3 py-1.5 rounded-lg border cursor-pointer appearance-none text-center transition-colors ${levelColors[current]}`}
                        >
                          {domain.levels.map(level => (
                            <option key={level} value={level}>
                              {level === 'none' ? 'None' : level === 'view' ? 'View' : level === 'create' ? 'Create' : level === 'edit' ? 'Edit' : level === 'manage' ? 'Manage' : level === 'approve' ? 'Approve' : 'Full'}
                            </option>
                          ))}
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

      <div className="bg-white/80 backdrop-blur-xl p-6 rounded-[2.5rem] border border-slate-200 shadow-sm">
        <h3 className="text-sm font-black text-primary tracking-tight mb-3">Permission Hierarchy</h3>
        <div className="flex flex-wrap gap-2">
          {PERMISSION_HIERARCHY.map((level, i) => (
            <div key={level} className="flex items-center gap-1">
              <span className={`px-3 py-1 text-[10px] font-black uppercase tracking-widest rounded-lg border ${levelColors[level]}`}>
                {level}
              </span>
              {i < PERMISSION_HIERARCHY.length - 1 && (
                <span className="material-symbols-outlined text-slate-300 text-xs">chevron_right</span>
              )}
            </div>
          ))}
        </div>
        <p className="text-xs text-slate-400 mt-3">Each level includes all capabilities of lower levels. For example, "Manage" includes View, Create, and Edit.</p>
      </div>
    </div>
  );
};

export default EmployeesPermissionsPage;
