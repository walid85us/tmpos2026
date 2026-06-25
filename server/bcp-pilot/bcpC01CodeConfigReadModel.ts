// Phase 2.0 M7K — DEV-only code/config C-01 Readiness Summary posture source.
//
// WHAT THIS IS: a PURE, SYNCHRONOUS, NO-THROW builder that maps the BCP route's OWN code/config
// posture into the `SyntheticReadinessSource` shape the M7C/M7E envelope already consumes. It is
// the first "live" C-01 source ONLY in the sense that it reflects current SERVER CODE/CONFIG state
// (feature-flag posture, route-registration constant, production-disabled gate, redaction path,
// source mode, static parity, phase boundary, isolation evidence).
//
// BINDING SAFETY — reads NOTHING live:
//   - No DB, no Supabase, no provider, no fetch, no network.
//   - No filesystem reads, no test execution, no typecheck execution (S-7/S-8 are NOT emitted here;
//     they remain documentation/evidence labels per M7J, never run at request time).
//   - No Express router introspection (S-2 derives from the path CONSTANT passed in, never the live
//     router).
//   - No tenant/store/customer data, identity_link rows, audit rows, raw auth claims, provider UIDs,
//     permission/entitlement keys, mismatch lists, secrets, tokens, DB URLs, or emails.
//   - S-11 (DB/Supabase counts) is BLOCKED — not emitted. S-12 (tenant/store/identity_link/audit)
//     is OUT OF SCOPE — not emitted. S-10 parity is a STATIC/config label only — never computed
//     from identity.
//
// All inputs are server-derived primitives supplied by the adapter (never the request, never a DB).
// Output is safe bounded posture LABELS only, routed through the existing redaction/envelope path
// (the harness independently strips forbidden keys and content-validates every label). Server-side
// only. Never imported by src/ (the client bundle).

import type { SyntheticReadinessSource, ReadinessEnvelopeMeta } from './bcpReadinessSummaryHarness';

/**
 * M7O — honest, additive envelope metadata for the code/config path. Bounded safe labels only;
 * the harness independently content-validates each. The synthetic test path keeps the v0 defaults.
 */
export const C01_CODE_CONFIG_ENVELOPE_META: ReadinessEnvelopeMeta = {
  schemaVersion: 'bcp.c01.readiness.v1-code-config',
  sourceMode: 'code_config',
  warnings: ['code_config'],
  lastSuccessfulReadLabel: 'code-config-no-live-read',
};

/** Server-derived inputs (resolved by the adapter; never from the request, never from a DB). */
export interface C01CodeConfigInput {
  /** The known route path CONSTANT (passed in; never live router introspection). Source S-2. */
  routePath: string;
  /** True when the process is non-production (server-derived from NODE_ENV). Source S-3. */
  isDevEnvironment: boolean;
  /** Resolved, production-aware feature-flag state (isBcpDevReadonlyPilotEnabled()). Source S-1. */
  featureEnabled: boolean;
}

/** Safe posture category shape (mirrors BcpReadinessCategory; bounded labels only). The index
 * signature keeps the named fields typed while satisfying the harness's Record<string, unknown>
 * category type (which independently allow-lists and content-validates the fields it reads). */
interface C01PostureCategory {
  category: string;
  status: string;
  severity: 'low' | 'medium' | 'high';
  [key: string]: unknown;
}

/**
 * Build the code/config C-01 posture source. PURE + NO-THROW. Emits only safe bounded labels:
 *   S-1 feature_flag_posture, S-2 route_registration_posture, S-3 production_disabled_posture,
 *   S-4 redaction_posture, S-5 synthetic_live_boundary_posture (now code_config_only),
 *   S-10 parity_posture (static/config label only), S-6 phase_boundary_posture, S-9 isolation_posture.
 * Deliberately emits NO S-7/S-8 (test/typecheck — never run at request time), NO S-11 (DB/Supabase
 * counts — blocked), and NO S-12 (tenant/store/identity_link/audit — out of scope).
 */
export function buildC01CodeConfigSource(input: C01CodeConfigInput): SyntheticReadinessSource {
  const routeRegistered = typeof input.routePath === 'string' && input.routePath.trim().length > 0;

  const categories: C01PostureCategory[] = [
    // S-1 — feature-flag posture (resolved, production-aware boolean → label).
    { category: 'feature_flag_posture', status: input.featureEnabled ? 'enabled' : 'disabled', severity: 'low' },
    // S-2 — route-registration posture, derived from the path CONSTANT (never the live router).
    { category: 'route_registration_posture', status: routeRegistered ? 'ready' : 'guarded', severity: 'low' },
    // S-3 — the route is production-disabled by design; report the guarded posture.
    { category: 'production_disabled_posture', status: input.isDevEnvironment ? 'production_disabled' : 'blocked', severity: 'low' },
    // S-4 — redaction/forbidden-field stripping path is active.
    { category: 'redaction_posture', status: 'ready', severity: 'low' },
    // S-5 — source mode: this milestone reads code/config posture (no synthetic stub, no live data).
    { category: 'synthetic_live_boundary_posture', status: 'code_config_only', severity: 'low' },
    // S-10 — parity posture is a STATIC/config label only; never a live identity-derived computation.
    { category: 'parity_posture', status: 'static_config', severity: 'low' },
    // S-6 — phase boundary: live read-only / controlled actions / production remain gated.
    { category: 'phase_boundary_posture', status: 'guarded', severity: 'low' },
    // S-9 — isolation posture is a documentation/evidence label (platform-level; no tenant/store data).
    { category: 'isolation_posture', status: 'evidence_only', severity: 'low' },
  ];

  // Only `categories` — no top-level forbidden keys, no raw source object, no passthrough.
  return { categories };
}
