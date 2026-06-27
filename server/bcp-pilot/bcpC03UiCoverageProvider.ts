// Phase 2.0 M12 — Safe server-owned C-03 Backend CP UI coverage / screen readiness provider.
//
// WHAT THIS IS: a PURE, server-owned, code/config-only source of Backend Control Plane UI coverage
// entries for the C-03 readiness lens. It feeds the C-03 read model through the accepted getModules-style
// dependency seam, exactly mirroring the proven M10 C-02 provider pattern.
//
// BINDING SAFETY — reads NOTHING live and crosses NO boundary:
//   - PURE + DETERMINISTIC + NO-THROW + side-effect-free. No I/O of any kind.
//   - No DB, no Supabase, no createClient, no getDb, no DATABASE url, no provider / live / network /
//     fetch / filesystem. No process.env. No request. No auth / session / principal. No tenant / store /
//     customer / identity / audit dependency. No mutation. No backend action.
//   - No import from src/ (the client bundle); no mockData import; no sensitive row-shaped type import.
//     The ONLY imports are TYPE-ONLY enum unions from the frozen C-03 read model (erased at runtime).
//   - Emits ONLY safe bounded labels/enums. NEVER a raw id / UUID / secret / token / DB url / email /
//     domain / filename / raw component name / source path / permission or RBAC key / tenant / store /
//     customer / identity / audit value.
//   - The exported constant is DEEPLY FROZEN; getBcpC03UiCoverageEntries() returns a FRESH defensive copy.
//
// SOURCE: a server-authored constant that CONCEPTUALLY MIRRORS the Backend CP screen/preview-card set by
// code/config inspection ONLY (NO runtime import of the frontend screens). Labels are intentionally
// re-expressed as safe bounded labels. 14 entries (bounded; documented in the tests).

import type {
  C03ScreenStatus,
  C03CoverageClass,
  C03SubStatus,
  C03DataSourceClass,
  C03DevGatePosture,
  C03ProductionPosture,
  C03ReadOnlyPosture,
  C03MutationPosture,
  C03ExposurePosture,
  C03EvidenceStatus,
} from './bcpC03UiCoverageReadModel';

/** Safe, server-owned UI coverage entry — accepted bounded fields only. */
export interface BcpC03UiCoverageEntry {
  screenKey: string;
  screenLabel: string;
  screenStatus: C03ScreenStatus;
  coverageClass: C03CoverageClass;
  previewCardStatus: C03SubStatus;
  clientStatus: C03SubStatus;
  routeStatus: C03SubStatus;
  dataSourceClass: C03DataSourceClass;
  devGatePosture: C03DevGatePosture;
  productionPosture: C03ProductionPosture;
  readOnlyPosture: C03ReadOnlyPosture;
  mutationPosture: C03MutationPosture;
  exposurePosture: C03ExposurePosture;
  evidenceStatus: C03EvidenceStatus;
}

// Shared posture constants — every Backend CP screen is production-disabled, read-only, no-mutation,
// and exposed only inside the Backend CP internal DEV shell.
const PROD: C03ProductionPosture = 'production_disabled';
const RO: C03ReadOnlyPosture = 'read_only';
const NOMUT: C03MutationPosture = 'no_mutation';
const INTERNAL: C03ExposurePosture = 'backend_cp_internal_only';

// Server-authored, code/config UI coverage registry. Safe bounded labels only — conceptual mirror of the
// Backend CP screen / preview-card set (14 entries), re-expressed safely; NEVER imported from the bundle.
const ENTRIES: readonly BcpC03UiCoverageEntry[] = [
  { screenKey: 'readiness-gate', screenLabel: 'Backend CP Readiness Gate', screenStatus: 'implemented', coverageClass: 'readiness_gate', previewCardStatus: 'not_applicable', clientStatus: 'not_applicable', routeStatus: 'not_applicable', dataSourceClass: 'no_live_source', devGatePosture: 'backend_cp_shell_gate', productionPosture: PROD, readOnlyPosture: RO, mutationPosture: NOMUT, exposurePosture: INTERNAL, evidenceStatus: 'static_reviewed' },
  { screenKey: 'access-gate', screenLabel: 'Separate Access Gate', screenStatus: 'implemented', coverageClass: 'internal_dev_screen', previewCardStatus: 'not_applicable', clientStatus: 'not_applicable', routeStatus: 'not_applicable', dataSourceClass: 'no_live_source', devGatePosture: 'backend_cp_shell_gate', productionPosture: PROD, readOnlyPosture: RO, mutationPosture: NOMUT, exposurePosture: INTERNAL, evidenceStatus: 'static_reviewed' },
  { screenKey: 'c01-readiness-preview', screenLabel: 'C-01 Readiness Preview', screenStatus: 'implemented', coverageClass: 'preview_card', previewCardStatus: 'implemented', clientStatus: 'implemented', routeStatus: 'implemented', dataSourceClass: 'code_config_only', devGatePosture: 'dev_only', productionPosture: PROD, readOnlyPosture: RO, mutationPosture: NOMUT, exposurePosture: INTERNAL, evidenceStatus: 'transport_verified' },
  { screenKey: 'c02-registry-preview', screenLabel: 'C-02 Registry Preview', screenStatus: 'implemented', coverageClass: 'preview_card', previewCardStatus: 'implemented', clientStatus: 'implemented', routeStatus: 'implemented', dataSourceClass: 'code_config_only', devGatePosture: 'dev_only', productionPosture: PROD, readOnlyPosture: RO, mutationPosture: NOMUT, exposurePosture: INTERNAL, evidenceStatus: 'transport_verified' },
  { screenKey: 'c03-ui-coverage-preview', screenLabel: 'C-03 UI Coverage Preview', screenStatus: 'preview', coverageClass: 'preview_card', previewCardStatus: 'implemented', clientStatus: 'implemented', routeStatus: 'implemented', dataSourceClass: 'code_config_only', devGatePosture: 'dev_only', productionPosture: PROD, readOnlyPosture: RO, mutationPosture: NOMUT, exposurePosture: INTERNAL, evidenceStatus: 'transport_verified' },
  { screenKey: 'command-center', screenLabel: 'Command Center', screenStatus: 'placeholder', coverageClass: 'placeholder_screen', previewCardStatus: 'not_applicable', clientStatus: 'not_applicable', routeStatus: 'not_applicable', dataSourceClass: 'no_live_source', devGatePosture: 'backend_cp_shell_gate', productionPosture: PROD, readOnlyPosture: RO, mutationPosture: NOMUT, exposurePosture: INTERNAL, evidenceStatus: 'static_reviewed' },
  { screenKey: 'operations-console', screenLabel: 'Operations Console', screenStatus: 'placeholder', coverageClass: 'placeholder_screen', previewCardStatus: 'not_applicable', clientStatus: 'not_applicable', routeStatus: 'not_applicable', dataSourceClass: 'no_live_source', devGatePosture: 'backend_cp_shell_gate', productionPosture: PROD, readOnlyPosture: RO, mutationPosture: NOMUT, exposurePosture: INTERNAL, evidenceStatus: 'static_reviewed' },
  { screenKey: 'tenants', screenLabel: 'Tenants', screenStatus: 'implemented', coverageClass: 'internal_dev_screen', previewCardStatus: 'not_applicable', clientStatus: 'not_applicable', routeStatus: 'not_applicable', dataSourceClass: 'no_live_source', devGatePosture: 'backend_cp_shell_gate', productionPosture: PROD, readOnlyPosture: RO, mutationPosture: NOMUT, exposurePosture: INTERNAL, evidenceStatus: 'static_reviewed' },
  { screenKey: 'stores', screenLabel: 'Stores', screenStatus: 'implemented', coverageClass: 'internal_dev_screen', previewCardStatus: 'not_applicable', clientStatus: 'not_applicable', routeStatus: 'not_applicable', dataSourceClass: 'no_live_source', devGatePosture: 'backend_cp_shell_gate', productionPosture: PROD, readOnlyPosture: RO, mutationPosture: NOMUT, exposurePosture: INTERNAL, evidenceStatus: 'static_reviewed' },
  { screenKey: 'database-registry', screenLabel: 'Database Registry', screenStatus: 'implemented', coverageClass: 'internal_dev_screen', previewCardStatus: 'not_applicable', clientStatus: 'not_applicable', routeStatus: 'not_applicable', dataSourceClass: 'no_live_source', devGatePosture: 'backend_cp_shell_gate', productionPosture: PROD, readOnlyPosture: RO, mutationPosture: NOMUT, exposurePosture: INTERNAL, evidenceStatus: 'static_reviewed' },
  { screenKey: 'database-control', screenLabel: 'Database Control', screenStatus: 'blocked', coverageClass: 'blocked_screen', previewCardStatus: 'not_applicable', clientStatus: 'not_applicable', routeStatus: 'not_applicable', dataSourceClass: 'no_live_source', devGatePosture: 'backend_cp_shell_gate', productionPosture: PROD, readOnlyPosture: RO, mutationPosture: NOMUT, exposurePosture: INTERNAL, evidenceStatus: 'static_reviewed' },
  { screenKey: 'identity-access', screenLabel: 'Identity and Access', screenStatus: 'implemented', coverageClass: 'internal_dev_screen', previewCardStatus: 'not_applicable', clientStatus: 'not_applicable', routeStatus: 'not_applicable', dataSourceClass: 'no_live_source', devGatePosture: 'backend_cp_shell_gate', productionPosture: PROD, readOnlyPosture: RO, mutationPosture: NOMUT, exposurePosture: INTERNAL, evidenceStatus: 'static_reviewed' },
  { screenKey: 'audit-approvals', screenLabel: 'Audit and Approvals', screenStatus: 'implemented', coverageClass: 'internal_dev_screen', previewCardStatus: 'not_applicable', clientStatus: 'not_applicable', routeStatus: 'not_applicable', dataSourceClass: 'no_live_source', devGatePosture: 'backend_cp_shell_gate', productionPosture: PROD, readOnlyPosture: RO, mutationPosture: NOMUT, exposurePosture: INTERNAL, evidenceStatus: 'static_reviewed' },
  { screenKey: 'deployments-releases', screenLabel: 'Deployments and Releases', screenStatus: 'deferred', coverageClass: 'deferred_screen', previewCardStatus: 'not_applicable', clientStatus: 'not_applicable', routeStatus: 'not_applicable', dataSourceClass: 'no_live_source', devGatePosture: 'backend_cp_shell_gate', productionPosture: PROD, readOnlyPosture: RO, mutationPosture: NOMUT, exposurePosture: INTERNAL, evidenceStatus: 'static_reviewed' },
];

/**
 * The server-owned C-03 UI coverage registry, DEEPLY FROZEN so the source-of-truth constant can never be
 * mutated by a caller. Safe bounded labels only. Read via getBcpC03UiCoverageEntries() for a copy.
 */
export const BCP_C03_SERVER_OWNED_UI_COVERAGE_ENTRIES: readonly Readonly<BcpC03UiCoverageEntry>[] =
  Object.freeze(ENTRIES.map((e) => Object.freeze({ ...e })));

/**
 * Return the server-owned C-03 UI coverage entries as a FRESH defensive copy (new array of new objects).
 * PURE, DETERMINISTIC, NO-THROW. Takes NO arguments and reads NO env / request / global / live state —
 * authority- and request-independent. Mutating the result never affects the constant or a later call.
 */
export function getBcpC03UiCoverageEntries(): BcpC03UiCoverageEntry[] {
  return BCP_C03_SERVER_OWNED_UI_COVERAGE_ENTRIES.map((e) => ({ ...e }));
}
