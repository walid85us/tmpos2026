// M5-GAP11-P5 (C) — the production-reachable store role states, regenerated from the current code.
//
// The four state groups M5-GAP11-P4 measured (docs/phase-4/09, P4 STOP) are rebuilt here from the
// catalogs and from the literal checkPermission(...) call sites in src/, then every decision is taken by
// the REAL decision functions (tenantAccessDecisions.ts) and compared with the pre-P5 client algorithm,
// frozen below. Non-money decisions must not change at all; every money decision that changes is
// enumerated and explained.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PERMISSION_DOMAINS, SUB_PERMISSIONS, isSubPermissionPlanAvailable, tenantRoles } from './accessConfig';
import {
  decideSupervisorRefundApproval,
  decideTenantPermission,
  decideTenantSubPermission,
  type TenantDecisionInput,
} from './tenantAccessDecisions';
import type { EmployeeRole, PermissionLevel } from '../types';

// ---- the pre-P5 client algorithm (84fa74e9 AccessContext.tsx:278-322, :469-483), frozen as the oracle ----
const LEGACY_ORDER = ['none', 'view', 'create', 'edit', 'manage', 'approve', 'full'];
const legacyMeets = (a: string, r: string) => { const x = LEGACY_ORDER.indexOf(a); const y = LEGACY_ORDER.indexOf(r); return x >= 0 && y >= 0 && x >= y; };
// 84fa74e9 AccessContext.tsx resolvePermissionLevel, copied literally so the oracle shares no code with
// the module under test.
function legacyResolve(roleConfig: EmployeeRole, domain: string): string {
  const perms = roleConfig.permissions;
  if (Array.isArray(perms)) {
    if (perms.includes('all')) return 'full';
    if (perms.includes(domain)) return 'full';
    if (perms.includes(`${domain}_read`)) return 'view';
    return 'none';
  }
  const record = perms as Record<string, PermissionLevel>;
  if (Object.prototype.hasOwnProperty.call(record, '_grant') && record['_grant'] === 'full') return 'full';
  return Object.prototype.hasOwnProperty.call(record, domain) ? record[domain] : 'none';
}
const legacyCheckPermission = (role: EmployeeRole, d: string, req: string) =>
  PERMISSION_DOMAINS.some((x) => x.id === d) && legacyMeets(legacyResolve(role, d), req);
// A store session always carries its tenant (AccessContext sets it with the session), so every state is
// decided for the shipped plan; the pre-P5 plan gate ran first, before every shortcut.
const TENANT = { id: 'tenant-1', plan: 'growth' } as const;
function legacyCheckSub(role: EmployeeRole, id: string): boolean {
  const def = SUB_PERMISSIONS.find((s) => s.id === id)!;
  if (!isSubPermissionPlanAvailable(def, TENANT.plan, TENANT.id)) return false;
  const parent = legacyResolve(role, def.parentDomain);
  if (!legacyMeets(parent, def.minModuleLevel)) return false;
  if (role.subPermissions && Object.prototype.hasOwnProperty.call(role.subPermissions, id)) return role.subPermissions[id] === true;
  return legacyMeets(parent, def.defaultLevel);
}
function legacyRefundAuth(role: EmployeeRole): boolean {
  if (!legacyMeets(legacyResolve(role, 'refunds'), 'approve')) return false;
  return !(role.subPermissions && Object.prototype.hasOwnProperty.call(role.subPermissions, 'approve_refunds') && role.subPermissions.approve_refunds !== true);
}

// ---- the literal client requirements: every checkPermission('<domain>', '<level>') call in shipped src/ ----
const SRC = join(dirname(fileURLToPath(import.meta.url)), '..');
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...sourceFiles(p));
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}
const CP: [string, string][] = (() => {
  const seen = new Set<string>();
  for (const f of sourceFiles(SRC)) {
    for (const m of readFileSync(f, 'utf8').matchAll(/checkPermission\('([a-z_]+)',\s*'([a-z]+)'\)/g)) seen.add(`${m[1]}:${m[2]}`);
  }
  return [...seen].sort().map((k) => k.split(':') as [string, string]);
})();

// ---- the state groups (built-in non-owner roles as the owner can edit them; custom roles) ----
type Row = { group: string; role: string; domain: string; held: string; state: string; check: string; money: boolean; before: boolean; after: boolean };
const rows: Row[] = [];
const MONEY = new Set(['approve_refunds', 'approve_return']);
const inputFor = (role: EmployeeRole): TenantDecisionInput => ({ hasSession: true, effectiveRole: role.id, roles: [role], tenant: TENANT });
function evalRole(group: string, role: EmployeeRole, domain: string, held: string, state: string) {
  const inp = inputFor(role);
  for (const [d, r] of CP) if (d === domain) {
    rows.push({ group, role: role.id, domain, held, state, check: `checkPermission(${d},${r})`, money: false,
      before: legacyCheckPermission(role, d, r), after: decideTenantPermission(inp, d, r as PermissionLevel) });
  }
  for (const s of SUB_PERMISSIONS) if (s.parentDomain === domain) {
    rows.push({ group, role: role.id, domain, held, state, check: `checkSubPermission(${s.id})`, money: MONEY.has(s.id),
      before: legacyCheckSub(role, s.id), after: decideTenantSubPermission(inp, s.id) });
  }
  // The POS supervisor select offers Store Owner and Manager only (POS.tsx supervisor modal).
  if (domain === 'refunds' && (role.id === 'manager' || role.id === 'store_owner')) {
    rows.push({ group, role: role.id, domain, held, state, check: 'requestSupervisorRefundAuth', money: true,
      before: legacyRefundAuth(role), after: decideSupervisorRefundApproval({ ...inp, roles: [role] }, role.id) });
  }
}
const NON_OWNER = tenantRoles.filter((r) => r.id !== 'store_owner');
for (const base of NON_OWNER) for (const D of PERMISSION_DOMAINS) evalRole('S0-defaults', base, D.id, legacyResolve(base, D.id), 'shipped');
for (const base of NON_OWNER) for (const D of PERMISSION_DOMAINS) for (const L of D.levels) {
  const role: EmployeeRole = { ...base, permissions: { ...(base.permissions as Record<string, PermissionLevel>), [D.id]: L } };
  evalRole('S1-edit', role, D.id, L, 'shipped');
  for (const s of SUB_PERMISSIONS.filter((x) => x.parentDomain === D.id)) for (const v of [true, false]) {
    const toggled: EmployeeRole = { ...role, subPermissions: { ...(base.subPermissions ?? {}), [s.id]: v } };
    rows.push({ group: 'S1-toggle', role: role.id, domain: D.id, held: L, state: `${s.id}=${v}`, check: `checkSubPermission(${s.id})`,
      money: MONEY.has(s.id), before: legacyCheckSub(toggled, s.id), after: decideTenantSubPermission(inputFor(toggled), s.id) });
  }
}
for (const D of PERMISSION_DOMAINS) for (const L of D.levels) {
  evalRole('S2-custom', { id: 'custom_role', name: 'Custom', permissions: { [D.id]: L }, subPermissions: {} }, D.id, L, 'absent');
}
const count = (g: string) => rows.filter((r) => r.group === g).length;
const changed = rows.filter((r) => r.before !== r.after);

test('C1. the four reachable-state groups regenerate from current code to the P4 inventory', () => {
  // The literal call sites the counts rest on (derived from src/, not listed by hand).
  assert.deepEqual(CP.map(([d, l]) => `${d}:${l}`), [
    'inventory:create', 'inventory:edit', 'inventory:manage', 'inventory:view', 'invoices:create', 'invoices:edit',
    'repairs:create', 'repairs:edit', 'repairs:manage', 'shipping:view', 'suggestive_sales:manage', 'warranties:create',
  ]);
  assert.deepEqual(
    { defaults: count('S0-defaults'), editedArea: count('S1-edit'), subToggles: count('S1-toggle'), custom: count('S2-custom') },
    { defaults: 259, editedArea: 1517, subToggles: 2598, custom: 504 },
  );
});

test('C2. no non-money decision changes in any reachable state — the store family keeps every answer', () => {
  assert.deepEqual(changed.filter((r) => !r.money).map((r) => `${r.group} ${r.role} ${r.domain}=${r.held} ${r.state} ${r.check}`), []);
  // The P4 witnesses: an owner-edited Approve still satisfies Manage in the store family.
  const inv = rows.filter((r) => r.group === 'S1-edit' && r.check === 'checkPermission(inventory,manage)' && r.held === 'approve');
  assert.ok(inv.length === 3 && inv.every((r) => r.after), 'inventory Approve satisfies inventory Manage for every built-in role');
  const ret = rows.filter((r) => r.group === 'S1-edit' && r.role === 'manager' && r.held === 'approve'
    && (r.check === 'checkSubPermission(approve_return)' || r.check === 'checkSubPermission(complete_return_disposition)'));
  assert.ok(ret.length === 2 && ret.every((r) => r.after), 'manager Returns Approve keeps approve_return and complete disposition');
});

test('C4. beyond the four groups: data-driven Create checks and the Store Owner keep every answer', () => {
  // DashboardOverview quick actions and hasPermission() pass a domain with the fixed level 'create'.
  const diffs: string[] = [];
  for (const D of PERMISSION_DOMAINS) for (const base of NON_OWNER) for (const L of [null, ...D.levels]) {
    const role: EmployeeRole = L === null ? base : { ...base, permissions: { ...(base.permissions as Record<string, PermissionLevel>), [D.id]: L } };
    if (legacyCheckPermission(role, D.id, 'create') !== decideTenantPermission(inputFor(role), D.id, 'create')) diffs.push(`${role.id} ${D.id}=${L} create`);
  }
  // The Store Owner: the pre-P5 owner shortcut allowed every level on every domain and, after the plan
  // gate, every sub-permission. Only the retired level form changes, and no call site uses it.
  const owner = tenantRoles.find((r) => r.id === 'store_owner')!;
  for (const D of PERMISSION_DOMAINS) for (const lvl of LEGACY_ORDER) {
    const after = decideTenantPermission(inputFor(owner), D.id, lvl as PermissionLevel);
    if (after !== !(D.id === 'refunds' && lvl === 'approve')) diffs.push(`store_owner ${D.id}:${lvl}`);
  }
  for (const s of SUB_PERMISSIONS) {
    if (decideTenantSubPermission(inputFor(owner), s.id) !== isSubPermissionPlanAvailable(s, TENANT.plan, TENANT.id)) diffs.push(`store_owner ${s.id}`);
  }
  assert.deepEqual(diffs, []);
  assert.ok(!CP.some(([d, l]) => d === 'refunds' && l === 'approve'), 'no call site uses the retired form');
});

test('C3. every money decision that changes is enumerated, and each is an owner decision', () => {
  const got = changed.map((r) => `${r.group} ${r.role} ${r.domain}=${r.held} ${r.check}: ${r.before ? 'allow' : 'deny'} -> ${r.after ? 'allow' : 'deny'}`).sort();
  assert.deepEqual(got, [
    // Refund approval converged on approve_refunds (owner decision Q4): the supervisor check's module
    // minimum is now the catalog's Refunds View, with the explicit grant, so a manager whose Refunds level
    // was lowered below Approve but whose Approve Refunds grant stands can authorize — as the matrix shows.
    'S1-edit manager refunds=create requestSupervisorRefundAuth: deny -> allow',
    'S1-edit manager refunds=view requestSupervisorRefundAuth: deny -> allow',
    // Custom roles start without money grants (owner decision 2): a level never grants one.
    'S2-custom custom_role refunds=approve checkSubPermission(approve_refunds): allow -> deny',
    'S2-custom custom_role refunds=full checkSubPermission(approve_refunds): allow -> deny',
    'S2-custom custom_role returns=approve checkSubPermission(approve_return): allow -> deny',
    'S2-custom custom_role returns=full checkSubPermission(approve_return): allow -> deny',
  ]);
  // Built-in roles at their defaults and every owner toggle of a built-in role: no change at all.
  assert.equal(changed.filter((r) => r.group === 'S0-defaults' || r.group === 'S1-toggle').length, 0);
});
