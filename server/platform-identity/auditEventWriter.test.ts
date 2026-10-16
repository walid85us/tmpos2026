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
  ADMIN_SESSION_AUDIT_EVENTS,
  TENANT_SESSION_AUDIT_EVENTS,
  buildAdminSessionAuditEvent,
  buildSessionAuditEvent,
  SESSION_AUDIT_METADATA_KEYS,
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
  assert.ok(sql.includes('insert into public.audit_event'), sql.slice(0, 80));
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

// ---------------------------------------------------------------------------
// M5-GIAM-D1-P1-R1 — the record's direct subject (migration 009)
// ---------------------------------------------------------------------------

test('S3-W-17: a subject tenant is its own bound column; without one the statement is exactly the pre-009 one', async () => {
  const withSubject = recorder();
  const event = { ...baseEvent(), scopeType: 'platform' as const, tenantId: null, storeId: null, subjectTenantId: T1 };
  const receipt = await writeAuditEvent(event, { executor: withSubject.executor });
  const { strings, values, sql } = withSubject.calls[0];
  assert.equal(withSubject.calls.length, 1, 'one statement');
  assert.equal(values.length, 21);
  assert.equal(strings.length, 22);
  assert.match(sql.toLowerCase(), /metadata,\s*subject_tenant_id\s*\)/, 'the subject column follows metadata');
  assert.ok(!strings.join(' ').includes(T1), 'bound as a value, never spliced into the text');
  // The COMPLETE positional map of the subject variant, in column order — the same anti-transposition pin
  // S3-W-10 applies to the other statement: a sample cannot catch a swap between two like-typed columns.
  assert.equal(values[0], receipt.eventId, 'event_id is the id handed back in the receipt');
  assert.deepEqual(values.slice(1, 19), [
    AUDIT_CONTRACT_VERSION, event.requestId, event.traceId, event.actorInternalUserId, event.actorAuthProvider,
    event.onBehalfOfInternalUserId, event.scopeType, event.tenantId, event.storeId, event.actionId,
    event.requiredPermission, event.decision, event.reasonCode, event.humanReadableReason, event.resultStatus,
    event.sourceOfTruth, event.evaluatedBy, event.evidenceLevel,
  ]);
  // (Distinctness of those values is S3-W-10's pin; a platform-scope event deliberately nulls tenant_id and store_id.)
  assert.deepEqual(values[19], { __json: event.metadata ?? {} }, 'metadata still goes through the driver\'s json helper');
  assert.equal(values[20], T1, 'and the subject is the last binding, its own column');
  assert.deepEqual([values[7], values[8], values[9]], ['platform', null, null], 'the scope stays platform, naming no tenant_id');

  for (const absent of [undefined, null]) {
    const without = recorder();
    await writeAuditEvent({ ...baseEvent(), subjectTenantId: absent }, { executor: without.executor });
    assert.equal(without.calls[0].values.length, 20, `subject ${String(absent)}: 20 values`);
    assert.ok(!without.calls[0].sql.includes('subject_tenant_id'), `subject ${String(absent)}: the column is not named`);
  }
});

test('S3-W-18: a subject that is not a UUID is refused before any statement', async () => {
  for (const subjectTenantId of ['not-a-uuid', '', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa', `${T1} `]) {
    const r = recorder();
    await assert.rejects(writeAuditEvent({ ...baseEvent(), subjectTenantId }, { executor: r.executor }), AuditEventValidationError, JSON.stringify(subjectTenantId));
    assert.equal(r.calls.length, 0, 'nothing sent');
  }
});

// ---------------------------------------------------------------------------
// M7A-CUSTOMERS-P7 — the record's customer subject (migration 024)
// ---------------------------------------------------------------------------

const CUSTOMER = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

test('S3-W-22: a subject customer is its own bound column after metadata; without one the statements are exactly the earlier ones', async () => {
  const withSubject = recorder();
  const event = { ...baseEvent(), scopeType: 'tenant' as const, tenantId: T1, storeId: null, subjectCustomerId: CUSTOMER };
  const receipt = await writeAuditEvent(event, { executor: withSubject.executor });
  const { strings, values, sql } = withSubject.calls[0];
  assert.equal(withSubject.calls.length, 1, 'one statement');
  assert.equal(values.length, 21);
  assert.equal(strings.length, 22);
  assert.match(sql.toLowerCase(), /metadata,\s*subject_customer_id\s*\)/, 'the customer subject column follows metadata');
  assert.ok(!sql.includes('subject_tenant_id'), 'the tenant subject column is not named');
  assert.ok(!strings.join(' ').includes(CUSTOMER), 'bound as a value, never spliced into the text');
  assert.equal(values[0], receipt.eventId);
  assert.deepEqual(values.slice(1, 19), [
    AUDIT_CONTRACT_VERSION, event.requestId, event.traceId, event.actorInternalUserId, event.actorAuthProvider,
    event.onBehalfOfInternalUserId, event.scopeType, event.tenantId, event.storeId, event.actionId,
    event.requiredPermission, event.decision, event.reasonCode, event.humanReadableReason, event.resultStatus,
    event.sourceOfTruth, event.evaluatedBy, event.evidenceLevel,
  ]);
  assert.deepEqual(values[19], { __json: event.metadata ?? {} });
  assert.equal(values[20], CUSTOMER, 'the customer subject is the last binding, its own column');
  for (const absent of [undefined, null]) {
    const without = recorder();
    await writeAuditEvent({ ...baseEvent(), subjectCustomerId: absent }, { executor: without.executor });
    assert.equal(without.calls[0].values.length, 20, `subject ${String(absent)}: 20 values`);
    assert.ok(!without.calls[0].sql.includes('subject_customer_id'), `subject ${String(absent)}: the column is not named`);
    const tenantOnly = recorder();
    await writeAuditEvent({ ...baseEvent(), scopeType: 'platform', tenantId: null, storeId: null, subjectTenantId: T1, subjectCustomerId: absent },
      { executor: tenantOnly.executor });
    assert.ok(tenantOnly.calls[0].sql.includes('subject_tenant_id') && !tenantOnly.calls[0].sql.includes('subject_customer_id'),
      `a tenant subject beside a ${String(absent)} customer subject is the 009 statement`);
  }
});

test('S3-W-23: a customer subject that is not a UUID, or one beside a tenant subject, is refused before any statement', async () => {
  for (const subjectCustomerId of ['not-a-uuid', '', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa', `${T1} `, 7]) {
    const r = recorder();
    await assert.rejects(writeAuditEvent({ ...baseEvent(), subjectCustomerId: subjectCustomerId as never }, { executor: r.executor }),
      AuditEventValidationError, JSON.stringify(subjectCustomerId));
    assert.equal(r.calls.length, 0, 'nothing sent');
  }
  const both = recorder();
  await assert.rejects(writeAuditEvent({ ...baseEvent(), scopeType: 'platform', tenantId: null, storeId: null, subjectTenantId: T1, subjectCustomerId: CUSTOMER },
    { executor: both.executor }), AuditEventValidationError, 'two subjects');
  assert.equal(both.calls.length, 0, 'nothing sent');
});

// ---------------------------------------------------------------------------
// M7B-INVOICES-P1 — the record's invoice draft subject (migration 028)
// ---------------------------------------------------------------------------

const DRAFT = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const STORE = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

test('M7B-INVOICES-P1 AC-08: a subject invoice draft is its own bound column after metadata, at store scope; without one the statements are exactly the earlier ones', async () => {
  const withSubject = recorder();
  const event = { ...baseEvent(), scopeType: 'store' as const, tenantId: T1, storeId: STORE, subjectInvoiceDraftId: DRAFT };
  await writeAuditEvent(event, { executor: withSubject.executor });
  const { strings, values, sql } = withSubject.calls[0];
  assert.equal(withSubject.calls.length, 1, 'one statement');
  assert.equal(values.length, 21);
  assert.equal(strings.length, 22);
  assert.match(sql.toLowerCase(), /metadata,\s*subject_invoice_draft_id\s*\)/, 'the draft subject column follows metadata');
  assert.ok(!sql.includes('subject_tenant_id') && !sql.includes('subject_customer_id'), 'no other subject column is named');
  assert.ok(!strings.join(' ').includes(DRAFT), 'bound as a value, never spliced into the text');
  assert.deepEqual([values[7], values[8], values[9]], ['store', T1, STORE], 'store scope, its tenant and store');
  assert.equal(values[20], DRAFT, 'the draft subject is the last binding, its own column');
  for (const absent of [undefined, null]) {
    const without = recorder();
    await writeAuditEvent({ ...baseEvent(), subjectInvoiceDraftId: absent }, { executor: without.executor });
    assert.equal(without.calls[0].values.length, 20, `subject ${String(absent)}: 20 values`);
    assert.ok(!without.calls[0].sql.includes('subject_invoice_draft_id'), `subject ${String(absent)}: the column is not named`);
  }
});

test('M7B-INVOICES-P1: a draft subject that is not a UUID, or one beside another subject, is refused before any statement', async () => {
  for (const subjectInvoiceDraftId of ['not-a-uuid', '', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa', `${DRAFT} `, 7]) {
    const r = recorder();
    await assert.rejects(writeAuditEvent({ ...baseEvent(), subjectInvoiceDraftId: subjectInvoiceDraftId as never }, { executor: r.executor }),
      AuditEventValidationError, JSON.stringify(subjectInvoiceDraftId));
    assert.equal(r.calls.length, 0, 'nothing sent');
  }
  for (const [label, other] of [['a customer', { subjectCustomerId: CUSTOMER }], ['a tenant', { subjectTenantId: T1 }]] as const) {
    const both = recorder();
    await assert.rejects(writeAuditEvent({ ...baseEvent(), scopeType: 'store', tenantId: T1, storeId: STORE, subjectInvoiceDraftId: DRAFT, ...other },
      { executor: both.executor }), AuditEventValidationError, `a draft beside ${label}`);
    assert.equal(both.calls.length, 0, 'nothing sent');
  }
});

test('S3-W-19: the session metadata keys persist for the three administrative session events alone, and are all those events keep', async () => {
  const ids = Object.values(ADMIN_SESSION_AUDIT_EVENTS).map((shape) => shape.actionId);
  assert.deepEqual(ids, ['platform.admin.session.login', 'platform.admin.session.reauthenticate', 'platform.admin.session.logout']);
  assert.deepEqual([...SESSION_AUDIT_METADATA_KEYS], ['sessionRef', 'replacedSessionRef', 'authenticatedAt']);
  const session = { sessionRef: 'r'.repeat(43), replacedSessionRef: 'q'.repeat(43), authenticatedAt: 1_700_000_000_000 };
  for (const action of ['login', 'reauthenticate'] as const) {
    const event = buildAdminSessionAuditEvent(action, T1, ACTOR, session);
    assert.deepEqual(sanitizeAuditMetadata({ ...session, phase: 'p' }, event.actionId), session, `${action}: kept, and a general key is not`);
    const r = recorder();
    await writeAuditEvent(event, { executor: r.executor });
    assert.deepEqual(r.calls[0].values[19], { __json: session }, `${action}: persisted as given`);
  }
  // A general key on a session event is refused by validation, exactly as a session key is on any other action.
  assert.throws(() => validateAuditEventInput({ ...buildAdminSessionAuditEvent('logout', T1, null, { sessionRef: session.sessionRef }),
    metadata: { sessionRef: session.sessionRef, phase: 'p' } }), AuditEventValidationError, 'phase on a session event');
  // Every other action treats them as it treats any key off the allow-list — exactly as before: stripped on write,
  // refused by standalone validation — including an action that merely shares the prefix.
  for (const actionId of ['s3.audit.unit', 'platform.tenant.status.change', 'platform.admin.session', 'platform.admin.session.login.x', undefined]) {
    assert.deepEqual(sanitizeAuditMetadata({ ...session, phase: 'p' }, actionId), { phase: 'p' }, String(actionId));
  }
  for (const key of SESSION_AUDIT_METADATA_KEYS) {
    assert.throws(() => validateAuditEventInput({ ...baseEvent(), metadata: { [key]: 'v' } as never }), AuditEventValidationError, key);
    const r = recorder();
    await writeAuditEvent({ ...baseEvent(), metadata: { [key]: 'v', phase: 'p' } as never }, { executor: r.executor });
    assert.deepEqual(r.calls[0].values[19], { __json: { phase: 'p' } }, `${key}: stripped from another action's row`);
  }
  assert.ok(!AUDIT_WRITER_METADATA_ALLOWLIST.some((key) => SESSION_AUDIT_METADATA_KEYS.includes(key)), 'never on the general allow-list');
});

test('S3-W-20: a row under a session action id must match that event\'s fixed shape in every column, whoever builds it', async () => {
  const ref = 'r'.repeat(43);
  const login = buildAdminSessionAuditEvent('login', T1, ACTOR, { sessionRef: ref, authenticatedAt: 1 });
  const logout = buildAdminSessionAuditEvent('logout', T1, null, { sessionRef: ref });
  assert.deepEqual([login.decision, login.reasonCode, logout.decision, logout.reasonCode, logout.actorInternalUserId],
    ['allow', 'admin_session_created', 'not_applicable', 'admin_session_ended', null]);
  const drift: Array<[string, AuditEventWriteInput]> = [
    ['a request id that is no server UUID', { ...login, requestId: 'client-chosen-request-id' }],
    ['another decision', { ...login, decision: 'deny' }],
    ['another reason code', { ...login, reasonCode: 'admin_session_reauthenticated' }],
    ['another sentence', { ...login, humanReadableReason: 'Caller text.' }],
    ['another result', { ...login, resultStatus: 'failed' }],
    ['another source', { ...login, sourceOfTruth: 'server_authorization_resolver' }],
    ['another evaluator', { ...login, evaluatedBy: 'durable_audit@v0-contract' }],
    ['another permission', { ...login, requiredPermission: 'audit:write' }],
    ['a trace id', { ...login, traceId: 'client-trace' }],
    ['a provider', { ...login, actorAuthProvider: 'firebase' }],
    ['an on-behalf actor', { ...login, onBehalfOfInternalUserId: BEHALF }],
    ['a subject tenant', { ...login, subjectTenantId: T1 }],
    ['a subject customer', { ...login, subjectCustomerId: T1 }],
    ['a subject invoice draft', { ...login, subjectInvoiceDraftId: T1 }],
    ['a subject issued invoice', { ...login, subjectIssuedInvoiceId: T1 }],
    ['a subject store', { ...login, subjectStoreId: T1 }],
    ['another scope', { ...login, scopeType: 'none' }],
    ['a tenant scope, itself consistent', { ...login, scopeType: 'tenant', tenantId: T1 }],
    ['advisory evidence', { ...login, evidenceLevel: 'dev_sidecar_log_advisory' }],
    ['a login naming no actor', { ...login, actorInternalUserId: null }],
    ['a logout naming an actor', { ...logout, actorInternalUserId: ACTOR }],
    ['no session reference', { ...login, metadata: { authenticatedAt: 1 } }],
    ['a malformed session reference', { ...login, metadata: { sessionRef: 'short' } }],
    ['a reference of the right length outside base64url', { ...login, metadata: { sessionRef: `${'r'.repeat(42)}=` } }],
    ['a malformed replaced reference', { ...login, metadata: { sessionRef: ref, replacedSessionRef: 7 } }],
    ['a malformed authentication time', { ...login, metadata: { sessionRef: ref, authenticatedAt: 1.5 } }],
    ['a logout naming a replaced session', { ...logout, metadata: { sessionRef: ref, replacedSessionRef: ref } }],
    ['a logout binding an authentication time', { ...logout, metadata: { sessionRef: ref, authenticatedAt: 1 } }],
    ['a generic event borrowing the login id', { ...baseEvent(), scopeType: 'platform', tenantId: null, storeId: null, actionId: login.actionId, metadata: { sessionRef: ref } }],
  ];
  for (const [label, event] of drift) {
    assert.throws(() => validateAuditEventInput(event), AuditEventValidationError, label);
    const r = recorder();
    await assert.rejects(writeAuditEvent(event, { executor: r.executor }), AuditEventValidationError, label);
    assert.equal(r.calls.length, 0, `${label}: nothing sent`);
  }
  // The builder refuses what validation refuses, before anything is sent: an actor that is no UUID, an unknown action.
  assert.throws(() => buildAdminSessionAuditEvent('login', T1, 'uid-alpha', { sessionRef: ref }), AuditEventValidationError);
  assert.throws(() => buildAdminSessionAuditEvent('constructor' as never, T1, ACTOR, { sessionRef: ref }), AuditEventValidationError);
  // Other actions are untouched: the generic event still validates as before.
  assert.doesNotThrow(() => validateAuditEventInput(baseEvent()));
});

test('S3-W-21: the tenant session events are the administrative ones at scope none: their own ids and reasons, the actor rule and the same metadata keys', async () => {
  // M5-TENANT-SESSION-P1 (DA-65): a tenant session selects no tenant or store at login, so its record names neither.
  const ref = 'r'.repeat(43);
  assert.deepEqual(Object.values(TENANT_SESSION_AUDIT_EVENTS).map((shape) => [shape.actionId, shape.decision, shape.reasonCode, shape.actor]), [
    ['tenant.session.login', 'allow', 'tenant_session_created', true],
    ['tenant.session.reauthenticate', 'allow', 'tenant_session_reauthenticated', true],
    ['tenant.session.logout', 'not_applicable', 'tenant_session_ended', false],
  ]);
  const login = buildSessionAuditEvent('tenant', 'login', T1, ACTOR, { sessionRef: ref, authenticatedAt: 1 });
  const logout = buildSessionAuditEvent('tenant', 'logout', T1, null, { sessionRef: ref });
  const fixed = (e: AuditEventWriteInput) => [e.scopeType, e.tenantId, e.storeId, e.requiredPermission, e.resultStatus, e.sourceOfTruth, e.evaluatedBy, e.evidenceLevel];
  assert.deepEqual(fixed(login), ['none', null, null, 'n_a', 'succeeded', 'session_transaction', 'm6_postgres_session_store@v1', 'durable_compliance_event']);
  assert.deepEqual(fixed(logout), fixed(login));
  assert.deepEqual([login.actorInternalUserId, logout.actorInternalUserId], [ACTOR, null]);
  const session = { sessionRef: ref, replacedSessionRef: 'q'.repeat(43), authenticatedAt: 1_700_000_000_000 };
  for (const action of ['login', 'reauthenticate'] as const) {
    const event = buildSessionAuditEvent('tenant', action, T1, ACTOR, session);
    assert.deepEqual(sanitizeAuditMetadata({ ...session, phase: 'p' }, event.actionId), session, `${action}: the session keys are kept, a general one is not`);
  }
  // Each family keeps its own scope: a tenant row at platform scope, an administrative one at none, or either naming a
  // tenant is refused before anything is sent; so is a tenant login with no actor or a logout naming one.
  const drift: Array<[string, AuditEventWriteInput]> = [
    ['a tenant login at platform scope', { ...login, scopeType: 'platform' }],
    ['a tenant login naming its tenant', { ...login, scopeType: 'tenant', tenantId: T1 }],
    ['an administrative login at scope none', { ...buildAdminSessionAuditEvent('login', T1, ACTOR, { sessionRef: ref }), scopeType: 'none' }],
    ['a tenant login naming no actor', { ...login, actorInternalUserId: null }],
    ['a tenant logout naming an actor', { ...logout, actorInternalUserId: ACTOR }],
    ['a tenant logout binding an authentication time', { ...logout, metadata: { sessionRef: ref, authenticatedAt: 1 } }],
    ['another reason code', { ...login, reasonCode: 'admin_session_created' }],
    ['a generic event borrowing the tenant login id', { ...baseEvent(), scopeType: 'none', tenantId: null, storeId: null, actionId: login.actionId, metadata: { sessionRef: ref } }],
  ];
  for (const [label, event] of drift) {
    const r = recorder();
    await assert.rejects(writeAuditEvent(event, { executor: r.executor }), AuditEventValidationError, label);
    assert.equal(r.calls.length, 0, `${label}: nothing sent`);
  }
  assert.throws(() => buildSessionAuditEvent('support' as never, 'login', T1, ACTOR, { sessionRef: ref }), AuditEventValidationError, 'an unknown family');
  assert.throws(() => buildSessionAuditEvent('tenant', 'constructor' as never, T1, ACTOR, { sessionRef: ref }), AuditEventValidationError, 'an unknown action');
  const r = recorder();
  await writeAuditEvent(login, { executor: r.executor });
  assert.equal(r.calls.length, 1, 'a well-formed tenant row is written');
});

// ---------------------------------------------------------------------------
// M7B-INVOICES-ISSUE-P1 — the issue's triple and the settings write's store subject (migration 034)
// ---------------------------------------------------------------------------

const ISSUED = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const TRIPLE = Object.freeze({ subjectInvoiceDraftId: DRAFT, subjectIssuedInvoiceId: ISSUED, subjectCustomerId: CUSTOMER });

test('M7B-INVOICES-ISSUE-P1: the issue\'s triple is ONE fixed statement — the draft, the issued invoice and the customer as the last three bound columns, in that order, at store scope', async () => {
  const r = recorder();
  await writeAuditEvent({ ...baseEvent(), actionId: 'store.invoice.issue', scopeType: 'store', tenantId: T1, storeId: STORE, ...TRIPLE }, { executor: r.executor });
  assert.equal(r.calls.length, 1, 'one statement');
  const { strings, values, sql } = r.calls[0];
  assert.equal(values.length, 23);
  assert.equal(strings.length, 24);
  assert.match(sql.toLowerCase(), /metadata,\s*subject_invoice_draft_id,\s*subject_issued_invoice_id,\s*subject_customer_id\s*\)/);
  assert.ok(!sql.includes('subject_tenant_id') && !sql.includes('subject_store_id'), 'no other subject column');
  for (const id of [DRAFT, ISSUED, CUSTOMER]) assert.ok(!strings.join(' ').includes(id), 'bound as a value, never spliced');
  assert.deepEqual([values[7], values[8], values[9]], ['store', T1, STORE]);
  assert.deepEqual(values.slice(20), [DRAFT, ISSUED, CUSTOMER]);
});

test('M7B-INVOICES-ISSUE-P1: a store subject is its own statement, alone after metadata, at tenant scope; every earlier statement is unchanged', async () => {
  const r = recorder();
  await writeAuditEvent({ ...baseEvent(), actionId: 'tenant.issuing_settings.update', scopeType: 'tenant', tenantId: T1, storeId: null, subjectStoreId: STORE },
    { executor: r.executor });
  const { values, sql } = r.calls[0];
  assert.equal(values.length, 21);
  assert.match(sql.toLowerCase(), /metadata,\s*subject_store_id\s*\)/);
  for (const other of ['subject_tenant_id', 'subject_customer_id', 'subject_invoice_draft_id', 'subject_issued_invoice_id']) assert.ok(!sql.includes(other), other);
  assert.equal(values[20], STORE);
  for (const absent of [undefined, null]) {
    const without = recorder();
    await writeAuditEvent({ ...baseEvent(), subjectStoreId: absent, subjectIssuedInvoiceId: absent }, { executor: without.executor });
    assert.equal(without.calls[0].values.length, 20, `subjects ${String(absent)}: 20 values`);
    assert.ok(!without.calls[0].sql.includes('subject_store_id') && !without.calls[0].sql.includes('subject_issued_invoice_id'), `${String(absent)}: not named`);
    const draftOnly = recorder();
    await writeAuditEvent({ ...baseEvent(), scopeType: 'store', tenantId: T1, storeId: STORE, subjectInvoiceDraftId: DRAFT, subjectIssuedInvoiceId: absent, subjectStoreId: absent },
      { executor: draftOnly.executor });
    assert.match(draftOnly.calls[0].sql.toLowerCase(), /metadata,\s*subject_invoice_draft_id\s*\)/, `${String(absent)}: the 028 statement`);
  }
});

test('M7B-INVOICES-ISSUE-P1: at most one subject except exactly the triple — an issued invoice alone or in part of the triple, the triple beside a fourth subject, a store beside any other, and a malformed new subject are refused before any statement', async () => {
  for (const [label, over] of [
    ['an issued invoice alone', { subjectIssuedInvoiceId: ISSUED }],
    ['an issued invoice with its draft only', { subjectIssuedInvoiceId: ISSUED, subjectInvoiceDraftId: DRAFT }],
    ['an issued invoice with its customer only', { subjectIssuedInvoiceId: ISSUED, subjectCustomerId: CUSTOMER }],
    ['a draft and a customer without the invoice', { subjectInvoiceDraftId: DRAFT, subjectCustomerId: CUSTOMER }],
    ['the triple beside a tenant', { ...TRIPLE, subjectTenantId: T1 }],
    ['the triple beside a store', { ...TRIPLE, subjectStoreId: STORE }],
    ['a store beside a customer', { subjectStoreId: STORE, subjectCustomerId: CUSTOMER }],
    ['a store beside a tenant', { subjectStoreId: STORE, subjectTenantId: T1 }],
    ['a store beside a draft', { subjectStoreId: STORE, subjectInvoiceDraftId: DRAFT }],
    ['an issued invoice that is no uuid', { ...TRIPLE, subjectIssuedInvoiceId: 'not-a-uuid' }],
    ['an issued invoice number', { ...TRIPLE, subjectIssuedInvoiceId: 7 }],
    ['a store that is no uuid', { subjectStoreId: `${STORE} ` }],
    ['an empty store', { subjectStoreId: '' }],
  ] as const) {
    const r = recorder();
    await assert.rejects(writeAuditEvent({ ...baseEvent(), scopeType: 'store', tenantId: T1, storeId: STORE, ...over } as never, { executor: r.executor }),
      AuditEventValidationError, label);
    assert.equal(r.calls.length, 0, `${label}: nothing sent`);
  }
});

test('M7B-INVOICES-ISSUE-P1: the triple is admitted only for store.invoice.issue at store scope, and a store subject only for tenant.issuing_settings.update at tenant scope — any other action or scope is refused before any statement', async () => {
  const issue = { ...baseEvent(), actionId: 'store.invoice.issue', scopeType: 'store', tenantId: T1, storeId: STORE, ...TRIPLE } as const;
  const settings = { ...baseEvent(), actionId: 'tenant.issuing_settings.update', scopeType: 'tenant', tenantId: T1, storeId: null, subjectStoreId: STORE } as const;
  for (const [label, event] of [['the issue', issue], ['the settings write', settings]] as const) {
    const r = recorder();
    await writeAuditEvent(event, { executor: r.executor });
    assert.equal(r.calls.length, 1, `${label}: admitted`);
  }
  for (const [label, event] of [
    ['the triple on another action', { ...issue, actionId: 'store.invoice_draft.update' }],
    ['the triple on the settings action', { ...issue, actionId: 'tenant.issuing_settings.update' }],
    ['the triple at tenant scope', { ...issue, scopeType: 'tenant', storeId: null }],
    ['a store subject on another action', { ...settings, actionId: 'tenant.display_name.update' }],
    ['a store subject on the issue action', { ...settings, actionId: 'store.invoice.issue' }],
    ['a store subject at store scope', { ...settings, scopeType: 'store', storeId: STORE }],
  ] as const) {
    const r = recorder();
    await assert.rejects(writeAuditEvent(event as never, { executor: r.executor }),
      (e: unknown) => e instanceof AuditEventValidationError && e.message === 'audit event subject is not admitted for its action and scope', label);
    assert.equal(r.calls.length, 0, `${label}: nothing sent`);
  }
});
