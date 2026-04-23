import React, { useState } from 'react';
import type { AutomationRule, AutomationLogEntry, AutomationTriggerType, AutomationCondition, AutomationAction, AutomationActionType, AutomationConditionField, AutomationConditionOp } from '../../types';
import { TRIGGER_LABELS, CONDITION_FIELD_LABELS, ACTION_LABELS } from '../../shipping/automationEngine';

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

const TRIGGERS: AutomationTriggerType[] = [
  'shipment_created', 'shipment_updated', 'status_changed', 'label_purchased',
  'pickup_requested', 'pickup_confirmed', 'pickup_cancelled', 'tracking_synced', 'return_shipment_created',
];

const FIELDS: AutomationConditionField[] = [
  'mode', 'status', 'sourceType', 'carrier', 'serviceLevel',
  'addressValidationState', 'hasLabel', 'hasPickup', 'shippingCost',
];

const OPS: AutomationConditionOp[] = ['eq', 'neq', 'in', 'notIn', 'gt', 'gte', 'lt', 'lte', 'truthy', 'falsy'];

const ACTION_TYPES: AutomationActionType[] = [
  'add_flag', 'add_internal_note', 'mark_review_needed', 'mark_ready_for_batch', 'set_priority',
];

function blankRule(currentUser: string): AutomationRule {
  const now = new Date().toISOString();
  return {
    id: `rule-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name: '',
    enabled: true,
    trigger: 'shipment_created',
    conditions: [],
    actions: [],
    description: '',
    createdAt: now, updatedAt: now,
    createdBy: currentUser, updatedBy: currentUser,
    runCount: 0, matchCount: 0,
  };
}

export default function AutomationRules({ rules, logs, canManage, canViewResults, currentUser, onAdd, onUpdate, onDelete }: Props) {
  const [editing, setEditing] = useState<AutomationRule | null>(null);
  const [creating, setCreating] = useState(false);
  const [showLogs, setShowLogs] = useState(false);

  const target = creating ? editing : null;

  function startCreate() {
    setEditing(blankRule(currentUser));
    setCreating(true);
  }

  function startEdit(rule: AutomationRule) {
    setEditing({ ...rule, conditions: [...rule.conditions], actions: [...rule.actions] });
    setCreating(false);
  }

  function cancelEdit() { setEditing(null); setCreating(false); }

  function saveRule() {
    if (!editing) return;
    if (!editing.name.trim()) return;
    if (creating) {
      onAdd(editing);
    } else {
      onUpdate(editing.id, {
        name: editing.name, enabled: editing.enabled, trigger: editing.trigger,
        conditions: editing.conditions, actions: editing.actions, description: editing.description,
        updatedBy: currentUser,
      });
    }
    setEditing(null);
    setCreating(false);
  }

  function updateField<K extends keyof AutomationRule>(key: K, value: AutomationRule[K]) {
    if (!editing) return;
    setEditing({ ...editing, [key]: value });
  }

  function addCondition() {
    if (!editing) return;
    setEditing({ ...editing, conditions: [...editing.conditions, { field: 'status', op: 'eq', value: '' }] });
  }
  function updateCondition(idx: number, patch: Partial<AutomationCondition>) {
    if (!editing) return;
    const next = editing.conditions.map((c, i) => i === idx ? { ...c, ...patch } : c);
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

  return (
    <div className="space-y-6">
      <div className="bg-white rounded-2xl border border-slate-200 p-6">
        <div className="flex items-start justify-between gap-3 mb-2">
          <div>
            <p className="text-[10px] font-black text-primary uppercase tracking-widest flex items-center gap-1.5">
              <span className="material-symbols-outlined text-sm">bolt</span>Shipping Automation Rules
            </p>
            <p className="text-xs text-slate-500 mt-1 max-w-2xl">
              Operator-trustworthy rule engine. Rules can flag shipments, add internal notes, mark review-needed,
              queue ready-for-batch, and set priority. They cannot purchase labels, change status, or perform
              irreversible carrier operations. All matches are logged.
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
                Trigger
                <select value={editing.trigger} onChange={e => updateField('trigger', e.target.value as AutomationTriggerType)}
                  className="mt-1 w-full text-xs border border-slate-200 rounded-lg px-2 py-1.5">
                  {TRIGGERS.map(t => <option key={t} value={t}>{TRIGGER_LABELS[t]}</option>)}
                </select>
              </label>
            </div>
            <label className="text-xs font-bold text-slate-700 block">
              Description (optional)
              <input value={editing.description || ''} onChange={e => updateField('description', e.target.value)}
                className="mt-1 w-full text-xs border border-slate-200 rounded-lg px-2 py-1.5" />
            </label>

            <div>
              <div className="flex items-center justify-between mb-2">
                <p className="text-[10px] font-black text-slate-500 uppercase tracking-widest">Conditions (ALL must match)</p>
                <button onClick={addCondition} className="text-[10px] font-black uppercase tracking-widest text-primary hover:underline">+ Add Condition</button>
              </div>
              {editing.conditions.length === 0 && (
                <p className="text-xs text-slate-400 italic">No conditions — rule will match every shipment of this trigger.</p>
              )}
              <div className="space-y-2">
                {editing.conditions.map((c, i) => (
                  <div key={i} className="flex items-center gap-2 bg-white border border-slate-200 rounded-lg p-2">
                    <select value={c.field} onChange={e => updateCondition(i, { field: e.target.value as AutomationConditionField })}
                      className="text-xs border border-slate-200 rounded px-1.5 py-1">
                      {FIELDS.map(f => <option key={f} value={f}>{CONDITION_FIELD_LABELS[f]}</option>)}
                    </select>
                    <select value={c.op} onChange={e => updateCondition(i, { op: e.target.value as AutomationConditionOp })}
                      className="text-xs border border-slate-200 rounded px-1.5 py-1">
                      {OPS.map(op => <option key={op} value={op}>{op}</option>)}
                    </select>
                    {c.op !== 'truthy' && c.op !== 'falsy' && (
                      <input value={c.value ?? ''} onChange={e => updateCondition(i, { value: c.op === 'in' || c.op === 'notIn' ? e.target.value.split(',').map(s => s.trim()) : (c.field === 'shippingCost' ? Number(e.target.value) : e.target.value) })}
                        className="flex-1 text-xs border border-slate-200 rounded px-1.5 py-1"
                        placeholder={c.op === 'in' || c.op === 'notIn' ? 'comma,separated,values' : 'value'} />
                    )}
                    <button onClick={() => removeCondition(i)} className="text-rose-500 hover:text-rose-700 text-xs">×</button>
                  </div>
                ))}
              </div>
            </div>

            <div>
              <div className="flex items-center justify-between mb-2">
                <p className="text-[10px] font-black text-slate-500 uppercase tracking-widest">Actions</p>
                <button onClick={addAction} className="text-[10px] font-black uppercase tracking-widest text-primary hover:underline">+ Add Action</button>
              </div>
              {editing.actions.length === 0 && (
                <p className="text-xs text-rose-500 italic">At least one action is required.</p>
              )}
              <div className="space-y-2">
                {editing.actions.map((a, i) => (
                  <div key={i} className="flex items-center gap-2 bg-white border border-slate-200 rounded-lg p-2">
                    <select value={a.type} onChange={e => updateAction(i, { type: e.target.value as AutomationActionType, params: {} })}
                      className="text-xs border border-slate-200 rounded px-1.5 py-1">
                      {ACTION_TYPES.map(at => <option key={at} value={at}>{ACTION_LABELS[at]}</option>)}
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
                        <option value="normal">normal</option>
                        <option value="high">high</option>
                        <option value="urgent">urgent</option>
                      </select>
                    )}
                    <button onClick={() => removeAction(i)} className="text-rose-500 hover:text-rose-700 text-xs">×</button>
                  </div>
                ))}
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
                <div key={rule.id} className="border border-slate-200 rounded-xl p-3 flex items-start justify-between gap-3 bg-white">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-bold text-slate-700">{rule.name}</span>
                      <span className={`px-1.5 py-0.5 text-[8px] font-black uppercase tracking-widest rounded ${rule.enabled ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-100 text-slate-500'}`}>{rule.enabled ? 'Enabled' : 'Disabled'}</span>
                      <span className="px-1.5 py-0.5 text-[8px] font-black uppercase tracking-widest rounded bg-indigo-50 text-indigo-700 border border-indigo-100">{TRIGGER_LABELS[rule.trigger]}</span>
                    </div>
                    <p className="text-[11px] text-slate-500 mt-1">
                      {rule.conditions.length} condition{rule.conditions.length === 1 ? '' : 's'}, {rule.actions.length} action{rule.actions.length === 1 ? '' : 's'}
                      {typeof rule.matchCount === 'number' && rule.matchCount > 0 && ` · matched ${rule.matchCount}×`}
                      {rule.lastRunAt && ` · last run ${new Date(rule.lastRunAt).toLocaleString()}`}
                    </p>
                    {rule.description && <p className="text-[11px] text-slate-400 mt-0.5 italic">{rule.description}</p>}
                  </div>
                  {canManage && (
                    <div className="flex items-center gap-1">
                      <button onClick={() => onUpdate(rule.id, { enabled: !rule.enabled, updatedBy: currentUser })}
                        className="text-[10px] font-black uppercase tracking-widest text-slate-500 hover:text-primary px-2 py-1">
                        {rule.enabled ? 'Disable' : 'Enable'}
                      </button>
                      <button onClick={() => startEdit(rule)} className="text-[10px] font-black uppercase tracking-widest text-primary hover:underline px-2 py-1">Edit</button>
                      <button onClick={() => { if (confirm(`Delete rule "${rule.name}"?`)) onDelete(rule.id); }}
                        className="text-[10px] font-black uppercase tracking-widest text-rose-500 hover:text-rose-700 px-2 py-1">Delete</button>
                    </div>
                  )}
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
                <span className="material-symbols-outlined text-sm">history</span>Automation Results
              </p>
              <p className="text-xs text-slate-500 mt-1">Auditable execution log — every rule match is recorded with the shipment, trigger, and actions applied.</p>
            </div>
            <button onClick={() => setShowLogs(s => !s)} className="text-[10px] font-black uppercase tracking-widest text-primary hover:underline">
              {showLogs ? 'Hide' : 'Show'} ({logs.length})
            </button>
          </div>
          {showLogs && (
            logs.length === 0 ? (
              <p className="text-xs text-slate-400 italic mt-2">No automation runs recorded yet.</p>
            ) : (
              <div className="mt-2 max-h-80 overflow-y-auto divide-y divide-slate-100">
                {logs.map(l => (
                  <div key={l.id} className="py-2 text-xs">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-bold text-slate-700">{l.ruleName}</span>
                      <span className="text-slate-400">→</span>
                      <span className="text-slate-700">{l.shipmentNumber}</span>
                      <span className="px-1.5 py-0.5 text-[8px] font-black uppercase tracking-widest rounded bg-indigo-50 text-indigo-700">{TRIGGER_LABELS[l.trigger]}</span>
                    </div>
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
    </div>
  );
}
