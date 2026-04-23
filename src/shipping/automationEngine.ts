import type {
  AutomationRule,
  AutomationCondition,
  AutomationAction,
  AutomationTriggerType,
  AutomationLogEntry,
  Shipment,
  ShipmentInternalNote,
} from '../types';

export interface RuleEvaluationResult {
  shipmentUpdates: Partial<Shipment>;
  logs: AutomationLogEntry[];
}

function getShipmentFieldValue(shipment: Shipment, field: AutomationCondition['field']): any {
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
    default: return null;
  }
}

function evaluateCondition(shipment: Shipment, condition: AutomationCondition): boolean {
  const actual = getShipmentFieldValue(shipment, condition.field);
  const v = condition.value;
  switch (condition.op) {
    case 'eq': return actual === v;
    case 'neq': return actual !== v;
    case 'in': return Array.isArray(v) && v.includes(actual);
    case 'notIn': return Array.isArray(v) && !v.includes(actual);
    case 'gt': return typeof actual === 'number' && typeof v === 'number' && actual > v;
    case 'gte': return typeof actual === 'number' && typeof v === 'number' && actual >= v;
    case 'lt': return typeof actual === 'number' && typeof v === 'number' && actual < v;
    case 'lte': return typeof actual === 'number' && typeof v === 'number' && actual <= v;
    case 'truthy': return !!actual;
    case 'falsy': return !actual;
    default: return false;
  }
}

export function ruleMatches(rule: AutomationRule, shipment: Shipment, trigger: AutomationTriggerType): boolean {
  if (!rule.enabled) return false;
  if (rule.trigger !== trigger) return false;
  if (!rule.conditions || rule.conditions.length === 0) return true;
  return rule.conditions.every(c => evaluateCondition(shipment, c));
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
  let workingShipment = shipment;
  for (const rule of rules) {
    if (!ruleMatches(rule, workingShipment, trigger)) continue;
    const { updates, appliedLabels } = applyActionsToShipment(workingShipment, rule, rule.actions, now);
    if (Object.keys(updates).length > 0) {
      mergedUpdates = { ...mergedUpdates, ...updates };
      workingShipment = { ...workingShipment, ...updates };
    }
    logs.push({
      id: `log-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      ruleId: rule.id,
      ruleName: rule.name,
      shipmentId: shipment.id,
      shipmentNumber: shipment.shipmentNumber,
      trigger,
      matched: true,
      actionsApplied: appliedLabels,
      timestamp: now,
    });
  }
  return { shipmentUpdates: mergedUpdates, logs };
}

export const TRIGGER_LABELS: Record<AutomationTriggerType, string> = {
  shipment_created: 'Shipment Created',
  shipment_updated: 'Shipment Updated',
  status_changed: 'Status Changed',
  label_purchased: 'Label Purchased',
  pickup_requested: 'Pickup Requested',
  pickup_confirmed: 'Pickup Confirmed',
  pickup_cancelled: 'Pickup Cancelled',
  tracking_synced: 'Tracking Synced',
  return_shipment_created: 'Return Shipment Created',
};

export const CONDITION_FIELD_LABELS: Record<string, string> = {
  mode: 'Mode (provider/manual)',
  status: 'Status',
  sourceType: 'Source Type',
  carrier: 'Carrier',
  serviceLevel: 'Service Level',
  addressValidationState: 'Address Validation State',
  hasLabel: 'Has Label',
  hasPickup: 'Has Pickup',
  shippingCost: 'Shipping Cost',
};

export const ACTION_LABELS: Record<string, string> = {
  add_flag: 'Add Flag',
  add_internal_note: 'Add Internal Note',
  mark_review_needed: 'Mark Review Needed',
  mark_ready_for_batch: 'Mark Ready for Batch',
  set_priority: 'Set Priority',
};
