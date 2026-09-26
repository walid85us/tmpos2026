// Phase 4.0 M4 — TEST SUPPORT ONLY: a process-local session store, and the session-store
// contract every store must meet (the durable adapter included).
//
// This module is excluded from the deployable artifact (tsconfig.server.json) and is never
// imported by a production module or by the production composition root
// (tests/quality/production-runtime-contract.test.mjs), so no production call path can reach,
// wrap or substitute it: the runtime needs no identity check to keep it out of production.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { SessionAudience } from './routes.js';
import type { SessionAuditEntry, SessionEndAudit, SessionEstablishAudit, SessionRecord, SessionStore } from './sessions.js';

/** What the in-memory store recorded for one audited operation (M6-ADMIN-AUDIT-P1), in order. */
export interface MemorySessionAudit {
  readonly entry: SessionAuditEntry;
  /** The key the operation created (establish) or ended (end). */
  readonly key: string;
  /** The presented key establish ended, when it held a record of the new one's audience; otherwise null. */
  readonly replaced: string | null;
}

export interface MemorySessionStore extends Required<SessionStore> {
  /** Every audited operation that took effect, as the durable store would have recorded it. */
  readonly audits: readonly MemorySessionAudit[];
}

/** An in-memory store: records die with the process and are shared with no other instance. */
export function createMemorySessionStore(): MemorySessionStore {
  const records = new Map<string, SessionRecord>();
  const audits: MemorySessionAudit[] = [];
  const refuse = (reason: string): never => { throw new Error(`memory session store refused: ${reason}`); };
  return {
    audits,
    create: (key, record) => {
      // An administrative session is written only by establish, with its audit record.
      if (record.audience === 'admin') refuse('audit_required');
      records.set(key, Object.freeze({ ...record }));
    },
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
    // One synchronous step each, so all of it takes effect or none does — the durable store's one transaction. Both
    // audiences (M5-TENANT-SESSION-P1). This store holds no standing to re-read, so it never answers 'standing_changed';
    // its reauthentication rule is the durable store's (M5-ADMIN-REVOKE-P1).
    establish: (key, record, replaces, audit) => {
      if (record.audience !== 'admin' && record.audience !== 'tenant') refuse('audience_invalid');
      const held = replaces === null ? undefined : records.get(replaces);
      // A reauthentication must end the live session of its own audience and principal that it presents; anything
      // else ends, creates and records nothing. Checked first, as the durable store checks it before it creates.
      if (audit.action === 'reauthenticate' && (held === undefined || held.audience !== record.audience || held.principalKey !== record.principalKey)) {
        return 'session_ended';
      }
      // A taken key is refused BEFORE the presented session is touched.
      if (records.has(key)) refuse('not_created');
      if (replaces !== null) records.delete(replaces);
      records.set(key, Object.freeze({ ...record }));
      audits.push(Object.freeze({ entry: Object.freeze({ ...audit }), key, replaced: held?.audience === record.audience ? replaces : null }));
      return 'established';
    },
    end: (key, audit) => {
      const held = records.get(key);
      if (held === undefined) return 'absent';
      records.delete(key);
      audits.push(Object.freeze({ entry: Object.freeze({ ...audit }), key, replaced: null }));
      return 'ended';
    },
  };
}

/**
 * The instant every record in the contract below is created at. Exported because a DURABLE store
 * expires its records at their absolute lifetime (sessions.ts SessionStore) and so must be built with
 * a clock: one reading the wall clock would find every record here already long expired and return
 * none of them. A store with no clock of its own can ignore this.
 */
export const SESSION_CONTRACT_EPOCH = 1_700_000_000_000;

const record = (audience: SessionAudience, principalKey: string, t: number, authenticatedAt: number | null = t): SessionRecord => Object.freeze({
  audience, authProvider: 'synthetic', authProviderUid: `uid-${principalKey}`, principalKey,
  securityVersion: 'v1', authenticatedAt, createdAt: t, lastSeenAt: t, validatedAt: t,
});

/** A synthetic actor (UUID) for the contract's audited logins; never a real user. */
const CONTRACT_ACTOR = '0b6f1c2e-4d5a-4e3b-9c8d-7a6b5c4d3e2f';

/**
 * The behaviour the runtime relies on, run against any store: a record reads back as written;
 * an update changes only the fields it names and never recreates an absent or revoked record;
 * revocation is final; and revoking a principal ends every one of its sessions in that audience
 * and nothing else. An administrative session is never created, only established; a session of
 * either audience is established — ending the presented session it replaces, and refusing a taken
 * key without touching that session — and ended by `end`, which answers 'absent' once there is
 * nothing live to end (M5-TENANT-SESSION-P1: both audiences). A reauthentication establishes only
 * by ending the live session of its own audience and principal that it presents; otherwise it
 * answers 'session_ended' and changes nothing (M5-ADMIN-REVOKE-P1). What a durable store records
 * for them is not observable through the port; its own suite proves the records. A durable store
 * under this contract must be built with a standing check that admits (its standing is proved
 * against the real admission elsewhere).
 */
export async function assertSessionStoreContract(store: SessionStore): Promise<void> {
  const signal = new AbortController().signal;
  const t = SESSION_CONTRACT_EPOCH;
  const put = (key: string, r: SessionRecord): unknown => store.create(key, r, signal);
  const get = async (key: string): Promise<unknown> => (await store.get(key, signal)) ?? undefined;
  assert.ok(typeof store.establish === 'function' && typeof store.end === 'function', 'the store offers the audited pair');
  const audited = store as Required<SessionStore>;
  // Each record below is authenticated at t, which is what a login's entry must say it bound; a logout binds nothing.
  const audit = (action: 'login' | 'reauthenticate'): SessionEstablishAudit => Object.freeze({
    action, operationId: randomUUID(), actor: CONTRACT_ACTOR, authenticatedAt: t,
  });
  const logout = (): SessionEndAudit => Object.freeze({ action: 'logout', operationId: randomUUID(), actor: null, authenticatedAt: null });
  const admit = (key: string, r: SessionRecord, replaces: string | null = null): Promise<unknown> =>
    Promise.resolve(audited.establish(key, r, replaces, audit('login'), signal));
  const reauthenticate = (key: string, r: SessionRecord, replaces: string | null): Promise<unknown> =>
    Promise.resolve(audited.establish(key, r, replaces, audit('reauthenticate'), signal));

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
  await admit('k-d', record('admin', 'p-2', t));
  await put('k-e', record('tenant', 'p-3', t));
  await store.revokePrincipal('tenant', 'p-2', signal);
  assert.equal(await get('k-b'), undefined, 'every session of the principal in that audience ends');
  assert.equal(await get('k-c'), undefined);
  assert.notEqual(await get('k-d'), undefined, 'the same principal in the other audience is untouched');
  assert.notEqual(await get('k-e'), undefined, 'another principal is untouched');

  // The audited pair (M6-ADMIN-AUDIT-P1).
  await assert.rejects(async () => put('k-f', record('admin', 'p-4', t)), 'an administrative record is never created');
  assert.equal(await get('k-f'), undefined, 'and the refused create wrote nothing');
  await assert.rejects(async () => admit('k-f', record('support' as SessionAudience, 'p-4', t)), 'establish refuses an audience the runtime does not know');
  assert.equal(await get('k-f'), undefined);
  assert.equal(await admit('k-f', record('admin', 'p-4', t)), 'established', 'an establishment answers established');
  assert.deepEqual(await get('k-f'), record('admin', 'p-4', t), 'an established record reads back as written');
  // A reauthentication that presents no live session, another principal's, or a record of another audience ends,
  // creates and records nothing (M5-ADMIN-REVOKE-P1).
  await put('k-t', record('tenant', 'p-4', t));
  await admit('k-o', record('admin', 'p-9', t));
  for (const [label, presented] of [['no live session', 'k-absent'], ['another principal\'s session', 'k-o'], ['a record of another audience', 'k-t']]) {
    assert.equal(await reauthenticate('k-r', record('admin', 'p-4', t), presented), 'session_ended', `a reauthentication presenting ${label}`);
    assert.equal(await get('k-r'), undefined, `${label}: nothing created`);
  }
  assert.notEqual(await get('k-o'), undefined, 'another principal\'s presented session is left as it was');
  assert.notEqual(await get('k-t'), undefined, 'and so is a presented record of another audience');
  assert.equal(await reauthenticate('k-g', record('admin', 'p-4', t), 'k-f'), 'established');
  assert.equal(await get('k-f'), undefined, 'the presented session ends with the establishment that replaces it');
  assert.deepEqual(await get('k-g'), record('admin', 'p-4', t));
  assert.equal(await reauthenticate('k-r', record('admin', 'p-4', t), 'k-f'), 'session_ended', 'a session already ended cannot be ended again');
  assert.equal(await get('k-r'), undefined, 'so a second reauthentication presenting it creates nothing');
  assert.equal(await admit('k-h', record('admin', 'p-4', t), 'k-absent'), 'established');
  assert.notEqual(await get('k-h'), undefined, 'a presented key naming no session changes nothing but still establishes');
  await assert.rejects(async () => admit('k-g', record('admin', 'p-5', t), 'k-h'), 'a taken key is refused');
  assert.notEqual(await get('k-h'), undefined, 'without touching the presented session');
  assert.deepEqual(await get('k-g'), record('admin', 'p-4', t), 'and without overwriting the live one');
  await put('k-i', record('tenant', 'p-6', t));
  assert.equal(await admit('k-j', record('admin', 'p-6', t), 'k-i'), 'established');
  assert.equal(await get('k-i'), undefined, 'rotation ends whatever record is presented, whatever its audience');
  assert.equal(await audited.end('k-g', logout(), signal), 'ended', 'end ends a live session');
  assert.equal(await get('k-g'), undefined);
  assert.equal(await audited.end('k-g', logout(), signal), 'absent', 'nothing live to end: absent');
  // The tenant boundary issues and ends its sessions through the same pair (M5-TENANT-SESSION-P1).
  assert.equal(await admit('k-k', record('tenant', 'p-7', t)), 'established', 'a tenant session is established');
  assert.deepEqual(await get('k-k'), record('tenant', 'p-7', t));
  await admit('k-m', record('admin', 'p-7', t));
  assert.equal(await reauthenticate('k-l', record('tenant', 'p-7', t), 'k-m'), 'session_ended', 'a tenant reauthentication presenting its principal\'s administrative session');
  assert.equal(await get('k-l'), undefined, 'creates nothing');
  assert.notEqual(await get('k-m'), undefined, 'and leaves the presented session');
  assert.equal(await reauthenticate('k-l', record('tenant', 'p-7', t), 'k-k'), 'established', 'a tenant reauthentication ending its own session');
  assert.equal(await get('k-k'), undefined);
  assert.equal(await audited.end('k-l', logout(), signal), 'ended', 'end ends a live tenant session');
  assert.equal(await get('k-l'), undefined);
  assert.equal(await audited.end('k-l', logout(), signal), 'absent');
}
