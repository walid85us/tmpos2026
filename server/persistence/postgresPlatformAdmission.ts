// Phase 4.0 M5 — the PostgreSQL platform admission: the production adapter behind the administrative session
// boundary's admission, over migration 013's one bounded read (M5-GIAM-D1-P4; G-IAM, G-CPLOGIN).
//
// WHAT IT ANSWERS. For a provider reference the authentication boundary has already verified, it asks the
// database who that names, which PLATFORM grants they currently hold, and the actor's platform authority
// version — one read, one snapshot (migration 013 section 5). Nothing authoritative comes from the request: not
// the actor, not the grant, not the role, not the version. The request supplies a cookie; the database supplies
// the rest.
//
// IT DECIDES NOTHING. It validates the answer as untrusted and reports it: `resolved` with the principal (its
// memberships the platform grants alone) and the version, `refused`, or `unavailable`. Whether that standing
// admits an administrative session — exactly one platform grant, an account that is neither denied nor
// limited, a role the canonical catalog defines — and the witness a session is bound to are decided in trusted
// source (server/composition/platformAuthorization.ts), so this file holds no policy that could drift from it.
//
// IT CONSTRUCTS NOTHING AND READS NOTHING. The caller hands it the transaction kernel the composition root
// already built. Importing this file connects to nothing and reads no secret.
//
// FAIL CLOSED, NEVER FAIL OPEN. A malformed row, an unexpected column or key, a grant that is not at platform
// scope, a row count other than one, an abort, a timeout, a lost connection and a driver error all answer
// 'unavailable' — never 'resolved', and never a fabricated principal. 'refused' is reserved for a reference the
// database says names nobody. There is no in-memory fallback and no development shortcut: with no database,
// this port admits nobody.
//
// NOTHING IS LOGGED. The provider reference is bound as a parameter and never appears in a message, an error or a
// return value; a driver error is caught and discarded — except by readPlatformAdmission, which runs on a caller's
// transaction and leaves the error to that caller's kernel, whose own boundary discards it.
import { isTrustedPrincipal } from '../runtime/principals.js';
import type { PlatformAdmissionPort, PlatformAdmissionResult, TrustedMembership } from '../runtime/principals.js';
import type { VerifiedPrincipal } from '../runtime/routes.js';
import type { PgTransactionScope, SupervisedPgClient, TransactionBounds } from './supervisedPgClient.js';

/**
 * Admission runs on EVERY protected administrative request (the boundary keeps no revalidation window), so its
 * bounds are the tenant admission's: one short read, cancelled by PostgreSQL itself if it overruns rather than
 * held by this process.
 */
export const PLATFORM_ADMISSION_DEADLINE_MS = 3_000;
export const PLATFORM_ADMISSION_BOUNDS: TransactionBounds = Object.freeze({
  lock: `${Math.floor(PLATFORM_ADMISSION_DEADLINE_MS * 0.7)}ms`,
  statement: `${Math.floor(PLATFORM_ADMISSION_DEADLINE_MS * 0.9)}ms`,
  idle: `${PLATFORM_ADMISSION_DEADLINE_MS * 2}ms`,
});

const REFUSED: PlatformAdmissionResult = Object.freeze({ outcome: 'refused' });
const UNAVAILABLE: PlatformAdmissionResult = Object.freeze({ outcome: 'unavailable' });

/**
 * The two providers 002's audit CHECK admits and 007's resolver names. A provider a later migration adds must be
 * added HERE TOO: a reference this set does not know is refused, and the boundary acts on a refusal by ending
 * every administrative session that principal holds.
 */
const PROVIDERS: ReadonlySet<string> = new Set(['firebase', 'supabase']);
/** Above the runtime's own bound (access.ts MAX_UID_LENGTH = 128): it only keeps an absurd value off the wire. */
const MAX_UID_LENGTH = 255;
/**
 * A syntactically valid reference that should name nobody. Readiness runs migration 013's read with it, through
 * 007's resolution, so a routine that is missing, not executable or broken in its lookup reports NOT ready. It is
 * not reserved: were someone registered under it, the read would answer `resolved`, an equally closed answer.
 */
const PROBE_UID = 'm5-platform-admission-probe-names-nobody-0';

/** The columns migration 013's read answers with. */
const ROW_COLUMNS: readonly string[] = [
  'outcome', 'actor_id', 'account_status', 'limitation', 'security_version', 'memberships', 'authority_version',
];
/** The fields each membership carries: 007's seven. */
const MEMBERSHIP_FIELDS: readonly string[] = ['membershipId', 'scopeType', 'tenantId', 'storeId', 'roleId', 'tenantStatus', 'storeStatus'];
/** The platform authority version as the routine renders it: canonical decimal text — no sign, no space, no leading zero. */
const AUTHORITY_VERSION_RE = /^(0|[1-9][0-9]{0,15})$/;

/**
 * `value` as a version 013 can answer: 0 for an actor with no counter row (its coalesce), else 1..2^53-1 (its CHECK).
 * Past the bound, Number rounds to 2^53 or above, which is never a safe integer, so the check stays exact.
 */
function isAuthorityVersion(value: unknown): value is string {
  return typeof value === 'string' && AUTHORITY_VERSION_RE.test(value) && Number.isSafeInteger(Number(value));
}

type Row = Readonly<Record<string, unknown>>;

/** Exactly one row, with exactly the columns the routine declares — or nothing is trusted. */
function onlyRow(rows: unknown, columns: readonly string[]): Row | null {
  if (!Array.isArray(rows) || rows.length !== 1) return null;
  const row: unknown = rows[0];
  if (typeof row !== 'object' || row === null) return null;
  const keys = Object.keys(row as Record<string, unknown>);
  if (keys.length !== columns.length || !columns.every((c) => keys.includes(c))) return null;
  return row as Row;
}

/**
 * The platform grants, every field read once and checked. The routine narrows 007's answer to platform scope, so a
 * grant at any other scope — or one that names a tenant, a store or a status, which a platform grant never does —
 * means the routine is not the one this file was written against: the whole admission is unavailable rather than
 * a principal with one grant quietly dropped or kept.
 */
function platformGrantsOf(value: unknown): TrustedMembership[] | null {
  if (!Array.isArray(value)) return null;
  const out: TrustedMembership[] = [];
  // inv: out holds a copy of each entry below i, each field read once; term: i rises to the array's length.
  for (let i = 0; i < value.length; i++) {
    const entry: unknown = value[i];
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return null;
    const e = entry as Record<string, unknown>;
    const keys = Object.keys(e);
    if (keys.length !== MEMBERSHIP_FIELDS.length || !MEMBERSHIP_FIELDS.every((f) => keys.includes(f))) return null;
    const { membershipId, scopeType, tenantId, storeId, roleId, tenantStatus, storeStatus } = e;
    if (typeof membershipId !== 'string' || typeof roleId !== 'string' || scopeType !== 'platform') return null;
    if (tenantId !== null || storeId !== null || tenantStatus !== null || storeStatus !== null) return null;
    out.push(Object.freeze({ membershipId, scopeType, roleId, tenant: null, store: null, tenantStatus: null, storeStatus: null }));
  }
  return out;
}

/** The answered row as an admission, or null — which the caller turns into 'unavailable'. */
function admissionOf(row: Row): PlatformAdmissionResult | null {
  const {
    outcome, actor_id: actor, account_status: accountStatus, limitation, security_version: securityVersion, memberships,
    authority_version: authorityVersion,
  } = row;
  // A refusal is 013's only when every payload column is null: one naming anything is a fault, never a denial that revokes.
  if (outcome === 'refused') {
    return [actor, accountStatus, limitation, securityVersion, memberships, authorityVersion].every((v) => v === null) ? REFUSED : null;
  }
  if (outcome !== 'resolved') return null;
  if (!isAuthorityVersion(authorityVersion)) return null;
  const grants = platformGrantsOf(memberships);
  if (grants === null) return null;
  const principal = Object.freeze({ actor, accountStatus, limitation, securityVersion, memberships: Object.freeze(grants) });
  if (!isTrustedPrincipal(principal)) return null;
  return Object.freeze({ outcome: 'resolved', principal, authorityVersion });
}

/** The reference, each field read once and checked, or null — which every caller answers 'refused' without a statement. */
function referenceOf(principal: unknown): VerifiedPrincipal | null {
  if (typeof principal !== 'object' || principal === null) return null;
  const { authProvider, authProviderUid } = principal as Record<string, unknown>;
  if (typeof authProvider !== 'string' || !PROVIDERS.has(authProvider)) return null;
  if (typeof authProviderUid !== 'string' || authProviderUid.length === 0 || authProviderUid.length > MAX_UID_LENGTH) return null;
  return Object.freeze({ authProvider, authProviderUid });
}

/**
 * Migration 013's read on the CALLER's own transaction handle (M5-ADMIN-REVOKE-P1): the same one statement admit() runs
 * in a transaction of its own, for the two callers that must read the standing where they write — the administrative
 * login's establish transaction and the command transaction (platformAuthorization.ts). It answers exactly what admit()
 * would, save that a statement or driver error is NOT caught: it propagates, the caller's transaction is aborted by it,
 * and the kernel rolls back — an outage there, never a verdict. 'unavailable' still marks a malformed answer.
 */
export async function readPlatformAdmission(sql: PgTransactionScope, principal: VerifiedPrincipal): Promise<PlatformAdmissionResult> {
  const reference = referenceOf(principal);
  if (reference === null) return REFUSED;
  const rows = await sql`select outcome, actor_id, account_status, limitation, security_version, memberships, authority_version
    from tmpos_admission.m5_admit_platform_session(${reference.authProvider}::text, ${reference.authProviderUid}::text)`;
  const row = onlyRow(rows, ROW_COLUMNS);
  if (row === null) return UNAVAILABLE;
  return admissionOf(row) ?? UNAVAILABLE;
}

/**
 * The production platform admission over the M6 runtime client. `client` is the kernel the composition root
 * already built — one client, one credential, one governed endpoint.
 */
export function createPostgresPlatformAdmission(deps: { readonly client: SupervisedPgClient }): PlatformAdmissionPort {
  const { client } = deps;

  const run = async <T>(signal: AbortSignal, work: (sql: PgTransactionScope) => Promise<T>, fallback: T): Promise<T> => {
    if (signal.aborted) return fallback;
    try {
      return await client.transaction(signal, PLATFORM_ADMISSION_BOUNDS, work);
    } catch {
      return fallback; // an outage, an abort, an overrun or a driver fault: nothing is disclosed
    }
  };

  return Object.freeze({
    async admit(principal: VerifiedPrincipal, signal: AbortSignal): Promise<PlatformAdmissionResult> {
      // Refused before a statement runs, so a malformed reference costs the database nothing.
      const reference = referenceOf(principal);
      if (reference === null) return REFUSED;
      return run(signal, (sql) => readPlatformAdmission(sql, reference), UNAVAILABLE);
    },

    /** Readiness: 013's read runs for a valid reference and answers one of its two closed outcomes. */
    probe(signal: AbortSignal): Promise<boolean> {
      return run(signal, async (sql) => {
        const rows = await sql`select outcome from tmpos_admission.m5_admit_platform_session('firebase'::text, ${PROBE_UID}::text)`;
        const row = onlyRow(rows, ['outcome']);
        return row !== null && (row.outcome === 'refused' || row.outcome === 'resolved');
      }, false);
    },
  });
}
