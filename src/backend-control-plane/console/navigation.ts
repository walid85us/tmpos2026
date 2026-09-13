// Phase 4.0 M4 — the console's navigation: the accepted platform feature vocabulary. The home
// entry is the Command Center (CommandCenterPage.tsx), the one read-only dashboard; every other
// entry is a placeholder with no implemented destination yet. An entry is a destination, never a
// grant — the server decides what a session may do (docs/phase-4/03 §6).

import { CONSOLE_BASE } from './adminSurface';

export const CONSOLE_HOME = CONSOLE_BASE;
export const CONSOLE_HOME_LABEL = 'Command Center';
export const CONSOLE_HOME_SUMMARY = 'Platform posture, the work that needs attention, governance signals and service health.';
export const SIGN_IN_PATH = `${CONSOLE_BASE}/sign-in`;

export interface ConsoleModule {
  readonly slug: string;
  readonly label: string;
  readonly summary: string;
}

export interface ConsoleGroup {
  readonly label: string;
  readonly modules: readonly ConsoleModule[];
}

export const CONSOLE_GROUPS: readonly ConsoleGroup[] = [
  {
    label: 'Operations',
    modules: [
      { slug: 'audit-security', label: 'Audit & Security', summary: 'Administrative activity, sign-in history and security posture.' },
      { slug: 'support-tools', label: 'Support Tools', summary: 'Find tenants and help with their support cases.' },
    ],
  },
  {
    label: 'Tenants',
    modules: [
      { slug: 'tenant-management', label: 'Tenant Management', summary: 'Tenant accounts, their stores and their lifecycle status.' },
      { slug: 'provisioning', label: 'Provisioning', summary: 'Create and onboard new tenants.' },
      { slug: 'domains', label: 'Domains', summary: 'Tenant web addresses and domain verification.' },
    ],
  },
  {
    label: 'Commercial',
    modules: [
      { slug: 'billing-subscriptions', label: 'Billing & Subscriptions', summary: 'Plans, subscriptions, invoices and payment status.' },
      { slug: 'feature-matrix', label: 'Feature Matrix', summary: 'Which features each plan includes.' },
      { slug: 'add-on-governance', label: 'Add-on Governance', summary: 'Add-on availability, compatibility and pricing rules.' },
    ],
  },
  {
    label: 'Platform',
    modules: [
      { slug: 'platform-settings', label: 'Platform Settings', summary: 'Platform-wide defaults and configuration.' },
      { slug: 'team-management', label: 'Team Management', summary: 'Platform operators and the access they hold.' },
    ],
  },
];

export const CONSOLE_MODULES: readonly ConsoleModule[] = CONSOLE_GROUPS.flatMap((group) => group.modules);

export const modulePath = (module: ConsoleModule): string => `${CONSOLE_BASE}/${module.slug}`;

const RETURN_PATHS: ReadonlySet<string> = new Set([CONSOLE_HOME, ...CONSOLE_MODULES.map(modulePath)]);

/**
 * Where to go after signing in: `candidate` only when it is exactly one of the console's own
 * pages, otherwise the console home. Exact membership rejects every other shape at once —
 * another origin, protocol-relative and backslash forms, encodings, traversal, queries,
 * fragments, the sign-in page itself and the /admin/v1 API namespace.
 */
export function safeReturnPath(candidate: unknown): string {
  return typeof candidate === 'string' && RETURN_PATHS.has(candidate) ? candidate : CONSOLE_HOME;
}
