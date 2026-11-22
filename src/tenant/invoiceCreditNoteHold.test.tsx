// M7B-CREDITNOTES-CN-P2 — the shop's credit-note hold (docs/phase-4/17 §2.6, §3.2, §3.6; §6 Hold) against injected clocks
// and fake timers (vitest, as the section's component suite: the hold binds the sign-out through ServerInvoiceDrafts): an
// attempt is held before its first send under a new generation and an open one is never replaced; one issue key ever
// (compare-and-set); `send` is the last gate (token, first-send-once, the 8-minute first send, the 9-minute register/issue and
// 23-hour settlement Check again by the larger of monotonic and wall-clock time, a decided stage, a request in flight before
// its 30 s boundary, a pause or Retry-After) and the timer scrubs bytes without sending; `decide` attributes and judges in one
// step; state moves forward only; a hide keeps the generation, a detach bumps it and keeps only what names the attempt.
// Ids are built at run time (secret scanning); a proof and a token are compared, never printed.
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, test, vi } from 'vitest';
import assert from 'node:assert/strict';
import {
  CREDIT_NOTE_FIRST_SEND_MS, CREDIT_NOTE_IN_PROGRESS_WAIT_MS, CREDIT_NOTE_REPLAY_MS, CREDIT_NOTE_SETTLE_REPLAY_MS, CREDIT_NOTE_STAGE_WAIT_MS, createCreditNoteHoldStore,
  isLiveCreditNote, isOpenCreditNote, replaySent, replayWindowOpen, sendBlockOf, type CreditNoteHoldInit, type CreditNoteHoldStore, type CreditNoteSend, type CreditNoteStage,
} from './invoiceCreditNoteHold';
import { creditNoteIssueBodyOf, creditNoteRegisterBodyOf, settleBodyOf, type CreditNoteCommandResult, type CreditNoteProofResult } from './invoiceIssuingClient';

const uuid = (n: number): string => `${n.toString(16).padStart(8, '0')}-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const UID = 'uid-a';
const ATTEMPT = uuid(0xa7e);
const OTHER_ATTEMPT = uuid(0xa7f);
const STORE = uuid(0x5a1);
const TENANT = uuid(0x7e1);
const INVOICE = uuid(0x1a1);
const REG = uuid(0x4e1);
const CN = uuid(0xc1d);
const KEY_REGISTER = uuid(0x101);
const KEY_ISSUE = uuid(0x102);
const KEY_SETTLE = uuid(0x103);
const CSRF = 's'.repeat(43);
const OTHER_CSRF = 't'.repeat(43);
const NOW = Object.freeze({ csrf: CSRF, sessionEnds: 0 });
const PROOF = ['0123456789abcdef'.repeat(2), 'fedcba9876543210'.repeat(2)].join('');
const REGISTER_BYTES = creditNoteRegisterBodyOf(TENANT, ATTEMPT, 1250, 'goodwill') as string;
const ISSUE_BYTES = creditNoteIssueBodyOf({ expectedTenant: TENANT, registrationId: REG, attemptId: ATTEMPT, grossCents: 1250, reason: 'goodwill', registrationProof: PROOF }) as string;
const SETTLE_BYTES = (v: 1 | 2, attempt = ATTEMPT) => settleBodyOf(TENANT, attempt, v) as string;
const MIN = 60_000;
const HOUR = 60 * MIN;
const REGISTERED: CreditNoteCommandResult = Object.freeze({ kind: 'registered', registrationId: REG, replayed: false });
const ISSUED: CreditNoteCommandResult = Object.freeze({ kind: 'issued', creditNoteId: CN, replayed: false });
const CONFIRMED: CreditNoteCommandResult = Object.freeze({ kind: 'settled', state: 'confirmed', replayed: false });
const NO_ANSWER: CreditNoteCommandResult = Object.freeze({ kind: 'unknown', responded: false });
const refusal = (status: number, error: string, sealedShape = false, retryAfterSeconds: number | null = null): CreditNoteCommandResult =>
  Object.freeze({ kind: 'refused', status, error, sealed: sealedShape, replayed: false, retryAfterSeconds });

const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const done of cleanup.splice(0)) done();
  vi.useRealTimers();
});

/** A store on injected clocks with setTimeout faked (no real timer is ever left behind), and helpers bound to it. */
function rig() {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const clock = { mono: 5_000, wall: 1_790_000_000_000 };
  const holds: CreditNoteHoldStore = createCreditNoteHoldStore({ now: () => clock.mono, wallNow: () => clock.wall });
  cleanup.push(() => holds.dispose());
  const advance = (ms: number, wallMs = ms): void => { clock.mono += ms; clock.wall += wallMs; vi.advanceTimersByTime(ms); };
  const init = (over: Partial<Record<string, unknown>> = {}): CreditNoteHoldInit => ({
    start: 'register', attemptId: ATTEMPT, storeId: STORE, tenantId: TENANT, invoiceId: INVOICE, invoiceNumber: 7, grossCents: 1250, reason: 'goodwill', csrf: CSRF,
    key: KEY_REGISTER, body: REGISTER_BYTES, signIn: { mono: clock.mono, wall: clock.wall }, baseline: { ids: [uuid(0xd01)], complete: true }, ...over,
  } as CreditNoteHoldInit);
  const settleInit = (version: 1 | 2, over: Partial<Record<string, unknown>> = {}): CreditNoteHoldInit =>
    ({ ...init(), start: 'settle', key: KEY_SETTLE, body: SETTLE_BYTES(version), version, creditNoteId: version === 2 ? CN : null, ...over } as CreditNoteHoldInit);
  const put = (over: Partial<Record<string, unknown>> = {}) => {
    const got = holds.put(UID, init(over));
    assert.equal(got.kind, 'held');
    return got.kind === 'held' ? got.held : (undefined as never);
  };
  const gen = (): number => (holds.get(UID) as { generation: number }).generation;
  const send = (stage: CreditNoteStage, over: { replay?: boolean; csrf?: string; sessionEnds?: number } = {}) =>
    holds.send(UID, ATTEMPT, gen(), stage, { replay: false, csrf: CSRF, sessionEnds: 0, ...over });
  const decide = (ticket: CreditNoteSend | null, result: CreditNoteCommandResult | CreditNoteProofResult, current: { csrf: string | null; sessionEnds: number } = NOW) =>
    holds.decide(UID, ticket as CreditNoteSend, current, result);
  /** Register sent and answered 201: the issue key may be claimed. */
  const registered = () => {
    put();
    assert.equal(decide(send('register'), REGISTERED), 'first');
    assert.ok(holds.change(UID, ATTEMPT, gen(), { state: 'registered', registrationId: REG }), 'registered');
  };
  /** Registered, the issue key claimed and sent, its 201 decided: Confirm may follow. */
  const issued = () => {
    registered();
    assert.equal(holds.claimIssueKey(UID, ATTEMPT, gen(), KEY_ISSUE, ISSUE_BYTES), 'claimed');
    assert.equal(decide(send('issue'), ISSUED), 'first');
    assert.ok(holds.change(UID, ATTEMPT, gen(), { state: 'issued', creditNoteId: CN }), 'issued');
  };
  return { clock, holds, advance, init, settleInit, put, gen, send, decide, registered, issued };
}

test('CNH-01. P2-hold: an attempt is held BEFORE its first send under a new generation; an open one (attached, hidden or detached) is never replaced by another attempt — only a detached one by its own lookup row\'s settlement — and an ended one is; a v4 key and its own bytes or `invalid`; a sign-in at most 8 minutes old (and not from the future) or `lapsed`', () => {
  const { holds, put, init, settleInit, gen, send, decide, clock } = rig();
  const first = put();
  assert.ok(isLiveCreditNote(first) && isOpenCreditNote(first), 'live and open');
  assert.deepEqual([first.state, first.stage, first.unresolved, first.hidden, first.registrationId, first.issue, first.settle, first.sends, first.notBefore],
    ['registering', 'register', false, false, null, null, null, [], {}]);
  assert.ok(first.register !== null && first.register.key === KEY_REGISTER && first.register.body === REGISTER_BYTES && first.register.firstMono === null, 'the exact bytes, held');
  assert.deepEqual(first.baseline, { ids: [uuid(0xd01)], complete: true });
  assert.ok(Object.isFrozen(first) && Object.isFrozen(first.baseline) && Object.isFrozen(first.baseline?.ids), 'frozen');
  const otherBytes = creditNoteRegisterBodyOf(TENANT, OTHER_ATTEMPT, 1250, 'goodwill');
  assert.deepEqual(holds.put(UID, init({ attemptId: OTHER_ATTEMPT, body: otherBytes })), { kind: 'busy' }, 'attached');
  assert.ok(holds.hide(UID, ATTEMPT), 'hidden');
  assert.deepEqual(holds.put(UID, init({ attemptId: OTHER_ATTEMPT, body: otherBytes })), { kind: 'busy' }, 'hidden');
  assert.ok(send('register') !== null, 'sent');
  holds.detach(UID);
  assert.deepEqual(holds.put(UID, init({ attemptId: OTHER_ATTEMPT, body: otherBytes })), { kind: 'busy' }, 'detached: its blockers stay until evidence or a reload');
  assert.deepEqual(holds.put(UID, settleInit(1, { attemptId: OTHER_ATTEMPT, body: SETTLE_BYTES(1, OTHER_ATTEMPT) })), { kind: 'busy' }, 'another row');
  const before = gen();
  const own = holds.put(UID, settleInit(1));
  assert.ok(own.kind === 'held' && own.held.generation > before && own.held.csrf === CSRF && own.held.state === 'registered', 'its own row\'s release, under the new session');
  assert.ok(holds.change(UID, ATTEMPT, gen(), { state: 'released' }), 'released');
  const second = put({ attemptId: OTHER_ATTEMPT, body: otherBytes });
  assert.ok(second.attemptId === OTHER_ATTEMPT && second.state === 'registering', 'an ended one is replaced');
  void decide;
  // invalid: an empty fact, a key that is no lowercase v4, bytes not its own.
  const fresh = createCreditNoteHoldStore({ now: () => clock.mono, wallNow: () => clock.wall });
  cleanup.push(() => fresh.dispose());
  for (const field of ['attemptId', 'storeId', 'tenantId', 'invoiceId', 'csrf', 'key', 'body']) assert.deepEqual(fresh.put(`e-${field}`, init({ [field]: '' })), { kind: 'invalid' }, field);
  for (const key of [uuid(0xabcd).toUpperCase(), KEY_REGISTER.replace('-4000-', '-1000-'), KEY_REGISTER.replace('-8000-', '-c000-'), 'x']) {
    assert.deepEqual(fresh.put(`k-${key}`, init({ key })), { kind: 'invalid' }, key);
  }
  for (const [name, over] of [['amount', { grossCents: 1251 }], ['reason', { reason: 'service_issue' }], ['tenant', { tenantId: uuid(0x7e2) }], ['attempt', { attemptId: OTHER_ATTEMPT }],
    ['payment register', { body: `{"expectedTenant":"${TENANT}","attemptId":"${ATTEMPT}"}` }]] as const) {
    assert.deepEqual(fresh.put(`v-${name}`, init(over)), { kind: 'invalid' }, name);
  }
  assert.deepEqual(fresh.put('v-settle', settleInit(2, { body: SETTLE_BYTES(1) })), { kind: 'invalid' }, 'a settlement of the other version');
  // The 8-minute first-send window, inclusive, by the larger elapsed time; a non-finite or future sign-in is none.
  const at = (mono: number, wall: number) => init({ signIn: { mono: clock.mono - mono, wall: clock.wall - wall } });
  assert.equal(fresh.put('u1', at(CREDIT_NOTE_FIRST_SEND_MS, 0)).kind, 'held');
  assert.equal(fresh.put('u2', at(CREDIT_NOTE_FIRST_SEND_MS + 1, 0)).kind, 'lapsed');
  assert.equal(fresh.put('u3', at(0, CREDIT_NOTE_FIRST_SEND_MS + 1)).kind, 'lapsed', 'the wall clock alone');
  assert.equal(fresh.put('u4', at(Number.NaN, 0)).kind, 'lapsed', 'a non-finite time counts as passed');
  assert.equal(fresh.put('u5', at(-10 * MIN, -10 * MIN)).kind, 'lapsed', 'a sign-in from the future is no sign-in');
  // From a lookup row: settle-only, no sign-in; open → registered (version 1), issued → issued (version 2); never an issue key.
  const open = fresh.put('u6', settleInit(1));
  assert.ok(open.kind === 'held' && open.held.state === 'registered' && open.held.signIn === null && open.held.register === null && open.held.baseline === null, 'a lookup hold');
  if (open.kind === 'held') assert.equal(fresh.claimIssueKey('u6', ATTEMPT, open.held.generation, KEY_ISSUE, ISSUE_BYTES), 'gone', 'no registration id from a 201: never an issue');
  const iss = fresh.put('u7', settleInit(2));
  assert.ok(iss.kind === 'held' && iss.held.state === 'issued' && iss.held.creditNoteId === CN, 'an issued row');
});

test('CNH-02. P2-hold E7: exactly one issue key per attempt — the compare-and-set moves none → one; a second claimant gets `taken` and holds nothing; only a registered, attached attempt of its generation with a registration id claims, with an unused v4 key and its own issue bytes, within 8 minutes of the sign-in', () => {
  const r = rig();
  r.put();
  assert.equal(r.holds.claimIssueKey(UID, ATTEMPT, r.gen(), KEY_ISSUE, ISSUE_BYTES), 'gone', 'not registered yet');
  const s = rig();
  s.registered();
  const { holds, gen } = s;
  assert.equal(holds.claimIssueKey(UID, ATTEMPT, gen() + 1, KEY_ISSUE, ISSUE_BYTES), 'gone', 'another generation');
  assert.equal(holds.claimIssueKey(UID, OTHER_ATTEMPT, gen(), KEY_ISSUE, ISSUE_BYTES), 'gone', 'another attempt');
  for (const key of ['', uuid(0xabce).toUpperCase(), KEY_ISSUE.replace('-4000-', '-5000-'), KEY_REGISTER]) assert.equal(holds.claimIssueKey(UID, ATTEMPT, gen(), key, ISSUE_BYTES), 'gone', `key ${key}`);
  const foreign = creditNoteIssueBodyOf({ expectedTenant: TENANT, registrationId: uuid(0x4e2), attemptId: ATTEMPT, grossCents: 1250, reason: 'goodwill', registrationProof: PROOF }) as string;
  for (const [name, body] of [['another registration', foreign], ['not JSON', 'x'], ['no proof', ISSUE_BYTES.replace(PROOF, '')], ['spaced', ` ${ISSUE_BYTES}`]] as const) {
    assert.equal(holds.claimIssueKey(UID, ATTEMPT, gen(), KEY_ISSUE, body), 'gone', name);
  }
  assert.equal(holds.get(UID)?.issue, null, 'nothing claimed by a refused claim');
  const g = gen();
  assert.deepEqual([holds.claimIssueKey(UID, ATTEMPT, g, KEY_ISSUE, ISSUE_BYTES), holds.claimIssueKey(UID, ATTEMPT, g, uuid(0x104), ISSUE_BYTES)], ['claimed', 'taken'], 'two claimants in one turn');
  const held = holds.get(UID);
  assert.ok(held?.issue?.key === KEY_ISSUE && held.issue.body === ISSUE_BYTES && held.state === 'issuing' && held.generation === g, 'the first claim, its exact bytes');
  assert.equal(holds.claimIssueKey(UID, ATTEMPT, g, KEY_ISSUE, ISSUE_BYTES), 'taken', 'not even the same key twice');
  assert.ok(s.send('issue') !== null, 'its first send');
  assert.equal(holds.claimIssueKey(UID, ATTEMPT, g, uuid(0x105), ISSUE_BYTES), 'taken');
  const l = rig();
  l.registered();
  l.advance(CREDIT_NOTE_FIRST_SEND_MS + 1);
  assert.equal(l.holds.claimIssueKey(UID, ATTEMPT, l.gen(), KEY_ISSUE, ISSUE_BYTES), 'lapsed', 'continueLapsed');
  assert.equal(l.holds.get(UID)?.issue, null);
  l.holds.detach(UID);
  assert.equal(l.holds.claimIssueKey(UID, ATTEMPT, l.gen(), KEY_ISSUE, ISSUE_BYTES), 'gone', 'detached');
});

test('CNH-03. P2-hold: `send` gives the held key and exact bytes only with the hold\'s token; a first send once and a Check again only after it; first sends of register and issue within 8 minutes of the sign-in; their Check again under 9 minutes, by the larger of monotonic and wall-clock time, scrubbed at the press when it passed; the proof sends the registration id; nothing once ended', () => {
  const { holds, put, gen, send, decide, advance, clock } = rig();
  put();
  assert.equal(send('register', { replay: true }), null, 'no Check again before the first send');
  assert.equal(send('register', { csrf: OTHER_CSRF }), null, 'another token never takes the bytes');
  const ticket = send('register', { sessionEnds: 3 });
  assert.ok(ticket !== null && ticket.key === KEY_REGISTER && ticket.body === REGISTER_BYTES && ticket.stage === 'register' && !ticket.replay && !ticket.answered, 'the exact held bytes');
  assert.ok(ticket !== null && ticket.n === 1 && ticket.generation === gen() && ticket.sessionEnds === 3 && ticket.attemptId === ATTEMPT && ticket.csrf === CSRF, 'the record');
  assert.ok(holds.get(UID)?.register?.firstMono === clock.mono && holds.get(UID)?.register?.firstWall === clock.wall, 'the first send\'s times');
  assert.equal(send('register'), null, 'a first send once');
  assert.equal(send('proof'), null, 'no proof without a registration id');
  advance(CREDIT_NOTE_REPLAY_MS - 1);
  const replay = send('register', { replay: true });
  assert.ok(replay !== null && replay.replay && replay.key === KEY_REGISTER && replay.body === REGISTER_BYTES && replay.n === 2, 'a Check again: same key, same bytes');
  assert.ok(replaySent(holds.get(UID), 'register') && !replaySent(holds.get(UID), 'issue'), 'replaySent');
  clock.wall += 1;
  assert.equal(replayWindowOpen(holds.get(UID), 'register', clock.mono, clock.wall), false);
  assert.equal(sendBlockOf(holds.get(UID), 'register', true, clock.mono, clock.wall), 'window');
  assert.equal(send('register', { replay: true }), null);
  assert.equal(holds.get(UID)?.register?.body, '', 'scrubbed at the press');
  assert.equal(holds.get(UID)?.register?.key, KEY_REGISTER, 'the key still names the attempt');
  void decide;
  // The issue: its first send within 8 minutes of the sign-in, checked at the send itself; its Check again under 9.
  const r = rig();
  r.registered();
  const proof = r.send('proof');
  assert.ok(proof !== null && proof.key === '' && proof.body === REG, 'the proof\'s "bytes" are the registration id');
  assert.equal(r.holds.claimIssueKey(UID, ATTEMPT, r.gen(), KEY_ISSUE, ISSUE_BYTES), 'claimed');
  r.clock.mono += CREDIT_NOTE_FIRST_SEND_MS + 1;
  assert.equal(sendBlockOf(r.holds.get(UID), 'issue', false, r.clock.mono, r.clock.wall), 'lapsed');
  assert.equal(r.send('issue'), null, 'past 8 minutes the claimed issue never leaves');
  r.clock.mono -= CREDIT_NOTE_FIRST_SEND_MS + 1;
  const issue = r.send('issue');
  assert.ok(issue !== null && issue.key === KEY_ISSUE && issue.body === ISSUE_BYTES, 'the issue\'s exact bytes'); // compared: they carry the proof
  r.clock.mono += CREDIT_NOTE_REPLAY_MS - 1;
  assert.ok(r.send('issue', { replay: true }) !== null, 'a Check again under 9 minutes');
  r.clock.mono += 1;
  assert.equal(r.send('issue', { replay: true }), null, 'none at 9 minutes');
  assert.ok(r.holds.get(UID)?.issue?.body === '' && r.holds.get(UID)?.register?.body === '', 'register and issue bytes go together');
  assert.ok(r.holds.change(UID, ATTEMPT, r.gen(), { state: 'released' }), 'the lookup says released');
  assert.equal(sendBlockOf(r.holds.get(UID), 'proof', false, r.clock.mono, r.clock.wall), 'ended');
  assert.equal(r.send('proof'), null, 'nothing once ended');
});

test('CNH-04. P2-hold: a settlement Check again only under 23 hours after that key\'s first send, by the larger of monotonic and wall-clock time (a wall step, a monotonic step or a non-finite reading ends it)', () => {
  const { holds, put, send, advance, clock } = rig();
  put({ start: 'settle', key: KEY_SETTLE, body: SETTLE_BYTES(2), version: 2, creditNoteId: CN });
  const first = send('settle');
  assert.ok(first !== null && first.body === SETTLE_BYTES(2), 'the first send');
  advance(CREDIT_NOTE_STAGE_WAIT_MS);
  assert.ok(send('settle', { replay: true }) !== null, 'a Check again with no sign-in asked');
  advance(CREDIT_NOTE_SETTLE_REPLAY_MS - CREDIT_NOTE_STAGE_WAIT_MS - 1_000);
  assert.ok(replayWindowOpen(holds.get(UID), 'settle', clock.mono, clock.wall), 'still open');
  clock.wall += 2_000;
  assert.equal(send('settle', { replay: true }), null);
  assert.equal(holds.get(UID)?.settle?.body, '', 'scrubbed at the press');
  for (const [name, step] of [['monotonic', (c: { mono: number; wall: number }) => { c.mono += CREDIT_NOTE_SETTLE_REPLAY_MS; }], ['non-finite', (c: { mono: number; wall: number }) => { c.wall = Number.NaN; }]] as const) {
    const s = rig();
    s.put({ start: 'settle', key: KEY_SETTLE, body: SETTLE_BYTES(1), version: 1, creditNoteId: null });
    assert.ok(s.send('settle') !== null, name);
    step(s.clock);
    assert.equal(s.send('settle', { replay: true }), null, name);
  }
});

test('CNH-05. P2-hold: the store\'s own timer scrubs register and issue bytes 9 minutes after the sign-in and settlement bytes 23 hours after its first send — it never sends, and a later press finds nothing to send', () => {
  const { holds, put, gen, send, decide, advance } = rig();
  let changes = 0;
  cleanup.push(holds.subscribe(() => { changes += 1; }));
  put();
  const reg = send('register');
  assert.ok(reg !== null, 'sent');
  advance(CREDIT_NOTE_REPLAY_MS - 1);
  assert.equal(holds.get(UID)?.register?.body, REGISTER_BYTES);
  const before = changes;
  advance(1);
  assert.equal(holds.get(UID)?.register?.body, '', 'the timer scrubbed it');
  assert.equal(changes, before + 1, 'one change heard');
  assert.equal(send('register', { replay: true }), null);
  assert.ok(isLiveCreditNote(holds.get(UID)), 'the attempt itself stays: only the bytes went');
  assert.equal(decide(reg, REGISTERED), 'first', 'a late stored answer still counts after the bytes went');
  assert.ok(holds.change(UID, ATTEMPT, gen(), { state: 'registered', registrationId: REG }), 'registered');
  assert.ok(holds.holdSettlement(UID, ATTEMPT, gen(), 1, KEY_SETTLE, SETTLE_BYTES(1)), 'a release held');
  advance(HOUR);
  assert.equal(holds.get(UID)?.settle?.body, SETTLE_BYTES(1), 'not sent yet: nothing to time');
  assert.ok(send('settle') !== null, 'sent');
  advance(CREDIT_NOTE_SETTLE_REPLAY_MS - 1);
  assert.equal(holds.get(UID)?.settle?.body, SETTLE_BYTES(1));
  advance(1);
  assert.equal(holds.get(UID)?.settle?.body, '');
  assert.equal(holds.get(UID)?.sends.length, 2, 'the timer sent nothing');
});

test('CNH-06. P2-hold §3.6: an answer belongs only to its exact recorded send — the same n, stage, key, replay, generation, token and session count — while the hold is open and attached, the token and session count are unchanged now and the key is the stage\'s (the proof: the latest); a hide keeps the generation; a detach, a replacement or an end makes it stale', () => {
  const { holds, put, gen, send, registered } = rig();
  registered();
  const reg = holds.get(UID)?.sends[0] as CreditNoteSend;
  assert.equal(holds.belongs(UID, reg, NOW), true);
  for (const [name, current] of [['another token now', { csrf: OTHER_CSRF, sessionEnds: 0 }], ['signed out now', { csrf: null, sessionEnds: 0 }], ['a session ended since', { csrf: CSRF, sessionEnds: 1 }]] as const) {
    assert.equal(holds.belongs(UID, reg, current), false, name);
  }
  for (const [name, forged] of [['key', { key: uuid(0x199) }], ['n', { n: 9 }], ['replay', { replay: true }], ['session count', { sessionEnds: 1 }], ['token', { csrf: OTHER_CSRF }], ['stage', { stage: 'issue' }]] as const) {
    assert.equal(holds.belongs(UID, { ...reg, ...forged } as CreditNoteSend, NOW), false, `no recorded send: ${name}`);
  }
  assert.equal(holds.belongs('uid-b', reg, NOW), false, 'another user');
  const p1 = send('proof') as CreditNoteSend;
  holds.decide(UID, p1, NOW, NO_ANSWER as CreditNoteProofResult);
  const p2 = send('proof', { replay: true }) as CreditNoteSend;
  assert.ok(p1 !== null && p2 !== null, 'two proofs');
  assert.equal(holds.belongs(UID, p1, NOW), false, 'an earlier proof is stale');
  assert.equal(holds.belongs(UID, p2, NOW), true, 'the latest proof');
  const g = gen();
  assert.ok(holds.hide(UID, ATTEMPT), 'hide');
  assert.ok(holds.get(UID)?.hidden === true && gen() === g, 'a hide keeps the generation');
  assert.equal(holds.belongs(UID, reg, NOW), true, 'a hidden attempt still hears its answers');
  holds.detach(UID);
  assert.ok(gen() > g, 'a detach bumps the generation');
  assert.equal(holds.belongs(UID, reg, NOW), false, 'detached: stale');
  const e = rig();
  e.registered();
  const ended = e.holds.get(UID)?.sends[0] as CreditNoteSend;
  assert.ok(e.holds.change(UID, ATTEMPT, e.gen(), { state: 'ended' }), 'ended');
  assert.equal(e.holds.belongs(UID, ended, NOW), false, 'an ended hold hears nothing');
  void put;
});

test('CNH-07. P2-hold §2.6 item 4, §3.6: `decide` attributes and judges in one step — stale for no exact recorded send, another token or session count, another generation or an ended hold; a stored answer recorded once as a frozen copy, then `same` (replayed or not) or `different`; an unstored answer for a decided stage stale; otherwise the class (a first send\'s 422 after a Check again provisional); another stage\'s shape fails closed', () => {
  const { holds, put, send, decide, gen, advance } = rig();
  put();
  const ticket = send('register') as CreditNoteSend;
  assert.equal(decide(ticket, REGISTERED, { csrf: OTHER_CSRF, sessionEnds: 0 }), 'stale', 'another token now');
  assert.equal(decide(ticket, REGISTERED, { csrf: CSRF, sessionEnds: 1 }), 'stale', 'a session ended since');
  assert.equal(decide({ ...ticket, generation: gen() + 1 }, REGISTERED), 'stale', 'another generation');
  assert.equal(decide({ ...ticket, n: 7 }, REGISTERED), 'stale', 'no such send');
  assert.equal(holds.get(UID)?.register?.completion, null, 'nothing recorded by a stale answer');
  assert.equal(decide(ticket, ISSUED), 'fail-closed', 'an issue\'s shape for a register');
  advance(CREDIT_NOTE_STAGE_WAIT_MS);
  const replay = send('register', { replay: true }) as CreditNoteSend;
  assert.equal(decide(ticket, refusal(422, 'idempotency_key_reused')), 'provisional', 'the first send\'s 422 once a Check again was sent');
  assert.equal(decide(replay, refusal(409, 'request_in_progress')), 'provisional');
  const stored = { ...REGISTERED, replayed: true } as CreditNoteCommandResult;
  assert.equal(decide(replay, stored), 'first');
  const completion = holds.get(UID)?.register?.completion;
  assert.ok(completion !== null && completion !== stored && Object.isFrozen(completion), 'a frozen copy, not the caller\'s object');
  assert.deepEqual(completion, stored);
  assert.equal(decide(ticket, REGISTERED), 'same', 'the same completion, not replayed');
  assert.equal(decide(ticket, { kind: 'registered', registrationId: uuid(0x4e2), replayed: true }), 'different');
  assert.equal(decide(ticket, refusal(409, 'write_conflict', true)), 'different', 'a sealed refusal after a 201');
  for (const late of [refusal(503, 'service_unavailable'), refusal(409, 'request_in_progress'), refusal(429, 'rate_limited', false, 9), NO_ANSWER]) {
    assert.equal(decide(ticket, late), 'stale', `a decided stage: ${late.kind}`);
  }
  assert.deepEqual(holds.get(UID)?.notBefore, { register: holds.get(UID)?.sends[1].mono + CREDIT_NOTE_IN_PROGRESS_WAIT_MS }, 'no pause from a stale answer');
  // The classes, through the hold.
  const c = rig();
  c.put();
  const first = c.send('register') as CreditNoteSend;
  assert.equal(c.decide(first, refusal(403, 'step_up_required')), 'unstored');
  const m = rig();
  m.put();
  assert.equal(m.decide(m.send('register'), { kind: 'malformed' }), 'fail-closed');
  const f = rig();
  f.put();
  assert.equal(f.decide(f.send('register'), refusal(422, 'idempotency_key_reused')), 'fail-closed', 'a first send\'s 422 with no Check again');
  // The proof: open, neutral, provisional, fail-closed; never stored.
  const p = rig();
  p.registered();
  const proofOf = () => p.send('proof') as CreditNoteSend;
  assert.equal(p.decide(proofOf(), { kind: 'proof', proof: PROOF }), 'open');
  assert.equal(p.decide(proofOf(), refusal(404, 'not_found') as CreditNoteProofResult), 'neutral');
  assert.equal(p.decide(proofOf(), refusal(503, 'service_unavailable') as CreditNoteProofResult), 'provisional');
  assert.equal(p.decide(proofOf(), { kind: 'malformed' }), 'fail-closed');
  assert.equal(p.decide(proofOf(), REGISTERED), 'fail-closed', 'a register\'s shape for the proof');
  assert.ok(!JSON.stringify(p.holds.get(UID)).includes(PROOF), 'no proof is held');
  // An ended hold: stale, whatever comes.
  const e = rig();
  e.issued();
  const confirm = (() => { assert.ok(e.holds.holdSettlement(UID, ATTEMPT, e.gen(), 2, KEY_SETTLE, SETTLE_BYTES(2)), 'confirm held'); return e.send('settle') as CreditNoteSend; })();
  assert.equal(e.decide(confirm, CONFIRMED), 'first');
  assert.ok(e.holds.change(UID, ATTEMPT, e.gen(), { state: 'confirmed' }), 'confirmed');
  assert.equal(e.decide(confirm, CONFIRMED), 'stale', 'ended');
});

test('CNH-08. P2-hold: state moves forward only (registering → registered → issuing → issued → confirmed; issuing only by the claim; released only before issued; ended only before an issue key), an end is final and scrubs every byte; `unresolved` only turns on and `shown` only while attached, never on an ended hold; the ids fill once; no field is wiped by undefined; nothing else changes, nor under another generation', () => {
  const { holds, put, gen } = rig();
  put();
  const g = gen();
  const change = (next: Record<string, unknown>) => holds.change(UID, ATTEMPT, g, next);
  assert.equal(change({ state: 'toString' }), false);
  assert.equal(change({ csrf: OTHER_CSRF }), false, 'the token only through detach');
  for (const field of ['attemptId', 'storeId', 'tenantId', 'invoiceId', 'grossCents', 'generation', 'register', 'issue', 'settle', 'baseline', 'sends', 'hidden', 'signIn', 'notBefore']) assert.equal(change({ [field]: null }), false, field);
  assert.ok(change({ state: 'registered', registrationId: REG }), 'registered');
  assert.equal(change({ state: 'registering' }), false, 'never back');
  assert.ok(change({ state: 'registered' }), 'the same state is no move');
  assert.equal(change({ registrationId: uuid(0x4e2) }), false, 'an immutable fact');
  assert.ok(change({ registrationId: REG }), 'the same fact');
  assert.equal(change({ registrationId: '' }), false);
  assert.ok(change({ unresolved: true }), 'unresolved');
  assert.equal(change({ unresolved: false }), false, 'never unmarked');
  assert.equal(change({ state: 'issuing' }), false, 'issuing only by claiming the key');
  assert.equal(holds.claimIssueKey(UID, ATTEMPT, g, KEY_ISSUE, ISSUE_BYTES), 'claimed');
  for (const field of ['state', 'unresolved', 'registrationId', 'creditNoteId', 'shown']) assert.equal(change({ [field]: undefined }), false, `${field} undefined wipes nothing`);
  assert.ok(holds.get(UID)?.registrationId === REG && holds.get(UID)?.unresolved === true, 'nothing wiped');
  assert.equal(change({ state: 'ended' }), false, 'never ended once an issue key was claimed');
  assert.ok(change({ state: 'issued', creditNoteId: CN }), 'the issue 201');
  assert.equal(change({ state: 'released' }), false, 'an issued attempt is never released');
  assert.equal(change({ creditNoteId: uuid(0xc1e) }), false);
  assert.ok(change({ state: 'confirmed' }), 'confirmed');
  assert.ok(holds.get(UID)?.register?.body === '' && holds.get(UID)?.issue?.body === '', 'an end scrubs every byte at once (the issue carried the proof)');
  for (const state of ['ended', 'released', 'issued', 'registered']) assert.equal(change({ state }), false, `after confirmed: ${state}`);
  assert.equal(change({ unresolved: true }), false, 'nothing marked on an ended hold');
  assert.equal(change({ shown: { ids: [uuid(0xd02)], complete: true } }), false, 'nothing listed on an ended hold');
  assert.equal(isLiveCreditNote(holds.get(UID)) || isOpenCreditNote(holds.get(UID)), false, 'ended: replaceable, holds nothing back');
  assert.equal(holds.change(UID, ATTEMPT, g + 1, { unresolved: true }), false, 'another generation');
  for (const from of ['registering', 'registered', 'issuing'] as const) {
    const r = rig();
    r.put();
    if (from !== 'registering') assert.ok(r.holds.change(UID, ATTEMPT, r.gen(), { state: 'registered', registrationId: REG }), from);
    if (from === 'issuing') assert.equal(r.holds.claimIssueKey(UID, ATTEMPT, r.gen(), KEY_ISSUE, ISSUE_BYTES), 'claimed');
    assert.ok(r.holds.change(UID, ATTEMPT, r.gen(), { state: 'released' }), `released from ${from}`);
  }
  const e = rig();
  e.put();
  assert.ok(e.holds.change(UID, ATTEMPT, e.gen(), { state: 'registered', registrationId: REG }) && e.holds.change(UID, ATTEMPT, e.gen(), { state: 'ended' }), 'ended: refused before any issue key');
  const i = rig();
  i.put();
  assert.ok(i.holds.change(UID, ATTEMPT, i.gen(), { state: 'issued' }), 'an issued lookup row');
  assert.equal(i.holds.change(UID, ATTEMPT, i.gen(), { state: 'ended' }), false, 'an issued attempt only ever confirms');
});

test('CNH-09. P2-hold §3.6 rule 3: a detach (sign-out, user or store switch, another token) bumps the generation and keeps only the attempt, invoice, tenant, store, number, amount, reason, ids and last known state — the token (in every send record too), every byte, the D-P2-15 baseline and the notes a card listed go; detachOthers spares only the user named', () => {
  const { holds, gen, send, registered } = rig();
  registered();
  assert.equal(holds.claimIssueKey(UID, ATTEMPT, gen(), KEY_ISSUE, ISSUE_BYTES), 'claimed');
  assert.ok(send('issue') !== null, 'sent');
  assert.ok(holds.change(UID, ATTEMPT, gen(), { shown: { ids: [uuid(0xd02)], complete: false }, unresolved: true }), 'shown');
  assert.ok(holds.hide(UID, ATTEMPT), 'hidden');
  const before = holds.get(UID);
  holds.detach(UID);
  const after = holds.get(UID);
  assert.ok(before !== undefined && after !== undefined, 'held');
  if (before === undefined || after === undefined) return;
  assert.ok(after.generation > before.generation && after.csrf === null, 'a new generation, no token');
  assert.deepEqual([after.attemptId, after.storeId, after.tenantId, after.invoiceId, after.invoiceNumber, after.grossCents, after.reason, after.state, after.unresolved, after.hidden, after.registrationId],
    [ATTEMPT, STORE, TENANT, INVOICE, 7, 1250, 'goodwill', 'issuing', true, true, REG]);
  assert.ok(after.register?.body === '' && after.issue?.body === '' && after.issue.key === KEY_ISSUE, 'no byte left; the keys only name it');
  assert.ok(!JSON.stringify(after).includes(PROOF) && !JSON.stringify(after).includes(CSRF), 'no proof, no token anywhere');
  assert.ok(after.sends.length === before.sends.length && after.sends.every((s) => s.csrf === ''), 'the sends stay, without their token');
  assert.deepEqual([after.baseline, after.shown], [null, null]);
  assert.equal(holds.change(UID, ATTEMPT, after.generation, { shown: { ids: [uuid(0xd02)], complete: true } }), false, 'no listed notes on a detached card');
  assert.ok(holds.change(UID, ATTEMPT, after.generation, { state: 'issued' }), 'its last known state still moves on the lookup\'s evidence');
  assert.equal(holds.send(UID, ATTEMPT, after.generation, 'issue', { replay: true, csrf: CSRF, sessionEnds: 0 }), null, 'never sent again');
  const g = holds.get(UID)?.generation;
  holds.detach(UID);
  assert.equal(holds.get(UID)?.generation, g, 'detaching a detached attempt changes nothing');
  const other = createCreditNoteHoldStore();
  cleanup.push(() => other.dispose());
  for (const uid of ['a', 'b']) {
    const r = other.put(uid, { start: 'settle', attemptId: ATTEMPT, storeId: STORE, tenantId: TENANT, invoiceId: INVOICE, invoiceNumber: 7, grossCents: 1250, reason: 'goodwill', csrf: CSRF,
      key: KEY_SETTLE, body: SETTLE_BYTES(1), version: 1, creditNoteId: null });
    assert.equal(r.kind, 'held');
  }
  other.detachOthers('a');
  assert.ok(other.get('a')?.csrf === CSRF && other.get('b')?.csrf === null, 'only the other user');
  other.detachOthers(null);
  assert.equal(other.get('a')?.csrf, null);
});

test('CNH-10. P2-hold D-P2-16: a settlement is held before its send with an unused v4 key and its own bytes — version 2 (confirm) only on an issued attempt, version 1 (release) only before one was issued; never on an ended or detached attempt; the D-P2-15 baseline never changes after the put', () => {
  const { holds, put, gen } = rig();
  put();
  assert.equal(holds.holdSettlement(UID, ATTEMPT, gen(), 2, KEY_SETTLE, SETTLE_BYTES(2)), false, 'no confirm before issued');
  assert.ok(holds.holdSettlement(UID, ATTEMPT, gen(), 1, KEY_SETTLE, SETTLE_BYTES(1)), 'release an open one');
  assert.ok(holds.get(UID)?.settle?.version === 1 && holds.get(UID)?.settle?.body === SETTLE_BYTES(1), 'held');
  assert.ok(holds.change(UID, ATTEMPT, gen(), { state: 'issued' }), 'issued');
  assert.equal(holds.holdSettlement(UID, ATTEMPT, gen(), 1, uuid(0x10b), SETTLE_BYTES(1)), false, 'never release an issued one');
  for (const [name, key, body] of [['version 3', uuid(0x108), SETTLE_BYTES(2)], ['empty key', '', SETTLE_BYTES(2)], ['upper key', uuid(0xabcf).toUpperCase(), SETTLE_BYTES(2)],
    ['v1 key', uuid(0x108).replace('-4000-', '-1000-'), SETTLE_BYTES(2)], ['the register key', KEY_REGISTER, SETTLE_BYTES(2)], ['another attempt\'s bytes', uuid(0x10a), SETTLE_BYTES(2, OTHER_ATTEMPT)]] as const) {
    assert.equal(holds.holdSettlement(UID, ATTEMPT, gen(), (name === 'version 3' ? 3 : 2) as 2, key, body), false, name);
  }
  assert.ok(holds.holdSettlement(UID, ATTEMPT, gen(), 2, uuid(0x107), SETTLE_BYTES(2)), 'a never-sent release is replaced by the confirm');
  assert.equal(holds.change(UID, ATTEMPT, gen(), { baseline: { ids: [], complete: true } } as never), false, 'the baseline is frozen at the put');
  assert.deepEqual(holds.get(UID)?.baseline, { ids: [uuid(0xd01)], complete: true });
  holds.detach(UID);
  assert.equal(holds.holdSettlement(UID, ATTEMPT, gen(), 2, uuid(0x109), SETTLE_BYTES(2)), false, 'a detached attempt: its own row\'s settlement is a new put');
});

test('CNH-11. P2-49: the hold module keeps nothing outside memory — no browser storage, cookie, console, history, location or server import', () => {
  const source = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), 'invoiceCreditNoteHold.ts'), 'utf8');
  for (const banned of [/localStorage/, /sessionStorage/, /indexedDB/, /document\.cookie/, /console\./, /history\./, /location\./, /from '[^']*server\//]) assert.doesNotMatch(source, banned);
});

test('CNH-12. P2-hold §3.2 items 4-5: `send` is the last gate — no send of a decided stage; no Check again while the stage\'s request is in flight before its 30 s boundary (the proof too); a 5 s pause after request_in_progress and the Retry-After after a 429, for that stage only; a stale answer starts no pause', () => {
  const { holds, put, send, decide, advance, clock } = rig();
  put();
  const original = send('register') as CreditNoteSend;
  advance(CREDIT_NOTE_STAGE_WAIT_MS - 1);
  assert.equal(sendBlockOf(holds.get(UID), 'register', true, clock.mono, clock.wall), 'in-flight');
  assert.equal(send('register', { replay: true }), null, 'not before the 30 s boundary');
  advance(1);
  const check = send('register', { replay: true }) as CreditNoteSend;
  assert.ok(check !== null, 'at 30 s without an answer');
  assert.equal(send('register', { replay: true }), null, 'the Check again is in flight now');
  assert.equal(decide(check, refusal(409, 'request_in_progress')), 'provisional');
  assert.equal(sendBlockOf(holds.get(UID), 'register', true, clock.mono, clock.wall), 'cooling', 'the original is still out too, but past 30 s');
  advance(CREDIT_NOTE_IN_PROGRESS_WAIT_MS - 1);
  assert.equal(send('register', { replay: true }), null, 'cooling for 5 s');
  advance(1);
  const again = send('register', { replay: true }) as CreditNoteSend;
  assert.ok(again !== null, 'after 5 s');
  assert.equal(decide(again, refusal(429, 'rate_limited', false, 12)), 'provisional');
  advance(11_999);
  assert.equal(send('register', { replay: true }), null, 'the Retry-After');
  advance(1);
  const last = send('register', { replay: true }) as CreditNoteSend;
  assert.ok(last !== null, 'after it');
  assert.equal(decide(original, REGISTERED), 'first', 'the original\'s 201 decides it');
  assert.equal(sendBlockOf(holds.get(UID), 'register', true, clock.mono, clock.wall), 'decided');
  assert.equal(send('register', { replay: true }), null, 'no send once decided');
  const pausesBefore = holds.get(UID)?.notBefore;
  assert.equal(decide(last, refusal(409, 'request_in_progress')), 'stale', 'a late provisional answer after the decision');
  assert.deepEqual(holds.get(UID)?.notBefore, pausesBefore, 'and no pause from it');
  // The proof: in flight before 30 s, and its own Retry-After.
  assert.ok(holds.change(UID, ATTEMPT, (holds.get(UID) as { generation: number }).generation, { state: 'registered', registrationId: REG }), 'registered');
  const p1 = send('proof') as CreditNoteSend;
  assert.equal(send('proof'), null, 'a proof in flight');
  assert.equal(decide(p1, refusal(429, 'rate_limited', false, 3) as CreditNoteProofResult), 'provisional');
  assert.equal(send('proof'), null, 'its Retry-After');
  advance(3_000);
  assert.ok(send('proof') !== null, 'then a read again');
});

test('CNH-13. P2-hold: `remove` drops only an ended attempt or one that never sent anything — an open attempt that sent is hidden instead (its blockers stay)', () => {
  const { holds, put, send, gen } = rig();
  put();
  assert.equal(holds.remove(UID, OTHER_ATTEMPT), false, 'another attempt');
  assert.ok(holds.remove(UID, ATTEMPT), 'never sent');
  put();
  assert.ok(send('register') !== null, 'sent');
  assert.equal(holds.remove(UID, ATTEMPT), false, 'open and sent');
  holds.detach(UID);
  assert.equal(holds.remove(UID, ATTEMPT), false, 'detached, still open');
  assert.ok(holds.hide(UID, ATTEMPT) && isOpenCreditNote(holds.get(UID)), 'hidden, still holding back');
  assert.ok(holds.change(UID, ATTEMPT, gen(), { state: 'released' }), 'the lookup says released');
  assert.ok(holds.remove(UID, ATTEMPT) && holds.get(UID) === undefined, 'ended: dropped');
});

test('CNH-14. P2-hold D-P2-16: no replacement settlement key over a sent, undecided one; `retire` lets one follow only with nothing in flight and once the key is decided — a stored completion, its 23-hour window passed, or a first send\'s unstored answer with no Check again sent', () => {
  const r = rig();
  r.issued();
  const { holds, gen, send, decide, advance } = r;
  assert.ok(holds.holdSettlement(UID, ATTEMPT, gen(), 2, KEY_SETTLE, SETTLE_BYTES(2)), 'confirm held');
  const confirm = send('settle') as CreditNoteSend;
  assert.equal(holds.holdSettlement(UID, ATTEMPT, gen(), 2, uuid(0x106), SETTLE_BYTES(2)), false, 'not over a sent, undecided one');
  assert.equal(holds.retire(UID, ATTEMPT, gen(), 'settle'), false, 'in flight');
  assert.equal(decide(confirm, NO_ANSWER), 'provisional');
  assert.equal(holds.retire(UID, ATTEMPT, gen(), 'settle'), false, 'undecided, its window open');
  advance(CREDIT_NOTE_SETTLE_REPLAY_MS);
  assert.ok(holds.retire(UID, ATTEMPT, gen(), 'settle'), 'its window passed');
  assert.ok(holds.holdSettlement(UID, ATTEMPT, gen(), 2, uuid(0x106), SETTLE_BYTES(2)), 'then a new key, lookup-first');
  assert.equal(holds.belongs(UID, confirm, NOW), false, 'the replaced key\'s answer is stale');
  assert.equal(decide(confirm, CONFIRMED), 'stale');
  // An unstored first-send answer (a 404) with no Check again: decided, so retired.
  const u = rig();
  u.issued();
  assert.ok(u.holds.holdSettlement(UID, ATTEMPT, u.gen(), 2, KEY_SETTLE, SETTLE_BYTES(2)), 'confirm held');
  assert.equal(u.decide(u.send('settle'), refusal(404, 'not_found')), 'unstored');
  assert.ok(u.holds.retire(UID, ATTEMPT, u.gen(), 'settle') && u.holds.holdSettlement(UID, ATTEMPT, u.gen(), 2, uuid(0x106), SETTLE_BYTES(2)), 'settleUnknown → lookup → a new key');
  // …but not once a Check again was sent under it.
  const c = rig();
  c.issued();
  assert.ok(c.holds.holdSettlement(UID, ATTEMPT, c.gen(), 2, KEY_SETTLE, SETTLE_BYTES(2)), 'confirm held');
  const first = c.send('settle') as CreditNoteSend;
  c.advance(CREDIT_NOTE_STAGE_WAIT_MS);
  const check = c.send('settle', { replay: true }) as CreditNoteSend;
  assert.equal(c.decide(check, NO_ANSWER), 'provisional');
  assert.equal(c.decide(first, refusal(404, 'not_found')), 'provisional', 'read from the Check-again column');
  assert.equal(c.holds.retire(UID, ATTEMPT, c.gen(), 'settle'), false, 'still undecided');
  // A stored completion decides it too.
  const s = rig();
  s.issued();
  assert.ok(s.holds.holdSettlement(UID, ATTEMPT, s.gen(), 2, KEY_SETTLE, SETTLE_BYTES(2)), 'confirm held');
  assert.equal(s.decide(s.send('settle'), refusal(409, 'write_conflict', true)), 'first', 'a sealed write_conflict: the lookup decides');
  assert.ok(s.holds.retire(UID, ATTEMPT, s.gen(), 'settle'), 'stored: retired');
});
