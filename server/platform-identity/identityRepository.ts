// Phase 1.5 M1 — Platform Identity repository.
//
// The ONLY durable domain in M1. Provider-agnostic shape: the app-owned
// internal_user_id is primary; (auth_provider, auth_provider_uid) is the
// external reference key. Returns SAFE public fields only — no secrets, no
// tenant/business data.
//
// Server-side only. Never imported by `src/` (client).

import { getDb } from './db';

/** Safe, public-facing shape returned to callers. Contains no secrets. */
export interface PlatformIdentity {
  internalUserId: string;
  authProvider: string;
  authProviderUid: string;
  email: string | null;
  displayName: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface UpsertIdentityInput {
  /** Defaults to 'firebase' (the only provider in M1). */
  authProvider?: string;
  authProviderUid: string;
  email?: string | null;
  displayName?: string | null;
}

function toIso(value: unknown): string {
  // postgres returns timestamptz as a JS Date; be defensive for strings too.
  return value instanceof Date ? value.toISOString() : String(value);
}

function mapRow(row: any): PlatformIdentity {
  return {
    internalUserId: row.internal_user_id,
    authProvider: row.auth_provider,
    authProviderUid: row.auth_provider_uid,
    email: row.email ?? null,
    displayName: row.display_name ?? null,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

/** Look up an identity by its external provider reference. */
export async function findByProviderUid(
  authProvider: string,
  authProviderUid: string,
): Promise<PlatformIdentity | null> {
  const sql = getDb();
  const rows = await sql`
    select internal_user_id, auth_provider, auth_provider_uid, email, display_name, created_at, updated_at
    from platform_identity
    where auth_provider = ${authProvider} and auth_provider_uid = ${authProviderUid}
    limit 1
  `;
  return rows.length ? mapRow(rows[0]) : null;
}

/**
 * Create-or-update an identity mapping keyed on (auth_provider,
 * auth_provider_uid). Returns the stable internal_user_id plus safe fields.
 * Never creates tenant/business data.
 */
export async function upsertIdentity(input: UpsertIdentityInput): Promise<PlatformIdentity> {
  const sql = getDb();
  const authProvider = input.authProvider ?? 'firebase';
  const email = input.email ?? null;
  const displayName = input.displayName ?? null;
  const rows = await sql`
    insert into platform_identity (auth_provider, auth_provider_uid, email, display_name)
    values (${authProvider}, ${input.authProviderUid}, ${email}, ${displayName})
    on conflict (auth_provider, auth_provider_uid)
    do update set
      email = excluded.email,
      display_name = excluded.display_name,
      updated_at = now()
    returning internal_user_id, auth_provider, auth_provider_uid, email, display_name, created_at, updated_at
  `;
  return mapRow(rows[0]);
}
