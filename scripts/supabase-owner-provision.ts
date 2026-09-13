// Phase 4.0 M3 S4.1b C2B-R2 — owner-side database ACL provisioning (managed DEV only).
//
// WHY THIS FILE EXISTS. Migration 005 verifies that the database-level TEMPORARY privilege no
// longer reaches PUBLIC, and refuses to apply while it does — but it deliberately does NOT close
// it. Its own header states why: a REVOKE issued by a non-owner migration principal does not
// error, PostgreSQL emits only "WARNING: no privileges could be revoked", and the privilege
// survives. Shipping that would be a green that means nothing. Closing it is the database-OWNER
// provisioning step recorded under gate G-DBROLE, and 005 is immutable, so it cannot live there.
//
// SCOPE — this script performs exactly ONE database-level action and nothing else:
//     REVOKE TEMPORARY ON DATABASE <the verified current database> FROM PUBLIC
// plus the verification that the action actually took effect.
//
// NO ROLLBACK, DELIBERATELY. PostgreSQL would happily let the owner GRANT the privilege back,
// and this file still does not offer it. The accepted C2B rollback contract forbids restoring
// insecure PUBLIC TEMPORARY: re-opening temporary-object creation to every role in the database
// as an automatic reaction to some later, unrelated gate failure is a security regression
// wearing a rollback's clothes. If a later step fails, the hardened state is RETAINED and
// reported.
//
// SECURITY: never prints a connection string, hostname, project reference, database username,
// password, or CA content. Output is bounded booleans and stable reason codes.

import {
  MigrationExecutorError,
  assertManagedDevDsn,
  createManagedDevExecutor,
  describeManagedDsn,
  verifyManagedDevFingerprint,
} from '../server/platform-identity/migrationExecutor';

/** The DEV confirmation token (a label, not a secret). */
const EXPECTED_DEV_TARGET = 'tmpos2026-dev';
/** The managed database this recovery path may ever address. */
const EXPECTED_MANAGED_DATABASE = 'postgres';
/** Durable DEV-only audit actions that identify this specific database (identity signal C). */
const REQUIRED_AUDIT_ACTIONS = [
  'bcp.platform.system_owner_provisioning',
  'bcp.platform.system_owner_provisioning_compensation',
] as const;
const EXPECTED_ACTIVE_SYSTEM_OWNERS = 2;
const EXPECTED_SUSPENDED_SYSTEM_OWNERS = 1;

const PRODUCTION_FORBIDDEN = 'owner_provision_production_forbidden';
const OPERATOR_GATE_UNSATISFIED = 'owner_provision_operator_gate_unsatisfied';
const TARGET_UNVERIFIED = 'owner_provision_target_unverified';
const AUTHORITY_MISSING = 'owner_provision_authority_missing';
const VERIFY_FAILED = 'owner_provision_verify_failed';
const EXIT = 2;

const argv = process.argv.slice(2);
const hasFlag = (f: string): boolean => argv.includes(f);

function refuse(code: string, message: string): never {
  console.error(`[owner-provision] REFUSED: ${code} — ${message}`);
  process.exit(EXIT);
}

async function main(): Promise<void> {
  // 1) Production is hard-blocked outright, before anything else is considered.
  if (process.env.NODE_ENV === 'production') {
    refuse(PRODUCTION_FORBIDDEN, 'NODE_ENV=production; this path is DEV-only and no connection was attempted');
  }

  // 2) Operator intent — identity signal class A. A label compared to a repository constant is
  //    an ATTESTATION, not proof of target; it is necessary, never sufficient.
  const missing: string[] = [];
  if (!hasFlag('--revoke-public-temporary')) missing.push('--revoke-public-temporary');
  if (!hasFlag('--confirm-dev')) missing.push('--confirm-dev');
  if (process.env.ALLOW_OWNER_ACL_PROVISION !== '1') missing.push('ALLOW_OWNER_ACL_PROVISION=1');
  if (process.env.CONFIRM_SUPABASE_TARGET !== EXPECTED_DEV_TARGET) missing.push('CONFIRM_SUPABASE_TARGET=<dev target label>');
  if (missing.length > 0) {
    refuse(OPERATOR_GATE_UNSATISFIED, `requires: ${missing.join(', ')}. No connection was attempted.`);
  }

  // 3) Endpoint-derived consistency — identity signal class B. The DSN's project reference must
  //    agree with an INDEPENDENTLY configured project URL. Both are read from the environment;
  //    neither is accepted from a CLI argument, so the target cannot be redirected by a typo or
  //    a hostile argv.
  let dsn;
  try {
    dsn = assertManagedDevDsn(process.env.SUPABASE_DATABASE_URL, process.env.SUPABASE_URL, EXPECTED_MANAGED_DATABASE);
  } catch (err) {
    const code = err instanceof MigrationExecutorError ? err.code : TARGET_UNVERIFIED;
    refuse(code, 'the managed target did not validate; no connection was attempted');
  }
  const shape = describeManagedDsn(dsn);
  console.log(`[owner-provision] target: endpointFamily=${shape.endpointFamily} database=${shape.database}`);

  const handle = await createManagedDevExecutor(dsn);
  let changed = false;
  // Refusals inside the try are DEFERRED: refuse() calls process.exit(), and a `finally` does
  // not run through process.exit — so refusing inline would skip the disposal below and leak a
  // live connection to a managed database.
  let deferred: [string, string] | null = null;
  try {
    await handle.adapter.reserve('session');

    // 4) Live fingerprint — identity signal class C, and the FIRST check that can tell this
    //    database apart from any other of the same shape. It necessarily runs AFTER a connection
    //    exists, which is exactly why no mutation may be attempted before it passes.
    const fingerprint = await verifyManagedDevFingerprint(handle.catalog, {
      requiredAuditActions: REQUIRED_AUDIT_ACTIONS,
      activeSystemOwners: EXPECTED_ACTIVE_SYSTEM_OWNERS,
      suspendedSystemOwners: EXPECTED_SUSPENDED_SYSTEM_OWNERS,
    });
    if (fingerprint.length > 0) {
      console.error(`[owner-provision] fingerprint failures: ${fingerprint.length}`);
      for (const f of fingerprint) console.error(`  - ${f}`);
      deferred = [TARGET_UNVERIFIED, 'the live database is not the expected DEV target; NOTHING was mutated'];
      return;
    }
    console.log('[owner-provision] live DEV fingerprint: OK');

    // 5) Authority. A non-owner REVOKE is a silent no-op that emits only a warning, so the
    //    absence of an error proves nothing — ownership must be established BEFORE acting.
    const isOwner = await handle.ownerAcl.isCurrentPrincipalDatabaseOwner();
    if (!isOwner) {
      deferred = [AUTHORITY_MISSING, 'the connected principal does not own this database; a non-owner REVOKE would be a silent no-op'];
      return;
    }

    const before = await handle.ownerAcl.databasePublicPrivileges();
    console.log(`[owner-provision] before: PUBLIC CREATE=${before.create} PUBLIC TEMPORARY=${before.temporary}`);

    if (!before.temporary) {
      // Idempotent: an already-hardened database is a success, not an error, and needs no action.
      console.log('[owner-provision] PUBLIC TEMPORARY is already closed; no action taken.');
    } else {
      await handle.ownerAcl.revokeTemporaryFromPublic();
      changed = true;
    }

    // 6) Verify the action actually took effect. A PostgreSQL warning is NOT success.
    const after = await handle.ownerAcl.databasePublicPrivileges();
    console.log(`[owner-provision] after:  PUBLIC CREATE=${after.create} PUBLIC TEMPORARY=${after.temporary}`);
    if (after.temporary) {
      deferred = [VERIFY_FAILED, 'PUBLIC still holds database TEMPORARY after the revoke'];
      return;
    }
    if (after.create) {
      // Migration 005's gate checks BOTH database-level TEMPORARY *and* CREATE, so closing only
      // TEMPORARY and reporting COMPLETE would send the operator into an apply that still aborts
      // — at the exact step this provisioning was meant to unblock. Closing CREATE is a separate
      // owner action and is NOT authorized here, so this reports it rather than acting on it.
      deferred = [
        VERIFY_FAILED,
        before.create
          ? 'PUBLIC still holds database CREATE; migration 005 will refuse until a separate owner action closes it'
          : 'PUBLIC CREATE was broadened during this operation',
      ];
      return;
    }
    console.log(`[owner-provision] COMPLETE — PUBLIC TEMPORARY closed=${!after.temporary} PUBLIC CREATE closed=${!after.create} changed=${changed}`);
    console.log('[owner-provision] NOTE: this hardening is intentionally NOT reversible by this tool.');
  } finally {
    await handle.dispose();
  }
  // Dispose FIRST, refuse second.
  if (deferred !== null) refuse(deferred[0], deferred[1]);
}

main().catch((err) => {
  const code = err instanceof MigrationExecutorError ? err.code : 'owner_provision_failed';
  console.error(`[owner-provision] FATAL: ${code}`);
  process.exitCode = 1;
});
