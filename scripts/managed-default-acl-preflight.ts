/**
 * C2B-M005-P0 — the fixed READ-ONLY default-ACL diagnostic child.
 *
 * WHAT THIS IS. One question, asked once, over one reserved session inside one `READ ONLY`
 * transaction: what are the executing development principal's applicable global and public-schema
 * default ACLs for the object classes migration 005 governs, and would a covered blocker survive
 * the CURRENT migration 005 bytes?
 *
 * OWNER-SCOPED, NOT OWNER-INDEPENDENT. Every row read here is matched on the executing principal,
 * and a default ACL binds FUTURE OBJECTS TO WHICH THAT PRINCIPAL'S DEFAULT PRIVILEGES APPLY —
 * objects OWNED AT CREATION by that role. It is not a claim that every object the session issues
 * takes that owner (`CREATE SCHEMA ... AUTHORIZATION other` and identity/serial sequences on
 * another role's table do not), not a claim about inherited-role defaults, not a claim that
 * `ALTER ... OWNER TO` re-derives an ACL, and not a provider-wide compatibility claim.
 *
 * WHAT THIS IS NOT. It is not a migration, a migration mode, or a step toward one. It never plans,
 * executes, adopts, bootstraps a ledger, acquires an advisory lock, touches ownerAcl, modifies a
 * role, issues DDL, or calls a user-defined function. It shares no entry point with
 * `scripts/supabase-migrate.ts` and does not import it. Diagnostic completion is NOT migration
 * readiness: a favourable result authorizes nothing, and every other precondition of migration 005
 * is untouched by it.
 *
 * NOTHING HERE READS A SECRET VALUE OUT. Configuration is consumed by NAME to build the sealed
 * managed target; no value is printed, hashed, measured, or reported as set or unset. The operator
 * record is fixed labels, booleans and bounded counts only — never a catalog row, a role name, a
 * privilege name, an application identifier or a driver message.
 *
 * IMPORTING THIS MODULE DOES NOTHING. Only the exact-path entry guard at the foot starts a run.
 */

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_ACL_ROW_LIMIT,
  assertManagedDevDsn,
  assessDefaultAclPosture,
  createManagedDevExecutor,
  describeManagedDsn,
  readDefaultAclRowsBounded,
  verifyManagedDevFingerprint,
} from '../server/platform-identity/migrationExecutor';

/** The one development target this diagnostic will speak to, and the one database on it. */
export const EXPECTED_DEV_TARGET = 'tmpos2026-dev';
export const EXPECTED_DATABASE = 'postgres';

/**
 * Configuration NAMES this diagnostic consumes. Names only — never a value, and never a presence
 * probe: an absent name simply makes the sealed-target construction refuse, which is the same
 * refusal an invalid one produces.
 *
 * `ALLOW_SUPABASE_MIGRATION_APPLY` is retained ONLY because the managed connection contract seals
 * an EXACT child-environment set and this diagnostic reuses that contract unchanged. The NAME does
 * not authorize a write here, and the accurate reason is narrower than the one this comment used to
 * give. It previously claimed "this process has no write port"; that was false. The managed handle
 * `createManagedDevExecutor` returns RETAINS write-capable surfaces — an `ExecutorSession` carrying
 * `executeSql`/`beginTx`/`commitTx`, the ledger and baseline write ports, the owner-ACL revoke, and
 * a `catalog.query` that takes arbitrary statement text. What is true is that this FIXED production
 * diagnostic neither calls nor passes any of them: it calls `reserve`, the four `readOnlyTx`
 * operations, `catalog.query` with two fixed literal statements, and `dispose`. Discarding the
 * `ExecutorSession` that `reserve` returns does NOT remove those surfaces — they stay closure-scoped
 * on the handle for the life of the run. The database-side backstop is the server-verified
 * READ ONLY bracket, which refuses INSERT, UPDATE, DELETE, TRUNCATE, COPY FROM and DDL whatever this
 * process asks for. Renaming the variable would mean forking the sealed-set contract, which §2 does
 * not authorize and which would weaken the containment it provides.
 */
export const CONFIG_NAMES = Object.freeze([
  'SUPABASE_DATABASE_URL',
  'SUPABASE_URL',
  'DATABASE_CA_CERT',
  'CONFIRM_SUPABASE_TARGET',
  'ALLOW_SUPABASE_MIGRATION_APPLY',
  'NODE_ENV',
]);

/**
 * Bounded outcome vocabulary. Every value is a fixed literal; none is derived from a row, a role, a
 * privilege or a driver message.
 *
 * THERE IS NO LONGER AN `OK` CODE, AND THAT IS THE CORRECTION. `default_acl_preflight_ok` meant
 * only "the diagnostic completed", so an UNFAVOURABLE posture — A=UNMET, or a blocker surviving the
 * migration — still exited zero and still printed `outcome=..._ok`. A parent, a CI step or an
 * operator reading exit status therefore read "no blocker" from a run that had just found one. The
 * completion fact is now separated from the POSTURE fact: exactly one primary disposition can exit
 * zero, and it is the one that says the posture is met and nothing survives.
 */
export const PREFLIGHT_CODES = Object.freeze({
  /** A = MET and B = NO. The ONLY primary disposition that exits zero. */
  POSTURE_MET: 'default_acl_preflight_posture_met',
  /** A = UNMET, B = NO — the current defaults do not satisfy the postcondition. */
  POSTURE_UNMET: 'default_acl_preflight_posture_unmet',
  /** B = YES — a covered blocker survives the CURRENT migration 005 bytes. */
  SURVIVING_BLOCKER: 'default_acl_preflight_surviving_blocker',
  /** A = MET together with B = YES, or any other combination the semantics forbid. */
  POSTURE_INCONSISTENT: 'default_acl_preflight_posture_inconsistent',
  /** The reserved backend could not be re-proved identical across the diagnostic reads. */
  BACKEND_IDENTITY_CHANGED: 'default_acl_preflight_backend_identity_changed',
  PRODUCTION_FORBIDDEN: 'default_acl_preflight_production_forbidden',
  TARGET_UNCONFIRMED: 'default_acl_preflight_target_unconfirmed',
  ARGV_REJECTED: 'default_acl_preflight_argv_rejected',
  TARGET_INVALID: 'default_acl_preflight_target_invalid',
  READ_ONLY_NOT_ESTABLISHED: 'default_acl_preflight_read_only_not_established',
  READ_ONLY_LOST: 'default_acl_preflight_read_only_lost',
  IDENTITY_UNCONFIRMED: 'default_acl_preflight_identity_unconfirmed',
  FINGERPRINT_MISMATCH: 'default_acl_preflight_fingerprint_mismatch',
  EVIDENCE_UNREADABLE: 'default_acl_preflight_evidence_unreadable',
  PORT_FAILED: 'default_acl_preflight_port_failed',
  /** The READ ONLY bracket was open and its ROLLBACK did not complete. Distinct from disposal. */
  ROLLBACK_FAILED: 'default_acl_preflight_rollback_failed',
  TEARDOWN_FAILED: 'default_acl_preflight_teardown_failed',
});

/** Transaction-local bound. Every statement in the bracket is a bounded catalog read. */
export const TX_TIMEOUT_MS = 15_000;

/** The bounded development fingerprint expectations, reused unchanged from the managed contract. */
export const FINGERPRINT_EXPECTATIONS: {
  readonly requiredAuditActions: readonly string[];
  readonly activeSystemOwners: number;
  readonly suspendedSystemOwners: number;
} = Object.freeze({
  requiredAuditActions: Object.freeze([
    'bcp.platform.system_owner_provisioning',
    'bcp.platform.system_owner_provisioning_compensation',
  ]),
  activeSystemOwners: 2,
  suspendedSystemOwners: 1,
});

/** A line sink the tests can capture. Never receives a raw value, an Error, or a driver message. */
export type Emit = (line: string) => void;

/**
 * The bounded backend-continuity token, or `null` when it cannot be read.
 *
 * Returns a STRING or `null` and nothing else — the token is compared, never emitted, never parsed
 * and never reported. `null` covers a rejected call, a non-object result, a missing or non-string
 * `token`, an empty token, and a token carrying the literal `undefined`: the port formats its value
 * with `String(...)`, so a backend that answers with no pid yields `"pid:undefined"`, which is a
 * well-formed string standing for an unread value. Two such tokens would compare EQUAL and would
 * certify a continuity nothing established, so they are refused as unreadable instead.
 */
async function readBackendToken(session: unknown): Promise<string | null> {
  try {
    const port = session as { backendIdentity?: () => Promise<unknown> } | null;
    if (port === null || typeof port !== 'object' || typeof port.backendIdentity !== 'function') return null;
    const id = await port.backendIdentity();
    if (id === null || typeof id !== 'object') return null;
    const token = (id as Record<string, unknown>).token;
    if (typeof token !== 'string' || token === '' || token.includes('undefined')) return null;
    return token;
  } catch {
    // Dropped UNREAD: a driver rejection can carry a DSN or SQL. Unreadable is the bounded fact.
    return null;
  }
}

/**
 * The ONE place a bounded code becomes a process exit status.
 *
 * Extracted and exported because the previous shape could not be tested. The rule lived inline as
 * the last expression of `runDiagnostic`, and the test that appeared to guard it —
 * `Object.values(PREFLIGHT_CODES).filter((c) => c === POSTURE_MET).length === 1` — was a tautology:
 * it filtered a constant's values for equality with one of those same values and was 1 no matter
 * what the function returned. A mutation adding `POSTURE_INCONSISTENT` to the zero-exit set passed
 * the whole suite. The rule is now a pure function a table test can drive over EVERY code.
 */
export function exitCodeFor(code: string): number {
  return code === PREFLIGHT_CODES.POSTURE_MET ? 0 : 2;
}

/** The one place the A/B pair becomes a primary disposition. Pure, and exhaustive by construction. */
export function choosePosture(
  assessment: {
    principalAgreement: string;
    postcondition: 'MET' | 'UNMET' | 'UNREADABLE';
    blockerSurvivesCurrentM005: 'YES' | 'NO' | 'UNREADABLE';
  },
  overflowed: boolean,
): string {
  const a = assessment.postcondition;
  const b = assessment.blockerSurvivesCurrentM005;
  if (overflowed || a === 'UNREADABLE' || b === 'UNREADABLE' || assessment.principalAgreement !== 'AGREED') {
    return PREFLIGHT_CODES.EVIDENCE_UNREADABLE;
  }
  if (a === 'MET' && b === 'YES') return PREFLIGHT_CODES.POSTURE_INCONSISTENT;
  if (b === 'YES') return PREFLIGHT_CODES.SURVIVING_BLOCKER;
  if (a === 'UNMET') return PREFLIGHT_CODES.POSTURE_UNMET;
  return PREFLIGHT_CODES.POSTURE_MET;
}

/**
 * The whole diagnostic, as a sequence over injected ports.
 *
 * Split out from `main` so the deterministic suite can drive the ENTIRE ordering — including that
 * `begin()` precedes every query — against fake ports, with no client, no environment and no
 * process. `deps` exists for that and for nothing else; production passes none of it.
 *
 * THIS IS A STATE MACHINE, NOT A `try/finally`, AND THAT IS THE CORRECTION.
 *
 * A `return 0` chosen inside a protected block IS the function's completion value the moment it
 * executes. A later `finally` may run, may emit, and may assign to any variable it likes — unless it
 * returns or throws, it cannot change the value already selected. The previous shape did exactly
 * that: on a favourable verdict it returned 0 inside the `try`, then its `finally` emitted
 * `teardown_failed` and, one line later, `outcome=default_acl_preflight_ok`, and 0 was still the
 * answer. Assigning a status variable inside that `finally` would not have helped for the same
 * reason. So the primary diagnostic now RECORDS a bounded code instead of returning, cleanup runs
 * afterwards on the ordinary path, and the returned number is chosen ONCE, at the end, from the
 * primary fact and the cleanup facts together.
 *
 * The label + `break primary` is deliberate: it keeps the early-exit shape of the original without
 * a nested closure, so every exit is a recorded fact rather than a completion value.
 */
export async function runDiagnostic(
  source: NodeJS.ProcessEnv,
  emit: Emit,
  deps: {
    createExecutor?: typeof createManagedDevExecutor;
    assertDsn?: typeof assertManagedDevDsn;
    describeDsn?: typeof describeManagedDsn;
    fingerprint?: typeof verifyManagedDevFingerprint;
    readAcl?: typeof readDefaultAclRowsBounded;
  } = {},
): Promise<number> {
  // ---- gates, before anything that could open a socket -----------------------
  //
  // NOTHING IS CONSTRUCTED YET, so returning here cannot skip a rollback or a disposal: there is no
  // handle, no bracket and no cleanup record to write. Every later exit goes through the state
  // machine below instead.
  if (source.NODE_ENV === 'production') {
    emit(`[acl-preflight] REFUSED: ${PREFLIGHT_CODES.PRODUCTION_FORBIDDEN}`);
    return 2;
  }
  if (source.CONFIRM_SUPABASE_TARGET !== EXPECTED_DEV_TARGET) {
    // NAME only. Whether the variable is absent or merely different is not reported — both are the
    // same refusal, which is what keeps this from becoming a presence probe.
    emit(`[acl-preflight] REFUSED: ${PREFLIGHT_CODES.TARGET_UNCONFIRMED} name=CONFIRM_SUPABASE_TARGET`);
    return 2;
  }

  const assertDsn = deps.assertDsn ?? assertManagedDevDsn;
  const describe = deps.describeDsn ?? describeManagedDsn;
  const create = deps.createExecutor ?? createManagedDevExecutor;
  const fingerprint = deps.fingerprint ?? verifyManagedDevFingerprint;
  const readAcl = deps.readAcl ?? readDefaultAclRowsBounded;

  let handle: Awaited<ReturnType<typeof createManagedDevExecutor>> | null = null;
  let opened = false;
  // FAIL-CLOSED INITIAL VALUE. Every path either records a refusal or records a posture
  // disposition; if a future edit ever adds one that does neither, the run reports unreadable
  // evidence and exits nonzero rather than inheriting a favourable default.
  /** The PRIMARY fact only. Never this function's completion value — see the header. */
  let primaryCode: string = PREFLIGHT_CODES.EVIDENCE_UNREADABLE;

  primary: try {
    // The sealed target is constructed and validated BEFORE a client exists. A mismatch between the
    // DSN and the independently configured project URL refuses here, with no socket opened.
    const dsn = assertDsn(source.SUPABASE_DATABASE_URL, source.SUPABASE_URL, EXPECTED_DATABASE);
    const shape = describe(dsn);
    if (shape.database !== EXPECTED_DATABASE) {
      primaryCode = PREFLIGHT_CODES.TARGET_INVALID;
      emit(`[acl-preflight] REFUSED: ${PREFLIGHT_CODES.TARGET_INVALID}`);
      break primary;
    }
    emit(`[acl-preflight] target endpointFamily=${shape.endpointFamily} database=${shape.database}`);

    handle = await create(dsn);
    // The reserved session is CAPTURED now, not discarded. It is used for exactly one thing —
    // `backendIdentity()`, the bounded continuity token below. Its write-capable members
    // (`executeSql`, `beginTx`, `commitTx`, the lock ports) are never called; capturing the object
    // adds no surface that the handle was not already holding closure-scoped for the whole run.
    const session = await handle.adapter.reserve('session');

    // ---- the READ ONLY bracket, opened BEFORE any diagnostic query -----------
    //
    // DRIVER-INTERNAL READS BEFORE BEGIN, stated rather than omitted: postgres.js performs its own
    // connection setup round-trips when the socket is established (its startup exchange and the
    // parameter negotiation it caches). Those are the DRIVER's, are unchanged by this stage, and
    // are not operator-supplied diagnostic queries. This process issues NONE of its own queries
    // before the line below.
    await handle.readOnlyTx.begin();
    opened = true;
    await handle.readOnlyTx.applyLocalTimeouts(TX_TIMEOUT_MS);

    if ((await handle.readOnlyTx.isReadOnly()) !== true) {
      primaryCode = PREFLIGHT_CODES.READ_ONLY_NOT_ESTABLISHED;
      emit(`[acl-preflight] REFUSED: ${PREFLIGHT_CODES.READ_ONLY_NOT_ESTABLISHED}`);
      break primary;
    }
    emit('[acl-preflight] transaction readOnly=true');

    // ---- backend continuity, capture 1 -----------------------------------------
    //
    // WHY THIS EXISTS. Every guarantee this diagnostic makes about session pinning was structural:
    // one `max: 1` pool, one `reserve`, every operation through a `requireConn()` that THROWS rather
    // than opening a new backend, and no `close`/`terminate` on this path. Structural is not the
    // same as observed. A transparent driver-level reconnect between the identity read and the ACL
    // read would have gone undetected, and the emitted record carried no session identifier by which
    // a reader could have detected it either. The token closes that: the identity the verdict is
    // ATTRIBUTED to and the identity the ACL rows were READ ON are now proved to be one backend.
    //
    // Captured AFTER the READ ONLY bracket is server-verified, so a token can never be the first
    // thing this process learns from an unbracketed session.
    //
    // AN UNREADABLE FIRST TOKEN IS NOT A CHANGE. Nothing has been established yet, so there is
    // nothing for it to differ from, and reporting `backend_identity_changed` here would assert an
    // observation this run never made. The accurate bounded code is unreadable evidence. The second
    // capture is the one that may legitimately conflate the two — see there.
    const firstToken = await readBackendToken(session);
    if (firstToken === null) {
      primaryCode = PREFLIGHT_CODES.EVIDENCE_UNREADABLE;
      emit(`[acl-preflight] REFUSED: ${PREFLIGHT_CODES.EVIDENCE_UNREADABLE}`);
      break primary;
    }

    // ---- identity -------------------------------------------------------------
    const who = await handle.catalog.query(
      'select current_user as principal, session_user as session_principal, current_database() as db', [],
    );
    const principal = who[0]?.principal;
    const sessionPrincipal = who[0]?.session_principal;
    const database = who[0]?.db;
    if (typeof principal !== 'string' || principal === ''
        || typeof sessionPrincipal !== 'string' || sessionPrincipal === ''
        || database !== EXPECTED_DATABASE) {
      primaryCode = PREFLIGHT_CODES.IDENTITY_UNCONFIRMED;
      emit(`[acl-preflight] REFUSED: ${PREFLIGHT_CODES.IDENTITY_UNCONFIRMED}`);
      break primary;
    }
    // AGREEMENT ONLY. Neither role NAME is printed: the record states whether the two agree, which
    // is the whole diagnostic question, and nothing about who they are.
    emit(`[acl-preflight] principal currentMatchesSession=${String(principal === sessionPrincipal)}`);
    // AND THE AGREEMENT IS NOW ENFORCED, NOT MERELY REPORTED.
    //
    // Every default-ACL row this diagnostic reads is scoped to `current_user`, so under a mismatch
    // the verdict would describe defaults for a role the SESSION never proved it is running as.
    // Reporting the disagreement and then answering anyway was the defect: a favourable A/B pair
    // could be issued about an unestablished principal, and the pure assessment would not downgrade
    // it either. The run stops HERE — before the fingerprint, before the catalog read, and before
    // any verdict-shaped line exists to be misread.
    //
    // WHAT THIS DELIBERATELY DOES NOT DO: no role name is printed, no membership is discovered, and
    // no SET ROLE / RESET ROLE is issued. The owner binding stays server-derived; this gate only
    // ever refuses, and never widens what the diagnostic is allowed to speak for.
    if (principal !== sessionPrincipal) {
      primaryCode = PREFLIGHT_CODES.IDENTITY_UNCONFIRMED;
      emit(`[acl-preflight] REFUSED: ${PREFLIGHT_CODES.IDENTITY_UNCONFIRMED}`);
      break primary;
    }
    emit(`[acl-preflight] database targetAgreement=${String(database === EXPECTED_DATABASE)}`);

    // ---- application fingerprint: MATCH / MISMATCH only ------------------------
    const fpFailures = await fingerprint(handle.catalog, FINGERPRINT_EXPECTATIONS);
    const fp = fpFailures.length === 0 ? 'MATCH' : 'MISMATCH';
    // The failure STRINGS are consumed here and never emitted: they can name an application
    // identifier, and no application row or identifier may reach operator output.
    emit(`[acl-preflight] applicationFingerprint=${fp}`);
    if (fp === 'MISMATCH') {
      primaryCode = PREFLIGHT_CODES.FINGERPRINT_MISMATCH;
      emit(`[acl-preflight] REFUSED: ${PREFLIGHT_CODES.FINGERPRINT_MISMATCH}`);
      break primary;
    }

    // ---- the bounded default-ACL read -----------------------------------------
    const read = await readAcl(handle.catalog, DEFAULT_ACL_ROW_LIMIT);

    // ---- backend continuity, capture 2 -----------------------------------------
    //
    // EXACT AGREEMENT, and NO VERDICT WITHOUT IT. An unreadable second token and a token that
    // differs are the same refusal on purpose: both mean the run cannot prove the rows it just read
    // came from the backend whose identity it checked, and a bounded record has no honest way to
    // report a verdict qualified by "probably the same session". No retry and no reconnect — this is
    // the end of the run. The token itself is NEVER emitted; only the agreement is.
    const secondToken = await readBackendToken(session);
    const continuous = secondToken !== null && secondToken === firstToken;
    emit(`[acl-preflight] backendContinuity=${continuous ? 'AGREED' : 'BROKEN'}`);
    if (!continuous) {
      primaryCode = PREFLIGHT_CODES.BACKEND_IDENTITY_CHANGED;
      emit(`[acl-preflight] REFUSED: ${PREFLIGHT_CODES.BACKEND_IDENTITY_CHANGED}`);
      break primary;
    }

    // ---- read-only state re-verified AFTER the diagnostic queries --------------
    if ((await handle.readOnlyTx.isReadOnly()) !== true) {
      primaryCode = PREFLIGHT_CODES.READ_ONLY_LOST;
      emit(`[acl-preflight] REFUSED: ${PREFLIGHT_CODES.READ_ONLY_LOST}`);
      break primary;
    }

    // ---- and ONLY NOW is a verdict computed or spoken ---------------------------
    const assessment = assessDefaultAclPosture(principal, sessionPrincipal, read);

    emit(`[acl-preflight] rowsBounded limit=${String(DEFAULT_ACL_ROW_LIMIT)} overflowed=${String(read.overflowed)}`);
    emit(`[acl-preflight] principalAgreement=${assessment.principalAgreement}`);
    for (const [label, base] of Object.entries(assessment.globalBase)) {
      emit(`[acl-preflight] globalBase.${label}=${base}`);
    }
    emit(`[acl-preflight] schemaGrantsToCoveredGrantees=${assessment.schemaGrantsToCoveredGrantees}`);
    emit(`[acl-preflight] A.currentDefaultAclPostcondition=${assessment.postcondition}`);
    emit(`[acl-preflight] B.blockerSurvivesCurrentM005=${assessment.blockerSurvivesCurrentM005}`);
    emit(`[acl-preflight] findingCount=${String(assessment.findingCount)}`);
    // SAID EVERY TIME, including on the favourable result. A diagnostic that completes has answered
    // one question; it has not established the other preconditions of migration 005 and authorizes
    // nothing.
    emit('[acl-preflight] diagnosticCompletion=DISTINCT_FROM_MIGRATION_READINESS');

    // ---- the PRIMARY DISPOSITION, chosen from the posture itself ----------------
    //
    // Order is load-bearing. `POSTURE_INCONSISTENT` is tested BEFORE `SURVIVING_BLOCKER` so that an
    // A=MET/B=YES pair — which the semantics forbid, since a surviving blocker is itself a failed
    // postcondition — is reported as the contradiction it is rather than silently absorbed into the
    // blocker case. Unreadable evidence outranks both: a category that could not be read cannot be
    // compared with another.
    primaryCode = choosePosture(assessment, read.overflowed);
    emit(`[acl-preflight] disposition=${primaryCode}`);
    if (primaryCode !== PREFLIGHT_CODES.POSTURE_MET) {
      emit(`[acl-preflight] REFUSED: ${primaryCode}`);
    }
  } catch {
    // The thrown value is dropped UNREAD: it can carry a DSN, a credential or SQL. Only the bounded
    // fact crosses. There is no retry, no alternate connection, no endpoint change, no TLS
    // relaxation, no compensation and no automatic continuation — this is the end of the run.
    primaryCode = PREFLIGHT_CODES.PORT_FAILED;
    emit(`[acl-preflight] REFUSED: ${PREFLIGHT_CODES.PORT_FAILED}`);
  }

  // ---- cleanup: attempted at most once each, BEFORE any completion is chosen --
  const cleanup = {
    rollback: 'not_required' as 'not_required' | 'completed' | 'failed',
    disposalRequested: false,
    disposalCompleted: false,
    gracefulSocketClose: 'not_observed',
  };

  if (handle !== null) {
    if (opened) {
      try {
        await handle.readOnlyTx.finish();
        cleanup.rollback = 'completed';
      } catch {
        // The thrown value is dropped UNREAD — it can carry SQL or a DSN — but the FACT is kept.
        // That is what the previous shape lost: the failure was swallowed with no code, no line and
        // no effect on the result, under a comment claiming it was "bounded by the line below".
        // That claim was false. Disposal is a DIFFERENT operation: a completed teardown says the
        // client shut down, and says nothing whatever about whether the ROLLBACK succeeded.
        cleanup.rollback = 'failed';
      }
    }
    // ATTEMPTED EVEN AFTER A FAILED ROLLBACK, and deliberately so: the transaction dies with the
    // session, so disposal is the step that actually ends it. Skipping it because the rollback
    // failed would abandon the very backend the rollback could not clean.
    let teardown: unknown = null;
    try {
      teardown = await handle.dispose();
    } catch {
      // A REJECTED disposal is a bounded failure, never a message or a stack. Production's
      // `dispose()` does not reject; this exists so a shape that does cannot reach the caller raw.
      teardown = null;
    }
    // STRICT POSITIVE EVIDENCE — both fields, literal `true`. Missing, malformed, non-boolean,
    // truthy-but-not-true and rejected all land in the same place: not proven complete, so failed.
    //
    // READING IT IS ITSELF GUARDED. A property access is not obviously fallible, but an object whose
    // `requested`/`completed`/`gracefulSocketClose` are throwing accessors would send that throw
    // straight past this block and skip the outcome decision below. Malformed evidence must fail the
    // run, never escape it, so the read is bounded exactly like the call was.
    try {
      const t = (teardown !== null && typeof teardown === 'object')
        ? teardown as Record<string, unknown>
        : null;
      cleanup.disposalRequested = t?.requested === true;
      cleanup.disposalCompleted = t?.completed === true;
      // NEVER a claim about the socket. `client.end({timeout:0})` destroys it and reports nothing
      // about a graceful FIN exchange, so the only value echoed is the port's own 'not_observed';
      // ANY other value — including a port claiming a graceful close — is reported as unknown rather
      // than believed, because this process has no evidence either way.
      cleanup.gracefulSocketClose = t?.gracefulSocketClose === 'not_observed' ? 'not_observed' : 'unknown';
    } catch {
      cleanup.disposalRequested = false;
      cleanup.disposalCompleted = false;
      cleanup.gracefulSocketClose = 'unknown';
    }

    emit(`[acl-preflight] cleanup rollback=${cleanup.rollback}`
      + ` disposalRequested=${String(cleanup.disposalRequested)}`
      + ` disposalCompleted=${String(cleanup.disposalCompleted)}`
      + ` gracefulSocketClose=${cleanup.gracefulSocketClose}`);
    // `REFUSED:` IS THIS FILE'S REFUSAL MARKER, and cleanup failures now carry it too. They did not,
    // and a favourable posture whose rollback or disposal failed therefore produced a transcript in
    // which every `REFUSED:` line was absent and only `outcome=` disagreed with the verdict above it.
    // The exit code was already correct; the RECORD read like a clean run to anything keying on the
    // marker the rest of the file establishes.
    if (cleanup.rollback === 'failed') emit(`[acl-preflight] REFUSED: ${PREFLIGHT_CODES.ROLLBACK_FAILED}`);
    if (!(cleanup.disposalRequested && cleanup.disposalCompleted)) {
      emit(`[acl-preflight] REFUSED: ${PREFLIGHT_CODES.TEARDOWN_FAILED}`);
    }
  }

  // ---- the ONE completion decision, taken after cleanup has settled -----------
  //
  // CLEANUP WINS THE OUTCOME CODE when it failed: it is the fact about whether anything may still be
  // running, and it must be able to overrule a favourable verdict. A primary refusal, when there was
  // one, is already on its own REFUSED line above, so neither fact is lost — and a primary failure
  // still fails on its own when cleanup succeeded, because `primaryCode` is then the code chosen.
  const disposalFailed = handle !== null && !(cleanup.disposalRequested && cleanup.disposalCompleted);
  const cleanupCode = cleanup.rollback === 'failed'
    ? PREFLIGHT_CODES.ROLLBACK_FAILED
    : (disposalFailed ? PREFLIGHT_CODES.TEARDOWN_FAILED : null);
  const code = cleanupCode ?? primaryCode;
  emit(`[acl-preflight] outcome=${code}`);
  // EXACTLY ONE CODE EXITS ZERO. Completion is no longer sufficient: an unfavourable posture, an
  // inconsistent one, unreadable evidence, a broken backend identity and every cleanup failure all
  // land here as a nonzero result, and the launcher classifies any nonzero child as failure.
  return exitCodeFor(code);
}

export async function main(
  argv: readonly string[] = process.argv.slice(2),
  source: NodeJS.ProcessEnv = process.env,
  emit: Emit = (line) => console.log(line),
  // TEST SEAM ONLY, and defaulted so production cannot populate it: the entry guard below calls
  // `main()` with no arguments at all, so this is `{}` on every real run. It exists so the
  // deterministic suite can prove a cleanup failure reaches THIS function's completion value rather
  // than only an extracted helper's.
  deps: Parameters<typeof runDiagnostic>[2] = {},
): Promise<number> {
  // NO arguments. This child has exactly one behaviour, so any argument at all is a refusal rather
  // than something to ignore — an ignored argument is how a fixed command grows an option.
  if (argv.length !== 0) {
    emit(`[acl-preflight] REFUSED: ${PREFLIGHT_CODES.ARGV_REJECTED}`);
    return 2;
  }
  return await runDiagnostic(source, emit, deps);
}

// Entry guard: EXACT PATH IDENTITY, not a suffix test — a suffix test is satisfied by any entry
// script whose name merely ends in this one, which would import this module for its exports and
// open a real connection as a side effect. Importing this module must do nothing.
if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  void main().then(
    (c) => { process.exitCode = c; },
    () => { process.exitCode = 2; },
  );
}
