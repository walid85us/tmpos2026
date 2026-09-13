// Phase 4.0 M3 — CSRF / exact-origin contract for state-changing requests.
//
// Generalises the approved BCP controlled-action guard (exact trusted Origin with no
// suffix/substring match, Fetch-Metadata cross-site rejection, and a required
// non-safelisted custom header) from one route to every unsafe runtime route.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CSRF_HEADER, CSRF_HEADER_VALUE, UNSAFE_METHODS,
  normalizeOrigin, parseTrustedOrigins, evaluateRequestSecurity,
} from './requestSecurity.js';
import { EnforcementSetupError } from './routes.js';

const TRUSTED = 'https://pos.example.test';
const trusted = parseTrustedOrigins([TRUSTED]);
const valid = { origin: TRUSTED, [CSRF_HEADER]: CSRF_HEADER_VALUE, 'sec-fetch-site': 'same-origin' };

test('exactly the four state-changing methods require CSRF evidence', () => {
  assert.deepEqual([...UNSAFE_METHODS].sort(), ['DELETE', 'PATCH', 'POST', 'PUT']);
});

test('an origin is accepted only in its exact canonical form', () => {
  for (const ok of ['https://pos.example.test', 'http://127.0.0.1:5173', 'https://pos.example.test:8443']) {
    assert.equal(normalizeOrigin(ok), ok);
  }
  for (const bad of [
    'https://pos.example.test/', 'https://pos.example.test/path', 'https://pos.example.test?x', 'https://pos.example.test#x',
    'https://user@pos.example.test', 'HTTPS://POS.EXAMPLE.TEST', 'https://pos.example.test:443', 'http://pos.example.test:80',
    'null', '*', '', ' https://pos.example.test', 'https://pos.example.test, https://evil.test', 'https://*.example.test',
    'ftp://pos.example.test', 'javascript:alert(1)', 'https:\\\\pos.example.test', undefined, 42,
  ]) {
    assert.equal(normalizeOrigin(bad), null, String(bad));
  }
});

test('trusted origins must each be canonical; one bad entry fails startup closed', () => {
  assert.deepEqual([...parseTrustedOrigins([TRUSTED, 'http://127.0.0.1:5173'])], [TRUSTED, 'http://127.0.0.1:5173']);
  assert.equal(parseTrustedOrigins(undefined).size, 0);
  for (const bad of ['*', `${TRUSTED}/`, 'null', '', 'https://*.example.test', 42]) {
    assert.throws(
      () => parseTrustedOrigins([TRUSTED, bad]),
      (e: unknown) => e instanceof EnforcementSetupError && e.code === 'trusted_origin_invalid',
      String(bad),
    );
  }
});

test('an exact-origin request carrying the custom header is accepted; Fetch-Metadata is optional', () => {
  assert.equal(evaluateRequestSecurity(valid, trusted), null);
  assert.equal(evaluateRequestSecurity({ origin: TRUSTED, [CSRF_HEADER]: CSRF_HEADER_VALUE }, trusted), null);
});

test('each missing or invalid piece of CSRF/origin evidence is refused with its own code', () => {
  const cases: Array<[Record<string, string | string[] | undefined>, string]> = [
    [{ ...valid, 'sec-fetch-site': 'cross-site' }, 'csrf_cross_site'],
    [{ ...valid, origin: undefined }, 'csrf_origin_missing'],
    [{ ...valid, origin: [TRUSTED, TRUSTED] }, 'csrf_origin_missing'],
    [{ ...valid, origin: 'null' }, 'csrf_origin_malformed'],
    [{ ...valid, origin: `${TRUSTED}/` }, 'csrf_origin_malformed'],
    [{ ...valid, origin: 'https://pos.example.test.evil.test' }, 'csrf_origin_mismatch'],
    [{ ...valid, origin: 'https://evil.test' }, 'csrf_origin_mismatch'],
    [{ ...valid, origin: 'http://pos.example.test' }, 'csrf_origin_mismatch'],
    [{ ...valid, [CSRF_HEADER]: undefined }, 'csrf_token_missing'],
    [{ ...valid, [CSRF_HEADER]: '0' }, 'csrf_token_invalid'],
    [{ ...valid, [CSRF_HEADER]: `${CSRF_HEADER_VALUE}, ${CSRF_HEADER_VALUE}` }, 'csrf_token_invalid'],
  ];
  for (const [headers, code] of cases) {
    assert.equal(evaluateRequestSecurity(headers, trusted), code, JSON.stringify(headers));
  }
});

test('with no trusted origin configured every unsafe request is refused (fail closed)', () => {
  assert.equal(evaluateRequestSecurity(valid, parseTrustedOrigins([])), 'csrf_unavailable');
});
