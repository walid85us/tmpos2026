import type {
  AutomationRule,
  AutomationCondition,
  AutomationAction,
  AutomationActionType,
  AutomationTriggerType,
  AutomationRuleProcessType,
  AutomationLogEntry,
  AutomationConditionField,
  AutomationConditionOp,
  AutomationFieldKind,
  AutomationTriggerContext,
  RulePurpose,
  Shipment,
  ShipmentInternalNote,
  SlaStatus,
  SlaTargetType,
} from '../types';

// Phase 3 Pass #16 — SLA Automation Linkage. Whitelist of observational SLA
// triggers. Kept as a stable constant so the dispatcher (ShippingCenter SLA
// transition useEffect), the rule builder filter, and engine gating all
// reference one definition rather than drifting copies.
export const SLA_TRIGGERS: AutomationTriggerType[] = [
  'sla_at_risk', 'sla_overdue', 'sla_missed',
  'sla_paused', 'sla_resumed', 'sla_delay_reason_added',
];

export function isSlaTrigger(trigger: AutomationTriggerType): boolean {
  return SLA_TRIGGERS.includes(trigger);
}

// Phase 3 correction #3 — process-type registry. Defines which triggers and
// actions are valid under each process type (observational vs guardrail) so
// the rule builder and engine cannot drift apart.
export function getRuleProcessType(rule: Pick<AutomationRule, 'ruleType'>): AutomationRuleProcessType {
  return rule.ruleType === 'guardrail' ? 'guardrail' : 'observational';
}

export const OBSERVATIONAL_TRIGGERS: AutomationTriggerType[] = [
  'shipment_created', 'shipment_updated', 'status_changed', 'label_purchased',
  'pickup_requested', 'pickup_confirmed', 'pickup_cancelled', 'tracking_synced',
  'return_shipment_created',
  // Phase 3 Pass #10 — observational packing-workflow events. Fire AFTER
  // the corresponding packing action; never gate the underlying action.
  'packing_started', 'packing_completed', 'packing_exception_created',
  // Phase 3 Pass #16 — SLA Automation Linkage. Strictly observational; the
  // SLA-transition detector fires these after a transition is observed.
  // They never gate the underlying action and the engine refuses to apply
  // any guardrail action even if a malformed rule somehow lands here.
  ...SLA_TRIGGERS,
];

export const GUARDRAIL_TRIGGERS: AutomationTriggerType[] = [
  'pre_label_purchase',
  // Phase 3 matrix refinement — additional pre-action guardrail triggers
  // wired to the real handlers in ShippingCenter (handleRequestPickup,
  // handleStatusTransition→Dispatched, purchaseLabelForBatch). Kept as a
  // single canonical list so the rule builder, engine, and event-only
  // backfill registry all see the same set.
  'pre_pickup_request',
  'pre_shipment_dispatch',
  'pre_batch_label_purchase',
];

// Phase 3 matrix refinement — single source of truth for "this trigger
// fires BEFORE the action runs and can halt it". Used by the matrix,
// effectiveProcessType, primaryActionFor, evaluateGuardrails, and the
// AutomationRules helper-text gating so all surfaces stay in lockstep.
export const PRE_ACTION_TRIGGERS: AutomationTriggerType[] = [
  'pre_label_purchase',
  'pre_pickup_request',
  'pre_shipment_dispatch',
  'pre_batch_label_purchase',
];

export function isPreActionTrigger(t: AutomationTriggerType): boolean {
  return PRE_ACTION_TRIGGERS.includes(t);
}

export const OBSERVATIONAL_ACTIONS: AutomationActionType[] = [
  'add_flag', 'add_internal_note', 'mark_review_needed',
  'mark_ready_for_batch', 'set_priority',
];

export const GUARDRAIL_ACTIONS: AutomationActionType[] = [
  'require_approval', 'block_unless_approved', 'require_review_before_action',
];

export function triggersForProcessType(t: AutomationRuleProcessType): AutomationTriggerType[] {
  return t === 'guardrail' ? GUARDRAIL_TRIGGERS : OBSERVATIONAL_TRIGGERS;
}

export function actionsForProcessType(t: AutomationRuleProcessType): AutomationActionType[] {
  return t === 'guardrail' ? GUARDRAIL_ACTIONS : OBSERVATIONAL_ACTIONS;
}

// Phase 3 correction #4 — purpose-driven model. The operator picks a business
// purpose first; the engine derives the internal process type and filters
// triggers, conditions, and actions to logical combinations.

export const PURPOSE_LABELS: Record<RulePurpose, string> = {
  flag_note: 'Flag / Note',
  queue_batch: 'Queue for Batch',
  require_review: 'Require Review',
  require_approval: 'Require Approval',
  block_action: 'Block Action',
};

export const PURPOSE_DESCRIPTIONS: Record<RulePurpose, string> = {
  flag_note: 'After an event happens, flag a shipment, add an internal note, or set a priority. Does not pause any operator action.',
  queue_batch: 'Mark eligible shipments as candidates for the Batch Labels workflow.',
  require_review: 'Require an operator to review the shipment. After an event for observational triggers; before the action for pre-action triggers (label purchase, pickup request, dispatch, batch label purchase).',
  require_approval: 'Pause a risky action and require an authorized approver before it proceeds.',
  block_action: 'Halt a risky action until conditions change or an authorized override is applied.',
};

export function purposeToProcessType(purpose: RulePurpose): AutomationRuleProcessType {
  switch (purpose) {
    case 'require_approval':
    case 'block_action':
      return 'guardrail';
    case 'require_review':
      // 'require_review' becomes guardrail only on pre-action triggers; for
      // observational triggers it remains observational. Decided by the
      // (purpose + trigger) combination at builder time, not here.
      return 'observational';
    case 'flag_note':
    case 'queue_batch':
    default:
      return 'observational';
  }
}

// Trigger compatibility per the Pass #4 spec matrix.
export const PURPOSE_TRIGGER_MATRIX: Record<RulePurpose, AutomationTriggerType[]> = {
  flag_note: [
    'shipment_created', 'shipment_updated', 'status_changed', 'label_purchased',
    'pickup_requested', 'pickup_confirmed', 'pickup_cancelled', 'tracking_synced',
    'return_shipment_created',
    // Phase 3 Pass #10 — packing events support flag/note for visibility.
    'packing_started', 'packing_completed', 'packing_exception_created',
    // Phase 3 Pass #16 — SLA observational triggers. Useful for adding a flag
    // (e.g. 'sla_at_risk_dispatch'), an internal note, or setting priority
    // when an SLA boundary is crossed or an operator pauses/resumes/explains.
    ...SLA_TRIGGERS,
  ],
  queue_batch: [
    'shipment_created', 'shipment_updated', 'status_changed', 'return_shipment_created',
    // Phase 3 matrix refinement — packing_completed routes finished
    // shipments straight into the Batch Labels queue once verification
    // passes. Stays observational (post-event); no guardrail semantics.
    'packing_completed',
    // Phase 3 Pass #16 — let an at-risk/overdue dispatch SLA route the
    // shipment into the Batch Labels queue for accelerated handling.
    'sla_at_risk', 'sla_overdue',
  ],
  require_review: [
    'shipment_created', 'shipment_updated', 'status_changed', 'label_purchased',
    'pickup_requested', 'pickup_confirmed', 'pickup_cancelled', 'tracking_synced',
    'return_shipment_created',
    // Phase 3 matrix refinement — every pre-action trigger supports
    // require_review (becomes a guardrail review on these triggers via
    // effectiveProcessType so it can actually halt the action).
    ...PRE_ACTION_TRIGGERS,
    // Phase 3 Pass #10 — packing events can also raise a review (e.g. require
    // a manager review when an exception is created). Cannot be a guardrail
    // on these triggers because they are observational (the event has
    // already happened).
    'packing_started', 'packing_completed', 'packing_exception_created',
    // Phase 3 Pass #16 — SLA crossings are useful "ask a human to look"
    // triggers. Always observational; can never be a guardrail because the
    // SLA transition has already been observed by the time we dispatch.
    ...SLA_TRIGGERS,
  ],
  // Phase 3 Pass #16 + matrix refinement — SLA triggers are STRICTLY
  // observational and never valid for guardrail purposes. require_approval
  // and block_action are limited to the pre-action trigger set because
  // each one is wired to a real engine handler that can be halted before
  // the underlying action commits. The safe-action whitelist is enforced
  // by the matrix here, not just by runtime checks.
  require_approval: [...PRE_ACTION_TRIGGERS],
  block_action: [...PRE_ACTION_TRIGGERS],
};

export function purposesForTrigger(trigger: AutomationTriggerType): RulePurpose[] {
  const out: RulePurpose[] = [];
  (Object.keys(PURPOSE_TRIGGER_MATRIX) as RulePurpose[]).forEach(p => {
    if (PURPOSE_TRIGGER_MATRIX[p].includes(trigger)) out.push(p);
  });
  return out;
}

export function triggersForPurpose(purpose: RulePurpose): AutomationTriggerType[] {
  return PURPOSE_TRIGGER_MATRIX[purpose];
}

// Resolve the effective process type for a given (purpose, trigger).
// 'require_review' on pre_label_purchase becomes a guardrail review so it can
// gate the action; on any other trigger it stays observational.
export function effectiveProcessType(purpose: RulePurpose, trigger: AutomationTriggerType): AutomationRuleProcessType {
  // Phase 3 matrix refinement — require_review on ANY pre-action trigger
  // (label purchase, pickup request, dispatch, batch label purchase)
  // becomes a guardrail review so it can actually halt the action.
  if (purpose === 'require_review' && PRE_ACTION_TRIGGERS.includes(trigger)) return 'guardrail';
  return purposeToProcessType(purpose);
}

// Implicit primary action per purpose + (sometimes) trigger. The builder
// renders this as a fixed chip; supplementary actions can be added for
// purposes that allow them.
export function primaryActionFor(purpose: RulePurpose, trigger: AutomationTriggerType): AutomationActionType | null {
  switch (purpose) {
    case 'queue_batch': return 'mark_ready_for_batch';
    case 'require_review':
      // Phase 3 matrix refinement — every pre-action trigger gets the
      // gating require_review_before_action so the modal halts the
      // action; observational triggers stay on the post-event
      // mark_review_needed flag.
      return PRE_ACTION_TRIGGERS.includes(trigger) ? 'require_review_before_action' : 'mark_review_needed';
    case 'require_approval': return 'require_approval';
    case 'block_action': return 'block_unless_approved';
    case 'flag_note':
    default: return null;
  }
}

// Supplementary actions (in addition to the implicit primary) the operator may
// add for a given purpose. flag_note has no primary; it picks from the full
// observational supplementary set. queue_batch may also add note/flag/priority.
// Pre-action purposes (review/approval/block) keep their primary atomic.
export function supplementaryActionsFor(purpose: RulePurpose): AutomationActionType[] {
  switch (purpose) {
    case 'flag_note': return ['add_flag', 'add_internal_note', 'set_priority'];
    case 'queue_batch': return ['add_flag', 'add_internal_note', 'set_priority'];
    default: return [];
  }
}

export function actionsForPurpose(purpose: RulePurpose, trigger: AutomationTriggerType): AutomationActionType[] {
  const primary = primaryActionFor(purpose, trigger);
  const supp = supplementaryActionsFor(purpose);
  return primary ? [primary, ...supp] : supp;
}

// Per-trigger condition field allow-list. Most triggers can use the full
// observational field set; pre_label_purchase additionally exposes
// selectedRateCost; pickup/tracking triggers narrow the set so the builder
// does not offer fields with no operational meaning at that point.
const ALL_OBSERVATIONAL_FIELDS: AutomationConditionField[] = [
  'mode', 'status', 'sourceType', 'carrier', 'serviceLevel',
  'addressValidationState', 'hasLabel', 'hasPickup', 'shippingCost',
];

// Phase 3 Pass #16 — SLA-aware condition field set. Available on every SLA
// trigger so an operator can compose conditions like
// "slaTargetType is dispatch_by AND slaVarianceMinutes < -10". Mixed with
// the basic shipment fields so common filters (carrier, sourceType, mode)
// remain composable on SLA triggers too.
const SLA_TRIGGER_FIELDS: AutomationConditionField[] = [
  'mode', 'sourceType', 'carrier', 'serviceLevel', 'status',
  'slaWorstStatus', 'slaTargetType', 'slaIsPaused', 'slaHasDelayReason',
  'slaVarianceMinutes', 'isReturn',
];

export function conditionFieldsForTrigger(trigger: AutomationTriggerType): AutomationConditionField[] {
  switch (trigger) {
    case 'pre_label_purchase':
      return ['mode', 'sourceType', 'carrier', 'serviceLevel', 'addressValidationState', 'selectedRateCost'];
    // Phase 3 matrix refinement — pre_batch_label_purchase mirrors
    // pre_label_purchase: same buyable shipment shape, same selected-rate
    // cost gate. The only difference is execution context (batch vs
    // single), which the engine surfaces via the trigger name itself.
    case 'pre_batch_label_purchase':
      return ['mode', 'sourceType', 'carrier', 'serviceLevel', 'addressValidationState', 'selectedRateCost'];
    // Phase 3 matrix refinement — pre_pickup_request fires before the
    // carrier pickup booking call. addressValidationState is exposed so
    // operators can write rules like "block when origin is not validated"
    // before the truck is scheduled.
    case 'pre_pickup_request':
      return ['mode', 'sourceType', 'carrier', 'serviceLevel', 'hasPickup', 'addressValidationState'];
    // Phase 3 matrix refinement — pre_shipment_dispatch fires before
    // the operator-driven Status → Dispatched transition. status is
    // exposed so a rule can read the FROM-status; hasLabel/hasPickup
    // capture the readiness state that should normally be present
    // before dispatch.
    case 'pre_shipment_dispatch':
      return ['mode', 'sourceType', 'carrier', 'serviceLevel', 'status', 'hasLabel', 'hasPickup'];
    case 'pickup_requested':
    case 'pickup_confirmed':
    case 'pickup_cancelled':
      return ['mode', 'sourceType', 'carrier', 'serviceLevel', 'hasPickup'];
    case 'tracking_synced':
      return ['mode', 'sourceType', 'carrier', 'serviceLevel', 'status'];
    case 'label_purchased':
      return ['mode', 'sourceType', 'carrier', 'serviceLevel', 'shippingCost'];
    case 'return_shipment_created':
      return ['mode', 'sourceType', 'carrier', 'serviceLevel', 'addressValidationState'];
    case 'sla_at_risk':
    case 'sla_overdue':
    case 'sla_missed':
    case 'sla_paused':
    case 'sla_resumed':
    case 'sla_delay_reason_added':
      return SLA_TRIGGER_FIELDS;
    default:
      return ALL_OBSERVATIONAL_FIELDS;
  }
}

// Derive purpose for legacy rules created before the purpose-driven model.
// Inspects actions in priority order so the most specific intent wins.
export function inferPurposeFromActions(actions: AutomationAction[]): RulePurpose {
  const types = new Set(actions.map(a => a.type));
  if (types.has('block_unless_approved')) return 'block_action';
  if (types.has('require_approval')) return 'require_approval';
  if (types.has('require_review_before_action') || types.has('mark_review_needed')) return 'require_review';
  if (types.has('mark_ready_for_batch')) return 'queue_batch';
  return 'flag_note';
}

export function getRulePurpose(rule: Pick<AutomationRule, 'purpose' | 'actions'>): RulePurpose {
  return rule.purpose || inferPurposeFromActions(rule.actions);
}

export interface RuleEvaluation {
  matched: boolean;
  failedConditionIndex?: number;
  failedConditionDescription?: string;
}

export interface RuleEvaluationResult {
  shipmentUpdates: Partial<Shipment>;
  logs: AutomationLogEntry[];
  evaluations: { rule: AutomationRule; evaluation: RuleEvaluation }[];
}

// Phase 3 correction — typed field registry. Each condition field is classified
// so the rule builder can present operators and value inputs that make sense
// for that field, and the plain-language summary can render correctly.
export interface FieldDescriptor {
  field: AutomationConditionField;
  label: string;
  kind: AutomationFieldKind;
  options?: { value: string; label: string }[];
  unit?: string;
}

export const FIELD_DESCRIPTORS: FieldDescriptor[] = [
  { field: 'mode', label: 'Shipment Mode', kind: 'enum', options: [
    { value: 'provider', label: 'Provider (carrier label)' },
    { value: 'manual', label: 'Manual (no carrier label)' },
  ]},
  { field: 'status', label: 'Shipment Status', kind: 'enum', options: [
    { value: 'Draft', label: 'Draft' },
    { value: 'Ready', label: 'Ready' },
    { value: 'Packed', label: 'Packed' },
    { value: 'Label Created', label: 'Label Created' },
    { value: 'Dispatched', label: 'Dispatched' },
    { value: 'In Transit', label: 'In Transit' },
    { value: 'Out for Delivery', label: 'Out for Delivery' },
    { value: 'Delivered', label: 'Delivered' },
    { value: 'Exception', label: 'Exception' },
    { value: 'Returned', label: 'Returned' },
    { value: 'Cancelled', label: 'Cancelled' },
  ]},
  { field: 'sourceType', label: 'Source Type', kind: 'enum', options: [
    { value: 'Invoice', label: 'Invoice' },
    { value: 'Repair', label: 'Repair' },
    { value: 'RMA', label: 'RMA' },
    { value: 'Transfer', label: 'Transfer' },
    { value: 'Manual', label: 'Manual' },
    { value: 'Return', label: 'Return' },
  ]},
  { field: 'carrier', label: 'Carrier', kind: 'text' },
  { field: 'serviceLevel', label: 'Service Level', kind: 'text' },
  { field: 'addressValidationState', label: 'Address Validation State', kind: 'enum', options: [
    { value: 'both_validated', label: 'Both addresses validated' },
    { value: 'partial_validated', label: 'One address validated' },
    { value: 'corrected', label: 'Corrected by carrier' },
    { value: 'failed', label: 'Validation failed' },
    { value: 'unvalidated', label: 'Not validated' },
  ]},
  { field: 'hasLabel', label: 'Has Carrier Label', kind: 'boolean' },
  { field: 'hasPickup', label: 'Has Pickup Scheduled', kind: 'boolean' },
  { field: 'shippingCost', label: 'Shipping Cost', kind: 'number', unit: 'currency' },
  // Phase 3 correction #4 — selected rate cost (pre-label-purchase).
  { field: 'selectedRateCost', label: 'Selected Rate Cost', kind: 'number', unit: 'currency' },
  // Phase 3 Pass #16 — SLA-aware condition fields. Enum/boolean/number kinds
  // are picked so the rule builder offers the same operator UX as for any
  // other typed field (no special-cased SLA UI). Options match the SlaStatus
  // / SlaTargetType union members in src/types.ts so the dropdowns stay in
  // sync with the SLA foundation.
  { field: 'slaWorstStatus', label: 'SLA Worst Status', kind: 'enum', options: [
    { value: 'on_track', label: 'On Track' },
    { value: 'at_risk', label: 'At Risk' },
    { value: 'overdue', label: 'Overdue' },
    { value: 'missed', label: 'Missed' },
    { value: 'met', label: 'Met' },
    { value: 'paused', label: 'Paused' },
    { value: 'not_applicable', label: 'Not Applicable' },
    { value: 'unknown', label: 'Unknown' },
  ]},
  { field: 'slaTargetType', label: 'SLA Target Type', kind: 'enum', options: [
    { value: 'pack_by', label: 'Pack By' },
    { value: 'label_by', label: 'Label By' },
    { value: 'dispatch_by', label: 'Dispatch By' },
    { value: 'deliver_by', label: 'Deliver By' },
    { value: 'return_receive_by', label: 'Return Receive By' },
  ]},
  { field: 'slaIsPaused', label: 'SLA Is Paused', kind: 'boolean' },
  { field: 'slaHasDelayReason', label: 'SLA Has Delay Reason', kind: 'boolean' },
  { field: 'slaVarianceMinutes', label: 'SLA Variance (minutes)', kind: 'number' },
  { field: 'isReturn', label: 'Is Return Shipment', kind: 'boolean' },
];

// Phase 3 correction — operator catalog by field kind. Underlying op codes
// (eq, neq, in, notIn, gt, gte, lt, lte, truthy, falsy, contains, …) are
// implementation primitives; the UI only ever shows the human-readable label.
export interface OperatorChoice {
  op: AutomationConditionOp;
  label: string;
  needsValue: boolean;
  multiValue?: boolean;
}

export const OPERATORS_BY_KIND: Record<AutomationFieldKind, OperatorChoice[]> = {
  boolean: [
    { op: 'truthy', label: 'is true', needsValue: false },
    { op: 'falsy', label: 'is false', needsValue: false },
  ],
  number: [
    { op: 'eq', label: 'equals', needsValue: true },
    { op: 'neq', label: 'does not equal', needsValue: true },
    { op: 'gt', label: 'greater than', needsValue: true },
    { op: 'gte', label: 'greater than or equal to', needsValue: true },
    { op: 'lt', label: 'less than', needsValue: true },
    { op: 'lte', label: 'less than or equal to', needsValue: true },
  ],
  enum: [
    { op: 'eq', label: 'is', needsValue: true },
    { op: 'neq', label: 'is not', needsValue: true },
    { op: 'in', label: 'is one of', needsValue: true, multiValue: true },
    { op: 'notIn', label: 'is not one of', needsValue: true, multiValue: true },
  ],
  text: [
    { op: 'eq', label: 'equals', needsValue: true },
    { op: 'neq', label: 'does not equal', needsValue: true },
    { op: 'contains', label: 'contains', needsValue: true },
    { op: 'not_contains', label: 'does not contain', needsValue: true },
    { op: 'starts_with', label: 'starts with', needsValue: true },
    { op: 'ends_with', label: 'ends with', needsValue: true },
    { op: 'in', label: 'is one of', needsValue: true, multiValue: true },
    { op: 'notIn', label: 'is not one of', needsValue: true, multiValue: true },
  ],
};

export function getFieldDescriptor(field: AutomationConditionField): FieldDescriptor | undefined {
  return FIELD_DESCRIPTORS.find(f => f.field === field);
}

export function getOperatorChoice(kind: AutomationFieldKind, op: AutomationConditionOp): OperatorChoice | undefined {
  return OPERATORS_BY_KIND[kind].find(o => o.op === op);
}

function getShipmentFieldValue(
  shipment: Shipment,
  field: AutomationConditionField,
  triggerContext?: AutomationTriggerContext,
): any {
  switch (field) {
    case 'mode': return shipment.shipmentMode || (shipment.label ? 'provider' : 'manual');
    case 'status': return shipment.status;
    case 'sourceType': return shipment.sourceType;
    case 'carrier': return shipment.carrier || shipment.selectedRate?.carrier || '';
    case 'serviceLevel': return shipment.serviceLevel || shipment.selectedRate?.serviceName || '';
    case 'addressValidationState': {
      const o = shipment.originAddressValidation?.status;
      const d = shipment.addressValidation?.status;
      if (o === 'validated' && d === 'validated') return 'both_validated';
      if (o === 'failed' || d === 'failed') return 'failed';
      if (o === 'corrected' || d === 'corrected') return 'corrected';
      if (o === 'validated' || d === 'validated') return 'partial_validated';
      return 'unvalidated';
    }
    case 'hasLabel': return !!shipment.label;
    case 'hasPickup': return !!shipment.pickupInfo?.pickupRequested || !!(shipment as any).pickupRequest;
    case 'shippingCost': return typeof shipment.shippingCost === 'number' ? shipment.shippingCost : null;
    case 'selectedRateCost': {
      // Reads the candidate rate's price. evaluateGuardrails passes a
      // candidatePatch with selectedRate set so this resolves correctly even
      // when the operator has just picked but not yet purchased.
      const r = shipment.selectedRate?.rate;
      return typeof r === 'number' ? r : null;
    }
    // Phase 3 Pass #16 — SLA-aware fields. Mix of shipment-derived
    // (slaIsPaused, slaHasDelayReason, isReturn, slaWorstStatus) and
    // event-context-derived (slaTargetType, slaVarianceMinutes).
    //
    // slaWorstStatus is the SHIPMENT-derived worst status across all
    // applicable SLA targets at the moment the trigger fired — passed in
    // via triggerContext.slaWorstStatus by the SLA detector in
    // ShippingCenter (which has the live SlaSummary). This is distinct
    // from slaToStatus (the per-target post-transition state). Falling
    // back to slaToStatus would conflate "this one target moved into
    // overdue" with "the shipment overall is overdue" — they differ when
    // multiple targets exist (e.g. dispatch_by overdue but deliver_by
    // still on_track means worst=overdue, not whatever the event was).
    case 'slaIsPaused':
      return !!(shipment.slaPaused && !shipment.slaPaused.resumedAt);
    case 'slaHasDelayReason': {
      const reasons = shipment.slaDelayReasons || {};
      return Object.values(reasons).some(r => !!r && !!r.reason);
    }
    case 'isReturn': return !!shipment.returnInfo?.isReturn;
    case 'slaTargetType': return triggerContext?.slaTargetType ?? null;
    case 'slaVarianceMinutes': {
      if (typeof triggerContext?.slaVarianceMs !== 'number') return null;
      return Math.round(triggerContext.slaVarianceMs / 60000);
    }
    case 'slaWorstStatus': return triggerContext?.slaWorstStatus ?? null;
    default: return null;
  }
}

function evaluateCondition(
  shipment: Shipment,
  condition: AutomationCondition,
  triggerContext?: AutomationTriggerContext,
): boolean {
  const actual = getShipmentFieldValue(shipment, condition.field, triggerContext);
  const v = condition.value;
  switch (condition.op) {
    case 'eq': return String(actual) === String(v);
    case 'neq': return String(actual) !== String(v);
    case 'in': return Array.isArray(v) && v.map(String).includes(String(actual));
    case 'notIn': return Array.isArray(v) && !v.map(String).includes(String(actual));
    case 'gt': return typeof actual === 'number' && typeof v === 'number' && actual > v;
    case 'gte': return typeof actual === 'number' && typeof v === 'number' && actual >= v;
    case 'lt': return typeof actual === 'number' && typeof v === 'number' && actual < v;
    case 'lte': return typeof actual === 'number' && typeof v === 'number' && actual <= v;
    case 'truthy': return !!actual;
    case 'falsy': return !actual;
    case 'contains': return String(actual ?? '').toLowerCase().includes(String(v ?? '').toLowerCase());
    case 'not_contains': return !String(actual ?? '').toLowerCase().includes(String(v ?? '').toLowerCase());
    case 'starts_with': return String(actual ?? '').toLowerCase().startsWith(String(v ?? '').toLowerCase());
    case 'ends_with': return String(actual ?? '').toLowerCase().endsWith(String(v ?? '').toLowerCase());
    default: return false;
  }
}

export function ruleTriggerMatches(rule: AutomationRule, trigger: AutomationTriggerType): boolean {
  return rule.enabled && rule.trigger === trigger;
}

// Phase 3 correction #3 — observational vs guardrail dispatch helpers. The
// post-event engine (`runAutomation`) must only consider observational rules;
// the pre-action engine (`evaluateGuardrails`) must only consider guardrail
// rules. Process type is the source of truth, not trigger family alone, so a
// rule mis-typed at creation time still fails fast.
function isObservationalRule(rule: AutomationRule, trigger: AutomationTriggerType): boolean {
  return ruleTriggerMatches(rule, trigger) && getRuleProcessType(rule) === 'observational';
}

function isGuardrailRule(rule: AutomationRule, trigger: AutomationTriggerType): boolean {
  return ruleTriggerMatches(rule, trigger) && getRuleProcessType(rule) === 'guardrail';
}

export function evaluateRule(
  rule: AutomationRule,
  shipment: Shipment,
  triggerContext?: AutomationTriggerContext,
): RuleEvaluation {
  if (!rule.conditions || rule.conditions.length === 0) return { matched: true };
  for (let i = 0; i < rule.conditions.length; i++) {
    if (!evaluateCondition(shipment, rule.conditions[i], triggerContext)) {
      return {
        matched: false,
        failedConditionIndex: i,
        failedConditionDescription: describeCondition(rule.conditions[i]),
      };
    }
  }
  return { matched: true };
}

function applyActionsToShipment(
  shipment: Shipment,
  rule: AutomationRule,
  actions: AutomationAction[],
  now: string,
): { updates: Partial<Shipment>; appliedLabels: string[] } {
  const updates: Partial<Shipment> = {};
  const appliedLabels: string[] = [];
  const flags = new Set<string>(shipment.flags || []);
  const notes: ShipmentInternalNote[] = [...(shipment.internalNotes || [])];
  let newReview = shipment.reviewNeeded;
  let newBatchState = shipment.batchQueueState;
  let newBatchMarkedAt = shipment.batchQueueMarkedAt;
  let newBatchRuleId = shipment.batchQueueRuleId;
  let newPriority = shipment.priority;

  for (const action of actions) {
    // Phase 3 correction #3 — guardrail-only actions are evaluated by
    // evaluateGuardrails, not here. Skip silently if accidentally placed on
    // an observational rule (the rule builder also prevents this at edit time).
    if (action.type === 'require_approval' || action.type === 'block_unless_approved' || action.type === 'require_review_before_action') continue;
    switch (action.type) {
      case 'add_flag': {
        const flag = String(action.params?.flag || '').trim();
        if (flag && !flags.has(flag)) { flags.add(flag); appliedLabels.push(`flag:${flag}`); }
        break;
      }
      case 'add_internal_note': {
        const text = String(action.params?.text || `Rule "${rule.name}" matched`).trim();
        if (text) {
          notes.push({
            id: `note-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            text, timestamp: now, source: 'rule', ruleId: rule.id, ruleName: rule.name,
          });
          appliedLabels.push('note');
        }
        break;
      }
      case 'mark_review_needed': {
        // Phase 3 correction — do not spam re-marks. If this same rule already
        // has an active (unresolved) review on this shipment, skip so the
        // execution log stays truthful (no duplicate "review_needed" rows for
        // an already-flagged shipment). A different rule, or a re-trigger
        // after the operator resolved the prior review, will mark fresh.
        const existing = newReview;
        if (existing && !existing.resolved && existing.ruleId === rule.id) {
          break;
        }
        newReview = {
          reason: String(action.params?.reason || `Marked for review by rule "${rule.name}"`),
          ruleId: rule.id, ruleName: rule.name, markedAt: now,
        };
        appliedLabels.push('review_needed');
        break;
      }
      case 'mark_ready_for_batch': {
        if (newBatchState !== 'ready_for_batch') {
          newBatchState = 'ready_for_batch';
          newBatchMarkedAt = now;
          newBatchRuleId = rule.id;
          appliedLabels.push('ready_for_batch');
        }
        break;
      }
      case 'set_priority': {
        const p = action.params?.priority;
        if (p === 'normal' || p === 'high' || p === 'urgent') {
          newPriority = p;
          appliedLabels.push(`priority:${p}`);
        }
        break;
      }
    }
  }

  if (flags.size !== (shipment.flags?.length || 0)) updates.flags = Array.from(flags);
  if (notes.length !== (shipment.internalNotes?.length || 0)) updates.internalNotes = notes;
  if (newReview !== shipment.reviewNeeded) updates.reviewNeeded = newReview;
  if (newBatchState !== shipment.batchQueueState) {
    updates.batchQueueState = newBatchState;
    updates.batchQueueMarkedAt = newBatchMarkedAt;
    updates.batchQueueRuleId = newBatchRuleId;
  }
  if (newPriority !== shipment.priority) updates.priority = newPriority;

  return { updates, appliedLabels };
}

export function runAutomation(
  rules: AutomationRule[],
  shipment: Shipment,
  trigger: AutomationTriggerType,
  triggerContext?: AutomationTriggerContext,
): RuleEvaluationResult {
  const now = new Date().toISOString();
  let mergedUpdates: Partial<Shipment> = {};
  const logs: AutomationLogEntry[] = [];
  const evaluations: { rule: AutomationRule; evaluation: RuleEvaluation }[] = [];
  let workingShipment = shipment;
  // Phase 3 Pass #16 — capture per-event SLA context once so log entries for
  // SLA-trigger matches always carry the same snapshot the engine evaluated
  // against. Non-SLA triggers leave these fields unset on the log entry.
  const slaLogFields = isSlaTrigger(trigger) ? {
    slaTargetType: triggerContext?.slaTargetType,
    slaFromStatus: triggerContext?.slaFromStatus,
    slaToStatus: triggerContext?.slaToStatus,
    slaVarianceMinutes: typeof triggerContext?.slaVarianceMs === 'number'
      ? Math.round(triggerContext.slaVarianceMs / 60000)
      : undefined,
    slaTriggerReason: triggerContext?.slaReason,
  } : {};
  for (const rule of rules) {
    // Phase 3 correction #3 — runAutomation is the post-event path. Guardrail
    // rules are evaluated by `evaluateGuardrails` only; they never fire here,
    // so a guardrail rule cannot accidentally double as a post-event flag.
    if (!isObservationalRule(rule, trigger)) continue;
    const evalResult = evaluateRule(rule, workingShipment, triggerContext);
    evaluations.push({ rule, evaluation: evalResult });
    if (!evalResult.matched) continue;
    const { updates, appliedLabels } = applyActionsToShipment(workingShipment, rule, rule.actions, now);
    if (Object.keys(updates).length > 0) {
      mergedUpdates = { ...mergedUpdates, ...updates };
      workingShipment = { ...workingShipment, ...updates };
    }
    logs.push({
      id: `log-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      ruleId: rule.id,
      ruleName: rule.name,
      ruleSummary: describeRule(rule),
      shipmentId: shipment.id,
      shipmentNumber: shipment.shipmentNumber,
      trigger,
      matched: true,
      actionsApplied: appliedLabels,
      timestamp: now,
      ...slaLogFields,
    });
  }
  return { shipmentUpdates: mergedUpdates, logs, evaluations };
}

// Phase 3 correction #3 — pre-action guardrail evaluation. Pure: no log
// writes, no shipment mutation. Caller (e.g. ShippingCenter pre-label-purchase
// flow) decides what to do with the result and what to record. `candidatePatch`
// is an optional shallow overlay merged onto the shipment for evaluation only,
// letting callers test "if I purchased with THIS rate" without committing.
export interface GuardrailEvaluation {
  rule: AutomationRule;
  evaluation: RuleEvaluation;
  // True if this rule has at least one block_unless_approved action.
  blocking: boolean;
  // True if this rule has at least one require_approval action.
  approvalRequested: boolean;
  // Phase 3 correction #4 — true if this rule has at least one
  // require_review_before_action (Require Review purpose, pre-action trigger).
  reviewRequested: boolean;
  // Plain-language summary for the modal copy.
  reason: string;
}

export interface GuardrailEvaluationResult {
  blockingRules: GuardrailEvaluation[];
  approvalRules: GuardrailEvaluation[];
  // Phase 3 correction #4 — review-only guardrail rules. Distinct from
  // approvalRules because clearing them does not require approver
  // permission; any operator can acknowledge.
  reviewRules: GuardrailEvaluation[];
  allClear: boolean;
}

// Phase 3 correction #5 — stable approval-context key. Combines the rule
// id, shipment id, and a deterministic signature of the selected rate so
// the same approval decision can be recognized across re-evaluations of
// the same purchase attempt. Selecting a different rate produces a
// different key, so a prior approval does not leak to a different rate.
export function buildApprovalContextKey(
  ruleId: string,
  shipmentId: string,
  selectedRate?: { providerRateRef?: string; carrier?: string; serviceName?: string; rate?: number; currency?: string } | null,
): string {
  const rateId = selectedRate?.providerRateRef
    || (selectedRate ? `${selectedRate.carrier ?? ''}|${selectedRate.serviceName ?? ''}|${selectedRate.rate ?? ''}|${selectedRate.currency ?? ''}` : '');
  return `${ruleId}::${shipmentId}::${rateId || 'no-rate'}`;
}

export function evaluateGuardrails(
  rules: AutomationRule[],
  shipment: Shipment,
  trigger: AutomationTriggerType,
  candidatePatch?: Partial<Shipment>,
): GuardrailEvaluationResult {
  const subject: Shipment = candidatePatch ? { ...shipment, ...candidatePatch } : shipment;
  const blockingRules: GuardrailEvaluation[] = [];
  const approvalRules: GuardrailEvaluation[] = [];
  const reviewRules: GuardrailEvaluation[] = [];
  // Phase 3 correction #5 — already-approved-context recognition. Any
  // rule whose computed approval context key is in the shipment's
  // approvedGuardrailContexts list is treated as cleared and skipped, so
  // re-purchase attempts with the same rule + rate do not re-prompt.
  const approvedContexts = shipment.approvedGuardrailContexts || [];
  const candidateRate = (candidatePatch && 'selectedRate' in candidatePatch)
    ? (candidatePatch as { selectedRate?: typeof shipment.selectedRate }).selectedRate
    : shipment.selectedRate;
  for (const rule of rules) {
    // Phase 3 correction #4 — accept rules whose ruleType is 'guardrail'
    // OR whose effective process type is guardrail (purpose='require_review'
    // on a pre-action trigger). isGuardrailRule covers the former; we
    // additionally pick up purpose-driven review-on-pre-action rules here so
    // legacy and new rule shapes both work.
    if (!ruleTriggerMatches(rule, trigger)) continue;
    const isGuardrail = isGuardrailRule(rule, trigger)
      // Phase 3 matrix refinement — review-on-pre-action also lifts to
      // guardrail semantics on every pre-action trigger, not just
      // pre_label_purchase.
      || (rule.purpose === 'require_review' && PRE_ACTION_TRIGGERS.includes(trigger));
    if (!isGuardrail) continue;
    // Phase 3 correction #5 — skip rules whose context has already been
    // approved/overridden for this shipment + rate.
    const ctxKey = buildApprovalContextKey(rule.id, shipment.id, candidateRate as any);
    if (approvedContexts.includes(ctxKey)) continue;
    const evaluation = evaluateRule(rule, subject);
    if (!evaluation.matched) continue;
    const blocking = rule.actions.some(a => a.type === 'block_unless_approved');
    const approvalRequested = rule.actions.some(a => a.type === 'require_approval');
    const reviewRequested = rule.actions.some(a => a.type === 'require_review_before_action')
      // Phase 3 matrix refinement — pick up review-on-pre-action across
      // all four pre-action triggers so the modal dispatches the same
      // way for pickup / dispatch / batch as it does for label purchase.
      || (rule.purpose === 'require_review' && PRE_ACTION_TRIGGERS.includes(trigger));
    // A guardrail rule with no guardrail actions is a no-op; skip so it does
    // not silently halt the user's purchase flow.
    if (!blocking && !approvalRequested && !reviewRequested) continue;
    const reason = describeRule(rule);
    const entry: GuardrailEvaluation = { rule, evaluation, blocking, approvalRequested, reviewRequested, reason };
    if (blocking) blockingRules.push(entry);
    else if (approvalRequested) approvalRules.push(entry);
    else reviewRules.push(entry);
  }
  return {
    blockingRules, approvalRules, reviewRules,
    allClear: blockingRules.length === 0 && approvalRules.length === 0 && reviewRules.length === 0,
  };
}

export const TRIGGER_LABELS: Record<AutomationTriggerType, string> = {
  shipment_created: 'a shipment is created',
  shipment_updated: 'a shipment is edited',
  status_changed: 'shipment status changes',
  label_purchased: 'a carrier label is purchased',
  pickup_requested: 'a pickup is requested',
  pickup_confirmed: 'a pickup is confirmed',
  pickup_cancelled: 'a pickup is cancelled',
  tracking_synced: 'tracking is synced',
  return_shipment_created: 'a return shipment is created',
  pre_label_purchase: 'a carrier label is about to be purchased',
  pre_pickup_request: 'a carrier pickup is about to be requested',
  pre_shipment_dispatch: 'a shipment is about to be dispatched',
  pre_batch_label_purchase: 'a batch label purchase is about to run',
  packing_started: 'packing is started on a shipment',
  packing_completed: 'packing is completed on a shipment',
  packing_exception_created: 'a packing exception is created',
  // Phase 3 Pass #16 — SLA Automation Linkage human strings.
  sla_at_risk: 'an SLA target enters at-risk',
  sla_overdue: 'an SLA target becomes overdue',
  sla_missed: 'an SLA target is missed',
  sla_paused: 'an SLA is paused on a shipment',
  sla_resumed: 'an SLA is resumed on a shipment',
  sla_delay_reason_added: 'an SLA delay reason is recorded',
};

const TRIGGER_LABELS_TITLECASE: Record<AutomationTriggerType, string> = {
  shipment_created: 'Shipment Created',
  shipment_updated: 'Shipment Edited',
  status_changed: 'Status Changed',
  label_purchased: 'Label Purchased',
  pickup_requested: 'Pickup Requested',
  pickup_confirmed: 'Pickup Confirmed',
  pickup_cancelled: 'Pickup Cancelled',
  tracking_synced: 'Tracking Synced',
  return_shipment_created: 'Return Shipment Created',
  pre_label_purchase: 'Before Label Purchase',
  pre_pickup_request: 'Before Pickup Request',
  pre_shipment_dispatch: 'Before Shipment Dispatch',
  pre_batch_label_purchase: 'Before Batch Label Purchase',
  packing_started: 'Packing Started',
  packing_completed: 'Packing Completed',
  packing_exception_created: 'Packing Exception Created',
  sla_at_risk: 'SLA At Risk',
  sla_overdue: 'SLA Overdue',
  sla_missed: 'SLA Missed',
  sla_paused: 'SLA Paused',
  sla_resumed: 'SLA Resumed',
  sla_delay_reason_added: 'SLA Delay Reason Added',
};

export function getTriggerTitle(t: AutomationTriggerType): string { return TRIGGER_LABELS_TITLECASE[t]; }

// Phase 3 Pass #16 — convenience accessors mirroring the spec's helper names.
// These intentionally alias getTriggerTitle / getFieldDescriptor / ACTION_LABELS
// so the rule builder and execution-history list can call a single named helper
// per concept without importing several maps.
export function getTriggerLabel(t: AutomationTriggerType): string { return TRIGGER_LABELS_TITLECASE[t] || t; }
export function getConditionFieldLabel(field: AutomationConditionField): string {
  return getFieldDescriptor(field)?.label || field;
}
export function getActionLabel(type: AutomationActionType): string {
  return ACTION_LABELS[type] || type;
}

// Phase 3 Pass #16 — SLA target / status human labels for execution-history
// chips ("Dispatch By: on_track → at_risk"). Local to the engine so the UI
// does not duplicate these mappings.
const SLA_TARGET_LABELS: Record<SlaTargetType, string> = {
  pack_by: 'Pack By',
  label_by: 'Label By',
  dispatch_by: 'Dispatch By',
  deliver_by: 'Deliver By',
  return_receive_by: 'Return Receive By',
};
const SLA_STATUS_LABELS: Record<SlaStatus, string> = {
  not_applicable: 'Not Applicable',
  on_track: 'On Track',
  at_risk: 'At Risk',
  overdue: 'Overdue',
  met: 'Met',
  missed: 'Missed',
  paused: 'Paused',
  unknown: 'Unknown',
};
export function getSlaTargetLabel(t: SlaTargetType): string { return SLA_TARGET_LABELS[t] || t; }
export function getSlaStatusLabel(s: SlaStatus): string { return SLA_STATUS_LABELS[s] || s; }

export const ACTION_LABELS: Record<string, string> = {
  add_flag: 'add a flag',
  add_internal_note: 'add an internal note',
  mark_review_needed: 'mark the shipment for review',
  mark_ready_for_batch: 'queue the shipment for batch labels',
  set_priority: 'set shipment priority',
  require_approval: 'require operator approval before the action proceeds',
  block_unless_approved: 'block the action unless an authorized operator approves or overrides',
  require_review_before_action: 'require an operator to acknowledge a review before the action proceeds',
};

function describeValue(condition: AutomationCondition, descriptor?: FieldDescriptor): string {
  const v = condition.value;
  if (Array.isArray(v)) {
    if (descriptor?.kind === 'enum' && descriptor.options) {
      return v.map(item => descriptor.options!.find(o => o.value === item)?.label || String(item)).join(', ');
    }
    return v.map(String).join(', ');
  }
  if (descriptor?.kind === 'enum' && descriptor.options) {
    return descriptor.options.find(o => o.value === String(v))?.label || String(v ?? '');
  }
  if (descriptor?.kind === 'number' && descriptor.unit === 'currency' && typeof v === 'number') {
    return `$${v.toFixed(2)}`;
  }
  return String(v ?? '');
}

export function describeCondition(condition: AutomationCondition): string {
  const descriptor = getFieldDescriptor(condition.field);
  const fieldLabel = descriptor?.label || condition.field;
  const choice = descriptor ? getOperatorChoice(descriptor.kind, condition.op) : undefined;
  const opLabel = choice?.label || condition.op;
  if (choice && !choice.needsValue) return `${fieldLabel} ${opLabel}`;
  return `${fieldLabel} ${opLabel} ${describeValue(condition, descriptor)}`.trim();
}

export function describeAction(action: AutomationAction): string {
  switch (action.type) {
    case 'add_flag': return `add the flag "${action.params?.flag || ''}"`;
    case 'add_internal_note': return action.params?.text ? `add an internal note "${action.params.text}"` : 'add an internal note';
    case 'mark_review_needed': return action.params?.reason ? `mark the shipment for review (${action.params.reason})` : 'mark the shipment for review';
    case 'mark_ready_for_batch': return 'queue the shipment for batch labels';
    case 'set_priority': return `set shipment priority to ${action.params?.priority || 'normal'}`;
    case 'require_approval': return action.params?.reason
      ? `require operator approval (${action.params.reason})`
      : 'require operator approval before the action proceeds';
    case 'block_unless_approved': return action.params?.reason
      ? `block the action unless approved or overridden (${action.params.reason})`
      : 'block the action unless an authorized operator approves or overrides';
    case 'require_review_before_action': return action.params?.reason
      ? `require operator review before the action proceeds (${action.params.reason})`
      : 'require operator review before the action proceeds';
    default: return ACTION_LABELS[action.type] || action.type;
  }
}

// Phase 3 correction — plain-language rule summary. Used in the rule editor
// (live preview) and rule list (persistent display) so non-technical operators
// can read what a rule does at a glance.
export function describeRule(rule: Pick<AutomationRule, 'name' | 'trigger' | 'conditions' | 'actions'>): string {
  const triggerPart = TRIGGER_LABELS[rule.trigger] || rule.trigger;
  const conditionPart = rule.conditions.length === 0
    ? ''
    : ` and ${rule.conditions.map(describeCondition).join(' and ')}`;
  const actionPart = rule.actions.length === 0
    ? 'do nothing'
    : rule.actions.map(describeAction).join(', then ');
  return `When ${triggerPart}${conditionPart}, ${actionPart}.`;
}

// =============================================================================
// Phase 3 — SLA Automation Backfill
// =============================================================================
//
// The default automation engine path is *future-only*: a rule fires when the
// underlying event happens (a transition, a paused/resumed event, etc.). The
// backfill helpers below let an authorized operator explicitly apply an
// SLA-trigger rule to existing matching shipments — confirmed, itemized,
// duplicate-safe, audited. They never run automatically. The engine here
// only exposes pure helpers; the orchestration (scan + execute) lives in
// ShippingCenter and reuses `runAutomation` so the action whitelist /
// guardrail skipping rules remain the single source of truth.
//
// Excluded from backfill on purpose:
//   - sla_resumed                — by definition a one-off transient event;
//                                   nothing to "match" against current state.
//   - all non-SLA triggers       — Phase 3 scope is SLA-only.
//   - all guardrail process      — guardrails are pre-action gates, not
//                                   post-event flags; backfilling a guardrail
//                                   rule onto a shipment that already
//                                   completed the gated action is meaningless.

export const BACKFILLABLE_SLA_TRIGGERS: AutomationTriggerType[] = [
  'sla_at_risk', 'sla_overdue', 'sla_missed',
  'sla_paused', 'sla_delay_reason_added',
];

export function isBackfillableTrigger(trigger: AutomationTriggerType): boolean {
  return BACKFILLABLE_SLA_TRIGGERS.includes(trigger);
}

// Stable key per (rule, target) used for re-run safety. Stored on the
// shipment in `slaAutomationBackfillKeys`. A rule with no specific target in
// the trigger context (e.g. `sla_paused` is shipment-global) uses '__any__'
// as the target slot so re-runs of that exact rule are still deduped.
export function buildBackfillKey(ruleId: string, targetType?: SlaTargetType): string {
  return `${ruleId}|${targetType ?? '__any__'}`;
}

// Stable key for non-SLA backfill applies. Distinct prefix so it cannot
// shadow an existing SLA-format key on the same shipment if the rule's
// trigger family changes between backfill runs (the runtime
// trigger-changed guard also blocks that case, but the key format gives
// us a second layer of guarantee for already-stored history).
export function buildNonSlaBackfillKey(ruleId: string, trigger: AutomationTriggerType): string {
  return `${ruleId}|nonsla:${trigger}`;
}

// Lightweight projection of `SlaShipmentSummary` the backfill helper needs.
// Defined locally so the engine module does not have to import from
// `../utils/sla` (which would create a longer dependency chain). Callers
// (ShippingCenter) already compute the full summary and just pass the
// pieces relevant for matching.
export interface SlaBackfillStateView {
  worst: SlaStatus;
  paused: boolean;
  targets: Array<Pick<import('../types').SlaTarget, 'type' | 'status' | 'varianceMs'>>;
  pause?: { reason?: string } | null;
  delayReasons?: Partial<Record<SlaTargetType, { reason: string }>>;
}

export type BackfillCandidateOutcome =
  | { kind: 'match'; ctx: AutomationTriggerContext; slaTargetType?: SlaTargetType }
  | { kind: 'no_state'; reason: string }
  | { kind: 'conditions_failed'; failedConditionDescription?: string; ctx?: AutomationTriggerContext; slaTargetType?: SlaTargetType };

function pickWorstTargetWithStatus(
  targets: SlaBackfillStateView['targets'],
  status: SlaStatus,
): SlaBackfillStateView['targets'][number] | null {
  let pick: SlaBackfillStateView['targets'][number] | null = null;
  for (const t of targets) {
    if (t.status !== status) continue;
    if (!pick) { pick = t; continue; }
    // Prefer larger variance magnitude (more impactful) when same status.
    const a = Math.abs(pick.varianceMs ?? 0);
    const b = Math.abs(t.varianceMs ?? 0);
    if (b > a) pick = t;
  }
  return pick;
}

// Pure: derive the synthetic per-event context for one (rule, shipment) pair
// given the shipment's current SLA state, then run the existing rule
// evaluator. Returns one of three outcomes so the caller can itemize
// per-shipment results without re-running matching twice.
export function evaluateSlaBackfillCandidate(
  rule: AutomationRule,
  shipment: Shipment,
  state: SlaBackfillStateView,
): BackfillCandidateOutcome {
  if (!isBackfillableTrigger(rule.trigger)) {
    return { kind: 'no_state', reason: 'Trigger is not backfillable' };
  }

  let ctx: AutomationTriggerContext = { slaWorstStatus: state.worst };
  let slaTargetType: SlaTargetType | undefined;

  switch (rule.trigger) {
    case 'sla_at_risk':
    case 'sla_overdue':
    case 'sla_missed': {
      const wantStatus: SlaStatus =
        rule.trigger === 'sla_at_risk' ? 'at_risk'
        : rule.trigger === 'sla_overdue' ? 'overdue'
        : 'missed';
      const target = pickWorstTargetWithStatus(state.targets, wantStatus);
      if (!target) {
        return { kind: 'no_state', reason: `No ${wantStatus.replace('_', ' ')} SLA target on this shipment` };
      }
      slaTargetType = target.type;
      ctx = {
        ...ctx,
        slaTargetType: target.type,
        slaToStatus: target.status,
        slaVarianceMs: target.varianceMs,
      };
      break;
    }
    case 'sla_paused': {
      if (!state.paused) {
        return { kind: 'no_state', reason: 'Shipment SLA is not currently paused' };
      }
      ctx = {
        ...ctx,
        slaToStatus: 'paused',
        slaReason: state.pause?.reason,
      };
      break;
    }
    case 'sla_delay_reason_added': {
      const entries = Object.entries(state.delayReasons || {}) as Array<[SlaTargetType, { reason: string } | undefined]>;
      const found = entries.find(([, v]) => !!v);
      if (!found) {
        return { kind: 'no_state', reason: 'Shipment has no SLA delay reasons recorded' };
      }
      const [targetType, info] = found;
      slaTargetType = targetType;
      ctx = {
        ...ctx,
        slaTargetType: targetType,
        slaReason: info?.reason,
      };
      break;
    }
    default:
      return { kind: 'no_state', reason: 'Trigger is not backfillable' };
  }

  // Defer to the live engine so the same condition language (including SLA
  // condition fields) decides matching. No drift between live and backfill.
  const evalResult = evaluateRule(rule, shipment, ctx);
  if (!evalResult.matched) {
    return {
      kind: 'conditions_failed',
      failedConditionDescription: evalResult.failedConditionDescription,
      ctx,
      slaTargetType,
    };
  }
  return { kind: 'match', ctx, slaTargetType };
}

// ────────────────────────────────────────────────────────────────────────────
// General Automation Backfill Framework
//
// Tri-state eligibility model — current_state_backfillable / event_only /
// unsupported_backfill — implemented in getRuleBackfillEligibility(). The
// only currently-shipping current_state_backfillable family is the
// existing SLA backfill (BACKFILLABLE_SLA_TRIGGERS). The non-SLA
// current-state branch — evaluateNonSlaBackfillCandidate, the 'non_sla'
// triggerKind, and the |nonsla:<trigger> dedup-key namespace in
// ShippingCenter — is retained as inert plumbing so a genuinely
// current-state non-SLA trigger can be added later by appending it to
// CURRENT_STATE_NON_SLA_TRIGGERS (today empty) and supplying its
// per-trigger current-state precondition in evaluateNonSlaBackfillCandidate.
//
// The triggers in EVENT_ONLY_TRIGGERS describe a transition or external
// signal at a moment in time, not a persistent state. Current shipment
// data cannot truthfully tell us "this event fired in the past", so we
// never offer backfill for them — replaying would either fabricate the
// event or replay history blindly. Backfill of those semantics must be
// expressed instead via a current-state rule keyed on a current-state
// condition. We do NOT replay historical events under any path.
// ────────────────────────────────────────────────────────────────────────────

// Triggers that represent a transition or external signal at a moment
// in time. They are NOT backfillable, because the current shipment state
// cannot truthfully tell us "this event fired in the past". Re-applying
// the rule now would either fabricate an event ("we're pretending the
// label was just purchased") or replay history blindly. Backfill must
// be expressed via current-state rules instead (e.g. a rule keyed on
// "shipment currently has a carrier label" rather than the event
// "a carrier label is purchased"). The seven triggers below were briefly
// classified as backfillable during the General Automation Backfill
// Framework rollout; they have been moved back here because each is an
// event, not a state — see replit.md for the full rationale.
export const EVENT_ONLY_TRIGGERS: AutomationTriggerType[] = [
  'shipment_created',
  'shipment_updated',
  'status_changed',
  'label_purchased',
  'pickup_requested',
  'pickup_confirmed',
  'pickup_cancelled',
  'tracking_synced',
  'return_shipment_created',
  'sla_resumed',
  'pre_label_purchase',
  // Phase 3 matrix refinement — the new pre-action triggers describe an
  // imminent operator-driven action, not a persistent state. They are
  // never backfillable for the same reason pre_label_purchase is not.
  'pre_pickup_request',
  'pre_shipment_dispatch',
  'pre_batch_label_purchase',
  'packing_started',
  'packing_completed',
  'packing_exception_created',
];

// Reserved for genuinely current-state non-SLA triggers (none today).
// The framework plumbing — evaluateNonSlaBackfillCandidate, the
// 'non_sla' triggerKind, the '|nonsla:' dedup key prefix, and the
// orchestrator dispatch in ShippingCenter — is retained so that a
// future trigger like "shipment currently has a carrier label" can be
// added by appending it here and supplying a per-trigger current-state
// precondition in evaluateNonSlaBackfillCandidate. SLA-trigger backfill
// (the only family currently routed through this framework) remains
// unaffected and is handled by BACKFILLABLE_SLA_TRIGGERS below.
export const CURRENT_STATE_NON_SLA_TRIGGERS: AutomationTriggerType[] = [];

export type BackfillEligibilityKind =
  | 'current_state_backfillable'
  | 'event_only'
  | 'unsupported_backfill';

export interface RuleBackfillEligibility {
  kind: BackfillEligibilityKind;
  // Short, user-facing explanation surfaced in the rule card UI when the
  // backfill action is hidden or disabled. Only populated for the two
  // non-eligible kinds; the eligible kind has no reason to display.
  reason?: string;
  // Sub-classification used by the orchestrator to dispatch to the
  // correct candidate evaluator (SLA path vs non-SLA current-state path).
  // Always present, even for non-eligible rules, so downstream code can
  // reason about the trigger family without re-deriving it.
  triggerKind: 'sla' | 'non_sla' | 'event_only';
}

// True iff this rule has at least one action the engine will actually
// mutate from inside applyActionsToShipment. Rules whose actions list is
// 100% guardrails would produce zero engine effects during backfill (the
// engine silently skips guardrail actions inside applyActionsToShipment),
// which would be confusing — we prefer to surface that up-front via the
// 'unsupported_backfill' eligibility classification.
export function ruleHasAnySafeAction(rule: Pick<AutomationRule, 'actions'>): boolean {
  if (!rule.actions || rule.actions.length === 0) return false;
  return rule.actions.some(a => OBSERVATIONAL_ACTIONS.includes(a.type));
}

// Single source of truth for "is this rule backfillable, and if not, why
// not?". Used by the AutomationRules UI to decide button visibility and
// disabled-hint copy, and by the ShippingCenter orchestrator to gate
// runtime execution. The orchestrator must re-call this at execute time
// (not just at modal-open time) so a rule edited mid-flight cannot drive
// an out-of-scope mutation.
export function getRuleBackfillEligibility(
  rule: Pick<AutomationRule, 'trigger' | 'actions'>,
): RuleBackfillEligibility {
  if (EVENT_ONLY_TRIGGERS.includes(rule.trigger)) {
    return {
      kind: 'event_only',
      reason: 'Backfill is not available for event-only rules.',
      triggerKind: 'event_only',
    };
  }
  if (!ruleHasAnySafeAction(rule)) {
    // Either no actions at all, or only guardrail actions — neither is
    // mutated by the engine during the observational backfill path.
    return {
      kind: 'unsupported_backfill',
      reason: 'This rule has no safe actions to apply during backfill.',
      triggerKind: BACKFILLABLE_SLA_TRIGGERS.includes(rule.trigger)
        ? 'sla'
        : CURRENT_STATE_NON_SLA_TRIGGERS.includes(rule.trigger)
          ? 'non_sla'
          : 'event_only',
    };
  }
  if (BACKFILLABLE_SLA_TRIGGERS.includes(rule.trigger)) {
    return { kind: 'current_state_backfillable', triggerKind: 'sla' };
  }
  if (CURRENT_STATE_NON_SLA_TRIGGERS.includes(rule.trigger)) {
    return { kind: 'current_state_backfillable', triggerKind: 'non_sla' };
  }
  // Defensive default — any trigger not explicitly classified above is
  // treated as unsupported rather than silently allowed through.
  return {
    kind: 'unsupported_backfill',
    reason: 'Backfill is not supported for this trigger.',
    triggerKind: 'event_only',
  };
}

// Pure: derive the synthetic per-event context for one (rule, shipment)
// pair given the shipment's current non-SLA state, then run the existing
// rule evaluator. Mirrors evaluateSlaBackfillCandidate so the orchestrator
// can treat both candidate evaluators uniformly. Returns 'no_state' when
// the trigger's current-state precondition is not met (e.g. a
// label_purchased rule against a shipment with no label) so the
// orchestrator can itemize that distinctly from "matched the trigger but
// failed the conditions".
export function evaluateNonSlaBackfillCandidate(
  rule: AutomationRule,
  shipment: Shipment,
): BackfillCandidateOutcome {
  if (!CURRENT_STATE_NON_SLA_TRIGGERS.includes(rule.trigger)) {
    return { kind: 'no_state', reason: 'Trigger is not backfillable' };
  }

  // Per-trigger current-state precondition. If the precondition fails the
  // shipment is not a truthful candidate — we never fabricate the event.
  switch (rule.trigger) {
    case 'shipment_created':
      // Every persisted shipment trivially satisfies "was created".
      break;
    case 'label_purchased':
      if (!shipment.label) {
        return { kind: 'no_state', reason: 'Shipment does not currently have a label' };
      }
      break;
    case 'pickup_requested':
      if (!shipment.pickupInfo?.pickupRequested && !(shipment as any).pickupRequest) {
        return { kind: 'no_state', reason: 'Shipment does not currently have a pickup request' };
      }
      break;
    case 'return_shipment_created':
      if (!shipment.returnInfo?.isReturn) {
        return { kind: 'no_state', reason: 'Shipment is not currently a return' };
      }
      break;
    case 'packing_started':
      // The trigger fires the moment packing transitions out of
      // not_started — for backfill purposes "packing has started" is
      // truthful for any non-not_started status.
      if (!shipment.packingStatus || shipment.packingStatus === 'not_started') {
        return { kind: 'no_state', reason: 'Packing has not started for this shipment' };
      }
      break;
    case 'packing_completed':
      if (shipment.packingStatus !== 'packed') {
        return { kind: 'no_state', reason: 'Shipment is not currently packed' };
      }
      break;
    case 'packing_exception_created':
      if (shipment.packingStatus !== 'exception') {
        return { kind: 'no_state', reason: 'Shipment does not currently have a packing exception' };
      }
      break;
    default:
      return { kind: 'no_state', reason: 'Trigger is not backfillable' };
  }

  // Non-SLA triggers do not need any synthetic context fields — all of
  // their conditions read directly from the shipment via
  // getShipmentFieldValue. Passing an empty context is correct.
  const ctx: AutomationTriggerContext = {};
  const evalResult = evaluateRule(rule, shipment, ctx);
  if (!evalResult.matched) {
    return {
      kind: 'conditions_failed',
      failedConditionDescription: evalResult.failedConditionDescription,
      ctx,
    };
  }
  return { kind: 'match', ctx };
}
