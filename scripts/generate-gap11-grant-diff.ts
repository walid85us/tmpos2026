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
// TWO CLASSIFICATIONS, NEVER ONE (M5-GAP11-P1-R1). Section A is the STRUCTURAL diff: which tuples the
// ordering flip moves, and whether a tuple's decisive level is `approve`. Section B is D2's question:
// which tuples represent an operation an authoritative document identifies as an approve-gated money
// action. Section C lists the approve-level rows no document ties to one. A level is never evidence of
// money, so no count in A is presented as a count of D2 rows.
//
// THREE VIEWS (M5-GAP11-P2). The owner decided D2 — an explicit per-role grant for every approval-gated
// money action — and the candidate carries it. Every tuple is therefore shown three ways: the shipped
// authority, the unified ordering before the re-pin, and the unified ordering after it. Section D is
// the re-pin itself; section E is the final diff D3 approves, with each kind of change kept apart.
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
  auditExplicitMoneyGrants,
  computeGrantDiff,
  computeRepinnedGrantDiff,
  evaluateAfterCandidate,
  evaluateAfterRepinCandidate,
  evaluateBefore,
  explicitMoneyGrantFor,
  heldLevelFor,
  normalizedAuthorizationInputs,
  CANONICAL_DIFF_CONTEXT,
  CANONICAL_GRANT_UNIVERSE,
  UNIFIED_CANDIDATE_ORDERING,
  D2_EXPLICIT_MONEY_ACTION_GRANTS,
  D2_MONEY_ACTIONS,
  D2_NAMED_GRANT_ONLY_ACTIONS,
  D2_UNMAPPED_PAYMENT_OPERATIONS,
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

/** The three answers for one tuple: the shipped authority, and the candidate before and after the re-pin. */
interface ThreeViews {
  readonly t: CanonicalGrantTuple;
  readonly authoritative: GrantOutcome;
  readonly preRepin: GrantOutcome;
  readonly postRepin: GrantOutcome;
  readonly explicit: boolean | null;
}

function threeViews(t: CanonicalGrantTuple, ctx: GrantEvaluationContext): ThreeViews {
  return {
    t,
    authoritative: evaluateBefore(t, ctx),
    preRepin: evaluateAfterCandidate(t, ctx),
    postRepin: evaluateAfterRepinCandidate(t, ctx),
    explicit: explicitMoneyGrantFor(D2_EXPLICIT_MONEY_ACTION_GRANTS, t),
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

/** Why a changed tuple's answers differ, in one line. */
function reasonFor(v: ThreeViews, held: string | null): string {
  if (v.t.d2Classification === 'money_action' && v.postRepin !== v.authoritative) {
    return `the D2 explicit grant is ${v.explicit === null ? 'missing or unsound' : code(String(v.explicit))}, `
      + `the authority says ${v.authoritative}`;
  }
  const holds = held === null ? 'no level' : code(held);
  if (v.authoritative === 'denied' && v.preRepin === 'granted') {
    return `holds ${holds}; the unified ordering ranks \`manage\` above \`approve\`, so it now clears the ${code(v.t.requiredLevel ?? '')} gate; not a money action, so the re-pin leaves it`;
  }
  if (v.authoritative === 'granted' && v.preRepin === 'denied') {
    return `holds ${holds}; the unified ordering ranks \`approve\` below \`manage\`, so it no longer clears the ${code(v.t.requiredLevel ?? '')} gate; not a money action, so the re-pin leaves it`;
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
    + 'sub-permission still refuses it. The refunds narrowing below is a third comparison on the same '
    + 'domain; it is not a documented money action and is not re-pinned.',
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
    const rows = tuplesFor(rep).map((t) => ({ v: threeViews(t, ctx), held: heldLevelFor(t, ctx) }));
    return { rep, rows, moves: rows.some((r) => r.v.preRepin !== r.v.authoritative) };
  });

  lines.push(`#### ${code(m.operation)}`);
  lines.push('');
  lines.push('Authoritative source' + (m.sources.length === 1 ? ':' : 's:'));
  lines.push('');
  for (const s of m.sources) lines.push(`- ${code(s.path)} — "${s.quote}"`);
  lines.push('');
  lines.push(table(
    ['representation', 'kind', 'changes under the flip', 'decided after the re-pin by'],
    reps.map(({ rep, moves }) => [
      code(`${rep.plane}/${rep.scope}/${rep.action}`),
      STRATUM_LABEL[rep.stratum],
      moves ? '**yes**' : 'no',
      'its D2 explicit per-role grant',
    ]),
  ));
  lines.push('');
  lines.push(table(
    ['representation', 'role', 'holds', 'authoritative', 'pre-re-pin', 'explicit grant', 'post-re-pin', 'preserved'],
    reps.flatMap(({ rep, rows }) => rows.map(({ v, held }) => [
      code(`${rep.scope}/${rep.action}`),
      code(v.t.role),
      held === null ? '—' : code(held),
      v.authoritative,
      v.preRepin,
      v.explicit === null ? '—' : code(String(v.explicit)),
      v.postRepin,
      v.postRepin === v.authoritative ? 'yes' : '**NO**',
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
function unresolvedMappingRows(views: readonly ThreeViews[]): readonly (readonly string[])[] {
  const groups = new Map<string, ThreeViews[]>();
  for (const v of views) {
    const k = `${v.t.plane}/${v.t.stratum}/${v.t.scope}/${v.t.action}`;
    const g = groups.get(k);
    if (g === undefined) groups.set(k, [v]); else g.push(v);
  }
  const granted = (g: readonly ThreeViews[], pick: (v: ThreeViews) => GrantOutcome): string => {
    const roles = g.filter((v) => pick(v) === 'granted').map((v) => code(v.t.role));
    return roles.length === 0 ? 'none' : roles.join(', ');
  };
  return [...groups.keys()].sort().map((k) => {
    const g = groups.get(k)!;
    const changes = g.filter((v) => v.postRepin !== v.authoritative).length;
    return [
      code(`${g[0].t.plane}/${g[0].t.stratum}`), code(g[0].t.scope), code(g[0].t.action), String(g.length),
      granted(g, (v) => v.authoritative), granted(g, (v) => v.preRepin), granted(g, (v) => v.postRepin),
      changes === 0 ? '0' : `**${changes}**`,
    ];
  });
}

export function renderArtifact(pre: GrantDiff, post: GrantDiff, inputsFingerprint: string): string {
  const context = pre.context;
  if (context === null || post.context === null) throw new Error('refusing to render a diff computed in a malformed context');
  if (pre.view !== 'pre_repin' || post.view !== 'post_repin') throw new Error('refusing to render diffs of the wrong views');
  const audit = auditExplicitMoneyGrants(D2_EXPLICIT_MONEY_ACTION_GRANTS);
  if (!audit.ok) throw new Error(`refusing to render with an unsound D2 grant table: ${audit.problems.join('; ')}`);
  const s = pre.summary;
  const p = post.summary;
  const widened = pre.rows.filter((r) => r.change === 'widened');
  const narrowed = pre.rows.filter((r) => r.change === 'narrowed');
  const unresolvedRows = pre.rows.filter((r) => r.d2Classification === 'unresolved');
  const subPlane = pre.rows.filter((r) => r.stratum === 'sub_permission');
  const platformPlane = pre.rows.filter((r) => r.plane === 'platform');
  const coverage = explicitGrantCoverage();
  const moneyTuples = CANONICAL_GRANT_UNIVERSE.filter((t) => t.d2Classification === 'money_action');
  const moneyViews = moneyTuples.map((t) => threeViews(t, context));
  const unresolvedViews = CANONICAL_GRANT_UNIVERSE.filter((t) => t.d2Classification === 'unresolved').map((t) => threeViews(t, context));
  const preserved = moneyViews.filter((v) => v.postRepin === v.authoritative).length;
  const repinMoves = CANONICAL_GRANT_UNIVERSE.filter((t) =>
    evaluateAfterCandidate(t, context) !== evaluateAfterRepinCandidate(t, context)).length;
  const byGrant = post.rows.filter((r) => r.decidedBy === 'explicit_grant');

  // Every tuple either candidate view moves, in universe order, with all three answers.
  const changedKeys = new Set([...pre.rows, ...post.rows].map(labelOf));
  const changed = CANONICAL_GRANT_UNIVERSE.filter((t) => changedKeys.has(labelOf(t))).map((t) => threeViews(t, context));

  // The refunds narrowing, read from the catalog rather than restated.
  const managerRefunds = (TENANT_ROLE_PERMISSION_DEFAULTS as Record<string, Record<string, string>>).manager.refunds;
  const refundSubs = TENANT_SUB_PERMISSIONS.filter((x) => x.parentDomain === 'refunds')
    .map((x) => `${code(x.id)} (minimum ${code(x.minModuleLevel)}, default ${code(x.defaultLevel)})`).join(', ');
  const refundNarrowing = narrowed.find((r) => r.role === 'manager' && r.scope === 'refunds');
  if (refundNarrowing === undefined || narrowed.length !== 1) {
    throw new Error('the refunds narrowing this artifact explains is not the diff\'s only narrowing');
  }
  const narrowingAfterRepin = post.rows.find((r) => labelOf(r) === labelOf(refundNarrowing));
  // The D3 section describes the net change in words; refuse to render words the rows do not support.
  const netWidened = post.rows.filter((r) => r.change === 'widened');
  const netNarrowed = post.rows.filter((r) => r.change === 'narrowed');
  if (!netWidened.every((r) => r.d2Classification === 'unresolved')
    || !netNarrowed.every((r) => r.d2Classification === 'not_money_action')
    || netNarrowed.length !== 1 || labelOf(netNarrowed[0]) !== labelOf(refundNarrowing)) {
    throw new Error('the D3 section\'s description no longer matches the post-re-pin rows');
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

  const moneyOutcomes = moneyViews.map((v) => ({
    tuple: labelOf(v.t), explicit: v.explicit, authoritative: v.authoritative, preRepin: v.preRepin, postRepin: v.postRepin,
  }));
  const unresolvedOutcomes = unresolvedViews.map((v) => ({
    tuple: labelOf(v.t), authoritative: v.authoritative, preRepin: v.preRepin, postRepin: v.postRepin,
  }));

  return `# GAP-11 — ordering-flip effective-grant diff

> **Generated file. Do not edit by hand.**
> Produced by \`scripts/generate-gap11-grant-diff.ts\` from the inert permission catalog.
> Regenerate with \`tsx scripts/generate-gap11-grant-diff.ts\`; \`--check\` fails when it is stale.

This is **safeguard #2** of the six that [docs/phase-4/04 §3](../04-canonical-iam-and-four-user-migration.md#3-permission-level-reconciliation-required--gap-11)
binds to the GAP-11 ordering unification: a before/after effective-grant diff for every canonical
\`(role, scope, action)\` tuple, so that no silent change ships.

It decides nothing. Safeguard **#1** (the per-action re-pin of \`approve\`-gated money actions) is
owner decision **D2**, now made: an approval-gated money action requires an explicit per-role grant.
The candidate carries that re-pin (section D) — in the candidate only: production is not re-pinned and
nothing is cut over. Safeguard **#3** (explicit approval of this diff) is owner decision **D3**, still
open; section E is the diff it approves. GAP-11 is **not** closed.

## How to read this diff

### Three views of every tuple

${table(
  ['view', 'what it is'],
  [
    ['**authoritative** (BEFORE)', 'What ships today: the production materializers in `server/platform-identity/permissionCatalog.ts`, called directly.'],
    ['**pre-re-pin** (AFTER-CANDIDATE)', 'The unified ordering alone — an independent implementation with its own rank table. Section A is the diff against it: the structural ordering changes.'],
    ['**post-re-pin** (AFTER-REPIN)', 'The unified ordering with D2\'s explicit money-action grants — the evaluator a cutover would install. Section E is the diff against it: the net effective change D3 approves.'],
  ],
)}

### Two classifications, kept apart

Every tuple carries two separate classifications, and no count below mixes them:

${table(
  ['classification', 'values', 'what it means'],
  [
    ['**approve level** (structural)', 'yes / no', 'The tuple\'s decisive required level is `approve`: a threshold tuple\'s level, a platform sub-permission\'s threshold, or a tenant sub-permission\'s default level. It is the level the flip moves. It says nothing about money.'],
    ['**D2 classification**', '`money_action`', 'The tuple represents an operation an authoritative document identifies as an approve-gated money action (section B, with the source quoted). Only these are D2 rows, and only these carry an explicit grant (section D).'],
    ['', '`unresolved`', 'The tuple requires the `approve` level, but no authoritative document ties it to a money action (section C). It keeps the unified ordering\'s rules; it is not re-pinned and not counted as a D2 row.'],
    ['', '`not_money_action`', 'Neither: the decisive level is not `approve`, so the tuple cannot be an approve-gated action, and no document names it as one.'],
  ],
)}

A level, a domain name, a widening, or the role that holds it is never taken as evidence of money.

## A. Structural ordering diff

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

### Orderings compared

${table(
  ['ordering', 'sequence', 'role in this diff'],
  [
    ['tenant (\`TENANT_ORDERING\`)', code(TENANT_ORDERING.join(' < ')), 'the BEFORE authority for the tenant plane'],
    ['platform (\`PLATFORM_ORDERING\`)', code(PLATFORM_ORDERING.join(' < ')), 'the BEFORE authority for the platform plane'],
    ['unified candidate', code(UNIFIED_CANDIDATE_ORDERING.join(' < ')), 'the AFTER-CANDIDATE for both planes'],
  ],
)}

**BEFORE** is the behaviour that ships today, obtained by calling the production materializers in
\`server/platform-identity/permissionCatalog.ts\` — it is the authority itself, not a copy of it.
**AFTER-CANDIDATE** is an independent implementation carrying its own rank table, so a single defect
cannot make both agree and report a falsely empty diff. The platform plane already uses the unified
ordering, so every platform tuple must come out identical under both; that is the positive control
proving the candidate is not simply broken. Both deny any level, role, scope or action outside the
catalog (safeguard #4), so they differ only in the ordering.

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
one does not contain. The authorization-matrix suite checks that argument rather than trusting it,
across the full, empty, every-one-off and every-one-on entitlement sets, each with and without the
read-only cap, for both candidate views.

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

## B. Authoritatively identified money actions (D2)

These are the only tuples D2 governs. Each operation below is identified as an approve-gated money
action by the quoted source, and listed with every canonical representation the catalog gives it.
${moneyTuples.length} of the universe's ${CANONICAL_GRANT_UNIVERSE.length} tuples are such
representations. **${s.byD2Classification.money_action} of them change** under the unified ordering
alone, and **${p.byD2Classification.money_action} change** after the D2 re-pin: all
${moneyTuples.length} keep their authoritative answer (${preserved} of ${moneyTuples.length} preserved).

${D2_MONEY_ACTIONS.map((m) => moneyActionSection(m, context)).join('\n\n')}

**What this means.** On every documented money action, for every canonical role, neither candidate
view changes the answer: the manager already holds \`refunds\` at \`approve\`, every non-owner tenant
role holds explicit catalog grants for \`approve_refunds\` and \`approve_return\` that are read before the
default-by-level path, no canonical role holds the \`approve\` level that \`approve_return\`'s \`manage\`
minimum would stop admitting, and D2's explicit grants carry exactly today's answers. 04 §3's warning
that the manager "would silently gain approval capability it did not have" does not materialize on
these operations for the catalog's roles; the structural widening sits on the \`unresolved\` rows of
section C, which D2 does not re-pin.

## C. Unresolved mapping

These rows require the \`approve\` level but **no authoritative document ties them to a money
action**. They are structural facts, not D2 rows: D2's explicit grants do not apply to them, and they
keep the unified ordering's rules in the post-re-pin view. No document is taken to classify them here.

### Changed rows (${unresolvedRows.length})

${unresolvedRows.length === 0 ? '_No rows._' : table(
  ['role', 'scope', 'action', 'holds', 'gate', 'before', 'after', 'default-by-level path of', 'why unresolved'],
  unresolvedRows.map((r) => [
    code(r.role), code(r.scope), code(r.action),
    r.heldLevel === null ? '—' : code(r.heldLevel),
    r.requiredLevel === null ? '—' : code(r.requiredLevel),
    r.before, r.after,
    defaultPathOf(r),
    r.stratum === 'domain_threshold'
      ? 'a bare domain threshold names no action; no document identifies this domain at `approve` as a money action'
      : 'no document identifies this sub-permission as a money action',
  ]),
)}

The rows with an entry in "default-by-level path of" are the comparisons those sub-permissions would
make for a role without an explicit grant: ${unresolvedRows.map(defaultPathOf).filter((x) => x !== '—').join(', ')}.
Every canonical non-owner role holds an explicit grant for each of them, so none is reached today. The
link is structural, from the catalog; it does not make a threshold row a representation of the
sub-permission, and only \`approve_return\` among them is a documented money action (section B).

### Every tuple, by classification

${table(
  ['plane/stratum', 'tuples', 'approve level', '`money_action`', '`unresolved`', '`not_money_action`'],
  universeClassCounts(),
)}

Approve-level sub-permissions with no documented money mapping: tenant — ${unresolvedSubPermissions('tenant')};
platform — ${unresolvedSubPermissions('platform')}. None of them changes under the flip.

Named-grant-only capabilities 04 §2 folds into the §3 re-pin safeguard: ${D2_NAMED_GRANT_ONLY_ACTIONS.map(code).join(', ')}.
04 §2.1 classes them as provider configuration, separate from payment operations, and no document calls
them money actions. 04 §2.1 also names payment-operation permissions — ${D2_UNMAPPED_PAYMENT_OPERATIONS.map(code).join(', ')} —
without a level and without calling them approve-gated. None of either list is in the catalog; should
one be added, its tuples classify \`unresolved\`.

### All ${unresolvedViews.length} unresolved mappings

Every unresolved tuple, grouped by what it gates. Each "granted" column lists the roles that view
allows; every other role of the plane is denied. "changes" counts the roles whose post-re-pin answer
differs from the authoritative one.

${table(
  ['plane/stratum', 'scope', 'action', 'roles', 'granted — authoritative', 'granted — pre-re-pin', 'granted — post-re-pin', 'changes'],
  unresolvedMappingRows(unresolvedViews),
)}

## D. The D2 re-pin — explicit money-action grants (candidate only)

Owner decision D2, as the candidate implements it:

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
which no production module imports; the post-re-pin view reads them, the authority never does.

${table(
  ['plane/stratum', 'role', 'scope', 'action', 'explicit grant', 'authoritative', 'pre-re-pin', 'post-re-pin', 'preserved'],
  moneyViews.map((v) => [
    code(`${v.t.plane}/${v.t.stratum}`), code(v.t.role), code(v.t.scope), code(v.t.action),
    v.explicit === null ? '—' : code(String(v.explicit)),
    v.authoritative, v.preRepin, v.postRepin,
    v.postRepin === v.authoritative ? 'yes' : '**NO**',
  ]),
)}

**Preserved: ${preserved} of ${moneyTuples.length}** in this context. The D2 suite checks the same in every
entitlement and limitation context the matrix sweeps, and proves the controls: a missing, \`false\`,
malformed, duplicated or unknown grant denies; an \`approve\`, \`manage\` or \`full\` holder is denied
without its grant; and a grant still cannot pass a disabled plan gate, the read-only limitation, the
\`manage\` minimum of \`approve_return\`, or another tuple's scope.

## E. The final diff for D3

### Counts in each view

${table(
  ['compared against the authority', 'evaluated', 'unchanged', 'widened', 'narrowed'],
  [
    ['pre-re-pin candidate (the ordering flip alone)', String(s.evaluated), String(s.unchanged), String(s.widened), String(s.narrowed)],
    ['post-re-pin candidate (the flip with D2\'s grants)', String(p.evaluated), String(p.unchanged), String(p.widened), String(p.narrowed)],
  ],
)}

### Four kinds of change, kept apart

${table(
  ['kind', 'tuples', 'what it is'],
  [
    ['**structural ordering changes** — authority vs pre-re-pin', `${pre.rows.length} (${s.widened} widened, ${s.narrowed} narrowed)`, 'the comparisons the unified ordering moves (section A); none is a money action'],
    ['**explicit-grant representation changes** — how a tuple is decided', `${moneyTuples.length}`, `the money-action tuples now decided by a D2 explicit grant instead of a level; ${p.byD2Classification.money_action} of them change their answer`],
    ['**re-pin effect** — pre-re-pin vs post-re-pin', String(repinMoves), 'tuples whose answer the re-pin itself moves'],
    ['**net effective authorization changes** — authority vs post-re-pin', `${post.rows.length} (${p.widened} widened, ${p.narrowed} narrowed; ${byGrant.length} decided by an explicit grant)`, 'what a cutover would change, and what D3 approves'],
  ],
)}

${table(
  ['intended or still unapproved', 'tuples', 'status'],
  [
    ['intended — decided by the owner', String(moneyTuples.length), 'the money-action answers, preserved by D2\'s explicit grants'],
    ['**still unapproved**', String(post.rows.length), '**the net effective changes below — awaiting D3**'],
  ],
)}

### Every changed tuple

${changed.length === 0 ? '_No rows._' : table(
  ['scope', 'role', 'domain', 'action', 'D2 classification', 'authoritative', 'pre-re-pin', 'post-re-pin', 'explicit grant', 'classification source', 'reason'],
  changed.map((v) => [
    code(v.t.plane), code(v.t.role), code(v.t.scope), code(v.t.action), code(v.t.d2Classification),
    v.authoritative, v.preRepin, v.postRepin,
    v.explicit === null ? '—' : code(String(v.explicit)),
    classificationSource(v.t),
    reasonFor(v, heldLevelFor(v.t, context)),
  ]),
)}

## The \`manager\` / \`refunds\` narrowing

${table(
  ['question', 'answer'],
  [
    ['level held', `${code('manager')} holds ${code(managerRefunds)} on ${code('refunds')} (role default)`],
    ['level required', `${code(refundNarrowing.requiredLevel ?? '')} — the tuple ${code(`refunds/${refundNarrowing.action}`)}`],
    ['BEFORE', `**${refundNarrowing.before}** — the tenant ordering ranks \`approve\` (5) above \`manage\` (4), so an \`approve\` holder clears a \`manage\` gate`],
    ['AFTER-CANDIDATE', `**${refundNarrowing.after}** — the unified ordering ranks \`approve\` (4) below \`manage\` (5), so it no longer does`],
    ['AFTER-REPIN', `**${narrowingAfterRepin === undefined ? refundNarrowing.before : narrowingAfterRepin.after}** — the re-pin does not touch it: the tuple is not a money action, so it keeps the unified ordering's rule`],
    ['a real refund money action?', `**No — a domain-threshold decision only** (D2 classification ${code(refundNarrowing.d2Classification)}). Refund approval is documented as \`refunds: approve\` / \`approve_refunds\` (section B); nothing documents \`refunds\` at \`manage\`. No catalog sub-permission uses that comparison — ${refundSubs} — and the client offers no \`manage\` level on \`refunds\` at all.`],
    ['does D2 affect it?', '**No.** D2 was decided as an explicit per-role grant, applied to both refund-approval representations (`refunds/require:approve` and `approve_refunds`), not as a "`≥ manage`" domain-level gate. So this comparison is not the manager\'s refund-approval check: the manager\'s refund approval is decided by its explicit grants, which are `true` and preserved.'],
    ['what remains for D3', 'Approval of this row, as of every changed row: accepting that under the unified ordering an `approve` holder no longer clears a `manage` gate on `refunds`.'],
  ],
)}

## The D3 decision

D2 is decided and is not asked again. What is open is **D3**: the owner's explicit approval of the net
effective change in section E — ${post.rows.length} rows, identified exactly by the post-re-pin row
fingerprint below. The owner can:

- **Approve** the diff as listed. That accepts, for a future cutover: the manager newly clearing an
  \`approve\` gate on ${managerWidened} domains${otherWidened === '' ? '' : ` and ${otherWidened}`} (the ${p.widened} widened
  rows, all \`unresolved\`); the manager no longer clearing the \`manage\` gate on \`refunds\` (the
  ${p.narrowed} narrowed row, \`not_money_action\`); and the ${moneyTuples.length} money actions decided by the explicit grants in section D,
  each with today's answer. Approval does not cut anything over: the cutover stays a separate step.
- **Reject** some or all rows. Each rejected row then needs its own re-pin — an explicit per-role
  value or a changed role level — before any cutover, and each such re-pin is a new decision.
- **Revise** and approve again. Changing an explicit grant value, re-pinning an \`unresolved\` row,
  or changing a role's level regenerates this artifact with a new fingerprint; D3 then approves that
  fingerprint instead. An \`unresolved\` row becomes a money action only if an authoritative document
  says so.

## Fingerprints

${table(
  ['input', 'sha256'],
  [
    ['normalized authorization inputs', code(inputsFingerprint)],
    ['diff rows (canonical serialization)', code(sha256(JSON.stringify(pre.rows)))],
    ['summary (canonical serialization)', code(sha256(JSON.stringify(pre.summary)))],
    ['post-re-pin diff rows — the diff D3 approves', code(sha256(JSON.stringify(post.rows)))],
    ['post-re-pin summary', code(sha256(JSON.stringify(post.summary)))],
    ['money-action outcomes, all three views', code(sha256(JSON.stringify(moneyOutcomes)))],
    ['unresolved mappings, all three views', code(sha256(JSON.stringify(unresolvedOutcomes)))],
  ],
)}

The first fingerprint covers every catalog input this diff reads — orderings, roles, domains,
features, actions, thresholds, role defaults, explicit grants, entitlement gates and dependencies —
and the D2 inputs (the money-action registry with its quoted sources, the named-grant-only list, and
the explicit money-action grants), serialized with sorted keys at every level. If it changes, this
artifact is stale and the repository test fails.
`;
}

export function buildArtifact(): string {
  const pre = computeGrantDiff(CANONICAL_DIFF_CONTEXT);
  const post = computeRepinnedGrantDiff(CANONICAL_DIFF_CONTEXT);
  return renderArtifact(pre, post, sha256(normalizedAuthorizationInputs()));
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
