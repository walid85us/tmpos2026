// Phase 1.5 M9 — dev-only STATIC check for the inert durable audit-event contract.
//
// Pure, offline, secret-free: builds hand-made sample events against the inert M9
// types/constants and statically inspects the contract source text. No network,
// no env, no DB, no Supabase, no Firebase, no tokens. Proves the audit event is
// representable, distinguishes advisory vs durable evidence, documents append-only
// + fail-closed intent, uses the app-owned internal_user_id (never the raw
// provider uid), enforces a never-capture list, keeps metadata allow-listed, and
// imports nothing unsafe.
//
// Run:  npx tsx scripts/diagnostics-audit-event-contract-check.ts

import { readFileSync } from 'fs';
import { join } from 'path';
import {
  AUDIT_CONTRACT_VERSION,
  EVIDENCE_LEVELS,
} from '../server/platform-identity/authorizationConstants';
import {
  AUDIT_EVENT_EVALUATED_BY,
  AUDIT_FORBIDDEN_FIELDS,
  AUDIT_METADATA_ALLOWLIST,
  AUDIT_WRITE_FAILURE_STRATEGY,
  AUDIT_TABLE_INTENT,
  type DurableAuditEventV1,
} from '../server/platform-identity/auditEventContract';

const ROOT = process.cwd();
const AUDIT_SRC = readFileSync(join(ROOT, 'server/platform-identity/auditEventContract.ts'), 'utf8');

interface Result { name: string; pass: boolean; detail: string }
const results: Result[] = [];
function check(name: string, pass: boolean, detail = ''): void {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** A representative, fully-populated durable audit event sample. */
const sample: DurableAuditEventV1 = {
  auditVersion: AUDIT_CONTRACT_VERSION,
  eventId: 'evt-uuid',
  requestId: 'req-uuid',
  traceId: 'trace-1',
  occurredAt: '2026-06-15T00:00:00.000Z',
  actorInternalUserId: 'iuid-123', // app-owned UUID, NOT the raw provider uid
  actorAuthProvider: 'supabase',
  onBehalfOfInternalUserId: null,
  scopeType: 'store',
  tenantId: 'tenant-1',
  storeId: 'store-1',
  actionId: 'tenant.shipping.purchase-label',
  requiredPermission: 'shipping:manage',
  decision: 'allow',
  reasonCode: 'allowed_permission_met',
  humanReadableReason: 'Actor meets shipping:manage.',
  resultStatus: 'succeeded',
  sourceOfTruth: 'supabase_verified_token',
  evaluatedBy: AUDIT_EVENT_EVALUATED_BY,
  evidenceLevel: 'durable_compliance_event',
  metadata: { route: '/api/shipping/purchase-label', httpStatus: 200 },
};

// 1) Audit contract version is defined.
check(
  '1 audit contract version defined (audit.v1)',
  AUDIT_CONTRACT_VERSION === 'audit.v1' && sample.auditVersion === 'audit.v1',
  `version=${AUDIT_CONTRACT_VERSION}`,
);

// 2) Evidence levels distinguish advisory dev log vs durable compliance event.
{
  const ok =
    (EVIDENCE_LEVELS as readonly string[]).includes('dev_sidecar_log_advisory') &&
    (EVIDENCE_LEVELS as readonly string[]).includes('durable_compliance_event');
  check('2 evidence levels distinguish advisory vs durable compliance', ok, EVIDENCE_LEVELS.join(','));
}

// 3) Required fields are representable.
{
  const required = [
    'eventId', 'requestId', 'traceId', 'occurredAt', 'actorInternalUserId',
    'scopeType', 'actionId', 'decision', 'reasonCode', 'resultStatus',
    'sourceOfTruth', 'evaluatedBy', 'evidenceLevel',
  ];
  const keys = new Set(Object.keys(sample));
  const missing = required.filter((k) => !keys.has(k));
  check('3 required audit fields representable', missing.length === 0, missing.length ? `MISSING: ${missing.join(',')}` : 'all present');
}

// 4) Append-only intent is documented.
{
  const ok =
    AUDIT_TABLE_INTENT.appendOnly === true &&
    (AUDIT_TABLE_INTENT.forbiddenOps as readonly string[]).includes('update') &&
    (AUDIT_TABLE_INTENT.forbiddenOps as readonly string[]).includes('delete') &&
    /append-only/i.test(AUDIT_SRC);
  check('4 append-only intent documented (no update/delete)', ok, `forbidden=${AUDIT_TABLE_INTENT.forbiddenOps.join(',')}`);
}

// 5) Audit actor uses app-owned internal_user_id, not raw provider uid.
{
  const keys = new Set(Object.keys(sample));
  const ok =
    keys.has('actorInternalUserId') &&
    !keys.has('authProviderUid') &&
    !keys.has('providerUid') &&
    !keys.has('rawProviderUid') &&
    /NEVER the raw provider uid/i.test(AUDIT_SRC);
  check('5 actor is app-owned internal_user_id (not raw provider uid)', ok, 'actorInternalUserId only');
}

// 6) Forbidden never-capture list includes token/JWT/JWKS/service-role/DB-URL/password/raw DB error.
{
  const must = ['accessToken', 'refreshToken', 'rawJwt', 'jwtPayload', 'jwks', 'serviceRoleKey', 'databaseUrl', 'connectionString', 'password', 'rawDbError'];
  const missing = must.filter((f) => !(AUDIT_FORBIDDEN_FIELDS as readonly string[]).includes(f));
  check('6 never-capture list covers tokens/JWT/JWKS/service-role/DB-URL/password/raw DB error', missing.length === 0, missing.length ? `MISSING: ${missing.join(',')}` : 'complete');
}

// 7) Metadata is allow-listed / redacted only.
{
  const metaKeys = Object.keys(sample.metadata);
  const ok = metaKeys.every((k) => AUDIT_METADATA_ALLOWLIST.includes(k)) && AUDIT_METADATA_ALLOWLIST.length > 0;
  check('7 metadata is allow-listed (sample keys ⊆ allow-list)', ok, metaKeys.join(','));
}

// 8) No raw secret/token field exists on the DTO.
{
  const keys = new Set(Object.keys(sample));
  const leaked = AUDIT_FORBIDDEN_FIELDS.filter((f) => keys.has(f));
  // also ensure metadata carries no forbidden key
  const metaLeaked = AUDIT_FORBIDDEN_FIELDS.filter((f) => Object.prototype.hasOwnProperty.call(sample.metadata, f));
  check('8 DTO + metadata carry no forbidden secret/token field', leaked.length === 0 && metaLeaked.length === 0, leaked.concat(metaLeaked).join(',') || 'none present');
}

// 9) No env/DB/Supabase/Firebase imports in the audit contract source.
{
  const code = stripComments(AUDIT_SRC);
  // Import-context only (provider NAMES are legitimate string values).
  const forbidden = /(process\.env|getDb|from\s+'postgres'|from\s+'express'|from\s+'\.\/db'|from\s+['"][^'"]*@supabase[^'"]*['"]|from\s+['"][^'"]*firebase[^'"]*['"])/;
  check('9 audit contract imports no env/DB/Supabase/Firebase/Express', !forbidden.test(code), forbidden.test(code) ? 'offender found' : 'clean');
}

// 10) Durable audit write-failure fail-closed strategy is documented.
{
  const ok =
    AUDIT_WRITE_FAILURE_STRATEGY.default === 'fail_closed' &&
    AUDIT_WRITE_FAILURE_STRATEGY.sensitiveOrStateChanging === 'fail_closed' &&
    /FAIL-CLOSED/i.test(AUDIT_SRC);
  check('10 durable audit write-failure fail-closed strategy documented', ok, `default=${AUDIT_WRITE_FAILURE_STRATEGY.default}`);
}

const failed = results.filter((r) => !r.pass);
console.log(`\n[audit-event-contract-check] ${results.length - failed.length}/${results.length} checks passed.`);
if (failed.length) process.exitCode = 1;
