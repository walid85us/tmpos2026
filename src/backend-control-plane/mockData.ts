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
  DiagnosticDetail,
  GateRoleCard,
  GovDetail,
  IdentityDetail,
  Kpi,
  OpsJobDetail,
  OpsServiceDetail,
  PermissionRow,
  PolicyCard,
  PostureCard,
  ReadinessCard,
  RunbookItem,
  ServiceCard,
  StoreRow,
  TenantRow,
} from './types';

export const ENVIRONMENTS = ['DEV', 'STAGING', 'PRODUCTION'] as const;

// ---------------------------------------------------------------------------
// 28-module registry (drives the sidebar navigation and screen routing).
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
  // ----- Phase 1.6 M23 — read-only operations expansion (included screens) -----
  {
    id: 'system-operations-overview',
    name: 'System Operations Overview',
    group: 'Operations Expansion',
    state: 'Read-Only First',
    status: 'included',
    purpose: 'Mock-only operational posture: service health, uptime, queues, jobs, and alerts.',
    futureMilestone: 'Aggregated read-only operations telemetry fed by governed read models.',
    blockedActions: ['Restart', 'Scale', 'Pause/Retry/Cancel jobs', 'Any control action'],
    reason: 'Read-only operations command surface with mock-only cards. No live systems.',
  },
  {
    id: 'data-governance-overview',
    name: 'Data Governance Overview',
    group: 'Operations Expansion',
    state: 'Read-Only First',
    status: 'included',
    purpose: 'Mock-only schema health, migration posture, tenant-isolation, and RLS/identity-boundary status.',
    futureMilestone: 'Read-only governance posture fed by a governed registry (no live DB calls).',
    blockedActions: ['Apply migration', 'Provision DB', 'Any mutation', 'Live DB call (never here)'],
    reason: 'Posture metadata only; never connection strings; no live DB calls.',
  },
  {
    id: 'identity-readiness-overview',
    name: 'Identity Readiness Overview',
    group: 'Operations Expansion',
    state: 'Read-Only First',
    status: 'included',
    purpose: 'Read-only readiness for platform_identity, identity_link, session authorization, token bridge, shadow comparison, and the paused M20 stream.',
    futureMilestone: 'Read-only readiness surface; writes/execution remain separately gated.',
    blockedActions: ['Create/disable/revoke link', 'Provision fixture', 'Create registry entry', 'Enable server authority'],
    reason: 'Explicitly shows writes-blocked / execution-blocked and the M20 paused status.',
  },
  {
    id: 'audit-governance-overview',
    name: 'Audit Governance Overview',
    group: 'Operations Expansion',
    state: 'Read-Only First',
    status: 'included',
    purpose: 'Mock-only audit readiness, approval-required indicators, redaction policy, and immutable-audit concept.',
    futureMilestone: 'Read-only audit governance posture (append-only, redacted evidence only).',
    blockedActions: ['Write audit_event', 'Edit/delete evidence (never)', 'Approve/Reject'],
    reason: 'Append-only / redaction-first concept cards; no audit writes.',
  },
  {
    id: 'support-diagnostics-overview',
    name: 'Support & Diagnostics Overview',
    group: 'Operations Expansion',
    state: 'Read-Only First',
    status: 'included',
    purpose: 'Mock-only diagnostics cards and static, non-clickable operational runbook labels.',
    futureMilestone: 'Bounded, audited, redacted-only diagnostics (no live invocation).',
    blockedActions: ['Live diagnostic invocation', 'Route/API call', 'Raw identifier/PII access (never)'],
    reason: 'Static runbook labels and mock diagnostics only; no live diagnostic invocation.',
  },
];

export const NAV_GROUP_ORDER = [
  'Overview',
  'Operations Expansion',
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

// ===========================================================================
// Phase 1.6 M23 — read-only operations expansion mock data.
// Every value is a fictional, redaction-safe label. No live systems, no DB,
// no API, no secrets, no raw identifiers. Nothing here is fetched.
// ===========================================================================

// 1) System Operations Overview ---------------------------------------------
export const OPS_METRICS: Kpi[] = [
  { label: 'Mock Uptime', value: '99.9%', hint: 'Mock posture', tone: 'healthy' },
  { label: 'Queue Depth', value: 'Nominal', hint: 'Mock queue', tone: 'warning' },
  { label: 'Active Jobs', value: '5', hint: 'Mock workers', tone: 'warning' },
  { label: 'Critical Alerts', value: '1', hint: 'Mock alert', tone: 'blocked' },
  { label: 'Error Rate', value: 'Low', hint: 'Mock posture', tone: 'healthy' },
  { label: 'Throughput', value: 'Nominal', hint: 'Mock posture', tone: 'healthy' },
];

export const SYSTEM_POSTURE: PostureCard[] = [
  { title: 'Operational Posture', status: 'Read-Only', detail: 'No control actions available from this console.', tone: 'neutral' },
  { title: 'Active Environment', status: 'DEV', detail: 'Backend Control Plane is DEV-gated.', tone: 'healthy' },
  { title: 'Production', status: 'Locked', detail: 'Production remains blocked by default.', tone: 'blocked' },
  { title: 'Write Path', status: 'Blocked', detail: 'No mutating action, no live API, no DB write.', tone: 'blocked' },
];

// 2) Data Governance Overview -----------------------------------------------
export const DATA_GOVERNANCE: PostureCard[] = [
  { title: 'Schema Health', status: 'Schema v-mock OK', detail: 'Posture only — no live DB calls.', tone: 'healthy' },
  { title: 'Migration Posture', status: 'Up to date (mock)', detail: 'Migration state is observed, never applied here.', tone: 'healthy' },
  { title: 'Tenant Isolation', status: 'Database-per-Tenant', detail: 'Isolation posture (mock) — opaque references only.', tone: 'healthy' },
  { title: 'RLS / Identity Boundary', status: 'RLS Protected', detail: 'Row-level security posture (mock). Boundary enforced.', tone: 'healthy' },
  { title: 'Connection', status: 'Masked', detail: 'Connection strings are never shown.', tone: 'neutral' },
  { title: 'Backups', status: 'Backup Ready (mock)', detail: 'Backup posture only; no restore action here.', tone: 'healthy' },
];

// 3) Identity / Authorization Readiness Overview ----------------------------
export const IDENTITY_READINESS: ReadinessCard[] = [
  { domain: 'platform_identity', status: 'Schema present (mock)', writeState: 'Writes blocked', detail: 'Posture only; no rows shown; opaque references only.', tone: 'healthy' },
  { domain: 'identity_link', status: 'DEV table empty · dormant', writeState: 'Writes blocked', detail: 'Default OFF · unwired · RLS protected.', tone: 'neutral' },
  { domain: 'Session Authorization', status: 'Shadow / read-only', writeState: 'Not authoritative', detail: 'Server-derived authority is not enabled; Firebase remains authoritative.', tone: 'neutral' },
  { domain: 'Token Bridge', status: 'Not invoked', writeState: 'Execution blocked', detail: 'No token bridge invocation from this console.', tone: 'neutral' },
  { domain: 'Shadow Comparison', status: 'Not invoked', writeState: 'Execution blocked', detail: 'No comparison / harness / feed invocation.', tone: 'neutral' },
  { domain: 'M20 Identity-Link Stream', status: 'Paused', writeState: 'Execution blocked', detail: 'M20.24 NOT READY · M20.20 blocked · M20.17C blocked · no Controlled Pair A.', tone: 'warning' },
];

// 4) Audit / Governance Overview --------------------------------------------
export const AUDIT_READINESS: PostureCard[] = [
  { title: 'Audit Readiness', status: 'Append-only concept (mock)', detail: 'Immutable, append-only audit model (mock).', tone: 'healthy' },
  { title: 'Approval Required', status: 'Owner + Reviewer (SoD)', detail: 'Sensitive actions require approval and separation of duties.', tone: 'warning' },
  { title: 'Redaction Policy', status: 'Redaction-First', detail: 'Aggregate / redacted evidence only; no raw values.', tone: 'healthy' },
  { title: 'Immutable Audit', status: 'Append-Only (mock)', detail: 'Evidence is never edited or deleted.', tone: 'healthy' },
  { title: 'Audit Writes', status: 'Blocked', detail: 'No audit_event writes from this read-only console.', tone: 'blocked' },
  { title: 'Evidence Form', status: 'Aggregate / Redacted', detail: 'Counts, booleans, and safe reason codes only.', tone: 'neutral' },
];

// 5) Support / Diagnostics Overview -----------------------------------------
export const DIAGNOSTICS: RunbookItem[] = [
  { label: 'Service Health Runbook', category: 'Operations', note: 'Static label — no live invocation.' },
  { label: 'Database Posture Runbook', category: 'Data', note: 'Static label — no live DB calls.' },
  { label: 'Identity Readiness Runbook', category: 'Identity', note: 'Static label — read-only.' },
  { label: 'Audit Evidence Runbook', category: 'Governance', note: 'Static label — redacted only.' },
  { label: 'Incident Response Runbook', category: 'Support', note: 'Static label — no live diagnostics.' },
  { label: 'Backup / Recovery Runbook', category: 'Data', note: 'Static label — no restore action.' },
];

// ===========================================================================
// Phase 1.6 M24 — read-only / mock-only detail drilldown data.
// Fictional, redaction-safe labels only. No live systems, DB, API, secrets,
// or raw identifiers. Nothing here is fetched or invokable.
// ===========================================================================

// 1) System Operations Detail -----------------------------------------------
export const OPS_SERVICE_DETAIL: OpsServiceDetail[] = [
  { name: 'Auth Service', tone: 'healthy', status: 'Service Healthy', uptime: 'Mock 99.9%', latency: 'Nominal', lastChecked: 'Mock recent' },
  { name: 'POS Service', tone: 'healthy', status: 'Service Healthy', uptime: 'Mock 99.9%', latency: 'Nominal', lastChecked: 'Mock recent' },
  { name: 'Repairs Service', tone: 'healthy', status: 'Service Healthy', uptime: 'Mock 99.8%', latency: 'Nominal', lastChecked: 'Mock recent' },
  { name: 'Inventory Service', tone: 'warning', status: 'Queue Warning', uptime: 'Mock 99.4%', latency: 'Elevated (mock)', lastChecked: 'Mock recent' },
  { name: 'Shipping Service', tone: 'healthy', status: 'Service Healthy', uptime: 'Mock 99.9%', latency: 'Nominal', lastChecked: 'Mock recent' },
  { name: 'Identity Link Service', tone: 'neutral', status: 'Default OFF', uptime: 'Unwired', latency: 'N/A', lastChecked: 'N/A' },
  { name: 'Audit Service', tone: 'healthy', status: 'Service Healthy', uptime: 'Append-only', latency: 'Nominal', lastChecked: 'Mock recent' },
  { name: 'Worker Service', tone: 'warning', status: 'Queue Warning', uptime: 'Mock 99.5%', latency: 'Elevated (mock)', lastChecked: 'Mock recent' },
];

export const OPS_JOB_DETAIL: OpsJobDetail[] = [
  { name: 'Nightly Backup (mock)', type: 'Job', state: 'Scheduled', severity: 'Info', lastEvent: 'Event Redacted' },
  { name: 'Inventory Sync (mock)', type: 'Queue', state: 'Backlogged', severity: 'Warning', lastEvent: 'Event Redacted' },
  { name: 'Report Build (mock)', type: 'Job', state: 'Idle', severity: 'Info', lastEvent: 'Event Redacted' },
  { name: 'Worker Pool (mock)', type: 'Queue', state: 'Degraded', severity: 'Warning', lastEvent: 'Event Redacted' },
  { name: 'Critical Alert (mock)', type: 'Alert', state: 'Open', severity: 'Critical', lastEvent: 'Event Redacted' },
];

export const SYSTEM_POSTURE_NOTES: string[] = [
  'This console is observational only — no run, repair, restart, or scale actions exist here.',
  'Service health, uptime, queue, job, and alert values are mock-only and not from live systems.',
  'No live health check is performed; nothing is fetched.',
  'Production remains locked; the write path is blocked.',
];

// 2) Data Governance Detail --------------------------------------------------
export const DATA_GOVERNANCE_DETAIL: GovDetail[] = [
  { area: 'Schema Posture', posture: 'Schema v-mock', status: 'Healthy (mock)', lastReviewed: 'Mock recent', note: 'Posture only — no DB introspection.' },
  { area: 'Migration Posture', posture: 'Up to date (mock)', status: 'Healthy (mock)', lastReviewed: 'Mock recent', note: 'Observed only — no migration runner.' },
  { area: 'Store Migration', posture: 'Migration Pending (mock)', status: 'Warning (mock)', lastReviewed: 'Mock recent', note: 'Observed only — no apply here.' },
  { area: 'Tenant Isolation', posture: 'Database-per-Tenant', status: 'Healthy (mock)', lastReviewed: 'Mock recent', note: 'Opaque references only.' },
  { area: 'RLS / Identity Boundary', posture: 'RLS Protected', status: 'Healthy (mock)', lastReviewed: 'Mock recent', note: 'Boundary enforced (mock).' },
  { area: 'Connection Posture', posture: 'Masked', status: 'Neutral', lastReviewed: 'Mock recent', note: 'Connection strings never shown.' },
];

// 3) Identity Readiness Detail ----------------------------------------------
export const IDENTITY_DETAIL: IdentityDetail[] = [
  { domain: 'platform_identity', posture: 'Schema present (mock)', writeState: 'Writes blocked', executeState: 'No row exposure', authority: 'App-owned anchor', note: 'Posture only; opaque references; no rows shown.' },
  { domain: 'identity_link', posture: 'DEV table empty · dormant', writeState: 'Writes blocked', executeState: 'No create/disable/revoke', authority: 'Not authoritative', note: 'Default OFF · unwired · RLS protected.' },
  { domain: 'Session Authorization', posture: 'Shadow / read-only', writeState: 'No write', executeState: 'Not enabled', authority: 'Firebase authoritative', note: 'Server-derived authority not enabled.' },
  { domain: 'Token Bridge', posture: 'Not invoked', writeState: 'No write', executeState: 'Execution blocked', authority: 'N/A', note: 'No token bridge invocation.' },
  { domain: 'Shadow Comparison', posture: 'Not invoked', writeState: 'No write', executeState: 'Execution blocked', authority: 'N/A', note: 'No comparison / harness / feed invocation.' },
  { domain: 'M20 Identity-Link Stream', posture: 'Paused (M20.24 NOT READY)', writeState: 'Writes blocked', executeState: 'Execution blocked', authority: 'No Controlled Pair A', note: 'M20.20 blocked · M20.17C blocked · approval signals missing.' },
];

// 4) Audit Governance Detail -------------------------------------------------
export const AUDIT_DETAIL: GovDetail[] = [
  { area: 'Audit Readiness', posture: 'Append-only concept', status: 'Healthy (mock)', lastReviewed: 'Mock recent', note: 'Immutable, append-only model (mock).' },
  { area: 'Approval Posture', posture: 'Owner + Reviewer (SoD)', status: 'Required', lastReviewed: 'Mock recent', note: 'Requester never equals approver.' },
  { area: 'Redaction Policy', posture: 'Redaction-first', status: 'Healthy (mock)', lastReviewed: 'Mock recent', note: 'Aggregate / redacted evidence only.' },
  { area: 'Immutability', posture: 'Append-only', status: 'Healthy (mock)', lastReviewed: 'Mock recent', note: 'Evidence never edited or deleted.' },
  { area: 'Audit Writes', posture: 'Blocked', status: 'Blocked', lastReviewed: 'Mock recent', note: 'No audit_event writes from this console.' },
];

// 5) Support & Diagnostics Detail -------------------------------------------
export const DIAGNOSTIC_DETAIL: DiagnosticDetail[] = [
  { label: 'Service Health Runbook', category: 'Operations', severity: 'Info', owner: 'Operations (mock)', status: 'Read-Only', note: 'Not invokable — static label.' },
  { label: 'Database Posture Runbook', category: 'Data', severity: 'Info', owner: 'Data (mock)', status: 'Read-Only', note: 'Not invokable — no live DB calls.' },
  { label: 'Identity Readiness Runbook', category: 'Identity', severity: 'Warning', owner: 'Security (mock)', status: 'Read-Only', note: 'Not invokable — read-only.' },
  { label: 'Audit Evidence Runbook', category: 'Governance', severity: 'Info', owner: 'Governance (mock)', status: 'Read-Only', note: 'Not invokable — redacted only.' },
  { label: 'Incident Response Runbook', category: 'Support', severity: 'Critical', owner: 'On-call (mock)', status: 'Read-Only', note: 'Not invokable — no live diagnostics.' },
  { label: 'Backup / Recovery Runbook', category: 'Data', severity: 'Warning', owner: 'Data (mock)', status: 'Read-Only', note: 'Not invokable — no restore action.' },
];
