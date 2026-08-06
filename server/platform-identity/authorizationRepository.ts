// Phase 1.5 M11.2 — Read-only durable authorization repository.
//
// PURPOSE: read the durable, app-owned authorization rows (platform_identity,
// app_user, tenant, store, user_membership, tenant_feature_entitlement) and
// assemble the exact server-side snapshot the pure M11 resolver consumes
// (AuthorizationResolverInput). It performs NO authorization logic itself — the
// inert resolver owns every decision. This module only READS.
//
// PHASE 4.0 M3 S4.1b C1R — TWO EXECUTION PLANES (binding):
//   - The privileged AUTHORIZATION CONTROL PLANE (ADMIN_CLIENT) resolves identity, app_user and
//     the narrow membership bootstrap that ESTABLISHES scope. It cannot itself be scope-filtered
//     without circularity, which is why it is classified as control-plane rather than tenant work.
//   - The TENANT DATA PLANE (RUNTIME_CLIENT under migration-005 RLS) reads tenant/store/
//     entitlement rows, and only after the scope has been validated against the verified user's
//     own membership rows. Its executor is a REQUIRED parameter — there is no getDb() fallback.
//
// READ-ONLY (binding):
//   - SELECT-only, parameterized tagged-template SQL. No INSERT/UPDATE/DELETE/UPSERT/ON
//     CONFLICT/ALTER/DROP/TRUNCATE, no
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
import { getDb, getRuntimeDb, withTenantContext } from './db';
import type { TenantContext, TransactionCapable, SqlTag } from './db';
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

// =============================================================================
// C1R — the two execution planes are now distinct TYPES, not one threaded client
// =============================================================================
//
// AUTHORIZATION CONTROL PLANE (privileged, ADMIN_CLIENT): platform_identity, app_user and the
// narrow user_membership bootstrap. Migration 005 deliberately grants tmpos_app NOTHING on the
// identity store, and the membership read is what ESTABLISHES scope — it cannot itself be
// scope-filtered without circularity. It is therefore classified as control-plane work.
//
// TENANT DATA PLANE (RUNTIME_CLIENT under RLS): tenant, store, tenant_feature_entitlement. These
// run only AFTER a trusted scope exists, inside withTenantContext(), and their executor is a
// REQUIRED parameter with no `= getDb()` default — a tenant read cannot silently fall back to the
// privileged client, because there is no fallback to fall back to.

/**
 * The tagged-template capability a tenant read needs. Deliberately narrower than SqlExecutor:
 * both a postgres.js client and a `withTenantContext` transaction handle satisfy it, so a tenant
 * reader can be handed a scoped transaction without widening its type to a full client.
 */
export type TenantSqlExecutor = (strings: TemplateStringsArray, ...values: any[]) => Promise<any[]>;

/**
 * Runs `fn` inside a transaction-local tenant context on the RUNTIME principal. The scope must
 * already be TRUSTED (validated against the verified user's memberships by the control plane).
 */
export type TenantScopeRunner = <T>(
  scope: TenantContext,
  fn: (tx: TenantSqlExecutor) => Promise<T>,
) => Promise<T>;

/**
 * The production runner: RUNTIME_CLIENT + transaction-local RLS context. It never consults the
 * admin client, and `getRuntimeDb()` throws when APP_DATABASE_URL is absent — so with no runtime
 * credential this fails closed rather than degrading to the privileged principal.
 */
export const runInTenantScope: TenantScopeRunner = <T>(
  scope: TenantContext,
  fn: (tx: TenantSqlExecutor) => Promise<T>,
): Promise<T> =>
  withTenantContext(
    getRuntimeDb() as unknown as TransactionCapable,
    scope,
    (tx: SqlTag) => fn(tx as unknown as TenantSqlExecutor),
  );

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

/**
 * Read the durable tenant row by id (or null). TENANT DATA PLANE: the executor is REQUIRED and
 * must be a scoped handle from withTenantContext() — there is deliberately no `= getDb()` default
 * to fall back to.
 */
export async function getTenant(
  tenantId: string,
  executor: TenantSqlExecutor,
): Promise<TenantSnapshot | null> {
  const rows = await executor`
    select tenant_id, plan_key, status
    from tenant
    where tenant_id = ${tenantId}
    limit 1
  `;
  return rows.length ? mapTenant(rows[0]) : null;
}

/** Read the durable store row by id (or null). TENANT DATA PLANE — executor REQUIRED. */
export async function getStore(
  storeId: string,
  executor: TenantSqlExecutor,
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
  executor: TenantSqlExecutor,
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
export interface AuthorizationBootstrap {
  identity: ResolverIdentity;
  appUser: AppUserSnapshot | null;
  memberships: MembershipSnapshot[];
}

/**
 * AUTHORIZATION CONTROL PLANE (privileged). Resolve the durable identity for an already
 * cryptographically-verified provider key, then load the app_user row and the membership set that
 * BELONGS TO THAT IDENTITY.
 *
 * The internal user id is never taken from a caller: it is produced here, from the verified
 * (auth_provider, auth_provider_uid) key, and every subsequent read is keyed on it. That is what
 * makes this bootstrap safe to run privileged — it cannot be steered at another user's rows.
 *
 * Returns null when no durable identity matches (the caller fails closed).
 */
export async function loadAuthorizationBootstrap(
  identityKey: IdentityKey,
  controlPlaneExecutor: SqlExecutor = getDb(),
): Promise<AuthorizationBootstrap | null> {
  const identity = await getIdentityByProviderUid(
    identityKey.authProvider,
    identityKey.authProviderUid,
    controlPlaneExecutor,
  );
  if (!identity) return null;

  const appUser = await getAppUser(identity.internalUserId, controlPlaneExecutor);
  const memberships = await getMembershipsForUser(identity.internalUserId, controlPlaneExecutor);
  return { identity, appUser, memberships };
}

export interface TenantScopeSnapshot {
  tenant: TenantSnapshot | null;
  store: StoreSnapshot | null;
  entitlements: EntitlementSnapshot[];
}

/**
 * TENANT DATA PLANE. Load the tenant/store/entitlement rows for an ALREADY TRUSTED scope, on a
 * scoped executor. Platform scope reads nothing here by design: migration 005 states the runtime
 * principal never operates at platform scope, so a platform decision stays entirely on the
 * control plane and this returns the empty snapshot without touching the runtime client.
 */
export async function loadTenantScopeSnapshot(
  trustedScope: RequestedContext,
  executor: TenantSqlExecutor,
): Promise<TenantScopeSnapshot> {
  if (trustedScope.scopeType === 'tenant' && trustedScope.tenantId) {
    return {
      tenant: await getTenant(trustedScope.tenantId, executor),
      store: null,
      entitlements: await getEntitlementsForTenant(trustedScope.tenantId, executor),
    };
  }
  if (trustedScope.scopeType === 'store' && trustedScope.tenantId && trustedScope.storeId) {
    return {
      tenant: await getTenant(trustedScope.tenantId, executor),
      store: await getStore(trustedScope.storeId, executor),
      entitlements: await getEntitlementsForTenant(trustedScope.tenantId, executor),
    };
  }
  return { tenant: null, store: null, entitlements: [] };
}

/** True when the scope requires RLS-protected tenant data (i.e. the runtime plane must run). */
export function scopeNeedsTenantPlane(scope: RequestedContext): boolean {
  return (
    (scope.scopeType === 'tenant' && !!scope.tenantId)
    || (scope.scopeType === 'store' && !!scope.tenantId && !!scope.storeId)
  );
}

/**
 * TRUST GATE — is this scope backed by an ACTIVE membership of the verified user?
 *
 * This is not the authorization decision; the inert resolver still owns that. It decides only
 * whether the runtime plane may run AT ALL, and it is load-bearing rather than belt-and-braces:
 * the migration-005 policies filter tenant rows by the DECLARED context (`tenant_id =
 * current_setting('app.tenant_id')`), NOT by the caller's memberships. RLS therefore prevents
 * cross-context leakage but would happily serve tenant X's rows to anyone who declares tenant X.
 * Binding the declared scope to the verified user's own membership rows — which only the
 * privileged bootstrap can read — is what stops an unvalidated scope from becoming trusted.
 */
export function isScopeBackedByActiveMembership(
  scope: RequestedContext,
  memberships: MembershipSnapshot[],
): boolean {
  if (scope.scopeType === 'platform') {
    return memberships.some((m) => m.scope_type === 'platform' && m.status === 'active');
  }
  if (scope.scopeType === 'tenant') {
    return !!scope.tenantId && memberships.some(
      (m) => m.scope_type === 'tenant' && m.status === 'active' && m.tenant_id === scope.tenantId,
    );
  }
  if (scope.scopeType === 'store') {
    return !!scope.tenantId && !!scope.storeId && memberships.some(
      (m) => m.scope_type === 'store'
        && m.status === 'active'
        && m.tenant_id === scope.tenantId
        && m.store_id === scope.storeId,
    );
  }
  return false;
}

export async function buildResolverInputForContext(
  identityKey: IdentityKey,
  requestedContext: RequestedContext,
  controlPlaneExecutor: SqlExecutor = getDb(),
  tenantScope: TenantScopeRunner = runInTenantScope,
): Promise<AuthorizationResolverInput | null> {
  // Phase 1 — privileged control plane. Identity + app_user + the membership bootstrap.
  const bootstrap = await loadAuthorizationBootstrap(identityKey, controlPlaneExecutor);
  if (!bootstrap) return null;
  const { identity, appUser, memberships } = bootstrap;

  // TRUST GATE — the requested scope becomes trusted only once it is backed by an ACTIVE
  // membership of THIS verified user, read privileged in phase 1. An unbacked scope never
  // reaches the runtime plane, so no tenant SQL is issued for it at all.
  const scopeIsTrusted = isScopeBackedByActiveMembership(requestedContext, memberships);

  // Phase 2 — tenant data plane, on the RUNTIME principal inside transaction-local RLS context.
  // The privileged executor is NOT threaded here: `tenantScope` owns its own client, so there is
  // no path by which an admin handle reaches a tenant table.
  const snapshot: TenantScopeSnapshot = scopeIsTrusted && scopeNeedsTenantPlane(requestedContext)
    ? await tenantScope(requestedContext as TenantContext, (tx) =>
      loadTenantScopeSnapshot(requestedContext, tx))
    : { tenant: null, store: null, entitlements: [] };

  return {
    identity,
    appUser,
    memberships,
    tenant: snapshot.tenant,
    store: snapshot.store,
    entitlements: snapshot.entitlements,
    requestedContext,
  };
}
