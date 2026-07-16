// Phase 4.0 M2 — Firestore rules SEMANTIC emulator suite (gate G-EMU).
//
// Unlike the static source guard (firestore.rules.static.test.mjs), this suite
// runs the ACTUAL fail-closed ruleset against the Java-backed Firestore
// emulator and proves allow/deny behavior. It uses a synthetic `demo-` project
// so the emulator needs NO credentials and NO live project; there is no
// .firebaserc and no real project id. Deterministic, non-watch (node:test).
//
// Run (Java via ephemeral Nix, emulator lifecycle via firebase emulators:exec):
//   nix shell nixpkgs#jdk17_headless --command \
//     node_modules/.bin/firebase emulators:exec --only firestore \
//     --project demo-tmpos-rules \
//     'node --test tests/firestore/firestore.rules.emulator.test.mjs'

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  initializeTestEnvironment,
  assertFails,
  assertSucceeds,
} from '@firebase/rules-unit-testing';
import {
  doc, getDoc, setDoc, updateDoc, deleteDoc, collection, getDocs,
} from 'firebase/firestore';

const HERE = dirname(fileURLToPath(import.meta.url));
const RULES_PATH = join(HERE, '..', '..', 'firestore.rules');
const PROJECT_ID = 'demo-tmpos-rules';
const HOST = '127.0.0.1';
const PORT = 8085;

let testEnv;

before(async () => {
  // Guard: the project id must be a synthetic demo- id (emulator-only, no creds).
  assert.ok(PROJECT_ID.startsWith('demo-'), 'project id must be a synthetic demo- id');
  testEnv = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: { rules: readFileSync(RULES_PATH, 'utf8'), host: HOST, port: PORT },
  });
  // Seeding happens ONLY through the rules-disabled admin context.
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, 'users/alice'), { displayName: 'Alice', role: 'staff' });
    await setDoc(doc(db, 'users/bob'), { displayName: 'Bob', role: 'staff' });
    await setDoc(doc(db, 'users/sysowner'), { displayName: 'Sys', role: 'system_owner' });
    await setDoc(doc(db, 'tenants/t1'), { name: 'T1' });
    await setDoc(doc(db, 'tenants/t1/memberships/m1'), { role: 'owner' });
    await setDoc(doc(db, 'tenants/t1/invitations/i1'), { email: 'x@example.test' });
    await setDoc(doc(db, 'auditEvents/e1'), { type: 'seed' });
    await setDoc(doc(db, 'secretStuff/s1'), { any: 'thing' });
  });
});

after(async () => { if (testEnv) await testEnv.cleanup(); });

const authed = (uid) => testEnv.authenticatedContext(uid).firestore();
const anon = () => testEnv.unauthenticatedContext().firestore();

// ---- ALLOW ------------------------------------------------------------------
test('ALLOW: authenticated user gets exactly their own /users/{uid}', async () => {
  await assertSucceeds(getDoc(doc(authed('alice'), 'users/alice')));
});

// ---- DENY: /users -----------------------------------------------------------
test('DENY: unauthenticated own-user get', async () => {
  await assertFails(getDoc(doc(anon(), 'users/alice')));
});
test('DENY: another-user get', async () => {
  await assertFails(getDoc(doc(authed('alice'), 'users/bob')));
});
test('DENY: user list/query', async () => {
  await assertFails(getDocs(collection(authed('alice'), 'users')));
});
test('DENY: own-user create', async () => {
  await assertFails(setDoc(doc(authed('carol'), 'users/carol'), { displayName: 'Carol' }));
});
test('DENY: own-user ordinary-profile update', async () => {
  await assertFails(updateDoc(doc(authed('alice'), 'users/alice'), { displayName: 'A2' }));
});
for (const field of ['role', 'userType', 'status', 'tenantId', 'storeId', 'permissions', 'claims']) {
  test(`DENY: own-user ${field} mutation`, async () => {
    await assertFails(updateDoc(doc(authed('alice'), 'users/alice'), { [field]: 'escalated' }));
  });
}
test('DENY: own-user delete', async () => {
  await assertFails(deleteDoc(doc(authed('alice'), 'users/alice')));
});

// ---- DENY: tenants / memberships / invitations / auditEvents ----------------
const DENIED_DOCS = [
  ['tenant', 'tenants/t1', 'tenants'],
  ['membership', 'tenants/t1/memberships/m1', 'tenants/t1/memberships'],
  ['invitation', 'tenants/t1/invitations/i1', 'tenants/t1/invitations'],
  ['auditEvents', 'auditEvents/e1', 'auditEvents'],
];
for (const [label, docPath, collPath] of DENIED_DOCS) {
  test(`DENY: ${label} get`, async () => { await assertFails(getDoc(doc(authed('alice'), docPath))); });
  test(`DENY: ${label} list`, async () => { await assertFails(getDocs(collection(authed('alice'), collPath))); });
  test(`DENY: ${label} create`, async () => { await assertFails(setDoc(doc(authed('alice'), `${collPath}/new`), { x: 1 })); });
  test(`DENY: ${label} update`, async () => { await assertFails(setDoc(doc(authed('alice'), docPath), { x: 1 })); });
  test(`DENY: ${label} delete`, async () => { await assertFails(deleteDoc(doc(authed('alice'), docPath))); });
}

// ---- DENY: unmatched collection (recursive default-deny) ---------------------
test('DENY: unmatched collection get', async () => {
  await assertFails(getDoc(doc(authed('alice'), 'secretStuff/s1')));
});
test('DENY: unmatched collection list', async () => {
  await assertFails(getDocs(collection(authed('alice'), 'secretStuff')));
});
test('DENY: unmatched collection write', async () => {
  await assertFails(setDoc(doc(authed('alice'), 'secretStuff/s2'), { x: 1 }));
});

// ---- DENY: a seeded role=system_owner doc grants NOTHING client-side --------
test('DENY: seeded system_owner cannot list users', async () => {
  await assertFails(getDocs(collection(authed('sysowner'), 'users')));
});
test('DENY: seeded system_owner cannot read tenants', async () => {
  await assertFails(getDoc(doc(authed('sysowner'), 'tenants/t1')));
});
test('DENY: seeded system_owner cannot write users', async () => {
  await assertFails(updateDoc(doc(authed('sysowner'), 'users/sysowner'), { role: 'x' }));
});
test('DENY: seeded system_owner cannot write auditEvents', async () => {
  await assertFails(setDoc(doc(authed('sysowner'), 'auditEvents/e2'), { type: 'forged' }));
});
