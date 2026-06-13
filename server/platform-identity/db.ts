// Phase 1.5 M1 — Platform Identity: server-side-only Postgres connection helper.
//
// SECURITY:
//   - Server-side only. NEVER imported by `src/` (client). The connection string
//     (SUPABASE_DATABASE_URL) stays inside this process and is never logged.
//   - The direct-Postgres connection authenticates as the database owner role,
//     which BYPASSES Row-Level Security. The browser/anon key path is never used
//     here, so clients get no access to platform_identity (RLS enabled, no
//     policies — see the migration).
//
// The connection is created lazily (on first use) so importing this module — or
// running the isolated API with the feature flag OFF — does not open a DB
// connection or require any secret to be present.

import postgres from 'postgres';
import { getRequiredServerConfig } from './config';

type Sql = ReturnType<typeof postgres>;

let sql: Sql | null = null;

/**
 * Returns the shared Postgres client, creating it on first use. Throws a
 * non-sensitive error if SUPABASE_DATABASE_URL is not configured. The thrown
 * message contains the variable NAME only — never its value.
 */
export function getDb(): Sql {
  if (sql) return sql;
  const cfg = getRequiredServerConfig();
  if (!cfg) {
    throw new Error('SUPABASE_DATABASE_URL is not configured (server-side secret missing).');
  }
  // ssl: 'require' — Supabase requires TLS.
  // prepare: false — safe with Supabase's transaction-mode connection pooler.
  sql = postgres(cfg.databaseUrl, {
    ssl: 'require',
    max: 3,
    idle_timeout: 20,
    connect_timeout: 10,
    prepare: false,
  });
  return sql;
}

/** Closes the shared client (used by scripts and graceful shutdown). */
export async function closeDb(): Promise<void> {
  if (sql) {
    await sql.end({ timeout: 5 });
    sql = null;
  }
}
