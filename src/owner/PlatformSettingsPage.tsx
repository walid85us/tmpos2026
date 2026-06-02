import React, { useEffect, useMemo, useState } from 'react';
import { platformDefaults, type PlatformDefaults } from './mockData';
import { pushPlatformAudit } from './platformOpsAudit';
import { useAccess } from '../context/AccessContext';
import { hasPlatformPermission, hasEffectiveFeatureAccess } from './platformPermissionsConfig';
import type { Role } from '../context/accessConfig';
import {
  SETTINGS_GROUP_ORDER,
  SETTINGS_GROUP_LABELS,
  SETTINGS_GROUP_DESCRIPTIONS,
  SETTING_ENFORCEMENT_LABELS,
  SETTING_RISK_LABELS,
  SETTINGS_TRUTH_LABELS,
  getSettingsForGroup,
  getSettingValue,
  getSettingDefault,
  isSettingModified,
  formatSettingValue,
  deriveSettingsPosture,
  type SettingsGroup,
  type SettingDefinition,
  type SettingEnforcement,
  type SettingRisk,
  type SettingPrimitive,
} from './platformOpsSettings';

const STORAGE_KEY = 'platform_settings_v1';

const ENFORCEMENT_STYLES: Record<SettingEnforcement, string> = {
  enforced: 'bg-teal-400/10 text-teal-700 border-teal-400/20',
  advisory: 'bg-blue-400/10 text-blue-700 border-blue-400/20',
  display_only: 'bg-slate-100 text-slate-500 border-slate-200',
  documentation_only: 'bg-amber-400/10 text-amber-700 border-amber-400/20',
};

const RISK_STYLES: Record<SettingRisk, string> = {
  low: 'bg-slate-100 text-slate-500 border-slate-200',
  medium: 'bg-amber-400/10 text-amber-700 border-amber-400/20',
  high: 'bg-red-500/10 text-red-700 border-red-500/30',
};

const loadSettings = (): PlatformDefaults => {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return platformDefaults;
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return platformDefaults;
    const parsed = JSON.parse(raw);
    return {
      branding: { ...platformDefaults.branding, ...(parsed.branding || {}) },
      maintenance: { ...platformDefaults.maintenance, ...(parsed.maintenance || {}) },
      security: { ...platformDefaults.security, ...(parsed.security || {}) },
      support: { ...platformDefaults.support, ...(parsed.support || {}) },
    };
  } catch {
    return platformDefaults;
  }
};

const saveSettings = (s: PlatformDefaults) => {
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
    }
  } catch { /* noop */ }
};

const setDraftValue = (settings: PlatformDefaults, def: SettingDefinition, value: SettingPrimitive): PlatformDefaults => ({
  ...settings,
  [def.group]: { ...(settings[def.group] as Record<string, SettingPrimitive>), [def.field]: value },
} as PlatformDefaults);

// Per-group change summary, registry-driven so the audit note matches the
// governance keys exactly.
const groupChangeSummary = (group: SettingsGroup, prev: PlatformDefaults, next: PlatformDefaults): string => {
  const changes: string[] = [];
  getSettingsForGroup(group).forEach(def => {
    const a = getSettingValue(prev, def);
    const b = getSettingValue(next, def);
    if (JSON.stringify(a) !== JSON.stringify(b)) {
      changes.push(`${def.key}: ${formatSettingValue(def, a)} → ${formatSettingValue(def, b)}`);
    }
  });
  return changes.join('; ');
};

const PlatformSettingsPage: React.FC = () => {
  const { session } = useAccess();
  const sessionRole = (session?.role as Role | undefined) || null;
  // Page visibility follows EFFECTIVE feature access (parent level OR any child
  // sub-permission >= view), per the locked Global Permissions Matrix rule.
  // Editing is gated separately by the exact child sub-permission.
  const canView = hasEffectiveFeatureAccess(sessionRole, 'platform_settings');
  const editGate = hasPlatformPermission(sessionRole, 'edit_platform_settings');
  const canEdit = editGate.allowed;

  const [persisted, setPersisted] = useState<PlatformDefaults>(() => loadSettings());
  const [draft, setDraft] = useState<PlatformDefaults>(persisted);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [savingGroup, setSavingGroup] = useState<SettingsGroup | null>(null);

  useEffect(() => { setDraft(persisted); }, [persisted]);

  // Governance posture reflects the PERSISTED (in-effect) settings.
  const posture = useMemo(() => deriveSettingsPosture(persisted), [persisted]);

  const dirtyGroups = useMemo<Record<SettingsGroup, boolean>>(() => {
    const out = {} as Record<SettingsGroup, boolean>;
    SETTINGS_GROUP_ORDER.forEach(g => {
      out[g] = JSON.stringify(persisted[g]) !== JSON.stringify(draft[g]);
    });
    return out;
  }, [persisted, draft]);

  const updateField = (def: SettingDefinition, value: SettingPrimitive) => {
    if (!canEdit) return;
    setDraft(d => setDraftValue(d, def, value));
  };

  const persistGroup = (group: SettingsGroup) => {
    if (!canEdit) return;
    const summary = groupChangeSummary(group, persisted, draft);
    if (!summary) return;
    const next: PlatformDefaults = { ...persisted, [group]: draft[group] } as PlatformDefaults;
    saveSettings(next);
    setPersisted(next);
    setSavedAt(new Date().toLocaleString());
    setSavingGroup(group);
    setTimeout(() => setSavingGroup(null), 1200);
    pushPlatformAudit({
      actor: 'System Owner',
      action: 'platform_setting_updated',
      target: SETTINGS_GROUP_LABELS[group],
      category: 'configuration',
      severity: 'notice',
      note: summary,
    });
  };

  if (!canView) {
    return (
      <div className="space-y-8">
        <h2 className="text-2xl font-black text-primary tracking-tight">Platform Settings</h2>
        <div className="bg-white/80 backdrop-blur-xl rounded-[2rem] border border-slate-200 p-12 text-center shadow-sm">
          <span className="material-symbols-outlined text-4xl text-slate-300">lock</span>
          <p className="mt-3 text-sm font-black text-slate-600 uppercase tracking-widest">No access</p>
          <p className="mt-1 text-xs font-bold text-slate-400">You do not have permission to view Platform Settings.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      {/* Command header */}
      <div className="flex items-end justify-between flex-wrap gap-4">
        <div className="max-w-2xl">
          <h2 className="text-2xl font-black text-primary tracking-tight">Platform Settings</h2>
          <p className="text-slate-500 font-medium">Governed platform-wide configuration with enforcement, risk, and ownership metadata.{savedAt && <span className="ml-2 text-xs text-slate-400">Last saved: {savedAt}</span>}</p>
          <div className="mt-2 flex flex-wrap gap-2">
            <TruthLabel text={SETTINGS_TRUTH_LABELS.governance} tone="slate" />
            <TruthLabel text={SETTINGS_TRUTH_LABELS.notEnforced} tone="amber" />
            <TruthLabel text={SETTINGS_TRUTH_LABELS.future} tone="slate" />
          </div>
        </div>
        {!canEdit && (
          <span className="px-4 py-2 text-[10px] font-black uppercase tracking-widest text-slate-400 bg-slate-100 border border-slate-200 rounded-xl">Read-only — Edit Platform Settings required</span>
        )}
      </div>

      {/* Governance posture */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3">
        <PostureCard label="Total Settings" value={posture.total} />
        <PostureCard label="Modified" value={posture.modified} tint="amber" />
        <PostureCard label="High Risk" value={posture.highRisk} tint="red" />
        <PostureCard label="High Risk · Modified" value={posture.highRiskModified} tint="red" />
        <PostureCard label="Documentation Only" value={posture.documentationOnly} tint="amber" />
      </div>

      {/* Registry-driven group sections */}
      {SETTINGS_GROUP_ORDER.map(group => (
        <SectionCard key={group} title={SETTINGS_GROUP_LABELS[group]} subtitle={SETTINGS_GROUP_DESCRIPTIONS[group]}>
          <div className="space-y-4">
            {getSettingsForGroup(group).map(def => (
              <SettingRow
                key={def.key}
                def={def}
                value={getSettingValue(draft, def)}
                defaultValue={getSettingDefault(def)}
                modified={isSettingModified(draft, def)}
                canEdit={canEdit}
                onChange={v => updateField(def, v)}
              />
            ))}
          </div>
          {canEdit && (
            <SaveRow group={group} dirty={dirtyGroups[group]} saving={savingGroup === group} onSave={persistGroup} />
          )}
        </SectionCard>
      ))}
    </div>
  );
};

// =============================================================================
// Presentational components
// =============================================================================

const TruthLabel: React.FC<{ text: string; tone: 'amber' | 'slate' }> = ({ text, tone }) => (
  <span className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-[10px] font-bold border ${tone === 'amber' ? 'bg-amber-400/10 text-amber-700 border-amber-400/20' : 'bg-slate-100 text-slate-500 border-slate-200'}`}>
    <span className="material-symbols-outlined text-[12px]">info</span>
    {text}
  </span>
);

const PostureCard: React.FC<{ label: string; value: number; tint?: 'amber' | 'red' }> = ({ label, value, tint }) => {
  const tintCls = tint === 'amber' ? 'text-amber-700' : tint === 'red' ? 'text-red-700' : 'text-primary';
  return (
    <div className="bg-white/80 backdrop-blur-xl p-5 rounded-3xl border border-slate-200 shadow-sm">
      <p className="text-[10px] font-black uppercase tracking-widest text-slate-400">{label}</p>
      <p className={`text-2xl font-black mt-1 ${tintCls}`}>{value}</p>
    </div>
  );
};

const SectionCard: React.FC<{ title: string; subtitle?: string; children: React.ReactNode }> = ({ title, subtitle, children }) => (
  <div className="bg-white/80 backdrop-blur-xl p-8 rounded-[2.5rem] border border-slate-200 shadow-sm space-y-5">
    <div>
      <h3 className="text-lg font-black text-primary tracking-tight">{title}</h3>
      {subtitle && <p className="text-xs text-slate-500 font-medium mt-1">{subtitle}</p>}
    </div>
    {children}
  </div>
);

const Badge: React.FC<{ text: string; className: string }> = ({ text, className }) => (
  <span className={`px-2 py-0.5 text-[9px] font-black uppercase tracking-widest rounded-md border ${className}`}>{text}</span>
);

const SettingControl: React.FC<{ def: SettingDefinition; value: SettingPrimitive; canEdit: boolean; onChange: (v: SettingPrimitive) => void }> = ({ def, value, canEdit, onChange }) => {
  const base = 'w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-2xl text-sm font-bold text-slate-700 disabled:opacity-60';
  switch (def.valueType) {
    case 'boolean':
      return (
        <label className="flex items-center gap-3 cursor-pointer">
          <input type="checkbox" disabled={!canEdit} checked={Boolean(value)} onChange={e => onChange(e.target.checked)} className="w-5 h-5 rounded-lg border-slate-300 text-primary focus:ring-primary disabled:opacity-60" />
          <span className="text-sm font-bold text-slate-700">{Boolean(value) ? 'On' : 'Off'}</span>
        </label>
      );
    case 'multiline':
      return <textarea disabled={!canEdit} value={String(value)} onChange={e => onChange(e.target.value)} className={`${base} h-20 resize-none`} placeholder={def.placeholder} />;
    case 'number':
      return <input type="number" min={def.min} max={def.max} disabled={!canEdit} value={Number(value)} onChange={e => onChange(Number(e.target.value) || 0)} className={base} placeholder={def.placeholder} />;
    case 'datetime':
      return <input type="datetime-local" disabled={!canEdit} value={String(value)} onChange={e => onChange(e.target.value)} className={base} />;
    case 'email':
      return <input type="email" disabled={!canEdit} value={String(value)} onChange={e => onChange(e.target.value)} className={base} placeholder={def.placeholder} />;
    case 'url':
    case 'text':
    default:
      return <input type="text" disabled={!canEdit} value={String(value)} onChange={e => onChange(e.target.value)} className={base} placeholder={def.placeholder} />;
  }
};

const SettingRow: React.FC<{
  def: SettingDefinition;
  value: SettingPrimitive;
  defaultValue: SettingPrimitive;
  modified: boolean;
  canEdit: boolean;
  onChange: (v: SettingPrimitive) => void;
}> = ({ def, value, defaultValue, modified, canEdit, onChange }) => (
  <div className="border border-slate-100 rounded-3xl p-5 bg-white/60 space-y-3">
    <div className="flex items-start justify-between gap-3 flex-wrap">
      <div className="flex-1 min-w-[200px]">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm font-black text-slate-800">{def.label}</span>
          {modified && <Badge text="Modified" className="bg-amber-400/10 text-amber-700 border-amber-400/20" />}
        </div>
        <p className="text-xs text-slate-500 font-medium mt-0.5">{def.description}</p>
      </div>
      <div className="flex items-center gap-1.5 flex-wrap">
        <Badge text={SETTING_ENFORCEMENT_LABELS[def.enforcement]} className={ENFORCEMENT_STYLES[def.enforcement]} />
        <Badge text={`${SETTING_RISK_LABELS[def.risk]} Risk`} className={RISK_STYLES[def.risk]} />
      </div>
    </div>

    <SettingControl def={def} value={value} canEdit={canEdit} onChange={onChange} />

    <div className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-1.5 pt-1">
      <Meta label="Owner" value={def.owner} />
      <Meta label="Default" value={formatSettingValue(def, defaultValue)} />
      <Meta label="Impact" value={def.impactSummary} full />
      <Meta label="Truth" value={def.truthLabel} full muted />
    </div>
    <p className="text-[10px] font-mono text-slate-300">key: {def.key}</p>
  </div>
);

const Meta: React.FC<{ label: string; value: string; full?: boolean; muted?: boolean }> = ({ label, value, full, muted }) => (
  <div className={full ? 'md:col-span-2' : ''}>
    <span className="text-[10px] font-black uppercase tracking-widest text-slate-400">{label}: </span>
    <span className={`text-[11px] font-${muted ? 'medium' : 'bold'} ${muted ? 'text-slate-400' : 'text-slate-600'}`}>{value}</span>
  </div>
);

const SaveRow: React.FC<{ group: SettingsGroup; dirty: boolean; saving: boolean; onSave: (g: SettingsGroup) => void }> = ({ group, dirty, saving, onSave }) => (
  <div className="flex justify-end pt-2">
    <button
      onClick={() => onSave(group)}
      disabled={!dirty || saving}
      className={`px-6 py-2.5 text-[10px] font-black uppercase tracking-widest rounded-xl transition-all ${saving ? 'bg-emerald-500 text-white' : dirty ? 'bg-primary text-white shadow-lg shadow-primary/20 hover:bg-primary/90' : 'bg-slate-100 text-slate-400 cursor-not-allowed'}`}
    >
      {saving ? 'Saved!' : dirty ? `Save ${SETTINGS_GROUP_LABELS[group]}` : 'No Changes'}
    </button>
  </div>
);

export default PlatformSettingsPage;
