// Phase 1.5 M11.3 — OFFLINE static check for the durable audit-event WRITER + its
// live diagnostic.
//
// PURE / OFFLINE: never connects to Postgres, runs no SQL, applies no migration or
// seed, makes no network call, uses no Supabase/Firebase/MCP. It reads the M11.3
// source files as TEXT and asserts their safety invariants, plus runs ONE in-memory
// (DB-free) shape/enum/allow-list test of buildAuthorizationDecisionAuditEvent.
//
// IMPORTANT: forbidden mutation words legitimately appear in the writer's
// DOCUMENTATION comments ("No UPDATE/DELETE …"). The mutation scan therefore runs
// against COMMENT-STRIPPED executable code only — it must not trip on prose.
//
// Run:  npx tsx scripts/diagnostics-audit-event-writer-static-check.ts

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import {
  buildAuthorizationDecisionAuditEvent,
  sanitizeAuditMetadata,
  AUDIT_WRITER_METADATA_ALLOWLIST,
} from '../server/platform-identity/auditEventWriter';

const ROOT = process.cwd();
const WRITER = join(ROOT, 'server', 'platform-identity', 'auditEventWriter.ts');
const STATIC = join(ROOT, 'scripts', 'diagnostics-audit-event-writer-static-check.ts');
const LIVE = join(ROOT, 'scripts', 'diagnostics-audit-event-writer-live-check.ts');
const SESSION_RESOLVE = join(ROOT, 'server', 'platform-identity', 'sessionResolve.ts');

const read = (p: string): string => (existsSync(p) ? readFileSync(p, 'utf8') : '');
const writerSrc = read(WRITER);
const liveSrc = read(LIVE);
const sessionSrc = read(SESSION_RESOLVE);

interface Result { name: string; pass: boolean; detail: string }
const results: Result[] = [];
function check(name: string, pass: boolean, detail = ''): void {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

/** Strip // and block comments so a scan sees only executable code (not the
 *  module's own "no update/delete" documentation). */
function stripTsComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

const writerCode = stripTsComments(writerSrc);
const liveCode = stripTsComments(liveSrc);

// =============================================================================
// Presence
// =============================================================================

check('C1 auditEventWriter.ts exists', writerSrc.length > 0, WRITER);
check('C2 static check exists', read(STATIC).length > 0, STATIC);
check('C3 live diagnostic exists', liveSrc.length > 0, LIVE);

// =============================================================================
// Writer — imports getDb + reuses the audit-event contract
// =============================================================================

const writerImports = [...writerCode.matchAll(/from '([^']+)'/g)].map((m) => m[1]);
check('C4 writer imports getDb from ./db', /from '\.\/db'/.test(writerCode) && /\bgetDb\b/.test(writerCode), writerImports.join(', '));
check(
  'C5 writer reuses the audit-event contract',
  /from '\.\/auditEventContract'/.test(writerCode) &&
    /\bAUDIT_FORBIDDEN_FIELDS\b/.test(writerCode) &&
    /\bDurableAuditEventV1\b/.test(writerCode),
  'auditEventContract reused',
);

// =============================================================================
// Writer — INSERT-only into audit_event; NO other mutation
// =============================================================================

check('C6 writer INSERTs into audit_event', /insert\s+into\s+audit_event\b/i.test(writerCode), 'insert into audit_event present');

// Every executable INSERT must target audit_event (no other insert target).
const insertTargets = [...writerCode.matchAll(/insert\s+into\s+(\w+)/gi)].map((m) => m[1].toLowerCase());
const nonAuditInserts = insertTargets.filter((t) => t !== 'audit_event');
check('C7 every INSERT targets audit_event only', nonAuditInserts.length === 0, nonAuditInserts.join(',') || `targets=[${insertTargets.join(',')}]`);

// No UPDATE/DELETE/UPSERT/ON CONFLICT/ALTER/DROP/TRUNCATE in executable code.
const FORBIDDEN_MUTATIONS: [string, RegExp][] = [
  ['update', /\bupdate\b/i],
  ['delete', /\bdelete\b/i],
  ['upsert', /\bupsert\b/i],
  ['on conflict', /\bon\s+conflict\b/i],
  ['alter', /\balter\b/i],
  ['drop', /\bdrop\b/i],
  ['truncate', /\btruncate\b/i],
];
const writerMutations = FORBIDDEN_MUTATIONS.filter(([, re]) => re.test(writerCode)).map(([l]) => l);
check('C8 writer executable code has NO update/delete/upsert/alter/drop/truncate', writerMutations.length === 0, writerMutations.join(',') || 'none');

check('C9 writer has NO sql.unsafe', !/\.unsafe\b/i.test(writerCode), 'no .unsafe');
check('C10 writer has NO string-concatenated/dynamic SQL', !/sql\s*\+/i.test(writerCode) && !/\+\s*['"`]\s*(insert|select|update|delete)/i.test(writerCode), 'no dynamic concat');

// =============================================================================
// Writer — exports the required surface; exposes NO update/delete function
// =============================================================================

const REQUIRED_EXPORTS = [
  'sanitizeAuditMetadata',
  'validateAuditEventInput',
  'buildDiagnosticAuditEvent',
  'buildAuthorizationDecisionAuditEvent',
  'writeAuditEvent',
];
const missingExports = REQUIRED_EXPORTS.filter((e) => !new RegExp(`export\\s+(async\\s+)?function\\s+${e}\\b`).test(writerCode));
check('C11 writer exports all required functions', missingExports.length === 0, missingExports.length ? `MISSING: ${missingExports.join(',')}` : REQUIRED_EXPORTS.join(','));

check('C12 writer has an explicit metadata allow-list', /AUDIT_WRITER_METADATA_ALLOWLIST/.test(writerCode), 'allow-list present');

// No exported updateX/deleteX mutation helpers.
const mutationFns = [...writerCode.matchAll(/export\s+(?:async\s+)?function\s+(\w+)/g)]
  .map((m) => m[1])
  .filter((n) => /^(update|delete|remove|destroy|purge|upsert)/i.test(n));
check('C13 writer exposes NO update/delete function', mutationFns.length === 0, mutationFns.join(',') || 'none');

// =============================================================================
// Writer — isolation from runtime / frontend
// =============================================================================

check('C14 writer does NOT import Express', !writerImports.includes('express'), writerImports.join(', '));
check('C15 writer does NOT import sessionResolve', !writerImports.some((i) => /sessionResolve/.test(i)), 'ok');
check('C16 writer does NOT import frontend (src/)', !writerImports.some((i) => /(^|\/)src\//.test(i) || /\.\.\/\.\.\/src/.test(i)), 'ok');
check('C17 writer registers no route', !/\b(app|router)\.(get|post|put|patch|delete|use)\s*\(/.test(writerCode), 'no route registration');
check('C18 writer references no Supabase MCP', !/\bmcp\b/i.test(writerCode), 'no mcp');

// No migration/seed/rollback execution anywhere in M11.3 code.
const artifacts = `${writerCode}\n${liveCode}`;
const MIGRATION_EXEC: [string, RegExp][] = [
  ['supabase-migrate', /supabase-migrate/i],
  ['ALLOW_SUPABASE_MIGRATION_APPLY', /ALLOW_SUPABASE_MIGRATION_APPLY/],
  ['.up.sql', /\.up\.sql/i],
  ['.down.sql', /\.down\.sql/i],
  ['--apply', /--apply/],
];
const migrationHits = MIGRATION_EXEC.filter(([, re]) => re.test(artifacts)).map(([l]) => l);
check('C19 no migration/seed/rollback execution in M11.3 code', migrationHits.length === 0, migrationHits.join(',') || 'none');

// =============================================================================
// Writer NOT imported directly by /auth/session/resolve (M11.5 wires only the
// M11.4 service); flag-disabled route path returns authorization: null.
// =============================================================================

check('C20 sessionResolve does NOT import the writer directly', !/auditEventWriter/.test(sessionSrc), 'not wired');
check(
  'C21 flag-disabled /auth/session/resolve path returns authorization: null',
  /authorization:\s*null/.test(sessionSrc) && /isLiveSessionAuthorizationEnabled/.test(sessionSrc),
  'null default + live-flag gate present',
);

// =============================================================================
// Writer — no UID/email/secret printing (no console output at all)
// =============================================================================

check('C22 writer prints nothing (no console.*)', !/console\.(log|error|warn|info|debug)\s*\(/.test(writerCode), 'no console output');

// =============================================================================
// Live diagnostic — required DEV gates + production block
// =============================================================================

const GATES = [
  'ALLOW_LIVE_AUDIT_WRITER_CHECK',
  'CONFIRM_SUPABASE_TARGET',
  'SUPABASE_DATABASE_URL',
];
const missingGates = GATES.filter((g) => !liveSrc.includes(g));
check('C23 live diagnostic enforces all required gates', missingGates.length === 0, missingGates.length ? `MISSING: ${missingGates.join(',')}` : GATES.join(','));
check('C24 live diagnostic blocks production', /NODE_ENV\s*===\s*'production'/.test(liveSrc), 'NODE_ENV production block present');
check('C25 live diagnostic uses countDurableAuthorizationRows', /countDurableAuthorizationRows/.test(liveSrc), 'reuses count helper');
check('C26 live diagnostic calls writeAuditEvent', /writeAuditEvent\s*\(/.test(liveSrc), 'writes via writer');

// Live diagnostic must not print UID/email/secret.
const PRINT_FORBIDDEN = [
  'authProviderUid', 'AUTH_PROVIDER_UID', '.email', 'databaseUrl', 'DATABASE_URL',
  'SERVICE_ROLE', 'serviceRole', 'ANON_KEY', 'anonKey', 'rawJwt', 'accessToken',
  'projectRef', 'PROJECT_REF',
];
const consoleLines = liveSrc.split('\n').filter((l) => /console\.(log|error|warn)\s*\(/.test(l));
const leakyLines = consoleLines.filter((l) => PRINT_FORBIDDEN.some((f) => l.includes(f)));
check('C27 live diagnostic prints no UID/email/secret/URL', leakyLines.length === 0, leakyLines.length ? `${leakyLines.length} suspicious console line(s)` : 'none');

// Live diagnostic isolation.
const liveImports = [...liveCode.matchAll(/from '([^']+)'/g)].map((m) => m[1]);
check('C28 live diagnostic does NOT import Express', !liveImports.includes('express'), liveImports.join(', '));
check('C29 live diagnostic does NOT import sessionResolve', !liveImports.some((i) => /sessionResolve/.test(i)), 'ok');
check('C30 live diagnostic does NOT import frontend (src/)', !liveImports.some((i) => /(^|\/)src\//.test(i)), 'ok');

// =============================================================================
// In-memory (DB-free) builder test — shape / enum / allow-list / redaction
// =============================================================================

const built = buildAuthorizationDecisionAuditEvent({
  requestId: 'req-static-check',
  actorInternalUserId: null,
  actorAuthProvider: null,
  scopeType: 'tenant',
  tenantId: '11111111-1111-1111-1111-111111111111',
  storeId: null,
  actionId: 'tenant.feature.view',
  requiredPermission: 'view',
  decision: 'allow',
  reasonCode: 'verified_entitlement',
  humanReadableReason: 'allowed by entitlement',
  resultStatus: 'succeeded',
  // forbidden + non-allow-listed + non-scalar keys MUST all be stripped:
  metadata: {
    featureKey: 'pickup_requests',
    accessToken: 'should-be-stripped',
    serviceRoleKey: 'should-be-stripped',
    nested: { x: 1 },
    arr: [1, 2, 3],
    randomKey: 'should-be-stripped',
  } as Record<string, unknown>,
});

check('C31 builder stamps durable evidence level', built.evidenceLevel === 'durable_compliance_event', built.evidenceLevel);
check('C32 builder stamps resolver source of truth', built.sourceOfTruth === 'server_authorization_resolver', built.sourceOfTruth);
const metaKeys = Object.keys(built.metadata ?? {});
check('C33 builder metadata keys all allow-listed', metaKeys.every((k) => AUDIT_WRITER_METADATA_ALLOWLIST.includes(k)), metaKeys.join(',') || 'none');
check('C34 builder metadata is scalar-only', Object.values(built.metadata ?? {}).every((v) => v === null || ['string', 'number', 'boolean'].includes(typeof v)), 'scalar-only');
check('C35 builder strips forbidden keys', !('accessToken' in (built.metadata ?? {})) && !('serviceRoleKey' in (built.metadata ?? {})), 'forbidden stripped');
check('C36 builder strips non-allow-listed keys', !('randomKey' in (built.metadata ?? {})) && !('nested' in (built.metadata ?? {})) && !('arr' in (built.metadata ?? {})), 'non-allow-listed stripped');
check('C37 builder keeps the one allow-listed scalar', built.metadata?.featureKey === 'pickup_requests', `featureKey=${built.metadata?.featureKey}`);

// sanitizeAuditMetadata direct test.
const san = sanitizeAuditMetadata({ httpStatus: 200, password: 'x', deep: { a: 1 } } as Record<string, unknown>);
check('C38 sanitizeAuditMetadata keeps allow-listed scalar, strips forbidden/non-scalar', san.httpStatus === 200 && !('password' in san) && !('deep' in san), JSON.stringify(san));

const failed = results.filter((r) => !r.pass);
console.log(`\n[audit-writer-static-check] ${results.length - failed.length}/${results.length} checks passed.`);
if (failed.length) process.exitCode = 1;
