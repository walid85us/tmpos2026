// Phase 4.0 M3 S1/S1.1 — static contract over the real migration files. DATABASE-FREE.
//
// Reads the eight committed migration files through the engine's Node fs port (node:fs
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
};

const port = createNodeFsPort(ABS_DIR, REL_DIR);
const descriptors = discoverMigrations(port);

test('the migrations directory holds exactly the eight expected files', () => {
  const names = descriptors.map((d) => d.relPath.slice(`${REL_DIR}/`.length)).sort();
  assert.deepEqual(names, Object.keys(PINNED).sort());
});

test('every version pairs an up with a down, in stable numeric order', () => {
  const pairs = pairMigrations(descriptors);
  assert.deepEqual(pairs.map((p) => p.version), ['001', '002', '003', '004']);
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
