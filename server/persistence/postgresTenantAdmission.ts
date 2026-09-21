// Phase 4.0 M5 — the PostgreSQL tenant admission: the production adapter behind the tenant session
// boundary's SessionAdmission, over migration 011's one bounded read (M5-GIAM-D1-P2-R1; DA-32, GAP-13).
//
// WHAT IT ANSWERS. For a provider reference the authentication boundary has already verified, it asks
// the database who that names and what they currently hold, and derives the SESSION WITNESS — the
// security version the boundary binds into the session record and re-compares on every protected
// request. Nothing authoritative comes from the request: not the actor, not the tenant, not the store,
// not the role, not the membership, not the lifecycle status, not the access version. The request
// supplies a cookie; the database supplies the rest.
//
// THE WITNESS, AND WHY IT IS A DIGEST OVER EVERYTHING. sessions.ts admits a session at one opaque
// version and refuses it the moment that version moves, so the witness must move on EVERY change that
// should end a session and on no change that should not. It is therefore a digest over the actor's
// whole standing: the actor, the account status and its read-only cap, migration 007's account security
// version, and every grant the database still returns — its id, scope, tenant, store, role, the tenant's
// and store's lifecycle statuses, and the tenant's ACCESS VERSION (migration 010).
//   * SUSPENDING a tenant removes its grants from 007's answer AND moves that tenant's access version:
//     the digest moves, and every session admitted before it is refused.
//   * REACTIVATING moves the access version again, to a value it has never held, so the digest does NOT
//     return to what it was before the suspension. A session that was idle across the whole episode is
//     refused too — the revival this boundary exists to prevent.
//   * A DISPLAY-NAME edit moves only row_version, which is not in the digest, so no session ends.
// Ordering is the database's (migration 011 orders by membership id), so one unchanged state always
// digests to one unchanged value.
//
// IT CONSTRUCTS NOTHING AND READS NOTHING. The caller hands it the transaction kernel the composition
// root already built. Importing this file connects to nothing and reads no secret.
//
// FAIL CLOSED, NEVER FAIL OPEN. A malformed row, an unexpected column or key, a row count other than
// one, an abort, a timeout, a lost connection and a driver error all answer 'unavailable' — never
// 'admitted', and never a fabricated principal. 'refused' is reserved for a reference the database
// says names nobody who may hold a tenant session. There is no in-memory fallback and no development
// shortcut: with no database, this port admits nobody.
//
// NOTHING IS LOGGED. The provider reference is bound as a parameter and never appears in a message, an
// error or a return value; a driver error is caught and discarded.
import { createHash } from 'node:crypto';
import { isTrustedPrincipal } from '../runtime/principals.js';
import type { TenantAdmissionPort, TenantAdmissionResult, TrustedMembership } from '../runtime/principals.js';
import type { VerifiedPrincipal } from '../runtime/routes.js';
import type { PgTransactionScope, SupervisedPgClient, TransactionBounds } from './supervisedPgClient.js';

/**
 * Admission runs on EVERY protected tenant request (the boundary keeps no revalidation window), so its
 * bounds are the resolver's: one short read, cancelled by PostgreSQL itself if it overruns rather than
 * held by this process.
 */
export const TENANT_ADMISSION_DEADLINE_MS = 3_000;
export const TENANT_ADMISSION_BOUNDS: TransactionBounds = Object.freeze({
  lock: `${Math.floor(TENANT_ADMISSION_DEADLINE_MS * 0.7)}ms`,
  statement: `${Math.floor(TENANT_ADMISSION_DEADLINE_MS * 0.9)}ms`,
  idle: `${TENANT_ADMISSION_DEADLINE_MS * 2}ms`,
});

const REFUSED: TenantAdmissionResult = Object.freeze({ outcome: 'refused' });
const UNAVAILABLE: TenantAdmissionResult = Object.freeze({ outcome: 'unavailable' });

/**
 * The two providers 002's audit CHECK admits, and the same two 007's resolver names. A provider a
 * later migration adds must be added HERE TOO: a reference this set does not know is refused, and the
 * boundary acts on a refusal by ending every session that principal holds.
 */
const PROVIDERS: ReadonlySet<string> = new Set(['firebase', 'supabase']);
/**
 * A bound above the runtime's own (access.ts MAX_UID_LENGTH = 128) and above migration 011's column
 * CHECK, so no reference the authentication boundary accepted is refused here; it exists only to keep
 * an absurd value from reaching the database at all.
 */
const MAX_UID_LENGTH = 255;
/** The witness's prefix: it names the derivation, so a later one is never mistaken for this one. */
const WITNESS_PREFIX = 't1';
/**
 * A syntactically valid reference that should name nobody. Readiness runs migration 011's routine with
 * it, through 007's resolution, so a routine that is missing, not executable, or broken in its lookup
 * reports NOT ready. An empty or malformed reference would be refused by the first guard, before
 * anything was read, and would report ready on an adapter that can no longer reach the database.
 *
 * WHAT IT DOES NOT REACH. A reference that names nobody holds no grant, so 011 answers before its
 * access-version join runs: a definer that can no longer read public.tenant is reported by the first
 * admission that needs it — as an outage, a 503 that revokes nothing — not by readiness. Nor is the
 * reference reserved: were someone ever registered under it, 011 would answer `resolved`, which is an
 * equally closed, well-formed answer and is read as ready too.
 */
const PROBE_UID = 'm5-tenant-admission-probe-names-nobody-00';

/** The columns migration 011's read answers with. */
const ROW_COLUMNS: readonly string[] = ['outcome', 'actor_id', 'account_status', 'limitation', 'security_version', 'memberships'];
/** The fields each membership carries: 007's seven, plus the tenant's access version. */
const MEMBERSHIP_FIELDS: readonly string[] = [
  'membershipId', 'scopeType', 'tenantId', 'storeId', 'roleId', 'tenantStatus', 'storeStatus', 'tenantAccessVersion',
];
/** An access version as the routine renders it: decimal text, bounded well inside bigint. */
const ACCESS_VERSION_RE = /^[0-9]{1,19}$/;

type Row = Readonly<Record<string, unknown>>;

/** One grant as the database answered, with the witness field kept beside the port's own shape. */
interface WitnessedMembership {
  readonly membership: TrustedMembership;
  readonly tenantAccessVersion: string | null;
}

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
 * The membership array, every field read once and checked. The routine builds it with
 * jsonb_build_object, so the driver hands back plain objects; anything else — a string, a proxy, a
 * missing key, an extra key — makes the whole admission unavailable rather than a principal with one
 * grant quietly dropped or one witness quietly absent.
 */
function membershipsOf(value: unknown): WitnessedMembership[] | null {
  if (!Array.isArray(value)) return null;
  const out: WitnessedMembership[] = [];
  // inv: out holds a copy of each entry below i, each field read once; term: i rises to the array's length.
  for (let i = 0; i < value.length; i++) {
    const entry: unknown = value[i];
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return null;
    const e = entry as Record<string, unknown>;
    const keys = Object.keys(e);
    if (keys.length !== MEMBERSHIP_FIELDS.length || !MEMBERSHIP_FIELDS.every((f) => keys.includes(f))) return null;
    const { membershipId, scopeType, tenantId, storeId, roleId, tenantStatus, storeStatus, tenantAccessVersion } = e;
    if (typeof membershipId !== 'string' || typeof roleId !== 'string') return null;
    if (scopeType !== 'platform' && scopeType !== 'tenant' && scopeType !== 'store') return null;
    if (tenantId !== null && typeof tenantId !== 'string') return null;
    if (storeId !== null && typeof storeId !== 'string') return null;
    if (tenantStatus !== null && typeof tenantStatus !== 'string') return null;
    if (storeStatus !== null && typeof storeStatus !== 'string') return null;
    // A grant that names a tenant MUST carry that tenant's access version, and one that names none must
    // carry no version. A tenant-scoped grant with no witness could never be revoked by moving one,
    // which is the whole guarantee. The routine RAISES in that case (migration 011: a missing version
    // means it cannot read public.tenant, which is a fault, not a verdict) and reaches this file as an
    // outage; a version that is present but malformed is caught here and is an outage too. Neither is
    // ever a refusal, because the boundary acts on a refusal by ending every session the principal holds.
    if (tenantId === null) {
      if (tenantAccessVersion !== null) return null;
    } else if (typeof tenantAccessVersion !== 'string' || !ACCESS_VERSION_RE.test(tenantAccessVersion)) {
      return null;
    }
    out.push(Object.freeze({
      membership: Object.freeze({
        membershipId, scopeType, roleId,
        tenant: tenantId as string | null, store: storeId as string | null,
        tenantStatus: tenantStatus as string | null, storeStatus: storeStatus as string | null,
      }),
      tenantAccessVersion: tenantAccessVersion as string | null,
    }));
  }
  return out;
}

/**
 * The session witness over one answer.
 *
 * Every field is printable and newline-free by its own constraint — a UUID, one of 002's status words,
 * a role id migration 003 pins, 007's security version (printable ASCII, no space) or a decimal access
 * version — so joining with newlines is injective: no two different standings can produce one string.
 * The array's order is the database's, by membership id, so an unchanged standing digests unchanged.
 */
function witnessOf(
  actor: string, accountStatus: string, limitation: string, securityVersion: string, grants: readonly WitnessedMembership[],
): string {
  const lines: string[] = [WITNESS_PREFIX, actor, accountStatus, limitation, securityVersion, String(grants.length)];
  for (const { membership: m, tenantAccessVersion } of grants) {
    lines.push(m.membershipId, m.scopeType, m.tenant ?? '', m.store ?? '', m.roleId,
      m.tenantStatus ?? '', m.storeStatus ?? '', tenantAccessVersion ?? '');
  }
  // 43 base64url characters after the prefix: well inside the boundary's 1-128 printable-ASCII bound.
  return `${WITNESS_PREFIX}:${createHash('sha256').update(lines.join('\n')).digest('base64url')}`;
}

/** The answered row as an admission, or null — which the caller turns into 'unavailable'. */
function admissionOf(row: Row): TenantAdmissionResult | null {
  const {
    outcome, actor_id: actor, account_status: accountStatus, limitation, security_version: securityVersion, memberships,
  } = row;
  if (outcome === 'refused') return REFUSED;
  if (outcome !== 'resolved') return null;
  const grants = membershipsOf(memberships);
  if (grants === null) return null;
  const candidate = Object.freeze({
    actor, accountStatus, limitation, securityVersion,
    memberships: Object.freeze(grants.map((g) => g.membership)),
  });
  if (!isTrustedPrincipal(candidate)) return null;
  // A TENANT session needs a tenant or store grant. An actor holding only a platform grant — or none
  // at all, which is what remains once every tenant they held is suspended — is refused here, and the
  // boundary then ends every session that principal holds on it (sessions.ts revokeAllOf). This is a
  // REFUSAL, not an outage: the database answered, and the answer is that nobody may hold a session.
  if (!candidate.memberships.some((m) => m.scopeType === 'tenant' || m.scopeType === 'store')) return REFUSED;
  return Object.freeze({
    outcome: 'admitted',
    principal: candidate,
    securityVersion: witnessOf(candidate.actor, candidate.accountStatus, candidate.limitation, candidate.securityVersion, grants),
  });
}

/**
 * The production tenant admission over the M6 runtime client. `client` is the kernel the composition
 * root already built — one client, one credential, one governed endpoint.
 */
export function createPostgresTenantAdmission(deps: { readonly client: SupervisedPgClient }): TenantAdmissionPort {
  const { client } = deps;

  const run = async <T>(signal: AbortSignal, work: (sql: PgTransactionScope) => Promise<T>, fallback: T): Promise<T> => {
    if (signal.aborted) return fallback;
    try {
      return await client.transaction(signal, TENANT_ADMISSION_BOUNDS, work);
    } catch {
      return fallback; // an outage, an abort, an overrun or a driver fault: nothing is disclosed
    }
  };

  return Object.freeze({
    async admit(principal: VerifiedPrincipal, signal: AbortSignal): Promise<TenantAdmissionResult> {
      // Refused before a statement runs, so a malformed reference costs the database nothing.
      if (typeof principal !== 'object' || principal === null) return REFUSED;
      const { authProvider, authProviderUid } = principal as unknown as Record<string, unknown>;
      if (typeof authProvider !== 'string' || !PROVIDERS.has(authProvider)) return REFUSED;
      if (typeof authProviderUid !== 'string' || authProviderUid.length === 0 || authProviderUid.length > MAX_UID_LENGTH) return REFUSED;

      return run(signal, async (sql) => {
        const rows = await sql`select outcome, actor_id, account_status, limitation, security_version, memberships
          from tmpos_session.m5_admit_tenant_session(${authProvider}::text, ${authProviderUid}::text)`;
        const row = onlyRow(rows, ROW_COLUMNS);
        if (row === null) return UNAVAILABLE;
        return admissionOf(row) ?? UNAVAILABLE;
      }, UNAVAILABLE);
    },

    /** Readiness: 011's routine runs for a valid reference and answers one of its two closed outcomes. */
    probe(signal: AbortSignal): Promise<boolean> {
      return run(signal, async (sql) => {
        const rows = await sql`select outcome from tmpos_session.m5_admit_tenant_session('firebase'::text, ${PROBE_UID}::text)`;
        const row = onlyRow(rows, ['outcome']);
        return row !== null && (row.outcome === 'refused' || row.outcome === 'resolved');
      }, false);
    },
  });
}
