// M7B-CREDITNOTES-CN-P2 — the shop's held credit-note attempt (docs/phase-4/17 §2.6, §3.2, §3.6; §6 Hold): one attempt to
// issue one credit note on one issued invoice — register, proof, issue, then a deliberate settlement — held in memory BEFORE
// each request leaves. The payment hold's model (invoicePaymentHold.ts), with the credit note's own rules:
//
//   - Each command stage keeps its ONE key (a lowercase UUID v4, never another stage's) and its own exact bytes, and `send` is
//     the last gate to them: the token, first-send-once, the stage's window at the press (a timer that never ran lets nothing
//     out), a decided stage, a request still in flight before its 30 s boundary, and a cool-down. Every send is recorded.
//   - `decide` judges an answer in one step: it belongs only to its exact recorded send under the same token and session
//     count, never to an ended hold; a stored answer is recorded once (a frozen copy) and compared with any later one; an
//     unstored answer for a decided stage is stale; otherwise it says the answer's class (doc 17 §2.6 item 4).
//   - One issue key per attempt, ever: `claimIssueKey` moves it from none to one in a single compare-and-set.
//   - Register and issue bytes go 9 minutes after the shop-observed sign-in (§3.2 item 6), settlement bytes 23 hours after
//     the settlement key's first send — each by the larger of the monotonic and the wall-clock time elapsed (as
//     invoicePaymentHold.ts measures it) — by this store's own timer and again at every press.
//   - The hold generation changes only when the attempt is replaced (a new `put`) or detached, never on a hide or a Check again.
//   - An open attempt (not ended: attached, hidden or detached) is never replaced by another — its blockers stay until
//     positive evidence or a reload (D-P2-6) — and never removed while it has sent anything; a detached one is replaced only
//     by its own lookup row's settlement.
//   - A detach (a sign-out, a user or store switch, another token) keeps the attempt, invoice, tenant, store and last known
//     state; the token, every byte, the baseline and the notes a card listed go. No staff name is ever held.
//   - State moves forward only (`change`); a late answer may fill an immutable fact (the registration id), never move it back.
//   - Memory only: no browser storage, URL, DOM or log; a page load ends it, and a hot reload disposes the old store.
//
// Import discipline as invoiceVoidHold.ts: from ServerInvoiceDrafts only its session-end binding (a function declaration).
import { bindDraftHoldsToSessionEnd } from './ServerInvoiceDrafts';
import {
  creditNoteIssueBodyOf, creditNoteRegisterBodyOf, evidenceOf, proofEvidenceOf, settleBodyOf,
  type CreditNoteCommandResult, type CreditNoteEvidence, type CreditNoteProofResult, type InvoiceCreditNoteReason,
} from './invoiceIssuingClient';

/** A first send of a register or an issue needs a shop-observed sign-in no older than this (doc 17 §2.5). */
export const CREDIT_NOTE_FIRST_SEND_MS = 8 * 60_000;
/** A Check again of a register or an issue needs one younger than this: a minute inside the server's 10 (§3.2). */
export const CREDIT_NOTE_REPLAY_MS = 9 * 60_000;
/** A Check again of a settlement only this long after its first send: an hour inside the key's 24 h retention (§3.2). */
export const CREDIT_NOTE_SETTLE_REPLAY_MS = 23 * 60 * 60_000;
/** A stage with no answer this long shows unresolved and may be checked again; the request itself keeps running (§2.6 item 5). */
export const CREDIT_NOTE_STAGE_WAIT_MS = 30_000;
/** The pause after a 409 request_in_progress, at every stage (§3.2 item 5; IN_PROGRESS_WAIT_MS). */
export const CREDIT_NOTE_IN_PROGRESS_WAIT_MS = 5_000;

export type CreditNoteStage = 'register' | 'proof' | 'issue' | 'settle';
type CommandStage = Exclude<CreditNoteStage, 'proof'>;
/**
 * What is known of the attempt, forward only: `registering` (a register out or undecided), `registered` (open: a stored
 * register 201, or a lookup row), `issuing` (the issue key claimed, undecided), `issued` (a stored issue 201 or an issued
 * lookup row), then one end: `confirmed`, `released` or `ended` (refused, or nothing ran).
 */
export type CreditNoteState = 'registering' | 'registered' | 'issuing' | 'issued' | 'confirmed' | 'released' | 'ended';
const RANK: Readonly<Record<CreditNoteState, number>> = Object.freeze({ registering: 0, registered: 1, issuing: 2, issued: 3, confirmed: 4, released: 4, ended: 4 });
const isEnd = (state: CreditNoteState): boolean => RANK[state] === 4;
/** The keys this shop mints (R1 S7): a canonical lowercase UUID version 4. */
const KEY_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** One command stage's key and exact bytes ('' once scrubbed: never sent again), its first send's times and its first stored answer. */
export interface HeldCreditNoteBytes {
  readonly key: string;
  readonly body: string;
  readonly firstMono: number | null;
  readonly firstWall: number | null;
  /** The first stored answer under this key: a frozen copy. */
  readonly completion: CreditNoteCommandResult | null;
  /** A first send's unstored-definitive answer was judged (final while no Check again is sent under the key). */
  readonly unstored: boolean;
}
/** One send, recorded just before it leaves: what its answer must match exactly to belong to the attempt (§3.6). */
export interface CreditNoteSend {
  readonly attemptId: string;
  /** This hold's send count, from 1. */
  readonly n: number;
  readonly stage: CreditNoteStage;
  /** The stage's key ('' for the proof). */
  readonly key: string;
  /** A Check again (else the stage's first send). */
  readonly replay: boolean;
  readonly generation: number;
  /** The token it went with ('' once the hold detached). */
  readonly csrf: string;
  /** `sessionEndsSoFar()` at the send. */
  readonly sessionEnds: number;
  readonly mono: number;
  readonly wall: number;
  /** Its answer has been judged (`decide`): no longer in flight. */
  readonly answered: boolean;
}
/** What `send` hands out: the record and the exact bytes to send (the proof's: the registration id). */
export interface CreditNoteTicket extends CreditNoteSend { readonly body: string }
/** The D-P2-15 baseline: the invoice's credit-note ids read before the register's first send, and whether that read was complete. */
export interface CreditNoteBaseline { readonly ids: readonly string[]; readonly complete: boolean }
/** What a card listed for D-P2-15 (anotherNoteFound / anotherNoteUnknown): the ids and whether its comparison was complete. */
export interface CreditNoteShown { readonly ids: readonly string[]; readonly complete: boolean }
export interface CreditNoteSignIn { readonly mono: number; readonly wall: number }

export interface HeldCreditNote {
  readonly attemptId: string;
  readonly storeId: string;
  /** The store's tenant (GET /api/v1/stores), every body's expectedTenant. */
  readonly tenantId: string;
  readonly invoiceId: string;
  readonly invoiceNumber: number;
  readonly grossCents: number;
  readonly reason: InvoiceCreditNoteReason;
  /** The session token its requests go with; null once detached. */
  readonly csrf: string | null;
  readonly generation: number;
  /** The shop-observed sign-in; null for an attempt held from a lookup row (it never registers or issues). */
  readonly signIn: CreditNoteSignIn | null;
  /** The stage last sent (or held to be sent). */
  readonly stage: CreditNoteStage;
  readonly state: CreditNoteState;
  /** Set once the attempt was ever left unresolved: no later success runs on into the next stage (§2.6 item 3). */
  readonly unresolved: boolean;
  /** "Hide this attempt": the card only; answers still update the hold. */
  readonly hidden: boolean;
  readonly register: HeldCreditNoteBytes | null;
  readonly issue: HeldCreditNoteBytes | null;
  readonly settle: (HeldCreditNoteBytes & { readonly version: 1 | 2 }) | null;
  readonly registrationId: string | null;
  readonly creditNoteId: string | null;
  readonly baseline: CreditNoteBaseline | null;
  readonly shown: CreditNoteShown | null;
  readonly sends: readonly CreditNoteSend[];
  /** Monotonic time before which no send of a stage leaves: a request_in_progress pause or a Retry-After. */
  readonly notBefore: Readonly<Partial<Record<CreditNoteStage, number>>>;
}

interface CreditNoteFacts {
  readonly attemptId: string; readonly storeId: string; readonly tenantId: string; readonly invoiceId: string; readonly invoiceNumber: number;
  readonly grossCents: number; readonly reason: InvoiceCreditNoteReason; readonly csrf: string; readonly key: string; readonly body: string;
}
/** A new attempt: from "Issue credit note" (the register's key and bytes, the sign-in, the baseline) or from a lookup row's settlement. */
export type CreditNoteHoldInit = CreditNoteFacts & (
  | { readonly start: 'register'; readonly signIn: CreditNoteSignIn; readonly baseline: CreditNoteBaseline }
  | { readonly start: 'settle'; readonly version: 1 | 2; readonly creditNoteId: string | null }
);
export type CreditNotePut = { readonly kind: 'held'; readonly held: HeldCreditNote } | { readonly kind: 'busy' | 'lapsed' | 'invalid' };
/** What `change` may move (no field undefined): state forward only (an end scrubs every byte), `unresolved` only to true, the two ids only once, `shown` only while attached and open. */
export interface CreditNoteChange {
  readonly state?: CreditNoteState;
  readonly unresolved?: true;
  readonly registrationId?: string;
  readonly creditNoteId?: string;
  readonly shown?: CreditNoteShown | null;
}
/**
 * One answer judged: `stale` (not this attempt's any more — no exact recorded send, another generation, token or session
 * count, an ended hold, or an unstored answer for a stage already decided); a stored answer `first` (apply it), `same` (no
 * second transition) or `different` (fail closed); otherwise its class — commands `unstored` / `provisional` /
 * `fail-closed`, the proof `open` / `neutral` / `provisional` / `fail-closed`.
 */
export type CreditNoteDecision = 'stale' | 'first' | 'same' | 'different' | Exclude<CreditNoteEvidence, 'stored'> | 'open' | 'neutral';
/** Why `send` would refuse now (null: it may leave). */
export type CreditNoteSendBlock = 'detached' | 'ended' | 'decided' | 'no-bytes' | 'sent' | 'not-sent' | 'lapsed' | 'window' | 'in-flight' | 'cooling';

export interface CreditNoteHoldStore {
  get(uid: string): HeldCreditNote | undefined;
  /**
   * Hold a new attempt BEFORE its first send, under a new generation: `busy` while this user has an open one (attached,
   * hidden or detached; a detached one only yields to its own lookup row's settlement); `lapsed` past the 8-minute sign-in
   * (or one from the future); `invalid` for a key that is no v4 or bytes not its own.
   */
  put(uid: string, init: CreditNoteHoldInit): CreditNotePut;
  /** The one issue key: none → `key` with its bytes. `taken` once claimed; `lapsed` past 8 minutes; `gone` for no registered, attached attempt of that generation, a bad or used key, or bytes not its own issue. */
  claimIssueKey(uid: string, attemptId: string, generation: number, key: string, body: string): 'claimed' | 'taken' | 'lapsed' | 'gone';
  /** A settlement's new, unused v4 key and its own bytes, held before its send: version 2 only when issued, 1 only before; never over a sent, undecided one that was not retired. */
  holdSettlement(uid: string, attemptId: string, generation: number, version: 1 | 2, key: string, body: string): boolean;
  /** The last gate and record of one send: its ticket, or null (see `sendBlockOf`; also another token). */
  send(uid: string, attemptId: string, generation: number, stage: CreditNoteStage, opts: { readonly replay: boolean; readonly csrf: string; readonly sessionEnds: number }): CreditNoteTicket | null;
  /** Whether an answer to `ticket` still belongs: its exact recorded send, the hold open, attached and of its generation, the same token and session count now, the stage's current key (the proof: the latest). */
  belongs(uid: string, ticket: CreditNoteSend, current: { readonly csrf: string | null; readonly sessionEnds: number }): boolean;
  /** Attribution and judgement in one step (see CreditNoteDecision); the send is no longer in flight, and a pause or Retry-After is kept. */
  decide(uid: string, ticket: CreditNoteSend, current: { readonly csrf: string | null; readonly sessionEnds: number }, result: CreditNoteCommandResult | CreditNoteProofResult): CreditNoteDecision;
  change(uid: string, attemptId: string, generation: number, next: CreditNoteChange): boolean;
  /** Hide the card; the generation stays. */
  hide(uid: string, attemptId: string): boolean;
  /**
   * Scrub a command stage's bytes so a new settlement key may follow: only with nothing in flight under it, and only once
   * it is decided — a stored completion, its window passed, or a first send's unstored answer with no Check again sent.
   */
  retire(uid: string, attemptId: string, generation: number, stage: CommandStage): boolean;
  /** Drop an ended attempt, or one that never sent anything; an open one that sent is hidden instead. */
  remove(uid: string, attemptId: string): boolean;
  detach(uid: string): void;
  detachOthers(uid: string | null): void;
  subscribe(listener: () => void): () => void;
  dispose(): void;
}

/** Live: not ended and still attached. */
export const isLiveCreditNote = (held: HeldCreditNote | undefined): held is HeldCreditNote => held !== undefined && held.csrf !== null && !isEnd(held.state);
/** Not ended (attached or not, hidden or not): it holds its invoice's actions back and is never replaced (doc 17 §2.3, D-P2-6). */
export const isOpenCreditNote = (held: HeldCreditNote | undefined): held is HeldCreditNote => held !== undefined && !isEnd(held.state);
/** The larger of the monotonic and the wall-clock time since a reading; non-finite when either is. */
export const creditNoteElapsed = (from: CreditNoteSignIn, mono: number, wall: number): number => Math.max(mono - from.mono, wall - from.wall);
/** Inside the window: a finite elapsed time below (or at) the limit — a reading from the future on both clocks counts as passed. */
const within = (from: CreditNoteSignIn | null, mono: number, wall: number, limit: number, inclusive: boolean): boolean => {
  if (from === null) return false;
  const elapsed = creditNoteElapsed(from, mono, wall);
  return Number.isFinite(elapsed) && elapsed >= 0 && (inclusive ? elapsed <= limit : elapsed < limit);
};
/** A first send of a register or an issue may leave: the sign-in is at most 8 minutes old. */
export const signInFresh = (signIn: CreditNoteSignIn | null, mono: number, wall: number): boolean => within(signIn, mono, wall, CREDIT_NOTE_FIRST_SEND_MS, true);
const firstOf = (bytes: HeldCreditNoteBytes | null): CreditNoteSignIn | null =>
  bytes === null || bytes.firstMono === null || bytes.firstWall === null ? null : { mono: bytes.firstMono, wall: bytes.firstWall };
/** The stage's Check-again window by time alone (from the sign-in; a settlement from its first send). */
const windowOpen = (held: HeldCreditNote, stage: CommandStage, mono: number, wall: number): boolean =>
  stage === 'settle' ? within(firstOf(held.settle), mono, wall, CREDIT_NOTE_SETTLE_REPLAY_MS, false) : within(held.signIn, mono, wall, CREDIT_NOTE_REPLAY_MS, false);
/** Whether a Check again of `stage` may go now by its window and bytes (display; `send` checks everything). */
export function replayWindowOpen(held: HeldCreditNote | undefined, stage: CommandStage, mono: number, wall: number): boolean {
  const bytes = held?.[stage] ?? null;
  return held !== undefined && held.csrf !== null && bytes !== null && bytes.body !== '' && firstOf(bytes) !== null && windowOpen(held, stage, mono, wall);
}
const keyOf = (held: HeldCreditNote, stage: CreditNoteStage): string | undefined => (stage === 'proof' ? '' : held[stage]?.key);
/** Whether a Check again was ever sent under `stage`'s current key (§2.6 item 4: an unstored answer is then provisional). */
export const replaySent = (held: HeldCreditNote | undefined, stage: CommandStage): boolean =>
  held !== undefined && held.sends.some((s) => s.replay && s.stage === stage && s.key === held[stage]?.key);
const unanswered = (held: HeldCreditNote, stage: CreditNoteStage): readonly CreditNoteSend[] =>
  held.sends.filter((s) => s.stage === stage && !s.answered && s.key === keyOf(held, stage));
/** Why a send of `stage` (a first send, or a Check again when `replay`) would be refused now; null when it may leave. */
export function sendBlockOf(held: HeldCreditNote | undefined, stage: CreditNoteStage, replay: boolean, mono: number, wall: number): CreditNoteSendBlock | null {
  if (held === undefined || held.csrf === null) return 'detached';
  if (isEnd(held.state)) return 'ended';
  const flying = unanswered(held, stage).some((s) => mono - s.mono < CREDIT_NOTE_STAGE_WAIT_MS);
  const cooling = (held.notBefore[stage] ?? Number.NEGATIVE_INFINITY) > mono;
  if (stage === 'proof') return held.registrationId === null ? 'no-bytes' : flying ? 'in-flight' : cooling ? 'cooling' : null;
  const bytes = held[stage];
  if (bytes !== null && bytes.completion !== null) return 'decided';
  if (bytes === null || bytes.body === '') return 'no-bytes';
  const sentBefore = held.sends.some((s) => s.stage === stage && s.key === bytes.key);
  if (!replay) return sentBefore ? 'sent' : stage !== 'settle' && !signInFresh(held.signIn, mono, wall) ? 'lapsed' : null;
  if (!sentBefore) return 'not-sent';
  if (!windowOpen(held, stage, mono, wall)) return 'window';
  return flying ? 'in-flight' : cooling ? 'cooling' : null;
}

const CHANGEABLE: ReadonlySet<string> = new Set(['state', 'unresolved', 'registrationId', 'creditNoteId', 'shown']);
/**
 * Forward only, ends final; `issuing` only by claiming the issue key; `released` only before an issue 201 (an issued row is
 * only ever confirmed); `ended` (refused, nothing ran) only before any issue key was claimed.
 */
const canMove = (from: CreditNoteState, to: CreditNoteState): boolean => from === to || (!isEnd(from) && to !== 'issuing'
  && (to === 'released' ? RANK[from] <= RANK.issuing : to === 'ended' ? RANK[from] <= RANK.registered : RANK[to] > RANK[from]));
const freshBytes = (key: string, body: string): HeldCreditNoteBytes =>
  Object.freeze({ key, body, firstMono: null, firstWall: null, completion: null, unstored: false });
const scrub = <T extends HeldCreditNoteBytes>(bytes: T | null): T | null => (bytes === null || bytes.body === '' ? bytes : Object.freeze({ ...bytes, body: '' }));
/** A stored answer's identity, canonically: every field but the replay header, in sorted key order. */
const canonical = (result: CreditNoteCommandResult): string => {
  const fields = result as unknown as Record<string, unknown>;
  return JSON.stringify(Object.keys(fields).filter((k) => k !== 'replayed').sort().map((k) => [k, fields[k]]));
};
/** Every key this attempt ever held or sent under: none may serve another stage. */
const keysOf = (held: HeldCreditNote): ReadonlySet<string> =>
  new Set([held.register?.key, held.issue?.key, held.settle?.key, ...held.sends.map((s) => s.key)].filter((k): k is string => typeof k === 'string' && k !== ''));
/** Whether `body` is byte for byte the issue this attempt may send: its tenant, registration, attempt, amount and reason, and a proof. */
const isOwnIssue = (h: HeldCreditNote, body: string): boolean => {
  try {
    const parsed: unknown = JSON.parse(body);
    const proof = typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>).registrationProof : undefined;
    return typeof proof === 'string' && h.registrationId !== null && creditNoteIssueBodyOf({
      expectedTenant: h.tenantId, registrationId: h.registrationId, attemptId: h.attemptId, grossCents: h.grossCents, reason: h.reason, registrationProof: proof,
    }) === body;
  } catch {
    return false;
  }
};
const SUCCESS: Readonly<Record<CommandStage, string>> = Object.freeze({ register: 'registered', issue: 'issued', settle: 'settled' });
/** A result of another stage's shape (a caller's mix-up) is never judged as this stage's. */
const fitsStage = (stage: CreditNoteStage, result: CreditNoteCommandResult | CreditNoteProofResult): boolean => {
  const own = ['refused', 'malformed', 'not-sent', 'unknown', stage === 'proof' ? 'proof' : SUCCESS[stage]];
  return own.includes(result.kind);
};

export function createCreditNoteHoldStore(clocks: { readonly now?: () => number; readonly wallNow?: () => number } = {}): CreditNoteHoldStore {
  const now = clocks.now ?? (() => performance.now());
  const wallNow = clocks.wallNow ?? (() => Date.now());
  const held = new Map<string, HeldCreditNote>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const listeners = new Set<() => void>();
  let generations = 0;
  const tell = (): void => { for (const listener of [...listeners]) listener(); };
  const set = (uid: string, next: HeldCreditNote): void => { held.set(uid, Object.freeze(next)); tell(); };
  /** This attempt, under this generation, or undefined. */
  const own = (uid: string, attemptId: string, generation: number): HeldCreditNote | undefined => {
    const h = held.get(uid);
    return h !== undefined && h.attemptId === attemptId && h.generation === generation ? h : undefined;
  };
  /** The exact recorded send a ticket names, in the hold of its generation. */
  const recorded = (h: HeldCreditNote | undefined, t: CreditNoteSend): CreditNoteSend | undefined =>
    h === undefined || h.attemptId !== t.attemptId || h.generation !== t.generation ? undefined
      : h.sends.find((s) => s.n === t.n && s.stage === t.stage && s.key === t.key && s.replay === t.replay && s.generation === t.generation
        && s.csrf === t.csrf && s.sessionEnds === t.sessionEnds);
  const attributed = (h: HeldCreditNote, t: CreditNoteSend, current: { readonly csrf: string | null; readonly sessionEnds: number }): boolean =>
    !isEnd(h.state) && h.csrf !== null && h.csrf === t.csrf && current.csrf === t.csrf && current.sessionEnds === t.sessionEnds
    && (t.stage === 'proof' ? h.sends.filter((s) => s.stage === 'proof').pop()?.n === t.n : keyOf(h, t.stage) === t.key);

  /** Scrub what has passed its window, then wait for the next window to pass (never a send). */
  const sync = (uid: string): void => {
    clearTimeout(timers.get(uid));
    timers.delete(uid);
    let h = held.get(uid);
    if (h === undefined) return;
    const mono = now();
    const wall = wallNow();
    const replayBytes = (h.register?.body ?? '') !== '' || (h.issue?.body ?? '') !== '';
    if (replayBytes && !within(h.signIn, mono, wall, CREDIT_NOTE_REPLAY_MS, false)) set(uid, { ...h, register: scrub(h.register), issue: scrub(h.issue) });
    h = held.get(uid) as HeldCreditNote;
    const settleFirst = firstOf(h.settle);
    if ((h.settle?.body ?? '') !== '' && settleFirst !== null && !within(settleFirst, mono, wall, CREDIT_NOTE_SETTLE_REPLAY_MS, false)) set(uid, { ...h, settle: scrub(h.settle) });
    h = held.get(uid) as HeldCreditNote;
    const waits: number[] = [];
    if (h.signIn !== null && ((h.register?.body ?? '') !== '' || (h.issue?.body ?? '') !== '')) waits.push(CREDIT_NOTE_REPLAY_MS - creditNoteElapsed(h.signIn, mono, wall));
    const first = firstOf(h.settle);
    if ((h.settle?.body ?? '') !== '' && first !== null) waits.push(CREDIT_NOTE_SETTLE_REPLAY_MS - creditNoteElapsed(first, mono, wall));
    if (waits.length > 0) timers.set(uid, setTimeout(() => { timers.delete(uid); sync(uid); }, Math.max(0, Math.min(...waits))));
  };
  const detachOne = (uid: string): boolean => {
    const h = held.get(uid);
    if (h === undefined || h.csrf === null) return false;
    held.set(uid, Object.freeze({
      ...h, csrf: null, generation: ++generations, register: scrub(h.register), issue: scrub(h.issue), settle: scrub(h.settle),
      sends: Object.freeze(h.sends.map((s) => Object.freeze({ ...s, csrf: '' }))), baseline: null, shown: null,
    }));
    return true;
  };

  const store: CreditNoteHoldStore = {
    get: (uid: string) => held.get(uid),
    put(uid: string, init: CreditNoteHoldInit): CreditNotePut {
      const was = held.get(uid);
      // An open attempt stays (D-P2-6); only a detached one's own lookup row settles it under the new session.
      if (isOpenCreditNote(was) && !(was.csrf === null && was.attemptId === init.attemptId && init.start === 'settle')) return Object.freeze({ kind: 'busy' });
      const facts = [init.attemptId, init.storeId, init.tenantId, init.invoiceId, init.csrf, init.key, init.body];
      const register = init.start === 'register';
      // Only this attempt's own bytes: a body built from other values would make a matching 201 name the wrong thing.
      const ownBytes = register ? creditNoteRegisterBodyOf(init.tenantId, init.attemptId, init.grossCents, init.reason) : settleBodyOf(init.tenantId, init.attemptId, init.version);
      if (facts.some((v) => typeof v !== 'string' || v === '') || ownBytes !== init.body || !KEY_V4_RE.test(init.key)) return Object.freeze({ kind: 'invalid' });
      if (register && !signInFresh(init.signIn, now(), wallNow())) return Object.freeze({ kind: 'lapsed' });
      const next: HeldCreditNote = {
        attemptId: init.attemptId, storeId: init.storeId, tenantId: init.tenantId, invoiceId: init.invoiceId, invoiceNumber: init.invoiceNumber,
        grossCents: init.grossCents, reason: init.reason, csrf: init.csrf, generation: ++generations,
        signIn: register ? Object.freeze({ mono: init.signIn.mono, wall: init.signIn.wall }) : null,
        stage: init.start, state: register ? 'registering' : init.version === 2 ? 'issued' : 'registered', unresolved: false, hidden: false,
        register: register ? freshBytes(init.key, init.body) : null, issue: null,
        settle: register ? null : Object.freeze({ ...freshBytes(init.key, init.body), version: init.version }),
        registrationId: null, creditNoteId: register ? null : init.creditNoteId,
        baseline: register ? Object.freeze({ ids: Object.freeze([...init.baseline.ids]), complete: init.baseline.complete }) : null,
        shown: null, sends: Object.freeze([]), notBefore: Object.freeze({}),
      };
      set(uid, next);
      sync(uid);
      return Object.freeze({ kind: 'held', held: held.get(uid) as HeldCreditNote });
    },
    claimIssueKey(uid: string, attemptId: string, generation: number, key: string, body: string): 'claimed' | 'taken' | 'lapsed' | 'gone' {
      const h = own(uid, attemptId, generation);
      if (h === undefined || h.csrf === null) return 'gone';
      if (h.issue !== null) return 'taken';
      if (h.state !== 'registered' || h.registrationId === null || !KEY_V4_RE.test(key) || keysOf(h).has(key) || !isOwnIssue(h, body)) return 'gone';
      if (!signInFresh(h.signIn, now(), wallNow())) return 'lapsed';
      set(uid, { ...h, issue: freshBytes(key, body), state: 'issuing' });
      sync(uid);
      return 'claimed';
    },
    holdSettlement(uid: string, attemptId: string, generation: number, version: 1 | 2, key: string, body: string): boolean {
      const h = own(uid, attemptId, generation);
      if (h === undefined || h.csrf === null || isEnd(h.state) || !KEY_V4_RE.test(key) || keysOf(h).has(key) || settleBodyOf(h.tenantId, h.attemptId, version) !== body) return false;
      if (version === 2 ? h.state !== 'issued' : RANK[h.state] > RANK.issuing) return false;
      // No replacement key for a sent, undecided settlement while its bytes stand (§2.6 item 2): `retire` it first.
      const prior = h.settle;
      if (prior !== null && prior.body !== '' && prior.completion === null && h.sends.some((s) => s.stage === 'settle' && s.key === prior.key)) return false;
      set(uid, { ...h, settle: Object.freeze({ ...freshBytes(key, body), version }) });
      sync(uid);
      return true;
    },
    send(uid, attemptId, generation, stage, opts): CreditNoteTicket | null {
      const h = own(uid, attemptId, generation);
      if (h === undefined || h.csrf === null || h.csrf !== opts.csrf) return null;
      const mono = now();
      const wall = wallNow();
      const block = sendBlockOf(h, stage, opts.replay, mono, wall);
      if (block !== null) {
        if (block === 'window') sync(uid);
        return null;
      }
      const bytes = stage === 'proof' ? null : h[stage];
      const key = bytes?.key ?? '';
      const body = bytes?.body ?? (h.registrationId as string);
      const record: CreditNoteSend = Object.freeze({
        attemptId, n: h.sends.length + 1, stage, key, replay: opts.replay, generation, csrf: opts.csrf, sessionEnds: opts.sessionEnds, mono, wall, answered: false,
      });
      const first = bytes !== null && !opts.replay ? { [stage]: Object.freeze({ ...bytes, firstMono: mono, firstWall: wall }) } : {};
      set(uid, { ...h, ...first, stage, sends: Object.freeze([...h.sends, record]) });
      sync(uid);
      return Object.freeze({ ...record, body });
    },
    belongs(uid, ticket, current): boolean {
      const h = held.get(uid);
      return recorded(h, ticket) !== undefined && attributed(h as HeldCreditNote, ticket, current);
    },
    decide(uid, ticket, current, result): CreditNoteDecision {
      const h = held.get(uid);
      const rec = recorded(h, ticket);
      if (h === undefined || rec === undefined) return 'stale';
      const mono = now();
      // Whatever it says, the request is over: no longer in flight.
      const sends = Object.freeze(h.sends.map((s) => (s === rec ? Object.freeze({ ...s, answered: true }) : s)));
      if (!attributed(h, ticket, current)) { set(uid, { ...h, sends }); return 'stale'; }
      const stage = ticket.stage;
      const pause = result.kind === 'refused' && result.status === 409 && !result.sealed && result.error === 'request_in_progress' ? CREDIT_NOTE_IN_PROGRESS_WAIT_MS
        : result.kind === 'refused' && result.status === 429 && result.retryAfterSeconds !== null ? result.retryAfterSeconds * 1_000 : 0;
      const notBefore = pause > 0 ? Object.freeze({ ...h.notBefore, [stage]: mono + pause }) : h.notBefore;
      if (stage === 'proof') {
        set(uid, { ...h, sends, notBefore });
        return fitsStage(stage, result) ? proofEvidenceOf(result as CreditNoteProofResult) : 'fail-closed';
      }
      const bytes = h[stage] as HeldCreditNoteBytes;
      const command = result as CreditNoteCommandResult;
      const evidence = fitsStage(stage, result) ? evidenceOf(command, { firstSend: !ticket.replay, replaySent: replaySent(h, stage) }) : 'fail-closed';
      if (evidence === 'stored') {
        if (bytes.completion !== null) { set(uid, { ...h, sends }); return canonical(bytes.completion) === canonical(command) ? 'same' : 'different'; }
        set(uid, { ...h, sends, [stage]: Object.freeze({ ...bytes, completion: Object.freeze({ ...command }) }) });
        return 'first';
      }
      if (bytes.completion !== null) { set(uid, { ...h, sends }); return 'stale'; }
      set(uid, { ...h, sends, notBefore, ...(evidence === 'unstored' ? { [stage]: Object.freeze({ ...bytes, unstored: true }) } : {}) });
      return evidence;
    },
    change(uid: string, attemptId: string, generation: number, next: CreditNoteChange): boolean {
      const h = own(uid, attemptId, generation);
      if (h === undefined || !Object.entries(next).every(([field, value]) => CHANGEABLE.has(field) && value !== undefined)) return false;
      const fills = (was: string | null, to: string | undefined): boolean => to === undefined || (typeof to === 'string' && to !== '' && (was === null || was === to));
      const allowed = (next.state === undefined || (Object.prototype.hasOwnProperty.call(RANK, next.state) && canMove(h.state, next.state)))
        && (next.unresolved === undefined || (next.unresolved === true && !isEnd(h.state)))
        && fills(h.registrationId, next.registrationId) && fills(h.creditNoteId, next.creditNoteId)
        && (next.shown === undefined || next.shown === null || (h.csrf !== null && !isEnd(h.state)));
      if (!allowed) return false;
      const shown = next.shown === undefined || next.shown === null ? next.shown : Object.freeze({ ids: Object.freeze([...next.shown.ids]), complete: next.shown.complete });
      const ended = next.state !== undefined && isEnd(next.state);
      set(uid, { ...h, ...next, ...(shown === undefined ? {} : { shown }), ...(ended ? { register: scrub(h.register), issue: scrub(h.issue), settle: scrub(h.settle) } : {}) });
      sync(uid);
      return true;
    },
    hide(uid: string, attemptId: string): boolean {
      const h = held.get(uid);
      if (h === undefined || h.attemptId !== attemptId) return false;
      if (!h.hidden) set(uid, { ...h, hidden: true });
      return true;
    },
    retire(uid: string, attemptId: string, generation: number, stage: CommandStage): boolean {
      // A replacement settlement key is legitimate only after a lookup (lookup-first, D-P2-16); the section enforces that.
      const h = own(uid, attemptId, generation);
      const bytes = h?.[stage] ?? null;
      if (h === undefined || bytes === null || unanswered(h, stage).length > 0) return false;
      const decided = bytes.completion !== null || !windowOpen(h, stage, now(), wallNow()) || (bytes.unstored && !replaySent(h, stage));
      if (!decided) return false;
      set(uid, { ...h, [stage]: scrub(bytes) });
      sync(uid);
      return true;
    },
    remove(uid: string, attemptId: string): boolean {
      const h = held.get(uid);
      if (h === undefined || h.attemptId !== attemptId || (!isEnd(h.state) && h.sends.length > 0)) return false;
      held.delete(uid);
      sync(uid);
      tell();
      return true;
    },
    detach(uid: string): void {
      if (!detachOne(uid)) return;
      sync(uid);
      tell();
    },
    detachOthers(uid: string | null): void {
      let changed = false;
      for (const other of [...held.keys()]) if (other !== uid && detachOne(other)) { changed = true; sync(other); }
      if (changed) tell();
    },
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    dispose(): void {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
      for (const uid of [...held.keys()]) detachOne(uid);
      tell();
    },
  };
  return Object.freeze(store);
}

/** The shop's one credit-note hold store, detached at every sign-out as the other holds are. */
export const creditNoteHolds: CreditNoteHoldStore = createCreditNoteHoldStore();
const unbindCreditNoteHolds = bindDraftHoldsToSessionEnd(creditNoteHolds);
import.meta.hot?.dispose(() => { unbindCreditNoteHolds(); creditNoteHolds.dispose(); });
