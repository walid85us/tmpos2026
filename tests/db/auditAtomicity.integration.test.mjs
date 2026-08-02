// Phase 4.0 M3 S3 — durable audit against a REAL disposable PostgreSQL.
//
// Everything here runs against a throwaway `tmpos_s1b_*` database: locally a cluster the S1b
// harness creates on a task-owned Unix socket, in CI the workflow's disposable loopback
// service. No managed provider, no persistent application database, and no ambient application
// DSN is ever consulted — the trusted executor's own guard refuses anything that is not a
// disposable local target.
//
// WHY THIS SUITE EXISTS AND THE UNIT SUITES ARE NOT ENOUGH:
//   server/platform-identity/auditEventWriter.test.ts proves the writer builds a statement with
//   no RETURNING; server/platform-identity/auditTransaction.test.ts proves the helper ASKS for
//   a rollback on every failing path. A fake executor accepts anything and a fake boundary
//   rolls back whatever it is told to. Neither can show that PostgreSQL refuses `RETURNING` to
//   an INSERT-only principal, or that a business row a caller already UPDATEd is genuinely gone
//   after the audit insert was denied. That runs here, observed OUT OF BAND by the owner on a
//   separate connection after the transaction has ended.
//
// THE OWNER PROVES NOTHING ABOUT PRIVILEGE. Migration 005 deliberately does not set FORCE ROW
// LEVEL SECURITY, so the table owner bypasses every policy and holds every grant. Each
// privilege and isolation assertion below therefore runs through an ephemeral NON-OWNER LOGIN
// role that inherits nothing but the privilege roles it is granted; the owner connection is
// used only to build fixtures and to observe.
//
// PRIVILEGE DENIAL IS NOT POLICY DENIAL, AND NEITHER IS A TRIGGER. All three can surface as a
// refusal; conflating them is how a missing GRANT gets reported as working enforcement.
// `classify` separates them and every negative assertion states which one it expects.

import test from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';

import { startDisposablePostgres, localPostgresAvailable } from './localPostgres.harness.mjs';
import {
  assertDisposableTestDsn,
  createPostgresExecutor,
  runTrustedApply,
} from '../../server/platform-identity/migrationExecutor.ts';
import { createNodeFsPort } from '../../server/platform-identity/migrationEngine.ts';
import { runtimeClientOptions, CONTEXT_SETTINGS } from '../../server/platform-identity/db.ts';
import {
  writeAuditEvent,
  validateAuditEventInput,
} from '../../server/platform-identity/auditEventWriter.ts';
import { runAuditedMutation } from '../../server/platform-identity/auditTransaction.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..');
const MIG_DIR = join(REPO, 'server', 'platform-identity', 'migrations');
const MIG_REL = 'server/platform-identity/migrations';

const LOCK_KEY = 720100304;
const CREDENTIAL = { purpose: 'migration', migratorRef: 's3-migrator', runtimeRef: 's3-runtime' };
const NOW = () => new Date().toISOString();

const RUNTIME_ROLE = 'tmpos_app';
const AUDIT_ROLE = 'tmpos_audit_writer';

/** Ephemeral LOGIN principals, one per capability shape the S3 scenarios need. */
const FULL_PROBE = 'tmpos_s3_full_probe';       // tmpos_app + tmpos_audit_writer
const MUTATE_PROBE = 'tmpos_s3_mutate_probe';   // tmpos_app ONLY — can mutate, cannot audit
const SETROLE_PROBE = 'tmpos_s3_setrole_probe'; // tmpos_audit_writer WITH INHERIT FALSE, SET TRUE

/** Fixture ids, deliberately disjoint from the S2 fixture's a/b sets: in CI both suites share
 *  one disposable database, and a collision would make either suite's failure the other's. */
const T_E = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const S_E1 = 'e1e1e1e1-e1e1-4e1e-8e1e-e1e1e1e1e1e1';
const ORIGINAL_NAME = 'S3 Fixture Store (original)';

/** The G-DBROLE database-owner step migration 005 verifies and refuses to run without. Issued
 *  by the disposable database's OWNER — it is not the migration's to issue. No database name is
 *  hard-coded; the identifier is quoted through format('%I'). */
const OWNER_DB_ACL_PREP = `do $$
begin
  execute format('revoke temporary on database %I from public', current_database());
  execute format('revoke create on database %I from public', current_database());
end
$$;`;

// ---------------------------------------------------------------------------
// cluster lifecycle
// ---------------------------------------------------------------------------

const ambientTestDsn = process.env.TM_POS_TEST_DATABASE_URL;
let cluster = null;
let TARGET_DSN = null;
let CLIENT_OPTS = {};

if (typeof ambientTestDsn === 'string' && ambientTestDsn.trim() !== '') {
  TARGET_DSN = ambientTestDsn.trim();
} else if (localPostgresAvailable()) {
  cluster = startDisposablePostgres();
  TARGET_DSN = cluster.dsn;
  CLIENT_OPTS = cluster.clientOptions;
} else {
  throw new Error(
    'S3 INFRASTRUCTURE BLOCKER: no TM_POS_TEST_DATABASE_URL and no local initdb/pg_ctl. ' +
    'Docker and remote databases are not substitutes.',
  );
}

// VALIDATE BEFORE TOUCHING ANYTHING. The statements below include cluster-wide DDL (CREATE
// ROLE), which is not scoped to a database and cannot be undone by dropping one.
assertDisposableTestDsn(TARGET_DSN);

/** `host`/`user` are libpq TRANSPORT parameters; forwarded in the URL the server would reject
 *  them as startup settings, so they travel in CLIENT_OPTS instead. Userinfo is REPLACED (not
 *  blanked) when a role is named: the CI service DSN carries `tmpos_s1b_owner@`, and blanking
 *  it would fall back to the OS account, which is not a role in that cluster. */
function driverDsn(raw, user) {
  const u = new URL(raw);
  u.searchParams.delete('host');
  u.searchParams.delete('user');
  if (user !== undefined) {
    u.username = encodeURIComponent(user);
    u.password = '';
  }
  return u.toString();
}

/** The OWNER connection — fixtures and out-of-band observation only, never a privilege claim. */
const observer = postgres(driverDsn(TARGET_DSN), {
  max: 1, prepare: false, idle_timeout: 0, onnotice: () => {}, ...CLIENT_OPTS,
});

/**
 * A probe client for one non-owner LOGIN role, carrying the RUNTIME PRINCIPAL'S OWN options
 * (imported from db.ts rather than restated, so what is proved live is what the runtime client
 * really applies). `max: 1` pins every transaction to one physical backend, which is what makes
 * the shared-backend evidence below meaningful.
 */
function probeClient(role) {
  return postgres(driverDsn(TARGET_DSN, role), {
    ...runtimeClientOptions(TARGET_DSN),
    // EXPLICIT TLS opt-out, stated at the call site rather than inferred from a hostname. The
    // disposable target is a task-owned socket locally and a plaintext loopback service in CI.
    ssl: false,
    max: 1,
    idle_timeout: 0,
    onnotice: () => {},
    ...CLIENT_OPTS,
    user: role,
  });
}

let fullProbe = null;
let mutateProbe = null;
let setroleProbe = null;

/** Classify a refusal. Privilege, policy, trigger and constraint are four different things. */
function classify(err) {
  const msg = String(err?.message ?? '');
  const code = err?.code ?? null;
  if (/append-only/i.test(msg)) return { kind: 'append_only_trigger', code, msg };
  if (/row-level security policy/i.test(msg)) return { kind: 'rls_policy', code, msg };
  if (/permission denied/i.test(msg)) return { kind: 'privilege', code, msg };
  if (/violates check constraint/i.test(msg)) return { kind: 'check_constraint', code, msg };
  if (err?.name === 'AuditEventValidationError') return { kind: 'application_validation', code, msg };
  return { kind: 'other', code, msg };
}

/**
 * Run `fn` and report how it was refused ('none' when it was not).
 *
 * An AssertionError is RE-THROWN, never classified. Some of the callbacks below assert INSIDE
 * the transaction (S3-DB-6 checks that the UPDATE is really live before the audit fails); a
 * catch-all would convert such a failure into `kind: 'other'` and surface it as a confusing
 * mismatch against the expected refusal kind instead of the assertion that actually broke.
 */
async function refusal(fn) {
  try {
    await fn();
    return { kind: 'none', code: null, msg: '' };
  } catch (e) {
    if (e instanceof assert.AssertionError) throw e;
    return classify(e);
  }
}

/** A well-formed store-scope audit event for the fixture store. */
const storeScopeEvent = (requestId, patch = {}) => ({
  requestId,
  traceId: null,
  actorInternalUserId: null,
  actorAuthProvider: null,
  onBehalfOfInternalUserId: null,
  scopeType: 'store',
  tenantId: T_E,
  storeId: S_E1,
  actionId: 's3.store.rename',
  requiredPermission: 'store:rename',
  decision: 'allow',
  reasonCode: 's3_atomic',
  humanReadableReason: 'S3 atomicity proof — store rename.',
  resultStatus: 'succeeded',
  sourceOfTruth: 'server_authorization_resolver',
  evaluatedBy: 'durable_audit@v0-contract',
  evidenceLevel: 'durable_compliance_event',
  metadata: { phase: 'phase-4.0-m3-s3' },
  ...patch,
});

/** Install the SERVER-DERIVED store context transaction-locally, exactly as db.ts does. */
async function installStoreContext(tx) {
  await tx`select set_config(${CONTEXT_SETTINGS.scopeType}, ${'store'}, true)`;
  await tx`select set_config(${CONTEXT_SETTINGS.tenantId}, ${T_E}, true)`;
  await tx`select set_config(${CONTEXT_SETTINGS.storeId}, ${S_E1}, true)`;
}

const storeNameAsOwner = async () =>
  (await observer`select store_name from store where store_id = ${S_E1}`)[0]?.store_name ?? null;
const auditCountAsOwner = async (prefix) =>
  (await observer`select count(*)::int as n from audit_event where request_id like ${`${prefix}%`}`)[0].n;

// ---------------------------------------------------------------------------
// setup: real migrations, real fixture, real non-owner principals
// ---------------------------------------------------------------------------

// 001-004 revoke from `anon` and `authenticated`, which exist on Supabase Postgres but not in a
// bare cluster. Creating them reproduces the role environment those migrations assume, rather
// than editing a frozen migration to accommodate a test.
await observer.unsafe(`do $$ begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
end $$;`);

// The G-DBROLE owner step, before the migration that verifies it. Idempotent, because in CI this
// database is shared with the S2 suite within one job and may already carry the closed posture.
await observer.unsafe(OWNER_DB_ACL_PREP);

// Idempotent by design: locally this suite owns a fresh cluster and applies 001-005 itself; in
// CI the S2 suite has already applied them to the shared service database and the ledger makes
// this a no-op. Either way the assertion that matters is made below, on the schema.
{
  const handle = await createPostgresExecutor(assertDisposableTestDsn(TARGET_DSN));
  try {
    await runTrustedApply({
      fsPort: createNodeFsPort(MIG_DIR, MIG_REL),
      adapter: handle.adapter,
      ledger: handle.ledger,
      connectionMode: 'session',
      credential: CREDENTIAL,
      lockKey: LOCK_KEY,
      now: NOW,
      deadlineMs: 60_000,
    });
  } finally {
    await handle.dispose();
  }
}

// Fixture, inserted as the OWNER: the tenant-runtime principal cannot create tenants or stores,
// so it could not build its own — which is itself part of what migration 005 guarantees.
await observer`insert into tenant (tenant_id, display_name, legal_name, plan_key, status)
  values (${T_E}, ${'S3 Fixture Tenant'}, ${'S3 Fixture Tenant Ltd'}, ${'starter'}, ${'active'})
  on conflict (tenant_id) do nothing`;
await observer`insert into store (store_id, tenant_id, store_name, status)
  values (${S_E1}, ${T_E}, ${ORIGINAL_NAME}, ${'active'})
  on conflict (store_id) do update set store_name = ${ORIGINAL_NAME}`;

// Ephemeral LOGIN probes. They carry NO password: the disposable cluster authenticates locally
// by trust, so no credential is created, stored, or transmitted anywhere in this suite.
for (const role of [FULL_PROBE, MUTATE_PROBE, SETROLE_PROBE]) {
  await observer.unsafe(
    `create role ${role} login nosuperuser nocreatedb nocreaterole noreplication nobypassrls inherit`);
}
await observer.unsafe(`grant ${RUNTIME_ROLE} to ${FULL_PROBE}`);
await observer.unsafe(`grant ${AUDIT_ROLE} to ${FULL_PROBE}`);
await observer.unsafe(`grant ${RUNTIME_ROLE} to ${MUTATE_PROBE}`);
// The honest-limit principal: it does NOT inherit the audit capability, but it can SET ROLE to
// it. `has_table_privilege` alone reports false for this shape, which is exactly the point.
await observer.unsafe(`grant ${AUDIT_ROLE} to ${SETROLE_PROBE} with inherit false, set true`);

fullProbe = probeClient(FULL_PROBE);
mutateProbe = probeClient(MUTATE_PROBE);
setroleProbe = probeClient(SETROLE_PROBE);

test.after(async () => {
  for (const c of [fullProbe, mutateProbe, setroleProbe]) {
    if (c) await c.end({ timeout: 0 }).catch(() => {});
  }
  // Fixture rows first: a role that still held a privilege on them could not be dropped. Audit
  // rows are deliberately NOT deleted — the table is append-only and the database is disposable.
  await observer`delete from store where store_id = ${S_E1}`.catch(() => {});
  await observer`delete from tenant where tenant_id = ${T_E}`.catch(() => {});
  // EVERY cluster-wide role this suite created. Locally the whole cluster goes below anyway, but
  // in CI the service container outlives this suite within its job, and these CREATE ROLE
  // statements are unguarded — a second invocation would fail at module load.
  for (const r of [FULL_PROBE, MUTATE_PROBE, SETROLE_PROBE]) {
    await observer.unsafe(`drop role if exists ${r}`).catch(() => {});
  }
  await observer.end({ timeout: 5 }).catch(() => {});
  if (cluster !== null) {
    const life = cluster.stop();
    assert.equal(life.stopped, true, 'the task-created PostgreSQL process must be stopped');
    assert.equal(life.removed, true, 'the task-created temporary directory must be removed');
  }
});

// ---------------------------------------------------------------------------
// foundation
// ---------------------------------------------------------------------------

test('S3-DB-1: the frozen audit objects are present on the applied schema', async () => {
  const [chk] = await observer`select count(*)::int as n from pg_constraint
    where conname = 'audit_event_scope_consistency_chk'`;
  const [trg] = await observer`select count(*)::int as n from pg_trigger
    where tgname = 'trg_audit_event_reject_mutation' and not tgisinternal`;
  const [pol] = await observer`select polcmd from pg_policy where polname = 'tmpos_audit_writer_append'`;
  const [rls] = await observer`select relrowsecurity, relforcerowsecurity
    from pg_class where oid = 'public.audit_event'::regclass`;

  assert.equal(chk.n, 1, 'the S2 scope-consistency constraint must exist');
  assert.equal(trg.n, 1, 'the 002 append-only trigger must exist');
  assert.equal(pol.polcmd, 'a', 'the audit policy must be INSERT-only (pg_policy polcmd a)');
  assert.equal(rls.relrowsecurity, true);
  // Stated, not asserted away: the owner is NOT subject to the policy, which is why every
  // privilege claim below runs through a non-owner probe.
  assert.equal(rls.relforcerowsecurity, false);
});

test('S3-DB-2: the audit principal holds INSERT and nothing else on audit_event', async () => {
  const [p] = await fullProbe`select
      has_table_privilege('public.audit_event', 'INSERT') as ins,
      has_table_privilege('public.audit_event', 'SELECT') as sel,
      has_table_privilege('public.audit_event', 'UPDATE') as upd,
      has_table_privilege('public.audit_event', 'DELETE') as del,
      has_table_privilege('public.audit_event', 'TRUNCATE') as trunc,
      has_table_privilege('public.audit_event', 'REFERENCES') as refs,
      has_table_privilege('public.audit_event', 'TRIGGER') as trg,
      has_column_privilege('public.audit_event', 'event_id', 'SELECT') as col_event_id,
      has_column_privilege('public.audit_event', 'request_id', 'SELECT') as col_request_id,
      has_column_privilege('public.audit_event', 'metadata', 'SELECT') as col_metadata,
      has_schema_privilege('public', 'CREATE') as schema_create`;
  assert.equal(p.ins, true, 'the writer must be able to append');
  for (const [k, v] of Object.entries(p)) {
    if (k === 'ins') continue;
    assert.equal(v, false, `${k} must be denied to the runtime audit principal`);
  }
  const [u] = await fullProbe`select has_schema_privilege('public', 'USAGE') as schema_usage`;
  assert.equal(u.schema_usage, true, 'USAGE on the schema is the one thing it does hold');

  // The tenant-runtime role holds NOTHING on audit_event — a mutation principal cannot audit.
  const [q] = await mutateProbe`select
      has_table_privilege('public.audit_event', 'INSERT') as ins,
      has_table_privilege('public.audit_event', 'SELECT') as sel,
      has_table_privilege('public.store', 'SELECT') as store_sel,
      has_table_privilege('public.store', 'INSERT') as store_ins,
      has_column_privilege('public.store', 'store_name', 'UPDATE') as store_name_upd,
      has_column_privilege('public.store', 'status', 'UPDATE') as store_status_upd`;
  assert.deepEqual(
    [q.ins, q.sel, q.store_sel, q.store_ins, q.store_name_upd, q.store_status_upd],
    [false, false, true, true, true, false],
  );
});

// ---------------------------------------------------------------------------
// 1) INSERT-only writer
// ---------------------------------------------------------------------------

test('S3-DB-3: the corrected writer succeeds with no SELECT privilege at all', async () => {
  const rid = 's3-atomic-writer-1';
  const receipt = await writeAuditEvent(
    storeScopeEvent(rid, { scopeType: 'none', tenantId: null, storeId: null }),
    { executor: fullProbe },
  );
  assert.match(receipt.eventId, /^[0-9a-f]{8}-/i);
  assert.equal(receipt.requestId, rid);

  // The row really landed — read by the OWNER, because the writer's principal cannot read it.
  const [row] = await observer`select event_id, request_id, scope_type, audit_version
    from audit_event where request_id = ${rid}`;
  assert.equal(row.event_id, receipt.eventId, 'the receipt id is the id that was persisted');
  assert.equal(row.scope_type, 'none');
  assert.equal(row.audit_version, 'audit.v1');

  // And the principal that wrote it still cannot read it back.
  const back = await refusal(() => fullProbe`select 1 from audit_event where request_id = ${rid}`);
  assert.equal(back.kind, 'privilege');
  assert.equal(back.code, '42501');
});

test('S3-DB-4: the same INSERT with RETURNING is refused 42501 — the isolating control', async () => {
  // Not a hypothetical: this is the exact clause the writer used to emit. Both statements are
  // otherwise identical, so the only variable is `returning`.
  const ok = await refusal(() => fullProbe`
    insert into audit_event (request_id, scope_type, action_id, required_permission, decision,
      reason_code, human_readable_reason, result_status, source_of_truth, evaluated_by, evidence_level)
    values (${'s3-atomic-control-plain'}, ${'none'}, ${'s3.control'}, ${'n_a'}, ${'not_applicable'},
      ${'s3_ctl'}, ${'S3 RETURNING control'}, ${'n_a'}, ${'system_diagnostic'}, ${'s3_ctl@v0'},
      ${'durable_compliance_event'})`);
  assert.equal(ok.kind, 'none', `the plain INSERT must succeed: ${ok.msg}`);

  const denied = await refusal(() => fullProbe`
    insert into audit_event (request_id, scope_type, action_id, required_permission, decision,
      reason_code, human_readable_reason, result_status, source_of_truth, evaluated_by, evidence_level)
    values (${'s3-atomic-control-returning'}, ${'none'}, ${'s3.control'}, ${'n_a'}, ${'not_applicable'},
      ${'s3_ctl'}, ${'S3 RETURNING control'}, ${'n_a'}, ${'system_diagnostic'}, ${'s3_ctl@v0'},
      ${'durable_compliance_event'})
    returning event_id, request_id`);
  assert.equal(denied.kind, 'privilege', denied.msg);
  assert.equal(denied.code, '42501');
  // RETURNING needs SELECT, so the row was never written either.
  assert.equal(await auditCountAsOwner('s3-atomic-control-returning'), 0);
});

// ---------------------------------------------------------------------------
// 2) successful atomic commit
// ---------------------------------------------------------------------------

test('S3-DB-5: mutation and audit commit together, in ONE transaction on ONE backend', async () => {
  const rid = 's3-atomic-commit-1';
  const NEW_NAME = 'S3 Fixture Store (renamed)';
  let inMutation = null;
  let inAudit = null;

  const outcome = await runAuditedMutation(
    fullProbe,
    {
      mutate: async (tx) => {
        await installStoreContext(tx);
        const [ids] = await tx`select pg_backend_pid() as pid, txid_current() as xid`;
        inMutation = ids;
        const res = await tx`update store set store_name = ${NEW_NAME} where store_id = ${S_E1}`;
        return { rows: res.count };
      },
      buildAuditEvent: (r) => storeScopeEvent(rid, {
        metadata: { phase: 'phase-4.0-m3-s3', check: String(r.rows) },
      }),
    },
    {
      // A thin passthrough so the transaction handle the WRITER receives can be interrogated —
      // it forwards to the real writer unchanged and adds no behaviour of its own.
      writeAuditEvent: async (event, options) => {
        const [ids] = await options.executor`select pg_backend_pid() as pid, txid_current() as xid`;
        inAudit = ids;
        return writeAuditEvent(event, options);
      },
    },
  );

  assert.equal(outcome.result.rows, 1, 'exactly one store row was updated');
  assert.equal(outcome.audit.requestId, rid);
  assert.equal(inAudit.pid, inMutation.pid, 'same backend');
  assert.equal(String(inAudit.xid), String(inMutation.xid), 'same transaction id');

  // Out of band, after the transaction ended: BOTH became visible to the owner.
  assert.equal(await storeNameAsOwner(), NEW_NAME);
  const [audited] = await observer`select event_id, scope_type, tenant_id, store_id
    from audit_event where request_id = ${rid}`;
  assert.equal(audited.event_id, outcome.audit.eventId);
  assert.equal(audited.scope_type, 'store');
  assert.equal(audited.tenant_id, T_E);
  assert.equal(audited.store_id, S_E1);

  // The strongest available evidence that it was ONE transaction and not two well-timed ones:
  // both committed row versions carry the same inserting xid.
  const [{ xmin: storeXmin }] = await observer`select xmin::text::bigint as xmin from store where store_id = ${S_E1}`;
  const [{ xmin: auditXmin }] = await observer`select xmin::text::bigint as xmin from audit_event where request_id = ${rid}`;
  assert.equal(String(storeXmin), String(auditXmin), 'both rows must carry the same inserting xid');

  // And the principal that wrote the audit row still cannot read it.
  const back = await refusal(() => fullProbe`select 1 from audit_event where request_id = ${rid}`);
  assert.equal(back.kind, 'privilege');
});

// ---------------------------------------------------------------------------
// 3) audit failure rolls the mutation back — at the PostgreSQL boundary
// ---------------------------------------------------------------------------

test('S3-DB-6: an audit privilege failure discards a mutation that had already executed', async () => {
  // The mutate-only principal holds tmpos_app and NOT tmpos_audit_writer, so the failure is a
  // real privilege refusal from PostgreSQL AFTER the UPDATE statement ran — not an application
  // validation error, which would prove nothing about the database's atomicity.
  const rid = 's3-atomic-rollback-1';
  const ATTEMPTED = 'S3 Fixture Store (must not persist)';
  const before = await storeNameAsOwner();
  const auditBefore = await auditCountAsOwner('s3-atomic-');
  let mutatedRows = -1;

  const failure = await refusal(() => runAuditedMutation(mutateProbe, {
    mutate: async (tx) => {
      await installStoreContext(tx);
      const res = await tx`update store set store_name = ${ATTEMPTED} where store_id = ${S_E1}`;
      mutatedRows = res.count;
      // Proof the mutation was REAL and visible inside the transaction before the audit failed.
      const [seen] = await tx`select store_name from store where store_id = ${S_E1}`;
      assert.equal(seen.store_name, ATTEMPTED, 'the update must be live inside the transaction');
      return { rows: res.count };
    },
    buildAuditEvent: () => storeScopeEvent(rid),
  }));

  assert.equal(mutatedRows, 1, 'the business mutation really did execute');
  assert.equal(failure.kind, 'privilege', failure.msg);
  assert.equal(failure.code, '42501');
  assert.match(failure.msg, /audit_event/);

  // Out of band: the mutation is GONE and no audit row exists.
  assert.equal(await storeNameAsOwner(), before, 'the business mutation must not have persisted');
  assert.equal(await auditCountAsOwner(rid), 0);
  // No compensating out-of-transaction write happened anywhere either.
  assert.equal(await auditCountAsOwner('s3-atomic-'), auditBefore);
});

// ---------------------------------------------------------------------------
// 4) mutation failure prevents the audit
// ---------------------------------------------------------------------------

test('S3-DB-7: a mutation refused by PostgreSQL prevents the audit INSERT entirely', async () => {
  // `status` is deliberately outside the column-scoped UPDATE grant migration 005 issues, so
  // this is a genuine 42501 from the server, not a synthetic throw.
  const rid = 's3-atomic-mutfail-1';
  const before = await storeNameAsOwner();
  let auditAttempted = false;

  const failure = await refusal(() => runAuditedMutation(
    fullProbe,
    {
      mutate: async (tx) => {
        await installStoreContext(tx);
        return tx`update store set status = ${'suspended'} where store_id = ${S_E1}`;
      },
      buildAuditEvent: () => storeScopeEvent(rid),
    },
    {
      writeAuditEvent: async (event, options) => {
        auditAttempted = true;
        return writeAuditEvent(event, options);
      },
    },
  ));

  assert.equal(failure.kind, 'privilege', failure.msg);
  assert.equal(failure.code, '42501');
  assert.equal(auditAttempted, false, 'no audit may be attempted for a mutation that failed');
  assert.equal(await auditCountAsOwner(rid), 0);
  assert.equal(await storeNameAsOwner(), before);
  const [{ status }] = await observer`select status from store where store_id = ${S_E1}`;
  assert.equal(status, 'active', 'the refused column must be untouched');
});

// ---------------------------------------------------------------------------
// 5) scope consistency — three enforcement layers, kept apart
// ---------------------------------------------------------------------------

const VALID_SCOPES = [
  ['platform', { scopeType: 'platform', tenantId: null, storeId: null }],
  ['none', { scopeType: 'none', tenantId: null, storeId: null }],
  ['tenant', { scopeType: 'tenant', tenantId: T_E, storeId: null }],
  ['store', { scopeType: 'store', tenantId: T_E, storeId: S_E1 }],
];

/** EXHAUSTIVE over the four scope types x the four (tenant, store) presence combinations, minus
 *  the four the CHECK allows: 4 x 4 - 4 = 12. A sampled list would let a constraint that had
 *  lost one branch still pass. */
const INVALID_SCOPES = [
  ['platform carrying a tenant', 'platform', T_E, null],
  ['platform carrying a store', 'platform', null, S_E1],
  ['platform carrying both', 'platform', T_E, S_E1],
  ['none carrying a tenant', 'none', T_E, null],
  ['none carrying a store', 'none', null, S_E1],
  ['none carrying both', 'none', T_E, S_E1],
  ['tenant with no tenant id', 'tenant', null, null],
  ['tenant carrying a store', 'tenant', T_E, S_E1],
  ['tenant with a store but no tenant', 'tenant', null, S_E1],
  ['store with no ids', 'store', null, null],
  ['store missing its store id', 'store', T_E, null],
  ['store missing its tenant id', 'store', null, S_E1],
];

test('S3-DB-8: every valid canonical scope form inserts through the runtime writer', async () => {
  for (const [label, patch] of VALID_SCOPES) {
    const rid = `s3-atomic-scope-${label}`;
    const receipt = await writeAuditEvent(storeScopeEvent(rid, patch), { executor: fullProbe });
    assert.ok(receipt.eventId, label);
    const [row] = await observer`select scope_type, tenant_id, store_id from audit_event where request_id = ${rid}`;
    assert.equal(row.scope_type, patch.scopeType, label);
    assert.equal(row.tenant_id, patch.tenantId, label);
    assert.equal(row.store_id, patch.storeId, label);
  }
});

test('S3-DB-9: every invalid direct-SQL scope combination is refused by the frozen CHECK', async () => {
  // Issued as the OWNER on purpose: the owner bypasses the RLS policy, so what refuses here can
  // only be `audit_event_scope_consistency_chk` and not the policy's identical-looking clause.
  for (const [label, scope, tenant, store] of INVALID_SCOPES) {
    const r = await refusal(() => observer`
      insert into audit_event (request_id, scope_type, tenant_id, store_id, action_id,
        required_permission, decision, reason_code, human_readable_reason, result_status,
        source_of_truth, evaluated_by, evidence_level)
      values (${'s3-atomic-dbcheck'}, ${scope}, ${tenant}, ${store}, ${'s3.check'}, ${'n_a'},
        ${'not_applicable'}, ${'s3_chk'}, ${'S3 direct check'}, ${'n_a'}, ${'system_diagnostic'},
        ${'s3_chk@v0'}, ${'durable_compliance_event'})`);
    assert.equal(r.kind, 'check_constraint', `${label}: ${r.msg}`);
    assert.equal(r.code, '23514', label);
    assert.match(r.msg, /audit_event_scope_consistency_chk/, label);
  }
  assert.equal(await auditCountAsOwner('s3-atomic-dbcheck'), 0);
});

test('S3-DB-10: the writer refuses the same combinations earlier, before any statement', async () => {
  const before = await auditCountAsOwner('s3-atomic-appcheck');
  for (const [label, scope, tenant, store] of INVALID_SCOPES) {
    const r = await refusal(() => writeAuditEvent(
      storeScopeEvent('s3-atomic-appcheck', { scopeType: scope, tenantId: tenant, storeId: store }),
      { executor: fullProbe },
    ));
    assert.equal(r.kind, 'application_validation', `${label}: ${r.kind} / ${r.msg}`);
    assert.match(r.msg, /scope fields are inconsistent/, label);
  }
  assert.equal(await auditCountAsOwner('s3-atomic-appcheck'), before, 'nothing may reach the database');
  // Same rule, reachable without a database at all.
  assert.throws(() => validateAuditEventInput(storeScopeEvent('x', { storeId: null })));
});

test('S3-DB-11: a scope-less denial is recordable with no tenant context at all', async () => {
  // `deny` is a DECISION; the scope-less scope type is `none`. Conflating the two would make the
  // most security-relevant events — denials and unauthenticated outcomes — unrecordable.
  const rid = 's3-atomic-denial-1';
  const receipt = await writeAuditEvent(
    storeScopeEvent(rid, {
      scopeType: 'none', tenantId: null, storeId: null,
      actorInternalUserId: null, actorAuthProvider: null,
      decision: 'deny', resultStatus: 'failed', reasonCode: 'denied_no_identity',
      humanReadableReason: 'No durable identity matched the supplied provider key.',
    }),
    { executor: fullProbe },
  );
  const [row] = await observer`select scope_type, tenant_id, store_id, decision, result_status,
      actor_internal_user_id from audit_event where event_id = ${receipt.eventId}`;
  assert.deepEqual(
    [row.scope_type, row.tenant_id, row.store_id, row.decision, row.result_status, row.actor_internal_user_id],
    ['none', null, null, 'deny', 'failed', null],
  );
});

test('S3-DB-12: the audit policy refuses an advisory evidence level the CHECK would allow', async () => {
  // The two layers are not the same rule: `dev_sidecar_log_advisory` satisfies every CHECK on
  // the table and is refused only by the policy's WITH CHECK. Proved by the owner accepting the
  // identical row (the owner is not subject to the policy) while the runtime role is refused.
  const denied = await refusal(() => fullProbe`
    insert into audit_event (request_id, scope_type, action_id, required_permission, decision,
      reason_code, human_readable_reason, result_status, source_of_truth, evaluated_by, evidence_level)
    values (${'s3-atomic-advisory'}, ${'none'}, ${'s3.adv'}, ${'n_a'}, ${'not_applicable'},
      ${'s3_adv'}, ${'S3 advisory'}, ${'n_a'}, ${'system_diagnostic'}, ${'s3_adv@v0'},
      ${'dev_sidecar_log_advisory'})`);
  assert.equal(denied.kind, 'rls_policy', denied.msg);
  assert.equal(denied.code, '42501');

  const asOwner = await refusal(() => observer`
    insert into audit_event (request_id, scope_type, action_id, required_permission, decision,
      reason_code, human_readable_reason, result_status, source_of_truth, evaluated_by, evidence_level)
    values (${'s3-atomic-advisory-owner'}, ${'none'}, ${'s3.adv'}, ${'n_a'}, ${'not_applicable'},
      ${'s3_adv'}, ${'S3 advisory'}, ${'n_a'}, ${'system_diagnostic'}, ${'s3_adv@v0'},
      ${'dev_sidecar_log_advisory'})`);
  assert.equal(asOwner.kind, 'none', 'no CHECK forbids it — the policy is what refuses');
});

// ---------------------------------------------------------------------------
// 6) append-only enforcement
// ---------------------------------------------------------------------------

test('S3-DB-13: the runtime role is refused UPDATE/DELETE by PRIVILEGE, the owner by the TRIGGER', async () => {
  const rid = 's3-atomic-append-1';
  await writeAuditEvent(
    storeScopeEvent(rid, { scopeType: 'none', tenantId: null, storeId: null }),
    { executor: fullProbe },
  );

  // Non-owner: refused before the trigger is ever reached — a missing GRANT.
  const upd = await refusal(() => fullProbe`update audit_event set reason_code = ${'tampered'} where request_id = ${rid}`);
  const del = await refusal(() => fullProbe`delete from audit_event where request_id = ${rid}`);
  const trunc = await refusal(() => fullProbe.unsafe('truncate table audit_event'));
  for (const [label, r] of [['update', upd], ['delete', del], ['truncate', trunc]]) {
    assert.equal(r.kind, 'privilege', `${label}: ${r.msg}`);
    assert.equal(r.code, '42501', label);
  }

  // OWNER: holds every privilege and bypasses RLS, so only the trigger stands in the way.
  const ownerUpd = await refusal(() => observer`update audit_event set reason_code = ${'tampered'} where request_id = ${rid}`);
  const ownerDel = await refusal(() => observer`delete from audit_event where request_id = ${rid}`);
  for (const [label, r] of [['update', ownerUpd], ['delete', ownerDel]]) {
    assert.equal(r.kind, 'append_only_trigger', `${label}: ${r.msg}`);
    assert.equal(r.code, '23001', `${label} must be restrict_violation`);
    assert.match(r.msg, /audit_event is append-only/, label);
  }

  // The row is untouched by any of it.
  const [row] = await observer`select reason_code from audit_event where request_id = ${rid}`;
  assert.equal(row.reason_code, 's3_atomic');

  // HONEST LIMIT, asserted rather than implied: the trigger is ordinary schema the OWNER may
  // alter or drop. This suite proves ordinary DML cannot mutate an audit row; it does NOT claim
  // protection against a privileged DBA, and no test here pretends otherwise.
  const [{ owner_is_us }] = await observer`select (select relowner from pg_class
    where oid = 'public.audit_event'::regclass) = current_user::regrole::oid as owner_is_us`;
  assert.equal(owner_is_us, true, 'the observer IS the owner and could remove the trigger — outside this control');
});

// ---------------------------------------------------------------------------
// 7) membership honesty
// ---------------------------------------------------------------------------

test('S3-DB-14: effective privilege covers direct grants, PUBLIC, and inherited memberships', async () => {
  const [p] = await fullProbe`select
      pg_catalog.pg_has_role(current_user, ${AUDIT_ROLE}, 'USAGE') as inherits_audit,
      pg_catalog.pg_has_role(current_user, ${AUDIT_ROLE}, 'SET') as can_set_audit,
      pg_catalog.pg_has_role(current_user, ${RUNTIME_ROLE}, 'USAGE') as inherits_app,
      has_table_privilege('public.audit_event', 'INSERT') as ins,
      has_database_privilege(current_user, current_database(), 'TEMPORARY') as db_temp,
      has_database_privilege(current_user, current_database(), 'CREATE') as db_create,
      has_database_privilege('public', current_database(), 'TEMPORARY') as public_temp`;
  assert.deepEqual(
    [p.inherits_audit, p.can_set_audit, p.inherits_app, p.ins],
    [true, true, true, true],
    'the full principal reaches INSERT by INHERITED membership',
  );
  // The PUBLIC path is closed too, so the INSERT above is the membership and nothing else.
  assert.deepEqual([p.db_temp, p.db_create, p.public_temp], [false, false, false]);

  // No aclexplode entry grants anything on audit_event to PUBLIC.
  const publicGrants = await observer`select a.privilege_type from pg_class c,
      aclexplode(c.relacl) a where c.oid = 'public.audit_event'::regclass and a.grantee = 0`;
  assert.equal(publicGrants.length, 0, 'PUBLIC must hold nothing on audit_event');
});

test('S3-DB-15: a WITH INHERIT FALSE, SET TRUE membership is not treated as harmless', async () => {
  // The shape a single has_table_privilege reading cannot see: the capability is not inherited,
  // so every privilege probe reports false — and SET ROLE still reaches it.
  const [p] = await setroleProbe`select
      pg_catalog.pg_has_role(current_user, ${AUDIT_ROLE}, 'USAGE') as inherits,
      pg_catalog.pg_has_role(current_user, ${AUDIT_ROLE}, 'SET') as can_set,
      pg_catalog.pg_has_role(current_user, ${AUDIT_ROLE}, 'MEMBER') as is_member,
      has_table_privilege('public.audit_event', 'INSERT') as ins`;
  assert.equal(p.inherits, false, 'not inherited');
  assert.equal(p.can_set, true, 'but SET-able');
  assert.equal(p.is_member, true);
  assert.equal(p.ins, false, 'the privilege probe alone reports NO capability');

  // Without SET ROLE it genuinely cannot write.
  const before = await refusal(() => writeAuditEvent(
    storeScopeEvent('s3-atomic-setrole-before', { scopeType: 'none', tenantId: null, storeId: null }),
    { executor: setroleProbe },
  ));
  assert.equal(before.kind, 'privilege', before.msg);

  // With SET ROLE, in one transaction, it can — which is why a cutover check must probe both.
  await setroleProbe.begin(async (tx) => {
    await tx.unsafe(`set local role ${AUDIT_ROLE}`);
    const [q] = await tx`select current_user as who, has_table_privilege('public.audit_event', 'INSERT') as ins`;
    assert.equal(q.who, AUDIT_ROLE);
    assert.equal(q.ins, true, 'SET ROLE reaches the capability the inherit check reported false');
    await writeAuditEvent(
      storeScopeEvent('s3-atomic-setrole-after', { scopeType: 'none', tenantId: null, storeId: null }),
      { executor: tx },
    );
  });
  assert.equal(await auditCountAsOwner('s3-atomic-setrole-after'), 1);

  // WHAT THIS DOES NOT CLOSE: gate G-DBROLE. These are throwaway probe roles in a disposable
  // cluster. No persistent LOGIN role has been provisioned, and the cutover check for a real one
  // must repeat BOTH readings — inherited privilege AND SET-able membership — against it.
  const [{ n }] = await observer`select count(*)::int as n from pg_roles
    where rolcanlogin and rolname in (${RUNTIME_ROLE}, ${AUDIT_ROLE})`;
  assert.equal(n, 0, 'the privilege roles themselves must remain NOLOGIN');
});

// ---------------------------------------------------------------------------
// 8) containment
// ---------------------------------------------------------------------------

test('S3-DB-16: only disposable PostgreSQL was contacted, and nothing leaked out of it', async () => {
  // The executor's own guard, re-run here rather than trusted from module load: it accepts only
  // a task-owned socket under the temp root or loopback, and only a `tmpos_s1b_`-prefixed
  // database. It returns a bounded handle carrying no connection string.
  const handle = assertDisposableTestDsn(String(TARGET_DSN));
  assert.equal(handle.kind, 'disposable_test_dsn');
  assert.ok(['unix_socket', 'loopback'].includes(handle.hostKind), handle.hostKind);
  assert.match(handle.database, /^tmpos_s1b_/);
  const [{ db }] = await observer`select current_database() as db`;
  assert.equal(db, handle.database, 'the guard and the live session must name the same database');
  assert.match(db, /^tmpos_s1b_/, 'every statement in this suite ran against a disposable database');

  // The suite created exactly three roles, all prefixed and all dropped in `after`.
  const created = await observer`select rolname from pg_roles where rolname like 'tmpos_s3_%' order by rolname`;
  assert.deepEqual(
    created.map((r) => r.rolname),
    [FULL_PROBE, MUTATE_PROBE, SETROLE_PROBE].sort(),
  );
});
