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
  computeGrantDiff,
  evaluateAfterCandidate,
  evaluateBefore,
  heldLevelFor,
  normalizedAuthorizationInputs,
  CANONICAL_DIFF_CONTEXT,
  CANONICAL_GRANT_UNIVERSE,
  UNIFIED_CANDIDATE_ORDERING,
  D2_MONEY_ACTIONS,
  D2_NAMED_GRANT_ONLY_ACTIONS,
  D2_UNMAPPED_PAYMENT_OPERATIONS,
  type CanonicalGrantTuple,
  type D2Classification,
  type D2MoneyAction,
  type GrantDiff,
  type GrantDiffRow,
} from '../server/platform-identity/gap11GrantDiff';
import {
  TENANT_ORDERING,
  PLATFORM_ORDERING,
  TENANT_SUB_PERMISSIONS,
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

/** The universe's tuples for one representation — one per role on its plane, in universe order. */
function tuplesFor(rep: D2MoneyAction['representations'][number]): readonly CanonicalGrantTuple[] {
  return CANONICAL_GRANT_UNIVERSE.filter((t) =>
    t.plane === rep.plane && t.stratum === rep.stratum && t.scope === rep.scope && t.action === rep.action);
}

/**
 * What the catalog cannot yet express about each identified operation. Prose, keyed by the registry's
 * operation id; the suite requires one entry per registered operation, so a new money action cannot be
 * rendered without saying what its representation leaves open.
 */
export const DATA_MODEL_NOTES: Readonly<Record<string, string>> = Object.freeze({
  refund_approval:
    'The catalog represents refund approval twice, and links the two only through `approve_refunds`\' '
    + 'default-by-level path (`refunds` at `approve`), which every canonical role\'s explicit grant '
    + 'overrides — so for those roles they are separate decisions that can disagree. The client\'s '
    + 'supervisor refund authorization requires both: the `refunds` level at `approve` and an '
    + '`approve_refunds` entry that is absent or true. There is no single canonical refund-approval action, '
    + 'so "re-pin refund approval" names more than one change. D2 has to say which representation it '
    + 're-pins — the refunds narrowing below is where the difference shows.',
  return_approval:
    'One representation: the `approve_return` sub-permission. Two of its comparisons are on the level '
    + 'the flip moves. Its minimum module level is `manage`, checked BEFORE any explicit grant: a role '
    + 'holding `returns` at `approve` clears it today and would not under the unified ordering — no '
    + 'canonical role holds that level, which is why no row changes. Its default-by-level path compares '
    + '`returns` against `approve` — the same comparison as the widened `manager` / `returns` row in '
    + 'section C — but every canonical tenant role carries an explicit `approve_return` grant, read after '
    + 'the minimum and before the default, so the path is not reached for them. The server catalog has only its four '
    + 'fixed tenant roles and cannot represent a role without an explicit grant. The client can: a '
    + 'custom role created in the Employees screen stores only the sub-permissions an owner toggled, so '
    + 'for such a role the client\'s default path, and with it the unified ordering, would decide.',
  platform_billing_approval:
    'Platform plane. That plane already ranks `approve` below `manage`, so the unified ordering cannot '
    + 'move it (0 platform rows change). Nothing needs re-pinning to prevent a silent change.',
});

function moneyActionSection(m: D2MoneyAction, context: GrantDiff['context']): string {
  const ctx = context!;
  const lines: string[] = [];
  const reps = m.representations.map((rep) => {
    const tuples = tuplesFor(rep);
    const rows = tuples.map((t) => {
      const before = evaluateBefore(t, ctx);
      const after = evaluateAfterCandidate(t, ctx);
      const held = heldLevelFor(t, ctx);
      return { t, before, after, held, changes: before !== after };
    });
    return { rep, rows, moves: rows.some((r) => r.changes) };
  });

  lines.push(`#### ${code(m.operation)}`);
  lines.push('');
  lines.push('Authoritative source' + (m.sources.length === 1 ? ':' : 's:'));
  lines.push('');
  for (const s of m.sources) lines.push(`- ${code(s.path)} — "${s.quote}"`);
  lines.push('');
  lines.push(table(
    ['representation', 'kind', 'changes under the flip', 're-pin needed to stop a silent change'],
    reps.map(({ rep, moves }) => [
      code(`${rep.plane}/${rep.scope}/${rep.action}`),
      STRATUM_LABEL[rep.stratum],
      moves ? '**yes**' : 'no',
      moves ? '**yes** — the flip moves it' : 'no — the flip does not move it (D2 may still re-pin it as policy)',
    ]),
  ));
  lines.push('');
  lines.push(table(
    ['representation', 'role', 'holds', 'BEFORE', 'AFTER-CANDIDATE', 'changes'],
    reps.flatMap(({ rep, rows }) => rows.map((r) => [
      code(`${rep.scope}/${rep.action}`),
      code(r.t.role),
      r.held === null ? '—' : code(r.held),
      r.before,
      r.after,
      r.changes ? '**yes**' : 'no',
    ])),
  ));
  lines.push('');
  const note = Object.prototype.hasOwnProperty.call(DATA_MODEL_NOTES, m.operation) ? DATA_MODEL_NOTES[m.operation] : undefined;
  if (note === undefined) throw new Error(`no data-model note for money action ${m.operation}`);
  lines.push(`What the current data model cannot yet express: ${note}`);
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
function defaultPathOf(r: GrantDiffRow): string {
  if (r.plane !== 'tenant' || r.stratum !== 'domain_threshold') return '—';
  const subs = TENANT_SUB_PERMISSIONS.filter((s) => s.parentDomain === r.scope && s.defaultLevel === r.requiredLevel);
  return subs.length === 0 ? '—' : subs.map((s) => code(s.id)).join(', ');
}

export function renderArtifact(diff: GrantDiff, inputsFingerprint: string): string {
  const context = diff.context;
  if (context === null) throw new Error('refusing to render a diff computed in a malformed context');
  const s = diff.summary;
  const widened = diff.rows.filter((r) => r.change === 'widened');
  const narrowed = diff.rows.filter((r) => r.change === 'narrowed');
  const unresolvedRows = diff.rows.filter((r) => r.d2Classification === 'unresolved');
  const subPlane = diff.rows.filter((r) => r.stratum === 'sub_permission');
  const platformPlane = diff.rows.filter((r) => r.plane === 'platform');
  const coverage = explicitGrantCoverage();
  const moneyTuples = CANONICAL_GRANT_UNIVERSE.filter((t) => t.d2Classification === 'money_action');

  // The refunds narrowing, read from the catalog rather than restated.
  const managerRefunds = (TENANT_ROLE_PERMISSION_DEFAULTS as Record<string, Record<string, string>>).manager.refunds;
  const refundSubs = TENANT_SUB_PERMISSIONS.filter((x) => x.parentDomain === 'refunds')
    .map((x) => `${code(x.id)} (minimum ${code(x.minModuleLevel)}, default ${code(x.defaultLevel)})`).join(', ');
  const refundNarrowing = narrowed.find((r) => r.role === 'manager' && r.scope === 'refunds');
  if (refundNarrowing === undefined || narrowed.length !== 1) {
    throw new Error('the refunds narrowing this artifact explains is not the diff\'s only narrowing');
  }

  const rowsTable = (rs: readonly GrantDiffRow[]): string =>
    rs.length === 0
      ? '_No rows._\n'
      : `${table(
          ['role', 'scope', 'action', 'holds', 'gate', 'before', 'after', 'change', 'approve level', 'D2 classification', 'plane/stratum'],
          rs.map(rowLine),
        )}\n`;

  return `# GAP-11 — ordering-flip effective-grant diff

> **Generated file. Do not edit by hand.**
> Produced by \`scripts/generate-gap11-grant-diff.ts\` from the inert permission catalog.
> Regenerate with \`tsx scripts/generate-gap11-grant-diff.ts\`; \`--check\` fails when it is stale.

This is **safeguard #2** of the six that [docs/phase-4/04 §3](../04-canonical-iam-and-four-user-migration.md#3-permission-level-reconciliation-required--gap-11)
binds to the GAP-11 ordering unification: a before/after effective-grant diff for every canonical
\`(role, scope, action)\` tuple, so that no silent change ships.

It decides nothing. Safeguard **#1** (the per-action re-pin of \`approve\`-gated money actions) is an
open policy choice, tracked as decision **D2** — 04 §3 names two ways to satisfy it and assigns the
choice to no one. Safeguard **#3** (explicit approval of this diff) is the owner's, tracked as decision
**D3**. Both remain open; GAP-11 is **not** closed.

## How to read this diff: two classifications, kept apart

Every tuple carries two separate classifications, and no count below mixes them:

${table(
  ['classification', 'values', 'what it means'],
  [
    ['**approve level** (structural)', 'yes / no', 'The tuple\'s decisive required level is `approve`: a threshold tuple\'s level, a platform sub-permission\'s threshold, or a tenant sub-permission\'s default level. It is the level the flip moves. It says nothing about money.'],
    ['**D2 classification**', '`money_action`', 'The tuple represents an operation an authoritative document identifies as an approve-gated money action (section B, with the source quoted). Only these are D2 rows.'],
    ['', '`unresolved`', 'The tuple requires the `approve` level, but no authoritative document ties it to a money action (section C). Whether D2 covers it is part of D2\'s open scope, not a finding. It is not counted as a D2 row.'],
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
read-only cap.

### Universe

${table(
  ['stratum', 'tuples'],
  [
    ['tenant sub-permissions (roles × actions)', `${diff.shape.tenantRoles} × ${diff.shape.tenantSubPermissions} = ${diff.shape.tenantSubTuples}`],
    ['tenant domain thresholds (roles × domains × levels)', `${diff.shape.tenantRoles} × ${diff.shape.tenantDomains} × ${diff.shape.levels} = ${diff.shape.tenantThresholdTuples}`],
    ['platform sub-permissions (roles × actions)', `${diff.shape.platformRoles} × ${diff.shape.platformSubPermissions} = ${diff.shape.platformSubTuples}`],
    ['platform feature thresholds (roles × features × levels)', `${diff.shape.platformRoles} × ${diff.shape.platformFeatures} × ${diff.shape.levels} = ${diff.shape.platformThresholdTuples}`],
    ['**total**', `**${diff.shape.total}**`],
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
representations, and **${s.byD2Classification.money_action} of them change** under the unified ordering.

${D2_MONEY_ACTIONS.map((m) => moneyActionSection(m, context)).join('\n\n')}

**What this means for D2.** On every documented money action, for every canonical role, the unified
ordering changes nothing: the manager already holds \`refunds\` at \`approve\`, every non-owner tenant
role holds explicit \`approve_refunds\` and \`approve_return\` grants that are read before the
default-by-level path, and no canonical role holds the \`approve\` level that \`approve_return\`'s \`manage\`
minimum would stop admitting.
04 §3's warning that the manager "would silently gain approval capability it did not have" does not
materialize on these operations for the catalog's roles; the structural widening sits on the
\`unresolved\` rows of section C. What D2 still has to settle is where a re-pin lands — which
representation of refund approval is the canonical one, and whether roles without explicit grants are
in scope — not a change the flip forces on the documented actions.

## C. Unresolved mapping

These rows require the \`approve\` level but **no authoritative document ties them to a money
action**. They are structural facts, not D2 rows, and D2 is not asked to decide from them. Whether
D2's re-pin should also cover them is part of D2's open scope; nothing here answers it.

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

## The \`manager\` / \`refunds\` narrowing

${table(
  ['question', 'answer'],
  [
    ['level held', `${code('manager')} holds ${code(managerRefunds)} on ${code('refunds')} (role default)`],
    ['level required', `${code(refundNarrowing.requiredLevel ?? '')} — the tuple ${code(`refunds/${refundNarrowing.action}`)}`],
    ['BEFORE', `**${refundNarrowing.before}** — the tenant ordering ranks \`approve\` (5) above \`manage\` (4), so an \`approve\` holder clears a \`manage\` gate`],
    ['AFTER-CANDIDATE', `**${refundNarrowing.after}** — the unified ordering ranks \`approve\` (4) below \`manage\` (5), so it no longer does`],
    ['a real refund money action?', `**No — a domain-threshold decision only** (D2 classification ${code(refundNarrowing.d2Classification)}). Refund approval is documented as \`refunds: approve\` / \`approve_refunds\` (section B); nothing documents \`refunds\` at \`manage\`. No catalog sub-permission uses that comparison — ${refundSubs} — and the client offers no \`manage\` level on \`refunds\` at all.`],
    ['can D2 affect it?', '**D2 does not decide it, but D2 can make it a live check.** If D2 re-pins refund approval to "`≥ manage`" as a *domain-level* gate — the shape of the `refunds: approve` representation and of the client\'s supervisor refund authorization — this comparison becomes the manager\'s refund-approval check, and under the unified ordering the manager would lose refund approval unless the role\'s `refunds` level is raised in the same change. If D2 re-pins through an explicit per-role grant or on `approve_refunds`, this comparison is not consulted: the manager\'s explicit grant is read first.'],
    ['what remains for D3', 'Approval of this row, as of every changed row: accepting that under the unified ordering an `approve` holder no longer clears a `manage` gate on `refunds`. Whatever D2 decides, the row is D3\'s to approve; if D2 makes it a live check, D3\'s approval of it should be read together with that choice.'],
  ],
)}

## What remains to be decided (D2, D3)

- **D3** — approval of all ${diff.rows.length} changed rows: ${s.widened} widened, ${s.narrowed} narrowed.
- **D2** — the re-pin of the approve-gated money actions in section B. None of their representations
  changes under the flip, so D2 is not forced by this diff; it still has to choose where a re-pin lands
  (see the refund-approval data-model note and the narrowing above) and, separately, whether its scope
  extends to the ${unresolvedRows.length} \`unresolved\` rows of section C. Neither choice is made here.

## Fingerprints

${table(
  ['input', 'sha256'],
  [
    ['normalized authorization inputs', code(inputsFingerprint)],
    ['diff rows (canonical serialization)', code(sha256(JSON.stringify(diff.rows)))],
    ['summary (canonical serialization)', code(sha256(JSON.stringify(diff.summary)))],
  ],
)}

The first fingerprint covers every catalog input this diff reads — orderings, roles, domains,
features, actions, thresholds, role defaults, explicit grants, entitlement gates and dependencies —
and the D2 classification's own inputs (the money-action registry with its quoted sources, and the
named-grant-only list), serialized with sorted keys at every level. If it changes, this artifact is
stale and the repository test fails.
`;
}

export function buildArtifact(): string {
  const diff = computeGrantDiff(CANONICAL_DIFF_CONTEXT);
  return renderArtifact(diff, sha256(normalizedAuthorizationInputs()));
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
