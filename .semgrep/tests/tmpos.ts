/*
 * Phase 4.0 M2 — Semgrep rule unit tests for .semgrep/tmpos.yml (run via `semgrep --test`).
 *
 * SYNTHETIC fixtures ONLY. No real UID, email, token, API key, credential, PIN, PAN,
 * CVV, track data, provider ID, project ID, or connection string appears here — every
 * value is an obvious placeholder. Each positive line carries an annotation naming the
 * rule that MUST flag it; each safe line carries an annotation asserting the rule must
 * NOT flag it. This file is never imported, bundled, executed, or scanned by the
 * repository Semgrep scan (which targets src/ + server/ only) — it exists solely to
 * prove each rule's positive/negative behaviour.
 */

// --- tmpos-server-only-module-in-client (positive: server-only pkg imported into a src/ client module) ---
// ruleid: tmpos-server-only-module-in-client
import postgres from 'postgres';
// ok: tmpos-server-only-module-in-client
import { getAuth } from 'firebase/auth';

declare const req: { query: Record<string, string>; params: Record<string, string>; body: Record<string, string> };
declare const allowedLabelEndpoint: string;
declare const apiKey: string;

// --- tmpos-hardcoded-pin ---
export function pinPositive(enteredPin: string): boolean {
  // ruleid: tmpos-hardcoded-pin
  return enteredPin === '1234';
}
export function pinNegative(enteredPin: string, expectedPin: string): boolean {
  // ok: tmpos-hardcoded-pin
  return enteredPin === expectedPin;
}

// --- tmpos-ssrf-request-controlled-fetch ---
export function ssrfPositive(): Promise<Response> {
  // ruleid: tmpos-ssrf-request-controlled-fetch
  return fetch(req.query.targetUrl);
}
export function ssrfNegative(): Promise<Response> {
  // ok: tmpos-ssrf-request-controlled-fetch
  return fetch(allowedLabelEndpoint);
}

// --- tmpos-credential-logging ---
export function logPositive(): void {
  // ruleid: tmpos-credential-logging
  console.log('outbound call used', apiKey);
}
export function logNegative(userId: string): void {
  // ok: tmpos-credential-logging
  console.log('user session established for', userId);
}

// --- tmpos-raw-cardholder-data-field ---
export interface ForbiddenCardData {
  // ruleid: tmpos-raw-cardholder-data-field
  primaryAccountNumber: string;
}
export interface AllowedGiftCard {
  // ok: tmpos-raw-cardholder-data-field
  cardNumber: string;
}

// --- tmpos-webhook-verification-bypass ---
// ruleid: tmpos-webhook-verification-bypass
export const SKIP_WEBHOOK_VERIFICATION = false;
export function webhookNegative(sig: string, body: string): boolean {
  // ok: tmpos-webhook-verification-bypass
  return verifyWebhookSignatureLocal(sig, body);
}
function verifyWebhookSignatureLocal(sig: string, body: string): boolean {
  return sig.length > 0 && body.length > 0;
}

// Keep the imported symbols "used" so the fixture stays type-clean under the
// project's tsconfig (which has no include/exclude and would otherwise compile it).
export const _fixtureExports = { postgres, getAuth };
