// Phase 1.5 M10 — dev-only STATIC check for the durable APPEND-ONLY audit table.
//
// Pure, offline, secret-free: reads the 002 up/down migration SQL as TEXT and
// statically asserts the audit_event table maps DurableAuditEventV1, is decoupled
// (no FKs), carries no forbidden secret columns, enforces a forbidden-key + flatness
// metadata CHECK, is append-only (reject-update/delete trigger, no updated_at), has
// RLS + revokes, the audit indexes, and a reverse-order rollback. No DB, no network,
// no env, no Supabase, no Firebase, no token. It does NOT apply the migration.
//
// Run:  npx tsx scripts/diagnostics-audit-schema-check.ts

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

const ROOT = process.cwd();
const MIG_DIR = join(ROOT, 'server', 'platform-identity', 'migrations');
const UP = join(MIG_DIR, '002_authorization_audit_foundation.up.sql');
const DOWN = join(MIG_DIR, '002_authorization_audit_foundation.down.sql');

const upText = existsSync(UP) ? readFileSync(UP, 'utf8') : '';
const downText = existsSync(DOWN) ? readFileSync(DOWN, 'utf8') : '';

// Extract just the audit_event CREATE TABLE block so column/FK scans don't pick up
// other tables. Captures from the create line to its closing ");".
const blockMatch = upText.match(/create table if not exists audit_event \(([\s\S]*?)\n\);/i);
const auditBlock = blockMatch ? blockMatch[1] : '';

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

// 1) audit_event table exists.
check('1 audit_event table exists', auditBlock.length > 0);

// 2) all DurableAuditEventV1 columns are mapped (snake_case).
{
  const cols = [
    'event_id', 'audit_version', 'request_id', 'trace_id', 'occurred_at',
    'actor_internal_user_id', 'actor_auth_provider', 'on_behalf_of_internal_user_id',
    'scope_type', 'tenant_id', 'store_id', 'action_id', 'required_permission',
    'decision', 'reason_code', 'human_readable_reason', 'result_status',
    'source_of_truth', 'evaluated_by', 'evidence_level', 'metadata',
  ];
  const missing = cols.filter((c) => !new RegExp(`\\b${c}\\b`).test(auditBlock));
  check('2 all DurableAuditEventV1 columns mapped', missing.length === 0, missing.length ? `MISSING: ${missing.join(',')}` : `${cols.length} columns`);
}

// 3) no foreign keys declared on audit_event (decoupled / append-only).
check('3 audit_event has NO foreign keys (decoupled)', auditBlock.length > 0 && !/references/i.test(auditBlock));

// 4) no forbidden secret columns exist on audit_event.
{
  const forbidden = [
    'access_token', 'refresh_token', 'raw_jwt', 'jwt_payload', 'jwks',
    'service_role_key', 'database_url', 'connection_string', 'password',
    'raw_db_error', 'pan', 'card_number', 'provider_secret',
  ];
  // A "column" = name followed by a SQL type. The forbidden-key CHECK array uses
  // quoted camelCase strings (not followed by a type), so it never matches here.
  const typeRe = '(text|uuid|jsonb|boolean|timestamptz|int|integer|numeric|date|bigint|smallint)';
  const leaked = forbidden.filter((c) => new RegExp(`\\b${c}\\s+${typeRe}\\b`, 'i').test(auditBlock));
  check('4 no forbidden secret columns on audit_event', leaked.length === 0, leaked.length ? `LEAKED: ${leaked.join(',')}` : 'none present');
}

// 5) metadata jsonb exists with default '{}'.
check("5 metadata jsonb exists with default '{}'", /metadata\s+jsonb\s+not null default '\{\}'::jsonb/i.test(auditBlock));

// 6) forbidden top-level metadata keys are checked.
{
  const ok =
    /audit_event_metadata_no_forbidden_keys_chk/i.test(upText) &&
    /metadata \?\| array\[/i.test(upText) &&
    /'accessToken'/.test(upText) && /'serviceRoleKey'/.test(upText) &&
    /'rawDbError'/.test(upText) && /'providerSecret'/.test(upText);
  check('6 forbidden top-level metadata keys are checked', ok);
}

// 7) metadata object + flatness CHECK exists.
{
  const ok =
    /audit_event_metadata_object_chk/i.test(upText) &&
    /jsonb_typeof\(metadata\) = 'object'/i.test(upText) &&
    /audit_event_metadata_flat_chk/i.test(upText) &&
    /audit_metadata_is_flat\(metadata\)/i.test(upText);
  check('7 metadata object + flatness CHECK exists', ok);
}

// 8) append-only reject trigger + function exist.
{
  const ok =
    /create or replace function reject_audit_event_mutation\(\)/i.test(upText) &&
    /raise exception/i.test(upText) &&
    /create trigger trg_audit_event_reject_mutation/i.test(upText) &&
    /before update or delete on audit_event/i.test(upText);
  check('8 append-only reject trigger + function exist', ok);
}

// 9) no updated_at on audit_event (no column, no trigger).
{
  const noColumn = !/\bupdated_at\b/i.test(auditBlock);
  const noTrigger = !/trg_audit_event_updated_at/i.test(upText);
  check('9 no updated_at on audit_event (immutable)', noColumn && noTrigger, `noColumn=${noColumn} noTrigger=${noTrigger}`);
}

// 10) RLS enabled on audit_event.
check('10 RLS enabled on audit_event', /alter table audit_event enable row level security/i.test(upText));

// 11) explicit REVOKE from public/anon/authenticated.
check('11 explicit REVOKE on audit_event (public/anon/authenticated)', /revoke all on table audit_event from public, anon, authenticated/i.test(upText));

// 12) no CREATE POLICY anywhere in the up migration.
check('12 no CREATE POLICY (deny-all posture)', !/create\s+policy/i.test(upText));

// 13) audit indexes exist.
{
  const want = [
    'idx_audit_event_actor_occurred',
    'idx_audit_event_tenant_occurred',
    'idx_audit_event_store_occurred',
    'idx_audit_event_action_id',
    'idx_audit_event_occurred_at',
    'idx_audit_event_request_id',
  ];
  const missing = want.filter((i) => !new RegExp(i, 'i').test(upText));
  check('13 audit lookup indexes exist', missing.length === 0, missing.length ? `MISSING: ${missing.join(',')}` : `${want.length} present`);
}

// 14) down migration drops audit trigger, function, and table.
{
  const ok =
    /drop trigger if exists trg_audit_event_reject_mutation on audit_event/i.test(downText) &&
    /drop function if exists reject_audit_event_mutation\(\)/i.test(downText) &&
    /drop table if exists audit_event\b/i.test(downText);
  check('14 down migration drops audit trigger/function/table', ok);
}

// 15) no migration-application command appears in the executable SQL (comments,
//     which may reference the runner filename, are stripped first).
{
  const appRe = /(\\i\s|psql\s|dblink|copy\s+\w+\s+from\s+program|identity:migrate|supabase-migrate)/i;
  check('15 no migration-application command in executable SQL', !appRe.test(stripSqlComments(upText)) && !appRe.test(stripSqlComments(downText)));
}

const failed = results.filter((r) => !r.pass);
console.log(`\n[audit-schema-check] ${results.length - failed.length}/${results.length} checks passed.`);
if (failed.length) process.exitCode = 1;
