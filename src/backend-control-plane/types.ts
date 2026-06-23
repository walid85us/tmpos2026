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
