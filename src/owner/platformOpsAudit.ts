// Platform Operations & Security audit helper.
//
// Mirrors the existing `commercialAudit.ts` pattern: every action
// writes a single row into `sessionStorage('audit_logs')` with the
// row contract that AuditSecurityPage consumes (`id`, `date`,
// `actor`, `action`, `target`, `severity`, `category`) and dispatches
// the `audit_logs:changed` event so subscribed views refresh.
//
// Severity is the expanded Platform Operations severity scale
// (`info | notice | warning | critical`) — AuditSecurityPage maps
// these to color tokens. The pre-existing `commercialAudit.ts` only
// emits `info | warning`; both stay valid.

import type { PlatformAuditSeverity } from './mockData';

const MIRROR_KEY = 'audit_logs';

export type PlatformAuditCategory =
  | 'security'
  | 'support'
  | 'configuration'
  | 'domains'
  | 'team';

export type PlatformAuditAction =
  | 'platform_setting_updated'
  | 'support_case_created'
  | 'support_case_status_changed'
  | 'support_case_severity_changed'
  | 'support_case_assignee_changed'
  | 'support_case_note_added'
  | 'domain_created'
  | 'domain_status_changed'
  | 'domain_ssl_changed'
  | 'domain_disabled'
  | 'domain_reenabled'
  | 'domain_deleted'
  | 'platform_team_member_invited'
  | 'platform_team_member_updated'
  | 'platform_team_member_role_changed'
  | 'platform_team_member_status_changed'
  | 'platform_role_created'
  | 'platform_permission_changed'
  | 'platform_sub_permission_changed'
  | 'security_note_added'
  | 'security_note_deleted'
  // Phase 1.1 — additional governance actions for Command Center,
  // Audit & Security upgrade, and Support Tools upgrade.
  | 'audit_view_exported'
  | 'support_case_created_from_audit'
  | 'support_case_macro_inserted'
  | 'support_case_escalated'
  | 'support_case_deescalated'
  | 'support_case_closed'
  | 'support_case_reopened'
  | 'command_center_quick_action_used'
  // Phase 1.1.1 — Mission Control / Command Center interactive controls.
  | 'command_center_refreshed'
  | 'command_center_time_range_changed'
  | 'command_center_focus_mode_changed'
  | 'command_center_tenant360_opened'
  // Phase 1.1.1 UX Correction — interactive pulse filter
  | 'command_center_pulse_filter_applied'
  // Phase 1.1.3B — advanced command center intelligence.
  | 'command_center_snapshot_saved'
  | 'command_center_intelligence_drawer_opened'
  // Phase 1.1.3A — Operating Model + Permission-Aware Escalation.
  // All actions are advisory governance only — no real notifications,
  // no real RBAC enforcement, no on-call routing.
  | 'support_case_escalation_assigned'
  | 'support_case_escalation_reassigned'
  | 'support_case_escalation_acknowledged'
  | 'support_case_escalation_level_changed'
  | 'support_case_escalation_resolved'
  | 'support_case_deescalation_requested'
  | 'support_case_deescalation_request_approved'
  | 'support_case_deescalation_request_rejected'
  | 'platform_permission_dependency_reconciled'
  | 'support_case_close_with_active_escalation_warning'
  | 'support_case_assignment_changed'
  // Phase 1.1.3C correction — lightweight internal macro management.
  // Internal-only templates; no external send.
  | 'support_macro_created'
  | 'support_macro_updated'
  | 'support_macro_disabled'
  | 'support_macro_enabled'
  | 'platform_permissions_reset';

export interface PushPlatformAuditInput {
  actor: string;
  action: PlatformAuditAction;
  target: string;
  severity?: PlatformAuditSeverity;
  category: PlatformAuditCategory;
  tenantId?: string | null;
  oldValue?: string | number | null;
  newValue?: string | number | null;
  note?: string;
}

interface MirrorRow {
  id: string;
  date: string;
  actor: string;
  action: string;
  target: string;
  severity: PlatformAuditSeverity;
  category: PlatformAuditCategory;
  tenantId?: string | null;
  oldValue?: string | number | null;
  newValue?: string | number | null;
  note?: string;
}

function safeGet<T>(key: string, fallback: T): T {
  try {
    if (typeof window === 'undefined' || !window.sessionStorage) return fallback;
    const raw = window.sessionStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function safeSet(key: string, value: unknown): void {
  try {
    if (typeof window === 'undefined' || !window.sessionStorage) return;
    window.sessionStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* noop */
  }
}

const DEFAULT_SEVERITY_BY_ACTION: Partial<Record<PlatformAuditAction, PlatformAuditSeverity>> = {
  platform_setting_updated: 'notice',
  support_case_created: 'info',
  support_case_status_changed: 'info',
  support_case_severity_changed: 'notice',
  support_case_assignee_changed: 'info',
  support_case_note_added: 'info',
  domain_created: 'info',
  domain_status_changed: 'notice',
  domain_ssl_changed: 'notice',
  domain_disabled: 'warning',
  domain_reenabled: 'notice',
  domain_deleted: 'warning',
  platform_team_member_invited: 'notice',
  platform_team_member_updated: 'info',
  platform_team_member_role_changed: 'warning',
  platform_team_member_status_changed: 'warning',
  platform_role_created: 'notice',
  platform_permission_changed: 'warning',
  platform_sub_permission_changed: 'warning',
  security_note_added: 'notice',
  security_note_deleted: 'notice',
  // Phase 1.1
  audit_view_exported: 'info',
  support_case_created_from_audit: 'notice',
  support_case_macro_inserted: 'info',
  support_case_escalated: 'warning',
  support_case_deescalated: 'notice',
  support_case_closed: 'info',
  support_case_reopened: 'notice',
  command_center_quick_action_used: 'info',
  // Phase 1.1.1
  command_center_refreshed: 'info',
  command_center_time_range_changed: 'info',
  command_center_focus_mode_changed: 'info',
  command_center_tenant360_opened: 'info',
  // Phase 1.1.3B
  command_center_snapshot_saved: 'info',
  command_center_intelligence_drawer_opened: 'info',
  // Phase 1.1.3A
  support_case_escalation_assigned: 'notice',
  support_case_escalation_reassigned: 'notice',
  support_case_escalation_acknowledged: 'notice',
  support_case_escalation_level_changed: 'warning',
  support_case_escalation_resolved: 'notice',
  support_case_close_with_active_escalation_warning: 'warning',
  support_case_assignment_changed: 'info',
  support_case_deescalation_requested: 'notice',
  support_case_deescalation_request_approved: 'notice',
  support_case_deescalation_request_rejected: 'notice',
  platform_permission_dependency_reconciled: 'notice',
  // Phase 1.1.3C correction — macro management
  support_macro_created: 'notice',
  support_macro_updated: 'notice',
  support_macro_disabled: 'notice',
  support_macro_enabled: 'notice',
  platform_permissions_reset: 'warning',
};

export function pushPlatformAudit(input: PushPlatformAuditInput): MirrorRow {
  const severity: PlatformAuditSeverity =
    input.severity ?? DEFAULT_SEVERITY_BY_ACTION[input.action] ?? 'info';
  const row: MirrorRow = {
    id: `pa_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    date: new Date().toISOString().slice(0, 10),
    actor: input.actor || 'System Owner',
    action: input.action.replace(/_/g, ' '),
    target: input.target,
    severity,
    category: input.category,
    tenantId: input.tenantId ?? null,
    oldValue: input.oldValue ?? null,
    newValue: input.newValue ?? null,
    note: input.note,
  };
  const existing = safeGet<MirrorRow[]>(MIRROR_KEY, []);
  safeSet(MIRROR_KEY, [row, ...existing].slice(0, 1000));
  try {
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new Event('audit_logs:changed'));
    }
  } catch {
    /* noop */
  }
  return row;
}

export function readMirroredAuditRows(): MirrorRow[] {
  return safeGet<MirrorRow[]>(MIRROR_KEY, []);
}
