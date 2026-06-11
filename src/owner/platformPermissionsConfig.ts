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
      // Phase 1.3 — Milestone 5 correction: governance signals section (local/advisory).
      { id: 'view_governance_signals', label: 'View Governance Signals', description: 'See the Phase 1.3 Platform Team Governance signals section (temporary access, access review, and sensitive-action counts — local/advisory, derived from session records).', threshold: 'view' },
    ],
  },
  {
    key: 'audit_security',
    label: 'Audit & Security',
    description: 'Audit log viewer, security notes, and audit-driven case creation.',
    subPermissions: [
      { id: 'view_audit_security', label: 'View Audit & Security', description: 'Open the Audit & Security page and read the log.', threshold: 'view' },
      { id: 'view_audit_logs', label: 'View Audit Logs', description: 'Read the audit log table content. None hides all audit rows.', threshold: 'view' },
      { id: 'view_actor_profile', label: 'View Actor Profile', description: 'Open the actor profile tab in the audit drawer.', threshold: 'view' },
      { id: 'view_related_event_timeline', label: 'View Related Event Timeline', description: 'Open the related-events / timeline tab in the audit drawer.', threshold: 'view' },
      { id: 'export_audit_csv', label: 'Export Audit CSV', description: 'Export the currently visible audit rows as CSV.', threshold: 'approve', sensitive: true },
      { id: 'add_security_note', label: 'Add Security Note', description: 'Add a security / posture / incident note (per-session store).', threshold: 'create' },
      { id: 'delete_security_note', label: 'Delete Security Note', description: 'Permanently delete a security note (writes a `security_note_deleted` audit row).', threshold: 'approve', sensitive: true },
      { id: 'create_support_case_from_audit', label: 'Create Case from Audit Event', description: 'Open the "Create Support Case from Event" modal in the audit drawer.', threshold: 'create' },
      { id: 'view_restricted_audit_details', label: 'View Restricted Audit Details', description: 'Access restricted/sensitive detail in the audit drawer.', threshold: 'approve' },
      { id: 'view_escalation_lifecycle_audit', label: 'View Escalation Lifecycle Audit', description: 'Access escalation lifecycle lens/detail in audit context.', threshold: 'view' },
      // Phase 1.3 — Milestone 5 correction: governance advisory audit lens (local/advisory).
      { id: 'view_governance_audit_lens', label: 'View Governance Audit Lens', description: 'See and use the "Governance Activity (Advisory)" investigation lens that groups Phase 1.3 temporary-access / access-review / sensitive-action audit events. Local advisory audit trail only — not compliance evidence.', threshold: 'view' },
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
    label: 'Tenant Web Address',
    description: 'Tenant platform URLs, customer-facing links, external redirect guidance.',
    subPermissions: [
      { id: 'view_domains', label: 'View Tenant Web Address', description: 'Open the tenant web address directory.', threshold: 'view' },
      { id: 'manage_domain_lifecycle', label: 'Manage Tenant Web Address', description: 'Create, update, disable / re-enable tenant web addresses.', threshold: 'manage', sensitive: true },
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
      // Phase 1.3 — Milestone 5 correction: platform team GOVERNANCE controls
      // (Temporary Access / PIM Foundation + Access Review + Sensitive Action
      // Reason Capture). All LOCAL / ADVISORY / NON-ENFORCING — granting these
      // controls who can VIEW or MANAGE the governance tabs/records; it does NOT
      // change any real permission, role, or add server-side enforcement.
      { id: 'view_temporary_access', label: 'View Temporary Access', description: 'Open the Temporary Access / PIM tab and read advisory temporary-access grants (local/advisory — no real elevation).', threshold: 'view' },
      { id: 'manage_temporary_access', label: 'Manage Temporary Access', description: 'Request, approve/grant, deny, revoke, or cancel advisory temporary-access grants (reason required; no real permission change, no server-side enforcement).', threshold: 'manage', sensitive: true },
      { id: 'view_access_reviews', label: 'View Access Reviews', description: 'Open the Access Review tab and read advisory access-review records and the sensitive-action reason log (local/advisory).', threshold: 'view' },
      { id: 'manage_access_reviews', label: 'Manage Access Reviews', description: 'Create / seed access-review records and record reason-required review outcomes (no change required outcome ever alters a live role or permission).', threshold: 'manage', sensitive: true },
      { id: 'capture_sensitive_action_reasons', label: 'Capture Sensitive Action Reasons', description: 'See the Sensitive Action Reason Capture panel/log of reasons recorded around existing sensitive governance actions (local/advisory; does not broaden who can perform those actions).', threshold: 'manage', sensitive: true },
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

// ---------------------------------------------------------------------------
// Permission Dependency / Prerequisite Map (spec PART A).
//
// Some sub-permissions are MEANINGLESS without a prerequisite. e.g.:
//   - "Act on NBA Recommendations" is useless if NBA view is None.
//   - All Support Tools child actions assume the operator can at least open
//     Support Tools (view_support_tools).
//   - "Create Case from Audit Event" requires both "View Audit & Security"
//     AND "Create Support Case".
//   - Add-on commercial overrides require "View Add-on Governance".
//
// The resolver below (explainAccessDecision / hasPlatformPermission) auto-
// reconciles: if ANY prerequisite resolves to denied, the dependent action
// is denied with `source = 'denied_prerequisite'` and a concise reason that
// names the missing prerequisite, so UI tooltips, the Effective Access
// Preview, and audit logs can explain "this action is inactive because
// prerequisite [X] is None/View Only" without each callsite repeating the
// dependency check.
//
// NOTE: only direct prerequisites are listed — the resolver follows them
// transitively with a small recursion guard to prevent cycles. Server-side
// RBAC / PIM / PAM enforcement is out of scope for this phase (planned for
// Phase 1.3).
// ---------------------------------------------------------------------------

export const PLATFORM_PERMISSION_DEPENDENCIES: Record<string, string[]> = {
  // Command Center — NBA action requires NBA view.
  act_on_nba_recommendations: ['view_next_best_actions'],

  // Support Tools — every child action requires being able to OPEN the
  // Support Tools surface (view_support_tools). This makes a stale UI
  // (e.g. an open drawer after parent access is revoked) safe by design.
  view_escalation_history: ['view_support_tools'],
  create_support_case: ['view_support_tools'],
  change_support_status: ['view_support_tools'],
  change_support_severity: ['view_support_tools'],
  assign_support_case: ['view_support_tools'],
  close_support_case: ['view_support_tools'],
  reopen_support_case: ['view_support_tools'],
  edit_support_case: ['view_support_tools'],
  escalate_assigned_case: ['view_support_tools'],
  escalate_any_case: ['view_support_tools'],
  acknowledge_escalation: ['view_support_tools'],
  assign_escalation_owner_team: ['view_support_tools'],
  change_escalation_level: ['view_support_tools'],
  deescalate_support_case: ['view_support_tools'],
  resolve_escalation: ['view_support_tools'],
  close_with_active_escalation: ['view_support_tools', 'close_support_case'],
  view_support_sla: ['view_support_tools'],
  view_support_tenant_health: ['view_support_tools'],
  view_support_related_entities: ['view_support_tools'],
  add_internal_support_note: ['view_support_tools'],
  use_support_macro: ['add_internal_support_note'],
  manage_support_macros: ['view_support_tools'],

  // Audit & Security — drawer sub-tabs, export, and note actions require
  // being able to open Audit & Security at minimum.
  view_audit_logs: ['view_audit_security'],
  view_actor_profile: ['view_audit_security'],
  view_related_event_timeline: ['view_audit_security'],
  view_restricted_audit_details: ['view_audit_security'],
  view_escalation_lifecycle_audit: ['view_audit_security'],
  export_audit_csv: ['view_audit_logs'],
  add_security_note: ['view_audit_security'],
  delete_security_note: ['view_audit_security'],
  // Creating a support case FROM an audit event needs BOTH (Audit drawer
  // visibility + the right to create a support case in Support Tools).
  create_support_case_from_audit: ['view_audit_security', 'create_support_case'],

  // Phase 1.3 — Milestone 5 correction: platform team governance controls.
  // Every governance MANAGE/CAPTURE action depends on being able to VIEW the
  // corresponding governance surface, and the two governance signal/lens views
  // depend on being able to open their host page. Uses the SAME dependency
  // auto-sync mechanism as every other entry (no resolver change).
  manage_temporary_access: ['view_temporary_access'],
  manage_access_reviews: ['view_access_reviews'],
  capture_sensitive_action_reasons: ['view_access_reviews'],
  view_governance_signals: ['view_command_center'],
  view_governance_audit_lens: ['view_audit_security'],

  // Commercial Controls / Add-on Governance — every mutation depends on
  // being able to see the add-on catalog.
  create_addon: ['view_addon_governance'],
  edit_addon: ['view_addon_governance'],
  archive_delete_addon: ['view_addon_governance'],
  manage_addon_compatible_plans: ['view_addon_governance'],
  manage_addon_readiness: ['view_addon_governance'],
  generate_addon_implementation_brief: ['view_addon_governance'],
  grant_trial: ['view_addon_governance'],
  grant_paid_override: ['view_addon_governance'],
  revoke_addon_override: ['view_addon_governance'],
  edit_addon_overrides: ['view_addon_governance'],
};

export function getPlatformPermissionDependencies(subKey: string): string[] {
  return PLATFORM_PERMISSION_DEPENDENCIES[subKey] || [];
}

// Reverse dependency index — given a prerequisite sub-key, list the
// dependent sub-keys that require it. Built once at module-load.
export const PLATFORM_PERMISSION_DEPENDENTS: Record<string, string[]> = (() => {
  const map: Record<string, string[]> = {};
  for (const [dependent, deps] of Object.entries(PLATFORM_PERMISSION_DEPENDENCIES)) {
    for (const prereq of deps) {
      if (!map[prereq]) map[prereq] = [];
      map[prereq].push(dependent);
    }
  }
  return map;
})();

export function getPlatformPermissionDependents(subKey: string): string[] {
  return PLATFORM_PERMISSION_DEPENDENTS[subKey] || [];
}

// ---------------------------------------------------------------------------
// Permission Dependency Auto-Sync (write-time reconciliation).
//
// Direction-aware IAM rules (mirrors PART A of the spec):
//   1) RAISING a dependent action permission auto-raises each prerequisite to
//      the minimum level needed to satisfy that prereq's own threshold (so the
//      dependent action is actually usable).
//   2) LOWERING a prerequisite auto-caps any dependent mutation/action perm
//      that becomes ineffective as a result (set explicit `none`).
//   3) LOWERING a dependent action does NOT touch its read-only prerequisite.
//   4) System Owner is locked — no reconciliation runs for it.
//   5) Every adjustment is returned so the caller can audit it.
//
// These helpers are pure — they take overrides in, return new overrides +
// the list of adjustments. The matrix UI applies and audits the result.
// ---------------------------------------------------------------------------

export interface PermissionAdjustment {
  /** The sub-permission whose stored value was auto-changed. */
  subKey: string;
  /** Display label of the adjusted sub-permission. */
  label: string;
  /** Effective level before the auto-adjustment. */
  prevLevel: PermissionLevel;
  /** Effective level after the auto-adjustment. */
  nextLevel: PermissionLevel;
  /** What kind of reconciliation occurred. */
  reason: 'prereq_auto_raised' | 'dependent_auto_capped';
  /** For prereq_auto_raised: the dependent action that triggered the raise. */
  triggeredBy?: string;
}

export interface ReconciliationResult {
  next: PlatformPermissionsOverrides;
  adjustments: PermissionAdjustment[];
}

function cloneOverrides(o: PlatformPermissionsOverrides): PlatformPermissionsOverrides {
  return JSON.parse(JSON.stringify(o || {}));
}

function setExplicitSub(
  overrides: PlatformPermissionsOverrides,
  role: Role,
  subKey: string,
  level: PermissionLevel
): void {
  const entry = { ...(overrides[role] || {}) };
  entry.subs = { ...(entry.subs || {}), [subKey]: level };
  overrides[role] = entry;
}

/**
 * Reconcile dependencies after a single sub-permission was set to a new
 * level. Direction-aware per the IAM rules above.
 *
 * @param role             The role whose permission was changed.
 * @param subKey           The sub-permission that was changed.
 * @param prevLevel        The effective level immediately BEFORE the user's
 *                         change (used only as a fast direction check).
 * @param nextLevel        The level the user just set.
 * @param overrides        The full overrides snapshot AFTER the user's
 *                         change has been applied (the changed sub already
 *                         reflects `nextLevel`).
 * @param overridesBefore  The full overrides snapshot BEFORE the user's
 *                         change. Required for the "was previously allowed"
 *                         test that drives dependent auto-capping.
 */
export function reconcileSubPermissionChange(
  role: Role,
  subKey: string,
  prevLevel: PermissionLevel,
  nextLevel: PermissionLevel,
  overrides: PlatformPermissionsOverrides,
  overridesBefore: PlatformPermissionsOverrides
): ReconciliationResult {
  if (role === 'system_owner') return { next: overrides, adjustments: [] };
  if (LEVEL_RANK[nextLevel] === LEVEL_RANK[prevLevel]) {
    return { next: overrides, adjustments: [] };
  }
  const working = cloneOverrides(overrides);
  const adjustments: PermissionAdjustment[] = [];

  const raised = LEVEL_RANK[nextLevel] > LEVEL_RANK[prevLevel];
  const lowered = LEVEL_RANK[nextLevel] < LEVEL_RANK[prevLevel];

  if (raised) {
    // Walk this sub's prerequisites transitively; raise any currently-denied
    // prereq to the minimum level that satisfies its own threshold. NEVER
    // lower an already-higher level (least-privilege preserved).
    const visited = new Set<string>();
    const raiseChain = (k: string) => {
      if (visited.has(k)) return;
      visited.add(k);
      const deps = PLATFORM_PERMISSION_DEPENDENCIES[k] || [];
      for (const dk of deps) {
        const def = SUB_LOOKUP.get(dk);
        if (!def) continue;
        const dec = explainAccessDecision(role, dk, working);
        if (!dec.allowed) {
          const target: PermissionLevel = def.def.threshold === 'none' ? 'view' : def.def.threshold;
          const currentStored = getPlatformSubPermissionLevel(role, dk, working);
          // Guard: never write a target that would LOWER an already-higher
          // explicit/inherited level. This can occur in transitive chains
          // where a prereq is itself denied because of yet another missing
          // prereq — in that case raising its sibling prereq fixes things
          // and we must not overwrite the unrelated sub.
          if (LEVEL_RANK[target] <= LEVEL_RANK[currentStored]) {
            raiseChain(dk);
            continue;
          }
          setExplicitSub(working, role, dk, target);
          adjustments.push({
            subKey: dk,
            label: def.def.label,
            prevLevel: currentStored,
            nextLevel: target,
            reason: 'prereq_auto_raised',
            triggeredBy: k,
          });
          raiseChain(dk);
        }
      }
    };
    raiseChain(subKey);
  }

  if (lowered) {
    // Walk reverse dependencies transitively; cap any dependent that was
    // allowed BEFORE the user's change but is now denied_prerequisite.
    // Critical: compare against `overridesBefore` (true pre-change state)
    // — using the post-change snapshot would mask the very transitions we
    // need to detect.
    const visited = new Set<string>();
    const capChain = (k: string) => {
      if (visited.has(k)) return;
      visited.add(k);
      const dependents = PLATFORM_PERMISSION_DEPENDENTS[k] || [];
      for (const dk of dependents) {
        const def = SUB_LOOKUP.get(dk);
        if (!def) continue;
        const prevDec = explainAccessDecision(role, dk, overridesBefore);
        const nowDec = explainAccessDecision(role, dk, working);
        if (prevDec.allowed && !nowDec.allowed && nowDec.source === 'denied_prerequisite') {
          const prev = getPlatformSubPermissionLevel(role, dk, working);
          if (prev !== 'none') {
            setExplicitSub(working, role, dk, 'none');
            adjustments.push({
              subKey: dk,
              label: def.def.label,
              prevLevel: prev,
              nextLevel: 'none',
              reason: 'dependent_auto_capped',
              triggeredBy: k,
            });
            capChain(dk);
          }
        }
      }
    };
    capChain(subKey);
  }

  return { next: working, adjustments };
}

/**
 * Reconcile dependencies after a parent FEATURE-level change. Only LOWERING
 * a parent can drop dependents below their threshold (raising parent only
 * increases inherited levels). For each sub in the changed feature whose
 * effective level dropped, cap any dependents that became
 * denied_prerequisite.
 */
export function reconcileFeatureLevelChange(
  role: Role,
  featureKey: PlatformFeatureKey,
  prevLevel: PermissionLevel,
  nextLevel: PermissionLevel,
  overrides: PlatformPermissionsOverrides,
  overridesBefore: PlatformPermissionsOverrides
): ReconciliationResult {
  if (role === 'system_owner') return { next: overrides, adjustments: [] };
  if (LEVEL_RANK[nextLevel] >= LEVEL_RANK[prevLevel]) {
    return { next: overrides, adjustments: [] };
  }
  const working = cloneOverrides(overrides);
  const adjustments: PermissionAdjustment[] = [];
  const group = FEATURE_BY_KEY.get(featureKey);
  if (!group) return { next: working, adjustments };

  const visited = new Set<string>();
  const capChain = (k: string) => {
    if (visited.has(k)) return;
    visited.add(k);
    const dependents = PLATFORM_PERMISSION_DEPENDENTS[k] || [];
    for (const dk of dependents) {
      const def = SUB_LOOKUP.get(dk);
      if (!def) continue;
      const prevDec = explainAccessDecision(role, dk, overridesBefore);
      const nowDec = explainAccessDecision(role, dk, working);
      if (prevDec.allowed && !nowDec.allowed && nowDec.source === 'denied_prerequisite') {
        const prev = getPlatformSubPermissionLevel(role, dk, working);
        if (prev !== 'none') {
          setExplicitSub(working, role, dk, 'none');
          adjustments.push({
            subKey: dk,
            label: def.def.label,
            prevLevel: prev,
            nextLevel: 'none',
            reason: 'dependent_auto_capped',
            triggeredBy: k,
          });
          capChain(dk);
        }
      }
    }
  };
  for (const sp of group.subPermissions) {
    capChain(sp.id);
  }
  return { next: working, adjustments };
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
  // Delegate to explainAccessDecision so every gate decision honors the
  // dependency/prerequisite map uniformly. This lets a single resolver auto-
  // reconcile dependent permissions (e.g. NBA action requires NBA view).
  const dec = explainAccessDecision(role, subKey, overrides);
  return {
    allowed: dec.allowed,
    reason: dec.allowed ? '' : dec.reason,
    level: dec.effectiveLevel,
    threshold: dec.threshold,
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
  | 'denied_no_access'
  | 'denied_prerequisite';
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
  overrides?: PlatformPermissionsOverrides,
  _depPath?: Set<string>
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
  let allowed = platformPermissionMeets(effectiveLevel, threshold);
  if (!allowed && source !== 'denied_explicit_child') {
    if (effectiveLevel === 'none') source = 'denied_no_access';
  }

  // Dependency / prerequisite reconciliation. If this permission depends on
  // other sub-permissions, EACH prerequisite must independently resolve to
  // allowed. A failing prereq forces this decision to denied with a clear
  // reason that names the missing prerequisite (UI tooltips, Effective
  // Access Preview, audit log all read off this).
  if (allowed) {
    const deps = PLATFORM_PERMISSION_DEPENDENCIES[subKey] || [];
    if (deps.length > 0) {
      const path = _depPath ?? new Set<string>();
      path.add(subKey);
      for (const depKey of deps) {
        if (path.has(depKey)) continue; // cycle guard
        const depSub = SUB_LOOKUP.get(depKey);
        if (!depSub) continue;
        const depDec = explainAccessDecision(role, depKey, ov, path);
        if (!depDec.allowed) {
          allowed = false;
          source = 'denied_prerequisite';
          return {
            allowed: false,
            effectiveLevel,
            source,
            reason: `This action depends on "${depSub.def.label}", which is currently denied (${PLATFORM_PERMISSION_LEVEL_LABEL[depDec.effectiveLevel]}). Grant the prerequisite to enable this action.`,
            threshold,
          };
        }
      }
    }
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
