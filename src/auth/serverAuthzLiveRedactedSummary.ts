// Phase 1.6 M17.1 — Dormant, DEV-only SAFE LIVE-AUTHORIZATION OUTPUT REDACTION projection.
//
// WHAT THIS IS: a PURE, SYNCHRONOUS, NO-THROW projection that — WHEN EXPLICITLY INVOKED BY A
// FUTURE, SEPARATELY OWNER-APPROVED LIVE-AUTHORIZATION (M17.2) PASS — converts an M14-style
// server-authz shadow FEED result into a COUNTS-AND-BOOLEANS-ONLY summary that is SAFE to surface
// to the browser when `ENABLE_LIVE_SESSION_AUTHORIZATION` is enabled and the server returns a
// NON-NULL `authorization`. It exists because the M14 feed / M15 harness result embeds the M13
// structural comparison, whose per-key-space `missingFromServerKeys` / `unknownToFrontendKeys`
// arrays would disclose a real user's effective permission / sub-permission / entitlement KEY
// NAMES once authorization is non-null. This projection DROPS those arrays, keeping ONLY counts +
// parity booleans.
//
// WHAT THIS IS NOT (binding for M17.1): it changes NO current behavior and reads NOTHING live.
//   - It accepts a CALLER-PROVIDED feed-shaped object ONLY. It NEVER calls the M14 feed, the M15
//     harness, the M13 comparison, the M11 token bridge, or the backend session-resolve route;
//     NEVER fetches / XHRs / sendBeacons; NEVER acquires or reads a token; NEVER connects to a DB.
//   - It is DORMANT: imported by NOTHING active (not AccessContext, Login, AccessGuard, App
//     routing, src/main.tsx, the pilot, the M14 feed, or the M15 harness) and invoked by NOTHING
//     in M17.1, so the bundler tree-shakes it out of production. (Proven by the M17.1 dormancy
//     diagnostic + the bundle scan.)
//   - It has NO import-time side effects and NO top-level await. It reads the public env ONLY
//     inside the enablement helper (never at module scope, never in the projection).
//
// REDACTION BOUNDARY (binding): the projection reads ONLY transport `ok`/`status`/`phase`,
// `serverAuthzPresent`, and — from a non-null comparison — the per-key-space COUNT fields and the
// `.length` of the two mismatch arrays (to produce counts). It NEVER reads or copies a key NAME,
// a permission LEVEL, an allow/deny value, a role / tenant / store / plan / identity value, or the
// raw authorization DTO. The two mismatch arrays are converted to COUNTS and then DROPPED — their
// names never appear in the output.
//
// OUTPUT SAFETY (binding): the returned object carries ONLY counts, booleans, allow-listed safe
// phase strings, a fixed safe reason label, and a fixed phase-derived message (see
// serverAuthzLiveRedactedSummaryTypes.ts). It NEVER carries a raw authorization object, raw route
// body, raw comparison object, `missingFromServerKeys` / `unknownToFrontendKeys`, any
// permission/sub-permission/entitlement key name, mismatch key list, permission level, role,
// tenant/store/plan/user id, provider uid, email, token, header, or body.
//
// ISOLATION: imports its OWN types ONLY (via `import type`, erased at compile time) — NOT the M14
// feed, NOT the M15 harness, NOT the M13 comparison, NOT the M11 token bridge, NOT the M12 shadow
// client, NOT the M5 foundation, NOT `@supabase/supabase-js`, NOT React, NOT Firebase, NOT
// AccessContext / Login / AccessGuard / App / main, NOT the pilot, and NOT any server module.
//
// FLAG (binding): `isServerAuthzLiveRedactedSummaryEnabled()` is DEV-only and default OFF
// (`VITE_ENABLE_SERVER_AUTHZ_LIVE_REDACTED_SUMMARY === 'true'`). It is provided for a FUTURE call
// site to gate wiring; the projection itself is pure and does NOT depend on it. A real M17.2 call
// site would additionally AND this with the upstream M11–M15 feed/harness enablement AT THE CALL
// SITE — never by importing those modules here. No other new flag is introduced.

import type {
  RedactedKeySpaceInput,
  RedactedKeySpaceSummary,
  ServerAuthzLiveRedactedSummary,
  ServerAuthzLiveRedactedSummaryInput,
  ServerAuthzLiveRedactedSummaryPhase,
} from './serverAuthzLiveRedactedSummaryTypes';

// -----------------------------------------------------------------------------
// Public env boundary (client-safe, VITE_-only). Read through a single narrow cast so this module
// adds NO new ImportMeta typing error and does not alter the baseline. PURE reads only, and ONLY
// inside the enablement helpers — never at module scope and never in the projection.
// -----------------------------------------------------------------------------

interface RedactedSummaryPublicEnv {
  /** Vite's built-in dev flag (true under `vite dev`, false in production builds). */
  DEV?: boolean;
  /** DEV-only opt-in for a FUTURE call site — must equal the string 'true' to enable. */
  VITE_ENABLE_SERVER_AUTHZ_LIVE_REDACTED_SUMMARY?: string;
}

/** Pure read of the public env object. No side effects, no I/O. */
function readEnv(): RedactedSummaryPublicEnv {
  return (import.meta as unknown as { env?: RedactedSummaryPublicEnv }).env ?? {};
}

/** True only under a Vite DEV build (never in a production build). */
export function isDevBuild(): boolean {
  return readEnv().DEV === true;
}

/**
 * DEV-only enablement helper for a FUTURE call site. False unless we are in a DEV build AND the
 * dedicated opt-in flag is explicitly 'true'. Default OFF. The projection does NOT consult this —
 * it is pure and always safe to call; this helper only governs whether a future caller wires it.
 */
export function isServerAuthzLiveRedactedSummaryEnabled(): boolean {
  return isDevBuild() && readEnv().VITE_ENABLE_SERVER_AUTHZ_LIVE_REDACTED_SUMMARY === 'true';
}

// -----------------------------------------------------------------------------
// Allow-listed safe phase strings. Only these enum values are passed through; any other string
// (including arbitrary/attacker-shaped input) becomes null and is never echoed.
// -----------------------------------------------------------------------------

const SAFE_FEED_PHASES: ReadonlySet<string> = new Set<string>([
  'disabled',
  'token_bridge_disabled',
  'no_session',
  'no_token',
  'cancelled',
  'route_disabled',
  'denied',
  'unreachable',
  'server_error',
  'malformed',
  'server_authz_unavailable',
  'compared',
]);

const SAFE_COMPARISON_PHASES: ReadonlySet<string> = new Set<string>([
  'disabled',
  'server_authz_unavailable',
  'compared',
]);

const MESSAGE: Record<ServerAuthzLiveRedactedSummaryPhase, string> = {
  summarized:
    'Live-authz redacted summary: server authorization present; key-spaces reduced to counts + parity booleans (all key-name lists dropped — comparable only, not authoritative, not enforceable).',
  unavailable:
    'Live-authz redacted summary: server authorization unavailable / not evaluated / non-200. Only the safe transport status + phase are preserved (no key-space detail).',
  malformed:
    'Live-authz redacted summary: input was missing / malformed / could not be safely summarized. Failed closed to an empty safe summary (no detail surfaced).',
};

const REASON_CODE: Record<ServerAuthzLiveRedactedSummaryPhase, string> = {
  summarized: 'server_authz_summarized',
  unavailable: 'server_authz_unavailable',
  malformed: 'input_malformed_or_unavailable',
};

// -----------------------------------------------------------------------------
// Pure helpers. NO-THROW by construction: every read is defensive and falls back to a safe value.
// -----------------------------------------------------------------------------

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/** Non-negative integer count, or 0 for anything else. */
function countOf(v: unknown): number {
  return isFiniteNumber(v) && v >= 0 ? Math.floor(v) : 0;
}

function boolOrNull(v: unknown): boolean | null {
  return typeof v === 'boolean' ? v : null;
}

function safePhase(v: unknown, allow: ReadonlySet<string>): string | null {
  return typeof v === 'string' && allow.has(v) ? v : null;
}

/**
 * Reduce a (possibly present) key-name array to its COUNT only. Reads `.length` and nothing else —
 * the key names are never read, copied, or returned. Falls back to a derived count when the array
 * is absent. The array itself is DROPPED.
 */
function lengthOf(v: unknown, fallback: number): number {
  if (Array.isArray(v)) return v.length;
  if (v && typeof (v as { length?: unknown }).length === 'number') {
    const n = (v as { length: number }).length;
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
  }
  return fallback < 0 ? 0 : fallback;
}

/**
 * Reduce one comparison key-space to a redacted, counts-only summary. Returns null when no
 * key-space object is present. NEVER reads or returns key NAMES — `missingCount` / `unknownCount`
 * are derived from array LENGTHS only, after which the arrays are dropped.
 */
function redactKeySpace(ks: RedactedKeySpaceInput | null | undefined): RedactedKeySpaceSummary | null {
  if (!ks || typeof ks !== 'object') return null;
  const frontendCount = countOf(ks.frontendKeyCount);
  const serverCount = countOf(ks.serverKeyCount);
  const matchedCount = countOf(ks.matchedKeyCount);
  const missingCount = lengthOf(ks.missingFromServerKeys, frontendCount - matchedCount);
  const unknownCount = lengthOf(ks.unknownToFrontendKeys, serverCount - matchedCount);
  const isExactMatch = ks.parity === true || (missingCount === 0 && unknownCount === 0);
  return { hasComparison: true, frontendCount, serverCount, matchedCount, missingCount, unknownCount, isExactMatch };
}

function parityOf(flag: unknown, ks: RedactedKeySpaceSummary | null): boolean | null {
  if (typeof flag === 'boolean') return flag;
  return ks ? ks.isExactMatch : null;
}

/** Build a fail-closed, empty-but-safe summary for a non-summarizable input. NEVER echoes input. */
function failClosed(summaryPhase: ServerAuthzLiveRedactedSummaryPhase): ServerAuthzLiveRedactedSummary {
  return {
    summaryPhase,
    ok: false,
    status: 0,
    phase: null,
    comparisonPhase: null,
    serverAuthzPresent: false,
    safeReasonCode: REASON_CODE[summaryPhase],
    overallParity: null,
    permissionParity: null,
    subPermissionParity: null,
    entitlementParity: null,
    permission: null,
    subPermission: null,
    entitlement: null,
    message: MESSAGE[summaryPhase],
  };
}

// -----------------------------------------------------------------------------
// Exported pure projection. Reads NOTHING live; performs a synchronous, no-throw redaction of a
// caller-provided feed-shaped object. In M17.1 NOTHING calls this — the projection stays dormant.
// -----------------------------------------------------------------------------

/**
 * Project an M14-style feed result into a NON-SECRET, counts-and-booleans-only live-authz summary.
 * PURE, SYNCHRONOUS, NO-THROW. Does NOT mutate the input (reads only; returns a fresh object).
 *
 *   - null / non-object input            ⇒ summaryPhase 'malformed' (fail closed, empty safe summary).
 *   - recognized input, serverAuthzPresent=false (or no comparison) ⇒ 'unavailable' (status/phase only).
 *   - serverAuthzPresent=true + comparison ⇒ 'summarized' (counts + parity booleans; ALL key-name
 *     arrays dropped).
 *
 * The output NEVER carries a raw authorization object, raw body, raw comparison, key names,
 * `missingFromServerKeys` / `unknownToFrontendKeys`, mismatch lists, permission levels, roles,
 * tenant/store/plan/identity values, tokens, or headers.
 */
export function projectServerAuthzLiveRedactedSummary(
  input?: ServerAuthzLiveRedactedSummaryInput | null,
): ServerAuthzLiveRedactedSummary {
  if (!input || typeof input !== 'object') {
    return failClosed('malformed');
  }

  const ok = input.ok === true;
  const status = isFiniteNumber(input.status) && input.status >= 0 ? Math.floor(input.status) : 0;
  const phase = safePhase(input.phase, SAFE_FEED_PHASES);
  const serverAuthzPresent = input.serverAuthzPresent === true;
  const comparison =
    input.comparison && typeof input.comparison === 'object' ? input.comparison : null;
  const comparisonPhase = comparison ? safePhase(comparison.phase, SAFE_COMPARISON_PHASES) : null;

  // Non-null server authorization ⇒ summarize counts + parity ONLY; drop every key-name array.
  if (serverAuthzPresent && comparison) {
    const permission = redactKeySpace(comparison.permissionKeySpace);
    const subPermission = redactKeySpace(comparison.subPermissionKeySpace);
    const entitlement = redactKeySpace(comparison.entitlementKeySpace);
    return {
      summaryPhase: 'summarized',
      ok,
      status,
      phase,
      comparisonPhase,
      serverAuthzPresent: true,
      safeReasonCode: REASON_CODE.summarized,
      overallParity: boolOrNull(comparison.overallParity),
      permissionParity: parityOf(comparison.permissionKeyParity, permission),
      subPermissionParity: parityOf(comparison.subPermissionKeyParity, subPermission),
      entitlementParity: parityOf(comparison.entitlementKeyParity, entitlement),
      permission,
      subPermission,
      entitlement,
      message: MESSAGE.summarized,
    };
  }

  // Null authz / non-200 / short-circuit ⇒ safe transport status + phase ONLY (no key-space detail).
  return {
    summaryPhase: 'unavailable',
    ok,
    status,
    phase,
    comparisonPhase,
    serverAuthzPresent: false,
    safeReasonCode: REASON_CODE.unavailable,
    overallParity: null,
    permissionParity: null,
    subPermissionParity: null,
    entitlementParity: null,
    permission: null,
    subPermission: null,
    entitlement: null,
    message: MESSAGE.unavailable,
  };
}
