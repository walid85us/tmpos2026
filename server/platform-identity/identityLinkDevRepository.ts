// Phase 1.6 M20.13 — Identity Link DEV REPOSITORY ADAPTER (server-only, DEV-only, default-OFF).
//
// WHAT THIS IS: a dependency-injected adapter that implements the M20.11
// `IdentityLinkRepository` contract against the DEV `identity_link` table (M20.4 schema) and the
// existing `platform_identity` table (READ-ONLY). It realizes the M20.12 plan's repository-method
// mapping: read-only existence/eligibility checks against `platform_identity`, read-only active /
// historical `identity_link` lookups, a single append of one active `identity_link` row, and a
// lifecycle status update (disable/revoke, never delete).
//
// WHAT THIS IS NOT (binding for M20.13):
//   - It is server-only and is imported by NOTHING active: no route, no `sessionResolve`, no
//     AccessContext/Login/AccessGuard/App/main/pilot, no startup, no seed, no migration runner. It
//     has no public endpoint and no UI. It changes no existing authorization behavior.
//   - It opens NO database connection and contains NO global singleton DB client. The Postgres
//     executor is INJECTED (the future owner-gated caller would supply the existing server-side
//     owner-role direct-Postgres helper; unit tests supply an in-memory fake). It never uses the
//     anon/client path. `import type { SqlExecutor }` is erased at compile time → NO runtime import
//     of the repository/db modules and NO connection.
//   - By itself it inserts NO `identity_link` row and writes NO `audit_event` row at import time; a
//     mutation happens only if a future caller injects a real executor and invokes a write method.
//
// SECURITY (binding): it NEVER returns, logs, or throws a raw provider reference, raw internal
// anchor reference, email, token, secret, raw DB error text, host name, or constraint detail. All
// failures map to a SAFE code via `classifyDbError` and surface as a `SafeRepositoryError` whose
// message contains ONLY the safe code. Fail-closed: it refuses to operate in production.

import type { SqlExecutor } from './authorizationRepository';
import type {
  IdentityLinkRepository,
  ExistingActiveLink,
  ExistingHistoricalLink,
  IdentityLinkVerificationMethod,
  IdentityLinkLifecycleRequest,
} from './identityLinkAdminProvisioning';

// =============================================================================
// Safe result / error vocabulary (NEVER carries an identifier, email, or raw DB text)
// =============================================================================

export type IdentityLinkRepositorySafeCode =
  | 'ok'
  | 'not_found'
  | 'already_linked'
  | 'exact_pair_exists'
  | 'firebase_side_conflict'
  | 'supabase_side_conflict'
  | 'invalid_anchor'
  | 'missing_platform_identity'
  | 'constraint_conflict'
  | 'write_failed'
  | 'disabled'
  | 'revoked'
  | 'production_blocked'
  | 'unexpected_error';

/**
 * A redaction-safe repository error. Its message is ONLY the safe code — never a raw DB error,
 * host name, constraint text, provider reference, or identifier.
 */
export class SafeRepositoryError extends Error {
  readonly code: IdentityLinkRepositorySafeCode;
  constructor(code: IdentityLinkRepositorySafeCode) {
    super(`identity_link_repository: ${code}`);
    this.name = 'SafeRepositoryError';
    this.code = code;
  }
}

/**
 * Map a low-level DB error to a SAFE code using ONLY its SQLSTATE `code` property (a short, public
 * class string such as '23505'). It NEVER reads the error message/detail/hint (which can contain
 * identifiers, values, or host info). Unknown → 'unexpected_error'.
 */
export function classifyDbError(err: unknown): IdentityLinkRepositorySafeCode {
  const sqlState =
    err && typeof err === 'object' && 'code' in err ? String((err as { code?: unknown }).code) : '';
  switch (sqlState) {
    case '23505': // unique_violation (active partial-unique index race)
      return 'constraint_conflict';
    case '23503': // foreign_key_violation (anchor / provider reference not a real platform_identity)
      return 'missing_platform_identity';
    case '23514': // check_violation (status/verification_method/provider check)
      return 'constraint_conflict';
    case '23502': // not_null_violation
      return 'write_failed';
    default:
      return 'unexpected_error';
  }
}

/** True only when the process is production. Used for the fail-closed DEV-only guard. */
export function isProductionEnvironment(): boolean {
  return process.env.NODE_ENV === 'production';
}

/**
 * Defensive extraction of an active link from a query result. Empty result → null (legitimately no
 * link). A non-array result, or a present-but-malformed row (missing/empty link_id), → fail-closed
 * SafeRepositoryError('unexpected_error'). Never returns a link with an empty/undefined ref. The
 * real array-returning client passes through unchanged (length is a number, link_id is present).
 */
function firstActiveLink(rows: any): ExistingActiveLink | null {
  if (!rows || typeof rows.length !== 'number') throw new SafeRepositoryError('unexpected_error');
  if (rows.length === 0) return null;
  const ref = rows[0] ? rows[0].link_id : undefined;
  if (ref == null || ref === '') throw new SafeRepositoryError('unexpected_error');
  return { linkRef: ref };
}

export interface IdentityLinkDevRepositoryDeps {
  /** Injected server-side owner-role Postgres executor (or a tx handle). NEVER the anon path. */
  sql: SqlExecutor;
}

// =============================================================================
// Adapter
// =============================================================================

/**
 * Create the DEV-only repository adapter. Fail-closed: throws SafeRepositoryError('production_blocked')
 * if invoked in production. The executor is injected — no global client, no auto-connect.
 */
export function createIdentityLinkDevRepository(
  deps: IdentityLinkDevRepositoryDeps,
): IdentityLinkRepository {
  if (isProductionEnvironment()) {
    // Belt-and-suspenders: this DEV-only adapter must never run against production.
    throw new SafeRepositoryError('production_blocked');
  }
  const sql = deps.sql;

  // Wrap every DB call so a raw error can NEVER escape; only a safe code is surfaced.
  async function safe<T>(op: () => Promise<T>): Promise<T> {
    try {
      return await op();
    } catch (err) {
      if (err instanceof SafeRepositoryError) throw err;
      throw new SafeRepositoryError(classifyDbError(err));
    }
  }

  async function getAnchorEligibility(anchorRef: string): Promise<{ found: boolean; eligible: boolean }> {
    return safe(async () => {
      const rows: any = await sql`
        select 1 as ok from platform_identity
        where internal_user_id = ${anchorRef}
        limit 1 /* il_op=anchor_eligibility */
      `;
      const found = rows.length > 0;
      return { found, eligible: found };
    });
  }

  async function providerReferenceExists(
    provider: 'firebase' | 'supabase',
    reference: string,
  ): Promise<boolean> {
    return safe(async () => {
      const rows: any = await sql`
        select 1 as ok from platform_identity
        where auth_provider = ${provider} and auth_provider_uid = ${reference}
        limit 1 /* il_op=provider_exists */
      `;
      return rows.length > 0;
    });
  }

  async function findActiveLinkByPair(
    firebaseReference: string,
    supabaseReference: string,
  ): Promise<ExistingActiveLink | null> {
    return safe(async () => {
      const rows: any = await sql`
        select link_id from identity_link
        where firebase_auth_provider_uid = ${firebaseReference}
          and supabase_auth_provider_uid = ${supabaseReference}
          and status = 'active'
        limit 1 /* il_op=find_active_pair */
      `;
      return firstActiveLink(rows);
    });
  }

  async function findActiveLinkByFirebaseRef(
    firebaseReference: string,
  ): Promise<ExistingActiveLink | null> {
    return safe(async () => {
      const rows: any = await sql`
        select link_id from identity_link
        where firebase_auth_provider_uid = ${firebaseReference} and status = 'active'
        limit 1 /* il_op=find_active_firebase */
      `;
      return firstActiveLink(rows);
    });
  }

  async function findActiveLinkBySupabaseRef(
    supabaseReference: string,
  ): Promise<ExistingActiveLink | null> {
    return safe(async () => {
      const rows: any = await sql`
        select link_id from identity_link
        where supabase_auth_provider_uid = ${supabaseReference} and status = 'active'
        limit 1 /* il_op=find_active_supabase */
      `;
      return firstActiveLink(rows);
    });
  }

  async function findHistoricalPair(
    firebaseReference: string,
    supabaseReference: string,
  ): Promise<ExistingHistoricalLink | null> {
    return safe(async () => {
      const rows: any = await sql`
        select link_id, status from identity_link
        where firebase_auth_provider_uid = ${firebaseReference}
          and supabase_auth_provider_uid = ${supabaseReference}
          and status in ('disabled', 'revoked')
        limit 1 /* il_op=find_historical_pair */
      `;
      if (!rows || typeof rows.length !== 'number') throw new SafeRepositoryError('unexpected_error');
      if (!rows.length) return null;
      const row = rows[0];
      if (!row || row.link_id == null || row.link_id === '') throw new SafeRepositoryError('unexpected_error');
      const state = row.status === 'revoked' ? 'revoked' : 'disabled';
      return { linkRef: row.link_id, lifecycleState: state };
    });
  }

  async function createActiveLink(input: {
    anchorRef: string;
    firebaseReference: string;
    supabaseReference: string;
    verificationMethod: IdentityLinkVerificationMethod;
    createdByRef: string;
    approvedByRef: string;
  }): Promise<{ lifecycleState: 'active' }> {
    return safe(async () => {
      const rows: any = await sql`
        insert into identity_link (
          internal_user_id,
          firebase_auth_provider, firebase_auth_provider_uid,
          supabase_auth_provider, supabase_auth_provider_uid,
          status, verification_method,
          created_by_internal_user_id, approved_by_internal_user_id
        ) values (
          ${input.anchorRef},
          'firebase', ${input.firebaseReference},
          'supabase', ${input.supabaseReference},
          'active', ${input.verificationMethod},
          ${input.createdByRef}, ${input.approvedByRef}
        )
        returning status /* il_op=create_active_link */
      `;
      if (!rows || typeof rows.length !== 'number' || !rows.length || (rows[0] ? rows[0].status : undefined) !== 'active') {
        throw new SafeRepositoryError('write_failed');
      }
      return { lifecycleState: 'active' };
    });
  }

  async function findActiveLinkForLifecycle(
    selector: NonNullable<IdentityLinkLifecycleRequest['selector']>,
  ): Promise<ExistingActiveLink | null> {
    return safe(async () => {
      if (selector.linkRef && selector.linkRef.trim().length > 0) {
        const rows: any = await sql`
          select link_id from identity_link
          where link_id = ${selector.linkRef} and status = 'active'
          limit 1 /* il_op=find_active_for_lifecycle_by_ref */
        `;
        return firstActiveLink(rows);
      }
      if (
        selector.firebaseReference && selector.firebaseReference.trim().length > 0 &&
        selector.supabaseReference && selector.supabaseReference.trim().length > 0
      ) {
        const rows: any = await sql`
          select link_id from identity_link
          where firebase_auth_provider_uid = ${selector.firebaseReference}
            and supabase_auth_provider_uid = ${selector.supabaseReference}
            and status = 'active'
          limit 1 /* il_op=find_active_for_lifecycle_by_pair */
        `;
        return firstActiveLink(rows);
      }
      return null;
    });
  }

  async function setLifecycleState(
    linkRef: string,
    state: 'disabled' | 'revoked',
  ): Promise<{ lifecycleState: 'disabled' | 'revoked' }> {
    return safe(async () => {
      const rows: any = await sql`
        update identity_link
        set status = ${state},
            disabled_at = case when ${state} = 'disabled' then now() else disabled_at end,
            revoked_at  = case when ${state} = 'revoked'  then now() else revoked_at  end
        where link_id = ${linkRef} and status = 'active'
        returning status /* il_op=set_lifecycle_state */
      `;
      if (!rows || typeof rows.length !== 'number') throw new SafeRepositoryError('unexpected_error');
      if (!rows.length) throw new SafeRepositoryError('not_found');
      return { lifecycleState: state };
    });
  }

  return {
    getAnchorEligibility,
    providerReferenceExists,
    findActiveLinkByPair,
    findActiveLinkByFirebaseRef,
    findActiveLinkBySupabaseRef,
    findHistoricalPair,
    createActiveLink,
    findActiveLinkForLifecycle,
    setLifecycleState,
  };
}
