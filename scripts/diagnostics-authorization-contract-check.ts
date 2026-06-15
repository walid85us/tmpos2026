// Phase 1.5 M9 — dev-only STATIC check for the inert server-derived authorization contract.
//
// Pure, offline, secret-free: builds hand-made sample objects against the inert
// M9 types/constants and statically inspects the contract source text. No network,
// no env, no DB, no Supabase, no Firebase, no tokens. Proves the authorization
// contract is representable, server-derived-only, carries no secret/token field,
// keeps the `authorization: null` runtime invariant documented, can represent both
// permission orderings + the future shared-catalog target, and imports nothing
// unsafe.
//
// Run:  npx tsx scripts/diagnostics-authorization-contract-check.ts

import { readFileSync } from 'fs';
import { join } from 'path';
import {
  AUTHORIZATION_CONTRACT_VERSION,
  SCOPE_TYPE_VALUES,
  ACCOUNT_STATUS_VALUES,
  PERMISSION_LEVEL_VALUES,
  TENANT_PERMISSION_ORDERING,
  PLATFORM_PERMISSION_ORDERING,
  SHARED_PERMISSION_CATALOG_TARGET,
  type SharedPermissionCatalogEntry,
} from '../server/platform-identity/authorizationConstants';
import {
  RUNTIME_SESSION_RESOLVE_AUTHORIZATION,
  AUTHORIZATION_DERIVED_BY,
  AUTHORIZATION_FORBIDDEN_FIELDS,
  type ServerDerivedAuthorizationV1,
} from '../server/platform-identity/authorizationContract';

const ROOT = process.cwd();
const CONTRACT_SRC = readFileSync(join(ROOT, 'server/platform-identity/authorizationContract.ts'), 'utf8');
const CONSTANTS_SRC = readFileSync(join(ROOT, 'server/platform-identity/authorizationConstants.ts'), 'utf8');

interface Result { name: string; pass: boolean; detail: string }
const results: Result[] = [];
function check(name: string, pass: boolean, detail = ''): void {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

/** Strip comments so import/secret scans inspect CODE only, not documentation. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** A representative, fully-populated server-derived authorization sample. */
const sample: ServerDerivedAuthorizationV1 = {
  authorizationVersion: AUTHORIZATION_CONTRACT_VERSION,
  userType: 'tenant',
  scope: { scopeType: 'store', tenantId: 'tenant-1', storeId: 'store-1' },
  roles: { platformRoleId: null, tenantRoleId: 'manager' },
  status: { user: 'active', tenant: 'active', store: 'active' },
  entitlements: { batch_labels: true, shipping_sla_optimization: false },
  permissions: { shipping: 'manage', inventory: 'view' },
  subPermissions: { manage_batch_labels: true, override_packing_requirements: false },
  derivedBy: AUTHORIZATION_DERIVED_BY,
};

// 1) Authorization contract version is defined.
check(
  '1 authorization contract version defined (authz.v1)',
  AUTHORIZATION_CONTRACT_VERSION === 'authz.v1' && sample.authorizationVersion === 'authz.v1',
  `version=${AUTHORIZATION_CONTRACT_VERSION}`,
);

// 2) Scope supports platform/tenant/store/none.
{
  const want = ['platform', 'tenant', 'store', 'none'];
  const ok = want.every((s) => (SCOPE_TYPE_VALUES as readonly string[]).includes(s));
  check('2 scope supports platform/tenant/store/none', ok, SCOPE_TYPE_VALUES.join(','));
}

// 3) User/tenant/store status fields are representable.
{
  const ok =
    (ACCOUNT_STATUS_VALUES as readonly string[]).includes(sample.status.user) &&
    sample.status.tenant !== undefined &&
    sample.status.store !== undefined &&
    (ACCOUNT_STATUS_VALUES as readonly string[]).includes('suspended');
  check('3 user/tenant/store status representable', ok, `user=${sample.status.user}`);
}

// 4) Entitlements are boolean server-derived values.
{
  const vals = Object.values(sample.entitlements);
  const ok = vals.length > 0 && vals.every((v) => typeof v === 'boolean');
  check('4 entitlements are booleans (plan/feature gates)', ok, `count=${vals.length}`);
}

// 5) Permissions are effective server-derived levels.
{
  const vals = Object.values(sample.permissions);
  const ok = vals.length > 0 && vals.every((v) => (PERMISSION_LEVEL_VALUES as readonly string[]).includes(v));
  check('5 permissions are effective permission levels', ok, vals.join(','));
}

// 6) Sub-permissions are effective server-derived booleans.
{
  const vals = Object.values(sample.subPermissions);
  const ok = vals.length > 0 && vals.every((v) => typeof v === 'boolean');
  check('6 sub-permissions are effective booleans', ok, `count=${vals.length}`);
}

// 7) Both tenant + platform orderings are representable AND distinct (manage/approve swap).
{
  const sameLen = TENANT_PERMISSION_ORDERING.length === 7 && PLATFORM_PERMISSION_ORDERING.length === 7;
  const tIdx = TENANT_PERMISSION_ORDERING.indexOf('manage') < TENANT_PERMISSION_ORDERING.indexOf('approve');
  const pIdx = PLATFORM_PERMISSION_ORDERING.indexOf('approve') < PLATFORM_PERMISSION_ORDERING.indexOf('manage');
  check(
    '7 both permission orderings representable + distinct (tenant manage<approve; platform approve<manage)',
    sameLen && tIdx && pIdx,
    `tenant[manage<approve]=${tIdx} platform[approve<manage]=${pIdx}`,
  );
}

// 8) Server-derived only — sample carries derivedBy and NO client-authority field.
{
  const keys = new Set(Object.keys(sample));
  const clientAuthority = ['user_metadata', 'userMetadata', 'clientRole', 'assertedRole', 'bodyTenantId', 'bodyPermissions'];
  const leaked = clientAuthority.filter((k) => keys.has(k));
  check(
    '8 server-derived only — has derivedBy, no client-authority field',
    keys.has('derivedBy') && leaked.length === 0,
    leaked.length ? `LEAKED: ${leaked.join(',')}` : 'clean',
  );
}

// 9) `authorization: null` runtime invariant remains (constant + documented).
{
  const documented = /authorization[^.\n]*null/i.test(CONTRACT_SRC) && /DEFERRED|future approved/i.test(CONTRACT_SRC);
  check(
    '9 authorization:null runtime invariant remains (const null + documented)',
    RUNTIME_SESSION_RESOLVE_AUTHORIZATION === null && documented,
    `const=${RUNTIME_SESSION_RESOLVE_AUTHORIZATION} documented=${documented}`,
  );
}

// 10) No raw token/JWT/JWKS/service-role/DB URL/password fields on the DTO.
{
  const keys = new Set(Object.keys(sample));
  const leaked = AUTHORIZATION_FORBIDDEN_FIELDS.filter((f) => keys.has(f));
  check(
    '10 DTO has no token/JWT/JWKS/service-role/DB-URL/password field',
    leaked.length === 0,
    leaked.length ? `LEAKED: ${leaked.join(',')}` : 'none present',
  );
}

// 11) No env/DB/Supabase/Firebase/Express imports in the contract/constants source.
{
  const codeC = stripComments(CONTRACT_SRC);
  const codeK = stripComments(CONSTANTS_SRC);
  // Import-context only: provider NAMES ('supabase'|'firebase') are legitimate
  // string VALUES in the provider-agnostic vocabulary; only a real IMPORT of
  // firebase/@supabase/db/env is forbidden.
  const forbidden = /(process\.env|getDb|from\s+'postgres'|from\s+'express'|from\s+'\.\/db'|from\s+['"][^'"]*@supabase[^'"]*['"]|from\s+['"][^'"]*firebase[^'"]*['"])/;
  const offC = forbidden.test(codeC);
  const offK = forbidden.test(codeK);
  check(
    '11 contract/constants import no env/DB/Supabase/Firebase/Express',
    !offC && !offK,
    offC ? 'contract offender' : offK ? 'constants offender' : 'clean',
  );
}

// 12) Future shared-catalog target is representable.
{
  const entry: SharedPermissionCatalogEntry = {
    key: 'shipping',
    ordering: 'tenant',
    minModuleLevel: null,
    defaultLevel: 'view',
    requiresEntitlements: [],
  };
  const ok = SHARED_PERMISSION_CATALOG_TARGET.status === 'declared_not_built' && entry.key === 'shipping';
  check('12 future shared-catalog target representable', ok, SHARED_PERMISSION_CATALOG_TARGET.status);
}

const failed = results.filter((r) => !r.pass);
console.log(`\n[authorization-contract-check] ${results.length - failed.length}/${results.length} checks passed.`);
if (failed.length) process.exitCode = 1;
