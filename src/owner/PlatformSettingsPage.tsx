import React, { useEffect, useMemo, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { platformDefaults, type PlatformDefaults } from './mockData';
import { pushPlatformAudit } from './platformOpsAudit';
import { useAccess } from '../context/AccessContext';
import { hasPlatformPermission, hasEffectiveFeatureAccess } from './platformPermissionsConfig';
import type { Role } from '../context/accessConfig';
import {
  SETTINGS_REGISTRY,
  SETTINGS_GROUP_ORDER,
  SETTINGS_GROUP_LABELS,
  SETTINGS_GROUP_DESCRIPTIONS,
  SETTING_ENFORCEMENT_LABELS,
  SETTING_ENFORCEMENT_ORDER,
  SETTING_RISK_LABELS,
  SETTING_RISK_ORDER,
  SETTINGS_TRUTH_LABELS,
  getSettingsForGroup,
  getSettingValue,
  getSettingDefault,
  getRegistryDefault,
  getEffectiveDefault,
  isDefaultOverridden,
  isSettingModified,
  formatSettingValue,
  deriveSettingsPosture,
  type SettingsDefaultsOverride,
  type SettingsGroup,
  type SettingDefinition,
  type SettingEnforcement,
  type SettingRisk,
  type SettingPrimitive,
} from './platformOpsSettings';

const STORAGE_KEY = 'platform_settings_v1';
// Default-baseline overrides store. Separate from the in-effect settings store
// (platform_settings_v1) — this records governance-only adjustments to the
// registry DEFAULTS, still enforced by nothing at runtime.
const BASELINE_KEY = 'platform_settings_defaults_v1';

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

// Read-only, informational summary of capability areas that are NOT active in
// this phase. Nothing here is wired to runtime behavior — the panel exists to
// set honest expectations about what Platform Settings does and does not do.
const FUTURE_READINESS: { icon: string; title: string; detail: string }[] = [
  { icon: 'notifications', title: 'Notifications & alerts', detail: 'No email, SMS, or webhook delivery. Maintenance/support fields are display-only.' },
  { icon: 'badge', title: 'SSO / SCIM provisioning', detail: 'No identity-provider sign-in or directory sync. MFA expectations are recorded, not enforced.' },
  { icon: 'cloud_sync', title: 'Provider / external calls', detail: 'No outbound integration calls. Status page and logo URLs are referenced for display only.' },
  { icon: 'gavel', title: 'Runtime policy enforcement', detail: 'No setting changes platform behavior at runtime. Session timeout / MFA are documentation only.' },
  { icon: 'dns', title: 'Backend configuration service', detail: 'Values persist to local browser storage only. There is no server-side config service yet.' },
  { icon: 'verified', title: 'Audit / compliance evidence', detail: 'Saves emit governance audit rows in-app. No legal-grade or compliance-certified evidence pipeline.' },
];

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

const loadBaseline = (): SettingsDefaultsOverride => {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return {};
    const raw = window.localStorage.getItem(BASELINE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    // Keep only keys that still exist in the registry, so a removed setting can
    // never resurrect a stale override.
    const out: SettingsDefaultsOverride = {};
    SETTINGS_REGISTRY.forEach(def => {
      if (Object.prototype.hasOwnProperty.call(parsed, def.key)) out[def.key] = parsed[def.key];
    });
    return out;
  } catch {
    return {};
  }
};

const saveBaseline = (o: SettingsDefaultsOverride) => {
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      window.localStorage.setItem(BASELINE_KEY, JSON.stringify(o));
    }
  } catch { /* noop */ }
};

// Full working map of every registry key → its currently-effective default,
// used as the editable baseline draft.
const buildBaselineDraft = (overrides: SettingsDefaultsOverride): Record<string, SettingPrimitive> => {
  const out: Record<string, SettingPrimitive> = {};
  SETTINGS_REGISTRY.forEach(def => { out[def.key] = getEffectiveDefault(def, overrides); });
  return out;
};

const baselineChangedDefsForGroup = (
  group: SettingsGroup,
  overrides: SettingsDefaultsOverride,
  draft: Record<string, SettingPrimitive>,
): SettingDefinition[] =>
  getSettingsForGroup(group).filter(def => JSON.stringify(draft[def.key]) !== JSON.stringify(getEffectiveDefault(def, overrides)));

// Registry-driven baseline audit note: registry default → new default value.
const buildBaselineSummary = (defs: SettingDefinition[], draft: Record<string, SettingPrimitive>): string =>
  defs.map(def => `${def.key}: default ${formatSettingValue(def, getRegistryDefault(def))} → ${formatSettingValue(def, draft[def.key])}`).join('; ');

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

  // Top-level Control Center workspace. `registry` is the in-effect settings
  // editing/governance surface (grouped or table view); `baseline` edits the
  // default baseline; `overview` is the read-only Configuration Center summary.
  const [workspace, setWorkspace] = useState<'overview' | 'registry' | 'baseline'>('overview');
  const [registryView, setRegistryView] = useState<'grouped' | 'table'>('grouped');

  const [persisted, setPersisted] = useState<PlatformDefaults>(() => loadSettings());
  const [draft, setDraft] = useState<PlatformDefaults>(persisted);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [savingGroup, setSavingGroup] = useState<SettingsGroup | null>(null);

  // Default-baseline state — overrides (persisted) + a full editable draft map.
  const [baselineOverrides, setBaselineOverrides] = useState<SettingsDefaultsOverride>(() => loadBaseline());
  const [baselineDraft, setBaselineDraft] = useState<Record<string, SettingPrimitive>>(() => buildBaselineDraft(baselineOverrides));
  const [baselineSavedAt, setBaselineSavedAt] = useState<string | null>(null);
  const [baselineSavingGroup, setBaselineSavingGroup] = useState<SettingsGroup | null>(null);
  const [baselineReviewGroup, setBaselineReviewGroup] = useState<SettingsGroup | null>(null);
  const [baselineAck, setBaselineAck] = useState(false);
  const [baselineResetTarget, setBaselineResetTarget] = useState<SettingDefinition | null>(null);

  // Navigation / review UX state.
  const [query, setQuery] = useState('');
  const [groupFilter, setGroupFilter] = useState<SettingsGroup | 'all'>('all');
  const [riskFilter, setRiskFilter] = useState<SettingRisk | 'all'>('all');
  const [enforcementFilter, setEnforcementFilter] = useState<SettingEnforcement | 'all'>('all');
  const [modifiedOnly, setModifiedOnly] = useState(false);
  const [customizedOnly, setCustomizedOnly] = useState(false);
  const [reviewGroup, setReviewGroup] = useState<SettingsGroup | null>(null);
  const [ackHighRisk, setAckHighRisk] = useState(false);
  const [resetTarget, setResetTarget] = useState<SettingDefinition | null>(null);

  useEffect(() => { setDraft(persisted); }, [persisted]);
  useEffect(() => { setBaselineDraft(buildBaselineDraft(baselineOverrides)); }, [baselineOverrides]);

  // Governance posture reflects the PERSISTED (in-effect) settings, evaluated
  // against the EFFECTIVE defaults (registry default ± baseline override).
  const posture = useMemo(() => deriveSettingsPosture(persisted, baselineOverrides), [persisted, baselineOverrides]);

  const changedByGroup = useMemo<Record<SettingsGroup, SettingDefinition[]>>(() => {
    const out = {} as Record<SettingsGroup, SettingDefinition[]>;
    SETTINGS_GROUP_ORDER.forEach(g => { out[g] = changedDefsForGroup(g, persisted, draft); });
    return out;
  }, [persisted, draft]);

  const totalDirty = useMemo(() => SETTINGS_GROUP_ORDER.reduce((n, g) => n + changedByGroup[g].length, 0), [changedByGroup]);
  const dirtyGroupCount = useMemo(() => SETTINGS_GROUP_ORDER.filter(g => changedByGroup[g].length > 0).length, [changedByGroup]);

  const matchesQuery = (def: SettingDefinition): boolean => {
    const q = query.trim().toLowerCase();
    if (!q) return true;
    return [def.label, def.description, def.key, def.owner, def.impactSummary].some(s => s.toLowerCase().includes(q));
  };

  // Single predicate shared by the registry list, the grouped sections, and the
  // active-filter chips so a count and the visible rows can never drift. The
  // `modified` / `customized` lenses are measured against the PERSISTED
  // (in-effect) settings and the maintained baseline — identical to the
  // Configuration Center overview counts, so a card and its filtered list match.
  const matchesFilters = (def: SettingDefinition): boolean => {
    if (!matchesQuery(def)) return false;
    if (groupFilter !== 'all' && def.group !== groupFilter) return false;
    if (riskFilter !== 'all' && def.risk !== riskFilter) return false;
    if (enforcementFilter !== 'all' && def.enforcement !== enforcementFilter) return false;
    if (modifiedOnly && !isSettingModified(persisted, def, baselineOverrides)) return false;
    if (customizedOnly && !isDefaultOverridden(def, baselineOverrides)) return false;
    return true;
  };

  const hasActiveFilters =
    !!query.trim() ||
    groupFilter !== 'all' ||
    riskFilter !== 'all' ||
    enforcementFilter !== 'all' ||
    modifiedOnly ||
    customizedOnly;

  const clearAllFilters = () => {
    setQuery('');
    setGroupFilter('all');
    setRiskFilter('all');
    setEnforcementFilter('all');
    setModifiedOnly(false);
    setCustomizedOnly(false);
  };

  // Navigate from an overview lens into the registry workspace with a single
  // visible filter applied (table view = governance browsing). Never hides a
  // filter — every applied lens shows as a clearable chip.
  const openRegistryWith = (
    apply: () => void,
    view: 'grouped' | 'table' = 'table',
  ) => {
    clearAllFilters();
    apply();
    setRegistryView(view);
    setWorkspace('registry');
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
    // Reset to the EFFECTIVE default (registry default ± baseline override).
    setDraft(d => setDraftValue(d, resetTarget, getEffectiveDefault(resetTarget, baselineOverrides)));
    setResetTarget(null);
  };

  // ---- Default-baseline derived state + handlers ----
  const baselineChangedByGroup = useMemo<Record<SettingsGroup, SettingDefinition[]>>(() => {
    const out = {} as Record<SettingsGroup, SettingDefinition[]>;
    SETTINGS_GROUP_ORDER.forEach(g => { out[g] = baselineChangedDefsForGroup(g, baselineOverrides, baselineDraft); });
    return out;
  }, [baselineOverrides, baselineDraft]);

  const baselineTotalDirty = useMemo(() => SETTINGS_GROUP_ORDER.reduce((n, g) => n + baselineChangedByGroup[g].length, 0), [baselineChangedByGroup]);
  const baselineDirtyGroupCount = useMemo(() => SETTINGS_GROUP_ORDER.filter(g => baselineChangedByGroup[g].length > 0).length, [baselineChangedByGroup]);
  const overriddenCount = useMemo(() => SETTINGS_REGISTRY.filter(def => isDefaultOverridden(def, baselineOverrides)).length, [baselineOverrides]);
  const highRiskOverriddenCount = useMemo(() => SETTINGS_REGISTRY.filter(def => def.risk === 'high' && isDefaultOverridden(def, baselineOverrides)).length, [baselineOverrides]);

  // Unsaved-changes guard for full page/browser navigation (either surface).
  useEffect(() => {
    if (totalDirty === 0 && baselineTotalDirty === 0) return;
    const handler = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [totalDirty, baselineTotalDirty]);

  const updateBaselineField = (def: SettingDefinition, value: SettingPrimitive) => {
    if (!canEdit) return;
    setBaselineDraft(d => ({ ...d, [def.key]: value }));
  };

  const discardBaselineGroup = (group: SettingsGroup) => {
    if (!canEdit) return;
    setBaselineDraft(d => {
      const next = { ...d };
      getSettingsForGroup(group).forEach(def => { next[def.key] = getEffectiveDefault(def, baselineOverrides); });
      return next;
    });
  };

  const openBaselineReview = (group: SettingsGroup) => {
    if (!canEdit || baselineChangedByGroup[group].length === 0) return;
    setBaselineAck(false);
    setBaselineReviewGroup(group);
  };

  const confirmBaselineSave = () => {
    if (!canEdit || !baselineReviewGroup) return;
    const group = baselineReviewGroup;
    const defs = baselineChangedByGroup[group];
    if (defs.length === 0) { setBaselineReviewGroup(null); return; }
    // Re-check high-risk acknowledgment inside the handler, independent of the
    // button's disabled state.
    if (defs.some(d => d.risk === 'high') && !baselineAck) return;
    // Apply each changed default: equal to the registry default → drop the
    // override key; otherwise record it. Keeps the store minimal/no-noise.
    const nextOverrides: SettingsDefaultsOverride = { ...baselineOverrides };
    defs.forEach(def => {
      const v = baselineDraft[def.key];
      if (JSON.stringify(v) === JSON.stringify(getRegistryDefault(def))) delete nextOverrides[def.key];
      else nextOverrides[def.key] = v;
    });
    saveBaseline(nextOverrides);
    setBaselineOverrides(nextOverrides);
    setBaselineSavedAt(new Date().toLocaleString());
    setBaselineSavingGroup(group);
    setTimeout(() => setBaselineSavingGroup(null), 1200);
    pushPlatformAudit({
      actor: 'System Owner',
      action: 'platform_setting_default_updated',
      target: SETTINGS_GROUP_LABELS[group],
      category: 'configuration',
      severity: defs.some(d => d.risk === 'high') ? 'warning' : 'notice',
      note: buildBaselineSummary(defs, baselineDraft),
    });
    setBaselineReviewGroup(null);
    setBaselineAck(false);
  };

  const confirmBaselineReset = () => {
    if (!canEdit || !baselineResetTarget) return;
    // Stage the REGISTRY default into the draft (clears the pending override).
    setBaselineDraft(d => ({ ...d, [baselineResetTarget.key]: getRegistryDefault(baselineResetTarget) }));
    setBaselineResetTarget(null);
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
    .map(group => ({ group, defs: getSettingsForGroup(group).filter(matchesFilters) }))
    .filter(g => g.defs.length > 0);

  // Flat, filtered registry list for the governance table view — same predicate
  // as the grouped sections, so the table and the grouped view never disagree.
  const registryRows = SETTINGS_REGISTRY.filter(matchesFilters);

  const reviewDefs = reviewGroup ? changedByGroup[reviewGroup] : [];
  const reviewHasHighRisk = reviewDefs.some(d => d.risk === 'high');

  const baselineReviewDefs = baselineReviewGroup ? baselineChangedByGroup[baselineReviewGroup] : [];
  const baselineReviewHasHighRisk = baselineReviewDefs.some(d => d.risk === 'high');

  return (
    <div className="space-y-8">
      {/* Command header */}
      <div className="flex items-end justify-between flex-wrap gap-4">
        <div className="max-w-2xl">
          <h2 className="text-2xl font-black text-primary tracking-tight">Platform Settings Control Center</h2>
          <p className="text-slate-500 font-medium">
            {workspace === 'overview'
              ? <>A governed view of every platform setting — registry, risk, enforcement, and maintained defaults. Nothing here is enforced at runtime.</>
              : workspace === 'registry'
                ? <>Governed platform-wide configuration with change review, impact preview, and audit.{savedAt && <span className="ml-2 text-xs text-slate-400">Last saved: {savedAt}</span>}</>
                : <>Edit the registry <span className="font-bold text-slate-600">default baseline</span> — governance reference only, enforced by nothing at runtime.{baselineSavedAt && <span className="ml-2 text-xs text-slate-400">Last saved: {baselineSavedAt}</span>}</>}
          </p>
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
          {canEdit && workspace !== 'baseline' && totalDirty > 0 && (
            <span className="inline-flex items-center gap-1.5 px-4 py-2 text-[10px] font-black uppercase tracking-widest text-amber-700 bg-amber-400/10 border border-amber-400/30 rounded-xl">
              <span className="material-symbols-outlined text-[14px]">edit_note</span>
              {totalDirty} unsaved change{totalDirty === 1 ? '' : 's'} · {dirtyGroupCount} group{dirtyGroupCount === 1 ? '' : 's'}
            </span>
          )}
          {canEdit && workspace === 'baseline' && baselineTotalDirty > 0 && (
            <span className="inline-flex items-center gap-1.5 px-4 py-2 text-[10px] font-black uppercase tracking-widest text-amber-700 bg-amber-400/10 border border-amber-400/30 rounded-xl">
              <span className="material-symbols-outlined text-[14px]">edit_note</span>
              {baselineTotalDirty} unsaved baseline change{baselineTotalDirty === 1 ? '' : 's'} · {baselineDirtyGroupCount} group{baselineDirtyGroupCount === 1 ? '' : 's'}
            </span>
          )}
        </div>
      </div>

      {/* Workspace navigation — Overview / Settings Registry / Default Baseline */}
      <div className="inline-flex items-center gap-1 p-1 bg-slate-100 border border-slate-200 rounded-2xl">
        <ModeTab label="Overview" icon="dashboard" active={workspace === 'overview'} onClick={() => setWorkspace('overview')} />
        <ModeTab label="Settings Registry" icon="tune" active={workspace === 'registry'} dirty={totalDirty > 0} onClick={() => setWorkspace('registry')} />
        <ModeTab label="Default Baseline" icon="rule_settings" active={workspace === 'baseline'} dirty={baselineTotalDirty > 0} onClick={() => setWorkspace('baseline')} />
      </div>

      {/* ============ OVERVIEW WORKSPACE — read-only Configuration Center ============ */}
      {workspace === 'overview' && (
        <div className="space-y-6">
          <div>
            <div className="flex items-center justify-between flex-wrap gap-2 mb-3">
              <div>
                <h3 className="text-lg font-black text-primary tracking-tight">Configuration Center</h3>
                <p className="text-xs font-bold text-slate-400">Live governance snapshot of the settings registry. Select any tile to open the matching settings.</p>
              </div>
            </div>
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
              <MetricCard label="Total Settings" value={posture.total} onClick={() => openRegistryWith(() => {})} />
              <MetricCard label="Modified" value={posture.modified} tint="amber" onClick={() => openRegistryWith(() => setModifiedOnly(true))} />
              <MetricCard label="High Risk" value={posture.highRisk} tint="red" onClick={() => openRegistryWith(() => setRiskFilter('high'))} />
              <MetricCard label="High Risk · Modified" value={posture.highRiskModified} tint="red" onClick={() => openRegistryWith(() => { setRiskFilter('high'); setModifiedOnly(true); })} />
              <MetricCard label="Documentation Only" value={posture.documentationOnly} tint="amber" onClick={() => openRegistryWith(() => setEnforcementFilter('documentation_only'))} />
              <MetricCard label="Customized Defaults" value={overriddenCount} tint="amber" onClick={() => openRegistryWith(() => setCustomizedOnly(true))} />
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            <BreakdownCard title="By Group" icon="category">
              {SETTINGS_GROUP_ORDER.map(g => (
                <BreakdownRow key={g} label={SETTINGS_GROUP_LABELS[g]} value={posture.byGroup[g]} dirty={changedByGroup[g].length} onClick={() => openRegistryWith(() => setGroupFilter(g))} />
              ))}
            </BreakdownCard>
            <BreakdownCard title="By Enforcement" icon="policy">
              {SETTING_ENFORCEMENT_ORDER.filter(e => posture.byEnforcement[e] > 0).map(e => (
                <BreakdownRow key={e} label={SETTING_ENFORCEMENT_LABELS[e]} value={posture.byEnforcement[e]} onClick={() => openRegistryWith(() => setEnforcementFilter(e))} />
              ))}
            </BreakdownCard>
            <BreakdownCard title="Unsaved Work" icon="edit_note">
              <BreakdownRow label="Settings — unsaved" value={totalDirty} dirty={totalDirty} muted={totalDirty === 0} onClick={() => { setRegistryView('grouped'); setWorkspace('registry'); }} />
              <BreakdownRow label="Settings — groups affected" value={dirtyGroupCount} muted />
              <BreakdownRow label="Baseline — unsaved" value={baselineTotalDirty} dirty={baselineTotalDirty} muted={baselineTotalDirty === 0} onClick={() => setWorkspace('baseline')} />
            </BreakdownCard>
          </div>

          {/* Default Baseline Manager entry */}
          <div className="bg-white/80 backdrop-blur-xl p-6 rounded-[2rem] border border-slate-200 shadow-sm">
            <div className="flex items-start justify-between gap-4 flex-wrap">
              <div className="max-w-2xl">
                <div className="flex items-center gap-2">
                  <span className="material-symbols-outlined text-primary">rule_settings</span>
                  <h3 className="text-lg font-black text-primary tracking-tight">Default Baseline Manager</h3>
                </div>
                <p className="text-xs font-medium text-slate-500 mt-1">
                  The baseline is the value each setting falls back to when you choose <span className="font-bold text-slate-600">Reset to default</span> on the Settings Registry. Editing it changes that fallback only — it never changes an in-effect setting and is <span className="font-bold text-slate-600">enforced by nothing at runtime</span>.
                </p>
                <div className="mt-3 flex flex-wrap gap-2">
                  <StatPill label="Customized defaults" value={overriddenCount} tint={overriddenCount ? 'amber' : 'slate'} />
                  <StatPill label="High-risk customized" value={highRiskOverriddenCount} tint={highRiskOverriddenCount ? 'red' : 'slate'} />
                </div>
              </div>
              <button
                onClick={() => setWorkspace('baseline')}
                className="inline-flex items-center gap-1.5 px-4 py-2.5 rounded-2xl bg-primary text-white text-xs font-black uppercase tracking-widest hover:opacity-90 cursor-pointer"
              >
                <span className="material-symbols-outlined text-[16px]">tune</span> Open Default Baseline
              </button>
            </div>
          </div>

          {/* Future Integration Readiness — informational only */}
          <div className="bg-white/80 backdrop-blur-xl p-6 rounded-[2rem] border border-slate-200 shadow-sm">
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <div className="flex items-center gap-2">
                <span className="material-symbols-outlined text-slate-400">schedule</span>
                <h3 className="text-lg font-black text-primary tracking-tight">Future Integration Readiness</h3>
              </div>
              <TruthLabel text="Informational only — not active in this phase." tone="slate" />
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3 mt-4">
              {FUTURE_READINESS.map(item => (
                <div key={item.title} className="border border-slate-100 rounded-2xl p-4 bg-slate-50/60">
                  <div className="flex items-center gap-2">
                    <span className="material-symbols-outlined text-slate-400 text-[18px]">{item.icon}</span>
                    <span className="text-sm font-black text-slate-700">{item.title}</span>
                  </div>
                  <p className="text-[11px] font-medium text-slate-500 mt-1.5">{item.detail}</p>
                  <div className="mt-2 flex flex-wrap gap-1">
                    <Badge text="Future" className="bg-slate-100 text-slate-500 border-slate-200" />
                    <Badge text="No runtime enforcement" className="bg-slate-100 text-slate-500 border-slate-200" />
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* ============ REGISTRY + BASELINE WORKSPACES — editing surfaces ============ */}
      {workspace !== 'overview' && (
        <>
          {/* Governance posture */}
          {workspace === 'registry' ? (
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3">
              <PostureCard label="Total Settings" value={posture.total} />
              <PostureCard label="Modified" value={posture.modified} tint="amber" />
              <PostureCard label="High Risk" value={posture.highRisk} tint="red" />
              <PostureCard label="High Risk · Modified" value={posture.highRiskModified} tint="red" />
              <PostureCard label="Documentation Only" value={posture.documentationOnly} tint="amber" />
            </div>
          ) : (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <PostureCard label="Total Settings" value={posture.total} />
              <PostureCard label="Defaults Overridden" value={overriddenCount} tint="amber" />
              <PostureCard label="High Risk" value={posture.highRisk} tint="red" />
              <PostureCard label="Unsaved Baseline" value={baselineTotalDirty} tint="amber" />
            </div>
          )}

          {/* Default Baseline explanation — concise, plain-language framing */}
          {workspace === 'baseline' && (
            <div className="bg-white/80 backdrop-blur-xl p-5 rounded-3xl border border-slate-200 shadow-sm">
              <p className="text-sm font-black text-slate-800">What the Default Baseline does</p>
              <p className="text-xs font-medium text-slate-500 mt-1 max-w-3xl">
                The baseline is the value each setting falls back to when you choose <span className="font-bold text-slate-600">Reset to default</span> on the Settings Registry. Editing it here changes that fallback — it never changes the in-effect setting and is <span className="font-bold text-slate-600">enforced by nothing at runtime</span>. Each row below shows the current baseline, the built-in registry default, whether the baseline is customized, and its risk and enforcement.
              </p>
              <ol className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] font-bold text-slate-500">
                <li className="px-2.5 py-1 rounded-lg bg-slate-100 border border-slate-200">1 · Edit a baseline value</li>
                <span className="material-symbols-outlined text-slate-300 text-[14px]">arrow_forward</span>
                <li className="px-2.5 py-1 rounded-lg bg-slate-100 border border-slate-200">2 · Review &amp; Save the group</li>
                <span className="material-symbols-outlined text-slate-300 text-[14px]">arrow_forward</span>
                <li className="px-2.5 py-1 rounded-lg bg-slate-100 border border-slate-200">3 · Reset any row to the registry default</li>
              </ol>
            </div>
          )}

          {/* Registry view toggle — grouped editing vs governance table */}
          {workspace === 'registry' && (
            <div className="flex items-center justify-between flex-wrap gap-3">
              <div className="inline-flex items-center gap-1 p-1 bg-slate-100 border border-slate-200 rounded-2xl">
                <ViewTab label="Grouped" icon="view_agenda" active={registryView === 'grouped'} onClick={() => setRegistryView('grouped')} />
                <ViewTab label="Registry Table" icon="table_rows" active={registryView === 'table'} onClick={() => setRegistryView('table')} />
              </div>
              <p className="text-[11px] font-bold text-slate-400">{registryView === 'grouped' ? 'Edit settings grouped by area, with review & save.' : 'Scannable governance table — open a row to edit it in Grouped view.'}</p>
            </div>
          )}

          {/* Search + group navigation + lens filters */}
          <div className="bg-white/80 backdrop-blur-xl p-4 rounded-3xl border border-slate-200 shadow-sm flex flex-col gap-3">
            <div className="flex flex-col md:flex-row md:items-center gap-3">
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
                  <GroupPill key={g} label={SETTINGS_GROUP_LABELS[g]} active={groupFilter === g} dirty={(workspace === 'baseline' ? baselineChangedByGroup[g] : changedByGroup[g]).length > 0} onClick={() => setGroupFilter(g)} />
                ))}
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2 pt-1 border-t border-slate-100">
              <span className="text-[10px] font-black uppercase tracking-widest text-slate-400 mt-2">Lenses:</span>
              <FilterSelect
                label="Risk"
                value={riskFilter}
                onChange={v => setRiskFilter(v as SettingRisk | 'all')}
                options={[{ value: 'all', label: 'All risk' }, ...SETTING_RISK_ORDER.map(r => ({ value: r, label: SETTING_RISK_LABELS[r] }))]}
              />
              <FilterSelect
                label="Enforcement"
                value={enforcementFilter}
                onChange={v => setEnforcementFilter(v as SettingEnforcement | 'all')}
                options={[{ value: 'all', label: 'All enforcement' }, ...SETTING_ENFORCEMENT_ORDER.map(e => ({ value: e, label: SETTING_ENFORCEMENT_LABELS[e] }))]}
              />
              <ToggleChip label="Modified only" active={modifiedOnly} onClick={() => setModifiedOnly(v => !v)} />
              <ToggleChip label="Customized defaults" active={customizedOnly} onClick={() => setCustomizedOnly(v => !v)} />
            </div>
          </div>

          {/* Active filter chips */}
          {hasActiveFilters && (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[10px] font-black uppercase tracking-widest text-slate-400">Filters:</span>
              {groupFilter !== 'all' && <FilterChip label={`Group: ${SETTINGS_GROUP_LABELS[groupFilter]}`} onClear={() => setGroupFilter('all')} />}
              {riskFilter !== 'all' && <FilterChip label={`Risk: ${SETTING_RISK_LABELS[riskFilter]}`} onClear={() => setRiskFilter('all')} />}
              {enforcementFilter !== 'all' && <FilterChip label={`Enforcement: ${SETTING_ENFORCEMENT_LABELS[enforcementFilter]}`} onClear={() => setEnforcementFilter('all')} />}
              {modifiedOnly && <FilterChip label="Modified only" onClear={() => setModifiedOnly(false)} />}
              {customizedOnly && <FilterChip label="Customized defaults" onClear={() => setCustomizedOnly(false)} />}
              {query.trim() && <FilterChip label={`Search: "${query.trim()}"`} onClear={() => setQuery('')} />}
              <button onClick={clearAllFilters} className="text-[10px] font-black uppercase tracking-widest text-slate-400 hover:text-slate-600 cursor-pointer">Clear all</button>
            </div>
          )}

          {/* Content — grouped editing sections OR registry governance table */}
          {(workspace === 'baseline' || registryView === 'grouped') ? (
            renderPlan.length === 0 ? (
              <div className="bg-white/80 backdrop-blur-xl rounded-[2rem] border border-slate-200 p-12 text-center shadow-sm">
                <span className="material-symbols-outlined text-4xl text-slate-300">search_off</span>
                <p className="mt-3 text-sm font-black text-slate-600 uppercase tracking-widest">No settings match</p>
                <p className="mt-1 text-xs font-bold text-slate-400">Adjust your search or filters.</p>
              </div>
            ) : renderPlan.map(({ group, defs }) => {
              const changedCount = (workspace === 'baseline' ? baselineChangedByGroup[group] : changedByGroup[group]).length;
              return (
                <SectionCard
                  key={group}
                  title={SETTINGS_GROUP_LABELS[group]}
                  subtitle={SETTINGS_GROUP_DESCRIPTIONS[group]}
                  badge={changedCount > 0 ? `${changedCount} unsaved` : undefined}
                >
                  <div className="space-y-4">
                    {defs.map(def => workspace === 'registry' ? (
                      <SettingRow
                        key={def.key}
                        def={def}
                        value={getSettingValue(draft, def)}
                        defaultValue={getEffectiveDefault(def, baselineOverrides)}
                        modified={isSettingModified(draft, def, baselineOverrides)}
                        changed={isChangedFromPersisted(def, persisted, draft)}
                        canEdit={canEdit}
                        onChange={v => updateField(def, v)}
                        onReset={() => setResetTarget(def)}
                      />
                    ) : (
                      <SettingRow
                        key={def.key}
                        def={def}
                        value={baselineDraft[def.key]}
                        defaultValue={getRegistryDefault(def)}
                        modified={JSON.stringify(baselineDraft[def.key]) !== JSON.stringify(getRegistryDefault(def))}
                        changed={JSON.stringify(baselineDraft[def.key]) !== JSON.stringify(getEffectiveDefault(def, baselineOverrides))}
                        canEdit={canEdit}
                        baseline
                        onChange={v => updateBaselineField(def, v)}
                        onReset={() => setBaselineResetTarget(def)}
                      />
                    ))}
                  </div>
                  {canEdit && (
                    <SaveRow
                      group={group}
                      changedCount={changedCount}
                      saving={(workspace === 'baseline' ? baselineSavingGroup : savingGroup) === group}
                      onReview={() => workspace === 'baseline' ? openBaselineReview(group) : openReview(group)}
                      onDiscard={() => workspace === 'baseline' ? discardBaselineGroup(group) : discardGroup(group)}
                    />
                  )}
                </SectionCard>
              );
            })
          ) : (
            registryRows.length === 0 ? (
              <div className="bg-white/80 backdrop-blur-xl rounded-[2rem] border border-slate-200 p-12 text-center shadow-sm">
                <span className="material-symbols-outlined text-4xl text-slate-300">search_off</span>
                <p className="mt-3 text-sm font-black text-slate-600 uppercase tracking-widest">No settings match</p>
                <p className="mt-1 text-xs font-bold text-slate-400">Adjust your search or filters.</p>
              </div>
            ) : (
              <div className="bg-white/80 backdrop-blur-xl rounded-[2rem] border border-slate-200 shadow-sm overflow-hidden">
                <div className="overflow-x-auto">
                  <table className="w-full text-left border-collapse">
                    <thead>
                      <tr className="bg-slate-50/80 border-b border-slate-200 text-[10px] font-black uppercase tracking-widest text-slate-400">
                        <th className="px-4 py-3">Setting</th>
                        <th className="px-4 py-3">Group</th>
                        <th className="px-4 py-3">Owner</th>
                        <th className="px-4 py-3">Risk</th>
                        <th className="px-4 py-3">Enforcement</th>
                        <th className="px-4 py-3">Current</th>
                        <th className="px-4 py-3">Baseline</th>
                        <th className="px-4 py-3">Registry</th>
                        <th className="px-4 py-3">Status</th>
                        <th className="px-4 py-3 text-right">Edit</th>
                      </tr>
                    </thead>
                    <tbody>
                      {registryRows.map(def => {
                        const isMod = isSettingModified(persisted, def, baselineOverrides);
                        const isCustom = isDefaultOverridden(def, baselineOverrides);
                        return (
                          <tr key={def.key} className="border-b border-slate-100 last:border-0 align-top hover:bg-slate-50/50">
                            <td className="px-4 py-3 max-w-[18rem]">
                              <div className="text-sm font-black text-slate-700">{def.label}</div>
                              <div className="text-[10px] font-mono text-slate-400">{def.key}</div>
                              <div className="text-[11px] font-medium text-slate-500 mt-1">{def.impactSummary}</div>
                              <div className="text-[10px] font-bold text-slate-400 mt-1 uppercase tracking-wide">{def.truthLabel}</div>
                            </td>
                            <td className="px-4 py-3 text-xs font-bold text-slate-600 whitespace-nowrap">{SETTINGS_GROUP_LABELS[def.group]}</td>
                            <td className="px-4 py-3 text-xs font-bold text-slate-600 whitespace-nowrap">{def.owner}</td>
                            <td className="px-4 py-3 whitespace-nowrap"><Badge text={SETTING_RISK_LABELS[def.risk]} className={RISK_STYLES[def.risk]} /></td>
                            <td className="px-4 py-3 whitespace-nowrap"><Badge text={SETTING_ENFORCEMENT_LABELS[def.enforcement]} className={ENFORCEMENT_STYLES[def.enforcement]} /></td>
                            <td className="px-4 py-3 text-xs font-bold text-slate-700 max-w-[12rem] break-words">{formatSettingValue(def, getSettingValue(persisted, def))}</td>
                            <td className="px-4 py-3 text-xs font-medium text-slate-500 max-w-[12rem] break-words">{formatSettingValue(def, getEffectiveDefault(def, baselineOverrides))}</td>
                            <td className="px-4 py-3 text-xs font-medium text-slate-400 max-w-[12rem] break-words">{formatSettingValue(def, getRegistryDefault(def))}</td>
                            <td className="px-4 py-3 whitespace-nowrap">
                              <div className="flex flex-col gap-1">
                                {isMod && <Badge text="Modified" className="bg-amber-400/10 text-amber-700 border-amber-400/20" />}
                                {isCustom && <Badge text="Custom default" className="bg-blue-400/10 text-blue-700 border-blue-400/20" />}
                                {!isMod && !isCustom && <span className="text-[11px] font-bold text-slate-300">—</span>}
                              </div>
                            </td>
                            <td className="px-4 py-3 text-right whitespace-nowrap">
                              <button
                                onClick={() => { setGroupFilter(def.group); setRegistryView('grouped'); }}
                                className="inline-flex items-center gap-1 px-3 py-1.5 rounded-xl bg-slate-100 border border-slate-200 text-[10px] font-black uppercase tracking-widest text-slate-500 hover:text-slate-700 hover:bg-slate-200 cursor-pointer"
                              >
                                <span className="material-symbols-outlined text-[14px]">open_in_new</span> Open
                              </button>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                <div className="px-4 py-3 border-t border-slate-100 bg-slate-50/50 text-[11px] font-bold text-slate-400">
                  Showing {registryRows.length} of {SETTINGS_REGISTRY.length} settings · Current values reflect persisted (in-effect) settings. Editing happens in Grouped view.
                </div>
              </div>
            )
          )}
        </>
      )}

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
                <button onClick={() => setReviewGroup(null)} className="px-5 py-2.5 text-[10px] font-black uppercase tracking-widest text-slate-500 border border-slate-200 rounded-xl hover:bg-slate-50 transition-all cursor-pointer">Cancel</button>
                <button
                  onClick={confirmSave}
                  disabled={reviewHasHighRisk && !ackHighRisk}
                  className={`px-6 py-2.5 text-[10px] font-black uppercase tracking-widest rounded-xl transition-all ${reviewHasHighRisk && !ackHighRisk ? 'bg-slate-100 text-slate-400 cursor-not-allowed' : 'bg-primary text-white shadow-lg shadow-primary/20 hover:bg-primary/90 cursor-pointer'}`}
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
                <p className="text-sm font-bold text-slate-600">Reset <span className="text-slate-900">{resetTarget.label}</span> to its effective default{isDefaultOverridden(resetTarget, baselineOverrides) ? ' (registry default with the active baseline override applied)' : ''}.</p>
                <div className="flex items-center gap-2 text-sm font-bold flex-wrap">
                  <span className="px-2 py-1 rounded-lg bg-slate-50 border border-slate-200 text-slate-400 line-through">{formatSettingValue(resetTarget, getSettingValue(draft, resetTarget))}</span>
                  <span className="material-symbols-outlined text-slate-400 text-[16px]">arrow_forward</span>
                  <span className="px-2 py-1 rounded-lg bg-primary/5 border border-primary/20 text-primary">{formatSettingValue(resetTarget, getEffectiveDefault(resetTarget, baselineOverrides))}</span>
                </div>
                <p className="text-[11px] font-medium text-slate-400">This stages a pending change — review &amp; save the group to apply and record it.</p>
              </div>
              <div className="px-6 pb-6 flex justify-end gap-2">
                <button onClick={() => setResetTarget(null)} className="px-5 py-2.5 text-[10px] font-black uppercase tracking-widest text-slate-500 border border-slate-200 rounded-xl hover:bg-slate-50 transition-all cursor-pointer">Cancel</button>
                <button onClick={confirmReset} className="px-6 py-2.5 bg-primary text-white text-[10px] font-black uppercase tracking-widest rounded-xl shadow-lg shadow-primary/20 hover:bg-primary/90 transition-all cursor-pointer">Reset</button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* ---- Baseline change review / impact / confirmation modal ---- */}
      <AnimatePresence>
        {baselineReviewGroup && (
          <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={() => setBaselineReviewGroup(null)} className="absolute inset-0 bg-slate-900/50 backdrop-blur-md" />
            <motion.div initial={{ opacity: 0, scale: 0.95, y: 20 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: 0.95, y: 20 }} className="relative w-full max-w-xl bg-white rounded-[2rem] shadow-2xl overflow-hidden max-h-[90vh] flex flex-col">
              <div className="p-6 border-b border-slate-100">
                <h3 className="text-lg font-black text-primary tracking-tight">Review default baseline — {SETTINGS_GROUP_LABELS[baselineReviewGroup]}</h3>
                <p className="text-xs font-bold text-slate-500 mt-1">{baselineReviewDefs.length} default{baselineReviewDefs.length === 1 ? '' : 's'} will be updated. Baseline is governance reference only — enforced by nothing at runtime.</p>
              </div>
              <div className="p-6 space-y-3 overflow-y-auto">
                {baselineReviewDefs.map(def => (
                  <div key={def.key} className="border border-slate-100 rounded-2xl p-4 bg-slate-50/60">
                    <div className="flex items-center justify-between gap-2 flex-wrap">
                      <span className="text-sm font-black text-slate-800">{def.label}</span>
                      <div className="flex items-center gap-1.5">
                        <Badge text={SETTING_ENFORCEMENT_LABELS[def.enforcement]} className={ENFORCEMENT_STYLES[def.enforcement]} />
                        <Badge text={`${SETTING_RISK_LABELS[def.risk]} Risk`} className={RISK_STYLES[def.risk]} />
                      </div>
                    </div>
                    <div className="flex items-center gap-2 mt-2 text-sm font-bold flex-wrap">
                      <span className="px-2 py-1 rounded-lg bg-white border border-slate-200 text-slate-400 line-through">{formatSettingValue(def, getEffectiveDefault(def, baselineOverrides))}</span>
                      <span className="material-symbols-outlined text-slate-400 text-[16px]">arrow_forward</span>
                      <span className="px-2 py-1 rounded-lg bg-primary/5 border border-primary/20 text-primary">{formatSettingValue(def, baselineDraft[def.key])}</span>
                    </div>
                    <p className="text-[11px] font-bold text-slate-500 mt-2"><span className="text-slate-400 uppercase tracking-widest text-[10px] font-black">Registry default: </span>{formatSettingValue(def, getRegistryDefault(def))}</p>
                    <p className="text-[11px] font-bold text-slate-500 mt-1"><span className="text-slate-400 uppercase tracking-widest text-[10px] font-black">Impact: </span>{def.impactSummary}</p>
                    <p className="text-[11px] font-medium text-slate-400 mt-0.5">{def.truthLabel}</p>
                  </div>
                ))}
              </div>
              {baselineReviewHasHighRisk && (
                <div className="px-6 pb-2">
                  <div className="bg-red-500/5 border border-red-500/20 rounded-2xl p-4">
                    <p className="text-xs font-black text-red-700 uppercase tracking-widest flex items-center gap-1.5"><span className="material-symbols-outlined text-[16px]">warning</span> High-risk default change</p>
                    <p className="text-[11px] font-bold text-slate-600 mt-1">This batch changes the baseline for high-risk settings. Recorded for governance only and not enforced at runtime today.</p>
                    <label className="flex items-center gap-2 cursor-pointer mt-2">
                      <input type="checkbox" checked={baselineAck} onChange={e => setBaselineAck(e.target.checked)} className="w-4 h-4 rounded border-slate-300 text-red-600 focus:ring-red-500" />
                      <span className="text-[11px] font-bold text-slate-700">I understand and want to record this baseline change.</span>
                    </label>
                  </div>
                </div>
              )}
              <div className="p-6 border-t border-slate-100 flex justify-end gap-2">
                <button onClick={() => setBaselineReviewGroup(null)} className="px-5 py-2.5 text-[10px] font-black uppercase tracking-widest text-slate-500 border border-slate-200 rounded-xl hover:bg-slate-50 transition-all cursor-pointer">Cancel</button>
                <button
                  onClick={confirmBaselineSave}
                  disabled={baselineReviewHasHighRisk && !baselineAck}
                  className={`px-6 py-2.5 text-[10px] font-black uppercase tracking-widest rounded-xl transition-all ${baselineReviewHasHighRisk && !baselineAck ? 'bg-slate-100 text-slate-400 cursor-not-allowed' : 'bg-primary text-white shadow-lg shadow-primary/20 hover:bg-primary/90 cursor-pointer'}`}
                >
                  Confirm &amp; Save Baseline
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* ---- Baseline reset-to-registry-default confirmation ---- */}
      <AnimatePresence>
        {baselineResetTarget && (
          <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={() => setBaselineResetTarget(null)} className="absolute inset-0 bg-slate-900/50 backdrop-blur-md" />
            <motion.div initial={{ opacity: 0, scale: 0.95, y: 20 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: 0.95, y: 20 }} className="relative w-full max-w-md bg-white rounded-[2rem] shadow-2xl overflow-hidden">
              <div className="p-6 space-y-3">
                <h3 className="text-lg font-black text-primary tracking-tight">Reset baseline to registry default?</h3>
                <p className="text-sm font-bold text-slate-600">Clear the override for <span className="text-slate-900">{baselineResetTarget.label}</span> and restore the built-in registry default.</p>
                <div className="flex items-center gap-2 text-sm font-bold flex-wrap">
                  <span className="px-2 py-1 rounded-lg bg-slate-50 border border-slate-200 text-slate-400 line-through">{formatSettingValue(baselineResetTarget, baselineDraft[baselineResetTarget.key])}</span>
                  <span className="material-symbols-outlined text-slate-400 text-[16px]">arrow_forward</span>
                  <span className="px-2 py-1 rounded-lg bg-primary/5 border border-primary/20 text-primary">{formatSettingValue(baselineResetTarget, getRegistryDefault(baselineResetTarget))}</span>
                </div>
                <p className="text-[11px] font-medium text-slate-400">This stages a pending change — review &amp; save the group to apply and record it.</p>
              </div>
              <div className="px-6 pb-6 flex justify-end gap-2">
                <button onClick={() => setBaselineResetTarget(null)} className="px-5 py-2.5 text-[10px] font-black uppercase tracking-widest text-slate-500 border border-slate-200 rounded-xl hover:bg-slate-50 transition-all cursor-pointer">Cancel</button>
                <button onClick={confirmBaselineReset} className="px-6 py-2.5 bg-primary text-white text-[10px] font-black uppercase tracking-widest rounded-xl shadow-lg shadow-primary/20 hover:bg-primary/90 transition-all cursor-pointer">Reset</button>
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

const MetricCard: React.FC<{ label: string; value: number; tint?: 'amber' | 'red'; onClick: () => void }> = ({ label, value, tint, onClick }) => {
  const tintCls = tint === 'amber' ? 'text-amber-700' : tint === 'red' ? 'text-red-700' : 'text-primary';
  return (
    <button
      onClick={onClick}
      className="text-left bg-white/80 backdrop-blur-xl p-5 rounded-3xl border border-slate-200 shadow-sm hover:border-primary/40 hover:shadow-md transition-all cursor-pointer group"
    >
      <p className="text-[10px] font-black uppercase tracking-widest text-slate-400">{label}</p>
      <p className={`text-2xl font-black mt-1 ${tintCls}`}>{value}</p>
      <span className="mt-1 inline-flex items-center gap-0.5 text-[10px] font-black uppercase tracking-widest text-slate-300 group-hover:text-primary/60">
        View <span className="material-symbols-outlined text-[12px]">arrow_forward</span>
      </span>
    </button>
  );
};

const BreakdownCard: React.FC<{ title: string; icon: string; children: React.ReactNode }> = ({ title, icon, children }) => (
  <div className="bg-white/80 backdrop-blur-xl p-5 rounded-3xl border border-slate-200 shadow-sm">
    <div className="flex items-center gap-2 mb-3">
      <span className="material-symbols-outlined text-slate-400 text-[18px]">{icon}</span>
      <p className="text-[10px] font-black uppercase tracking-widest text-slate-400">{title}</p>
    </div>
    <div className="space-y-1">{children}</div>
  </div>
);

const BreakdownRow: React.FC<{ label: string; value: number; dirty?: number; muted?: boolean; onClick?: () => void }> = ({ label, value, dirty, muted, onClick }) => {
  const inner = (
    <>
      <span className="text-xs font-bold text-slate-600 flex items-center gap-1.5">
        {label}
        {!!dirty && dirty > 0 && <span className="inline-flex items-center px-1.5 py-0.5 rounded-md bg-amber-400/10 text-amber-700 border border-amber-400/20 text-[9px] font-black uppercase tracking-widest">{dirty} unsaved</span>}
      </span>
      <span className={`text-sm font-black ${muted ? 'text-slate-300' : 'text-slate-700'}`}>{value}</span>
    </>
  );
  if (!onClick) return <div className="flex items-center justify-between px-2 py-1.5 rounded-lg">{inner}</div>;
  return (
    <button onClick={onClick} className="w-full flex items-center justify-between px-2 py-1.5 rounded-lg hover:bg-slate-50 cursor-pointer transition-colors">{inner}</button>
  );
};

const StatPill: React.FC<{ label: string; value: number; tint?: 'amber' | 'red' | 'slate' }> = ({ label, value, tint = 'slate' }) => {
  const cls = tint === 'red' ? 'bg-red-500/10 text-red-700 border-red-500/20' : tint === 'amber' ? 'bg-amber-400/10 text-amber-700 border-amber-400/20' : 'bg-slate-100 text-slate-500 border-slate-200';
  return (
    <span className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl border text-[10px] font-black uppercase tracking-widest ${cls}`}>
      {label}<span className="font-black">{value}</span>
    </span>
  );
};

const ViewTab: React.FC<{ label: string; icon: string; active: boolean; onClick: () => void }> = ({ label, icon, active, onClick }) => (
  <button
    onClick={onClick}
    className={`inline-flex items-center gap-1.5 px-4 py-2 text-[10px] font-black uppercase tracking-widest rounded-xl transition-all cursor-pointer ${active ? 'bg-white text-primary shadow-sm border border-slate-200' : 'text-slate-500 hover:text-slate-700'}`}
  >
    <span className="material-symbols-outlined text-[16px]">{icon}</span>
    {label}
  </button>
);

const FilterSelect: React.FC<{ label: string; value: string; onChange: (v: string) => void; options: { value: string; label: string }[] }> = ({ label, value, onChange, options }) => (
  <label className="inline-flex items-center gap-1.5 text-[10px] font-black uppercase tracking-widest text-slate-400">
    {label}
    <select
      value={value}
      onChange={e => onChange(e.target.value)}
      className="px-2.5 py-1.5 bg-slate-50 border border-slate-200 rounded-xl text-[11px] font-bold text-slate-600 cursor-pointer"
    >
      {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  </label>
);

const ToggleChip: React.FC<{ label: string; active: boolean; onClick: () => void }> = ({ label, active, onClick }) => (
  <button
    onClick={onClick}
    className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-[10px] font-black uppercase tracking-widest rounded-xl border transition-all cursor-pointer ${active ? 'bg-primary text-white border-primary' : 'bg-white text-slate-500 border-slate-200 hover:bg-slate-50'}`}
  >
    <span className="material-symbols-outlined text-[14px]">{active ? 'check_box' : 'check_box_outline_blank'}</span>
    {label}
  </button>
);

const GroupPill: React.FC<{ label: string; active: boolean; dirty?: boolean; onClick: () => void }> = ({ label, active, dirty, onClick }) => (
  <button
    onClick={onClick}
    className={`inline-flex items-center gap-1.5 px-3 py-2 text-[10px] font-black uppercase tracking-widest rounded-xl border transition-all ${active ? 'bg-primary text-white border-primary shadow-lg shadow-primary/20' : 'bg-white text-slate-500 border-slate-200 hover:bg-slate-50'}`}
  >
    {label}
    {dirty && <span className={`w-1.5 h-1.5 rounded-full ${active ? 'bg-white' : 'bg-amber-500'}`} />}
  </button>
);

const ModeTab: React.FC<{ label: string; icon: string; active: boolean; dirty?: boolean; onClick: () => void }> = ({ label, icon, active, dirty, onClick }) => (
  <button
    onClick={onClick}
    className={`inline-flex items-center gap-1.5 px-4 py-2 text-[10px] font-black uppercase tracking-widest rounded-xl transition-all cursor-pointer ${active ? 'bg-white text-primary shadow-sm border border-slate-200' : 'text-slate-500 hover:text-slate-700'}`}
  >
    <span className="material-symbols-outlined text-[16px]">{icon}</span>
    {label}
    {dirty && <span className="w-1.5 h-1.5 rounded-full bg-amber-500" />}
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
  baseline?: boolean;
  onChange: (v: SettingPrimitive) => void;
  onReset: () => void;
}> = ({ def, value, defaultValue, modified, changed, canEdit, baseline, onChange, onReset }) => (
  <div className={`border rounded-3xl p-5 bg-white/60 space-y-3 ${changed ? 'border-amber-300 ring-1 ring-amber-200' : 'border-slate-100'}`}>
    <div className="flex items-start justify-between gap-3 flex-wrap">
      <div className="flex-1 min-w-[200px]">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm font-black text-slate-800">{def.label}</span>
          {changed && <Badge text="Unsaved" className="bg-amber-400/10 text-amber-700 border-amber-400/20" />}
          {!changed && modified && <Badge text={baseline ? 'Overridden' : 'Modified'} className="bg-slate-100 text-slate-500 border-slate-200" />}
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
      <Meta label={baseline ? 'Registry default' : 'Default'} value={formatSettingValue(def, defaultValue)} />
      <Meta label="Impact" value={def.impactSummary} full />
      <Meta label="Truth" value={def.truthLabel} full muted />
    </div>
    <div className="flex items-center justify-between gap-3">
      <p className="text-[10px] font-mono text-slate-300">key: {def.key}</p>
      {canEdit && modified && (
        <button onClick={onReset} className="inline-flex items-center gap-1 text-[10px] font-black uppercase tracking-widest text-slate-400 hover:text-primary transition-all cursor-pointer">
          <span className="material-symbols-outlined text-[14px]">restart_alt</span> {baseline ? 'Reset to registry default' : 'Reset to default'}
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
