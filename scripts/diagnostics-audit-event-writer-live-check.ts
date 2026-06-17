// Phase 1.5 M11.3 — LIVE DEV-only diagnostic for the durable audit-event WRITER.
//
// WHAT IT DOES: with explicit DEV gates set, it captures the durable row counts,
// inserts EXACTLY ONE redacted, system/diagnostic audit_event row through the
// sanctioned writer (writeAuditEvent), re-captures the counts, re-queries the row
// by its unique request_id, and PROVES:
//   - audit_event incremented by exactly 1,
//   - every OTHER durable table count is unchanged,
//   - the inserted row is redacted (system actor, scope none, no forbidden data),
//   - metadata is allow-listed + scalar-only + free of forbidden keys/substrings,
//   - the row still exists afterward (nothing deleted).
// It performs NO update/delete and uses NO ad-hoc SQL beyond the single writer
// INSERT and read-only SELECTs of its own row.
//
// SAFETY (binding):
//   - Refuses unless NODE_ENV!=production AND every gate below is set.
//   - Requires NO DEV UID. The actor is the SYSTEM/diagnostic actor (null).
//   - Prints ONLY booleans, counts, decision/scope labels, and safe constants.
//     NEVER prints the UID, email, DB URL, project ref, service-role key, anon key,
//     tokens, JWTs, raw SQL, raw rows, or raw DB errors. DB errors are reduced to
//     their error NAME only.
//   - Applies no migration/seed/rollback. Uses no Supabase MCP. Verifies no token.
//     Imports no Express/frontend/sessionResolve. Wires no route.
//
// Run (DEV shell where SUPABASE_DATABASE_URL exists; inserts ONE durable row):
//   NODE_ENV=development ALLOW_LIVE_AUDIT_WRITER_CHECK=true \
//   CONFIRM_SUPABASE_TARGET=tmpos2026-dev \
//   npx tsx scripts/diagnostics-audit-event-writer-live-check.ts

import { randomUUID } from 'crypto';
import { getDb, closeDb } from '../server/platform-identity/db';
import {
  countDurableAuthorizationRows,
  type SqlExecutor,
  type DurableRowCounts,
} from '../server/platform-identity/authorizationRepository';
import {
  writeAuditEvent,
  buildDiagnosticAuditEvent,
  AUDIT_WRITER_METADATA_ALLOWLIST,
} from '../server/platform-identity/auditEventWriter';
import { AUDIT_FORBIDDEN_FIELDS } from '../server/platform-identity/auditEventContract';

const EXPECTED_TARGET = 'tmpos2026-dev';

interface Result { name: string; pass: boolean; detail: string }
const results: Result[] = [];
function check(name: string, pass: boolean, detail = ''): void {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

/** Reduce any error to a NON-sensitive label (name only — never the message). */
function errName(err: unknown): string {
  return err instanceof Error ? err.name : 'Error';
}

/** Refuse safely (no secret/UID/email/URL) and exit non-zero. */
function refuse(message: string): never {
  console.error(`[audit-writer-live] REFUSED: ${message}`);
  process.exit(1);
}

// Forbidden substrings that must NOT appear anywhere in the serialized inserted
// row (token/JWT/connection-string/key shapes). Safe to list — these are patterns,
// not secrets.
const FORBIDDEN_SUBSTRINGS = [
  'eyJ', // JWT header prefix
  'service_role', 'serviceRole', 'SERVICE_ROLE',
  'anon_key', 'anonKey', 'ANON_KEY',
  'postgres://', 'postgresql://', '.supabase.co', '.supabase.com',
  'accessToken', 'refreshToken', 'password', 'rawJwt', 'jwtPayload',
];

// =============================================================================
// Gates — every gate must hold BEFORE any DB connection is created.
// =============================================================================

function assertGates(): void {
  if (process.env.NODE_ENV === 'production') {
    refuse('NODE_ENV=production — production is hard-blocked. This check is DEV-only.');
  }
  if (process.env.ALLOW_LIVE_AUDIT_WRITER_CHECK !== 'true') {
    refuse('ALLOW_LIVE_AUDIT_WRITER_CHECK must equal "true".');
  }
  if (process.env.CONFIRM_SUPABASE_TARGET !== EXPECTED_TARGET) {
    refuse(`CONFIRM_SUPABASE_TARGET must equal the expected DEV target "${EXPECTED_TARGET}".`);
  }
  if (!process.env.SUPABASE_DATABASE_URL) {
    refuse('SUPABASE_DATABASE_URL is not set. Run in the Replit shell where the secret exists.');
  }

  // Optional defense-in-depth: confirm the DB-derived project ref matches the
  // expected ref WITHOUT printing either value (boolean-only).
  const expectedRef = process.env.EXPECTED_DEV_PROJECT_REF;
  if (expectedRef) {
    const derived = deriveProjectRef(process.env.SUPABASE_DATABASE_URL);
    const matched = derived !== null && derived === expectedRef;
    console.log(`[audit-writer-live] expected dev project ref matched: ${matched}`);
    if (!matched) refuse('the project ref derived from SUPABASE_DATABASE_URL does not match EXPECTED_DEV_PROJECT_REF.');
  }
}

/** Derive a project ref from the DB URL host/username. Never logs the URL/ref. */
function deriveProjectRef(databaseUrl: string): string | null {
  try {
    const u = new URL(databaseUrl);
    const hostM = /^db\.([a-z0-9]+)\.supabase\.(co|com|net)$/i.exec(u.hostname);
    if (hostM) return hostM[1];
    const userM = /^postgres\.([a-z0-9]+)$/i.exec(decodeURIComponent(u.username || ''));
    if (userM) return userM[1];
  } catch {
    /* not a parseable URL — treat as not derivable */
  }
  return null;
}

// =============================================================================
// Main
// =============================================================================

async function main(): Promise<void> {
  assertGates();

  const db = getDb();
  const correlationId = `audit-writer-live-${randomUUID()}`;

  // ---- before counts (committed read) ----
  let before: DurableRowCounts;
  try {
    before = await countDurableAuthorizationRows(db);
  } catch (err) {
    refuse(`could not read baseline row counts (${errName(err)}).`);
  }
  // Informational only — M11.3 does NOT assume audit_event started at 0.
  console.log(`[audit-writer-live] audit_event baseline: ${before.audit_event}`);

  // ---- insert exactly ONE redacted diagnostic row via the sanctioned writer ----
  let written: { eventId: string; requestId: string } | null = null;
  try {
    const event = buildDiagnosticAuditEvent(correlationId);
    written = await writeAuditEvent(event, { executor: db as unknown as SqlExecutor });
  } catch (err) {
    check('W1 writeAuditEvent inserted one row', false, `insert error: ${errName(err)}`);
  }
  check('W1 writeAuditEvent inserted one row', written !== null, written ? 'inserted' : 'failed');
  check('W2 inserted event_id is a UUID', !!written && /^[0-9a-f-]{36}$/i.test(written.eventId), written ? 'uuid' : 'n/a');
  check('W3 inserted request_id matches correlation id', !!written && written.requestId === correlationId, written ? 'match' : 'n/a');

  // ---- after counts + delta proof ----
  let after: DurableRowCounts;
  try {
    after = await countDurableAuthorizationRows(db);
  } catch (err) {
    refuse(`could not read post-insert row counts (${errName(err)}).`);
  }

  check('D1 audit_event incremented by exactly 1', after.audit_event === before.audit_event + 1, `${before.audit_event}->${after.audit_event}`);

  const UNCHANGED: (keyof DurableRowCounts)[] = [
    'app_user', 'tenant', 'store', 'user_membership', 'tenant_feature_entitlement',
  ];
  const unchanged = UNCHANGED.every((t) => before[t] === after[t]);
  check('D2 all OTHER durable row counts unchanged', unchanged, UNCHANGED.map((t) => `${t}:${before[t]}->${after[t]}`).join(' '));

  // ---- re-query the inserted row by request_id (read-only, parameterized) ----
  let row: Record<string, unknown> | null = null;
  try {
    const rows = await db`
      select
        event_id, audit_version, request_id, trace_id,
        actor_internal_user_id, actor_auth_provider, on_behalf_of_internal_user_id,
        scope_type, tenant_id, store_id,
        action_id, required_permission, decision, reason_code,
        human_readable_reason, result_status, source_of_truth, evaluated_by,
        evidence_level, metadata
      from audit_event
      where request_id = ${correlationId}
      limit 1
    `;
    row = rows.length ? (rows[0] as Record<string, unknown>) : null;
  } catch (err) {
    check('R1 inserted row re-queried by request_id', false, `query error: ${errName(err)}`);
  }
  check('R1 inserted row re-queried by request_id', row !== null, row ? 'found' : 'not found');

  if (row) {
    // ---- redaction assertions (system/diagnostic actor; no leaked identity) ----
    check('R2 actor_internal_user_id is null', row.actor_internal_user_id === null, `${row.actor_internal_user_id}`);
    check('R3 actor_auth_provider is null', row.actor_auth_provider === null, `${row.actor_auth_provider}`);
    check('R4 on_behalf_of_internal_user_id is null', row.on_behalf_of_internal_user_id === null, `${row.on_behalf_of_internal_user_id}`);
    check('R5 scope_type is none', row.scope_type === 'none', `${row.scope_type}`);
    check('R6 tenant_id is null', row.tenant_id === null, `${row.tenant_id}`);
    check('R7 store_id is null', row.store_id === null, `${row.store_id}`);
    check('R8 decision is not_applicable', row.decision === 'not_applicable', `${row.decision}`);
    check('R9 result_status is succeeded', row.result_status === 'succeeded', `${row.result_status}`);
    check('R10 evidence_level is durable_compliance_event', row.evidence_level === 'durable_compliance_event', `${row.evidence_level}`);
    check('R11 source_of_truth is system_diagnostic', row.source_of_truth === 'system_diagnostic', `${row.source_of_truth}`);
    check('R12 action_id is audit.writer.live_check', row.action_id === 'audit.writer.live_check', `${row.action_id}`);

    // ---- metadata: allow-listed, scalar-only, no forbidden keys ----
    const metaRaw = row.metadata;
    const meta: Record<string, unknown> =
      metaRaw && typeof metaRaw === 'object' ? (metaRaw as Record<string, unknown>) : {};
    const metaKeys = Object.keys(meta);
    check('M1 metadata keys all allow-listed', metaKeys.every((k) => AUDIT_WRITER_METADATA_ALLOWLIST.includes(k)), metaKeys.join(',') || 'none');
    check('M2 metadata is scalar-only', Object.values(meta).every((v) => v === null || ['string', 'number', 'boolean'].includes(typeof v)), 'scalar-only');
    const forbiddenKeyHit = metaKeys.some((k) => (AUDIT_FORBIDDEN_FIELDS as readonly string[]).includes(k));
    check('M3 metadata has no forbidden keys', !forbiddenKeyHit, forbiddenKeyHit ? 'forbidden key present' : 'none');

    // ---- whole-row forbidden-substring scan (token/JWT/URL/key shapes) ----
    const rowJson = JSON.stringify(row);
    const hitSubstrings = FORBIDDEN_SUBSTRINGS.filter((s) => rowJson.includes(s));
    check('S1 inserted row contains no forbidden substrings', hitSubstrings.length === 0, hitSubstrings.length ? `${hitSubstrings.length} hit(s)` : 'none');

    // Defense-in-depth: the owner-supplied DEV UID (if present in env) must NOT
    // appear in the row. Never printed — boolean only.
    const devUid = process.env.AUTHZ_CHECK_AUTH_PROVIDER_UID;
    const uidLeak = !!devUid && rowJson.includes(devUid);
    check('S2 inserted row does not contain the DEV UID', !uidLeak, uidLeak ? 'LEAK' : 'absent');
  }

  // ---- the row must still exist afterward (nothing deleted) ----
  let stillThere = false;
  try {
    const [c] = await db`select count(*)::int as n from audit_event where request_id = ${correlationId}`;
    stillThere = Number((c as { n: number }).n) === 1;
  } catch (err) {
    check('P1 inserted row persists (not deleted)', false, `query error: ${errName(err)}`);
  }
  check('P1 inserted row persists (not deleted)', stillThere, stillThere ? 'present' : 'missing');

  finish();
}

function finish(): void {
  const failed = results.filter((r) => !r.pass);
  console.log(`\n[audit-writer-live] ${results.length - failed.length}/${results.length} checks passed.`);
  if (failed.length) process.exitCode = 1;
}

main()
  .catch((err) => {
    console.error('[audit-writer-live] harness error:', errName(err));
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDb().catch(() => { /* ignore close errors */ });
  });
