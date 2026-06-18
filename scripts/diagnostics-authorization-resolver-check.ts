// Phase 1.5 M11 — dev-only check for the pure server-derived authorization resolver.
//
// PURE / OFFLINE: no DB, no network, no Supabase, no Firebase, no env secrets, no
// SQL, no migration, no runtime endpoint call. It feeds MOCKED durable-row
// snapshots to resolveAuthorization() and asserts the M11 rules, plus static
// assertions that the resolver is inert and not wired into the runtime.
//
// Run:  npx tsx scripts/diagnostics-authorization-resolver-check.ts

import { readFileSync } from 'fs';
import { join } from 'path';
import {
  resolveAuthorization,
  AUTHORIZATION_RESOLVER_REASON_CODES as RC,
  type AuthorizationResolverInput,
  type ResolverIdentity,
  type AppUserSnapshot,
  type MembershipSnapshot,
} from '../server/platform-identity/authorizationResolver';

const ROOT = process.cwd();

interface Result { name: string; pass: boolean; detail: string }
const results: Result[] = [];
function check(name: string, pass: boolean, detail = ''): void {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

// ---- mocked snapshot builders ----------------------------------------------

const UID = 'user-internal-1';
const TID = 'tenant-1';
const SID = 'store-1';

const identity = (): ResolverIdentity => ({
  internalUserId: UID, authProvider: 'supabase', authProviderUid: 'sub-abc', email: 'tester@dev.local',
});
const appUser = (status: AppUserSnapshot['status'] = 'active'): AppUserSnapshot => ({
  internal_user_id: UID, status, display_name: 'Tester',
});
const membership = (over: Partial<MembershipSnapshot>): MembershipSnapshot => ({
  membership_id: 'm-1', internal_user_id: UID, tenant_id: null, store_id: null,
  scope_type: 'platform', role_id: 'system_owner', status: 'active', ...over,
});
function base(over: Partial<AuthorizationResolverInput>): AuthorizationResolverInput {
  return {
    identity: identity(), appUser: appUser(), memberships: [], tenant: null, store: null,
    entitlements: [], requestedContext: { scopeType: 'platform' }, ...over,
  };
}

// ---- 1..8 status / membership denials --------------------------------------

{
  const r = resolveAuthorization(base({ appUser: null }));
  check('1 missing app_user denies', r.decision === 'deny' && r.authorization === null && r.reasonCode === RC.DENIED_NO_APP_USER, r.reasonCode);
}
{
  const r = resolveAuthorization(base({ appUser: appUser('suspended'), memberships: [membership({})] }));
  check('2 suspended app_user denies', r.decision === 'deny' && r.reasonCode === RC.DENIED_ACCOUNT_SUSPENDED, r.reasonCode);
}
{
  const r = resolveAuthorization(base({ appUser: appUser('pending_activation'), memberships: [membership({})] }));
  check('3 pending_activation app_user denies', r.decision === 'deny' && r.reasonCode === RC.DENIED_ACCOUNT_PENDING_ACTIVATION, r.reasonCode);
}
{
  const r = resolveAuthorization(base({ appUser: appUser('read_only'), memberships: [membership({ role_id: 'system_owner' })] }));
  check('4 read_only app_user resolves with read-only limiting', r.decision === 'allow' && r.limitation === 'read_only' && r.reasonCode === RC.RESOLVED_READ_ONLY, `${r.decision}/${r.limitation}`);
}
{
  const r = resolveAuthorization(base({ memberships: [] }));
  check('5 missing membership denies', r.decision === 'deny' && r.reasonCode === RC.DENIED_NO_MEMBERSHIP, r.reasonCode);
}
{
  const r = resolveAuthorization(base({ memberships: [membership({ status: 'invited' })] }));
  check('6 invited membership denies', r.decision === 'deny' && r.reasonCode === RC.DENIED_MEMBERSHIP_NOT_ACTIVE, r.reasonCode);
}
{
  const r = resolveAuthorization(base({ memberships: [membership({ status: 'suspended' })] }));
  check('7 suspended membership denies', r.decision === 'deny' && r.reasonCode === RC.DENIED_MEMBERSHIP_NOT_ACTIVE, r.reasonCode);
}
{
  const r = resolveAuthorization(base({ memberships: [membership({ status: 'pending_setup' })] }));
  check('8 pending_setup membership denies', r.decision === 'deny' && r.reasonCode === RC.DENIED_MEMBERSHIP_NOT_ACTIVE, r.reasonCode);
}

// ---- 9..11 owner resolutions ------------------------------------------------

{
  const r = resolveAuthorization(base({ memberships: [membership({ scope_type: 'platform', role_id: 'system_owner' })], requestedContext: { scopeType: 'platform' } }));
  const a = r.authorization;
  check('9 active platform owner resolves platform scope', r.decision === 'allow' && a?.userType === 'platform' && a?.scope.scopeType === 'platform' && a?.roles.platformRoleId === 'system_owner', `${r.decision}/${a?.roles.platformRoleId}`);
}
{
  const r = resolveAuthorization(base({
    requestedContext: { scopeType: 'tenant', tenantId: TID },
    tenant: { tenant_id: TID, plan_key: 'growth', status: 'active' },
    memberships: [membership({ membership_id: 'm-t', scope_type: 'tenant', tenant_id: TID, role_id: 'store_owner', status: 'active' })],
  }));
  const a = r.authorization;
  check('10 active tenant owner resolves tenant scope', r.decision === 'allow' && a?.userType === 'tenant' && a?.scope.scopeType === 'tenant' && a?.scope.tenantId === TID && a?.roles.tenantRoleId === 'store_owner', `${r.decision}/${a?.roles.tenantRoleId}`);
}
{
  const r = resolveAuthorization(base({
    requestedContext: { scopeType: 'store', tenantId: TID, storeId: SID },
    tenant: { tenant_id: TID, plan_key: 'growth', status: 'active' },
    store: { store_id: SID, tenant_id: TID, status: 'active' },
    memberships: [membership({ membership_id: 'm-s', scope_type: 'store', tenant_id: TID, store_id: SID, role_id: 'store_owner', status: 'active' })],
  }));
  const a = r.authorization;
  check('11 active store owner resolves store scope', r.decision === 'allow' && a?.scope.scopeType === 'store' && a?.scope.storeId === SID && a?.roles.tenantRoleId === 'store_owner', `${r.decision}/${a?.scope.storeId}`);
}

// ---- 12..16 scope/status edge rules ----------------------------------------

{
  // store scope requires active tenant: tenant suspended ⇒ deny BEFORE role.
  const r = resolveAuthorization(base({
    requestedContext: { scopeType: 'store', tenantId: TID, storeId: SID },
    tenant: { tenant_id: TID, plan_key: 'growth', status: 'suspended' },
    store: { store_id: SID, tenant_id: TID, status: 'active' },
    memberships: [membership({ scope_type: 'store', tenant_id: TID, store_id: SID, role_id: 'store_owner' })],
  }));
  check('12 store scope requires active tenant (suspended tenant denies)', r.decision === 'deny' && r.reasonCode === RC.DENIED_TENANT_STATUS, r.reasonCode);
}
{
  // store belongs to a different tenant.
  const r = resolveAuthorization(base({
    requestedContext: { scopeType: 'store', tenantId: TID, storeId: SID },
    tenant: { tenant_id: TID, plan_key: 'growth', status: 'active' },
    store: { store_id: SID, tenant_id: 'tenant-OTHER', status: 'active' },
    memberships: [membership({ scope_type: 'store', tenant_id: TID, store_id: SID, role_id: 'store_owner' })],
  }));
  check('13 store not belonging to tenant denies', r.decision === 'deny' && r.reasonCode === RC.DENIED_STORE_TENANT_MISMATCH, r.reasonCode);
}
{
  const r = resolveAuthorization(base({
    requestedContext: { scopeType: 'tenant', tenantId: TID },
    tenant: { tenant_id: TID, plan_key: 'growth', status: 'suspended' },
    memberships: [membership({ scope_type: 'tenant', tenant_id: TID, role_id: 'manager' })],
  }));
  check('14 suspended tenant denies', r.decision === 'deny' && r.reasonCode === RC.DENIED_TENANT_STATUS, r.reasonCode);
}
{
  const r = resolveAuthorization(base({
    requestedContext: { scopeType: 'store', tenantId: TID, storeId: SID },
    tenant: { tenant_id: TID, plan_key: 'growth', status: 'active' },
    store: { store_id: SID, tenant_id: TID, status: 'suspended' },
    memberships: [membership({ scope_type: 'store', tenant_id: TID, store_id: SID, role_id: 'store_owner' })],
  }));
  check('15 suspended store denies', r.decision === 'deny' && r.reasonCode === RC.DENIED_STORE_STATUS, r.reasonCode);
}
{
  const r = resolveAuthorization(base({
    requestedContext: { scopeType: 'tenant', tenantId: TID },
    tenant: { tenant_id: TID, plan_key: 'growth', status: 'overdue' },
    memberships: [membership({ scope_type: 'tenant', tenant_id: TID, role_id: 'manager' })],
  }));
  check('16 overdue tenant limits to read-only', r.decision === 'allow' && r.limitation === 'read_only' && r.authorization?.status.tenant === 'overdue', `${r.decision}/${r.limitation}`);
}

// ---- 17..19 entitlements ----------------------------------------------------

const tenantOwnerInput = (entitlements: AuthorizationResolverInput['entitlements']): AuthorizationResolverInput => base({
  requestedContext: { scopeType: 'tenant', tenantId: TID },
  tenant: { tenant_id: TID, plan_key: 'growth', status: 'active' },
  memberships: [membership({ scope_type: 'tenant', tenant_id: TID, role_id: 'store_owner' })],
  entitlements,
});
{
  const r = resolveAuthorization(tenantOwnerInput([{ tenant_id: TID, feature_key: 'pos', enabled: true, source: 'plan' }]));
  check('17 enabled entitlement is included', r.authorization?.entitlements.pos === true, JSON.stringify(r.authorization?.entitlements));
}
{
  const r = resolveAuthorization(tenantOwnerInput([{ tenant_id: TID, feature_key: 'pos', enabled: false, source: 'plan' }]));
  check('18 disabled entitlement is excluded', r.authorization?.entitlements.pos === undefined, JSON.stringify(r.authorization?.entitlements));
}
{
  const r = resolveAuthorization(tenantOwnerInput([{ tenant_id: 'tenant-OTHER', feature_key: 'pos', enabled: true, source: 'plan' }]));
  check('19 other-tenant entitlement is excluded', r.authorization?.entitlements.pos === undefined, JSON.stringify(r.authorization?.entitlements));
}

// ---- 20..21 never trust client / metadata ----------------------------------

{
  // Injected client claims on the context + a different real membership role.
  const injectedCtx = { scopeType: 'tenant', tenantId: TID, role: 'store_owner', permissions: { all: 'full' } } as any;
  const r = resolveAuthorization(base({
    requestedContext: injectedCtx,
    tenant: { tenant_id: TID, plan_key: 'starter', status: 'active' },
    memberships: [membership({ scope_type: 'tenant', tenant_id: TID, role_id: 'sales_staff' })],
  }));
  check('20 client-supplied role/permission ignored', r.authorization?.roles.tenantRoleId === 'sales_staff', r.authorization?.roles.tenantRoleId ?? 'null');
}
{
  // user_metadata injected on identity must not grant access without a membership.
  const idWithMeta = { ...identity(), user_metadata: { role: 'system_owner' }, app_metadata: { admin: true } } as any;
  const r = resolveAuthorization(base({ identity: idWithMeta, memberships: [] }));
  check('21 Supabase user_metadata ignored', r.decision === 'deny' && r.reasonCode === RC.DENIED_NO_MEMBERSHIP, r.reasonCode);
}

// ---- 22..23 output shape / denial null -------------------------------------

{
  const r = resolveAuthorization(base({ memberships: [membership({ role_id: 'system_owner' })] }));
  const a = r.authorization!;
  const keys = Object.keys(a).sort().join(',');
  const expected = ['authorizationVersion', 'derivedBy', 'entitlements', 'permissions', 'roles', 'scope', 'status', 'subPermissions', 'userType'].sort().join(',');
  const shapeOk = keys === expected && a.authorizationVersion === 'authz.v1' &&
    typeof a.scope === 'object' && 'scopeType' in a.scope && 'tenantId' in a.scope && 'storeId' in a.scope &&
    'platformRoleId' in a.roles && 'tenantRoleId' in a.roles &&
    'user' in a.status && 'tenant' in a.status && 'store' in a.status;
  check('22 allowed output conforms to ServerDerivedAuthorizationV1', shapeOk, keys);
}
{
  const denials = [
    resolveAuthorization(base({ appUser: null })),
    resolveAuthorization(base({ memberships: [] })),
    resolveAuthorization(base({ appUser: appUser('suspended'), memberships: [membership({})] })),
  ];
  check('23 every denied result has authorization=null', denials.every((d) => d.authorization === null));
}

// ---- 24..27 inertness / isolation / no-secret ------------------------------

const resolverSrc = readFileSync(join(ROOT, 'server', 'platform-identity', 'authorizationResolver.ts'), 'utf8');
/** Strip // and block comments so the scan only sees executable code (not the
 *  resolver's own "no process.env / no Firebase" documentation). */
function stripTsComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}
{
  const code = stripTsComments(resolverSrc);
  const forbidden = /process\.env|getDb|from 'postgres'|postgres\(|from 'express'|fetch\(|createClient|firebase|supabase|https?:\/\/|require\(/i;
  const imports = [...code.matchAll(/from '([^']+)'/g)].map((m) => m[1]);
  // Phase 1.6 M1: the resolver now also imports the inert, server-only permission
  // catalog to materialize permissions/subPermissions on allow. The catalog is
  // itself inert (asserted by diagnostics-permission-catalog-static-check.ts), so
  // the resolver's import graph stays I/O-free.
  const allowedImports = new Set(['./authorizationConstants', './authorizationContract', './permissionCatalog']);
  const onlyInertImports = imports.length > 0 && imports.every((i) => allowedImports.has(i));
  check('24 resolver performs no DB/env/network/IO (code only)', !forbidden.test(code) && onlyInertImports, `imports=[${imports.join(', ')}]`);
}
const sessionResolveSrc = readFileSync(join(ROOT, 'server', 'platform-identity', 'sessionResolve.ts'), 'utf8');
{
  check('25 resolver not imported by sessionResolve.ts', !/authorizationResolver/.test(sessionResolveSrc));
}
{
  check('26 /auth/session/resolve still returns authorization: null', /authorization:\s*null/.test(sessionResolveSrc));
}
{
  const r = resolveAuthorization(base({ memberships: [membership({ role_id: 'system_owner' })] }));
  const json = JSON.stringify(r);
  const forbiddenFields = ['accessToken', 'refreshToken', 'rawJwt', 'jwtPayload', 'jwks', 'serviceRoleKey', 'databaseUrl', 'connectionString', 'password'];
  const leaked = forbiddenFields.filter((f) => json.includes(f));
  check('27 no forbidden token/secret fields in output', leaked.length === 0, leaked.length ? `LEAKED: ${leaked.join(',')}` : 'none');
}

const failed = results.filter((r) => !r.pass);
console.log(`\n[authorization-resolver-check] ${results.length - failed.length}/${results.length} checks passed.`);
if (failed.length) process.exitCode = 1;
