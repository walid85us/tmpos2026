// Phase 1.5 M10 — dev-only STATIC check for the durable authorization SQL migration.
//
// Pure, offline, secret-free: reads the 002 up/down migration SQL as TEXT and
// statically asserts the authorization tables, constraints, indexes, RLS posture,
// and reverse-order rollback. No DB, no network, no env, no Supabase, no Firebase,
// no token. It does NOT apply the migration.
//
// Run:  npx tsx scripts/diagnostics-authorization-schema-check.ts

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

const ROOT = process.cwd();
const MIG_DIR = join(ROOT, 'server', 'platform-identity', 'migrations');
const UP = join(MIG_DIR, '002_authorization_audit_foundation.up.sql');
const DOWN = join(MIG_DIR, '002_authorization_audit_foundation.down.sql');

const upText = existsSync(UP) ? readFileSync(UP, 'utf8') : '';
const downText = existsSync(DOWN) ? readFileSync(DOWN, 'utf8') : '';

interface Result { name: string; pass: boolean; detail: string }
const results: Result[] = [];
function check(name: string, pass: boolean, detail = ''): void {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

/** Strip SQL comments so executable-only scans ignore documentary references. */
function stripSqlComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--.*$/gm, '');
}

const AUTH_TABLES = ['app_user', 'tenant', 'store', 'user_membership', 'tenant_feature_entitlement'];
const createRe = (t: string) => new RegExp(`create table if not exists ${t}\\s*\\(`, 'i');

// 1) up migration exists.
check('1 up migration exists (002_authorization_audit_foundation.up.sql)', upText.length > 0, UP);

// 2) down migration exists.
check('2 down migration exists (002_authorization_audit_foundation.down.sql)', downText.length > 0, DOWN);

// 3) singular authorization tables are created.
{
  const missing = AUTH_TABLES.filter((t) => !createRe(t).test(upText));
  check('3 singular authorization tables created', missing.length === 0, missing.length ? `MISSING: ${missing.join(',')}` : AUTH_TABLES.join(','));
}

// 4) no plural table versions are created.
{
  const plurals = ['app_users', 'tenants', 'stores', 'user_memberships', 'tenant_feature_entitlements'];
  const found = plurals.filter((p) => new RegExp(`create table[^;]*\\b${p}\\b`, 'i').test(upText));
  check('4 no plural table versions created', found.length === 0, found.length ? `PLURAL: ${found.join(',')}` : 'singular only');
}

// 5) pgcrypto extension present.
check('5 pgcrypto extension present', /create extension if not exists "pgcrypto"/i.test(upText));

// 6) UUID PKs use gen_random_uuid() (tenant/store/membership/entitlement/audit).
{
  const n = (upText.match(/primary key default gen_random_uuid\(\)/gi) || []).length;
  check('6 UUID PKs use gen_random_uuid()', n >= 5, `count=${n}`);
}

// 7) app_user FK to platform_identity exists.
check(
  '7 app_user FK to platform_identity(internal_user_id) exists',
  /references platform_identity\s*\(\s*internal_user_id\s*\)/i.test(upText),
);

// 8) operational FKs exist (store→tenant, membership→app_user/tenant/store, entitlement→tenant).
{
  const fkTenant = (upText.match(/references tenant\s*\(\s*tenant_id\s*\)/gi) || []).length; // store, membership, entitlement
  const fkAppUser = /references app_user\s*\(\s*internal_user_id\s*\)/i.test(upText);
  const fkStore = /references store\s*\(\s*store_id\s*\)/i.test(upText);
  check('8 operational FKs exist', fkTenant >= 3 && fkAppUser && fkStore, `tenantFKs=${fkTenant} appUserFK=${fkAppUser} storeFK=${fkStore}`);
}

// 9) expected CHECK constraints exist (account status, plan, entitlement source).
{
  const ok =
    /app_user_status_chk/i.test(upText) &&
    /tenant_status_chk/i.test(upText) &&
    /store_status_chk/i.test(upText) &&
    /tenant_plan_key_chk/i.test(upText) &&
    /user_membership_status_chk/i.test(upText) &&
    /tenant_feature_entitlement_source_chk/i.test(upText);
  check('9 expected CHECK constraints exist (status/plan/source)', ok);
}

// 10) scope consistency CHECK exists.
check('10 scope-consistency CHECK exists', /user_membership_scope_consistency_chk/i.test(upText));

// 11) role/scope CHECK exists with both role families.
{
  const ok =
    /user_membership_role_scope_chk/i.test(upText) &&
    /platform_owner/.test(upText) && /platform_readonly/.test(upText) &&
    /store_owner/.test(upText) && /sales_staff/.test(upText);
  check('11 role/scope CHECK exists (platform + tenant role ids)', ok);
}

// 12) membership duplicate-grant uniqueness exists.
{
  const ok = /user_membership_unique_grant/i.test(upText) && /unique nulls not distinct\s*\(/i.test(upText);
  check('12 membership uniqueness (UNIQUE NULLS NOT DISTINCT) exists', ok);
}

// 13) expected indexes exist.
{
  const want = [
    'idx_app_user_status',
    'idx_store_tenant_id',
    'idx_user_membership_internal_user_id',
    'idx_user_membership_tenant_id',
    'idx_user_membership_store_id',
    'idx_tenant_feature_entitlement_tenant_id',
  ];
  const missing = want.filter((i) => !new RegExp(i, 'i').test(upText));
  check('13 expected authorization indexes exist', missing.length === 0, missing.length ? `MISSING: ${missing.join(',')}` : `${want.length} present`);
}

// 14) RLS enabled on every authorization table.
{
  const missing = AUTH_TABLES.filter((t) => !new RegExp(`alter table ${t} enable row level security`, 'i').test(upText));
  check('14 RLS enabled on every authorization table', missing.length === 0, missing.length ? `MISSING: ${missing.join(',')}` : 'all enabled');
}

// 15) no CREATE POLICY.
check('15 no CREATE POLICY (deny-all posture)', !/create\s+policy/i.test(upText));

// 16) no GRANT ... TO anon.
check('16 no GRANT ... TO anon', !/grant[\s\S]*?\bto\b[^;]*\banon\b/i.test(upText));

// 17) no GRANT ... TO authenticated.
check('17 no GRANT ... TO authenticated', !/grant[\s\S]*?\bto\b[^;]*\bauthenticated\b/i.test(upText));

// 18) explicit REVOKE from public/anon/authenticated for each table.
{
  const missing = AUTH_TABLES.filter(
    (t) => !new RegExp(`revoke all on table ${t} from public, anon, authenticated`, 'i').test(upText),
  );
  check('18 explicit REVOKE (public/anon/authenticated) per table', missing.length === 0, missing.length ? `MISSING: ${missing.join(',')}` : 'all revoked');
}

// 19) down migration drops tables in reverse dependency order.
{
  const order = ['audit_event', 'tenant_feature_entitlement', 'user_membership', 'store', 'tenant', 'app_user'];
  const positions = order.map((t) => downText.search(new RegExp(`drop table if exists ${t}\\b`, 'i')));
  const allFound = positions.every((p) => p >= 0);
  const ascending = positions.every((p, i) => i === 0 || p > positions[i - 1]);
  check('19 down migration drops tables in reverse order', allFound && ascending, positions.join(','));
}

// 20) no migration-application command appears in the executable SQL (comments,
//     which may reference the runner filename, are stripped first).
{
  const appRe = /(\\i\s|psql\s|dblink|copy\s+\w+\s+from\s+program|identity:migrate|supabase-migrate)/i;
  check('20 no migration-application command in executable SQL', !appRe.test(stripSqlComments(upText)) && !appRe.test(stripSqlComments(downText)));
}

const failed = results.filter((r) => !r.pass);
console.log(`\n[authorization-schema-check] ${results.length - failed.length}/${results.length} checks passed.`);
if (failed.length) process.exitCode = 1;
