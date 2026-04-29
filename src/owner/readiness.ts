// Add-on Implementation Readiness helpers.
//
// This module is the single source of truth for:
//   - deriving a *suggested* readiness status from add-on metadata +
//     KNOWN_CAPABILITY_REGISTRY,
//   - computing tenant grant safety (can a System Owner offer Trial /
//     Paid Override for this add-on right now?),
//   - generating a copyable Implementation Brief for non-runtime-backed
//     add-ons that the System Owner can paste into a follow-up build
//     prompt.
//
// The functions here are pure — they take an AddOn (and optionally a
// linked feature row) and return derived data. They never mutate state
// or push audit. Callers in PlansPage.tsx / TenantDetailPage.tsx are
// responsible for the audit trail when readiness fields change.
//
// Out of scope (per spec):
//   - generating real app functionality
//   - calling external AI services
//   - touching Stripe / external billing / Shipping module behavior
//
// See replit.md → "Add-on Implementation Readiness".

import type {
  AddOn,
  AddOnReadinessStatus,
  RuntimeChecklist,
  RuntimeChecklistKey,
} from './mockData';
import {
  DEFAULT_RUNTIME_CHECKLIST,
  KNOWN_CAPABILITY_REGISTRY,
  RUNTIME_CHECKLIST_LABELS,
  isKnownImplementedCapability,
  isParentFeatureCapability,
} from './mockData';

export const READINESS_LABELS: Record<AddOnReadinessStatus, string> = {
  runtime_backed: 'Runtime-backed',
  partially_backed: 'Partially Runtime-backed',
  parent_feature_linked: 'Parent Feature Linked',
  implementation_required: 'Implementation Required',
  commercial_placeholder: 'Commercial Placeholder',
};

export const READINESS_DESCRIPTIONS: Record<AddOnReadinessStatus, string> = {
  runtime_backed: 'Linked to implemented capability with full runtime backing. Safe to offer as Trial / Paid Override.',
  partially_backed: 'Capability exists but one or more runtime backing items are missing. Tenant grant shows a warning.',
  parent_feature_linked: 'Linked to a broad parent module — granting may unlock more than intended.',
  implementation_required: 'Catalog placeholder. Real app functionality must be built before tenant grant.',
  commercial_placeholder: 'Roadmap / pre-sale listing only. Not tenant-grantable unless manual/presale is explicitly allowed.',
};

export const READINESS_BADGE_STYLES: Record<AddOnReadinessStatus, string> = {
  runtime_backed: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  partially_backed: 'bg-amber-50 text-amber-700 border-amber-200',
  parent_feature_linked: 'bg-orange-50 text-orange-700 border-orange-200',
  implementation_required: 'bg-rose-50 text-rose-700 border-rose-200',
  commercial_placeholder: 'bg-slate-100 text-slate-600 border-slate-300',
};

export const getReadinessStatus = (addon: AddOn): AddOnReadinessStatus => {
  return addon.readinessStatus || deriveSuggestedReadiness(addon);
};

export const getRuntimeChecklist = (addon: AddOn): RuntimeChecklist => {
  return addon.runtimeChecklist || { ...DEFAULT_RUNTIME_CHECKLIST };
};

// Derive a *suggestion* for readiness status based on metadata. Used
// when the add-on has no explicitly set readinessStatus, and as the
// "Suggested" hint in the Add-on Create/Edit modal. Does not auto-promote
// any add-on to runtime_backed without checklist evidence — completion
// must be explicit.
export const deriveSuggestedReadiness = (addon: AddOn): AddOnReadinessStatus => {
  const linked = addon.linkedFeatureId || null;
  const checklist = getRuntimeChecklist(addon);

  if (!linked) {
    // Standalone add-on with no linked existing capability — placeholder
    // by default. Promotion to implementation_required signals "this is
    // intentional and needs build work".
    return 'commercial_placeholder';
  }

  if (isParentFeatureCapability(linked) && !addon.parentLinkAcknowledged) {
    return 'parent_feature_linked';
  }

  if (isKnownImplementedCapability(linked)) {
    if (isChecklistFullyComplete(checklist)) return 'runtime_backed';
    if (hasAnyMissingChecklistItem(checklist)) return 'partially_backed';
    // Linked to known capability but checklist is mostly unknown —
    // safer to flag partial than overclaim runtime backing.
    return 'partially_backed';
  }

  // Linked to a feature row that isn't in the known registry → real
  // implementation status is uncertain.
  if (hasAnyMissingChecklistItem(checklist)) return 'implementation_required';
  return 'implementation_required';
};

const isChecklistFullyComplete = (cl: RuntimeChecklist): boolean => {
  return (Object.keys(cl) as RuntimeChecklistKey[]).every(k => {
    const v = cl[k];
    return v === 'complete' || v === 'not_required';
  });
};

const hasAnyMissingChecklistItem = (cl: RuntimeChecklist): boolean => {
  return (Object.keys(cl) as RuntimeChecklistKey[]).some(k => cl[k] === 'missing');
};

export const getMissingOrUnknownChecklistItems = (cl: RuntimeChecklist): RuntimeChecklistKey[] => {
  return (Object.keys(cl) as RuntimeChecklistKey[]).filter(k => cl[k] === 'missing' || cl[k] === 'unknown');
};

// Tenant Grant Safety — drives Trial / Paid Override button state on
// the Tenant Features tab. The rule per the readiness spec is:
//   runtime_backed         → allowed, no warning
//   partially_backed       → allowed, with warning
//   parent_feature_linked  → allowed, with warning
//   implementation_required → BLOCKED unless allowManualPresaleGrant
//   commercial_placeholder → BLOCKED unless allowManualPresaleGrant
// The check is *additive* to existing eligibility (governance status
// must already be 'active', plan must be compatible, etc). Callers
// must continue to apply those checks before consulting grant safety.
export interface AddOnGrantSafety {
  allowed: boolean;
  requiresWarning: boolean;
  warningText: string;
  blockReason: string | null;
  shortBadge: string | null;
}

export const getAddOnGrantSafety = (addon: AddOn): AddOnGrantSafety => {
  const status = getReadinessStatus(addon);
  switch (status) {
    case 'runtime_backed':
      return { allowed: true, requiresWarning: false, warningText: '', blockReason: null, shortBadge: null };
    case 'partially_backed':
      return {
        allowed: true,
        requiresWarning: true,
        warningText: 'This add-on may not be fully connected to runtime behavior.',
        blockReason: null,
        shortBadge: 'Runtime Not Connected',
      };
    case 'parent_feature_linked':
      return {
        allowed: true,
        requiresWarning: true,
        warningText: 'This add-on may unlock a broad module. Consider linking a specific sub-feature.',
        blockReason: null,
        shortBadge: 'Parent Feature Warning',
      };
    case 'implementation_required':
      if (addon.allowManualPresaleGrant) {
        return {
          allowed: true,
          requiresWarning: true,
          warningText: 'Implementation Required — manual/presale grant explicitly allowed by System Owner.',
          blockReason: null,
          shortBadge: 'Manual / Presale',
        };
      }
      return {
        allowed: false,
        requiresWarning: false,
        warningText: '',
        blockReason: 'Implementation required before tenant grant.',
        shortBadge: 'Implementation Required',
      };
    case 'commercial_placeholder':
      if (addon.allowManualPresaleGrant) {
        return {
          allowed: true,
          requiresWarning: true,
          warningText: 'Commercial Placeholder — manual/presale grant explicitly allowed by System Owner.',
          blockReason: null,
          shortBadge: 'Manual / Presale',
        };
      }
      return {
        allowed: false,
        requiresWarning: false,
        warningText: '',
        blockReason: 'Commercial placeholder — not tenant-grantable.',
        shortBadge: 'Placeholder',
      };
  }
};

// Implementation Brief Generator — copyable structured text the System
// Owner can paste back into a build-prompt to kick off the missing
// implementation work. Pure function; reads metadata only.
export const generateImplementationBrief = (
  addon: AddOn,
  linkedFeatureName: string | null,
): string => {
  const status = getReadinessStatus(addon);
  const checklist = getRuntimeChecklist(addon);
  const missingItems = getMissingOrUnknownChecklistItems(checklist);
  const registryEntry = addon.linkedFeatureId
    ? KNOWN_CAPABILITY_REGISTRY.find(e => e.featureId === addon.linkedFeatureId)
    : undefined;

  const lines: string[] = [];
  lines.push(`# Add-on Implementation Brief — ${addon.name}`);
  lines.push('');
  lines.push(`## Add-on Identity`);
  lines.push(`- Add-on ID: ${addon.id}`);
  lines.push(`- Name: ${addon.name}`);
  lines.push(`- Description: ${addon.description || '(none)'}`);
  lines.push(`- Price / Cadence: $${addon.price} / ${addon.billingCadence}`);
  lines.push(`- Governance Status: ${addon.governanceStatus}`);
  lines.push(`- PM Lifecycle: ${addon.lifecycle}`);
  lines.push(`- Readiness Status: ${READINESS_LABELS[status]}`);
  lines.push('');
  lines.push(`## Linked Capability`);
  lines.push(`- Linked Feature ID: ${addon.linkedFeatureId || '(standalone — generated cap row)'}`);
  if (linkedFeatureName) lines.push(`- Linked Feature Name: ${linkedFeatureName}`);
  if (registryEntry) {
    lines.push(`- Registry Entry: parent module=${registryEntry.parentModule}, isParentFeature=${registryEntry.isParentFeature ? 'yes' : 'no'}, runtimeSurfaceExists=${registryEntry.runtimeSurfaceExists}, planMatrixRowExists=${registryEntry.planMatrixRowExists}`);
    if (registryEntry.notes) lines.push(`- Registry Notes: ${registryEntry.notes}`);
  } else if (addon.linkedFeatureId) {
    lines.push(`- Registry Entry: not in KNOWN_CAPABILITY_REGISTRY — verify implementation status before promoting readiness.`);
  }
  lines.push('');
  lines.push(`## Intended Tenant / User`);
  lines.push(`- Tenant role: (specify which Store roles need this — Store Owner, Manager, Cashier, Tech, etc.)`);
  lines.push(`- Plan eligibility: ${addon.compatiblePlans.length > 0 ? addon.compatiblePlans.join(', ') : '(none configured — link the smallest specific capability and choose plans)'}`);
  lines.push('');
  lines.push(`## Business Goal`);
  lines.push(`- (Restate the tenant outcome this add-on enables in 1-2 sentences.)`);
  lines.push('');
  lines.push(`## Current Readiness`);
  lines.push(`- Status: ${READINESS_LABELS[status]}`);
  lines.push(`- ${READINESS_DESCRIPTIONS[status]}`);
  lines.push('');
  lines.push(`## Runtime Backing Checklist`);
  (Object.keys(checklist) as RuntimeChecklistKey[]).forEach(k => {
    lines.push(`- ${RUNTIME_CHECKLIST_LABELS[k]}: ${checklist[k]}`);
  });
  if (missingItems.length > 0) {
    lines.push('');
    lines.push(`## Missing or Unknown Items (work to do)`);
    missingItems.forEach(k => {
      lines.push(`- ${RUNTIME_CHECKLIST_LABELS[k]} (${checklist[k]})`);
    });
  }
  lines.push('');
  lines.push(`## Proposed UI Surfaces`);
  lines.push(`- ${addon.runtimeSurface || '(specify the route / tab / page where this capability becomes visible to a tenant)'}`);
  lines.push('');
  lines.push(`## Required Data Model`);
  lines.push(`- (Firestore collections / local state shape this add-on needs. Include indexes if any.)`);
  lines.push('');
  lines.push(`## Required Permissions`);
  if (registryEntry?.permissionIds.length) {
    lines.push(`- Existing registry permissions: ${registryEntry.permissionIds.join(', ')}`);
  } else {
    lines.push(`- (List Store Permissions Matrix permission ids needed; verify with the Permissions tab.)`);
  }
  lines.push('');
  lines.push(`## Required Plan / Entitlement Gating`);
  lines.push(`- Plans & Features Matrix row: ${addon.linkedFeatureId || `cap_${addon.id}`}`);
  lines.push(`- Compatible Plans: ${addon.compatiblePlans.length > 0 ? addon.compatiblePlans.join(', ') : '(none configured)'}`);
  lines.push(`- Resolver: confirm \`resolveTenantFeature\` returns enabled when the override / plan path includes this capability.`);
  lines.push('');
  lines.push(`## Required Tenant Visibility Behavior`);
  lines.push(`- Tenant Features tab: ensure the row appears for active+compatible add-on, and is hidden when add-on is disabled/archived or plan is incompatible.`);
  lines.push(`- Store Permissions Matrix: surface the permission only when the tenant has the entitlement.`);
  lines.push('');
  lines.push(`## Required Billing Behavior`);
  lines.push(`- Internal SaaS invoice on Paid Override grant (existing flow). No external Stripe / customer storefront billing.`);
  lines.push('');
  lines.push(`## Required Audit Behavior`);
  lines.push(`- Capture create/update/delete of any new domain entities through the platform audit log.`);
  lines.push('');
  lines.push(`## Manual QA Checklist`);
  lines.push(`- [ ] System Owner sees Runtime-backed badge after build.`);
  lines.push(`- [ ] Tenant on a compatible plan sees the capability after Trial / Paid Override grant.`);
  lines.push(`- [ ] Tenant on an incompatible plan does not see the capability.`);
  lines.push(`- [ ] Disabling / archiving the add-on hides tenant access (no orphaned UI).`);
  lines.push(`- [ ] Permissions guard the role-level actions inside the new surface.`);
  lines.push(`- [ ] Audit log captures grant / revoke / use of the new capability.`);
  lines.push('');
  lines.push(`## Replit Implementation Prompt Starter`);
  lines.push('');
  lines.push('```');
  lines.push(`Implement runtime functionality for add-on "${addon.name}" (id: ${addon.id}).`);
  lines.push(`The add-on is linked to capability "${addon.linkedFeatureId || `cap_${addon.id}`}" in the Plans & Features Matrix.`);
  lines.push(`Build the runtime UI surface, entitlement check, permission dependency, data model, and audit hooks listed in this brief.`);
  lines.push(`Do NOT touch Stripe, customer storefront billing, or the Shipping Module. Preserve existing source-of-truth, archive/delete, and resolver behavior.`);
  lines.push(`Verify the Manual QA Checklist passes before marking the add-on Runtime-backed.`);
  lines.push('```');
  lines.push('');
  return lines.join('\n');
};
