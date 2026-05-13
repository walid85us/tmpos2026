// =============================================================================
// Phase 1.1.3A correction — Platform Permissions catalog & helpers.
//
// This module is the SINGLE source of truth for platform-side ("System Owner /
// platform staff") permissions. It is intentionally additive on top of the
// existing access model in `src/context/accessConfig.ts`:
//
//   - It reuses the same `PermissionLevel` 7-level hierarchy
//     (none / view / create / edit / approve / manage / full).
//   - It does NOT replace the existing `PERMISSION_HIERARCHY` ordering;
//     `meetsPermissionLevel(actual, required)` still works for the rest of
//     the app exactly as before.
//   - It does NOT replace or alter the Store Permissions Matrix or the
//     tenant-side `SUB_PERMISSIONS` catalog (those govern store employees).
//   - It does NOT introduce server-side RBAC or PIM/PAM. All gating here is
//     UI-enforced — see the truthful-limitations banner shown in the matrix.
//
// Spec semantics — "Approve, Manage, or Full Access" (PART E of the spec):
// approval-sensitive platform actions accept any of those three levels. To
// avoid changing global hierarchy semantics this module ships its own
// `platformPermissionMeets(actual, threshold)` that maps the platform spec
// onto the existing levels:
//
//   threshold='view'    → view, create, edit, approve, manage, full
//   threshold='create'  → create, edit, approve, manage, full
//   threshold='edit'    → edit, approve, manage, full
//   threshold='approve' → approve, manage, full         (spec-aligned)
//   threshold='manage'  → manage, full
//   threshold='full'    → full
//
// Override storage: per-role overrides written by the Global Permissions
// Matrix UI live in `sessionStorage.platform_permissions_v1` as
// `{ [roleId]: { features: {[featureKey]: PermissionLevel}, subs: {[subKey]: PermissionLevel} } }`.
// System Owner is locked at Full Access and cannot be overridden.
// =============================================================================

import type { PermissionLevel } from '../types';
import type { Role } from '../context/accessConfig';

export const PLATFORM_PERMISSION_LEVELS: PermissionLevel[] = [
  'none', 'view', 'create', 'edit', 'approve', 'manage', 'full',
];

export const PLATFORM_PERMISSION_LEVEL_LABEL: Record<PermissionLevel, string> = {
  none: 'None',
  view: 'View Only',
  create: 'Create',
  edit: 'Edit',
  approve: 'Approve',
  manage: 'Manage',
  full: 'Full Access',
};

const LEVEL_RANK: Record<PermissionLevel, number> = {
  none: 0,
  view: 1,
  create: 2,
  edit: 3,
  approve: 4,
  manage: 5,
  full: 6,
};

/**
 * Spec-aligned threshold check for platform permissions.
 * Approve / Manage / Full Access all satisfy an Approve threshold.
 * Manage / Full Access satisfy a Manage threshold.
 * Full Access satisfies all thresholds.
 *
 * Note: this is intentionally separate from `meetsPermissionLevel()` in
 * accessConfig.ts (which uses a different array ordering and is consumed
 * by the tenant / store side of the app). Do not unify them.
 */
export function platformPermissionMeets(
  actual: PermissionLevel,
  threshold: PermissionLevel
): boolean {
  if (threshold === 'none') return true;
  return LEVEL_RANK[actual] >= LEVEL_RANK[threshold];
}

// ---------------------------------------------------------------------------
// Feature catalog — 11 platform feature groups + their sub-permissions.
// ---------------------------------------------------------------------------

export type PlatformFeatureKey =
  | 'command_center'
  | 'audit_security'
  | 'support_tools'
  | 'tenant_management'
  | 'billing_subscriptions'
  | 'platform_settings'
  | 'domains'
  | 'team_management'
  | 'provisioning'
  | 'feature_matrix'
  | 'addon_governance';

export interface PlatformSubPermissionDef {
  /** Stable string id used by callers like `hasPlatformPermission(role, 'export_audit_csv')`. */
  id: string;
  /** Human-readable label used in the matrix UI. */
  label: string;
  /** Short tooltip / description used in the matrix UI and helper text. */
  description: string;
  /** Minimum level required for this sub-permission to be considered "enabled". */
  threshold: PermissionLevel;
  /** True if this is an approval-sensitive action (delete / export sensitive data / change_level / etc). */
  sensitive?: boolean;
}

export interface PlatformFeatureGroupDef {
  key: PlatformFeatureKey;
  label: string;
  description: string;
  subPermissions: PlatformSubPermissionDef[];
}

export const PLATFORM_FEATURE_GROUPS: PlatformFeatureGroupDef[] = [
  {
    key: 'command_center',
    label: 'Command Center',
    description: 'Platform-wide pulse, NBA recommendations, and Tenant 360 quick access.',
    subPermissions: [
      { id: 'view_command_center', label: 'View Command Center', description: 'Open the Command Center page and see pulse cells.', threshold: 'view' },
      { id: 'view_operational_pulse', label: 'View Operational Pulse', description: 'See the Operational Pulse strip with live metrics.', threshold: 'view' },
      { id: 'view_needs_attention', label: 'View Needs Attention', description: 'See the Needs Attention priority queue.', threshold: 'view' },
      { id: 'view_tenant_360', label: 'Open Tenant 360 Drawer', description: 'Click through to a tenant\'s Tenant 360 read-only summary.', threshold: 'view' },
      { id: 'use_command_quick_actions', label: 'Use Quick Actions', description: 'Click Command Center quick action buttons (navigation only).', threshold: 'view' },
      { id: 'view_next_best_actions', label: 'View Next Best Actions', description: 'See Next Best Action recommendations list.', threshold: 'view' },
      { id: 'act_on_nba_recommendations', label: 'Act on NBA Recommendations', description: 'Click through NBA actions to take operational steps.', threshold: 'edit' },
    ],
  },
  {
    key: 'audit_security',
    label: 'Audit & Security',
    description: 'Audit log viewer, security notes, and audit-driven case creation.',
    subPermissions: [
      { id: 'view_audit_security', label: 'View Audit & Security', description: 'Open the Audit & Security page and read the log.', threshold: 'view' },
      { id: 'view_audit_logs', label: 'View Audit Logs', description: 'Read the audit log table content. None hides all audit rows.', threshold: 'view' },
      { id: 'view_actor_profile', label: 'View Actor Profile', description: 'Open actor / related-events tabs in the audit drawer.', threshold: 'view' },
      { id: 'export_audit_csv', label: 'Export Audit CSV', description: 'Export the currently visible audit rows as CSV.', threshold: 'approve', sensitive: true },
      { id: 'add_security_note', label: 'Add Security Note', description: 'Add a security / posture / incident note (per-session store).', threshold: 'create' },
      { id: 'delete_security_note', label: 'Delete Security Note', description: 'Permanently delete a security note (writes a `security_note_deleted` audit row).', threshold: 'approve', sensitive: true },
      { id: 'create_support_case_from_audit', label: 'Create Case from Audit Event', description: 'Open the "Create Support Case from Event" modal in the audit drawer.', threshold: 'create' },
      { id: 'view_restricted_audit_details', label: 'View Restricted Audit Details', description: 'Access restricted/sensitive detail in the audit drawer.', threshold: 'approve' },
      { id: 'view_escalation_lifecycle_audit', label: 'View Escalation Lifecycle Audit', description: 'Access escalation lifecycle lens/detail in audit context.', threshold: 'view' },
    ],
  },
  {
    key: 'support_tools',
    label: 'Support Tools',
    description: 'Support cases, escalation lifecycle, tenant impersonation links.',
    subPermissions: [
      { id: 'view_support_tools', label: 'View Support Tools', description: 'Open the Support Tools page and read cases.', threshold: 'view' },
      { id: 'view_escalation_history', label: 'View Escalation History', description: 'Read the escalation history timeline on a case.', threshold: 'view' },
      { id: 'create_support_case', label: 'Create Support Case', description: 'Create a new support case.', threshold: 'create' },
      { id: 'change_support_status', label: 'Change Case Status', description: 'Move a case between Open / In Progress / Waiting Customer / Resolved.', threshold: 'edit' },
      { id: 'change_support_severity', label: 'Change Case Severity', description: 'Change the severity of a support case.', threshold: 'edit' },
      { id: 'assign_support_case', label: 'Assign Support Case', description: 'Assign a case owner / team.', threshold: 'edit' },
      { id: 'close_support_case', label: 'Close Support Case', description: 'Close a case (without an active escalation).', threshold: 'manage', sensitive: true },
      { id: 'escalate_assigned_case', label: 'Escalate Owned Case', description: 'Escalate a case the current operator owns or is assigned.', threshold: 'edit' },
      { id: 'escalate_any_case', label: 'Escalate Any Case', description: 'Escalate any case across the platform.', threshold: 'manage' },
      { id: 'acknowledge_escalation', label: 'Acknowledge Escalation', description: 'Acknowledge an escalation (own or any).', threshold: 'edit' },
      { id: 'assign_escalation_owner_team', label: 'Assign Escalation Owner / Team', description: 'Assign or reassign escalation ownership.', threshold: 'manage', sensitive: true },
      { id: 'change_escalation_level', label: 'Change Escalation Level', description: 'Promote / demote escalation level (L1 / L2 / L3 / Manager / Security / Critical).', threshold: 'approve', sensitive: true },
      { id: 'deescalate_support_case', label: 'De-escalate Case', description: 'De-escalate an acknowledged or in-review escalation.', threshold: 'edit' },
      { id: 'resolve_escalation', label: 'Resolve Escalation', description: 'Resolve an active escalation (writes paired audit row).', threshold: 'approve', sensitive: true },
      { id: 'close_with_active_escalation', label: 'Close Case with Active Escalation', description: 'Override-close a case that still has an active escalation.', threshold: 'manage', sensitive: true },
      { id: 'view_support_sla', label: 'View Support SLA', description: 'See SLA timer pills, deadlines, and SLA microcopy on cases.', threshold: 'view' },
      { id: 'view_support_tenant_health', label: 'View Tenant Health (Support)', description: 'See the Tenant Health mini-card on the support case drawer.', threshold: 'view' },
      { id: 'view_support_related_entities', label: 'View Related Entities (Support)', description: 'See the Related Entities panel on the support case drawer (source event / audits / domains).', threshold: 'view' },
      { id: 'add_internal_support_note', label: 'Add Internal Support Note', description: 'Append an internal note to the case timeline.', threshold: 'create' },
      { id: 'use_support_macro', label: 'Use Support Macro', description: 'Insert a macro template into the note composer.', threshold: 'create' },
      { id: 'manage_support_macros', label: 'Manage Support Macros', description: 'Create, edit, or delete shared support macro templates.', threshold: 'manage', sensitive: true },
      { id: 'edit_support_case', label: 'Edit Support Case', description: 'Edit the case subject, description, or other case fields.', threshold: 'edit' },
      { id: 'reopen_support_case', label: 'Reopen Support Case', description: 'Reopen a previously closed support case.', threshold: 'edit' },
    ],
  },
  {
    key: 'tenant_management',
    label: 'Tenant Management',
    description: 'Tenant directory, profile, status, and lifecycle.',
    subPermissions: [
      { id: 'view_tenants', label: 'View Tenants', description: 'Open the tenant directory and tenant detail.', threshold: 'view' },
      { id: 'edit_tenant_profile', label: 'Edit Tenant Profile', description: 'Edit tenant name, contacts, etc.', threshold: 'edit' },
      { id: 'change_tenant_status', label: 'Change Tenant Status', description: 'Suspend / reactivate / mark read-only.', threshold: 'manage', sensitive: true },
    ],
  },
  {
    key: 'billing_subscriptions',
    label: 'Billing & Subscriptions',
    description: 'Plans, subscriptions, invoices, dunning, refunds.',
    subPermissions: [
      { id: 'view_billing', label: 'View Billing', description: 'Read billing data, invoices, and dunning queue.', threshold: 'view' },
      { id: 'edit_subscriptions', label: 'Edit Subscriptions', description: 'Change a tenant\'s plan or billing cycle.', threshold: 'edit' },
      { id: 'approve_billing_actions', label: 'Approve Billing Actions', description: 'Approve refunds, credits, or write-offs.', threshold: 'approve', sensitive: true },
    ],
  },
  {
    key: 'platform_settings',
    label: 'Platform Settings',
    description: 'Branding, regional, feature flags, system toggles.',
    subPermissions: [
      { id: 'view_platform_settings', label: 'View Platform Settings', description: 'Open the platform settings page.', threshold: 'view' },
      { id: 'edit_platform_settings', label: 'Edit Platform Settings', description: 'Save changes to platform-wide configuration.', threshold: 'manage', sensitive: true },
    ],
  },
  {
    key: 'domains',
    label: 'Domains',
    description: 'Custom domains, subdomains, DNS, SSL.',
    subPermissions: [
      { id: 'view_domains', label: 'View Domains', description: 'Open the domains directory.', threshold: 'view' },
      { id: 'manage_domain_lifecycle', label: 'Manage Domain Lifecycle', description: 'Verify, provision, retire domains.', threshold: 'manage', sensitive: true },
    ],
  },
  {
    key: 'team_management',
    label: 'Team Management',
    description: 'Platform team directory, platform roles, Global Permissions Matrix.',
    subPermissions: [
      { id: 'view_team', label: 'View Team', description: 'Open the team directory and roles list.', threshold: 'view' },
      { id: 'manage_team_members', label: 'Manage Team Members', description: 'Invite / suspend / disable platform team members.', threshold: 'manage', sensitive: true },
      { id: 'manage_platform_roles', label: 'Manage Platform Roles', description: 'Create / edit platform roles and the Global Permissions Matrix.', threshold: 'full', sensitive: true },
    ],
  },
  {
    key: 'provisioning',
    label: 'Provisioning',
    description: 'New tenant provisioning, environment seeding.',
    subPermissions: [
      { id: 'view_provisioning', label: 'View Provisioning', description: 'Open the provisioning queue.', threshold: 'view' },
      { id: 'run_provisioning', label: 'Run Provisioning', description: 'Trigger a provisioning step or seed run.', threshold: 'manage', sensitive: true },
    ],
  },
  {
    key: 'feature_matrix',
    label: 'Feature Matrix / Plans',
    description: 'Plan catalog and feature-to-plan matrix.',
    subPermissions: [
      { id: 'view_feature_matrix', label: 'View Feature Matrix', description: 'Read the plan / feature matrix.', threshold: 'view' },
      { id: 'create_plan', label: 'Create Plan', description: 'Create a new subscription plan.', threshold: 'create' },
      { id: 'edit_plan', label: 'Edit Plan', description: 'Edit an existing subscription plan.', threshold: 'edit' },
      { id: 'archive_plan', label: 'Archive Plan', description: 'Archive a subscription plan.', threshold: 'manage', sensitive: true },
      { id: 'edit_feature_matrix', label: 'Edit Feature Matrix', description: 'Change plan / feature mappings.', threshold: 'manage', sensitive: true },
    ],
  },
  {
    key: 'addon_governance',
    label: 'Commercial Controls / Add-on Governance',
    description: 'Add-on catalog, commercial overrides, paid-add-on controls.',
    subPermissions: [
      { id: 'view_addon_governance', label: 'View Add-on Governance', description: 'Read the add-on catalog and overrides.', threshold: 'view' },
      { id: 'create_addon', label: 'Create Add-on', description: 'Create a new add-on in the catalog.', threshold: 'create' },
      { id: 'edit_addon', label: 'Edit Add-on', description: 'Edit an existing add-on.', threshold: 'edit' },
      { id: 'archive_delete_addon', label: 'Archive / Delete Add-on', description: 'Archive or delete an add-on from the catalog.', threshold: 'manage', sensitive: true },
      { id: 'manage_addon_compatible_plans', label: 'Manage Compatible Plans', description: 'Change which plans an add-on is compatible with.', threshold: 'edit' },
      { id: 'manage_addon_readiness', label: 'Manage Add-on Readiness', description: 'Update add-on implementation readiness status and checklist.', threshold: 'edit' },
      { id: 'generate_addon_implementation_brief', label: 'Generate Implementation Brief', description: 'Generate an implementation brief document for an add-on.', threshold: 'view' },
      { id: 'grant_trial', label: 'Grant Trial', description: 'Grant a trial override for a tenant add-on.', threshold: 'approve', sensitive: true },
      { id: 'grant_paid_override', label: 'Grant Paid Override', description: 'Grant a paid override for a tenant add-on.', threshold: 'approve', sensitive: true },
      { id: 'revoke_addon_override', label: 'Revoke Override', description: 'Revoke an existing trial or paid override.', threshold: 'approve', sensitive: true },
      { id: 'edit_addon_overrides', label: 'Edit Add-on Overrides', description: 'Grant or revoke commercial overrides for tenants.', threshold: 'approve', sensitive: true },
    ],
  },
];

const FEATURE_BY_KEY: Map<PlatformFeatureKey, PlatformFeatureGroupDef> = new Map(
  PLATFORM_FEATURE_GROUPS.map(g => [g.key, g])
);

// Pre-QA correction: legacy sub-permission key aliases. Older callsites
// may still reference the previous key; the lookup resolves the alias to
// the canonical sub-permission so existing code keeps working.
export const PLATFORM_SUB_PERMISSION_ALIASES: Record<string, string> = {
  view_nba_recommendations: 'view_next_best_actions',
};

const SUB_LOOKUP: Map<string, { feature: PlatformFeatureKey; def: PlatformSubPermissionDef }> = (() => {
  const m = new Map<string, { feature: PlatformFeatureKey; def: PlatformSubPermissionDef }>();
  for (const g of PLATFORM_FEATURE_GROUPS) {
    for (const sp of g.subPermissions) m.set(sp.id, { feature: g.key, def: sp });
  }
  for (const [alias, canonical] of Object.entries(PLATFORM_SUB_PERMISSION_ALIASES)) {
    const target = m.get(canonical);
    if (target) m.set(alias, target);
  }
  return m;
})();

export function getPlatformFeatureGroup(key: PlatformFeatureKey): PlatformFeatureGroupDef | null {
  return FEATURE_BY_KEY.get(key) || null;
}

export function findSubPermissionDef(
  subKey: string
): { feature: PlatformFeatureKey; def: PlatformSubPermissionDef } | null {
  return SUB_LOOKUP.get(subKey) || null;
}

// ---------------------------------------------------------------------------
// Per-role default feature levels (spec PART D).
// Tenant roles intentionally get all `none` — they have no platform access.
// System Owner is hardcoded to `full` and is never overridable.
// ---------------------------------------------------------------------------

type FeatureLevels = Record<PlatformFeatureKey, PermissionLevel>;

const ALL_NONE: FeatureLevels = {
  command_center: 'none',
  audit_security: 'none',
  support_tools: 'none',
  tenant_management: 'none',
  billing_subscriptions: 'none',
  platform_settings: 'none',
  domains: 'none',
  team_management: 'none',
  provisioning: 'none',
  feature_matrix: 'none',
  addon_governance: 'none',
};

const ALL_FULL: FeatureLevels = {
  command_center: 'full',
  audit_security: 'full',
  support_tools: 'full',
  tenant_management: 'full',
  billing_subscriptions: 'full',
  platform_settings: 'full',
  domains: 'full',
  team_management: 'full',
  provisioning: 'full',
  feature_matrix: 'full',
  addon_governance: 'full',
};

export const DEFAULT_PLATFORM_FEATURE_LEVELS: Record<Role, FeatureLevels> = {
  system_owner: { ...ALL_FULL },

  support_admin: {
    command_center: 'manage',
    audit_security: 'view',
    support_tools: 'full',
    tenant_management: 'edit',
    billing_subscriptions: 'view',
    platform_settings: 'view',
    domains: 'view',
    team_management: 'view',
    provisioning: 'view',
    feature_matrix: 'view',
    addon_governance: 'view',
  },

  billing_admin: {
    command_center: 'view',
    audit_security: 'view',
    support_tools: 'view',
    tenant_management: 'view',
    billing_subscriptions: 'full',
    platform_settings: 'view',
    domains: 'none',
    team_management: 'view',
    provisioning: 'none',
    feature_matrix: 'manage',
    addon_governance: 'manage',
  },

  operations_admin: {
    command_center: 'manage',
    audit_security: 'view',
    support_tools: 'manage',
    tenant_management: 'full',
    billing_subscriptions: 'view',
    platform_settings: 'edit',
    domains: 'full',
    team_management: 'view',
    provisioning: 'full',
    feature_matrix: 'manage',
    addon_governance: 'edit',
  },

  security_admin: {
    command_center: 'manage',
    audit_security: 'full',
    support_tools: 'approve',
    tenant_management: 'view',
    billing_subscriptions: 'view',
    platform_settings: 'manage',
    domains: 'view',
    team_management: 'manage',
    provisioning: 'view',
    feature_matrix: 'view',
    addon_governance: 'view',
  },

  // Tenant-side roles never have platform-side access by default.
  store_owner: { ...ALL_NONE },
  manager: { ...ALL_NONE },
  technician: { ...ALL_NONE },
  sales_staff: { ...ALL_NONE },
};

// ---------------------------------------------------------------------------
// Override storage in sessionStorage. Pure read — writes happen in the matrix
// UI in TeamManagementPage.
// ---------------------------------------------------------------------------

export const PLATFORM_PERMISSIONS_STORAGE_KEY = 'platform_permissions_v1';

export interface PlatformRoleOverrides {
  features?: Partial<Record<PlatformFeatureKey, PermissionLevel>>;
  subs?: Record<string, PermissionLevel>;
}

export type PlatformPermissionsOverrides = Partial<Record<Role, PlatformRoleOverrides>>;

export function readPlatformPermissionsOverrides(): PlatformPermissionsOverrides {
  if (typeof window === 'undefined' || !window.sessionStorage) return {};
  try {
    const raw = window.sessionStorage.getItem(PLATFORM_PERMISSIONS_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return (parsed && typeof parsed === 'object') ? parsed as PlatformPermissionsOverrides : {};
  } catch {
    return {};
  }
}

export function writePlatformPermissionsOverrides(next: PlatformPermissionsOverrides): void {
  if (typeof window === 'undefined' || !window.sessionStorage) return;
  try {
    window.sessionStorage.setItem(PLATFORM_PERMISSIONS_STORAGE_KEY, JSON.stringify(next));
    window.dispatchEvent(new Event('platform_permissions:changed'));
  } catch { /* noop */ }
}

// ---------------------------------------------------------------------------
// Reader helpers.
// ---------------------------------------------------------------------------

/**
 * Returns the effective feature-level for a role. System Owner is locked to
 * `full`; tenant-side roles always return `none`. Otherwise: the override
 * value (if present) wins, else the spec default.
 */
export function getPlatformFeatureLevel(
  role: Role | undefined | null,
  featureKey: PlatformFeatureKey,
  overrides?: PlatformPermissionsOverrides
): PermissionLevel {
  if (!role) return 'none';
  if (role === 'system_owner') return 'full';
  const ov = (overrides ?? readPlatformPermissionsOverrides())[role]?.features?.[featureKey];
  if (ov) return ov;
  return DEFAULT_PLATFORM_FEATURE_LEVELS[role]?.[featureKey] ?? 'none';
}

/**
 * Returns the effective sub-permission level for a role. Resolution rule:
 *   1. System Owner → 'full'.
 *   2. Tenant role → 'none'.
 *   3. Explicit sub override (sessionStorage) → that level.
 *   4. Otherwise inherit from the parent feature level.
 *
 * No "auto-grant by inheritance for sensitive subs" — the caller decides
 * via `hasPlatformPermission()` whether the inherited level meets the
 * sensitive sub-permission's threshold.
 */
export function getPlatformSubPermissionLevel(
  role: Role | undefined | null,
  subKey: string,
  overrides?: PlatformPermissionsOverrides
): PermissionLevel {
  if (!role) return 'none';
  if (role === 'system_owner') return 'full';
  const sub = SUB_LOOKUP.get(subKey);
  if (!sub) return 'none';
  const ov = overrides ?? readPlatformPermissionsOverrides();
  const explicit = ov[role]?.subs?.[subKey];
  if (explicit) return explicit;
  return getPlatformFeatureLevel(role, sub.feature, ov);
}

/**
 * The single permission gate used by Command Center, Audit & Security, and
 * Support Tools. Returns { allowed, reason }. Reason is empty when allowed.
 *
 * `subKey` must be a registered sub-permission id from the catalog. Unknown
 * keys deny with a clear reason so accidental typos surface immediately
 * instead of silently passing.
 */
export interface PlatformPermissionResult {
  allowed: boolean;
  reason: string;
  /** Effective level we resolved for diagnostics / tooltips. */
  level: PermissionLevel;
  /** The sub-permission threshold the caller had to meet. */
  threshold: PermissionLevel;
}

export function hasPlatformPermission(
  role: Role | undefined | null,
  subKey: string,
  overrides?: PlatformPermissionsOverrides
): PlatformPermissionResult {
  const sub = SUB_LOOKUP.get(subKey);
  if (!sub) {
    return {
      allowed: false,
      reason: `Unknown platform permission "${subKey}".`,
      level: 'none',
      threshold: 'view',
    };
  }
  if (!role) {
    return {
      allowed: false,
      reason: 'No active session.',
      level: 'none',
      threshold: sub.def.threshold,
    };
  }
  const level = getPlatformSubPermissionLevel(role, subKey, overrides);
  const allowed = platformPermissionMeets(level, sub.def.threshold);
  return {
    allowed,
    reason: allowed
      ? ''
      : `${PLATFORM_PERMISSION_LEVEL_LABEL[sub.def.threshold]} or higher required for ${sub.def.label}; current level is ${PLATFORM_PERMISSION_LEVEL_LABEL[level]}.`,
    level,
    threshold: sub.def.threshold,
  };
}

/**
 * Convenience wrapper: returns just the boolean. Use when you need a quick
 * gate and don't want to render the reason in a tooltip.
 */
export function canPlatform(
  role: Role | undefined | null,
  subKey: string,
  overrides?: PlatformPermissionsOverrides
): boolean {
  return hasPlatformPermission(role, subKey, overrides).allowed;
}

/**
 * Effective Feature Visibility — the unified resolver per the spec.
 *
 * A platform feature/page/sidebar item is visible if:
 *   - parent feature permission is View Only or higher
 *   OR
 *   - any child sub-permission under that feature is View Only or higher
 *     (explicit override in sessionStorage that grants access even when
 *     parent is None)
 *   OR
 *   - System Owner Full Access applies
 *
 * This function is the SINGLE place that decides sidebar visibility
 * and route-level access for platform features. canAccess() in
 * AccessContext delegates to it.
 */
export function hasEffectiveFeatureAccess(
  role: Role | undefined | null,
  featureKey: PlatformFeatureKey,
  overrides?: PlatformPermissionsOverrides
): boolean {
  if (!role) return false;
  if (role === 'system_owner') return true;

  const ov = overrides ?? readPlatformPermissionsOverrides();

  const parentLevel = getPlatformFeatureLevel(role, featureKey, ov);
  if (parentLevel !== 'none') return true;

  const group = FEATURE_BY_KEY.get(featureKey);
  if (!group) return false;

  for (const sp of group.subPermissions) {
    const subLevel = getPlatformSubPermissionLevel(role, sp.id, ov);
    if (subLevel !== 'none') return true;
  }

  return false;
}

// ---------------------------------------------------------------------------
// Nav / route feature-key → PlatformFeatureKey mapping.
// The sidebar and AccessGuard use short feature keys like 'tenants', 'billing',
// 'plans', etc. This map resolves them to the canonical PlatformFeatureKey used
// by the Global Permissions Matrix. Keys that already match (e.g.
// 'command_center') are included for completeness.
// ---------------------------------------------------------------------------

export const NAV_FEATURE_TO_PLATFORM_KEY: Record<string, PlatformFeatureKey> = {
  command_center: 'command_center',
  audit_security: 'audit_security',
  support_tools: 'support_tools',
  tenants: 'tenant_management',
  billing: 'billing_subscriptions',
  subscriptions: 'billing_subscriptions',
  usage: 'billing_subscriptions',
  plans: 'feature_matrix',
  platform_settings: 'platform_settings',
  domains: 'domains',
  team_management: 'team_management',
  provisioning: 'provisioning',
  addon_governance: 'addon_governance',
};

export const NAV_FEATURE_SECONDARY_KEYS: Partial<Record<string, PlatformFeatureKey[]>> = {
  plans: ['addon_governance'],
};

// ---------------------------------------------------------------------------
// Role display labels. Mirrors `accessConfig.platformRoles` but exported here
// so consumers don't have to reach into AccessContext.
// ---------------------------------------------------------------------------

export const PLATFORM_ROLE_DISPLAY_LABEL: Record<Role, string> = {
  system_owner: 'System Owner',
  support_admin: 'Support Admin',
  billing_admin: 'Billing Admin',
  operations_admin: 'Operations Admin',
  security_admin: 'Security/Audit Admin',
  store_owner: 'Store Owner',
  manager: 'Manager',
  technician: 'Technician',
  sales_staff: 'Sales Staff',
};

// ---------------------------------------------------------------------------
// Unified Effective Access Resolver — section/action level explainability.
//
// Per the IAM/RBAC hardening spec, the matrix is the single source of truth
// for sidebar visibility, page/route access, section/widget visibility, and
// action/handler authorization. These helpers expose a uniform shape so
// every gate decision is explainable, auditable, and testable.
//
// Source values:
//   system_owner          — System Owner is locked Full Access.
//   explicit_child        — Child sub-permission overridden in session storage.
//   explicit_parent       — Parent feature overridden in session storage.
//   default_parent        — Inherited from parent feature default level
//                           (sub-permissions have no per-child default).
//   denied_explicit_child — Explicit child None blocks action even if parent grants.
//   denied_no_access      — No effective access at all.
// ---------------------------------------------------------------------------

export type AccessDecisionSource =
  | 'system_owner'
  | 'explicit_child'
  | 'explicit_parent'
  | 'default_parent'
  | 'denied_explicit_child'
  | 'denied_no_access';
// Note: `default_child` is intentionally absent — sub-permissions inherit
// from the parent feature default (no per-child default level is stored on
// the def), so `default_parent` is the correct source label whenever the
// effective level comes from `DEFAULT_PLATFORM_FEATURE_LEVELS`.

export interface AccessDecision {
  allowed: boolean;
  effectiveLevel: PermissionLevel;
  source: AccessDecisionSource;
  reason: string;
  threshold: PermissionLevel;
}

/**
 * Returns the highest effective access level for a feature, considering
 * parent + every child sub-permission. Used for sidebar/page-level visibility
 * where any permitted child may grant access.
 */
export function getEffectiveFeatureAccess(
  role: Role | undefined | null,
  featureKey: PlatformFeatureKey,
  overrides?: PlatformPermissionsOverrides
): PermissionLevel {
  if (!role) return 'none';
  if (role === 'system_owner') return 'full';
  const ov = overrides ?? readPlatformPermissionsOverrides();
  let highest = getPlatformFeatureLevel(role, featureKey, ov);
  if (highest === 'full') return highest;
  const group = FEATURE_BY_KEY.get(featureKey);
  if (!group) return highest;
  for (const sp of group.subPermissions) {
    const sl = getPlatformSubPermissionLevel(role, sp.id, ov);
    if (LEVEL_RANK[sl] > LEVEL_RANK[highest]) {
      highest = sl;
    }
  }
  return highest;
}

/**
 * Section/widget visibility — checks the EXACT child sub-permission against
 * its threshold. Independent of parent feature level so that an explicit child
 * grant (e.g. view_needs_attention=View Only with parent=None) reveals only
 * that section and nothing else on the page.
 */
export function hasSectionAccess(
  role: Role | undefined | null,
  subKey: string,
  overrides?: PlatformPermissionsOverrides
): AccessDecision {
  return explainAccessDecision(role, subKey, overrides);
}

/**
 * Action/handler authorization — same semantics as hasSectionAccess but
 * named for clarity at the call site for mutations / workflow transitions.
 * Every mutation handler must call this (matrix is sole source of truth;
 * UI button state alone is not sufficient).
 */
export function hasActionAccess(
  role: Role | undefined | null,
  subKey: string,
  overrides?: PlatformPermissionsOverrides
): AccessDecision {
  return explainAccessDecision(role, subKey, overrides);
}

/**
 * Returns a structured explanation of a permission decision, including the
 * effective level and the source that produced it. Used by the matrix
 * Effective Access Preview, debug logs, and gate tooltips.
 */
export function explainAccessDecision(
  role: Role | undefined | null,
  subKey: string,
  overrides?: PlatformPermissionsOverrides
): AccessDecision {
  const sub = SUB_LOOKUP.get(subKey);
  if (!sub) {
    return {
      allowed: false,
      effectiveLevel: 'none',
      source: 'denied_no_access',
      reason: `Unknown platform permission "${subKey}".`,
      threshold: 'view',
    };
  }
  const threshold = sub.def.threshold;
  if (!role) {
    return {
      allowed: false,
      effectiveLevel: 'none',
      source: 'denied_no_access',
      reason: 'No active session.',
      threshold,
    };
  }
  if (role === 'system_owner') {
    return {
      allowed: true,
      effectiveLevel: 'full',
      source: 'system_owner',
      reason: 'System Owner has Full Access (locked).',
      threshold,
    };
  }
  const ov = overrides ?? readPlatformPermissionsOverrides();
  // Detect explicit child vs default child.
  const explicitChild = ov[role]?.subs?.[subKey];
  const explicitParent = ov[role]?.features?.[sub.feature];
  let source: AccessDecisionSource;
  let effectiveLevel: PermissionLevel;
  if (explicitChild !== undefined) {
    effectiveLevel = explicitChild;
    source = explicitChild === 'none' ? 'denied_explicit_child' : 'explicit_child';
  } else if (explicitParent !== undefined) {
    effectiveLevel = explicitParent;
    source = 'explicit_parent';
  } else {
    // No explicit override — fall back to the spec default for the parent
    // feature (sub-permissions inherit their parent's role default).
    effectiveLevel = (DEFAULT_PLATFORM_FEATURE_LEVELS[role]?.[sub.feature]) || 'none';
    source = 'default_parent';
  }
  const allowed = platformPermissionMeets(effectiveLevel, threshold);
  if (!allowed && source !== 'denied_explicit_child') {
    if (effectiveLevel === 'none') source = 'denied_no_access';
  }
  return {
    allowed,
    effectiveLevel,
    source,
    reason: allowed
      ? `${PLATFORM_PERMISSION_LEVEL_LABEL[effectiveLevel]} (${source.replace(/_/g, ' ')})`
      : `${PLATFORM_PERMISSION_LEVEL_LABEL[threshold]} or higher required for ${sub.def.label}; current level is ${PLATFORM_PERMISSION_LEVEL_LABEL[effectiveLevel]} (${source.replace(/_/g, ' ')}).`,
    threshold,
  };
}
