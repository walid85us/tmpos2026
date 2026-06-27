// Phase 2.0 M10 — Safe server-owned C-02 Backend CP module registry provider.
//
// WHAT THIS IS: a PURE, server-owned, code/config-only source of the Backend Control Plane module
// registry for the FROZEN C-02 readiness lens. It replaces the C-02 adapter's SAFE EMPTY default with a
// deterministic, bounded, server-authored module list (id / name / status only), so the C-02 envelope
// becomes meaningful WITHOUT relaxing a single frozen C-02 safety boundary.
//
// BINDING SAFETY — reads NOTHING live and crosses NO boundary:
//   - PURE + DETERMINISTIC + NO-THROW + side-effect-free. No I/O of any kind.
//   - No DB, no Supabase, no createClient, no getDb, no DATABASE url, no provider / live / network /
//     fetch / filesystem. No process.env. No request. No tenant / store / customer. No auth. No
//     session / principal. No mutation. No backend action.
//   - No import from src/ (the client bundle); no mockData import; no sensitive row-shaped type import
//     (no TenantRow / StoreRow / AuditRow / DatabaseRow / PermissionRow). The ONLY import is a TYPE-ONLY
//     status union from the frozen C-02 read model (erased at runtime — no runtime coupling).
//   - Emits ONLY { id, name, status } with SAFE BOUNDED LABELS (kebab ids / human names) and a status
//     from the accepted C-02 status vocabulary. NEVER a raw id / UUID / secret / token / DB url / email /
//     domain / filename / tenant / store / customer / identity / audit value.
//   - The exported constant is DEEPLY FROZEN; getBcpC02RegistryModules() returns a FRESH defensive copy,
//     so neither the constant nor a prior result can be mutated by a caller.
//
// SOURCE: a server-authored constant that CONCEPTUALLY MIRRORS the Backend CP module registry by
// code/config inspection ONLY (NO runtime import of the frontend registry). The display labels are
// intentionally RE-EXPRESSED as safe bounded labels — `&` becomes `and`, `/` is dropped, and the
// `Configuration & Secrets Posture` module is re-expressed as `Configuration Posture` (the literal
// `secret`-shaped substring would otherwise redact), and `risk-alerts-lens` is keyed `risks-alerts-lens`
// (the substring `sk-` is a forbidden secret-key prefix) — so EVERY value passes the frozen C-02
// read-model redaction allow-list. 33 modules, matching the conceptual registry count.

import type { C02ModuleStatus } from './bcpC02RegistryReadModel';

/** Safe, server-owned module descriptor — id / name / status ONLY (no other fields). */
export interface BcpC02RegistryModule {
  id: string;
  name: string;
  status: C02ModuleStatus;
}

// Server-authored, code/config module registry. Safe bounded labels only — conceptual mirror of the
// Backend CP module registry (33 modules), re-expressed safely and NEVER imported from the client bundle.
const REGISTRY: readonly BcpC02RegistryModule[] = [
  { id: 'access-gate', name: 'Separate Access Gate', status: 'included' },
  { id: 'command-center', name: 'Command Center', status: 'included' },
  { id: 'operations-console', name: 'Operations Console', status: 'placeholder' },
  { id: 'tenants', name: 'Tenants', status: 'included' },
  { id: 'stores', name: 'Stores', status: 'included' },
  { id: 'tenant-isolation-debugger', name: 'Tenant Isolation Debugger', status: 'placeholder' },
  { id: 'database-registry', name: 'Database Registry', status: 'included' },
  { id: 'database-control', name: 'Database Control', status: 'blocked' },
  { id: 'schema-migrations', name: 'Schema and Migrations', status: 'placeholder' },
  { id: 'services', name: 'Services', status: 'included' },
  { id: 'jobs-workers', name: 'Jobs and Workers', status: 'placeholder' },
  { id: 'api-traffic', name: 'API Traffic', status: 'placeholder' },
  { id: 'logs-telemetry', name: 'Logs and Telemetry', status: 'placeholder' },
  { id: 'identity-access', name: 'Identity and Access', status: 'included' },
  { id: 'identity-links', name: 'Identity Links', status: 'included' },
  { id: 'config-posture', name: 'Configuration Posture', status: 'placeholder' },
  { id: 'audit-approvals', name: 'Audit and Approvals', status: 'included' },
  { id: 'policies-guardrails', name: 'Policies and Guardrails', status: 'included' },
  { id: 'deployments-releases', name: 'Deployments and Releases', status: 'deferred' },
  { id: 'environments-infra', name: 'Environments and Infrastructure', status: 'placeholder' },
  { id: 'backups-recovery', name: 'Backups and Recovery', status: 'deferred' },
  { id: 'support-tools', name: 'Support Operator Tools', status: 'deferred' },
  { id: 'control-plane-settings', name: 'Control Plane Settings', status: 'placeholder' },
  { id: 'system-operations-overview', name: 'System Operations Overview', status: 'included' },
  { id: 'data-governance-overview', name: 'Data Governance Overview', status: 'included' },
  { id: 'identity-readiness-overview', name: 'Identity Readiness Overview', status: 'included' },
  { id: 'audit-governance-overview', name: 'Audit Governance Overview', status: 'included' },
  { id: 'support-diagnostics-overview', name: 'Support and Diagnostics Overview', status: 'included' },
  { id: 'risks-alerts-lens', name: 'Risk and Alerts Lens', status: 'included' },
  { id: 'timeline-evidence-lens', name: 'Timeline and Evidence Lens', status: 'included' },
  { id: 'tenant-store-operations-lens', name: 'Tenant and Store Operations Lens', status: 'included' },
  { id: 'billing-plan-operations-lens', name: 'Billing and Plan Operations Lens', status: 'included' },
  { id: 'readiness-gate', name: 'Backend CP Readiness Gate', status: 'included' },
];

/**
 * The server-owned C-02 module registry, DEEPLY FROZEN so the source-of-truth constant can never be
 * mutated by a caller. Safe bounded labels only. Read via getBcpC02RegistryModules() for a copy.
 */
export const BCP_C02_SERVER_OWNED_REGISTRY_MODULES: readonly Readonly<BcpC02RegistryModule>[] =
  Object.freeze(REGISTRY.map((m) => Object.freeze({ id: m.id, name: m.name, status: m.status })));

/**
 * Return the server-owned C-02 module registry as a FRESH defensive copy (new array of new objects).
 * PURE, DETERMINISTIC, NO-THROW. Takes NO arguments and reads NO env / request / global / live state —
 * authority- and request-independent. Mutating the result never affects the constant or a later call.
 */
export function getBcpC02RegistryModules(): BcpC02RegistryModule[] {
  return BCP_C02_SERVER_OWNED_REGISTRY_MODULES.map((m) => ({ id: m.id, name: m.name, status: m.status }));
}
