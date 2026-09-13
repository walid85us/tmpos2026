/**
 * C2B-M005-P2-B0 — the fixed READ-ONLY comprehensive migration-005 preflight child.
 *
 * WHAT THIS IS. One snapshot, taken once, over one reserved session inside one
 * `REPEATABLE READ, READ ONLY` transaction. It answers two OBSERVATIONAL questions and no other:
 * which of migration 005's stated preconditions are observably satisfied on the confirmed
 * development target right now, and is there any residue of an earlier attempt? Every answer is a
 * fixed label, a boolean or a bounded count.
 *
 * IT DOES NOT ANSWER "MAY THE MIGRATION RUN". That question depends on facts a read-only snapshot
 * structurally cannot see — event-trigger effects, the apply session's own `search_path`,
 * apply-time lock availability, and provider-managed behaviour — every one of which this file
 * reports as explicitly open, on the favourable record as much as on any other.
 *
 * WHY REPEATABLE READ AND NOT THE DEFAULT. Under READ COMMITTED each statement takes a fresh
 * snapshot, so the ledger read, the policy read and the constraint read could each describe a
 * different instant and the combined verdict would describe a state that never existed. A single
 * snapshot makes the residue classification a statement about ONE database state.
 *
 * WHAT THIS IS NOT. It is not a migration, a migration mode, or a step toward one. It never plans
 * through a write-capable path, executes, adopts, bootstraps a ledger, acquires an advisory lock,
 * touches ownerAcl, resolves a dirty marker, modifies a role, issues DDL, or calls a user-defined
 * function. It shares no entry point with `scripts/supabase-migrate.ts` and does not import it.
 * PASSING THIS PREFLIGHT AUTHORIZES NOTHING and eliminates no race: the apply path must revalidate
 * every one of these facts under its own advisory lock and pre-commit gate, because this snapshot
 * is released the moment the bracket ends and the database is free to change afterwards.
 *
 * WHAT THE READ-ONLY BRACKET DOES NOT COVER, stated rather than left to be found. The guarantee is
 * "no call site plus a server-verified READ ONLY bracket", not a property of the handle: the handle
 * `createManagedDevExecutor` returns keeps `write`, the ledger write ports and the owner-ACL revoke
 * closure-scoped on the SAME reserved connection for the life of the run, and the bracket covers
 * neither the window between `reserve()` and `begin()` nor the one between `finish()` and
 * `dispose()`. Nothing occupies those windows today, and the containment suite pins that no call
 * site exists — but the containment is a source property, not a capability the handle lacks.
 *
 * FURTHER RESIDUALS THIS PREFLIGHT DOES NOT CLOSE, each disclosed in the operator record rather than
 * silently omitted: an enabled event trigger's effect on migration 005 is counted but NOT assessed;
 * the ACCESS EXCLUSIVE lock the constraint addition needs at apply time is not assessed; and the
 * shadowing check answers the name-resolution question on THIS session, which is not the apply's.
 *
 * PREDICTION IS KEPT DISTINCT FROM OBSERVATION. `tmpos_app` and `tmpos_audit_writer` do not exist
 * yet, so their effective privileges CANNOT be live-tested. What is proved instead is narrower and
 * stated as such: the frozen migration bytes create them with no membership and no direct database
 * grant, so at the moment migration 005's own privilege gate runs their database privilege can only
 * derive from the PUBLIC paths this preflight DID observe. A source drift in those bytes invalidates
 * the prediction and is a refusal.
 *
 * NOTHING HERE READS A SECRET VALUE OUT. Configuration is consumed by NAME to build the sealed
 * managed target; no value is printed, hashed, measured, or reported as set or unset. The operator
 * record is fixed labels, booleans and bounded counts only — never a catalog row, a role name, an
 * object identifier, a policy or constraint expression, an application identifier, SQL, or a driver
 * message.
 *
 * IMPORTING THIS MODULE DOES NOTHING. Only the exact-path entry guard at the foot starts a run.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CatalogReadPort,
  DEFAULT_ACL_ROW_LIMIT,
  LEDGER_SHAPE_CATEGORY_ORDER,
  LedgerShapeCategory,
  LedgerShapeResult,
  M005_UP_SHA256,
  assertManagedDevDsn,
  assessDefaultAclPosture,
  createManagedDevExecutor,
  describeManagedDsn,
  readDefaultAclRowsBounded,
  readEventTriggersBounded,
  readLedgerPoliciesBounded,
  readLedgerPrivilegesBounded,
  readLedgerRlsMode,
  verifyLedgerShape,
  verifyManagedDevFingerprint,
} from '../server/platform-identity/migrationExecutor';

/** The one development target this preflight will speak to, and the one database on it. */
export const EXPECTED_DEV_TARGET = 'tmpos2026-dev';
export const EXPECTED_DATABASE = 'postgres';

/**
 * The token the target line prints for the database, INSTEAD OF the database value itself.
 *
 * WHY A CONSTANT AND NOT THE VALUE. The value was rendered by interpolating `shape.database`, whose
 * text is `postgres` — and `postgres` is also the USERNAME of the direct endpoint. The launcher's
 * redactor adds `url.username` to its RAW class, which is matched as an unrestricted substring with
 * no vocabulary filter and no length floor, so on a direct-endpoint credential the literal
 * `database=postgres` rendered as `database=[REDACTED]`, while a session-pooler credential
 * (`postgres.<ref>`) left the same field in clear. Same code, same field, two renderings decided by
 * the CREDENTIAL rather than by the contract — an operator cannot tell a redacted field from an
 * absent one, and neither rendering was a property of the observation.
 *
 * The guard above the emit already proves `shape.database === EXPECTED_DATABASE`, so the value
 * carried no information this constant does not. Printing the constant removes the credential
 * derivation entirely: the field's text is now decided by source alone.
 *
 * RESIDUAL, STATED RATHER THAN PAPERED OVER: the redactor is a frozen governed file and still
 * matches RAW literals by substring, so a credential that literally contained this token would
 * redact it. That is a property of the redactor, not of a credential-derived value — what is
 * corrected here is the DERIVATION, and no token can be immune while the RAW class is unrestricted.
 */
export const TARGET_DATABASE_FIELD = 'EXPECTED';

/**
 * Configuration NAMES this preflight consumes. Names only — never a value, and never a presence
 * probe: an absent name simply makes the sealed-target construction refuse, which is the same
 * refusal an invalid one produces.
 *
 * `ALLOW_SUPABASE_MIGRATION_APPLY` IS DELIBERATELY ABSENT, and that is the correction over the
 * default-ACL diagnostic, which retained it only because it reused the apply launcher's sealed set
 * unchanged. That name is read in exactly one place in this repository — `assertOperatorGates` in
 * `scripts/supabase-migrate.ts` — which this child never imports and never reaches. Passing a
 * write-enabling operator gate to a read-only diagnostic buys nothing and would mean a stray
 * `execFile` of the migrate CLI from this environment inherited an armed gate.
 */
export const CONFIG_NAMES = Object.freeze([
  'SUPABASE_DATABASE_URL',
  'SUPABASE_URL',
  'DATABASE_CA_CERT',
  'CONFIRM_SUPABASE_TARGET',
  'NODE_ENV',
]);

/**
 * Bounded outcome vocabulary. Every value is a fixed literal; none is derived from a row, a role, a
 * privilege, an identifier or a driver message.
 *
 * THIS VOCABULARY DESCRIBES OBSERVATION, NOT PERMISSION. No code here is named for the question
 * "may migration 005 now run", because nothing here answers it: the favourable code says only that every
 * condition THIS ONE SNAPSHOT could observe matched and that cleanup succeeded. Event-trigger
 * effect, apply-session `search_path` continuity, apply-time lock availability and provider-managed
 * compatibility are all outside what a read-only snapshot can see, and each stays explicitly open on
 * the favourable record. A separate authorization is still required to execute migration 005.
 *
 * EXACTLY ONE CODE EXITS ZERO. Completion is not sufficient: an unmet observable precondition, any
 * residue, unreadable evidence, a broken backend identity and every cleanup failure are all nonzero.
 */
export const PREFLIGHT_CODES = Object.freeze({
  /**
   * Every bounded condition observable by this snapshot matched, and cleanup succeeded.
   *
   * IT IS NOT AN AUTHORIZATION, a prediction that the migration will succeed, a statement about
   * provider compatibility, or permission to execute migration 005. The residuals stay open.
   */
  OBSERVED_PRECONDITIONS_MET: 'm005_preflight_observed_preconditions_met',
  /** Everything readable, nothing residual, but at least one OBSERVABLE precondition is unmet. */
  PRECONDITIONS_NOT_MET: 'm005_preflight_observed_preconditions_not_met',
  /** Roles, constraint, policies or ledger carry evidence of an earlier 005 attempt. */
  RESIDUE_PRESENT: 'm005_preflight_residue_present',
  /**
   * A structurally OBSERVED contradiction in the ledger, or between the ledger and the objects.
   *
   * DISTINCT FROM `EVIDENCE_UNREADABLE` ON PURPOSE. This code means the evidence WAS obtained and
   * parsed and disagrees with itself; unreadable means it could not be obtained or parsed at all.
   * Collapsing the two would report a measured contradiction as a measurement failure.
   */
  LEDGER_INCONSISTENT: 'm005_preflight_ledger_inconsistent',
  /** An OBSERVED checksum disagreement between a stored ledger row and the governed bytes. */
  CHECKSUM_MISMATCH: 'm005_preflight_checksum_mismatch',
  /** The ledger already records version 005. Nothing here resolves or removes it. */
  ALREADY_APPLIED: 'm005_preflight_already_applied',
  /** A dirty ledger row exists. No recovery is authorized, attempted or recommended. */
  DIRTY_LEDGER: 'm005_preflight_dirty_ledger',
  /** The frozen migration-005 bytes are not the ones this preflight reasons about. */
  SOURCE_DRIFT: 'm005_preflight_source_drift',
  BACKEND_IDENTITY_CHANGED: 'm005_preflight_backend_identity_changed',
  PRODUCTION_FORBIDDEN: 'm005_preflight_production_forbidden',
  TARGET_UNCONFIRMED: 'm005_preflight_target_unconfirmed',
  ARGV_REJECTED: 'm005_preflight_argv_rejected',
  TARGET_INVALID: 'm005_preflight_target_invalid',
  READ_ONLY_NOT_ESTABLISHED: 'm005_preflight_read_only_not_established',
  READ_ONLY_LOST: 'm005_preflight_read_only_lost',
  ISOLATION_NOT_ESTABLISHED: 'm005_preflight_isolation_not_established',
  ISOLATION_LOST: 'm005_preflight_isolation_lost',
  IDENTITY_UNCONFIRMED: 'm005_preflight_identity_unconfirmed',
  FINGERPRINT_MISMATCH: 'm005_preflight_fingerprint_mismatch',
  EVIDENCE_UNREADABLE: 'm005_preflight_evidence_unreadable',
  PORT_FAILED: 'm005_preflight_port_failed',
  /** The snapshot bracket was open and its ROLLBACK did not complete. Distinct from disposal. */
  ROLLBACK_FAILED: 'm005_preflight_rollback_failed',
  TEARDOWN_FAILED: 'm005_preflight_teardown_failed',
});

/**
 * Transaction-local per-statement bound.
 *
 * LOWERED FROM 30s, AND THE PARENT'S BOUND IS NOW DERIVED FROM IT. Every statement in the bracket is
 * a bounded catalog read except one — the `audit_event` compatibility aggregate — and at 30s each,
 * eighteen statements plus a 15s connect could outlast the parent's 90s kill, turning a slow-but-
 * successful preflight into a containment/timeout outcome with no verdict at all. A launcher bound
 * that is not derived from the child's own budget is a number, not a contract.
 */
export const TX_TIMEOUT_MS = 10_000;

/**
 * The number of statements the bracket issues, used to derive the parent's bound.
 *
 * COUNTED, NOT ESTIMATED, and the previous value of 20 was under half the truth:
 * `readObservedPreconditionEvidence` alone issues 15, before the 2 provider reads, the ledger-shape
 * probe, the bounded ledger read, the default-ACL read, the fingerprint, the identity read, the two
 * backend tokens, and the eight bracket statements (begin, two SET LOCAL timeouts, two read-only
 * checks, two isolation checks, rollback). An UNDERSTATED budget is the dangerous direction: the
 * parent's kill is derived from it, so a slow-but-successful preflight was liable to be SIGKILLed
 * before it could report — the exact failure the derivation exists to prevent. Each statement is
 * still individually bounded by `TX_TIMEOUT_MS`, so a larger budget lengthens the outer bound
 * without weakening any per-statement one.
 */
export const BRACKET_STATEMENT_BUDGET = 40;

/** The isolation level the bracket must report, exactly as PostgreSQL spells it. */
export const REQUIRED_ISOLATION = 'repeatable read';

/** The bounded development fingerprint expectations, reused unchanged from the managed contract. */
export const FINGERPRINT_EXPECTATIONS: {
  readonly requiredAuditActions: readonly string[];
  readonly activeSystemOwners: number;
  readonly suspendedSystemOwners: number;
} = Object.freeze({
  requiredAuditActions: Object.freeze([
    'bcp.platform.system_owner_provisioning',
    'bcp.platform.system_owner_provisioning_compensation',
  ]),
  activeSystemOwners: 2,
  suspendedSystemOwners: 1,
});

// ---------------------------------------------------------------------------
// The governed object set, DERIVED FROM THE FROZEN MIGRATION-005 BYTES.
//
// Stated as DATA rather than as prose, so the deterministic suite can compare these lists against the
// migration text itself IN BOTH DIRECTIONS — every listed name must appear in the frozen bytes, AND
// every role, constraint and policy the bytes create must appear in a list. The forward direction
// alone would pass a 005 edit that ADDED an object, which is the drift that matters; the checksum pin
// in `readGovernedUpSql` would still catch that as SOURCE_DRIFT, but as a blanket refusal rather than
// as the specific "this list is now incomplete" the suite owes its reader.
// ---------------------------------------------------------------------------

/** Roles migration 005 CREATES. Each must be ABSENT: 005 refuses to adopt a role it did not create. */
export const M005_CREATED_ROLES: readonly string[] = Object.freeze(['tmpos_app', 'tmpos_audit_writer']);

/** Roles migration 005 REFERENCES as grantees of a REVOKE. Each must already exist. */
export const M005_PREREQUISITE_ROLES: readonly string[] = Object.freeze(['anon', 'authenticated']);

/** Every table migration 005 grants on, revokes on, constrains or attaches a policy to. */
export const M005_GOVERNED_TABLES: readonly string[] = Object.freeze([
  'audit_event', 'platform_identity', 'store', 'tenant', 'tenant_feature_entitlement', 'user_membership',
]);

/**
 * Tables whose RLS must ALREADY be enabled, and this is the finding the trace surfaced.
 *
 * MIGRATION 005 CONTAINS NO `enable row level security` STATEMENT. It creates five policies and
 * nothing else; RLS itself is enabled by 001, 002 and 004. A policy on a table whose
 * `relrowsecurity` is false is INERT — it is stored and it is never consulted — so applying 005
 * against a table someone has since disabled RLS on would produce a green run and no enforcement.
 * `relrowsecurity` is therefore a PRECONDITION of 005 rather than one of its effects, and it is
 * checked here as one.
 */
export const M005_RLS_REQUIRED_TABLES: readonly string[] = Object.freeze([
  'audit_event', 'platform_identity', 'store', 'tenant', 'tenant_feature_entitlement', 'user_membership',
]);

/**
 * `platform_identity` is in that list for a DIFFERENT reason, and the difference is worth stating.
 *
 * The other five carry a 005 policy, so RLS-off makes that policy inert. `platform_identity` carries
 * none — 005 only revokes on it, and section 6 of the migration justifies that revoke explicitly by
 * 001's "RLS enabled, no policies" posture, calling the explicit REVOKE "the half of the posture that
 * survives a future migration adding a permissive policy". So the OTHER half is the RLS flag, and if
 * it were off the revoke would be the only thing standing between a non-owner role and the identity
 * store. Auditing that stated basis is the same discipline applied to the no-sequence claim below.
 */
export const M005_POLICY_TABLES: readonly string[] = Object.freeze([
  'audit_event', 'store', 'tenant', 'tenant_feature_entitlement', 'user_membership',
]);

/** Every column named by a grant column-list, a policy predicate or the new constraint. */
/**
 * Every column named by a grant column-list, a policy predicate or the new constraint, WITH ITS TYPE.
 *
 * THE TYPE IS NOT DECORATION. Every policy predicate compares a `*_id` column against
 * `nullif(current_setting(...), '')::uuid`, and the constraint compares `scope_type` against text
 * literals. A column present under the right NAME but the wrong type does not fail this preflight and
 * then fails `CREATE POLICY` or `ADD CONSTRAINT` at apply time with `operator does not exist` — a
 * favourable record that turns into a durable dirty marker. Matching on `format_type` closes that.
 */
export const M005_REQUIRED_COLUMNS: readonly string[] = Object.freeze([
  'audit_event.evidence_level:text', 'audit_event.scope_type:text',
  'audit_event.store_id:uuid', 'audit_event.tenant_id:uuid',
  'store.store_id:uuid', 'store.store_name:text', 'store.tenant_id:uuid',
  'tenant.display_name:text', 'tenant.legal_name:text', 'tenant.tenant_id:uuid',
  'tenant_feature_entitlement.tenant_id:uuid',
  'user_membership.store_id:uuid', 'user_membership.tenant_id:uuid',
]);

/** The one constraint 005 adds. Its name must be ABSENT. */
export const M005_CONSTRAINT = Object.freeze({ table: 'audit_event', name: 'audit_event_scope_consistency_chk' });

/** Every policy 005 creates, as `table.policy`. Each must be ABSENT. */
export const M005_POLICIES: readonly string[] = Object.freeze([
  'audit_event.tmpos_audit_writer_append',
  'store.tmpos_app_store_scope',
  'tenant.tmpos_app_tenant_scope',
  'tenant_feature_entitlement.tmpos_app_entitlement_scope',
  'user_membership.tmpos_app_membership_scope',
]);

/**
 * The only non-builtin-operator function every 005 policy predicate calls.
 *
 * `nullif` is an SQL construct rather than a routine, and the `::uuid` casts resolve to the type's
 * own input function, so `current_setting(text, boolean)` is the whole list. It is checked with its
 * exact identity arguments because the single-argument form RAISES on an unset setting, which is
 * precisely the behaviour the two-argument form exists to avoid.
 */
export const M005_POLICY_FUNCTION = Object.freeze({ schema: 'pg_catalog', name: 'current_setting', args: 'text, boolean' });

/** The ledger prefix 005 requires, and the exact basenames whose bytes define their checksums. */
export const LEDGER_PREFIX_VERSIONS: readonly string[] = Object.freeze(['001', '002', '003', '004']);
export const LEDGER_PREFIX_BASENAMES: readonly string[] = Object.freeze([
  '001_platform_identity.up.sql',
  '002_authorization_audit_foundation.up.sql',
  '003_platform_role_vocabulary_alignment.up.sql',
  '004_identity_link.up.sql',
]);

/** Bounded ledger read ceiling. A history longer than this is unreadable, never truncated. */
export const LEDGER_ROW_LIMIT = 50;

/** Governed role attributes the frozen bytes must still declare, in the order 005 writes them. */
export const M005_ROLE_ATTRIBUTES = 'nologin nosuperuser nocreatedb nocreaterole noreplication nobypassrls inherit';

/** A line sink the tests can capture. Never receives a raw value, an Error, or a driver message. */
export type Emit = (line: string) => void;

// ---------------------------------------------------------------------------
// Bounded evidence — every field is a fixed label, a boolean, `null` for unreadable, or a count.
// ---------------------------------------------------------------------------

export type Tri = 'ABSENT' | 'PRESENT' | 'UNREADABLE';
export type Match = 'MATCH' | 'MISMATCH' | 'UNREADABLE';

/**
 * The version-005 ledger axis, SIX-VALUED, one state per way a 005 row can exist.
 *
 * `ALREADY_APPLIED` is the strongest claim this preflight makes, and it once rested on the version
 * STRING alone: any row reading `005` earned it. A four-valued axis then collapsed every unsound
 * shape into one `INVALID`, which is still too coarse — a DUPLICATE row and a CHECKSUM_MISMATCH are
 * different observed facts and an operator acts on them differently.
 *
 * WHAT MAPS WHERE. A row set that could not be parsed at all never reaches this axis: a malformed
 * row makes the ENTIRE classification unreadable upstream, so `UNREADABLE` here covers both "no
 * expectation to compare against" and "the rows were unparsable". Every other state is an OBSERVED
 * fact about rows that were successfully read.
 */
export type LedgerM005 =
  | 'ABSENT'
  | 'VALID'
  | 'CHECKSUM_MISMATCH'
  | 'DIRTY'
  | 'DUPLICATE'
  | 'UNREADABLE';

/** The ledger version migration 005 writes for itself. NOT part of the required historical prefix. */
export const M005_LEDGER_VERSION = '005';

/**
 * The ONE ledger-shape failure that is a measurement failure rather than an observation.
 *
 * `verifyLedgerShape` reports an ambiguous catalog entry when it cannot tell WHICH relation it is
 * looking at. Every other label it emits — an absent relation, a non-table relkind, row-level
 * security on the ledger — describes something it read successfully and that disagrees with the
 * contract. Only this one means "could not be determined".
 */
export const LEDGER_SHAPE_UNREADABLE = 'ledger relation ambiguous in catalog';

/**
 * The bounded operator value for a shape that MATCHED. A category set is absent, not unreadable.
 */
export const LEDGER_SHAPE_CATEGORIES_NONE = 'NONE';

/**
 * The bounded operator value for a shape that could not be MEASURED.
 *
 * Deliberately the same token the rest of this record uses for missing evidence: an ambiguous
 * catalog entry produces no category, and printing `NONE` for it would say the relation was read
 * and found conforming — the exact collapse this preflight exists to refuse.
 */
export const LEDGER_SHAPE_CATEGORIES_UNREADABLE = 'UNREADABLE';

export const LEDGER_SHAPE_CATEGORY_SEPARATOR = ',';

/**
 * RE-EXPORTED THROUGH THE ADAPTER, deliberately.
 *
 * The executor is import-contained: only the operator CLI and its own suites may reach it, and a
 * test of THIS module's operator grammar importing it directly both breaks that containment and
 * asserts against the wrong boundary. The order is part of the published output contract here.
 */
export { LEDGER_SHAPE_CATEGORY_ORDER };
export type { LedgerShapeCategory, LedgerShapeResult };
// The same containment argument covers the two reads whose result-column mapping this module's
// suite must exercise directly: they are the producers of the shapes classified above.
export { readLedgerRlsMode, readLedgerPrivilegesBounded };

/**
 * The COMPILE-DERIVED maximum width of the rendered category field.
 *
 * Computed from the closed order list rather than written down, so adding or renaming a category
 * moves the bound with it instead of silently overrunning a figure a test asserts.
 */
export const LEDGER_SHAPE_CATEGORIES_MAX_LENGTH: number =
  LEDGER_SHAPE_CATEGORY_ORDER.reduce((n, c) => n + c.length, 0)
  + Math.max(0, LEDGER_SHAPE_CATEGORY_ORDER.length - 1) * LEDGER_SHAPE_CATEGORY_SEPARATOR.length;

/**
 * Render the category set as ONE bounded field of fixed source constants.
 *
 * Every token comes from `LEDGER_SHAPE_CATEGORY_ORDER`, so no catalog value, reason string,
 * identifier, type, default expression or constraint name can reach this string by construction —
 * not by filtering one out afterwards.
 */
export function renderShapeCategories(shape: Match, categories: readonly LedgerShapeCategory[]): string {
  if (shape === 'UNREADABLE') return LEDGER_SHAPE_CATEGORIES_UNREADABLE;
  if (categories.length === 0) return LEDGER_SHAPE_CATEGORIES_NONE;
  return LEDGER_SHAPE_CATEGORY_ORDER
    .filter((c) => categories.includes(c))
    .join(LEDGER_SHAPE_CATEGORY_SEPARATOR);
}

export interface LedgerEvidence {
  readonly shape: Match;
  /**
   * WHICH shape checks disagreed — empty on MATCH and on UNREADABLE, non-empty on every MISMATCH.
   *
   * The run that found the live mismatch computed this set inside `verifyLedgerShape` and threw it
   * away at the renderer, so the operator record carried "the ledger disagrees" and nothing about
   * WHAT disagreed, and a second connection would have returned the identical aggregate.
   */
  readonly shapeCategories: readonly LedgerShapeCategory[];
  readonly prefix: Match;
  readonly checksums: Match;
  readonly dirty: Tri;
  readonly m005: LedgerM005;
  readonly unknownOrOutOfOrder: Tri;
  readonly overflowed: boolean;
}

export interface ObservedPreconditionEvidence {
  readonly publicCreateOnDatabase: boolean | null;
  readonly publicTemporaryOnDatabase: boolean | null;
  readonly principalCanCreateRole: boolean | null;
  readonly schemaPublicPresent: boolean | null;
  readonly schemaPublicAuthority: boolean | null;
  /**
   * HOW MANY of the two roles 005 creates exist — AND THE ONLY REPRESENTATION OF THAT FACT. The `Tri` above cannot answer that: `toTri` maps
   * ANY nonzero count to `PRESENT`, so one role out of two read as "the roles are there" and an
   * object set missing half its roles was classified COMPLETE — the strongest label, on a database
   * whose 005 postconditions do not hold.
   */
  readonly createdRolesCount: number | null;
  readonly roleCommentResidue: Tri;
  readonly prerequisiteRoles: Tri;
  readonly governedTablesPresent: number | null;
  readonly governedTablesAuthoritative: number | null;
  readonly requiredColumnsPresent: number | null;
  readonly rlsEnabledTables: number | null;
  readonly policiesPresent: number | null;
  readonly foreignPoliciesOnGovernedTables: number | null;
  readonly governedNamesShadowedOutsidePublic: number | null;
  readonly plpgsqlPresent: boolean | null;
  readonly enabledEventTriggers: number | null;
  readonly constraintPresent: Tri;
  readonly incompatibleAuditRows: number | null;
  readonly policyFunctionPresent: boolean | null;
  readonly sequencesInPublic: number | null;
}

export interface ProviderEvidence {
  readonly routinesOutsidePublic: number | null;
  readonly creatableNonPublicSchemas: number | null;
}

/**
 * The SOURCE-DERIVED prediction about the two roles migration 005 has not created yet.
 *
 * `MATCH` means the frozen bytes still (a) create both roles with the governed attribute list,
 * (b) grant neither of them membership in any role, and (c) issue no database-level GRANT at all.
 * Only under all three does "their database privilege at the gate derives from PUBLIC alone" follow
 * from what this preflight observed. Any drift makes the prediction unsound, and the run refuses
 * rather than reporting a prediction whose basis it just failed to establish.
 */
export function predictCreatedRoleSource(upSql: unknown): Match {
  if (typeof upSql !== 'string' || upSql === '') return 'UNREADABLE';
  // COMMENTS ARE REMOVED FIRST. The membership scan below splits on `;` and discards any chunk
  // containing ` on `, so a line comment carrying those two characters anywhere in the same chunk
  // silently suppressed the finding — a MATCH, the strongest label, from a scan that never ran.
  const sql = upSql
    .split('\n').map((l) => l.replace(/--.*$/, '')).join('\n')
    .toLowerCase();
  for (const role of M005_CREATED_ROLES) {
    // The attribute list is matched as a whole, on the create statement for that exact role name.
    const wanted = `create role ${role}\n  ${M005_ROLE_ATTRIBUTES};`;
    if (!sql.includes(wanted)) return 'MISMATCH';
  }
  // A role-membership grant would give the new roles privileges no PUBLIC observation can predict.
  for (const role of M005_CREATED_ROLES) {
    if (new RegExp(`grant\\s+[a-z_ ,]*\\bto\\s+[a-z_, ]*\\b${role}\\b`).test(sql)) {
      // Table and schema grants to these roles are expected and are NOT role memberships; only a
      // grant whose object is a ROLE would be. `grant <role> to <role>` has no `on` clause.
      const suspects = sql.split(';').filter((s) => new RegExp(`\\bto\\s+[a-z_, ]*\\b${role}\\b`).test(s));
      if (suspects.some((s) => s.includes('grant') && !s.includes(' on '))) return 'MISMATCH';
    }
  }
  if (/\bgrant\b[^;]*\bon\s+database\b/.test(sql)) return 'MISMATCH';
  return 'MATCH';
}

/**
 * Classify the bounded ledger read.
 *
 * TOTAL over its inputs and fail-closed on every one of them: an unreadable shape, an overflowed
 * read, a malformed row or a missing count all produce `UNREADABLE` rather than a favourable label.
 * No stored checksum, version string or row value ever leaves this function.
 */
/**
 * Classify the shape half of the ledger read, and the category set that explains a MISMATCH.
 *
 * FAIL-CLOSED ON ITS OWN CONTRACT, which is the point of separating it: a MISMATCH whose category
 * set is empty, or which names something outside the closed list, is a producer this classifier
 * cannot account for. That is missing evidence about the shape, not an observed disagreement, so it
 * degrades to UNREADABLE — unfavourable, nonzero, and unable to reach the exit-zero cell — rather
 * than printing a mismatch with no stated cause or a cause nothing defines.
 */
export function classifyShape(
  shape: LedgerShapeResult | null,
): { shape: Match; categories: readonly LedgerShapeCategory[] } {
  const blank = { shape: 'UNREADABLE' as Match, categories: [] as readonly LedgerShapeCategory[] };
  if (shape === null) return blank;
  // ONE SHAPE FAILURE IS GENUINELY UNMEASURABLE and the rest are observations. An ambiguous catalog
  // entry means the shape could not be determined; an absent relation, a view, or row-level security
  // on the ledger were all READ successfully and disagree with the contract. Collapsing them sent an
  // operator hunting a broken connection for a database that answered every question correctly.
  // A MALFORMED PRODUCER RESULT IS MISSING EVIDENCE, not a conforming shape. Checked rather than
  // trusted from the declared type: this value crosses a module boundary, and a caller that omits
  // the set entirely would otherwise throw out of the classifier and collapse the whole run to a
  // port failure — discarding every fact the snapshot had already gathered.
  if (!Array.isArray(shape.failed) || !Array.isArray(shape.categories)) return blank;
  if (shape.failed.includes(LEDGER_SHAPE_UNREADABLE)) return blank;
  if (shape.present && shape.failed.length === 0 && shape.categories.length === 0) {
    return { shape: 'MATCH', categories: [] };
  }
  // MEMBERSHIP IS TESTED AGAINST THE CLOSED LIST, not assumed from the declared type: this value
  // crosses a module boundary and a widened or hand-built producer would otherwise put an unknown
  // token straight into the operator record.
  const known = shape.categories.filter((c) => LEDGER_SHAPE_CATEGORY_ORDER.includes(c));
  if (known.length !== shape.categories.length) return blank;
  const canonical = LEDGER_SHAPE_CATEGORY_ORDER.filter((c) => known.includes(c));
  // A MISMATCH WITHOUT A CAUSE IS NOT REPORTABLE AS ONE. Absence is the case this protects: its
  // reason list is empty by design, so only the category distinguishes it from a broken producer.
  if (canonical.length === 0) return blank;
  return { shape: 'MISMATCH', categories: canonical };
}

export function classifyLedger(
  shapeResult: LedgerShapeResult | null,
  rows: readonly { version: unknown; checksum: unknown; dirty: unknown }[] | null,
  overflowed: boolean,
  expectedChecksums: ReadonlyMap<string, string>,
): LedgerEvidence {
  const verdict = classifyShape(shapeResult);
  const shape = verdict.shape;
  const shapeCategories = verdict.categories;
  const unreadable: LedgerEvidence = {
    shape: 'UNREADABLE', shapeCategories, prefix: 'UNREADABLE', checksums: 'UNREADABLE',
    dirty: 'UNREADABLE', m005: 'UNREADABLE', unknownOrOutOfOrder: 'UNREADABLE', overflowed,
  };
  if (shape !== 'MATCH') return { ...unreadable, shape, overflowed };
  // THE SHAPE WAS READ AND MATCHED; only the ROWS are missing. Returning the blank record here
  // dropped that fact and printed `ledgerShape=UNREADABLE` for a conforming relation.
  if (rows === null || overflowed) return { ...unreadable, shape, overflowed };

  // Every row must be strictly well-formed before ANY conclusion is drawn from the set.
  const seen: { version: string; checksum: string; dirty: boolean }[] = [];
  for (const r of rows) {
    if (typeof r.version !== 'string' || r.version === '') return { ...unreadable, shape };
    if (typeof r.checksum !== 'string' || r.checksum === '') return { ...unreadable, shape };
    if (typeof r.dirty !== 'boolean') return { ...unreadable, shape };
    seen.push({ version: r.version, checksum: r.checksum, dirty: r.dirty });
  }

  const versions = seen.map((r) => r.version);
  const prefixRows = seen.filter((r) => LEDGER_PREFIX_VERSIONS.includes(r.version));
  const exactlyOnceEach = LEDGER_PREFIX_VERSIONS.every(
    (v) => versions.filter((x) => x === v).length === 1,
  );
  const sortedAscending = versions.every((v, i) => i === 0 || versions[i - 1] < v);
  const known = versions.every((v) => LEDGER_PREFIX_VERSIONS.includes(v) || v === '005');

  const prefix: Match = exactlyOnceEach && prefixRows.every((r) => !r.dirty) ? 'MATCH' : 'MISMATCH';
  const checksums: Match = exactlyOnceEach
    && prefixRows.every((r) => expectedChecksums.get(r.version) === r.checksum) ? 'MATCH' : 'MISMATCH';
  const dirty: Tri = seen.some((r) => r.dirty) ? 'PRESENT' : 'ABSENT';

  // THE 005 ROW IS VALIDATED, NOT MERELY DETECTED. Three independent ways a 005 row can exist
  // without meaning "the governed migration 005 was cleanly applied", each of which used to read as
  // ALREADY_APPLIED: more than one such row, a dirty one, and one whose stored checksum describes
  // different bytes. An expectation this process could not measure is UNREADABLE, never a MISMATCH
  // — "I could not check" and "it disagrees" are different claims about the same row.
  const m005Rows = seen.filter((r) => r.version === M005_LEDGER_VERSION);
  const expected005 = expectedChecksums.get(M005_LEDGER_VERSION);
  const m005: LedgerM005 = ((): LedgerM005 => {
    if (m005Rows.length === 0) return 'ABSENT';
    // AN UNMEASURABLE EXPECTATION IS UNREADABLE, never a mismatch: "I could not check" and "it
    // disagrees" are different claims about the same row and reach different operator codes.
    if (typeof expected005 !== 'string' || expected005 === '') return 'UNREADABLE';
    // STRUCTURE BEFORE CONTENT. With two rows there is no single checksum to compare, so the
    // duplication is the fact — reporting a checksum verdict would have to pick a row arbitrarily.
    if (m005Rows.length > 1) return 'DUPLICATE';
    const only = m005Rows[0] as { checksum: string; dirty: boolean };
    if (only.dirty) return 'DIRTY';
    return only.checksum === expected005 ? 'VALID' : 'CHECKSUM_MISMATCH';
  })();

  const unknownOrOutOfOrder: Tri = known && sortedAscending ? 'ABSENT' : 'PRESENT';
  return { shape, shapeCategories, prefix, checksums, dirty, m005, unknownOrOutOfOrder, overflowed };
}

/**
 * The plan this ledger state predicts. INFORMATIONAL, and computed PURELY.
 *
 * `planApply` is deliberately not called: its module is reachable only through a path that also
 * carries write and dirty-resolution surfaces, and a prediction is not worth importing them for.
 */
export function predictPlan(l: LedgerEvidence): 'EXACT_005' | 'NOT_EXACT_005' | 'UNREADABLE' {
  if (l.shape !== 'MATCH' || l.prefix === 'UNREADABLE' || l.m005 === 'UNREADABLE') return 'UNREADABLE';
  if (l.overflowed || l.dirty === 'UNREADABLE' || l.unknownOrOutOfOrder === 'UNREADABLE') return 'UNREADABLE';
  // AND THE CHECKSUM AXIS, which this guard used to omit. An unmeasurable expectation made `clean`
  // false and printed NOT_EXACT_005 — a definite prediction drawn from evidence the run never read.
  if (l.checksums === 'UNREADABLE') return 'UNREADABLE';
  const clean = l.prefix === 'MATCH' && l.checksums === 'MATCH'
    && l.dirty === 'ABSENT' && l.m005 === 'ABSENT' && l.unknownOrOutOfOrder === 'ABSENT';
  return clean ? 'EXACT_005' : 'NOT_EXACT_005';
}

/**
 * How much of migration 005's postcondition object set is present, INDEPENDENT of the ledger.
 *
 * Kept separate on purpose: the ledger's account of 005 and the objects 005 creates are two
 * different witnesses, and the whole point of the classification below is to notice when they
 * disagree. Folding them together is what let a valid 005 row speak for objects nobody looked at.
 */
export type ObjectState = 'NONE' | 'PARTIAL' | 'COMPLETE' | 'UNREADABLE';

export function classifyObjectState(r: ObservedPreconditionEvidence): ObjectState {
  if (r.createdRolesCount === null || r.roleCommentResidue === 'UNREADABLE'
      || r.constraintPresent === 'UNREADABLE' || r.policiesPresent === null) {
    return 'UNREADABLE';
  }
  // EXACT COUNTS, exactly as the prerequisite-role gate already does. "Some of them" is not a
  // completed apply, and COMPLETE is the only object state that can reach ALREADY_APPLIED.
  const complete = r.createdRolesCount === M005_CREATED_ROLES.length
    && r.constraintPresent === 'PRESENT' && r.policiesPresent === M005_POLICIES.length;
  if (complete) return 'COMPLETE';
  const none = r.createdRolesCount === 0 && r.roleCommentResidue === 'ABSENT'
    && r.constraintPresent === 'ABSENT' && r.policiesPresent === 0;
  return none ? 'NONE' : 'PARTIAL';
}

export type Residue = 'CLEAN' | 'PARTIAL_RESIDUE' | 'ALREADY_APPLIED' | 'INCONSISTENT' | 'UNREADABLE';

/**
 * The combined classification over the historical prefix, the version-005 row and the objects.
 *
 * DEFAULT ACLs ARE DELIBERATELY NOT AN INPUT, and saying so matters: a loosened default ACL left by
 * an abandoned attempt is indistinguishable from one that was always there, so it cannot evidence a
 * PARTIAL attempt. It is routed through the A/B posture instead and reaches the operator as
 * `PRECONDITIONS_NOT_MET` — a different code for a different claim, at the same nonzero exit.
 *
 * ALREADY_APPLIED IS THE STRONGEST CLAIM AND NOW CARRIES ITS FULL PRICE. It used to follow from a
 * 005 row alone, so a valid 005 row could sit on top of a ledger missing 002, or beside a half-built
 * object set, and the report would still say the migration had been applied — hiding the very
 * defects an operator needs to see. It now requires ALL of:
 *
 *   - the exact clean 001-004 prefix, checksum-matched against the current repository bytes;
 *   - no unknown or out-of-order version anywhere in the ledger;
 *   - exactly one version-005 row, not dirty, checksum-matched to the governed bytes;
 *   - an object set CONSISTENT with a completed apply, i.e. COMPLETE.
 *
 * A 005 row that survives the ledger tests but disagrees with the objects is INCONSISTENT, not
 * applied: two witnesses that were both read and contradict each other. That is an OBSERVATION, and
 * it is deliberately not `UNREADABLE` — unreadable is reserved for evidence that could not be
 * obtained or parsed, and reporting a measured contradiction as a measurement failure would tell
 * the operator to go looking for a broken connection instead of a broken database.
 *
 * ORDER IS LOAD-BEARING: unreadable outranks everything, because a category that could not be read
 * cannot be compared with one that was.
 */
export function classifyResidue(r: ObservedPreconditionEvidence, l: LedgerEvidence): Residue {
  const objects = classifyObjectState(r);
  if (l.shape === 'MISMATCH') return 'INCONSISTENT';
  if (objects === 'UNREADABLE' || l.m005 === 'UNREADABLE' || l.shape !== 'MATCH' || l.overflowed
      || l.prefix === 'UNREADABLE' || l.checksums === 'UNREADABLE'
      || l.dirty === 'UNREADABLE' || l.unknownOrOutOfOrder === 'UNREADABLE') {
    return 'UNREADABLE';
  }

  // THE HISTORICAL PREFIX IS A PRECONDITION OF BOTH FAVOURABLE LABELS, not just of the clean one.
  // A ledger whose 001-004 history is missing, duplicated, checksum-drifted, dirty, out of order or
  // padded with an unknown version cannot support ANY confident statement about 005 — including the
  // statement that 005 was applied, which is only meaningful relative to the history it followed.
  const prefixClean = l.prefix === 'MATCH' && l.checksums === 'MATCH'
    && l.unknownOrOutOfOrder === 'ABSENT' && l.dirty === 'ABSENT';

  if (l.m005 !== 'ABSENT') {
    // Every non-absent 005 state other than a fully sound one is an observed contradiction.
    if (l.m005 !== 'VALID') return 'INCONSISTENT';
    if (!prefixClean) return 'INCONSISTENT';
    // THE OBJECTS MUST AGREE. A ledger row saying "applied" beside an incomplete object set is the
    // signature of an interrupted apply, and it is the one state most dangerous to call "applied".
    return objects === 'COMPLETE' ? 'ALREADY_APPLIED' : 'INCONSISTENT';
  }

  // NO 005 ROW. Objects without a ledger row are exactly what an abandoned attempt leaves behind;
  // calling that "applied" would invite someone to mark the work done.
  if (objects !== 'NONE') return 'PARTIAL_RESIDUE';
  return prefixClean ? 'CLEAN' : 'INCONSISTENT';
}

/**
 * Are all governed preconditions observed AND satisfied?
 *
 * Returns `null` when ANY input is unreadable — deliberately three-valued, so "not proven to be
 * satisfied" and "proven unsatisfied" never collapse into one another.
 */
export function assessObservedPreconditions(r: ObservedPreconditionEvidence): boolean | null {
  const nums = [
    r.governedTablesPresent, r.governedTablesAuthoritative, r.requiredColumnsPresent,
    r.rlsEnabledTables, r.incompatibleAuditRows, r.sequencesInPublic,
    r.foreignPoliciesOnGovernedTables, r.governedNamesShadowedOutsidePublic, r.enabledEventTriggers,
  ];
  if (nums.some((n) => n === null)) return null;
  const bools = [
    r.publicCreateOnDatabase, r.publicTemporaryOnDatabase, r.principalCanCreateRole,
    r.schemaPublicPresent, r.schemaPublicAuthority, r.policyFunctionPresent, r.plpgsqlPresent,
  ];
  if (bools.some((b) => b === null)) return null;
  if (r.prerequisiteRoles === 'UNREADABLE') return null;
  return r.publicCreateOnDatabase === false
    && r.publicTemporaryOnDatabase === false
    && r.principalCanCreateRole === true
    && r.schemaPublicPresent === true
    && r.schemaPublicAuthority === true
    && r.policyFunctionPresent === true
    && r.plpgsqlPresent === true
    && r.prerequisiteRoles === 'PRESENT'
    // A GOVERNED NAME VISIBLE OUTSIDE `public` would silently retarget the eight unqualified
    // statements 005 issues, so a nonzero count is a refusal rather than a note.
    && r.governedNamesShadowedOutsidePublic === 0
    // A PRE-EXISTING POLICY ON A GOVERNED TABLE IS NOT INERT. Permissive policies OR together, so one
    // left on a policy table would union with 005's and defeat the isolation 005 exists to establish.
    // THE SCAN COVERS ALL SIX TABLES, NOT THE FIVE THAT GET A POLICY, and the sixth is the point: the
    // reason `platform_identity` is in the RLS list at all is 001's "RLS enabled, NO POLICIES"
    // posture. Checking the flag and not the policies would have audited one half of a two-part
    // claim and returned the favourable code on a permissive policy sitting on the identity store.
    && r.foreignPoliciesOnGovernedTables === 0
    && r.governedTablesPresent === M005_GOVERNED_TABLES.length
    && r.governedTablesAuthoritative === M005_GOVERNED_TABLES.length
    && r.requiredColumnsPresent === M005_REQUIRED_COLUMNS.length
    && r.rlsEnabledTables === M005_RLS_REQUIRED_TABLES.length
    && r.incompatibleAuditRows === 0
    && r.sequencesInPublic === 0;
}

/**
 * The one place every bounded fact becomes a primary disposition. Pure, total and ordered.
 *
 * ORDER, AND WHY EACH STEP OUTRANKS THE NEXT:
 *   1. source drift    — the prediction and the whole governed object set are derived from those
 *                        bytes; if they moved, every later label describes a different migration.
 *   2. dirty ledger    — the most consequential single finding, and the one with no implemented
 *                        remedy. It outranks the unreadable checks BELOW it: the axis is only ever
 *                        'PRESENT' on a fully well-formed row set, so reaching it means the marker
 *                        was genuinely read, and letting some other unread category downgrade it to
 *                        `evidence_unreadable` would bury the one fact an operator must act on.
 *   3. unreadable      — a fact that could not be OBTAINED OR PARSED. Nothing below this line is
 *                        about measurement failure; everything below is an observed disagreement.
 *   4. checksum mismatch — a stored checksum was read and disagrees with the governed bytes. Its own
 *                        code, because "the history does not describe these files" is a specific,
 *                        actionable finding and not a generic inconsistency.
 *   5. ledger inconsistent — the historical prefix is broken, an unknown or out-of-order version is
 *                        present, the 005 row is duplicated, or the ledger and the objects disagree.
 *                        THIS OUTRANKS `already applied` DELIBERATELY: a valid 005 row must never be
 *                        able to speak over a prefix that is missing 002 or an object set that is
 *                        half built. Both witnesses have to agree before the strongest label is used.
 *   6. already applied — the exact clean 001-004 prefix, exactly one sound 005 row, and a COMPLETE
 *                        object set. Diagnostic only, and still a nonzero exit.
 *   7. residue         — a partial earlier attempt without a ledger row. Refused, never repaired.
 *   8. preconditions not met — everything readable and consistent, some observable gate unsatisfied.
 *   9. observed preconditions met — and it authorizes nothing.
 */
export function chooseDisposition(
  source: Match, observed: boolean | null, residue: Residue, l: LedgerEvidence, aclOk: boolean | null,
): string {
  if (source === 'UNREADABLE') return PREFLIGHT_CODES.EVIDENCE_UNREADABLE;
  if (source === 'MISMATCH') return PREFLIGHT_CODES.SOURCE_DRIFT;

  // THE DIRTY MARKER OUTRANKS EVERY UNREADABLE AXIS, and the ordering is deliberate. `dirty` is only
  // ever 'PRESENT' on a well-formed row set, so reaching here means the marker was genuinely read.
  // It is the single most consequential finding this preflight can make and the one with no
  // implemented recovery; reporting `evidence_unreadable` because some OTHER category could not be
  // read would bury it.
  if (l.dirty === 'PRESENT' || l.m005 === 'DIRTY') return PREFLIGHT_CODES.DIRTY_LEDGER;

  // AN OBSERVED SHAPE MISMATCH IS AN OBSERVATION, and it must be tested before the unreadable block.
  // `classifyLedger` blanks every other axis on a shape mismatch — the rows cannot be trusted
  // against a relation that is not the contract — so this branch is unreachable from below.
  if (l.shape === 'MISMATCH') return PREFLIGHT_CODES.LEDGER_INCONSISTENT;

  // ---- the LEDGER could not be read ----------------------------------------------
  if (l.shape === 'UNREADABLE' || l.prefix === 'UNREADABLE' || l.checksums === 'UNREADABLE'
      || l.dirty === 'UNREADABLE' || l.m005 === 'UNREADABLE'
      || l.unknownOrOutOfOrder === 'UNREADABLE' || l.overflowed) {
    return PREFLIGHT_CODES.EVIDENCE_UNREADABLE;
  }

  // ---- observed LEDGER disagreement: STRUCTURE BEFORE CONTENT ---------------------
  //
  // TESTED BEFORE THE OBJECT AND ACL MEASUREMENT FAILURES BELOW, and that ordering fixes a real
  // burial: an ACL read that merely OVERFLOWS its row bound is a successful read with too many
  // rows, and it made `aclOk` null — which reported a fully read, fully parsed ledger contradiction
  // as `evidence_unreadable`. A contradiction this run DID read outranks a category it did not.
  //
  // STRUCTURE FIRST WITHIN THE BLOCK: `checksums` is computed as "each required version appears
  // exactly once AND each stored hash matches", so a MISSING or DUPLICATED row makes it MISMATCH
  // too — and a checksum-first test reported a structural defect as `checksum_mismatch`, sending
  // the operator to compare hashes for a row that is simply absent.
  if (l.m005 === 'DUPLICATE' || l.prefix === 'MISMATCH' || l.unknownOrOutOfOrder === 'PRESENT') {
    return PREFLIGHT_CODES.LEDGER_INCONSISTENT;
  }
  if (l.checksums === 'MISMATCH' || l.m005 === 'CHECKSUM_MISMATCH') return PREFLIGHT_CODES.CHECKSUM_MISMATCH;

  // ---- the OBJECTS or the ACL could not be read -----------------------------------
  if (residue === 'UNREADABLE' || observed === null || aclOk === null) return PREFLIGHT_CODES.EVIDENCE_UNREADABLE;

  // The ledger agrees with itself; this is the ledger-versus-objects disagreement.
  if (residue === 'INCONSISTENT') return PREFLIGHT_CODES.LEDGER_INCONSISTENT;

  // BOUND TO THE AXIS, NOT ONLY TO `residue`. A direct caller handing in `ALREADY_APPLIED` beside a
  // ledger whose 005 row is ABSENT got the strongest claim this function makes, from a ledger saying
  // the migration was never applied. The restated gate below defends only the last two codes, so it
  // cannot cover these; each favourable label now carries its own precondition.
  if (residue === 'ALREADY_APPLIED') {
    return l.m005 === 'VALID' ? PREFLIGHT_CODES.ALREADY_APPLIED : PREFLIGHT_CODES.LEDGER_INCONSISTENT;
  }
  if (residue === 'PARTIAL_RESIDUE') {
    return l.m005 === 'ABSENT' ? PREFLIGHT_CODES.RESIDUE_PRESENT : PREFLIGHT_CODES.LEDGER_INCONSISTENT;
  }

  // THE LEDGER GATE, RESTATED WITHOUT REFERENCE TO `residue`, and this is not belt-and-braces.
  // Every check above that could catch a 005 row or a broken prefix reads `residue`, which
  // production derives from this same ledger — so on the composed path they agree. A DIRECT caller
  // holding a `residue` from anywhere else could hand in `CLEAN` beside a valid 005 row and reach
  // the favourable code. This function's contract says it is total; that has to hold for the
  // function, not merely for the one call site that happens to satisfy an unstated invariant.
  // WHICH CONJUNCT IS ACTUALLY LIVE, stated because the comment above used to imply all five were.
  // By this point `shape`, `prefix`, `checksums` and `unknownOrOutOfOrder` are already forced: the
  // unreadable block excluded every UNREADABLE, the shape branch excluded MISMATCH, and the
  // structural and checksum branches excluded the rest. Only `m005 === 'ABSENT'` can fire here —
  // and it is the one that matters, because `residue` is an ARGUMENT: a direct caller passing
  // `CLEAN` beside a valid 005 row reaches this line and nothing above it would have caught them.
  // The other four are kept as defence against a future reordering, not because they fire today.
  const ledgerClean = l.prefix === 'MATCH' && l.checksums === 'MATCH'
    && l.unknownOrOutOfOrder === 'ABSENT' && l.shape === 'MATCH' && l.m005 === 'ABSENT';
  if (!ledgerClean) return PREFLIGHT_CODES.LEDGER_INCONSISTENT;

  // Reaching here means the ledger is exactly the clean 001-004 prefix with no 005 row and the
  // object set is empty; only the remaining observable gates can still refuse.
  if (!observed || !aclOk) return PREFLIGHT_CODES.PRECONDITIONS_NOT_MET;
  return PREFLIGHT_CODES.OBSERVED_PRECONDITIONS_MET;
}

/**
 * The ONE place a bounded code becomes a process exit status.
 *
 * ZERO MEANS THE BOUNDED DIAGNOSTIC COMPLETED WITH EVERY OBSERVABLE CONDITION MATCHED. It does not
 * mean the migration is permitted, authorized, or certain to succeed.
 */
export function exitCodeFor(code: string): number {
  return code === PREFLIGHT_CODES.OBSERVED_PRECONDITIONS_MET ? 0 : 2;
}

// ---------------------------------------------------------------------------
// Bounded catalog reads. Every statement below is a FIXED literal; the only values that ever reach
// the server are positional parameters built from this module's own frozen constants, never from
// argv, never from the environment and never from a previous row.
//
// EVERY READ IS INDIVIDUALLY GUARDED, AND THE GUARANTEE IS NARROWER THAN IT LOOKS. A rejected read
// yields `null` — the bounded fact "unreadable" — and the thrown value is dropped UNREAD because a
// driver rejection can carry a DSN or SQL. What the guards buy is that a RESULT-SHAPE anomaly (a
// missing row, a wrong type, an unparsable count) in one category does not discard the others, and
// is never mistaken for a favourable answer: every classifier above is fail-closed on `null`.
//
// WHAT THEY CANNOT BUY, stated rather than implied: these reads share ONE transaction, and
// PostgreSQL aborts the whole transaction on the first statement error, so every later statement
// fails with 25P02 too. A genuine SERVER-side failure therefore produces a uniformly unreadable
// record and the run reports `port_failed` — not a partially populated one. The guards make the
// process honest about shape; they do not make an aborted bracket partially readable.
// ---------------------------------------------------------------------------

/** A single scalar from a single row, or `null`. Never throws, never returns a row. */
async function scalar(port: CatalogReadPort, text: string, params: readonly unknown[], key: string): Promise<unknown> {
  try {
    const rows = await port.query(text, params);
    if (!Array.isArray(rows) || rows.length !== 1) return null;
    const v = rows[0]?.[key];
    return v === undefined ? null : v;
  } catch {
    return null;
  }
}

/** A `count(*)::text` result as a non-negative safe integer, or `null`. */
function toCount(v: unknown): number | null {
  if (typeof v !== 'string' || !/^\d{1,12}$/.test(v)) return null;
  const n = Number(v);
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}

/** A boolean column, strictly. A NULL, a string or a number is missing evidence, never a pass. */
function toBool(v: unknown): boolean | null {
  return typeof v === 'boolean' ? v : null;
}

function toTri(n: number | null): Tri {
  return n === null ? 'UNREADABLE' : (n === 0 ? 'ABSENT' : 'PRESENT');
}

/**
 * Every governed observable precondition, as ONE bounded evidence record.
 *
 * `current_database()` and `current_user` are resolved BY THE SERVER in every statement, so nothing
 * here can be pointed at another database or answered for another principal.
 */
export async function readObservedPreconditionEvidence(port: CatalogReadPort): Promise<ObservedPreconditionEvidence> {
  const dbPriv = await (async () => {
    try {
      const rows = await port.query(
        `select pg_catalog.has_database_privilege('public', pg_catalog.current_database(), 'CREATE')    as c,
                pg_catalog.has_database_privilege('public', pg_catalog.current_database(), 'TEMPORARY') as t`,
        [],
      );
      if (!Array.isArray(rows) || rows.length !== 1) return { c: null, t: null };
      return { c: toBool(rows[0]?.c), t: toBool(rows[0]?.t) };
    } catch {
      return { c: null, t: null };
    }
  })();

  const canCreateRole = toBool(await scalar(
    port, 'select r.rolcreaterole as v from pg_catalog.pg_roles r where r.rolname = current_user', [], 'v',
  ));

  const schema = await (async () => {
    try {
      const rows = await port.query(
        `select count(*)::text as present,
                count(*) filter (where pg_catalog.pg_has_role(current_user, n.nspowner, 'USAGE'))::text as owned
           from pg_catalog.pg_namespace n where n.nspname = 'public'`,
        [],
      );
      if (!Array.isArray(rows) || rows.length !== 1) return { present: null, owned: null };
      const p = toCount(rows[0]?.present);
      const o = toCount(rows[0]?.owned);
      // WHAT `owned = 1` MEANS, stated precisely: the principal can use the schema owner's
      // privileges WITHOUT `SET ROLE`. That covers a direct owner, a database owner reaching
      // `pg_database_owner` through its implicit sole membership, ANY role inheriting from the
      // owning role, and a superuser — for whom `pg_has_role` is true of every role. The field is
      // named `schemaPublicAuthority`, not `schemaPublicOwner`, because effective authority is the
      // precondition 005 actually needs; catalog ownership is merely the commonest way to hold it.
      // CO-ABSORBING, because both counts come from ONE aggregate row. Reporting authority=true
      // beside present=unreadable asserted usable ownership of a schema whose existence this run
      // could not establish — a claim stronger than the one malformed row it was read from. A row
      // that is unparsable in either column is unparsable, and both facts go unread together.
      if (p === null || o === null) return { present: null, owned: null };
      return { present: p === 1, owned: o === 1 };
    } catch {
      return { present: null, owned: null };
    }
  })();

  // Roles. `pg_roles` is a PASSWORD-REDACTED view; `pg_authid` is never referenced, and no
  // credential column is named in any statement in this file.
  const roles = await (async () => {
    try {
      const rows = await port.query(
        `select count(*) filter (where r.rolname = any($1::name[]))::text as created,
                count(*) filter (where r.rolname = any($2::name[]))::text as prereq
           from pg_catalog.pg_roles r`,
        [[...M005_CREATED_ROLES], [...M005_PREREQUISITE_ROLES]],
      );
      if (!Array.isArray(rows) || rows.length !== 1) return { created: null, prereq: null };
      return { created: toCount(rows[0]?.created), prereq: toCount(rows[0]?.prereq) };
    } catch {
      return { created: null, prereq: null };
    }
  })();

  // A comment carrying 005's own marker on ANY role is residue from an earlier attempt even when
  // the role itself has since been renamed. Joined to `pg_roles`, so only role comments are seen.
  const comments = toCount(await scalar(
    port,
    `select count(*)::text as v
       from pg_catalog.pg_shdescription d
       join pg_catalog.pg_roles r on r.oid = d.objoid
      where d.description like $1`,
    ['tmpos:005_principal_separation_rls_foundation:%'],
    'v',
  ));

  const objects = await (async () => {
    try {
      const rows = await port.query(
        `select count(*)::text as present,
                count(*) filter (where pg_catalog.pg_has_role(current_user, c.relowner, 'USAGE'))::text as authoritative,
                count(*) filter (where c.relrowsecurity and c.relname = any($2::name[]))::text as rls
           from pg_catalog.pg_class c
           join pg_catalog.pg_namespace n on n.oid = c.relnamespace
          where n.nspname = 'public' and c.relkind = 'r' and c.relname = any($1::name[])`,
        [[...M005_GOVERNED_TABLES], [...M005_RLS_REQUIRED_TABLES]],
      );
      if (!Array.isArray(rows) || rows.length !== 1) return { present: null, authoritative: null, rls: null };
      return {
        present: toCount(rows[0]?.present),
        authoritative: toCount(rows[0]?.authoritative),
        rls: toCount(rows[0]?.rls),
      };
    } catch {
      return { present: null, authoritative: null, rls: null };
    }
  })();

  const columns = toCount(await scalar(
    port,
    `select count(*)::text as v
       from pg_catalog.pg_attribute a
       join pg_catalog.pg_class c on c.oid = a.attrelid
       join pg_catalog.pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r'
        and a.attnum > 0 and not a.attisdropped
        and (c.relname || '.' || a.attname || ':'
             || pg_catalog.format_type(a.atttypid, a.atttypmod)) = any($1::text[])`,
    [[...M005_REQUIRED_COLUMNS]], 'v',
  ));

  const policies = await (async () => {
    try {
      const rows = await port.query(
        `select count(*) filter (where (p.tablename || '.' || p.policyname) = any($1::text[]))::text as governed,
                count(*) filter (where p.tablename = any($2::name[]))::text as on_governed
           from pg_catalog.pg_policies p where p.schemaname = 'public'`,
        [[...M005_POLICIES], [...M005_RLS_REQUIRED_TABLES]],
      );
      if (!Array.isArray(rows) || rows.length !== 1) return { governed: null, onGoverned: null };
      return { governed: toCount(rows[0]?.governed), onGoverned: toCount(rows[0]?.on_governed) };
    } catch {
      return { governed: null, onGoverned: null };
    }
  })();

  // NAME RESOLUTION, and this is the gap the schema filter above would otherwise hide. EIGHT of
  // migration 005's statements — the `platform_identity` revoke and all seven GRANTs — name their
  // relation WITHOUT a schema, so their target is whatever `search_path` resolves at apply time,
  // while every fact this preflight gathers is scoped to `public`. A relation of a governed name that
  // is VISIBLE from a non-public schema is exactly the shadowing that would send those eight
  // statements somewhere this run never inspected. `pg_table_is_visible` answers the resolution
  // question the way the server itself would — but ON THIS SESSION, which is NOT the apply's session.
  // `ALTER ROLE ... SET search_path` or a later apply-side setting can differ, so this narrows the
  // hazard rather than closing it; the residual is stated in the record.
  const shadowed = toCount(await scalar(
    port,
    `select count(*)::text as v
       from pg_catalog.pg_class c
       join pg_catalog.pg_namespace n on n.oid = c.relnamespace
      where c.relname = any($1::name[])
        and n.nspname <> 'public'
        and pg_catalog.pg_table_is_visible(c.oid)`,
    [[...M005_GOVERNED_TABLES]], 'v',
  ));

  // BOTH GATE BLOCKS ARE `do $$ ... $$;` WITH NO LANGUAGE CLAUSE, i.e. plpgsql. It is the first thing
  // the migration needs and the cheapest thing to be missing.
  const plpgsql = toCount(await scalar(
    port, "select count(*)::text as v from pg_catalog.pg_language where lanname = 'plpgsql'", [], 'v',
  ));

  // REPORTED, NOT GATED — and the record says so. GRANT, REVOKE, ALTER TABLE and CREATE POLICY all
  // fire ddl_command_start/ddl_command_end, so an enabled event trigger can abort or alter what 005
  // does. This preflight can COUNT them; it cannot read what they do, and a managed provider legitimately
  // installs some. Refusing on a nonzero count would make the favourable code unreachable on the target this exists
  // for, so the count is disclosed as an unassessed residual instead of being silently dropped.
  const eventTriggers = toCount(await scalar(
    port, "select count(*)::text as v from pg_catalog.pg_event_trigger where evtenabled <> 'D'", [], 'v',
  ));

  const constraintCount = toCount(await scalar(
    port,
    `select count(*)::text as v
       from pg_catalog.pg_constraint k
       join pg_catalog.pg_class t on t.oid = k.conrelid
       join pg_catalog.pg_namespace n on n.oid = t.relnamespace
      where n.nspname = 'public' and t.relname = $1 and k.conname = $2`,
    [M005_CONSTRAINT.table, M005_CONSTRAINT.name], 'v',
  ));

  // THE ONLY APPLICATION-DATA READ IN THIS FILE, and it is a single aggregate. The predicate is the
  // proposed constraint, negated, so the count answers exactly one question — would ADD CONSTRAINT
  // validate? No column value, no row and no identifier is selected or returned.
  const incompatible = toCount(await scalar(
    port,
    `select count(*)::text as v from public.audit_event
      where not (
        (scope_type in ('platform', 'none') and tenant_id is null and store_id is null)
        or (scope_type = 'tenant' and tenant_id is not null and store_id is null)
        or (scope_type = 'store' and tenant_id is not null and store_id is not null)
      )`,
    [], 'v',
  ));

  const fnCount = toCount(await scalar(
    port,
    `select count(*)::text as v
       from pg_catalog.pg_proc p
       join pg_catalog.pg_namespace n on n.oid = p.pronamespace
      where n.nspname = $1 and p.proname = $2
        and pg_catalog.pg_get_function_identity_arguments(p.oid) = $3`,
    [M005_POLICY_FUNCTION.schema, M005_POLICY_FUNCTION.name, M005_POLICY_FUNCTION.args], 'v',
  ));

  // Migration 005 states, as its stated basis for issuing no sequence grant, that no sequence
  // exists. A sequence that has appeared since invalidates that basis, so it is a bounded count and
  // a fail-closed one rather than a silent assumption.
  const sequences = toCount(await scalar(
    port,
    `select count(*)::text as v from pg_catalog.pg_class c
       join pg_catalog.pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'S'`,
    [], 'v',
  ));

  return {
    publicCreateOnDatabase: dbPriv.c,
    publicTemporaryOnDatabase: dbPriv.t,
    principalCanCreateRole: canCreateRole,
    schemaPublicPresent: schema.present,
    schemaPublicAuthority: schema.owned,
    createdRolesCount: roles.created,
    roleCommentResidue: toTri(comments),
    prerequisiteRoles: roles.prereq === null
      ? 'UNREADABLE' : (roles.prereq === M005_PREREQUISITE_ROLES.length ? 'PRESENT' : 'ABSENT'),
    governedTablesPresent: objects.present,
    governedTablesAuthoritative: objects.authoritative,
    requiredColumnsPresent: columns,
    rlsEnabledTables: objects.rls,
    policiesPresent: policies.governed,
    foreignPoliciesOnGovernedTables: policies.governed === null || policies.onGoverned === null
      ? null : policies.onGoverned - policies.governed,
    governedNamesShadowedOutsidePublic: shadowed,
    plpgsqlPresent: plpgsql === null ? null : plpgsql === 1,
    enabledEventTriggers: eventTriggers,
    constraintPresent: toTri(constraintCount),
    incompatibleAuditRows: incompatible,
    policyFunctionPresent: fnCount === null ? null : fnCount === 1,
    sequencesInPublic: sequences,
  };
}

/**
 * The provider-managed compatibility BOUNDARY, and nothing more.
 *
 * Counts only, no schema or routine name, and no provider API is contacted. This CANNOT establish
 * future Supabase-managed compatibility: the global FUNCTIONS default-privilege row 005 writes
 * governs routines this principal creates in EVERY schema afterwards, including ones an extension
 * has not installed yet, and no catalog read can see a routine that does not exist. The residual
 * stays OPEN/MEDIUM however these counts come out.
 */
export async function readProviderEvidence(port: CatalogReadPort): Promise<ProviderEvidence> {
  const routines = toCount(await scalar(
    port,
    `select count(*)::text as v
       from pg_catalog.pg_proc p
       join pg_catalog.pg_namespace n on n.oid = p.pronamespace
      where n.nspname <> 'public'
        and n.nspname not in ('pg_catalog', 'information_schema')
        and n.nspname not like 'pg\\_%'
        and pg_catalog.pg_has_role(current_user, p.proowner, 'USAGE')`,
    [], 'v',
  ));
  const schemas = toCount(await scalar(
    port,
    `select count(*)::text as v
       from pg_catalog.pg_namespace n
      where n.nspname not in ('pg_catalog', 'information_schema', 'public')
        and n.nspname not like 'pg\\_%'
        and pg_catalog.has_schema_privilege(current_user, n.nspname, 'CREATE')`,
    [], 'v',
  ));
  return { routinesOutsidePublic: routines, creatableNonPublicSchemas: schemas };
}

/** The bounded ledger row read. Overflow is DISCARDED, never truncated and never partially used. */
export async function readLedgerRowsBounded(
  port: CatalogReadPort, limit: number = LEDGER_ROW_LIMIT,
): Promise<{ rows: { version: unknown; checksum: unknown; dirty: unknown }[] | null; overflowed: boolean }> {
  try {
    const rows = await port.query(
      'select version, checksum, dirty from public.schema_migrations order by version asc limit $1',
      [limit + 1],
    );
    if (!Array.isArray(rows)) return { rows: null, overflowed: false };
    if (rows.length > limit) return { rows: null, overflowed: true };
    return {
      rows: rows.map((r) => ({ version: r?.version, checksum: r?.checksum, dirty: r?.dirty })),
      overflowed: false,
    };
  } catch {
    return { rows: null, overflowed: false };
  }
}

/**
 * The expected 001-004 checksums, computed from the governed artifact BYTES on disk.
 *
 * SHA-256 over exact bytes, identical to the engine's own migration checksum, so a ledger row that
 * disagrees means the stored history does not describe the files this repository now holds.
 * Returns `null` when any file is unreadable — an unverifiable expectation is not an expectation.
 */
export function expectedPrefixChecksums(dir: string = MIGRATIONS_DIR): Map<string, string> | null {
  const out = new Map<string, string>();
  try {
    for (let i = 0; i < LEDGER_PREFIX_VERSIONS.length; i += 1) {
      const bytes = readFileSync(join(dir, LEDGER_PREFIX_BASENAMES[i] as string));
      out.set(LEDGER_PREFIX_VERSIONS[i] as string, createHash('sha256').update(bytes).digest('hex'));
    }
  } catch {
    return null;
  }
  // AND THE 005 EXPECTATION, taken from the GOVERNED CONSTANT rather than from disk. If the on-disk
  // 005 has drifted, `readGovernedUpSql` has already refused with SOURCE_DRIFT before any socket
  // exists, so binding here to the constant means a ledger row is compared against the migration
  // this preflight is actually for — not against whatever the working tree currently holds.
  out.set(M005_LEDGER_VERSION, M005_UP_SHA256);
  return out;
}

/** The governed migration directory, resolved from THIS module's own location, never from argv. */
export const MIGRATIONS_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)), '..', 'server', 'platform-identity', 'migrations',
);

/** The frozen migration-005 up bytes, or `null`. Read once, and only for the source prediction. */
export type GovernedSourceRead =
  | { readonly status: 'match'; readonly sql: string }
  | { readonly status: 'drift' }
  | { readonly status: 'unreadable' };

/**
 * The frozen migration-005 up bytes, re-bound to the governed checksum before a single character is
 * reasoned about.
 *
 * THE TWO FAILURES ARE DIFFERENT FACTS AND ARE NO LONGER COLLAPSED. Returning `null` for both made
 * `SOURCE_DRIFT` unreachable from the production entry point: a genuinely edited migration reported
 * `evidence_unreadable`, which reads as "this process could not open a file" rather than "the
 * governed bytes are not the ones this preflight reasons about". Those call for different operator
 * responses, and only one of them means the repository changed.
 */
export function readGovernedUpSql(dir: string = MIGRATIONS_DIR): GovernedSourceRead {
  let bytes: Buffer;
  try {
    bytes = readFileSync(join(dir, '005_principal_separation_rls_foundation.up.sql'));
  } catch {
    return { status: 'unreadable' };
  }
  if (createHash('sha256').update(bytes).digest('hex') !== M005_UP_SHA256) return { status: 'drift' };
  return { status: 'match', sql: bytes.toString('utf8') };
}

/** The bounded backend-continuity token, or `null` when it cannot be read. Never emitted. */
async function readBackendToken(session: unknown): Promise<string | null> {
  try {
    const port = session as { backendIdentity?: () => Promise<unknown> } | null;
    if (port === null || typeof port !== 'object' || typeof port.backendIdentity !== 'function') return null;
    const id = await port.backendIdentity();
    if (id === null || typeof id !== 'object') return null;
    const token = (id as Record<string, unknown>).token;
    if (typeof token !== 'string' || token === '' || token.includes('undefined')) return null;
    return token;
  } catch {
    return null;
  }
}

/**
 * The whole preflight, as a sequence over injected ports.
 *
 * Split out from `main` so the deterministic suite can drive the ENTIRE ordering — including that
 * `begin()` precedes every query and that both continuity captures bracket the reads — against fake
 * ports, with no client, no environment and no process. `deps` exists for that and nothing else;
 * production passes none of it.
 *
 * THIS IS A STATE MACHINE, NOT A `try/finally`. A `return` chosen inside a protected block IS the
 * completion value the moment it executes, and a later `finally` cannot change it however much it
 * emits. So the primary run RECORDS a bounded code, cleanup runs afterwards on the ordinary path,
 * and the returned number is chosen ONCE, at the end, from the primary fact and the cleanup facts
 * together. A cleanup failure can therefore overrule a favourable verdict, which is the point.
 */
export async function runPreflight(
  source: NodeJS.ProcessEnv,
  emit: Emit,
  deps: {
    createExecutor?: typeof createManagedDevExecutor;
    assertDsn?: typeof assertManagedDevDsn;
    describeDsn?: typeof describeManagedDsn;
    fingerprint?: typeof verifyManagedDevFingerprint;
    readAcl?: typeof readDefaultAclRowsBounded;
    ledgerShape?: typeof verifyLedgerShape;
    rlsMode?: typeof readLedgerRlsMode;
    ledgerPolicies?: typeof readLedgerPoliciesBounded;
    ledgerPrivileges?: typeof readLedgerPrivilegesBounded;
    eventTriggers?: typeof readEventTriggersBounded;
    readObservedPreconditions?: typeof readObservedPreconditionEvidence;
    readProvider?: typeof readProviderEvidence;
    readLedgerRows?: typeof readLedgerRowsBounded;
    upSql?: () => GovernedSourceRead;
    prefixChecksums?: () => Map<string, string> | null;
  } = {},
): Promise<number> {
  // THE THREE REFUSALS BELOW RETURN BEFORE THE PROTECTED BLOCK EXISTS, so the single emission
  // after it cannot reach them. They are the EARLIEST refusals the child makes and the furthest
  // from contact — which is precisely when an operator is most likely to read the record as
  // "these questions do not arise here" if the residuals are missing from it.
  const refuse = (n: number): number => {
    for (const line of residualFacts()) emit(line);
    return n;
  };

  // ---- gates, before anything that could open a socket -----------------------
  //
  // NOTHING IS CONSTRUCTED YET, so returning here cannot skip a rollback or a disposal: there is no
  // handle, no bracket and no cleanup record to write.
  if (source.NODE_ENV === 'production') {
    emit(`[m005-preflight] REFUSED: ${PREFLIGHT_CODES.PRODUCTION_FORBIDDEN}`);
    return refuse(2);
  }
  if (source.CONFIRM_SUPABASE_TARGET !== EXPECTED_DEV_TARGET) {
    // NAME only. Whether the variable is absent or merely different is not reported — both are the
    // same refusal, which is what keeps this from becoming a presence probe.
    emit(`[m005-preflight] REFUSED: ${PREFLIGHT_CODES.TARGET_UNCONFIRMED} name=CONFIRM_SUPABASE_TARGET`);
    return refuse(2);
  }

  // ---- the SOURCE prediction, taken before any socket exists -------------------
  //
  // Deliberately first: if the frozen bytes are not the ones this preflight reasons about, every
  // governed object list below describes a different migration and no connection should be opened
  // to answer questions about it.
  const governed = (deps.upSql ?? readGovernedUpSql)();
  // A CHECKSUM DRIFT IS ITS OWN LABEL, not an unreadable one, and it does not need the role scan to
  // establish it: if the bytes are not the governed bytes, nothing derived from them describes the
  // migration this preflight is for.
  const sourceMatch: Match = governed.status === 'drift'
    ? 'MISMATCH'
    : (governed.status === 'unreadable' ? 'UNREADABLE' : predictCreatedRoleSource(governed.sql));
  emit(`[m005-preflight] governedSource=${sourceMatch}`);
  if (sourceMatch !== 'MATCH') {
    const code = sourceMatch === 'MISMATCH' ? PREFLIGHT_CODES.SOURCE_DRIFT : PREFLIGHT_CODES.EVIDENCE_UNREADABLE;
    emit(`[m005-preflight] REFUSED: ${code}`);
    // BEFORE the outcome, not after it: this path is the one pre-bracket refusal that computes an
    // outcome at all, and the outcome stays the last word here exactly as it is on every path that
    // reaches cleanup.
    for (const line of residualFacts()) emit(line);
    emit(`[m005-preflight] outcome=${code}`);
    return exitCodeFor(code);
  }

  const assertDsn = deps.assertDsn ?? assertManagedDevDsn;
  const describe = deps.describeDsn ?? describeManagedDsn;
  const create = deps.createExecutor ?? createManagedDevExecutor;
  const fingerprint = deps.fingerprint ?? verifyManagedDevFingerprint;
  const readAcl = deps.readAcl ?? readDefaultAclRowsBounded;
  const ledgerShape = deps.ledgerShape ?? verifyLedgerShape;
  const rlsMode = deps.rlsMode ?? readLedgerRlsMode;
  const ledgerPolicies = deps.ledgerPolicies ?? readLedgerPoliciesBounded;
  const ledgerPrivileges = deps.ledgerPrivileges ?? readLedgerPrivilegesBounded;
  const eventTriggers = deps.eventTriggers ?? readEventTriggersBounded;
  const readObservedPreconditions = deps.readObservedPreconditions ?? readObservedPreconditionEvidence;
  const readProvider = deps.readProvider ?? readProviderEvidence;
  const readLedger = deps.readLedgerRows ?? readLedgerRowsBounded;
  const prefixChecksums = (deps.prefixChecksums ?? expectedPrefixChecksums)();

  let handle: Awaited<ReturnType<typeof createManagedDevExecutor>> | null = null;
  let opened = false;
  /** The PRIMARY fact only. Never this function's completion value — see the header. */
  let primaryCode: string = PREFLIGHT_CODES.EVIDENCE_UNREADABLE;

  primary: try {
    const dsn = assertDsn(source.SUPABASE_DATABASE_URL, source.SUPABASE_URL, EXPECTED_DATABASE);
    const shape = describe(dsn);
    if (shape.database !== EXPECTED_DATABASE) {
      primaryCode = PREFLIGHT_CODES.TARGET_INVALID;
      emit(`[m005-preflight] REFUSED: ${PREFLIGHT_CODES.TARGET_INVALID}`);
      break primary;
    }
    // BOUNDED BEFORE IT IS PRINTED. `database` is compared against its expected literal above, so it
    // can only be that literal by the time it is emitted; `endpointFamily` had no such bound and was
    // forwarded verbatim from a dependency. Production's `describeManagedDsn` pins it to one literal,
    // but a value that reaches the operator record should be bounded where it is printed.
    const family = shape.endpointFamily === 'session' ? 'session' : 'unrecognized';
    // DATABASE IS PRINTED AS A FIXED SOURCE TOKEN, never as the value. The guard immediately above
    // has already proved the value equals `EXPECTED_DATABASE`, so the token says everything the
    // value did — and unlike the value its rendering cannot vary with the credential. See
    // TARGET_DATABASE_FIELD for the redactor interaction that made the value non-deterministic.
    emit(`[m005-preflight] target endpointFamily=${family} database=${TARGET_DATABASE_FIELD}`);

    handle = await create(dsn);
    const session = await handle.adapter.reserve('session');

    // ---- the REPEATABLE READ, READ ONLY bracket, opened BEFORE any query -------
    await handle.snapshotTx.begin();
    opened = true;
    await handle.snapshotTx.applyLocalTimeouts(TX_TIMEOUT_MS);

    if ((await handle.snapshotTx.isReadOnly()) !== true) {
      primaryCode = PREFLIGHT_CODES.READ_ONLY_NOT_ESTABLISHED;
      emit(`[m005-preflight] REFUSED: ${PREFLIGHT_CODES.READ_ONLY_NOT_ESTABLISHED}`);
      break primary;
    }
    // ISOLATION IS PROVED, NOT ASSUMED. `serializable` is strictly stronger and would also give one
    // snapshot, but it is NOT accepted here: this preflight asserts the level it declared, and a
    // bracket that silently took a different one is evidence the statement did not do what the
    // record says it did.
    const isolationBefore = await handle.snapshotTx.isolationLevel();
    if (isolationBefore !== REQUIRED_ISOLATION) {
      primaryCode = PREFLIGHT_CODES.ISOLATION_NOT_ESTABLISHED;
      emit(`[m005-preflight] REFUSED: ${PREFLIGHT_CODES.ISOLATION_NOT_ESTABLISHED}`);
      break primary;
    }
    emit('[m005-preflight] transaction readOnly=true isolation=repeatable_read');

    // ---- backend continuity, capture 1 -----------------------------------------
    //
    // AN UNREADABLE FIRST TOKEN IS NOT A CHANGE: nothing has been established yet, so there is
    // nothing for it to differ from, and the accurate bounded code is unreadable evidence.
    const firstToken = await readBackendToken(session);
    if (firstToken === null) {
      primaryCode = PREFLIGHT_CODES.EVIDENCE_UNREADABLE;
      emit(`[m005-preflight] REFUSED: ${PREFLIGHT_CODES.EVIDENCE_UNREADABLE}`);
      break primary;
    }

    // ---- identity ---------------------------------------------------------------
    const who = await handle.catalog.query(
      'select current_user as principal, session_user as session_principal, current_database() as db', [],
    );
    const principal = who[0]?.principal;
    const sessionPrincipal = who[0]?.session_principal;
    const database = who[0]?.db;
    if (typeof principal !== 'string' || principal === ''
        || typeof sessionPrincipal !== 'string' || sessionPrincipal === ''
        || database !== EXPECTED_DATABASE) {
      primaryCode = PREFLIGHT_CODES.IDENTITY_UNCONFIRMED;
      emit(`[m005-preflight] REFUSED: ${PREFLIGHT_CODES.IDENTITY_UNCONFIRMED}`);
      break primary;
    }
    // AGREEMENT ONLY. Neither role NAME is printed, and the agreement is ENFORCED rather than merely
    // reported: every ownership and default-ACL fact below is scoped to `current_user`, so under a
    // mismatch the verdict would describe authority the SESSION never proved it holds.
    emit(`[m005-preflight] principal currentMatchesSession=${String(principal === sessionPrincipal)}`);
    if (principal !== sessionPrincipal) {
      primaryCode = PREFLIGHT_CODES.IDENTITY_UNCONFIRMED;
      emit(`[m005-preflight] REFUSED: ${PREFLIGHT_CODES.IDENTITY_UNCONFIRMED}`);
      break primary;
    }
    emit(`[m005-preflight] database targetAgreement=${String(database === EXPECTED_DATABASE)}`);

    // ---- application fingerprint: MATCH / MISMATCH only --------------------------
    // GUARDED LIKE EVERY OTHER READ. This one and the ACL read below were the two exceptions: neither
    // helper carries its own try/catch, so a rejection escaped into the outer handler and collapsed
    // the whole run to `port_failed` — discarding the evidence already gathered and skipping the
    // continuity and read-only re-checks that come after. A rejection here is now the same bounded
    // MISMATCH an unreadable fingerprint always was.
    // A REJECTION IS NOT A DISAGREEMENT. Returning a synthetic failure label made a port rejection —
    // an aborted transaction, a statement timeout — report `fingerprint_mismatch`, a specific claim
    // that the application identity on the target differs from the expected one, drawn from a
    // comparison that never ran. `null` is the third state: evidence that could not be obtained.
    const fpFailures = await (async () => {
      try {
        return await fingerprint(handle!.catalog, FINGERPRINT_EXPECTATIONS);
      } catch {
        return null;
      }
    })();
    const fp: Match = fpFailures === null ? 'UNREADABLE' : (fpFailures.length === 0 ? 'MATCH' : 'MISMATCH');
    // The failure STRINGS are consumed here and never emitted: they can name an application
    // identifier, and no application row or identifier may reach operator output.
    emit(`[m005-preflight] applicationFingerprint=${fp}`);
    if (fp !== 'MATCH') {
      primaryCode = fp === 'MISMATCH'
        ? PREFLIGHT_CODES.FINGERPRINT_MISMATCH
        : PREFLIGHT_CODES.EVIDENCE_UNREADABLE;
      emit(`[m005-preflight] REFUSED: ${primaryCode}`);
      break primary;
    }

    // ---- the bounded reads, all inside the one snapshot --------------------------
    const observed = await readObservedPreconditions(handle.catalog);
    const provider = await readProvider(handle.catalog);
    const shapeResult = await (async () => {
      try {
        return await ledgerShape(handle!.catalog);
      } catch {
        return null;
      }
    })();
    const ledgerRead = await readLedger(handle.catalog, LEDGER_ROW_LIMIT);
    const acl = await (async () => {
      try {
        return await readAcl(handle!.catalog, DEFAULT_ACL_ROW_LIMIT);
      } catch {
        // OVERFLOWED IS THE FAIL-CLOSED SHAPE: `assessDefaultAclPosture` reports every category
        // UNREADABLE for it, which is exactly what an unread ACL is.
        return { rows: [], overflowed: true };
      }
    })();

    // ---- ledger-RLS repair-safety evidence, inside the SAME snapshot ---------------
    //
    // EACH READ IS GUARDED SEPARATELY. A rejection here is missing evidence about one axis, not a
    // reason to discard the shape finding the run already has; the classifiers below turn every
    // null into UNREADABLE rather than into a favourable posture.
    const guarded = async <T>(f: () => Promise<T>): Promise<T | null> => {
      try { return await f(); } catch { return null; }
    };
    const rlsModeRead = await guarded(() => rlsMode(handle!.catalog));
    const policyRead = await guarded(() => ledgerPolicies(handle!.catalog));
    const privilegeRead = await guarded(() => ledgerPrivileges(handle!.catalog));
    const triggerRead = await guarded(() => eventTriggers(handle!.catalog));

    // ---- backend continuity, capture 2 -------------------------------------------
    //
    // EXACT AGREEMENT, AND NO VERDICT WITHOUT IT. An unreadable second token and a differing token
    // are the same refusal: both mean the run cannot prove the rows it just read came from the
    // backend whose identity and isolation it checked. No retry and no reconnect.
    // THE TWO WAYS THIS CAN FAIL ARE DIFFERENT CLAIMS, and they were collapsed. `BACKEND_IDENTITY_
    // CHANGED` asserts the connection moved to another backend — a specific, alarming finding. But
    // the FIRST statement error inside the bracket aborts the whole transaction, so the second
    // `pg_backend_pid()` throws and was swallowed to `null`, and every ordinary aborted read
    // reported a backend change that nothing had observed. An unread token is unread evidence.
    const secondToken = await readBackendToken(session);
    const continuity = secondToken === null
      ? 'UNREADABLE'
      : (secondToken === firstToken ? 'AGREED' : 'BROKEN');
    emit(`[m005-preflight] backendContinuity=${continuity}`);
    if (continuity !== 'AGREED') {
      primaryCode = continuity === 'BROKEN'
        ? PREFLIGHT_CODES.BACKEND_IDENTITY_CHANGED
        : PREFLIGHT_CODES.EVIDENCE_UNREADABLE;
      emit(`[m005-preflight] REFUSED: ${primaryCode}`);
      break primary;
    }

    // ---- read-only and isolation re-verified AFTER the reads -----------------------
    if ((await handle.snapshotTx.isReadOnly()) !== true) {
      primaryCode = PREFLIGHT_CODES.READ_ONLY_LOST;
      emit(`[m005-preflight] REFUSED: ${PREFLIGHT_CODES.READ_ONLY_LOST}`);
      break primary;
    }
    if ((await handle.snapshotTx.isolationLevel()) !== isolationBefore) {
      primaryCode = PREFLIGHT_CODES.ISOLATION_LOST;
      emit(`[m005-preflight] REFUSED: ${PREFLIGHT_CODES.ISOLATION_LOST}`);
      break primary;
    }

    // ---- and ONLY NOW is a verdict computed or spoken -------------------------------
    const ledger = classifyLedger(
      shapeResult,
      ledgerRead.rows,
      ledgerRead.overflowed,
      prefixChecksums ?? new Map<string, string>(),
    );
    // An unreadable expectation must not masquerade as a checksum MISMATCH, which would read as a
    // tampered history rather than as a repository this process could not measure.
    const ledgerFinal: LedgerEvidence = prefixChecksums === null
      ? { ...ledger, checksums: 'UNREADABLE' } : ledger;

    const assessment = assessDefaultAclPosture(principal, sessionPrincipal, acl);
    const aclReadable = !acl.overflowed && assessment.principalAgreement === 'AGREED'
      && assessment.postcondition !== 'UNREADABLE'
      && assessment.blockerSurvivesCurrentM005 !== 'UNREADABLE'
      && assessment.globalBase.tables !== 'UNREADABLE'
      && assessment.globalBase.sequences !== 'UNREADABLE';
    // A=MET IS NOT REQUIRED, and saying so is the whole point of the A/B split: migration 005 exists
    // to CHANGE the posture, so demanding the destination as a precondition would refuse every
    // database the migration is for. What is required is that nothing 005 leaves behind blocks it,
    // and that no global TABLES or SEQUENCES row — a class 005 issues no global statement for —
    // has been widened from outside.
    const aclOk = !aclReadable ? null : (
      assessment.blockerSurvivesCurrentM005 === 'NO'
      && assessment.globalBase.tables === 'BUILTIN_RETAINED'
      && assessment.globalBase.sequences === 'BUILTIN_RETAINED'
    );

    const residue = classifyResidue(observed, ledgerFinal);
    const observedOk = assessObservedPreconditions(observed);

    for (const line of renderEvidence(observed, provider, ledgerFinal, assessment, acl.overflowed, residue)) {
      emit(line);
    }

    // THE REPAIR-SAFETY POSTURE, rendered AFTER the existing record and BEFORE the disposition, so
    // it can never be mistaken for an input to it: nothing below reads any of these values.
    for (const line of renderLedgerRepairSafety(
      rlsModeRead,
      classifyRlsApplicability(rlsModeRead),
      classifyPolicies(policyRead),
      classifyPrivilegePosture(privilegeRead, rlsModeRead),
      classifyEventTriggers(triggerRead),
    )) {
      emit(line);
    }

    primaryCode = chooseDisposition(sourceMatch, observedOk, residue, ledgerFinal, aclOk);
    emit(`[m005-preflight] disposition=${primaryCode}`);
    if (primaryCode !== PREFLIGHT_CODES.OBSERVED_PRECONDITIONS_MET) {
      emit(`[m005-preflight] REFUSED: ${primaryCode}`);
    }
    if (ledgerFinal.dirty === 'PRESENT') {
      // NO REMEDY IS NAMED. No managed command resolves a dirty marker, nothing here clears one, and
      // no second connection is opened. Resolution is separately authorized investigation.
      emit('[m005-preflight] dirtyMarker=PRESENT; nothing is cleared, nothing is retried, no second connection is opened, and no resolution command is authorized or implemented');
    }
  } catch {
    // The thrown value is dropped UNREAD: it can carry a DSN, a credential or SQL. Only the bounded
    // fact crosses. No retry, no alternate connection, no endpoint change, no TLS relaxation.
    primaryCode = PREFLIGHT_CODES.PORT_FAILED;
    emit(`[m005-preflight] REFUSED: ${PREFLIGHT_CODES.PORT_FAILED}`);
  }

  // EXACTLY ONCE, AFTER EVERY PRIMARY PATH AND BEFORE CLEANUP. Placed here rather than inside the
  // protected block so that a `break primary`, a thrown port failure and a computed disposition all
  // reach it, and placed before cleanup so it can neither bypass nor pre-empt the teardown record.
  for (const line of residualFacts()) emit(line);

  // ---- cleanup: attempted at most once each, BEFORE any completion is chosen ----
  const cleanup = {
    rollback: 'not_required' as 'not_required' | 'completed' | 'failed',
    disposalRequested: false,
    disposalCompleted: false,
    // TYPE-BOUND LIKE ITS SIBLING ABOVE. This value is rendered into the operator record, and the
    // grammar guard that proves it survives canonicalisation drives a domain DECLARED in the test.
    // A declared domain cannot notice a value nobody declared, so the closed union is what makes a
    // third value a compile error instead of quietly stale coverage.
    gracefulSocketClose: 'not_observed' as 'not_observed' | 'unknown',
  };

  if (handle !== null) {
    if (opened) {
      try {
        await handle.snapshotTx.finish();
        cleanup.rollback = 'completed';
      } catch {
        // Dropped UNREAD — it can carry SQL or a DSN — but the FACT is kept. Disposal is a DIFFERENT
        // operation: a completed teardown says the client shut down and says nothing whatever about
        // whether the ROLLBACK succeeded.
        cleanup.rollback = 'failed';
      }
    }
    let teardown: unknown = null;
    try {
      teardown = await handle.dispose();
    } catch {
      teardown = null;
    }
    // STRICT POSITIVE EVIDENCE — both fields, literal `true`. Missing, malformed, non-boolean,
    // truthy-but-not-true and rejected all land in the same place: not proven complete, so failed.
    // Reading it is itself guarded: a throwing accessor must fail the run, never escape it.
    try {
      const t = (teardown !== null && typeof teardown === 'object')
        ? teardown as Record<string, unknown>
        : null;
      cleanup.disposalRequested = t?.requested === true;
      cleanup.disposalCompleted = t?.completed === true;
      // NEVER a claim about the socket. `client.end({timeout:0})` destroys it and reports nothing
      // about a graceful FIN exchange, so the only value echoed is the port's own 'not_observed';
      // ANY other value — including a port claiming a graceful close — is reported as unknown.
      cleanup.gracefulSocketClose = t?.gracefulSocketClose === 'not_observed' ? 'not_observed' : 'unknown';
    } catch {
      cleanup.disposalRequested = false;
      cleanup.disposalCompleted = false;
      cleanup.gracefulSocketClose = 'unknown';
    }

    emit(`[m005-preflight] cleanup rollback=${cleanup.rollback}`
      + ` disposalRequested=${String(cleanup.disposalRequested)}`
      + ` disposalCompleted=${String(cleanup.disposalCompleted)}`
      + ` gracefulSocketClose=${cleanup.gracefulSocketClose}`);
    if (cleanup.rollback === 'failed') emit(`[m005-preflight] REFUSED: ${PREFLIGHT_CODES.ROLLBACK_FAILED}`);
    if (!(cleanup.disposalRequested && cleanup.disposalCompleted)) {
      emit(`[m005-preflight] REFUSED: ${PREFLIGHT_CODES.TEARDOWN_FAILED}`);
    }
  }

  // ---- the ONE completion decision, taken after cleanup has settled ---------------
  //
  // CLEANUP WINS THE OUTCOME CODE when it failed: it is the fact about whether anything may still be
  // running, and it must be able to overrule a favourable verdict. A primary refusal, when there was
  // one, is already on its own REFUSED line above, so neither fact is lost.
  const disposalFailed = handle !== null && !(cleanup.disposalRequested && cleanup.disposalCompleted);
  const cleanupCode = cleanup.rollback === 'failed'
    ? PREFLIGHT_CODES.ROLLBACK_FAILED
    : (disposalFailed ? PREFLIGHT_CODES.TEARDOWN_FAILED : null);
  const code = cleanupCode ?? primaryCode;
  emit(`[m005-preflight] outcome=${code}`);
  return exitCodeFor(code);
}

/**
 * The bounded evidence record. FIXED LABELS, BOOLEANS AND COUNTS ONLY.
 *
 * Extracted and exported so a test can drive every field over synthetic evidence and assert that no
 * identifier, expression, row or name can appear. Counts are reported as `observed/required` so a
 * reader sees WHICH check failed without any object being named.
 */
// ---------------------------------------------------------------------------
// C2B-M005-LRLS-B0 — LEDGER-RLS REPAIR-SAFETY CLASSIFICATION
//
// `ledgerShapeCategories=ROW_LEVEL_SECURITY` proves row-level security is ENABLED on the ledger.
// It proves nothing about whether THIS connection is filtered by it, and the difference decides
// whether a contemplated repair is a no-op for the migrator or a change to what it can read.
//
// Four independent facts settle that, and collapsing any of them loses the answer:
//   - RLS enabled            — are policies consulted for anyone at all;
//   - FORCE RLS              — is the table OWNER also subjected to them;
//   - table ownership        — is this principal that owner;
//   - superuser / BYPASSRLS  — does this principal bypass policies regardless.
//
// A second question is separate again: if RLS were switched off, ordinary SQL privileges become the
// only access boundary, and existing policies would remain STORED and simply stop being consulted.
// So the privilege posture is evidence about the repair, not about the present state.
// ---------------------------------------------------------------------------

export type Bool3 = 'TRUE' | 'FALSE' | 'UNREADABLE';

export const b3 = (v: boolean | null | undefined): Bool3 =>
  (v === true ? 'TRUE' : v === false ? 'FALSE' : 'UNREADABLE');

/** Whether policies are consulted FOR THIS PRINCIPAL. Kept distinct from whether RLS is enabled. */
export type RlsApplicability =
  | 'BYPASS_SUPERUSER_OR_BYPASSRLS'
  | 'BYPASS_TABLE_OWNER'
  | 'SUBJECT_TO_POLICIES'
  | 'UNREADABLE';

export interface LedgerRlsModeEvidence {
  readonly rlsEnabled: boolean | null;
  readonly forceRls: boolean | null;
  readonly currentIsSessionPrincipal: boolean | null;
  readonly currentOwnsLedger: boolean | null;
  readonly ledgerOwnerIsDatabaseOwner: boolean | null;
  readonly currentIsSuperuser: boolean | null;
  readonly currentHasBypassRls: boolean | null;
  /** PostgreSQL's own `row_security_active` verdict; a CROSS-CHECK, not a replacement. */
  readonly rowSecurityActiveForCurrent: boolean | null;
}

/**
 * What `row_security_active` MUST report if the authority booleans are to be believed.
 *
 * Each clause is a documented PostgreSQL rule, not an inference: RLS off means nothing is applied;
 * a superuser and a BYPASSRLS role bypass row security regardless of the relation; a table owner is
 * exempt unless FORCE ROW LEVEL SECURITY is set. Anything unreadable yields null, which the caller
 * treats as a FAILED cross-check rather than as agreement.
 */
export function expectedRowSecurityActive(m: LedgerRlsModeEvidence): boolean | null {
  const { rlsEnabled, forceRls, currentOwnsLedger, currentIsSuperuser, currentHasBypassRls } = m;
  if (rlsEnabled === null || currentIsSuperuser === null || currentHasBypassRls === null) return null;
  if (rlsEnabled === false) return false;
  if (currentIsSuperuser === true || currentHasBypassRls === true) return false;
  if (currentOwnsLedger === null || forceRls === null) return null;
  if (currentOwnsLedger === true && forceRls === false) return false;
  return true;
}

/**
 * TOTAL and fail-closed. Any unreadable input makes the whole derivation UNREADABLE rather than
 * letting a missing bypass flag read as "not bypassing", which is the favourable direction.
 *
 * BYPASS_TABLE_OWNER REQUIRES FORCE RLS TO BE FALSE. An owner of a table carrying FORCE ROW LEVEL
 * SECURITY is subject to its policies exactly like anyone else, so ownership alone is not a bypass.
 *
 * THE SERVER GETS THE LAST WORD. The label below is derived from catalog flags this process
 * interprets itself; `row_security_active` is the database's own answer to the same question. When
 * the two disagree — or when either is missing or malformed — the derivation is not reconciled in
 * this process's favour, it is DISCARDED: UNREADABLE, never a favourable repair-safety result. The
 * individual booleans survive the disagreement and are still rendered; only the conclusion drawn
 * from them is withdrawn.
 */
export function classifyRlsApplicability(m: LedgerRlsModeEvidence | null): RlsApplicability {
  if (m === null) return 'UNREADABLE';
  const { forceRls, currentOwnsLedger, currentIsSuperuser, currentHasBypassRls } = m;
  const expected = expectedRowSecurityActive(m);
  if (expected === null || m.rowSecurityActiveForCurrent !== expected) return 'UNREADABLE';
  if (currentIsSuperuser === null || currentHasBypassRls === null) return 'UNREADABLE';
  if (currentIsSuperuser === true || currentHasBypassRls === true) return 'BYPASS_SUPERUSER_OR_BYPASSRLS';
  if (currentOwnsLedger === null || forceRls === null) return 'UNREADABLE';
  if (currentOwnsLedger === true && forceRls === false) return 'BYPASS_TABLE_OWNER';
  return 'SUBJECT_TO_POLICIES';
}

// ---- policy inventory -------------------------------------------------------

export const POLICY_COMMAND_CLASSES: readonly string[] = Object.freeze([
  'ALL', 'SELECT', 'INSERT', 'UPDATE', 'DELETE',
]);

/** `pg_policy.polcmd` letters. An unrecognized letter fails the whole inventory closed. */
const POLICY_CMD_BY_LETTER: Readonly<Record<string, string>> = Object.freeze({
  '*': 'ALL', r: 'SELECT', a: 'INSERT', w: 'UPDATE', d: 'DELETE',
});

export interface PolicyInventory {
  readonly readable: boolean;
  readonly total: number;
  readonly permissive: number;
  readonly restrictive: number;
  readonly commandClasses: readonly string[];
  readonly anyTargetsPublic: boolean;
  readonly anyAppliesToCurrent: boolean;
  readonly anyTargetsOnlyOtherRoles: boolean;
  readonly withUsing: number;
  readonly withCheck: number;
}

export const UNREADABLE_POLICY_INVENTORY: PolicyInventory = Object.freeze({
  readable: false, total: 0, permissive: 0, restrictive: 0, commandClasses: Object.freeze([]),
  anyTargetsPublic: false, anyAppliesToCurrent: false, anyTargetsOnlyOtherRoles: false,
  withUsing: 0, withCheck: 0,
});

/**
 * Counts and fixed tokens only. Overflow discards the observations — a truncated policy set is not
 * a policy posture, and reporting the visible half as one would understate exposure.
 */
export function classifyPolicies(read: {
  rows: readonly {
    permissive: boolean | null; cmd: string | null; hasUsing: boolean | null;
    hasWithCheck: boolean | null; targetsPublic: boolean | null;
    appliesToCurrent: boolean | null; targetsOnlyOtherRoles: boolean | null;
  }[];
  overflowed: boolean;
} | null): PolicyInventory {
  if (read === null || read.overflowed) return UNREADABLE_POLICY_INVENTORY;
  const classes = new Set<string>();
  let permissive = 0; let restrictive = 0; let withUsing = 0; let withCheck = 0;
  let anyTargetsPublic = false; let anyAppliesToCurrent = false; let anyTargetsOnlyOtherRoles = false;
  for (const p of read.rows) {
    // EVERY FIELD MUST BE READABLE. One malformed policy makes the SET unreadable: a policy whose
    // applicability could not be determined cannot be excluded from the ones that apply.
    if (p.permissive === null || p.hasUsing === null || p.hasWithCheck === null
        || p.targetsPublic === null || p.appliesToCurrent === null || p.targetsOnlyOtherRoles === null) {
      return UNREADABLE_POLICY_INVENTORY;
    }
    const cls = p.cmd === null ? undefined : POLICY_CMD_BY_LETTER[p.cmd];
    if (cls === undefined) return UNREADABLE_POLICY_INVENTORY;
    classes.add(cls);
    if (p.permissive) permissive += 1; else restrictive += 1;
    if (p.hasUsing) withUsing += 1;
    if (p.hasWithCheck) withCheck += 1;
    if (p.targetsPublic) anyTargetsPublic = true;
    if (p.appliesToCurrent) anyAppliesToCurrent = true;
    if (p.targetsOnlyOtherRoles) anyTargetsOnlyOtherRoles = true;
  }
  return {
    readable: true, total: read.rows.length, permissive, restrictive,
    commandClasses: POLICY_COMMAND_CLASSES.filter((c) => classes.has(c)),
    anyTargetsPublic, anyAppliesToCurrent, anyTargetsOnlyOtherRoles, withUsing, withCheck,
  };
}

// ---- ordinary-privilege posture ---------------------------------------------

export const LEDGER_PRIVILEGE_NAMES: readonly string[] = Object.freeze([
  'SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER',
]);
export const LEDGER_COLUMN_PRIVILEGE_NAMES: readonly string[] = Object.freeze([
  'SELECT', 'INSERT', 'UPDATE', 'REFERENCES',
]);

/**
 * AXIS A — who holds ordinary SQL privileges on the relation, right now, RLS aside.
 *
 * BYPASSRLS IS NOT A PRIVILEGE SOURCE. The attribute exempts a role from row-level security; it
 * grants no object privilege whatever. A BYPASSRLS role reaching the table still does so on an
 * ordinary GRANT, so excluding it from this axis would let a real, ACL-backed grant hide behind an
 * unrelated role attribute and produce a false OWNER_ONLY.
 */
export type StandardPrivilegePosture = 'OWNER_ONLY' | 'NON_OWNER_PRIVILEGE_PRESENT' | 'UNREADABLE';

/**
 * AXIS B — who would gain access that active RLS is currently the only thing withholding.
 *
 * This is the only axis from which a bypassing principal is excluded, and it is excluded because it
 * already reaches the rows: disabling RLS changes nothing for it.
 */
export type IncrementalRlsExposure = 'NONE_DETECTED' | 'PRESENT' | 'UNREADABLE';

export interface PrivilegePosture {
  readonly readable: boolean;
  /** PUBLIC's privileges, TABLE ∪ COLUMN, in canonical order. */
  readonly publicPrivileges: readonly string[];
  readonly anyNonOwnerOrdinaryPrivilege: boolean;
  /** Axis A per-privilege count of non-owner, non-superuser roles. BYPASSRLS roles are INCLUDED. */
  readonly nonOwnerCounts: readonly number[];
  readonly columnOnlyContributes: readonly string[];
  readonly roleSetOverflowed: boolean;
  /** Of the Axis-A roles holding any privilege, how many can presently CONNECT and USE the schema. */
  readonly presentlyReachable: number;
  readonly standardPrivilegePosture: StandardPrivilegePosture;
  /** Axis B role count: subject-to-RLS roles holding an effective ordinary privilege. */
  readonly newlyExposedRoles: number;
  readonly newlyExposedReachable: number;
  readonly publicGrantContributesExposure: boolean;
  readonly incrementalExposure: IncrementalRlsExposure;
}

export const UNREADABLE_PRIVILEGE_POSTURE: PrivilegePosture = Object.freeze({
  readable: false, publicPrivileges: Object.freeze([]), anyNonOwnerOrdinaryPrivilege: false,
  nonOwnerCounts: Object.freeze([]), columnOnlyContributes: Object.freeze([]),
  roleSetOverflowed: true, presentlyReachable: 0, standardPrivilegePosture: 'UNREADABLE',
  newlyExposedRoles: 0, newlyExposedReachable: 0, publicGrantContributesExposure: false,
  incrementalExposure: 'UNREADABLE',
});

/**
 * TWO SEPARATE QUESTIONS, ANSWERED SEPARATELY. One label cannot carry both, and the earlier single
 * label did: it excluded BYPASSRLS roles — correct for "who is newly exposed", wrong for "who holds
 * a privilege" — and so could report OWNER_ONLY over a live GRANT.
 *
 * OWNER_ONLY IS THE STRONGEST CLAIM HERE and is issued only when every condition it names was
 * proved: PUBLIC holds nothing at TABLE level and nothing at COLUMN level, and every role that is
 * neither the owner nor a superuser holds no table privilege AND no column privilege on any
 * non-dropped column. One unreadable field anywhere, or a truncated role set, makes it UNREADABLE.
 *
 * SUPERUSERS ARE EXCLUDED FROM BOTH AXES, and for a reason that does not extend to BYPASSRLS: a
 * superuser's access to every object is implicit in the role attribute and bypasses ACL checks
 * altogether, so its presence is not evidence of any grant and its absence would not be evidence of
 * none. BYPASSRLS carries no such implicit access.
 *
 * IT IS A STATEMENT ABOUT NOW. A future GRANT would change it, and no label here survives one.
 */
export function classifyPrivilegePosture(
  read: {
    publicTablePrivileges: readonly (boolean | null)[];
    publicColumnPrivileges: readonly (boolean | null)[];
    roles: readonly {
      isSuperuser: boolean | null; hasBypassRls: boolean | null; ownsLedger: boolean | null;
      canConnectDatabase: boolean | null; canUseSchema: boolean | null;
      tablePrivileges: readonly (boolean | null)[]; columnPrivileges: readonly (boolean | null)[];
    }[];
    overflowed: boolean;
  } | null,
  mode: LedgerRlsModeEvidence | null,
): PrivilegePosture {
  if (read === null || read.overflowed) return UNREADABLE_PRIVILEGE_POSTURE;
  if (read.publicTablePrivileges.length !== LEDGER_PRIVILEGE_NAMES.length) return UNREADABLE_PRIVILEGE_POSTURE;
  if (read.publicColumnPrivileges.length !== LEDGER_COLUMN_PRIVILEGE_NAMES.length) return UNREADABLE_PRIVILEGE_POSTURE;
  if (read.publicTablePrivileges.some((v) => v === null)) return UNREADABLE_PRIVILEGE_POSTURE;
  if (read.publicColumnPrivileges.some((v) => v === null)) return UNREADABLE_PRIVILEGE_POSTURE;

  const columnContributes = new Set<string>();
  const publicPrivileges: string[] = [];
  // PUBLIC IS TABLE **OR** COLUMN. Column ACLs live in pg_attribute, not pg_class, so a grant that
  // exists only there is invisible to a relation-ACL read and is exactly what this union restores.
  LEDGER_PRIVILEGE_NAMES.forEach((name, i) => {
    const atTable = read.publicTablePrivileges[i] === true;
    const ci = LEDGER_COLUMN_PRIVILEGE_NAMES.indexOf(name);
    const atColumn = ci >= 0 && read.publicColumnPrivileges[ci] === true;
    if (atColumn && !atTable) columnContributes.add(name);
    if (atTable || atColumn) publicPrivileges.push(name);
  });

  const nonOwnerCounts = LEDGER_PRIVILEGE_NAMES.map(() => 0);
  let anyNonOwnerOrdinaryPrivilege = publicPrivileges.length > 0;
  let presentlyReachable = 0;
  let newlyExposedRoles = 0;
  let newlyExposedReachable = 0;

  // AXIS B NEEDS FORCE RLS. Whether the owner is exempt depends on it, so without it this axis is
  // undecidable — and undecidable is reported, not assumed away in the favourable direction.
  const forceRls = mode === null ? null : mode.forceRls;

  for (const r of read.roles) {
    if (r.isSuperuser === null || r.hasBypassRls === null || r.ownsLedger === null
        || r.canConnectDatabase === null || r.canUseSchema === null) return UNREADABLE_PRIVILEGE_POSTURE;
    if (r.tablePrivileges.length !== LEDGER_PRIVILEGE_NAMES.length) return UNREADABLE_PRIVILEGE_POSTURE;
    if (r.columnPrivileges.length !== LEDGER_COLUMN_PRIVILEGE_NAMES.length) return UNREADABLE_PRIVILEGE_POSTURE;
    if (r.tablePrivileges.some((v) => v === null)) return UNREADABLE_PRIVILEGE_POSTURE;
    if (r.columnPrivileges.some((v) => v === null)) return UNREADABLE_PRIVILEGE_POSTURE;

    const holdsTable = LEDGER_PRIVILEGE_NAMES.map((_, i) => r.tablePrivileges[i] === true);
    const holdsColumn = LEDGER_COLUMN_PRIVILEGE_NAMES.map((_, i) => r.columnPrivileges[i] === true);
    const holdsAny = holdsTable.some(Boolean) || holdsColumn.some(Boolean);
    // REACHABILITY IS A SEPARATE FACT from privilege. A grant held by a role that cannot connect or
    // use the schema is real but not presently exercisable, and the two must not be merged.
    const reachable = r.canConnectDatabase === true && r.canUseSchema === true;

    // ---- Axis A: everyone but the owner and superusers. BYPASSRLS roles are counted here.
    if (r.isSuperuser === false && r.ownsLedger === false) {
      holdsTable.forEach((v, i) => { if (v) nonOwnerCounts[i] += 1; });
      holdsColumn.forEach((v, i) => {
        if (!v) return;
        // COLUMN-LEVEL ONLY when the same privilege is absent at table level, which is the case a
        // table-only scan reports as "no access" while a SELECT on one column still succeeds.
        const name = LEDGER_COLUMN_PRIVILEGE_NAMES[i] as string;
        const ti = LEDGER_PRIVILEGE_NAMES.indexOf(name);
        if (ti >= 0 && !holdsTable[ti]) columnContributes.add(name);
      });
      if (holdsAny) {
        anyNonOwnerOrdinaryPrivilege = true;
        if (reachable) presentlyReachable += 1;
      }
    }

    // ---- Axis B: exclude only principals that already bypass ACTIVE row-level security.
    const bypassesActiveRls = r.isSuperuser === true || r.hasBypassRls === true
      || (r.ownsLedger === true && forceRls === false);
    if (!bypassesActiveRls && holdsAny) {
      newlyExposedRoles += 1;
      if (reachable) newlyExposedReachable += 1;
    }
  }

  // A PUBLIC GRANT IS HELD BY EVERY ROLE IN THE CLUSTER, subject-to-RLS ones included, so it is
  // exposure that active RLS is presently the only thing gating.
  const publicGrantContributesExposure = publicPrivileges.length > 0;
  const anyIncremental = publicGrantContributesExposure || newlyExposedRoles > 0;
  return {
    readable: true,
    publicPrivileges,
    anyNonOwnerOrdinaryPrivilege,
    nonOwnerCounts,
    columnOnlyContributes: LEDGER_COLUMN_PRIVILEGE_NAMES.filter((c) => columnContributes.has(c)),
    roleSetOverflowed: false,
    presentlyReachable,
    standardPrivilegePosture:
      anyNonOwnerOrdinaryPrivilege ? 'NON_OWNER_PRIVILEGE_PRESENT' : 'OWNER_ONLY',
    newlyExposedRoles,
    newlyExposedReachable,
    publicGrantContributesExposure,
    incrementalExposure:
      forceRls === null ? 'UNREADABLE' : (anyIncremental ? 'PRESENT' : 'NONE_DETECTED'),
  };
}

/**
 * THE ONE CANONICAL DISABLE-RLS EXPOSURE ANSWER. Every token and every count printed for Axis B is
 * derived from this, and nothing else may compute a second one.
 *
 * WHY IT EXISTS. The exposure verdict was rendered twice: once by interpolating the computed
 * `incrementalExposure`, and once by a HARD-CODED `NONE_DETECTED` string literal in the adjacent
 * scope line. The literal could not disagree with the evidence because it never consulted it, so a
 * run that had proved `PRESENT` over four newly exposed roles printed `PRESENT` on one line and
 * `NONE_DETECTED` on the next. An operator reading either line alone read a different posture, and
 * the favourable one was the one that was never computed.
 *
 * NONE_DETECTED IS THE STRONGEST CLAIM ON THIS AXIS and is now issued only when complete bounded
 * evidence proves zero newly exposed roles: the read was readable, the role set was not truncated,
 * the count is exactly zero, and no PUBLIC grant contributes. Anything less is not NONE_DETECTED.
 *
 * DISAGREEMENT FAILS CLOSED, NEVER FAVOURABLY. If the token, the counts and the reachability
 * subcount do not corroborate one another — a PRESENT with nothing exposed, a NONE_DETECTED over a
 * positive count or a contributing PUBLIC grant, more reachable roles than exposed roles, or a
 * count that is not a non-negative integer — the RESULT IS WITHDRAWN as UNREADABLE. The individual
 * counts remain printed as read; it is only the conclusion drawn from them that is withdrawn.
 */
export function reconcileDisableRlsExposure(p: PrivilegePosture): IncrementalRlsExposure {
  const { newlyExposedRoles: n, newlyExposedReachable: k, publicGrantContributesExposure: pub } = p;
  // Bounded integers first: a non-integer, negative or non-finite count is not evidence of anything.
  if (!Number.isSafeInteger(n) || !Number.isSafeInteger(k) || n < 0 || k < 0) return 'UNREADABLE';
  // Reachability is a SUBSET of exposure, so it can never exceed it. If it does, the two were not
  // produced by the same pass over the same role set and neither corroborates the other.
  if (k > n) return 'UNREADABLE';
  // An unreadable or truncated read cannot support any conclusion, favourable or otherwise.
  if (!p.readable || p.roleSetOverflowed) return 'UNREADABLE';
  // C2B-M005-LRLS-L3-R3 — a fourth guard stood here reading
  // `if (p.incrementalExposure === 'UNREADABLE') return 'UNREADABLE';`
  // and it was DEAD, not defensive: an UNREADABLE token satisfies neither branch below and reaches
  // the tail return, which hands back that same token. Mutating it could not change any result, so
  // it was a line no test could ever hold to account. It is removed rather than left as permanently
  // unkillable code, and the behaviour it described — UNREADABLE in, UNREADABLE out — is now
  // asserted by a test instead, where a future edit to the tail return would actually be caught.
  const evidenceShowsExposure = n > 0 || pub;
  // The token must agree with the evidence IN BOTH DIRECTIONS. Checking only one direction would
  // leave the other free to drift, and it was drift that produced the contradiction.
  if (p.incrementalExposure === 'PRESENT' && !evidenceShowsExposure) return 'UNREADABLE';
  if (p.incrementalExposure === 'NONE_DETECTED' && evidenceShowsExposure) return 'UNREADABLE';
  return p.incrementalExposure;
}

// ---- event-trigger relevance ------------------------------------------------

export type RepairEventTriggerEffect = 'NONE_CATALOG_RELEVANT' | 'UNRESOLVED';

/**
 * Events that a plain `ALTER TABLE` can fire. `sql_drop` fires for commands that DROP an object,
 * which the contemplated RLS-mode change is not — but an unrecognized event string is treated as
 * relevant, because an event this code cannot name is not an event it can rule out.
 */
const ALTER_TABLE_EVENTS: readonly string[] = Object.freeze(['ddl_command_start', 'ddl_command_end', 'table_rewrite']);
const KNOWN_EVENTS: readonly string[] = Object.freeze([...ALTER_TABLE_EVENTS, 'sql_drop']);

/**
 * TWO POPULATIONS, NAMED SEPARATELY, BECAUSE THEY ARE NOT THE SAME SET.
 *
 * `wildcardTagged` and `explicitAlterTableTagged` count over EVERY enabled trigger. `potentiallyRelevant`
 * counts only triggers whose EVENT could fire for the contemplated command. The two were printed
 * side by side under bare names, so a run reporting `potentiallyRelevant=1 wildcardTagged=2` looked
 * self-contradictory: the reader had no way to know the second number was drawn from a wider set,
 * and could not tell whether one wildcard trigger had been silently dropped or was simply
 * event-irrelevant. Both numbers were correct; the OUTPUT was ambiguous.
 *
 * The relevance-scoped pair below is a DISJOINT PARTITION of the relevant population, so it
 * reconciles by construction: `relevantWildcardTagged + relevantAlterTableOnlyTagged` is exactly
 * `potentiallyRelevant`. A trigger carrying both a wildcard and an explicit ALTER TABLE tag is
 * counted once, in the wildcard bucket — hence "AlterTableOnly" in the second name, which says
 * which set it is rather than leaving the overlap to the reader.
 */
export interface EventTriggerPosture {
  readonly readable: boolean;
  readonly enabledTotal: number;
  readonly potentiallyRelevant: number;
  /** Population: ALL ENABLED triggers, irrespective of whether their event could fire. */
  readonly wildcardTagged: number;
  /** Population: ALL ENABLED triggers, irrespective of whether their event could fire. */
  readonly explicitAlterTableTagged: number;
  /** Population: RELEVANT triggers only. Disjoint from `relevantAlterTableOnlyTagged`. */
  readonly relevantWildcardTagged: number;
  /** Population: RELEVANT triggers with an explicit ALTER TABLE tag and NO wildcard tag. */
  readonly relevantAlterTableOnlyTagged: number;
  readonly extensionOwned: number;
  readonly ownershipNotEstablished: number;
  readonly effect: RepairEventTriggerEffect;
}

export const UNREADABLE_EVENT_TRIGGER_POSTURE: EventTriggerPosture = Object.freeze({
  readable: false, enabledTotal: 0, potentiallyRelevant: 0, wildcardTagged: 0,
  explicitAlterTableTagged: 0, relevantWildcardTagged: 0, relevantAlterTableOnlyTagged: 0,
  extensionOwned: 0, ownershipNotEstablished: 0, effect: 'UNRESOLVED',
});

/**
 * NONE_CATALOG_RELEVANT is issued ONLY when the bounded catalog evidence proves no enabled trigger
 * could match. It is a claim about tag and event filters, never about what a trigger function does:
 * no function is read or executed here, so a trigger that COULD match is always UNRESOLVED.
 */
export function classifyEventTriggers(read: {
  rows: readonly {
    event: string | null; enableMode: string | null; wildcardTags: boolean | null;
    altersTableTag: boolean | null; extensionOwned: boolean | null;
  }[];
  overflowed: boolean;
} | null): EventTriggerPosture {
  if (read === null || read.overflowed) return UNREADABLE_EVENT_TRIGGER_POSTURE;
  let potentiallyRelevant = 0; let wildcardTagged = 0; let explicitAlterTableTagged = 0;
  let relevantWildcardTagged = 0; let relevantAlterTableOnlyTagged = 0;
  let extensionOwned = 0; let ownershipNotEstablished = 0;
  for (const t of read.rows) {
    if (t.event === null || t.enableMode === null || t.wildcardTags === null
        || t.altersTableTag === null) return UNREADABLE_EVENT_TRIGGER_POSTURE;
    // ALL-ENABLED population. Counted for every enabled trigger, event relevance not consulted.
    if (t.wildcardTags) wildcardTagged += 1;
    if (t.altersTableTag) explicitAlterTableTagged += 1;
    // EXTENSION OWNERSHIP IS NOT A SAFETY PROPERTY, only a provenance one, and an unreadable
    // dependency answer is counted as NOT ESTABLISHED rather than as "not extension-owned".
    if (t.extensionOwned === true) extensionOwned += 1; else ownershipNotEstablished += 1;
    // An unknown event string is RELEVANT: this code cannot rule out an event it cannot name.
    const eventCouldFire = !KNOWN_EVENTS.includes(t.event) || ALTER_TABLE_EVENTS.includes(t.event);
    // Enable mode is reported but not used to exclude: 'R' fires only in a replica session, and
    // this run did not observe the session replication role, so excluding it would overclaim.
    if (eventCouldFire && (t.wildcardTags || t.altersTableTag)) {
      potentiallyRelevant += 1;
      // RELEVANT population, partitioned so the two buckets sum to `potentiallyRelevant` exactly.
      // Wildcard wins the overlap; the other bucket is therefore ALTER-TABLE-tagged AND NOT wildcard.
      if (t.wildcardTags) relevantWildcardTagged += 1; else relevantAlterTableOnlyTagged += 1;
    }
  }
  // THE PARTITION IS PROVED, NOT ASSUMED. If the relevant buckets do not sum to the relevant total,
  // or any count escapes the enabled population, the counters did not come from one consistent pass
  // and no verdict drawn from them can be trusted — including the favourable NONE_CATALOG_RELEVANT.
  const enabledTotal = read.rows.length;
  const partitionReconciles = relevantWildcardTagged + relevantAlterTableOnlyTagged === potentiallyRelevant;
  const bounded = potentiallyRelevant <= enabledTotal && wildcardTagged <= enabledTotal
    && explicitAlterTableTagged <= enabledTotal && relevantWildcardTagged <= wildcardTagged
    && relevantAlterTableOnlyTagged <= explicitAlterTableTagged
    && extensionOwned + ownershipNotEstablished === enabledTotal;
  if (!partitionReconciles || !bounded) return UNREADABLE_EVENT_TRIGGER_POSTURE;
  return {
    readable: true, enabledTotal, potentiallyRelevant, wildcardTagged,
    explicitAlterTableTagged, relevantWildcardTagged, relevantAlterTableOnlyTagged,
    extensionOwned, ownershipNotEstablished,
    // UNRESOLVED WHENEVER ANY RELEVANT TRIGGER EXISTS. NONE_CATALOG_RELEVANT is reachable only from
    // a readable, reconciled read in which the relevant population is empty; every unreadable or
    // non-reconciling path returns UNREADABLE_EVENT_TRIGGER_POSTURE, whose effect is UNRESOLVED.
    effect: potentiallyRelevant === 0 ? 'NONE_CATALOG_RELEVANT' : 'UNRESOLVED',
  };
}

// ---- bounded rendering ------------------------------------------------------

/**
 * Every token below is a fixed source constant or a bounded integer. No role, policy, expression,
 * trigger, function, extension or relation identifier is in scope here to be printed.
 */
export function renderLedgerRepairSafety(
  mode: LedgerRlsModeEvidence | null,
  applicability: RlsApplicability,
  policies: PolicyInventory,
  privileges: PrivilegePosture,
  triggers: EventTriggerPosture,
): string[] {
  const list = (xs: readonly string[]): string => (xs.length === 0 ? 'NONE' : xs.join(','));
  const counts = (names: readonly string[], xs: readonly number[]): string =>
    (xs.length === names.length ? names.map((n, i) => `${n}=${String(xs[i])}`).join(',') : 'UNREADABLE');
  // ONE CANONICAL EXPOSURE ANSWER, COMPUTED ONCE. Both Axis-B lines interpolate this binding, so
  // there is no second expression that could render a different token from the same evidence.
  const exposure = reconcileDisableRlsExposure(privileges);
  return [
    `[m005-preflight] ledgerRls enabled=${b3(mode?.rlsEnabled)} force=${b3(mode?.forceRls)}`
      + ` applicability=${applicability} activeForCurrent=${b3(mode?.rowSecurityActiveForCurrent)}`,
    `[m005-preflight] ledgerRlsAuthority currentIsSessionPrincipal=${b3(mode?.currentIsSessionPrincipal)}`
      + ` ownsLedger=${b3(mode?.currentOwnsLedger)} ownerIsDatabaseOwner=${b3(mode?.ledgerOwnerIsDatabaseOwner)}`
      + ` superuser=${b3(mode?.currentIsSuperuser)} bypassRls=${b3(mode?.currentHasBypassRls)}`,
    `[m005-preflight] ledgerPolicies readable=${String(policies.readable)} total=${String(policies.total)}`
      + ` permissive=${String(policies.permissive)} restrictive=${String(policies.restrictive)}`
      + ` commands=${list(policies.commandClasses)}`,
    `[m005-preflight] ledgerPolicyTargets public=${String(policies.anyTargetsPublic)}`
      + ` appliesToCurrent=${String(policies.anyAppliesToCurrent)} onlyOtherRoles=${String(policies.anyTargetsOnlyOtherRoles)}`
      + ` withUsing=${String(policies.withUsing)} withCheck=${String(policies.withCheck)}`,
    // AXIS A. `public` is the TABLE ∪ COLUMN union, so a grant held only on a single column of the
    // ledger appears here and denies OWNER_ONLY exactly as a table-wide grant would.
    `[m005-preflight] ledgerStandardPrivileges standardPrivilegePosture=${privileges.standardPrivilegePosture}`
      + ` public=${list(privileges.publicPrivileges)} anyNonOwner=${String(privileges.anyNonOwnerOrdinaryPrivilege)}`
      + ` roleSetOverflowed=${String(privileges.roleSetOverflowed)}`,
    `[m005-preflight] ledgerNonOwnerPrivilegeCounts ${counts(LEDGER_PRIVILEGE_NAMES, privileges.nonOwnerCounts)}`
      + ` bypassRlsRolesIncluded=true superusersExcluded=true`,
    `[m005-preflight] ledgerColumnPrivilegeContribution ${list(privileges.columnOnlyContributes)}`
      + ` presentlyReachableRoles=${String(privileges.presentlyReachable)}`
      + ` reachabilityIncludesDatabaseConnectAndSchemaUsage=true`,
    // AXIS B, kept apart from Axis A on purpose: it answers what disabling RLS would ADD, which is
    // a different question from who holds a privilege today.
    // AXIS B, kept apart from Axis A on purpose, and rendered from ONE reconciled result so the
    // token below and the token on the scope line cannot disagree — they are the same value.
    `[m005-preflight] ledgerDisableRlsExposure incrementalExposure=${exposure}`
      + ` newlyExposedRoles=${String(privileges.newlyExposedRoles)}`
      + ` newlyExposedReachable=${String(privileges.newlyExposedReachable)}`
      + ` publicGrantContributes=${String(privileges.publicGrantContributesExposure)}`,
    `[m005-preflight] ledgerDisableRlsExposureScope=${exposure} describes what was observed now and proves nothing about a later grant`,
    // POPULATION NAMED ON THE LINE. These counters range over every enabled trigger, which is a
    // wider set than the relevant one on the next line; without the label the two read as a
    // contradiction rather than as two answers to two questions.
    `[m005-preflight] ledgerEventTriggerMetadata readable=${String(triggers.readable)}`
      + ` enabled=${String(triggers.enabledTotal)} population=ALL_ENABLED`
      + ` wildcardTagged=${String(triggers.wildcardTagged)} alterTableTagged=${String(triggers.explicitAlterTableTagged)}`
      + ` extensionOwned=${String(triggers.extensionOwned)} ownershipNotEstablished=${String(triggers.ownershipNotEstablished)}`,
    // RELEVANT population, as a disjoint partition that sums to `potentiallyRelevant` by construction.
    `[m005-preflight] ledgerEventTriggerRelevance population=EVENT_COULD_FIRE`
      + ` potentiallyRelevant=${String(triggers.potentiallyRelevant)}`
      + ` relevantWildcardTagged=${String(triggers.relevantWildcardTagged)}`
      + ` relevantAlterTableOnlyTagged=${String(triggers.relevantAlterTableOnlyTagged)}`
      + ` partitionReconciles=${String(triggers.relevantWildcardTagged + triggers.relevantAlterTableOnlyTagged === triggers.potentiallyRelevant)}`,
    `[m005-preflight] repairEventTriggerEffect=${triggers.effect}`,
    // SAID EVERY TIME. This block describes a posture; it is not a recommendation, and no command
    // in this boundary can act on it.
    `[m005-preflight] ledgerRlsRepair=UNAUTHORIZED; this preflight observes posture only and implements no repair`,
    `[m005-preflight] ledgerRlsEnablementProvenance=UNKNOWN; no repository source enables or forces RLS on the ledger relation and this run attributes the live state to no actor`,
  ];
}

/** Independently pinned: the widest line this contract can emit, asserted against a literal. */
export const LEDGER_REPAIR_SAFETY_MAX_LINE_BYTES = 198;

/**
 * THE FACTS A READ-ONLY SNAPSHOT STRUCTURALLY CANNOT CLOSE, said on every terminal path.
 *
 * These were emitted only where a disposition was COMPUTED, so every early refusal — a rejected
 * argument, an unconfirmed target, a lost read-only bracket, a port failure — produced a record
 * that omitted them, and the omission read as "these questions do not arise on this run". They
 * arise on every run: none of them is a measurement this process performs, so no outcome can
 * settle any of them, and a refusal is exactly when an operator is most likely to go looking.
 *
 * ONE CANONICAL KEY PER FACT. The apply-time lock and the event-trigger effect each had a second
 * spelling inside `renderEvidence`, so the computed path stated the same residual twice under two
 * names while the refusal paths stated it zero times. Each is now said once, here, on every path.
 *
 * NOTHING HERE IMPLIES CONTACT. Every line is a property of migration 005 and of this preflight's
 * own contract, so the pre-contact refusals may carry them without asserting the database answered.
 */
export function residualFacts(): readonly string[] {
  return [
    '[m005-preflight] preflightCompletion=DISTINCT_FROM_MIGRATION_AUTHORIZATION',
    '[m005-preflight] eventTriggerEffectOnM005=OPEN',
    '[m005-preflight] applySessionSearchPathContinuity=UNPROVEN',
    '[m005-preflight] providerManagedCompatibility=OPEN_MEDIUM',
    '[m005-preflight] lockAvailability=UNOBSERVED; the constraint addition takes ACCESS EXCLUSIVE on its table at apply time residual=OPEN',
    '[m005-preflight] migration005=UNAUTHORIZED; a separate authorization is required to execute it',
    '[m005-preflight] snapshotScope=ONE_INSTANT_ONLY; the apply path must revalidate under its own advisory lock and pre-commit gate',
  ];
}

export function renderEvidence(
  r: ObservedPreconditionEvidence,
  p: ProviderEvidence,
  l: LedgerEvidence,
  a: { globalBase: Readonly<Record<string, string>>; postcondition: string; blockerSurvivesCurrentM005: string; findingCount: number },
  aclOverflowed: boolean,
  residue: Residue,
): string[] {
  const n = (v: number | null): string => (v === null ? 'UNREADABLE' : String(v));
  const b = (v: boolean | null): string => (v === null ? 'UNREADABLE' : String(v));
  return [
    `[m005-preflight] database publicCreate=${b(r.publicCreateOnDatabase)} publicTemporary=${b(r.publicTemporaryOnDatabase)}`,
    `[m005-preflight] principal canCreateRole=${b(r.principalCanCreateRole)} schemaPublicPresent=${b(r.schemaPublicPresent)} schemaPublicAuthority=${b(r.schemaPublicAuthority)}`,
    `[m005-preflight] roles created=${n(r.createdRolesCount)}/${M005_CREATED_ROLES.length} commentResidue=${r.roleCommentResidue} prerequisites=${r.prerequisiteRoles}`,
    `[m005-preflight] createdRolePrivilege=PREDICTED_FROM_SOURCE_AND_PUBLIC_PATHS notLiveTested=true`,
    `[m005-preflight] objects tables=${n(r.governedTablesPresent)}/${M005_GOVERNED_TABLES.length} authoritative=${n(r.governedTablesAuthoritative)}/${M005_GOVERNED_TABLES.length} columns=${n(r.requiredColumnsPresent)}/${M005_REQUIRED_COLUMNS.length} sequences=${n(r.sequencesInPublic)}`,
    `[m005-preflight] rls enabledTables=${n(r.rlsEnabledTables)}/${M005_RLS_REQUIRED_TABLES.length} enabledByM005=false`,
    `[m005-preflight] policies governedPresent=${n(r.policiesPresent)}/${M005_POLICIES.length} foreignOnGovernedTables=${n(r.foreignPoliciesOnGovernedTables)} policyFunction=${b(r.policyFunctionPresent)}`,
    `[m005-preflight] resolution governedNamesShadowedOutsidePublic=${n(r.governedNamesShadowedOutsidePublic)} plpgsql=${b(r.plpgsqlPresent)}`,
    `[m005-preflight] eventTriggersEnabled=${n(r.enabledEventTriggers)}`,
    `[m005-preflight] constraint present=${r.constraintPresent} incompatibleRows=${n(r.incompatibleAuditRows)} compatible=${r.incompatibleAuditRows === null ? 'UNREADABLE' : String(r.incompatibleAuditRows === 0)}`,
    `[m005-preflight] ledgerShape=${l.shape} ledgerShapeCategories=${renderShapeCategories(l.shape, l.shapeCategories)} prefix001To004=${l.prefix} checksums001To004=${l.checksums}`,
    `[m005-preflight] dirtyMarker=${l.dirty} migration005=${l.m005} unknownOrOutOfOrder=${l.unknownOrOutOfOrder} overflowed=${String(l.overflowed)}`,
    // NAMED FOR THE LEDGER, NOT FOR A DECISION. As `planPrediction` this line read as a verdict on
    // whether to proceed — the one label in the record an operator skimming for a go/no-go could
    // mistake for one — and `informationalOnly=true` was the only thing arguing otherwise. It states
    // a property of the stored history: which plan THAT LEDGER implies. It is not a recommendation.
    `[m005-preflight] ledgerImpliedPlan=${predictPlan(l)} informationalOnly=true notARecommendation=true`,
    `[m005-preflight] acl overflowed=${String(aclOverflowed)} globalTables=${a.globalBase.tables ?? 'UNREADABLE'} globalSequences=${a.globalBase.sequences ?? 'UNREADABLE'} globalFunctions=${a.globalBase.functions ?? 'UNREADABLE'}`,
    `[m005-preflight] A.currentPosture=${a.postcondition} B.blockerSurvivesCurrentM005=${a.blockerSurvivesCurrentM005} findingCount=${String(a.findingCount)}`,
    `[m005-preflight] aclNote=A_MET_IS_NOT_REQUIRED_MIGRATION_005_CHANGES_THE_POSTURE; B=NO is not authorization to migrate`,
    `[m005-preflight] provider routinesOutsidePublic=${n(p.routinesOutsidePublic)} creatableNonPublicSchemas=${n(p.creatableNonPublicSchemas)}`,
    `[m005-preflight] typesAndSchemasClasses=OUTSIDE_THIS_CONTRACT residual=OPEN`,
    `[m005-preflight] residue=${residue}`,
  ];
}

export async function main(
  argv: readonly string[] = process.argv.slice(2),
  source: NodeJS.ProcessEnv = process.env,
  emit: Emit = (line) => console.log(line),
  // TEST SEAM ONLY, defaulted so production cannot populate it: the entry guard calls `main()` with
  // no arguments at all, so this is `{}` on every real run.
  deps: Parameters<typeof runPreflight>[2] = {},
): Promise<number> {
  // NO arguments. This child has exactly one behaviour, so any argument at all is a refusal rather
  // than something to ignore — an ignored argument is how a fixed command grows an option.
  if (argv.length !== 0) {
    emit(`[m005-preflight] REFUSED: ${PREFLIGHT_CODES.ARGV_REJECTED}`);
    // THE EARLIEST TERMINAL PATH, and the one furthest from contact: nothing has been read, no
    // configuration resolved and no socket opened. The residuals still hold, and stating them here
    // asserts nothing about a database this path never addressed.
    for (const line of residualFacts()) emit(line);
    return 2;
  }
  return await runPreflight(source, emit, deps);
}

// Entry guard: EXACT PATH IDENTITY, not a suffix test — a suffix test is satisfied by any entry
// script whose name merely ends in this one, which would import this module for its exports and
// open a real connection as a side effect. Importing this module must do nothing.
if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  void main().then(
    (c) => { process.exitCode = c; },
    () => { process.exitCode = 2; },
  );
}
