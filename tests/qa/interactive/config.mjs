// QA-INTERACTIVE-P1 — launch configuration for an interactive QA session, refused rather than guessed.
//
// The public origin comes from the Replit-provided dev domain (or an explicit --origin that must agree
// with it); the Firebase project must be a demo- project so the emulators can never be pointed at a
// live one; an ambient test database URL is refused because QA starts only its own cluster.

export class QaRefusal extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = 'QaRefusal';
    this.code = code;
  }
}

export const QA_PROJECT_ID = 'demo-tmpos-qa';

const HOST_SHAPE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
const PROJECT_SHAPE = /^demo-[a-z0-9-]{1,40}$/;
const OPTIONS = new Set(['--origin', '--project']);

/** A host the Preview can be served on: dotted DNS shape, not a bare IPv4 address. */
function isServableHost(host) {
  return HOST_SHAPE.test(host) && !/^\d+$/.test(host.slice(host.lastIndexOf('.') + 1));
}

export function resolveLaunchConfig({ env = {}, args = [] } = {}) {
  const given = {};
  for (let i = 0; i < args.length; i += 1) {
    const token = String(args[i]);
    const eq = token.indexOf('=');
    const name = eq === -1 ? token : token.slice(0, eq);
    // Option values are never echoed: an unknown option may carry a credential.
    if (!OPTIONS.has(name)) throw new QaRefusal('unknown_option', `unsupported argument at position ${i + 1}`);
    if (Object.hasOwn(given, name)) throw new QaRefusal('unknown_option', `${name} given twice`);
    let value;
    if (eq !== -1) {
      value = token.slice(eq + 1);
    } else {
      value = args[i + 1];
      i += 1;
    }
    if (typeof value !== 'string' || value === '' || value.startsWith('--')) {
      throw new QaRefusal('unknown_option', `${name} needs a value`);
    }
    given[name] = value;
  }

  const ambient = env.TM_POS_TEST_DATABASE_URL;
  if (typeof ambient === 'string' && ambient.trim() !== '') {
    throw new QaRefusal('ambient_database', 'TM_POS_TEST_DATABASE_URL is set; QA starts only its own database cluster');
  }

  const projectId = given['--project'] ?? QA_PROJECT_ID;
  if (!PROJECT_SHAPE.test(projectId)) throw new QaRefusal('not_demo_project', 'the Firebase project must be a demo- project');

  const rawDomain = typeof env.REPLIT_DEV_DOMAIN === 'string' ? env.REPLIT_DEV_DOMAIN.trim().toLowerCase() : '';
  if (rawDomain && !isServableHost(rawDomain)) throw new QaRefusal('origin_invalid', 'REPLIT_DEV_DOMAIN is not a plain hostname');

  let originHost = null;
  if (given['--origin'] !== undefined) {
    const raw = given['--origin'];
    let url;
    try {
      url = new URL(raw);
    } catch {
      throw new QaRefusal('origin_invalid', '--origin is not a URL');
    }
    if (url.protocol !== 'https:' || url.username || url.password || url.port || url.pathname !== '/'
      || url.search || url.hash || raw.includes('?') || raw.includes('#') || !isServableHost(url.hostname)) {
      throw new QaRefusal('origin_invalid', '--origin must be https://<host> with no port, path, query or credentials');
    }
    originHost = url.hostname;
    if (rawDomain && rawDomain !== originHost) {
      throw new QaRefusal('origin_mismatch', '--origin does not match REPLIT_DEV_DOMAIN');
    }
  }

  const publicHost = originHost ?? (rawDomain || null);
  if (!publicHost) throw new QaRefusal('origin_missing', 'no REPLIT_DEV_DOMAIN and no --origin');
  return Object.freeze({ publicHost, publicOrigin: `https://${publicHost}`, projectId });
}

/** The major version in `java -version` text (`version "21.0.9"` → 21; the legacy `"1.8.0_401"` → 8), or null. */
export function javaMajor(text) {
  const match = /version "(\d+)(?:\.(\d+))?/.exec(String(text ?? ''));
  if (!match) return null;
  return Number(match[1] === '1' && match[2] !== undefined ? match[2] : match[1]);
}

/** MemAvailable in MB; refuses (fail closed) below `minMb` or when it is not reported. */
export function assertMemoryHeadroom(meminfoText, minMb = 1200) {
  const match = /^MemAvailable:\s+(\d+)\s+kB\s*$/m.exec(String(meminfoText ?? ''));
  if (!match) throw new QaRefusal('low_memory', 'MemAvailable is not reported');
  const availableMb = Math.floor(Number(match[1]) / 1024);
  if (availableMb < minMb) {
    throw new QaRefusal('low_memory', `only ${availableMb} MB available; at least ${minMb} MB is required`);
  }
  return availableMb;
}

/**
 * Names of the files whose text contains any live value. `files` is `[{ name, text }]` or `{ name: text }`.
 * Values shorter than 4 characters are ignored (they would match everything); values are never returned.
 */
export function findLiveConfigLeaks(files, liveValues) {
  const pairs = Array.isArray(files) ? files.map((f) => [f?.name, f?.text]) : Object.entries(files ?? {});
  const values = (liveValues ?? []).filter((v) => typeof v === 'string' && v.trim().length >= 4);
  const leaking = new Set();
  for (const [name, text] of pairs) {
    if (typeof text !== 'string') continue;
    if (values.some((v) => text.includes(v))) leaking.add(String(name));
  }
  return [...leaking].sort();
}
