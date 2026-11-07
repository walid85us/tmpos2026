// M7B-PAYMENTS-P1 (doc 15 §12.5, docs/phase-4/05 line 38) — the safe log redacts card security codes, track data and the PIN
// block by key, beside the keys it already redacted; operational keys stay readable.
import test from 'node:test';
import assert from 'node:assert/strict';
import { redactObject } from './safe-log';

test('SLG-01 the card-data key fragments are redacted whatever their case or prefix; the earlier fragments still are; operational keys are kept', () => {
  const redacted = redactObject({
    cvv: '123', CVC: '456', track1: 'B4111', Track2: '4111=', pinBlock: 'ab12', PINBLOCK: 'cd34', cardCvv: '789', customerPinBlock: 'ef56',
    password: 'p', customerEmail: 'e', status: 409, invoiceId: 'inv-1', amountCents: 1250,
  }) as Record<string, unknown>;
  for (const key of ['cvv', 'CVC', 'track1', 'Track2', 'pinBlock', 'PINBLOCK', 'cardCvv', 'customerPinBlock', 'password', 'customerEmail']) {
    assert.equal(redacted[key], '[REDACTED]', key);
  }
  assert.deepEqual([redacted.status, redacted.invoiceId, redacted.amountCents], [409, 'inv-1', 1250], 'operational values kept');
  const nested = redactObject({ payment: { method: 'cash', track2: '4111=' } }) as { payment: Record<string, unknown> };
  assert.deepEqual(nested.payment, { method: 'cash', track2: '[REDACTED]' }, 'nested too');
});
