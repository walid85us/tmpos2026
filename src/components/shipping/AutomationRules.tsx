import React, { useMemo, useState } from 'react';
import type {
  AutomationRule, AutomationLogEntry, AutomationTriggerType,
  AutomationCondition, AutomationAction, AutomationActionType,
  AutomationConditionField, AutomationConditionOp,
  AutomationRuleProcessType, RulePurpose, Shipment,
} from '../../types';
import {
  FIELD_DESCRIPTORS, OPERATORS_BY_KIND, getFieldDescriptor, getOperatorChoice,
  describeRule, getTriggerTitle, getRuleProcessType,
  PURPOSE_LABELS, PURPOSE_DESCRIPTIONS,
  triggersForPurpose, actionsForPurpose, primaryActionFor, supplementaryActionsFor,
  conditionFieldsForTrigger, getRulePurpose, effectiveProcessType,
} from '../../shipping/automationEngine';

interface Props {
  rules: AutomationRule[];
  logs: AutomationLogEntry[];
  shipments?: Shipment[];
  canManage: boolean;
  canViewResults: boolean;
  currentUser: string;
  onAdd: (rule: AutomationRule) => void;
  onUpdate: (id: string, updates: Partial<AutomationRule>) => void;
  onDelete: (id: string) => void;
  // Phase 3 correction #3 — execution history shipment numbers are clickable.
  // Caller wires this to ShippingCenter to open the shipment detail panel.
  onOpenShipment?: (shipmentId: string) => void;
}

const TRIGGER_LABELS_BY_TYPE: Record<AutomationTriggerType, string> = {
  shipment_created: 'A shipment is created',
  shipment_updated: 'A shipment is edited',
  status_changed: 'Shipment status changes',
  label_purchased: 'A carrier label is purchased',
  pickup_requested: 'A pickup is requested',
  pickup_confirmed: 'A pickup is confirmed',
  pickup_cancelled: 'A pickup is cancelled',
  tracking_synced: 'Tracking is synced',
  return_shipment_created: 'A return shipment is created',
  pre_label_purchase: 'A carrier label is about to be purchased',
};

const ACTION_LABELS_BY_TYPE: Record<AutomationActionType, string> = {
  add_flag: 'Add a flag to the shipment',
  add_internal_note: 'Add an internal note',
  mark_review_needed: 'Mark the shipment for review',
  mark_ready_for_batch: 'Queue for Batch Labels',
  set_priority: 'Set shipment priority',
  require_approval: 'Require operator approval before the action proceeds',
  block_unless_approved: 'Block the action unless approved or overridden',
  require_review_before_action: 'Require operator review before the action proceeds',
};

const ACTION_HELPER_BY_TYPE: Record<AutomationActionType, string> = {
  add_flag: 'Adds a label chip to the shipment. Visible on the row and filterable via the Flagged outcome chip.',
  add_internal_note: 'Appends a rule-sourced note to the shipment\u2019s internal notes log. Visible in the Automation Outcomes panel.',
  mark_review_needed: 'Pauses the shipment for a human check. Adds a Review Needed badge on the row, surfaces in the Review Needed filter, and requires an operator to Resolve from the detail view.',
  mark_ready_for_batch: 'Queues the shipment for the Batch Labels workflow. Surfaces a Ready for Batch badge and the corresponding outcome chip on the shipment list.',
  set_priority: 'Sets the shipment priority. High/Urgent show as a colored badge on the row and are findable via the High Priority outcome chip.',
  require_approval: 'Pauses the action and asks an authorized operator to approve before it proceeds. Operators with Approve Automation Exceptions can clear it from the shipment detail view.',
  block_unless_approved: 'Halts the action unless an authorized operator approves or overrides. Approve requires Approve Automation Exceptions; override requires the stricter Override Automation Guardrails permission.',
  require_review_before_action: 'Pauses the action until an operator acknowledges a review. Any operator can clear the review from the pre-action modal — no approver permission required.',
};

function blankRule(currentUser: string, purpose: RulePurpose = 'flag_note'): AutomationRule {
  const now = new Date().toISOString();
  const triggers = triggersForPurpose(purpose);
  const trigger: AutomationTriggerType = triggers[0];
  const ruleType = effectiveProcessType(purpose, trigger);
  const primary = primaryActionFor(purpose, trigger);
  // flag_note has no implicit primary — start with one supplementary action so
  // the rule is saveable; the operator can swap or add more.
  const initialAction: AutomationAction = primary
    ? { type: primary, params: {} }
    : { type: 'add_flag', params: {} };
  return {
    id: `rule-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name: '',
    enabled: true,
    ruleType,
    purpose,
    trigger,
    conditions: [],
    actions: [initialAction],
    description: '',
    createdAt: now, updatedAt: now,
    createdBy: currentUser, updatedBy: currentUser,
    runCount: 0, matchCount: 0,
  };
}

// Reset op + value to safe defaults whenever a condition's field changes,
// so we never leave a boolean field paired with a numeric value (the exact
// "Has Label eq 6" footgun this correction pass exists to remove).
function defaultConditionForField(field: AutomationConditionField): AutomationCondition {
  const desc = getFieldDescriptor(field);
  if (!desc) return { field, op: 'eq', value: '' };
  const ops = OPERATORS_BY_KIND[desc.kind];
  const op = ops[0].op;
  let value: any = '';
  if (desc.kind === 'boolean') value = undefined;
  else if (desc.kind === 'number') value = 0;
  else if (desc.kind === 'enum' && desc.options && desc.options.length > 0) value = desc.options[0].value;
  return { field, op, value };
}

function defaultValueForOperator(field: AutomationConditionField, op: AutomationConditionOp): any {
  const desc = getFieldDescriptor(field);
  if (!desc) return '';
  const choice = getOperatorChoice(desc.kind, op);
  if (!choice || !choice.needsValue) return undefined;
  if (choice.multiValue) {
    if (desc.kind === 'enum' && desc.options && desc.options.length > 0) return [desc.options[0].value];
    return [];
  }
  if (desc.kind === 'enum' && desc.options && desc.options.length > 0) return desc.options[0].value;
  if (desc.kind === 'number') return 0;
  return '';
}

export default function AutomationRules({ rules, logs, shipments, canManage, canViewResults, currentUser, onAdd, onUpdate, onDelete, onOpenShipment }: Props) {
  const [editing, setEditing] = useState<AutomationRule | null>(null);
  const [creating, setCreating] = useState(false);
  const [showLogs, setShowLogs] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<AutomationRule | null>(null);

  const liveSummary = useMemo(() => editing ? describeRule(editing) : '', [editing]);
  const editingPurpose: RulePurpose = editing ? getRulePurpose(editing) : 'flag_note';
  const editingType: AutomationRuleProcessType = editing
    ? effectiveProcessType(editingPurpose, editing.trigger)
    : 'observational';
  const allowedTriggers = useMemo(() => triggersForPurpose(editingPurpose), [editingPurpose]);
  const allowedActions = useMemo(
    () => editing ? actionsForPurpose(editingPurpose, editing.trigger) : [],
    [editingPurpose, editing?.trigger],
  );
  const allowedFields = useMemo(
    () => editing ? conditionFieldsForTrigger(editing.trigger) : [],
    [editing?.trigger],
  );
  const primaryAction = useMemo(
    () => editing ? primaryActionFor(editingPurpose, editing.trigger) : null,
    [editingPurpose, editing?.trigger],
  );
  const supplementaryAllowed = useMemo(() => supplementaryActionsFor(editingPurpose), [editingPurpose]);
  // Index shipments by id for O(1) lookup when rendering history outcome chips.
  const shipmentsById = useMemo(() => {
    const m = new Map<string, Shipment>();
    (shipments || []).forEach(s => m.set(s.id, s));
    return m;
  }, [shipments]);

  function startCreate() { setEditing(blankRule(currentUser, 'flag_note')); setCreating(true); }
  function startEdit(rule: AutomationRule) {
    // Phase 3 correction #4 — derive purpose for legacy rules so the
    // purpose-first builder always has a concrete value to edit against.
    const purpose = getRulePurpose(rule);
    setEditing({
      ...rule,
      purpose,
      ruleType: effectiveProcessType(purpose, rule.trigger),
      conditions: rule.conditions.map(c => ({ ...c })),
      actions: rule.actions.map(a => ({ ...a, params: { ...(a.params || {}) } })),
    });
    setCreating(false);
  }
  function cancelEdit() { setEditing(null); setCreating(false); }

  // Phase 3 correction #4 — switching purpose resets trigger to the first
  // compatible option, drops conditions on now-invalid fields, and rebuilds
  // actions to the new purpose's primary (+ keeps any still-allowed
  // supplementary action).
  function changePurpose(nextPurpose: RulePurpose) {
    if (!editing) return;
    const triggers = triggersForPurpose(nextPurpose);
    const trigger = triggers.includes(editing.trigger) ? editing.trigger : triggers[0];
    const allowedFieldSet = new Set(conditionFieldsForTrigger(trigger));
    const conditions = editing.conditions.filter(c => allowedFieldSet.has(c.field));
    const primary = primaryActionFor(nextPurpose, trigger);
    const supp = new Set(supplementaryActionsFor(nextPurpose));
    const keptSupp = editing.actions.filter(a => supp.has(a.type));
    const actions: AutomationAction[] = primary
      ? [{ type: primary, params: {} }, ...keptSupp]
      : (keptSupp.length > 0 ? keptSupp : [{ type: 'add_flag', params: {} }]);
    setEditing({
      ...editing,
      purpose: nextPurpose,
      trigger,
      ruleType: effectiveProcessType(nextPurpose, trigger),
      conditions,
      actions,
    });
  }

  // Phase 3 correction #4 — changing trigger drops conditions on
  // now-invalid fields and rebuilds the implicit primary action (which can
  // change between mark_review_needed and require_review_before_action when
  // toggling the require_review purpose between observational and pre-action
  // triggers).
  function changeTrigger(nextTrigger: AutomationTriggerType) {
    if (!editing) return;
    const allowedFieldSet = new Set(conditionFieldsForTrigger(nextTrigger));
    const conditions = editing.conditions.filter(c => allowedFieldSet.has(c.field));
    const primary = primaryActionFor(editingPurpose, nextTrigger);
    const supp = new Set(supplementaryActionsFor(editingPurpose));
    const keptSupp = editing.actions.filter(a => supp.has(a.type));
    const actions: AutomationAction[] = primary
      ? [{ type: primary, params: {} }, ...keptSupp]
      : (keptSupp.length > 0 ? keptSupp : [{ type: 'add_flag', params: {} }]);
    setEditing({
      ...editing,
      trigger: nextTrigger,
      ruleType: effectiveProcessType(editingPurpose, nextTrigger),
      conditions,
      actions,
    });
  }

  function saveRule() {
    if (!editing) return;
    if (!editing.name.trim()) return;
    if (editing.actions.length === 0) return;
    if (creating) onAdd(editing);
    else onUpdate(editing.id, {
      name: editing.name, enabled: editing.enabled, ruleType: editing.ruleType, purpose: editing.purpose,
      trigger: editing.trigger,
      conditions: editing.conditions, actions: editing.actions, description: editing.description,
      updatedBy: currentUser,
    });
    setEditing(null); setCreating(false);
  }

  function updateField<K extends keyof AutomationRule>(key: K, value: AutomationRule[K]) {
    if (!editing) return;
    setEditing({ ...editing, [key]: value });
  }

  function addCondition() {
    if (!editing) return;
    // Phase 3 correction #4 — default to the first field allowed by the
    // current trigger so the new row never starts in an invalid state (e.g.
    // adding a 'status' condition on a pre_label_purchase trigger that does
    // not expose status).
    const fields = conditionFieldsForTrigger(editing.trigger);
    const firstField = (fields[0] || 'status') as AutomationConditionField;
    setEditing({ ...editing, conditions: [...editing.conditions, defaultConditionForField(firstField)] });
  }
  function updateConditionField(idx: number, field: AutomationConditionField) {
    if (!editing) return;
    const next = editing.conditions.map((c, i) => i === idx ? defaultConditionForField(field) : c);
    setEditing({ ...editing, conditions: next });
  }
  function updateConditionOp(idx: number, op: AutomationConditionOp) {
    if (!editing) return;
    const next = editing.conditions.map((c, i) => {
      if (i !== idx) return c;
      return { ...c, op, value: defaultValueForOperator(c.field, op) };
    });
    setEditing({ ...editing, conditions: next });
  }
  function updateConditionValue(idx: number, value: any) {
    if (!editing) return;
    const next = editing.conditions.map((c, i) => i === idx ? { ...c, value } : c);
    setEditing({ ...editing, conditions: next });
  }
  function removeCondition(idx: number) {
    if (!editing) return;
    setEditing({ ...editing, conditions: editing.conditions.filter((_, i) => i !== idx) });
  }

  function addAction() {
    if (!editing) return;
    // Phase 3 correction #4 — only purposes with a supplementary set can add
    // additional actions. Pick the first supplementary type not already on the
    // rule, so the operator gets a useful default rather than a duplicate.
    const supp = supplementaryActionsFor(editingPurpose);
    if (supp.length === 0) return;
    const taken = new Set(editing.actions.map(a => a.type));
    const next = supp.find(t => !taken.has(t)) || supp[0];
    setEditing({ ...editing, actions: [...editing.actions, { type: next, params: {} }] });
  }
  function updateAction(idx: number, patch: Partial<AutomationAction>) {
    if (!editing) return;
    const next = editing.actions.map((a, i) => i === idx ? { ...a, ...patch } : a);
    setEditing({ ...editing, actions: next });
  }
  function removeAction(idx: number) {
    if (!editing) return;
    setEditing({ ...editing, actions: editing.actions.filter((_, i) => i !== idx) });
  }

  // Phase 3 correction — execution history is a matches-only audit log.
  // Non-matches are surfaced through each rule's `lastEvaluation` snapshot
  // on its card (matched? / failed condition) rather than as log entries,
  // so the log truthfully represents only actions the engine actually took.
  const matchedLogs = useMemo(() => logs.filter(l => l.matched), [logs]);

  return (
    <div className="space-y-6">
      <div className="bg-white rounded-2xl border border-slate-200 p-6">
        <div className="flex items-start justify-between gap-3 mb-2">
          <div>
            <p className="text-[10px] font-black text-primary uppercase tracking-widest flex items-center gap-1.5">
              <span className="material-symbols-outlined text-sm">bolt</span>Shipping Automation Rules
            </p>
            <p className="text-xs text-slate-500 mt-1 max-w-2xl">
              Build rules in plain language. Pick a trigger, add the conditions you want to match, and choose
              the action. Rules can flag, note, queue for batch, prioritize, or mark for review — they cannot
              purchase labels, change status, or take any other irreversible action.
            </p>
          </div>
          {canManage && !editing && (
            <button onClick={startCreate} className="px-3 py-1.5 text-[10px] font-black uppercase tracking-widest rounded-lg bg-primary text-white hover:opacity-90 flex items-center gap-1">
              <span className="material-symbols-outlined text-sm">add</span>New Rule
            </button>
          )}
        </div>

        {editing && (
          <div className="mt-4 border border-indigo-200 rounded-xl p-4 bg-indigo-50/40 space-y-4">
            {/* Phase 3 correction #4 — purpose-first selector. The operator
                picks WHAT they want to happen, and the builder derives the
                trigger options, condition fields, and primary action from
                that. Five purposes: Flag/Note (observational tagging),
                Queue for Batch (route to batch labels), Require Review
                (mark for human check; on pre-label trigger this gates the
                purchase), Require Approval (gates pre-action with approver
                permission), Block Action (gates pre-action and only an
                override can proceed). */}
            <div>
              <p className="text-[10px] font-black text-slate-500 uppercase tracking-widest mb-1.5">Purpose</p>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-2">
                {(['flag_note','queue_batch','require_review','require_approval','block_action'] as RulePurpose[]).map(p => {
                  const accent = p === 'block_action'
                    ? (editingPurpose === p ? 'border-rose-400' : 'border-slate-200')
                    : (p === 'require_approval' || p === 'require_review')
                      ? (editingPurpose === p ? 'border-amber-400' : 'border-slate-200')
                      : (editingPurpose === p ? 'border-indigo-400' : 'border-slate-200');
                  return (
                    <label key={p} className={`cursor-pointer border rounded-lg p-2.5 bg-white ${accent}`}>
                      <span className="flex items-center gap-2">
                        <input type="radio" name="rulePurpose" checked={editingPurpose === p} onChange={() => changePurpose(p)} />
                        <span className="text-xs font-bold text-slate-700">{PURPOSE_LABELS[p]}</span>
                      </span>
                      <span className="block text-[11px] text-slate-500 mt-1 ml-5 leading-snug">
                        {PURPOSE_DESCRIPTIONS[p]}
                      </span>
                    </label>
                  );
                })}
              </div>
              <p className="text-[10px] text-slate-500 mt-2 leading-snug">
                Process type derived from purpose + trigger:
                <span className={`ml-1 px-1.5 py-0.5 text-[8px] font-black uppercase tracking-widest rounded border ${editingType === 'guardrail' ? 'bg-amber-50 text-amber-700 border-amber-200' : 'bg-slate-50 text-slate-600 border-slate-200'}`}>{editingType}</span>
              </p>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <label className="text-xs font-bold text-slate-700">
                Rule Name
                <input value={editing.name} onChange={e => updateField('name', e.target.value)}
                  className="mt-1 w-full text-xs border border-slate-200 rounded-lg px-2 py-1.5"
                  placeholder={editingType === 'guardrail' ? 'e.g. Block high-cost express labels' : 'e.g. Flag high-value international shipments'} />
              </label>
              <label className="text-xs font-bold text-slate-700">
                {editingType === 'guardrail' ? 'Evaluate this rule when…' : 'Run this rule when…'}
                <select value={editing.trigger} onChange={e => changeTrigger(e.target.value as AutomationTriggerType)}
                  className="mt-1 w-full text-xs border border-slate-200 rounded-lg px-2 py-1.5">
                  {allowedTriggers.map(t => <option key={t} value={t}>{TRIGGER_LABELS_BY_TYPE[t]}</option>)}
                </select>
              </label>
            </div>
            <label className="text-xs font-bold text-slate-700 block">
              Description (optional)
              <input value={editing.description || ''} onChange={e => updateField('description', e.target.value)}
                className="mt-1 w-full text-xs border border-slate-200 rounded-lg px-2 py-1.5" />
            </label>

            <div className="bg-white border border-indigo-100 rounded-lg p-3">
              <p className="text-[9px] font-black text-indigo-600 uppercase tracking-widest">Plain-language summary</p>
              <p className="text-sm text-slate-700 mt-1 leading-relaxed">{liveSummary}</p>
              {editing.actions.length === 0 && (
                <p className="text-[11px] text-rose-600 mt-1">A rule must have at least one action before it can be saved.</p>
              )}
            </div>

            <div>
              <div className="flex items-center justify-between mb-2">
                <p className="text-[10px] font-black text-slate-500 uppercase tracking-widest">Conditions <span className="font-normal text-slate-400 normal-case">(all must match)</span></p>
                <button onClick={addCondition} className="text-[10px] font-black uppercase tracking-widest text-primary hover:underline">+ Add Condition</button>
              </div>
              {editing.conditions.length === 0 && (
                <p className="text-xs text-slate-400 italic">No conditions — the rule will run every time the trigger fires.</p>
              )}
              <div className="space-y-2">
                {editing.conditions.map((c, i) => {
                  const desc = getFieldDescriptor(c.field);
                  const ops = desc ? OPERATORS_BY_KIND[desc.kind] : [];
                  const choice = desc ? getOperatorChoice(desc.kind, c.op) : undefined;
                  return (
                    <div key={i} className="flex items-start gap-2 bg-white border border-slate-200 rounded-lg p-2 flex-wrap md:flex-nowrap">
                      <select value={c.field} onChange={e => updateConditionField(i, e.target.value as AutomationConditionField)}
                        className="text-xs border border-slate-200 rounded px-1.5 py-1">
                        {/* Phase 3 correction #4 — only fields the matrix
                            allows for the current trigger are offered, so the
                            operator can never compose a meaningless condition
                            (e.g. selectedRateCost outside pre_label_purchase). */}
                        {FIELD_DESCRIPTORS.filter(f => allowedFields.includes(f.field)).map(f => (
                          <option key={f.field} value={f.field}>{f.label}</option>
                        ))}
                      </select>
                      <select value={c.op} onChange={e => updateConditionOp(i, e.target.value as AutomationConditionOp)}
                        className="text-xs border border-slate-200 rounded px-1.5 py-1">
                        {ops.map(o => <option key={o.op} value={o.op}>{o.label}</option>)}
                      </select>
                      {choice?.needsValue && (
                        <ValueInput descriptor={desc!} choice={choice} value={c.value} onChange={v => updateConditionValue(i, v)} />
                      )}
                      <button onClick={() => removeCondition(i)} className="text-rose-500 hover:text-rose-700 text-xs ml-auto px-1">×</button>
                    </div>
                  );
                })}
              </div>
            </div>

            <div>
              <div className="flex items-center justify-between mb-2">
                <p className="text-[10px] font-black text-slate-500 uppercase tracking-widest">Actions</p>
                {/* Phase 3 correction #4 — only purposes that allow
                    supplementary actions show the "+ Add" affordance.
                    Pre-action purposes (review/approval/block) are atomic. */}
                {supplementaryAllowed.length > 0 && (
                  <button onClick={addAction} className="text-[10px] font-black uppercase tracking-widest text-primary hover:underline">+ Add Supplementary Action</button>
                )}
              </div>
              <div className="space-y-2">
                {editing.actions.map((a, i) => {
                  // Phase 3 correction #4 — the action at index 0 is the
                  // implicit primary action when the purpose has one. We
                  // render it as a fixed chip with only its params editable
                  // (no type swap, no remove). Other actions are
                  // supplementary; their type can be swapped within the
                  // purpose's supplementary set and they can be removed.
                  const isPrimary = primaryAction != null && i === 0 && a.type === primaryAction;
                  return (
                  <div key={i} className={`bg-white border rounded-lg p-2 ${isPrimary ? 'border-indigo-200 bg-indigo-50/30' : 'border-slate-200'}`}>
                    <div className="flex items-center gap-2 flex-wrap">
                      {isPrimary ? (
                        <span className="text-[10px] font-black uppercase tracking-widest px-1.5 py-1 rounded bg-indigo-100 text-indigo-700 border border-indigo-200">
                          {ACTION_LABELS_BY_TYPE[a.type]}
                        </span>
                      ) : (
                        <select value={a.type} onChange={e => updateAction(i, { type: e.target.value as AutomationActionType, params: {} })}
                          className="text-xs border border-slate-200 rounded px-1.5 py-1">
                          {supplementaryAllowed.map(at => <option key={at} value={at}>{ACTION_LABELS_BY_TYPE[at]}</option>)}
                        </select>
                      )}
                      {a.type === 'add_flag' && (
                        <input value={a.params?.flag || ''} onChange={e => updateAction(i, { params: { ...(a.params || {}), flag: e.target.value } })}
                          className="flex-1 text-xs border border-slate-200 rounded px-1.5 py-1" placeholder="Flag label (e.g. high_value)" />
                      )}
                      {a.type === 'add_internal_note' && (
                        <input value={a.params?.text || ''} onChange={e => updateAction(i, { params: { ...(a.params || {}), text: e.target.value } })}
                          className="flex-1 text-xs border border-slate-200 rounded px-1.5 py-1" placeholder="Note text" />
                      )}
                      {a.type === 'mark_review_needed' && (
                        <input value={a.params?.reason || ''} onChange={e => updateAction(i, { params: { ...(a.params || {}), reason: e.target.value } })}
                          className="flex-1 text-xs border border-slate-200 rounded px-1.5 py-1" placeholder="Review reason (optional)" />
                      )}
                      {(a.type === 'require_approval' || a.type === 'block_unless_approved' || a.type === 'require_review_before_action') && (
                        <input value={a.params?.reason || ''} onChange={e => updateAction(i, { params: { ...(a.params || {}), reason: e.target.value } })}
                          className="flex-1 text-xs border border-slate-200 rounded px-1.5 py-1" placeholder="Reason shown to operator (optional)" />
                      )}
                      {a.type === 'set_priority' && (
                        <select value={a.params?.priority || 'high'} onChange={e => updateAction(i, { params: { ...(a.params || {}), priority: e.target.value } })}
                          className="text-xs border border-slate-200 rounded px-1.5 py-1">
                          <option value="normal">Normal</option>
                          <option value="high">High</option>
                          <option value="urgent">Urgent</option>
                        </select>
                      )}
                      {!isPrimary && (
                        <button onClick={() => removeAction(i)} className="text-rose-500 hover:text-rose-700 text-xs ml-auto px-1">×</button>
                      )}
                    </div>
                    <p className="text-[10px] text-slate-500 mt-1.5 leading-snug">{ACTION_HELPER_BY_TYPE[a.type]}</p>
                  </div>
                  );
                })}
              </div>
            </div>

            <div className="flex items-center justify-between pt-2 border-t border-indigo-100">
              <label className="text-xs font-bold text-slate-700 flex items-center gap-2">
                <input type="checkbox" checked={editing.enabled} onChange={e => updateField('enabled', e.target.checked)} />
                Enabled
              </label>
              <div className="flex items-center gap-2">
                <button onClick={cancelEdit} className="px-3 py-1.5 text-[10px] font-black uppercase tracking-widest rounded-lg border border-slate-200 text-slate-600 hover:bg-slate-50">Cancel</button>
                <button onClick={saveRule} disabled={!editing.name.trim() || editing.actions.length === 0}
                  className="px-3 py-1.5 text-[10px] font-black uppercase tracking-widest rounded-lg bg-primary text-white disabled:opacity-40">
                  {creating ? 'Create Rule' : 'Save Changes'}
                </button>
              </div>
            </div>
          </div>
        )}

        <div className="mt-5">
          {rules.length === 0 ? (
            <div className="text-center py-8 border border-dashed border-slate-200 rounded-xl">
              <span className="material-symbols-outlined text-slate-300 text-3xl">bolt</span>
              <p className="text-xs text-slate-500 mt-2">No automation rules defined yet.</p>
            </div>
          ) : (
            <div className="space-y-2">
              {rules.map(rule => (
                <div key={rule.id} className="border border-slate-200 rounded-xl p-3 bg-white">
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-sm font-bold text-slate-700">{rule.name}</span>
                        <span className={`px-1.5 py-0.5 text-[8px] font-black uppercase tracking-widest rounded ${rule.enabled ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-100 text-slate-500'}`}>{rule.enabled ? 'Enabled' : 'Disabled'}</span>
                        {/* Phase 3 correction #3 — rule type badge so the
                            list distinguishes guardrails from observational rules at a glance. */}
                        <span className={`px-1.5 py-0.5 text-[8px] font-black uppercase tracking-widest rounded border ${getRuleProcessType(rule) === 'guardrail' ? 'bg-amber-50 text-amber-700 border-amber-200' : 'bg-slate-50 text-slate-600 border-slate-200'}`}>{getRuleProcessType(rule)}</span>
                        <span className="px-1.5 py-0.5 text-[8px] font-black uppercase tracking-widest rounded bg-indigo-50 text-indigo-700 border border-indigo-100">{getTriggerTitle(rule.trigger)}</span>
                      </div>
                      <p className="text-xs text-slate-700 mt-1 leading-relaxed">{describeRule(rule)}</p>
                      <p className="text-[11px] text-slate-400 mt-1">
                        Evaluated {rule.runCount || 0}× · matched {rule.matchCount || 0}×
                        {rule.lastRunAt && ` · last evaluated ${new Date(rule.lastRunAt).toLocaleString()}`}
                      </p>
                      {rule.lastEvaluation && (
                        <p className={`text-[11px] mt-1 ${rule.lastEvaluation.matched ? 'text-emerald-700' : 'text-amber-600'}`}>
                          {rule.lastEvaluation.matched
                            ? `✓ Last match: shipment ${rule.lastEvaluation.shipmentNumber} (${getTriggerTitle(rule.lastEvaluation.trigger)})`
                            : `Did not match shipment ${rule.lastEvaluation.shipmentNumber} — failed at: ${rule.lastEvaluation.failedConditionDescription}`}
                        </p>
                      )}
                      {rule.description && <p className="text-[11px] text-slate-400 mt-0.5 italic">{rule.description}</p>}
                    </div>
                    {canManage && (
                      <div className="flex items-center gap-1 shrink-0">
                        <button onClick={() => onUpdate(rule.id, { enabled: !rule.enabled, updatedBy: currentUser })}
                          className="text-[10px] font-black uppercase tracking-widest text-slate-500 hover:text-primary px-2 py-1">
                          {rule.enabled ? 'Disable' : 'Enable'}
                        </button>
                        <button onClick={() => startEdit(rule)} className="text-[10px] font-black uppercase tracking-widest text-primary hover:underline px-2 py-1">Edit</button>
                        <button onClick={() => setDeleteTarget(rule)}
                          className="text-[10px] font-black uppercase tracking-widest text-rose-500 hover:text-rose-700 px-2 py-1">Delete</button>
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {canViewResults && (
        <div className="bg-white rounded-2xl border border-slate-200 p-6">
          <div className="flex items-center justify-between mb-2">
            <div>
              <p className="text-[10px] font-black text-primary uppercase tracking-widest flex items-center gap-1.5">
                <span className="material-symbols-outlined text-sm">history</span>Execution History
              </p>
              <p className="text-xs text-slate-500 mt-1">
                Auditable record of every rule that fired — which shipment, which trigger, and what the rule did.
                Non-matches are not logged here to keep the audit trail truthful; see each rule's card for its
                most recent evaluation outcome (including which condition failed).
              </p>
            </div>
            <button onClick={() => setShowLogs(s => !s)} className="text-[10px] font-black uppercase tracking-widest text-primary hover:underline">
              {showLogs ? 'Hide' : 'Show'} ({matchedLogs.length})
            </button>
          </div>
          {showLogs && (
            matchedLogs.length === 0 ? (
              <p className="text-xs text-slate-400 italic mt-2">No automation matches recorded yet.</p>
            ) : (
              <div className="mt-2 max-h-96 overflow-y-auto divide-y divide-slate-100">
                {matchedLogs.map(l => {
                  // Phase 3 correction #3 — outcome-aware history. Look up the
                  // live shipment so a stale "Matched" badge doesn't claim a
                  // review-needed shipment is still pending after an operator
                  // resolved / approved / overrode it. Falls back to the log
                  // entry's own guardrail outcome if no live shipment exists.
                  const shipment = shipmentsById.get(l.shipmentId);
                  const rn = shipment?.reviewNeeded;
                  const isThisRuleReview = rn && rn.ruleId === l.ruleId;
                  let outcomeChip: { label: string; className: string } | null = null;
                  if (isThisRuleReview) {
                    if (rn?.state === 'resolved') outcomeChip = { label: 'Resolved', className: 'bg-emerald-100 text-emerald-700' };
                    else if (rn?.state === 'approved') outcomeChip = { label: 'Approved', className: 'bg-sky-100 text-sky-700' };
                    else if (rn?.state === 'overridden') outcomeChip = { label: 'Overridden', className: 'bg-amber-100 text-amber-700' };
                    else if (rn?.state === 'dismissed') outcomeChip = { label: 'Dismissed', className: 'bg-slate-100 text-slate-600' };
                    else if (rn?.kind === 'block') outcomeChip = { label: 'Blocked', className: 'bg-rose-100 text-rose-700' };
                    else if (rn?.kind === 'approval') outcomeChip = { label: 'Approval Needed', className: 'bg-amber-100 text-amber-700' };
                    else outcomeChip = { label: 'Review Needed', className: 'bg-amber-100 text-amber-700' };
                  } else if (l.guardrailOutcome) {
                    const map: Record<NonNullable<typeof l.guardrailOutcome>, { label: string; className: string }> = {
                      blocked: { label: 'Blocked', className: 'bg-rose-100 text-rose-700' },
                      approval_required: { label: 'Approval Required', className: 'bg-amber-100 text-amber-700' },
                      approved: { label: 'Approved', className: 'bg-sky-100 text-sky-700' },
                      overridden: { label: 'Overridden', className: 'bg-amber-100 text-amber-700' },
                      cleared_by_alternate_rate: { label: 'Cleared (alt rate)', className: 'bg-slate-100 text-slate-600' },
                    };
                    outcomeChip = map[l.guardrailOutcome];
                  }
                  return (
                    <div key={l.id} className="py-2 text-xs">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-bold text-slate-700">{l.ruleName}</span>
                        <span className="text-slate-400">→</span>
                        {/* Phase 3 correction #3 — clickable shipment number.
                            Wired to ShippingCenter via onOpenShipment. */}
                        {onOpenShipment ? (
                          <button onClick={() => onOpenShipment(l.shipmentId)}
                            className="text-slate-700 font-mono underline hover:text-primary">
                            {l.shipmentNumber}
                          </button>
                        ) : (
                          <span className="text-slate-700 font-mono">{l.shipmentNumber}</span>
                        )}
                        <span className="px-1.5 py-0.5 text-[8px] font-black uppercase tracking-widest rounded bg-indigo-50 text-indigo-700">{getTriggerTitle(l.trigger)}</span>
                        {l.ruleType === 'guardrail' && (
                          <span className="px-1.5 py-0.5 text-[8px] font-black uppercase tracking-widest rounded bg-amber-50 text-amber-700 border border-amber-200">Guardrail</span>
                        )}
                        <span className="px-1.5 py-0.5 text-[8px] font-black uppercase tracking-widest rounded bg-emerald-100 text-emerald-700">Matched</span>
                        {outcomeChip && (
                          <span className={`px-1.5 py-0.5 text-[8px] font-black uppercase tracking-widest rounded ${outcomeChip.className}`}>{outcomeChip.label}</span>
                        )}
                      </div>
                      {l.ruleSummary && <p className="text-[11px] text-slate-500 mt-0.5 italic">{l.ruleSummary}</p>}
                      <p className="text-[11px] text-slate-500 mt-0.5">
                        {new Date(l.timestamp).toLocaleString()} · actions: {l.actionsApplied.length === 0 ? 'none' : l.actionsApplied.join(', ')}
                      </p>
                    </div>
                  );
                })}
              </div>
            )
          )}
        </div>
      )}

      {deleteTarget && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={() => setDeleteTarget(null)}>
          <div className="bg-white rounded-2xl border border-slate-200 max-w-md w-full p-5" onClick={e => e.stopPropagation()}>
            <div className="flex items-start gap-3">
              <span className="material-symbols-outlined text-rose-500 text-2xl">delete</span>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-black text-slate-800">Delete this automation rule?</p>
                <p className="text-xs text-slate-500 mt-1">
                  You are about to delete <span className="font-bold text-slate-700">"{deleteTarget.name}"</span>.
                  This cannot be undone — the rule will stop running immediately and will not appear in execution
                  history filters going forward (past entries are preserved).
                </p>
                <p className="text-[11px] text-slate-400 mt-2 italic">{describeRule(deleteTarget)}</p>
              </div>
            </div>
            <div className="flex items-center justify-end gap-2 mt-4">
              <button onClick={() => setDeleteTarget(null)}
                className="px-3 py-1.5 text-[10px] font-black uppercase tracking-widest rounded-lg border border-slate-200 text-slate-600 hover:bg-slate-50">Cancel</button>
              <button onClick={() => { onDelete(deleteTarget.id); setDeleteTarget(null); }}
                className="px-3 py-1.5 text-[10px] font-black uppercase tracking-widest rounded-lg bg-rose-500 text-white hover:bg-rose-600">Delete Rule</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

interface ValueInputProps {
  descriptor: ReturnType<typeof getFieldDescriptor> & {};
  choice: ReturnType<typeof getOperatorChoice> & {};
  value: any;
  onChange: (v: any) => void;
}
function ValueInput({ descriptor, choice, value, onChange }: ValueInputProps) {
  if (descriptor.kind === 'number') {
    return (
      <input type="number" value={value ?? 0} onChange={e => onChange(parseFloat(e.target.value))}
        className="flex-1 min-w-[100px] text-xs border border-slate-200 rounded px-1.5 py-1"
        placeholder={descriptor.unit === 'currency' ? '0.00' : '0'} />
    );
  }
  if (descriptor.kind === 'enum' && descriptor.options) {
    if (choice.multiValue) {
      const arr: string[] = Array.isArray(value) ? value.map(String) : [];
      return (
        <div className="flex-1 min-w-[160px] flex flex-wrap gap-1">
          {descriptor.options.map(o => {
            const checked = arr.includes(o.value);
            return (
              <label key={o.value} className={`text-[10px] font-bold uppercase tracking-widest px-2 py-0.5 rounded cursor-pointer border ${checked ? 'bg-primary text-white border-primary' : 'border-slate-200 text-slate-600'}`}>
                <input type="checkbox" className="hidden" checked={checked}
                  onChange={() => onChange(checked ? arr.filter(v => v !== o.value) : [...arr, o.value])} />
                {o.label}
              </label>
            );
          })}
        </div>
      );
    }
    return (
      <select value={String(value ?? '')} onChange={e => onChange(e.target.value)}
        className="flex-1 min-w-[120px] text-xs border border-slate-200 rounded px-1.5 py-1">
        {descriptor.options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    );
  }
  // text
  if (choice.multiValue) {
    return (
      <input value={Array.isArray(value) ? value.join(', ') : ''}
        onChange={e => onChange(e.target.value.split(',').map(s => s.trim()).filter(Boolean))}
        className="flex-1 min-w-[140px] text-xs border border-slate-200 rounded px-1.5 py-1"
        placeholder="comma, separated, values" />
    );
  }
  return (
    <input value={value ?? ''} onChange={e => onChange(e.target.value)}
      className="flex-1 min-w-[140px] text-xs border border-slate-200 rounded px-1.5 py-1"
      placeholder="value" />
  );
}
