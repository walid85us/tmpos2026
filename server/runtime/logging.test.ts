// Phase 4.0 M3 — structured-log schema + redaction tests.
//
// A log record carries ONLY an enumerated allowlist of fields, is always
// parseable JSON, and can never be forged into a second record by a
// user-controlled string. Sensitive material is never accepted by the API.
// Adversarial bytes are built at runtime so this source stays printable ASCII.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildLogRecord, sanitizeLogValue, emitLog } from './logging.js';

const ALLOWED = ['timestamp', 'level', 'event', 'requestId', 'method', 'route', 'status', 'durationMs', 'reason'];
// Any C0 control byte, DEL, or C1 control byte — matched from code points so this
// source contains no literal control characters.
const CONTROL = new RegExp('[\\u0000-\\u001f\\u007f-\\u009f]');
const ch = (code: number) => String.fromCharCode(code);
const NL = ch(10);

test('a record contains only allowlisted keys', () => {
  const rec = buildLogRecord('info', {
    event: 'request', requestId: 'r-1', method: 'GET', route: '/health', status: 200, durationMs: 3, reason: 'ok',
  });
  for (const k of Object.keys(rec)) assert.ok(ALLOWED.includes(k), `unexpected key: ${k}`);
});

test('non-allowlisted fields are dropped by construction', () => {
  const rec = buildLogRecord('info', {
    event: 'request',
    // deliberately smuggled — must never be read:
    authorization: 'Bearer secret-token',
    email: 'person@example.com',
    password: 'hunter2',
  } as never);
  const json = JSON.stringify(rec);
  assert.ok(!json.includes('secret-token'));
  assert.ok(!json.includes('person@example.com'));
  assert.ok(!json.includes('hunter2'));
  assert.ok(!('authorization' in rec) && !('email' in rec) && !('password' in rec));
});

test('the record is always parseable JSON', () => {
  const line = JSON.stringify(buildLogRecord('warn', { event: 'x' }));
  assert.doesNotThrow(() => JSON.parse(line));
});

test('control characters, ANSI escapes, and unicode line separators are stripped', () => {
  // ESC[31m (ANSI colour) + CR + LF + TAB + U+2028 LINE SEP + U+2029 PARA SEP.
  const dirty = 'evt' + ch(27) + '[31m ' + ch(13) + ch(10) + ch(9) + ch(0x2028) + ch(0x2029) + ' clean';
  const clean = sanitizeLogValue(dirty);
  assert.equal(CONTROL.test(clean), false, 'no control byte may survive');
  assert.equal(clean.includes(ch(0x2028)), false, 'U+2028 must be stripped');
  assert.equal(clean.includes(ch(0x2029)), false, 'U+2029 must be stripped');
  assert.ok(clean.includes('clean'));
});

test('a user string cannot forge a second log record', () => {
  const forged = 'evt"}' + NL + '{"level":"error","event":"injected';
  const rec = buildLogRecord('info', { event: forged });
  // The newline must be stripped from the VALUE itself, not merely escaped by
  // JSON.stringify — so this fails if sanitizeLogValue is disabled (JSON escaping
  // alone would make a line-count check pass vacuously).
  assert.equal(String(rec.event).includes(NL), false, 'the newline must be stripped from the value');
  const line = JSON.stringify(rec);
  assert.equal(String(JSON.parse(line).event).includes(NL), false);
});

test('long values are bounded', () => {
  const rec = buildLogRecord('info', { event: 'e', reason: 'r'.repeat(5000) });
  assert.ok(String(rec.reason).length <= 200);
});

test('numeric fields accept only finite numbers', () => {
  const rec = buildLogRecord('info', { event: 'e', status: Number.NaN, durationMs: Number.POSITIVE_INFINITY });
  assert.ok(!('status' in rec));
  assert.ok(!('durationMs' in rec));
});

test('emitLog writes a single JSON line to the injected sink', () => {
  const lines: string[] = [];
  emitLog('error', { event: 'boom', reason: 'internal_error' }, { log: (l: string) => lines.push(l) });
  assert.equal(lines.length, 1);
  const parsed = JSON.parse(lines[0]);
  assert.equal(parsed.level, 'error');
  assert.equal(parsed.event, 'boom');
});
