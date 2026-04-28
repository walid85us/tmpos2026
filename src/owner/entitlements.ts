// System Owner Commercial Controls — Pure entitlement resolver.
//
// Single canonical decision point for "is this feature available to this
// tenant, and why?" Used by the System Owner Tenant Detail Features tab and
// by `AccessContext` to decide whether add-on-driven sub-permissions appear
// in the Store Permissions Matrix.
//
// No React, no sessionStorage, no I/O. All inputs are passed in. The
// `runtime` helpers below adapt the in-memory caller state (sessionStorage
// for the mock environment, future Firestore reads for production) into
// the pure resolver inputs.

import type {
  AddOn,
  TenantFeatureOverride,
  AddOnGovernanceStatus,
  CommercialInvoice,
  CommercialInvoiceStatus,
} from './mockData';

// Distinct, machine-readable reasons for the entitlement decision. Each is
// surfaced verbatim as a UI badge / explainer in the Tenant Detail Features
// tab. Keep names stable — they are persisted in audit entries.
export type EntitlementReason =
  | 'included_by_plan'
  | 'enabled_by_trial_addon'
  | 'enabled_by_paid_addon'
  | 'enabled_by_paid_override'
  | 'pending_payment'
  | 'disabled_by_plan'
  | 'addon_disabled'
  | 'addon_archived'
  | 'trial_expired'
  | 'override_revoked'
  | 'feature_disabled_by_owner'
  | 'not_available';

// Derived state of a single tenant override row. Computed from the row's
// `type`, `trialEnd`, and `revokedDate` plus a caller-provided `nowMs`.
// Used by the resolver and surfaced in the Tenant Features tab badges.
export type TenantOverrideStatus =
  | 'trial_active'
  | 'trial_expired'
  | 'paid_active'
  | 'pending_payment'
  | 'feature_disabled'
  | 'revoked'
  | 'inactive';

export interface EntitlementResult {
  // True iff the feature is currently available to the tenant.
  enabled: boolean;
  // Why — drives UI copy and downstream filtering.
  reason: EntitlementReason;
  // Where the entitlement came from when enabled.
  source: 'plan' | 'trial' | 'paid_override' | 'addon' | 'none';
  // The driving add-on, if any.
  addOn?: AddOn;
  // The driving override row, if any.
  override?: TenantFeatureOverride;
  // Default catalog price for the linked add-on (when present).
  defaultPrice?: number;
  // Tenant-specific override price (when set and different from default).
  customPrice?: number;
  // Trial end date (ISO yyyy-mm-dd) when relevant.
  trialEnd?: string;
  // Linked SaaS invoice (when this row was granted via the internal
  // billing workflow). The UI uses this to (a) show the
  // "Invoice Open / Payment Due" secondary badge on rows that were
  // immediately activated while the invoice is unpaid, and (b) show
  // "View Invoice" / "Mark Paid" / "Cancel Invoice" actions on
  // pending-payment rows.
  invoice?: CommercialInvoice;
  invoiceUiStatus?: CommercialInvoiceStatus;
}

export interface ResolverContext {
  tenantPlan: string;
  // Map of featureId → planAvailability map (e.g. `{ growth: true }`). Use
  // the live `featureMatrix` so System Owner toggles are reflected.
  featureMatrix: Array<{
    id: string;
    planAvailability: Record<string, boolean>;
    lifecycle?: string;
  }>;
  // The full add-on catalog as the System Owner currently sees it.
  addOns: AddOn[];
  // The tenant's current override rows (any status).
  overrides: TenantFeatureOverride[];
  // Reference epoch for trial expiry checks. Tests pin this; runtime
  // callers pass `Date.now()` (or the project's pinned `2026-03-26`).
  nowMs: number;
  // Optional invoice lookup for surfacing internal billing state on
  // override-driven rows. Resolver stays pure — caller wires this to
  // `getInvoiceById` or its Firestore equivalent. Returning `undefined`
  // is fine; the resolver just won't attach invoice metadata.
  lookupInvoice?: (invoiceId: string) => CommercialInvoice | undefined;
  // Optional helper to derive the user-visible invoice status (open vs
  // overdue is a function of `nowMs` vs dueDate). Default behavior:
  // pass through `invoice.status`.
  deriveInvoiceUi?: (
    invoice: CommercialInvoice,
    nowMs: number,
  ) => CommercialInvoiceStatus;
}

const dateToMs = (iso: string | undefined): number | null => {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
};

// Compute the derived status of a single override row. Pure.
export function deriveOverrideStatus(
  override: TenantFeatureOverride,
  nowMs: number,
): TenantOverrideStatus {
  if (override.revokedDate) return 'revoked';
  if (override.type === 'disabled') return 'feature_disabled';
  if (override.type === 'pending_payment') return 'pending_payment';
  if (override.type === 'trial') {
    const endMs = dateToMs(override.trialEnd);
    if (endMs === null) return 'trial_active';
    return endMs >= nowMs ? 'trial_active' : 'trial_expired';
  }
  if (
    override.type === 'paid_override' ||
    override.type === 'overridden' ||
    override.type === 'addon'
  ) {
    return 'paid_active';
  }
  return 'inactive';
}

// Find the add-on that drives a feature, if any. An add-on drives a
// feature when (a) its `linkedFeatureId` matches OR (b) its id matches
// the featureId verbatim (legacy linkage in the seed data).
export function findAddOnForFeature(
  featureId: string,
  addOns: AddOn[],
): AddOn | undefined {
  return (
    addOns.find(a => a.linkedFeatureId === featureId) ||
    addOns.find(a => a.id === featureId)
  );
}

// True iff the add-on is offerable to tenants right now (commercial gate).
export function isAddOnOfferable(addOn: AddOn): boolean {
  return addOn.governanceStatus === 'active';
}

// Filter the add-on catalog to the subset that may be offered to a tenant
// on the given plan. Used by the Tenant Features tab to decide which
// add-ons can be granted as a trial / paid override.
export function listAvailableAddOnsForTenant(
  addOns: AddOn[],
  tenantPlan: string,
): AddOn[] {
  return addOns.filter(
    a => isAddOnOfferable(a) && a.compatiblePlans.includes(tenantPlan),
  );
}

// Single canonical resolver. Decides whether `featureId` is available to
// the tenant, why, and where the entitlement came from.
//
// Decision order (deterministic):
//   1. If an explicit `disabled` override exists for this feature → owner
//      disabled it; return `feature_disabled_by_owner`.
//   2. If a non-revoked, non-expired override grants this feature →
//      check the linked add-on's governance state. If the catalog says
//      the add-on is `disabled` or `archived`, the historical override
//      *cannot* keep enabling the feature; return the corresponding
//      catalog reason (`addon_disabled` / `addon_archived`). Otherwise
//      enable with the appropriate trial/paid reason.
//   3. If the tenant's plan includes the feature → `included_by_plan`.
//   4. Otherwise `not_available` (with `disabled_by_plan` when the
//      feature exists in `featureMatrix` but the plan column is false).
export function resolveTenantFeature(
  featureId: string,
  ctx: ResolverContext,
): EntitlementResult {
  const { tenantPlan, featureMatrix, addOns, overrides, nowMs, lookupInvoice, deriveInvoiceUi } = ctx;
  const planKey = tenantPlan === 'starter' ? 'essential' : tenantPlan;

  const override = overrides.find(o => o.featureId === featureId);
  const addOn = findAddOnForFeature(featureId, addOns);
  const overrideStatus = override
    ? deriveOverrideStatus(override, nowMs)
    : 'inactive';

  // Resolve linked invoice (if any) once up front. The same payload
  // is attached to every result branch that comes from an override.
  const invoice =
    override && override.invoiceId && lookupInvoice
      ? lookupInvoice(override.invoiceId)
      : undefined;
  const invoiceUiStatus = invoice
    ? (deriveInvoiceUi ? deriveInvoiceUi(invoice, nowMs) : invoice.status)
    : undefined;

  // (1) Owner-disabled override. Only meaningful when the feature would
  // otherwise be entitled (i.e. the plan includes it). If the feature
  // is not in the plan to begin with, the disabled flag is dormant —
  // surfacing "Disabled by Owner" would mislead the operator into
  // thinking there is a re-enable that matters. In that case fall
  // through and let the plan/lifecycle resolution below produce the
  // truthful state (Not in Plan / Not Available).
  if (override && override.type === 'disabled') {
    const featureInMatrix = featureMatrix.find(f => f.id === featureId);
    const planIncludesFeature = !!(featureInMatrix && featureInMatrix.planAvailability[planKey]);
    if (planIncludesFeature) {
      return {
        enabled: false,
        reason: 'feature_disabled_by_owner',
        source: 'none',
        override,
      };
    }
    // Plan does not include this feature; skip the disabled branch and
    // let the standard plan/availability resolution take over.
  }

  // (2) Active override → respect catalog governance gate.
  if (override && !override.revokedDate) {
    if (overrideStatus === 'trial_active') {
      if (addOn && addOn.governanceStatus === 'archived') {
        return {
          enabled: false,
          reason: 'addon_archived',
          source: 'none',
          addOn,
          override,
          trialEnd: override.trialEnd,
        };
      }
      if (addOn && addOn.governanceStatus === 'disabled') {
        return {
          enabled: false,
          reason: 'addon_disabled',
          source: 'none',
          addOn,
          override,
          trialEnd: override.trialEnd,
        };
      }
      return {
        enabled: true,
        reason: 'enabled_by_trial_addon',
        source: 'trial',
        addOn,
        override,
        trialEnd: override.trialEnd,
        defaultPrice: addOn?.price,
      };
    }
    if (overrideStatus === 'trial_expired') {
      return {
        enabled: false,
        reason: 'trial_expired',
        source: 'none',
        addOn,
        override,
        trialEnd: override.trialEnd,
      };
    }
    if (overrideStatus === 'paid_active') {
      if (addOn && addOn.governanceStatus === 'archived') {
        return {
          enabled: false,
          reason: 'addon_archived',
          source: 'none',
          addOn,
          override,
        };
      }
      if (addOn && addOn.governanceStatus === 'disabled') {
        return {
          enabled: false,
          reason: 'addon_disabled',
          source: 'none',
          addOn,
          override,
        };
      }
      const customPrice =
        typeof override.price === 'number' &&
        addOn &&
        override.price !== addOn.price
          ? override.price
          : undefined;
      const isAddOnRow = override.type === 'addon';
      return {
        enabled: true,
        reason: isAddOnRow ? 'enabled_by_paid_addon' : 'enabled_by_paid_override',
        source: isAddOnRow ? 'addon' : 'paid_override',
        addOn,
        override,
        defaultPrice: addOn?.price,
        customPrice,
        invoice,
        invoiceUiStatus,
      };
    }
    if (overrideStatus === 'pending_payment') {
      return {
        enabled: false,
        reason: 'pending_payment',
        source: 'none',
        addOn,
        override,
        defaultPrice: addOn?.price,
        customPrice:
          typeof override.price === 'number' &&
          addOn &&
          override.price !== addOn.price
            ? override.price
            : undefined,
        invoice,
        invoiceUiStatus,
      };
    }
  }

  // Revoked override → kept for history but does not enable.
  if (override && override.revokedDate) {
    return {
      enabled: false,
      reason: 'override_revoked',
      source: 'none',
      addOn,
      override,
    };
  }

  // (3) Plan inclusion.
  const featureRow = featureMatrix.find(f => f.id === featureId);
  if (featureRow) {
    const inPlan = !!featureRow.planAvailability[planKey];
    if (inPlan) {
      return {
        enabled: true,
        reason: 'included_by_plan',
        source: 'plan',
        addOn,
      };
    }
    // Feature exists but plan excludes it. The "Add-on Available" hint
    // and modal price pre-fill are handled by the UI based on the
    // resolver's `addOn` payload + governanceStatus. The reason itself
    // is always `disabled_by_plan` so the tenant Features tab can offer
    // a tenant-level Trial / Paid Override (which is independent of
    // catalog availability — paid overrides do not require a linked
    // active add-on; the linked add-on only contributes a default
    // price and an "Add-on Available" badge when present + active).
    return {
      enabled: false,
      reason: 'disabled_by_plan',
      source: 'none',
      addOn,
      defaultPrice: addOn?.price,
    };
  }

  // (4) Unknown feature.
  return { enabled: false, reason: 'not_available', source: 'none' };
}

// Helper for `AccessContext`: given the running tenant's plan and override
// state, decide whether the linked feature is currently entitled. Returns
// `true` for the plan-baseline path AND for active trial / paid overrides
// whose catalog entry is still `active`.
export function isFeatureEntitledForTenant(
  featureId: string,
  ctx: ResolverContext,
): boolean {
  return resolveTenantFeature(featureId, ctx).enabled;
}

// Audit / labelling helpers shared by the UI surfaces.

export const REASON_LABEL: Record<EntitlementReason, string> = {
  included_by_plan: 'Included by plan',
  enabled_by_trial_addon: 'Trial',
  enabled_by_paid_addon: 'Add-on',
  enabled_by_paid_override: 'Paid override',
  pending_payment: 'Pending payment',
  disabled_by_plan: 'Not in plan',
  addon_disabled: 'Add-on disabled',
  addon_archived: 'Add-on archived',
  trial_expired: 'Trial expired',
  override_revoked: 'Revoked',
  feature_disabled_by_owner: 'Disabled by owner',
  not_available: 'Not available',
};

export const REASON_EXPLAINER: Record<EntitlementReason, string> = {
  included_by_plan: 'This feature is included by the tenant\u2019s active plan.',
  enabled_by_trial_addon:
    'Active trial granted by an add-on override. Reverts when the trial ends unless converted.',
  enabled_by_paid_addon:
    'Active paid add-on. Linked to the catalog entry; tenant can be billed at the catalog price.',
  enabled_by_paid_override:
    'Active paid override. Tenant-specific entitlement separate from add-on billing.',
  pending_payment:
    'Override created but waiting for payment confirmation; the feature is not yet enabled.',
  disabled_by_plan:
    'This feature is not in the tenant\u2019s plan. Grant a trial or paid override to enable.',
  addon_disabled:
    'The linked add-on is currently disabled in the catalog; existing tenant overrides are inactive until the add-on is reactivated.',
  addon_archived:
    'The linked add-on has been archived; the override stays in history but no longer enables the feature.',
  trial_expired: 'The trial period has ended. Convert to paid override or grant a new trial.',
  override_revoked: 'This override was revoked and is kept only as historical evidence.',
  feature_disabled_by_owner:
    'The System Owner explicitly disabled this feature for this tenant.',
  not_available: 'No catalog entry available for this feature.',
};
