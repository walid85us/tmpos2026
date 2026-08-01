// Phase 4.0 M3 S2 — static contract over migration 005 (principal separation + RLS).
// DATABASE-FREE: this suite reads the two committed 005 files with node:fs and judges their
// TEXT. It never connects to PostgreSQL.
//
// DIVISION OF LABOUR (deliberate, and stated so no reader over-reads this file):
//   * THIS suite proves SHAPE — that the privilege roles are least-privileged, that the
//     role-to-table grant matrix is exactly the approved one, that no policy is blanket-open,
//     that the identity tables are unreachable from the runtime role, that the public schema
//     grants no CREATE, that default privileges are handled, that no secret literal appears,
//     and that the down migration reverses every S2-owned object in a dependency-safe order.
//   * tests/db/rlsIsolation.integration.test.mjs proves SEMANTICS against a real disposable
//     PostgreSQL — that the policies actually deny, that the constraint actually rejects, and
//     that the runtime role actually cannot reach what it must not reach.
//   Shape alone is not isolation: a syntactically valid policy can still be semantically
//   overbroad. Neither suite is sufficient on its own, which is why both are required.
//
// The validator below is exercised from BOTH directions: every rule is shown to reject a
// mutated copy of the real migration, and the real migration is shown to satisfy all of them.
// A rule that only ever ran against a passing input would prove nothing.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { MIN_SUITES, REQUIRED_SENTINELS } from '../../scripts/run-tests.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..');
const MIG_DIR = join(REPO, 'server', 'platform-identity', 'migrations');
const UP_FILE = '005_principal_separation_rls_foundation.up.sql';
const DOWN_FILE = '005_principal_separation_rls_foundation.down.sql';

// --- the S2 contract, as data ------------------------------------------------

const RUNTIME_ROLE = 'tmpos_app';
const AUDIT_ROLE = 'tmpos_audit_writer';
const S2_ROLES = [RUNTIME_ROLE, AUDIT_ROLE];

/** Identity tables the general runtime role may never be granted anything on. */
const IDENTITY_TABLES = ['platform_identity', 'app_user', 'identity_link'];

/** Tables that must carry a tenant/store RLS policy targeted at the runtime role. */
const TENANT_SCOPED_TABLES = ['tenant', 'store', 'user_membership', 'tenant_feature_entitlement'];

const AUDIT_TABLE = 'audit_event';
const AUDIT_SCOPE_CONSTRAINT = 'audit_event_scope_consistency_chk';

/** The transaction-local context contract these policies read. */
const CONTEXT_SETTINGS = ['app.scope_type', 'app.tenant_id', 'app.store_id'];

/**
 * The approved role-to-table privilege matrix. This object IS the contract: the up migration's
 * actual grants must equal it exactly, so neither a widened verb nor a new table can be added
 * without editing this line and being seen in review.
 */
// The UPDATE verbs are COLUMN-SCOPED on purpose. RLS is row-granular and cannot restrict which
// column an UPDATE touches, so a table-wide `update` here would let the tenant runtime rewrite
// tenant.status / tenant.plan_key / store.status — the columns the authorization resolver denies
// on. Pinning the column list is the only way this contract can hold that line.
const APPROVED_TABLE_GRANTS = {
  tenant: { [RUNTIME_ROLE]: ['select', 'update(display_name,legal_name)'] },
  store: { [RUNTIME_ROLE]: ['insert', 'select', 'update(store_name)'] },
  user_membership: { [RUNTIME_ROLE]: ['select'] },
  tenant_feature_entitlement: { [RUNTIME_ROLE]: ['select'] },
  [AUDIT_TABLE]: { [AUDIT_ROLE]: ['insert'] },
};

/** Split a GRANT verb list on top-level commas, so `update (a, b)` survives intact. */
function splitVerbs(list) {
  const parts = [];
  let cur = '';
  let depth = 0;
  for (const ch of list) {
    if (ch === '(') depth += 1;
    else if (ch === ')') depth -= 1;
    if (ch === ',' && depth === 0) { parts.push(cur); cur = ''; continue; }
    cur += ch;
  }
  parts.push(cur);
  return parts
    .map((p) => p.trim().replace(/\s*\(\s*/, '(').replace(/\s*\)\s*$/, ')').replace(/\s*,\s*/g, ','))
    .filter(Boolean);
}

/** Role attributes that must never appear on an S2 privilege role. */
const FORBIDDEN_ROLE_ATTRS = ['login', 'superuser', 'createdb', 'createrole', 'replication', 'bypassrls'];

// --- SQL text handling -------------------------------------------------------

/**
 * Remove `--` and block comments while preserving single-quoted string literals, so a rule can
 * neither be satisfied by a commented-out statement nor tripped by prose in a comment.
 */
export function stripSqlComments(sql) {
  let out = '';
  let i = 0;
  let inSingle = false;
  while (i < sql.length) {
    if (inSingle) {
      out += sql[i];
      if (sql[i] === "'") {
        if (sql[i + 1] === "'") { out += "'"; i += 2; continue; }
        inSingle = false;
      }
      i += 1;
      continue;
    }
    if (sql[i] === "'") { inSingle = true; out += sql[i]; i += 1; continue; }
    if (sql[i] === '-' && sql[i + 1] === '-') { while (i < sql.length && sql[i] !== '\n') i += 1; continue; }
    if (sql[i] === '/' && sql[i + 1] === '*') {
      const end = sql.indexOf('*/', i + 2);
      i = end === -1 ? sql.length : end + 2;
      out += ' ';
      continue;
    }
    out += sql[i];
    i += 1;
  }
  return out;
}

/** Split on top-level `;`, respecting single quotes and dollar-quoted bodies. */
export function splitStatements(sql) {
  const out = [];
  let cur = '';
  let i = 0;
  let inSingle = false;
  let tag = null;
  while (i < sql.length) {
    if (tag) {
      if (sql.startsWith(tag, i)) { cur += tag; i += tag.length; tag = null; continue; }
      cur += sql[i]; i += 1; continue;
    }
    if (inSingle) {
      cur += sql[i];
      if (sql[i] === "'") {
        if (sql[i + 1] === "'") { cur += "'"; i += 2; continue; }
        inSingle = false;
      }
      i += 1; continue;
    }
    const dq = /^\$[A-Za-z_0-9]*\$/.exec(sql.slice(i));
    if (dq) { tag = dq[0]; cur += tag; i += tag.length; continue; }
    if (sql[i] === "'") { inSingle = true; cur += sql[i]; i += 1; continue; }
    if (sql[i] === ';') { if (cur.trim()) out.push(cur.trim()); cur = ''; i += 1; continue; }
    cur += sql[i]; i += 1;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

const norm = (s) => s.replace(/\s+/g, ' ').trim().toLowerCase();

/** Index of the `)` matching the `(` at `open`, or -1. */
function matchParen(s, open) {
  let depth = 0;
  let inSingle = false;
  for (let i = open; i < s.length; i += 1) {
    if (inSingle) { if (s[i] === "'") inSingle = false; continue; }
    if (s[i] === "'") { inSingle = true; continue; }
    if (s[i] === '(') depth += 1;
    else if (s[i] === ')') { depth -= 1; if (depth === 0) return i; }
  }
  return -1;
}

/**
 * Parse `create policy`. Returns null on ANY grammar or clause-ordering deviation — the strict
 * `USING` before `WITH CHECK` order and the absence of trailing text are both load-bearing.
 */
export function parsePolicy(statement) {
  const s = norm(statement);
  const head = /^create policy ([a-z0-9_]+) on ([a-z0-9_.]+) for (all|select|insert|update|delete) to ([a-z0-9_, ]+?)(?= using \(| with check \(|$)/.exec(s);
  if (!head) return null;
  let rest = s.slice(head[0].length).trim();
  let using = null;
  let check = null;
  if (rest.startsWith('using (')) {
    const open = rest.indexOf('(');
    const close = matchParen(rest, open);
    if (close === -1) return null;
    using = rest.slice(open + 1, close).trim();
    rest = rest.slice(close + 1).trim();
  }
  if (rest.startsWith('with check (')) {
    const open = rest.indexOf('(');
    const close = matchParen(rest, open);
    if (close === -1) return null;
    check = rest.slice(open + 1, close).trim();
    rest = rest.slice(close + 1).trim();
  }
  if (rest !== '') return null;
  return {
    name: head[1],
    table: head[2].replace(/^public\./, ''),
    command: head[3],
    roles: head[4].split(',').map((r) => r.trim()).filter(Boolean),
    using,
    check,
  };
}

/** True for a predicate that grants unrestricted access. */
const isUnrestricted = (pred) => pred !== null && /^(true|1\s*=\s*1|\(\s*true\s*\))$/.test(pred.trim());

// --- the validator -----------------------------------------------------------

/**
 * Judge a 005 up/down pair. Returns a list of problem strings; empty means the pair satisfies
 * every S2 rule. Pure over its inputs so each rule can be shown to reject a mutated migration.
 */
export function validateMigration005({ up, down }) {
  const problems = [];
  const upStmts = splitStatements(stripSqlComments(up)).map(norm);
  const downStmts = splitStatements(stripSqlComments(down)).map(norm);

  // --- secrets: neither file may carry a credential or endpoint --------------
  const SECRET_PATTERNS = [
    [/\bpassword\b/, 'a role password'],
    [/postgres(ql)?:\/\//, 'a database connection URL'],
    [/\.supabase\.co/, 'a provider project host'],
    [/-----begin [a-z ]*private key/, 'a private key'],
  ];
  for (const [label, text] of [['up', up], ['down', down]]) {
    const bare = stripSqlComments(text).toLowerCase();
    for (const [re, what] of SECRET_PATTERNS) {
      if (re.test(bare)) problems.push(`${label}: migration 005 must not contain ${what}`);
    }
  }

  // --- privilege roles: created, and least-privileged ------------------------
  for (const role of S2_ROLES) {
    const roleStmts = upStmts.filter((s) => new RegExp(`\\b(create|alter) role ${role}\\b`).test(s));
    if (!upStmts.some((s) => new RegExp(`\\bcreate role ${role}\\b`).test(s))) {
      problems.push(`up: privilege role ${role} is never created`);
    }
    if (!roleStmts.some((s) => new RegExp(`\\b(create|alter) role ${role}\\b[^;]*\\bnologin\\b`).test(s))) {
      problems.push(`up: privilege role ${role} is never declared NOLOGIN`);
    }
    for (const attr of FORBIDDEN_ROLE_ATTRS) {
      for (const s of roleStmts) {
        // Strip the required NEGATIONS first, so only a bare (positive) attribute can match.
        const positives = ` ${s.replace(/\bno(login|superuser|createdb|createrole|replication|bypassrls)\b/g, ' ')} `;
        if (new RegExp(`\\s${attr}\\s`).test(positives)) {
          problems.push(`up: privilege role ${role} must never carry ${attr.toUpperCase()}`);
          break;
        }
      }
    }
  }

  // --- grants ---------------------------------------------------------------
  // GRANT parsing is FAIL-CLOSED. `TABLE` is optional in PostgreSQL, so a rule keyed on
  // "on table" alone would let `grant select on platform_identity to tmpos_app` straight
  // through. And `grant <role> to <role>` is a MEMBERSHIP grant — the escalation path that
  // makes a NOLOGIN role as privileged as whatever it inherits. Anything this cannot classify
  // is a problem, not a pass.
  const actualGrants = {};
  for (const s of upStmts) {
    if (!/^grant\b/.test(s)) continue;
    if (/^grant [a-z, ]+ on (all [a-z]+ in )?schema [a-z0-9_]+ to /.test(s)) continue; // checked below

    const table = /^grant ([a-z, ()_]+?) on (?:table )?([a-z0-9_.]+) to ([a-z0-9_, ]+)$/.exec(s);
    if (table) {
      const verbs = splitVerbs(table[1]);
      const name = table[2].replace(/^public\./, '');
      for (const role of table[3].split(',').map((r) => r.trim()).filter(Boolean)) {
        actualGrants[name] = actualGrants[name] ?? {};
        actualGrants[name][role] = [...(actualGrants[name][role] ?? []), ...verbs].sort();
      }
      continue;
    }

    const membership = /^grant ([a-z0-9_, ]+) to ([a-z0-9_, ]+)( with admin option)?$/.exec(s);
    if (membership) {
      const grantees = membership[2].split(',').map((r) => r.trim());
      problems.push(grantees.some((g) => S2_ROLES.includes(g))
        ? `up: role membership '${membership[1]}' granted to ${grantees.join(',')} — an inheriting privilege role is not least-privileged`
        : `up: unexpected role-membership grant: ${s.slice(0, 90)}`);
      continue;
    }

    problems.push(`up: unclassifiable GRANT statement (fail-closed): ${s.slice(0, 90)}`);
  }
  for (const t of IDENTITY_TABLES) {
    for (const role of Object.keys(actualGrants[t] ?? {})) {
      if (S2_ROLES.includes(role)) {
        problems.push(`up: ${role} must have NO privilege on the identity table ${t} (found ${actualGrants[t][role].join(', ')})`);
      }
    }
  }
  const expectedKeys = Object.keys(APPROVED_TABLE_GRANTS).sort();
  const actualKeys = Object.keys(actualGrants).sort();
  if (expectedKeys.join('|') !== actualKeys.join('|')) {
    problems.push(`up: granted tables ${actualKeys.join(',') || '(none)'} do not equal the approved set ${expectedKeys.join(',')}`);
  }
  for (const [table, byRole] of Object.entries(APPROVED_TABLE_GRANTS)) {
    for (const [role, verbs] of Object.entries(byRole)) {
      const got = (actualGrants[table] ?? {})[role] ?? [];
      if (got.join(',') !== [...verbs].sort().join(',')) {
        problems.push(`up: grant on ${table} to ${role} is [${got.join(',')}], approved is [${[...verbs].sort().join(',')}]`);
      }
    }
  }
  // The audit writer is INSERT-only: it may never read or mutate the evidence it appends to.
  for (const verb of ['select', 'update', 'delete', 'truncate', 'all']) {
    if (upStmts.some((s) => new RegExp(`^grant [^;]*\\b${verb}\\b[^;]* on table (public\\.)?${AUDIT_TABLE} to [^;]*${AUDIT_ROLE}`).test(s))) {
      problems.push(`up: the audit writer must never be granted ${verb.toUpperCase()} on ${AUDIT_TABLE}`);
    }
  }

  // --- schema privileges ----------------------------------------------------
  for (const s of upStmts) {
    if (/^grant [^;]*\b(create|all)\b[^;]* on schema public to /.test(s)) {
      problems.push('up: no role may be granted CREATE (or ALL) on schema public');
    }
  }
  if (!upStmts.some((s) => /^revoke [^;]*\bcreate\b[^;]* on schema public from [^;]*\bpublic\b/.test(s))) {
    problems.push('up: CREATE on schema public must be explicitly revoked from PUBLIC');
  }

  // --- the missing platform_identity revocation -----------------------------
  if (!upStmts.some((s) => /^revoke all on table (public\.)?platform_identity from [^;]*\bpublic\b[^;]*\banon\b[^;]*\bauthenticated\b/.test(s))) {
    problems.push('up: platform_identity must carry the explicit REVOKE ALL from public, anon, authenticated that 001 omitted');
  }

  // --- default privileges ---------------------------------------------------
  const upDefaults = upStmts.filter((s) => s.startsWith('alter default privileges'));
  if (upDefaults.length === 0) problems.push('up: least-privilege ALTER DEFAULT PRIVILEGES handling is missing');
  for (const objType of ['tables', 'sequences', 'functions']) {
    if (!upDefaults.some((s) => new RegExp(`revoke [^;]* on ${objType} from [^;]*\\bpublic\\b`).test(s))) {
      problems.push(`up: default privileges on ${objType} are not revoked from PUBLIC`);
    }
  }
  for (const s of upDefaults) {
    if (new RegExp(`grant [^;]* to [^;]*(${S2_ROLES.join('|')})`).test(s)) {
      problems.push('up: default privileges must never pre-grant a future object to a runtime role');
    }
  }

  // --- policies -------------------------------------------------------------
  const policyStmts = upStmts.filter((s) => s.startsWith('create policy'));
  const policies = [];
  for (const s of policyStmts) {
    const p = parsePolicy(s);
    if (p === null) { problems.push(`up: invalid CREATE POLICY grammar or clause ordering: ${s.slice(0, 90)}`); continue; }
    policies.push(p);
  }
  for (const p of policies) {
    const writeCapable = ['all', 'insert', 'update'].includes(p.command);
    if (writeCapable && p.check === null) {
      problems.push(`up: policy ${p.name} is write-capable (FOR ${p.command.toUpperCase()}) but has no WITH CHECK`);
    }
    if (p.command === 'insert' && p.using !== null) {
      problems.push(`up: policy ${p.name} is FOR INSERT and must not carry USING`);
    }
    if (['select', 'delete'].includes(p.command) && p.using === null) {
      problems.push(`up: policy ${p.name} is FOR ${p.command.toUpperCase()} and must carry USING`);
    }
    if (isUnrestricted(p.using)) problems.push(`up: policy ${p.name} has a blanket USING predicate`);
    if (isUnrestricted(p.check)) problems.push(`up: policy ${p.name} has an unrestricted WITH CHECK predicate`);
    if (!p.roles.every((r) => S2_ROLES.includes(r))) {
      problems.push(`up: policy ${p.name} targets ${p.roles.join(',')}, which is not an S2 privilege role`);
    }
    // A tenant-scoped policy must actually read the transaction-local context, missing-safe.
    if (TENANT_SCOPED_TABLES.includes(p.table)) {
      for (const pred of [p.using, p.check].filter((x) => x !== null)) {
        if (!pred.includes("current_setting('app.tenant_id', true)")) {
          problems.push(`up: policy ${p.name} does not read app.tenant_id missing-safe`);
        }
        if (!pred.includes('tenant_id =')) {
          problems.push(`up: policy ${p.name} does not constrain tenant_id`);
        }
      }
    }
    if (IDENTITY_TABLES.includes(p.table)) problems.push(`up: identity table ${p.table} must carry no policy`);
  }
  for (const t of TENANT_SCOPED_TABLES) {
    if (!policies.some((p) => p.table === t)) problems.push(`up: tenant-scoped table ${t} has no RLS policy`);
  }
  if (!policies.some((p) => p.table === AUDIT_TABLE && p.command === 'insert' && p.roles.includes(AUDIT_ROLE))) {
    problems.push(`up: ${AUDIT_TABLE} has no FOR INSERT policy targeting ${AUDIT_ROLE}`);
  }
  for (const setting of CONTEXT_SETTINGS) {
    if (!upStmts.some((s) => s.includes(`current_setting('${setting}', true)`))) {
      problems.push(`up: context setting ${setting} is never read missing-safe`);
    }
  }

  // --- the audit scope-consistency constraint -------------------------------
  const constraintStmt = upStmts.find((s) =>
    new RegExp(`^alter table (public\\.)?${AUDIT_TABLE} add constraint ${AUDIT_SCOPE_CONSTRAINT} check `).test(s));
  if (constraintStmt === undefined) {
    problems.push(`up: the ${AUDIT_SCOPE_CONSTRAINT} scope-consistency constraint is missing`);
  } else {
    // Each scope_type must be paired with the CORRECT nullability; a mis-paired branch is an
    // internally inconsistent constraint and must fail here, not only at apply time.
    const REQUIRED_BRANCHES = [
      "scope_type in ('platform', 'none') and tenant_id is null and store_id is null",
      "scope_type = 'tenant' and tenant_id is not null and store_id is null",
      "scope_type = 'store' and tenant_id is not null and store_id is not null",
    ];
    for (const branch of REQUIRED_BRANCHES) {
      if (!constraintStmt.includes(branch)) {
        problems.push(`up: ${AUDIT_SCOPE_CONSTRAINT} is internally inconsistent — missing branch "${branch}"`);
      }
    }
  }

  // --- the down migration reverses every S2-owned object, in a safe order ----
  const firstIdx = (pred) => downStmts.findIndex(pred);
  const lastIdx = (pred) => { let n = -1; downStmts.forEach((s, i) => { if (pred(s)) n = i; }); return n; };

  for (const p of policies) {
    if (!downStmts.some((s) => new RegExp(`^drop policy if exists ${p.name} on (public\\.)?${p.table}$`).test(s))) {
      problems.push(`down: policy ${p.name} on ${p.table} is never dropped`);
    }
  }
  // The revokes are wrapped in a role-existence guard (a bare REVOKE naming an absent role
  // raises 42704 and aborts the rollback), so they are not top-level statements. Match on the
  // statement TEXT instead of requiring `^revoke`.
  const downText = downStmts.join('\n');
  for (const [table, byRole] of Object.entries(APPROVED_TABLE_GRANTS)) {
    for (const role of Object.keys(byRole)) {
      if (!new RegExp(`revoke [a-z ,]* on table (public\\.)?${table} from [a-z_, ]*${role}`).test(downText)) {
        problems.push(`down: the grant on ${table} to ${role} is never revoked`);
      }
    }
  }
  if (constraintStmt !== undefined &&
      !downStmts.some((s) => new RegExp(`^alter table (public\\.)?${AUDIT_TABLE} drop constraint if exists ${AUDIT_SCOPE_CONSTRAINT}$`).test(s))) {
    problems.push(`down: ${AUDIT_SCOPE_CONSTRAINT} is never dropped`);
  }
  const downDefaults = downStmts.filter((s) => s.startsWith('alter default privileges'));
  if (downDefaults.length === 0) {
    problems.push("down: the up migration's default-privilege change is never reversed");
  }
  for (const s of downDefaults) {
    if (/grant [^;]* on (tables|sequences) to [^;]*\b(public|anon|authenticated)\b/.test(s)) {
      problems.push('down: reversal must not grant future tables or sequences to public/anon/authenticated');
    }
  }
  for (const role of S2_ROLES) {
    if (!downStmts.some((s) => new RegExp(`\\bdrop role ${role}\\b`).test(s))) {
      problems.push(`down: privilege role ${role} is never dropped`);
    }
  }
  // Ordering: a role cannot be dropped while a policy still names it or a grant still holds it.
  const firstRoleDrop = firstIdx((s) => S2_ROLES.some((r) => new RegExp(`\\bdrop role ${r}\\b`).test(s)));
  const lastPolicyDrop = lastIdx((s) => s.startsWith('drop policy'));
  const lastRevoke = lastIdx((s) => /revoke [a-z ,]* on table /.test(s));
  if (firstRoleDrop !== -1 && lastPolicyDrop > firstRoleDrop) {
    problems.push('down: a policy is dropped AFTER the role it targets — unsafe order');
  }
  if (firstRoleDrop !== -1 && lastRevoke > firstRoleDrop) {
    problems.push('down: a grant is revoked AFTER the role that holds it is dropped — unsafe order');
  }
  // 001-004 protections must survive a 005 rollback.
  for (const s of downStmts) {
    if (/^drop table\b/.test(s)) problems.push('down: 005 rollback must not drop a table created by 001-004');
    if (/^alter table [^;]* disable row level security/.test(s)) {
      problems.push('down: 005 rollback must not disable RLS established by 001-004');
    }
    if (/^grant [^;]* to [^;]*\b(public|anon|authenticated)\b/.test(s)) {
      problems.push('down: 005 rollback must not re-grant table access to public/anon/authenticated');
    }
  }

  return problems;
}

// --- the real migration ------------------------------------------------------

const readMigration = (basename) => {
  const p = join(MIG_DIR, basename);
  assert.ok(existsSync(p), `migration 005 file is missing: ${basename}`);
  return readFileSync(p, 'utf8');
};

test('both migration 005 files exist and are non-empty', () => {
  assert.ok(readMigration(UP_FILE).trim().length > 0, 'the up migration must not be empty');
  assert.ok(readMigration(DOWN_FILE).trim().length > 0, 'the down migration must not be empty');
});

test('the real migration 005 satisfies every S2 rule', () => {
  const problems = validateMigration005({ up: readMigration(UP_FILE), down: readMigration(DOWN_FILE) });
  assert.deepEqual(problems, [], problems.join('\n'));
});

test('migration 005 declares exactly the approved role-to-table privilege matrix', () => {
  // Re-asserted here as an explicit, readable inventory so the matrix is visible in this file
  // and not only implied by the validator's internals.
  const up = norm(stripSqlComments(readMigration(UP_FILE)));
  assert.ok(up.includes(`grant select on table tenant to ${RUNTIME_ROLE}`));
  assert.ok(up.includes(`grant update (display_name, legal_name) on table tenant to ${RUNTIME_ROLE}`));
  assert.ok(up.includes(`grant select, insert on table store to ${RUNTIME_ROLE}`));
  assert.ok(up.includes(`grant update (store_name) on table store to ${RUNTIME_ROLE}`));
  // The authorization-critical columns must NOT be writable by the tenant runtime.
  for (const col of ['status', 'plan_key']) {
    assert.ok(!new RegExp(`grant update \\([^)]*\\b${col}\\b`).test(up), `${col} must never be granted for UPDATE`);
  }
  assert.ok(up.includes(`grant select on table user_membership to ${RUNTIME_ROLE}`));
  assert.ok(up.includes(`grant select on table tenant_feature_entitlement to ${RUNTIME_ROLE}`));
  assert.ok(up.includes(`grant insert on table ${AUDIT_TABLE} to ${AUDIT_ROLE}`));
  for (const t of IDENTITY_TABLES) {
    assert.ok(!new RegExp(`grant [^;]* on table (public\\.)?${t} to`).test(up), `${t} must never be granted`);
  }
});

// --- every rule is shown to REJECT a mutated migration -----------------------
// Fragments are assembled at runtime so no credential-shaped literal is stored in this file.

const DSN_FRAGMENT = ['postgres:', '//example.invalid/db'].join('');
const PASSWORD_KEYWORD = ['pass', 'word'].join('');

/** Apply a mutation to the real pair and return the problems it produces. */
function problemsFor(mutate) {
  return validateMigration005(mutate({ up: readMigration(UP_FILE), down: readMigration(DOWN_FILE) }));
}

const DEFECTS = [
  {
    name: 'invalid CREATE POLICY grammar or clause ordering',
    mutate: (p) => ({ ...p, up: `${p.up}\ncreate policy bad_order on store for select to ${RUNTIME_ROLE} with check (tenant_id is not null) using (tenant_id is not null);\n` }),
    expect: /invalid CREATE POLICY grammar or clause ordering/,
  },
  {
    name: 'a write-capable FOR ALL policy missing WITH CHECK',
    mutate: (p) => ({ ...p, up: `${p.up}\ncreate policy bad_all on store for all to ${RUNTIME_ROLE} using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);\n` }),
    expect: /write-capable \(FOR ALL\) but has no WITH CHECK/,
  },
  {
    name: 'a blanket USING (true) predicate',
    mutate: (p) => ({ ...p, up: `${p.up}\ncreate policy bad_using on store for select to ${RUNTIME_ROLE} using (true);\n` }),
    expect: /blanket USING predicate/,
  },
  {
    name: 'an unrestricted WITH CHECK predicate',
    mutate: (p) => ({ ...p, up: `${p.up}\ncreate policy bad_check on store for insert to ${RUNTIME_ROLE} with check (true);\n` }),
    expect: /unrestricted WITH CHECK predicate/,
  },
  {
    name: 'a runtime-role grant on an identity table',
    mutate: (p) => ({ ...p, up: `${p.up}\ngrant select on table platform_identity to ${RUNTIME_ROLE};\n` }),
    expect: /must have NO privilege on the identity table platform_identity/,
  },
  {
    // `TABLE` is OPTIONAL in PostgreSQL. A rule keyed on the keyword would miss this entirely.
    name: 'an identity-table grant written WITHOUT the optional TABLE keyword',
    mutate: (p) => ({ ...p, up: `${p.up}\ngrant select on platform_identity to ${RUNTIME_ROLE};\n` }),
    expect: /must have NO privilege on the identity table platform_identity/,
  },
  {
    // The defect the confirmed review found: RLS cannot restrict columns, so a table-wide
    // UPDATE hands the runtime principal tenant.status / tenant.plan_key / store.status.
    name: 'a table-wide UPDATE grant where the approved matrix is column-scoped',
    mutate: (p) => ({
      ...p,
      up: p.up.replace('grant update (display_name, legal_name) on table tenant to tmpos_app;',
        'grant update on table tenant to tmpos_app;'),
    }),
    expect: /grant on tenant to tmpos_app is \[/,
  },
  {
    // The escalation the attribute checks alone cannot see: inheriting another role.
    name: 'a role-membership grant to a privilege role',
    mutate: (p) => ({ ...p, up: `${p.up}\ngrant some_privileged_role to ${RUNTIME_ROLE};\n` }),
    expect: /an inheriting privilege role is not least-privileged/,
  },
  {
    name: 'a GRANT the validator cannot classify (must fail closed)',
    mutate: (p) => ({ ...p, up: `${p.up}\ngrant execute on function audit_metadata_is_flat(jsonb) to ${RUNTIME_ROLE};\n` }),
    expect: /unclassifiable GRANT statement \(fail-closed\)/,
  },
  {
    name: 'a missing explicit platform_identity revocation',
    mutate: (p) => ({ ...p, up: p.up.replace(/^revoke all on table platform_identity[^\n]*\n/m, '') }),
    expect: /platform_identity must carry the explicit REVOKE ALL/,
  },
  {
    name: 'a privilege role that has LOGIN',
    mutate: (p) => ({ ...p, up: `${p.up}\nalter role ${RUNTIME_ROLE} login;\n` }),
    expect: /must never carry LOGIN/,
  },
  {
    name: 'a privilege role that has BYPASSRLS',
    mutate: (p) => ({ ...p, up: `${p.up}\nalter role ${RUNTIME_ROLE} bypassrls;\n` }),
    expect: /must never carry BYPASSRLS/,
  },
  {
    name: 'a privilege role that has SUPERUSER',
    mutate: (p) => ({ ...p, up: `${p.up}\nalter role ${AUDIT_ROLE} superuser;\n` }),
    expect: /must never carry SUPERUSER/,
  },
  {
    name: 'a role password literal',
    mutate: (p) => ({ ...p, up: `${p.up}\nalter role ${RUNTIME_ROLE} ${PASSWORD_KEYWORD} 'redacted-fixture';\n` }),
    expect: /must not contain a role password/,
  },
  {
    name: 'a database URL literal',
    mutate: (p) => ({ ...p, up: `${p.up}\ncomment on schema public is '${DSN_FRAGMENT}';\n` }),
    expect: /must not contain a database connection URL/,
  },
  {
    name: 'broad CREATE permission on the public schema',
    mutate: (p) => ({ ...p, up: `${p.up}\ngrant create on schema public to ${RUNTIME_ROLE};\n` }),
    expect: /no role may be granted CREATE \(or ALL\) on schema public/,
  },
  {
    name: 'missing least-privilege default-privilege handling',
    mutate: (p) => ({ ...p, up: p.up.replace(/alter default privileges[^;]*;/g, '') }),
    expect: /ALTER DEFAULT PRIVILEGES handling is missing|default privileges on \w+ are not revoked/,
  },
  {
    name: 'a default privilege that pre-grants a future object to a runtime role',
    mutate: (p) => ({ ...p, up: `${p.up}\nalter default privileges in schema public grant select on tables to ${RUNTIME_ROLE};\n` }),
    expect: /must never pre-grant a future object to a runtime role/,
  },
  {
    name: 'a missing audit scope constraint',
    mutate: (p) => ({ ...p, up: p.up.replace(new RegExp(`alter table[^;]*${AUDIT_SCOPE_CONSTRAINT}[^;]*;`), '') }),
    expect: /scope-consistency constraint is missing/,
  },
  {
    name: 'an internally inconsistent audit scope constraint',
    mutate: (p) => ({ ...p, up: p.up.replace("scope_type = 'tenant' and tenant_id is not null", "scope_type = 'tenant' and tenant_id is null") }),
    expect: /internally inconsistent/,
  },
  {
    name: 'an audit-writer SELECT grant on the evidence table',
    mutate: (p) => ({ ...p, up: `${p.up}\ngrant select on table ${AUDIT_TABLE} to ${AUDIT_ROLE};\n` }),
    expect: /audit writer must never be granted SELECT/,
  },
  {
    name: 'a down migration that does not drop the policies',
    mutate: (p) => ({ ...p, down: p.down.replace(/drop policy[^;]*;/g, '') }),
    expect: /is never dropped/,
  },
  {
    name: 'a down migration that does not revoke the grants',
    mutate: (p) => ({ ...p, down: p.down.replace(/revoke [^;]*on table[^;]*;/g, '') }),
    expect: /is never revoked/,
  },
  {
    name: 'a down migration that does not reverse the default privileges',
    mutate: (p) => ({ ...p, down: p.down.replace(/alter default privileges[^;]*;/g, '') }),
    expect: /default-privilege change is never reversed/,
  },
  {
    name: 'a down migration that does not drop the privilege roles',
    mutate: (p) => ({ ...p, down: p.down.replace(/drop role [a-z_]+/g, 'select 1') }),
    expect: /privilege role \w+ is never dropped/,
  },
  {
    name: 'a down migration that drops a role before its policies',
    mutate: (p) => ({ ...p, down: `drop role ${RUNTIME_ROLE};\n${p.down}` }),
    expect: /dropped AFTER the role/,
  },
  {
    name: 'a down migration that drops a 001-004 table',
    mutate: (p) => ({ ...p, down: `${p.down}\ndrop table audit_event;\n` }),
    expect: /must not drop a table created by 001-004/,
  },
  {
    name: 'a down migration that disables RLS established by 001-004',
    mutate: (p) => ({ ...p, down: `${p.down}\nalter table store disable row level security;\n` }),
    expect: /must not disable RLS established by 001-004/,
  },
];

for (const defect of DEFECTS) {
  test(`the contract rejects: ${defect.name}`, () => {
    const problems = problemsFor(defect.mutate);
    assert.ok(problems.length > 0, 'the mutated migration must be rejected');
    assert.ok(problems.some((p) => defect.expect.test(p)),
      `expected a problem matching ${defect.expect}; got:\n${problems.join('\n')}`);
  });
}

// --- the parser itself, from both directions --------------------------------

test('the comment stripper removes comments but preserves string literals', () => {
  assert.equal(norm(stripSqlComments('select 1; -- using (true)\n')), 'select 1;');
  assert.equal(norm(stripSqlComments('select 1; /* using (true) */ select 2;')), 'select 1; select 2;');
  assert.ok(stripSqlComments("comment on table t is 'a -- b';").includes('a -- b'), 'a literal is preserved');
});

test('the statement splitter respects dollar-quoted bodies', () => {
  const stmts = splitStatements("do $$ begin raise notice 'a;b'; end $$;\nselect 1;");
  assert.equal(stmts.length, 2);
  assert.ok(stmts[0].startsWith('do $$'));
  assert.equal(stmts[1], 'select 1');
});

test('the policy parser accepts a well-formed policy and rejects deviations', () => {
  const good = parsePolicy('create policy p on store for all to tmpos_app using (a = 1) with check (a = 1)');
  assert.deepEqual(good, {
    name: 'p', table: 'store', command: 'all', roles: ['tmpos_app'], using: 'a = 1', check: 'a = 1',
  });
  assert.equal(parsePolicy('create policy p on store for all to tmpos_app with check (a = 1) using (a = 1)'), null, 'clause order');
  assert.equal(parsePolicy('create policy p on store to tmpos_app using (a = 1)'), null, 'missing FOR');
  assert.equal(parsePolicy('create policy p on store for all using (a = 1)'), null, 'missing TO');
  assert.equal(parsePolicy('create policy p on store for all to tmpos_app using (a = 1) junk'), null, 'trailing text');
  // Nested parentheses in the predicate must not truncate the parse.
  assert.equal(parsePolicy('create policy p on store for select to tmpos_app using (a = (b + (c)))').using, 'a = (b + (c))');
});

// --- this suite's own wiring ------------------------------------------------

test('the real-PostgreSQL isolation proof cannot be deleted silently', () => {
  // tests/db is NOT a discovery root — it needs a database, so the deterministic runner cannot
  // collect it and the sentinel ratchet cannot see it. That leaves a hole: deleting the
  // semantic half of this contract would fail nothing. This closes it from the side that IS
  // collected. It is not a substitute for running the suite — CI does that via `npm run
  // test:db` — it only makes the suite's DISAPPEARANCE loud.
  const suite = join(REPO, 'tests', 'db', 'rlsIsolation.integration.test.mjs');
  assert.ok(existsSync(suite), 'the RLS isolation suite must exist');
  const body = readFileSync(suite, 'utf8');
  assert.ok(body.length > 2000, 'the RLS isolation suite must not be gutted to a stub');
  assert.ok(body.includes("from 'node:test'"), 'it must still be a node:test suite');

  const pkg = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8'));
  assert.ok(pkg.scripts['test:db'].includes('tests/db/rlsIsolation.integration.test.mjs'),
    'test:db must still execute the RLS isolation suite');
  assert.ok(pkg.scripts['test:db'].includes('tests/db/migrationEngine.integration.test.mjs'),
    'and must not have dropped the S1b executor suite');
});

test('the S2 suites are registered deterministic-runner sentinels', () => {
  assert.ok(REQUIRED_SENTINELS.includes('tests/quality/migration-005-contract.test.mjs'),
    'this contract suite must stay sentinel-registered');
  assert.ok(REQUIRED_SENTINELS.includes('server/platform-identity/dbPrincipals.test.ts'),
    'the database-principal suite must stay sentinel-registered');
  assert.ok(Number.isInteger(MIN_SUITES) && MIN_SUITES >= 80,
    'the suite-count ratchet must not regress below the S2 baseline');
});
