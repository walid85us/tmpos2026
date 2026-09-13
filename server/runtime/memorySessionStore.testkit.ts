// Phase 4.0 M4 — TEST SUPPORT ONLY: a process-local session store, and the session-store
// contract every store must meet (the durable adapter included).
//
// This module is excluded from the deployable artifact (tsconfig.server.json) and is never
// imported by a production module or by the production composition root
// (tests/quality/production-runtime-contract.test.mjs), so no production call path can reach,
// wrap or substitute it: the runtime needs no identity check to keep it out of production.
import assert from 'node:assert/strict';
import type { SessionAudience } from './routes.js';
import type { SessionRecord, SessionStore } from './sessions.js';

/** An in-memory store: records die with the process and are shared with no other instance. */
export function createMemorySessionStore(): SessionStore {
  const records = new Map<string, SessionRecord>();
  return {
    create: (key, record) => { records.set(key, Object.freeze({ ...record })); },
    get: (key) => records.get(key),
    update: (key, fields) => {
      const record = records.get(key);
      if (record !== undefined) records.set(key, Object.freeze({ ...record, ...fields }));
    },
    revoke: (key) => { records.delete(key); },
    revokePrincipal: (audience, principalKey) => {
      for (const [key, record] of records) {
        if (record.audience === audience && record.principalKey === principalKey) records.delete(key);
      }
    },
  };
}

const record = (audience: SessionAudience, principalKey: string, t: number): SessionRecord => Object.freeze({
  audience, authProvider: 'synthetic', authProviderUid: `uid-${principalKey}`, principalKey,
  securityVersion: 'v1', createdAt: t, lastSeenAt: t, validatedAt: t,
});

/**
 * The behaviour the runtime relies on, run against any store: a record reads back as written;
 * an update changes only the fields it names and never recreates an absent or revoked record;
 * revocation is final; and revoking a principal ends every one of its sessions in that audience
 * and nothing else.
 */
export async function assertSessionStoreContract(store: SessionStore): Promise<void> {
  const signal = new AbortController().signal;
  const t = 1_700_000_000_000;
  const put = (key: string, r: SessionRecord): unknown => store.create(key, r, signal);
  const get = async (key: string): Promise<unknown> => (await store.get(key, signal)) ?? undefined;

  await put('k-a', record('tenant', 'p-1', t));
  assert.deepEqual(await get('k-a'), record('tenant', 'p-1', t), 'a record reads back as written');
  await store.update('k-a', { lastSeenAt: t + 5 }, signal);
  await store.update('k-a', { validatedAt: t + 7 }, signal);
  assert.deepEqual(await get('k-a'), { ...record('tenant', 'p-1', t), lastSeenAt: t + 5, validatedAt: t + 7 }, 'an update changes only its fields');
  await store.update('k-absent', { lastSeenAt: t }, signal);
  assert.equal(await get('k-absent'), undefined, 'an update never creates a record');
  await store.revoke('k-a', signal);
  await store.update('k-a', { lastSeenAt: t + 9 }, signal);
  assert.equal(await get('k-a'), undefined, 'a revoked record stays revoked');

  await put('k-b', record('tenant', 'p-2', t));
  await put('k-c', record('tenant', 'p-2', t));
  await put('k-d', record('admin', 'p-2', t));
  await put('k-e', record('tenant', 'p-3', t));
  await store.revokePrincipal('tenant', 'p-2', signal);
  assert.equal(await get('k-b'), undefined, 'every session of the principal in that audience ends');
  assert.equal(await get('k-c'), undefined);
  assert.notEqual(await get('k-d'), undefined, 'the same principal in the other audience is untouched');
  assert.notEqual(await get('k-e'), undefined, 'another principal is untouched');
}
