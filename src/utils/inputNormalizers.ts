import type React from 'react';
// Phase 2.10 — Shared input-hardening helpers used everywhere a U.S. state
// code, ZIP code, or phone number is captured. Centralized here so the
// Shipping Center, Customers, Returns Portal, and any future address form
// share one consistent normalization rule. The rules:
//
// - State code: letters only, uppercase, max 2 chars. Pasting "Texas" yields
//   "TE"; pasting "tx" yields "TX". The form value MUST be the storage
//   value — no separate display vs. stored representation.
// - ZIP: digits only, max 5 chars. We intentionally do NOT auto-format ZIP+4
//   here because every consumer (EasyPost, USPS, etc.) accepts the 5-digit
//   form, and accepting the dash/extension created subtle validation drift.
//   If a future consumer needs ZIP+4, add a separate `normalizeZipPlus4`.
// - Phone: digits only, max 15 chars (E.164 ceiling). EasyPost / FedEx /
//   UPS all accept a digits-only string; presentation can format on read,
//   but the stored value stays normalized so downstream validators do not
//   need to strip punctuation.

export function normalizeStateCode(input: string): string {
  if (!input) return '';
  return input.replace(/[^a-zA-Z]/g, '').toUpperCase().slice(0, 2);
}

export function normalizeZip(input: string): string {
  if (!input) return '';
  return input.replace(/\D/g, '').slice(0, 5);
}

export function normalizePhone(input: string): string {
  if (!input) return '';
  return input.replace(/\D/g, '').slice(0, 15);
}

// Convenience wrappers for the common React onChange shape so callers can do:
//   onChange={onStateChange(v => setForm(p => ({ ...p, state: v })))}
// Kept optional — direct calls to the three normalizers above are equally
// valid and used in places where the setter signature is more complex.
export const onStateChange =
  (setter: (v: string) => void) =>
  (e: React.ChangeEvent<HTMLInputElement>) =>
    setter(normalizeStateCode(e.target.value));

export const onZipChange =
  (setter: (v: string) => void) =>
  (e: React.ChangeEvent<HTMLInputElement>) =>
    setter(normalizeZip(e.target.value));

export const onPhoneChange =
  (setter: (v: string) => void) =>
  (e: React.ChangeEvent<HTMLInputElement>) =>
    setter(normalizePhone(e.target.value));
