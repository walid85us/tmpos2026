// Phase 4.0 M5-GIAM-D1-P3 — the console's display-name and reason checks against the server's own rules: over one
// corpus, checkDisplayName / checkReason (tenantManagementClient.ts) accept exactly what normalizeTenantDisplayName
// (server/runtime/tenantDisplayName.ts) / normalizeTenantStatusReason (server/runtime/tenantStatus.ts) accept, refuse
// exactly what they refuse, and the accepted value is the identical string. Special characters are built from code
// points, so this source stays ASCII.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkDisplayName, checkReason } from './tenantManagementClient';
import { normalizeTenantDisplayName } from '../../../server/runtime/tenantDisplayName';
import { normalizeTenantStatusReason } from '../../../server/runtime/tenantStatus';

const cp = (code: number): string => String.fromCodePoint(code);
const unit = (code: number): string => String.fromCharCode(code); // a lone surrogate is one UTF-16 unit

const BIDI_CONTROL = [0x061c, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069];
const C0 = Array.from({ length: 0x20 }, (_, i) => i);
const C1_AND_DEL = Array.from({ length: 0x9f - 0x7f + 1 }, (_, i) => 0x7f + i);
const SEPARATORS = [0x2028, 0x2029];
const SURROGATES = [0xd800, 0xdbff, 0xdc00, 0xdfff];
const ASTRAL = cp(0x1f600); // two UTF-16 units, one scalar
const BASE = 'Acme Retail Group';

function corpus(): string[] {
  const out = [
    '', ' ', '   ', 'A', ' A ', 'ab', 'Tenant 42', BASE, `  ${BASE}  `, 'Reason ok!', 'Short one', 'Exactly10!',
    `\t${BASE}\n`, `${cp(0xa0)}${BASE}${cp(0x3000)}`, `${cp(0xfeff)}${BASE}`, // whitespace the trim removes
    'x'.repeat(9), 'x'.repeat(10), 'x'.repeat(119), 'x'.repeat(120), 'x'.repeat(121),
    'y'.repeat(499), 'y'.repeat(500), 'y'.repeat(501), ` ${'y'.repeat(500)} `,
    ASTRAL, ASTRAL.repeat(5), ASTRAL.repeat(10), ASTRAL.repeat(120), ASTRAL.repeat(121), ASTRAL.repeat(500), ASTRAL.repeat(501),
    `${'x'.repeat(119)}${ASTRAL}`, `${'x'.repeat(120)}${ASTRAL}`, // 120 and 121 scalars, astral last
    `Caf${cp(0xe9)} ${cp(0x4e2d)}${cp(0x6587)} ${cp(0x5d0)}${cp(0x5d1)}`, // Latin-1, CJK, Hebrew letters (not controls)
    `${BASE}${cp(0x200b)}`, `${BASE}${cp(0x200d)}`, // zero-width space/joiner: not Bidi_Control, not refused
    unit(0xd83d) + unit(0xde00), // a well-formed pair built from units
  ];
  for (const code of [...BIDI_CONTROL, ...C0, ...C1_AND_DEL, ...SEPARATORS]) {
    const ch = cp(code);
    out.push(ch, `${BASE}${ch}`, `${ch}${BASE}`, `Reason with ${ch} inside it`, `${'x'.repeat(60)}${ch}${'x'.repeat(59)}`);
  }
  for (const code of SURROGATES) {
    const ch = unit(code);
    out.push(ch, `${BASE}${ch}`, `${ch}${BASE}`, `Reason with ${ch} inside it`);
  }
  out.push(unit(0xde00) + unit(0xd83d)); // reversed pair: two lone surrogates
  return out;
}

function compare(name: string, client: (raw: string) => { value: string } | { problem: string }, server: (raw: unknown) => string | null) {
  let accepted = 0;
  let refused = 0;
  for (const raw of corpus()) {
    const mine = client(raw);
    const theirs = server(raw);
    const label = `${name} of ${JSON.stringify([...raw].map((c) => c.codePointAt(0)!.toString(16)).slice(0, 8))} (length ${raw.length})`;
    if (theirs === null) {
      assert.ok('problem' in mine, `${label}: the server refuses it, so the console must too`);
      refused++;
    } else {
      assert.ok('value' in mine, `${label}: the server accepts it, so the console must too`);
      assert.equal(mine.value, theirs, `${label}: the normalized value is identical`);
      accepted++;
    }
  }
  return { accepted, refused };
}

test('checkDisplayName accepts and refuses exactly what normalizeTenantDisplayName does, with the identical value', () => {
  const { accepted, refused } = compare('display name', checkDisplayName, normalizeTenantDisplayName);
  assert.ok(accepted >= 15, `the corpus exercises acceptance (${accepted})`);
  assert.ok(refused >= 300, `the corpus exercises refusal (${refused})`);
});

test('checkReason accepts and refuses exactly what normalizeTenantStatusReason does, with the identical value', () => {
  const { accepted, refused } = compare('reason', checkReason, normalizeTenantStatusReason);
  assert.ok(accepted >= 15, `the corpus exercises acceptance (${accepted})`);
  assert.ok(refused >= 300, `the corpus exercises refusal (${refused})`);
});

test('the corpus hits every boundary on both sides', () => {
  assert.deepEqual(checkDisplayName('x'.repeat(120)), { value: 'x'.repeat(120) });
  assert.deepEqual(checkDisplayName('x'.repeat(121)), { problem: 'too-long' });
  assert.deepEqual(checkDisplayName(ASTRAL.repeat(120)), { value: ASTRAL.repeat(120) }); // 240 units, 120 scalars
  assert.deepEqual(checkDisplayName('   '), { problem: 'empty' });
  assert.deepEqual(checkReason('x'.repeat(9)), { problem: 'too-short' });
  assert.deepEqual(checkReason(` ${'y'.repeat(500)} `), { value: 'y'.repeat(500) });
  assert.deepEqual(checkReason('y'.repeat(501)), { problem: 'too-long' });
  for (const code of [...BIDI_CONTROL, ...C0, 0x7f, 0x85, 0x9f, 0x2028, 0x2029]) {
    assert.deepEqual(checkDisplayName(`${BASE}${cp(code)}${BASE}`), { problem: 'character' }, `U+${code.toString(16)} inside is refused`);
    assert.equal(normalizeTenantDisplayName(`${BASE}${cp(code)}${BASE}`), null);
  }
  for (const code of SURROGATES) assert.deepEqual(checkReason(`Reason with ${unit(code)} inside it`), { problem: 'character' });
  assert.equal(normalizeTenantDisplayName(42), null); // the server also refuses a non-string; the console only ever sends text
});
