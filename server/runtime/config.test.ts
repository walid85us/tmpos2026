// Phase 4.0 M3 — fail-closed environment/config contract tests.
//
// The validator is PURE over an injected plain object: unit tests never mutate
// the global process environment. Failure output must carry only bounded field
// names and reason codes — never an injected value.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from './config.js';

/** A minimally-valid production environment; individual cases override one key. */
const base = (over: Record<string, string | undefined> = {}) => ({
  NODE_ENV: 'production',
  PORT: '8080',
  ...over,
});

test('accepts a valid production configuration', () => {
  const r = loadConfig(base());
  assert.equal(r.ok, true);
  assert.equal(r.config?.env, 'production');
  assert.equal(r.config?.port, 8080);
  assert.equal(r.config?.isProduction, true);
  assert.equal(r.config?.trustProxy, false);
});

test('accepts the test/development/staging classifications', () => {
  for (const env of ['test', 'development', 'staging']) {
    const r = loadConfig(base({ NODE_ENV: env }));
    assert.equal(r.ok, true, env);
    assert.equal(r.config?.env, env);
    assert.equal(r.config?.isProduction, false, env);
  }
});

test('production is never inferred from a permissive fallback', () => {
  // An unknown classification must be rejected, not silently downgraded/upgraded.
  const r = loadConfig(base({ NODE_ENV: 'prod' }));
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.field === 'NODE_ENV' && e.code === 'env_invalid'));
});

test('rejects a missing classification', () => {
  const r = loadConfig({ PORT: '8080' });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.field === 'NODE_ENV' && e.code === 'env_missing'));
});

test('rejects invalid ports (empty, signed, hex, fractional, overflow, trailing chars)', () => {
  for (const port of ['', ' ', '0', '-80', '+80', '80.5', '0x50', '65536', '99999999999', '80abc', ' 80', '80 ']) {
    const r = loadConfig(base({ PORT: port }));
    assert.equal(r.ok, false, `port=${JSON.stringify(port)} must be rejected`);
    assert.ok(r.errors.some((e) => e.field === 'PORT'), `port=${JSON.stringify(port)}`);
  }
});

test('rejects a missing port', () => {
  const r = loadConfig({ NODE_ENV: 'production' });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.field === 'PORT' && e.code === 'port_missing'));
});

test('accepts the port-range boundaries and decimal leading-zero ports', () => {
  assert.equal(loadConfig(base({ PORT: '1' })).config?.port, 1);
  assert.equal(loadConfig(base({ PORT: '65535' })).config?.port, 65535);
  // Leading zeros are decimal, never octal: '00080' -> 80.
  assert.equal(loadConfig(base({ PORT: '00080' })).config?.port, 80);
});

test('rejects a port with a trailing or leading newline', () => {
  const NL = String.fromCharCode(10);
  for (const p of ['8080' + NL, NL + '8080']) {
    const r = loadConfig(base({ PORT: p }));
    assert.equal(r.ok, false, JSON.stringify(p));
    assert.ok(r.errors.some((e) => e.field === 'PORT' && e.code === 'port_invalid'));
  }
});

test('accepts the explicit boolean vocabulary and rejects everything else', () => {
  assert.equal(loadConfig(base({ TRUST_PROXY: 'true' })).config?.trustProxy, true);
  assert.equal(loadConfig(base({ TRUST_PROXY: 'false' })).config?.trustProxy, false);
  for (const v of ['yes', '1', 'TRUE', 'on', 'y']) {
    const r = loadConfig(base({ TRUST_PROXY: v }));
    assert.equal(r.ok, false, `TRUST_PROXY=${v} must be rejected`);
    assert.ok(r.errors.some((e) => e.field === 'TRUST_PROXY' && e.code === 'bool_invalid'));
  }
});

test('rejects a production + DEV action-flag contradiction', () => {
  const r = loadConfig(base({ ENABLE_BCP_DEV_ACTION_ACKNOWLEDGE_READINESS_REVIEW: 'true' }));
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.code === 'production_dev_flag_conflict'));
});

test('permits the DEV action flag outside production', () => {
  const r = loadConfig(base({ NODE_ENV: 'development', ENABLE_BCP_DEV_ACTION_ACKNOWLEDGE_READINESS_REVIEW: 'true' }));
  assert.equal(r.ok, true);
});

test('failure output is sanitized: only { field, code }, never an injected value', () => {
  const r = loadConfig(base({ NODE_ENV: 'sentinel-env-value', PORT: 'sentinel-port-value' }));
  assert.equal(r.ok, false);
  const serialized = JSON.stringify(r.errors);
  assert.ok(!serialized.includes('sentinel-env-value'), 'must not echo the NODE_ENV value');
  assert.ok(!serialized.includes('sentinel-port-value'), 'must not echo the PORT value');
  for (const e of r.errors) assert.deepEqual(Object.keys(e).sort(), ['code', 'field']);
});

test('is pure over its input — reads only the injected object', () => {
  // No key is read from the real process.env; an empty-but-valid object suffices.
  const r = loadConfig({ NODE_ENV: 'staging', PORT: '3000' });
  assert.equal(r.ok, true);
  assert.equal(r.config?.port, 3000);
});
