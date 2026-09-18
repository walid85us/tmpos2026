#!/usr/bin/env tsx
// Phase 4.0 M5 — generator for the GAP-11 effective-grant diff artifact (04 §3 safeguard #2).
//
// Writes docs/phase-4/evidence/gap11-ordering-flip-grant-diff.md from the canonical universe. The
// artifact is GENERATED, never hand-assembled, so it cannot drift from the catalog it describes and
// cannot be edited into saying something the code does not.
//
// DETERMINISM IS THE POINT. Same catalog in, byte-identical file out: no timestamp, no hostname, no
// absolute path, no run id, no locale-sensitive sort, no iteration over an unsorted map. Anything
// that varied run to run would make "the artifact is stale" undetectable, and a staleness test that
// can never pass is the same as no staleness test.
//
// TWO CLASSIFICATIONS, NEVER ONE (M5-GAP11-P1-R1). The structural question — which tuples the ordering
// flip moves, and whether a tuple's decisive level is `approve` — is kept apart from D2's question:
// which tuples represent an operation an authoritative document identifies as an approve-gated money
// action. A level is never evidence of money, so no structural count is presented as a count of D2 rows.
//
// FOUR VIEWS, FIVE SECTIONS (M5-GAP11-P3). The owner decided D2 (an explicit per-role grant for every
// approval-gated money action) and D3 (reject all thirteen changes the unified ordering makes, keeping
// each tuple's authoritative answer), and the candidate carries both. Every tuple is therefore shown
// four ways — the shipped authority, the unified ordering before D2, after D2's grants, and after D3's
// compatibility pins — in sections 1 to 4, and section 5 is the final net diff, which must be empty.
// The generator REFUSES to render a non-empty final diff, or authoritative answers, an unresolved
// mapping or a money-action count that moved from the P2 baseline: the artifact records D3's
// conditional approval, and it must never say so over a change that breaks the condition.
//
// Usage:
//   tsx scripts/generate-gap11-grant-diff.ts            write the artifact
//   tsx scripts/generate-gap11-grant-diff.ts --check    exit 1 if the committed artifact is stale
//
// READ-ONLY WITH RESPECT TO EVERYTHING ELSE: no database, no network, no secret, no environment
// variable. It reads the inert catalog and writes exactly one file under docs/.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  auditCompatibilityPins,
  auditExplicitMoneyGrants,
  computeGrantDiff,
  computePinnedGrantDiff,
  computeRepinnedGrantDiff,
  evaluateAfterCandidate,
  evaluateAfterRepinCandidate,
  evaluateBefore,
  evaluatePinnedCandidate,
  explicitMoneyGrantFor,
  heldLevelFor,
  normalizedAuthorizationInputs,
  CANONICAL_DIFF_CONTEXT,
  CANONICAL_GRANT_UNIVERSE,
  FULLY_ENTITLED,
  UNIFIED_CANDIDATE_ORDERING,
  D2_EXPLICIT_MONEY_ACTION_GRANTS,
  D2_MONEY_ACTIONS,
  D2_NAMED_GRANT_ONLY_ACTIONS,
  D2_UNMAPPED_PAYMENT_OPERATIONS,
  D3_COMPATIBILITY_PINS,
  type CanonicalGrantTuple,
  type D2Classification,
  type D2MoneyAction,
  type GrantDiff,
  type GrantDiffRow,
  type GrantEvaluationContext,
  type GrantOutcome,
} from '../server/platform-identity/gap11GrantDiff';
import {
  TENANT_ORDERING,
  PLATFORM_ORDERING,
  TENANT_SUB_PERMISSIONS,
  PLATFORM_SUB_PERMISSIONS,
  TENANT_ROLE_SUBPERMISSION_DEFAULTS,
  TENANT_ROLE_PERMISSION_DEFAULTS,
} from '../server/platform-identity/permissionCatalog';

/**
 * Which tenant sub-permissions each non-owner role leaves to the default-by-level path — derived from
 * the catalog, not asserted, because the artifact's central structural finding rests on it.
 * `store_owner` has no explicit map at all: it short-circuits after plan gating.
 */
function explicitGrantCoverage(): { total: number; roles: readonly { role: string; defaulted: readonly string[] }[] } {
  const maps = TENANT_ROLE_SUBPERMISSION_DEFAULTS as unknown as Record<string, Record<string, boolean>>;
  return {
    total: TENANT_SUB_PERMISSIONS.length,
    roles: Object.keys(maps).sort().map((role) => ({
      role,
      defaulted: TENANT_SUB_PERMISSIONS.filter((s) => maps[role][s.id] === undefined)
        .map((s) => `\`${s.id}\` (default \`${s.defaultLevel}\`)`),
    })),
  };
}

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = join(HERE, '..');
export const ARTIFACT_RELATIVE_PATH = 'docs/phase-4/evidence/gap11-ordering-flip-grant-diff.md';

/** The P2 artifact whose thirteen net changes the owner rejected as D3 — a historical reference, not an input. */
const D3_REJECTED_ARTIFACT_SHA256 = 'f49ca74baf0d46a628bdcc066b95aade8f0f4ff92ef8eef20c5c8e7e394bd7c0';

/**
 * The baselines D3's condition is measured against, captured from the M5-GAP11-P2 entry bytes and
 * written here, not re-derived — so "unchanged" in the artifact is a comparison that can fail, and the
 * generator refuses to render when it does:
 *   - every authoritative answer, every tuple, in four contexts (full and empty entitlements, each
 *     with and without the read-only limitation);
 *   - the set of the 188 unresolved tuples, by label, in universe order;
 *   - the number of money-action tuples.
 */
const D3_BASELINE = Object.freeze({
  authoritativeVector: '22d64b70ed5e7d3866a2f8166780043f28fdd0c31e64f5087120e9399100e8b6',
  unresolvedLabels: '0cc0a297ba975e5d8b400102c93995d45da812f224b0678872ffb713b6beebb0',
  unresolvedCount: 188,
  moneyActions: 17,
});

/** The authority's answer on every tuple in the four baseline contexts, as the baseline fingerprints it. */
function authoritativeVectorFingerprint(): string {
  const contexts: readonly GrantEvaluationContext[] = [
    CANONICAL_DIFF_CONTEXT, { entitlements: {}, limitation: 'none' },
    { entitlements: FULLY_ENTITLED, limitation: 'read_only' }, { entitlements: {}, limitation: 'read_only' },
  ];
  return sha256(contexts.map((c) => CANONICAL_GRANT_UNIVERSE
    .map((t) => (evaluateBefore(t, c) === 'granted' ? '1' : '0')).join('')).join('|'));
}

const sha256 = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');
const code = (s: string): string => `\`${s}\``;
const labelOf = (t: { plane: string; stratum: string; role: string; scope: string; action: string }): string =>
  `${t.plane}/${t.stratum}/${t.role}/${t.scope}/${t.action}`;

function table(header: readonly string[], rows: readonly (readonly string[])[]): string {
  const head = `| ${header.join(' | ')} |`;
  const rule = `| ${header.map(() => '---').join(' | ')} |`;
  const body = rows.map((r) => `| ${r.join(' | ')} |`);
  return [head, rule, ...body].join('\n');
}

function countTable(title: string, counts: Readonly<Record<string, number>>): string {
  const keys = Object.keys(counts).sort();
  if (keys.length === 0) return `**${title}:** none.\n`;
  return `**${title}**\n\n${table(['key', 'changed rows'], keys.map((k) => [code(k), String(counts[k])]))}\n`;
}

const STRATUM_LABEL = { sub_permission: 'named sub-permission', domain_threshold: 'domain-threshold decision' } as const;

function rowLine(r: GrantDiffRow): readonly string[] {
  return [
    code(r.role),
    code(r.scope),
    code(r.action),
    r.heldLevel === null ? '—' : code(r.heldLevel),
    r.requiredLevel === null ? '—' : code(r.requiredLevel),
    r.before,
    r.after,
    r.change,
    r.requiresApproveLevel ? 'yes' : 'no',
    code(r.d2Classification),
    code(`${r.plane}/${r.stratum}`),
  ];
}

/** A pinned-view answer as the artifact prints it. An invalid candidate is refused, never printed. */
function pinnedOutcome(t: CanonicalGrantTuple, ctx: GrantEvaluationContext): GrantOutcome {
  const v = evaluatePinnedCandidate(t, ctx);
  if (v === 'invalid') throw new Error('refusing to render: the D3 compatibility pins are invalid');
  return v;
}

/** The pin a tuple carries in the committed D3 table, or null. */
function pinFor(t: CanonicalGrantTuple): boolean | null {
  const p = D3_COMPATIBILITY_PINS.find((x) => labelOf(x) === labelOf(t));
  return p === undefined ? null : p.granted;
}

/** The four answers for one tuple: the authority, and the candidate before D2, after D2, after D3's pins. */
interface FourViews {
  readonly t: CanonicalGrantTuple;
  readonly authoritative: GrantOutcome;
  readonly preD2: GrantOutcome;
  readonly postD2: GrantOutcome;
  readonly pinned: GrantOutcome;
  readonly explicit: boolean | null;
  readonly pin: boolean | null;
}

function fourViews(t: CanonicalGrantTuple, ctx: GrantEvaluationContext): FourViews {
  return {
    t,
    authoritative: evaluateBefore(t, ctx),
    preD2: evaluateAfterCandidate(t, ctx),
    postD2: evaluateAfterRepinCandidate(t, ctx),
    pinned: pinnedOutcome(t, ctx),
    explicit: explicitMoneyGrantFor(D2_EXPLICIT_MONEY_ACTION_GRANTS, t),
    pin: pinFor(t),
  };
}

/** The universe's tuples for one representation — one per role on its plane, in universe order. */
function tuplesFor(rep: D2MoneyAction['representations'][number]): readonly CanonicalGrantTuple[] {
  return CANONICAL_GRANT_UNIVERSE.filter((t) =>
    t.plane === rep.plane && t.stratum === rep.stratum && t.scope === rep.scope && t.action === rep.action);
}

/** The level a tuple's classification rests on: a threshold's gate, a tenant sub's default, a platform sub's threshold. */
function decisiveLevel(t: CanonicalGrantTuple): string {
  if (t.requiredLevel !== null) return t.requiredLevel;
  if (t.plane === 'tenant') return TENANT_SUB_PERMISSIONS.find((s) => s.id === t.action)?.defaultLevel ?? '—';
  return PLATFORM_SUB_PERMISSIONS.find((s) => s.id === t.action)?.threshold ?? '—';
}

/** Where a tuple's D2 classification comes from: a quoted document for a money action, the catalog otherwise. */
function classificationSource(t: CanonicalGrantTuple): string {
  if (t.d2Classification === 'money_action') {
    const m = D2_MONEY_ACTIONS.find((x) => x.operation === t.moneyAction);
    return m === undefined ? '—' : m.sources.map((s) => code(s.path)).join(', ');
  }
  const level = code(decisiveLevel(t));
  return t.d2Classification === 'unresolved'
    ? `catalog: decisive level ${level}; no document names it a money action`
    : `catalog: decisive level ${level}, not \`approve\`; no document names it`;
}

/** Why a tuple the unified ordering moves ends where it does, in one line. */
function reasonFor(v: FourViews, held: string | null): string {
  const holds = held === null ? 'no level' : code(held);
  const gate = code(v.t.requiredLevel ?? '');
  const kept = `D3 pins it to ${code(String(v.pin))}, today's answer`;
  if (v.authoritative === 'denied' && v.preD2 === 'granted') {
    return `holds ${holds}; the unified ordering ranks \`manage\` above \`approve\`, so it would clear the ${gate} gate; not a money action, so D2 leaves it; ${kept}`;
  }
  if (v.authoritative === 'granted' && v.preD2 === 'denied') {
    return `holds ${holds}; the unified ordering ranks \`approve\` below \`manage\`, so it would stop clearing the ${gate} gate; not a money action, so D2 leaves it; ${kept}`;
  }
  return 'the candidate views disagree with each other';
}

/**
 * What the catalog cannot yet express about each identified operation, and how the D2 re-pin meets it.
 * Prose, keyed by the registry's operation id; the suite requires one entry per registered operation,
 * so a new money action cannot be rendered without saying what its representation leaves open.
 */
export const DATA_MODEL_NOTES: Readonly<Record<string, string>> = Object.freeze({
  refund_approval:
    'The catalog represents refund approval twice, and links the two only through `approve_refunds`\' '
    + 'default-by-level path (`refunds` at `approve`), which every canonical role\'s explicit catalog grant '
    + 'overrides. The client\'s supervisor refund authorization requires both: the `refunds` level at '
    + '`approve` and an `approve_refunds` entry that is absent or true. D2\'s explicit per-role grant is '
    + 'applied to BOTH representations, and today each role carries the same value on both, so in the '
    + 'candidate neither is decided by a level any more. The two still differ in one step the re-pin '
    + 'keeps: the threshold\'s comparison IS its grant step, so the explicit grant replaces it outright, '
    + 'while `approve_refunds` keeps its `refunds` minimum (`view`), read before the grant. With today\'s '
    + 'values both agree for every role in every context (the D2 suite checks it); a later value change '
    + 'should set both together, or a role holding `refunds` at `none` could pass the threshold while the '
    + 'sub-permission still refuses it. The refunds narrowing in section 4 is a third comparison on the '
    + 'same domain; it is not a documented money action, D2 does not decide it, and a D3 compatibility '
    + 'pin keeps its authoritative answer.',
  return_approval:
    'One representation: the `approve_return` sub-permission. Its minimum module level `manage` is a '
    + 'prerequisite, read BEFORE the grant step, and the re-pin keeps it there: it can still deny, never '
    + 'grant. A role holding `returns` at `approve` clears it today and would not under the unified '
    + 'ordering — no canonical role holds that level, which is why no row changes. The explicit grant '
    + 'replaces the per-role catalog grant and the default-by-level path together. The server catalog has '
    + 'only its four fixed tenant roles; a custom role created in the client\'s Employees screen stores '
    + 'only the sub-permissions an owner toggled, and has no D2 grant — under the re-pin it would be '
    + 'denied, where today the client\'s default path would decide.',
  platform_billing_approval:
    'Platform plane. That plane already ranks `approve` below `manage`, so the unified ordering cannot '
    + 'move it (0 platform rows change). Under the re-pin its threshold is replaced by the explicit grant; '
    + 'it has no platform prerequisite, and the read-only limitation still refuses it.',
});

function moneyActionSection(m: D2MoneyAction, ctx: GrantEvaluationContext): string {
  const lines: string[] = [];
  const reps = m.representations.map((rep) => {
    const rows = tuplesFor(rep).map((t) => ({ v: fourViews(t, ctx), held: heldLevelFor(t, ctx) }));
    return { rep, rows, moves: rows.some((r) => r.v.preD2 !== r.v.authoritative) };
  });

  lines.push(`#### ${code(m.operation)}`);
  lines.push('');
  lines.push('Authoritative source' + (m.sources.length === 1 ? ':' : 's:'));
  lines.push('');
  for (const s of m.sources) lines.push(`- ${code(s.path)} — "${s.quote}"`);
  lines.push('');
  lines.push(table(
    ['representation', 'kind', 'changes under the flip', 'decided after D2 by'],
    reps.map(({ rep, moves }) => [
      code(`${rep.plane}/${rep.scope}/${rep.action}`),
      STRATUM_LABEL[rep.stratum],
      moves ? '**yes**' : 'no',
      'its D2 explicit per-role grant',
    ]),
  ));
  lines.push('');
  lines.push(table(
    ['representation', 'role', 'holds', 'authoritative', 'pre-D2', 'explicit grant', 'post-D2', 'post-pins', 'preserved'],
    reps.flatMap(({ rep, rows }) => rows.map(({ v, held }) => [
      code(`${rep.scope}/${rep.action}`),
      code(v.t.role),
      held === null ? '—' : code(held),
      v.authoritative,
      v.preD2,
      v.explicit === null ? '—' : code(String(v.explicit)),
      v.postD2,
      v.pinned,
      v.postD2 === v.authoritative && v.pinned === v.authoritative ? 'yes' : '**NO**',
    ])),
  ));
  lines.push('');
  const note = Object.prototype.hasOwnProperty.call(DATA_MODEL_NOTES, m.operation) ? DATA_MODEL_NOTES[m.operation] : undefined;
  if (note === undefined) throw new Error(`no data-model note for money action ${m.operation}`);
  lines.push(`What the data model leaves open, and how the re-pin meets it: ${note}`);
  return lines.join('\n');
}

function universeClassCounts(): readonly (readonly string[])[] {
  const planes = ['tenant', 'platform'] as const;
  const strata = ['domain_threshold', 'sub_permission'] as const;
  const classes: readonly D2Classification[] = ['money_action', 'unresolved', 'not_money_action'];
  const rows: string[][] = [];
  for (const plane of planes) {
    for (const stratum of strata) {
      const ts = CANONICAL_GRANT_UNIVERSE.filter((t) => t.plane === plane && t.stratum === stratum);
      rows.push([
        code(`${plane}/${stratum}`),
        String(ts.length),
        String(ts.filter((t) => t.requiresApproveLevel).length),
        ...classes.map((c) => String(ts.filter((t) => t.d2Classification === c).length)),
      ]);
    }
  }
  const all = CANONICAL_GRANT_UNIVERSE;
  rows.push([
    '**total**',
    `**${all.length}**`,
    `**${all.filter((t) => t.requiresApproveLevel).length}**`,
    ...classes.map((c) => `**${all.filter((t) => t.d2Classification === c).length}**`),
  ]);
  return rows;
}

/** The authority's own answers in the artifact's context, by plane and stratum. */
function authorityCounts(ctx: GrantEvaluationContext): readonly (readonly string[])[] {
  const rows: string[][] = [];
  let granted = 0;
  for (const plane of ['tenant', 'platform'] as const) {
    for (const stratum of ['domain_threshold', 'sub_permission'] as const) {
      const ts = CANONICAL_GRANT_UNIVERSE.filter((t) => t.plane === plane && t.stratum === stratum);
      const g = ts.filter((t) => evaluateBefore(t, ctx) === 'granted').length;
      granted += g;
      rows.push([code(`${plane}/${stratum}`), String(ts.length), String(g), String(ts.length - g)]);
    }
  }
  const n = CANONICAL_GRANT_UNIVERSE.length;
  rows.push(['**total**', `**${n}**`, `**${granted}**`, `**${n - granted}**`]);
  return rows;
}

/** Distinct approve-level sub-permissions with no documented money mapping, by plane. */
function unresolvedSubPermissions(plane: 'tenant' | 'platform'): string {
  const ids = [...new Set(CANONICAL_GRANT_UNIVERSE
    .filter((t) => t.plane === plane && t.stratum === 'sub_permission' && t.d2Classification === 'unresolved')
    .map((t) => t.action))].sort();
  return ids.length === 0 ? 'none' : ids.map(code).join(', ');
}

/** For a tenant threshold row: the catalog sub-permissions whose default-by-level path IS this comparison. */
function defaultPathOf(r: { plane: string; stratum: string; scope: string; requiredLevel: string | null }): string {
  if (r.plane !== 'tenant' || r.stratum !== 'domain_threshold') return '—';
  const subs = TENANT_SUB_PERMISSIONS.filter((s) => s.parentDomain === r.scope && s.defaultLevel === r.requiredLevel);
  return subs.length === 0 ? '—' : subs.map((s) => code(s.id)).join(', ');
}

/**
 * Every unresolved tuple, grouped by what it gates (plane, stratum, scope, action) with the roles each
 * view grants — so all of them are pinned in the artifact, not only the ones that change.
 */
function unresolvedMappingRows(views: readonly FourViews[]): readonly (readonly string[])[] {
  const groups = new Map<string, FourViews[]>();
  for (const v of views) {
    const k = `${v.t.plane}/${v.t.stratum}/${v.t.scope}/${v.t.action}`;
    const g = groups.get(k);
    if (g === undefined) groups.set(k, [v]); else g.push(v);
  }
  const granted = (g: readonly FourViews[], pick: (v: FourViews) => GrantOutcome): string => {
    const roles = g.filter((v) => pick(v) === 'granted').map((v) => code(v.t.role));
    return roles.length === 0 ? 'none' : roles.join(', ');
  };
  const bold = (n: number): string => (n === 0 ? '0' : `**${n}**`);
  return [...groups.keys()].sort().map((k) => {
    const g = groups.get(k)!;
    return [
      code(`${g[0].t.plane}/${g[0].t.stratum}`), code(g[0].t.scope), code(g[0].t.action), String(g.length),
      granted(g, (v) => v.authoritative), granted(g, (v) => v.preD2), granted(g, (v) => v.postD2), granted(g, (v) => v.pinned),
      bold(g.filter((v) => v.preD2 !== v.authoritative).length),
      bold(g.filter((v) => v.pinned !== v.authoritative).length),
    ];
  });
}

export function renderArtifact(pre: GrantDiff, post: GrantDiff, pinned: GrantDiff, inputsFingerprint: string): string {
  const context = pre.context;
  if (context === null || post.context === null || pinned.context === null) {
    throw new Error('refusing to render a diff computed in a malformed context');
  }
  if (pre.view !== 'pre_repin' || post.view !== 'post_repin' || pinned.view !== 'post_pins') {
    throw new Error('refusing to render diffs of the wrong views');
  }
  const grantAudit = auditExplicitMoneyGrants(D2_EXPLICIT_MONEY_ACTION_GRANTS);
  if (!grantAudit.ok) throw new Error(`refusing to render with an unsound D2 grant table: ${grantAudit.problems.join('; ')}`);
  const pinAudit = auditCompatibilityPins(D3_COMPATIBILITY_PINS);
  if (!pinAudit.ok) throw new Error(`refusing to render with invalid D3 compatibility pins: ${pinAudit.problems.join('; ')}`);
  // D3's condition: the final diff is empty. The artifact records the owner's approval; it must never
  // say so over rows that break the condition.
  if (pinned.rows.length !== 0) {
    throw new Error(`refusing to render: the final diff is not empty, so D3's condition is not met — ${pinned.rows.map((r) => `${labelOf(r)} ${r.change}`).join('; ')}`);
  }
  const s = pre.summary;
  const p = post.summary;
  const f = pinned.summary;
  const widened = pre.rows.filter((r) => r.change === 'widened');
  const narrowed = pre.rows.filter((r) => r.change === 'narrowed');
  const unresolvedRows = pre.rows.filter((r) => r.d2Classification === 'unresolved');
  const subPlane = pre.rows.filter((r) => r.stratum === 'sub_permission');
  const platformPlane = pre.rows.filter((r) => r.plane === 'platform');
  const coverage = explicitGrantCoverage();
  const moneyTuples = CANONICAL_GRANT_UNIVERSE.filter((t) => t.d2Classification === 'money_action');
  const moneyViews = moneyTuples.map((t) => fourViews(t, context));
  const unresolvedTuples = CANONICAL_GRANT_UNIVERSE.filter((t) => t.d2Classification === 'unresolved');
  const unresolvedViews = unresolvedTuples.map((t) => fourViews(t, context));
  const pinViews = CANONICAL_GRANT_UNIVERSE.filter((t) => pinFor(t) !== null).map((t) => fourViews(t, context));
  const moneyPreserved = moneyViews.filter((v) => v.postD2 === v.authoritative && v.pinned === v.authoritative).length;
  const pinsPreserved = pinViews.filter((v) => v.pinned === v.authoritative).length;
  const d2Moves = CANONICAL_GRANT_UNIVERSE.filter((t) =>
    evaluateAfterCandidate(t, context) !== evaluateAfterRepinCandidate(t, context)).length;
  const pinMoves = CANONICAL_GRANT_UNIVERSE.filter((t) =>
    evaluateAfterRepinCandidate(t, context) !== pinnedOutcome(t, context)).length;
  const authoritativeVector = CANONICAL_GRANT_UNIVERSE.map((t) => (evaluateBefore(t, context) === 'granted' ? '1' : '0')).join('');
  // D3's other conditions, each compared with its P2 baseline: the authority's own answers, the
  // unresolved mapping and the money-action count. The approval must never be rendered over a change.
  const authorityFingerprint = authoritativeVectorFingerprint();
  const unresolvedFingerprint = sha256(unresolvedTuples.map(labelOf).join('\n'));
  if (authorityFingerprint !== D3_BASELINE.authoritativeVector) {
    throw new Error(`refusing to render: the authoritative answers moved from the P2 baseline (${authorityFingerprint})`);
  }
  if (unresolvedFingerprint !== D3_BASELINE.unresolvedLabels || unresolvedTuples.length !== D3_BASELINE.unresolvedCount) {
    throw new Error(`refusing to render: the unresolved mapping moved from the P2 baseline (${unresolvedTuples.length} tuples, ${unresolvedFingerprint})`);
  }
  if (moneyTuples.length !== D3_BASELINE.moneyActions) {
    throw new Error(`refusing to render: ${moneyTuples.length} money-action tuples, not the ${D3_BASELINE.moneyActions} D2 decided`);
  }

  // The pins are exactly the thirteen rows D3 rejected — the post-D2 diff, row for row, in universe order.
  if (pinViews.map((v) => labelOf(v.t)).join('\n') !== post.rows.map(labelOf).join('\n')) {
    throw new Error('refusing to render: the D3 pins are not exactly the post-D2 diff\'s rows');
  }

  // The refunds narrowing, read from the catalog rather than restated.
  const managerRefunds = (TENANT_ROLE_PERMISSION_DEFAULTS as Record<string, Record<string, string>>).manager.refunds;
  const refundSubs = TENANT_SUB_PERMISSIONS.filter((x) => x.parentDomain === 'refunds')
    .map((x) => `${code(x.id)} (minimum ${code(x.minModuleLevel)}, default ${code(x.defaultLevel)})`).join(', ');
  const refundNarrowing = narrowed.find((r) => r.role === 'manager' && r.scope === 'refunds');
  if (refundNarrowing === undefined || narrowed.length !== 1) {
    throw new Error('the refunds narrowing this artifact explains is not the diff\'s only narrowing');
  }
  const refundPin = pinViews.find((v) => labelOf(v.t) === labelOf(refundNarrowing));
  // Section 4 describes the rejected changes in words; refuse to render words the rows do not support.
  const netWidened = post.rows.filter((r) => r.change === 'widened');
  const netNarrowed = post.rows.filter((r) => r.change === 'narrowed');
  if (!netWidened.every((r) => r.d2Classification === 'unresolved')
    || !netNarrowed.every((r) => r.d2Classification === 'not_money_action')
    || netNarrowed.length !== 1 || labelOf(netNarrowed[0]) !== labelOf(refundNarrowing) || refundPin === undefined) {
    throw new Error('section 4\'s description no longer matches the post-D2 rows');
  }
  const managerWidened = netWidened.filter((r) => r.role === 'manager').length;
  const otherWidened = netWidened.filter((r) => r.role !== 'manager')
    .map((r) => `the ${r.role} on ${code(r.scope)}`).join(', ');

  const rowsTable = (rs: readonly GrantDiffRow[]): string =>
    rs.length === 0
      ? '_No rows._\n'
      : `${table(
          ['role', 'scope', 'action', 'holds', 'gate', 'before', 'after', 'change', 'approve level', 'D2 classification', 'plane/stratum'],
          rs.map(rowLine),
        )}\n`;

  const outcomesOf = (v: FourViews): Record<string, unknown> => ({
    tuple: labelOf(v.t), authoritative: v.authoritative, preD2: v.preD2, postD2: v.postD2, pinned: v.pinned,
  });
  const moneyOutcomes = moneyViews.map((v) => ({ ...outcomesOf(v), explicit: v.explicit }));
  const unresolvedOutcomes = unresolvedViews.map(outcomesOf);
  const pinOutcomes = pinViews.map((v) => ({ ...outcomesOf(v), pin: v.pin, d2Classification: v.t.d2Classification }));

  return `# GAP-11 — ordering-flip effective-grant diff

> **Generated file. Do not edit by hand.**
> Produced by \`scripts/generate-gap11-grant-diff.ts\` from the inert permission catalog.
> Regenerate with \`tsx scripts/generate-gap11-grant-diff.ts\`; \`--check\` fails when it is stale.

This is **safeguard #2** of the six that [docs/phase-4/04 §3](../04-canonical-iam-and-four-user-migration.md#3-permission-level-reconciliation-required--gap-11)
binds to the GAP-11 ordering unification: a before/after effective-grant diff for every canonical
\`(role, scope, action)\` tuple, so that no silent change ships.

It decides nothing. Safeguard **#1** (the per-action re-pin of \`approve\`-gated money actions) is
owner decision **D2**, made: an approval-gated money action requires an explicit per-role grant
(section 3). Safeguard **#3** (explicit approval of the diff) is owner decision **D3**, made: the owner
rejected all thirteen changes the unified ordering makes, and each keeps its authoritative answer
through a compatibility pin (section 4). Section 5 is the final net diff; D3's approval holds only while
it is empty, and it is. All of this is in the candidate only: production is not re-pinned and
nothing is cut over. GAP-11 is **not** closed.

## How to read this artifact

### Four views of every tuple

${table(
  ['view', 'what it is'],
  [
    ['**authoritative** (BEFORE)', 'What ships today: the production materializers in `server/platform-identity/permissionCatalog.ts`, called directly. Section 1.'],
    ['**pre-D2** (AFTER-CANDIDATE)', 'The unified ordering alone — an independent implementation with its own rank table. Section 2 is the diff against it: the structural ordering changes.'],
    ['**post-D2** (AFTER-D2)', 'The unified ordering with D2\'s explicit money-action grants. Section 3; its diff is the thirteen changes D3 rejected.'],
    ['**post-pins** (AFTER-PINS)', 'The post-D2 candidate with D3\'s thirteen compatibility pins — the evaluator a cutover would install. Section 4; section 5 is the diff against it: the final net change, which must be empty.'],
  ],
)}

### Two classifications, kept apart

Every tuple carries two separate classifications, and no count below mixes them:

${table(
  ['classification', 'values', 'what it means'],
  [
    ['**approve level** (structural)', 'yes / no', 'The tuple\'s decisive required level is `approve`: a threshold tuple\'s level, a platform sub-permission\'s threshold, or a tenant sub-permission\'s default level. It is the level the flip moves. It says nothing about money.'],
    ['**D2 classification**', '`money_action`', 'The tuple represents an operation an authoritative document identifies as an approve-gated money action (section 3, with the source quoted). Only these are D2 rows, and only these carry an explicit grant.'],
    ['', '`unresolved`', 'The tuple requires the `approve` level, but no authoritative document ties it to a money action (section 4). It is not re-pinned by D2 and not counted as a D2 row; where the unified ordering would change its answer, a D3 compatibility pin keeps the authoritative one without reclassifying it.'],
    ['', '`not_money_action`', 'Neither: the decisive level is not `approve`, so the tuple cannot be an approve-gated action, and no document names it as one.'],
  ],
)}

A level, a domain name, a widening, or the role that holds it is never taken as evidence of money.

## 1. Current authoritative result

### Orderings compared

${table(
  ['ordering', 'sequence', 'role in this diff'],
  [
    ['tenant (\`TENANT_ORDERING\`)', code(TENANT_ORDERING.join(' < ')), 'the BEFORE authority for the tenant plane'],
    ['platform (\`PLATFORM_ORDERING\`)', code(PLATFORM_ORDERING.join(' < ')), 'the BEFORE authority for the platform plane'],
    ['unified candidate', code(UNIFIED_CANDIDATE_ORDERING.join(' < ')), 'the ordering of every candidate view, on both planes'],
  ],
)}

**BEFORE** is the behaviour that ships today, obtained by calling the production materializers in
\`server/platform-identity/permissionCatalog.ts\` — it is the authority itself, not a copy of it.
Every candidate view is an independent implementation carrying its own rank table, so a single defect
cannot make both sides agree and report a falsely empty diff. The platform plane already uses the
unified ordering, so every platform tuple must come out identical under both; that is the positive
control proving the candidate is not simply broken. Both sides deny any level, role, scope or action
outside the catalog (safeguard #4).

### Evaluation context

${table(
  ['field', 'value'],
  [
    ['entitlements', `every known tenant entitlement enabled (${Object.keys(context.entitlements).length} keys)`],
    ['limitation', code(context.limitation)],
  ],
)}

This is the **maximal-grant** context, chosen deliberately: plan gating can only force a domain to
\`none\` and the read-only cap can only force a level to \`view\`, and neither \`none\` nor \`view\`
straddles the \`manage\`/\`approve\` boundary. No other context can therefore produce a change this
one does not contain. The suites check that argument rather than trusting it, across the full, empty,
alias-keyed, every-one-off and every-one-on entitlement sets, each with and without the read-only cap,
for every candidate view — and the pinned view equals the authority in every one of them.

### Universe

${table(
  ['stratum', 'tuples'],
  [
    ['tenant sub-permissions (roles × actions)', `${pre.shape.tenantRoles} × ${pre.shape.tenantSubPermissions} = ${pre.shape.tenantSubTuples}`],
    ['tenant domain thresholds (roles × domains × levels)', `${pre.shape.tenantRoles} × ${pre.shape.tenantDomains} × ${pre.shape.levels} = ${pre.shape.tenantThresholdTuples}`],
    ['platform sub-permissions (roles × actions)', `${pre.shape.platformRoles} × ${pre.shape.platformSubPermissions} = ${pre.shape.platformSubTuples}`],
    ['platform feature thresholds (roles × features × levels)', `${pre.shape.platformRoles} × ${pre.shape.platformFeatures} × ${pre.shape.levels} = ${pre.shape.platformThresholdTuples}`],
    ['**total**', `**${pre.shape.total}**`],
  ],
)}

Both strata are enumerated on purpose. The ordering flip is a statement about **level comparison**,
so a diff listing only named sub-permissions would miss every threshold check and could report "no
grants changed" while the real exposure sat untouched beside it — which is exactly what happens here.

### Every tuple, by classification

${table(
  ['plane/stratum', 'tuples', 'approve level', '`money_action`', '`unresolved`', '`not_money_action`'],
  universeClassCounts(),
)}

### The authority's answers

${table(
  ['plane/stratum', 'tuples', 'granted', 'denied'],
  authorityCounts(context),
)}

Every answer in this table is the reference every candidate view is compared against; its tuple-by-tuple
fingerprint is listed at the end.

## 2. Unified-order candidate before D2 — the structural ordering diff

### What changed, in one line

The unified ordering moves exactly two comparisons, and nothing else:

${table(
  ['comparison', 'today (tenant ordering)', 'unified candidate', 'effect'],
  [
    ['holds \`manage\`, gate \`approve\`', 'denied', 'granted', '**widens**'],
    ['holds \`approve\`, gate \`manage\`', 'granted', 'denied', '**narrows**'],
  ],
)}

Every other pair of levels keeps its truth value, because only \`manage\` and \`approve\` swap rank.
That is why the changed set below is small and completely enumerable rather than a sample.

### Summary

${table(
  ['measure', 'count'],
  [
    ['tuples evaluated', String(s.evaluated)],
    ['unchanged', String(s.unchanged)],
    ['**widened**', `**${s.widened}**`],
    ['**narrowed**', `**${s.narrowed}**`],
    ['changed rows whose decisive level is \`approve\` (structural)', String(s.requiresApproveLevel)],
    ['changed in the sub-permission stratum', String(subPlane.length)],
    ['changed on the platform plane', String(platformPlane.length)],
  ],
)}

**Changed rows by D2 classification** — a separate count, not a subset of the structural one above:

${table(
  ['D2 classification', 'changed rows'],
  (['money_action', 'unresolved', 'not_money_action'] as const).map((c) => [code(c), String(s.byD2Classification[c])]),
)}

${countTable('Changed rows by role', s.byRole)}
${countTable('Changed rows by scope', s.byScope)}
${countTable('Changed rows by action', s.byAction)}

### Every changed row

#### Widened — a \`manage\` holder newly clears an \`approve\` gate (${widened.length})

${rowsTable(widened)}
#### Narrowed — an \`approve\` holder stops clearing a \`manage\` gate (${narrowed.length})

${rowsTable(narrowed)}
### Structural findings

1. **The named sub-permissions do not move** (${subPlane.length} changed rows in that stratum). Each
   non-owner tenant role carries an **explicit boolean grant** for every sub-permission whose default
   level is \`approve\` — \`approve_refunds\`, \`approve_return\`, \`approve_inventory\`,
   \`approve_requests\` — and an explicit grant is consulted *before* the default-by-level path the
   ordering flip would move. \`store_owner\` has no explicit map: it short-circuits after plan gating,
   which the ordering does not touch. What each non-owner role still leaves to the default-by-level
   path, of ${coverage.total} sub-permissions, derived from the catalog:
${coverage.roles.map((r) => `   - ${code(r.role)}: ${r.defaulted.length === 0 ? 'none' : r.defaulted.join(', ')}`).join('\n')}

   None of those defaults is \`approve\`, and none sits on a \`manage\`/\`approve\` boundary a role
   straddles, which is why they do not move either.
2. **The exposure is entirely at the domain-threshold layer** — wherever a role's *level* on a
   domain is compared against a required level: the client engine's \`checkPermission(domain, level)\`
   and its supervisor refund authorization (both in \`src/context/AccessContext.tsx\`), and the DEV
   control plane's \`requireTenantPermission\` (\`server/platform-identity/permissionDecision.ts\`).
   The M5 canonical route catalog (\`m5CanonicalPermissions.ts\`) is *not* on this layer: it admits
   only named sub-permissions, which is the stratum that does not move. This diff enumerates the
   changed *decisions*; it does not claim that any particular call site consults one of them today.
3. **The client's per-domain level list is not an authorization control.** \`PERMISSION_DOMAINS[].levels\`
   in \`src/context/accessConfig.ts\` (which for example offers no \`manage\` on \`refunds\` and no
   \`approve\` on \`shipping\`) is a UI allow-list only. Nothing server-side mirrors or enforces it, so a
   stored role level outside it lands directly on the \`manage\`/\`approve\` boundary this diff is about.
   This diff therefore evaluates every level on every domain, not only the ones the UI offers.

## 3. Candidate after the 17 D2 money-action grants

### Owner decision D2

1. Every \`money_action\` tuple requires an explicit per-role grant, and only \`true\` can allow it.
2. \`false\`, a missing entry, a malformed value or an unknown entry denies. The table is closed — one
   entry per money-action tuple, nothing else — and a table that does not audit clean honors no grant.
3. No level (\`approve\`, \`manage\`, \`full\`) and no ordering comparison grants a money action by
   itself: the explicit grant replaces exactly the step that confers the grant — a threshold tuple's
   level comparison; for a tenant sub-permission the owner short-circuit, the per-role catalog grant and
   the default-by-level path; for a platform sub-permission its threshold.
4. The grant is necessary, never sufficient. Every other step keeps its place and can only deny: the
   plan gates, a non-owner's parent-module minimum, platform prerequisites, and the read-only
   limitation. Identity, scope, session and route constraints are enforced outside this model and are
   unchanged.
5. Each value below equals the tuple's authoritative answer today. No new business entitlement is
   created, and changing a value is a new owner policy decision.

The grants live in \`D2_EXPLICIT_MONEY_ACTION_GRANTS\` (\`server/platform-identity/gap11GrantDiff.ts\`),
which no production module imports; the post-D2 and post-pins views read them, the authority never does.

### The identified money actions

These are the only tuples D2 governs. Each operation below is identified as an approve-gated money
action by the quoted source, and listed with every canonical representation the catalog gives it.
${moneyTuples.length} of the universe's ${CANONICAL_GRANT_UNIVERSE.length} tuples are such
representations. **${s.byD2Classification.money_action} of them change** under the unified ordering
alone, **${p.byD2Classification.money_action} change** after D2's grants, and
**${f.byD2Classification.money_action} change** after D3's pins: all ${moneyTuples.length} keep their
authoritative answer (${moneyPreserved} of ${moneyTuples.length} preserved).

${D2_MONEY_ACTIONS.map((m) => moneyActionSection(m, context)).join('\n\n')}

**What this means.** On every documented money action, for every canonical role, no candidate view
changes the answer: the manager already holds \`refunds\` at \`approve\`, every non-owner tenant role
holds explicit catalog grants for \`approve_refunds\` and \`approve_return\` that are read before the
default-by-level path, no canonical role holds the \`approve\` level that \`approve_return\`'s \`manage\`
minimum would stop admitting, and D2's explicit grants carry exactly today's answers. 04 §3's warning
that the manager "would silently gain approval capability it did not have" does not materialize on
these operations for the catalog's roles; the structural widening sits on the \`unresolved\` rows,
which D2 does not re-pin and D3 pins (section 4).

### The seventeen explicit grants

${table(
  ['plane/stratum', 'role', 'scope', 'action', 'explicit grant', 'authoritative', 'pre-D2', 'post-D2', 'post-pins', 'preserved'],
  moneyViews.map((v) => [
    code(`${v.t.plane}/${v.t.stratum}`), code(v.t.role), code(v.t.scope), code(v.t.action),
    v.explicit === null ? '—' : code(String(v.explicit)),
    v.authoritative, v.preD2, v.postD2, v.pinned,
    v.postD2 === v.authoritative && v.pinned === v.authoritative ? 'yes' : '**NO**',
  ]),
)}

**Preserved: ${moneyPreserved} of ${moneyTuples.length}** in this context, after D2 and after D3's pins alike —
no pin names a money action. The D2 suite checks the same in every entitlement and limitation context
the matrix sweeps, and proves the controls: a missing, \`false\`, malformed, duplicated or unknown grant
denies; an \`approve\`, \`manage\` or \`full\` holder is denied without its grant; and a grant still cannot
pass a disabled plan gate, the read-only limitation, the \`manage\` minimum of \`approve_return\`, or
another tuple's scope.

### Counts after D2

${table(
  ['compared against the authority', 'evaluated', 'unchanged', 'widened', 'narrowed'],
  [
    ['post-D2 candidate (the flip with D2\'s grants)', String(p.evaluated), String(p.unchanged), String(p.widened), String(p.narrowed)],
  ],
)}

D2's grants move ${d2Moves} answers: the ${post.rows.length} rows left are the structural ones of section 2, none a
money action — the thirteen changes D3 rejected.

## 4. Candidate after the 13 D3 compatibility pins

### Owner decision D3

1. The owner rejected all ${post.rows.length} net changes the P2 artifact listed (sha256
   \`${D3_REJECTED_ARTIFACT_SHA256}\`): the ${p.widened} widenings and the ${p.narrowed}
   narrowing.
2. Each keeps its current authoritative answer: the ${managerWidened} \`manager\` widenings${otherWidened === '' ? '' : ` and ${otherWidened}`} stay
   **denied**, and the \`manager\`'s \`refunds\` \`manage\` gate stays **allowed**.
3. These are **ordering-compatibility pins**, not money-action classifications and not a rule: every
   pinned tuple keeps its D2 classification, no role level, ordering or D2 grant changes, and no other
   tuple is affected. None of them generalizes to another unresolved mapping.
4. A pin replaces only the pinned threshold's level comparison. The plan gate still zeroes the domain
   and the read-only cap still refuses any gate \`view\` does not clear, so the one allowing pin agrees
   with the authority in every context, not only this one.
5. The table is closed. It must match, entry for entry, the rows the unified ordering changes that D2
   does not decide, each with its authoritative value. A missing, duplicate, malformed, unexpected or
   changed pin makes the candidate **invalid**: it then has no answers at all, never the unified
   ordering's widened or narrowed one, the shadow comparator records it as \`candidate_invalid\`, and
   this generator refuses to render.

The pins live in \`D3_COMPATIBILITY_PINS\` (\`server/platform-identity/gap11GrantDiff.ts\`), which no
production module imports; only the post-pins view reads them.

### The thirteen compatibility pins

${table(
  ['role', 'scope', 'action', 'D2 classification', 'holds', 'authoritative', 'pre-D2', 'post-D2', 'pin', 'post-pins', 'preserved', 'classification source', 'reason'],
  pinViews.map((v) => {
    const held = heldLevelFor(v.t, context);
    return [
      code(v.t.role), code(v.t.scope), code(v.t.action), code(v.t.d2Classification),
      held === null ? '—' : code(held),
      v.authoritative, v.preD2, v.postD2,
      v.pin === null ? '—' : code(String(v.pin)),
      v.pinned,
      v.pinned === v.authoritative ? 'yes' : '**NO**',
      classificationSource(v.t),
      reasonFor(v, held),
    ];
  }),
)}

**Preserved: ${pinsPreserved} of ${pinViews.length}.** The D3 suite checks each pin in every swept context,
that each moves exactly its own tuple, and that a removed, duplicated, corrupted, changed or added pin
is refused.

### The \`manager\` / \`refunds\` narrowing

${table(
  ['question', 'answer'],
  [
    ['level held', `${code('manager')} holds ${code(managerRefunds)} on ${code('refunds')} (role default)`],
    ['level required', `${code(refundNarrowing.requiredLevel ?? '')} — the tuple ${code(`refunds/${refundNarrowing.action}`)}`],
    ['BEFORE', `**${refundNarrowing.before}** — the tenant ordering ranks \`approve\` (5) above \`manage\` (4), so an \`approve\` holder clears a \`manage\` gate`],
    ['AFTER-CANDIDATE', `**${refundNarrowing.after}** — the unified ordering ranks \`approve\` (4) below \`manage\` (5), so it no longer does`],
    ['AFTER-D2', `**${refundPin.postD2}** — D2 does not touch it: the tuple is not a money action, so it keeps the unified ordering's rule`],
    ['AFTER-PINS', `**${refundPin.pinned}** — D3 pins it to ${code(String(refundPin.pin))}, today's answer`],
    ['a real refund money action?', `**No — a domain-threshold decision only** (D2 classification ${code(refundNarrowing.d2Classification)}). Refund approval is documented as \`refunds: approve\` / \`approve_refunds\` (section 3); nothing documents \`refunds\` at \`manage\`. No catalog sub-permission uses that comparison — ${refundSubs} — and the client offers no \`manage\` level on \`refunds\` at all.`],
    ['does D2 affect it?', '**No.** D2 was decided as an explicit per-role grant, applied to both refund-approval representations (`refunds/require:approve` and `approve_refunds`), not as a "`≥ manage`" domain-level gate. So this comparison is not the manager\'s refund-approval check: the manager\'s refund approval is decided by its explicit grants, which are `true` and preserved.'],
    ['what D3 decided', 'The narrowing is rejected: a compatibility pin keeps the `approve` holder clearing the `manage` gate on `refunds`, exactly as today. It stays `not_money_action`.'],
  ],
)}

### Unresolved mapping

These tuples require the \`approve\` level but **no authoritative document ties them to a money
action**. They are structural facts, not D2 rows: D2's explicit grants do not apply to them. No
document is taken to classify them here, and D3's pins do not classify them either — the ${unresolvedRows.length}
the ordering would move keep their authoritative answers and stay \`unresolved\`.

#### Rows the ordering would move (${unresolvedRows.length})

${unresolvedRows.length === 0 ? '_No rows._' : table(
  ['role', 'scope', 'action', 'holds', 'gate', 'authoritative', 'pre-D2', 'post-D2', 'post-pins', 'default-by-level path of', 'why unresolved'],
  unresolvedRows.map((r) => {
    const v = pinViews.find((x) => labelOf(x.t) === labelOf(r));
    return [
      code(r.role), code(r.scope), code(r.action),
      r.heldLevel === null ? '—' : code(r.heldLevel),
      r.requiredLevel === null ? '—' : code(r.requiredLevel),
      r.before, r.after,
      v === undefined ? '—' : v.postD2,
      v === undefined ? '—' : v.pinned,
      defaultPathOf(r),
      r.stratum === 'domain_threshold'
        ? 'a bare domain threshold names no action; no document identifies this domain at `approve` as a money action'
        : 'no document identifies this sub-permission as a money action',
    ];
  }),
)}

The rows with an entry in "default-by-level path of" are the comparisons those sub-permissions would
make for a role without an explicit grant: ${unresolvedRows.map(defaultPathOf).filter((x) => x !== '—').join(', ')}.
Every canonical non-owner role holds an explicit grant for each of them, so none is reached today. The
link is structural, from the catalog; it does not make a threshold row a representation of the
sub-permission, and only \`approve_return\` among them is a documented money action (section 3).

Approve-level sub-permissions with no documented money mapping: tenant — ${unresolvedSubPermissions('tenant')};
platform — ${unresolvedSubPermissions('platform')}. None of them changes under the flip.

Named-grant-only capabilities 04 §2 folds into the §3 re-pin safeguard: ${D2_NAMED_GRANT_ONLY_ACTIONS.map(code).join(', ')}.
04 §2.1 classes them as provider configuration, separate from payment operations, and no document calls
them money actions. 04 §2.1 also names payment-operation permissions — ${D2_UNMAPPED_PAYMENT_OPERATIONS.map(code).join(', ')} —
without a level and without calling them approve-gated. None of either list is in the catalog; should
one be added, its tuples classify \`unresolved\`.

#### All ${unresolvedViews.length} unresolved mappings

Every unresolved tuple, grouped by what it gates. Each "granted" column lists the roles that view
allows; every other role of the plane is denied. "moved by the ordering" counts the roles whose pre-D2
answer differs from the authoritative one; "changes after pins" counts those whose post-pins answer
does — the final behaviour.

${table(
  ['plane/stratum', 'scope', 'action', 'roles', 'granted — authoritative', 'granted — pre-D2', 'granted — post-D2', 'granted — post-pins', 'moved by the ordering', 'changes after pins'],
  unresolvedMappingRows(unresolvedViews),
)}

### Counts after the pins

${table(
  ['compared against the authority', 'evaluated', 'unchanged', 'widened', 'narrowed'],
  [
    ['post-pins candidate (the flip with D2\'s grants and D3\'s pins)', String(f.evaluated), String(f.unchanged), String(f.widened), String(f.narrowed)],
  ],
)}

## 5. Final net behavioral diff

### Counts in each view

${table(
  ['compared against the authority', 'evaluated', 'unchanged', 'widened', 'narrowed'],
  [
    ['pre-D2 candidate (the ordering flip alone)', String(s.evaluated), String(s.unchanged), String(s.widened), String(s.narrowed)],
    ['post-D2 candidate (the flip with D2\'s grants)', String(p.evaluated), String(p.unchanged), String(p.widened), String(p.narrowed)],
    ['**post-pins candidate — final** (the flip with D2\'s grants and D3\'s pins)', `**${f.evaluated}**`, `**${f.unchanged}**`, `**${f.widened}**`, `**${f.narrowed}**`],
  ],
)}

### Kinds of change, kept apart

${table(
  ['kind', 'tuples', 'what it is'],
  [
    ['**structural ordering changes** — authority vs pre-D2', `${pre.rows.length} (${s.widened} widened, ${s.narrowed} narrowed)`, 'the comparisons the unified ordering moves (section 2); none is a money action'],
    ['**explicit-grant representation changes** — how a tuple is decided', `${moneyTuples.length}`, `the money-action tuples decided by a D2 explicit grant instead of a level; ${f.byD2Classification.money_action} of them change their answer`],
    ['**compatibility-pin representation changes** — how a tuple is decided', `${pinViews.length}`, `the tuples decided by a D3 pin instead of the unified ordering's comparison; ${pinViews.length - pinsPreserved} of them change their answer`],
    ['**D2 effect** — pre-D2 vs post-D2', String(d2Moves), 'answers D2\'s grants move'],
    ['**pin effect** — post-D2 vs post-pins', String(pinMoves), 'answers D3\'s pins move — each back to the authority'],
    ['**net effective authorization changes** — authority vs post-pins', `${pinned.rows.length} (${f.widened} widened, ${f.narrowed} narrowed)`, 'what a cutover would change'],
  ],
)}

${table(
  ['check D3\'s approval requires', 'result'],
  [
    ['tuples evaluated', String(f.evaluated)],
    ['unchanged', String(f.unchanged)],
    ['widened', String(f.widened)],
    ['narrowed', String(f.narrowed)],
    ['money-action outcomes unchanged', `${moneyPreserved} of ${moneyTuples.length} (the ${D3_BASELINE.moneyActions} D2 decided)`],
    ['unresolved classifications unchanged', `${unresolvedTuples.length} of ${D3_BASELINE.unresolvedCount} still \`unresolved\` — the same set as the P2 baseline (\`${D3_BASELINE.unresolvedLabels.slice(0, 8)}…\`)`],
    ['authoritative behaviour', `unchanged — every answer, every tuple, in four contexts matches the P2 baseline (\`${D3_BASELINE.authoritativeVector.slice(0, 8)}…\`)`],
  ],
)}

### The exact final changed-row set

${pinned.rows.length === 0 ? '_None._ No tuple answers differently from the authority in the final candidate.' : rowsTable(pinned.rows)}

## The D3 decision

**D3 is approved by the owner, conditionally**, for this exact artifact: computed from the inputs whose
fingerprint is the first below, with the final diff whose rows and summary are fingerprinted after it (a
file cannot carry its own hash; docs/phase-4/09 records this one's). The condition is zero behavioural
difference: ${f.evaluated} tuples evaluated, ${f.unchanged} unchanged,
${f.widened} widened, ${f.narrowed} narrowed, all ${moneyTuples.length} money-action outcomes and all
${unresolvedTuples.length} unresolved classifications unchanged. Any change that makes the final diff
non-empty voids the approval: this generator refuses to render such a diff, and a changed artifact is a
new question for the owner, not a refresh.

Approval is not a cutover. Production authorization is unchanged and uncut, the cutover stays a
separate decision nobody has authorized, and GAP-11 stays open. D1 and D4 remain undecided.

## Fingerprints

${table(
  ['input', 'sha256'],
  [
    ['normalized authorization inputs', code(inputsFingerprint)],
    ['authoritative answers, every tuple, in universe order', code(sha256(authoritativeVector))],
    ['authoritative answers, every tuple, four contexts — equal to the P2 baseline', code(authorityFingerprint)],
    ['unresolved tuples, by label — equal to the P2 baseline', code(unresolvedFingerprint)],
    ['pre-D2 diff rows (canonical serialization)', code(sha256(JSON.stringify(pre.rows)))],
    ['pre-D2 summary', code(sha256(JSON.stringify(pre.summary)))],
    ['post-D2 diff rows — the thirteen D3 rejected', code(sha256(JSON.stringify(post.rows)))],
    ['post-D2 summary', code(sha256(JSON.stringify(post.summary)))],
    ['final (post-pins) diff rows — empty, as D3 requires', code(sha256(JSON.stringify(pinned.rows)))],
    ['final (post-pins) summary', code(sha256(JSON.stringify(pinned.summary)))],
    ['money-action outcomes, all four views', code(sha256(JSON.stringify(moneyOutcomes)))],
    ['unresolved mappings, all four views', code(sha256(JSON.stringify(unresolvedOutcomes)))],
    ['D3 compatibility pins and their outcomes, all four views', code(sha256(JSON.stringify(pinOutcomes)))],
  ],
)}

The first fingerprint covers every catalog input this diff reads — orderings, roles, domains,
features, actions, thresholds, role defaults, explicit grants, entitlement gates and dependencies —
the D2 inputs (the money-action registry with its quoted sources, the named-grant-only list, and the
explicit money-action grants) and D3's compatibility pins, serialized with sorted keys at every level.
If it changes, this artifact is stale and the repository test fails.
`;
}

export function buildArtifact(): string {
  const pre = computeGrantDiff(CANONICAL_DIFF_CONTEXT);
  const post = computeRepinnedGrantDiff(CANONICAL_DIFF_CONTEXT);
  const pinned = computePinnedGrantDiff(CANONICAL_DIFF_CONTEXT);
  return renderArtifact(pre, post, pinned, sha256(normalizedAuthorizationInputs()));
}

function main(argv: readonly string[]): number {
  const target = join(REPO_ROOT, ARTIFACT_RELATIVE_PATH);
  const rendered = buildArtifact();
  if (argv.includes('--check')) {
    if (!existsSync(target)) {
      process.stdout.write(`STALE: ${ARTIFACT_RELATIVE_PATH} does not exist\n`);
      return 1;
    }
    const committed = readFileSync(target, 'utf8');
    if (committed !== rendered) {
      process.stdout.write(`STALE: ${ARTIFACT_RELATIVE_PATH} does not match the catalog\n`);
      return 1;
    }
    process.stdout.write(`current: ${ARTIFACT_RELATIVE_PATH}\n`);
    return 0;
  }
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, rendered, 'utf8');
  process.stdout.write(`wrote: ${ARTIFACT_RELATIVE_PATH}\n`);
  return 0;
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(main(process.argv.slice(2)));
}
