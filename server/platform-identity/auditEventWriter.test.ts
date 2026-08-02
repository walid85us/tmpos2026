// Phase 4.0 M3 S3 — the durable audit writer's INSERT-only contract and scope truth table.
//
// DATABASE-FREE. Every statement the writer emits is captured by an in-memory executor that
// records the template strings and the interpolated values separately, so what is asserted is
// the SQL the writer really builds — not a paraphrase of it, and not a source-code pattern
// that a refactor could satisfy while changing the statement.
//
// WHAT THIS SUITE CANNOT PROVE, AND DOES NOT CLAIM: that PostgreSQL accepts the statement, or
// that an INSERT-only principal can run it. A fake executor accepts anything. The live proof —
// effective privileges, SQLSTATE 42501 for `RETURNING`, the frozen CHECK, the append-only
// trigger — is tests/db/auditAtomicity.integration.test.mjs against real disposable PostgreSQL.
// This suite proves the half a database cannot: that the writer refuses malformed input BEFORE
// any executor is touched.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  writeAuditEvent,
  validateAuditEventInput,
  sanitizeAuditMetadata,
  buildDiagnosticAuditEvent,
  buildAuthorizationDecisionAuditEvent,
  AuditEventValidationError,
  AUDIT_WRITER_METADATA_ALLOWLIST,
  type AuditEventWriteInput,
} from './auditEventWriter';
import { AUDIT_CONTRACT_VERSION, SCOPE_TYPE_VALUES } from './authorizationConstants';
import { AUDIT_FORBIDDEN_FIELDS } from './auditEventContract';
import type { SqlExecutor } from './authorizationRepository';

const HERE = dirname(fileURLToPath(import.meta.url));
const WRITER_SRC = readFileSync(join(HERE, 'auditEventWriter.ts'), 'utf8');

/** Strip line and block comments so a prose mention is never mistaken for code. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

interface Captured {
  strings: readonly string[];
  values: unknown[];
  sql: string;
}

/** A recording executor. Never a database: it proves what was SENT, never what was accepted. */
function recorder(behaviour: { fail?: Error; defer?: boolean } = {}) {
  const calls: Captured[] = [];
  let release: (() => void) | null = null;
  const gate = behaviour.defer ? new Promise<void>((r) => { release = r; }) : null;

  const executor = Object.assign(
    async (strings: TemplateStringsArray, ...values: unknown[]) => {
      calls.push({ strings: [...strings], values, sql: strings.join('?') });
      if (gate) await gate;
      if (behaviour.fail) throw behaviour.fail;
      // The corrected writer must not read this: it emits no RETURNING, so postgres.js hands
      // back an empty result set. Returning [] is the faithful shape.
      return [];
    },
    { json: (v: unknown) => ({ __json: v }) },
  ) as unknown as SqlExecutor;

  return { executor, calls, release: () => release?.() };
}

const T1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const S1 = 'a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1';
const ACTOR = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const BEHALF = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

/**
 * A well-formed event; individual tests patch exactly the field under test.
 *
 * EVERY field carries a DISTINCT non-null value on purpose — including traceId and
 * onBehalfOfInternalUserId, which are the two the shipped builders always leave null. The
 * complete positional assertion in S3-W-10 can only catch a transposed column when no two
 * expected values are interchangeable, and a field left null in every fixture is a column whose
 * binding nothing checks at all.
 */
const baseEvent = (): AuditEventWriteInput => ({
  requestId: 'req-s3-0001',
  traceId: 'trace-s3-0001',
  actorInternalUserId: ACTOR,
  actorAuthProvider: 'supabase',
  onBehalfOfInternalUserId: BEHALF,
  scopeType: 'store',
  tenantId: T1,
  storeId: S1,
  actionId: 's3.audit.unit',
  requiredPermission: 'audit:write',
  decision: 'allow',
  reasonCode: 's3_unit',
  humanReadableReason: 'S3 unit-test event.',
  resultStatus: 'succeeded',
  sourceOfTruth: 'server_authorization_resolver',
  evaluatedBy: 'durable_audit@v0-contract',
  evidenceLevel: 'durable_compliance_event',
  metadata: { phase: 'phase-4.0-m3-s3' },
});

const rejection = async (fn: () => unknown): Promise<Error> => {
  try { await fn(); } catch (e) { return e as Error; }
  throw new Error('expected a rejection, got none');
};

// ---------------------------------------------------------------------------
// INSERT-only: exactly one statement, no RETURNING, no secondary SELECT
// ---------------------------------------------------------------------------

test('S3-W-1: one successful INSERT returns the unchanged receipt shape', async () => {
  const r = recorder();
  const event = baseEvent();
  const receipt = await writeAuditEvent(event, { executor: r.executor });

  assert.equal(r.calls.length, 1, 'exactly one statement may be sent');
  assert.deepEqual(Object.keys(receipt).sort(), ['eventId', 'requestId']);
  assert.equal(receipt.requestId, event.requestId, 'the receipt echoes the validated request id');
  assert.match(receipt.eventId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
});

test('S3-W-2: the emitted statement carries NO returning clause and NO select', async () => {
  // Asserted on the SQL the writer BUILDS, so a comment mentioning RETURNING cannot satisfy it
  // and a refactor that re-adds the clause cannot hide behind one.
  const r = recorder();
  await writeAuditEvent(baseEvent(), { executor: r.executor });
  const sql = r.calls[0].sql.toLowerCase();
  assert.ok(sql.includes('insert into audit_event'), sql.slice(0, 80));
  assert.ok(!/\breturning\b/.test(sql), 'RETURNING requires SELECT privilege — it must be gone');
  assert.ok(!/\bselect\b/.test(sql), 'no read may substitute for the removed RETURNING');
  assert.ok(!/\b(update|delete|truncate|on conflict)\b/.test(sql), 'append-only');
  // One statement, not two smuggled through one template.
  assert.equal(sql.split(';').filter((s) => s.trim() !== '').length, 1);
});

test('S3-W-3: the writer source contains no returning/select outside comments', () => {
  const code = stripComments(WRITER_SRC).toLowerCase();
  assert.ok(!/\breturning\b/.test(code), 'no RETURNING may survive anywhere in the writer code');
  assert.ok(!/\bselect\b/.test(code), 'no SELECT fallback may be introduced');
  assert.ok(!/\.unsafe\b/.test(code), 'no dynamic SQL');
});

test('S3-W-4: the receipt is produced only AFTER the executor resolves', async () => {
  const r = recorder({ defer: true });
  let settled = false;
  const p = writeAuditEvent(baseEvent(), { executor: r.executor }).then((v) => { settled = true; return v; });

  // Drain the microtask queue: had the writer resolved without waiting, it would have settled.
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false, 'no receipt may exist while the INSERT is still in flight');
  assert.equal(r.calls.length, 1, 'the statement was sent and is pending');

  r.release();
  const receipt = await p;
  assert.equal(settled, true);
  assert.equal(receipt.requestId, 'req-s3-0001');
});

test('S3-W-5: an executor failure propagates and yields no receipt', async () => {
  const boom = Object.assign(new Error('permission denied for table audit_event'), { code: '42501' });
  const r = recorder({ fail: boom });
  const err = await rejection(() => writeAuditEvent(baseEvent(), { executor: r.executor }));
  assert.equal(err, boom, 'the original error must reach the caller unchanged');
  assert.equal((err as { code?: string }).code, '42501', 'the SQLSTATE must survive');
  assert.equal(r.calls.length, 1);
});

// ---------------------------------------------------------------------------
// scope truth table — the exact audit_event_scope_consistency_chk tuple
// ---------------------------------------------------------------------------

/** Every VALID form, one per branch of the frozen CHECK. */
const VALID_SCOPES: ReadonlyArray<[string, Partial<AuditEventWriteInput>]> = [
  ['platform: no tenant, no store', { scopeType: 'platform', tenantId: null, storeId: null }],
  ['none: no tenant, no store', { scopeType: 'none', tenantId: null, storeId: null }],
  ['tenant: tenant only', { scopeType: 'tenant', tenantId: T1, storeId: null }],
  ['store: tenant and store', { scopeType: 'store', tenantId: T1, storeId: S1 }],
];

/** Every MATERIAL invalid cross-field combination the CHECK rejects. */
const INVALID_SCOPES: ReadonlyArray<[string, Partial<AuditEventWriteInput>]> = [
  ['platform carrying a tenant', { scopeType: 'platform', tenantId: T1, storeId: null }],
  ['platform carrying a store', { scopeType: 'platform', tenantId: null, storeId: S1 }],
  ['platform carrying both', { scopeType: 'platform', tenantId: T1, storeId: S1 }],
  ['none carrying a tenant', { scopeType: 'none', tenantId: T1, storeId: null }],
  ['none carrying a store', { scopeType: 'none', tenantId: null, storeId: S1 }],
  ['none carrying both', { scopeType: 'none', tenantId: T1, storeId: S1 }],
  ['tenant with no tenant id', { scopeType: 'tenant', tenantId: null, storeId: null }],
  ['tenant carrying a store', { scopeType: 'tenant', tenantId: T1, storeId: S1 }],
  ['tenant with a store but no tenant', { scopeType: 'tenant', tenantId: null, storeId: S1 }],
  ['store with no ids at all', { scopeType: 'store', tenantId: null, storeId: null }],
  ['store missing its store id', { scopeType: 'store', tenantId: T1, storeId: null }],
  ['store missing its tenant id', { scopeType: 'store', tenantId: null, storeId: S1 }],
];

test('S3-W-6: the valid scope matrix is complete and every form is accepted', async () => {
  // Completeness, not a sample: every declared scope type must appear among the valid forms,
  // so adding one to the vocabulary without deciding its tuple fails here.
  assert.deepEqual(
    [...new Set(VALID_SCOPES.map(([, p]) => p.scopeType))].sort(),
    [...SCOPE_TYPE_VALUES].sort(),
  );
  for (const [label, patch] of VALID_SCOPES) {
    const r = recorder();
    const receipt = await writeAuditEvent({ ...baseEvent(), ...patch }, { executor: r.executor });
    assert.equal(r.calls.length, 1, label);
    assert.ok(receipt.eventId, label);
  }
});

test('S3-W-7: every invalid scope combination is rejected BEFORE the executor is invoked', async () => {
  for (const [label, patch] of INVALID_SCOPES) {
    const r = recorder();
    const err = await rejection(() => writeAuditEvent({ ...baseEvent(), ...patch }, { executor: r.executor }));
    assert.ok(err instanceof AuditEventValidationError, `${label}: ${err.name}`);
    assert.match(err.message, /scope fields are inconsistent/, label);
    assert.equal(r.calls.length, 0, `${label}: no statement may be sent for a rejected event`);
  }
});

test('S3-W-8: the rejection names the scope type and never echoes an id', async () => {
  const err = await rejection(() =>
    validateAuditEventInput({ ...baseEvent(), scopeType: 'none', tenantId: T1, storeId: S1 }));
  assert.match(err.message, /'none'/);
  assert.ok(!err.message.includes(T1) && !err.message.includes(S1), err.message);
});

test('S3-W-9: validateAuditEventInput enforces the same tuple standalone', () => {
  for (const [label, patch] of VALID_SCOPES) {
    assert.doesNotThrow(() => validateAuditEventInput({ ...baseEvent(), ...patch }), label);
  }
  for (const [label, patch] of INVALID_SCOPES) {
    assert.throws(
      () => validateAuditEventInput({ ...baseEvent(), ...patch }),
      AuditEventValidationError,
      label,
    );
  }
});

// ---------------------------------------------------------------------------
// parameterisation
// ---------------------------------------------------------------------------

test('S3-W-10: every column is bound to its own value, parameterised, never concatenated', async () => {
  const r = recorder();
  const event = baseEvent();
  const receipt = await writeAuditEvent(event, { executor: r.executor });
  const { strings, values } = r.calls[0];

  // 20 columns, 20 interpolations, 21 literal fragments — the shape a fully parameterised
  // tagged template has, and the shape a concatenated string cannot have.
  assert.equal(values.length, 20);
  assert.equal(strings.length, 21);

  const literal = strings.join(' ');
  for (const secret of [event.requestId, event.actionId, event.reasonCode, T1, S1, ACTOR]) {
    assert.ok(!literal.includes(secret), `${secret} must travel as a parameter, not as SQL text`);
  }

  // The COMPLETE positional map, in column order, not a spot-check.
  //
  // A sample cannot catch a transposition: `action_id` and `required_permission` are both plain
  // `text not null` with no distinguishing CHECK, so swapping their bindings compiles, satisfies
  // every constraint, and silently records the permission as the action in every audit row
  // forever. The same is true of source_of_truth/evaluated_by and of the two nullable uuid actor
  // columns. Verified: with only a sample asserted, that swap passed all 46 tests in this slice.
  assert.equal(values[0], receipt.eventId, 'event_id is the id handed back in the receipt');
  assert.deepEqual(values.slice(1, 19), [
    AUDIT_CONTRACT_VERSION,           // 1  audit_version
    event.requestId,                  // 2  request_id
    event.traceId,                    // 3  trace_id
    event.actorInternalUserId,        // 4  actor_internal_user_id
    event.actorAuthProvider,          // 5  actor_auth_provider
    event.onBehalfOfInternalUserId,   // 6  on_behalf_of_internal_user_id
    event.scopeType,                  // 7  scope_type
    event.tenantId,                   // 8  tenant_id
    event.storeId,                    // 9  store_id
    event.actionId,                   // 10 action_id
    event.requiredPermission,         // 11 required_permission
    event.decision,                   // 12 decision
    event.reasonCode,                 // 13 reason_code
    event.humanReadableReason,        // 14 human_readable_reason
    event.resultStatus,               // 15 result_status
    event.sourceOfTruth,              // 16 source_of_truth
    event.evaluatedBy,                // 17 evaluated_by
    event.evidenceLevel,              // 18 evidence_level
  ]);
  // Every expected value must be DISTINCT, or a swap between two of them is invisible here.
  const positional = values.slice(1, 19);
  assert.equal(new Set(positional.map(String)).size, positional.length, 'fixture values must be distinguishable');
  // metadata is handed to the driver's json helper, never string-built.
  assert.deepEqual(values[19], { __json: { phase: 'phase-4.0-m3-s3' } });
});

// ---------------------------------------------------------------------------
// preserved controls — redaction, bounds, identifiers, enums
// ---------------------------------------------------------------------------

test('S3-W-11: metadata redaction, allow-listing and bounds are unchanged', async () => {
  const r = recorder();
  const long = 'x'.repeat(400);
  await writeAuditEvent(
    {
      ...baseEvent(),
      metadata: {
        route: long,
        phase: 'p',
        accessToken: 'must-not-persist',
        nested: { a: 1 },
        notAllowListed: 'drop me',
      } as never,
    },
    { executor: r.executor },
  );
  const persisted = (r.calls[0].values[19] as { __json: Record<string, unknown> }).__json;
  assert.equal((persisted.route as string).length, 256, 'long strings truncate, never reject');
  assert.equal(persisted.phase, 'p');
  assert.ok(!('accessToken' in persisted), 'a forbidden key must never be persisted');
  assert.ok(!('nested' in persisted), 'non-scalars are dropped');
  assert.ok(!('notAllowListed' in persisted), 'non-allow-listed keys are dropped');
});

test('S3-W-12: a forbidden or non-allow-listed metadata key still fails validation', () => {
  for (const key of AUDIT_FORBIDDEN_FIELDS) {
    assert.throws(
      () => validateAuditEventInput({ ...baseEvent(), metadata: { [key]: 'v' } as never }),
      AuditEventValidationError,
      key,
    );
  }
  assert.throws(
    () => validateAuditEventInput({ ...baseEvent(), metadata: { madeUpKey: 'v' } as never }),
    AuditEventValidationError,
  );
  assert.throws(
    () => validateAuditEventInput({ ...baseEvent(), metadata: { phase: { a: 1 } } as never }),
    AuditEventValidationError,
  );
  assert.ok(AUDIT_WRITER_METADATA_ALLOWLIST.includes('phase'));
  assert.deepEqual(sanitizeAuditMetadata(null), {});
});

test('S3-W-13: identifier validation is unregressed — actor, on-behalf-of, tenant, store', () => {
  const notAUuid = ['firebase-uid-123', 'user@example.com', '', 'aaaaaaaa-aaaa-4aaa-8aaa'];
  for (const bad of notAUuid) {
    assert.throws(() => validateAuditEventInput({ ...baseEvent(), actorInternalUserId: bad }), AuditEventValidationError, bad);
    assert.throws(() => validateAuditEventInput({ ...baseEvent(), onBehalfOfInternalUserId: bad }), AuditEventValidationError, bad);
    assert.throws(
      () => validateAuditEventInput({ ...baseEvent(), scopeType: 'tenant', tenantId: bad, storeId: null }),
      AuditEventValidationError, bad,
    );
    assert.throws(
      () => validateAuditEventInput({ ...baseEvent(), scopeType: 'store', tenantId: T1, storeId: bad }),
      AuditEventValidationError, bad,
    );
  }
  // A null actor stays legal (system/diagnostic events have none).
  assert.doesNotThrow(() => validateAuditEventInput({ ...baseEvent(), actorInternalUserId: null }));
});

test('S3-W-14: enum and required-string validation is unregressed', () => {
  const cases: Array<Partial<AuditEventWriteInput>> = [
    { requestId: '' },
    { actionId: '' },
    { requiredPermission: '' },
    { reasonCode: '' },
    { humanReadableReason: '' },
    { sourceOfTruth: '' },
    { evaluatedBy: '' },
    { scopeType: 'tenant_or_store' as never },
    { decision: 'maybe' as never },
    { resultStatus: 'ok' as never },
    { evidenceLevel: 'advisory' as never },
    { actorAuthProvider: 'okta' as never },
  ];
  for (const patch of cases) {
    assert.throws(
      () => validateAuditEventInput({ ...baseEvent(), ...patch }),
      AuditEventValidationError,
      JSON.stringify(patch),
    );
  }
});

test('S3-W-15: both shipped builders produce scope-consistent events', async () => {
  const r = recorder();
  const diag = buildDiagnosticAuditEvent('corr-1');
  assert.deepEqual([diag.scopeType, diag.tenantId, diag.storeId], ['none', null, null]);
  await writeAuditEvent(diag, { executor: r.executor });
  assert.equal(r.calls.length, 1);

  for (const [label, patch] of VALID_SCOPES) {
    const built = buildAuthorizationDecisionAuditEvent({
      requestId: 'req-2',
      actorInternalUserId: null,
      actorAuthProvider: null,
      scopeType: patch.scopeType!,
      tenantId: patch.tenantId ?? null,
      storeId: patch.storeId ?? null,
      actionId: 'a',
      requiredPermission: 'p',
      decision: 'deny',
      reasonCode: 'r',
      humanReadableReason: 'h',
      resultStatus: 'failed',
    });
    assert.doesNotThrow(() => validateAuditEventInput(built), label);
  }
});

test('S3-W-16: a denial with no tenant context is recordable at scope none', async () => {
  // The scope-less form the S3 contract requires for a denial or unauthenticated outcome.
  // `deny` is a DECISION; the scope-less scope type is `none`, and conflating the two would
  // make the most security-relevant events the only unrecordable ones.
  const r = recorder();
  const receipt = await writeAuditEvent(
    {
      ...baseEvent(),
      actorInternalUserId: null,
      actorAuthProvider: null,
      scopeType: 'none',
      tenantId: null,
      storeId: null,
      decision: 'deny',
      resultStatus: 'failed',
      reasonCode: 'denied_no_identity',
    },
    { executor: r.executor },
  );
  assert.ok(receipt.eventId);
  assert.equal(r.calls[0].values[7], 'none');
  assert.equal(r.calls[0].values[8], null);
  assert.equal(r.calls[0].values[9], null);
});
