import React, { useMemo, useState } from 'react';
import type {
  AutomationRule, AutomationLogEntry, AutomationTriggerType,
  AutomationCondition, AutomationAction, AutomationActionType,
  AutomationConditionField, AutomationConditionOp,
} from '../../types';
import {
  FIELD_DESCRIPTORS, OPERATORS_BY_KIND, getFieldDescriptor, getOperatorChoice,
  describeRule, getTriggerTitle,
} from '../../shipping/automationEngine';

interface Props {
  rules: AutomationRule[];
  logs: AutomationLogEntry[];
  canManage: boolean;
  canViewResults: boolean;
  currentUser: string;
  onAdd: (rule: AutomationRule) => void;
  onUpdate: (id: string, updates: Partial<AutomationRule>) => void;
  onDelete: (id: string) => void;
}

const TRIGGERS: { value: AutomationTriggerType; label: string }[] = [
  { value: 'shipment_created', label: 'A shipment is created' },
  { value: 'shipment_updated', label: 'A shipment is edited' },
  { value: 'status_changed', label: 'Shipment status changes' },
  { value: 'label_purchased', label: 'A carrier label is purchased' },
  { value: 'pickup_requested', label: 'A pickup is requested' },
  { value: 'pickup_confirmed', label: 'A pickup is confirmed' },
  { value: 'pickup_cancelled', label: 'A pickup is cancelled' },
  { value: 'tracking_synced', label: 'Tracking is synced' },
  { value: 'return_shipment_created', label: 'A return shipment is created' },
];

const ACTION_TYPES: { value: AutomationActionType; label: string }[] = [
  { value: 'add_flag', label: 'Add a flag to the shipment' },
  { value: 'add_internal_note', label: 'Add an internal note' },
  { value: 'mark_review_needed', label: 'Mark the shipment for review' },
  { value: 'mark_ready_for_batch', label: 'Queue for Batch Labels' },
  { value: 'set_priority', label: 'Set shipment priority' },
];

function blankRule(currentUser: string): AutomationRule {
  const now = new Date().toISOString();
  return {
    id: `rule-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name: '',
    enabled: true,
    trigger: 'shipment_created',
    conditions: [],
    actions: [{ type: 'mark_ready_for_batch', params: {} }],
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

export default function AutomationRules({ rules, logs, canManage, canViewResults, currentUser, onAdd, onUpdate, onDelete }: Props) {
  const [editing, setEditing] = useState<AutomationRule | null>(null);
  const [creating, setCreating] = useState(false);
  const [showLogs, setShowLogs] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<AutomationRule | null>(null);

  const liveSummary = useMemo(() => editing ? describeRule(editing) : '', [editing]);

  function startCreate() { setEditing(blankRule(currentUser)); setCreating(true); }
  function startEdit(rule: AutomationRule) {
    setEditing({ ...rule, conditions: rule.conditions.map(c => ({ ...c })), actions: rule.actions.map(a => ({ ...a, params: { ...(a.params || {}) } })) });
    setCreating(false);
  }
  function cancelEdit() { setEditing(null); setCreating(false); }

  function saveRule() {
    if (!editing) return;
    if (!editing.name.trim()) return;
    if (editing.actions.length === 0) return;
    if (creating) onAdd(editing);
    else onUpdate(editing.id, {
      name: editing.name, enabled: editing.enabled, trigger: editing.trigger,
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
    setEditing({ ...editing, conditions: [...editing.conditions, defaultConditionForField('status')] });
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
    setEditing({ ...editing, actions: [...editing.actions, { type: 'mark_ready_for_batch', params: {} }] });
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
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <label className="text-xs font-bold text-slate-700">
                Rule Name
                <input value={editing.name} onChange={e => updateField('name', e.target.value)}
                  className="mt-1 w-full text-xs border border-slate-200 rounded-lg px-2 py-1.5"
                  placeholder="e.g. Flag high-value international shipments" />
              </label>
              <label className="text-xs font-bold text-slate-700">
                Run this rule when…
                <select value={editing.trigger} onChange={e => updateField('trigger', e.target.value as AutomationTriggerType)}
                  className="mt-1 w-full text-xs border border-slate-200 rounded-lg px-2 py-1.5">
                  {TRIGGERS.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
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
                        {FIELD_DESCRIPTORS.map(f => <option key={f.field} value={f.field}>{f.label}</option>)}
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
                <button onClick={addAction} className="text-[10px] font-black uppercase tracking-widest text-primary hover:underline">+ Add Action</button>
              </div>
              <div className="space-y-2">
                {editing.actions.map((a, i) => {
                  // Phase 3 correction — explain the operational outcome of each
                  // action so operators know exactly what happens and where to find it.
                  const helper: Record<AutomationActionType, string> = {
                    add_flag: 'Adds a label chip to the shipment. Visible on the row and filterable via the Flagged outcome chip.',
                    add_internal_note: 'Appends a rule-sourced note to the shipment\u2019s internal notes log. Visible in the Automation Outcomes panel.',
                    mark_review_needed: 'Pauses the shipment for a human check. Adds a Review Needed badge on the row, surfaces in the Review Needed filter, and requires an operator to Resolve from the detail view.',
                    mark_ready_for_batch: 'Queues the shipment for the Batch Labels workflow. Surfaces a Ready for Batch badge and the corresponding outcome chip on the shipment list.',
                    set_priority: 'Sets the shipment priority. High/Urgent show as a colored badge on the row and are findable via the High Priority outcome chip.',
                  };
                  return (
                  <div key={i} className="bg-white border border-slate-200 rounded-lg p-2">
                    <div className="flex items-center gap-2 flex-wrap">
                      <select value={a.type} onChange={e => updateAction(i, { type: e.target.value as AutomationActionType, params: {} })}
                        className="text-xs border border-slate-200 rounded px-1.5 py-1">
                        {ACTION_TYPES.map(at => <option key={at.value} value={at.value}>{at.label}</option>)}
                      </select>
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
                      {a.type === 'set_priority' && (
                        <select value={a.params?.priority || 'high'} onChange={e => updateAction(i, { params: { ...(a.params || {}), priority: e.target.value } })}
                          className="text-xs border border-slate-200 rounded px-1.5 py-1">
                          <option value="normal">Normal</option>
                          <option value="high">High</option>
                          <option value="urgent">Urgent</option>
                        </select>
                      )}
                      <button onClick={() => removeAction(i)} className="text-rose-500 hover:text-rose-700 text-xs ml-auto px-1">×</button>
                    </div>
                    <p className="text-[10px] text-slate-500 mt-1.5 leading-snug">{helper[a.type]}</p>
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
                {matchedLogs.map(l => (
                  <div key={l.id} className="py-2 text-xs">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-bold text-slate-700">{l.ruleName}</span>
                      <span className="text-slate-400">→</span>
                      <span className="text-slate-700 font-mono">{l.shipmentNumber}</span>
                      <span className="px-1.5 py-0.5 text-[8px] font-black uppercase tracking-widest rounded bg-indigo-50 text-indigo-700">{getTriggerTitle(l.trigger)}</span>
                      <span className="px-1.5 py-0.5 text-[8px] font-black uppercase tracking-widest rounded bg-emerald-100 text-emerald-700">Matched</span>
                    </div>
                    {l.ruleSummary && <p className="text-[11px] text-slate-500 mt-0.5 italic">{l.ruleSummary}</p>}
                    <p className="text-[11px] text-slate-500 mt-0.5">
                      {new Date(l.timestamp).toLocaleString()} · actions: {l.actionsApplied.length === 0 ? 'none' : l.actionsApplied.join(', ')}
                    </p>
                  </div>
                ))}
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
