// M5-GAP11-P5-R1 — the bounded inventory of the shipped money-action entry points. Every entry names
// the one capability it consumes (approve_refunds, approve_return or approve_billing_actions), its
// family, its parent-module minimum, whether it only decides what is offered or executes the action,
// and whether a server enforces it (none does: the static client ships, no production route exists).
// Execution entries are checked on the syntax tree: the handler re-decides the capability in a
// guard that returns before the state-changing call.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

import {
  MONEY_CAPABILITIES,
  PLATFORM_MONEY_PARENT_MINIMUM,
  type MoneyCapability,
} from './moneyCapabilities';
import type { PermissionFamily } from './permissionFamilies';
import { SUB_PERMISSIONS, tenantRoles } from '../context/accessConfig';
import {
  decidePosRefundExecution,
  decideSupervisorRefundApproval,
  decideTenantMoneyCapability,
  decideTenantSubPermission,
  grantSupervisorRefundApproval,
  type PosRefundInput,
} from '../context/tenantAccessDecisions';
import { hasPlatformPermission } from '../owner/platformPermissionsConfig';
import { PRODUCTION_INVENTORY } from '../../server/composition/productionTransactions';
import type { EmployeeRole, PermissionLevel } from '../types';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (file: string) => readFileSync(join(REPO, file), 'utf8');

interface Guard {
  /** A named `const handler = (...) => {...}`, or the handler that encloses a unique sink text. */
  readonly handler?: string;
  /** The state-changing call the guard must precede (unique in the file when no handler is named). */
  readonly sink: string;
  /** Every marker must appear in the guard's condition. */
  readonly decision: readonly string[];
}

interface Entry {
  readonly id: string;
  readonly file: string;
  readonly family: PermissionFamily;
  readonly capability: MoneyCapability;
  readonly parentMinimum: PermissionLevel;
  readonly kind: 'presentation' | 'execution';
  readonly enforcement: 'client-only';
  /** Presentation: the expression deciding what is offered. */
  readonly offer?: string;
  /** Presentation: the condition that withholds each offered action, and how many actions carry it. */
  readonly gates?: { readonly marker: string; readonly count: number };
  /** Execution: the handler's guard. */
  readonly guard?: Guard;
}

const POS = 'src/components/POS.tsx';
const RETURNS = 'src/components/ReturnsPortal.tsx';
const ACCESS = 'src/context/AccessContext.tsx';
const BILLING = 'src/owner/BillingPage.tsx';
const TENANT = 'src/owner/TenantDetailPage.tsx';
const BILLING_DECISION = ['hasPlatformPermission(', "'approve_billing_actions'"] as const;

const store = (capability: 'approve_refunds' | 'approve_return') =>
  ({ family: 'tenant_store', capability, parentMinimum: SUB_PERMISSIONS.find((s) => s.id === capability)!.minModuleLevel, enforcement: 'client-only' }) as const;
const platform = { family: 'platform', capability: 'approve_billing_actions', parentMinimum: PLATFORM_MONEY_PARENT_MINIMUM, enforcement: 'client-only' } as const;

const MONEY_ACTION_ENTRY_POINTS: readonly Entry[] = [
  // Store plane — POS refund (approve_refunds): the operator's own authority or one bound supervisor approval.
  // The final Process Refund button is withheld once the refund is no longer authorized.
  { id: 'pos.refund.offer', file: POS, ...store('approve_refunds'), kind: 'presentation', offer: 'const canProcessRefund = canExecutePosRefund({',
    gates: { marker: 'disabled={!refundReason || !refundAuthorized}', count: 1 } },
  { id: 'pos.refund.supervisor-approval', file: ACCESS, ...store('approve_refunds'), kind: 'execution',
    guard: { handler: 'requestSupervisorRefundAuth', sink: 'setSupervisorRefundAuth(approval)', decision: ['!approval'] } },
  { id: 'pos.refund.execute', file: POS, ...store('approve_refunds'), kind: 'execution',
    guard: { handler: 'processRefund', sink: 'addRefundRecord(', decision: ['canExecutePosRefund('] } },
  // Store plane — return approval and rejection (approve_return).
  { id: 'returns.approve.offer', file: RETURNS, ...store('approve_return'), kind: 'presentation', offer: "const canApprove = checkSubPermission('approve_return') && !isWriteBlocked;" },
  { id: 'returns.approve.execute', file: RETURNS, ...store('approve_return'), kind: 'execution',
    guard: { handler: 'handleStatusTransition', sink: 'updateReturn(ret.id, updates)', decision: ["checkSubPermission('approve_return')"] } },
  // Platform plane — billing refunds and credits (approve_billing_actions).
  // Openers: header Issue/Apply Credit, transaction Refund, tenant-action Credit, unapplied-credit Apply, Apply Remaining.
  { id: 'billing.offer', file: BILLING, ...platform, kind: 'presentation', offer: "const canApproveBillingActions = hasPlatformPermission(billingRole, 'approve_billing_actions').allowed;",
    gates: { marker: 'canApproveBillingActions && ', count: 5 } },
  { id: 'billing.transaction-refund', file: BILLING, ...platform, kind: 'execution',
    guard: { handler: 'executeConfirmedAction', sink: 'setActionSuccess(label)', decision: BILLING_DECISION } },
  { id: 'billing.issue-apply-credit-and-refund-form', file: BILLING, ...platform, kind: 'execution',
    guard: { handler: 'submitForm', sink: 'setCreditNotes(', decision: BILLING_DECISION } },
  // Openers: Revoke + Refund, the credits list row's Apply/Void, the credit detail's Apply Credit and Void.
  { id: 'tenant.billing.offer', file: TENANT, ...platform, kind: 'presentation', offer: "const canApproveBillingActions = hasPlatformPermission(tdpRole, 'approve_billing_actions').allowed;",
    gates: { marker: 'canApproveBillingActions && ', count: 4 } },
  { id: 'tenant.revoke-and-refund', file: TENANT, ...platform, kind: 'execution',
    guard: { handler: 'handleConfirmRevoke', sink: 'setLocalOverrides(', decision: BILLING_DECISION } },
  { id: 'tenant.apply-credit', file: TENANT, ...platform, kind: 'execution',
    guard: { sink: "[selectedCredit.id]: 'applied'", decision: BILLING_DECISION } },
  { id: 'tenant.apply-credit-row', file: TENANT, ...platform, kind: 'execution',
    guard: { sink: "[cr.id]: 'applied'", decision: BILLING_DECISION } },
  { id: 'tenant.void-credit', file: TENANT, ...platform, kind: 'execution',
    guard: { sink: "[voidConfirmId]: 'voided'", decision: BILLING_DECISION } },
];

/** The files that name a money capability or decision without being an entry point, and why. */
const NON_ENTRY_FILES: Readonly<Record<string, string>> = {
  'src/authorization/moneyCapabilities.ts': 'the capability contract and built-in default grants',
  'src/context/accessConfig.ts': 'the store sub-permission catalog and built-in role grants',
  'src/context/tenantAccessDecisions.ts': 'the store decisions the entry points call',
  'src/owner/platformPermissionsConfig.ts': 'the platform catalog and decision the entry points call',
  'src/owner/TeamManagementPage.tsx': 'the platform role editor: shows and edits the grant, executes no money action',
  'server/platform-identity/permissionCatalog.ts': 'DEV-only catalog (not shipped, no route)',
  'server/platform-identity/permissionDecision.ts': 'DEV-only decision spine (not shipped, no route)',
  'server/platform-identity/gap11GrantDiff.ts': 'historical GAP-11 grant diff (diagnostic)',
};

// --- syntax-tree helpers --------------------------------------------------------------------------
function sourceOf(file: string): ts.SourceFile {
  return ts.createSourceFile(file, read(file), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
}
type Fn = ts.ArrowFunction | ts.FunctionExpression | ts.FunctionDeclaration;
const isFn = (n: ts.Node): n is Fn => ts.isArrowFunction(n) || ts.isFunctionExpression(n) || ts.isFunctionDeclaration(n);

function namedHandler(sf: ts.SourceFile, name: string): Fn {
  const found: Fn[] = [];
  const visit = (n: ts.Node) => {
    if (ts.isVariableDeclaration(n) && n.name.getText(sf) === name && n.initializer && isFn(n.initializer)) found.push(n.initializer);
    ts.forEachChild(n, visit);
  };
  visit(sf);
  assert.equal(found.length, 1, `${sf.fileName}: exactly one handler named ${name}`);
  return found[0];
}

function enclosingHandler(sf: ts.SourceFile, pos: number): Fn {
  let best: Fn | undefined;
  const visit = (n: ts.Node) => {
    if (n.getStart(sf) > pos || n.getEnd() <= pos) return;
    // The handler, not a state-updater arrow such as `prev => ({ ...prev })` inside it.
    if (isFn(n) && n.body && ts.isBlock(n.body)) best = n;
    ts.forEachChild(n, visit);
  };
  visit(sf);
  assert.ok(best, `${sf.fileName}: no handler encloses position ${pos}`);
  return best!;
}

const returns = (s: ts.Statement): boolean => {
  if (ts.isReturnStatement(s)) return true;
  return ts.isBlock(s) && s.statements.some((x) => ts.isReturnStatement(x));
};

/** The index of the guard `if (<decision>) { ...; return }` and of the statement holding the sink. */
function guardBeforeSink(file: string, guard: Guard): { guardAt: number; sinkAt: number; condition: string; sinkPos: number; preGuardCalls: string[] } {
  const sf = sourceOf(file);
  const text = sf.getFullText();
  let fn: Fn;
  let sinkPos: number;
  if (guard.handler) {
    fn = namedHandler(sf, guard.handler);
    sinkPos = text.indexOf(guard.sink, fn.getStart(sf));
    assert.ok(sinkPos >= 0 && sinkPos < fn.getEnd(), `${file}: ${guard.sink} is inside ${guard.handler}`);
  } else {
    sinkPos = text.indexOf(guard.sink);
    assert.ok(sinkPos >= 0 && sinkPos === text.lastIndexOf(guard.sink), `${file}: ${guard.sink} is unique`);
    fn = enclosingHandler(sf, sinkPos);
  }
  assert.ok(fn.body && ts.isBlock(fn.body), `${file}: the handler has a statement body`);
  const statements = (fn.body as ts.Block).statements;
  const sinkAt = statements.findIndex((s) => s.getStart(sf) <= sinkPos && sinkPos < s.getEnd());
  const guardAt = statements.findIndex((s) =>
    ts.isIfStatement(s) && guard.decision.every((m) => s.expression.getText(sf).includes(m)) && returns(s.thenStatement));
  // Every call the handler makes before its guard, so no second state change can move ahead of it.
  const preGuardCalls: string[] = [];
  const collect = (n: ts.Node) => { if (ts.isCallExpression(n)) preGuardCalls.push(n.expression.getText(sf)); ts.forEachChild(n, collect); };
  statements.slice(0, Math.max(guardAt, 0)).forEach(collect);
  return { guardAt, sinkAt, condition: guardAt >= 0 ? (statements[guardAt] as ts.IfStatement).expression.getText(sf) : '', sinkPos, preGuardCalls };
}

/** The only calls a money handler may make before its guard: lookups and the decision itself, never a state change. */
const PRE_GUARD_CALLS = /^(?:hasPlatformPermission|console\.warn|tenantRolesState\.find|grantSupervisorRefundApproval|posRefundInput)$/;

// --- the inventory ----------------------------------------------------------------------------------
test('I1. every entry names exactly one canonical capability, in its own family, with the catalog parent minimum', () => {
  const byId = new Map(MONEY_CAPABILITIES.map((c) => [c.id, c]));
  const ids = new Set<string>();
  for (const e of MONEY_ACTION_ENTRY_POINTS) {
    assert.ok(!ids.has(e.id), `${e.id} is listed once`);
    ids.add(e.id);
    const def = byId.get(e.capability);
    assert.ok(def, `${e.id}: ${e.capability} is a money capability`);
    assert.equal(e.family, def!.family, `${e.id}: family`);
    const expected = def!.plane === 'tenant' ? SUB_PERMISSIONS.find((s) => s.id === e.capability)!.minModuleLevel : PLATFORM_MONEY_PARENT_MINIMUM;
    assert.equal(e.parentMinimum, expected, `${e.id}: parent-module minimum`);
    assert.equal(e.kind === 'execution' ? Boolean(e.guard) : Boolean(e.offer), true, `${e.id}: a ${e.kind} entry carries its decision`);
    const decisionText = [e.offer ?? '', ...(e.guard?.decision ?? [])].join(' ');
    const named = MONEY_CAPABILITIES.filter((c) => decisionText.includes(`'${c.id}'`));
    assert.ok(named.every((c) => c.id === e.capability), `${e.id}: its decision names no other capability`);
  }
  const count = (cap: string, kind: string) => MONEY_ACTION_ENTRY_POINTS.filter((e) => e.capability === cap && e.kind === kind).length;
  assert.deepEqual(
    MONEY_CAPABILITIES.map((c) => [c.id, count(c.id, 'presentation'), count(c.id, 'execution')]),
    [['approve_refunds', 1, 2], ['approve_return', 1, 1], ['approve_billing_actions', 2, 6]],
  );
});

test('I2. every presentation entry decides what is offered with the capability, in the file it names', () => {
  for (const e of MONEY_ACTION_ENTRY_POINTS.filter((x) => x.kind === 'presentation')) {
    assert.equal(read(e.file).split(e.offer!).length - 1, 1, `${e.id}: the offer expression appears once in ${e.file}`);
    // Removing the condition from any listed opener changes the count.
    if (e.gates) assert.equal(read(e.file).split(e.gates.marker).length - 1, e.gates.count, `${e.id}: ${e.gates.count} openers wrapped in ${e.gates.marker}`);
  }
});

test('I3. every execution handler re-decides its capability in a guard that returns before the state change', () => {
  for (const e of MONEY_ACTION_ENTRY_POINTS.filter((x) => x.kind === 'execution')) {
    const { guardAt, sinkAt, condition, preGuardCalls } = guardBeforeSink(e.file, e.guard!);
    assert.ok(sinkAt >= 0, `${e.id}: the state change is a statement of the handler`);
    assert.ok(guardAt >= 0, `${e.id}: a guard naming ${e.guard!.decision.join(' + ')} returns`);
    assert.ok(guardAt < sinkAt, `${e.id}: the guard precedes the state change (guard ${guardAt}, change ${sinkAt})`);
    // Not only the declared sink: nothing ahead of the guard changes state (e.g. marking invoices paid).
    for (const call of preGuardCalls) assert.match(call, PRE_GUARD_CALLS, `${e.id}: ${call}() runs before the guard`);
    // No entry relies on a level alone: the guard is the capability decision, never a level comparison.
    assert.doesNotMatch(condition, /checkPermission\(|getPermissionLevel\(|meetsFamilyLevel\(|platformPermissionMeets\(/, `${e.id}: ${condition}`);
  }
  // The approval step's guard variable is the approve_refunds decision itself.
  assert.match(namedHandler(sourceOf(ACCESS), 'requestSupervisorRefundAuth').getText(), /const approval = grantSupervisorRefundApproval\(/);
});

test('I4. store and platform capabilities cannot stand in for each other', () => {
  for (const e of MONEY_ACTION_ENTRY_POINTS) {
    const decision = [e.offer ?? '', ...(e.guard?.decision ?? [])].join(' ');
    if (e.family === 'platform') assert.doesNotMatch(decision, /checkSubPermission|canExecutePosRefund|approve_refunds|approve_return/, e.id);
    else assert.doesNotMatch(decision, /hasPlatformPermission|approve_billing_actions/, e.id);
  }
  // A store role holding every store money grant has no platform billing authority, and the platform
  // decision answers no store capability.
  for (const role of ['manager', 'store_owner']) assert.equal(hasPlatformPermission(role as never, 'approve_billing_actions').allowed, false, role);
  for (const cap of ['approve_refunds', 'approve_return']) assert.equal(hasPlatformPermission('billing_admin', cap).allowed, false, cap);
  assert.equal(hasPlatformPermission('billing_admin', 'approve_billing_actions').allowed, true, 'control');
  // A store role configuration carrying the platform grant key gains nothing in the store plane.
  const input = {
    hasSession: true, effectiveRole: 'custom_x', tenant: { id: 't', plan: 'advanced' },
    roles: [{ id: 'custom_x', name: 'X', permissions: { refunds: 'full', returns: 'full' }, subPermissions: { approve_billing_actions: true } }] as EmployeeRole[],
  };
  assert.equal(decideTenantSubPermission(input, 'approve_billing_actions'), false);
  assert.equal(decideTenantSubPermission(input, 'approve_refunds'), false);
});

test('I5. a level alone never grants a money action, and the platform System Owner has no store-money shortcut', () => {
  const tenant = { id: 't', plan: 'advanced' };
  const full: EmployeeRole = { id: 'custom_full', name: 'Full', permissions: { refunds: 'full', returns: 'full', sales: 'full' }, subPermissions: { process_refunds: true } };
  for (const cap of ['approve_refunds', 'approve_return'] as const) {
    assert.equal(decideTenantMoneyCapability({ hasSession: true, tenant, roleConfig: full }, cap), false, `${cap} at Full, no grant`);
    assert.equal(decideTenantMoneyCapability({ hasSession: true, tenant, roleConfig: { ...full, subPermissions: { [cap]: true } } }, cap), true, `${cap} control`);
  }
  const roles = [...(tenantRoles as unknown as EmployeeRole[]), full];
  const pos = (effectiveRole: string): PosRefundInput => ({
    hasSession: true, effectiveRole, roles, tenant, userId: 'u', operatorKey: 'op', requestId: 'r', writeBlocked: false,
  });
  assert.equal(decidePosRefundExecution(pos('custom_full'), null), false, 'Refunds Full + Process Refunds, no grant');
  assert.equal(decidePosRefundExecution(pos('manager'), null), true, 'control: the manager\'s explicit grant');
  // A read-only or suspended tenant takes no money action, whatever the grant.
  for (const status of ['read_only', 'suspended']) {
    assert.equal(decidePosRefundExecution({ ...pos('manager'), tenant: { ...tenant, status } }, null), false, status);
    assert.equal(decideTenantMoneyCapability({ hasSession: true, tenant: { ...tenant, status }, roleConfig: { ...full, subPermissions: { approve_return: true } } }, 'approve_return'), false, status);
  }
  // System Owner has no store role: no refund as operator, no approval as supervisor.
  assert.equal(decidePosRefundExecution(pos('system_owner'), null), false);
  assert.equal(decideSupervisorRefundApproval(pos('manager'), 'system_owner'), false);
  assert.equal(grantSupervisorRefundApproval(pos('sales_staff'), 'system_owner', 'System Owner'), null);
  assert.ok(grantSupervisorRefundApproval(pos('sales_staff'), 'manager', 'Manager'), 'control: a store supervisor');
  // Statically: no owner-role shortcut in any store money decision.
  const sf = sourceOf('src/context/tenantAccessDecisions.ts');
  for (const name of ['decideTenantMoneyCapability', 'decideSupervisorRefundApproval', 'posRefundOperator', 'grantSupervisorRefundApproval', 'decidePosRefundExecution']) {
    const decl = sf.statements.find((s) => ts.isFunctionDeclaration(s) && s.name?.text === name);
    assert.ok(decl, name);
    assert.doesNotMatch(decl!.getText(sf), /isOwnerRole|'system_owner'|'store_owner'/, name);
  }
});

test('I6. every entry is client-only and says so; no production route enforces any money action', () => {
  for (const e of MONEY_ACTION_ENTRY_POINTS) {
    assert.equal(e.enforcement, 'client-only', e.id);
    assert.doesNotMatch(read(e.file), /server[- ]enforced|enforced (by|on) the server/i, `${e.file} claims server enforcement`);
  }
  for (const file of [BILLING, TENANT]) assert.match(read(file), /Client-side only/, `${file} records the platform money gate as client-side only`);
  assert.deepEqual({ routes: PRODUCTION_INVENTORY.routes.length, mutators: PRODUCTION_INVENTORY.mutators.length }, { routes: 0, mutators: 0 });
});

/**
 * The swept money state changes — a POS refund record, a billing credit-note change, a tenant credit apply or
 * void: each occurrence must be the sink of a declared, guarded entry. Other state changes are not swept here;
 * I3 keeps every call ahead of a declared entry's guard to lookups and the decision.
 */
const SINK_SWEEPS: readonly { readonly file: string; readonly pattern: RegExp }[] = [
  { file: POS, pattern: /addRefundRecord\(/g },
  { file: BILLING, pattern: /setCreditNotes\(/g },
  { file: TENANT, pattern: /\]: '(?:applied|voided)'/g },
];

test('I8. every swept money state change (POS refund record, billing credit note, tenant credit apply/void) is a declared entry\'s sink', () => {
  for (const { file, pattern } of SINK_SWEEPS) {
    const declared = MONEY_ACTION_ENTRY_POINTS.filter((e) => e.file === file && e.guard).map((e) => {
      const from = guardBeforeSink(file, e.guard!).sinkPos;
      return { from, to: from + e.guard!.sink.length };
    });
    const found = [...read(file).matchAll(pattern)].map((m) => m.index!);
    assert.ok(found.length > 0, `${file}: the sweep finds its sinks (control)`);
    for (const at of found) assert.ok(declared.some((d) => d.from <= at && at < d.to), `${file}: the state change at ${at} is no declared sink`);
  }
});

test('I9. a supervisor approval ends when an input it was decided on changes, and is not revived by changing it back', () => {
  // The effect's dependency list and the call it makes, read from the syntax tree.
  const effects = (file: string) => {
    const sf = sourceOf(file);
    const out: { body: string; deps: string }[] = [];
    const visit = (n: ts.Node) => {
      if (ts.isCallExpression(n) && n.expression.getText(sf) === 'useEffect' && n.arguments.length === 2) {
        out.push({ body: n.arguments[0].getText(sf), deps: n.arguments[1].getText(sf) });
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
    return out;
  };
  // POS: a change of operator at the till (two operators can share a role).
  assert.ok(effects(POS).some((e) => /clearSupervisorRefundAuth\(\)/.test(e.body) && /\brefundOperatorKey\b/.test(e.deps)), 'POS clears the approval when the operator changes');
  // AccessContext: the user, the effective role, the tenant, its plan and status, and read-only mode —
  // each its own dependency, never a joined key two different contexts could share.
  const clearing = effects(ACCESS).filter((e) => /setSupervisorRefundAuth\(null\)/.test(e.body));
  assert.equal(clearing.length, 1, 'AccessContext has one approval-clearing effect');
  const deps = clearing[0].deps.replace(/^\[|\]$/g, '').split(',').map((d) => d.trim());
  assert.deepEqual([...deps].sort(), ['effectiveRole', 'isWriteBlocked', 'session?.user.id', 'tenant?.id', 'tenant?.plan', 'tenant?.status']);
});

test('I7. the inventory is complete: every shipped file naming a money capability or decision is an entry or a listed non-entry', () => {
  const walk = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return name === 'node_modules' ? [] : walk(p);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$|\.testkit\.ts$/.test(name) ? [p] : [];
  });
  const MONEY = /approve_billing_actions|approve_refunds|approve_return|canExecutePosRefund|requestSupervisorRefundAuth|decidePosRefundExecution|grantSupervisorRefundApproval|decideTenantMoneyCapability|decideSupervisorRefundApproval/;
  const naming = [...walk(join(REPO, 'src')), ...walk(join(REPO, 'server'))]
    .filter((p) => MONEY.test(readFileSync(p, 'utf8')))
    .map((p) => relative(REPO, p).split('\\').join('/'))
    .sort();
  const entryFiles = new Set(MONEY_ACTION_ENTRY_POINTS.map((e) => e.file));
  const unclassified = naming.filter((f) => !entryFiles.has(f) && !(f in NON_ENTRY_FILES));
  assert.deepEqual(unclassified, [], 'a new file names a money capability: add it to the inventory or classify it');
  assert.deepEqual([...entryFiles, ...Object.keys(NON_ENTRY_FILES)].filter((f) => !naming.includes(f)), [], 'no stale inventory file');
});
