// QA-INTERACTIVE-P1 — the tenant runtime's token verifier for the QA composition ONLY, passed through startTenantEntry's
// `construction.tokenVerifier` (the one seam the runtime offers; PRODUCTION_CONSTRUCTION has none and no environment
// variable selects one). The Auth emulator signs nothing, so its tokens carry no proof of origin: a token is accepted only
// when its digest is in this run's issued-token ledger (tokens.mjs: recorded from the emulator's own answers), its claims
// name this run's demo project and a seeded account, it lives at most one hour, and the emulator still recognises it.
// The ledger is checked first, so a forged token never reaches the emulator. Anything else is a credential verdict
// (`auth/invalid-id-token`); an unreachable emulator is an outage (a plain error: the runtime answers 503).
import { lookupToken } from './emulators.mjs';

const AGED_BY_S = 11 * 60; // past the void's 10-minute recent-sign-in window
const MAX_LIFETIME_S = 3600; // the emulator issues one-hour tokens

const refused = () => Object.assign(new Error('qa_token_refused'), { code: 'auth/invalid-id-token' });
const decode = (part) => JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));

// `lookup` defaults to the emulator's accounts:lookup; the suite injects a stub to observe that it is never reached.
export function createQaVerifier({ projectId, apiKey, accepts, tokens, lookup = lookupToken }) {
  if (!tokens || typeof tokens.has !== 'function') throw new TypeError('tokens (the issued-token ledger) is required');
  const aged = new Set(); // uids whose NEXT login is aged (operator scenario aged-sign-in)
  const verifier = Object.freeze({
    async verify(token) {
      if (typeof token !== 'string' || token.length > 8192) throw refused();
      if (!tokens.has(token)) throw refused();
      const parts = token.split('.');
      if (parts.length !== 3) throw refused();
      let header;
      let claims;
      try {
        header = decode(parts[0]);
        claims = decode(parts[1]);
      } catch {
        throw refused();
      }
      // The Auth emulator signs nothing ('none'); a signed token was not issued by it.
      if (header?.alg !== 'none') throw refused();
      if (claims?.iss !== `https://securetoken.google.com/${projectId}` || claims.aud !== projectId) throw refused();
      if (typeof claims.sub !== 'string' || claims.sub !== claims.user_id || !accepts(claims.sub)) throw refused();
      const now = Math.floor(Date.now() / 1000);
      if (!Number.isInteger(claims.exp) || claims.exp <= now || !Number.isInteger(claims.auth_time) || claims.auth_time > now + 60) throw refused();
      // A future iat would stretch exp past the one-hour bound.
      if (!Number.isInteger(claims.iat) || claims.iat > now + 60 || claims.exp - claims.iat > MAX_LIFETIME_S) throw refused();
      if ((await lookup(apiKey, token)) !== claims.sub) throw refused();
      // aged-sign-in: this one login binds an auth_time 11 minutes old, so the void's real recent-sign-in rule asks for a
      // re-authentication at once; that re-authentication is verified with its true time.
      const authTime = aged.delete(claims.sub) ? claims.auth_time - AGED_BY_S : claims.auth_time;
      return { uid: claims.sub, authTime, secondFactor: claims.firebase?.sign_in_second_factor };
    },
  });
  return {
    verifier,
    ageNextLogin: (uid) => { aged.add(uid); },
    clearAged: () => { aged.clear(); },
    agedPending: () => [...aged],
  };
}
