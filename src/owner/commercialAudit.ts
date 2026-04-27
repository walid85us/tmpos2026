// SessionStorage-backed commercial audit log. Mirrors the existing
// `auditLogs` storage pattern used by other System Owner surfaces.
//
// Two stores are written on every action:
//   1. `commercial_audit` — the dedicated commercial governance log
//      surfaced in PlansPage (Add-ons tab footer).
//   2. `audit_logs` (category: 'commercial') — mirrored entry so the
//      cross-cutting Audit / Activity surfaces continue to surface
//      commercial actions without bespoke wiring.
//
// Pure-write helpers; readers fall back to the seed array when the
// session store is empty.

import {
  commercialAuditLogs as seedCommercial,
  type CommercialAuditEntry,
  type CommercialAuditAction,
} from './mockData';

const KEY = 'commercial_audit';
const MIRROR_KEY = 'audit_logs';

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

export function getCommercialAuditLog(): CommercialAuditEntry[] {
  return safeGet<CommercialAuditEntry[]>(KEY, [...seedCommercial]);
}

export interface PushCommercialAuditInput {
  actor: string;
  action: CommercialAuditAction;
  addOnId?: string | null;
  tenantId?: string | null;
  featureId?: string | null;
  oldValue?: string | number | null;
  newValue?: string | number | null;
  note?: string;
}

export function pushCommercialAudit(input: PushCommercialAuditInput): CommercialAuditEntry {
  const entry: CommercialAuditEntry = {
    id: `ca_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    timestamp: new Date().toISOString(),
    actor: input.actor || 'System Owner',
    action: input.action,
    addOnId: input.addOnId ?? null,
    tenantId: input.tenantId ?? null,
    featureId: input.featureId ?? null,
    oldValue: input.oldValue ?? null,
    newValue: input.newValue ?? null,
    note: input.note,
  };

  const log = getCommercialAuditLog();
  const next = [entry, ...log].slice(0, 500);
  safeSet(KEY, next);

  // Mirror into the cross-cutting audit log with category 'commercial'
  // so the existing AuditSecurity surfaces continue to show these.
  // The mirrored row MUST conform to the AuditSecurityPage row contract
  // (`id`, `date`, `actor`, `action`, `target`, `severity`, `category`)
  // so it sorts/filters correctly alongside the seed entries.
  type MirrorEntry = {
    id: string;
    date: string;
    actor: string;
    action: string;
    target: string;
    severity: 'info' | 'warning';
    category: 'commercial';
    tenantId?: string | null;
    addOnId?: string | null;
    featureId?: string | null;
    oldValue?: string | number | null;
    newValue?: string | number | null;
  };
  const mirror = safeGet<MirrorEntry[]>(MIRROR_KEY, []);
  const targetParts: string[] = [];
  if (input.tenantId) targetParts.push(`tenant=${input.tenantId}`);
  if (input.addOnId) targetParts.push(`add-on=${input.addOnId}`);
  if (input.featureId) targetParts.push(`feature=${input.featureId}`);
  if (targetParts.length === 0) targetParts.push('—');
  const isElevated =
    input.action === 'tenant_trial_revoked' ||
    input.action === 'tenant_override_revoked' ||
    input.action === 'tenant_pending_payment_cancelled' ||
    input.action === 'addon_status_changed';
  const mirrorEntry: MirrorEntry = {
    id: entry.id,
    date: entry.timestamp.slice(0, 10),
    actor: entry.actor,
    action: input.action.replace(/_/g, ' '),
    target: targetParts.join(' · '),
    severity: isElevated ? 'warning' : 'info',
    category: 'commercial',
    tenantId: entry.tenantId,
    addOnId: entry.addOnId,
    featureId: entry.featureId,
    oldValue: entry.oldValue,
    newValue: entry.newValue,
  };
  safeSet(MIRROR_KEY, [mirrorEntry, ...mirror].slice(0, 1000));
  try {
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new Event('audit_logs:changed'));
      window.dispatchEvent(new Event('commercial_audit:changed'));
    }
  } catch {
    /* noop */
  }

  return entry;
}
