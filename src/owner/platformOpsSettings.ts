// =============================================================================
// Platform Settings Governance Model (Phase 1.2 · Milestone 3)
// -----------------------------------------------------------------------------
// A deterministic, rule-based registry that describes every platform setting
// with governance metadata. This module is the SINGLE source of truth for the
// Platform Settings surface: keys, labels, descriptions, groups, default
// values, enforcement state, risk level, owner, impact summary, and truth
// labels all live here so the page and any consumer cannot drift.
//
// Scope / truth constraints (locked for this phase):
//   - No setting on this page is ENFORCED at runtime today. Values drive
//     display surfaces, informational banners, or governance documentation.
//   - No real notifications, SSO/SCIM, external integrations, or provider
//     calls. Real enforcement (session policy / MFA / SSO / SCIM) is future
//     work and is labelled as such.
//   - `enforced` exists in the vocabulary for completeness but is NOT assigned
//     to any current setting (mirrors the Domains `draft` decision in M1).
//
// Milestone 3 delivers the MODEL + a registry-driven governance view. The
// change-review / impact-preview-on-save / audit-timeline UX is Milestone 4.
// =============================================================================

import { platformDefaults, type PlatformDefaults } from './mockData';

export type SettingsGroup = 'branding' | 'maintenance' | 'security' | 'support';

export type SettingValueType =
  | 'text'
  | 'email'
  | 'url'
  | 'multiline'
  | 'boolean'
  | 'number'
  | 'datetime';

// How much the platform actually does with this value today. None of the
// current settings are `enforced`; the honest governance picture is that they
// drive display, advisory banners, or documentation only.
export type SettingEnforcement =
  | 'enforced'
  | 'advisory'
  | 'display_only'
  | 'documentation_only';

export type SettingRisk = 'low' | 'medium' | 'high';

export type SettingPrimitive = string | number | boolean;

export interface SettingDefinition {
  /** Stable unique key, e.g. `branding.name`. */
  key: string;
  group: SettingsGroup;
  /** Field name within the group object in PlatformDefaults. */
  field: string;
  label: string;
  description: string;
  valueType: SettingValueType;
  enforcement: SettingEnforcement;
  risk: SettingRisk;
  owner: string;
  /** One-line summary of what changing this value affects. */
  impactSummary: string;
  /** Honest statement of what the app does (and does not) do with the value. */
  truthLabel: string;
  min?: number;
  max?: number;
  placeholder?: string;
}

export const SETTINGS_GROUP_LABELS: Record<SettingsGroup, string> = {
  branding: 'Branding',
  maintenance: 'Maintenance',
  security: 'Security Defaults',
  support: 'Support Contacts',
};

export const SETTINGS_GROUP_DESCRIPTIONS: Record<SettingsGroup, string> = {
  branding: 'Display name, logo, and public contact shown across owner- and tenant-facing surfaces.',
  maintenance: 'Maintenance banner content and schedule. Display only — traffic is never blocked.',
  security: 'Security expectations recorded for governance. Not enforced by the app today.',
  support: 'Internal operations directory surfaced in help footers and runbooks.',
};

export const SETTINGS_GROUP_ORDER: SettingsGroup[] = ['branding', 'maintenance', 'security', 'support'];

export const SETTING_ENFORCEMENT_LABELS: Record<SettingEnforcement, string> = {
  enforced: 'Enforced',
  advisory: 'Advisory',
  display_only: 'Display Only',
  documentation_only: 'Documentation Only',
};

export const SETTING_ENFORCEMENT_ORDER: SettingEnforcement[] = [
  'enforced',
  'advisory',
  'display_only',
  'documentation_only',
];

export const SETTING_RISK_LABELS: Record<SettingRisk, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
};

export const SETTING_RISK_ORDER: SettingRisk[] = ['high', 'medium', 'low'];

export const SETTINGS_TRUTH_LABELS = {
  governance: 'Governance metadata is rule-based from the settings registry.',
  notEnforced: 'No setting here is enforced at runtime today — values drive display, banners, or documentation only.',
  future: 'Real enforcement (session policy, MFA, SSO/SCIM) is future work.',
} as const;

// -----------------------------------------------------------------------------
// The registry. One entry per field in PlatformDefaults.
// -----------------------------------------------------------------------------
export const SETTINGS_REGISTRY: SettingDefinition[] = [
  // --- Branding -------------------------------------------------------------
  {
    key: 'branding.name',
    group: 'branding',
    field: 'name',
    label: 'Platform Name',
    description: 'Display name used across owner-facing surfaces.',
    valueType: 'text',
    enforcement: 'display_only',
    risk: 'low',
    owner: 'Brand & Communications',
    impactSummary: 'Changes the display name shown across owner and tenant-facing surfaces.',
    truthLabel: 'Shown in UI surfaces only — no enforcement logic.',
    placeholder: 'RepairPlatform',
  },
  {
    key: 'branding.supportEmail',
    group: 'branding',
    field: 'supportEmail',
    label: 'Public Support Email',
    description: 'Support address surfaced to tenants.',
    valueType: 'email',
    enforcement: 'display_only',
    risk: 'low',
    owner: 'Brand & Communications',
    impactSummary: 'Updates the public support email shown in tenant help footers.',
    truthLabel: 'Displayed in help surfaces only — no mail is sent by the app.',
    placeholder: 'support@repairplatform.com',
  },
  {
    key: 'branding.logoUrl',
    group: 'branding',
    field: 'logoUrl',
    label: 'Logo URL',
    description: 'Logo asset referenced across owner surfaces.',
    valueType: 'url',
    enforcement: 'display_only',
    risk: 'low',
    owner: 'Brand & Communications',
    impactSummary: 'Points owner-facing surfaces at a different logo asset.',
    truthLabel: 'Referenced for display only — the asset is not validated or uploaded.',
    placeholder: '/logo.png',
  },
  // --- Maintenance ----------------------------------------------------------
  {
    key: 'maintenance.enabled',
    group: 'maintenance',
    field: 'enabled',
    label: 'Maintenance Mode',
    description: 'Toggles the maintenance banner.',
    valueType: 'boolean',
    enforcement: 'advisory',
    risk: 'medium',
    owner: 'Platform Operations',
    impactSummary: 'Shows or hides the maintenance banner. Does not block tenant traffic.',
    truthLabel: 'Drives an informational banner only — traffic is never blocked.',
  },
  {
    key: 'maintenance.message',
    group: 'maintenance',
    field: 'message',
    label: 'Maintenance Message',
    description: 'Body shown in the maintenance banner.',
    valueType: 'multiline',
    enforcement: 'advisory',
    risk: 'low',
    owner: 'Platform Operations',
    impactSummary: 'Sets the message body displayed in the maintenance banner when enabled.',
    truthLabel: 'Banner copy only — no notification is sent.',
    placeholder: 'Optional message displayed to tenants.',
  },
  {
    key: 'maintenance.scheduledStart',
    group: 'maintenance',
    field: 'scheduledStart',
    label: 'Scheduled Start',
    description: 'Informational maintenance start time.',
    valueType: 'datetime',
    enforcement: 'advisory',
    risk: 'low',
    owner: 'Platform Operations',
    impactSummary: 'Informational scheduled-start shown alongside the maintenance banner.',
    truthLabel: 'Displayed for reference only — no schedule is executed.',
  },
  {
    key: 'maintenance.scheduledEnd',
    group: 'maintenance',
    field: 'scheduledEnd',
    label: 'Scheduled End',
    description: 'Informational maintenance end time.',
    valueType: 'datetime',
    enforcement: 'advisory',
    risk: 'low',
    owner: 'Platform Operations',
    impactSummary: 'Informational scheduled-end shown alongside the maintenance banner.',
    truthLabel: 'Displayed for reference only — no schedule is executed.',
  },
  // --- Security -------------------------------------------------------------
  {
    key: 'security.sessionTimeoutMinutes',
    group: 'security',
    field: 'sessionTimeoutMinutes',
    label: 'Session Timeout (minutes)',
    description: 'Intended idle session timeout.',
    valueType: 'number',
    enforcement: 'documentation_only',
    risk: 'high',
    owner: 'Security & Compliance',
    impactSummary: 'Documents the intended idle session timeout for platform admins.',
    truthLabel: 'Recorded for governance only — no session policy is enforced today.',
    min: 5,
    max: 1440,
  },
  {
    key: 'security.requireMfaForPlatformAdmins',
    group: 'security',
    field: 'requireMfaForPlatformAdmins',
    label: 'Require MFA for Platform Admins',
    description: 'Intended MFA requirement for platform admins.',
    valueType: 'boolean',
    enforcement: 'documentation_only',
    risk: 'high',
    owner: 'Security & Compliance',
    impactSummary: 'Documents the MFA expectation for platform administrators.',
    truthLabel: 'Recorded for governance only — MFA is not enforced today.',
  },
  // --- Support --------------------------------------------------------------
  {
    key: 'support.supportEmail',
    group: 'support',
    field: 'supportEmail',
    label: 'Support Email',
    description: 'Operations support email.',
    valueType: 'email',
    enforcement: 'display_only',
    risk: 'low',
    owner: 'Support Operations',
    impactSummary: 'Operations support email used in runbooks and help footers.',
    truthLabel: 'Displayed in operations surfaces only — no mail is sent.',
    placeholder: 'support@repairplatform.com',
  },
  {
    key: 'support.onCallPhone',
    group: 'support',
    field: 'onCallPhone',
    label: 'On-Call Phone',
    description: 'On-call operations number.',
    valueType: 'text',
    enforcement: 'display_only',
    risk: 'medium',
    owner: 'Support Operations',
    impactSummary: 'On-call number surfaced to internal operators.',
    truthLabel: 'Displayed to internal operators only — no call/SMS is placed.',
    placeholder: '+1 555 000 0000',
  },
  {
    key: 'support.statusPageUrl',
    group: 'support',
    field: 'statusPageUrl',
    label: 'Status Page URL',
    description: 'External status page link.',
    valueType: 'url',
    enforcement: 'display_only',
    risk: 'low',
    owner: 'Support Operations',
    impactSummary: 'External status page link surfaced in help surfaces.',
    truthLabel: 'Linked for display only — the page is not monitored by the app.',
  },
];

// -----------------------------------------------------------------------------
// Pure helpers
// -----------------------------------------------------------------------------
const readField = (settings: PlatformDefaults, def: SettingDefinition): SettingPrimitive => {
  const group = settings[def.group] as Record<string, SettingPrimitive>;
  return group[def.field];
};

/** Current value of a setting in the provided settings object. */
export const getSettingValue = (settings: PlatformDefaults, def: SettingDefinition): SettingPrimitive =>
  readField(settings, def);

/** Registry (seed/code) default value of a setting — the immutable baseline. */
export const getSettingDefault = (def: SettingDefinition): SettingPrimitive =>
  readField(platformDefaults, def);

/** Alias of {@link getSettingDefault} for call sites that want the explicit name. */
export const getRegistryDefault = (def: SettingDefinition): SettingPrimitive =>
  getSettingDefault(def);

// ---------------------------------------------------------------------------
// Default Baseline overrides (Phase 1.2 acceptance correction).
// A System Owner may maintain an org-specific "default baseline" that overrides
// the registry default for selected settings. This is a separate, persisted
// overlay keyed by setting key — it never mutates the registry and is purely a
// governance reference (still nothing enforced at runtime). `getEffectiveDefault`
// returns the maintained baseline when present, otherwise the registry default.
// ---------------------------------------------------------------------------

export type SettingsDefaultsOverride = Record<string, SettingPrimitive>;

const hasOverride = (overrides: SettingsDefaultsOverride | undefined, def: SettingDefinition): boolean =>
  !!overrides && Object.prototype.hasOwnProperty.call(overrides, def.key);

/** Effective default = maintained baseline override (if any) else registry default. */
export const getEffectiveDefault = (
  def: SettingDefinition,
  overrides?: SettingsDefaultsOverride,
): SettingPrimitive =>
  hasOverride(overrides, def) ? (overrides as SettingsDefaultsOverride)[def.key] : getSettingDefault(def);

/** Whether a maintained baseline override exists AND differs from the registry default. */
export const isDefaultOverridden = (
  def: SettingDefinition,
  overrides?: SettingsDefaultsOverride,
): boolean =>
  hasOverride(overrides, def) &&
  JSON.stringify((overrides as SettingsDefaultsOverride)[def.key]) !== JSON.stringify(getSettingDefault(def));

/**
 * Whether the current value differs from its EFFECTIVE default (maintained
 * baseline if present, else registry default). `overrides` is optional and
 * defaults to the registry default — fully backward compatible.
 */
export const isSettingModified = (
  settings: PlatformDefaults,
  def: SettingDefinition,
  overrides?: SettingsDefaultsOverride,
): boolean =>
  JSON.stringify(getSettingValue(settings, def)) !== JSON.stringify(getEffectiveDefault(def, overrides));

/** Human-readable rendering of a setting value (for summaries / chips). */
export const formatSettingValue = (def: SettingDefinition, value: SettingPrimitive): string => {
  if (def.valueType === 'boolean') return value ? 'On' : 'Off';
  if (value === '' || value === null || value === undefined) return '—';
  return String(value);
};

export const getSettingByKey = (key: string): SettingDefinition | undefined =>
  SETTINGS_REGISTRY.find(d => d.key === key);

export const getSettingsForGroup = (group: SettingsGroup): SettingDefinition[] =>
  SETTINGS_REGISTRY.filter(d => d.group === group);

export interface SettingsPosture {
  total: number;
  modified: number;
  highRisk: number;
  highRiskModified: number;
  documentationOnly: number;
  byGroup: Record<SettingsGroup, number>;
  byRisk: Record<SettingRisk, number>;
  byEnforcement: Record<SettingEnforcement, number>;
}

/**
 * Rule-based governance posture derived from the live settings object. When a
 * maintained baseline `overrides` map is supplied, "modified" is measured
 * against the effective default (baseline) rather than the registry default —
 * keeping posture honest with the Default Baseline panel. Backward compatible.
 */
export const deriveSettingsPosture = (
  settings: PlatformDefaults,
  overrides?: SettingsDefaultsOverride,
): SettingsPosture => {
  const byGroup: Record<SettingsGroup, number> = { branding: 0, maintenance: 0, security: 0, support: 0 };
  const byRisk: Record<SettingRisk, number> = { low: 0, medium: 0, high: 0 };
  const byEnforcement: Record<SettingEnforcement, number> = {
    enforced: 0,
    advisory: 0,
    display_only: 0,
    documentation_only: 0,
  };
  let modified = 0;
  let highRisk = 0;
  let highRiskModified = 0;

  SETTINGS_REGISTRY.forEach(def => {
    byGroup[def.group] += 1;
    byRisk[def.risk] += 1;
    byEnforcement[def.enforcement] += 1;
    const isMod = isSettingModified(settings, def, overrides);
    if (isMod) modified += 1;
    if (def.risk === 'high') {
      highRisk += 1;
      if (isMod) highRiskModified += 1;
    }
  });

  return {
    total: SETTINGS_REGISTRY.length,
    modified,
    highRisk,
    highRiskModified,
    documentationOnly: byEnforcement.documentation_only,
    byGroup,
    byRisk,
    byEnforcement,
  };
};
