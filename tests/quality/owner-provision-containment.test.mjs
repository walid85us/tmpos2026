// Phase 4.0 M3 S4.1b C2B-R2 — owner-side ACL provisioning containment.
//
// scripts/supabase-owner-provision.ts holds the ONE database-level action migration 005 cannot
// perform on its own: closing PUBLIC's database TEMPORARY privilege. Its dangerous properties
// are structural rather than behavioural — what it CANNOT do, and what it must never grow back —
// so they are asserted lexically here, the same way the executor's containment is asserted.
//
// This suite connects to nothing and executes no SQL.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = 'scripts/supabase-owner-provision.ts';
const SRC = readFileSync(join(REPO_ROOT, SCRIPT), 'utf8');
// The SQL itself deliberately lives in the executor's ownerAcl port, not in the CLI: the CLI
// decides WHETHER to act, the port owns HOW. Both halves are asserted, because a rule proved
// against only one of them would be trivially satisfiable by moving code across the seam.
const PORT_SRC = readFileSync(join(REPO_ROOT, 'server/platform-identity/migrationExecutor.ts'), 'utf8');

/** Source with line- and block-comments removed, so a rule can never be satisfied or violated
 *  by prose. Every assertion below runs against CODE. */
function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}
const CODE = stripComments(SRC);
const PORT = stripComments(PORT_SRC);

/** SQL statements only — an identifier like `revokeTemporaryFromPublic` is not a statement, and
 *  a bare word inside a message string is not one either. A statement is the keyword followed by
 *  whitespace and, eventually, `on database`. `[\s\S]` rather than `[a-z ,]` so a statement
 *  split across lines cannot slip past the rule this file calls decisive. */
const dbLevel = (code, keyword) => code.match(new RegExp(`\\b${keyword}\\b[\\s\\S]{0,80}?on\\s+database[^'"\`]*`, 'gi')) ?? [];

test('owner-provision: there is NO path that restores PUBLIC TEMPORARY', () => {
  // The decisive property. PostgreSQL would let the owner GRANT the privilege back, so nothing
  // but this rule stops a future "rollback" from re-opening temporary-object creation to every
  // role in the database as an automatic reaction to an unrelated later failure.
  for (const [name, code] of [['cli', CODE], ['port', PORT]]) {
    assert.ok(!/grant\s+temporary/i.test(code), `no GRANT TEMPORARY may exist (${name})`);
    assert.deepEqual(dbLevel(code, 'grant'), [], `no database-level GRANT may exist at all (${name})`);
  }
});

test('owner-provision: the only database-level action is the authorized REVOKE', () => {
  const cliStatements = dbLevel(CODE, 'revoke');
  assert.deepEqual(cliStatements, [], 'the CLI itself issues no SQL — it decides, the port acts');
  const portStatements = dbLevel(PORT, 'revoke');
  assert.equal(portStatements.length, 1, 'exactly one database-level revoke may exist in the port');
  assert.match(portStatements[0].toLowerCase(), /temporary/, 'and it must be the TEMPORARY one');
  assert.match(portStatements[0].toLowerCase(), /from public/, 'revoked from PUBLIC');
});

test('owner-provision: the target database cannot be supplied by the caller', () => {
  // The database name is resolved by the SERVER via current_database(); it is never taken from
  // argv and never string-concatenated into the statement. A caller-suppliable name is exactly
  // how an owner action gets redirected to the wrong database.
  const stmt = dbLevel(PORT, 'revoke')[0] ?? '';
  assert.ok(!/\$\{/.test(stmt), 'no interpolation may appear inside the revoke statement');
  assert.ok(
    PORT.includes("format('revoke temporary on database %I from public', current_database())"),
    'the identifier must be quoted by the server from current_database(), not assembled here',
  );
});

test('owner-provision: connection inputs come from the environment, never from argv', () => {
  assert.match(CODE, /process\.env\.SUPABASE_DATABASE_URL/, 'DSN is read from the environment');
  assert.match(CODE, /process\.env\.SUPABASE_URL/, 'the independent project URL is read from the environment');
  // If a DSN could arrive through argv, the endpoint-derived identity signal would be forgeable
  // by whoever types the command. `hasFlag` is the ONE permitted argv reader: it answers a
  // yes/no question and cannot carry a value. Anything else that reaches into argv could.
  const argvUses = CODE.match(/argv[.[]\s*[a-z]*/gi) ?? [];
  const permitted = new Set(['argv.includes', 'argv.slice']);
  const unexpected = argvUses.map((u) => u.replace(/\s+/g, '')).filter((u) => !permitted.has(u));
  assert.deepEqual(unexpected, [], `only value-free argv reads are permitted; found: ${unexpected.join(', ')}`);
});

test('owner-provision: production is hard-blocked and explicit operator gates are required', () => {
  assert.match(CODE, /NODE_ENV === 'production'/, 'production must be blocked outright');
  for (const gate of ['--revoke-public-temporary', '--confirm-dev', 'ALLOW_OWNER_ACL_PROVISION', 'CONFIRM_SUPABASE_TARGET']) {
    assert.ok(CODE.includes(gate), `operator gate ${gate} must be required`);
  }
});

test('owner-provision: ownership is proven BEFORE the revoke, and the result is verified AFTER', () => {
  const ownerAt = CODE.indexOf('isCurrentPrincipalDatabaseOwner');
  const revokeAt = CODE.indexOf('revokeTemporaryFromPublic()');
  const verifyAt = CODE.lastIndexOf('databasePublicPrivileges()');
  assert.ok(ownerAt > 0 && revokeAt > 0 && verifyAt > 0, 'all three steps must be present');
  // A non-owner REVOKE emits only a warning and the privilege survives, so the absence of an
  // error proves nothing — ownership must be established first, and the effect confirmed after.
  assert.ok(ownerAt < revokeAt, 'ownership must be proven before the revoke');
  assert.ok(revokeAt < verifyAt, 'the effect must be verified after the revoke');
});

test('owner-provision: the live fingerprint gates the mutation', () => {
  const fpAt = CODE.indexOf('verifyManagedDevFingerprint');
  const revokeAt = CODE.indexOf('revokeTemporaryFromPublic()');
  assert.ok(fpAt > 0 && fpAt < revokeAt, 'no mutation may precede live target identification');
});

test('owner-provision: an already-hardened database is idempotent, not an error', () => {
  assert.match(CODE, /if \(!before\.temporary\)/, 'the already-closed case must be handled explicitly');
});

test('owner-provision: TLS is never weakened and no secret is printed', () => {
  assert.ok(!/rejectUnauthorized/.test(CODE), 'the script must not touch TLS verification at all');
  assert.ok(!/console\.(log|error)\([^)]*DATABASE_URL/.test(CODE), 'a DSN must never be printed');
  assert.ok(!/console\.(log|error)\([^)]*password/i.test(CODE), 'a password must never be printed');
});
