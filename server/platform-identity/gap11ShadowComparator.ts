// Phase 4.0 M5-GAP11-P1 — dual-read shadow comparator, kept as a DIAGNOSTIC-ONLY historical artifact.
//
// SUPERSEDED. This comparator shadow-read the pinned candidate (the unified global ordering with D2's
// default grants and D3's now-retired compatibility pins) — the evaluator a cutover to a single global
// ordering would have installed. M5-GAP11-P5 rejected that cutover in favour of family-specific
// orderings (src/authorization/permissionFamilies.ts), so there is no longer a pinned candidate to
// shadow: `evaluatePinnedCandidate` and the D3 pins it depended on are retired. This module now shadows
// the pre-pin post-D2 candidate (`evaluateAfterRepinCandidate`) purely as a diagnostic historical
// comparator — it is wired into no request path, decides nothing, and its divergences are simply the
// (already known, already rejected) differences between today's family-aware authority and the
// abandoned global-ordering proposal.
//
// THE AUTHORITATIVE ANSWER IS AN INPUT, NOT SOMETHING THIS MODULE COMPUTES. The caller has already
// made its decision when it calls `compare`; it passes that decision in and gets it back — or a
// denial, when the decision or the tuple it concerns is not admissible (never the reverse). That
// shape is deliberate and does three things at once:
//   * it makes fail-open structurally impossible — there is no code path on which a candidate result
//     becomes the returned value, because the candidate is never assigned to it;
//   * it satisfies the original "run both in parallel" shadow-read shape honestly — one policy is
//     evaluated by the caller, the other here, on the same input;
//   * it avoids a duplicate evaluation of the authoritative policy, which would evaluate it twice and
//     invite the two copies to disagree.
//
// WHAT A MISMATCH MAY CONTAIN. Canonical vocabulary and outcome codes only: plane, stratum, role id,
// domain/feature id, action id, level token, the tuple's own structural and D2 classifications, the
// two outcomes. No user id, no email, no token, no
// cookie, no session, no tenant or store record, no request, no header, no IP, no timestamp, no free
// text. A divergence record is a statement about the CATALOG, not about a person — the catalog is
// the same for everyone holding the role, so nothing identifying is needed to act on it.
//
// WHERE MISMATCHES GO. To an injected observer, or to the comparator's own bounded buffer. There is
// no approved telemetry sink, so this module adds none, and it does not log: a console write is an
// unbounded, unredacted sink wearing a different hat. No network, no database, no file, no env var,
// no process global.
//
// WHICH CANDIDATE. The post-D2 candidate (evaluateAfterRepinCandidate): the (rejected) unified ordering
// with owner decision D2's default money-action grants — never the D3-pinned view, which is retired.
// Every divergence recorded here is therefore a KNOWN, HISTORICAL difference from the abandoned
// global-ordering proposal, not a live risk.
//
// NOT A CUTOVER, AND NEVER WAS. Enabling this changes no decision anywhere. The candidate stays
// observational and diagnostic-only.
import {
  canonicalTupleFor,
  evaluateAfterRepinCandidate,
  snapshotContext,
  type CanonicalGrantTuple,
  type D2Classification,
  type GrantEvaluationContext,
  type GrantOutcome,
  type GrantPlane,
  type GrantStratum,
} from './gap11GrantDiff';
import type { PermissionLevelValue } from './authorizationConstants';

type Level = PermissionLevelValue;

/** Why a record exists. `divergence` is the diagnostic one; the others are failures to observe. */
export type ShadowMismatchKind =
  /** Both policies answered; they disagreed. */
  | 'divergence'
  /**
   * The candidate evaluator threw. Recorded, never allowed to affect the returned decision. No input
   * reaches this today — the candidate only ever sees a canonical tuple and a frozen context copy — so
   * it is defence in depth: a future candidate defect is recorded rather than silently lost.
   */
  | 'candidate_error'
  /**
   * The evaluation context is not one: it throws while being read, or a field is missing, of the
   * wrong shape, or unknown. No candidate is attempted.
   */
  | 'malformed_context'
  /** The caller supplied something that is not a decision. Returned as a denial, fail closed. */
  | 'malformed_authoritative'
  /**
   * The tuple is not one of the universe's canonical tuples — malformed, unknown (an unknown required
   * level included), or a mismatched combination of known parts. It is DENIED before any comparison:
   * no candidate is attempted, no caller field is recorded, and nothing about it is read as a `none`
   * requirement (the record's level is null, never `none`).
   */
  | 'malformed_tuple';

/** A bounded divergence record. Vocabulary and outcome codes only — see the header. */
export interface ShadowMismatch {
  readonly kind: ShadowMismatchKind;
  readonly plane: GrantPlane | 'unknown';
  readonly stratum: GrantStratum | 'unknown';
  readonly role: string;
  readonly scope: string;
  readonly action: string;
  readonly requiredLevel: Level | null;
  /** Structural: the tuple's decisive level is `approve`. False when there is no canonical tuple. */
  readonly requiresApproveLevel: boolean;
  /** Whether D2 governs the tuple; null when there is no canonical tuple to classify. */
  readonly d2Classification: D2Classification | null;
  readonly moneyAction: string | null;
  /** The decision the comparator returned: the caller's, or `denied` when that was not admissible. */
  readonly authoritative: GrantOutcome;
  /** What the post-D2 candidate would have said. `null` when it could not be obtained. */
  readonly candidate: GrantOutcome | null;
}

export type ShadowObserver = (mismatch: ShadowMismatch) => void;

export interface ShadowComparatorOptions {
  /**
   * Where divergences go. Optional: with no observer they land in the comparator's own bounded
   * buffer, readable through `records()`. An observer that throws is contained — a broken sink must
   * not be able to influence an authorization outcome.
   */
  readonly observer?: ShadowObserver;
  /** Hard cap on retained records. Beyond it, records are dropped and counted, never accumulated. */
  readonly maxRecords?: number;
}

export interface ShadowComparator {
  /**
   * Record whether the (retired) candidate ordering would have answered differently, and return the
   * caller's own decision, unchanged. THE RETURN VALUE IS ALWAYS THE `authoritative` ARGUMENT — except
   * when that argument is not a decision at all, or the tuple is not one of the universe's canonical
   * tuples, in which case the answer is `denied`. Both exceptions only ever deny; neither consults the
   * candidate.
   */
  compare(
    tuple: CanonicalGrantTuple,
    ctx: GrantEvaluationContext,
    authoritative: GrantOutcome,
  ): GrantOutcome;
  /** The retained records, oldest first. */
  records(): readonly ShadowMismatch[];
  /** How many records were dropped after `maxRecords` was reached. */
  dropped(): number;
}

const DEFAULT_MAX_RECORDS = 256;

function isOutcome(v: unknown): v is GrantOutcome {
  return v === 'granted' || v === 'denied';
}

/**
 * A record built only from the universe's own frozen tuple, or from fixed placeholders when there is
 * none. No caller-supplied string is ever copied into a record, so every record is catalog vocabulary
 * and its size is bounded by the catalog, whatever the caller passed.
 */
function record(
  kind: ShadowMismatchKind,
  t: CanonicalGrantTuple | null,
  authoritative: GrantOutcome,
  candidate: GrantOutcome | null,
): ShadowMismatch {
  return Object.freeze({
    kind,
    plane: t === null ? ('unknown' as const) : t.plane,
    stratum: t === null ? ('unknown' as const) : t.stratum,
    role: t === null ? '' : t.role,
    scope: t === null ? '' : t.scope,
    action: t === null ? '' : t.action,
    requiredLevel: t === null ? null : t.requiredLevel,
    requiresApproveLevel: t === null ? false : t.requiresApproveLevel,
    d2Classification: t === null ? null : t.d2Classification,
    moneyAction: t === null ? null : t.moneyAction,
    authoritative,
    candidate,
  });
}

export function createShadowComparator(options: ShadowComparatorOptions = {}): ShadowComparator {
  // Options are read once, here, each in its own guard, so one unreadable option cannot cost another
  // its value. An observer or cap that throws, or has the wrong type, leaves its default in place.
  let observer: ShadowObserver | undefined;
  let max = DEFAULT_MAX_RECORDS;
  const given: ShadowComparatorOptions = typeof options === 'object' && options !== null ? options : {};
  try {
    const o = given.observer;
    if (typeof o === 'function') observer = o;
  } catch {
    // unreadable ⇒ no observer
  }
  try {
    const m = given.maxRecords;
    if (typeof m === 'number' && Number.isInteger(m) && m >= 0) max = m;
  } catch {
    // unreadable ⇒ the default cap
  }
  const buffer: ShadowMismatch[] = [];
  let droppedCount = 0;

  function emit(m: ShadowMismatch): void {
    if (buffer.length < max) buffer.push(m); else droppedCount += 1;
    if (observer === undefined) return;
    try {
      // An async sink's rejection is settled here too: an unhandled rejection would end the process.
      void Promise.resolve(observer(m)).catch(() => {});
    } catch {
      // A sink that throws is a broken sink, not an authorization event.
    }
  }

  return {
    compare(tuple, ctx, authoritative) {
      // The tuple is parsed first, once: vocabulary, never a grant. canonicalTupleFor reads each field
      // once and returns null rather than throwing; the catch is belt and braces.
      let canonical: CanonicalGrantTuple | null;
      try {
        canonical = canonicalTupleFor(tuple);
      } catch {
        canonical = null;
      }
      // The answer is fixed before anything is observed. A non-decision, or a tuple that is not one of
      // the universe's own — an unknown required level included — is `denied` before any comparison:
      // it is never compared, and never read as an ordinary `none` requirement. Coercing to `denied`
      // can never turn a denial into an allowance, which is the one direction that matters.
      const decision: GrantOutcome = isOutcome(authoritative) && canonical !== null ? authoritative : 'denied';

      // Everything below is observation, and all of it is inside one catch-all: a hostile tuple,
      // context or observer can cost a record, never the decision.
      try {
        if (!isOutcome(authoritative)) {
          emit(record('malformed_authoritative', canonical, 'denied', null));
        } else if (canonical === null) {
          // Not one of the universe's tuples — malformed, unknown, or a mismatched combination of
          // known parts. Observed with placeholders, never guessed at.
          emit(record('malformed_tuple', null, decision, null));
        } else {
          // The context is read once, here; the candidate sees only the frozen copy. One it cannot
          // read is a failure to observe, not a policy divergence.
          const context = snapshotContext(ctx, canonical.plane);
          if (context === null) {
            emit(record('malformed_context', canonical, decision, null));
          } else {
            // The shadow read: one candidate evaluation, on the universe's own tuple.
            let candidate: GrantOutcome | null = null;
            try {
              candidate = evaluateAfterRepinCandidate(canonical, context);
            } catch {
              candidate = null;
            }
            if (candidate === null) emit(record('candidate_error', canonical, decision, null));
            else if (candidate !== decision) emit(record('divergence', canonical, decision, candidate));
            // Exact agreement produces no record at all.
          }
        }
      } catch {
        // Observation failed; the decision stands.
      }

      // The single return. It is the caller's own decision; the candidate is never returned.
      return decision;
    },

    records() {
      return Object.freeze(buffer.slice());
    },

    dropped() {
      return droppedCount;
    },
  };
}
