// Phase 1.5 M11.2 — Read-only durable authorization repository.
//
// PURPOSE: read the durable, app-owned authorization rows (platform_identity,
// app_user, tenant, store, user_membership, tenant_feature_entitlement) and
// assemble the exact server-side snapshot the pure M11 resolver consumes
// (AuthorizationResolverInput). It performs NO authorization logic itself — the
// inert resolver owns every decision. This module only READS.
//
// READ-ONLY (binding):
//   - SELECT-only, parameterized tagged-template SQL via the existing getDb()
//     helper. No INSERT/UPDATE/DELETE/UPSERT/ON CONFLICT/ALTER/DROP/TRUNCATE, no
//     sql.unsafe, no dynamic/string-concatenated SQL, no schema/RLS change, no
//     audit write. Table names are hardcoded literals — never caller-supplied.
//
// SERVER-AUTHORITATIVE (binding):
//   - Identity is selected ONLY by the durable, app-owned (auth_provider,
//     auth_provider_uid) reference key. Rows are then read by the app-owned
//     internal_user_id. NOTHING here trusts a request body, a provider token's
//     user_metadata, a JWT, or any client-asserted role/tenant/store/permission.
//   - It verifies NO token and reads NO secret. It returns RAW rows (statuses
//     preserved verbatim, roles not collapsed) and lets the resolver decide.
//
// ISOLATION (binding): server-side only — NEVER imported by src/ (the client
// bundle). Imports NO Express, NO frontend, NO sessionResolve. It is imported by
// the M11.2 live diagnostic only; it wires no route and changes no runtime path.
//
// SAFETY: never logs/returns the UID, email, DB URL, connection string, or any
// secret. Errors thrown by getDb()/queries are propagated UNMODIFIED to the
// caller (the diagnostic), which is responsible for sanitizing before printing —
// this module itself logs nothing.

import postgres from 'postgres';
import { getDb } from './db';
import type {
  AuthProviderValue,
  AccountStatusValue,
  MembershipStatusValue,
} from './authorizationConstants';
import type {
  ResolverIdentity,
  AppUserSnapshot,
  MembershipSnapshot,
  TenantSnapshot,
  StoreSnapshot,
  EntitlementSnapshot,
  RequestedContext,
  AuthorizationResolverInput,
} from './authorizationResolver';

// A SELECT-capable executor: the shared client (getDb()) or a transaction handle
// (e.g. a READ ONLY transaction opened by the diagnostic). TransactionSql extends
// Sql, so a transaction handle is accepted wherever this type is expected.
export type SqlExecutor = postgres.Sql<Record<string, never>>;

/** The durable identity reference key (NEVER a client-asserted internal id). */
export interface IdentityKey {
  authProvider: string;
  authProviderUid: string;
}

// =============================================================================
// Row mappers (DB text → resolver snapshot shapes)
// =============================================================================
// The 002/003 CHECK constraints guarantee the status/scope/role domains, so the
// narrowing casts below are honest reflections of DB-enforced invariants.

function mapIdentity(row: any): ResolverIdentity {
  return {
    internalUserId: row.internal_user_id,
    authProvider: row.auth_provider as AuthProviderValue,
    authProviderUid: row.auth_provider_uid ?? null,
    email: row.email ?? null,
  };
}

function mapAppUser(row: any): AppUserSnapshot {
  return {
    internal_user_id: row.internal_user_id,
    status: row.status as AccountStatusValue,
    display_name: row.display_name ?? null,
  };
}

function mapMembership(row: any): MembershipSnapshot {
  return {
    membership_id: row.membership_id,
    internal_user_id: row.internal_user_id,
    tenant_id: row.tenant_id ?? null,
    store_id: row.store_id ?? null,
    scope_type: row.scope_type as MembershipSnapshot['scope_type'],
    role_id: row.role_id,
    status: row.status as MembershipStatusValue,
  };
}

function mapTenant(row: any): TenantSnapshot {
  return {
    tenant_id: row.tenant_id,
    plan_key: row.plan_key,
    status: row.status as AccountStatusValue,
  };
}

function mapStore(row: any): StoreSnapshot {
  return {
    store_id: row.store_id,
    tenant_id: row.tenant_id,
    status: row.status as AccountStatusValue,
  };
}

function mapEntitlement(row: any): EntitlementSnapshot {
  return {
    tenant_id: row.tenant_id,
    feature_key: row.feature_key,
    enabled: row.enabled === true,
    source: row.source,
  };
}

// =============================================================================
// Read-only readers (SELECT only, parameterized)
// =============================================================================

/**
 * Look up the durable identity by its unique (auth_provider, auth_provider_uid)
 * reference key. Returns at most one identity, or null. Logs nothing.
 */
export async function getIdentityByProviderUid(
  authProvider: string,
  authProviderUid: string,
  executor: SqlExecutor = getDb(),
): Promise<ResolverIdentity | null> {
  const rows = await executor`
    select internal_user_id, auth_provider, auth_provider_uid, email
    from platform_identity
    where auth_provider = ${authProvider} and auth_provider_uid = ${authProviderUid}
    limit 1
  `;
  return rows.length ? mapIdentity(rows[0]) : null;
}

/** Read the durable app_user row for the app-owned internal_user_id (or null). */
export async function getAppUser(
  internalUserId: string,
  executor: SqlExecutor = getDb(),
): Promise<AppUserSnapshot | null> {
  const rows = await executor`
    select internal_user_id, status, display_name
    from app_user
    where internal_user_id = ${internalUserId}
    limit 1
  `;
  return rows.length ? mapAppUser(rows[0]) : null;
}

/**
 * Read ALL membership rows for the internal user — every scope, every status.
 * RAW rows: this does NOT filter by status and does NOT collapse roles; the
 * resolver applies status precedence and selects the active grant per scope.
 */
export async function getMembershipsForUser(
  internalUserId: string,
  executor: SqlExecutor = getDb(),
): Promise<MembershipSnapshot[]> {
  const rows = await executor`
    select membership_id, internal_user_id, tenant_id, store_id, scope_type, role_id, status
    from user_membership
    where internal_user_id = ${internalUserId}
  `;
  return rows.map(mapMembership);
}

/** Read the durable tenant row by id (or null). */
export async function getTenant(
  tenantId: string,
  executor: SqlExecutor = getDb(),
): Promise<TenantSnapshot | null> {
  const rows = await executor`
    select tenant_id, plan_key, status
    from tenant
    where tenant_id = ${tenantId}
    limit 1
  `;
  return rows.length ? mapTenant(rows[0]) : null;
}

/** Read the durable store row by id (or null). */
export async function getStore(
  storeId: string,
  executor: SqlExecutor = getDb(),
): Promise<StoreSnapshot | null> {
  const rows = await executor`
    select store_id, tenant_id, status
    from store
    where store_id = ${storeId}
    limit 1
  `;
  return rows.length ? mapStore(rows[0]) : null;
}

/**
 * Read ALL entitlement rows for a tenant — enabled AND disabled. RAW rows: the
 * resolver includes only enabled, in-scope rows.
 */
export async function getEntitlementsForTenant(
  tenantId: string,
  executor: SqlExecutor = getDb(),
): Promise<EntitlementSnapshot[]> {
  const rows = await executor`
    select tenant_id, feature_key, enabled, source
    from tenant_feature_entitlement
    where tenant_id = ${tenantId}
  `;
  return rows.map(mapEntitlement);
}

// =============================================================================
// Diagnostic-only row counts (no caller-supplied table names)
// =============================================================================

/** count(*) for each durable authorization table. Diagnostic no-mutation proof. */
export interface DurableRowCounts {
  app_user: number;
  tenant: number;
  store: number;
  user_membership: number;
  tenant_feature_entitlement: number;
  audit_event: number;
}

/**
 * Read count(*) from the fixed, hardcoded allow-list of durable tables. Table
 * names are SQL literals in separate parameter-free SELECTs — never interpolated
 * and never taken from a caller. Used by the live diagnostic to prove that no row
 * count changed before vs after the read-only resolver checks.
 */
export async function countDurableAuthorizationRows(
  executor: SqlExecutor = getDb(),
): Promise<DurableRowCounts> {
  const [au] = await executor`select count(*)::int as n from app_user`;
  const [tn] = await executor`select count(*)::int as n from tenant`;
  const [st] = await executor`select count(*)::int as n from store`;
  const [um] = await executor`select count(*)::int as n from user_membership`;
  const [fe] = await executor`select count(*)::int as n from tenant_feature_entitlement`;
  const [ae] = await executor`select count(*)::int as n from audit_event`;
  return {
    app_user: Number(au.n),
    tenant: Number(tn.n),
    store: Number(st.n),
    user_membership: Number(um.n),
    tenant_feature_entitlement: Number(fe.n),
    audit_event: Number(ae.n),
  };
}

// =============================================================================
// Snapshot assembler (RAW data only — no authorization logic)
// =============================================================================

/**
 * Assemble the exact AuthorizationResolverInput the pure resolver consumes, for a
 * given durable identity key + a server-validated requested context. Returns null
 * ONLY when no durable identity matches the key (the caller decides how to treat
 * that — the diagnostic fails closed). Loads RAW rows and performs NO decision
 * logic, NO client-trust, and NO row creation. Per scope:
 *   - platform: tenant=null, store=null, entitlements=[]
 *   - tenant:   load tenant + its entitlements; store=null
 *   - store:    load tenant + store + the tenant's entitlements
 * A null tenant/store row is returned verbatim (the resolver denies honestly).
 */
export async function buildResolverInputForContext(
  identityKey: IdentityKey,
  requestedContext: RequestedContext,
  executor: SqlExecutor = getDb(),
): Promise<AuthorizationResolverInput | null> {
  const identity = await getIdentityByProviderUid(
    identityKey.authProvider,
    identityKey.authProviderUid,
    executor,
  );
  if (!identity) return null;

  const appUser = await getAppUser(identity.internalUserId, executor);
  const memberships = await getMembershipsForUser(identity.internalUserId, executor);

  let tenant: TenantSnapshot | null = null;
  let store: StoreSnapshot | null = null;
  let entitlements: EntitlementSnapshot[] = [];

  if (requestedContext.scopeType === 'tenant' && requestedContext.tenantId) {
    tenant = await getTenant(requestedContext.tenantId, executor);
    entitlements = await getEntitlementsForTenant(requestedContext.tenantId, executor);
  } else if (
    requestedContext.scopeType === 'store' &&
    requestedContext.tenantId &&
    requestedContext.storeId
  ) {
    tenant = await getTenant(requestedContext.tenantId, executor);
    store = await getStore(requestedContext.storeId, executor);
    entitlements = await getEntitlementsForTenant(requestedContext.tenantId, executor);
  }

  return { identity, appUser, memberships, tenant, store, entitlements, requestedContext };
}
