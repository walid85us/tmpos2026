// Phase 4.0 M3 S1/S1.1 — static contract over the real migration files. DATABASE-FREE.
//
// Reads the seventeen committed migration pairs through the engine's Node fs port (node:fs
// only — never a database) and asserts inventory, pairing, ordering, byte-fingerprint
// immutability, default transaction mode, and the absence of any credential / provider
// identifier / generated artifact. This is the ratchet that a historical migration was
// not silently altered: the checksums below are pinned to the exact committed bytes.
//
// S1.1 additions — REAL-filesystem integrity proofs against temporary fixtures (removed
// in `finally`): symlinks (inside and outside the root), directories with migration
// names, canonical-root prefix confusion, post-discovery file mutation (TOCTOU), strict
// UTF-8, and bounded errors that expose neither SQL nor absolute fixture paths. A FIFO/
// socket/device entry is modeled at the engine level ('other' lstat class) in
// server/platform-identity/migrationEngine.test.ts — Node cannot portably create one.

import test from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

import {
  createNodeFsPort,
  discoverMigrations,
  pairMigrations,
  sha256Hex,
  isContained,
  MigrationEngineError,
  ENGINE_CODES,
} from '../../server/platform-identity/migrationEngine.ts';
// Side-effect-free: the runner's main() is entry-guarded (the frozen discovery suite
// imports the same module the same way).
import { MIN_SUITES, REQUIRED_SENTINELS } from '../../scripts/run-tests.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..');
const REL_DIR = 'server/platform-identity/migrations';
const ABS_DIR = join(REPO, REL_DIR);

// Pinned SHA-256 of the EXACT committed bytes of each migration file. If a historical
// migration is edited (even a comment), its checksum changes and this ratchet fails —
// which is the whole point (forward-only: historical migrations are immutable).
const PINNED = {
  '001_platform_identity.up.sql': 'f763a39943c519d8779afd354bac44ae4d8a0e26b36abcb2b8b19d27e8b1f305',
  '001_platform_identity.down.sql': '171094019903694c461587adb43f1d87c339f3c7522f0b4d3bd1a63479341a92',
  '002_authorization_audit_foundation.up.sql': '98fa4c30e8bd97c57ef9e754aa9073556e749a0815a653a6e1cbb395895cf2e4',
  '002_authorization_audit_foundation.down.sql': 'd0cb89a20a753a5cab0baa894b9f371d439b1aea20a5c8e6c9a6c0c9b325055f',
  '003_platform_role_vocabulary_alignment.up.sql': '03757459a1774ea10494c5ffeeaa6950866ee6952c5e85fce9c6fbe49d3eed94',
  '003_platform_role_vocabulary_alignment.down.sql': 'ce1c2a5bb4f05707cde332a096523cf92c8620651f1373533f5d287785379aa5',
  '004_identity_link.up.sql': 'a1cc9dad8092fe510c7745b92281d88617ab20af616e0e1942bfe808341d7bc6',
  '004_identity_link.down.sql': '21eb505cc6d24bac771e52f5c2f3418d1dd7a844fdf4c9a1ea4f3a15dfabba6b',
  // Phase 4.0 M3 S2 — privilege roles, tenant/store RLS policies, the least-privilege grant
  // matrix and the audit scope constraint. Its SHAPE is judged by
  // tests/quality/migration-005-contract.test.mjs and its SEMANTICS by
  // tests/db/rlsIsolation.integration.test.mjs; here it joins the immutability ratchet.
  //
  // ONE-TIME OWNER-AUTHORISED CORRECTION (Phase 4.0 M3 S2.2). These two values REPLACE the
  // checksums first pinned at commit 090818da (up 2dc62eb9…, down cd38cb4a…). The exception was
  // granted explicitly, on a narrow and verified basis:
  //   * the old bytes were committed but, per the project record, never applied to a managed,
  //     production, persistent or application database — only to disposable test clusters — so
  //     no deployed schema can disagree with the corrected file;
  //   * they carried two reproduced defects: the tenant runtime could create TEMPORARY objects
  //     through the database-level privilege PostgreSQL grants to PUBLIC by default, and the
  //     rollback removed roles on the strength of their NAME, deleting operator-owned state
  //     migration 005 had never created.
  // The values below are now the immutable ones. This does NOT relax the forward-only policy:
  // a migration that has been applied anywhere, or that is not covered by an explicit owner
  // authorisation of this kind, is still corrected by a NEW migration and never edited.
  '005_principal_separation_rls_foundation.up.sql': 'a4a61385beedf98194fb427bcd528704b068d7ca2947a9713d7a1a1c87157bda',
  '005_principal_separation_rls_foundation.down.sql': 'c198c0fa9c481cb2fe99c7f841aba4023bfbbef06663e2948755abca1d74db64',
  // Phase 4.0 M6-PG-P4 — the transactional store for the idempotency, command-transaction and outbox ports.
  // Its SEMANTICS are proved by tests/db/transactionalStore.integration.test.mjs against disposable PostgreSQL
  // only; it has been applied to no managed, persistent or application database. While it is pending, the
  // managed apply of 005 refuses at its exact-[005] plan gate (tests/quality/managed-m005-launcher.test.mjs).
  '006_m6_transactional_store.up.sql': '091933e19559d1d109580dd86cd381ada12398fbe1a93b011ac97e15c23dc68c',
  '006_m6_transactional_store.down.sql': '767afd8a194b5bfe4b8541af25342f12346d219b8bc046d588ddb18cf3d44ecc',
  // Phase 4.0 M5-ID-P1 — the trusted principal-resolution and transaction-revalidation boundary: three
  // routines in 006's schema, no table, no column, no role. Proved by
  // tests/db/principalResolution.integration.test.mjs against disposable PostgreSQL only; applied to no
  // managed, persistent or application database. It changes no exact-[005] gate: the derived managed
  // plan simply lengthens, and that gate refuses any plan that is not exactly [005].
  '007_m5_trusted_principal_resolution.up.sql': 'a3a9aa98b299cd343e35df6b9048ea1468f5b11668e7ea6996045cb514f7bcbe',
  '007_m5_trusted_principal_resolution.down.sql': '1f3a130489d2c19a9cba27ece60d2937fa92956bf7b1d5e13cfa63602b697984',
  // Phase 4.0 M5-GIAM-D1-P1 — the first server-authorized business command (owner decision D1): the tenant's row version,
  // the trigger that alone moves it, and one SECURITY DEFINER operation in its own schema, tmpos_command. Proved by
  // tests/db/tenantDisplayName.integration.test.mjs against disposable PostgreSQL only; applied to no managed, persistent or
  // application database. Owner decision D4 fixes a future managed apply to the complete contiguous chain through the newest
  // committed migration, which this stage does not authorize; the exact-[005] gate is unchanged and still refuses the longer plan.
  '008_m5_tenant_display_name_command.up.sql': 'cfaa5724bd4b9bb1681f6a8633a282aa8dd3ea3ed3d3cf9a89a8e28d33a51d5e',
  '008_m5_tenant_display_name_command.down.sql': '532ef95098745971cabbef107fe8a8b1fad02fe7f29e4b8722b1a38e3362718f',
  // Phase 4.0 M5-GIAM-D1-P1-R1 — hardening the first command: the exact platform-authority routine and the Bidi_Control-refusing
  // display-name operation (both in tmpos_command, EXECUTE to tmpos_app; 008's operation no longer granted to it), the audit
  // record's subject_tenant_id and its index, and 005's UPDATE(display_name) revoked from tmpos_app. Proved by
  // tests/db/tenantDisplayName.integration.test.mjs against disposable PostgreSQL only; applied to no managed, persistent or
  // application database. D4 now names the contiguous chain through 009; the exact-[005] gate is unchanged and still refuses.
  '009_m5_first_command_hardening.up.sql': '032842618ee71ca1e523502a75d9824ea5c922236e03670defb99f0e0764b54c',
  '009_m5_first_command_hardening.down.sql': 'b08558c05c36b0248713409cb2d1924f9d773eb5301707ff77d792a50f75f2b3',
  // Phase 4.0 M5-GIAM-D1-P2 — the tenant lifecycle command: one SECURITY DEFINER operation in tmpos_command that moves a tenant
  // between active and suspended at an expected row version (EXECUTE to tmpos_app alone), and public.tenant.access_version, the
  // witness a tenant/store session is admitted against, which no role may write. Nothing is revoked: no role ever held a
  // privilege on tenant.status. Proved by tests/db/tenantStatus.integration.test.mjs against disposable PostgreSQL only; applied
  // to no managed, persistent or application database. D4 now names the contiguous chain through 010; the exact-[005] gate is
  // unchanged and still refuses the longer plan.
  '010_m5_tenant_lifecycle_command.up.sql': 'a3a2f41107df582826c20001a91edff569507582e1d90df6c339778b2fb8748b',
  '010_m5_tenant_lifecycle_command.down.sql': '02b1633e9f22fa92ca458131c97ac2a79b6499b38802e67fc2c125cf6c240297',
  // Phase 4.0 M5-GIAM-D1-P2-R1 — the tenant session store and the composed tenant/store admission read, in their OWN schema
  // tmpos_session: one table no role may read directly, five session routines and one admission routine (EXECUTE to tmpos_app
  // alone, none of it grantable). The admission routine digests the actor's whole standing — every grant, and every grant's
  // tenant access_version from 010 — so a suspension and a later reactivation cannot return the same answer. Proved by
  // tests/db/tenantAdmission.integration.test.mjs against disposable PostgreSQL only; applied to no managed, persistent or
  // application database. D4 now names the contiguous chain through 011; the exact-[005] gate is unchanged and still refuses.
  '011_m5_tenant_admission.up.sql': 'b3944f909c4298f700746784cd52385c5410acd3a15ad39f0a7138d5d6911c7d',
  '011_m5_tenant_admission.down.sql': 'c272ab6656c7a37e62d007bf60404bfaebe21a40ef95dc906efacd7914f7495b',
  // Phase 4.0 M5-GIAM-D1-P3 — the platform tenant directory, in its OWN schema tmpos_directory: one STABLE SECURITY DEFINER
  // read (EXECUTE to tmpos_app alone, not grantable) that answers a bounded keyset page of (tenant id, display name, status,
  // row version) only while the caller's named platform grant still holds. No table, no write, no role. Proved by
  // tests/db/tenantDirectory.integration.test.mjs against disposable PostgreSQL only; applied to no managed, persistent or
  // application database. D4 now names the contiguous chain through 012; the exact-[005] gate is unchanged and still refuses.
  '012_m5_platform_tenant_directory.up.sql': '6e71d4d5223576b86bd6acc46ed429bbcff64390d69a6d3980a3bc9baf3efce6',
  '012_m5_platform_tenant_directory.down.sql': '9d359194edc3031ff5dd1dd60bd54bbe448d850c58d393876993cb5301f47a89',
  // Phase 4.0 M5-GIAM-D1-P4 — durable platform-administrator admission, in its OWN schema tmpos_admission: one per-actor
  // platform authority version that only increases (RLS on, no grant to any role, no foreign key: it outlives the account),
  // moved by one SECURITY DEFINER trigger function granted to nobody through four AFTER INSERT/UPDATE/DELETE row triggers,
  // each ENABLE ALWAYS so a replica-mode session moves it too — on public.platform_identity (its anchor only: internal user
  // id, provider and provider uid), app_user, identity_link and user_membership (a platform-scope grant only, before or
  // after the write) — on every change to the actor's standing but an updated_at-only UPDATE; and one STABLE SECURITY
  // DEFINER read (EXECUTE to tmpos_app alone, not grantable) answering 007's resolution narrowed to platform grants plus
  // that version. Its only change to earlier objects is those four triggers, which its postcondition requires exactly,
  // and the up and the rollback each refuse while an administrative session exists.
  // Proved by tests/db/platformAdmission.integration.test.mjs against disposable PostgreSQL only; applied to no managed,
  // persistent or application database. D4 now names the contiguous chain through 013; the exact-[005] gate is unchanged
  // and still refuses.
  '013_m5_platform_admission.up.sql': 'c6df3d2e3559270243a52477c8acc9b8d7cca71c576acc00caf8d267a5151f7a',
  '013_m5_platform_admission.down.sql': 'b0d07b580154e6e387d8093b98ad2889273dcd659c0b53aa15a03cf6c3a0b0ab',
  // Phase 4.0 M6-RATE-P2 — the distributed rate-limit store, in its OWN schema tmpos_rate_limit: two tables (the bucket
  // table keyed by namespace/dimension/limiter key/limit/window, and a one-row key-fingerprint table) and three routines
  // — a key-admission check (SECURITY INVOKER), a consume (SECURITY DEFINER, EXECUTE to tmpos_app alone) that locks and
  // atomically updates or opens a bucket against the database's own clock and reclaims a bounded number of expired
  // buckets, and a probe (EXECUTE to tmpos_app alone) that never touches a bucket. No new role, no type, no trigger, no
  // sequence, and nothing an earlier migration created changes: migrations 001-013 are untouched, byte for byte. The
  // rollback refuses (object_in_use) while any bucket has not yet expired. Proved by tests/db/rateLimiter.integration.
  // test.mjs and tests/db/rateLimitRuntime.integration.test.mjs against disposable PostgreSQL only; applied to no
  // managed, persistent or application database. D4 now names the contiguous chain through 014; the exact-[005] gate is
  // unchanged and still refuses.
  '014_m6_distributed_rate_limit.up.sql': '48ff3e4bc2b3d4c6ee3cc2c54e4111d8647669d349d1449b249303a9dcc4cf62',
  '014_m6_distributed_rate_limit.down.sql': '72aab6e28ff512e2c8061cfae510e073466f4f5d5bb9ca9d27e3a5e333a63846',
  // Phase 4.0 M5-ADMIN-REVOKE-P1 — changer-side standing serialization: one SECURITY DEFINER trigger function in 013's
  // schema tmpos_admission, granted to nobody, fired BEFORE ROW and ENABLE ALWAYS by three triggers — UPDATE or DELETE on
  // public.platform_identity (when the anchor moves or goes), and INSERT or UPDATE on public.identity_link and on
  // public.user_membership (a link or grant inserted for, or re-pointed to, an actor) — that takes FOR KEY SHARE on the
  // account row of each actor the write moves, so the write waits for a command or login holding that account FOR UPDATE
  // (009), in replica mode too, where no foreign-key check or cascade runs. Its postcondition also refuses FORCE ROW LEVEL
  // SECURITY on public.app_user. No table, no grant, no role, no data change, and nothing an earlier migration created
  // changes but those three triggers: migrations 001-014 are untouched, byte for byte.
  // Proved by tests/db/platformAdmission.integration.test.mjs against disposable PostgreSQL only; applied to no managed,
  // persistent or application database. D4 now names the contiguous chain through 015; the exact-[005] gate is unchanged
  // and still refuses.
  '015_m5_admin_standing_serialization.up.sql': 'a3b1514ee65703d29b3becf78ef338e8966eb0ee12550ecd5e1f19d357154f4e',
  '015_m5_admin_standing_serialization.down.sql': 'c065b4129bf5499b762d76288b89bd9358845dd274f2eda6484d367b98822e3c',
  // Phase 4.0 M5-TENANT-SESSION-P1 — tenant session ordering, in 011's schema tmpos_session: public.store.access_version
  // (010's column, for a store); a BEFORE ROW trigger, ENABLE ALWAYS, on public.tenant (UPDATE) and public.store (INSERT or
  // UPDATE) that starts a new store at one, moves the access version by exactly one on every status change or store
  // re-parenting, whoever writes it, and refuses any other change of it and any change of a key; a per-actor tenant grant
  // version with no foreign key, row security on and no grant, moved by AFTER ROW triggers, ENABLE ALWAYS, on every write
  // to a tenant- or store-scope grant (cascades included) and on every delete of a tenant or store a grant names (as a
  // replica too); the v2 admission read (011's answer plus each grant's store access version, the platform authority
  // version and the grant version); and the hold a tenant login takes first (the account FOR UPDATE; links, every grant,
  // and every tenant and store they name FOR SHARE). EXECUTE on the two routines to tmpos_app alone; the up and the
  // rollback each refuse while a tenant session exists. Nothing an earlier migration created changes but that column and
  // those five triggers: migrations 001-015 are untouched, byte for byte. Proved against disposable PostgreSQL only;
  // applied to no managed, persistent or application database. D4 now names the contiguous chain through 016; the
  // exact-[005] gate is unchanged and still refuses.
  '016_m5_tenant_session_ordering.up.sql': 'e5633336da5376a747d05aabac21b73ca9ebcf4743a9436081c58322ac07e9be',
  '016_m5_tenant_session_ordering.down.sql': 'acf8a95610c97c8dca496da6fad4a3618a49a7268a9a82237ecb5849040728a6',
  // Phase 4.0 M7A-CUSTOMERS-P1 — the tenant customer directory, in its OWN schema tmpos_customer: the minimal durable
  // customer identity (id, owning tenant, name) and the one bounded keyset read a tenant session lists it through
  // (docs/phase-4/05, docs/phase-4/10 ADR-32). The routine re-checks the caller's named authority in the same
  // snapshot as the rows it returns — account not denied, security version equal, exactly one active tenant-scope
  // grant and it the named membership, role and tenant, tenant status admitting access — and decides no permission
  // itself. tmpos_app holds USAGE on the schema and EXECUTE on the routine and nothing else; row level security is
  // enabled on the table with no policy, so no runtime grant could read it regardless. Nothing an earlier migration
  // created changes: migrations 001-016 are untouched, byte for byte. Proved against disposable PostgreSQL only;
  // applied to no managed, persistent or application database. D4 now names the contiguous chain through 017; the
  // exact-[005] gate is unchanged and still refuses.
  '017_m7a_customer_directory.up.sql': '1fea57a1c4bdba7efdb5da0f34893879a6b8aa741c1f117b2dcf63259f85d66d',
  '017_m7a_customer_directory.down.sql': '8e6b095959670d2c53d139be3a3c00f4c06544b72c264d6febf4373ef67eb440',
  // Phase 4.0 M7A-CUSTOMERS-P2 — the tenant session mint, in its OWN schema tmpos_mint: the issuer key table (one row,
  // 32-64 bytes, installed by the owner out of band, never by a migration), the mint ledger (no foreign key, pruned a day
  // after expiry), two helpers granted to nobody (HMAC-SHA256 from core functions, the netstring mint message), and three
  // routines tmpos_app may execute: every session create (a tenant one only with an HMAC under the issuer key over all
  // eleven values; every argument of both audiences checked first), the customer read bound to a minted, live session
  // under the key installed now (017's page run as its owner), and the key check (docs/phase-4/10 ADR-33). It revokes
  // tmpos_app's EXECUTE on 011's m5_session_create and on 017's m7a_customer_page: those two ACL changes are its only
  // effect on earlier objects, and migrations 001-017 are untouched, byte for byte. Proved against disposable PostgreSQL
  // only; applied to no managed, persistent or application database. D4 now names the contiguous chain through 018; the
  // exact-[005] gate is unchanged and still refuses.
  '018_m7a_tenant_session_mint.up.sql': 'e57c72b77e90bd6348e70c42912f073348c90a40e59e75e95c0b6689adc746cf',
  '018_m7a_tenant_session_mint.down.sql': '03ee4ed497f2774954247520bc2207709791f1b9041357ce0f32fe0adf8c3845',
  // Phase 4.0 M7A-CUSTOMERS-P3 — tenant customer creation, in its OWN schema tmpos_customer_write: one SECURITY DEFINER
  // VOLATILE routine whose only authority argument is a minted tenant session's key. An unlocked pre-check first refuses,
  // taking no row lock, a key whose session is not live on the database clock or was minted under another issuer key;
  // then it takes 016's hold, the session row and its mint-ledger row, and the issuer key row, re-reads the standing
  // digest on the database clock after those waits, and inserts one row of 017's table in the tenant it derived — only
  // for an active/trialing account and tenant, exactly one tenant grant, and a role holding Customers >= Create (store_owner, manager, sales_staff; pinned to the catalog by
  // tests/db/customerCreateRoutine.integration.test.mjs). tmpos_app gains USAGE and EXECUTE only, never a table privilege;
  // migrations 001-018 are untouched, byte for byte. Proved against disposable PostgreSQL only; applied to no managed,
  // persistent or application database. D4 now names the contiguous chain through 019; the exact-[005] gate is unchanged
  // and still refuses.
  '019_m7a_customer_create.up.sql': '1d260ca4cc98fe3ee6df18403da16db4a21712c064d3c911b195980a0496e0e2',
  '019_m7a_customer_create.down.sql': '83e66b3fbe51f3b5ae3939db7ee9df1bfa176ea4addbacc10737f0b87189e5bb',
  // Phase 4.0 M7A-CUSTOMERS-P3-R1 — owner-edited tenant role levels, in its OWN schema tmpos_role: one table of an owner's
  // durable Customers level per tenant and editable built-in role (manager, technician, sales_staff; the runtime role holds
  // no privilege on it), the levels read every tenant route decision makes, the owner's session-bound edit, and successors
  // of 019's create and 018's page_v2 that decide the grant's role on its CURRENT Customers level under a lock on that
  // role's row. It revokes tmpos_app's EXECUTE on 019's create and 018's page_v2 and USAGE on tmpos_customer_write: those
  // ACL changes are its only effect on earlier objects, and migrations 001-019 are untouched, byte for byte. Proved against
  // disposable PostgreSQL only; applied to no managed, persistent or application database. D4 now names the contiguous
  // chain through 020; the exact-[005] gate is unchanged and still refuses.
  '020_m7a_tenant_role_levels.up.sql': '0a289ad4dcefdb4a5a260aed7a2121d93e23c5efe4f3550eb9fdc39094d9acfe',
  '020_m7a_tenant_role_levels.down.sql': '182718aaf001567531ed9b3737e1cd723e040c4d9305f76a60e9c1c99f8185fc',
  // Phase 4.0 M7A-CUSTOMERS-P4 — the owner's Customers level edit made conditional (DA-125), in its OWN schema
  // tmpos_role_edit: a per-row edit counter (no row is version 0; every effective edit exactly +1, a restored default
  // included, so no ABA; no foreign key, no seed, no clock), the owner's one-snapshot read-back of level and version, and
  // 020's edit copied with two preconditions — the session's tenant must be the one the owner reviewed, and the version the
  // one read (checked unlocked, then under the role row FOR UPDATE) — else nothing is written. It revokes tmpos_app's
  // EXECUTE on 020's unconditional m7a_role_level_set: that ACL change is its only effect on earlier objects, and
  // migrations 001-020 are untouched, byte for byte. Its rollback refuses while a version row exists and does not give that
  // EXECUTE back (forward-only in effect, fail closed). Proved against disposable PostgreSQL only; applied to no managed,
  // persistent or application database. D4 now names the contiguous chain through 021; the exact-[005] gate is unchanged
  // and still refuses.
  '021_m7a_role_level_precondition.up.sql': '139a63b193e7c17c0b6770766eee6c3e70ba8b7bd0e65937cf3d7d05bd7b7876',
  '021_m7a_role_level_precondition.down.sql': 'dcde77eb338d09142dc3a0eb5df5257314ce48c9f7eb94e472856a26ff71ec27',
};

const port = createNodeFsPort(ABS_DIR, REL_DIR);
const descriptors = discoverMigrations(port);

test('the migrations directory holds exactly the forty-two expected files', () => {
  const names = descriptors.map((d) => d.relPath.slice(`${REL_DIR}/`.length)).sort();
  assert.deepEqual(names, Object.keys(PINNED).sort());
});

test('every version pairs an up with a down, in stable numeric order', () => {
  const pairs = pairMigrations(descriptors);
  assert.deepEqual(pairs.map((p) => p.version), ['001', '002', '003', '004', '005', '006', '007', '008', '009', '010', '011', '012', '013', '014', '015', '016', '017', '018', '019', '020', '021']);
  for (const p of pairs) {
    assert.equal(p.up.direction, 'up');
    assert.equal(p.down.direction, 'down');
    assert.equal(p.up.version, p.down.version);
  }
});

test('each migration file matches its pinned byte-fingerprint (historical immutability)', () => {
  for (const [basename, expected] of Object.entries(PINNED)) {
    const actual = sha256Hex(readFileSync(join(ABS_DIR, basename)));
    assert.equal(actual, expected, `checksum drift on ${basename} — a historical migration was altered`);
  }
  // The engine's own discovery must agree with the pinned checksums.
  for (const d of descriptors) {
    const basename = d.relPath.slice(`${REL_DIR}/`.length);
    assert.equal(d.checksum, PINNED[basename], `engine checksum mismatch on ${basename}`);
  }
});

test('there is no duplicate (version, direction)', () => {
  const keys = descriptors.map((d) => `${d.version}.${d.direction}`);
  assert.equal(new Set(keys).size, keys.length);
});

test('the existing migrations default to transaction mode "required"', () => {
  assert.ok(descriptors.every((d) => d.transactionMode === 'required'));
});

test('no migration file carries a credential, provider identifier, or generated artifact', () => {
  const forbidden = [
    /postgres(ql)?:\/\//i,          // a connection string
    /\.supabase\.co/i,               // a project host
    /SUPABASE_DATABASE_URL\s*=/i,    // an assigned secret value
    /service_role/i,                 // a service-role reference
    /-----BEGIN [A-Z ]+PRIVATE KEY/, // a private key
    /sourceMappingURL/i,             // a generated artifact
  ];
  for (const basename of Object.keys(PINNED)) {
    const text = readFileSync(join(ABS_DIR, basename), 'utf8');
    for (const re of forbidden) {
      assert.ok(!re.test(text), `${basename} must not contain ${re}`);
    }
  }
});

// --- S1.1: checksum-to-execution artifact binding on the REAL files ---------

test('every real descriptor carries a frozen artifact whose exact bytes hash to the pinned checksum', () => {
  for (const d of descriptors) {
    const basename = d.relPath.slice(`${REL_DIR}/`.length);
    assert.ok(Object.isFrozen(d.artifact), `${basename}: the artifact must be immutable`);
    assert.equal(sha256Hex(d.artifact.bytes), PINNED[basename], `${basename}: artifact bytes must hash to the pinned checksum`);
    assert.equal(d.artifact.checksum, d.checksum, `${basename}: artifact and descriptor checksums agree`);
    // Strict UTF-8 decode round-trips: the sql handed to execution IS the checksummed bytes.
    assert.deepEqual(new Uint8Array(Buffer.from(d.artifact.sql, 'utf8')), new Uint8Array(d.artifact.bytes), `${basename}: sql round-trips to the exact bytes`);
  }
});

// --- S1.1: REAL-filesystem integrity fixtures (removed in finally) -----------

/** Run `fn` against a fresh temporary directory; ALWAYS remove it afterwards. */
function inTemp(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'tmpos-s11-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const codeOf = (fn) => {
  try { fn(); return 'NO_THROW'; } catch (e) { return e instanceof MigrationEngineError ? e.code : `OTHER:${String(e)}`; }
};

test('a symlink INSIDE the migration directory is rejected (discovery and direct read)', () => {
  inTemp((dir) => {
    writeFileSync(join(dir, '001_alpha.down.sql'), 'drop table alpha;\n');
    symlinkSync('001_alpha.down.sql', join(dir, '001_alpha.up.sql')); // link → regular sibling
    const p = createNodeFsPort(dir, 'fixture');
    assert.equal(codeOf(() => discoverMigrations(p)), ENGINE_CODES.NONREGULAR_MIGRATION_ENTRY);
    // The no-follow read refuses the symlink even when called directly (O_NOFOLLOW).
    assert.equal(codeOf(() => p.readBytes('001_alpha.up.sql')), ENGINE_CODES.NONREGULAR_MIGRATION_ENTRY);
  });
});

test('a symlink pointing OUTSIDE the migration directory is rejected and leaks no path', () => {
  inTemp((parent) => {
    const dir = join(parent, 'migrations');
    mkdirSync(dir);
    writeFileSync(join(parent, 'outside_payload.sql'), 'select 1; -- OUTSIDE_PAYLOAD\n');
    symlinkSync('../outside_payload.sql', join(dir, '001_alpha.up.sql'));
    const p = createNodeFsPort(dir, 'fixture');
    try {
      discoverMigrations(p);
      assert.fail('expected the escaping symlink to be rejected');
    } catch (e) {
      assert.ok(e instanceof MigrationEngineError);
      assert.equal(e.code, ENGINE_CODES.NONREGULAR_MIGRATION_ENTRY);
      assert.ok(!e.message.includes(parent), 'no absolute fixture path in the error');
      assert.ok(!e.message.includes('OUTSIDE_PAYLOAD'), 'no target content in the error');
    }
    assert.equal(codeOf(() => p.readBytes('001_alpha.up.sql')), ENGINE_CODES.NONREGULAR_MIGRATION_ENTRY);
  });
});

test('a DIRECTORY carrying a valid migration filename is rejected', () => {
  inTemp((dir) => {
    mkdirSync(join(dir, '001_alpha.up.sql'));
    const p = createNodeFsPort(dir, 'fixture');
    assert.equal(codeOf(() => discoverMigrations(p)), ENGINE_CODES.NONREGULAR_MIGRATION_ENTRY);
    assert.equal(codeOf(() => p.readBytes('001_alpha.up.sql')), ENGINE_CODES.NONREGULAR_MIGRATION_ENTRY);
  });
});

test('canonical containment refuses sibling roots that share the text prefix', () => {
  assert.equal(isContained('/a/mig', '/a/mig/001_x.up.sql'), true);
  assert.equal(isContained('/a/mig', '/a/mig-evil/001_x.up.sql'), false, 'a prefix-sharing sibling is OUTSIDE');
  assert.equal(isContained('/a/mig', '/a/mig'), false, 'the root itself is not a contained entry');
  assert.equal(isContained('/a/mig', '/a/mig/../mig-evil/001_x.up.sql'), false, 'traversal cannot re-enter a sibling');
  assert.equal(isContained('/a/mig', '001_x.up.sql'), false, 'a RELATIVE candidate is never judged against the CWD — fail closed');
});

test('mutating a migration file AFTER discovery cannot change the checksum-bound artifact (TOCTOU)', () => {
  inTemp((dir) => {
    const original = 'create table alpha();\n';
    writeFileSync(join(dir, '001_alpha.up.sql'), original);
    writeFileSync(join(dir, '001_alpha.down.sql'), 'drop table alpha;\n');
    const p = createNodeFsPort(dir, 'fixture');
    const up = discoverMigrations(p).find((d) => d.direction === 'up');
    const pinned = up.checksum;

    // Attacker/operator mutates the file after discovery, before "execution".
    writeFileSync(join(dir, '001_alpha.up.sql'), '-- ALTERED AFTER DISCOVERY\ndrop table users;\n');
    assert.ok(readFileSync(join(dir, '001_alpha.up.sql'), 'utf8').includes('ALTERED'), 'the on-disk file really changed');

    // The artifact was read ONCE at discovery: its bytes still hash to the checksum and
    // its sql is the original text — execution receives this artifact, never the path.
    assert.equal(sha256Hex(up.artifact.bytes), pinned, 'artifact bytes are the checksummed bytes');
    assert.equal(up.artifact.sql, original, 'artifact sql is the discovery-time text');
    assert.ok(Object.isFrozen(up.artifact));
  });
});

test('invalid UTF-8 migration bytes fail closed with a bounded error and no fixture path', () => {
  inTemp((dir) => {
    writeFileSync(join(dir, '001_bad.up.sql'), Buffer.from([0x2d, 0x2d, 0xff, 0xfe, 0x0a]));
    const p = createNodeFsPort(dir, 'fixture');
    try {
      discoverMigrations(p);
      assert.fail('expected an encoding rejection');
    } catch (e) {
      assert.ok(e instanceof MigrationEngineError);
      assert.equal(e.code, ENGINE_CODES.INVALID_ENCODING);
      assert.ok(!e.message.includes(dir), 'no absolute fixture path in the error');
    }
  });
});

// --- S1.2: this suite's own wiring into the deterministic runner is guarded --
// The frozen discovery ratchet pins only the M2-era sentinels by literal path, so
// removing an S1 registration from REQUIRED_SENTINELS would otherwise fail nothing.

test('both S1 migration suites are registered deterministic-runner sentinels', () => {
  assert.ok(REQUIRED_SENTINELS.includes('server/platform-identity/migrationEngine.test.ts'),
    'the migration-engine suite must stay sentinel-registered');
  assert.ok(REQUIRED_SENTINELS.includes('tests/quality/migration-files-contract.test.mjs'),
    'this contract suite must stay sentinel-registered');
  assert.ok(Number.isInteger(MIN_SUITES) && MIN_SUITES >= 76,
    'the suite-count ratchet must not regress below the S1 baseline');
});
