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
  normalizedAuthorizationInputs,
  CANONICAL_DIFF_CONTEXT,
  UNIFIED_CANDIDATE_ORDERING,
  D2_NAMED_GRANT_ONLY_ACTIONS,
  type GrantDiff,
  type GrantDiffRow,
} from '../server/platform-identity/gap11GrantDiff';
import {
  TENANT_ORDERING,
  PLATFORM_ORDERING,
  TENANT_SUB_PERMISSIONS,
  TENANT_ROLE_SUBPERMISSION_DEFAULTS,
} from '../server/platform-identity/permissionCatalog';

/**
 * Which tenant sub-permissions each non-owner role leaves to the default-by-level path — derived from
 * the catalog, not asserted, because the artifact's central D2 finding rests on it. `store_owner` has
 * no explicit map at all: it short-circuits after plan gating.
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

function table(header: readonly string[], rows: readonly (readonly string[])[]): string {
  const head = `| ${header.join(' | ')} |`;
  const rule = `| ${header.map(() => '---').join(' | ')} |`;
  const body = rows.map((r) => `| ${r.join(' | ')} |`);
  return [head, rule, ...body].join('\n');
}

function countTable(title: string, counts: Readonly<Record<string, number>>): string {
  const keys = Object.keys(counts).sort();
  if (keys.length === 0) return `**${title}:** none.\n`;
  return `**${title}**\n\n${table(['key', 'changed rows'], keys.map((k) => [`\`${k}\``, String(counts[k])]))}\n`;
}

function rowLine(r: GrantDiffRow): readonly string[] {
  return [
    `\`${r.role}\``,
    `\`${r.scope}\``,
    `\`${r.action}\``,
    r.heldLevel === null ? '—' : `\`${r.heldLevel}\``,
    r.requiredLevel === null ? '—' : `\`${r.requiredLevel}\``,
    r.before,
    r.after,
    r.change,
    r.approveGated ? 'yes' : 'no',
    r.blockedOnD2 ? 'yes' : 'no',
    `\`${r.plane}/${r.stratum}\``,
  ];
}

export function renderArtifact(diff: GrantDiff, inputsFingerprint: string): string {
  const context = diff.context;
  if (context === null) throw new Error('refusing to render a diff computed in a malformed context');
  const s = diff.summary;
  const widened = diff.rows.filter((r) => r.change === 'widened');
  const narrowed = diff.rows.filter((r) => r.change === 'narrowed');
  const d2 = diff.rows.filter((r) => r.blockedOnD2);
  const subPlane = diff.rows.filter((r) => r.stratum === 'sub_permission');
  const platformPlane = diff.rows.filter((r) => r.plane === 'platform');
  const coverage = explicitGrantCoverage();

  const rowsTable = (rs: readonly GrantDiffRow[]): string =>
    rs.length === 0
      ? '_No rows._\n'
      : `${table(
          ['role', 'scope', 'action', 'holds', 'gate', 'before', 'after', 'change', 'approve-gated', 'D2', 'plane/stratum'],
          rs.map(rowLine),
        )}\n`;

  return `# GAP-11 — ordering-flip effective-grant diff

> **Generated file. Do not edit by hand.**
> Produced by \`scripts/generate-gap11-grant-diff.ts\` from the inert permission catalog.
> Regenerate with \`tsx scripts/generate-gap11-grant-diff.ts\`; \`--check\` fails when it is stale.

This is **safeguard #2** of the six that [docs/phase-4/04 §3](../04-canonical-iam-and-four-user-migration.md#3-permission-level-reconciliation-required--gap-11)
binds to the GAP-11 ordering unification: a before/after effective-grant diff for every canonical
\`(role, scope, action)\` tuple, so that no silent change ships.

It decides nothing. Safeguard **#1** (the per-action re-pin) is an open policy choice, tracked as
decision **D2** — 04 §3 names two ways to satisfy it and assigns the choice to no one. Safeguard
**#3** (explicit approval of this diff) is the owner's, tracked as decision **D3**. Both remain open;
GAP-11 is **not** closed.

## What changed, in one line

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

## Orderings compared

${table(
  ['ordering', 'sequence', 'role in this diff'],
  [
    ['tenant (\`TENANT_ORDERING\`)', `\`${TENANT_ORDERING.join(' < ')}\``, 'the BEFORE authority for the tenant plane'],
    ['platform (\`PLATFORM_ORDERING\`)', `\`${PLATFORM_ORDERING.join(' < ')}\``, 'the BEFORE authority for the platform plane'],
    ['unified candidate', `\`${UNIFIED_CANDIDATE_ORDERING.join(' < ')}\``, 'the AFTER-CANDIDATE for both planes'],
  ],
)}

**BEFORE** is the behaviour that ships today, obtained by calling the production materializers in
\`server/platform-identity/permissionCatalog.ts\` — it is the authority itself, not a copy of it.
**AFTER-CANDIDATE** is an independent implementation carrying its own rank table, so a single defect
cannot make both agree and report a falsely empty diff. The platform plane already uses the unified
ordering, so every platform tuple must come out identical under both; that is the positive control
proving the candidate is not simply broken.

## Evaluation context

${table(
  ['field', 'value'],
  [
    ['entitlements', `every known tenant entitlement enabled (${Object.keys(context.entitlements).length} keys)`],
    ['limitation', `\`${context.limitation}\``],
  ],
)}

This is the **maximal-grant** context, chosen deliberately: plan gating can only force a domain to
\`none\` and the read-only cap can only force a level to \`view\`, and neither \`none\` nor \`view\`
straddles the \`manage\`/\`approve\` boundary. No other context can therefore produce a change this
one does not contain. The authorization-matrix suite checks that argument rather than trusting it,
across the full, empty, every-one-off and every-one-on entitlement sets, each with and without the
read-only cap.

## Universe

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

## Summary

${table(
  ['measure', 'count'],
  [
    ['tuples evaluated', String(s.evaluated)],
    ['unchanged', String(s.unchanged)],
    ['**widened**', `**${s.widened}**`],
    ['**narrowed**', `**${s.narrowed}**`],
    ['waiting on D2 (approve-gated: the re-pin policy)', String(s.blockedOnD2)],
    ['waiting on D3 (owner approval of this diff)', String(diff.rows.length)],
    ['changed in the sub-permission stratum', String(subPlane.length)],
    ['changed on the platform plane', String(platformPlane.length)],
  ],
)}

${countTable('Changed rows by role', s.byRole)}
${countTable('Changed rows by scope', s.byScope)}
${countTable('Changed rows by action', s.byAction)}

## Every changed row

### Widened — a \`manage\` holder newly clears an \`approve\` gate (${widened.length})

${rowsTable(widened)}
### Narrowed — an \`approve\` holder stops clearing a \`manage\` gate (${narrowed.length})

${rowsTable(narrowed)}
## What remains to be decided (D2, D3)

All ${diff.rows.length} changed rows need the owner's approval of this diff (**D3**). ${d2.length} of
them — every row gated at \`approve\` — also wait on **D2**: whether an \`approve\`-gated action is
re-pinned to require \`≥ manage\`, or to an explicit per-role grant. Both options are named by 04 §3
safeguard #1; it picks neither, and neither is picked here. The remaining
${diff.rows.length - d2.length} row(s) are gated at \`manage\`, so they are not a re-pin question — but
see the refunds row below: which D2 option is chosen, and where it is applied, decides whether that
narrowing ever reaches a real check.

Two findings bear directly on that choice, and both are visible only because the diff was computed
rather than assumed:

1. **The named sub-permissions do not move** (${subPlane.length} changed rows in that stratum). Each
   non-owner tenant role carries an **explicit boolean grant** for every \`approve\`-gated
   sub-permission — \`approve_refunds\`, \`approve_return\`, \`approve_inventory\`,
   \`approve_requests\` — and an explicit grant is consulted *before* the default-by-level path the
   ordering flip would move. So for those actions safeguard #1's second option, "an explicit per-role
   grant", is **already in force**, and the widening 04 §3 warns about does not reach them.
   \`store_owner\` has no explicit map: it short-circuits after plan gating, which the ordering does not
   touch. What each non-owner role still leaves to the default-by-level path, of ${coverage.total}
   sub-permissions, derived from the catalog:
${coverage.roles.map((r) => `   - \`${r.role}\`: ${r.defaulted.length === 0 ? 'none' : r.defaulted.join(', ')}`).join('\n')}

   None of those defaults is \`approve\`, and none sits on a \`manage\`/\`approve\` boundary a role
   straddles, which is why they do not move either.
2. **The exposure is entirely at the domain-threshold layer** — wherever a role's *level* on a
   domain is compared against a required level: the client engine's \`checkPermission(domain, level)\`
   and its supervisor refund authorization (both in \`src/context/AccessContext.tsx\`), and the DEV
   control plane's \`requireTenantPermission\` (\`server/platform-identity/permissionDecision.ts\`).
   The M5 canonical route catalog (\`m5CanonicalPermissions.ts\`) is *not* on this layer: it admits
   only named sub-permissions, which is the stratum that does not move. This diff enumerates the
   changed *decisions*; it does not claim that any particular call site consults one of them today.

And one row cuts the other way from the documented risk:

- **\`manager\` / \`refunds\` / gate \`manage\`: granted → denied.** The manager holds \`approve\` on
  \`refunds\`, and under the unified ordering \`approve\` sits *below* \`manage\`. So if D2's
  "\`≥ manage\`" option is applied as a **domain-level** gate — the shape of today's supervisor refund
  authorization, which checks the \`refunds\` level against \`approve\` — the manager **loses** refund
  approval rather than keeping it, unless the role's \`refunds\` level is raised at the same time.
  Applied instead as the required level of the \`approve_refunds\` *sub-permission*, it changes nothing
  for the manager, whose explicit grant is consulted first. 04 §3 describes GAP-11 only as a widening
  hazard; on the money domain it can also narrow, depending on where the re-pin is applied.

One boundary is not an authorization control, and should not be read as one: the client's
per-domain list of selectable levels (\`PERMISSION_DOMAINS[].levels\` in \`src/context/accessConfig.ts\`,
which for example offers no \`manage\` on \`refunds\` and no \`approve\` on \`shipping\`) is a UI
allow-list only. Nothing server-side mirrors or enforces it, so a stored role level outside it lands
directly on the \`manage\`/\`approve\` boundary this diff is about. This diff therefore evaluates every
level on every domain, not only the ones the UI offers.

Named-grant-only capabilities tracked for D2 (04 §2), none currently present in the catalog:
${D2_NAMED_GRANT_ONLY_ACTIONS.map((a) => `\`${a}\``).join(', ')}.

## Fingerprints

${table(
  ['input', 'sha256'],
  [
    ['normalized authorization inputs', `\`${inputsFingerprint}\``],
    ['diff rows (canonical serialization)', `\`${sha256(JSON.stringify(diff.rows))}\``],
    ['summary (canonical serialization)', `\`${sha256(JSON.stringify(diff.summary))}\``],
  ],
)}

The first fingerprint covers every catalog input this diff reads — orderings, roles, domains,
features, actions, thresholds, role defaults, explicit grants, entitlement gates and dependencies —
serialized with sorted keys at every level. If it changes, this artifact is stale and the repository
test fails.
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
