// Phase 4.0 M0 — STATIC regression guard for firestore.rules (dependency-free, Node 20 built-ins only).
//
// SCOPE NOTE (read this): This is a STATIC source-pattern guard ONLY. It does NOT
// semantically evaluate Firestore Security Rules — semantic evaluation requires the
// Java-backed Firestore emulator, which is unavailable in this environment, so the
// emulator red/green suite remains an OPEN, NOT-EXECUTED M0 residual. This guard's
// sole job is to FAIL if the three historical vulnerabilities are reintroduced into
// firestore.rules (self-writable /users role trusted by an isAdmin() doc read;
// authenticated cross-tenant reads; client audit-event writes) or if the fail-closed
// contract is otherwise weakened. It asserts meaningful required + prohibited security
// properties against the live file contents (not a hash or whole-file string fixture).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const RULES_PATH = join(HERE, '..', '..', 'firestore.rules');
const raw = readFileSync(RULES_PATH, 'utf8');

// Executable form: strip block + line comments so comments can never satisfy or
// bypass a pattern check.
const code = raw
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/\/\/[^\n]*/g, ' ');
// Whitespace-normalized executable form.
const norm = code.replace(/\s+/g, ' ').trim();

// Parse every `allow <ops>: if <guard>;` statement from executable code.
const allows = [...norm.matchAll(/allow\s+([a-z,\s]+?)\s*:\s*if\s+([^;]+);/g)].map((m) => ({
  ops: m[1].split(',').map((s) => s.trim()).filter(Boolean),
  guard: m[2].trim(),
}));

// ---------- REQUIRED CONTRACT ----------
test('required: rules_version is 2', () => {
  assert.match(norm, /rules_version\s*=\s*'2'/);
});
test('required: isAuthenticated requires request.auth != null', () => {
  assert.match(norm, /function\s+isAuthenticated\s*\(\s*\)\s*\{\s*return\s+request\.auth\s*!=\s*null\s*;\s*\}/);
});
test('required: isOwner requires request.auth.uid == userId', () => {
  assert.match(norm, /function\s+isOwner\s*\(\s*userId\s*\)\s*\{\s*return\s+isAuthenticated\s*\(\s*\)\s*&&\s*request\.auth\.uid\s*==\s*userId\s*;\s*\}/);
});
test('required: /users allows only get when isOwner(userId)', () => {
  assert.match(norm, /match\s+\/users\/\{userId\}\s*\{[^}]*allow\s+get\s*:\s*if\s+isOwner\s*\(\s*userId\s*\)\s*;/);
});
test('required: user list is explicitly false', () => {
  assert.match(norm, /allow\s+list\s*:\s*if\s+false\s*;/);
});
test('required: user create/update/delete are explicitly false', () => {
  assert.match(norm, /allow\s+create\s*,\s*update\s*,\s*delete\s*:\s*if\s+false\s*;/);
});
test('required: /tenants read/write are false', () => {
  assert.match(norm, /match\s+\/tenants\/\{tenantId\}\s*\{\s*allow\s+read\s*,\s*write\s*:\s*if\s+false\s*;\s*\}/);
});
test('required: memberships read/write are false', () => {
  assert.match(norm, /match\s+\/tenants\/\{tenantId\}\/memberships\/\{membershipId\}\s*\{\s*allow\s+read\s*,\s*write\s*:\s*if\s+false\s*;\s*\}/);
});
test('required: invitations read/write are false', () => {
  assert.match(norm, /match\s+\/tenants\/\{tenantId\}\/invitations\/\{invitationId\}\s*\{\s*allow\s+read\s*,\s*write\s*:\s*if\s+false\s*;\s*\}/);
});
test('required: auditEvents read/write are false', () => {
  assert.match(norm, /match\s+\/auditEvents\/\{eventId\}\s*\{\s*allow\s+read\s*,\s*write\s*:\s*if\s+false\s*;\s*\}/);
});
test('required: recursive default-deny exists', () => {
  assert.match(norm, /match\s+\/\{document=\*\*\}\s*\{\s*allow\s+read\s*,\s*write\s*:\s*if\s+false\s*;\s*\}/);
});

// ---------- FORBIDDEN CONTRACT ----------
test('forbidden: no isAdmin function', () => {
  assert.ok(!/isAdmin/.test(code), 'isAdmin must not appear in executable rules');
});
test('forbidden: no .data.role authorization lookup', () => {
  assert.ok(!/\.data\.role/.test(code), '.data.role must not be used');
});
test('forbidden: no document-field read used as an authorization input', () => {
  assert.ok(!/\bget\s*\(/.test(code), 'no get() cross-document read');
  assert.ok(!/resource\.data/.test(code), 'no resource.data field read');
  for (const f of ['role', 'userType', 'tenantId', 'storeId', 'status', 'permissions', 'claims']) {
    assert.ok(!new RegExp('\\.data\\.' + f + '\\b').test(code), `no .data.${f} authorization input`);
  }
});
test('forbidden: no allow write guarded by isAuthenticated()/auth!=null', () => {
  assert.ok(!/allow[^:;{}]*\bwrite\b[^:;{}]*:\s*if\s+isAuthenticated\s*\(\s*\)/.test(norm));
  assert.ok(!/allow[^:;{}]*\bwrite\b[^:;{}]*:\s*if\s+request\.auth\s*!=\s*null/.test(norm));
});
test('forbidden: no allow read/get/list guarded by isAuthenticated()/auth!=null', () => {
  assert.ok(!/allow[^:;{}]*\b(read|get|list)\b[^:;{}]*:\s*if\s+isAuthenticated\s*\(\s*\)/.test(norm));
  assert.ok(!/allow[^:;{}]*\b(read|get|list)\b[^:;{}]*:\s*if\s+request\.auth\s*!=\s*null/.test(norm));
});
test('forbidden: every write/create/update/delete allowance is false', () => {
  const writes = allows.filter((a) => a.ops.some((o) => ['write', 'create', 'update', 'delete'].includes(o)));
  assert.ok(writes.length > 0, 'expected some write allowances to exist');
  for (const w of writes) assert.equal(w.guard, 'false', `write-op allowance guard must be false; got: ${w.guard}`);
});
test('forbidden: only permitted non-false read allowance is get:isOwner(userId)', () => {
  const reads = allows.filter((a) => a.ops.some((o) => ['read', 'get', 'list'].includes(o)));
  for (const r of reads) {
    const permitted =
      r.guard === 'false' ||
      (r.ops.length === 1 && r.ops[0] === 'get' && /^isOwner\s*\(\s*userId\s*\)$/.test(r.guard));
    assert.ok(permitted, `unexpected read allowance ops=[${r.ops}] guard=${r.guard}`);
  }
});
test('forbidden: every allow statement is parsed (no unaccounted/unconditional grant)', () => {
  // Closes a parse-completeness blind spot: any `allow` the guarded-allow regex fails
  // to capture (e.g. an unconditional `allow read;` with no `: if`, or an unusual
  // syntax) would silently escape the whitelist checks below. Require the count of
  // `allow` keywords to equal the number of parsed guarded allows.
  const allowKeywords = (code.match(/\ballow\b/g) || []).length;
  assert.equal(
    allowKeywords,
    allows.length,
    `unparsed allow statement(s): ${allowKeywords} 'allow' keywords vs ${allows.length} parsed guarded allows — an unconditional or unusual-syntax grant may be escaping the guard`,
  );
});
test('forbidden: exactly one non-false allow exists (the sole /users get:isOwner)', () => {
  // Pins the contract to a single owner-scoped read: combined with the /users get
  // required-test above, the one permitted non-deny allowance must be /users get:isOwner.
  // Any additional non-false allow anywhere (other path, claims/token guard, membership
  // check, broadened op) pushes this above 1 and fails.
  const nonFalse = allows.filter((a) => a.guard !== 'false');
  assert.equal(nonFalse.length, 1, `expected exactly 1 non-false allow; got ${nonFalse.length}: ${JSON.stringify(nonFalse)}`);
  assert.deepEqual(nonFalse[0].ops, ['get']);
  assert.match(nonFalse[0].guard, /^isOwner\s*\(\s*userId\s*\)$/);
});
test('forbidden: no unconditional true / public access', () => {
  assert.ok(!/\bif\s+true\b/.test(code), 'no ": if true"');
});
