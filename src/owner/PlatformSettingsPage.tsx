import React, { useEffect, useMemo, useState } from 'react';
import { platformDefaults, type PlatformDefaults } from './mockData';
import { pushPlatformAudit } from './platformOpsAudit';

const STORAGE_KEY = 'platform_settings_v1';

type SettingsGroup = 'branding' | 'maintenance' | 'security' | 'support';

const GROUP_LABELS: Record<SettingsGroup, string> = {
  branding: 'Branding',
  maintenance: 'Maintenance',
  security: 'Security Defaults',
  support: 'Support Contacts',
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

const diffGroup = <T extends Record<string, unknown>>(prev: T, next: T): string => {
  const changes: string[] = [];
  Object.keys(next).forEach(k => {
    const a = prev[k];
    const b = next[k];
    if (JSON.stringify(a) !== JSON.stringify(b)) {
      changes.push(`${k}: ${JSON.stringify(a)} → ${JSON.stringify(b)}`);
    }
  });
  return changes.join('; ');
};

const PlatformSettingsPage: React.FC = () => {
  const [persisted, setPersisted] = useState<PlatformDefaults>(() => loadSettings());
  const [draft, setDraft] = useState<PlatformDefaults>(persisted);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [savingGroup, setSavingGroup] = useState<SettingsGroup | null>(null);

  useEffect(() => {
    setDraft(persisted);
  }, [persisted]);

  const dirtyGroups = useMemo<Record<SettingsGroup, boolean>>(() => ({
    branding: JSON.stringify(persisted.branding) !== JSON.stringify(draft.branding),
    maintenance: JSON.stringify(persisted.maintenance) !== JSON.stringify(draft.maintenance),
    security: JSON.stringify(persisted.security) !== JSON.stringify(draft.security),
    support: JSON.stringify(persisted.support) !== JSON.stringify(draft.support),
  }), [persisted, draft]);

  const persistGroup = (group: SettingsGroup) => {
    const next: PlatformDefaults = { ...persisted, [group]: draft[group] } as PlatformDefaults;
    const summary = diffGroup(persisted[group] as any, draft[group] as any);
    if (!summary) return;
    saveSettings(next);
    setPersisted(next);
    setSavedAt(new Date().toLocaleString());
    setSavingGroup(group);
    setTimeout(() => setSavingGroup(null), 1200);
    pushPlatformAudit({
      actor: 'System Owner',
      action: 'platform_setting_updated',
      target: GROUP_LABELS[group],
      category: 'configuration',
      severity: 'notice',
      note: summary,
    });
  };

  return (
    <div className="space-y-8">
      <div>
        <h2 className="text-2xl font-black text-primary tracking-tight">Platform Settings</h2>
        <p className="text-slate-500 font-medium">Global defaults consumed across the System Owner control panel.{savedAt && <span className="ml-2 text-xs text-slate-400">Last saved: {savedAt}</span>}</p>
      </div>

      {/* Branding */}
      <SectionCard title="Branding" subtitle="Display name and logo used across owner-facing surfaces.">
        <Field label="Platform Name">
          <input value={draft.branding.name} onChange={e => setDraft(d => ({ ...d, branding: { ...d.branding, name: e.target.value } }))} className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-2xl text-sm font-bold text-slate-700" />
        </Field>
        <Field label="Public Support Email">
          <input value={draft.branding.supportEmail} onChange={e => setDraft(d => ({ ...d, branding: { ...d.branding, supportEmail: e.target.value } }))} type="email" className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-2xl text-sm font-bold text-slate-700" />
        </Field>
        <Field label="Logo URL">
          <input value={draft.branding.logoUrl} onChange={e => setDraft(d => ({ ...d, branding: { ...d.branding, logoUrl: e.target.value } }))} className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-2xl text-sm font-bold text-slate-700" />
        </Field>
        <SaveRow group="branding" dirty={dirtyGroups.branding} saving={savingGroup === 'branding'} onSave={persistGroup} />
      </SectionCard>

      {/* Maintenance */}
      <SectionCard title="Maintenance" subtitle="Maintenance flag is consumed by display banners only — the app does NOT block traffic when enabled.">
        <Field label="">
          <label className="flex items-center gap-3 cursor-pointer">
            <input type="checkbox" checked={draft.maintenance.enabled} onChange={e => setDraft(d => ({ ...d, maintenance: { ...d.maintenance, enabled: e.target.checked } }))} className="w-5 h-5 rounded-lg border-slate-300 text-primary focus:ring-primary" />
            <span className="text-sm font-bold text-slate-700">Enable Maintenance Mode <span className="text-[10px] uppercase tracking-widest text-amber-600 font-black ml-2">Banner only — not enforced</span></span>
          </label>
        </Field>
        <Field label="Maintenance Message">
          <textarea value={draft.maintenance.message} onChange={e => setDraft(d => ({ ...d, maintenance: { ...d.maintenance, message: e.target.value } }))} className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-2xl text-sm text-slate-700 h-20 resize-none" placeholder="Optional message displayed to tenants." />
        </Field>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Field label="Scheduled Start">
            <input type="datetime-local" value={draft.maintenance.scheduledStart} onChange={e => setDraft(d => ({ ...d, maintenance: { ...d.maintenance, scheduledStart: e.target.value } }))} className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-2xl text-sm font-bold text-slate-700" />
          </Field>
          <Field label="Scheduled End">
            <input type="datetime-local" value={draft.maintenance.scheduledEnd} onChange={e => setDraft(d => ({ ...d, maintenance: { ...d.maintenance, scheduledEnd: e.target.value } }))} className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-2xl text-sm font-bold text-slate-700" />
          </Field>
        </div>
        <SaveRow group="maintenance" dirty={dirtyGroups.maintenance} saving={savingGroup === 'maintenance'} onSave={persistGroup} />
      </SectionCard>

      {/* Security */}
      <SectionCard title="Security Defaults" subtitle="These values are documentation only — no runtime auth/MFA enforcement is wired today.">
        <Field label="Session Timeout (minutes) — Documentation only">
          <input type="number" min={5} max={1440} value={draft.security.sessionTimeoutMinutes} onChange={e => setDraft(d => ({ ...d, security: { ...d.security, sessionTimeoutMinutes: Number(e.target.value) || 60 } }))} className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-2xl text-sm font-bold text-slate-700" />
        </Field>
        <Field label="">
          <label className="flex items-center gap-3 cursor-pointer">
            <input type="checkbox" checked={draft.security.requireMfaForPlatformAdmins} onChange={e => setDraft(d => ({ ...d, security: { ...d.security, requireMfaForPlatformAdmins: e.target.checked } }))} className="w-5 h-5 rounded-lg border-slate-300 text-primary focus:ring-primary" />
            <span className="text-sm font-bold text-slate-700">Require MFA for Platform Admins <span className="text-[10px] uppercase tracking-widest text-amber-600 font-black ml-2">Documentation only — not enforced</span></span>
          </label>
        </Field>
        <SaveRow group="security" dirty={dirtyGroups.security} saving={savingGroup === 'security'} onSave={persistGroup} />
      </SectionCard>

      {/* Support */}
      <SectionCard title="Support Contacts" subtitle="Internal operations directory — surfaced in tenant Help footers and ops runbooks.">
        <Field label="Support Email">
          <input value={draft.support.supportEmail} onChange={e => setDraft(d => ({ ...d, support: { ...d.support, supportEmail: e.target.value } }))} type="email" className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-2xl text-sm font-bold text-slate-700" />
        </Field>
        <Field label="On-Call Phone">
          <input value={draft.support.onCallPhone} onChange={e => setDraft(d => ({ ...d, support: { ...d.support, onCallPhone: e.target.value } }))} className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-2xl text-sm font-bold text-slate-700" placeholder="+1 555 000 0000" />
        </Field>
        <Field label="Status Page URL">
          <input value={draft.support.statusPageUrl} onChange={e => setDraft(d => ({ ...d, support: { ...d.support, statusPageUrl: e.target.value } }))} className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-2xl text-sm font-bold text-slate-700" />
        </Field>
        <SaveRow group="support" dirty={dirtyGroups.support} saving={savingGroup === 'support'} onSave={persistGroup} />
      </SectionCard>
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

const Field: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <div>
    {label && <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1 block">{label}</label>}
    {children}
  </div>
);

const SaveRow: React.FC<{ group: SettingsGroup; dirty: boolean; saving: boolean; onSave: (g: SettingsGroup) => void }> = ({ group, dirty, saving, onSave }) => (
  <div className="flex justify-end pt-2">
    <button
      onClick={() => onSave(group)}
      disabled={!dirty || saving}
      className={`px-6 py-2.5 text-[10px] font-black uppercase tracking-widest rounded-xl transition-all ${saving ? 'bg-emerald-500 text-white' : dirty ? 'bg-primary text-white shadow-lg shadow-primary/20 hover:bg-primary/90' : 'bg-slate-100 text-slate-400 cursor-not-allowed'}`}
    >
      {saving ? 'Saved!' : dirty ? `Save ${GROUP_LABELS[group]}` : 'No Changes'}
    </button>
  </div>
);

export default PlatformSettingsPage;
