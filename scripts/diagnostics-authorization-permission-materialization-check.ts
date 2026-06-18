// Phase 1.6 M1 — STATIC (offline) check for resolver PERMISSION MATERIALIZATION.
//
// PURE / OFFLINE: no DB, no network, no Supabase, no Firebase, no env secrets, no
// SQL, no migration, no audit write, no Supabase MCP, no runtime endpoint call.
// It feeds MOCKED durable-row snapshots to the REAL resolveAuthorization() and
// asserts the M1 materialization rules end-to-end (deny → null preserved).
//
// Run:  npx tsx scripts/diagnostics-authorization-permission-materialization-check.ts

import {
  resolveAuthorization,
  type AuthorizationResolverInput,
  type ResolverIdentity,
  type AppUserSnapshot,
  type MembershipSnapshot,
  type EntitlementSnapshot,
} from '../server/platform-identity/authorizationResolver';
import {
  KNOWN_TENANT_ENTITLEMENT_KEYS,
  TENANT_PERMISSION_DOMAINS,
  PLATFORM_FEATURE_KEYS,
} from '../server/platform-identity/permissionCatalog';

interface Result { name: string; pass: boolean; detail: string }
const results: Result[] = [];
function check(name: string, pass: boolean, detail = ''): void {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

// ---- mocked snapshot builders ----------------------------------------------

const UID = 'user-internal-1';
const TID = 'tenant-1';

const identity = (): ResolverIdentity => ({
  internalUserId: UID, authProvider: 'supabase', authProviderUid: 'sub-abc', email: 'tester@dev.local',
});
const appUser = (status: AppUserSnapshot['status'] = 'active'): AppUserSnapshot => ({
  internal_user_id: UID, status, display_name: 'Tester',
});
const membership = (over: Partial<MembershipSnapshot>): MembershipSnapshot => ({
  membership_id: 'm-1', internal_user_id: UID, tenant_id: null, store_id: null,
  scope_type: 'platform', role_id: 'system_owner', status: 'active', ...over,
});
function base(over: Partial<AuthorizationResolverInput>): AuthorizationResolverInput {
  return {
    identity: identity(), appUser: appUser(), memberships: [], tenant: null, store: null,
    entitlements: [], requestedContext: { scopeType: 'platform' }, ...over,
  };
}

// Full-plan entitlement rows = every KNOWN catalog feature key enabled.
const fullEntitlements = (keys?: string[]): EntitlementSnapshot[] =>
  (keys ?? [...KNOWN_TENANT_ENTITLEMENT_KEYS]).map((feature_key) => ({
    tenant_id: TID, feature_key, enabled: true, source: 'plan',
  }));

function tenant(roleId: string, opts: {
  userStatus?: AppUserSnapshot['status'];
  tenantStatus?: 'active' | 'overdue' | 'suspended';
  entitlements?: EntitlementSnapshot[];
} = {}): AuthorizationResolverInput {
  return base({
    appUser: appUser(opts.userStatus ?? 'active'),
    requestedContext: { scopeType: 'tenant', tenantId: TID },
    tenant: { tenant_id: TID, plan_key: 'advanced', status: opts.tenantStatus ?? 'active' },
    memberships: [membership({ scope_type: 'tenant', tenant_id: TID, role_id: roleId, status: 'active' })],
    entitlements: opts.entitlements ?? fullEntitlements(),
  });
}

function platform(durableRoleId: string, userStatus: AppUserSnapshot['status'] = 'active'): AuthorizationResolverInput {
  return base({
    appUser: appUser(userStatus),
    requestedContext: { scopeType: 'platform' },
    memberships: [membership({ scope_type: 'platform', role_id: durableRoleId, status: 'active' })],
  });
}

// =============================================================================
// 1) Deny still returns null; 2) allow fills non-empty maps; empty never = full
// =============================================================================

{
  const r = resolveAuthorization(base({ appUser: null }));
  check('1a deny (no app_user) → authorization null', r.decision === 'deny' && r.authorization === null, r.reasonCode);
}
{
  const r = resolveAuthorization(base({ appUser: appUser('suspended'), memberships: [membership({})] }));
  check('1b deny (suspended) → authorization null', r.decision === 'deny' && r.authorization === null, r.reasonCode);
}
{
  const r = resolveAuthorization(tenant('store_owner'));
  const a = r.authorization!;
  const permKeys = Object.keys(a.permissions).length;
  const subKeys = Object.keys(a.subPermissions).length;
  check('2a allow fills NON-EMPTY permissions + subPermissions', r.decision === 'allow' && permKeys > 0 && subKeys > 0, `perm=${permKeys} sub=${subKeys}`);
  check('2b empty maps never produced on allow (never interpreted as full)', permKeys > 0 && subKeys > 0, 'non-empty');
}

// =============================================================================
// 3) store_owner → full within tenant ordering, capped by plan + status
// =============================================================================

{
  const a = resolveAuthorization(tenant('store_owner'))!.authorization!;
  const allFull = TENANT_PERMISSION_DOMAINS.every((d) => a.permissions[d] === 'full');
  const allSubsTrue = Object.values(a.subPermissions).every((v) => v === true);
  check('3a store_owner (full plan): every domain = full', allFull, JSON.stringify(a.permissions));
  check('3b store_owner (full plan): every sub-permission granted', allSubsTrue, `${Object.values(a.subPermissions).filter((v) => v).length}/${Object.keys(a.subPermissions).length}`);
}
{
  // Plan cap: drop 'shipping' entitlement entirely.
  const ent = fullEntitlements([...KNOWN_TENANT_ENTITLEMENT_KEYS].filter((k) => k !== 'shipping'));
  const a = resolveAuthorization(tenant('store_owner', { entitlements: ent }))!.authorization!;
  check('3c store_owner: plan-disabled domain capped to none (shipping)', a.permissions.shipping === 'none', String(a.permissions.shipping));
  check('3d store_owner: every shipping sub false when shipping plan-disabled', a.subPermissions.create_shipment === false && a.subPermissions.view_shipping_sla === false, `${a.subPermissions.create_shipment}/${a.subPermissions.view_shipping_sla}`);
  check('3e store_owner: non-shipping domain still full', a.permissions.inventory === 'full', String(a.permissions.inventory));
}
{
  // Status cap: read_only user.
  const a = resolveAuthorization(tenant('store_owner', { userStatus: 'read_only' }))!.authorization!;
  const allView = TENANT_PERMISSION_DOMAINS.every((d) => a.permissions[d] === 'view');
  check('3f store_owner read_only: every domain capped to view', allView, JSON.stringify(a.permissions));
  check('3g store_owner read_only: mutating sub forced false (adjust_stock)', a.subPermissions.adjust_stock === false, String(a.subPermissions.adjust_stock));
  check('3h store_owner read_only: read-safe sub preserved (view_shipping_sla)', a.subPermissions.view_shipping_sla === true, String(a.subPermissions.view_shipping_sla));
}

// =============================================================================
// 4) system_owner → full within PLATFORM ordering (unambiguous mapped path)
// =============================================================================

{
  // durable 'platform_owner' → contract 'system_owner' via the compat shim.
  const r = resolveAuthorization(platform('platform_owner'));
  const a = r.authorization!;
  const allFull = PLATFORM_FEATURE_KEYS.every((f) => a.permissions[f] === 'full');
  const allSubs = Object.values(a.subPermissions).every((v) => v === true);
  check('4a system_owner: roles.platformRoleId mapped', a.roles.platformRoleId === 'system_owner', String(a.roles.platformRoleId));
  check('4b system_owner: every platform feature = full', allFull, JSON.stringify(a.permissions));
  check('4c system_owner: every platform sub granted', allSubs, `${Object.values(a.subPermissions).filter((v) => v).length}/${Object.keys(a.subPermissions).length}`);
}

// =============================================================================
// 5) manager / 6) technician / 7) sales_staff match role defaults
// =============================================================================

{
  const a = resolveAuthorization(tenant('manager'))!.authorization!;
  const ok =
    a.permissions.refunds === 'approve' &&
    a.permissions.inventory === 'manage' &&
    a.permissions.employees === 'manage' &&
    a.permissions.dashboard === 'full' &&
    a.subPermissions.approve_refunds === true &&
    a.subPermissions.manage_employees === true &&
    a.subPermissions.assign_manager_role === false &&   // explicit false wins
    a.subPermissions.approve_requests === false;          // explicit false wins
  check('5 manager materialization matches role defaults', ok, `refunds=${a.permissions.refunds} approve_refunds=${a.subPermissions.approve_refunds} assign_manager_role=${a.subPermissions.assign_manager_role}`);
}
{
  const a = resolveAuthorization(tenant('technician'))!.authorization!;
  // Precedence proof: technician's role default explicitly grants adjust_stock &
  // manage_refurbishment, but both require parent inventory ≥ edit; technician
  // inventory is only 'create', so the parent-level gate SHADOWS the explicit
  // grant → false. create_inventory_items (minModuleLevel 'create') survives.
  const ok =
    a.permissions.repairs === 'manage' &&
    a.permissions.sales === 'none' &&
    a.permissions.employees === 'none' &&
    a.subPermissions.create_inventory_items === true &&
    a.subPermissions.adjust_stock === false &&
    a.subPermissions.manage_refurbishment === false &&
    a.subPermissions.manage_employees === false &&
    a.subPermissions.approve_refunds === false;
  check('6 technician materialization matches role defaults (parent-level gate shadows explicit adjust_stock)', ok, `repairs=${a.permissions.repairs} create_inv_items=${a.subPermissions.create_inventory_items} adjust_stock=${a.subPermissions.adjust_stock}`);
}
{
  const a = resolveAuthorization(tenant('sales_staff'))!.authorization!;
  const ok =
    a.permissions.sales === 'create' &&
    a.permissions.customers === 'create' &&
    a.permissions.refunds === 'none' &&
    a.permissions.suggestive_sales === 'view' &&
    a.subPermissions.process_refunds === false &&
    a.subPermissions.manage_employees === false;
  check('7 sales_staff materialization matches role defaults', ok, `sales=${a.permissions.sales} customers=${a.permissions.customers} process_refunds=${a.subPermissions.process_refunds}`);
}

// =============================================================================
// 8) Plan-disabled feature removes dependent capabilities (feature-level gate)
// =============================================================================

{
  // Drop only the shipping_providers FEATURE (shipping domain stays enabled).
  const ent = fullEntitlements([...KNOWN_TENANT_ENTITLEMENT_KEYS].filter((k) => k !== 'shipping_providers'));
  const a = resolveAuthorization(tenant('manager', { entitlements: ent }))!.authorization!;
  const providerSubsOff =
    a.subPermissions.configure_shipping_provider === false &&
    a.subPermissions.fetch_shipping_rates === false &&
    a.subPermissions.purchase_shipping_label === false &&
    a.subPermissions.purchase_batch_labels === false;
  const otherShippingOn = a.subPermissions.create_shipment === true; // shipping domain still enabled
  check('8a manager: shipping_providers-disabled removes provider sub-permissions', providerSubsOff, `cfg=${a.subPermissions.configure_shipping_provider}`);
  check('8b manager: independent shipping sub still granted (create_shipment)', otherShippingOn, String(a.subPermissions.create_shipment));
  check('8c manager: shipping domain itself still manage (feature gate ≠ domain gate)', a.permissions.shipping === 'manage', String(a.permissions.shipping));
}

// =============================================================================
// 9) Entitlements reduce only — never expand role grants (cap-only / monotonic)
// =============================================================================

{
  const full = resolveAuthorization(tenant('store_owner'))!.authorization!;
  const none = resolveAuthorization(tenant('store_owner', { entitlements: [] }))!.authorization!;
  // Removing entitlements may only turn capabilities OFF, never ON.
  const expandedSub = Object.keys(none.subPermissions).filter((k) => none.subPermissions[k] && !full.subPermissions[k]);
  check('9a fewer entitlements never enable a sub that full-plan denies', expandedSub.length === 0, expandedSub.slice(0, 5).join(','));
  // Core domains survive zero entitlements; gated domains are removed.
  check('9b zero entitlements: core domain survives (dashboard full)', none.permissions.dashboard === 'full', String(none.permissions.dashboard));
  check('9c zero entitlements: gated domain removed (shipping none)', none.permissions.shipping === 'none', String(none.permissions.shipping));
  check('9d zero entitlements: gated sub denied (configure_shipping_provider false)', none.subPermissions.configure_shipping_provider === false, String(none.subPermissions.configure_shipping_provider));
}

// =============================================================================
// 10) read_only / overdue caps write/manage/approve to view-or-false
// =============================================================================

{
  // overdue TENANT status (not user) must still cap.
  const a = resolveAuthorization(tenant('manager', { tenantStatus: 'overdue' }))!.authorization!;
  const noWriteLevels = TENANT_PERMISSION_DOMAINS.every((d) => a.permissions[d] === 'view' || a.permissions[d] === 'none');
  const writeSubsOff =
    a.subPermissions.manage_employees === false &&
    a.subPermissions.approve_refunds === false &&
    a.subPermissions.adjust_stock === false;
  check('10a overdue tenant: no domain exceeds view', noWriteLevels, JSON.stringify(a.permissions));
  check('10b overdue tenant: write/manage/approve subs forced false', writeSubsOff, `mng_emp=${a.subPermissions.manage_employees}`);
  check('10c overdue tenant: read-safe sub preserved (view_carrier_scorecards)', a.subPermissions.view_carrier_scorecards === true, String(a.subPermissions.view_carrier_scorecards));
}
{
  // Platform read_only capping.
  const a = resolveAuthorization(platform('platform_owner', 'read_only'))!.authorization!;
  const allView = PLATFORM_FEATURE_KEYS.every((f) => a.permissions[f] === 'view');
  check('10d platform read_only: every feature capped to view', allView, JSON.stringify(a.permissions));
  check('10e platform read_only: sensitive/mutating sub off (manage_platform_roles)', a.subPermissions.manage_platform_roles === false, String(a.subPermissions.manage_platform_roles));
  check('10f platform read_only: view sub preserved (view_command_center)', a.subPermissions.view_command_center === true, String(a.subPermissions.view_command_center));
}

// =============================================================================
// 11) Platform unmapped/ambiguous roles fail closed (deny → null)
// =============================================================================

{
  const r = resolveAuthorization(platform('platform_admin')); // ambiguous, intentionally unmapped
  check('11a ambiguous durable platform_admin → deny + null', r.decision === 'deny' && r.authorization === null, r.reasonCode);
}
{
  const r = resolveAuthorization(platform('platform_readonly')); // no contract equivalent
  check('11b durable platform_readonly → deny + null', r.decision === 'deny' && r.authorization === null, r.reasonCode);
}
{
  const r = resolveAuthorization(platform('zzz_unknown_role')); // not a durable id, not a contract id, no compat entry
  check('11c unknown platform role string → deny + null (fail closed)', r.decision === 'deny' && r.authorization === null, r.reasonCode);
}

// =============================================================================
// 12) Mapped partial platform roles materialize the expected subset
// =============================================================================

{
  const a = resolveAuthorization(platform('platform_support'))!.authorization!; // → support_admin
  const ok =
    a.roles.platformRoleId === 'support_admin' &&
    a.permissions.support_tools === 'full' &&
    a.permissions.audit_security === 'view' &&
    a.subPermissions.view_support_tools === true &&
    a.subPermissions.export_audit_csv === false; // audit 'view' < approve threshold
  check('12a support_admin: support full, audit view-only, export denied', ok, `support=${a.permissions.support_tools} export_csv=${a.subPermissions.export_audit_csv}`);
}
{
  const a = resolveAuthorization(platform('platform_ops'))!.authorization!; // → operations_admin
  const ok =
    a.roles.platformRoleId === 'operations_admin' &&
    a.permissions.tenant_management === 'full' &&
    a.permissions.provisioning === 'full' &&
    a.subPermissions.change_tenant_status === true &&
    a.subPermissions.run_provisioning === true &&
    a.subPermissions.manage_platform_roles === false; // team_management 'view' < full
  check('12b operations_admin: tenant/provisioning full, no manage_platform_roles', ok, `tenants=${a.permissions.tenant_management} mpr=${a.subPermissions.manage_platform_roles}`);
}

// =============================================================================
// 13) No forbidden token/secret fields appear in any materialized output
// =============================================================================

{
  const samples = [
    resolveAuthorization(tenant('store_owner')),
    resolveAuthorization(tenant('manager')),
    resolveAuthorization(platform('platform_owner')),
  ];
  const json = JSON.stringify(samples);
  const forbidden = ['accessToken', 'refreshToken', 'rawJwt', 'jwtPayload', 'jwks', 'serviceRoleKey', 'databaseUrl', 'connectionString', 'password'];
  const leaked = forbidden.filter((f) => json.includes(f));
  check('13 no forbidden token/secret fields in materialized output', leaked.length === 0, leaked.join(','));
}

// =============================================================================
// Summary
// =============================================================================

const failed = results.filter((r) => !r.pass);
console.log(`\n[authorization-permission-materialization-check] ${results.length - failed.length}/${results.length} checks passed.`);
if (failed.length) process.exitCode = 1;
