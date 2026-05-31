// Phase 1.1.3D — Audit Investigation Center shared data model + helpers.
//
// This module is the single source of truth for the deterministic,
// rule-based "investigation" derivations layered on top of the existing
// audit log rows that AuditSecurityPage already consumes
// (`platformOpsAudit.ts` MirrorRow + `mockData.auditLogs` seed).
//
// Everything here is PURE and deterministic: no IO, no AI/ML, no network,
// no realtime listeners. Risk is *derived* from current app/session audit
// data — never invented. Storage-overlay shapes (review status / notes /
// evidence summary) are defined here as the data-model contract; their
// read/write helpers and UI are added in later Phase 1.1.3D milestones.
//
// Truth: this is investigation tooling over current app/session audit data,
// not a SIEM, not immutable audit storage, and not real threat detection.

import {
  deriveHighRiskFlag,
  type AuditEventLike,
  type HighRiskFlag,
  type SignalConfidence,
} from './platformOpsDerive';
import type { PlatformAuditSeverity } from './mockData';

// --- TRUTH LABELS ----------------------------------------------------------

export const AUDIT_INVESTIGATION_TRUTH_LABEL =
  'Audit Investigation Center uses current app/session audit data.';
export const AUDIT_CORRELATION_TRUTH_LABEL =
  'Rule-based correlation only — no AI or SIEM integration in this phase.';
export const AUDIT_NOTE_TRUTH_LABEL = 'Investigation notes are internal only.';
export const AUDIT_EVIDENCE_TRUTH_LABEL =
  'Evidence summary is internal and not compliance-certified.';
export const AUDIT_RESTRICTED_TRUTH_LABEL =
  'Restricted fields require elevated audit permission.';
export const AUDIT_NO_NOTIFY_TRUTH_LABEL =
  'No external notifications or automated remediation are active.';

// --- SEVERITY --------------------------------------------------------------

export type AuditEventSeverity = PlatformAuditSeverity;

export const SEVERITY_RANK: Record<AuditEventSeverity, number> = {
  info: 0,
  notice: 1,
  warning: 2,
  critical: 3,
};

// Mirrors AuditSecurityPage.normalizeSeverity so the page and helpers can
// never disagree about what a raw severity string means.
export function normalizeAuditSeverity(s: string | null | undefined): AuditEventSeverity {
  if (s === 'notice' || s === 'warning' || s === 'critical') return s;
  return 'info';
}

export function maxSeverity(severities: AuditEventSeverity[]): AuditEventSeverity {
  return severities.reduce<AuditEventSeverity>(
    (acc, s) => (SEVERITY_RANK[s] > SEVERITY_RANK[acc] ? s : acc),
    'info'
  );
}

// --- SOURCE SURFACE (derived, best-effort) --------------------------------
// Audit rows do not persist the originating surface; we derive a truthful
// best-effort label from the category so the drawer/search can group by it.

export type AuditSourceSurface =
  | 'Audit & Security'
  | 'Support Tools'
  | 'Domains'
  | 'Team Management'
  | 'Platform Settings'
  | 'Commercial'
  | 'Command Center'
  | 'Provisioning'
  | 'Other';

export function deriveSourceSurface(event: AuditEventLike): AuditSourceSurface {
  const cat = (event.category || '').toLowerCase();
  const action = (event.action || '').toLowerCase();
  if (action.startsWith('command center') || action.startsWith('command_center'))
    return 'Command Center';
  switch (cat) {
    case 'security':
      return 'Audit & Security';
    case 'support':
      return 'Support Tools';
    case 'domains':
      return 'Domains';
    case 'team':
      return 'Team Management';
    case 'configuration':
      return 'Platform Settings';
    case 'commercial':
    case 'addon':
    case 'billing':
      return 'Commercial';
    case 'provisioning':
    case 'lifecycle':
      return 'Provisioning';
    default:
      return 'Other';
  }
}

// --- CATEGORY FAMILY -------------------------------------------------------
// Collapses the many raw categories into investigation families used by
// correlation + lenses.

export type AuditCategoryFamily =
  | 'security'
  | 'permissions'
  | 'support'
  | 'commercial'
  | 'domains'
  | 'configuration'
  | 'team'
  | 'lifecycle'
  | 'other';

export function deriveCategoryFamily(event: AuditEventLike): AuditCategoryFamily {
  const cat = (event.category || '').toLowerCase();
  const action = (event.action || '').toLowerCase();
  if (cat === 'security') return 'security';
  if (cat === 'team') return /(permission|role)/.test(action) ? 'permissions' : 'team';
  if (cat === 'support') return 'support';
  if (cat === 'domains') return 'domains';
  if (cat === 'configuration') return 'configuration';
  if (cat === 'commercial' || cat === 'addon' || cat === 'billing') return 'commercial';
  if (cat === 'lifecycle' || cat === 'provisioning') return 'lifecycle';
  if (/(permission|role)/.test(action)) return 'permissions';
  return 'other';
}

// --- DAY INDEX (date-only correlation window) ------------------------------
// Audit rows persist a `date` (YYYY-MM-DD) only — no sub-day timestamp — so
// correlation windows are expressed in whole days. Deterministic + stable.

export function dayIndex(date: string | null | undefined): number | null {
  if (!date) return null;
  const t = Date.parse(`${date}T00:00:00Z`);
  if (Number.isNaN(t)) return null;
  return Math.floor(t / 86_400_000);
}

// --- INVESTIGATION EVENT ---------------------------------------------------
// A normalized, derived view of an audit row used everywhere in the
// investigation center. Original audit rows are never mutated.

export interface AuditInvestigationEvent {
  id: string;
  date: string;
  dayIndex: number | null;
  actor: string;
  action: string;
  target: string;
  severity: AuditEventSeverity;
  category: string;
  categoryFamily: AuditCategoryFamily;
  tenantId: string | null;
  sourceSurface: AuditSourceSurface;
  oldValue: string | number | null;
  newValue: string | number | null;
  note?: string;
  flag: HighRiskFlag;
  flagReasons: string[];
  isHighRisk: boolean;
}

export function toInvestigationEvent(row: AuditEventLike): AuditInvestigationEvent {
  const { flag, reasons } = deriveHighRiskFlag(row);
  return {
    id: row.id,
    date: row.date,
    dayIndex: dayIndex(row.date),
    actor: row.actor,
    action: row.action,
    target: row.target,
    severity: normalizeAuditSeverity(row.severity),
    category: row.category || 'other',
    categoryFamily: deriveCategoryFamily(row),
    tenantId: row.tenantId ?? null,
    sourceSurface: deriveSourceSurface(row),
    oldValue: row.oldValue ?? null,
    newValue: row.newValue ?? null,
    note: row.note,
    flag,
    flagReasons: reasons,
    isHighRisk: flag === 'critical' || flag === 'high_risk',
  };
}

// --- RISK SIGNALS ("Why this matters") -------------------------------------
// Deterministic, explainable reasons an event deserves review. If no rule
// matches the caller renders "No additional risk signal from current rules."

export type AuditRiskSignalCode =
  | 'critical_severity'
  | 'security_event'
  | 'permission_change'
  | 'destructive_action'
  | 'commercial_change'
  | 'escalation_change'
  | 'domain_config_change'
  | 'repeated_actor_activity';

export interface AuditRiskSignal {
  code: AuditRiskSignalCode;
  label: string;
  detail: string;
  severity: AuditEventSeverity;
}

export function deriveAuditRiskSignals(
  event: AuditInvestigationEvent,
  allEvents: AuditInvestigationEvent[] = []
): AuditRiskSignal[] {
  const signals: AuditRiskSignal[] = [];
  const action = (event.action || '').toLowerCase();

  if (event.severity === 'critical') {
    signals.push({
      code: 'critical_severity',
      label: 'Critical severity event',
      detail: 'This event is recorded at critical severity.',
      severity: 'critical',
    });
  }
  if (event.categoryFamily === 'security') {
    signals.push({
      code: 'security_event',
      label: 'Security-category event',
      detail: 'Security-category events are prioritized for review.',
      severity: 'warning',
    });
  }
  if (event.categoryFamily === 'permissions' || /(permission|role)/.test(action)) {
    signals.push({
      code: 'permission_change',
      label: 'Permission / role change',
      detail: 'Access or role configuration was changed.',
      severity: 'warning',
    });
  }
  if (/(delete|archive|block|suspend|disable|remove)/.test(action)) {
    signals.push({
      code: 'destructive_action',
      label: 'Destructive action',
      detail: 'A destructive action (delete / archive / block / suspend) was performed.',
      severity: 'warning',
    });
  }
  if (event.categoryFamily === 'commercial') {
    signals.push({
      code: 'commercial_change',
      label: 'Commercial / billing change',
      detail: 'A billing, add-on, or commercial entitlement change occurred.',
      severity: 'notice',
    });
  }
  if (event.categoryFamily === 'support' && /escalat/.test(action)) {
    signals.push({
      code: 'escalation_change',
      label: 'Support escalation lifecycle change',
      detail: 'A support escalation lifecycle transition occurred.',
      severity: 'warning',
    });
  }
  if (event.categoryFamily === 'domains' || event.categoryFamily === 'configuration') {
    signals.push({
      code: 'domain_config_change',
      label: 'Domain / configuration change',
      detail: 'A domain or platform configuration change occurred.',
      severity: 'notice',
    });
  }

  // Repeated actor activity in the same window (rule-based, explainable).
  if (allEvents.length && event.dayIndex != null) {
    const window = 2;
    const sameActorNearby = allEvents.filter(
      e =>
        e.id !== event.id &&
        e.actor === event.actor &&
        e.dayIndex != null &&
        Math.abs(e.dayIndex - (event.dayIndex as number)) <= window
    );
    const highRiskNearby = sameActorNearby.filter(e => e.flag != null).length;
    if (sameActorNearby.length >= 2 && highRiskNearby >= 1) {
      signals.push({
        code: 'repeated_actor_activity',
        label: 'Repeated actor activity',
        detail: `${event.actor} performed ${sameActorNearby.length} other action${
          sameActorNearby.length === 1 ? '' : 's'
        } within ${window} days of this event.`,
        severity: 'notice',
      });
    }
  }

  return signals;
}

// --- ACTOR PROFILE ---------------------------------------------------------

export interface AuditActorProfile {
  actor: string;
  total: number;
  severityBreakdown: Record<AuditEventSeverity, number>;
  categoryBreakdown: Array<[string, number]>;
  tenantsTouched: string[];
  lastActivity: string | null;
  highRiskCount: number;
  recent: AuditInvestigationEvent[];
  signals: string[];
}

export function deriveAuditActorProfile(
  actor: string,
  allEvents: AuditInvestigationEvent[],
  selectedEvent?: AuditInvestigationEvent | null
): AuditActorProfile {
  const own = allEvents
    .filter(e => e.actor === actor)
    .slice()
    .sort((a, b) => (a.date === b.date ? b.id.localeCompare(a.id) : a.date < b.date ? 1 : -1));

  const severityBreakdown: Record<AuditEventSeverity, number> = {
    info: 0,
    notice: 0,
    warning: 0,
    critical: 0,
  };
  const catMap = new Map<string, number>();
  const tenants = new Set<string>();
  let highRiskCount = 0;

  for (const e of own) {
    severityBreakdown[e.severity]++;
    catMap.set(e.category, (catMap.get(e.category) || 0) + 1);
    if (e.tenantId) tenants.add(e.tenantId);
    if (e.flag != null) highRiskCount++;
  }

  // Rule-based, explainable activity signals (never behavioral AI).
  const signals: string[] = [];
  const families = new Set(own.map(e => e.categoryFamily));
  if (selectedEvent && selectedEvent.dayIndex != null) {
    const window = 2;
    const nearby = own.filter(
      e =>
        e.dayIndex != null &&
        Math.abs(e.dayIndex - (selectedEvent.dayIndex as number)) <= window
    );
    const highRiskNearby = nearby.filter(e => e.flag != null).length;
    if (highRiskNearby >= 2) {
      signals.push(
        `Actor performed ${highRiskNearby} high-risk actions within ${window} days of the selected event.`
      );
    }
    if (families.has('permissions') && families.has('commercial')) {
      signals.push('Actor changed permissions and commercial settings in this period.');
    }
    if (nearby.length <= 1) {
      signals.push('Actor has no other related events in this time range.');
    }
  }
  if (!signals.length) {
    signals.push('No additional actor risk signal from current rules.');
  }

  return {
    actor,
    total: own.length,
    severityBreakdown,
    categoryBreakdown: Array.from(catMap.entries()).sort((a, b) => b[1] - a[1]).slice(0, 6),
    tenantsTouched: Array.from(tenants),
    lastActivity: own.length ? own[0].date : null,
    highRiskCount,
    recent: own.slice(0, 8),
    signals,
  };
}

// --- RELATED EVENTS + ENTITY TIMELINE --------------------------------------

export function deriveRelatedEvents(
  selected: AuditInvestigationEvent,
  allEvents: AuditInvestigationEvent[],
  limit = 12
): AuditInvestigationEvent[] {
  return allEvents
    .filter(e => e.id !== selected.id)
    .filter(
      e =>
        (!!selected.tenantId && e.tenantId === selected.tenantId) ||
        (!!selected.target && e.target === selected.target) ||
        (!!selected.actor && e.actor === selected.actor)
    )
    .slice(0, limit);
}

export interface AuditEntityTimeline {
  entityKey: string;
  entityLabel: string;
  events: AuditInvestigationEvent[];
}

// Related entity timeline: events for the same tenant/target/entity sorted
// chronologically (oldest → newest reads as a story), selected highlighted.
export function deriveEntityTimeline(
  selected: AuditInvestigationEvent,
  allEvents: AuditInvestigationEvent[],
  tenantNameById?: Map<string, string>,
  limit = 20
): AuditEntityTimeline {
  const entityKey = selected.tenantId || selected.target || selected.id;
  const entityLabel = selected.tenantId
    ? tenantNameById?.get(selected.tenantId) || selected.tenantId
    : selected.target || 'This event';

  const matches = allEvents.filter(e =>
    selected.tenantId
      ? e.tenantId === selected.tenantId
      : selected.target
        ? e.target === selected.target
        : e.id === selected.id
  );

  const sorted = matches
    .slice()
    .sort((a, b) => (a.date === b.date ? a.id.localeCompare(b.id) : a.date < b.date ? -1 : 1))
    .slice(-limit);

  return { entityKey, entityLabel, events: sorted };
}

// --- CORRELATED EVENT GROUPS -----------------------------------------------

export type AuditCorrelationKind =
  | 'actor_burst'
  | 'tenant_cluster'
  | 'permission_escalation_chain'
  | 'commercial_sequence'
  | 'domain_config_sequence';

export interface AuditRelatedEventGroup {
  id: string;
  kind: AuditCorrelationKind;
  title: string;
  reason: string;
  recommendedAction: string;
  severity: AuditEventSeverity;
  confidence: SignalConfidence;
  count: number;
  actor: string | null;
  tenantId: string | null;
  eventIds: string[];
}

// Greedy windowed clustering: events (already sorted desc by date) are grouped
// so each member is within `windowDays` of the cluster anchor.
function clusterByWindow(
  events: AuditInvestigationEvent[],
  windowDays: number
): AuditInvestigationEvent[][] {
  const dated = events.filter(e => e.dayIndex != null);
  if (!dated.length) return [];
  const sorted = dated
    .slice()
    .sort((a, b) => (b.dayIndex as number) - (a.dayIndex as number));
  const clusters: AuditInvestigationEvent[][] = [];
  let current: AuditInvestigationEvent[] = [sorted[0]];
  let anchor = sorted[0].dayIndex as number;
  for (let i = 1; i < sorted.length; i++) {
    const di = sorted[i].dayIndex as number;
    if (anchor - di <= windowDays) {
      current.push(sorted[i]);
    } else {
      clusters.push(current);
      current = [sorted[i]];
      anchor = di;
    }
  }
  clusters.push(current);
  return clusters;
}

function confidenceFor(count: number, severity: AuditEventSeverity): SignalConfidence {
  if (count >= 4 || severity === 'critical') return 'High';
  if (count >= 3) return 'Medium';
  return 'Low';
}

function groupByKey<T>(items: T[], keyFn: (t: T) => string | null): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const it of items) {
    const k = keyFn(it);
    if (k == null) continue;
    const arr = m.get(k);
    if (arr) arr.push(it);
    else m.set(k, [it]);
  }
  return m;
}

export interface CorrelationOptions {
  windowDays?: number;
  minClusterSize?: number;
  maxGroups?: number;
}

export function deriveCorrelatedGroups(
  allEvents: AuditInvestigationEvent[],
  opts: CorrelationOptions = {}
): AuditRelatedEventGroup[] {
  const windowDays = opts.windowDays ?? 3;
  const minSize = opts.minClusterSize ?? 2;
  const maxGroups = opts.maxGroups ?? 24;
  const groups: AuditRelatedEventGroup[] = [];

  const pushClusterGroups = (
    kind: AuditCorrelationKind,
    keyed: Map<string, AuditInvestigationEvent[]>,
    build: (
      key: string,
      cluster: AuditInvestigationEvent[]
    ) => Omit<AuditRelatedEventGroup, 'id' | 'kind' | 'severity' | 'confidence' | 'count' | 'eventIds'> & {
      qualifies: boolean;
    }
  ) => {
    keyed.forEach((events, key) => {
      for (const cluster of clusterByWindow(events, windowDays)) {
        if (cluster.length < minSize) continue;
        const meta = build(key, cluster);
        if (!meta.qualifies) continue;
        const severity = maxSeverity(cluster.map(e => e.severity));
        groups.push({
          id: `corr_${kind}_${key}_${cluster[0].id}`,
          kind,
          title: meta.title,
          reason: meta.reason,
          recommendedAction: meta.recommendedAction,
          severity,
          confidence: confidenceFor(cluster.length, severity),
          count: cluster.length,
          actor: meta.actor,
          tenantId: meta.tenantId,
          eventIds: cluster.map(e => e.id),
        });
      }
    });
  };

  // 1. Actor burst — same actor, multiple flagged actions in window.
  pushClusterGroups('actor_burst', groupByKey(allEvents, e => e.actor || null), (key, cluster) => {
    const flagged = cluster.filter(e => e.flag != null).length;
    return {
      qualifies: flagged >= 2,
      title: `${key} — activity burst`,
      reason: `${key} performed ${cluster.length} actions (${flagged} flagged) within ${windowDays} days.`,
      recommendedAction: 'Review whether this actor activity was expected and authorized.',
      actor: key,
      tenantId: null,
    };
  });

  // 2. Tenant cluster — same tenant, multiple events (≥1 flagged) in window.
  pushClusterGroups(
    'tenant_cluster',
    groupByKey(allEvents, e => e.tenantId || null),
    (key, cluster) => {
      const flagged = cluster.filter(e => e.flag != null).length;
      return {
        qualifies: flagged >= 1 && cluster.length >= 2,
        title: `Tenant ${key} — event cluster`,
        reason: `${cluster.length} events on tenant ${key} (${flagged} flagged) within ${windowDays} days.`,
        recommendedAction: 'Open the tenant timeline to confirm the cluster is benign.',
        actor: null,
        tenantId: key,
      };
    }
  );

  // 3. Permission + support escalation chain — same actor, both a permission
  //    change and a support escalation in window.
  pushClusterGroups('permission_escalation_chain', groupByKey(allEvents, e => e.actor || null), (key, cluster) => {
    const hasPerm = cluster.some(e => e.categoryFamily === 'permissions');
    const hasEsc = cluster.some(
      e => e.categoryFamily === 'support' && /escalat/.test((e.action || '').toLowerCase())
    );
    return {
      qualifies: hasPerm && hasEsc,
      title: `${key} — permission + escalation chain`,
      reason: `${key} changed permissions and acted on a support escalation within ${windowDays} days.`,
      recommendedAction: 'Verify the access change was related to the escalation and authorized.',
      actor: key,
      tenantId: null,
    };
  });

  // 4. Commercial / add-on change sequence — by tenant.
  pushClusterGroups(
    'commercial_sequence',
    groupByKey(
      allEvents.filter(e => e.categoryFamily === 'commercial'),
      e => e.tenantId || '__platform__'
    ),
    (key, cluster) => ({
      qualifies: cluster.length >= 2,
      title:
        key === '__platform__'
          ? 'Platform commercial change sequence'
          : `Tenant ${key} — commercial change sequence`,
      reason: `${cluster.length} commercial / add-on changes within ${windowDays} days.`,
      recommendedAction: 'Confirm the commercial changes match an approved request.',
      actor: null,
      tenantId: key === '__platform__' ? null : key,
    })
  );

  // 5. Domain / configuration change sequence — by tenant/platform.
  pushClusterGroups(
    'domain_config_sequence',
    groupByKey(
      allEvents.filter(
        e => e.categoryFamily === 'domains' || e.categoryFamily === 'configuration'
      ),
      e => e.tenantId || '__platform__'
    ),
    (key, cluster) => ({
      qualifies: cluster.length >= 2,
      title:
        key === '__platform__'
          ? 'Platform configuration change sequence'
          : `Tenant ${key} — domain / config sequence`,
      reason: `${cluster.length} domain / configuration changes within ${windowDays} days.`,
      recommendedAction: 'Confirm the configuration changes were intended.',
      actor: null,
      tenantId: key === '__platform__' ? null : key,
    })
  );

  return groups
    .sort((a, b) =>
      SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] || b.count - a.count
    )
    .slice(0, maxGroups);
}

// --- REVIEW STATUS ---------------------------------------------------------

export type AuditReviewStatus = 'needs_review' | 'reviewed' | 'dismissed';

export const AUDIT_REVIEW_STATUS_LABEL: Record<AuditReviewStatus, string> = {
  needs_review: 'Needs Review',
  reviewed: 'Reviewed',
  dismissed: 'Dismissed',
};

export const AUDIT_REVIEW_STATUS_STYLES: Record<AuditReviewStatus, string> = {
  needs_review: 'bg-amber-400/10 text-amber-700 border-amber-400/20',
  reviewed: 'bg-emerald-400/10 text-emerald-700 border-emerald-400/20',
  dismissed: 'bg-slate-100 text-slate-500 border-slate-200',
};

// --- OVERLAY / NOTES / EVIDENCE / SEARCH (data-model contracts) ------------
// Defined here so the model is complete; read/write helpers + UI land in the
// review-status / notes / evidence milestone. Review state is overlay
// metadata persisted separately — original audit rows are never modified.

export interface AuditInvestigationNote {
  id: string;
  eventId: string;
  text: string;
  author: string;
  role?: string;
  createdAt: string;
}

export interface AuditReviewState {
  eventId: string;
  status: AuditReviewStatus;
  reviewedBy?: string;
  reviewedAt?: string;
}

export interface AuditInvestigationState {
  reviews: Record<string, AuditReviewState>;
  notes: AuditInvestigationNote[];
}

export interface AuditCaseLink {
  eventId: string;
  caseId: string;
}

export interface AuditEvidenceSummary {
  generatedAt: string;
  event: AuditInvestigationEvent;
  riskSignals: AuditRiskSignal[];
  relatedEventIds: string[];
  notes: AuditInvestigationNote[];
  linkedCaseId: string | null;
  reviewStatus: AuditReviewStatus;
  truthLabel: string;
}

export interface AuditSearchQueryState {
  keyword: string;
  severity: 'all' | AuditEventSeverity;
  category: 'all' | string;
  tenantId: 'all' | string;
  actor: 'all' | string;
  actionType: 'all' | string;
  sourceSurface: 'all' | AuditSourceSurface;
  review: 'all' | AuditReviewStatus;
  linkedCase: 'all' | 'linked' | 'unlinked';
  restricted: 'all' | 'restricted_only';
  timeRange: 'all' | 'today' | '7d' | '30d';
}

export const EMPTY_AUDIT_SEARCH_QUERY: AuditSearchQueryState = {
  keyword: '',
  severity: 'all',
  category: 'all',
  tenantId: 'all',
  actor: 'all',
  actionType: 'all',
  sourceSurface: 'all',
  review: 'all',
  linkedCase: 'all',
  restricted: 'all',
  timeRange: 'all',
};
