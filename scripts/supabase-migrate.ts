// Phase 1.5 M1 — Platform Identity migration runner (convenience script).
//
// Applies the 001_platform_identity migration against the Supabase DEV database
// using SUPABASE_DATABASE_URL. RUN THIS IN THE REPLIT SHELL (where the secret is
// available), not from an environment that lacks the secret.
//
// Usage:
//   npm run identity:migrate           # apply UP (create platform_identity)
//   npm run identity:migrate -- --down # apply DOWN (rollback)
//
// SECURITY: never prints the connection string, credentials, or any secret.
// Reports only safe status. Multi-statement SQL (incl. the trigger function) is
// executed in simple-query mode.
//
// If you prefer, you can instead paste the contents of
// server/platform-identity/migrations/001_platform_identity.up.sql into the
// Supabase SQL editor — that is an equally valid manual application path.

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import postgres from 'postgres';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, '..', 'server', 'platform-identity', 'migrations');

async function main() {
  const isDown = process.argv.includes('--down');
  const file = isDown ? '001_platform_identity.down.sql' : '001_platform_identity.up.sql';
  const direction = isDown ? 'DOWN (rollback)' : 'UP (create)';

  const databaseUrl = process.env.SUPABASE_DATABASE_URL;
  if (!databaseUrl) {
    console.error('[migrate] SUPABASE_DATABASE_URL is not set. Run this in the Replit shell where the secret exists.');
    process.exit(1);
    return;
  }

  const sqlText = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
  console.log(`[migrate] Applying ${direction} from ${file} …`);

  const sql = postgres(databaseUrl, { ssl: 'require', max: 1, prepare: false, connect_timeout: 10 });
  try {
    await sql.unsafe(sqlText).simple();
    console.log(`[migrate] SUCCESS: ${direction} applied.`);
  } catch (err) {
    // Print only a safe, non-sensitive message.
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error(`[migrate] FAILED: ${message}`);
    process.exitCode = 1;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main();
