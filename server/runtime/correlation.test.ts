// Phase 4.0 M3 — correlation-ID contract tests.
//
// An inbound request ID is accepted only when it is a strict, bounded ASCII
// token; anything else is replaced by a cryptographically strong generated ID.
// The ID never confers authority or idempotency — it is a log/trace correlator.
// Adversarial bytes are built at runtime so this source stays printable ASCII.
import test from 'node:test';
import assert from 'node:assert/strict';
import { isValidRequestId, resolveRequestId } from './correlation.js';

const ch = (code: number) => String.fromCharCode(code);

test('a valid bounded inbound ID is retained verbatim', () => {
  assert.equal(resolveRequestId('abc123-DEF_456.z'), 'abc123-DEF_456.z');
  assert.equal(isValidRequestId('abc123-DEF_456.z'), true);
});

test('an absent ID is replaced by a generated, valid ID', () => {
  const id = resolveRequestId(undefined);
  assert.equal(isValidRequestId(id), true);
  // randomUUID shape — proves it is generated, not echoed.
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
});

test('invalid inbound IDs are replaced, not reflected', () => {
  const bad: Array<string | string[] | undefined> = [
    '',                                        // empty
    'short',                                   // below minimum length
    'has space',                               // whitespace
    'ctrl' + ch(1) + 'char',                   // control character
    'newline' + ch(10) + 'injection',          // log-forging newline
    'a,b,c',                                   // comma-joined (multiple values)
    'x'.repeat(129),                           // oversized
    'confusable' + ch(0x202e) + 'id',          // unicode directional-override trick
    ['a1b2c3d4', 'e5f6g7h8'],                  // duplicate header → array
  ];
  for (const v of bad) {
    const id = resolveRequestId(v);
    assert.equal(isValidRequestId(id), true, `replacement must be valid for ${JSON.stringify(v)}`);
    assert.notEqual(id, v, `must not reflect ${JSON.stringify(v)}`);
  }
});

test('length boundaries are exact: 7 rejected, 8 and 128 accepted, 129 rejected', () => {
  assert.equal(isValidRequestId('a'.repeat(7)), false);
  assert.equal(isValidRequestId('a'.repeat(8)), true);
  assert.equal(isValidRequestId('a'.repeat(128)), true);
  assert.equal(isValidRequestId('a'.repeat(129)), false);
  assert.equal(resolveRequestId('a'.repeat(8)), 'a'.repeat(8), 'exact-min valid id retained');
  assert.notEqual(resolveRequestId('a'.repeat(7)), 'a'.repeat(7), 'one-below-min replaced');
});

test('resolution is stable for the same valid input', () => {
  assert.equal(resolveRequestId('stable-id-0001'), resolveRequestId('stable-id-0001'));
});
