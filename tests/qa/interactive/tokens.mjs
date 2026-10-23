// QA-INTERACTIVE-P1 — the ledger of ID and refresh tokens the Auth emulator actually issued during this run.
//
// The emulator signs nothing (alg 'none') and its accounts:lookup only checks that the account exists, so a token
// forged for a seeded uid would otherwise pass; its token route likewise mints a real ID token for any refresh token
// that names an existing account. The front records every token the emulator hands out (and the supervisor its own
// seed/probe sign-ins); the verifier and the front's credential checks accept only recorded ones. Each token is kept
// under its kind ('id' or 'refresh'), so an ID token never passes as a refresh token or the reverse. Only sha256
// digests are kept, bounded to the most recent MAX_TOKENS.
import { createHash } from 'node:crypto';

const MAX_TOKENS = 500;
const KINDS = new Set(['id', 'refresh']);

const usable = (token, kind) => KINDS.has(kind) && typeof token === 'string' && token !== '' && token.length <= 8192;
// The kind never contains '\n', so 'id\n…' and 'refresh\n…' can never collide.
const digest = (token, kind) => createHash('sha256').update(`${kind}\n${token}`, 'utf8').digest('hex');

export function createTokenLedger() {
  const digests = new Set(); // insertion order = issue order, so the oldest is evicted first
  return Object.freeze({
    /** Records `token` under `kind`; false when it cannot be recorded (not a string, empty, over 8192, unknown kind). */
    record(token, kind = 'id') {
      if (!usable(token, kind)) return false;
      const d = digest(token, kind);
      digests.delete(d);
      digests.add(d);
      while (digests.size > MAX_TOKENS) digests.delete(digests.values().next().value);
      return true;
    },
    has(token, kind = 'id') {
      return usable(token, kind) && digests.has(digest(token, kind));
    },
    clear() {
      digests.clear();
    },
  });
}
