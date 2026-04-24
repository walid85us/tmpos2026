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
  RulePurpose,
  Shipment,
  ShipmentInternalNote,
} from '../types';

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
];

export const GUARDRAIL_TRIGGERS: AutomationTriggerType[] = [
  'pre_label_purchase',
];

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
  require_review: 'Require an operator to review the shipment. After an event for observational triggers; before the action for pre-action triggers (e.g. before label purchase).',
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
  ],
  queue_batch: [
    'shipment_created', 'shipment_updated', 'status_changed', 'return_shipment_created',
  ],
  require_review: [
    'shipment_created', 'shipment_updated', 'status_changed', 'label_purchased',
    'pickup_requested', 'pickup_confirmed', 'pickup_cancelled', 'tracking_synced',
    'return_shipment_created', 'pre_label_purchase',
  ],
  require_approval: ['pre_label_purchase'],
  block_action: ['pre_label_purchase'],
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
  if (purpose === 'require_review' && trigger === 'pre_label_purchase') return 'guardrail';
  return purposeToProcessType(purpose);
}

// Implicit primary action per purpose + (sometimes) trigger. The builder
// renders this as a fixed chip; supplementary actions can be added for
// purposes that allow them.
export function primaryActionFor(purpose: RulePurpose, trigger: AutomationTriggerType): AutomationActionType | null {
  switch (purpose) {
    case 'queue_batch': return 'mark_ready_for_batch';
    case 'require_review':
      return trigger === 'pre_label_purchase' ? 'require_review_before_action' : 'mark_review_needed';
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

export function conditionFieldsForTrigger(trigger: AutomationTriggerType): AutomationConditionField[] {
  switch (trigger) {
    case 'pre_label_purchase':
      return ['mode', 'sourceType', 'carrier', 'serviceLevel', 'addressValidationState', 'selectedRateCost'];
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

function getShipmentFieldValue(shipment: Shipment, field: AutomationConditionField): any {
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
    default: return null;
  }
}

function evaluateCondition(shipment: Shipment, condition: AutomationCondition): boolean {
  const actual = getShipmentFieldValue(shipment, condition.field);
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

export function evaluateRule(rule: AutomationRule, shipment: Shipment): RuleEvaluation {
  if (!rule.conditions || rule.conditions.length === 0) return { matched: true };
  for (let i = 0; i < rule.conditions.length; i++) {
    if (!evaluateCondition(shipment, rule.conditions[i])) {
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
): RuleEvaluationResult {
  const now = new Date().toISOString();
  let mergedUpdates: Partial<Shipment> = {};
  const logs: AutomationLogEntry[] = [];
  const evaluations: { rule: AutomationRule; evaluation: RuleEvaluation }[] = [];
  let workingShipment = shipment;
  for (const rule of rules) {
    // Phase 3 correction #3 — runAutomation is the post-event path. Guardrail
    // rules are evaluated by `evaluateGuardrails` only; they never fire here,
    // so a guardrail rule cannot accidentally double as a post-event flag.
    if (!isObservationalRule(rule, trigger)) continue;
    const evalResult = evaluateRule(rule, workingShipment);
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
  for (const rule of rules) {
    // Phase 3 correction #4 — accept rules whose ruleType is 'guardrail'
    // OR whose effective process type is guardrail (purpose='require_review'
    // on a pre-action trigger). isGuardrailRule covers the former; we
    // additionally pick up purpose-driven review-on-pre-action rules here so
    // legacy and new rule shapes both work.
    if (!ruleTriggerMatches(rule, trigger)) continue;
    const isGuardrail = isGuardrailRule(rule, trigger)
      || (rule.purpose === 'require_review' && trigger === 'pre_label_purchase');
    if (!isGuardrail) continue;
    const evaluation = evaluateRule(rule, subject);
    if (!evaluation.matched) continue;
    const blocking = rule.actions.some(a => a.type === 'block_unless_approved');
    const approvalRequested = rule.actions.some(a => a.type === 'require_approval');
    const reviewRequested = rule.actions.some(a => a.type === 'require_review_before_action')
      || (rule.purpose === 'require_review' && trigger === 'pre_label_purchase');
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
};

export function getTriggerTitle(t: AutomationTriggerType): string { return TRIGGER_LABELS_TITLECASE[t]; }

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
