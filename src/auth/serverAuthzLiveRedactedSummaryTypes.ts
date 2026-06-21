// Phase 1.6 M17.1 — Safe Live-Authorization Output Redaction: TYPES ONLY.
//
// PURPOSE: declare the SHAPE of (a) the M14-style feed result the dormant redaction
// projection accepts as INPUT, and (b) the NON-SECRET, COUNTS-AND-BOOLEANS-ONLY
// summary it returns as OUTPUT. This file is INERT:
//   - TypeScript types ONLY — no runtime values, no side effects, no env reads, no
//     fetch, no import-time execution, no top-level await.
//   - Imports NOTHING (no app module, no server module, no SDK). The input type is a
//     STRUCTURAL MIRROR of the M14 `ServerAuthzShadowFeedResult` / M13
//     `ServerAuthzShadowComparisonResult` (declared HERE, not imported) so the dormant
//     redaction layer takes a runtime dependency on NO existing module — the same
//     decoupling pattern M13/M14 use.
//   - Imported only by `serverAuthzLiveRedactedSummary.ts` and (via `import type`,
//     erased) by the M17.1 dormancy diagnostic.
//
// OUTPUT SAFETY (binding): the OUTPUT summary carries ONLY a redaction phase, transport
// `ok`/`status`, safe phase-enum passthrough strings, a presence boolean, a high-level
// safe reason label, parity booleans, and per-key-space COUNT summaries. It NEVER
// carries — and the projection NEVER emits — a raw authorization DTO, raw route body,
// raw comparison object, permission / sub-permission / entitlement KEY NAMES,
// `missingFromServerKeys` / `unknownToFrontendKeys` arrays, mismatch key lists,
// permission LEVEL values, role names/ids, tenant/store/plan/user ids, provider uid,
// email, tokens, headers, or request/response bodies.
//
// INPUT NOTE: the INPUT key-space type references the M13 mismatch array FIELD NAMES so
// the projection can derive a COUNT from each array's `.length` — but it types them as
// length-bearing shapes (`{ length?: number }`), never as `string[]` of key names, so
// even the INPUT type declares NO array-of-key-names field. A real `string[]` is
// structurally assignable to `{ length?: number }`, so a live M14 result is accepted.

// =============================================================================
// Redaction outcome phase
// =============================================================================

/**
 * Outcome phase of a single redaction projection, in honest fail-closed order:
 *   - 'summarized'  → input carried a non-null server authorization comparison; the
 *                     three key-spaces were reduced to COUNTS + parity booleans (all
 *                     key-name arrays dropped). COMPARABLE ONLY — never authoritative.
 *   - 'unavailable' → input was a recognized result but server authorization was absent
 *                     / not evaluated / non-200 / short-circuited. Only the safe
 *                     transport status + phase are preserved (no key-space detail).
 *   - 'malformed'   → input was null / undefined / not an object, OR a non-null
 *                     comparison could not be safely summarized. Fails closed to a safe
 *                     empty summary; NEVER throws and NEVER echoes input.
 */
export type ServerAuthzLiveRedactedSummaryPhase =
  | 'summarized'
  | 'unavailable'
  | 'malformed';

// =============================================================================
// INPUT — structural mirror of the M14 feed result (NOT imported)
// =============================================================================

/**
 * One key-space of the M13 comparison, as the projection consumes it. Only COUNT
 * fields and the two mismatch-array `.length`s are ever read; key NAMES are never read,
 * copied, or retained. The mismatch arrays are typed as length-bearing shapes so this
 * type declares NO array-of-key-names field while still accepting a live `string[]`.
 */
export interface RedactedKeySpaceInput {
  /** Structural parity flag for this key-space (boolean only). */
  readonly parity?: boolean;
  /** Count of known frontend vocabulary keys for this key-space. */
  readonly frontendKeyCount?: number;
  /** Count of distinct keys present on the server-derived map. */
  readonly serverKeyCount?: number;
  /** Count of server keys recognized by the frontend vocabulary. */
  readonly matchedKeyCount?: number;
  /** Length-bearing shape ONLY — the projection reads `.length`, never the names. */
  readonly missingFromServerKeys?: { readonly length?: number } | null;
  /** Length-bearing shape ONLY — the projection reads `.length`, never the names. */
  readonly unknownToFrontendKeys?: { readonly length?: number } | null;
}

/**
 * The M13 comparison object as the projection consumes it (all fields optional;
 * key-name arrays excluded by construction). Structurally compatible with the live
 * `ServerAuthzShadowComparisonResult`.
 */
export interface ServerAuthzShadowComparisonLikeInput {
  readonly phase?: string;
  readonly serverAuthzPresent?: boolean;
  readonly overallParity?: boolean;
  readonly permissionKeyParity?: boolean;
  readonly subPermissionKeyParity?: boolean;
  readonly entitlementKeyParity?: boolean;
  readonly permissionKeySpace?: RedactedKeySpaceInput | null;
  readonly subPermissionKeySpace?: RedactedKeySpaceInput | null;
  readonly entitlementKeySpace?: RedactedKeySpaceInput | null;
}

/**
 * The M14-style feed result the projection accepts. Structurally compatible with the
 * live `ServerAuthzShadowFeedResult`. NOTE: `message` is intentionally NOT read by the
 * projection (it emits its own phase-derived message), so an input message is never
 * echoed.
 */
export interface ServerAuthzLiveRedactedSummaryInput {
  readonly ok?: boolean;
  readonly status?: number;
  readonly phase?: string;
  readonly serverAuthzPresent?: boolean;
  readonly comparison?: ServerAuthzShadowComparisonLikeInput | null;
}

// =============================================================================
// OUTPUT — counts + booleans only (no key names, no raw DTO)
// =============================================================================

/**
 * The redacted, NON-SECRET summary of ONE key-space. Carries ONLY counts + booleans —
 * never key names, never the mismatch arrays. `missingCount` / `unknownCount` are the
 * LENGTHS of the dropped arrays; the names themselves are never present.
 */
export interface RedactedKeySpaceSummary {
  /** True when a key-space comparison was present and summarized. */
  readonly hasComparison: boolean;
  readonly frontendCount: number;
  readonly serverCount: number;
  readonly matchedCount: number;
  /** LENGTH of the dropped "missing from server" array — the names are NOT present. */
  readonly missingCount: number;
  /** LENGTH of the dropped "unknown to frontend" array — the names are NOT present. */
  readonly unknownCount: number;
  /** True when this key-space is in exact structural parity. */
  readonly isExactMatch: boolean;
}

/**
 * The NON-SECRET redacted summary of a (future) live-authorization feed result. This is
 * the ONLY shape that may be surfaced to the browser when `ENABLE_LIVE_SESSION_AUTHORIZATION`
 * is enabled. It carries ONLY: the redaction phase, transport `ok`/`status`, safe
 * phase-enum passthrough strings, a presence boolean, a high-level safe reason label,
 * parity booleans, per-key-space COUNT summaries, and a phase-derived message. It NEVER
 * carries a raw authorization object, raw route body, raw comparison object, any
 * permission / sub-permission / entitlement KEY NAME, `missingFromServerKeys` /
 * `unknownToFrontendKeys`, mismatch key lists, permission LEVEL values, role
 * names/ids, tenant/store/plan/user ids, provider uid, email, tokens, headers, or
 * request/response bodies.
 */
export interface ServerAuthzLiveRedactedSummary {
  /** Honest, fail-closed redaction outcome (see ServerAuthzLiveRedactedSummaryPhase). */
  readonly summaryPhase: ServerAuthzLiveRedactedSummaryPhase;
  /** Transport-level success flag passed through from the feed result. */
  readonly ok: boolean;
  /** HTTP TRANSPORT status passed through (0 ⇒ never reached / unknown). */
  readonly status: number;
  /** Safe feed/route phase enum string (allow-listed; otherwise null). */
  readonly phase: string | null;
  /** Safe comparison phase enum string (allow-listed; otherwise null). */
  readonly comparisonPhase: string | null;
  /** True ONLY when the input carried a non-null server authorization comparison. */
  readonly serverAuthzPresent: boolean;
  /** High-level, fixed, safe reason label (never echoes input values). */
  readonly safeReasonCode: string;
  /** Overall structural parity (null when no comparison was summarized). */
  readonly overallParity: boolean | null;
  readonly permissionParity: boolean | null;
  readonly subPermissionParity: boolean | null;
  readonly entitlementParity: boolean | null;
  /** Per-key-space COUNT summaries (null when no comparison was summarized). */
  readonly permission: RedactedKeySpaceSummary | null;
  readonly subPermission: RedactedKeySpaceSummary | null;
  readonly entitlement: RedactedKeySpaceSummary | null;
  /** Safe, fixed, phase-derived status note (never echoes server/response content). */
  readonly message: string;
}
