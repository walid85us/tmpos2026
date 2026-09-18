// Phase 4.0 M5-GAP11-P1 — the dual-read shadow comparator (04 §3 safeguard #5). Since M5-GAP11-P3 it
// reads the pinned candidate (D2's grants and D3's compatibility pins), which equals the shipped
// authority, so every divergence below is driven by a caller decision that disagrees with it.
//
// The whole value of a shadow read is that it cannot affect the decision it shadows. So most of this
// suite is adversarial: throw from the candidate, throw from the observer, hand it garbage, hand it a
// decision that is not a decision — and require that the caller's own answer comes back untouched and
// that nothing ever fails open.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

import { createShadowComparator, type ShadowMismatch } from './gap11ShadowComparator';
import {
  CANONICAL_GRANT_UNIVERSE,
  CANONICAL_DIFF_CONTEXT,
  computeGrantDiff,
  computeRepinnedGrantDiff,
  evaluateAfterCandidate,
  evaluateAfterRepinCandidate,
  evaluateBefore,
  evaluatePinnedCandidate,
  D3_COMPATIBILITY_PINS,
  type CanonicalGrantTuple,
  type D3CompatibilityPin,
  type GrantEvaluationContext,
} from './gap11GrantDiff';

const CTX = CANONICAL_DIFF_CONTEXT;
const SOURCE = readFileSync(fileURLToPath(new URL('./gap11ShadowComparator.ts', import.meta.url)), 'utf8');

const tupleFor = (pred: (t: CanonicalGrantTuple) => boolean): CanonicalGrantTuple =>
  CANONICAL_GRANT_UNIVERSE.find(pred)!;

/**
 * A tuple the unified ordering alone disagrees about — `manager` holds `manage` on `returns` — and D3
 * pins to its authoritative `denied`. Against the pinned candidate only a caller that says `granted`
 * diverges on it.
 */
const DIVERGING = tupleFor((t) =>
  t.plane === 'tenant' && t.stratum === 'domain_threshold'
  && t.role === 'manager' && t.scope === 'returns' && t.action === 'require:approve');

/** A tuple they agree about. */
const AGREEING = tupleFor((t) =>
  t.plane === 'tenant' && t.stratum === 'domain_threshold'
  && t.role === 'manager' && t.scope === 'sales' && t.action === 'require:view');

// =============================================================================
// The authoritative answer survives, always
// =============================================================================

test('the caller decision is returned unchanged for every tuple in the universe', () => {
  const c = createShadowComparator({ maxRecords: 0 });
  for (const t of CANONICAL_GRANT_UNIVERSE) {
    const authoritative = evaluateBefore(t, CTX);
    assert.equal(c.compare(t, CTX, authoritative), authoritative);
  }
});

test('the candidate never becomes the answer, precisely where it disagrees', () => {
  const diff = computeGrantDiff(CTX);
  assert.ok(diff.rows.length > 0, 'the control is meaningless without real divergences');
  const c = createShadowComparator();
  for (const r of diff.rows) {
    const t = tupleFor((x) => x.role === r.role && x.scope === r.scope && x.action === r.action
      && x.plane === r.plane && x.stratum === r.stratum);
    const returned = c.compare(t, CTX, r.before);
    assert.equal(returned, r.before, 'the shipped answer');
    assert.notEqual(returned, r.after, 'and specifically not the candidate answer');
  }
});

test('a denial is never converted into an allowance, whatever the comparator does', () => {
  // Force every hostile condition at once and assert the direction that matters.
  const hostile = createShadowComparator({ observer() { throw new Error('sink is broken'); } });
  assert.equal(hostile.compare(DIVERGING, CTX, 'denied'), 'denied');
  assert.equal(hostile.compare(AGREEING, CTX, 'denied'), 'denied');
  assert.equal(hostile.compare({ junk: true } as unknown as CanonicalGrantTuple, CTX, 'denied'), 'denied');
  assert.equal(hostile.compare(DIVERGING, null as never, 'denied'), 'denied');
  assert.equal(hostile.compare(DIVERGING, undefined as never, 'denied'), 'denied');
});

// =============================================================================
// Records: only on disagreement, bounded, vocabulary-only
// =============================================================================

test('exact agreement produces no record at all', () => {
  const seen: ShadowMismatch[] = [];
  const c = createShadowComparator({ observer: (m) => { seen.push(m); } });
  const authoritative = evaluateBefore(AGREEING, CTX);
  c.compare(AGREEING, CTX, authoritative);
  assert.deepEqual(seen, []);
  assert.deepEqual(c.records(), []);
});

test('disagreement produces exactly one bounded record naming only canonical vocabulary', () => {
  const seen: ShadowMismatch[] = [];
  const c = createShadowComparator({ observer: (m) => { seen.push(m); } });
  c.compare(DIVERGING, CTX, 'granted');

  assert.equal(seen.length, 1, 'one record per compare, not two');
  assert.deepEqual(c.records(), seen);
  const m = seen[0];
  assert.deepEqual({ ...m }, {
    kind: 'divergence',
    plane: 'tenant',
    stratum: 'domain_threshold',
    role: 'manager',
    scope: 'returns',
    action: 'require:approve',
    requiredLevel: 'approve',
    // The corrected taxonomy travels with the record: structurally approve-level, and NOT a D2 row —
    // no document ties the returns domain at approve to a money action.
    requiresApproveLevel: true,
    d2Classification: 'unresolved',
    moneyAction: null,
    authoritative: 'granted',
    candidate: 'denied',
  });
  assert.equal(Object.isFrozen(m), true);
});

/** The opposite of the shipped answer: a caller that disagrees with the pinned candidate on every tuple. */
const opposite = (t: CanonicalGrantTuple): 'granted' | 'denied' => (evaluateBefore(t, CTX) === 'granted' ? 'denied' : 'granted');

test('a record carries no identity, credential, request or free text — asserted over the whole universe', () => {
  const c = createShadowComparator({ maxRecords: 4096 });
  for (const t of CANONICAL_GRANT_UNIVERSE) c.compare(t, CTX, opposite(t));
  assert.equal(c.records().length, CANONICAL_GRANT_UNIVERSE.length, 'one record for every tuple');

  const ALLOWED_KEYS = ['kind', 'plane', 'stratum', 'role', 'scope', 'action', 'requiredLevel',
    'requiresApproveLevel', 'd2Classification', 'moneyAction', 'authoritative', 'candidate'];
  const vocabulary = new Set<string>([
    ...CANONICAL_GRANT_UNIVERSE.map((t) => t.role),
    ...CANONICAL_GRANT_UNIVERSE.map((t) => t.scope),
    ...CANONICAL_GRANT_UNIVERSE.map((t) => t.action),
  ]);

  assert.ok(c.records().length > 0, 'there is something to inspect');
  for (const m of c.records()) {
    assert.deepEqual(Object.keys(m).sort(), [...ALLOWED_KEYS].sort(), 'no extra field');
    assert.ok(vocabulary.has(m.role), `role ${m.role} is catalog vocabulary`);
    assert.ok(vocabulary.has(m.scope), `scope ${m.scope} is catalog vocabulary`);
    assert.ok(vocabulary.has(m.action), `action ${m.action} is catalog vocabulary`);
    // Nothing in the record may be a free-form or identifying value.
    const serialized = JSON.stringify(m);
    for (const forbidden of ['@', 'Bearer', 'token', 'cookie', 'session', 'uid', 'email', 'password', 'http', 'tenant_id', 'store_id']) {
      assert.ok(!serialized.toLowerCase().includes(forbidden.toLowerCase()), `${forbidden} absent from ${serialized}`);
    }
  }
});

test('the record buffer is bounded and drops are counted, never accumulated', () => {
  const c = createShadowComparator({ maxRecords: 3 });
  const diverging = computeGrantDiff(CTX).rows.map((r) =>
    tupleFor((x) => x.role === r.role && x.scope === r.scope && x.action === r.action));
  assert.ok(diverging.length > 3, 'more divergences than the cap');
  for (const t of diverging) c.compare(t, CTX, opposite(t));
  assert.equal(c.records().length, 3);
  assert.equal(c.dropped(), diverging.length - 3);
});

test('records() hands back a frozen copy that cannot be used to mutate the buffer', () => {
  const c = createShadowComparator();
  c.compare(DIVERGING, CTX, 'granted');
  const first = c.records();
  assert.equal(Object.isFrozen(first), true);
  assert.notEqual(first, c.records(), 'a fresh copy each call');
  assert.equal(c.records().length, 1, 'the internal buffer is unchanged');
});

// =============================================================================
// Failure containment
// =============================================================================

test('an async observer that rejects is settled, never left as an unhandled rejection', async () => {
  const c = createShadowComparator({ observer: async () => { throw new Error('sink down'); } });
  assert.equal(c.compare(DIVERGING, CTX, 'granted'), 'granted');
  assert.equal(c.records().length, 1);
  // Let the rejection surface: were it unhandled, the test runner would fail this test here.
  await new Promise((resolve) => setImmediate(resolve));
});

test('an observer that throws cannot influence the decision or lose the record', () => {
  let calls = 0;
  const c = createShadowComparator({ observer() { calls += 1; throw new Error('boom'); } });
  assert.equal(c.compare(DIVERGING, CTX, 'granted'), 'granted');
  assert.equal(calls, 1);
  assert.equal(c.records().length, 1, 'the buffered copy survives a broken sink');
});

test('a malformed authoritative value fails closed to denied and is recorded as such', () => {
  for (const bad of ['allow', 'ALLOW', '', 'granted ', 0, 1, true, false, null, undefined, {}, []]) {
    const c = createShadowComparator();
    assert.equal(c.compare(DIVERGING, CTX, bad as never), 'denied', `${JSON.stringify(bad)} fails closed`);
    assert.equal(c.records()[0].kind, 'malformed_authoritative');
    assert.equal(c.records()[0].authoritative, 'denied');
    assert.equal(c.records()[0].candidate, null, 'no candidate is attempted for a malformed decision');
  }
});

test('a malformed tuple is recorded without a candidate, and is denied whatever the caller said', () => {
  const malformed: readonly unknown[] = [
    null, undefined, 42, 'tuple', [], {}, { plane: 'tenant' },
    { plane: 'nope', stratum: 'sub_permission', role: 'r', scope: 's', action: 'a', requiredLevel: null },
    // Well-formed but not canonical: caller text must never reach a record, whatever its size.
    { ...DIVERGING, role: 'victim@example.com' },
    { ...DIVERGING, scope: 'x'.repeat(1_000_000) },
    { ...DIVERGING, action: 'require:full' },
    { ...DIVERGING, requiredLevel: 'full' },
  ];
  for (const bad of malformed) {
    for (const authoritative of ['granted', 'denied'] as const) {
      const c = createShadowComparator();
      // M5-GAP11-P1-R1: a tuple that is not canonical is denied before any comparison — the caller's
      // `granted` for it is not admissible. The comparator can only ever tighten, never loosen.
      assert.equal(c.compare(bad as never, CTX, authoritative), 'denied');
      assert.equal(c.records()[0].kind, 'malformed_tuple');
      assert.equal(c.records()[0].authoritative, 'denied');
      assert.equal(c.records()[0].candidate, null);
      assert.equal(c.records()[0].role, '');
    }
  }
});

test('an unknown required level is denied before comparison and is never read as a `none` requirement', () => {
  // A canonical threshold tuple the caller grants, then the same tuple with its required level
  // replaced by something outside the catalog. The control proves the comparator does return a
  // caller's `granted` for a canonical tuple, so the denials below are the rule, not a constant.
  const threshold = tupleFor((t) => t.plane === 'tenant' && t.stratum === 'domain_threshold'
    && t.role === 'manager' && t.scope === 'sales' && t.action === 'require:none');
  const control = createShadowComparator();
  assert.equal(control.compare(threshold, CTX, 'granted'), 'granted', 'control: a canonical tuple keeps the caller decision');

  const nul = String.fromCharCode(0);
  const unknownLevels: readonly unknown[] = [
    'bogus', 'FULL', 'None', ' none', 'none ', '', `none${nul}`, `none${String.fromCharCode(1)}`,
    undefined, 0, false, {}, [], ['none'], 'constructor', '__proto__', 'toString',
  ];
  for (const requiredLevel of unknownLevels) {
    // The same substitution also on a tuple whose action names the level, so neither field is trusted.
    for (const bad of [{ ...threshold, requiredLevel }, { ...threshold, requiredLevel, action: `require:${String(requiredLevel)}` }]) {
      const c = createShadowComparator();
      assert.equal(c.compare(bad as never, CTX, 'granted'), 'denied', `denied: ${JSON.stringify(requiredLevel)}`);
      assert.equal(c.records().length, 1, 'observed once');
      const [m] = c.records();
      assert.equal(m.kind, 'malformed_tuple', 'refused as a tuple, not compared');
      assert.equal(m.candidate, null, 'no candidate was evaluated');
      assert.equal(m.requiredLevel, null, 'recorded as no level at all — never as `none`');
      assert.equal(m.action, '', 'and never as `require:none`');
      assert.equal(m.d2Classification, null);
      // Both evaluators agree it is no tuple: neither reads it as a `none` gate, which every level clears.
      assert.equal(evaluateBefore(bad as never, CTX), 'denied');
      assert.equal(evaluateAfterCandidate(bad as never, CTX), 'denied');
      assert.equal(evaluateAfterRepinCandidate(bad as never, CTX), 'denied');
      assert.equal(evaluatePinnedCandidate(bad as never, CTX), 'denied');
    }
  }
});

test('the shadow reads the pinned candidate on money actions, and still returns only the caller decision', () => {
  // M5-GAP11-P2: the candidate a cutover would install carries D2's explicit money-action grants. A
  // caller whose decision disagrees with an explicit grant is recorded, never overruled. Written by
  // hand from the D2 table: sales_staff holds `approve_refunds` false, store_owner the refunds
  // approval threshold true.
  const salesRefund = tupleFor((t) => t.plane === 'tenant' && t.stratum === 'sub_permission'
    && t.role === 'sales_staff' && t.action === 'approve_refunds');
  const ownerRefund = tupleFor((t) => t.plane === 'tenant' && t.stratum === 'domain_threshold'
    && t.role === 'store_owner' && t.scope === 'refunds' && t.action === 'require:approve');
  const cases = [[salesRefund, 'granted', 'denied'], [ownerRefund, 'denied', 'granted']] as const;
  for (const [t, callerSays, grantSays] of cases) {
    const c = createShadowComparator();
    assert.equal(c.compare(t, CTX, callerSays), callerSays, 'the caller decision is what comes back');
    assert.equal(c.records().length, 1);
    const [m] = c.records();
    assert.deepEqual({ kind: m.kind, d2: m.d2Classification, authoritative: m.authoritative, candidate: m.candidate },
      { kind: 'divergence', d2: 'money_action', authoritative: callerSays, candidate: grantSays });
  }
  // With the shipped authority as the caller, nothing diverges at all: the pinned candidate is the authority.
  const quiet = createShadowComparator({ maxRecords: 4096 });
  for (const t of CANONICAL_GRANT_UNIVERSE) assert.equal(quiet.compare(t, CTX, evaluateBefore(t, CTX)), evaluateBefore(t, CTX));
  assert.deepEqual(quiet.records(), []);
});

test('the shadow reads D3\'s pins: a caller giving the unified ordering\'s answer on a pinned row diverges from it', () => {
  // M5-GAP11-P3: the thirteen rows the post-D2 candidate changed are pinned to the authority. A caller
  // that answered as the unified ordering would is recorded against the pin — and still gets its own
  // answer back.
  const rows = computeRepinnedGrantDiff(CTX).rows;
  assert.equal(rows.length, 13, 'control: the thirteen rejected changes');
  const c = createShadowComparator();
  for (const r of rows) {
    const t = tupleFor((x) => x.plane === r.plane && x.stratum === r.stratum && x.role === r.role
      && x.scope === r.scope && x.action === r.action);
    assert.equal(c.compare(t, CTX, r.after), r.after, 'the caller decision is what comes back');
  }
  assert.deepEqual(c.records().map((m) => ({ kind: m.kind, authoritative: m.authoritative, candidate: m.candidate })),
    rows.map((r) => ({ kind: 'divergence', authoritative: r.after, candidate: r.before })));
});

test('an invalid pin table is surfaced as candidate_invalid on every compare that reaches the candidate, deterministically, and never decides', () => {
  // Removing one pin makes the candidate invalid. Every compare of a canonical tuple, in a readable
  // context, with a real decision records exactly one candidate_invalid record — never a divergence,
  // never an answer — and returns the caller decision unchanged.
  const invalid = D3_COMPATIBILITY_PINS.slice(1);
  const runs = [0, 1].map(() => {
    const c = createShadowComparator({ compatibilityPins: invalid, maxRecords: 4096 });
    for (const t of CANONICAL_GRANT_UNIVERSE) {
      for (const authoritative of ['granted', 'denied'] as const) assert.equal(c.compare(t, CTX, authoritative), authoritative);
    }
    return c.records();
  });
  assert.equal(runs[0].length, CANONICAL_GRANT_UNIVERSE.length * 2, 'one record per compare');
  assert.ok(runs[0].every((m) => m.kind === 'candidate_invalid' && m.candidate === null));
  assert.deepEqual(runs[0], runs[1], 'deterministic');
  assert.equal(evaluatePinnedCandidate(DIVERGING, CTX, invalid), 'invalid', 'control: the candidate itself is invalid');
  // A copy with the committed content is valid: the option can invalidate, never rewrite.
  const copy = createShadowComparator({ compatibilityPins: JSON.parse(JSON.stringify(D3_COMPATIBILITY_PINS)) });
  copy.compare(DIVERGING, CTX, 'denied');
  assert.deepEqual(copy.records(), []);
  // Malformed input is recorded as what it is, ahead of the candidate: that ordering is fixed too.
  const c = createShadowComparator({ compatibilityPins: invalid });
  assert.equal(c.compare({ junk: true } as unknown as CanonicalGrantTuple, CTX, 'granted'), 'denied');
  assert.equal(c.compare(DIVERGING, null as never, 'granted'), 'granted');
  assert.equal(c.compare(DIVERGING, CTX, 'allow' as never), 'denied');
  assert.deepEqual(c.records().map((m) => m.kind), ['malformed_tuple', 'malformed_context', 'malformed_authoritative']);
});

test('the pin option is decided once, at creation: changing the table afterwards changes nothing', () => {
  // A valid copy stays valid after it is emptied; an invalid table stays invalid after it is repaired;
  // and a getter-backed table is read at creation only, never inside compare().
  const valid = JSON.parse(JSON.stringify(D3_COMPATIBILITY_PINS)) as D3CompatibilityPin[];
  const a = createShadowComparator({ compatibilityPins: valid });
  valid.length = 0;
  a.compare(DIVERGING, CTX, 'denied');
  assert.deepEqual(a.records(), [], 'still the committed pins');
  const broken = D3_COMPATIBILITY_PINS.slice(1);
  const b = createShadowComparator({ compatibilityPins: broken });
  broken.unshift(D3_COMPATIBILITY_PINS[0]);
  b.compare(DIVERGING, CTX, 'denied');
  assert.deepEqual(b.records().map((m) => m.kind), ['candidate_invalid'], 'still invalid');
  let reads = 0;
  const watched = new Proxy([...D3_COMPATIBILITY_PINS], { get(t, k, r) { reads += 1; return Reflect.get(t, k, r); } });
  const w = createShadowComparator({ compatibilityPins: watched });
  const atCreation = reads;
  assert.ok(atCreation > 0, 'control: the table is read at creation');
  for (let i = 0; i < 5; i += 1) w.compare(DIVERGING, CTX, 'denied');
  assert.equal(reads, atCreation, 'compare() never reads the caller\'s table');
  assert.deepEqual(w.records(), []);
});

test('a context that cannot be read is contained and recorded as malformed, not as a divergence', () => {
  const c = createShadowComparator();
  // A context whose entitlement map throws on ANY access. The tuple is one whose evaluation actually
  // consults an entitlement — `returns` is plan-gated — so the trap would fire if the map were read
  // anywhere past the one guarded copy.
  const boom = (): never => { throw new Error('hostile entitlements'); };
  const hostileCtx = {
    limitation: 'none' as const,
    entitlements: new Proxy({}, {
      get: boom, has: boom, ownKeys: boom, getOwnPropertyDescriptor: boom, getPrototypeOf: boom,
    }) as Record<string, boolean>,
  };
  const t = tupleFor((x) => x.plane === 'tenant' && x.stratum === 'domain_threshold'
    && x.role === 'manager' && x.scope === 'returns' && x.action === 'require:approve');

  assert.equal(c.compare(t, hostileCtx, 'denied'), 'denied');
  assert.equal(c.compare(t, hostileCtx, 'granted'), 'granted');
  assert.equal(c.records().length, 2, 'both calls recorded');
  for (const m of c.records()) {
    assert.equal(m.kind, 'malformed_context', 'the throw was caught, not propagated');
    assert.equal(m.candidate, null);
  }

  // A context whose limitation answers differently on a second read is read once: `read_only` on
  // that read caps the owner's `full` to `view`, so the candidate agrees with a denial.
  let reads = 0;
  const shifting = { entitlements: CTX.entitlements, get limitation() { reads += 1; return reads === 1 ? 'read_only' : 'none'; } };
  const full = tupleFor((x) => x.plane === 'tenant' && x.stratum === 'domain_threshold'
    && x.role === 'store_owner' && x.scope === 'dashboard' && x.action === 'require:full');
  const d = createShadowComparator();
  assert.equal(d.compare(full, shifting as GrantEvaluationContext, 'denied'), 'denied');
  assert.equal(reads, 1, 'the context is read once');
  assert.equal(d.records().length, 0, 'agreement on the single read: no record');

  // A container that is not a record is read as the catalog reads it — it enables no gate — so the
  // candidate agrees with production and nothing is recorded.
  const dated = { entitlements: new Date(0), limitation: 'none' } as never;
  const e = createShadowComparator();
  assert.equal(e.compare(full, dated, evaluateBefore(full, dated)), evaluateBefore(full, dated));
  assert.deepEqual(e.records(), []);

  // For a platform tuple the tenant map is never touched — production never receives it either.
  const touched: string[] = [];
  const watched = new Proxy({}, {
    ownKeys(t) { touched.push('ownKeys'); return Reflect.ownKeys(t); },
    get(t, k, r) { touched.push(`get:${String(k)}`); return Reflect.get(t, k, r); },
  });
  const platform = tupleFor((x) => x.plane === 'platform');
  createShadowComparator().compare(platform, { entitlements: watched, limitation: 'none' } as never, 'denied');
  assert.deepEqual(touched, []);
  // Nor the context's entitlement field: a throwing getter there is not a malformed platform context.
  const poisoned = { get entitlements(): never { throw new Error('field read'); }, limitation: 'none' } as never;
  const p = createShadowComparator();
  assert.equal(p.compare(platform, poisoned, evaluateBefore(platform, poisoned)), evaluateBefore(platform, poisoned));
  assert.deepEqual(p.records(), []);
});

test('hostile getters on the tuple cannot throw out of compare or smuggle unvalidated values', () => {
  const throwing = Object.defineProperty({ ...DIVERGING }, 'role', { get() { throw new Error('boom'); } });
  let reads = 0;
  const shifting = Object.defineProperty({ ...DIVERGING }, 'role', {
    get() { reads += 1; return reads === 1 ? DIVERGING.role : 'victim@example.com'; },
  });
  const revoked = Proxy.revocable({}, {});
  revoked.revoke();
  for (const authoritative of ['granted', 'denied'] as const) {
    const c = createShadowComparator();
    // An unreadable tuple is not canonical, so it is denied whatever the caller said (R1).
    assert.equal(c.compare(throwing as CanonicalGrantTuple, CTX, authoritative), 'denied');
    assert.equal(c.compare(revoked.proxy as CanonicalGrantTuple, CTX, authoritative), 'denied');
    assert.deepEqual(c.records().map((m) => m.kind), ['malformed_tuple', 'malformed_tuple'],
      'an unreadable tuple is observed, not silently lost');
    reads = 0;
    assert.equal(c.compare(shifting as CanonicalGrantTuple, CTX, authoritative), authoritative);
    for (const m of c.records()) {
      assert.notEqual(m.role, 'victim@example.com', 'a second read never reaches a record');
    }
  }
  assert.equal(reads, 1, 'each tuple field is read exactly once');
});

test('hostile options cannot break construction or compare', () => {
  const throwingObserver = Object.defineProperty({}, 'observer', { get() { throw new Error('boom'); } });
  const throwingMax = Object.defineProperty({}, 'maxRecords', { get() { throw new Error('boom'); } });
  for (const options of [throwingObserver, throwingMax, { observer: 'not a function' }, { maxRecords: -1 }, { maxRecords: 1.5 }, null, 42]) {
    const c = createShadowComparator(options as never);
    assert.equal(c.compare(DIVERGING, CTX, 'granted'), 'granted');
    assert.equal(c.records().length, 1, 'defaults applied: the divergence is buffered');
    assert.equal(c.records()[0].kind, 'divergence', 'and the committed pins are read');
  }
  // Pin data that cannot be read is invalid pin data — never replaced by the committed pins — and one
  // unreadable option cannot cost another its value.
  const throwingPins = Object.defineProperty({}, 'compatibilityPins', { get() { throw new Error('boom'); } });
  const emptyPinsThrowingObserver = Object.defineProperty({ compatibilityPins: [] }, 'observer', { get() { throw new Error('boom'); } });
  for (const options of [throwingPins, emptyPinsThrowingObserver]) {
    const c = createShadowComparator(options as never);
    assert.equal(c.compare(DIVERGING, CTX, 'granted'), 'granted');
    assert.deepEqual(c.records().map((m) => m.kind), ['candidate_invalid']);
  }
});

// =============================================================================
// Structural containment — asserted against the module source
// =============================================================================

test('the candidate is evaluated at one call site, directly in compare(), outside any loop — and compare never re-enters', () => {
  // A structural claim, checked on the syntax tree rather than by counting text: exactly one call to
  // evaluatePinnedCandidate (the pinned candidate — and none to the pre-D2 or post-D2 one); its nearest
  // enclosing function is the `compare` method itself (not a
  // callback that could run many times); no loop sits between them; nothing in the module calls
  // compare. Together those bound it to at most one candidate evaluation per compare() call. (The
  // runtime count is not observed directly — the call is a static ESM binding — so the test claims
  // the structure, which is what makes the bound hold.) The no-network/no-console/no-clock census
  // for this module lives in tests/quality/gap11-grant-diff-artifact.test.mjs.
  const sf = ts.createSourceFile('gap11ShadowComparator.ts', SOURCE, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const candidateCalls: ts.CallExpression[] = [];
  const preRepinCalls: ts.CallExpression[] = [];
  const compareCalls: ts.CallExpression[] = [];
  let namesBefore = false;
  const visit = (n: ts.Node): void => {
    if (ts.isIdentifier(n) && n.text === 'evaluateBefore') namesBefore = true;
    if (ts.isCallExpression(n)) {
      if (ts.isIdentifier(n.expression) && n.expression.text === 'evaluatePinnedCandidate') candidateCalls.push(n);
      if (ts.isIdentifier(n.expression) && (n.expression.text === 'evaluateAfterCandidate'
        || n.expression.text === 'evaluateAfterRepinCandidate')) preRepinCalls.push(n);
      const callee = ts.isPropertyAccessExpression(n.expression) ? n.expression.name.text
        : ts.isIdentifier(n.expression) ? n.expression.text : '';
      if (callee === 'compare') compareCalls.push(n);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);

  assert.equal(candidateCalls.length, 1, 'exactly one call site');
  assert.equal(preRepinCalls.length, 0, 'the shadow never reads the pre-D2 or post-D2 candidate');
  assert.equal(compareCalls.length, 0, 'compare never calls itself');
  assert.equal(namesBefore, false, 'the comparator never evaluates the authoritative policy — that would be the duplicate evaluation');

  let node: ts.Node = candidateCalls[0].parent;
  while (!ts.isFunctionLike(node)) {
    assert.ok(!ts.isIterationStatement(node, false), 'no loop encloses the call');
    node = node.parent;
  }
  assert.ok(ts.isMethodDeclaration(node) && node.name.getText(sf) === 'compare',
    'the nearest enclosing function is compare() itself, not a callback');
});

test('the comparator imports only the inert diff module and a type — nothing that can decide', () => {
  const specifiers = [...SOURCE.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]).sort();
  assert.deepEqual(specifiers, ['./authorizationConstants', './gap11GrantDiff']);
  assert.ok(!/permissionCatalog|permissionDecision|protectedAction|authorizationResolver|sessionAuthorizationService/.test(SOURCE),
    'the comparator never reaches a production authorization entry point');
});
