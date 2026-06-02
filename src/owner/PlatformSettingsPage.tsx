import React, { useEffect, useMemo, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
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

// The single predicate for "this setting changed in the draft vs what's
// persisted". Diff preview, audit note, dirty state, and the review modal all
// derive from this so they cannot drift.
const isChangedFromPersisted = (def: SettingDefinition, persisted: PlatformDefaults, draft: PlatformDefaults): boolean =>
  JSON.stringify(getSettingValue(persisted, def)) !== JSON.stringify(getSettingValue(draft, def));

const changedDefsForGroup = (group: SettingsGroup, persisted: PlatformDefaults, draft: PlatformDefaults): SettingDefinition[] =>
  getSettingsForGroup(group).filter(def => isChangedFromPersisted(def, persisted, draft));

// Registry-driven audit note so the recorded change matches governance keys.
const buildChangeSummary = (defs: SettingDefinition[], persisted: PlatformDefaults, draft: PlatformDefaults): string =>
  defs.map(def => `${def.key}: ${formatSettingValue(def, getSettingValue(persisted, def))} → ${formatSettingValue(def, getSettingValue(draft, def))}`).join('; ');

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

  // Navigation / review UX state.
  const [query, setQuery] = useState('');
  const [groupFilter, setGroupFilter] = useState<SettingsGroup | 'all'>('all');
  const [reviewGroup, setReviewGroup] = useState<SettingsGroup | null>(null);
  const [ackHighRisk, setAckHighRisk] = useState(false);
  const [resetTarget, setResetTarget] = useState<SettingDefinition | null>(null);

  useEffect(() => { setDraft(persisted); }, [persisted]);

  // Governance posture reflects the PERSISTED (in-effect) settings.
  const posture = useMemo(() => deriveSettingsPosture(persisted), [persisted]);

  const changedByGroup = useMemo<Record<SettingsGroup, SettingDefinition[]>>(() => {
    const out = {} as Record<SettingsGroup, SettingDefinition[]>;
    SETTINGS_GROUP_ORDER.forEach(g => { out[g] = changedDefsForGroup(g, persisted, draft); });
    return out;
  }, [persisted, draft]);

  const totalDirty = useMemo(() => SETTINGS_GROUP_ORDER.reduce((n, g) => n + changedByGroup[g].length, 0), [changedByGroup]);
  const dirtyGroupCount = useMemo(() => SETTINGS_GROUP_ORDER.filter(g => changedByGroup[g].length > 0).length, [changedByGroup]);

  // Unsaved-changes guard for full page/browser navigation.
  useEffect(() => {
    if (totalDirty === 0) return;
    const handler = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [totalDirty]);

  const matchesQuery = (def: SettingDefinition): boolean => {
    const q = query.trim().toLowerCase();
    if (!q) return true;
    return [def.label, def.description, def.key, def.owner, def.impactSummary].some(s => s.toLowerCase().includes(q));
  };

  const updateField = (def: SettingDefinition, value: SettingPrimitive) => {
    if (!canEdit) return;
    setDraft(d => setDraftValue(d, def, value));
  };

  const discardGroup = (group: SettingsGroup) => {
    if (!canEdit) return;
    setDraft(d => ({ ...d, [group]: persisted[group] } as PlatformDefaults));
  };

  const openReview = (group: SettingsGroup) => {
    if (!canEdit || changedByGroup[group].length === 0) return;
    setAckHighRisk(false);
    setReviewGroup(group);
  };

  const confirmSave = () => {
    if (!canEdit || !reviewGroup) return;
    const group = reviewGroup;
    const defs = changedByGroup[group];
    if (defs.length === 0) { setReviewGroup(null); return; }
    // Defensive: never persist a high-risk batch without explicit acknowledgment,
    // independent of the button's disabled state.
    if (defs.some(d => d.risk === 'high') && !ackHighRisk) return;
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
      severity: defs.some(d => d.risk === 'high') ? 'warning' : 'notice',
      note: buildChangeSummary(defs, persisted, draft),
    });
    setReviewGroup(null);
    setAckHighRisk(false);
  };

  const confirmReset = () => {
    if (!canEdit || !resetTarget) return;
    setDraft(d => setDraftValue(d, resetTarget, getSettingDefault(resetTarget)));
    setResetTarget(null);
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

  const groupsToRender = groupFilter === 'all' ? SETTINGS_GROUP_ORDER : [groupFilter];
  const renderPlan = groupsToRender
    .map(group => ({ group, defs: getSettingsForGroup(group).filter(matchesQuery) }))
    .filter(g => g.defs.length > 0);

  const reviewDefs = reviewGroup ? changedByGroup[reviewGroup] : [];
  const reviewHasHighRisk = reviewDefs.some(d => d.risk === 'high');

  return (
    <div className="space-y-8">
      {/* Command header */}
      <div className="flex items-end justify-between flex-wrap gap-4">
        <div className="max-w-2xl">
          <h2 className="text-2xl font-black text-primary tracking-tight">Platform Settings</h2>
          <p className="text-slate-500 font-medium">Governed platform-wide configuration with change review, impact preview, and audit.{savedAt && <span className="ml-2 text-xs text-slate-400">Last saved: {savedAt}</span>}</p>
          <div className="mt-2 flex flex-wrap gap-2">
            <TruthLabel text={SETTINGS_TRUTH_LABELS.governance} tone="slate" />
            <TruthLabel text={SETTINGS_TRUTH_LABELS.notEnforced} tone="amber" />
            <TruthLabel text={SETTINGS_TRUTH_LABELS.future} tone="slate" />
          </div>
        </div>
        <div className="flex flex-col items-end gap-2">
          {!canEdit && (
            <span className="px-4 py-2 text-[10px] font-black uppercase tracking-widest text-slate-400 bg-slate-100 border border-slate-200 rounded-xl">Read-only — Edit Platform Settings required</span>
          )}
          {canEdit && totalDirty > 0 && (
            <span className="inline-flex items-center gap-1.5 px-4 py-2 text-[10px] font-black uppercase tracking-widest text-amber-700 bg-amber-400/10 border border-amber-400/30 rounded-xl">
              <span className="material-symbols-outlined text-[14px]">edit_note</span>
              {totalDirty} unsaved change{totalDirty === 1 ? '' : 's'} · {dirtyGroupCount} group{dirtyGroupCount === 1 ? '' : 's'}
            </span>
          )}
        </div>
      </div>

      {/* Governance posture */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3">
        <PostureCard label="Total Settings" value={posture.total} />
        <PostureCard label="Modified" value={posture.modified} tint="amber" />
        <PostureCard label="High Risk" value={posture.highRisk} tint="red" />
        <PostureCard label="High Risk · Modified" value={posture.highRiskModified} tint="red" />
        <PostureCard label="Documentation Only" value={posture.documentationOnly} tint="amber" />
      </div>

      {/* Search + group navigation */}
      <div className="bg-white/80 backdrop-blur-xl p-4 rounded-3xl border border-slate-200 shadow-sm flex flex-col md:flex-row md:items-center gap-3">
        <div className="relative flex-1">
          <span className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 text-[18px]">search</span>
          <input
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Search settings by label, key, owner, or impact…"
            className="w-full pl-10 pr-4 py-2.5 bg-slate-50 border border-slate-200 rounded-2xl text-sm font-bold text-slate-700"
          />
        </div>
        <div className="flex flex-wrap gap-1.5">
          <GroupPill label="All" active={groupFilter === 'all'} onClick={() => setGroupFilter('all')} />
          {SETTINGS_GROUP_ORDER.map(g => (
            <GroupPill key={g} label={SETTINGS_GROUP_LABELS[g]} active={groupFilter === g} dirty={changedByGroup[g].length > 0} onClick={() => setGroupFilter(g)} />
          ))}
        </div>
      </div>

      {/* Active filter chips */}
      {(query.trim() || groupFilter !== 'all') && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[10px] font-black uppercase tracking-widest text-slate-400">Filters:</span>
          {groupFilter !== 'all' && (
            <FilterChip label={`Group: ${SETTINGS_GROUP_LABELS[groupFilter]}`} onClear={() => setGroupFilter('all')} />
          )}
          {query.trim() && <FilterChip label={`Search: "${query.trim()}"`} onClear={() => setQuery('')} />}
          <button onClick={() => { setQuery(''); setGroupFilter('all'); }} className="text-[10px] font-black uppercase tracking-widest text-slate-400 hover:text-slate-600">Clear all</button>
        </div>
      )}

      {/* Registry-driven group sections */}
      {renderPlan.length === 0 ? (
        <div className="bg-white/80 backdrop-blur-xl rounded-[2rem] border border-slate-200 p-12 text-center shadow-sm">
          <span className="material-symbols-outlined text-4xl text-slate-300">search_off</span>
          <p className="mt-3 text-sm font-black text-slate-600 uppercase tracking-widest">No settings match</p>
          <p className="mt-1 text-xs font-bold text-slate-400">Adjust your search or group filter.</p>
        </div>
      ) : renderPlan.map(({ group, defs }) => {
        const changedCount = changedByGroup[group].length;
        return (
          <SectionCard
            key={group}
            title={SETTINGS_GROUP_LABELS[group]}
            subtitle={SETTINGS_GROUP_DESCRIPTIONS[group]}
            badge={changedCount > 0 ? `${changedCount} unsaved` : undefined}
          >
            <div className="space-y-4">
              {defs.map(def => (
                <SettingRow
                  key={def.key}
                  def={def}
                  value={getSettingValue(draft, def)}
                  defaultValue={getSettingDefault(def)}
                  modified={isSettingModified(draft, def)}
                  changed={isChangedFromPersisted(def, persisted, draft)}
                  canEdit={canEdit}
                  onChange={v => updateField(def, v)}
                  onReset={() => setResetTarget(def)}
                />
              ))}
            </div>
            {canEdit && (
              <SaveRow
                group={group}
                changedCount={changedCount}
                saving={savingGroup === group}
                onReview={() => openReview(group)}
                onDiscard={() => discardGroup(group)}
              />
            )}
          </SectionCard>
        );
      })}

      {/* ---- Change review / impact / confirmation modal ---- */}
      <AnimatePresence>
        {reviewGroup && (
          <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={() => setReviewGroup(null)} className="absolute inset-0 bg-slate-900/50 backdrop-blur-md" />
            <motion.div initial={{ opacity: 0, scale: 0.95, y: 20 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: 0.95, y: 20 }} className="relative w-full max-w-xl bg-white rounded-[2rem] shadow-2xl overflow-hidden max-h-[90vh] flex flex-col">
              <div className="p-6 border-b border-slate-100">
                <h3 className="text-lg font-black text-primary tracking-tight">Review changes — {SETTINGS_GROUP_LABELS[reviewGroup]}</h3>
                <p className="text-xs font-bold text-slate-500 mt-1">{reviewDefs.length} setting{reviewDefs.length === 1 ? '' : 's'} will be saved. {SETTINGS_TRUTH_LABELS.notEnforced}</p>
              </div>
              <div className="p-6 space-y-3 overflow-y-auto">
                {reviewDefs.map(def => (
                  <div key={def.key} className="border border-slate-100 rounded-2xl p-4 bg-slate-50/60">
                    <div className="flex items-center justify-between gap-2 flex-wrap">
                      <span className="text-sm font-black text-slate-800">{def.label}</span>
                      <div className="flex items-center gap-1.5">
                        <Badge text={SETTING_ENFORCEMENT_LABELS[def.enforcement]} className={ENFORCEMENT_STYLES[def.enforcement]} />
                        <Badge text={`${SETTING_RISK_LABELS[def.risk]} Risk`} className={RISK_STYLES[def.risk]} />
                      </div>
                    </div>
                    <div className="flex items-center gap-2 mt-2 text-sm font-bold flex-wrap">
                      <span className="px-2 py-1 rounded-lg bg-white border border-slate-200 text-slate-400 line-through">{formatSettingValue(def, getSettingValue(persisted, def))}</span>
                      <span className="material-symbols-outlined text-slate-400 text-[16px]">arrow_forward</span>
                      <span className="px-2 py-1 rounded-lg bg-primary/5 border border-primary/20 text-primary">{formatSettingValue(def, getSettingValue(draft, def))}</span>
                    </div>
                    <p className="text-[11px] font-bold text-slate-500 mt-2"><span className="text-slate-400 uppercase tracking-widest text-[10px] font-black">Impact: </span>{def.impactSummary}</p>
                    <p className="text-[11px] font-medium text-slate-400 mt-0.5">{def.truthLabel}</p>
                  </div>
                ))}
              </div>
              {reviewHasHighRisk && (
                <div className="px-6 pb-2">
                  <div className="bg-red-500/5 border border-red-500/20 rounded-2xl p-4">
                    <p className="text-xs font-black text-red-700 uppercase tracking-widest flex items-center gap-1.5"><span className="material-symbols-outlined text-[16px]">warning</span> High-risk change</p>
                    <p className="text-[11px] font-bold text-slate-600 mt-1">This batch changes high-risk settings. These are recorded for governance only and are not enforced at runtime today.</p>
                    <label className="flex items-center gap-2 cursor-pointer mt-2">
                      <input type="checkbox" checked={ackHighRisk} onChange={e => setAckHighRisk(e.target.checked)} className="w-4 h-4 rounded border-slate-300 text-red-600 focus:ring-red-500" />
                      <span className="text-[11px] font-bold text-slate-700">I understand and want to record this change.</span>
                    </label>
                  </div>
                </div>
              )}
              <div className="p-6 border-t border-slate-100 flex justify-end gap-2">
                <button onClick={() => setReviewGroup(null)} className="px-5 py-2.5 text-[10px] font-black uppercase tracking-widest text-slate-500 border border-slate-200 rounded-xl hover:bg-slate-50 transition-all">Cancel</button>
                <button
                  onClick={confirmSave}
                  disabled={reviewHasHighRisk && !ackHighRisk}
                  className={`px-6 py-2.5 text-[10px] font-black uppercase tracking-widest rounded-xl transition-all ${reviewHasHighRisk && !ackHighRisk ? 'bg-slate-100 text-slate-400 cursor-not-allowed' : 'bg-primary text-white shadow-lg shadow-primary/20 hover:bg-primary/90'}`}
                >
                  Confirm &amp; Save
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* ---- Reset-to-default confirmation ---- */}
      <AnimatePresence>
        {resetTarget && (
          <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={() => setResetTarget(null)} className="absolute inset-0 bg-slate-900/50 backdrop-blur-md" />
            <motion.div initial={{ opacity: 0, scale: 0.95, y: 20 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: 0.95, y: 20 }} className="relative w-full max-w-md bg-white rounded-[2rem] shadow-2xl overflow-hidden">
              <div className="p-6 space-y-3">
                <h3 className="text-lg font-black text-primary tracking-tight">Reset to default?</h3>
                <p className="text-sm font-bold text-slate-600">Reset <span className="text-slate-900">{resetTarget.label}</span> to its registry default.</p>
                <div className="flex items-center gap-2 text-sm font-bold flex-wrap">
                  <span className="px-2 py-1 rounded-lg bg-slate-50 border border-slate-200 text-slate-400 line-through">{formatSettingValue(resetTarget, getSettingValue(draft, resetTarget))}</span>
                  <span className="material-symbols-outlined text-slate-400 text-[16px]">arrow_forward</span>
                  <span className="px-2 py-1 rounded-lg bg-primary/5 border border-primary/20 text-primary">{formatSettingValue(resetTarget, getSettingDefault(resetTarget))}</span>
                </div>
                <p className="text-[11px] font-medium text-slate-400">This stages a pending change — review &amp; save the group to apply and record it.</p>
              </div>
              <div className="px-6 pb-6 flex justify-end gap-2">
                <button onClick={() => setResetTarget(null)} className="px-5 py-2.5 text-[10px] font-black uppercase tracking-widest text-slate-500 border border-slate-200 rounded-xl hover:bg-slate-50 transition-all">Cancel</button>
                <button onClick={confirmReset} className="px-6 py-2.5 bg-primary text-white text-[10px] font-black uppercase tracking-widest rounded-xl shadow-lg shadow-primary/20 hover:bg-primary/90 transition-all">Reset</button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
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

const GroupPill: React.FC<{ label: string; active: boolean; dirty?: boolean; onClick: () => void }> = ({ label, active, dirty, onClick }) => (
  <button
    onClick={onClick}
    className={`inline-flex items-center gap-1.5 px-3 py-2 text-[10px] font-black uppercase tracking-widest rounded-xl border transition-all ${active ? 'bg-primary text-white border-primary shadow-lg shadow-primary/20' : 'bg-white text-slate-500 border-slate-200 hover:bg-slate-50'}`}
  >
    {label}
    {dirty && <span className={`w-1.5 h-1.5 rounded-full ${active ? 'bg-white' : 'bg-amber-500'}`} />}
  </button>
);

const FilterChip: React.FC<{ label: string; onClear: () => void }> = ({ label, onClear }) => (
  <span className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-primary/5 border border-primary/20 text-primary text-[10px] font-black uppercase tracking-widest rounded-xl">
    {label}
    <button onClick={onClear} className="hover:text-primary/70"><span className="material-symbols-outlined text-[14px]">close</span></button>
  </span>
);

const SectionCard: React.FC<{ title: string; subtitle?: string; badge?: string; children: React.ReactNode }> = ({ title, subtitle, badge, children }) => (
  <div className="bg-white/80 backdrop-blur-xl p-8 rounded-[2.5rem] border border-slate-200 shadow-sm space-y-5">
    <div className="flex items-start justify-between gap-3">
      <div>
        <h3 className="text-lg font-black text-primary tracking-tight">{title}</h3>
        {subtitle && <p className="text-xs text-slate-500 font-medium mt-1">{subtitle}</p>}
      </div>
      {badge && <Badge text={badge} className="bg-amber-400/10 text-amber-700 border-amber-400/20 shrink-0" />}
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
  changed: boolean;
  canEdit: boolean;
  onChange: (v: SettingPrimitive) => void;
  onReset: () => void;
}> = ({ def, value, defaultValue, modified, changed, canEdit, onChange, onReset }) => (
  <div className={`border rounded-3xl p-5 bg-white/60 space-y-3 ${changed ? 'border-amber-300 ring-1 ring-amber-200' : 'border-slate-100'}`}>
    <div className="flex items-start justify-between gap-3 flex-wrap">
      <div className="flex-1 min-w-[200px]">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm font-black text-slate-800">{def.label}</span>
          {changed && <Badge text="Unsaved" className="bg-amber-400/10 text-amber-700 border-amber-400/20" />}
          {!changed && modified && <Badge text="Modified" className="bg-slate-100 text-slate-500 border-slate-200" />}
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
    <div className="flex items-center justify-between gap-3">
      <p className="text-[10px] font-mono text-slate-300">key: {def.key}</p>
      {canEdit && modified && (
        <button onClick={onReset} className="inline-flex items-center gap-1 text-[10px] font-black uppercase tracking-widest text-slate-400 hover:text-primary transition-all">
          <span className="material-symbols-outlined text-[14px]">restart_alt</span> Reset to default
        </button>
      )}
    </div>
  </div>
);

const Meta: React.FC<{ label: string; value: string; full?: boolean; muted?: boolean }> = ({ label, value, full, muted }) => (
  <div className={full ? 'md:col-span-2' : ''}>
    <span className="text-[10px] font-black uppercase tracking-widest text-slate-400">{label}: </span>
    <span className={`text-[11px] font-${muted ? 'medium' : 'bold'} ${muted ? 'text-slate-400' : 'text-slate-600'}`}>{value}</span>
  </div>
);

const SaveRow: React.FC<{ group: SettingsGroup; changedCount: number; saving: boolean; onReview: () => void; onDiscard: () => void }> = ({ group, changedCount, saving, onReview, onDiscard }) => {
  const dirty = changedCount > 0;
  return (
    <div className="flex justify-end items-center gap-2 pt-2">
      {dirty && !saving && (
        <button onClick={onDiscard} className="px-5 py-2.5 text-[10px] font-black uppercase tracking-widest text-slate-500 border border-slate-200 rounded-xl hover:bg-slate-50 transition-all">Discard</button>
      )}
      <button
        onClick={onReview}
        disabled={!dirty || saving}
        className={`px-6 py-2.5 text-[10px] font-black uppercase tracking-widest rounded-xl transition-all ${saving ? 'bg-emerald-500 text-white' : dirty ? 'bg-primary text-white shadow-lg shadow-primary/20 hover:bg-primary/90' : 'bg-slate-100 text-slate-400 cursor-not-allowed'}`}
      >
        {saving ? 'Saved!' : dirty ? `Review & Save (${changedCount})` : 'No Changes'}
      </button>
    </div>
  );
};

export default PlatformSettingsPage;
