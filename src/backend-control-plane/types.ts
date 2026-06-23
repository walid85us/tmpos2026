// Phase 1.6 M22B — Backend Control Plane read-only / mock-only UI foundation.
// Shared types for the BCP shell. No runtime behaviour; presentational only.

export type StateChip =
  | 'Current'
  | 'Planned'
  | 'Future'
  | 'Dormant'
  | 'Read-Only First'
  | 'Production Blocked';

export type ActionChip =
  | 'Read Only'
  | 'Request Only'
  | 'Approval Required'
  | 'Owner Approval'
  | 'Separation of Duties'
  | 'DEV Only'
  | 'Production Blocked'
  | 'Audit Required'
  | 'Default OFF';

export type ModuleStatus = 'included' | 'placeholder' | 'deferred' | 'blocked';

export type EnvLabel = 'DEV' | 'STAGING' | 'PRODUCTION';

export type Health = 'healthy' | 'warning' | 'blocked' | 'neutral';

export interface BcpModule {
  id: string;
  name: string;
  group: string;
  state: StateChip;
  status: ModuleStatus;
  purpose: string;
  /** What a future, separately-approved milestone would add. */
  futureMilestone: string;
  /** Conceptual actions that remain blocked / disabled in this foundation. */
  blockedActions: string[];
  /** Why this module is included / placeholder / deferred / blocked. */
  reason: string;
}

export interface Kpi {
  label: string;
  value: string;
  hint: string;
  tone: Health;
}

export interface TenantRow {
  label: string;
  isolation: string;
  dbStatus: string;
  stores: string;
  schema: string;
  backup: string;
  lastAudit: string;
  production: string;
}

export interface StoreRow {
  label: string;
  tenant: string;
  dbStatus: string;
  service: string;
  pos: string;
  repair: string;
  inventory: string;
  backup: string;
  lastEvent: string;
}

export interface DatabaseRow {
  scope: string;
  environment: string;
  schema: string;
  migration: string;
  rls: string;
  backup: string;
  connection: string;
  lock: string;
  tone: Health;
}

export interface ServiceCard {
  name: string;
  status: string;
  tone: Health;
  uptime: string;
  note: string;
}

export interface ApprovalRow {
  request: string;
  requester: string;
  approver: string;
  state: string;
  sod: string;
  environment: string;
}

export interface AuditRow {
  category: string;
  outcome: string;
  reason: string;
  actor: string;
  environment: string;
  evidence: string;
}

export interface PolicyCard {
  title: string;
  detail: string;
  enforced: boolean;
}

export interface GateRoleCard {
  name: string;
  scope: string;
  access: string;
}

export interface PermissionRow {
  role: string;
  read: string;
  request: string;
  approve: string;
  execute: string;
  production: string;
}

// Phase 1.6 M23 — read-only operations expansion (presentational only).

/** Generic read-only posture tile (system / data / audit overviews). */
export interface PostureCard {
  title: string;
  status: string;
  detail: string;
  tone: Health;
}

/** Identity / authorization readiness tile with an explicit blocked write/execute state. */
export interface ReadinessCard {
  domain: string;
  status: string;
  /** Explicit "writes blocked" / "execution blocked" / "not authoritative" label. */
  writeState: string;
  detail: string;
  tone: Health;
}

/** Static, non-clickable runbook / diagnostics label (no live invocation). */
export interface RunbookItem {
  label: string;
  category: string;
  note: string;
}

// Phase 1.6 M24 — read-only detail drilldowns (presentational only).

/** Service-by-service operational detail (mock; no live health check). */
export interface OpsServiceDetail {
  name: string;
  tone: Health;
  status: string;
  uptime: string;
  latency: string;
  lastChecked: string;
}

/** Job / queue / alert detail row (mock). */
export interface OpsJobDetail {
  name: string;
  type: string;
  state: string;
  severity: string;
  lastEvent: string;
}

/** Governance posture detail row (data governance + audit detail), with mock review fields. */
export interface GovDetail {
  area: string;
  posture: string;
  status: string;
  lastReviewed: string;
  note: string;
}

/** Identity / authorization readiness detail with explicit blocked write/execute/authority states. */
export interface IdentityDetail {
  domain: string;
  posture: string;
  writeState: string;
  executeState: string;
  authority: string;
  note: string;
}

/** Diagnostics / runbook catalogue detail (mock; not invokable). */
export interface DiagnosticDetail {
  label: string;
  category: string;
  severity: string;
  owner: string;
  status: string;
  note: string;
}

// Phase 1.6 M25 — read-only Risk & Alerts Lens (presentational only).

/** Static, mock-only alert / risk category (no live alerting or notification). */
export interface AlertCategory {
  category: string;
  severity: string;
  state: string;
  tone: Health;
  detail: string;
}

/** Static governance attention item (read-only; no approve/deny/resolve/assign). */
export interface GovernanceItem {
  item: string;
  area: string;
  state: string;
  severity: string;
  note: string;
}

/** Static blocked-action register entry with the reason it remains blocked. */
export interface BlockedAction {
  action: string;
  reason: string;
}

// Phase 1.6 M26 — read-only Timeline & Evidence Lens (presentational only).

/** Static milestone timeline entry (safe labels only; no raw logs or commit diffs). */
export interface TimelineEntry {
  milestone: string;
  title: string;
  state: string;
  checkpoint: string;
  tone: Health;
  detail: string;
}

/** Static evidence-register row (safe status + note; no raw terminal output). */
export interface EvidenceRow {
  category: string;
  status: string;
  tone: Health;
  note: string;
}
