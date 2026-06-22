// Phase 1.6 M22B — Backend Control Plane read-only / mock-only UI foundation.
//
// SAFE STATIC MOCK DATA ONLY. Every value here is a fictional, redaction-safe label.
// There are NO real identifiers, emails, domains, IPs, tokens, secrets, DB URLs,
// provider UIDs, internal_user_id values, raw payloads, or raw audit rows.
// Nothing in this file is fetched; nothing connects to a backend or database.

import type {
  ApprovalRow,
  AuditRow,
  BcpModule,
  DatabaseRow,
  GateRoleCard,
  Kpi,
  PermissionRow,
  PolicyCard,
  ServiceCard,
  StoreRow,
  TenantRow,
} from './types';

export const ENVIRONMENTS = ['DEV', 'STAGING', 'PRODUCTION'] as const;

// ---------------------------------------------------------------------------
// 23-module registry (drives the sidebar navigation and screen routing).
// ---------------------------------------------------------------------------
export const MODULES: BcpModule[] = [
  {
    id: 'access-gate',
    name: 'Separate Access Gate',
    group: 'Overview',
    state: 'Read-Only First',
    status: 'included',
    purpose: 'Establish the separate secure workspace identity (mock/read-only).',
    futureMilestone: 'Real gate: owner-granted scoped access, second-factor posture, session scope.',
    blockedActions: ['Authenticate', 'Create session', 'Grant access'],
    reason: 'Foundational entry; rendered as a mock visual gate with no real authentication.',
  },
  {
    id: 'command-center',
    name: 'Command Center',
    group: 'Overview',
    state: 'Read-Only First',
    status: 'included',
    purpose: 'At-a-glance posture and governance status across environments.',
    futureMilestone: 'Aggregated, environment-scoped status surface fed by governed read models.',
    blockedActions: ['None — observational only'],
    reason: 'Primary first read-only screen with mock posture tiles.',
  },
  {
    id: 'operations-console',
    name: 'Operations Console',
    group: 'Overview',
    state: 'Planned',
    status: 'placeholder',
    purpose: 'Unified operational triage overview (services, jobs, API, logs).',
    futureMilestone: 'Cross-domain triage with read-only drill-through.',
    blockedActions: ['Any control action'],
    reason: 'Placeholder: full triage surface is a later read-only milestone.',
  },
  {
    id: 'tenants',
    name: 'Tenants',
    group: 'Tenancy & Data',
    state: 'Read-Only First',
    status: 'included',
    purpose: 'Observe tenant inventory and isolation posture (opaque references).',
    futureMilestone: 'Governed tenant database provisioning (approval-required, DEV-first).',
    blockedActions: ['Provision tenant DB', 'Edit tenant'],
    reason: 'Demonstrates redaction, isolation posture, and topology.',
  },
  {
    id: 'stores',
    name: 'Stores',
    group: 'Tenancy & Data',
    state: 'Read-Only First',
    status: 'included',
    purpose: 'Observe store inventory and store-scoped isolation posture.',
    futureMilestone: 'Governed store database / isolation-unit provisioning.',
    blockedActions: ['Provision store DB', 'Edit store'],
    reason: 'Pairs with Tenants to show the isolation map.',
  },
  {
    id: 'tenant-isolation-debugger',
    name: 'Tenant Isolation Debugger',
    group: 'Tenancy & Data',
    state: 'Planned',
    status: 'placeholder',
    purpose: 'Verify and visualize isolation posture (RLS posture, boundaries).',
    futureMilestone: 'Read-only isolation assertion and drift detection.',
    blockedActions: ['Any mutation'],
    reason: 'Placeholder: full isolation checks are a later read-only milestone.',
  },
  {
    id: 'database-registry',
    name: 'Database Registry',
    group: 'Tenancy & Data',
    state: 'Read-Only First',
    status: 'included',
    purpose: 'Catalog databases with posture metadata (never connection strings).',
    futureMilestone: 'Authoritative registry feeding provisioning, backups, migrations.',
    blockedActions: ['Register', 'Lock', 'Unlock'],
    reason: 'Core read-only value surface for the BCP.',
  },
  {
    id: 'database-control',
    name: 'Database Control',
    group: 'Tenancy & Data',
    state: 'Future',
    status: 'blocked',
    purpose: 'Governed database orchestration (provisioning, lifecycle).',
    futureMilestone: 'Governed provisioning pipeline (approval + separation of duties, DEV-first).',
    blockedActions: ['Provision', 'Lock', 'Unlock', 'Destructive orchestration'],
    reason: 'Blocked (Future): orchestration is heavily gated and not built.',
  },
  {
    id: 'schema-migrations',
    name: 'Schema & Migrations',
    group: 'Tenancy & Data',
    state: 'Planned',
    status: 'placeholder',
    purpose: 'Observe schema versions and migration state; govern apply (future).',
    futureMilestone: 'Approval-gated, non-destructive migration apply (DEV-first).',
    blockedActions: ['Apply migration', 'Destructive change'],
    reason: 'Placeholder: viewer/apply is a later, governed milestone.',
  },
  {
    id: 'services',
    name: 'Services',
    group: 'Platform Operations',
    state: 'Read-Only First',
    status: 'included',
    purpose: 'Backend service health panels and status.',
    futureMilestone: 'Governed restart/scale request (approval-required).',
    blockedActions: ['Restart', 'Scale'],
    reason: 'Read-only operations health surface.',
  },
  {
    id: 'jobs-workers',
    name: 'Jobs & Workers',
    group: 'Platform Operations',
    state: 'Planned',
    status: 'placeholder',
    purpose: 'Observe jobs, queues, and workers; govern control (future).',
    futureMilestone: 'Governed pause/retry/cancel (approval-required).',
    blockedActions: ['Pause', 'Retry', 'Cancel'],
    reason: 'Placeholder: control surface is a later milestone.',
  },
  {
    id: 'api-traffic',
    name: 'API Traffic',
    group: 'Platform Operations',
    state: 'Planned',
    status: 'placeholder',
    purpose: 'Observe aggregate API health and rates.',
    futureMilestone: 'Aggregate rate/posture observation (no raw payloads, ever).',
    blockedActions: ['Raw header/body inspection (never)'],
    reason: 'Placeholder: aggregate-only surface is a later milestone.',
  },
  {
    id: 'logs-telemetry',
    name: 'Logs & Telemetry',
    group: 'Platform Operations',
    state: 'Planned',
    status: 'placeholder',
    purpose: 'Centralized, redacted logs and telemetry views.',
    futureMilestone: 'Governed, redacted log search (no secrets/raw identifiers, ever).',
    blockedActions: ['Secret/raw-identifier exposure (never)'],
    reason: 'Placeholder: redacted log surface is a later milestone.',
  },
  {
    id: 'identity-access',
    name: 'Identity & Access',
    group: 'Identity & Security',
    state: 'Read-Only First',
    status: 'included',
    purpose: 'Govern BCP roles and scoped grants (mock display; not app authority).',
    futureMilestone: 'Owner-granted scoped access administration (approval-required).',
    blockedActions: ['Grant', 'Revoke', 'Surface actor identities (never)'],
    reason: 'Core governance display (roles + permission matrix), mock only.',
  },
  {
    id: 'identity-links',
    name: 'Identity Links',
    group: 'Identity & Security',
    state: 'Dormant',
    status: 'included',
    purpose: 'Govern the future identity-link lifecycle (currently dormant).',
    futureMilestone: 'Governed admin provisioning (create/disable/revoke), DEV-only, approval-required.',
    blockedActions: ['Create link', 'Disable link', 'Revoke link', 'Self-service linking (never)'],
    reason: 'Shown with dormant / default-OFF / unwired state and strong redaction messaging.',
  },
  {
    id: 'config-secrets',
    name: 'Configuration & Secrets Posture',
    group: 'Identity & Security',
    state: 'Planned',
    status: 'placeholder',
    purpose: 'Show configuration and secrets posture (never values).',
    futureMilestone: 'Posture monitoring and rotation governance (values never shown).',
    blockedActions: ['Display secret value (never)', 'Rotate'],
    reason: 'Placeholder: posture-only surface is a later milestone.',
  },
  {
    id: 'audit-approvals',
    name: 'Audit & Approvals',
    group: 'Governance',
    state: 'Read-Only First',
    status: 'included',
    purpose: 'Immutable, redacted audit timeline plus the approval queue.',
    futureMilestone: 'Governed approval queue feeding all sensitive modules.',
    blockedActions: ['Approve', 'Reject', 'Edit/delete evidence (never)'],
    reason: 'Core governance surface (timeline + queue), mock only.',
  },
  {
    id: 'policies-guardrails',
    name: 'Policies & Guardrails',
    group: 'Governance',
    state: 'Read-Only First',
    status: 'included',
    purpose: 'Registry of guardrail policies and their enforcement posture.',
    futureMilestone: 'Policy registry that gates governed actions.',
    blockedActions: ['Edit policy', 'Weaken guardrail (never in production)'],
    reason: 'Read-only registry showing production blockers.',
  },
  {
    id: 'deployments-releases',
    name: 'Deployments & Releases',
    group: 'Delivery',
    state: 'Future',
    status: 'deferred',
    purpose: 'Observe deployment/release state; govern promotions (future).',
    futureMilestone: 'Governed, approval-gated promotion (production-blocked).',
    blockedActions: ['Promote', 'Rollback'],
    reason: 'Deferred: lower priority for the read-only foundation.',
  },
  {
    id: 'environments-infra',
    name: 'Environments & Infrastructure',
    group: 'Delivery',
    state: 'Planned',
    status: 'placeholder',
    purpose: 'Observe environment groups and infrastructure posture.',
    futureMilestone: 'Governed environment/infrastructure controls (production-blocked).',
    blockedActions: ['Infra change'],
    reason: 'Placeholder: read-only posture surface is a later milestone.',
  },
  {
    id: 'backups-recovery',
    name: 'Backups & Recovery',
    group: 'Tenancy & Data',
    state: 'Future',
    status: 'deferred',
    purpose: 'Observe backup/recovery state; govern restore (future).',
    futureMilestone: 'Governed restore (approval + separation of duties, DEV-first).',
    blockedActions: ['Restore', 'Production restore (never until approved)'],
    reason: 'Deferred: restore is a heavily-gated later milestone.',
  },
  {
    id: 'support-tools',
    name: 'Support / Operator Tools',
    group: 'Operator',
    state: 'Planned',
    status: 'deferred',
    purpose: 'Safe, bounded operator helpers (redacted lookups, diagnostics).',
    futureMilestone: 'Bounded, audited support actions (redacted-only).',
    blockedActions: ['Raw identifier/PII access (never)', 'Impersonation (never)'],
    reason: 'Deferred: bounded support actions are a later milestone.',
  },
  {
    id: 'control-plane-settings',
    name: 'Control Plane Settings',
    group: 'Settings',
    state: 'Planned',
    status: 'placeholder',
    purpose: 'BCP configuration (itself governed).',
    futureMilestone: 'Governed configuration of the BCP (safety-relevant changes approval-required).',
    blockedActions: ['Disable audit/approval/production-lock/redaction (never)'],
    reason: 'Placeholder: governed settings are a later milestone.',
  },
];

export const NAV_GROUP_ORDER = [
  'Overview',
  'Tenancy & Data',
  'Platform Operations',
  'Identity & Security',
  'Governance',
  'Delivery',
  'Operator',
  'Settings',
];

// ---------------------------------------------------------------------------
// Command Center KPIs (mock).
// ---------------------------------------------------------------------------
export const KPIS: Kpi[] = [
  { label: 'Total Tenants', value: '3', hint: 'Opaque references', tone: 'neutral' },
  { label: 'Total Stores', value: '3', hint: 'Opaque references', tone: 'neutral' },
  { label: 'Tenant Databases', value: '3', hint: 'Isolation mock', tone: 'healthy' },
  { label: 'Store Databases', value: '3', hint: 'Isolation mock', tone: 'healthy' },
  { label: 'Backend Services', value: '8', hint: 'Health mock', tone: 'healthy' },
  { label: 'Active Jobs', value: '5', hint: 'Queue mock', tone: 'warning' },
  { label: 'Pending Approvals', value: '4', hint: 'Awaiting reviewer', tone: 'warning' },
  { label: 'Critical Alerts', value: '1', hint: 'Mock alert', tone: 'blocked' },
  { label: 'Backup Success Rate', value: '100%', hint: 'Mock posture', tone: 'healthy' },
  { label: 'Production Locks', value: 'Locked', hint: 'Production blocked', tone: 'blocked' },
];

export const TENANTS: TenantRow[] = [
  { label: 'Tenant Alpha', isolation: 'Database-per-Tenant', dbStatus: 'DB Healthy', stores: '2', schema: 'Schema v-mock', backup: 'Backup Ready', lastAudit: 'Redacted Evidence', production: 'Production Blocked' },
  { label: 'Tenant Beta', isolation: 'Database-per-Tenant', dbStatus: 'DB Healthy', stores: '1', schema: 'Schema v-mock', backup: 'Backup Ready', lastAudit: 'Redacted Evidence', production: 'Production Blocked' },
  { label: 'Tenant Gamma', isolation: 'Store-Scoped Isolation', dbStatus: 'Migration Pending', stores: '0', schema: 'Schema v-mock', backup: 'Backup Ready', lastAudit: 'Redacted Evidence', production: 'Production Blocked' },
];

export const STORES: StoreRow[] = [
  { label: 'Store 001', tenant: 'Tenant Alpha', dbStatus: 'DB Healthy', service: 'Service Healthy', pos: 'POS Ready', repair: 'Repairs Ready', inventory: 'Inventory Ready', backup: 'Backup Ready', lastEvent: 'Event Redacted' },
  { label: 'Store 002', tenant: 'Tenant Alpha', dbStatus: 'DB Healthy', service: 'Service Healthy', pos: 'POS Ready', repair: 'Repairs Ready', inventory: 'Queue Warning', backup: 'Backup Ready', lastEvent: 'Event Redacted' },
  { label: 'Store 003', tenant: 'Tenant Beta', dbStatus: 'Migration Pending', service: 'Service Healthy', pos: 'POS Ready', repair: 'Repairs Ready', inventory: 'Inventory Ready', backup: 'Backup Ready', lastEvent: 'Event Redacted' },
];

export const DATABASES: DatabaseRow[] = [
  { scope: 'Tenant DB', environment: 'DEV', schema: 'Schema v-mock', migration: 'Up to date', rls: 'RLS Protected', backup: 'Backup Ready', connection: 'Masked Connection', lock: 'Production Blocked', tone: 'healthy' },
  { scope: 'Store DB', environment: 'DEV', schema: 'Schema v-mock', migration: 'Migration Pending', rls: 'RLS Protected', backup: 'Backup Ready', connection: 'Masked Connection', lock: 'Production Blocked', tone: 'warning' },
  { scope: 'Shared Reference', environment: 'DEV', schema: 'Schema v-mock', migration: 'Up to date', rls: 'RLS Protected', backup: 'Backup Ready', connection: 'Masked Connection', lock: 'Production Blocked', tone: 'healthy' },
  { scope: 'Audit DB', environment: 'DEV', schema: 'Schema v-mock', migration: 'Up to date', rls: 'RLS Protected', backup: 'Backup Ready', connection: 'Masked Connection', lock: 'Append-Only', tone: 'healthy' },
  { scope: 'Control Metadata', environment: 'DEV', schema: 'Schema v-mock', migration: 'Up to date', rls: 'RLS Protected', backup: 'Backup Ready', connection: 'Masked Connection', lock: 'Production Blocked', tone: 'healthy' },
];

export const SERVICES: ServiceCard[] = [
  { name: 'Auth Service', status: 'Service Healthy', tone: 'healthy', uptime: 'Mock uptime', note: 'Read-only health' },
  { name: 'POS Service', status: 'Service Healthy', tone: 'healthy', uptime: 'Mock uptime', note: 'Read-only health' },
  { name: 'Repairs Service', status: 'Service Healthy', tone: 'healthy', uptime: 'Mock uptime', note: 'Read-only health' },
  { name: 'Inventory Service', status: 'Queue Warning', tone: 'warning', uptime: 'Mock uptime', note: 'Read-only health' },
  { name: 'Shipping Service', status: 'Service Healthy', tone: 'healthy', uptime: 'Mock uptime', note: 'Read-only health' },
  { name: 'Identity Link Service', status: 'Default OFF', tone: 'neutral', uptime: 'Unwired', note: 'Server-only, default OFF' },
  { name: 'Audit Service', status: 'Service Healthy', tone: 'healthy', uptime: 'Append-only', note: 'Read-only health' },
  { name: 'Worker Service', status: 'Queue Warning', tone: 'warning', uptime: 'Mock uptime', note: 'Read-only health' },
];

export const APPROVALS: ApprovalRow[] = [
  { request: 'Tenant DB provisioning (mock)', requester: 'Actor Redacted', approver: 'Actor Redacted', state: 'Approval Required', sod: 'Separation of Duties', environment: 'DEV' },
  { request: 'Schema migration apply (mock)', requester: 'Actor Redacted', approver: 'Actor Redacted', state: 'Approval Required', sod: 'Separation of Duties', environment: 'DEV' },
  { request: 'Identity link create (mock)', requester: 'Actor Redacted', approver: 'Actor Redacted', state: 'Approval Required', sod: 'Separation of Duties', environment: 'DEV' },
  { request: 'Secret rotation (mock)', requester: 'Actor Redacted', approver: 'Actor Redacted', state: 'Approval Required', sod: 'Separation of Duties', environment: 'DEV' },
];

export const AUDIT_EVENTS: AuditRow[] = [
  { category: 'identity_link.create.requested', outcome: 'Requested', reason: 'Reason Code Category', actor: 'Actor Redacted', environment: 'DEV', evidence: 'Redacted Evidence' },
  { category: 'identity_link.create.validated', outcome: 'Validated', reason: 'Reason Code Category', actor: 'Actor Redacted', environment: 'DEV', evidence: 'Redacted Evidence' },
  { category: 'identity_link.create.approved', outcome: 'Approved', reason: 'Reason Code Category', actor: 'Actor Redacted', environment: 'DEV', evidence: 'Redacted Evidence' },
  { category: 'database.provision.requested', outcome: 'Requested', reason: 'Reason Code Category', actor: 'Actor Redacted', environment: 'DEV', evidence: 'Redacted Evidence' },
  { category: 'policy.guardrail.evaluated', outcome: 'Pass', reason: 'Reason Code Category', actor: 'Actor Redacted', environment: 'DEV', evidence: 'Redacted Evidence' },
  { category: 'access.grant.requested', outcome: 'Requested', reason: 'Reason Code Category', actor: 'Actor Redacted', environment: 'DEV', evidence: 'Redacted Evidence' },
];

export const POLICIES: PolicyCard[] = [
  { title: 'Production destructive actions blocked', detail: 'No destructive schema or data actions in production from the BCP.', enforced: true },
  { title: 'Raw SQL console disabled', detail: 'No general raw SQL console for any role.', enforced: true },
  { title: 'Identity-link writes DEV-only', detail: 'Create/disable/revoke are DEV-only, approval-required, default OFF.', enforced: true },
  { title: 'Self-service linking deferred', detail: 'Self-service identity linking is deferred and forbidden from the BCP.', enforced: true },
  { title: 'Approval required for database creation', detail: 'Provisioning requires owner approval and separation of duties.', enforced: true },
  { title: 'Audit required for all write actions', detail: 'Every governed write produces immutable, redacted audit evidence.', enforced: true },
  { title: 'Secrets never displayed', detail: 'Only posture is shown; secret values are never rendered.', enforced: true },
  { title: 'Provider identifiers redacted', detail: 'Raw provider references and internal anchors are never shown.', enforced: true },
  { title: 'Runtime wiring blocked until approved', detail: 'Dormant capabilities are not wired into runtime from the BCP.', enforced: true },
];

// Identity-link governance facts (aligned with accepted M20.11 / M20.12 state).
export const IDENTITY_LINK_FACTS: string[] = [
  'DEV identity_link table exists',
  'Table is empty',
  'RLS enabled',
  'Zero client policies',
  'Zero client-role grants',
  'Admin provisioning service is server-only',
  'Admin provisioning service is default OFF',
  'Admin provisioning service is unwired (imported only by its own test)',
  'Repository / audit adapters are planned, not implemented',
  'Production blocked',
  'Self-service linking deferred',
  'Raw provider UID never shown',
  'Raw internal anchor never shown',
  'Email is never identity authority',
  'Client-supplied UID is never authority',
  'Opaque references and redacted evidence only',
];

// Mock lifecycle taxonomy labels (for the read-only identity-link timeline).
export const IDENTITY_LINK_TIMELINE: AuditRow[] = [
  { category: 'identity_link.create.requested', outcome: 'Requested', reason: 'Reason Code Category', actor: 'Actor Redacted', environment: 'DEV', evidence: 'Redacted Evidence' },
  { category: 'identity_link.create.validated', outcome: 'Validated', reason: 'Reason Code Category', actor: 'Actor Redacted', environment: 'DEV', evidence: 'Redacted Evidence' },
  { category: 'identity_link.create.approved', outcome: 'Approved', reason: 'Reason Code Category', actor: 'Actor Redacted', environment: 'DEV', evidence: 'Redacted Evidence' },
  { category: 'identity_link.create.succeeded', outcome: 'Succeeded (mock)', reason: 'Reason Code Category', actor: 'Actor Redacted', environment: 'DEV', evidence: 'Redacted Evidence' },
];

// Owner-granted access scope axes (mock display).
export const SCOPE_AXES: { axis: string; value: string }[] = [
  { axis: 'Environment', value: 'DEV' },
  { axis: 'Tenant', value: 'Tenant Alpha' },
  { axis: 'Store', value: 'Store 001' },
  { axis: 'Module', value: 'Scope Placeholder' },
  { axis: 'Action Type', value: 'Read Only' },
  { axis: 'Duration', value: 'Time-bounded' },
  { axis: 'Approval', value: 'Approval Required' },
];

export const ROLES: GateRoleCard[] = [
  { name: 'Backend Control Plane Owner', scope: 'All modules', access: 'Governed (no self-approval)' },
  { name: 'Platform Administrator', scope: 'Operations + tenancy', access: 'Read-only by default' },
  { name: 'Database Administrator', scope: 'Database + schema', access: 'DEV-first, approval-required' },
  { name: 'Security Administrator', scope: 'Identity + policy + audit', access: 'Governed, stricter' },
  { name: 'Operations Administrator', scope: 'Services + jobs + delivery', access: 'Read-only by default' },
  { name: 'Support Operator', scope: 'Bounded support tools', access: 'Redacted-only' },
  { name: 'Read-Only Auditor', scope: 'All read-only', access: 'View only' },
  { name: 'Approval Reviewer', scope: 'Approval queue', access: 'Approve (not own)' },
  { name: 'Emergency Operator', scope: 'Scoped to emergency', access: 'Bounded, heavily audited' },
  { name: 'Scoped Contributor', scope: 'Granted scope only', access: 'Granted, approved actions only' },
];

export const PERMISSION_MATRIX: PermissionRow[] = [
  { role: 'BCP Owner', read: 'View', request: 'Request', approve: 'Approve (not own)', execute: 'After approval', production: 'Separate approval' },
  { role: 'Platform Admin', read: 'View', request: 'Request', approve: 'Limited', execute: 'DEV after approval', production: 'Read-only' },
  { role: 'Database Admin', read: 'View', request: 'Request', approve: '—', execute: 'DEV after approval (SoD)', production: 'Read-only' },
  { role: 'Security Admin', read: 'View', request: 'Request', approve: 'Approve (not own)', execute: 'DEV after approval', production: 'Governed' },
  { role: 'Read-Only Auditor', read: 'View', request: '—', approve: '—', execute: '—', production: 'Read-only' },
  { role: 'Approval Reviewer', read: 'View (queue)', request: '—', approve: 'Approve (not own)', execute: '—', production: 'Governed' },
];
