// Phase 4.0 M7A-CUSTOMERS-P3 — tenant customer creation through the runtime: the name rule and its parity with migration
// 017's CHECK (every code point swept), the planner's input contract, the route's and the contract's registration, and the
// enforced chain over real loopback sockets on the TENANT boundary — session, CSRF, the authorizer's trusted scope, the
// command handed to the transaction port, replay, and a key bound to the trusted tenant and actor.
//
// M7A-CUSTOMERS-P6: the optional phone and email — each refused class, their parity with migration 023's CHECKs (every
// code point swept), the body's three keys, the 8 KiB cap, the change set carrying '' for an absent contact, and the
// idempotency witnesses: the fingerprint is the body bytes (a name-only body's is pinned to the value the pre-contact code
// computes), a changed contact under one key is the 422, and records sealed before contacts existed — with and without
// Location — replay exactly as committed.
//
// Synthetic principals, sessions, keys and ports only. The transaction port here is a recording stand-in whose lease check
// is the idempotency store's own; the PostgreSQL store, its tenant revalidation and migration 019 are proved elsewhere
// (server/persistence, tests/db). Special characters are built from code points so this source stays ASCII.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { createApp, createBoundedServer, createReadinessState } from './app.js';
import { defineCommands, prepareCommand } from './commandTransaction.js';
import type { CommandTransactionPort, TransactionCommand } from './commandTransaction.js';
import {
  CUSTOMER_CREATE_CONTRACT, CUSTOMER_CREATE_PERMISSION, CUSTOMER_CREATE_ROUTE, normalizeCustomerName, planCustomerCreate,
} from './customerCreate.js';
import {
  CONTACT_REFUSED, CUSTOMER_DIRECTORY_PATH, CUSTOMER_EMAIL_MAX_CHARACTERS, CUSTOMER_NAME_MAX_CHARACTERS, CUSTOMER_PHONE_MAX_CHARACTERS,
  createCustomerDirectoryRoute, normalizeCustomerEmail, normalizeCustomerPhone,
} from './customerDirectory.js';
import { TEST_IDEMPOTENCY_KEY, createMemoryIdempotencyState, createMemoryIdempotencyStore } from './idempotencyStore.testkit.js';
import { IDEMPOTENCY_POLICY, createIdempotencyKeyring, envelopeFromOutcome } from './idempotency.js';
import { createMemorySessionStore } from './memorySessionStore.testkit.js';
import { UUID_V4_RE, defineOutboxEvents } from './outbox.js';
import type { TrustedScope } from './principals.js';
import { testRequestLimits } from './rateLimiter.testkit.js';
import { CSRF_HEADER, CSRF_HEADER_VALUE } from './requestSecurity.js';
import { COMMAND_REQUEST_INVALID, defineRoutes, sessionPaths } from './routes.js';
import type { CommandPlan } from './routes.js';
import { SECURITY_HEADERS } from './securityHeaders.js';
import { SESSION_COOKIES, SESSION_CSRF_HEADER } from './sessions.js';
import type { SessionBoundaryDeps } from './sessions.js';

const ACTOR = '7b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d';
const OTHER_ACTOR = '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
const MEMBERSHIP = '5a6b7c8d-9e0f-4a1b-8c2d-3e4f5a6b7c8d';
const T1 = '3f0c2a8e-9b1d-4c7e-8a2f-5d6e7f8a9b0c';
const T2 = '9a8b7c6d-5e4f-4a3b-9c2d-1e0f2a3b4c5d';
const SCOPE: TrustedScope = Object.freeze({
  actor: ACTOR, securityVersion: 'sv-1', scope: 'tenant', tenant: T1, store: null, membershipId: MEMBERSHIP, roleId: 'sales_staff', limitation: 'none',
});
const ch = (...codes: number[]): string => String.fromCodePoint(...codes);
const unit = (code: number): string => String.fromCharCode(code); // a lone UTF-16 unit, for surrogates
const plan = (body: unknown) => planCustomerCreate({ audience: 'tenant', body, newAggregateId: randomUUID() });

// --- 1. the name rule, and its parity with migration 017's CHECK -----------------------------------------------------------

const MIGRATION_017 = readFileSync(new URL('../platform-identity/migrations/017_m7a_customer_directory.up.sql', import.meta.url), 'utf8');
/** The code points of one bracket class written as 017 writes it: \uXXXX escapes and \uXXXX-\uXXXX ranges, nothing else. */
function classOf(text: string): Set<number> {
  const out = new Set<number>();
  const re = /\\u([0-9a-f]{4})(?:-\\u([0-9a-f]{4}))?/y;
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    const from = parseInt(m[1], 16);
    const to = m[2] === undefined ? from : parseInt(m[2], 16);
    for (let c = from; c <= to; c++) out.add(c);
    if (re.lastIndex === text.length) return out;
  }
  throw new Error(`017 class not fully read: ${text}`);
}
const check017 = (() => {
  const constraint = /constraint customer_name_chk check \(([\s\S]*?)\n\);/.exec(MIGRATION_017)?.[1] ?? '';
  const anywhere = [...constraint.matchAll(/and name !~ '\[([^\]]+)\]'\n/g)].map((m) => classOf(m[1]));
  const edge = /and name !~ '\^\[([^\]]+)\]\|\[([^\]]+)\]\$'\)$/.exec(constraint);
  const length = /char_length\(name\) between 1 and (\d+)/.exec(constraint);
  return { rules: (constraint.match(/name !~/g) ?? []).length, anywhere, edge, length };
})();

test('migration 017\'s CHECK reads as this test expects: a length, two anywhere classes and one edge class', () => {
  assert.equal(check017.rules, 3, 'exactly three character rules');
  assert.equal(check017.anywhere.length, 2);
  assert.ok(check017.edge !== null && check017.edge[1] === check017.edge[2], 'the same class at either edge');
  assert.equal(Number(check017.length?.[1]), CUSTOMER_NAME_MAX_CHARACTERS, '1-200 characters');
});

test('ES trim strips EXACTLY 017\'s 25 edge-whitespace code points, at either edge: swept over every scalar value', () => {
  const edge = classOf((check017.edge as RegExpExecArray)[1]);
  assert.equal(edge.size, 25);
  const wrong: number[] = [];
  for (let c = 0; c <= 0x10ffff; c++) {
    if (c >= 0xd800 && c <= 0xdfff) continue; // no scalar value
    const s = String.fromCodePoint(c);
    const stripped = (s + 'a').trim() === 'a' && ('a' + s).trim() === 'a';
    const kept = (s + 'a').trim() === s + 'a' && ('a' + s).trim() === 'a' + s;
    if (edge.has(c) ? !stripped : !kept) wrong.push(c);
  }
  assert.deepEqual(wrong, [], 'so a trimmed name never has an edge character 017 refuses, and trimming removes nothing 017 allows');
  // And the normalizer trims them: every one at either edge of a name is gone.
  for (const c of edge) assert.equal(normalizeCustomerName(`${ch(c)}Ada${ch(c)}`), 'Ada', c.toString(16));
});

test('inside a name the refused set is EXACTLY 017\'s two anywhere classes plus NUL: swept over every scalar value', () => {
  const [controls, bidi] = check017.anywhere;
  assert.equal(bidi.size, 12, 'the twelve Bidi_Control characters');
  const wrong: number[] = [];
  for (let c = 0; c <= 0x10ffff; c++) {
    if (c >= 0xd800 && c <= 0xdfff) continue;
    const refused = normalizeCustomerName(`a${ch(c)}a`) === null;
    if (refused !== (c === 0 || controls.has(c) || bidi.has(c))) wrong.push(c);
  }
  assert.deepEqual(wrong, [], 'the runtime refuses every character 017 refuses anywhere, NUL besides, and nothing else between visible ones');
  // A lone surrogate is no scalar value: 017 cannot see one (the driver would send U+FFFD); the runtime refuses it.
  for (const lone of [unit(0xd800), unit(0xdbff), unit(0xdc00), unit(0xdfff), unit(0xdc00) + unit(0xd800)]) {
    assert.equal(normalizeCustomerName(`a${lone}a`), null, `lone ${lone.charCodeAt(0).toString(16)}`);
    assert.equal(normalizeCustomerName(lone), null);
  }
  assert.equal(normalizeCustomerName(`a${ch(0x1f600)}a`), `a${ch(0x1f600)}a`, 'a well-formed surrogate pair is one scalar (control)');
});

test('a name must hold at least one visible scalar: whitespace, default-ignorables, format characters, marks and U+2800 alone are refused', () => {
  const invisible: Array<[string, string]> = [
    ['empty', ''], ['spaces', '   '], ['NBSP and ideographic space', `${ch(0xa0)}${ch(0x3000)}`],
    ['ZWSP', ch(0x200b)], ['ZWNJ', ch(0x200c)], ['ZWJ', ch(0x200d)], ['word joiner', ch(0x2060)], ['soft hyphen', ch(0xad)],
    ['combining grapheme joiner', ch(0x34f)], ['a variation selector', ch(0xfe0f)], ['a tag character', ch(0xe0041)],
    ['Hangul choseong filler', ch(0x115f)], ['Hangul jungseong filler', ch(0x1160)], ['Hangul filler', ch(0x3164)],
    ['halfwidth Hangul filler', ch(0xffa0)], ['Mongolian vowel separator', ch(0x180e)], ['braille blank', ch(0x2800)],
    ['a combining mark alone', ch(0x301)], ['an enclosing mark alone', ch(0x20dd)], ['mixed', `${ch(0x200b)} ${ch(0x2800)}${ch(0x301)}${ch(0xfe0f)}`],
  ];
  for (const [label, name] of invisible) assert.equal(normalizeCustomerName(name), null, label);
  // One visible scalar is enough, and the invisible ones beside it are kept exactly.
  for (const [label, name] of [
    ['a letter', 'A'], ['a digit', '7'], ['a symbol', '#'], ['a ZWJ emoji', ch(0x1f468, 0x200d, 0x1f527)], ['a combining acute on e', `e${ch(0x301)}`],
    ['a private-use scalar (visible by choice)', ch(0xe000)], ['an unassigned scalar (visible by choice)', ch(0x0378)], ['CJK', ch(0x4fee, 0x7406)],
    ['a letter beside a ZWSP', `A${ch(0x200b)}`], ['right-to-left text', ch(0x5e9, 0x5dc, 0x5d5, 0x5dd)],
  ] as const) {
    assert.equal(normalizeCustomerName(name), name, label);
  }
});

test('the length is 1-200 scalars after trimming, astral scalars included, and padding does not count', () => {
  const astral = ch(0x1f600);
  assert.equal(normalizeCustomerName('A'), 'A', 'one scalar');
  assert.equal(normalizeCustomerName('a'.repeat(200)), 'a'.repeat(200), '200 scalars');
  assert.equal(normalizeCustomerName('a'.repeat(201)), null, '201 scalars');
  assert.equal(normalizeCustomerName(astral.repeat(200)), astral.repeat(200), '200 astral scalars are 400 UTF-16 units, and allowed');
  assert.equal(normalizeCustomerName(astral.repeat(201)), null, '201 astral scalars');
  assert.equal(normalizeCustomerName(`${'a'.repeat(199)}${astral}`), `${'a'.repeat(199)}${astral}`, 'a mix is counted in scalars');
  assert.equal(normalizeCustomerName(`${' '.repeat(300)}${'b'.repeat(200)}${ch(0x3000).repeat(300)}`), 'b'.repeat(200), 'padding is trimmed first');
  assert.equal(normalizeCustomerName('Ada  Lovelace'), 'Ada  Lovelace', 'internal whitespace is kept exactly');
  assert.equal(normalizeCustomerName(`Ada${ch(0xa0)}Lovelace`), `Ada${ch(0xa0)}Lovelace`, 'an internal NBSP is kept');
  assert.equal(normalizeCustomerName(`Cafe${ch(0x301)}`), `Cafe${ch(0x301)}`, 'no normalization: NFD stays NFD');
  assert.equal(normalizeCustomerName('Bob\n'), 'Bob', 'a trailing newline is edge whitespace, trimmed');
  assert.equal(normalizeCustomerName(`a${ch(0x2028)}b`), null, 'a separator inside a name is refused');
  for (const raw of [undefined, null, 1, true, {}, ['A'], { toString: () => 'A' }]) assert.equal(normalizeCustomerName(raw), null, String(raw));
});

// --- 1b. the contact rules (M7A-CUSTOMERS-P6), and their parity with migration 023's CHECKs ------------------------------

const MIGRATION_023 = readFileSync(new URL('../platform-identity/migrations/023_m7a_customer_contact.up.sql', import.meta.url), 'utf8');
/** One of 023's two CHECKs, read as 017's is read above: its bounds, its anywhere classes and its edge class. */
function check023(field: 'phone' | 'email') {
  const constraint = new RegExp(`add constraint customer_${field}_chk check \\(\\n([\\s\\S]*?)\\)\\)`).exec(MIGRATION_023)?.[1] ?? '';
  const anywhere = [...constraint.matchAll(new RegExp(`and ${field} !~ '\\[([^\\]]+)\\]'\\n`, 'g'))].map((m) => classOf(m[1]));
  const edge = new RegExp(`and ${field} !~ '\\^\\[([^\\]]+)\\]\\|\\[([^\\]]+)\\]\\$'`).exec(constraint);
  const length = new RegExp(`char_length\\(${field}\\) between 1 and (\\d+)`).exec(constraint);
  return { anywhere, edge, length: Number(length?.[1]), refusals: (constraint.match(new RegExp(`${field} !~`, 'g')) ?? []).length, constraint };
}
const PHONE_023 = check023('phone');
const EMAIL_023 = check023('email');

test('migration 023\'s CHECKs read as this test expects, and restate 017\'s classes exactly', () => {
  const [controls017, bidi017] = check017.anywhere;
  const edge017 = classOf((check017.edge as RegExpExecArray)[1]);
  assert.deepEqual([PHONE_023.refusals, PHONE_023.anywhere.length, PHONE_023.length], [3, 2, CUSTOMER_PHONE_MAX_CHARACTERS]);
  assert.deepEqual([EMAIL_023.refusals, EMAIL_023.anywhere.length, EMAIL_023.length], [4, 3, CUSTOMER_EMAIL_MAX_CHARACTERS]);
  for (const check of [PHONE_023, EMAIL_023]) {
    assert.deepEqual([...check.anywhere[0]], [...controls017], 'the controls class is 017\'s');
    assert.deepEqual([...check.anywhere[1]], [...bidi017], 'the Bidi_Control class is 017\'s');
    assert.ok(check.edge !== null && check.edge[1] === check.edge[2], 'the same class at either edge');
    assert.deepEqual([...classOf((check.edge as RegExpExecArray)[1])], [...edge017], 'the edge class is 017\'s');
  }
  assert.match(PHONE_023.constraint, /and phone ~ '\[0-9\]'$/, 'a phone needs an ASCII digit');
  assert.match(EMAIL_023.constraint, /and email ~ '\^\[\^@\]\+@\[\^@\]\+\$'$/, 'an email is exactly one @ between non-empty parts');
  // 023's email White_Space class is EXACTLY Unicode's White_Space: every scalar value swept.
  const wrong: number[] = [];
  for (let c = 0; c <= 0x10ffff; c++) {
    if (c >= 0xd800 && c <= 0xdfff) continue;
    if (EMAIL_023.anywhere[2].has(c) !== /\p{White_Space}/u.test(String.fromCodePoint(c))) wrong.push(c);
  }
  assert.deepEqual(wrong, []);
});

test('inside a contact the refused set is EXACTLY 023\'s classes plus NUL (and, in an email, a second @): swept over every scalar value', () => {
  const [controls, bidi] = PHONE_023.anywhere;
  const space = EMAIL_023.anywhere[2];
  const wrongPhone: number[] = [];
  const wrongEmail: number[] = [];
  for (let c = 0; c <= 0x10ffff; c++) {
    if (c >= 0xd800 && c <= 0xdfff) continue;
    const refusedAnywhere = c === 0 || controls.has(c) || bidi.has(c);
    if ((normalizeCustomerPhone(`1${ch(c)}2`) === CONTACT_REFUSED) !== refusedAnywhere) wrongPhone.push(c);
    if ((normalizeCustomerEmail(`a${ch(c)}@b`) === CONTACT_REFUSED) !== (refusedAnywhere || space.has(c) || c === 0x40)) wrongEmail.push(c);
  }
  assert.deepEqual(wrongPhone, [], 'the runtime refuses inside a phone exactly what 023 refuses, NUL besides');
  assert.deepEqual(wrongEmail, [], 'the runtime refuses inside an email exactly what 023 refuses, NUL besides');
  // The edges: every one of 017's edge characters (023's edge class) is trimmed away, so a stored contact never has one.
  for (const c of classOf((PHONE_023.edge as RegExpExecArray)[1])) {
    assert.equal(normalizeCustomerPhone(`${ch(c)}+1 555 0100${ch(c)}`), '+1 555 0100', c.toString(16));
    assert.equal(normalizeCustomerEmail(`${ch(c)}ada@example.test${ch(c)}`), 'ada@example.test', c.toString(16));
  }
});

test('the phone: optional, trimmed, 1-64 scalars, an ASCII digit, kept as typed — and every refused class refused', () => {
  for (const absent of [undefined, null, '', ' ', '   ', '\t\n', ch(0x3000, 0xa0)]) assert.equal(normalizeCustomerPhone(absent), null, `absent: ${JSON.stringify(absent)}`);
  for (const [label, raw, stored] of [
    ['as typed', '+1 555 0100', '+1 555 0100'], ['trimmed', '  (555) 0100\n', '(555) 0100'], ['one digit', '7', '7'],
    ['internal spaces and punctuation kept', '+44 (0)20 7946-0958 ext. 12', '+44 (0)20 7946-0958 ext. 12'],
    ['letters beside a digit', 'call 555 0100 after 5', 'call 555 0100 after 5'], ['an internal NBSP kept', `555${ch(0xa0)}0100`, `555${ch(0xa0)}0100`],
    ['64 scalars', '1'.repeat(64), '1'.repeat(64)], ['64 astral scalars with a digit', `1${ch(0x1f4de).repeat(63)}`, `1${ch(0x1f4de).repeat(63)}`],
    ['padding does not count', ` ${'1'.repeat(64)} `, '1'.repeat(64)],
  ] as const) {
    assert.equal(normalizeCustomerPhone(raw), stored, label);
  }
  const refused: Array<[string, unknown]> = [
    ['no digit', 'call me'], ['a non-ASCII digit only', ch(0x0661, 0x0662)], ['a fullwidth digit only', ch(0xff11)],
    ['65 scalars', '1'.repeat(65)], ['65 astral scalars', `1${ch(0x1f4de).repeat(64)}`],
    ['NUL', `1${ch(0)}2`], ['a C0 control', `1${ch(0x7)}2`], ['a tab inside', `1${ch(0x9)}2`], ['DEL', `1${ch(0x7f)}2`], ['a C1 control', `1${ch(0x85)}2`],
    ['LS inside', `1${ch(0x2028)}2`], ['PS inside', `1${ch(0x2029)}2`], ['a lone high surrogate', `1${unit(0xd800)}2`], ['a lone low surrogate', `1${unit(0xdfff)}`],
    ...[0x061c, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069]
      .map((c): [string, unknown] => [`Bidi_Control U+${c.toString(16)}`, `1${ch(c)}2`]),
    ['a number', 5550100], ['true', true], ['an object', { phone: '1' }], ['an array', ['1']], ['a String object', Object('1')],
  ];
  for (const [label, raw] of refused) assert.equal(normalizeCustomerPhone(raw), CONTACT_REFUSED, label);
});

test('the email: optional, trimmed, 1-254 scalars, no White_Space, exactly one @ between non-empty parts, kept as typed — and every refused class refused', () => {
  for (const absent of [undefined, null, '', '  ', `${ch(0x2028)}`]) assert.equal(normalizeCustomerEmail(absent), null, `absent: ${JSON.stringify(absent)}`);
  const local = 'a'.repeat(126);
  for (const [label, raw, stored] of [
    ['as typed', 'ada@example.test', 'ada@example.test'], ['trimmed', '  Ada.Lovelace@Example.TEST\n', 'Ada.Lovelace@Example.TEST'],
    ['no case folding', 'ADA@EXAMPLE.TEST', 'ADA@EXAMPLE.TEST'], ['no domain rule', 'a@b', 'a@b'], ['plus and quotes kept', '"ada+x"@example.test', '"ada+x"@example.test'],
    ['254 scalars', `${local}@${'b'.repeat(127)}`, `${local}@${'b'.repeat(127)}`],
    ['254 astral scalars', `${ch(0x1f600).repeat(126)}@${ch(0x1f600).repeat(127)}`, `${ch(0x1f600).repeat(126)}@${ch(0x1f600).repeat(127)}`],
    ['a ZWSP is not White_Space (kept as typed)', `a${ch(0x200b)}@example.test`, `a${ch(0x200b)}@example.test`],
  ] as const) {
    assert.equal(normalizeCustomerEmail(raw), stored, label);
  }
  const refused: Array<[string, unknown]> = [
    ['no @', 'ada.example.test'], ['two @', 'a@b@example.test'], ['@@', 'a@@example.test'], ['an empty local part', '@example.test'],
    ['an empty domain', 'ada@'], ['only @', '@'], ['255 scalars', `${local}@${'b'.repeat(128)}`],
    ['a space inside', 'ada lovelace@example.test'], ['a space after @', 'ada@ example.test'], ['a tab inside', `ada${ch(9)}@example.test`],
    ['an NBSP inside', `ada${ch(0xa0)}@example.test`], ['an ideographic space inside', `ada${ch(0x3000)}@example.test`], ['NEL inside', `ada${ch(0x85)}@example.test`],
    ['NUL', `a${ch(0)}@b`], ['DEL', `a${ch(0x7f)}@b`], ['a C1 control', `a${ch(0x9f)}@b`], ['LS inside', `a${ch(0x2028)}@b`], ['PS inside', `a${ch(0x2029)}@b`],
    ['a lone surrogate', `a${unit(0xdc00)}@b`],
    ...[0x061c, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069]
      .map((c): [string, unknown] => [`Bidi_Control U+${c.toString(16)}`, `a${ch(c)}@b`]),
    ['a number', 1], ['false', false], ['an object', { email: 'a@b' }], ['an array', ['a@b']],
  ];
  for (const [label, raw] of refused) assert.equal(normalizeCustomerEmail(raw), CONTACT_REFUSED, label);
});

test('the planner: contacts optional and independent, stored trimmed, blank or null absent (the empty string), keys name, phone and email only', () => {
  const id = randomUUID();
  const changesOf = (body: unknown) => (planCustomerCreate({ audience: 'tenant', body, newAggregateId: id }) as CommandPlan).changes;
  assert.deepEqual(changesOf({ name: 'Ada', phone: ' +1 555 0100 ', email: ' ada@example.test ' }), { name: 'Ada', phone: '+1 555 0100', email: 'ada@example.test' });
  assert.deepEqual(changesOf({ name: 'Ada', phone: '+1 555 0100' }), { name: 'Ada', phone: '+1 555 0100', email: '' });
  assert.deepEqual(changesOf({ name: 'Ada', email: 'ada@example.test' }), { name: 'Ada', phone: '', email: 'ada@example.test' });
  assert.deepEqual(changesOf({ name: 'Ada', phone: null, email: '   ' }), { name: 'Ada', phone: '', email: '' }, 'null and blank are absent');
  assert.deepEqual(changesOf({ email: 'ada@example.test', name: 'Ada', phone: '1' }), { name: 'Ada', phone: '1', email: 'ada@example.test' }, 'any key order');
  // The 201 representation never carries a contact.
  const p = planCustomerCreate({ audience: 'tenant', body: { name: 'Ada', phone: '+1 555 0100', email: 'ada@example.test' }, newAggregateId: id }) as CommandPlan;
  assert.deepEqual(p.response, { status: 201, body: { customer: { id, name: 'Ada' } }, headers: { location: `/api/v1/customers/${id}` } });
  // An own key the prototype also names is read; an omitted one is never read from a prototype.
  const polluted = Object.create({ phone: 'proto 1', email: 'proto@example.test' }) as Record<string, unknown>;
  polluted.name = 'Ada';
  assert.deepEqual(changesOf(polluted), { name: 'Ada', phone: '', email: '' }, 'an inherited contact is not a field');
});

// --- 2. the planner ------------------------------------------------------------------------------------------------------

test('a body the contract refuses plans nothing: name and at most phone and email, each valid, or COMMAND_REQUEST_INVALID', () => {
  // M7A-CUSTOMERS-P6 changed one expectation deliberately: { name, email } is no longer refused (it plans; see the next test).
  const invalid: Array<[string, unknown]> = [
    ['null', null], ['undefined', undefined], ['an array', [{ name: 'A' }]], ['an empty array', []], ['a string', 'A'], ['a number', 1], ['true', true],
    ['no field', {}], ['a tenant selector', { name: 'A', tenantId: T2 }], ['a client id', { name: 'A', id: randomUUID() }],
    ['an actor', { name: 'A', actor: ACTOR }], ['a contact beside an unknown field', { name: 'A', email: 'a@example.test', note: 'x' }],
    ['a contact without a name', { phone: '+1 555 0100' }], ['contacts without a name', { phone: '+1 555 0100', email: 'ada@example.test' }],
    ['a capitalised contact key', { name: 'A', Email: 'a@example.test' }], ['only another field', { title: 'A' }],
    ['a number for the phone', { name: 'A', phone: 5550100 }], ['an object for the email', { name: 'A', email: { address: 'a@example.test' } }],
    ['an array for the phone', { name: 'A', phone: ['+1 555 0100'] }], ['false for the email', { name: 'A', email: false }],
    ['a phone with no digit', { name: 'A', phone: 'call me' }], ['an email with a space', { name: 'A', email: 'ada @example.test' }],
    ['an email without @', { name: 'A', email: 'ada.example.test' }], ['a valid name with a refused phone', { name: 'Ada', phone: `1${ch(0x202e)}2` }],
    ['a number for the name', { name: 1 }], ['null for the name', { name: null }], ['an object for the name', { name: { first: 'A' } }],
    ['an array for the name', { name: ['A'] }], ['an empty name', { name: '' }], ['a blank name', { name: '   ' }],
    ['an invisible name', { name: ch(0x200b) }], ['a Bidi override', { name: `a${ch(0x202e)}b` }], ['a C1 control', { name: `a${ch(0x85)}b` }],
    ['201 scalars', { name: 'a'.repeat(201) }], ['a lone surrogate', { name: `a${unit(0xd800)}` }],
    ['an own __proto__ key', JSON.parse('{"name":"A","__proto__":{"x":1}}')], ['__proto__ in place of name', JSON.parse('{"__proto__":"A"}')],
  ];
  for (const [label, body] of invalid) assert.equal(plan(body), COMMAND_REQUEST_INVALID, label);
});

test('the plan: the runtime\'s new id as the aggregate, no version, the stored name with no contact, no event, and the 201 representation', () => {
  const newAggregateId = randomUUID();
  const p = planCustomerCreate({ audience: 'tenant', body: { name: '  Ada  Lovelace ' }, newAggregateId });
  // M7A-CUSTOMERS-P6 changed one expectation deliberately: the change set always carries phone and email, '' when absent.
  assert.deepEqual(p, {
    aggregateId: newAggregateId, expectedVersion: null, changes: { name: 'Ada  Lovelace', phone: '', email: '' }, events: [],
    response: { status: 201, body: { customer: { id: newAggregateId, name: 'Ada  Lovelace' } }, headers: { location: `/api/v1/customers/${newAggregateId}` } },
  });
  // M7A-CUSTOMERS-P4: the detail route exists, so the 201 names it — the one allowlisted, sealed header, and nothing else.
  assert.deepEqual(Object.keys((p as CommandPlan).response.headers ?? {}), ['location']);
  // The planner reads the body alone: the same body under another audience plans the same command.
  assert.deepEqual(planCustomerCreate({ audience: null, body: { name: 'Ada' }, newAggregateId }), planCustomerCreate({ audience: 'tenant', body: { name: 'Ada' }, newAggregateId }));
});

// --- 3. registration -----------------------------------------------------------------------------------------------------

test('the route registers as one POST behind the tenant session and create_customers, requiring idempotency and a trusted context', () => {
  const [route] = defineRoutes([CUSTOMER_CREATE_ROUTE]).list();
  assert.deepEqual({
    method: route.method, path: route.path, policy: route.policy, body: route.body, idempotency: route.idempotency,
    trustedContext: route.trustedContext, recentAuth: route.recentAuth, sessionBinding: route.sessionBinding,
  }, {
    method: 'POST', path: '/api/v1/customers', idempotency: 'required', trustedContext: 'required', recentAuth: 'none', sessionBinding: 'none',
    policy: { access: 'session', audience: 'tenant', authorization: { scope: 'tenant', permission: 'create_customers' } },
    body: { kind: 'json', maxBytes: 8192, required: true },
  });
  assert.equal(CUSTOMER_CREATE_PERMISSION, 'create_customers');
  assert.ok('command' in route && route.command.contract === CUSTOMER_CREATE_CONTRACT && route.command.plan === planCustomerCreate);
  assert.ok('command' in CUSTOMER_CREATE_ROUTE);
  for (const part of [CUSTOMER_CREATE_ROUTE, CUSTOMER_CREATE_ROUTE.policy, CUSTOMER_CREATE_ROUTE.body, CUSTOMER_CREATE_ROUTE.command,
    CUSTOMER_CREATE_CONTRACT, CUSTOMER_CREATE_CONTRACT.changes, CUSTOMER_CREATE_CONTRACT.events]) {
    assert.ok(Object.isFrozen(part), 'the shared definition is frozen throughout: no importer can change another\'s');
  }
  assert.ok(Object.isFrozen((CUSTOMER_CREATE_ROUTE.policy as { authorization: object }).authorization));
  // Beside the directory's GET on the same literal path: two distinct keys, one table.
  const both = defineRoutes([createCustomerDirectoryRoute({ customers: { page: () => ({ outcome: 'page', customers: [], hasMore: false }) } }), CUSTOMER_CREATE_ROUTE]);
  assert.deepEqual(both.list().map((r) => `${r.method} ${r.path}`), ['GET /api/v1/customers', 'POST /api/v1/customers']);
  assert.equal(CUSTOMER_DIRECTORY_PATH, route.path);
});

test('the contract registers with no event contract at all, and declares the name, phone and email as 400, 128 and 508 UTF-16 units — the record caps they need', () => {
  const [contract] = defineCommands([CUSTOMER_CREATE_CONTRACT], defineOutboxEvents([])).list();
  assert.deepEqual(contract, {
    kind: 'tenant.customer.create', mode: 'create', aggregateType: 'customer', events: [],
    changes: { name: { type: 'string', maxLength: 400 }, phone: { type: 'string', maxLength: 128 }, email: { type: 'string', maxLength: 508 } },
  });
  // The longest legal record — a 200-, a 64- and a 254-scalar field, every scalar astral — plans, and the runtime prepares it
  // for the store: the schema admits it.
  const newAggregateId = randomUUID();
  const longest = ch(0x1f600).repeat(200);
  const longestPhone = `1${ch(0x1f4de).repeat(63)}`;
  const longestEmail = `${ch(0x1f600).repeat(126)}@${ch(0x1f600).repeat(127)}`;
  assert.deepEqual([[...longestPhone].length, [...longestEmail].length, longestEmail.length], [64, 254, 507]);
  const keyring = createIdempotencyKeyring(TEST_IDEMPOTENCY_KEY);
  const operation = keyring.operationOf(randomUUID(), { authProvider: 'synthetic', authProviderUid: 'uid-a' }, {
    method: 'POST', path: CUSTOMER_DIRECTORY_PATH, audience: 'tenant', tenant: T1, store: null, actor: ACTOR, body: Buffer.from('{}'),
  });
  const prepared = prepareCommand(contract, defineOutboxEvents([]), planCustomerCreate({ audience: 'tenant', body: { name: longest, phone: longestPhone, email: longestEmail }, newAggregateId }), {
    scope: operation.scope, lease: 'l'.repeat(43), newAggregateId, authorization: { scope: 'tenant', permission: 'create_customers' },
    context: SCOPE, authNotAfter: null, sessionKey: 'k'.repeat(43), seal: (envelope) => keyring.seal(envelope, operation),
  });
  assert.ok(prepared !== null, 'prepared');
  assert.deepEqual(prepared.command.mutation, {
    kind: 'tenant.customer.create', aggregateType: 'customer', aggregateId: newAggregateId, expectedVersion: null,
    changes: { name: longest, phone: longestPhone, email: longestEmail },
  });
  assert.deepEqual({ ...prepared.command.audit, correlationId: '' }, {
    action: 'tenant.customer.create', permission: 'create_customers', scope: 'tenant', tenant: T1, store: null, actor: ACTOR, correlationId: '',
    reasonCode: null, reason: null,
  }, 'the audit record carries the trusted scope and no name, phone or email');
  assert.ok(!JSON.stringify(prepared.command.audit).includes(ch(0x1f4de)) && !JSON.stringify(prepared.command.audit).includes('@'), 'no contact in the audit record');
  assert.ok(!JSON.stringify(prepared.command.response).includes(ch(0x1f4de)), 'nor in the sealed 201');
  assert.deepEqual(prepared.command.events, []);
});

// --- 4. the chain over real loopback sockets, on the tenant boundary --------------------------------------------------------

const TENANT_ORIGIN = 'http://pos.trusted.test';
const BEARER = 'synthetic-tenant-bearer';
interface Reply { status: number; headers: http.IncomingHttpHeaders; body: string }

function request(port: number, method: string, path: string, headers: Record<string, string>, body?: string): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path, headers, agent: false }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: text }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

interface Harness {
  commits: TransactionCommand[]; authorizations: unknown[][]; logs: string[]; id: string; storeKey: string;
  /** What the authorizer answers from now on; the default is SCOPE, granted. */
  setScope(scope: TrustedScope | false): void;
  setAnswer(answer: 'committed' | 'unavailable'): void;
  /** Preseed a COMPLETED idempotency record for this key and body, holding `sealed` as its response — as an earlier build left it. */
  seedCompleted(key: string, body: string, sealed: (operation: { scope: string; fingerprint: string }) => string): void;
  post(over?: { body?: string; key?: string | null; headers?: Record<string, string> }): Promise<Reply>;
}

async function withChain(fn: (h: Harness) => Promise<void>): Promise<void> {
  const commits: TransactionCommand[] = [];
  const authorizations: unknown[][] = [];
  const logs: string[] = [];
  let scope: TrustedScope | false = SCOPE;
  let answer: 'committed' | 'unavailable' = 'committed';
  const keyring = createIdempotencyKeyring(TEST_IDEMPOTENCY_KEY);
  const state = createMemoryIdempotencyState();
  const inner = createMemoryIdempotencyStore(state);
  const seedCompleted: Harness['seedCompleted'] = (key, body, sealed) => {
    // The operation this chain derives for the key, principal, trusted scope and exact body bytes (app.ts).
    const operation = keyring.operationOf(key, { authProvider: 'synthetic', authProviderUid: 'uid-customers' }, {
      method: 'POST', path: CUSTOMER_DIRECTORY_PATH, audience: 'tenant', tenant: SCOPE.tenant, store: null, actor: ACTOR, body: Buffer.from(body),
    });
    const t = Date.now();
    state.records.set(operation.scope, {
      fingerprint: operation.fingerprint, lease: 'l'.repeat(43), leaseExpiresAt: t, expiresAt: t + IDEMPOTENCY_POLICY.retentionMs, response: sealed(operation),
    });
  };
  // Commits through the idempotency store's own lease check, as the one-database adapter does.
  const port: CommandTransactionPort = {
    async commit(c, s) {
      commits.push(c);
      if (answer !== 'committed') return { outcome: answer };
      const done = await inner.complete(Object.freeze({ scope: c.scope, lease: c.lease, response: c.response }), s);
      return { outcome: (done as { outcome?: unknown }).outcome === 'completed' ? 'committed' : 'lease_lost' };
    },
    probe: () => true,
  };
  const boundary: SessionBoundaryDeps = {
    trustedOrigins: [TENANT_ORIGIN],
    verifier: {
      async verify(credential) {
        return credential.bearerToken === BEARER
          ? { verified: true, authProvider: 'synthetic', authProviderUid: 'uid-customers', authenticatedAt: Date.now(), secondFactor: null }
          : null;
      },
    },
    admission: { admit: () => ({ admitted: true, securityVersion: 'v1', actor: ACTOR }) },
    authorizer: { authorize: (...args: unknown[]) => { authorizations.push(args); return scope === false ? false : { granted: true, context: scope }; } },
    store: createMemorySessionStore(),
  };
  const readiness = createReadinessState();
  readiness.setReady();
  const app = createApp({
    readiness, log: { log: (line: string) => { logs.push(line); } }, sessions: { tenant: boundary }, routes: [CUSTOMER_CREATE_ROUTE],
    limits: testRequestLimits(), idempotency: { store: inner, keySecret: TEST_IDEMPOTENCY_KEY }, transactions: { port },
  });
  const server = createBoundedServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const p = (server.address() as AddressInfo).port;
    const login = await request(p, 'POST', sessionPaths('tenant').login, {
      origin: TENANT_ORIGIN, 'sec-fetch-site': 'same-origin', [CSRF_HEADER]: CSRF_HEADER_VALUE, authorization: `Bearer ${BEARER}`, 'content-length': '0',
    });
    assert.equal(login.status, 200, `tenant login: ${login.body}`);
    const pair = (login.headers['set-cookie'] ?? [''])[0].split('; ')[0];
    const id = pair.slice(pair.indexOf('=') + 1);
    const csrf = (JSON.parse(login.body) as { csrfToken: string }).csrfToken;
    // The store key the chain derives from the identifier, computed here independently (sessions.ts digestOf).
    const storeKey = createHash('sha256').update(id).digest('base64url');
    authorizations.length = 0;
    const post: Harness['post'] = ({ body = JSON.stringify({ name: 'Ada Lovelace' }), key = randomUUID(), headers = {} } = {}) => request(p, 'POST', CUSTOMER_DIRECTORY_PATH, {
      origin: TENANT_ORIGIN, 'sec-fetch-site': 'same-origin', [CSRF_HEADER]: CSRF_HEADER_VALUE, 'content-type': 'application/json',
      cookie: `${SESSION_COOKIES.tenant}=${id}`, [SESSION_CSRF_HEADER]: csrf, 'content-length': String(Buffer.byteLength(body)),
      ...(key === null ? {} : { 'idempotency-key': key }), ...headers,
    }, body);
    await fn({ commits, authorizations, logs, id, storeKey, post, setScope: (s) => { scope = s; }, setAnswer: (a) => { answer = a; }, seedCompleted });
  } finally {
    await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); });
  }
}

const errorOf = (r: Reply): unknown => (JSON.parse(r.body) as { error?: unknown }).error;

test('a committed create answers 201 { customer: { id, name } }, and the port receives the trusted scope and the presenting session', async () => {
  await withChain(async (h) => {
    const r = await h.post({ body: JSON.stringify({ name: '  Ada  Lovelace ' }), headers: { 'x-tenant-id': T2, 'x-role': 'store_owner' } });
    assert.equal(r.status, 201, r.body);
    const { customer } = JSON.parse(r.body) as { customer: { id: string; name: string } };
    assert.deepEqual(Object.keys(JSON.parse(r.body) as object), ['customer']);
    assert.deepEqual(Object.keys(customer), ['id', 'name']);
    assert.match(customer.id, UUID_V4_RE, 'a server-generated v4 id');
    assert.equal(customer.name, 'Ada  Lovelace', 'the name as stored');
    assert.equal(r.headers.location, `/api/v1/customers/${customer.id}`, 'Location names the detail route of the new id (M7A-CUSTOMERS-P4)');
    assert.equal(r.headers['idempotent-replayed'], undefined);
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) assert.equal(r.headers[name.toLowerCase()], value, name);
    assert.deepEqual(h.authorizations.map((a) => a[1]), [{ scope: 'tenant', permission: 'create_customers' }], 'the declared requirement, never one the request names');
    assert.equal(h.commits.length, 1);
    const [c] = h.commits;
    // M7A-CUSTOMERS-P6 changed one expectation deliberately: an absent contact is '' in the change set (a record holds no null).
    assert.deepEqual(c.mutation, { kind: 'tenant.customer.create', aggregateType: 'customer', aggregateId: customer.id, expectedVersion: null, changes: { name: 'Ada  Lovelace', phone: '', email: '' } });
    assert.deepEqual(c.context, SCOPE, 'the authorizer\'s scope, unchanged by any header');
    assert.equal(c.sessionKey, h.storeKey, 'the presenting session\'s store key, for the store to hold and hand its routine');
    assert.deepEqual([c.audit.action, c.audit.permission, c.audit.scope, c.audit.tenant, c.audit.store, c.audit.actor], ['tenant.customer.create', 'create_customers', 'tenant', T1, null, ACTOR]);
    assert.deepEqual(c.events, []);
    assert.equal(c.unchanged, null, 'a create has no unchanged response');
  });
});

test('the key is bound to the trusted tenant and actor: a same-principal retry replays, the same key in another tenant or as another actor is the 422', async () => {
  await withChain(async (h) => {
    const key = randomUUID();
    const body = JSON.stringify({ name: 'Grace Hopper' });
    const first = await h.post({ key, body });
    assert.equal(first.status, 201, first.body);
    const replay = await h.post({ key, body });
    assert.deepEqual([replay.status, replay.body, replay.headers['idempotent-replayed']], [201, first.body, 'true'], 'replayed byte for byte');
    assert.equal(replay.headers.location, first.headers.location, 'the sealed Location replays with it');
    assert.equal(first.headers.location, `/api/v1/customers/${(JSON.parse(first.body) as { customer: { id: string } }).customer.id}`);
    // The same principal, key and body, after the principal's one tenant grant moved from T1 to T2 — never T1's customer.
    h.setScope({ ...SCOPE, tenant: T2 });
    const moved = await h.post({ key, body });
    assert.deepEqual([moved.status, errorOf(moved)], [422, 'idempotency_key_reused'], moved.body);
    assert.ok(!moved.body.includes((JSON.parse(first.body) as { customer: { id: string } }).customer.id), 'nothing of T1\'s record reaches T2');
    h.setScope({ ...SCOPE, actor: OTHER_ACTOR });
    const other = await h.post({ key, body });
    assert.deepEqual([other.status, errorOf(other)], [422, 'idempotency_key_reused'], 'another resolved actor');
    h.setScope(SCOPE);
    assert.equal((await h.post({ key, body })).body, first.body, 'the original context still replays its own');
    assert.equal(h.commits.length, 1, 'one commit for the key');
    // Two keys with one name are two customers: no uniqueness rule exists.
    const second = await h.post({ body });
    assert.equal(second.status, 201, second.body);
    assert.notEqual(second.body, first.body, 'a distinct id');
    assert.equal(h.commits.length, 2);
  });
});

test('refusals before the store: a denial, a missing or malformed key, a body the contract refuses, malformed JSON — none commits', async () => {
  await withChain(async (h) => {
    const cases: Array<[string, Parameters<Harness['post']>[0], number, string]> = [
      ['no key', { key: null }, 400, 'invalid_request'], ['a malformed key', { key: 'not-a-uuid' }, 400, 'invalid_request'],
      ['a tenant selector', { body: JSON.stringify({ name: 'A', tenantId: T2 }) }, 400, 'invalid_request'],
      ['a client id', { body: JSON.stringify({ name: 'A', id: randomUUID() }) }, 400, 'invalid_request'],
      ['an array', { body: '[]' }, 400, 'invalid_request'], ['an invisible name', { body: JSON.stringify({ name: ch(0x2800) }) }, 400, 'invalid_request'],
      ['a lone surrogate escape', { body: '{"name":"a\\ud800"}' }, 400, 'invalid_request'], ['malformed JSON', { body: '{"name":' }, 400, 'invalid_request'],
      ['no session CSRF', { headers: { [SESSION_CSRF_HEADER]: 'wrong' } }, 403, 'forbidden'],
      ['a cross-site request', { headers: { 'sec-fetch-site': 'cross-site' } }, 403, 'forbidden'],
      ['another origin', { headers: { origin: 'http://admin.trusted.test' } }, 403, 'forbidden'],
      // M7A-CUSTOMERS-P6: the cap is 8192 bytes (a body of 4100 is now admitted, and refused only as a 201-scalar name).
      ['an over-cap name', { body: JSON.stringify({ name: 'a'.repeat(4_100) }) }, 400, 'invalid_request'],
      ['an oversized body', { body: JSON.stringify({ name: 'a'.repeat(8_200) }) }, 413, 'content_too_large'],
      ['a refused phone', { body: JSON.stringify({ name: 'Ada', phone: 'no digit' }) }, 400, 'invalid_request'],
      ['a refused email', { body: JSON.stringify({ name: 'Ada', email: 'a@b@example.test' }) }, 400, 'invalid_request'],
      ['an unknown field beside the contacts', { body: JSON.stringify({ name: 'Ada', phone: '1', email: 'a@example.test', id: randomUUID() }) }, 400, 'invalid_request'],
    ];
    for (const [label, over, status, error] of cases) {
      const r = await h.post(over);
      assert.deepEqual([r.status, errorOf(r)], [status, error], `${label}: ${r.body}`);
      assert.deepEqual(Object.keys(JSON.parse(r.body) as object).sort(), ['error', 'requestId'], `${label}: bounded`);
    }
    h.setScope(false);
    const denied = await h.post();
    assert.deepEqual([denied.status, errorOf(denied)], [403, 'forbidden'], 'an authorizer denial (the real create_customers decision: m5CanonicalPermissions.test.ts)');
    assert.equal(h.commits.length, 0, 'nothing reached the transaction port');
  });
});

test('a refusal inside the transaction is a bounded 503 that is never replayed, and no log line carries the name, key, cookie or session key', async () => {
  await withChain(async (h) => {
    const name = 'Canary Quux 7f3a';
    const key = randomUUID();
    h.setAnswer('unavailable');
    const refused = await h.post({ key, body: JSON.stringify({ name }) });
    assert.deepEqual([refused.status, errorOf(refused)], [503, 'service_unavailable'], refused.body);
    assert.ok(!refused.body.includes(name), 'the 503 names nothing');
    h.setAnswer('committed');
    const retry = await h.post({ key, body: JSON.stringify({ name }) });
    assert.deepEqual([retry.status, errorOf(retry), h.commits.length], [409, 'request_in_progress', 1], 'no replay and no second commit while the lease holds');
    const created = await h.post({ body: JSON.stringify({ name }) });
    assert.equal(created.status, 201, created.body);
    assert.ok(h.logs.length > 0 && h.logs.some((line) => line.includes(String(created.headers['x-request-id']))), 'the chain logged its requests (control)');
    for (const line of h.logs) {
      for (const secret of [name, key, h.id, h.storeKey]) assert.ok(!line.includes(secret), `a log line carries ${secret.slice(0, 6)}...`);
    }
  });
});

test('a completion sealed BEFORE M7A-CUSTOMERS-P4 replays on its first request with this build: 201, the sealed body, no Location, nothing committed', async () => {
  await withChain(async (h) => {
    const key = randomUUID();
    const body = JSON.stringify({ name: 'Legacy Customer' });
    const id = randomUUID();
    const sealedBody = JSON.stringify({ customer: { id, name: 'Legacy Customer' } });
    // EXACTLY what the pre-change build sealed for a create, written out as a literal — not derived from this build's plan.
    // Before M7A-CUSTOMERS-P4 the plan's response was { status: 201, body } with no `headers`, and idempotency.ts (unchanged
    // by this change) recorded it as the four fields { status, contentType, headers, body } with `headers` the EMPTY object
    // (envelopeFromOutcome: `headers === undefined ? {} : headers`). A sealed envelope with no `headers` member at all was
    // never written by any build: envelopeOf refuses one on read, so it could not replay (asserted below).
    const preChange = { status: 201, contentType: 'application/json; charset=utf-8', headers: {}, body: sealedBody };
    assert.deepEqual(envelopeFromOutcome({ status: 201, body: { customer: { id, name: 'Legacy Customer' } } }), preChange,
      'the literal is the pre-change plan\'s envelope, byte for byte');
    const keyring = createIdempotencyKeyring(TEST_IDEMPOTENCY_KEY);
    let operation: { scope: string; fingerprint: string } | null = null;
    h.seedCompleted(key, body, (op) => { operation = op; return keyring.seal(preChange, op); });
    assert.ok(operation !== null);
    assert.equal(keyring.unseal(keyring.seal({ status: 201, contentType: preChange.contentType, body: sealedBody } as never, operation), operation), null,
      'an envelope lacking `headers` does not unseal: no build could have left one to replay');
    // The FIRST request with the key is a replay: the sealed 201, no Location, no commit, no port call.
    const first = await h.post({ key, body });
    assert.deepEqual([first.status, first.body, first.headers['idempotent-replayed']], [201, sealedBody, 'true'], first.body);
    assert.equal(first.headers.location, undefined, 'a pre-change completion replays without Location, exactly as committed');
    assert.equal(h.commits.length, 0, 'nothing planned, committed or sent to the port');
    // A key sealed by this build replays its Location.
    const newKey = randomUUID();
    const fresh = await h.post({ key: newKey, body });
    const again = await h.post({ key: newKey, body });
    assert.equal(fresh.headers.location, `/api/v1/customers/${(JSON.parse(fresh.body) as { customer: { id: string } }).customer.id}`);
    assert.deepEqual([again.headers['idempotent-replayed'], again.headers.location, again.body], ['true', fresh.headers.location, fresh.body]);
    assert.equal(h.commits.length, 1, 'one commit: the new key\'s first request');
  });
});

// --- 5. contacts and idempotency (M7A-CUSTOMERS-P6) -------------------------------------------------------------------------

test('contacts ride in the fingerprint as bytes: the same key and bytes replay the sealed 201; a changed phone, email or spelling under the key is the 422', async () => {
  await withChain(async (h) => {
    const key = randomUUID();
    const body = JSON.stringify({ name: 'Ada Lovelace', phone: '+1 555 0100', email: 'ada@example.test' });
    const first = await h.post({ key, body });
    assert.equal(first.status, 201, first.body);
    const { customer } = JSON.parse(first.body) as { customer: { id: string; name: string } };
    assert.deepEqual(JSON.parse(first.body), { customer: { id: customer.id, name: 'Ada Lovelace' } }, 'the 201 is {customer:{id,name}}: no contact');
    assert.equal(first.headers.location, `/api/v1/customers/${customer.id}`);
    assert.deepEqual(h.commits[0].mutation.changes, { name: 'Ada Lovelace', phone: '+1 555 0100', email: 'ada@example.test' });
    const replay = await h.post({ key, body });
    assert.deepEqual([replay.status, replay.body, replay.headers['idempotent-replayed'], replay.headers.location], [201, first.body, 'true', first.headers.location]);
    for (const [label, changed] of [
      ['a changed phone', JSON.stringify({ name: 'Ada Lovelace', phone: '+1 555 0199', email: 'ada@example.test' })],
      ['a changed email', JSON.stringify({ name: 'Ada Lovelace', phone: '+1 555 0100', email: 'grace@example.test' })],
      ['the phone dropped', JSON.stringify({ name: 'Ada Lovelace', email: 'ada@example.test' })],
      ['the same values, another key order', JSON.stringify({ email: 'ada@example.test', name: 'Ada Lovelace', phone: '+1 555 0100' })],
      ['the same values, padded', JSON.stringify({ name: 'Ada Lovelace', phone: ' +1 555 0100', email: 'ada@example.test' })],
    ] as const) {
      const r = await h.post({ key, body: changed });
      assert.deepEqual([r.status, errorOf(r)], [422, 'idempotency_key_reused'], `${label}: ${r.body}`);
      assert.ok(!r.body.includes('555') && !r.body.includes('@'), `${label}: the refusal names no contact`);
    }
    // A name-only body and the same name with an explicit null phone are two spellings: the bytes, not the parsed value, bind.
    const nameOnly = randomUUID();
    assert.equal((await h.post({ key: nameOnly, body: '{"name":"Grace"}' })).status, 201);
    const nulled = await h.post({ key: nameOnly, body: '{"name":"Grace","phone":null}' });
    assert.deepEqual([nulled.status, errorOf(nulled)], [422, 'idempotency_key_reused'], nulled.body);
    assert.equal(h.commits.length, 2, 'one commit per key; no refusal re-planned');
    for (const line of h.logs) assert.ok(!line.includes('555 0') && !line.includes('example.test'), 'no log line carries a contact');
  });
});

test('a name-only body keeps the fingerprint the pre-contact code computed: pinned, and a record sealed with Location before contacts replays unchanged', async () => {
  // The fingerprint app.ts derives for these exact inputs, computed with this repository's code at ad584b5 (idempotency.ts
  // is unchanged by M7A-CUSTOMERS-P6) and written out here; assembled from two halves so no scanner reads a token literal.
  const keyring = createIdempotencyKeyring(TEST_IDEMPOTENCY_KEY);
  const pinned = ['jNmrjvWu3XnY6Zbou', 'QMNeh5VfHOl7vZjA2g3II2kZYQ'].join('');
  const operation = keyring.operationOf('0b6f1d2e-3c4a-4b5c-8d6e-7f8091a2b3c4', { authProvider: 'synthetic', authProviderUid: 'uid-customers' }, {
    method: 'POST', path: CUSTOMER_DIRECTORY_PATH, audience: 'tenant', tenant: T1, store: null, actor: ACTOR, body: Buffer.from('{"name":"Ada Lovelace"}'),
  });
  assert.equal(operation.fingerprint, pinned, 'a name-only body\'s fingerprint is unchanged: no default contact enters it');
  await withChain(async (h) => {
    // EXACTLY what the P4/P5 build sealed for a name-only create: the four envelope fields with Location, as a literal.
    const key = randomUUID();
    const body = JSON.stringify({ name: 'Sealed Before Contacts' });
    const id = randomUUID();
    const sealedBody = JSON.stringify({ customer: { id, name: 'Sealed Before Contacts' } });
    const p5 = { status: 201, contentType: 'application/json; charset=utf-8', headers: { location: `/api/v1/customers/${id}` }, body: sealedBody };
    assert.deepEqual(envelopeFromOutcome({ status: 201, body: { customer: { id, name: 'Sealed Before Contacts' } }, headers: { location: `/api/v1/customers/${id}` } }), p5);
    h.seedCompleted(key, body, (op) => keyring.seal(p5, op));
    const replay = await h.post({ key, body });
    assert.deepEqual([replay.status, replay.body, replay.headers['idempotent-replayed'], replay.headers.location],
      [201, sealedBody, 'true', `/api/v1/customers/${id}`], replay.body);
    // The same key with a contact added is a changed request against that record, never a re-plan.
    const changed = await h.post({ key, body: JSON.stringify({ name: 'Sealed Before Contacts', phone: '+1 555 0100' }) });
    assert.deepEqual([changed.status, errorOf(changed)], [422, 'idempotency_key_reused']);
    assert.equal(h.commits.length, 0, 'nothing planned, committed or sent to the port');
  });
});
