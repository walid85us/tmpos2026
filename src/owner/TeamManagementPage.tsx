import React, { useEffect, useMemo, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import PageShell from '../components/PageShell';
import { useAccess } from '../context/AccessContext';
import { platformTeamMembers, type PlatformTeamStatus } from './mockData';
import { pushPlatformAudit } from './platformOpsAudit';
import type { PermissionLevel } from '../types';
import type { Role } from '../context/accessConfig';
// Phase 1.3 — Milestone 2: consume the Milestone 1 ADVISORY governance model.
// Everything imported below produces display LABELS / SUMMARIES only — it never
// blocks or allows an action and does not touch the permission resolver.
import {
  PLATFORM_ROLE_CATALOG,
  getRoleGovernanceSummary,
  FUTURE_ROLE_CONCEPTS,
  PLATFORM_GOVERNANCE_MODEL_STATUS,
  isPlatformRoleId,
  getTemporaryAccessStatus,
  getTemporaryAccessDisplayLabel,
  ACCESS_REVIEW_STATUS_LABEL,
  getRecommendedReviewCadence,
  type PlatformRoleId,
  type TemporaryAccessStatus,
  type AccessReviewStatus,
} from './platformTeamGovernance';
// Phase 1.3 — Milestone 4: Access Review + Sensitive Action Reason Capture
// (LOCAL / ADVISORY / NON-ENFORCING). The store + helpers below never touch the
// resolver or real permissions — they record reason-captured review outcomes
// (with derived overdue/stale labels) and reason-captured sensitive actions only.
import {
  ACCESS_REVIEW_CHANGED_EVENT,
  ACCESS_REVIEW_MODEL_STATUS,
  ACCESS_REVIEW_OUTCOMES,
  ACCESS_REVIEW_OUTCOME_LABEL,
  SENSITIVE_ACTION_REASON_CHANGED_EVENT,
  SENSITIVE_ACTION_REASON_MODEL_STATUS,
  SENSITIVE_ACTION_REASON_ADVISORY_LABEL,
  readAccessReviewRecords,
  writeAccessReviewRecords,
  createAccessReviewRecord,
  completeAccessReview,
  captureSensitiveActionReason,
  readSensitiveActionReasons,
  writeSensitiveActionReasons,
  deriveAccessReviewStatus,
  availableAccessReviewActions,
  summarizeAccessReviews,
  type StoredAccessReviewRecord,
  type AccessReviewOutcome,
  type SensitiveActionReasonCapture,
  type SensitiveActionCaptureInput,
} from './platformAccessReview';
// Phase 1.3 — Milestone 3: Temporary Access / PIM Foundation (LOCAL / ADVISORY /
// NON-ENFORCING). The store + lifecycle helpers below never touch the resolver
// or real permissions — they record reason-captured, derived-expiry grants only.
import {
  TEMPORARY_ACCESS_CHANGED_EVENT,
  TEMPORARY_ACCESS_MODEL_STATUS,
  TEMPORARY_ACCESS_DURATION_PRESETS,
  readTemporaryAccessGrants,
  writeTemporaryAccessGrants,
  createTemporaryAccessRequest,
  approveTemporaryAccess,
  denyTemporaryAccess,
  revokeTemporaryAccess,
  cancelTemporaryAccess,
  availableTemporaryAccessActions,
  summarizeTemporaryAccess,
  type StoredTemporaryAccessGrant,
  type TemporaryAccessLifecycleAction,
} from './platformTemporaryAccess';
import {
  PLATFORM_FEATURE_GROUPS,
  PLATFORM_PERMISSION_LEVELS,
  PLATFORM_PERMISSION_LEVEL_LABEL,
  PLATFORM_PERMISSION_DEPENDENCIES,
  findSubPermissionDef,
  explainAccessDecision,
  reconcileSubPermissionChange,
  reconcileFeatureLevelChange,
  type PermissionAdjustment,
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

// `lastActiveAt` / `invitedAt` are ADDITIVE optional display fields carried
// through from the mock directory. Members added in-session don't have them and
// fall back to truthful "not recorded" copy — never fabricated activity.
type TeamMember = {
  id: string;
  name: string;
  email: string;
  role: string;
  status: PlatformTeamStatus;
  lastActiveAt?: string | null;
  invitedAt?: string;
};

const STATUS_BADGE_STYLES: Record<PlatformTeamStatus, string> = {
  invited: 'bg-amber-400/10 text-amber-700 border-amber-400/20',
  active: 'bg-emerald-500/10 text-emerald-600 border-emerald-500/20',
  suspended: 'bg-orange-400/10 text-orange-700 border-orange-400/20',
  disabled: 'bg-slate-200 text-slate-600 border-slate-300',
};

// ---------------------------------------------------------------------------
// Phase 1.3 — Milestone 2 advisory-display helpers (LABELS ONLY).
//
// None of the helpers below change any access decision. They map a directory
// member's role string onto the Milestone 1 governance catalog so the UI can
// surface risk posture, review cadence, system protection, and future
// temporary-elevation eligibility as advisory badges. Unknown / custom roles
// resolve to `null` and render truthful fallbacks instead of fake data.
// ---------------------------------------------------------------------------

// Reverse lookup: governance-catalog display label (lowercased) -> platform role id.
const PLATFORM_ROLE_ID_BY_LABEL: Record<string, PlatformRoleId> = (() => {
  const map: Record<string, PlatformRoleId> = {};
  (Object.keys(PLATFORM_ROLE_CATALOG) as PlatformRoleId[]).forEach(id => {
    map[PLATFORM_ROLE_CATALOG[id].displayLabel.trim().toLowerCase()] = id;
  });
  return map;
})();

/** Resolve a stored role string (id OR display label) to a catalog role id, else null. */
function resolvePlatformRoleId(role: string | null | undefined): PlatformRoleId | null {
  if (!role) return null;
  if (isPlatformRoleId(role)) return role;
  return PLATFORM_ROLE_ID_BY_LABEL[role.trim().toLowerCase()] ?? null;
}

// Advisory risk-posture badge colors (display only; severity ordering matches
// the governance catalog's RiskPosture labels).
const RISK_POSTURE_BADGE_STYLE: Record<string, string> = {
  Critical: 'bg-red-500/10 text-red-600 border-red-500/20',
  High: 'bg-orange-400/10 text-orange-700 border-orange-400/20',
  Elevated: 'bg-amber-400/10 text-amber-700 border-amber-400/20',
  Moderate: 'bg-slate-100 text-slate-500 border-slate-200',
};

/** Truthful relative/explicit last-activity label. Never fabricates a value. */
function formatLastActivity(lastActiveAt: string | null | undefined): string {
  if (!lastActiveAt) return 'Last activity not recorded';
  return lastActiveAt;
}

// Phase 1.3 — Milestone 3: derived temporary-access status badge colors
// (display only; keyed by the Milestone 1 derived status).
const TEMP_ACCESS_STATUS_BADGE_STYLE: Record<TemporaryAccessStatus, string> = {
  requested: 'bg-amber-400/10 text-amber-700 border-amber-400/20',
  active: 'bg-emerald-500/10 text-emerald-600 border-emerald-500/20',
  expired: 'bg-slate-200 text-slate-600 border-slate-300',
  revoked: 'bg-red-500/10 text-red-600 border-red-500/20',
  denied: 'bg-orange-400/10 text-orange-700 border-orange-400/20',
  cancelled: 'bg-slate-100 text-slate-500 border-slate-200',
};

const TEMP_ACCESS_ACTION_VERB: Record<TemporaryAccessLifecycleAction, string> = {
  request: 'Request',
  approve: 'Approve / Grant',
  deny: 'Deny',
  revoke: 'Revoke',
  cancel: 'Cancel',
};

// Short, honest copy shown in the reason-required action modal per action.
const TEMP_ACCESS_ACTION_PROMPT: Record<TemporaryAccessLifecycleAction, string> = {
  request: 'Describe why this temporary elevation is needed.',
  approve: 'Why is this temporary elevation being approved? The time-box clock starts now.',
  deny: 'Why is this temporary-access request being denied?',
  revoke: 'Why is this active grant being revoked early? (Manual — there is no automatic revocation.)',
  cancel: 'Why is this grant being cancelled/withdrawn?',
};

// Phase 1.3 — Milestone 4: derived access-review status badge colors
// (display only; keyed by the Milestone 1 derived AccessReviewStatus). `overdue`
// is a DERIVED label only — never a stored, reviewer-selected outcome.
const ACCESS_REVIEW_STATUS_BADGE_STYLE: Record<AccessReviewStatus, string> = {
  pending: 'bg-amber-400/10 text-amber-700 border-amber-400/20',
  reviewed_no_change: 'bg-emerald-500/10 text-emerald-600 border-emerald-500/20',
  reviewed_change_required: 'bg-orange-400/10 text-orange-700 border-orange-400/20',
  escalated: 'bg-red-500/10 text-red-600 border-red-500/20',
  overdue: 'bg-rose-500/10 text-rose-700 border-rose-500/20',
  deferred: 'bg-slate-100 text-slate-500 border-slate-200',
};

// Honest copy shown in the reason-required outcome modal, per outcome.
const ACCESS_REVIEW_OUTCOME_PROMPT: Record<AccessReviewOutcome, string> = {
  reviewed_no_change: 'Confirm the access was reviewed and no change is needed. A reason is required.',
  reviewed_change_required:
    'A change is required. This is advisory only — no permission change is applied automatically. A reason is required.',
  escalated: 'Escalate this review for further attention. A reason is required.',
  deferred: 'Defer this review to a later period. A reason is required.',
};

/** Suggests a default review period like "Q2 2026" from a timestamp (display default only). */
function defaultReviewPeriod(now: number = Date.now()): string {
  const d = new Date(now);
  const quarter = Math.floor(d.getMonth() / 3) + 1;
  return `Q${quarter} ${d.getFullYear()}`;
}

export default function TeamManagementPage() {
  const { session, platformRolesState = [], addPlatformRole, updatePlatformRole } = useAccess();
  const [activeTab, setActiveTab] = useState<'team' | 'roles' | 'temporary' | 'review' | 'permissions' | 'activity'>('team');
  const [searchQuery, setSearchQuery] = useState('');
  const [showAddModal, setShowAddModal] = useState(false);
  const [showCreateRoleModal, setShowCreateRoleModal] = useState(false);
  const [editingMember, setEditingMember] = useState<TeamMember | null>(null);

  const [newRole, setNewRole] = useState({ name: '', description: '', status: 'active' as string, permissions: [] as string[] });

  const [team, setTeam] = useState<TeamMember[]>(() =>
    platformTeamMembers.map(m => ({
      id: m.id,
      name: m.name,
      email: m.email,
      role: m.role,
      status: m.status,
      lastActiveAt: m.lastActiveAt,
      invitedAt: m.invitedAt,
    }))
  );

  const [activityLogs, setActivityLogs] = useState([
    { id: 'a1', user: 'Admin User', action: 'Created Role', details: 'Added new Billing Admin role', time: '2024-03-20 10:00' },
    { id: 'a2', user: 'Support Rep', action: 'Reset Password', details: 'Reset password for store tenant-1', time: '2024-03-20 11:30' },
  ]);

  const [showResetConfirm, setShowResetConfirm] = useState(false);
  // Phase 1.3 — Milestone 4: reason required to capture the sensitive "reset
  // permissions to defaults" governance action (advisory reason capture only —
  // the reset behavior + its existing audit row are unchanged).
  const [resetReason, setResetReason] = useState('');

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

  // Phase 1.3 — Milestone 2: advisory access-posture badge cluster for a member.
  // Pure display. Unknown / custom roles get a truthful fallback, never fake data.
  const renderAccessPostureBadges = (roleId: PlatformRoleId | null) => {
    if (!roleId) {
      return (
        <div className="flex flex-wrap gap-1.5">
          <span
            title="This role is not part of the platform governance catalog (e.g. a custom role). Advisory governance metadata is unavailable for it."
            className="px-2 py-0.5 text-[8px] font-black uppercase tracking-widest rounded border bg-slate-100 text-slate-500 border-slate-200"
          >
            Custom / non-catalog role — no governance metadata
          </span>
          <span className="px-2 py-0.5 text-[8px] font-black uppercase tracking-widest rounded border bg-indigo-400/10 text-indigo-700 border-indigo-400/20">
            UI-Gated Today
          </span>
        </div>
      );
    }
    const gov = getRoleGovernanceSummary(roleId);
    return (
      <div className="flex flex-wrap gap-1.5">
        <span className={`px-2 py-0.5 text-[8px] font-black uppercase tracking-widest rounded border ${RISK_POSTURE_BADGE_STYLE[gov.riskPostureLabel] || RISK_POSTURE_BADGE_STYLE.Moderate}`}>
          Risk: {gov.riskPostureLabel}
        </span>
        <span className="px-2 py-0.5 text-[8px] font-black uppercase tracking-widest rounded border bg-slate-100 text-slate-500 border-slate-200">
          Review: {gov.reviewCadenceLabel}
        </span>
        {gov.systemProtected && (
          <span
            title="System-protected role — locked at Full Access and never downgraded or reconciled by the resolver."
            className="px-2 py-0.5 text-[8px] font-black uppercase tracking-widest rounded border bg-violet-400/10 text-violet-700 border-violet-400/20"
          >
            System Protected
          </span>
        )}
        <span className={`px-2 py-0.5 text-[8px] font-black uppercase tracking-widest rounded border ${gov.includeInAccessReview ? 'bg-sky-400/10 text-sky-700 border-sky-400/20' : 'bg-slate-100 text-slate-500 border-slate-200'}`}>
          {gov.includeInAccessReview ? 'Included in Future Access Review' : 'Not in Access-Review Scope'}
        </span>
        <span
          title="Future workflow — no temporary-elevation / PIM workflow exists today. Eligibility is an advisory planning label only."
          className={`px-2 py-0.5 text-[8px] font-black uppercase tracking-widest rounded border ${gov.eligibleForTemporaryElevation ? 'bg-teal-400/10 text-teal-700 border-teal-400/20' : 'bg-slate-100 text-slate-400 border-slate-200'}`}
        >
          {gov.eligibleForTemporaryElevation ? 'Temp Elevation Eligible — Future' : 'No Temp Elevation'}
        </span>
        <span
          title="Current platform access is enforced in the UI/client only. Server-side enforcement is future/deferred."
          className="px-2 py-0.5 text-[8px] font-black uppercase tracking-widest rounded border bg-indigo-400/10 text-indigo-700 border-indigo-400/20"
        >
          UI-Gated Today
        </span>
      </div>
    );
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

      <p className="text-[11px] font-medium text-slate-500 leading-relaxed max-w-3xl -mt-2">
        Governance posture below (risk, review cadence, system protection, temporary-elevation eligibility) is{' '}
        <span className="font-black text-slate-600">advisory</span> and derived from the Phase 1.3 governance model. These
        labels do not change any access decision — current platform access is UI/client-gated only.
      </p>

      <div className="bg-white/80 backdrop-blur-xl rounded-[2.5rem] border border-slate-200 overflow-hidden shadow-sm">
        <div className="overflow-x-auto">
        <table className="w-full text-left border-collapse min-w-[1040px]">
          <thead>
            <tr className="border-b border-slate-100 bg-slate-50/50">
              <th className="px-8 py-6 text-[10px] font-black text-slate-400 uppercase tracking-widest">Member</th>
              <th className="px-8 py-6 text-[10px] font-black text-slate-400 uppercase tracking-widest">Role &amp; Governance</th>
              <th className="px-8 py-6 text-[10px] font-black text-slate-400 uppercase tracking-widest">Access Posture <span className="text-slate-300 normal-case tracking-normal">(advisory)</span></th>
              <th className="px-8 py-6 text-[10px] font-black text-slate-400 uppercase tracking-widest">Last Activity</th>
              <th className="px-8 py-6 text-[10px] font-black text-slate-400 uppercase tracking-widest">Status</th>
              <th className="px-8 py-6 text-[10px] font-black text-slate-400 uppercase tracking-widest text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {team.filter(u => u.name.toLowerCase().includes(searchQuery.toLowerCase()) || u.email.toLowerCase().includes(searchQuery.toLowerCase())).map((user) => {
              const roleId = resolvePlatformRoleId(user.role);
              const meta = roleId ? PLATFORM_ROLE_CATALOG[roleId] : null;
              const gov = roleId ? getRoleGovernanceSummary(roleId) : null;
              return (
              <tr key={user.id} className="hover:bg-slate-50/50 transition-colors border-b border-slate-50 last:border-0 align-top">
                <td className="px-8 py-6">
                  <p className="text-sm font-black text-primary">{user.name}</p>
                  <p className="text-xs font-bold text-slate-500 mt-0.5">{user.email}</p>
                </td>
                <td className="px-8 py-6">
                  <span
                    title={meta?.purpose || 'Role is not part of the platform governance catalog.'}
                    className="inline-block px-3 py-1 bg-slate-100 text-slate-600 text-[10px] font-black uppercase tracking-widest rounded-lg"
                  >
                    {user.role}
                  </span>
                  <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mt-1.5">
                    {gov ? gov.governanceCategoryLabel : 'Governance category not catalogued'}
                  </p>
                </td>
                <td className="px-8 py-6">
                  {renderAccessPostureBadges(roleId)}
                </td>
                <td className="px-8 py-6">
                  <span className={`text-xs font-bold ${user.lastActiveAt ? 'text-slate-600' : 'text-slate-400 italic'}`}>
                    {formatLastActivity(user.lastActiveAt)}
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
              );
            })}
          </tbody>
        </table>
        </div>
      </div>
    </div>
  );

  // Phase 1.3 — Milestone 2: read-only governance summary for the 5 CURRENT
  // platform roles, plus a clearly separated Future / Deferred Role Concepts
  // area. Advisory display only — introduces no new active roles and changes no
  // role defaults, thresholds, or resolver behavior.
  const renderRoleGovernanceCatalog = () => {
    const catalogIds = Object.keys(PLATFORM_ROLE_CATALOG) as PlatformRoleId[];
    return (
      <div className="space-y-6" data-testid="role-governance-catalog">
        <div>
          <h2 className="text-2xl font-black text-primary tracking-tight">Platform Role Catalog — Governance</h2>
          <p className="text-slate-500 text-sm font-medium mt-1 max-w-3xl">
            Advisory governance summary for the five current platform roles. Risk posture, review cadence, system
            protection, and temporary-elevation eligibility are <span className="font-black">advisory labels</span> from
            the Phase 1.3 governance model — they do not change role defaults or permission decisions.
          </p>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6">
          {catalogIds.map(id => {
            const meta = PLATFORM_ROLE_CATALOG[id];
            const gov = getRoleGovernanceSummary(id);
            return (
              <div key={id} className="bg-white/80 backdrop-blur-xl p-7 rounded-[2rem] border border-slate-200 shadow-sm flex flex-col">
                <div className="flex items-start justify-between gap-3 mb-3">
                  <h3 className="text-lg font-black text-primary leading-tight">{meta.displayLabel}</h3>
                  {meta.systemProtected && (
                    <span
                      title="System-protected — locked at Full Access; never downgraded or reconciled."
                      className="shrink-0 px-2 py-0.5 text-[8px] font-black uppercase tracking-widest rounded border bg-violet-400/10 text-violet-700 border-violet-400/20"
                    >
                      System Protected
                    </span>
                  )}
                </div>
                <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-3">{gov.governanceCategoryLabel}</p>
                <p className="text-xs font-medium text-slate-500 leading-relaxed mb-4">{meta.purpose}</p>
                <div className="flex flex-wrap gap-1.5 mb-4">
                  <span className={`px-2 py-0.5 text-[8px] font-black uppercase tracking-widest rounded border ${RISK_POSTURE_BADGE_STYLE[gov.riskPostureLabel] || RISK_POSTURE_BADGE_STYLE.Moderate}`}>
                    Risk: {gov.riskPostureLabel}
                  </span>
                  <span className="px-2 py-0.5 text-[8px] font-black uppercase tracking-widest rounded border bg-slate-100 text-slate-500 border-slate-200">
                    Review: {gov.reviewCadenceLabel}
                  </span>
                  <span className={`px-2 py-0.5 text-[8px] font-black uppercase tracking-widest rounded border ${gov.includeInAccessReview ? 'bg-sky-400/10 text-sky-700 border-sky-400/20' : 'bg-slate-100 text-slate-500 border-slate-200'}`}>
                    {gov.includeInAccessReview ? 'In Future Access Review' : 'Not in Review Scope'}
                  </span>
                  <span
                    title="Future workflow — no temporary-elevation / PIM workflow exists today."
                    className={`px-2 py-0.5 text-[8px] font-black uppercase tracking-widest rounded border ${gov.eligibleForTemporaryElevation ? 'bg-teal-400/10 text-teal-700 border-teal-400/20' : 'bg-slate-100 text-slate-400 border-slate-200'}`}
                  >
                    {gov.eligibleForTemporaryElevation ? 'Temp Elevation Eligible — Future' : 'No Temp Elevation'}
                  </span>
                </div>
                {meta.notes && (
                  <p className="text-[11px] font-medium text-amber-700 bg-amber-400/10 border border-amber-400/20 rounded-xl px-3 py-2 leading-relaxed mb-3">
                    <span className="material-symbols-outlined text-[13px] align-middle mr-1">info</span>
                    {meta.notes}
                  </p>
                )}
                <p className="mt-auto text-[8px] font-black uppercase tracking-widest text-indigo-500">
                  UI-Gated Today · Server Enforcement Future
                </p>
              </div>
            );
          })}
        </div>

        <div className="bg-slate-50/70 border border-slate-200 rounded-[2rem] p-7" data-testid="future-role-concepts">
          <h3 className="text-sm font-black text-slate-700 uppercase tracking-widest flex items-center gap-2 mb-1">
            <span className="material-symbols-outlined text-base text-slate-400">schedule</span>
            Future / Deferred Role Concepts
          </h3>
          <p className="text-xs font-medium text-slate-500 mb-5 max-w-3xl">
            These are documented concepts only. They are <span className="font-black">not active roles</span>, are not
            wired into the resolver, defaults, or the permissions matrix, and cannot be assigned.
          </p>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {FUTURE_ROLE_CONCEPTS.map(concept => (
              <div key={concept.id} className="bg-white/70 border border-dashed border-slate-300 rounded-2xl p-5">
                <div className="flex items-center justify-between gap-2 mb-1.5">
                  <h4 className="text-sm font-black text-slate-600">{concept.displayLabel}</h4>
                  <span className="px-2 py-0.5 text-[8px] font-black uppercase tracking-widest rounded border bg-slate-100 text-slate-500 border-slate-200">
                    Future / Deferred
                  </span>
                </div>
                <p className="text-[11px] font-medium text-slate-500 leading-relaxed">{concept.purpose}</p>
              </div>
            ))}
          </div>
        </div>

        <div className="border-t border-slate-100" />
      </div>
    );
  };

  const renderRoles = () => (
    <div className="space-y-8">
      {renderRoleGovernanceCatalog()}
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
  // Non-blocking notice surfaced when a permission change auto-reconciled
  // one or more dependent or prerequisite permissions. Auto-dismisses after
  // a few seconds; explicit close also clears it.
  const [reconcileNotice, setReconcileNotice] = useState<
    | null
    | {
        role: Role;
        changedLabel: string;
        adjustments: PermissionAdjustment[];
        ts: number;
      }
  >(null);
  useEffect(() => {
    if (!reconcileNotice) return;
    const t = window.setTimeout(() => setReconcileNotice(null), 8000);
    return () => window.clearTimeout(t);
  }, [reconcileNotice?.ts]);

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
    const before = overrides;
    const next: PlatformPermissionsOverrides = { ...overrides };
    const roleEntry = { ...(next[role] || {}) };
    const features = { ...(roleEntry.features || {}) };
    features[featureKey] = level;
    roleEntry.features = features;
    next[role] = roleEntry;
    // Auto-reconcile dependents that became ineffective when the parent
    // feature was lowered. Raising a parent only increases inherited levels
    // and never violates a prereq, so reconciliation is a no-op in that
    // direction (handled inside the helper).
    const { next: reconciled, adjustments } =
      reconcileFeatureLevelChange(role, featureKey, oldLevel, level, next, before);
    setOverrides(reconciled);
    writePlatformPermissionsOverrides(reconciled);
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
    auditAdjustments(role, featureLabel, adjustments);
    if (adjustments.length > 0) {
      setReconcileNotice({ role, changedLabel: featureLabel, adjustments, ts: Date.now() });
    }
  };

  const setSubLevel = (role: Role, featureKey: PlatformFeatureKey, subKey: string, level: PermissionLevel) => {
    if (!isOwner || role === 'system_owner') return;
    const oldLevel = getPlatformSubPermissionLevel(role, subKey, overrides);
    if (oldLevel === level) return;
    const before = overrides;
    const next: PlatformPermissionsOverrides = { ...overrides };
    const roleEntry = { ...(next[role] || {}) };
    const subs = { ...(roleEntry.subs || {}) };
    subs[subKey] = level;
    roleEntry.subs = subs;
    next[role] = roleEntry;
    // Direction-aware auto-reconcile: raised → auto-raise prereqs; lowered
    // → auto-cap dependents. Lowering a dependent never touches its read-
    // only prerequisite (handled inside the helper). `before` is required
    // so the helper can detect "was previously allowed" transitions.
    const { next: reconciled, adjustments } =
      reconcileSubPermissionChange(role, subKey, oldLevel, level, next, before);
    setOverrides(reconciled);
    writePlatformPermissionsOverrides(reconciled);
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
    auditAdjustments(role, subDef?.label || subKey, adjustments);
    if (adjustments.length > 0) {
      setReconcileNotice({
        role,
        changedLabel: subDef?.label || subKey,
        adjustments,
        ts: Date.now(),
      });
    }
  };

  // Emit one `platform_permission_dependency_reconciled` audit row per
  // auto-adjustment. Deduplicates by subKey so a transitive chain that
  // somehow re-visits the same node never doubles up.
  const auditAdjustments = (
    role: Role,
    sourceLabel: string,
    adjustments: PermissionAdjustment[]
  ) => {
    if (!adjustments.length) return;
    const roleLabel = PLATFORM_ROLE_DISPLAY_LABEL[role];
    const seen = new Set<string>();
    for (const adj of adjustments) {
      if (seen.has(adj.subKey)) continue;
      seen.add(adj.subKey);
      pushPlatformAudit({
        actor: session?.user?.name || 'System Owner',
        action: 'platform_permission_dependency_reconciled',
        target: `${roleLabel} · ${adj.label}`,
        category: 'team',
        oldValue: adj.prevLevel,
        newValue: adj.nextLevel,
        severity: 'warning',
        note: adj.reason === 'prereq_auto_raised'
          ? `Auto-raised prerequisite to satisfy "${sourceLabel}".`
          : `Auto-capped — depends on "${sourceLabel}" which was lowered.`,
      });
    }
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
    setResetReason('');
    setShowResetConfirm(true);
  };

  const confirmReset = () => {
    // Defence in depth — the confirm button is also disabled until a reason is
    // entered. This is sensitive-action REASON CAPTURE only: the reset behavior
    // and its existing audit row are unchanged; no resolver/permission logic moves.
    if (resetReason.trim().length < 3) return;
    const overrideRoleCount = Object.keys(overrides).length;
    writePlatformPermissionsOverrides({});
    setOverrides({});
    logActivity('Reset Permissions', `All overrides cleared — reverted to default levels. Reason: ${resetReason.trim()}`);
    pushPlatformAudit({
      actor: session?.user?.name || 'System Owner',
      action: 'platform_permissions_reset',
      target: 'All roles',
      category: 'team',
      severity: 'warning',
      note: 'All overrides cleared to defaults',
    });
    // Phase 1.3 — Milestone 4: capture the reason for this sensitive action
    // (advisory/local — does NOT change the permission result or add enforcement).
    captureAndLogSensitiveAction({
      actionCategory: 'platform_sub_permission_override',
      actionLabel: 'Reset Global Permissions Matrix to defaults (all overrides cleared)',
      reason: resetReason.trim(),
      targetPermission: 'All platform roles · all overrides',
      beforeSummary: `${overrideRoleCount} role(s) had session overrides`,
      afterSummary: 'All overrides cleared to role defaults',
    });
    setShowResetConfirm(false);
    setResetReason('');
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
    // Phase 1.3 — Milestone 2: advisory governance summary for the previewed
    // role. Display only — the access grid below is still produced solely by the
    // unchanged resolver (explainAccessDecision / getPlatformFeatureLevel).
    const previewGov = isPlatformRoleId(previewRole) ? getRoleGovernanceSummary(previewRole) : null;
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
        {previewGov && (
          <div className="mb-4" data-testid="preview-governance-summary">
            <div className="flex flex-wrap gap-1.5 mb-2">
              <span className={`px-2 py-0.5 text-[8px] font-black uppercase tracking-widest rounded border ${RISK_POSTURE_BADGE_STYLE[previewGov.riskPostureLabel] || RISK_POSTURE_BADGE_STYLE.Moderate}`}>
                Risk: {previewGov.riskPostureLabel}
              </span>
              <span className="px-2 py-0.5 text-[8px] font-black uppercase tracking-widest rounded border bg-white text-indigo-700 border-indigo-200">
                {previewGov.governanceCategoryLabel}
              </span>
              <span className="px-2 py-0.5 text-[8px] font-black uppercase tracking-widest rounded border bg-white text-indigo-700 border-indigo-200">
                Review: {previewGov.reviewCadenceLabel}
              </span>
              {previewGov.systemProtected && (
                <span className="px-2 py-0.5 text-[8px] font-black uppercase tracking-widest rounded border bg-violet-400/10 text-violet-700 border-violet-400/20">
                  System Protected
                </span>
              )}
              <span className={`px-2 py-0.5 text-[8px] font-black uppercase tracking-widest rounded border ${previewGov.eligibleForTemporaryElevation ? 'bg-teal-400/10 text-teal-700 border-teal-400/20' : 'bg-slate-100 text-slate-400 border-slate-200'}`}>
                {previewGov.eligibleForTemporaryElevation ? 'Temp Elevation Eligible — Future' : 'No Temp Elevation'}
              </span>
            </div>
            <p className="text-[10px] font-medium text-indigo-500 leading-relaxed">
              Governance labels are <span className="font-black">advisory</span> and do not change the access decision
              below. Access is resolved by the unchanged permissions matrix and is UI/client-gated only.
            </p>
          </div>
        )}
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
          <p><span className="font-black uppercase tracking-widest">Governance:</span> <span className="font-black">sensitive</span> sub-permissions are flagged, and risk-posture / review-cadence / enforcement-tier guidance comes from the Phase 1.3 advisory governance model. These are display labels only and never change a permission level, threshold, or access decision.</p>
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

      {reconcileNotice && (
        <div
          className="bg-indigo-50 border border-indigo-200 rounded-2xl p-4 mb-4 flex items-start gap-3"
          data-testid="permission-reconciliation-notice"
        >
          <span className="material-symbols-outlined text-indigo-600 text-lg mt-0.5">auto_fix_high</span>
          <div className="flex-1 text-xs text-indigo-900 leading-relaxed">
            <p className="font-black uppercase tracking-widest text-indigo-700 mb-1">
              Dependent permissions adjusted to preserve least-privilege consistency
            </p>
            <p className="font-medium mb-1.5">
              Changing <span className="font-black">"{reconcileNotice.changedLabel}"</span> for{' '}
              <span className="font-black">{PLATFORM_ROLE_DISPLAY_LABEL[reconcileNotice.role]}</span>{' '}
              auto-{reconcileNotice.adjustments[0]?.reason === 'prereq_auto_raised' ? 'raised' : 'capped'} the following:
            </p>
            <ul className="space-y-0.5 list-disc list-inside font-medium">
              {reconcileNotice.adjustments.map(adj => (
                <li key={adj.subKey}>
                  <span className="font-black">{adj.label}</span>:{' '}
                  {PLATFORM_PERMISSION_LEVEL_LABEL[adj.prevLevel]} → {PLATFORM_PERMISSION_LEVEL_LABEL[adj.nextLevel]}{' '}
                  <span className="text-indigo-600">
                    ({adj.reason === 'prereq_auto_raised'
                      ? 'prerequisite auto-raised'
                      : 'dependent auto-capped'})
                  </span>
                </li>
              ))}
            </ul>
          </div>
          <button
            onClick={() => setReconcileNotice(null)}
            className="text-indigo-400 hover:text-indigo-700"
            aria-label="Dismiss"
          >
            <span className="material-symbols-outlined text-sm">close</span>
          </button>
        </div>
      )}

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

  // =========================================================================
  // Phase 1.3 — Milestone 3: Temporary Access / PIM Foundation
  //
  // A session-scoped store of temporary-access grants with reason-required
  // lifecycle transitions and a per-grant audit-style trail. Everything here is
  // ADVISORY / NON-ENFORCING: a grant never changes a member's real permissions
  // (the resolver / matrix are untouched), expiry is DERIVED/LAZY (no scheduler,
  // no automatic revocation), and gating mirrors the rest of this page
  // (System Owner only — no new permission keys).
  // =========================================================================
  const [tempGrants, setTempGrants] = useState<StoredTemporaryAccessGrant[]>(() => readTemporaryAccessGrants());
  // `nowTick` drives DERIVED status. There is NO scheduler — it only advances
  // when the operator clicks "Refresh status" or performs a lifecycle action.
  const [nowTick, setNowTick] = useState<number>(() => Date.now());
  const [showTempRequestModal, setShowTempRequestModal] = useState(false);
  const [tempForm, setTempForm] = useState<{ subjectId: string; elevatedRoleId: string; durationId: string; reason: string }>(
    () => ({ subjectId: '', elevatedRoleId: '', durationId: TEMPORARY_ACCESS_DURATION_PRESETS[3].id, reason: '' })
  );
  const [tempActionTarget, setTempActionTarget] = useState<{ grant: StoredTemporaryAccessGrant; action: TemporaryAccessLifecycleAction } | null>(null);
  const [tempActionReason, setTempActionReason] = useState('');
  const [tempError, setTempError] = useState<string | null>(null);
  const [expandedTempHistory, setExpandedTempHistory] = useState<Record<string, boolean>>({});

  useEffect(() => {
    const onChange = () => setTempGrants(readTemporaryAccessGrants());
    window.addEventListener(TEMPORARY_ACCESS_CHANGED_EVENT, onChange);
    window.addEventListener('storage', onChange);
    return () => {
      window.removeEventListener(TEMPORARY_ACCESS_CHANGED_EVENT, onChange);
      window.removeEventListener('storage', onChange);
    };
  }, []);

  // Lifecycle action → platform-audit action (additive, defined in platformOpsAudit).
  const TEMP_AUDIT_ACTION = {
    request: 'platform_temporary_access_requested',
    approve: 'platform_temporary_access_approved',
    deny: 'platform_temporary_access_denied',
    revoke: 'platform_temporary_access_revoked',
    cancel: 'platform_temporary_access_cancelled',
  } as const;

  const persistTempGrants = (next: StoredTemporaryAccessGrant[]) => {
    writeTemporaryAccessGrants(next);
    setTempGrants(next);
    setNowTick(Date.now());
  };

  // Mirror each transition to BOTH the in-page Activity Log and the shared
  // platform audit (same dual pattern used by role/permission changes above).
  const auditTempAccess = (action: TemporaryAccessLifecycleAction, grant: StoredTemporaryAccessGrant, reason: string) => {
    const actor = session?.user?.name || 'System Owner';
    const subject = `${grant.subjectName} (${grant.subjectEmail})`;
    const elevation = grant.elevatedRoleLabel || grant.elevatedPermissionScope || 'unspecified elevation';
    logActivity(
      `Temp Access ${TEMP_ACCESS_ACTION_VERB[action]}`,
      `${TEMP_ACCESS_ACTION_VERB[action]} temporary elevation (${elevation}) for ${subject} — reason: ${reason}`
    );
    pushPlatformAudit({
      actor,
      action: TEMP_AUDIT_ACTION[action],
      target: `${subject} · ${elevation}`,
      category: 'team',
      note: `Reason: ${reason}. Advisory/non-enforcing — no real permission change applied.`,
    });
  };

  const handleRequestTempAccess = () => {
    setTempError(null);
    const member = team.find(m => m.id === tempForm.subjectId);
    if (!member) { setTempError('Select a team member to elevate.'); return; }
    const baseRoleId = resolvePlatformRoleId(member.role);
    if (!baseRoleId) { setTempError('Selected member has a non-catalog/custom role and is not eligible for this foundation.'); return; }
    const duration = TEMPORARY_ACCESS_DURATION_PRESETS.find(d => d.id === tempForm.durationId);
    if (!duration) { setTempError('Select a duration.'); return; }
    const elevatedRoleId = tempForm.elevatedRoleId ? (tempForm.elevatedRoleId as PlatformRoleId) : undefined;
    const elevatedRoleLabel = elevatedRoleId ? PLATFORM_ROLE_CATALOG[elevatedRoleId].displayLabel : undefined;
    const res = createTemporaryAccessRequest({
      subjectUserId: member.id,
      subjectName: member.name,
      subjectEmail: member.email,
      baseRoleId,
      elevatedRoleId,
      elevatedRoleLabel,
      requestedBy: session?.user?.name || 'System Owner',
      reason: tempForm.reason,
      durationMs: duration.ms,
      now: Date.now(),
    });
    if (!res.ok || !res.grant) { setTempError(res.error || 'Could not create the request.'); return; }
    persistTempGrants([res.grant, ...tempGrants]);
    auditTempAccess('request', res.grant, res.grant.reason);
    setShowTempRequestModal(false);
    setTempForm({ subjectId: '', elevatedRoleId: '', durationId: TEMPORARY_ACCESS_DURATION_PRESETS[3].id, reason: '' });
  };

  const handleTempAction = () => {
    if (!tempActionTarget) return;
    setTempError(null);
    const { grant, action } = tempActionTarget;
    const actor = session?.user?.name || 'System Owner';
    const now = Date.now();
    const res =
      action === 'approve' ? approveTemporaryAccess(grant, actor, tempActionReason, now) :
      action === 'deny' ? denyTemporaryAccess(grant, actor, tempActionReason, now) :
      action === 'revoke' ? revokeTemporaryAccess(grant, actor, tempActionReason, now) :
      action === 'cancel' ? cancelTemporaryAccess(grant, actor, tempActionReason, now) :
      { ok: false as const, error: 'Unsupported action.' };
    if (!res.ok || !res.grant) { setTempError(res.error || 'Action failed.'); return; }
    const updated = res.grant;
    persistTempGrants(tempGrants.map(g => (g.id === updated.id ? updated : g)));
    auditTempAccess(action, updated, tempActionReason.trim());
    setTempActionTarget(null);
    setTempActionReason('');
  };

  // Catalog-role members eligible for temporary elevation (System Owner is
  // system-protected and excluded). Shared by the tab + the request modal.
  const tempEligibleSubjects = team
    .map(m => ({ member: m, roleId: resolvePlatformRoleId(m.role) }))
    .filter((x): x is { member: TeamMember; roleId: PlatformRoleId } =>
      !!x.roleId && PLATFORM_ROLE_CATALOG[x.roleId].eligibleForTemporaryElevation);
  const tempElevationTargets = (Object.keys(PLATFORM_ROLE_CATALOG) as PlatformRoleId[]).filter(id => id !== 'system_owner');

  const renderTemporaryAccess = () => {
    const summary = summarizeTemporaryAccess(tempGrants, nowTick);
    const counts: { key: TemporaryAccessStatus | 'total'; label: string }[] = [
      { key: 'total', label: 'Total' },
      { key: 'requested', label: 'Requested' },
      { key: 'active', label: 'Active' },
      { key: 'expired', label: 'Expired' },
      { key: 'revoked', label: 'Revoked' },
      { key: 'denied', label: 'Denied' },
      { key: 'cancelled', label: 'Cancelled' },
    ];
    return (
      <div className="space-y-6" data-testid="temporary-access-tab">
        {/* Truthful, standing non-enforcement banner. */}
        <div className="bg-teal-50/70 border border-teal-200/70 rounded-2xl p-4 flex items-start gap-3" data-testid="temp-access-truth-banner">
          <span className="material-symbols-outlined text-teal-700 text-lg mt-0.5">timer</span>
          <div className="text-xs font-medium text-teal-900 leading-relaxed space-y-1">
            <p className="font-black uppercase tracking-widest text-teal-800">Temporary Access / PIM — Foundation (Advisory)</p>
            <p>{TEMPORARY_ACCESS_MODEL_STATUS}</p>
            <p className="text-[11px] text-teal-600">
              Every lifecycle action (request, approve/grant, deny, revoke, cancel) <span className="font-black">requires a reason</span> and is recorded in the grant's local trail and the platform Audit &amp; Security log.
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <h2 className="text-2xl font-black text-primary tracking-tight">Temporary Access</h2>
            <p className="text-slate-500 text-sm font-medium mt-1 max-w-3xl">
              Time-boxed elevation requests for platform team members. Granting a request does{' '}
              <span className="font-black">not</span> change the member's real permissions — it records an advisory,
              derived-expiry grant only.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setNowTick(Date.now())}
              data-testid="temp-access-refresh"
              title="Recompute derived statuses now. Expiry is lazy — there is no background scheduler."
              className="px-4 py-2.5 bg-slate-100 hover:bg-slate-200 text-slate-600 font-black text-[10px] rounded-xl uppercase tracking-widest transition-all flex items-center gap-1.5"
            >
              <span className="material-symbols-outlined text-sm">refresh</span>
              Refresh Status
            </button>
            {isOwner && (
              <button
                onClick={() => { setTempError(null); setShowTempRequestModal(true); }}
                data-testid="temp-access-request-btn"
                className="px-6 py-2.5 bg-primary text-white font-black text-[10px] rounded-xl hover:bg-primary/90 transition-all shadow-lg shadow-primary/20 uppercase tracking-widest flex items-center gap-2"
              >
                <span className="material-symbols-outlined text-sm">add_moderator</span>
                Request Temporary Access
              </button>
            )}
          </div>
        </div>

        {/* Derived summary counts — single source (summarizeTemporaryAccess over
            the same list/nowTick that drives the rows), so they cannot drift. */}
        <div className="flex flex-wrap gap-2" data-testid="temp-access-summary">
          {counts.map(c => (
            <span
              key={c.key}
              className={`px-3 py-1.5 text-[10px] font-black uppercase tracking-widest rounded-xl border ${
                c.key === 'total'
                  ? 'bg-white text-slate-600 border-slate-200'
                  : TEMP_ACCESS_STATUS_BADGE_STYLE[c.key as TemporaryAccessStatus]
              }`}
            >
              {c.label}: {summary[c.key]}
            </span>
          ))}
        </div>

        {tempGrants.length === 0 ? (
          <div className="bg-white/80 backdrop-blur-xl rounded-[2.5rem] border border-slate-200 p-12 text-center shadow-sm" data-testid="temp-access-empty">
            <span className="material-symbols-outlined text-4xl text-slate-300 mb-2 block">schedule</span>
            <p className="text-sm font-bold text-slate-500">No temporary-access grants yet.</p>
            <p className="text-xs font-medium text-slate-400 mt-1">
              {isOwner ? 'Use “Request Temporary Access” to create an advisory, time-boxed elevation request.' : 'Only System Owner can create temporary-access requests.'}
            </p>
          </div>
        ) : (
          <div className="bg-white/80 backdrop-blur-xl rounded-[2.5rem] border border-slate-200 overflow-hidden shadow-sm">
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse min-w-[1080px]">
                <thead>
                  <tr className="border-b border-slate-100 bg-slate-50/50">
                    <th className="px-6 py-5 text-[10px] font-black text-slate-400 uppercase tracking-widest">Subject</th>
                    <th className="px-6 py-5 text-[10px] font-black text-slate-400 uppercase tracking-widest">Requested Elevation <span className="text-slate-300 normal-case tracking-normal">(advisory — not applied)</span></th>
                    <th className="px-6 py-5 text-[10px] font-black text-slate-400 uppercase tracking-widest">Window</th>
                    <th className="px-6 py-5 text-[10px] font-black text-slate-400 uppercase tracking-widest">Derived Status</th>
                    <th className="px-6 py-5 text-[10px] font-black text-slate-400 uppercase tracking-widest text-right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {tempGrants.map(grant => {
                    const derived = getTemporaryAccessStatus(grant, nowTick);
                    const actions = isOwner ? availableTemporaryAccessActions(grant, nowTick) : [];
                    const historyOpen = !!expandedTempHistory[grant.id];
                    return (
                      <React.Fragment key={grant.id}>
                        <tr className="border-b border-slate-50 last:border-0 align-top hover:bg-slate-50/50 transition-colors" data-testid={`temp-access-row-${grant.id}`}>
                          <td className="px-6 py-5">
                            <p className="text-sm font-black text-primary">{grant.subjectName}</p>
                            <p className="text-xs font-bold text-slate-500 mt-0.5">{grant.subjectEmail}</p>
                            <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mt-1">
                              Base: {PLATFORM_ROLE_CATALOG[grant.baseRoleId]?.displayLabel || grant.baseRoleId}
                            </p>
                          </td>
                          <td className="px-6 py-5">
                            <span className="inline-block px-2.5 py-1 bg-teal-400/10 text-teal-700 border border-teal-400/20 text-[10px] font-black uppercase tracking-widest rounded-lg">
                              {grant.elevatedRoleLabel || grant.elevatedPermissionScope || 'Unspecified'}
                            </span>
                            <p className="text-[10px] font-medium text-slate-400 mt-1.5 max-w-[240px]">Reason: {grant.reason}</p>
                          </td>
                          <td className="px-6 py-5">
                            <p className="text-[11px] font-bold text-slate-600">Requested: {TEMPORARY_ACCESS_DURATION_PRESETS.find(d => d.ms === grant.requestedDurationMs)?.label || `${Math.round(grant.requestedDurationMs / 3600000)}h`}</p>
                            <p className="text-[10px] font-medium text-slate-400 mt-0.5">Starts: {grant.startsAt.slice(0, 16).replace('T', ' ')}</p>
                            <p className="text-[10px] font-medium text-slate-400">Expires: {grant.expiresAt.slice(0, 16).replace('T', ' ')}</p>
                          </td>
                          <td className="px-6 py-5">
                            <span className={`px-3 py-1 text-[10px] font-black uppercase tracking-widest rounded-lg border ${TEMP_ACCESS_STATUS_BADGE_STYLE[derived]}`}>
                              {getTemporaryAccessDisplayLabel(grant, nowTick)}
                            </span>
                            <button
                              onClick={() => setExpandedTempHistory(prev => ({ ...prev, [grant.id]: !prev[grant.id] }))}
                              className="block mt-2 text-[9px] font-black uppercase tracking-widest text-indigo-500 hover:text-indigo-700"
                              data-testid={`temp-access-history-toggle-${grant.id}`}
                            >
                              {historyOpen ? 'Hide trail' : `Trail (${grant.history.length})`}
                            </button>
                          </td>
                          <td className="px-6 py-5 text-right">
                            {actions.length === 0 ? (
                              <span className="text-[10px] font-bold text-slate-300 uppercase tracking-widest">{isOwner ? 'No actions' : 'View only'}</span>
                            ) : (
                              <div className="flex flex-wrap gap-1.5 justify-end">
                                {actions.map(action => (
                                  <button
                                    key={action}
                                    onClick={() => { setTempError(null); setTempActionReason(''); setTempActionTarget({ grant, action }); }}
                                    data-testid={`temp-access-action-${action}-${grant.id}`}
                                    className={`px-3 py-1.5 text-[9px] font-black uppercase tracking-widest rounded-lg border transition-all ${
                                      action === 'approve' ? 'bg-emerald-50 text-emerald-700 border-emerald-200 hover:bg-emerald-100' :
                                      action === 'revoke' ? 'bg-red-50 text-red-600 border-red-200 hover:bg-red-100' :
                                      action === 'deny' ? 'bg-orange-50 text-orange-700 border-orange-200 hover:bg-orange-100' :
                                      'bg-slate-50 text-slate-600 border-slate-200 hover:bg-slate-100'
                                    }`}
                                  >
                                    {TEMP_ACCESS_ACTION_VERB[action]}
                                  </button>
                                ))}
                              </div>
                            )}
                          </td>
                        </tr>
                        {historyOpen && (
                          <tr className="bg-slate-50/60" data-testid={`temp-access-history-${grant.id}`}>
                            <td colSpan={5} className="px-6 py-4">
                              <p className="text-[10px] font-black uppercase tracking-widest text-slate-400 mb-2">Lifecycle Trail — reason captured per transition</p>
                              <ul className="space-y-1.5">
                                {grant.history.map(ev => (
                                  <li key={ev.id} className="text-[11px] font-medium text-slate-600 flex flex-wrap items-baseline gap-x-2">
                                    <span className="font-black text-slate-700">{TEMP_ACCESS_ACTION_VERB[ev.action]}</span>
                                    <span className="text-slate-400">{ev.at.slice(0, 16).replace('T', ' ')}</span>
                                    <span className="text-slate-400">by {ev.actor}</span>
                                    {ev.fromStatus && <span className="text-slate-400">· {ev.fromStatus} → {ev.toStatus}</span>}
                                    {!ev.fromStatus && <span className="text-slate-400">· → {ev.toStatus}</span>}
                                    <span className="text-slate-500">— {ev.reason}</span>
                                  </li>
                                ))}
                              </ul>
                            </td>
                          </tr>
                        )}
                      </React.Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {tempEligibleSubjects.length === 0 && (
          <p className="text-[11px] font-medium text-slate-400">
            No catalog-role team members are currently eligible for temporary elevation (System Owner is system-protected and excluded).
          </p>
        )}
      </div>
    );
  };

  // =========================================================================
  // Phase 1.3 — Milestone 4: Access Review + Sensitive Action Reason Capture
  //
  // A session-scoped store of access-review records with reason-required
  // completion outcomes (reviewed_no_change / reviewed_change_required /
  // escalated / deferred), derived overdue/stale labels, a per-record trail,
  // and a parallel log of reason-captured sensitive governance actions.
  // Everything here is ADVISORY / NON-ENFORCING: an outcome NEVER changes a
  // role, a permission, the resolver, defaults, thresholds, or dependency
  // auto-sync; overdue is DERIVED/LAZY (no scheduler, no reminders, no
  // automatic revocation); gating mirrors the rest of this page (System Owner
  // only — no new permission keys). The shared `nowTick` drives derived status.
  // =========================================================================
  const [accessReviews, setAccessReviews] = useState<StoredAccessReviewRecord[]>(() => readAccessReviewRecords());
  const [sensitiveReasons, setSensitiveReasons] = useState<SensitiveActionReasonCapture[]>(() => readSensitiveActionReasons());
  const [showReviewCreateModal, setShowReviewCreateModal] = useState(false);
  const [reviewForm, setReviewForm] = useState<{ subjectId: string; reviewPeriod: string; findings: string; notes: string }>(
    () => ({ subjectId: '', reviewPeriod: defaultReviewPeriod(), findings: '', notes: '' })
  );
  const [reviewActionTarget, setReviewActionTarget] = useState<StoredAccessReviewRecord | null>(null);
  const [reviewOutcome, setReviewOutcome] = useState<AccessReviewOutcome>('reviewed_no_change');
  const [reviewActionReason, setReviewActionReason] = useState('');
  const [reviewActionFindings, setReviewActionFindings] = useState('');
  const [reviewError, setReviewError] = useState<string | null>(null);
  const [expandedReviewHistory, setExpandedReviewHistory] = useState<Record<string, boolean>>({});

  useEffect(() => {
    const onChange = () => {
      setAccessReviews(readAccessReviewRecords());
      setSensitiveReasons(readSensitiveActionReasons());
    };
    window.addEventListener(ACCESS_REVIEW_CHANGED_EVENT, onChange);
    window.addEventListener(SENSITIVE_ACTION_REASON_CHANGED_EVENT, onChange);
    window.addEventListener('storage', onChange);
    return () => {
      window.removeEventListener(ACCESS_REVIEW_CHANGED_EVENT, onChange);
      window.removeEventListener(SENSITIVE_ACTION_REASON_CHANGED_EVENT, onChange);
      window.removeEventListener('storage', onChange);
    };
  }, []);

  // Outcome → additive platform-audit action (defined in platformOpsAudit).
  const REVIEW_AUDIT_ACTION = {
    reviewed_no_change: 'access_review_completed',
    reviewed_change_required: 'access_review_change_required',
    escalated: 'access_review_escalated',
    deferred: 'access_review_deferred',
  } as const;

  const persistReviews = (next: StoredAccessReviewRecord[]) => {
    writeAccessReviewRecords(next);
    setAccessReviews(next);
    setNowTick(Date.now());
  };

  // Sensitive Action Reason Capture: write the reason to the local advisory log
  // (visible in the M4 panel) + the in-page Activity Log. The shared
  // `sensitive_action_reason_captured` audit row is pushed by default; callers
  // that already emit their own action row (e.g. access-review outcomes, which
  // emit an `access_review_*` row) pass `pushAuditRow: false` to avoid spam.
  const captureAndLogSensitiveAction = (
    input: Omit<SensitiveActionCaptureInput, 'actor' | 'now'>,
    options?: { pushAuditRow?: boolean }
  ): boolean => {
    const actor = session?.user?.name || 'System Owner';
    const res = captureSensitiveActionReason({ ...input, actor, now: Date.now() });
    if (!res.ok || !res.record) return false;
    const next = [res.record, ...readSensitiveActionReasons()];
    writeSensitiveActionReasons(next);
    setSensitiveReasons(next);
    logActivity('Sensitive Action Reason', `${input.actionLabel} — reason: ${input.reason}`);
    if (options?.pushAuditRow !== false) {
      pushPlatformAudit({
        actor,
        action: 'sensitive_action_reason_captured',
        target: input.targetSubject || input.targetPermission || input.actionLabel,
        category: 'team',
        note: `${input.actionLabel}. Reason: ${input.reason}. ${SENSITIVE_ACTION_REASON_ADVISORY_LABEL}`,
      });
    }
    return true;
  };

  const auditAccessReview = (outcome: AccessReviewOutcome, record: StoredAccessReviewRecord, reason: string) => {
    const actor = session?.user?.name || 'System Owner';
    const subject = `${record.reviewedSubjectName} · ${record.reviewedRoleLabel}`;
    logActivity(
      `Access Review ${ACCESS_REVIEW_OUTCOME_LABEL[outcome]}`,
      `${subject} [${record.reviewPeriod}] — reason: ${reason}`
    );
    pushPlatformAudit({
      actor,
      action: REVIEW_AUDIT_ACTION[outcome],
      target: `${subject} · ${record.reviewPeriod}`,
      category: 'team',
      note:
        `Reason: ${reason}. Advisory/non-enforcing — no role or permission change applied.` +
        (record.systemProtected ? ' System Owner is system-protected (no downgrade).' : ''),
    });
  };

  const handleCreateReview = () => {
    setReviewError(null);
    const member = team.find(m => m.id === reviewForm.subjectId);
    if (!member) { setReviewError('Select a team member to review.'); return; }
    const resolvedRoleId = resolvePlatformRoleId(member.role);
    const actor = session?.user?.name || 'System Owner';
    const res = createAccessReviewRecord({
      reviewPeriod: reviewForm.reviewPeriod,
      reviewedSubjectId: member.id,
      reviewedSubjectName: member.name,
      reviewedRoleId: resolvedRoleId,
      reviewedRoleLabel: member.role,
      reviewerId: actor,
      reviewerName: actor,
      createdBy: actor,
      findings: reviewForm.findings || undefined,
      notes: reviewForm.notes || undefined,
      now: Date.now(),
    });
    if (!res.ok || !res.record) { setReviewError(res.error || 'Could not create the review record.'); return; }
    const created = res.record;
    persistReviews([created, ...accessReviews]);
    logActivity('Access Review Created', `${created.reviewedSubjectName} · ${created.reviewedRoleLabel} [${created.reviewPeriod}]`);
    pushPlatformAudit({
      actor,
      action: 'access_review_created',
      target: `${created.reviewedSubjectName} · ${created.reviewedRoleLabel} · ${created.reviewPeriod}`,
      category: 'team',
      note:
        'Pending access review created. Advisory/non-enforcing — no permission change applied.' +
        (created.systemProtected ? ' System Owner is system-protected — review carefully; no downgrade.' : ''),
    });
    setShowReviewCreateModal(false);
    setReviewForm({ subjectId: '', reviewPeriod: defaultReviewPeriod(), findings: '', notes: '' });
  };

  // Duplicate-safe seeding: one pending record per current team member for the
  // default period, skipping members who already have a pending record for it.
  const handleSeedReviews = () => {
    const actor = session?.user?.name || 'System Owner';
    const period = defaultReviewPeriod();
    const existingPending = new Set(
      accessReviews.filter(r => r.reviewStatus === 'pending' && r.reviewPeriod === period).map(r => r.reviewedSubjectId)
    );
    const created: StoredAccessReviewRecord[] = [];
    team.forEach(member => {
      if (existingPending.has(member.id)) return;
      const resolvedRoleId = resolvePlatformRoleId(member.role);
      const res = createAccessReviewRecord({
        reviewPeriod: period,
        reviewedSubjectId: member.id,
        reviewedSubjectName: member.name,
        reviewedRoleId: resolvedRoleId,
        reviewedRoleLabel: member.role,
        reviewerId: actor,
        reviewerName: actor,
        createdBy: actor,
        now: Date.now(),
      });
      if (res.ok && res.record) created.push(res.record);
    });
    if (created.length === 0) { setReviewError(`Every current team member already has a pending review for ${period}.`); return; }
    setReviewError(null);
    persistReviews([...created, ...accessReviews]);
    created.forEach(rec => {
      pushPlatformAudit({
        actor,
        action: 'access_review_created',
        target: `${rec.reviewedSubjectName} · ${rec.reviewedRoleLabel} · ${rec.reviewPeriod}`,
        category: 'team',
        note:
          'Seeded pending access review. Advisory/non-enforcing — no permission change applied.' +
          (rec.systemProtected ? ' System Owner is system-protected.' : ''),
      });
    });
    logActivity('Access Review Seeded', `Created ${created.length} pending review(s) for ${period}`);
  };

  const handleCompleteReview = () => {
    if (!reviewActionTarget) return;
    setReviewError(null);
    const actor = session?.user?.name || 'System Owner';
    const res = completeAccessReview(reviewActionTarget, {
      outcome: reviewOutcome,
      actor,
      reason: reviewActionReason,
      findings: reviewActionFindings || undefined,
      now: Date.now(),
    });
    if (!res.ok || !res.record) { setReviewError(res.error || 'Could not record the outcome.'); return; }
    const updated = res.record;
    persistReviews(accessReviews.map(r => (r.id === updated.id ? updated : r)));
    auditAccessReview(reviewOutcome, updated, reviewActionReason.trim());
    // The outcome is itself a sensitive governance action — log its reason to
    // the shared sensitive-action log (no second audit row; auditAccessReview
    // already emitted the access_review_* row).
    captureAndLogSensitiveAction(
      {
        actionCategory: 'access_review_completion',
        actionLabel: `Access review outcome: ${ACCESS_REVIEW_OUTCOME_LABEL[reviewOutcome]}`,
        reason: reviewActionReason.trim(),
        targetSubject: `${updated.reviewedSubjectName} · ${updated.reviewedRoleLabel}`,
        beforeSummary: 'pending',
        afterSummary: reviewOutcome + (updated.systemProtected ? ' (System Owner — no downgrade, no permission change)' : ''),
      },
      { pushAuditRow: false }
    );
    setReviewActionTarget(null);
    setReviewActionReason('');
    setReviewActionFindings('');
  };

  const renderAccessReview = () => {
    const summary = summarizeAccessReviews(accessReviews, nowTick);
    const counts: { key: AccessReviewStatus | 'total' | 'actionRequired'; label: string }[] = [
      { key: 'total', label: 'Total' },
      { key: 'pending', label: 'Pending' },
      { key: 'overdue', label: 'Overdue (derived)' },
      { key: 'reviewed_no_change', label: 'No Change' },
      { key: 'reviewed_change_required', label: 'Change Required' },
      { key: 'escalated', label: 'Escalated' },
      { key: 'deferred', label: 'Deferred' },
      { key: 'actionRequired', label: 'Action Required' },
    ];
    return (
      <div className="space-y-6" data-testid="access-review-tab">
        {/* Truthful, standing advisory notice (required verbatim copy). */}
        <div className="bg-sky-50/70 border border-sky-200/70 rounded-2xl p-4 flex items-start gap-3" data-testid="access-review-truth-banner">
          <span className="material-symbols-outlined text-sky-700 text-lg mt-0.5">fact_check</span>
          <div className="text-xs font-medium text-sky-900 leading-relaxed space-y-1">
            <p className="font-black uppercase tracking-widest text-sky-800">Access Review Foundation (Advisory)</p>
            <p>
              Access review records in this phase are local/advisory governance records. They help document review
              decisions but do not automatically change roles, permissions, or server-side access. Backend enforcement
              and compliance evidence automation are future/deferred.
            </p>
            <p className="text-[11px] text-sky-600">{ACCESS_REVIEW_MODEL_STATUS}</p>
            <p className="text-[11px] text-sky-600">
              Completing, escalating, deferring, or flagging a change as required <span className="font-black">requires a reason</span>; overdue/stale is a derived label (no scheduler, no automatic reminders or revocation).
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <h2 className="text-2xl font-black text-primary tracking-tight">Access Review</h2>
            <p className="text-slate-500 text-sm font-medium mt-1 max-w-3xl">
              Document periodic access reviews for platform team members. Recording an outcome — including{' '}
              <span className="font-black">change required</span> — does <span className="font-black">not</span> change the
              member's real role or permissions; it records an advisory governance decision only.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setNowTick(Date.now())}
              data-testid="access-review-refresh"
              title="Recompute derived overdue/stale labels now. There is no background scheduler."
              className="px-4 py-2.5 bg-slate-100 hover:bg-slate-200 text-slate-600 font-black text-[10px] rounded-xl uppercase tracking-widest transition-all flex items-center gap-1.5"
            >
              <span className="material-symbols-outlined text-sm">refresh</span>
              Refresh Status
            </button>
            {isOwner && (
              <>
                <button
                  onClick={handleSeedReviews}
                  data-testid="access-review-seed-btn"
                  title={`Create pending review records for current team members for ${defaultReviewPeriod()} (duplicate-safe).`}
                  className="px-4 py-2.5 bg-slate-100 hover:bg-slate-200 text-slate-600 font-black text-[10px] rounded-xl uppercase tracking-widest transition-all flex items-center gap-1.5"
                >
                  <span className="material-symbols-outlined text-sm">playlist_add</span>
                  Seed Team Reviews
                </button>
                <button
                  onClick={() => { setReviewError(null); setReviewForm({ subjectId: '', reviewPeriod: defaultReviewPeriod(), findings: '', notes: '' }); setShowReviewCreateModal(true); }}
                  data-testid="access-review-create-btn"
                  className="px-6 py-2.5 bg-primary text-white font-black text-[10px] rounded-xl hover:bg-primary/90 transition-all shadow-lg shadow-primary/20 uppercase tracking-widest flex items-center gap-2"
                >
                  <span className="material-symbols-outlined text-sm">add_task</span>
                  Create Review Record
                </button>
              </>
            )}
          </div>
        </div>

        {reviewError && !showReviewCreateModal && !reviewActionTarget && (
          <p className="text-[11px] font-bold text-amber-700 bg-amber-50 border border-amber-200 rounded-xl px-3 py-2" data-testid="access-review-inline-error">{reviewError}</p>
        )}

        {/* Single-source derived summary counts (summarizeAccessReviews over the
            same list/nowTick that drives the rows) — counts cannot drift. */}
        <div className="flex flex-wrap gap-2" data-testid="access-review-summary">
          {counts.map(c => (
            <span
              key={c.key}
              className={`px-3 py-1.5 text-[10px] font-black uppercase tracking-widest rounded-xl border ${
                c.key === 'total' || c.key === 'actionRequired'
                  ? 'bg-white text-slate-600 border-slate-200'
                  : ACCESS_REVIEW_STATUS_BADGE_STYLE[c.key as AccessReviewStatus]
              }`}
            >
              {c.label}: {summary[c.key]}
            </span>
          ))}
        </div>

        {accessReviews.length === 0 ? (
          <div className="bg-white/80 backdrop-blur-xl rounded-[2.5rem] border border-slate-200 p-12 text-center shadow-sm" data-testid="access-review-empty">
            <span className="material-symbols-outlined text-4xl text-slate-300 mb-2 block">fact_check</span>
            <p className="text-sm font-bold text-slate-500">No access review records yet.</p>
            <p className="text-xs font-medium text-slate-400 mt-1">
              {isOwner ? 'Use “Create Review Record” or “Seed Team Reviews” to start an advisory access review.' : 'Only System Owner can create access review records.'}
            </p>
          </div>
        ) : (
          <div className="bg-white/80 backdrop-blur-xl rounded-[2.5rem] border border-slate-200 overflow-hidden shadow-sm">
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse min-w-[1140px]">
                <thead>
                  <tr className="border-b border-slate-100 bg-slate-50/50">
                    <th className="px-6 py-5 text-[10px] font-black text-slate-400 uppercase tracking-widest">Reviewed Subject</th>
                    <th className="px-6 py-5 text-[10px] font-black text-slate-400 uppercase tracking-widest">Role &amp; Cadence</th>
                    <th className="px-6 py-5 text-[10px] font-black text-slate-400 uppercase tracking-widest">Period / Reviewer</th>
                    <th className="px-6 py-5 text-[10px] font-black text-slate-400 uppercase tracking-widest">Status <span className="text-slate-300 normal-case tracking-normal">(advisory)</span></th>
                    <th className="px-6 py-5 text-[10px] font-black text-slate-400 uppercase tracking-widest">Reviewed / Updated</th>
                    <th className="px-6 py-5 text-[10px] font-black text-slate-400 uppercase tracking-widest text-right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {accessReviews.map(record => {
                    const derived = deriveAccessReviewStatus(record, nowTick);
                    const actions = isOwner ? availableAccessReviewActions(record, nowTick) : [];
                    const historyOpen = !!expandedReviewHistory[record.id];
                    return (
                      <React.Fragment key={record.id}>
                        <tr className="border-b border-slate-50 last:border-0 align-top hover:bg-slate-50/50 transition-colors" data-testid={`access-review-row-${record.id}`}>
                          <td className="px-6 py-5">
                            <p className="text-sm font-black text-primary">{record.reviewedSubjectName}</p>
                            {record.systemProtected && (
                              <div className="flex flex-wrap gap-1 mt-1.5" data-testid={`access-review-sysowner-${record.id}`}>
                                <span className="px-2 py-0.5 text-[8px] font-black uppercase tracking-widest rounded border bg-violet-400/10 text-violet-700 border-violet-400/20">System Protected</span>
                                <span className="px-2 py-0.5 text-[8px] font-black uppercase tracking-widest rounded border bg-violet-400/10 text-violet-700 border-violet-400/20">Review Carefully</span>
                                <span className="px-2 py-0.5 text-[8px] font-black uppercase tracking-widest rounded border bg-slate-100 text-slate-500 border-slate-200">No Automatic Downgrade</span>
                                <span className="px-2 py-0.5 text-[8px] font-black uppercase tracking-widest rounded border bg-slate-100 text-slate-500 border-slate-200">No Permission Change Applied</span>
                              </div>
                            )}
                          </td>
                          <td className="px-6 py-5">
                            <span className="inline-block px-2.5 py-1 bg-slate-100 text-slate-600 text-[10px] font-black uppercase tracking-widest rounded-lg">
                              {record.reviewedRoleLabel}
                            </span>
                            <p className="text-[10px] font-medium text-slate-400 mt-1.5">
                              {record.reviewedRoleKnown
                                ? `Recommended review: ${record.recommendedCadenceLabel}`
                                : 'Custom / non-catalog role — advisory cadence (annual fallback)'}
                            </p>
                          </td>
                          <td className="px-6 py-5">
                            <p className="text-[11px] font-bold text-slate-600">{record.reviewPeriod}</p>
                            <p className="text-[10px] font-medium text-slate-400 mt-0.5">Reviewer: {record.reviewerName}</p>
                            <p className="text-[10px] font-medium text-slate-400">Created by: {record.createdBy}</p>
                          </td>
                          <td className="px-6 py-5">
                            <span className={`px-3 py-1 text-[10px] font-black uppercase tracking-widest rounded-lg border ${ACCESS_REVIEW_STATUS_BADGE_STYLE[derived]}`} data-testid={`access-review-status-${record.id}`}>
                              {ACCESS_REVIEW_STATUS_LABEL[derived]}
                            </span>
                            {record.actionRequired && (
                              <p className="text-[9px] font-black uppercase tracking-widest text-orange-600 mt-1.5 max-w-[220px]">
                                Action required — advisory only; no permission change applied.
                              </p>
                            )}
                            {record.notes && (
                              <p className="text-[10px] font-medium text-slate-500 mt-1.5 max-w-[240px]">Reason: {record.notes}</p>
                            )}
                            {record.findings && (
                              <p className="text-[10px] font-medium text-slate-400 mt-1 max-w-[240px]">Findings: {record.findings}</p>
                            )}
                            <button
                              onClick={() => setExpandedReviewHistory(prev => ({ ...prev, [record.id]: !prev[record.id] }))}
                              className="block mt-2 text-[9px] font-black uppercase tracking-widest text-indigo-500 hover:text-indigo-700"
                              data-testid={`access-review-history-toggle-${record.id}`}
                            >
                              {historyOpen ? 'Hide trail' : `Trail (${record.history.length})`}
                            </button>
                          </td>
                          <td className="px-6 py-5">
                            <p className="text-[10px] font-medium text-slate-500">
                              Reviewed: {record.reviewedAt ? record.reviewedAt.slice(0, 16).replace('T', ' ') : '—'}
                            </p>
                            <p className="text-[10px] font-medium text-slate-400 mt-0.5">Updated: {record.updatedAt.slice(0, 16).replace('T', ' ')}</p>
                          </td>
                          <td className="px-6 py-5 text-right">
                            {actions.length === 0 ? (
                              <span className="text-[10px] font-bold text-slate-300 uppercase tracking-widest">{isOwner ? 'Terminal — no actions' : 'View only'}</span>
                            ) : (
                              <button
                                onClick={() => { setReviewError(null); setReviewOutcome('reviewed_no_change'); setReviewActionReason(''); setReviewActionFindings(''); setReviewActionTarget(record); }}
                                data-testid={`access-review-record-outcome-${record.id}`}
                                className="px-3 py-1.5 text-[9px] font-black uppercase tracking-widest rounded-lg border bg-primary/5 text-primary border-primary/20 hover:bg-primary/10 transition-all"
                              >
                                Record Outcome
                              </button>
                            )}
                          </td>
                        </tr>
                        {historyOpen && (
                          <tr className="bg-slate-50/60" data-testid={`access-review-history-${record.id}`}>
                            <td colSpan={6} className="px-6 py-4">
                              <p className="text-[10px] font-black uppercase tracking-widest text-slate-400 mb-2">Review Trail — reason captured per transition</p>
                              <ul className="space-y-1.5">
                                {record.history.map(ev => (
                                  <li key={ev.id} className="text-[11px] font-medium text-slate-600 flex flex-wrap items-baseline gap-x-2">
                                    <span className="font-black text-slate-700">{ev.action === 'created' ? 'Created' : ACCESS_REVIEW_OUTCOME_LABEL[ev.action]}</span>
                                    <span className="text-slate-400">{ev.at.slice(0, 16).replace('T', ' ')}</span>
                                    <span className="text-slate-400">by {ev.actor}</span>
                                    {ev.fromStatus && <span className="text-slate-400">· {ev.fromStatus} → {ev.toStatus}</span>}
                                    {!ev.fromStatus && <span className="text-slate-400">· → {ev.toStatus}</span>}
                                    <span className="text-slate-500">— {ev.reason}</span>
                                  </li>
                                ))}
                              </ul>
                            </td>
                          </tr>
                        )}
                      </React.Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* ---- Sensitive Action Reason Capture (local/advisory log) ---- */}
        <div className="space-y-3" data-testid="sensitive-action-reason-panel">
          <div className="bg-amber-400/10 border border-amber-400/30 rounded-2xl p-4 flex items-start gap-3" data-testid="sensitive-action-truth-banner">
            <span className="material-symbols-outlined text-amber-700 text-lg mt-0.5">history_edu</span>
            <div className="text-xs font-medium text-amber-900 leading-relaxed space-y-1">
              <p className="font-black uppercase tracking-widest text-amber-800">Sensitive Action Reason Capture (Advisory)</p>
              <p>{SENSITIVE_ACTION_REASON_MODEL_STATUS}</p>
              <p className="text-[11px] text-amber-700">
                Captured for: access review outcomes (above) and resetting the Global Permissions Matrix to defaults.
                Per-cell matrix edits, member edits, and temporary-access actions keep their own existing audit trails.
                Production compliance evidence is future/deferred · no server-side enforcement.
              </p>
            </div>
          </div>

          {sensitiveReasons.length === 0 ? (
            <div className="bg-white/70 border border-slate-200 rounded-2xl p-6 text-center" data-testid="sensitive-action-empty">
              <p className="text-xs font-bold text-slate-500">No sensitive-action reasons captured this session yet.</p>
              <p className="text-[11px] font-medium text-slate-400 mt-1">Record an access review outcome, or reset the permissions matrix, to capture a reason here.</p>
            </div>
          ) : (
            <div className="bg-white/80 backdrop-blur-xl rounded-2xl border border-slate-200 overflow-hidden shadow-sm">
              <ul className="divide-y divide-slate-100">
                {sensitiveReasons.slice(0, 20).map(cap => (
                  <li key={cap.id} className="px-5 py-4" data-testid={`sensitive-action-row-${cap.id}`}>
                    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                      <span className="text-xs font-black text-slate-700">{cap.actionLabel}</span>
                      <span className="px-1.5 py-0.5 text-[8px] font-black uppercase tracking-widest rounded bg-slate-100 text-slate-500 border border-slate-200">
                        {cap.actionCategory.replace(/_/g, ' ')}
                      </span>
                      <span className="text-[10px] font-medium text-slate-400">{cap.at.slice(0, 16).replace('T', ' ')} · {cap.actor}</span>
                    </div>
                    {cap.targetSubject && <p className="text-[11px] font-medium text-slate-500 mt-1">Target: {cap.targetSubject}</p>}
                    {cap.targetPermission && <p className="text-[11px] font-medium text-slate-500 mt-1">Target: {cap.targetPermission}</p>}
                    {(cap.beforeSummary || cap.afterSummary) && (
                      <p className="text-[10px] font-medium text-slate-400 mt-0.5">
                        {cap.beforeSummary || '—'} → {cap.afterSummary || '—'}
                      </p>
                    )}
                    <p className="text-[11px] font-medium text-slate-600 mt-1">Reason: {cap.reason}</p>
                    <p className="text-[9px] font-black uppercase tracking-widest text-amber-600 mt-1">{cap.advisoryLabel}</p>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </div>
    );
  };

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

        {/* Phase 1.3 — Milestone 2: truthful platform-governance posture notice. */}
        <div className="bg-indigo-50/70 border border-indigo-200/60 rounded-2xl p-4 flex items-start gap-3" data-testid="platform-governance-notice">
          <span className="material-symbols-outlined text-indigo-600 text-lg mt-0.5">shield</span>
          <div>
            <p className="text-xs font-black text-indigo-900 uppercase tracking-widest">Platform Access Governance — Current Phase</p>
            <p className="text-xs font-medium text-indigo-800 mt-1">
              Current platform access controls are UI/client-gated in this phase. Server-side enforcement, automated
              access review, and temporary access workflows are future/deferred.
            </p>
            <p className="text-[11px] font-medium text-indigo-500 mt-1.5 leading-relaxed">{PLATFORM_GOVERNANCE_MODEL_STATUS}</p>
          </div>
        </div>

        <div className="flex items-center gap-2 bg-white/80 backdrop-blur-xl p-1.5 rounded-2xl border border-slate-200 shadow-sm w-fit">
          {[
            { id: 'team', label: 'Team', icon: 'group' },
            { id: 'roles', label: 'Roles', icon: 'security' },
            { id: 'temporary', label: 'Temporary Access', icon: 'timer' },
            { id: 'review', label: 'Access Review', icon: 'fact_check' },
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
            {activeTab === 'temporary' && renderTemporaryAccess()}
            {activeTab === 'review' && renderAccessReview()}
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
                  <p className="text-xs text-slate-500 mb-4">
                    Affected roles: {MATRIX_ROLES.filter(r => r !== 'system_owner').map(r => PLATFORM_ROLE_DISPLAY_LABEL[r]).join(', ')}. System Owner remains locked at Full Access.
                  </p>
                  {/* Phase 1.3 — Milestone 4: sensitive-action reason capture. The
                      reset behavior is unchanged; a reason is captured (advisory/local). */}
                  <div className="space-y-2 mb-5">
                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1">Reason (required — sensitive action)</label>
                    <textarea
                      value={resetReason}
                      onChange={e => setResetReason(e.target.value)}
                      data-testid="reset-reason"
                      className="w-full px-4 py-3 bg-slate-50 rounded-2xl border border-slate-200 focus:outline-none focus:ring-2 focus:ring-primary/20 font-bold text-slate-700 resize-none h-20 text-sm"
                      placeholder="Why are all permission overrides being reset to defaults?"
                    />
                    <p className="text-[10px] font-medium text-slate-400 ml-1">
                      {SENSITIVE_ACTION_REASON_ADVISORY_LABEL}
                    </p>
                  </div>
                  <div className="flex gap-3">
                    <button
                      onClick={() => { setShowResetConfirm(false); setResetReason(''); }}
                      className="flex-1 py-3 bg-white text-slate-600 font-black text-[10px] rounded-2xl border border-slate-200 hover:bg-slate-50 transition-all uppercase tracking-widest"
                    >
                      Cancel
                    </button>
                    <button
                      onClick={confirmReset}
                      disabled={resetReason.trim().length < 3}
                      data-testid="reset-confirm"
                      className="flex-1 py-3 bg-amber-500 text-white font-black text-[10px] rounded-2xl shadow-lg shadow-amber-500/20 uppercase tracking-widest hover:bg-amber-600 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      Confirm Reset
                    </button>
                  </div>
                </div>
              </motion.div>
            </div>
          )}
        </AnimatePresence>

        {/* Phase 1.3 — Milestone 3: Request Temporary Access modal (reason required). */}
        <AnimatePresence>
          {showTempRequestModal && (
            <div key="temp-request-modal" className="fixed inset-0 z-50 flex items-center justify-center p-6">
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                onClick={() => setShowTempRequestModal(false)}
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
                    <h3 className="text-2xl font-black text-primary tracking-tight">Request Temporary Access</h3>
                    <p className="text-xs font-bold text-slate-400 uppercase tracking-widest mt-1">Advisory · time-boxed · non-enforcing</p>
                  </div>
                  <button onClick={() => setShowTempRequestModal(false)} className="w-10 h-10 rounded-full hover:bg-slate-200 flex items-center justify-center transition-colors">
                    <span className="material-symbols-outlined text-slate-400">close</span>
                  </button>
                </div>

                <div className="p-8 overflow-y-auto flex-1 space-y-5">
                  <div className="bg-teal-50/70 border border-teal-200/60 rounded-2xl p-3 text-[11px] font-medium text-teal-800 leading-relaxed">
                    This records an <span className="font-black">advisory</span> elevation request. It does not change the member's real permissions, and there is no automatic activation, escalation, or revocation.
                  </div>

                  <div className="space-y-2">
                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-4">Subject (catalog-role member)</label>
                    <select
                      value={tempForm.subjectId}
                      onChange={e => setTempForm(prev => ({ ...prev, subjectId: e.target.value }))}
                      data-testid="temp-request-subject"
                      className="w-full px-6 py-4 bg-slate-50 rounded-2xl border border-slate-200 focus:outline-none focus:ring-2 focus:ring-primary/20 font-bold text-slate-700"
                    >
                      <option value="">Select a member…</option>
                      {tempEligibleSubjects.map(({ member, roleId }) => (
                        <option key={member.id} value={member.id}>
                          {member.name} — {PLATFORM_ROLE_CATALOG[roleId].displayLabel}
                        </option>
                      ))}
                    </select>
                    <p className="text-[10px] font-medium text-slate-400 ml-4">System Owner and custom/non-catalog roles are excluded (system-protected / not modelled).</p>
                  </div>

                  <div className="space-y-2">
                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-4">Requested elevation target (advisory — not applied)</label>
                    <select
                      value={tempForm.elevatedRoleId}
                      onChange={e => setTempForm(prev => ({ ...prev, elevatedRoleId: e.target.value }))}
                      data-testid="temp-request-elevation"
                      className="w-full px-6 py-4 bg-slate-50 rounded-2xl border border-slate-200 focus:outline-none focus:ring-2 focus:ring-primary/20 font-bold text-slate-700"
                    >
                      <option value="">(Unspecified)</option>
                      {tempElevationTargets.map(id => (
                        <option key={id} value={id}>{PLATFORM_ROLE_CATALOG[id].displayLabel}</option>
                      ))}
                    </select>
                  </div>

                  <div className="space-y-2">
                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-4">Duration (time-box; clock starts on approval)</label>
                    <select
                      value={tempForm.durationId}
                      onChange={e => setTempForm(prev => ({ ...prev, durationId: e.target.value }))}
                      data-testid="temp-request-duration"
                      className="w-full px-6 py-4 bg-slate-50 rounded-2xl border border-slate-200 focus:outline-none focus:ring-2 focus:ring-primary/20 font-bold text-slate-700"
                    >
                      {TEMPORARY_ACCESS_DURATION_PRESETS.map(d => (
                        <option key={d.id} value={d.id}>{d.label}</option>
                      ))}
                    </select>
                  </div>

                  <div className="space-y-2">
                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-4">Reason (required)</label>
                    <textarea
                      value={tempForm.reason}
                      onChange={e => setTempForm(prev => ({ ...prev, reason: e.target.value }))}
                      data-testid="temp-request-reason"
                      className="w-full px-6 py-4 bg-slate-50 rounded-2xl border border-slate-200 focus:outline-none focus:ring-2 focus:ring-primary/20 font-bold text-slate-700 resize-none h-20"
                      placeholder="Why is this temporary elevation needed?"
                    />
                  </div>

                  {tempError && (
                    <p className="text-[11px] font-bold text-red-600 bg-red-50 border border-red-200 rounded-xl px-3 py-2" data-testid="temp-request-error">{tempError}</p>
                  )}
                </div>

                <div className="p-8 border-t border-slate-100 bg-slate-50/50 flex gap-4">
                  <button
                    onClick={() => setShowTempRequestModal(false)}
                    className="flex-1 py-4 bg-white text-slate-600 font-black text-sm rounded-2xl border border-slate-200 hover:bg-slate-50 transition-all uppercase tracking-widest"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={handleRequestTempAccess}
                    disabled={!tempForm.subjectId || tempForm.reason.trim().length < 3}
                    data-testid="temp-request-submit"
                    className="flex-1 py-4 bg-primary text-white font-black text-sm rounded-2xl shadow-lg shadow-primary/20 uppercase tracking-widest hover:bg-primary/90 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    Submit Request
                  </button>
                </div>
              </motion.div>
            </div>
          )}
        </AnimatePresence>

        {/* Phase 1.3 — Milestone 3: reason-required lifecycle action modal. */}
        <AnimatePresence>
          {tempActionTarget && (
            <div key="temp-action-modal" className="fixed inset-0 z-50 flex items-center justify-center p-6">
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                onClick={() => { setTempActionTarget(null); setTempActionReason(''); }}
                className="absolute inset-0 bg-slate-900/40 backdrop-blur-md"
              />
              <motion.div
                initial={{ opacity: 0, scale: 0.95, y: 10 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.95, y: 10 }}
                transition={{ duration: 0.2 }}
                className="relative w-full max-w-md bg-white rounded-3xl shadow-2xl border border-slate-200 overflow-hidden"
              >
                <div className="p-8">
                  <h3 className="text-xl font-black text-slate-900 tracking-tight mb-1">
                    {TEMP_ACCESS_ACTION_VERB[tempActionTarget.action]} Temporary Access
                  </h3>
                  <p className="text-xs font-bold text-slate-500 mb-1">
                    {tempActionTarget.grant.subjectName} ({tempActionTarget.grant.subjectEmail})
                  </p>
                  <p className="text-[11px] font-medium text-slate-500 mb-4">{TEMP_ACCESS_ACTION_PROMPT[tempActionTarget.action]}</p>
                  <textarea
                    value={tempActionReason}
                    onChange={e => setTempActionReason(e.target.value)}
                    data-testid="temp-action-reason"
                    autoFocus
                    className="w-full px-4 py-3 bg-slate-50 rounded-2xl border border-slate-200 focus:outline-none focus:ring-2 focus:ring-primary/20 font-bold text-slate-700 resize-none h-24 text-sm"
                    placeholder="Reason (required)…"
                  />
                  {tempError && (
                    <p className="text-[11px] font-bold text-red-600 bg-red-50 border border-red-200 rounded-xl px-3 py-2 mt-3" data-testid="temp-action-error">{tempError}</p>
                  )}
                  <div className="flex gap-3 mt-5">
                    <button
                      onClick={() => { setTempActionTarget(null); setTempActionReason(''); }}
                      className="flex-1 py-3 bg-white text-slate-600 font-black text-[10px] rounded-2xl border border-slate-200 hover:bg-slate-50 transition-all uppercase tracking-widest"
                    >
                      Cancel
                    </button>
                    <button
                      onClick={handleTempAction}
                      disabled={tempActionReason.trim().length < 3}
                      data-testid="temp-action-confirm"
                      className={`flex-1 py-3 text-white font-black text-[10px] rounded-2xl shadow-lg uppercase tracking-widest transition-all disabled:opacity-50 disabled:cursor-not-allowed ${
                        tempActionTarget.action === 'approve' ? 'bg-emerald-500 hover:bg-emerald-600 shadow-emerald-500/20' :
                        tempActionTarget.action === 'revoke' ? 'bg-red-500 hover:bg-red-600 shadow-red-500/20' :
                        tempActionTarget.action === 'deny' ? 'bg-orange-500 hover:bg-orange-600 shadow-orange-500/20' :
                        'bg-slate-600 hover:bg-slate-700 shadow-slate-500/20'
                      }`}
                    >
                      Confirm {TEMP_ACCESS_ACTION_VERB[tempActionTarget.action]}
                    </button>
                  </div>
                </div>
              </motion.div>
            </div>
          )}
        </AnimatePresence>

        {/* Phase 1.3 — Milestone 4: Create Access Review record modal. */}
        <AnimatePresence>
          {showReviewCreateModal && (
            <div key="review-create-modal" className="fixed inset-0 z-50 flex items-center justify-center p-6">
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                onClick={() => setShowReviewCreateModal(false)}
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
                    <h3 className="text-2xl font-black text-primary tracking-tight">Create Access Review Record</h3>
                    <p className="text-xs font-bold text-slate-400 uppercase tracking-widest mt-1">Advisory · local · non-enforcing</p>
                  </div>
                  <button onClick={() => setShowReviewCreateModal(false)} className="w-10 h-10 rounded-full hover:bg-slate-200 flex items-center justify-center transition-colors">
                    <span className="material-symbols-outlined text-slate-400">close</span>
                  </button>
                </div>

                <div className="p-8 overflow-y-auto flex-1 space-y-5">
                  <div className="bg-sky-50/70 border border-sky-200/60 rounded-2xl p-3 text-[11px] font-medium text-sky-800 leading-relaxed">
                    Creates a <span className="font-black">pending</span> advisory review record. It does not change the member's role or permissions, and there is no automatic completion, reminder, or revocation.
                  </div>

                  <div className="space-y-2">
                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-4">Reviewed subject (team member)</label>
                    <select
                      value={reviewForm.subjectId}
                      onChange={e => setReviewForm(prev => ({ ...prev, subjectId: e.target.value }))}
                      data-testid="review-create-subject"
                      className="w-full px-6 py-4 bg-slate-50 rounded-2xl border border-slate-200 focus:outline-none focus:ring-2 focus:ring-primary/20 font-bold text-slate-700"
                    >
                      <option value="">Select a member…</option>
                      {team.map(m => (
                        <option key={m.id} value={m.id}>{m.name} — {m.role}</option>
                      ))}
                    </select>
                    {(() => {
                      const m = team.find(x => x.id === reviewForm.subjectId);
                      if (!m) return <p className="text-[10px] font-medium text-slate-400 ml-4">All platform team members are in scope (including System Owner — reviewed for existence/ownership, never downgraded).</p>;
                      const rid = resolvePlatformRoleId(m.role);
                      const sysOwner = rid === 'system_owner';
                      return (
                        <p className="text-[10px] font-medium text-slate-400 ml-4">
                          Reviewed role: <span className="font-black text-slate-500">{m.role}</span> ·{' '}
                          {rid ? `recommended review ${getRecommendedReviewCadence(rid)}` : 'custom/non-catalog role (annual fallback)'}
                          {sysOwner && <span className="text-violet-600 font-black"> · System Protected — review carefully; no downgrade.</span>}
                        </p>
                      );
                    })()}
                  </div>

                  <div className="space-y-2">
                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-4">Review period (required)</label>
                    <input
                      value={reviewForm.reviewPeriod}
                      onChange={e => setReviewForm(prev => ({ ...prev, reviewPeriod: e.target.value }))}
                      data-testid="review-create-period"
                      className="w-full px-6 py-4 bg-slate-50 rounded-2xl border border-slate-200 focus:outline-none focus:ring-2 focus:ring-primary/20 font-bold text-slate-700"
                      placeholder="e.g. Q2 2026"
                    />
                  </div>

                  <div className="space-y-2">
                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-4">Reviewer / created by</label>
                    <input
                      value={session?.user?.name || 'System Owner'}
                      readOnly
                      className="w-full px-6 py-4 bg-slate-100 rounded-2xl border border-slate-200 font-bold text-slate-500"
                    />
                  </div>

                  <div className="space-y-2">
                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-4">Initial findings (optional)</label>
                    <textarea
                      value={reviewForm.findings}
                      onChange={e => setReviewForm(prev => ({ ...prev, findings: e.target.value }))}
                      data-testid="review-create-findings"
                      className="w-full px-6 py-4 bg-slate-50 rounded-2xl border border-slate-200 focus:outline-none focus:ring-2 focus:ring-primary/20 font-bold text-slate-700 resize-none h-16"
                      placeholder="Context noted at creation (optional)…"
                    />
                  </div>

                  {reviewError && (
                    <p className="text-[11px] font-bold text-red-600 bg-red-50 border border-red-200 rounded-xl px-3 py-2" data-testid="review-create-error">{reviewError}</p>
                  )}
                </div>

                <div className="p-8 border-t border-slate-100 bg-slate-50/50 flex gap-4">
                  <button
                    onClick={() => setShowReviewCreateModal(false)}
                    className="flex-1 py-4 bg-white text-slate-600 font-black text-sm rounded-2xl border border-slate-200 hover:bg-slate-50 transition-all uppercase tracking-widest"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={handleCreateReview}
                    disabled={!reviewForm.subjectId || reviewForm.reviewPeriod.trim().length === 0}
                    data-testid="review-create-submit"
                    className="flex-1 py-4 bg-primary text-white font-black text-sm rounded-2xl shadow-lg shadow-primary/20 uppercase tracking-widest hover:bg-primary/90 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    Create Record
                  </button>
                </div>
              </motion.div>
            </div>
          )}
        </AnimatePresence>

        {/* Phase 1.3 — Milestone 4: Record Access Review Outcome modal (reason required). */}
        <AnimatePresence>
          {reviewActionTarget && (
            <div key="review-action-modal" className="fixed inset-0 z-50 flex items-center justify-center p-6">
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                onClick={() => { setReviewActionTarget(null); setReviewActionReason(''); setReviewActionFindings(''); }}
                className="absolute inset-0 bg-slate-900/40 backdrop-blur-md"
              />
              <motion.div
                initial={{ opacity: 0, scale: 0.95, y: 10 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.95, y: 10 }}
                transition={{ duration: 0.2 }}
                className="relative w-full max-w-md bg-white rounded-3xl shadow-2xl border border-slate-200 overflow-hidden"
              >
                <div className="p-8">
                  <h3 className="text-xl font-black text-slate-900 tracking-tight mb-1">Record Access Review Outcome</h3>
                  <p className="text-xs font-bold text-slate-500 mb-1">
                    {reviewActionTarget.reviewedSubjectName} · {reviewActionTarget.reviewedRoleLabel} · {reviewActionTarget.reviewPeriod}
                  </p>

                  {reviewActionTarget.systemProtected && (
                    <div className="bg-violet-50 border border-violet-200 rounded-xl px-3 py-2 my-3 text-[11px] font-medium text-violet-800 leading-relaxed" data-testid="review-action-sysowner-notice">
                      <span className="font-black uppercase tracking-widest">System Protected:</span> System Owner is reviewed carefully for existence/ownership. No outcome downgrades it and no permission change is applied.
                    </div>
                  )}

                  <div className="space-y-2 mt-3">
                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1">Outcome</label>
                    <select
                      value={reviewOutcome}
                      onChange={e => setReviewOutcome(e.target.value as AccessReviewOutcome)}
                      data-testid="review-action-outcome"
                      className="w-full px-4 py-3 bg-slate-50 rounded-2xl border border-slate-200 focus:outline-none focus:ring-2 focus:ring-primary/20 font-bold text-slate-700 text-sm"
                    >
                      {ACCESS_REVIEW_OUTCOMES.map(o => (
                        <option key={o} value={o} data-testid={`review-action-outcome-${o}`}>{ACCESS_REVIEW_OUTCOME_LABEL[o]}</option>
                      ))}
                    </select>
                    <p className="text-[11px] font-medium text-slate-500 ml-1">{ACCESS_REVIEW_OUTCOME_PROMPT[reviewOutcome]}</p>
                    {reviewOutcome === 'reviewed_change_required' && (
                      <p className="text-[10px] font-black uppercase tracking-widest text-orange-600 ml-1" data-testid="review-action-change-required-label">
                        Action required — advisory only; no permission change applied.
                      </p>
                    )}
                  </div>

                  <div className="space-y-2 mt-4">
                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1">Findings (optional)</label>
                    <textarea
                      value={reviewActionFindings}
                      onChange={e => setReviewActionFindings(e.target.value)}
                      data-testid="review-action-findings"
                      className="w-full px-4 py-3 bg-slate-50 rounded-2xl border border-slate-200 focus:outline-none focus:ring-2 focus:ring-primary/20 font-bold text-slate-700 resize-none h-16 text-sm"
                      placeholder="What was found (optional)…"
                    />
                  </div>

                  <div className="space-y-2 mt-4">
                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1">Reason (required)</label>
                    <textarea
                      value={reviewActionReason}
                      onChange={e => setReviewActionReason(e.target.value)}
                      data-testid="review-action-reason"
                      autoFocus
                      className="w-full px-4 py-3 bg-slate-50 rounded-2xl border border-slate-200 focus:outline-none focus:ring-2 focus:ring-primary/20 font-bold text-slate-700 resize-none h-20 text-sm"
                      placeholder="Reason for this outcome (required)…"
                    />
                  </div>

                  {reviewError && (
                    <p className="text-[11px] font-bold text-red-600 bg-red-50 border border-red-200 rounded-xl px-3 py-2 mt-3" data-testid="review-action-error">{reviewError}</p>
                  )}

                  <div className="flex gap-3 mt-5">
                    <button
                      onClick={() => { setReviewActionTarget(null); setReviewActionReason(''); setReviewActionFindings(''); }}
                      className="flex-1 py-3 bg-white text-slate-600 font-black text-[10px] rounded-2xl border border-slate-200 hover:bg-slate-50 transition-all uppercase tracking-widest"
                    >
                      Cancel
                    </button>
                    <button
                      onClick={handleCompleteReview}
                      disabled={reviewActionReason.trim().length < 3}
                      data-testid="review-action-confirm"
                      className="flex-1 py-3 bg-primary text-white font-black text-[10px] rounded-2xl shadow-lg shadow-primary/20 uppercase tracking-widest hover:bg-primary/90 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      Record Outcome
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
